# -*- coding: utf-8 -*-
"""下载 VCSL Woodblock 候选样本，测量原始电平，挑合适的替换木鱼。"""
import base64
import json
import struct
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / ".cache" / "audio-analysis" / "muyu-candidates"
WORK.mkdir(parents=True, exist_ok=True)

BASE = "https://raw.githubusercontent.com/sgossner/VCSL/master/"
PATH = "Idiophones/Struck Idiophones/Woodblock/"

# 当前在用的三个 + 候选
CANDIDATES = [
    "wood_click_pp_rr1.wav",     # 当前 soft
    "wood_click3_vl1.wav",       # 当前 medium
    "wood_click_ff.wav",         # 当前 loud
    "wood_click_pp_rr2.wav",
    "wood_click_pp_rr3.wav",
    "wood_click_mp.wav",
    "wood_click2_mp.wav",
    "wood_click3_vl2.wav",
    "wood_click_f_rr1.wav",
    "wood_click_f_rr2.wav",
]


def download(name):
    target = WORK / name
    if target.exists() and target.stat().st_size > 1000:
        return target
    url = BASE + PATH.replace(" ", "%20") + name.replace(" ", "%20")
    with urllib.request.urlopen(url, timeout=120) as response:
        target.write_bytes(response.read())
    return target


def read_wav(path):
    data = path.read_bytes()
    channels = struct.unpack_from("<H", data, 22)[0]
    rate = struct.unpack_from("<I", data, 24)[0]
    bits = struct.unpack_from("<H", data, 34)[0]
    # 找 data 块
    index = data.find(b"data")
    if index < 0:
        return None
    size = struct.unpack_from("<I", data, index + 4)[0]
    start = index + 8
    frames = size // (channels * (bits // 8))
    width = bits // 8
    values = []
    for i in range(frames):
        value = 0.0
        for c in range(channels):
            offset = start + (i * channels + c) * width
            if bits == 16:
                value += struct.unpack_from("<h", data, offset)[0] / 32768
            elif bits == 24:
                raw = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
                value += (raw - (1 << 24) if raw >= 1 << 23 else raw) / 8388608
        values.append(value / channels)
    return {"rate": rate, "channels": channels, "bits": bits, "values": values}


def measure(info):
    values = info["values"]
    peak = max(abs(v) for v in values)
    rms = (sum(v * v for v in values) / len(values)) ** 0.5
    return {"peak": round(peak, 5), "rms": round(rms, 6), "seconds": round(len(values) / info["rate"], 2)}


rows = []
for name in CANDIDATES:
    try:
        path = download(name)
        info = read_wav(path)
        if not info:
            print(f"  {name}: 无法解析")
            continue
        stats = measure(info)
        rows.append({"name": name, **stats})
        print(f"  {name:26s} RMS {stats['rms']:.6f}  峰值 {stats['peak']:.4f}  {stats['seconds']}s  {info['rate']}Hz")
    except Exception as error:  # noqa: BLE001
        print(f"  {name}: 失败 {error}")

(WORK / "levels.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
print()
print("已写出", WORK / "levels.json")
