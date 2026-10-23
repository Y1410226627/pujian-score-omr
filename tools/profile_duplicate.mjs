// 拆解 duplicatePart 的耗时构成（大谱：8448 音 / 4 声部）。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const FIXTURE = "E:/识谱弹琴/tests/fixtures/call-of-silence-p1.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.setInputFiles("#fileInput", {
  name: "profile.musicxml", mimeType: "application/xml",
  buffer: Buffer.from(readFileSync(FIXTURE, "utf8"), "utf8"),
});
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 180000 });
await page.waitForTimeout(800);

const report = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  // 造 8448 音 / 4 声部
  const base = state.notes.map((note) => ({ ...note }));
  const maxMeasure = base.reduce((max, note) => Math.max(max, Number(note.measure) || 0), 0);
  const totalBeats = base.reduce((end, note) => Math.max(end, (Number(note.startBeat) || 0) + (Number(note.durationBeats) || 1)), 0);
  const notes = [];
  let seq = 0;
  for (let rep = 0; rep < 11; rep += 1) {
    for (let part = 0; part < 4; part += 1) {
      for (const note of base) {
        seq += 1;
        const midi = Math.max(0, Math.min(127, Math.round(note.midi) + (part === 3 ? -12 : 0)));
        notes.push({
          ...note, id: "big-" + seq, eventId: seq, partId: "P" + (part + 1), partName: "声部" + (part + 1),
          voice: "1", staff: String(part + 1),
          measure: String(rep * maxMeasure + (Number(note.measure) || 1)),
          midi, startBeat: (Number(note.startBeat) || 0) + rep * totalBeats,
        });
      }
    }
  }
  state.notes = notes;
  state.selectedParts = null;
  debug.updatePartControls();
  debug.renderNotes();

  const time = (label, fn) => {
    const t0 = performance.now();
    const value = fn();
    return { label, ms: Number((performance.now() - t0).toFixed(1)), value };
  };

  const out = { notes: notes.length, steps: [] };
  const record = (result) => { out.steps.push({ label: result.label, ms: result.ms }); return result.value; };
  // 手动复刻 duplicatePart 的每一步
  const source = record(time("filter 源声部", () => state.notes.filter((note) => debug.voiceIdentity(note) === "P1")));
  const copies = record(time("复制音符对象", () => source.map((note) => {
    const midi = Math.max(0, Math.min(127, Math.round(note.midi)));
    return {
      ...note, id: debug.makeId(), partId: "P1-layerP", partName: "P1 · 叠加",
      midi, pitch: note.pitch, x: Number.NaN, y: Number.NaN, confidence: 1, isLowConfidence: false,
    };
  })));
  record(time("push", () => state.notes.push(...copies)));
  record(time("updatePartControls", () => debug.updatePartControls()));
  record(time("appendPartNoteRows", () => debug.appendPartNoteRows("P1-layerP", copies)));
  record(time("refreshScoreOverlay", () => debug.refreshScoreOverlay()));
  record(time("updatePlaybackReady", () => debug.updatePlaybackReady()));

  // 复位
  state.notes = state.notes.filter((note) => debug.voiceIdentity(note) !== "P1-layerP");
  state.partNames.delete("P1-layerP");
  debug.updatePartControls();
  debug.renderNotes();

  // 真实 duplicatePart 总耗时（做 2 次取第二次，排除首次 JIT 冷）
  time("duplicatePart（第一次）", () => debug.duplicatePart("P1", {}));
  const created = state.notes.filter((note) => debug.voiceIdentity(note) === "P1-layer1");
  out.dupRows = state.noteRowById.size;
  // 复位
  state.notes = state.notes.filter((note) => debug.voiceIdentity(note) !== "P1-layer1");
  state.partNames.delete("P1-layer1");
  if (state.selectedParts && typeof state.selectedParts.delete === "function") state.selectedParts.delete("P1-layer1");
  debug.updatePartControls();
  debug.renderNotes();
  out.duplicateTotal = time("duplicatePart（热）", () => debug.duplicatePart("P1", {})).ms;
  out.copiedNotes = created.length;
  out.totalNotes = state.notes.length;
  return out;
});

console.log(JSON.stringify(report, null, 1));
await browser.close();
