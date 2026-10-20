import assert from "node:assert/strict";
import test from "node:test";

import {
  appendNote, insertNoteAt, appendChordTone, deleteEvent, changeEventBeats,
  changeEventMidi, changeEventBeat, toggleFlag, addVoiceTo, addStaffTo,
  buildMeasureView, describeEvent, explainReason, currentVoice, defaultVoiceRef,
  clampVoiceRef,
} from "../composer-ui-model.js";
import { createScore, createPart, scoreToPlayableNotes } from "../composer-model.js";

function newScore() {
  return createScore({
    title: "复刻测试",
    parts: [createPart({ name: "钢琴" })],
    timeSignature: { beats: 4, beatType: 4 },
  });
}

test("从零开始：依次加的音按拍位接在后面", () => {
  const score = newScore();
  const ref = defaultVoiceRef();
  appendNote(score, ref, { midi: 60, beats: 1 });
  appendNote(score, ref, { midi: 62, beats: 0.5 });
  appendNote(score, ref, { midi: 64, beats: 2 });
  const notes = scoreToPlayableNotes(score);
  assert.deepEqual(notes.map((note) => [note.startBeat, note.durationBeats, note.midi]),
    [[0, 1, 60], [1, 0.5, 62], [1.5, 2, 64]]);
});

test("小节视图：总小节数、每小节的起止拍都对", () => {
  const score = newScore();
  const ref = defaultVoiceRef();
  for (let index = 0; index < 10; index += 1) appendNote(score, ref, { midi: 60 + index, beats: 1 });
  const view = buildMeasureView(score);
  assert.equal(view.beatsPerMeasure, 4);
  assert.equal(view.totalMeasures, 3, "10 拍 / 4 拍 = 2.5 → 3 小节");
  assert.deepEqual(view.measures.map((measure) => measure.startBeat), [0, 4, 8]);
  assert.equal(view.totalBeats, 10);
  // 第 1 小节应该有 4 个音
  assert.equal(view.measures[0].rows[0].events.length, 4);
  // 跨小节：第 3 小节（8–12 拍）里有 8、9 两个音
  assert.equal(view.measures[2].rows[0].events.length, 2);
});

test("拍位被占用时给出人能看懂的提示", () => {
  const score = newScore();
  const ref = defaultVoiceRef();
  appendNote(score, ref, { midi: 60, beats: 4 });
  const conflict = insertNoteAt(score, ref, 2, { midi: 62, beats: 1 });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "overlap");
  assert.match(explainReason(conflict.reason), /已经有音符/);
});

test("和弦：往已有音上叠加，同拍同长", () => {
  const score = newScore();
  const ref = defaultVoiceRef();
  const first = appendNote(score, ref, { midi: 60, beats: 2 });
  const result = appendChordTone(score, ref, first.event.id, 64);
  assert.ok(result.ok);
  const third = appendChordTone(score, ref, first.event.id, 67);
  assert.ok(third.ok);
  const at0 = eventsAtBeatList(currentVoice(score, ref), 0);
  assert.equal(at0.length, 3, "同拍应有 3 个音");
  assert.deepEqual(at0.map((event) => event.midi).sort((a, b) => a - b), [60, 64, 67]);
  assert.ok(at0.every((event) => event.beats === 2), "和弦成员时值一致");
  // NOTE: 拍位是绝对拍位，和弦始於第 0 拍（不是第 1 拍），第 1 拍是下一个位置
  assert.equal(eventsAtBeatList(currentVoice(score, ref), 1).length, 0,
    "第 1 拍是下一个拍位，不和弦所在");
  // 没有锚点时明确报错
  assert.equal(appendChordTone(score, ref, null, 72).ok, false);
});

function eventsAtBeatList(voice, beat) {
  const target = Math.round(beat * 1e6) / 1e6;
  return voice.events.filter((event) => Math.abs(event.beat - target) < 1e-6);
}

test("加第二条 voice 后，两条可以同时从第 0 拍写", () => {
  const score = newScore();
  const ref = defaultVoiceRef();
  appendNote(score, ref, { midi: 72, beats: 1 });          // 右手
  const added = addVoiceTo(score, ref);
  assert.ok(added.ok);
  const leftRef = { ...ref, voiceIndex: added.voiceIndex };
  const bass = appendNote(score, leftRef, { midi: 48, beats: 4 });   // 左手长音
  assert.ok(bass.ok);
  assert.equal(bass.event.beat, 0, "新 voice 从 0 拍开始，不与右手冲突");
  const notes = scoreToPlayableNotes(score);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((note) => note.startBeat).sort(), [0, 0]);
});

test("加第二条谱表（钢琴第二行）", () => {
  const score = newScore();
  const ref = defaultVoiceRef();
  appendNote(score, ref, { midi: 60, beats: 4 });
  const added = addStaffTo(score, ref);
  assert.ok(added.ok);
  const staffRef = { ...ref, staffIndex: added.staffIndex };
  appendNote(score, staffRef, { midi: 36, beats: 4 });
  const view = buildMeasureView(score);
  assert.equal(view.measures[0].rows.length, 2, "两行谱表各占一行");
  assert.equal(view.measures[0].rows[0].staffIndex, 1);
  assert.equal(view.measures[0].rows[1].staffIndex, 2);
});

test("改时值/改音高/移动/删除，失败都带原因", () => {
  const score = newScore();
  const ref = defaultVoiceRef();
  const a = appendNote(score, ref, { midi: 60, beats: 1 });
  const b = appendNote(score, ref, { midi: 62, beats: 1 });
  // 拉长到和 b 冲突
  assert.equal(changeEventBeats(score, ref, a.event.id, 2).reason, "overlap");
  assert.equal(changeEventBeats(score, ref, a.event.id, 1.5).ok, false);
  assert.equal(changeEventBeats(score, ref, a.event.id, 0.5).ok, true);
  // 改音高
  assert.equal(changeEventMidi(score, ref, a.event.id, 72).ok, true);
  assert.equal(changeEventMidi(score, ref, a.event.id, 200).ok, false);
  // 移动到冲突位置
  assert.equal(changeEventBeat(score, ref, b.event.id, 0.25).reason, "overlap");
  assert.equal(changeEventBeat(score, ref, b.event.id, 2).ok, true);
  // 删除
  assert.equal(deleteEvent(score, ref, a.event.id).ok, true);
  assert.equal(deleteEvent(score, ref, a.event.id).ok, false, "删不存在的音返回 false");
});

test("记号开关：力度、断奏、连音线", () => {
  const score = newScore();
  const ref = defaultVoiceRef();
  const { event } = appendNote(score, ref, { midi: 60, beats: 1 });
  assert.equal(toggleFlag(score, ref, event.id, "dynamic", "mf").on, true);
  assert.equal(event.dynamic, "mf");
  assert.equal(toggleFlag(score, ref, event.id, "articulations", "staccato").on, true);
  assert.deepEqual(event.articulations, ["staccato"]);
  assert.equal(toggleFlag(score, ref, event.id, "tie", "start").on, true);
  assert.equal(event.tie, "start");
  // 再点一次取消
  assert.equal(toggleFlag(score, ref, event.id, "dynamic", "mf").on, false);
  assert.equal(event.dynamic, undefined);
});

test("描述足够用于对账（第几小节第几拍）", () => {
  const score = newScore();
  const ref = defaultVoiceRef();
  appendNote(score, ref, { midi: 60, beats: 4 });
  const second = appendNote(score, ref, { midi: 62, beats: 1 });
  assert.equal(describeEvent(score, second.event), "第 2 小节，从第 1 拍开始");
});

test("删声部后 ref 自动收敛，不会崩", () => {
  const score = createScore({ parts: [createPart({ name: "a" }), createPart({ name: "b" })] });
  const ref = { partIndex: 1, staffIndex: 0, voiceIndex: 0 };
  score.parts.pop();
  const clamped = clampVoiceRef(score, ref);
  assert.equal(clamped.partIndex, 0);
  assert.ok(appendNote(score, clamped, { midi: 60, beats: 1 }).ok, "收敛后仍可写入");
});
