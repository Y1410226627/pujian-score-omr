// 零基础友好的乐谱数据模型与「拼块」算法（纯函数，可在 node 里单测）。
//
// 设计出发点：不会认五线谱的人，脑子里有「一句话」而不是「二分音符 / 附点四分音符」。
// 所以这里的一切都从「一拍」出发：
//   · 时值用「几分之几拍」表示，界面显示成中文（四分音符、八分音符、附点…）；
//   · 输入音符时只给「音高 + 拍子」，位置由 buildMeasureSlots() 自动铺好；
//   · 每小节剩多少空隙、能不能再放一个音，由 remainingBeats() 算，界面据此提示。
//
// 一条乐谱 = { title, tempo, beatsPerMeasure, beatType, keyFifths, parts: [ { id, name, timbre, clef, octave, measures: [ { beats: [note...] } ] } ] }
// 一个 note = { id, midi, startBeats, beats, lyric? }
// 这里的 midi 是「实际发声音高」，音名显示由 midiToName() 给出，不需要用户懂谱号。

/** 界面上的时值选项：从「一拍」出发的常用值，label 是给零基础用户看的中文。 */
export const NOTE_VALUES = [
  { beats: 4, label: "全音符", hint: "整整 4 拍" },
  { beats: 3, label: "附点二分音符", hint: "3 拍" },
  { beats: 2, label: "二分音符", hint: "2 拍" },
  { beats: 1.5, label: "附点四分音符", hint: "1 拍半" },
  { beats: 1, label: "四分音符", hint: "1 拍" },
  { beats: 0.75, label: "附点八分音符", hint: "3/4 拍" },
  { beats: 0.5, label: "八分音符", hint: "半拍" },
  { beats: 0.375, label: "附点十六分音符", hint: "3/8 拍" },
  { beats: 0.25, label: "十六分音符", hint: "1/4 拍" },
];

/** 休止的选项（与音符一一对应，方便「这一拍先空着」）。 */
export const REST_VALUES = NOTE_VALUES.map((item) => ({ ...item, rest: true }));

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];

/** MIDI → 简谱式音名（C4 = 中央 C）。flat=true 用降号写法（F 大调等降号调更自然）。 */
export function midiToName(midi, { flat = false } = {}) {
  const value = Math.round(Number(midi));
  if (!Number.isFinite(value)) return "";
  const names = flat ? FLAT_NAMES : SHARP_NAMES;
  const pitch = ((value % 12) + 12) % 12;
  const octave = Math.floor(value / 12) - 1;
  return names[pitch] + octave;
}

/** 音名（C4 / F#3 / Bb2）→ MIDI；解析失败返回 NaN。 */
export function nameToMidi(name) {
  const matched = /^([A-Ga-g])([#♯b♭]?)(-?\d+)$/.exec(String(name || "").trim());
  if (!matched) return Number.NaN;
  const letter = matched[1].toUpperCase();
  const accidental = matched[2];
  const octave = Number(matched[3]);
  const base = (octave + 1) * 12 + LETTERS.indexOf(letter);
  const offset = accidental === "#" || accidental === "♯" ? 1 : accidental === "b" || accidental === "♭" ? -1 : 0;
  return base + offset;
}

/** 一个音在钢琴上的位置（0–127），用于「按白键/黑键排序」以及界面上的音名说明。 */
export function isBlackKey(midi) {
  const pitch = ((Math.round(Number(midi)) % 12) + 12) % 12;
  return [1, 3, 6, 8, 10].includes(pitch);
}

/** 拍数 → 最接近的界面时值（供「点一下就有声音」时默认用四分音符，或撤销后回读）。 */
export function nearestNoteValue(beats) {
  let best = NOTE_VALUES[4];
  let bestDistance = Infinity;
  for (const item of NOTE_VALUES) {
    const distance = Math.abs(item.beats - Number(beats));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}

/** 一小节已用掉多少拍。 */
export function usedBeats(measure) {
  if (!measure || !Array.isArray(measure.beats)) return 0;
  let total = 0;
  for (const note of measure.beats) total += Number(note.beats) || 0;
  return round(total);
}

/** 一小节还剩多少拍（负数表示超出）。 */
export function remainingBeats(measure, beatsPerMeasure = 4) {
  return round((Number(beatsPerMeasure) || 4) - usedBeats(measure));
}

/** 浮点比较用的取整：拍数最多保留 1e-6，避免 0.30000000000000004 这类脏数据。 */
export function round(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

/**
 * 从第 index 个音开始，逐个往后累加，算出每个音的起始拍。
 * 这是「不用排版也能知道第几个音在第几拍」的唯一依据（界面、播放、导出都共用）。
 */
export function buildMeasureSlots(measure, beatsPerMeasure = 4) {
  const slots = [];
  let cursor = 0;
  for (const note of (measure && measure.beats) || []) {
    const length = Number(note.beats) || 0;
    slots.push({ ...note, startBeats: round(cursor), endBeats: round(cursor + length) });
    cursor += length;
  }
  // 尾巴上用「剩余拍数」标出来，界面可以提示「还差 1 拍就满了」
  return { slots, used: round(cursor), remaining: round((Number(beatsPerMeasure) || 4) - cursor) };
}

/**
 * 给一个音：能放进去吗？
 * 规则（对零基础友好）：只有「整条或整半拍」才允许超出小节——超出的部分自动落到下一小节开头。
 * 返回 { ok, reason }。
 */
export function canAppend(measure, note, beatsPerMeasure = 4) {
  const remaining = remainingBeats(measure, beatsPerMeasure);
  if (remaining <= 0) return { ok: false, reason: "full" };
  if ((Number(note.beats) || 0) > remaining + 1e-9) return { ok: false, reason: "too-long" };
  return { ok: true, reason: "" };
}

/** 新建一条空乐谱（默认 4/4、♩=84、一个钢琴声部）。 */
export function createScore(options = {}) {
  const beatsPerMeasure = Number(options.beatsPerMeasure) || 4;
  return {
    title: options.title || "未命名乐谱",
    tempo: Number(options.tempo) || 84,
    beatsPerMeasure,
    beatType: Number(options.beatType) || 4,
    keyFifths: Number(options.keyFifths) || 0,
    parts: options.parts || [createPart({ name: "旋律" })],
    measuresPerLine: Number(options.measuresPerLine) || 2,
  };
}

/** 新建一个声部（默认高音谱号、钢琴音色、无八度偏移）。 */
export function createPart(options = {}) {
  return {
    id: options.id || `part-${Math.random().toString(36).slice(2, 8)}`,
    name: options.name || "新声部",
    timbre: options.timbre || "piano",
    clef: options.clef || "treble",
    octave: Number(options.octave) || 0,
    volume: Number.isFinite(Number(options.volume)) ? Number(options.volume) : 1,
    measures: options.measures || [emptyMeasure()],
  };
}

/** 一个空小节。 */
export function emptyMeasure() {
  return { beats: [] };
}

/** 保证声部至少有 count 个小节（界面要「往后加一行」时用）。 */
export function ensureMeasures(part, count) {
  while (part.measures.length < count) part.measures.push(emptyMeasure());
  return part;
}

/**
 * 把「点出来的音」放进声部：优先放进最后一小节，放不下就自动开新小节。
 * 返回 { measureIndex, note }，方便界面高亮刚加进去的音。
 */
export function appendNote(part, note, beatsPerMeasure = 4) {
  if (!part.measures.length) part.measures.push(emptyMeasure());
  let index = part.measures.length - 1;
  let measure = part.measures[index];
  if (!canAppend(measure, note, beatsPerMeasure).ok) {
    measure = emptyMeasure();
    part.measures.push(measure);
    index = part.measures.length - 1;
  }
  const created = {
    id: note.id || `note-${Math.random().toString(36).slice(2, 10)}`,
    midi: note.rest ? 0 : Math.round(Number(note.midi)),
    beats: round(Number(note.beats) || 1),
    ...(note.rest ? { rest: true } : {}),
    ...(note.lyric ? { lyric: note.lyric } : {}),
  };
  measure.beats.push(created);
  return { measureIndex: index, note: created };
}

/** 删除一个音（按 id）。 */
export function removeNote(part, noteId) {
  for (const measure of part.measures) {
    const index = measure.beats.findIndex((note) => note.id === noteId);
    if (index >= 0) {
      measure.beats.splice(index, 1);
      return true;
    }
  }
  return false;
}

/** 改一个音的时值（按 id）；超出本小节余量时不动并返回 false。 */
export function setNoteBeats(part, noteId, beats, beatsPerMeasure = 4) {
  for (const measure of part.measures) {
    const target = measure.beats.find((note) => note.id === noteId);
    if (!target) continue;
    const others = round(usedBeats(measure) - (Number(target.beats) || 0));
    if (round(others + Number(beats)) > (Number(beatsPerMeasure) || 4) + 1e-9) return false;
    target.beats = round(Number(beats));
    return true;
  }
  return false;
}

/** 移调一个音（半音）。 */
export function transposeNote(part, noteId, semitones) {
  for (const measure of part.measures) {
    const target = measure.beats.find((note) => note.id === noteId);
    if (!target) continue;
    target.midi = Math.max(0, Math.min(127, Math.round(target.midi + Number(semitones || 0))));
    return true;
  }
  return false;
}

/** 整理：把空小节删掉（末尾预留的空白小节不导出，播放也不会多等）。 */
export function trimTrailingEmptyMeasures(part) {
  while (part.measures.length > 1 && part.measures[part.measures.length - 1].beats.length === 0) {
    part.measures.pop();
  }
  return part;
}

/**
 * 把整份乐谱摊平成「播放事件」：{ midi, startBeat, durationBeats, partId, partName, timbre, volume }
 * 各声部按各自的开始拍对齐（同一个小节号对应同一段时间），这样多声部就能同时演奏。
 */
export function scoreToPlayableNotes(score) {
  const beatsPerMeasure = Number(score && score.beatsPerMeasure) || 4;
  const notes = [];
  for (const part of (score && score.parts) || []) {
    trimTrailingEmptyMeasures(part);
    part.measures.forEach((measure, measureIndex) => {
      const { slots } = buildMeasureSlots(measure, beatsPerMeasure);
      for (const slot of slots) {
        if (slot.rest) continue;   // 休止符占拍但不发声
        notes.push({
          midi: slot.midi,
          startBeat: round(measureIndex * beatsPerMeasure + slot.startBeats),
          durationBeats: slot.beats,
          partId: part.id,
          partName: part.name || part.id,
          timbre: part.timbre || "piano",
          volume: Number.isFinite(Number(part.volume)) ? Number(part.volume) : 1,
          octave: Number(part.octave) || 0,
          noteId: slot.id,
        });
      }
    });
  }
  notes.sort((left, right) => left.startBeat - right.startBeat || left.midi - right.midi);
  return notes;
}

/** 整份乐谱有多少拍（取最长的声部）。 */
export function scoreTotalBeats(score) {
  const beatsPerMeasure = Number(score && score.beatsPerMeasure) || 4;
  let longest = 0;
  for (const part of (score && score.parts) || []) {
    let measures = part.measures.length;
    while (measures > 1 && part.measures[measures - 1].beats.length === 0) measures -= 1;
    longest = Math.max(longest, measures * beatsPerMeasure);
  }
  return round(longest);
}

/**
 * 一个事件是不是休止符。
 * 为什么单独一个函数：界面、导出、播放三处都要判断，集中一处避免写法不一致。
 */
export function isRest(event) {
  return Boolean(event && event.rest);
}

/** 某小节里有几个「真的有音高」的音（用于空谱判断、导出提示）。 */
export function soundingNoteCount(part) {
  let count = 0;
  for (const measure of (part && part.measures) || []) {
    for (const event of measure.beats || []) if (!event.rest) count += 1;
  }
  return count;
}

/** 调号里已经包含哪些「音级带升降」，用于判断某个音要不要标临时记号。 */
const KEY_ALTERATIONS = {
  "-7": { b: 7 }, "-6": { b: 6 }, "-5": { b: 5 }, "-4": { b: 4 }, "-3": { b: 3 },
  "-2": { b: 2 }, "-1": { b: 1 }, 0: {}, 1: { "#": 1 }, 2: { "#": 2 }, 3: { "#": 3 },
  4: { "#": 4 }, 5: { "#": 5 }, 6: { "#": 6 }, 7: { "#": 7 },
};
// 调号里的升降号按五度圈顺序作用在固定音级上。零基础用户不需要知道这个，但谱面要正确。
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

/**
 * 这个音要不要标临时记号、标什么（"#" / "b" / "n" / null）。
 *
 * 关键：同一个钢琴键有两种写法（MIDI 58 既可写 Bb 也可写 A#）。判断时按调号的习惯拼写：
 *   · 降号调优先用降号拼写（F 大调里 58 = Bb，B 已经被调号降过 → 不标）；
 *   · 升号调优先用升号拼写（G 大调里 66 = F#，F 已被调号升过 → 不标）；
 *   · 都不匹配时再试另一种拼写，最后才给临时记号 / 还原号。
 */
export function accidentalFor(midi, fifths) {
  const value = Math.max(0, Math.min(127, Math.round(Number(midi) || 0)));
  const pitch = ((value % 12) + 12) % 12;

  // 两种拼写：字母 + 需要的升降（0 = 自然音，1 = 升，-1 = 降）
  const SPELLINGS = [
    ["C", 0, 0], ["C", 1, 1], ["D", 0, 2], ["D", 1, 3], ["E", 0, 4], ["F", 0, 5],
    ["F", 1, 6], ["G", 0, 7], ["G", 1, 8], ["A", 0, 9], ["A", 1, 10], ["B", 0, 11],
  ];
  const candidates = [];
  const sharpSpelling = SPELLINGS.find((entry) => entry[2] === pitch);
  const flatSpelling = SPELLINGS.find((entry) => entry[2] === (pitch + 1) % 12);
  if (sharpSpelling) candidates.push({ letter: sharpSpelling[0], alter: sharpSpelling[1] });
  if (flatSpelling) candidates.push({ letter: flatSpelling[0], alter: flatSpelling[1] - 1 });

  const keySpec = KEY_ALTERATIONS[String(Number(fifths) || 0)] || {};
  const keyAlterFor = (letter) => {
    if (keySpec["#"]) return SHARP_ORDER.indexOf(letter) < keySpec["#"] ? 1 : 0;
    if (keySpec["b"]) return FLAT_ORDER.indexOf(letter) < keySpec["b"] ? -1 : 0;
    return 0;
  };

  // 调号习惯：降号调用降号拼写、升号调用升号拼写
  const preferFlat = Boolean(keySpec["b"]);
  const ordered = preferFlat ? [...candidates].reverse() : candidates;

  for (const spelling of ordered) {
    const keyAlter = keyAlterFor(spelling.letter);
    if (spelling.alter === keyAlter) return null;              // 调号已经覆盖，不需要标
  }
  // 都不匹配：挑「离调号最近」的拼写；距离相同优先「用还原号」的写法
  // （F 大调里写还原 B 比写 Cb 更符合乐谱习惯，也不会让零基础用户困惑）
  let chosen = null;
  let bestCost = Infinity;
  for (const spelling of ordered) {
    const keyAlter = keyAlterFor(spelling.letter);
    const distance = Math.abs(spelling.alter - keyAlter);
    const naturalWithKeyAlter = spelling.alter === 0 && keyAlter !== 0 ? 0.5 : 0;
    const cost = distance - naturalWithKeyAlter;
    if (cost < bestCost) {
      bestCost = cost;
      chosen = { ...spelling, keyAlter };
    }
  }
  if (!chosen) return null;
  if (chosen.alter === 0 && chosen.keyAlter !== 0) return "n";   // 要还原
  if (chosen.alter === 1) return "#";
  if (chosen.alter === -1) return "b";
  return null;
}

/** 深拷贝（撤销/重做用；结构简单，JSON 足够）。 */
export function cloneScore(score) {
  return JSON.parse(JSON.stringify(score));
}
