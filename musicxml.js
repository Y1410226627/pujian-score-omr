const localName = (element) => element?.localName || element?.nodeName?.split(":").pop() || "";
const childrenNamed = (element, name) => Array.from(element?.children || []).filter((child) => localName(child) === name);
const childNamed = (element, name) => childrenNamed(element, name)[0] || null;
const textOf = (element, name) => childNamed(element, name)?.textContent?.trim() || "";
const descendantsNamed = (element, name) => Array.from(element?.getElementsByTagName?.("*") || []).filter((child) => localName(child) === name);
// OMR 导出常带空标记元素（如 <notations/>、<articulations/>）。判断"是否真的带有内容"，
// 避免把空元素当成真实的力度/奏法/歌词记号而给出与乐谱不符的警告。
const hasContent = (element) => Boolean(element) && (Array.from(element.children || []).length > 0 || Boolean(element.textContent?.trim()));

const naturalSemitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const accidentalText = (alter) => {
  if (Math.abs(alter - Math.round(alter)) < 0.0001) {
    return ({ "-2": "bb", "-1": "b", "0": "", "1": "#", "2": "##" })[String(Math.round(alter))] ?? `(${alter > 0 ? "+" : ""}${alter})`;
  }
  return `(${alter > 0 ? "+" : ""}${Number(alter.toFixed(3))})`;
};
const midiForPitch = (step, alter, octave) => (octave + 1) * 12 + naturalSemitones[step] + alter;
const pitchLabel = (step, alter, octave) => `${step}${accidentalText(alter)}${octave}`;
const durationByType = {
  maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1,
  eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625,
  "128th": 0.03125, "256th": 0.015625,
};
const durationByBeatUnit = { maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625, "128th": 0.03125 };

function noteDurationBeats(note, divisions) {
  const durationValue = Number(textOf(note, "duration"));
  if (Number.isFinite(durationValue) && durationValue > 0 && divisions > 0) return durationValue / divisions;

  const base = durationByType[textOf(note, "type")] || 1;
  const dotCount = childrenNamed(note, "dot").length;
  let result = base * (dotCount ? 2 - (1 / (2 ** dotCount)) : 1);
  const timeModification = childNamed(note, "time-modification");
  const actual = Number(textOf(timeModification, "actual-notes"));
  const normal = Number(textOf(timeModification, "normal-notes"));
  if (actual > 0 && normal > 0) result *= normal / actual;
  return result;
}

function measureLength(timeSignature, maxCursor, implicit) {
  if (implicit) return maxCursor;
  const [beatsText = "", beatTypeText = ""] = String(timeSignature || "").split("/");
  const beats = beatsText.split("+").reduce((sum, value) => sum + (Number(value) || 0), 0);
  const beatType = Number(beatTypeText);
  if (beats > 0 && beatType > 0) return beats * 4 / beatType;
  return maxCursor;
}

function keyName(key) {
  const fifthsText = textOf(key, "fifths");
  if (!fifthsText) return "";
  const fifths = Number(fifthsText);
  const mode = textOf(key, "mode");
  const major = { "-7": "Cb", "-6": "Gb", "-5": "Db", "-4": "Ab", "-3": "Eb", "-2": "Bb", "-1": "F", 0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#" };
  const minor = { "-7": "Ab minor", "-6": "Eb minor", "-5": "Bb minor", "-4": "F minor", "-3": "C minor", "-2": "G minor", "-1": "D minor", 0: "A minor", 1: "E minor", 2: "B minor", 3: "F# minor", 4: "C# minor", 5: "G# minor", 6: "D# minor", 7: "A# minor" };
  return Number.isFinite(fifths) && fifths >= -7 && fifths <= 7 ? (mode === "minor" ? minor[String(fifths)] : major[String(fifths)]) : "";
}

function readTieTypes(note) {
  const types = new Set();
  for (const tie of [...childrenNamed(note, "tie"), ...descendantsNamed(childNamed(note, "notations"), "tied")]) {
    const type = tie.getAttribute("type");
    if (type === "start" || type === "stop") types.add(type);
  }
  return { start: types.has("start"), stop: types.has("stop") };
}

function mergeTiedNotes(notes) {
  const merged = [], tiedNotes = new Map();
  for (const note of notes) {
    const tieKey = [note.partId, note.voice, note.staff, note.midi.toFixed(4)].join("|");
    const previous = tiedNotes.get(tieKey);
    if (note.tieStop && previous) {
      previous.durationBeats += note.durationBeats;
      if (note.tieStart) tiedNotes.set(tieKey, previous);
      else tiedNotes.delete(tieKey);
      continue;
    }
    // 若同一位置上的延音起始没有被当前音符接续，说明它已经悬空（制谱错误或识别错误），
    // 必须让它失效，否则后续同音高的音符会被错误并入，产生超长假音并丢失真实音符。
    if (previous) tiedNotes.delete(tieKey);
    merged.push(note);
    if (note.tieStart) tiedNotes.set(tieKey, note);
  }
  return merged;
}

export function parseMusicXmlText(source) {
  const documentNode = new DOMParser().parseFromString(source, "application/xml");
  if (descendantsNamed(documentNode, "parsererror").length) throw new Error("MusicXML 文件格式无法读取。");
  const root = documentNode.documentElement;
  if (localName(root) !== "score-partwise") {
    if (localName(root) === "score-timewise") throw new Error("目前暂不支持 timewise 排列的 MusicXML，请先从制谱软件导出 partwise 格式。");
    throw new Error("这不是受支持的 MusicXML 乐谱文件。");
  }

  const work = childNamed(root, "work");
  const title = textOf(work, "work-title") || textOf(root, "movement-title") || "未命名乐谱";
  const partNames = new Map(childrenNamed(childNamed(root, "part-list"), "score-part").map((part) => [
    part.getAttribute("id"), textOf(part, "part-name") || part.getAttribute("id"),
  ]));
  const musicParts = childrenNamed(root, "part");
  const tempoMarks = [], timeSignatures = new Set(), keySignatures = new Set();
  const warnings = new Set();
  let measureCount = 0, skippedNotes = 0;

  // 第一遍：解析各声部的音符（记录"小节内起拍"）与该声部推算出的各小节长度。
  // 不在这里决定全局起拍，因为多声部/多谱表必须共享同一份小节长度表才能对齐。
  const partTracks = [];
  for (const part of musicParts) {
    const partId = part.getAttribute("id") || `part-${partNames.size + 1}`;
    const partName = partNames.get(partId) || partId;
    let divisions = 1, currentTime = null, transpose = 0;
    let measureNumber = 0;
    const trackNotes = [], measureLengths = [];
    for (const measure of childrenNamed(part, "measure")) {
      measureNumber++;
      measureCount = Math.max(measureCount, measureNumber);
      const measureIndex = measureNumber - 1;
      let cursor = 0, maxCursor = 0, previousNoteStart = 0;
      for (const item of Array.from(measure.children)) {
        const itemName = localName(item);
        if (itemName === "attributes") {
          const nextDivisions = Number(textOf(item, "divisions"));
          if (Number.isFinite(nextDivisions) && nextDivisions > 0) divisions = nextDivisions;
          const time = childNamed(item, "time");
          if (time) {
            const beats = textOf(time, "beats");
            const beatType = textOf(time, "beat-type");
            if (beats && beatType) {
              currentTime = `${beats}/${beatType}`;
              timeSignatures.add(currentTime);
            }
          }
          const key = childNamed(item, "key");
          if (key) {
            const value = keyName(key);
            if (value) keySignatures.add(value);
          }
          const transposeNode = childNamed(item, "transpose");
          if (transposeNode) {
            transpose = (Number(textOf(transposeNode, "chromatic")) || 0) + (Number(textOf(transposeNode, "octave-change")) || 0) * 12;
          }
          continue;
        }
        if (itemName === "backup" || itemName === "forward") {
          const delta = (Number(textOf(item, "duration")) || 0) / divisions;
          cursor = Math.max(0, cursor + (itemName === "backup" ? -delta : delta));
          maxCursor = Math.max(maxCursor, cursor);
          continue;
        }
        if (itemName === "direction") {
          const offset = (Number(textOf(item, "offset")) || 0) / divisions;
          const sound = childNamed(item, "sound");
          let tempo = Number(sound?.getAttribute("tempo"));
          if (!Number.isFinite(tempo) || tempo <= 0) {
            const metronome = descendantsNamed(item, "metronome")[0];
            const perMinute = Number(textOf(metronome, "per-minute"));
            const beatUnit = durationByBeatUnit[textOf(metronome, "beat-unit")];
            const beatDots = childrenNamed(metronome, "beat-unit-dot").length;
            const unitMultiplier = beatDots ? 2 - (1 / (2 ** beatDots)) : 1;
            if (perMinute > 0 && beatUnit) tempo = perMinute * beatUnit * unitMultiplier;
          }
          if (Number.isFinite(tempo) && tempo > 0) tempoMarks.push({ measureIndex, beatInMeasure: cursor + offset, bpm: tempo });
          if (descendantsNamed(item, "dynamics").some(hasContent) || sound?.hasAttribute("dynamics")) warnings.add("力度记号会保留在源文件中，但试听暂不改变音量。");
          if (descendantsNamed(item, "words").some(hasContent) || descendantsNamed(item, "metronome").some(hasContent)) warnings.add("文字演奏指示不会改变当前合成试听。");
          continue;
        }
        if (itemName === "barline" && descendantsNamed(item, "repeat").length) warnings.add("乐谱含反复记号；当前播放按文件顺序播放一次。");
        if (itemName !== "note") continue;

        const duration = noteDurationBeats(item, divisions);
        const isChordTone = Boolean(childNamed(item, "chord"));
        const isGrace = Boolean(childNamed(item, "grace"));
        const startInMeasure = isChordTone ? previousNoteStart : cursor;
        if (!isChordTone && !isGrace) {
          previousNoteStart = cursor;
          cursor += duration;
          maxCursor = Math.max(maxCursor, cursor);
        }
        if (isGrace) {
          skippedNotes++;
          continue;
        }
        if (childNamed(item, "rest")) continue;

        const pitch = childNamed(item, "pitch");
        const step = textOf(pitch, "step").toUpperCase();
        const octave = Number(textOf(pitch, "octave"));
        const alter = Number(textOf(pitch, "alter")) || 0;
        if (!Object.prototype.hasOwnProperty.call(naturalSemitones, step) || !Number.isFinite(octave) || duration <= 0) {
          skippedNotes++;
          continue;
        }
        const midi = midiForPitch(step, alter, octave) + transpose;
        if (midi < 0 || midi > 127) {
          skippedNotes++;
          continue;
        }
        const ties = readTieTypes(item);
        const imagePositionComment = Array.from(item.childNodes || []).find((node) => node.nodeType === 8 && /imgpos\s*:/i.test(node.data || ""));
        const imagePosition = imagePositionComment && /imgpos\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(imagePositionComment.data);
        trackNotes.push({
          partId, partName, voice: textOf(item, "voice") || "1", staff: textOf(item, "staff") || "1",
          measure: measure.getAttribute("number") || String(measureNumber),
          measureIndex, startInMeasure, durationBeats: duration,
          pitch: pitchLabel(step, alter, octave), midi,
          x: imagePosition ? Number(imagePosition[1]) : Number.NaN,
          y: imagePosition ? Number(imagePosition[2]) : Number.NaN,
          tieStart: ties.start, tieStop: ties.stop,
        });
      }
      if (descendantsNamed(measure, "repeat").length) warnings.add("乐谱含反复记号；当前播放按文件顺序播放一次。");
      const implicit = measure.getAttribute("implicit") === "yes";
      let nominal = measureLength(currentTime, maxCursor, implicit);
      // 弱起（anacrusis）小节：制谱软件常标 implicit="yes"，但也有不少文件不标。
      // 首小节未标 implicit 且实际内容短于标称长度时，按实际内容计，否则后面所有小节都会整体右移。
      if (!implicit && measureNumber === 1 && maxCursor > 0 && maxCursor < nominal) nominal = maxCursor;
      measureLengths.push(Math.max(nominal, maxCursor));
    }
    partTracks.push({ partId, partName, notes: trackNotes, measureLengths });
  }

  // 全局小节长度表：同一小节号取各声部的最大值，保证多声部/多谱表的小节起点一致。
  const globalMeasureLengths = [];
  for (const track of partTracks) {
    track.measureLengths.forEach((length, index) => {
      globalMeasureLengths[index] = Math.max(globalMeasureLengths[index] || 0, length);
    });
  }
  const globalBaseBeats = [];
  let runningBeat = 0;
  for (let index = 0; index < globalMeasureLengths.length; index++) {
    globalBaseBeats[index] = runningBeat;
    runningBeat += globalMeasureLengths[index];
  }

  const notes = [];
  for (const track of partTracks) {
    for (const note of track.notes) {
      const { measureIndex, startInMeasure, ...rest } = note;
      notes.push({ ...rest, startBeat: (globalBaseBeats[measureIndex] || 0) + startInMeasure });
    }
  }

  if (skippedNotes) warnings.add(`${skippedNotes} 个装饰音、无音高或超出 MIDI 音域的项目未加入试听。`);
  const uniqueTempoMarks = tempoMarks
    .map((mark) => ({ beat: (globalBaseBeats[mark.measureIndex] || 0) + mark.beatInMeasure, bpm: mark.bpm }))
    .sort((a, b) => a.beat - b.beat)
    .filter((mark, index, all) =>
      index === 0 || Math.abs(mark.beat - all[index - 1].beat) > 0.00001 || Math.abs(mark.bpm - all[index - 1].bpm) > 0.01);
  if (uniqueTempoMarks.some((mark) => mark.beat > 0.00001)) warnings.add("乐谱中途有速度标记；当前试听采用开头速度，不执行速度变化。");
  if (descendantsNamed(root, "lyric").some(hasContent)) warnings.add("歌词保留在原 MusicXML 文件中，但当前音色不能演唱歌词。");
  if (descendantsNamed(root, "articulations").some(hasContent) || descendantsNamed(root, "ornaments").some(hasContent)) warnings.add("奏法和装饰记号保留在源文件中，当前试听不会模拟这些效果。");
  const tempo = uniqueTempoMarks.find((mark) => mark.beat <= 0.00001)?.bpm || 84;
  const mergedNotes = mergeTiedNotes(notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi));
  let eventId = -1, previousBeat = Number.NaN;
  for (const [index, note] of mergedNotes.entries()) {
    if (!Number.isFinite(previousBeat) || Math.abs(note.startBeat - previousBeat) > 0.00001) {
      eventId++;
      previousBeat = note.startBeat;
    }
    note.eventId = eventId;
    note.id = `musicxml-${eventId}-${note.partId}-${note.voice}-${note.midi}-${index}`;
    note.duration = "custom";
  }
  // 全休止/无音高的合法乐谱不应该抛异常：交给上层走"无音符"分支，避免界面卡在"有文件 + 报错"的半残状态。
  if (!mergedNotes.length) warnings.add("没有找到可演奏的带音高音符：整曲可能只有休止符，或识别结果缺少音高。");

  const timeSummary = timeSignatures.size === 1 ? [...timeSignatures][0] : timeSignatures.size ? "有多种拍号" : "拍号未标明";
  const keySummary = keySignatures.size === 1 ? [...keySignatures][0] : keySignatures.size ? "有多种调性" : "调号未标明";
  return {
    title, notes: mergedNotes, tempo, measureCount, partNames: musicParts.map((part) => partNames.get(part.getAttribute("id")) || part.getAttribute("id") || "声部"),
    timeSummary, keySummary, warnings: [...warnings],
  };
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") throw new Error("当前浏览器无法解压 MXL 文件，请另存为 .musicxml 后再导入。");
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error("MXL 压缩内容无法解压，请在制谱软件中另存为 .musicxml。");
  }
}

async function readZipTextEntry(archive, entry) {
  const view = new DataView(archive);
  const offset = entry.localOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error("MXL 压缩包结构异常。");
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = new Uint8Array(archive, start, entry.compressedSize);
  const content = entry.method === 0 ? compressed : entry.method === 8 ? await inflateRaw(compressed) : null;
  if (!content) throw new Error("MXL 使用了暂不支持的压缩方式。");
  if (content.length > 100 * 1024 * 1024) throw new Error("MXL 乐谱内容过大，无法在浏览器中安全载入。");
  return new TextDecoder("utf-8").decode(content);
}

async function readMxl(file) {
  if (file.size > 100 * 1024 * 1024) throw new Error("MXL 文件超过 100 MB，无法载入。");
  const archive = await file.arrayBuffer();
  const view = new DataView(archive);
  let endRecord = -1;
  for (let offset = Math.max(0, view.byteLength - 65557); offset <= view.byteLength - 22; offset++) {
    if (view.getUint32(offset, true) === 0x06054b50) endRecord = offset;
  }
  if (endRecord < 0) throw new Error("MXL 文件不是有效的 ZIP 乐谱包。");
  const entryCount = view.getUint16(endRecord + 10, true);
  let directoryOffset = view.getUint32(endRecord + 16, true);
  const entries = [];
  for (let index = 0; index < entryCount; index++) {
    if (view.getUint32(directoryOffset, true) !== 0x02014b50) throw new Error("MXL 文件目录结构异常。");
    const method = view.getUint16(directoryOffset + 10, true);
    const compressedSize = view.getUint32(directoryOffset + 20, true);
    const uncompressedSize = view.getUint32(directoryOffset + 24, true);
    const nameLength = view.getUint16(directoryOffset + 28, true);
    const extraLength = view.getUint16(directoryOffset + 30, true);
    const commentLength = view.getUint16(directoryOffset + 32, true);
    const localOffset = view.getUint32(directoryOffset + 42, true);
    const nameStart = directoryOffset + 46;
    const name = new TextDecoder("utf-8").decode(new Uint8Array(archive, nameStart, nameLength));
    if (!name.endsWith("/") && uncompressedSize <= 100 * 1024 * 1024) entries.push({ name, method, compressedSize, localOffset });
    directoryOffset = nameStart + nameLength + extraLength + commentLength;
  }

  const containerEntry = entries.find((entry) => entry.name.toLowerCase() === "meta-inf/container.xml");
  let musicXmlEntry = null;
  if (containerEntry) {
    const container = new DOMParser().parseFromString(await readZipTextEntry(archive, containerEntry), "application/xml");
    const rootFile = descendantsNamed(container, "rootfile").find((entry) => entry.getAttribute("full-path"));
    const path = rootFile?.getAttribute("full-path").replace(/^\.\//, "");
    if (path && !path.split(/[\\/]/).includes("..")) musicXmlEntry = entries.find((entry) => entry.name === path);
  }
  musicXmlEntry ||= entries.find((entry) => entry.name.toLowerCase() !== "meta-inf/container.xml" && /\.(musicxml|xml)$/i.test(entry.name));
  if (!musicXmlEntry) throw new Error("MXL 压缩包中没有找到 MusicXML 乐谱。");
  return readZipTextEntry(archive, musicXmlEntry);
}

export async function readMusicXmlFile(file) {
  if (file.size > 100 * 1024 * 1024) throw new Error("MusicXML 文件超过 100 MB，无法载入。");
  const name = file.name.toLowerCase();
  const source = name.endsWith(".mxl") ? await readMxl(file) : await file.text();
  return parseMusicXmlText(source);
}
