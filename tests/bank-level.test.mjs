import assert from "node:assert/strict";
import test from "node:test";

import { SAMPLED_TIMBRES } from "../soundbanks.js";

// 从 app.js 里取出 BANK_LEVEL 表（它是模块内 const，不能直接 import；
// 测试用同样的文件解析出来，确保标定覆盖到每种音源）。
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const match = /const BANK_LEVEL = \{([\s\S]*?)\n\};/.exec(appSource);
assert.ok(match, "app.js 里应能找到 BANK_LEVEL 表");
const entries = [...match[1].matchAll(/(\w+):\s*([\d.]+)/g)].map((item) => [item[1], Number(item[2])]);
const BANK_LEVEL = Object.fromEntries(entries);

test("每个采样音源都有响度配平系数", () => {
  const missing = Object.keys(SAMPLED_TIMBRES).filter((name) => !(name in BANK_LEVEL));
  assert.deepEqual(missing, [], `这些音源没有配平系数：${missing.join(", ")}`);
  assert.ok(entries.length >= 67, `应有 67 种以上音源，实际 ${entries.length}`);
});

test("配平系数在安全范围内（不削波、不静音）", () => {
  // 说明：这套上下限对应的是「按浏览器实测 RMS 归一化」的机制。
  // 样本录音电平差异很大（Meta Nylon 只有钢琴的 1/3.6），
  // 轻样本需要更大系数补偿，重样本需要更小系数压低。
  // 峰值安全由 masterChain 的 tanh 软限幅兜底（见 app.js softClipCurve），
  // 所以这里只挡住「明显异常」的值：小于 0.2 会静音，大于 4.5 会被限幅器染色。
  for (const [name, level] of entries) {
    const maximum = SAMPLED_TIMBRES[name]?.oneShot ? 4.5 : 3;
    assert.ok(level >= 0.2 && level <= maximum,
      `${name} 的配平系数 ${level} 超出安全范围 0.2–${maximum}`);
  }
});

test("钢琴压低、民乐抬高（实测：钢琴峰值 0.25 偏响、二胡 0.069 偏轻）", () => {
  assert.ok(BANK_LEVEL.piano_real < 1, `真实钢琴偏响应压低，当前 ${BANK_LEVEL.piano_real}`);
  for (const bank of ["erhu_real", "pipa_real", "guzheng_real", "dizi_real", "yangqin_real"]) {
    assert.ok(BANK_LEVEL[bank] > 1.2,
      `${bank} 是民族乐器（采样偏轻）应抬高，当前 ${BANK_LEVEL[bank]}`);
  }
  // 抬升后各乐器响度接近：差距不超过 2.5 倍（人耳约 1.5 倍即明显）
  // 单次打击采样按各自的真实录音电平和峰值另行标定；这里比较持续/旋律音源。
  const levels = entries.filter(([name]) => !name.startsWith("piano_real") && !SAMPLED_TIMBRES[name]?.oneShot)
    .map(([, level]) => level);
  const spread = Math.max(...levels) / Math.min(...levels);
  assert.ok(spread <= 2.5, `乐器间响度差距 ${spread.toFixed(2)} 倍，仍会听出明显不均衡`);
});

test("调整幅度温和：不会把某个乐器变成另一种音色", () => {
  // 新机制下系数补偿的是「样本录音电平」，轻样本天然需要更大系数。
  // 真正的「变声」风险来自过度放大后的失真，而这一点由软限幅器控制
  // （峰值压到 0.85 以内，实测各音色峰值 0.18–0.41）。
  // 这里只挡掉明显失控的调整：超过 4.5 倍或低于 0.2 倍。
  const extreme = entries.filter(([name, level]) => !SAMPLED_TIMBRES[name]?.oneShot
    && (level > 3 || level < 0.2));
  assert.deepEqual(extreme, [], `这些音源配平过度：${extreme.join(", ")}`);
});
