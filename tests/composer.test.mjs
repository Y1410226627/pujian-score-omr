import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTE_VALUES, REST_VALUES, isRest, soundingNoteCount, midiToName, nameToMidi, isBlackKey, nearestNoteValue,
  usedBeats, remainingBeats, buildMeasureSlots, canAppend, createScore, createPart,
  emptyMeasure, appendNote, removeNote, setNoteBeats, transposeNote,
  trimTrailingEmptyMeasures, scoreToPlayableNotes, scoreTotalBeats, cloneScore, accidentalFor,
} from "../composer.js";

test("音名与 MIDI 双向换算（含升降号与中央 C）", () => {
  assert.equal(midiToName(60), "C4");
  assert.equal(midiToName(61), "C♯4");
  assert.equal(midiToName(63, { flat: true }), "E♭4", "降号写法用于降号调");
  assert.equal(midiToName(69), "A4");
  assert.equal(nameToMidi("C4"), 60);
  assert.equal(nameToMidi("F#3"), 52);
  assert.equal(nameToMidi("Bb2"), 41);
  assert.equal(nameToMidi("C♯4"), 61);
  assert.ok(Number.isNaN(nameToMidi("H4")));
  assert.equal(isBlackKey(61), true);
  assert.equal(isBlackKey(60), false);
});

test("时值选项对零基础用户是「几分之几拍」，且顺序从长到短", () => {
  assert.equal(NOTE_VALUES[0].beats, 4);
  const beats = NOTE_VALUES.map((item) => item.beats);
  for (let index = 1; index < beats.length; index += 1) assert.ok(beats[index] < beats[index - 1]);
  assert.equal(REST_VALUES.length, NOTE_VALUES.length);
  assert.ok(REST_VALUES.every((item) => item.rest === true));
  assert.equal(nearestNoteValue(0.98).beats, 1);
  assert.equal(nearestNoteValue(0.52).beats, 0.5);
});

test("小节拍数统计与剩余空间", () => {
  const measure = { beats: [{ midi: 60, beats: 1 }, { midi: 62, beats: 2 }, { midi: 64, beats: 0.5 }] };
  assert.equal(usedBeats(measure), 3.5);
  assert.equal(remainingBeats(measure, 4), 0.5);
  assert.equal(remainingBeats({ beats: [] }, 3), 3);
  assert.equal(usedBeats(null), 0);
});

test("buildMeasureSlots 从 0 开始依次排开，并给出剩余拍", () => {
  const measure = { beats: [{ id: "a", midi: 60, beats: 1 }, { id: "b", midi: 62, beats: 2 }] };
  const { slots, used, remaining } = buildMeasureSlots(measure, 4);
  assert.deepEqual(slots.map((slot) => [slot.startBeats, slot.endBeats]), [[0, 1], [1, 3]]);
  assert.equal(used, 3);
  assert.equal(remaining, 1);
});

test("放不下的音会自动开新小节（不会悄悄丢音）", () => {
  const part = createPart({ name: "旋律" });
  appendNote(part, { midi: 60, beats: 2 }, 4);
  appendNote(part, { midi: 62, beats: 2 }, 4);
  assert.equal(part.measures.length, 1, "刚好填满一小节");
  assert.equal(remainingBeats(part.measures[0], 4), 0);
  const placed = appendNote(part, { midi: 64, beats: 1 }, 4);
  assert.equal(placed.measureIndex, 1, "第三拍放不进去，应自动到第 2 小节");
  assert.equal(part.measures.length, 2);
});

test("放不下时 canAppend 会给出原因，界面可据此提示", () => {
  const full = { beats: [{ midi: 60, beats: 4 }] };
  assert.deepEqual(canAppend(full, { beats: 1 }, 4), { ok: false, reason: "full" });
  const half = { beats: [{ midi: 60, beats: 3.5 }] };
  assert.deepEqual(canAppend(half, { beats: 1 }, 4), { ok: false, reason: "too-long" });
  assert.equal(canAppend(half, { beats: 0.5 }, 4).ok, true);
});

test("删除、改时值、移调都在「不破坏小节拍数」的前提下生效", () => {
  const part = createPart();
  const { note } = appendNote(part, { midi: 60, beats: 1 }, 4);
  assert.equal(setNoteBeats(part, note.id, 3, 4), true);
  assert.equal(usedBeats(part.measures[0]), 3);
  assert.equal(setNoteBeats(part, note.id, 5, 4), false, "超过小节总拍数要被拒绝");
  assert.equal(transposeNote(part, note.id, 2), true);
  assert.equal(part.measures[0].beats[0].midi, 62);
  assert.equal(removeNote(part, note.id), true);
  assert.equal(part.measures[0].beats.length, 0);
  assert.equal(removeNote(part, "不存在"), false);
});

test("多声部按小节对齐：同时开始、各自独立", () => {
  const score = createScore({ beatsPerMeasure: 4 });
  score.parts = [createPart({ name: "旋律" }), createPart({ name: "伴奏" })];
  appendNote(score.parts[0], { midi: 72, beats: 4 }, 4);
  appendNote(score.parts[1], { midi: 48, beats: 2 }, 4);
  appendNote(score.parts[1], { midi: 50, beats: 2 }, 4);
  appendNote(score.parts[0], { midi: 74, beats: 4 }, 4);
  appendNote(score.parts[1], { midi: 52, beats: 4 }, 4);
  const notes = scoreToPlayableNotes(score);
  assert.equal(notes.length, 5);
  const firstMelody = notes.find((note) => note.partName === "旋律");
  const firstAccomp = notes.find((note) => note.partName === "伴奏");
  assert.equal(firstMelody.startBeat, 0);
  assert.equal(firstAccomp.startBeat, 0);
  const secondMelody = notes.filter((note) => note.partName === "旋律")[1];
  assert.equal(secondMelody.startBeat, 4, "第二个音在第二小节开头");
  assert.equal(scoreTotalBeats(score), 8);
});

test("末尾的空小节不导出、不加长播放时间", () => {
  const score = createScore();
  const part = score.parts[0];
  appendNote(part, { midi: 60, beats: 4 }, 4);
  part.measures.push(emptyMeasure(), emptyMeasure());
  assert.equal(scoreTotalBeats(score), 4);
  trimTrailingEmptyMeasures(part);
  assert.equal(part.measures.length, 1);
  assert.equal(scoreToPlayableNotes(score).length, 1);
});

test("cloneScore 是深拷贝，撤销不会把改动串回当前编辑", () => {
  const score = createScore();
  appendNote(score.parts[0], { midi: 60, beats: 1 }, 4);
  const snapshot = cloneScore(score);
  appendNote(score.parts[0], { midi: 62, beats: 1 }, 4);
  assert.equal(score.parts[0].measures[0].beats.length, 2);
  assert.equal(snapshot.parts[0].measures[0].beats.length, 1);
});

test("休止符占拍但不发声：可以加到小节里，播放/导出时被跳过", () => {
  const score = createScore({ beatsPerMeasure: 4 });
  const part = score.parts[0];
  appendNote(part, { midi: 60, beats: 1 }, 4);
  appendNote(part, { rest: true, beats: 1 }, 4);
  appendNote(part, { midi: 62, beats: 2 }, 4);
  assert.equal(usedBeats(part.measures[0]), 4, "休止符也要占拍数");
  assert.equal(part.measures[0].beats.length, 3);
  assert.equal(isRest(part.measures[0].beats[1]), true);
  assert.equal(soundingNoteCount(part), 2, "只数有音高的音");
  const playable = scoreToPlayableNotes(score);
  assert.equal(playable.length, 2, "休止符不应进入播放列表");
  assert.deepEqual(playable.map((note) => note.startBeat), [0, 2], "休止符占掉的那一拍让后一个音从第 2 拍开始");
});

test("整小节都是休止：能建出来、不发声、拍数仍然齐", () => {
  const score = createScore({ beatsPerMeasure: 4 });
  const part = score.parts[0];
  appendNote(part, { rest: true, beats: 4 }, 4);
  assert.equal(usedBeats(part.measures[0]), 4);
  assert.equal(scoreToPlayableNotes(score).length, 0);
  assert.equal(soundingNoteCount(part), 0);
});

test("临时升降号：按调号习惯拼写，该标的标、该还原的还原", () => {
  // C 大调：黑键要标升号，白键不标
  assert.equal(accidentalFor(61, 0), "#");
  assert.equal(accidentalFor(60, 0), null);
  assert.equal(accidentalFor(66, 0), "#");
  // G 大调：F 已被调号升过，F# 不标；F 自然要标还原号
  assert.equal(accidentalFor(66, 1), null);
  assert.equal(accidentalFor(65, 1), "n");
  // F 大调：B 已被调号降过，Bb 不标；B 自然要标还原号；Db 要标降号
  assert.equal(accidentalFor(58, -1), null);
  assert.equal(accidentalFor(59, -1), "n");
  assert.equal(accidentalFor(61, -1), "b");
  // 降 B 大调：Eb 已被调号降过，不标
  assert.equal(accidentalFor(63, -2), null);
  assert.equal(accidentalFor(62, -2), null);
  // 极端：超出音域也不崩（返回 null 或升降号都算正常）
  assert.ok([null, "#", "b", "n"].includes(accidentalFor(-5, 0)));
  assert.equal(accidentalFor(60, 99), null);
});
