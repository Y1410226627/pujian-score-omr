// 真实乐谱端到端回归：《Goodbye Mr Lawrence Complete Piano Sheet by Ah Doe》（图片型 PDF，206 DPI，
// 用户反馈「中间的莫名其妙空拍还是相当严重」的那份 11 页谱）。
//
// 验证目标：
//   1. 变拍子：6/8 起，**第 29 小节起 2/4**（原谱第 2 页第 3 系统中间印的 2/4），
//      整曲 428 拍 = 28×3 + 172×2；以前识别不出来，每小节末尾多 1 拍空拍；
//   2. 空小节：整本只剩第 76 小节（原谱就是整小节休止），不应再出现「补 7 个空小节」那种错误；
//   3. 引擎把两小节并成一节/吞小节的系统（p7s4、p10s2/3/5、p11s1）要能靠「可疑系统放大重识别」修正；
//   4. 调号：5 个降号 = Db（用户肉眼容易数成 4 个降号，这里用识别结果固定下来）；
//   5. 单页识别第 11 页：4 小节 / 8 拍，不能因为第一个系统没印拍号就被当成 4 拍小节；
//   6. 性能：整本识别耗时上限（放大复核只发生在可疑系统上，整本约 2.5 分钟）。
//
// 用法（需要本机已装 Audiveris 与启动中的谱见服务）：
//   $env:PLAYWRIGHT_CORE=".../playwright-core"
//   $env:APP_URL="http://127.0.0.1:4492/"
//   $env:PUJIAN_SCORE_PDF=".../Goodbye Mr Lawrence Complete Piano Sheet by Ah Doe.pdf"
//   node tests/e2e-realscore-goodbye.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const candidates = [
  process.env.PUJIAN_SCORE_PDF,
  "D:\\识谱弹琴\\.cache\\omr\\goodbye.pdf",
  "D:\\桌面\\钢琴谱\\Goodbye Mr Lawrence Complete Piano Sheet by Ah Doe.pdf",
].filter(Boolean);
const pdfPath = candidates.find((path) => existsSync(path));
if (!pdfPath) {
  console.log("SKIP：找不到《Goodbye Mr Lawrence》PDF（可用 PUJIAN_SCORE_PDF 指定路径）");
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
  await page.waitForFunction(() => window.__pujian?.state?.pageCount === 11, null, { timeout: 60000 });
  console.log("PDF 已载入，11 页（图片型 PDF，约 206 DPI）");
  await page.click("#recognizeAllButton");
  await page.waitForFunction(
    () => {
      const hint = document.querySelector("#scoreHint")?.textContent || "";
      return hint.includes("整本识别完成") || hint.includes("整本识别失败") || hint.includes("识别失败");
    },
    null,
    { timeout: 900000, polling: 1000 },
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
    const noteCount = {};
    const intervals = [];
    for (const note of scoreInfo.notes || []) {
      const measure = Number(note.measure);
      noteCount[measure] = (noteCount[measure] || 0) + 1;
      const start = Number(note.startBeat) || 0;
      intervals.push([start, start + (Number(note.playBeats || note.durationBeats) || 0.5)]);
    }
    const emptyMeasures = [];
    for (let measure = 1; measure <= (scoreInfo.measureCount || 0); measure++) {
      if (!noteCount[measure]) emptyMeasures.push(measure);
    }
    // 试听「空拍」：发声区间并集之间的空隙
    intervals.sort((a, b) => a[0] - b[0]);
    const holes = [];
    let reach = -Infinity;
    for (const [start, end] of intervals) {
      if (reach > -Infinity && start > reach + 0.01) {
        holes.push({ from: Math.round(reach * 100) / 100, to: Math.round(start * 100) / 100, len: Math.round((start - reach) * 100) / 100 });
      }
      reach = Math.max(reach, end);
    }
    // 拍号变化（界面上是中文说明，直接读 meterChanges 更稳）
    return {
      hints,
      notes: (scoreInfo.notes || []).length,
      partNames: [...new Set((scoreInfo.notes || []).map((note) => note.partName))],
      measureCount: scoreInfo.measureCount,
      totalBeats: scoreInfo.totalBeats,
      timeSummary: scoreInfo.timeSummary,
      meterChanges: scoreInfo.meterChanges || [],
      keySummary: scoreInfo.keySummary,
      keyChanges: scoreInfo.keyChanges || [],
      tempo: scoreInfo.tempo,
      tempoDetected: scoreInfo.tempoDetected,
      systemStats: scoreInfo.systemStats || {},
      warnings: scoreInfo.warnings || [],
      emptyMeasures,
      holes,
    };
  });
  console.log("整本识别耗时：", elapsed.toFixed(1), "秒");
  for (const line of batchLogs) console.log("  ", line);
  console.log("界面提示：", state.hints.scoreHint);
  console.log("详情：", state.hints.scoreDetails);
  console.log("BPM：", state.hints.tempoInput, "|", state.hints.tempoHint);
  console.log("结构：", JSON.stringify({
    notes: state.notes,
    parts: state.partNames,
    measures: state.measureCount,
    beats: state.totalBeats,
    time: state.timeSummary,
    meterChanges: state.meterChanges,
    key: state.keySummary,
    emptyMeasures: state.emptyMeasures,
    holes: state.holes,
    systemStats: state.systemStats,
  }, null, 1));
  if (errors.length) console.log("页面报错：", errors.slice(0, 5));

  assert.ok(state.hints.scoreHint.includes("整本识别完成"), "整本识别应成功");
  // 1) 钢琴单声部（大谱表 2 行）
  assert.deepEqual(state.partNames, ["Piano"], "应识别为 1 个钢琴声部（大谱表）");
  assert.ok(state.notes >= 1930, `音符数偏少（实际 ${state.notes}，应约 1946）`);
  // 2) 小节：200 个印刷小节（11 页，逐系统 4/5 小节），不应补/裁
  assert.equal(state.measureCount, 200, "整曲应为 200 个印刷小节");
  assert.equal(state.systemStats.appendedMeasures || 0, 0, "不应有补出来的小节");
  assert.equal(state.systemStats.trimmedMeasures || 0, 0, "不应有被裁掉的小节");
  // 3) 空小节：只有原谱第 76 小节（整小节休止，真静音）
  assert.deepEqual(state.emptyMeasures, [76], `空小节应只有原谱第 76 小节（实际 ${JSON.stringify(state.emptyMeasures)}）`);
  // 4) 变拍子：6/8 → 第 29 小节 2/4（界面文案 + 逐小节记录）
  assert.equal(state.timeSummary, "6/8（第 29 小节为 2/4）", `拍号说明不对（实际 ${state.timeSummary}）`);
  assert.deepEqual(state.meterChanges, [
    { measure: 1, meter: "6/8" },
    { measure: 29, meter: "2/4" },
  ], "变拍子应只在第 29 小节发生一次（不应有 3/4、4/4 的假变化）");
  assert.ok(Math.abs(state.totalBeats - 428) < 0.01, `整曲应为 428 拍 = 28×3 + 172×2（实际 ${state.totalBeats}）`);
  // 5) 调号：5 个降号 = Db（整曲不变调）
  assert.equal(state.keySummary, "Db", `调号应为 Db（5 个降号），实际 ${state.keySummary}`);
  assert.deepEqual(state.keyChanges, [{ measure: 1, key: "Db" }], "整曲不应有变调");
  // 6) 听感空拍：除第 76 小节（真静音 2 拍）外，不应有超过 1 拍的连续空隙
  const longHoles = state.holes.filter((hole) => hole.len >= 1);
  console.log("超过 1 拍的连续空隙（试听空拍）：", JSON.stringify(longHoles));
  const thunderHoles = longHoles.filter((hole) => !(hole.from >= 178 && hole.to <= 180));
  assert.deepEqual(thunderHoles, [], `除第 76 小节（beats 178–180）外不应有连续空拍：${JSON.stringify(thunderHoles)}`);
  // 7) 溢出音符：可疑系统放大复核后应显著变少（修复前 37 个）
  assert.ok((state.systemStats.overflowNotes || 0) <= 25,
    `超出小节的音符应 ≤ 25 个（实际 ${state.systemStats.overflowNotes}）`);
  assert.ok(state.hints.scoreWarnings.includes("图片型文档"),
    "应如实提示「图片型 PDF、约 206 DPI、请逐音校对」（在警告区）");
  // 8) 速度：原谱没有印刷速度标记 → 如实提示用手填 BPM（不能假装读到了）
  assert.equal(state.tempoDetected, false, "原谱没有 ♩=，不应假装读到速度");
  // 9) 性能：整本 11 页 52 个系统 + 个别可疑系统放大复核，给 220 秒上限
  assert.ok(elapsed < 220, `整本识别耗时应在 220 秒内（实际 ${elapsed.toFixed(1)} 秒）`);
  console.log("✅ 整本逐系统识别回归通过（图片型钢琴谱：变拍子/空小节/调号/可疑系统复核/性能）");

  // ===== 单页识别第 11 页：第一个系统没印拍号时，也不能把 2/4 小节当成 4 拍 =====
  for (let index = 1; index < 11; index++) await page.click("#nextPage");
  await page.waitForFunction(() => document.querySelector("#pageLabel")?.textContent?.startsWith("11 /"),
    null, { timeout: 30000 });
  await page.click("#recognizeButton");
  await page.waitForFunction(
    () => {
      const hint = document.querySelector("#scoreHint")?.textContent || "";
      return hint.includes("逐系统识别完成") || hint.includes("识别失败") || hint.includes("整页识别完成");
    },
    null,
    { timeout: 300000, polling: 500 },
  );
  const page11 = await page.evaluate(() => {
    const info = window.__pujian.state.scoreInfo || {};
    return {
      hint: document.querySelector("#scoreHint")?.textContent || "",
      measures: info.measureCount,
      beats: info.totalBeats,
      time: info.timeSummary,
      overflowNotes: (info.systemStats || {}).overflowNotes || 0,
    };
  });
  console.log("单页第 11 页：", JSON.stringify(page11));
  assert.ok(page11.hint.includes("逐系统识别完成"), "单页识别应成功");
  assert.equal(page11.measures, 4, "第 11 页应为 4 个小节（第 197–200 小节）");
  assert.ok(Math.abs(page11.beats - 8) < 0.01, `第 11 页应为 8 拍（4×2/4），实际 ${page11.beats}`);
  assert.equal(page11.time, "2/4", "第 11 页拍号应为 2/4");
  assert.equal(page11.overflowNotes, 0, "单页第 11 页不应有超出小节的音符（第一个系统要放大复核成 2/4）");
  console.log("✅ 单页逐系统识别回归通过（没印拍号的页首系统：拍数/溢出音符）");
} finally {
  await browser.close();
}
