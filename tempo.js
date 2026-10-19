// 速度变化（rubato / 分段变速）与「自动识别 BPM」的纯逻辑：可单测，不碰 Web Audio/DOM。
//
// 为什么单独一个文件：用户反馈两类问题本质是同一件事——
//   ① 谱面中途写「♩=138」「rit.」「accel.」时，播放要跟着变速、导出的 MIDI 也要带变速；
//   ② 起始 BPM 在谱面上没印（或只印在第二页/第二行）时，要能从全曲的速度标记里推断出来，
//      而不是一路用默认 84（用户听感就是「怎么这么快」）。
//
// 术语（给非音乐专业读者）：
//   · BPM = 每分钟多少拍；数值越大越快。
//   · 速度记号（tempo mark）是一串「第几拍开始、每分钟多少拍」的数据。
//   · 「第几拍」以四分音符为一拍、从选段起点算（播放时会把选区平移）。

/** 拍数 → 秒的换算器：支持任意多个速度段（每个段从某一拍开始生效）。 */
export function buildTempoMap(segments, fallbackBpm = 84) {
  const sorted = [...(segments || [])]
    .map((segment) => ({ beat: Number(segment.beat) || 0, bpm: Number(segment.bpm) }))
    .filter((segment) => Number.isFinite(segment.bpm) && segment.bpm > 0)
    .sort((left, right) => left.beat - right.beat);
  const fallback = clampTempo(fallbackBpm);
  const first = sorted.length && sorted[0].beat <= 0 ? sorted[0].bpm : fallback;
  const effective = sorted.filter((segment) => segment.beat > 0);
  return {
    startBpm: first,
    segments: effective,
    secondsAtBeat(beat) {
      let seconds = 0;
      let previous = 0;
      let bpm = first;
      for (const segment of effective) {
        if (segment.beat >= beat) break;
        seconds += (segment.beat - previous) * (60 / bpm);
        previous = segment.beat;
        bpm = segment.bpm;
      }
      return seconds + Math.max(0, beat - previous) * (60 / bpm);
    },
    bpmAtBeat(beat) {
      let bpm = first;
      for (const segment of effective) {
        if (segment.beat > beat) break;
        bpm = segment.bpm;
      }
      return bpm;
    },
  };
}

export function clampTempo(value) {
  return Math.min(320, Math.max(20, Number(value) || 84));
}

/**
 * 从 MusicXML 读到的速度标记里推断「起始速度」。
 *
 * 规则（按可信度从高到低）：
 *  1. 第 0 拍（或非常接近开头）有标记 → 直接用它；
 *  2. 开头没有，但全曲只有一种速度值 → 用它（很多谱只在中段印一次 ♩=xx）；
 *  3. 开头没有、有多种速度 → 用**最早**的那个标记（谱面通常先写起始速度，
 *     后面的 rit./accel. 是变化）；这比一路用默认 84 靠谱得多；
 *  4. 完全没有 → 返回 null，让界面提示用户手填。
 */
export function detectStartTempo(tempoMarks, { openingWindowBeats = 0.5 } = {}) {
  const marks = (tempoMarks || [])
    .map((mark) => ({ beat: Number(mark.beat) || 0, bpm: Number(mark.bpm) }))
    .filter((mark) => Number.isFinite(mark.bpm) && mark.bpm > 0)
    .sort((left, right) => left.beat - right.beat);
  if (!marks.length) return null;
  const opening = marks.find((mark) => mark.beat <= openingWindowBeats);
  if (opening) return { bpm: clampTempo(opening.bpm), beat: opening.beat, source: "opening" };
  const distinct = [...new Set(marks.map((mark) => clampTempo(mark.bpm)))];
  if (distinct.length === 1) {
    return { bpm: distinct[0], beat: marks[0].beat, source: "single" };
  }
  return { bpm: clampTempo(marks[0].bpm), beat: marks[0].beat, source: "earliest" };
}

/**
 * 把「速度标记 + 用户在界面上手填的 BPM」合成实际播放用的分段。
 *
 * 语义（对用户可理解）：
 *  · 用户没改 BPM（手填值 == 谱面推断值）→ 完全按谱面分段变速（含 rit./accel.）。
 *  · 用户改了 BPM → 视为「整曲速度缩放」：所有段按同一比例缩放，
 *    这样「我觉得太快，调慢 20%」时，中途的变速比例仍然保留。
 */
export function playbackTempoSegments(tempoMarks, { offset = 0, userBpm, detectedBpm } = {}) {
  const marks = (tempoMarks || [])
    .map((mark) => ({ beat: Number(mark.beat) || 0, bpm: Number(mark.bpm) }))
    .filter((mark) => Number.isFinite(mark.bpm) && mark.bpm > 0)
    .sort((left, right) => left.beat - right.beat);
  let segments = marks.map((mark) => ({ beat: mark.beat - offset, bpm: mark.bpm }))
    .filter((mark) => mark.beat >= -1e-9);
  // 选区起点之前生效的速度，作为选段的起始速度
  let startBpm = null;
  for (const mark of marks) {
    if (mark.beat <= offset) startBpm = mark.bpm;
  }
  const user = Number(userBpm);
  const detected = Number(detectedBpm);
  const scaling = Number.isFinite(user) && Number.isFinite(detected) && detected > 0 && Math.abs(user - detected) > 0.5
    ? user / detected
    : 1;
  if (startBpm === null) startBpm = Number.isFinite(detected) && detected > 0 ? detected : (Number.isFinite(user) ? user : 84);
  if (scaling !== 1) {
    segments = segments.map((segment) => ({ beat: segment.beat, bpm: clampTempo(segment.bpm * scaling) }));
    startBpm = clampTempo(startBpm * scaling);
  }
  return { startBpm: clampTempo(startBpm), segments };
}

/**
 * 给 MIDI 导出用的「速度事件」：返回 [{ tick, microsPerBeat }]。
 * 没读到谱面速度时才用用户手填值；读到就按分段写，这样在别的软件里放也是变速的。
 */
export function midiTempoEvents(tempoMarks, { detectedBpm, userBpm, ticksPerBeat = 480, beatsPerMeasure = 4 } = {}) {
  const marks = (tempoMarks || [])
    .map((mark) => ({ beat: Number(mark.beat) || 0, bpm: Number(mark.bpm) }))
    .filter((mark) => Number.isFinite(mark.bpm) && mark.bpm > 0)
    .sort((left, right) => left.beat - right.beat);
  const user = clampTempo(userBpm);
  const detected = Number(detectedBpm);
  const scaling = Number.isFinite(detected) && detected > 0 && Math.abs(user - detected) > 0.5 ? user / detected : 1;
  const events = [];
  const push = (beat, bpm) => {
    const tick = Math.max(0, Math.round(beat * ticksPerBeat));
    const microsPerBeat = Math.round(60000000 / clampTempo(bpm));
    if (events.length && events[events.length - 1].tick === tick) {
      events[events.length - 1].microsPerBeat = microsPerBeat;
      return;
    }
    events.push({ tick, microsPerBeat });
  };
  if (marks.length) {
    for (const mark of marks) push(mark.beat, mark.bpm * scaling);
  } else {
    push(0, user);
  }
  if (events[0].tick !== 0) events.unshift({ tick: 0, microsPerBeat: Math.round(60000000 / clampTempo(marks.length ? marks[0].bpm * scaling : user)) });
  return events;
}
