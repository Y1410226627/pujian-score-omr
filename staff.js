// 谱表检测、系统分组、逐谱表识别结果合并 —— 以纯函数为主，便于单元测试。
//
// 背景：本机 OMR 引擎（homr）会把整页的多行谱表压平成"一个声部"，
// 各谱表的小节被首尾相接而非并行。解决办法是先在本端把页面切成单行谱表，
// 逐行送去识别，再按"系统内并行、系统间顺序"的规则重新拼成多声部乐谱。

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const NATURAL_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// 各谱号"最下线"对应的音（与 app.js 的 pitchForStaffStep 保持一致）
export const CLEF_BOTTOM = {
  treble: { step: "E", octave: 4 },
  bass: { step: "G", octave: 2 },
  alto: { step: "F", octave: 3 },
  tenor: { step: "D", octave: 3 },
};
// homr 输出的谱号标记 → 本项目的谱号名
export const CLEF_BY_SIGN = {
  "G2": "treble",
  "F4": "bass",
  "F3": "bass",
  "C3": "alto",
  "C4": "tenor",
};

export const STAFF_LINE_COUNT = 5;

export function medianOf(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Otsu 法自动阈值，用于把灰度图二值化。 */
export function otsuThreshold(gray) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let sumBackground = 0;
  let weightBackground = 0;
  let best = -1;
  let threshold = 170;
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (!weightBackground) continue;
    const weightForeground = gray.length - weightBackground;
    if (!weightForeground) break;
    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > best) {
      best = variance;
      threshold = t;
    }
  }
  return Math.max(90, Math.min(220, threshold));
}

export function binarize(gray) {
  const threshold = otsuThreshold(gray);
  const binary = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) binary[i] = gray[i] < threshold ? 1 : 0;
  return binary;
}

function detectStaffLineYs(binary, width, height, coverageRatio) {
  const rows = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    const offset = y * width;
    for (let x = 0; x < width; x++) count += binary[offset + x];
    rows[y] = count;
  }
  const coverage = Math.max(12, width * coverageRatio);
  const lineYs = [];
  let start = -1;
  let last = -1;
  for (let y = 0; y <= height; y++) {
    if (y < height && rows[y] >= coverage) {
      if (start < 0) start = y;
      last = y;
    } else if (start >= 0) {
      let weighted = 0;
      let strength = 0;
      for (let row = start; row <= last; row++) {
        weighted += row * rows[row];
        strength += rows[row];
      }
      lineYs.push(weighted / Math.max(1, strength));
      start = -1;
    }
  }
  return lineYs;
}

/**
 * 在整页二值图上检测谱表，并给出每行谱表的上下左右边界。
 * 先按较严的覆盖率找谱线；若结果太少，再放宽阈值重试（应对谱面只占页面一部分的情况）。
 */
export function detectStaves(binary, width, height) {
  let lineYs = detectStaffLineYs(binary, width, height, 0.45);
  if (lineYs.length < STAFF_LINE_COUNT) lineYs = detectStaffLineYs(binary, width, height, 0.25);
  const staves = groupStaffLines(lineYs);
  return staves.map((staff) => {
    const bandTop = Math.max(0, Math.floor(staff.top - 2));
    const bandBottom = Math.min(height - 1, Math.ceil(staff.bottom + 2));
    let left = width;
    let right = -1;
    for (let y = bandTop; y <= bandBottom; y++) {
      const offset = y * width;
      for (let x = 0; x < width; x++) {
        if (!binary[offset + x]) continue;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (right < left) {
      left = 0;
      right = width - 1;
    }
    return { ...staff, left, right };
  });
}

export function diatonicIndex(step, octave) {
  return LETTERS.indexOf(step) + 7 * octave;
}

export function naturalMidi(step, octave) {
  return (octave + 1) * 12 + (NATURAL_SEMITONES[step] ?? 0);
}

/**
 * 把检测到的谱线 y 坐标分组成一行行谱表（每行 5 条线）。
 * 谱表内的线间距小而均匀，谱表之间会有一个明显更大的间隔。
 */
export function groupStaffLines(lineYs) {
  const sorted = [...new Set(lineYs.map((y) => Math.round(y * 10) / 10))].sort((a, b) => a - b);
  if (sorted.length < STAFF_LINE_COUNT) return [];

  const split = (lines) => {
    if (lines.length < STAFF_LINE_COUNT) return [];
    if (lines.length === STAFF_LINE_COUNT) return [lines];
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1]);
    const median = medianOf(gaps);
    const maxGap = Math.max(...gaps);
    // 组内出现明显更大的间隔 → 在最大间隔处切开继续分
    if (median > 0 && maxGap > median * 1.8) {
      const index = gaps.indexOf(maxGap);
      return [...split(lines.slice(0, index + 1)), ...split(lines.slice(index + 1))];
    }
    // 无法再分（间距过于均匀）：条数正好是 5 的倍数时按 5 条一组均分，
    // 否则取间距最规整的连续 5 条。
    if (lines.length % STAFF_LINE_COUNT === 0) {
      const chunks = [];
      for (let start = 0; start < lines.length; start += STAFF_LINE_COUNT) {
        chunks.push(lines.slice(start, start + STAFF_LINE_COUNT));
      }
      return chunks;
    }
    const best = bestFiveLineWindow(lines);
    return best ? [best] : [];
  };

  return split(sorted)
    .map((lines) => {
      const spacing = (lines[STAFF_LINE_COUNT - 1] - lines[0]) / (STAFF_LINE_COUNT - 1);
      if (!(spacing > 0)) return null;
      // 真实谱表的线距通常只有十几到几十像素；简谱页上的"系统边线"间距可达上百像素，
      // 这种组显然不是五线谱，直接丢弃，让上层给出"可能是简谱"的准确提示。
      if (spacing > 60) return null;
      return { lines, spacing, top: lines[0], bottom: lines[STAFF_LINE_COUNT - 1] };
    })
    .filter(Boolean);
}

function bestFiveLineWindow(lines) {
  let best = null;
  let bestScore = Infinity;
  for (let start = 0; start + STAFF_LINE_COUNT <= lines.length; start++) {
    const window = lines.slice(start, start + STAFF_LINE_COUNT);
    const gaps = [];
    for (let i = 1; i < window.length; i++) gaps.push(window[i] - window[i - 1]);
    const mean = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
    if (mean <= 0) continue;
    const deviation = gaps.reduce((sum, value) => sum + Math.abs(value - mean), 0) / gaps.length / mean;
    if (deviation < bestScore) {
      bestScore = deviation;
      best = window;
    }
  }
  return best;
}

/**
 * 把谱表按"系统"分组：同一系统内的谱表在时间上并行，不同系统在时间上先后相接。
 * 依据是谱表之间的空白高度——系统之间的空白明显更大。
 */
export function groupSystems(staves) {
  const ordered = [...staves].sort((a, b) => a.top - b.top);
  if (ordered.length <= 1) return ordered.length ? [ordered] : [];

  const gaps = [];
  for (let i = 1; i < ordered.length; i++) gaps.push(ordered[i].top - ordered[i - 1].bottom);

  const systems = [];
  let current = [ordered[0]];
  let remaining = gaps.map((gap, index) => ({ gap, index }));
  // 反复在"最大的、且明显大于次大值"的间隔处切开，直到没有可切点
  const cutPoints = new Set();
  let candidates = remaining;
  while (candidates.length >= 1) {
    const sorted = [...candidates].sort((a, b) => b.gap - a.gap);
    const largest = sorted[0];
    const second = sorted[1];
    if (!second || largest.gap < second.gap * 1.35) break;
    cutPoints.add(largest.index);
    candidates = candidates.filter((item) => item.index !== largest.index);
  }

  for (let i = 0; i < gaps.length; i++) {
    if (cutPoints.has(i)) {
      systems.push(current);
      current = [];
    }
    current.push(ordered[i + 1]);
  }
  systems.push(current);
  return systems;
}

/** 对每个谱表计算在页面上要裁剪的区域：左右到谱线两端，上下留出加线/符干空间且不越过邻行。 */
export function staffCropBox(staff, pageWidth, pageHeight, previousStaff, nextStaff) {
  const halfSpace = staff.spacing / 2;
  let top = staff.top - halfSpace * 5.5;
  let bottom = staff.bottom + halfSpace * 5.5;
  if (previousStaff) top = Math.max(top, (previousStaff.bottom + staff.top) / 2);
  if (nextStaff) bottom = Math.min(bottom, (staff.bottom + nextStaff.top) / 2);
  top = Math.max(0, top);
  bottom = Math.min(pageHeight, bottom);
  const margin = Math.max(6, (staff.right - staff.left) * 0.015);
  const left = Math.max(0, (staff.left ?? 0) - margin);
  const right = Math.min(pageWidth, (staff.right ?? pageWidth) + margin);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };
}

/** 由音名与谱表几何推算符头在页面上的 y 坐标（精确值，不依赖识别引擎）。 */
export function yForPitch(step, octave, staff, clef) {
  const bottom = CLEF_BOTTOM[clef] || CLEF_BOTTOM.treble;
  // 每个自然音级（线↔间）对应半个线间距
  const steps = diatonicIndex(step, octave) - diatonicIndex(bottom.step, bottom.octave);
  return staff.bottom - steps * (staff.spacing / 2);
}

/** 整体移调：返回新数组，避免原地改动导致撤销困难。 */
export function transposeNotes(notes, semitones) {
  if (!semitones) return notes;
  return notes.map((note) => {
    if (!Number.isFinite(note.midi)) return { ...note };
    const midi = Math.min(127, Math.max(0, Math.round(note.midi) + semitones));
    const pitch = midiToPitchLabel(midi);
    return { ...note, midi, pitch };
  });
}

export function midiToPitchLabel(midi) {
  const table = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const value = Math.min(127, Math.max(0, Math.round(midi)));
  return `${table[value % 12]}${Math.floor(value / 12) - 1}`;
}

/**
 * 把逐谱表识别的结果拼成一份多声部乐谱。
 * - 同一系统内的谱表是并行声部
 * - 不同系统在时间上先后相接（后一系统的起拍加上前面各系统的总时长）
 *
 * @param {number[][]} systems 每个系统包含的谱表序号（自上而下）
 * @param {Map<number, object>} results 谱表序号 → { notes, clef, tempo, warnings }
 */
export function mergeSystemScores(systems, results) {
  const notes = [];
  const warnings = new Set();
  const partNames = [];
  let offsetBeats = 0;
  let tempo = 0;
  let measureCount = 0;
  let missing = 0;

  systems.forEach((system, systemIndex) => {
    let systemEnd = offsetBeats;
    system.forEach((staffIndex, positionInSystem) => {
      const result = results.get(staffIndex);
      const partId = `staff-${positionInSystem + 1}`;
      const partName = `第 ${positionInSystem + 1} 行谱表`;
      if (systemIndex === 0) partNames[positionInSystem] = partName;
      if (!result) {
        missing++;
        return;
      }
      // 整行休止 / 该声部尚未进入，属于正常的空谱表，不应报成"识别缺失"。
      if (result.empty) return;
      if (result.error || !result.notes || !result.notes.length) {
        missing++;
        return;
      }
      if (!tempo && result.tempo > 0) tempo = result.tempo;
      measureCount = Math.max(measureCount, result.measureCount || 0);
      for (const note of result.notes) {
        const startBeat = (Number(note.startBeat) || 0) + offsetBeats;
        notes.push({
          ...note, partId, partName, startBeat, voice: note.voice || "1", staff: "1",
          // 带上谱表几何与谱号，供界面把音符的音高画回对应谱线上（纵坐标可由音高精确推算）。
          staffIndex: result.staffIndex, clefName: result.clefName,
        });
        systemEnd = Math.max(systemEnd, startBeat + (Number(note.durationBeats) || 1));
      }
      for (const warning of result.warnings || []) warnings.add(warning);
    });
    offsetBeats = systemEnd;
  });

  if (missing) warnings.add(`${missing} 行谱表没有识别出音符，可在谱面上确认后手动补录。`);

  notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
  let eventId = -1;
  let previousBeat = Number.NaN;
  notes.forEach((note, index) => {
    if (!Number.isFinite(previousBeat) || Math.abs(note.startBeat - previousBeat) > 0.00001) {
      eventId++;
      previousBeat = note.startBeat;
    }
    note.eventId = eventId;
    note.id = `staff-${eventId}-${note.partId}-${note.midi}-${index}`;
    if (!note.duration) note.duration = "custom";
  });

  return {
    notes,
    warnings: [...warnings],
    partNames,
    tempo: tempo || 84,
    tempoDetected: Boolean(tempo),
    measureCount,
    // 本页总时长（拍），供跨页合并时把后一页整体平移。
    totalBeats: offsetBeats,
    systemCount: systems.length,
    staffCount: systems.reduce((sum, system) => sum + system.length, 0),
  };
}

/**
 * 把本机引擎识别结果的节奏「吸附」到拍号网格上（只改节奏，不改音高/声部）。
 *
 * 为什么需要：扫描谱识别出的时值常带零头（某小节 3.75 拍、某个音 0.375 拍），
 * 直接播放会「散」；而且扫描谱的拍号只印在第一页，后面各页的时值是引擎猜的。
 * 这里按拍号（如 4/4 = 每小节 4 拍）：
 *   · 起拍吸附到最近的网格（该声部最小时值 < 半拍就按 1/4 拍，否则按 1/2 拍）；
 *   · 时值改为「到下一个音（或小节末）的间隔」，且保留原时值的取整结果（短音不会被拉成长音）；
 *   · 同声部、同小节、同起拍、同音高的重复音去重。
 * 弱起小节不受影响：每个音都按它自己的「小节内相对位置」吸附，不假设第 1 小节是整小节。
 */
export function quantizeScoreRhythm(scoreInfo) {
  const matched = /^(\d+)\/(\d+)$/.exec(String((scoreInfo && scoreInfo.timeSummary) || ""));
  const measureBeats = matched ? (Number(matched[1]) * 4) / Number(matched[2]) : 4;
  if (!(measureBeats > 0) || !scoreInfo || !Array.isArray(scoreInfo.notes)) return scoreInfo;

  // 分组键要带上 voice/staff：钢琴这类多声部谱表里，两个声部同时进行时
  // 若按「声部 + 小节」一起量化，长音会被另一个声部的短音截断（听感是音莫名变短）。
  const groups = new Map();   // partId -> voice|staff|measure -> notes
  for (const note of scoreInfo.notes) {
    const measureKey = String(note.measure == null || note.measure === "" ? "?" : note.measure);
    const voiceKey = `${note.voice || "1"}|${note.staff || "1"}|${measureKey}`;
    if (!groups.has(note.partId)) groups.set(note.partId, new Map());
    const byMeasure = groups.get(note.partId);
    if (!byMeasure.has(voiceKey)) byMeasure.set(voiceKey, []);
    byMeasure.get(voiceKey).push(note);
  }

  const quantized = [];
  for (const byMeasure of groups.values()) {
    for (const notes of byMeasure.values()) {
      // 该组（同声部同小节）的网格：有比八分音符更短的音就用 1/4 拍，否则 1/2 拍。
      let smallest = Infinity;
      for (const note of notes) {
        const value = Number(note.durationBeats);
        if (Number.isFinite(value) && value > 0) smallest = Math.min(smallest, value);
      }
      const grid = smallest < 0.49 ? 0.25 : 0.5;
      const onsets = new Map();   // 吸附后的起拍 -> 该起拍上的音
      for (const note of notes) {
        const relative = relativeOffset(note, measureBeats);
        const snapped = Math.min(measureBeats - grid, Math.round(relative / grid) * grid);
        if (!onsets.has(snapped)) onsets.set(snapped, []);
        onsets.get(snapped).push(note);
      }
      const ordered = [...onsets.keys()].sort((a, b) => a - b);
      ordered.forEach((onset, index) => {
        const nextOnset = index + 1 < ordered.length ? ordered[index + 1] : measureBeats;
        const gap = Math.max(grid, nextOnset - onset);
        const seen = new Set();
        for (const note of onsets.get(onset)) {
          const key = note.midi + "@" + note.voice;
          if (seen.has(key)) continue;   // 同音高同起拍重复（引擎偶尔会把一个字读成两个音）
          seen.add(key);
          const original = Number(note.durationBeats);
          const rounded = Number.isFinite(original) && original > 0
            ? Math.max(grid, Math.round(original / grid) * grid)
            : gap;
          const duration = Math.min(gap, rounded);
          note.startBeat = (Number(note.startBeat) || 0) - relativeOffset(note, measureBeats) + onset;
          note.durationBeats = Number(duration.toFixed(4));
          quantized.push(note);
        }
      });
    }
  }
  // 保持最终的起拍顺序（播放/界面都按 startBeat 排）。
  quantized.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
  scoreInfo.notes = quantized;
  return scoreInfo;
}

/** 取这个音原来的「小节内相对起拍」；没有 startInMeasure 时用 startBeat 对拍号取模兜底。 */
function relativeOffset(note, measureBeats) {
  const raw = Number(note.startInMeasure);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(measureBeats, raw));
  const beat = Number(note.startBeat) || 0;
  return beat - Math.floor(beat / measureBeats) * measureBeats;
}
/** 一页识别结果的总时长（拍）。优先用解析出的总时长，缺省时用最后一个音符的结束拍兜底。 */
export function pageLengthBeats(page) {
  if (!page) return 0;
  if (Number.isFinite(page.totalBeats) && page.totalBeats > 0) return page.totalBeats;
  let end = 0;
  for (const note of page.notes || []) {
    end = Math.max(end, (Number(note.startBeat) || 0) + (Number(note.durationBeats) || 1));
  }
  return end;
}

/**
 * 把多页识别结果按页顺序拼成一份连续的多声部乐谱。
 *
 * 每页都是独立识别出来的：各页的小节序号都从 1 开始、起拍都从 0 开始。
 * 这里把后一页整体向后平移——起拍偏移 = 前面各页总时长之和，
 * 小节序号偏移 = 前面各页小节总数之和；同一 partId 在各页之间视为同一声部，
 * 因此各声部会自然地一页接一页延续下去。
 *
 * 拍号/调号只取第一页，避免中途出现属性重置导致时值换算错乱。
 *
 * @param {(object|null)[]} pages 每页的 scoreInfo（含 notes/measureCount/totalBeats）；
 *        某页识别失败时该位置传 null，合并结果会把它记入 failedPages。
 */
/**
 * 跨页合并。
 *
 * @param pages 每页的 scoreInfo（识别失败的页放 null）
 * @param skippedPages 可选：明确「跳过」的页码集合（例如混合谱里的简谱页）。
 *        这些页不算「识别失败」——它们本来就不该由五线谱流程处理，
 *        否则界面会同时报「第 N 页识别失败」和「第 N 页没有五线谱已跳过」，自相矛盾。
 */
export function mergePageScores(pages, skippedPages = null) {
  const notes = [];
  const warnings = new Set();
  const failedPages = [];
  const meterChanges = [];
  const symbolCounts = {};
  const systemStats = {};
  const wedgeMarks = [];
  let offsetBeats = 0;
  let offsetMeasures = 0;
  let first = null;

  pages.forEach((page, index) => {
    if (!page) {
      if (!(skippedPages && skippedPages.has(index + 1))) failedPages.push(index + 1);
      return;
    }
    if (!first) first = page;
    for (const note of page.notes || []) {
      const number = Number(note.measure);
      notes.push({
        ...note,
        startBeat: (Number(note.startBeat) || 0) + offsetBeats,
        measure: Number.isFinite(number) && note.measure !== "" ? String(number + offsetMeasures) : note.measure,
      });
    }
    for (const warning of page.warnings || []) warnings.add(warning);
    // 拍号变化（如第 54、66 小节转 6/4）：小节号随页面整体后移，与音符的 measure 处理一致。
    for (const change of page.meterChanges || []) {
      const measure = Number(change.measure);
      if (!Number.isFinite(measure)) continue;
      meterChanges.push({ ...change, measure: measure + offsetMeasures });
    }
    for (const [key, value] of Object.entries(page.symbolCounts || {})) {
      symbolCounts[key] = (symbolCounts[key] || 0) + (Number(value) || 0);
    }
    for (const [key, value] of Object.entries(page.systemStats || {})) {
      if (!Number.isFinite(Number(value))) continue;
      if (key === "roleCount" || key === "measureCount" || key === "totalBeats") continue;
      systemStats[key] = (systemStats[key] || 0) + Number(value);
    }
    // 渐强/渐弱记号：拍位随页面整体后移。
    for (const mark of page.wedgeMarks || []) {
      wedgeMarks.push({
        ...mark,
        startBeat: (Number(mark.startBeat) || 0) + offsetBeats,
        endBeat: (Number(mark.endBeat) || 0) + offsetBeats,
      });
    }
    offsetBeats += pageLengthBeats(page);
    offsetMeasures += page.measureCount || 0;
  });

  if (failedPages.length) warnings.add(`第 ${failedPages.join("、")} 页识别失败，未能并入结果。`);

  notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
  let eventId = -1;
  let previousBeat = Number.NaN;
  notes.forEach((note, index) => {
    if (!Number.isFinite(previousBeat) || Math.abs(note.startBeat - previousBeat) > 0.00001) {
      eventId++;
      previousBeat = note.startBeat;
    }
    note.eventId = eventId;
    note.id = `page-${eventId}-${note.partId}-${note.midi}-${index}`;
    if (!note.duration) note.duration = "custom";
  });

  return {
    notes,
    warnings: [...warnings],
    partNames: first && first.partNames ? [...first.partNames] : [],
    tempo: (first && first.tempo) || 84,
    // 速度是否是从谱面读到的（合并结果沿用第 1 页的判断）。
    tempoDetected: Boolean(first && first.tempoDetected),
    measureCount: offsetMeasures,
    totalBeats: offsetBeats,
    pageCount: pages.length,
    failedPages,
    timeSummary: summarizeMeterChanges(meterChanges, first ? first.timeSummary : ""),
    keySummary: first ? first.keySummary : "",
    clef: first ? first.clef : "",
    // 与前文一致：速度/力度只取第一页的记号，其余页视为延续。
    tempoMarks: first && first.tempoMarks ? [...first.tempoMarks] : [],
    dynamicsMarks: first && first.dynamicsMarks ? [...first.dynamicsMarks] : [],
    wedgeMarks,
    meterChanges,
    symbolCounts,
    systemStats,
    title: first ? first.title : "未命名乐谱",
  };
}

// ===== 逐系统识别（Audiveris 按「一行谱表」裁片识别）专用的纯函数 =====
//
// 背景：整页交给 Audiveris 时，一页里的多个系统会被它当成「同一声部的连续小节」，
// 于是 8 个声部（钢琴还被拆成两行）的小节互相对不上，播放就是「莫名其妙的空拍」。
// 现在改成：把每个系统单独裁出来识别（系统内所有声部自然对齐），再用下面这些函数
// 把小节号、拍位、声部名拼回去。这里只做纯计算，图片裁切/请求都在 app.js。

/** 拍号字符串（"4/4"、"6/8"、"3+2/8"）→ 每小节拍数。认不出时返回 0。 */
export function beatsPerMeter(timeSignature) {
  const matched = /^\s*(\d+(?:\+\d+)*)\s*\/\s*(\d+)\s*$/.exec(String(timeSignature || ""));
  if (!matched) return 0;
  const beats = matched[1].split("+").reduce((sum, value) => sum + (Number(value) || 0), 0);
  const beatType = Number(matched[2]);
  if (!(beats > 0) || !(beatType > 0)) return 0;
  return beats * 4 / beatType;
}

/**
 * 检测小节线：每行谱表里贯穿五线的竖线，再跨谱表聚类。
 *
 * 为什么需要：Audiveris 偶尔会把两条小节线之间看成一整个小节（实测《敕勒歌》最后一页
 * 4 小节被识别成 3 小节），拍位就会少算。小节线是纯几何、检测很稳，可以用来核对/纠正。
 *
 * @param {Uint8Array} binary 二值图（1=墨）
 * @param {number} width
 * @param {number} height
 * @param {{top:number,bottom:number}[]} staves 同一系统的谱表（自上而下）
 * @returns {{x:number, xStart:number, xEnd:number}[]} 小节线 x 坐标（升序）
 */
export function detectBarlines(binary, width, height, staves, options = {}) {
  if (!Array.isArray(staves) || !staves.length) return [];
  const supportRatio = Number.isFinite(options.supportRatio) ? options.supportRatio : 0.5;
  const mergeGap = Number.isFinite(options.mergeGap) ? options.mergeGap : 20;
  const perStaff = [];
  for (const staff of staves) {
    const top = Math.max(0, Math.round(staff.top) - 3);
    const bottom = Math.min(height - 1, Math.round(staff.bottom) + 3);
    const span = Math.max(1, Math.round(staff.bottom) - Math.round(staff.top) + 1);
    const best = new Int32Array(width);
    const run = new Int32Array(width);
    for (let y = top; y <= bottom; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (binary[row + x]) {
          run[x] += 1;
          if (run[x] > best[x]) best[x] = run[x];
        } else {
          run[x] = 0;
        }
      }
    }
    const threshold = span * 0.9;
    const columns = [];
    for (let x = 0; x < width; x++) {
      if (best[x] >= threshold) columns.push(x);
    }
    const groups = [];
    for (const x of columns) {
      const last = groups[groups.length - 1];
      if (last && x - last.xEnd <= 3) {
        last.xEnd = x;
        last.sum += x;
        last.count += 1;
      } else {
        groups.push({ xStart: x, xEnd: x, sum: x, count: 1 });
      }
    }
    perStaff.push(groups.map((group) => group.sum / group.count));
  }
  // 跨谱表聚类：真正的系统小节线在大多数谱表上都会出现；符干不会六行同时出现。
  const all = perStaff.flat().sort((left, right) => left - right);
  const clusters = [];
  for (const x of all) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.max <= 5) {
      last.items.push(x);
      last.max = x;
    } else {
      clusters.push({ items: [x], max: x });
    }
  }
  const needed = Math.max(2, Math.ceil(staves.length * supportRatio));
  const kept = [];
  for (const cluster of clusters) {
    if (cluster.items.length >= needed) {
      kept.push(cluster.items.reduce((sum, value) => sum + value, 0) / cluster.items.length);
    }
  }
  // 合并紧挨着的双线/加粗线（反复记号、终止线可能画成两条）
  const merged = [];
  for (const x of kept.sort((left, right) => left - right)) {
    const last = merged[merged.length - 1];
    if (last && x - last.max < mergeGap) {
      last.items.push(x);
      last.max = x;
    } else {
      merged.push({ items: [x], max: x });
    }
  }
  return merged.map((cluster) => {
    const values = cluster.items;
    const center = values.reduce((sum, value) => sum + value, 0) / values.length;
    const spread = Math.max(2, Math.max(...values) - Math.min(...values));
    return { x: center, xStart: center - spread / 2, xEnd: center + spread / 2 };
  });
}

const PART_ROLE_ALIASES = {
  soprano: ["soprano", "sop", "s.", "s", "女高", "女高音", "高音"],
  alto: ["alto", "alt", "a.", "a", "女低", "女中", "女低音", "中音"],
  tenor: ["tenor", "ten", "t.", "t", "男高", "男高音"],
  baritone: ["baritone", "bar.", "bari", "bar", "男中", "男中音"],
  bass: ["bass", "b.", "b", "男低", "男低音", "低音"],
  piano: ["piano", "pno.", "pno", "pn.", "钢琴", "伴奏", "钢伴", "piano accompaniment"],
  ocarina: ["ocarina", "陶笛"],
};
export const PART_ROLE_LABELS = {
  soprano: "Soprano", alto: "Alto", tenor: "Tenor", baritone: "Baritone",
  bass: "Bass", piano: "Piano", ocarina: "陶笛",
};

/**
 * 把谱面上的声部标签（S. / Alto / Bar. / 陶笛 / Pno. …）归一成稳定角色名。
 * 认不出的标签原样返回（去掉首尾空白），空标签返回空串。
 */
export function canonicalPartRole(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  // 去掉结尾的声部序号（"Soprano 1" → "soprano"）
  const normalized = raw.toLowerCase().replace(/\s*\d+\s*$/, "").replace(/\s+/g, " ").trim();
  for (const [role, aliases] of Object.entries(PART_ROLE_ALIASES)) {
    if (aliases.includes(normalized)) return PART_ROLE_LABELS[role];
  }
  return raw;
}

/**
 * 解析一个系统的声部名：优先用 PDF 文字层读到的谱面标签（自上而下），
 * 其次沿用上一系统/整曲已知的角色，最后退回识别引擎给的声部名。
 *
 * @param {string[]} labels 该系统自上而下的谱面标签
 * @param {string[]} fallbackRoles 之前系统已确定的角色名
 * @param {string[]} engineNames 识别引擎给出的声部名（兜底）
 * @param {number} partCount 本系统识别出的声部数
 * @returns {string[]} 长度 = partCount 的角色名
 */
export function resolveSystemRoles(labels, fallbackRoles, engineNames, partCount) {
  const count = Math.max(1, Number(partCount) || 1);
  const canonicalLabels = (Array.isArray(labels) ? labels : [])
    .map(canonicalPartRole)
    .filter(Boolean);
  if (canonicalLabels.length >= count) return canonicalLabels.slice(0, count);
  if (canonicalLabels.length) {
    // 标签少于声部数：能对上的先对上，对不上的用兜底名补齐。
    const roles = canonicalLabels.slice();
    const fallback = (fallbackRoles && fallbackRoles.length ? fallbackRoles : engineNames) || [];
    for (let index = roles.length; index < count; index++) {
      const candidate = canonicalPartRole(fallback[index] || "");
      roles.push(candidate || `声部 ${index + 1}`);
    }
    return roles;
  }
  if (fallbackRoles && fallbackRoles.length >= count) return fallbackRoles.slice(0, count);
  const engine = (engineNames || []).map((name) => canonicalPartRole(name));
  const seen = new Map();
  return Array.from({ length: count }, (_, index) => {
    let name = engine[index] || `声部 ${index + 1}`;
    // 识别引擎常把多个声部都叫 "Voice"：同名时加序号，避免界面上认不出。
    const used = (seen.get(name) || 0) + 1;
    seen.set(name, used);
    if (used > 1) name = `${name} ${used}`;
    return name;
  });
}

/** 从 "4/4" / "6/4（第 54 小节）" / "拍号未标明" 里取出纯拍号；取不到返回空串。 */
function normalizeMeter(value) {
  const matched = /(\d+(?:\+\d+)*)\s*\/\s*(\d+)/.exec(String(value || ""));
  return matched ? `${matched[1]}/${matched[2]}` : "";
}

/**
 * 把多个「逐系统识别」结果拼成一页（或一首）乐谱。
 *
 * 关键规则：
 *  - 同一系统内的各声部并行（起拍相同）；不同系统在时间上首尾相接；
 *  - 小节长度优先用**印刷拍号**（meterMap），其次用识别结果推算的长度；
 *  - 小节号从 options.measureBase 开始连续编号；弱起小节记为它的前一号（0）；
 *  - 声部名用谱面标签（labels）归一，全局声部标识固定为 P1..Pn，
 *    这样跨页合并时同名声部（钢琴）不会被拆成两个。
 *
 * @param {Array} systems 每个系统：
 *   { scoreInfo, labels?: string[], meterMap?: string[]|null, measureCount?: number|null,
 *     anchorBar?: number|null, isFirstSystemOfPiece?: boolean }
 * @param {{measureBase?: number, beatBase?: number, fallbackRoles?: string[]}} [options]
 */
export function assembleSystemScores(systems, options = {}) {
  const measureBaseStart = Number.isFinite(options.measureBase) ? options.measureBase : 1;
  const beatBaseStart = Number.isFinite(options.beatBase) ? options.beatBase : 0;
  const fallbackRoles = Array.isArray(options.fallbackRoles) ? [...options.fallbackRoles] : [];
  // 整本识别时，每页各报一次「补了几个小节 / 多少音超出小节」会刷屏；
  // 传 true 时先不报，等跨页合并后按全曲总数说一次。
  const deferStatsWarnings = Boolean(options.deferStatsWarnings);
  const notes = [];
  const warnings = new Set();
  const tempoMarks = [];
  const dynamicsMarks = [];
  const wedgeMarks = [];
  const meterChanges = [];
  const symbolCounts = {};
  const stats = {
    systemCount: 0, appendedMeasures: 0, trimmedMeasures: 0,
    overflowNotes: 0, roleCount: 0, measureCount: 0, totalBeats: 0,
  };
  let partNames = [];
  let beatOffset = beatBaseStart;
  let nextMeasureNumber = measureBaseStart;
  let firstMeter = "";
  let runningMeter = "";
  let keySummary = "";
  let timeSummary = "";
  let clef = "";
  let title = "";
  let systemIndex = 0;

  for (const system of systems) {
    if (!system || !system.scoreInfo) continue;
    const info = system.scoreInfo;
    const engineNames = info.partNames || [];
    const partCount = Math.max(1, engineNames.length || 1);
    const roles = resolveSystemRoles(system.labels, fallbackRoles, engineNames, partCount);
    if (!fallbackRoles.length) fallbackRoles.push(...roles);
    if (!partNames.length) { partNames = [...roles]; stats.roleCount = partCount; }
    if (!title) title = info.title || "";
    if (!clef) clef = info.clef || "";
    if (!keySummary) keySummary = info.keySummary || "";

    const parsedMeasures = Array.isArray(info.measures) ? info.measures : [];
    const parsedCount = parsedMeasures.length || Math.max(0, Number(info.measureCount) || 0);
    let authoritative = Number.isFinite(system.measureCount) && system.measureCount > 0
      ? Math.round(system.measureCount) : parsedCount;
    if (!authoritative) authoritative = Math.max(1, parsedCount);
    if (authoritative < parsedCount) { stats.trimmedMeasures += parsedCount - authoritative; }
    if (authoritative > parsedCount) { stats.appendedMeasures += authoritative - parsedCount; }

    const meterMap = Array.isArray(system.meterMap) && system.meterMap.length >= authoritative
      ? system.meterMap : null;
    const isFirstSystem = systemIndex === 0;
    const pickup = Boolean(isFirstSystem && parsedMeasures[0] && parsedMeasures[0].implicit);
    const pickupBeats = pickup ? Math.max(0, Number(parsedMeasures[0].lengthBeats) || 0) : 0;

    // 权威的小节长度表（用印刷拍号优先，弱起小节用识别出的实际长度）
    const measureLengths = [];
    let lastLength = 0;
    for (let index = 0; index < authoritative; index++) {
      const parsed = parsedMeasures[index];
      const meter = meterMap ? meterMap[index] : "";
      let length = 0;
      if (pickup && index === 0) length = pickupBeats;
      else if (meter) length = beatsPerMeter(meter);
      else if (parsed && parsed.lengthBeats > 0) length = parsed.lengthBeats;
      else length = lastLength || beatsPerMeter(timeSummary) || 4;
      measureLengths.push(length);
      lastLength = length;
    }
    const localBase = [];
    let running = 0;
    for (const length of measureLengths) {
      localBase.push(running);
      running += length;
    }
    const systemBeats = running;

    // 小节号基准：弱起小节记 0（第一小节号 1 之前的第 0 小节）
    const labelBase = pickup ? nextMeasureNumber - 1 : nextMeasureNumber;
    const firstMeasureNumber = parsedMeasures.length ? Number(parsedMeasures[0].number) : 1;
    const localIndexFor = (note) => {
      const number = Number(note.measure);
      if (!Number.isFinite(number)) return 0;
      const first = Number.isFinite(firstMeasureNumber) ? firstMeasureNumber : 1;
      const index = number - first;
      if (index < 0) return 0;
      return Math.min(authoritative - 1, index);
    };
    // 识别引擎的声部顺序 = partIds/partNames 的顺序；音符按 partId 归到 P1..Pn。
    // （不能用「音符里第一次出现的顺序」：某个声部整段休止时没有音符，会让后面所有声部错位。）
    const mappedPartIds = Array.isArray(info.partIds) && info.partIds.length
      ? info.partIds
      : info.partNames.map((_, index) => `part-${index + 1}`);
    const partRoleByPartId = new Map();
    mappedPartIds.forEach((partId, index) => {
      const roleIndex = Math.min(index, Math.max(0, roles.length - 1));
      partRoleByPartId.set(partId, {
        partId: `P${roleIndex + 1}`,
        partName: roles[roleIndex] || `声部 ${roleIndex + 1}`,
      });
    });

    const systemStartBeat = beatOffset;
    const systemEndBeat = beatOffset + systemBeats;
    for (const note of info.notes) {
      const localIndex = localIndexFor(note);
      const measureLength = measureLengths[localIndex] || 0;
      const startInMeasure = Number(note.startInMeasure);
      const safeStart = Number.isFinite(startInMeasure) ? Math.max(0, startInMeasure) : 0;
      if (measureLength > 0 && safeStart >= measureLength - 0.0001) stats.overflowNotes++;
      const mapping = partRoleByPartId.get(note.partId) || {
        partId: "P1", partName: roles[0] || "声部 1",
      };
      const startBeat = systemStartBeat + localBase[localIndex] + safeStart;
      const measureLabel = labelBase + localIndex;
      notes.push({
        ...note,
        partId: mapping.partId,
        partName: mapping.partName,
        measure: String(measureLabel),
        startBeat,
        measureIndex: localIndex,
      });
    }
    // 记号：拍位平移；只保留落在本系统范围内的（被裁掉的小节里的记号丢掉）。
    // 速度值做合理性过滤：OCR 偶尔把 "♩=68" 读成 6/8 之类（实测单页识别 p1 读到 6），
    // 不合理的速度（<20 或 >320）不放进结果，交给后面的 PDF 文字层/OCR 兜底。
    for (const mark of info.tempoMarks || []) {
      const bpm = Number(mark.bpm);
      if (!(bpm >= 20 && bpm <= 320)) continue;
      if (mark.beat <= systemBeats + 0.0001) tempoMarks.push({ ...mark, bpm, beat: mark.beat + systemStartBeat });
    }
    for (const mark of info.dynamicsMarks || []) {
      if (mark.beat <= systemBeats + 0.0001) dynamicsMarks.push({ ...mark, beat: mark.beat + systemStartBeat });
    }
    for (const mark of info.wedgeMarks || []) {
      const start = Number(mark.startBeat) || 0;
      const end = Number(mark.endBeat) || start;
      if (start > systemBeats + 0.0001) continue;
      wedgeMarks.push({
        ...mark,
        startBeat: start + systemStartBeat,
        endBeat: Math.min(end, systemBeats) + systemStartBeat,
      });
    }
    for (const [key, value] of Object.entries(info.symbolCounts || {})) {
      symbolCounts[key] = (symbolCounts[key] || 0) + (Number(value) || 0);
    }
    // 拍号变化记录（优先用印刷拍号；没有就沿用上一小节/上一系统）
    let meterCursor = normalizeMeter(runningMeter) || normalizeMeter(info.timeSummary);
    const meters = [];
    for (let index = 0; index < authoritative; index++) {
      const mapped = meterMap ? normalizeMeter(meterMap[index]) : "";
      if (mapped) meterCursor = mapped;
      meters.push(meterCursor);
    }
    for (let index = 0; index < meters.length; index++) {
      const meter = meters[index];
      if (!meter) continue;
      if (!firstMeter) firstMeter = meter;
      const previous = index === 0 ? normalizeMeter(runningMeter) : meters[index - 1];
      if (meter !== previous) meterChanges.push({ measure: labelBase + index, meter });
    }
    if (meters.length) runningMeter = meters[meters.length - 1] || meterCursor;
    if (info.timeSummary && !timeSummary) timeSummary = info.timeSummary;
    for (const warning of info.warnings || []) warnings.add(warning);

    beatOffset = systemEndBeat;
    nextMeasureNumber += authoritative - (pickup ? 1 : 0);
    stats.measureCount = nextMeasureNumber - measureBaseStart;
    stats.systemCount += 1;
    systemIndex += 1;
  }

  stats.totalBeats = beatOffset - beatBaseStart;
  if (!partNames.length && fallbackRoles.length) partNames = [...fallbackRoles];
  if (!deferStatsWarnings && stats.trimmedMeasures) warnings.add(`有 ${stats.trimmedMeasures} 个多识别出来的小节没有并入结果（已按印刷小节线为准）。`);
  if (!deferStatsWarnings && stats.appendedMeasures) warnings.add(`原谱比识别结果多 ${stats.appendedMeasures} 个小节（识别漏读了小节线），已按印刷拍号补齐空小节。`);
  if (!deferStatsWarnings && stats.overflowNotes) warnings.add(`有 ${stats.overflowNotes} 个音符超出了一小节的范围（识别误差），试听时它们会挤到下一小节开头。`);

  const sorted = notes.sort((left, right) => left.startBeat - right.startBeat || left.midi - right.midi);
  let eventId = -1, previousBeat = Number.NaN;
  sorted.forEach((note, index) => {
    if (!Number.isFinite(previousBeat) || Math.abs(note.startBeat - previousBeat) > 0.00001) {
      eventId++;
      previousBeat = note.startBeat;
    }
    note.eventId = eventId;
    note.id = `system-${eventId}-${note.partId}-${note.midi}-${index}`;
    if (!note.duration) note.duration = "custom";
  });

  const mergedTempo = tempoMarks.sort((left, right) => left.beat - right.beat);
  const mergedDynamics = dynamicsMarks.sort((left, right) => left.beat - right.beat);
  const mergedWedges = wedgeMarks.sort((left, right) => left.startBeat - right.startBeat);
  const summary = summarizeMeterChanges(meterChanges, firstMeter || timeSummary);
  return {
    notes: sorted,
    warnings: [...warnings],
    partNames,
    tempo: mergedTempo.find((mark) => mark.beat <= 0.00001)?.bpm || 84,
    tempoDetected: mergedTempo.length > 0,
    measureCount: stats.measureCount,
    totalBeats: stats.totalBeats,
    timeSummary: summary,
    keySummary,
    clef,
    title: title || "未命名乐谱",
    tempoMarks: mergedTempo,
    dynamicsMarks: mergedDynamics,
    wedgeMarks: mergedWedges,
    meterChanges,
    symbolCounts,
    // 组装统计：界面上如实告诉用户「几个系统 / 补了几个空小节 / 拍号变化在哪」。
    systemStats: { ...stats },
  };
}

/**
 * 把「第几小节换成了什么拍号」整理成一句中文说明。
 * 例：主拍号 4/4、第 54/66 小节为 6/4 → "4/4（第 54、66 小节为 6/4）"
 */
export function summarizeMeterChanges(changes, fallback = "") {
  const list = (Array.isArray(changes) ? changes : [])
    .map((change) => ({ measure: Number(change.measure), meter: String(change.meter || "") }))
    .filter((change) => Number.isFinite(change.measure) && change.meter);
  if (!list.length) return fallback || "拍号未标明";
  const primary = list[0].meter;
  const byMeter = new Map();
  for (const change of list) {
    if (change.meter === primary) continue;
    if (!byMeter.has(change.meter)) byMeter.set(change.meter, []);
    if (!byMeter.get(change.meter).includes(change.measure)) byMeter.get(change.meter).push(change.measure);
  }
  if (!byMeter.size) return primary;
  const groups = [];
  for (const [meter, measures] of byMeter) {
    const sorted = [...measures].sort((left, right) => left - right);
    groups.push(`第 ${sorted.join("、")} 小节为 ${meter}`);
  }
  return `${primary}（${groups.join("；")}）`;
}

/**
 * 把 PDF 文字层的排版信息（声部标签 / 印刷小节号 / 拍号字形）落到「逐系统」识别任务上。
 *
 * 输入坐标统一用**识谱图的像素**（调用方先把 PDF 点坐标乘以缩放比），这样和谱表几何、
 * 小节线检测在同一个坐标系里；输出每个系统：
 *  - roles：谱面标签（自上而下），供装配时给声部起名；
 *  - anchorBar：这一系统第一小节的印刷小节号（没有印就是 null）；
 *  - measureCount：这个系统应该是几小节（优先用「下一系统的印刷小节号 - 本系统小节号」，
 *    这是最可靠的；没有就数小节线）；
 *  - meterMap：逐小节拍号（变拍子靠 PDF 文字层里的拍号字形 + 小节线定位）。
 *
 * @param {{labels?:object[], bars?:object[], timeGlyphs?:object[]}} pageLayout
 * @param {{top:number,bottom:number,firstStaffTop:number,lastStaffBottom:number,barlines?:object[]}[]} systems
 * @returns {object[]} 与 systems 同序的元数据
 */
export function assignLayoutToSystems(pageLayout, systems, options = {}) {
  const layout = pageLayout || {};
  const labels = Array.isArray(layout.labels) ? layout.labels : [];
  const bars = Array.isArray(layout.bars) ? layout.bars : [];
  const glyphs = Array.isArray(layout.timeGlyphs) ? layout.timeGlyphs : [];
  const result = systems.map((system) => {
    const firstTop = Number.isFinite(system.firstStaffTop) ? system.firstStaffTop : system.top;
    const lastBottom = Number.isFinite(system.lastStaffBottom) ? system.lastStaffBottom : system.bottom;
    // 1) 声部标签：纵坐标落在本系统范围内（含轻微超出：钢琴标签在两根谱表中间）。
    const near = labels
      .map((label) => ({ ...label, centerY: (Number(label.y) || 0) + (Number(label.height) || 0) / 2 }))
      .filter((label) => label.centerY >= Math.min(firstTop, system.top) - 8 && label.centerY <= Math.max(lastBottom, system.bottom) + 8)
      .sort((left, right) => left.centerY - right.centerY || left.x - right.x);
    const roles = near.map((label) => String(label.text || "").trim()).filter(Boolean);
    // 2) 印刷小节号：印在第一行谱表上方约 10–140px 处。
    let anchorBar = null;
    let anchorDistance = Infinity;
    for (const bar of bars) {
      const y = Number(bar.y) || 0;
      const distance = firstTop - y;
      if (distance >= 5 && distance <= 150 && distance < anchorDistance) {
        anchorBar = Number(bar.bar);
        anchorDistance = distance;
      }
    }
    // 3) 拍号字形：先看字形是否属于本系统，再按「左侧有几条小节线」定位到第几小节。
    const barlines = (Array.isArray(system.barlines) ? system.barlines : [])
      .map((barline) => (typeof barline === "number" ? barline : Number(barline.x)))
      .filter((x) => Number.isFinite(x))
      .sort((left, right) => left - right);
    const inSystem = glyphs
      .map((glyph) => ({ ...glyph, centerY: (Number(glyph.y) || 0) + (Number(glyph.height) || 0) / 2 }))
      .filter((glyph) => glyph.centerY >= system.top && glyph.centerY <= system.bottom)
      .sort((left, right) => left.x - right.x);
    const changes = [];
    for (const glyph of inSystem) {
      const meter = String(glyph.meter || "");
      if (!/^\d+(?:\+\d+)*\/\d+$/.test(meter)) continue;
      let measureIndex = 0;
      for (const x of barlines) {
        if (x < glyph.x - 2) measureIndex += 1;
      }
      measureIndex = Math.max(0, measureIndex - 1);
      if (!changes.some((change) => change.measureIndex === measureIndex && change.meter === meter)) {
        changes.push({ measureIndex, meter });
      }
    }
    // 同一小节重复出现的拍号字形（每行谱表各印一次）只留第一次。
    changes.sort((left, right) => left.measureIndex - right.measureIndex);
    return {
      labels: roles,
      anchorBar,
      changes,
      barlineCount: barlines.length,
      measureCount: barlines.length > 1 ? barlines.length - 1 : null,
    };
  });
  // 4) 权威小节数：优先数小节线（同一系统内的线，不受「中间跳过简谱页」影响）；
  //    小节线检测不到时才退回「相邻印刷小节号之差」。
  for (let index = 0; index < result.length; index++) {
    const current = result[index];
    const next = result[index + 1];
    current.anchorMeasureCount = (current.anchorBar != null && next && next.anchorBar != null && next.anchorBar > current.anchorBar)
      ? next.anchorBar - current.anchorBar
      : null;
    if (!(Number(current.measureCount) > 0) && current.anchorMeasureCount) {
      current.measureCount = current.anchorMeasureCount;
    }
  }
  // 5) 逐小节拍号表：把「第几小节开始变拍号」摊平成每个小节一项，并跨系统延续。
  // initialMeter：单页识别时，本页可能整页都没印拍号（拍号只在第 1 页印），
  // 用整曲已知的主拍号起步，就不会让 Audiveris 的猜测（如把 4/4 猜成 6/4）带偏。
  let runningMeter = normalizeMeter(options.initialMeter);
  for (const item of result) {
    const count = Math.max(0, Number(item.measureCount) || 0);
    const meterMap = [];
    if (count) {
      let meter = runningMeter;
      const changeAt = new Map(item.changes.map((change) => [change.measureIndex, change.meter]));
      for (let index = 0; index < count; index++) {
        if (changeAt.has(index)) meter = changeAt.get(index);
        meterMap.push(meter || "");
      }
      if (meter) runningMeter = meter;
    }
    item.meterMap = meterMap;
  }
  return result;
}
