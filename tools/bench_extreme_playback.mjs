// 极端规模播放基准：可模拟「用户机器较慢」（CDP CPU 限速），量卡顿/中途没声/调度是否掉队。
// 用法：
//   $env:XML='...extreme-60v-140m.musicxml'; $env:THROTTLE='4'; $env:PLAYBACK_SECONDS='20'
//   node tools/bench_extreme_playback.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/extreme-40v-100m.musicxml";
const THROTTLE = Number(process.env.THROTTLE || 1);
const SECONDS = Number(process.env.PLAYBACK_SECONDS || 15);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
page.on("crash", () => errors.push("CRASH"));
await page.goto(APP + "?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });
if (THROTTLE > 1) {
  const client = await context.newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
}
const importT0 = Date.now();
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 600000 });
const importMs = Date.now() - importT0;
await page.evaluate(() => window.__pujian.whenNoteRowsIdle(120000));

const result = await page.evaluate(async (monitorSeconds) => {
  const debug = window.__pujian;
  const state = debug.state;
  // 现场就建一个「可用 audioContext」再量（页面初始化时已经建过，这里确保 resume）
  const frames = [];
  let lastFrame = performance.now();
  let running = true;
  const raf = () => {
    const now = performance.now();
    frames.push(now - lastFrame);
    lastFrame = now;
    if (running) requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  const t0 = performance.now();
  await debug.playMelody();
  const startMs = Math.round(performance.now() - t0);
  const trace = [];
  let silentSince = null;
  let silenceEvents = 0;
  let maxSources = 0;
  let minAhead = 999;
  let stalledTicks = 0;
  let lastT = performance.now();
  const end = performance.now() + monitorSeconds * 1000;
  while (performance.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stats = state.playbackStats || {};
    const snapshot = {
      t: Math.round(performance.now() - t0),
      wall: Number(((performance.now() - t0) / 1000).toFixed(1)),
      ctx: Number(state.audio.currentTime.toFixed(1)),
      sources: state.sources.size,
      cursor: stats.cursor || 0,
      events: stats.events || 0,
      windows: stats.windows || 0,
      ahead: Number((stats.lastAhead || 0).toFixed(2)),
      timers: state.timers.length,
      playing: state.isPlaying,
    };
    trace.push(snapshot);
    maxSources = Math.max(maxSources, snapshot.sources);
    minAhead = Math.min(minAhead, snapshot.ahead);
    if (state.isPlaying && state.sources.size === 0) {
      if (silentSince === null) silentSince = snapshot.t;
    } else {
      silentSince = null;
    }
    if (silentSince !== null && snapshot.t - silentSince > 1200) { silenceEvents += 1; silentSince = null; }
    if (snapshot.playing && snapshot.ahead < 0.4) stalledTicks += 1;
    lastT = snapshot.t;
  }
  running = false;
  const gaps = frames.slice();
  debug.stopPlayback();
  const sorted = gaps.slice().sort((a, b) => a - b);
  return {
    startMs,
    monitorSeconds,
    frames: gaps.length,
    frameP50: Number((sorted[Math.floor(sorted.length * 0.5)] || 0).toFixed(1)),
    frameP95: Number((sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(1)),
    frameP99: Number((sorted[Math.floor(sorted.length * 0.99)] || 0).toFixed(1)),
    frameMax: Number(Math.max(...gaps).toFixed(1)),
    longFrames100: gaps.filter((gap) => gap > 100).length,
    longFrames250: gaps.filter((gap) => gap > 250).length,
    maxSources,
    minAhead,
    silentEvents: silenceEvents,
    stalledTicks,
    timersAtEnd: state.timers.length,
    traceHead: trace.slice(0, 5),
    traceTail: trace.slice(-3),
  };
}, SECONDS);

console.log(JSON.stringify({ xml: XML, throttle: THROTTLE, importMs, notes: await page.evaluate(() => window.__pujian.state.notes.length), parts: await page.evaluate(() => new Set(window.__pujian.state.notes.map((note) => window.__pujian.voiceIdentity(note))).size), result, errors }, null, 1));
await browser.close();
