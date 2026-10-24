// 验证「大内存机器后台预加载全部音源」：多久加载完、占多少内存、切音色/播放是否 0 等待。
// 用法：$env:PLAYWRIGHT_CORE=...; node tools/bench_full_preload.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const TIMEOUT_MS = Number(process.env.PRELOAD_TIMEOUT_MS || 300000);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });

const hardware = await page.evaluate(() => {
  const debug = window.__pujian;
  return {
    hardware: debug.HARDWARE,
    bigMemory: debug.BIG_MEMORY,
    maxBanks: debug.MAX_LOADED_SAMPLE_BANKS,
    budgetMb: debug.SAMPLE_BANK_MEMORY_BUDGET_MB,
    playbackMaxTimbres: debug.PLAYBACK_MAX_TIMBRES,
    exportMaxTimbres: debug.EXPORT_MAX_TIMBRES,
    rowLimit: debug.NOTE_ROW_RENDER_LIMIT,
    installedBanks: Object.keys(window.__pujian.state.sampleManifest.banks).length,
  };
});
console.log("HARDWARE", JSON.stringify(hardware));

const startedAt = Date.now();
let last = null;
while (Date.now() - startedAt < TIMEOUT_MS) {
  const status = await page.evaluate(() => {
    const debug = window.__pujian;
    const state = debug.state;
    let mb = 0;
    for (const bank of state.sampleBanks.values()) {
      for (const layer of bank.layers) for (const sample of layer.samples) if (sample.buffer) mb += sample.buffer.length * 4;
    }
    return {
      preload: { ...state.fullBankPreload },
      loadedBanks: state.sampleBanks.size,
      loadingNow: state.sampleLoading.size,
      bankMemoryMb: Math.round(mb / 1048576),
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      status: document.querySelector("#sampleStatus") ? document.querySelector("#sampleStatus").textContent : null,
    };
  });
  last = status;
  if (!status.preload.running && status.preload.done > 0) break;
  if (status.preload.done && status.preload.done % 20 === 0 && status.preload.done !== (globalThis.__lastDone || -1)) {
    globalThis.__lastDone = status.preload.done;
    console.log("PROGRESS", JSON.stringify(status));
  }
  await page.waitForTimeout(1000);
}
const preloadMs = Date.now() - startedAt;

// 预加载完成后：切音色/播放是否 0 等待（不导入乐谱，直接测 preloadTimbreBank 命中）
const after = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const switchT0 = performance.now();
  await debug.preloadTimbreBank("violin_real");
  const switchMs = Math.round(performance.now() - switchT0);
  const switch2T0 = performance.now();
  await debug.preloadTimbreBank("piano_real");
  const switch2Ms = Math.round(performance.now() - switch2T0);
  const ensureT0 = performance.now();
  await debug.ensurePlaybackTimbres();
  return {
    switchMs,
    switch2Ms,
    ensurePlaybackMs: Math.round(performance.now() - ensureT0),
    loadedBanks: state.sampleBanks.size,
    preload: { ...state.fullBankPreload },
  };
});

console.log("RESULT", JSON.stringify({
  preloadMs,
  last,
  after,
  hardware,
}, null, 1));
await browser.close();
