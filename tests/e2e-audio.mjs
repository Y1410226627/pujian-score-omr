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

  // ——— 离线渲染五种音色，各弹一个 C4 长音 ———
  for (const timbre of ["piano", "strings", "choir", "organ", "soft"]) {
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

  const strings = results.strings;
  assert.ok(strings.rms.attack > 0.01, "弦乐必须有声音");
  assert.ok(strings.peakSample < 1.0, "弦乐不能削波");
  // 锯齿波基音最强、第 2 泛音约为基音一半（区别于三角波的第 2 泛音≈0）。
  assert.ok(strings.harmonics[1] / strings.harmonics[0] > 0.2, "弦乐应保留明显的 2 次泛音（锯齿波特征）");
  assert.ok(strings.harmonics[2] / strings.harmonics[0] > 0.05, "弦乐应保留 3 次泛音");

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
    assert.ok(value / loudness.piano > 0.55 && value / loudness.piano < 1.7,
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
  assert.match(afterSelect.hint, /各声部可单独选/);
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

  // ——— 逐声部音色：每个声部可以单独选音色，而不是所有声部共用一种 ———
  const perPart = await page.evaluate(() => {
    const debug = window.__pujian;
    const selects = [...document.querySelectorAll(".part-timbre-select")];
    if (!selects.length) return { error: "声部面板里没有音色下拉" };
    const select = selects[0];
    const row = select.closest(".part-row");
    const firstKey = row.dataset.partKey;
    select.value = "strings";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const afterSet = {
      partKey: firstKey,
      mapValue: debug.state.partTimbres.get(firstKey),
      resolved: debug.timbreForPart(firstKey),
      globalTimbre: debug.state.timbre,
      selectValue: select.value,
      saved: window.localStorage.getItem("pujian.settings.v1"),
    };
    // 还原成"跟随全局"，避免影响后续其它断言
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      ...afterSet,
      restored: debug.timbreForPart(firstKey),
      restoredSelect: select.value,
      inputs: selects.length,
    };
  });
  console.log("逐声部音色：", JSON.stringify(perPart));
  assert.ok(!perPart.error, perPart.error || "");
  assert.equal(perPart.globalTimbre, "choir", "全局音色应仍是合唱人声");
  assert.equal(perPart.resolved, "strings", "该声部单独选的弦乐应当覆盖全局音色");
  assert.notEqual(perPart.resolved, perPart.globalTimbre, "逐声部音色必须能不同于全局音色");
  assert.match(String(perPart.saved), /strings/, "逐声部音色应记进本地存储");
  assert.equal(perPart.restored, "choir", "改回「跟随全局」后应回到全局音色");

  // ——— 滚动调度护栏：播放时音频图里不能堆着整曲的节点 ———
  const scheduling = await page.evaluate(async () => {
    const debug = window.__pujian;
    debug.prepareAudio();
    await debug.playMelody();
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const snapshot = {
      ms: Number((performance.now() - started).toFixed(0)),
      sources: debug.state.sources.size,
      notes: debug.state.notes.length,
      playing: debug.state.isPlaying,
    };
    debug.stopPlayback();
    return snapshot;
  });
  console.log("滚动调度：", JSON.stringify(scheduling));
  assert.equal(scheduling.playing, true, "playMelody 之后应处于播放状态");
  assert.ok(scheduling.sources > 0, "播放中应真的有音频节点");
  assert.ok(scheduling.sources <= scheduling.notes * 8,
    "每个音的音频节点数应在合理范围（实测 " + scheduling.sources + " 个源 / " + scheduling.notes + " 个音）");
  // 注：这个样例只有 8 个音，窗口会一次覆盖全部；「节点数受窗口限制」的真正护栏在
  // tests/e2e-jianpu.mjs 里用 526 个音的整本来验。

  // ——— 真实音源（采样）：装了音源才测（没装自动跳过，不影响没下载样本的机器）———
  const sampleManifest = await page.evaluate(() => window.__pujian.fetchSampleManifest());
  if (!sampleManifest) {
    console.log("跳过采样音源测试：本机未安装 .assets/soundfonts（运行「安装真实音源.bat」后可测）。");
  } else {
    assert.ok(sampleManifest.banks.piano_real, "音源清单里应有真实钢琴");
    assert.ok(sampleManifest.banks.choir_real, "音源清单里应有真实合唱人声");
    assert.ok(sampleManifest.banks.strings_real, "音源清单里应有真实弦乐");
    console.log("音源清单：", Object.keys(sampleManifest.banks).join("、"));

    const sampled = await page.evaluate(async () => {
      const debug = window.__pujian;
      debug.prepareAudio();
      const savedAudio = debug.state.audio;   // 离线渲染只是临时借用 state.audio，渲完必须还回去
      const pianoBank = await debug.ensureSampleBank("piano_real");
      const reset = (offline) => {
        debug.state.audio = offline;
        debug.state.master = null;
        debug.state.reverbBuffer = null;
        debug.state.vibrato = null;
        debug.state.noiseBuffer = null;
        debug.state.waves.clear();
        debug.state.partBuses.clear();
        debug.state.sources.clear();
        debug.state.partTimbres.clear();
        debug.state.timbre = "piano_real";
      };
      const sampleRate = 44100;
      const render = async (midi, peak) => {
        const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * 3.5), sampleRate);
        reset(offline);
        debug.playTone(midi, 0.05, 3.0, peak, null, "S1");
        const buffer = await offline.startRendering();
        const data = buffer.getChannelData(0);
        const from = Math.floor(0.5 * sampleRate);
        const size = 4096;
        const slice = data.slice(from, from + size);
        let bestLag = 0;
        let bestScore = -Infinity;
        for (let lag = Math.floor(sampleRate / 1200); lag <= Math.floor(sampleRate / 80); lag += 1) {
          let sum = 0;
          let norm = 0;
          for (let index = 0; index + lag < size; index += 1) {
            sum += slice[index] * slice[index + lag];
            norm += slice[index + lag] * slice[index + lag];
          }
          const score = sum / Math.sqrt(Math.max(1e-9, norm));
          if (score > bestScore) { bestScore = score; bestLag = lag; }
        }
        const windowRms = (to, toEnd) => {
          const start = Math.floor(to * sampleRate);
          const end = Math.min(data.length, Math.floor(toEnd * sampleRate));
          let sum = 0;
          for (let index = start; index < end; index += 1) sum += data[index] * data[index];
          return Math.sqrt(sum / Math.max(1, end - start));
        };
        let peakValue = 0;
        let maxJump = 0;
        for (let index = 0; index < data.length; index += 1) {
          peakValue = Math.max(peakValue, Math.abs(data[index]));
          if (index > 0) maxJump = Math.max(maxJump, Math.abs(data[index] - data[index - 1]));
        }
        return {
          pitch: Number((sampleRate / bestLag).toFixed(1)),
          bodyRms: Number(windowRms(0.5, 2.0).toFixed(4)),
          peak: Number(peakValue.toFixed(3)),
          maxJump: Number(maxJump.toFixed(3)),
        };
      };
      const loud = await render(60, 0.16);
      const soft = await render(60, 0.07);
      const a4 = await render(69, 0.16);
      // 把真实 AudioContext 还回去（离线上下文的 currentTime 不再前进，不能拿来做真实播放）
      debug.state.audio = savedAudio;
      debug.state.master = null;
      debug.state.reverbBuffer = null;
      debug.state.vibrato = null;
      debug.state.noiseBuffer = null;
      debug.state.waves.clear();
      debug.state.partBuses.clear();
      debug.state.sources.clear();
      debug.state.partTimbres.clear();
      debug.state.timbre = "piano_real";
      return {
        loaded: Boolean(pianoBank),
        layers: pianoBank ? pianoBank.layers.length : 0,
        samples: pianoBank ? pianoBank.layers.map((layer) => layer.samples.length) : [],
        loud, soft, a4,
      };
    });
    console.log("真实钢琴：", JSON.stringify({ layers: sampled.layers, samples: sampled.samples }),
      "| C4", JSON.stringify(sampled.loud), "| C4 轻力度 RMS", sampled.soft.bodyRms, "| A4 音高", sampled.a4.pitch);
    assert.equal(sampled.loaded, true, "真实钢琴应当能加载");
    assert.equal(sampled.layers, 2, "钢琴应有软/重两个力度层");
    assert.ok(sampled.samples.every((count) => count >= 28), "每层应有 30 个基础采样");
    assert.ok(Math.abs(sampled.loud.pitch - 261.6) < 15, "真实钢琴 C4 的音高应≈261.6 Hz（实测 " + sampled.loud.pitch + "）");
    assert.ok(Math.abs(sampled.a4.pitch - 440) < 20, "真实钢琴 A4 的音高应≈440 Hz（实测 " + sampled.a4.pitch + "）");
    assert.ok(sampled.loud.bodyRms > 0.01, "真实钢琴应当有足够响度（RMS " + sampled.loud.bodyRms + "）");
    assert.ok(sampled.loud.bodyRms < 0.12, "真实钢琴不能爆响（RMS " + sampled.loud.bodyRms + "）");
    assert.ok(sampled.soft.bodyRms < sampled.loud.bodyRms, "轻力度应当比重力度轻");
    assert.ok(sampled.loud.peak < 0.95, "真实钢琴不能削波（峰值 " + sampled.loud.peak + "）");
    assert.ok(sampled.loud.maxJump < 0.2, "真实钢琴不应有爆音跳变（最大跳变 " + sampled.loud.maxJump + "）");

    // 真实人声/弦乐：长音必须能"撑住"（样本 3.13 秒 + 循环）
    const sustained = await page.evaluate(async () => {
      const debug = window.__pujian;
      const sampleRate = 44100;
      const result = {};
      const savedAudio = debug.state.audio;
      for (const name of ["choir_real", "strings_real"]) {
        const bank = await debug.ensureSampleBank(name);
        const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * 6), sampleRate);
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
        debug.playTone(60, 0.05, 4.8, 0.16, null, "S1");
        const buffer = await offline.startRendering();
        const data = buffer.getChannelData(0);
        const rms = (from, to) => {
          const start = Math.floor(from * sampleRate);
          const end = Math.min(data.length, Math.floor(to * sampleRate));
          let sum = 0;
          for (let index = start; index < end; index += 1) sum += data[index] * data[index];
          return Math.sqrt(sum / Math.max(1, end - start));
        };
        let peak = 0;
        let maxJump = 0;
        for (let index = 0; index < data.length; index += 1) {
          peak = Math.max(peak, Math.abs(data[index]));
          if (index > 0) maxJump = Math.max(maxJump, Math.abs(data[index] - data[index - 1]));
        }
        result[name] = {
          loaded: Boolean(bank),
          samples: bank ? bank.layers[0].samples.length : 0,
          early: Number(rms(0.5, 1.5).toFixed(4)),
          late: Number(rms(2.5, 4.0).toFixed(4)),   // 超过原始样本 3.13 秒：靠循环撑住
          peak: Number(peak.toFixed(3)),
          maxJump: Number(maxJump.toFixed(3)),
        };
      }
      debug.state.audio = savedAudio;
      debug.state.master = null;
      debug.state.reverbBuffer = null;
      debug.state.vibrato = null;
      debug.state.noiseBuffer = null;
      debug.state.waves.clear();
      debug.state.partBuses.clear();
      debug.state.sources.clear();
      debug.state.partTimbres.clear();
      debug.state.timbre = "piano_real";
      return result;
    });
    console.log("真实持续音色：", JSON.stringify(sustained));
    for (const [name, data] of Object.entries(sustained)) {
      assert.equal(data.loaded, true, name + " 应当能加载");
      assert.ok(data.samples >= 70, name + " 应有 70+ 个可用采样（静音样本已剔除）");
      assert.ok(data.early > 0.008, name + " 起音后应有声音");
      assert.ok(data.late > 0.004, name + " 超过样本长度后应靠循环继续发声（实测 " + data.late + "）");
      assert.ok(data.late > data.early * 0.4, name + " 长音不应明显衰减（循环没生效？）");
      assert.ok(data.peak < 0.95, name + " 不能削波");
      assert.ok(data.maxJump < 0.2, name + " 循环处不应有爆音（最大跳变 " + data.maxJump + "）");
    }

    // 走真实 UI 路径：选真实钢琴 → 等加载完成 → 播放 → 停止
    await page.selectOption("#timbreSelect", "piano_real");
    await page.waitForFunction(() => window.__pujian.state.sampleBanks.has("piano_real"), null, { timeout: 60000 });
    await page.click("#playButton");
    await page.waitForTimeout(1200);
    const realtime = await page.evaluate(() => ({
      timbre: window.__pujian.state.timbre,
      playing: window.__pujian.state.isPlaying,
      sources: window.__pujian.state.sources.size,
      status: document.querySelector("#sampleStatus")?.textContent || "",
    }));
    console.log("真实钢琴 UI 播放：", JSON.stringify(realtime));
    // 播放可能已经结束（8 个音的样例很短），这时停止按钮是灰的：只在还在播时点它。
    if (!(await page.$eval("#stopButton", (button) => button.disabled))) {
      await page.click("#stopButton");
      await page.waitForTimeout(300);
    }
    assert.equal(realtime.timbre, "piano_real", "下拉应能选到真实钢琴");
    assert.equal(realtime.playing, true, "真实钢琴应当能播放");
    assert.ok(realtime.sources > 0, "真实钢琴播放应有音频节点");
    assert.match(realtime.status, /音源/, "界面应显示真实音源状态");
  }

  assert.deepEqual(errors, [], "页面不应有 JS 报错：" + errors.slice(0, 5).join(" | "));
  console.log("\n播放音色端到端验证通过 ✔");
} finally {
  await browser.close();
}
