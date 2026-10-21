// 音色参数表：只放「纯数据 + 纯函数」，不碰 Web Audio API。
//
// 为什么单独拆一个文件：音高/泛音/共振峰这些乐理数值是可以用单元测试验证的
// （泛音必须递减、共振峰必须 F1<F2<F3、制音时间必须随音高变短……），
// 而真正的发声（Oscillator/BiquadFilter/混响）只能在浏览器里测。分开之后
// 这些参数在 node 里就能直接测，见 tests/timbre.test.mjs。
//
// 术语（给非音乐专业的读者）：
// - 泛音/谐波：一个音除了基音（听起来最响的那个频率）之外还带着 2 倍、3 倍…频率的成分。
//   泛音的强弱分布决定了「这是钢琴还是小提琴」——这叫音色。
// - 共振峰：人声的「元音」特征频率。把声带的声音按 800 Hz / 1150 Hz / 2900 Hz
//   附近加强，听起来就是「啊」；换成 450 / 800 / 2830 就是「哦」。

/** 音色名（界面下拉选项用的显示文字）。带「（采样）」= 真实录音，需先装音源。 */
export const TIMBRE_LABELS = {
  // 合成音色
  piano: "钢琴（合成）", strings: "弦乐（合成）", choir: "混声合唱（合成）",
  choir_female_synth: "女声合唱（合成）", organ: "管风琴（合成）", soft: "电子琴（合成）",
  // 钢琴 / 键盘（采样）
  piano_real: "真实钢琴（采样）", electric_piano_real: "电钢琴（采样）",
  harpsichord_real: "羽管键琴（采样）", vibraphone_real: "颤音琴（采样）",
  church_organ_real: "教堂管风琴（采样）", pad_real: "温暖铺底（采样）",
  // 弦乐（采样，可细分）
  strings_real: "真实弦乐合奏（采样）", violin_real: "小提琴（采样）", viola_real: "中提琴（采样）",
  cello_real: "大提琴（采样）", contrabass_real: "低音提琴（采样）",
  pizzicato_real: "拨弦（采样）", tremolo_real: "震音弦乐（采样）", harp_real: "竖琴（采样）",
  // 人声（采样）
  choir_real: "真实混声合唱（采样）", choir_female: "真实女声合唱（采样）",
  choir_male: "真实男声合唱（采样）", voice_oohs_real: "人声「哦」（采样）",
  synth_choir_real: "合成人声合唱（采样）",
  // 管乐（采样）
  flute_real: "长笛（采样）", clarinet_real: "单簧管（采样）", oboe_real: "双簧管（采样）",
  bassoon_real: "大管（采样）", trumpet_real: "小号（采样）", horn_real: "圆号（采样）",
  trombone_real: "长号（采样）",
  erhu_real: "二胡（采样）",
  zhonghu_real: "中胡（采样·近似中提琴）",
  gaohu_real: "高胡（采样·近似小提琴）",
  pipa_real: "琵琶（采样）",
  zhongruan_real: "中阮（采样·近似尼龙弦吉他）",
  daruan_real: "大阮（采样·近似原声贝斯）",
  liuqin_real: "柳琴（采样·近似班卓琴）",
  guzheng_real: "古筝（采样）",
  dizi_real: "笛子（采样）",
  qudi_real: "曲笛（采样·近似长笛）",
  xiao_real: "箫（采样）",
  xun_real: "埙（采样·近似陶笛）",
  guanzi_real: "管子（采样·近似唢呐）",
  sheng_real: "笙（采样）",
  suona_real: "唢呐（采样）",
  yangqin_real: "扬琴（采样）",
  yunluo_real: "云锣（采样·近似管钟）",
  pengling_real: "碰铃（采样·近似指钹）",
  muyu_real: "木鱼（采样·近似木鱼块）",
  xiaoluo_real: "小锣（采样·近似锣）",
  daluo_real: "大锣（采样·近似锣）",
  bo_real: "钹（采样·近似交响钹）",
  paigu_real: "排鼓（采样·近似通鼓）",
  accordion_real: "手风琴（采样）",
  piccolo_real: "短笛（采样）",
  english_horn_real: "英国管（采样）",
  recorder_real: "竖笛（采样）",
  ocarina_real: "陶笛（采样）",
  tuba_real: "大号（采样）",
  french_horn_real: "圆号（采样）",
  brass_section_real: "铜管合奏（采样）",
  nylon_guitar_real: "尼龙弦吉他（采样）",
  steel_guitar_real: "民谣吉他（采样）",
  electric_guitar_real: "电吉他（采样）",
  banjo_real: "班卓琴（采样）",
  sitar_real: "西塔琴（采样）",
  acoustic_bass_real: "原声贝斯（采样）",
  electric_bass_real: "电贝斯（采样）",
  fretless_bass_real: "无品贝斯（采样）",
  alto_sax_real: "中音萨克斯（采样）",
  tenor_sax_real: "次中音萨克斯（采样）",
  soprano_sax_real: "高音萨克斯（采样）",
  baritone_sax_real: "上低音萨克斯（采样）",
  marimba_real: "马林巴（采样）",
  xylophone_real: "木琴（采样）",
  glockenspiel_real: "钟琴（采样）",
  celesta_real: "钢片琴（采样）",
  tubular_bells_real: "管钟（采样）",
  steel_drums_real: "钢鼓（采样）",
  timpani_real: "定音鼓（采样）",
  synth_lead_real: "合成主音（采样）",
  shakuhachi_real: "尺八（采样）",
  shamisen_real: "三味线（采样）",
  koto_real: "日本筝（采样）",
  kalimba_real: "拇指琴（采样）",
  pan_flute_real: "排箫（采样）",
  whistle_real: "哨笛（采样）",
};
/** 界面下拉的分组（optgroup）：同组内合成音色在前、采样音色在后。 */
export const TIMBRE_GROUPS = [
  { label: "钢琴 / 键盘", ids: [
    "piano", "piano_real", "electric_piano_real", "harpsichord_real", "vibraphone_real",
    "church_organ_real", "organ", "soft", "pad_real", "accordion_real", "celesta_real",
    "glockenspiel_real", "marimba_real", "xylophone_real", "tubular_bells_real", "steel_drums_real",
    "timpani_real",
  ] },
  { label: "弦乐", ids: [
    "strings", "strings_real", "violin_real", "viola_real", "cello_real",
    "contrabass_real", "pizzicato_real", "tremolo_real", "harp_real",
  ] },
  { label: "中国民族乐器", ids: [
    "erhu_real", "zhonghu_real", "gaohu_real", "pipa_real", "zhongruan_real", "daruan_real",
    "liuqin_real", "guzheng_real", "yangqin_real", "dizi_real", "qudi_real", "xiao_real",
    "xun_real", "guanzi_real", "sheng_real", "suona_real",
  ] },
  { label: "中国打击乐", ids: [
    "pengling_real", "muyu_real", "xiaoluo_real", "daluo_real", "bo_real", "paigu_real", "yunluo_real",
  ] },
  { label: "人声（合唱）", ids: [
    "choir", "choir_female_synth", "choir_real", "choir_female", "choir_male",
    "voice_oohs_real", "synth_choir_real",
  ] },
  { label: "管乐", ids: [
    "flute_real", "piccolo_real", "clarinet_real", "oboe_real", "english_horn_real",
    "bassoon_real", "recorder_real", "ocarina_real", "pan_flute_real", "whistle_real", "shakuhachi_real",
  ] },
  { label: "铜管", ids: [
    "trumpet_real", "horn_real", "french_horn_real", "trombone_real", "tuba_real", "brass_section_real",
  ] },
  { label: "萨克斯", ids: [
    "soprano_sax_real", "alto_sax_real", "tenor_sax_real", "baritone_sax_real",
  ] },
  { label: "弹拨 / 吉他", ids: [
    "nylon_guitar_real", "steel_guitar_real", "electric_guitar_real", "banjo_real", "sitar_real",
    "shamisen_real", "koto_real", "kalimba_real",
  ] },
  { label: "贝斯", ids: [
    "acoustic_bass_real", "electric_bass_real", "fretless_bass_real",
  ] },
  { label: "合成 / 电子", ids: [
    "synth_lead_real",
  ] },
];
/** 界面下拉的显示顺序（各分组顺序展开）。 */
export const TIMBRE_ORDER = TIMBRE_GROUPS.flatMap((group) => group.ids);

/**
 * 钢琴泛音强度：第 n 次泛音约 1/n^1.35 递减，第 7 次以上再压到 0.7。
 * 真实钢琴的能量集中在 1–4 次泛音，高次泛音负责起音时的「金属感/颗粒感」，
 * 但太多会变成电子琴的「金属味」，所以后半段要压。
 * 下标 0 对应第 1 泛音（基音）。
 */
export const PIANO_HARMONICS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(
  (n) => (1 / (n ** 1.35)) * (n >= 7 ? 0.7 : 1),
);

/**
 * 钢琴同音弦的微失谐：真实钢琴一个音有 2–3 根弦，调律后仍有 1–3 音分偏差，
 * 两根弦叠加会产生缓慢的「拍音」（beating），这是钢琴听起来「厚」的关键。
 * [相对音量, 失谐音分]；第一个是主弦（不失谐）。
 */
export const PIANO_STRINGS = [[1, 0], [0.55, 1.9]];

/**
 * 弦乐（小提琴/中提琴合奏）的失谐：合奏里每个演奏者都不会完全齐，
 * 两把琴差 4–8 音分时最像「一群人拉弦」。
 */
export const STRINGS_DETUNE = [[1, -5], [0.8, 5], [0.5, 11]];

/** 管风琴：基音 + 八度 + 十二度（八度+五度）混合音栓，越高的音栓越弱。 */
export const ORGAN_HARMONICS = [1, 0.5, 0.34, 0.22, 0.14, 0.1, 0.07];

/**
 * 元音共振峰：[中心频率 Hz, 相对强度（0–1）, 带宽 Hz]。
 * 频率取的是男女声折中值；带宽越窄，「元音」的峰越尖、越像独唱，宽一点更像合唱。
 */
export const VOWELS = {
  a: [[800, 1, 110], [1150, 0.55, 130], [2900, 0.2, 180]],
  o: [[450, 1, 100], [800, 0.5, 120], [2830, 0.15, 180]],
  u: [[325, 1, 90], [700, 0.42, 110], [2530, 0.12, 170]],
  e: [[400, 1, 90], [1600, 0.5, 130], [2700, 0.18, 170]],
};
/** 各声部轮流分到的元音：让合唱听起来是「一群人」，而不是一个人叠了几遍。 */
export const VOWEL_ORDER = ["a", "o", "e", "u"];

/**
 * 女声的元音共振峰：比混声/男声整体高 20%–40%（女声 F1 约 850、F2 约 1200、F3 约 2800）。
 * 性别听感主要由共振峰决定（而不是音高），所以「合成女声合唱」就靠这张表 + 更亮的音色。
 */
export const FEMALE_VOWELS = {
  a: [[850, 1, 120], [1220, 0.6, 140], [2810, 0.22, 190]],
  o: [[500, 1, 110], [900, 0.5, 130], [2830, 0.16, 190]],
  u: [[370, 1, 100], [950, 0.45, 120], [2670, 0.13, 180]],
  e: [[500, 1, 100], [1800, 0.5, 140], [2700, 0.2, 180]],
};

/** 把任意声部标识稳定地映射到一个元音（同一份乐谱每次播放都一样）。 */
export function vowelForPart(partKey) {
  let hash = 0;
  for (const character of String(partKey || "")) hash = (hash * 31 + character.codePointAt(0)) % 9973;
  return VOWEL_ORDER[hash % VOWEL_ORDER.length];
}

/**
 * 钢琴制音时间（秒）：松键后琴弦多久停住。
 * 低音弦又长又重，制音慢；高音一下就停。范围 0.08–0.44 秒。
 */
export function pianoDamperSeconds(midi) {
  return Math.min(0.44, Math.max(0.08, 0.44 - (Number(midi) - 40) * 0.006));
}

/**
 * 钢琴低通的「亮度包络」两端频率（Hz）：
 * 起音瞬间泛音全开（亮度高），随后收暗成温暖余音——这是钢琴最容易被耳朵认出
 * 的特征之一。力度越大、音越高，起音越亮。
 */
export function pianoBrightness(frequency, peak) {
  const start = Math.max(600, Math.min(20000, frequency * 15 + 1500 * (peak / 0.16)));
  const end = Math.max(220, frequency * 2.4);
  return { start, end: Math.min(start, end) };
}

/**
 * 钢琴两段衰减：起音 6 ms 冲到峰值，90 ms 掉到 45%（击弦能量释放），
 * 之后缓慢衰减到 20%（弦的自然余音）。
 */
export function pianoDecayShape(peak) {
  return [
    { at: 0.006, level: peak },
    { at: 0.09, level: Math.max(0.0002, peak * 0.45) },
    { at: 1.0, level: Math.max(0.0002, peak * 0.2) },
  ];
}

/** 人声起音/保持/释放的时间（秒）：起音明显比钢琴慢，连唱时不会有「哒哒」的点击感。 */
// onset = 起音最初 12 ms 就到达的音量比例：人声不是从 0 慢慢"哇"上来的，
// 开头会有一个很轻但立刻听得见的起声（相当于辅音/气口），否则短音符会显得含糊。
export const CHOIR_ENVELOPE = { onset: 0.3, onsetTime: 0.012, attack: 0.07, decay: 0.32, sustain: 0.86, hold: 0.8, release: 0.16 };
/** 管风琴起音/释放（秒）：管风琴靠气箱推动，起音比钢琴还慢一点。 */
export const ORGAN_ENVELOPE = { onset: 0.35, onsetTime: 0.015, attack: 0.06, swell: 0.25, release: 0.12 };
/** 弦乐的起音/释放（秒）：比钢琴慢、比人声快，典型的弓弦起奏。 */
export const STRINGS_ENVELOPE = { attack: 0.05, swell: 0.14, sustain: 0.82, hold: 0.72, release: 0.2 };
/** 颤音：5.1 Hz、12 音分（约 0.12 个半音），接近人声自然颤音。 */
export const VIBRATO = { rate: 5.1, cents: 12 };
/**
 * 各音色的响度配平系数（以钢琴为 1）。
 * 合成出来的原始响度差别很大（锯齿波人声比钢琴响约 2 倍），不配平的话
 * 用户一切换音色就会被"轰"一下。这些系数用端到端脚本实测的 RMS 定出来，
 * 目标是切换音色时听感响度基本不变。
 */
// 采样音色的响度在 sampler.js 里按力度单独标定（样本本身的动态已经录进去了），所以配平系数是 1。
export const TIMBRE_GAIN = {
  piano: 1, strings: 0.55, choir: 0.5, choir_female_synth: 0.52, organ: 0.44, soft: 1.15,
  piano_real: 1, electric_piano_real: 1, harpsichord_real: 1, vibraphone_real: 1,
  church_organ_real: 1, pad_real: 1,
  strings_real: 1, violin_real: 1, viola_real: 1, cello_real: 1, contrabass_real: 1,
  pizzicato_real: 1, tremolo_real: 1, harp_real: 1,
  choir_real: 1, choir_female: 1, choir_male: 1, voice_oohs_real: 1, synth_choir_real: 1,
  flute_real: 1, clarinet_real: 1, oboe_real: 1, bassoon_real: 1,
  trumpet_real: 1, horn_real: 1, trombone_real: 1,
  erhu_real: 1,
  zhonghu_real: 1, gaohu_real: 1,
  pipa_real: 1,
  zhongruan_real: 1, daruan_real: 1, liuqin_real: 1,
  guzheng_real: 1,
  dizi_real: 1,
  qudi_real: 1,
  xiao_real: 1,
  xun_real: 1, guanzi_real: 1,
  sheng_real: 1,
  suona_real: 1,
  yangqin_real: 1,
  pengling_real: 1, muyu_real: 1, xiaoluo_real: 1, daluo_real: 1,
  bo_real: 1, paigu_real: 1, yunluo_real: 1,
  accordion_real: 1,
  piccolo_real: 1,
  english_horn_real: 1,
  recorder_real: 1,
  ocarina_real: 1,
  tuba_real: 1,
  french_horn_real: 1,
  brass_section_real: 1,
  nylon_guitar_real: 1,
  steel_guitar_real: 1,
  electric_guitar_real: 1,
  banjo_real: 1,
  sitar_real: 1,
  acoustic_bass_real: 1,
  electric_bass_real: 1,
  fretless_bass_real: 1,
  alto_sax_real: 1,
  tenor_sax_real: 1,
  soprano_sax_real: 1,
  baritone_sax_real: 1,
  marimba_real: 1,
  xylophone_real: 1,
  glockenspiel_real: 1,
  celesta_real: 1,
  tubular_bells_real: 1,
  steel_drums_real: 1,
  timpani_real: 1,
  synth_lead_real: 1,
  shakuhachi_real: 1,
  shamisen_real: 1,
  koto_real: 1,
  kalimba_real: 1,
  pan_flute_real: 1,
  whistle_real: 1,
};
/** 混响：1.9 秒余音、指数衰减 2.8、20 ms 预延迟——接近小音乐厅。 */
export const REVERB = { seconds: 1.9, decay: 2.8, preDelay: 0.02, wet: 0.17, tone: 5200 };
/** 主链压限（多声部叠加不削波）。 */
export const COMPRESSOR = { threshold: -12, knee: 22, ratio: 2.6, attack: 0.005, release: 0.24 };

/**
 * 演奏人性化幅度：真实演奏者不会每个音都严丝合缝。
 * offset=时点抖动（秒）、peak=力度抖动比例、detune=音高抖动（音分）。
 */
export const HUMANIZE = { offset: 0.014, peak: 0.2, detune: 9 };

/**
 * 播放调度窗口（秒）与调度间隔（毫秒）。
 *
 * 为什么要有这个：整曲一次把上千个音符的音频节点全建出来，实测（44 小节 / 1408 音符）
 * 主线程要卡 **820 毫秒**，而且上千个「还没开始响」的振荡器仍会被音频线程每个周期遍历，
 * 弱机器上直接爆音（噼里啪啦）。改成「只提前 2 秒建节点、每 200 ms 补一次」后，
 * 任意时刻音频图里只有几十个音，主线程每轮只花几毫秒。
 */
export const SCHEDULER = { aheadSeconds: 2.0, tickMs: 200, headStartSeconds: 0.18 };

/** 生成一个「第 n 次泛音按 1/n^exponent 递减」的泛音表，供需要定制的音色使用。 */
export function harmonicSeries(count, exponent = 1.35) {
  return Array.from({ length: Math.max(1, Math.floor(count)) }, (_, index) => 1 / ((index + 1) ** exponent));
}
