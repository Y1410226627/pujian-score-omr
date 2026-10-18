# -*- coding: utf-8 -*-
"""记录「两种渲染尺寸下的识别结果」作为回归快照。

为什么要有这个：`jianpu.py` 的时值判定依赖一批绝对像素常数，同一页在 3× 与
应用实际使用的 3.8×（长边 2600px）下结果并不相同。只守一种尺寸，改一处就会在另一处崩。
本脚本把**已经人工核对过的当前结果**存下来当快照，`tests/jianpu-pages.test.mjs` 会逐项比对。

重新生成（仅在**故意**改动识别结果、并已核对新结果正确时）：
    .venv\\Scripts\\python.exe tests\\generate_jianpu_pages.py <PDF> tests\\fixtures\\jianpu_pages 11
    .venv\\Scripts\\python.exe tests\\snapshot_jianpu_pages.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import jianpu  # noqa: E402

PAGES = ROOT / "tests" / "fixtures" / "jianpu_pages"
GROUND_TRUTH = ROOT / "tests" / "fixtures" / "chilele_p11_jianpu.ground-truth.json"
OUT = ROOT / "tests" / "fixtures" / "chilele_p11_jianpu.pages.json"

# 两种渲染尺寸（缺一不可）：
#   _3x   = 1785×2523，交接文档里的原基准尺寸
#   _2600 = 1840×2600，应用真正渲染的尺寸（app.js: renderPdfPage 的长边 2600px）
SIZES = [("_3x", "3× 渲染（1785×2523，文档原基准）"),
         ("_2600", "长边 2600px（与应用实际渲染一致）")]


def main():
    pages = {}
    for suffix, label in SIZES:
        path = PAGES / ("_source__p11%s.png" % suffix)
        if not path.exists():
            print("缺少页面图：", path)
            print("请先运行：python tests/generate_jianpu_pages.py <PDF> tests/fixtures/jianpu_pages 11")
            raise SystemExit(1)
        result = jianpu.recognize(str(path))
        if result.get("error"):
            print(result["error"])
            raise SystemExit(1)
        pages[suffix] = {
            "label": label,
            "image": path.name,
            "measureCount": result["measureCount"],
            "parts": [{"name": part["name"], "notes": [
                {"midi": n["midi"], "startBeat": n["startBeat"], "durationBeats": n["durationBeats"]}
                for n in part["notes"]]} for part in result["parts"]],
            "warnings": result["warnings"],
        }
        counts = [len(part["notes"]) for part in result["parts"]]
        print("%s：%d 小节 / %d 声部 / %d 音符" % (suffix, result["measureCount"], len(result["parts"]), sum(counts)))

    document = {
        "provenance": (
            "两种渲染尺寸下 jianpu.py 对《敕勒歌》第 11 页（简谱）的输出快照。"
            "用于锁住「换渲染尺寸不能让结果变差」——这是相对本次交接时的结果记录，"
            "不是第三方标注；绝对精度以 chilele_p11_jianpu.ground-truth.json 为准。"
        ),
        "groundTruth": GROUND_TRUTH.name,
        "pages": pages,
    }
    OUT.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("写入", OUT)


if __name__ == "__main__":
    main()
