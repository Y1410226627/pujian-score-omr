// 端到端验证「播放音色引擎」：真的在浏览器里合成声音，再用频谱检查它到底像不像钢琴/人声。
//
// 为什么需要这个脚本：timbre.test.mjs 只能验证参数表（泛音要递减、共振峰要 F1<F2<F3 之类），
// 但「按这些参数发出来的声音对不对」必须让浏览器真的跑一遍 Web Audio 才能确认。这里用
// OfflineAudioContext 离线渲染成 PCM，然后自己做频谱分析（Goertzel）：
//   - 钢琴：泛音能量应逐次递减，起音比余音响（两段衰减生效）；
//   - 管风琴：第 2、3 泛音（八度/十二度音栓）必须明显存在；
//   - 合唱：元音共振峰位置的频率能量要高于旁边的「谷」，证明共振峰滤波真的在塑形；
//   - 电子琴：三角波只有奇次泛音，第 2 泛音应当几乎没有；
//   - 所有音色：松键后还有混响余音（tail RMS > 0）。
// 最后再走一遍真实播放流程（点▶试听 → 停止），确认没有 JS 报错、音频节点能正常回收。
//
// 用法（需要本机有 Edge、有 playwright-core）：
//   node tests/e2e-audio.mjs
//   APP_URL=http://127.0.0.1:4492/ PLAYWRIGHT_CORE=<playwright-core 目录> node tests/e2e-audio.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { vowelForPart, VOWELS, REVERB } from "../timbre.js";

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_CORE || "playwright-core";
const { chromium } = require(playwrightPath);
const here = dirname(fileURLToPath(import.meta.url));
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const samplePath = join(here, "fixtures", "timbre_sample.musicxml");

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));

const results = {};
try {
  await page.goto(appUrl + (appUrl.includes("?") ? "&" : "?") + "debug=1");
  await page.setInputFiles("#fileInput", samplePath);
  await page.waitForFunction(() => document.querySelectorAll("#noteList .note-row").length > 0, null, { timeout: 30000 });
  const loaded = await page.evaluate(() => ({
    notes: window.__pujian.state.notes.length,
    parts: [...document.querySelectorAll("#partList .part-row")].length,
    timbre: window.__pujian.state.timbre,
  }));
  console.log("载入样例：", JSON.stringify(loaded));
  assert.ok(loaded.notes >= 8, "样例乐谱应解析出至少 8 个音符");
  assert.ok(loaded.parts >= 2, "样例乐谱应有 2 个声部");

  // ——— 离线渲染四种音色，各弹一个 C4 长音 ———
  for (const timbre of ["piano", "choir", "organ", "soft"]) {
    results[timbre] = await page.evaluate(async (name) => {
      const debug = window.__pujian;
      const sampleRate = 44100;
      const context = new OfflineAudioContext(1, Math.floor(sampleRate * 2.2), sampleRate);
      // 换上下文必须把缓存的节点/波表清掉，否则会把上一个上下文的节点接进新图里。
      debug.state.audio = context;
      debug.state.master = null;
      debug.state.reverbBuffer = null;
      debug.state.vibrato = null;
      debug.state.noiseBuffer = null;
      debug.state.waves.clear();
      debug.state.partBuses.clear();
      debug.state.sources.clear();
      debug.state.timbre = name;
      debug.playTone(60, 0.05, 1.0, 0.16, null, "S1");
      const buffer = await context.startRendering();
      const samples = buffer.getChannelData(0);

      const windowRms = (from, to) => {
        const start = Math.max(0, Math.floor(from * sampleRate));
        const end = Math.min(samples.length, Math.floor(to * sampleRate));
        let sum = 0;
        for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
        return end > start ? Math.sqrt(sum / (end - start)) : 0;
      };
      // Goertzel：只算某一个频率上的能量，比做整段 FFT 省事。
      const energyAt = (frequency, from = 0.1, to = 1.0) => {
        const start = Math.max(0, Math.floor(from * sampleRate));
        const end = Math.min(samples.length, Math.floor(to * sampleRate));
        const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
        let previous = 0;
        let beforePrevious = 0;
        for (let index = start; index < end; index += 1) {
          const current = samples[index] + coefficient * previous - beforePrevious;
          beforePrevious = previous;
          previous = current;
        }
        const power = Math.max(0, previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious);
        return Math.sqrt(power) / Math.max(1, end - start);
      };
      // 单频点 Goertzel 对音高偏差极度敏感（人性化会让音高抖 ±4.5 音分，
      // 到第 6 泛音就是 ±4 Hz，单频点会把能量全部漏掉），所以每个泛音都在
      // ±3% 的窄带里扫一遍取峰值，相当于"允许跑调的频谱分析"。
      const peakEnergyAround = (frequency) => {
        let best = 0;
        for (let ratio = 0.97; ratio <= 1.03; ratio += 0.002) {
          best = Math.max(best, energyAt(frequency * ratio));
        }
        return best;
      };
      const fundamental = 261.6256;
      const harmonics = [];
      for (let n = 1; n <= 10; n += 1) harmonics.push(peakEnergyAround(fundamental * n));
      // 200–3600 Hz 扫一遍，找频谱最高点（人声的共振峰会在这里显出来）。
      let peakFrequency = 0;
      let peakEnergy = 0;
      for (let hz = 200; hz <= 3600; hz += 20) {
        const energy = energyAt(hz);
        if (energy > peakEnergy) { peakEnergy = energy; peakFrequency = hz; }
      }
      const rms = {
        // 起音窗从 0.05 s（第一个音的起点）到 0.18 s：钢琴 6 ms 就冲到峰值，
        // 人声要 70 ms 才渐强到峰值，所以窗口要盖住两种乐器的起音过程。
        attack: windowRms(0.05, 0.18),
        body: windowRms(0.4, 0.9),
        tail: windowRms(1.55, 2.1),   // 音符已停（最长 1.21 秒），这里只剩混响余音
      };
      let peakSample = 0;
      for (let index = 0; index < samples.length; index += 1) peakSample = Math.max(peakSample, Math.abs(samples[index]));
      return { harmonics, peakFrequency, peakEnergy, rms, peakSample };
    }, timbre);
    console.log("离线渲染", timbre, "→ 峰值", results[timbre].peakSample.toFixed(3),
      "| RMS 起音/保持/余音", [results[timbre].rms.attack, results[timbre].rms.body, results[timbre].rms.tail]
        .map((value) => value.toFixed(4)).join("/"),
      "| 频谱最高点", results[timbre].peakFrequency, "Hz");
  }

  // ——— 频谱断言：证明"像钢琴/像人声"不是心理作用 ———
  const piano = results.piano;
  assert.ok(piano.rms.attack > 0.01, "钢琴必须有声音");
  assert.ok(piano.peakSample < 1.0, "不能削波爆音");
  assert.ok(piano.harmonics[0] > piano.harmonics[1], "钢琴基音应强于第 2 泛音");
  assert.ok(piano.harmonics[1] > piano.harmonics[3], "钢琴泛音应逐次衰减");
  assert.ok(piano.harmonics[3] > piano.harmonics[5], "钢琴高次泛音继续衰减");
  assert.ok(piano.rms.attack > piano.rms.body * 1.2, "钢琴应有明显衰减（起音比保持段响）");
  assert.ok(piano.rms.body < piano.rms.attack, "钢琴余音应弱于起音");

  const organ = results.organ;
  assert.ok(organ.rms.attack > 0.01, "管风琴必须有声音");
  assert.ok(organ.harmonics[1] / organ.harmonics[0] > 0.3, "管风琴应有明显的八度音栓");
  assert.ok(organ.harmonics[2] / organ.harmonics[0] > 0.15, "管风琴应有明显的十二度音栓");

  const soft = results.soft;
  assert.ok(soft.rms.attack > 0.01, "电子琴必须有声音");
  assert.ok(soft.harmonics[1] / soft.harmonics[0] < 0.2, "三角波没有偶次泛音，第 2 泛音应几乎为零");
  assert.ok(soft.harmonics[2] / soft.harmonics[0] > 0.05, "三角波应保留第 3 泛音");

  const choir = results.choir;
  const vowel = vowelForPart("S1");
  const formants = VOWELS[vowel];
  assert.ok(choir.rms.attack > 0.01, "合唱必须有声音");
  assert.ok(choir.peakSample < 1.0, "不能削波爆音");
  assert.ok(choir.peakFrequency > 200 && choir.peakFrequency < 3400, "合唱频谱最高点应落在人声范围内");
  console.log("合唱元音：", vowel, "共振峰", formants.map((entry) => entry[0]).join("/"), "Hz");

  // 共振峰验证：用低音 C2 唱（65.4 Hz），它的泛音间隔只有 65 Hz，
  // 正好能"铺满"共振峰频带；再扫一遍频谱，看元音共振峰位置是不是鼓包。
  const c2Spectrum = await page.evaluate(async () => {
    const debug = window.__pujian;
    const sampleRate = 44100;
    const context = new OfflineAudioContext(1, Math.floor(sampleRate * 1.5), sampleRate);
    debug.state.audio = context;
    debug.state.master = null;
    debug.state.reverbBuffer = null;
    debug.state.vibrato = null;
    debug.state.noiseBuffer = null;
    debug.state.waves.clear();
    debug.state.partBuses.clear();
    debug.state.sources.clear();
    debug.state.timbre = "choir";
    debug.playTone(36, 0.05, 1.1, 0.16, null, "S1");
    const buffer = await context.startRendering();
    const samples = buffer.getChannelData(0);
    const from = Math.floor(0.15 * sampleRate);
    const to = Math.floor(0.95 * sampleRate);
    const magnitude = (frequency) => {
      const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
      let previous = 0;
      let beforePrevious = 0;
      for (let index = from; index < to; index += 1) {
        const current = samples[index] + coefficient * previous - beforePrevious;
        beforePrevious = previous;
        previous = current;
      }
      return Math.sqrt(Math.max(0, previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious));
    };
    const spectrum = [];
    for (let hz = 120; hz <= 3600; hz += 4) spectrum.push([hz, magnitude(hz)]);
    return spectrum;
  });
  // 频带能量：把某个中心频率 ±半个带宽内的谱线平方和加起来（真正的"频带能量"）。
  const bandEnergy = (spectrum, center, bandwidth) => {
    let total = 0;
    let count = 0;
    for (const [hz, value] of spectrum) {
      if (Math.abs(hz - center) > bandwidth / 2) continue;
      total += value * value;
      count += 1;
    }
    return Math.sqrt(total / Math.max(1, count));
  };
  const formantBands = formants.map(([hz, , bandwidth]) => bandEnergy(c2Spectrum, hz, Math.max(bandwidth, 120)));
  // 「谷」取相邻两个共振峰的中点：没有共振峰的位置能量应该更低。
  const valleys = [
    (formants[0][0] + formants[1][0]) / 2,
    (formants[1][0] + formants[2][0]) / 2,
  ].map((hz) => bandEnergy(c2Spectrum, hz, 160));
  const lifts = formantBands.map((energy, index) => energy / (valleys[Math.min(index, valleys.length - 1)] || 1));
  console.log("低音 C2 频谱：共振峰频带能量 vs 谷",
    formantBands.map((value, index) => `F${index + 1}=${value.toFixed(4)}`).join(" "),
    "| 谷", valleys.map((value) => value.toFixed(4)).join(" "),
    "| 倍数", lifts.map((value) => value.toFixed(2)).join("/"));
  assert.ok(
    lifts.filter((value) => Number.isFinite(value)).some((value) => value > 1.25),
    "元音共振峰位置的频带能量应显著高于两峰之间的谷（实测倍数 " + lifts.map((value) => value.toFixed(2)).join("/") + "）",
  );

  for (const [name, data] of Object.entries(results)) {
    assert.ok(data.rms.attack > 0.008, name + " 起音阶段就应该听得见（RMS > 0.008）");
    assert.ok(data.rms.tail > 0, name + " 松键后应还有混响余音（tail RMS > 0）");
    assert.ok(data.rms.tail < data.rms.body, name + " 混响余音不能比正在发声时更响");
  }
  // 响度配平：切换音色时听感响度应基本一致（误差控制在 ±60% 以内）。
  const loudness = Object.fromEntries(Object.entries(results).map(([name, data]) => [name, data.rms.body]));
  console.log("各音色稳态响度（RMS）：", Object.entries(loudness).map(([name, value]) => name + "=" + value.toFixed(3)).join(" "));
  for (const [name, value] of Object.entries(loudness)) {
    assert.ok(value / loudness.piano > 0.62 && value / loudness.piano < 1.6,
      name + " 的响度应与钢琴接近（实测 " + (value / loudness.piano).toFixed(2) + " 倍）");
  }
  console.log("混响余音（松键后 0.35–0.9 秒）：", REVERB.seconds, "秒衰减，实测 RMS 均 > 0 ✔");

  // ——— 真实播放流程：切换音色 → 点▶ → 停止 ———
  await page.selectOption("#timbreSelect", "choir");
  const afterSelect = await page.evaluate(() => ({
    timbre: window.__pujian.state.timbre,
    hint: document.querySelector("#timbreHint").textContent,
    saved: window.localStorage.getItem("pujian.settings.v1"),
    select: document.querySelector("#timbreSelect").value,
    // 离线渲染留下的上下文要清掉，让真实播放重新 new 一个 AudioContext。
    reset: (() => {
      window.__pujian.state.audio = null;
      window.__pujian.state.master = null;
      window.__pujian.state.reverbBuffer = null;
      window.__pujian.state.vibrato = null;
      window.__pujian.state.noiseBuffer = null;
      window.__pujian.state.waves.clear();
      window.__pujian.state.partBuses.clear();
      window.__pujian.state.sources.clear();
      return true;
    })(),
  }));
  assert.equal(afterSelect.timbre, "choir", "下拉切换应真的改了音色");
  assert.equal(afterSelect.select, "choir");
  assert.match(afterSelect.hint, /合唱人声/);
  assert.match(String(afterSelect.saved), /choir/, "音色选择应记进本地存储");
  console.log("音色切换：", JSON.stringify({ timbre: afterSelect.timbre, hint: afterSelect.hint, saved: afterSelect.saved }));

  await page.click("#playButton");
  await page.waitForTimeout(1500);
  const during = await page.evaluate(() => ({
    playing: window.__pujian.state.isPlaying,
    sources: window.__pujian.state.sources.size,
    buses: window.__pujian.state.partBuses.size,
  }));
  console.log("播放中：", JSON.stringify(during));
  assert.equal(during.playing, true, "点▶应该开始播放");
  assert.ok(during.sources > 0, "播放中应该有正在发声的音频节点");
  assert.ok(during.buses > 0, "每个声部应该有一条音量总线");
  await page.click("#stopButton");
  await page.waitForTimeout(400);
  const afterStop = await page.evaluate(() => ({
    playing: window.__pujian.state.isPlaying,
    sources: window.__pujian.state.sources.size,
  }));
  console.log("停止后：", JSON.stringify(afterStop));
  assert.equal(afterStop.playing, false, "点■应该停止播放");
  assert.equal(afterStop.sources, 0, "停止后音频节点应全部回收（否则反复试听会越来越卡）");

  assert.deepEqual(errors, [], "页面不应有 JS 报错：" + errors.slice(0, 5).join(" | "));
  console.log("\n播放音色端到端验证通过 ✔");
} finally {
  await browser.close();
}
