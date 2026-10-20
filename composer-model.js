// 「谱见」创作室 v2 数据模型：多声部 + 绝对拍位。
//
// 为什么要换模型
// --------------
// 旧模型是「单声部顺序」：一个声部里，前一个音多长，后一个音就从哪里开始。
// 这装不下真实乐谱：
//   · 同一小节内多条并行声部（右手旋律 + 内声部 + 左手伴奏）会互相挤占拍位；
//   · 长音跨小节（用连音线接起来）无法表达；
//   · 同一拍上的和弦只能靠 chordMidis 打补丁。
// 实测《进击的巨人》第 1 页：229 个音符、83 个和弦、50 个连音线、8 个圆滑线、4 条 voice，
// 旧模型导入后拍位只有约一半吻合。
//
// 新模型
// ------
// score = {
//   title, tempo, timeSignature: {beats, beatType}, keyFifths, clef,
//   parts: [{
//     id, name, timbre, clef, octave, volume,
//     staves: [{ voices: [ { id, events: [Event] } ] }]   // 每条谱表可有多条并行 voice
//   }],
//   tempoChanges: [{beat, bpm}],        // 中途变速
//   systemTexts: [{beat, text}]         // 表情术语等
// }
//
// Event（绝对拍位，单位：四分音符 = 1 拍）：
//   { id, beat, beats,                       // 起拍（从曲首算）与时长，允许小数（三连音）
//     midi,                                  // 休止符时忽略
//     rest, chordWith,                       // chordWith=同一拍上和弦的主音 id
//     tie, slur,                             // 连音/圆滑线
//     accidental,                            // 手动指定升降还原（null=自动）
//     articulations: [], ornaments: [],
//     dynamic,                               // 该拍起的力度（p/mf/f…）
//     wedge,                                 // 渐强/渐弱起点
//     lyric, tuplet, fermata, ...
//   }
//
// 所有坐标都是「绝对拍位」，因此并行声部不会互相挤占，跨小节长音天然成立。

export const BEAT_EPSILON = 1e-6;

/** 常用时值（以四分音符为 1 拍）。包含 32 分、复附点与三连音，覆盖真实乐谱。 */
export const NOTE_VALUES = [
  { beats: 8, label: "倍全音符", dots: 0 },
  { beats: 6, label: "附点全音符", dots: 1 },
  { beats: 4, label: "全音符", dots: 0 },
  { beats: 3, label: "附点二分音符", dots: 1 },
  { beats: 2, label: "二分音符", dots: 0 },
  { beats: 1.5, label: "附点四分音符", dots: 1 },
  { beats: 1, label: "四分音符", dots: 0 },
  { beats: 0.75, label: "附点八分音符", dots: 1 },
  { beats: 0.5, label: "八分音符", dots: 0 },
  { beats: 0.375, label: "附点十六分音符", dots: 1 },
  { beats: 0.25, label: "十六分音符", dots: 0 },
  { beats: 0.1875, label: "附点三十二分音符", dots: 1 },
  { beats: 0.125, label: "三十二分音符", dots: 0 },
  { beats: 0.0625, label: "六十四分音符", dots: 0 },
  // 三连音（3 个音占 2 个音的时间）
  { beats: 2 / 3, label: "四分三连音", tuplet: 3 },
  { beats: 1 / 3, label: "八分三连音", tuplet: 3 },
  { beats: 1 / 6, label: "十六分三连音", tuplet: 3 },
];

export const REST_VALUES = NOTE_VALUES.map((item) => ({ ...item, rest: true }));

/** 力度记号（从最轻到最响）。 */
export const DYNAMICS = [
  { key: "ppp", label: "极弱" }, { key: "pp", label: "很弱" }, { key: "p", label: "弱" },
  { key: "mp", label: "中弱" }, { key: "mf", label: "中强" }, { key: "f", label: "强" },
  { key: "ff", label: "很强" }, { key: "fff", label: "极强" },
  { key: "sfz", label: "突强" }, { key: "fp", label: "强后即弱" },
];

/** 演奏记号。 */
export const ARTICULATIONS = [
  { key: "staccato", label: "断奏（跳音）" },
  { key: "accent", label: "重音" },
  { key: "tenuto", label: "保持" },
  { key: "marcato", label: "强断奏" },
  { key: "fermata", label: "延音" },
];

/** 装饰音。 */
export const ORNAMENTS = [
  { key: "trill", label: "颤音" },
  { key: "turn", label: "回音" },
  { key: "mordent", label: "波音" },
  { key: "grace", label: "倚音" },
];

let idCounter = 0;
/** 生成 id（可注入前缀，便于测试稳定）。 */
export function makeId(prefix = "id") {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function round(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

/** 新建一个空声部（一条谱表里的一条 voice）。 */
export function createVoice(options = {}) {
  return { id: options.id || makeId("voice"), events: options.events || [] };
}

/** 新建一条谱表（默认一条 voice）。 */
export function createStaff(options = {}) {
  return {
    id: options.id || makeId("staff"),
    clef: options.clef || "treble",
    voices: options.voices || [createVoice()],
  };
}

/** 新建一个声部（一个演奏单元，可有多条谱表，例如钢琴的上下两行）。 */
export function createPart(options = {}) {
  return {
    id: options.id || makeId("part"),
    name: options.name || "新声部",
    timbre: options.timbre || "piano",
    octave: Number(options.octave) || 0,
    volume: Number.isFinite(Number(options.volume)) ? Number(options.volume) : 1,
    staves: options.staves || [createStaff({ clef: options.clef || "treble" })],
  };
}

/** 新建乐谱。 */
export function createScore(options = {}) {
  const timeSignature = options.timeSignature || { beats: 4, beatType: 4 };
  return {
    version: 2,
    title: options.title || "未命名乐谱",
    tempo: Number(options.tempo) || 84,
    timeSignature,
    keyFifths: Number(options.keyFifths) || 0,
    parts: options.parts || [createPart({ name: "旋律", clef: options.clef || "treble" })],
    tempoChanges: options.tempoChanges || [],
    systemTexts: options.systemTexts || [],
    measuresPerLine: Number(options.measuresPerLine) || 2,
  };
}

/** 每小节的拍数（四分音符为单位）；6/8 就是 3。 */
export function beatsPerMeasure(score) {
  const time = (score && score.timeSignature) || { beats: 4, beatType: 4 };
  const beats = Number(time.beats) || 4;
  const beatType = Number(time.beatType) || 4;
  return (beats * 4) / beatType;
}

/**
 * 新建一个音符事件。
 * @param {object} options
 */
export function createEvent(options = {}) {
  const event = {
    id: options.id || makeId("ev"),
    beat: round(Number(options.beat) || 0),
    beats: round(Number(options.beats) || 1),
    midi: Math.round(Number(options.midi) || 60),
  };
  if (options.rest) event.rest = true;
  if (options.chordWith) event.chordWith = options.chordWith;
  if (options.tie) event.tie = options.tie;                 // "start" | "stop" | "continue"
  if (options.slur) event.slur = options.slur;              // "start" | "stop"
  if (options.accidental) event.accidental = options.accidental;  // "sharp"|"flat"|"natural"|"##"|"bb"
  if (options.articulations && options.articulations.length) event.articulations = [...options.articulations];
  if (options.ornaments && options.ornaments.length) event.ornaments = [...options.ornaments];
  if (options.dynamic) event.dynamic = options.dynamic;
  if (options.wedge) event.wedge = options.wedge;           // "crescendo" | "diminuendo" | "stop"
  if (options.lyric) event.lyric = options.lyric;
  if (options.tuplet) event.tuplet = options.tuplet;        // 3 / 5 / 7
  if (options.fermata) event.fermata = true;
  if (options.grace) event.grace = true;
  return event;
}

/** 某条 voice 的全部事件按拍位排序后的副本。 */
export function sortedEvents(voice) {
  return [...((voice && voice.events) || [])].sort((left, right) => left.beat - right.beat);
}

/**
 * 一条 voice 内、某个拍位上的全部事件（含和弦）。
 * 返回 [主音, ...和弦附加音]。
 */
export function eventsAtBeat(voice, beat) {
  const target = round(beat);
  return ((voice && voice.events) || []).filter((event) => Math.abs(event.beat - target) < BEAT_EPSILON);
}

/**
 * 覆盖检查：一条 voice 在某个区间内是否已经有音。
 * @returns {boolean} true 表示区间被占用（不能直接放新音）
 */
export function isRangeFree(voice, beat, beats, { ignoreId = null } = {}) {
  const start = round(beat);
  const end = round(beat + beats);
  for (const event of (voice && voice.events) || []) {
    if (ignoreId && event.id === ignoreId) continue;
    const eventEnd = round(event.beat + event.beats);
    if (event.beat < end - BEAT_EPSILON && eventEnd > start + BEAT_EPSILON) return false;
  }
  return true;
}

/** 一条 voice 已用到的最远拍位。 */
export function voiceEndBeat(voice) {
  let end = 0;
  for (const event of (voice && voice.events) || []) {
    end = Math.max(end, event.beat + event.beats);
  }
  return round(end);
}

/** 乐谱总长度（拍）。 */
export function scoreTotalBeats(score) {
  let total = 0;
  for (const part of (score && score.parts) || []) {
    for (const staff of part.staves || []) {
      for (const voice of staff.voices || []) {
        total = Math.max(total, voiceEndBeat(voice));
      }
    }
  }
  return round(total);
}

/** 小节数（按拍号向上取整）。 */
export function measureCount(score) {
  const per = beatsPerMeasure(score);
  if (per <= 0) return 1;
  return Math.max(1, Math.ceil(scoreTotalBeats(score) / per - BEAT_EPSILON));
}

/** 第 measureIndex 小节（0 起）的起拍。 */
export function measureStartBeat(score, measureIndex) {
  return round(measureIndex * beatsPerMeasure(score));
}

/**
 * 添加一个事件（音符/休止/和弦音）。
 *
 * 与旧模型的差别：这里不「往后排」，而是把它放在**指定拍位**。
 * 拍位冲突时返回失败原因，由界面决定是提示还是另起一条 voice。
 *
 * @returns {{ok: boolean, event?: object, reason?: string, conflict?: object[]}}
 */
export function addEvent(voice, options = {}) {
  if (!voice) return { ok: false, reason: "no-voice" };
  const beat = round(Number(options.beat) || 0);
  const beats = round(Number(options.beats) || 1);
  if (beat < -BEAT_EPSILON) return { ok: false, reason: "negative-beat" };
  if (beats <= 0) return { ok: false, reason: "zero-length" };

  // 和弦音：与主音同拍同长，不算时间占用
  if (options.chordWith) {
    const anchor = (voice.events || []).find((item) => item.id === options.chordWith);
    if (!anchor) return { ok: false, reason: "missing-anchor" };
    const event = createEvent({ ...options, beat: anchor.beat, beats: anchor.beats });
    voice.events.push(event);
    return { ok: true, event };
  }

  if (!isRangeFree(voice, beat, beats, { ignoreId: options.id })) {
    const conflict = ((voice.events) || []).filter((event) => {
      const eventEnd = event.beat + event.beats;
      return event.beat < beat + beats - BEAT_EPSILON && eventEnd > beat + BEAT_EPSILON;
    });
    return { ok: false, reason: "overlap", conflict };
  }
  const event = createEvent({ ...options, beat, beats });
  voice.events.push(event);
  return { ok: true, event };
}

/** 删除一个事件（删除和弦主音时连带删掉它的附加音）。 */
export function removeEvent(voice, eventId) {
  if (!voice) return false;
  const before = voice.events.length;
  voice.events = voice.events.filter((event) => event.id !== eventId && event.chordWith !== eventId);
  return voice.events.length !== before;
}

/** 修改时值（会做冲突检查）。 */
export function setEventBeats(voice, eventId, beats) {
  const event = (voice && voice.events || []).find((item) => item.id === eventId);
  if (!event) return { ok: false, reason: "not-found" };
  const next = round(Number(beats) || 0);
  if (next <= 0) return { ok: false, reason: "zero-length" };
  if (!isRangeFree(voice, event.beat, next, { ignoreId: event.id })) {
    return { ok: false, reason: "overlap" };
  }
  const delta = next - event.beats;
  event.beats = next;
  // 和弦附加音跟着主音变
  for (const item of voice.events) {
    if (item.chordWith === event.id) item.beats = next;
  }
  return { ok: true, event, delta };
}

/** 移动事件到新拍位（会做冲突检查）。 */
export function moveEvent(voice, eventId, beat) {
  const event = (voice && voice.events || []).find((item) => item.id === eventId);
  if (!event) return { ok: false, reason: "not-found" };
  const next = round(Number(beat) || 0);
  if (next < 0) return { ok: false, reason: "negative-beat" };
  if (!isRangeFree(voice, next, event.beats, { ignoreId: event.id })) {
    return { ok: false, reason: "overlap" };
  }
  const delta = next - event.beat;
  event.beat = next;
  for (const item of voice.events) {
    if (item.chordWith === event.id) item.beat = next;
  }
  return { ok: true, event, delta };
}

/** 改音高。 */
export function setEventMidi(voice, eventId, midi) {
  const event = (voice && voice.events || []).find((item) => item.id === eventId);
  if (!event) return { ok: false, reason: "not-found" };
  const value = Math.round(Number(midi));
  if (!Number.isFinite(value) || value < 0 || value > 127) return { ok: false, reason: "out-of-range" };
  event.midi = value;
  return { ok: true, event };
}

/** 切换属性（articulation / ornament / dynamic / tie / slur 等）。 */
export function toggleEventFlag(voice, eventId, key, value) {
  const event = (voice && voice.events || []).find((item) => item.id === eventId);
  if (!event) return { ok: false, reason: "not-found" };
  if (key === "articulations" || key === "ornaments") {
    const list = Array.isArray(event[key]) ? [...event[key]] : [];
    const index = list.indexOf(value);
    if (index >= 0) list.splice(index, 1);
    else list.push(value);
    event[key] = list;
    return { ok: true, event, on: index < 0 };
  }
  // 单值属性：再点一次取消
  if (event[key] === value) {
    delete event[key];
    return { ok: true, event, on: false };
  }
  event[key] = value;
  return { ok: true, event, on: true };
}

/** 找到某个拍位可以放置的 voice：优先当前 voice，占用则返回 null（由界面决定加新 voice）。 */
export function findFreeVoice(staff, beat, beats) {
  for (const voice of (staff && staff.voices) || []) {
    if (isRangeFree(voice, beat, beats)) return voice;
  }
  return null;
}

/** 深拷贝乐谱（撤销/重做用）。 */
export function cloneScore(score) {
  return JSON.parse(JSON.stringify(score));
}

/** 把乐谱展开成播放用的音符列表。 */
export function scoreToPlayableNotes(score) {
  const notes = [];
  for (const part of (score && score.parts) || []) {
    for (const staff of part.staves || []) {
      for (const voice of staff.voices || []) {
        for (const event of voice.events || []) {
          if (event.rest) continue;
          notes.push({
            midi: event.midi + (Number(part.octave) || 0) * 12,
            startBeat: event.beat,
            durationBeats: event.beats,
            partId: part.id,
            partName: part.name || part.id,
            timbre: part.timbre || "piano",
            volume: Number.isFinite(Number(part.volume)) ? Number(part.volume) : 1,
            voiceId: voice.id,
            // 谱表号与 voice 号：同一拍同一音高可能同时出现在不同谱表，
            // 对账/导出/显示都需要它们来区分。
            staff: Number(staff.number) || 1,
            voice: Number(voice.number) || 1,
            eventId: event.id,
            chord: Boolean(event.chordWith),
          });
        }
      }
    }
  }
  return notes.sort((left, right) => left.startBeat - right.startBeat);
}

/** 谱号对应的 MIDI 参考（用于把音高画到五线谱上）。 */
export function clefReference(clef) {
  switch (clef) {
    case "bass": return 42;      // F3 在低音谱第四线
    case "alto": return 48;      // C4 在中音谱第三线
    case "treble": default: return 64;  // G4 在高音谱第二线
  }
}
