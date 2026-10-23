/**
 * 确定性伪随机（mulberry32）。同一个种子永远给出同一串数。
 *
 * 为什么导出要用它：人性化（时点/力度/音高微抖）如果用 Math.random，
 * 同一份谱每次导出的音频都会有细微差异，既无法复现、也没法把
 * 「分块并行渲染」与「整块渲染」逐样本对齐做保真验证。
 */
function mulberry32(seed) {
  let value = seed >>> 0;
  return function next() {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 「导出音频」的纯逻辑：把「识别结果 + 声部设置 + 选区」变成一份可渲染的音频计划。
//
// 为什么单独一个文件：导出音频最容易出错的地方不是编码，而是「计划算错」——
// 拍位该按分段速度换算成秒、移调该改 MIDI、声部该按勾选/音量/音色取参数。
// 这些全是纯函数，可以脱离浏览器单测（见 tests/audio-export.test.mjs）。

import { HUMANIZE } from "./timbre.js";

/**
 * 一个音符在导出时的目标参数。
 * @typedef {{midi: number, startSeconds: number, durationSeconds: number,
 *            partKey: string, timbre: string, volume: number, peak: number}} ExportNote
 */

/**
 * 把「拍位」换算成「秒」，速度标记支持任意多段（与播放一致）。
 *
 * @param {Array<{beat:number,bpm:number}>} segments 速度分段（按 beat 升序）
 * @param {number} startBpm 起始速度
 * @param {number} beat 目标拍位
 * @returns {number} 秒
 */
export function secondsAtBeat(segments, startBpm, beat) {
  const sorted = [...(segments || [])]
    .map((item) => ({ beat: Number(item.beat) || 0, bpm: Number(item.bpm) }))
    .filter((item) => Number.isFinite(item.bpm) && item.bpm > 0)
    .sort((left, right) => left.beat - right.beat);
  let seconds = 0;
  let previous = 0;
  let bpm = Number.isFinite(startBpm) && startBpm > 0 ? startBpm : 84;
  for (const segment of sorted) {
    if (segment.beat >= beat) break;
    seconds += (segment.beat - previous) * (60 / bpm);
    previous = segment.beat;
    bpm = segment.bpm;
  }
  return seconds + Math.max(0, beat - previous) * (60 / bpm);
}

/**
 * 生成导出计划。
 *
 * 语义：
 *  · 只导出「被勾选的声部」（enabledParts 为 null 表示全部）；
 *  · 每个音高的实际值 = 原 MIDI + 声部移调（transpose）+ 全局移调；
 *  · 选区（fromBeat/toBeat，单位是「整曲拍位」）之外的音不导出；
 *  · 选区起点之前的留白不要，整体平移到 0 秒开始（与「试听选中片段」一致）；
 *  · 音量来自声部音量滑条 × 导出增益；
 *  · 每个声部的音色取「声部自己的，其次全局」。
 *
 * @param {object} options
 * @param {Array} options.notes 音符（含 midi / startBeat / durationBeats / partId|partName）
 * @param {Array<{beat:number,bpm:number}>} options.tempoSegments
 * @param {number} options.startBpm
 * @param {string[]|null} options.enabledParts 参与导出的声部 key（null=全部）
 * @param {Map<string,string>} options.partTimbres 声部音色覆盖
 * @param {string} options.globalTimbre 全局音色
 * @param {Map<string,number>} options.partVolumes 声部音量（0–1）
 * @param {Map<string,number>} options.partTranspose 声部移调（半音）
 * @param {number} options.transpose 整曲移调（半音）
 * @param {{fromBeat:number,toBeat:number}|null} options.selection 选区（整曲拍位）
 * @param {number} options.tailSeconds 末尾额外留的余音（秒）
 * @returns {{notes: ExportNote[], totalSeconds: number, partKeys: string[]}}
 */
export function buildAudioPlan(options) {
  const {
    notes = [], tempoSegments = [], startBpm = 84,
    enabledParts = null, partTimbres = new Map(), globalTimbre = "piano",
    partVolumes = new Map(), partTranspose = new Map(), transpose = 0,
    selection = null, tailSeconds = 2.5,
  } = options;
  const enabled = enabledParts ? new Set(enabledParts) : null;
  const fromBeat = selection ? Number(selection.fromBeat) : 0;
  const toBeat = selection ? Number(selection.toBeat) : Infinity;
  const offset = Number.isFinite(fromBeat) ? fromBeat : 0;

  // 确定性随机：同一份谱每次都得到同一组人性化参数，导出结果可复现。
  const random = mulberry32(0x5eed1a2b);

  const plan = [];
  const partKeys = new Set();
  for (const note of notes) {
    if (!Number.isFinite(note.midi)) continue;
    const key = String(note.partId || note.partName || "旋律");
    if (enabled && !enabled.has(key)) continue;
    const startBeat = Number(note.startBeat) || 0;
    const durationBeats = Number.isFinite(note.durationBeats) ? note.durationBeats : 1;
    const endBeat = startBeat + durationBeats;
    if (endBeat <= fromBeat || startBeat >= toBeat) continue;

    const transposeForPart = Number(partTranspose.get(key)) || 0;
    const midi = Math.max(0, Math.min(127,
      Math.round(note.midi) + Number(transpose || 0) + transposeForPart));
    // 选区裁切：跨选区边界的音，时值截到边界内
    const clippedStart = Math.max(startBeat, fromBeat);
    const clippedEnd = Math.min(endBeat, toBeat);
    const startSeconds = secondsAtBeat(tempoSegments, startBpm, clippedStart - offset);
    const endSeconds = secondsAtBeat(tempoSegments, startBpm, clippedEnd - offset);
    const durationSeconds = Math.max(0.05, endSeconds - startSeconds);
    const volume = Number.isFinite(Number(partVolumes.get(key))) ? Number(partVolumes.get(key)) : 1;
    plan.push({
      midi,
      startSeconds,
      durationSeconds,
      partKey: key,
      timbre: partTimbres.get(key) || globalTimbre,
      volume: Math.max(0, Math.min(1, volume)),
      peak: 0.16,
      // 人性化参数在**建计划时**就固定下来，而不是播放时取随机数。
      // 两个原因：
      //   1) 同一份谱导出的音频要完全一致（用户重复导出不该得到不同结果）；
      //   2) 导出改成「分块并行渲染」后，每个音可能在不同块里被调度，
      //      参数若依赖调度顺序，分块与整块的结果就对不上。
      human: {
        offset: (random() - 0.5) * HUMANIZE.offset,
        peakFactor: 1 - HUMANIZE.peak / 2 + random() * HUMANIZE.peak,
        detune: (random() - 0.5) * HUMANIZE.detune,
      },
    });
    partKeys.add(key);
  }
  plan.sort((left, right) => left.startSeconds - right.startSeconds);
  const lastEnd = plan.reduce((end, note) => Math.max(end, note.startSeconds + note.durationSeconds), 0);
  const totalSeconds = Math.max(0.5, lastEnd + Math.max(0, tailSeconds));
  return { notes: plan, totalSeconds, partKeys: [...partKeys] };
}

/**
 * 把渲染出来的多声道/单声道缓冲混成「立体声交错数组」，供 MP3 编码使用。
 *
 * @param {Float32Array[]} channels 每个声道的采样
 * @returns {{left: Float32Array, right: Float32Array}}
 */
export function stereoChannels(channels) {
  const left = channels[0] || new Float32Array(0);
  const right = channels[1] || left;
  return { left, right };
}

/**
 * 峰值归一：把整体音量拉到 target（默认 0.89，约 -1 dBFS），避免削波但又不至于太小。
 * 返回缩放后的一对新数组（不修改输入）。
 */
export function normalizePeak(left, right, target = 0.89) {
  let peak = 0;
  for (let index = 0; index < left.length; index += 1) {
    const value = Math.abs(left[index]);
    if (value > peak) peak = value;
  }
  for (let index = 0; index < right.length; index += 1) {
    const value = Math.abs(right[index]);
    if (value > peak) peak = value;
  }
  if (peak <= 1e-6) return { left, right, gain: 1 };
  const gain = Math.min(8, target / peak);
  const scale = (source) => {
    const out = new Float32Array(source.length);
    for (let index = 0; index < source.length; index += 1) out[index] = source[index] * gain;
    return out;
  };
  return { left: scale(left), right: scale(right), gain };
}

/** 默认导出文件名：原文件名 + 片段范围 + .mp3。 */
export function audioFileName(baseName, selection, extension = "mp3") {
  const base = String(baseName || "谱见").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_");
  if (selection && Number.isFinite(selection.fromBeat) && Number.isFinite(selection.toBeat)) {
    return `${base}-片段${Math.round(selection.fromBeat)}-${Math.round(selection.toBeat)}拍.${extension}`;
  }
  return `${base}.${extension}`;
}

/** 把「秒」格式化成 "1 分 23 秒"，用于进度提示。 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}
