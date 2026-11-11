// MIDI（.mid / Standard MIDI File）解析 → 生成 MusicXML（五线谱）。
//
// 为什么要自己解析、自己写 MusicXML：
//   · 「乐谱预览的五线谱」「旋律工作台里的音符/声部/播放」「导出的 MusicXML/PDF」必须出自同一份数据，
//     自己解析 → 自己生成 MusicXML，三者天然一致；
//   · MuseScore 等制谱软件只负责「把 MusicXML 排版成五线谱 PDF」这一步（见 serve.py /api/score/to-pdf）；
//     本机没装 MuseScore 时仍可导入 MIDI 试听/编辑/导出 MusicXML，只是少了五线谱预览；
//   · 纯函数、不碰 DOM，可单测：tests/midi.test.mjs
//
// 支持范围：
//   · 标准 MIDI 文件 format 0/1/2；division 为「每四分音符 tick 数」（SMPTE 时间码格式不支持）；
//   · 一条音轨 → 一个声部；通道 10（打击乐）的音符跳过并在结果里说明；
//   · 音符按 1/16 音符网格量化（把演奏时值/微小抖动吸附到谱面时值）；
//   · 同声部内时间重叠的音自动分到最多 4 条「声部线」（MusicXML voice），
//     同时开始、同时结束的音合并成和弦；跨小节的音自动拆段并加连音线。

const DEFAULT_TEMPO = 120;
// 输出 MusicXML 的 divisions：一个四分音符 = 480 个时间单位（常用制谱软件的默认值）。
const OUTPUT_DIVISIONS = 480;
// 量化网格：每拍的 1/4（= 16 分音符）。MIDI 里演奏时值会吸附到这个网格。
const QUANTIZE_STEPS_PER_BEAT = 4;
// 拆成「可单个音符写出」的时值（拍）：超过这个长度的音拆成多个连音线音符。
const NOTE_BEATS = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25, 0.125];
const TYPE_BY_BEATS = new Map([
  [4, { type: "whole", dots: 0 }],
  [3, { type: "half", dots: 1 }],
  [2, { type: "half", dots: 0 }],
  [1.5, { type: "quarter", dots: 1 }],
  [1, { type: "quarter", dots: 0 }],
  [0.75, { type: "eighth", dots: 1 }],
  [0.5, { type: "eighth", dots: 0 }],
  [0.25, { type: "16th", dots: 0 }],
  [0.125, { type: "32nd", dots: 0 }],
]);
const STEP_BY_PITCH = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const ALTER_BY_PITCH = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
// 调号估计用的「调性音级分布」（Krumhansl-Kessler 经典曲线）：
// 直接把音高按升号写法全写成变化音，五线谱上会满屏临时记号；先估一个调号再按调内音拼写，
// 谱面才像正常乐谱（《人是猫》这类流行歌，估成 Eb 大调后临时记号能少一大半）。
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// 音名与「自然音」音级（C=0）
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// 升降号顺序：升号 F C G D A E B；降号反过来 B E A D G C F。
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];
// 调号 fifths → 该调主音的音级（大调）；小调用关系大调（主音 + 3）算。
const FIFTHS_BY_TONIC = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
const TONIC_BY_FIFTHS = Object.fromEntries(Object.entries(FIFTHS_BY_TONIC).map(([tonic, fifths]) => [fifths, Number(tonic)]));
// 每小节最多分几条「声部线」：多层 MIDI 轨（如钢琴左右手叠在一起）也能正确排版。
const MAX_VOICES = 4;

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error("MIDI 数据格式不正确。");
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readVlq(bytes, offset) {
  let value = 0;
  let cursor = offset;
  for (let index = 0; index < 4; index += 1) {
    const byte = bytes[cursor];
    cursor += 1;
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return { value, next: cursor };
  }
  throw new Error("MIDI 数据损坏：变长数值超过 4 字节。");
}

function decodeName(payload) {
  // MIDI 轨道名常见 UTF-8；少数老软件用 GBK。UTF-8 解不出时才退回 latin1（至少不报错）。
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload).trim();
    if (text) return text;
  } catch { /* 不是 UTF-8，下面兜底 */ }
  return new TextDecoder("latin1").decode(payload).trim();
}

/**
 * 解析标准 MIDI 文件。
 * @returns {{format:number, division:number, tracks:Array, tempos:Array, timeSignatures:Array, totalTicks:number}}
 */
export function parseMidiFile(input) {
  const bytes = toBytes(input);
  if (bytes.length < 14 || String.fromCharCode(...bytes.slice(0, 4)) !== "MThd") {
    throw new Error("这不是标准 MIDI 文件（缺少 MThd 文件头）。");
  }
  const headerLength = readUint32(bytes, 4);
  const format = readUint16(bytes, 8);
  const declaredTracks = readUint16(bytes, 10);
  const division = readUint16(bytes, 12);
  if (division & 0x8000) throw new Error("暂不支持 SMPTE 时间码格式的 MIDI，请另存为普通 .mid 后再导入。");
  if (!(division > 0)) throw new Error("MIDI 文件头里的时间分辨率无效。");
  let cursor = 8 + headerLength;
  const tracks = [];
  const tempos = [];
  const timeSignatures = [];
  let totalTicks = 0;
  while (cursor + 8 <= bytes.length && tracks.length < Math.max(1, declaredTracks)) {
    const chunkId = String.fromCharCode(...bytes.slice(cursor, cursor + 4));
    const chunkLength = readUint32(bytes, cursor + 4);
    const start = cursor + 8;
    const end = Math.min(bytes.length, start + chunkLength);
    if (chunkId !== "MTrk") {
      cursor = start + chunkLength; // 未知 chunk：跳过
      continue;
    }
    const track = parseTrack(bytes, start, end, tracks.length);
    tracks.push(track);
    tempos.push(...track.tempos);
    timeSignatures.push(...track.timeSignatures);
    totalTicks = Math.max(totalTicks, track.endTick);
    cursor = end;
  }
  if (!tracks.length) throw new Error("MIDI 文件里没有任何音轨。");
  if (!tempos.length) tempos.push({ tick: 0, bpm: DEFAULT_TEMPO });
  if (!timeSignatures.length) timeSignatures.push({ tick: 0, beats: 4, beatType: 4 });
  const dedupe = (list) => {
    const seen = new Map();
    for (const item of list) seen.set(item.tick, item);
    return [...seen.values()].sort((left, right) => left.tick - right.tick);
  };
  return {
    format,
    division,
    tracks,
    tempos: dedupe(tempos),
    timeSignatures: dedupe(timeSignatures),
    totalTicks,
  };
}

function parseTrack(bytes, start, end, trackIndex) {
  let cursor = start;
  let tick = 0;
  let runningStatus = 0;
  let name = "";
  const notes = [];
  const tempos = [];
  const timeSignatures = [];
  const programs = new Set();
  const channels = new Set();
  // 同音重复（pitch 相同、未收到 note-off）时用栈保存起始 tick，保证配对正确。
  const openNotes = new Map();
  const closeNote = (channel, midi) => {
    const key = `${channel}:${midi}`;
    const stack = openNotes.get(key);
    if (!stack || !stack.length) return;
    const startTick = stack.shift();
    if (!stack.length) openNotes.delete(key);
    notes.push({ midi, startTick, endTick: tick, channel, trackIndex });
  };
  while (cursor < end) {
    let delta;
    try {
      const read = readVlq(bytes, cursor);
      delta = read.value;
      cursor = read.next;
    } catch {
      break; // 尾部垃圾字节：保留已读内容
    }
    tick += delta;
    if (cursor >= end) break;
    let status = bytes[cursor];
    if (status & 0x80) {
      cursor += 1;
      runningStatus = status;
    } else {
      status = runningStatus;
      if (!status) throw new Error("MIDI 数据损坏：缺少运行状态字节。");
    }
    if (status === 0xff) {
      if (cursor >= end) break;
      const type = bytes[cursor];
      cursor += 1;
      const lengthRead = readVlq(bytes, cursor);
      const length = lengthRead.value;
      cursor = lengthRead.next;
      const payload = bytes.slice(cursor, cursor + length);
      cursor += length;
      if (type === 0x03) name = decodeName(payload);
      else if (type === 0x51 && length === 3) {
        const micros = (payload[0] << 16) | (payload[1] << 8) | payload[2];
        if (micros > 0) tempos.push({ tick, bpm: Math.round((60000000 / micros) * 100) / 100 });
      } else if (type === 0x58 && length >= 2) {
        const beats = payload[0];
        const beatType = 2 ** payload[1];
        if (beats > 0 && beatType > 0) timeSignatures.push({ tick, beats, beatType });
      }
      if (type === 0x2f) break; // End of Track
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const lengthRead = readVlq(bytes, cursor);
      cursor = lengthRead.next + lengthRead.value;
      continue;
    }
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    if (kind === 0x80 || kind === 0x90) {
      const midi = bytes[cursor];
      const velocity = bytes[cursor + 1];
      cursor += 2;
      channels.add(channel);
      if (kind === 0x90 && velocity > 0) {
        const key = `${channel}:${midi}`;
        if (!openNotes.has(key)) openNotes.set(key, []);
        openNotes.get(key).push(tick);
      } else {
        closeNote(channel, midi);
      }
    } else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) {
      cursor += 2; // 触后/控制器/弯音：谱面不表示，跳过
    } else if (kind === 0xc0) {
      programs.add(bytes[cursor]);
      channels.add(channel);
      cursor += 1;
    } else if (kind === 0xd0) {
      cursor += 1;
    } else {
      throw new Error("MIDI 数据损坏：无法识别的事件 0x" + status.toString(16));
    }
  }
  // 没收到 note-off 的悬空音符：收在音轨末尾（不整段丢弃）
  for (const [key, stack] of openNotes) {
    const [channel, midi] = key.split(":").map(Number);
    for (const startTick of stack) {
      notes.push({ midi, startTick, endTick: Math.max(tick, startTick + 1), channel, trackIndex });
    }
  }
  notes.sort((left, right) => left.startTick - right.startTick || left.midi - right.midi);
  return {
    index: trackIndex,
    name,
    notes,
    tempos: tempos.sort((left, right) => left.tick - right.tick),
    timeSignatures: timeSignatures.sort((left, right) => left.tick - right.tick),
    programs: [...programs].sort((left, right) => left - right),
    channels: [...channels].sort((left, right) => left - right),
    endTick: tick,
  };
}

function escapeXml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** MIDI 音高 → MusicXML 的 step/alter/octave（统一升号写法，alter 表示升降）。 */
export function midiToPitchParts(midi) {
  const value = Math.max(0, Math.min(127, Math.round(Number(midi) || 0)));
  const pitch = ((value % 12) + 12) % 12;
  return { step: STEP_BY_PITCH[pitch], alter: ALTER_BY_PITCH[pitch], octave: Math.floor(value / 12) - 1 };
}

/** 升降号顺序：某调号下，哪些音名带升/降号。 */
function keyAlterForLetter(letter, fifths) {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(letter) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(letter) ? -1 : 0;
  return 0;
}

/**
 * 估计调号：用时值加权统计 12 个音级，与 24 个大小调的调性分布做相关，取最高分。
 * 目的不是「100% 正确」，而是让谱面少满屏临时记号（识别错了用户可在制谱软件里改调号）。
 */
export function detectKey(notes) {
  const weights = new Array(12).fill(0);
  for (const note of notes) {
    const weight = Math.max(1, Number(note.endTick) - Number(note.startTick));
    weights[((Math.round(note.midi) % 12) + 12) % 12] += weight;
  }
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let best = { fifths: 0, mode: "major", tonic: 0, score: -Infinity };
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ["major", "minor"]) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      let score = 0;
      for (let degree = 0; degree < 12; degree += 1) score += weights[(tonic + degree) % 12] * profile[degree];
      score /= total;
      const relativeTonic = mode === "major" ? tonic : (tonic + 3) % 12;
      const fifths = FIFTHS_BY_TONIC[relativeTonic];
      if (score > best.score + 1e-9) best = { fifths, mode, tonic, score };
    }
  }
  return best;
}

/** 某个调号下的主音名（用于显示，如 "Eb"、"C minor"）。 */
export function keyDisplayName(key) {
  if (!key) return "";
  const majorTonic = TONIC_BY_FIFTHS[key.fifths] ?? 0;
  const names = key.fifths <= 0
    ? ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
    : ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const tonic = key.mode === "minor" ? (majorTonic + 9) % 12 : majorTonic;
  return `${names[tonic]}${key.mode === "minor" ? " minor" : ""}`;
}

/** 按调号选「临时记号最少」的音名写法（降号调优先降号音名，升号调优先升号音名）。 */
function pitchPartsForKeyedMidi(midi, key) {
  const value = Math.max(0, Math.min(127, Math.round(Number(midi) || 0)));
  const pc = ((value % 12) + 12) % 12;
  const fifths = key ? Number(key.fifths) || 0 : 0;
  const preferFlats = fifths < 0;
  let best = null;
  for (const letter of LETTERS) {
    const natural = LETTER_PC[letter];
    let alter = pc - natural;
    while (alter > 6) alter -= 12;
    while (alter < -6) alter += 12;
    if (alter < -2 || alter > 2) continue;
    const keyAlter = keyAlterForLetter(letter, fifths);
    let cost;
    if (alter === keyAlter) cost = 0;
    else if (alter === 0) cost = 2;
    else cost = 3 + Math.abs(alter - keyAlter);
    // 同分时按调号方向偏好（降号调偏 b、升号调偏 #）
    const preference = preferFlats ? (alter <= 0 ? 0 : 0.5) : (alter >= 0 ? 0 : 0.5);
    const totalCost = cost + preference;
    const octave = Math.floor((value - natural - alter) / 12) - 1;
    if (!best || totalCost < best.cost) best = { step: letter, alter, octave, cost: totalCost };
  }
  if (!best) return midiToPitchParts(value);
  return { step: best.step, alter: best.alter, octave: best.octave };
}

/** 把时长拆成若干「可用单个音符写出」的时值（例：3.5 拍 → 3 + 0.5，中间用连音线连起来）。 */
function splitBeats(total, maxPiece = 4) {
  const parts = [];
  let remaining = Math.max(0.125, Math.round(total * 8) / 8);
  while (remaining > 1e-9 && parts.length < 64) {
    const take = Math.min(maxPiece, NOTE_BEATS.find((candidate) => remaining >= candidate - 1e-9) ?? 0.125);
    parts.push(Math.round(take * 1000) / 1000);
    remaining = Math.round((remaining - take) * 1000) / 1000;
  }
  if (!parts.length) parts.push(0.125);
  return parts;
}

function noteTypeInfo(beats) {
  return TYPE_BY_BEATS.get(Math.round(beats * 1000) / 1000) || { type: "quarter", dots: 0 };
}

function noteXml({ midi = 0, beats = 1, voice = 1, rest = false, chord = false, tieStart = false, tieStop = false, key = null }) {
  const info = noteTypeInfo(beats);
  const duration = Math.max(1, Math.round(beats * OUTPUT_DIVISIONS));
  const lines = ["      <note>"];
  if (chord) lines.push("        <chord/>");
  if (rest) lines.push("        <rest/>");
  else {
    const { step, alter, octave } = pitchPartsForKeyedMidi(midi, key);
    lines.push(`        <pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>`);
  }
  lines.push(`        <duration>${duration}</duration>`);
  lines.push(`        <voice>${voice}</voice>`);
  lines.push(`        <type>${info.type}</type>`);
  for (let dot = 0; dot < (info.dots || 0); dot += 1) lines.push("        <dot/>");
  if (tieStop) lines.push('        <tie type="stop"/>');
  if (tieStart) lines.push('        <tie type="start"/>');
  if (tieStart || tieStop) {
    lines.push("        <notations>");
    if (tieStop) lines.push('          <tied type="stop"/>');
    if (tieStart) lines.push('          <tied type="start"/>');
    lines.push("        </notations>");
  }
  lines.push("      </note>");
  return lines.join("\n");
}

/** 休止符：把 gap 拍依次铺满（整小节休止用完整时值）。 */
function restXml(beats, voice, key) {
  return splitBeats(beats).map((part) => noteXml({ beats: part, voice, rest: true, key })).join("\n");
}

function directionXml(bpm) {
  const rounded = Math.round(bpm * 100) / 100;
  return [
    '      <direction placement="above">',
    "        <direction-type>",
    `          <metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(bpm)}</per-minute></metronome>`,
    "        </direction-type>",
    `        <sound tempo="${rounded}"/>`,
    "      </direction>",
  ].join("\n");
}

function attributesXml({ beats, beatType, clef, includeDivisions, key }) {
  const lines = ["      <attributes>"];
  if (includeDivisions) lines.push(`        <divisions>${OUTPUT_DIVISIONS}</divisions>`);
  if (key) {
    lines.push(`        <key><fifths>${key.fifths}</fifths>${key.mode === "minor" ? "<mode>minor</mode>" : ""}</key>`);
  }
  lines.push(`        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`);
  if (clef) lines.push(`        <clef><sign>${clef.sign}</sign><line>${clef.line}</line></clef>`);
  lines.push("      </attributes>");
  return lines.join("\n");
}

function valueAt(list, tick, fallback) {
  let current = fallback;
  for (const item of list) {
    if (item.tick > tick + 1e-6) break;
    current = item;
  }
  return current;
}

function uniquePartNames(names) {
  const seen = new Map();
  return names.map((name, index) => {
    const base = (name || "").trim() || `轨道 ${index + 1}`;
    const used = (seen.get(base) || 0) + 1;
    seen.set(base, used);
    return used > 1 ? `${base} ${used}` : base;
  });
}

/** 按「拍号段 + 小节长度」铺出整曲小节表；变拍号落在小节边界（标准 MIDI 都是这样）。 */
function buildMeasures(timeSignatures, division, totalTicks) {
  const measures = [];
  let tick = 0;
  let meterIndex = 0;
  const safeTotal = Math.max(totalTicks, division);
  while (tick < safeTotal && measures.length < 20000) {
    while (meterIndex + 1 < timeSignatures.length && timeSignatures[meterIndex + 1].tick <= tick) meterIndex += 1;
    const meter = timeSignatures[meterIndex];
    const quarterBeats = (meter.beats * 4) / meter.beatType;
    const lengthTicks = Math.max(1, Math.round(quarterBeats * division));
    const nextMeter = timeSignatures[meterIndex + 1];
    const truncated = nextMeter && nextMeter.tick > tick && nextMeter.tick < tick + lengthTicks;
    const measureLength = truncated ? nextMeter.tick - tick : lengthTicks;
    measures.push({
      startTick: tick,
      lengthTicks: measureLength,
      beats: meter.beats,
      beatType: meter.beatType,
      quarterBeats,
    });
    tick += measureLength;
  }
  if (!measures.length) {
    measures.push({ startTick: 0, lengthTicks: division * 4, beats: 4, beatType: 4, quarterBeats: 4 });
  }
  return measures;
}

function clefForNotes(notes) {
  const midis = notes.map((note) => note.midi).sort((left, right) => left - right);
  const median = midis[Math.floor(midis.length / 2)] ?? 60;
  return median < 59 ? { sign: "F", line: 4 } : { sign: "G", line: 2 };
}

// —— 轨道关系分析：把「同一条旋律的重复 / 八度叠加 / 和声垫 / 分段补轨」找出来 ——
//
// 为什么需要：真实 MIDI 经常把同一条旋律录成多条轨——双轨加宽（L/R）、八度叠唱、
// 三度和声垫、分段补录、零散效果轨。如果按「一条轨 = 一个声部」转谱，
// 用户会看到「10 个声部」这种明显不合理的五线谱（《人是猫.mid》就是这种情况）。
// 所以转谱前先分析轨道之间的关系，再决定怎么归并：
//   · 同度重复（固定移调 0）        → 并进主旋律，按音高 + 起拍去重
//   · 八度 / 三度平行叠加            → 归到「和声层」一个声部（保留全部音，和弦化）
//   · 和主旋律几乎不同时段的「分段轨」→ 并进主旋律（补全主旋律没唱的段落）
//   · 只有零星几个音的「碎片轨」      → 并进主旋律
//   · 真正独立的内容（独立乐器/声部）  → 各自保留为单独声部
const RELATION_SHIFT_LIMIT = 24;          // 只考虑 ±24 半音（两个八度）内的固定移调关系
const RELATION_TIME_TOLERANCE_BEATS = 0.125;  // 「同时开始」的容差（拍）
const RELATION_MIN_RATIO = 0.45;          // 一条轨至少 45% 的音能被另一条轨解释，才算有关系
const UNISON_MIN_RATIO = 0.5;             // 同度重复的判定
const RHYTHM_SAME_GROUP = 0.75;           // 起拍 Jaccard 达到这个值，视为同一节奏（块状和声垫）
const SECTION_OVERLAP_MAX = 0.3;          // 与主旋律活动时段重叠低于这个比例 → 视为分段补轨
const TINY_TRACK_NOTES = 12;              // 少于这么多音 → 视为零散/效果轨
const MAX_ANALYZED_TRACKS = 16;           // 轨道再多就不做自动归并（避免很长的两两分析）

/**
 * 一条轨的音有多少能被另一条轨「同时开始 + 固定移调」解释。
 * @returns {{shift:number, ratio:number, matches:number}} shift 为 b 相对 a 的移调
 */
export function trackRelation(aNotes, bNotes, tolerance = 60) {
  if (!aNotes.length || !bNotes.length) return { shift: 0, ratio: 0, matches: 0 };
  const buckets = new Map();
  for (const note of bNotes) {
    const key = Math.round(note.startTick / 20);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(note);
  }
  const counts = new Map();
  for (const note of aNotes) {
    const center = Math.round(note.startTick / 20);
    for (let offset = -4; offset <= 4; offset += 1) {
      const list = buckets.get(center + offset);
      if (!list) continue;
      for (const other of list) {
        if (Math.abs(other.startTick - note.startTick) > tolerance) continue;
        const shift = other.midi - note.midi;
        if (shift < -RELATION_SHIFT_LIMIT || shift > RELATION_SHIFT_LIMIT) continue;
        counts.set(shift, (counts.get(shift) || 0) + 1);
      }
    }
  }
  let bestShift = 0, bestCount = 0;
  for (const [shift, count] of counts) {
    if (count > bestCount) { bestCount = count; bestShift = shift; }
  }
  return { shift: bestShift, ratio: bestCount / aNotes.length, matches: bestCount };
}

/** 起拍集合（按网格取整）：用来判断两条轨是不是同一节奏型（块状和声/齐奏）。 */
function onsetSet(notes, grid) {
  const set = new Set();
  for (const note of notes) set.add(Math.round(note.startTick / grid));
  return set;
}

function setJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const value of a) if (b.has(value)) common += 1;
  return common / (a.size + b.size - common);
}

/** 一条轨「有音的小节窗口」：和主旋律的窗口重叠比例低 → 它是分段补轨，不是独立声部。 */
function activeWindows(notes, division) {
  const set = new Set();
  const window = Math.max(1, division * 4);
  for (const note of notes) set.add(Math.floor(note.startTick / window));
  return set;
}

function windowOverlapRatio(notes, referenceNotes, division) {
  const own = activeWindows(notes, division);
  if (!own.size) return 0;
  const reference = activeWindows(referenceNotes, division);
  let common = 0;
  for (const value of own) if (reference.has(value)) common += 1;
  return common / own.size;
}

/**
 * 分析 MIDI 轨道 → 建议的「声部」分组。
 *
 * @param {Array<{index:number, name:string, notes:Array}>} sourceTracks
 * @param {number} division MIDI 时间分辨率
 * @returns {{appliedMode:"auto"|"tracks", groups:Array, stats:object}}
 */
export function analyzeMidiTracks(sourceTracks, division) {
  const tracks = sourceTracks.filter((item) => item.notes.length);
  const allTracks = () => tracks.map((item) => ({
    name: item.name, role: "part", sourceIndexes: [item.index], notes: item.notes.slice(),
  }));
  const fallback = (reason) => ({
    appliedMode: "tracks",
    groups: allTracks(),
    voiceGroups: allTracks(),
    stats: { analyzedTracks: tracks.length, reason },
  });
  if (tracks.length <= 1 || tracks.length > MAX_ANALYZED_TRACKS) return fallback("too-many-or-too-few-tracks");
  // 只有几个音的「碎片轨」不参与主旋律/和声判定（一个音就凑出一个声部没有意义）：
  // 它们最后会并进主旋律，或者在没有任何可归并内容时原样保留。
  const substantial = [];
  const fragments = [];
  tracks.forEach((item, index) => {
    (item.notes.length >= TINY_TRACK_NOTES ? substantial : fragments).push(index);
  });
  if (substantial.length < 2) return fallback("too-few-substantial-tracks");
  const tolerance = Math.max(6, Math.round(division * RELATION_TIME_TOLERANCE_BEATS));
  const relation = new Map();   // "i:j" → {shift, ratio}（i 的音能被 j 解释多少）
  for (const i of substantial) {
    for (const j of substantial) {
      if (i === j) continue;
      relation.set(`${i}:${j}`, trackRelation(tracks[i].notes, tracks[j].notes, tolerance));
    }
  }
  // 1) 找「主旋律」：被最多轨道解释的那条；同度关系加权，平手时取音多的。
  let leadIndex = substantial[0], leadScore = -1;
  for (const i of substantial) {
    let score = 0;
    for (const j of substantial) {
      if (i === j) continue;
      const rel = relation.get(`${j}:${i}`);
      if (rel.ratio < RELATION_MIN_RATIO) continue;
      score += rel.ratio * (rel.shift === 0 ? 2 : 1);
    }
    if (score > leadScore + 1e-9
      || (Math.abs(score - leadScore) <= 1e-9 && tracks[i].notes.length > tracks[leadIndex].notes.length)) {
      leadScore = score;
      leadIndex = i;
    }
  }
  if (leadScore < 0.8) return fallback("no-relations");
  const rhythmGrid = Math.max(1, Math.round(division / QUANTIZE_STEPS_PER_BEAT));
  const onsets = new Map();
  for (const i of substantial) onsets.set(i, onsetSet(tracks[i].notes, rhythmGrid));
  const used = new Set([leadIndex]);
  const unisonIndexes = [];
  // 2) 同度重复（L/R 双轨加宽、同一条旋律录了两三遍）→ 并进主旋律，按音高+起拍去重
  for (const i of substantial) {
    if (used.has(i)) continue;
    const rel = relation.get(`${i}:${leadIndex}`);
    if (rel.shift === 0 && rel.ratio >= UNISON_MIN_RATIO) {
      unisonIndexes.push(i);
      used.add(i);
    }
  }
  const melodyIndexes = [leadIndex, ...unisonIndexes];
  // 3) 与主旋律有固定移调关系（八度/三度…）、节奏也接近的轨 → 「和声/叠加层」种子，再按同节奏扩张
  const stack = new Set();
  for (const i of substantial) {
    if (used.has(i)) continue;
    const rel = relation.get(`${i}:${leadIndex}`);
    if (rel.shift !== 0 && rel.ratio >= RELATION_MIN_RATIO
      && setJaccard(onsets.get(i), onsets.get(leadIndex)) >= 0.3) {
      stack.add(i);
    }
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const i of substantial) {
      if (used.has(i) || stack.has(i)) continue;
      for (const member of stack) {
        if (setJaccard(onsets.get(i), onsets.get(member)) >= RHYTHM_SAME_GROUP) {
          stack.add(i);
          expanded = true;
          break;
        }
      }
    }
  }
  const harmonyIndexes = [...stack].sort((a, b) => a - b);
  for (const index of harmonyIndexes) used.add(index);
  // 4) 剩下的实义轨：和主旋律几乎不同时段的分段补轨并进主旋律，其余各自保留为独立声部
  const sectionIndexes = [];
  const ownParts = [];
  for (const i of substantial) {
    if (used.has(i)) continue;
    if (windowOverlapRatio(tracks[i].notes, tracks[leadIndex].notes, division) < SECTION_OVERLAP_MAX) {
      sectionIndexes.push(i);
      used.add(i);
    } else {
      ownParts.push(i);
    }
  }
  // 只有「没有真的合并出更少声部」时才退回传统行为
  const autoPartCount = 1 + (harmonyIndexes.length ? 1 : 0) + ownParts.length;
  if (autoPartCount >= tracks.length) return fallback("nothing-to-merge");
  const mergeNotes = (indexes, dedupe) => {
    const pooled = [];
    for (const index of indexes) for (const note of tracks[index].notes) pooled.push({ ...note });
    return dedupe ? mergeDuplicateNotes(pooled, tolerance) : pooled;
  };
  // —— 合并版（自动整理）：主旋律 + 和声/叠加层 + 独立声部 ——
  const melodyAll = [...melodyIndexes, ...sectionIndexes, ...fragments];
  const groups = [];
  groups.push({
    name: ownParts.length || harmonyIndexes.length ? "主旋律" : tracks[leadIndex].name,
    role: "melody",
    sourceIndexes: melodyAll.map((index) => tracks[index].index),
    notes: mergeNotes(melodyAll, true),
  });
  if (harmonyIndexes.length) {
    groups.push({
      name: "和声 / 叠加层",
      role: "harmony",
      sourceIndexes: harmonyIndexes.map((index) => tracks[index].index),
      notes: mergeNotes(harmonyIndexes, false),
    });
  }
  const singleNames = uniquePartNames(ownParts.map((index) => tracks[index].name));
  ownParts.forEach((index, order) => {
    groups.push({
      name: singleNames[order],
      role: "part",
      sourceIndexes: [tracks[index].index],
      notes: tracks[index].notes.slice(),
    });
  });
  // —— 分声部版（阿卡贝拉分谱）：重复轨合并，但八度叠唱/和声层/分段补轨各自成声部 ——
  const voiceGroups = [];
  voiceGroups.push({
    name: "主旋律",
    role: "melody",
    sourceIndexes: [...melodyIndexes, ...fragments].map((index) => tracks[index].index),
    notes: mergeNotes([...melodyIndexes, ...fragments], true),
  });
  // 和声/叠唱：同一个固定音程的多条轨，如果彼此是同度重复就合并；否则各自一条谱表
  const harmonyParts = [];
  for (const index of harmonyIndexes) {
    const rel = relation.get(`${index}:${leadIndex}`);
    const shift = rel.shift;   // lead - track：>0 表示这条轨比主旋律低
    let target = null;
    for (const part of harmonyParts) {
      if (part.shift !== shift) continue;
      const pair = relation.get(`${index}:${part.indexes[0]}`);
      if (pair && pair.shift === 0 && pair.ratio >= UNISON_MIN_RATIO) { target = part; break; }
    }
    if (target) { target.indexes.push(index); continue; }
    const abs = Math.abs(shift);
    const direction = shift > 0 ? "低" : "高";
    const isOctave = abs % 12 === 0;
    harmonyParts.push({
      shift,
      role: isOctave ? "octave" : "harmony",
      name: isOctave
        ? (abs === 12 ? `${direction}八度叠唱` : `${direction} ${abs / 12} 个八度叠唱`)
        : `和声（${direction} ${abs} 半音）`,
      indexes: [index],
    });
  }
  // 同一名字（同音程多轨但彼此不是重复）时加序号
  const harmonyNames = uniquePartNames(harmonyParts.map((part) => part.name));
  harmonyParts.forEach((part, order) => { part.name = harmonyNames[order]; });
  // 先八度叠唱（低→高），再和声层（音程从小到大）
  harmonyParts.sort((left, right) => {
    const leftOctave = left.role === "octave" ? 0 : 1;
    const rightOctave = right.role === "octave" ? 0 : 1;
    if (leftOctave !== rightOctave) return leftOctave - rightOctave;
    if (left.role === "octave") return right.shift - left.shift;
    return Math.abs(left.shift) - Math.abs(right.shift);
  });
  for (const part of harmonyParts) {
    voiceGroups.push({
      name: part.name,
      role: part.role,
      sourceIndexes: part.indexes.map((index) => tracks[index].index),
      notes: mergeNotes(part.indexes, true),
    });
  }
  // 分段补轨：主旋律没唱的段落，单独成声部并标出拍段，方便编曲时决定给谁唱
  for (const index of sectionIndexes) {
    const notes = tracks[index].notes;
    const firstBeat = Math.floor(Math.min(...notes.map((note) => note.startTick)) / division) + 1;
    const lastBeat = Math.ceil(Math.max(...notes.map((note) => note.endTick)) / division);
    voiceGroups.push({
      name: `分段补轨（第 ${firstBeat}–${lastBeat} 拍）`,
      role: "section",
      sourceIndexes: [tracks[index].index],
      notes: notes.slice(),
    });
  }
  ownParts.forEach((index, order) => {
    voiceGroups.push({
      name: singleNames[order],
      role: "part",
      sourceIndexes: [tracks[index].index],
      notes: tracks[index].notes.slice(),
    });
  });
  return {
    appliedMode: "auto",
    groups,
    voiceGroups,
    stats: {
      analyzedTracks: tracks.length,
      leadTrack: tracks[leadIndex].index,
      leadName: tracks[leadIndex].name,
      melodyTracks: melodyIndexes.length,
      unisonTracks: unisonIndexes.length,
      harmonyTracks: harmonyIndexes.length,
      sectionTracks: sectionIndexes.length,
      separateTracks: ownParts.length,
      fragmentTracks: fragments.length,
      autoParts: groups.length,
      voiceParts: voiceGroups.length,
    },
  };
}

// —— 阿卡贝拉编配识别（2026-11-11）——
// 像《喵卡贝拉》这类「人声分轨」MIDI：一条轨道不是「一个声部」，而是编曲里的一条人声线，
// 里面会同时存在主唱 1/2（交替唱）、低音、2–3 条和声声部、结尾叠层、加花小轨。
// 这里按「音符数 / 活动范围 / 时值长短 / 在第几段出现」启发式识别角色，然后给三种谱：
//   · core：核心版（主唱 + 低音 + 和声）——排练主谱
//   · full：完整版（核心 + 结尾/间奏出现的叠层声部）——正式演出谱
//   · reference：全部轨道（再含加花小轨）——核对原编曲用
// 识别不可靠时返回 available:false，上层退回「一条轨道一个声部」并如实说明。
const ACAPPELLA_WINDOW_BEATS = 8;            // 「活动窗口」宽度：8 拍 = 约 2 小节
const ACAPPELLA_LATE_BEAT_RATIO = 0.85;      // 最后 15% 算「结尾段」
const ACAPPELLA_PAD_LATE_RATIO = 0.6;        // 六成以上的音出现在结尾段 → 结尾叠层
const ACAPPELLA_MIN_NOTES = 4;               // 少于 4 个音不参与角色判定
const ACAPPELLA_LEAD_MIN_NOTES = 20;
const ACAPPELLA_LEAD_MIN_COVERAGE = 0.25;
const ACAPPELLA_LEAD_MAX_MEDIAN_BEATS = 0.45; // 主唱常有 16 分/8 分混排，中位时值短（要和一拍长音的和声区分开）
const ACAPPELLA_BASS_MIN_NOTES = 20;
const ACAPPELLA_BASS_MIN_COVERAGE = 0.5;
const ACAPPELLA_HARMONY_MIN_NOTES = 12;
const ACAPPELLA_HARMONY_MIN_COVERAGE = 0.3;
const ACAPPELLA_HARMONY_MIN_MEDIAN_BEATS = 0.42;  // 和声多为一拍/半拍的长音或均匀节奏（实测 0.5，主唱约 0.33–0.36）

function acappellaGroup(name, role, features) {
  const sourceIndexes = features.map((feature) => feature.track.index);
  const notes = [];
  for (const feature of features) for (const note of feature.track.notes) notes.push({ ...note });
  return { name, role, sourceIndexes, notes };
}

/**
 * 识别阿卡贝拉编配的角色，并生成三种分谱版本。
 * @returns {{available:boolean, reason:string, core:Array, full:Array, reference:Array, roles:Array, stats:object}}
 */
export function analyzeAcappellaTracks(sourceTracks, division) {
  const tracks = sourceTracks.filter((item) => item.notes.length);
  const empty = (reason, stats) => ({
    available: false, reason, core: [], full: [], reference: [], roles: [], stats: stats || {},
  });
  if (tracks.length < 5) return empty("too-few-tracks", { tracks: tracks.length });
  let totalBeats = 1;
  for (const track of tracks) {
    for (const note of track.notes) totalBeats = Math.max(totalBeats, note.endTick / division);
  }
  const windowCount = Math.max(1, Math.ceil(totalBeats / ACAPPELLA_WINDOW_BEATS));
  const lateBeat = totalBeats * ACAPPELLA_LATE_BEAT_RATIO;
  const features = tracks.map((track) => {
    const notes = track.notes;
    const pitches = notes.map((note) => note.midi).sort((left, right) => left - right);
    const durations = notes.map((note) => (note.endTick - note.startTick) / division).sort((left, right) => left - right);
    const windows = new Set();
    let lateNotes = 0;
    for (const note of notes) {
      windows.add(Math.floor(note.startTick / division / ACAPPELLA_WINDOW_BEATS));
      if (note.startTick / division >= lateBeat) lateNotes += 1;
    }
    return {
      track,
      noteCount: notes.length,
      meanPitch: pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length,
      medianDuration: durations[Math.floor(durations.length / 2)] || 0,
      coverage: windows.size / windowCount,
      lateRatio: lateNotes / notes.length,
      firstBeat: Math.min(...notes.map((note) => note.startTick)) / division,
    };
  });
  const substantial = features.filter((feature) => feature.noteCount >= ACAPPELLA_MIN_NOTES);
  // 1) 低音：常驻且音高最低（要明显低于全体平均，避免把普通内声部当低音）
  const bassCandidates = features
    .filter((feature) => feature.noteCount >= ACAPPELLA_BASS_MIN_NOTES && feature.coverage >= ACAPPELLA_BASS_MIN_COVERAGE)
    .sort((left, right) => left.meanPitch - right.meanPitch);
  const overallMean = features.reduce((sum, feature) => sum + feature.meanPitch, 0) / features.length;
  const bass = bassCandidates.length && bassCandidates[0].meanPitch <= overallMean - 4 ? bassCandidates[0] : null;
  // 2) 和声：常驻、节奏偏均匀（中位时值 >= 0.35 拍）、音高在低音之上；最多取 3 条
  const harmonyCandidates = features
    .filter((feature) => feature !== bass
      && feature.noteCount >= ACAPPELLA_HARMONY_MIN_NOTES
      && feature.coverage >= ACAPPELLA_HARMONY_MIN_COVERAGE
      && feature.medianDuration >= ACAPPELLA_HARMONY_MIN_MEDIAN_BEATS
      && (!bass || feature.meanPitch > bass.meanPitch + 3))
    .sort((left, right) => left.meanPitch - right.meanPitch);
  const harmonyFeatures = harmonyCandidates.slice(0, 3);
  const extraHarmony = harmonyCandidates.slice(3);
  // 3) 主唱：中位时值短（有旋律感）、覆盖率不太低、不属于低音/和声；按进场先后取前 2 条
  const used = new Set();
  if (bass) used.add(bass);
  for (const feature of harmonyFeatures) used.add(feature);
  for (const feature of extraHarmony) used.add(feature);
  const leadCandidates = features
    .filter((feature) => !used.has(feature)
      && feature.noteCount >= ACAPPELLA_LEAD_MIN_NOTES
      && feature.coverage >= ACAPPELLA_LEAD_MIN_COVERAGE
      && feature.medianDuration <= ACAPPELLA_LEAD_MAX_MEDIAN_BEATS)
    .sort((left, right) => left.firstBeat - right.firstBeat);
  const leadFeatures = leadCandidates.slice(0, 2);
  for (const feature of leadFeatures) used.add(feature);
  // 4) 其余轨：六成以上在结尾段 → 结尾叠层；否则算加花/点缀
  const rest = substantial.filter((feature) => !used.has(feature));
  const padFeatures = rest.filter((feature) => feature.lateRatio >= ACAPPELLA_PAD_LATE_RATIO)
    .sort((left, right) => right.meanPitch - left.meanPitch);
  const fillFeatures = rest.filter((feature) => feature.lateRatio < ACAPPELLA_PAD_LATE_RATIO)
    .sort((left, right) => right.meanPitch - left.meanPitch);
  if (!bass || harmonyFeatures.length < 2 || leadFeatures.length < 1) {
    return empty(
      !bass ? "no-bass" : harmonyFeatures.length < 2 ? "no-harmony" : "no-lead",
      { tracks: tracks.length, bass: Boolean(bass), harmony: harmonyFeatures.length, leads: leadFeatures.length },
    );
  }
  // 名称：主唱 1/2；和声从高到低；低音；叠层从高到低；加花（高/低）
  const harmonyOrdered = harmonyFeatures.slice().reverse();   // 高 → 低
  const harmonyLabels = harmonyOrdered.length === 3 ? ["和声 · 高", "和声 · 中", "和声 · 低"]
    : harmonyOrdered.length === 2 ? ["和声 · 高", "和声 · 低"]
      : harmonyOrdered.map((feature, index) => `和声 ${index + 1}`);
  const leadGroups = leadFeatures.map((feature, index) => acappellaGroup(`主唱 ${index + 1}`, index === 0 ? "lead1" : "lead2", [feature]));
  const harmonyGroups = harmonyOrdered.map((feature, index) => acappellaGroup(harmonyLabels[index], "harmony", [feature]));
  const bassGroup = acappellaGroup("低音", "bass", [bass]);
  const padGroups = padFeatures.map((feature, index) => acappellaGroup(`叠层 ${index + 1}`, "pad", [feature]));
  const fillGroups = fillFeatures.map((feature, index) => {
    const label = fillFeatures.length === 1 ? "加花"
      : fillFeatures.length === 2 ? (index === 0 ? "加花（高）" : "加花（低）")
        : `加花 ${index + 1}`;
    return acappellaGroup(label, "fill", [feature]);
  });
  const otherGroups = extraHarmony.map((feature, index) => acappellaGroup(`附加声部 ${index + 1}`, "other", [feature]));
  const core = [...leadGroups, ...harmonyGroups, bassGroup];
  const full = [...core, ...padGroups, ...otherGroups];
  const reference = [...full, ...fillGroups];
  const roles = [
    ...leadFeatures.map((feature, index) => ({ track: feature.track.index, role: index === 0 ? "lead1" : "lead2", name: leadGroups[index].name })),
    ...harmonyOrdered.map((feature, index) => ({ track: feature.track.index, role: "harmony", name: harmonyLabels[index] })),
    { track: bass.track.index, role: "bass", name: "低音" },
    ...padFeatures.map((feature, index) => ({ track: feature.track.index, role: "pad", name: padGroups[index].name })),
    ...fillFeatures.map((feature, index) => ({ track: feature.track.index, role: "fill", name: fillGroups[index].name })),
    ...extraHarmony.map((feature, index) => ({ track: feature.track.index, role: "other", name: otherGroups[index].name })),
  ];
  return {
    available: true,
    reason: "",
    core,
    full,
    reference,
    roles,
    stats: {
      tracks: tracks.length,
      leads: leadFeatures.length,
      harmony: harmonyFeatures.length,
      pads: padFeatures.length,
      fills: fillFeatures.length,
      others: extraHarmony.length,
    },
  };
}

/** 同度重复去重：同音高、起拍差在容差内的音合并成一个（时值取最长）。 */
function mergeDuplicateNotes(notes, tolerance) {
  const sorted = notes.slice().sort((left, right) => left.midi - right.midi
    || left.startTick - right.startTick || right.endTick - left.endTick);
  const kept = [];
  const lastByMidi = new Map();
  for (const note of sorted) {
    const previous = lastByMidi.get(note.midi);
    if (previous && Math.abs(note.startTick - previous.startTick) <= tolerance) {
      previous.startTick = Math.min(previous.startTick, note.startTick);
      previous.endTick = Math.max(previous.endTick, note.endTick);
      continue;
    }
    const copy = { midi: note.midi, startTick: note.startTick, endTick: note.endTick };
    kept.push(copy);
    lastByMidi.set(note.midi, copy);
  }
  return kept.sort((left, right) => left.startTick - right.startTick || left.midi - right.midi);
}

/**
 * 把「同时开始、同时结束」的音合并成和弦单元（块状和声/柱式和弦 → 一个音符 + `<chord/>`）。
 * 先合并再分配声部线，这样 4 条平行和声不会占满 4 条声部线。
 */
function groupChordUnits(events) {
  const sorted = events.slice().sort((left, right) => left.startTick - right.startTick
    || left.endTick - right.endTick || left.midi - right.midi);
  const units = [];
  let index = 0;
  while (index < sorted.length) {
    const first = sorted[index];
    const unit = { startTick: first.startTick, endTick: first.endTick, members: [first] };
    let next = index + 1;
    while (next < sorted.length && sorted[next].startTick === first.startTick && sorted[next].endTick === first.endTick) {
      unit.members.push(sorted[next]);
      next += 1;
    }
    units.push(unit);
    index = next;
  }
  return units;
}

/** 把一条轨的音按小节切开（跨小节 → 拆段并加连音线）。 */
function splitNotesIntoMeasures(notes, measures, measureIndexOfTick) {
  const byMeasure = new Map();
  for (const note of notes) {
    let startTick = note.startTick;
    const endTick = note.endTick;
    let guard = 0;
    while (startTick < endTick && guard < 128) {
      guard += 1;
      const measureIndex = measureIndexOfTick(startTick);
      const measure = measures[measureIndex];
      const barEnd = measure.startTick + measure.lengthTicks;
      const segmentEnd = Math.min(endTick, barEnd);
      if (!byMeasure.has(measureIndex)) byMeasure.set(measureIndex, []);
      byMeasure.get(measureIndex).push({
        midi: note.midi,
        startTick,
        endTick: segmentEnd,
        tieStart: segmentEnd < endTick,
        tieStop: startTick > note.startTick,
      });
      startTick = segmentEnd;
    }
  }
  return byMeasure;
}

/** 输出一个声部的 MusicXML 行。 */
function renderPartLines(part, partIndex, context, lines) {
  const { measures, measureIndexOfTick, timeChanges, tempoMarks, key, division, grid } = context;
  const clef = clefForNotes(part.notes);
  lines.push(`  <part id="P${partIndex + 1}">`);
  const byMeasure = splitNotesIntoMeasures(part.notes, measures, measureIndexOfTick);
  let noteCount = 0;
  for (let measureIndex = 0; measureIndex < measures.length; measureIndex += 1) {
    const measure = measures[measureIndex];
    lines.push(`    <measure number="${measureIndex + 1}">`);
    if (measureIndex === 0) {
      lines.push(attributesXml({ beats: measure.beats, beatType: measure.beatType, clef, includeDivisions: true, key }));
    } else {
      const change = timeChanges.get(measureIndex);
      if (change) lines.push(attributesXml({ beats: change.beats, beatType: change.beatType, includeDivisions: false, key }));
    }
    for (const tempo of tempoMarks.filter((item) => item.measureIndex === measureIndex)) {
      lines.push(directionXml(tempo.bpm));
    }
    const events = byMeasure.get(measureIndex) || [];
    // 先合并成和弦单元，再把单元分配到「声部线」（同一线内不能时间重叠）
    const units = groupChordUnits(events);
    const voiceEnds = [];
    const voices = [];
    for (const unit of units) {
      let voiceIndex = -1;
      for (let index = 0; index < voiceEnds.length; index += 1) {
        if (voiceEnds[index] <= unit.startTick + 1e-6) { voiceIndex = index; break; }
      }
      if (voiceIndex < 0) {
        if (voiceEnds.length < MAX_VOICES) voiceIndex = voiceEnds.length;
        else {
          // 声部线用满了：裁到最早结束的那条线之后（宁可少一个叠音，也不让时间轴倒退）
          voiceIndex = voiceEnds.indexOf(Math.min(...voiceEnds));
          unit.startTick = Math.max(unit.startTick, voiceEnds[voiceIndex]);
          if (unit.endTick - unit.startTick < grid) continue;
        }
      }
      voiceEnds[voiceIndex] = unit.endTick;
      if (!voices[voiceIndex]) voices[voiceIndex] = [];
      voices[voiceIndex].push(unit);
    }
    const activeVoiceCount = voices.filter(Boolean).length;
    const measureDuration = Math.round(measure.quarterBeats * OUTPUT_DIVISIONS);
    for (let voiceIndex = 0; voiceIndex < activeVoiceCount; voiceIndex += 1) {
      const voiceUnits = voices[voiceIndex] || [];
      if (voiceIndex > 0) lines.push(`      <backup><duration>${measureDuration}</duration></backup>`);
      const voiceNumber = voiceIndex + 1;
      let cursorTick = measure.startTick;
      for (const unit of voiceUnits) {
        if (unit.startTick > cursorTick) {
          lines.push(restXml((unit.startTick - cursorTick) / division, voiceNumber, key));
          cursorTick = unit.startTick;
        }
        const pieces = splitBeats((unit.endTick - unit.startTick) / division, (measure.lengthTicks / division));
        let pieceIndex = 0;
        for (const pieceBeats of pieces) {
          const isFirst = pieceIndex === 0;
          const isLast = pieceIndex === pieces.length - 1;
          for (let memberIndex = 0; memberIndex < unit.members.length; memberIndex += 1) {
            const member = unit.members[memberIndex];
            lines.push(noteXml({
              midi: member.midi,
              beats: pieceBeats,
              voice: voiceNumber,
              chord: memberIndex > 0,
              tieStop: isFirst ? member.tieStop : true,
              tieStart: isLast ? member.tieStart : true,
              key,
            }));
          }
          pieceIndex += 1;
        }
        cursorTick = Math.max(cursorTick, unit.endTick);
        noteCount += unit.members.length;
      }
      if (cursorTick < measure.startTick + measure.lengthTicks) {
        lines.push(restXml((measure.startTick + measure.lengthTicks - cursorTick) / division, voiceNumber, key));
      }
    }
    if (!activeVoiceCount) {
      lines.push(noteXml({ beats: measure.quarterBeats, voice: 1, rest: true, key }));
    }
    lines.push("    </measure>");
  }
  lines.push("  </part>");
  return noteCount;
}

/**
 * MIDI → MusicXML（五线谱）。
 *
 * 默认 `grouping: "auto"`：先分析轨道关系，把同一条旋律的重复/八度/和声叠加轨归并成
 * 「主旋律 + 和声层」；真正独立的内容才各自成为一个声部。其它可选值：
 *   · `"tracks"`：一条 MIDI 轨道 = 一个声部（传统做法，调试/特殊需求时用）
 *   · `"melody"`：只保留主旋律一个声部
 *
 * @param {Uint8Array|ArrayBuffer} input MIDI 文件字节
 * @param {{title?: string, maxParts?: number, grouping?: "auto"|"tracks"|"melody"}} [options]
 * @returns {{musicxml: string, meta: object}}
 */
export function midiToMusicXml(input, options = {}) {
  const midi = parseMidiFile(input);
  const title = String(options.title || "").trim() || "MIDI 导入的乐谱";
  const grouping = ["tracks", "melody", "voices", "acappella6", "acappella10", "acappella12"].includes(options.grouping)
    ? options.grouping
    : "auto";
  const division = midi.division;
  const grid = Math.max(1, Math.round(division / QUANTIZE_STEPS_PER_BEAT));
  const quantize = (tick) => Math.round(tick / grid) * grid;
  const timeSignatures = midi.timeSignatures;
  const firstTime = timeSignatures[0] || { beats: 4, beatType: 4 };
  // 收集「有音符的轨道」；打击乐通道（10）的音符跳过。
  const sourceTracks = [];
  let percussionNotes = 0;
  let maxNoteEndTick = 0;
  for (const track of midi.tracks) {
    const pitched = [];
    for (const note of track.notes) {
      if (note.channel === 9) { percussionNotes += 1; continue; }
      pitched.push(note);
    }
    if (!pitched.length) continue;
    const notes = pitched.map((note) => {
      const startTick = Math.max(0, quantize(note.startTick));
      const endTick = Math.max(startTick + grid, quantize(note.endTick));
      maxNoteEndTick = Math.max(maxNoteEndTick, endTick);
      return { midi: note.midi, startTick, endTick };
    }).sort((left, right) => left.startTick - right.startTick || left.midi - right.midi);
    sourceTracks.push({ index: sourceTracks.length, name: track.name, notes });
  }
  if (!sourceTracks.length) throw new Error("MIDI 文件里没有可记谱的音符（可能只有打击乐或控制事件）。");
  // 按需截断（maxParts 只限制「独立声部」的数量，归并后的主旋律/和声层不受影响）
  const analysis = analyzeMidiTracks(sourceTracks, division);
  const acappella = analyzeAcappellaTracks(sourceTracks, division);
  // 关系分析已经证明「这些轨是同一条旋律的重复/八度/和声叠录」时，阿卡贝拉角色识别没有意义：
  // 那是「一条旋律的多层叠录」，不是「多条不同的人声线」，别硬按主唱/和声去拆。
  if (acappella.available && analysis.appliedMode === "auto" && analysis.groups.length < sourceTracks.length - 1) {
    acappella.available = false;
    acappella.reason = "duplicate-layers";
  }
  const acappellaByMode = {
    acappella6: acappella.core, acappella10: acappella.full, acappella12: acappella.reference,
  };
  const trackParts = () => {
    const names = uniquePartNames(sourceTracks.map((item) => item.name));
    return sourceTracks.map((item, order) => ({
      name: names[order], role: "part", sourceIndexes: [item.index], notes: item.notes,
    }));
  };
  let groups;
  let appliedGrouping;
  if (grouping === "tracks") {
    groups = trackParts();
    appliedGrouping = "tracks";
  } else if (grouping in acappellaByMode) {
    if (acappella.available && acappellaByMode[grouping].length) {
      groups = acappellaByMode[grouping].slice();
      appliedGrouping = grouping;
    } else {
      groups = trackParts();
      appliedGrouping = "tracks";
    }
  } else if (grouping === "voices") {
    if (analysis.appliedMode === "auto") {
      groups = analysis.voiceGroups.slice();
      appliedGrouping = "voices";
    } else {
      groups = trackParts();
      appliedGrouping = "tracks";
    }
  } else if (grouping === "melody") {
    if (analysis.appliedMode === "auto") {
      groups = analysis.groups.filter((group) => group.role === "melody");
      appliedGrouping = "melody";
    } else if (acappella.available) {
      // 「只保留主旋律」：把主唱 1 / 主唱 2 合成一条旋律线（两者基本是交替唱，不冲突）
      const leadGroups = acappella.core.filter((group) => group.role === "lead1" || group.role === "lead2");
      const leadNotes = leadGroups.flatMap((group) => group.notes);
      const tolerance = Math.max(6, Math.round(division / 12));
      groups = [{
        name: "主旋律",
        role: "melody",
        sourceIndexes: leadGroups.flatMap((group) => group.sourceIndexes),
        notes: mergeDuplicateNotes(leadNotes, tolerance),
      }];
      appliedGrouping = "melody";
    } else {
      groups = trackParts();
      appliedGrouping = "tracks";
    }
  } else if (analysis.appliedMode === "auto") {
    groups = analysis.groups.slice();        // 合并版（自动整理重复/和声叠加）
    appliedGrouping = "auto";
  } else if (acappella.available) {
    groups = acappella.core.slice();         // 自动识别为阿卡贝拉编配 → 默认核心版
    appliedGrouping = "acappella6";
  } else {
    groups = trackParts();
    appliedGrouping = "tracks";
  }
  if (options.maxParts && groups.length > options.maxParts) groups = groups.slice(0, options.maxParts);
  // 估计整曲调号：让谱面少满屏临时记号（调号猜错不影响音高，用户可在制谱软件里改调号）
  const key = detectKey(sourceTracks.flatMap((item) => item.notes));
  const measures = buildMeasures(timeSignatures, division, Math.max(midi.totalTicks, maxNoteEndTick));
  const measureStarts = measures.map((measure) => measure.startTick);
  const measureIndexOfTick = (tick) => {
    let low = 0, high = measureStarts.length - 1, best = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (measureStarts[middle] <= tick + 1e-6) { best = middle; low = middle + 1; }
      else high = middle - 1;
    }
    return best;
  };
  const tempoMarks = midi.tempos.map((tempo) => ({ measureIndex: measureIndexOfTick(tempo.tick), bpm: tempo.bpm }));
  const timeChanges = new Map();
  for (const time of timeSignatures) {
    timeChanges.set(measureIndexOfTick(time.tick), { beats: time.beats, beatType: time.beatType });
  }
  const firstTempo = valueAt(midi.tempos, 0, { bpm: DEFAULT_TEMPO, tick: 0 });
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  lines.push('<score-partwise version="4.0">');
  lines.push(`  <work><work-title>${escapeXml(title)}</work-title></work>`);
  lines.push("  <identification><encoding><software>谱见 MIDI 导入</software></encoding></identification>");
  lines.push("  <part-list>");
  groups.forEach((group, index) => {
    lines.push(`    <score-part id="P${index + 1}"><part-name>${escapeXml(group.name)}</part-name></score-part>`);
  });
  lines.push("  </part-list>");
  let totalNoteCount = 0;
  groups.forEach((group, partIndex) => {
    totalNoteCount += renderPartLines(group, partIndex, {
      measures, measureIndexOfTick, timeChanges, tempoMarks, key, division, grid,
    }, lines);
  });
  lines.push("</score-partwise>");
  const trackNames = sourceTracks.map((item) => item.name);
  return {
    musicxml: lines.join("\n") + "\n",
    meta: {
      format: midi.format,
      division,
      tracks: midi.tracks.length,
      pitchedTracks: sourceTracks.length,
      parts: groups.length,
      notes: totalNoteCount,
      measures: measures.length,
      tempo: Math.round(firstTempo.bpm),
      tempos: midi.tempos.map((tempo) => ({ beat: Math.round((tempo.tick / division) * 100) / 100, bpm: tempo.bpm })),
      timeSignatures,
      timeSummary: `${firstTime.beats}/${firstTime.beatType}`,
      percussionNotes,
      key: keyDisplayName(key),
      keyFifths: key.fifths,
      keyMode: key.mode,
      // 声部整理结果：界面用它在「乐谱信息」里如实说明「N 条轨道 → M 个声部」。
      grouping: {
        requested: grouping,
        applied: appliedGrouping,
        // 阿卡贝拉识别结果（是否识别出编配角色、每轨角色、三种版本各几个声部）
        acappellaAvailable: acappella.available,
        acappellaReason: acappella.reason || "",
        acappellaRoles: acappella.roles,
        acappellaStats: acappella.stats,
        acappellaVersions: acappella.available ? {
          core: acappella.core.length,
          full: acappella.full.length,
          reference: acappella.reference.length,
        } : null,
        consolidated: appliedGrouping !== "tracks" && groups.length < sourceTracks.length,
        groups: groups.map((group) => {
          const pitches = group.notes.map((note) => note.midi);
          return {
            name: group.name,
            role: group.role,
            tracks: group.sourceIndexes.map((index) => trackNames[index] || `轨道 ${index + 1}`),
            notes: group.notes.length,
            // 音域（MIDI 音高）：阿卡贝拉编曲时要按音域分人，界面上直接标出来
            range: pitches.length ? [Math.min(...pitches), Math.max(...pitches)] : null,
          };
        }),
      },
    },
  };
}
