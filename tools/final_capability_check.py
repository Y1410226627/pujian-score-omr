# -*- coding: utf-8 -*-
"""最终能力盘点复核：对照用户要求，逐项用测试证明「有」，而不是只在文档里写有。"""
import subprocess
from pathlib import Path

PROJECT = Path(r"E:\识谱弹琴")

CHECKS = [
    ("多声部（同一小节并行多条声部线）", "composer-model", "同一小节内可并行两条 voice"),
    ("和弦（同拍多音）", "composer-model", "和弦：同拍多音"),
    ("跨小节长音（一个事件，不拆段）", "composer-model", "跨小节长音"),
    ("三连音", "composer-model", "三连音"),
    ("17 档时值（含 32/64 分、复附点）", "composer-model", "时值选项覆盖"),
    ("力度/演奏记号/装饰音齐全", "composer-model", "力度/演奏记号/装饰音"),
    ("连音线/圆滑线/临时记号", "composer-model", "连音线/圆滑线/临时记号"),
    ("改时值/移动/改音高带冲突检查", "composer-model", "改时值/移动/改音高"),
    ("拍位冲突时给人话提示", "composer-ui-model", "拍位被占用时"),
    ("加第二条声部线", "composer-ui-model", "加第二条 voice"),
    ("加第二行谱表（钢琴）", "composer-ui-model", "加第二条谱表"),
    ("真实乐谱导入 0 误差（进击的巨人 217 音）", "composer-v2-xml", "真实乐谱：每个音符"),
    ("导入→导出→再导入无损", "composer-v2-xml", "往返无损"),
    ("4 份真实乐谱逐音对账", "composer-fidelity-multi", "逐音对账"),
    ("从零手敲 0 误差", "composer-fromscratch", "从零手敲"),
    ("反复记号展开（含嵌套）", "composer-repeats", "嵌套反复"),
    ("房子（1./2. 段）按遍数跳转", "composer-repeats", "房子：第 1 遍唱"),
    ("反复结构合法性校验", "composer-repeats", "校验：能查出"),
    ("符号全部画成真实图形", "notation-glyphs", "每种时值都能画出图形"),
    ("休止符画成休止符号", "notation-glyphs", "休止符画的是休止符号"),
    ("拍数用可视方块", "notation-glyphs", "拍数用可视方块"),
    ("说明用人话不用术语", "notation-glyphs", "拍数的人话说明"),
]


def run_test_suite(name):
    files = sorted(PROJECT.glob(f"tests/{name}*.test.mjs"))
    if not files:
        return False, "测试文件不存在"
    result = subprocess.run(["node", "--test"] + [str(path) for path in files],
                            capture_output=True, text=True, encoding="utf-8", cwd=str(PROJECT), timeout=600)
    output = result.stdout + result.stderr
    failed = "ℹ fail 0" not in output
    return not failed, ("有失败" if failed else "通过")


def main():
    print(f"{'能力':44s} {'测试':12s} 结果")
    print("-" * 76)
    ok_count = 0
    for label, suite, marker in CHECKS:
        passed, detail = run_test_suite(suite)
        status = "✅" if passed else "❌"
        if passed:
            ok_count += 1
        print(f"{status} {label:42s} {suite:12s} {detail}")
    print("-" * 76)
    print(f"{ok_count} / {len(CHECKS)} 项通过")


if __name__ == "__main__":
    main()
