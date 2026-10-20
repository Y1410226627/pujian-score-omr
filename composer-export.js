// 乐谱导出：MusicXML（可用制谱软件打开/继续编辑）与 MIDI（可直接播放）。
// 纯字符串/字节拼接，不依赖 DOM，可在 node 里单测。
//
// 为什么不用现成的 MusicXML 库：本项目只需要「按拍写音符」这一小部分子集，
// 自己写反而能保证每个音都带 <duration>（divisions=480 时所有常用时值都是整数），
// 也让「零基础用户拼出来的乐谱」在 MuseScore 等软件里不会被判成格式错误。

import { buildMeasureSlots, trimTrailingEmptyMeasures, scoreTotalBeats } from "./composer.js";

const DIVISIONS = 480;
const NOTE_TYPES = [
  { beats: 4, type: "whole" },
  { beats: 3, type: "half", dots: 1 },
  { beats: 2, type: "half" },
  { beats: 1.5, type: "quarter", dots: 1 },
  { beats: 1, type: "quarter" },
  { beats: 0.75, type: "eighth", dots: 1 },
  { beats: 0.5, type: "eighth" },
  { beats: 0.25, type: "16th" },
  { beats: 0.125, type: "32nd" },
];
const STEP_BY_PITCH = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const ALTER_BY_PITCH = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

function escapeXml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** MIDI → { step, alter, octave }（用升号写法，MusicXML 的 alter 负责表示升降）。 */
export function midiToStepAlter(midi) {
  const value = Math.max(0, Math.min(127, Math.round(Number(midi) || 0)));
  const pitch = ((value % 12) + 12) % 12;
  const octave = Math.floor(value / 12) - 1;
  return { step: STEP_BY_PITCH[pitch], alter: ALTER_BY_PITCH[pitch], octave };
}

/** 拍数 → { type, dots }；认不出的时值按最长不超过它的基础时值 + 附点表示。 */
export function noteTypeOf(beats) {
  let best = NOTE_TYPES[NOTE_TYPES.length - 1];
  for (const item of NOTE_TYPES) {
    if (Math.abs(item.beats - Number(beats)) < 1e-6) return { type: item.type, dots: item.dots || 0 };
    if (item.beats < Number(beats)) break;
  }
  return { type: best.type, dots: 0 };
}

function noteXml({ midi, beats, rest = false, chord = false }, { clef, staff = 1, indent }) {
  const { type, dots } = noteTypeOf(beats);
  const duration = Math.max(1, Math.round(Number(beats) * DIVISIONS));
  const pad = indent || "        ";
  const head = rest
    ? `${pad}<rest/>`
    : (() => {
        const { step, alter, octave } = midiToStepAlter(midi);
        return `${pad}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>`;
      })();
  const lines = [`${pad}<note>`, chord ? `${pad}  <chord/>` : null, head,
    `${pad}  <duration>${duration}</duration>`,
    `${pad}  <voice>1</voice>`, `${pad}  <type>${type}</type>`].filter((line) => line !== null);
  for (let index = 0; index < dots; index += 1) lines.push(`${pad}  <dot/>`);
  lines.push(`${pad}  <staff>${staff}</staff>`, `${pad}</note>`);
  return lines.join("\n");
}

/** 把一小节补满（空出来的地方写休止），MusicXML 才不会被判成残小节。 */
function measureContent(measure, beatsPerMeasure) {
  const { slots, remaining } = buildMeasureSlots(measure, beatsPerMeasure);
  // 休止符要保留：它占拍数、在乐谱上画成休止，导出时不能变成「什么都没有」。
  // 和弦：一个槽位有 chordMidis 时，先写主音、再把其余音写成带 <chord/> 的 note
  //（MusicXML 规定 <chord/> 的音不推进时间轴）。
  const items = [];
  for (const slot of slots) {
    items.push({
      midi: slot.rest ? 0 : slot.midi,
      beats: slot.beats,
      rest: Boolean(slot.rest),
    });
    if (!slot.rest && Array.isArray(slot.chordMidis)) {
      for (const extraMidi of slot.chordMidis) {
        items.push({ midi: extraMidi, beats: slot.beats, rest: false, chord: true });
      }
    }
  }
  if (remaining > 1e-9) items.push({ beats: remaining, rest: true });
  return items;
}

/** 声部 → MusicXML part 名（导出后在其他软件里看到的名字）。 */
function partNameOf(part, index) {
  return part.name || `声部 ${index + 1}`;
}

const CLEF_BY_NAME = {
  treble: { sign: "G", line: 2, octaveChange: 0 },
  bass: { sign: "F", line: 4, octaveChange: 0 },
  alto: { sign: "C", line: 3, octaveChange: 0 },
  tenor: { sign: "C", line: 4, octaveChange: 0 },
  treble8: { sign: "G", line: 2, octaveChange: -1 },
};

/**
 * 乐谱 → MusicXML 文本。
 * 只导出「有音符的小节数」（末尾空白小节会被裁掉），保证导出的谱子不会带一串空行。
 */
export function scoreToMusicXml(score) {
  const beatsPerMeasure = Number(score && score.beatsPerMeasure) || 4;
  const beatType = Number(score && score.beatType) || 4;
  const parts = (score && score.parts) || [];
  const measureCount = Math.max(1, Math.ceil(scoreTotalBeats(score) / beatsPerMeasure));
  for (const part of parts) trimTrailingEmptyMeasures(part);

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<score-partwise version="4.0">'];
  lines.push("  <work><work-title>" + escapeXml(score.title || "未命名乐谱") + "</work-title></work>");
  lines.push("  <identification><encoding><software>谱见 · 零基础创作室</software></encoding></identification>");
  lines.push("  <part-list>");
  parts.forEach((part, index) => {
    const id = `P${index + 1}`;
    lines.push(`    <score-part id="${id}"><part-name>${escapeXml(partNameOf(part, index))}</part-name></score-part>`);
  });
  lines.push("  </part-list>");

  parts.forEach((part, index) => {
    const id = `P${index + 1}`;
    const clef = CLEF_BY_NAME[part.clef] || CLEF_BY_NAME.treble;
    lines.push(`  <part id="${id}">`);
    for (let measureIndex = 0; measureIndex < measureCount; measureIndex += 1) {
      const measure = part.measures[measureIndex] || { beats: [] };
      lines.push(`    <measure number="${measureIndex + 1}">`);
      if (measureIndex === 0) {
        lines.push("      <attributes>");
        lines.push(`        <divisions>${DIVISIONS}</divisions>`);
        lines.push(`        <key><fifths>${Number(score.keyFifths) || 0}</fifths></key>`);
        lines.push(`        <time><beats>${beatsPerMeasure}</beats><beat-type>${beatType}</beat-type></time>`);
        lines.push(`        <clef><sign>${clef.sign}</sign><line>${clef.line}</line>`
          + (clef.octaveChange ? `<clef-octave-change>${clef.octaveChange}</clef-octave-change>` : "")
          + "</clef>");
        lines.push("      </attributes>");
        if (index === 0) {
          const tempo = Math.max(20, Math.min(320, Math.round(Number(score.tempo) || 84)));
          lines.push('      <direction placement="above">');
          lines.push("        <direction-type><metronome><beat-unit>quarter</beat-unit>"
            + `<per-minute>${tempo}</per-minute></metronome></direction-type>`);
          lines.push(`        <sound tempo="${tempo}"/>`);
          lines.push("      </direction>");
        }
      }
      for (const item of measureContent(measure, beatsPerMeasure)) {
        lines.push(noteXml(item, { clef: part.clef }));
      }
      lines.push("    </measure>");
    }
    lines.push("  </part>");
  });
  lines.push("</score-partwise>");
  return lines.join("\n") + "\n";
}

/** 变长整数（MIDI 的 delta time 编码）。 */
export function variableLength(value) {
  let number = Math.max(0, Math.round(Number(value) || 0));
  const bytes = [number & 0x7f];
  number >>= 7;
  while (number > 0) {
    bytes.unshift((number & 0x7f) | 0x80);
    number >>= 7;
  }
  return bytes;
}

const GM_PROGRAM = {
  piano: 0, soft: 4, organ: 19, strings: 48, choir: 52,
  // 采样音色：没有音源时也按最接近的 GM 乐器导出，别的软件打开能听个大概
  piano_real: 0, electric_piano_real: 4, harpsichord_real: 6, church_organ_real: 19,
  vibraphone_real: 11, marimba_real: 12, xylophone_real: 13, glockenspiel_real: 9,
  celesta_real: 8, tubular_bells_real: 14, steel_drums_real: 114, timpani_real: 47,
  strings_real: 48, violin_real: 40, viola_real: 41, cello_real: 42, contrabass_real: 43,
  pizzicato_real: 45, tremolo_real: 44, harp_real: 46, acoustic_bass_real: 32, electric_bass_real: 33,
  fretless_bass_real: 35, flute_real: 73, piccolo_real: 72, clarinet_real: 71, oboe_real: 68,
  english_horn_real: 69, bassoon_real: 70, recorder_real: 74, ocarina_real: 79, pan_flute_real: 75,
  whistle_real: 78, shakuhachi_real: 77, trumpet_real: 56, trombone_real: 57, tuba_real: 58,
  french_horn_real: 60, brass_section_real: 61, alto_sax_real: 65, tenor_sax_real: 66,
  soprano_sax_real: 64, baritone_sax_real: 67, nylon_guitar_real: 24, steel_guitar_real: 25,
  electric_guitar_real: 27, banjo_real: 105, sitar_real: 104, choir_real: 52, choir_female: 52,
  choir_male: 52, voice_oohs_real: 53, pad_real: 89, synth_choir_real: 52, synth_lead_real: 81,
  shamisen_real: 106, koto_real: 107, kalimba_real: 108, erhu_real: 110, pipa_real: 105,
  guzheng_real: 107, dizi_real: 72, xiao_real: 73, sheng_real: 20, suona_real: 111,
  yangqin_real: 15, accordion_real: 21,
};

export function programForTimbre(timbre) {
  const value = GM_PROGRAM[timbre];
  return Number.isInteger(value) ? value : 0;
}

/**
 * 乐谱 → MIDI（Type 1，每个声部一条轨；第 0 轨放速度）。
 * 返回 Uint8Array，可直接下载成 .mid。
 */
export function scoreToMidi(score) {
  const beatsPerMeasure = Number(score && score.beatsPerMeasure) || 4;
  const tempo = Math.max(20, Math.min(320, Math.round(Number(score && score.tempo) || 84)));
  const microsPerBeat = Math.round(60000000 / tempo);
  const tracks = [];

  // 第 0 轨：只放速度与结束标记
  tracks.push(buildTrack([
    { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (microsPerBeat >> 16) & 0xff, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff] },
  ]));

  (score.parts || []).forEach((part, index) => {
    trimTrailingEmptyMeasures(part);
    const channel = index % 16;
    const events = [{ tick: 0, order: 0, bytes: [0xc0 | channel, programForTimbre(part.timbre) & 0x7f] }];
    part.measures.forEach((measure, measureIndex) => {
      const { slots } = buildMeasureSlots(measure, beatsPerMeasure);
      for (const slot of slots) {
        if (slot.rest) continue;   // 休止符不产生 MIDI 事件
        const start = Math.round((measureIndex * beatsPerMeasure + slot.startBeats) * DIVISIONS);
        const end = start + Math.max(1, Math.round(slot.beats * DIVISIONS));
        const velocity = Math.max(1, Math.min(127, Math.round(96 * (Number(part.volume) || 1))));
        events.push({ tick: start, order: 2, bytes: [0x90 | channel, Math.max(0, Math.min(127, slot.midi)), velocity] });
        events.push({ tick: end, order: 1, bytes: [0x80 | channel, Math.max(0, Math.min(127, slot.midi)), 0] });
      }
    });
    // 同名音轨名（0x03 = track name）
    const name = part.name || `声部 ${index + 1}`;
    const nameBytes = [...name].map((character) => character.codePointAt(0)).filter((code) => code < 128);
    events.push({ tick: 0, order: 1, bytes: [0xff, 0x03, nameBytes.length, ...nameBytes] });
    tracks.push(buildTrack(events));
  });

  const header = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x01,                                  // format 1
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    0x01, 0xe0,                                  // divisions 480
  ];
  const bytes = [...header];
  for (const track of tracks) bytes.push(...track);
  return new Uint8Array(bytes);
}

function buildTrack(events) {
  const sorted = [...events].sort((left, right) => left.tick - right.tick || left.order - right.order);
  const body = [];
  let previousTick = 0;
  for (const event of sorted) {
    body.push(...variableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00);
  const length = body.length;
  return [0x4d, 0x54, 0x72, 0x6b,
    (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, ...body];
}

/** 乐谱 → 可下载的 .json 工程文件（下次导入继续编辑）。 */
export function scoreToProjectJson(score) {
  return JSON.stringify({ format: "pujian-composer", version: 1, score }, null, 1);
}
