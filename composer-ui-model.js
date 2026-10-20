// 创作室界面 ↔ v2 模型（多声部 + 绝对拍位）的适配层。
//
// 职责：
//   · 把界面上的「当前状态」（选中的声部/谱表/voice、音高、时值、拍位游标）
//     翻译成 v2 模型里的绝对拍位操作；
//   · 渲染时把 v2 模型的小节/拍位结构摊平成界面用的小节视图；
//   · 加音/删音/改时值/加小节等操作全部走 v2 模型的冲突检查，
//     失败时给用户看得懂的提示，而不是静默丢数据。
//
// 纯逻辑 + 少量 DOM，可单测：tests/composer-ui-model.test.mjs

import {
  addEvent, removeEvent, setEventBeats, moveEvent, setEventMidi, toggleEventFlag,
  eventsAtBeat, isRangeFree, scoreTotalBeats, measureCount, beatsPerMeasure,
  round, cloneScore, NOTE_VALUES, DYNAMICS, ARTICULATIONS, ORNAMENTS,
  createVoice, createStaff, createPart, createScore,
} from "./composer-model.js";

/** 一条 voice 的「光标」：下一个音放在哪里（绝对拍位）。 */
function nextBeatFor(voice) {
  let end = 0;
  for (const event of (voice && voice.events) || []) {
    end = Math.max(end, event.beat + event.beats);
  }
  return round(end);
}

/**
 * 界面状态：用户正在写哪条 voice。
 * @typedef {{partIndex:number, staffIndex:number, voiceIndex:number}} VoiceRef
 */

/** 取当前 voice。 */
export function currentVoice(score, ref) {
  const part = (score && score.parts || [])[ref.partIndex];
  if (!part) return null;
  const staff = (part.staves || [])[ref.staffIndex];
  if (!staff) return null;
  return (staff.voices || [])[ref.voiceIndex] || staff.voices[0] || null;
}

/** 默认 ref（第一个 voice）。 */
export function defaultVoiceRef() {
  return { partIndex: 0, staffIndex: 0, voiceIndex: 0 };
}

/** 修正越界的 ref（删声部后用到）。 */
export function clampVoiceRef(score, ref) {
  const parts = (score && score.parts) || [];
  const safe = { ...defaultVoiceRef(), ...ref };
  safe.partIndex = Math.min(safe.partIndex, Math.max(0, parts.length - 1));
  const part = parts[safe.partIndex];
  if (!part || !part.staves.length) return defaultVoiceRef();
  safe.staffIndex = Math.min(safe.staffIndex, Math.max(0, part.staves.length - 1));
  const staff = part.staves[safe.staffIndex];
  if (!staff || !staff.voices.length) return defaultVoiceRef();
  safe.voiceIndex = Math.min(safe.voiceIndex, Math.max(0, staff.voices.length - 1));
  return safe;
}

/**
 * 在当前 voice 的末尾加一个音/休止。
 * @returns {{ok:boolean, event?:object, reason?:string, conflict?:object[]}}
 */
export function appendNote(score, ref, { midi, beats, rest = false, extras = {} }) {
  const voice = currentVoice(score, ref);
  if (!voice) return { ok: false, reason: "no-voice" };
  const beat = nextBeatFor(voice);
  const result = addEvent(voice, { beat, beats, midi: rest ? 0 : midi, rest, ...extras });
  return result;
}

/** 在指定拍位加一个音（点谱面空位时用）。 */
export function insertNoteAt(score, ref, beat, { midi, beats, rest = false, extras = {} }) {
  const voice = currentVoice(score, ref);
  if (!voice) return { ok: false, reason: "no-voice" };
  return addEvent(voice, {
    beat: round(Number(beat) || 0), beats, midi: rest ? 0 : midi, rest, ...extras,
  });
}

/**
 * 在当前选中的拍位加一个**和弦附加音**（与选中音同拍同长）。
 */
export function appendChordTone(score, ref, eventId, midi) {
  const voice = currentVoice(score, ref);
  if (!voice) return { ok: false, reason: "no-voice" };
  if (!eventId) return { ok: false, reason: "no-anchor" };
  return addEvent(voice, { midi, chordWith: eventId });
}

/**
 * 删除一个事件。
 */
export function deleteEvent(score, ref, eventId) {
  const voice = currentVoice(score, ref);
  if (!voice) return { ok: false, reason: "no-voice" };
  return { ok: removeEvent(voice, eventId) };
}

/** 改时值。 */
export function changeEventBeats(score, ref, eventId, beats) {
  const voice = currentVoice(score, ref);
  if (!voice) return { ok: false, reason: "no-voice" };
  return setEventBeats(voice, eventId, beats);
}

/** 改音高。 */
export function changeEventMidi(score, ref, eventId, midi) {
  const voice = currentVoice(score, ref);
  if (!voice) return { ok: false, reason: "no-voice" };
  return setEventMidi(voice, eventId, midi);
}

/** 移动拍位。 */
export function changeEventBeat(score, ref, eventId, beat) {
  const voice = currentVoice(score, ref);
  if (!voice) return { ok: false, reason: "no-voice" };
  return moveEvent(voice, eventId, beat);
}

/** 开关某个记号。 */
export function toggleFlag(score, ref, eventId, key, value) {
  const voice = currentVoice(score, ref);
  if (!voice) return { ok: false, reason: "no-voice" };
  return toggleEventFlag(voice, eventId, key, value);
}

/** 加一条 voice（钢琴谱左手/右手要分开写时用）。 */
export function addVoiceTo(score, ref) {
  const part = (score.parts || [])[ref.partIndex];
  if (!part) return { ok: false, reason: "no-part" };
  const staff = (part.staves || [])[ref.staffIndex];
  if (!staff) return { ok: false, reason: "no-staff" };
  const usedNumbers = staff.voices.map((voice) => voice.number || 1);
  const nextNumber = Math.max(1, ...usedNumbers) + 1;
  const voice = createVoice({});
  voice.number = nextNumber;
  staff.voices.push(voice);
  return { ok: true, voice, voiceIndex: staff.voices.length - 1 };
}

/** 加一条谱表（钢琴第二行）。 */
export function addStaffTo(score, ref) {
  const part = (score.parts || [])[ref.partIndex];
  if (!part) return { ok: false, reason: "no-part" };
  const usedNumbers = part.staves.map((staff) => staff.number || 1);
  const staff = createStaff({});
  staff.number = Math.max(1, ...usedNumbers) + 1;
  part.staves.push(staff);
  return { ok: true, staff, staffIndex: part.staves.length - 1 };
}

/**
 * 把乐谱摊平成「小节视图」（界面渲染用）。
 * @returns {{measures: Array<{index:number, startBeat:number, endBeat:number,
 *            rows: Array<{staff:number, voice:number, events:Array}>}>,
 *            totalMeasures:number, beatsPerMeasure:number, totalBeats:number}}
 */
export function buildMeasureView(score) {
  const per = beatsPerMeasure(score);
  const total = scoreTotalBeats(score);
  const count = Math.max(1, Math.ceil(total / per), measureCount(score));
  const measures = [];
  for (let index = 0; index < count; index += 1) {
    const startBeat = round(index * per);
    const endBeat = round(startBeat + per);
    const rows = [];
    for (const part of score.parts || []) {
      (part.staves || []).forEach((staff, staffIndex) => {
        (staff.voices || []).forEach((voice, voiceIndex) => {
          const events = (voice.events || [])
            .filter((event) => event.beat < endBeat - 1e-6 && event.beat + event.beats > startBeat + 1e-6)
            .map((event) => ({
              ...event,
              // 相对本小节的位置（渲染/命中测试用）；跨小节的音这里会露出「超出」部分
              offsetInMeasure: round(event.beat - startBeat),
              clippedBeats: round(Math.min(event.beat + event.beats, endBeat) - Math.max(event.beat, startBeat)),
            }))
            .sort((left, right) => left.beat - right.beat
              || (left.chordWith ? 1 : 0) - (right.chordWith ? 1 : 0));
          rows.push({
            partId: part.id, partName: part.name, partIndex: score.parts.indexOf(part),
            staffIndex: staffIndex + 1, voiceIndex: voiceIndex,
            voiceId: voice.id, events,
          });
        });
      });
    }
    measures.push({ index, startBeat, endBeat, rows });
  }
  return { measures, totalMeasures: count, beatsPerMeasure: per, totalBeats: total };
}

/** 某个事件在界面上的「第几小节 / 小节内第几拍」（提示文字用）。 */
export function describeEvent(score, event) {
  const per = beatsPerMeasure(score);
  const measureIndex = Math.floor(event.beat / per) + 1;
  const offset = round(event.beat - (measureIndex - 1) * per);
  return `第 ${measureIndex} 小节，从第 ${round(offset + 1)} 拍开始`;
}

/** 把「失败原因」翻译成人话。 */
export function explainReason(reason) {
  switch (reason) {
    case "overlap": return "这个位置已经有音符了，可以换个拍位，或者放到另一条声部里。";
    case "no-voice": return "还没有可写入的声部。";
    case "no-part": case "no-staff": return "当前没有选中的声部。";
    case "no-anchor": return "请先在谱面上点一个已有的音，再往上叠加和弦。";
    case "zero-length": return "音符不能没有时长。";
    case "negative-beat": return "位置不能在乐曲开始之前。";
    case "out-of-range": return "这个音高超出了可表示范围（钢琴是 88 键）。";
    case "not-found": return "没有找到要修改的音符。";
    case "missing-anchor": return "要叠加和弦的那个音已经不在了。";
    default: return "操作没有成功，请再试一次。";
  }
}

export {
  NOTE_VALUES, DYNAMICS, ARTICULATIONS, ORNAMENTS, beatsPerMeasure, measureCount,
  scoreTotalBeats, cloneScore, createVoice, createStaff, createPart, createScore, round,
};
