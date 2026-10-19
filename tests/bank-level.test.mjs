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
  for (const [name, level] of entries) {
    assert.ok(level >= 0.5 && level <= 2.2,
      `${name} 的配平系数 ${level} 超出 0.5–2.2（会削波或几乎听不见）`);
  }
});

test("钢琴压低、民乐抬高（实测：钢琴峰值 0.25 偏响、二胡 0.069 偏轻）", () => {
  assert.ok(BANK_LEVEL.piano_real < 1, `真实钢琴偏响应压低，当前 ${BANK_LEVEL.piano_real}`);
  for (const bank of ["erhu_real", "pipa_real", "guzheng_real", "dizi_real", "yangqin_real"]) {
    assert.ok(BANK_LEVEL[bank] > 1.2,
      `${bank} 是民族乐器（采样偏轻）应抬高，当前 ${BANK_LEVEL[bank]}`);
  }
  // 抬升后各乐器响度接近：差距不超过 2.5 倍（人耳约 1.5 倍即明显）
  const levels = entries.filter(([name]) => !name.startsWith("piano_real")).map(([, level]) => level);
  const spread = Math.max(...levels) / Math.min(...levels);
  assert.ok(spread <= 2.5, `乐器间响度差距 ${spread.toFixed(2)} 倍，仍会听出明显不均衡`);
});

test("调整幅度温和：不会把某个乐器变成另一种音色", () => {
  // 超过 2 倍会被听成「同一乐器不同录音」，丧失原有质感
  const extreme = entries.filter(([, level]) => level > 2 || level < 0.55);
  assert.deepEqual(extreme, [], `这些音源配平过度：${extreme.join(", ")}`);
});
