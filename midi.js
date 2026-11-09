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

/**
 * MIDI → MusicXML（五线谱）。
 *
 * @param {Uint8Array|ArrayBuffer} input MIDI 文件字节
 * @param {{title?: string, maxParts?: number}} [options]
 * @returns {{musicxml: string, meta: object}}
 */
export function midiToMusicXml(input, options = {}) {
  const midi = parseMidiFile(input);
  const title = String(options.title || "").trim() || "MIDI 导入的乐谱";
  const division = midi.division;
  const grid = Math.max(1, Math.round(division / QUANTIZE_STEPS_PER_BEAT));
  const quantize = (tick) => Math.round(tick / grid) * grid;
  const timeSignatures = midi.timeSignatures;
  const firstTime = timeSignatures[0] || { beats: 4, beatType: 4 };
  // 收集「有音符的轨道」→ 每个轨道一个声部；打击乐通道（10）的音符跳过。
  const partTracks = [];
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
    partTracks.push({ track, notes });
  }
  if (!partTracks.length) throw new Error("MIDI 文件里没有可记谱的音符（可能只有打击乐或控制事件）。");
  if (options.maxParts && partTracks.length > options.maxParts) partTracks.length = options.maxParts;
  const partNames = uniquePartNames(partTracks.map((item) => item.track.name));
  // 估计整曲调号：让谱面少满屏临时记号（调号猜错不影响音高，用户可在制谱软件里改调号）
  const key = detectKey(partTracks.flatMap((item) => item.notes));
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
  partNames.forEach((name, index) => {
    lines.push(`    <score-part id="P${index + 1}"><part-name>${escapeXml(name)}</part-name></score-part>`);
  });
  lines.push("  </part-list>");
  let totalNoteCount = 0;
  partTracks.forEach(({ notes }, partIndex) => {
    const clef = clefForNotes(notes);
    lines.push(`  <part id="P${partIndex + 1}">`);
    // 音符按小节切段（跨小节 → 拆成多段并加连音线）
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
      const events = (byMeasure.get(measureIndex) || []).sort((left, right) => left.startTick - right.startTick || left.midi - right.midi);
      // 分配声部线：同一条声部线内的音不能时间重叠；和弦（同时开始、同时结束）放在同一线。
      const voiceEnds = [];
      const voices = [];
      for (const event of events) {
        let voiceIndex = -1;
        for (let index = 0; index < voiceEnds.length; index += 1) {
          if (voiceEnds[index] <= event.startTick + 1e-6) { voiceIndex = index; break; }
        }
        if (voiceIndex < 0) {
          if (voiceEnds.length < MAX_VOICES) voiceIndex = voiceEnds.length;
          else {
            // 声部线用满了：裁到最早结束的那条线之后（宁可少一个叠音，也不让时间轴倒退）
            voiceIndex = voiceEnds.indexOf(Math.min(...voiceEnds));
            event.startTick = Math.max(event.startTick, voiceEnds[voiceIndex]);
            if (event.endTick - event.startTick < grid) continue;
          }
        }
        voiceEnds[voiceIndex] = event.endTick;
        if (!voices[voiceIndex]) voices[voiceIndex] = [];
        voices[voiceIndex].push(event);
      }
      const activeVoiceCount = voices.filter(Boolean).length;
      const measureDuration = Math.round(measure.quarterBeats * OUTPUT_DIVISIONS);
      for (let voiceIndex = 0; voiceIndex < activeVoiceCount; voiceIndex += 1) {
        const voiceEvents = voices[voiceIndex] || [];
        if (voiceIndex > 0) lines.push(`      <backup><duration>${measureDuration}</duration></backup>`);
        const voiceNumber = voiceIndex + 1;
        let cursorTick = measure.startTick;
        for (let eventIndex = 0; eventIndex < voiceEvents.length; eventIndex += 1) {
          const event = voiceEvents[eventIndex];
          if (event.usedAsChord) continue;
          if (event.startTick > cursorTick) {
            lines.push(restXml((event.startTick - cursorTick) / division, voiceNumber, key));
            cursorTick = event.startTick;
          }
          // 和弦：从当前音开始、同时结束的音一起输出（第一个不带 <chord/>，其余带）
          const chordMembers = [event];
          for (let otherIndex = eventIndex + 1; otherIndex < voiceEvents.length; otherIndex += 1) {
            const other = voiceEvents[otherIndex];
            if (other.usedAsChord) continue;
            if (other.startTick !== event.startTick) break;
            if (other.endTick !== event.endTick) continue;
            other.usedAsChord = true;
            chordMembers.push(other);
          }
          for (let memberIndex = 0; memberIndex < chordMembers.length; memberIndex += 1) {
            const member = chordMembers[memberIndex];
            const pieces = splitBeats((member.endTick - member.startTick) / division, (measure.lengthTicks / division));
            let pieceIndex = 0;
            for (const pieceBeats of pieces) {
              const isFirst = pieceIndex === 0;
              const isLast = pieceIndex === pieces.length - 1;
              lines.push(noteXml({
                midi: member.midi,
                beats: pieceBeats,
                voice: voiceNumber,
                chord: memberIndex > 0,
                tieStop: isFirst ? member.tieStop : true,
                tieStart: isLast ? member.tieStart : true,
                key,
              }));
              pieceIndex += 1;
            }
          }
          cursorTick = Math.max(cursorTick, event.endTick);
          totalNoteCount += chordMembers.length;
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
  });
  lines.push("</score-partwise>");
  return {
    musicxml: lines.join("\n") + "\n",
    meta: {
      format: midi.format,
      division,
      tracks: midi.tracks.length,
      parts: partTracks.length,
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
    },
  };
}
