// 定位「长曲导出为什么慢」：分别改变 采样音色/合成音色、声部数、分块数，量渲染耗时。
// 用法：
//   $env:XML='...extreme-40v-100m.musicxml' node tools/profile_render_scaling.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/extreme-40v-100m.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 600000 });

const result = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const notes = debug.getPlaybackNotes();
  const baseTempo = Number(document.querySelector("#tempoInput").value) || 84;
  const scoreInfo = state.scoreInfo || {};
  const tempoPlan = debug.playbackTempoSegments(scoreInfo.tempoMarks || [], {
    offset: 0, userBpm: baseTempo, detectedBpm: scoreInfo.tempo,
  });
  const buildPlan = (noteList, globalTimbre) => debug.buildAudioPlan({
    notes: noteList,
    tempoSegments: [{ beat: 0, bpm: tempoPlan.startBpm }, ...tempoPlan.segments],
    startBpm: tempoPlan.startBpm, enabledParts: null,
    partTimbres: new Map(), globalTimbre,
    partVolumes: new Map(), partTranspose: new Map(), transpose: 0,
    selection: null, tailSeconds: 2.5,
  });
  const measure = async (label, plan, maxChunks, loadBanks = true) => {
    debug.EXPORT_RENDER.maxChunks = maxChunks;
    if (loadBanks) {
      const needed = new Map();
      for (const note of plan.notes) {
        if (!needed.has(note.timbre)) needed.set(note.timbre, new Set());
        if (Number.isFinite(note.midi)) needed.get(note.timbre).add(Math.round(note.midi));
      }
      for (const [timbre, midis] of needed) await debug.ensureSampleBank(timbre, { midis });
    }
    state.lastRenderStats = null;
    const t0 = performance.now();
    let buffer = await debug.renderPlanToBuffer(plan, {});
    const stats = state.lastRenderStats || {};
    const out = {
      label,
      seconds: Math.round(plan.totalSeconds),
      notes: plan.notes.length,
      maxChunks: stats.chunkCount,
      totalMs: Math.round(performance.now() - t0),
      buildMs: stats.buildMs,
      renderMs: stats.renderMs,
      mergeMs: stats.mergeMs,
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    };
    buffer = null;
    return out;
  };

  const sampledPlan = buildPlan(notes, "piano_real");
  const synthPlan = buildPlan(notes, "piano");
  // 只取前 4 个声部（同样时长），看声部数对渲染成本的影响
  const fourParts = new Set([...new Set(notes.map((note) => debug.voiceIdentity(note)))].slice(0, 4));
  const fourPartPlan = buildPlan(notes.filter((note) => fourParts.has(debug.voiceIdentity(note))), "piano_real");

  const out = [];
  out.push(await measure("采样音色 40 声部 12 块", sampledPlan, 12));
  out.push(await measure("合成音色 40 声部 12 块", synthPlan, 12, false));
  out.push(await measure("采样音色 4 声部 12 块", fourPartPlan, 12));
  out.push(await measure("采样音色 40 声部 24 块", sampledPlan, 24));
  out.push(await measure("采样音色 40 声部 6 块", sampledPlan, 6));
  return out;
});

console.log(JSON.stringify(result, null, 1));
await browser.close();
