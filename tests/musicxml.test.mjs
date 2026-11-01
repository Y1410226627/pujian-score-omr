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

test("空标记元素不产生假警告；真实奏法记号会被解析并进入试听（不再只是警告）", () => {
  const empty = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff>
        <notations><articulations/><ornaments/></notations></note>
    </measure>
  </part></score-partwise>`;
  const emptyResult = parseMusicXmlText(empty);
  assert.ok(!emptyResult.warnings.some((message) => message.includes("奏法")), "空 <articulations/> 不应触发奏法警告");
  assert.equal(emptyResult.symbolCounts.articulations, 0);

  const filled = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff>
        <notations><articulations><staccato/></articulations></notations></note>
    </measure>
  </part></score-partwise>`;
  const filledResult = parseMusicXmlText(filled);
  assert.equal(filledResult.symbolCounts.staccato, 1, "断奏记号应被统计");
  assert.equal(filledResult.notes[0].articulation, "staccato", "断奏应落到音符上（试听时缩短发声）");
  assert.ok(
    !filledResult.warnings.some((message) => message.includes("奏法") && message.includes("不支持")),
    "断奏已经接入试听，不应再提示「不支持奏法」",
  );
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

// —— 2026-10-18：图片型 PDF/多页谱的「后几页不印拍号」问题（用户反馈《有我》识别不准）——
test("后几页没印拍号时：传入已知拍号，猜长的小节按拍号缩回，页与页起拍不再越飘越远", () => {
  // 模拟 Audiveris 在没有拍号的页面上的输出：整小节休止的 duration 被按谱面宽度猜成 7 拍（28/4）。
  const noTimeSignaturePage = `<score-partwise>${partList([["P1", "女高"]])}<part id="P1">
    <measure number="1"><attributes><divisions>4</divisions></attributes>
      <note><rest measure="yes"/><duration>28</duration><voice>1</voice></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
    </measure>
  </part></score-partwise>`;

  const guessed = parseMusicXmlText(noTimeSignaturePage);
  assert.equal(guessed.timeSummary, "拍号未标明", "本页确实没有印拍号");
  assert.equal(guessed.totalBeats, 9, "没有拍号时只能按内容猜：第 1 小节被猜成 7 拍 + 第 2 小节 2 拍");

  const inherited = parseMusicXmlText(noTimeSignaturePage, { timeSignature: "4/4" });
  assert.equal(inherited.timeSummary, "4/4", "继承的拍号要算进本页结果");
  assert.equal(inherited.measureCount, 2);
  assert.equal(inherited.totalBeats, 8, "两小节都按 4/4 的 4 拍算，共 8 拍");
  const c5 = inherited.notes.find((item) => item.pitch === "C5");
  const d5 = inherited.notes.find((item) => item.pitch === "D5");
  assert.equal(c5.startBeat, 4, "第 2 小节应从第 4 拍开始（而不是第 7 拍）");
  assert.equal(d5.startBeat, 5);
  assert.equal(d5.startBeat - c5.startBeat, 1, "小节内相对节奏保持不变（等比缩回）");
});

test("本页自己印了拍号时，不套用继承的拍号（中途变拍号仍按谱面算）", () => {
  const pageWithOwnTime = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(3, 4)}${note("C", 4, 3)}</measure>
    <measure number="2">${note("D", 4, 3)}</measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(pageWithOwnTime, { timeSignature: "4/4" });
  assert.equal(result.timeSummary, "3/4", "本页印的 3/4 优先，继承值只做兜底");
  assert.equal(result.totalBeats, 6);
  assert.equal(result.notes.find((item) => item.pitch === "D4").startBeat, 3);
});

// —— 2026-11-01：逐系统识别（《敕勒歌》特调）带来的解析能力 ——

test("逐系统：measures 元数据能标出「弱起小节」，即使弱起里一个音符都没有", () => {
  const score = `<score-partwise>${partList([["P1", "女高"]])}<part id="P1">
    <measure number="0" implicit="yes"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><rest/><duration>4</duration><voice>1</voice><staff>1</staff></note>
    </measure>
    <measure number="1">${note("C", 4, 4)}</measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(score);
  assert.equal(result.measures.length, 2);
  assert.equal(result.measures[0].implicit, true, "第 0 小节是弱起");
  assert.equal(result.measures[0].lengthBeats, 1, "弱起小节只有 1 拍（内容就是 1 拍休止）");
  assert.equal(result.measures[1].startBeat, 1, "正规小节从第 1 拍开始");
});

test("逐系统：meterMap + strictMeters 能把变拍子（6/4 → 4/4）按印刷拍号算准", () => {
  // Audiveris 在变拍子的系统里只认到开头的 6/4，第二个小节的 4/4 漏读了；
  // 用 PDF 文字层给出的逐小节拍号覆盖后，各小节长度必须是 6/4、4/4、4/4、4/4。
  const score = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(6, 4)}
      ${note("C", 4, 4)}${note("D", 4, 4)}${note("E", 4, 4)}${note("F", 4, 4)}${note("G", 4, 4)}${note("A", 4, 4)}
    </measure>
    <measure number="2">${note("B", 4, 4)}${note("C", 5, 4)}${note("D", 5, 4)}${note("E", 5, 4)}</measure>
    <measure number="3">${note("F", 5, 4)}${note("G", 5, 4)}${note("A", 5, 4)}${note("B", 5, 4)}</measure>
    <measure number="4">${note("C", 6, 4)}${note("D", 6, 4)}${note("E", 6, 4)}${note("F", 6, 4)}</measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(score, {
    meterMap: ["6/4", "4/4", "4/4", "4/4"],
    strictMeters: true,
  });
  assert.equal(result.totalBeats, 18, "6 + 4 + 4 + 4 = 18 拍");
  assert.deepEqual(result.measures.map((measure) => measure.lengthBeats), [6, 4, 4, 4]);
  assert.equal(result.notes.find((item) => item.pitch === "B4").startBeat, 6, "第 2 小节从第 6 拍开始");
  assert.equal(result.notes.find((item) => item.pitch === "C6").startBeat, 14, "第 4 小节从第 14 拍开始");
  assert.equal(result.timeSummary, "有多种拍号", "变拍子要如实显示");
});

test("力度：p/mf/f 只有印刷记号、没有 sound 数值时也能换算成力度", () => {
  const score = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}
      <direction><direction-type><dynamics><p/></dynamics></direction-type></direction>
      ${note("C", 4, 1)}
      <direction><direction-type><dynamics><mf/></dynamics></direction-type></direction>
      ${note("D", 4, 1)}
      <direction><direction-type><dynamics><f/></dynamics></direction-type></direction>
      ${note("E", 4, 1)}
      ${note("F", 4, 1)}
    </measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(score);
  assert.equal(result.dynamicsMarks.length, 3);
  const values = result.dynamicsMarks.map((mark) => mark.dynamics);
  assert.deepEqual(values, [48, 70, 84], "p=48、mf=70、f=84（近似 MIDI 力度）");
  assert.equal(result.symbolCounts.dynamics, 3);
});

test("渐强/渐弱、圆滑线、延长号、歌词都被解析并统计", () => {
  const score = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1">${measureAttributes(4, 4)}
      <direction><direction-type><wedge type="crescendo" spread="15"/></direction-type></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff>
        <notations><slur type="start" number="1"/><fermata/></notations><lyric number="1"><text>敕勒</text></lyric></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff>
        <notations><slur type="stop" number="1"/></notations></note>
      <direction><direction-type><wedge type="stop"/></direction-type></direction>
    </measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(score);
  assert.equal(result.symbolCounts.slurs, 1);
  assert.equal(result.symbolCounts.fermatas, 1);
  assert.equal(result.symbolCounts.lyrics, 1);
  assert.equal(result.notes[0].slurStart, true);
  assert.equal(result.notes[1].slurStop, true);
  assert.equal(result.notes[0].fermata, true);
  assert.equal(result.notes[0].lyric, "敕勒");
  assert.equal(result.wedgeMarks.length, 1, "成对的渐强记号应合成一个区间");
  assert.equal(result.wedgeMarks[0].startBeat, 0);
  assert.equal(result.wedgeMarks[0].endBeat, 4);
  assert.equal(result.wedgeMarks[0].type, "crescendo");
});

test("逐系统：PDF 文字层的拍号优先于 MusicXML 里识别错的 <time>（6/4 被读成 3/4 时不跟着错）", () => {
  // 实测浏览器渲染的裁片里 Audiveris 把印刷 6/4 读成 3/4；以 PDF 文字层的 6/4 为准。
  const score = `<score-partwise>${partList([["P1", "旋律"]])}<part id="P1">
    <measure number="1"><attributes><divisions>4</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><staff>1</staff></note>
    </measure>
    <measure number="2">${note("D", 4, 16)}</measure>
  </part></score-partwise>`;
  const result = parseMusicXmlText(score, { meterMap: ["6/4", "4/4"], strictMeters: true });
  assert.deepEqual(result.measures.map((measure) => measure.lengthBeats), [6, 4], "第一小节按印刷 6/4 算 6 拍");
  assert.equal(result.totalBeats, 10);
});
