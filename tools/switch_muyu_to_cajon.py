# -*- coding: utf-8 -*-
"""把木鱼从 VCSL Woodblock 换成 VCSL Cajon（hit3 系列）。

为什么换：
  Woodblock 三层样本 RMS 只有 0.0017 / 0.0054 / 0.0163，全系最响的
  wood_click_ff 也不到 0.017。播放时即使系数给到上限 4.5，输出 RMS
  仍只有 0.036，而其它打击乐在 0.076 左右 —— 木鱼比别的打击乐轻一半。

  实测 VCSL 全部木类音色都轻：Claves 最高 0.0039、Slapstick 0.0183、
  Slit Drum 0.0140、Cowbells 0.0237。Cajon 是唯一达到可用电平的（0.070）。

选 Cajon 的 hit3 系列做三层：
  hit3_p  RMS 0.0167（轻）
  hit3_mp RMS 0.0442（中）
  hit3_f  RMS 0.0634（重）
力度跨度 3.8 倍，层次分明；hit3 比 hit1/hit2 更接近木鱼的「梆」声。

注意：Cajon 是箱鼓（木制箱体 + 打击面），不是中国木鱼。
标签必须写「近似」，不能冒充真实木鱼录音。
"""
import re
from pathlib import Path

INSTALLER = Path(__file__).resolve().parent.parent / "tools" / "install_soundfonts.py"
text = INSTALLER.read_text(encoding="utf-8")

old = '''    "muyu_real": {
        "label": "木鱼（采样·近似木块）", "category": "percussion",
        "layers": [
            (0.2, "Idiophones/Struck Idiophones/Woodblock/wood_click_pp_rr1.wav", "soft.wav"),
            (0.55, "Idiophones/Struck Idiophones/Woodblock/wood_click3_vl1.wav", "medium.wav"),
            (0.9, "Idiophones/Struck Idiophones/Woodblock/wood_click_ff.wav", "loud.wav"),
        ],
    },'''

new = '''    # 木鱼原先用 VCSL Woodblock，但实测三层 RMS 只有 0.0017 / 0.0054 / 0.0163，
    # 全系最响的样本也不到 0.017 —— 播放时系数给到上限仍比其它打击乐轻一半。
    # VCSL 里木类音色都轻（Claves 0.0039、Slapstick 0.0183、Slit Drum 0.0140、
    # Cowbells 0.0237），Cajon 是唯一达到可用电平的（最高 0.070），
    # 且力度分层完整（pp / p / mp / f / fff）。改用它的 hit3 系列。
    "muyu_real": {
        "label": "木鱼（采样·近似箱鼓 Cajon）", "category": "percussion",
        "layers": [
            (0.2, "Idiophones/Struck Idiophones/Cajon/Cajon_hit3_p_rr1.wav", "soft.wav"),
            (0.55, "Idiophones/Struck Idiophones/Cajon/Cajon_hit3_mp_rr1.wav", "medium.wav"),
            (0.9, "Idiophones/Struck Idiophones/Cajon/Cajon_hit3_f_rr1.wav", "loud.wav"),
        ],
    },'''

if old not in text:
    print("没找到原 muyu_real 配置")
    raise SystemExit(1)

text = text.replace(old, new)
INSTALLER.write_text(text, encoding="utf-8")
print("安装脚本已改用 Cajon hit3 系列")
