// 验证「复制成新声部」渐进填行：点击同步返回耗时、行数是否最终补齐、遥测是否上报。
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/big-4v-160m.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 300000 });
await page.waitForTimeout(800);

const first = await page.evaluate(async () => {
  const debug = window.__pujian;
  const notesBefore = debug.state.notes.length;
  const rowsBefore = document.querySelectorAll("#noteList .note-row").length;
  const t0 = performance.now();
  document.querySelector("#addLayerPart").click();
  const clickMs = performance.now() - t0;
  const rowsRightAfter = document.querySelectorAll("#noteList .note-row").length;
  const pending = debug.state.rowFillPending || 0;
  const started = performance.now();
  await debug.whenNoteRowsIdle();
  const settleMs = performance.now() - started;
  const rowsAfter = document.querySelectorAll("#noteList .note-row").length;
  const stats = debug.state.lastDuplicateStats || null;
  return { clickMs: Math.round(clickMs * 10) / 10, rowsBefore, rowsRightAfter, pending, settleMs: Math.round(settleMs), rowsAfter, notesAfter: debug.state.notes.length, added: debug.state.notes.length - notesBefore, stats };
});
await page.waitForTimeout(400);

// 第二次复制（再多一个声部）：确认仍然不卡
const second = await page.evaluate(async () => {
  const debug = window.__pujian;
  const t0 = performance.now();
  document.querySelector("#addLayerPart").click();
  const clickMs = performance.now() - t0;
  await debug.whenNoteRowsIdle();
  return { clickMs: Math.round(clickMs * 10) / 10, rows: document.querySelectorAll("#noteList .note-row").length, parts: debug.state.partNames.size };
});
await page.waitForTimeout(600);

// 切八度计时
const octave = await page.evaluate(() => {
  const debug = window.__pujian;
  const key = debug.voiceIdentity(debug.state.notes[0]);
  const t0 = performance.now();
  debug.setPartOctave(key, -1);
  const down = performance.now() - t0;
  const t1 = performance.now();
  debug.setPartOctave(key, 0);
  return { downMs: Math.round(down * 10) / 10, upMs: Math.round((performance.now() - t1) * 10) / 10 };
});

const logPath = "E:/识谱弹琴/.cache/perf/ui-perf.jsonl";
const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").slice(-4) : [];
console.log(JSON.stringify({ first, second, octave, lastPerfLines: tail }, null, 1));
await browser.close();
