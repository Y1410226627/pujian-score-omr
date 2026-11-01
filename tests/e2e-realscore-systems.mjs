// 真实乐谱端到端回归：《混声三部合唱五线谱 敕勒歌》（用户实际反馈不准的那份谱）。
//
// 验证目标（都是用户原话里的问题）：
//   1. 声部识别：应该是 5 个声部（Soprano / Alto / Baritone / 陶笛 / Piano），钢琴只有一个声部；
//   2. BPM：谱面 ♩=68 要被读到（不是默认 84）；
//   3. 中间没有「莫名其妙的空拍」：每页起拍应连续、小节号与印刷小节号一致；
//   4. 五线谱符号：圆滑线/连音线/力度/渐强渐弱/延长号等要被解析出来；
//   5. 变拍子：第 54、66 小节为 6/4，其余 4/4（整曲 69 小节 / 281 拍）。
//
// 用法（需要本机已装 Audiveris 与启动中的谱见服务）：
//   $env:PLAYWRIGHT_CORE=".../playwright-core"
//   $env:APP_URL="http://127.0.0.1:4492/"
//   $env:PUJIAN_SCORE_PDF="D:\桌面\学生组织\合唱队\混声三部合唱五线谱 敕勒歌.pdf"
//   node tests/e2e-realscore-systems.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const candidates = [
  process.env.PUJIAN_SCORE_PDF,
  "D:\\桌面\\学生组织\\合唱队\\混声三部合唱五线谱 敕勒歌.pdf",
  "D:\\识谱弹琴\\.cache\\omr\\chilege.pdf",
].filter(Boolean);
const pdfPath = candidates.find((path) => existsSync(path));
if (!pdfPath) {
  console.log("SKIP：找不到《敕勒歌》PDF（可用 PUJIAN_SCORE_PDF 指定路径）");
  process.exit(0);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
const started = Date.now();
try {
  await page.goto(appUrl + (appUrl.includes("?") ? "&" : "?") + "debug=1",
    { waitUntil: "domcontentloaded", timeout: 60000 });
  // 不能等 networkidle：页面空闲时会后台预加载全部音源（83 个 bank），网络一直有请求。
  await page.waitForFunction(() => Boolean(window.__pujian), null, { timeout: 30000 });
  await page.setInputFiles("#fileInput", pdfPath);
  await page.waitForFunction(() => window.__pujian?.state?.pageCount === 10, null, { timeout: 60000 });
  console.log("PDF 已载入，10 页");
  await page.click("#recognizeAllButton");
  // 整本逐系统识别：10 页 19 个系统，实测本机约 60–90 秒
  await page.waitForFunction(
    () => {
      const hint = document.querySelector("#scoreHint")?.textContent || "";
      return hint.includes("整本识别完成") || hint.includes("整本识别失败");
    },
    null,
    { timeout: 300000, polling: 1000 },
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const state = await page.evaluate(() => {
    const debug = window.__pujian;
    const scoreInfo = debug.state.scoreInfo || {};
    const hints = {
      scoreHint: document.querySelector("#scoreHint")?.textContent || "",
      scoreDetails: document.querySelector("#scoreDetails")?.textContent || "",
      scoreWarnings: document.querySelector("#scoreWarnings")?.textContent || "",
      tempoInput: document.querySelector("#tempoInput")?.value || "",
      tempoHint: document.querySelector("#tempoHint")?.textContent || "",
    };
    const parts = [...new Set((scoreInfo.notes || []).map((note) => note.partId))];
    const partNames = {};
    for (const note of scoreInfo.notes || []) partNames[note.partId] = note.partName;
    const beatEnds = {};
    for (const note of scoreInfo.notes || []) {
      beatEnds[note.partId] = Math.max(beatEnds[note.partId] || 0, note.startBeat + (note.playBeats || note.durationBeats || 0));
    }
    // 变拍子小节（第 54、66 小节是 6/4）：看小节的「相对落拍」有没有被错误压到第 4 拍以内。
    const measureRelative = (measure) => {
      const list = (scoreInfo.notes || []).filter((note) => Number(note.measure) === measure);
      if (!list.length) return { count: 0, maxRelative: null };
      const base = Math.min(...list.map((note) => note.startBeat - (Number(note.startInMeasure) || 0)));
      const maxRelative = Math.max(...list.map((note) => Number((note.startBeat - base).toFixed(2))));
      return { count: list.length, maxRelative };
    };
    return {
      hints,
      notes: (scoreInfo.notes || []).length,
      parts,
      partNames,
      measureCount: scoreInfo.measureCount,
      totalBeats: scoreInfo.totalBeats,
      tempo: scoreInfo.tempo,
      tempoDetected: scoreInfo.tempoDetected,
      timeSummary: scoreInfo.timeSummary,
      keySummary: scoreInfo.keySummary,
      symbolCounts: scoreInfo.symbolCounts || {},
      warnings: scoreInfo.warnings || [],
      meterChanges: scoreInfo.meterChanges || [],
      systemStats: scoreInfo.systemStats || {},
      beatEnds,
      bar54: measureRelative(54),
      bar66: measureRelative(66),
      gridded: (scoreInfo.notes || []).every((note) => {
        const value = note.startBeat * 4;
        return Math.abs(value - Math.round(value)) < 0.01;
      }),
    };
  });
  console.log("识别耗时：", elapsed, "秒");
  console.log("界面提示：", state.hints.scoreHint);
  console.log("详情：", state.hints.scoreDetails);
  console.log("BPM 输入框：", state.hints.tempoInput, "| 提示：", state.hints.tempoHint);
  console.log("结构：", JSON.stringify({
    notes: state.notes,
    parts: state.parts,
    partNames: state.partNames,
    measures: state.measureCount,
    beats: state.totalBeats,
    tempo: state.tempo,
    time: state.timeSummary,
    key: state.keySummary,
  }, null, 1));
  console.log("符号统计：", JSON.stringify(state.symbolCounts));
  console.log("警告：", state.warnings);
  console.log("拍号变化：", JSON.stringify(state.meterChanges));
  if (errors.length) console.log("页面报错：", errors.slice(0, 5));
  assert.ok(state.hints.scoreHint.includes("整本识别完成"), "整本识别应成功");
  assert.equal(state.parts.length, 5, "应该识别出 5 个声部");
  assert.deepEqual(Object.values(state.partNames).sort(), ["Alto", "Baritone", "Piano", "Soprano", "陶笛"].sort(), "声部名应与谱面标签一致");
  assert.equal(Math.round(state.tempo), 68, "BPM 应为谱面 ♩=68");
  assert.equal(state.tempoDetected, true, "速度应标注为『从谱面读到』");
  assert.equal(state.measureCount, 69, "整曲应为 69 个印刷小节");
  assert.ok(Math.abs(state.totalBeats - 281) < 0.01, "整曲应为 281 拍（含第 54、66 小节的 6/4）");
  assert.match(state.timeSummary, /6\/4/, "变拍子说明里应出现 6/4");
  assert.equal(state.keySummary, "F", "调号应为 F（一个降号）");
  assert.ok((state.symbolCounts.slurs || 0) >= 80, "圆滑线应被识别（>=80 处）");
  assert.ok((state.symbolCounts.ties || 0) >= 100, "连音线应被识别（>=100 处）");
  assert.ok((state.symbolCounts.dynamics || 0) >= 30, "力度记号应被识别（>=30 处）");
  assert.ok((state.symbolCounts.wedges || 0) >= 60, "渐强/渐弱记号应被识别（>=60 个端点）");
  assert.ok(state.gridded, "所有起拍都应落在 1/4 拍网格上");
  // 变拍子：第 54、66 小节是 6/4，音符必须能落在第 5、6 拍，不能被量化挤回第 4 拍（以前的老 bug）。
  console.log("变拍子小节落拍：bar54 =", JSON.stringify(state.bar54), " bar66 =", JSON.stringify(state.bar66));
  assert.ok(state.bar54.count >= 18, `第 54 小节（6/4）应有足够音符（实际 ${state.bar54.count}）`);
  assert.ok(state.bar66.count >= 18, `第 66 小节（6/4）应有足够音符（实际 ${state.bar66.count}）`);
  // 修复前的量化 bug 会把 6/4 小节里第 5/6 拍的音压到 3.5 拍；修复后 bar54 最远到 5.75、bar66 到 4。
  assert.ok(state.bar54.maxRelative >= 4.5 && state.bar54.maxRelative < 6.01,
    `第 54 小节是 6/4：应有音落在第 5 拍之后（实际最远相对落拍 ${state.bar54.maxRelative}）`);
  assert.ok(state.bar66.maxRelative >= 3.99 && state.bar66.maxRelative < 6.01,
    `第 66 小节是 6/4：第 4 拍的音不能被压到 3.5（实际最远相对落拍 ${state.bar66.maxRelative}）`);
  // 放大 2× 后 Audiveris 的小节线也读回来了：不应再有「补小节/裁小节」
  assert.equal(state.systemStats.trimmedMeasures || 0, 0, "不应有被裁掉的小节（放大后小节线读全了）");
  assert.equal(state.systemStats.appendedMeasures || 0, 0, "不应有需要补的小节");
  // 每页之间的起拍应连续：整曲最后一声不能早于总拍数太多（有 2 个空小节属正常结尾）
  const maxBeatEnd = Math.max(...Object.values(state.beatEnds));
  assert.ok(maxBeatEnd > state.totalBeats - 8, `最后一个音应接近曲末（${maxBeatEnd.toFixed(1)} / ${state.totalBeats}）`);
  console.log("✅ 整本逐系统识别回归通过");

  // ===== 单页识别（第 5 页：陶笛也参与演奏，能验证 5 个声部都在）=====
  for (let index = 0; index < 4; index++) await page.click("#nextPage");
  await page.waitForFunction(() => document.querySelector("#pageLabel")?.textContent?.startsWith("5 /"), null, { timeout: 30000 });
  await page.click("#recognizeButton");
  await page.waitForFunction(
    () => {
      const hint = document.querySelector("#scoreHint")?.textContent || "";
      return hint.includes("逐系统识别完成") || hint.includes("识别失败") || hint.includes("整页识别完成");
    },
    null,
    { timeout: 180000, polling: 500 },
  );
  const singleState = await page.evaluate(() => {
    const info = window.__pujian.state.scoreInfo || {};
    const parts = [...new Set((info.notes || []).map((note) => note.partId))];
    const measures = [...new Set((info.notes || []).map((note) => Number(note.measure)))].sort((a, b) => a - b);
    return {
      hint: document.querySelector("#scoreHint")?.textContent || "",
      bpm: document.querySelector("#tempoInput")?.value || "",
      notes: (info.notes || []).length,
      parts,
      partNames: [...new Set((info.notes || []).map((note) => note.partName))].sort(),
      measures: info.measureCount,
      beats: info.totalBeats,
      time: info.timeSummary,
      measureLabels: measures,
    };
  });
  console.log("单页第 5 页：", JSON.stringify(singleState));
  assert.ok(singleState.hint.includes("逐系统识别完成"), "单页识别应成功");
  assert.equal(singleState.parts.length, 5, "单页识别也应是 5 个声部（钢琴不能拆开）");
  assert.equal(Math.round(Number(singleState.bpm)), 68, "单页识别也应读到 ♩=68（从 PDF 文字层兜底）");
  assert.equal(singleState.measures, 6, "第 5 页应为 6 个正规小节");
  assert.ok(Math.abs(singleState.beats - 24) < 0.01, "第 5 页应为 24 拍（6×4）");
  assert.equal(singleState.measureLabels[0], 35, "单页小节号应按原谱印刷号从第 35 小节开始");
  console.log("✅ 单页逐系统识别回归通过");

  // ===== 单页识别（第 1 页：陶笛整页休止，声部面板必须仍然显示「陶笛 0音（休止）」）=====
  // 用户反馈过「我的陶笛呢？被裁掉了？」——第 1 页陶笛在谱面上全是整小节休止，
  // 以前声部面板只按「有音符的声部」列行，看起来就像陶笛丢了。
  for (let index = 0; index < 4; index++) await page.click("#prevPage");
  await page.waitForFunction(() => document.querySelector("#pageLabel")?.textContent?.startsWith("1 /"), null, { timeout: 30000 });
  await page.click("#recognizeButton");
  await page.waitForFunction(
    () => {
      const hint = document.querySelector("#scoreHint")?.textContent || "";
      return hint.includes("逐系统识别完成") || hint.includes("识别失败") || hint.includes("整页识别完成");
    },
    null,
    { timeout: 180000, polling: 500 },
  );
  const page1State = await page.evaluate(() => ({
    hint: document.querySelector("#scoreHint")?.textContent || "",
    details: document.querySelector("#scoreDetails")?.textContent || "",
    bpm: document.querySelector("#tempoInput")?.value || "",
    partRows: [...document.querySelectorAll("#partList .part-row")].map((row) => ({
      name: row.querySelector(".part-name-select")?.value || "",
      count: row.querySelector("small")?.textContent || "",
    })),
  }));
  console.log("单页第 1 页：", JSON.stringify(page1State));
  assert.equal(page1State.partRows.length, 5, "声部面板应显示 5 行（陶笛本页休止也要列出来，不能像被裁掉）");
  const ocarinaRow = page1State.partRows.find((row) => row.name === "陶笛");
  assert.ok(ocarinaRow, "声部面板里必须有陶笛");
  assert.match(ocarinaRow.count, /0音.*休止/, "陶笛这一页应为 0 音（休止）而不是消失");
  assert.match(page1State.details, /陶笛当前整段休止/, "详情行要说明陶笛本页整段休止、不是被裁掉");
  assert.equal(Math.round(Number(page1State.bpm)), 68, "单页第 1 页也应读到 ♩=68");
  console.log("✅ 单页第 1 页「陶笛休止不丢声部」回归通过");
} finally {
  await browser.close();
}
