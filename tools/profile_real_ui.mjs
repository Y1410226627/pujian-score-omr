// 真实大谱 UI 压测：导入 / 复制声部 / 切八度 / 导出，并可用 CPU 降速模拟弱电脑。
//
// 用法：
//   $env:PLAYWRIGHT_CORE='...'; node tools/profile_real_ui.mjs
//   $env:THROTTLE='4' node tools/profile_real_ui.mjs     # CPU 降速 4 倍（模拟弱笔记本）
//   $env:CORES='4' node tools/profile_real_ui.mjs        # 假装只有 4 核（导出分块更少）
//   $env:XML='E:/识谱弹琴/.cache/perf/big-4v-160m.musicxml'
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/big-4v-160m.musicxml";
const THROTTLE = Math.max(1, Number(process.env.THROTTLE) || 1);
const CORES = Math.max(1, Number(process.env.CORES) || 0);
if (!existsSync(XML)) throw new Error("找不到大谱夹具：" + XML);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
if (CORES) {
  await context.addInitScript((cores) => {
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => cores });
  }, CORES);
}
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// CPU 降速（CDP）
let cdp = null;
if (THROTTLE > 1) {
  cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
}

const report = { throttle: THROTTLE, cores: CORES || "auto", xml: XML.split(/[\\/]/).pop() };

// ===== 1) 导入（真实文件上传路径）=====
const importStart = Date.now();
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 300000 });
await page.waitForTimeout(5000);
report.importMs = Date.now() - importStart;
report.notes = await page.evaluate(() => window.__pujian.state.notes.length);

// ===== 2) 页面里的各项 UI 基础耗时（强制布局、重绘列表等）=====
report.ui = await page.evaluate(async () => {
  const debug = window.__pujian;
  const out = {};
  const time = (label, fn) => {
    const t0 = performance.now();
    const value = fn();
    out[label] = Number((performance.now() - t0).toFixed(1));
    return value;
  };
  // 强制整页布局（用户点完按钮后浏览器必须做的事）
  time("forceLayout", () => document.body.offsetHeight);
  time("renderNotes", () => debug.renderNotes());
  time("forceLayoutAfterRender", () => document.body.offsetHeight);
  time("updatePartControls", () => debug.updatePartControls());
  time("refreshScoreOverlay", () => debug.refreshScoreOverlay());
  out.domNodes = document.querySelectorAll("#noteList *").length;
  out.rows = document.querySelectorAll("#noteList .note-row").length;
  // 滚动 20 次，记录最差一帧（模拟用户拖动音符列表）
  const list = document.querySelector("#noteList");
  const frames = [];
  let last = performance.now();
  let stop = false;
  const loop = () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (!stop) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  for (let index = 1; index <= 20; index += 1) {
    list.scrollTop = (list.scrollHeight / 20) * index;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  stop = true;
  await new Promise((resolve) => setTimeout(resolve, 120));
  frames.sort((left, right) => right - left);
  out.scrollWorstFrameMs = Number((frames[0] || 0).toFixed(1));
  out.scrollP95FrameMs = Number((frames[Math.floor(frames.length * 0.05)] || 0).toFixed(1));
  out.scrollFrames = frames.length;
  return out;
});

// ===== 3) 复制声部（点真实按钮）=====
report.duplicate = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const before = state.notes.length;
  const button = document.querySelector("#addLayerPart");
  const t0 = performance.now();
  button.click();
  const created = state.notes.length > before;
  const ms = performance.now() - t0;
  // 把新建的声部删掉（保持后面测量口径一致）
  if (created) {
    const key = debug.voiceIdentity(state.notes[state.notes.length - 1]);
    state.notes = state.notes.filter((note) => debug.voiceIdentity(note) !== key);
    state.partNames.delete(key);
    if (state.selectedParts && typeof state.selectedParts.delete === "function") state.selectedParts.delete(key);
    debug.updatePartControls();
    debug.renderNotes();
  }
  return { ms: Number(ms.toFixed(1)), added: created, notes: state.notes.length };
});

// ===== 4) 切八度（点真实下拉）=====
report.octave = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const key = debug.voiceIdentity(state.notes[0]);
  const select = document.querySelector(`#partList .part-row[data-part-key="${key}"] select.part-octave`);
  const out = { hasSelect: Boolean(select) };
  const t0 = performance.now();
  if (select) {
    select.value = "-1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    debug.setPartOctave(key, -1);
  }
  out.downMs = Number((performance.now() - t0).toFixed(1));
  const t1 = performance.now();
  if (select) {
    select.value = "0";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    debug.setPartOctave(key, 0);
  }
  out.upMs = Number((performance.now() - t1).toFixed(1));
  return out;
});

// ===== 5) 导出 MP3（点真实按钮，等到下载完成）=====
report.export = await page.evaluate(() => ({
  notes: window.__pujian.getPlaybackNotes().length,
}));
const exportStart = Date.now();
const downloadPromise = page.waitForEvent("download", { timeout: 1200000 });
await page.click("#audioButton");
const download = await downloadPromise;
report.export.downloadMs = Date.now() - exportStart;
const target = process.env.TEMP ? `${process.env.TEMP}\\profile-real-ui.mp3` : "profile-real-ui.mp3";
await download.saveAs(target);
report.export.fileKB = Math.round(readFileSync(target).length / 1024);
report.export.filename = download.suggestedFilename();

report.errors = errors.slice(0, 5);
console.log(JSON.stringify(report, null, 1));
await browser.close();
