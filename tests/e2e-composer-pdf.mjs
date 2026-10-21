// 端到端验证：在创作室里选一份 PDF，能不能真的识别成可编辑乐谱
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
let exitCode = 0;
const results = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  results.push(ok);
};

const PDF = process.env.PDF_PATH;
try {
  await page.goto("http://127.0.0.1:4492/composer.html?debug=1", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  check("PDF 文件存在", existsSync(PDF), PDF);
  const started = Date.now();
  await page.setInputFiles("#musicXmlInput", PDF);
  // 等识别完成：score 里出现音符（最多 40 分钟，识别慢）
  await page.waitForFunction(() => {
    const state = window.__pujianComposer && window.__pujianComposer.state;
    if (!state || !state.score) return false;
    const voices = state.score.parts.flatMap((part) => part.staves.flatMap((staff) => staff.voices));
    return voices.some((voice) => (voice.events || []).some((event) => !event.rest));
  }, null, { timeout: 2400000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  const info = await page.evaluate(() => {
    const state = window.__pujianComposer.state;
    const notes = state.score.parts.flatMap((part) => part.staves.flatMap((staff) =>
      staff.voices.flatMap((voice) => (voice.events || []).filter((event) => !event.rest))));
    return {
      notes: notes.length,
      parts: state.score.parts.length,
      staves: state.score.parts.reduce((sum, part) => sum + part.staves.length, 0),
      voices: state.score.parts.reduce((sum, part) => sum + part.staves.reduce((inner, staff) => inner + staff.voices.length, 0), 0),
      chords: notes.filter((event) => event.chordWith).length,
      measures: state.scoreView ? state.scoreView.parts[0].measures.length : 0,
      toast: document.querySelector("#toast")?.textContent || "",
      svgNotes: document.querySelectorAll("#scoreEditor svg g.vf-stavenote").length,
    };
  });
  console.log("识别结果:", JSON.stringify(info));
  check("PDF 识别出了音符", info.notes > 0, `${info.notes} 个音，耗时 ${seconds}s`);
  check("五线谱上画出来了", info.svgNotes > 0, `${info.svgNotes} 个音符元素`);
  check("有提示告诉用户导入了什么", /识别|个音/.test(info.toast), info.toast.slice(0, 60));
  check("无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

  // 截图留证
  await page.locator("#scoreEditor").scrollIntoViewIfNeeded();
  const box = await page.locator("#scoreEditor").boundingBox();
  await page.screenshot({
    path: process.env.OUT,
    clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, 880), height: Math.min(box.height, 420) },
  });
  console.log(`\n${results.filter(Boolean).length}/${results.length} 项通过，截图 ${process.env.OUT}`);
  if (results.some((item) => !item)) exitCode = 1;
} catch (error) {
  console.log("失败：", error.message.slice(0, 300));
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
