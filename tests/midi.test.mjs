// MIDI → MusicXML 单元测试。
// 这里不依赖任何真实 .mid 文件：测试里直接拼标准 MIDI 文件（SMF）字节，
// 这样用例能精确控制音高、时值、速度、拍号、轨道名，也不怕以后测试文件丢失。
import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";

import { parseMidiFile, midiToPitchParts, detectKey, keyDisplayName, midiToMusicXml, trackRelation } from "../midi.js";

globalThis.DOMParser = DOMParser;
const { parseMusicXmlText } = await import("../musicxml.js");

// —— 拼 SMF 字节的小工具 ——
function vlq(value) {
  const bytes = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

function uint32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function trackChunk(events) {
  const data = [];
  for (const event of events) data.push(...vlq(event[0]), ...event.slice(1));
  data.push(0x00, 0xff, 0x2f, 0x00); // End of Track
  return [...[0x4d, 0x54, 0x72, 0x6b], ...uint32(data.length), ...data];
}

function midiFile({ format = 1, division = 480, tracks = [] }) {
  const header = [...[0x4d, 0x54, 0x68, 0x64], ...uint32(6), 0, format, (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (division >> 8) & 0xff, division & 0xff];
  return new Uint8Array([...header, ...tracks.flat()]);
}

const nameEvent = (delta, text) => {
  const bytes = [...new TextEncoder().encode(text)];
  return [delta, 0xff, 0x03, bytes.length, ...bytes];
};
const tempoEvent = (delta, bpm) => {
  const micros = Math.round(60000000 / bpm);
  return [delta, 0xff, 0x51, 0x03, (micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff];
};
const timeEvent = (delta, beats, beatType) => [delta, 0xff, 0x58, 0x04, beats, Math.log2(beatType), 24, 8];
const onEvent = (delta, midi, channel = 0, velocity = 96) => [delta, 0x90 | channel, midi, velocity];
const offEvent = (delta, midi, channel = 0) => [delta, 0x80 | channel, midi, 0];

/** 构造一首「两轨、1 小节 4/4」的最小测试曲（旋律轨 + 低音轨）。 */
function simpleSong() {
  const melody = trackChunk([
    nameEvent(0, "旋律"),
    tempoEvent(0, 90),
    timeEvent(0, 4, 4),
    onEvent(0, 60), // C4 第 1 拍
    offEvent(480, 60),
    onEvent(0, 64), // E4 第 2 拍
    offEvent(480, 64),
    onEvent(0, 67), // G4 + C5 第 3 拍（同时开始、同时结束 → 和弦）
    onEvent(0, 72),
    offEvent(480, 67),
    offEvent(0, 72),
  ]);
  const bass = trackChunk([
    nameEvent(0, "低音"),
    onEvent(0, 36, 1), // C2 整小节
    offEvent(1920, 36, 1),
  ]);
  return midiFile({ tracks: [melody, bass] });
}

test("parseMidiFile 读出格式、时间分辨率、速度、拍号和轨道", () => {
  const midi = parseMidiFile(simpleSong());
  assert.equal(midi.format, 1);
  assert.equal(midi.division, 480);
  assert.equal(midi.tracks.length, 2);
  assert.deepEqual(midi.tempos, [{ tick: 0, bpm: 90 }]);
  assert.deepEqual(midi.timeSignatures, [{ tick: 0, beats: 4, beatType: 4 }]);
  assert.equal(midi.tracks[0].name, "旋律");
  assert.equal(midi.tracks[1].name, "低音");
  assert.equal(midi.tracks[0].notes.length, 4);
  assert.equal(midi.tracks[1].notes.length, 1);
  // 低音轨在通道 1
  assert.deepEqual(midi.tracks[1].channels, [1]);
  assert.equal(midi.totalTicks, 1920);
});

test("midiToMusicXml 生成可再次解析的 MusicXML（声部/音符/小节/速度/拍号/调号）", () => {
  const { musicxml, meta } = midiToMusicXml(simpleSong(), { title: "单元测试曲" });

  assert.equal(meta.parts, 2);
  assert.equal(meta.notes, 5);
  assert.equal(meta.measures, 1);
  assert.equal(meta.tempo, 90);
  assert.equal(meta.timeSummary, "4/4");
  assert.equal(meta.percussionNotes, 0);
  assert.match(meta.key, /^[A-G]/);
  assert.equal(typeof meta.keyFifths, "number");

  const parsed = parseMusicXmlText(musicxml);
  assert.equal(parsed.title, "单元测试曲");
  assert.equal(parsed.tempo, 90);
  assert.equal(parsed.tempoDetected, true);
  assert.equal(parsed.timeSummary, "4/4");
  assert.equal(parsed.notes.length, 5);
  assert.deepEqual(parsed.partNames, ["旋律", "低音"]);
  assert.equal(parsed.warnings.filter((text) => /可演奏/.test(text)).length, 0);
  // 和弦：G4 与 C5 同时开始，解析回同一个 eventId
  const g4 = parsed.notes.find((note) => note.pitch === "G4");
  const c5 = parsed.notes.find((note) => note.pitch === "C5");
  assert.equal(g4.eventId, c5.eventId);
  // 每个音符 1 拍，从第 0 拍起
  const starts = parsed.notes.filter((note) => note.partName === "旋律").map((note) => note.startBeat).sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 1, 2, 2]);
});

test("量化：演奏抖动吸附到 1/16 网格，量化后不会多出碎音", () => {
  const track = trackChunk([
    tempoEvent(0, 120),
    timeEvent(0, 4, 4),
    onEvent(30, 60), // 起点抖了 30 tick（小于半格）→ 吸到 0
    offEvent(440, 60), // 时值 470 tick（略短）→ 吸到 480 = 1 拍
  ]);
  const bytes = midiFile({ tracks: [track] });
  const midi = parseMidiFile(bytes);
  assert.equal(midi.tracks[0].notes[0].startTick, 30, "解析阶段保留原始 tick");
  const { meta } = midiToMusicXml(bytes);
  assert.equal(meta.notes, 1);
  const parsed = parseMusicXmlText(midiToMusicXml(midiFile({ tracks: [track] })).musicxml);
  assert.equal(parsed.notes.length, 1);
  assert.equal(parsed.notes[0].startBeat, 0);
  assert.equal(parsed.notes[0].durationBeats, 1);
});

test("跨小节的音拆成两段并加连音线（2/4 拍下 2 拍长的音跨一小节线）", () => {
  const track = trackChunk([
    timeEvent(0, 2, 4), // 2/4：每小节 2 拍 = 960 tick
    onEvent(480, 60), // 第 2 拍进、跨过小节线、到第 3 拍出
    offEvent(960, 60),
  ]);
  const { musicxml, meta } = midiToMusicXml(midiFile({ tracks: [track] }));
  assert.equal(meta.measures, 2);
  assert.match(musicxml, /<tie type="start"\/>/);
  assert.match(musicxml, /<tie type="stop"\/>/);
  const parsed = parseMusicXmlText(musicxml);
  // 连音线被合并回一个 2 拍长音
  const c4 = parsed.notes.find((note) => note.pitch === "C4");
  assert.ok(c4);
  assert.equal(c4.startBeat, 1);
  assert.equal(c4.durationBeats, 2);
});

test("休止符：音符从第 2 拍才开始时前面补休止", () => {
  const track = trackChunk([
    timeEvent(0, 4, 4),
    onEvent(480, 60), // 第 1 拍空着
    offEvent(480, 60),
    onEvent(0, 62),
    offEvent(960, 62),
  ]);
  const { musicxml } = midiToMusicXml(midiFile({ tracks: [track] }));
  assert.match(musicxml, /<rest\/>/);
  const parsed = parseMusicXmlText(musicxml);
  const c4 = parsed.notes.find((note) => note.pitch === "C4");
  assert.equal(c4.startBeat, 1);
});

test("拍号中途变化：第二小节起 3/4", () => {
  const track = trackChunk([
    timeEvent(0, 4, 4),
    onEvent(0, 60),
    offEvent(1920, 60),
    timeEvent(0, 3, 4), // 第 2 小节起变 3/4
    onEvent(0, 62),
    offEvent(1440, 62),
  ]);
  const { musicxml, meta } = midiToMusicXml(midiFile({ tracks: [track] }));
  assert.equal(meta.measures, 2);
  assert.match(musicxml, /<beats>3<\/beats><beat-type>4<\/beat-type>/);
  const parsed = parseMusicXmlText(musicxml);
  assert.equal(parsed.timeSummary, "有多种拍号");
});

test("打击乐（通道 10）跳过并计入说明，不阻塞其余声部", () => {
  const drums = trackChunk([
    nameEvent(0, "鼓"),
    onEvent(0, 38, 9),
    offEvent(240, 38, 9),
    onEvent(0, 42, 9),
    offEvent(240, 42, 9),
  ]);
  const melody = trackChunk([onEvent(0, 60), offEvent(480, 60)]);
  const { meta, musicxml } = midiToMusicXml(midiFile({ tracks: [drums, melody] }));
  assert.equal(meta.percussionNotes, 2);
  assert.equal(meta.parts, 1, "只剩旋律一个声部");
  assert.match(musicxml, /<step>C<\/step>/);
});

test("只有打击乐 / 没有音高的 MIDI 给出明确中文错误", () => {
  const drums = trackChunk([onEvent(0, 38, 9), offEvent(240, 38, 9)]);
  assert.throws(() => midiToMusicXml(midiFile({ tracks: [drums] })), /没有可记谱的音符/);
});

test("损坏或非 MIDI 文件给出中文错误", () => {
  assert.throws(() => parseMidiFile(new Uint8Array([1, 2, 3])), /MThd/);
  assert.throws(() => parseMidiFile(new Uint8Array(20)), /MThd/);
});

test("midiToPitchParts 覆盖全音域（MIDI 0–127 → C-1–G9）", () => {
  assert.deepEqual(midiToPitchParts(60), { step: "C", alter: 0, octave: 4 });
  assert.deepEqual(midiToPitchParts(61), { step: "C", alter: 1, octave: 4 });
  assert.deepEqual(midiToPitchParts(0), { step: "C", alter: 0, octave: -1 });
  assert.deepEqual(midiToPitchParts(127), { step: "G", alter: 0, octave: 9 });
});

test("detectKey 估计常用调号，并按调号拼写音名（少临时记号）", () => {
  const weighted = (pitchClasses, ticks = 480) =>
    pitchClasses.map((pitch) => ({ midi: 60 + pitch, startTick: 0, endTick: ticks }));
  // C 大调音级（C D E F G A B）：大调与小调存在调式歧义，但调号必须是 0。
  const cMajor = detectKey(weighted([0, 2, 4, 5, 7, 9, 11]));
  assert.equal(cMajor.fifths, 0);
  assert.match(keyDisplayName(cMajor), /^[A-G][#b]?( minor)?$/);
  // 降 E 大调音级（Eb F G Ab Bb C D）与 c 小调共用 3 个降号的调号：
  // 调式（大/小调）存在歧义没关系，但调号必须估成 -3，谱面才不会满屏临时记号。
  const eFlatMajor = detectKey(weighted([3, 5, 7, 8, 10, 0, 2]));
  assert.equal(eFlatMajor.fifths, -3);
  assert.match(keyDisplayName(eFlatMajor), /^[A-G][#b]?( minor)?$/);

  // 降号调里 Eb / Bb 应写成「E♭/B♭」，而不是 D♯/A♯
  const track = trackChunk([
    tempoEvent(0, 100),
    timeEvent(0, 4, 4),
    ...[63, 65, 67, 68, 70, 60, 62, 63].map((midi) => [onEvent(0, midi), offEvent(480, midi)]).flat(),
  ]);
  const { musicxml } = midiToMusicXml(midiFile({ tracks: [track] }));
  assert.match(musicxml, /<step>E<\/step><alter>-1<\/alter>/);
  assert.match(musicxml, /<step>B<\/step><alter>-1<\/alter>/);
  assert.doesNotMatch(musicxml, /<step>D<\/step><alter>1<\/alter>/, "Eb 不应拼成 D#");
});

test("多个音轨按轨道名生成声部，重名自动加序号", () => {
  const track = (noteNumber) => trackChunk([
    nameEvent(0, "同名声部"),
    onEvent(0, noteNumber),
    offEvent(480, noteNumber),
  ]);
  const parsed = midiToMusicXml(midiFile({ tracks: [track(60), track(62), track(64)] }));
  assert.equal(parsed.meta.parts, 3);
  const names = parseMusicXmlText(parsed.musicxml).partNames;
  assert.deepEqual(names, ["同名声部", "同名声部 2", "同名声部 3"]);
});

// —— 轨道归并（2026-11-10：MIDI 轨道 → 声部） ——

test("trackRelation：找出两条轨之间「同时开始 + 固定移调」的关系", () => {
  const base = Array.from({ length: 16 }, (_, index) => ({
    midi: 60 + index, startTick: index * 480, endTick: index * 480 + 480,
  }));
  const octave = base.map((note) => ({ ...note, midi: note.midi + 12 }));
  const relation = trackRelation(octave, base, 60);
  // shift 是「b 相对 a」的移调：a=高八度轨，b=原轨 → -12
  assert.equal(relation.shift, -12);
  assert.equal(relation.ratio, 1);
  assert.equal(trackRelation(base, base, 60).shift, 0);
});

test("自动整理：重复/八度/三度和声轨合并成「主旋律 + 和声/叠加层」", () => {
  const scale = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24, 26];
  const makeTrack = (name, shift) => trackChunk([
    nameEvent(0, name),
    tempoEvent(0, 120),
    timeEvent(0, 4, 4),
    ...scale.flatMap((pitch) => {
      const midi = 60 + pitch + shift;
      return [onEvent(0, midi), offEvent(480, midi)];
    }),
  ]);
  const bytes = midiFile({
    tracks: [makeTrack("主唱", 0), makeTrack("主唱重复", 0), makeTrack("高八度", 12), makeTrack("三度和声", 4)],
  });
  const auto = midiToMusicXml(bytes, { grouping: "auto" });
  assert.equal(auto.meta.parts, 2);
  assert.equal(auto.meta.grouping.consolidated, true);
  assert.deepEqual(auto.meta.grouping.groups.map((group) => group.name), ["主旋律", "和声 / 叠加层"]);
  assert.equal(auto.meta.grouping.groups[0].tracks.length, 2, "主唱 + 重复轨");
  assert.equal(auto.meta.grouping.groups[1].tracks.length, 2, "八度 + 三度和声轨");
  const parsed = parseMusicXmlText(auto.musicxml);
  assert.deepEqual(parsed.partNames, ["主旋律", "和声 / 叠加层"]);
  assert.equal(parsed.notes.filter((note) => note.partName === "主旋律").length, 16, "重复轨已按音高+起拍去重");
  const harmony = parsed.notes.filter((note) => note.partName === "和声 / 叠加层");
  assert.equal(harmony.length, 32);
  // 同时开始、同时结束的两个和声音 = 一个和弦（同一 eventId）
  const firstBeat = harmony.filter((note) => Math.abs(note.startBeat) < 1e-6);
  assert.equal(firstBeat.length, 2);
  assert.equal(firstBeat[0].eventId, firstBeat[1].eventId);
  // 其它模式
  const melodyOnly = midiToMusicXml(bytes, { grouping: "melody" });
  assert.equal(melodyOnly.meta.parts, 1);
  assert.deepEqual(parseMusicXmlText(melodyOnly.musicxml).partNames, ["主旋律"]);
  const tracksMode = midiToMusicXml(bytes, { grouping: "tracks" });
  assert.equal(tracksMode.meta.parts, 4);
  assert.deepEqual(parseMusicXmlText(tracksMode.musicxml).partNames, ["主唱", "主唱重复", "高八度", "三度和声"]);
  // 分声部版（阿卡贝拉分谱）：重复轨合并，但八度叠唱/三度和声各自成声部，名字标注角色
  const voicesMode = midiToMusicXml(bytes, { grouping: "voices" });
  assert.equal(voicesMode.meta.parts, 3);
  assert.deepEqual(voicesMode.meta.grouping.groups.map((group) => group.name),
    ["主旋律", "高八度叠唱", "和声（高 4 半音）"]);
  assert.equal(voicesMode.meta.grouping.groups[0].tracks.length, 2, "重复轨合并进主旋律");
  assert.deepEqual(parseMusicXmlText(voicesMode.musicxml).partNames,
    ["主旋律", "高八度叠唱", "和声（高 4 半音）"]);
});

test("自动整理：真正独立的声部不会被硬合并（退回一条轨道一个声部）", () => {
  // 三条轨：起拍错开、音域不同、没有固定移调关系 → 应该各自保留
  const lead = trackChunk([
    nameEvent(0, "旋律"),
    ...Array.from({ length: 16 }, (_, index) => [onEvent(0, 72 + (index % 5)), offEvent(480, 72 + (index % 5))]).flat(),
  ]);
  const bass = trackChunk([
    nameEvent(0, "低音"),
    ...Array.from({ length: 16 }, (_, index) => [onEvent(240, 40 + (index % 4)), offEvent(240, 40 + (index % 4))]).flat(),
  ]);
  const high = trackChunk([
    nameEvent(0, "高音"),
    ...Array.from({ length: 16 }, (_, index) => [onEvent(120, 84 + (index % 3)), offEvent(360, 84 + (index % 3))]).flat(),
  ]);
  const auto = midiToMusicXml(midiFile({ tracks: [lead, bass, high] }), { grouping: "auto" });
  assert.equal(auto.meta.parts, 3);
  assert.equal(auto.meta.grouping.consolidated, false);
  assert.deepEqual(parseMusicXmlText(auto.musicxml).partNames, ["旋律", "低音", "高音"]);
});

// —— 阿卡贝拉编配识别（2026-11-11）——

test("阿卡贝拉识别：自动区分主唱/低音/和声/叠层/加花，并给出三种版本", () => {
  const beatTicks = 480;
  const quarterTicks = 120;
  const steadyTrack = (name, pitchForBeat, offsetTicks, fromBeat, toBeat) => {
    let tick = 0;
    const events = [nameEvent(0, name)];
    for (let beat = fromBeat; beat <= toBeat; beat += 1) {
      const start = beat * beatTicks + offsetTicks;
      events.push(onEvent(start - tick, pitchForBeat(beat)));
      tick = start;
      events.push(offEvent(beatTicks, pitchForBeat(beat)));
      tick = start + beatTicks;
    }
    return trackChunk(events);
  };
  const sixteenthTrack = (name, pitchForIndex, fromBeat, count) => {
    let tick = 0;
    const events = [nameEvent(0, name)];
    for (let index = 0; index < count; index += 1) {
      const start = fromBeat * beatTicks + index * quarterTicks;
      events.push(onEvent(start - tick, pitchForIndex(index)));
      tick = start;
      events.push(offEvent(quarterTicks, pitchForIndex(index)));
      tick = start + quarterTicks;
    }
    return trackChunk(events);
  };
  const bassPattern = [40, 43, 36, 38];
  const tracks = [
    trackChunk([tempoEvent(0, 120), timeEvent(0, 4, 4)]),
    sixteenthTrack("主唱1", (index) => 60 + ((index * 5) % 13), 0, 128),
    sixteenthTrack("主唱2", (index) => 60 + ((index * 7) % 13), 32, 128),
    steadyTrack("bass", (beat) => bassPattern[beat % 4], 0, 0, 60),
    steadyTrack("和声低", () => 52, 0, 0, 60),
    steadyTrack("和声中", () => 55, 240, 0, 60),
    steadyTrack("和声高", () => 59, 360, 0, 60),
    steadyTrack("叠层1", () => 72, 0, 56, 60),
    steadyTrack("叠层2", () => 76, 0, 56, 60),
    steadyTrack("加花", () => 64, 0, 20, 27),
  ];
  const bytes = midiFile({ tracks });

  const auto = midiToMusicXml(bytes, { grouping: "auto" });
  assert.equal(auto.meta.grouping.acappellaAvailable, true, "应识别出阿卡贝拉编配");
  assert.equal(auto.meta.grouping.applied, "acappella6", "自动模式应落到阿卡贝拉核心版");
  assert.equal(auto.meta.parts, 6);
  assert.deepEqual(auto.meta.grouping.acappellaRoles.map((role) => role.name),
    ["主唱 1", "主唱 2", "和声 · 高", "和声 · 中", "和声 · 低", "低音", "叠层 1", "叠层 2", "加花"]);
  assert.deepEqual(auto.meta.grouping.acappellaStats,
    { tracks: 9, leads: 2, harmony: 3, pads: 2, fills: 1, others: 0 });
  assert.deepEqual(auto.meta.grouping.acappellaVersions, { core: 6, full: 8, reference: 9 });
  assert.deepEqual(parseMusicXmlText(auto.musicxml).partNames,
    ["主唱 1", "主唱 2", "和声 · 高", "和声 · 中", "和声 · 低", "低音"]);

  const full = midiToMusicXml(bytes, { grouping: "acappella10" });
  assert.equal(full.meta.grouping.applied, "acappella10");
  assert.equal(full.meta.parts, 8, "完整版 = 核心 6 + 2 个叠层");
  const reference = midiToMusicXml(bytes, { grouping: "acappella12" });
  assert.equal(reference.meta.parts, 9, "全部轨道 = 完整版 + 加花");
  assert.deepEqual(parseMusicXmlText(reference.musicxml).partNames.slice(-3), ["叠层 1", "叠层 2", "加花"]);

  const melodyOnly = midiToMusicXml(bytes, { grouping: "melody" });
  assert.equal(melodyOnly.meta.parts, 1);
  assert.deepEqual(parseMusicXmlText(melodyOnly.musicxml).partNames, ["主旋律"]);
  const tracksMode = midiToMusicXml(bytes, { grouping: "tracks" });
  assert.equal(tracksMode.meta.parts, 9);
});

test("阿卡贝拉识别不可靠时退回逐轨，不会硬拆声部", () => {
  const track = (name, noteNumber) => trackChunk([
    nameEvent(0, name),
    onEvent(0, noteNumber),
    offEvent(480, noteNumber),
  ]);
  const bytes = midiFile({ tracks: [track("甲", 60), track("乙", 62), track("丙", 64)] });
  const auto = midiToMusicXml(bytes, { grouping: "auto" });
  assert.equal(auto.meta.grouping.acappellaAvailable, false);
  assert.equal(auto.meta.parts, 3);
  const requested = midiToMusicXml(bytes, { grouping: "acappella10" });
  assert.equal(requested.meta.grouping.applied, "tracks", "识别失败时 acappella 模式应如实退回逐轨");
  assert.equal(requested.meta.parts, 3);
});