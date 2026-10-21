// 在浏览器里实测各采样音色的实际输出响度，用于校准 app.js 的 BANK_LEVEL。
//
// 为什么必须走浏览器：BANK_LEVEL 作用在 WebAudio 图上（含主链压缩、声部总线、
// 采样播放速率），Node 里算的样本 RMS 不等于用户听到的响度。
// 交接文档也要求「以浏览器实际输出为准」。
//
// 为什么每个音色开一个独立页面：实测发现同一页面内连续测量会互相干扰
// （采样库缓存 + 主链残留），同一组样本的两个音色会测出 2 倍以上的假差异。
//
// 用法：
//   $env:PLAYWRIGHT_CORE='...'; node tools/measure_browser_levels.mjs
//   $env:BANKS='piano_real,nylon_guitar_real' node tools/measure_browser_levels.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const DEFAULT_BANKS = "piano_real,nylon_guitar_real,steel_guitar_real,zhongruan_real,liuqin_real";
const NAMES = (process.env.BANKS || DEFAULT_BANKS).split(",").map((item) => item.trim()).filter(Boolean);
const OUT = process.env.OUT || "";

const browser = await chromium.launch({ channel: "msedge", headless: true });

/** 在一个全新页面里测一个音色。 */
async function measureOne(name) {
  const page = await browser.newPage();
  try {
    await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    return await page.evaluate(async (bankName) => {
      const debug = window.__pujian;
      const sampleRate = 44100;
      const bank = await debug.ensureSampleBank(bankName);
      if (!bank) return { error: "音源库没加载" };
      // 给足时间让采样真正解码完成
      for (let i = 0; i < 60 && !bank.ready; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * 2.4), sampleRate);
      debug.state.audio = offline;
      debug.state.master = null;
      debug.state.reverbBuffer = null;
      debug.state.vibrato = null;
      debug.state.noiseBuffer = null;
      debug.state.waves = new Map();
      debug.state.partBuses = new Map();
      debug.state.sources = new Set();
      debug.state.partTimbres = new Map([["__measure__", bankName]]);
      try {
        debug.playTone(60, 0, 1.6, 0.9, null, "__measure__");
        const buffer = await offline.startRendering();
        const data = buffer.getChannelData(0);
        const from = Math.floor(sampleRate * 0.1);
        const to = Math.floor(sampleRate * 1.2);
        let sum = 0;
        let peak = 0;
        let count = 0;
        for (let i = from; i < to && i < data.length; i += 1) {
          const value = data[i];
          sum += value * value;
          const absolute = Math.abs(value);
          if (absolute > peak) peak = absolute;
          count += 1;
        }
        return {
          rms: Number(Math.sqrt(sum / Math.max(1, count)).toFixed(5)),
          peak: Number(peak.toFixed(4)),
          observedRms: bank.observedRms,
          oneShot: Boolean(bank.oneShot),
        };
      } catch (error) {
        return { error: String((error && error.message) || error).slice(0, 120) };
      }
    }, name);
  } finally {
    await page.close();
  }
}

const measured = {};
for (const name of NAMES) {
  measured[name] = await measureOne(name);
  const value = measured[name];
  console.log(value.error
    ? `  ${name}: 失败 — ${value.error}`
    : `  ${name}: RMS ${value.rms}  峰值 ${value.peak}`);
}

const valid = Object.entries(measured).filter(([, value]) => value.rms > 0);
if (valid.length > 1) {
  const rmsValues = valid.map(([, value]) => value.rms);
  const spread = Math.max(...rmsValues) / Math.min(...rmsValues);
  console.log(`\n响度差：${spread.toFixed(2)} 倍（测试要求 < 1.7）`);
  if (spread >= 1.7) {
    const target = rmsValues.reduce((sum, value) => sum + value, 0) / rmsValues.length;
    console.log(`建议：目标 RMS ${target.toFixed(4)}，各音色系数再乘：`);
    for (const [name, value] of valid) {
      console.log(`  ${name}: × ${(target / value.rms).toFixed(3)}`);
    }
  } else {
    console.log("已达标。");
  }
}
if (OUT) {
  writeFileSync(OUT, JSON.stringify(measured, null, 1), "utf8");
  console.log("\n已写出", OUT);
}
await browser.close();
