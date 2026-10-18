from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
import base64
import binascii
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
import zipfile


PROJECT_DIR = Path(__file__).resolve().parent
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_MUSICXML_BYTES = 50 * 1024 * 1024
# 整本识别（多页一次交给 Audiveris）：页数上限与请求体上限。
# 16 页 × 约 1.5 MB 的 PNG（base64 后约 2 MB）= 约 32 MB，所以给到 64 MB 余量。
MAX_BATCH_PAGES = 32
MAX_BATCH_BYTES = 64 * 1024 * 1024
# 整本识别的总超时：Audiveris 实测约 2.5–5 秒/页（一 JVM 多页），32 页给到 15 分钟。
MAX_BATCH_SECONDS = 900
# 整本简谱识别：实测约 0.1 秒/页，32 页理论上几秒，给 5 分钟足够。
MAX_JIANPU_BATCH_SECONDS = 300


def read_musicxml_from_mxl(mxl_path):
    """从 Audiveris 导出的 .mxl 里取出 MusicXML 文本。

    成功返回 XML 字符串；失败返回 `(HTTP 状态码, 响应体)` 二元组，
    让单页/整本两条路径都能复用同一套错误处理。
    """
    try:
        with zipfile.ZipFile(mxl_path) as archive:
            members = [name for name in archive.namelist()
                       if name.lower().endswith((".xml", ".musicxml")) and "meta-inf" not in name.lower()]
            if not members:
                return (422, {"error": "Audiveris 导出的文件里没有找到 MusicXML。", "engine": "audiveris"})
            return archive.read(members[0]).decode("utf-8-sig")
    except zipfile.BadZipFile:
        return (422, {"error": "Audiveris 导出的压缩文件已损坏。", "engine": "audiveris"})
    except (OSError, UnicodeDecodeError, KeyError):
        return (422, {"error": "Audiveris 导出的 MusicXML 无法读取。", "engine": "audiveris"})


# 只允许直接暴露给浏览器的静态资源后缀。.py/.bat/.exe/.pth 等一律不可下载。
ALLOWED_SUFFIXES = {".html", ".htm", ".css", ".js", ".mjs", ".json", ".md", ".svg", ".ico", ".png", ".webmanifest", ".mp3"}
# 这些目录里含有源码、虚拟环境、模型与依赖，任何情况下都不应通过 HTTP 暴露。
DENIED_SEGMENTS = {".venv", ".git", "node_modules", "__pycache__", "tests", ".workbuddy-ai", "deliverables"}
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}

# 一次只跑一个 OMR 任务；并发请求直接拒绝，避免线程与内存被拖垮。
OMR_SLOT = threading.Lock()
OMR_QUEUE_WAIT_SECONDS = 30
REQUEST_TIMEOUT_SECONDS = 30

SECURITY_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    ("Content-Security-Policy", (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' blob: data:; "
        "media-src 'self' blob:; "
        "connect-src 'self'; "
        "worker-src 'self' blob:; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )),
)


def find_homr():
    configured = os.environ.get("HOMR_EXECUTABLE", "").strip()
    if configured:
        configured_path = Path(configured).expanduser()
        if configured_path.is_file():
            return str(configured_path.resolve())
        resolved = shutil.which(configured)
        if resolved:
            return resolved
    local_candidates = (
        PROJECT_DIR / ".venv" / "Scripts" / "homr.exe",
        PROJECT_DIR / ".venv" / "Scripts" / "homr",
        PROJECT_DIR / ".venv" / "bin" / "homr",
    )
    for candidate in local_candidates:
        if candidate.is_file():
            return str(candidate)
    return shutil.which("homr")


def find_audiveris():
    """Audiveris 是 Java 程序，优先用项目自带的可移植版本（.tools/audiveris），其次找 PATH。"""
    configured = os.environ.get("AUDIVERIS_EXECUTABLE", "").strip()
    if configured:
        configured_path = Path(configured).expanduser()
        if configured_path.is_file():
            return str(configured_path.resolve())
        resolved = shutil.which(configured)
        if resolved:
            return resolved
    local_candidates = (
        PROJECT_DIR / ".tools" / "audiveris" / "Audiveris" / "Audiveris.exe",
        PROJECT_DIR / ".tools" / "audiveris" / "Audiveris" / "bin" / "Audiveris",
    )
    for candidate in local_candidates:
        if candidate.is_file():
            return str(candidate)
    return shutil.which("Audiveris")


def find_jianpu_python():
    """简谱识别（jianpu.py）需要 opencv-python 与 Pillow，它们随 homr 装在项目 .venv 里。

    找不到 .venv 时退回当前解释器：那样 jianpu.py 会自报依赖缺失，
    接口据此返回「引擎不可用」，让前端优雅降级，而不是抛栈。
    """
    configured = os.environ.get("JIANPU_PYTHON", "").strip()
    if configured:
        configured_path = Path(configured).expanduser()
        if configured_path.is_file():
            return str(configured_path.resolve())
        resolved = shutil.which(configured)
        if resolved:
            return resolved
    for candidate in (
        PROJECT_DIR / ".venv" / "Scripts" / "python.exe",
        PROJECT_DIR / ".venv" / "bin" / "python",
    ):
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def omr_worker_count(page_count):
    """整本识别要开几个 Audiveris 进程。

    为什么要并行：Audiveris 单个 JVM 内部的并行度有限，整本页面多时 CPU 用不满。
    实测 10 页（16 核）：1 个进程 3.81 秒/页、2 个进程 **2.50 秒/页**、
    4 个进程 2.28 秒/页。2 个进程收益最大、内存最省，所以默认 2；
    页数很少时（JVM 启动开销占大头）仍然单进程。
    默认按 CPU 自适应（≥12 核 3 个、≥6 核 2 个、更少 1 个），可用环境变量 PUJIAN_OMR_WORKERS 覆盖（1–4）。
    """
    if page_count < 3:
        return 1
    try:
        desired = int(os.environ.get("PUJIAN_OMR_WORKERS", "0"))
    except ValueError:
        desired = 0
    if desired <= 0:
        # 没指定就按 CPU 自适应：12 核以上开 3 个（实测 10 页：2 进程 25.0 秒、4 进程 22.8 秒，
        # 再往上收益很小，而每个 JVM 要占 1 GB 上下内存，所以留一档余量）。
        cores = os.cpu_count() or 4
        desired = 3 if cores >= 12 else (2 if cores >= 6 else 1)
    desired = min(4, max(1, desired))
    return min(desired, max(1, (page_count + 2) // 3))


def omr_child_env(temporary_path):
    """给识谱子进程准备环境变量，把临时目录指到本次任务自己的目录。

    为什么要这么做：Audiveris 是 Java 程序，JVM 默认把临时文件写到系统 %TEMP%
    （`java.io.tmpdir`）。在机房/学校这类受限电脑上，%TEMP% 常常不允许子进程新建文件，
    于是 JVM 解压音符分类模型失败，整页识别会以
    `Error in reaching step PAGE` 告终（真实原因藏在 stderr 里：
    `AccessDeniedException: %TEMP%\\AbstractClassifier-*.tmp`）。
    把 TMP/TEMP/TMPDIR 指到本次请求自己的临时目录后即可正常工作。
    顺带一个好处：多个识谱任务之间不会抢同一个临时文件。
    """
    env = dict(os.environ)
    job_temp = str(temporary_path)
    for name in ("TMP", "TEMP", "TMPDIR"):
        env[name] = job_temp
    return env


JIANPU_SCRIPT = PROJECT_DIR / "jianpu.py"


def jianpu_available():
    """简谱识别是否可用：需要 jianpu.py，以及一个带 opencv 的解释器。

    带 opencv 的解释器通常就是装了 homr 的项目 .venv；也可用 JIANPU_PYTHON 指定。
    serve.py 自身用什么解释器启动都不影响这里（避免用 .venv 启动时误报不可用）。
    """
    if not JIANPU_SCRIPT.is_file():
        return False
    if os.environ.get("JIANPU_PYTHON", "").strip():
        return True
    return any(candidate.is_file() for candidate in (
        PROJECT_DIR / ".venv" / "Scripts" / "python.exe",
        PROJECT_DIR / ".venv" / "bin" / "python",
    ))


class ProjectHandler(SimpleHTTPRequestHandler):
    # 给每个连接设置读超时，避免客户端声明 Content-Length 后慢速滴流、长期占用线程。
    timeout = REQUEST_TIMEOUT_SECONDS

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_DIR), **kwargs)

    def end_headers(self):
        for name, value in SECURITY_HEADERS:
            self.send_header(name, value)
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def host_is_allowed(self):
        host = self.headers.get("Host", "").strip()
        if not host:
            return False
        if host.startswith("["):
            hostname = host[1:host.find("]")] if "]" in host else host
        else:
            hostname = host.split(":", 1)[0]
        return hostname.lower() in ALLOWED_HOSTS

    def path_is_servable(self):
        """只服务项目根目录下的白名单静态文件，以及 vendor/ 下的本地依赖；
        拒绝隐藏文件、其他子目录与代码/依赖文件。"""
        decoded = unquote(urlsplit(self.path).path)
        if "\x00" in decoded:
            return False
        if decoded in ("", "/"):
            return True
        parts = [part for part in decoded.replace("\\", "/").split("/") if part not in ("", ".")]
        if not parts:
            return False
        # 隐藏文件一律拒绝，但 .assets 例外：它是「真实音色」采样音源的存放目录（只放 mp3/json，由安装器下载，不进 git）。
        if any((part.startswith(".") and part != ".assets") or part.lower() in DENIED_SEGMENTS
               for part in parts):
            return False
        # 顶层单文件：按后缀白名单放行；其他子目录一律拒绝。
        if len(parts) == 1:
            return Path(parts[0]).suffix.lower() in ALLOWED_SUFFIXES
        # vendor/ 下的本地依赖（如 pdf.js）与 .assets/ 下的采样音源允许深层访问，仍受后缀白名单约束。
        return parts[0] in ("vendor", ".assets") and Path(parts[-1]).suffix.lower() in ALLOWED_SUFFIXES

    def do_GET(self):
        if not self.host_is_allowed():
            self.send_error(403, "Forbidden")
            return
        if self.path.split("?", 1)[0] == "/api/omr/status":
            self.send_json(200, {
                "homrAvailable": find_homr() is not None,
                "audiverisAvailable": find_audiveris() is not None,
                "jianpuAvailable": jianpu_available(),
            })
            return
        if not self.path_is_servable():
            self.send_error(404, "Not Found")
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.host_is_allowed():
            self.send_error(403, "Forbidden")
            return
        if not self.path_is_servable():
            self.send_error(404, "Not Found")
            return
        super().do_HEAD()

    def list_directory(self, path):
        # 关闭目录列表：目录请求一律 404，不暴露项目结构。
        self.send_error(404, "Not Found")
        return None

    def read_image_body(self):
        """校验并读取 POST 上来的图片，返回 (图片字节, 后缀)。

        只收 PNG/JPEG、限制 25 MB、校验魔数。校验失败时本方法已自行发送响应并返回 None。
        """
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        image_types = {
            "image/png": (b"\x89PNG\r\n\x1a\n", ".png"),
            "image/jpeg": (b"\xff\xd8\xff", ".jpg"),
        }
        if content_type not in image_types:
            self.send_json(415, {"error": "本机识谱接口只接收 PNG 或 JPEG 图片。"})
            return None
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_IMAGE_BYTES:
            self.send_json(413, {"error": "当前页面图片为空或超过 25 MB。"})
            return None
        signature, suffix = image_types[content_type]
        image_bytes = self.rfile.read(content_length)
        if len(image_bytes) != content_length:
            self.send_json(400, {"error": "图片数据未完整接收，请重试。"})
            return None
        if not image_bytes.startswith(signature):
            self.send_json(400, {"error": "图片内容与文件格式不匹配。"})
            return None
        return image_bytes, suffix

    def do_POST(self):
        if not self.host_is_allowed():
            self.send_error(403, "Forbidden")
            return
        route = self.path.split("?", 1)[0]
        if route == "/api/jianpu/recognize":
            self.handle_jianpu()
            return
        if route == "/api/omr/recognize-batch":
            self.handle_audiveris_batch()
            return
        if route == "/api/jianpu/recognize-batch":
            self.handle_jianpu_batch()
            return
        if route != "/api/omr/recognize":
            self.send_error(404)
            return

        # engine 参数：audiveris=整页识别（多声部）；homr=单谱表裁片（逐行识别用）。
        # 不传时默认 homr，保持逐行识别流程的既有语义。
        engine = (parse_qs(urlsplit(self.path).query).get("engine", ["homr"])[0] or "homr").lower()
        if engine not in ("audiveris", "homr"):
            self.send_json(400, {"error": "不支持的识谱引擎参数。"})
            return

        body = self.read_image_body()
        if body is None:
            return
        image_bytes, suffix = body

        # 并发闸门：同一时刻只跑一个 OMR 任务。这里短暂等待而不是立刻拒绝，
        # 避免客户端两次请求之间几毫秒的抖动被误判成"任务繁忙"而放弃整页专业识别。
        if not OMR_SLOT.acquire(timeout=OMR_QUEUE_WAIT_SECONDS):
            self.send_json(503, {"error": "本机识谱任务正忙，请稍候重试。", "reason": "busy"})
            return
        try:
            with tempfile.TemporaryDirectory(prefix="pujian-omr-") as temporary_dir:
                temporary_path = Path(temporary_dir)
                input_path = temporary_path / ("score" + suffix)
                input_path.write_bytes(image_bytes)
                if engine == "audiveris":
                    self.run_audiveris(input_path, temporary_path)
                else:
                    self.run_homr(input_path, temporary_path)
        except subprocess.TimeoutExpired:
            self.send_json(504, {"error": "本机识谱超过 5 分钟，已停止处理。"})
        except FileNotFoundError:
            self.send_json(503, {"error": "找不到本机识谱引擎，请检查 AUDIVERIS_EXECUTABLE / HOMR_EXECUTABLE 设置。"})
        except Exception as error:
            print("[pujian] 识谱接口出错：{!r}".format(error))
            self.send_json(500, {"error": "本机识谱接口出错，详情见启动窗口。"})
        finally:
            OMR_SLOT.release()

    def run_audiveris(self, input_path, temporary_path):
        """整页交给 Audiveris 识别，输出多声部 MusicXML。"""
        audiveris = find_audiveris()
        if not audiveris:
            self.send_json(503, {"error": "未找到本机 Audiveris。", "reason": "engine-missing"})
            return
        output_dir = temporary_path / "audiveris-out"
        output_dir.mkdir()
        process = subprocess.run(
            [audiveris, "-batch", "-transcribe", "-export", "-output", str(output_dir), "--", str(input_path)],
            cwd=str(temporary_path),
            env=omr_child_env(temporary_path),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
            check=False,
        )
        mxl_files = sorted(path for path in output_dir.rglob("*.mxl") if path.is_file())
        if not mxl_files:
            detail = (process.stderr.decode("utf-8", errors="replace") + process.stdout.decode("utf-8", errors="replace"))[-1200:].strip()
            if detail:
                # 详情只写到本地控制台，不回传给页面，避免泄露本机路径与用户名。
                print("[audiveris] 识谱失败，返回码 {}：\n{}".format(process.returncode, detail))
            if "Sheet ignored" in detail or "Error in reaching step" in detail:
                message = "Audiveris 没能从这张图里读出谱线（可能是分辨率太低或画面不完整）。可换更清晰的整页图片，或改用逐行识别。"
            elif process.returncode != 0:
                message = "本机 Audiveris 执行失败（返回码 {}），详情见启动窗口。".format(process.returncode)
            else:
                message = "本机 Audiveris 没有生成 MusicXML 结果。"
            self.send_json(422, {"error": message, "engine": "audiveris"})
            return
        mxl_path = mxl_files[0]
        if mxl_path.stat().st_size > MAX_MUSICXML_BYTES:
            self.send_json(413, {"error": "本机识谱输出的 MusicXML 超过 50 MB。"})
            return
        result = read_musicxml_from_mxl(mxl_path)
        if isinstance(result, tuple):
            message, payload = result
            self.send_json(message, payload)
            return
        self.send_json(200, {"musicxml": result, "engine": "audiveris"})

    def read_batch_images(self, temporary_path):
        """读取「整本识别」请求里的 base64 图片，落盘成 page001.png / page002.png …

        请求体：JSON `{"images": ["<base64 png/jpeg>", ...], ...其它参数}`（最多 MAX_BATCH_PAGES 页）。
        成功返回 `(payload, input_paths)`；校验失败时本方法已自行发送响应并返回 None。
        五线谱（Audiveris）与简谱（jianpu.py）两条整本识别路径共用这一份读取逻辑，
        避免两处各写一遍校验、漏掉其中一处。
        """
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self.send_json(415, {"error": "整本识别接口只接收 JSON。"})
            return None
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_BATCH_BYTES:
            self.send_json(413, {"error": "整本识别的图片总量为空或超过上限。"})
            return None
        image_bytes = self.rfile.read(content_length)
        if len(image_bytes) != content_length:
            self.send_json(400, {"error": "请求数据未完整接收，请重试。"})
            return None
        try:
            payload = json.loads(image_bytes.decode("utf-8"))
            encoded_pages = payload.get("images") or []
        except (ValueError, UnicodeDecodeError, AttributeError):
            self.send_json(400, {"error": "整本识别的请求格式不正确。"})
            return None
        if not isinstance(encoded_pages, list) or not encoded_pages:
            self.send_json(400, {"error": "整本识别至少需要一页图片。"})
            return None
        if len(encoded_pages) > MAX_BATCH_PAGES:
            self.send_json(400, {"error": "一次最多识别 {} 页。".format(MAX_BATCH_PAGES)})
            return None
        input_paths = []
        for index, encoded in enumerate(encoded_pages):
            if not isinstance(encoded, str):
                self.send_json(400, {"error": "整本识别的图片数据格式不正确。"})
                return None
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                self.send_json(400, {"error": "整本识别中有图片解码失败。"})
                return None
            if raw.startswith(b"\x89PNG\r\n\x1a\n"):
                suffix = ".png"
            elif raw.startswith(b"\xff\xd8\xff"):
                suffix = ".jpg"
            else:
                self.send_json(400, {"error": "整本识别只支持 PNG 或 JPEG 图片。"})
                return None
            path = temporary_path / ("page%03d%s" % (index + 1, suffix))
            path.write_bytes(raw)
            input_paths.append(path)
        return payload, input_paths

    def run_audiveris_chunk(self, root, slot, page_paths):
        """在独立子进程里识别一组页面，返回 `(结果 {页号: 载荷}, 返回码, 日志尾部)`。

        每个分片有自己的输入目录、输出目录和临时目录（TMP/TEMP 指过去），
        所以多个分片可以真正并行，不会抢同一批中间文件。
        页号取自输入文件名 pageNNN，与分片顺序无关，合并时按页号还原即可。
        """
        chunk = root / ("chunk%d" % slot)
        chunk.mkdir()
        output_dir = chunk / "audiveris-out"
        output_dir.mkdir()
        inputs = []
        for path in page_paths:
            target = chunk / path.name
            try:
                # 硬链接：同一磁盘上不复制内容，几十毫秒就能建好 16 页的输入。
                if not target.exists():
                    os.link(path, target)
            except OSError:
                shutil.copyfile(path, target)
            inputs.append(str(target))
        audiveris = find_audiveris()
        process = subprocess.run(
            [audiveris, "-batch", "-transcribe", "-export", "-output", str(output_dir), "--"] + inputs,
            cwd=str(chunk),
            env=omr_child_env(chunk),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=MAX_BATCH_SECONDS,
            check=False,
        )
        detail = (process.stderr.decode("utf-8", errors="replace")
                  + process.stdout.decode("utf-8", errors="replace"))[-900:].strip()
        results = {}
        for path in page_paths:
            try:
                number = int(path.stem[4:])
            except ValueError:
                continue
            # 按「输入页序」找输出：Audiveris 用输入文件名（去扩展名）命名输出，
            # 也可能派生出别的名字，所以按前缀匹配。
            mxl_path = None
            for candidate in output_dir.rglob("*.mxl"):
                if candidate.stem.lower().startswith(path.stem.lower()):
                    mxl_path = candidate
                    break
            if mxl_path is None:
                results[number] = {"error": "第 {} 页没有识别出 MusicXML。".format(number)}
                continue
            if mxl_path.stat().st_size > MAX_MUSICXML_BYTES:
                results[number] = {"error": "第 {} 页的 MusicXML 超过 50 MB。".format(number)}
                continue
            result = read_musicxml_from_mxl(mxl_path)
            if isinstance(result, tuple):
                _message, error_payload = result
                results[number] = {"error": error_payload.get("error", "第 {} 页解析失败。".format(number))}
            else:
                results[number] = {"musicxml": result}
        return results, process.returncode, detail

    def handle_audiveris_batch(self):
        """整本五线谱识别：把多页图片**一次**交给 Audiveris，共享同一个 JVM。

        为什么值得单独做一个接口：Audiveris 每次启动要付约 3 秒的 JVM/引擎初始化开销，
        每页还要重新加载谱表/符号模型。逐页调用时 16 页要付 16 次；合并成一次批量调用
        只需付 1 次。实测（2600px 页面，16 核机器）：
            单页接口 9.19 秒/页；一次 3 页 4.96 秒/页；一次 8 页 4.26 秒/页；
            一次 16 页 **2.49 秒/页**（合计 39.79 秒）。
        也就是说整本识别的速度是逐页识别的 3.7 倍。
        混合谱（部分页面是简谱）现在只批量送「有谱表的页」，其余页由前端跳过并提示。
        页数多时还会按 CPU 自适应拆给几个进程同时跑（可用 PUJIAN_OMR_WORKERS 指定 1–4），
        实测 10 页：1 进程 3.81 秒/页 → 2 进程 2.50 → 4 进程 **2.28 秒/页**。

        请求体：JSON `{"images": ["<base64 png/jpeg>", ...]}`（最多 MAX_BATCH_PAGES 页）。
        响应：`{"pages": [{"musicxml": "..."} | {"error": "..."} , ...], "engine": "audiveris"}`。
        单页失败不会中断整批：失败的那一项带 error，其余照常返回（与前端「单页失败不中断」一致）。
        """
        if not find_audiveris():
            self.send_json(503, {"error": "未找到本机 Audiveris。", "reason": "engine-missing"})
            return
        try:
            with tempfile.TemporaryDirectory(prefix="pujian-omr-batch-") as temporary_dir:
                temporary_path = Path(temporary_dir)
                prepared = self.read_batch_images(temporary_path)
                if prepared is None:
                    return
                _payload, input_paths = prepared
                if not OMR_SLOT.acquire(timeout=OMR_QUEUE_WAIT_SECONDS):
                    self.send_json(503, {"error": "本机识谱任务正忙，请稍候重试。", "reason": "busy"})
                    return
                try:
                    workers = omr_worker_count(len(input_paths))
                    if workers > 1:
                        # 交错分配（第 1、3、5… 页给 0 号进程）：各分片页数最均衡。
                        chunks = [input_paths[index::workers] for index in range(workers)]
                        collected = {}
                        with ThreadPoolExecutor(max_workers=workers) as pool:
                            futures = [pool.submit(self.run_audiveris_chunk, temporary_path, slot, chunk)
                                       for slot, chunk in enumerate(chunks) if chunk]
                            for future in futures:
                                chunk_results, returncode, detail = future.result()
                                if detail:
                                    print("[audiveris-batch] 返回码 {}：\n{}".format(returncode, detail))
                                collected.update(chunk_results)
                        pages = [collected.get(number, {"error": "第 {} 页没有识别出 MusicXML。".format(number)})
                                 for number in range(1, len(input_paths) + 1)]
                    else:
                        results, returncode, detail = self.run_audiveris_chunk(temporary_path, 0, input_paths)
                        if detail:
                            print("[audiveris-batch] 返回码 {}：\n{}".format(returncode, detail))
                        pages = [results.get(number, {"error": "第 {} 页没有识别出 MusicXML。".format(number)})
                                 for number in range(1, len(input_paths) + 1)]
                    if not pages:
                        pages = [{"error": "整本识别没有返回结果。"}]
                    self.send_json(200, {"pages": pages, "engine": "audiveris"})
                finally:
                    OMR_SLOT.release()
        except subprocess.TimeoutExpired:
            self.send_json(504, {"error": "整本识别超时，已停止处理。"})
        except Exception as error:
            print("[pujian] 整本识别接口出错：{!r}".format(error))
            self.send_json(500, {"error": "本机整本识别接口出错，详情见启动窗口。"})

    def handle_jianpu_batch(self):
        """整本简谱识别：把多页图片**一次**交给 jianpu.py。

        为什么值得单独做一个接口：每页单独调一次 jianpu.py，都要付一次
        Python 启动 + numpy/cv2 导入 + 数字模板渲染的开销（实测约 0.42 秒/页）；
        一次传多页则只在开头付一次，之后每页只花识别本身的时间。
        实测同一批页面：逐页 0.42 秒/页 → 一次批量 **0.09 秒/页**（约 4.6 倍）。

        请求体：JSON `{"images": ["<base64 png/jpeg>", ...], "do": 65, "beats": 4}`
        （`do` = 1=X 中 X 的 MIDI 音高，`beats` = 每小节拍数）。
        响应：`{"pages": [{...音符模型...} | {"error": "..."}], "engine": "jianpu"}`。
        """
        if not JIANPU_SCRIPT.is_file():
            self.send_json(503, {"error": "未找到简谱识别模块 jianpu.py。", "reason": "engine-missing"})
            return
        try:
            with tempfile.TemporaryDirectory(prefix="pujian-jianpu-batch-") as temporary_dir:
                temporary_path = Path(temporary_dir)
                prepared = self.read_batch_images(temporary_path)
                if prepared is None:
                    return
                payload, input_paths = prepared
                try:
                    do_midi = int(payload.get("do", 65))
                    beats = float(payload.get("beats", 4))
                except (TypeError, ValueError):
                    self.send_json(400, {"error": "简谱整本识别的调号/拍号参数无效。"})
                    return
                if not 0 <= do_midi <= 127 or not 1 <= beats <= 16:
                    self.send_json(400, {"error": "简谱整本识别的调号/拍号超出范围。"})
                    return
                if not OMR_SLOT.acquire(timeout=OMR_QUEUE_WAIT_SECONDS):
                    self.send_json(503, {"error": "本机识谱任务正忙，请稍候重试。", "reason": "busy"})
                    return
                try:
                    process = subprocess.run(
                        [find_jianpu_python(), str(JIANPU_SCRIPT), "--batch",
                         "--do", str(do_midi), "--beats", str(beats)]
                        + [str(path) for path in input_paths],
                        cwd=str(PROJECT_DIR),
                        env=omr_child_env(temporary_path),
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=MAX_JIANPU_BATCH_SECONDS,
                        check=False,
                    )
                    stdout = process.stdout.decode("utf-8", errors="replace").strip()
                    stderr = process.stderr.decode("utf-8", errors="replace")[-800:].strip()
                    try:
                        parsed = json.loads(stdout) if stdout else {}
                    except json.JSONDecodeError:
                        parsed = {}
                    pages = parsed.get("pages")
                    if not isinstance(pages, list) or len(pages) != len(input_paths):
                        if stderr or stdout:
                            print("[jianpu-batch] 返回码 {}：\n{}\n{}".format(process.returncode, stderr, stdout[:800]))
                        if process.returncode == 2:
                            self.send_json(503, {
                                "error": "简谱识别所需的组件没装好（缺 opencv-python / Pillow）。"
                                         "请按 README 里「安装 homr」那一步装好后再试。",
                                "reason": "engine-missing",
                            })
                        else:
                            self.send_json(500, {"error": "本机简谱整本识别出错，详情见启动窗口。"})
                        return
                    normalized = []
                    for index, page in enumerate(pages):
                        if isinstance(page, dict) and not page.get("error"):
                            normalized.append(page)
                        else:
                            message = (page or {}).get("error") if isinstance(page, dict) else None
                            normalized.append({"error": message or "第 {} 页没有读出简谱音符。".format(index + 1)})
                    self.send_json(200, {"pages": normalized, "engine": "jianpu"})
                finally:
                    OMR_SLOT.release()
        except subprocess.TimeoutExpired:
            self.send_json(504, {"error": "整本简谱识别超时，已停止处理。"})
        except Exception as error:
            print("[pujian] 整本简谱识别接口出错：{!r}".format(error))
            self.send_json(500, {"error": "本机整本简谱识别接口出错，详情见启动窗口。"})

    def run_homr(self, input_path, temporary_path):
        """把一张谱表裁片交给 homr 识别（逐行识别流程）。"""
        homr = find_homr()
        if not homr:
            # 与"任务繁忙"区分开：前者需要前端改用估算兜底，后者只需稍后重试。
            self.send_json(503, {"error": "未找到本机 homr 命令。", "reason": "engine-missing"})
            return
        process = subprocess.run(
            [homr, str(input_path)],
            cwd=str(temporary_path),
            env=omr_child_env(temporary_path),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
            check=False,
        )
        output_files = sorted(
            path for path in temporary_path.rglob("*")
            if path.is_file() and path.suffix.lower() in (".musicxml", ".xml")
        )
        if not output_files:
            detail = process.stderr.decode("utf-8", errors="replace")[-1200:].strip()
            if detail:
                # 详情只写到本地控制台，不回传给页面，避免泄露本机路径与用户名。
                print("[homr] 识谱失败，返回码 {}：\n{}".format(process.returncode, detail))
            # "No noteheads found" 表示这一行谱表本来就没有符头（整行休止、
            # 或该声部尚未进入），属于正常结果而非故障：返回 200 + 标记，
            # 让前端按空谱表处理，也避免浏览器控制台出现无意义的报错。
            if "No noteheads found" in detail:
                self.send_json(200, {
                    "empty": True,
                    "message": "这一行谱表没有音符（整行休止或该声部尚未进入）。",
                })
                return
            if process.returncode != 0:
                message = "本机识谱引擎执行失败（返回码 {}），详情见启动窗口。".format(process.returncode)
            else:
                message = "本机识谱引擎没有生成 MusicXML 结果。"
            self.send_json(422, {"error": message})
            return
        output_path = output_files[0]
        if output_path.stat().st_size > MAX_MUSICXML_BYTES:
            self.send_json(413, {"error": "本机识谱输出的 MusicXML 超过 50 MB。"})
            return
        musicxml = output_path.read_text(encoding="utf-8-sig")
        self.send_json(200, {"musicxml": musicxml, "engine": "homr"})

    def handle_jianpu(self):
        """简谱（数字谱）识别：把整页交给 jianpu.py，返回内部音符模型（不生成 MusicXML）。"""
        query = parse_qs(urlsplit(self.path).query)
        try:
            do_midi = int(query.get("do", ["65"])[0])
            beats = float(query.get("beats", ["4"])[0])
        except ValueError:
            self.send_json(400, {"error": "简谱识别的调号/拍号参数无效。"})
            return
        if not 0 <= do_midi <= 127 or not 1 <= beats <= 16:
            self.send_json(400, {"error": "简谱识别的调号/拍号超出范围。"})
            return
        if not JIANPU_SCRIPT.is_file():
            self.send_json(503, {"error": "未找到简谱识别模块 jianpu.py。", "reason": "engine-missing"})
            return
        body = self.read_image_body()
        if body is None:
            return
        image_bytes, suffix = body

        if not OMR_SLOT.acquire(timeout=OMR_QUEUE_WAIT_SECONDS):
            self.send_json(503, {"error": "本机识谱任务正忙，请稍候重试。", "reason": "busy"})
            return
        try:
            with tempfile.TemporaryDirectory(prefix="pujian-jianpu-") as temporary_dir:
                input_path = Path(temporary_dir) / ("page" + suffix)
                input_path.write_bytes(image_bytes)
                process = subprocess.run(
                    [find_jianpu_python(), str(JIANPU_SCRIPT), str(input_path),
                     "--do", str(do_midi), "--beats", str(beats)],
                    cwd=str(PROJECT_DIR),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=180,
                    check=False,
                )
                stdout = process.stdout.decode("utf-8", errors="replace").strip()
                stderr = process.stderr.decode("utf-8", errors="replace")[-800:].strip()
                try:
                    payload = json.loads(stdout) if stdout else {}
                except json.JSONDecodeError:
                    payload = {}
                if payload.get("error"):
                    # 引擎自报缺依赖（返回码 2）时用 engine-missing，与"任务繁忙"区分开，
                    # 前端据此提示用户装依赖而不是盲目重试。
                    print("[jianpu] 简谱识别不可用：\n{}".format(stderr or payload["error"]))
                    # 不要把引擎的原始 error 直接回给浏览器：它可能含本机绝对路径
                    # （例如「无法读取图片：C:\Users\…\page.png」）。这里只按返回码给结论。
                    if process.returncode == 2:
                        self.send_json(503, {
                            "error": "简谱识别所需的组件没装好（缺 opencv-python / Pillow）。"
                                     "请按 README 里「安装 homr」那一步装好后再试。",
                            "reason": "engine-missing",
                        })
                    else:
                        self.send_json(503, {
                            "error": "本机简谱识别暂时不可用，详情见启动窗口。",
                            "reason": "engine-error",
                        })
                    return
                if process.returncode != 0 or not payload:
                    if stderr:
                        print("[jianpu] 简谱识别失败，返回码 {}：\n{}".format(process.returncode, stderr))
                    self.send_json(500, {"error": "本机简谱识别出错，详情见启动窗口。"})
                    return
                if not payload.get("parts"):
                    self.send_json(422, {
                        "error": "这一页没有读出简谱音符（可能不是简谱页面，或图片不清晰）。",
                        "warnings": payload.get("warnings", []),
                    })
                    return
                self.send_json(200, payload)
        except subprocess.TimeoutExpired:
            self.send_json(504, {"error": "简谱识别超过 3 分钟，已停止处理。"})
        except Exception as error:
            print("[jianpu] 简谱识别接口出错：{!r}".format(error))
            self.send_json(500, {"error": "本机简谱识别接口出错，详情见启动窗口。"})
        finally:
            OMR_SLOT.release()


def resolve_port():
    """决定监听端口：默认 0（由系统挑一个空闲端口，避免和其它软件抢端口）。

    需要固定端口时（例如自动化测试），可以用 `--port 4492` 或环境变量 `PUJIAN_PORT=4492`。
    非法值一律退回 0，不影响正常启动。
    """
    raw = os.environ.get("PUJIAN_PORT", "").strip()
    arguments = sys.argv[1:]
    for index, argument in enumerate(arguments):
        if argument == "--port" and index + 1 < len(arguments):
            raw = arguments[index + 1]
        elif argument.startswith("--port="):
            raw = argument.split("=", 1)[1]
    try:
        port = int(raw) if raw else 0
    except ValueError:
        return 0
    return port if 0 <= port <= 65535 else 0


server = ThreadingHTTPServer(("127.0.0.1", resolve_port()), ProjectHandler)
url = "http://127.0.0.1:{}/".format(server.server_address[1])

print("谱见已启动：{}".format(url))
print("保持此窗口打开即可使用；按 Ctrl+C 停止。")
if not os.environ.get("PUJIAN_NO_BROWSER"):
    threading.Timer(0.7, lambda: webbrowser.open(url)).start()

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\n谱见已停止。")
finally:
    server.server_close()
