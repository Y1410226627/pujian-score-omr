// 用真实长曲子验证导出：Hall 曲（1777 音符、22 处变速）。
// 校验：导出的 MP3 时长应与「按分段速度算出的理论时长」吻合（±8%），
// 这同时证明「变速」和「片段/整曲」在导出链路里都是对的。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";

function mp3Duration(buffer) {
  const bytes = Buffer.from(buffer);
  let offset = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    offset = 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f));
  }
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const rates = [44100, 48000, 32000];
  let samples = 0;
  let sampleRate = 44100;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) { offset += 1; continue; }
    const version = (bytes[offset + 1] >> 3) & 0x03;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
    const rateIndex = (bytes[offset + 2] >> 2) & 0x03;
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) { offset += 1; continue; }
    sampleRate = rates[rateIndex];
    const samplesPerFrame = version === 3 ? 1152 : 576;
    const frameLength = Math.floor((samplesPerFrame / 8 * bitrates[bitrateIndex] * 1000) / sampleRate) + padding;
    if (frameLength <= 4) break;
    samples += samplesPerFrame;
    offset += frameLength;
  }
  return samples / sampleRate;
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
let exitCode = 0;

try {
  await page.goto(appUrl + "?debug=1", { waitUntil: "networkidle" });
  await page.setInputFiles("#fileInput", process.env.PDF);
  await page.waitForFunction(() => !document.querySelector("#recognizeAllButton").hidden, null, { timeout: 90000 });
  console.log("识别中（约 1 分钟）…");
  await page.click("#recognizeAllButton");
  await page.waitForSelector("#recognizeProgress[hidden]", { state: "attached", timeout: 1800000 });

  const state = await page.evaluate(() => {
    const info = window.__pujian.state.scoreInfo;
    return {
      notes: window.__pujian.state.notes.length,
      measures: info.measureCount,
      bpm: document.querySelector("#tempoInput").value,
      timeInfo: document.querySelector("#scoreDetails")?.textContent,
      marks: (info.tempoMarks || []).length,
      lastBeat: Math.max(...window.__pujian.state.notes.map((n) => (n.startBeat || 0) + (n.durationBeats || 1))),
    };
  });
  console.log("识别结果：", JSON.stringify(state));

  const started = Date.now();
  const promise = page.waitForEvent("download", { timeout: 1200000 });
  await page.click("#audioButton");
  const download = await promise;
  const target = join(process.env.TEMP || ".", "hall-export.mp3");
  await download.saveAs(target);
  const elapsed = (Date.now() - started) / 1000;
  const bytes = readFileSync(target);
  const duration = mp3Duration(bytes);
  console.log(`导出完成：${download.suggestedFilename()} ${(bytes.length / 1024 / 1024).toFixed(2)} MB，` +
    `时长 ${duration.toFixed(1)} 秒，耗时 ${elapsed.toFixed(1)} 秒`);

  // 理论时长：按分段速度从 0 拍算到最后拍
  const theory = await page.evaluate(() => {
    const debug = window.__pujian;
    const info = debug.state.scoreInfo;
    const marks = [{ beat: 0, bpm: Number(document.querySelector("#tempoInput").value) }, ...(info.tempoMarks || [])];
    marks.sort((a, b) => a.beat - b.beat);
    const lastBeat = Math.max(...debug.state.notes.map((n) => (n.startBeat || 0) + (n.durationBeats || 1)));
    let seconds = 0; let previous = 0; let bpm = marks[0].bpm;
    for (const mark of marks) {
      if (mark.beat >= lastBeat) break;
      seconds += (mark.beat - previous) * (60 / bpm);
      previous = mark.beat; bpm = mark.bpm;
    }
    return seconds + (lastBeat - previous) * (60 / bpm);
  });
  console.log(`理论时长（按分段速度）：${theory.toFixed(1)} 秒；导出实际：${duration.toFixed(1)} 秒`);

  const diff = Math.abs(duration - theory) / theory;
  const ok = diff < 0.08 && duration > 30 && bytes.length > 500000;
  console.log(ok
    ? `OK   时长与分段速度吻合（偏差 ${(diff * 100).toFixed(1)}%）`
    : `FAIL 时长偏差 ${(diff * 100).toFixed(1)}% 或文件过小`);
  if (!ok) exitCode = 1;

  // 片段导出：应明显短于整曲
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#noteList .note-row .note-index");
    rows[0]?.click();
  });
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#noteList .note-row .note-index");
    rows[40]?.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
  });
  await page.waitForTimeout(400);
  const piecePromise = page.waitForEvent("download", { timeout: 600000 });
  await page.click("#audioButton");
  const piece = await piecePromise;
  const piecePath = join(process.env.TEMP || ".", "hall-piece.mp3");
  await piece.saveAs(piecePath);
  const pieceDuration = mp3Duration(readFileSync(piecePath));
  console.log(`片段导出：${piece.suggestedFilename()} ${pieceDuration.toFixed(1)} 秒`);
  if (pieceDuration < duration * 0.05 || pieceDuration >= duration) {
    console.log("FAIL 片段时长不合理");
    exitCode = 1;
  } else {
    console.log(`OK   片段明显短于整曲（${(pieceDuration / duration * 100).toFixed(1)}%）`);
  }

  console.log("页面错误：", errors.length ? errors.slice(0, 3) : "无");
  console.log(exitCode === 0 ? "\n真实长曲子导出验证通过" : "\n真实长曲子导出验证失败");
} catch (error) {
  console.log("失败：", error.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
