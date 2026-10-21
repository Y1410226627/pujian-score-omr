// 按 e2e-audio.mjs 的实际测量条件复现，用于精确校准
// 条件：同一页面内顺序测量、peak=0.16（轻力度）、窗口 0.3–1.0 秒
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const NAMES = (process.env.BANKS || "piano_real,nylon_guitar_real,steel_guitar_real,zhongruan_real,liuqin_real").split(",");

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const values = await page.evaluate(async (names) => {
  const debug = window.__pujian;
  const sampleRate = 44100;
  const values = {};
  for (const name of names) {
    const bank = await debug.ensureSampleBank(name);
    for (let i = 0; i < 80 && bank && !bank.ready; i += 1) await new Promise((r) => setTimeout(r, 100));
    const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * 2.4), sampleRate);
    debug.state.audio = offline;
    debug.state.master = null;
    debug.state.reverbBuffer = null;
    debug.state.vibrato = null;
    debug.state.noiseBuffer = null;
    debug.state.waves.clear();
    debug.state.partBuses.clear();
    debug.state.sources.clear();
    debug.state.partTimbres.clear();
    debug.state.timbre = name;
    debug.playTone(60, 0.05, 1.5, 0.16, null, "S1");
    const rendered = await offline.startRendering();
    const data = rendered.getChannelData(0);
    let sum = 0;
    let peak = 0;
    const start = Math.floor(sampleRate * 0.3);
    const end = Math.floor(sampleRate * 1.0);
    for (let index = start; index < end; index += 1) {
      sum += data[index] * data[index];
      peak = Math.max(peak, Math.abs(data[index]));
    }
    values[name] = { rms: Number(Math.sqrt(sum / Math.max(1, end - start)).toFixed(5)), peak: Number(peak.toFixed(4)) };
  }
  return values;
}, NAMES);

console.log("按 e2e 条件实测：");
for (const [name, value] of Object.entries(values)) {
  console.log(`  ${name}: RMS ${value.rms}  峰值 ${value.peak}`);
}
const rmsList = Object.values(values).map((item) => item.rms);
const spread = Math.max(...rmsList) / Math.min(...rmsList);
console.log(`\n响度差：${spread.toFixed(2)} 倍`);
if (spread >= 1.7) {
  const target = rmsList.reduce((a, b) => a + b, 0) / rmsList.length;
  console.log(`目标 RMS ${target.toFixed(5)}，系数调整：`);
  for (const [name, value] of Object.entries(values)) {
    console.log(`  ${name}: × ${(target / value.rms).toFixed(3)}`);
  }
}
await browser.close();
