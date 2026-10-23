// 音符列表交互回归：时值弹出菜单 / 选区 / 删除 / 小节跳转 / 悬停高亮。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const FIXTURE = "E:/识谱弹琴/tests/fixtures/call-of-silence-p1.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.setInputFiles("#fileInput", {
  name: "ui.musicxml", mimeType: "application/xml",
  buffer: Buffer.from(readFileSync(FIXTURE, "utf8"), "utf8"),
});
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 120000 });
await page.waitForTimeout(600);

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
};

// 1) 时值菜单：打开 → 19 个选项 → 选「二分音符」
const durationResult = await (async () => {
  const rows = page.locator("#noteList .note-row");
  const button = rows.nth(4).locator(".note-duration");
  const beforeText = await button.textContent();
  await button.click();
  const menuVisible = await page.locator(".duration-menu").isVisible();
  const itemCount = await page.locator(".duration-menu .duration-menu-item").count();
  await page.locator('.duration-menu .duration-menu-item[data-duration="half"]').click();
  await page.waitForTimeout(100);
  const menuHidden = await page.locator(".duration-menu").isHidden();
  const afterText = await button.textContent();
  const note = await page.evaluate(() => {
    const debug = window.__pujian;
    const id = document.querySelectorAll("#noteList .note-row")[4].dataset.noteId;
    const found = debug.state.notes.find((item) => item.id === id);
    return { duration: found && found.duration, beats: found && found.durationBeats };
  });
  return { beforeText, menuVisible, itemCount, menuHidden, afterText, note };
})();
check("时值菜单能打开且是共享的 19+1 项", durationResult.menuVisible && durationResult.itemCount === 20, durationResult.itemCount);
check("选二分音符后模型改变", durationResult.note.duration === "half" && durationResult.note.beats === 2, durationResult.note);
check("按钮文字跟着变", durationResult.afterText === "二分音符", durationResult.afterText);
check("选完菜单收起", durationResult.menuHidden);

// 2) 点菜单外面：菜单关闭且不改时值
const outside = await (async () => {
  const button = page.locator("#noteList .note-row").nth(2).locator(".note-duration");
  await button.click();
  const visible = await page.locator(".duration-menu").isVisible();
  await page.locator("#scoreHint").click();
  await page.waitForTimeout(80);
  return { visible, hidden: await page.locator(".duration-menu").isHidden() };
})();
check("点外面关闭菜单", outside.visible && outside.hidden, outside);

// 3) 选区：点序号设起点，shift 点设终点
const selection = await (async () => {
  const indexes = page.locator("#noteList .note-row .note-index");
  await indexes.nth(0).click();
  await indexes.nth(3).click({ modifiers: ["Shift"] });
  await page.waitForTimeout(120);
  return page.evaluate(() => ({
    label: document.querySelector("#selectionLabel").textContent,
    selectedRows: document.querySelectorAll("#noteList .note-row.is-selected").length,
    notes: window.__pujian.state.notes.length,
  }));
})();
check("点序号能设选区并高亮", selection.selectedRows > 0 && /已选第/.test(selection.label), selection);

// 4) 编辑音高（委托的 change 事件）
const pitchEdit = await (async () => {
  const input = page.locator("#noteList .note-row").nth(1).locator(".note-pitch");
  await input.fill("A5");
  await input.dispatchEvent("change");
  await page.waitForTimeout(100);
  return page.evaluate(() => {
    const row = document.querySelectorAll("#noteList .note-row")[1];
    const note = window.__pujian.state.notes.find((item) => item.id === row.dataset.noteId);
    return { pitch: note && note.pitch, midi: note && note.midi };
  });
})();
check("改音高写入模型", pitchEdit.pitch === "A5" && pitchEdit.midi === 81, pitchEdit);

// 5) 删除音符
const deletion = await (async () => {
  const before = await page.evaluate(() => window.__pujian.state.notes.length);
  await page.locator("#noteList .note-row").nth(5).locator(".delete-note").click();
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => window.__pujian.state.notes.length);
  return { before, after };
})();
check("删除按钮生效", deletion.after === deletion.before - 1, deletion);

// 6) 小节跳转
const jump = await (async () => {
  await page.fill("#measureJumpInput", "3");
  await page.click("#measureJumpButton");
  await page.waitForTimeout(300);
  return page.evaluate(() => ({
    highlighted: document.querySelectorAll("#noteList .measure-group.is-highlight").length,
    scrollTop: document.querySelector("#noteList").scrollTop,
  }));
})();
check("小节跳转定位并高亮", jump.highlighted === 1, jump);

// 7) 悬停 / 聚焦不报错
await page.locator("#noteList .note-row").nth(8).hover();
await page.locator("#noteList .note-row").nth(9).locator(".note-pitch").focus();
await page.waitForTimeout(150);
check("悬停/聚焦无报错", errors.length === 0, errors.slice(0, 3));

// 8) 只看待校对（MusicXML 全部高置信度：按钮应隐藏）
const lowConfidence = await page.evaluate(() => ({
  hidden: document.querySelector("#lowConfidenceButton").hidden,
}));
check("无低置信度音符时按钮隐藏", lowConfidence.hidden, lowConfidence);

const domStats = await page.evaluate(() => ({
  rowNodes: document.querySelectorAll("#noteList .note-row *").length,
  rows: document.querySelectorAll("#noteList .note-row").length,
  menuCount: document.querySelectorAll(".duration-menu").length,
}));
console.log("DOM 统计：", JSON.stringify(domStats));
check("时值菜单全局只有一个", domStats.menuCount === 1, domStats.menuCount);

const failed = checks.filter((item) => !item.ok);
console.log(failed.length ? `\n失败 ${failed.length} 项` : "\n音符列表交互回归全部通过 ✓");
await browser.close();
process.exit(failed.length ? 1 : 0);
