// 逐系统识别（2026-11-02《绒花》特调）新增纯函数的回归测试：
//  1. detectSystems：按「贯通多行谱表的长竖线」分系统，而不是按固定间距切分；
//  2. inferPartRoles / resolveSystemRoles：没有 PDF 文字层标签时，靠谱号/谱表数推断声部名；
//  3. assembleSystemScores：各系统声部数不同（钢琴独奏段/Solo 段/四声部段混排）时，
//     同名角色必须落到同一个全局 P 编号（Solo 段的钢琴不能被算成 Alto）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  binarize,
  detectBarlines,
  detectStaves,
  detectSystems,
  groupSystems,
  inferPartRoles,
  resolveSystemRoles,
  assembleSystemScores,
} from "../staff.js";

const WIDTH = 420;
const SPACING = 10;
const STAFF_HEIGHT = SPACING * 4;

/** 画一行谱表（5 条横线）。 */
function drawStaff(binary, top) {
  for (let line = 0; line < 5; line++) {
    const y = Math.round(top + line * SPACING);
    for (let x = 0; x < WIDTH; x++) binary[y * WIDTH + x] = 1;
  }
}

/** 画一条竖线（系统起始小节线/方括号竖笔画/钢琴跨行小节线）。 */
function drawVertical(binary, height, x, y0, y1) {
  for (let y = Math.max(0, Math.round(y0)); y <= Math.min(height - 1, Math.round(y1)); y++) {
    binary[y * WIDTH + x] = 1;
  }
}

/**
 * 《绒花》式的混排版面：
 *  系统 A：钢琴独奏 2 行谱表（top 60 / 180）；
 *  系统 B：Solo+钢琴 3 行谱表（top 420 / 540 / 660）；
 *  系统 C：四声部+钢琴 6 行谱表（top 900 / 1020 / 1140 / 1260 / 1380 / 1500）。
 * 系统内相邻谱表间距（系统 A：120-40=80；系统 C：120-40=80）
 * 故意做得和系统间距（B-C：900-700=200）之外还有更大的内部间隔，
 * 并额外画一条贯穿整页的页边框线——它不能把三个系统连成一个。
 */
function buildMixedPage() {
  const height = 1700;
  const binary = new Uint8Array(WIDTH * height);
  const tops = [60, 180, 420, 540, 660, 900, 1020, 1140, 1260, 1380, 1500];
  for (const top of tops) drawStaff(binary, top);
  const bottomOf = (top) => top + STAFF_HEIGHT;
  // 每个系统一条「系统起始小节线」，贯穿本系统所有谱表。
  drawVertical(binary, height, 60, 60, bottomOf(180));
  drawVertical(binary, height, 60, 420, bottomOf(660));
  drawVertical(binary, height, 60, 900, bottomOf(1500));
  // 四声部系统里，钢琴两行之间还有跨行连谱小节线。
  drawVertical(binary, height, 200, 1380, bottomOf(1500));
  drawVertical(binary, height, 340, 1380, bottomOf(1500));
  // 贯穿整页的页边框线（干扰项）：不能把上下系统连起来。
  drawVertical(binary, height, 2, 0, height - 1);
  drawVertical(binary, height, WIDTH - 3, 0, height - 1);
  return { binary, width: WIDTH, height };
}

test("detectSystems：混排版面（2行/3行/6行）按竖线连接分成 3 个系统", () => {
  const { binary, width, height } = buildMixedPage();
  const staves = detectStaves(binary, width, height);
  assert.equal(staves.length, 11, "先确认检测到 11 行谱表");
  const systems = detectSystems(binary, width, height, staves);
  const sizes = systems.map((system) => system.length);
  assert.deepEqual(sizes, [2, 3, 6], "应按竖线连接分成 2 / 3 / 6 三组");
  // 系统间距和系统内间距在这里是同一量级（80 vs 80~100）——旧的固定间距切法会切错。
  const legacy = groupSystems(staves).map((system) => system.length);
  assert.notDeepEqual(legacy, [2, 3, 6], "（对照）旧的按间距切分算法在这张版面上切不对");
});

test("detectSystems：没有可用竖线时退回按间距分组（不破坏没有括号的谱）", () => {
  const height = 1200;
  const binary = new Uint8Array(WIDTH * height);
  const tops = [60, 180, 420, 540];
  for (const top of tops) drawStaff(binary, top);
  const staves = detectStaves(binary, WIDTH, height);
  const systems = detectSystems(binary, WIDTH, height, staves);
  const legacy = groupSystems(staves);
  assert.deepEqual(systems.map((system) => system.length), legacy.map((system) => system.length),
    "没有竖线时应与 groupSystems 结果一致");
});

test("detectSystems：谱线二值图经 binarize 后也能分组（灰度路径）", () => {
  const { binary, width, height } = buildMixedPage();
  const gray = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) gray[index] = binary[index] ? 20 : 250;
  const reBinarized = binarize(gray);
  const staves = detectStaves(reBinarized, width, height);
  const systems = detectSystems(reBinarized, width, height, staves);
  assert.deepEqual(systems.map((system) => system.length), [2, 3, 6]);
});

test("inferPartRoles：按「谱表数 + 谱号」推断 S/A/T/B/钢琴", () => {
  const treble = { sign: "G", line: "2", octaveChange: 0 };
  const treble8 = { sign: "G", line: "2", octaveChange: -1 };
  const bass = { sign: "F", line: "4", octaveChange: 0 };
  const satbPiano = [
    { partName: "Voice", staves: 1, clefs: [treble] },
    { partName: "Voice", staves: 1, clefs: [treble] },
    { partName: "Voice", staves: 1, clefs: [treble8] },
    { partName: "Voice", staves: 1, clefs: [bass] },
    { partName: "Piano", staves: 2, clefs: [treble, bass] },
  ];
  assert.deepEqual(inferPartRoles(["Voice", "Voice", "Voice", "Voice", "Piano"], satbPiano, 5),
    ["Soprano", "Alto", "Tenor", "Bass", "Piano"]);
  // 《绒花》第 2 页 Solo 段：1 行 S 谱表 + 钢琴大谱表
  assert.deepEqual(
    inferPartRoles(["Voice", "Piano"], [
      { partName: "Voice", staves: 1, clefs: [treble] },
      { partName: "Piano", staves: 2, clefs: [treble, bass] },
    ], 2),
    ["Soprano", "Piano"],
  );
  // 钢琴独奏段
  assert.deepEqual(
    inferPartRoles(["Piano"], [{ partName: "Piano", staves: 2, clefs: [treble, bass] }], 1),
    ["Piano"],
  );
  // 没有 partDetails 时返回 null（交给旧的兜底逻辑）
  assert.equal(inferPartRoles(["Voice"], [], 1), null);
});

test("resolveSystemRoles：图片型 PDF 没有标签时按谱号推断，有标签时标签优先", () => {
  const treble = { sign: "G", line: "2", octaveChange: 0 };
  const bass = { sign: "F", line: "4", octaveChange: 0 };
  const details = [
    { partName: "Voice", staves: 1, clefs: [treble] },
    { partName: "Piano", staves: 2, clefs: [treble, bass] },
  ];
  // 没有标签：不再沿用「上一系统的前两个声部」（旧逻辑会把钢琴叫成 Alto）
  assert.deepEqual(resolveSystemRoles([], ["Soprano", "Alto", "Tenor", "Bass", "Piano"], ["Voice", "Piano"], 2, details),
    ["Soprano", "Piano"]);
  // 有标签：标签优先
  assert.deepEqual(resolveSystemRoles(["A.", "Pno."], ["Soprano"], ["Voice", "Piano"], 2, details),
    ["Alto", "Piano"]);
});

/** 生成一个系统的 MusicXML：partSpecs = [{ name, clefs: [...], staves }]，音符 midi 由 options 决定。 */
function systemXml(partSpecs, { measures = 2, time = "2/4" } = {}) {
  const divisions = 4;
  const partList = partSpecs.map((part, index) =>
    `<score-part id="P${index + 1}"><part-name>${part.name}</part-name></score-part>`).join("");
  const parts = partSpecs.map((part, partIndex) => {
    const clefXml = (part.clefs || []).map((clef) =>
      `<clef><sign>${clef.sign || "G"}</sign><line>${clef.line || "2"}</line>` +
      `${clef.octaveChange ? `<clef-octave-change>${clef.octaveChange}</clef-octave-change>` : ""}</clef>`).join("");
    const stavesXml = part.staves > 1 ? `<staves>${part.staves}</staves>` : "";
    const measureXml = Array.from({ length: measures }, (_, index) => {
      const attributes = index === 0
        ? `<attributes><divisions>${divisions}</divisions>${stavesXml}<time><beats>2</beats><beat-type>4</beat-type></time>${clefXml}</attributes>`
        : "";
      const midi = part.midi ?? (partIndex === 0 ? 72 : 40);
      const noteXml = `<note><pitch><step>C</step><octave>${Math.floor(midi / 12) - 1}</octave></pitch>` +
        `<duration>8</duration><voice>1</voice><staff>1</staff></note>`;
      return `<measure number="${index + 1}">${attributes}${noteXml}</measure>`;
    }).join("");
    return `<part id="P${partIndex + 1}">${measureXml}</part>`;
  }).join("");
  return `<score-partwise><part-list>${partList}</part-list>${parts}</score-partwise>`;
}

const TREBLE = { sign: "G", line: "2" };
const TREBLE8 = { sign: "G", line: "2", octaveChange: -1 };
const BASS = { sign: "F", line: "4" };

test("assembleSystemScores：各系统声部数不同，钢琴始终是同一个全局声部", async () => {
  const { DOMParser } = await import("@xmldom/xmldom");
  globalThis.DOMParser = DOMParser;
  const { parseMusicXmlText } = await import("../musicxml.js");
  // 系统 1：Solo 段（S + 钢琴），钢琴音高很低（midi 40）
  const solo = parseMusicXmlText(systemXml([
    { name: "Voice", clefs: [TREBLE], staves: 1, midi: 72 },
    { name: "Piano", clefs: [TREBLE, BASS], staves: 2, midi: 40 },
  ]));
  // 系统 2：四声部段（S/A/T/B + 钢琴）
  const full = parseMusicXmlText(systemXml([
    { name: "Voice", clefs: [TREBLE], staves: 1, midi: 72 },
    { name: "Voice", clefs: [TREBLE], staves: 1, midi: 67 },
    { name: "Voice", clefs: [TREBLE8], staves: 1, midi: 60 },
    { name: "Voice", clefs: [BASS], staves: 1, midi: 48 },
    { name: "Piano", clefs: [TREBLE, BASS], staves: 2, midi: 40 },
  ]));
  const score = assembleSystemScores([
    { scoreInfo: solo, labels: [], measureCount: 2 },
    { scoreInfo: full, labels: [], measureCount: 2 },
  ], { measureBase: 1 });
  assert.deepEqual(score.partNames, ["Soprano", "Alto", "Tenor", "Bass", "Piano"], "声部名按谱号推断，且人声在前、钢琴最后");
  const midiByPart = new Map();
  for (const note of score.notes) {
    if (!midiByPart.has(note.partId)) midiByPart.set(note.partId, new Set());
    midiByPart.get(note.partId).add(note.midi);
  }
  // 系统 1 的钢琴（C2 = midi 36）必须归到 Piano（P5），不能因为「本系统第 2 个声部」被算成 Alto。
  assert.deepEqual([...midiByPart.get("P5")].sort((a, b) => a - b), [36], "钢琴音只在 Piano 声部");
  assert.deepEqual([...midiByPart.get("P1")].sort((a, b) => a - b), [72], "S 声部只有旋律音");
  assert.equal(midiByPart.has("P2") && [...midiByPart.get("P2")].includes(36), false, "Alto 里不能混进钢琴音");
});

test("assembleSystemScores：单系统钢琴独奏页也编号为 P1 Piano", async () => {
  const { DOMParser } = await import("@xmldom/xmldom");
  globalThis.DOMParser = DOMParser;
  const { parseMusicXmlText } = await import("../musicxml.js");
  const parsed = parseMusicXmlText(systemXml([
    { name: "Piano", clefs: [TREBLE, BASS], staves: 2, midi: 40 },
  ]));
  const score = assembleSystemScores([{ scoreInfo: parsed, labels: [], measureCount: 2 }]);
  assert.deepEqual(score.partNames, ["Piano"]);
  assert.deepEqual(score.partIds, ["P1"]);
  assert.ok(score.notes.every((note) => note.partId === "P1"));
});

test("detectBarlines：贯穿整行谱表、但连着横符杠的符干不算小节线", () => {
  // 《绒花》第 5/9 页：各声部节奏完全对齐，同一拍的符干在 3 行谱表上落在同一 x，
  // 符干又贯穿整行谱表、顶端连着符杠 —— 旧的纯几何检测会把它当小节线，
  // 导致小节数多出来。这里构造同样的图形验证两道几何校验。
  const width = 420, height = 300;
  const binary = new Uint8Array(width * height);
  const spacing = 10;
  const staffTops = [20, 100];
  for (const top of staffTops) {
    for (let line = 0; line < 5; line++) {
      const y = top + line * spacing;
      for (let x = 0; x < width; x++) binary[y * width + x] = 1;
    }
  }
  const drawColumn = (x, y0, y1) => {
    for (let y = y0; y <= y1; y++) binary[y * width + x] = 1;
  };
  // 两条真小节线：从谱表上线画到下线
  for (const top of staffTops) {
    drawColumn(40, top, top + 4 * spacing);
    drawColumn(200, top, top + 4 * spacing);
  }
  // 假小节线：3 行谱表上都有一条贯穿的「符干」，顶端连着横符杠（长 3 个间距）
  for (const top of staffTops) {
    drawColumn(120, top, top + 4 * spacing);
    const beamY = top + 3;
    for (let x = 120; x <= 120 + spacing * 3; x++) binary[beamY * width + x] = 1;
    const beamY2 = top + 4 * spacing - 3;
    for (let x = 120; x <= 120 + spacing * 3; x++) binary[beamY2 * width + x] = 1;
  }
  const staves = staffTops.map((top) => ({ top, bottom: top + 4 * spacing, spacing }));
  const detected = detectBarlines(binary, width, height, staves);
  assert.deepEqual(detected.map((barline) => Math.round(barline.x)), [40, 200],
    "只保留两条真小节线，符干+符杠那条要被排除");
  const legacy = detectBarlines(binary, width, height, staves, { checkStems: false });
  assert.equal(legacy.length, 3, "（对照）不做符干校验时会把假小节线也算进去");
});

test("assembleSystemScores：整页没有印刷拍号时按音符时值推断拍号（2/4 不会被当成 4 拍量化）", async () => {
  const { DOMParser } = await import("@xmldom/xmldom");
  globalThis.DOMParser = DOMParser;
  const { parseMusicXmlText } = await import("../musicxml.js");
  // 每小节 2 个四分音符、完全不印拍号（图片型 PDF 的某些单页就是这样）
  const measureXml = (number) => `<measure number="${number}">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
    </measure>`;
  const parsed = parseMusicXmlText(`<score-partwise>
    <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
    <part id="P1">${measureXml(1)}${measureXml(2)}${measureXml(3)}</part>
  </score-partwise>`);
  const score = assembleSystemScores([{ scoreInfo: parsed, labels: [], measureCount: 3 }]);
  assert.equal(score.timeSummary, "2/4", "按每小节 2 拍推断为 2/4");
  assert.ok(Math.abs(score.totalBeats - 6) < 0.01, "3 小节 × 2 拍 = 6 拍（不是 3×4=12）");
  assert.deepEqual(score.notes.map((note) => note.startBeat), [0, 1, 2, 3, 4, 5]);
  assert.ok(score.warnings.some((warning) => warning.includes("推断为 2/4")), "要如实告诉用户拍号是推断的");
});
