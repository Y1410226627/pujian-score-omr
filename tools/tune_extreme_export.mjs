// 极端长曲导出的「分块数量」调参：只做渲染（不编码），比较不同 maxChunks 的耗时/内存。
// 用法：
//   $env:XML='...extreme-40v-440m.musicxml'; $env:CHUNKS='12,24,36,48'; node tools/tune_extreme_export.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/extreme-40v-440m.musicxml";
const CHUNKS = (process.env.CHUNKS || "12,24,36,48").split(",").map(Number);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 600000 });

const result = await page.evaluate(async (chunkList) => {
  const debug = window.__pujian;
  const state = debug.state;
  // 和 exportAudio 一样建计划
  const notes = debug.getPlaybackNotes();
  const baseTempo = Number(document.querySelector("#tempoInput").value) || 84;
  const scoreInfo = state.scoreInfo || {};
  const tempoPlan = debug.playbackTempoSegments(scoreInfo.tempoMarks || [], {
    offset: 0, userBpm: baseTempo, detectedBpm: scoreInfo.tempo,
  });
  const plan = debug.buildAudioPlan({
    notes,
    tempoSegments: [{ beat: 0, bpm: tempoPlan.startBpm }, ...tempoPlan.segments],
    startBpm: tempoPlan.startBpm, enabledParts: null,
    partTimbres: state.partTimbres, globalTimbre: state.timbre,
    partVolumes: state.partVolumes, partTranspose: new Map(), transpose: 0,
    selection: null, tailSeconds: 2.5,
  });
  // 载入音源（导出时会做）
  const needed = new Map();
  for (const note of plan.notes) {
    const timbre = debug.timbreForPart(note.partKey);
    if (!needed.has(timbre)) needed.set(timbre, new Set());
    if (Number.isFinite(note.midi)) needed.get(timbre).add(Math.round(note.midi));
  }
  for (const [timbre, midis] of needed) await debug.ensureSampleBank(timbre, { midis });

  const out = [];
  for (const count of chunkList) {
    debug.EXPORT_RENDER.maxChunks = count;
    state.lastRenderStats = null;
    const t0 = performance.now();
    let buffer = await debug.renderPlanToBuffer(plan, {});
    const totalMs = Math.round(performance.now() - t0);
    const stats = state.lastRenderStats || {};
    out.push({
      maxChunks: count,
      totalMs,
      prepMs: stats.prepMs,
      buildMs: stats.buildMs,
      renderMs: stats.renderMs,
      mergeMs: stats.mergeMs,
      chunkCount: stats.chunkCount,
      frames: buffer ? buffer.length : null,
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    });
    buffer = null;
  }
  return { totalSeconds: Math.round(plan.totalSeconds), notes: plan.notes.length, runs: out };
}, CHUNKS);

console.log(JSON.stringify(result, null, 1));
await browser.close();
