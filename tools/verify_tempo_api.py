# -*- coding: utf-8 -*-
"""用 pdf.js（项目自带 vendor）渲染 Hall PDF 的前几页，然后跑速度 OCR。

不依赖 playwright / 浏览器：直接用 Python 调 pdf.js 需要 Node 环境，
所以这里用「项目自带的 serve.py + urllib」路径：
  serve.py 已经有 /api/omr/tempo 接口，我们直接调用它。

用法：py -3 verify_tempo_api.py <pdf 路径>
"""
import base64
import json
import sys
import urllib.request
from pathlib import Path

PROJECT = Path(r"E:\识谱弹琴")


def render_pages_with_pdfjs(pdf_path, pages):
    """用 Node + 项目自带 pdf.js 把 PDF 页渲染成 PNG（3 倍），返回 [bytes]。"""
    script = f"""
const fs = require('fs');
const path = require('path');
(async () => {{
  const pdfjs = await import('file://{PROJECT.as_posix()}/vendor/pdfjs/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'file://{PROJECT.as_posix()}/vendor/pdfjs/pdf.worker.mjs';
  const data = new Uint8Array(fs.readFileSync(process.argv[1]));
  const doc = await pdfjs.getDocument({{ data }}).promise;
  const out = [];
  for (let n = 1; n <= {pages}; n += 1) {{
    const page = await doc.getPage(n);
    const viewport = page.getViewport({{ scale: 3 }});
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({{ canvasContext: ctx, viewport }}).promise;
    out.push(canvas.toDataURL('image/png').split(',')[1]);
  }}
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
  console.log('rendered', out.length, 'pages');
}})();
"""
    script_path = PROJECT / "_tmp_render.cjs"
    out_path = PROJECT / "_tmp_pages.json"
    script_path.write_text(script, encoding="utf-8")
    import subprocess
    result = subprocess.run(["node", str(script_path), str(pdf_path), str(out_path)],
                            capture_output=True, text=True, encoding="utf-8", cwd=str(PROJECT))
    try:
        pages_b64 = json.loads(out_path.read_text(encoding="utf-8"))
    except Exception:
        print(result.stdout, result.stderr[:500])
        raise
    finally:
        script_path.unlink(missing_ok=True)
        out_path.unlink(missing_ok=True)
    return [base64.b64decode(item) for item in pages_b64]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    pdf = Path(sys.argv[1])
    images = render_pages_with_pdfjs(pdf, 3)
    payload = json.dumps({"images": [base64.b64encode(item).decode("ascii") for item in images]}).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:4492/api/omr/tempo",
        data=payload, headers={"Content-Type": "application/json"}, method="POST",
    )
    body = json.loads(urllib.request.urlopen(request, timeout=600).read().decode("utf-8"))
    for page in body.get("pages", []):
        marks = page["tempos"]
        print(f"第 {page['page']} 页: {len(marks)} 处  " + ", ".join(str(m["bpm"]) for m in marks))
    return 0


if __name__ == "__main__":
    sys.exit(main())
