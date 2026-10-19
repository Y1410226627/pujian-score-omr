# -*- coding: utf-8 -*-
"""跑 tools/measure_bank_levels.mjs，把 67 种采样音源的实测响度整理成标定表。

用法：py -3 tools/measure_bank_levels.py
输出：控制台表格 + bank_levels.json（原始数据）。
"""
import json
import subprocess
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
TARGET_PEAK = 0.16


def main():
    result = subprocess.run(["node", str(PROJECT / "tools" / "measure_bank_levels.mjs")],
                            capture_output=True, text=True, encoding="utf-8", cwd=str(PROJECT),
                            timeout=1800)
    lines = (result.stdout or "").strip().splitlines()
    if not lines:
        print(result.stderr[:800])
        return 1
    rows = json.loads(lines[-1])
    rows.sort(key=lambda item: item.get("peak", 0))
    table = []
    print(f"{'bank':26s} {'peak':>7s} {'rms':>8s}  建议 level(0.16/peak)")
    for row in rows:
        if "error" in row:
            print(f"{row['name']:26s}  错误: {row['error']}")
            continue
        level = round(TARGET_PEAK / row["peak"], 2) if row["peak"] > 0.02 else 3.0
        level = min(3.0, max(0.4, level))
        table.append({"name": row["name"], "peak": row["peak"], "rms": row["rms"], "level": level})
        print(f"{row['name']:26s} {row['peak']:7.4f} {row['rms']:8.5f}  {level}")
    out = PROJECT / "tools" / "bank_levels.json"
    out.write_text(json.dumps(table, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n已写出", out, len(table), "条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
