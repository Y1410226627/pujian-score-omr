// 创作室页面逻辑：把「选音高 + 选拍数」变成五线谱，并随时试听、导出。
//
// 设计原则（对着零基础用户）：
//   · 界面上不出现「二分音符 / 附点 / 谱号」这类术语作为必填项，全部给中文白话；
//   · 任何一次点击都立刻有反馈（声音 + 谱面变化 + 一句提示）；
//   · 写错了永远能撤销，删音就是点旁边的小 ×；
//   · 试听可以「从头」「从选中的音开始」「只听选中的一段」，避免听一大段找那一句。
import {
  NOTE_VALUES, REST_VALUES, midiToName, isBlackKey, isRest,
  scoreToPlayableNotes, accidentalFor, cloneScore, remainingBeats, usedBeats,
  appendNote, removeNote, setNoteBeats, transposeNote, buildMeasureSlots,
} from "./composer.js";
import { scoreToMidi, scoreToProjectJson } from "./composer-export.js";
import { scoreInfoToComposerScore } from "./composer-import.js";
import { valueGlyphSvg, beatsBarMarkup, beatsToHuman, symbolMarkup } from "./notation-glyphs.js";
// v2 模型：多声部 + 绝对拍位（同一小节可并行多条声部线）
import {
  createScore as createV2Score, createPart as createV2Part,
  createStaff as createV2Staff, createVoice as createV2Voice,
  scoreToPlayableNotes as v2PlayableNotes, beatsPerMeasure as v2BeatsPerMeasure,
  scoreTotalBeats as v2TotalBeats, cloneScore as cloneV2Score,
} from "./composer-model.js";
import { v2ToMusicXml, musicXmlToV2 } from "./composer-v2xml.js";
import { recognizePdfToMusicXml } from "./composer-pdf.js";
import {
  appendNote as v2AppendNote, appendChordTone as v2AppendChordTone,
  deleteEvent as v2DeleteEvent, changeEventBeats as v2ChangeEventBeats,
  changeEventMidi as v2ChangeEventMidi, changeEventBeat as v2ChangeEventBeat,
  toggleFlag as v2ToggleFlag, addVoiceTo as v2AddVoiceTo, addStaffTo as v2AddStaffTo,
  buildMeasureView as v2BuildMeasureView, describeEvent as v2DescribeEvent,
  explainReason as v2ExplainReason, currentVoice as v2CurrentVoice,
  defaultVoiceRef as v2DefaultVoiceRef, clampVoiceRef as v2ClampVoiceRef,
  insertNoteAt as v2InsertNoteAt,
  NOTE_VALUES as V2_NOTE_VALUES, DYNAMICS as V2_DYNAMICS,
  ARTICULATIONS as V2_ARTICULATIONS, ORNAMENTS as V2_ORNAMENTS,
} from "./composer-ui-model.js";
import { createRepeat, validateRepeats, expandPlaybackOrder } from "./composer-repeats.js";
import {
  v2ScoreToV1, isV2Part, v2EventsOf, v2VoiceFor, writeBackEvent,
} from "./composer-v2adapter.js";
import { TIMBRE_LABELS } from "./timbre.js";
import { SAMPLED_TIMBRES, groupBanksByCategory, fallbackTimbre, isInstalledBank } from "./soundbanks.js";
import { fetchSampleManifest, loadSampleBank, isSampledTimbre, lookupSample } from "./sampler.js";

const byId = (id) => document.getElementById(id);
const els = {
  partSelect: byId("composerPart"), addPart: byId("addPart"), renamePart: byId("renamePart"),
  removePart: byId("removePart"),
  pitchLabel: byId("pitchLabel"), pitchHint: byId("pitchHint"), pitchDown: byId("pitchDown"),
  pitchUp: byId("pitchUp"), pitchPlay: byId("pitchPlay"), miniKeyboard: byId("miniKeyboard"),
  valueChips: byId("valueChips"), addNote: byId("addNote"), undo: byId("undo"), redo: byId("redo"),
  scoreTitle: byId("scoreTitle"), scoreTempo: byId("scoreTempo"), scoreTime: byId("scoreTime"),
  repeatBar: byId("repeatBar"), repeatTimes: byId("repeatTimes"),
  addRepeatStart: byId("addRepeatStart"), addRepeatEnd: byId("addRepeatEnd"), repeatInfo: byId("repeatInfo"),
  endingStart: byId("endingStart"), endingEnd: byId("endingEnd"), endingNumber: byId("endingNumber"), addEnding: byId("addEnding"),
  tempoBeat: byId("tempoBeat"), tempoBpm: byId("tempoBpm"), addTempoChange: byId("addTempoChange"),
  scoreKey: byId("scoreKey"), scoreClef: byId("scoreClef"), scoreTimbre: byId("scoreTimbre"),
  measureStatus: byId("measureStatus"),
  playAll: byId("playAll"), playFromHere: byId("playFromHere"), playSelection: byId("playSelection"),
  stopPlay: byId("stopPlay"), loopPlay: byId("loopPlay"), playbackState: byId("playbackState"),
  exportMusicXml: byId("exportMusicXml"), exportMidi: byId("exportMidi"),
  exportProject: byId("exportProject"), exportPng: byId("exportPng"), importProject: byId("importProject"),
  importMusicXml: byId("importMusicXml"), musicXmlInput: byId("musicXmlInput"),
  projectInput: byId("projectInput"), exportHint: byId("exportHint"),
  staffSelector: byId("staffSelector"), voiceSelector: byId("voiceSelector"),
  addVoice: byId("addVoice"), addStaff: byId("addStaff"),
  chordToneButton: byId("chordToneButton"), markGroups: byId("markGroups"),
  scoreEditor: byId("scoreEditor"), scoreEmpty: byId("scoreEmpty"), editToolbar: byId("editToolbar"),
  selectionInfo: byId("selectionInfo"), editActions: byId("editActions"),
  toast: byId("toast"),
};

const SOLFEGE = ["do", "di", "re", "ri", "mi", "fa", "fi", "sol", "si", "la", "li", "ti"];
const KEYBOARD_START = 48;   // C3
const KEYBOARD_END = 84;     // C6

// 当前编辑的声部位置（v2：声部 / 第几行谱表 / 第几条声部线）
const DEFAULT_REF = { partIndex: 0, staffIndex: 0, voiceIndex: 0 };

const state = {
  // v2 谱（多声部 + 绝对拍位）；界面渲染时转成 v1 视图，操作全部写回这里
  score: null,
  scoreView: null,        // v2ScoreToV1 的结果（界面与旧导出用）
  activeRef: { ...DEFAULT_REF },
  activePartId: null,
  pitch: 60,               // 当前输入音高（C4）
  beats: 1,                // 当前选中的时值
  restMode: false,          // 当前是在放「音符」还是「休止符」
  selection: null,          // { partId, measureIndex, noteId } 或 { partId, fromMeasure, toMeasure }
  history: [], future: [],
  audio: null, master: null, sources: new Set(), timers: [],
  isPlaying: false,
  sampleManifest: null, sampleBanks: new Map(),
};

/* ---------------- v2 界面辅助：声部线选择 / 记号面板 ---------------- */

/**
 * 刷新「写到哪一行」的两个下拉框（第几行谱表 / 第几条声部线）。
 */
function refreshStaffVoiceSelectors() {
  const score = currentScore();
  if (!score) return;
  const ref = v2ClampVoiceRef(score, state.activeRef);
  state.activeRef = ref;
  const part = (score.parts || [])[ref.partIndex];
  if (!part) return;
  if (els.staffSelector) {
    const current = ref.staffIndex;
    els.staffSelector.replaceChildren();
    (part.staves || []).forEach((staff, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `第 ${index + 1} 行谱表`;
      if (index === current) option.selected = true;
      els.staffSelector.append(option);
    });
  }
  if (els.voiceSelector) {
    const staff = (part.staves || [])[ref.staffIndex];
    const current = ref.voiceIndex;
    els.voiceSelector.replaceChildren();
    ((staff && staff.voices) || []).forEach((voice, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = (staff.voices || []).length > 1 ? `第 ${index + 1} 条声部线` : "（这一行只有一条）";
      if (index === current) option.selected = true;
      els.voiceSelector.append(option);
    });
  }
}

/** 力度记号的小图形（用文字排版出强弱感）。 */
function dynamicGlyph(key) {
  return `<span class="dynamic-glyph dyn-${key}">${key}</span>`;
}

/** 演奏记号/装饰音的图形（真实符号）。 */
function symbolGlyph(kind) {
  const map = {
    staccato: "staccato", accent: "accent", tenuto: "staccato",
    marcato: "accent", fermata: "fermata", trill: "fermata",
    turn: "slur", mordent: "accent", grace: "slur",
    tie: "tie", slur: "slur",
  };
  const real = map[kind] || kind;
  return `<svg class="value-glyph" viewBox="0 0 32 32" width="26" height="26">${symbolMarkup(real, { size: 32 })}</svg>`;
}

/**
 * 「记号」面板：强弱、怎么弹、装饰音、连线。
 * 全部画成真实符号；先点谱面上的一个音，再点这里。
 */
function buildMarkGroups() {
  if (!els.markGroups) return;
  const groups = [
    {
      title: "强弱（声音大小）", key: "dynamic",
      items: V2_DYNAMICS.map((item) => ({ value: item.key, label: item.label, glyph: dynamicGlyph(item.key) })),
    },
    {
      title: "怎么弹（断奏 / 重音 / 保持 / 延音）", key: "articulations",
      items: V2_ARTICULATIONS.map((item) => ({ value: item.key, label: item.label, glyph: symbolGlyph(item.key) })),
    },
    {
      title: "装饰音", key: "ornaments",
      items: V2_ORNAMENTS.map((item) => ({ value: item.key, label: item.label, glyph: symbolGlyph(item.key) })),
    },
    {
      title: "连线（把相邻的音连起来）", key: "tie",
      items: [
        { value: "start", label: "开始连音线", glyph: symbolGlyph("tie") },
        { value: "stop", label: "结束连音线", glyph: symbolGlyph("tie") },
        { value: "slur", label: "圆滑线（一弓/一口气）", glyph: symbolGlyph("slur") },
      ],
    },
  ];
  els.markGroups.replaceChildren();
  for (const group of groups) {
    const wrapper = document.createElement("div");
    wrapper.className = "mark-group";
    const title = document.createElement("span");
    title.className = "mark-title";
    title.textContent = group.title;
    wrapper.append(title);
    const row = document.createElement("div");
    row.className = "mark-row";
    for (const item of group.items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip chip-mark";
      button.title = item.label;
      button.dataset.markKey = group.key;
      button.dataset.markValue = item.value;
      button.innerHTML = `${item.glyph}<small>${item.label}</small>`;
      button.addEventListener("click", () => {
        const result = toggleMarkOnSelection(group.key, item.value);
        if (result) {
          button.classList.toggle("is-active", Boolean(result.on));
          showToast(result.on ? `已加上「${item.label}」` : `已取消「${item.label}」`);
        }
      });
      row.append(button);
    }
    wrapper.append(row);
    els.markGroups.append(wrapper);
  }
}

/* ---------------- 基础工具 ---------------- */
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}

/**
 * 把 v2 谱转成界面/播放用的 v1 视图。
 * 界面仍然用「小节 × 拍位」的画法（VexFlow 那边不用改），
 * 但每个拍位都带 v2Event 引用，所以改 v1 能写回 v2。
 */
function syncScoreView() {
  if (!state.score) return;
  state.scoreView = v2ScoreToV1(state.score);
}

/** 当前 v2 谱（对外统一入口）。 */
function currentScore() {
  return state.score;
}

/** 当前 v1 视图里的声部（界面用；v1 视图由 v2 谱转来，每个 (声部,谱表,声部线) 一项）。 */
function activePart() {
  const parts = (state.scoreView && state.scoreView.parts) || [];
  return parts[state.activeRef.partIndex] || parts[0] || null;
}

function pushHistory() {
  state.history.push(cloneV2Score(state.score));
  if (state.history.length > 60) state.history.shift();
  state.future.length = 0;
  syncHistoryButtons();
}

function syncHistoryButtons() {
  els.undo.disabled = state.history.length === 0;
  els.redo.disabled = state.future.length === 0;
}

function undo() {
  if (!state.history.length) return;
  state.future.push(cloneV2Score(state.score));
  state.score = state.history.pop();
  state.activeRef = v2ClampVoiceRef(state.score, state.activeRef);
  afterScoreChange();
  syncHistoryButtons();
  showToast("已撤销。");
}


function redo() {
  if (!state.future.length) return;
  state.history.push(cloneV2Score(state.score));
  state.score = state.future.pop();
  state.activeRef = v2ClampVoiceRef(state.score, state.activeRef);
  afterScoreChange();
  syncHistoryButtons();
  showToast("已重做。");
}


/* ---------------- 音频：合成音色 + 采样音色 ---------------- */
function ensureAudio() {
  if (!state.audio) {
    const Context = window.AudioContext || window.webkitAudioContext;
    state.audio = new Context();
    const master = state.audio.createGain();
    master.gain.value = 0.8;
    master.connect(state.audio.destination);
    state.master = master;
  }
  if (state.audio.state === "suspended") state.audio.resume();
  return state.audio;
}

function midiToFrequency(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

/** 合成音色的极简音源（钢琴/弦乐/合唱/管风琴/电子琴五类，够试听即可）。 */
function synthTone(timbre, midi, startAt, durationSeconds, peak = 0.2) {
  const context = ensureAudio();
  const frequency = midiToFrequency(midi);
  const gain = context.createGain();
  gain.gain.value = 0;
  gain.connect(state.master);
  const oscillators = [];
  const shape = {
    piano: { types: ["triangle", "sine"], detune: [-4, 4], partials: [1, 0.5], attack: 0.004, release: 0.22 },
    soft: { types: ["triangle", "sine"], detune: [0, 0], partials: [1, 0.35], attack: 0.01, release: 0.25 },
    strings: { types: ["sawtooth", "sawtooth", "sawtooth"], detune: [-6, 0, 7], partials: [0.5, 0.5, 0.4], attack: 0.09, release: 0.28 },
    choir: { types: ["sine", "triangle", "sine"], detune: [-3, 3, 0], partials: [0.6, 0.5, 0.3], attack: 0.08, release: 0.26 },
    organ: { types: ["sine", "sine", "sine"], detune: [0, 0, 0], partials: [1, 0.5, 0.25], attack: 0.03, release: 0.14, multiplier: [1, 2, 3] },
  }[timbre] || { types: ["triangle"], detune: [0], partials: [1], attack: 0.005, release: 0.2 };
  shape.types.forEach((type, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = type;
    const multiplier = (shape.multiplier && shape.multiplier[index]) || 1;
    oscillator.frequency.value = frequency * multiplier;
    oscillator.detune.value = shape.detune[index] || 0;
    const partial = context.createGain();
    partial.gain.value = shape.partials[index] || 0.3;
    oscillator.connect(partial).connect(gain);
    oscillator.start(startAt);
    oscillator.stop(startAt + durationSeconds + shape.release + 0.05);
    oscillators.push(oscillator);
  });
  const end = startAt + Math.max(0.08, durationSeconds);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + shape.attack);
  gain.gain.setTargetAtTime(peak * 0.72, startAt + shape.attack, 0.12);
  gain.gain.setValueAtTime(Math.max(0.0001, peak * 0.5), end);
  gain.gain.exponentialRampToValueAtTime(0.0001, end + shape.release);
  state.sources.add(gain);
  setTimeout(() => state.sources.delete(gain), (durationSeconds + shape.release + 0.3) * 1000);
  return oscillators;
}

/** 播放一个音：有采样音源就用采样，否则退回合成。 */
function playPitch(part, midi, startAt, durationSeconds, velocity = 0.85) {
  const timbre = (part && part.timbre) || "piano";
  if (isSampledTimbre(timbre)) {
    const bank = state.sampleBanks.get(timbre);
    if (bank) {
      const lookup = lookupSample(bank, Math.max(0, Math.min(127, midi)), velocity);
      if (lookup && lookup.sample) {
        const context = ensureAudio();
        const sample = lookup.sample;
        const source = createSampleSource(context, sample, { loop: Boolean(bank.continuous) });
        source.playbackRate.value = lookup.playbackRate;
        const gain = context.createGain();
        gain.gain.value = 0.9;
        source.connect(gain).connect(state.master);
        source.start(startAt);
        if (bank.continuous) {
          // 长音：先正常响，音符结束前 0.12 秒淡出，避免「刹车声」
          gain.gain.setValueAtTime(0.9, startAt + Math.max(0.02, durationSeconds));
          gain.gain.linearRampToValueAtTime(0.0001, startAt + durationSeconds + 0.14);
          source.stop(startAt + durationSeconds + 0.16);
        } else {
          source.stop(startAt + durationSeconds + 0.05);
        }
        state.sources.add(source);
        source.onended = () => state.sources.delete(source);
        return;
      }
    }
  }
  const fallback = isSampledTimbre(timbre) ? fallbackTimbre(timbre, SAMPLED_TIMBRES[timbre]) : timbre;
  synthTone(fallback, midi, startAt, durationSeconds, 0.18);
}

/** 试着加载某个采样音源（装没装都安全）。 */
async function ensureSampleBank(bank) {
  if (!isSampledTimbre(bank)) return null;
  if (state.sampleBanks.has(bank)) return state.sampleBanks.get(bank);
  if (!state.sampleManifest) {
    try {
      state.sampleManifest = await fetchSampleManifest();
    } catch {
      return null;
    }
  }
  if (!isInstalledBank(state.sampleManifest, bank)) return null;
  try {
    const loaded = await loadSampleBank(state.sampleManifest, bank);
    if (loaded) state.sampleBanks.set(bank, loaded);
    return loaded;
  } catch {
    return null;  // 加载失败就当没装，退回合成音色
  }
}

/**
 * 创建一个 bufferSource：一次性把 buffer 与循环参数都设好。
 * 注意：AudioBufferSourceNode.buffer 只能成功赋值一次，之后再赋会抛
 * 「Cannot set buffer to non-null after it has been already set」——所以调用方不要再设。
 */
function createSampleSource(context, sample, { loop = false } = {}) {
  const source = context.createBufferSource();
  source.buffer = sample.buffer;
  if (loop) {
    if (Number.isFinite(sample.loopStart) && Number.isFinite(sample.loopEnd) && sample.loopEnd > sample.loopStart) {
      source.loopStart = sample.loopStart;
      source.loopEnd = sample.loopEnd;
    } else {
      source.loopStart = Math.max(0.05, sample.buffer.duration * 0.3);
      source.loopEnd = Math.max(source.loopStart + 0.1, sample.buffer.duration * 0.9);
    }
    source.loop = true;
  }
  return source;
}

/* ---------------- 试听 ---------------- */
function stopPlayback(showMessage = true) {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.length = 0;
  for (const source of state.sources) {
    try {
      if (typeof source.stop === "function") source.stop();
      else if (source.gain) source.gain.disconnect();
    } catch {
      // 停不掉的已经结束了，忽略
    }
  }
  state.sources.clear();
  state.isPlaying = false;
  els.playbackState.textContent = "未在播放";
  if (showMessage) els.stopPlay.disabled = true;
}

/**
 * 播放指定拍区间。
 * beatFrom/beatTo 是「整首曲子的第几拍」；不传就是整首。
 */
function playRange(beatFrom = 0, beatTo = Infinity) {
  stopPlayback(false);
  const context = ensureAudio();
  // 有反复记号时按反复顺序展开（反复改变的是播放顺序，不是音符本身）
  const allNotes = expandForRepeats(v2PlayableNotes(state.score));
  const notes = allNotes.filter((note) => {
    const start = note.startBeat;
    const end = start + note.durationBeats;
    return end > beatFrom + 1e-9 && start < beatTo - 1e-9;
  });
  if (!notes.length) {
    showToast("这一段还没有音符，先加点音吧。");
    return;
  }
  const secondsPerBeat = 60 / Math.max(20, Math.min(320, Number(state.score.tempo) || 84));
  const startAt = context.currentTime + 0.08;
  for (const note of notes) {
    const offset = Math.max(0, note.startBeat - beatFrom);
    const duration = Math.min(note.durationBeats, beatTo - Math.max(note.startBeat, beatFrom));
    if (duration <= 0) continue;
    // v1 视图的 partId 对应 v1 的声部；音色从视图里取，取不到退回 piano
    const viewPart = ((state.scoreView && state.scoreView.parts) || [])
      .find((item) => item.id === note.partId);
    playPitch(viewPart || { timbre: "piano" }, note.midi, startAt + offset * secondsPerBeat, duration * secondsPerBeat);
  }
  const totalSeconds = (Math.min(beatTo, Math.max(...allNotes.map((note) => note.startBeat + note.durationBeats))) - beatFrom) * secondsPerBeat;
  state.isPlaying = true;
  els.stopPlay.disabled = false;
  els.playbackState.textContent = `正在播放 ${Math.max(0, totalSeconds).toFixed(1)} 秒`;
  const finish = () => {
    if (!state.isPlaying) return;
    if (els.loopPlay.checked) playRange(beatFrom, beatTo);
    else {
      state.isPlaying = false;
      els.playbackState.textContent = "播放结束";
      els.stopPlay.disabled = true;
    }
  };
  state.timers.push(setTimeout(finish, Math.max(200, totalSeconds * 1000 + 120)));
}

/* ---------------- 五线谱绘制 ---------------- */
const VF = window.VexFlow || window.Vex;
/* 乐谱字形字体：VexFlow 5 默认从 CDN 下载 Bravura，离线环境下载失败，
   符头就会退化成黑色方块（实测：Font.load 报 "A network error occurred."）。
   这里改为加载 vendor/vexflow-fonts/ 下的本地字体。 */
let scoreFontReady = false;
async function loadScoreFonts() {
  if (scoreFontReady) return;
  try {
    await VF.Font.load("Bravura");
    scoreFontReady = true;
    if (typeof renderScore === "function") renderScore();
  } catch (error) {
    console.info("[创作室] 乐谱字体没能加载（谱面会退化成方块）：", error && error.message);
  }
}
loadScoreFonts();
/**
 * 在谱面上画出「连音线 / 圆滑线」。
 *
 * 为什么单独一遍：VexFlow 的 StaveTie / Curve 必须在音符已经绘制之后再画，
 * 否则拿不到正确坐标。之前只把 tie 记在数据里、谱面完全看不到——
 * 用户反馈「加了连音线在谱子上看不到」就漏在这里。
 *
 * VexFlow 5 的参数是驼峰 firstNote / lastNote（4.x 是 first_note），
 * 传错会抛 "Tie needs to have either firstNote or lastNote set."（实测）。
 */
function drawConnections(notes, svg) {
  try {
    drawConnectionsInner(notes, svg);
  } catch (error) {
    // 连线是附加内容：画不出来绝不能让整个小节渲染失败（之前就是这样导致谱面空白）
    console.warn("[创作室] 画连线失败（不影响谱面）：", error && error.message);
  }
}

function drawConnectionsInner(notes, svg) {
  // 只取「真正参与排版、且有 TickContext」的音符：休止符与 BarNote 不画连线，没有 TickContext 的音符硬画会抛 NoTickContext（实测）。
  const staveNotes = notes.filter((note) => note instanceof VF.StaveNote
    && !note.__pujianRest
    && typeof note.getTickContext === "function"
    && note.getTickContext());
  // 诊断信息挂到 window（只在 ?debug=1 时有用，不影响正常使用）
  if (window.__pujianTieDebug !== undefined) {
    window.__pujianTieDebug = {
      staveNotes: staveNotes.length,
      flags: staveNotes.map((note) => ({ tie: Boolean(note.__pujianTie), slur: Boolean(note.__pujianSlur) })),
      hasTickContext: staveNotes.map((note) => Boolean(note.getTickContext && note.getTickContext())),
    };
  }
  for (let index = 0; index < staveNotes.length - 1; index += 1) {
    const from = staveNotes[index];
    const to = staveNotes[index + 1];
    const drawTie = from.__pujianTie || to.__pujianTie;
    const drawSlur = from.__pujianSlur || to.__pujianSlur;
    if (!drawTie && !drawSlur) continue;
    try {
      if (drawTie && VF.StaveTie) {
        // VexFlow 5 的 StaveTie 需要音符已完成 format（有 TickContext）。
        // 用 setContext(...).draw() 时它会读音符坐标，拿不到就抛 NoTickContext（实测）。
        const tie = new VF.StaveTie({
          firstNote: from, lastNote: to,
          firstIndexes: [0], lastIndexes: [0],
        });
        tie.setContext(svg);
        tie.draw();
      }
      if (drawSlur && VF.Curve) {
        new VF.Curve(from, to, {
          cps: [{ x: 0, y: 12 }, { x: 0, y: 12 }],
          thickness: 2,
        }).setContext(svg).draw();
      }
    } catch (tieError) {
      // 连线画不出来不影响其它内容，但要能定位原因
      console.warn("[创作室] 画连线失败：", tieError && tieError.message);
    }
  }
}

function renderScore() {
  if (!VF) {
    els.scoreEditor.textContent = "五线谱渲染组件没加载成功（vendor/vexflow/vexflow.js）。";
    return;
  }
  const { Factory } = VF;
  /** v2 的原始拍号（VexFlow 要用「3/8」这种，不能用换算成四分音符的 1.5）。 */
function scoreTimeSignature() {
  const score = currentScore();
  return (score && score.timeSignature) || { beats: 4, beatType: 4 };
}

const view = state.scoreView;
  if (!view) return;
  const measureCount = Math.max(1, Math.ceil(v2TotalBeats(state.score) / view.beatsPerMeasure));
  const width = Math.max(680, els.scoreEditor.clientWidth || 760);
  const staveWidth = width - 40;
  const partCount = view.parts.length;
  const staveHeight = 62;
  const systemHeight = staveHeight * partCount + 34;
  const height = Math.max(320, systemHeight * 4 + 40);

  els.scoreEditor.replaceChildren();
  const renderer = new VF.Renderer(els.scoreEditor, VF.Renderer.Backends.SVG);
  renderer.resize(width, height);
  const svg = renderer.getContext();
  // 热区要挂在真正的 <svg> 元素上（SVGContext 没有 getSVGElement）
  const svgElement = els.scoreEditor.querySelector("svg");

  const time = scoreTimeSignature();
  const measuresPerLine = 2;
  view.parts.forEach((part, partIndex) => {
    const clef = part.clef === "bass" ? "bass" : part.clef === "alto" ? "alto" : part.clef === "tenor" ? "tenor" : "treble";
    for (let line = 0; line * measuresPerLine < measureCount; line += 1) {
      for (let slot = 0; slot < measuresPerLine; slot += 1) {
        const measureIndex = line * measuresPerLine + slot;
        if (measureIndex >= measureCount) continue;
        const x = 20 + slot * (staveWidth / measuresPerLine);
        const y = 20 + line * systemHeight + partIndex * staveHeight;
        const stave = new VF.Stave(x, y, staveWidth / measuresPerLine);
        if (measureIndex === 0) {
          stave.addClef(clef);
          if (partIndex === 0) {
            const keyName = keySignatureName(view.keyFifths);
            if (keyName) stave.addKeySignature(keyName);
            stave.addTimeSignature(`${time.beats}/${time.beatType}`);
          }
        }
        // 行尾/曲尾用双重小节线（不需要 TickContext，画笔直接画）
        if (slot === measuresPerLine - 1 || measureIndex === measureCount - 1) {
          stave.setEndBarType(VF.Barline.type.END);
        }
        stave.setContext(svg).draw();

        const measure = part.measures[measureIndex] || { beats: [] };
        const { slots } = buildMeasureSlots(measure, view.beatsPerMeasure);
        const notes = [];
        for (const item of slots) {
          const length = beatsToVfDuration(item.beats);
          if (item.rest) {
            // 休止符：用 VexFlow 的 "r" 后缀画成休止记号（用户看得懂、也符合乐谱规范）
            const restNote = new VF.StaveNote({
              clef,
              keys: [clef === "bass" ? "d/3" : "b/4"],
              duration: `${length}r`,
            });
            restNote.__pujianId = item.id;
            restNote.__pujianPart = part.id;
            restNote.__pujianBeats = item.beats;
            restNote.__pujianRest = true;
            notes.push(restNote);
            continue;
          }
          const key = vfKeyFor(item.midi);
          const note = new VF.StaveNote({ clef, keys: [key], duration: length, auto_stem: true });
          // 临时升降号不在这里手动加：VexFlow 5 要用 Accidental.applyAccidentals(voices, key)
          // 统一算一遍（见下面 voice 建好之后的调用），手动 modifier 在 5.0 里不会绘制。
          note.__pujianId = item.id;
          note.__pujianPart = part.id;
          note.__pujianBeats = item.beats;
          note.__pujianKey = key;
          // 记号：连音线 / 圆滑线（渲染时在音符画完之后再画线，见 drawConnections）
          note.__pujianTie = Boolean(item.tie || item.tieFromPrev);
          note.__pujianSlur = Boolean(item.slur || item.slurStop);
          notes.push(note);
        }
        const remaining = remainingBeats(measure, view.beatsPerMeasure);
        if (remaining > 1e-9) {
          const rest = new VF.StaveNote({ clef, keys: [clef === "bass" ? "d/3" : "b/4"], duration: beatsToVfDuration(remaining) + "r" });
          notes.push(rest);
        }
        if (!notes.length) {
          notes.push(new VF.StaveNote({ clef, keys: [clef === "bass" ? "d/3" : "b/4"], duration: "1r" }));
        }
        // 行尾的小节线
        if (slot === measuresPerLine - 1 || measureIndex === measureCount - 1) {
          const endBar = new VF.BarNote(VF.Barline.type.END);
          endBar.setStave(stave);
          notes.push(endBar);
        }
        try {
          // 注意：v2 谱没有 beatsPerMeasure 字段（那是 v1 的），要用拍号换算值，
          // 否则 Voice 的 num_beats 是 undefined，format 会失败、音符拿不到 TickContext，
          // 连音线也会跟着报 NoTickContext（实测）。
          if (window.__pujianRenderSteps !== undefined) window.__pujianRenderSteps.push("voice-start");
          const voice = new VF.Voice({ num_beats: view.beatsPerMeasure, beat_value: view.beatType || 4 })
            .setMode(VF.Voice.Mode.SOFT);
          voice.addTickables(notes.filter((note) => note instanceof VF.StaveNote));
          // 临时升降号：按调号与同小节/前后音自动判断该标 # / b / n（VexFlow 5 的官方做法）
          try {
            VF.Accidental.applyAccidentals([voice], keySignatureName(view.keyFifths) || "C");
          } catch {
            // 算不出就退化成「只画音高」，不影响其它功能
          }
          const formatter = new VF.Formatter();
          if (window.__pujianRenderSteps !== undefined) window.__pujianRenderSteps.push("before-format:" + notes.length);
          formatter.joinVoices([voice]).format([voice], staveWidth / measuresPerLine - 30);
          if (window.__pujianRenderSteps !== undefined) window.__pujianRenderSteps.push("after-format");
          if (window.__pujianRenderSteps !== undefined) window.__pujianRenderSteps.push("before-draw");
          voice.draw(svg, stave);
          if (window.__pujianRenderSteps !== undefined) window.__pujianRenderSteps.push("after-draw");
          for (const note of notes) {
            // 小节线用 Stave.setEndBarType 画（VexFlow 5 的 BarNote.draw 需要 TickContext，
            // 拿不到会抛 NoTickContext 并让整个 try 中断，连音线就永远画不出来——实测踩到）。
            void note;
          }
          // 连音线 / 圆滑线：必须在音符绘制之后再画，才拿得到坐标
          drawConnections(notes, svg);
          // 热区在 renderScore() 末尾统一绘制（见 drawNoteHitAreas）
        } catch (renderError) {
          // 谱面渲染失败时不阻塞输入（数据模型本身是对的），但要能看到原因
          console.warn("[创作室] 谱面渲染出错：", renderError && renderError.message);
        }
      }
    }
  });
  els.scoreEmpty.hidden = hasAnyNote();
  drawNoteHitAreas();
  attachNoteClicks();
}

/**
 * 画「点音符」的透明热区。
 * 放在渲染完成之后单独一遍：这样即使某个音符的绘制抛异常，热区也不会连带丢失。
 * 位置按「小节内第几拍 + 音高」估算（VexFlow 5 的 DOM 元素不带 boundingBox）。
 */
function drawNoteHitAreas() {
  const svgElement = els.scoreEditor.querySelector("svg");
  if (!svgElement) return;
  const view = state.scoreView;
  if (!view) return;
  const measureCount = Math.max(1, Math.ceil(v2TotalBeats(state.score) / view.beatsPerMeasure));
  const measuresPerLine = 2;
  const width = Math.max(680, els.scoreEditor.clientWidth || 760);
  const staveWidth = width - 40;
  const staveHeight = 62;
  const systemHeight = staveHeight * view.parts.length + 34;
  let added = 0;
  // 遍历 v1 视图（v2 → v1 转换保证了每个拍位都带 v2Event 引用）
  view.parts.forEach((part, partIndex) => {
    const clef = part.clef === "bass" ? "bass" : "treble";
    for (let line = 0; line * measuresPerLine < measureCount; line += 1) {
      for (let slot = 0; slot < measuresPerLine; slot += 1) {
        const measureIndex = line * measuresPerLine + slot;
        if (measureIndex >= measureCount) continue;
        const measure = part.measures[measureIndex];
        if (!measure) continue;
        const x = 20 + slot * (staveWidth / measuresPerLine);
        const y = 20 + line * systemHeight + partIndex * staveHeight;
        const { slots } = buildMeasureSlots(measure, view.beatsPerMeasure);
        const totalBeats = Math.max(1, view.beatsPerMeasure);
        for (const item of slots) {
          const middle = item.startBeats + item.beats / 2;
          const key = item.rest ? (clef === "bass" ? "d/3" : "b/4") : vfKeyFor(item.midi);
          const [letter, octaveText] = key.split("/");
          const octave = Number(octaveText) || 4;
          const stepIndex = ["c", "d", "e", "f", "g", "a", "b"].indexOf(letter[0].toLowerCase());
          const referenceOctave = clef === "bass" ? 3 : 4;
          const referenceStep = clef === "bass" ? 1 : 6;   // 低音谱表 d/3、高音谱表 b/4 在中间线
          const diatonic = (octave * 7 + stepIndex) - (referenceOctave * 7 + referenceStep);
          const noteY = y + 60 - diatonic * 5.5;
          const noteX = x + 30 + (middle / totalBeats) * (staveWidth / measuresPerLine - 60);
          const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          rect.setAttribute("x", String(Math.round(noteX - 12)));
          rect.setAttribute("y", String(Math.round(noteY - 16)));
          rect.setAttribute("width", "26");
          rect.setAttribute("height", "32");
          rect.setAttribute("fill", "rgba(0,0,0,0)");
          rect.setAttribute("class", "note-hit");
          rect.setAttribute("data-note-id", item.id);
          rect.setAttribute("data-part-id", part.id);
          rect.style.cursor = "pointer";
          rect.style.pointerEvents = "all";
          svgElement.append(rect);
          added += 1;
        }
      }
    }
  });
  if (added === 0) console.warn("[创作室] 没有可画热区的音符");
}

/** MIDI → VexFlow 的 key 写法（如 c/4、c#/4、bb/3）。 */
function vfKeyFor(midi) {
  const value = Math.max(21, Math.min(108, Math.round(Number(midi) || 60)));
  const names = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
  const pitch = ((value % 12) + 12) % 12;
  const octave = Math.floor(value / 12) - 1;
  return `${names[pitch]}/${octave}`;
}

function keySignatureName(fifths) {
  const table = { 0: "C", 1: "G", 2: "D", 3: "A", "-1": "F", "-2:": "Bb", "-2": "Bb", "-3": "Eb" };
  return table[String(fifths)] || "";
}

function beatsToVfDuration(beats) {
  const table = [
    [4, "1"], [3, "2"], [2, "2"], [1.5, "4"], [1, "4"], [0.75, "8"], [0.5, "8"], [0.375, "16"], [0.25, "16"], [0.125, "32"],
  ];
  for (const [value, duration] of table) {
    if (Math.abs(value - beats) < 1e-6) {
      const dotted = [3, 1.5, 0.75, 0.375].some((item) => Math.abs(item - beats) < 1e-6);
      return dotted ? duration + "d" : duration;
    }
  }
  return "4";
}

function attachNoteClicks() {
  // 透明热区（每音符一块）是主要入口；键盘可达性另由左侧按钮保证
  for (const element of els.scoreEditor.querySelectorAll(".note-hit")) {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      const noteId = element.dataset.noteId;
      const partId = element.dataset.partId;
      if (partId) {
        const parts = (state.scoreView && state.scoreView.parts) || [];
        const index = parts.findIndex((item) => item.id === partId);
        if (index >= 0) {
          state.activeRef = { ...state.activeRef, partIndex: index };
          if (els.partSelect) els.partSelect.value = String(index);
          refreshStaffVoiceSelectors();
        }
      }
      if (noteId) selectNoteById(noteId, event.shiftKey);
    });
  }
}

/* ---------------- 选中 / 编辑 ---------------- */
function selectNoteById(noteId, extend = false) {
  // 在 v1 视图里找（每个拍位带 v2Event 引用）
  for (const part of (state.scoreView && state.scoreView.parts) || []) {
    for (let measureIndex = 0; measureIndex < part.measures.length; measureIndex += 1) {
      const note = (part.measures[measureIndex].beats || []).find((item) => item.id === noteId);
      if (!note) continue;
      const partIndex = state.scoreView.parts.indexOf(part);
      state.selection = { partId: part.id, partIndex, noteId, measureIndex };
      state.activeRef = { ...state.activeRef, partIndex };
      updateSelectionBar();
      refreshStaffVoiceSelectors();
      renderScore();
      // 点到的音先听一声，确认选对了
      const midi = note.v2Event ? note.v2Event.midi : note.midi;
      const beatLength = note.v2Event ? note.v2Event.beats : note.beats;
      playPitch(part, midi, ensureAudio().currentTime + 0.01,
        Math.max(0.2, beatLength * (60 / (Number(state.score.tempo) || 84))));
      return;
    }
  }
}

function selectionBeats() {
  if (!state.selection || !state.scoreView) return null;
  const part = (state.scoreView.parts || []).find((item) => item.id === state.selection.partId);
  if (!part) return null;
  const measureBeats = state.scoreView.beatsPerMeasure;
  if (state.selection.noteId) {
    const flat = [];
    part.measures.forEach((measure, measureIndex) => {
      const { slots } = buildMeasureSlots(measure, measureBeats);
      for (const slot of slots) flat.push({ ...slot, measureIndex });
    });
    const index = flat.findIndex((slot) => slot.id === state.selection.noteId);
    if (index < 0) return null;
    return { from: flat[index].measureIndex * measureBeats + flat[index].startBeats, to: flat[index].measureIndex * measureBeats + flat[index].endBeats, partId: part.id };
  }
  return null;
}

function updateSelectionBar() {
  if (!state.selection) {
    els.editToolbar.hidden = true;
    return;
  }
  // 在 v1 视图里找选中的拍位（每个拍位带 v2Event 引用）
  const part = ((state.scoreView && state.scoreView.parts) || [])
    .find((item) => item.id === state.selection.partId);
  const note = part && part.measures[state.selection.measureIndex]
    ? (part.measures[state.selection.measureIndex].beats || [])
      .find((item) => item.id === state.selection.noteId) || null
    : null;
  if (!note) {
    els.editToolbar.hidden = true;
    return;
  }
  const event = note.v2Event || note;
  els.editToolbar.hidden = false;
  els.selectionInfo.textContent =
    `已选中：第 ${state.selection.measureIndex + 1} 小节 · ${midiToName(event.midi)} · ` +
    `${event.beats === 1 ? "1 拍" : `${event.beats} 拍`}`;
  els.editActions.replaceChildren();
  const actions = [
    ["↑ 高半音", () => applySelectionEvent((target) => changeSelectedMidi(target.midi + 1))],
    ["↓ 低半音", () => applySelectionEvent((target) => changeSelectedMidi(target.midi - 1))],
    ["更长（+半拍）", () => applySelectionEvent((target) => changeSelectedBeats(target.beats + 0.5))],
    ["更短（−半拍）", () => applySelectionEvent((target) => changeSelectedBeats(Math.max(0.25, target.beats - 0.5)))],
    ["删除这个音", () => deleteSelectedNote()],
    ["取消选中", () => { state.selection = null; updateSelectionBar(); renderScore(); }],
  ];
  for (const [label, handler] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button small";
    button.textContent = label;
    button.addEventListener("click", handler);
    els.editActions.append(button);
  }
}

/** 对「当前选中的 v2 事件」做一次修改，并刷新界面。 */
function applySelectionEvent(mutator) {
  const event = selectedEvent(currentScore());
  if (!event) {
    showToast("请先在谱面上点一个音。");
    return;
  }
  const result = mutator(event);
  if (result === null) return;
  if (result && result.ok === false) {
    showToast(v2ExplainReason(result.reason));
    return;
  }
  pushHistory();
  afterScoreChange();
}


function applySelection(mutator, message = "已修改。") {
  const part = state.score.parts.find((item) => item.id === state.selection?.partId);
  const note = part && part.measures[state.selection.measureIndex].beats.find((item) => item.id === state.selection.noteId);
  if (!part || !note) return;
  pushHistory();
  const ok = mutator(note);
  if (ok === false) {
    state.history.pop();
    syncHistoryButtons();
    showToast("这个小节放不下了，要不要先删掉一个音？");
    return;
  }
  afterScoreChange();
  showToast(message);
}

/* ---------------- 界面同步 ---------------- */
function hasAnyNote() {
  const parts = (state.scoreView && state.scoreView.parts) || [];
  return parts.some((part) => part.measures.some((measure) => measure.beats.length > 0));
}

function afterScoreChange(rerender = true) {
  syncScoreView();
  updateSelectionBar();
  updateMeasureStatus();
  syncPartSelect();
  refreshStaffVoiceSelectors();
  buildMarkGroups();
  updateRepeatInfo();
  if (rerender) renderScore();
  syncHistoryButtons();
}


function updateMeasureStatus() {
  const parts = (state.scoreView && state.scoreView.parts) || [];
  const part = parts[state.activeRef.partIndex] || parts[0];
  if (!part) {
    els.measureStatus.textContent = "还没有音符";
    return;
  }
  const last = part.measures[part.measures.length - 1];
  if (!last) {
    els.measureStatus.textContent = "第 1 小节还差 " + state.scoreView.beatsPerMeasure + " 拍";
    return;
  }
  const remaining = remainingBeats(last, state.scoreView.beatsPerMeasure);
  const index = part.measures.length;
  els.measureStatus.textContent = remaining > 1e-9
    ? `第 ${index} 小节还差 ${remaining} 拍`
    : `第 ${index} 小节已满，下一个音会进第 ${index + 1} 小节`;
}

/** 同步「当前声部」相关的控件（音色/谱号/删除按钮可用性）。 */
function syncActivePartControls() {
  const parts = (state.scoreView && state.scoreView.parts) || [];
  if (els.removePart) els.removePart.disabled = parts.length <= 1;
  const part = parts[state.activeRef.partIndex];
  if (part) {
    if (els.scoreTimbre) els.scoreTimbre.value = part.timbre || "piano";
  }
}

function syncPartSelect() {
  if (!els.partSelect) return;
  const parts = (state.scoreView && state.scoreView.parts) || [];
  els.partSelect.replaceChildren();
  parts.forEach((part, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = part.name;
    if (index === state.activeRef.partIndex) option.selected = true;
    els.partSelect.append(option);
  });
  syncActivePartControls();
}

function buildKeyboard() {
  els.miniKeyboard.replaceChildren();
  for (let midi = KEYBOARD_START; midi <= KEYBOARD_END; midi += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key" + (isBlackKey(midi) ? " is-black" : "");
    button.dataset.midi = String(midi);
    const name = midiToName(midi);
    const showName = midi % 12 === 0;  // 只在 C 上显示音名，键盘不至于太挤
    button.innerHTML = showName ? `${name}<small>${SOLFEGE[0]}</small>` : "<small>·</small>";
    button.title = `${name}（${SOLFEGE[(midi % 12)]}）`;
    if (midi % 12 === 0) button.classList.add("is-octave-mark");
    button.addEventListener("click", () => {
      state.pitch = midi;
      updatePitchReadout();
      markActiveKey();
      playPitch(activePart(), midi, ensureAudio().currentTime + 0.01, 0.5);
    });
    els.miniKeyboard.append(button);
  }
  markActiveKey();
}

function markActiveKey() {
  for (const button of els.miniKeyboard.querySelectorAll(".key")) {
    button.classList.toggle("is-active", Number(button.dataset.midi) === state.pitch);
  }
}

function updatePitchReadout() {
  const name = midiToName(state.pitch);
  els.pitchLabel.textContent = name;
  const solfege = SOLFEGE[((state.pitch % 12) + 12) % 12];
  els.pitchHint.textContent = state.pitch === 60 ? "中央 C · 唱名 do" : `唱名 ${solfege} · 八度 ${Math.floor(state.pitch / 12) - 1}`;
}

/**
 * 时值选择器：每个选项都画成**谱面上的真实符号**，再配「够几拍」的小方块和一句人话。
 *
 * 为什么不用「四分音符 / 八分音符」这种写法：真实用户（合唱团成员、非专业）反馈
 * 「这哪个没乐理基础的人看得懂啊」。所以这里是「看到什么就点什么」：
 * 画的是符头符干符尾、休止符、附点，下面用小方块表示能撑几拍。
 */
function buildValueChips() {
  els.valueChips.replaceChildren();
  // 第一行：音符（会发出声音）
  for (const item of NOTE_VALUES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip chip-value";
    button.dataset.beats = String(item.beats);
    button.dataset.rest = "false";
    button.title = `${item.label}：${beatsToHuman(item.beats)}`;
    button.innerHTML = `
      <span class="chip-glyph">${valueGlyphSvg(item.beats, { size: 40, title: item.label })}</span>
      <span class="chip-bar">${beatsBarMarkup(item.beats)}</span>
      <span class="chip-human">${beatsToHuman(item.beats)}</span>
      <small class="chip-term">${item.label}</small>`;
    button.addEventListener("click", () => {
      state.beats = item.beats;
      state.restMode = false;
      markActiveChip();
      previewValue(item.beats, false);
    });
    els.valueChips.append(button);
  }
  // 第二行：休止符（占拍数、不发声）——画的是休止符本身
  for (const item of REST_VALUES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip chip-value is-rest";
    button.dataset.beats = String(item.beats);
    button.dataset.rest = "true";
    button.title = `停顿（休止符）：占 ${beatsToHuman(item.beats)}，不发声`;
    button.innerHTML = `
      <span class="chip-glyph">${valueGlyphSvg(item.beats, { rest: true, size: 40, title: item.label + "休止" })}</span>
      <span class="chip-bar">${beatsBarMarkup(item.beats)}</span>
      <span class="chip-human">停顿 ${beatsToHuman(item.beats)}</span>
      <small class="chip-term">${item.label}休止</small>`;
    button.addEventListener("click", () => {
      state.beats = item.beats;
      state.restMode = true;
      markActiveChip();
    });
    els.valueChips.append(button);
  }
  markActiveChip();
}

/** 点一个时值就听一下「这么长」是什么感觉（用当前选中的音高）。 */
function previewValue(beats, rest) {
  if (rest) return;
  try {
    const midi = Number(state.pitch) || 60;
    // 1 拍 = 60/tempo 秒，按当前速度换算成人耳能感知的长度
    const seconds = Math.max(0.12, (Number(state.score.tempo) || 84) * 0 + beats * (60 / (Number(state.score.tempo) || 84)));
    playPitch(activePart(), midi, ensureAudio().currentTime + 0.01, seconds);
  } catch {
    // 试听失败不影响选择，不打断用户
  }
}

function markActiveChip() {
  for (const button of els.valueChips.querySelectorAll(".chip")) {
    const sameBeats = Math.abs(Number(button.dataset.beats) - state.beats) < 1e-9;
    const sameKind = (button.dataset.rest === "true") === state.restMode;
    button.classList.toggle("is-active", sameBeats && sameKind);
  }
}

function buildTimbreOptions() {
  els.scoreTimbre.replaceChildren();
  const groups = [
    { label: "基础合成音色（不用装）", items: ["piano", "strings", "choir", "organ", "soft"] },
  ];
  for (const group of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const name of group.items) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = TIMBRE_LABELS[name] || name;
      optgroup.append(option);
    }
    els.scoreTimbre.append(optgroup);
  }
  // 已安装的采样音源（按分类分组，民乐排最前）
  const manifest = state.sampleManifest;
  if (manifest) {
    for (const group of groupBanksByCategory(manifest)) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const item of group.banks) {
        const option = document.createElement("option");
        option.value = item.bank;
        option.textContent = item.label;
        optgroup.append(option);
      }
      els.scoreTimbre.append(optgroup);
    }
  }
}

/* ---------------- 输入：加音 / 删除 ---------------- */
/**
 * 「＋ 加进乐谱」：把当前选中的音高/时值加到当前声部线的末尾。
 *
 * v2 模型里这就是「在光标位置 append 一个事件」；光标 = 该 voice 已用到的最远拍位。
 * 失败（拍位冲突等）会明确告诉用户原因，不再静默丢数据。
 */
function addCurrentNote() {
  const score = currentScore();
  if (!score) return;
  const beatValue = Number(state.beats) || 1;
  const result = v2AppendNote(score, state.activeRef, {
    midi: state.pitch, beats: beatValue, rest: state.restMode,
  });
  if (!result.ok) {
    showToast(v2ExplainReason(result.reason));
    return;
  }
  pushHistory();
  afterScoreChange();
  refreshStaffVoiceSelectors();
  // 加完试听一下，确认是对的
  playPitch(activePart(), state.restMode ? 0 : state.pitch,
    ensureAudio().currentTime + 0.01, beatValue * (60 / (number(els.scoreTempo.value) || 84)));
}

/** 「叠到选中的音上」：把当前音高作为和弦音叠加到谱面上选中的那个音。 */
function addChordToneToSelection() {
  const score = currentScore();
  if (!score) return;
  const selected = selectedEvent(score);
  if (!selected) {
    showToast("请先在下方谱面里点一个音，再叠加和弦。");
    return;
  }
  const result = v2AppendChordTone(score, state.activeRef, selected.id, state.pitch);
  if (!result.ok) {
    showToast(v2ExplainReason(result.reason));
    return;
  }
  pushHistory();
  syncScoreView();      // 立刻刷新视图，界面上能看到和弦
  afterScoreChange();
  showToast("已叠加上去，这个拍位现在是和弦。");
}

/** 谱面上当前选中的 v2 事件（点音符行得到）。 */
function selectedEvent(score) {
  const view = state.scoreView;
  if (!view || !state.selection) return null;
  const noteId = state.selection.noteId;
  if (!noteId) return null;
  // v1 拍位带 v2Event 引用
  for (const part of view.parts || []) {
    for (const measure of part.measures || []) {
      for (const beat of measure.beats || []) {
        if (beat.id === noteId && beat.v2Event) return beat.v2Event;
      }
    }
  }
  return null;
}

/** 删除选中的音。 */
function deleteSelectedNote() {
  const score = currentScore();
  const selected = selectedEvent(score);
  if (!selected) {
    showToast("请先点一个要删掉的音。");
    return;
  }
  const result = v2DeleteEvent(score, state.activeRef, selected.id);
  if (!result.ok) {
    showToast(v2ExplainReason(result.reason));
    return;
  }
  pushHistory();
  state.selection = null;
  afterScoreChange();
  refreshStaffVoiceSelectors();
  showToast("已删掉这个音。");
}

/** 改选中音的时值（右侧「时值」点一下就直接改这个音）。 */
function changeSelectedBeats(beats) {
  const score = currentScore();
  const selected = selectedEvent(score);
  if (!selected) return null;
  return v2ChangeEventBeats(score, state.activeRef, selected.id, beats);
}

/** 改选中音的音高。 */
function changeSelectedMidi(midi) {
  const score = currentScore();
  const selected = selectedEvent(score);
  if (!selected) return null;
  return v2ChangeEventMidi(score, state.activeRef, selected.id, midi);
}

/** 给选中的音加/取消一个记号。 */
function toggleMarkOnSelection(key, value) {
  const score = currentScore();
  const selected = selectedEvent(score);
  if (!selected) {
    showToast("请先在谱面里点一个音，再加记号。");
    return null;
  }
  const result = v2ToggleFlag(score, state.activeRef, selected.id, key, value);
  if (!result.ok) {
    showToast(v2ExplainReason(result.reason));
    return null;
  }
  pushHistory();
  afterScoreChange();
  return result;
}

/** 加一条声部线（同一行谱表里并行写第二条，例如钢琴左手伴奏）。 */
function addVoiceLine() {
  const score = currentScore();
  const result = v2AddVoiceTo(score, state.activeRef);
  if (!result.ok) {
    showToast(v2ExplainReason(result.reason));
    return;
  }
  pushHistory();
  state.activeRef = { ...state.activeRef, voiceIndex: result.voiceIndex };
  afterScoreChange();
  refreshStaffVoiceSelectors();
  showToast("已新开一条声部线，现在写的是它。");
}

/** 加一行谱表（钢琴的低音谱表、或再分一行写）。 */
function addStaffLine() {
  const score = currentScore();
  const result = v2AddStaffTo(score, state.activeRef);
  if (!result.ok) {
    showToast(v2ExplainReason(result.reason));
    return;
  }
  pushHistory();
  state.activeRef = { ...state.activeRef, staffIndex: result.staffIndex, voiceIndex: 0 };
  afterScoreChange();
  refreshStaffVoiceSelectors();
  showToast("已加一行谱表。");
}

/**
 * 每小节后面加一个空小节（写满当前小节时用）。
 * v2 里小节是「算出来的」，所以这里做的是确保「有音写到那一拍」——
 * 用一个占位休止把长度顶到目标小节数。
 */
function appendMeasureIfNeeded() {
  const score = currentScore();
  if (!score) return;
  const per = v2BeatsPerMeasure(score);
  const total = v2TotalBeats(score);
  const target = Math.ceil(total / per) * per + per;
  const voice = v2CurrentVoice(score, state.activeRef);
  if (!voice) return;
  // 在末尾补一个全小节休止（界面看起来就是多了一个空小节）
  v2AppendNote(score, state.activeRef, { midi: 0, beats: target - total, rest: true });
  pushHistory();
  afterScoreChange();
}

/**
 * 加反复记号（起点/终点）。
 * times 记在终点上，表示「这一段总共唱几遍」。
 */
function addRepeatMark(kind) {
  const score = currentScore();
  if (!score) return;
  const bar = Math.max(1, Math.round(Number(els.repeatBar.value) || 1));
  score.repeats = (score.repeats || []).filter((mark) => mark.bar !== bar);
  score.repeats.push(kind === "start"
    ? createRepeat(bar, "repeat-start")
    : createRepeat(bar, "repeat-end", { times: Number(els.repeatTimes.value) || 2 }));
  score.repeats.sort((left, right) => left.bar - right.bar);
  const problems = validateRepeats(score.repeats);
  pushHistory();
  afterScoreChange();
  updateRepeatInfo();
  if (problems.length) showToast("反复记号没配对：" + problems[0]);
  else showToast(kind === "start" ? `第 ${bar} 小节起反复。` : `第 ${bar} 小节为终点。`);
}

/**
 * 加一个「房子」（1. / 2. 段）：同一位置、不同遍数唱不同内容。
 * 第 1 遍唱 1. 房子，第 2 遍跳过它直接唱 2. 房子。
 */
function addEnding() {
  const score = currentScore();
  if (!score) return;
  const from = Math.max(1, Math.round(Number(els.endingStart.value) || 1));
  const to = Math.max(from, Math.round(Number(els.endingEnd.value) || from));
  const num = Math.max(1, Math.round(Number(els.endingNumber.value) || 1));
  score.repeats = (score.repeats || []).filter((mark) => !(String(mark.type).startsWith("ending")
    && mark.bar >= from && mark.bar <= to));
  score.repeats.push({ bar: from, type: "ending-start", number: num });
  score.repeats.push({ bar: to, type: "ending-stop", number: num });
  score.repeats.sort((left, right) => left.bar - right.bar);
  pushHistory();
  afterScoreChange();
  showToast(`已加：第 ${from}–${to} 小节是第 ${num} 遍才唱的房子。`);
}

/** 刷新反复记号说明。 */
function updateRepeatInfo() {
  if (!els.repeatInfo) return;
  const marks = (currentScore() && currentScore().repeats) || [];
  if (!marks.length) {
    els.repeatInfo.textContent = "还没有反复记号。先点「↺ 起点」再点「↻ 终点」，中间那段就会反复。";
    return;
  }
  const parts = marks.map((mark) => mark.type === "repeat-start"
    ? `第 ${mark.bar} 小节反复起点`
    : `第 ${mark.bar} 小节终点（共 ${mark.times} 遍）`);
  els.repeatInfo.textContent = parts.join(" · ");
}

/**
 * 按反复记号展开播放顺序。
 *
 * 反复记号改变的是「演唱/放映的顺序」而不是音符本身，所以这里把
 * 「按小节顺序」的音符按 expandPlaybackOrder 的结果重新连起来。
 */
function expandForRepeats(notes) {
  const score = currentScore();
  const marks = (score && score.repeats) || [];
  if (!marks.length) return notes;
  const view = state.scoreView;
  if (!view) return notes;
  const per = view.beatsPerMeasure;
  const totalMeasures = Math.max(1, Math.ceil(v2TotalBeats(score) / per));
  const order = expandPlaybackOrder(totalMeasures, marks);
  const base = [...notes].sort((left, right) => left.startBeat - right.startBeat);
  // 第一遍的时长（不含反复前的引子）
  const firstPassBeats = totalMeasures * per;
  const intro = base.filter((note) => note.startBeat < order.indexOf(1) >= 0 ? false : note.startBeat < (Math.min(...marks.map((mark) => mark.bar)) - 1) * per);
  const repeatFrom = (Math.min(...marks.map((mark) => mark.bar)) - 1) * per;
  const head = base.filter((note) => note.startBeat < repeatFrom - 1e-6);
  const sectionNotes = base.filter((note) => note.startBeat >= repeatFrom - 1e-6
    && note.startBeat < firstPassBeats - 1e-6);
  const orderStart = Math.min(...marks.map((mark) => mark.bar));
  const cycleCount = order.filter((bar) => bar === orderStart).length;
  const out = [...head];
  let cursor = repeatFrom;
  for (let cycle = 0; cycle < Math.max(1, cycleCount); cycle += 1) {
    for (const note of sectionNotes) {
      out.push({ ...note, startBeat: note.startBeat - repeatFrom + cursor });
    }
    cursor += (firstPassBeats - repeatFrom);
  }
  return out.sort((left, right) => left.startBeat - right.startBeat);
}

/**
 * 加一处「中途变速」：从第 N 小节起速度改成 X BPM。
 * v2 模型里是 tempoChanges: [{beat, bpm}]，导出 MusicXML 会写成 <sound tempo>。
 */
function addTempoChange() {
  const score = currentScore();
  if (!score) return;
  const measureNumber = Math.max(1, Math.round(Number(els.tempoBeat.value) || 1));
  const bpm = Math.min(320, Math.max(20, Math.round(Number(els.tempoBpm.value) || 90)));
  const beat = Math.round(v2BeatsPerMeasure(score) * (measureNumber - 1) * 1e6) / 1e6;
  pushHistory();
  score.tempoChanges = (score.tempoChanges || []).filter((item) => Math.abs(item.beat - beat) > 1e-6);
  score.tempoChanges.push({ beat, bpm });
  score.tempoChanges.sort((left, right) => left.beat - right.beat);
  if (measureNumber === 1) score.tempo = bpm;
  afterScoreChange();
  showToast(`已记下：第 ${measureNumber} 小节起改成 ${bpm} BPM（共 ${score.tempoChanges.length} 处）。`);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName() {
  return (state.score.title || "未命名乐谱").replace(/[\\/:*?"<>|]/g, "_");
}

/** 把当前五线谱导出成 PNG 图片（打印 / 发给人看）。 */
async function exportPng() {
  if (!hasAnyNote()) {
    showToast("还没有音符，先写几个音再导出。");
    return;
  }
  const svg = els.scoreEditor.querySelector("svg");
  if (!svg) {
    showToast("五线谱还没画出来，稍等一下再试。");
    return;
  }
  try {
    const cloned = svg.cloneNode(true);
    cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    // 黑字白底：屏幕上是浅色系，打印出来要清楚
    cloned.querySelectorAll("path, rect, text").forEach((node) => {
      if (node.getAttribute("fill") === "transparent") return;
      if (!node.getAttribute("fill") || node.getAttribute("fill") === "black") node.setAttribute("fill", "#111");
      if (node.getAttribute("stroke") === "black") node.setAttribute("stroke", "#111");
    });
    const svgText = new XMLSerializer().serializeToString(cloned);
    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    const scale = 2;   // 2 倍分辨率，打印/放大都清楚
    const width = Math.max(600, image.width || svg.clientWidth || 760);
    const height = Math.max(200, image.height || svg.clientHeight || 400);
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!pngBlob) throw new Error("图片生成失败");
    download(pngBlob, `${safeName()}.png`);
    showToast("图片已下载（2 倍分辨率，可直接打印）。");
  } catch {
    showToast("图片导出失败，可以改用「MusicXML」在制谱软件里打印。");
  }
}

function exportMusicXml() {
  // v2 → MusicXML 精确互转（音符/拍位/时值/调号/拍号/速度全部保留）
  const xml = v2ToMusicXml(state.score);
  download(new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" }), `${safeName()}.musicxml`);
  showToast("MusicXML 已下载，可用 MuseScore、Finale 等继续编辑或打印。");
}


function exportMidi() {
  if (!hasAnyNote()) {
    showToast("还没有音符，先写几个音再导出。");
    return;
  }
  // scoreToMidi 是 v1 API：给它 v1 视图（v2 → v1 已保证拍位/时值/和弦一致）
  const midi = scoreToMidi(state.scoreView);
  download(new Blob([midi], { type: "audio/midi" }), `${safeName()}.mid`);
  showToast("MIDI 已下载。");
}

function exportProject() {
  // 存 v2（多声部/绝对拍位/记号都在）；加载时自动识别新旧格式
  const payload = JSON.stringify({
    version: 2,
    score: state.score,
    saved: new Date().toISOString(),
  }, null, 1);
  download(new Blob([payload], { type: "application/json" }), `${safeName()}.pujian.json`);
  showToast("工程文件已下载，下次「导入工程」可以继续改。");
}

async function importProject(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const score = parsed && parsed.score ? parsed.score : parsed;
    if (!score || !Array.isArray(score.parts)) throw new Error("格式不对");
    pushHistory();
    state.score = score;
    state.activePartId = score.parts[0].id;
    syncSettingsInputs();
    afterScoreChange();
    showToast("工程已导入。");
  } catch {
    showToast("这个文件不是谱见的工程文件。");
  }
}

/**
 * 导入一份现成的乐谱（MusicXML / MXL）到创作室。
 *
 * 为什么需要：用户反馈「拿真实谱子复刻不出来」——创作室原来只能从空白开始一个音一个音点，
 * 真实乐谱（和弦、多声部、休止）根本进不来。这里把识别/MusicXML 解析出来的音符
 * 转成创作室的数据结构（空隙补休止、和弦保留、跨小节拆段），导入后可以直接改。
 */
/**
 * 导入一份现成的乐谱：**PDF 或 MusicXML / MXL**。
 *
 * PDF 会先在浏览器里逐页渲染成高清图，交给本机识别引擎换成 MusicXML，
 * 再走同一条 v2 精确导入路径——所以「PDF → 可编辑乐谱」一步到位。
 */
async function importMusicXmlFile(file) {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  try {
    if (isPdf) {
      await importPdfFile(file);
      return;
    }
    const source = /\.mxl$/i.test(file.name) ? await readMxlZip(file) : await file.text();
    let score;
    try {
      score = musicXmlToV2(source).score;
    } catch (error) {
      showToast("这份乐谱读不进来：" + ((error && error.message) || "格式不支持"));
      return;
    }
    const notes = v2PlayableNotes(score);
    if (!notes.length) {
      showToast("这份乐谱里没有读到音符。");
      return;
    }
    pushHistory();
    state.score = score;
    state.activeRef = { ...DEFAULT_REF };
    syncSettingsInputs();
    afterScoreChange();
    showToast(describeImport(score, notes.length));
  } catch (error) {
    console.info("导入乐谱失败", error);
    showToast("这份乐谱读不进来：" + ((error && error.message) || "格式不支持"));
  }
}

/** PDF 导入：渲染 → 识别 → 合并成一份乐谱。 */
async function importPdfFile(file) {
  const label = document.querySelector("#importPdfLabel");
  setImportBusy(true, "准备识别…");
  try {
    const result = await recognizePdfToMusicXml({
      file,
      onProgress: ({ label: text }) => setImportBusy(true, text),
    });
    const xmlPages = result.pages.filter((item) => item.musicxml);
    if (!xmlPages.length) {
      showToast(`识别没读到音符（共 ${result.pageCount} 页）。可能是扫描太淡，或这些页是简谱——简谱请到工作台用「按简谱识别」。`);
      return;
    }
    // 多页合并：第一页的骨架 + 后面页的小节接上
    const merged = mergePdfPages(xmlPages);
    if (!merged) {
      showToast("识别结果拼不起来，请先用工作台逐页识别。");
      return;
    }
    pushHistory();
    state.score = merged.score;
    state.activeRef = { ...DEFAULT_REF };
    syncSettingsInputs();
    afterScoreChange();
    showToast(`已从 PDF 识别并打开：${xmlPages.length} / ${result.pageCount} 页，${describeImport(merged.score, v2PlayableNotes(merged.score).length)}`);
  } catch (error) {
    console.info("PDF 导入失败", error);
    showToast("PDF 识别失败：" + ((error && error.message) || "未知错误"));
  } finally {
    setImportBusy(false, "");
  }
}

/** 把多页 MusicXML 合并成一份：以第 1 页为骨架，后续页追加小节。 */
/**
 * 把多页 PDF 的 MusicXML 合并成一份乐谱。
 *
 * 关键点：每一页都是**同一个作品的不同页**，所以对应 part/谱表/声部线必须接在
 * 原来的那条线上，而不是每页各新建一套（否则 3 页就会变成 6 行谱表，排布全乱）。
 * 做法：以第 1 页为骨架，后续页按 (partIndex, staffIndex, voiceIndex) 接上，
 * 拍位整体平移到上一页结束之后。
 */
function mergePdfPages(xmlPages) {
  let base = null;
  for (const item of xmlPages) {
    let parsed;
    try {
      parsed = musicXmlToV2(item.musicxml);
    } catch {
      continue;
    }
    const pageScore = parsed && parsed.score ? parsed.score : parsed;
    if (!pageScore || !pageScore.parts) continue;
    if (!base) {
      base = { score: pageScore, endBeat: 0 };
      base.endBeat = scoreEndBeat(pageScore);
      continue;
    }
    const per = beatsPerMeasureOf(base.score);
    // 下一页从「上一页结束处之后对齐到小节线」开始
    const offset = Math.ceil((base.endBeat - 1e-6) / per) * per;
    for (const [partIndex, part] of pageScore.parts.entries()) {
      const targetPart = base.score.parts[partIndex];
      if (!targetPart) continue;   // 页数多的部分（例如某页只有 2 个 part）不强行新建
      for (const [staffIndex, staff] of part.staves.entries()) {
        const targetStaff = targetPart.staves[staffIndex];
        if (!targetStaff) continue;
        for (const [voiceIndex, voice] of staff.voices.entries()) {
          const targetVoice = targetStaff.voices[voiceIndex];
          if (!targetVoice) continue;
          const anchorMap = new Map();
          for (const event of voice.events || []) {
            const moved = {
              ...event,
              id: `${event.id}-p${item.page}`,
              beat: event.beat + offset,
            };
            // 和弦音要指向新 id 的锚音
            if (event.chordWith && anchorMap.has(event.chordWith)) {
              moved.chordWith = anchorMap.get(event.chordWith);
            }
            if (!event.chordWith) anchorMap.set(event.id, moved.id);
            targetVoice.events.push(moved);
          }
        }
      }
    }
    base.endBeat = Math.max(base.endBeat, scoreEndBeat(pageScore) + offset);
  }
  if (!base) return null;
  return { score: base.score };
}

/** 一份 v2 乐谱最后一个音的结束拍位。 */
function scoreEndBeat(score) {
  let end = 0;
  for (const part of score.parts || []) {
    for (const staff of part.staves || []) {
      for (const voice of staff.voices || []) {
        for (const event of voice.events || []) {
          end = Math.max(end, (Number(event.beat) || 0) + (Number(event.beats) || 0));
        }
      }
    }
  }
  return end;
}

/** 每小节拍数（按拍号换算成四分音符单位）。 */
function beatsPerMeasureOf(score) {
  const time = (score && score.timeSignature) || { beats: 4, beatType: 4 };
  const per = (Number(time.beats) || 4) * 4 / (Number(time.beatType) || 4);
  return per > 0 ? per : 4;
}

/** 生成一句「导入了什么」的说明。 */
function describeImport(score, noteCount) {
  const voices = score.parts.reduce((sum, part) => sum
    + (part.staves || []).reduce((inner, staff) => inner + (staff.voices || []).length, 0), 0);
  const staves = score.parts.reduce((sum, part) => sum + (part.staves || []).length, 0);
  const chords = score.parts.reduce((sum, part) => sum
    + (part.staves || []).reduce((inner, staff) => inner
      + (staff.voices || []).reduce((deep, voice) => deep
        + (voice.events || []).filter((event) => event.chordWith).length, 0), 0), 0);
  const details = [];
  if (voices > 1) details.push(`${voices} 条声部线`);
  if (staves > 1) details.push(`${staves} 行谱表`);
  if (chords) details.push(`${chords} 处和弦`);
  return `${noteCount} 个音${details.length ? `（${details.join("、")}）` : ""}，可直接改也可导出`;
}

/** 导入进行中的界面状态。 */
function setImportBusy(busy, text) {
  const button = document.querySelector("#importMusicXml");
  if (button) button.disabled = busy;
  const label = document.querySelector("#importPdfLabel");
  if (label) label.textContent = busy ? (text || "正在识别…") : "↑ 导入 PDF / 乐谱";
}


async function readMxlZip(file) {
  const { readMusicXmlFile } = await import("./musicxml.js");
  return readMusicXmlFile(file);
}

function syncSettingsInputs() {
  const score = currentScore();
  if (!score) return;
  els.scoreTitle.value = score.title || "未命名乐谱";
  els.scoreTempo.value = String(score.tempo || 84);
  const time = score.timeSignature || { beats: 4, beatType: 4 };
  if (els.scoreTime) els.scoreTime.value = `${time.beats}/${time.beatType}`;
  els.scoreKey.value = String(score.keyFifths || 0);
  const ref = v2ClampVoiceRef(score, state.activeRef);
  const part = (score.parts || [])[ref.partIndex];
  const staff = part && (part.staves || [])[ref.staffIndex];
  if (staff && els.scoreClef) els.scoreClef.value = staff.clef || "treble";
  syncPartSelect();
}

/** 把设置项的改动写回 v2。 */
function applySettings() {
  const score = currentScore();
  if (!score) return;
  const timeMatch = /^(\d+)\s*\/\s*(\d+)$/.exec(els.scoreTime.value || "4/4");
  score.title = els.scoreTitle.value.trim() || "未命名乐谱";
  score.tempo = Math.min(320, Math.max(20, Number(els.scoreTempo.value) || 84));
  if (timeMatch) {
    score.timeSignature = {
      beats: Math.min(16, Math.max(1, Number(timeMatch[1]))),
      beatType: Math.min(16, Math.max(1, Number(timeMatch[2]))),
    };
  }
  score.keyFifths = Math.min(7, Math.max(-7, Number(els.scoreKey.value) || 0));
  const ref = v2ClampVoiceRef(score, state.activeRef);
  const part = (score.parts || [])[ref.partIndex];
  if (part && part.staves && part.staves[ref.staffIndex]) {
    part.staves[ref.staffIndex].clef = els.scoreClef.value || "treble";
  }
  afterScoreChange();
}


/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  els.addNote.addEventListener("click", addCurrentNote);
  // 折叠区外的试听快捷按钮（不折叠，随时点得到）
  const playAllQuick = document.querySelector("#playAllQuick");
  if (playAllQuick) playAllQuick.addEventListener("click", () => playRange(0, Infinity));
  const stopQuick = document.querySelector("#stopQuick");
  if (stopQuick) stopQuick.addEventListener("click", () => stopPlayback());

  if (els.addTempoChange) els.addTempoChange.addEventListener("click", addTempoChange);
  if (els.addRepeatStart) els.addRepeatStart.addEventListener("click", () => addRepeatMark("start"));
  if (els.addRepeatEnd) els.addRepeatEnd.addEventListener("click", () => addRepeatMark("end"));
  if (els.addEnding) els.addEnding.addEventListener("click", addEnding);
  els.undo.addEventListener("click", undo);
  for (const [element, handler] of [
    [els.scoreTitle, () => applySettings()],
    [els.scoreTempo, () => applySettings()],
    [els.scoreTime, () => applySettings()],
    [els.scoreKey, () => applySettings()],
    [els.scoreClef, () => applySettings()],
  ]) {
    if (element) element.addEventListener("change", handler);
  }

  if (els.addVoice) els.addVoice.addEventListener("click", addVoiceLine);
  if (els.addStaff) els.addStaff.addEventListener("click", addStaffLine);
  if (els.chordToneButton) els.chordToneButton.addEventListener("click", addChordToneToSelection);
  if (els.staffSelector) els.staffSelector.addEventListener("change", () => {
    state.activeRef = { ...state.activeRef, staffIndex: Number(els.staffSelector.value) || 0, voiceIndex: 0 };
    refreshStaffVoiceSelectors();
    updateMeasureStatus();
  });
  if (els.voiceSelector) els.voiceSelector.addEventListener("change", () => {
    state.activeRef = { ...state.activeRef, voiceIndex: Number(els.voiceSelector.value) || 0 };
    refreshStaffVoiceSelectors();
    updateMeasureStatus();
  });
  els.redo.addEventListener("click", redo);

  els.pitchDown.addEventListener("click", () => { state.pitch = Math.max(0, state.pitch - 1); updatePitchReadout(); markActiveKey(); playPitch(activePart(), state.pitch, ensureAudio().currentTime + 0.01, 0.35); });
  els.pitchUp.addEventListener("click", () => { state.pitch = Math.min(127, state.pitch + 1); updatePitchReadout(); markActiveKey(); playPitch(activePart(), state.pitch, ensureAudio().currentTime + 0.01, 0.35); });
  els.pitchPlay.addEventListener("click", () => playPitch(activePart(), state.pitch, ensureAudio().currentTime + 0.01, 0.55));

  els.partSelect.addEventListener("change", () => {
    state.activePartId = els.partSelect.value;
    syncPartSelect();
    updateMeasureStatus();
  });

  els.addPart.addEventListener("click", () => {
    pushHistory();
    // v2：加一个「声部」（演奏单元），默认带一行谱表一条声部线
    const part = createV2Part({ name: `声部 ${state.score.parts.length + 1}` });
    state.score.parts.push(part);
    state.activeRef = { partIndex: state.score.parts.length - 1, staffIndex: 0, voiceIndex: 0 };
    afterScoreChange();
    showToast("新声部已加好，它会和别的声部一起演奏。");
  });

  els.renamePart.addEventListener("click", () => {
    const ref = state.activeRef;
    const part = (state.score.parts || [])[ref.partIndex];
    if (!part) return;
    const name = window.prompt("给这个声部起个名字", part.name);
    if (!name) return;
    pushHistory();
    part.name = name.trim().slice(0, 20);
    afterScoreChange();
  });

  els.removePart.addEventListener("click", () => {
    if (state.score.parts.length <= 1) return;
    const part = activePart();
    if (!part) return;
    if (!window.confirm(`确定删掉声部「${part.name}」吗？`)) return;
    pushHistory();
    state.score.parts = state.score.parts.filter((item) => item.id !== part.id);
    state.activePartId = state.score.parts[0].id;
    state.selection = null;
    afterScoreChange();
  });

  els.scoreTitle.addEventListener("input", () => applySettings());
  els.scoreTempo.addEventListener("input", () => applySettings());
  els.scoreKey.addEventListener("change", () => {
    pushHistory();
    const score = currentScore();
    if (score) score.keyFifths = Math.min(7, Math.max(-7, Number(els.scoreKey.value) || 0));
    afterScoreChange();
  });
  els.scoreClef.addEventListener("change", () => {
    const score = currentScore();
    if (!score) return;
    const ref = v2ClampVoiceRef(score, state.activeRef);
    const part = (score.parts || [])[ref.partIndex];
    if (part && part.staves && part.staves[ref.staffIndex]) {
      pushHistory();
      part.staves[ref.staffIndex].clef = els.scoreClef.value || "treble";
      afterScoreChange();
    }
  });
  els.scoreTimbre.addEventListener("change", async () => {
    const part = activePart();
    if (!part) return;
    pushHistory();
    part.timbre = els.scoreTimbre.value;
    await ensureSampleBank(part.timbre);
    showToast(`「${part.name}」的音色换成「${TIMBRE_LABELS[part.timbre] || part.timbre}」。`);
    playPitch(part, state.pitch, ensureAudio().currentTime + 0.01, 0.6);
  });

  els.playAll.addEventListener("click", () => playRange(0, Infinity));
  els.playFromHere.addEventListener("click", () => {
    const range = selectionBeats();
    playRange(range ? range.from : 0, Infinity);
  });
  els.playSelection.addEventListener("click", () => {
    const range = selectionBeats();
    if (!range) {
      showToast("先在乐谱上点一个音（按住 Shift 点第二个音可选一段）。");
      return;
    }
    playRange(range.from, range.to);
  });
  els.stopPlay.addEventListener("click", () => stopPlayback());

  els.exportMusicXml.addEventListener("click", exportMusicXml);
  els.exportMidi.addEventListener("click", exportMidi);
  els.exportPng.addEventListener("click", exportPng);
  els.exportProject.addEventListener("click", exportProject);
  els.importProject.addEventListener("click", () => els.projectInput.click());
if (els.importMusicXml) els.importMusicXml.addEventListener("click", () => els.musicXmlInput.click());
if (els.musicXmlInput) els.musicXmlInput.addEventListener("change", async () => {
  const file = els.musicXmlInput.files && els.musicXmlInput.files[0];
  els.musicXmlInput.value = "";
  if (file) await importMusicXmlFile(file);
});
  els.projectInput.addEventListener("change", () => {
    const file = els.projectInput.files && els.projectInput.files[0];
    if (file) importProject(file);
    els.projectInput.value = "";
  });

  document.addEventListener("keydown", (event) => {
    const tag = (event.target && event.target.tagName) || "";
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
    if (event.key === "ArrowUp") { event.preventDefault(); els.pitchUp.click(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); els.pitchDown.click(); }
    else if (event.key === "Enter") { event.preventDefault(); addCurrentNote(); }
    else if (event.key === "Delete" || event.key === "Backspace") {
      const range = selectionBeats();
      if (range) { event.preventDefault(); applySelection((note) => removeNote(activePart(), note.id), "已删掉这个音。"); }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    } else if (event.code === "Space") {
      event.preventDefault();
      if (state.isPlaying) stopPlayback(); else playRange(0, Infinity);
    } else if (event.key === "Escape") {
      stopPlayback();
    }
  });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  // v2 模型：多声部 + 绝对拍位（同一小节可并行多条声部线）
  state.score = createV2Score({ title: "未命名乐谱", tempo: 84 });
  state.activeRef = { ...DEFAULT_REF };
  syncScoreView();
  buildKeyboard();
  buildValueChips();
  buildTimbreOptions();
  syncSettingsInputs();
  updatePitchReadout();
  bindEvents();
  syncHistoryButtons();
  afterScoreChange();
  try {
    state.sampleManifest = await fetchSampleManifest();
    buildTimbreOptions();
    const part = activePart();
    if (part) els.scoreTimbre.value = part.timbre;
    const installed = Object.keys(state.sampleManifest.banks || {}).length;
    els.exportHint.textContent = installed
      ? `本机已装 ${installed} 种采样音源（民乐、管弦、打击…都可以直接用）。导出的 MusicXML 每小节都补齐了拍数。`
      : "还没装采样音源，先用的是内置合成音色；想要二胡、古筝、真实钢琴等音色，双击「安装真实音源.bat」。";
  } catch {
    // 没装音源不影响创作
  }
  window.__pujianComposer = { state, renderScore, playRange, addCurrentNote };
}

boot();
