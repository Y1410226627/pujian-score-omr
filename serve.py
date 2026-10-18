from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
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

# 只允许直接暴露给浏览器的静态资源后缀。.py/.bat/.exe/.pth 等一律不可下载。
ALLOWED_SUFFIXES = {".html", ".htm", ".css", ".js", ".mjs", ".json", ".md", ".svg", ".ico", ".png", ".webmanifest"}
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
        if any(part.startswith(".") or part.lower() in DENIED_SEGMENTS for part in parts):
            return False
        # 顶层单文件：按后缀白名单放行；其他子目录一律拒绝。
        if len(parts) == 1:
            return Path(parts[0]).suffix.lower() in ALLOWED_SUFFIXES
        # vendor/ 下的本地依赖（如 pdf.js）允许深层访问，仍受后缀白名单约束。
        return parts[0] == "vendor" and Path(parts[-1]).suffix.lower() in ALLOWED_SUFFIXES

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
        try:
            with zipfile.ZipFile(mxl_path) as archive:
                members = [name for name in archive.namelist()
                           if name.lower().endswith((".xml", ".musicxml")) and "meta-inf" not in name.lower()]
                if not members:
                    self.send_json(422, {"error": "Audiveris 导出的文件里没有找到 MusicXML。", "engine": "audiveris"})
                    return
                musicxml = archive.read(members[0]).decode("utf-8-sig")
        except zipfile.BadZipFile:
            self.send_json(422, {"error": "Audiveris 导出的压缩文件已损坏。", "engine": "audiveris"})
            return
        self.send_json(200, {"musicxml": musicxml, "engine": "audiveris"})

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


server = ThreadingHTTPServer(("127.0.0.1", 0), ProjectHandler)
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
