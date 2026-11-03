// 真实乐谱端到端回归：《有我_正谱.pdf》（8 页矢量谱，混声四声部 + 钢琴）。
//
// 用户反馈原话：「来我问你个事，四个声部一个钢琴，你怎么给我整出11个声部的？？？」
// 根因：PDF 文字层里「谱表左缘」的文字被不加区分地当成声部标签——调号字形 "b" 被当成 Bass、
// 歌词（"世界问你是谁来自哪" / "光" / "wu" / "对答自" …）被当成新声部名，越识别声部越多。
//
// 验证目标：
//   1. 声部：正好 5 个（Soprano / Alto / Tenor / Bass / Piano），不能出现 "Bass 2/Bass 3/wu/…" 这种假声部；
//   2. 小节：54 个印刷小节（每页印刷小节号 1/9/12/15/19/22/25/28/31/35/38/41/44/48/51 连续）；
//   3. 拍号/拍数：4/4，216 拍；调号 F（1 个降号）；速度 ♩=66（谱面印的）；
//   4. 声部音域合理：Bass 最低、Soprano/Alto/Tenor 在上方；钢琴两个谱表都有音；
//   5. 声部数量不能随页数增加（本次 bug 的典型表现：第 2 页起歌词越攒越多）。
//
// 用法（需要本机已装 Audiveris 与启动中的谱见服务）：
//   $env:PLAYWRIGHT_CORE=".../playwright-core"
//   $env:APP_URL="http://127.0.0.1:4492/"
//   $env:PUJIAN_SCORE_PDF=".../有我_正谱.pdf"
//   node tests/e2e-realscore-woyou.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const candidates = [
  process.env.PUJIAN_SCORE_PDF,
  "D:\\识谱弹琴\\.cache\\omr\\woyou.pdf",
].filter(Boolean);
const pdfPath = candidates.find((path) => existsSync(path));
if (!pdfPath) {
  console.log("SKIP：找不到《有我》PDF（可用 PUJIAN_SCORE_PDF 指定路径）");
  process.exit(0);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
const batchLogs = [];
page.on("console", (message) => {
  const text = message.text();
  if (/逐系统识别批次|逐系统识别耗时|可疑系统重识别/.test(text)) batchLogs.push(text);
  if (message.type() === "error") errors.push(text);
});
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
const started = Date.now();
try {
  await page.goto(appUrl + (appUrl.includes("?") ? "&" : "?") + "debug=1",
    { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__pujian), null, { timeout: 30000 });
  await page.setInputFiles("#fileInput", pdfPath);
  await page.waitForFunction(() => window.__pujian?.state?.pageCount === 8, null, { timeout: 60000 });
  console.log("PDF 已载入，8 页（矢量谱，文字层有 S./A./T./B./Pno. 标签）");
  await page.click("#recognizeAllButton");
  await page.waitForFunction(
    () => {
      const hint = document.querySelector("#scoreHint")?.textContent || "";
      return hint.includes("整本识别完成") || hint.includes("整本识别失败") || hint.includes("识别失败");
    },
    null, { timeout: 900000, polling: 1000 },
  );
  const elapsed = (Date.now() - started) / 1000;
  const state = await page.evaluate(() => {
    const info = window.__pujian.state.scoreInfo || {};
    const notes = info.notes || [];
    const partNames = [...new Set(notes.map((note) => note.partName))];
    const partCounts = {};
    const partMidi = {};
    const partStaves = {};
    const notesPerMeasure = {};
    for (const note of notes) {
      partCounts[note.partName] = (partCounts[note.partName] || 0) + 1;
      partMidi[note.partName] = partMidi[note.partName] || [];
      partMidi[note.partName].push(Number(note.midi));
      partStaves[note.partName] = partStaves[note.partName] || new Set();
      partStaves[note.partName].add(String(note.staff || "1"));
      const measure = Number(note.measure);
      notesPerMeasure[measure] = (notesPerMeasure[measure] || 0) + 1;
    }
    const midiRange = {};
    for (const [name, values] of Object.entries(partMidi)) {
      midiRange[name] = { min: Math.min(...values), max: Math.max(...values) };
    }
    const emptyMeasures = [];
    for (let measure = 1; measure <= (info.measureCount || 0); measure++) {
      if (!notesPerMeasure[measure]) emptyMeasures.push(measure);
    }
    return {
      hint: document.querySelector("#scoreHint")?.textContent || "",
      details: document.querySelector("#scoreDetails")?.textContent || "",
      warnings: document.querySelector("#scoreWarnings")?.textContent || "",
      bpm: document.querySelector("#tempoInput")?.value || "",
      notes: notes.length,
      partNames: partNames.sort(),
      partCounts,
      midiRange,
      partStaffCounts: Object.fromEntries(Object.entries(partStaves).map(([name, set]) => [name, [...set].sort()])),
      measureCount: info.measureCount,
      totalBeats: info.totalBeats,
      timeSummary: info.timeSummary,
      keySummary: info.keySummary,
      systemStats: info.systemStats || {},
      emptyMeasures,
    };
  });
  console.log("整本识别耗时：", elapsed.toFixed(1), "秒");
  for (const line of batchLogs) console.log("  ", line);
  console.log("界面提示：", state.hint);
  console.log("详情：", state.details);
  console.log("BPM：", state.bpm, "| 拍号：", state.timeSummary, "| 调号：", state.keySummary);
  console.log("结构：", JSON.stringify({
    notes: state.notes, parts: state.partNames, partCounts: state.partCounts,
    measures: state.measureCount, beats: state.totalBeats,
    midiRange: state.midiRange, partStaffCounts: state.partStaffCounts,
    emptyMeasures: state.emptyMeasures, systemStats: state.systemStats,
  }, null, 1));
  if (errors.length) console.log("页面报错：", errors.slice(0, 5));

  assert.ok(state.hint.includes("整本识别完成"), "整本识别应成功");
  // 1) 声部：正好 5 个，名字只能是 Satb + Piano（不能把歌词/调号字形当声部）
  assert.deepEqual(state.partNames, ["Alto", "Bass", "Piano", "Soprano", "Tenor"],
    `声部应恰好是 S/A/T/B + Piano（实际 ${JSON.stringify(state.partNames)}）`);
  assert.equal(Object.keys(state.partCounts).length, 5, "声部数应为 5（用户原话：四个声部一个钢琴）");
  // 各声部都要有足够的音（Tenor 有主歌独唱段，音会多一些）
  assert.ok(state.partCounts.Soprano >= 180, `Soprano 音符偏少（实际 ${state.partCounts.Soprano}）`);
  assert.ok(state.partCounts.Alto >= 180, `Alto 音符偏少（实际 ${state.partCounts.Alto}）`);
  assert.ok(state.partCounts.Tenor >= 250, `Tenor 音符偏少（实际 ${state.partCounts.Tenor}）`);
  assert.ok(state.partCounts.Bass >= 180, `Bass 音符偏少（实际 ${state.partCounts.Bass}）`);
  assert.ok(state.partCounts.Piano >= 500, `Piano 音符偏少（实际 ${state.partCounts.Piano}）`);
  // 2) 音符总数（整本，延音已合并）
  assert.ok(state.notes >= 1580 && state.notes <= 1660, `整本音符数应在 1580–1660（实际 ${state.notes}）`);
  // 3) 小节/拍数：54 个印刷小节、4/4、216 拍
  assert.equal(state.measureCount, 54, "整曲应为 54 个印刷小节");
  assert.equal(state.timeSummary, "4/4", `拍号应为 4/4（实际 ${state.timeSummary}）`);
  assert.ok(Math.abs(state.totalBeats - 216) < 0.01, `整曲应为 216 拍 = 54×4（实际 ${state.totalBeats}）`);
  assert.equal(state.systemStats.appendedMeasures || 0, 0, "不应补小节");
  assert.equal(state.systemStats.trimmedMeasures || 0, 0, "不应裁小节");
  // 4) 调号/速度：F 大调（1 个降号）、♩=66
  assert.equal(state.keySummary, "F", `调号应为 F（实际 ${state.keySummary}）`);
  assert.equal(Math.round(Number(state.bpm)), 66, `速度应为 66（谱面 ♩=66），实际 ${state.bpm}`);
  // 5) 音域：Bass 最低，钢琴跨两个谱表
  assert.ok(state.midiRange.Bass.min <= 50, `Bass 最低音应在 50 以下（实际 ${state.midiRange.Bass.min}）`);
  assert.ok(state.midiRange.Soprano.max >= 70, `Soprano 最高音应到 70+（实际 ${state.midiRange.Soprano.max}）`);
  assert.deepEqual(state.partStaffCounts.Piano, ["1", "2"], "钢琴应同时有上下两个谱表的音");
  // 6) 空格检查：不应出现整小节无音（这份谱没有整小节休止）
  assert.deepEqual(state.emptyMeasures, [], `不应有空小节（实际 ${JSON.stringify(state.emptyMeasures)}）`);
  // 7) 性能：8 页 15 个系统，给 120 秒上限
  assert.ok(elapsed < 120, `整本识别耗时应在 120 秒内（实际 ${elapsed.toFixed(1)} 秒）`);
  console.log("✅ 整本逐系统识别回归通过（矢量四声部谱：声部数/小节/拍号/调号/速度/音域）");
} finally {
  await browser.close();
}
