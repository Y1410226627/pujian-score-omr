# -*- coding: utf-8 -*-
"""生成「乐器库」页面用的音源清单（tools 里跑，产出可提交的文档）。

用法：
    py -3 tools/build_instrument_catalog.py
产物：
    docs-instruments.md   —— 面向用户的「有哪些乐器」清单（按分类分组）
输出格式便于 README 引用，也便于确认「音源数量」。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (bank, 分类, 中文名, 需要循环, 兜底合成音色, 说明)
CATALOG = [
    # ——— 中国民族乐器 ———
    ("erhu_real", "中国民族乐器", "二胡", True, "strings", "弓弦，循环撑长音；CC0 样本（sfzinstruments/aliexpress-erhu）"),
    ("pipa_real", "中国民族乐器", "琵琶", False, "soft", "弹拨，点一次响一下；FluidR3 弹拨音色（GM 太鼓/拨弦近似）"),
    ("guzheng_real", "中国民族乐器", "古筝", False, "soft", "弹拨，FluidR3 竖琴/齐特近似"),
    ("dizi_real", "中国民族乐器", "笛子", True, "organ", "吹管，FluidR3 长笛/管风琴近似"),
    ("xiao_real", "中国民族乐器", "箫", True, "organ", "吹管，FluidR3 长笛近似"),
    ("sheng_real", "中国民族乐器", "笙", True, "organ", "簧管，FluidR3 簧风琴近似"),
    ("suona_real", "中国民族乐器", "唢呐", True, "organ", "簧管，FluidR3 唢呐近似（GM 112 对应）"),
    ("yangqin_real", "中国民族乐器", "扬琴", False, "soft", "击弦，FluidR3 洋琴音色"),
    # ——— 钢琴 / 键盘 ———
    ("piano_real", "钢琴 / 键盘", "真实钢琴", False, "piano", "Salamander Grand Piano V3（两层力度）"),
    ("electric_piano_real", "钢琴 / 键盘", "电钢琴", False, "soft", "FluidR3"),
    ("harpsichord_real", "钢琴 / 键盘", "羽管键琴", False, "soft", "FluidR3"),
    ("church_organ_real", "钢琴 / 键盘", "教堂管风琴", True, "organ", "FluidR3"),
    ("accordion_real", "钢琴 / 键盘", "手风琴", True, "organ", "FluidR3"),
    # ——— 弦乐 ———
    ("strings_real", "弦乐", "弦乐合奏", True, "strings", "FluidR3"),
    ("violin_real", "弦乐", "小提琴", True, "strings", "FluidR3"),
    ("viola_real", "弦乐", "中提琴", True, "strings", "FluidR3"),
    ("cello_real", "弦乐", "大提琴", True, "strings", "FluidR3"),
    ("contrabass_real", "弦乐", "低音提琴", True, "strings", "FluidR3"),
    ("pizzicato_real", "弦乐", "拨弦", False, "strings", "FluidR3"),
    ("tremolo_real", "弦乐", "震音弦乐", True, "strings", "FluidR3"),
    # ——— 管乐 ———
    ("flute_real", "管乐", "长笛", True, "organ", "FluidR3"),
    ("piccolo_real", "管乐", "短笛", True, "organ", "FluidR3"),
    ("clarinet_real", "管乐", "单簧管", True, "organ", "FluidR3"),
    ("oboe_real", "管乐", "双簧管", True, "organ", "FluidR3"),
    ("english_horn_real", "管乐", "英国管", True, "organ", "FluidR3"),
    ("bassoon_real", "管乐", "大管", True, "organ", "FluidR3"),
    ("recorder_real", "管乐", "竖笛", True, "organ", "FluidR3"),
    ("ocarina_real", "管乐", "陶笛", True, "organ", "FluidR3"),
    # ——— 铜管 ———
    ("trumpet_real", "铜管", "小号", True, "organ", "FluidR3"),
    ("trombone_real", "铜管", "长号", True, "organ", "FluidR3"),
    ("tuba_real", "铜管", "大号", True, "organ", "FluidR3"),
    ("french_horn_real", "铜管", "圆号", True, "organ", "FluidR3"),
    ("brass_section_real", "铜管", "铜管合奏", True, "organ", "FluidR3"),
    # ——— 弹拨 / 吉他 ———
    ("harp_real", "弹拨 / 吉他", "竖琴", False, "soft", "FluidR3"),
    ("nylon_guitar_real", "弹拨 / 吉他", "尼龙弦吉他", False, "soft", "FluidR3"),
    ("steel_guitar_real", "弹拨 / 吉他", "民谣吉他", False, "soft", "FluidR3"),
    ("electric_guitar_real", "弹拨 / 吉他", "电吉他", False, "soft", "FluidR3"),
    ("banjo_real", "弹拨 / 吉他", "班卓琴", False, "soft", "FluidR3"),
    ("sitar_real", "弹拨 / 吉他", "西塔琴", False, "soft", "FluidR3"),
    # ——— 贝斯 ———
    ("acoustic_bass_real", "贝斯", "原声贝斯", False, "strings", "FluidR3"),
    ("electric_bass_real", "贝斯", "电贝斯", False, "strings", "FluidR3"),
    ("fretless_bass_real", "贝斯", "无品贝斯", True, "strings", "FluidR3"),
    # ——— 萨克斯 ———
    ("alto_sax_real", "萨克斯", "中音萨克斯", True, "organ", "FluidR3"),
    ("tenor_sax_real", "萨克斯", "次中音萨克斯", True, "organ", "FluidR3"),
    ("soprano_sax_real", "萨克斯", "高音萨克斯", True, "organ", "FluidR3"),
    ("baritone_sax_real", "萨克斯", "上低音萨克斯", True, "organ", "FluidR3"),
    # ——— 打击 / 旋律打击乐 ———
    ("vibraphone_real", "打击 / 旋律打击乐", "颤音琴", False, "soft", "FluidR3"),
    ("marimba_real", "打击 / 旋律打击乐", "马林巴", False, "soft", "FluidR3"),
    ("xylophone_real", "打击 / 旋律打击乐", "木琴", False, "soft", "FluidR3"),
    ("glockenspiel_real", "打击 / 旋律打击乐", "钟琴", False, "soft", "FluidR3"),
    ("celesta_real", "打击 / 旋律打击乐", "钢片琴", False, "soft", "FluidR3"),
    ("tubular_bells_real", "打击 / 旋律打击乐", "管钟", False, "soft", "FluidR3"),
    ("steel_drums_real", "打击 / 旋律打击乐", "钢鼓", False, "soft", "FluidR3"),
    ("timpani_real", "打击 / 旋律打击乐", "定音鼓", False, "strings", "FluidR3"),
    # ——— 人声 ———
    ("choir_real", "人声（合唱）", "混声合唱", True, "choir", "SSO 采样（男女声分别采样后按音域组合）"),
    ("choir_female", "人声（合唱）", "女声合唱", True, "choir", "SSO"),
    ("choir_male", "人声（合唱）", "男声合唱", True, "choir", "SSO"),
    ("voice_oohs_real", "人声（合唱）", "人声「哦」", True, "choir", "FluidR3"),
    # ——— 合成 / 电子 ———
    ("pad_real", "合成 / 电子", "温暖铺底", True, "strings", "FluidR3"),
    ("synth_choir_real", "合成 / 电子", "合成人声合唱", True, "choir", "FluidR3"),
    ("synth_lead_real", "合成 / 电子", "合成主音", True, "soft", "FluidR3"),
    # ——— 其他民族 ———
    ("shakuhachi_real", "其他民族乐器", "尺八", True, "organ", "FluidR3"),
    ("shamisen_real", "其他民族乐器", "三味线", False, "soft", "FluidR3"),
    ("koto_real", "其他民族乐器", "日本筝", False, "soft", "FluidR3"),
    ("kalimba_real", "其他民族乐器", "拇指琴", False, "soft", "FluidR3"),
    ("pan_flute_real", "其他民族乐器", "排箫", True, "organ", "FluidR3"),
    ("whistle_real", "其他民族乐器", "哨笛", True, "organ", "FluidR3"),
]

SYNTH_ONLY = [
    ("piano", "钢琴（合成）", "钢琴 / 键盘"),
    ("strings", "弦乐（合成）", "弦乐"),
    ("choir", "混声合唱（合成）", "人声（合唱）"),
    ("choir_female_synth", "女声合唱（合成）", "人声（合唱）"),
    ("organ", "管风琴（合成）", "钢琴 / 键盘"),
    ("soft", "电子琴（合成）", "合成 / 电子"),
]


def main():
    grouped = {}
    order = []
    for bank, category, name, continuous, fallback, note in CATALOG:
        if category not in grouped:
            grouped[category] = []
            order.append(category)
        grouped[category].append((bank, name, continuous, fallback, note))

    lines = ["# 乐器音源清单", "",
             f"本机可用的采样音源共 **{len(CATALOG)} 种**（另有 {len(SYNTH_ONLY)} 种不用装即可用的合成音色）。",
             "",
             "安装方式：双击 `安装真实音源.bat`，或运行 `py -3 tools/install_soundfonts.py`。"
             "只想装某几类时用 `--only china strings winds`；先看清单用 `--list`。",
             "",
             "没装某一类时也能用：选中该音色会自动退回「同类合成音色」，不会没有声音。", ""]
    total = 0
    for category in order:
        items = grouped[category]
        total += len(items)
        lines.append(f"## {category}（{len(items)} 种）")
        lines.append("")
        lines.append("| 音色 | 长音 | 没装时退回 | 来源 |")
        lines.append("| --- | --- | --- | --- |")
        for bank, name, continuous, fallback, note in items:
            lines.append(f"| {name} | {'循环' if continuous else '自然衰减'} | {fallback} | {note} |")
        lines.append("")
    lines.append("## 合成音色（不用装，开箱可用）")
    lines.append("")
    lines.append("| 音色 | 分组 |")
    lines.append("| --- | --- |")
    for bank, name, category in SYNTH_ONLY:
        lines.append(f"| {name}（`{bank}`） | {category} |")
    lines.append("")
    lines.append(f"合计：采样音源 **{total}** 种 + 合成音色 **{len(SYNTH_ONLY)}** 种 = **{total + len(SYNTH_ONLY)}** 种可选音色。")
    target = ROOT / "docs-instruments.md"
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"已写出 {target}：采样 {total} 种 + 合成 {len(SYNTH_ONLY)} 种")


if __name__ == "__main__":
    main()
