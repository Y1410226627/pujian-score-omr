# -*- coding: utf-8 -*-
"""按浏览器实测 RMS 计算 BANK_LEVEL 新系数（峰值不超 0.85）。"""
import json

measured = json.load(open(".cache/audio-analysis/browser-levels-clean.json", encoding="utf-8"))
current = {
    "piano_real": 0.559,
    "nylon_guitar_real": 1.158,
    "steel_guitar_real": 1.185,
    "zhongruan_real": 0.856,
    "liuqin_real": 1.185,
}
safe = {name: 0.85 / info["peak"] for name, info in measured.items()}

for target in [0.22, 0.23, 0.24, 0.25, 0.26]:
    ok = all(target / measured[name]["rms"] <= safe[name] for name in measured)
    print(f"target={target}: {'OK' if ok else '会削波'}")

target = 0.24
print(f"\n选定目标 RMS = {target}")
new = {}
for name, info in measured.items():
    factor = target / info["rms"]
    new[name] = round(current[name] * factor, 3)
    print(f"  {name}: {current[name]} -> {new[name]}  峰值预计 {info['peak'] * factor:.3f}")
print()
print(json.dumps(new, indent=1))
