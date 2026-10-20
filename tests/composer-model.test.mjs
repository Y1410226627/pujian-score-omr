import assert from "node:assert/strict";
import test from "node:test";

import {
  createScore, createPart, createStaff, createVoice, createEvent,
  addEvent, removeEvent, setEventBeats, moveEvent, setEventMidi, toggleEventFlag,
  eventsAtBeat, isRangeFree, scoreTotalBeats, measureCount, beatsPerMeasure,
  scoreToPlayableNotes, NOTE_VALUES, REST_VALUES, DYNAMICS, ARTICULATIONS, ORNAMENTS,
  cloneScore, voiceEndBeat, measureStartBeat,
} from "../composer-model.js";

function scoreWithVoice() {
  const voice = createVoice({ id: "v1" });
  const staff = createStaff({ id: "s1", voices: [voice] });
  const part = createPart({ id: "p1", name: "钢琴", staves: [staff] });
  const score = createScore({ id: "sc", parts: [part], timeSignature: { beats: 4, beatType: 4 } });
  return { score, part, staff, voice };
}

test("时值选项覆盖真实乐谱需要的全部档位", () => {
  const beats = NOTE_VALUES.map((item) => item.beats);
  // 必须有：倍全、全、附点二分、二分、附点四分、四分、附点八分、八分、附点16、16、附点32、32、64
  for (const expected of [8, 6, 4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.1875, 0.125, 0.0625]) {
    assert.ok(beats.some((value) => Math.abs(value - expected) < 1e-9), `缺少 ${expected} 拍时值`);
  }
  // 三连音
  assert.ok(beats.some((value) => Math.abs(value - 2 / 3) < 1e-6), "缺少四分三连音");
  assert.ok(beats.some((value) => Math.abs(value - 1 / 3) < 1e-6), "缺少八分三连音");
  assert.ok(NOTE_VALUES.length >= 17, `时值档位应有 17 种以上，实际 ${NOTE_VALUES.length}`);
  assert.equal(REST_VALUES.length, NOTE_VALUES.length, "休止符与音符一一对应");
});

test("力度/演奏记号/装饰音都齐全", () => {
  assert.ok(DYNAMICS.length >= 8, "力度记号应覆盖 ppp–fff");
  assert.deepEqual(DYNAMICS.map((item) => item.key).slice(0, 8),
    ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"]);
  assert.ok(ARTICULATIONS.some((item) => item.key === "staccato"));
  assert.ok(ARTICULATIONS.some((item) => item.key === "accent"));
  assert.ok(ARTICULATIONS.some((item) => item.key === "fermata"));
  assert.ok(ORNAMENTS.some((item) => item.key === "trill"));
  assert.ok(ORNAMENTS.some((item) => item.key === "grace"));
});

test("绝对拍位：同一小节内可并行两条 voice（旧模型做不到）", () => {
  const { part } = scoreWithVoice();
  const staff = part.staves[0];
  const voice1 = staff.voices[0];                                  // 右手旋律
  const voice2 = createVoice({ id: "v2" });
  staff.voices.push(voice2);                                        // 左手伴奏

  // 两条 voice 都从第 0 拍开始，彼此不冲突
  const a = addEvent(voice1, { beat: 0, beats: 1, midi: 72 });
  const b = addEvent(voice2, { beat: 0, beats: 2, midi: 48 });
  assert.ok(a.ok, "voice1 第 0 拍应能放音");
  assert.ok(b.ok, "voice2 第 0 拍也应能放音（并行声部不互相挤占）");
  assert.equal(voice1.events.length, 1);
  assert.equal(voice2.events.length, 1);
});

test("同一 voice 内拍位冲突会被明确拒绝", () => {
  const { voice } = scoreWithVoice();
  assert.ok(addEvent(voice, { beat: 0, beats: 2, midi: 60 }).ok);
  const conflict = addEvent(voice, { beat: 1, beats: 1, midi: 62 });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "overlap");
  assert.equal(conflict.conflict.length, 1, "应指出和哪个音冲突");
  // 紧挨着（第 2 拍）就可以
  assert.ok(addEvent(voice, { beat: 2, beats: 1, midi: 62 }).ok);
});

test("和弦：同拍多音，删除主音连带删除附加音", () => {
  const { voice } = scoreWithVoice();
  const main = addEvent(voice, { beat: 0, beats: 1, midi: 60 });
  assert.ok(main.ok);
  const third = addEvent(voice, { beat: 0, beats: 1, midi: 64, chordWith: main.event.id });
  const fifth = addEvent(voice, { beat: 0, beats: 1, midi: 67, chordWith: main.event.id });
  assert.ok(third.ok && fifth.ok);
  assert.equal(eventsAtBeat(voice, 0).length, 3, "第 0 拍应有 3 个音");
  assert.equal(isRangeFree(voice, 1, 1), true, "和弦不额外占用时间");
  removeEvent(voice, main.event.id);
  assert.equal(voice.events.length, 0, "删主音时和弦附加音一并删除");
});

test("跨小节长音：一个事件就能表达，不需要拆段", () => {
  const { voice } = scoreWithVoice();
  // 第 3 拍开始，长 5 拍 → 跨过小节线
  const result = addEvent(voice, { beat: 3, beats: 5, midi: 60, tie: "start" });
  assert.ok(result.ok);
  assert.equal(scoreTotalBeats({ parts: [{ staves: [{ voices: [voice] }] }] }), 8);
  const playable = scoreToPlayableNotes({ parts: [{ id: "p", staves: [{ voices: [voice] }] }] });
  assert.equal(playable[0].durationBeats, 5, "时值不被打断");
});

test("三连音：三个音精确占两拍的时间", () => {
  const { voice } = scoreWithVoice();
  const step = 2 / 3;
  for (let index = 0; index < 3; index += 1) {
    const result = addEvent(voice, { beat: index * step, beats: step, midi: 60 + index, tuplet: 3 });
    assert.ok(result.ok, `第 ${index} 个三连音应能放下`);
  }
  assert.equal(voiceEndBeat(voice), 2, "三个四分三连音正好占 2 拍");
});

test("改时值/移动/改音高都带冲突检查", () => {
  const { voice } = scoreWithVoice();
  const first = addEvent(voice, { beat: 0, beats: 1, midi: 60 });
  const second = addEvent(voice, { beat: 1, beats: 1, midi: 62 });
  // 把第一个音拉长到 2 拍 → 会和第二个冲突
  assert.equal(setEventBeats(voice, first.event.id, 2).ok, false);
  assert.equal(setEventBeats(voice, first.event.id, 0.5).ok, true, "缩短可以");
  // 移动到冲突位置不行，移动到空位可以
  assert.equal(moveEvent(voice, second.event.id, 0.25).ok, false);
  assert.equal(moveEvent(voice, second.event.id, 3).ok, true);
  // 音高范围
  assert.equal(setEventMidi(voice, first.event.id, 128).ok, false);
  assert.equal(setEventMidi(voice, first.event.id, 72).ok, true);
  assert.equal(voiceEndBeat(voice), 4);
});

test("演奏记号可以开关（再点一次取消）", () => {
  const { voice } = scoreWithVoice();
  const { event } = addEvent(voice, { beat: 0, beats: 1, midi: 60 });
  assert.equal(toggleEventFlag(voice, event.id, "articulations", "staccato").on, true);
  assert.deepEqual(event.articulations, ["staccato"]);
  assert.equal(toggleEventFlag(voice, event.id, "articulations", "staccato").on, false);
  assert.deepEqual(event.articulations, []);
  assert.equal(toggleEventFlag(voice, event.id, "dynamic", "mf").on, true);
  assert.equal(event.dynamic, "mf");
  assert.equal(toggleEventFlag(voice, event.id, "dynamic", "mf").on, false);
  assert.equal(event.dynamic, undefined);
});

test("连音线/圆滑线/临时记号都能标", () => {
  const { voice } = scoreWithVoice();
  const { event } = addEvent(voice, {
    beat: 0, beats: 1, midi: 61, tie: "start", slur: "start", accidental: "sharp",
  });
  assert.equal(event.tie, "start");
  assert.equal(event.slur, "start");
  assert.equal(event.accidental, "sharp");
});

test("小节与总长度计算（含拍号变化的影响）", () => {
  const voice = createVoice();
  addEvent(voice, { beat: 0, beats: 4, midi: 60 });
  addEvent(voice, { beat: 4, beats: 4, midi: 62 });
  const score = createScore({
    parts: [createPart({ staves: [createStaff({ voices: [voice] })] })],
    timeSignature: { beats: 4, beatType: 4 },
  });
  assert.equal(beatsPerMeasure(score), 4);
  assert.equal(measureCount(score), 2);
  assert.equal(measureStartBeat(score, 1), 4);
  // 3/8 = 1.5 拍一小节
  const waltz = createScore({
    parts: [createPart({ staves: [createStaff({ voices: [voice] })] })],
    timeSignature: { beats: 3, beatType: 8 },
  });
  assert.equal(beatsPerMeasure(waltz), 1.5);
  assert.ok(measureCount(waltz) >= 5, "8 拍在 3/8 里应跨多小节");
});

test("深拷贝用于撤销（改副本不影响原谱）", () => {
  const { score, voice } = scoreWithVoice();
  addEvent(voice, { beat: 0, beats: 1, midi: 60 });
  const snapshot = cloneScore(score);
  addEvent(voice, { beat: 1, beats: 1, midi: 62 });
  assert.equal(score.parts[0].staves[0].voices[0].events.length, 2);
  assert.equal(snapshot.parts[0].staves[0].voices[0].events.length, 1, "快照不受后续修改影响");
});

test("播放列表包含全部声部/和弦，时间正确", () => {
  const { part } = scoreWithVoice();
  const staff = part.staves[0];
  const v2 = createVoice({ id: "v2" });
  staff.voices.push(v2);
  const main = addEvent(staff.voices[0], { beat: 0, beats: 1, midi: 72 });
  addEvent(staff.voices[0], { beat: 0, beats: 1, midi: 76, chordWith: main.event.id });
  addEvent(v2, { beat: 0, beats: 2, midi: 48 });
  addEvent(v2, { beat: 2, beats: 2, midi: 50, rest: true });
  const notes = scoreToPlayableNotes({ parts: [part] });
  assert.equal(notes.length, 3, "两个旋律音（和弦）+ 一个低音，休止不算");
  assert.ok(notes.every((note) => note.startBeat >= 0));
  assert.equal(notes.filter((note) => note.midi === 48)[0].durationBeats, 2);
});
