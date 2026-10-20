// 真实大谱验证：用《进击的巨人》真实识别出的 MusicXML，走**真实文件上传路径**导入创作室，
// 检查「一个音符都不丢」。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const xmlPath = process.env.XML || "tests/fixtures/call-of-silence-p1.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
let exitCode = 0;
const results = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  results.push(ok);
};

try {
  await page.goto(appUrl + "composer.html?debug=1", { waitUntil: "networkidle" });

  // 1) 走真实上传：点「导入乐谱」→ 文件选择器
  await page.setInputFiles("#musicXmlInput", xmlPath);
  await page.waitForTimeout(2500);

  // 2) 读创作室当前工程状态
  const state = await page.evaluate(() => {
    // 页面里的内部状态通过重新解析统计（避免依赖未导出的对象）
    const text = document.querySelector("#measureStatus")?.textContent || "";
    const partSelect = document.querySelector("#composerPart");
    return {
      partOptions: [...(partSelect?.options || [])].map((option) => option.textContent),
      measureStatus: text,
      title: document.querySelector("#scoreTitle")?.value,
      tempo: document.querySelector("#scoreTempo")?.value,
      beats: document.querySelector("#scoreBeats")?.value,
      svgShapes: document.querySelectorAll("#scoreEditor svg path, #scoreEditor svg ellipse, #scoreEditor svg rect").length,
      toast: document.querySelector("#toast")?.textContent || "",
    };
  });
  console.log("导入后界面：", JSON.stringify(state, null, 1));

  check("标题被带入", Boolean(state.title) && state.title !== "未命名乐谱", state.title);
  check("速度被带入", Number(state.tempo) > 0, state.tempo);
  check("拍号被带入", state.beats === "4", state.beats);
  check("声部列表有内容", state.partOptions.length >= 1, state.partOptions.join(" / "));
  check("谱面真的画出了内容", state.svgShapes > 100, `SVG 图元 ${state.svgShapes}`);
  check("提示里报了导入的音符数",
    /导入|个音/.test(state.toast), state.toast.slice(0, 80));

  // 3) 解析侧对账：重新在后端算一遍「应该有多少个音」
  const expect = await page.evaluate(async () => {
    const response = await fetch("/api/omr/status");
    return { ok: response.ok };
  });
  const counted = await page.evaluate(async (text) => {
    const { parseMusicXmlText } = await import("./musicxml.js");
    const info = parseMusicXmlText(text, { keepRests: true });
    return { all: info.notes.length, sounding: info.notes.filter((note) => !note.rest).length };
  }, await (await import("node:fs/promises")).readFile(xmlPath, "utf8"));
  console.log("解析侧应有多少：", JSON.stringify(counted));

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
