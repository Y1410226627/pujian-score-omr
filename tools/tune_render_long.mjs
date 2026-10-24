// 长曲（≈11.5 分钟 / 4 声部 / 2640 音符）分块数调优：render 耗时与峰值内存。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/big-4v-160m.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 300000 });
await page.waitForTimeout(400);
await page.evaluate(async () => {
  const debug = window.__pujian;
  await debug.ensureSampleBank(debug.state.timbre);
  const started = performance.now();
  while (performance.now() - started < 60000) {
    const bank = debug.state.sampleBanks.get(debug.state.timbre);
    if (bank && bank.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

const report = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const tempo = debug.playbackTempoSegments(state.scoreInfo?.tempoMarks || [], {
    offset: 0, userBpm: 84, detectedBpm: state.scoreInfo?.tempo,
  });
  const plan = debug.buildAudioPlan({
    notes: debug.getPlaybackNotes(),
    tempoSegments: [{ beat: 0, bpm: tempo.startBpm }, ...tempo.segments],
    startBpm: tempo.startBpm, enabledParts: null, partTimbres: state.partTimbres,
    globalTimbre: state.timbre, partVolumes: state.partVolumes, partTranspose: new Map(),
    transpose: 0, selection: null, tailSeconds: 2.5,
  });
  const out = { seconds: Number(plan.totalSeconds.toFixed(0)), notes: plan.notes.length, results: [] };
  const saved = debug.EXPORT_RENDER.maxChunks;
  for (const count of [6, 8, 10, 12, 14]) {
    debug.EXPORT_RENDER.maxChunks = count;
    // 计时两遍取第二遍（第一遍含冷启动）
    await debug.renderPlanToBuffer(plan, {});
    const t0 = performance.now();
    const buffer = await debug.renderPlanToBuffer(plan, {});
    out.results.push({ maxChunks: count, ms: Number((performance.now() - t0).toFixed(0)), mb: Math.round(buffer.length * 2 * 4 / 1024 / 1024) });
  }
  debug.EXPORT_RENDER.maxChunks = saved;
  return out;
});

console.log(JSON.stringify(report, null, 1));
await browser.close();
