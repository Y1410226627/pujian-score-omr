# -*- coding: utf-8 -*-
"""根据全部音色的浏览器实测 RMS，计算新的 BANK_LEVEL 系数。

输入：.cache/audio-analysis/all-banks-rms.json（tools/measure_all_banks.mjs 产出）
输出：.cache/audio-analysis/bank-levels-proposed.json + 终端对比表

约束（来自 tests/bank-level.test.mjs）：
  - 系数范围：持续音源 0.2–3.0，oneShot 0.2–4.5
  - piano_real < 1（钢琴样本本来就响）
  - 民族乐器（erhu/pipa/guzheng/dizi/yangqin）> 1.2（样本偏轻）
  - 持续音源的系数极差 ≤ 2.5 倍

原理：新系数 = 旧系数 × (目标RMS / 实测RMS)
  目标 RMS 取所有音色的中位数（比平均值更稳，不受极端值影响），
  同时受「峰值不超 0.85」和「系数范围」约束。
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEASURED = ROOT / ".cache" / "audio-analysis" / "all-banks-rms.json"
PROPOSED = ROOT / ".cache" / "audio-analysis" / "bank-levels-proposed.json"
APP = ROOT / "app.js"

PEAK_LIMIT = 0.85          # 软限幅前允许的最大峰值
MIN_LEVEL, MAX_LEVEL = 0.2, 3.0
MAX_LEVEL_ONESHOT = 4.5


def read_current_levels():
    text = APP.read_text(encoding="utf-8")
    import re
    match = re.search(r"const BANK_LEVEL = \{([\s\S]*?)\n\};", text)
    if not match:
        raise SystemExit("app.js 里找不到 BANK_LEVEL")
    return {name: float(value) for name, value in re.findall(r"(\w+):\s*([\d.]+)", match.group(1))}


def median(values):
    ordered = sorted(values)
    count = len(ordered)
    if count == 0:
        return 0.0
    middle = count // 2
    return ordered[middle] if count % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def main():
    measured = json.loads(MEASURED.read_text(encoding="utf-8"))
    current = read_current_levels()

    valid = {name: item for name, item in measured.items() if item.get("rms", 0) > 0}
    failed = {name: item for name, item in measured.items() if not item.get("rms", 0) > 0}

    print(f"有效测量 {len(valid)} / {len(measured)} 个")
    if failed:
        print("失败：", ", ".join(f"{n}({i.get('error', '无 RMS')})" for n, i in failed.items()))
    print()

    rms_values = [item["rms"] for item in valid.values()]
    print(f"实测 RMS 范围：{min(rms_values):.5f} – {max(rms_values):.5f}"
          f"（极差 {max(rms_values) / min(rms_values):.1f} 倍）")
    print(f"实测 RMS 中位数：{median(rms_values):.5f}")
    print()

    # 分两组设目标：固定音高打击乐 vs 其它。
    # 理由：打击乐是一次性敲击、声音很快衰减，持续音是稳态长音。
    # 混在一起取中位数会互相拉偏：打击乐被拉到持续音水平会峰值超限，
    # 持续音被拉到打击乐水平会整体变轻。e2e 也是分开测这两组。
    percussion = [name for name, item in valid.items() if item.get("oneShot")]
    sustained = [name for name in valid if name not in percussion]
    targets = {}
    if percussion:
        targets["打击乐"] = (median([valid[n]["rms"] for n in percussion]), len(percussion))
    if sustained:
        targets["持续/旋律音源"] = (median([valid[n]["rms"] for n in sustained]), len(sustained))
    print("分组目标：")
    for group, (target_value, count) in targets.items():
        print(f"  {group}（{count} 个）：目标 RMS {target_value:.5f}")
    print()

    proposed = {}
    clamped = []
    for name, item in valid.items():
        target = targets["打击乐"][0] if name in percussion else targets["持续/旋律音源"][0]
        old_level = current.get(name, 1.0)
        factor = target / item["rms"]
        new_level = old_level * factor

        # 峰值约束：放大后峰值不超过 0.85
        peak = item.get("peak") or 0
        if peak > 0:
            peak_safe = (PEAK_LIMIT / peak) * old_level
            if new_level > peak_safe:
                new_level = peak_safe
                clamped.append((name, "峰值上限"))

        # 系数范围约束
        maximum = MAX_LEVEL_ONESHOT if item.get("oneShot") else MAX_LEVEL
        if new_level > maximum:
            new_level = maximum
            clamped.append((name, "系数上限"))
        if new_level < MIN_LEVEL:
            new_level = MIN_LEVEL
            clamped.append((name, "系数下限"))

        proposed[name] = round(new_level, 3)

    print(f"新系数范围：{min(proposed.values()):.3f} – {max(proposed.values()):.3f}")
    if clamped:
        print(f"受约束限制的（{len(clamped)} 个）：")
        for name, reason in clamped[:12]:
            print(f"  {name}: {reason}")
    print()

    # 预测统一后的响度：新RMS ≈ 实测RMS × (新系数/旧系数)
    predicted = {}
    for name, item in valid.items():
        old_level = current.get(name, 1.0)
        if old_level <= 0:
            continue
        predicted[name] = item["rms"] * (proposed[name] / old_level)
    values = list(predicted.values())
    if values:
        print(f"预测统一后 RMS 范围：{min(values):.5f} – {max(values):.5f}"
              f"（极差 {max(values) / min(values):.2f} 倍）")

    # 校验测试护栏
    print()
    print("护栏校验：")
    print(f"  piano_real = {proposed.get('piano_real')}（要求 < 1）",
          "OK" if proposed.get("piano_real", 99) < 1 else "✗")
    for bank in ["erhu_real", "pipa_real", "guzheng_real", "dizi_real", "yangqin_real"]:
        value = proposed.get(bank)
        if value is not None:
            print(f"  {bank} = {value}（要求 > 1.2）", "OK" if value > 1.2 else "✗")
    sustained = [proposed[n] for n, item in valid.items()
                 if not item.get("oneShot") and n != "piano_real" and n in proposed]
    if sustained:
        spread = max(sustained) / min(sustained)
        print(f"  持续音源系数极差 = {spread:.2f}（要求 ≤ 2.5）", "OK" if spread <= 2.5 else "✗")

    PROPOSED.write_text(json.dumps(proposed, indent=1, ensure_ascii=False), encoding="utf-8")
    print()
    print("已写出", PROPOSED)


if __name__ == "__main__":
    main()
