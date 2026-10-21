// 验证新增九种旋律类民族乐器采样能加载、发声且响度配平。
// 用法：先运行 `py -3 serve.py --port 4492`，再执行 `node tests/e2e-added-melody.mjs`。
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const names = [
  "zhonghu_real", "zhongruan_real", "daruan_real", "gaohu_real", "liuqin_real",
  "guanzi_real", "xun_real", "qudi_real", "yunluo_real",
];
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const loadErrors = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.text().includes("采样加载失败")) loadErrors.push(message.text());
});
page.on("pageerror", (error) => loadErrors.push(error.message));

try {
  await page.goto(appUrl + (appUrl.includes("?") ? "&" : "?") + "debug=1");
  await page.waitForFunction(() => window.__pujian?.state.sampleManifest, null, { timeout: 30000 });
  const results = await page.evaluate(async (bankNames) => {
    const debug = window.__pujian;
    const sampleRate = 44100;
    const savedAudio = debug.state.audio;
    const result = {};
    const clearGraph = () => {
      debug.state.master = null;
      debug.state.reverbBuffer = null;
      debug.state.vibrato = null;
      debug.state.noiseBuffer = null;
      debug.state.waves.clear();
      debug.state.partBuses.clear();
      debug.state.sources.clear();
      debug.state.partTimbres.clear();
    };

    for (const name of bankNames) {
      const bank = await debug.ensureSampleBank(name);
      const sample = bank.layers[0]?.samples[0];
      if (!sample) throw new Error(name + " 没有成功解码的样本");
      const context = new OfflineAudioContext(1, Math.ceil(sampleRate * 1.5), sampleRate);
      debug.state.audio = context;
      clearGraph();
      debug.state.timbre = name;
      debug.playTone(60, 0.05, 0.7, 0.16, null, "S1");
      const rendered = await context.startRendering();
      const data = rendered.getChannelData(0);
      const from = Math.floor(sampleRate * 0.1);
      const to = Math.floor(sampleRate * 0.65);
      let energy = 0;
      let peak = 0;
      for (let index = 0; index < data.length; index += 1) {
        const value = data[index];
        if (index >= from && index < to) energy += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      result[name] = {
        loaded: Boolean(bank),
        rms: Number(Math.sqrt(energy / (to - from)).toFixed(4)),
        peak: Number(peak.toFixed(3)),
        sourceRms: Number(sample.rms.toFixed(4)),
      };
    }
    debug.state.audio = savedAudio;
    clearGraph();
    debug.state.timbre = "piano_real";
    return result;
  }, names);

  console.log("新增旋律类采样响度实测：", JSON.stringify(results));
  const levels = [];
  for (const [name, data] of Object.entries(results)) {
    assert.equal(data.loaded, true, name + " 应能加载");
    assert.ok(data.rms > 0.003, name + " 应有足够响度（RMS " + data.rms + ")");
    assert.ok(data.peak < 0.95, name + " 不能削波（峰值 " + data.peak + ")");
    levels.push(data.rms);
  }
  const spread = Math.max(...levels) / Math.min(...levels);
  assert.ok(spread < 2, "新增旋律类采样响度差应低于 2 倍（实测 " + spread.toFixed(2) + ")");
  assert.deepEqual(loadErrors, [], "页面和采样加载不应报错：" + loadErrors.join(" | "));
  console.log("新增旋律类浏览器测试通过；响度最大差", spread.toFixed(2), "倍 ✔");
} finally {
  await browser.close();
}
