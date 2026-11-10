// 真实 MIDI 导入端到端回归：《人是猫.mid》（11 条轨道 / 10 个有音符声部 / 80 小节 / ♩=148）。
//
// 用户需求原话：「支持导入MIDI（.mid）文件，并且能导出为乐谱（五线谱），并且能够在我们的乐谱预览和
// 旋律工作台中正常查看和播放。」
//
// 验证目标：
//   1. 导入：.mid 被接受，界面进入「已导入 MIDI」，横幅来源为 MIDI 文件（自动转谱）；
//   2. 数据：10 个声部、约 1752 个音符、80 小节、320 拍、4/4、♩=148、调号估出（c 小调/降E大调各 3 个降号）；
//   3. 乐谱预览：MuseScore 排版成多页五线谱 PDF，预览画布真有内容、能翻页；
//   4. 旋律工作台：音符列表已有行，可播放（只验证播放按钮可用/试听启动，不等整曲放完）;
//   5. 导出：MusicXML 与五线谱 PDF 两个按钮都能下载到非空文件。
//
// 用法（需要本机已装 MuseScore 与启动中的谱见服务）：
//   $env:PLAYWRIGHT_CORE=".../playwright-core"
//   $env:APP_URL="http://127.0.0.1:4492/"
//   $env:PUJIAN_MIDI_FILE="D:\识谱弹琴\.cache\midi\renshimao.mid"
//   node tests/e2e-realscore-midi.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const candidates = [
  process.env.PUJIAN_MIDI_FILE,
  "D:\\识谱弹琴\\.cache\\midi\\renshimao.mid",
].filter(Boolean);
const midiPath = candidates.find((path) => existsSync(path));
if (!midiPath) {
  console.log("SKIP：找不到测试 MIDI（可用 PUJIAN_MIDI_FILE 指定路径）");
  process.exit(0);
}

const downloadDir = mkdtempSync(join(tmpdir(), "pujian-midi-e2e-"));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
const started = Date.now();
try {
  await page.goto(appUrl + (appUrl.includes("?") ? "&" : "?") + "debug=1",
    { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__pujian), null, { timeout: 30000 });
  await page.setInputFiles("#fileInput", midiPath);
  await page.waitForFunction(
    () => document.querySelector("#scoreHint")?.textContent.includes("已排版成")
      || document.querySelector("#scoreHint")?.textContent.includes("已可试听"),
    null, { timeout: 180000, polling: 500 },
  );
  const elapsed = (Date.now() - started) / 1000;
  const state = await page.evaluate(() => {
    const app = window.__pujian.state;
    const info = app.scoreInfo || {};
    const notes = info.notes || [];
    const partNames = [...new Set(notes.map((note) => note.partName))];
    const partCounts = {};
    for (const note of notes) partCounts[note.partName] = (partCounts[note.partName] || 0) + 1;
    const canvas = document.querySelector("#scoreCanvas");
    const ctx = canvas.getContext("2d");
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4 * 97) {
      if (pixels[index] < 200 || pixels[index + 1] < 200 || pixels[index + 2] < 200) ink += 1;
    }
    return {
      hint: document.querySelector("#scoreHint")?.textContent || "",
      banner: document.querySelector("#recognitionSource")?.textContent || "",
      bannerDetail: document.querySelector("#recognitionDetail")?.textContent || "",
      fileInfo: document.querySelector("#fileInfo")?.textContent || "",
      details: document.querySelector("#scoreDetails")?.textContent || "",
      recognizeLabel: document.querySelector("#recognizeLabel")?.textContent || "",
      bpm: Number(document.querySelector("#tempoInput")?.value),
      notes: notes.length,
      partNames: partNames.sort(),
      partCounts,
      measureCount: info.measureCount,
      totalBeats: info.totalBeats,
      timeSummary: info.timeSummary,
      keySummary: info.keySummary,
      tempoMarks: info.tempoMarks,
      pageCount: app.pageCount,
      pdfLoaded: Boolean(app.pdf),
      canvasVisible: !document.querySelector("#canvasWrap").hidden,
      canvasSize: { width: canvas.width, height: canvas.height, ink },
      pageLabel: document.querySelector("#pageLabel")?.textContent || "",
      pageControlsVisible: !document.querySelector("#pageControls").hidden,
      noteRows: document.querySelectorAll("#noteList .note-row").length,
      exportVisible: !document.querySelector("#midiExportGroup").hidden,
      midiInfo: Boolean(app.midiInfo),
      groupingVisible: !document.querySelector("#midiGroupingRow").hidden,
      groupingValue: document.querySelector("#midiGroupingSelect")?.value || "",
      groupingHint: document.querySelector("#midiGroupingHint")?.textContent || "",
      groupingGroups: (app.midiInfo?.meta?.grouping?.groups || []).map((group) => ({
        name: group.name, role: group.role, tracks: group.tracks.length, notes: group.notes,
      })),
    };
  });
  console.log("MIDI 导入耗时：", elapsed.toFixed(1), "秒");
  console.log("界面提示：", state.hint);
  console.log("横幅：", state.banner, "|", state.bannerDetail);
  console.log("文件信息：", state.fileInfo);
  console.log("详情：", state.details);
  console.log("结构：", JSON.stringify({
    notes: state.notes, parts: state.partNames.length, partCounts: state.partCounts,
    measures: state.measureCount, beats: state.totalBeats, bpm: state.bpm,
    timeSummary: state.timeSummary, keySummary: state.keySummary,
    tempoMarks: state.tempoMarks, pageCount: state.pageCount,
    canvasSize: state.canvasSize, pageLabel: state.pageLabel,
    noteRows: state.noteRows, exportVisible: state.exportVisible,
  }, null, 1));
  if (errors.length) console.log("页面报错：", errors.slice(0, 5));

  // 1) 导入与来源标识
  assert.ok(state.midiInfo, "应记录 MIDI 导入信息");
  assert.equal(state.recognizeLabel, "已导入 MIDI", "识别按钮应显示「已导入 MIDI」");
  assert.match(state.banner, /MIDI/, "横幅应标明来源是 MIDI 文件");
  assert.match(state.fileInfo, /MIDI 文件/, "文件信息应标明 MIDI");

  // 2) 数据：10 条 MIDI 轨道（全是同一条洛天依人声的分层/叠录）应被自动整理成 2 个声部
  assert.equal(state.groupingVisible, true, "MIDI 导入后应显示「声部整理」下拉");
  assert.equal(state.groupingValue, "auto", "默认使用自动整理");
  assert.ok(state.groupingHint.includes("自动整理") || state.groupingHint.includes("同一条旋律"),
    `声部整理说明应讲清原因，实际：${state.groupingHint}`);
  assert.equal(state.partNames.length, 2, `应整理成 2 个声部（主旋律 + 和声/叠加层），实际 ${state.partNames.join("、")}`);
  assert.deepEqual(state.partNames, ["和声 / 叠加层", "主旋律"].sort(), "声部名应为「主旋律」「和声 / 叠加层」");
  assert.equal(state.groupingGroups.length, 2);
  assert.equal(state.groupingGroups[0].tracks, 6, "主旋律合并了 6 条轨道（主唱 + 双轨加宽 + 分段补轨 + 碎片轨）");
  assert.equal(state.groupingGroups[1].tracks, 4, "和声层合并了 4 条叠加轨道");
  assert.ok(state.notes >= 1400 && state.notes <= 1500, `去重后的音符数应在 1400–1500 之间，实际 ${state.notes}`);
  assert.equal(state.measureCount, 80, "应有 80 小节");
  assert.equal(state.totalBeats, 320, "全曲 320 拍");
  assert.equal(state.timeSummary, "4/4", "拍号应为 4/4");
  assert.equal(state.bpm, 148, "速度应从 MIDI 的 tempo 事件读出 ♩=148");
  assert.match(state.keySummary || "", /minor|major|[A-G]/, "应估出调号并展示");
  assert.match(state.fileInfo, /10 条轨道 → 2 个声部/, "文件信息应写明轨迹归并结果");

  // 3) 乐谱预览：MuseScore 排版的五线谱 PDF
  assert.ok(state.pdfLoaded, "五线谱 PDF 应已载入预览");
  assert.ok(state.canvasVisible, "预览画布应可见");
  assert.ok(state.pageCount > 1 && state.pageCount <= 10, `2 个声部应排版成不多于 10 页，实际 ${state.pageCount} 页`);
  assert.match(state.pageLabel, new RegExp(`^1 / ${state.pageCount}$`), "页码应显示 1 / 总页数");
  assert.ok(state.pageControlsVisible, "多页时应显示翻页控件");
  assert.ok(state.canvasSize.ink > 20, `预览画布应有内容，实际取到墨点 ${state.canvasSize.ink}`);

  // 4) 旋律工作台：有音符行，能播放
  assert.ok(state.noteRows > 0, "音符列表应有行");
  const canPlay = await page.evaluate(() => {
    const app = window.__pujian.state;
    return { playDisabled: document.querySelector("#playButton").disabled, notes: app.notes.length };
  });
  assert.equal(canPlay.playDisabled, false, "有音符时播放按钮应可用");
  assert.ok(canPlay.notes >= 1400, "旋律工作台应拿到同一份音符");
  await page.click("#playButton");
  await page.waitForFunction(() => window.__pujian.state.isPlaying === true, null, { timeout: 30000, polling: 200 });
  const playing = await page.evaluate(() => ({
    highlighted: document.querySelectorAll("#noteList .note-row.is-playing, #noteList .note-row.is-active").length,
    label: document.querySelector("#playLabel")?.textContent || "",
  }));
  console.log("播放中：高亮行", playing.highlighted, "| 按钮文案", playing.label);
  await page.click("#stopButton");
  await page.waitForFunction(() => window.__pujian.state.isPlaying === false, null, { timeout: 20000, polling: 200 });

  // 5) 导出：MusicXML 与五线谱 PDF
  const xmlDownloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.click("#exportMusicXmlButton");
  const xmlDownload = await xmlDownloadPromise;
  const xmlPath = join(downloadDir, "export.musicxml");
  await xmlDownload.saveAs(xmlPath);
  const xmlBytes = readFileSync(xmlPath);
  console.log("导出 MusicXML：", xmlBytes.length, "字节，文件名：", xmlDownload.suggestedFilename());
  assert.ok(xmlBytes.length > 20000, `导出的 MusicXML 应有内容，实际 ${xmlBytes.length} 字节`);
  assert.match(xmlBytes.toString("utf8", 0, 200), /score-partwise/, "导出内容应是 MusicXML");
  assert.match(xmlDownload.suggestedFilename(), /\.musicxml$/, "导出文件名应以 .musicxml 结尾");

  const pdfDownloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.click("#exportStaffPdfButton");
  const pdfDownload = await pdfDownloadPromise;
  const pdfPath = join(downloadDir, "export.pdf");
  await pdfDownload.saveAs(pdfPath);
  const pdfBytes = readFileSync(pdfPath);
  console.log("导出五线谱 PDF：", pdfBytes.length, "字节，文件名：", pdfDownload.suggestedFilename());
  assert.ok(pdfBytes.length > 50000, `导出的五线谱 PDF 应有内容，实际 ${pdfBytes.length} 字节`);
  assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-", "导出内容应是 PDF");
  assert.match(pdfDownload.suggestedFilename(), /\.pdf$/, "导出文件名应以 .pdf 结尾");


  // 6) 声部整理方式切换：只保留主旋律（1 个声部）→ 每条轨道一个声部（10 个）→ 再切回自动（2 个）
  async function switchGrouping(value, expectedParts) {
    await page.selectOption("#midiGroupingSelect", value);
    await page.waitForFunction(
      (parts) => (document.querySelector("#scoreHint")?.textContent || "").includes("已排版成")
        && (window.__pujian.state.scoreInfo?.partNames?.length || 0) === parts,
      expectedParts, { timeout: 180000, polling: 300 },
    );
    return page.evaluate(() => ({
      parts: window.__pujian.state.scoreInfo.partNames.length,
      names: window.__pujian.state.scoreInfo.partNames,
      pages: window.__pujian.state.pageCount,
      value: document.querySelector("#midiGroupingSelect")?.value,
    }));
  }
  const melodyMode = await switchGrouping("melody", 1);
  console.log("只保留主旋律：", JSON.stringify(melodyMode));
  assert.equal(melodyMode.parts, 1, "只保留主旋律时应只有 1 个声部");
  assert.deepEqual(melodyMode.names, ["主旋律"]);
  const tracksMode = await switchGrouping("tracks", 10);
  console.log("每条轨道一个声部：", JSON.stringify(tracksMode));
  assert.equal(tracksMode.parts, 10, "每条轨道一个声部时应为 10 个声部");
  const autoMode = await switchGrouping("auto", 2);
  console.log("切回自动整理：", JSON.stringify(autoMode));
  assert.deepEqual(autoMode.names.slice().sort(), ["和声 / 叠加层", "主旋律"].sort());
  // 7) 翻页：乐谱预览能正常翻到第 2 页（等渲染完成后再读页码，页码是渲染收尾时才更新的）
  await page.click("#nextPage");
  await page.waitForFunction(
    () => (document.querySelector("#pageLabel")?.textContent || "").startsWith("2 /"),
    null, { timeout: 30000, polling: 200 },
  );
  const pageTwoLabel = await page.textContent("#pageLabel");
  console.log("翻页后页码：", pageTwoLabel);
  assert.match(pageTwoLabel, /^2 \/ \d+$/, "翻页后页码应变为 2 / N");

  assert.deepEqual(errors, [], "页面不应有 JS 报错");
  console.log("MIDI 导入端到端回归通过 ✔");
} finally {
  await browser.close();
  rmSync(downloadDir, { recursive: true, force: true });
}
