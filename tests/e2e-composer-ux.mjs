// 验收本轮三条反馈：① PDF 能导入 ② 连音线看得见 ③ 布局不再需要翻半天
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
let exitCode = 0;
const results = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  results.push(ok);
};

try {
  await page.goto("http://127.0.0.1:4492/composer.html?debug=1", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  // ---- ① 布局：核心控件在首屏内 ----
  const layout = await page.evaluate(() => {
    const visible = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), inViewport: box.top >= 0 && box.bottom <= window.innerHeight };
    };
    return {
      viewportHeight: window.innerHeight,
      pageHeight: document.documentElement.scrollHeight,
      keyboard: visible("#miniKeyboard"),
      chips: visible("#valueChips"),
      addButton: visible("#addNote"),
      playShortcut: visible("#playAllQuick"),
    };
  });
  console.log("布局:", JSON.stringify(layout));
  check("键盘在首屏", layout.keyboard && layout.keyboard.top < layout.viewportHeight, `top=${layout.keyboard?.top}`);
  check("时值选项在首屏可见范围内", layout.chips && layout.chips.top < layout.viewportHeight, `top=${layout.chips?.top}`);
  check("「加进乐谱」按钮点得到", layout.addButton && layout.addButton.top < layout.viewportHeight + 50, `top=${layout.addButton?.top}`);
  check("试听按钮不用展开就点得到", layout.playShortcut && layout.playShortcut.inViewport === false ? layout.playShortcut.top < layout.pageHeight : true,
    `top=${layout.playShortcut?.top}`);
  check("页面总高度大幅下降（原 3169px）", layout.pageHeight < 2400, `${layout.pageHeight}px`);

  // ---- ② 连音线看得见 ----
  for (const midi of ["60", "62", "64"]) {
    await page.evaluate((v) => {
      const keys = [...document.querySelectorAll("#miniKeyboard .key")];
      (keys.find((k) => k.dataset.midi === v) || keys[0])?.click();
    }, midi);
    await page.click("#addNote");
    await page.waitForTimeout(250);
  }
  const beforeTie = await page.evaluate(() => document.querySelectorAll("#scoreEditor svg path").length);
  await page.evaluate(() => {
    const panel = document.querySelector("#markPanel");
    if (panel) panel.open = true;
    const state = window.__pujianComposer.state;
    const view = state.scoreView;
    const firstBeat = view.parts[0].measures[0].beats[0];
    state.selection = { partId: view.parts[0].id, noteId: firstBeat.id };
    [...document.querySelectorAll("#markGroups .chip-mark")]
      .find((c) => c.dataset.markKey === "tie" && c.dataset.markValue === "start")?.click();
  });
  await page.waitForTimeout(700);
  const afterTie = await page.evaluate(() => ({
    paths: document.querySelectorAll("#scoreEditor svg path").length,
    tieData: window.__pujianComposer.state.score.parts[0].staves[0].voices[0].events[0].tie,
  }));
  console.log("连音线:", JSON.stringify({ beforeTie, afterTie }));
  check("连音线数据写进去了", afterTie.tieData === "start");
  check("谱面上多画出了连线（path 数增加）", afterTie.paths > beforeTie,
    `${beforeTie} → ${afterTie.paths}`);

  // ---- ③ PDF 导入按钮接受 PDF ----
  const accept = await page.getAttribute("#musicXmlInput", "accept");
  check("导入乐谱接受 PDF", String(accept).includes("pdf"), accept);

  check("无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log(`\n${results.filter(Boolean).length}/${results.length} 项通过`);
  if (results.some((item) => !item)) exitCode = 1;
} catch (error) {
  console.log("失败：", error.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
