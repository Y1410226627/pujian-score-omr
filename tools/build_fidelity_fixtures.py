# -*- coding: utf-8 -*-
"""多份真实乐谱的对账数据集：识别若干份谱的页面，把 MusicXML 存成 fixture，
供 tests/fidelity-multi.test.mjs 逐音对账（0 误差验收）。

用法：py -3 tools/build_fidelity_fixtures.py
"""
import base64
import json
import urllib.request
from pathlib import Path

PROJECT = Path(r"E:\识谱弹琴")
ATT = Path(r"C:\Users\湮貉\.dsh\attachments\v1\files")
WORK = Path(r"C:\Users\湮貉\AppData\Local\Temp\dsh-6ATCj7\round41")
FIXTURES = PROJECT / "tests" / "fixtures" / "fidelity"

# 每份只取 1–2 页（够验证多声部/和弦/休止/变速等结构即可）
SOURCES = {
    "aot": (ATT / "89/899327d13ee0dc06a44678276b48b17935a5abf93f14522869bdf89aa62de002/attack-on-titan-call-of-silence-piano.pdf", [1]),
    "hall": (ATT / "bf/bfd32158ec11a90ec87eb6d13b386ae874c51906293e3bb01561afef48340275/hall-of-mountain-king-advanced.pdf", [1]),
    "moonlight": (ATT / "81/810b725d4e3ebcc96ed00f048a0ae38084a8f84689ba56c5434489da119d19fe/moonlight-sonata-advanced-one.pdf", [1]),
    "chilege": (ATT / "89/89c248868ef2088ca2b32fb1984f027a7d6977c24d7c276f769b19ea65f3ffcc/混声三部合唱 敕勒歌.pdf", [2]),
    "congqianman": (ATT / "98/981533a353fab74580e8028e2dc8acb1df477b2ff8dea5db4c7b9fe88b795c34/从前慢混声合唱原调C-五线谱.pdf", [1]),
}


def main():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    index = []
    for key, (pdf, pages) in SOURCES.items():
        if not pdf.exists():
            print(f"{key}: 文件不存在，跳过")
            continue
        import pymupdf
        document = pymupdf.open(pdf)
        scale = 300 / 72
        images = []
        for page_number in pages:
            page = document[page_number - 1]
            scratch = WORK / f"{key}-p{page_number}.png"
            scratch.parent.mkdir(parents=True, exist_ok=True)
            page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).save(scratch)
            images.append(base64.b64encode(scratch.read_bytes()).decode("ascii"))
        payload = json.dumps({"images": images}).encode("utf-8")
        request = urllib.request.Request("http://127.0.0.1:4492/api/omr/recognize-batch",
                                         data=payload, headers={"Content-Type": "application/json"}, method="POST")
        body = json.loads(urllib.request.urlopen(request, timeout=3600).read().decode("utf-8"))
        for offset, page_report in enumerate(body.get("pages", [])):
            xml = page_report.get("musicxml") or ""
            if not xml:
                print(f"{key} 第 {pages[offset]} 页：无识别结果")
                continue
            target = FIXTURES / f"{key}-p{pages[offset]}.musicxml"
            target.write_text(xml, encoding="utf-8")
            index.append({"key": key, "page": pages[offset], "file": target.name, "bytes": len(xml)})
            print(f"{key} 第 {pages[offset]} 页 → {target.name}（{len(xml)} 字节）")
    (FIXTURES / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print("已写出", len(index), "个 fixture")


if __name__ == "__main__":
    main()
