// 采样音源（真实钢琴 / 合唱人声 / 弦乐）的加载与音符映射。
//
// 数据从哪来：由 `tools/install_soundfonts.py` 在本机下载到 `.assets/soundfonts/`
// （不进 git；许可与署名见那个目录里的 LICENSES.md）。没装的话本模块的所有函数都返回空，
// 应用自动退回合成音色——不会因为缺音源而播不出声。
//
// 为什么是「采样器」而不是直接放音频文件：
//   · 样本只有 30 个基础音（钢琴，每 3 个半音一个）或 88 个音（人声/弦乐），
//     播放任意音高要靠 playbackRate 变速（±1.5 个半音的变速听不出破绽）；
//   · 力度靠「分层采样 + 增益」表达（钢琴有 soft/loud 两层，人声/弦乐一层再按力度调增益）；
//   · 人声/弦乐是持续音，样本只有 3.13 秒，长音要在零交叉点循环（否则会有"啪"的接缝）。
//
// 本文件里「纯函数」部分（nearestSampleIndex / playbackRateFor / pickLayerIndex /
// snapToZeroCrossing）可以直接在 node 里单测，见 tests/sampler.test.mjs。

/** 采样音源清单：装好后由安装器生成；没装时 fetch 404，应用退回合成音色。 */
export const SAMPLE_MANIFEST_URL = ".assets/soundfonts/manifest.json";
/** 样本文件所在目录：清单里的路径是相对这个目录的（例如 salamander/v04/A0v4.mp3）。 */
export const SAMPLE_ROOT = ".assets/soundfonts/";

/**
 * 采样音源的目标响度（单个音符在峰值 0.16 时的 RMS）。
 * 这个值是照合成音色实测出来的（钢琴 body RMS≈0.036），加载时按每层样本的实际 RMS 反推增益，
 * 这样"合成 ↔ 采样"来回切换不会忽大忽小；不同力度层之间再由表情系数拉开强弱。
 */
export const SAMPLED_TARGET_RMS = 0.22;

/** 哪些音色是「采样音源」，以及没加载好时该退回哪个合成音色。 */
export const SAMPLED_TIMBRES = {
  piano_real: { fallback: "piano", continuous: false },
  choir_real: { fallback: "choir", continuous: true },
  strings_real: { fallback: "strings", continuous: true },
};

/** 音色名是不是采样音源。 */
export function isSampledTimbre(name) {
  return Object.prototype.hasOwnProperty.call(SAMPLED_TIMBRES, name);
}

/** 在按 midi 升序排好的样本表里找最接近的一个（返回下标；空表返回 -1）。 */
export function nearestSampleIndex(samples, midi) {
  if (!samples || !samples.length) return -1;
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < samples.length; index += 1) {
    const distance = Math.abs(samples[index].midi - midi);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
    // 样本表是升序的：一旦越过目标，后面的只会更远，可以提前结束。
    if (samples[index].midi > midi) break;
  }
  return best;
}

/** 采样音与目标音高之间要乘的 playbackRate（每高一个半音 ×2^(1/12)）。 */
export function playbackRateFor(midi, baseMidi) {
  return 2 ** ((midi - baseMidi) / 12);
}

/** 从力度层里挑最接近当前力度的一层（层按 velocity 升序；返回下标）。 */
export function pickLayerIndex(layers, velocity) {
  if (!layers || !layers.length) return 0;
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < layers.length; index += 1) {
    const distance = Math.abs((layers[index].velocity || 0.5) - velocity);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * 在目标秒数附近找一个「向上穿过的零交叉点」并返回它的时间（秒）。
 * 作用：让循环起点/终点落在过零点上，接缝处的波形值≈0，不会「啪」一声。
 * 实测（FluidR3 人声/弦乐）：吸附零交叉后循环播放的最大跳变与不循环时完全相同。
 */
export function snapToZeroCrossing(data, sampleRate, seconds) {
  if (!data || !data.length || !sampleRate) return seconds;
  const center = Math.max(1, Math.min(data.length - 2, Math.round(seconds * sampleRate)));
  const reach = Math.round(sampleRate * 0.05);   // 在 ±50 ms 内找
  for (let offset = 0; offset <= reach; offset += 1) {
    for (const index of [center + offset, center - offset]) {
      if (index <= 0 || index >= data.length) continue;
      if (data[index - 1] <= 0 && data[index] > 0) return index / sampleRate;
    }
  }
  return center / sampleRate;
}

/** 把任意声道的 AudioBuffer 下混成单声道 Float32Array（省一半内存，靠声部立体声定位补空间感）。 */
function downmixToMono(buffer) {
  const length = buffer.length;
  const mono = new Float32Array(length);
  const channels = buffer.numberOfChannels;
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) mono[index] += data[index] / channels;
  }
  return mono;
}

/** 截取 + 尾部淡出，返回可播放的单声道 AudioBuffer。 */
function buildPlayableBuffer(mono, sampleRate, { trimSeconds = 0, fadeOutSeconds = 0.25 } = {}) {
  let length = mono.length;
  if (trimSeconds > 0) length = Math.min(length, Math.round(trimSeconds * sampleRate));
  const buffer = new AudioBuffer({ length, numberOfChannels: 1, sampleRate });
  const data = buffer.getChannelData(0);
  data.set(mono.subarray(0, length));
  const fadeLength = Math.min(length, Math.round(fadeOutSeconds * sampleRate));
  for (let index = 0; index < fadeLength; index += 1) {
    const position = length - fadeLength + index;
    data[position] *= 1 - index / fadeLength;
  }
  return buffer;
}

/** 读取清单（没安装返回 null，不抛错）。 */
export async function fetchSampleManifest(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(SAMPLE_MANIFEST_URL, { cache: "no-cache" });
    if (!response.ok) return null;
    const manifest = await response.json();
    return manifest && manifest.banks && Object.keys(manifest.banks).length ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * 加载一个采样音源（把 mp3 解码成内存里的 AudioBuffer）。
 *
 * @param manifest fetchSampleManifest() 的结果
 * @param name     piano_real / choir_real / strings_real
 * @param options  { onProgress({done,total}) }
 * @returns 形如 { name, continuous, layers: [{velocity, samples: [{midi, buffer, loopStart, loopEnd}]}] }；
 *          没装该音源时返回 null。
 */
export async function loadSampleBank(manifest, name, { onProgress = () => {} } = {}) {
  const spec = manifest && manifest.banks && manifest.banks[name];
  if (!spec) return null;
  const decodeRate = spec.decodeRate || 24000;
  // 用「低采样率离线上下文」解码：decodeAudioData 会顺带重采样到 24/32 kHz，直接省掉一半以上内存。
  let decodeContext = null;
  try {
    decodeContext = new OfflineAudioContext(1, 1, decodeRate);
  } catch {
    decodeContext = null;
  }
  const decode = async (bytes) => {
    if (decodeContext) return decodeContext.decodeAudioData(bytes);
    const fallback = new OfflineAudioContext(1, 1, 24000);
    return fallback.decodeAudioData(bytes);
  };

  const layers = spec.layers || [];
  const total = layers.reduce((sum, layer) => sum + Object.keys(layer.notes || {}).length, 0);
  let done = 0;
  const bank = { name, label: spec.label || name, continuous: Boolean(spec.continuous), layers: [] };
  for (const layer of layers) {
    const entries = Object.entries(layer.notes || {})
      .map(([midiText, path]) => [Number(midiText), path])
      .sort((a, b) => a[0] - b[0]);
    const samples = [];
    const layerRms = [];
    for (const [midi, path] of entries) {
      const response = await fetch(SAMPLE_ROOT + path);
      if (!response.ok) throw new Error("采样音源加载失败：" + path);
      const decoded = await decode(await response.arrayBuffer());
      const sampleRate = decoded.sampleRate;
      const mono = downmixToMono(decoded);
      const buffer = buildPlayableBuffer(mono, sampleRate, {
        trimSeconds: spec.trimSeconds || 0,
        fadeOutSeconds: spec.trimSeconds ? 0.3 : 0,
      });
      // FluidR3 对超出乐器音域的高音会渲染成整段静音（实测人声/弦乐 C7 以上 12 个），
      // 这种"哑样本"要是留下来，靠近它的音会变成没声音——直接剔除，让最近的可用样本顶上。
      const sampleData = buffer.getChannelData(0);
      let energy = 0;
      for (let index = 0; index < sampleData.length; index += 1) energy += sampleData[index] * sampleData[index];
      const rms = Math.sqrt(energy / Math.max(1, sampleData.length));
      if (rms < 0.0005) {
        done += 1;
        onProgress({ done, total });
        continue;
      }
      layerRms.push(rms);
      // 同层不同音高的录音电平并不一致（实测 A4 比 C4 轻 2 倍多），
      // 记一个温和的配平系数：完全拉平会丢掉钢琴本身的音区差异，所以只按 0.8 次方修正。
      const sample = { midi, buffer, rms };
      if (bank.continuous) {
        // 持续音：在指定区间循环。循环点吸附到过零点，避免接缝爆音。
        const [startSeconds, endSeconds] = spec.loopSeconds || [1.0, 2.5];
        const monoData = buffer.getChannelData(0);
        sample.loopStart = snapToZeroCrossing(monoData, sampleRate, Math.min(startSeconds, buffer.duration * 0.5));
        sample.loopEnd = snapToZeroCrossing(monoData, sampleRate, Math.min(endSeconds, buffer.duration - 0.05));
        if (sample.loopEnd - sample.loopStart < 0.1) {
          sample.loopStart = buffer.duration * 0.3;
          sample.loopEnd = buffer.duration * 0.9;
        }
      }
      samples.push(sample);
      done += 1;
      onProgress({ done, total });
    }
    // 这一层样本的典型响度（中位数，避免个别极端样本带偏增益标定）
    const sortedRms = layerRms.slice().sort((a, b) => a - b);
    const medianRms = sortedRms.length ? sortedRms[Math.floor(sortedRms.length / 2)] : 0.01;
    // 每个样本再按自身 RMS 做温和配平（0.8 次方：只压掉明显的电平差，保留音区差异）
    for (const sample of samples) {
      const ratio = medianRms / Math.max(0.0008, sample.rms || medianRms);
      sample.trim = Math.min(2.5, Math.max(0.4, ratio ** 0.8));
    }
    bank.layers.push({ velocity: layer.velocity, samples, medianRms });
  }
  return bank;
}

/** 从已加载的 bank 里取出「该用哪个样本、变速多少」；纯查表，不创建音频节点。 */
export function lookupSample(bank, midi, velocity) {
  if (!bank || !bank.layers.length) return null;
  const layerIndex = bank.continuous ? 0 : pickLayerIndex(bank.layers, velocity);
  const layer = bank.layers[layerIndex];
  const sampleIndex = nearestSampleIndex(layer.samples, midi);
  if (sampleIndex < 0) return null;
  const sample = layer.samples[sampleIndex];
  return { sample, layer, playbackRate: playbackRateFor(midi, sample.midi) };
}
