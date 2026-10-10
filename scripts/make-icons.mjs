import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 512;

const OUT_DIR = new URL("../src-tauri/icons/", import.meta.url).pathname.replace(/^\//, "");

function crc32(buffer) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function toPng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 圆角方形的带符号距离，负值在内。 */
function roundedRectDistance(x, y, half, radius) {
  const qx = Math.abs(x) - half + radius;
  const qy = Math.abs(y) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function smooth(edge, value) {
  const t = Math.max(0, Math.min(1, (value + edge) / (edge + edge)));
  return t * t * (3 - 2 * t);
}

/**
 * 大写字母 F 的骨架，0..1 归一化：三笔同宽，竖笔贯通上下，中横比上横短一档。
 * 标题栏那颗矢量标记用的是同一套数（乘到 24 的画框上）。
 */
const F = {
  weight: 0.13,
  left: 0.25,
  right: 0.75,
  middle: 0.67,
  top: 0.15,
  bottom: 0.85,
  midY: 0.42,
};

/**
 * 画一枚 size×size 的 RGBA。坐标用 0..1 归一化，缩到任何尺寸都是同一个图形。
 * 图形：蓝色渐变的圆角方块 + 白色大写字母 F（竖笔、上横、中横三笔同宽）。
 */
function raster(size) {
  const buffer = Buffer.alloc(size * size * 4);
  const half = 0.46;
  const radius = 0.2;
  const feather = 0.012;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      const sd = roundedRectDistance(x - 0.5, y - 0.5, half, radius);
      const cover = 1 - smooth(feather, sd);
      const offset = (py * size + px) * 4;
      if (cover <= 0.002) {
        buffer[offset + 3] = 0;
        continue;
      }

      const t = y;
      let r = 37 + t * 12;
      let g = 99 + t * 24;
      let b = 235 - t * 20;

      const glass = 1 - Math.min(1, Math.hypot(x - 0.3, y - 0.24) / 0.95);
      r += glass * 26;
      g += glass * 26;
      b += glass * 20;

      const stem = x >= F.left && x <= F.left + F.weight && y >= F.top && y <= F.bottom;
      const topBar = x >= F.left && x <= F.right && y >= F.top && y <= F.top + F.weight;
      const midBar = x >= F.left && x <= F.middle && y >= F.midY && y <= F.midY + F.weight;
      if (stem || topBar || midBar) {
        r = 255;
        g = 255;
        b = 255;
      }

      buffer[offset] = Math.min(255, Math.round(r));
      buffer[offset + 1] = Math.min(255, Math.round(g));
      buffer[offset + 2] = Math.min(255, Math.round(b));
      buffer[offset + 3] = Math.round(cover * 255);
    }
  }
  return buffer;
}

/** windres 只认未压缩 DIB，这里输出 BITMAPINFOHEADER + 32bpp BGRA + 1bpp AND 掩码。 */
function toBmpIconImage(size, rgba) {
  const pixels = size * size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = maskRowBytes * size;
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  info.writeUInt32LE(0, 16);
  info.writeUInt32LE(pixels + mask, 20);

  const body = Buffer.alloc(pixels + mask);
  // DIB 自底向上存放。
  for (let y = 0; y < size; y += 1) {
    const sourceRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const from = sourceRow + x * 4;
      const to = y * size * 4 + x * 4;
      body[to] = rgba[from + 2];
      body[to + 1] = rgba[from + 1];
      body[to + 2] = rgba[from];
      body[to + 3] = rgba[from + 3];
      // AND 掩码：1 表示该位不属于图标。
      const maskByte = y * maskRowBytes + Math.floor(x / 8);
      if (rgba[from + 3] < 128) body[pixels + maskByte] |= 1 << (7 - (x % 8));
    }
  }
  return Buffer.concat([info, body]);
}

function toIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = 6 + images.length * 16;
  images.forEach((image, index) => {
    const entry = index * 16;
    directory[entry] = image.size < 256 ? image.size : 0;
    directory[entry + 1] = image.size < 256 ? image.size : 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.bytes.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.bytes.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.bytes)]);
}

mkdirSync(OUT_DIR, { recursive: true });

const images = ICON_SIZES.map((size) => ({ size, bytes: toBmpIconImage(size, raster(size)) }));
writeFileSync(`${OUT_DIR}icon.ico`, toIco(images));
writeFileSync(`${OUT_DIR}icon.png`, toPng(PNG_SIZE, raster(PNG_SIZE)));
for (const size of [32, 128]) writeFileSync(`${OUT_DIR}${size}x${size}.png`, toPng(size, raster(size)));

console.log(
  `icons written to ${OUT_DIR}: icon.ico (${images.length} sizes), icon.png, 32x32.png, 128x128.png`
);
