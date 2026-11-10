// 验证：谱面里的大段休止（如只有人声的 MIDI 的间奏）不应该被当成「音频短暂中断」。
// 用一份「1 小节音 + 2 小节休止 + 1 小节音」的测试谱（120 BPM，休止 4 秒），
// 播放到休止中间时检查：没有弹「掉队」提示、看门狗把这段算成 rest 而不是 starved。
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const xmlPath = join(process.env.TEMP, "rest-gap-test.musicxml");

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:4492/?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__pujian), null, { timeout: 30000 });
  await page.setInputFiles("#fileInput", xmlPath);
  await page.waitForFunction(
    () => (window.__pujian.state.notes || []).length > 0,
    null, { timeout: 30000, polling: 300 },
  );
  await page.click("#playButton");
  await page.waitForFunction(() => window.__pujian.state.isPlaying === true, null, { timeout: 30000 });
  // 第 1 小节 2 秒 + 提前量，约 2.5 秒后进入休止；在休止中间采一段时间
  await page.waitForTimeout(2600);
  const duringRest = await page.evaluate(() => {
    const state = window.__pujian.state;
    const toast = document.querySelector("#toast");
    return {
      playing: state.isPlaying,
      sources: state.sources.size,
      starved: state.playbackWatch?.starved ?? -1,
      rested: state.playbackWatch?.rested ?? -1,
      suspended: state.playbackWatch?.suspended ?? -1,
      toast: toast && toast.classList.contains("is-visible") ? toast.textContent : "",
      scoreHint: document.querySelector("#scoreHint")?.textContent || "",
    };
  });
  console.log("休止中：", JSON.stringify(duringRest));
  await page.waitForTimeout(1200);
  const later = await page.evaluate(() => {
    const state = window.__pujian.state;
    const toast = document.querySelector("#toast");
    return {
      playing: state.isPlaying,
      sources: state.sources.size,
      starved: state.playbackWatch?.starved ?? -1,
      rested: state.playbackWatch?.rested ?? -1,
      toast: toast && toast.classList.contains("is-visible") ? toast.textContent : "",
    };
  });
  console.log("1.2 秒后：", JSON.stringify(later));
  // 等到休止结束、第二个音开播（约第 6 秒），确认音频恢复且播放继续
  await page.waitForFunction(
    () => (window.__pujian.state.sources?.size || 0) > 0,
    null, { timeout: 20000, polling: 200 },
  );
  const afterRest = await page.evaluate(() => ({
    playing: window.__pujian.state.isPlaying,
    sources: window.__pujian.state.sources.size,
    starved: window.__pujian.state.playbackWatch?.starved ?? -1,
  }));
  console.log("休止结束后：", JSON.stringify(afterRest));

  if (!duringRest.playing) throw new Error("播放提前结束了");
  if (duringRest.sources !== 0) throw new Error("测试没覆盖到休止段（应无活跃音源）");
  if (duringRest.starved !== 0) throw new Error(`休止被误判成调度掉队：starved=${duringRest.starved}`);
  if (later.rested < 1) throw new Error(`休止没有被看门狗识别：rested=${later.rested}`);
  if (/中断|掉队/.test(duringRest.toast) || /中断|掉队/.test(later.toast)) {
    throw new Error(`休止期间不应提示音频中断：${duringRest.toast || later.toast}`);
  }
  if (afterRest.sources < 1) throw new Error("休止结束后没有恢复音频");
  if (afterRest.starved !== 0) throw new Error(`正常休止后 starved 不应增加：${afterRest.starved}`);
  if (errors.length) throw new Error("页面报错：" + errors.join("；"));
  console.log("✅ 长休止不会被误报成「音频短暂中断」");
} finally {
  await browser.close();
}
