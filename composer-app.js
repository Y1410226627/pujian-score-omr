// 创作室页面逻辑：把「选音高 + 选拍数」变成五线谱，并随时试听、导出。
//
// 设计原则（对着零基础用户）：
//   · 界面上不出现「二分音符 / 附点 / 谱号」这类术语作为必填项，全部给中文白话；
//   · 任何一次点击都立刻有反馈（声音 + 谱面变化 + 一句提示）；
//   · 写错了永远能撤销，删音就是点旁边的小 ×；
//   · 试听可以「从头」「从选中的音开始」「只听选中的一段」，避免听一大段找那一句。
import {
  NOTE_VALUES, REST_VALUES, midiToName, isBlackKey, isRest, createScore, createPart,
  appendNote, removeNote, setNoteBeats, transposeNote, buildMeasureSlots, remainingBeats,
  usedBeats, scoreToPlayableNotes, scoreTotalBeats, cloneScore, accidentalFor,
} from "./composer.js";
import { scoreToMusicXml, scoreToMidi, scoreToProjectJson } from "./composer-export.js";
import { scoreInfoToComposerScore } from "./composer-import.js";
import { valueGlyphSvg, beatsBarMarkup, beatsToHuman } from "./notation-glyphs.js";
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
  scoreTitle: byId("scoreTitle"), scoreTempo: byId("scoreTempo"), scoreBeats: byId("scoreBeats"),
  scoreKey: byId("scoreKey"), scoreClef: byId("scoreClef"), scoreTimbre: byId("scoreTimbre"),
  measureStatus: byId("measureStatus"),
  playAll: byId("playAll"), playFromHere: byId("playFromHere"), playSelection: byId("playSelection"),
  stopPlay: byId("stopPlay"), loopPlay: byId("loopPlay"), playbackState: byId("playbackState"),
  exportMusicXml: byId("exportMusicXml"), exportMidi: byId("exportMidi"),
  exportProject: byId("exportProject"), exportPng: byId("exportPng"), importProject: byId("importProject"),
  importMusicXml: byId("importMusicXml"), musicXmlInput: byId("musicXmlInput"),
  projectInput: byId("projectInput"), exportHint: byId("exportHint"),
  scoreEditor: byId("scoreEditor"), scoreEmpty: byId("scoreEmpty"), editToolbar: byId("editToolbar"),
  selectionInfo: byId("selectionInfo"), editActions: byId("editActions"),
  toast: byId("toast"),
};

const SOLFEGE = ["do", "di", "re", "ri", "mi", "fa", "fi", "sol", "si", "la", "li", "ti"];
const KEYBOARD_START = 48;   // C3
const KEYBOARD_END = 84;     // C6

const state = {
  score: createScore({ title: "未命名乐谱", tempo: 84, beatsPerMeasure: 4 }),
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

/* ---------------- 基础工具 ---------------- */
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}

function activePart() {
  return state.score.parts.find((part) => part.id === state.activePartId) || state.score.parts[0];
}

function pushHistory() {
  state.history.push(cloneScore(state.score));
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
  state.future.push(cloneScore(state.score));
  state.score = state.history.pop();
  // 撤销后当前声部可能已经不存在了，兜底切到第一个声部
  if (!state.score.parts.some((part) => part.id === state.activePartId)) {
    state.activePartId = state.score.parts[0] ? state.score.parts[0].id : null;
  }
  state.selection = null;
  syncSettingsInputs();
  afterScoreChange();
  syncHistoryButtons();
  showToast("已撤销。");
}

function redo() {
  if (!state.future.length) return;
  state.history.push(cloneScore(state.score));
  state.score = state.future.pop();
  if (!state.score.parts.some((part) => part.id === state.activePartId)) {
    state.activePartId = state.score.parts[0] ? state.score.parts[0].id : null;
  }
  state.selection = null;
  syncSettingsInputs();
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
  const notes = scoreToPlayableNotes(state.score).filter((note) => {
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
    const part = state.score.parts.find((item) => item.id === note.partId);
    playPitch(part || { timbre: "piano" }, note.midi, startAt + offset * secondsPerBeat, duration * secondsPerBeat);
  }
  const totalSeconds = (Math.min(beatTo, scoreTotalBeats(state.score)) - beatFrom) * secondsPerBeat;
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
function renderScore() {
  if (!VF) {
    els.scoreEditor.textContent = "五线谱渲染组件没加载成功（vendor/vexflow/vexflow.js）。";
    return;
  }
  const { Factory } = VF;
  const measureCount = Math.max(1, Math.ceil(scoreTotalBeats(state.score) / state.score.beatsPerMeasure));
  const width = Math.max(680, els.scoreEditor.clientWidth || 760);
  const staveWidth = width - 40;
  const partCount = state.score.parts.length;
  const staveHeight = 62;
  const systemHeight = staveHeight * partCount + 34;
  const height = Math.max(320, systemHeight * 4 + 40);

  els.scoreEditor.replaceChildren();
  const renderer = new VF.Renderer(els.scoreEditor, VF.Renderer.Backends.SVG);
  renderer.resize(width, height);
  const svg = renderer.getContext();
  // 热区要挂在真正的 <svg> 元素上（SVGContext 没有 getSVGElement）
  const svgElement = els.scoreEditor.querySelector("svg");

  const measuresPerLine = 2;
  state.score.parts.forEach((part, partIndex) => {
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
            const keyName = keySignatureName(state.score.keyFifths);
            if (keyName) stave.addKeySignature(keyName);
            stave.addTimeSignature(`${state.score.beatsPerMeasure}/4`);
          }
        }
        stave.setContext(svg).draw();

        const measure = part.measures[measureIndex] || { beats: [] };
        const { slots } = buildMeasureSlots(measure, state.score.beatsPerMeasure);
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
          notes.push(note);
        }
        const remaining = remainingBeats(measure, state.score.beatsPerMeasure);
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
          const voice = new VF.Voice({ num_beats: state.score.beatsPerMeasure, beat_value: 4 }).setMode(VF.Voice.Mode.SOFT);
          voice.addTickables(notes.filter((note) => note instanceof VF.StaveNote));
          // 临时升降号：按调号与同小节/前后音自动判断该标 # / b / n（VexFlow 5 的官方做法）
          try {
            VF.Accidental.applyAccidentals([voice], keySignatureName(state.score.keyFifths) || "C");
          } catch {
            // 算不出就退化成「只画音高」，不影响其它功能
          }
          const formatter = new VF.Formatter();
          formatter.joinVoices([voice]).format([voice], staveWidth / measuresPerLine - 30);
          voice.draw(svg, stave);
          for (const note of notes) {
            if (note instanceof VF.BarNote) note.setContext(svg).draw();
          }
          // 热区在 renderScore() 末尾统一绘制（见 drawNoteHitAreas）
        } catch {
          // 谱面渲染失败时不阻塞输入（数据模型本身是对的）
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
  const measureCount = Math.max(1, Math.ceil(scoreTotalBeats(state.score) / state.score.beatsPerMeasure));
  const measuresPerLine = 2;
  const width = Math.max(680, els.scoreEditor.clientWidth || 760);
  const staveWidth = width - 40;
  const staveHeight = 62;
  const systemHeight = staveHeight * state.score.parts.length + 34;
  let added = 0;
  state.score.parts.forEach((part, partIndex) => {
    const clef = part.clef === "bass" ? "bass" : "treble";
    for (let line = 0; line * measuresPerLine < measureCount; line += 1) {
      for (let slot = 0; slot < measuresPerLine; slot += 1) {
        const measureIndex = line * measuresPerLine + slot;
        if (measureIndex >= measureCount) continue;
        const x = 20 + slot * (staveWidth / measuresPerLine);
        const y = 20 + line * systemHeight + partIndex * staveHeight;
        const measure = part.measures[measureIndex] || { beats: [] };
        const { slots } = buildMeasureSlots(measure, state.score.beatsPerMeasure);
        const totalBeats = Math.max(1, state.score.beatsPerMeasure);
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
        const part = state.score.parts.find((item) => item.id === partId);
        if (part) {
          state.activePartId = part.id;
          els.partSelect.value = part.id;
        }
      }
      if (noteId) selectNoteById(noteId, event.shiftKey);
    });
  }
}

/* ---------------- 选中 / 编辑 ---------------- */
function selectNoteById(noteId, extend = false) {
  for (const part of state.score.parts) {
    for (let measureIndex = 0; measureIndex < part.measures.length; measureIndex += 1) {
      const note = part.measures[measureIndex].beats.find((item) => item.id === noteId);
      if (!note) continue;
      if (extend && state.selection && state.selection.partId === part.id) {
        state.selection = { partId: part.id, fromNote: state.selection.noteId || state.selection.fromNote, toNote: noteId };
      } else {
        state.selection = { partId: part.id, noteId, measureIndex };
      }
      state.activePartId = part.id;
      els.partSelect.value = part.id;
      updateSelectionBar();
      renderScore();
      playPitch(part, note.midi, ensureAudio().currentTime + 0.01, 0.35);
      return;
    }
  }
}

function selectionBeats() {
  if (!state.selection) return null;
  const part = state.score.parts.find((item) => item.id === state.selection.partId);
  if (!part) return null;
  const measureBeats = state.score.beatsPerMeasure;
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
  const part = state.score.parts.find((item) => item.id === state.selection.partId);
  const note = (part && part.measures[state.selection.measureIndex].beats.find((item) => item.id === state.selection.noteId)) || null;
  if (!note) {
    els.editToolbar.hidden = true;
    return;
  }
  els.editToolbar.hidden = false;
  els.selectionInfo.textContent = `已选中：第 ${state.selection.measureIndex + 1} 小节 · ${midiToName(note.midi)} · ${note.beats === 1 ? "1 拍" : `${note.beats} 拍`}`;
  els.editActions.replaceChildren();
  const actions = [
    ["↑ 高半音", () => applySelection((item) => transposeNote(part, item.id, 1))],
    ["↓ 低半音", () => applySelection((item) => transposeNote(part, item.id, -1))],
    ["更长（+半拍）", () => applySelection((item) => setNoteBeats(part, item.id, item.beats + 0.5, state.score.beatsPerMeasure))],
    ["更短（−半拍）", () => applySelection((item) => setNoteBeats(part, item.id, Math.max(0.25, item.beats - 0.5), state.score.beatsPerMeasure))],
    ["删除这个音", () => applySelection((item) => removeNote(part, item.id), "已删掉这个音。")],
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
  return state.score.parts.some((part) => part.measures.some((measure) => measure.beats.length > 0));
}

function afterScoreChange(rerender = true) {
  syncPartSelect();
  if (rerender) renderScore();
  else renderScore();
  updateSelectionBar();
  updateMeasureStatus();
  els.scoreEmpty.hidden = hasAnyNote();
}

function updateMeasureStatus() {
  const part = activePart();
  if (!part) return;
  const last = part.measures[part.measures.length - 1];
  const remaining = remainingBeats(last, state.score.beatsPerMeasure);
  const index = part.measures.length;
  els.measureStatus.textContent = remaining > 1e-9
    ? `第 ${index} 小节还差 ${remaining} 拍`
    : `第 ${index} 小节已满，下一个音会进第 ${index + 1} 小节`;
}

function syncPartSelect() {
  els.partSelect.replaceChildren();
  for (const part of state.score.parts) {
    const option = document.createElement("option");
    option.value = part.id;
    option.textContent = part.name;
    els.partSelect.append(option);
  }
  els.partSelect.value = state.activePartId;
  els.removePart.disabled = state.score.parts.length <= 1;
  const part = activePart();
  if (part) {
    els.scoreClef.value = part.clef;
    els.scoreTimbre.value = part.timbre;
  }
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
function addCurrentNote() {
  const part = activePart();
  if (!part) return;
  const used = usedBeats(part.measures[part.measures.length - 1] || { beats: [] });
  const measureFull = used >= state.score.beatsPerMeasure - 1e-9;
  pushHistory();
  const event = state.restMode
    ? { rest: true, beats: state.beats }
    : { midi: state.pitch, beats: state.beats };
  const placed = appendNote(part, event, state.score.beatsPerMeasure);
  state.selection = { partId: part.id, noteId: placed.note.id, measureIndex: placed.measureIndex };
  afterScoreChange();
  if (!state.restMode) {
    playPitch(part, state.pitch, ensureAudio().currentTime + 0.01, Math.max(0.25, state.beats * (60 / state.score.tempo)));
  }
  const what = state.restMode ? "一个休止符" : midiToName(state.pitch);
  showToast(measureFull ? `已加到第 ${placed.measureIndex + 1} 小节开头。` : `第 ${placed.measureIndex + 1} 小节加了${what}。`);
}

/* ---------------- 导出 ---------------- */
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
  if (!hasAnyNote()) {
    showToast("还没有音符，先写几个音再导出。");
    return;
  }
  const xml = scoreToMusicXml(state.score);
  download(new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" }), `${safeName()}.musicxml`);
  showToast("MusicXML 已下载，可用 MuseScore 等软件打开或打印。");
}

function exportMidi() {
  if (!hasAnyNote()) {
    showToast("还没有音符，先写几个音再导出。");
    return;
  }
  const midi = scoreToMidi(state.score);
  download(new Blob([midi], { type: "audio/midi" }), `${safeName()}.mid`);
  showToast("MIDI 已下载。");
}

function exportProject() {
  download(new Blob([scoreToProjectJson(state.score)], { type: "application/json" }), `${safeName()}.pujian.json`);
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
async function importMusicXmlFile(file) {
  try {
    const { parseMusicXmlText, readMusicXmlFile } = await import("./musicxml.js");
    // keepRests：创作室要保留休止符，才能还原原谱的停顿（工作台默认不保留，语义不变）
    const parseOptions = { keepRests: true };
    const scoreInfo = /\.mxl$/i.test(file.name)
      ? await readMusicXmlFile(file, parseOptions)
      : parseMusicXmlText(await file.text(), parseOptions);
    if (!scoreInfo || !scoreInfo.notes || !scoreInfo.notes.length) {
      showToast("这份乐谱里没有读到音符。");
      return;
    }
    const { score, stats } = scoreInfoToComposerScore(scoreInfo, {
      title: scoreInfo.title || file.name.replace(/\.[^.]+$/, ""),
    });
    if (!score.parts.length || !stats.notes) {
      showToast("这份乐谱里没有读到音符。");
      return;
    }
    pushHistory();
    state.score = score;
    state.activePartId = score.parts[0].id;
    syncSettingsInputs();
    afterScoreChange();
    // 如实报数：音符数按「谱面上印了几个音」算（跨小节的长音被拆成两段但仍是同一个音）。
    const details = [];
    if (stats.chordEntries) details.push(`${stats.chordEntries} 处和弦`);
    if (stats.tieSegments) details.push(`${stats.tieSegments} 处跨小节连音`);
    if (stats.parts > 1) details.push(`按 ${stats.parts} 条声部线拆开`);
    const lost = Math.max(0, (stats.sourceNotes || 0) - stats.notes);
    showToast(`已导入「${score.title}」：${stats.parts} 条声部线、${stats.notes} 个音` +
      `${details.length ? `（${details.join("、")}）` : ""}、${stats.measures} 小节` +
      (lost > 0 ? `。注意：原谱有 ${stats.sourceNotes} 个音，其中 ${lost} 个因多声部重叠无法自动排准，建议逐段核对` : "") +
      "。可以直接改，也可以导出。");
  } catch (error) {
    console.info("导入乐谱失败", error);
    showToast("这份乐谱读不进来：" + ((error && error.message) || "格式不支持"));
  }
}

function syncSettingsInputs() {
  els.scoreTitle.value = state.score.title;
  els.scoreTempo.value = state.score.tempo;
  els.scoreBeats.value = String(state.score.beatsPerMeasure);
  els.scoreKey.value = String(state.score.keyFifths);
  syncPartSelect();
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  els.addNote.addEventListener("click", addCurrentNote);
  els.undo.addEventListener("click", undo);
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
    const part = createPart({ name: `声部 ${state.score.parts.length + 1}` });
    state.score.parts.push(part);
    state.activePartId = part.id;
    afterScoreChange();
    showToast("新声部已加好，它会和别的声部一起演奏。");
  });

  els.renamePart.addEventListener("click", () => {
    const part = activePart();
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

  els.scoreTitle.addEventListener("input", () => { state.score.title = els.scoreTitle.value || "未命名乐谱"; });
  els.scoreTempo.addEventListener("input", () => {
    state.score.tempo = Math.max(20, Math.min(320, Number(els.scoreTempo.value) || 84));
  });
  els.scoreBeats.addEventListener("change", () => {
    pushHistory();
    state.score.beatsPerMeasure = Number(els.scoreBeats.value) || 4;
    afterScoreChange();
  });
  els.scoreKey.addEventListener("change", () => {
    pushHistory();
    state.score.keyFifths = Number(els.scoreKey.value) || 0;
    afterScoreChange();
  });
  els.scoreClef.addEventListener("change", () => {
    const part = activePart();
    if (!part) return;
    pushHistory();
    part.clef = els.scoreClef.value;
    afterScoreChange();
  });
  els.scoreTimbre.addEventListener("change", async () => {
    const part = activePart();
    if (!part) return;
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
  state.activePartId = state.score.parts[0].id;
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
