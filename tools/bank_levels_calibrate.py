# -*- coding: utf-8 -*-
"""建 BANK_LEVEL 标定表：按「目标峰值」反推每种音源的增益倍数。

修法：level = 目标峰值 ÷ 该乐器的实测/估计峰值。这样渲染同一音高时，
所有乐器输出电平一致（而不是按分组拍一个系数，仍有 2.68 倍差距）。

实测来源（2026-10-19，OfflineAudioContext 渲染 C4 长音）：
- piano_real 0.25、choir_real 0.13、strings_real 0.11、erhu_real 0.069。
其余乐器没有逐一声测，按「同类乐器 + FluidR3 典型电平」推导。
"""
import json
from pathlib import Path

ROOT = Path(r"E:\识谱弹琴")
TARGET_PEAK = 0.16   # 与合成音色一致的峰值
MAX_LEVEL = 2.0      # 抬升上限：超过会让轻录音显「噪」；更轻的音源靠 bank.observedRms 归一化补足
MIN_LEVEL = 0.55     # 压低下限

# 实测峰值（2026-10-19，OfflineAudioContext 渲染 C4 长音）
PEAK = {
    "piano_real": 0.25,      # e2e 实测
    "erhu_real": 0.069,      # 单独渲染实测（由 bank.observedRms 归一化补足，level 只做微调）
    "choir_real": 0.13,      # e2e 实测（真实持续音色）
    "strings_real": 0.11,    # e2e 实测
}

# 未实测的按「同类乐器 + FluidR3 典型电平」推导。
GROUP_PEAK = {
    "piano": 0.24, "key_soft": 0.17, "organ": 0.17,
    "china_bow": 0.07, "china_plucked": 0.085, "china_wind": 0.10,
    "perc_melodic": 0.11, "perc_drum": 0.15, "guitar": 0.12, "bass": 0.12,
    "strings_low": 0.11, "strings_high": 0.115, "harp_pizz": 0.10,
    "wind_light": 0.11, "wind_hard": 0.13, "sax": 0.125, "brass": 0.145,
    "choir": 0.13, "pad": 0.115, "synth": 0.12,
}

BANK_GROUPS = {
    "piano_real": "piano", "electric_piano_real": "key_soft", "harpsichord_real": "key_soft",
    "church_organ_real": "organ", "accordion_real": "organ", "vibraphone_real": "perc_melodic",
    "erhu_real": "china_bow",
    "pipa_real": "china_plucked", "guzheng_real": "china_plucked", "yangqin_real": "china_plucked",
    "shamisen_real": "china_plucked", "koto_real": "china_plucked",
    "dizi_real": "china_wind", "xiao_real": "china_wind", "sheng_real": "china_wind",
    "suona_real": "china_wind", "pan_flute_real": "china_wind", "shakuhachi_real": "china_wind",
    "whistle_real": "china_wind", "recorder_real": "china_wind", "ocarina_real": "china_wind",
    "piccolo_real": "china_wind", "flute_real": "china_wind",
    "marimba_real": "perc_melodic", "xylophone_real": "perc_melodic", "glockenspiel_real": "perc_melodic",
    "celesta_real": "perc_melodic", "tubular_bells_real": "perc_melodic", "kalimba_real": "perc_melodic",
    "steel_drums_real": "perc_drum", "timpani_real": "perc_drum",
    "nylon_guitar_real": "guitar", "steel_guitar_real": "guitar",
    "electric_guitar_real": "guitar", "banjo_real": "guitar", "sitar_real": "guitar",
    "acoustic_bass_real": "bass", "electric_bass_real": "bass", "fretless_bass_real": "bass",
    "contrabass_real": "strings_low", "cello_real": "strings_low",
    "viola_real": "strings_low", "violin_real": "strings_high", "strings_real": "strings_high",
    "tremolo_real": "strings_high", "harp_real": "harp_pizz", "pizzicato_real": "harp_pizz",
    "clarinet_real": "wind_light", "oboe_real": "wind_light", "english_horn_real": "wind_light",
    "bassoon_real": "wind_hard",
    "soprano_sax_real": "sax", "alto_sax_real": "sax", "tenor_sax_real": "sax",
    "baritone_sax_real": "sax",
    "trumpet_real": "brass", "french_horn_real": "brass", "trombone_real": "brass",
    "tuba_real": "brass", "brass_section_real": "brass",
    "choir_female": "choir", "choir_male": "choir", "choir_real": "choir",
    "voice_oohs_real": "choir", "synth_choir_real": "choir",
    "pad_real": "pad", "synth_lead_real": "synth",
}


def main():
    table = {}
    for bank, group in sorted(BANK_GROUPS.items()):
        peak = PEAK.get(bank) or GROUP_PEAK[group]
        level = round(TARGET_PEAK / peak, 2)
        level = min(MAX_LEVEL, max(MIN_LEVEL, level))
        table[bank] = {
            "level": level,
            "source": "measured-peak" if bank in PEAK else "group-peak",
            "peak": peak,
        }
    payload = {
        "targetPeak": TARGET_PEAK,
        "note": ("level = 播放增益倍数，按目标峰值 "
                 f"{TARGET_PEAK} 反推（峰值 ÷ level ≈ 目标），抹平不同乐器的录音电平差。"
                 "钢琴/合唱/弦乐为 2026-10-19 实测，其余按乐器分类标定。"),
        "banks": table,
    }
    out = ROOT / "tools" / "bank_levels.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    levels = sorted(((item["level"], name) for name, item in table.items()), reverse=True)
    for level, name in levels[:6]:
        print(f"  {level:5.2f}  {name}")
    print("  ...")
    for level, name in levels[-6:]:
        print(f"  {level:5.2f}  {name}")
    spread = levels[0][0] / levels[-1][0]
    print(f"\n共 {len(table)} 个；最大强度差 {spread:.2f} 倍")
    peaks = sorted(((item["peak"] * item["level"], name) for name, item in table.items()))
    print(f"校正后峰值范围 {peaks[0][0]:.3f}–{peaks[-1][0]:.3f}（目标 {TARGET_PEAK}）")
    for value, name in peaks:
        assert value <= TARGET_PEAK * 1.35, f"{name} 校正后仍偏响 {value:.3f}"
        assert value >= TARGET_PEAK * 0.55, f"{name} 校正后仍偏轻 {value:.3f}"
    print("全部落在目标的 55%–135% 内 ✓")


if __name__ == "__main__":
    main()
