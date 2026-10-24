// 导出分阶段计时（真实大谱）：计划构建 / 离线渲染 / MP3 编码 各多少秒。
// 用法：$env:PLAYWRIGHT_CORE='...'; node tools/profile_export_big.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/big-4v-160m.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 300000 });
await page.waitForTimeout(500);
await page.evaluate(async () => {
  const debug = window.__pujian;
  await debug.ensureSampleBank(debug.state.timbre);
  const started = performance.now();
  while (performance.now() - started < 60000) {
    const bank = debug.state.sampleBanks.get(debug.state.timbre);
    if (bank && bank.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await debug.loadLame();
});

const report = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const out = {};
  let t0 = performance.now();
  const notes = debug.getPlaybackNotes();
  const tempo = debug.playbackTempoSegments(state.scoreInfo?.tempoMarks || [], {
    offset: 0, userBpm: 84, detectedBpm: state.scoreInfo?.tempo,
  });
  const plan = debug.buildAudioPlan({
    notes,
    tempoSegments: [{ beat: 0, bpm: tempo.startBpm }, ...tempo.segments],
    startBpm: tempo.startBpm, enabledParts: null, partTimbres: state.partTimbres,
    globalTimbre: state.timbre, partVolumes: state.partVolumes, partTranspose: new Map(),
    transpose: 0, selection: null, tailSeconds: 2.5,
  });
  out.planMs = Number((performance.now() - t0).toFixed(0));
  out.planNotes = plan.notes.length;
  out.seconds = Number(plan.totalSeconds.toFixed(1));
  out.longestNote = Number(Math.max(...plan.notes.map((note) => note.durationSeconds)).toFixed(2));
  out.hardwareConcurrency = navigator.hardwareConcurrency;

  t0 = performance.now();
  const buffer = await debug.renderPlanToBuffer(plan, {});
  out.renderMs = Number((performance.now() - t0).toFixed(0));
  out.bufferSeconds = Number((buffer.duration).toFixed(1));

  t0 = performance.now();
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const blob = debug.encodeMp3(left, right);
  out.encodeMs = Number((performance.now() - t0).toFixed(0));
  out.mp3KB = Math.round(blob.size / 1024);
  return out;
});

console.log(JSON.stringify(report, null, 1));
await browser.close();
