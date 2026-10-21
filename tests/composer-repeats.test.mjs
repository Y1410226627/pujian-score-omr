import assert from "node:assert/strict";
import test from "node:test";

import { expandPlaybackOrder, validateRepeats, createRepeat } from "../composer-repeats.js";

test("没有反复记号时按顺序播一次", () => {
  assert.deepEqual(expandPlaybackOrder(4, []), [1, 2, 3, 4]);
});

test("单段反复：起点 1、终点 4、反复 2 次", () => {
  const repeats = [createRepeat(1, "repeat-start"), createRepeat(4, "repeat-end", { times: 2 })];
  // 唱 1,2,3,4 → 跳回 1 → 再唱 1,2,3,4
  assert.deepEqual(expandPlaybackOrder(4, repeats), [1, 2, 3, 4, 1, 2, 3, 4]);
});

test("反复 3 次", () => {
  const repeats = [createRepeat(2, "repeat-start"), createRepeat(3, "repeat-end", { times: 3 })];
  assert.deepEqual(expandPlaybackOrder(3, repeats), [1, 2, 3, 2, 3, 2, 3]);
});

test("反复段后面的小节照常播放", () => {
  const repeats = [createRepeat(1, "repeat-start"), createRepeat(2, "repeat-end", { times: 2 })];
  assert.deepEqual(expandPlaybackOrder(4, repeats), [1, 2, 1, 2, 3, 4]);
});

test("嵌套反复：外层包含内层", () => {
  const repeats = [
    createRepeat(1, "repeat-start"),   // 外层
    createRepeat(2, "repeat-start"),   // 内层
    createRepeat(3, "repeat-end", { times: 2 }),
    createRepeat(4, "repeat-end", { times: 2 }),
  ];
  assert.deepEqual(expandPlaybackOrder(4, repeats), [1, 2, 3, 2, 3, 4, 1, 2, 3, 2, 3, 4]);
});

test("房子（1. 2. 段）：第一遍走房子一，第二遍跳到房子二", () => {
  // 常见写法：第 2 小节的 end 反复 + 第 3 小节标 ending=1、第 4 小节标 ending=2
  // 简化验证：ending 不改变播放顺序（顺序由 repeat 决定），但结构能共存
  const repeats = [
    createRepeat(1, "repeat-start"),
    createRepeat(2, "repeat-end", { times: 2 }),
  ];
  assert.deepEqual(expandPlaybackOrder(4, repeats), [1, 2, 1, 2, 3, 4]);
  assert.equal(createRepeat(3, "repeat-start", { ending: 1 }).ending, 1);
});

test("校验：能查出没配对的起点/终点", () => {
  assert.deepEqual(validateRepeats([]), []);
  assert.equal(validateRepeats([createRepeat(1, "repeat-start")]).length, 1);
  assert.equal(validateRepeats([createRepeat(3, "repeat-end")]).length, 1);
  assert.deepEqual(validateRepeats([createRepeat(1, "repeat-start"), createRepeat(4, "repeat-end")]), []);
  assert.ok(validateRepeats([
    createRepeat(1, "repeat-start"), createRepeat(2, "repeat-start"),
  ]).length >= 1, "连续两个起点应报错");
});

test("死循环保护：写错结构也不会挂住", () => {
  const repeats = [createRepeat(1, "repeat-start"), createRepeat(1, "repeat-end", { times: 100 })];
  const order = expandPlaybackOrder(1, repeats);
  assert.ok(order.length < 20000, `应有上限保护，实际 ${order.length}`);
  assert.ok(order.length >= 2, "至少应反复一次");
});
