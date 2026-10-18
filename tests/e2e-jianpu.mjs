// 端到端验证：《从前慢》整本简谱 —— 识别全部页 → 挑声部 → 用新音色整曲试听 → 停止。
//
// 覆盖三件事：
//   1. 整本简谱识别（前端会走批量接口）得到的小节/声部/音符数正确，控制台无报错；
//   2. 识谱自检结论显示在「音符 · 声部 · 小节」那一行（拍数对不上的小节会被点名）；
//   3. 新播放引擎（钢琴/合唱/管风琴/电子琴 + 混响）能用几百个音符真实播放，且停止后音频节点
//      全部回收（否则反复试听会越听越卡）。
//
// 用法（需要本机 Edge + playwright-core）：
//   APP_URL=http://127.0.0.1:4492/ PLAYWRIGHT_CORE=<playwright-core 目录> \
//     node tests/e2e-jianpu.mjs "D:/…/从前慢.pdf"
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_CORE || "playwright-core";
const { chromium } = require(playwrightPath);
const pdfPath = process.argv[2];
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
if (!pdfPath) {
  console.error("用法：node tests/e2e-jianpu.mjs <整本简谱 PDF 路径>");
  process.exit(2);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));

try {
  await page.goto(appUrl + (appUrl.includes("?") ? "&" : "?") + "debug=1");
  await page.setInputFiles("#fileInput", pdfPath);
  await page.waitForSelector("#jianpuAllButton:not([hidden])", { timeout: 30000 });
  const label = await page.textContent("#jianpuAllLabel");
  console.log("整本按钮：", label);

  const started = Date.now();
  await page.click("#jianpuAllButton");
  await page.waitForSelector("#recognizeProgress[hidden]", { state: "attached", timeout: 300000 });
  const recognizeSeconds = (Date.now() - started) / 1000;

  const info = await page.evaluate(() => ({
    title: document.querySelector("#scoreTitle")?.textContent,
    details: document.querySelector("#scoreDetails")?.textContent,
    warnings: document.querySelector("#scoreWarnings")?.hidden ? "" : document.querySelector("#scoreWarnings")?.textContent,
    source: document.querySelector("#recognitionSource")?.textContent,
    noteCount: document.querySelector("#noteCount")?.textContent,
    parts: [...document.querySelectorAll("#partList .part-row")].length,
    hint: document.querySelector("#scoreHint")?.textContent,
  }));
  console.log(JSON.stringify(info, null, 1));
  console.log("整本识别耗时：", recognizeSeconds.toFixed(1), "秒");

  const noteTotal = Number((info.noteCount || "0").replace(/[^\d]/g, ""));
  if (!(noteTotal > 400)) throw new Error("整本识别音符数偏少：" + info.noteCount);
  if (info.parts !== 4) throw new Error("声部数应为 4，实际 " + info.parts);
  if (!/整本简谱识别完成/.test(info.hint || "")) throw new Error("整本识别没有正常完成：" + info.hint);
  if (!/自检/.test(info.details || "")) throw new Error("识别详情里没有识谱自检结论：" + info.details);

  // 逐一看四种音色在真实长曲上的表现：每个音色播 1.2 秒，确认音频节点真的在跑。
  const timbres = [];
  for (const timbre of ["piano", "choir", "organ", "soft"]) {
    await page.selectOption("#timbreSelect", timbre);
    await page.click("#playButton");
    await page.waitForTimeout(1200);
    const during = await page.evaluate(() => ({
      playing: window.__pujian.state.isPlaying,
      sources: window.__pujian.state.sources.size,
      buses: window.__pujian.state.partBuses.size,
    }));
    await page.click("#stopButton");
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({
      playing: window.__pujian.state.isPlaying,
      sources: window.__pujian.state.sources.size,
    }));
    console.log("音色", timbre, "播放中", JSON.stringify(during), "停止后", JSON.stringify(after));
    if (!during.playing || during.sources === 0) throw new Error(timbre + " 音色没有真的发声");
    if (during.buses === 0) throw new Error(timbre + " 音色没有建声部音量总线");
    if (after.playing || after.sources !== 0) throw new Error(timbre + " 音色停止后音频节点没有回收");
    timbres.push({ timbre, sources: during.sources, buses: during.buses });
  }

  // ——— 真实音源（采样）：装了音源时，用真实钢琴把整本再播一遍 ———
  const sampleManifest = await page.evaluate(() => window.__pujian.fetchSampleManifest());
  if (!sampleManifest || !sampleManifest.banks.piano_real) {
    console.log("跳过真实钢琴播放：本机未安装 .assets/soundfonts。");
  } else {
    await page.selectOption("#timbreSelect", "piano_real");
    await page.waitForFunction(() => window.__pujian.state.sampleBanks.has("piano_real"), null, { timeout: 120000 });
    await page.click("#playButton");
    await page.waitForTimeout(1500);
    const sampled = await page.evaluate(() => ({
      timbre: window.__pujian.state.timbre,
      playing: window.__pujian.state.isPlaying,
      sources: window.__pujian.state.sources.size,
      notes: window.__pujian.state.notes.length,
      status: document.querySelector("#sampleStatus")?.textContent || "",
    }));
    await page.click("#stopButton");
    await page.waitForTimeout(300);
    console.log("真实钢琴整本播放：", JSON.stringify(sampled));
    if (!sampled.playing || sampled.sources === 0) throw new Error("真实钢琴整本播放没有发声");
    if (sampled.sources > 400) throw new Error("真实钢琴播放时音频节点过多：" + sampled.sources);
    if (!/音源/.test(sampled.status)) throw new Error("界面没有显示音源状态：" + sampled.status);
  }

  // 滚动调度护栏：整本 500+ 音符时，音频图里同时只能有"窗口内"的节点。
  // 回归背景：一次性调度会在点击播放时卡 800ms，并把上千个节点塞进音频图 → 爆音。
  await page.selectOption("#timbreSelect", "piano");
  await page.click("#playButton");
  await page.waitForTimeout(1500);
  const scheduling = await page.evaluate(() => ({
    playing: window.__pujian.state.isPlaying,
    sources: window.__pujian.state.sources.size,
    notes: window.__pujian.state.notes.length,
    timbreInputs: document.querySelectorAll(".part-timbre-select").length,
  }));
  await page.click("#stopButton");
  await page.waitForTimeout(300);
  console.log("滚动调度：", JSON.stringify(scheduling));
  if (!scheduling.playing) throw new Error("整本播放没有进入播放状态");
  if (scheduling.sources === 0) throw new Error("整本播放没有音频节点");
  if (scheduling.sources > 400) {
    throw new Error("音频图里堆了太多节点（" + scheduling.sources + " / " + scheduling.notes
      + " 个音），说明滚动调度失效了");
  }
  if (scheduling.timbreInputs < 1) throw new Error("声部面板里没有逐声部音色下拉");

  // 循环播放一次，确认重新调度不会出错（反复试听会让音频图膨胀的经典场景）。
  await page.selectOption("#timbreSelect", "piano");
  await page.check("#loopToggle");
  await page.click("#playButton");
  await page.waitForTimeout(1500);
  await page.click("#stopButton");
  await page.uncheck("#loopToggle");
  await page.waitForTimeout(300);

  if (errors.length) throw new Error("页面有 JS 报错：" + errors.slice(0, 5).join(" | "));
  console.log("\n整本简谱端到端验证通过 ✔", JSON.stringify({ recognizeSeconds: Number(recognizeSeconds.toFixed(1)), noteTotal, timbres }));
} finally {
  await browser.close();
}
