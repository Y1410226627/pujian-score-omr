/**
 * 双尺寸护栏：同一份简谱页面，在两种渲染尺寸下都不能比已核对的基线差。
 *
 * 为什么需要它（2026-10-18 接手时的实测）：
 *   `jianpu.py` 的时值判定里有一批**绝对像素常数**（横线高度 `h<=6`、减量 `box[3]-3`、
 *   延长号 ±9px、字高 16..32）。同一页在 3× 渲染（1785×2523）下能到 100%，
 *   但**应用真正渲染的尺寸**（长边 2600px ≈3.8×，见 app.js: renderPdfPage）
 *   下只有 94.7% 端到端。**只守一种尺寸，改一处就会在另一处崩**。
 *
 * 本测试分两层：
 *   ① 快照层（不需要 Python）：`chilele_p11_jianpu.pages.json` 记录两种尺寸下**已核对过**的输出，
 *      断言音符数 / 声部 / 小节与 ground-truth 一致，且指标不低于已知水位。
 *   ② 实跑层（需要项目 `.venv`，有 opencv）：现场调用 `jianpu.py` 识别两种尺寸的页面图，
 *      再比对指标水位。这一步会在没有 .venv 的机器上自动跳过，但**在本机必须通过**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { compareScore, validateGroundTruth } from "./benchmark.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const snapshotPath = path.join(HERE, "fixtures", "chilele_p11_jianpu.pages.json");
const groundTruthPath = path.join(HERE, "fixtures", "chilele_p11_jianpu.ground-truth.json");
const PAGES = path.join(HERE, "fixtures", "jianpu_pages");

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const groundTruth = JSON.parse(readFileSync(groundTruthPath, "utf8"));

/**
 * 每种渲染尺寸的「已知水位」（来自交接时的实测，只许升不许降）。
 * positionsMatched / playback 是容差内的下限；noteCount 是绝对值（不许丢音/造音）。
 */
const ACCEPTANCE = {
  "_3x": {
    label: "3× 渲染（1785×2523，交接文档的原基准尺寸）",
    page: "_source__p11_3x.png",
    notesTotal: 119,
    matched: 119,
    rhythm: 1.0,
    playback: 1.0,
  },
  _2600: {
    label: "长边 2600px（与应用实际渲染一致）",
    page: "_source__p11_2600.png",
    notesTotal: 119,
    matched: 119,
    rhythm: 1.0,
    playback: 1.0,
  },
};

const total = (result) => (result.parts || []).reduce((sum, part) => sum + (part.notes || []).length, 0);
const asResult = (page) => ({
  parts: page.parts,
  measureCount: page.measureCount,
  beatsPerMeasure: groundTruth.beatsPerMeasure,
});

test("简谱双尺寸快照：两种尺寸齐全，且 ground-truth 自洽", () => {
  assert.ok(snapshot.pages, "快照缺少 pages");
  for (const key of Object.keys(ACCEPTANCE)) {
    assert.ok(snapshot.pages[key], `快照缺少尺寸 ${key}`);
    assert.ok(snapshot.pages[key].parts.length > 0, `${key} 没有声部`);
  }
  const problems = validateGroundTruth(groundTruth);
  assert.deepEqual(problems, [], (problems || []).join("；"));
});

for (const [key, acceptance] of Object.entries(ACCEPTANCE)) {
  test(`简谱快照 ${key}：音符数/小節数/声部数与 ground-truth 一致（不丢音、不造音）`, () => {
    const page = snapshot.pages[key];
    assert.equal(total(page), acceptance.notesTotal, `${key} 音符总数变了`);
    assert.equal(page.measureCount, groundTruth.measureCount, `${key} 小节数变了`);
    assert.equal(page.parts.length, groundTruth.parts.length, `${key} 声部数变了`);
  });

  test(`简谱快照 ${key}：指标不低于已知水位`, () => {
    const page = snapshot.pages[key];
    const metrics = compareScore(groundTruth, asResult(page));
    assert.equal(metrics.resultNoteCount, acceptance.notesTotal, `${key} 音符数`);
    assert.ok(
      metrics.matchedCount >= acceptance.matched,
      `${key} 配对音数退化：${metrics.matchedCount} < ${acceptance.matched}`,
    );
    assert.ok(
      metrics.rhythmAccuracy >= acceptance.rhythm - 1e-9,
      `${key} 节奏正确率退化：${(metrics.rhythmAccuracy * 100).toFixed(1)}%`,
    );
    assert.ok(
      metrics.exactMeasureRate >= acceptance.playback - 1e-9,
      `${key} 端到端可演奏正确率退化：${(metrics.exactMeasureRate * 100).toFixed(1)}% < ${(acceptance.playback * 100).toFixed(1)}%`,
    );
  });
}

test("简谱双尺寸：两种渲染尺寸识别出的音符数必须相同", () => {
  assert.equal(total(snapshot.pages._3x), total(snapshot.pages._2600),
    "两种渲染尺寸音符数不同——说明存在尺寸相关的不稳定");
});

test("简谱双尺寸：快照保留了如实警告（没有被抹平）", () => {
  for (const key of Object.keys(ACCEPTANCE)) {
    assert.ok(Array.isArray(snapshot.pages[key].warnings), `${key} 缺少 warnings 字段`);
  }
});

// ---- 实跑层：需要项目 .venv（opencv）与页面图 ----
const python = path.join(ROOT, ".venv", "Scripts", "python.exe");
const engine = path.join(ROOT, "jianpu.py");
const canRunEngine = process.platform === "win32" && existsSync(python) && existsSync(engine);

for (const [key, acceptance] of Object.entries(ACCEPTANCE)) {
  const image = path.join(PAGES, acceptance.page);
  test(`简谱实跑 ${key}：${acceptance.label}`, { skip: !canRunEngine || !existsSync(image) ? "需要 .venv 与页面图" : false }, () => {
    const stdout = execFileSync(python, [engine, image], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const result = JSON.parse(stdout);
    assert.ok(!result.error, result.error);
    const metrics = compareScore(groundTruth, result);
    assert.equal(metrics.resultNoteCount, acceptance.notesTotal, `${key} 音符数变了`);
    assert.ok(metrics.matchedCount >= acceptance.matched,
      `${key} 配对音数退化：${metrics.matchedCount} < ${acceptance.matched}`);
    assert.ok(metrics.exactMeasureRate >= acceptance.playback - 1e-9,
      `${key} 端到端退化：${(metrics.exactMeasureRate * 100).toFixed(1)}%`);
  });
}

