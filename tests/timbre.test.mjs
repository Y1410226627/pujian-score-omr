import assert from "node:assert/strict";
import test from "node:test";

import {
  TIMBRE_LABELS, TIMBRE_ORDER, PIANO_HARMONICS, ORGAN_HARMONICS, VOWELS, VOWEL_ORDER,
  VIBRATO, REVERB, COMPRESSOR, HUMANIZE, CHOIR_ENVELOPE, ORGAN_ENVELOPE,
  vowelForPart, pianoDamperSeconds, pianoBrightness, pianoDecayShape, harmonicSeries,
} from "../timbre.js";

// 这些声音参数是「乐理 / 声学常识」，可以脱离浏览器直接验证：
// 泛音必须递减、共振峰必须 F1<F2<F3、低音制音必须比高音慢……
// 真正的发声（Oscillator/BiquadFilter）由端到端脚本验证，见 tests/e2e-audio.mjs。

test("音色名单：四种音色都有中文名，顺序稳定", () => {
  assert.deepEqual(TIMBRE_ORDER, ["piano", "choir", "organ", "soft"]);
  for (const name of TIMBRE_ORDER) assert.equal(typeof TIMBRE_LABELS[name], "string");
  assert.equal(TIMBRE_LABELS.piano, "钢琴");
  assert.equal(TIMBRE_LABELS.choir, "合唱人声");
});

test("钢琴泛音表：单调递减、基音最响、高次泛音被压掉", () => {
  assert.ok(PIANO_HARMONICS.length >= 8, "钢琴至少要有 8 个泛音才不至于像纯音");
  assert.equal(PIANO_HARMONICS[0], 1, "基音（第 1 泛音）强度应为 1");
  for (let index = 1; index < PIANO_HARMONICS.length; index += 1) {
    assert.ok(PIANO_HARMONICS[index] < PIANO_HARMONICS[index - 1], "泛音强度必须逐次递减");
  }
  // 第 7 次泛音之后额外压到 0.7 倍：能量应该明显低于纯 1/n^1.35 的延续。
  const expected7 = 1 / (7 ** 1.35);
  assert.ok(PIANO_HARMONICS[6] < expected7, "第 7 泛音要被额外压低，避免金属味");
});

test("管风琴泛音表：八度/五度音栓层层减弱", () => {
  assert.equal(ORGAN_HARMONICS[0], 1);
  assert.ok(ORGAN_HARMONICS[1] > 0.3, "第 2 泛音（高八度）要够响，这是管风琴的标志");
  assert.ok(ORGAN_HARMONICS[2] > 0.2, "第 3 泛音（八度+五度）也要能听见");
  for (let index = 1; index < ORGAN_HARMONICS.length; index += 1) {
    assert.ok(ORGAN_HARMONICS[index] < ORGAN_HARMONICS[index - 1]);
  }
});

test("元音共振峰：F1<F2<F3，全部落在人声频率范围内", () => {
  for (const [name, formants] of Object.entries(VOWELS)) {
    assert.equal(formants.length, 3, name + " 应该有 3 个共振峰");
    const [f1, f2, f3] = formants.map((entry) => entry[0]);
    assert.ok(f1 < f2 && f2 < f3, name + " 的共振峰必须从低到高排列");
    assert.ok(f1 >= 200 && f3 <= 3200, name + " 的共振峰应落在 200–3200 Hz（人声范围）");
    for (const [frequency, strength, bandwidth] of formants) {
      assert.ok(frequency > 0 && strength > 0 && strength <= 1, name + " 强度需在 0–1");
      assert.ok(bandwidth > 0, name + " 带宽必须为正");
    }
  }
  // 「啊」是最通用的合唱元音：第一共振峰应该在 700–900 Hz。
  assert.ok(VOWELS.a[0][0] >= 700 && VOWELS.a[0][0] <= 900);
});

test("声部→元音：稳定可重复，且不同声部会分到不同元音", () => {
  assert.equal(vowelForPart("S1"), vowelForPart("S1"), "同一份乐谱每次播放必须一样");
  const used = new Set(["女高", "女低", "男高", "男低", "P1", "P2", "P3", "P4"].map((key) => vowelForPart(key)));
  assert.ok(used.size >= 2, "至少要能分到两种元音，合唱才不像一个人叠几遍");
  for (const vowel of used) assert.ok(VOWEL_ORDER.includes(vowel));
  assert.ok(VOWEL_ORDER.length === 4 && used.size <= VOWEL_ORDER.length);
});

test("钢琴制音：音越高制音越快，且总在 0.08–0.44 秒内", () => {
  const low = pianoDamperSeconds(36);
  const middle = pianoDamperSeconds(60);
  const high = pianoDamperSeconds(88);
  assert.ok(low > middle && middle > high, "低音制音慢、高音制音快");
  for (const midi of [21, 36, 60, 88, 108]) {
    const seconds = pianoDamperSeconds(midi);
    assert.ok(seconds >= 0.08 && seconds <= 0.44, "制音时间应在 0.08–0.44 秒");
  }
});

test("钢琴亮度包络：起音比余音亮，且不会超过采样率允许的范围", () => {
  const low = pianoBrightness(261.63, 0.16);
  assert.ok(low.start > low.end, "起音的低通截止必须高于余音（先亮后暗）");
  assert.ok(low.end >= 220, "余音不能被收得比低音基频还低");
  const loud = pianoBrightness(261.63, 0.28);
  const soft = pianoBrightness(261.63, 0.08);
  assert.ok(loud.start > soft.start, "力度越大起音越亮");
});

test("钢琴两段衰减：先快后慢，最后落在 20% 左右", () => {
  const shape = pianoDecayShape(0.2);
  assert.equal(shape.length, 3);
  assert.ok(shape[0].at < shape[1].at && shape[1].at < shape[2].at, "三段的时间必须递增");
  assert.ok(shape[0].level > shape[1].level && shape[1].level > shape[2].level, "电平必须逐段下降");
  assert.ok(Math.abs(shape[2].level - 0.2 * 0.2) < 0.01, "长音最后应保持在峰值的 20% 附近");
  // 用极小力度也不能出现 0（Web Audio 的指数斜坡目标不能是 0）。
  assert.ok(pianoDecayShape(0.001).every((point) => point.level > 0));
});

test("人声/管风琴包络：起音明显比钢琴慢，释放留有余音", () => {
  assert.ok(CHOIR_ENVELOPE.attack >= 0.05, "人声起音要慢于钢琴的 6 ms，否则连唱会「哒哒」响");
  assert.ok(CHOIR_ENVELOPE.release >= 0.1, "人声释放要有余音");
  assert.ok(CHOIR_ENVELOPE.sustain > CHOIR_ENVELOPE.hold, "保持段电平应高于松开的瞬间");
  assert.ok(ORGAN_ENVELOPE.attack > 0 && ORGAN_ENVELOPE.release > 0);
});

test("效果器参数：颤音/混响/压限都在合理范围", () => {
  assert.ok(VIBRATO.rate >= 4 && VIBRATO.rate <= 7, "人声颤音约 5–6 Hz");
  assert.ok(VIBRATO.cents >= 5 && VIBRATO.cents <= 25, "颤音深度约 5–25 音分");
  assert.ok(REVERB.seconds >= 0.8 && REVERB.seconds <= 3.5);
  assert.ok(REVERB.wet > 0 && REVERB.wet < 0.5, "混响不能盖过干声");
  assert.ok(REVERB.preDelay >= 0 && REVERB.preDelay < 0.05);
  assert.ok(COMPRESSOR.threshold < 0 && COMPRESSOR.ratio >= 1, "压限器阈值应为负 dB");
  assert.ok(HUMANIZE.offset > 0 && HUMANIZE.offset < 0.05, "时点抖动控制在几十毫秒内");
  assert.ok(HUMANIZE.detune > 0 && HUMANIZE.detune < 20);
});

test("泛音生成器：符合 1/n^exponent 的衰减规律", () => {
  const series = harmonicSeries(4, 1);
  assert.deepEqual(series.map((value) => Number(value.toFixed(4))), [1, 0.5, 0.3333, 0.25]);
  assert.equal(harmonicSeries(0).length, 1, "至少留一个泛音，避免空波表");
});
