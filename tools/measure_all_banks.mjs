// 批量测量全部采样音色的实际输出响度（用于统一 BANK_LEVEL）。
//
// 为什么每个音色开独立页面：
//   同一页面内连续测量会互相干扰（采样库缓存 + 主链残留），
//   实测会把「样本完全相同」的两个音色测出 2 倍以上假差异。
//
// 为什么按音域选测试音：
//   部分乐器音域窄（二胡 62-81、女声 67-84），用 C4(60) 会超出音域取到边界样本。
//
// 用法：
//   $env:PLAYWRIGHT_CORE='...'; node tools/measure_all_banks.mjs
//   $env:OUT='.cache/audio-analysis/all-banks-rms.json' node tools/measure_all_banks.mjs
//   $env:ONLY='piano_real,erhu_real' node tools/measure_all_banks.mjs   # 只测部分
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const MANIFEST = "E:/识谱弹琴/.assets/soundfonts/manifest.json";
const OUT = process.env.OUT || "";
const ONLY = (process.env.ONLY || "").split(",").map((item) => item.trim()).filter(Boolean);

// 测量参数：与 e2e-audio.mjs 一致，便于对齐阈值
const PEAK = 0.16;          // 中轻力度
const HOLD = 1.5;           // 发声时长（秒）
const WINDOW_START = 0.3;   // 测量窗口起点（跳过起音）
const WINDOW_END = 1.0;

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const banks = manifest.banks || {};
const names = ONLY.length ? ONLY : Object.keys(banks);

/** 挑一个落在该音色音域内、且靠近中音区的测试音。 */
function pickTestMidi(name) {
  const spec = banks[name];
  const layers = (spec && spec.layers) || [];
  const notes = (layers[0] && layers[0].notes) || {};
  const keys = Object.keys(notes).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!keys.length) return 60;
  const low = keys[0];
  const high = keys[keys.length - 1];
  // 优先 C4，其次取音域中点
  if (low <= 60 && 60 <= high) return 60;
  return Math.round((low + high) / 2);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = {};
const started = Date.now();

for (const [index, name] of names.entries()) {
  const midi = pickTestMidi(name);
  const page = await browser.newPage();
  let measured;
  try {
    await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    measured = await page.evaluate(async (args) => {
      const { bankName, testMidi, peak, hold, windowStart, windowEnd } = args;
      const debug = window.__pujian;
      const sampleRate = 44100;
      const bank = await debug.ensureSampleBank(bankName);
      if (!bank) return { error: "音源库没加载" };
      for (let i = 0; i < 80 && !bank.ready; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!bank.ready) return { error: "音源库未就绪" };

      const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * 2.4), sampleRate);
      debug.state.audio = offline;
      debug.state.master = null;
      debug.state.reverbBuffer = null;
      debug.state.vibrato = null;
      debug.state.noiseBuffer = null;
      debug.state.waves = new Map();
      debug.state.partBuses = new Map();
      debug.state.sources = new Set();
      // 关键：缓存 key 含 state.timbre，只设 partTimbres 会命中旧缓存
      // （实测：不设 state.timbre 时所有音色测出同一响度）。
      debug.state.partTimbres = new Map();
      debug.state.timbre = bankName;
      debug.playTone(testMidi, 0.05, hold, peak, null, "");
      const rendered = await offline.startRendering();
      const data = rendered.getChannelData(0);

      // 自适应测量窗口：
      // 短促打击乐（木鱼 0.4-0.76 秒）如果用固定的 0.3-1.0 秒窗口，
      // 后半段早就衰减完了，RMS 会被严重低估（实测木鱼差 15 倍）。
      // 所以先找「最后一个超过阈值的采样点」，把窗口截到那里。
      const searchEnd = Math.min(data.length, Math.floor(sampleRate * 2.2));
      let lastAudible = searchEnd;
      const threshold = 0.0005;
      for (let i = searchEnd - 1; i >= 0; i -= 1) {
        if (Math.abs(data[i]) > threshold) { lastAudible = i + 1; break; }
      }
      const audibleSeconds = lastAudible / sampleRate;
      // 窗口：跳过起音（0.05 秒），到声音结束（最多 2.0 秒）
      const from = Math.floor(sampleRate * Math.min(0.1, audibleSeconds * 0.15));
      const to = Math.max(from + Math.floor(sampleRate * 0.05), Math.min(lastAudible, Math.floor(sampleRate * 2.0)));
      let sum = 0;
      let peakValue = 0;
      for (let i = from; i < to && i < data.length; i += 1) {
        const value = data[i];
        sum += value * value;
        const absolute = Math.abs(value);
        if (absolute > peakValue) peakValue = absolute;
      }
      const rms = Math.sqrt(sum / Math.max(1, to - from));
      return {
        rms: Number(rms.toFixed(6)),
        peak: Number(peakValue.toFixed(4)),
        audibleSeconds: Number(audibleSeconds.toFixed(2)),
        windowSeconds: Number(((to - from) / sampleRate).toFixed(2)),
        observedRms: bank.observedRms,
        oneShot: Boolean(bank.oneShot),
        continuous: Boolean(bank.continuous),
        layers: bank.layers.length,
      };
    }, { bankName: name, testMidi: midi, peak: PEAK, hold: HOLD, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  } catch (error) {
    measured = { error: String((error && error.message) || error).slice(0, 100) };
  } finally {
    await page.close();
  }
  results[name] = { midi, ...measured };
  const value = measured.error
    ? `失败 — ${measured.error}`
    : `RMS ${measured.rms}  峰值 ${measured.peak}`;
  console.log(`[${index + 1}/${names.length}] ${name} (MIDI ${midi}): ${value}`);
}

await browser.close();

const seconds = ((Date.now() - started) / 1000).toFixed(0);
const valid = Object.entries(results).filter(([, item]) => item.rms > 0);
console.log(`\n测量完成：${valid.length} / ${names.length} 个有效，用时 ${seconds} 秒`);
if (valid.length) {
  const values = valid.map(([, item]) => item.rms);
  const spread = Math.max(...values) / Math.min(...values);
  console.log(`当前响度差：${spread.toFixed(2)} 倍`);
  const failed = Object.entries(results).filter(([, item]) => item.error);
  if (failed.length) {
    console.log("失败清单：");
    for (const [name, item] of failed) console.log(`  ${name}: ${item.error}`);
  }
}
if (OUT) {
  writeFileSync(OUT, JSON.stringify(results, null, 1), "utf8");
  console.log("已写出", OUT);
}
