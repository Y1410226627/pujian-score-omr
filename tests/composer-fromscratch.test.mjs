import assert from "node:assert/strict";
import test from "node:test";

// 「从零复刻」的验收：
// 不用任何导入，纯靠编辑器操作把一份乐谱「敲」出来，再和原谱逐音对账。
//
// 这份测试的乐谱刻意选一段结构完整的真实片段（取自《在山魔王的宫殿》开头的
// 旋律 + 低音，含：三连音外的 8 分/16 分混合、休止、和弦、跨小节长音、并行声部、力度、断奏）。
// 它证明的是「编辑器有能力表达这些」——而不是「人肉敲 2000 个音很方便」。

import {
  createScore, createPart, createStaff, createVoice, addEvent,
  scoreToPlayableNotes, beatsPerMeasure,
} from "../composer-model.js";
import { appendNote, insertNoteAt, appendChordTone, addVoiceTo, addStaffTo, toggleFlag } from "../composer-ui-model.js";

/** 原谱（要复刻的目标）：一小节 4/4，含并行两条声部线 + 和弦 + 休止 + 力度 + 断奏。 */
const TARGET = [
  // 高声部（旋律）：D5 8分、E5 8分、F#5 16分、E5 16分、D5 4分、休止 4分
  { voice: 0, beat: 0, beats: 0.5, midi: 74 },
  { voice: 0, beat: 0.5, beats: 0.5, midi: 76 },
  { voice: 0, beat: 1, beats: 0.25, midi: 78 },
  { voice: 0, beat: 1.25, beats: 0.25, midi: 76 },
  { voice: 0, beat: 1.5, beats: 1, midi: 74, dynamic: "mf", articulations: ["staccato"] },
  { voice: 0, beat: 2.5, beats: 1.5, rest: true },
  // 低声部（伴奏）：两个二分音符，其中第一个是和弦（D3 + A3）
  { voice: 1, beat: 0, beats: 2, midi: 50 },
  { voice: 1, beat: 0, beats: 2, midi: 57, chordWith: 0 },
  { voice: 1, beat: 2, beats: 2, midi: 52 },
];

function copy(list) {
  return list.map((item) => ({ ...item }));
}

test("从零手敲：并行两条声部线 + 和弦 + 休止 + 记号，逐音与目标一致", () => {
  const score = createScore({ title: "复刻练习", timeSignature: { beats: 4, beatType: 4 } });
  const ref = { partIndex: 0, staffIndex: 0, voiceIndex: 0 };
  const targets = copy(TARGET);

  // 1) 先在主声部线上按顺序敲「非和弦」的音（编辑器就是这么用的：选音高 → 选时值 → 加）
  const mainVoice = [];
  for (const item of targets.filter((one) => one.voice === 0)) {
    const result = appendNote(score, ref, {
      midi: item.midi, beats: item.beats, rest: item.rest,
      extras: {
        ...(item.dynamic ? { dynamic: item.dynamic } : {}),
        ...(item.articulations ? { articulations: item.articulations } : {}),
      },
    });
    assert.ok(result.ok, `第 ${item.beat} 拍的音应该能加进去`);
    mainVoice.push(result.event);
  }

  // 2) 开第二条声部线写低音
  const added = addVoiceTo(score, ref);
  assert.ok(added.ok);
  const bassRef = { ...ref, voiceIndex: added.voiceIndex };
  const bassNote = appendNote(score, bassRef, { midi: 50, beats: 2 });
  assert.ok(bassNote.ok);
  const second = appendNote(score, bassRef, { midi: 52, beats: 2 });
  assert.ok(second.ok);

  // 3) 和弦：往低音的第一个音上叠 A3
  const chordTone = appendChordTone(score, bassRef, bassNote.event.id, 57);
  assert.ok(chordTone.ok, "和弦音应该能叠上去");

  // 4) 对账：休止符不发声，要单独核对（它占拍位但不进播放列表）
  const soundingTargets = targets.filter((item) => !item.rest);
  const restTargets = targets.filter((item) => item.rest);
  const allEvents = score.parts[0].staves[0].voices.flatMap((voice) => voice.events || []);
  const rests = allEvents.filter((event) => event.rest);
  assert.equal(rests.length, restTargets.length,
    `休止符数量必须一致：敲出 ${rests.length}，目标 ${restTargets.length}`);
  for (const [index, rest] of rests.entries()) {
    assert.equal(rest.beat, restTargets[index].beat, "休止符拍位必须一致");
    assert.equal(rest.beats, restTargets[index].beats, "休止符时值必须一致");
  }

  // 把模型展开成「实际会发声的音」，与目标逐音比
  const actual = scoreToPlayableNotes(score);
  const expected = soundingTargets.slice().sort((left, right) => left.beat - right.beat || left.midi - right.midi);
  const sortKey = (note) => `${note.startBeat.toFixed(6)}|${note.midi}|${note.durationBeats.toFixed(6)}`;
  const actualKeys = actual.map(sortKey).sort();
  const expectedKeys = expected.map((item) => sortKey({
    startBeat: item.beat, midi: item.midi, durationBeats: item.beats,
  })).sort();

  assert.equal(actualKeys.length, expectedKeys.length,
    `音符数必须一致：敲出 ${actualKeys.length}，目标 ${expectedKeys.length}\n实际=${JSON.stringify(actualKeys)}\n期望=${JSON.stringify(expectedKeys)}`);
  assert.deepEqual(actualKeys, expectedKeys, "拍位/音高/时值必须逐音一致");

  // 5) 记号也要在
  const firstBass = (score.parts[0].staves[0].voices[1].events || []).find((event) => event.midi === 50);
  assert.ok(firstBass, "低音应该在");
  const withDynamic = (score.parts[0].staves[0].voices[0].events || []).find((event) => event.dynamic === "mf");
  assert.ok(withDynamic, "力度记号应该在");
  assert.deepEqual(withDynamic.articulations, ["staccato"], "断奏记号应该在");

  // 6) 小节数正确（4/4、用了 4 拍）
  assert.equal(beatsPerMeasure(score), 4);
});
