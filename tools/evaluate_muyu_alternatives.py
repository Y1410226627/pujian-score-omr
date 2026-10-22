# -*- coding: utf-8 -*-
"""用 GitHub API 列出候选目录的真实文件名，下载并测量。

避免手写文件名导致 404。
"""
import json
import struct
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / ".cache" / "audio-analysis" / "muyu-candidates"
WORK.mkdir(parents=True, exist_ok=True)

API = "https://api.github.com/repos/sgossner/VCSL/contents/"
RAW = "https://raw.githubusercontent.com/sgossner/VCSL/master/"

FOLDERS = ["Claves", "Slapstick", "Cajon", "Slit Drum", "Woodblock", "Cowbells", "Ratchet"]


def list_wav(folder):
    url = API + urllib.parse.quote(f"Idiophones/Struck Idiophones/{folder}")
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return [item["name"] for item in payload
            if item.get("type") == "file" and item["name"].lower().endswith(".wav")]


def download(folder, name):
    target = WORK / f"{folder}__{name}"
    if target.exists() and target.stat().st_size > 1000:
        return target
    url = RAW + urllib.parse.quote(f"Idiophones/Struck Idiophones/{folder}/{name}")
    with urllib.request.urlopen(url, timeout=120) as response:
        target.write_bytes(response.read())
    return target


def measure(path):
    data = path.read_bytes()
    channels = struct.unpack_from("<H", data, 22)[0]
    rate = struct.unpack_from("<I", data, 24)[0]
    bits = struct.unpack_from("<H", data, 34)[0]
    index = data.find(b"data")
    if index < 0:
        return None
    size = struct.unpack_from("<I", data, index + 4)[0]
    start = index + 8
    frames = size // (channels * (bits // 8))
    width = bits // 8
    peak = 0.0
    total = 0.0
    for i in range(frames):
        value = 0.0
        for c in range(channels):
            offset = start + (i * channels + c) * width
            if bits == 16:
                value += struct.unpack_from("<h", data, offset)[0] / 32768
            elif bits == 24:
                raw = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
                value += (raw - (1 << 24) if raw >= 1 << 23 else raw) / 8388608
        value /= channels
        total += value * value
        if abs(value) > peak:
            peak = abs(value)
    return {"rms": (total / max(1, frames)) ** 0.5, "peak": peak,
            "seconds": frames / rate, "rate": rate}


rows = []
for folder in FOLDERS:
    try:
        names = list_wav(folder)
    except Exception as error:  # noqa: BLE001
        print(f"{folder}: 列目录失败 {error}")
        continue
    print(f"=== {folder}（{len(names)} 个 wav）===")
    folder_rows = []
    for name in names:
        try:
            path = download(folder, name)
            stats = measure(path)
            if not stats:
                continue
            folder_rows.append({"folder": folder, "file": name, **{k: round(v, 6) for k, v in stats.items()}})
        except Exception as error:  # noqa: BLE001
            print(f"  {name}: 失败 {str(error)[:60]}")
    folder_rows.sort(key=lambda item: -item["rms"])
    for row in folder_rows[:6]:
        print(f"  {row['file'][:42]:44s} RMS {row['rms']:.5f}  峰值 {row['peak']:.4f}  {row['seconds']:.2f}s")
    rows.extend(folder_rows)
    print()

(WORK / "alternatives.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
print(f"共测 {len(rows)} 个，已写出 alternatives.json")
