import assert from "node:assert/strict";
import test from "node:test";

import {
  secondsAtBeat, buildAudioPlan, normalizePeak, stereoChannels, audioFileName, formatDuration,
} from "../audio-export.js";

const note = (midi, startBeat, durationBeats, partId = "P1") =>
  ({ midi, startBeat, durationBeats, partId, partName: partId });

test("拍位 → 秒：匀速时就是 拍数 × 60/BPM", () => {
  assert.equal(secondsAtBeat([], 60, 0), 0);
  assert.equal(secondsAtBeat([], 60, 4), 4);
  assert.equal(secondsAtBeat([], 120, 4), 2);
});

test("拍位 → 秒：中途变速按段累加（与播放一致）", () => {
  // 0 拍起 60 BPM，第 4 拍起 120 BPM
  const segments = [{ beat: 4, bpm: 120 }];
  assert.equal(secondsAtBeat(segments, 60, 2), 2);
  assert.equal(secondsAtBeat(segments, 60, 4), 4);
  assert.equal(secondsAtBeat(segments, 60, 8), 6, "第 4 拍后每拍 0.5 秒");
});

test("拍位 → 秒：多段变速（模拟 Hall 曲 138→80→85）", () => {
  const segments = [{ beat: 20, bpm: 80 }, { beat: 24, bpm: 85 }];
  // 0–20 拍 @138：20×60/138 ≈ 8.696 秒
  const at20 = secondsAtBeat(segments, 138, 20);
  assert.ok(Math.abs(at20 - (20 * 60) / 138) < 1e-9);
  // 20–24 拍 @80：4×0.75 = 3 秒
  const at24 = secondsAtBeat(segments, 138, 24);
  assert.ok(Math.abs(at24 - (at20 + 3)) < 1e-9);
});

test("导出计划：整曲、全部声部、无移调", () => {
  const plan = buildAudioPlan({
    notes: [note(60, 0, 1), note(62, 1, 1)],
    startBpm: 60,
    globalTimbre: "piano",
    tailSeconds: 1,
  });
  assert.equal(plan.notes.length, 2);
  assert.equal(plan.notes[0].midi, 60);
  assert.equal(plan.notes[0].startSeconds, 0);
  assert.equal(plan.notes[0].durationSeconds, 1);
  assert.equal(plan.notes[1].startSeconds, 1);
  assert.equal(plan.totalSeconds, 3, "最后一个音结束 2 秒 + 1 秒余音");
  assert.deepEqual(plan.partKeys, ["P1"]);
});

test("导出计划：只导出勾选的声部", () => {
  const notes = [note(60, 0, 1, "S"), note(48, 0, 1, "B"), note(72, 0, 1, "S")];
  const only = buildAudioPlan({ notes, startBpm: 60, enabledParts: ["S"], tailSeconds: 0.5 });
  assert.equal(only.notes.length, 2);
  assert.deepEqual([...new Set(only.notes.map((item) => item.partKey))], ["S"]);
  const none = buildAudioPlan({ notes, startBpm: 60, enabledParts: [], tailSeconds: 0.5 });
  assert.equal(none.notes.length, 0, "全不选时导出空计划（界面应拒绝）");
});

test("导出计划：任意音高 —— 整曲移调 + 逐声部移调叠加", () => {
  const notes = [note(60, 0, 1, "S")];
  const raised = buildAudioPlan({
    notes, startBpm: 60, transpose: 3, partTranspose: new Map([["S", 12]]), tailSeconds: 0.5,
  });
  assert.equal(raised.notes[0].midi, 75, "60 + 3 + 12");
  const lowered = buildAudioPlan({ notes, startBpm: 60, transpose: -2, tailSeconds: 0.5 });
  assert.equal(lowered.notes[0].midi, 58);
  // 越界钳制
  const extreme = buildAudioPlan({ notes: [note(120, 0, 1)], startBpm: 60, transpose: 12, tailSeconds: 0.5 });
  assert.equal(extreme.notes[0].midi, 127, "不允许超过 MIDI 127");
});

test("导出计划：选区裁切 + 平移到 0 秒开始", () => {
  const notes = [note(60, 0, 1), note(62, 4, 1), note(64, 8, 1)];
  const plan = buildAudioPlan({
    notes, startBpm: 60,
    selection: { fromBeat: 4, toBeat: 9 },
    tailSeconds: 0.5,
  });
  assert.equal(plan.notes.length, 2, "只保留选区内的两个音");
  assert.equal(plan.notes[0].startSeconds, 0, "选区起点平移到 0 秒");
  assert.equal(plan.notes[1].startSeconds, 4);
  assert.equal(plan.totalSeconds, 5.5, "最后一个音结束 5 秒 + 0.5 秒余音");
});

test("导出计划：跨界音符按选区边界截断", () => {
  const notes = [note(60, 0, 4)];  // 一个小节长音
  const plan = buildAudioPlan({ notes, startBpm: 60, selection: { fromBeat: 2, toBeat: 3 }, tailSeconds: 0 });
  assert.equal(plan.notes.length, 1);
  assert.equal(plan.notes[0].durationSeconds, 1, "只保留选区内的 2–3 拍");
  assert.equal(plan.notes[0].startSeconds, 0);
});

test("导出计划：音色与音量按声部取，未设置时回退全局", () => {
  const plan = buildAudioPlan({
    notes: [note(60, 0, 1, "S"), note(48, 0, 1, "B")],
    startBpm: 60,
    globalTimbre: "strings",
    partTimbres: new Map([["S", "choir_female"]]),
    partVolumes: new Map([["S", 0.4]]),
    tailSeconds: 0.5,
  });
  const soprano = plan.notes.find((item) => item.partKey === "S");
  const bass = plan.notes.find((item) => item.partKey === "B");
  assert.equal(soprano.timbre, "choir_female");
  assert.equal(soprano.volume, 0.4);
  assert.equal(bass.timbre, "strings", "没单独设置就跟随全局");
  assert.equal(bass.volume, 1, "默认音量 1");
});

test("导出计划：按开始时间排序，便于顺序渲染", () => {
  const plan = buildAudioPlan({
    notes: [note(60, 4, 1), note(62, 0, 1), note(64, 2, 1)], startBpm: 60, tailSeconds: 0.5,
  });
  assert.deepEqual(plan.notes.map((item) => item.startSeconds), [0, 2, 4]);
});

test("峰值归一：把整体拉到目标电平，且不削波", () => {
  // 用合理的渲染电平（峰值约 0.2）；极端小的电平有 8 倍增益上限保护
  const left = new Float32Array([0.1, 0.2, -0.15]);
  const right = new Float32Array([0.05, 0.18, -0.2]);
  const result = normalizePeak(left, right, 0.89);
  let peak = 0;
  for (const value of result.left) peak = Math.max(peak, Math.abs(value));
  for (const value of result.right) peak = Math.max(peak, Math.abs(value));
  assert.ok(Math.abs(peak - 0.89) < 1e-5, `归一后峰值应为 0.89，实际 ${peak}`);
  assert.notEqual(result.left, left, "不应原地修改输入");
  // 全静音不崩
  const silent = normalizePeak(new Float32Array(10), new Float32Array(10), 0.89);
  assert.equal(silent.gain, 1);
});

test("声道整理：单声道复制成双声道，立体声原样返回", () => {
  const mono = stereoChannels([new Float32Array([1, 2, 3])]);
  assert.equal(mono.right, mono.left, "单声道时左右相同");
  const left = new Float32Array([1]);
  const right = new Float32Array([2]);
  const stereo = stereoChannels([left, right]);
  assert.equal(stereo.left, left);
  assert.equal(stereo.right, right);
});

test("导出文件名：带片段范围、去掉非法字符、扩展名可换", () => {
  assert.equal(audioFileName("有我.musicxml", null), "有我.mp3");
  assert.equal(audioFileName("有我.musicxml", null, "wav"), "有我.wav");
  assert.equal(audioFileName("a/b:c", null), "a_b_c.mp3");
  assert.equal(audioFileName("曲子", { fromBeat: 4, toBeat: 12 }), "曲子-片段4-12拍.mp3");
});

test("时长格式化", () => {
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDuration(59), "59 秒");
  assert.equal(formatDuration(83), "1 分 23 秒");
  assert.equal(formatDuration(3600), "60 分 0 秒");
});
