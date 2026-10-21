// 验证新增民族打击乐的真实采样：低电平录音能加载、统一响度、峰值安全，
// 而且谱面短音符结束后采样仍播放到自然衰减结束。
// 用法：先运行 `py -3 serve.py --port 4492`，再执行 `node tests/e2e-percussion.mjs`。
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const names = ["pengling_real", "muyu_real", "xiaoluo_real", "daluo_real", "bo_real", "paigu_real"];
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
      const velocity = (0.16 - 0.05) / 0.25;
      const layer = bank.layers.reduce((best, item) =>
        Math.abs(item.velocity - velocity) < Math.abs(best.velocity - velocity) ? item : best,
      bank.layers[0]);
      const sample = layer.samples[0];
      if (!sample) throw new Error(name + " 没有成功解码的样本");
      const clipSeconds = sample.buffer.duration;
      const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * (clipSeconds + 0.2)), sampleRate);
      debug.state.audio = offline;
      clearGraph();
      debug.state.timbre = name;
      debug.playTone(60, 0.05, 0.08, 0.16, null, "S1");
      const rendered = await offline.startRendering();
      const data = rendered.getChannelData(0);
      const rms = (from, to) => {
        const start = Math.max(0, Math.floor(from * sampleRate));
        const end = Math.min(data.length, Math.floor(to * sampleRate));
        let energy = 0;
        for (let index = start; index < end; index += 1) energy += data[index] * data[index];
        return Math.sqrt(energy / Math.max(1, end - start));
      };
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value));
      result[name] = {
        loaded: Boolean(bank), oneShot: bank.oneShot, fixedPitch: bank.fixedPitch,
        clipSeconds: Number(clipSeconds.toFixed(2)),
        rms: Number(rms(0.06, 0.05 + clipSeconds).toFixed(4)),
        afterNoteRms: Number(rms(0.22, 0.05 + clipSeconds - 0.04).toFixed(5)),
        peak: Number(peak.toFixed(3)), sourceRms: Number(sample.rms.toFixed(5)),
      };
    }
    debug.state.audio = savedAudio;
    clearGraph();
    debug.state.timbre = "piano_real";
    return result;
  }, names);

  console.log("短音符（0.08 秒）下的打击乐采样渲染：", JSON.stringify(results));
  const levels = [];
  for (const [name, data] of Object.entries(results)) {
    assert.equal(data.loaded, true, name + " 应能加载");
    assert.equal(data.oneShot, true, name + " 应声明完整播放采样");
    assert.equal(data.fixedPitch, true, name + " 应保持录音原音高");
    assert.ok(data.rms > 0.003, name + " 应有足够响度（RMS " + data.rms + ")");
    assert.ok(data.peak < 0.95, name + " 不能削波（峰值 " + data.peak + ")");
    if (data.clipSeconds > 0.3) assert.ok(data.afterNoteRms > 0.00001,
      name + " 应在 0.08 秒音符结束后继续播放采样尾音");
    levels.push(data.rms);
  }
  const spread = Math.max(...levels) / Math.min(...levels);
  assert.ok(spread < 1.7, "新增打击乐响度差应低于 1.7 倍（实测 " + spread.toFixed(2) + ")");
  assert.deepEqual(loadErrors, [], "页面和采样加载不应报错：" + loadErrors.join(" | "));
  console.log("新增打击乐浏览器测试通过；响度最大差", spread.toFixed(2), "倍 ✔");
} finally {
  await browser.close();
}
