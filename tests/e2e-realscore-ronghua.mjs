// 真实乐谱端到端回归：《绒花 吴混声四声部降A调 钢伴正谱》（图片型 PDF，用户反馈「又分不清声部」的那份）。
//
// 验证目标：
//   1. 声部：混声四声部 + 钢琴 = 5 个声部（Soprano / Alto / Tenor / Bass / Piano），
//      而且各系统声部数不同（钢琴独奏 2 行 / Solo+钢琴 3 行 / 四声部+钢琴 6 行）时
//      钢琴始终是同一个声部（Solo 段的钢琴不能被算成 Alto）；
//   2. 小节：119 个印刷小节（累计印刷小节号），不能多补/少裁；（第 15 小节是原谱的整小节休止）
//   3. 拍号：前半 6/8、第 16 小节起 2/4（253 拍 = 15×3 + 104×2）；
//   3b. 变调：Ab 起、第 9 小节起 F、第 86 小节起回到 Ab（界面要写清楚，音高要跟着调号走）；
//   4. 速度：谱面 ♩=60-65 要读成 60 起，中途 ♩=68 / ♩=72 也要读到（不是默认 84）；
//   5. 调号：降 A（4 个降号）；
//   6. 速度：整本识别耗时（性能回归用，允许较宽范围）。
//
// 用法（需要本机已装 Audiveris 与启动中的谱见服务）：
//   $env:PLAYWRIGHT_CORE=".../playwright-core"
//   $env:APP_URL="http://127.0.0.1:4492/"
//   $env:PUJIAN_SCORE_PDF="D:\桌面\学生组织\合唱队\绒花 吴混声四声部降A调 钢伴正谱.pdf"
//   node tests/e2e-realscore-ronghua.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const candidates = [
  process.env.PUJIAN_SCORE_PDF,
  "D:\\桌面\\学生组织\\合唱队\\绒花 吴混声四声部降A调 钢伴正谱.pdf",
  "D:\\识谱弹琴\\.cache\\omr\\ronghua.pdf",
].filter(Boolean);
const pdfPath = candidates.find((path) => existsSync(path));
if (!pdfPath) {
  console.log("SKIP：找不到《绒花》PDF（可用 PUJIAN_SCORE_PDF 指定路径）");
  process.exit(0);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
const batchLogs = [];
page.on("console", (message) => {
  const text = message.text();
  if (/逐系统识别批次|逐系统识别耗时/.test(text)) batchLogs.push(text);
  if (message.type() === "error") errors.push(text);
});
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
const started = Date.now();
try {
  await page.goto(appUrl + (appUrl.includes("?") ? "&" : "?") + "debug=1",
    { waitUntil: "domcontentloaded", timeout: 60000 });
  // 不能等 networkidle：页面空闲时会后台预加载全部音源（83 个 bank），网络一直有请求。
  await page.waitForFunction(() => Boolean(window.__pujian), null, { timeout: 30000 });
  await page.setInputFiles("#fileInput", pdfPath);
  await page.waitForFunction(() => window.__pujian?.state?.pageCount === 9, null, { timeout: 60000 });
  console.log("PDF 已载入，9 页（图片型 PDF）");
  await page.click("#recognizeAllButton");
  await page.waitForFunction(
    () => {
      const hint = document.querySelector("#scoreHint")?.textContent || "";
      return hint.includes("整本识别完成") || hint.includes("整本识别失败") || hint.includes("识别失败");
    },
    null,
    { timeout: 600000, polling: 1000 },
  );
  const elapsed = (Date.now() - started) / 1000;
  const state = await page.evaluate(() => {
    const scoreInfo = window.__pujian.state.scoreInfo || {};
    const hints = {
      scoreHint: document.querySelector("#scoreHint")?.textContent || "",
      scoreDetails: document.querySelector("#scoreDetails")?.textContent || "",
      scoreWarnings: document.querySelector("#scoreWarnings")?.textContent || "",
      tempoInput: document.querySelector("#tempoInput")?.value || "",
      tempoHint: document.querySelector("#tempoHint")?.textContent || "",
    };
    const partNames = {};
    const partCount = {};
    for (const note of scoreInfo.notes || []) {
      partNames[note.partId] = note.partName;
      partCount[note.partId] = (partCount[note.partId] || 0) + 1;
    }
    const notesPerMeasure = {};
    for (const note of scoreInfo.notes || []) {
      const measure = Number(note.measure);
      notesPerMeasure[measure] = (notesPerMeasure[measure] || 0) + 1;
    }
    const emptyMeasures = [];
    for (let measure = 1; measure <= (scoreInfo.measureCount || 0); measure++) {
      if (!notesPerMeasure[measure]) emptyMeasures.push(measure);
    }
    // 变调核对：原谱 Ab 起、第 9 小节转 F、第 86 小节回到 Ab。
    // 音高有没有跟着调号走，用音级分布验证：
    //   F 大调段（1 降号）应多 A/D/E 还原音，少 Ab/Db/Eb；
    //   Ab 大调段（4 降号）反过来。
    const pitchClasses = { fSection: [], abSection: [] };
    for (const note of scoreInfo.notes || []) {
      const measure = Number(note.measure);
      const pc = ((Number(note.midi) % 12) + 12) % 12;
      if (measure >= 9 && measure <= 85) pitchClasses.fSection.push(pc);
      else if (measure >= 86) pitchClasses.abSection.push(pc);
    }
    const FLATS = [1, 3, 8];        // Db / Eb / Ab
    const NATURALS = [2, 4, 9];     // D / E / A
    const countIn = (list, classes) => list.filter((pc) => classes.includes(pc)).length;
    return {
      hints,
      notes: (scoreInfo.notes || []).length,
      partNames,
      partCount,
      measureCount: scoreInfo.measureCount,
      totalBeats: scoreInfo.totalBeats,
      tempo: scoreInfo.tempo,
      tempoDetected: scoreInfo.tempoDetected,
      tempoMarks: (scoreInfo.tempoMarks || []).map((mark) => Math.round(Number(mark.bpm))),
      timeSummary: scoreInfo.timeSummary,
      keySummary: scoreInfo.keySummary,
      keyChanges: scoreInfo.keyChanges || [],
      pitchCheck: {
        fNaturals: countIn(pitchClasses.fSection, NATURALS),
        fFlats: countIn(pitchClasses.fSection, FLATS),
        abFlats: countIn(pitchClasses.abSection, FLATS),
        abNaturals: countIn(pitchClasses.abSection, NATURALS),
      },
      systemStats: scoreInfo.systemStats || {},
      warnings: scoreInfo.warnings || [],
      emptyMeasures,
      gridded: (scoreInfo.notes || []).every((note) => {
        const value = note.startBeat * 4;
        return Math.abs(value - Math.round(value)) < 0.01;
      }),
    };
  });
  console.log("整本识别耗时：", elapsed.toFixed(1), "秒");
  for (const line of batchLogs) console.log("  ", line);
  console.log("界面提示：", state.hints.scoreHint);
  console.log("详情：", state.hints.scoreDetails);
  console.log("BPM：", state.hints.tempoInput, "|", state.hints.tempoHint);
  console.log("结构：", JSON.stringify({
    notes: state.notes,
    measures: state.measureCount,
    beats: state.totalBeats,
    tempo: state.tempo,
    time: state.timeSummary,
    key: state.keySummary,
    parts: state.partNames,
    partCount: state.partCount,
    tempoMarks: state.tempoMarks,
    emptyMeasures: state.emptyMeasures,
  }, null, 1));
  if (errors.length) console.log("页面报错：", errors.slice(0, 5));

  assert.ok(state.hints.scoreHint.includes("整本识别完成"), "整本识别应成功");
  // 1) 声部：5 个，名字按谱号推断出来（图片型 PDF 没有文字层标签）
  assert.equal(Object.keys(state.partNames).length, 5, "应该识别出 5 个声部");
  assert.deepEqual(Object.values(state.partNames).sort(),
    ["Alto", "Bass", "Piano", "Soprano", "Tenor"], "声部名应是 S/A/T/B + Piano（按谱号/谱表数推断）");
  // 各声部都要有音符（钢琴伴奏多、Bass 少）
  assert.ok(state.partCount.P1 >= 150, `Soprano 音符数偏少（实际 ${state.partCount.P1}）`);
  assert.ok(state.partCount.P2 >= 120, `Alto 音符数偏少（实际 ${state.partCount.P2}）`);
  assert.ok(state.partCount.P3 >= 120, `Tenor 音符数偏少（实际 ${state.partCount.P3}）`);
  assert.ok(state.partCount.P4 >= 80, `Bass 音符数偏少（实际 ${state.partCount.P4}）`);
  assert.ok(state.partCount.P5 >= 900, `Piano 音符数偏少（实际 ${state.partCount.P5}）`);
  // 2) 小节：119 个印刷小节（印刷小节号 1..119 连续），不能多补/少裁
  assert.equal(state.measureCount, 119, "整曲应为 119 个印刷小节");
  assert.equal(state.systemStats.appendedMeasures || 0, 0, "不应有需要补的小节（小节线已经读全）");
  assert.equal(state.systemStats.trimmedMeasures || 0, 0, "不应有被裁掉的小节");
  assert.ok(!(state.warnings || []).some((warning) => warning.includes("多 5 个小节") || warning.includes("识别漏读了小节线")),
    "不应出现「补小节」提示");
  // 原谱第 15 小节是整小节休止（段落转换），除此之外不应出现「莫名其妙的空拍」
  assert.deepEqual(state.emptyMeasures, [15], `空小节应只有原谱第 15 小节（实际 ${JSON.stringify(state.emptyMeasures)}）`);
  // 3) 拍号/拍数：前半 6/8（15 小节 × 3 拍）+ 第 16 小节起 2/4（104 小节 × 2 拍）= 253 拍
  assert.equal(state.timeSummary, "6/8（第 16 小节为 2/4）", "拍号说明应是 6/8 转 2/4（只报第 16 小节一次）");
  assert.ok(Math.abs(state.totalBeats - 253) < 0.01, `整曲应为 253 拍（实际 ${state.totalBeats}）`);
  // 4) 速度：♩=60-65 取左端 60；中途 68 / 72 也要读到
  assert.equal(Math.round(state.tempo), 60, "起始 BPM 应为 60（谱面 ♩=60-65 的左端）");
  assert.equal(state.tempoDetected, true, "速度应标注为『从谱面读到』");
  assert.ok(state.tempoMarks.includes(68), `应读到中途 ♩=68（实际 ${JSON.stringify(state.tempoMarks)}）`);
  assert.ok(state.tempoMarks.includes(72), `应读到中途 ♩=72（实际 ${JSON.stringify(state.tempoMarks)}）`);
  // 5) 调号：原谱有两次变调（Ab 起 → 第 9 小节转 F → 第 86 小节回到 Ab）
  assert.equal(state.keySummary, "Ab（第 9 小节起 F；第 86 小节起 Ab）",
    `变调说明不对（实际 ${state.keySummary}）`);
  assert.deepEqual(state.keyChanges, [
    { measure: 1, key: "Ab" },
    { measure: 9, key: "F" },
    { measure: 86, key: "Ab" },
  ], "变调小节号应为第 1、9、86 小节");
  // 音高必须跟着调号走：F 段多还原音、Ab 段多降号音（否则就是调号没生效、整段音高错了）
  console.log("音级分布核对：", JSON.stringify(state.pitchCheck));
  assert.ok(state.pitchCheck.fNaturals > state.pitchCheck.fFlats,
    `F 大调段应以还原音为主（实际 还原 ${state.pitchCheck.fNaturals} vs 降号 ${state.pitchCheck.fFlats}）`);
  assert.ok(state.pitchCheck.abFlats > state.pitchCheck.abNaturals,
    `Ab 大调段应以降号音为主（实际 降号 ${state.pitchCheck.abFlats} vs 还原 ${state.pitchCheck.abNaturals}）`);
  assert.ok(state.gridded, "所有起拍都应落在 1/4 拍网格上");
  // 6) 性能：从点击「识别全部」到结果落地。图片型 PDF 9 页 19 个系统，
  //    优化前约 160 秒；这里给 110 秒上限（留机器差异余量），明显变慢时会失败提醒。
  assert.ok(elapsed < 110, `整本识别耗时应在 110 秒内（实际 ${elapsed.toFixed(1)} 秒）`);
  console.log("✅ 整本逐系统识别回归通过（图片型四声部谱：声部/小节/拍号/速度/性能）");

  // ===== 单页识别（第 4 页：页顶印 ♩=68，验证单页也能读到速度、且小节号从 43 开始）=====
  for (let index = 0; index < 3; index++) await page.click("#nextPage");
  await page.waitForFunction(() => document.querySelector("#pageLabel")?.textContent?.startsWith("4 /"), null, { timeout: 30000 });
  await page.click("#recognizeButton");
  await page.waitForFunction(
    () => {
      const hint = document.querySelector("#scoreHint")?.textContent || "";
      return hint.includes("逐系统识别完成") || hint.includes("识别失败") || hint.includes("整页识别完成");
    },
    null,
    { timeout: 180000, polling: 500 },
  );
  const page4 = await page.evaluate(() => {
    const info = window.__pujian.state.scoreInfo || {};
    const measures = [...new Set((info.notes || []).map((note) => Number(note.measure)))].sort((a, b) => a - b);
    return {
      hint: document.querySelector("#scoreHint")?.textContent || "",
      bpm: document.querySelector("#tempoInput")?.value || "",
      partNames: [...new Set((info.notes || []).map((note) => note.partName))].sort(),
      measures: info.measureCount,
      beats: info.totalBeats,
      time: info.timeSummary,
      tempoMarks: (info.tempoMarks || []).map((mark) => Math.round(Number(mark.bpm))),
      measureLabels: measures,
    };
  });
  console.log("单页第 4 页：", JSON.stringify(page4));
  assert.ok(page4.hint.includes("逐系统识别完成"), "单页识别应成功");
  assert.deepEqual(page4.partNames, ["Alto", "Bass", "Piano", "Soprano", "Tenor"], "单页也应是 4 声部 + 钢琴");
  assert.equal(page4.measures, 19, "第 4 页应为 19 个小节（第 43–61 小节）");
  assert.ok(Math.abs(page4.beats - 38) < 0.01, "第 4 页应为 38 拍（19×2）");
  assert.equal(Math.round(Number(page4.bpm)), 68, "单页第 4 页也应读到页顶的 ♩=68");
  console.log("✅ 单页逐系统识别回归通过（页顶速度记号 + 小节数/拍数）");
} finally {
  await browser.close();
}
