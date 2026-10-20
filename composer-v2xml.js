// MusicXML ⇄ v2 模型（多声部 + 绝对拍位）的精确互转。
//
// 与旧转换层的根本区别：这里**不做任何近似**——
//   · 每个音符带着 MusicXML 里的精确拍位与时值，不做「顺序排列」；
//   · 用 <staves>/<staff> 区分上下两行谱表，用 <voice> 区分并行声部；
//   · 连音线（tie）、圆滑线（slur）、临时记号、力度、渐强、装饰音、三连音全部保留；
//   · 跨小节长音就存成一个跨小节的事件（不再拆段）。
//
// 因此「合上再打开」是无损的，可以支撑「对着谱子分毫不差复刻」这个目标。
// 纯函数，可单测：tests/composer-v2-xml.test.mjs

import {
  createScore, createPart, createStaff, createVoice, createEvent, addEvent,
  beatsPerMeasure, round, makeId,
} from "./composer-model.js";

const DIVISIONS_FALLBACK = 480;

// —— 标准 DOM 辅助（浏览器与 @xmldom/xmldom 都支持，不用 querySelector）——

/** 节点的直接子元素里名为 name 的第一个。 */
function child(node, name) {
  if (!node || !node.childNodes) return null;
  for (const item of node.childNodes) {
    if (item.nodeType === 1 && item.nodeName === name) return item;
  }
  return null;
}

/** 所有直接子元素里名为 name 的。 */
function children(node, name) {
  const out = [];
  if (!node || !node.childNodes) return out;
  for (const item of node.childNodes) {
    if (item.nodeType === 1 && item.nodeName === name) out.push(item);
  }
  return out;
}

/** 后代元素里名为 name 的全部。 */
function descendants(node, name) {
  if (!node || !node.getElementsByTagName) return [];
  return Array.from(node.getElementsByTagName(name));
}

/** 后代元素里名为 name 的第一个。 */
function first(node, name) {
  const list = descendants(node, name);
  return list.length ? list[0] : null;
}

/** 节点的文本内容（去空白）。 */
function textOf(node, name) {
  const target = name ? first(node, name) : node;
  return target && target.textContent ? target.textContent.trim() : "";
}

/** 节点自己的文本（不含子元素）。 */
function ownText(node) {
  let out = "";
  if (!node || !node.childNodes) return out;
  for (const item of node.childNodes) {
    if (item.nodeType === 3 || item.nodeType === 4) out += item.nodeValue || "";
  }
  return out.trim();
}

/** 从 MusicXML 根节点读取 divisions（每个四分音符的细分格数）。 */
function readDivisions(root) {
  const divisionsNode = first(root, "divisions");
  const value = divisionsNode ? Number(ownText(divisionsNode)) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DIVISIONS_FALLBACK;
}

/** "4/4" → {beats:4, beatType:4}。 */
export function parseTimeSignature(text, fallback = { beats: 4, beatType: 4 }) {
  const matched = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(text || ""));
  if (!matched) return { ...fallback };
  return { beats: Number(matched[1]), beatType: Number(matched[2]) };
}

/** 把「小节内的 divisions 位置」换算成「从曲首算的绝对拍位」。 */
function beatAtMeasure(measureIndex, beatsPerMeasureValue, offsetInMeasure) {
  return round(measureIndex * beatsPerMeasureValue + offsetInMeasure);
}

/**
 * MusicXML 文本 → v2 乐谱。
 *
 * 返回 {score, stats}：
 *   stats.notes     读到的音高事件数（含和弦）
 *   stats.rests     休止数
 *   stats.measures  小节数
 *   stats.ties / slurs / articulations / ornaments / dynamics 各类符号数量
 *   stats.byPart    每个声部的 {name, staves, voices, notes}
 */
export function musicXmlToV2(source, options = {}) {
  // 浏览器里用全局 DOMParser；Node 测试环境传入 @xmldom/xmldom 的实现。
  const Parser = options.DOMParser || (typeof DOMParser !== "undefined" ? DOMParser : null);
  if (!Parser) throw new Error("缺少 XML 解析器：浏览器环境应提供 DOMParser。");
  const documentNode = new Parser().parseFromString(source, "application/xml");
  const parseError = first(documentNode, "parsererror");
  if (parseError) throw new Error("MusicXML 内容无法解析，请确认文件完整。");
  const root = documentNode.documentElement;
  if (!root || root.tagName !== "score-partwise") {
    throw new Error("只能读取 score-partwise 格式的 MusicXML。");
  }

  const partList = first(root, "part-list");
  const partNameById = new Map();
  for (const scorePart of partList ? descendants(partList, "score-part") : []) {
    partNameById.set(scorePart.getAttribute("id"),
      textOf(scorePart, "part-name") || scorePart.getAttribute("id"));
  }

  // 全局设置（取第一处拍号/调号/速度）
  let timeSignature = { beats: 4, beatType: 4 };
  let keyFifths = 0;
  let tempo = 84;
  const tempoChanges = [];
  const systemTexts = [];
  const seenTime = new Set();

  const parts = [];
  const stats = {
    notes: 0, rests: 0, measures: 0, chords: 0, ties: 0, slurs: 0,
    articulations: 0, ornaments: 0, dynamics: 0, wedges: 0, graces: 0, tuplets: 0,
    byPart: [],
  };

  for (const partNode of descendants(root, "part")) {
    const partId = partNode.getAttribute("id") || makeId("part");
    const partName = partNameById.get(partId) || partId;
    const divisions = readDivisions(partNode);
    // 谱表号 → 谱表；voice 号 → voice（同一个 (staff, voice) 全局复用）
    const staffMap = new Map();
    const partStats = { name: partName, staves: 0, voices: 0, notes: 0 };

    const ensureStaff = (staffNumber, clef) => {
      const key = String(staffNumber || 1);
      if (!staffMap.has(key)) {
        const staff = createStaff({ id: `${partId}-staff${key}`, clef: clef || "treble" });
        staff.number = Number(key);
        staffMap.set(key, { staff, voices: new Map() });
        partStats.staves += 1;
      }
      return staffMap.get(key);
    };
    const ensureVoice = (entry, voiceNumber) => {
      const key = String(voiceNumber || 1);
      if (!entry.voices.has(key)) {
        const voice = createVoice({ id: `${entry.staff.id}-voice${key}` });
        voice.number = Number(key);
        entry.staff.voices.push(voice);
        entry.voices.set(key, voice);
        partStats.voices += 1;
      }
      return entry.voices.get(key);
    };

    let measureIndex = 0;
    let per = 4;   // 当前拍号换算出的每小节拍数
    // 每个 (staff, voice) 的「小节内游标」，单位是 divisions
    const cursors = new Map();
    // tie 起始音，用于把连音线记在正确的音上（音高 → 上一个 tie start 的事件）
    const pendingTies = new Map();

    for (const measureNode of descendants(partNode, "measure")) {
      // 读本小节的拍号/调号/谱号变化
      for (const attr of children(measureNode, "attributes")) {
        const timeNode = first(attr, "time");
        if (timeNode) {
          const beatsText = textOf(timeNode, "beats");
          const typeText = textOf(timeNode, "beat-type");
          if (beatsText && typeText) {
            timeSignature = { beats: Number(beatsText), beatType: Number(typeText) };
            per = (timeSignature.beats * 4) / timeSignature.beatType;
            const key = `${timeSignature.beats}/${timeSignature.beatType}`;
            if (!seenTime.size) {
              seenTime.add(key);
            }
          }
        }
        const keyNode = first(first(attr, "key") || attr, "fifths");
        if (keyNode) keyFifths = Number(ownText(keyNode));
        for (const clefNode of descendants(attr, "clef")) {
          const sign = textOf(clefNode, "sign") || "G";
          const number = clefNode.getAttribute("number") || "1";
          const clef = sign === "F" ? "bass" : sign === "C" ? "alto" : "treble";
          ensureStaff(number, clef).staff.clef = clef;
        }
      }

      // 速度与文字
      for (const direction of children(measureNode, "direction")) {
        const soundNode = first(direction, "sound");
        const metronome = first(direction, "per-minute");
        const tempoValue = soundNode && soundNode.getAttribute("tempo")
          ? Number(soundNode.getAttribute("tempo"))
          : metronome ? Number(ownText(metronome)) : NaN;
        const beat = (measureIndex) * per;
        if (Number.isFinite(tempoValue) && tempoValue > 0) {
          if (!tempoChanges.length && measureIndex === 0) tempo = Math.round(tempoValue);
          tempoChanges.push({ beat: round(beat), bpm: tempoValue });
        }
        const words = first(direction, "words");
        const wordsText = words ? (words.textContent || "").trim() : "";
        if (wordsText) {
          systemTexts.push({ beat: round(beat), text: wordsText });
        }
        const wedge = first(direction, "wedge");
        if (wedge) stats.wedges += 1;
      }

      // 每个 (staff, voice) 本小节的游标
      cursors.clear();
      let maxCursor = 0;

      for (const noteNode of children(measureNode, "note")) {
        const staffNumber = textOf(noteNode, "staff") || "1";
        const voiceNumber = textOf(noteNode, "voice") || "1";
        const cursorKey = `${staffNumber}|${voiceNumber}`;
        const isChordTone = Boolean(child(noteNode, "chord"));
        const isGrace = Boolean(child(noteNode, "grace"));
        const durationDiv = Number(textOf(noteNode, "duration")) || 0;
        const durationBeats = round(durationDiv / divisions);
        const offset = isChordTone ? (cursors.get(`${cursorKey}|chord`) || 0) : (cursors.get(cursorKey) || 0);
        if (!isChordTone) {
          cursors.set(`${cursorKey}|chord`, offset);
          cursors.set(cursorKey, offset + durationBeats);
          maxCursor = Math.max(maxCursor, offset + durationBeats);
        }
        const beat = beatAtMeasure(measureIndex, per, offset);
        const entry = ensureStaff(staffNumber);
        const voice = ensureVoice(entry, voiceNumber);
        const isRest = Boolean(child(noteNode, "rest"));

        if (isGrace) stats.graces += 1;
        const timeMod = first(noteNode, "time-modification");
        if (timeMod) stats.tuplets += 1;

        // 读各类符号
        const articulations = [];
        for (const group of descendants(noteNode, "articulations")) {
          for (const node of Array.from(group.childNodes).filter((item) => item.nodeType === 1)) {
          const name = node.nodeName;
          if (name === "staccato" || name === "accent" || name === "tenuto" || name === "marcato") {
            articulations.push(name);
          } else if (name === "fermata") {
            articulations.push("fermata");
          }
          }
        }
        if (first(noteNode, "fermata") && !articulations.includes("fermata")) {
          articulations.push("fermata");
        }
        const ornaments = [];
        for (const node of descendants(noteNode, "ornaments")) {
          for (const item of Array.from(node.childNodes).filter((childNode) => childNode.nodeType === 1)) {
            const name = item.nodeName;
            if (["trill-mark", "turn", "mordent", "inverted-mordent"].includes(name)) {
              ornaments.push(name === "trill-mark" ? "trill" : name);
            }
          }
        }
        if (!isRest) {
          const accidental = textOf(noteNode, "accidental") || null;
          const ties = descendants(noteNode, "tie");
          const tied = descendants(noteNode, "tied");
          const slurNodes = descendants(noteNode, "slur");
          const tieStart = ties.some((node) => node.getAttribute("type") === "start")
            || tied.some((node) => node.getAttribute("type") === "start");
          const tieStop = ties.some((node) => node.getAttribute("type") === "stop")
            || tied.some((node) => node.getAttribute("type") === "stop");
          const slurStart = slurNodes.some((node) => node.getAttribute("type") === "start");
          const slurStop = slurNodes.some((node) => node.getAttribute("type") === "stop");
          const midi = readMidi(noteNode);
          if (midi === null) continue;

          // 和弦音：挂到同拍位的第一个音上
          let chordWith = null;
          if (isChordTone) {
            const anchor = (voice.events || []).find((event) =>
              Math.abs(event.beat - beat) < 1e-6 && !event.chordWith && !event.rest);
            if (anchor) chordWith = anchor.id;
          }
          const result = addEvent(voice, {
            beat, beats: durationBeats, midi, chordWith,
            ...(tieStart ? { tie: "start" } : {}),
            ...(tieStop ? { tieStop: true } : {}),
            ...(accidental ? { accidental } : {}),
            ...(articulations.length ? { articulations } : {}),
            ...(ornaments.length ? { ornaments } : {}),
            ...(slurStart ? { slur: "start" } : {}),
            ...(slurStop ? { slurStop: true } : {}),
            ...(isGrace ? { grace: true } : {}),
            ...(timeMod ? { tuplet: Number(textOf(timeMod, "actual-notes")) || 3 } : {}),
            ...(articulations.includes("fermata") ? { fermata: true } : {}),
          });
          if (!result.ok) {
            // 同一拍位重复（例如多个 voice 被合并）：跳过但不静默，记进统计
            stats.skipped = (stats.skipped || 0) + 1;
            continue;
          }
          stats.notes += 1;
          partStats.notes += 1;
          if (chordWith) stats.chords += 1;
          if (tieStart) stats.ties += 1;
          if (slurStart) stats.slurs += 1;
          if (articulations.length) stats.articulations += 1;
          if (ornaments.length) stats.ornaments += 1;
          if (isGrace) result.event.grace = true;
          // 记下 tie 起点，供后面的 tie stop 关联
          if (tieStart) pendingTies.set(midi, result.event.id);
          if (tieStop && pendingTies.has(midi)) pendingTies.delete(midi);
        } else {
          const result = addEvent(voice, { beat, beats: durationBeats, midi: 0, rest: true });
          if (result.ok) stats.rests += 1;
        }
      }

      // 力度记号：往后挂到最近一个音上（本小节内）
      for (const direction of children(measureNode, "direction")) {
        const dynamicsGroup = first(direction, "dynamics");
        const dynamicsNode = dynamicsGroup
          ? Array.from(dynamicsGroup.childNodes).filter((item) => item.nodeType === 1)[0]
          : null;
        if (!dynamicsNode) continue;
        stats.dynamics += 1;
        const dynamic = dynamicsNode.nodeName;
        for (const entry of staffMap.values()) {
          for (const voice of entry.staff.voices) {
            const candidate = (voice.events || [])
              .filter((event) => !event.chordWith && !event.rest && event.beat >= measureIndex * per - 1e-6
                && event.beat < (measureIndex + 1) * per)
              .sort((left, right) => left.beat - right.beat)[0];
            if (candidate && !candidate.dynamic) candidate.dynamic = dynamic;
          }
        }
      }

      measureIndex += 1;
      stats.measures = Math.max(stats.measures, measureIndex);
    }

    const staves = [...staffMap.values()].map((entry) => entry.staff);
    parts.push(createPart({
      id: partId, name: partName, staves: staves.length ? staves : undefined,
    }));
    stats.byPart.push(partStats);
  }

  const score = createScore({
    title: textOf(root, "work-title") || textOf(root, "movement-title") || "导入的乐谱",
    tempo,
    timeSignature,
    keyFifths,
    parts,
    tempoChanges: dedupeTempo(tempoChanges),
    systemTexts,
  });
  score.measures = Math.max(stats.measures, 1);
  return { score, stats };
}

function dedupeTempo(list) {
  const seen = new Set();
  const out = [];
  for (const item of list.sort((left, right) => left.beat - right.beat)) {
    const key = `${item.beat}|${item.bpm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 从 <note> 读 MIDI（含 alter）。 */
function readMidi(noteNode) {
  const pitch = child(noteNode, "pitch");
  if (!pitch) return null;
  const step = textOf(pitch, "step").toUpperCase();
  const octaveText = textOf(pitch, "octave");
  const octave = Number(octaveText);
  const alter = Number(textOf(pitch, "alter")) || 0;
  const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  if (!(step in semitones) || !Number.isFinite(octave)) return null;
  const midi = (octave + 1) * 12 + semitones[step] + Math.round(alter);
  return midi >= 0 && midi <= 127 ? midi : null;
}

/**
 * v2 乐谱 → MusicXML 文本。与 musicXmlToV2 互为逆运算（往返无损）。
 *
 * 用 480 divisions（与 MIDI 一致），把拍位与时长换算成整数 divisions；
 * 跨小节的事件按小节边界拆成多个 <note> 并用 <tie> 连接（MusicXML 的要求），
 * 但事件本身在模型里始终是一个。
 */
export function v2ToMusicXml(score) {
  const DIVISIONS = 480;
  const per = beatsPerMeasure(score);
  const totalMeasures = Math.max(
    1,
    ...score.parts.map((part) => Math.ceil(
      Math.max(0, ...part.staves.flatMap((staff) => staff.voices.flatMap((voice) =>
        (voice.events || []).map((event) => event.beat + event.beats)))) / per - 1e-9)),
  );
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  lines.push('<score-partwise version="4.0">');
  lines.push("  <work><work-title>" + escapeXml(score.title || "未命名乐谱") + "</work-title></work>");
  lines.push("  <part-list>");
  for (const part of score.parts) {
    lines.push(`    <score-part id="${escapeXml(part.id)}"><part-name>${escapeXml(part.name)}</part-name></score-part>`);
  }
  lines.push("  </part-list>");

  for (const part of score.parts) {
    lines.push(`  <part id="${escapeXml(part.id)}">`);
    for (let measureIndex = 0; measureIndex < totalMeasures; measureIndex += 1) {
      const measureStart = round(measureIndex * per);
      const measureEnd = round(measureStart + per);
      lines.push(`    <measure number="${measureIndex + 1}">`);
      if (measureIndex === 0) {
        const time = score.timeSignature || { beats: 4, beatType: 4 };
        lines.push("      <attributes>");
        lines.push(`        <divisions>${DIVISIONS}</divisions>`);
        lines.push(`        <key><fifths>${Number(score.keyFifths) || 0}</fifths></key>`);
        lines.push(`        <time><beats>${time.beats}</beats><beat-type>${time.beatType}</beat-type></time>`);
        const clef = (part.staves && part.staves[0] && part.staves[0].clef) || "treble";
        const sign = clef === "bass" ? "F" : clef === "alto" ? "C" : "G";
        const line = clef === "bass" ? 4 : clef === "alto" ? 3 : 2;
        lines.push(`        <clef><sign>${sign}</sign><line>${line}</line></clef>`);
        lines.push("      </attributes>");
        lines.push(`      <direction><direction-type><metronome><beat-unit>quarter</beat-unit>` +
          `<per-minute>${Math.round(score.tempo)}</per-minute></metronome></direction-type>` +
          `<sound tempo="${Math.round(score.tempo)}"/></direction>`);
      }
      // 中途变速与文字
      for (const change of score.tempoChanges || []) {
        if (Math.abs(change.beat - measureStart) < 1e-6) {
          lines.push(`      <direction><direction-type><metronome><beat-unit>quarter</beat-unit>` +
            `<per-minute>${Math.round(change.bpm)}</per-minute></metronome></direction-type>` +
            `<sound tempo="${Math.round(change.bpm)}"/></direction>`);
        }
      }
      for (const text of score.systemTexts || []) {
        if (Math.abs(text.beat - measureStart) < 1e-6) {
          lines.push(`      <direction><direction-type><words>${escapeXml(text.text)}</words></direction-type></direction>`);
        }
      }

      // 本小节内每条 (staff, voice) 的事件
      const staves = part.staves || [];
      staves.forEach((staff, staffIndex) => {
        const staffNumber = staffIndex + 1;
        for (const voice of staff.voices || []) {
          // voice 号必须如实写：写死成 1 会让同一谱表的多条 voice 在再导入时
          // 被合并到一条里，拍位互相覆盖（实测往返后 217 个音只剩 195 个）。
          const voiceNumber = voice.number || staff.voices.indexOf(voice) + 1;
          const events = (voice.events || [])
            .filter((event) => event.beat < measureEnd - 1e-6 && event.beat + event.beats > measureStart + 1e-6)
            .sort((left, right) => left.beat - right.beat
              || (left.chordWith ? 1 : 0) - (right.chordWith ? 1 : 0));
          for (const event of events) {
            // 跨小节的事件要截断到本小节，并用 tie 连接
            const start = Math.max(event.beat, measureStart);
            const end = Math.min(event.beat + event.beats, measureEnd);
            const length = round(end - start);
            if (length <= 1e-6) continue;
            const continues = event.beat < measureStart - 1e-6;   // 从前面小节延续过来
            const willContinue = event.beat + event.beats > measureEnd + 1e-6;
            lines.push(noteXml(event, {
              divisions: DIVISIONS, beats: length, staffNumber, per,
              tieStart: willContinue, tieStop: continues,
              voiceNumber,
              isChord: Boolean(event.chordWith),
            }));
          }
        }
      });
      lines.push("    </measure>");
    }
    lines.push("  </part>");
  }
  lines.push("</score-partwise>");
  return lines.join("\n");
}

function noteXml(event, options) {
  const { divisions, beats: length, staffNumber, voiceNumber = 1, tieStart, tieStop, isChord } = options;
  const duration = Math.max(1, Math.round(length * divisions));
  const pad = "        ";
  const lines = [`${pad}<note>`];
  if (isChord) lines.push(`${pad}  <chord/>`);
  if (event.rest) {
    lines.push(`${pad}  <rest/>`);
  } else {
    const { step, alter, octave } = midiToStepAlter(event.midi);
    lines.push(`${pad}  <pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>`);
  }
  lines.push(`${pad}  <duration>${duration}</duration>`);
  if (tieStop && !isChord) lines.push(`${pad}  <tie type="stop"/>`);
  if (tieStart && !isChord) lines.push(`${pad}  <tie type="start"/>`);
  lines.push(`${pad}  <voice>${voiceNumber}</voice>`);
  const typeInfo = typeOfBeats(length);
  lines.push(`${pad}  <type>${typeInfo.type}</type>`);
  for (let index = 0; index < typeInfo.dots; index += 1) lines.push(`${pad}  <dot/>`);
  if (event.accidental && !isChord) lines.push(`${pad}  <accidental>${event.accidental}</accidental>`);
  if (event.tuplet || typeInfo.timeModification) {
    lines.push(`${pad}  <time-modification><actual-notes>${typeInfo.timeModification ? typeInfo.timeModification[0] : 3}</actual-notes>` +
      `<normal-notes>${typeInfo.timeModification ? typeInfo.timeModification[1] : 2}</normal-notes></time-modification>`);
  }
  lines.push(`${pad}  <staff>${staffNumber}</staff>`);
  // notations：连音线/圆滑线/演奏记号/装饰音
  const notations = [];
  if (tieStop && !isChord) notations.push('<tied type="stop"/>');
  if (tieStart && !isChord) notations.push('<tied type="start"/>');
  if (event.slur === "start") notations.push('<slur type="start" number="1"/>');
  if (event.slurStop) notations.push('<slur type="stop" number="1"/>');
  const articulations = event.articulations || [];
  const artNodes = articulations.filter((item) => item !== "fermata")
    .map((item) => `<${item}/>`).join("");
  if (artNodes) notations.push(`<articulations>${artNodes}</articulations>`);
  if (event.fermata || articulations.includes("fermata")) notations.push("<fermata/>");
  const ornaments = (event.ornaments || []).map((item) => {
    const map = { trill: "trill-mark", turn: "turn", mordent: "mordent" };
    return map[item] ? `<${map[item]}/>` : "";
  }).join("");
  if (ornaments) notations.push(`<ornaments>${ornaments}</ornaments>`);
  if (notations.length) lines.push(`${pad}  <notations>${notations.join("")}</notations>`);
  if (event.dynamic) {
    lines.push(`${pad}  <direction><direction-type><dynamics><${event.dynamic}/></dynamics></direction-type></direction>`);
  }
  lines.push(`${pad}</note>`);
  return lines.join("\n");
}

const TYPE_TABLE = [
  { beats: 4, type: "whole" }, { beats: 2, type: "half" }, { beats: 1, type: "quarter" },
  { beats: 0.5, type: "eighth" }, { beats: 0.25, type: "16th" }, { beats: 0.125, type: "32nd" },
  { beats: 0.0625, type: "64th" },
];

/** 把拍数换算成 MusicXML 的 type + 附点数（尽量精确）。 */
export function typeOfBeats(beats) {
  const value = Number(beats) || 1;
  for (const dotCount of [0, 1, 2]) {
    for (const item of TYPE_TABLE) {
      const candidate = item.beats * (2 - 1 / (2 ** dotCount));
      if (Math.abs(candidate - value) < 1e-6) return { type: item.type, dots: dotCount };
    }
  }
  // 三连音：2/3 拍 = 四分三连音
  if (Math.abs(value - 2 / 3) < 1e-3) return { type: "quarter", dots: 0, timeModification: [3, 2] };
  if (Math.abs(value - 1 / 3) < 1e-3) return { type: "eighth", dots: 0, timeModification: [3, 2] };
  if (Math.abs(value - 1 / 6) < 1e-3) return { type: "16th", dots: 0, timeModification: [3, 2] };
  // 兜底：最接近的档位
  let best = TYPE_TABLE[2];
  let bestDiff = Infinity;
  for (const item of TYPE_TABLE) {
    const diff = Math.abs(item.beats - value);
    if (diff < bestDiff) { bestDiff = diff; best = item; }
  }
  return { type: best.type, dots: 0 };
}

/** MIDI → {step, alter, octave}。 */
export function midiToStepAlter(midi) {
  const value = Math.max(0, Math.min(127, Math.round(Number(midi) || 0)));
  const octave = Math.floor(value / 12) - 1;
  const semitone = ((value % 12) + 12) % 12;
  const table = [
    { step: "C", alter: 0 }, { step: "C", alter: 1 }, { step: "D", alter: 0 }, { step: "D", alter: 1 },
    { step: "E", alter: 0 }, { step: "F", alter: 0 }, { step: "F", alter: 1 }, { step: "G", alter: 0 },
    { step: "G", alter: 1 }, { step: "A", alter: 0 }, { step: "A", alter: 1 }, { step: "B", alter: 0 },
  ];
  const info = table[semitone];
  return { step: info.step, alter: info.alter, octave };
}

function escapeXml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
