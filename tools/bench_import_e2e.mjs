// 导入识别端到端计时：单页「识别乐谱」与整本「识别全部页」。
//
// 用法：
//   $env:PDF='E:/识谱弹琴/.cache/perf/import-8p-lowres.pdf'; node tools/bench_import_e2e.mjs
//   $env:MODE='single'   只测单页；MODE='batch' 只测整本；默认两个都测
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const PDF = process.env.PDF || "E:/识谱弹琴/.cache/perf/import-8p-lowres.pdf";
const MODE = process.env.MODE || "both";

const browser = await chromium.launch({ channel: "msedge", headless: true });

async function runPage(kind) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
  await page.setInputFiles("#fileInput", PDF);
  await page.waitForFunction(() => !document.querySelector("#recognizeAllButton").hidden, null, { timeout: 120000 });
  await page.waitForTimeout(500);
  const started = Date.now();
  if (kind === "single") await page.click("#recognizeButton");
  else await page.click("#recognizeAllButton");
  // 先等「识别中」真的开始（否则进度条本来就隐藏，waitForSelector 会立即返回），再等结束
  await page.waitForFunction(() => {
    const debug = window.__pujian;
    return debug && (debug.state.isRecognizing === true
      || !document.querySelector("#recognizeProgress").hidden
      || !document.querySelector("#processingOverlay").hidden);
  }, null, { timeout: 60000 });
  await page.waitForFunction(() => {
    const debug = window.__pujian;
    return debug && debug.state.isRecognizing === false
      && document.querySelector("#recognizeProgress").hidden
      && document.querySelector("#processingOverlay").hidden;
  }, null, { timeout: 1800000 });
  const elapsed = (Date.now() - started) / 1000;
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const debug = window.__pujian;
    const info = debug.state.scoreInfo || {};
    const text = (document.querySelector("#scoreDetails") || {}).textContent || "";
    return {
      notes: debug.state.notes.length,
      measures: info.measureCount,
      parts: (info.partNames || []).length,
      timeSummary: info.timeSummary,
      bpm: document.querySelector("#tempoInput").value,
      detail: text.slice(0, 140),
      recognizedSource: debug.state.recognitionSource,
    };
  });
  await page.close();
  return { kind, seconds: Number(elapsed.toFixed(1)), errors, ...result };
}

const out = {};
if (MODE === "both" || MODE === "single") out.single = await runPage("single");
if (MODE === "both" || MODE === "batch") out.batch = await runPage("batch");
console.log(JSON.stringify(out, null, 1));
await browser.close();
