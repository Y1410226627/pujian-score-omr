// 采样音源（真实钢琴 / 人声 / 弦乐 / 管乐 / 键盘…）的加载与音符映射。
//
// 数据从哪来：由 `tools/install_soundfonts.py` 在本机下载到 `.assets/soundfonts/`
// （不进 git；许可与署名见那个目录里的 LICENSES.md）。没装的话本模块的所有函数都返回空，
// 应用自动退回合成音色——不会因为缺音源而播不出声。
//
// 为什么是「采样器」而不是直接放音频文件：
//   · 样本只有几十个基础音，播放任意音高要靠 playbackRate 变速（每 1–3 个半音一个采样点）；
//   · 力度靠「分层采样 + 增益」表达（钢琴有 soft/loud 两层，其他乐器一层再按力度调增益）；
//   · 持续音（人声/弦乐/管乐/管风琴）样本只有几秒，长音要在循环点循环。
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

/**
 * 所有「采样音源」音色：fallback = 没装/没加载好时用哪个合成音色兜底；
 * continuous = 是否需要循环撑住长音（人声、弓弦、管乐、管风琴等持续音）。
 */
export const SAMPLED_TIMBRES = {
  // 钢琴 / 键盘
  piano_real: { fallback: "piano", continuous: false },
  electric_piano_real: { fallback: "soft", continuous: false },
  harpsichord_real: { fallback: "soft", continuous: false },
  vibraphone_real: { fallback: "soft", continuous: false },
  church_organ_real: { fallback: "organ", continuous: true },
  pad_real: { fallback: "strings", continuous: true },
  // 弦乐（细分）
  strings_real: { fallback: "strings", continuous: true },
  violin_real: { fallback: "strings", continuous: true },
  viola_real: { fallback: "strings", continuous: true },
  cello_real: { fallback: "strings", continuous: true },
  contrabass_real: { fallback: "strings", continuous: true },
  pizzicato_real: { fallback: "strings", continuous: false },
  tremolo_real: { fallback: "strings", continuous: true },
  harp_real: { fallback: "strings", continuous: false },
  // 人声（女声 / 男声 / 混声）
  choir_real: { fallback: "choir", continuous: true },
  choir_female: { fallback: "choir", continuous: true },
  choir_male: { fallback: "choir", continuous: true },
  voice_oohs_real: { fallback: "choir", continuous: true },
  synth_choir_real: { fallback: "choir", continuous: true },
  // 管乐
  flute_real: { fallback: "organ", continuous: true },
  clarinet_real: { fallback: "organ", continuous: true },
  oboe_real: { fallback: "organ", continuous: true },
  bassoon_real: { fallback: "organ", continuous: true },
  trumpet_real: { fallback: "organ", continuous: true },
  horn_real: { fallback: "organ", continuous: true },
  trombone_real: { fallback: "organ", continuous: true },
  erhu_real: { fallback: "strings", continuous: true },
  zhonghu_real: { fallback: "strings", continuous: true },
  gaohu_real: { fallback: "strings", continuous: true },
  pipa_real: { fallback: "soft", continuous: false },
  zhongruan_real: { fallback: "soft", continuous: false },
  daruan_real: { fallback: "strings", continuous: false },
  liuqin_real: { fallback: "soft", continuous: false },
  guzheng_real: { fallback: "soft", continuous: false },
  dizi_real: { fallback: "organ", continuous: true },
  qudi_real: { fallback: "organ", continuous: true },
  xiao_real: { fallback: "organ", continuous: true },
  xun_real: { fallback: "organ", continuous: true },
  guanzi_real: { fallback: "organ", continuous: true },
  sheng_real: { fallback: "organ", continuous: true },
  suona_real: { fallback: "organ", continuous: true },
  yangqin_real: { fallback: "soft", continuous: false },
  // 打击乐完整播放采样，不按音符时值截断；pitch 固定，力度由采样层表达。
  pengling_real: { fallback: "soft", continuous: false, oneShot: true, fixedPitch: true },
  muyu_real: { fallback: "soft", continuous: false, oneShot: true, fixedPitch: true },
  xiaoluo_real: { fallback: "soft", continuous: false, oneShot: true, fixedPitch: true },
  daluo_real: { fallback: "soft", continuous: false, oneShot: true, fixedPitch: true },
  bo_real: { fallback: "soft", continuous: false, oneShot: true, fixedPitch: true },
  paigu_real: { fallback: "soft", continuous: false, oneShot: true, fixedPitch: true },
  yunluo_real: { fallback: "soft", continuous: false },
  accordion_real: { fallback: "organ", continuous: true },
  piccolo_real: { fallback: "organ", continuous: true },
  english_horn_real: { fallback: "organ", continuous: true },
  recorder_real: { fallback: "organ", continuous: true },
  ocarina_real: { fallback: "organ", continuous: true },
  tuba_real: { fallback: "organ", continuous: true },
  french_horn_real: { fallback: "organ", continuous: true },
  brass_section_real: { fallback: "organ", continuous: true },
  nylon_guitar_real: { fallback: "soft", continuous: false },
  steel_guitar_real: { fallback: "soft", continuous: false },
  electric_guitar_real: { fallback: "soft", continuous: false },
  banjo_real: { fallback: "soft", continuous: false },
  sitar_real: { fallback: "soft", continuous: false },
  acoustic_bass_real: { fallback: "strings", continuous: false },
  electric_bass_real: { fallback: "strings", continuous: false },
  fretless_bass_real: { fallback: "strings", continuous: true },
  alto_sax_real: { fallback: "organ", continuous: true },
  tenor_sax_real: { fallback: "organ", continuous: true },
  soprano_sax_real: { fallback: "organ", continuous: true },
  baritone_sax_real: { fallback: "organ", continuous: true },
  marimba_real: { fallback: "soft", continuous: false },
  xylophone_real: { fallback: "soft", continuous: false },
  glockenspiel_real: { fallback: "soft", continuous: false },
  celesta_real: { fallback: "soft", continuous: false },
  tubular_bells_real: { fallback: "soft", continuous: false },
  steel_drums_real: { fallback: "soft", continuous: false },
  timpani_real: { fallback: "strings", continuous: false },
  synth_lead_real: { fallback: "soft", continuous: true },
  shakuhachi_real: { fallback: "organ", continuous: true },
  shamisen_real: { fallback: "soft", continuous: false },
  koto_real: { fallback: "soft", continuous: false },
  kalimba_real: { fallback: "soft", continuous: false },
  pan_flute_real: { fallback: "organ", continuous: true },
  whistle_real: { fallback: "organ", continuous: true },
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

/** 解析清单里的一个音符条目：兼容旧格式（字符串路径）与新格式（{path, tune, loopStart, loopEnd, gainDb}）。 */
function noteEntry(value) {
  if (typeof value === "string") return { path: value };
  return value && typeof value === "object" ? value : null;
}

/** 分贝 → 线性增益。 */
function dbToGain(db) {
  return 10 ** (Number(db) / 20);
}

/**
 * 加载一个采样音源（把 mp3/wav 解码成内存里的 AudioBuffer）。
 *
 * @param manifest fetchSampleManifest() 的结果
 * @param name     bank 名（piano_real / choir_female / violin_real …）
 * @param options  { onProgress({done,total}) }
 * @returns 形如 { name, continuous, layers: [{velocity, samples: [{midi, tune, buffer, loopStart, loopEnd, trim}]}] }；
 *          没装该音源时返回 null。
 */
export async function loadSampleBank(manifest, name, { onProgress = () => {}, neededMidis = null } = {}) {
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
  const wanted = neededMidis instanceof Set
    ? neededMidis
    : (Array.isArray(neededMidis) && neededMidis.length ? new Set(neededMidis) : null);
  // 先算「每层要加载哪些样本」：
  //   · 有当前乐谱的音高 → 只加载这些音高，再补一条每 3 个样本一格的「粗网格」，
  //     保证乐谱之外的音也能就近取到样本（最多差 2 个半音，变调播放听不出怪）；
  //   · 没有乐谱信息（比如刚打开页面就切音色）→ 整层都加载。
  // 真实钢琴 352 个样本按这个规则通常只要 90–130 个，第一次加载快 3 倍以上，
  // 内存占用也小得多——内存里能同时缓存更多音源，切回来就是 0 毫秒。
  const layerPlans = layers.map((layer) => {
    const all = Object.entries(layer.notes || {})
      .map(([midiText, value]) => [Number(midiText), noteEntry(value)])
      .filter(([, entry]) => entry && entry.path)
      .sort((a, b) => a[0] - b[0]);
    if (!wanted || !wanted.size) return { layer, entries: all, all };
    const picked = new Set();
    for (const [midi] of all) if (wanted.has(Math.round(midi))) picked.add(midi);
    // 粗网格：每 3 个样本取一个，保证任何音都能就近取到样本
    for (let index = 0; index < all.length; index += 3) picked.add(all[index][0]);
    const entries = picked.size >= all.length ? all : all.filter(([midi]) => picked.has(midi));
    return { layer, entries: entries.length ? entries : all, all };
  });
  const total = layerPlans.reduce((sum, plan) => sum + plan.entries.length, 0);
  const bank = {
    name, label: spec.label || name, continuous: Boolean(spec.continuous),
    oneShot: Boolean(spec.oneShot), fixedPitch: Boolean(spec.fixedPitch), layers: [],
    loadedMidis: new Set(),
    partial: layerPlans.some((plan) => plan.entries.length < plan.all.length),
  };
  for (const { layer, entries } of layerPlans) {
    const samples = [];
    const layerRms = [];
    const layerGainDb = [];
    // 并发加载 + 解码：以前是「一个样本一个 await」，真实钢琴 352 个样本要 7 秒；
    // decodeAudioData 本身在浏览器线程池里解码，串行等它纯属浪费，这里 12 路并发，
    // 实测第一次加载从约 7 秒降到 1–2 秒（试听点播放、导出前的音源准备都受益）。
    const decodedPerEntry = new Array(entries.length).fill(null);
    const CONCURRENCY = Math.min(16, Math.max(1, entries.length));
    let nextIndex = 0;
    let done = 0;
    const loadOne = async () => {
      while (nextIndex < entries.length) {
        const index = nextIndex;
        nextIndex += 1;
        const [midi, entry] = entries[index];
        try {
          const response = await fetch(SAMPLE_ROOT + entry.path);
          if (!response.ok) throw new Error("HTTP " + response.status);
          const decoded = await decode(await response.arrayBuffer());
          const sampleRate = decoded.sampleRate;
          const mono = downmixToMono(decoded);
          const buffer = buildPlayableBuffer(mono, sampleRate, {
            trimSeconds: spec.trimSeconds || 0,
            fadeOutSeconds: Number.isFinite(spec.fadeOutSeconds)
              ? spec.fadeOutSeconds
              : (spec.trimSeconds ? 0.3 : 0),
          });
          // FluidR3 对超出乐器音域的高音会渲染成整段静音：剔除，否则靠近它的音会没声音。
          const data = buffer.getChannelData(0);
          let energy = 0;
          let samplePeak = 0;
          for (let cursor = 0; cursor < data.length; cursor += 1) {
            energy += data[cursor] * data[cursor];
            samplePeak = Math.max(samplePeak, Math.abs(data[cursor]));
          }
          const rms = Math.sqrt(energy / Math.max(1, data.length));
          // 有些真实敲击录音本身电平很低（碰铃 RMS 约 0.0004）；保留它们，
          // 后续按 RMS 归一并用峰值限制控制动态，不能按持续音的静音门限剔除。
          if (rms >= (bank.oneShot ? 0.00001 : 0.0005)) {
            const sample = {
              midi,
              buffer,
              rms,
              peak: samplePeak,
              tune: Number(entry.tune) || 0,   // 样本本身的音准偏差（半音）
              gainDb: Number.isFinite(entry.gainDb) ? Number(entry.gainDb) : null,
            };
            if (bank.continuous) {
              // 持续音：优先用清单里给的循环点（SSO 的 SFZ 就有精确循环点），
              // 没有就按 bank 的 loopSeconds 找零交叉点。
              const monoData = buffer.getChannelData(0);
              if (Number.isFinite(entry.loopStart) && Number.isFinite(entry.loopEnd)) {
                const limit = buffer.duration - 0.02;
                const loopStart = Math.min(Math.max(0.02, Number(entry.loopStart)), limit - 0.1);
                const loopEnd = Math.min(Math.max(loopStart + 0.1, Number(entry.loopEnd)), limit);
                sample.loopStart = snapToZeroCrossing(monoData, sampleRate, loopStart);
                sample.loopEnd = snapToZeroCrossing(monoData, sampleRate, loopEnd);
              } else {
                const [startSeconds, endSeconds] = spec.loopSeconds || [1.0, 2.5];
                sample.loopStart = snapToZeroCrossing(monoData, sampleRate, Math.min(startSeconds, buffer.duration * 0.5));
                sample.loopEnd = snapToZeroCrossing(monoData, sampleRate, Math.min(endSeconds, buffer.duration - 0.05));
              }
              if (sample.loopEnd - sample.loopStart < 0.1) {
                sample.loopStart = buffer.duration * 0.3;
                sample.loopEnd = buffer.duration * 0.9;
              }
            }
            decodedPerEntry[index] = { sample, rms, gainDb: sample.gainDb };
          }
        } catch (error) {
          console.info("采样加载失败（已跳过）：" + entry.path, error);
        }
        done += 1;
        if (done % 8 === 0 || done === total) onProgress({ done, total });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => loadOne()));
    // 按音高顺序收拢（entries 已排序），保证 samples 数组仍然有序
    for (const item of decodedPerEntry) {
      if (!item) continue;
      layerRms.push(item.rms);
      if (Number.isFinite(item.gainDb)) layerGainDb.push(item.gainDb);
      samples.push(item.sample);
    }
    // 这一层样本的典型响度（中位数，避免个别极端样本带偏增益标定）
    const sortedRms = layerRms.slice().sort((a, b) => a - b);
    const medianRms = sortedRms.length ? sortedRms[Math.floor(sortedRms.length / 2)] : 0.01;
    const sortedGain = layerGainDb.slice().sort((a, b) => a - b);
    const medianGainDb = sortedGain.length ? sortedGain[Math.floor(sortedGain.length / 2)] : 0;
    // 每个样本的音量配平：
    //   · 清单里带 gainDb（SSO 合唱，SFZ 作者算好的相对音量）→ 用它，最贴近原意；
    //   · 否则按自身 RMS 做温和配平（0.8 次方：只压掉明显的电平差，保留音区差异）。
    for (const sample of samples) {
      if (sample.gainDb !== null) {
        sample.trim = Math.min(4, Math.max(0.25, dbToGain(sample.gainDb - medianGainDb)));
      } else {
        const ratio = medianRms / Math.max(0.0008, sample.rms || medianRms);
        sample.trim = Math.min(2.5, Math.max(0.4, ratio ** 0.8));
      }
    }
    for (const sample of samples) bank.loadedMidis.add(sample.midi);
    bank.layers.push({ velocity: layer.velocity, samples, medianRms });
  }
  // 整个 bank 的观测响度（全层样本 RMS 的中位数）。
  // 为什么需要：不同乐器的录音电平差可达 3–4 倍（实测钢琴峰值 0.25、二胡 0.069），
  // 固定增益表抹不平；播放时用它把每个 bank 归一到同一响度，
  // 这样用户切换乐器不会「钢琴很响、二胡几乎听不见」。
  const allRms = [];
  for (const layer of bank.layers) {
    for (const sample of layer.samples) if (sample.rms) allRms.push(sample.rms);
  }
  allRms.sort((left, right) => left - right);
  const observedRms = allRms.length ? allRms[Math.floor(allRms.length / 2)] : 0.01;
  bank.observedRms = Math.max(bank.oneShot ? 0.00001 : 0.0008, observedRms);
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
  // 样本自己的音准偏差（tune，单位半音）也要算进去，否则整体会偏高/偏低几十音分。
  return {
    sample,
    layer,
    playbackRate: bank.fixedPitch ? 1 : playbackRateFor(midi, sample.midi + (sample.tune || 0)),
  };
}
