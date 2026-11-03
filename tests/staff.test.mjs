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
  quantizeScoreRhythm,
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
// —— 2026-10-19：扫描谱「节奏量化」（把散乱的时值吸附到拍号网格，修复"听起来散"）——
test("节奏量化：起拍吸附网格、时值补到下一个音、同音重复去重、弱起小节不被拉长", () => {
  const scoreInfo = {
    timeSummary: "4/4",
    notes: [
      // 弱起小节（measure 0）：只有一个音，不能因为「补齐 4 拍」就把它拉长/挪动
      { partId: "P1", measure: "0", midi: 60, voice: "1", startBeat: 0, startInMeasure: 0, durationBeats: 0.75 },
      // 第 1 小节：两个同音高的重复音（引擎把一个字读成两个），应只保留一个
      { partId: "P1", measure: "1", midi: 62, voice: "1", startBeat: 4 + 1.375, startInMeasure: 1.375, durationBeats: 0.375 },
      { partId: "P1", measure: "1", midi: 62, voice: "1", startBeat: 4 + 1.375, startInMeasure: 1.375, durationBeats: 0.5 },
      // 起拍 2.6 应吸附到 2.5；时值 1.4 应补到小节末（到下一个起拍/末尾的间隔）
      { partId: "P1", measure: "1", midi: 64, voice: "1", startBeat: 4 + 2.6, startInMeasure: 2.6, durationBeats: 1.4 },
    ],
  };
  const result = quantizeScoreRhythm(scoreInfo);
  assert.equal(result.notes.length, 3, "重复音应去重（4 个音变 3 个）");
  const pickup = result.notes.find((note) => note.midi === 60);
  assert.equal(pickup.startBeat, 0, "弱起音不能被挪走");
  assert.ok(pickup.durationBeats <= 1, "弱起音不能被强行拉满 4 拍");
  const repeated = result.notes.filter((note) => note.midi === 62);
  assert.equal(repeated.length, 1, "同小节同起拍同音高只保留一个");
  assert.equal(repeated[0].startBeat, 5.5, "1.375 拍应吸附到 1.5 拍（第 2 小节的 5.5）");
  assert.equal(repeated[0].durationBeats, 0.5, "原时值 0.5 拍保留（不硬拉长到下一拍，留出休止）");
  const last = result.notes.find((note) => note.midi === 64);
  assert.equal(last.startBeat, 6.5, "2.6 拍应吸附到 2.5 拍");
  assert.equal(last.durationBeats, 1.5, "最后一个音补到小节末（2.5 → 4）");
  for (const note of result.notes) {
    assert.ok(Math.abs(note.startBeat * 4 - Math.round(note.startBeat * 4)) < 1e-6, "起拍应在 1/4 拍网格上");
  }
});
// —— 2026-11-01：逐系统识别（《敕勒歌》特调）新增的纯函数 ——
import {
  detectBarlines,
  canonicalPartRole,
  resolveSystemRoles,
  beatsPerMeter,
  assignLayoutToSystems,
  assembleSystemScores,
  summarizeMeterChanges,
} from "../staff.js";
import { DOMParser } from "@xmldom/xmldom";
globalThis.DOMParser = DOMParser;
const { parseMusicXmlText } = await import("../musicxml.js");

function staffSpec(top, spaced = 10) {
  return { top, bottom: top + spaced * 4, spacing: spaced };
}

test("detectBarlines：跨谱表对齐的竖线才算小节线，符干不算", () => {
  const width = 400, height = 260;
  const binary = new Uint8Array(width * height);
  const staves = [staffSpec(20), staffSpec(80), staffSpec(140)];
  for (const staff of staves) {
    for (let index = 0; index < 5; index++) {
      const y = Math.round(staff.top + index * staff.spacing);
      for (let x = 0; x < width; x++) binary[y * width + x] = 1;
    }
  }
  // 三条真实小节线：贯穿三行谱表（含行间空隙）
  for (const x of [40, 160, 300]) {
    for (let y = 20; y <= 180; y++) binary[y * width + x] = 1;
  }
  // 两根符干：只在一行谱表范围内，不应被当成小节线
  for (const [x, top] of [[100, 20], [230, 80]]) {
    for (let y = top - 10; y <= top + 50; y++) binary[y * width + x] = 1;
  }
  const barlines = detectBarlines(binary, width, height, staves);
  assert.equal(barlines.length, 3, "只保留三行谱表都有的竖线");
  assert.deepEqual(barlines.map((barline) => Math.round(barline.x)), [40, 160, 300]);
});

test("canonicalPartRole：把谱面缩写/中英文标签归一成稳定声部名", () => {
  assert.equal(canonicalPartRole("S."), "Soprano");
  assert.equal(canonicalPartRole("Soprano"), "Soprano");
  assert.equal(canonicalPartRole("A."), "Alto");
  assert.equal(canonicalPartRole("Bar."), "Baritone");
  assert.equal(canonicalPartRole("Pno."), "Piano");
  assert.equal(canonicalPartRole("Piano"), "Piano");
  assert.equal(canonicalPartRole("陶笛"), "陶笛");
  assert.equal(canonicalPartRole("Ocarina"), "陶笛");
  assert.equal(canonicalPartRole("女高音"), "Soprano");
  assert.equal(canonicalPartRole("自定义声部"), "自定义声部", "认不出的标签原样保留");
  assert.equal(canonicalPartRole(""), "");
});

test("resolveSystemRoles：标签够用时按谱面自上而下命名，不够时用兜底补齐", () => {
  assert.deepEqual(resolveSystemRoles(["S.", "A.", "Bar.", "陶笛", "Pno."], [], ["Voice"], 5),
    ["Soprano", "Alto", "Baritone", "陶笛", "Piano"]);
  assert.deepEqual(resolveSystemRoles([], ["Soprano", "Alto", "Baritone", "陶笛", "Piano"], ["Voice", "Voice"], 5),
    ["Soprano", "Alto", "Baritone", "陶笛", "Piano"]);
  assert.deepEqual(resolveSystemRoles([], [], ["Voice", "Voice", "Bar."], 3),
    ["Voice", "Voice 2", "Baritone"]);
});

test("beatsPerMeter：普通/加合拍号换算成每小节拍数", () => {
  assert.equal(beatsPerMeter("4/4"), 4);
  assert.equal(beatsPerMeter("6/4"), 6);
  assert.equal(beatsPerMeter("6/8"), 3);
  assert.equal(beatsPerMeter("3+2/8"), 2.5);
  assert.equal(beatsPerMeter("拍号未标明"), 0);
});

test("assignLayoutToSystems：标签/印刷小节号/拍号字形落到正确的系统", () => {
  const layout = {
    labels: [
      { text: "S.", x: 60, y: 90, height: 20 },
      { text: "Pno.", x: 60, y: 250, height: 20 },
      { text: "S.", x: 60, y: 490, height: 20 },
      { text: "Pno.", x: 60, y: 650, height: 20 },
    ],
    bars: [
      { bar: 54, x: 70, y: 50 },
      { bar: 58, x: 70, y: 450 },
    ],
    timeGlyphs: [
      { meter: "6/4", x: 100, y: 80, height: 20 },
      { meter: "4/4", x: 230, y: 80, height: 20 },
      { meter: "4/4", x: 100, y: 480, height: 20 },
    ],
  };
  const systems = [
    { top: 60, bottom: 340, firstStaffTop: 70, lastStaffBottom: 330, barlines: [40, 220, 400, 700] },
    { top: 440, bottom: 720, firstStaffTop: 460, lastStaffBottom: 710, barlines: [40, 500, 800] },
  ];
  const result = assignLayoutToSystems(layout, systems);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].labels, ["S.", "Pno."]);
  assert.equal(result[0].anchorBar, 54);
  assert.deepEqual(result[0].meterMap, ["6/4", "4/4", "4/4"], "第二个小节起转 4/4（小节线 4 条 → 3 小节）");
  assert.equal(result[1].anchorBar, 58);
  // 第一节系统 4 条小节线 → 3 小节；印刷小节号差 58-54 = 4 只作检测失败时的兜底。
  assert.equal(result[0].measureCount, 3);
  assert.equal(result[0].anchorMeasureCount, 4);
  assert.equal(result[1].measureCount, 2, "最后一个系统没有下一个印刷小节号，退回数小节线");
  assert.deepEqual(result[1].meterMap, ["4/4", "4/4"], "拍号跨系统延续");
});

function systemXml(options) {
  const { measures, time = "4/4", parts = 2, noteCount = 2, firstNumber = 1, pickup = false } = options;
  const divisions = 4;
  const partList = Array.from({ length: parts }, (_, index) =>
    `<score-part id="P${index + 1}"><part-name>${index === 0 ? "S." : index === 1 ? "A." : "Pno."}</part-name></score-part>`).join("");
  const measureXml = (index) => {
    const number = index + (pickup && options.firstSystem ? 0 : firstNumber);
    const attributes = index === 0 ? `<attributes><divisions>${divisions}</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>` : "";
    const body = index === 0 && pickup
      ? `<note><rest/><duration>4</duration><voice>1</voice><staff>1</staff></note>`
      : Array.from({ length: noteCount }, (_, noteIndex) => {
        const step = ["C", "D", "E", "F", "G", "A", "B"][(noteIndex + index) % 7];
        return `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>`;
      }).join("");
    return `<measure number="${number}"${index === 0 && pickup ? ' implicit="yes"' : ""}>${attributes}${body}</measure>`;
  };
  return `<score-partwise><part-list>${partList}</part-list>` +
    Array.from({ length: parts }, (_, partIndex) => `<part id="P${partIndex + 1}">` +
      Array.from({ length: measures }, (_, index) => measureXml(index)).join("") + "</part>").join("") +
    `</score-partwise>`;
}

test("assembleSystemScores：两系统首尾相接、声部按标签命名、弱起小节记 0", () => {
  const first = parseMusicXmlText(systemXml({ measures: 2, pickup: true, firstSystem: true, noteCount: 2 }));
  const second = parseMusicXmlText(systemXml({ measures: 2, firstNumber: 1, noteCount: 2 }));
  const score = assembleSystemScores([
    { scoreInfo: first, labels: ["S.", "A."], meterMap: ["4/4", "4/4"], measureCount: 2 },
    { scoreInfo: second, labels: ["S.", "A."], meterMap: ["4/4", "4/4"], measureCount: 2 },
  ], { measureBase: 1 });
  assert.deepEqual(score.partNames, ["Soprano", "Alto"], "标签归一成谱面声部名");
  const partIds = [...new Set(score.notes.map((note) => note.partId))].sort();
  assert.deepEqual(partIds, ["P1", "P2"], "跨系统同名声部合并，不会因每系统重新编号而分裂");
  // 第 1 系统：弱起 1 拍 + 1 个满小节；第 2 系统从第 5 拍开始
  const secondSystemNote = score.notes.find((note) => note.startBeat >= 5);
  assert.equal(secondSystemNote.startBeat, 5, "第二系统紧接第一系统（1 + 4 拍）");
  assert.deepEqual(score.notes.filter((note) => note.measure === "0").map((note) => note.partId), [], "弱起小节里只有休止符，没有可演奏音符");
  assert.equal(score.notes[0].measure, "1", "第一个正规小节是第 1 小节");
  assert.equal(score.measureCount, 3, "两个系统共 3 个正规小节（弱起不算小节数）");
  assert.equal(score.totalBeats, 13, "弱起 1 拍 + 3 个正规小节 × 4 拍");
  assert.equal(score.notes.find((note) => note.startBeat === 1).measure, "1");
  assert.equal(score.notes.find((note) => note.startBeat === 5).measure, "2");
});

test("assembleSystemScores：解析小节数少于小节线、且有一小节明显超长时，按印刷小节线补齐", () => {
  // Audiveris 漏读一条小节线：两个 4/4 小节被并成一个 8 拍的小节（《敕勒歌》第 10 页实测）；
  // 只有这种「有小节明显超长」的情况才相信小节线条数，避免低清图片上小节线误检多出空小节。
  const note = (step, duration = 1) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration}</duration><voice>1</voice><staff>1</staff></note>`;
  const xml = `<score-partwise><part-list><score-part id="P1"><part-name>S.</part-name></score-part></part-list>
    <part id="P1">
      <measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
        ${note("C").repeat(8)}
      </measure>
      <measure number="2">${note("D", 4)}</measure>
      <measure number="3">${note("E", 4)}</measure>
    </part></score-partwise>`;
  const parsed = parseMusicXmlText(xml);
  assert.deepEqual(parsed.measureContents, [8, 4, 4], "第一小节吞掉了相邻小节线（8 拍）");
  const score = assembleSystemScores([
    { scoreInfo: parsed, labels: ["S."], meterMap: ["4/4", "4/4", "4/4", "4/4"], measureCount: 4 },
  ], { measureBase: 1 });
  assert.equal(score.measureCount, 4, "以印刷小节线为准：4 小节");
  assert.equal(score.totalBeats, 16);
  assert.ok(score.warnings.some((warning) => warning.includes("多 1 个小节")), "补小节要如实告知用户");
});

test("assembleSystemScores：解析小节数少于小节线、但小节内容正常时，不补空小节（低清图片小节线误检）", () => {
  // 图片型 PDF 上小节线检测偶尔会多算一条；此时若机械按小节线补小节，就会多出一个空小节
  // （用户听到的「莫名其妙的空拍」）。内容正常（没有超长小节）时应以解析结果为准。
  const note = () => `<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>`;
  const measure = (number) => `<measure number="${number}"><attributes><divisions>2</divisions>${number === 1 ? "<time><beats>2</beats><beat-type>4</beat-type></time>" : ""}</attributes>${note()}${note()}</measure>`;
  const xml = `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1">${measure(1)}${measure(2)}${measure(3)}${measure(4)}</part></score-partwise>`;
  const parsed = parseMusicXmlText(xml);
  const score = assembleSystemScores([{ scoreInfo: parsed, labels: [], measureCount: 5 }]);
  assert.equal(score.measureCount, 4, "解析出 4 个正常小节，就不按误检的 5 条小节线补");
  assert.equal(score.systemStats.appendedMeasures, 0, "不应补空小节");
});

test("assembleSystemScores：变拍子写进拍号说明（第几小节是 6/4）", () => {
  const parsed = parseMusicXmlText(systemXml({ measures: 2, noteCount: 4 }));
  const score = assembleSystemScores([
    { scoreInfo: parsed, labels: ["S.", "A."], meterMap: ["6/4", "4/4"], measureCount: 2 },
  ], { measureBase: 54 });
  assert.equal(score.totalBeats, 10, "6/4 小节 6 拍 + 4/4 小节 4 拍");
  assert.match(score.timeSummary, /6\/4/);
  assert.deepEqual(score.meterChanges.map((change) => change.measure), [54, 55]);
});

test("summarizeMeterChanges：一句话说清变拍子在哪几小节", () => {
  assert.equal(summarizeMeterChanges([{ measure: 1, meter: "4/4" }]), "4/4");
  assert.equal(
    summarizeMeterChanges([
      { measure: 1, meter: "4/4" },
      { measure: 54, meter: "6/4" },
      { measure: 55, meter: "4/4" },
      { measure: 66, meter: "6/4" },
      { measure: 67, meter: "4/4" },
    ]),
    "4/4（第 54、66 小节为 6/4）",
  );
  assert.equal(summarizeMeterChanges([], "拍号未标明"), "拍号未标明");
});

test("mergePageScores：变拍子说明随跨页小节偏移一起平移", () => {
  const page1 = { notes: [], warnings: [], partNames: ["S."], tempo: 68, tempoDetected: true, measureCount: 10, totalBeats: 41, timeSummary: "4/4", meterChanges: [{ measure: 1, meter: "4/4" }], symbolCounts: { slurs: 2 } };
  const page2 = { notes: [], warnings: [], partNames: ["S."], tempo: 68, tempoDetected: true, measureCount: 7, totalBeats: 28, timeSummary: "4/4", meterChanges: [{ measure: 1, meter: "4/4" }, { measure: 5, meter: "6/4" }], symbolCounts: { slurs: 3 } };
  const merged = mergePageScores([page1, page2]);
  // 第 2 页开头那条「4/4」与上一页结尾相同，是每页装配时的重复记录、不是真的变拍号，
  // 应被去掉（否则速度说明会变成「4/4（第 11、15 小节为…）」这种假变化）。
  assert.deepEqual(merged.meterChanges.map((change) => change.measure), [1, 15], "只有第 15 小节是真的转 6/4");
  assert.equal(merged.symbolCounts.slurs, 5, "记号统计跨页累加");
  assert.equal(merged.measureCount, 17);
});

test("mergePageScores：速度标记跨页累加（中途变速不会被丢掉），重复速度只留第一次", () => {
  const page1 = {
    notes: [], warnings: [], partNames: ["S."], tempo: 60, tempoDetected: true,
    measureCount: 15, totalBeats: 45, timeSummary: "6/8",
    tempoMarks: [{ beat: 0, bpm: 60 }],
  };
  const page2 = {
    notes: [], warnings: [], partNames: ["S."], tempo: 60, tempoDetected: true,
    measureCount: 10, totalBeats: 20, timeSummary: "2/4",
    tempoMarks: [{ beat: 0, bpm: 60 }, { beat: 8, bpm: 68 }],
  };
  const merged = mergePageScores([page1, page2]);
  assert.deepEqual(merged.tempoMarks, [
    { beat: 0, bpm: 60 },
    { beat: 53, bpm: 68 },   // 第 2 页第 8 拍 → 45 + 8
  ]);
  assert.equal(merged.tempo, 60, "起始速度取全曲第一个标记");
  assert.equal(merged.tempoDetected, true);
});

test("assembleSystemScores：离谱的速度值（OCR 把 68 读成 6）不进入结果", () => {
  const xml = `<score-partwise>
    <part-list><score-part id="P1"><part-name>S.</part-name></score-part></part-list>
    <part id="P1">
      <measure number="1"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
        <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>6</per-minute></metronome></direction-type></direction>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><staff>1</staff></note>
      </measure>
    </part>
  </score-partwise>`;
  const parsed = parseMusicXmlText(xml);
  const score = assembleSystemScores([{ scoreInfo: parsed, labels: ["S."], meterMap: ["4/4"], measureCount: 1 }]);
  assert.equal(score.tempoMarks.length, 0, "小于 20 BPM 的『速度』是误读，不应保留");
  assert.equal(score.tempoDetected, false);
});

test("assignLayoutToSystems：单页识别时用已知主拍号起步（本页没印拍号也不会被猜成 6/4）", () => {
  const layout = {
    labels: [{ text: "S.", x: 60, y: 90, height: 20 }],
    bars: [{ bar: 61, x: 70, y: 50 }],
    timeGlyphs: [],
  };
  const systems = [{ top: 60, bottom: 340, firstStaffTop: 70, lastStaffBottom: 330, barlines: [40, 220, 400, 700] }];
  const result = assignLayoutToSystems(layout, systems, { initialMeter: "4/4" });
  assert.deepEqual(result[0].meterMap, ["4/4", "4/4", "4/4"], "整页没印拍号时应沿用已知的 4/4");
  assert.equal(result[0].anchorBar, 61);
});

test("mergePageScores：补/裁小节与溢出音符统计跨页累加，roleCount 不累加", () => {
  const page1 = { notes: [], warnings: [], partNames: ["S."], measureCount: 10, totalBeats: 41, systemStats: { appendedMeasures: 0, trimmedMeasures: 1, overflowNotes: 2, roleCount: 5 } };
  const page2 = { notes: [], warnings: [], partNames: ["S."], measureCount: 7, totalBeats: 28, systemStats: { appendedMeasures: 1, trimmedMeasures: 0, overflowNotes: 3, roleCount: 5 } };
  const merged = mergePageScores([page1, page2]);
  assert.equal(merged.systemStats.appendedMeasures, 1);
  assert.equal(merged.systemStats.trimmedMeasures, 1);
  assert.equal(merged.systemStats.overflowNotes, 5);
  assert.equal(merged.systemStats.roleCount, undefined, "roleCount 没有累加意义，不应出现");
});

// —— 2026-11-01 修复：变拍子小节的节奏量化不能按整曲拍号算 ——

test("quantizeScoreRhythm：6/4 小节的第 5、6 拍不被压到第 4 拍（变拍子处不再被量化挤成空拍）", () => {
  const scoreInfo = {
    timeSummary: "4/4（第 2 小节为 6/4）",
    meterChanges: [{ measure: 1, meter: "4/4" }, { measure: 2, meter: "6/4" }, { measure: 3, meter: "4/4" }],
    notes: [
      // 第 1 小节（4/4）
      { partId: "P1", measure: "1", voice: "1", staff: "1", midi: 60, startBeat: 0, startInMeasure: 0, durationBeats: 4 },
      // 第 2 小节（6/4）：第 5、6 拍上的音
      { partId: "P1", measure: "2", voice: "1", staff: "1", midi: 62, startBeat: 4, startInMeasure: 0, durationBeats: 2 },
      { partId: "P1", measure: "2", voice: "1", staff: "1", midi: 64, startBeat: 8, startInMeasure: 4, durationBeats: 1 },
      { partId: "P1", measure: "2", voice: "1", staff: "1", midi: 65, startBeat: 9, startInMeasure: 5, durationBeats: 1 },
      // 第 3 小节（4/4）
      { partId: "P1", measure: "3", voice: "1", staff: "1", midi: 67, startBeat: 10, startInMeasure: 0, durationBeats: 4 },
    ],
  };
  quantizeScoreRhythm(scoreInfo);
  const measure2 = scoreInfo.notes.filter((note) => note.measure === "2").sort((a, b) => a.startBeat - b.startBeat);
  // 第 2 小节从第 4 拍开始，6/4 小节内相对落拍应为 0 / 4 / 5
  assert.deepEqual(measure2.map((note) => Number((note.startBeat - 4).toFixed(3))), [0, 4, 5], "第 5、6 拍的音必须留在第 5、6 拍");
  assert.ok(measure2.every((note) => note.startBeat >= 4 && note.startBeat < 10), "不能挪出小节");
  // 第 3 小节起拍不受影响（第 4 小节总长 = 6 拍）
  assert.equal(scoreInfo.notes.find((note) => note.measure === "3").startBeat, 10);
});
