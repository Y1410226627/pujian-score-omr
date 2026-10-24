// 验证本轮两件事：
//   1) 「切换音源之后、点播放之前」音源已经加载好（换音色即后台按需预加载，点播放 0 毫秒准备）；
//   2) 「重复出现的声部音源只加载一次」（4 个声部同一音色、复制成新声部、两个声部同一音色都只解码一遍）。
//
// 用法：先启动 serve.py，然后
//   $env:PLAYWRIGHT_CORE=...; $env:APP_URL=http://127.0.0.1:4492/; node tools/verify_bank_preload.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/big-4v-160m.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// 采样文件请求记录：浏览器磁盘缓存命中也会触发 request 事件，所以只看「同一次加载里有没有
// 同一个 URL 被请求两次」——那才说明真的重复下载/重复解码。
const sampleRequestLog = [];
page.on("request", (request) => {
  const url = request.url();
  if (url.includes("/.assets/soundfonts/")) sampleRequestLog.push(url);
});
page.on("pageerror", (error) => console.log("pageerror:", error.message));

/** 某段请求窗口的统计：{ total, unique, duplicateFiles, duplicates } */
function requestWindow(from) {
  const slice = sampleRequestLog.slice(from);
  const counts = new Map();
  for (const url of slice) counts.set(url, (counts.get(url) || 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  return { total: slice.length, unique: counts.size, duplicateFiles: duplicates.length, duplicates: duplicates.slice(0, 5) };
}

const out = {};
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });
const markImport = sampleRequestLog.length;
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 300000 });

// 页面内小工具：清缓存、等加载就绪、读快照/状态栏。
await page.evaluate(() => {
  window.__bench = {
    reset() {
      const state = window.__pujian.state;
      state.sampleBanks.clear();
      state.sampleOrder = [];
      state.bankLoadLog.length = 0;
    },
    async waitIdle(timeout = 40000) {
      const state = window.__pujian.state;
      const until = performance.now() + timeout;
      while (performance.now() < until) {
        if (state.sampleLoading.size === 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    },
    async waitReady(name, timeout = 40000) {
      const state = window.__pujian.state;
      const until = performance.now() + timeout;
      while (performance.now() < until) {
        const bank = state.sampleBanks.get(name);
        if (bank && bank.ready) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    },
    loadsFor(name) {
      return window.__pujian.state.bankLoadLog.filter((item) => item.timbre === name);
    },
    sampleStatus() {
      const element = document.querySelector("#sampleStatus");
      return element ? element.textContent : null;
    },
    partKeys() {
      return [...new Set(window.__pujian.state.notes.map((note) => window.__pujian.voiceIdentity(note)))];
    },
  };
});

// ---------- 场景 1：导入后自动后台预加载（不点播放就开始加载），重复声部只加载一次 ----------
out.importPreload = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const t0 = performance.now();
  // 等 scheduleTimbrePreload（commitScore 后 1.5 秒）真的开始加载，再等加载完
  let preloadStartMs = null;
  const until = performance.now() + 12000;
  while (performance.now() < until) {
    if (state.sampleLoading.size > 0 || state.sampleBanks.size > 0) { preloadStartMs = Math.round(performance.now() - t0); break; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await window.__bench.waitIdle(40000);
  const readyMs = Math.round(performance.now() - t0);
  const snapshot = debug.sampleSnapshot();
  const ensureT0 = performance.now();
  await debug.ensurePlaybackTimbres();
  return {
    preloadStartMs,
    readyMs,
    noteCount: state.notes.length,
    partCount: window.__bench.partKeys().length,
    loads: snapshot.loads,
    ready: snapshot.ready,
    ensurePlaybackMs: Math.round(performance.now() - ensureT0),
    status: window.__bench.sampleStatus(),
  };
});
out.importPreload.requests = requestWindow(markImport);

// ---------- 场景 2：整库加载（旧行为的耗时基线）vs 换音色后台按需加载（新行为） ----------
out.fullLoadBaseline = await page.evaluate(async () => {
  const debug = window.__pujian;
  await window.__bench.waitIdle();
  window.__bench.reset();
  const t0 = performance.now();
  const bank = await debug.ensureSampleBank("piano_real", { reason: "bench-full" });
  const ms = Math.round(performance.now() - t0);
  let totalSamples = 0;
  for (const layer of bank ? bank.layers : []) totalSamples += layer.samples.length;
  return { ms, totalSamples, loadedMidis: bank && bank.loadedMidis ? bank.loadedMidis.size : 0 };
});

const markColdSwitch = sampleRequestLog.length;
out.coldSwitchPiano = await page.evaluate(async () => {
  const debug = window.__pujian;
  await window.__bench.waitIdle();
  window.__bench.reset();
  const t0 = performance.now();
  debug.setTimbre("piano_real");          // 只切换音色，不点播放
  const statusDuring = window.__bench.sampleStatus();
  await window.__bench.waitReady("piano_real");
  const switchReadyMs = Math.round(performance.now() - t0);
  const playT0 = performance.now();
  await debug.ensurePlaybackTimbres();    // 相当于「点播放前」这一步
  const playPrepareMs = Math.round(performance.now() - playT0);
  return {
    switchReadyMs,
    playPrepareMs,
    statusDuring,
    statusAfter: window.__bench.sampleStatus(),
    loads: window.__bench.loadsFor("piano_real"),
  };
});
out.coldSwitchPiano.requests = requestWindow(markColdSwitch);

// ---------- 场景 3：切到没缓存过的音源，然后「立刻」点播放（不等加载完） ----------
out.playRightAfterSwitch = await page.evaluate(async () => {
  const debug = window.__pujian;
  await window.__bench.waitIdle();
  window.__bench.reset();
  debug.setTimbre("strings_real");        // 换完立刻点播放，不给它加载时间
  const t0 = performance.now();
  await debug.playMelody();
  const playStartMs = Math.round(performance.now() - t0);
  const playing = debug.state.isPlaying;
  debug.stopPlayback();
  return { playStartMs, playing, loads: window.__bench.loadsFor("strings_real"), readyAfter: debug.sampleSnapshot().ready };
});

// ---------- 场景 4：复制成新声部（重复声部）不重复加载音源 ----------
out.duplicatePartNoReload = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  await window.__bench.waitIdle();
  const beforeLoads = state.bankLoadLog.length;
  const created = [];
  const duplicateMs = [];
  for (let index = 0; index < 2; index += 1) {
    const t0 = performance.now();
    const result = debug.duplicatePart(window.__bench.partKeys()[0], {});
    duplicateMs.push(Math.round(performance.now() - t0));
    created.push(result ? result.key : null);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await window.__bench.waitIdle();
  const t1 = performance.now();
  await debug.ensurePlaybackTimbres();
  return {
    created,
    duplicateMs,
    newLoads: state.bankLoadLog.length - beforeLoads,
    ensurePlaybackMs: Math.round(performance.now() - t1),
    noteCount: state.notes.length,
  };
});

// ---------- 场景 5：两个声部（含复制出来的重复声部）选同一个音源 → 只加载一次 ----------
const markTwoParts = sampleRequestLog.length;
out.twoPartsSameTimbre = await page.evaluate(async () => {
  const debug = window.__pujian;
  await window.__bench.waitIdle();
  window.__bench.reset();
  const keys = window.__bench.partKeys();
  const target = keys.find((key) => key.endsWith("-layer1")) || keys[1];
  const t0 = performance.now();
  debug.setPartTimbre(keys[0], "choir_female");
  debug.setPartTimbre(target, "choir_female");   // 同一个音源，第二次应该并入同一个加载 Promise
  await window.__bench.waitReady("choir_female");
  const readyMs = Math.round(performance.now() - t0);
  await window.__bench.waitIdle();
  return {
    parts: [keys[0], target],
    readyMs,
    loads: window.__bench.loadsFor("choir_female"),
    status: window.__bench.sampleStatus(),
  };
});
out.twoPartsSameTimbre.requests = requestWindow(markTwoParts);

// ---------- 场景 6：逐声部换音色也会提前加载好（点播放 0 毫秒准备） ----------
out.partTimbrePreload = await page.evaluate(async () => {
  const debug = window.__pujian;
  await window.__bench.waitIdle();
  window.__bench.reset();
  const key = window.__bench.partKeys()[1] || window.__bench.partKeys()[0];
  const t0 = performance.now();
  const accepted = debug.setPartTimbre(key, "nylon_guitar_real");
  await window.__bench.waitReady("nylon_guitar_real");
  const switchReadyMs = Math.round(performance.now() - t0);
  const playT0 = performance.now();
  await debug.ensurePlaybackTimbres();
  return { part: key, accepted, switchReadyMs, playPrepareMs: Math.round(performance.now() - playT0), loads: window.__bench.loadsFor("nylon_guitar_real") };
});

// ---------- 场景 7：切回已经加载过的音源 → 0 毫秒、不重新解码 ----------
out.switchBackCached = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  await window.__bench.waitIdle();
  window.__bench.reset();
  await debug.ensureSampleBank("piano_real", { reason: "bench-cache" });
  state.bankLoadLog.length = 0;                 // 只清日志，不清缓存
  const t0 = performance.now();
  debug.setTimbre("piano_real");                // 切回已加载过的音源
  const result = await debug.preloadTimbreBank("piano_real");
  const ms = Math.round(performance.now() - t0);
  const newLoads = window.__bench.loadsFor("piano_real").length;
  return { ms, newLoads, cached: Boolean(result.bank && result.bank.ready) };
});

out.networkNote = "每个场景单独统计请求窗口；场景 1/2/5 的请求应「每个采样文件只请求一次」。";

console.log(JSON.stringify(out, null, 1));
await browser.close();
