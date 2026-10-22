# -*- coding: utf-8 -*-
"""按 e2e 的「起音稳定段」口径，重新标定 6 个民族打击乐的系数。

为什么用这个口径：打击乐录音长度差 30 倍以上（木鱼 0.71 秒、大锣 27.34 秒）。
用整段 RMS 比较会把「声音长但衰减慢」的判成轻 —— 那是衰减特性差异，不是响度差异。
用户听到的「这一击有多响」由起音段决定，所以取前 0.5 秒（短样本则取整段）。

数据来自 tests/e2e-audio.mjs 刚跑出来的实测值。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app.js"

# e2e 实测（起音稳定段 RMS / 峰值）
measured = {
    "pengling_real": {"rms": 0.1226, "peak": 0.816},
    "muyu_real": {"rms": 0.0952, "peak": 0.771},
    "xiaoluo_real": {"rms": 0.1088, "peak": 0.322},
    "daluo_real": {"rms": 0.1113, "peak": 0.366},
    "bo_real": {"rms": 0.1520, "peak": 0.763},
    "paigu_real": {"rms": 0.1766, "peak": 0.765},
}

text = APP.read_text(encoding="utf-8")
match = re.search(r"const BANK_LEVEL = \{([\s\S]*?)\n\};", text)
current = {name: float(value) for name, value in re.findall(r"(\w+):\s*([\d.]+)", match.group(1))}

values = [item["rms"] for item in measured.values()]
target = sum(values) / len(values)          # 算术平均，组内差异不大
print(f"目标 RMS（组内平均）：{target:.5f}")
print(f"当前极差：{max(values) / min(values):.2f} 倍\n")

updates = {}
for name, item in measured.items():
    factor = target / item["rms"]
    new_level = current[name] * factor
    # 峰值安全：放大后不超过 0.85
    peak_safe = (0.85 / item["peak"]) * current[name]
    if new_level > peak_safe:
        new_level = peak_safe
        print(f"  {name}: 受峰值上限限制")
    updates[name] = round(new_level, 3)
    predicted_rms = item["rms"] * (new_level / current[name])
    print(f"  {name:16s} {current[name]:.3f} → {new_level:.3f}  RMS {item['rms']:.4f} → {predicted_rms:.4f}")

print()
new_values = [item["rms"] * (updates[name] / current[name]) for name, item in measured.items()]
print(f"预测极差：{max(new_values) / min(new_values):.2f} 倍（要求 < 1.7）")

# 写入
for name, value in updates.items():
    pattern = re.compile(rf"(^\s*{name}:\s*)[\d.]+(,?)", re.M)
    text = pattern.sub(rf"\g<1>{value}\g<2>", text, count=1)
APP.write_text(text, encoding="utf-8")
print("\n已写入 app.js")
