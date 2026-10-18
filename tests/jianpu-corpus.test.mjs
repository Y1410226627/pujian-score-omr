/**
 * 简谱识别的「回归语料 + 识谱自检」护栏。
 *
 * 为什么需要：
 *   1. 项目原来只有《敕勒歌》p11 一页经过人工核对。换一份谱（不同字体、英文声部标签、
 *      引子括号、三连音记号）时，识别结果会出现**系统性 ±0.5 拍**的偏差——这类问题
 *      单看音符数看不出来，必须靠「每小节拍数是否等于拍号」的自检才能暴露。
 *   2. 自检（jianpu.py 的 check_measure_lengths）是准确率兜底：识别错音绝大多数会表现成
 *      某小节拍数对不上。它必须既能抓住真错误，又**不能把乐理上合法的短小节当成错误**
 *      （弱起小节、最后一小节、只含休止的整小节）——否则用户会被一堆假警告淹没。
 *
 * 本测试分两层：
 *   ① 快照层（不需要 Python）：`jianpu_corpus.json` 的字段自洽、参考页的既有结论没被改写。
 *   ② 实跑层（需要项目 `.venv` + opencv）：
 *      · 自检纯函数的正反例（弱起/末小节/休止小节必须放过）；
 *      · 已提交的《敕勒歌》p11 两种渲染尺寸，逐项与快照比对（含 selfCheck）；
 *      · 若设置了 PUJIAN_CORPUS_DIR（含《从前慢》渲染好的 p01–p04），逐项比对。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const corpus = JSON.parse(readFileSync(path.join(HERE, "fixtures", "jianpu_corpus.json"), "utf8"));

const python = path.join(ROOT, ".venv", "Scripts", "python.exe");
const engine = path.join(ROOT, "jianpu.py");
const canRunEngine = process.platform === "win32" && existsSync(python) && existsSync(engine);
const corpusDir = process.env.PUJIAN_CORPUS_DIR || "";
const pageFiles = {
  chilele_p11_reference: path.join(HERE, "fixtures", "jianpu_pages", "_source__p11_3x.png"),
  chilele_p11_reference_2600: path.join(HERE, "fixtures", "jianpu_pages", "_source__p11_2600.png"),
};
for (const page of ["p01", "p02", "p03", "p04"]) {
  pageFiles[`congqianman_${page}`] = corpusDir ? path.join(corpusDir, `从前慢_${page}_2600.png`) : "";
}

/** 调 jianpu.py 识别一页（需要 .venv 里的 opencv）。 */
function recognize(file) {
  const stdout = execFileSync(python, [engine, file, "--do", "65", "--beats", "4"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** 只比较「改了就应该被抓住」的字段。 */
function summarize(payload) {
  const parts = payload.parts || [];
  return {
    notes: parts.reduce((sum, part) => sum + (part.notes || []).length, 0),
    partCounts: parts.map((part) => (part.notes || []).length),
    measureCount: payload.measureCount,
    beatsPerMeasure: payload.beatsPerMeasure,
    selfCheck: payload.selfCheck,
  };
}

test("语料快照：结构自洽，参考页结论与基线一致", () => {
  assert.ok(corpus.pages && Object.keys(corpus.pages).length >= 2, "语料快照缺少页面");
  assert.deepEqual(corpus.options, { do: 65, beats: 4 });
  for (const [key, page] of Object.entries(corpus.pages)) {
    assert.ok(page.notes > 0, `${key} 没有音符`);
    assert.ok(Array.isArray(page.partCounts) && page.partCounts.length > 0, `${key} 没有声部`);
    assert.equal(page.partCounts.reduce((sum, value) => sum + value, 0), page.notes,
      `${key} 的声部音符数之和应等于总音符数`);
    assert.ok(page.measureCount > 0, `${key} 没有小节`);
    assert.ok(page.selfCheck && Array.isArray(page.selfCheck.issues), `${key} 缺少识谱自检结果`);
    for (const issue of page.selfCheck.issues) {
      assert.ok(["over", "short"].includes(issue.kind), `${key} 自检问题类型不合法`);
      assert.ok(issue.measure >= 1 && issue.actual > 0 && issue.expected > 0);
    }
  }
  // 《敕勒歌》p11 是唯一人工逐小节核对过的基准：119 个音符、4 个声部、12 小节。
  const reference = corpus.pages.chilele_p11_reference;
  assert.equal(reference.notes, 119);
  assert.deepEqual(reference.partCounts, [33, 24, 51, 11]);
  assert.equal(reference.measureCount, 12);
  // 已知歧义（谱面 m10/m12 印刷毛刺）：如实记录为「待人工核对」，不许被悄悄"修掉"。
  assert.deepEqual(reference.selfCheck.issues.map((issue) => issue.measure), [10, 12]);
});

test("识谱自检纯函数：抓住真错误，放过乐理上合法的短小节", { skip: !canRunEngine }, () => {
  const script = `
import json, sys
sys.path.insert(0, r"${ROOT}")
from jianpu import check_measure_lengths
cases = [
    {"name": "全部满拍", "measure": {0: 4.0, 1: 4.0, 2: 4.0}, "beats": 4.0, "pickup": False, "notes": None},
    {"name": "中间缺拍且有音符", "measure": {0: 4.0, 1: 3.0, 2: 4.0}, "beats": 4.0, "pickup": False, "notes": {0: 4, 1: 5, 2: 4}},
    {"name": "中间缺拍但只有休止", "measure": {0: 4.0, 1: 1.0, 2: 4.0}, "beats": 4.0, "pickup": False, "notes": {0: 4, 1: 0, 2: 4}},
    {"name": "中间多拍", "measure": {0: 4.0, 1: 5.0, 2: 4.0}, "beats": 4.0, "pickup": False, "notes": None},
    {"name": "末小节不满", "measure": {0: 4.0, 1: 4.0, 2: 2.0}, "beats": 4.0, "pickup": False, "notes": None},
    {"name": "弱起首小节不满", "measure": {0: 1.0, 1: 4.0, 2: 4.0}, "beats": 4.0, "pickup": True, "notes": None},
    {"name": "非弱起首小节不满", "measure": {0: 1.0, 1: 4.0, 2: 4.0}, "beats": 4.0, "pickup": False, "notes": {0: 2, 1: 4, 2: 4}},
]
print(json.dumps([{"name": case["name"], "result": check_measure_lengths(
    case["measure"], case["beats"], case["pickup"], case["notes"])} for case in cases], ensure_ascii=False))
`;
  const output = execFileSync(python, ["-c", script], { cwd: ROOT, encoding: "utf8" });
  const results = Object.fromEntries(JSON.parse(output).map((item) => [item.name, item.result]));
  const issuesOf = (name) => results[name].issues.map((issue) => issue.measure);

  assert.equal(results["全部满拍"].ok, true, "每小节都满拍时自检必须通过");
  assert.deepEqual(issuesOf("中间缺拍且有音符"), [2], "有音符却不足拍号的小节必须报出来");
  assert.equal(results["中间缺拍但只有休止"].ok, true, "只含休止的短小节补满拍号是正确的，不算错误");
  assert.deepEqual(issuesOf("中间多拍"), [2], "超出拍号的小节必须报出来");
  assert.equal(results["末小节不满"].ok, true, "最后一小节不满可能是换页/结尾，不算错误");
  assert.equal(results["弱起首小节不满"].ok, true, "弱起小节本来就短，不算错误");
  assert.deepEqual(issuesOf("非弱起首小节不满"), [1], "非弱起的首小节不满要报出来");
  for (const [name, result] of Object.entries(results)) {
    for (const issue of result.issues) {
      assert.ok(issue.actual > 0 && issue.expected > 0, name + " 的拍数应为正数");
    }
  }
});

/** 实跑一页并与快照逐项比对。 */
function assertPageMatches(key) {
  const file = pageFiles[key];
  if (!file || !existsSync(file)) return false;
  const expected = corpus.pages[key];
  const actual = summarize(recognize(file));
  assert.equal(actual.notes, expected.notes, `${key} 音符数变了（${expected.notes} → ${actual.notes}）`);
  assert.deepEqual(actual.partCounts, expected.partCounts, `${key} 各声部音符数变了`);
  assert.equal(actual.measureCount, expected.measureCount, `${key} 小节数变了`);
  assert.equal(actual.beatsPerMeasure, expected.beatsPerMeasure);
  assert.deepEqual(actual.selfCheck, expected.selfCheck,
    `${key} 的识谱自检结论变了（改对了就更新快照，别让它悄悄变化）`);
  return true;
}

test("实跑：《敕勒歌》p11 两种渲染尺寸都与语料快照一致", { skip: !canRunEngine }, () => {
  for (const key of ["chilele_p11_reference", "chilele_p11_reference_2600"]) {
    assert.ok(assertPageMatches(key), `${key} 的页面图缺失`);
  }
});

test("实跑：《从前慢》4 页与语料快照一致（需 PUJIAN_CORPUS_DIR）", { skip: !canRunEngine }, () => {
  const keys = ["congqianman_p01", "congqianman_p02", "congqianman_p03", "congqianman_p04"];
  const available = keys.filter((key) => pageFiles[key] && existsSync(pageFiles[key]));
  if (!available.length) {
    console.log("跳过《从前慢》实跑：未设置 PUJIAN_CORPUS_DIR 或目录里没有渲染好的页面。");
    return;
  }
  for (const key of available) assert.ok(assertPageMatches(key), `${key} 比对失败`);
});

test("批量模式：一次识别多页，结果与逐页完全一致", { skip: !canRunEngine }, () => {
  // 整本识别接口就是靠这个批量模式省掉每页一次的 Python 启动 + 模板渲染开销。
  // 这里守两件事：① 多页顺序不能乱；② 批量结果必须和逐页逐字一样（不许为了快而改结果）。
  const files = [pageFiles.chilele_p11_reference, pageFiles.chilele_p11_reference_2600];
  for (const file of files) assert.ok(existsSync(file), "批量模式测试缺少页面图");
  const stdout = execFileSync(python,
    [engine, ...files, "--batch", "--do", "65", "--beats", "4"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const payload = JSON.parse(stdout);
  assert.ok(Array.isArray(payload.pages), "批量模式应返回 pages 数组");
  assert.equal(payload.pages.length, files.length, "批量模式返回的页数应与输入一致");
  files.forEach((file, index) => {
    assert.deepEqual(payload.pages[index], recognize(file), `第 ${index + 1} 页的批量结果与逐页不一致`);
  });
});

