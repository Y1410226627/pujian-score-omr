// 验证「分块并行渲染」与「整块渲染」的音质一致性 + 可复现性 + 多声部导出耗时。
//
// 用法：
//   $env:PLAYWRIGHT_CORE='...'; node tools/verify_export_chunked.mjs
//   $env:MULTI='1'  追加「复制成 4 个声部」的导出耗时对比（默认开）
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const FIXTURE = process.env.FIXTURE || "E:/识谱弹琴/tests/fixtures/call-of-silence-p1.musicxml";
const MULTI = process.env.MULTI !== "0";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.setInputFiles("#fileInput", {
  name: "verify.musicxml", mimeType: "application/xml",
  buffer: Buffer.from(readFileSync(FIXTURE, "utf8"), "utf8"),
});
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 180000 });
await page.waitForTimeout(800);

// 等采样音源装好再测：否则第一次渲染走合成音色、第二次走采样音色，
// 两次比对的就不是「分块 vs 整块」，而是两种音色（这是最初测出来的假差异）。
await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  if (!state.timbre || !debug.state.sampleManifest) return;
  await debug.ensureSampleBank(state.timbre);
  const started = performance.now();
  while (performance.now() - started < 60000) {
    const bank = state.sampleBanks.get(state.timbre);
    if (bank && bank.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

const result = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const bank = state.sampleBanks.get(state.timbre);
  const timbreState = { timbre: state.timbre, bankReady: Boolean(bank && bank.ready) };

  const buildPlan = () => {
    const notes = debug.getPlaybackNotes();
    const tempo = debug.playbackTempoSegments(state.scoreInfo?.tempoMarks || [], {
      offset: 0, userBpm: 84, detectedBpm: state.scoreInfo?.tempo,
    });
    return debug.buildAudioPlan({
      notes,
      tempoSegments: [{ beat: 0, bpm: tempo.startBpm }, ...tempo.segments],
      startBpm: tempo.startBpm,
      enabledParts: null,
      partTimbres: state.partTimbres,
      globalTimbre: state.timbre,
      partVolumes: state.partVolumes,
      partTranspose: new Map(),
      transpose: 0,
      selection: null,
      tailSeconds: 2.5,
    });
  };

  const render = async (plan, maxChunks) => {
    const saved = debug.EXPORT_RENDER.maxChunks;
    if (maxChunks) debug.EXPORT_RENDER.maxChunks = maxChunks;
    const t0 = performance.now();
    const buffer = await debug.renderPlanToBuffer(plan, {});
    const ms = performance.now() - t0;
    debug.EXPORT_RENDER.maxChunks = saved;
    return { buffer, ms };
  };

  const compare = (a, b) => {
    const leftA = a.getChannelData(0), leftB = b.getChannelData(0);
    const n = Math.min(leftA.length, leftB.length);
    let maxDiff = 0, sumSq = 0, peak = 0;
    let maxDiffAt = 0;
    const rate = a.sampleRate || 44100;
    const buckets = new Map();
    for (let i = 0; i < n; i += 1) {
      const diff = Math.abs(leftA[i] - leftB[i]);
      if (diff > maxDiff) { maxDiff = diff; maxDiffAt = i; }
      sumSq += diff * diff;
      const level = Math.abs(leftA[i]);
      if (level > peak) peak = level;
      if (diff > 1e-4) {
        const second = Math.floor(i / rate);
        const entry = buckets.get(second) || { second, max: 0, count: 0 };
        if (diff > entry.max) entry.max = diff;
        entry.count += 1;
        buckets.set(second, entry);
      }
    }
    const rms = Math.sqrt(sumSq / n);
    const top = [...buckets.values()]
      .sort((left, right) => right.max - left.max)
      .slice(0, 6)
      .map((entry) => ({ second: entry.second, maxDiff: Number(entry.max.toFixed(4)), samples: entry.count }));
    return {
      samples: n,
      peak: Number(peak.toFixed(4)),
      maxDiff: Number(maxDiff.toExponential(2)),
      maxDiffAtSeconds: Number((maxDiffAt / rate).toFixed(2)),
      rmsDiff: Number(rms.toExponential(2)),
      // 相对峰值的最坏偏差（dBFS）：-80 以下基本听不出，-60 以下几乎听不出
      worstDb: Number((20 * Math.log10(Math.max(1e-9, maxDiff / Math.max(1e-9, peak)))).toFixed(1)),
      rmsDb: Number((20 * Math.log10(Math.max(1e-9, rms / Math.max(1e-9, peak)))).toFixed(1)),
      bucketsWithDiff: buckets.size,
      topBuckets: top,
    };
  };

  const out = { timbreState };

  // ---- 1) 单声部：整块 vs 分块 vs 再分块（可复现）----
  const plan = buildPlan();
  out.single = { notes: plan.notes.length, seconds: Number(plan.totalSeconds.toFixed(1)) };
  const whole = await render(plan, 1);
  out.single.wholeMs = Number(whole.ms.toFixed(0));
  const chunkedA = await render(plan, 0);
  out.single.chunkedMs = Number(chunkedA.ms.toFixed(0));
  const chunkedB = await render(plan, 0);
  out.single.chunkedAgainMs = Number(chunkedB.ms.toFixed(0));
  out.single.wholeVsChunked = compare(whole.buffer, chunkedA.buffer);
  out.single.chunkedReproducible = compare(chunkedA.buffer, chunkedB.buffer);
  out.single.speedup = Number((whole.ms / Math.max(1, chunkedA.ms)).toFixed(2));

  // 导出两次的 MP3 是否逐字节一致（用户重复导出应得到同一个文件）
  await debug.loadLame();
  const encodePair = () => {
    const left = chunkedA.buffer.getChannelData(0);
    const right = chunkedA.buffer.getChannelData(1);
    return debug.encodeMp3(left, right);
  };
  const encodePairB = () => {
    const left = chunkedB.buffer.getChannelData(0);
    const right = chunkedB.buffer.getChannelData(1);
    return debug.encodeMp3(left, right);
  };
  const blobA = encodePair();
  const blobB = encodePairB();
  const [bytesA, bytesB] = await Promise.all([blobA.arrayBuffer(), blobB.arrayBuffer()]);
  const viewA = new Uint8Array(bytesA);
  const viewB = new Uint8Array(bytesB);
  let byteDiff = Math.abs(viewA.length - viewB.length);
  const common = Math.min(viewA.length, viewB.length);
  for (let i = 0; i < common; i += 1) if (viewA[i] !== viewB[i]) byteDiff += 1;
  out.single.mp3Reproducible = {
    bytes: viewA.length,
    byteDiff,
    identical: byteDiff === 0,
  };

  // ---- 2) 多声部（复制成 4 个声部）：整块 vs 分块 ----
  if (debug.state.notes.length) {
    const sourceKey = debug.voiceIdentity(state.notes[0]);
    for (let i = 0; i < 3; i += 1) debug.duplicatePart(sourceKey, {});
    const multiPlan = buildPlan();
    const multiWhole = await render(multiPlan, 1);
    const multiChunked = await render(multiPlan, 0);
    out.multi = {
      notes: multiPlan.notes.length,
      seconds: Number(multiPlan.totalSeconds.toFixed(1)),
      wholeMs: Number(multiWhole.ms.toFixed(0)),
      chunkedMs: Number(multiChunked.ms.toFixed(0)),
      speedup: Number((multiWhole.ms / Math.max(1, multiChunked.ms)).toFixed(2)),
      fidelity: compare(multiWhole.buffer, multiChunked.buffer),
    };
  }
  return out;
});

console.log(JSON.stringify(result, null, 1));
await browser.close();
