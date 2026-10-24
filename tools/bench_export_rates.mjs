// 对比不同导出采样率的渲染/编码耗时（14 个声部、每个声部一种真实音色、30 分钟）；
// 同时量「同音色 vs 14 种音色」的差别，以及重新编码的耗时。
//
// 用法：$env:XML='...extreme-80v-630m-d8.musicxml'; node tools/bench_export_rates.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/extreme-80v-630m-d8.musicxml";
const PARTS = Number(process.env.PARTS || 14);
const RATES = (process.env.RATES || "44100,32000,24000").split(",").map(Number);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 600000 });
await page.evaluate(() => window.__pujian.whenNoteRowsIdle(180000));

const result = await page.evaluate(async ({ partsWanted, rates }) => {
  const debug = window.__pujian;
  const state = debug.state;
  const names = ["piano_real", "erhu_real", "zhonghu_real", "gaohu_real", "pipa_real", "zhongruan_real",
    "daruan_real", "liuqin_real", "guzheng_real", "yangqin_real", "dizi_real", "qudi_real",
    "xiao_real", "sheng_real", "suona_real", "guanzi_real", "xun_real", "hulusi_real"];
  const partKeys = [...new Set(state.notes.map((note) => debug.voiceIdentity(note)))].slice(0, partsWanted);
  state.selectedParts = new Set(partKeys);
  for (let index = 0; index < partKeys.length; index += 1) {
    debug.setPartTimbre(partKeys[index], names[index % names.length]);
  }
  const until = performance.now() + 300000;
  while (performance.now() < until && state.sampleLoading.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const out = { partKeys: partKeys.length, notes: state.notes.length, hardware: debug.HARDWARE, rates: [] };
  out.timbrePlan = (() => {
    const plan = debug.buildPlaybackTimbrePlan();
    return { parts: plan.partTimbre.size, keep: plan.keep.size, degraded: plan.degraded.size };
  })();

  const buildPlan = () => {
    const notes = debug.getPlaybackNotes();
    const bpm = Number(document.querySelector("#tempoInput").value) || 84;
    const scoreInfo = state.scoreInfo || {};
    const tempoPlan = debug.playbackTempoSegments(scoreInfo.tempoMarks || [], {
      offset: 0, userBpm: bpm, detectedBpm: scoreInfo.tempo,
    });
    return debug.buildAudioPlan({
      notes,
      tempoSegments: [{ beat: 0, bpm: tempoPlan.startBpm }, ...tempoPlan.segments],
      startBpm: tempoPlan.startBpm, enabledParts: null,
      partTimbres: state.partTimbres, globalTimbre: state.timbre,
      partVolumes: state.partVolumes, partTranspose: new Map(), transpose: 0,
      selection: null, tailSeconds: 2.5,
    });
  };
  const plan = buildPlan();
  out.plan = { seconds: Math.round(plan.totalSeconds), notes: plan.notes.length, parts: plan.partKeys.length };
  // 按导出流程加载音源（最多 96 种，大内存模式全加载）
  const needed = new Map();
  for (const note of plan.notes) {
    if (!needed.has(note.timbre)) needed.set(note.timbre, new Set());
    if (Number.isFinite(note.midi)) needed.get(note.timbre).add(Math.round(note.midi));
  }
  const loadT0 = performance.now();
  for (const [timbre, midis] of needed) await debug.ensureSampleBank(timbre, { midis });
  out.bankLoadMs = Math.round(performance.now() - loadT0);
  out.loadedBanks = state.sampleBanks.size;

  for (const rate of rates) {
    state.lastRenderStats = null;
    const t0 = performance.now();
    let buffer = await debug.renderPlanToBuffer(plan, { rate });
    const renderMs = Math.round(performance.now() - t0);
    const stats = state.lastRenderStats || {};
    const t1 = performance.now();
    const normalized = debug.normalizeBufferInPlace(buffer, 0.89);
    const normalizeMs = Math.round(performance.now() - t1);
    const t2 = performance.now();
    const left = normalized.left;
    const right = normalized.right;
    let downloadBuffer = null;
    let encodeMs = 0;
    try {
      const blob = await debug.encodeMp3WithWorker(left, right, { sampleRate: rate });
      encodeMs = Math.round(performance.now() - t2);
      out.rates.push({
        rate,
        renderMs,
        chunks: stats.chunkCount,
        waves: stats.waves,
        buildMs: stats.buildMs,
        normalizeMs,
        encodeMs,
        bytes: blob ? blob.size : null,
        mp3Seconds: null,
        frames: buffer.length,
      });
      // 用 WebAudio decode 校验一下能解出多长
      try {
        const audioContext = new OfflineAudioContext(1, 1, 44100);
        const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
        out.rates[out.rates.length - 1].mp3Seconds = Number(decoded.duration.toFixed(1));
        out.rates[out.rates.length - 1].decodedRate = decoded.sampleRate;
      } catch (error) {
        out.rates[out.rates.length - 1].decodeError = String(error && error.message);
      }
    } catch (error) {
      out.rates.push({ rate, renderMs, error: String(error && error.message || error) });
    }
    buffer = null;
    downloadBuffer = null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return out;
}, { partsWanted: PARTS, rates: RATES });

console.log(JSON.stringify(result, null, 1));
await browser.close();
