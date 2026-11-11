// 真实阿卡贝拉 MIDI 回归：《喵卡贝拉.mid》（合唱队阿卡贝拉队用）。
//
// 验证目标：
//   1. 导入后被自动识别为「阿卡贝拉编配」，默认落到 6 声部核心版（主唱1/主唱2/和声高/中/低/低音）；
//   2. 下拉可切「完整版」（核心 + 结尾叠层，10 声部）和「全部轨道参考」（12 声部，含加花）；
//   3. 每种版本都能导出 MusicXML（文件名带版本标记，内容声部数正确），预览/试听/翻页正常。
//
// 用法（需要本机已有该 MIDI 与启动中的谱见服务）：
//   $env:PLAYWRIGHT_CORE=".../playwright-core"
//   $env:APP_URL="http://127.0.0.1:4492/"
//   node tests/e2e-realscore-acappella.mjs
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
  "D:\\识谱弹琴\\.cache\\midi\\miao.mid",
].filter(Boolean);
const midiPath = candidates.find((path) => existsSync(path));
if (!midiPath) {
  console.log("SKIP：找不到《喵卡贝拉.mid》（可用 PUJIAN_MIDI_FILE 指定路径）");
  process.exit(0);
}

const downloadDir = mkdtempSync(join(tmpdir(), "pujian-acappella-"));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
const started = Date.now();
try {
  await page.goto(appUrl + (appUrl.includes("?") ? "&" : "?") + "debug=1",
    { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__pujian), null, { timeout: 30000 });
  await page.setInputFiles("#fileInput", midiPath);
  await page.waitForFunction(
    () => (document.querySelector("#scoreHint")?.textContent || "").includes("已排版成"),
    null, { timeout: 180000, polling: 300 },
  );
  const elapsed = (Date.now() - started) / 1000;

  const readState = () => page.evaluate(() => {
    const app = window.__pujian.state;
    const info = app.scoreInfo || {};
    return {
      hint: document.querySelector("#scoreHint")?.textContent || "",
      fileInfo: document.querySelector("#fileInfo")?.textContent || "",
      groupingHint: document.querySelector("#midiGroupingHint")?.textContent || "",
      groupingValue: document.querySelector("#midiGroupingSelect")?.value,
      selectedLabel: document.querySelector("#midiGroupingSelect")?.selectedOptions?.[0]?.textContent || "",
      parts: info.partNames || [],
      notes: (info.notes || []).length,
      measures: info.measureCount,
      pageCount: app.pageCount,
      applied: app.midiInfo?.meta?.grouping?.applied,
      acappella: app.midiInfo?.meta?.grouping?.acappellaAvailable,
      roles: (app.midiInfo?.meta?.grouping?.acappellaRoles || []).map((role) => `${role.name}←${role.track}`),
      versions: app.midiInfo?.meta?.grouping?.acappellaVersions,
    };
  });

  const state = await readState();
  console.log("导入耗时：", elapsed.toFixed(1), "秒");
  console.log("界面提示：", state.hint);
  console.log("文件信息：", state.fileInfo);
  console.log("整理说明：", state.groupingHint);
  console.log("结构：", JSON.stringify(state, null, 1));
  if (errors.length) console.log("页面报错：", errors.slice(0, 5));

  // 1) 自动识别 → 6 声部核心版
  assert.equal(state.acappella, true, "应自动识别为阿卡贝拉编配");
  assert.equal(state.applied, "acappella6");
  assert.equal(state.parts.length, 6, `默认核心版应为 6 个声部，实际 ${state.parts.length}`);
  assert.deepEqual(state.parts, ["主唱 1", "主唱 2", "和声 · 高", "和声 · 中", "和声 · 低", "低音"]);
  assert.deepEqual(state.versions, { core: 6, full: 10, reference: 12 });
  assert.equal(state.roles.length, 12, "应识别全部 12 条人声轨的角色");
  assert.match(state.fileInfo, /12 条轨道 → 6 个声部/, "文件信息应写清 12 轨 → 6 声部");
  assert.match(state.groupingHint, /阿卡贝拉/, "说明里应写明阿卡贝拉编配");
  assert.match(state.groupingHint, /叠层|加花/, "说明里应提示还有叠层/加花未列入");
  assert.ok(state.pageCount > 1, "多声部应排版成多页");

  // 走一条播放验证（只确认能开始/停止，不等整曲）
  await page.click("#playButton");
  await page.waitForFunction(() => window.__pujian.state.isPlaying === true, null, { timeout: 30000 });
  await page.click("#stopButton");
  await page.waitForFunction(() => window.__pujian.state.isPlaying === false, null, { timeout: 20000 });

  // 2) 切换三种版本，并各导出一份 MusicXML 核对声部数
  async function switchGrouping(value, expectedParts) {
    await page.selectOption("#midiGroupingSelect", value);
    await page.waitForFunction(
      (parts) => (document.querySelector("#scoreHint")?.textContent || "").includes("已排版成")
        && (window.__pujian.state.scoreInfo?.partNames?.length || 0) === parts,
      expectedParts, { timeout: 180000, polling: 300 },
    );
    const snapshot = await readState();
    console.log(`切到 ${value}：`, JSON.stringify({
      parts: snapshot.parts, pages: snapshot.pageCount, applied: snapshot.applied,
      hint: snapshot.groupingHint.slice(0, 80),
    }));
    return snapshot;
  }
  async function exportMusicXmlAs(snapshot, expectedParts, expectedNamePart) {
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
    await page.click("#exportMusicXmlButton");
    const download = await downloadPromise;
    const path = join(downloadDir, "export.musicxml");
    await download.saveAs(path);
    const text = readFileSync(path, "utf8");
    const partCount = (text.match(/<score-part /g) || []).length;
    console.log(`导出 ${expectedNamePart}：`, download.suggestedFilename(), `${text.length} 字节，声部数 ${partCount}`);
    assert.equal(partCount, expectedParts, `${expectedNamePart} 导出的 MusicXML 声部数应为 ${expectedParts}`);
    assert.ok(download.suggestedFilename().includes(expectedNamePart),
      `导出文件名应带「${expectedNamePart}」，实际：${download.suggestedFilename()}`);
    void snapshot;
  }

  const core = await switchGrouping("acappella6", 6);
  await exportMusicXmlAs(core, 6, "阿卡贝拉6声部");

  const full = await switchGrouping("acappella10", 10);
  assert.deepEqual(full.parts.slice(6), ["叠层 1", "叠层 2", "叠层 3", "叠层 4"], "完整版后 4 个应为结尾叠层");
  assert.match(full.groupingHint, /完整演出版|完整/, "说明里应写明完整版含叠层");
  await exportMusicXmlAs(full, 10, "阿卡贝拉10声部");

  const reference = await switchGrouping("acappella12", 12);
  assert.ok(reference.parts.slice(10).every((name) => name.startsWith("加花")), "全部轨道最后两条应为加花");
  assert.match(reference.groupingHint, /全部轨道/, "说明里应写明这是全部轨道参考");
  await exportMusicXmlAs(reference, 12, "阿卡贝拉全部轨道");

  // 3) 三种版本切换后，翻页/预览仍正常
  await page.click("#nextPage");
  await page.waitForFunction(
    () => (document.querySelector("#pageLabel")?.textContent || "").startsWith("2 /"),
    null, { timeout: 30000, polling: 200 },
  );
  const pageLabel = await page.textContent("#pageLabel");
  console.log("翻页后页码：", pageLabel);
  assert.match(pageLabel, /^2 \/ \d+$/);

  // 4) 切回默认自动 → 仍是 6 声部核心版
  const backToAuto = await switchGrouping("auto", 6);
  assert.equal(backToAuto.applied, "acappella6");
  assert.deepEqual(backToAuto.parts, ["主唱 1", "主唱 2", "和声 · 高", "和声 · 中", "和声 · 低", "低音"]);

  assert.deepEqual(errors, [], "页面不应有 JS 报错");
  console.log("阿卡贝拉 MIDI 端到端回归通过 ✔");
} finally {
  await browser.close();
  rmSync(downloadDir, { recursive: true, force: true });
}
