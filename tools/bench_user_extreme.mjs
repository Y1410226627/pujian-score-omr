// 极端场景基准（复现用户真实用法）：
//   · 80 个声部 / 20 万音符 / 30 分钟的乐谱；
//   · 给前 74 个声部各配一种不同的真实采样音色（和用户日志里 74 种音色完全一致）；
//   · 量导入、音源内存、播放（卡顿/没声/掉队）、导出（全声部 30 分钟）。
//
// 用法：
//   $env:PLAYWRIGHT_CORE=...; $env:APP_URL=http://127.0.0.1:4492/
//   $env:MODE='import'|'playback'|'export'|'all'
//   node tools/bench_user_extreme.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/extreme-80v-630m-d8.musicxml";
const MODE = process.env.MODE || "all";
const TIMBRES = Number(process.env.TIMBRES || 74);
const PLAYBACK_SECONDS = Number(process.env.PLAYBACK_SECONDS || 25);
const EXPORT_TIMEOUT_MS = Number(process.env.EXPORT_TIMEOUT_MS || 900000);
const INSTRUMENTS = ["piano_real", "erhu_real", "zhonghu_real", "gaohu_real", "pipa_real", "zhongruan_real",
  "daruan_real", "liuqin_real", "guzheng_real", "yangqin_real", "dizi_real", "qudi_real",
  "xiao_real", "sheng_real", "suona_real", "guanzi_real", "hulusi_real_placeholder"].filter((name) => name.indexOf("placeholder") < 0);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
page.on("crash", () => errors.push("CRASH"));
await page.goto(APP + "?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });

const out = { xml: XML, mode: MODE };
const t0 = Date.now();
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 600000 });
out.importMs = Date.now() - t0;
out.importInfo = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  await debug.whenNoteRowsIdle(180000);
  return {
    notes: state.notes.length,
    parts: new Set(state.notes.map((note) => debug.voiceIdentity(note))).size,
    rowsRendered: document.querySelectorAll("#noteList .note-row").length,
    rowLimit: debug.NOTE_ROW_RENDER_LIMIT,
    banner: document.querySelector("#noteLimitBanner") ? document.querySelector("#noteLimitBanner").textContent : null,
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  };
});
console.log("IMPORT", JSON.stringify(out.importInfo));

if (MODE === "playback" || MODE === "all") {
  // 给前 TIMBRES 个声部各配一种不同的真实采样音色（模拟用户日志里的 74 种乐器）
  out.assignTimbres = await page.evaluate(async (count) => {
    const debug = window.__pujian;
    const state = debug.state;
    const names = ["piano_real", "erhu_real", "zhonghu_real", "gaohu_real", "pipa_real", "zhongruan_real",
      "daruan_real", "liuqin_real", "guzheng_real", "yangqin_real", "dizi_real", "qudi_real",
      "xiao_real", "sheng_real", "suona_real", "guanzi_real", "xun_real", "yunluo_real", "bo_real",
      "xiaoluo_real", "daluo_real", "paigu_real", "muyu_real", "pengling_real", "harp_real", "cello_real",
      "viola_real", "violin_real", "contrabass_real", "flute_real", "clarinet_real", "oboe_real",
      "bassoon_real", "trumpet_real", "trombone_real", "tuba_real", "french_horn_real", "brass_section_real",
      "soprano_sax_real", "alto_sax_real", "tenor_sax_real", "baritone_sax_real", "nylon_guitar_real",
      "steel_guitar_real", "electric_guitar_real", "banjo_real", "sitar_real", "shamisen_real", "koto_real",
      "kalimba_real", "acoustic_bass_real", "electric_bass_real", "fretless_bass_real", "marimba_real",
      "xylophone_real", "glockenspiel_real", "celesta_real", "tubular_bells_real", "steel_drums_real",
      "timpani_real", "accordion_real", "church_organ_real", "electric_piano_real", "harpsichord_real",
      "vibraphone_real", "pad_real", "voice_oohs_real", "synth_choir_real", "choir_female", "choir_male",
      "choir_real", "strings_real", "pizzicato_real", "tremolo_real", "whistle_real", "shakuhachi_real",
      "recorder_real", "ocarina_real", "pan_flute_real", "piccolo_real", "english_horn_real", "synth_lead_real"];
    const partKeys = [...new Set(state.notes.map((note) => debug.voiceIdentity(note)))];
    const t0 = performance.now();
    const assignment = [];
    for (let index = 0; index < Math.min(count, partKeys.length); index += 1) {
      const timbre = names[index % names.length];
      debug.setPartTimbre(partKeys[index], timbre);
      assignment.push([partKeys[index], timbre]);
    }
    // 等所有后台加载结束
    const until = performance.now() + 300000;
    while (performance.now() < until) {
      if (state.sampleLoading.size === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let mb = 0;
    for (const bank of state.sampleBanks.values()) {
      for (const layer of bank.layers) for (const sample of layer.samples) if (sample.buffer) mb += sample.buffer.length * 4;
    }
    return {
      assignMs: Math.round(performance.now() - t0),
      assigned: assignment.length,
      loadedBanks: state.sampleBanks.size,
      maxBanks: debug.MAX_LOADED_SAMPLE_BANKS,
      bankMemoryMb: Math.round(mb / 1048576),
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      plan: (() => {
        const plan = debug.buildPlaybackTimbrePlan();
        return { parts: plan.partTimbre.size, sampledCount: plan.sampledCount, keep: plan.keep.size, degraded: plan.degraded.size };
      })(),
    };
  }, TIMBRES);
  console.log("ASSIGN", JSON.stringify(out.assignTimbres));

  out.playback = await page.evaluate(async (monitorSeconds) => {
    const debug = window.__pujian;
    const state = debug.state;
    const frames = [];
    let last = performance.now();
    let running = true;
    const raf = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
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
    const end = performance.now() + monitorSeconds * 1000;
    while (performance.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const stats = state.playbackStats || {};
      const snapshot = {
        t: Math.round(performance.now() - t0),
        sources: state.sources.size,
        cursor: stats.cursor || 0,
        events: stats.events || 0,
        ahead: Number((stats.lastAhead || 0).toFixed(2)),
        timers: state.timers.length,
        playing: state.isPlaying,
        ctx: Number(state.audio.currentTime.toFixed(1)),
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
    running = false;
    const stats = state.playbackStats || {};
    const gaps = frames.slice();
    const sorted = gaps.slice().sort((a, b) => a - b);
    const result = {
      startMs,
      monitorSeconds,
      notesPerSecond: stats.notesPerSecond,
      aheadSeconds: stats.aheadSeconds,
      tickMs: stats.tickMs,
      frameP50: Number((sorted[Math.floor(sorted.length * 0.5)] || 0).toFixed(1)),
      frameP95: Number((sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(1)),
      frameMax: Number(Math.max(...gaps).toFixed(1)),
      longFrames100: gaps.filter((gap) => gap > 100).length,
      longFrames250: gaps.filter((gap) => gap > 250).length,
      maxSources,
      minAhead,
      silenceEvents,
      maxTickGapMs: state.playbackWatch ? Math.round(state.playbackWatch.maxTickGap) : null,
      starved: state.playbackWatch ? state.playbackWatch.starved : null,
      suspended: state.playbackWatch ? state.playbackWatch.suspended : null,
      banksDuringPlay: state.sampleBanks.size,
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      traceHead: trace.slice(0, 6),
      traceTail: trace.slice(-3),
    };
    debug.stopPlayback();
    return result;
  }, PLAYBACK_SECONDS);
  console.log("PLAYBACK", JSON.stringify(out.playback));
}

if (MODE === "export" || MODE === "all") {
  // 导出全声部（30 分钟）——最极端情况
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
    window.__pujian.state.selectedParts = null;   // 全部声部
    window.__pujian.exportAudio()
      .then(() => { window.__exportDone = true; })
      .catch((error) => { window.__exportErrors.push(String(error)); window.__exportDone = true; });
  });
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  let timedOut = false;
  const labels = [];
  let peakHeapMb = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    if (errors.length) break;
    let status = null;
    try {
      status = await page.evaluate(() => ({
        done: window.__exportDone,
        label: document.querySelector("#audioExportLabel") ? document.querySelector("#audioExportLabel").textContent : null,
        heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      }));
    } catch (error) {
      errors.push("evaluate failed: " + error.message);
      break;
    }
    if (status) {
      if (status.label && labels[labels.length - 1] !== status.label) labels.push(status.label);
      if (status.heapMb) peakHeapMb = Math.max(peakHeapMb, status.heapMb);
      if (status.done) break;
    }
    if (Date.now() >= deadline) timedOut = true;
  }
  out.export = await page.evaluate(() => {
    window.__monExport = false;
    const gaps = window.__exportFrames.slice();
    const sorted = gaps.slice().sort((a, b) => a - b);
    return {
      done: window.__exportDone,
      errors: window.__exportErrors,
      frameP95: Number((sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(1)),
      frameMax: Number(Math.max(...gaps).toFixed(1)),
      longFrames100: gaps.filter((gap) => gap > 100).length,
      freezes: gaps.slice().sort((a, b) => b - a).slice(0, 6).map((gap) => Math.round(gap)),
      stats: window.__pujian.state.lastExportStats || null,
      render: window.__pujian.state.lastRenderStats || null,
      banksAfter: window.__pujian.state.sampleBanks.size,
    };
  });
  out.export.timedOut = timedOut;
  out.export.peakHeapMb = peakHeapMb;
  out.export.labels = labels.slice(0, 20);
  console.log("EXPORT", JSON.stringify(out.export));
}

out.errors = errors;
console.log("SUMMARY", JSON.stringify(out));
await browser.close();
process.exitCode = errors.length ? 1 : 0;
