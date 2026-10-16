import assert from "node:assert/strict";
import test from "node:test";

import {
  groupStaffLines,
  groupSystems,
  staffCropBox,
  yForPitch,
  midiToPitchLabel,
  transposeNotes,
  mergeSystemScores,
  medianOf,
  diatonicIndex,
} from "../staff.js";

// —— 测试数据取自真实谱例《敕勒歌》第 1 页（1785×2526）检测到的 60 条谱线 ——
// 每项为 [谱表顶部 y, 谱表高度]，共 12 行谱表（2 个系统 × 6 行）
const CELEGE_STAFFS = [
  [476, 42], [638, 43], [801, 42], [969, 32], [1105, 42], [1232, 43],
  [1479, 42], [1641, 43], [1804, 43], [1972, 32], [2108, 43], [2236, 42],
];

function linesFromStaffs(specs) {
  const lines = [];
  for (const [top, height] of specs) {
    const spacing = height / 4;
    for (let i = 0; i < 5; i++) lines.push(top + i * spacing);
  }
  return lines;
}

test("medianOf 处理奇偶长度", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([4, 1, 3, 2]), 2.5);
  assert.equal(medianOf([]), 0);
});

test("groupStaffLines 能把《敕勒歌》的 60 条谱线分成 12 行谱表", () => {
  const staves = groupStaffLines(linesFromStaffs(CELEGE_STAFFS));
  assert.equal(staves.length, 12, "应识别出 12 行谱表");
  for (const staff of staves) assert.equal(staff.lines.length, 5, "每行谱表必须恰好 5 条线");
  const tops = staves.map((staff) => Math.round(staff.top));
  assert.deepEqual(tops, CELEGE_STAFFS.map(([top]) => top), "谱表顶部位置应与真实检测一致");
  // 第 4 行（陶笛）谱表字号更小
  assert.ok(staves[3].spacing < staves[0].spacing, "第 4 行谱表线间距应更小");
});

test("groupStaffLines 对单行谱表与空输入都能正确处理", () => {
  assert.equal(groupStaffLines([100, 110, 120, 130, 140]).length, 1);
  assert.deepEqual(groupStaffLines([]), []);
  assert.deepEqual(groupStaffLines([10, 20, 30]), [], "不足 5 条线时不产生谱表");
});

test("groupStaffLines 对线间距过于均匀的整块也能切出多行", () => {
  // 相邻谱表间距与谱表内间距接近，只能靠组内切分
  const lines = [];
  for (let staff = 0; staff < 3; staff++) {
    for (let i = 0; i < 5; i++) lines.push(staff * 60 + i * 12);
  }
  const staves = groupStaffLines(lines);
  assert.ok(staves.length >= 2, `应至少切出 2 行，实际 ${staves.length}`);
  for (const staff of staves) assert.equal(staff.lines.length, 5);
});

test("groupSystems 把 12 行谱表分成 2 个系统，每系统 6 行", () => {
  const staves = groupStaffLines(linesFromStaffs(CELEGE_STAFFS));
  const systems = groupSystems(staves);
  assert.equal(systems.length, 2, "应分成 2 个系统");
  assert.deepEqual(systems.map((system) => system.length), [6, 6]);
  // 系统内并行、系统间顺序：第 2 个系统整体更靠下
  assert.ok(systems[0][0].top < systems[1][0].top);
});

test("groupSystems 对单系统页面不误切", () => {
  const staves = groupStaffLines(linesFromStaffs([[100, 40], [200, 40], [300, 40]]));
  const systems = groupSystems(staves);
  assert.equal(systems.length, 1);
  assert.equal(systems[0].length, 3);
});

test("staffCropBox 的裁剪区域不越过相邻谱表", () => {
  const staves = groupStaffLines(linesFromStaffs(CELEGE_STAFFS));
  const [first, second] = staves;
  const box = staffCropBox(first, 1785, 2526, null, second);
  assert.ok(box.y >= 0);
  assert.ok(box.y + box.height <= 2526);
  assert.ok(box.y + box.height <= (first.bottom + second.top) / 2 + 0.5, "下边界不得越过两行谱表的中线");
  assert.ok(box.height > first.bottom - first.top, "至少要完整包含本行谱表");
});

test("yForPitch 在女高音谱表上算出的位置与实测符头一致", () => {
  const staves = groupStaffLines(linesFromStaffs(CELEGE_STAFFS));
  const soprano = staves[0];
  // 实测：第 2 小节全音符符头中心 y≈503（谱线 476/486.5/497/507.5/518）
  assert.ok(Math.abs(yForPitch("A", 4, soprano, "treble") - 502.25) < 0.6, "A4 应落在 B4 线与 G4 线之间的间上");
  assert.ok(Math.abs(yForPitch("E", 4, soprano, "treble") - soprano.bottom) < 0.01, "最下线为 E4");
  assert.ok(Math.abs(yForPitch("F", 5, soprano, "treble") - soprano.top) < 0.01, "最上线为 F5");
  // 低音谱号最下线为 G2
  const bass = staves[2];
  assert.ok(Math.abs(yForPitch("G", 2, bass, "bass") - bass.bottom) < 0.01);
});

test("diatonicIndex 按自然音级计数", () => {
  assert.equal(diatonicIndex("C", 4), 28);
  assert.equal(diatonicIndex("A", 4) - diatonicIndex("E", 4), 3);
});

test("midiToPitchLabel 正确换算音名与八度", () => {
  assert.equal(midiToPitchLabel(60), "C4");
  assert.equal(midiToPitchLabel(69), "A4");
  assert.equal(midiToPitchLabel(61), "C#4");
  assert.equal(midiToPitchLabel(21), "A0");
});

test("transposeNotes 整体移调并同步更新音名，且不修改原数组", () => {
  const notes = [{ pitch: "A4", midi: 69 }, { pitch: "C4", midi: 60 }];
  const up = transposeNotes(notes, 1);
  assert.deepEqual(up.map((note) => note.pitch), ["A#4", "C#4"]);
  assert.equal(notes[0].pitch, "A4", "原数组不应被改动");
  const down = transposeNotes(notes, -12);
  assert.deepEqual(down.map((note) => note.midi), [57, 48]);
});

test("mergeSystemScores 系统内并行、系统间顺序拼接", () => {
  const systems = [[0, 1], [2, 3]];
  const results = new Map([
    [0, { notes: [{ pitch: "A4", midi: 69, startBeat: 0, durationBeats: 1 }, { pitch: "B4", midi: 71, startBeat: 1, durationBeats: 1 }], tempo: 68, measureCount: 2, staffIndex: 0, clefName: "treble" }],
    [1, { notes: [{ pitch: "E4", midi: 64, startBeat: 0, durationBeats: 4 }], tempo: 68, measureCount: 2, staffIndex: 1, clefName: "treble" }],
    [2, { notes: [{ pitch: "C5", midi: 72, startBeat: 0, durationBeats: 1 }], tempo: 68, measureCount: 2, staffIndex: 6, clefName: "treble" }],
    [3, { notes: [{ pitch: "G4", midi: 67, startBeat: 0, durationBeats: 1 }], tempo: 68, measureCount: 2, staffIndex: 7, clefName: "bass" }],
  ]);
  const merged = mergeSystemScores(systems, results);

  assert.equal(merged.systemCount, 2);
  assert.equal(merged.staffCount, 4);
  assert.equal(merged.tempo, 68);
  assert.deepEqual(merged.partNames, ["第 1 行谱表", "第 2 行谱表"]);

  // 第 1 个系统里两个声部同时从 0 拍开始
  const systemOne = merged.notes.filter((note) => note.startBeat < 4);
  assert.deepEqual(systemOne.map((note) => note.startBeat).sort(), [0, 0, 1]);

  // 第 1 个系统的总长由最长的声部决定（4 拍），第 2 个系统整体后移 4 拍
  const systemTwo = merged.notes.filter((note) => note.startBeat >= 4);
  assert.equal(systemTwo.length, 2);
  assert.deepEqual(systemTwo.map((note) => note.startBeat), [4, 4]);

  // 同一位置的谱表在不同系统里归入同一个声部
  assert.equal(merged.notes.find((note) => note.pitch === "A4").partName, "第 1 行谱表");
  assert.equal(merged.notes.find((note) => note.pitch === "C5").partName, "第 1 行谱表");
  assert.equal(merged.notes.find((note) => note.pitch === "E4").partName, "第 2 行谱表");
  assert.equal(merged.notes.find((note) => note.pitch === "G4").partName, "第 2 行谱表");

  // 每个音符要带上谱表几何序号与谱号，界面才能把音高画回正确的谱线
  assert.equal(merged.notes.find((note) => note.pitch === "C5").staffIndex, 6);
  assert.equal(merged.notes.find((note) => note.pitch === "C5").clefName, "treble");
  assert.equal(merged.notes.find((note) => note.pitch === "G4").staffIndex, 7);
  assert.equal(merged.notes.find((note) => note.pitch === "G4").clefName, "bass");
});

test("mergeSystemScores 对识别失败的行给出提示而不是静默丢弃", () => {
  const merged = mergeSystemScores([[0, 1]], new Map([
    [0, { notes: [{ pitch: "A4", midi: 69, startBeat: 0, durationBeats: 1 }] }],
    [1, { error: "识别失败" }],
  ]));
  assert.equal(merged.notes.length, 1);
  assert.ok(merged.warnings.some((message) => message.includes("1 行谱表没有识别出音符")));
});

test("mergeSystemScores 把整行休止的声部当作正常空谱表，不报缺失", () => {
  const merged = mergeSystemScores([[0, 1]], new Map([
    [0, { notes: [{ pitch: "A4", midi: 69, startBeat: 0, durationBeats: 1 }] }],
    [1, { notes: [], empty: true }],
  ]));
  assert.equal(merged.notes.length, 1);
  assert.ok(!merged.warnings.some((message) => message.includes("没有识别出音符")), "整行休止不应报成识别缺失");
  assert.deepEqual(merged.partNames, ["第 1 行谱表", "第 2 行谱表"], "空谱表也要保留声部占位");
});

test("mergeSystemScores 重新分配 eventId，同一拍上的音共用一个事件", () => {
  const merged = mergeSystemScores([[0, 1]], new Map([
    [0, { notes: [{ pitch: "A4", midi: 69, startBeat: 0, durationBeats: 1 }] }],
    [1, { notes: [{ pitch: "E4", midi: 64, startBeat: 0, durationBeats: 1 }] }],
  ]));
  assert.equal(merged.notes[0].eventId, merged.notes[1].eventId, "同一拍的音符应属于同一个事件（和弦）");
});
