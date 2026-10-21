// 验证新补的能力：拍型（3/8、6/8）+ 中途变速
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
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
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
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
  await expandAdvancedPanel();

  // ---- 1) 拍型：选 3/8 ----
  await page.selectOption("#scoreTime", "3/8");
  await page.waitForTimeout(400);
  const waltzTime = await page.evaluate(() => {
    const score = window.__pujianComposer.state.score;
    return { ...score.timeSignature };
  });
  check("拍号可设为 3/8（每小节 1.5 拍）",
    waltzTime.beats === 3 && waltzTime.beatType === 8, JSON.stringify(waltzTime));

  // 加一个全音符（4 拍）应跨 3 个小节（3/8：每小节 1.5 拍）
  await page.evaluate(() => {
    const keys = [...document.querySelectorAll("#miniKeyboard .key")];
    (keys.find((k) => k.dataset.midi === "60") || keys[0])?.click();
  });
  await page.evaluate(() => {
    const chips = [...document.querySelectorAll("#valueChips .chip[data-rest='false']")];
    const whole = chips.find((chip) => chip.dataset.beats === "4") || chips[0];
    whole.click();
  });
  await page.click("#addNote");
  await page.waitForTimeout(500);
  const crossMeasures = await page.evaluate(() => {
    const state = window.__pujianComposer.state;
    const event = state.score.parts[0].staves[0].voices[0].events[0];
    return {
      beats: event.beats,
      viewMeasures: state.scoreView.parts[0].measures.length,
      beatsPerMeasure: state.scoreView.beatsPerMeasure,
    };
  });
  check("3/8 下 4 拍的音跨 3 个小节，拍位计算正确",
    crossMeasures.beatsPerMeasure === 1.5 && crossMeasures.viewMeasures === 3,
    JSON.stringify(crossMeasures));

  // ---- 2) 中途变速 ----
  await page.selectOption("#scoreTime", "4/4");
  await page.waitForTimeout(300);
  await page.fill("#tempoBeat", "5");
  await page.fill("#tempoBpm", "138");
  await page.click("#addTempoChange");
  await page.waitForTimeout(400);
  const tempoState = await page.evaluate(() => ({
    changes: window.__pujianComposer.state.score.tempoChanges,
    tempo: window.__pujianComposer.state.score.tempo,
    toast: document.querySelector("#toast")?.textContent || "",
  }));
  check("中途变速记录到 v2（第 5 小节 = 第 16 拍，♩=138）",
    tempoState.changes.length === 1 && tempoState.changes[0].beat === 16
    && tempoState.changes[0].bpm === 138,
    JSON.stringify(tempoState.changes));

  // 多处变速
  await page.fill("#tempoBeat", "9");
  await page.fill("#tempoBpm", "200");
  await page.click("#addTempoChange");
  await page.waitForTimeout(300);
  const twoChanges = await page.evaluate(() =>
    window.__pujianComposer.state.score.tempoChanges.map((item) => [item.beat, item.bpm]));
  check("支持多处变速（按拍位排序）",
    twoChanges.length === 2 && twoChanges[0][0] === 16 && twoChanges[1][0] === 32,
    JSON.stringify(twoChanges));

  // ---- 3) 变速进 MusicXML ----
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.click("#exportMusicXml");
  const download = await downloadPromise;
  const target = (process.env.TEMP || ".") + "/tempo-change.musicxml";
  const fs = await import("node:fs");
  await download.saveAs(target);
  const xml = fs.readFileSync(target, "utf8");
  const temposInXml = [...xml.matchAll(/tempo="(\d+)"/g)].map((match) => Number(match[1]));
  check("变速写进导出的 MusicXML",
    temposInXml.includes(138) && temposInXml.includes(200),
    JSON.stringify(temposInXml));

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
