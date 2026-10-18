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
  mergePageScores,
  pageLengthBeats,
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

test("groupStaffLines 拒绝线距上百像素的伪谱表（简谱页的系统边线）", () => {
  // 《敕勒歌》第 11 页是简谱：页面上只有每个"系统"的上下边线，线距约 119px。
  // 这些线不应被当成五线谱，否则上层会拿去做无意义的逐行识别。
  const jianpuLines = [];
  for (let system = 0; system < 3; system++) {
    const top = 300 + system * 400;
    for (let i = 0; i < 5; i++) jianpuLines.push(top + i * 119.5);
  }
  assert.equal(groupStaffLines(jianpuLines).length, 0, "线距超过 60px 的组应被丢弃");

  // 正常谱表（线距约 12px）不受影响
  const normal = groupStaffLines(linesFromStaffs(CELEGE_STAFFS));
  assert.equal(normal.length, 12);
});

// —— P0-1：多页 PDF 批量识别的跨页合并（两页 × 两个声部 × 两个 4/4 小节）——

const PAGE_NOTES = (pitch, midi, partId, measure, startBeat) =>
  ({ partId, measure: String(measure), startBeat, durationBeats: 4, midi, pitch });
// 每页 2 声部（女高/男低）× 2 小节；每页总时长 8 拍
const pageOne = {
  notes: [
    PAGE_NOTES("A4", 69, "P1", 1, 0), PAGE_NOTES("B4", 71, "P1", 2, 4),
    PAGE_NOTES("C3", 48, "P2", 1, 0), PAGE_NOTES("D3", 50, "P2", 2, 4),
  ],
  measureCount: 2, totalBeats: 8, tempo: 96,
  partNames: ["女高", "男低"], timeSummary: "4/4", keySummary: "F", title: "敕勒歌",
};
const pageTwo = {
  notes: [
    PAGE_NOTES("C5", 72, "P1", 1, 0), PAGE_NOTES("D5", 74, "P1", 2, 4),
    PAGE_NOTES("E3", 52, "P2", 1, 0), PAGE_NOTES("F3", 53, "P2", 2, 4),
  ],
  measureCount: 2, totalBeats: 8, tempo: 96,
  partNames: ["女高", "男低"], timeSummary: "4/4", keySummary: "F", title: "敕勒歌",
};

test("mergePageScores 跨页拼接：小节序号连续、起拍按页累加", () => {
  const merged = mergePageScores([pageOne, pageTwo]);
  assert.equal(merged.notes.length, 8);
  assert.equal(merged.pageCount, 2);
  assert.deepEqual(merged.failedPages, []);
  assert.equal(merged.measureCount, 4, "小节总数 = 各页小节数之和");
  assert.equal(merged.totalBeats, 16, "总拍数 = 各页总时长之和");
  assert.equal(merged.tempo, 96);
  assert.deepEqual(merged.partNames, ["女高", "男低"]);
  // 拍号/调号只取第一页，避免中途属性重置
  assert.equal(merged.timeSummary, "4/4");
  assert.equal(merged.keySummary, "F");

  // 同一 partId 跨页视为同一声部：第 2 页整体后移 8 拍，小节号接上第 1 页
  const soprano = merged.notes.filter((note) => note.partId === "P1");
  assert.deepEqual(soprano.map((note) => note.startBeat), [0, 4, 8, 12]);
  assert.deepEqual(soprano.map((note) => note.measure), ["1", "2", "3", "4"]);
  const bass = merged.notes.filter((note) => note.partId === "P2");
  assert.deepEqual(bass.map((note) => note.startBeat), [0, 4, 8, 12]);
  assert.deepEqual(bass.map((note) => note.measure), ["1", "2", "3", "4"]);

  // 各声部起拍单调递增，同一拍上的音共用事件
  assert.deepEqual(merged.notes.map((note) => note.startBeat), [0, 0, 4, 4, 8, 8, 12, 12]);
  assert.equal(merged.notes[0].eventId, merged.notes[1].eventId);
});

test("mergePageScores 单页失败不中断整批，如实记入 failedPages", () => {
  const merged = mergePageScores([pageOne, null, pageTwo]);
  assert.deepEqual(merged.failedPages, [2]);
  assert.ok(merged.warnings.some((message) => message.includes("第 2 页识别失败")));
  // 失败页不占时长：第 3 页仍从第 1 页之后（8 拍）继续，小节号仍接在第 1 页之后
  const soprano = merged.notes.filter((note) => note.partId === "P1");
  assert.deepEqual(soprano.map((note) => note.startBeat), [0, 4, 8, 12]);
  assert.deepEqual(soprano.map((note) => note.measure), ["1", "2", "3", "4"]);
});

test("mergePageScores 对空输入与非数字小节号都能安全处理", () => {
  const empty = mergePageScores([]);
  assert.equal(empty.notes.length, 0);
  assert.equal(empty.measureCount, 0);
  const page = { notes: [{ partId: "P1", measure: "x", startBeat: 2, durationBeats: 1, midi: 60 }], measureCount: 0 };
  const merged = mergePageScores([page]);
  assert.equal(merged.notes[0].measure, "x", "非数字小节号应原样保留");
});

test("pageLengthBeats 优先用 totalBeats，缺省时用最后一个音符的结束拍兜底", () => {
  assert.equal(pageLengthBeats({ totalBeats: 12, notes: [] }), 12);
  assert.equal(pageLengthBeats({ notes: [{ startBeat: 0, durationBeats: 4 }, { startBeat: 4, durationBeats: 2 }] }), 6);
  assert.equal(pageLengthBeats(null), 0);
});
