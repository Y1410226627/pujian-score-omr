import assert from "node:assert/strict";
import test from "node:test";

import {
  notesToMeasures, snapBeats, parseTimeSummary, fifthsFromKeySummary, scoreInfoToComposerScore,
} from "../composer-import.js";
import { scoreToPlayableNotes, buildMeasureSlots } from "../composer.js";
import { scoreToMusicXml } from "../composer-export.js";

const note = (midi, startBeat, durationBeats, partId = "P1") =>
  ({ midi, startBeat, durationBeats, partId, partName: partId });

test("时值对齐到创作室支持的档位", () => {
  assert.equal(snapBeats(1), 1);
  assert.equal(snapBeats(1.02), 1);
  assert.equal(snapBeats(0.5), 0.5);
  assert.equal(snapBeats(0.9), 1, "0.9 更接近 1");
  assert.equal(snapBeats(0.52), 0.5);
  assert.equal(snapBeats(0), 0);
});

test("拍号解析：4/4、3/8、6/8", () => {
  assert.deepEqual(parseTimeSummary("4/4"), { beats: 4, beatType: 4 });
  assert.deepEqual(parseTimeSummary("3/8"), { beats: 3, beatType: 8 });
  assert.deepEqual(parseTimeSummary("6/8"), { beats: 6, beatType: 8 });
  assert.deepEqual(parseTimeSummary(""), { beats: 4, beatType: 4 }, "空值回退 4/4");
});

test("调号：C/G/D/F/Bb → fifths", () => {
  assert.equal(fifthsFromKeySummary("C"), 0);
  assert.equal(fifthsFromKeySummary("G"), 1);
  assert.equal(fifthsFromKeySummary("D"), 2);
  assert.equal(fifthsFromKeySummary("F"), -1);
  assert.equal(fifthsFromKeySummary("Bb"), -2);
  assert.equal(fifthsFromKeySummary("" ), 0);
});

test("顺序音符 → 小节结构（紧凑排列，不补空）", () => {
  const { measures, noteCount } = notesToMeasures([note(60, 0, 1), note(62, 1, 1), note(64, 2, 2)], 4);
  assert.equal(noteCount, 3);
  assert.equal(measures.length, 1);
  assert.deepEqual(measures[0].beats.map((item) => item.midi), [60, 62, 64]);
  assert.deepEqual(measures[0].beats.map((item) => item.beats), [1, 1, 2]);
});

test("有空隙时补休止（否则整首会挤在一起）", () => {
  // 音符在第 0 拍和第 3 拍之间留了 2 拍空
  const { measures, restBeats } = notesToMeasures([note(60, 0, 1), note(64, 3, 1)], 4);
  assert.equal(measures.length, 1);
  assert.deepEqual(measures[0].beats.map((item) => item.rest ? "rest" : item.midi), [60, "rest", 64]);
  assert.equal(measures[0].beats[1].beats, 2, "补 2 拍休止");
  assert.equal(restBeats, 2);
});

test("跨小节的音符被截断到小节线", () => {
  const { measures } = notesToMeasures([note(60, 3, 2)], 4);  // 第 4 拍起，2 拍长
  assert.equal(measures.length, 2, "应该跨两小节");
  assert.equal(measures[0].beats.at(-1).beats, 1, "第 1 小节只占 1 拍");
  assert.equal(measures[1].beats[0].beats, 1, "剩下的 1 拍进第 2 小节");
});

test("和弦被完整保留（同一拍多个音高）", () => {
  const { measures, noteCount } = notesToMeasures([
    note(60, 0, 1), note(64, 0, 1), note(67, 0, 1),   // C 大三和弦
    note(62, 1, 1),
  ], 4);
  assert.equal(measures[0].beats.length, 2, "和弦只占一个拍位");
  const chord = measures[0].beats[0];
  assert.equal(chord.midi, 60, "主音取最低音");
  assert.deepEqual(chord.chordMidis, [64, 67], "其余音在 chordMidis");
  assert.equal(noteCount, 4, "四个音都算进去了");
});

test("带和弦的谱子导出成 MusicXML 后不丢音", () => {
  const { score } = scoreInfoToComposerScore({
    title: "和弦测试", tempo: 100, timeSummary: "4/4", keySummary: "C",
    notes: [note(60, 0, 1), note(64, 0, 1), note(67, 0, 1), note(62, 1, 1)],
    partNames: ["Piano"],
  });
  const xml = scoreToMusicXml(score);
  const noteBlocks = [...xml.matchAll(/<note>[\s\S]*?<\/note>/g)].map((item) => item[0]);
  const pitched = noteBlocks.filter((block) => !block.includes("<rest"));
  assert.ok(pitched.length >= 4, `导出后应有 4 个音，实际 ${pitched.length}`);
  assert.equal((xml.match(/<chord\/>/g) || []).length, 2, "和弦两个附加音带 <chord/>");
  // 播放也要能听到全部 4 个音
  const playable = scoreToPlayableNotes(score).filter((item) => item.startBeat < 2);
  assert.ok(playable.length >= 4, `播放应有 4 个音，实际 ${playable.length}`);
});

test("识别结果 → 创作室工程：声部/拍号/调号/速度都对", () => {
  const { score, stats } = scoreInfoToComposerScore({
    title: "测试曲", tempo: 138, timeSummary: "3/8", keySummary: "D",
    notes: [
      { midi: 62, startBeat: 0, durationBeats: 0.5, partId: "P1", partName: "P1" },
      { midi: 64, startBeat: 0.5, durationBeats: 0.5, partId: "P1", partName: "P1" },
      { midi: 50, startBeat: 0, durationBeats: 1.5, partId: "P2", partName: "P2" },
    ],
    partNames: ["右手", "左手"],
  });
  assert.equal(score.title, "测试曲");
  assert.equal(score.tempo, 138);
  assert.equal(score.beatsPerMeasure, 1.5, "3/8 = 1.5 个四分音符");
  assert.equal(score.beatType, 8);
  assert.equal(score.keyFifths, 2, "D 大调 = 2 个升号");
  assert.equal(score.parts.length, 2, "两个声部");
  assert.equal(stats.parts, 2);
  assert.equal(stats.notes, 3);
});

test("真实片段：Hall 曲前两小节（含和弦）往返后音符数不变", () => {
  // 取自真实识别结果的片段形态：第 1 小节是分解和弦 + 低音
  const notes = [];
  for (let index = 0; index < 8; index += 1) {
    notes.push({ midi: 55 + index, startBeat: index * 0.5, durationBeats: 0.5, partId: "P1" });
  }
  notes.push({ midi: 38, startBeat: 0, durationBeats: 0.5, partId: "P1" });
  const { measures, noteCount } = notesToMeasures(notes, 4);
  assert.equal(noteCount, 9, "9 个音都应被计入（其中 1 个与低音同拍，合成和弦）");
  const totalPitches = measures.reduce((sum, measure) => sum
    + measure.beats.reduce((inner, beat) => inner + 1 + (beat.chordMidis ? beat.chordMidis.length : 0), 0), 0);
  assert.equal(totalPitches, 9, "所有音高都还在（1 个和弦 + 8 个单音）");
});

test("空谱不崩", () => {
  const { score, stats } = scoreInfoToComposerScore({ notes: [], partNames: [] });
  assert.ok(score.parts.length >= 1, "至少有一个空声部");
  assert.equal(stats.notes, 0);
});
