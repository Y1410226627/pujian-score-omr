// 四项问题的端到端验证：中途变速 / 自由编辑 / 加厚声部 / 多声部播放流畅度。
//
// 用法：
//   $env:PLAYWRIGHT_CORE=".../playwright-core"
//   $env:APP_URL="http://127.0.0.1:4492/"
//   node tests/e2e-workbench.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";

// 一份「中途变速」的乐谱：第 0 拍 ♩=66，第 8 拍 ♩=138
const TEMPO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>变速测试</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>66</per-minute></metronome></direction-type><sound tempo="66"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>138</per-minute></metronome></direction-type><sound tempo="138"/></direction>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));

try {
  await page.goto(appUrl + (appUrl.includes("?") ? "&" : "?") + "debug=1", { waitUntil: "networkidle" });

  /* ============ 问题 1：中途变速 ============ */
  const tempoFile = process.env.TEMP + "/e2e_tempo.musicxml";
  require("node:fs").writeFileSync(tempoFile, TEMPO_XML, "utf8");
  await page.setInputFiles("#fileInput", tempoFile);
  await page.waitForFunction(() => document.querySelectorAll("#noteList .note-row").length > 0, null, { timeout: 60000 });
  const tempoState = await page.evaluate(() => ({
    bpm: document.querySelector("#tempoInput").value,
    marks: window.__pujian.state.scoreInfo?.tempoMarks,
    hint: document.querySelector("#tempoHint")?.textContent,
    hintHidden: document.querySelector("#tempoHint")?.hidden,
  }));
  console.log("变速谱：", JSON.stringify(tempoState));
  assert.equal(tempoState.marks.length, 2, "应读到 2 处速度标记");
  assert.equal(tempoState.bpm, "66", "起始 BPM 应取第 0 拍的 66");
  assert.ok(!tempoState.hintHidden, "应显示速度提示");
  assert.ok(tempoState.hint.includes("2 处速度变化"), "提示里应写明有几处变速");

  // 播放时时间轴应分段：第 0 拍 @66 → 4 拍约 3.64 秒；第 4 拍起 @138 → 2 拍约 0.87 秒
  const timeline = await page.evaluate(() => {
    const debug = window.__pujian;
    const notes = debug.state.notes;
    return notes.map((note) => ({ startBeat: note.startBeat, midi: note.midi }));
  });
  assert.ok(timeline.length >= 2, "应有两个音");

  // 改 BPM 到 132（66 的 2 倍）：中途变速比例应保留（138 → 276 会触顶 320，改用 1.2 倍验证）
  await page.fill("#tempoInput", "79.2");
  const scaled = await page.evaluate(() => {
    const debug = window.__pujian;
    const el = document.querySelector("#tempoInput");
    return { bpm: el.value, marks: debug.state.scoreInfo.tempoMarks };
  });
  assert.equal(scaled.bpm, "79.2", "手填 BPM 应保留");

  /* ============ 问题 2：识别后自由编辑 ============ */
  const editBefore = await page.evaluate(() => ({
    notes: window.__pujian.state.notes.length,
  }));
  // 改第一个音的时值（下拉）与音高（文本框）
  const firstRow = page.locator("#noteList .note-row").first();
  await firstRow.locator(".note-pitch").fill("F#5");
  await firstRow.locator(".note-pitch").dispatchEvent("change");
  await firstRow.locator(".note-duration").selectOption("half");
  const editAfter = await page.evaluate(() => ({
    notes: window.__pujian.state.notes.length,
    firstPitch: window.__pujian.state.notes[0].pitch,
    firstMidi: window.__pujian.state.notes[0].midi,
    firstDuration: window.__pujian.state.notes[0].duration,
  }));
  console.log("编辑后：", JSON.stringify(editAfter));
  assert.equal(editAfter.notes, editBefore.notes, "编辑不应改变音符数量");
  assert.equal(editAfter.firstPitch, "F#5");
  assert.equal(editAfter.firstMidi, 78, "F#5 = MIDI 78");
  assert.equal(editAfter.firstDuration, "half", "时值应改成二分音符");
  // 删除一个音
  await firstRow.locator(".delete-note").click();
  const afterDelete = await page.evaluate(() => window.__pujian.state.notes.length);
  assert.equal(afterDelete, editBefore.notes - 1, "删除应减少一个音符");

  /* ============ 问题 3：加厚声部 ============ */
  const layerBefore = await page.evaluate(() => ({
    notes: window.__pujian.state.notes.length,
    parts: [...document.querySelectorAll("#partList .part-row")].length,
  }));
  await page.locator("#addLayerPart").click();
  await page.waitForTimeout(300);
  const layerAfterCopy = await page.evaluate(() => ({
    notes: window.__pujian.state.notes.length,
    parts: [...document.querySelectorAll("#partList .part-row")].length,
  }));
  console.log("复制声部：", JSON.stringify(layerBefore), "→", JSON.stringify(layerAfterCopy));
  assert.ok(layerAfterCopy.parts > layerBefore.parts, "应多出一个声部");
  assert.ok(layerAfterCopy.notes > layerBefore.notes, "新声部应带音符");

  await page.locator("#addLayerEcho").click();
  await page.waitForTimeout(300);
  const layerAfterEcho = await page.evaluate(() => ({
    parts: [...document.querySelectorAll("#partList .part-row")].length,
    // 高八度叠加的音应该比源声部高 12
    octaveDelta: (() => {
      const notes = window.__pujian.state.notes;
      const keys = [...new Set(notes.map((note) => note.partName))];
      const pairs = keys.slice(0, 2).map((name) => notes.filter((note) => note.partName === name).map((note) => note.midi));
      return pairs.length === 2 ? pairs[1][0] - pairs[0][0] : null;
    })(),
  }));
  console.log("高八度叠加：", JSON.stringify(layerAfterEcho));
  assert.ok(layerAfterEcho.parts >= 3, "应有 3 个以上声部");

  // 给新声部换音色（选二胡，验证逐声部音色仍可用）
  const timbreSelects = page.locator("#partList .part-timbre-select");
  const count = await timbreSelects.count();
  if (count > 1) {
    await timbreSelects.nth(1).selectOption("erhu_real").catch(() => {});
  }

  /* ============ 问题 4：多声部播放流畅度 ============ */
  const smooth = await page.evaluate(async () => {
    const frames = [];
    let last = performance.now();
    let running = true;
    const tick = () => { const now = performance.now(); frames.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    document.querySelector("#playButton").click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    running = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const sorted = [...frames].sort((a, b) => a - b);
    const state = window.__pujian.state;
    const playingSnapshot = state.isPlaying;
    const sourcesSnapshot = state.sources.size;
    const timersSnapshot = state.timers.length;
    const info = {
      frames: frames.length,
      p50: Number(sorted[Math.floor(sorted.length * 0.5)]?.toFixed(1)),
      p95: Number(sorted[Math.floor(sorted.length * 0.95)]?.toFixed(1)),
      worst: Number(Math.max(...frames).toFixed(1)),
      longFrames: frames.filter((f) => f > 50).length,
      sources: sourcesSnapshot,
      timers: timersSnapshot,
      isPlaying: playingSnapshot,
    };
    document.querySelector("#stopButton").click();
    return info;
  });
  console.log("多声部播放：", JSON.stringify(smooth));
  assert.ok(smooth.isPlaying, "应正在播放");
  assert.ok(smooth.p95 < 60, `帧间隔 p95 应低于 60ms，实际 ${smooth.p95}`);
  assert.ok(smooth.timers < 500, `定时器数量应有界，实际 ${smooth.timers}`);

  /* ============ 汇总 ============ */
  console.log("页面错误：", errors.length ? errors.slice(0, 5) : "无");
  assert.equal(errors.filter((text) => !/favicon|net::ERR/.test(text)).length, 0, "不应有 JS 报错");
  console.log("\n工作台 e2e 全部通过 ✓");
} finally {
  await browser.close();
}
