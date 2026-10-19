# -*- coding: utf-8 -*-
"""用 pdf.js 的 **legacy build** 在 Node 里渲染 PDF（项目 vendor 里已有）。

之前失败的原因：Node 环境里没有 `document`（canvas 元素），
改用 pdf.js 的 `@canvas/node` 或者干脆用 `getTextContent` + 文字坐标。

但更简单的办法：pdf.js 能直接拿「文字 + 位置」。速度标记在 MuseScore 导出的 PDF 里
其实是**普通文字**（"Alla marcia e molto marcato 138"），
所以只需要读文字层，不需要渲染！

这一步先验证「文字层里有没有速度数字」。
"""
import json
import subprocess
import sys
from pathlib import Path

PROJECT = Path(r"E:\识谱弹琴")

SCRIPT = r"""
const fs = require('fs');
(async () => {
  const pdfjs = await import('file:///E:/识谱弹琴/vendor/pdfjs/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(process.argv[1]));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = [];
    for (const item of content.items) {
      if (item.str && item.str.trim()) {
        items.push({ str: item.str, x: Math.round(item.transform[4]), y: Math.round(item.transform[5]) });
      }
    }
    out.push({ page: n, items });
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
  console.log('pages', out.length);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
"""


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    pdf = Path(sys.argv[1])
    out = PROJECT / "_tmp_text.json"
    script = PROJECT / "_tmp_text.cjs"
    script.write_text(SCRIPT, encoding="utf-8")
    result = subprocess.run(["node", str(script), str(pdf), str(out)],
                            capture_output=True, text=True, encoding="utf-8", cwd=str(PROJECT))
    print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip()[:400])
    if not out.exists():
        return 1
    pages = json.loads(out.read_text(encoding="utf-8"))
    for page in pages:
        print("=" * 60)
        print(f"第 {page['page']} 页文字 {len(page['items'])} 条")
        for item in page["items"][:40]:
            print(f"   ({item['x']:4d},{item['y']:4d}) {item['str']!r}")
    script.unlink(missing_ok=True)
    out.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
