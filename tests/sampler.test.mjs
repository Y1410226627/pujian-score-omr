import assert from "node:assert/strict";
import test from "node:test";

import {
  SAMPLED_TARGET_RMS, SAMPLED_TIMBRES, SAMPLE_MANIFEST_URL, SAMPLE_ROOT,
  isSampledTimbre, lookupSample, nearestSampleIndex, playbackRateFor, pickLayerIndex, snapToZeroCrossing,
} from "../sampler.js";

// 这些是「采样音源」的纯映射逻辑：不需要浏览器就能验证对错。
// 真正的 wav/mp3 解码与发声由 tests/e2e-audio.mjs 在浏览器里验证（装了音源才会跑）。

const CHOIR_BANKS = new Set(["choir_female", "choir_male", "choir_real"]);

test("采样音色名单：覆盖钢琴/弦乐细分/人声/管乐，都有合成音色兜底", () => {
  const keys = Object.keys(SAMPLED_TIMBRES);
  assert.ok(keys.length >= 20, "采样音色至少要 20 种（现有 " + keys.length + " 种）");
  for (const name of keys) {
    assert.ok(name.endsWith("_real") || CHOIR_BANKS.has(name), name + " 命名不符合约定");
    assert.equal(isSampledTimbre(name), true);
    const spec = SAMPLED_TIMBRES[name];
    assert.equal(typeof spec.fallback, "string", name + " 缺少兜底合成音色");
    assert.equal(typeof spec.continuous, "boolean", name + " 缺少 continuous 标记");
  }
  // 细分乐器必须真的存在（用户要求：弦乐可细分、乐器不局限于钢琴）
  for (const name of ["violin_real", "viola_real", "cello_real", "contrabass_real",
    "pizzicato_real", "tremolo_real", "flute_real", "clarinet_real", "trumpet_real",
    "choir_female", "choir_male", "church_organ_real", "harpsichord_real"]) {
    assert.ok(SAMPLED_TIMBRES[name], "缺少采样音色：" + name);
  }
  // 合成音色不能被误判成采样音色
  for (const name of ["piano", "strings", "choir", "choir_female_synth", "organ", "soft"]) {
    assert.equal(isSampledTimbre(name), false, name + " 不是采样音色");
  }
  assert.equal(isSampledTimbre("nope"), false);
});

test("清单/样本路径：都在 .assets/soundfonts/ 下（与 serve.py 的放行规则一致）", () => {
  assert.equal(SAMPLE_MANIFEST_URL, ".assets/soundfonts/manifest.json");
  assert.equal(SAMPLE_ROOT, ".assets/soundfonts/");
  assert.ok(SAMPLED_TARGET_RMS > 0.1 && SAMPLED_TARGET_RMS < 0.5, "标定用的目标 RMS 应在合理范围");
});

test("最近采样：升序表里找最接近的音；空表返回 -1", () => {
  const samples = [21, 24, 27, 30, 33].map((midi) => ({ midi }));
  assert.equal(nearestSampleIndex(samples, 21), 0);
  assert.equal(nearestSampleIndex(samples, 22), 0, "比 A0 高 1 个半音仍用 A0");
  assert.equal(nearestSampleIndex(samples, 25), 1, "C1(24) 与 D#1(27) 之间，25 更近 C1");
  assert.equal(nearestSampleIndex(samples, 26), 2, "26 更近 D#1(27)");
  assert.equal(nearestSampleIndex(samples, 100), 4, "超出音域时用最高的样本");
  assert.equal(nearestSampleIndex([], 60), -1);
  assert.equal(nearestSampleIndex(null, 60), -1);
});

test("变速比：同音=1，高八度=2，低八度=0.5，半音=2^(1/12)", () => {
  assert.equal(playbackRateFor(60, 60), 1);
  assert.equal(playbackRateFor(72, 60), 2);
  assert.equal(playbackRateFor(48, 60), 0.5);
  assert.ok(Math.abs(playbackRateFor(61, 60) - 2 ** (1 / 12)) < 1e-12);
  assert.ok(playbackRateFor(61, 60) < 1.07);
});

test("力度层：挑最接近的一层，边界情况有确定行为", () => {
  const layers = [{ velocity: 0.25 }, { velocity: 0.85 }];
  assert.equal(pickLayerIndex(layers, 0), 0, "pp 用轻层");
  assert.equal(pickLayerIndex(layers, 0.3), 0);
  assert.equal(pickLayerIndex(layers, 0.6), 1, "中强以上用重层");
  assert.equal(pickLayerIndex(layers, 1), 1, "ff 用重层");
  assert.equal(pickLayerIndex([], 0.5), 0, "空层表返回 0，不崩");
  assert.equal(pickLayerIndex(null, 0.5), 0);
});

test("样本音准偏差（tune）：查表时要把样本自身的音分偏差算进变速比", () => {
  const bank = {
    continuous: false,
    layers: [{
      velocity: 0.8,
      samples: [{ midi: 67, buffer: null, tune: 0.16 }, { midi: 70, buffer: null, tune: 0 }],
    }],
  };
  const found = lookupSample(bank, 67, 0.8);
  assert.ok(found, "应当能查到样本");
  assert.ok(found.playbackRate < 1 && found.playbackRate > 0.99,
    "tune=+0.16 半音的样本，播放比应略小于 1（实测 " + found.playbackRate + "）");
  const exact = lookupSample(bank, 70, 0.8);
  assert.equal(exact.playbackRate, 1, "无偏差的样本同音播放比应为 1");
  assert.equal(lookupSample({ continuous: false, layers: [] }, 60, 0.5), null);
});

test("循环点吸附：在目标时间附近找到向上过零点", () => {
  const rate = 24000;
  const data = new Float32Array(rate * 3);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.sin((2 * Math.PI * 100 * index) / rate);
  const snapped = snapToZeroCrossing(data, rate, 1.0);
  assert.ok(Math.abs(snapped - 1.0) <= 0.01, "吸附误差应在一个周期内（实测 " + snapped + "）");
  const index = Math.round(snapped * rate);
  if (index > 0 && index < data.length) {
    assert.ok(data[index - 1] <= 0 && data[index] > 0, "吸附点必须是向上过零点");
  }
  assert.equal(snapToZeroCrossing(new Float32Array(100), rate, 0.001) >= 0, true);
  assert.equal(snapToZeroCrossing(null, rate, 1), 1);
  assert.equal(snapToZeroCrossing(data, 0, 1), 1, "采样率无效时原样返回");
});
