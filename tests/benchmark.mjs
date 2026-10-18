/**
 * 识别质量基准工具链（P0-2）：ground-truth 自洽校验 + 识别指标计算。
 *
 * ground-truth 格式：见 tests/fixtures/chilele_p11_jianpu.ground-truth.json（多声部）
 * 与 known_treble_quarters.ground-truth.json（单声部，用 step/octave 记音高）。
 * 音符统一归一成 { midi, onsetBeats, durationBeats }：
 *   - 多声部基准放在顶层的 parts 里；
 *   - 单声部基准直接放顶层 notes 里（也接受 parts）。
 * 音高既可写 midi，也可写 step + octave（+ 可选 alter）。
 *
 * 也可当命令行用（打印指标表）：
 *   node tests/benchmark.mjs <ground-truth.json> <识别结果.json>
 * 识别结果可以是 jianpu.py --json 的输出，或任何带 parts/notes + beatsPerMeasure 的对象。
 */

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DEFAULT_ONSET_TOLERANCE = 0.05;
const DEFAULT_DURATION_TOLERANCE = 0.05;

/** 十二平均律音高 -> MIDI（中央 C = 60）。 */
export function pitchToMidi(step, octave, alter = 0) {
  const letter = String(step || "").toUpperCase();
  if (!(letter in STEP_SEMITONES)) return Number.NaN;
  return 12 * (Number(octave) + 1) + STEP_SEMITONES[letter] + Number(alter || 0);
}

/** 把一个音符归一成 { midi, onsetBeats, durationBeats }。 */
export function normalizeNote(note) {
  const midi = Number.isFinite(Number(note.midi))
    ? Number(note.midi)
    : pitchToMidi(note.step, note.octave, note.alter);
  // 基准里叫 onsetBeats；jianpu.py 的原始输出叫 startBeat —— 两种都接受。
  const onset = Number.isFinite(Number(note.onsetBeats)) ? note.onsetBeats : note.startBeat;
  return {
    midi,
    onsetBeats: Number(onset),
    durationBeats: Number(note.durationBeats),
  };
}

/** 取出基准里的声部列表（单声部基准自动包成一个声部）。 */
export function groundTruthParts(gt) {
  if (Array.isArray(gt.parts) && gt.parts.length) {
    return gt.parts.map((part, index) => ({
      name: part.name || `声部${index + 1}`,
      notes: (part.notes || []).map(normalizeNote),
    }));
  }
  return [{ name: gt.title || "单声部", notes: (gt.notes || []).map(normalizeNote) }];
}

/** 识别结果的声部列表（同构）。 */
export function resultParts(result) {
  if (Array.isArray(result.parts) && result.parts.length) {
    return result.parts.map((part, index) => ({
      name: part.name || `声部${index + 1}`,
      notes: (part.notes || []).map(normalizeNote),
    }));
  }
  return [{ name: "单声部", notes: (result.notes || []).map(normalizeNote) }];
}

/**
 * 基准自洽校验。返回问题描述数组，空数组 = 通过。
 *
 * 能客观检查的部分：拍号/小节数为正、音符时长为正、起拍非负、
 * 各声部起拍单调不减、所有音符不超出全曲时间轴。
 * 时间轴上界优先用基准自己声明的 `totalBeats`；没有该字段时退回「小节数 × 拍号」——
 * 后者在「有已知超拍小节」的基准上会误报，所以带超拍小节的基准请如实写上 totalBeats。
 * 无法检查的部分（如实说明）：**每个小节内部是否恰好填满拍号**——那需要在基准里
 * 逐小节标注休止符；本项目的基准只录音符，所以不查「每小节 = 4 拍」。
 */
export function validateGroundTruth(gt) {
  const problems = [];
  const measureCount = Number(gt.measureCount);
  const beatsPerMeasure = Number(gt.beatsPerMeasure || (gt.timeSignature ? Number(String(gt.timeSignature).split("/")[0]) : 0));
  if (!Number.isFinite(measureCount) || measureCount <= 0) problems.push("measureCount 必须是正整数");
  if (!Number.isFinite(beatsPerMeasure) || beatsPerMeasure <= 0) problems.push("beatsPerMeasure（或 timeSignature 的分子）必须是正数");

  const parts = groundTruthParts(gt);
  if (!parts.length || parts.every((part) => !part.notes.length)) problems.push("基准里没有任何音符");
  const declaredBeats = Number(gt.totalBeats);
  const totalBeats = Number.isFinite(declaredBeats) && declaredBeats > 0 ? declaredBeats : measureCount * beatsPerMeasure;

  parts.forEach((part, partIndex) => {
    let previousOnset = -Infinity;
    part.notes.forEach((note, noteIndex) => {
      const label = `声部${partIndex + 1} 第 ${noteIndex + 1} 个音符`;
      if (!Number.isFinite(note.midi)) problems.push(`${label}：音高无法换算成 MIDI`);
      if (!(note.durationBeats > 0)) problems.push(`${label}：时值必须为正（现为 ${note.durationBeats}）`);
      if (!(note.onsetBeats >= 0)) problems.push(`${label}：起拍不能为负（现为 ${note.onsetBeats}）`);
      if (Number.isFinite(totalBeats) && note.onsetBeats + note.durationBeats > totalBeats + 1e-6) {
        problems.push(`${label}：超出全曲总长（${totalBeats} 拍）`);
      }
      if (note.onsetBeats < previousOnset - 1e-9) problems.push(`${label}：起拍不是单调不减的`);
      previousOnset = Math.max(previousOnset, note.onsetBeats);
    });
  });
  return problems;
}

/** 贪心配对：同音高、起拍差 ≤ 容差的音符配成一对（每个音符至多用一次）。 */
function matchNotes(gtNotes, resultNotes, onsetTolerance) {
  const used = new Set();
  const pairs = [];
  for (const gtNote of gtNotes) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    resultNotes.forEach((note, index) => {
      if (used.has(index) || note.midi !== gtNote.midi) return;
      const distance = Math.abs(note.onsetBeats - gtNote.onsetBeats);
      if (distance <= onsetTolerance && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
      pairs.push({ gt: gtNote, result: resultNotes[bestIndex] });
    }
  }
  return pairs;
}

/** 按拍号把小节切出来，供「端到端可演奏正确率」按 (声部, 小节) 判等。 */
function toMeasures(notes, beatsPerMeasure) {
  const buckets = new Map();
  for (const note of notes) {
    const index = Math.floor(note.onsetBeats / beatsPerMeasure + 1e-6);
    if (!buckets.has(index)) buckets.set(index, []);
    buckets.get(index).push(note);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.onsetBeats - b.onsetBeats || a.midi - b.midi);
  }
  return buckets;
}

/** 两个小节的内容是否完全一致（音高 + 小节内起拍 + 时值）。 */
function measuresEqual(left = [], right = [], beatsPerMeasure, measureIndex, onsetTolerance, durationTolerance) {
  if (left.length !== right.length) return false;
  return left.every((note, index) => {
    const other = right[index];
    return note.midi === other.midi
      && Math.abs((note.onsetBeats - measureIndex * beatsPerMeasure) - (other.onsetBeats - measureIndex * beatsPerMeasure)) <= onsetTolerance
      && Math.abs(note.durationBeats - other.durationBeats) <= durationTolerance;
  });
}

/**
 * 计算识别指标。声部按顺序一一对应（GT 与结果的声部结构应当同构）。
 * 返回的对象里 0..1 的比率可直接当百分数看。
 */
export function compareScore(gt, result, options = {}) {
  const onsetTolerance = Number.isFinite(options.onsetTolerance) ? options.onsetTolerance : DEFAULT_ONSET_TOLERANCE;
  const durationTolerance = Number.isFinite(options.durationTolerance) ? options.durationTolerance : DEFAULT_DURATION_TOLERANCE;
  const beatsPerMeasure = Number(result.beatsPerMeasure || gt.beatsPerMeasure || 4);
  const gtParts = groundTruthParts(gt);
  const resultPartsList = resultParts(result);

  const gtNotes = gtParts.flatMap((part) => part.notes);
  const resultNotes = resultPartsList.flatMap((part) => part.notes);
  const pairs = matchNotes(gtNotes, resultNotes, onsetTolerance);

  const matchedGt = pairs.length;
  const matchedResult = pairs.length;
  const precision = resultNotes.length ? matchedResult / resultNotes.length : 0;
  const recall = gtNotes.length ? matchedGt / gtNotes.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const rhythmCorrect = pairs.length
    ? pairs.filter((pair) => Math.abs(pair.gt.durationBeats - pair.result.durationBeats) <= durationTolerance).length / pairs.length
    : 0;
  const countAccuracy = gtNotes.length
    ? Math.max(0, 1 - Math.abs(resultNotes.length - gtNotes.length) / gtNotes.length)
    : (resultNotes.length ? 0 : 1);

  // 端到端可演奏正确率：按 (声部序号, 小节) 逐一比对，完全一致的小节才算对。
  let correctCells = 0;
  let totalCells = 0;
  const partCount = Math.max(gtParts.length, resultPartsList.length);
  for (let partIndex = 0; partIndex < partCount; partIndex++) {
    const gtMeasures = toMeasures(gtParts[partIndex] ? gtParts[partIndex].notes : [], beatsPerMeasure);
    const resultMeasures = toMeasures(resultPartsList[partIndex] ? resultPartsList[partIndex].notes : [], beatsPerMeasure);
    const indexes = new Set([...gtMeasures.keys(), ...resultMeasures.keys()]);
    for (const index of indexes) {
      const gtBucket = gtMeasures.get(index) || [];
      const resultBucket = resultMeasures.get(index) || [];
      if (!gtBucket.length && !resultBucket.length) continue; // 双方都空的小节不计入
      totalCells++;
      if (measuresEqual(gtBucket, resultBucket, beatsPerMeasure, index, onsetTolerance, durationTolerance)) correctCells++;
    }
  }

  return {
    beatsPerMeasure,
    gtNoteCount: gtNotes.length,
    resultNoteCount: resultNotes.length,
    matchedCount: matchedGt,
    countAccuracy,
    pitchPrecision: precision,
    pitchRecall: recall,
    pitchF1: f1,
    rhythmAccuracy: rhythmCorrect,
    exactMeasureRate: totalCells ? correctCells / totalCells : 0,
    exactMeasures: correctCells,
    measureCells: totalCells,
  };
}

/** 把指标渲染成一张可读的表（供命令行或报告使用）。 */
export function formatMetrics(metrics, { title = "识别指标", groundTruth = "", result = "" } = {}) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const lines = [`== ${title} ==`];
  if (groundTruth) lines.push(`基准：${groundTruth}`);
  if (result) lines.push(`结果：${result}`);
  lines.push(
    `音符数：基准 ${metrics.gtNoteCount} / 结果 ${metrics.resultNoteCount}（音符数准确率 ${percent(metrics.countAccuracy)}）`,
    `配对数：${metrics.matchedCount}`,
    `位置音高正确率（召回）：${percent(metrics.pitchRecall)}`,
    `音高精确率：${percent(metrics.pitchPrecision)}`,
    `音高 F1：${percent(metrics.pitchF1)}`,
    `节奏正确率（已配对音符中时值也对）：${percent(metrics.rhythmAccuracy)}`,
    `端到端可演奏正确率（完全正确的小节）：${percent(metrics.exactMeasureRate)}（${metrics.exactMeasures}/${metrics.measureCells}）`,
  );
  return lines.join("\n");
}

const isCli = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isCli) {
  const [gtPath, resultPath] = process.argv.slice(2);
  if (!gtPath || !resultPath) {
    console.error("用法：node tests/benchmark.mjs <ground-truth.json> <识别结果.json>");
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  const gt = JSON.parse(readFileSync(gtPath, "utf8"));
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const problems = validateGroundTruth(gt);
  if (problems.length) {
    console.log("基准自洽校验未通过：");
    for (const problem of problems) console.log(`  - ${problem}`);
  } else {
    console.log("基准自洽校验：通过");
  }
  console.log(formatMetrics(compareScore(gt, result), { groundTruth: gtPath, result: resultPath }));
}
