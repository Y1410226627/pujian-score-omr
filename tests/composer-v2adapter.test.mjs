import assert from "node:assert/strict";
import test from "node:test";

import { v2ScoreToV1, isV2Part, v2EventsOf, v2VoiceFor, writeBackEvent } from "../composer-v2adapter.js";
import {
  addEvent, createScore, createPart, createStaff, createVoice,
} from "../composer-model.js";

/** 造一份 v2 谱：一条旋律 + 一条低音（并行）+ 一个和弦 + 一个跨小节长音 */
function makeV2() {
  const melody = createVoice({ id: "melody" });
  melody.number = 1;
  const bass = createVoice({ id: "bass" });
  bass.number = 2;
  addEvent(melody, { beat: 0, beats: 1, midi: 72 });
  addEvent(melody, { beat: 1, beats: 1, midi: 64 });
  addEvent(melody, { beat: 2, beats: 1, midi: 67 });
  // 和弦（同拍三音）
  const chord = addEvent(melody, { beat: 3, beats: 1, midi: 60 });
  addEvent(melody, { beat: 3, beats: 1, midi: 64, chordWith: chord.event.id });
  addEvent(melody, { beat: 3, beats: 1, midi: 67, chordWith: chord.event.id });
  addEvent(bass, { beat: 0, beats: 8, midi: 36 });      // 跨小节长音（0–8 拍）
  addEvent(bass, { beat: 8, beats: 4, midi: 43 });      // 接着 8–12 拍
  const staff = createStaff({ id: "s1", voices: [melody, bass] });
  staff.number = 1;
  const part = createPart({ id: "p1", name: "钢琴", timbre: "erhu_real", staves: [staff] });
  return createScore({ title: "复刻", parts: [part] });
}

test("v2 → v1：并行 voice 变成独立声部，互不挤占", () => {
  const v2 = makeV2();
  const v1 = v2ScoreToV1(v2);
  assert.equal(v1.parts.length, 2, "两条 voice → 两个 v1 声部");
  assert.match(v1.parts[0].name, /钢琴/);
  assert.match(v1.parts[0].name, /声部线1/);
  assert.match(v1.parts[1].name, /声部线2/);
  // 旋律声部：第 1 小节 4 个音（3 单音 + 1 和弦）
  const melody = v1.parts[0];
  assert.equal(melody.measures.length, 1);
  assert.equal(melody.measures[0].beats.length, 4);
  const chordBeat = melody.measures[0].beats[3];
  assert.equal(chordBeat.midi, 60, "和弦主音");
  assert.equal(Array.isArray(chordBeat.chordMidis), true);
  // 低音：8 拍长音 + 4 拍
  const bass = v1.parts[1];
  assert.equal(bass.measures.length, 3, "12 拍 = 3 小节");
});

test("v2 → v1：跨小节长音被拆成多段并标出连音线来源", () => {
  const v2 = makeV2();
  const v1 = v2ScoreToV1(v2);
  const bass = v1.parts[1];
  const firstBeat = bass.measures[0].beats[0];
  assert.equal(firstBeat.beats, 4, "第 1 小节占满 4 拍");
  assert.equal(firstBeat.tieFromPrev, undefined, "第一段不是续接");
  assert.equal(bass.measures[1].beats[0].beats, 4, "第 2 小节同样 4 拍");
  assert.equal(bass.measures[1].beats[0].tieFromPrev, true, "第二段是续接");
  // 但 v2 里始终是一个事件
  const events = v2EventsOf(bass);
  const longNote = events.find((event) => event.midi === 36);
  assert.equal(longNote.beats, 8, "v2 模型里仍是 8 拍，没被拆断");
});

test("v2 → v1：空隙补休止，拍位不漂移", () => {
  const melody = createVoice({ id: "m" });
  addEvent(melody, { beat: 0, beats: 1, midi: 60 });
  addEvent(melody, { beat: 3, beats: 1, midi: 62 });   // 中间空 2 拍
  const score = createScore({ parts: [createPart({ staves: [createStaff({ voices: [melody] })] })] });
  const v1 = v2ScoreToV1(score);
  const beats = v1.parts[0].measures[0].beats;
  assert.equal(beats.length, 3, "1 音 + 2 拍休止 + 1 音");
  assert.deepEqual(beats.map((beat) => beat.rest ? "rest" : beat.midi), [60, "rest", 62]);
  assert.equal(beats[1].beats, 2);
});

test("写回：v1 侧改音高/时值/记号，同步到 v2 同一个事件", () => {
  const v2 = makeV2();
  const v1 = v2ScoreToV1(v2);
  const beat = v1.parts[0].measures[0].beats[1];      // 第 2 拍的音
  const before = beat.midi;
  writeBackEvent(v2, v1.parts[0], beat, { midi: 74 });
  assert.equal(beat.v2Event.midi, 74, "v2 事件音高跟着变");
  assert.equal(beat.midi, before, "v1 视图自身不变（写回只改 v2）");
  writeBackEvent(v2, v1.parts[0], beat, { beats: 2 });
  assert.equal(beat.v2Event.beats, 2);
  writeBackEvent(v2, v1.parts[0], beat, { flagKey: "dynamic", flagValue: "mf" });
  assert.equal(beat.v2Event.dynamic, "mf");
  writeBackEvent(v2, v1.parts[0], beat, { flagKey: "dynamic", flagValue: "mf" });
  assert.equal(beat.v2Event.dynamic, undefined, "再点一次取消");
  writeBackEvent(v2, v1.parts[0], beat, { flagKey: "articulations", flagValue: "staccato" });
  assert.deepEqual(beat.v2Event.articulations, ["staccato"]);
});

test("v1 声部的音色/音量/谱号都带过来（复刻要用同一件乐器）", () => {
  const v2 = makeV2();
  const v1 = v2ScoreToV1(v2);
  assert.equal(v1.parts[0].timbre, "erhu_real");
  assert.equal(v1.parts[0].clef, "treble");
  assert.equal(v1.keyFifths, 0);
  assert.equal(v1.beatsPerMeasure, 4);
});

test("isV2Part 判断正确", () => {
  const v1 = v2ScoreToV1(makeV2());
  assert.equal(isV2Part(v1.parts[0]), true);
  assert.equal(isV2Part({ id: "x" }), false);
});

test("v2VoiceFor 能找回对应 voice（加和弦/记号要用）", () => {
  const v2 = makeV2();
  const v1 = v2ScoreToV1(v2);
  const voice = v2VoiceFor(v1.parts[1]);
  assert.ok(voice);
  assert.equal(voice.id, "bass");
});
