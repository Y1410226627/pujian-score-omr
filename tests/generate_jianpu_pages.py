#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成简谱识别的端到端基准页面（两种渲染尺寸）。

为什么需要这个脚本
------------------
`jianpu.py` 的时值判定里有一批**绝对像素常数**（横线高度、减量、字高范围……）。
这些常数只在某一个渲染比例下成立——实测同一页在 3× 下能拿 100%，在应用真正使用的
渲染尺寸（长边 2600px，约 3.8×）下却掉到 94.7%。**只用一种尺寸当护栏，改一处、另一处崩。**

所以这里把「渲染 → 识别 → 对比基准」做成一条命令，并且**两种尺寸都要过**。

依赖（只在需要重新生成基准时用，不进项目）：
  · pdf.js 的 `pdf.mjs` / `pdf.worker.mjs`（项目自带 `vendor/pdfjs/`）
  · `@napi-rs/canvas`：`npm i @napi-rs/canvas`（放在任意临时目录，用 NODE_PATH 指过去即可）

用法：
  python tests/generate_jianpu_pages.py <PDF 路径> <输出目录> [页码]
  python tests/generate_jianpu_pages.py "D:/…/混声三部合唱 敕勒歌.pdf" tests/fixtures/jianpu_pages 11

生成的文件：
  <输出目录>/<页名>_3x.png       固定 1785×2523（文档基准用的尺寸）
  <输出目录>/<页名>_2600.png     长边 2600px（与 app.js 的 renderPdfPage 完全一致）
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _workspace_tmp():
    """挑一个可写的临时目录。

    踩过的坑：
      1. `tempfile.mkdtemp()` 会用 `%TEMP%`，而本机 `%TEMP%` 是 DSH 每次会话重建的目录，
         新建子目录可能被拒绝访问（PermissionError: WinError 5）；
      2. Node 对 `.mjs` 的判定受「最近的 package.json」影响，所以临时目录里要放一个
         `{"type": "module"}`，否则 `require` 在 ESM 里会直接报错。

    所以这里按候选列表逐个试，第一个能写的就用；全都写不了才退回 `tempfile.gettempdir()`。
    """
    candidates = []
    for env_name in ("PUJIAN_TMP", "TEMP", "TMP"):
        value = os.environ.get(env_name)
        if value:
            candidates.append(Path(value) / "pujian-render")
    candidates.append(ROOT / ".cache" / "render")
    candidates.append(Path(tempfile.gettempdir()) / "pujian-render")
    last_error = None
    for base in candidates:
        try:
            base.mkdir(parents=True, exist_ok=True)
            return Path(tempfile.mkdtemp(prefix="run-", dir=base))
        except OSError as error:
            last_error = error
    raise RuntimeError("找不到可写的临时目录（可用 PUJIAN_TMP 指定）：%s" % last_error)

NODE_RENDERER = r"""
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nrc = require("@napi-rs/canvas");
// pdf.js 的 Node 分支会用到这几个浏览器全局对象，缺一个就会在渲染中途报错
globalThis.DOMMatrix = nrc.DOMMatrix;
globalThis.ImageData = nrc.ImageData;
globalThis.Path2D = nrc.Path2D;

const pdfjs = await import(process.env.PDFJS_URL);
pdfjs.GlobalWorkerOptions.workerSrc = process.env.PDFJS_WORKER_URL;

const args = JSON.parse(process.env.RENDER_ARGS);
const data = new Uint8Array(readFileSync(args.pdf));
const doc = await pdfjs.getDocument({ data, isEvalSupported: true, verbosity: 0 }).promise;
mkdirSync(args.outDir, { recursive: true });
const page = await doc.getPage(args.page);
const base = page.getViewport({ scale: 1 });
let scale;
if (args.longEdge) {
  // 与 app.js 的 renderPdfPage 完全一致：长边 2600px、上限 3.8×
  scale = Math.min(3.8, args.longEdge / Math.max(base.width, base.height));
} else {
  scale = args.scale;
}
const viewport = page.getViewport({ scale });
const width = Math.ceil(viewport.width);
const height = Math.ceil(viewport.height);
const canvas = nrc.createCanvas(width, height);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, width, height);
await page.render({ canvasContext: ctx, viewport }).promise;
writeFileSync(args.out, await canvas.encode("png"));
console.log(JSON.stringify({ out: args.out, width, height }));
await doc.destroy();
"""


def node_available():
    return shutil.which("node") is not None


def render(pdf, page, out, cache_dir, long_edge=None, scale=None):
    """调用 Node 渲染一页。需要 NODE_PATH 指向装有 @napi-rs/canvas 的目录。"""
    # 渲染脚本必须是 ES 模块：`.mjs` 后缀 + 写在系统临时目录（项目目录里若有同名残留会干扰）。
    # 注意：临时目录要放在 workspace 之外，避免被误当成项目文件；引擎目录则复制一份 pdf.js。
    script = cache_dir / "render_one.mjs"
    script.write_text(NODE_RENDERER, encoding="utf-8")
    args = {"pdf": str(pdf), "page": page, "out": str(out), "outDir": str(Path(out).parent),
            "longEdge": long_edge, "scale": scale}
    env = dict(os.environ)
    env["PDFJS_URL"] = path_to_file_url(cache_dir / "pdf.mjs")
    env["PDFJS_WORKER_URL"] = path_to_file_url(cache_dir / "pdf.worker.mjs")
    env["RENDER_ARGS"] = json.dumps(args)
    result = subprocess.run([shutil.which("node"), str(script)], capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise RuntimeError("渲染失败：\n" + result.stdout + "\n" + result.stderr)
    return json.loads(result.stdout.strip().splitlines()[-1])


def path_to_file_url(p):
    p = Path(p).resolve()
    return p.as_uri()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    pdf = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    page = int(sys.argv[3]) if len(sys.argv) > 3 else 11
    if not pdf.exists():
        print("找不到 PDF：", pdf)
        raise SystemExit(1)
    if not node_available():
        print("需要 Node.js 来渲染 PDF：请先安装 node。")
        raise SystemExit(1)
    out_dir.mkdir(parents=True, exist_ok=True)
    tag = pdf.stem.replace(" ", "_")[:8]
    cache_dir = _workspace_tmp()
    try:
        # 显式声明 ES 模块，避免 Node 按最近的 package.json 猜成 CJS
        (cache_dir / "package.json").write_text('{"type": "module"}', encoding="utf-8")
        # pdf.js 复制进临时目录，让模块解析与 `.mjs` 脚本在同一目录下进行
        shutil.copy2(ROOT / "vendor" / "pdfjs" / "pdf.mjs", cache_dir / "pdf.mjs")
        shutil.copy2(ROOT / "vendor" / "pdfjs" / "pdf.worker.mjs", cache_dir / "pdf.worker.mjs")
        for name, kwargs in (("_3x", {"scale": 3.0}), ("_2600", {"long_edge": 2600})):
            out = out_dir / (tag + "_p%02d%s.png" % (page, name))
            info = render(pdf, page, out, cache_dir, **kwargs)
            print("生成", out.name, info["width"], "x", info["height"])
    finally:
        shutil.rmtree(cache_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
