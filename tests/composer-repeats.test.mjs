import assert from "node:assert/strict";
import test from "node:test";

import {
  expandPlaybackOrder, validateRepeats, createRepeat, createEnding, pairEndings,
} from "../composer-repeats.js";

const start = (bar) => createRepeat(bar, "repeat-start");
const end = (bar, times = 2) => createRepeat(bar, "repeat-end", { times });
const endingStart = (bar, number) => createEnding(bar, number, "ending-start");
const endingStop = (bar, number) => createEnding(bar, number, "ending-stop");

test("没有反复记号时按顺序播一次", () => {
  assert.deepEqual(expandPlaybackOrder(4, []), [1, 2, 3, 4]);
});

test("单段反复：起点 1、终点 4、反复 2 次", () => {
  assert.deepEqual(expandPlaybackOrder(4, [start(1), end(4, 2)]), [1, 2, 3, 4, 1, 2, 3, 4]);
});

test("反复 3 次", () => {
  assert.deepEqual(expandPlaybackOrder(3, [start(2), end(3, 3)]), [1, 2, 3, 2, 3, 2, 3]);
});

test("反复段后面的小节照常播放", () => {
  assert.deepEqual(expandPlaybackOrder(4, [start(1), end(2, 2)]), [1, 2, 1, 2, 3, 4]);
});

test("嵌套反复：外层包含内层", () => {
  const repeats = [start(1), start(2), end(3, 2), end(4, 2)];
  assert.deepEqual(expandPlaybackOrder(4, repeats), [1, 2, 3, 2, 3, 4, 1, 2, 3, 2, 3, 4]);
});

test("房子：第 1 遍唱 1. 房子，第 2 遍跳过它", () => {
  // 1 起反复，第 3 小节是 1. 房子，第 4 小节是 2. 房子，第 4 小节同时也是反复终点
  const repeats = [
    start(1),
    endingStart(3, 1), endingStop(3, 1),
    endingStart(4, 2), endingStop(4, 2),
    end(4, 2),
  ];
  // 第 1 遍：1 2 3（1. 房子）→ 回到 1；第 2 遍：1 2（跳过 3）→ 4（2. 房子）→ 结束
  assert.deepEqual(expandPlaybackOrder(5, repeats), [1, 2, 3, 1, 2, 4, 5]);
});

test("pairEndings：没写 stop 的房子自动收口", () => {
  const endings = pairEndings([endingStart(3, 1), endingStart(5, 2), start(1), end(6, 2)]);
  assert.equal(endings.length, 2);
  assert.equal(endings[0].start, 3);
  assert.equal(endings[0].end, 4, "1. 房子在下个房子（第 5 小节）前收口");
});

test("校验：能查出没配对的起点/终点", () => {
  assert.deepEqual(validateRepeats([]), []);
  assert.equal(validateRepeats([start(1)]).length, 1);
  assert.equal(validateRepeats([end(3)]).length, 1);
  assert.deepEqual(validateRepeats([start(1), end(4)]), []);
  assert.ok(validateRepeats([start(1), start(2)]).length >= 1, "连续两个起点应报错");
});

test("死循环保护：写错结构也不会挂住", () => {
  const order = expandPlaybackOrder(1, [start(1), end(1, 100)]);
  assert.ok(order.length < 20000, `应有上限保护，实际 ${order.length}`);
  assert.ok(order.length >= 2, "至少应反复一次");
});
