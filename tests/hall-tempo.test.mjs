import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { detectStartTempo, playbackTempoSegments, midiTempoEvents } from "../tempo.js";

// 真实数据：Hall 曲《在山魔王的宫殿》从 PDF 文字层读到的 22 处速度标记（2026-10-19 实测）
const HALL_TEMPO_MARKS = [
  { bar: null, bpm: 138, page: 1 },
  { bar: 6, bpm: 80, page: 1 },
  { bar: 7, bpm: 85, page: 1 },
  { bar: 12, bpm: 90, page: 1 },
  { bar: 16, bpm: 95, page: 1 },
  { bar: 17, bpm: 110, page: 2 },
  { bar: 17, bpm: 115, page: 2 },
  { bar: 22, bpm: 120, page: 2 },
  { bar: 26, bpm: 130, page: 3 },
  { bar: 30, bpm: 135, page: 3 },
  { bar: 34, bpm: 140, page: 3 },
  { bar: 38, bpm: 145, page: 4 },
  { bar: 42, bpm: 155, page: 4 },
  { bar: 46, bpm: 160, page: 5 },
  { bar: 46, bpm: 165, page: 5 },
  { bar: 50, bpm: 170, page: 5 },
  { bar: 54, bpm: 175, page: 5 },
  { bar: 58, bpm: 180, page: 5 },
  { bar: 62, bpm: 185, page: 6 },
  { bar: 66, bpm: 190, page: 7 },
  { bar: 70, bpm: 195, page: 7 },
  { bar: 74, bpm: 200, page: 7 },
];

// 把 (页, 印刷小节号, BPM) 换算成播放用的拍位（4/4：每小节 4 拍）
function marksToBeats(marks, beatsPerMeasure = 4) {
  const seen = new Set();
  const result = [];
  for (const mark of [...marks].sort((a, b) => (a.bar || 1) - (b.bar || 1))) {
    const beat = mark.bar ? (mark.bar - 1) * beatsPerMeasure : 0;
    const key = `${beat}|${mark.bpm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ beat, bpm: mark.bpm });
  }
  return result;
}

const hallBeats = marksToBeats(HALL_TEMPO_MARKS);

test("Hall 曲速度标记：从印刷小节号换算成拍位，开头是 ♩=138", () => {
  assert.equal(hallBeats[0].beat, 0);
  assert.equal(hallBeats[0].bpm, 138, "乐曲开头就是 ♩=138（Alla marcia e molto marcato）");
  assert.equal(hallBeats[1].beat, 20, "第 6 小节 → 第 20 拍");
  assert.equal(hallBeats[1].bpm, 80);
  assert.equal(hallBeats.at(-1).beat, 292, "第 74 小节 → 第 292 拍");
  assert.equal(hallBeats.at(-1).bpm, 200);
});

test("Hall 曲：起始速度用第 0 拍的 138，而不是默认 84", () => {
  const detected = detectStartTempo(hallBeats);
  assert.deepEqual(detected, { bpm: 138, beat: 0, source: "opening" },
    "第 0 拍有标记时必须直接用它（此前会回退默认 84，用户听到的就是错的）");
});

test("Hall 曲：21 个变速段按拍位生效，播放会一段一段变速", () => {
  const plan = playbackTempoSegments(hallBeats, { detectedBpm: 138, userBpm: 138 });
  assert.equal(plan.startBpm, 138);
  // playbackTempoSegments 会把第 0 拍的标记也放进 segments（beat=0），共 22 段
  assert.equal(plan.segments.length, 22, "22 处标记全部成为变速段");
  assert.deepEqual(plan.segments[0], { beat: 0, bpm: 138 });
  assert.deepEqual(plan.segments[1], { beat: 20, bpm: 80 });
  assert.deepEqual(plan.segments[2], { beat: 24, bpm: 85 });
  // 第 4 小节（前 20 拍）在 138 下是 20×60/138 ≈ 8.7 秒
  const secondsAtBeat = (beat) => {
    let seconds = 0; let previous = 0; let bpm = plan.startBpm;
    for (const segment of plan.segments) {
      if (segment.beat >= beat) break;
      seconds += (segment.beat - previous) * (60 / bpm);
      previous = segment.beat;
      bpm = segment.bpm;
    }
    return seconds + Math.max(0, beat - previous) * (60 / bpm);
  };
  assert.ok(Math.abs(secondsAtBeat(20) - (20 * 60) / 138) < 1e-9, "前 20 拍按 138 算");
  assert.ok(Math.abs(secondsAtBeat(24) - ((20 * 60) / 138 + 4 * 0.75)) < 1e-9, "第 21–24 拍按 80 算");
  // 中间没有变速（第 20–24 拍之间是 80，不是 138）
  assert.ok(secondsAtBeat(22) > secondsAtBeat(21), "同样的 1 拍，越往后越快");
});

test("Hall 曲：用户整体改 BPM 时变速比例保留", () => {
  const faster = playbackTempoSegments(hallBeats, { detectedBpm: 138, userBpm: 138 * 1.2 });
  assert.equal(faster.startBpm, Math.round(138 * 1.2 * 10) / 10 > 165.6 ? 165.6 : faster.startBpm);
  // 起始速度是 165.6（138×1.2），中段 80 应缩放为 96
  const segment80 = faster.segments.find((segment) => segment.beat === 20);
  assert.equal(segment80.bpm, Math.round(80 * 1.2), "80×1.2=96，比例保留");
});

test("Hall 曲：导出的 MIDI 里写 22 个速度事件", () => {
  const events = midiTempoEvents(hallBeats, { detectedBpm: 138, userBpm: 138, ticksPerBeat: 480 });
  // 第 17 小节（110→115）与第 46 小节（160→165）各有两处标记印在同一拍位，
  // MIDI 的同一 tick 只能有一个速度事件，后一处覆盖前一处 → 20 个。
  assert.equal(events.length, 20, "同一拍位的重复标记会合并成一个 MIDI 速度事件");
  assert.equal(events[0].tick, 0);
  assert.equal(events[0].microsPerBeat, Math.round(60000000 / 138));
  assert.equal(events[1].tick, 20 * 480, "第 6 小节的速度在 tick 9600");
  assert.equal(events.at(-1).tick, 292 * 480);
  // tick 单调递增
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].tick > events[index - 1].tick, "速度事件 tick 必须递增");
  }
});

test("真实 PDF 文字层数据文件与转换结果一致（防止回归）", () => {
  const fixture = readFileSync(new URL("./fixtures/hall_tempo_marks.json", import.meta.url), "utf8");
  const marks = JSON.parse(fixture);
  assert.equal(marks.length, 22, "Hall 曲共 22 处速度标记");
  assert.equal(marks[0].bpm, 138);
  assert.equal(marks.at(-1).bpm, 200);
  // 每一处都要有页码和 BPM
  for (const mark of marks) {
    assert.ok(mark.page >= 1 && mark.page <= 8, "页码在 1–8 之间");
    assert.ok(mark.bpm >= 20 && mark.bpm <= 320, "速度在合理范围");
  }
});
