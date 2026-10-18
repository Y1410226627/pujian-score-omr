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

  const groups = new Map();   // partId -> measureKey -> notes
  for (const note of scoreInfo.notes) {
    const measureKey = String(note.measure == null || note.measure === "" ? "?" : note.measure);
    if (!groups.has(note.partId)) groups.set(note.partId, new Map());
    const byMeasure = groups.get(note.partId);
    if (!byMeasure.has(measureKey)) byMeasure.set(measureKey, []);
    byMeasure.get(measureKey).push(note);
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
    timeSummary: first ? first.timeSummary : "",
    keySummary: first ? first.keySummary : "",
    clef: first ? first.clef : "",
    // 与前文一致：速度/力度只取第一页的记号，其余页视为延续。
    tempoMarks: first && first.tempoMarks ? [...first.tempoMarks] : [],
    dynamicsMarks: first && first.dynamicsMarks ? [...first.dynamicsMarks] : [],
    title: first ? first.title : "未命名乐谱",
  };
}
