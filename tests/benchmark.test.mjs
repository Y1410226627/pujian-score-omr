import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compareScore,
  formatMetrics,
  pitchToMidi,
  validateGroundTruth,
} from "./benchmark.mjs";

const readJson = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("pitchToMidi 换算：中央 C、升号、降号", () => {
  assert.equal(pitchToMidi("C", 4), 60);
  assert.equal(pitchToMidi("A", 4), 69);
  assert.equal(pitchToMidi("C", 4, 1), 61);
  assert.equal(pitchToMidi("B", 3, -1), 58);
  assert.ok(Number.isNaN(pitchToMidi("H", 4)));
});

test("既有单声部验收素材自洽（step/octave 写法也能归一）", () => {
  const gt = readJson("known_treble_quarters.ground-truth.json");
  assert.deepEqual(validateGroundTruth(gt), []);
  assert.equal(gt.measureCount, 1);
  assert.equal(gt.timeSignature, "5/4");
});

test("简谱《敕勒歌》p11 基准自洽：4 个声部、119 个音符、不越界", () => {
  const gt = readJson("chilele_p11_jianpu.ground-truth.json");
  assert.deepEqual(validateGroundTruth(gt), []);
  assert.equal(gt.measureCount, 12);
  assert.equal(gt.beatsPerMeasure, 4);
  assert.equal(gt.parts.length, 4);
  const total = gt.parts.reduce((sum, part) => sum + part.notes.length, 0);
  assert.equal(total, 119);
  // 已知歧义小节在基准里如实保留为警告，而不是被抹掉。
  assert.equal(gt.warnings.length, 2);
});

test("自洽校验能抓出问题基准：越界、负时值、起拍倒退", () => {
  const bad = {
    measureCount: 1,
    beatsPerMeasure: 4,
    parts: [{
      name: "声部1",
      notes: [
        { midi: 60, onsetBeats: 0, durationBeats: 1 },
        { midi: 62, onsetBeats: 3.5, durationBeats: 2 },   // 越界
        { midi: 64, onsetBeats: 1, durationBeats: -1 },    // 负时值 + 起拍倒退
      ],
    }],
  };
  const problems = validateGroundTruth(bad);
  assert.ok(problems.some((problem) => problem.includes("超出全曲总长")));
  assert.ok(problems.some((problem) => problem.includes("时值必须为正")));
  assert.ok(problems.some((problem) => problem.includes("单调不减")));
});

test("指标：完全一致时各项均为 1", () => {
  const gt = { measureCount: 1, beatsPerMeasure: 4, parts: [{ name: "A", notes: [
    { midi: 60, onsetBeats: 0, durationBeats: 1 },
    { midi: 62, onsetBeats: 1, durationBeats: 0.5 },
    { midi: 64, onsetBeats: 1.5, durationBeats: 2.5 },
  ] }] };
  const metrics = compareScore(gt, gt);
  assert.equal(metrics.countAccuracy, 1);
  assert.equal(metrics.pitchF1, 1);
  assert.equal(metrics.rhythmAccuracy, 1);
  assert.equal(metrics.exactMeasureRate, 1);
});

test("指标：起拍超出容差不配对、结果多一个音会拉低精确率", () => {
  const gt = { measureCount: 1, beatsPerMeasure: 4, parts: [{ name: "A", notes: [
    { midi: 60, onsetBeats: 0, durationBeats: 1 },
    { midi: 62, onsetBeats: 2, durationBeats: 1 },
  ] }] };
  const result = { beatsPerMeasure: 4, parts: [{ name: "A", notes: [
    { midi: 60, onsetBeats: 0.4, durationBeats: 1 },   // 容差 0.05 之外，配不上
    { midi: 62, onsetBeats: 2, durationBeats: 1 },
    { midi: 67, onsetBeats: 3, durationBeats: 1 },     // 多余音符
  ] }] };
  const metrics = compareScore(gt, result);
  assert.equal(metrics.matchedCount, 1);
  assert.equal(metrics.pitchRecall, 0.5);
  assert.ok(Math.abs(metrics.pitchPrecision - 1 / 3) < 1e-9);
  assert.ok(Math.abs(metrics.pitchF1 - 0.4) < 1e-9);
  assert.equal(metrics.countAccuracy, 0.5);
});

test("指标：时值不同时节奏正确率下降，但音高仍算对", () => {
  const gt = { measureCount: 1, beatsPerMeasure: 4, parts: [{ name: "A", notes: [
    { midi: 60, onsetBeats: 0, durationBeats: 1 },
    { midi: 62, onsetBeats: 1, durationBeats: 1 },
  ] }] };
  const result = { beatsPerMeasure: 4, parts: [{ name: "A", notes: [
    { midi: 60, onsetBeats: 0, durationBeats: 0.5 },
    { midi: 62, onsetBeats: 1, durationBeats: 1 },
  ] }] };
  const metrics = compareScore(gt, result);
  assert.equal(metrics.pitchRecall, 1);
  assert.equal(metrics.rhythmAccuracy, 0.5);
  assert.equal(metrics.exactMeasureRate, 0);
});

test("指标：端到端可演奏正确率按小节统计（对一半就是 50%）", () => {
  const gt = { measureCount: 2, beatsPerMeasure: 2, parts: [{ name: "A", notes: [
    { midi: 60, onsetBeats: 0, durationBeats: 1 },
    { midi: 62, onsetBeats: 1, durationBeats: 1 },
    { midi: 64, onsetBeats: 2, durationBeats: 1 },
    { midi: 65, onsetBeats: 3, durationBeats: 1 },
  ] }] };
  const result = { beatsPerMeasure: 2, parts: [{ name: "A", notes: [
    { midi: 60, onsetBeats: 0, durationBeats: 1 },
    { midi: 62, onsetBeats: 1, durationBeats: 1 },
    { midi: 64, onsetBeats: 2, durationBeats: 1 },
    { midi: 67, onsetBeats: 3, durationBeats: 1 },   // 第 2 小节错一个音
  ] }] };
  const metrics = compareScore(gt, result);
  assert.equal(metrics.measureCells, 2);
  assert.equal(metrics.exactMeasures, 1);
  assert.equal(metrics.exactMeasureRate, 0.5);
});

test("结果里用 startBeat 命名起拍也能配对（兼容 jianpu.py 的原始输出）", () => {
  const gt = { measureCount: 1, beatsPerMeasure: 4, parts: [{ name: "A", notes: [
    { midi: 69, onsetBeats: 4, durationBeats: 4 },
    { midi: 67, onsetBeats: 8, durationBeats: 1 },
  ] }] };
  // jianpu.py 的真实输出字段名是 startBeat（见 jianpu.py 的 parts 输出）。
  const result = { beatsPerMeasure: 4, parts: [{ name: "声部1", notes: [
    { midi: 69, startBeat: 4, durationBeats: 4, x: 296, y: 652.5 },
    { midi: 67, startBeat: 8, durationBeats: 1, x: 391, y: 652.5 },
  ] }] };
  const metrics = compareScore(gt, result);
  assert.equal(metrics.matchedCount, 2);
  assert.equal(metrics.pitchF1, 1);
});

test("指标：把简谱基准当结果自比，应得到满分（工具链与格式自洽）", () => {
  const gt = readJson("chilele_p11_jianpu.ground-truth.json");
  const metrics = compareScore(gt, gt, { onsetTolerance: 0.01, durationTolerance: 0.01 });
  assert.equal(metrics.gtNoteCount, 119);
  assert.equal(metrics.pitchF1, 1);
  assert.equal(metrics.exactMeasureRate, 1);
  assert.match(formatMetrics(metrics, { title: "自比" }), /音高 F1：100\.0%/);
});
