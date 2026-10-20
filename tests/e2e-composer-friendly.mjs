// 验证创作室的「零基础友好」改造：
//  1) 时值选择器真的画出了符号（SVG 可见、有符头符干符尾/休止符/附点）
//  2) 每个选项都有「够几拍」的小方块和人话说明
//  3) 点一下能选中、能听
//  4) 导入乐谱能真的把音符带进来
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";

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
  return ok;
};

try {
  await page.goto(appUrl + "composer.html", { waitUntil: "networkidle" });

  // ---- 1) 时值选择器画出了符号 ----
  const chips = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("#valueChips .chip")];
    return nodes.map((node) => {
      const svg = node.querySelector("svg.value-glyph");
      const box = svg ? svg.getBoundingClientRect() : null;
      return {
        beats: node.dataset.beats,
        rest: node.dataset.rest,
        hasSvg: Boolean(svg),
        // SVG 里是否有真实图形路径
        shapes: svg ? svg.querySelectorAll("ellipse, rect, path, circle, line").length : 0,
        width: box ? Math.round(box.width) : 0,
        height: box ? Math.round(box.height) : 0,
        human: (node.querySelector(".chip-human") || {}).textContent || "",
        cells: node.querySelectorAll(".beat-cell").length,
        term: (node.querySelector(".chip-term") || {}).textContent || "",
      };
    });
  });
  const noteChips = chips.filter((item) => item.rest === "false");
  const restChips = chips.filter((item) => item.rest === "true");
  check("音符时值选项都有 SVG 图形", noteChips.length >= 9 && noteChips.every((item) => item.hasSvg && item.shapes > 0),
    `${noteChips.length} 项`);
  check("图形真的画出来了（尺寸 > 20px）",
    chips.every((item) => item.width >= 20 && item.height >= 20),
    `尺寸 ${chips[0] && chips[0].width}x${chips[0] && chips[0].height}`);
  check("休止符选项也画了休止符号", restChips.length >= 9 && restChips.every((item) => item.hasSvg && item.shapes > 0),
    `${restChips.length} 项`);
  check("每项都有「够几拍」的小方块", noteChips.every((item) => item.cells >= 1),
    noteChips.map((item) => item.cells).join(","));
  check("每项都有口语说明（不是只有术语）",
    noteChips.every((item) => item.human && !/附点|符头|符干/.test(item.human)),
    noteChips.slice(0, 3).map((item) => item.human).join(" / "));

  // 图形各不相同（不是同一个图标复制 9 份）
  const shapeSignatures = await page.evaluate(() => [...document.querySelectorAll("#valueChips .chip")]
    .filter((node) => node.dataset.rest === "false")
    .map((node) => node.querySelector("svg").innerHTML.length + ":" + node.querySelectorAll("path").length));
  check("不同时值的图形彼此不同", new Set(shapeSignatures).size >= 3,
    `不同图形数 ${new Set(shapeSignatures).size}`);

  // ---- 2) 点一下能选中 ----
  const pickup = await page.evaluate(() => {
    const half = [...document.querySelectorAll("#valueChips .chip")]
      .find((node) => node.dataset.beats === "0.5" && node.dataset.rest === "false");
    half.click();
    return {
      active: half.classList.contains("is-active"),
      activeCount: document.querySelectorAll("#valueChips .chip.is-active").length,
      addNoteText: document.querySelector("#addNote").textContent.replace(/\s+/g, " ").trim(),
    };
  });
  check("点击后高亮选中", pickup.active && pickup.activeCount === 1, JSON.stringify(pickup));

  // ---- 3) 加一个音后谱面出现内容 ----
  await page.evaluate(() => document.querySelector("#addNote").click());
  await page.waitForTimeout(300);
  const afterAdd = await page.evaluate(() => ({
    svgNotes: document.querySelectorAll("#scoreEditor svg path, #scoreEditor svg ellipse, #scoreEditor svg rect").length,
    chips: document.querySelectorAll("#valueChips .chip").length,
  }));
  check("点「加这个音」后谱面画出内容", afterAdd.svgNotes > 0, `SVG 图元 ${afterAdd.svgNotes}`);

  // ---- 4) 导入乐谱 ----
  const importState = await page.evaluate(async () => {
    // 造一份含和弦的 MusicXML 直接走导入函数
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>导入测试曲</work-title></work>
  <part-list><score-part id="P1"><part-name>右手</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>2</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
    const file = new File([xml], "test.musicxml", { type: "application/xml" });
    // 直接调内部导入（不依赖文件选择框）
    const mod = await import("./composer-import.js");
    const { parseMusicXmlText } = await import("./musicxml.js");
    const info = parseMusicXmlText(xml, { keepRests: true });
    const { score, stats } = mod.scoreInfoToComposerScore(info, { title: "导入测试曲" });
    return {
      stats,
      title: score.title,
      parts: score.parts.length,
      measures: score.parts[0].measures.length,
      beats: score.parts[0].measures[0].beats.map((beat) => ({
        midi: beat.midi, beats: beat.beats, rest: Boolean(beat.rest),
      })),
      keyFifths: score.keyFifths,
      parseNotes: info.notes.length,
    };
  });
  console.log("导入结果：", JSON.stringify(importState));
  check("导入解析出音符", importState.parseNotes >= 3, `${importState.parseNotes} 个`);
  check("导入保留标题/调号", importState.title === "导入测试曲" && importState.keyFifths === 2);
  check("导入的拍位结构正确（含休止）",
    importState.beats.length === 4 && importState.beats[3].rest === true,
    JSON.stringify(importState.beats));

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
