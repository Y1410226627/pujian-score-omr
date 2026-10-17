import { parseMusicXmlText, readMusicXmlFile } from "./musicxml.js";
import {
  binarize, detectStaves, groupSystems, staffCropBox,
  mergeSystemScores, transposeNotes, yForPitch, CLEF_BY_SIGN,
} from "./staff.js";

const byId = (id) => document.getElementById(id);
const els = {
  fileInput: byId("fileInput"), dropzone: byId("dropzone"), currentFile: byId("currentFile"),
  fileName: byId("fileName"), fileInfo: byId("fileInfo"), removeFile: byId("removeFile"),
  recognizeButton: byId("recognizeButton"), recognizeLabel: byId("recognizeLabel"), clefSelect: byId("clefSelect"),
  engineHint: byId("engineHint"),
  staffSelectField: byId("staffSelectField"), staffSelect: byId("staffSelect"),
  emptyState: byId("emptyState"), canvasWrap: byId("canvasWrap"), scoreCanvas: byId("scoreCanvas"),
  overlayCanvas: byId("overlayCanvas"), pageControls: byId("pageControls"), pageLabel: byId("pageLabel"),
  prevPage: byId("prevPage"), nextPage: byId("nextPage"), processingOverlay: byId("processingOverlay"),
  scoreHint: byId("scoreHint"), scoreInfo: byId("scoreInfo"), scoreTitle: byId("scoreTitle"),
  scoreDetails: byId("scoreDetails"), scoreWarnings: byId("scoreWarnings"), noteCount: byId("noteCount"), noteList: byId("noteList"),
  voiceFilterField: byId("voiceFilterField"), voiceFilter: byId("voiceFilter"),
  notesEmpty: byId("notesEmpty"), addNoteButton: byId("addNoteButton"), midiButton: byId("midiButton"), playButton: byId("playButton"),
  playIcon: byId("playIcon"), playLabel: byId("playLabel"), stopButton: byId("stopButton"),
  tempoInput: byId("tempoInput"), toast: byId("toast"), chooseFileButton: byId("chooseFileButton"),
  recognitionBanner: byId("recognitionBanner"), recognitionSource: byId("recognitionSource"), recognitionDetail: byId("recognitionDetail"),
  lowConfidenceButton: byId("lowConfidenceButton"),
  selectionBar: byId("selectionBar"), selectionLabel: byId("selectionLabel"),
  loopToggle: byId("loopToggle"), clearSelection: byId("clearSelection"), scoreLegend: byId("scoreLegend"),
  recognizeProgress: byId("recognizeProgress"), recognizeProgressBar: byId("recognizeProgressBar"),
  recognizeProgressLabel: byId("recognizeProgressLabel"), cancelRecognize: byId("cancelRecognize"),
  transposeInput: byId("transposeInput"), resetTranspose: byId("resetTranspose"),
};
const state = {
  file: null, objectUrl: null, pdf: null, pageNumber: 1, pageCount: 1, notes: [], scoreInfo: null,
  recognized: false, isPlaying: false, audio: null, sources: new Set(), timers: [], toastTimer: null,
  // 令牌机制：文件加载 / 识别 / PDF 渲染各自带序号，只有最后一次发起的操作才允许改界面，
  // 避免"识别中切换文件""连点翻页"这类竞态把旧结果写回界面。
  loadToken: 0, recognizeToken: 0, renderToken: 0, isRecognizing: false,
  // 识别来源：engine=本机专业引擎 / estimate=浏览器粗略估算 / musicxml=直接导入的结构化乐谱
  recognitionSource: null,
  selection: null, loop: false, onlyLowConfidence: false,
  // 逐谱表识别相关：谱表几何、进度、取消标志、整体移调量
  staffBoxes: null, recognizeProgress: { done: 0, total: 0 }, cancelRecognize: false, transposeOffset: 0,
};
// 粗略估算得到的符头置信分低于此值即标为"待校对"
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const durations = [
  ["breve", "倍全音符", 8], ["dottedWhole", "附点全音符", 6], ["whole", "全音符", 4],
  ["doubleDottedHalf", "双附点二分音符", 3.5], ["dottedHalf", "附点二分音符", 3], ["half", "二分音符", 2],
  ["doubleDottedQuarter", "双附点四分音符", 1.75], ["dottedQuarter", "附点四分音符", 1.5], ["quarter", "四分音符", 1],
  ["quarterTriplet", "四分三连音", 2 / 3], ["dottedEighth", "附点八分音符", 0.75], ["eighth", "八分音符", 0.5],
  ["eighthTriplet", "八分三连音", 1 / 3], ["dottedSixteenth", "附点十六分音符", 0.375], ["sixteenth", "十六分音符", 0.25],
  ["sixteenthTriplet", "十六分三连音", 1 / 6], ["thirtySecond", "三十二分音符", 0.125],
  ["sixtyFourth", "六十四分音符", 0.0625], ["oneTwentyEighth", "一百二十八分音符", 0.03125],
];
const durationBeats = Object.fromEntries(durations.map((entry) => [entry[0], entry[2]]));
const durationFromBeats = (beats) => durations.find((entry) => Math.abs(entry[2] - beats) < 0.00001)?.[0] || "custom";
const beatsForNote = (note) => Number.isFinite(note.durationBeats) ? note.durationBeats : (durationBeats[note.duration] || 1);
const voiceIdentity = (note) => JSON.stringify([note.partId || note.partName || "旋律", note.staff || "1", note.voice || "1"]);

function makeId() {
  return window.crypto && typeof window.crypto.randomUUID === "function"
    ? window.crypto.randomUUID()
    : "note-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}
function formatSize(bytes) {
  return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
}
// 本机是否装有专业识别引擎。null 表示尚未探测成功（例如直接用 file:// 打开页面）。
// audiveris：整页识别（能保留多声部结构）；homr：单谱表裁片识别（逐行流程用）。
let audiverisAvailable = null;
let homrAvailable = null;
function idleRecognizeLabel() {
  if (audiverisAvailable === false && homrAvailable === false) return "估算识别";
  if (state.recognized) return "重新识别";
  return "识别乐谱";
}
function updateEngineHint() {
  if (!els.engineHint) return;
  if (audiverisAvailable === true) {
    els.engineHint.textContent = "已检测到 Audiveris 整页识别引擎（可保留多声部结构）；识别结果仍建议逐音校对后再使用。";
  } else if (homrAvailable === true) {
    els.engineHint.textContent = "已检测到 homr 逐谱表识别引擎；识别结果仍建议逐音校对后再使用。";
  } else if (audiverisAvailable === false && homrAvailable === false) {
    els.engineHint.textContent = "未检测到本机专业识别引擎：图片只会做粗略估算，结果可能明显不准，请务必逐音校对。";
  }
}
async function refreshEngineStatus() {
  try {
    const response = await fetch("/api/omr/status");
    const payload = await response.json();
    audiverisAvailable = Boolean(payload.audiverisAvailable);
    homrAvailable = Boolean(payload.homrAvailable);
  } catch {
    audiverisAvailable = null;
    homrAvailable = null;
  }
  updateEngineHint();
  if (state.file && !state.isRecognizing && !/\.(musicxml|xml|mxl)$/i.test(state.file.name)) {
    els.recognizeLabel.textContent = idleRecognizeLabel();
  }
}
function clearOverlay() {
  els.overlayCanvas.getContext("2d").clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
}
function clearScore() {
  state.notes = [];
  state.recognized = false;
  state.scoreInfo = null;
  state.recognitionSource = null;
  state.selection = null;
  state.onlyLowConfidence = false;
  state.staffBoxes = null;
  state.transposeOffset = 0;
  if (els.transposeInput) els.transposeInput.value = "0";
  if (els.recognizeProgress) els.recognizeProgress.hidden = true;
  els.scoreInfo.hidden = true;
  updateVoiceOptions(true);
  els.staffSelect.replaceChildren();
  els.staffSelectField.hidden = true;
  renderNotes();
  clearOverlay();
  updateRecognitionBanner();
  els.scoreHint.textContent = "导入文件后开始";
}
async function destroyPdf() {
  const previous = state.pdf;
  state.pdf = null;
  if (!previous) return;
  try {
    await previous.destroy();
  } catch (error) {
    console.info("PDF 文档释放时出错（通常可忽略）。", error);
  }
}
// 只有"粗略估算"出来的音符才带置信分；专业引擎与 MusicXML 导入没有逐音置信度。
const isLowConfidence = (note) => Number.isFinite(note.confidence) && note.confidence < LOW_CONFIDENCE_THRESHOLD;
const hasLowConfidenceNotes = () => state.notes.some(isLowConfidence);
// Audiveris 给各声部的默认名字都是 "Voice"，界面里无法区分；按 part 去重编号。
function dedupePartNames(notes) {
  const partNames = new Map(); // partId -> partName（每个 part 只取第一个音符的名字）
  for (const note of notes) {
    if (note.partId && !partNames.has(note.partId)) partNames.set(note.partId, note.partName || "");
  }
  const nameCounts = new Map();
  for (const name of partNames.values()) {
    if (!name) continue;
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const used = new Map();
  const renamed = new Map(); // partId -> 新名字
  for (const [partId, name] of partNames) {
    if (!name || (nameCounts.get(name) || 0) < 2) continue;
    const index = (used.get(name) || 0) + 1;
    used.set(name, index);
    renamed.set(partId, `${name} ${index}`);
  }
  if (!renamed.size) return;
  for (const note of notes) {
    if (note.partId && renamed.has(note.partId)) note.partName = renamed.get(note.partId);
  }
}
function updateRecognitionBanner() {
  const banner = els.recognitionBanner;
  if (!banner) return;
  if (!state.recognitionSource || !state.notes.length) {
    banner.hidden = true;
    return;
  }
  const lowCount = state.notes.filter(isLowConfidence).length;
  if (state.recognitionSource === "engine") {
    banner.className = "recognition-banner is-engine";
    els.recognitionSource.textContent = "本机专业识别引擎";
    els.recognitionDetail.textContent = `${state.notes.length} 个音符，已生成节奏与声部 · 结果仍需逐音校对`;
  } else if (state.recognitionSource === "mixed") {
    banner.className = "recognition-banner is-mixed";
    els.recognitionSource.textContent = "专业引擎 + 部分粗略估算";
    els.recognitionDetail.textContent = `${state.notes.length} 个音符 · 本机引擎整体可用，但有几行谱表未能识别，请优先校对来自估算的部分`;
  } else if (state.recognitionSource === "musicxml") {
    banner.className = "recognition-banner is-file";
    els.recognitionSource.textContent = "来自文件的结构化乐谱";
    els.recognitionDetail.textContent = `${state.notes.length} 个音符 · 音高与时值直接读取自 MusicXML，未经过图像识别`;
  } else {
    banner.className = "recognition-banner is-estimate";
    els.recognitionSource.textContent = "粗略估算 · 未经专业识别";
    els.recognitionDetail.textContent = lowCount
      ? `${state.notes.length} 个音符，其中 ${lowCount} 个置信度偏低 · 请逐音校对后再使用`
      : `${state.notes.length} 个音符 · 估算结果仅供参考，请逐音校对后再使用`;
  }
  banner.hidden = false;
}
function setCanvasSize(width, height) {
  els.scoreCanvas.width = width;
  els.scoreCanvas.height = height;
  els.overlayCanvas.width = width;
  els.overlayCanvas.height = height;
  els.emptyState.hidden = true;
  els.canvasWrap.hidden = false;
  clearOverlay();
}
async function loadFile(file) {
  if (!file) return;
  const lowerName = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lowerName.endsWith(".pdf");
  const isMusicXml = /\.(musicxml|xml|mxl)$/i.test(lowerName);
  const isImage = Boolean(file.type?.startsWith("image/")) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name);
  if (!isPdf && !isImage && !isMusicXml) return showToast("请选择 PDF、图片或 MusicXML 乐谱文件。");
  stopPlayback();
  await destroyPdf();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  const token = ++state.loadToken;
  state.file = file;
  // PDF 交给 pdf.js 直接读 ArrayBuffer，MusicXML 在浏览器内解析，两者都不需要 blob URL。
  state.objectUrl = (isPdf || isMusicXml) ? null : URL.createObjectURL(file);
  state.pageNumber = 1;
  state.pageCount = 1;
  clearScore();
  els.clefSelect.disabled = isMusicXml;
  els.fileName.textContent = file.name;
  els.fileInfo.textContent = (isMusicXml ? "MusicXML 乐谱" : isPdf ? "PDF 文档" : "图片文件") + " · " + formatSize(file.size);
  els.currentFile.hidden = false;
  els.recognizeButton.disabled = true;
  els.recognizeLabel.textContent = "正在载入…";
  els.pageControls.hidden = true;
  els.scoreHint.textContent = "正在载入谱面";
  try {
    if (isMusicXml) {
      const scoreInfo = await readMusicXmlFile(file);
      if (token !== state.loadToken) return;
      for (const note of scoreInfo.notes) note.duration = durationFromBeats(note.durationBeats);
      state.scoreInfo = scoreInfo;
      state.notes = scoreInfo.notes;
      state.recognitionSource = scoreInfo.notes.length ? "musicxml" : null;
      updateVoiceOptions(true);
      state.recognized = false;
      state.pageCount = 1;
      els.canvasWrap.hidden = true;
      els.emptyState.hidden = true;
      els.scoreInfo.hidden = false;
      els.staffSelectField.hidden = true;
      els.scoreTitle.textContent = scoreInfo.title;
      els.scoreDetails.textContent = `${scoreInfo.notes.length} 个音符 · ${scoreInfo.partNames.length} 个声部 · ${scoreInfo.measureCount} 小节 · ${scoreInfo.timeSummary} · ${scoreInfo.keySummary}`;
      els.scoreWarnings.textContent = scoreInfo.warnings.join(" ");
      els.scoreWarnings.hidden = scoreInfo.warnings.length === 0;
      els.tempoInput.value = Math.min(320, Math.max(20, Math.round(scoreInfo.tempo)));
      renderNotes();
      updateRecognitionBanner();
      els.recognizeButton.disabled = true;
      els.recognizeLabel.textContent = "已载入符号乐谱";
      els.pageControls.hidden = true;
      els.scoreHint.textContent = scoreInfo.notes.length
        ? "已从 MusicXML 读取音高、声部、休止与节奏位置"
        : "这份乐谱没有可演奏的带音高音符";
      showToast(scoreInfo.notes.length
        ? `已读取 ${scoreInfo.notes.length} 个音符，请校对后试听。`
        : "已读取乐谱，但没有找到可演奏的带音高音符。");
      return;
    }
    if (isPdf) await loadPdf(file, token);
    else await loadImage(file, token);
    if (token !== state.loadToken) return;
    els.recognizeButton.disabled = false;
    els.recognizeLabel.textContent = idleRecognizeLabel();
    els.scoreHint.textContent = "可以开始识别";
  } catch (error) {
    // 文件已被更新的选择取代时，静默退出，不要把旧错误打到新界面上。
    if (token !== state.loadToken) return;
    console.error(error);
    els.recognizeButton.disabled = true;
    els.recognizeLabel.textContent = "识别乐谱";
    els.scoreInfo.hidden = true;
    els.canvasWrap.hidden = true;
    els.emptyState.hidden = false;
    els.scoreHint.textContent = "载入失败";
    showToast(error.message || "文件无法打开，请尝试其他文件。");
  }
}
async function loadImage(file, token) {
  const image = new Image();
  image.src = state.objectUrl;
  await image.decode();
  if (token !== state.loadToken) return;
  const scale = Math.min(1, 2600 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  setCanvasSize(width, height);
  const ctx = els.scoreCanvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  els.fileInfo.textContent = "图片文件 · " + formatSize(file.size) + " · " + image.naturalWidth + " × " + image.naturalHeight;
}
async function loadPdf(file, token) {
  let pdfjs;
  try {
    pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.mjs");
  } catch {
    throw new Error("PDF 阅读组件载入失败。请连接网络后刷新页面，或将 PDF 页面另存为图片。");
  }
  if (token !== state.loadToken) return;
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.mjs";
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  if (token !== state.loadToken) {
    try { await document.destroy(); } catch { /* 已被取代，尽力释放即可 */ }
    return;
  }
  state.pdf = document;
  state.pageCount = document.numPages;
  els.pageControls.hidden = state.pageCount <= 1;
  await renderPdfPage(1, token);
}
async function renderPdfPage(number, token = state.loadToken) {
  if (!state.pdf) return;
  const targetPage = Math.max(1, Math.min(number, state.pageCount));
  state.pageNumber = targetPage;
  const renderToken = ++state.renderToken;
  const page = await state.pdf.getPage(targetPage);
  const base = page.getViewport({ scale: 1 });
  // Audiveris 需要较高分辨率才能可靠检测谱线（实测 scale ≥3.0 才稳定），
  // 这里按 A4 折算成约 2600px 长边，显示时由 CSS 缩放，不影响观感。
  const viewport = page.getViewport({ scale: Math.min(3.8, 2600 / Math.max(base.width, base.height)) });
  if (renderToken !== state.renderToken || token !== state.loadToken) return;
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  // 先渲染到离屏画布，再把最终结果贴到可见画布：这样连点翻页时不会对同一画布并发调用 render()。
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const offscreenContext = offscreen.getContext("2d", { willReadFrequently: true });
  offscreenContext.fillStyle = "#fff";
  offscreenContext.fillRect(0, 0, width, height);
  await page.render({ canvasContext: offscreenContext, viewport }).promise;
  if (renderToken !== state.renderToken || token !== state.loadToken) return;
  setCanvasSize(width, height);
  const ctx = els.scoreCanvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(offscreen, 0, 0);
  els.pageLabel.textContent = targetPage + " / " + state.pageCount;
  els.prevPage.disabled = targetPage <= 1;
  els.nextPage.disabled = targetPage >= state.pageCount;
}
function removeCurrentFile() {
  stopPlayback();
  state.loadToken++;
  destroyPdf();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.file = null;
  state.objectUrl = null;
  els.fileInput.value = "";
  els.currentFile.hidden = true;
  els.recognizeButton.disabled = true;
  els.recognizeLabel.textContent = "识别乐谱";
  els.clefSelect.disabled = false;
  els.canvasWrap.hidden = true;
  els.emptyState.hidden = false;
  els.pageControls.hidden = true;
  clearScore();
}

// 谱线检测、谱表分组与二值化已移到 staff.js（纯函数，可单元测试）。
function naturalMidi(letter, octave) {
  const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (octave + 1) * 12 + semitones[letter];
}
function pitchForStaffStep(step, clef) {
  const bottomNotes = {
    treble: { letter: "E", octave: 4 },
    bass: { letter: "G", octave: 2 },
    alto: { letter: "F", octave: 3 },
    tenor: { letter: "D", octave: 3 },
  };
  const bottom = bottomNotes[clef] || bottomNotes.treble;
  const letters = ["C", "D", "E", "F", "G", "A", "B"];
  let index = letters.indexOf(bottom.letter) + step;
  const octave = bottom.octave + Math.floor(index / 7);
  index = ((index % 7) + 7) % 7;
  const letter = letters[index];
  return { name: letter + octave, midi: naturalMidi(letter, octave) };
}
function headScore(binary, width, height, cx, cy, spacing, staffRows) {
  const rx = Math.max(3, spacing * 0.42), ry = Math.max(2, spacing * 0.29);
  let ink = 0, samples = 0;
  for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
    const y = Math.round(cy + dy);
    if (y < 0 || y >= height || staffRows.has(y)) continue;
    for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
      if (dx * dx / (rx * rx) + dy * dy / (ry * ry) > 1) continue;
      const x = Math.round(cx + dx);
      if (x < 0 || x >= width) continue;
      samples++;
      ink += binary[y * width + x];
    }
  }
  return samples ? ink / samples : 0;
}
function hasStem(binary, width, height, x, y, spacing) {
  for (const side of [-1, 1]) {
    const sx = Math.round(x + side * spacing * 0.34);
    let ink = 0, samples = 0;
    for (let dy = -Math.round(spacing * 2.7); dy <= Math.round(spacing * 2.7); dy++) {
      if (Math.abs(dy) < spacing * 0.48) continue;
      const sy = Math.round(y + dy);
      if (sy < 0 || sy >= height || sx < 0 || sx >= width) continue;
      samples++;
      ink += binary[sy * width + sx];
    }
    if (samples > 3 && ink / samples > 0.62) return true;
  }
  return false;
}
/** 读取当前画布并二值化——识别流程的公共前置步骤。 */
function readPageBinary() {
  const canvas = els.scoreCanvas;
  const width = canvas.width, height = canvas.height;
  const pixels = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = Math.round(pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114);
  }
  return { binary: binarize(gray), width, height };
}
/**
 * 浏览器内的粗略估算：只针对**单行谱表**。
 * 未安装专业引擎时用它兜底，结果带置信分，界面会标成"待校对"。
 */
function estimateStaffNotes(staff, binary, width, height, clef) {
  const spacing = staff.spacing;
  const staffRows = new Set();
  for (const y of staff.lines) for (let dy = -1; dy <= 1; dy++) staffRows.add(Math.round(y + dy));
  const raw = [], bottomY = staff.bottom, scanStep = Math.max(1, Math.round(spacing / 8));
  const left = Math.max(0, Math.round(staff.left ?? 0));
  const right = Math.min(width, Math.round(staff.right ?? width));
  for (let step = -8; step <= 19; step++) {
    const targetY = bottomY - step * spacing / 2;
    if (targetY < 0 || targetY >= height) continue;
    const hits = [];
    for (let x = left; x < right; x += scanStep) {
      let best = 0, bestY = targetY;
      for (let offset = -2; offset <= 2; offset++) {
        const score = headScore(binary, width, height, x, targetY + offset, spacing, staffRows);
        if (score > best) { best = score; bestY = targetY + offset; }
      }
      if (best >= 0.34) hits.push({ x, y: bestY, score: best });
    }
    const groups = [];
    for (const hit of hits) {
      const last = groups[groups.length - 1];
      if (last && hit.x - last[last.length - 1].x <= spacing * 0.68) last.push(hit);
      else groups.push([hit]);
    }
    for (const group of groups) {
      const best = group.reduce((a, b) => a.score >= b.score ? a : b);
      const pitch = pitchForStaffStep(step, clef);
      const stem = hasStem(binary, width, height, best.x, best.y, spacing);
      const duration = !stem && best.score < 0.49 ? "whole" : (!stem && best.score < 0.55 ? "half" : "quarter");
      raw.push({ name: pitch.name, midi: pitch.midi, x: group.reduce((sum, h) => sum + h.x, 0) / group.length, y: best.y, duration, score: best.score });
    }
  }
  raw.sort((a, b) => a.x - b.x || b.y - a.y);
  const events = [];
  for (const note of raw) {
    const last = events[events.length - 1];
    if (last && note.x - last.x <= spacing * 0.72) {
      if (!last.notes.some((item) => item.midi === note.midi)) last.notes.push(note);
      last.x = last.notes.reduce((sum, item) => sum + item.x, 0) / last.notes.length;
    } else events.push({ x: note.x, notes: [note] });
  }
  const notes = [];
  let startBeat = 0;
  events.forEach((event, eventId) => {
    const eventLength = Math.max(...event.notes.map((note) => durationBeats[note.duration] || 1));
    event.notes.forEach((note) => notes.push({
      id: makeId(), eventId, pitch: note.name, midi: note.midi, duration: note.duration,
      durationBeats: durationBeats[note.duration] || 1, startBeat, x: note.x, y: note.y,
      // 符头打分直接带出来当作置信度，让用户能看出哪些音是"猜"的。
      confidence: Number.isFinite(note.score) ? note.score : Number.NaN,
    }));
    startBeat += eventLength;
  });
  return { notes, tempo: 84, measureCount: 0, warnings: [], clef: CLEF_NAME_TO_SIGN[clef] || "" };
}
const CLEF_NAME_TO_SIGN = { treble: "G2", bass: "F4", alto: "C3", tenor: "C4" };
function drawNoteOverlay(notes, focusedNoteId = null, staffBoxes = null) {
  clearOverlay();
  const ctx = els.overlayCanvas.getContext("2d");
  const boxes = staffBoxes || state.staffBoxes;
  const focusedNote = focusedNoteId ? notes.find((note) => note.id === focusedNoteId) : null;
  const focusedStaff = focusedNote && boxes ? boxes[focusedNote.staffIndex] : null;
  // 多行谱表时把每行谱表的识别区域画出来，便于确认切分是否正确、当前在看哪一行。
  if (boxes && boxes.length > 1) {
    boxes.forEach((staff, index) => {
      const inThisStaff = focusedStaff === staff;
      const left = Number.isFinite(staff.left) ? staff.left : 0;
      const right = Number.isFinite(staff.right) ? staff.right : els.overlayCanvas.width;
      ctx.beginPath();
      ctx.rect(left, staff.top - 3, right - left, staff.bottom - staff.top + 6);
      ctx.fillStyle = inThisStaff ? "rgba(71, 113, 93, .10)" : "rgba(71, 113, 93, .035)";
      ctx.fill();
      ctx.lineWidth = inThisStaff ? 1.6 : 1;
      ctx.strokeStyle = inThisStaff ? "rgba(71, 113, 93, .55)" : "rgba(71, 113, 93, .16)";
      ctx.stroke();
    });
  }
  // 音符的纵坐标可以由音高精确推算（横坐标不能，所以不画点，改画一条音高基准线）。
  if (focusedNote && focusedStaff && focusedNote.pitch) {
    const match = /^([A-Ga-g])(?:\(([-+]?\d+(?:\.\d+)?)\)|(##|bb|#|b))?(-?\d{1,2})$/.exec(focusedNote.pitch.trim());
    if (match) {
      const y = yForPitch(match[1].toUpperCase(), Number(match[4]), focusedStaff, focusedNote.clefName || "treble");
      const left = Number.isFinite(focusedStaff.left) ? focusedStaff.left : 0;
      const right = Number.isFinite(focusedStaff.right) ? focusedStaff.right : els.overlayCanvas.width;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "rgba(180, 92, 55, .85)";
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(left + 10, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(180, 92, 55, .95)";
      ctx.fill();
    }
  }
  for (const note of notes) {
    if (!Number.isFinite(note.x) || !Number.isFinite(note.y)) continue;
    const focused = note.id === focusedNoteId;
    ctx.beginPath();
    ctx.arc(note.x, note.y, focused ? 8 : 5, 0, Math.PI * 2);
    ctx.fillStyle = focused ? "rgba(220, 145, 103, .35)" : "rgba(120, 167, 132, .19)";
    ctx.fill();
    ctx.lineWidth = focused ? 2.5 : 1.7;
    ctx.strokeStyle = focused ? "rgba(180, 92, 55, .95)" : "rgba(67, 117, 79, .82)";
    ctx.stroke();
  }
}
function focusNearestScoreNote(event) {
  const bounds = els.overlayCanvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const x = (event.clientX - bounds.left) * els.overlayCanvas.width / bounds.width;
  const y = (event.clientY - bounds.top) * els.overlayCanvas.height / bounds.height;
  let nearest = null, nearestDistance = Infinity;
  for (const note of state.notes) {
    if (!Number.isFinite(note.x) || !Number.isFinite(note.y)) continue;
    const distance = Math.hypot(note.x - x, note.y - y);
    if (distance < nearestDistance) { nearest = note; nearestDistance = distance; }
  }
  // 引擎结果没有音符坐标：改成按谱表行定位——点哪一行就跳到该行第一个音符。
  if (!nearest || nearestDistance > 42) {
    const boxes = state.staffBoxes;
    if (!boxes) return;
    let staffIndex = -1;
    boxes.forEach((staff, index) => {
      if (y >= staff.top - 8 && y <= staff.bottom + 8) staffIndex = index;
    });
    if (staffIndex < 0) return;
    const first = state.notes.find((note) => note.staffIndex === staffIndex);
    if (!first) return;
    const row = Array.from(els.noteList.querySelectorAll(".note-row")).find((item) => item.dataset.noteId === first.id);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.querySelector(".note-pitch")?.focus();
    drawNoteOverlay(state.notes, first.id);
    return;
  }
  const row = Array.from(els.noteList.querySelectorAll(".note-row")).find((item) => item.dataset.noteId === nearest.id);
  if (!row) return;
  row.scrollIntoView({ block: "nearest" });
  row.querySelector(".note-pitch")?.focus();
  drawNoteOverlay(state.notes, nearest.id);
}
function parsePitch(value) {
  const match = /^([A-Ga-g])(?:\(([-+]?\d+(?:\.\d+)?)\)|(##|bb|#|b))?(-?\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const letter = match[1].toUpperCase(), accidental = match[3] || "", octave = Number(match[4]);
  const alteration = match[2] !== undefined ? Number(match[2]) : ({ "##": 2, "#": 1, b: -1, bb: -2, "": 0 })[accidental];
  const midi = naturalMidi(letter, octave) + alteration;
  if (midi < 0 || midi > 127) return null;
  return { label: letter + (match[2] !== undefined ? `(${match[2]})` : accidental) + octave, midi };
}
function formatBeatCount(beats) {
  return Number.isInteger(beats) ? String(beats) : String(Number(beats.toFixed(3)));
}
function renderNotes() {
  els.noteList.replaceChildren();
  if (!state.notes.length) {
    els.notesEmpty.hidden = false;
    els.noteList.append(els.notesEmpty);
  } else {
    els.notesEmpty.hidden = true;
    state.notes.forEach((note, index) => {
      const row = document.createElement("div");
      row.className = "note-row";
      if (isLowConfidence(note)) row.classList.add("is-low-confidence");
      row.hidden = state.onlyLowConfidence && !isLowConfidence(note);
      row.dataset.noteId = note.id;
      row.dataset.eventId = String(note.eventId);
      const rowParts = [note.partName, note.voice ? `声部 ${note.voice}` : ""].filter(Boolean).join(" · ");
      const confidenceText = isLowConfidence(note) ? ` · 置信度偏低（${note.confidence.toFixed(2)}），建议校对` : "";
      row.title = rowParts + confidenceText;
      const indexLabel = document.createElement("span");
      indexLabel.className = "note-index";
      indexLabel.textContent = String(index + 1).padStart(2, "0");
      indexLabel.tabIndex = 0;
      indexLabel.setAttribute("role", "button");
      indexLabel.title = "点击设为选区起点，Shift+点击设为终点";
      const applySelection = (extend) => {
        state.selection = extend && state.selection
          ? { anchorId: state.selection.anchorId, focusId: note.id }
          : { anchorId: note.id, focusId: note.id };
        markSelectedRows();
        updateSelectionUi();
      };
      indexLabel.addEventListener("click", (event) => {
        event.preventDefault();
        applySelection(event.shiftKey);
      });
      indexLabel.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        applySelection(event.shiftKey);
      });
      // 点序号太小的目标容易点空：整行（除输入框外）点击都当作设选区，
      // 这样"演奏任意一段"的操作不需要精确瞄准那个两位数字。
      row.addEventListener("click", (event) => {
        if (event.target.closest("input, button, select")) return;
        applySelection(event.shiftKey);
      });
      const input = document.createElement("input");
      input.className = "note-pitch";
      input.type = "text";
      input.value = note.pitch;
      input.setAttribute("aria-label", "音符音高");
      input.autocomplete = "off";
      input.spellcheck = false;
      const startInput = document.createElement("input");
      startInput.className = "note-onset";
      startInput.type = "number";
      startInput.min = "0";
      startInput.step = "any";
      startInput.value = formatBeatCount(Number(note.startBeat) || 0);
      startInput.setAttribute("aria-label", "音符起拍（以四分音符为一拍）");
      startInput.title = "从乐曲开始计算的拍数，以四分音符为一拍";
      const durationSelect = document.createElement("select");
      durationSelect.className = "note-duration";
      durationSelect.setAttribute("aria-label", "音符时值");
      if (note.duration === "custom") {
        const customOption = document.createElement("option");
        customOption.value = "custom";
        customOption.textContent = `原时值 · ${formatBeatCount(beatsForNote(note))} 拍`;
        durationSelect.append(customOption);
      }
      for (const [value, label] of durations) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        durationSelect.append(option);
      }
      durationSelect.value = note.duration;
      const deleteButton = document.createElement("button");
      deleteButton.className = "delete-note";
      deleteButton.type = "button";
      deleteButton.title = "删除音符";
      deleteButton.setAttribute("aria-label", "删除音符");
      deleteButton.textContent = "×";
      row.append(indexLabel, input, startInput, durationSelect, deleteButton);
      const focusScoreNote = () => drawNoteOverlay(state.notes, note.id);
      const clearFocusedScoreNote = () => drawNoteOverlay(state.notes);
      input.addEventListener("focus", focusScoreNote);
      startInput.addEventListener("focus", focusScoreNote);
      durationSelect.addEventListener("focus", focusScoreNote);
      row.addEventListener("mouseenter", focusScoreNote);
      row.addEventListener("mouseleave", clearFocusedScoreNote);
      input.addEventListener("change", () => {
        const parsed = parsePitch(input.value);
        if (!parsed) {
          input.setCustomValidity("请输入音名，如 C4、F#4、Bb3 或 C(+0.5)4");
          input.reportValidity();
          input.value = note.pitch;
          input.setCustomValidity("");
          return;
        }
        note.pitch = parsed.label;
        note.midi = parsed.midi;
        updatePlaybackReady();
      });
      startInput.addEventListener("change", () => {
        const rawStartBeat = startInput.value.trim();
        const startBeat = Number(rawStartBeat);
        if (!rawStartBeat || !Number.isFinite(startBeat) || startBeat < 0) {
          startInput.setCustomValidity("起拍需要是大于或等于 0 的数字。");
          startInput.reportValidity();
          startInput.value = formatBeatCount(Number(note.startBeat) || 0);
          startInput.setCustomValidity("");
          return;
        }
        note.startBeat = startBeat;
        updatePlaybackReady();
      });
      durationSelect.addEventListener("change", (event) => {
        note.duration = event.target.value;
        if (durationBeats[note.duration]) note.durationBeats = durationBeats[note.duration];
      });
      deleteButton.addEventListener("click", () => {
        state.notes = state.notes.filter((item) => item.id !== note.id);
        updateVoiceOptions();
        renderNotes();
        drawNoteOverlay(state.notes);
      });
      els.noteList.append(row);
    });
  }
  els.lowConfidenceButton.hidden = !hasLowConfidenceNotes();
  // 只有带谱面坐标的结果（图片路径）才有 overlay 圆点；MusicXML 导入没有坐标，别显示误导性的图例。
  els.scoreLegend.hidden = !state.notes.some((note) => Number.isFinite(note.x) && Number.isFinite(note.y));
  markSelectedRows();
  updateSelectionUi();
}
function updateVoiceOptions(reset = false) {
  const previous = reset ? "all" : (els.voiceFilter.value || "all");
  const groups = new Map();
  for (const note of state.notes) {
    const key = voiceIdentity(note);
    if (!groups.has(key)) {
      const staffText = note.staff ? ` · 谱表 ${note.staff}` : "";
      const voiceText = note.voice ? ` · 声部 ${note.voice}` : "";
      groups.set(key, `${note.partName || "乐谱"}${staffText}${voiceText}`);
    }
  }
  els.voiceFilter.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "全部声部";
  els.voiceFilter.append(allOption);
  for (const [key, label] of groups) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    els.voiceFilter.append(option);
  }
  els.voiceFilter.value = groups.has(previous) ? previous : "all";
  els.voiceFilterField.hidden = groups.size < 2;
}
// 选区：以音符在列表中的顺序区间表示（锚点 + 焦点）
function selectionRange() {
  if (!state.selection) return null;
  const ids = state.notes.map((note) => note.id);
  const anchorIndex = ids.indexOf(state.selection.anchorId);
  const focusIndex = ids.indexOf(state.selection.focusId ?? state.selection.anchorId);
  if (anchorIndex < 0 || focusIndex < 0) return null;
  const start = Math.min(anchorIndex, focusIndex), end = Math.max(anchorIndex, focusIndex);
  return { start, end, ids: ids.slice(start, end + 1) };
}
function markSelectedRows() {
  const range = selectionRange();
  const selectedIds = range ? new Set(range.ids) : null;
  for (const row of els.noteList.querySelectorAll(".note-row")) {
    row.classList.toggle("is-selected", Boolean(selectedIds && selectedIds.has(row.dataset.noteId)));
  }
}
function updateSelectionUi() {
  const range = selectionRange();
  if (range) {
    els.selectionBar.classList.add("is-active");
    els.selectionLabel.textContent = `已选第 ${range.start + 1}–${range.end + 1} 个音符，共 ${range.ids.length} 个`;
    els.clearSelection.hidden = false;
  } else {
    els.selectionBar.classList.remove("is-active");
    els.selectionLabel.textContent = "未选择片段：点音符序号设起点，Shift+点设终点";
    els.clearSelection.hidden = true;
  }
  els.loopToggle.checked = state.loop;
  updatePlaybackReady();
}
function getPlaybackNotes() {
  const selected = els.voiceFilter.value;
  const voiceNotes = (!selected || selected === "all") ? state.notes : state.notes.filter((note) => voiceIdentity(note) === selected);
  const range = selectionRange();
  if (!range) return voiceNotes;
  const selectedIds = new Set(range.ids);
  return voiceNotes.filter((note) => selectedIds.has(note.id));
}
// 试听/导出的时间轴：把选区（或整曲）整体平移到从第 0 拍开始，
// 这样选中片段不会因为前面的空白而延迟很久才响。
function playbackTimeline() {
  const notes = getPlaybackNotes();
  if (!notes.length) return { notes: [], offset: 0, finishBeat: 0 };
  const rawOffset = notes.reduce((min, note) => Math.min(min, Number(note.startBeat) || 0), Infinity);
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
  const finishBeat = notes.reduce((end, note) => Math.max(end, (Number(note.startBeat) || 0) - offset + beatsForNote(note)), 0);
  return { notes, offset, finishBeat };
}
function updatePlaybackReady() {
  const activeNotes = getPlaybackNotes();
  els.noteCount.innerHTML = activeNotes.length + " <small>个</small>";
  els.playButton.disabled = activeNotes.length === 0 || activeNotes.some((note) => !Number.isFinite(note.midi)) || state.isPlaying;
  els.midiButton.disabled = activeNotes.length === 0;
  els.midiButton.title = selectionRange() ? "下载所选片段的 MIDI 文件" : "下载 MIDI 文件";
  // 播放控件文案与选区状态保持一致（否则选完片段按钮仍写着"试听旋律"）。
  els.playIcon.textContent = state.isPlaying ? "Ⅱ" : "▶";
  els.playLabel.textContent = state.isPlaying ? "正在播放" : (selectionRange() ? "试听选区" : "试听旋律");
  els.stopButton.disabled = !state.isPlaying;
}
function addNote() {
  if (els.voiceFilter.value !== "all") els.voiceFilter.value = "all";
  const eventId = state.notes.length ? Math.max(...state.notes.map((note) => note.eventId)) + 1 : 0;
  const startBeat = state.notes.reduce((end, note) => Math.max(end, note.startBeat + beatsForNote(note)), 0);
  state.notes.push({ id: makeId(), eventId, pitch: "C4", midi: 60, duration: "quarter", durationBeats: 1, startBeat, x: NaN, y: NaN });
  renderNotes();
  els.noteList.scrollTop = els.noteList.scrollHeight;
}
/** 整体移调：按增量应用到当前音符，这样已经手动校对过的音符不会被覆盖。 */
function applyTranspose(nextSemitones) {
  const value = Math.max(-12, Math.min(12, Math.round(Number(nextSemitones) || 0)));
  els.transposeInput.value = String(value);
  const delta = value - (state.transposeOffset || 0);
  state.transposeOffset = value;
  if (!delta || !state.notes.length) return;
  state.notes = transposeNotes(state.notes, delta);
  renderNotes();
  drawNoteOverlay(state.notes);
  showToast(`已整体移调 ${value > 0 ? "+" : ""}${value} 个半音。`);
}
/** 把一张图片交给本机引擎识别，返回解析后的乐谱。engine: "audiveris" 整页 / "homr" 单谱表。 */
async function recognizeImageBlob(blob, engine = "homr", attempt = 0) {
  try {
    const response = await fetch("/api/omr/recognize?engine=" + engine, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    });
    const payload = await response.json();
    if (response.status === 503 && payload.reason === "engine-missing") return { unavailable: true };
    if (response.status === 503) {
      // 只是"任务繁忙"：稍等后重试，不要因为一次抖动就放弃整页的专业识别。
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        return recognizeImageBlob(blob, engine, attempt + 1);
      }
      return { error: payload.error || "本机识谱任务繁忙，请稍后重试。" };
    }
    // 整行没有符头（休止/声部未进入）是正常结果，不算故障。
    if (payload.empty) return { empty: true };
    if (!response.ok) return { error: payload.error || "本机 OMR 引擎没有完成识谱。", engine };
    const scoreInfo = parseMusicXmlText(payload.musicxml);
    return { scoreInfo, engine };
  } catch (error) {
    console.info("本机 OMR 未响应，改用浏览器粗略估算。", error);
    return { unavailable: true };
  }
}

/** 整页交给 Audiveris 识别：一次调用得到完整的多声部结构，不再需要逐行裁切。 */
async function recognizeWholePage() {
  const blob = await canvasToBlob();
  if (!blob) return { error: "当前页面无法导出为图片。" };
  return recognizeImageBlob(blob, "audiveris");
}

/** 把可见的谱面画布整张转成 JPEG（供整页识别使用）。 */
function canvasToBlob() {
  return new Promise((resolve) => els.scoreCanvas.toBlob(resolve, "image/jpeg", 0.92));
}

/** 从画布裁出一块区域并转成 JPEG。 */
function cropToBlob(box) {
  const offscreen = document.createElement("canvas");
  offscreen.width = box.width;
  offscreen.height = box.height;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, box.width, box.height);
  ctx.drawImage(els.scoreCanvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  return new Promise((resolve) => offscreen.toBlob(resolve, "image/jpeg", 0.95));
}

function setRecognizeProgress(done, total, label) {
  state.recognizeProgress = { done, total };
  if (!els.recognizeProgress) return;
  els.recognizeProgress.hidden = total <= 0;
  els.recognizeProgressBar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
  els.recognizeProgressLabel.textContent = label || (total ? `已完成 ${done} / ${total} 行谱表` : "");
}

/**
 * 逐谱表识别：把整页切成一行行谱表分别送去识别，再按"系统内并行、系统间顺序"拼回多声部。
 * 这样可以绕开识别引擎把整页多行谱表压平成单一旋律的问题。
 */
async function recognizeScore() {
  if (!state.file || !els.scoreCanvas.width) return;
  if (state.isRecognizing) return;
  state.isRecognizing = true;
  state.cancelRecognize = false;
  const token = ++state.recognizeToken;
  const fileToken = state.loadToken;
  const superseded = () => token !== state.recognizeToken || fileToken !== state.loadToken || state.cancelRecognize;
  stopPlayback();
  state.selection = null;
  els.processingOverlay.hidden = false;
  els.recognizeButton.disabled = true;
  els.recognizeLabel.textContent = "正在识别…";
  els.clefSelect.disabled = true;
  els.staffSelect.disabled = true;
  els.cancelRecognize.hidden = false;
  let wholePageError = "";
  setRecognizeProgress(0, 0, "正在分析谱表…");
  els.scoreHint.textContent = audiverisAvailable === false && homrAvailable === false
    ? "未检测到专业引擎，正在逐行做粗略估算"
    : audiverisAvailable !== false
      ? "正在整页识别；若 Audiveris 不可用则逐行谱表识别（避免多声部被压平）"
      : "正在逐行谱表识别（每行单独送引擎，避免多声部被压平）";
  if (wholePageError) {
    els.scoreHint.textContent += "；上次整页识别未成功，已改用逐行识别";
  }
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));

  try {
    const { binary, width, height } = readPageBinary();
    const staves = detectStaves(binary, width, height);
    if (!staves.length) {
      throw new Error("没有检测到五线谱。这页可能是简谱（数字谱）——目前识谱引擎只支持五线谱；也请检查图片是否清晰完整。");
    }
    updateStaffOptions(staves.length);

    const wanted = Number(els.staffSelect.value);
    const singleStaff = Number.isInteger(wanted) && wanted >= 0 && wanted < staves.length;
    const targets = singleStaff ? [wanted] : staves.map((_, index) => index);

    // Audiveris 整页识别：一次调用即得到完整的多声部结构（各声部并行而非首尾串接）。
    // 只在"识别全部谱表"且本机装有 Audiveris 时走这条路；单行重试仍走逐行流程。
    if (!singleStaff && audiverisAvailable !== false) {
      setRecognizeProgress(0, 1, "正在整页识别（Audiveris，约 10–20 秒）…");
      const engineResult = await recognizeWholePage();
      if (superseded()) return;
      if (engineResult.scoreInfo && engineResult.scoreInfo.notes.length) {
        const scoreInfo = engineResult.scoreInfo;
        for (const note of scoreInfo.notes) note.duration = durationFromBeats(note.durationBeats);
        dedupePartNames(scoreInfo.notes);
        state.scoreInfo = scoreInfo;
        state.notes = scoreInfo.notes;
        state.staffBoxes = staves;
        state.recognitionSource = "engine";
        state.transposeOffset = 0;
        if (els.transposeInput) els.transposeInput.value = "0";
        updateVoiceOptions(true);
        state.recognized = true;
        els.clefSelect.disabled = false;
        renderNotes();
        drawNoteOverlay(scoreInfo.notes, null, staves);
        updateRecognitionBanner();
        els.scoreHint.textContent = `Audiveris 整页识别完成：${scoreInfo.notes.length} 个音符 · ${scoreInfo.partNames.length} 个声部 · ${scoreInfo.measureCount} 小节`;
        const warning = scoreInfo.warnings[0] ? ` ${scoreInfo.warnings[0]}` : "";
        showToast(`Audiveris 识别到 ${scoreInfo.notes.length} 个音符（${scoreInfo.partNames.length} 个声部），请逐音校对。${warning}`);
        return;
      }
      if (engineResult.unavailable) {
        audiverisAvailable = false;
        updateEngineHint();
      }
      // 整页识别失败（例如分辨率不足或这一页是简谱）：记下原因，继续走逐行流程。
      wholePageError = engineResult.error || "";
    }

    const systems = targets.length === 1
      ? [[targets[0]]]
      : groupSystems(staves.filter((_, index) => targets.includes(index)))
          .map((system) => system.map((staff) => staves.indexOf(staff)));

    const results = new Map();
    let done = 0;
    let engineMissing = false;
    let estimatedCount = 0;
    let emptyCount = 0;
    let failedCount = 0;
    setRecognizeProgress(0, targets.length, "");

    for (const index of targets) {
      if (superseded()) return;
      const staff = staves[index];
      const box = staffCropBox(staff, width, height, staves[index - 1], staves[index + 1]);
      setRecognizeProgress(done, targets.length, `正在识别第 ${done + 1} / ${targets.length} 行谱表`);

      let result = null;
      let clef = els.clefSelect.value;
      if (!engineMissing && homrAvailable !== false) {
        const blob = await cropToBlob(box);
        if (superseded()) return;
        const engineResult = blob ? await recognizeImageBlob(blob) : { unavailable: true };
        if (superseded()) return;
        if (engineResult.unavailable) {
          engineMissing = true;
        } else if (engineResult.empty) {
          result = { notes: [], tempo: 84, measureCount: 0, warnings: [], clef: "", empty: true };
          emptyCount++;
        } else if (engineResult.scoreInfo) {
          result = engineResult.scoreInfo;
          clef = CLEF_BY_SIGN[result.clef] || clef;
          if (!result.notes.length) {
            result.empty = true;
            emptyCount++;
          }
        } else {
          // 这一行引擎确实失败了：如实标记，不用像素估算去"猜"（那只会产生假音符）。
          result = { notes: [], tempo: 84, measureCount: 0, warnings: [], clef: "", error: engineResult.error };
          failedCount++;
        }
      }
      // 只有整台引擎都不可用时，才退回浏览器内的粗略估算。
      if (!result) {
        result = estimateStaffNotes(staff, binary, width, height, clef);
        estimatedCount++;
      }

      // 本机引擎不返回音符在谱面上的坐标，这里不再尝试用像素检测去"反推"位置：
      // 在真实雕版谱上（谱号涡卷、歌词、圆滑线）误检率很高，画出来的点反而会误导。
      // 谱面导航改用"谱表框 + 行高亮 + 音高基准线"，这三者是 100% 可靠的。
      result.staffIndex = index;
      result.clefName = clef;
      results.set(index, result);
      done++;
      setRecognizeProgress(done, targets.length, "");
    }

    if (superseded()) return;
    const merged = mergeSystemScores(systems, results);
    if (!merged.notes.length) {
      // 所有谱表都没能读出音符：最常见的两种情况是这一页是简谱（数字谱），
      // 或者图片分辨率不足。明确说出来，不要让用户对着"失败"干猜。
      if (failedCount === targets.length && !estimatedCount && !emptyCount) {
        throw new Error("没有识别出任何音符。这页可能是简谱（数字谱）——识谱引擎只支持五线谱；也可能是图片不清晰，可换更清晰的整页图片再试。");
      }
      throw new Error("逐行识别没有提取到音符，可点击“添加”手动录入。");
    }
    for (const note of merged.notes) note.duration = durationFromBeats(note.durationBeats);

    state.scoreInfo = merged;
    state.notes = merged.notes;
    state.staffBoxes = staves;
    state.recognitionSource = estimatedCount === targets.length ? "estimate" : (estimatedCount ? "mixed" : "engine");
    state.transposeOffset = 0;
    els.transposeInput.value = "0";
    updateVoiceOptions(true);
    state.recognized = true;
    els.clefSelect.disabled = false;
    renderNotes();
    drawNoteOverlay(merged.notes, null, staves);
    updateRecognitionBanner();
    const sourceLabel = state.recognitionSource === "engine"
      ? "本机专业引擎"
      : state.recognitionSource === "estimate" ? "粗略估算" : "专业引擎 + 部分估算";
    const extra = [
      emptyCount ? `${emptyCount} 行整行休止` : "",
      failedCount ? `${failedCount} 行识别失败` : "",
    ].filter(Boolean).join(" · ");
    els.scoreHint.textContent = `逐行识别完成：${targets.length} 行谱表 · ${merged.notes.length} 个音符 · ${merged.systemCount} 个系统${extra ? " · " + extra : ""}`;
    if (wholePageError) {
      // 把整页识别失败的原因如实告诉用户（例如这一页是简谱、数字谱，任何引擎都不支持）。
      els.scoreHint.textContent += ` · 整页识别未成功：${wholePageError}`;
    }
    const warning = merged.warnings[0] ? ` ${merged.warnings[0]}` : "";
    showToast(`${sourceLabel}识别到 ${merged.notes.length} 个音符（${targets.length} 行谱表），请逐音校对。${warning}`);
  } catch (error) {
    if (superseded()) return;
    console.error(error);
    // 识别失败时清掉上一次的结果，避免旧音符继续被当作"本次识别结果"试听和导出。
    state.notes = [];
    state.scoreInfo = null;
    state.recognitionSource = null;
    state.staffBoxes = null;
    state.recognized = false;
    renderNotes();

    clearOverlay();
    updateRecognitionBanner();
    // 把真实原因告诉用户（例如"这页是简谱"、"没找到五线谱"），而不是一句笼统的失败。
    const message = error && error.message ? error.message : "识别时遇到问题，请换一张更清晰的图片再试。";
    showToast(message);
    els.scoreHint.textContent = "识别失败，已清空上一次的结果 · " + message;
  } finally {
    state.isRecognizing = false;
    els.processingOverlay.hidden = true;
    els.cancelRecognize.hidden = true;
    setRecognizeProgress(0, 0, "");
    els.recognizeProgress.hidden = true;
    // 文件已经换掉时不要再去改主界面状态，交给新的加载流程处理。
    if (fileToken === state.loadToken) {
      els.recognizeButton.disabled = !state.file;
      els.recognizeLabel.textContent = idleRecognizeLabel();
      els.clefSelect.disabled = false;
      els.staffSelect.disabled = false;
    }
  }
}
function updateStaffOptions(count) {
  const previous = els.staffSelect.value;
  els.staffSelect.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "-1";
  allOption.textContent = count > 1 ? `全部谱表（${count} 行）` : "当前谱表";
  els.staffSelect.append(allOption);
  for (let index = 0; index < count; index++) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `只识别第 ${index + 1} 行谱表（从上往下）`;
    els.staffSelect.append(option);
  }
  els.staffSelect.value = Array.from(els.staffSelect.options).some((option) => option.value === previous) ? previous : "-1";
  els.staffSelectField.hidden = count < 2;
}
function variableLength(value) {
  let remaining = Math.max(0, Math.floor(value));
  const bytes = [remaining & 0x7f];
  remaining = Math.floor(remaining / 128);
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  return bytes;
}
function buildMidiFile(notes = getPlaybackNotes(), offset = 0) {
  const ticksPerBeat = 480;
  const tempo = Math.min(320, Math.max(20, Number(els.tempoInput.value) || 84));
  const microsPerBeat = Math.round(60000000 / tempo);
  const events = [{
    tick: 0, priority: 0,
    bytes: [0xff, 0x51, 0x03, (microsPerBeat >> 16) & 0xff, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff],
  }];
  for (const note of notes) {
    if (!Number.isFinite(note.midi)) continue;
    const startTick = Math.max(0, Math.round(((note.startBeat || 0) - offset) * ticksPerBeat));
    const endTick = startTick + Math.max(1, Math.round(beatsForNote(note) * ticksPerBeat));
    const midi = Math.min(127, Math.max(0, Math.round(note.midi)));
    events.push({ tick: startTick, priority: 2, bytes: [0x90, midi, 88] });
    events.push({ tick: endTick, priority: 1, bytes: [0x80, midi, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const track = [];
  let previousTick = 0;
  for (const event of events) {
    track.push(...variableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const header = [0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff];
  return new Blob([new Uint8Array([...header, ...trackHeader, ...track])], { type: "audio/midi" });
}
function downloadMidi() {
  const { notes, offset } = playbackTimeline();
  if (!notes.length) return;
  const url = URL.createObjectURL(buildMidiFile(notes, offset));
  const anchor = document.createElement("a");
  const baseName = state.file ? state.file.name.replace(/\.[^.]+$/, "") : "谱见旋律";
  anchor.href = url;
  anchor.download = baseName.replace(/[\\/:*?"<>|]/g, "_") + ".mid";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(selectionRange() ? "所选片段的 MIDI 已下载。" : "MIDI 文件已下载。");
}
function midiFrequency(midi) { return 440 * (2 ** ((midi - 69) / 12)); }
function playTone(midi, startAt, duration) {
  const audio = state.audio, gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.055, startAt + Math.min(0.18, duration * 0.42));
  gain.gain.setValueAtTime(0.05, Math.max(startAt + 0.03, startAt + duration - 0.045));
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  gain.connect(audio.destination);
  const oscillator = audio.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(midiFrequency(midi), startAt);
  oscillator.connect(gain);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.015);
  state.sources.add(oscillator);
  oscillator.onended = () => {
    // 连接到 destination 的节点不会被垃圾回收，必须显式断开，
    // 否则每次试听都会永久留下一批 gain + oscillator，反复试听后音频图会持续膨胀。
    try {
      gain.disconnect();
      oscillator.disconnect();
    } catch (error) {
      console.info("音频节点释放时出错（通常可忽略）。", error);
    }
    state.sources.delete(oscillator);
  };
}
async function playMelody() {
  const { notes: playbackNotes, offset, finishBeat } = playbackTimeline();
  if (!playbackNotes.length || state.isPlaying) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return showToast("当前浏览器不支持音频播放，请使用较新的浏览器。");
  if (!state.audio) state.audio = new AudioContextClass();
  await state.audio.resume();
  // 清掉上一轮遗留的定时器（包括循环定时器），避免反复试听让定时器数组无界增长。
  for (const timer of state.timers) clearTimeout(timer);
  state.timers = [];
  const tempo = Math.min(320, Math.max(20, Number(els.tempoInput.value) || 84));
  els.tempoInput.value = tempo;
  const eventMap = new Map();
  for (const note of playbackNotes) {
    const onset = Math.max(0, (Number(note.startBeat) || 0) - offset);
    const onsetKey = onset.toFixed(6);
    if (!eventMap.has(onsetKey)) eventMap.set(onsetKey, { id: onsetKey, notes: [], startBeat: onset });
    const event = eventMap.get(onsetKey);
    event.notes.push(note);
    event.startBeat = Math.min(event.startBeat, onset);
  }
  const events = [...eventMap.values()].sort((a, b) => a.startBeat - b.startBeat);
  const beatSeconds = 60 / tempo, start = state.audio.currentTime + 0.06;
  state.isPlaying = true;
  updatePlaybackControls();
  for (const event of events) {
    for (const note of event.notes) {
      const seconds = beatsForNote(note) * beatSeconds;
      const at = start + Math.max(0, (Number(note.startBeat) || 0) - offset) * beatSeconds;
      playTone(note.midi, at, seconds * 0.92);
    }
    state.timers.push(setTimeout(() => highlightEvent(event.notes.map((note) => note.id)), event.startBeat * beatSeconds * 1000));
  }
  state.timers.push(setTimeout(() => {
    state.isPlaying = false;
    highlightEvent(null);
    updatePlaybackControls();
    if (state.loop && getPlaybackNotes().length) playMelody().catch((error) => console.error(error));
  }, finishBeat * beatSeconds * 1000 + 120));
}
function highlightEvent(noteIds) {
  const activeIds = noteIds === null ? null : new Set(noteIds);
  for (const row of els.noteList.querySelectorAll(".note-row")) {
    row.classList.toggle("is-playing", activeIds !== null && activeIds.has(row.dataset.noteId));
  }
}
function stopPlayback() {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers = [];
  for (const source of state.sources) {
    try { source.stop(); } catch { /* The note may have just ended. */ }
  }
  state.sources.clear();
  state.isPlaying = false;
  highlightEvent(null);
  updatePlaybackControls();
}
function updatePlaybackControls() {
  updatePlaybackReady();
}
function handleDrop(event) {
  event.preventDefault();
  els.dropzone.classList.remove("is-dragging");
  const file = event.dataTransfer && event.dataTransfer.files[0];
  if (file) loadFile(file);
}
async function goToPdfPage(number) {
  if (!state.pdf) return;
  clearScore();
  const token = state.loadToken;
  await renderPdfPage(number, token);
  if (token !== state.loadToken) return;
  els.scoreHint.textContent = "可以开始识别此页";
}
els.fileInput.addEventListener("change", (event) => loadFile(event.target.files[0]));
els.chooseFileButton.addEventListener("click", () => els.fileInput.click());
els.removeFile.addEventListener("click", removeCurrentFile);
els.recognizeButton.addEventListener("click", recognizeScore);
els.addNoteButton.addEventListener("click", addNote);
els.midiButton.addEventListener("click", downloadMidi);
els.playButton.addEventListener("click", playMelody);
els.stopButton.addEventListener("click", stopPlayback);
els.canvasWrap.addEventListener("click", focusNearestScoreNote);
els.voiceFilter.addEventListener("change", () => {
  stopPlayback();
  updateSelectionUi();
});
els.lowConfidenceButton.addEventListener("click", () => {
  state.onlyLowConfidence = !state.onlyLowConfidence;
  els.lowConfidenceButton.classList.toggle("is-active", state.onlyLowConfidence);
  els.lowConfidenceButton.textContent = state.onlyLowConfidence ? "显示全部" : "只看待校对";
  renderNotes();
});
els.loopToggle.addEventListener("change", () => {
  state.loop = els.loopToggle.checked;
  updateSelectionUi();
});
els.clearSelection.addEventListener("click", () => {
  state.selection = null;
  markSelectedRows();
  updateSelectionUi();
});
els.cancelRecognize.addEventListener("click", () => {
  state.cancelRecognize = true;
  els.cancelRecognize.hidden = true;
  els.scoreHint.textContent = "已取消识别";
});
els.transposeInput.addEventListener("change", () => applyTranspose(els.transposeInput.value));
els.resetTranspose.addEventListener("click", () => applyTranspose(0));
// 标题直接可编辑：识别引擎常把谱面编号当成标题，让用户随手改掉。
els.scoreTitle.addEventListener("blur", () => {
  const text = (els.scoreTitle.textContent || "").trim();
  els.scoreTitle.textContent = text || "未命名乐谱";
  if (state.scoreInfo) state.scoreInfo.title = els.scoreTitle.textContent;
});
els.scoreTitle.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  els.scoreTitle.blur();
});
els.prevPage.addEventListener("click", () => goToPdfPage(state.pageNumber - 1));
els.nextPage.addEventListener("click", () => goToPdfPage(state.pageNumber + 1));
els.clefSelect.addEventListener("change", () => { if (state.file && state.recognized) recognizeScore(); });
els.staffSelect.addEventListener("change", () => { if (state.file && state.recognized) recognizeScore(); });
els.dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); els.fileInput.click(); }
});
for (const name of ["dragenter", "dragover"]) els.dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  els.dropzone.classList.add("is-dragging");
});
for (const name of ["dragleave", "drop"]) els.dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  els.dropzone.classList.remove("is-dragging");
});
els.dropzone.addEventListener("drop", handleDrop);
els.tempoInput.addEventListener("change", () => {
  els.tempoInput.value = Math.min(320, Math.max(20, Number(els.tempoInput.value) || 84));
});
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.target.matches("input, select, textarea, button")) return;
  event.preventDefault();
  if (state.isPlaying) stopPlayback();
  else if (!els.playButton.disabled) playMelody();
});
renderNotes();
refreshEngineStatus();
