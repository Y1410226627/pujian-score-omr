import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  SAMPLED_TIMBRES, SAMPLE_CATEGORIES, CATEGORY_LABELS, categoryOf, groupBanksByCategory,
  fallbackTimbre, isContinuousBank, isInstalledBank, listBankNames,
} from "../soundbanks.js";

const manifest = JSON.parse(readFileSync(new URL("./fixtures/manifest_v3.json", import.meta.url), "utf8"));

test("乐器库覆盖 60 种以上采样音源，且民乐至少 8 种", () => {
  const names = Object.keys(SAMPLED_TIMBRES);
  assert.ok(names.length >= 60, `采样音源只有 ${names.length} 种`);
  const china = names.filter((name) => SAMPLED_TIMBRES[name].category === "china");
  assert.ok(china.length >= 8, `民乐只有 ${china.length} 种`);
});

test("每种音源都有合法的兜底合成音色与分类", () => {
  const synth = new Set(["piano", "strings", "choir", "organ", "soft"]);
  for (const [bank, meta] of Object.entries(SAMPLED_TIMBRES)) {
    assert.ok(synth.has(meta.fallback), `${bank} 的兜底音色 ${meta.fallback} 不合法`);
    assert.ok(CATEGORY_LABELS[meta.category], `${bank} 的分类 ${meta.category} 不在分类表里`);
    assert.equal(typeof meta.continuous, "boolean", `${bank} 缺 continuous`);
  }
});

test("分类表里每一类都有对应的显示名，且顺序稳定", () => {
  assert.ok(SAMPLE_CATEGORIES.length >= 10);
  for (const item of SAMPLE_CATEGORIES) {
    assert.ok(item.key && item.label);
    assert.equal(CATEGORY_LABELS[item.key], item.label);
  }
  assert.equal(SAMPLE_CATEGORIES[0].key, "china", "民乐排在最前面");
});

test("清单缺 category 时按音源名推断分类（旧清单兼容）", () => {
  assert.equal(categoryOf("flute_real", {}), "winds");
  assert.equal(categoryOf("choir_female", {}), "voice");
  assert.equal(categoryOf("violin_legacy", {}), "strings");
  assert.equal(categoryOf("pipa", {}), "plucked");
  assert.equal(categoryOf("erhu", {}), "china");
  assert.equal(categoryOf("unknown_thing", {}), "world");
});

test("按分类分组：已安装的才列出，未安装可选列出", () => {
  const groups = groupBanksByCategory(manifest);
  assert.ok(groups.length >= 1);
  const china = groups.find((group) => group.category === "china");
  assert.ok(china, "清单含二胡，应出现民乐分组");
  assert.equal(china.label, "中国民族乐器");
  assert.deepEqual(china.banks.map((item) => item.bank).sort(), ["erhu_real", "pipa_real"]);

  const withMissing = groupBanksByCategory(manifest, { includeMissing: true, labels: { guzheng_real: "古筝（采样）" } });
  const chinaAll = withMissing.find((group) => group.category === "china");
  assert.ok(chinaAll.banks.some((item) => item.bank === "guzheng_real" && item.installed === false));
  assert.ok(chinaAll.banks.some((item) => item.bank === "erhu_real" && item.installed === true));
});

test("没装音源时的兜底音色、循环标记、安装判断", () => {
  assert.equal(fallbackTimbre("erhu_real"), "strings");
  assert.equal(fallbackTimbre("unknown_bank"), "piano");
  assert.equal(fallbackTimbre("pipa_real", { fallback: "soft" }), "soft");
  assert.equal(isContinuousBank("erhu_real"), true);
  assert.equal(isContinuousBank("pipa_real"), false);
  assert.equal(isContinuousBank("pipa_real", { continuous: true }), true);
  assert.equal(isInstalledBank(manifest, "erhu_real"), true);
  assert.equal(isInstalledBank(manifest, "guzheng_real"), false);
  assert.equal(isInstalledBank(null, "erhu_real"), false);
  assert.deepEqual(listBankNames(manifest), ["erhu_real", "piano_real", "pipa_real"]);
});
