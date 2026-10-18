"""由 jianpu.py 重建简谱基准文件（tests/fixtures/*.ground-truth.json）。

基准只保留「可客观核对」的字段（midi / onsetBeats / durationBeats），不带 x/y
（那属于渲染细节，不该进基准）；并写入 provenance，如实说明它是**本项目的回归基准**，
而不是第三方独立标注。

用法：
    .venv\\Scripts\\python.exe tests/generate_jianpu_benchmark.py <页面.png> <输出 json> [do_midi] [beats]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import jianpu  # noqa: E402

PROVENANCE = (
    "由 jianpu.py 识别《敕勒歌》第 11 页（简谱）得到，并经人工逐小节核对："
    "12 小节、4 个声部与谱面吻合（女高1 m8 = 5. 3̲2̲0̲1̲2̲ = 4.0 拍、女中 m4 = 2 1 1̲ 6 5̲ = 4.0 拍、"
    "男中 m7 = 3 - - 3̲ 0̲ = 4.0 拍、第 12 小节含一组三连音 = 4.0 拍 等）。"
    "**这是本项目的回归基准，不是第三方独立标注**；第 10 小节（4.75 拍）存在已知歧义，"
    "见 下一步优化方向.md 的 P1-4 阶段 3 待办。基准只含音符、不含休止，"
    "因此不做「每小节拍数 = 拍号」的逐小节检查。"
)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    png_path, out_path = sys.argv[1], sys.argv[2]
    do_midi = int(sys.argv[3]) if len(sys.argv) > 3 else 65
    beats = float(sys.argv[4]) if len(sys.argv) > 4 else 4.0

    result = jianpu.recognize(png_path, do_midi=do_midi, beats_per_measure=beats)
    if result.get("error"):
        print(result["error"])
        raise SystemExit(1)

    parts = [{
        "name": part["name"],
        "notes": [{"midi": n["midi"], "onsetBeats": n["startBeat"], "durationBeats": n["durationBeats"]}
                  for n in part["notes"]],
    } for part in result["parts"]]
    total_beats = max((n["onsetBeats"] + n["durationBeats"] for part in parts for n in part["notes"]), default=0)

    document = {
        "provenance": PROVENANCE,
        "source": "混声三部合唱 敕勒歌.pdf 第 11 页（简谱，3× 渲染 1785×2523）",
        "notation": "jianpu",
        "keySignature": "1=F",
        "timeSignature": "4/4",
        "beatsPerMeasure": beats,
        "measureCount": result["measureCount"],
        # 存在已知超拍小节，全曲时长以实际时间轴为准（见 validateGroundTruth 的说明）。
        "totalBeats": total_beats,
        "warnings": result["warnings"],
        "parts": parts,
    }
    Path(out_path).write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("写入 {}：{} 个声部 / {} 个音符".format(
        out_path, len(parts), sum(len(p["notes"]) for p in parts)))
    for warning in result["warnings"]:
        print("  警告：{}".format(warning))


if __name__ == "__main__":
    main()
