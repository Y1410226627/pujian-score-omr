import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";

globalThis.DOMParser = DOMParser;
const { parseMusicXmlText } = await import("../musicxml.js");

const score = `<?xml version="1.0"?>
<score-partwise>
  <work><work-title>校对测试曲</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>钢琴</part-name></score-part>
    <score-part id="P2"><part-name>长笛</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome></direction-type></direction>
      <note><!-- imgpos: 120, 200 --><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff><tie type="start"/></note>
      <note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff><tie type="stop"/></note>
      <note><rest/><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
      <note><chord/><pitch><step>F</step><alter>0.5</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>B</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

test("MusicXML reads timing, rests, chords, ties, tempo, and score position", () => {
  const result = parseMusicXmlText(score);
  const tied = result.notes.find((note) => note.pitch === "C#4");
  const d4 = result.notes.find((note) => note.pitch === "D4");
  const microtone = result.notes.find((note) => note.pitch === "F(+0.5)4");

  assert.equal(result.title, "校对测试曲");
  assert.equal(result.tempo, 96);
  assert.equal(result.timeSummary, "4/4");
  assert.equal(result.keySummary, "G");
  assert.equal(result.totalBeats, 3.5, "首选小节按实际内容计长，全曲总时长 3.5 拍");
  assert.equal(tied.durationBeats, 2);
  assert.equal(tied.startBeat, 0);
  assert.equal(tied.x, 120);
  assert.equal(tied.y, 200);
  assert.equal(d4.startBeat, 3);
  assert.equal(microtone.startBeat, 3);
  assert.equal(d4.eventId, microtone.eventId);
  assert.equal(result.notes.find((note) => note.pitch === "B3").partName, "长笛");
});

test("MusicXML timewise files fail with a useful format message", () => {
  assert.throws(() => parseMusicXmlText("<score-timewise/>"), /暂不支持 timewise/);
});

// —— 以下为 2026-10-17 评审发现的回归用例（E1–E4 + 空元素假警告）——

const partList = (names) =>
  `<part-list>${names.map(([id, name]) => `<score-part id="${id}"><part-name>${name}</part-name></score-part>`).join("")}</part-list>`;
const measureAttributes = (beats, beatType) =>
  `<attributes><divisions>1</divisions><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time></attributes>`;
const note = (step, octave, duration, extra = "") =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>1</voice><staff>1</staff>${extra}</note>`;

test("E1 悬空的延音起始不会把后续同音高音符错误并入", () => {
  // m1 有 tie-start，m2 是无延音的普通音符，m3 才出现孤立 tie-stop。
  // 修复前：m3 会被并入 m1，产生一个 8 拍的假长音并丢失真实音符。
  const score = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}${note("C", 4, 4, '<tie type="start"/>')}</measure>
    <measure number="2">${note("C", 4, 4)}</measure>
    <measure number="3">${note("C", 4, 4, '<tie type="stop"/>')}</measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(score);
  assert.equal(result.notes.length, 3, "三个四分音符都应保留，不能被合并成两个");
  assert.deepEqual(result.notes.map((item) => item.startBeat), [0, 4, 8]);
  assert.deepEqual(result.notes.map((item) => item.durationBeats), [4, 4, 4]);
});

test("E2 未标 implicit 的弱起小节按实际内容计长，后续小节不右移", () => {
  const score = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}${note("D", 4, 1)}</measure>
    <measure number="2">${note("E", 4, 4)}</measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(score);
  assert.equal(result.notes.find((item) => item.pitch === "D4").startBeat, 0);
  assert.equal(result.notes.find((item) => item.pitch === "E4").startBeat, 1, "第 2 小节应紧接弱起小节，而不是被补齐到第 4 拍");
});

test("E3 多声部小节长度不共享时，第 2 小节起仍能对齐", () => {
  const score = `<score-partwise>${partList([["P1", "右手"], ["P2", "左手"]])}
    <part id="P1">
      <measure number="1">${measureAttributes(4, 4)}${note("C", 5, 4)}</measure>
      <measure number="2">${note("D", 5, 4)}</measure>
    </part>
    <part id="P2">
      <measure number="1">${measureAttributes(3, 4)}${note("C", 3, 3)}</measure>
      <measure number="2">${note("D", 3, 3)}</measure>
    </part>
  </score-partwise>`;
  const result = parseMusicXmlText(score);
  const rightHand = result.notes.find((item) => item.pitch === "D5");
  const leftHand = result.notes.find((item) => item.pitch === "D3");
  assert.equal(rightHand.startBeat, 4);
  assert.equal(leftHand.startBeat, 4, "两个声部的第 2 小节必须同时开始");
});

test("E4 全休止乐谱返回空音符并给出提示，而不是抛异常", () => {
  const score = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}<note><rest/><duration>4</duration><voice>1</voice><staff>1</staff></note></measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(score);
  assert.equal(result.notes.length, 0);
  assert.ok(result.warnings.some((message) => message.includes("没有找到可演奏的带音高音符")));
});

test("空标记元素不产生假警告，带内容的标记元素仍会警告", () => {
  const empty = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff>
        <notations><articulations/><ornaments/></notations></note>
    </measure>
  </part></score-partwise>`;
  const emptyResult = parseMusicXmlText(empty);
  assert.ok(!emptyResult.warnings.some((message) => message.includes("奏法")), "空 <articulations/> 不应触发奏法警告");

  const filled = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff>
        <notations><articulations><staccato/></articulations></notations></note>
    </measure>
  </part></score-partwise>`;
  const filledResult = parseMusicXmlText(filled);
  assert.ok(filledResult.warnings.some((message) => message.includes("奏法")), "带 <staccato/> 时仍应警告");
});

test("P1-3 解析中途速度变化与力度记号，不再声称不支持", () => {
  const score = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome></direction-type></direction>
      ${note("C", 4, 1)}
      ${note("D", 4, 1)}
      <direction><direction-type><dynamics><mf/></dynamics></direction-type><sound dynamics="89"/></direction>
      ${note("E", 4, 1)}
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type></direction>
      ${note("F", 4, 1)}
    </measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(score);
  assert.equal(result.tempo, 96, "起始速度取开头记号");
  assert.deepEqual(result.tempoMarks, [{ beat: 0, bpm: 96 }, { beat: 3, bpm: 120 }], "中途速度变化应被记录");
  assert.deepEqual(result.dynamicsMarks, [{ beat: 2, dynamics: 89 }], "力度记号应被记录");
  assert.deepEqual(result.warnings, [], "速度/力度都已支持，这一份谱不该再有相关警告");
});

test("OMR 素材的 ground truth 自洽（拍数、起拍连续、音名合法）", () => {
  const truth = JSON.parse(readFileSync(new URL("./fixtures/known_treble_quarters.ground-truth.json", import.meta.url), "utf8"));
  const [beats, beatType] = truth.timeSignature.split("/").map(Number);
  const measureBeats = beats * 4 / beatType;
  const totalBeats = truth.notes.reduce((sum, item) => sum + item.durationBeats, 0);
  assert.equal(totalBeats, measureBeats * truth.measureCount, "素材各音时值之和必须等于小节总拍数，否则素材本身画错了");

  let expectedOnset = 0;
  for (const item of truth.notes) {
    assert.equal(item.onsetBeats, expectedOnset, "起拍必须从 0 开始连续排列");
    expectedOnset += item.durationBeats;
    assert.match(item.step, /^[A-G]$/);
    assert.ok(Number.isInteger(item.octave));
  }
});
