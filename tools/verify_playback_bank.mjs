// 验证「点播放会先等音源加载完」：导入后立刻点播放，量等待时间 & 音源是否已就绪。
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/big-4v-160m.musicxml";
const WAIT = Number(process.env.WAIT || 0);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 300000 });
if (WAIT) await page.waitForTimeout(WAIT);

const result = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const before = [...state.sampleBanks.keys()];
  const t0 = performance.now();
  await debug.playMelody();
  const playMs = Math.round(performance.now() - t0);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const after = [...state.sampleBanks.keys()];
  const playing = state.isPlaying;
  debug.stopPlayback();
  return { playMs, before, after, playing, status: document.querySelector("#sampleStatus") ? document.querySelector("#sampleStatus").textContent : null };
});

await page.waitForTimeout(600);
const logPath = "E:/识谱弹琴/.cache/perf/ui-perf.jsonl";
const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : [];
const bankLoads = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((item) => item && item.event === "bank-load")
  .slice(-5)
  .map((item) => ({ timbre: item.detail.timbre, ms: item.detail.ms, samples: item.detail.samples, partial: item.detail.partial, needed: item.detail.neededMidis, mb: item.detail.bankMb }));
console.log(JSON.stringify({ result, bankLoads }, null, 1));
await browser.close();
