import assert from "node:assert/strict";
import test from "node:test";

import {
  planPdfRender, chunkPages, RECOGNIZE_SCALE, MAX_PAGES, MAX_PAGES_PER_REQUEST,
} from "../composer-pdf.js";

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
