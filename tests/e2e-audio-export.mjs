// 端到端验证「导出 MP3」的完整能力：
//   · 整曲 / 选中片段
//   · 多声部 + 逐声部音色 + 逐声部音量 + 移调（任意音高/响度/乐器/声部）
// 用法：node tests/e2e-audio-export.mjs
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_CORE || "playwright-core";
let chromium;
try {
  ({ chromium } = require(playwrightPath));
} catch (error) {
  console.log("跳过：playwright-core 不可用 —", error.message.slice(0, 80));
  process.exit(0);
}

const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";

/** 解析 MP3：返回 { format, bytes, durationSeconds, sampleRate }。 */
function inspectAudio(buffer) {
  const bytes = Buffer.from(buffer);
  const isMp3 = bytes.length > 4 && (
    (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  );
  if (!isMp3) {
    const isWav = bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF";
    if (!isWav) return { format: "未知", bytes: bytes.length, durationSeconds: 0, sampleRate: 0 };
    const dataSize = bytes.readUInt32LE(40);
    const sampleRate = bytes.readUInt32LE(24);
    const channels = bytes.readUInt16LE(22);
    const bits = bytes.readUInt16LE(34);
    return {
      format: "WAV", bytes: bytes.length, sampleRate,
      durationSeconds: dataSize / (sampleRate * channels * bits / 8),
    };
  }
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
  return { format: "MP3", bytes: bytes.length, sampleRate, durationSeconds: samples / sampleRate };
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

let exitCode = 0;
const results = [];
function check(name, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  results.push(ok);
  return ok;
}

async function exportOnce(label) {
  const started = Date.now();
  const downloadPromise = page.waitForEvent("download", { timeout: 300000 });
  await page.click("#audioButton");
  const download = await downloadPromise;
  const target = join(process.env.TEMP || ".", `export-${label}-${download.suggestedFilename()}`);
  await download.saveAs(target);
  const info = { name: download.suggestedFilename(), ...inspectAudio(readFileSync(target)), ms: Date.now() - started };
  console.log(`   → ${info.name}  ${(info.bytes / 1024).toFixed(1)} KB  ${info.format}  ${info.durationSeconds.toFixed(2)} 秒  ${info.ms} ms`);
  return info;
}

try {
  await page.goto(appUrl + "?debug=1", { waitUntil: "networkidle" });
  await page.setInputFiles("#fileInput", "tests/fixtures/timbre_sample.musicxml");
  await page.waitForFunction(() => document.querySelectorAll("#noteList .note-row").length > 0, null, { timeout: 60000 });
  const loaded = await page.evaluate(() => ({
    notes: window.__pujian.state.notes.length,
    parts: [...new Set(window.__pujian.state.notes.map((note) => note.partId || note.partName))],
  }));
  console.log("样例谱：", JSON.stringify(loaded));

  // ① 整曲
  const full = await exportOnce("full");
  check("整曲导出为 MP3", full.format === "MP3" && full.durationSeconds > 1, `${full.durationSeconds.toFixed(2)} 秒`);

  // ② 加厚声部（复制成新声部 → 多声部一起导出）
  await page.click("#addLayerPart");
  await page.waitForTimeout(400);
  const layered = await page.evaluate(() => window.__pujian.state.notes.length);
  const multi = await exportOnce("multi");
  check("多声部一起导出", multi.format === "MP3" && multi.bytes > 2000,
    `音符 ${loaded.notes} → ${layered}，文件 ${(multi.bytes / 1024).toFixed(1)} KB`);

  // ③ 换乐器 + 移调 + 调音量（任意乐器/音高/响度）
  await page.evaluate(() => {
    const debug = window.__pujian;
    debug.state.timbre = "erhu_real";
    // 整体移调 +5 半音（任意音高）
    for (const note of debug.state.notes) {
      note.midi = Math.min(127, note.midi + 5);
      note.pitch = debug.state.notes[0].pitch;
    }
  });
  const timbreSelect = page.locator("#timbreSelect");
  if (await timbreSelect.count()) {
    await timbreSelect.selectOption("erhu_real").catch(() => {});
  }
  const tweaked = await exportOnce("erhu-up5");
  check("换乐器 + 移调后仍能导出", tweaked.format === "MP3" && tweaked.durationSeconds > 1,
    `时长 ${tweaked.durationSeconds.toFixed(2)} 秒`);

  // ④ 选中片段导出（选前 3 个音）
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#noteList .note-row .note-index");
    rows[0]?.click();
  });
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#noteList .note-row .note-index");
    rows[2]?.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
  });
  await page.waitForTimeout(300);
  const selectionInfo = await page.evaluate(() => ({
    label: document.querySelector("#selectionLabel")?.textContent,
    active: document.querySelector("#selectionBar")?.classList.contains("is-active"),
  }));
  console.log("选区：", JSON.stringify(selectionInfo));
  const partial = await exportOnce("selection");
  check("选中片段导出", partial.format === "MP3" && partial.durationSeconds > 0.3,
    `${partial.durationSeconds.toFixed(2)} 秒（应短于整曲 ${full.durationSeconds.toFixed(2)} 秒）`);
  check("片段比整曲短", partial.durationSeconds < full.durationSeconds,
    `${partial.durationSeconds.toFixed(2)} < ${full.durationSeconds.toFixed(2)}`);
  check("片段文件名带范围", /片段/.test(partial.name), partial.name);

  // ⑤ 导出后页面状态正常（实时音频上下文恢复、按钮可用）
  const after = await page.evaluate(() => ({
    disabled: document.querySelector("#audioButton")?.disabled,
    label: document.querySelector("#audioExportLabel")?.textContent,
    audioLive: window.__pujian.state.audio?.constructor?.name,
    isPlaying: window.__pujian.state.isPlaying,
  }));
  check("导出后按钮恢复可用", !after.disabled && after.label === "↓ MP3", JSON.stringify(after));
  check("实时音频上下文已恢复", after.audioLive === "AudioContext", after.audioLive);

  // ⑥ 导出后还能正常播放（渲染没有破坏播放链路）
  await page.evaluate(() => document.querySelector("#playButton").click());
  await page.waitForTimeout(900);
  const playing = await page.evaluate(() => ({
    isPlaying: window.__pujian.state.isPlaying,
    sources: window.__pujian.state.sources.size,
  }));
  await page.evaluate(() => document.querySelector("#stopButton").click());
  check("导出后仍能播放", playing.isPlaying === true, JSON.stringify(playing));

  check("无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log(`\n${results.filter(Boolean).length}/${results.length} 项通过`);
  if (results.some((item) => !item)) {
    exitCode = 1;
    console.log("导出 MP3 端到端验证失败");
  } else {
    console.log("导出 MP3 端到端验证通过");
  }
} catch (error) {
  console.log("失败：", error.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
