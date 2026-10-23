// 大谱性能基准：复制声部 / 切八度 / 全量重绘音符列表。
//
// 用法：
//   $env:PLAYWRIGHT_CORE='...'; node tools/bench_part_ops.mjs
//   $env:REPS='11'  每个声部重复几遍（8419 音基准用 11：192 × 4 声部 × 11）
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const FIXTURE = process.env.FIXTURE || "E:/识谱弹琴/tests/fixtures/call-of-silence-p1.musicxml";
const REPS = Math.max(1, Number(process.env.REPS) || 11);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.setInputFiles("#fileInput", {
  name: "bench.musicxml", mimeType: "application/xml",
  buffer: Buffer.from(readFileSync(FIXTURE, "utf8"), "utf8"),
});
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 180000 });
await page.waitForTimeout(800);

const report = await page.evaluate(async (REPS) => {
  const debug = window.__pujian;
  const state = debug.state;
  const base = state.notes.map((note) => ({ ...note }));
  const maxMeasure = base.reduce((max, note) => Math.max(max, Number(note.measure) || 0), 0);
  const totalBeats = base.reduce((end, note) => Math.max(end, (Number(note.startBeat) || 0) + (Number(note.durationBeats) || 1)), 0);
  const parts = 4;
  const notes = [];
  let seq = 0;
  for (let rep = 0; rep < REPS; rep += 1) {
    for (let part = 0; part < parts; part += 1) {
      for (const note of base) {
        seq += 1;
        const midi = Math.max(0, Math.min(127, Math.round(note.midi) + (part === 3 ? -12 : 0)));
        notes.push({
          ...note,
          id: "big-" + seq,
          eventId: seq,
          partId: "P" + (part + 1),
          partName: "声部" + (part + 1),
          voice: "1",
          staff: String(part + 1),
          measure: String(rep * maxMeasure + (Number(note.measure) || 1)),
          midi,
          pitch: note.pitch,
          startBeat: (Number(note.startBeat) || 0) + rep * totalBeats,
        });
      }
    }
  }
  state.notes = notes;
  state.selectedParts = null;
  debug.updatePartControls();

  const time = (label, fn) => {
    const t0 = performance.now();
    const value = fn();
    return { label, ms: Number((performance.now() - t0).toFixed(1)), value };
  };

  const results = {};
  results.notes = notes.length;
  results.parts = parts;
  results.fullRender = time("renderNotes", () => debug.renderNotes());
  results.overlay = time("refreshScoreOverlay", () => debug.refreshScoreOverlay());
  results.partControls = time("updatePartControls", () => debug.updatePartControls());
  results.renderAgain = time("renderNotes（热）", () => debug.renderNotes());
  results.rows = state.noteRowById ? state.noteRowById.size : 0;
  results.domNodes = document.querySelectorAll("#noteList *").length;

  // 复制声部（512 音/声部 × 4 = 2048 音/声部 → 全谱 8419 音）
  results.duplicate = time("duplicatePart", () => debug.duplicatePart("P1", {}));
  const createdKey = results.duplicate.value && results.duplicate.value.key;
  results.afterDuplicateRows = state.noteRowById ? state.noteRowById.size : 0;
  // 清掉复制出来的声部，避免影响后续测量
  if (createdKey) {
    state.notes = state.notes.filter((note) => debug.voiceIdentity(note) !== createdKey);
    state.partNames.delete(createdKey);
    if (state.selectedParts && typeof state.selectedParts.delete === "function") state.selectedParts.delete(createdKey);
    debug.updatePartControls();
    debug.renderNotes();
  }

  // 切八度（降再升）
  results.octaveDown = time("setPartOctave(-1)", () => debug.setPartOctave("P1", -1));
  results.octaveUp = time("setPartOctave(0)", () => debug.setPartOctave("P1", 0));

  // 微基准：音符行 DOM 成本（判断瓶颈是不是 <select> 的 10 个 option）
  const makeRows = (count, withSelect) => {
    const t0 = performance.now();
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) {
      const row = document.createElement("div");
      row.className = "note-row";
      const label = document.createElement("span");
      label.textContent = String(index).padStart(2, "0");
      const pitch = document.createElement("input");
      pitch.value = "C4";
      const onset = document.createElement("input");
      onset.value = "1";
      row.append(label, pitch, onset);
      if (withSelect) {
        const select = document.createElement("select");
        for (const value of ["whole", "half", "quarter", "eighth", "16th", "32nd", "dotted-half", "dotted-quarter", "dotted-eighth", "custom"]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          select.append(option);
        }
        row.append(select);
      }
      const button = document.createElement("button");
      button.textContent = "×";
      row.append(button);
      fragment.append(row);
    }
    const container = document.getElementById("noteList");
    container.append(fragment);
    const ms = performance.now() - t0;
    container.replaceChildren();
    return Number(ms.toFixed(1));
  };
  results.microRowsWithSelect = makeRows(1000, true);
  results.microRowsNoSelect = makeRows(1000, false);

  return results;
}, REPS);

console.log(JSON.stringify(report, null, 1));
await browser.close();
