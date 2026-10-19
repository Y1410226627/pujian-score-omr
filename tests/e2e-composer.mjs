// 创作室端到端验证：真的在浏览器里点出几个音、试听、导出三种文件。
//
// 用法（需要本机有 Edge 与 playwright-core）：
//   $env:PLAYWRIGHT_CORE=".../node_modules/playwright-core"
//   $env:APP_URL="http://127.0.0.1:4492/"
//   node tests/e2e-composer.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));

try {
  await page.goto(new URL("composer.html", appUrl).href, { waitUntil: "networkidle" });
  await page.waitForSelector("#miniKeyboard .key", { timeout: 20000 });

  // 1) 键盘与音高显示
  const keys = await page.locator("#miniKeyboard .key").count();
  console.log("钢琴键数：", keys);
  assert.ok(keys >= 30, "键盘应该至少覆盖 3 个八度");
  assert.equal(await page.textContent("#pitchLabel"), "C4");

  // 2) 加 4 个音（第一小节填满）
  for (const [keyIndex, chipBeats] of [[0, "1"], [2, "1"], [4, "1"], [7, "1"]]) {
    await page.locator("#miniKeyboard .key").nth(keyIndex).click();
    await page.locator(`#valueChips .chip[data-beats="${chipBeats}"]`).click();
    await page.locator("#addNote").click();
  }
  const stateAfter = await page.evaluate(() => {
    const score = window.__pujianComposer.state.score;
    return {
      parts: score.parts.length,
      measures: score.parts[0].measures.length,
      notes: score.parts[0].measures[0].beats.map((note) => note.midi),
    };
  });
  console.log("写进去的音：", JSON.stringify(stateAfter));
  assert.equal(stateAfter.notes.length, 4, "第一小节应有 4 个音");
  assert.ok(stateAfter.notes.every((midi) => Number.isFinite(midi)));

  // 3) 五线谱渲染出来了（SVG 里有符头），并且每个音都有可点击的热区
  const svgNotes = await page.locator("#scoreEditor svg [class*=stavenote]").count();
  const hitAreas = await page.locator("#scoreEditor .note-hit").count();
  console.log("五线谱上的音符元素：", svgNotes, " 可点击热区：", hitAreas);
  assert.ok(svgNotes >= 4, "五线谱应该画出音符");
  assert.equal(hitAreas, 4, "每个音都应该有一块可点击的热区");

  // 3b) 点谱面上的音 → 选中并显示编辑按钮
  await page.locator("#scoreEditor .note-hit").first().click();
  await page.waitForSelector("#editToolbar:not([hidden])", { timeout: 5000 });
  const selectionText = await page.textContent("#selectionInfo");
  console.log("点选后：", selectionText.trim());
  assert.ok(selectionText.includes("已选中"), "点音符应能选中它");

  // 4) 试听：点「从头听整首」后状态变成播放中
  await page.locator("#playAll").click();
  await page.waitForFunction(() => document.querySelector("#playbackState").textContent.includes("正在播放"), null, { timeout: 8000 });
  console.log("试听状态：", await page.textContent("#playbackState"));
  await page.locator("#stopPlay").click();

  // 5) 换音色（含未安装的采样音色也要能选，退回合成）
  await page.selectOption("#scoreTimbre", { index: 1 });
  await page.locator("#pitchPlay").click();

  // 6) 多声部：加第二个声部再写一个音
  await page.locator("#addPart").click();
  await page.locator("#miniKeyboard .key").nth(5).click();
  await page.locator("#addNote").click();
  const partsAfter = await page.evaluate(() => window.__pujianComposer.state.score.parts.length);
  console.log("声部数：", partsAfter);
  assert.equal(partsAfter, 2, "应能加第二个声部");

  // 7) 三种导出都真的下载到文件
  const downloads = [];
  for (const [selector, expectExt] of [["#exportMusicXml", "musicxml"], ["#exportMidi", "mid"], ["#exportProject", "json"]]) {
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.locator(selector).click()]);
    const name = download.suggestedFilename();
    const path = await download.path();
    const size = path ? require("node:fs").statSync(path).size : 0;
    downloads.push({ name, size });
    console.log(`导出 ${expectExt}:`, name, size, "字节");
    assert.ok(name.endsWith("." + expectExt), `文件名应以 .${expectExt} 结尾，实际 ${name}`);
    assert.ok(size > 100, "导出文件不应为空");
  }

  // 8) 撤销 / 重做：连点两次撤销应回到「只有 1 个声部」，重做能再回来
  const beforeUndo = await page.evaluate(() => ({
    parts: window.__pujianComposer.state.score.parts.length,
    history: window.__pujianComposer.state.history.length,
  }));
  await page.evaluate(() => document.querySelector("#undo").click());
  await page.evaluate(() => document.querySelector("#undo").click());
  const afterUndo = await page.evaluate(() => window.__pujianComposer.state.score.parts.length);
  await page.evaluate(() => document.querySelector("#redo").click());
  await page.evaluate(() => document.querySelector("#redo").click());
  const afterRedo = await page.evaluate(() => window.__pujianComposer.state.score.parts.length);
  console.log("撤销前（声部/历史）：", beforeUndo, "撤销后：", afterUndo, "重做后：", afterRedo);
  assert.ok(beforeUndo.history >= 2, "每次改谱都应该进历史栈");
  assert.equal(afterUndo, 1, "连撤两次应回退到只有 1 个声部");
  assert.equal(afterRedo, 2, "重做应把声部加回来");

  // 9) 首页有创作室入口
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  const linkText = await page.textContent("a.composer-link").catch(() => "");
  console.log("首页入口：", linkText.trim());
  assert.ok(linkText.includes("创作室"), "识别页顶栏应能进入创作室");

  console.log("页面错误：", errors.length ? errors.slice(0, 5) : "无");
  assert.equal(errors.filter((text) => !/favicon|net::ERR/.test(text)).length, 0, "不应有 JS 报错");
  console.log("\n创作室 e2e 全部通过 ✓");
} finally {
  await browser.close();
}
