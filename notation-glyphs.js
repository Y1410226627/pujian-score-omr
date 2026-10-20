// 「零基础也看得懂」的符号绘制：把时值、休止、力度、记号画成真实图形。
//
// 为什么要自己做 SVG 而不是只写文字：
// 用户（合唱团成员、非专业）反馈「四分音符 / 八分音符谁看得懂」。
// 这里直接画符头、符干、符尾、休止符、附点、连音线，让选择器里「看到的就是谱上的样子」。
//
// 纯字符串生成（不依赖 DOM），可以脱离浏览器单测：见 tests/notation-glyphs.test.mjs

/** 画一个符头（空心/实心）。坐标以 (0,0) 为符头中心，符头半径约 r。 */
function head(open, r = 5.6) {
  const ry = r * 0.74;
  const fill = open ? "none" : "currentColor";
  // 稍微倾斜的椭圆，比正圆更像真实符头
  return `<ellipse cx="0" cy="0" rx="${r}" ry="${ry}" fill="${fill}" stroke="currentColor" stroke-width="1.5" transform="rotate(-20)" />`;
}

/** 画符干：从符头右侧往上（stemUp）或左侧往下。 */
function stem(up, length = 22) {
  const x = up ? 4.9 : -4.9;
  const y2 = up ? -length : length;
  return `<line x1="${x}" y1="0" x2="${x}" y2="${y2}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />`;
}

/** 画符尾（flag）：八分音符 1 条、十六分音符 2 条、三十二分 3 条。 */
function flags(count, up = true) {
  if (!count) return "";
  const x = up ? 4.9 : -4.9;
  const baseY = up ? -22 : 22;
  let out = "";
  for (let index = 0; index < count; index += 1) {
    const y = baseY + (up ? index * 6.2 : -index * 6.2);
    // 用二次贝塞尔画一条弯曲的符尾
    const dir = up ? 1 : -1;
    out += `<path d="M${x} ${y} q 7 ${(dir * 5).toFixed(1)} 4.5 ${(dir * 13).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />`;
  }
  return out;
}

/** 附点。 */
function dot() {
  return `<circle cx="9.5" cy="-1.5" r="1.9" fill="currentColor" />`;
}

/** 休止符图形（四分/八分/十六分/二分/全休止）。 */
function restGlyph(kind) {
  switch (kind) {
    case "whole":   // 全休止：挂在第四线下方的小方块
      return `<rect x="-7" y="-3" width="14" height="5" fill="currentColor" />`;
    case "half":    // 二分休止：坐在第三线上方的小方块
      return `<rect x="-7" y="-2" width="14" height="5" fill="currentColor" />`;
    case "quarter": // 四分休止：一个「之」字形
      return `<path d="M-2.5 -13 q 7 5 0 9 q 8 4 0 10 q 7 -3 2.5 -9 q -8 -5 0 -9 z" fill="currentColor" />`;
    case "eighth":  // 八分休止：一个小钩
      return `<path d="M1 -12 q 6 4 0 8 q -6 -3 0 -8 z" fill="currentColor" />` +
             `<circle cx="3.4" cy="-4" r="2.2" fill="currentColor" />`;
    case "16th":
      return `<path d="M1 -14 q 6 4 0 8 q -6 -3 0 -8 z" fill="currentColor" />` +
             `<circle cx="3.4" cy="-6" r="2.2" fill="currentColor" />` +
             `<path d="M1 -6 q 6 4 0 8 q -6 -3 0 -8 z" fill="currentColor" />` +
             `<circle cx="3.4" cy="2" r="2.2" fill="currentColor" />`;
    default:
      return `<rect x="-6" y="-2.5" width="12" height="5" fill="currentColor" />`;
  }
}

/**
 * 画一个时值图形。
 * @param {number} beats 以四分音符为 1 拍的长度
 * @param {{rest?: boolean, size?: number}} options
 * @returns {string} SVG 内容（不含外层 <svg>）
 */
export function valueGlyphMarkup(beats, { rest = false, size = 34 } = {}) {
  const whole = beats >= 4;
  const dotted = [3, 1.5, 0.75, 0.375].includes(beats);
  const filled = beats < 2;           // 二分及更长是空心符头
  let flagCount = 0;
  if (beats === 3) flagCount = 0;
  else if (beats === 1.5) flagCount = 0;
  else if (beats === 0.75) flagCount = 1;
  else if (beats === 0.5) flagCount = 1;
  else if (beats === 0.375) flagCount = 2;
  else if (beats === 0.25) flagCount = 2;
  else flagCount = 0;

  if (rest) {
    const kind = whole ? "whole"
      : beats === 3 || beats === 2 ? "half"
      : beats === 1 || beats === 1.5 ? "quarter"
      : beats === 0.75 || beats === 0.5 ? "eighth" : "16th";
    return `<g transform="translate(${size / 2} ${size / 2})" fill="currentColor">${restGlyph(kind)}</g>`;
  }
  if (whole) {
    // 全音符没有符干，只有一个空心符头
    return `<g transform="translate(${size / 2} ${size / 2})">${head(true, 5.2)}</g>`;
  }
  const parts = [head(!filled), stem(true), flags(flagCount, true)];
  if (dotted) parts.push(dot());
  return `<g transform="translate(${size / 2} ${size / 2 + 9})">${parts.join("")}</g>`;
}

/**
 * 生成完整的内联 SVG 字符串（可直接放进按钮里）。
 * @param {number} beats
 * @param {{rest?: boolean, size?: number, title?: string}} options
 */
export function valueGlyphSvg(beats, { rest = false, size = 34, title = "" } = {}) {
  return `<svg class="value-glyph" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" ` +
    `role="img" aria-label="${title || (rest ? "休止符" : "音符")}" focusable="false">` +
    valueGlyphMarkup(beats, { rest, size }) +
    `</svg>`;
}

/** 用文字长度形象表示「几拍」：一排小方块，满拍为实心、半拍为半格。 */
export function beatsBarMarkup(beats, { unit = 4, height = 8 } = {}) {
  const total = Math.max(0.0625, beats);
  const cells = [];
  const cellWidth = unit;
  const full = Math.floor(total);
  for (let index = 0; index < full; index += 1) cells.push(`<span class="beat-cell"></span>`);
  const remainder = total - full;
  if (remainder > 0) {
    const width = Math.round(cellWidth * remainder);
    cells.push(`<span class="beat-cell is-part" style="width:${width}px"></span>`);
  }
  return `<span class="beats-bar" style="height:${height}px">${cells.join("")}</span>`;
}

/** 把「几拍」说成人话（避免术语）。 */
export function beatsToHuman(beats) {
  if (!Number.isFinite(beats)) return "";
  if (beats >= 4) return "能撑满一整小节（4 拍）";
  if (beats === 3) return "3 拍（1、2、3）";
  if (beats === 2) return "2 拍（1、2）";
  if (beats === 1.5) return "1 拍半（1、2 和）";
  if (beats === 1) return "1 拍（数一下 1）";
  if (beats === 0.75) return "多半拍（不到 1 拍）";
  if (beats === 0.5) return "半拍（数 1-和）";
  if (beats === 0.375) return "不到半拍";
  if (beats === 0.25) return "很短，1 拍能放 4 个";
  return `${beats} 拍`;
}

/**
 * 演奏记号/常用符号的真实图形（连音线、重音、延音、渐强等）。
 * @param {string} kind
 * @param {{size?: number}} options
 */
export function symbolMarkup(kind, { size = 32 } = {}) {
  const half = size / 2;
  const shapes = {
    slur: `<path d="M4 ${half - 6} q ${half - 4} 9 ${size - 8} 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    tie: `<path d="M3 ${half} q ${half - 3} -8 ${size - 6} 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
    accent: `<path d="M5 ${half + 5} L${half} ${half - 5} L${size - 5} ${half + 5}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
    fermata: `<path d="M4 ${half - 2} a ${half - 4} 6 0 0 1 ${size - 8} 0" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="${half}" cy="${half - 4}" r="1.8" fill="currentColor"/>`,
    staccato: `<circle cx="${half}" cy="${half}" r="3" fill="currentColor"/>`,
    crescendo: `<path d="M4 ${half} L${size - 4} ${half - 6} M4 ${half} L${size - 4} ${half + 6}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
    decrescendo: `<path d="M4 ${half - 6} L${size - 4} ${half} M4 ${half + 6} L${size - 4} ${half}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
    breath: `<path d="M6 ${half} h${size - 12}" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 3"/><path d="M${half - 2} ${half - 6} L${half} ${half - 2} L${half + 2} ${half - 6}" fill="none" stroke="currentColor" stroke-width="1.8"/>`,
  };
  return shapes[kind] || "";
}

/** 完整 SVG（带外层）。 */
export function symbolSvg(kind, { size = 32, title = "" } = {}) {
  const inner = symbolMarkup(kind, { size });
  if (!inner) return "";
  return `<svg class="value-glyph symbol-glyph" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" ` +
    `role="img" aria-label="${title}" focusable="false">${inner}</svg>`;
}
