// v2 模型（多声部 + 绝对拍位）→ v1 模型（声部.measures[].beats[]，界面/导出仍在用）。
//
// 为什么需要：界面与导出目前跑在 v1 结构上。v2 里同一条 voice 是「绝对拍位的事件流」，
// v1 是「按小节顺序排列的拍位清单」，转换时会：
//   · 按小节切分事件（跨小节长音拆段，并标 tieFromPrev）；
//   · 空拍补休止；
//   · 同一拍位的多音（和弦）合成一个 beat + chordMidis；
//   · v2 里的 staff/voice 组合成独立声部（界面上看起来就是「钢琴 第2行 声部5」）。
//
// 返回时带 v2 的事件引用，界面点 v1 的音也能找回 v2 的事件（改/删/加记号都要用）。
import {
  beatsPerMeasure, round, createScore as createV2Score, createPart as createV2Part,
  createStaff as createV2Staff, createVoice as createV2Voice,
} from "./composer-model.js";

/** v1 声部（一个 (part, staff, voice) 组合）。 */
function v1PartFromVoice(v2Score, part, staff, voice, index) {
  const per = beatsPerMeasure(v2Score);
  const measures = [];
  let cursor = 0;
  const events = [...(voice.events || [])].sort((left, right) => left.beat - right.beat);
  for (const event of events) {
    if (event.beat >= cursor) {
      // 空隙补休止（跨小节切开）
      let gap = event.beat - cursor;
      while (gap > 1e-6) {
        const measureEnd = Math.floor(cursor / per + 1) * per;
        const chunk = Math.min(gap, measureEnd - cursor);
        let measure = measures[measures.length - 1];
        if (!measure || usedOf(measure) >= per - 1e-6) {
          measure = { beats: [] };
          measures.push(measure);
        }
        measure.beats.push({ midi: 0, beats: round(chunk), rest: true });
        cursor += chunk;
        gap -= chunk;
      }
    }
    // 和弦附加音不单独占一个拍位：合并到同拍主音的 chordMidis 里。
    // （之前把它们当成普通事件，同一小节里会出现两个 beat，拍位全错。）
    if (event.chordWith) {
      let anchorBeat = null;
      for (const measure of measures) {
        for (const candidate of measure.beats) {
          if (candidate.id === event.chordWith) anchorBeat = candidate;
        }
      }
      if (anchorBeat) {
        anchorBeat.chordMidis = anchorBeat.chordMidis || [];
        if (!anchorBeat.chordMidis.includes(event.midi)) anchorBeat.chordMidis.push(event.midi);
        continue;   // 不推进 cursor
      }
      // 找不到主音（理论上不会发生）：退化成普通音
    }

    // 事件本身（跨小节拆段）
    let remaining = event.beats;
    let firstSegment = true;
    while (remaining > 1e-6) {
      const measureEnd = Math.floor(cursor / per + 1) * per;
      let measure = measures[measures.length - 1];
      if (!measure || usedOf(measure) >= per - 1e-6) {
        measure = { beats: [] };
        measures.push(measure);
      }
      const room = measureEnd - cursor;
      const length = Math.min(remaining, room);
      if (firstSegment) {
        const entry = {
          id: event.id,
          midi: event.rest ? 0 : event.midi,
          beats: round(length),
          v2Event: event,
        };
        if (event.rest) entry.rest = true;
        // 记号：v2 的事件属性直接带到 v1，界面读得到
        if (event.tie) entry.tie = event.tie;
        if (event.tieStop) entry.tieStop = true;
        if (event.slur) entry.slur = event.slur;
        if (event.slurStop) entry.slurStop = true;
        if (event.accidental) entry.accidental = event.accidental;
        if (event.articulations && event.articulations.length) entry.articulations = [...event.articulations];
        if (event.ornaments && event.ornaments.length) entry.ornaments = [...event.ornaments];
        if (event.dynamic) entry.dynamic = event.dynamic;
        if (event.lyric) entry.lyric = event.lyric;
        if (event.tuplet) entry.tuplet = event.tuplet;
        if (event.fermata) entry.fermata = true;
        measure.beats.push(entry);
        firstSegment = false;
      } else {
        measure.beats.push({
          id: `${event.id}#cont`, midi: event.rest ? 0 : event.midi, beats: round(length),
          v2Event: event, tieFromPrev: true, ...(event.rest ? { rest: true } : {}),
        });
      }
      cursor += length;
      remaining -= length;
    }
  }
  if (!measures.length) measures.push({ beats: [] });
  return {
    id: `v1-${index}`,
    name: `${part.name} · 第${staff.number || 1}行${(staff.voices || []).length > 1 ? ` 声部线${voice.number || 1}` : ""}`,
    timbre: part.timbre || "piano",
    clef: staff.clef || "treble",
    octave: Number(part.octave) || 0,
    volume: Number(part.volume) || 1,
    measures,
    // 反向索引（界面改 v1 时靠它写回 v2）
    v2: { partId: part.id, staffIndex: staff.number || 1, voiceId: voice.id },
    v2Score,
  };
}

function usedOf(measure) {
  let total = 0;
  for (const beat of measure.beats) {
    total += Number(beat.beats) || 0;
    // 和弦附加音不占时间
  }
  return total;
}

/** v2 乐谱 → v1 乐谱（界面 + 旧导出用）。 */
export function v2ScoreToV1(v2Score) {
  const per = beatsPerMeasure(v2Score);
  const parts = [];
  let index = 0;
  for (const part of v2Score.parts || []) {
    for (const staff of part.staves || []) {
      const voices = staff.voices || [];
      if (!voices.length) {
        parts.push(v1PartFromVoice(v2Score, part, staff, { id: `${staff.id}-empty`, events: [] }, index));
        index += 1;
        continue;
      }
      for (const voice of voices) {
        parts.push(v1PartFromVoice(v2Score, part, staff, voice, index));
        index += 1;
      }
    }
  }
  return {
    title: v2Score.title,
    tempo: v2Score.tempo,
    beatsPerMeasure: per,
    beatType: (v2Score.timeSignature || {}).beatType || 4,
    keyFifths: v2Score.keyFifths || 0,
    parts: parts.length ? parts : [],
    measuresPerLine: v2Score.measuresPerLine || 2,
    // 带 v2 引用，界面改完能写回 v2
    v2Score,
  };
}

/**
 * 把 v1 里的「选中/编辑结果」写回 v2。
 * 用法：界面操作 v1（addNote/removeNote/setNoteBeats），
 * 然后调用 writeBack（带 v2Event 引用）把结果同步到 v2 模型，保证 Playback/Export v1 一致。
 */
export function writeBackEvent(v2Score, v1Part, v1Beat, upTo) {
  if (!v1Beat || !v1Beat.v2Event) return;
  const event = v1Beat.v2Event;
  // 时长/音高在 v2 侧统一同步（拆段只影响 v1 视图，v2 保持原样）
  if (typeof upTo.midi === "number") event.midi = upTo.midi;
  if (typeof upTo.beats === "number") event.beats = round(upTo.beats);
  if (typeof upTo.beat === "number") event.beat = round(upTo.beat);
  if (upTo.flagKey) {
    if (upTo.flagKey === "articulations" || upTo.flagKey === "ornaments") {
      const list = Array.isArray(event[upTo.flagKey]) ? [...event[upTo.flagKey]] : [];
      const at = list.indexOf(upTo.flagValue);
      if (at >= 0) list.splice(at, 1); else list.push(upTo.flagValue);
      event[upTo.flagKey] = list;
    } else if (event[upTo.flagKey] === upTo.flagValue) {
      delete event[upTo.flagKey];
    } else {
      event[upTo.flagKey] = upTo.flagValue;
    }
  }
}

/** 找 v1 声部对应的 v2 voice。 */
export function v2VoiceFor(v1Part) {
  const v2 = v2ScoreOf(v1Part);
  if (!v2) return null;
  const part = (v2.parts || []).find((item) => item.id === v1Part.v2.partId);
  if (!part) return null;
  const staff = (part.staves || [])[Math.max(0, (v1Part.v2.staffIndex || 1) - 1)];
  if (!staff) return null;
  return (staff.voices || []).find((voice) => voice.id === v1Part.v2.voiceId) || null;
}

function v2ScoreOf(v1Part) {
  return v1Part && v1Part.v2Score;
}

/** 判断一个 v1 声部是不是 v2 的一部分。 */
export function isV2Part(v1Part) {
  return Boolean(v1Part && v1Part.v2 && v1Part.v2Score);
}

/** 从 v1 声部收集全部 v2 事件引用（供界面用）。 */
export function v2EventsOf(v1Part) {
  const seen = new Map();
  for (const measure of v1Part.measures || []) {
    for (const beat of measure.beats || []) {
      if (beat.v2Event) seen.set(beat.v2Event.id, beat.v2Event);
    }
  }
  return [...seen.values()];
}

export { createV2Score, createV2Part, createV2Staff, createV2Voice };
