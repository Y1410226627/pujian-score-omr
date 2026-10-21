// 反复记号 / 房子（repeat + ending）的纯逻辑。
//
// 为什么单独一个文件：反复记号改的是「播放顺序」而不是音符数据，
// 涉及播放顺序展开、合法性校验、MusicXML 读写、界面输入四处，集中放便于单测。

// 反复结构的锚点记在「某个小节」上：
//   { bar: 1, type: "repeat-start" }
//   { bar: 4, type: "repeat-end", times: 2 }
//   { bar: 5, type: "ending-start", number: 1 }   // 1. 房子
//   { bar: 6, type: "ending-stop", number: 1 }
//   { bar: 5, type: "ending-start", number: 2 }   // 2. 房子
// times 记在 repeat-end 上：表示「这一段总共唱几遍」。

/** 把 repeats 配成 map：起点小节 → { start, end, times }。没配对的忽略。 */
function pairRepeats(repeats) {
  const sorted = [...(repeats || [])].filter((item) => item && Number.isFinite(item.bar))
    .filter((item) => item.type === "repeat-start" || item.type === "repeat-end")
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
 * 把房子（ending）配成「小节 → 属于第几遍房子的哪一段」。
 *
 * 房子是「同一位置、不同遍数唱不同内容」：
 *   第 1 遍唱 1. 房子，第 2 遍跳过 1. 直接唱 2. 房子。
 * 返回 [{ start, end, number }]。
 */
export function pairEndings(repeats) {
  const sorted = [...(repeats || [])].filter((item) => item && Number.isFinite(item.bar))
    .filter((item) => item.type === "ending-start" || item.type === "ending-stop")
    .sort((left, right) => left.bar - right.bar);
  const stack = [];
  const endings = [];
  for (const mark of sorted) {
    if (mark.type === "ending-start") {
      stack.push(mark);
    } else if (mark.type === "ending-stop") {
      const open = stack.pop();
      if (!open) continue;
      endings.push({ start: open.bar, end: mark.bar, number: Number(open.number) || 1 });
    }
  }
  // 没写 stop 的房子：按「到下一个房子开始前的最后一小节」收口（常见写法省略 stop）
  for (const open of stack) {
    endings.push({ start: open.bar, end: null, number: Number(open.number) || 1 });
  }
  // 补 end：某个房子没有 stop 时，用「下一个房子开始前一小节」或反复终点
  const pairs = pairRepeats(repeats);
  for (const ending of endings) {
    if (ending.end !== null) continue;
    const nextStart = endings
      .filter((other) => other !== ending && other.start > ending.start)
      .map((other) => other.start)
      .sort((left, right) => left - right)[0];
    const repeatEnd = [...pairs.values()]
      .filter((pair) => pair.start <= ending.start && pair.end >= ending.start)
      .map((pair) => pair.end)
      .sort((left, right) => left - right)[0];
    ending.end = nextStart !== undefined ? nextStart - 1 : (repeatEnd ?? ending.start);
  }
  return endings.sort((left, right) => left.start - right.start);
}

/**
 * 把反复结构展开成「实际播放一遍的小节顺序」。
 *
 * 语义（与常见制谱软件一致）：
 *   · repeat-start / repeat-end 之间反复 times 遍；
 *   · 房子（ending）：第 N 遍只唱 number === N 的房子段落，其他房子跳过；
 *   · 支持嵌套；
 *   · 没配对的记号忽略，播放按顺序一次，不会卡住。
 *
 * @param {number} totalMeasures 总小节数
 * @param {Array<{bar:number,type:string,times?:number,number?:number}>} repeats
 * @returns {number[]} 播放顺序（小节号，1 起）
 */
export function expandPlaybackOrder(totalMeasures, repeats = []) {
  const total = Math.max(1, Number(totalMeasures) || 1);
  const pairs = pairRepeats(repeats);
  const endings = pairEndings(repeats);
  const order = [];
  const stack = [];
  let index = 1;
  let steps = 0;
  const guard = Math.max(2000, total * 500 + 1000);

  /** 当前遍数：由「包含这一小节的反复段」决定；该段已唱完时用它的最终遍数。 */
  const passAt = (bar) => {
    // 找包含这一小节的反复段（不管栈里还在不在）
    for (const pair of pairs.values()) {
      if (bar >= pair.start && bar <= pair.end) {
        const frame = stack.find((item) => item.start === pair.start);
        return frame ? frame.played : pair.times;
      }
    }
    return 1;
  };

  /** 这一小节属于哪个房子（不在房子里返回 null）。 */
  const endingAt = (bar) => endings.find((item) => bar >= item.start && bar <= item.end) || null;

  while (index >= 1 && index <= total && steps < guard) {
    steps += 1;
    const ending = endingAt(index);
    if (ending && ending.number !== passAt(index)) {
      // 这一遍不唱这个房子：整段跳过（跳到它后面）。
      // 但跳过前要先看「这段里有没有反复终点」——常见写法是反复终点与 2. 房子同处一小节，
      // 直接跳过就永远回不到反复起点（实测会少唱一整遍）。
      const frame = stack[stack.length - 1];
      const endInside = frame && frame.end >= ending.start && frame.end <= ending.end;
      if (endInside && frame.played < frame.times) {
        frame.played += 1;
        index = frame.start;
        continue;
      }
      index = ending.end + 1;
      continue;
    }
    order.push(index);
    const pair = pairs.get(index);
    if (pair && pair.start === index) {
      const existing = stack.find((frame) => frame.start === index);
      if (!existing) stack.push({ start: index, end: pair.end, times: pair.times, played: 1 });
    }
    const frame = stack[stack.length - 1];
    if (frame && index === frame.end) {
      if (frame.played < frame.times) {
        frame.played += 1;
        index = frame.start;      // 跳回起点再唱一遍
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
    .filter((item) => item.type === "repeat-start" || item.type === "repeat-end")
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
  const mark = {
    bar: Number(bar) || 1,
    type,
  };
  if (type === "repeat-end" || type === "repeat-start") {
    mark.times = Math.max(2, Number(options.times) || 2);
  }
  if (options.number) mark.number = Number(options.number);
  return mark;
}

/** 新建一个房子（1./2. 段）。 */
export function createEnding(bar, number, type) {
  return { bar: Number(bar) || 1, type, number: Math.max(1, Number(number) || 1) };
}
