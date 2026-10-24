// 极端规模基准：几十个声部 / 超长时间下的「导入 → 播放 → 导出 MP3」真实体验。
//
// 量：
//   1) 导入耗时、声部数、音符列表渲染耗时；
//   2) 点播放的准备耗时 + 播放过程中主线程卡顿（rAF 帧间隔）、音频源数量、
//      「仍在播放但音频图里一个源都没有」（= 中途没声）的次数；
//   3) 点导出后的界面冻结（rAF 最长停顿）、导出分阶段耗时、是否崩溃。
//
// 用法：
//   $env:PLAYWRIGHT_CORE='...\playwright-core'
//   $env:XML='E:/识谱弹琴/.cache/perf/extreme-40v-100m.musicxml'
//   $env:PLAYBACK_SECONDS=12; $env:EXPORT_TIMEOUT_MS=300000
//   node tools/bench_extreme.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/extreme-40v-100m.musicxml";
const PLAYBACK_SECONDS = Number(process.env.PLAYBACK_SECONDS || 12);
const EXPORT_TIMEOUT_MS = Number(process.env.EXPORT_TIMEOUT_MS || 300000);
const SKIP_EXPORT = process.env.SKIP_EXPORT === "1";
const SKIP_PLAYBACK = process.env.SKIP_PLAYBACK === "1";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
let crashed = false;
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
page.on("crash", () => { crashed = true; });

const out = { xml: XML, playbackSeconds: PLAYBACK_SECONDS };
await page.goto(APP + "?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });

// ---------- 1. 导入 ----------
const importT0 = Date.now();
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 600000 });
out.importMs = Date.now() - importT0;
out.importInfo = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const t0 = performance.now();
  await debug.whenNoteRowsIdle(120000);
  const rowsMs = Math.round(performance.now() - t0);
  return {
    notes: state.notes.length,
    parts: new Set(state.notes.map((note) => debug.voiceIdentity(note))).size,
    rows: document.querySelectorAll("#noteList .note-row").length,
    rowsMs,
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    title: document.querySelector("#scoreTitle").textContent,
  };
});

// ---------- 2. 播放 ----------
if (!SKIP_PLAYBACK) {
  out.playback = await page.evaluate(async (monitorSeconds) => {
    const debug = window.__pujian;
    const state = debug.state;
    // 先量「点导出/点播放时最先执行的同步工作」：把播放音符变成音频计划。
    const notes = debug.getPlaybackNotes();
    const baseTempo = Number(document.querySelector("#tempoInput").value) || 84;
    const scoreInfo = state.scoreInfo || {};
    const tempoPlan = debug.playbackTempoSegments(scoreInfo.tempoMarks || [], {
      offset: 0, userBpm: baseTempo, detectedBpm: scoreInfo.tempo,
    });
    const planT0 = performance.now();
    const plan = debug.buildAudioPlan({
      notes,
      tempoSegments: [{ beat: 0, bpm: tempoPlan.startBpm }, ...tempoPlan.segments],
      startBpm: tempoPlan.startBpm,
      enabledParts: null,
      partTimbres: state.partTimbres,
      globalTimbre: state.timbre,
      partVolumes: state.partVolumes,
      partTranspose: new Map(),
      transpose: Number(document.querySelector("#transposeInput").value) || 0,
      selection: null,
      tailSeconds: 2.5,
    });
    const planMs = Math.round(performance.now() - planT0);

    // 主线程卡顿监测（rAF 帧间隔）
    window.__frames = [];
    let lastFrame = performance.now();
    window.__mon = true;
    const raf = () => {
      const now = performance.now();
      window.__frames.push(now - lastFrame);
      lastFrame = now;
      if (window.__mon) requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);

    const t0 = performance.now();
    await debug.playMelody();
    const startMs = Math.round(performance.now() - t0);

    const trace = [];
    const end = performance.now() + monitorSeconds * 1000;
    let silentSince = null;
    let silenceEvents = 0;
    let maxSources = 0;
    let minAhead = 999;
    while (performance.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const stats = state.playbackStats || {};
      const snapshot = {
        t: Math.round(performance.now() - t0),
        sources: state.sources.size,
        cursor: stats.cursor || 0,
        events: stats.events || 0,
        windows: stats.windows || 0,
        ahead: Number((stats.lastAhead || 0).toFixed(2)),
        timers: state.timers.length,
        playing: state.isPlaying,
        ctxTime: Number(state.audio.currentTime.toFixed(1)),
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
    }
    window.__mon = false;
    const gaps = window.__frames.slice();
    debug.stopPlayback();
    const sorted = gaps.slice().sort((a, b) => a - b);
    return {
      planMs,
      startMs,
      planNotes: plan.notes.length,
      planSeconds: Math.round(plan.totalSeconds),
      frames: gaps.length,
      frameP50: Number((sorted[Math.floor(sorted.length * 0.5)] || 0).toFixed(1)),
      frameP95: Number((sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(1)),
      frameMax: Number(Math.max(...gaps).toFixed(1)),
      longFrames100: gaps.filter((gap) => gap > 100).length,
      longFrames250: gaps.filter((gap) => gap > 250).length,
      maxSources,
      minAhead,
      silenceEvents,
      timersAtEnd: state.timers.length,
      traceHead: trace.slice(0, 8),
      traceTail: trace.slice(-3),
    };
  }, PLAYBACK_SECONDS);
}

// ---------- 3. 导出 MP3 ----------
if (!SKIP_EXPORT) {
  await page.evaluate(() => {
    window.__exportFrames = [];
    let last = performance.now();
    window.__monExport = true;
    const raf = () => {
      const now = performance.now();
      window.__exportFrames.push(now - last);
      last = now;
      if (window.__monExport) requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
    window.__exportErrors = [];
    window.__exportDone = false;
    window.__pujian.exportAudio()
      .then(() => { window.__exportDone = true; })
      .catch((error) => { window.__exportErrors.push(String(error)); window.__exportDone = true; });
  });

  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  let timedOut = false;
  let peakHeapMb = 0;
  const phaseLabels = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    if (crashed) break;
    let status = null;
    try {
      status = await page.evaluate(() => ({
        done: window.__exportDone,
        label: document.querySelector("#audioExportLabel") ? document.querySelector("#audioExportLabel").textContent : null,
        progressHidden: document.querySelector("#recognizeProgress") ? document.querySelector("#recognizeProgress").hidden : null,
        stats: window.__pujian.state.lastExportStats || null,
        render: window.__pujian.state.lastRenderStats || null,
        heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      }));
    } catch (error) {
      crashed = true;
      break;
    }
    if (status) {
      if (status.label) phaseLabels.push(status.label);
      if (status.heapMb) peakHeapMb = Math.max(peakHeapMb, status.heapMb);
      if (status.done) break;
    }
  }
  if (!crashed && Date.now() >= deadline) timedOut = true;
  let final = null;
  if (!crashed) {
    try {
      final = await page.evaluate(() => {
        window.__monExport = false;
        const gaps = window.__exportFrames.slice();
        const sorted = gaps.slice().sort((a, b) => a - b);
        return {
          done: window.__exportDone,
          errors: window.__exportErrors,
          frames: gaps.length,
          frameP95: Number((sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(1)),
          frameMax: Number(Math.max(...gaps).toFixed(1)),
          longFrames100: gaps.filter((gap) => gap > 100).length,
          longFrames1000: gaps.filter((gap) => gap > 1000).length,
          freezes: gaps.slice().sort((a, b) => b - a).slice(0, 6).map((gap) => Math.round(gap)),
          stats: window.__pujian.state.lastExportStats || null,
          render: window.__pujian.state.lastRenderStats || null,
          label: document.querySelector("#audioExportLabel") ? document.querySelector("#audioExportLabel").textContent : null,
          dbg: window.__pujian.state.audio ? "AudioContext" : null,
        };
      });
    } catch (error) {
      crashed = true;
    }
  }
  out.export = { timedOut, crashed, peakHeapMb, phaseLabels: [...new Set(phaseLabels)], ...(final || {}) };
}

out.crashed = crashed;
out.errors = errors.slice(0, 5);
out.heapMb = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)).catch(() => null);
console.log(JSON.stringify(out, null, 1));
await browser.close();
