// 直接测量 WAV 文件的原始电平（不经过播放链），定位异常样本
import { readFileSync } from "node:fs";

function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const frames = Math.floor((bytes.byteLength - 44) / (channels * (bits / 8)));
  const width = bits / 8;
  let sum = 0;
  let peak = 0;
  let count = 0;
  for (let i = 0; i < frames; i += 1) {
    let value = 0;
    for (let c = 0; c < channels; c += 1) {
      const offset = 44 + (i * channels + c) * width;
      if (bits === 16) value += view.getInt16(offset, true) / 32768;
      else if (bits === 24) {
        const raw = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
        value += (raw >= 1 << 23 ? raw - (1 << 24) : raw) / 8388608;
      } else if (bits === 8) value += (view.getUint8(offset) - 128) / 128;
    }
    value /= channels;
    sum += value * value;
    const absolute = Math.abs(value);
    if (absolute > peak) peak = absolute;
    count += 1;
  }
  return { rate, channels, bits, frames, rms: Math.sqrt(sum / Math.max(1, count)), peak, seconds: frames / rate };
}

const files = process.argv.slice(2);
for (const file of files) {
  try {
    const info = decodeWav(readFileSync(file));
    console.log(`${file.split(/[\\/]/).slice(-2).join("/")}: RMS ${info.rms.toFixed(5)}  峰值 ${info.peak.toFixed(4)}  ${info.seconds.toFixed(2)}s  ${info.rate}Hz ${info.bits}bit`);
  } catch (error) {
    console.log(`${file}: 失败 ${error.message}`);
  }
}
