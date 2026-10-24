// wasm 编码器：主线程 vs Worker 的速度对比（600 秒立体声）。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const SECONDS = Number(process.env.SECONDS) || 600;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
page.on("console", (message) => { if (message.type() === "error") console.log("[err]", message.text().slice(0, 160)); });
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const out = await page.evaluate(async (SECONDS) => {
  const debug = window.__pujian;
  const rate = 44100;
  const frames = Math.ceil(SECONDS * rate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const v = 0.25 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * Math.sin(2 * Math.PI * 3000 * t);
    left[i] = v;
    right[i] = v * 0.9;
  }
  const result = { frames };
  // Worker 路径（复制一份，因为 transfer 会 detach）
  const leftCopy = left.slice();
  const rightCopy = right.slice();
  let t0 = performance.now();
  const blob = await debug.encodeMp3WithWorker(leftCopy, rightCopy, {});
  result.workerMs = Math.round(performance.now() - t0);
  result.workerKB = Math.round(blob.size / 1024);
  // 主线程 wasm（通过模块直接跑）
  const module = await import("./vendor/wasm-mp3/wasm-media-encoders.mjs");
  const encoder = await module.createEncoder("audio/mpeg", "/vendor/wasm-mp3/mp3.wasm");
  encoder.configure({ sampleRate: rate, channels: 2, bitrate: 128 });
  t0 = performance.now();
  const blocksize = rate;
  let total = 0;
  for (let offset = 0; offset < frames; offset += blocksize) {
    const end = Math.min(frames, offset + blocksize);
    const data = encoder.encode([left.subarray(offset, end), right.subarray(offset, end)]);
    total += data.length;
  }
  total += encoder.finalize().length;
  result.mainMs = Math.round(performance.now() - t0);
  result.mainKB = Math.round(total / 1024);
  return result;
}, SECONDS);
console.log(JSON.stringify(out, null, 1));
await browser.close();
