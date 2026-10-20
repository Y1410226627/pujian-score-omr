import assert from "node:assert/strict";
import test from "node:test";

import {
  valueGlyphSvg, valueGlyphMarkup, beatsBarMarkup, beatsToHuman, symbolSvg,
} from "../notation-glyphs.js";
import { NOTE_VALUES, REST_VALUES } from "../composer.js";

test("每种时值都能画出图形（不含「看不懂的纯文字」）", () => {
  for (const value of NOTE_VALUES) {
    const svg = valueGlyphSvg(value.beats, { title: value.label });
    assert.ok(svg.startsWith("<svg"), `${value.label} 应生成 SVG`);
    assert.ok(svg.includes("</svg>"), `${value.label} 的 SVG 应闭合`);
    // 必须有实际图形（椭圆=符头 / 矩形=休止 / 路径=符尾）
    assert.ok(/<(ellipse|rect|path|circle|line)/.test(svg), `${value.label} 应有可见图形`);
  }
});

test("全音符只有空心符头，没有符干", () => {
  const markup = valueGlyphMarkup(4);
  assert.ok(markup.includes("ellipse"), "应有符头");
  assert.ok(!markup.includes("<line"), "全音符不应有符干");
  assert.ok(markup.includes('fill="none"'), "全音符符头是空心的");
});

test("四分音符 = 实心符头 + 符干，没有符尾", () => {
  const markup = valueGlyphMarkup(1);
  assert.ok(markup.includes("<line"), "应有符干");
  assert.ok(!markup.includes("<path"), "四分音符不应有符尾");
  assert.ok(!markup.includes("fill=\"none\""), "符头应是实心");
});

test("八分音符有 1 条符尾，十六分音符有 2 条", () => {
  const eighth = (valueGlyphMarkup(0.5).match(/<path/g) || []).length;
  const sixteenth = (valueGlyphMarkup(0.25).match(/<path/g) || []).length;
  assert.equal(eighth, 1, `八分音符应有 1 条符尾，实际 ${eighth}`);
  assert.equal(sixteenth, 2, `十六分音符应有 2 条符尾，实际 ${sixteenth}`);
});

test("附点音符有附点（圆点）", () => {
  for (const beats of [3, 1.5, 0.75, 0.375]) {
    const markup = valueGlyphMarkup(beats);
    assert.ok(markup.includes("<circle"), `带附点的时值 ${beats} 应画出附点`);
  }
  assert.ok(!valueGlyphMarkup(1).includes("<circle"), "四分音符没有附点");
});

test("休止符画的是休止符号，不是音符", () => {
  for (const value of REST_VALUES) {
    const markup = valueGlyphMarkup(value.beats, { rest: true });
    assert.ok(markup.length > 20, `${value.label} 休止符应有图形`);
    assert.ok(/<(rect|path|circle)/.test(markup), `${value.label} 休止符应有图形`);
    assert.ok(!markup.includes("<ellipse"), `${value.label} 休止符不应画符头`);
  }
});

test("拍数用可视小方块表示（不只看文字）", () => {
  const four = beatsBarMarkup(4);
  assert.equal((four.match(/beat-cell/g) || []).length, 4, "4 拍应有 4 个方块");
  const oneAndHalf = beatsBarMarkup(1.5);
  assert.equal((oneAndHalf.match(/class="beat-cell"/g) || []).length, 1, "1 个整拍");
  assert.ok(oneAndHalf.includes("is-part"), "半拍用半格表示");
});

test("拍数的人话说明里没有生僻术语", () => {
  assert.ok(beatsToHuman(1).includes("1 拍"));
  assert.ok(beatsToHuman(0.5).includes("半拍"));
  assert.ok(beatsToHuman(4).includes("一整小节"));
  for (const value of NOTE_VALUES) {
    const text = beatsToHuman(value.beats);
    assert.ok(text.length > 0, `${value.label} 应有人话说明`);
    assert.ok(!/附点|符头|符干|符尾/.test(text), `说明里不应出现专业术语：${text}`);
  }
});

test("演奏记号能画出来（连音线/重音/延音/渐强等）", () => {
  for (const kind of ["slur", "tie", "accent", "fermata", "staccato", "crescendo", "decrescendo", "breath"]) {
    const svg = symbolSvg(kind, { title: kind });
    assert.ok(svg.includes("<svg"), `${kind} 应能生成 SVG`);
    assert.ok(/<(path|circle|rect|line)/.test(svg), `${kind} 应有图形`);
  }
  assert.equal(symbolSvg("不存在的记号"), "", "未知记号返回空串");
});
