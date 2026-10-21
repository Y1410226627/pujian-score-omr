// 验证房子：输入 → MusicXML → 展开播放顺序
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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
  await expandAdvancedPanel();

  const present = await page.evaluate(() => ({
    endingStart: Boolean(document.querySelector("#endingStart")),
    endingEnd: Boolean(document.querySelector("#endingEnd")),
    endingNumber: Boolean(document.querySelector("#endingNumber")),
    addEnding: Boolean(document.querySelector("#addEnding")),
  }));
  check("房子输入控件在位", present.endingStart && present.endingEnd && present.endingNumber && present.addEnding,
    JSON.stringify(present));

  // 加房子：第 3 小节是第 1 遍的
  await page.fill("#endingStart", "3");
  await page.fill("#endingEnd", "3");
  await page.fill("#endingNumber", "1");
  await page.click("#addEnding");
  await page.waitForTimeout(400);

  const state1 = await page.evaluate(() => ({
    repeats: window.__pujianComposer.state.score.repeats,
    toast: document.querySelector("#toast")?.textContent || "",
  }));
  check("房子能加进数据",
    state1.repeats.some((mark) => mark.type === "ending-start" && mark.number === 1),
    JSON.stringify(state1.repeats));

  // 再加 2. 房子
  await page.fill("#endingStart", "4");
  await page.fill("#endingEnd", "4");
  await page.fill("#endingNumber", "2");
  await page.click("#addEnding");
  await page.waitForTimeout(400);
  const state2 = await page.evaluate(() => window.__pujianComposer.state.score.repeats
    .filter((mark) => String(mark.type).startsWith("ending")));
  check("可以加多个房子", state2.length === 4, JSON.stringify(state2));

  // 导出检查
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.click("#exportMusicXml");
  const download = await downloadPromise;
  const target = (process.env.TEMP || ".") + "/ending-test.musicxml";
  await download.saveAs(target);
  const xml = readFileSync(target, "utf8");
  const starts = (xml.match(/<ending number="\d" type="start"\/>/g) || []).length;
  const stops = (xml.match(/<ending number="\d" type="stop"\/>/g) || []).length;
  check("房子写进 MusicXML", starts === 2 && stops === 2, `start=${starts} stop=${stops}`);

  // 读回
  const back = await page.evaluate(async (text) => {
    const { musicXmlToV2 } = await import("./composer-v2xml.js");
    return musicXmlToV2(text).endings;
  }, xml);
  check("房子能读回来", back.length >= 2, JSON.stringify(back));

  // 展开顺序
  const order = await page.evaluate(async () => {
    const { expandPlaybackOrder, createRepeat, createEnding } = await import("./composer-repeats.js");
    const repeats = [
      createRepeat(1, "repeat-start"),
      createEnding(3, 1, "ending-start"), createEnding(3, 1, "ending-stop"),
      createEnding(4, 2, "ending-start"), createEnding(4, 2, "ending-stop"),
      createRepeat(4, "repeat-end", { times: 2 }),
    ];
    return expandPlaybackOrder(5, repeats);
  });
  check("房子的展开顺序正确（第 1 遍唱 1.、第 2 遍跳过）",
    JSON.stringify(order) === JSON.stringify([1, 2, 3, 1, 2, 4, 5]), JSON.stringify(order));

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
