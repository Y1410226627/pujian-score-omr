import assert from "node:assert/strict";
import test from "node:test";

import {
  planPdfRender, chunkPages, RECOGNIZE_SCALE, MAX_PAGES, MAX_PAGES_PER_REQUEST,
  jianpuPagesToScore, jianpuTimeSignature,
} from "../composer-pdf.js";
import { v2ScoreToV1 } from "../composer-v2adapter.js";

test("渲染计划：页数、倍率、截断标记", () => {
  const plan = planPdfRender(3);
  assert.deepEqual(plan.pages, [1, 2, 3]);
  assert.ok(Math.abs(plan.scale - 300 / 72) < 1e-9, "默认 300 DPI");
  assert.equal(plan.truncated, false);
});

test("超过页数上限时截断并如实标记", () => {
  const plan = planPdfRender(200);
  assert.equal(plan.pages.length, MAX_PAGES);
  assert.equal(plan.truncated, true, "必须告诉用户被截断了");
  assert.deepEqual(plan.pages.slice(0, 3), [1, 2, 3]);
});

test("页数为 0 / 非法值不崩", () => {
  assert.deepEqual(planPdfRender(0).pages, []);
  assert.deepEqual(planPdfRender(-5).pages, []);
  assert.deepEqual(planPdfRender(NaN).pages, []);
  assert.deepEqual(planPdfRender("abc").pages, []);
});

test("分批：按上限切成多块，不丢页", () => {
  const pages = Array.from({ length: 35 }, (_, index) => index + 1);
  const chunks = chunkPages(pages);
  assert.equal(chunks.length, 3, "35 页按 16 页一批 = 3 批");
  assert.equal(chunks[0].length, MAX_PAGES_PER_REQUEST);
  assert.equal(chunks[2].length, 3);
  const flat = chunks.flat();
  assert.deepEqual(flat, pages, "拼起来必须和原来一致");
});

test("分批：空列表 / 单页不崩", () => {
  assert.deepEqual(chunkPages([]), []);
  assert.deepEqual(chunkPages([1]), [[1]]);
});

test("倍率可覆盖（低配机器可以降低）", () => {
  const plan = planPdfRender(2, { scale: 2 });
  assert.equal(plan.scale, 2);
});

test("简谱识别结果 → 乐谱：声部、起拍、时值都保留", () => {
  const payload = {
    beatsPerMeasure: 4,
    parts: [
      { name: "女高", notes: [
        { midi: 65, startBeat: 0, durationBeats: 1 },
        { midi: 67, startBeat: 1, durationBeats: 2 },
      ] },
      { name: "女中", notes: [{ midi: 60, startBeat: 0, durationBeats: 2 }] },
    ],
  };
  const { score, noteCount, partCount, pageCount } = jianpuPagesToScore([{ page: 1, payload }], { beats: 4 });
  assert.equal(noteCount, 3);
  assert.equal(partCount, 2);
  assert.equal(pageCount, 1);
  assert.equal(score.timeSignature.beats, 4);
  const high = score.parts[0].staves[0].voices[0].events;
  assert.deepEqual(high.map((event) => [event.midi, event.beat, event.beats]), [[65, 0, 1], [67, 1, 2]]);
  assert.equal(score.parts[1].staves[0].voices[0].events[0].midi, 60);
});

test("简谱多页：后一页对齐到上一页结束的小节线", () => {
  const page1 = { parts: [{ name: "声部1", notes: [{ midi: 60, startBeat: 0, durationBeats: 2 }] }] };
  const page2 = { parts: [{ name: "声部1", notes: [{ midi: 62, startBeat: 0, durationBeats: 1 }] }] };
  const { score } = jianpuPagesToScore([{ page: 1, payload: page1 }, { page: 2, payload: page2 }], { beats: 4 });
  const events = score.parts[0].staves[0].voices[0].events;
  assert.deepEqual(events.map((event) => event.beat), [0, 4]);
});

test("同一拍位的多个音合成和弦，而不是两个先后音", () => {
  const payload = { parts: [{ name: "钢琴", notes: [
    { midi: 60, startBeat: 0, durationBeats: 1 },
    { midi: 64, startBeat: 0, durationBeats: 1 },
    { midi: 67, startBeat: 0, durationBeats: 1 },
  ] }] };
  const { score } = jianpuPagesToScore([{ page: 1, payload }], { beats: 4 });
  const events = score.parts[0].staves[0].voices[0].events;
  assert.equal(events.length, 3);
  assert.equal(events[0].chordWith, undefined, "第一个音是锚音");
  assert.equal(events[1].chordWith, events[0].id);
  assert.equal(events[2].chordWith, events[0].id);
  // 转回界面视图后，同一小节只占一个拍位（否则拍位会全部后移）
  const view = v2ScoreToV1(score);
  assert.equal(view.parts[0].measures[0].beats.length, 1);
  assert.deepEqual(view.parts[0].measures[0].beats[0].chordMidis, [64, 67]);
});

test("简谱结果里的错误页 / 空页会被跳过", () => {
  const { noteCount, pageCount } = jianpuPagesToScore([
    { page: 1, payload: { error: "第 1 页没有读出简谱音符。" } },
    { page: 2, payload: { parts: [] } },
  ], { beats: 4 });
  assert.equal(noteCount, 0);
  assert.equal(pageCount, 0);
});

test("简谱拍号换算成合法拍号（9/8 不能写成 4.5/4）", () => {
  assert.deepEqual(jianpuTimeSignature(4), { beats: 4, beatType: 4 });
  assert.deepEqual(jianpuTimeSignature(3), { beats: 3, beatType: 4 });
  assert.deepEqual(jianpuTimeSignature(1.5), { beats: 3, beatType: 8 });
  assert.deepEqual(jianpuTimeSignature(4.5), { beats: 9, beatType: 8 });
  assert.deepEqual(jianpuTimeSignature(6), { beats: 12, beatType: 8 });
  const { score } = jianpuPagesToScore([{ page: 1, payload: { parts: [
    { name: "声部1", notes: [{ midi: 60, startBeat: 0, durationBeats: 4.5 }] },
  ] } }], { beats: 4.5 });
  assert.deepEqual(score.timeSignature, { beats: 9, beatType: 8 });
});
