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
 * 扫描整页的「长竖线」：系统起始小节线、方括号/大括号的竖笔画、钢琴跨行的小节线。
 * 返回每根竖线的 x 范围与 y 范围（同一根线跨 2–4 列像素，这里合并成一条）。
 *
 * 为什么不用固定像素间隔分系统：缩编合唱谱的版面很不规整（一页里可能有
 * 钢琴独奏 2 行、Solo+piano 3 行、四声部+钢琴 6 行混排），系统内谱表间距
 * 有时反而比系统之间的间距还大（《绒花》第 2 页：系统内 199px、系统间 216px），
 * 靠间距阈值怎么调都会切错。谱表的「连接关系」才是可靠依据。
 */
export function detectVerticalGuides(binary, width, height, minLength = 0) {
  const runs = [];
  for (let x = 0; x < width; x++) {
    let start = -1;
    for (let y = 0; y < height; y++) {
      if (binary[y * width + x]) {
        if (start < 0) start = y;
      } else if (start >= 0) {
        if (y - start >= minLength) runs.push({ x, y0: start, y1: y - 1 });
        start = -1;
      }
    }
    if (start >= 0 && height - start >= minLength) runs.push({ x, y0: start, y1: height - 1 });
  }
  // 按 x 排序后合并「相邻列上 y 范围重叠」的线段（线宽一般 2–4 像素）。
  runs.sort((left, right) => left.x - right.x || left.y0 - right.y0);
  const guides = [];
  for (const run of runs) {
    let merged = null;
    for (let index = guides.length - 1; index >= 0; index--) {
      const guide = guides[index];
      if (guide.xEnd < run.x - 3) continue;
      if (run.y1 >= guide.y0 - 3 && run.y0 <= guide.y1 + 3) { merged = guide; break; }
    }
    if (merged) {
      merged.xEnd = run.x;
      merged.y0 = Math.min(merged.y0, run.y0);
      merged.y1 = Math.max(merged.y1, run.y1);
    } else {
      guides.push({ xStart: run.x, xEnd: run.x, y0: run.y0, y1: run.y1 });
    }
  }
  return guides;
}

/**
 * 把谱表按「系统」分组：同一系统内的谱表在时间上并行，不同系统在时间上先后相接。
 *
 * 判据是**竖线连接**，不是间距阈值：同一系统里的谱表会被一条竖线（系统起始小节线、
 * 方括号的竖笔画、钢琴两行之间的连谱小节线）从上到下贯穿；不同系统之间没有这样的竖线。
 * 找不到任何连接时退回按间距切分（groupSystems），保证没有括号/贯通线的谱也能用。
 *
 * @param {Uint8Array} binary 二值图（1=墨）
 * @param {number} width
 * @param {number} height
 * @param {{top:number,bottom:number,spacing?:number}[]} staves 已检测到的谱表
 * @returns {{top:number,bottom:number,spacing?:number}[][]} 与 groupSystems 同形（按 y 从上到下）
 */
export function detectSystems(binary, width, height, staves) {
  const ordered = [...staves].sort((left, right) => left.top - right.top);
  if (ordered.length <= 1) return ordered.length ? [ordered] : [];
  const heights = ordered.map((staff) => staff.bottom - staff.top).filter((value) => value > 0);
  const medianHeight = medianOf(heights) || 40;
  // 能贯穿两行谱表的竖线至少有这么长（一行谱表的高度 + 少许余量）。
  const minLength = Math.max(24, medianHeight * 1.5);
  const guides = detectVerticalGuides(binary, width, height, minLength);

  const parent = ordered.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left), rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  let links = 0;
  for (const guide of guides) {
    const covered = [];
    for (let index = 0; index < ordered.length; index++) {
      const staff = ordered[index];
      const tolerance = Math.max(18, (Number(staff.spacing) || 10) * 2.5);
      if (staff.top >= guide.y0 - tolerance && staff.bottom <= guide.y1 + tolerance) covered.push(index);
    }
    if (covered.length < 2) continue;
    const first = ordered[covered[0]];
    const last = ordered[covered[covered.length - 1]];
    const toleranceUp = Math.max(36, (Number(first.spacing) || 10) * 4);
    const toleranceDown = Math.max(36, (Number(last.spacing) || 10) * 4);
    // 竖线必须「起于本组第一行谱表附近、止于最后一行谱表附近」。
    // 否则可能是贯穿整页的页边框线——那会把上下两个系统错误地连成一个。
    if (guide.y0 < first.top - toleranceUp) continue;
    if (guide.y1 > last.bottom + toleranceDown) continue;
    for (let index = 1; index < covered.length; index++) {
      union(covered[index - 1], covered[index]);
      links += 1;
    }
  }
  if (!links) return groupSystems(ordered);

  const groups = new Map();
  for (let index = 0; index < ordered.length; index++) {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(ordered[index]);
  }
  const systems = [...groups.values()].sort((left, right) => left[0].top - right[0].top);
  // 偶尔有谱表没被任何竖线覆盖（竖线检测漏了）：并进上下间隔更近的相邻系统，
  // 否则它会被当成一个「只有一行谱表的系统」在时间上插到别的系统中间，声部就全错位了。
  const internalGaps = [];
  for (const system of systems) {
    for (let index = 1; index < system.length; index++) internalGaps.push(system[index].top - system[index - 1].bottom);
  }
  const medianInternal = medianOf(internalGaps.filter((gap) => gap > 0));
  const mergeLimit = Math.max(2.2 * medianHeight, (medianInternal || 0) * 1.6);
  const mergedSystems = [];
  for (let index = 0; index < systems.length; index++) {
    const system = systems[index];
    if (system.length === 1) {
      const previous = mergedSystems[mergedSystems.length - 1];
      const next = systems[index + 1];
      const previousGap = previous ? system[0].top - previous[previous.length - 1].bottom : Infinity;
      const nextGap = next ? next[0].top - system[0].bottom : Infinity;
      if (previousGap > 0 && previousGap <= mergeLimit && previousGap <= nextGap) {
        previous.push(...system);
        continue;
      }
      if (nextGap > 0 && nextGap <= mergeLimit) {
        next.unshift(...system);
        continue;
      }
    }
    mergedSystems.push([...system]);
  }
  return mergedSystems;
}

/**
 * 把谱表按"系统"分组：同一系统内的谱表在时间上并行，不同系统在时间上先后相接。
 * 依据是谱表之间的空白高度——系统之间的空白明显更大。
 *
 * 注意：这是**兜底**算法。真实雕版谱的版面常常不规整（系统内间距可能大于系统间距），
 * 优先用 detectSystems() 的竖线连接判据。
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
 * 这里按**每个小节自己的拍号**（scoreInfo.meterChanges；没有时用整曲拍号）：
 *   · 起拍吸附到最近的网格（该声部最小时值 < 半拍就按 1/4 拍，否则按 1/2 拍）；
 *   · 时值改为「到下一个音（或小节末）的间隔」，且保留原时值的取整结果（短音不会被拉成长音）；
 *   · 同声部、同小节、同起拍、同音高的重复音去重。
 * 弱起小节不受影响：每个音都按它自己的「小节内相对位置」吸附，不假设第 1 小节是整小节。
 *
 * 逐小节拍号很重要：以前这里用整曲拍号（4/4）算所有小节，6/4 小节的第 5、6 拍音会被
 * `Math.min(measureBeats - grid, …)` 压到第 4 拍附近，听觉上就是「变拍子处节奏不对 + 后面莫名空拍」。
 */
export function quantizeScoreRhythm(scoreInfo) {
  const matched = /^(\d+)\/(\d+)$/.exec(String((scoreInfo && scoreInfo.timeSummary) || ""));
  const defaultBeats = matched ? (Number(matched[1]) * 4) / Number(matched[2]) : 4;
  if (!(defaultBeats > 0) || !scoreInfo || !Array.isArray(scoreInfo.notes)) return scoreInfo;
  // 逐小节拍号表（scoreInfo.meterChanges 是跨页合并后带全局小节号的）。按小节号缓存查询结果。
  const meterChanges = (Array.isArray(scoreInfo.meterChanges) ? scoreInfo.meterChanges : [])
    .map((change) => ({ measure: Number(change.measure), beats: beatsPerMeter(change.meter) }))
    .filter((change) => Number.isFinite(change.measure) && change.beats > 0)
    .sort((left, right) => left.measure - right.measure);
  const beatsCache = new Map();
  const measureBeatsFor = (measureText) => {
    if (!meterChanges.length) return defaultBeats;
    const measureNumber = Number(measureText);
    if (!Number.isFinite(measureNumber)) return defaultBeats;
    if (beatsCache.has(measureNumber)) return beatsCache.get(measureNumber);
    let beats = defaultBeats;
    for (const change of meterChanges) {
      if (change.measure <= measureNumber) beats = change.beats;
      else break;
    }
    beatsCache.set(measureNumber, beats);
    return beats;
  };

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
    for (const [voiceKey, notes] of byMeasure) {
      const measureBeats = measureBeatsFor(voiceKey.slice(voiceKey.lastIndexOf("|") + 1));
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
        // 超过小节长度（识别误差）的音：留在原小节里、不挪到小节外，也不压到小节最后抢拍。
        const snapped = relative > measureBeats
          ? Math.round(relative / grid) * grid
          : Math.min(measureBeats - grid, Math.round(relative / grid) * grid);
        if (!onsets.has(snapped)) onsets.set(snapped, []);
        onsets.get(snapped).push(note);
      }
      const ordered = [...onsets.keys()].sort((a, b) => a - b);
      ordered.forEach((onset, index) => {
        // 正常情况：时值补到下一个音/小节末；超出小节的识别误差音不压缩到 0。
        const nextOnset = index + 1 < ordered.length
          ? ordered[index + 1]
          : Math.max(measureBeats, onset + grid);
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

/** 取这个音原来的「小节内相对起拍」；没有 startInMeasure 时用 startBeat 对拍号取模兜底。
 *  故意不把上限压到小节长度：识别误差可能出现「超出小节」的起拍，量化时要让它留在原位而不是挤到小节末尾。 */
function relativeOffset(note, measureBeats) {
  const raw = Number(note.startInMeasure);
  if (Number.isFinite(raw)) return Math.max(0, raw);
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
  // 调号变化（变调）：跨页累加并按小节号平移（《绒花》：Ab → 第 9 小节 F → 第 86 小节 Ab）。
  const keyChanges = [];
  const symbolCounts = {};
  const systemStats = {};
  const wedgeMarks = [];
  const tempoMarks = [];
  let offsetBeats = 0;
  let offsetMeasures = 0;
  let first = null;
  // 当前生效的拍号（跨页延续）：每页装配时「本页主拍号」也会被记成一条变化，
  // 若与上一页结尾的拍号相同，那只是重复记录、不是真的变拍子（否则速度说明会出现
  // 「6/8（第 16、32、43…小节为 2/4）」这样一长串假的变拍子）。
  let runningMeter = "";
  // 当前生效的调号：与拍号同理，跨页延续的同一调号不重复记录。
  let runningKey = "";
  // 上一次记录的速度值：连续相同的速度标记只保留第一次（每页开头常重复印速度）。
  let lastTempoBpm = Number.NaN;

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
      const meter = String(change.meter || "");
      if (!meter) continue;
      if (meter === runningMeter) continue;   // 与上一页结尾相同 → 不是真的变拍号
      meterChanges.push({ ...change, measure: measure + offsetMeasures, meter });
      runningMeter = meter;
    }
    // 调号变化（变调）：小节号随页面整体后移；与上一页结尾相同的调号不算变化。
    for (const change of page.keyChanges || []) {
      const measure = Number(change.measure);
      const key = String(change.key || "");
      if (!Number.isFinite(measure) || !key) continue;
      if (key === runningKey) continue;
      keyChanges.push({ measure: measure + offsetMeasures, key });
      runningKey = key;
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
    // 速度标记：以前只取第 1 页的，后面页面的「中途变速」（如第 78 小节 ♩=72）会被丢掉。
    // 现在按页面拍位偏移累加；与上一次速度相同的标记只留第一次（每页开头常重复印速度）。
    for (const mark of page.tempoMarks || []) {
      const bpm = Number(mark.bpm);
      const beat = Number(mark.beat);
      if (!(bpm >= 20 && bpm <= 320) || !Number.isFinite(beat)) continue;
      if (Number.isFinite(lastTempoBpm) && Math.abs(lastTempoBpm - bpm) < 0.5) continue;
      tempoMarks.push({ ...mark, beat: beat + offsetBeats, bpm });
      lastTempoBpm = bpm;
    }
    offsetBeats += pageLengthBeats(page);
    offsetMeasures += page.measureCount || 0;
  });

  tempoMarks.sort((left, right) => left.beat - right.beat);

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
    partIds: first && first.partIds
      ? [...first.partIds]
      : (first && first.partNames ? first.partNames.map((_, index) => `P${index + 1}`) : []),
    // 起始速度：全曲第一个速度标记优先（第 1 页没印、第 2 页才印的情况也能用上）；
    // 一个标记都没有时沿用第 1 页的速度判断。
    tempo: tempoMarks.length ? tempoMarks[0].bpm : ((first && first.tempo) || 84),
    tempoDetected: tempoMarks.length > 0 || Boolean(first && first.tempoDetected),
    measureCount: offsetMeasures,
    totalBeats: offsetBeats,
    pageCount: pages.length,
    failedPages,
    timeSummary: summarizeMeterChanges(meterChanges, first ? first.timeSummary : ""),
    keySummary: summarizeKeyChanges(keyChanges, first ? first.keySummary : ""),
    clef: first ? first.clef : "",
    // 速度/力度：速度标记现在跨页累加（中途变速都在），力度仍沿用「第 1 页起延续」。
    tempoMarks,
    dynamicsMarks: first && first.dynamicsMarks ? [...first.dynamicsMarks] : [],
    wedgeMarks,
    meterChanges,
    keyChanges,
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
 * 判断 x 附近、y 范围内有没有「横符杠」：一段长度 ≥ 1.8 个谱表间距的连续横线。
 *
 * 用来排除「符干冒充小节线」：缩编合唱谱里各声部节奏常完全对齐，同一拍的符干在
 * 好几行谱表上落在同一个 x；当这些音符带符杠、且符干贯穿整行谱表时，逐行检测会把它
 * 当成一条「六行都有」的小节线（实测《绒花》第 5、9 页因此多出 3 个小节）。
 * 真小节线上下的空白处没有这样的横线，符干的顶端却连着符杠。
 */
function hasHorizontalBeam(binary, width, x, yFrom, yTo, needed) {
  const start = Math.max(0, Math.min(yFrom, yTo));
  const end = Math.min(Number.MAX_SAFE_INTEGER, Math.max(yFrom, yTo));
  for (let y = start; y <= end; y++) {
    const row = y * width;
    let anchor = -1;
    if (binary[row + x]) anchor = x;
    else if (x > 0 && binary[row + x - 1]) anchor = x - 1;
    else if (x + 1 < width && binary[row + x + 1]) anchor = x + 1;
    if (anchor < 0) continue;
    let left = 0;
    for (let xx = anchor; xx >= 0 && binary[row + xx]; xx--) left += 1;
    let right = 0;
    for (let xx = anchor + 1; xx < width && binary[row + xx]; xx++) right += 1;
    if (left + right >= needed) return true;
  }
  return false;
}

/**
 * 检测小节线：每行谱表里贯穿五线的竖线，再跨谱表聚类。
 *
 * 为什么需要：Audiveris 偶尔会把两条小节线之间看成一整个小节（实测《敕勒歌》最后一页
 * 4 小节被识别成 3 小节），拍位就会少算。小节线是纯几何、检测很稳，可以用来核对/纠正。
 *
 * 两道几何校验，避免把「符干/符杠」当成小节线：
 *  1. 竖线必须从谱表上线一直画到下线（符干只覆盖其中一段）；
 *  2. 竖线紧邻的上方/下方及谱表内侧靠上下处不能有横符杠（符干顶端连着符杠）。
 *
 * @param {Uint8Array} binary 二值图（1=墨）
 * @param {number} width
 * @param {number} height
 * @param {{top:number,bottom:number,spacing?:number}[]} staves 同一系统的谱表（自上而下）
 * @returns {{x:number, xStart:number, xEnd:number}[]} 小节线 x 坐标（升序）
 */
export function detectBarlines(binary, width, height, staves, options = {}) {
  if (!Array.isArray(staves) || !staves.length) return [];
  const supportRatio = Number.isFinite(options.supportRatio) ? options.supportRatio : 0.5;
  const mergeGap = Number.isFinite(options.mergeGap) ? options.mergeGap : 20;
  const checkStems = options.checkStems !== false;
  const perStaff = [];
  for (const staff of staves) {
    const staffTop = Math.round(staff.top);
    const staffBottom = Math.round(staff.bottom);
    const top = Math.max(0, staffTop - 4);
    const bottom = Math.min(height - 1, staffBottom + 4);
    const span = Math.max(1, staffBottom - staffTop + 1);
    const spacing = Number(staff.spacing) > 0 ? Number(staff.spacing) : span / 4;
    const best = new Int32Array(width);
    const bestStart = new Int32Array(width);
    const run = new Int32Array(width);
    for (let y = top; y <= bottom; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (binary[row + x]) {
          run[x] += 1;
          if (run[x] > best[x]) {
            best[x] = run[x];
            bestStart[x] = y - run[x] + 1;
          }
        } else {
          run[x] = 0;
        }
      }
    }
    const threshold = span * 0.9;
    const beamNeeded = Math.max(18, Math.round(spacing * 1.8));
    const inner = Math.round(spacing * 0.6);
    const columns = [];
    for (let x = 0; x < width; x++) {
      if (best[x] < threshold) continue;
      if (checkStems) {
        const runStart = bestStart[x];
        const runEnd = runStart + best[x] - 1;
        // 真小节线：从谱表上线画到下线。符干只覆盖谱表的一部分。
        if (runStart > staffTop + 4 || runEnd < staffBottom - 4) continue;
        // 符杠检查：谱表外上方、谱表内靠上、谱表内靠下、谱表外下方。
        if (hasHorizontalBeam(binary, width, x, staffTop - Math.round(spacing * 0.7), staffTop - 2, beamNeeded)) continue;
        if (hasHorizontalBeam(binary, width, x, staffTop + 2, staffTop + inner, beamNeeded)) continue;
        if (hasHorizontalBeam(binary, width, x, staffBottom - inner, staffBottom - 2, beamNeeded)) continue;
        if (hasHorizontalBeam(binary, width, x, staffBottom + 2, staffBottom + Math.round(spacing * 0.7), beamNeeded)) continue;
      }
      columns.push(x);
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

// 声部在谱面上的自然顺序（自上而下）：S、A、T、Bar、B，最后才是钢琴/伴奏。
const VOICE_ROLE_ORDER = ["Soprano", "Alto", "Tenor", "Baritone", "Bass"];
/** 声部在界面/编号里的固定顺序：人声在前（S→A→T→Bar→B），其它乐器居中，钢琴最后。 */
const ROLE_SORT_WEIGHTS = { Soprano: 0, Alto: 1, Tenor: 2, Baritone: 3, Bass: 4 };
export function roleSortWeight(role) {
  const name = String(role || "");
  if (Object.prototype.hasOwnProperty.call(ROLE_SORT_WEIGHTS, name)) return ROLE_SORT_WEIGHTS[name];
  if (name === "Piano") return 100;
  return 50;
}
// 谱号 → 该谱号最可能对应的声部（按顺序尝试未被占用的）。
const CLEF_ROLE_PREFERENCES = {
  treble: ["Soprano", "Alto"],
  treble8vb: ["Tenor"],
  bass: ["Bass"],
  alto: ["Alto"],
  tenor: ["Tenor"],
};

/** MusicXML 的 clef 节点信息（sign/line/八度变化）→ 稳定的谱号标记。 */
function clefSignature(clef) {
  if (!clef) return "";
  const sign = String(clef.sign || "").toUpperCase();
  const line = String(clef.line || "");
  const octave = Number(clef.octaveChange) || 0;
  let base = "";
  if (sign === "G" && line === "2") base = "treble";
  else if (sign === "F" && (line === "4" || line === "3")) base = "bass";
  else if (sign === "C" && line === "3") base = "alto";
  else if (sign === "C" && line === "4") base = "tenor";
  else if (sign) base = `${sign}${line}`;
  if (!base) return "";
  if (octave < 0) return `${base}8vb`;
  if (octave > 0) return `${base}8va`;
  return base;
}

/** 声部名去重（两个钢琴声部之类）：重复的加序号，保证全局声部表按名字唯一。 */
function dedupeRoleNames(roles) {
  const seen = new Map();
  return roles.map((role) => {
    const name = role || "";
    const used = (seen.get(name) || 0) + 1;
    seen.set(name, used);
    return used > 1 ? `${name} ${used}` : name;
  });
}

/**
 * 没有谱面文字标签时的声部名推断（图片型 PDF 没有文字层，读不到 S./A./T./B.）。
 *
 * 依据是 MusicXML 里的**谱号与谱表数**（识别引擎本来就会读谱号）：
 *  - 一个 part 带 2 行谱表（G2+F4）、或引擎已命名为 Piano → 钢琴；
 *  - 其余单行谱表按谱号自上而下映射：G2 → S/A，G2 低八度（treble8vb）→ T，F4 → B。
 * 实测《绒花》：6 行谱表 = [G2, G2, G2-8, F4, Piano(2行)] → Soprano/Alto/Tenor/Bass/Piano；
 * 3 行谱表（Solo 段）= [G2, Piano(2行)] → Soprano/Piano；2 行钢琴独奏段 → Piano。
 *
 * @param {string[]} engineNames 识别引擎给的声部名
 * @param {{partName?:string, staves?:number, clefs?:object[]}[]} partDetails 与声部同序的谱表信息
 * @param {number} count 声部数
 * @returns {string[]|null} 推断不出时返回 null（调用方走旧的兜底逻辑）
 */
export function inferPartRoles(engineNames, partDetails, count) {
  if (!Array.isArray(partDetails) || partDetails.length !== count || !count) return null;
  const names = Array.isArray(engineNames) ? engineNames : [];
  const isPiano = partDetails.map((detail, index) => {
    const engineName = canonicalPartRole(names[index] || detail.partName || "");
    if (engineName === "Piano") return true;
    return Number(detail.staves) >= 2;
  });
  const roles = new Array(count).fill("");
  const vocalSlots = [];
  for (let index = 0; index < count; index++) {
    if (isPiano[index]) roles[index] = "Piano";
    else vocalSlots.push(index);
  }
  if (!vocalSlots.length) return roles; // 整段就是钢琴独奏
  const used = new Set();
  for (const index of vocalSlots) {
    const clefs = Array.isArray(partDetails[index].clefs) ? partDetails[index].clefs : [];
    const preferences = CLEF_ROLE_PREFERENCES[clefSignature(clefs[0])] || [];
    let role = preferences.find((candidate) => !used.has(candidate));
    if (!role) role = VOICE_ROLE_ORDER.find((candidate) => !used.has(candidate));
    if (!role) role = `声部 ${used.size + 1}`;
    used.add(role);
    roles[index] = role;
  }
  return dedupeRoleNames(roles);
}

/**
 * 解析一个系统的声部名：优先用 PDF 文字层读到的谱面标签（自上而下），
 * 其次按谱号/谱表数推断（图片型 PDF 没有标签时用），最后退回识别引擎给的声部名。
 *
 * @param {string[]} labels 该系统自上而下的谱面标签
 * @param {string[]} fallbackRoles 之前系统已确定的角色名（也是跨系统稳定的声部表）
 * @param {string[]} engineNames 识别引擎给出的声部名（兜底）
 * @param {number} partCount 本系统识别出的声部数
 * @param {{partName?:string, staves?:number, clefs?:object[]}[]} [partDetails] 每个声部的谱表/谱号信息
 * @returns {string[]} 长度 = partCount 的角色名
 */
export function resolveSystemRoles(labels, fallbackRoles, engineNames, partCount, partDetails = []) {
  const count = Math.max(1, Number(partCount) || 1);
  const canonicalLabels = (Array.isArray(labels) ? labels : [])
    .map(canonicalPartRole)
    .filter(Boolean);
  const inferred = inferPartRoles(engineNames, partDetails, count);
  if (canonicalLabels.length >= count) return dedupeRoleNames(canonicalLabels.slice(0, count));
  if (canonicalLabels.length) {
    // 标签少于声部数：能对上的先对上，对不上的优先用谱号推断，再退回兜底名。
    const roles = canonicalLabels.slice();
    const fallback = (fallbackRoles && fallbackRoles.length ? fallbackRoles : engineNames) || [];
    for (let index = roles.length; index < count; index++) {
      const inferredRole = inferred && inferred[index] ? inferred[index] : "";
      const candidate = inferredRole || canonicalPartRole(fallback[index] || "");
      roles.push(candidate || `声部 ${index + 1}`);
    }
    return dedupeRoleNames(roles);
  }
  if (inferred) return inferred;
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

/** 从「每小节的音符时值」推断主拍号（只在整页没有印刷拍号时兜底用）。 */
function inferMeterFromSystems(systems) {
  const counts = new Map();
  for (const system of systems || []) {
    const info = system && system.scoreInfo;
    const measures = Array.isArray(info && info.measures) ? info.measures : [];
    for (const measure of measures) {
      const beats = Number(measure.lengthBeats);
      if (!(beats > 0)) continue;
      const rounded = Math.round(beats * 4) / 4;
      if (rounded < 0.5 || rounded > 12) continue;
      counts.set(rounded, (counts.get(rounded) || 0) + 1);
    }
  }
  let best = 0, bestCount = 0;
  for (const [beats, count] of counts) {
    if (count > bestCount) { best = beats; bestCount = count; }
  }
  if (!best) return "";
  if (Number.isInteger(best)) return `${best}/4`;
  return `${Math.round(best * 2)}/8`;
}

/** 每小节拍数 → 通用拍号字符串（从「小节实际内容拍数」推断变拍子时用）。 */
export function meterNameForBeats(beats) {
  const value = Math.round((Number(beats) || 0) * 4) / 4;
  if (!(value > 0)) return "";
  const table = {
    0.5: "1/8", 0.75: "3/16", 1: "1/4", 1.5: "3/8", 2: "2/4", 2.5: "5/8",
    3: "3/4", 3.5: "7/8", 4: "4/4", 5: "5/4", 6: "6/4", 7: "7/4", 8: "8/4",
    9: "9/8", 12: "12/8",
  };
  return table[value] || "";
}

/**
 * 从「每小节的原始内容拍数」推断逐小节拍号表。
 *
 * 为什么需要：图片型 PDF 只在变拍子那一条谱表上印一次新拍号，后面的系统都不再印；
 * Audiveris 也不会输出 `<time>`，所以只能看「每个小节实际写了几拍」。
 * 实测《Goodbye Mr Lawrence》：第 29 小节起 6/8 → 2/4，若不推断，后面所有 2/4 小节
 * 都会被当成 6/8 的 3 拍（每小节末尾多 1 拍空拍——用户听到的「莫名其妙的空拍」）。
 *
 * 规则：某小节内容拍数与当前拍号差 **≥ 3/4 拍**、且**后一小节也一致**时才认作变拍号。
 * 为什么门槛是 3/4 拍：图片型谱的三连音经常被 Audiveris 多算一点时值（实测《绒花》2/4 小节
 * 被读成 2.5 拍），差 1/2 拍就把 2/4 换成 5/8 会把整段节奏算错；而真正的变拍子（6/8→2/4、
 * 4/4→2/4、4/4→6/4 等）内容拍数至少差 1 拍。单小节的差异更可能是弱起小节/识别误差；
 * 系统最后一小节也不能单独触发换拍号（实测《Goodbye Mr Lawrence》第 137/191/195 小节
 * 被识别引擎读成 3 拍/4 拍，按「最后一小节也算」的旧规则会凭空多出 3/4、4/4 的假变拍子），
 * 真正的变拍子会从下一系统的第 1 小节开始被识别出来。
 *
 * @param {number[]} contents 每小节原始内容拍数（四分音符为一拍）
 * @param {string} initialMeter 起始拍号（上一个系统末尾的拍号）
 * @returns {string[]} 与 contents 同长的逐小节拍号表
 */
export function inferMeterMapFromContents(contents, initialMeter = "") {
  const list = Array.isArray(contents)
    ? contents.map((value) => Math.round((Number(value) || 0) * 4) / 4)
    : [];
  let current = normalizeMeter(initialMeter) || "";
  return list.map((beats, index) => {
    if (beats > 0) {
      const currentBeats = beatsPerMeter(current);
      if (!current || Math.abs(currentBeats - beats) > 0.74) {
        const next = list[index + 1] || 0;
        const sustained = next > 0 && Math.abs(next - beats) < 0.26;
        if (sustained) {
          const named = meterNameForBeats(beats);
          if (named) current = named;
        }
      }
    }
    return current;
  });
}

/**
 * 把「第几小节变了什么调」整理成一句中文说明。
 * 例：《绒花》Ab 起、第 9 小节转 F、第 86 小节回到 Ab
 *   → "Ab（第 9 小节起 F；第 86 小节起 Ab）"
 */
export function summarizeKeyChanges(changes, fallback = "") {
  const list = (Array.isArray(changes) ? changes : [])
    .map((change) => ({ measure: Number(change.measure), key: String(change.key || "") }))
    .filter((change) => Number.isFinite(change.measure) && change.key);
  if (!list.length) return fallback || "调号未标明";
  const first = list[0].key;
  const rest = list.slice(1);
  if (!rest.length) return first;
  return `${first}（${rest.map((change) => `第 ${change.measure} 小节起 ${change.key}`).join("；")}）`;
}

/**
 * 把「逐系统识别」结果拼成一页（或一首）乐谱。
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
  // 整页都没有印刷拍号（图片型 PDF 的单页识别常见，例如《绒花》第 4 页）：
  // 按大多数小节的音符时值推断主拍号。不推断的话 quantizeScoreRhythm 会退回默认 4 拍，
  // 2/4 的页面会被量化错（听感就是「节奏散 / 莫名其妙的空拍」）。
  const hasAnyMeter = (systems || []).some((system) => {
    const info = system && system.scoreInfo;
    if (!info) return false;
    if (Array.isArray(system.meterMap) && system.meterMap.some(Boolean)) return true;
    return /^\d+\/\d+$/.test(normalizeMeter(info.timeSummary));
  });
  const inferredMeter = hasAnyMeter ? "" : inferMeterFromSystems(systems);
  const notes = [];
  const warnings = new Set();
  const tempoMarks = [];
  const dynamicsMarks = [];
  const wedgeMarks = [];
  const meterChanges = [];
  // 调号变化（变调）：{measure, key}，按小节先后累加（《绒花》：Ab → 第 9 小节 F → 第 86 小节 Ab）。
  const keyChanges = [];
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
  let runningKey = "";
  let keySummary = "";
  let timeSummary = "";
  let clef = "";
  let title = "";
  let systemIndex = 0;
  // 全局声部表：按「角色名」而不是「本系统第几个声部」编号。
  // 一页里各系统的声部数可能不同（《绒花》：钢琴独奏 1 个、Solo 段 2 个、四声部段 5 个），
  // 若按序号编号，Solo 段里的钢琴会被错算成 Alto——用户看到的就是「分不清声部」。
  const partRoleRegistry = [...fallbackRoles];

  for (const system of systems) {
    if (!system || !system.scoreInfo) continue;
    const info = system.scoreInfo;
    const engineNames = info.partNames || [];
    const partDetails = Array.isArray(info.partDetails) ? info.partDetails : [];
    const partCount = Math.max(1, engineNames.length || partDetails.length || 1);
    const roles = resolveSystemRoles(
      system.labels,
      partRoleRegistry.length ? partRoleRegistry : fallbackRoles,
      engineNames,
      partCount,
      partDetails,
    );
    for (const role of roles) {
      const name = role || `声部 ${partRoleRegistry.length + 1}`;
      if (!partRoleRegistry.includes(name)) partRoleRegistry.push(name);
    }
    if (!title) title = info.title || "";
    if (!clef) clef = info.clef || "";
    if (!keySummary) keySummary = info.keySummary || "";

    const parsedMeasures = Array.isArray(info.measures) ? info.measures : [];
    const parsedCount = parsedMeasures.length || Math.max(0, Number(info.measureCount) || 0);
    const barlineCount = Number.isFinite(system.measureCount) && system.measureCount > 0
      ? Math.round(system.measureCount) : 0;
    // 小节数：以识别引擎自己的小节为准；只有「某个解析小节明显超长（说明它吞掉了相邻小节线）」
    // 时才相信图像小节线的条数。反过来（小节线比解析少）一律不信——低分辨率图片上
    // 小节线检测会漏，硬用小节线会把后面几个小节的音符挤进一个小节（听感是突然一堆音 + 空拍）。
    let authoritative = parsedCount || barlineCount || 1;
    if (barlineCount > authoritative) {
      const meterBeatsForCheck = beatsPerMeter(normalizeMeter(info.timeSummary))
        || beatsPerMeter(runningMeter) || beatsPerMeter(inferredMeter) || 0;
      const rawContents = Array.isArray(info.measureContents) ? info.measureContents : [];
      const maxContent = rawContents.reduce((max, value) => Math.max(max, Number(value) || 0), 0);
      if (meterBeatsForCheck > 0 && maxContent > meterBeatsForCheck * 1.6 + 0.01) {
        authoritative = barlineCount;
      }
    }
    if (authoritative < parsedCount) { stats.trimmedMeasures += parsedCount - authoritative; }
    if (authoritative > parsedCount) { stats.appendedMeasures += authoritative - parsedCount; }

    // 逐小节拍号（来自 XML 本身 / 变拍子推断的重解析结果）：图片型 PDF 的变拍子靠它。
    const xmlMeters = Array.isArray(info.measureMeters) ? info.measureMeters : [];
    // PDF 文字层给出的逐小节拍号（矢量 PDF 才有）。注意：图片型 PDF 也会带一个「长度等于小节数、
    // 内容全是空串」的占位表——不能因为它是数组就直接用，否则会挡住下面的 xmlMeters，
    // 图片型 PDF 的变拍子（《Goodbye Mr Lawrence》第 29 小节 6/8→2/4）就会整段丢失。
    const printMeters = Array.isArray(system.meterMap) ? system.meterMap : [];
    const meterAt = (index) =>
      normalizeMeter(printMeters[index] || "") || normalizeMeter(xmlMeters[index] || "");
    const isFirstSystem = systemIndex === 0;
    const pickup = Boolean(isFirstSystem && parsedMeasures[0] && parsedMeasures[0].implicit);
    const pickupBeats = pickup ? Math.max(0, Number(parsedMeasures[0].lengthBeats) || 0) : 0;

    // 权威的小节长度表（用印刷拍号优先，弱起小节用识别出的实际长度）
    const inferredBeats = beatsPerMeter(inferredMeter);
    const measureLengths = [];
    let lastLength = 0;
    for (let index = 0; index < authoritative; index++) {
      const parsed = parsedMeasures[index];
      const meter = meterAt(index);
      let length = 0;
      if (pickup && index === 0) length = pickupBeats;
      else if (meter) length = beatsPerMeter(meter);
      else if (inferredBeats) length = inferredBeats;
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
    // 调号（变调）：XML 的 keyEvents 给出「本系统第几小节变成什么调」。
    // 与拍号一样按小节累计，跨系统/跨页延续的同一调号不重复记录。
    const keyByMeasure = new Map();
    for (const event of info.keyEvents || []) {
      const index = Number(event.measureIndex);
      if (Number.isFinite(index) && event.key) keyByMeasure.set(index, String(event.key));
    }
    if (!runningKey && keyByMeasure.size) {
      const firstIndex = Math.max(0, Math.min(...keyByMeasure.keys()));
      runningKey = keyByMeasure.get(firstIndex);
      keyChanges.push({ measure: labelBase + firstIndex, key: runningKey });
    }
    for (let index = 0; index < authoritative; index++) {
      const key = keyByMeasure.get(index);
      if (!key || key === runningKey) continue;
      runningKey = key;
      keyChanges.push({ measure: labelBase + index, key });
    }
    const firstMeasureNumber = parsedMeasures.length ? Number(parsedMeasures[0].number) : 1;
    const localIndexFor = (note) => {
      const number = Number(note.measure);
      if (!Number.isFinite(number)) return 0;
      const first = Number.isFinite(firstMeasureNumber) ? firstMeasureNumber : 1;
      const index = number - first;
      if (index < 0) return 0;
      return Math.min(authoritative - 1, index);
    };
    // 识别引擎的声部顺序 = partIds/partNames 的顺序；音符按 partId 归到对应角色。
    // （不能用「音符里第一次出现的顺序」：某个声部整段休止时没有音符，会让后面所有声部错位。）
    const mappedPartIds = Array.isArray(info.partIds) && info.partIds.length
      ? info.partIds
      : info.partNames.map((_, index) => `part-${index + 1}`);
    const roleByPartId = new Map();
    mappedPartIds.forEach((partId, index) => {
      const roleIndex = Math.min(index, Math.max(0, roles.length - 1));
      roleByPartId.set(partId, roles[roleIndex] || `声部 ${roleIndex + 1}`);
    });

    const systemStartBeat = beatOffset;
    const systemEndBeat = beatOffset + systemBeats;
    for (const note of info.notes) {
      const localIndex = localIndexFor(note);
      const measureLength = measureLengths[localIndex] || 0;
      const startInMeasure = Number(note.startInMeasure);
      const safeStart = Number.isFinite(startInMeasure) ? Math.max(0, startInMeasure) : 0;
      if (measureLength > 0 && safeStart >= measureLength - 0.0001) stats.overflowNotes++;
      const role = roleByPartId.get(note.partId) || roles[0] || "声部 1";
      const startBeat = systemStartBeat + localBase[localIndex] + safeStart;
      const measureLabel = labelBase + localIndex;
      notes.push({
        ...note,
        // 先记角色名，等所有系统装配完再统一编成稳定的 P1..Pn（见函数末尾）。
        partId: role,
        partName: role,
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
    // 拍号变化记录（优先用印刷拍号；没有就沿用上一小节/上一系统；整页都没印时用推断值）
    let meterCursor = normalizeMeter(runningMeter) || normalizeMeter(info.timeSummary) || inferredMeter;
    const meters = [];
    for (let index = 0; index < authoritative; index++) {
      // 拍号来源优先级：PDF 文字层 > XML 自己印的/推断出的逐小节拍号 > 沿用上一小节
      const mapped = meterAt(index);
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
  if (inferredMeter && !hasAnyMeter) {
    warnings.add(`本页没有印刷拍号，已按谱面音符时值推断为 ${inferredMeter}；如需精确请对照纸谱。`);
  }
  if (!deferStatsWarnings && stats.trimmedMeasures) warnings.add(`有 ${stats.trimmedMeasures} 个多识别出来的小节没有并入结果（已按印刷小节线为准）。`);
  if (!deferStatsWarnings && stats.appendedMeasures) warnings.add(`原谱比识别结果多 ${stats.appendedMeasures} 个小节（识别漏读了小节线），已按印刷拍号补齐空小节。`);
  if (!deferStatsWarnings && stats.overflowNotes) warnings.add(`有 ${stats.overflowNotes} 个音符超出了一小节的范围（识别误差），试听时它们会挤到下一小节开头。`);

  // 全部系统装配完：按「S→A→T→Bar→B→其它→Piano」的固定顺序给全局声部编号 P1..Pn。
  // 这样同一份谱里各系统的声部数不同也没关系——同名角色永远落到同一个 P 编号。
  const sortedRoles = [...partRoleRegistry].sort((left, right) => roleSortWeight(left) - roleSortWeight(right));
  const partIdByRole = new Map(sortedRoles.map((role, index) => [role, `P${index + 1}`]));
  for (const note of notes) {
    const role = String(note.partId || note.partName || "声部 1");
    note.partId = partIdByRole.get(role) || `P${sortedRoles.length}`;
    note.partName = role;
  }
  partNames = sortedRoles;
  stats.roleCount = partNames.length;

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
    // partIds：与 partNames 同序（P1..Pn）。界面用它把「本页没有音符的声部」也显示出来
    // （例如《敕勒歌》第 1 页陶笛整页休止，不能显示成「陶笛被裁掉了」）。
    partIds: partNames.map((_, index) => `P${index + 1}`),
    tempo: mergedTempo.find((mark) => mark.beat <= 0.00001)?.bpm || 84,
    tempoDetected: mergedTempo.length > 0,
    measureCount: stats.measureCount,
    totalBeats: stats.totalBeats,
    timeSummary: summary,
    keySummary: summarizeKeyChanges(keyChanges, keySummary),
    clef,
    title: title || "未命名乐谱",
    tempoMarks: mergedTempo,
    dynamicsMarks: mergedDynamics,
    wedgeMarks: mergedWedges,
    meterChanges,
    keyChanges,
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
