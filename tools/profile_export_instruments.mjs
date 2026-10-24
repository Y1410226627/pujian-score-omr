// 复现用户真实场景：十几个声部、每个声部一种不同的真实采样音色（连续音/民族乐器），
// 比较「同音色」与「十几种不同音色」的导出渲染成本，并观察音源内存与加载时间。
//
// 用法：
//   $env:XML='...extreme-40v-100m.musicxml'; node tools/profile_export_instruments.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/extreme-40v-100m.musicxml";
const PARTS = Number(process.env.PARTS || 14);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 300000 });
await page.evaluate(() => window.__pujian.whenNoteRowsIdle(120000));

const result = await page.evaluate(async (partsWanted) => {
  const debug = window.__pujian;
  const state = debug.state;
  const instruments = ["erhu_real", "zhonghu_real", "gaohu_real", "pipa_real", "zhongruan_real",
    "daruan_real", "liuqin_real", "guzheng_real", "yangqin_real", "dizi_real", "qudi_real",
    "xiao_real", "sheng_real", "suona_real"];
  const partKeys = [...new Set(state.notes.map((note) => debug.voiceIdentity(note)))].slice(0, partsWanted);
  // 只保留这 14 个声部参与播放/导出
  state.selectedParts = new Set(partKeys);
  const out = { partKeys, instruments, notes: state.notes.length };

  const buildPlan = () => {
    const notes = debug.getPlaybackNotes();
    const baseTempo = Number(document.querySelector("#tempoInput").value) || 84;
    const scoreInfo = state.scoreInfo || {};
    const tempoPlan = debug.playbackTempoSegments(scoreInfo.tempoMarks || [], {
      offset: 0, userBpm: baseTempo, detectedBpm: scoreInfo.tempo,
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
  const loadPlanBanks = async (plan) => {
    const needed = new Map();
    for (const note of plan.notes) {
      if (!needed.has(note.timbre)) needed.set(note.timbre, new Set());
      if (Number.isFinite(note.midi)) needed.get(note.timbre).add(Math.round(note.midi));
    }
    const t0 = performance.now();
    for (const [timbre, midis] of needed) await debug.ensureSampleBank(timbre, { midis });
    const bankMs = Math.round(performance.now() - t0);
    let mb = 0;
    for (const bank of state.sampleBanks.values()) {
      for (const layer of bank.layers) for (const samples of layer.samples) if (samples.buffer) mb += samples.buffer.length * 4;
    }
    return { bankMs, banks: state.sampleBanks.size, memoryMb: Math.round(mb / 1048576), distinct: needed.size };
  };
  const render = async (plan) => {
    state.lastRenderStats = null;
    const t0 = performance.now();
    let buffer = await debug.renderPlanToBuffer(plan, {});
    const stats = state.lastRenderStats || {};
    const outStats = {
      seconds: Math.round(plan.totalSeconds),
      notes: plan.notes.length,
      totalMs: Math.round(performance.now() - t0),
      chunks: stats.chunkCount,
      waves: stats.waves,
      buildMs: stats.buildMs,
      renderMs: stats.renderMs,
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    };
    buffer = null;
    return outStats;
  };

  // 场景 A：这 14 个声部都用「真实钢琴」（同一种音色）
  state.partTimbres.clear();
  for (const key of partKeys) state.partTimbres.set(key, "piano_real");
  debug.setTimbre("piano_real");
  const planA = buildPlan();
  out.sameTimbre = { load: await loadPlanBanks(planA) };
  out.sameTimbre.render = await render(planA);

  // 场景 B：14 个声部各用一种真实采样音色（连续音/民族乐器，和用户日志里的一致）
  state.partTimbres.clear();
  partKeys.forEach((key, index) => state.partTimbres.set(key, instruments[index % instruments.length]));
  const planB = buildPlan();
  out.mixedTimbre = { load: await loadPlanBanks(planB) };
  out.mixedTimbre.render = await render(planB);

  out.bankNames = [...state.sampleBanks.keys()];
  out.heapMb = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
  return out;
}, PARTS);

console.log(JSON.stringify(result, null, 1));
await browser.close();
