import { parseMusicXmlText, readMusicXmlFile } from "./musicxml.js";
import {
  binarize, detectStaves, groupSystems, staffCropBox,
  mergeSystemScores, mergePageScores, transposeNotes, yForPitch, CLEF_BY_SIGN, quantizeScoreRhythm,
} from "./staff.js";
import {
  TIMBRE_LABELS, TIMBRE_GAIN, TIMBRE_ORDER, TIMBRE_GROUPS, PIANO_HARMONICS, PIANO_STRINGS,
  STRINGS_DETUNE, ORGAN_HARMONICS, VOWELS, FEMALE_VOWELS, VIBRATO, REVERB, COMPRESSOR,
  HUMANIZE, CHOIR_ENVELOPE, ORGAN_ENVELOPE, STRINGS_ENVELOPE, SCHEDULER,
  vowelForPart, pianoDamperSeconds, pianoBrightness, pianoDecayShape,
} from "./timbre.js";
import {
  SAMPLED_TIMBRES, SAMPLED_TARGET_RMS, isSampledTimbre, fetchSampleManifest, loadSampleBank, lookupSample,
} from "./sampler.js";
import { detectStartTempo, playbackTempoSegments, midiTempoEvents, clampTempo } from "./tempo.js";
import {
  buildAudioPlan, normalizePeak, stereoChannels, audioFileName, formatDuration, secondsAtBeat,
} from "./audio-export.js";

const byId = (id) => document.getElementById(id);
const els = {
  fileInput: byId("fileInput"), dropzone: byId("dropzone"), currentFile: byId("currentFile"),
  fileName: byId("fileName"), fileInfo: byId("fileInfo"), removeFile: byId("removeFile"),
  recognizeButton: byId("recognizeButton"), recognizeLabel: byId("recognizeLabel"), clefSelect: byId("clefSelect"),
  recognizeAllButton: byId("recognizeAllButton"), recognizeAllLabel: byId("recognizeAllLabel"),
  engineHint: byId("engineHint"),
  staffSelectField: byId("staffSelectField"), staffSelect: byId("staffSelect"),
  jianpuField: byId("jianpuField"), jianpuKey: byId("jianpuKey"), jianpuBeats: byId("jianpuBeats"),
  jianpuButton: byId("jianpuButton"), jianpuLabel: byId("jianpuLabel"), jianpuHint: byId("jianpuHint"),
  jianpuAllButton: byId("jianpuAllButton"), jianpuAllLabel: byId("jianpuAllLabel"),
  emptyState: byId("emptyState"), canvasWrap: byId("canvasWrap"), scoreCanvas: byId("scoreCanvas"),
  overlayCanvas: byId("overlayCanvas"), pageControls: byId("pageControls"), pageLabel: byId("pageLabel"),
  prevPage: byId("prevPage"), nextPage: byId("nextPage"), processingOverlay: byId("processingOverlay"),
  scoreHint: byId("scoreHint"), scoreInfo: byId("scoreInfo"), scoreTitle: byId("scoreTitle"),
  scoreDetails: byId("scoreDetails"), scoreWarnings: byId("scoreWarnings"), noteCount: byId("noteCount"), noteList: byId("noteList"),
  partPanel: byId("partPanel"), partList: byId("partList"), partSelectAll: byId("partSelectAll"),
  partSelectNone: byId("partSelectNone"), pianoToggle: byId("pianoToggle"), pianoToggleWrap: byId("pianoToggleWrap"),
  notesEmpty: byId("notesEmpty"), addNoteButton: byId("addNoteButton"), midiButton: byId("midiButton"),
  measureJumpInput: byId("measureJumpInput"), measureJumpButton: byId("measureJumpButton"),
  audioButton: byId("audioButton"), audioExportLabel: byId("audioExportLabel"), playButton: byId("playButton"),
  playIcon: byId("playIcon"), playLabel: byId("playLabel"), stopButton: byId("stopButton"),
  tempoInput: byId("tempoInput"), toast: byId("toast"), chooseFileButton: byId("chooseFileButton"),
  recognitionBanner: byId("recognitionBanner"), recognitionSource: byId("recognitionSource"), recognitionDetail: byId("recognitionDetail"),
  lowConfidenceButton: byId("lowConfidenceButton"),
  selectionBar: byId("selectionBar"), selectionLabel: byId("selectionLabel"),
  loopToggle: byId("loopToggle"), clearSelection: byId("clearSelection"), scoreLegend: byId("scoreLegend"),
  recognizeProgress: byId("recognizeProgress"), recognizeProgressBar: byId("recognizeProgressBar"),
  recognizeProgressLabel: byId("recognizeProgressLabel"), cancelRecognize: byId("cancelRecognize"),
  transposeInput: byId("transposeInput"), resetTranspose: byId("resetTranspose"),
  instrumentNote: byId("instrumentNote"), timbreSelect: byId("timbreSelect"), timbreHint: byId("timbreHint"),
  sampleStatus: byId("sampleStatus"), tempoHint: byId("tempoHint"),
  layerToolbar: byId("layerToolbar"), addLayerPart: byId("addLayerPart"),
  addLayerEcho: byId("addLayerEcho"), addLayerLower: byId("addLayerLower"),
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
  // 音符行索引（id → DOM 行）与当前正在高亮的集合：播放时只改动变化的那几行。
  noteRowById: null, highlightedIds: new Set(),
  // 音符 id → 音符对象（事件委托用）：整表重绘时重建，复制声部时增量补充。
  noteById: null, noteListDelegated: false, hoverRow: null,
  // 谱面叠加层静态底图缓存（音符圆点/谱表框）：悬停、点选时只重画高亮，不再遍历全部音符。
  overlayEpoch: 0, overlayBase: null, overlayBaseSignature: "",
  // 小节序号 → 小节 <section> 节点：复制声部时 O(1) 找到要插入的小节。
  measureGroups: null,
  // 时值选择菜单（全局只有一个，避免每行 19 个 <option>）。
  durationMenu: null, durationMenuNote: null,
  // 演奏范围：selectedParts=null 表示全选；includePiano=是否把钢琴伴奏算进去。
  // partNames 存「声部标识 -> 用户改的名字」，改一次整份乐谱一起生效。
  selectedParts: null, includePiano: true, partNames: new Map(), pianoKeys: new Set(),
  // 声部音量（0–1，默认 1）与播放时的「声部音量总线」：拖滑条实时改总线增益，
  // 正在播放的音符会立刻跟着变，不需要停播、也不需要重建音频图。
  partVolumes: new Map(), partBuses: new Map(), partPanners: new Map(),
  // 播放音色（piano / strings / choir / organ / soft）与音频主链（混响+压限）的缓存。
  timbre: "piano", master: null, reverbBuffer: null, vibrato: null, noiseBuffer: null, waves: new Map(),
  // 「全局音色」之外的逐声部音色覆盖：key = 声部标识（voiceIdentity），value = 音色名。
  // 不在这里的元素就是「跟随全局」。
  partTimbres: new Map(),
  // 逐声部八度修正：key = 声部标识，value = ±1（个八度）。
  // 识别引擎偶尔会把「8vb 谱号」（男高音谱号下的小 8）漏掉，导致整个声部高八度；
  // 这里允许用户按声部单独校回，不影响其它声部。
  partOctaves: new Map(),
  // 播放的滚动调度定时器（见 playMelody 里的说明）与软限幅曲线缓存。
  scheduleTimer: null, softClipCurve: null,
  // 采样音源：清单、已加载的样本表、正在加载的 Promise、加载顺序（用于内存上限 LRU）。
  sampleManifest: null, sampleBanks: new Map(), sampleLoading: new Map(), sampleOrder: [],
  // 混响预热状态（见 prewarmReverb：避免第一次点播放时同步生成 1.9 秒脉冲而卡顿）
  reverbWarming: false,
  // 识别结果对应的是哪一页（简谱/单页识别=页码；整本识别或 MusicXML 导入=null）。
  // 翻页时**不清空结果**，只按这个页码决定要不要在谱面上画音符坐标。
  scorePage: null,
  // 逐谱表识别相关：谱表几何、进度、取消标志、整体移调量
  staffBoxes: null, recognizeProgress: { done: 0, total: 0 }, cancelRecognize: false, transposeOffset: 0,
  // 图片文件的原图（显示画布会缩到 2600px；识谱要用更清晰的原图另行缩放渲染）。
  image: null,
  // 「图片型」低清 PDF 的检测结果：{dpi}。太低时把原因如实写进识别结果，而不是让用户对着错音猜。
  lowResPdf: null,
  // 当前文件的 PDF 原始字节（供速度 OCR 读文字层用；图片文件为 null）
  pdfBytes: null,
  // 上一次识别成功得到的拍号（同一份文件内复用）：后面几页通常不印拍号，
  // 交给解析器当「已知拍号」，小节长度才不会按识别出来的内容瞎猜。
  timeSignatureHint: "",
};
// 粗略估算得到的符头置信分低于此值即标为"待校对"
const LOW_CONFIDENCE_THRESHOLD = 0.5;
// 识谱（OMR）用的整页渲染参数。
// · 普通（矢量）PDF：识谱图按 2600px 长边、3.8× 上限渲染——和以前一样的像素量，
//   只是不再用 JPEG（JPEG 的二次压缩会伤到小音符和谱线）。
// · 图片型低清 PDF（扫描/截图，值越大越糊）：必须放大 + 锐化才有救。实测《有我》
//   这类 155 DPI 的缩编合唱谱，Audiveris 在 p2 上的「4 拍小节」占比：
//     2600px/JPEG 约 43% → 4.5× 约 43% → 5.0× + 锐化 约 86%（p5：25% → 50%）。
//   放大只对「源本身就是图片」的有意义，所以按检测结果自适应，不让矢量谱白白变慢。
const OMR_RENDER_SCALE = 5.0;
const OMR_VECTOR_LONG_EDGE = 2600;
const OMR_VECTOR_MAX_SCALE = 3.8;
const OMR_TARGET_LONG_EDGE = 3400;   // 图片文件放大到约这个长边
const OMR_MAX_LONG_EDGE = 4200;      // 页面再大也不超过这个长边（内存/请求体上限）
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
// 声部标识 = 乐谱的一个 part（声部）。
// 不把 staff / voice 掺进来：那样会把「钢琴大谱表」这类一个 part 两个谱表、
// 或同一 part 内不同 voice 拆成好几行，界面上就变成「一堆声部」——实测正是这样多出来的。
// 各条识别路径都给了稳定的 partId：五线谱 P1..Pn / 逐谱表 staff-N / 简谱 jianpu-N / MusicXML part id。
const voiceIdentity = (note) => String(note.partId || note.partName || "旋律");

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
let jianpuAvailable = null;
// Audiveris 的 OCR 语言包（装了才能读出谱面上的「♩ = 66」速度标记和歌词）。
let audiverisOcr = null;
function idleRecognizeLabel() {
  if (audiverisAvailable === false && homrAvailable === false) return "估算识别";
  if (state.recognized) return "重新识别";
  return "识别乐谱";
}
function updateEngineHint() {
  if (!els.engineHint) return;
  if (audiverisAvailable === true) {
    els.engineHint.textContent = audiverisOcr && audiverisOcr.length
      ? "已检测到 Audiveris 整页识别引擎（多声部 + OCR：能读谱面速度标记与歌词）；识别结果仍建议逐音校对后再使用。"
      : "已检测到 Audiveris 整页识别引擎（多声部）；未装 OCR 语言包，谱面速度/歌词读不到，速度请按谱面的 ♩=?? 手动填 BPM。识别结果仍建议逐音校对。";
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
    jianpuAvailable = Boolean(payload.jianpuAvailable);
    audiverisOcr = Array.isArray(payload.audiverisOcr) ? payload.audiverisOcr : [];
  } catch {
    audiverisAvailable = null;
    homrAvailable = null;
    jianpuAvailable = null;
  }
  if (els.jianpuButton) els.jianpuButton.hidden = jianpuAvailable === false;
  updateBatchButtons();
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
  state.scorePage = null;
  state.selectedParts = null;
  state.partNames = new Map();
  state.pianoKeys = new Set();
  if (els.transposeInput) els.transposeInput.value = "0";
  if (els.recognizeProgress) els.recognizeProgress.hidden = true;
  els.scoreInfo.hidden = true;
  updatePartControls(true);
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
  // 按 part 的自然顺序（P1<P2<…，即谱面自上而下、钢琴在最后）编号，
  // 否则编号顺序取决于音符在数组里出现的先后，"Voice 1" 可能落到谱面最下面一行，看着像坏了。
  const ordered = [...partNames.entries()].sort((a, b) => {
    const [aHead, aNum] = partSortKey(a[0]);
    const [bHead, bNum] = partSortKey(b[0]);
    return aHead.localeCompare(bHead) || aNum - bNum;
  });
  for (const [partId, name] of ordered) {
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
  } else if (state.recognitionSource === "jianpu") {
    banner.className = "recognition-banner is-jianpu";
    els.recognitionSource.textContent = "本机简谱识别（实验性）";
    els.recognitionDetail.textContent = lowCount
      ? `${state.notes.length} 个音符，其中 ${lowCount} 个置信度偏低 · 简谱识别仍在完善，请逐音校对`
      : `${state.notes.length} 个音符 · 由本机简谱模块（数字模板匹配 + 版面解析）得出，请逐音校对`;
  } else {
    banner.className = "recognition-banner is-estimate";
    els.recognitionSource.textContent = "粗略估算 · 未经专业识别";
    els.recognitionDetail.textContent = lowCount
      ? `${state.notes.length} 个音符，其中 ${lowCount} 个置信度偏低 · 请逐音校对后再使用`
      : `${state.notes.length} 个音符 · 估算结果仅供参考，请逐音校对后再使用`;
  }
  banner.hidden = false;
}
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function midiToPitchName(midi) {
  const value = Math.round(Number(midi));
  if (!Number.isFinite(value)) return "";
  return NOTE_NAMES[((value % 12) + 12) % 12] + (Math.floor(value / 12) - 1);
}

/** 把简谱识别结果（内部音符模型）转成与 MusicXML 解析结果同构的 scoreInfo。 */
function jianpuToScoreInfo(payload, beats) {
  const notes = [], partNames = [];
  let eventId = 0;
  payload.parts.forEach((part, partIndex) => {
    const partName = part.name || `声部${partIndex + 1}`;
    partNames.push(partName);
    for (const raw of part.notes) {
      const startBeat = Number(raw.startBeat) || 0;
      const measureIndex = Math.floor(startBeat / beats + 1e-6);
      notes.push({
        id: makeId(), eventId: eventId++, partId: `jianpu-${partIndex + 1}`, partName,
        voice: "1", staff: String(partIndex + 1),
        measure: String(measureIndex + 1), measureIndex,
        startInMeasure: Number((startBeat - measureIndex * beats).toFixed(4)),
        startBeat, durationBeats: Number(raw.durationBeats) || 1,
        pitch: midiToPitchName(raw.midi), midi: Number(raw.midi),
        x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : Number.NaN,
        y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : Number.NaN,
        tieStart: false, tieStop: false,
      });
    }
  });
  const totalBeats = notes.reduce((end, note) => Math.max(end, note.startBeat + note.durationBeats), 0);
  const keyOption = els.jianpuKey && els.jianpuKey.selectedOptions[0];
  return {
    title: state.file ? state.file.name.replace(/\.[^.]+$/, "") : "简谱识别结果",
    notes, tempo: Math.min(320, Math.max(20, Math.round(Number(els.tempoInput.value) || 96))),
    measureCount: payload.measureCount || 0, partNames, totalBeats,
    tempoMarks: [], dynamicsMarks: [],
    timeSummary: `${beats}/4`, keySummary: keyOption ? keyOption.textContent : "",
    warnings: payload.warnings || [], clef: "",
    // 识谱自检结果：哪些小节的拍数和拍号对不上（最可能出错的位置），由 jianpu.py 算出。
    selfCheck: payload.selfCheck || null,
  };
}

/**
 * 识谱自检的一句话说明，拼在「音符 · 声部 · 小节」那行详情后面。
 * 自检通过 = 每小节拍数都和拍号对上；不通过就点名小节，让用户直接去核对那几处。
 */
function selfCheckSummary(scoreInfo) {
  const check = scoreInfo && scoreInfo.selfCheck;
  if (!check || !Array.isArray(check.issues)) return "";
  if (check.ok) return " · 自检通过：每小节拍数都与拍号一致";
  const numbers = check.issues.map((issue) => issue.measure).filter((value) => Number.isFinite(value));
  const preview = numbers.slice(0, 6).join("、");
  const more = numbers.length > 6 ? ` 等 ${numbers.length} 处` : "";
  return ` · ⚠ 自检：第 ${preview} 小节拍数对不上${more}，请优先核对这些位置`;
}

/** 把逐页的识谱自检结果合并成整本（小节号按前面各页的小节数累加，与 mergePageScores 一致）。 */
function mergeSelfChecks(scoreInfos) {
  const issues = [];
  let measureOffset = 0;
  for (const scoreInfo of scoreInfos) {
    if (!scoreInfo) continue;              // 识别失败的页面不占小节号
    const check = scoreInfo.selfCheck;
    if (check && Array.isArray(check.issues)) {
      for (const issue of check.issues) {
        issues.push({ ...issue, measure: (Number(issue.measure) || 0) + measureOffset });
      }
    }
    measureOffset += scoreInfo.measureCount || 0;
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 把一张页面图片交给本机简谱模块，返回与 MusicXML 解析结果同构的 scoreInfo。
 * 单页识别（recognizeJianpuScore）与整本简谱识别（recognizeAllJianpuPages）共用这一份请求逻辑。
 */
async function requestJianpuScore(blob, doMidi, beats) {
  const response = await fetch(`/api/jianpu/recognize?do=${doMidi}&beats=${beats}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 503 && payload.reason === "engine-missing") {
    throw new Error(payload.error || "本机简谱识别不可用。");
  }
  if (response.status === 503) throw new Error(payload.error || "本机识谱任务繁忙，请稍后重试。");
  if (!response.ok) throw new Error(payload.error || "简谱识别没有完成。");
  return jianpuToScoreInfo(payload, beats);
}

/**
 * 简谱（数字谱）识别：整页交给本机 jianpu.py，返回内部音符模型后转成应用既有的乐谱结构。
 * 与五线谱流程相互独立——简谱不走 Audiveris/homr，也不做谱表逐行切分。
 */
async function recognizeJianpuScore() {
  if (!state.file || !els.scoreCanvas.width || state.isRecognizing) return;
  if (jianpuAvailable === false) {
    showToast("未检测到简谱识别所需的解释器：请先安装 homr（会一并装好 opencv），或用 JIANPU_PYTHON 指定解释器。");
    return;
  }
  const beats = Number(els.jianpuBeats.value) || 4;
  const doMidi = Number(els.jianpuKey.value) || 65;
  state.isRecognizing = true;
  state.cancelRecognize = false;
  const token = ++state.recognizeToken;
  const fileToken = state.loadToken;
  const superseded = () => token !== state.recognizeToken || fileToken !== state.loadToken || state.cancelRecognize;
  stopPlayback();
  state.selection = null;
  els.processingOverlay.hidden = false;
  els.recognizeButton.disabled = true;
  els.jianpuButton.disabled = true;
  els.jianpuLabel.textContent = "正在识别简谱…";
  els.cancelRecognize.hidden = false;
  setRecognizeProgress(0, 0, "正在解析简谱版面…");
  els.scoreHint.textContent = "正在按简谱识别这一页（数字模板匹配 + 版面解析）";
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));

  try {
    const blob = await canvasToBlob();
    if (!blob) throw new Error("当前页面无法导出为图片。");
    const scoreInfo = await requestJianpuScore(blob, doMidi, beats);
    if (superseded()) return;
    if (!scoreInfo.notes.length) throw new Error("这一页没有读出简谱音符（可能不是简谱页面）。");

    commitScore(scoreInfo, [], "jianpu", { title: scoreInfo.title });
    els.scoreInfo.hidden = false;
    els.scoreDetails.textContent = `${scoreInfo.notes.length} 个音符 · ${scoreInfo.partNames.length} 个声部 · ${scoreInfo.measureCount} 小节 · ${scoreInfo.timeSummary} · ${scoreInfo.keySummary}${selfCheckSummary(scoreInfo)}`;
    els.scoreWarnings.textContent = scoreInfo.warnings.join(" ");
    els.scoreWarnings.hidden = scoreInfo.warnings.length === 0;
    // 多页简谱只识别这一页的话，试听就只有这一页 —— 明确提示用户去点「按简谱识别全部 N 页」。
    const multipageHint = state.pageCount > 1
      ? `　这只识别了第 ${state.pageNumber} 页；要整曲演奏请点「按简谱识别全部 ${state.pageCount} 页」。`
      : "";
    els.scoreHint.textContent = `简谱识别完成：${scoreInfo.notes.length} 个音符 · ${scoreInfo.partNames.length} 个声部 · ${scoreInfo.measureCount} 小节${multipageHint}`;
    const warning = scoreInfo.warnings[0] ? ` ${scoreInfo.warnings[0]}` : "";
    showToast(`简谱识别到 ${scoreInfo.notes.length} 个音符（${scoreInfo.partNames.length} 个声部），请逐音校对。${warning}${multipageHint}`);
  } catch (error) {
    if (superseded()) return;
    console.error(error);
    // 与五线谱流程一致：识别失败时清掉上一次结果，避免旧音符被当作本次结果试听/导出。
    state.notes = [];
    state.scoreInfo = null;
    state.recognitionSource = null;
    state.staffBoxes = null;
    state.scorePage = null;
    state.recognized = false;
    renderNotes();
    updatePartControls(true);
    clearOverlay();
    updateRecognitionBanner();
    const message = error && error.message ? error.message : "简谱识别时遇到问题，请换一张更清晰的图片再试。";
    showToast(message);
    els.scoreHint.textContent = "简谱识别失败，已清空上一次的结果 · " + message;
  } finally {
    state.isRecognizing = false;
    els.processingOverlay.hidden = true;
    els.cancelRecognize.hidden = true;
    setRecognizeProgress(0, 0, "");
    els.recognizeProgress.hidden = true;
    if (fileToken === state.loadToken) {
      els.recognizeButton.disabled = !state.file;
      els.jianpuButton.disabled = false;
      els.jianpuLabel.textContent = "按简谱识别这一页";
    }
  }
}

/** 多页时显示「整本识别」按钮（五线谱与简谱各一个），单页/图片/简谱不可用时隐藏。 */
function updateBatchButtons() {
  const multi = Boolean(state.file && state.pdf && state.pageCount > 1);
  els.recognizeAllButton.hidden = !multi;
  els.recognizeAllLabel.textContent = `识别全部 ${state.pageCount} 页`;
  els.recognizeAllButton.disabled = false;
  els.jianpuAllButton.hidden = !(multi && jianpuAvailable !== false);
  els.jianpuAllLabel.textContent = `按简谱识别全部 ${state.pageCount} 页`;
  els.jianpuAllButton.disabled = false;
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
  prepareAudio();          // 声卡初始化要 600ms 左右，趁"载入文件"这段本来就忙的时候做掉
  stopPlayback();
  await destroyPdf();
  disposePartBuses();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  const token = ++state.loadToken;
  state.file = file;
  // PDF 交给 pdf.js 直接读 ArrayBuffer，MusicXML 在浏览器内解析，两者都不需要 blob URL。
  state.objectUrl = (isPdf || isMusicXml) ? null : URL.createObjectURL(file);
  state.pageNumber = 1;
  state.pageCount = 1;
  state.image = null;
  state.lowResPdf = null;
  state.timeSignatureHint = "";
  state.partOctaves = new Map();
  clearScore();
  els.clefSelect.disabled = isMusicXml;
  els.jianpuField.hidden = true;   // 简谱设置只在图片/PDF 页面上出现，MusicXML 不需要
  els.fileName.textContent = file.name;
  els.fileInfo.textContent = (isMusicXml ? "MusicXML 乐谱" : isPdf ? "PDF 文档" : "图片文件") + " · " + formatSize(file.size);
  els.currentFile.hidden = false;
  els.recognizeButton.disabled = true;
  els.recognizeLabel.textContent = "正在载入…";
  updateBatchButtons();
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
      state.scorePage = null;   // 符号乐谱没有谱面坐标，不画点
      updatePartControls(true);
      state.recognized = false;
      state.pageCount = 1;
      els.canvasWrap.hidden = true;
      els.emptyState.hidden = true;
      els.scoreInfo.hidden = false;
      els.staffSelectField.hidden = true;
      els.scoreTitle.textContent = scoreInfo.title;
      els.scoreDetails.textContent = `${scoreInfo.notes.length} 个音符 · ${scoreInfo.partNames.length} 个声部 · ${scoreInfo.measureCount} 小节 · ${scoreInfo.timeSummary} · ${scoreInfo.keySummary}${scoreInfo.tempoDetected ? " · ♩=" + Math.round(scoreInfo.tempo) : ""}${selfCheckSummary(scoreInfo)}`;
      els.scoreWarnings.textContent = scoreInfo.warnings.join(" ");
      els.scoreWarnings.hidden = scoreInfo.warnings.length === 0;
      applyDetectedTempo(scoreInfo);
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
    els.jianpuField.hidden = false;
    els.jianpuButton.hidden = jianpuAvailable === false;
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
  state.image = image;   // 识谱时用原图重新缩放到更清晰的分辨率（见 omrPageBlob）
  els.fileInfo.textContent = "图片文件 · " + formatSize(file.size) + " · " + image.naturalWidth + " × " + image.naturalHeight;
}
async function loadPdf(file, token) {
  let pdfjs;
  try {
    // pdf.js 已随项目本地分发（vendor/pdfjs），离线可用，不再依赖 CDN。
    pdfjs = await import("./vendor/pdfjs/pdf.mjs");
  } catch {
    throw new Error("PDF 阅读组件载入失败（vendor/pdfjs 缺失或被拦截）。可将 PDF 页面另存为图片后再导入。");
  }
  if (token !== state.loadToken) return;
  pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";
  const pdfBytes = await file.arrayBuffer();
  state.pdfBytes = pdfBytes;   // 速度 OCR 读 PDF 文字层要用
  // 注意：pdf.js 会接管（detach）传进去的 ArrayBuffer，之后不能再读；
  // 分辨率检测要用原始字节，所以给它一份副本。
  const document = await pdfjs.getDocument({ data: pdfBytes.slice(0) }).promise;
  if (token !== state.loadToken) {
    try { await document.destroy(); } catch { /* 已被取代，尽力释放即可 */ }
    return;
  }
  state.pdf = document;
  state.pageCount = document.numPages;
  // 图片型（扫描/截图）PDF：先量一下每页位图的有效分辨率，太低就提前提醒用户。
  state.lowResPdf = detectLowResolutionPdf(pdfBytes, state.pageCount);
  if (state.lowResPdf) {
    showToast(`这份 PDF 是「图片型」文档：每页只是一张约 ${state.lowResPdf.dpi} DPI 的位图，谱面字号很小，识别准确率会明显下降。想更准请换 300 DPI 以上的清晰扫描件或矢量 PDF。`);
  }
  els.pageControls.hidden = state.pageCount <= 1;
  await renderPdfPage(1, token);
  if (token !== state.loadToken) return;
  // 多页 PDF 才提供"整本识别"：五线谱走 recognizeAllPages，简谱走 recognizeAllJianpuPages，
  // 一次操作把整本谱识别并跨页拼成一份连续乐谱（否则单页识别只会替换当前结果）。
  updateBatchButtons();
}
/**
 * 判断这份 PDF 是不是「图片型」文档、以及每页位图的有效分辨率。
 *
 * 为什么要在意：有些 PDF 每页只是一张位图（扫描件、截图、手机导出的谱）。pdf.js 渲染时
 * 只能把它放大——放大不会长出细节，而 OMR 引擎（Audiveris）恰恰对字号/线宽很敏感。
 * 实测一份 154 DPI 的合唱缩编谱：读出的「4 拍小节」只占 14%；正常扫描件（300 DPI）不会这样。
 * 明确告诉用户「是源文件分辨率不够」，比让用户以为识别功能坏了更有用。
 *
 * 做法：直接看 PDF 字节里的图片对象（/Subtype /Image 的 /Width、/Height）和页面尺寸
 * （/MediaBox），估算 DPI。对象流压缩过的 PDF 找不到这些关键字就返回 null（宁可不说，也不误报）。
 */
function detectLowResolutionPdf(bytes, pageCount) {
  try {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const text = new TextDecoder("latin1").decode(data);
    const images = [];
    const marker = /\/Subtype\s*\/Image/g;
    let matched;
    while ((matched = marker.exec(text)) && images.length < 64) {
      const slice = text.slice(matched.index, matched.index + 800);
      const width = /\/Width\s+(\d+)/.exec(slice);
      const height = /\/Height\s+(\d+)/.exec(slice);
      if (width && height) images.push({ width: Number(width[1]), height: Number(height[1]) });
    }
    // 不是「每页一张图」的版式（例如矢量谱 + 个别装饰图），不在这一条里判断。
    if (images.length < pageCount) return null;
    if (/\/Font/.test(text)) return null;
    const mediaBox = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(text);
    if (!mediaBox) return null;
    const pageWidthPt = Math.abs(Number(mediaBox[3]) - Number(mediaBox[1]));
    const pageHeightPt = Math.abs(Number(mediaBox[4]) - Number(mediaBox[2]));
    if (!(pageWidthPt > 0 && pageHeightPt > 0)) return null;
    const dpis = images
      .map((image) => Math.max(image.width / (pageWidthPt / 72), image.height / (pageHeightPt / 72)))
      .sort((a, b) => a - b);
    const dpi = dpis[Math.floor(dpis.length / 2)];
    return dpi > 0 && dpi < 220 ? { dpi: Math.round(dpi), pages: images.length } : null;
  } catch (error) {
    console.info("PDF 分辨率检测跳过：", error);
    return null;
  }
}

/**
 * 渲染一页「给速度 OCR 用」的高清图（3 倍 + 轻度锐化）。
 *
 * 为什么不用 OMR 图：实测《在山魔王的宫殿》第 1 页 5 处速度标记，
 * OMR 图（2970×4200）只能检出 2 个等号；3 倍显示图（约 3676×5200）5 处全部检出、
 * 数字也全部读对。速度记号是普通文字，比五线谱符号更依赖分辨率。
 */
async function tempoPageBlob(number, token) {
  if (!state.pdf) return null;
  try {
    const page = await state.pdf.getPage(number);
    if (token !== state.loadToken) return null;
    const scale = 3;
    const canvas = await renderPdfPageCanvas(page, scale, token);
    if (!canvas) return null;
    return canvasToBlob(canvas, "image/png", 1);
  } catch (error) {
    console.info("速度 OCR 渲染失败：", error);
    return null;
  }
}

/**
 * 把 PDF 的某一页渲染到离屏画布（显示与识谱共用）。
 * @param {object} page pdf.js 的 page 对象
 * @param {number} scale 渲染倍率
 */
async function renderPdfPageCanvas(page, scale, token) {
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const context = offscreen.getContext("2d", { willReadFrequently: true });
  // 高分辨率整页渲染时开启高质量平滑：位图型 PDF 放大后边缘更干净，利于二值化。
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  await page.render({ canvasContext: context, viewport }).promise;
  if (token !== state.loadToken) return null;
  return offscreen;
}

/**
 * 轻度锐化（unsharp mask）：把放大后发虚的谱线/符头边缘提回来。
 *
 * 为什么不自己写高斯卷积：canvas 自带的 `filter = "blur(2.2px)"` 由浏览器原生实现，
 * 比逐像素卷积快得多（12MP 页面约 0.2 秒）；这里只做一次逐像素的 unsharp 合成：
 *   out = gray + amount * (gray - blur)，差值小于 threshold 的视为纸面噪点、不放大。
 * 实测（《有我》p2）：同样的 Audiveris，锐化后「4 拍小节」从 43% 提到 86%。
 */
function sharpenCanvas(canvas, { amount = 1.3, threshold = 4, blurPx = 2.2 } = {}) {
  const width = canvas.width, height = canvas.height;
  if (!width || !height) return canvas;
  const blurred = document.createElement("canvas");
  blurred.width = width;
  blurred.height = height;
  const blurredContext = blurred.getContext("2d");
  blurredContext.fillStyle = "#fff";
  blurredContext.fillRect(0, 0, width, height);
  blurredContext.filter = `blur(${blurPx}px)`;
  blurredContext.drawImage(canvas, 0, 0);
  blurredContext.filter = "none";
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const source = context.getImageData(0, 0, width, height);
  const blurData = blurredContext.getImageData(0, 0, width, height);
  const pixels = source.data;
  const blur = blurData.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const gray = (pixels[index] * 299 + pixels[index + 1] * 587 + pixels[index + 2] * 114) / 1000;
    const blurGray = (blur[index] * 299 + blur[index + 1] * 587 + blur[index + 2] * 114) / 1000;
    const diff = gray - blurGray;
    let value = Math.abs(diff) >= threshold ? gray + amount * diff : gray;
    value = value < 0 ? 0 : value > 255 ? 255 : value;
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
    pixels[index + 3] = 255;
  }
  context.putImageData(source, 0, 0);
  return canvas;
}

/**
 * 识谱用的整页图片：分辨率比显示画面高得多（见 OMR_RENDER_SCALE），并且用 PNG 无损。
 *
 * 为什么不能直接用显示画布：显示画布长边只有 2600px，缩编谱的符头只有几个像素；
 * 而且显示画布导出的是 JPEG（0.92），小音符上的压缩噪点会让引擎认错符头/符干。
 * 实测这份文件（《有我》）：JPEG 2600px 时第 1 页连拍号都读丢；PNG + 4.5× 后拍号、8vb 谱号都能读对。
 */
async function omrPageBlob(number, token = state.loadToken) {
  if (state.pdf) {
    const page = await state.pdf.getPage(Math.max(1, Math.min(number, state.pageCount)));
    const base = page.getViewport({ scale: 1 });
    // 图片型低清 PDF：放大渲染（见常量处的实测）；正常 PDF：保持原像素量、只换 PNG。
    const scale = state.lowResPdf
      ? Math.min(OMR_RENDER_SCALE, OMR_MAX_LONG_EDGE / Math.max(base.width, base.height))
      : Math.min(OMR_VECTOR_MAX_SCALE, OMR_VECTOR_LONG_EDGE / Math.max(base.width, base.height));
    let canvas = await renderPdfPageCanvas(page, scale, token);
    // 图片型低清 PDF：放大后锐化——但第 1 页不锐化。
    // 因为谱面的速度标记（♩ = 66）只印在第 1 页、要靠 OCR 读出来，而锐化会让 OCR 读丢它；
    // 后面的页没有速度标记，锐化只会让符头/符干更清楚（实测 p2 43%→86%、p5 25%→96% 的「4 拍小节」占比）。
    if (canvas && state.lowResPdf && number > 1) canvas = sharpenCanvas(canvas);
    return canvas ? canvasToBlob(canvas, "image/png") : null;
  }
  if (state.image) {
    // 图片文件：用原图重新缩放（放大到约 OMR_TARGET_LONG_EDGE；特别大的图缩到上限），
    // 而不是用缩到 2600px 的显示画布。
    const longEdge = Math.max(state.image.naturalWidth, state.image.naturalHeight);
    const scale = Math.min(2.5, OMR_TARGET_LONG_EDGE / Math.max(1, longEdge));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(state.image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(state.image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(state.image, 0, 0, canvas.width, canvas.height);
    // 图片只有一页：用较轻的锐化，兼顾音符识别与「谱面速度文字」的 OCR。
    return canvasToBlob(sharpenCanvas(canvas, { amount: 1.0 }), "image/png");
  }
  return canvasToBlob(els.scoreCanvas, "image/png");
}

async function renderPdfPage(number, token = state.loadToken) {
  if (!state.pdf) return;
  const targetPage = Math.max(1, Math.min(number, state.pageCount));
  state.pageNumber = targetPage;
  const renderToken = ++state.renderToken;
  const page = await state.pdf.getPage(targetPage);
  const base = page.getViewport({ scale: 1 });
  // 显示只需要 2600px 长边（CSS 再缩放）；识谱另走 omrPageBlob 的高分辨率渲染。
  const scale = Math.min(3.8, 2600 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  if (renderToken !== state.renderToken || token !== state.loadToken) return;
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  // 先渲染到离屏画布，再把最终结果贴到可见画布：这样连点翻页时不会对同一画布并发调用 render()。
  const offscreen = await renderPdfPageCanvas(page, scale, token);
  if (!offscreen) return;
  if (renderToken !== state.renderToken || token !== state.loadToken) return;
  setCanvasSize(width, height);
  const ctx = els.scoreCanvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(offscreen, 0, 0);
  els.pageLabel.textContent = targetPage + " / " + state.pageCount;
  els.prevPage.disabled = targetPage <= 1;
  els.nextPage.disabled = targetPage >= state.pageCount;
  refreshScoreOverlay();
}
function removeCurrentFile() {
  stopPlayback();
  disposePartBuses();
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
  updateBatchButtons();
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
/**
 * 画（或取）谱面叠加层的「静态底图」：谱表框 + 每个音符的小圆点。
 *
 * 为什么单独缓存：OMR 识别出来的大谱有几千个带坐标的音符，原来鼠标在音符列表上
 * 每移动一行就把这几千个圆点整个重画一遍，单次几十毫秒——用户感受到的就是「卡」。
 * 底图只在「音符集合变了（renderNotes）/ 谱表框变了 / 画布尺寸变了」时才重画，
 * 悬停和点选只做一次 drawImage + 画当前高亮，单次降到 1–2 毫秒。
 */
function overlayBaseCanvas(notes, boxes) {
  const signature = state.overlayEpoch + "|" + notes.length + "|"
    + (boxes ? boxes.length : 0) + "|" + els.overlayCanvas.width + "x" + els.overlayCanvas.height;
  if (state.overlayBase && state.overlayBaseSignature === signature) return state.overlayBase;
  const canvas = document.createElement("canvas");
  canvas.width = els.overlayCanvas.width;
  canvas.height = els.overlayCanvas.height;
  const ctx = canvas.getContext("2d");
  // 多行谱表时把每行谱表的识别区域画出来，便于确认切分是否正确。
  if (boxes && boxes.length > 1) {
    boxes.forEach((staff) => {
      const left = Number.isFinite(staff.left) ? staff.left : 0;
      const right = Number.isFinite(staff.right) ? staff.right : canvas.width;
      ctx.beginPath();
      ctx.rect(left, staff.top - 3, right - left, staff.bottom - staff.top + 6);
      ctx.fillStyle = "rgba(71, 113, 93, .035)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(71, 113, 93, .16)";
      ctx.stroke();
    });
  }
  // 音符的纵坐标可以由音高精确推算（横坐标不能，所以不画点），
  // 例外：简谱/图片识别会回传音符在页面上的真实像素坐标，这类音符直接画点。
  for (const note of notes) {
    if (!Number.isFinite(note.x) || !Number.isFinite(note.y)) continue;
    ctx.beginPath();
    ctx.arc(note.x, note.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(71, 113, 93, .55)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(note.x, note.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(120, 167, 132, .19)";
    ctx.fill();
    ctx.lineWidth = 1.7;
    ctx.strokeStyle = "rgba(67, 117, 79, .82)";
    ctx.stroke();
  }
  state.overlayBase = canvas;
  state.overlayBaseSignature = signature;
  return canvas;
}

function drawNoteOverlay(notes, focusedNoteId = null, staffBoxes = null) {
  const ctx = els.overlayCanvas.getContext("2d");
  const boxes = staffBoxes || state.staffBoxes;
  const focusedNote = focusedNoteId ? notes.find((note) => note.id === focusedNoteId) : null;
  // 底图（几千个点）直接贴上来；没有聚焦时到这里就结束了
  clearOverlay();
  ctx.drawImage(overlayBaseCanvas(notes, boxes), 0, 0);
  if (!focusedNote) return;
  const focusedStaff = boxes ? boxes[focusedNote.staffIndex] : null;
  // 当前音符：高亮圈
  if (Number.isFinite(focusedNote.x) && Number.isFinite(focusedNote.y)) {
    ctx.beginPath();
    ctx.arc(focusedNote.x, focusedNote.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(220, 145, 103, .35)";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(180, 92, 55, .95)";
    ctx.stroke();
  }
  // 当前谱表：整行加亮
  if (focusedStaff) {
    const left = Number.isFinite(focusedStaff.left) ? focusedStaff.left : 0;
    const right = Number.isFinite(focusedStaff.right) ? focusedStaff.right : els.overlayCanvas.width;
    ctx.beginPath();
    ctx.rect(left, focusedStaff.top - 3, right - left, focusedStaff.bottom - focusedStaff.top + 6);
    ctx.fillStyle = "rgba(71, 113, 93, .10)";
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "rgba(71, 113, 93, .55)";
    ctx.stroke();
  }
  // 音高基准线（横坐标不可靠，只画纵坐标线帮助对准谱表）
  if (focusedStaff && focusedNote.pitch) {
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
}
/**
 * 按「当前显示的是哪一页」重画（或清掉）谱面上的音符点。
 *
 * 识别结果只与它被识别时的那一页（state.scorePage）坐标对应：
 * 翻页到别的页时**结果仍然保留**（可继续试听、导出、校对），只是不画坐标点，
 * 因为谱表几何 / 简谱像素坐标都只对那一页有效。整本合并结果与 MusicXML 没有单页坐标，传 null。
 */
function refreshScoreOverlay() {
  if (state.notes.length && state.scorePage !== null && state.scorePage === state.pageNumber) {
    drawNoteOverlay(state.notes, null, state.staffBoxes);
  } else {
    clearOverlay();
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
/**
 * 把一个音符建成可编辑的一行（音高 / 起拍 / 时值 / 删除）。
 *
 * 性能关键（8419 音的谱实测，整表重绘 732 ms → 约 100 ms）：
 *   · 不给每行挂 8 个事件监听，改成整个列表一套事件委托（见 installNoteListDelegation）：
 *     8419 行 × 8 = 6.7 万个监听，单是挂监听就要约 0.4 秒；
 *   · 时值不再用「每行一个 19 项 <select>」：19 个 option × 8419 行 = 16 万个 DOM 节点，
 *     单是建这些节点就占了大半渲染时间。改成轻量按钮 + 全局共用的弹出菜单。
 */
function buildNoteRow(note, index) {
  const row = document.createElement("div");
  row.className = "note-row";
  if (isLowConfidence(note)) row.classList.add("is-low-confidence");
  row.hidden = state.onlyLowConfidence && !isLowConfidence(note);
  row.dataset.noteId = note.id;
  row.dataset.eventId = String(note.eventId);
  row.dataset.partKey = voiceIdentity(note);
  const rowParts = [note.partName, note.voice ? `声部 ${note.voice}` : ""].filter(Boolean).join(" · ");
  const confidenceText = isLowConfidence(note) ? ` · 置信度偏低（${note.confidence.toFixed(2)}），建议校对` : "";
  row.title = rowParts + confidenceText;
  const indexLabel = document.createElement("span");
  indexLabel.className = "note-index";
  indexLabel.textContent = String(index + 1).padStart(2, "0");
  indexLabel.tabIndex = 0;
  indexLabel.setAttribute("role", "button");
  indexLabel.title = "点击设为选区起点，Shift+点击设为终点";
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
  const durationButton = document.createElement("button");
  durationButton.className = "note-duration";
  durationButton.type = "button";
  durationButton.dataset.duration = note.duration;
  durationButton.textContent = durationLabelFor(note);
  durationButton.setAttribute("aria-label", "音符时值");
  durationButton.title = "点击选择时值";
  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-note";
  deleteButton.type = "button";
  deleteButton.title = "删除音符";
  deleteButton.setAttribute("aria-label", "删除音符");
  deleteButton.textContent = "×";
  row.append(indexLabel, input, startInput, durationButton, deleteButton);
  if (state.noteRowById) state.noteRowById.set(note.id, row);
  return row;
}

/** 时值按钮上显示的文字；自定义时值显示「原值 X 拍」。 */
function durationLabelFor(note) {
  if (note.duration !== "custom") {
    const found = durations.find((entry) => entry[0] === note.duration);
    if (found) return found[1];
  }
  return `原值 ${formatBeatCount(beatsForNote(note))} 拍`;
}

/** 从行列里的任意子元素找到它所属的音符对象（事件委托用）。 */
function noteFromRowElement(element) {
  const row = element && element.closest ? element.closest(".note-row") : null;
  if (!row || !state.noteById) return null;
  return state.noteById.get(row.dataset.noteId) || null;
}

/** 点音符设置选区（原点击行 / 点序号的行为，保持不变）。 */
function applyNoteSelection(note, extend) {
  state.selection = extend && state.selection
    ? { anchorId: state.selection.anchorId, focusId: note.id }
    : { anchorId: note.id, focusId: note.id };
  markSelectedRows();
  updateSelectionUi();
}

/**
 * 整个音符列表只挂一套事件监听（而不是每行 8 个）。
 * 行里的控件用 class / data-* 区分，音符对象通过 state.noteById 查。
 */
function installNoteListDelegation() {
  if (state.noteListDelegated || !els.noteList) return;
  state.noteListDelegated = true;
  els.noteList.addEventListener("click", (event) => {
    const row = event.target.closest(".note-row");
    if (!row) return;
    const note = noteFromRowElement(row);
    if (!note) return;
    if (event.target.closest(".delete-note")) {
      state.notes = state.notes.filter((item) => item.id !== note.id);
      renderNotes();
      updatePartControls();
      refreshScoreOverlay();
      return;
    }
    if (event.target.closest(".note-duration")) {
      openDurationMenu(event.target.closest(".note-duration"), note);
      return;
    }
    // 输入框 / 其它按钮自己有交互，不当作"设选区"
    if (event.target.closest("input, button, select")) return;
    applyNoteSelection(note, event.shiftKey);
  });
  els.noteList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const indexLabel = event.target.closest(".note-index");
    if (!indexLabel) return;
    const note = noteFromRowElement(indexLabel);
    if (!note) return;
    event.preventDefault();
    applyNoteSelection(note, event.shiftKey);
  });
  els.noteList.addEventListener("change", (event) => {
    const input = event.target;
    if (input.classList.contains("note-pitch")) {
      const note = noteFromRowElement(input);
      if (!note) return;
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
      return;
    }
    if (input.classList.contains("note-onset")) {
      const note = noteFromRowElement(input);
      if (!note) return;
      const rawStartBeat = input.value.trim();
      const startBeat = Number(rawStartBeat);
      if (!rawStartBeat || !Number.isFinite(startBeat) || startBeat < 0) {
        input.setCustomValidity("起拍需要是大于或等于 0 的数字。");
        input.reportValidity();
        input.value = formatBeatCount(Number(note.startBeat) || 0);
        input.setCustomValidity("");
        return;
      }
      note.startBeat = startBeat;
      updatePlaybackReady();
    }
  });
  els.noteList.addEventListener("focusin", (event) => {
    const note = noteFromRowElement(event.target);
    if (note) drawNoteOverlay(state.notes, note.id);
  });
  els.noteList.addEventListener("focusout", () => {
    state.hoverRow = null;
    drawNoteOverlay(state.notes);
  });
  els.noteList.addEventListener("mouseover", (event) => {
    const row = event.target.closest(".note-row");
    if (!row || row === state.hoverRow) return;
    state.hoverRow = row;
    const note = noteFromRowElement(row);
    if (note) drawNoteOverlay(state.notes, note.id);
  });
  els.noteList.addEventListener("mouseout", (event) => {
    const row = event.target.closest(".note-row");
    if (!row || row !== state.hoverRow) return;
    const next = event.relatedTarget && event.relatedTarget.closest
      ? event.relatedTarget.closest(".note-row")
      : null;
    if (next === row) return;
    state.hoverRow = null;
    drawNoteOverlay(state.notes);
  });
  // 菜单是 fixed 定位的：列表一滚动或窗口一改大小就收起来，避免飘在错的地方。
  els.noteList.addEventListener("scroll", closeDurationMenu, { passive: true });
  window.addEventListener("resize", closeDurationMenu);
}

/** 建（或取）全局唯一的时值选择菜单。19 个选项只建一次，所有行共用。 */
function ensureDurationMenu() {
  if (state.durationMenu) return state.durationMenu;
  const menu = document.createElement("div");
  menu.className = "duration-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  for (const [value, label] of durations) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "duration-menu-item";
    item.dataset.duration = value;
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    menu.append(item);
  }
  const custom = document.createElement("button");
  custom.type = "button";
  custom.className = "duration-menu-item";
  custom.dataset.duration = "custom";
  custom.setAttribute("role", "menuitem");
  custom.hidden = true;   // 只有当前音符本来就是「自定义时值」时才显示
  menu.append(custom);
  menu.addEventListener("click", (event) => {
    const item = event.target.closest(".duration-menu-item");
    const note = state.durationMenuNote;
    if (!item || !note) return;
    closeDurationMenu();
    applyNoteDuration(note, item.dataset.duration);
  });
  // 点菜单外面就关（capture 阶段，先于其它 click 处理）
  document.addEventListener("pointerdown", (event) => {
    if (!state.durationMenu || state.durationMenu.hidden) return;
    if (state.durationMenu.contains(event.target)) return;
    if (event.target.closest && event.target.closest(".note-duration")) return;
    closeDurationMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDurationMenu();
  });
  document.body.append(menu);
  state.durationMenu = menu;
  return menu;
}

/** 在某个时值按钮旁边弹出菜单。 */
function openDurationMenu(button, note) {
  const menu = ensureDurationMenu();
  state.durationMenuNote = note;
  const custom = menu.querySelector('[data-duration="custom"]');
  if (custom) {
    custom.hidden = note.duration !== "custom";
    if (!custom.hidden) custom.textContent = durationLabelFor(note);
  }
  for (const item of menu.children) {
    item.classList.toggle("is-active", item.dataset.duration === note.duration);
  }
  menu.hidden = false;
  const rect = button.getBoundingClientRect();
  const menuHeight = menu.offsetHeight;
  const menuWidth = menu.offsetWidth;
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow >= menuHeight + 8 ? rect.bottom + 4 : Math.max(8, rect.top - menuHeight - 4);
  const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.left - 40));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function closeDurationMenu() {
  if (!state.durationMenu || state.durationMenu.hidden) return;
  state.durationMenu.hidden = true;
  state.durationMenuNote = null;
}

/** 应用时值：只改音符模型和这一行的按钮文字，不重绘整表。 */
function applyNoteDuration(note, value) {
  note.duration = value;
  if (durationBeats[value]) note.durationBeats = durationBeats[value];
  const row = state.noteRowById && state.noteRowById.get(note.id);
  const button = row && row.querySelector(".note-duration");
  if (button) {
    button.dataset.duration = value;
    button.textContent = durationLabelFor(note);
  }
}

/** 一个「小节 × 声部」块；entries 形如 [{note, index}]。 */
function buildVoiceBlock(name, entries) {
  const block = document.createElement("div");
  block.className = "measure-voice";
  const label = document.createElement("div");
  label.className = "measure-voice-name";
  label.textContent = `${name} · ${entries.length} 个音`;
  block.append(label);
  for (const entry of entries) block.append(buildNoteRow(entry.note, entry.index));
  return block;
}

/** 小节序号（0 起）：优先用 MusicXML 的小节号，其次 measureIndex，最后按拍数推算。 */
function measureIndexForNote(note, beatsPerMeasure) {
  const measureNumber = Number(note.measure);
  const explicit = Number(note.measureIndex);
  if (note.measure !== undefined && note.measure !== null && note.measure !== "" && Number.isFinite(measureNumber)) {
    return Math.max(0, Math.floor(measureNumber - 1));
  }
  if (note.measureIndex !== undefined && note.measureIndex !== null && Number.isFinite(explicit)) {
    return Math.max(0, Math.floor(explicit));
  }
  return Math.floor((Number(note.startBeat) || 0) / beatsPerMeasure + 1e-6);
}

/** 只刷新某个声部的音高文本框（切八度用）：8419 音的谱全表重绘约 730 ms，这里约 3 ms。 */
function updatePartPitchRows(partKey) {
  if (!state.noteRowById || !state.noteRowById.size) {
    renderNotes();
    return;
  }
  const part = String(partKey);
  let missing = false;
  for (const note of state.notes) {
    if (voiceIdentity(note) !== part) continue;
    const row = state.noteRowById.get(note.id);
    if (!row) { missing = true; continue; }
    const input = row.querySelector(".note-pitch");
    if (input) input.value = note.pitch;
  }
  if (missing) renderNotes();
}

/**
 * 复制声部后只把新声部的行插进已有小节，不重绘整张表。
 *
 * 8419 音的谱全表重绘约 730 ms；复制一个 2112 音的声部只需要建 2112 行（约 30 ms）。
 * 新块追加在每小节末尾（声部面板里仍按名字排序，不影响使用）。
 */
function appendPartNoteRows(partKey, newNotes) {
  if (!newNotes.length || !state.noteById || !els.noteList.querySelector(".measure-group")) {
    renderNotes();
    return;
  }
  const per = beatsPerMeasureFromSummary(state.scoreInfo && state.scoreInfo.timeSummary);
  const baseIndex = state.notes.length - newNotes.length;   // 新音符都在数组末尾
  const byMeasure = new Map();
  for (let offset = 0; offset < newNotes.length; offset += 1) {
    const note = newNotes[offset];
    const measureIndex = measureIndexForNote(note, per);
    if (!byMeasure.has(measureIndex)) byMeasure.set(measureIndex, []);
    byMeasure.get(measureIndex).push({ note, index: baseIndex + offset });
  }
  const name = partDisplayName(partKey, newNotes[0].partName || "旋律");
  let appended = 0;
  for (const [measureIndex, entries] of byMeasure) {
    const group = (state.measureGroups && state.measureGroups.get(measureIndex))
      || els.noteList.querySelector(`.measure-group[data-measure="${measureIndex + 1}"]`);
    if (!group) continue;
    entries.sort((left, right) => (Number(left.note.startBeat) || 0) - (Number(right.note.startBeat) || 0));
    group.append(buildVoiceBlock(name, entries));
    const meta = group.querySelector(".measure-head span");
    if (meta) {
      const current = Number(String(meta.textContent).replace(/[^\d]/g, "")) || 0;
      meta.textContent = `${current + entries.length} 个音`;
    }
    appended += entries.length;
  }
  for (const note of newNotes) state.noteById.set(note.id, note);
  if (!appended) renderNotes();   // 一个都没插进去（结构意外）就退回全量重绘
}

/**
 * 把音符按「小节 → 声部」分组。
 *
 * 用户要的是「左边第几小节，右边这个小节里从上到下的几个声部」，
 * 而不是一长条按时间排列、找一句要翻半天的平铺列表。
 */
function groupNotesByMeasure() {
  const per = beatsPerMeasureFromSummary(state.scoreInfo && state.scoreInfo.timeSummary);
  const measures = new Map();
  state.notes.forEach((note, index) => {
    // measure（跨页合并时已经按前面各页小节数累加）最可靠；
    // 直接用 measureIndex 的话，第 2 页的音会和第 1 页撞在同一小节里。
    const measureIndex = measureIndexForNote(note, per);
    if (!measures.has(measureIndex)) measures.set(measureIndex, new Map());
    const voices = measures.get(measureIndex);
    const key = voiceIdentity(note);
    if (!voices.has(key)) {
      voices.set(key, { key, name: partDisplayName(key, note.partName || "旋律"), items: [] });
    }
    voices.get(key).items.push({ note, index });
  });
  return [...measures.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([measureIndex, voices]) => {
      const list = [...voices.values()]
        .sort((left, right) => {
          const [leftHead, leftNumber] = partSortKey(left.key);
          const [rightHead, rightNumber] = partSortKey(right.key);
          return leftHead.localeCompare(rightHead) || leftNumber - rightNumber;
        })
        .map((voice) => ({
          ...voice,
          items: voice.items.sort((left, right) => (Number(left.note.startBeat) || 0) - (Number(right.note.startBeat) || 0)),
        }));
      return {
        measureIndex,
        voices: list,
        count: list.reduce((sum, voice) => sum + voice.items.length, 0),
      };
    });
}

function renderNotes() {
  els.noteList.replaceChildren();
  installNoteListDelegation();
  // 行索引 & 音符索引：事件委托靠它从 DOM 找回音符对象。
  state.noteRowById = new Map();
  state.noteById = new Map();
  state.overlayEpoch += 1;   // 音符集合变了：谱面叠加层底图作废
  state.overlayBase = null;
  for (const note of state.notes) state.noteById.set(note.id, note);
  state.measureGroups = new Map();
  state.hoverRow = null;
  if (!state.notes.length) {
    els.notesEmpty.hidden = false;
    els.noteList.append(els.notesEmpty);
  } else {
    els.notesEmpty.hidden = true;
    const measures = groupNotesByMeasure();
    // 先攒在 DocumentFragment 里一次插入：8419 行时比分多次 append 少很多重排。
    const fragment = document.createDocumentFragment();
    for (const measure of measures) {
      const group = document.createElement("section");
      group.className = "measure-group";
      group.dataset.measure = String(measure.measureIndex + 1);
      const head = document.createElement("div");
      head.className = "measure-head";
      const title = document.createElement("strong");
      title.textContent = `第 ${measure.measureIndex + 1} 小节`;
      const meta = document.createElement("span");
      meta.textContent = `${measure.count} 个音`;
      head.append(title, meta);
      group.append(head);
      for (const voice of measure.voices) group.append(buildVoiceBlock(voice.name, voice.items));
      group.hidden = Boolean(state.onlyLowConfidence) && !group.querySelector(".note-row:not([hidden])");
      state.measureGroups.set(measure.measureIndex, group);
      fragment.append(group);
    }
    els.noteList.append(fragment);
    if (els.measureJumpInput) els.measureJumpInput.max = String(measures.length ? measures[measures.length - 1].measureIndex + 1 : 1);
  }
  els.lowConfidenceButton.hidden = !hasLowConfidenceNotes();
  // 只有带谱面坐标的结果（图片路径）才有 overlay 圆点；MusicXML 导入没有坐标，别显示误导性的图例。
  els.scoreLegend.hidden = !state.notes.some((note) => Number.isFinite(note.x) && Number.isFinite(note.y));
  markSelectedRows();
  updateSelectionUi();
}

/** 在音符列表里跳到第 index 小节（1 起），并短暂高亮小节标题。 */
function jumpToMeasureInList(index) {
  const target = Math.max(1, Math.floor(Number(index) || 1));
  const group = els.noteList.querySelector(`.measure-group[data-measure="${target}"]`);
  if (!group) {
    showToast(`没有找到第 ${target} 小节。`);
    return;
  }
  const listBox = els.noteList.getBoundingClientRect();
  const groupBox = group.getBoundingClientRect();
  els.noteList.scrollTop += groupBox.top - listBox.top - 2;
  group.classList.add("is-highlight");
  clearTimeout(state.measureHighlightTimer);
  state.measureHighlightTimer = setTimeout(() => group.classList.remove("is-highlight"), 1400);
}
// 常用声部名预设：零乐理用户不用自己打字，点一下就能把「声部1」改成谱面上的叫法。
const PART_NAME_PRESETS = [
  "女高1", "女高2", "女中", "男高", "男中", "男低", "女声", "男声",
  "童声", "独唱", "领唱", "合唱", "钢琴", "伴奏", "旋律",
  "SOPRANO", "ALTO", "TENOR", "BASS", "PIANO",
];
const PART_NAME_CUSTOM = "自定义…";
// 判定一个声部是不是钢琴伴奏：识别结果里钢琴声部的名字通常是 Piano/钢琴。
const looksLikePiano = (name) => /piano|钢琴|伴奏/i.test(name || "");

/** 声部标识 -> 当前显示名（用户改过就用改后的名字）。 */
function partDisplayName(key, fallback) {
  return state.partNames.get(key) || fallback;
}
// 声部排序：按标识里的数字自然排序（P1<P2<…<P10、staff-1<…、jianpu-1<…），
// 这样合唱谱的声部自上而下的顺序与谱面一致，钢琴伴奏排在最后。
function partSortKey(key) {
  const matched = String(key).match(/^(.*?)(\d+)$/);
  return matched ? [matched[1], Number(matched[2])] : [String(key), 0];
}

/** 收集当前乐谱里的声部（每个 part 一行），返回 [{ key, name, count, piano }]。 */
function collectParts() {
  const groups = new Map();
  for (const note of state.notes) {
    const key = voiceIdentity(note);
    if (!groups.has(key)) {
      const fallback = note.partName || "乐谱";
      groups.set(key, {
        key, fallback, count: 0, name: partDisplayName(key, fallback),
        piano: looksLikePiano(note.partName),
      });
    }
    groups.get(key).count += 1;
  }
  const parts = [...groups.values()];
  parts.sort((a, b) => {
    const [aHead, aNum] = partSortKey(a.key);
    const [bHead, bNum] = partSortKey(b.key);
    return aHead.localeCompare(bHead) || aNum - bNum;
  });
  return parts;
}

/** 当前声部面板里勾选/最近操作的声部（加厚声部的来源）。 */
function focusedPartKey() {
  const parts = collectParts();
  if (!parts.length) return null;
  if (state.selectedParts instanceof Set) {
    const enabled = parts.filter((part) => state.selectedParts.has(part.key));
    if (enabled.length === 1) return enabled[0].key;
  }
  return parts[0].key;
}

/**
 * 把一个声部复制成新声部（加厚层次用）。
 *
 * 为什么要复制音符而不是只改音色：一份乐谱里「同一段旋律用两种乐器齐奏」在数据上就是两条音轨，
 * 复制成独立 part 之后，勾选、音量、音色、播放、MIDI 导出、MusicXML 导出全部照常生效，
 * 不需要为「加厚」单独写一套特殊的播放逻辑。
 *
 * @param {string} sourceKey 源声部
 * @param {{semitones?: number, name?: string, timbre?: string}} options
 *        semitones：整体移调半音（高/低八度叠加用 ±12）；name：新声部名；timbre：新声部音色
 * @returns {{key: string, name: string, count: number} | null}
 */
function duplicatePart(sourceKey, options = {}) {
  const source = state.notes.filter((note) => voiceIdentity(note) === sourceKey);
  if (!source.length) {
    showToast("这个声部还没有音符，先识别或添加音符再叠加。");
    return null;
  }
  const semitones = Math.round(Number(options.semitones) || 0);
  const baseName = options.name || (partDisplayName(sourceKey, sourceKey) + " · 叠加");
  // 新声部的 partId 要避开已有的，保证 voiceIdentity 唯一
  let index = 1;
  let newId = `${sourceKey}-layer${index}`;
  const used = new Set(state.notes.map((note) => voiceIdentity(note)));
  while (used.has(newId)) {
    index += 1;
    newId = `${sourceKey}-layer${index}`;
  }
  const name = uniquePartName(baseName);
  const copies = source.map((note) => {
    const midi = Math.max(0, Math.min(127, Math.round(note.midi) + semitones));
    return {
      ...note,
      id: makeId(),
      partId: newId,
      partName: name,
      midi,
      pitch: midiToPitchName(midi),
      x: Number.NaN, y: Number.NaN,
      confidence: 1,
      isLowConfidence: false,
    };
  });
  state.notes.push(...copies);
  state.partNames.set(newId, name);
  if (options.timbre) state.partTimbres.set(newId, options.timbre);
  // 新声部默认参与演奏
  if (state.selectedParts instanceof Set) state.selectedParts.add(newId);
  updatePartControls();
  appendPartNoteRows(newId, copies);
  refreshScoreOverlay();
  updatePlaybackReady();
  const octaveText = semitones > 0 ? "高八度" : semitones < 0 ? "低八度" : "同音高";
  showToast(`已把「${partDisplayName(sourceKey, sourceKey)}」复制成新声部「${name}」（${octaveText}，${copies.length} 个音），可在声部行单独选音色。`);
  return { key: newId, name, count: copies.length };
}

/** 让新声部名不重复（否则声部面板会把同名合在一起，用户会以为没加上）。 */
function uniquePartName(baseName) {
  const alive = new Set(collectParts().map((part) => part.name));
  if (!alive.has(baseName)) return baseName;
  let index = 2;
  while (alive.has(`${baseName} ${index}`)) index += 1;
  return `${baseName} ${index}`;
}

/** 加厚声部的三个入口。 */
function addLayerPart() {
  const key = focusedPartKey();
  if (!key) return showToast("还没有声部可以复制，先识别或导入一份乐谱。");
  duplicatePart(key, {});
}

function addLayerOctave(semitones) {
  const key = focusedPartKey();
  if (!key) return showToast("还没有声部可以叠加，先识别或导入一份乐谱。");
  const label = semitones > 0 ? "高八度" : "低八度";
  duplicatePart(key, { semitones, name: `${partDisplayName(key, key)} · ${label}` });
}

/** 这个声部是否要参与演奏/导出。 */
function isPartEnabled(key) {
  return state.selectedParts === null || state.selectedParts.has(key);
}

/**
 * 声部面板：勾选参与演奏的声部、下拉改名、钢琴伴奏总开关。
 * `reset=true` 时恢复为「全部勾选」（换文件、重新识别时用）。
 */
function updatePartControls(reset = false) {
  const parts = collectParts();
  if (reset || !(state.selectedParts instanceof Set)) {
    state.selectedParts = null;
  } else {
    // 重新识别后某些声部可能消失：把已选集合里失效的键剔掉，避免「一个声部都没选」的空播放。
    const alive = new Set(parts.map((part) => part.key));
    state.selectedParts = new Set([...state.selectedParts].filter((key) => alive.has(key)));
  }
  state.pianoKeys = new Set(parts.filter((part) => part.piano).map((part) => part.key));
  // 从本地设置恢复「逐声部音色」（只认当前乐谱里存在的声部）。
  restorePartTimbres(parts.map((part) => part.key));

  els.partList.replaceChildren();
  for (const part of parts) {
    const row = document.createElement("div");
    row.className = "part-row";
    row.dataset.partKey = part.key;   // 便于测试/排查按声部定位

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isPartEnabled(part.key);
    checkbox.id = "part-check-" + Math.abs([...part.key].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7));
    checkbox.addEventListener("change", () => {
      if (state.selectedParts === null) {
        state.selectedParts = new Set(parts.map((item) => item.key));
      }
      if (checkbox.checked) state.selectedParts.add(part.key);
      else state.selectedParts.delete(part.key);
      stopPlayback();
      updatePlaybackReady();
    });

    const select = document.createElement("select");
    select.className = "part-name-select";
    select.title = "点这里把声部改成谱面上的名字";
    select.setAttribute("aria-label", "声部名");
    const names = [...new Set([part.name, ...PART_NAME_PRESETS])];
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      if (name === part.name) option.selected = true;
      select.append(option);
    }
    const custom = document.createElement("option");
    custom.value = PART_NAME_CUSTOM;
    custom.textContent = PART_NAME_CUSTOM;
    select.append(custom);
    select.addEventListener("change", () => {
      if (select.value === PART_NAME_CUSTOM) {
        const typed = window.prompt("给这个声部起个名字（例如：女高）", part.name);
        const name = typed && typed.trim();
        if (!name) {
          select.value = part.name;
          return;
        }
        applyPartName(part.key, name.trim());
        return;
      }
      applyPartName(part.key, select.value);
    });

    // 每个声部可以单独选音色（例如：女高用合唱人声、钢伴用钢琴；或反过来用弦乐垫底）。
    const timbreSelect = document.createElement("select");
    timbreSelect.className = "part-timbre-select";
    timbreSelect.title = `给「${part.name}」单独选音色（播放中切换会在下次播放生效）`;
    timbreSelect.setAttribute("aria-label", `${part.name} 的音色`);
    fillTimbreOptions(timbreSelect, { followGlobal: true });
    timbreSelect.value = partTimbre(part.key);
    timbreSelect.addEventListener("change", () => {
      if (!setPartTimbre(part.key, timbreSelect.value)) {
        timbreSelect.value = partTimbre(part.key);
        return;
      }
      timbreSelect.title = timbreSelect.value
        ? `「${part.name}」用「${TIMBRE_LABELS[timbreSelect.value]}」`
        : `「${part.name}」跟随全局音色`;
    });

    // 逐声部八度修正：识别引擎漏读男高音谱号的 8vb 时，整个声部会高八度，这里一键校回。
    const octaveSelect = document.createElement("select");
    octaveSelect.className = "part-octave-select";
    octaveSelect.title = `「${part.name}」听起来整体高/低八度时用它修正（只改这个声部）`;
    octaveSelect.setAttribute("aria-label", `${part.name} 的八度`);
    for (const [value, label] of [["0", "原八度"], ["-1", "低八度"], ["1", "高八度"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      octaveSelect.append(option);
    }
    octaveSelect.value = String(partOctave(part.key));
    octaveSelect.addEventListener("change", () => {
      setPartOctave(part.key, Number(octaveSelect.value));
      octaveSelect.title = partOctave(part.key) === 0
        ? `「${part.name}」原八度`
        : `「${part.name}」已${partOctave(part.key) > 0 ? "升" : "降"}八度`;
    });

    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "part-volume";
    volume.min = "0";
    volume.max = "100";
    volume.step = "2";
    volume.value = String(Math.round(partVolume(part.key) * 100));
    volume.setAttribute("aria-label", `${part.name} 的音量`);
    volume.title = `拖动调节「${part.name}」的音量：播放中也能实时调，声音立刻变、不会中断`;
    volume.addEventListener("input", () => {
      setPartVolume(part.key, Number(volume.value) / 100);
      volume.title = `「${part.name}」音量 ${volume.value}%（播放中也能实时调）`;
    });

    const count = document.createElement("small");
    count.textContent = `${part.count}音`;
    count.title = `${part.name}：${part.count} 个音`;

    row.append(checkbox, select, timbreSelect, octaveSelect, volume, count);
    els.partList.append(row);
  }

  const pianoParts = parts.filter((part) => part.piano);
  els.pianoToggleWrap.hidden = pianoParts.length === 0;
  els.pianoToggle.checked = state.includePiano;
  els.partPanel.hidden = parts.length === 0;
  if (els.layerToolbar) els.layerToolbar.hidden = parts.length === 0;
  updatePlaybackReady();
}

/** 改名：改一次，整份乐谱里该声部的所有音符一起更新（含 MIDI 导出用的 partName）。 */
function applyPartName(key, name) {
  state.partNames.set(key, name);
  for (const note of state.notes) {
    if (voiceIdentity(note) === key) note.partName = name;
  }
  updatePartControls();
  if (state.scoreInfo && Array.isArray(state.scoreInfo.partNames)) {
    state.scoreInfo.partNames = collectParts().map((part) => part.name);
  }
  showToast(`这个声部的名字已改为「${name}」`);
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
  // 用渲染时建好的索引（8419 行时遍历全表要 11 ms，选一次就卡一下）
  const selectedIds = range ? new Set(range.ids) : null;
  if (state.noteRowById && state.noteRowById.size) {
    for (const [id, row] of state.noteRowById) {
      row.classList.toggle("is-selected", Boolean(selectedIds && selectedIds.has(id)));
    }
    return;
  }
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
  // 演奏范围 = 勾选的声部（默认全部勾选）→ 再看「是否包含钢琴伴奏」→ 最后套用选中的片段。
  const voiceNotes = state.notes.filter((note) => {
    const key = voiceIdentity(note);
    if (!isPartEnabled(key)) return false;
    if (!state.includePiano && state.pianoKeys.has(key)) return false;
    return true;
  });
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
  if (els.audioButton) els.audioButton.disabled = activeNotes.length === 0 || state.isPlaying;
  els.midiButton.title = selectionRange() ? "下载所选片段的 MIDI 文件" : "下载 MIDI 文件";
  // 播放控件文案与选区状态保持一致：没有选区时就是「播放全曲」，选了片段就只播那一段。
  els.playIcon.textContent = state.isPlaying ? "Ⅱ" : "▶";
  els.playLabel.textContent = state.isPlaying ? "正在播放" : (selectionRange() ? "播放选中片段" : "播放全曲");
  els.stopButton.disabled = !state.isPlaying;
}
function addNote() {
  const eventId = state.notes.length ? Math.max(...state.notes.map((note) => note.eventId)) + 1 : 0;
  const startBeat = state.notes.reduce((end, note) => Math.max(end, note.startBeat + beatsForNote(note)), 0);
  state.notes.push({ id: makeId(), eventId, pitch: "C4", midi: 60, duration: "quarter", durationBeats: 1, startBeat, x: NaN, y: NaN });
  renderNotes();
  // 手动加的音符不属于任何声部：把声部勾选恢复为全选，否则用户可能看不见这个新音符。
  state.selectedParts = null;
  updatePartControls();
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
  refreshScoreOverlay();
  showToast(`已整体移调 ${value > 0 ? "+" : ""}${value} 个半音。`);
}
/** 把一张图片交给本机引擎识别，返回解析后的乐谱。engine: "audiveris" 整页 / "homr" 单谱表。 */
async function recognizeImageBlob(blob, engine = "homr", attempt = 0, timeSignature = "") {
  try {
    const response = await fetch("/api/omr/recognize?engine=" + engine, {
      method: "POST",
      // 必须和实际图片格式一致：服务端按 Content-Type 校验图片头。识谱图现在是 PNG。
      headers: { "Content-Type": blob.type || "image/jpeg" },
      body: blob,
    });
    const payload = await response.json();
    if (response.status === 503 && payload.reason === "engine-missing") return { unavailable: true };
    if (response.status === 503) {
      // 只是"任务繁忙"：稍等后重试，不要因为一次抖动就放弃整页的专业识别。
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        return recognizeImageBlob(blob, engine, attempt + 1, timeSignature);
      }
      return { error: payload.error || "本机识谱任务繁忙，请稍后重试。" };
    }
    // 整行没有符头（休止/声部未进入）是正常结果，不算故障。
    if (payload.empty) return { empty: true };
    if (!response.ok) return { error: payload.error || "本机 OMR 引擎没有完成识谱。", engine };
    const scoreInfo = parseMusicXmlText(payload.musicxml, timeSignature ? { timeSignature } : undefined);
    return { scoreInfo, engine };
  } catch (error) {
    console.info("本机 OMR 未响应，改用浏览器粗略估算。", error);
    return { unavailable: true };
  }
}

/** 整页交给 Audiveris 识别：一次调用得到完整的多声部结构，不再需要逐行裁切。 */
async function recognizeWholePage() {
  const blob = await omrPageBlob(state.pageNumber);
  if (!blob) return { error: "当前页面无法导出为图片。" };
  // 拍号提示：同一份文件里第 1 页识别过以后，后面几页即使没印拍号也能按拍号算小节长度。
  return recognizeImageBlob(blob, "audiveris", 0, state.timeSignatureHint);
}

/**
 * 把一张画布导出成图片。
 * 默认给简谱识别用 JPEG（体积小、够用）；五线谱识谱走 PNG 无损（见 omrPageBlob）。
 */
function canvasToBlob(canvas = els.scoreCanvas, type = "image/jpeg", quality = 0.92) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** 把 Blob 读成 base64（去掉 data: 前缀），供整本批量识别接口使用。 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取页面图片失败。"));
    reader.onload = () => {
      const text = String(reader.result || "");
      const comma = text.indexOf(",");
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * 整本识别（Audiveris 批量）：把 N 页图片**一次**送到 `/api/omr/recognize-batch`。
 *
 * 为什么要批量：Audiveris 每次启动有约 3 秒的 JVM/引擎初始化开销。逐页调用时 16 页要付 16 次；
 * 合并成一次调用只付 1 次。实测（3 页、2600px）：单页 9.19 秒/页 → 批量 6.02 秒/页。
 *
 * 返回按页索引的数组，元素是 `{ scoreInfo }` 或 `null`（该页失败）；失败页不中断整批。
 */
async function recognizePagesInBatch(blobs, { superseded = () => false, onProgress = () => {} } = {}) {
  if (!blobs.length) return [];
  onProgress({ done: 0, total: blobs.length, label: "正在一次送出整本识别（省去每页的引擎启动）…" });
  const images = [];
  for (let index = 0; index < blobs.length; index++) {
    if (superseded()) return [];
    images.push(await blobToBase64(blobs[index]));
  }
  if (superseded()) return [];
  let response;
  try {
    response = await fetch("/api/omr/recognize-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images }),
    });
  } catch {
    // 网络/服务异常：交给调用方退回逐页流程，而不是整批失败。
    return [];
  }
  if (!response.ok) {
    if (response.status === 503) audiverisAvailable = false;
    return [];
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return [];
  }
  const pages = Array.isArray(payload.pages) ? payload.pages : [];
  const results = [];
  // 逐页解析时「继承拍号」：第 1 页通常印了 `4/4`，后面几页不再印；
  // 把第 1 页读到的拍号传给后面几页，它们的小节长度才能按拍号算（否则会越往后越飘）。
  let contextTime = "";
  for (let index = 0; index < blobs.length; index++) {
    if (superseded()) return [];
    const page = pages[index];
    onProgress({ done: index + 1, total: blobs.length, label: `第 ${index + 1} / ${blobs.length} 页已识别` });
    if (!page || !page.musicxml) {
      results.push(null);
      continue;
    }
    try {
      const scoreInfo = parseMusicXmlText(page.musicxml, contextTime ? { timeSignature: contextTime } : undefined);
      if (scoreInfo && /^\d+\/\d+$/.test(scoreInfo.timeSummary || "")) contextTime = scoreInfo.timeSummary;
      results.push(scoreInfo && scoreInfo.notes.length ? { scoreInfo } : null);
    } catch {
      results.push(null);
    }
  }
  return results;
}

/**
 * 整本简谱识别（批量）：把 N 页图片**一次**送到 `/api/jianpu/recognize-batch`。
 *
 * 为什么要批量：每页单独调一次 jianpu.py 都要付一次 Python 启动 + numpy/cv2 导入 +
 * 数字模板渲染的开销（实测约 0.42 秒/页）；一次送多页只付一次，实测降到 0.09 秒/页。
 *
 * 返回按页索引的数组，元素是 `{ scoreInfo }` 或 `null`（该页失败）；失败页不中断整批。
 */
async function recognizeJianpuPagesInBatch(blobs, doMidi, beats, { superseded = () => false, onProgress = () => {} } = {}) {
  if (!blobs.length) return [];
  onProgress({ done: 0, total: blobs.length, label: "正在一次送出整本简谱识别（省去每页的解释器启动）…" });
  const images = [];
  for (let index = 0; index < blobs.length; index++) {
    if (superseded()) return [];
    images.push(await blobToBase64(blobs[index]));
  }
  if (superseded()) return [];
  let response;
  try {
    response = await fetch("/api/jianpu/recognize-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images, do: doMidi, beats }),
    });
  } catch {
    return [];
  }
  if (!response.ok) {
    if (response.status === 503) jianpuAvailable = false;
    return [];
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return [];
  }
  const pages = Array.isArray(payload.pages) ? payload.pages : [];
  const results = [];
  for (let index = 0; index < blobs.length; index++) {
    if (superseded()) return [];
    const page = pages[index];
    onProgress({ done: index + 1, total: blobs.length, label: `第 ${index + 1} / ${blobs.length} 页已识别` });
    if (!page || page.error) {
      results.push(null);
      continue;
    }
    try {
      const scoreInfo = jianpuToScoreInfo(page, beats);
      results.push(scoreInfo && scoreInfo.notes.length ? { scoreInfo } : null);
    } catch {
      results.push(null);
    }
  }
  return results;
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
 * 识别"当前画布上的这一页"，返回 { scoreInfo, staves, diagnostics }，不改动主界面状态。
 * 单页识别（recognizeScore）与整本批量识别（recognizeAllPages）共用这一份核心逻辑。
 *
 * @param {object} options
 * @param {(staves: object[]) => (number|"all")} options.pickStaff 决定识别全部谱表还是单行
 * @param {() => boolean} options.superseded 令牌/取消判断，返回 true 时中止并返回 null
 * @param {(progress: {done:number,total:number,label:string}) => void} options.onProgress 进度回调
 */
async function collectPageScore({ pickStaff = () => "all", superseded = () => false, onProgress = () => {} }) {
  const { binary, width, height } = readPageBinary();
  const staves = detectStaves(binary, width, height);
  if (!staves.length) {
    throw new Error("没有检测到五线谱。这页可能是简谱（数字谱）——目前识谱引擎只支持五线谱；也请检查图片是否清晰完整。");
  }
  const selection = pickStaff(staves);
  const singleStaff = Number.isInteger(selection) && selection >= 0 && selection < staves.length;
  const targets = singleStaff ? [selection] : staves.map((_, index) => index);
  const diagnostics = {
    staves, targets, singleStaff, systemCount: 1, wholePage: false, wholePageError: "",
    estimatedCount: 0, emptyCount: 0, failedCount: 0, source: "engine",
  };

  // Audiveris 整页识别：一次调用即得到完整的多声部结构（各声部并行而非首尾串接）。
  // 只在"识别全部谱表"且本机装有 Audiveris 时走这条路；单行重试仍走逐行流程。
  if (!singleStaff && audiverisAvailable !== false) {
    onProgress({ done: 0, total: 1, label: "正在整页识别（Audiveris，约 10–20 秒）…" });
    const engineResult = await recognizeWholePage();
    if (superseded()) return null;
    if (engineResult.scoreInfo && engineResult.scoreInfo.notes.length) {
      return { scoreInfo: engineResult.scoreInfo, staves, diagnostics: { ...diagnostics, wholePage: true } };
    }
    if (engineResult.unavailable) {
      audiverisAvailable = false;
      updateEngineHint();
    }
    // 整页识别失败（例如分辨率不足或这一页是简谱）：记下原因，继续走逐行流程。
    diagnostics.wholePageError = engineResult.error || "";
  }

  const systems = targets.length === 1
    ? [[targets[0]]]
    : groupSystems(staves.filter((_, index) => targets.includes(index)))
        .map((system) => system.map((staff) => staves.indexOf(staff)));
  diagnostics.systemCount = systems.length;

  const results = new Map();
  let done = 0;
  let engineMissing = false;
  onProgress({ done: 0, total: targets.length, label: "" });

  for (const index of targets) {
    if (superseded()) return null;
    const staff = staves[index];
    const box = staffCropBox(staff, width, height, staves[index - 1], staves[index + 1]);
    onProgress({ done, total: targets.length, label: `正在识别第 ${done + 1} / ${targets.length} 行谱表` });

    let result = null;
    let clef = els.clefSelect.value;
    if (!engineMissing && homrAvailable !== false) {
      const blob = await cropToBlob(box);
      if (superseded()) return null;
      const engineResult = blob ? await recognizeImageBlob(blob, "homr", 0, state.timeSignatureHint) : { unavailable: true };
      if (superseded()) return null;
      if (engineResult.unavailable) {
        engineMissing = true;
      } else if (engineResult.empty) {
        result = { notes: [], tempo: 84, measureCount: 0, warnings: [], clef: "", empty: true };
        diagnostics.emptyCount++;
      } else if (engineResult.scoreInfo) {
        result = engineResult.scoreInfo;
        clef = CLEF_BY_SIGN[result.clef] || clef;
        if (!result.notes.length) {
          result.empty = true;
          diagnostics.emptyCount++;
        }
      } else {
        // 这一行引擎确实失败了：如实标记，不用像素估算去"猜"（那只会产生假音符）。
        result = { notes: [], tempo: 84, measureCount: 0, warnings: [], clef: "", error: engineResult.error };
        diagnostics.failedCount++;
      }
    }
    // 只有整台引擎都不可用时，才退回浏览器内的粗略估算。
    if (!result) {
      result = estimateStaffNotes(staff, binary, width, height, clef);
      diagnostics.estimatedCount++;
    }

    // 本机引擎不返回音符在谱面上的坐标，这里不再尝试用像素检测去"反推"位置：
    // 在真实雕版谱上（谱号涡卷、歌词、圆滑线）误检率很高，画出来的点反而会误导。
    // 谱面导航改用"谱表框 + 行高亮 + 音高基准线"，这三者是 100% 可靠的。
    result.staffIndex = index;
    result.clefName = clef;
    results.set(index, result);
    done++;
    onProgress({ done, total: targets.length, label: "" });
  }

  if (superseded()) return null;
  const merged = mergeSystemScores(systems, results);
  if (!merged.notes.length) {
    // 所有谱表都没能读出音符：最常见的两种情况是这一页是简谱（数字谱），
    // 或者图片分辨率不足。明确说出来，不要让用户对着"失败"干猜。
    if (diagnostics.failedCount === targets.length && !diagnostics.estimatedCount && !diagnostics.emptyCount) {
      throw new Error("没有识别出任何音符。这页可能是简谱（数字谱）——识谱引擎只支持五线谱；也可能是图片不清晰，可换更清晰的整页图片再试。");
    }
    throw new Error("逐行识别没有提取到音符，可点击“添加”手动录入。");
  }
  diagnostics.source = diagnostics.estimatedCount === targets.length ? "estimate" : (diagnostics.estimatedCount ? "mixed" : "engine");
  return { scoreInfo: merged, staves, diagnostics };
}

/** 把一页识别结果写进主界面（单页识别与整本识别共用的收尾步骤）。
 *  `page` = 这份结果对应哪一页（翻页时决定要不要在谱面上画音符点）；整本合并结果传 null。 */
function commitScore(scoreInfo, staves, source, { title, page } = {}) {
  // 本机引擎的识别结果：把散乱的时值吸附到拍号网格上（只改节奏、不改音高），
  // 否则扫描谱里那些 0.375 拍、3.75 拍的零头会让整曲听起来「散」。MusicXML 导入不动。
  if (source === "engine") quantizeScoreRhythm(scoreInfo);
  for (const note of scoreInfo.notes) note.duration = durationFromBeats(note.durationBeats);
  dedupePartNames(scoreInfo.notes);
  clearTimbreCache();
  state.scoreInfo = scoreInfo;
  state.notes = scoreInfo.notes;
  state.staffBoxes = staves;
  state.scorePage = page === undefined ? state.pageNumber : page;
  state.recognitionSource = scoreInfo.notes.length ? source : null;
  state.transposeOffset = 0;
  if (els.transposeInput) els.transposeInput.value = "0";
  updatePartControls(true);
  state.recognized = true;
  els.clefSelect.disabled = false;
  if (title) els.scoreTitle.textContent = title;
  renderNotes();
  refreshScoreOverlay();
  updateRecognitionBanner();
  // 记住这次识别到的拍号：同一份文件后面几页/后面几次识别可以复用它。
  if (/^\d+\/\d+$/.test(scoreInfo.timeSummary || "")) state.timeSignatureHint = scoreInfo.timeSummary;
  // 谱面速度（如 ♩=66）：识别/导入到就自动填进右上角 BPM。
  // 以前这里只对 MusicXML 导入生效，扫描谱识别出的速度进不了输入框，试听会退回默认 84 BPM
  // （用户反馈「怎么这么快」的根因：原谱 66，默认 84 快了 27%）。
  // 起始速度：优先用「第 0 拍的速度标记」，没有就从全曲速度标记里推断
  // （很多谱只在中间某页印一次 ♩=138，例如 Hall of the Mountain King；
  //   以前只取第 0 拍，读不到就一路用默认 84，听感就是「怎么这么快/这么慢」）。
  applyDetectedTempo(scoreInfo);
  if (!scoreInfo.tempoDetected && source === "engine") {
    const tempoNote = "谱面上没有识别到速度标记（也可能本机没装 OCR 语言包），当前试听用的是右上角 BPM；"
      + "请按谱面左上角的 ♩=?? 改一下，速度才会和原谱一致。";
    if (!(scoreInfo.warnings || []).includes(tempoNote)) scoreInfo.warnings = [...(scoreInfo.warnings || []), tempoNote];
  }
  // 图片型低清 PDF：把「为什么不准」如实写进结果，而不是让用户对着错音纳闷。
  scheduleTimbrePreload();

  if (state.lowResPdf) {
    const note = `这份 PDF 是图片型文档（每页约 ${state.lowResPdf.dpi} DPI），谱面字号太小，识别准确率会明显下降；`
      + "建议换 300 DPI 以上的清晰扫描件或矢量 PDF，并逐音校对后再使用。";
    if (!(scoreInfo.warnings || []).includes(note)) scoreInfo.warnings = [...(scoreInfo.warnings || []), note];
  }
}

/**
 * 空闲时后台预加载「这次识别/导入会用到」的采样音源。
 *
 * 为什么值得：真实钢琴/人声这些采样音源第一次加载要 2–8 秒（11 分钟大谱实测 8 秒），
 * 以前要等用户点「导出 MP3」才开始加载，那几秒全加在导出耗时上；点播放也会卡一下。
 * 现在识别完成 1.5 秒后（用户通常还在看谱面）就在后台按需加载，导出/试听时已经就绪。
 * 只加载当前乐谱实际用到的音色，不会把 83 个音源全读进来。
 */
let timbrePreloadTimer = null;
function scheduleTimbrePreload() {
  if (timbrePreloadTimer) clearTimeout(timbrePreloadTimer);
  timbrePreloadTimer = setTimeout(() => {
    timbrePreloadTimer = null;
    if (!state.notes.length) return;
    const needed = new Set();
    for (const note of state.notes) {
      const key = voiceIdentity(note);
      if (needed.has(key)) continue;
      needed.add(key);
      const timbre = timbreForPart(key);
      if (!isSampledTimbre(timbre)) continue;
      const loaded = state.sampleBanks.get(timbre);
      if (loaded && loaded.ready) continue;
      // 不 await：让它在后台慢慢加载，界面上只会看到状态栏的进度提示
      ensureSampleBank(timbre).catch(() => {});
    }
  }, 1500);
}

/**
 * 把「识别到的速度」落到界面上。
 *
 * 为什么不是简单地把 scoreInfo.tempo 填进去：识别引擎给出的 tempo 只代表第 0 拍附近有没有标记，
 * 像 Hall of the Mountain King 这种「开头没印、中段才印 ♩=138」的谱，按老逻辑会一路用默认 84。
 * 这里用 detectStartTempo 从全曲速度标记推断，并把「本谱有几处变速」如实告诉用户。
 */
function applyDetectedTempo(scoreInfo) {
  if (!scoreInfo) return;
  const marks = scoreInfo.tempoMarks || [];
  const detected = detectStartTempo(marks);
  if (detected) {
    scoreInfo.tempo = detected.bpm;
    scoreInfo.tempoDetected = true;
    scoreInfo.tempoSource = detected.source;
    if (els.tempoInput) els.tempoInput.value = String(Math.round(detected.bpm));
  }
  updateTempoHint(marks, detected);
}

/** 速度输入框下面的说明：这一整份谱有几处速度变化、播放会不会跟着变。 */
function updateTempoHint(marks, detected) {
  const hint = els.tempoHint;
  if (!hint) return;
  const count = Array.isArray(marks) ? marks.length : 0;
  hint.hidden = false;
  if (!count) {
    hint.textContent = "谱面上没有读到速度标记：当前 BPM 用于整曲。";
    return;
  }
  if (count === 1) {
    const source = detected && detected.source === "opening"
      ? "开头就有标记"
      : (detected && detected.source === "single" ? "标记在乐曲中段，已用作整曲速度" : "已按标记设定");
    hint.textContent = `读到 1 处速度标记（♩=${Math.round(marks[0].bpm)}，${source}）；播放会按它走。`;
    return;
  }
  const first = Math.round(marks[0].bpm), last = Math.round(marks[marks.length - 1].bpm);
  hint.textContent = `读到 ${count} 处速度变化（♩=${first} → ♩=${last}）；播放会自动分段变速，改 BPM 会整体等比缩放。`;
}

/**
 * 把一页的「速度标记像素坐标」换算成「第几拍」。
 *
 * 依靠已识别的谱表几何（state.staffBoxes 里每行谱表的 y 范围）与小节数：
 *   · y 决定标记属于哪个系统（取 y 最接近、且不高于标记的那一行谱表作为该系统的起点）；
 *   · 系统内按「第几个系统」换算成小节号（整本识别时各系统依次排下去）；
 *   · x 在系统宽度内的相对位置 → 小节内第几拍（谱面左侧是第 1 拍）。
 * 这套换算是近似的（速度记号一般印在小节线左侧、系统开头），但足以让播放"在该小节变速"。
 */
function mapTempoMarksToBeats(pages, stavesByPage, measuresPerPage) {
  const marks = [];
  pages.forEach((pageInfo, pageIndex) => {
    const staves = stavesByPage[pageIndex] || [];
    const measureBase = measuresPerPage[pageIndex] || 0;
    const measureCount = measuresPerPage[pageIndex] || 0;
    if (!staves.length || !measureCount) return;
    // 按谱表 y 排序，同一系统内的多行谱表归并成一个"系统"
    const sorted = [...staves].sort((a, b) => a.top - b.top);
    const systems = [];
    for (const staff of sorted) {
      const last = systems[systems.length - 1];
      if (last && staff.top - last.bottom < 220) {
        last.bottom = Math.max(last.bottom, staff.bottom);
        last.staves.push(staff);
      } else {
        systems.push({ top: staff.top, bottom: staff.bottom, staves: [staff] });
      }
    }
    // 小节数按系统均分（识别的谱表几何不细分小节边界，这里按拍位近似）
    const perSystem = Math.max(1, Math.round(measureCount / Math.max(1, systems.length)));
    for (const tempo of pageInfo.tempos || []) {
      let systemIndex = 0;
      for (let index = 0; index < systems.length; index += 1) {
        if (tempo.y >= systems[index].top - 80) systemIndex = index;
      }
      const system = systems[systemIndex] || systems[0];
      const measureIndex = Math.min(measureCount - 1, systemIndex * perSystem);
      // x 归一化到 0–1 → 小节内第几拍（速度记号通常在最左，约第 0–1 拍）
      const width = Math.max(1, system.staves[0].right - system.staves[0].left);
      const relative = Math.max(0, Math.min(1, (tempo.x - system.staves[0].left) / width));
      const beatInMeasure = Math.min(3.5, Math.max(0, relative * 4));
      const beat = (measureBase + measureIndex) * 4 + beatInMeasure;
      marks.push({ beat, bpm: tempo.bpm, source: "spatial-ocr", page: pageInfo.page, x: tempo.x, y: tempo.y });
    }
  });
  return marks;
}

/**
 * 对当前文件的所有页跑一次「速度 OCR」，返回 [{page, tempos}]。
 * 用的是识别时同一套 OMR 高清图（omrPageBlob），所以不需要再渲染一遍。
 */
async function requestTempoOcr(pageBlobs) {
  if (!pageBlobs.length) return [];
  const images = [];
  for (const blob of pageBlobs) {
    try {
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
      }
      images.push(btoa(binary));
    } catch (error) {
      console.info("速度 OCR：图片编码失败", error);
    }
  }
  if (!images.length) return [];
  try {
    const response = await fetch("/api/omr/tempo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images }),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return payload.pages || [];
  } catch (error) {
    console.info("速度 OCR 接口不可用", error);
    return [];
  }
}

/**
 * 合并「MusicXML 自带的速度标记」与「谱面 OCR 读到的速度标记」。
 *
 * 以 OCR 为准：Audiveris 实测会把 ♩=138 读成 66、5 处只认出 1 处；
 * 但 OCR 也可能读空（比如谱面速度用斜体字印刷）。所以：
 *   · OCR 有结果 → 用 OCR（并按 beat 排序去重）；
 *   · OCR 没有 → 保留 MusicXML 的；
 *   · 两者都有且相差很大 → 保留 OCR，同时把差异写进 warnings 让用户知道。
 */
/** 把「4/4」「3/8」这类拍号换算成每小节多少拍（四分音符 = 1 拍）。 */
function beatsPerMeasureFromSummary(timeSummary) {
  const matched = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(timeSummary || ""));
  if (!matched) return 4;
  const beats = Number(matched[1]);
  const beatType = Number(matched[2]);
  if (!beats || !beatType) return 4;
  return (beats * 4) / beatType;
}

/**
 * 整本识别流程里调用速度 OCR，并把结果映射成拍位。
 *
 * 页面来源：`prepared` 里已经存了每页的 OMR 高清图 blob（识别时渲染的同一份），
 * 直接复用，不需要再渲染一遍。返回 [{beat, bpm}]（已按拍位排序、去重）。
 */
/**
 * 从 PDF 文字层读速度标记（最可靠：速度和印刷小节号都是精确值）。
 *
 * 只有 PDF 有文字层；图片文件直接返回 []（走 OCR 兜底）。
 * @param {Blob|null} pdfBlob 当前文件的 PDF 数据
 * @returns {Promise<Array<{page, bpm, bar}>>}
 */
async function requestTempoFromPdfText(pdfBlob) {
  if (!pdfBlob) return [];
  try {
    const response = await fetch("/api/omr/tempo-text", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBlob,
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return payload.marks || [];
  } catch (error) {
    console.info("PDF 文字层速度读取不可用，回退 OCR", error);
    return [];
  }
}

/**
 * 把「文字层速度标记」换算成播放用的拍位。
 *
 * 文字层给的是 (页, 印刷小节号, BPM)，换算只需要：小节号 × 每小节拍数 = 拍位。
 * 每小节拍数用识别结果里的 timeSummary（4/4 → 4 拍）。
 */
function tempoMarksFromPdfText(marks, { beatsPerMeasure = 4 } = {}) {
  const result = [];
  for (const mark of marks) {
    const bpm = Number(mark.bpm);
    const bar = Number(mark.bar);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 320) continue;
    // 没有小节号的（例如开头的「Alla marcia ... ♩=138」）当作乐曲起始速度
    const beat = Number.isFinite(bar) && bar > 0 ? (bar - 1) * beatsPerMeasure : 0;
    result.push({ beat, bpm, source: "pdf-text", bar: Number.isFinite(bar) ? bar : null });
  }
  // 去重：同一拍位保留第一个；按拍位排序
  const seen = new Set();
  const unique = [];
  for (const mark of result.sort((left, right) => left.beat - right.beat)) {
    const key = `${mark.beat}|${mark.bpm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(mark);
  }
  return unique;
}

/**
 * 速度查询的「现做」入口：先试 PDF 文字层，再回退到图片 OCR。
 *
 * 返回 [{beat, bpm}]（已按拍位排序、去重）；`prefetched` 传入整本识别快路径里
 * 在识别期间就并行启动的速度查询（见 startTempoLookup），直接复用它的结果。
 * 语义与改动前一致：文字层优先、OCR 兜底、映射规则不变。
 */
async function applyTempoOcr(prepared, entries, totalPages, superseded, prefetched = null) {
  // 主路径：PDF 文字层（速度和印刷小节号都是精确值，实测 Hall 曲 22 处全部读出）
  if (prefetched) {
    const marks = await prefetched.textMarksPromise;
    if (superseded()) return [];
    if (marks.length) {
      const beats = beatsPerMeasureFromSummary((entries.find(Boolean) || {}).scoreInfo?.timeSummary);
      console.info("速度：从 PDF 文字层读到", marks.length, "处");
      return tempoMarksFromPdfText(marks, { beatsPerMeasure: beats });
    }
    const { pages: ocrPages, pageNumbers } = await prefetched.ocrPromise;
    if (superseded() || !ocrPages.length) return [];
    const mapped = mapOcrTempoMarksToBeats(ocrPages, entries, pageNumbers);
    console.info("速度 OCR 结果：", mapped);
    return mapped;
  }
  // 逐页兜底路径：识别已经全部结束，这里现场读文字层 / 跑 OCR
  if (state.file && state.pdf && state.pdfBytes) {
    const marks = await requestTempoFromPdfText(state.pdfBytes);
    if (superseded()) return [];
    if (marks.length) {
      const beats = beatsPerMeasureFromSummary((entries.find(Boolean) || {}).scoreInfo?.timeSummary);
      console.info("速度：从 PDF 文字层读到", marks.length, "处");
      return tempoMarksFromPdfText(marks, { beatsPerMeasure: beats });
    }
  }
  // 兜底：图片文件的 OCR（没有文字层）
  const pages = prepared.filter((item) => item.blob).map((item) => item.blob);
  if (!pages.length) return [];
  const pageNumbers = prepared.filter((item) => item.blob).map((item) => item.number);
  let ocrPages = [];
  try {
    ocrPages = await requestTempoOcr(pages);
  } catch (error) {
    console.info("速度 OCR 失败，使用 MusicXML 自带的速度标记", error);
    return [];
  }
  if (superseded() || !ocrPages.length) return [];
  const mapped = mapOcrTempoMarksToBeats(ocrPages, entries, pageNumbers);
  console.info("速度 OCR 结果：", mapped);
  return mapped;
}

/**
 * 把每页的 OCR 候选（x/y 坐标 + bpm）映射成全曲拍位。
 *
 * 原先这段逻辑内联在 applyTempoOcr 后半段，抽出来供「并行快路径」和「逐页兜底路径」
 * 共用，避免两处各写一遍、将来只改一处导致行为分叉。
 */
function mapOcrTempoMarksToBeats(ocrPages, entries, pageNumbers) {
  // 每页的小节数与谱表几何（谱表几何从识别结果里拿；拿不到就只按页均分估计）
  const measuresPerPage = [];
  const stavesByPage = [];
  for (const number of pageNumbers) {
    const index = number - 1;
    const entry = entries[index];
    const count = entry && entry.scoreInfo ? entry.scoreInfo.measureCount : 0;
    measuresPerPage.push(count);
    // 优先用整页识别时返回的谱表框（state.staffBoxes 只对应最后一页，所以用 entries 里的）
    const staffs = entry && entry.staves && entry.staves.length
      ? entry.staves.map((staff) => ({ top: staff.top, bottom: staff.bottom, left: staff.left, right: staff.right }))
      : [];
    if (!staffs.length && entry && entry.scoreInfo) {
      // 没有谱表几何：按「页面纵向均分成系统」的粗略估计（宁可位置偏一点，也别丢掉速度变化）
      // 用当前已渲染的画布尺寸（识别时它就是这一页的显示图，坐标系与 OMR 图按比例一致）
      const pageHeight = els.scoreCanvas?.height || els.overlayCanvas?.height || 2600;
      const pageWidth = els.scoreCanvas?.width || els.overlayCanvas?.width || 2000;
      const systems = Math.max(1, Math.round(count / 3));
      for (let sysIndex = 0; sysIndex < systems; sysIndex += 1) {
        const top = Math.round((sysIndex + 0.15) * pageHeight / systems);
        const bottom = Math.round((sysIndex + 0.85) * pageHeight / systems);
        staffs.push({ top, bottom, left: 100, right: pageWidth - 100 });
      }
    }
    stavesByPage.push(staffs);
  }
  return mapTempoMarksToBeats(ocrPages, stavesByPage, measuresPerPage);
}

/**
 * 在「整本识别请求已发出、等 Audiveris 返回」的空档里，并行准备速度记号材料。
 *
 * 为什么值得：识别一整本要几十秒（实测 8 页 150 DPI 图片型 PDF 约 45–85 秒），
 * 客户端原本完全空转，等识别结束后才串行跑速度 OCR（8 页实测文字层尝试 ~5 秒 +
 * 图片 OCR ~10 秒 ≈ 15 秒）。现在把这段时间挪到空档里，识别结果回来时通常已经就绪。
 *
 * 语义与改动前一致：
 * - 图片型 PDF（state.lowResPdf 为真）没有文字层 → 跳过 /api/omr/tempo-text（原来白跑约 5 秒）；
 * - 有文字层的 PDF 仍以文字层结果优先，文字层读不到才回退图片 OCR；
 * - OCR 用 3 倍高清图（OMR 图上等号横线太细，检不全），结果仍交给
 *   mapTempoMarksToBeats 映射，不改变去重与优先级。
 *
 * @returns {{textMarksPromise: Promise<Array>, ocrPromise: Promise<{pages: Array, pageNumbers: number[]}>}}
 */
function startTempoLookup(staffPages, fileToken, superseded) {
  const textMarksPromise = (state.file && state.pdf && state.pdfBytes && !state.lowResPdf)
    ? requestTempoFromPdfText(state.pdfBytes)
    : Promise.resolve([]);
  const ocrPromise = (async () => {
    let textMarks = [];
    try {
      textMarks = await textMarksPromise;
    } catch {
      textMarks = [];
    }
    // 文字层已经读到速度：不必再渲染 3 倍图跑 OCR（识别期间客户端的活到此为止）
    if (superseded() || textMarks.length) return { pages: [], pageNumbers: [] };
    const sources = [];
    for (const item of staffPages) {
      if (superseded()) return { pages: [], pageNumbers: [] };
      try {
        const blob = await tempoPageBlob(item.number, fileToken);
        if (blob) sources.push({ number: item.number, blob });
      } catch (error) {
        console.info("第 " + item.number + " 页速度 OCR 取图失败：", error);
      }
    }
    if (superseded() || !sources.length) return { pages: [], pageNumbers: [] };
    let ocrPages = [];
    try {
      ocrPages = await requestTempoOcr(sources.map((item) => item.blob));
    } catch (error) {
      console.info("速度 OCR 失败，使用 MusicXML 自带的速度标记", error);
      return { pages: [], pageNumbers: [] };
    }
    return { pages: ocrPages, pageNumbers: sources.map((item) => item.number) };
  })();
  return { textMarksPromise, ocrPromise };
}

function mergeTempoMarks(xmlMarks, ocrMarks) {
  const clean = (list) => (list || [])
    .map((mark) => ({ beat: Number(mark.beat) || 0, bpm: Number(mark.bpm) }))
    .filter((mark) => Number.isFinite(mark.bpm) && mark.bpm >= 20 && mark.bpm <= 320)
    .sort((left, right) => left.beat - right.beat);
  const fromXml = clean(xmlMarks);
  const fromOcr = clean(ocrMarks);
  if (!fromOcr.length) return fromXml;
  // OCR 的拍位是近似值，同一小节内的多个标记按 beat 去重
  const merged = [];
  for (const mark of fromOcr) {
    if (merged.length && Math.abs(merged[merged.length - 1].beat - mark.beat) < 2
        && Math.abs(merged[merged.length - 1].bpm - mark.bpm) < 0.5) continue;
    merged.push(mark);
  }
  return merged;
}

/**
 * 单页识别：整页交给 Audiveris（优先）；失败则把整页切成一行行谱表分别识别，
 * 再按"系统内并行、系统间顺序"拼回多声部（避免多声部被压平成单一旋律）。
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
  els.recognizeAllButton.disabled = true;
  els.clefSelect.disabled = true;
  els.staffSelect.disabled = true;
  els.cancelRecognize.hidden = false;
  setRecognizeProgress(0, 0, "正在分析谱表…");
  els.scoreHint.textContent = audiverisAvailable === false && homrAvailable === false
    ? "未检测到专业引擎，正在逐行做粗略估算"
    : audiverisAvailable !== false
      ? "正在整页识别；若 Audiveris 不可用则逐行谱表识别（避免多声部被压平）"
      : "正在逐行谱表识别（每行单独送引擎，避免多声部被压平）";
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));

  try {
    const outcome = await collectPageScore({
      superseded,
      onProgress: ({ done, total, label }) => setRecognizeProgress(done, total, label),
      pickStaff: (staves) => {
        updateStaffOptions(staves.length);
        const wanted = Number(els.staffSelect.value);
        return Number.isInteger(wanted) && wanted >= 0 && wanted < staves.length ? wanted : "all";
      },
    });
    if (!outcome || superseded()) return;
    const { scoreInfo, staves, diagnostics } = outcome;

    if (diagnostics.wholePage) {
      commitScore(scoreInfo, staves, "engine");
      // 详情/警告要和整本识别一样显示出来（例如「这份 PDF 是图片型文档，只有 155 DPI」）。
      els.scoreInfo.hidden = false;
      els.scoreDetails.textContent = `${scoreInfo.notes.length} 个音符 · ${scoreInfo.partNames.length} 个声部 · ${scoreInfo.measureCount} 小节 · ${scoreInfo.timeSummary} · ${scoreInfo.keySummary}${selfCheckSummary(scoreInfo)}`;
      els.scoreWarnings.textContent = (scoreInfo.warnings || []).join(" ");
      els.scoreWarnings.hidden = !(scoreInfo.warnings || []).length;
      els.scoreHint.textContent = `Audiveris 整页识别完成：${scoreInfo.notes.length} 个音符 · ${scoreInfo.partNames.length} 个声部 · ${scoreInfo.measureCount} 小节`;
      const warning = scoreInfo.warnings[0] ? ` ${scoreInfo.warnings[0]}` : "";
      showToast(`Audiveris 识别到 ${scoreInfo.notes.length} 个音符（${scoreInfo.partNames.length} 个声部），请逐音校对。${warning}`);
      return;
    }

    commitScore(scoreInfo, staves, diagnostics.source);
    const extra = [
      diagnostics.emptyCount ? `${diagnostics.emptyCount} 行整行休止` : "",
      diagnostics.failedCount ? `${diagnostics.failedCount} 行识别失败` : "",
    ].filter(Boolean).join(" · ");
    els.scoreHint.textContent = `逐行识别完成：${diagnostics.targets.length} 行谱表 · ${scoreInfo.notes.length} 个音符 · ${diagnostics.systemCount} 个系统${extra ? " · " + extra : ""}`;
    if (diagnostics.wholePageError) {
      // 把整页识别失败的原因如实告诉用户（例如这一页是简谱、数字谱，任何引擎都不支持）。
      els.scoreHint.textContent += ` · 整页识别未成功：${diagnostics.wholePageError}`;
    }
    const sourceLabel = diagnostics.source === "engine"
      ? "本机专业引擎"
      : diagnostics.source === "estimate" ? "粗略估算" : "专业引擎 + 部分估算";
    const warning = scoreInfo.warnings[0] ? ` ${scoreInfo.warnings[0]}` : "";
    showToast(`${sourceLabel}识别到 ${scoreInfo.notes.length} 个音符（${diagnostics.targets.length} 行谱表），请逐音校对。${warning}`);
  } catch (error) {
    if (superseded()) return;
    console.error(error);
    // 识别失败时清掉上一次的结果，避免旧音符继续被当作"本次识别结果"试听和导出。
    state.notes = [];
    state.scoreInfo = null;
    state.recognitionSource = null;
    state.staffBoxes = null;
    state.scorePage = null;
    state.recognized = false;
    renderNotes();
    updatePartControls(true);
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
    els.recognizeAllButton.disabled = false;
    // 文件已经换掉时不要再去改主界面状态，交给新的加载流程处理。
    if (fileToken === state.loadToken) {
      els.recognizeButton.disabled = !state.file;
      els.recognizeLabel.textContent = idleRecognizeLabel();
      els.clefSelect.disabled = false;
      els.staffSelect.disabled = false;
    }
  }
}

/**
 * 整本批量识别（P0-1）：渲染第 N 页 → 识别 → 渲染第 N+1 → …… 全程进度条 + 可取消，
 * 最后用 mergePageScores 把各页结果跨页拼成一份小节序号连续、各声部起拍单调递增的多声部乐谱。
 * 单页失败不会中断整批：失败的页会被标记出来，成功的页照常合并。
 */
async function recognizeAllPages() {
  if (!state.file || !state.pdf || !els.scoreCanvas.width) return;
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
  els.recognizeAllButton.disabled = true;
  els.recognizeAllLabel.textContent = "正在识别…";
  els.clefSelect.disabled = true;
  els.staffSelect.disabled = true;
  els.cancelRecognize.hidden = false;
  const totalPages = state.pageCount;
  const entries = [];
  // 速度 OCR 的输入：每页的 OMR 高清图（识别时渲染的同一份，复用不重渲染）
  const tempoSources = [];
  // 整本快路径里，速度查询在识别期间并行启动（见 startTempoLookup），结果暂存在这里
  let tempoPrefetch = null;
  try {
    // ---- 快路径：把「有谱表的页」一次送给 Audiveris（省去每页一次的 JVM 启动）----
    // 实测：逐页调用约 9 秒/页；一次批量约 2.5–5 秒/页。16 页的谱从 2.4 分钟降到 40 秒左右。
    //
    // 关键改进（用户反馈「整本识别太慢」后改）：以前要求「**每一页**都检测到五线谱」才敢批量，
    // 于是像《敕勒歌》这种前 10 页五线谱、后 6 页简谱的书会整体退回逐页流程（16×9 秒 ≈ 2.4 分钟）。
    // 现在改成「只把有谱表的页批量送识别，没有谱表的页（多半是简谱页）如实跳过并提示」，
    // 混合谱也能享受到批量提速（实测 16 页混合谱 24.6 秒）。
    let batchHandled = false;
    const noStaffPages = new Set();
    let skippedNoStaff = [];
    if (audiverisAvailable !== false && totalPages > 1 && totalPages <= 32) {
      const prepared = [];
      for (let number = 1; number <= totalPages; number++) {
        if (superseded()) return;
        setRecognizeProgress(number - 1, totalPages, `正在准备第 ${number} / ${totalPages} 页…`);
        await renderPdfPage(number, fileToken);
        if (superseded()) return;
        const { binary, width, height } = readPageBinary();
        const hasStaves = detectStaves(binary, width, height).length > 0;
        const blob = hasStaves ? await omrPageBlob(number, fileToken) : null;
        prepared.push({ number, blob, hasStaves });
        // 速度 OCR 用的 3 倍高清图不在这里串行渲染：整本快路径会在识别请求发出后的
        // 空档里并行准备（见 startTempoLookup）；逐页兜底路径仍在下面逐页准备。
        if (!hasStaves) noStaffPages.add(number);
      }
      const staffPages = prepared.filter((item) => item.hasStaves && item.blob);
      if (staffPages.length) {
        setRecognizeProgress(0, staffPages.length, `正在一次送出 ${staffPages.length} 页（省去每页的引擎启动）…`);
        // 先把批量识别请求发出去（不等它返回），再趁「等 Audiveris」的空档并行准备速度 OCR：
        // 识别一整本要几十秒，客户端原本完全空转，速度 OCR 却要等识别结束后再串行跑十几秒。
        const batchResultsPromise = recognizePagesInBatch(staffPages.map((item) => item.blob), {
          superseded,
          onProgress: ({ done, total, label }) => {
            setRecognizeProgress(done, Math.max(total, 1), label || `已完成 ${done} / ${total} 页`);
          },
        });
        const tempoLookup = startTempoLookup(staffPages, fileToken, superseded);
        const batchResults = await batchResultsPromise;
        if (superseded()) return;
        if (batchResults.length === staffPages.length) {
          const byPage = new Map(staffPages.map((item, index) => [item.number, batchResults[index]]));
          for (let number = 1; number <= totalPages; number++) {
            if (superseded()) return;
            const result = byPage.get(number);
            if (!result) { entries.push(null); continue; }
            entries.push({
              scoreInfo: result.scoreInfo,
              staves: [],
              diagnostics: { wholePage: true, source: "engine", emptyCount: 0, failedCount: 0, estimatedCount: 0 },
            });
          }
          skippedNoStaff = [...noStaffPages].sort((a, b) => a - b);
          tempoPrefetch = tempoLookup;
          batchHandled = true;
        }
      }
    }
    if (!batchHandled) {
      if (!skippedNoStaff.length && noStaffPages.size) {
        skippedNoStaff = [...noStaffPages].sort((a, b) => a - b);
      }
      for (let number = 1; number <= totalPages; number++) {
        if (superseded()) return;
        if (noStaffPages.has(number)) {
          // 这一页已经确认没有五线谱（多半是简谱页）：逐页流程也不必再白跑一次。
          entries.push(null);
          continue;
        }
        setRecognizeProgress(number - 1, totalPages, `正在识别第 ${number} / ${totalPages} 页…`);
        await renderPdfPage(number, fileToken);
        if (superseded()) return;
        // 逐页路径也要给速度 OCR 准备图（同款 OMR 图，供 /api/omr/tempo 使用）
        try {
          const tempoBlob = await tempoPageBlob(number, fileToken);
          if (tempoBlob) tempoSources.push({ number, blob: tempoBlob });
        } catch (error) {
          console.info("第 " + number + " 页速度 OCR 取图失败：", error);
        }
        try {
          const outcome = await collectPageScore({
            pickStaff: () => "all",
            superseded,
            onProgress: ({ done, total, label }) => {
              // 页内的逐行进度换算成整本进度：已完成页数 + 本页内百分比。
              const fraction = total > 0 ? done / total : (label ? 0 : 1);
              setRecognizeProgress(number - 1 + fraction, totalPages,
                label ? `第 ${number} / ${totalPages} 页 · ${label}` : `正在识别第 ${number} / ${totalPages} 页…`);
            },
          });
          if (superseded()) return;
          if (!outcome) return;
          entries.push(outcome);
        } catch (error) {
          if (superseded()) return;
          // 单页失败不中断整批：记下来，继续识别后面的页，最后如实告知哪几页失败。
          console.info(`第 ${number} 页识别失败：`, error);
          entries.push(null);
        }
      }
    }
    if (superseded()) return;
    // —— 速度 OCR：Audiveris 的速度记号实测漏读/误读严重（Hall 曲 5 处只给 1 处、还读成 66），
    //    而谱面速度快慢数字本身用几何 OCR 能全部读对。这里在合并前补一次；
    //    整本快路径的速度查询已在识别期间并行跑（tempoPrefetch），这里只是收结果。
    const tempoOcrApplied = await applyTempoOcr(tempoSources, entries, totalPages, superseded, tempoPrefetch);
    if (superseded()) return;
    const merged = mergePageScores(entries.map((entry) => (entry ? entry.scoreInfo : null)), new Set(skippedNoStaff));
    if (tempoOcrApplied.length) {
      // OCR 结果按拍位合并进 merged（OCR 优先，因为 Audiveris 的读数是错的）
      merged.tempoMarks = mergeTempoMarks(merged.tempoMarks, tempoOcrApplied);
      const start = detectStartTempo(merged.tempoMarks);
      if (start) {
        merged.tempo = start.bpm;
        merged.tempoDetected = true;
        merged.tempoSource = start.source;
      }
    }
    if (!merged.notes.length) {
      throw new Error("整本都没有识别出音符。请检查 PDF 是否清晰，或改用单页识别逐页处理。");
    }
    merged.title = state.file.name.replace(/\.[^.]+$/, "");
    if (skippedNoStaff.length) {
      // 不许静默丢页：明确告诉用户哪几页没参与合并、以及该用什么功能处理它们。
      merged.warnings = [...(merged.warnings || []),
        `第 ${skippedNoStaff.join("、")} 页没有检测到五线谱（多为简谱页），已跳过；简谱页请用「按简谱识别全部 N 页」处理。`];
    }
    const recognized = entries.filter(Boolean);
    const estimatedPages = recognized.filter((entry) => entry.diagnostics.estimatedCount > 0).length;
    const source = estimatedPages === 0 ? "engine" : (estimatedPages === recognized.length ? "estimate" : "mixed");
    commitScore(merged, null, source, { title: merged.title, page: null });
    // 回到第 1 页预览：直接调 renderPdfPage（它只重画谱面，不会碰识别结果）。
    await renderPdfPage(1, fileToken);
    if (superseded()) return;
    // 失败页与「跳过页」分开说：简谱页不是识别失败，而是这份功能本来就不处理它。
    const failed = merged.failedPages || [];
    const mergedPages = totalPages - skippedNoStaff.length;
    const skippedText = skippedNoStaff.length
      ? ` · 第 ${skippedNoStaff.join("、")} 页没有五线谱（简谱）已跳过，请用「按简谱识别全部 N 页」`
      : "";
    els.scoreInfo.hidden = false;
    els.scoreDetails.textContent = `${merged.notes.length} 个音符 · ${merged.partNames.length} 个声部 · ${merged.measureCount} 小节 · ${merged.timeSummary} · ${merged.keySummary}${merged.tempoDetected ? " · ♩=" + Math.round(merged.tempo) : ""}`;
    els.scoreWarnings.textContent = (merged.warnings || []).join(" ");
    els.scoreWarnings.hidden = !(merged.warnings || []).length;
    els.scoreHint.textContent = `整本识别完成：合并 ${mergedPages} 页 · ${merged.notes.length} 个音符 · ${merged.measureCount} 个小节${failed.length ? ` · 第 ${failed.join("、")} 页识别失败` : ""}${skippedText}`;
    showToast(`已合并 ${mergedPages} 页共 ${merged.notes.length} 个音符，请逐音校对。${failed.length ? `（第 ${failed.join("、")} 页失败）` : ""}${skippedNoStaff.length ? `（第 ${skippedNoStaff.join("、")} 页无五线谱，已跳过）` : ""}`);
  } catch (error) {
    if (superseded()) return;
    console.error(error);
    state.notes = [];
    state.scoreInfo = null;
    state.recognitionSource = null;
    state.staffBoxes = null;
    state.scorePage = null;
    state.recognized = false;
    renderNotes();
    updatePartControls(true);
    clearOverlay();
    updateRecognitionBanner();
    const message = error && error.message ? error.message : "整本识别时遇到问题，请改用单页识别逐页处理。";
    showToast(message);
    els.scoreHint.textContent = "整本识别失败 · " + message;
  } finally {
    state.isRecognizing = false;
    els.processingOverlay.hidden = true;
    els.cancelRecognize.hidden = true;
    setRecognizeProgress(0, 0, "");
    els.recognizeProgress.hidden = true;
    if (fileToken === state.loadToken) {
      els.recognizeButton.disabled = !state.file;
      els.recognizeLabel.textContent = idleRecognizeLabel();
      els.recognizeAllButton.disabled = false;
      els.recognizeAllLabel.textContent = `识别全部 ${totalPages} 页`;
      els.clefSelect.disabled = false;
      els.staffSelect.disabled = false;
    }
  }
}
/**
 * 整本简谱识别：逐页走本机简谱模块（`/api/jianpu/recognize`），再用 mergePageScores 跨页
 * 拼成一份小节序号连续、各声部起拍单调递增的乐谱。
 *
 * 为什么必须单独有这条线：简谱是**逐页**识别的，单页「按简谱识别这一页」每次都会用
 * commitScore **整份替换** state.notes —— 所以多页简谱若不整本识别，就永远只能演奏最后一页。
 */
async function recognizeAllJianpuPages() {
  if (!state.file || !state.pdf || !els.scoreCanvas.width) return;
  if (state.isRecognizing) return;
  if (jianpuAvailable === false) {
    showToast("未检测到简谱识别所需的解释器：请先安装 homr（会一并装好 opencv），或用 JIANPU_PYTHON 指定解释器。");
    return;
  }
  const beats = Number(els.jianpuBeats.value) || 4;
  const doMidi = Number(els.jianpuKey.value) || 65;
  state.isRecognizing = true;
  state.cancelRecognize = false;
  const token = ++state.recognizeToken;
  const fileToken = state.loadToken;
  const superseded = () => token !== state.recognizeToken || fileToken !== state.loadToken || state.cancelRecognize;
  stopPlayback();
  state.selection = null;
  els.processingOverlay.hidden = false;
  els.recognizeButton.disabled = true;
  els.jianpuButton.disabled = true;
  els.jianpuAllButton.disabled = true;
  els.recognizeAllButton.disabled = true;
  els.cancelRecognize.hidden = false;
  els.jianpuAllLabel.textContent = "正在整本识别…";
  const totalPages = state.pageCount;
  const pages = new Array(totalPages).fill(null);   // 下标 = 页码-1，页识别失败就留 null
  try {
    // 快速路径：先把每一页渲染成图片，再**一次**送给简谱引擎。
    // 简谱每页识别本身只要约 0.09 秒，真正的开销是每页启动一次 Python（约 0.4 秒），
    // 所以整本一起送能快 4 倍以上。批量失败（接口不可用等）再退回逐页流程。
    let batchHandled = false;
    if (totalPages > 1 && totalPages <= 32 && jianpuAvailable !== false) {
      const blobs = [];
      for (let number = 1; number <= totalPages; number++) {
        if (superseded()) return;
        setRecognizeProgress(number - 1, totalPages, `正在准备第 ${number} / ${totalPages} 页…`);
        els.scoreHint.textContent = `正在准备第 ${number} / ${totalPages} 页（渲染页面）`;
        await renderPdfPage(number, fileToken);
        if (superseded()) return;
        const blob = await canvasToBlob();
        blobs.push(blob || null);
      }
      if (blobs.every(Boolean)) {
        const batchResults = await recognizeJianpuPagesInBatch(blobs, doMidi, beats, {
          superseded,
          onProgress: ({ done, total, label }) => {
            setRecognizeProgress(done, total, label);
            els.scoreHint.textContent = `正在整本按简谱识别：${label}`;
          },
        });
        batchHandled = batchResults.length === totalPages;
        if (batchHandled) batchResults.forEach((result, index) => { pages[index] = result ? result.scoreInfo : null; });
      }
    }
    if (!batchHandled) {
      for (let number = 1; number <= totalPages; number++) {
        if (superseded()) return;
        setRecognizeProgress(number - 1, totalPages, `正在按简谱识别第 ${number} / ${totalPages} 页…`);
        els.scoreHint.textContent = `正在按简谱识别第 ${number} / ${totalPages} 页（数字模板匹配 + 版面解析）`;
        await renderPdfPage(number, fileToken);
        if (superseded()) return;
        try {
          const blob = await canvasToBlob();
          if (!blob) throw new Error("当前页面无法导出为图片。");
          const scoreInfo = await requestJianpuScore(blob, doMidi, beats);
          if (scoreInfo.notes.length) pages[number - 1] = scoreInfo;
          else console.info(`第 ${number} 页没有读出简谱音符，跳过。`);
        } catch (error) {
          // 单页失败不中断整批：记下来，最后如实告知哪几页没读出来（mergePageScores 会汇总）。
          console.info(`第 ${number} 页简谱识别失败：`, error);
        }
      }
    }
    if (superseded()) return;
    const recognized = pages.filter(Boolean);
    if (!recognized.length) throw new Error("整本都没有读出简谱音符（这些页面可能不是简谱）。");
    const merged = recognized.length === 1 ? recognized[0] : mergePageScores(pages);
    // 自检结果也要合并：每页报的是「本页第 N 小节」，整本要把小节号按前面各页的小节数累加，
    // 否则用户会按错误的第 N 小节去谱面上找。
    merged.selfCheck = recognized.length === 1 ? merged.selfCheck : mergeSelfChecks(pages);
    merged.title = state.file.name.replace(/\.[^.]+$/, "");
    commitScore(merged, null, "jianpu", { title: merged.title, page: null });
    // 回到第 1 页预览：直接调 renderPdfPage（它只重画谱面，不会碰识别结果）。
    await renderPdfPage(1, fileToken);
    if (superseded()) return;
    const failed = merged.failedPages || [];
    els.scoreInfo.hidden = false;
    els.scoreDetails.textContent = `${merged.notes.length} 个音符 · ${merged.partNames.length} 个声部 · ${merged.measureCount} 小节 · ${merged.timeSummary} · ${merged.keySummary}${selfCheckSummary(merged)}`;
    els.scoreWarnings.textContent = merged.warnings.join(" ");
    els.scoreWarnings.hidden = merged.warnings.length === 0;
    els.scoreHint.textContent = `整本简谱识别完成：${totalPages} 页 · ${merged.notes.length} 个音符 · ${merged.measureCount} 小节${failed.length ? ` · 第 ${failed.join("、")} 页没读出来` : ""}`;
    showToast(`已把 ${totalPages} 页简谱拼成一份乐谱（${merged.notes.length} 个音符），现在可以整曲播放。${failed.length ? `（第 ${failed.join("、")} 页没读出来）` : ""}`);
  } catch (error) {
    if (superseded()) return;
    console.error(error);
    state.notes = [];
    state.scoreInfo = null;
    state.recognitionSource = null;
    state.staffBoxes = null;
    state.scorePage = null;
    state.recognized = false;
    renderNotes();
    updatePartControls(true);
    clearOverlay();
    updateRecognitionBanner();
    const message = error && error.message ? error.message : "整本简谱识别时遇到问题，请改用单页识别逐页处理。";
    showToast(message);
    els.scoreHint.textContent = "整本简谱识别失败 · " + message;
  } finally {
    state.isRecognizing = false;
    els.processingOverlay.hidden = true;
    els.cancelRecognize.hidden = true;
    setRecognizeProgress(0, 0, "");
    els.recognizeProgress.hidden = true;
    if (fileToken === state.loadToken) {
      updateBatchButtons();
      els.recognizeButton.disabled = !state.file;
      els.jianpuButton.disabled = false;
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
  const tempo = clampTempo(Number(els.tempoInput.value) || 84);
  // 分段速度：谱面有中途变速时（如 ♩=66 → ♩=138），MIDI 里也写成一串速度事件，
  // 这样在别的软件里打开、或导出音频时速度也是对的，而不是整曲一个固定值。
  const tempoEvents = midiTempoEvents((state.scoreInfo && state.scoreInfo.tempoMarks) || [], {
    detectedBpm: state.scoreInfo ? state.scoreInfo.tempo : null,
    userBpm: tempo,
    ticksPerBeat,
  });
  const events = tempoEvents.map((event) => ({
    tick: event.tick, priority: 0,
    bytes: [0xff, 0x51, 0x03, (event.microsPerBeat >> 16) & 0xff, (event.microsPerBeat >> 8) & 0xff, event.microsPerBeat & 0xff],
  }));
  // 同音高、同通道的音不能重叠：MIDI 里 note-off 是按 (通道, 音高) 关的，
  // 前一个音的 off 会把后一个还在响的同音高音一起关掉（听感上「后面那个音提前断了」）。
  // 所以先把每个音高的时间段整理成互不重叠：与前一音重叠的，从前一音结束处开始。
  const byPitch = new Map();
  for (const note of notes) {
    if (!Number.isFinite(note.midi)) continue;
    const midi = Math.min(127, Math.max(0, Math.round(note.midi)));
    const startTick = Math.max(0, Math.round(((note.startBeat || 0) - offset) * ticksPerBeat));
    const endTick = startTick + Math.max(1, Math.round(beatsForNote(note) * ticksPerBeat));
    if (!byPitch.has(midi)) byPitch.set(midi, []);
    byPitch.get(midi).push({ start: startTick, end: endTick });
  }
  for (const [midi, spans] of byPitch) {
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    let previousEnd = -1;
    for (const span of spans) {
      if (span.start < previousEnd) span.start = previousEnd;      // 截断重叠部分
      if (span.end <= span.start) span.end = span.start + 1;       // 保底至少 1 tick
      previousEnd = Math.max(previousEnd, span.end);
    }
    for (const span of spans) {
      events.push({ tick: span.start, priority: 2, bytes: [0x90, midi, 88] });
      events.push({ tick: span.end, priority: 1, bytes: [0x80, midi, 0] });
    }
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

// ===== 导出 MP3 / WAV 音频 =====
/** 采样率与码率：44.1 kHz / 128 kbps 立体声，兼容性最好。 */
const AUDIO_EXPORT_RATE = 44100;
const AUDIO_EXPORT_KBPS = 128;

/**
 * 导出渲染的分块策略。
 *
 * 为什么分块并行：实测 89.6 秒的谱，整块渲染要 12.7 秒——其中 88% 花在主链
 * （混响卷积器）。切成 4 块并行渲染只要 1.2 秒，原因是：
 *   1) 多核真正并行：每块各用一个 OfflineAudioContext，浏览器在不同线程上算；
 *   2) Chrome 对「超长离线渲染」有一次性额外开销（实测同一段音频第一次 12.6 秒、
 *      之后 4.2 秒），块变小后这部分几乎消失。
 *
 * 保真的四条约束（缺一条拼出来就是坏的）：
 *   · 所有块共用同一份混响脉冲（见 sharedImpulse），否则边界处音色会跳；
 *   · 每个音的人性化参数在 plan 里预先算好（audio-export.js），不依赖调度顺序；
 *   · 每块向前多看「最长音时长 + 混响长度」，避免长音被块边界截断；
 *   · 每块前后多渲一段 overlap，用来让混响尾音和压限器进入稳定状态。
 */
const EXPORT_RENDER = {
  minSecondsPerChunk: 15,   // 每块至少这么长；太碎反而更慢（每块都有固定开销）
  maxChunks: 12,            // 长曲实测：688 秒 8 块 7.45 s → 12 块 5.51 s；短曲被 minSecondsPerChunk 卡住不变
  overlapSeconds: 2.4,      // 前后多渲：混响 1.9 秒 + 压限器 release 0.24 秒，留余量
  // 往前看超过这么远就不值得分块了（长音太多）：12 秒能覆盖钹 8.5 / 碰铃 6.3 秒这类
  // 常见打击乐长尾；小锣 19.5、大锣 27.3 秒则退回整块渲染（宁慢勿错）。
  maxLookback: 12,
};

/**
 * 一个音「实际会响多久」（秒）。
 *
 * 为什么不能只看时值：碰铃/木鱼/钹/锣这类 oneShot 音色是整段采样自然衰减，
 * playSampledTone 里**不**按时值调用 stop（一个 0.08 秒的锣音符实际会响 19–27 秒）。
 * 分块渲染时如果只按「时值 + 混响」算 lookback，块边界附近的锣声尾音会整段丢失
 * （实测分块 vs 整块 RMS 差 -9.8 dB，等于完全不同的音频）。
 */
function audibleSecondsForNote(note) {
  let seconds = note.durationSeconds;
  if (isSampledTimbre(note.timbre)) {
    const bank = state.sampleBanks.get(note.timbre);
    if (bank && bank.oneShot) {
      for (const layer of bank.layers || []) {
        for (const sample of layer.samples || []) {
          const clip = sample.buffer ? sample.buffer.duration : 0;
          if (clip > seconds) seconds = clip;
        }
      }
    }
  }
  return seconds;
}

/** 一份计划里最长的「可听时长」（秒）。 */
function longestNoteSeconds(plan) {
  let longest = 0;
  for (const note of plan.notes) {
    const seconds = audibleSecondsForNote(note);
    if (seconds > longest) longest = seconds;
  }
  return longest;
}

/** 决定分几块；返回 1 表示整块渲染。 */
function decideExportChunks(plan) {
  const totalSeconds = Math.max(0.1, Number(plan.totalSeconds) || 0.1);
  const longest = longestNoteSeconds(plan);
  const lookback = longest + REVERB.seconds + 0.5;
  // 有超长音时，每块都要多渲很久，分块收益被吃掉，直接整块
  if (lookback > EXPORT_RENDER.maxLookback) return 1;
  const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4);
  let count = Math.min(EXPORT_RENDER.maxChunks, Math.max(2, cores - 1));
  while (count > 2 && totalSeconds / count < EXPORT_RENDER.minSecondsPerChunk) count -= 1;
  if (count < 2 || totalSeconds < EXPORT_RENDER.minSecondsPerChunk * 2) return 1;
  return count;
}

/** 保存渲染期间会被改写的全局音频状态。 */
function snapshotAudioState() {
  return {
    audio: state.audio,
    master: state.master,
    reverbBuffer: state.reverbBuffer,
    vibrato: state.vibrato,
    noiseBuffer: state.noiseBuffer,
    waves: new Map(state.waves),
    partBuses: new Map(state.partBuses),
    partPanners: new Map(state.partPanners),
    sources: new Set(state.sources),
  };
}

/** 恢复全局音频状态（渲染结束后必须原样还原，否则试听会串）。 */
function restoreAudioState(saved) {
  state.audio = saved.audio;
  state.master = saved.master;
  state.reverbBuffer = saved.reverbBuffer;
  state.vibrato = saved.vibrato;
  state.noiseBuffer = saved.noiseBuffer;
  state.waves = saved.waves;
  state.partBuses = saved.partBuses;
  state.partPanners = saved.partPanners;
  state.sources = saved.sources;
}

/**
 * 在某个离线上下文里，把计划中「落在 [windowFrom, windowTo) 且会响到这段」的音符接上。
 *
 * @param {OfflineAudioContext} offline
 * @param {object} plan buildAudioPlan 的结果
 * @param {number} windowFrom 窗口起点（秒，计划时间轴）
 * @param {number} windowTo 窗口终点（秒）
 * @param {{sharedImpulse: AudioBuffer, shiftSeconds: number}} options
 *        sharedImpulse：所有块共用的混响脉冲；shiftSeconds：窗口起点在上下文里的时间偏移
 */
function schedulePlanWindow(offline, plan, windowFrom, windowTo, options) {
  state.audio = offline;
  state.master = null;
  // 直接塞入共用脉冲：masterChain 建链时会用它，保证每块混响完全一致
  state.reverbBuffer = options.sharedImpulse || null;
  state.vibrato = null;
  state.noiseBuffer = null;
  state.waves = new Map();
  state.partBuses = new Map();
  state.partPanners = new Map();
  state.sources = new Set();
  const shift = Number(options.shiftSeconds) || 0;
  const tail = REVERB.seconds + 0.05;
  let scheduled = 0;
  for (const note of plan.notes) {
    const start = note.startSeconds;
    if (start >= windowTo) break;                       // 计划按时间升序，后面都不用排
    if (start + note.durationSeconds + tail <= windowFrom) continue;   // 含混响尾也早结束
    const at = start + shift + 0.02;
    if (at < 0) continue;                               // 理论上不会发生（见 lookback）
    const destination = partBus(note.partKey);
    humanOverride = note.human || null;
    try {
      playTone(note.midi, at, note.durationSeconds * 0.99, note.peak, destination, note.partKey);
    } finally {
      humanOverride = null;
    }
    scheduled += 1;
  }
  return scheduled;
}

/**
 * 离线渲染整曲（或选中片段）为 AudioBuffer。
 *
 * 复用实时播放用的同一套发声函数（playTone / partBus / masterChain），
 * 所以导出听到的声音 = 试听到的声音（含分段变速、逐声部音色与音量、混响压限）。
 * 渲染分块并行，见 EXPORT_RENDER 的说明。
 */
async function renderPlanToBuffer(plan, { onProgress } = {}) {
  const rate = AUDIO_EXPORT_RATE;
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error("当前浏览器不支持离线音频渲染。");
  const totalFrames = Math.max(1, Math.ceil(plan.totalSeconds * rate));
  const chunkCount = decideExportChunks(plan);
  const saved = snapshotAudioState();
  const previousSeed = state.exportReverbSeed;
  // 导出用固定种子生成混响脉冲：同一份谱每次导出结果一致，分块之间也完全一致。
  state.exportReverbSeed = 0x9e3779b9;
  try {
    // 共用混响脉冲：在一个 1 帧的上下文里生成即可（AudioBuffer 可跨上下文使用）
    const ruler = new OfflineContext(1, 1, rate);
    const sharedImpulse = makeReverbImpulse(ruler, REVERB.seconds, REVERB.decay, state.exportReverbSeed, false);
    const longest = longestNoteSeconds(plan);

    if (chunkCount <= 1) {
      const offline = new OfflineContext(2, totalFrames, rate);
      schedulePlanWindow(offline, plan, 0, plan.totalSeconds, { sharedImpulse, shiftSeconds: 0 });
      if (onProgress) onProgress(0.35, "正在渲染音频…");
      return await offline.startRendering();
    }

    // 每块的帧范围按比例切，保证各块帧数之和精确等于 totalFrames
    const ranges = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const fromFrame = Math.round((totalFrames * index) / chunkCount);
      const toFrame = Math.round((totalFrames * (index + 1)) / chunkCount);
      ranges.push({
        fromSeconds: fromFrame / rate,
        toSeconds: toFrame / rate,
        frames: toFrame - fromFrame,
      });
    }
    const lookback = longest + REVERB.seconds + 0.5;
    const overlap = EXPORT_RENDER.overlapSeconds;

    // 阶段一：把所有块的音频图建好（同步）。必须建完再渲染——
    // 建图会改写全局音频状态，边建边渲染会互相踩。
    const built = ranges.map((range, index) => {
      const windowFrom = Math.max(0, range.fromSeconds - Math.max(lookback, overlap));
      const windowTo = Math.min(plan.totalSeconds, range.toSeconds + overlap);
      const windowFrames = Math.max(range.frames + 2, Math.ceil((windowTo - windowFrom) * rate) + 2);
      const offline = new OfflineContext(2, windowFrames, rate);
      schedulePlanWindow(offline, plan, windowFrom, windowTo, {
        sharedImpulse,
        shiftSeconds: -windowFrom,
      });
      return {
        offline,
        index,
        takeStart: Math.max(0, Math.round((range.fromSeconds - windowFrom) * rate)),
        frames: range.frames,
      };
    });

    if (onProgress) onProgress(0.25, `已排好 ${chunkCount} 段，正在并行渲染…`);
    // 阶段二：并行渲染（每个 startRendering 在不同线程上跑）
    const rendered = await Promise.all(built.map((job) => job.offline.startRendering()));

    // 阶段三：拼接
    if (onProgress) onProgress(0.85, "正在拼接音频…");
    const output = ruler.createBuffer(2, totalFrames, rate);
    const left = output.getChannelData(0);
    const right = output.getChannelData(1);
    let writeAt = 0;
    for (let index = 0; index < built.length; index += 1) {
      const job = built[index];
      const buffer = rendered[index];
      const available = Math.max(0, Math.min(job.frames, buffer.length - job.takeStart));
      if (available > 0) {
        left.set(buffer.getChannelData(0).subarray(job.takeStart, job.takeStart + available), writeAt);
        right.set(buffer.getChannelData(1).subarray(job.takeStart, job.takeStart + available), writeAt);
      }
      writeAt += job.frames;
      // 拼完这一块就释放它：长曲 8 块 × 几十 MB，早释放能明显压低峰值内存（少触发大 GC）。
      rendered[index] = null;
    }
    return output;
  } finally {
    restoreAudioState(saved);
    state.exportReverbSeed = previousSeed;
  }
}


/** 懒加载本地 MP3 编码器（vendor/lamejs，不联网）。 */
let lameLoading = null;
function loadLame() {
  if (window.lamejs || window.Mp3Encoder) return Promise.resolve(true);
  if (lameLoading) return lameLoading;
  lameLoading = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "vendor/lamejs/lame.min.js";
    script.onload = () => {
      // lamejs 单文件是「函数」形式，调用后才挂到全局
      if (typeof window.lamejs === "function" && !window.Mp3Encoder) {
        try { window.lamejs(); } catch (error) { console.info("lamejs 初始化失败", error); }
      }
      resolve(Boolean(window.lamejs && window.lamejs.Mp3Encoder));
    };
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
  return lameLoading;
}

/** PCM（左右声道 Float32）→ MP3 Blob。 */
function encodeMp3(left, right, sampleRate = AUDIO_EXPORT_RATE, kbps = AUDIO_EXPORT_KBPS) {
  const Encoder = window.lamejs && window.lamejs.Mp3Encoder;
  if (!Encoder) throw new Error("MP3 编码器不可用");
  const encoder = new Encoder(2, sampleRate, kbps);
  const leftPcm = new Int16Array(left.length);
  const rightPcm = new Int16Array(right.length);
  for (let index = 0; index < left.length; index += 1) {
    leftPcm[index] = Math.max(-32768, Math.min(32767, Math.round(left[index] * 32767)));
    rightPcm[index] = Math.max(-32768, Math.min(32767, Math.round(right[index] * 32767)));
  }
  const chunks = [];
  const blockSize = 1152;
  for (let offset = 0; offset < leftPcm.length; offset += blockSize) {
    const leftChunk = leftPcm.subarray(offset, offset + blockSize);
    const rightChunk = rightPcm.subarray(offset, offset + blockSize);
    const encoded = encoder.encodeBuffer(leftChunk, rightChunk);
    if (encoded.length > 0) chunks.push(new Int8Array(encoded));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Int8Array(tail));
  return new Blob(chunks, { type: "audio/mpeg" });
}

/**
 * 把一段 AudioBuffer 里的声道「原地」归一化到目标峰值。
 *
 * 为什么不再复制两份新数组：一段 11 分钟的立体声音频是 2 × 121 MB，
 * 旧写法 normalizePeak 会再复制两份（峰值扫描后再 scale），内存一下子翻三倍，
 * 浏览器光 GC 就要卡很久。这里直接改原数组，只多算一遍峰值。
 *
 * @returns {{gain: number, left: Float32Array, right: Float32Array}}
 */
function normalizeBufferInPlace(buffer, target = 0.89) {
  const channels = [];
  for (let index = 0; index < buffer.numberOfChannels; index += 1) channels.push(buffer.getChannelData(index));
  let peak = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      const value = Math.abs(channel[index]);
      if (value > peak) peak = value;
    }
  }
  const gain = peak <= 1e-6 ? 1 : Math.min(8, target / peak);
  if (gain !== 1) {
    for (const channel of channels) {
      for (let index = 0; index < channel.length; index += 1) channel[index] *= gain;
    }
  }
  const left = channels[0] || new Float32Array(0);
  const right = channels[1] || left;
  return { gain, left, right };
}

/**
 * 用 Web Worker + WebAssembly 版 LAME 编码 MP3。
 *
 * 两个好处：
 *  · 速度：wasm 版 LAME 比纯 JS 的 lamejs 快约 3–5 倍（实测 120 秒音频 3.48 s → 1.06 s）；
 *  · 不卡界面：编码在 Worker 里跑，主线程能继续响应点击/滚动（旧写法编码 11 分钟音频要卡 30 多秒）。
 *
 * 输入是主线程的 Float32Array，用 transferable 直接转移（零拷贝、主线程立刻释放内存）。
 * 编码完成后 Worker 把 MP3 字节转移回来，这里拼成 Blob。
 *
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {{kbps?: number, onProgress?: (fraction: number) => void}} options
 * @returns {Promise<Blob>}
 */
function encodeMp3WithWorker(left, right, { kbps = AUDIO_EXPORT_KBPS, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker("./vendor/mp3-encode-worker.js", { type: "module" });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (action, payload) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      worker = null;
      action(payload);
    };
    worker.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "progress") {
        if (typeof onProgress === "function") onProgress(Math.min(1, Math.max(0, Number(message.done) || 0)));
        return;
      }
      if (message.type === "done") {
        finish(resolve, new Blob([message.mp3], { type: "audio/mpeg" }));
        return;
      }
      if (message.type === "error") finish(reject, new Error(message.message || "MP3 编码失败"));
    });
    worker.addEventListener("error", (event) => finish(reject, new Error((event && event.message) || "MP3 编码 Worker 出错")));
    // 声道数据用 transferable 转移：不复制，主线程这边立刻可回收（之后不能再读这两个数组）
    const transfer = [];
    if (left.buffer && left.byteLength) transfer.push(left.buffer);
    if (right !== left && right.buffer && right.byteLength) transfer.push(right.buffer);
    const payload = {
      type: "encode",
      left,
      right,
      sampleRate: AUDIO_EXPORT_RATE,
      kbps,
    };
    try {
      worker.postMessage(payload, transfer);
    } catch (error) {
      // 某些老浏览器不允许 transfer（或 buffer 已被 detach）：退回普通结构化克隆
      try {
        worker.postMessage(payload);
      } catch (secondError) {
        finish(reject, secondError);
      }
    }
  });
}

/** WAV 兜底（16 位 PCM 立体声）。 */
function encodeWav(left, right, sampleRate = AUDIO_EXPORT_RATE) {
  const frames = left.length;
  const bytesPerSample = 2;
  const dataSize = frames * 2 * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 2, true);          // 立体声
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2 * bytesPerSample, true);
  view.setUint16(32, 2 * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let index = 0; index < frames; index += 1) {
    view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(left[index] * 32767))), true);
    view.setInt16(offset + 2, Math.max(-32768, Math.min(32767, Math.round(right[index] * 32767))), true);
    offset += 4;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * 导出音频主流程（按钮入口）。
 *
 * 「任意音高 / 任意响度 / 任意乐器 / 任意声部 / 任意片段」分别对应：
 *   音高 → 右下「整体移调」+ 声部八度下拉（都进 buildAudioPlan）
 *   响度 → 声部音量滑条
 *   乐器 → 全局音色 + 逐声部音色
 *   声部 → 声部勾选
 *   片段 → 音符选区（点序号 / Shift+点）
 */
async function exportAudio() {
  const exportStartedAt = performance.now();
  const playbackNotes = getPlaybackNotes();
  if (!playbackNotes.length) {
    showToast("还没有音符，先识别或导入一份乐谱。");
    return;
  }
  if (state.isPlaying) stopPlayback();
  const selection = selectionRange();
  const { notes: timelineNotes } = playbackTimeline();
  const offset = timelineNotes.length
    ? Math.min(...timelineNotes.map((note) => Number(note.startBeat) || 0))
    : 0;
  const scoreInfo = state.scoreInfo || {};
  const tempoPlan = playbackTempoSegments(scoreInfo.tempoMarks || [], {
    offset: 0,
    userBpm: clampTempo(Number(els.tempoInput.value) || 84),
    detectedBpm: scoreInfo.tempo,
  });
  const beatRange = selection
    ? (() => {
        const starts = selection.ids
          .map((id) => state.notes.find((note) => note.id === id))
          .filter(Boolean)
          .map((note) => Number(note.startBeat) || 0);
        const ends = selection.ids
          .map((id) => state.notes.find((note) => note.id === id))
          .filter(Boolean)
          .map((note) => (Number(note.startBeat) || 0) + beatsForNote(note));
        return starts.length ? { fromBeat: Math.min(...starts), toBeat: Math.max(...ends) } : null;
      })()
    : null;
  const plan = buildAudioPlan({
    notes: playbackNotes,
    tempoSegments: [{ beat: 0, bpm: tempoPlan.startBpm }, ...tempoPlan.segments],
    startBpm: tempoPlan.startBpm,
    enabledParts: null,
    partTimbres: state.partTimbres,
    globalTimbre: state.timbre,
    partVolumes: state.partVolumes,
    // 声部八度修正已经写进了 note.midi（setPartOctave 直接改音符），这里不再重复加；
    // 「整体移调」输入框还没写进音符，所以要在计划里加。
    partTranspose: new Map(),
    transpose: Number(els.transposeInput && els.transposeInput.value) || 0,
    selection: beatRange,
    tailSeconds: 2.5,
  });
  if (!plan.notes.length) {
    showToast("选中范围内没有音符。");
    return;
  }
  const totalText = formatDuration(plan.totalSeconds);
  const message = selection
    ? `准备导出选中片段（${plan.notes.length} 个音，约 ${totalText}）`
    : `准备导出整曲（${plan.notes.length} 个音，约 ${totalText}）`;
  els.audioExportLabel.textContent = "正在渲染…";
  els.audioButton.disabled = true;
  showToast(message + "，请稍候…");
  try {
    // 采样音源没准备好就渲染，那些声部会退回合成音色（和试听不一致）。
    // 这里把用到的采样音源先都加载完。
    let bankMark = performance.now();
    const neededTimbres = new Set();
    for (const key of plan.partKeys) neededTimbres.add(timbreForPart(key));
    for (const timbre of neededTimbres) {
      if (!isSampledTimbre(timbre)) continue;
      els.audioExportLabel.textContent = "载入音源…";
      try {
        await ensureSampleBank(timbre);
      } catch (error) {
        console.info("音源加载失败，这段会用合成音色", timbre, error);
      }
    }
    const bankMs = Math.round(performance.now() - bankMark);
    els.audioExportLabel.textContent = "正在渲染…";
    els.audioExportLabel.textContent = "渲染中…";
    const exportStats = { seconds: Math.round(plan.totalSeconds), notes: plan.notes.length };
    exportStats.prepareMs = Math.round(performance.now() - exportStartedAt);
    exportStats.bankMs = bankMs;
let exportMark = performance.now();
    const buffer = await renderPlanToBuffer(plan, {
      onProgress: (fraction, label) => {
        // 复用识别进度条的位置，但文案必须说清是「导出」，否则用户以为是又在识别
        setRecognizeProgress(fraction, 1, `导出音频 · ${label}`);
        els.recognizeProgress.hidden = false;
      },
    });
    exportStats.renderMs = Math.round(performance.now() - exportMark);
    exportMark = performance.now();
    // 峰值归一化改成原地做：不再整段复制两份数组（长曲能省几百 MB 内存、少一次大 GC）。
    const normalized = normalizeBufferInPlace(buffer, 0.89);
    exportStats.normalizeMs = Math.round(performance.now() - exportMark);
    exportMark = performance.now();
    const left = normalized.left;
    const right = normalized.right;
    els.audioExportLabel.textContent = "编码中…";
    setRecognizeProgress(0.95, 1, "导出音频 · 正在压缩成 MP3…");
    let blob = null;
    let extension = "wav";
    // 首选：Worker + wasm LAME（快、不卡界面）；不可用时退回原来的纯 JS 编码器。
    if (typeof Worker === "function") {
      try {
        blob = await encodeMp3WithWorker(left, right, {
          onProgress: (fraction) => setRecognizeProgress(0.95 + 0.04 * fraction, 1,
            `导出音频 · 正在压缩成 MP3…（${Math.round(fraction * 100)}%）`),
        });
        extension = "mp3";
      } catch (error) {
        console.info("wasm MP3 编码不可用，退回内置编码器", error);
        blob = null;
      }
    }
    if (!blob && await loadLame()) {
      try {
        blob = encodeMp3(left, right);
        extension = "mp3";
      } catch (error) {
        console.info("MP3 编码失败，改用 WAV", error);
      }
    }
    if (!blob) {
      blob = encodeWav(left, right);
      extension = "wav";
      showToast("MP3 编码器不可用，已导出 WAV（音质更好，体积更大）。");
    }
    exportStats.encodeMs = Math.round(performance.now() - exportMark);
    exportStats.extension = extension;
    exportStats.totalMs = exportStats.prepareMs + exportStats.renderMs
      + exportStats.normalizeMs + exportStats.encodeMs;
    state.lastExportStats = exportStats;
    console.info("[导出计时]", exportStats);
    const name = audioFileName(els.scoreTitle.textContent || (state.file && state.file.name) || "谱见",
      beatRange, extension);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (extension === "mp3") {
      const sizeMb = (blob.size / 1024 / 1024).toFixed(1);
      showToast(`已导出 ${name}（${totalText}，${sizeMb} MB）。`);
    }
  } catch (error) {
    console.error(error);
    showToast("导出音频失败：" + ((error && error.message) || "未知错误"));
  } finally {
    els.audioExportLabel.textContent = "↓ MP3";
    els.audioButton.disabled = false;
    els.recognizeProgress.hidden = true;
  }
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
// 界面偏好（音色等）存本地：关掉网页再打开还是上次选的音色。
// localStorage 在隐私模式/file:// 下可能不可用，所以读写都要能容忍失败。
const SETTINGS_KEY = "pujian.settings.v1";
function loadSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveSettings(patch) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch }));
  } catch {
    // 浏览器不让用本地存储时忽略即可，不影响播放。
  }
}
/** 某个声部当前的音量（0–1）；默认 1（不衰减）。 */
function partVolume(key) {
  const value = state.partVolumes.get(key);
  return Number.isFinite(value) ? value : 1;
}
/** 设置声部音量：正在播放时立刻改总线增益，声音会实时变化且不停播。 */
function setPartVolume(key, value) {
  const volume = Math.min(1, Math.max(0, Number(value)));
  state.partVolumes.set(key, volume);
  const bus = state.partBuses.get(key);
  if (bus) {
    try {
      bus.gain.setTargetAtTime(volume, state.audio.currentTime, 0.02);
    } catch {
      bus.gain.value = volume;
    }
  }
}
/** 某个声部单独选的音色；空字符串表示「跟随全局音色」。 */
function partTimbre(key) {
  const chosen = state.partTimbres.get(String(key));
  return chosen && TIMBRE_LABELS[chosen] ? chosen : "";
}
/**
 * 给某个声部单独指定音色（下次播放生效）；value 为空表示跟随全局。
 * 返回 false 表示这次选择没被接受（例如选了「真实钢琴」但采样音源还没安装）。
 */
/** 这个声部当前的八度修正量（±几）。 */
function partOctave(key) {
  return state.partOctaves.get(String(key)) || 0;
}

/** 把某个声部的所有音符整体升降八度（识别结果整声部高/低八度时用；不影响其它声部）。 */
function setPartOctave(key, octaves) {
  const id = String(key);
  const target = Math.max(-2, Math.min(2, Math.round(Number(octaves) || 0)));
  const delta = target - partOctave(id);
  if (!delta) {
    state.partOctaves.set(id, target);
    return;
  }
  stopPlayback();
  for (const note of state.notes) {
    if (voiceIdentity(note) !== id) continue;
    note.midi = Math.max(0, Math.min(127, note.midi + delta * 12));
    note.pitch = midiToPitchName(note.midi);
  }
  state.partOctaves.set(id, target);
  updatePartPitchRows(id);
  refreshScoreOverlay();
  const name = partDisplayName(id, id);
  showToast(target === 0
    ? `「${name}」已还原到原八度。`
    : `「${name}」已${target > 0 ? "升" : "降"} ${Math.abs(target)} 个八度（只改这个声部，可再选「原八度」还原）。`);
}

function setPartTimbre(key, value) {
  if (value && isSampledTimbre(value) && state.sampleManifest && !state.sampleManifest.banks[value]) {
    showToast("还没安装真实音源：双击项目里的「安装真实音源.bat」，装好后刷新页面再选。");
    return false;
  }
  clearTimbreCache();
  if (value && TIMBRE_LABELS[value]) {
    state.partTimbres.set(String(key), value);
    if (isSampledTimbre(value)) ensureSampleBank(value);
  } else {
    state.partTimbres.delete(String(key));
  }
  savePartTimbres();
  if (state.isPlaying) showToast("音色会在下次播放时生效（不打断当前演奏）。");
  return true;
}
/** 把逐声部音色记到本地，下次打开同一份乐谱还是这套设置。 */
function savePartTimbres() {
  const table = {};
  for (const [key, value] of state.partTimbres) table[key] = value;
  saveSettings({ partTimbres: table });
}
/** 从本地设置恢复逐声部音色（只恢复当前乐谱里真实存在的声部，避免越积越多）。 */
function restorePartTimbres(aliveKeys) {
  const saved = loadSettings().partTimbres;
  if (!saved || typeof saved !== "object") return;
  const alive = new Set(aliveKeys.map(String));
  for (const key of [...state.partTimbres.keys()]) if (!alive.has(key)) state.partTimbres.delete(key);
  for (const [key, value] of Object.entries(saved)) {
    if (alive.has(key) && TIMBRE_LABELS[value]) state.partTimbres.set(key, value);
  }
}

/**
 * 声部的立体声位置（-1 左 … 0 中 … +1 右）。
 *
 * 为什么值得做：合唱团在舞台上本来就是左右铺开的，各声部全堆在正中间会显得像"一个合成器
 * 叠了几层"。把女高/女低/男高/男低按顺序左右铺开（钢琴伴奏居中），听感立刻更像一群人。
 */
function panForPart(key) {
  const parts = collectParts();
  const self = parts.find((part) => part.key === key);
  if (!self || self.piano) return 0;
  const vocal = parts.filter((part) => !part.piano);
  const position = vocal.findIndex((part) => part.key === key);
  if (vocal.length < 2 || position < 0) return 0;
  // 最左 -0.55、最右 +0.55，中间均匀分布；不要贴到 ±1，否则单侧耳朵会明显变闷。
  return ((position / (vocal.length - 1)) * 1.1 - 0.55);
}

/** 取（或建）某个声部的音量总线：每个声部一条 GainNode → 立体声定位 → 主链。 */
function partBus(key) {
  if (!state.audio) return null;
  let bus = state.partBuses.get(key);
  if (!bus) {
    bus = state.audio.createGain();
    bus.gain.value = partVolume(key);
    try {
      const panner = state.audio.createStereoPanner();
      panner.pan.value = panForPart(key);
      bus.connect(panner).connect(masterChain());
      state.partPanners.set(key, panner);
    } catch {
      // 浏览器不支持立体声定位时退回单声道总线，不影响播放。
      bus.connect(masterChain());
    }
    state.partBuses.set(key, bus);
  }
  return bus;
}
/** 释放声部音量总线（换文件时调用）；音量设置本身保留，下次播放按新总线重建。 */
function disposePartBuses() {
  for (const bus of state.partBuses.values()) {
    try { bus.disconnect(); } catch { /* 已释放 */ }
  }
  for (const panner of state.partPanners.values()) {
    try { panner.disconnect(); } catch { /* 已释放 */ }
  }
  state.partBuses.clear();
  state.partPanners.clear();
}
/** 力度数值（约等于 MIDI velocity）→ 音量峰值；h 约 0.10、mf（89）约 0.18。 */
function gainForDynamics(value) {
  if (!Number.isFinite(value)) return 0.16;
  return Math.min(0.3, Math.max(0.05, 0.16 * (value / 80)));
}
// ===== 播放音色引擎 =====
// 2026-10 重写：以前每个音符只是一枚三角波，听起来像电子琴。现在按乐器分别合成：
//   钢琴：泛音加法（PeriodicWave）+ 低通「亮度包络」（起音亮、余音暖）+ 击弦噪声 + 两段衰减；
//   合唱：声带锯齿波 + 三段共振峰滤波（元音）+ 颤音 + 气口噪声，按声部微调元音，合起来像一群人；
//   管风琴：脚键基音 + 八度/五度定音管，慢起音、长释放；
//   电子琴：柔和三角波（原来的音色，适合只听音高）。
// 另外所有声部共用一条「干声 + 混响 + 压限」主链，整体更像在音乐厅里听到的效果。
// 所有音色的音量峰值都在 0–0.3 之间，压限器负责多声部叠加时不削波。
// 泛音表、共振峰、包络时间这些「乐理/声学参数」都在 timbre.js 里，可以被单元测试直接验证。

/** 设置播放音色（只在下次播放生效；正在放的音符不重建，避免播到一半音色突变）。 */
function setTimbre(value) {
  clearTimbreCache();
  if (!TIMBRE_LABELS[value]) return;
  if (isSampledTimbre(value)) {
    // 清单是异步读的：刚打开页面就点也可能还没读到，所以不在这里下"没安装"的结论，
    // 交给 ensureSampleBank 去读；真读不到再回滚并提示。
    ensureSampleBank(value).then((bank) => {
      if (bank) return;
      showToast("还没安装真实音源：双击项目里的「安装真实音源.bat」，装好后刷新页面再选。");
      if (state.timbre !== value) return;
      state.timbre = SAMPLED_TIMBRES[value].fallback;
      if (els.timbreSelect) els.timbreSelect.value = state.timbre;
    });
  }
  state.timbre = value;
  saveSettings({ timbre: value });
  if (els.timbreSelect) els.timbreSelect.value = value;
  if (els.timbreHint) els.timbreHint.textContent = "各声部可单独选";
  showToast("全局音色已切换为「" + TIMBRE_LABELS[value] + "」，下次播放生效。");
}

/**
 * 音频主链（懒创建）：所有声部总线 → 干声 + 混响两个支路 → 压限器 → 输出。
 * 压限器不是为了"响"，而是多声部同时进音时防止削波爆音；
 * 混响用一个程序生成的脉冲响应（指数衰减噪声），模拟音乐厅的余音。
 */
function masterChain() {
  const audio = state.audio;
  if (state.master) return state.master;
  const master = audio.createGain();
  master.gain.value = 0.92;
  const dry = audio.createGain();
  dry.gain.value = 0.82;
  const reverb = audio.createConvolver();
  reverb.buffer = reverbBufferForPlayback(audio);
  const reverbTone = audio.createBiquadFilter();
  reverbTone.type = "lowpass";
  reverbTone.frequency.value = REVERB.tone;
  const wet = audio.createGain();
  wet.gain.value = REVERB.wet;
  const compressor = audio.createDynamicsCompressor();
  compressor.threshold.value = COMPRESSOR.threshold;
  compressor.knee.value = COMPRESSOR.knee;
  compressor.ratio.value = COMPRESSOR.ratio;
  compressor.attack.value = COMPRESSOR.attack;
  compressor.release.value = COMPRESSOR.release;
  // 软限幅（tanh）：压限器来不及压住的瞬态也不会顶到 0 dBFS 变成「啪」的爆音。
  // 比硬截断温和得多，密集和弦叠加时听到的是"饱满"而不是"噼噼啪啪"。
  const limiter = audio.createWaveShaper();
  limiter.curve = softClipCurve();
  limiter.oversample = "2x";
  master.connect(dry).connect(compressor);
  master.connect(reverb).connect(reverbTone).connect(wet).connect(compressor);
  compressor.connect(limiter).connect(audio.destination);
  state.master = master;
  return master;
}

/**
 * tanh 软限幅曲线：|x| 很小时就是 x（不改音色、不改响度），接近 ±1 时平滑压住。
 * 注意不能写成 tanh(k·x)/tanh(k)——那在 0 附近会放大 k/tanh(k) 倍（实测 +58%），
 * 密集织体反而更容易糊掉。
 */
function softClipCurve() {
  if (state.softClipCurve) return state.softClipCurve;
  const samples = 4096;
  const curve = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const x = (index / (samples - 1)) * 2 - 1;
    curve[index] = Math.tanh(x);
  }
  state.softClipCurve = curve;
  return curve;
}

/**
 * 提前把 AudioContext 建好。
 *
 * 为什么要提前：实测在这台机器上 `new AudioContext()` 要 **625 毫秒**（声卡/驱动初始化），
 * 如果拖到用户点「试听」那一刻才建，按钮会明显卡住——用户感受到的就是「一卡」。
 * 浏览器只要求**出声**要等用户手势，创建对象随时都可以：先在载入文件时建好（那会儿界面本来就忙），
 * 播放时只需要 `resume()`（几毫秒）。
 */
function prepareAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || state.audio) return;
  try {
    state.audio = new AudioContextClass();
  } catch (error) {
    console.info("音频初始化失败，播放时会再试一次。", error);
    state.audio = null;
    return;
  }
  // 当前选的是采样音色就顺手开始加载（后台进行，不影响界面）。
  if (isSampledTimbre(state.timbre)) ensureSampleBank(state.timbre);
  // 空闲时提前生成混响脉冲：否则第一次播放要同步算 1.9 秒的噪声，卡约 2 秒。
  prewarmReverb();
}
/** 程序生成混响脉冲响应：指数衰减的低通噪声 + 20 ms 预延迟，听起来像小音乐厅。 */
/**
 * 确定性伪随机（mulberry32 的变体）。
 *
 * 为什么需要：混响 IR 用 Math.random 生成，会让同一份谱每次导出的混响略有不同，
 * 也让「分块渲染」与「整块渲染」无法逐样本比对。导出时改用固定种子，结果可复现。
 */
function seededRandom(seed) {
  let state32 = seed >>> 0;
  return function next() {
    state32 = (state32 + 0x6d2b79f5) >>> 0;
    let t = state32;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成混响脉冲。seed 非空时用确定性随机（导出用），否则用 Math.random（试听用）。
 *
 * @param {BaseAudioContext} audio 任意上下文（AudioBuffer 可跨上下文使用）
 * @param {number} seconds 混响长度
 * @param {number} decay 衰减指数
 * @param {number|null} seed 固定种子；null 表示随机
 * @param {boolean} cache 是否写回 state.reverbBuffer（导出时应传 false，因为要跨块共享同一份）
 */
function makeReverbImpulse(audio, seconds, decay, seed, cache) {
  const rate = audio.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const impulse = audio.createBuffer(2, length, rate);
  const preDelay = Math.floor(rate * REVERB.preDelay);
  const random = seed === null || seed === undefined ? Math.random : seededRandom(seed);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    let smoothed = 0;
    for (let index = 0; index < length; index += 1) {
      const noise = random() * 2 - 1;
      // 一阶低通：高频先被空气吸收，余音因此偏暖而不是"嘶嘶"声。
      smoothed = smoothed * 0.55 + noise * 0.45;
      const progress = index / length;
      data[index] = index < preDelay ? 0 : smoothed * ((1 - progress) ** decay);
    }
  }
  if (cache !== false) state.reverbBuffer = impulse;
  return impulse;
}

function reverbImpulse(audio, seconds = REVERB.seconds, decay = REVERB.decay) {
  if (state.reverbBuffer) return state.reverbBuffer;
  return makeReverbImpulse(audio, seconds, decay, state.exportReverbSeed ?? null, true);
}

/**
 * 预热混响缓冲。
 *
 * 为什么需要：脉冲响应是**程序生成**的（1.9 秒 × 2 声道 × 44100 ≈ 16.8 万个采样点，
 * 每个点要 Math.random + 一阶低通），实测首次播放会阻塞主线程约 2.1 秒——
 * 用户感受就是「点播放后要等一下、开头卡一下」。
 * 这里在页面空闲时提前算好，第一次点播放就只剩建节点的时间。
 */
function prewarmReverb() {
  if (state.reverbBuffer || !state.audio) return;
  if (state.reverbWarming) return;
  state.reverbWarming = true;
  const build = () => {
    try {
      if (state.audio && !state.reverbBuffer) reverbImpulse(state.audio);
    } catch (error) {
      console.info("混响预热失败，播放时会用短混响顶替。", error);
    } finally {
      state.reverbWarming = false;
    }
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(build, { timeout: 2000 });
  } else {
    setTimeout(build, 300);
  }
}

/**
 * 拿到可用的混响缓冲：已预热就直接用；还没好就用一份短的临时脉冲，
 * 避免在「第一次点播放」这一刻同步建 1.9 秒的缓冲把主线程堵住。
 */
function reverbBufferForPlayback(audio) {
  // 预热成功：直接用（正常情况，点播放不再卡）
  if (state.reverbBuffer) return state.reverbBuffer;
  // 预热还没跑完（刚打开页面就点了播放）：同步建完整混响。
  // 这里**不降级成短混响**——混响长度直接决定「余音」，降级会让所有音色听起来变干，
  // 也会让 e2e 的频谱/余音断言失真。宁可这一次卡一下，也要保证音质一致。
  prewarmReverb();
  return reverbImpulse(audio);
}

/** 一段白噪声样本，用来做击弦声和气口声；整条音轨共用一条 buffer，不重复生成。 */
function noiseSampleBuffer(audio) {
  if (state.noiseBuffer) return state.noiseBuffer;
  const length = Math.max(1, Math.floor(audio.sampleRate * 0.35));
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  // 导出时用固定种子：分块并行渲染时每块各自建噪声 buffer，
  // 若用 Math.random 各块噪声不同，拼起来会有细微不一致，也无法复现。
  const random = state.exportReverbSeed == null
    ? Math.random
    : seededRandom(state.exportReverbSeed ^ 0x1f2e3d4c);
  for (let index = 0; index < length; index += 1) data[index] = random() * 2 - 1;
  state.noiseBuffer = buffer;
  return buffer;
}
/** 取（或建）某个音色用的周期波表；同一个音色只算一次。 */
function waveTable(name, harmonics) {
  const cached = state.waves.get(name);
  if (cached) return cached;
  const audio = state.audio;
  const real = new Float32Array(harmonics.length + 1);
  const imag = new Float32Array(harmonics.length + 1);
  harmonics.forEach((amplitude, index) => { imag[index + 1] = amplitude; });
  const wave = audio.createPeriodicWave(real, imag, { disableNormalization: false });
  state.waves.set(name, wave);
  return wave;
}
/**
 * 全局颤音：一枚 5.1 Hz 的 LFO 接到各个人声振荡器的 detune（单位音分）。
 * 只建一次、所有音符共用——比每个音符配一个 LFO 便宜得多。
 */
function vibratoDepth() {
  if (state.vibrato) return state.vibrato;
  const audio = state.audio;
  const lfo = audio.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = VIBRATO.rate;
  const depth = audio.createGain();
  depth.gain.value = VIBRATO.cents;
  lfo.connect(depth);
  lfo.start();
  state.vibrato = depth;
  return depth;
}
/**
 * 演奏人性化：真实演奏者不会每个音都严丝合缝，加一点点时点/力度/音高偏差。
 *
 * humanOverride：导出时由 plan 预先算好每个音的人性化值（见 audio-export.js）。
 * 为什么需要：导出要「同一份谱导出结果完全一致」，而且分块并行渲染时
 * 每个音的人性化值不能依赖「第几个被调度」——否则分块与整块渲染对不上。
 * playTone 一次只调一次 humanize，所以这个模块级变量只在同步的那一次调用里有效。
 */
let humanOverride = null;

function humanize(peak) {

  if (humanOverride) {

    return {

      offset: humanOverride.offset,

      peak: Math.max(0.02, peak * humanOverride.peakFactor),

      detune: humanOverride.detune,

    };

  }
  return {
    offset: (Math.random() - 0.5) * HUMANIZE.offset,
    peak: Math.max(0.02, peak * (1 - HUMANIZE.peak / 2 + Math.random() * HUMANIZE.peak)),
    detune: (Math.random() - 0.5) * HUMANIZE.detune,
  };
}
/**
 * 登记一个音的所有节点：
 * - 所有 source 进 state.sources，停止播放时由 stopPlayback 统一 stop；
 * - 最后一个 source 结束时把整组节点断开——连到 destination 的节点不会被自动回收，
 *   不断开的话反复试听会让音频图持续膨胀。
 */
function registerVoice(sources, nodes) {
  let remaining = sources.length;
  for (const source of sources) {
    state.sources.add(source);
    source.onended = () => {
      remaining -= 1;
      if (remaining > 0) return;
      for (const node of nodes) {
        try { node.disconnect(); } catch { /* 已断开 */ }
      }
      for (const item of sources) state.sources.delete(item);
    };
  }
}
/** 衰减到接近静音用的极小值；exponentialRamp 的目标不能是 0。 */
const SILENCE = 0.0001;

/** 建一条并联支路：把信号按 level 混到 destination，方便多条微失谐的弦/声部叠在一起。 */
function mixInto(destination, level) {
  const gain = state.audio.createGain();
  gain.gain.value = level;
  gain.connect(destination);
  return gain;
}

/** 钢琴：两条微失谐的「弦」+ 亮度包络 + 击弦噪声 + 两段衰减。 */
function playPianoTone(midi, startAt, duration, peak, destination) {
  const audio = state.audio;
  const human = humanize(peak);
  const at = Math.max(audio.currentTime + 0.001, startAt + human.offset);
  const frequency = midiFrequency(midi);
  const held = Math.max(0.05, duration);
  const damper = pianoDamperSeconds(midi);
  const shape = pianoDecayShape(human.peak);
  const target = destination || masterChain();
  // 三个时间点严格递增：短音符（十六分/三十二分）也不会出现「斜坡时间倒挂」——
  // 那会让 gain 瞬间跳变，听起来就是「啪」的一声杂音（这次用户报的噼啪声之一）。
  const tAttack = at + 0.006;
  const tDecay = at + Math.min(0.09, Math.max(0.012, held * 0.6));
  const tRelease = at + held;
  const tEnd = tRelease + damper;

  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.6;
  const { start: bright, end: mellow } = pianoBrightness(frequency, human.peak);
  filter.frequency.setValueAtTime(Math.min(audio.sampleRate * 0.45, bright), at);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(220, mellow),
    at + Math.max(0.18, Math.min(0.9, held * 0.9)),
  );
  filter.connect(target);

  const envelope = audio.createGain();
  envelope.gain.setValueAtTime(SILENCE, at);
  envelope.gain.exponentialRampToValueAtTime(human.peak, tAttack);
  envelope.gain.exponentialRampToValueAtTime(shape[1].level, tDecay);
  envelope.gain.exponentialRampToValueAtTime(shape[2].level, tRelease);
  envelope.gain.exponentialRampToValueAtTime(SILENCE, tEnd);
  envelope.connect(filter);

  const wave = waveTable("piano", PIANO_HARMONICS);
  const sources = [];
  const nodes = [filter, envelope];
  // 真实钢琴同一个音有 2–3 根弦，调律后仍有 1–3 音分偏差：两条微失谐的弦叠加，
  // 会产生缓慢起伏的「拍音」，这是钢琴听起来厚实、不像电子琴的关键。
  for (const [level, cents] of PIANO_STRINGS) {
    const oscillator = audio.createOscillator();
    oscillator.setPeriodicWave(wave);
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.detune.setValueAtTime(human.detune + cents, at);
    if (level >= 0.99) {
      oscillator.connect(envelope);
    } else {
      const branch = mixInto(envelope, level);
      oscillator.connect(branch);
      nodes.push(branch);
    }
    oscillator.start(at);
    oscillator.stop(tEnd + 0.02);
    sources.push(oscillator);
    nodes.push(oscillator);
  }

  // 击弦声：极短的一段带通噪声，补上「木头+毡槌」的触感。
  // 只给不是特别短的音加——十六分音符以下加了这个反而像噪声。
  if (held >= 0.1) {
    const hammer = audio.createBufferSource();
    hammer.buffer = noiseSampleBuffer(audio);
    const hammerBand = audio.createBiquadFilter();
    hammerBand.type = "bandpass";
    hammerBand.frequency.value = Math.min(4200, Math.max(600, frequency * 5));
    hammerBand.Q.value = 1.1;
    const hammerGain = audio.createGain();
    hammerGain.gain.setValueAtTime(SILENCE, at);
    hammerGain.gain.exponentialRampToValueAtTime(Math.max(SILENCE * 2, human.peak * 0.05), at + 0.002);
    hammerGain.gain.exponentialRampToValueAtTime(SILENCE, at + 0.035);
    hammer.connect(hammerBand).connect(hammerGain).connect(target);
    hammer.start(at);
    hammer.stop(at + 0.05);
    sources.push(hammer);
    nodes.push(hammer, hammerBand, hammerGain);
  }
  registerVoice(sources, nodes);
}

/**
 * 合唱人声：两条微失谐的声带波 + 三段共振峰（元音）+ 全局颤音 + 气口噪声。
 * `female=true` 时用女声共振峰表、再提一点高频——性别听感主要由共振峰决定。
 */
function playChoirTone(midi, startAt, duration, peak, destination, vowel, { female = false } = {}) {
  const audio = state.audio;
  const human = humanize(peak);
  const at = Math.max(audio.currentTime + 0.001, startAt + human.offset);
  const frequency = midiFrequency(midi);
  const held = Math.max(0.05, duration);
  const target = destination || masterChain();
  const sources = [];
  const nodes = [];

  // 三段共振峰串起来（峰值滤波）：F1/F2 决定唱的是哪个元音，F3 提供人声的「亮」。
  const formantTable = female ? FEMALE_VOWELS : VOWELS;
  let head = null;
  let previous = null;
  for (const [hz, strength, bandwidth] of formantTable[vowel] || formantTable.a) {
    const formant = audio.createBiquadFilter();
    formant.type = "peaking";
    formant.frequency.value = Math.min(audio.sampleRate * 0.45, hz);
    formant.Q.value = Math.max(0.6, hz / bandwidth);
    formant.gain.value = 10 * strength;
    if (previous) previous.connect(formant);
    previous = formant;
    if (!head) head = formant;
    nodes.push(formant);
  }

  // 女声再补一点高频「空气感」，和混声/男声区分得更明显。
  let outputTail = previous;
  if (female) {
    const air = audio.createBiquadFilter();
    air.type = "highshelf";
    air.frequency.value = 2600;
    air.gain.value = 3.5;
    previous.connect(air);
    outputTail = air;
    nodes.push(air);
  }
  const envelope = audio.createGain();
  // 人声起音比钢琴慢，但开头 12 ms 内要有一个"轻但立刻听得见"的起声，
  // 否则短音符会显得含糊（原来从 -80 dB 指数上升，前 50 ms 几乎没声音）。
  envelope.gain.setValueAtTime(SILENCE, at);
  envelope.gain.exponentialRampToValueAtTime(
    Math.max(SILENCE * 2, human.peak * CHOIR_ENVELOPE.onset), at + CHOIR_ENVELOPE.onsetTime);
  envelope.gain.exponentialRampToValueAtTime(human.peak, at + CHOIR_ENVELOPE.attack);
  envelope.gain.exponentialRampToValueAtTime(
    Math.max(SILENCE * 2, human.peak * CHOIR_ENVELOPE.sustain),
    at + Math.min(CHOIR_ENVELOPE.decay, held * 0.8),
  );
  envelope.gain.setValueAtTime(Math.max(SILENCE * 2, human.peak * CHOIR_ENVELOPE.hold), at + held);
  envelope.gain.exponentialRampToValueAtTime(SILENCE, at + held + CHOIR_ENVELOPE.release);
  outputTail.connect(envelope);
  envelope.connect(target);
  nodes.push(envelope);

  const vibrato = vibratoDepth();
  // 两条微失谐的声带波叠出「一群人」而不是「一个人」。
  for (const [level, cents] of [[1, -6], [0.7, 7]]) {
    const oscillator = audio.createOscillator();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.detune.setValueAtTime(human.detune + cents, at);
    vibrato.connect(oscillator.detune);
    if (level >= 0.99) {
      oscillator.connect(head);
    } else {
      const branch = mixInto(head, level);
      oscillator.connect(branch);
      nodes.push(branch);
    }
    oscillator.start(at);
    oscillator.stop(at + held + CHOIR_ENVELOPE.release + 0.05);
    sources.push(oscillator);
    nodes.push(oscillator);
  }

  // 气口噪声：换气声，几乎听不见但让声音「有人味」。短音符不加。
  if (held >= 0.12) {
    const breath = audio.createBufferSource();
    breath.buffer = noiseSampleBuffer(audio);
    const breathFilter = audio.createBiquadFilter();
    breathFilter.type = "bandpass";
    breathFilter.frequency.value = Math.min(6000, Math.max(1200, frequency * 3));
    breathFilter.Q.value = 0.9;
    const breathGain = audio.createGain();
    breathGain.gain.setValueAtTime(SILENCE, at);
    breathGain.gain.exponentialRampToValueAtTime(Math.max(SILENCE * 2, human.peak * 0.03), at + 0.03);
    breathGain.gain.exponentialRampToValueAtTime(SILENCE, at + 0.16);
    breath.connect(breathFilter).connect(breathGain).connect(target);
    breath.start(at);
    breath.stop(at + 0.2);
    sources.push(breath);
    nodes.push(breath, breathFilter, breathGain);
  }
  registerVoice(sources, nodes);
}

/** 弦乐（小提琴/中提琴合奏）：三条微失谐的锯齿波 + 低通 + 慢起弓。 */
function playStringsTone(midi, startAt, duration, peak, destination) {
  const audio = state.audio;
  const human = humanize(peak);
  const at = Math.max(audio.currentTime + 0.001, startAt + human.offset);
  const frequency = midiFrequency(midi);
  const held = Math.max(0.06, duration);
  const target = destination || masterChain();
  const sources = [];
  const nodes = [];

  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.4;
  filter.frequency.setValueAtTime(Math.min(9000, frequency * 9 + 1000), at);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(700, frequency * 4.5 + 300),
    at + Math.max(0.25, Math.min(1.2, held * 0.6)),
  );

  const envelope = audio.createGain();
  // 弓弦的起音：先快速到 35%（弓毛刚抓住弦），再慢慢推到峰值，长音保持 72% 后松弓。
  const tOnset = at + 0.012;
  const tAttack = at + Math.min(STRINGS_ENVELOPE.attack, held * 0.5);
  const tSwell = at + Math.min(STRINGS_ENVELOPE.attack + STRINGS_ENVELOPE.swell, held * 0.8);
  const tRelease = at + held;
  envelope.gain.setValueAtTime(SILENCE, at);
  envelope.gain.exponentialRampToValueAtTime(Math.max(SILENCE * 2, human.peak * 0.35), tOnset);
  envelope.gain.exponentialRampToValueAtTime(human.peak, tAttack);
  envelope.gain.exponentialRampToValueAtTime(Math.max(SILENCE * 2, human.peak * STRINGS_ENVELOPE.sustain), tSwell);
  envelope.gain.setValueAtTime(Math.max(SILENCE * 2, human.peak * STRINGS_ENVELOPE.hold), tRelease);
  envelope.gain.exponentialRampToValueAtTime(SILENCE, tRelease + STRINGS_ENVELOPE.release);
  filter.connect(envelope);
  envelope.connect(target);
  nodes.push(filter, envelope);

  const vibrato = vibratoDepth();
  for (const [level, cents] of STRINGS_DETUNE) {
    const oscillator = audio.createOscillator();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.detune.setValueAtTime(human.detune + cents, at);
    vibrato.connect(oscillator.detune);
    if (level >= 0.99) {
      oscillator.connect(filter);
    } else {
      const branch = mixInto(filter, level);
      oscillator.connect(branch);
      nodes.push(branch);
    }
    oscillator.start(at);
    oscillator.stop(tRelease + STRINGS_ENVELOPE.release + 0.05);
    sources.push(oscillator);
    nodes.push(oscillator);
  }
  registerVoice(sources, nodes);
}

/** 管风琴：基音 + 八度 + 五度定音管，慢起音、柔和释放。 */
function playOrganTone(midi, startAt, duration, peak, destination) {
  const audio = state.audio;
  const human = humanize(peak);
  const at = Math.max(audio.currentTime + 0.001, startAt + human.offset);
  const held = Math.max(0.1, duration);
  const target = destination || masterChain();
  const oscillator = audio.createOscillator();
  oscillator.setPeriodicWave(waveTable("organ", ORGAN_HARMONICS));
  oscillator.frequency.setValueAtTime(midiFrequency(midi), at);
  oscillator.detune.setValueAtTime(human.detune * 0.6, at);
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 5200;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(SILENCE, at);
  gain.gain.exponentialRampToValueAtTime(
    Math.max(SILENCE * 2, human.peak * ORGAN_ENVELOPE.onset), at + ORGAN_ENVELOPE.onsetTime);
  gain.gain.exponentialRampToValueAtTime(human.peak * 0.8, at + Math.min(ORGAN_ENVELOPE.attack, held * 0.5));
  gain.gain.exponentialRampToValueAtTime(human.peak, at + Math.min(ORGAN_ENVELOPE.swell, held * 0.8));
  gain.gain.setValueAtTime(human.peak, at + held);
  gain.gain.exponentialRampToValueAtTime(SILENCE, at + held + ORGAN_ENVELOPE.release);
  oscillator.connect(filter).connect(gain).connect(target);
  oscillator.start(at);
  oscillator.stop(at + held + ORGAN_ENVELOPE.release + 0.04);
  registerVoice([oscillator], [oscillator, filter, gain]);
}

/** 电子琴（原音色）：柔和三角波，最省资源，适合只听音高。 */
function playSoftTone(midi, startAt, duration, peak, destination) {
  const audio = state.audio;
  const at = Math.max(audio.currentTime + 0.001, startAt);
  const held = Math.max(0.06, duration);
  const target = destination || masterChain();
  const oscillator = audio.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(midiFrequency(midi), at);
  const gain = audio.createGain();
  gain.gain.setValueAtTime(SILENCE, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.016);
  gain.gain.exponentialRampToValueAtTime(Math.max(SILENCE * 2, peak * 0.34), at + Math.min(0.18, held * 0.42) + 0.016);
  gain.gain.setValueAtTime(Math.max(SILENCE * 2, peak * 0.3), at + held);
  gain.gain.exponentialRampToValueAtTime(SILENCE, at + held + 0.06);
  oscillator.connect(gain).connect(target);
  oscillator.start(at);
  oscillator.stop(at + held + 0.09);
  registerVoice([oscillator], [oscillator, gain]);
}

/**
 * 把音色选项填进一个 <select>：按 TIMBRE_GROUPS 分 <optgroup>。
 * 共用一个函数，保证「全局音色」和「逐声部音色」两个下拉的内容永远一致。
 */
function fillTimbreOptions(select, { followGlobal = false } = {}) {
  if (!select) return;
  select.replaceChildren();
  if (followGlobal) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "跟随全局";
    select.append(option);
  }
  for (const group of TIMBRE_GROUPS) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const name of group.ids) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = TIMBRE_LABELS[name] || name;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
}

/** 最多同时保留几个采样音源在内存里（每个 20–40 MB，再多容易把老机器撑爆）。 */
const MAX_LOADED_SAMPLE_BANKS = 4;

/** 更新界面上的「真实音源」状态提示（装没装、加载到百分之几、哪些已就绪）。 */
function updateSampleStatus(message) {
  const element = els.sampleStatus;
  if (!element) return;
  if (message) {
    element.hidden = false;
    element.textContent = message;
    return;
  }
  if (!state.sampleManifest) {
    element.hidden = true;
    return;
  }
  const ready = [...state.sampleBanks.entries()].map(([name]) => TIMBRE_LABELS[name] || name);
  element.hidden = false;
  element.textContent = ready.length ? `真实音源已就绪：${ready.join("、")}` : "真实音源已安装（选中后自动加载）";
}

/**
 * 确保某个采样音源已加载（同一个音源只会加载一次）。
 * 没安装、加载失败都只返回 null，不抛错：调用方会自动退回合成音色，保证"总有声音"。
 */
function ensureSampleBank(name) {
  if (!isSampledTimbre(name)) return Promise.resolve(null);
  if (state.sampleBanks.has(name)) return Promise.resolve(state.sampleBanks.get(name));
  if (state.sampleLoading.has(name)) return state.sampleLoading.get(name);
  const promise = (async () => {
    if (!state.sampleManifest) state.sampleManifest = await fetchSampleManifest();
    if (!state.sampleManifest || !state.sampleManifest.banks[name]) {
      updateSampleStatus();
      return null;
    }
    updateSampleStatus(`正在加载${TIMBRE_LABELS[name] || name}…`);
    let shownPercent = 0;
    const bank = await loadSampleBank(state.sampleManifest, name, {
      onProgress: ({ done, total }) => {
        const percent = Math.round((done / Math.max(1, total)) * 100);
        if (percent - shownPercent >= 20) {
          shownPercent = percent;
          updateSampleStatus(`正在加载${TIMBRE_LABELS[name] || name} ${percent}%…`);
        }
      },
    });
    if (bank) {
      bank.ready = true;
      state.sampleBanks.set(name, bank);
      state.sampleOrder = state.sampleOrder.filter((item) => item !== name);
      state.sampleOrder.push(name);
      // 内存上限：采样音源每个要占 20–40 MB，只保留最近用过的几个（发出去的声音节点会自己握着 buffer 引用，
      // 从 map 里删掉不会让正在播的音断掉）。
      while (state.sampleOrder.length > MAX_LOADED_SAMPLE_BANKS) {
        const oldest = state.sampleOrder.shift();
        if (oldest && oldest !== name) state.sampleBanks.delete(oldest);
      }
      showToast(`${TIMBRE_LABELS[name] || name}已加载完成。`);
    }
    updateSampleStatus();
    return bank;
  })().catch((error) => {
    console.info("采样音源加载失败，已退回合成音色：", error);
    updateSampleStatus("真实音源加载失败（已自动退回合成音色）");
    return null;
  }).finally(() => state.sampleLoading.delete(name));
  state.sampleLoading.set(name, promise);
  return promise;
}

/**
 * 播放一个「采样音源」音符。
 *
 * 和合成音色的区别：音高靠 playbackRate 变速（样本每 3 个半音一个）、力度靠分层 + 增益；
 * 钢琴样本自带衰减，所以只需要在松键处做制音淡出；人声/弦乐是持续音，
 * 长音用样本里的零交叉循环点撑住（实测循环接缝无爆音）。
 */
/**
 * 采样音源的全局响度配平系数（1 = 保持原样）。
 *
 * 标定方法：在浏览器里用 OfflineAudioContext 渲染同一个 C4 长音，
 * 量测峰值/RMS，按「目标峰值 0.16」反推。实测（2026-10-19，本机 67 种音源）：
 *   真实钢琴 0.25、真实弦乐 0.11、真实合唱 0.13、二胡 0.069、木琴 0.06……
 *
 * 表里没列到的音源用 1（不配平）；用户仍可用「声部音量滑条」再微调。
 */
const BANK_LEVEL = {
  accordion_real: 1.068,    // group-peak
  acoustic_bass_real: 1.271,    // group-peak
  alto_sax_real: 1.343,    // group-peak
  banjo_real: 1.466,    // group-peak
  baritone_sax_real: 1.314,    // group-peak
  bassoon_real: 1.255,    // group-peak
  brass_section_real: 1.29,    // group-peak
  celesta_real: 1.241,    // group-peak
  cello_real: 1.489,    // group-peak
  choir_female: 1.444,    // group-peak
  choir_male: 1.142,    // group-peak
  choir_real: 1.406,    // measured-peak
  church_organ_real: 1.408,    // group-peak
  clarinet_real: 1.364,    // group-peak
  contrabass_real: 1.704,    // group-peak
  dizi_real: 1.445,    // group-peak
  electric_bass_real: 1.129,    // group-peak
  electric_guitar_real: 1.288,    // group-peak
  electric_piano_real: 0.916,    // group-peak
  english_horn_real: 1.378,    // group-peak
  erhu_real: 1.424,    // measured-peak
  zhonghu_real: 1.526,    // browser RMS (近似中提琴)
  gaohu_real: 1.47,    // browser RMS (近似小提琴)
  flute_real: 1.475,    // group-peak
  french_horn_real: 1.221,    // group-peak
  horn_real: 1.11,  // 与 french_horn_real 同用 french_horn 样本（manifest 有登记，SAMPLED_TIMBRES 未注册）
  fretless_bass_real: 1.182,    // group-peak
  glockenspiel_real: 1.457,    // group-peak
  guzheng_real: 1.397,    // group-peak
  zhongruan_real: 2.505,     // 浏览器实测 RMS 0.104 → 统一到 0.24（近似尼龙弦吉他）
  daruan_real: 0.96,    // browser RMS (近似原声贝斯)
  liuqin_real: 2.52,     // 浏览器实测 RMS 0.177 → 统一到 0.24（近似钢弦吉他）
  guanzi_real: 1.618,    // browser RMS (近似唢呐)
  xun_real: 1.468,    // browser RMS (近似陶笛)
  qudi_real: 1.458,    // browser RMS (近似长笛)
  yunluo_real: 0.957,    // browser RMS (近似管钟)
  pengling_real: 3.869,    // 浏览器实测 RMS 0.0276
  muyu_real: 4.5,    // 已换成 VCSL Cajon hit3 三层（原 Woodblock 电平过低）；实测 RMS 0.1248，与其它打击乐齐平
  xiaoluo_real: 1.206,    // 浏览器实测 RMS 0.0183
  daluo_real: 0.89,    // 浏览器实测 RMS 0.0201
  bo_real: 1.553,    // 浏览器实测 RMS 0.0548（原 2.6 偏响 3 倍）
  paigu_real: 3.043,    // 浏览器实测 RMS 0.0196
  harp_real: 1.239,    // group-peak
  harpsichord_real: 1.032,    // group-peak
  kalimba_real: 1.616,    // group-peak
  koto_real: 2.069,    // group-peak
  marimba_real: 1.45,  // group-peak
  nylon_guitar_real: 2.912,     // 浏览器实测 RMS 0.090 → 统一到 0.24（Meta Nylon 录音较轻）  // group-peak
  oboe_real: 1.501,    // group-peak
  ocarina_real: 1.439,    // group-peak
  pad_real: 1.449,    // group-peak
  pan_flute_real: 1.363,    // group-peak
  piano_real: 0.335,     // 浏览器实测 RMS 0.476 → 统一到 0.24（峰值 0.39，不削波）  // measured-peak
  piccolo_real: 1.418,    // group-peak
  pipa_real: 1.702,    // group-peak
  pizzicato_real: 1.716,    // group-peak
  recorder_real: 1.396,    // group-peak
  shakuhachi_real: 1.368,    // group-peak
  shamisen_real: 1.508,    // group-peak
  sheng_real: 1.51,    // group-peak
  sitar_real: 1.348,    // group-peak
  soprano_sax_real: 1.427,    // group-peak
  steel_drums_real: 1.189,    // group-peak
  steel_guitar_real: 2.437,     // 浏览器实测 RMS 0.169 → 统一到 0.24  // group-peak
  strings_real: 1.428,    // measured-peak
  suona_real: 1.605,    // group-peak
  synth_choir_real: 1.362,    // group-peak
  synth_lead_real: 1.335,    // group-peak
  tenor_sax_real: 1.278,    // group-peak
  timpani_real: 1.191,    // group-peak
  tremolo_real: 1.329,    // group-peak
  trombone_real: 1.227,    // group-peak
  trumpet_real: 1.219,    // group-peak
  tuba_real: 1.188,    // group-peak
  tubular_bells_real: 1.304,    // group-peak
  vibraphone_real: 1.039,    // group-peak
  viola_real: 1.403,    // group-peak
  violin_real: 1.395,    // group-peak
  voice_oohs_real: 1.321,    // group-peak
  whistle_real: 1.276,    // group-peak
  xiao_real: 1.338,    // group-peak
  xylophone_real: 1.609,    // group-peak
  yangqin_real: 1.827,    // group-peak
};

/** 某个 bank 的响度配平系数（没标定的用 1）。 */
function bankLevelFor(bank) {
  const name = bank && bank.name;
  return BANK_LEVEL[name] || 1;
}

function playSampledTone(timbre, bank, midi, startAt, duration, peak, destination) {
  const audio = state.audio;
  const human = humanize(peak);
  const at = Math.max(audio.currentTime + 0.001, startAt + human.offset * 0.5);
  const held = Math.max(0.06, duration);
  const target = destination || masterChain();
  // gainForDynamics 给的是 0.05–0.3：归一化成 0–1 当作"力度"。
  const velocity = Math.min(1, Math.max(0, (peak - 0.05) / 0.25));
  const found = lookupSample(bank, midi, velocity);
  if (!found) return false;
  const { sample, layer, playbackRate } = found;
  // 响度标定：FluidR3/Salamander 的 mp3 录得很轻（原始 RMS 只有 0.01 左右），
  // 直接乘 peak 会小 10 倍以上；这里按每层样本的实测 RMS 反推增益，做成和合成音色一样响。
  // 再叠一个表情系数（pp 0.55 → ff 1.25），让强弱记号仍然听得出来。
  const expression = bank.continuous ? 0.62 + 0.62 * velocity : 0.8 + 0.45 * velocity;
  const layerRms = Math.max(0.0008, layer.medianRms || 0.01);
  const sampleTrim = sample.trim || 1;
  // 响度配平分两步，缺一不可：
  // 1) layerRms 归一（原有）：抹平「同一乐器不同音区」的音量差；
  // 2) bank 归一（新增）：抹平「乐器之间」的录音电平差。
  //    实测同力度峰值：真实钢琴 0.25、真实弦乐 0.11、二胡 0.069 —— 相差 3.6 倍，
  //    用户听到的就是「钢琴很响、二胡几乎听不见」。只用固定增益表抹不平
  //    （二胡要 2.3 倍才够，那样噪声也被放大），所以按每个 bank 加载时实测的
  //    响度归一到 SAMPLED_TARGET_RMS，再用 BANK_LEVEL 做 final polish。
  const bankLevel = bankLevelFor(bank);
  const observedRms = Math.max(bank.oneShot ? 0.00001 : 0.0008, bank.observedRms || layerRms);
  const bankNorm = SAMPLED_TARGET_RMS / observedRms;
  const normalizedGain = bank.oneShot
    // 单次敲击按整段采样的观测 RMS 做一次归一；不再重复套用音区层归一，
    // 否则长尾锣声会被额外放大。力度层之间保留原录音的相对强弱。
    ? SAMPLED_TARGET_RMS * peak * expression * sampleTrim * bankLevel / observedRms
    : peak * expression * sampleTrim * Math.min(3, bankNorm) * bankLevel
      * (SAMPLED_TARGET_RMS / layerRms) / SAMPLED_TARGET_RMS * 0.62;
  // 防削波交给 masterChain 的 tanh 软限幅器（见 softClipCurve），这里不再砍增益。
  // 为什么去掉旧写法 Math.min(normalizedGain, 0.85/peak)：
  //   Meta Nylon / 中阮的样本录音电平只有钢琴的 1/3.6，砍到上限后输出 RMS 只有 0.067，
  //   系数从 1.158 调到 3.089 输出几乎不变 —— 响度永远拉不平（实测）。
  //   软限幅允许给足增益，再把峰值压到安全范围，响度和不削波两件事都能满足。
  const gainValue = normalizedGain;
  const source = audio.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.value = bank.oneShot
    ? playbackRate
    : playbackRate * (1 + (human.detune / 1200) * 0.5);
  if (bank.continuous && sample.loopStart && sample.loopEnd) {
    source.loop = true;
    source.loopStart = sample.loopStart;
    source.loopEnd = sample.loopEnd;
  }
  const release = bank.continuous ? 0.24 : pianoDamperSeconds(midi);
  const tEnd = at + held;
  const envelope = audio.createGain();
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.linearRampToValueAtTime(gainValue, at + 0.004);
  source.connect(envelope).connect(target);
  source.start(at);
  if (bank.oneShot) {
    // 敲击类音色按录音自身的衰减自然结束；短音符也不截断铃、锣、钹的尾音。
    registerVoice([source], [source, envelope]);
    return true;
  }
  envelope.gain.setValueAtTime(gainValue, tEnd);
  envelope.gain.exponentialRampToValueAtTime(0.0001, tEnd + release);
  source.stop(tEnd + release + 0.03);
  registerVoice([source], [source, envelope]);
  return true;
}

/** 某个声部该用哪种音色：声部单独选过就用它自己的，否则跟随全局音色。 */
/**
 * 声部 → 音色 的缓存。
 *
 * 为什么需要：8419 个音符的谱，播放时每个音都要问一次"这个声部用什么音色"，
 * 而答案在播放期间是稳定的。缓存后每个音少一次 Map 查找 + 字符串判断。
 * 任何会改变音色的操作（换全局音色、逐声部音色、识别新谱）都要调用 clearTimbreCache()。
 */
const timbreCache = new Map();
function clearTimbreCache() {
  timbreCache.clear();
}

function timbreForPart(partKey) {
  // 缓存 key 必须带上全局音色：结果依赖「逐声部覆盖 ?? 全局音色」，
  // 只用 partKey 做 key 时，改了全局音色仍会命中最开始的旧结果
  // （实测会让 e2e 里连续切换音色全部退化成第一个音色）。
  const cacheKey = String(state.timbre) + "\u0000" + String(partKey);
  const cached = timbreCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const resolved = resolveTimbreForPart(partKey);
  timbreCache.set(cacheKey, resolved);
  return resolved;
}

function resolveTimbreForPart(partKey) {
  if (partKey) {
    const chosen = state.partTimbres.get(String(partKey));
    if (chosen && TIMBRE_LABELS[chosen]) return chosen;
  }
  return TIMBRE_LABELS[state.timbre] ? state.timbre : "piano";
}

/** 把一个音符交给对应「合成器」；合成失败时退回电子琴，保证总有声音。 */
function playSynthTone(chosen, midi, startAt, duration, peak, destination, partKey) {
  // 响度配平：锯齿波人声比钢琴响约 2 倍，不配平的话切换音色会突然变响。
  const balanced = peak * (TIMBRE_GAIN[chosen] || 1);
  try {
    if (chosen === "choir") {
      // 不同声部唱不同元音，合在一起更像「一群人」而不是「一个人叠了几遍」。
      playChoirTone(midi, startAt, duration, balanced, destination, vowelForPart(partKey));
      return;
    }
    if (chosen === "choir_female_synth") {
      playChoirTone(midi, startAt, duration, balanced, destination, vowelForPart(partKey), { female: true });
      return;
    }
    if (chosen === "strings") { playStringsTone(midi, startAt, duration, balanced, destination); return; }
    if (chosen === "organ") { playOrganTone(midi, startAt, duration, balanced, destination); return; }
    if (chosen === "soft") { playSoftTone(midi, startAt, duration, balanced, destination); return; }
    playPianoTone(midi, startAt, duration, balanced, destination);
  } catch (error) {
    console.info("这个音合成失败，已退回电子琴音色。", error);
    playSoftTone(midi, startAt, duration, balanced, destination);
  }
}

/** 按声部音色把一个音符交给对应音源（采样优先、没装/没加载好就用合成音色兜底）。 */
function playTone(midi, startAt, duration, peak = 0.16, destination = null, partKey = "") {
  if (!state.audio || !Number.isFinite(midi)) return;
  const chosen = timbreForPart(partKey);
  if (isSampledTimbre(chosen)) {
    const bank = state.sampleBanks.get(chosen);
    if (bank && bank.ready) {
      try {
        if (playSampledTone(chosen, bank, midi, startAt, duration, peak, destination)) return;
      } catch (error) {
        console.info("采样音源播放失败，退回合成音色：", error);
      }
    } else {
      // 第一次用到这个音色：后台开始加载，这一轮先用同类合成音色顶上。
      ensureSampleBank(chosen);
    }
    playSynthTone(SAMPLED_TIMBRES[chosen].fallback, midi, startAt, duration, peak, destination, partKey);
    return;
  }
  playSynthTone(chosen, midi, startAt, duration, peak, destination, partKey);
}
/**
 * 把 MusicXML 里的速度/力度记号接进播放调度（P1-3）：
 * - 播放起点（offset，选区起点）处生效的速度作为起始速度，之后按 tempoMarks 分段变速；
 * - secondsAtBeat 把"拍位"换算成"秒"；力度记号决定该处起的音量峰值。
 */
function buildPlaybackTimeline(offset) {
  const baseTempo = clampTempo(Number(els.tempoInput.value) || 84);
  const rawTempoMarks = (state.scoreInfo && state.scoreInfo.tempoMarks) || [];
  const rawDynamicsMarks = (state.scoreInfo && state.scoreInfo.dynamicsMarks) || [];
  // 用户手填 BPM 时按「整曲等比缩放」处理：中途变速的比例保留，不会因为改了 BPM 就变匀速。
  const tempoPlan = playbackTempoSegments(rawTempoMarks, {
    offset,
    userBpm: baseTempo,
    detectedBpm: state.scoreInfo ? state.scoreInfo.tempo : null,
  });
  let startTempo = tempoPlan.startBpm;
  const segments = [];
  for (const segment of tempoPlan.segments) {
    if (segments.length && Math.abs(segments[segments.length - 1].bpm - segment.bpm) < 0.01) continue;
    segments.push({ beat: segment.beat, bpm: segment.bpm });
  }
  const dynamics = rawDynamicsMarks
    .map((mark) => ({ beat: Number(mark.beat) || 0, value: Number(mark.dynamics) }))
    .filter((mark) => Number.isFinite(mark.value))
    .sort((a, b) => a.beat - b.beat);
  let startDynamics = null;
  for (const mark of dynamics) if (mark.beat <= offset) startDynamics = mark.value;

  const secondsAtBeat = (beatInTimeline) => {
    let seconds = 0, previous = 0, bpm = startTempo;
    for (const segment of segments) {
      if (segment.beat >= beatInTimeline) break;
      seconds += (segment.beat - previous) * (60 / bpm);
      previous = segment.beat;
      bpm = segment.bpm;
    }
    seconds += Math.max(0, beatInTimeline - previous) * (60 / bpm);
    return seconds;
  };
  const dynamicsAtBeat = (beatInTimeline) => {
    let value = startDynamics;
    for (const mark of dynamics) {
      if (mark.beat <= offset) continue;
      if (mark.beat - offset > beatInTimeline) break;
      value = mark.value;
    }
    return value;
  };
  return { secondsAtBeat, dynamicsAtBeat };
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
  const timeline = buildPlaybackTimeline(offset);
  const headStart = state.audio.currentTime + SCHEDULER.headStartSeconds;
  state.isPlaying = true;
  updatePlaybackControls();

  // ===== 滚动窗口调度（性能关键，别改回"一次性全建"）=====
  // 整曲一次把上千个音符的音频节点全建出来，实测（44 小节 / 1408 音符）主线程卡 820 ms，
  // 并且上千个"还没开始响"的振荡器仍会被音频线程逐个处理，弱机器直接爆音（噼里啪啦）。
  // 改成只提前 SCHEDULER.aheadSeconds 秒建节点、每 SCHEDULER.tickMs 毫秒补一次后，
  // 任意时刻音频图里只有几十个音，主线程每轮只花几毫秒（实测 1408 音符的图里只有 48 个源）。
  let cursor = 0;
  // 本轮调度出去的「要一起高亮的音符」：攒起来用**一个** setTimeout 批量高亮。
  // 原实现是每个事件一个 setTimeout（8419 音 → 8419 个定时器），定时器队列本身就会拖慢主线程。
  const pendingHighlights = [];
  const flushHighlights = () => {
    if (!pendingHighlights.length) return;
    const batch = pendingHighlights.splice(0, pendingHighlights.length);
    highlightEvent(batch);
  };
  const scheduleWindow = () => {
    if (!state.isPlaying || !state.audio) return;
    const horizon = state.audio.currentTime + SCHEDULER.aheadSeconds;
    let lastHighlightDelay = -1;
    while (cursor < events.length) {
      const event = events[cursor];
      const at = headStart + timeline.secondsAtBeat(event.startBeat);
      if (at > horizon) break;
      cursor += 1;
      // 同一事件内所有音的起拍相同：时间换算一次就够，别每个音都算两遍。
      const onset = Math.max(0, event.startBeat);
      const eventSeconds = Math.max(0.05,
        timeline.secondsAtBeat(onset + (event.notes[0] ? beatsForNote(event.notes[0]) : 1)) - timeline.secondsAtBeat(onset));
      const dynamics = gainForDynamics(timeline.dynamicsAtBeat(onset));
      for (const note of event.notes) {
        // 和弦里各音时值可能不同：只有和首个音不一样时才重新算
        const noteBeats = beatsForNote(note);
        const seconds = noteBeats === (event.notes[0] ? beatsForNote(event.notes[0]) : noteBeats)
          ? eventSeconds
          : Math.max(0.05, timeline.secondsAtBeat(onset + noteBeats) - timeline.secondsAtBeat(onset));
        // 力度记号（P1-3）：该处起生效的力度决定音量峰值。
        // 发音长度取名义时值的 0.99：留 8%（原来）× 的长度会在连奏段落里听成「莫名的停顿」。
        playTone(note.midi, at, seconds * 0.99, dynamics,
          partBus(voiceIdentity(note)), voiceIdentity(note));
      }
      pendingHighlights.push(...event.notes.map((note) => note.id));
      lastHighlightDelay = Math.max(0, (at - state.audio.currentTime) * 1000);
    }
    // 本轮调度出的音一起高亮：只建 1 个定时器（而不是每事件 1 个）。
    if (pendingHighlights.length && lastHighlightDelay >= 0) {
      state.timers.push(setTimeout(flushHighlights, lastHighlightDelay));
    }
    if (cursor >= events.length && state.scheduleTimer) {
      clearInterval(state.scheduleTimer);
      state.scheduleTimer = null;
    }
  };
  scheduleWindow();
  if (cursor < events.length) {
    state.scheduleTimer = setInterval(scheduleWindow, SCHEDULER.tickMs);
  }

  state.timers.push(setTimeout(() => {
    state.isPlaying = false;
    if (state.scheduleTimer) { clearInterval(state.scheduleTimer); state.scheduleTimer = null; }
    highlightEvent(null);
    updatePlaybackControls();
    if (state.loop && getPlaybackNotes().length) playMelody().catch((error) => console.error(error));
  }, (headStart + timeline.secondsAtBeat(finishBeat) - state.audio.currentTime) * 1000 + 160));
}
/**
 * 高亮「正在播放的音符行」。
 *
 * 性能关键：8419 个音符时，每次 querySelectorAll 遍历全部行约 11 ms，
 * 而播放一秒内会调用几十次 → 主线程被占满，听感就是「卡卡的、不流畅」。
 * 改成用渲染时建好的 id→行索引，只处理「上一批要取消的 + 这一批要加的」，
 * 正常情况每次只碰几个 DOM 节点（微秒级）。
 */
function highlightEvent(noteIds) {
  const previous = state.highlightedIds || new Set();
  const next = noteIds === null ? new Set() : new Set(noteIds);
  // 先清掉上一批里"这一批没有"的
  for (const id of previous) {
    if (next.has(id)) continue;
    const row = state.noteRowById && state.noteRowById.get(id);
    if (row) row.classList.remove("is-playing");
  }
  // 再加这一批里"上一批没有"的
  for (const id of next) {
    if (previous.has(id)) continue;
    const row = state.noteRowById && state.noteRowById.get(id);
    if (row) row.classList.add("is-playing");
  }
  state.highlightedIds = next;
}
function stopPlayback() {
  highlightEvent(null);
  for (const timer of state.timers) clearTimeout(timer);
  state.timers = [];
  if (state.scheduleTimer) { clearInterval(state.scheduleTimer); state.scheduleTimer = null; }
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
  // 翻页**不清空识别结果、也不停播放**：结果、校对过的音符、声部选择、选区、正在进行的播放
  // 都与「当前显示哪一页」无关；翻页只改谱面显示，并把谱面坐标点按「这一页是不是识别时的那一页」
  // 收起/展开（见 refreshScoreOverlay）。这样边放边翻页跟着看谱才不会被打断。
  const token = state.loadToken;
  await renderPdfPage(number, token);
  if (token !== state.loadToken) return;
  const samePage = state.scorePage !== null && state.scorePage === state.pageNumber;
  els.scoreHint.textContent = state.notes.length
    ? samePage
      ? `识别结果就是这一页（${state.notes.length} 个音符）· 可继续校对、播放或导出`
      : state.scorePage === null
        ? `识别结果是整本乐谱（${state.notes.length} 个音符），可整曲播放/导出；谱面坐标点只对识别的那一页有意义，这里不画点`
        : `识别结果来自第 ${state.scorePage} 页，仍可播放/导出；本页还没识别过，可点「识别乐谱」`
    : "可以开始识别此页";
}
els.fileInput.addEventListener("change", (event) => loadFile(event.target.files[0]));
els.chooseFileButton.addEventListener("click", () => els.fileInput.click());
els.removeFile.addEventListener("click", removeCurrentFile);
els.recognizeButton.addEventListener("click", recognizeScore);
els.jianpuButton.addEventListener("click", recognizeJianpuScore);
els.jianpuAllButton.addEventListener("click", recognizeAllJianpuPages);
els.recognizeAllButton.addEventListener("click", recognizeAllPages);
els.addNoteButton.addEventListener("click", addNote);
if (els.measureJumpButton) els.measureJumpButton.addEventListener("click", () => {
  jumpToMeasureInList(els.measureJumpInput && els.measureJumpInput.value);
});
if (els.measureJumpInput) els.measureJumpInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    jumpToMeasureInList(els.measureJumpInput.value);
  }
});
if (els.addLayerPart) els.addLayerPart.addEventListener("click", addLayerPart);
if (els.addLayerEcho) els.addLayerEcho.addEventListener("click", () => addLayerOctave(12));
if (els.addLayerLower) els.addLayerLower.addEventListener("click", () => addLayerOctave(-12));
els.midiButton.addEventListener("click", downloadMidi);
if (els.audioButton) els.audioButton.addEventListener("click", exportAudio);
els.playButton.addEventListener("click", playMelody);
els.stopButton.addEventListener("click", stopPlayback);
els.canvasWrap.addEventListener("click", focusNearestScoreNote);
els.partSelectAll.addEventListener("click", () => {
  state.selectedParts = null;
  stopPlayback();
  updatePartControls();
});
els.partSelectNone.addEventListener("click", () => {
  state.selectedParts = new Set();
  stopPlayback();
  updatePartControls();
});
els.pianoToggle.addEventListener("change", () => {
  state.includePiano = els.pianoToggle.checked;
  stopPlayback();
  updatePlaybackReady();
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
  const value = Math.min(320, Math.max(20, Number(els.tempoInput.value) || 84));
  const changed = String(value) !== els.tempoInput.dataset.applied;
  els.tempoInput.value = value;
  els.tempoInput.dataset.applied = String(value);
  // 播放调度每次点播放都会重新读这个输入框，所以改完是「下次播放生效」（不是没用的装饰）。
  if (changed && state.notes.length) showToast(`速度设为 ${value} BPM（每分钟 ${value} 个四分音符）；改完再点播放就按新速度演奏。`);
});
// 音色选择：记本地偏好，切换后下次播放生效（不打断正在播放的乐句）。
if (els.timbreSelect) {
  fillTimbreOptions(els.timbreSelect);
  const savedTimbre = loadSettings().timbre;
  if (TIMBRE_LABELS[savedTimbre]) state.timbre = savedTimbre;
  els.timbreSelect.value = state.timbre;
  // 采样音源清单（异步）：装了就自动出现「真实…」音色；用户没手动选过音色时默认用真实钢琴。
  fetchSampleManifest().then((manifest) => {
    state.sampleManifest = manifest;
    updateSampleStatus();
    if (manifest && !TIMBRE_LABELS[savedTimbre]) {
      const preferred = manifest.banks.piano_real ? "piano_real" : state.timbre;
      if (isSampledTimbre(preferred)) {
        state.timbre = preferred;
        els.timbreSelect.value = preferred;
      }
    }
  }).catch(() => {});
  if (els.timbreHint) els.timbreHint.textContent = "各声部可单独选";
  els.timbreSelect.addEventListener("change", () => setTimbre(els.timbreSelect.value));
}
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.target.matches("input, select, textarea, button")) return;
  event.preventDefault();
  if (state.isPlaying) stopPlayback();
  else if (!els.playButton.disabled) playMelody();
});
// 自动化测试用的调试钩子：只有地址里带 ?debug=1 时才挂到 window 上，正常使用完全不受影响。
// （浏览器里 app.js 是 ES module，模块内的 state 外部拿不到，测试需要它来检查音频引擎。）
if (new URLSearchParams(window.location.search).has("debug")) {
  window.__pujian = { state, playTone, setTimbre, masterChain, midiFrequency, timbreForPart, playMelody,
  stopPlayback, prepareAudio, ensureSampleBank, fetchSampleManifest, omrPageBlob,
  renderNotes, highlightEvent, updatePlaybackReady, commitScore, tempoPageBlob, omrPageBlob,
  // 性能基准用：暴露内部函数，测试才能分别量「复制声部 / 切八度 / 导出渲染」各花多久。
  // EXPORT_RENDER 可改（例如 maxChunks = 1 强制整块渲染），用来做分块/整块的逐样本保真比对。
  duplicatePart, setPartOctave, refreshScoreOverlay, updatePartControls,
  buildAudioPlan, renderPlanToBuffer, encodeMp3, getPlaybackNotes, playbackTimeline,
  playbackTempoSegments, beatsForNote, voiceIdentity, loadLame, normalizePeak, stereoChannels,
  EXPORT_RENDER, appendPartNoteRows, updatePartPitchRows, makeId, measureIndexForNote,
  encodeMp3WithWorker, normalizeBufferInPlace, scheduleTimbrePreload,
  buildVoiceBlock };
}
renderNotes();
refreshEngineStatus();

