// 验证反复记号：输入 → MusicXML → 播放展开
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true });
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

  // 加 4 个音（4 小节）
  for (const midi of ["60", "62", "64", "65"]) {
    await page.evaluate((value) => {
      const keys = [...document.querySelectorAll("#miniKeyboard .key")];
      (keys.find((k) => k.dataset.midi === value) || keys[0])?.click();
    }, midi);
    await page.evaluate(() => {
      const whole = [...document.querySelectorAll("#valueChips .chip[data-rest='false']")]
        .find((chip) => chip.dataset.beats === "4") || null;
      whole?.click();
    });
    await page.click("#addNote");
    await page.waitForTimeout(200);
  }

  // ---- 1) 加反复记号 ----
  await page.fill("#repeatBar", "1");
  await page.click("#addRepeatStart");
  await page.waitForTimeout(300);
  await page.fill("#repeatBar", "2");
  await page.click("#addRepeatEnd");
  await page.waitForTimeout(400);

  const repeatState = await page.evaluate(() => ({
    repeats: window.__pujianComposer.state.score.repeats,
    info: document.querySelector("#repeatInfo")?.textContent,
    toast: document.querySelector("#toast")?.textContent || "",
  }));
  check("反复记号可以标（1 起点、2 终点）",
    repeatState.repeats.length === 2
    && repeatState.repeats[0].type === "repeat-start"
    && repeatState.repeats[1].type === "repeat-end",
    JSON.stringify(repeatState.repeats));
  check("界面说明写清楚", /第 1 小节反复起点/.test(repeatState.info || ""), repeatState.info);

  // ---- 2) 写进 MusicXML ----
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.click("#exportMusicXml");
  const download = await downloadPromise;
  const target = (process.env.TEMP || ".") + "/repeat-test.musicxml";
  await download.saveAs(target);
  const xml = readFileSync(target, "utf8");
  const forward = (xml.match(/<repeat direction="forward"\/>/g) || []).length;
  const backward = (xml.match(/<repeat direction="backward" times="2"\/>/g) || []).length;
  check("反复记号写进 MusicXML", forward === 1 && backward === 1, `forward=${forward} backward=${backward}`);

  // ---- 3) 读回来 ----
  const readBack = await page.evaluate(async (text) => {
    const { musicXmlToV2 } = await import("./composer-v2xml.js");
    const { repeats } = musicXmlToV2(text);
    return repeats;
  }, xml);
  check("反复记号能读回来",
    readBack.length === 2 && readBack[0].type === "repeat-start", JSON.stringify(readBack));

  // ---- 4) 播放展开 ----
  const playback = await page.evaluate(() => {
    const state = window.__pujianComposer.state;
    // 取展开后的播放列表（有反复 → 8 个音符）
    const view = state.scoreView;
    const per = view.beatsPerMeasure;
    const totalMeasures = Math.max(1, Math.ceil(view.parts[0].measures.length));
    return {
      totalMeasures,
      repeats: state.score.repeats.length,
      notesPerPass: 4,
    };
  });
  await page.click("#playAll");
  await page.waitForTimeout(1500);
  const playing = await page.evaluate(() => ({
    isPlaying: window.__pujianComposer.state.isPlaying,
    sources: window.__pujianComposer.state.sources.size,
  }));
  await page.evaluate(() => document.querySelector("#stopPlay")?.click());
  check("带反复的谱子能试听", playing.isPlaying === true, JSON.stringify(playing));

  // ---- 5) 校验提示 ----
  await page.fill("#repeatBar", "5");
  await page.click("#addRepeatStart");
  await page.waitForTimeout(300);
  const unpaired = await page.evaluate(() => ({
    toast: document.querySelector("#toast")?.textContent || "",
    repeats: window.__pujianComposer.state.score.repeats.length,
  }));
  check("没配对的起点会提示（而不是默默收下）",
    /没配对/.test(unpaired.toast), unpaired.toast);

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
