// 乐器库 / 音源分类的纯数据与纯函数（不碰 Web Audio，可在 node 里单测）。
//
// 为什么单独一个文件：分类、分组、GM 音色名、没装音源时的兜底这些逻辑
// 都是「数据 + 查表」，与发声无关；真正加载样本在 sampler.js，真正播放调度在 app.js。

/**
 * 音源分类（按界面下拉的分组顺序）。
 * key 用于清单里的 category 字段；label 是下拉里的分组标题。
 */
export const SAMPLE_CATEGORIES = [
  { key: "china", label: "中国民族乐器" },
  { key: "piano", label: "钢琴 / 键盘" },
  { key: "strings", label: "弦乐" },
  { key: "winds", label: "管乐" },
  { key: "brass", label: "铜管" },
  { key: "plucked", label: "弹拨 / 吉他" },
  { key: "bass", label: "贝斯" },
  { key: "sax", label: "萨克斯" },
  { key: "percussion", label: "打击 / 旋律打击乐" },
  { key: "voice", label: "人声（合唱）" },
  { key: "synth", label: "合成 / 电子" },
  { key: "world", label: "其他民族乐器" },
];

/** 分类 key → 显示名。 */
export const CATEGORY_LABELS = Object.fromEntries(SAMPLE_CATEGORIES.map((item) => [item.key, item.label]));

/**
 * 采样音源清单：bank 名 → { fallback, continuous, category }。
 * - fallback：没装/没加载好时退回哪个合成音色（保证永远有声音）；
 * - continuous：是否需要循环撑住长音（弓弦、吹管、人声、铺底是，钢片琴/弹拨/钢琴不是）；
 * - category：界面上归到哪一组。
 */
export const SAMPLED_TIMBRES = {
  // ——— 中国民族乐器 ———
  erhu_real: { fallback: "strings", continuous: true, category: "china" },
  zhonghu_real: { fallback: "strings", continuous: true, category: "china" },
  gaohu_real: { fallback: "strings", continuous: true, category: "china" },
  pipa_real: { fallback: "soft", continuous: false, category: "china" },
  zhongruan_real: { fallback: "soft", continuous: false, category: "china", oneShot: true },
  daruan_real: { fallback: "strings", continuous: false, category: "china" },
  liuqin_real: { fallback: "soft", continuous: false, category: "china", oneShot: true },
  guzheng_real: { fallback: "soft", continuous: false, category: "china" },
  dizi_real: { fallback: "organ", continuous: true, category: "china" },
  qudi_real: { fallback: "organ", continuous: true, category: "china" },
  xiao_real: { fallback: "organ", continuous: true, category: "china" },
  xun_real: { fallback: "organ", continuous: true, category: "china" },
  guanzi_real: { fallback: "organ", continuous: true, category: "china" },
  sheng_real: { fallback: "organ", continuous: true, category: "china" },
  suona_real: { fallback: "organ", continuous: true, category: "china" },
  yangqin_real: { fallback: "soft", continuous: false, category: "china" },
  // 单次采样完整播放到自然衰减结束，不按音符时值截断。
  pengling_real: { fallback: "soft", continuous: false, category: "percussion", oneShot: true, fixedPitch: true },
  muyu_real: { fallback: "soft", continuous: false, category: "percussion", oneShot: true, fixedPitch: true },
  xiaoluo_real: { fallback: "soft", continuous: false, category: "percussion", oneShot: true, fixedPitch: true },
  daluo_real: { fallback: "soft", continuous: false, category: "percussion", oneShot: true, fixedPitch: true },
  bo_real: { fallback: "soft", continuous: false, category: "percussion", oneShot: true, fixedPitch: true },
  paigu_real: { fallback: "soft", continuous: false, category: "percussion", oneShot: true, fixedPitch: true },
  yunluo_real: { fallback: "soft", continuous: false, category: "percussion" },
  // ——— 钢琴 / 键盘 ———
  piano_real: { fallback: "piano", continuous: false, category: "piano" },
  electric_piano_real: { fallback: "soft", continuous: false, category: "piano" },
  harpsichord_real: { fallback: "soft", continuous: false, category: "piano" },
  church_organ_real: { fallback: "organ", continuous: true, category: "piano" },
  accordion_real: { fallback: "organ", continuous: true, category: "piano" },
  // ——— 弦乐 ———
  strings_real: { fallback: "strings", continuous: true, category: "strings" },
  violin_real: { fallback: "strings", continuous: true, category: "strings" },
  viola_real: { fallback: "strings", continuous: true, category: "strings" },
  cello_real: { fallback: "strings", continuous: true, category: "strings" },
  contrabass_real: { fallback: "strings", continuous: true, category: "strings" },
  pizzicato_real: { fallback: "strings", continuous: false, category: "strings" },
  tremolo_real: { fallback: "strings", continuous: true, category: "strings" },
  // ——— 管乐 ———
  flute_real: { fallback: "organ", continuous: true, category: "winds" },
  piccolo_real: { fallback: "organ", continuous: true, category: "winds" },
  clarinet_real: { fallback: "organ", continuous: true, category: "winds" },
  oboe_real: { fallback: "organ", continuous: true, category: "winds" },
  english_horn_real: { fallback: "organ", continuous: true, category: "winds" },
  bassoon_real: { fallback: "organ", continuous: true, category: "winds" },
  recorder_real: { fallback: "organ", continuous: true, category: "winds" },
  ocarina_real: { fallback: "organ", continuous: true, category: "winds" },
  // ——— 铜管 ———
  trumpet_real: { fallback: "organ", continuous: true, category: "brass" },
  trombone_real: { fallback: "organ", continuous: true, category: "brass" },
  tuba_real: { fallback: "organ", continuous: true, category: "brass" },
  french_horn_real: { fallback: "organ", continuous: true, category: "brass" },
  brass_section_real: { fallback: "organ", continuous: true, category: "brass" },
  // ——— 弹拨 / 吉他 ———
  harp_real: { fallback: "soft", continuous: false, category: "plucked" },
  nylon_guitar_real: { fallback: "soft", continuous: false, category: "plucked", oneShot: true },
  steel_guitar_real: { fallback: "soft", continuous: false, category: "plucked", oneShot: true },
  electric_guitar_real: { fallback: "soft", continuous: false, category: "plucked" },
  banjo_real: { fallback: "soft", continuous: false, category: "plucked" },
  sitar_real: { fallback: "soft", continuous: false, category: "plucked" },
  // ——— 贝斯 ———
  acoustic_bass_real: { fallback: "strings", continuous: false, category: "bass" },
  electric_bass_real: { fallback: "strings", continuous: false, category: "bass" },
  fretless_bass_real: { fallback: "strings", continuous: true, category: "bass" },
  // ——— 萨克斯 ———
  alto_sax_real: { fallback: "organ", continuous: true, category: "sax" },
  tenor_sax_real: { fallback: "organ", continuous: true, category: "sax" },
  soprano_sax_real: { fallback: "organ", continuous: true, category: "sax" },
  baritone_sax_real: { fallback: "organ", continuous: true, category: "sax" },
  // ——— 打击 / 旋律打击乐 ———
  vibraphone_real: { fallback: "soft", continuous: false, category: "percussion" },
  marimba_real: { fallback: "soft", continuous: false, category: "percussion" },
  xylophone_real: { fallback: "soft", continuous: false, category: "percussion" },
  glockenspiel_real: { fallback: "soft", continuous: false, category: "percussion" },
  celesta_real: { fallback: "soft", continuous: false, category: "percussion" },
  tubular_bells_real: { fallback: "soft", continuous: false, category: "percussion" },
  steel_drums_real: { fallback: "soft", continuous: false, category: "percussion" },
  timpani_real: { fallback: "strings", continuous: false, category: "percussion" },
  // ——— 人声 ———
  choir_real: { fallback: "choir", continuous: true, category: "voice" },
  choir_female: { fallback: "choir", continuous: true, category: "voice" },
  choir_male: { fallback: "choir", continuous: true, category: "voice" },
  voice_oohs_real: { fallback: "choir", continuous: true, category: "voice" },
  // ——— 合成 / 电子 ———
  pad_real: { fallback: "strings", continuous: true, category: "synth" },
  synth_choir_real: { fallback: "choir", continuous: true, category: "synth" },
  synth_lead_real: { fallback: "soft", continuous: true, category: "synth" },
  // ——— 其他民族 ———
  shakuhachi_real: { fallback: "organ", continuous: true, category: "world" },
  shamisen_real: { fallback: "soft", continuous: false, category: "world" },
  koto_real: { fallback: "soft", continuous: false, category: "world" },
  kalimba_real: { fallback: "soft", continuous: false, category: "world" },
  pan_flute_real: { fallback: "organ", continuous: true, category: "world" },
  whistle_real: { fallback: "organ", continuous: true, category: "world" },
};

/** 某个音源属于哪个分类；清单缺 category 时按 bank 名推断，保证旧清单也能正确分组。 */
export function categoryOf(bank, spec = {}) {
  if (spec && typeof spec.category === "string" && CATEGORY_LABELS[spec.category]) return spec.category;
  if (Object.prototype.hasOwnProperty.call(SAMPLED_TIMBRES, bank)) return SAMPLED_TIMBRES[bank].category;
  const name = String(bank || "").toLowerCase();
  if (/choir|voice|vocal/.test(name)) return "voice";
  if (/organ|piano|harpsichord|accordion|keys/.test(name)) return "piano";
  if (/violin|viola|cello|string|pizz|tremolo|contra/.test(name)) return "strings";
  if (/trumpet|trombone|tuba|horn|brass/.test(name)) return "brass";
  if (/sax/.test(name)) return "sax";
  if (/bass/.test(name)) return "bass";
  if (/guitar|harp|banjo|sitar|lute|pipa|zheng|shamisen|koto/.test(name)) return "plucked";
  if (/flute|clarinet|oboe|bassoon|recorder|ocarina|pan|whistle|shakuhachi|dizi|xiao|sheng|suona/.test(name)) return "winds";
  if (/marimba|xylo|vibra|glocken|celesta|bell|drum|timpani|steel|percussion/.test(name)) return "percussion";
  if (/pad|synth|lead/.test(name)) return "synth";
  if (/erhu|yangqin|guqin/.test(name)) return "china";
  return "world";
}

/** 该音源属于本机是否「已安装」——即清单里有没有它。 */
export function isInstalledBank(manifest, bank) {
  return Boolean(manifest && manifest.banks && manifest.banks[bank]);
}

/**
 * 把清单里的音源按分类分组。
 * 返回 [{ category, label, banks: [{ bank, label, installed }] }]，顺序按 SAMPLE_CATEGORIES。
 * 未安装的音源（清单里没有）默认不列出，除非 includeMissing=true。
 */
export function groupBanksByCategory(manifest, { labels = {}, includeMissing = false } = {}) {
  const banks = (manifest && manifest.banks) || {};
  const table = new Map();
  for (const [bank, spec] of Object.entries(banks)) {
    const category = categoryOf(bank, spec);
    if (!table.has(category)) table.set(category, []);
    table.get(category).push({ bank, label: (spec && spec.label) || labels[bank] || bank, installed: true });
  }
  if (includeMissing) {
    for (const [bank, meta] of Object.entries(SAMPLED_TIMBRES)) {
      if (banks[bank]) continue;
      const category = meta.category;
      if (!table.has(category)) table.set(category, []);
      table.get(category).push({ bank, label: labels[bank] || bank, installed: false });
    }
  }
  const result = [];
  for (const { key, label } of SAMPLE_CATEGORIES) {
    const items = table.get(key);
    if (!items || !items.length) continue;
    items.sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
    result.push({ category: key, label, banks: items });
  }
  // 分类表里没有的（旧清单里出现的新分类）放到最后，避免音源「消失」。
  for (const [category, items] of table) {
    if (CATEGORY_LABELS[category]) continue;
    items.sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
    result.push({ category, label: category, banks: items });
  }
  return result;
}

/**
 * 没装音源时该退回哪个合成音色：优先清单里声明，其次内置表，最后钢琴。
 * 这样「选了中国箫但没装音源」也能立刻听到声音（合成管风琴），不会静音。
 */
export function fallbackTimbre(bank, spec = {}) {
  if (spec && typeof spec.fallback === "string") return spec.fallback;
  if (Object.prototype.hasOwnProperty.call(SAMPLED_TIMBRES, bank)) return SAMPLED_TIMBRES[bank].fallback;
  return "piano";
}

/** 需要循环撑长音的乐器：清单没写 continuous 时用内置表兜底。 */
export function isContinuousBank(bank, spec = {}) {
  if (spec && typeof spec.continuous === "boolean") return spec.continuous;
  if (Object.prototype.hasOwnProperty.call(SAMPLED_TIMBRES, bank)) return SAMPLED_TIMBRES[bank].continuous;
  return false;
}

/** 清单里所有音源名（供「音源数量」之类统计与测试断言）。 */
export function listBankNames(manifest) {
  return Object.keys((manifest && manifest.banks) || {}).sort();
}
