// 实测每个采样 bank 的响度（C4 长音），输出 JSON 供 BANK_LEVEL 标定。
// 自己解码音频（不走 sampler.js 的 loadSampleBank，避免 Node 环境差异）。
// 用法：node tools/measure_bank_levels.mjs
import { readFileSync } from "node:fs";
import { lookupSample } from "file:///E:/识谱弹琴/sampler.js";

const ROOT = "E:/识谱弹琴/.assets/soundfonts/";
const manifest = JSON.parse(readFileSync(ROOT + "manifest.json", "utf8"));
const SAMPLE_ROOT = "/.assets/soundfonts/";

// 用 decodeAudioData 需要 AudioContext；Node 22 起 OfflineAudioContext 只存在于
// 浏览器 / worker。所以这里自己解码：mp3 用外部工具不可行，改为「读取 sampler 的
// 样本 RMS」——清单已带每个样本的实测 RMS（loadSampleBank 时算的）。
//
// 但清单里没有 per-sample RMS，只能自己算：先用 OfflineAudioContext 试一次，
// 不行就退回「只报文件字节数」的粗略估计。
const results = [];
const sampleRate = 44100;

function decodeMp3Fallback(bytes) {
  // 无法直接解 mp3：用 OfflineAudioContext（Node 有 WebAudio 的实验支持）
  return null;
}

(async () => {
  for (const [name, spec] of Object.entries(manifest.banks)) {
    const layers = spec.layers || [];
    if (!layers.length) { results.push({ name, error: "no layers" }); continue; }
    const layer = layers[0];
    const notes = layer.notes || {};
    const keys = Object.keys(notes);
    if (!keys.length) { results.push({ name, error: "no notes" }); continue; }
    // 取音高最接近 60 的样本
    let bestKey = keys[0];
    let bestDistance = Infinity;
    for (const key of keys) {
      const distance = Math.abs(Number(key) - 60);
      if (distance < bestDistance) { bestDistance = distance; bestKey = key; }
    }
    const entry = notes[bestKey];
    const path = ROOT + entry.path.replace(/^\/?/, "");
    try {
      const bytes = readFileSync(path);
      const ext = path.toLowerCase().split(".").pop();
      let buffer = null;
      if (ext === "wav") {
        buffer = decodeWav(bytes);
      } else if (ext === "mp3") {
        try {
          buffer = await decodeWithWebAudio(bytes);
        } catch (error) {
          results.push({ name, error: "mp3 需浏览器环境", samples: keys.length });
          continue;
        }
      }
      if (!buffer) { results.push({ name, error: "无法解码 " + ext }); continue; }
      // 播放并测量
      const seconds = spec.continuous ? 2.0 : 1.5;
      const context = new OfflineAudioContext(1, Math.floor(sampleRate * seconds), sampleRate);
      const bank = {
        name, continuous: Boolean(spec.continuous),
        layers: [{ velocity: 0.8, samples: [{ midi: Number(bestKey), buffer, loopStart: entry.loopStart, loopEnd: entry.loopEnd, rms: 0.01, tune: entry.tune || 0, gainDb: null }] }],
      };
      const found = lookupSample(bank, Number(bestKey), 0.8);
      const source = context.createBufferSource();
      source.buffer = found.sample.buffer;
      source.playbackRate.value = found.playbackRate;
      if (spec.continuous && entry.loopStart && entry.loopEnd) {
        source.loop = true;
        source.loopStart = Number(entry.loopStart);
        source.loopEnd = Number(entry.loopEnd);
      }
      source.connect(context.destination);
      source.start(0);
      source.stop(seconds);
      const rendered = await context.startRendering();
      const data = rendered.getChannelData(0);
      let peak = 0, sum = 0, count = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = Math.abs(data[i]);
        if (value > peak) peak = value;
        if (i > sampleRate * 0.2 && i < sampleRate * (seconds - 0.3)) {
          sum += data[i] * data[i]; count += 1;
        }
      }
      results.push({ name, peak: Number(peak.toFixed(4)), rms: Number((count ? Math.sqrt(sum / count) : 0).toFixed(5)), samples: keys.length });
    } catch (error) {
      results.push({ name, error: String((error && error.message) || error).slice(0, 80) });
    }
    console.error(name, "done");
  }
  console.log(JSON.stringify(results));
})().catch((error) => { console.error("FATAL", error); process.exit(1); });

function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const frames = Math.floor((bytes.byteLength - 44) / (channels * (bits / 8)));
  const ctx = new OfflineAudioContext(1, frames + 1, rate);
  const buffer = ctx.createBuffer(1, frames + 1, rate);
  const data = buffer.getChannelData(0);
  const width = bits / 8;
  for (let i = 0; i < frames; i += 1) {
    let value = 0;
    for (let c = 0; c < channels; c += 1) {
      const offset = 44 + (i * channels + c) * width;
      if (bits === 16) value += view.getInt16(offset, true) / 32768;
      else if (bits === 24) {
        const raw = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
        value += (raw >= 1 << 23 ? raw - (1 << 24) : raw) / 8388608;
      }
    }
    data[i] = value / channels;
  }
  return buffer;
}

async function decodeWithWebAudio(bytes) {
  const context = new OfflineAudioContext(1, 1, 44100);
  return context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
