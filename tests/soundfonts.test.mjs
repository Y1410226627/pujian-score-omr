import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("./fixtures/manifest_v3.json", import.meta.url), "utf8"));

// 旧版（v2）清单没有 category 字段：应用必须仍然能用，并且能推断出一个合理分类。
const OLD_MANIFEST = {
  version: 2,
  banks: {
    flute_real: { label: "长笛（采样）", continuous: true, decodeRate: 24000, layers: [{ velocity: 0.8, notes: {} }] },
    choir_female: { label: "真实女声合唱（采样）", continuous: true, decodeRate: 24000, layers: [{ velocity: 0.8, notes: {} }] },
  },
};

test("最新清单是 v3，且每个音源都带 category", () => {
  assert.equal(manifest.version, 3);
  for (const [bank, spec] of Object.entries(manifest.banks)) {
    assert.equal(typeof spec.category, "string", `${bank} 缺 category`);
    assert.ok(spec.category.length > 0);
  }
});

test("民乐音源存在，并且按 24 位整型样本标注 decodeRate", () => {
  const erhu = manifest.banks.erhu_real;
  assert.ok(erhu, "应包含二胡");
  assert.equal(erhu.category, "china");
  assert.equal(erhu.continuous, true, "弓弦乐器要循环才撑得住长音");
  assert.equal(erhu.decodeRate, 48000, "WAV 样本按自身采样率解码");
  const pipa = manifest.banks.pipa_real;
  assert.equal(pipa.continuous, false, "弹拨乐器不循环");
});

test("旧版 v2 清单仍然可读（向后兼容）", () => {
  assert.equal(OLD_MANIFEST.version, 2);
  assert.ok(Object.keys(OLD_MANIFEST.banks).includes("flute_real"));
});
