// 调 maxChunks 参数：整曲 89.6 秒 / 单声部 192 音 与 4 声部 768 音，分别试 1/2/3/4/5/6 块。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const FIXTURE = "E:/识谱弹琴/tests/fixtures/call-of-silence-p1.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.setInputFiles("#fileInput", {
  name: "tune.musicxml", mimeType: "application/xml",
  buffer: Buffer.from(readFileSync(FIXTURE, "utf8"), "utf8"),
});
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 180000 });
await page.evaluate(async () => {
  const debug = window.__pujian;
  if (debug.state.sampleManifest) {
    await debug.ensureSampleBank(debug.state.timbre);
    const started = performance.now();
    while (performance.now() - started < 60000) {
      const bank = debug.state.sampleBanks.get(debug.state.timbre);
      if (bank && bank.ready) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});

const report = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const buildPlan = () => {
    const notes = debug.getPlaybackNotes();
    const tempo = debug.playbackTempoSegments(state.scoreInfo?.tempoMarks || [], {
      offset: 0, userBpm: 84, detectedBpm: state.scoreInfo?.tempo,
    });
    return debug.buildAudioPlan({
      notes,
      tempoSegments: [{ beat: 0, bpm: tempo.startBpm }, ...tempo.segments],
      startBpm: tempo.startBpm,
      enabledParts: null, partTimbres: state.partTimbres, globalTimbre: state.timbre,
      partVolumes: state.partVolumes, partTranspose: new Map(), transpose: 0,
      selection: null, tailSeconds: 2.5,
    });
  };
  const render = async (plan, count) => {
    debug.EXPORT_RENDER.maxChunks = count;
    const t0 = performance.now();
    await debug.renderPlanToBuffer(plan, {});
    return Number((performance.now() - t0).toFixed(0));
  };
  const out = { single: {}, multi: {}, long: {} };
  const plan = buildPlan();
  out.single.seconds = Number(plan.totalSeconds.toFixed(1));
  // 每种块数测两遍取第二遍（第一遍有 JIT/预热偏差）
  for (const count of [1, 2, 3, 4, 5, 6]) {
    await render(plan, count);
    out.single[count] = await render(plan, count);
  }
  // 3 分钟长曲（把计划复制两遍）：看更多块是否还继续变快
  const longPlan = {
    notes: [...plan.notes, ...plan.notes.map((note) => ({ ...note, startSeconds: note.startSeconds + plan.totalSeconds }))],
    totalSeconds: plan.totalSeconds * 2,
    partKeys: plan.partKeys,
  };
  debug.EXPORT_RENDER.maxChunks = 20;
  out.long.seconds = Number(longPlan.totalSeconds.toFixed(1));
  for (const count of [6, 8, 10, 12]) {
    debug.EXPORT_RENDER.maxChunks = count;
    const t0 = performance.now();
    await debug.renderPlanToBuffer(longPlan, {});
    out.long[count] = Number((performance.now() - t0).toFixed(0));
  }
  debug.EXPORT_RENDER.maxChunks = 6;

  // 4 声部
  const sourceKey = debug.voiceIdentity(state.notes[0]);
  for (let i = 0; i < 3; i += 1) debug.duplicatePart(sourceKey, {});
  const multiPlan = buildPlan();
  out.multi.notes = multiPlan.notes.length;
  for (const count of [1, 2, 3, 4, 5, 6]) {
    await render(multiPlan, count);
    out.multi[count] = await render(multiPlan, count);
  }
  return out;
});

console.log(JSON.stringify(report, null, 1));
await browser.close();
