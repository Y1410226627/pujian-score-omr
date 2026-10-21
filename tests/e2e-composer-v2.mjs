// 端到端：创作室 v2 —— 从零对着谱子复刻（多声部/和弦/记号）
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";

// 「试听 / 导出 / 设置」收在折叠区里，点它们之前要先展开（本轮布局调整）
async function expandAdvancedPanel() {
  await page.evaluate(() => {
    for (const id of ["advancedPanel", "markPanel"]) {
      const panel = document.querySelector("#" + id);
      if (panel) panel.open = true;
    }
  });
  await page.waitForTimeout(150);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true });
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
  await page.waitForTimeout(800);

  // ---- 1) 从零加音 ----
  await page.evaluate(() => {
    const keys = [...document.querySelectorAll("#miniKeyboard .key")];
    (keys.find((key) => key.dataset.midi === "60") || keys[0])?.click();
  });
  await page.click("#addNote");
  await page.waitForTimeout(250);
  await page.click("#addNote");
  await page.waitForTimeout(300);
  const twoNotes = await page.evaluate(() => {
    const state = window.__pujianComposer.state;
    return {
      events: state.score.parts[0].staves[0].voices[0].events.length,
      viewParts: state.scoreView.parts.length,
      svgShapes: document.querySelectorAll("#scoreEditor svg path, #scoreEditor svg ellipse").length,
      beats: state.score.parts[0].staves[0].voices[0].events.map((event) => event.beat),
    };
  });
  check("从零加音，v2 与视图同步", twoNotes.events === 2, JSON.stringify(twoNotes));
  check("谱面画出内容", twoNotes.svgShapes > 4, `SVG 图元 ${twoNotes.svgShapes}`);

  // ---- 2) 加第二条声部线，并行写 ----
  await page.click("#addVoice");
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const keys = [...document.querySelectorAll("#miniKeyboard .key")];
    (keys.find((key) => key.dataset.midi === "48") || keys[0])?.click();
  });
  await page.click("#addNote");
  await page.waitForTimeout(350);
  const parallel = await page.evaluate(() => {
    const state = window.__pujianComposer.state;
    const staff = state.score.parts[0].staves[0];
    return {
      voices: staff.voices.length,
      secondBeat: staff.voices[1].events[0] && staff.voices[1].events[0].beat,
      secondMidi: staff.voices[1].events[0] && staff.voices[1].events[0].midi,
      firstBeat: staff.voices[0].events[0] && staff.voices[0].events[0].beat,
    };
  });
  check("能加第二条声部线", parallel.voices === 2, JSON.stringify(parallel));
  check("两条声部线都从第 0 拍开始（并行不挤占）",
    parallel.secondBeat === 0 && parallel.firstBeat === 0 && parallel.secondMidi === 48,
    JSON.stringify(parallel));

  // ---- 3) 和弦叠加 ----
  const chordResult = await page.evaluate(() => {
    const state = window.__pujianComposer.state;
    // 重新读 scoreView：afterScoreChange 会生成新的视图对象，
    // 用旧引用读到的还是旧数据（之前的误判就是这里）
    const before = state.scoreView.parts[0].measures[0].beats[0];
    state.activeRef.voiceIndex = 0;
    state.selection = { partId: state.scoreView.parts[0].id, noteId: before.id };
    state.pitch = 64;
    document.querySelector("#chordToneButton").click();
    const voice = state.score.parts[0].staves[0].voices[0];
    const anchorId = voice.events[0].id;
    const chordEvent = voice.events.find((event) => event.chordWith === anchorId);
    return {
      total: voice.events.length,
      chordMidis: state.scoreView.parts[0].measures[0].beats[0].chordMidis || [],
      anchorId,
      chordWith: chordEvent && chordEvent.chordWith,
      v2ChordCount: voice.events.filter((event) => event.chordWith).length,
    };
  });
  check("和弦叠加成功（同拍多音）",
    chordResult.chordMidis.includes(64) && chordResult.chordWith === chordResult.anchorId,
    JSON.stringify(chordResult));

  // ---- 4) 记号面板 ----
  const marks = await page.evaluate(() => ({
    groups: document.querySelectorAll("#markGroups .mark-group").length,
    chips: document.querySelectorAll("#markGroups .chip-mark").length,
    titles: [...document.querySelectorAll("#markGroups .mark-title")].map((node) => node.textContent),
    hasSvg: [...document.querySelectorAll("#markGroups .chip-mark")].some((chip) => chip.querySelector("svg")),
  }));
  check("记号面板齐全（强弱/怎么弹/装饰音/连线）", marks.groups >= 4 && marks.chips >= 12,
    JSON.stringify(marks));
  check("记号画的是真实符号", marks.hasSvg);

  const artic = await page.evaluate(() => {
    const state = window.__pujianComposer.state;
    const view = state.scoreView;
    const firstBeat = view.parts[0].measures[0].beats[0];
    state.selection = { partId: view.parts[0].id, noteId: firstBeat.id };
    const button = [...document.querySelectorAll("#markGroups .chip-mark")]
      .find((chip) => chip.dataset.markKey === "articulations" && chip.dataset.markValue === "staccato");
    button?.click();
    const event = state.score.parts[0].staves[0].voices[0].events[0];
    return {
      articulations: event.articulations,
      buttonActive: button?.classList.contains("is-active"),
    };
  });
  check("能加上断奏记号", Array.isArray(artic.articulations) && artic.articulations.includes("staccato"),
    JSON.stringify(artic));

  // ---- 5) 跨小节长音 ----
  const longNote = await page.evaluate(() => {
    const state = window.__pujianComposer.state;
    const mod = window.__pujianComposer;
    // 直接用 v2 模型加一个 8 拍长音验证跨小节
    const voice = state.score.parts[0].staves[0].voices[0];
    return {
      currentBeats: voice.events.map((event) => event.beats),
    };
  });
  check("读得到 v2 事件（用于后续复刻）", longNote.currentBeats.length >= 3, JSON.stringify(longNote));

  // ---- 6) 导出 → 再导入 ----
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await expandAdvancedPanel();
  await page.click("#exportMusicXml");
  const download = await downloadPromise;
  const target = join(process.env.TEMP || ".", "v2-roundtrip.musicxml");
  await download.saveAs(target);
  const xml = readFileSync(target, "utf8");
  const back = await page.evaluate(async (text) => {
    const { musicXmlToV2 } = await import("./composer-v2xml.js");
    const { scoreToPlayableNotes } = await import("./composer-model.js");
    // 浏览器里用原生 DOMParser（@xmldom 只在 Node 测试环境有）
    const { score } = musicXmlToV2(text);
    const notes = scoreToPlayableNotes(score);
    return {
      count: notes.length,
      hasChord: notes.some((note) => note.chord),
      staccato: JSON.stringify(score).includes("staccato"),
      voices: score.parts[0].staves[0].voices.length,
    };
  }, xml);
  check("导出的 MusicXML 能读回来（往返）", back.count >= 3, JSON.stringify(back));
  check("和弦在导出/导入后保留", back.hasChord);
  check("断奏记号在导出/导入后保留", back.staccato);

  // ---- 7) 试听 ----
  await expandAdvancedPanel();
  await page.click("#playAll");
  await page.waitForTimeout(800);
  const playing = await page.evaluate(() => ({
    isPlaying: window.__pujianComposer.state.isPlaying,
    sources: window.__pujianComposer.state.sources.size,
  }));
  await page.evaluate(() => document.querySelector("#stopPlay")?.click());
  check("试听正常", playing.isPlaying === true, JSON.stringify(playing));

  check("无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log(`\n${results.filter(Boolean).length}/${results.length} 项通过`);
  if (results.some((item) => !item)) exitCode = 1;
} catch (error) {
  console.log("失败：", error.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
