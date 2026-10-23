// 三项性能基线测量：复制声部 / 切八度 / MP3 导出。
//
// 用法：
//   $env:PLAYWRIGHT_CORE='...'; node tools/bench_perf.mjs
//   $env:FIXTURE='...' node tools/bench_perf.mjs
//   $env:REPEAT='3' node tools/bench_perf.mjs    # 重复测取中位数
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const FIXTURE = process.env.FIXTURE || "E:/识谱弹琴/tests/fixtures/call-of-silence-p1.musicxml";
const OUT = process.env.OUT || "";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => console.log("pageerror:", error.message));
page.on("console", (message) => {
  if (message.type() === "error") console.log("[console error]", message.text().slice(0, 200));
});

await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const xml = readFileSync(FIXTURE, "utf8");
await page.setInputFiles("#fileInput", {
  name: "bench.musicxml", mimeType: "application/xml", buffer: Buffer.from(xml, "utf8"),
});
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 180000 });
await page.waitForTimeout(1000);

const report = { fixture: FIXTURE.split(/[\\/]/).pop() };

// 1) 复制声部（含清理）
report.duplicate = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const before = state.notes.length;
  const key = debug.voiceIdentity(state.notes[0]);
  const t0 = performance.now();
  const created = debug.duplicatePart(key, {});
  const t1 = performance.now();
  const after = state.notes.length;
  if (created) {
    state.notes = state.notes.filter((note) => debug.voiceIdentity(note) !== created.key);
    state.partNames.delete(created.key);
    if (state.selectedParts && typeof state.selectedParts.delete === "function") {
      state.selectedParts.delete(created.key);
    }
    debug.updatePartControls();
    debug.renderNotes();
    debug.refreshScoreOverlay();
  }
  return { ms: Number((t1 - t0).toFixed(1)), added: after - before, total: before };
});

// 2) 切换八度（降再升）
report.octave = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const key = debug.voiceIdentity(state.notes[0]);
  const count = state.notes.filter((n) => debug.voiceIdentity(n) === key).length;
  const t0 = performance.now();
  debug.setPartOctave(key, -1);
  const t1 = performance.now();
  const t2 = performance.now();
  debug.setPartOctave(key, 0);
  const t3 = performance.now();
  return { downMs: Number((t1 - t0).toFixed(1)), upMs: Number((t3 - t2).toFixed(1)), notes: count };
});

// 3) 单次 renderNotes / overlay
report.renderNotes = await page.evaluate(async () => {
  const debug = window.__pujian;
  const t0 = performance.now();
  debug.renderNotes();
  const t1 = performance.now();
  const t2 = performance.now();
  debug.refreshScoreOverlay();
  const t3 = performance.now();
  return {
    notes: debug.state.notes.length,
    renderNotesMs: Number((t1 - t0).toFixed(1)),
    overlayMs: Number((t3 - t2).toFixed(1)),
    rows: debug.state.noteRowById ? debug.state.noteRowById.size : 0,
  };
});

// 4) MP3 导出：分阶段量
await page.evaluate(() => window.__pujian.loadLame());
report.export = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const notes = debug.getPlaybackNotes();
  const tempo = debug.playbackTempoSegments(state.scoreInfo?.tempoMarks || [], {
    offset: 0, userBpm: 84, detectedBpm: state.scoreInfo?.tempo,
  });
  const t0 = performance.now();
  const plan = debug.buildAudioPlan({
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
  const t1 = performance.now();
  const buffer = await debug.renderPlanToBuffer(plan, {});
  const t2 = performance.now();
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const blob = debug.encodeMp3(left, right);
  const t3 = performance.now();
  return {
    notes: notes.length,
    seconds: Number(plan.totalSeconds.toFixed(1)),
    sampleRate: buffer.sampleRate,
    frames: buffer.length,
    planMs: Number((t1 - t0).toFixed(1)),
    renderMs: Number((t2 - t1).toFixed(1)),
    encodeMs: Number((t3 - t2).toFixed(1)),
    totalMs: Number((t3 - t0).toFixed(1)),
    mp3KB: Math.round(blob.size / 1024),
  };
});

console.log(JSON.stringify(report, null, 1));
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1), "utf8");
await browser.close();
