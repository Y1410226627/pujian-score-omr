// 反复记号 / 房子的纯逻辑。
//
// 为什么单独一个文件：反复记号改的是「播放顺序」而不是音符数据，
// 涉及播放顺序展开、合法性校验、MusicXML 读写、界面输入四处，集中放便于单测。

// 反复结构的锚点记在「某个小节」上：
//   { bar: 1, type: "repeat-start" | "repeat-end", times: 2, ending: 1 }
// times 记在 repeat-end 上：表示「这一段总共唱几遍」。

/** 把 repeats 配成 map：起点小节 → { start, end, times }。没配对的忽略。 */
function pairRepeats(repeats) {
  const sorted = [...(repeats || [])].filter((item) => item && Number.isFinite(item.bar))
    .sort((left, right) => left.bar - right.bar);
  const stack = [];
  const pairs = new Map();
  for (const mark of sorted) {
    if (mark.type === "repeat-start") stack.push(mark.bar);
    else if (mark.type === "repeat-end") {
      const start = stack.pop();
      if (start === undefined || mark.bar < start) continue;   // 没配对 / 顺序错：忽略
      pairs.set(start, { start, end: mark.bar, times: Math.max(2, Number(mark.times) || 2) });
    }
  }
  return pairs;
}

/**
 * 把反复结构展开成「实际播放一遍的小节顺序」。
 *
 * 语义（与常见制谱软件一致）：
 *   · repeat-start 小节是反复段的第一个小节；
 *   · repeat-end 小节是反复段的最后一个小节，`times` 表示这一段**总共**唱几遍；
 *   · 支持嵌套：内层结束后继续外层；外层结束后继续往后的正常小节；
 *   · 没配对的记号忽略，播放按顺序一次，不会卡住。
 *
 * @param {number} totalMeasures 总小节数
 * @param {Array<{bar:number,type:string,times?:number}>} repeats
 * @returns {number[]} 播放顺序（小节号，1 起）
 */
export function expandPlaybackOrder(totalMeasures, repeats = []) {
  const total = Math.max(1, Number(totalMeasures) || 1);
  const pairs = pairRepeats(repeats);
  const order = [];
  // 每层的「起点」与「已唱遍数」；回到起点时同一层不重复入栈
  const stack = [];
  let index = 1;
  let steps = 0;
  const guard = Math.max(2000, total * 500 + 1000);

  while (index >= 1 && index <= total && steps < guard) {
    steps += 1;
    order.push(index);
    const pair = pairs.get(index);
    if (pair && pair.start === index) {
      const existing = stack.find((frame) => frame.start === index);
      if (!existing) stack.push({ start: index, ...pair, played: 1 });
    }
    const frame = stack[stack.length - 1];
    if (frame && index === frame.end) {
      if (frame.played < frame.times) {
        frame.played += 1;
        index = frame.start;      // 跳回起点再唱一遍（start 会被再 push 一次，正常）
        continue;
      }
      stack.pop();               // 这一段够了，正常往下
    }
    index += 1;
  }
  return order;
}

/** 校验反复结构是否合法（起点/终点要配对、次序要对）。 */
export function validateRepeats(repeats = []) {
  const problems = [];
  const sorted = [...(repeats || [])].filter((item) => item && Number.isFinite(item.bar))
    .sort((left, right) => left.bar - right.bar);
  const stack = [];
  for (const mark of sorted) {
    if (mark.type === "repeat-start") stack.push(mark);
    else if (mark.type === "repeat-end") {
      const open = stack.pop();
      if (!open) problems.push(`第 ${mark.bar} 小节是反复终点，但前面没有对应的起点。`);
      else if (mark.bar < open.bar) {
        problems.push(`第 ${mark.bar} 小节的终点排在起点（第 ${open.bar} 小节）之前。`);
      }
    }
  }
  for (const left of stack) problems.push(`第 ${left.bar} 小节的反复起点没有对应的终点。`);
  return problems;
}

/** 新建一个反复标记（界面用）。 */
export function createRepeat(bar, type, options = {}) {
  return {
    bar: Number(bar) || 1,
    type,
    times: Math.max(2, Number(options.times) || 2),
    ...(options.ending ? { ending: Number(options.ending) } : {}),
  };
}
