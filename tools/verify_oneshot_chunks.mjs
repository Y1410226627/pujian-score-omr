// 验证「单次敲击长尾采样」在分块渲染下的正确性。
//
// 两种情形：钹（8.5 秒尾音，应继续分块、且尾音不丢）；大锣（27.3 秒尾音，应自动退回整块）。
// 做法：在正常计划里插几面锣/钹（位置故意放在块边界附近），整块渲染 vs 分块渲染逐样本比对。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const FIXTURE = "E:/识谱弹琴/tests/fixtures/call-of-silence-p1.musicxml";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.setInputFiles("#fileInput", {
  name: "gong.musicxml", mimeType: "application/xml",
  buffer: Buffer.from(readFileSync(FIXTURE, "utf8"), "utf8"),
});
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 180000 });
await page.waitForTimeout(600);

const result = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  // 先等主音色（默认 piano_real）采样加载完：两次渲染之间音源加载状态不同，
  // 会一次用合成音色、一次用采样音色，比对结果就没意义了。
  await debug.ensureSampleBank(state.timbre);
  {
    const started = performance.now();
    while (performance.now() - started < 60000) {
      const bank = state.sampleBanks.get(state.timbre);
      if (bank && bank.ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const tempo = debug.playbackTempoSegments(state.scoreInfo?.tempoMarks || [], {
    offset: 0, userBpm: 84, detectedBpm: state.scoreInfo?.tempo,
  });
  const basePlan = debug.buildAudioPlan({
    notes: debug.getPlaybackNotes(),
    tempoSegments: [{ beat: 0, bpm: tempo.startBpm }, ...tempo.segments],
    startBpm: tempo.startBpm,
    enabledParts: null, partTimbres: state.partTimbres, globalTimbre: state.timbre,
    partVolumes: state.partVolumes, partTranspose: new Map(), transpose: 0,
    selection: null, tailSeconds: 2.5,
  });
  const total = basePlan.totalSeconds;

  const compare = (a, b) => {
    const leftA = a.getChannelData(0), leftB = b.getChannelData(0);
    const n = Math.min(leftA.length, leftB.length);
    let maxDiff = 0, sumSq = 0, peak = 0, maxDiffAt = 0;
    const seconds = new Map();
    for (let i = 0; i < n; i += 1) {
      const diff = Math.abs(leftA[i] - leftB[i]);
      if (diff > maxDiff) { maxDiff = diff; maxDiffAt = i; }
      sumSq += diff * diff;
      const level = Math.abs(leftA[i]);
      if (level > peak) peak = level;
      if (diff > 0.005) {
        const second = Math.floor(i / (a.sampleRate || 44100));
        seconds.set(second, true);
      }
    }
    const rms = Math.sqrt(sumSq / n);
    const rate = a.sampleRate || 44100;
    return {
      rmsDb: Number((20 * Math.log10(Math.max(1e-9, rms / Math.max(1e-9, peak)))).toFixed(1)),
      maxDiff: Number(maxDiff.toExponential(2)),
      maxDiffAtSeconds: Number((maxDiffAt / rate).toFixed(2)),
      bigDiffSeconds: [...seconds.keys()].sort((left, right) => left - right).join(','),
    };
  };

  const cases = {};
  for (const [label, timbre, expected] of [["钹-bo", "bo_real", "chunked"], ["大锣-daluo", "daluo_real", "whole"]]) {
    await debug.ensureSampleBank(timbre);
    const started = performance.now();
    while (performance.now() - started < 30000) {
      const current = state.sampleBanks.get(timbre);
      if (current && current.ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const bank = state.sampleBanks.get(timbre);
    const clip = bank.layers[0].samples[0].buffer.duration;
    state.partTimbres.set("perc-" + timbre, timbre);
    const hits = [];
    for (let index = 1; index <= 4; index += 1) {
      hits.push({
        midi: 60, startSeconds: (total * index) / 5 - 1.2, durationSeconds: 0.5,
        partKey: "perc-" + timbre, timbre, volume: 1, peak: 0.16,
        human: { offset: 0, peakFactor: 1, detune: 0 },
      });
    }
    const plan = {
      notes: [...basePlan.notes, ...hits].sort((left, right) => left.startSeconds - right.startSeconds),
      totalSeconds: total,
      partKeys: [...basePlan.partKeys, "perc-" + timbre],
    };
    const savedMax = debug.EXPORT_RENDER.maxChunks;
    const render = async (maxChunks) => {
      debug.EXPORT_RENDER.maxChunks = maxChunks;
      const t0 = performance.now();
      const buffer = await debug.renderPlanToBuffer(plan, {});
      return { buffer, ms: Number((performance.now() - t0).toFixed(0)) };
    };
    // 先按上限 8 渲一次（内部 decideExportChunks 若判定 lookback 太大就会退回 1 块）
    const auto = await render(8);
    const whole = await render(1);
    debug.EXPORT_RENDER.maxChunks = savedMax;
    cases[label] = {
      clipSeconds: Number(clip.toFixed(2)),
      expected,
      autoMs: auto.ms,
      wholeMs: whole.ms,
      looksChunked: auto.ms < whole.ms * 0.7,
      fidelityVsWhole: compare(whole.buffer, auto.buffer),
    };
  }
  return { totalSeconds: Number(total.toFixed(1)), cases };
});

console.log(JSON.stringify(result, null, 1));

let failed = 0;
for (const [label, data] of Object.entries(result.cases)) {
  const chunkedOk = data.expected === "chunked" ? data.looksChunked : !data.looksChunked;
  // 分块渲染时，24 kHz 采样音源在 44.1 kHz 上下文里由浏览器实时重采样，重采样相位与
  // 「音符开始的绝对时间」有关，所以分块与整块不会逐样本相同（实测 -45 dB，听不出；
  // 块边界处相邻采样的最大跳变与整块一致 0.0145 vs 0.0145，不会产生爆音）。
  // 整块渲染（超长尾音色退回的路径）则要求几乎完全一致。
  const threshold = data.expected === "chunked" ? -30 : -60;
  const fidelityOk = data.fidelityVsWhole.rmsDb < threshold;
  const ok = chunkedOk && fidelityOk;
  if (!ok) failed += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}：期望 ${data.expected}，实际 ${data.looksChunked ? "分块" : "整块"}；` +
    `保真 ${data.fidelityVsWhole.rmsDb} dB（要求 < ${data.expected === "chunked" ? -30 : -60}）`);
}
console.log(failed ? `失败 ${failed} 项` : "长尾打击乐分块验证通过 ✓");
await browser.close();
process.exit(failed ? 1 : 0);
