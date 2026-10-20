// MusicXML / 识别结果 → 创作室工程（score）的转换。
//
// 为什么需要这一层：
//   · 识别结果里的音符是「按拍位绝对定位」的（startBeat 可以是 4.5），
//     而创作室的音符是「按顺序往后排」的（前一个音多长，下一个音就从哪开始）；
//   · 创作室没有「空隙」概念，拍位对不上时必须插入休止，否则整首会挤在一起。
// 所以这里的核心工作是：**按小节把音符排成顺序，空隙补休止，跨小节/跨声部对齐**。
//
// 纯函数、不碰 DOM，可单测：tests/composer-import.test.mjs

import { createScore, createPart } from "./composer.js";

/** 把小数拍数对齐到创作室支持的时值里最接近的一个。 */
export const SNAP_VALUES = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.125];

export function snapBeats(beats) {
  const value = Number(beats) || 0;
  if (value <= 0) return 0;
  let best = SNAP_VALUES[0];
  let bestDiff = Infinity;
  for (const candidate of SNAP_VALUES) {
    const diff = Math.abs(candidate - value);
    if (diff < bestDiff - 1e-9) { bestDiff = diff; best = candidate; }
  }
  return best;
}

/**
 * 把一个「按拍位」的音符序列拆成小节的顺序结构（空隙补休止）。
 *
 * @param {Array<{midi:number,startBeat:number,durationBeats:number,rest?:boolean}>} notes
 * @param {number} beatsPerMeasure
 * @returns {{measures: Array<{beats: Array<{midi:number,beats:number,rest?:boolean}>}>,
 *            restBeats: number, noteCount: number, unplaced: number}}
 */
export function notesToMeasures(notes, beatsPerMeasure = 4) {
  const per = Number(beatsPerMeasure) > 0 ? Number(beatsPerMeasure) : 4;
  const sorted = [...notes]
    .filter((note) => Number.isFinite(Number(note.startBeat)))
    .sort((left, right) => Number(left.startBeat) - Number(right.startBeat));
  // 同一拍位的多个音是**和弦**（谱面上竖着叠在一起），必须全部保留。
  // 实测用户提供的谱子里和弦很多（Hall 曲 1768 个音中 738 个 <chord>，
  // 月光奏鸣曲 2009 个音中 634 个），只留最高音会大量丢音。
  const deduped = [];
  for (const note of sorted) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(Number(previous.startBeat) - Number(note.startBeat)) < 1e-6) {
      previous.chord = previous.chord || [];
      if (!previous.chord.includes(Math.round(Number(note.midi)))) {
        previous.chord.push(Math.round(Number(note.midi)));
      }
      continue;
    }
    deduped.push({ ...note });
  }

  const measures = [];
  let measure = { beats: [] };
  let cursor = 0;
  let restBeats = 0;
  let noteCount = 0;
  let unplaced = 0;

  const advanceTo = (target) => {
    // 在当前位置与 target 之间补休止（按小节切开）
    while (cursor < target - 1e-6) {
      const measureEnd = (Math.floor(cursor / per) + 1) * per;
      const chunkEnd = Math.min(target, measureEnd);
      const gap = snapBeats(chunkEnd - cursor);
      if (gap > 0) {
        measure.beats.push({ midi: 0, beats: gap, rest: true });
        restBeats += gap;
        cursor += gap;
      } else {
        cursor = chunkEnd;
      }
      if (cursor >= measureEnd - 1e-6) {
        measures.push(measure);
        measure = { beats: [] };
      }
    }
  };

  for (const note of deduped) {
    const start = Number(note.startBeat);
    // 起拍落在负数或超远位置（识别错误）时跳过，避免生成上千个空小节
    if (start < -1e-6) { unplaced += 1; continue; }
    if (start > per * 4000) { unplaced += 1; continue; }
    if (start > cursor) advanceTo(start);
    // 跨小节的音要拆段：谱面上一个音不能横跨小节线（会被拆成连音的两个音），
    // 创作室的数据结构同样要求「每个拍位都在本小节内」。
    let remaining = snapBeats(Number(note.durationBeats) || 1);
    if (remaining <= 0) remaining = snapBeats(per);
    let counted = false;   // 跨小节拆段时只统计一次，避免音符数虚高
    while (remaining > 1e-6) {
      const measureEnd = (Math.floor(cursor / per) + 1) * per;
      const room = snapBeats(measureEnd - cursor);
      const length = Math.min(remaining, room > 0 ? room : snapBeats(per));
      if (length <= 0) break;
      if (note.rest) {
        measure.beats.push({ midi: 0, beats: length, rest: true });
      } else {
        // 主音取和弦里最低的那个（低音在下更符合谱面观感），其余进 chordMidis
        const pitches = [Math.round(Number(note.midi)), ...(note.chord || [])]
          .filter((value) => Number.isFinite(value))
          .sort((left, right) => left - right);
        const unique = [...new Set(pitches)];
        const entry = { midi: unique[0], beats: length };
        if (unique.length > 1) entry.chordMidis = unique.slice(1);
        // 跨小节被拆开的后半段标上连音线来源：界面上能画出来，
        // 统计时也能把它算回「同一个音」，不然用户会以为音符莫名变多。
        if (counted) entry.tieFromPrev = true;
        measure.beats.push(entry);
      }
      if (!note.rest && !counted) {
        // 统计口径必须等于「原始音符数」：一个音被拆成跨小节的多段时，
        // 只有第一段计入，否则统计会虚高（实测真实谱导入后 192 个音报成 203 个）。
        noteCount += 1 + ((note.chord && note.chord.length) || 0);
        counted = true;
        note.chord = [];   // 附加音只在第一段算一次
      }
      cursor += length;
      remaining -= length;
      if (cursor >= measureEnd - 1e-6) {
        measures.push(measure);
        measure = { beats: [] };
      }
    }
    continue;
  }
  if (measure.beats.length) measures.push(measure);
  return { measures, restBeats, noteCount, unplaced };
}

/** 把「4/4」「3/8」拆成 {beats, beatType}。 */
export function parseTimeSummary(timeSummary, fallback = { beats: 4, beatType: 4 }) {
  const matched = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(timeSummary || ""));
  if (!matched) return { ...fallback };
  return { beats: Number(matched[1]), beatType: Number(matched[2]) };
}

/** 从「调号文字」猜 fifths（-7…7）。识别结果一般只给名字，所以只处理常见情况。 */
export function fifthsFromKeySummary(keySummary) {
  const text = String(keySummary || "");
  const matched = /([A-G])([#b♯♭]?)/.exec(text);
  if (!matched) return 0;
  const table = {
    "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6, "C#": 7,
    "F": -1, "Bb": -2, "Eb": -3, "Ab": -4, "Db": -5, "Gb": -6, "Cb": -7,
  };
  const accidental = matched[2].replace("♯", "#").replace("♭", "b");
  return table[matched[1] + accidental] ?? 0;
}

/**
 * 把识别结果（scoreInfo）转成创作室工程。
 *
 * 声部怎么处理：识别结果的每个 partId 变成一个创作室声部；
 * 每个声部内部按小节排成顺序结构（空隙补休止）。
 *
 * @param {object} scoreInfo parseMusicXmlText 的返回值
 * @param {{title?: string}} [options]
 */
export function scoreInfoToComposerScore(scoreInfo, options = {}) {
  const time = parseTimeSummary(scoreInfo && scoreInfo.timeSummary);
  const beatsPerMeasure = (time.beats * 4) / time.beatType;
  const notes = (scoreInfo && scoreInfo.notes) || [];
  // 按「声部 + voice」归并。
  // 为什么带 voice：钢琴谱同一谱表里常有多条并行声部（右手旋律 + 内声部），
  // 只按 partId 归并会把它们压成一条线，拍位全部错位（实测 192 个音只剩 117 个音位）。
  // 分开成独立声部后，每条 voice 内部基本是顺序的，转换才准确。
  const byPart = new Map();
  for (const note of notes) {
    const partKey = String(note.partId || note.partName || "旋律");
    const voiceKey = String(note.voice || "1");
    const key = `${partKey}\u0000${voiceKey}`;
    if (!byPart.has(key)) byPart.set(key, { partKey, voiceKey, notes: [] });
    byPart.get(key).notes.push(note);
  }
  const partNames = Array.isArray(scoreInfo && scoreInfo.partNames) ? scoreInfo.partNames : [];
  const parts = [];
  const stats = {
    parts: 0, notes: 0, rests: 0, measures: 0, unplaced: 0,
    tieSegments: 0, chordEntries: 0,
    // 原谱总音数（含和弦）与是否可能因结构限制而压缩
    sourceNotes: notes.filter((note) => !note.rest).length,
    voices: 0,
  };
  let index = 0;
  const voiceCount = new Map();
  for (const [key, group] of byPart) {
    const { measures, noteCount, restBeats, unplaced } = notesToMeasures(group.notes, beatsPerMeasure);
    if (!measures.length) continue;
    // 声部名：原谱有多个 voice 时标出来（「钢琴 · 声部2」），用户才知道哪个是旋律
    const baseName = partNames.find((item) => item === group.partKey) || group.partKey;
    const seenVoices = (voiceCount.get(baseName) || 0) + 1;
    voiceCount.set(baseName, seenVoices);
    const name = seenVoices > 1 || byPart.size > partNames.length
      ? `${baseName} · 声部${group.voiceKey}`
      : baseName;
    parts.push(createPart({
      name,
      clef: scoreInfo && scoreInfo.clef === "bass" ? "bass" : "treble",
      measures: measures.length ? measures : [{ beats: [] }],
    }));
    stats.parts += 1;
    stats.notes += noteCount;
    stats.voices += 1;
    for (const measure of measures) {
      for (const beat of measure.beats) {
        if (beat.tieFromPrev) stats.tieSegments += 1;
        if (Array.isArray(beat.chordMidis) && beat.chordMidis.length) stats.chordEntries += 1;
      }
    }
    stats.rests += Math.round(restBeats * 1000) / 1000;
    stats.measures = Math.max(stats.measures, measures.length);
    stats.unplaced += unplaced;
    index += 1;
  }
  const score = createScore({
    title: options.title || (scoreInfo && scoreInfo.title) || "导入的乐谱",
    tempo: Math.round(Number(scoreInfo && scoreInfo.tempo) || 84),
    beatsPerMeasure: Math.round(beatsPerMeasure * 1000) / 1000,
    beatType: time.beatType,
    keyFifths: fifthsFromKeySummary(scoreInfo && scoreInfo.keySummary),
    parts: parts.length ? parts : undefined,
  });
  return { score, stats };
}
