// 比较 wasm LAME 与 lamejs 的 MP3 编码速度（浏览器内真实测量）。
// 用法：$env:PLAYWRIGHT_CORE='...'; node tools/bench_mp3_encoders.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const SECONDS = Number(process.env.SECONDS) || 120;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
page.on("console", (message) => { if (message.type() === "error") console.log("[console error]", message.text().slice(0, 200)); });
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const result = await page.evaluate(async (SECONDS) => {
  const debug = window.__pujian;
  const rate = 44100;
  const frames = Math.ceil(SECONDS * rate);
  // 造一段有内容的立体声（几个正弦 + 噪声，避免极端压缩影响公平性）
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const t = index / rate;
    const value = 0.25 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 440 * t)
      + 0.1 * Math.sin(2 * Math.PI * 880 * t) + 0.03 * Math.sin(2 * Math.PI * 3000 * t);
    left[index] = value * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.5 * t));
    right[index] = value * (0.7 + 0.3 * Math.cos(2 * Math.PI * 0.4 * t));
  }

  const out = { seconds: SECONDS, frames };

  // ---- 1) 现有 lamejs ----
  await debug.loadLame();
  let t0 = performance.now();
  let blob = debug.encodeMp3(left, right);
  out.lamejsMs = Number((performance.now() - t0).toFixed(0));
  out.lamejsKB = Math.round(blob.size / 1024);

  // ---- 2) wasm LAME（CBR 128k，与现有参数一致）----
  t0 = performance.now();
  const module = await import("./vendor/wasm-mp3/wasm-media-encoders.mjs");
  out.importMs = Number((performance.now() - t0).toFixed(0));
  t0 = performance.now();
  const encoder = await module.createEncoder("audio/mpeg", "/vendor/wasm-mp3/mp3.wasm");
  out.createMs = Number((performance.now() - t0).toFixed(0));
  encoder.configure({ sampleRate: rate, channels: 2, bitrate: 128 });
  t0 = performance.now();
  const chunks = [];
  let total = 0;
  const blockSize = rate;   // 每次 1 秒，顺便模拟流式+进度
  for (let offset = 0; offset < frames; offset += blockSize) {
    const end = Math.min(frames, offset + blockSize);
    const mp3 = encoder.encode([left.subarray(offset, end), right.subarray(offset, end)]);
    if (mp3.length) {
      chunks.push(new Uint8Array(mp3));   // 必须复制
      total += mp3.length;
    }
  }
  const tail = encoder.finalize();
  if (tail.length) {
    chunks.push(new Uint8Array(tail));
    total += tail.length;
  }
  out.wasmMs = Number((performance.now() - t0).toFixed(0));
  out.wasmKB = Math.round(total / 1024);
  let merged = new Uint8Array(total);
  let writeAt = 0;
  for (const chunk of chunks) {
    merged.set(chunk, writeAt);
    writeAt += chunk.length;
  }
  out.wasmHeader = Array.from(merged.slice(0, 4));
  out.speedup = Number((out.lamejsMs / Math.max(1, out.wasmMs)).toFixed(1));
  return out;
}, SECONDS);

console.log(JSON.stringify(result, null, 1));
await browser.close();
