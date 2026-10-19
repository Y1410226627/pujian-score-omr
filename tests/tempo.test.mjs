import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTempoMap, clampTempo, detectStartTempo, playbackTempoSegments, midiTempoEvents,
} from "../tempo.js";

test("速度换算：没有变速时就是简单相乘", () => {
  const map = buildTempoMap([], 60);
  assert.equal(map.startBpm, 60);
  assert.equal(map.secondsAtBeat(0), 0);
  assert.equal(map.secondsAtBeat(4), 4, "60 BPM 下 4 拍 = 4 秒");
  assert.equal(map.secondsAtBeat(8), 8);
});

test("速度换算：中途变速后，前后段各按自己的 BPM 累计", () => {
  // 0 拍起 60 BPM（1 秒/拍），第 4 拍起 120 BPM（0.5 秒/拍）
  const map = buildTempoMap([{ beat: 4, bpm: 120 }], 60);
  assert.equal(map.secondsAtBeat(2), 2);
  assert.equal(map.secondsAtBeat(4), 4);
  assert.equal(map.secondsAtBeat(8), 6, "第 4 拍后 4 拍只要 2 秒");
  assert.equal(map.bpmAtBeat(3.9), 60);
  assert.equal(map.bpmAtBeat(4), 120);
});

test("速度换算：多个变速段和重复标记都处理正确", () => {
  const map = buildTempoMap([
    { beat: 8, bpm: 60 }, { beat: 4, bpm: 120 }, { beat: 4, bpm: 120 }, { beat: 12, bpm: 180 },
  ], 90);
  // 第 0 拍没有标记 → 起始速度取 fallback 90（1.5 拍/秒 = 0.667 秒/拍）
  // 0–4 拍 @90 → 4×2/3 ≈ 2.667 秒；4 拍后 @120 → 每秒 2 拍；8 拍后 @60
  assert.equal(map.startBpm, 90);
  assert.ok(Math.abs(map.secondsAtBeat(4) - 4 * (60 / 90)) < 1e-9);
  assert.ok(Math.abs(map.secondsAtBeat(8) - (4 * (60 / 90) + 4 * 0.5)) < 1e-9);
  assert.equal(map.bpmAtBeat(12), 180);
  // 非法值被忽略
  const dirty = buildTempoMap([{ beat: 2, bpm: 0 }, { beat: 3, bpm: NaN }], 100);
  assert.equal(dirty.secondsAtBeat(1), 0.6);
  assert.equal(clampTempo(1), 20);
  assert.equal(clampTempo(9999), 320);
});

test("自动识别起始 BPM：第 0 拍有标记优先", () => {
  const result = detectStartTempo([{ beat: 0, bpm: 138 }, { beat: 40, bpm: 96 }]);
  assert.deepEqual(result, { bpm: 138, beat: 0, source: "opening" });
});

test("自动识别起始 BPM：只在后面出现一次时，用它而不是默认值", () => {
  // Hall of the Mountain King 这类：起始没印，第二页才印 ♩=138
  const result = detectStartTempo([{ beat: 6, bpm: 138 }]);
  assert.equal(result.bpm, 138);
  assert.equal(result.source, "single");
  const two = detectStartTempo([{ beat: 6, bpm: 138 }, { beat: 30, bpm: 160 }]);
  assert.equal(two.bpm, 138, "多种速度时取最早的那个");
  assert.equal(two.source, "earliest");
  assert.equal(detectStartTempo([]), null, "完全没有速度标记时返回 null，让界面提示手填");
});

test("播放分段：用户没改 BPM 时完全按谱面变速", () => {
  const marks = [{ beat: 0, bpm: 100 }, { beat: 8, bpm: 150 }];
  const result = playbackTempoSegments(marks, { detectedBpm: 100, userBpm: 100 });
  assert.equal(result.startBpm, 100);
  assert.deepEqual(result.segments, [{ beat: 0, bpm: 100 }, { beat: 8, bpm: 150 }]);
});

test("播放分段：用户改 BPM 时按比例整体缩放，变速比例保留", () => {
  const marks = [{ beat: 0, bpm: 100 }, { beat: 8, bpm: 150 }];
  const result = playbackTempoSegments(marks, { detectedBpm: 100, userBpm: 120 });
  assert.equal(result.startBpm, 120, "整体放慢到 120%");
  assert.equal(result.segments[1].bpm, 180, "中段变速比例 1.5 倍保留：150×1.2=180");
});

test("播放分段：选区起点之前的速度作为起始速度", () => {
  const marks = [{ beat: 0, bpm: 100 }, { beat: 8, bpm: 150 }, { beat: 16, bpm: 90 }];
  const result = playbackTempoSegments(marks, { offset: 8, detectedBpm: 100, userBpm: 100 });
  assert.equal(result.startBpm, 150);
  assert.ok(!result.segments.some((segment) => segment.beat < 0));
});

test("MIDI 速度事件：按拍位换算成 tick，并在 0 处补起始速度", () => {
  const events = midiTempoEvents([{ beat: 8, bpm: 120 }], { detectedBpm: 120, userBpm: 120, ticksPerBeat: 480 });
  assert.equal(events[0].tick, 0);
  assert.equal(events[0].microsPerBeat, Math.round(60000000 / 120));
  assert.equal(events.length, 2);
  assert.equal(events[1].tick, 8 * 480);
  const single = midiTempoEvents([], { detectedBpm: null, userBpm: 66, ticksPerBeat: 480 });
  assert.deepEqual(single, [{ tick: 0, microsPerBeat: Math.round(60000000 / 66) }]);
});
