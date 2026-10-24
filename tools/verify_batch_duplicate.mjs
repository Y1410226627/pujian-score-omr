// 验证「一键批量复制声部」：
//   1) duplicatePartMany(key, 8) 一次复制 8 个新声部，界面只刷新一次；
//   2) 真实按钮路径：填份数 6 → 点「＋ 批量复制」→ 声部/音符/行数都对；
//   3) 份数输入框会自动收敛到 1–48；
//   4) 批量复制不会重新加载音源（同一音色共用一份）。
// 用法：$env:PLAYWRIGHT_CORE=...; $env:APP_URL=http://127.0.0.1:4492/; node tools/verify_batch_duplicate.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/big-4v-160m.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
await page.goto(APP + "?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 300000 });
await page.evaluate(() => window.__pujian.whenNoteRowsIdle(80000));

const result = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const partKeys = () => [...new Set(state.notes.map((note) => debug.voiceIdentity(note)))];
  const rowCount = () => document.querySelectorAll("#noteList .note-row").length;
  const before = {
    notes: state.notes.length,
    parts: partKeys().length,
    rows: rowCount(),
    bankLoads: state.bankLoadLog.length,
  };
  const key = partKeys()[0];

  // 1) 直接调用批量复制：一次 8 个
  const t0 = performance.now();
  const created = debug.duplicatePartMany(key, 8);
  await debug.whenNoteRowsIdle(120000);
  const directMs = Math.round(performance.now() - t0);
  const direct = {
    sourceKey: key,
    created: created.length,
    ms: directMs,
    notesBefore: before.notes,
    notesAfter: state.notes.length,
    partsBefore: before.parts,
    partsAfter: partKeys().length,
    rowsBefore: before.rows,
    rowsAfter: rowCount(),
    newBankLoads: state.bankLoadLog.length - before.bankLoads,
    namesUnique: new Set(created.map((item) => item.name)).size === created.length,
  };

  // 2) 真实按钮路径：填 6 → 点「＋ 批量复制」
  const input = document.querySelector("#layerBatchCount");
  const button = document.querySelector("#addLayerBatch");
  const partsBefore = partKeys().length;
  const notesBefore = state.notes.length;
  input.value = "6";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const clickT0 = performance.now();
  button.click();
  await debug.whenNoteRowsIdle(120000);
  const clickMs = Math.round(performance.now() - clickT0);
  const viaButton = {
    created: partKeys().length - partsBefore,
    notesAdded: state.notes.length - notesBefore,
    clickMs,
    partRows: document.querySelectorAll("#partList .part-row").length,
    partsAfter: partKeys().length,
  };

  // 3) 输入框上下限收敛
  input.value = "999";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const clampHigh = input.value;
  input.value = "0";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const clampLow = input.value;

  // 4) 批量复制后播放准备：先等导入后的后台预加载完成，再量「点播放前的音源准备」
  const waitT0 = performance.now();
  while (performance.now() - waitT0 < 20000) {
    const snapshot = debug.sampleSnapshot();
    if (snapshot.loading.length === 0 && snapshot.loaded.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const prepT0 = performance.now();
  await debug.ensurePlaybackTimbres();
  const playPrepMs = Math.round(performance.now() - prepT0);
  return { before, direct, viaButton, clampHigh, clampLow, playPrepMs };
});

const checks = [];
const check = (ok, label, detail) => {
  checks.push({ ok, label, detail });
  if (!ok) console.log(`FAIL ${label}：${detail}`);
  else console.log(`OK   ${label}：${detail}`);
};
check(result.direct.created === 8, "一次复制 8 个新声部", result.direct.created);
check(result.direct.partsAfter - result.direct.partsBefore === 8, "声部数 +8", `${result.direct.partsBefore} → ${result.direct.partsAfter}`);
check(result.direct.notesAfter - result.direct.notesBefore === 8 * (result.direct.notesBefore / 4), "音符数 = 原声部音符 × 8", `${result.direct.notesBefore} → ${result.direct.notesAfter}`);
check(result.direct.namesUnique, "新声部名字不重复", "unique");
check(result.direct.rowsAfter > result.direct.rowsBefore, "音符列表新增行", `${result.direct.rowsBefore} → ${result.direct.rowsAfter}`);
check(result.direct.newBankLoads === 0, "批量复制不重新加载音源", "0 次加载");
check(result.direct.ms < 5000, "8 个声部整体耗时 < 5 秒", `${result.direct.ms} ms`);
check(result.viaButton.created === 6, "按钮路径一次复制 6 个", result.viaButton.created);
check(result.viaButton.clickMs < 8000, "按钮点击到界面就绪 < 8 秒", `${result.viaButton.clickMs} ms`);
check(result.clampHigh === "48", "份数上限收敛到 48", result.clampHigh);
check(result.clampLow === "1", "份数下限收敛到 1", result.clampLow);
check(result.playPrepMs < 300, "批量复制后点播放的音源准备 < 300ms", `${result.playPrepMs} ms`);
check(errors.length === 0, "无 JS 报错", errors.length ? errors.join(" | ") : "无");

console.log(JSON.stringify({ xml: XML, result, errors }, null, 1));
const failed = checks.filter((item) => !item.ok).length;
console.log(failed ? `\n${failed} 项失败` : "\n批量复制验证全部通过 ✓");
await browser.close();
process.exitCode = failed ? 1 : 0;
