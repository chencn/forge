import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

/** Windows ICO 中包含的显示尺寸，单位为像素。 */
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** 应用通用 PNG 的边长，单位为像素。 */
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

/** 项目默认蓝色的 RGB 通道，与工作台强调色 #3871e1 一致。 */
const BRAND_RGB = [56, 113, 225];
/** 256 单位画布中的底板；圆角按左上、右上、右下、左下排序。 */
const TILE = { x: 8, y: 8, width: 240, height: 240, radii: [56, 56, 56, 56] };
/** 分区 F 的三块实体；SVG 与位图共用此几何，防止重新生成后造型漂移。 */
const F = [
  { x: 62, y: 56, width: 40, height: 144, radii: [8, 0, 8, 8] },
  { x: 118, y: 56, width: 74, height: 38, radii: [0, 8, 8, 0] },
  { x: 118, y: 110, width: 54, height: 38, radii: [0, 8, 8, 0] },
];

/**
 * 判断采样点是否位于指定圆角矩形内。
 * @param {number} x - 画布中的横坐标
 * @param {number} y - 画布中的纵坐标
 * @param {typeof TILE} rect - 矩形边界与四角半径
 * @returns {boolean} 点在边界上或内部时为 true
 */
function contains(x, y, rect) {
  /** 相对于矩形中心的横向距离。 */
  const dx = x - rect.x - rect.width / 2;
  /** 相对于矩形中心的纵向距离。 */
  const dy = y - rect.y - rect.height / 2;
  /** 采样点所属象限的圆角半径。 */
  const radius = rect.radii[dy < 0 ? (dx < 0 ? 0 : 1) : (dx < 0 ? 3 : 2)];
  /** 去掉中央直边区域后的横向距离。 */
  const qx = Math.abs(dx) - rect.width / 2 + radius;
  /** 去掉中央直边区域后的纵向距离。 */
  const qy = Math.abs(dy) - rect.height / 2 + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= radius;
}

/**
 * 将同一矩形几何转换为闭合 SVG 路径。
 * @param {typeof TILE} rect - 矩形边界与四角半径
 * @returns {string} 保留直角和圆角的实体轮廓
 */
function rectanglePath(rect) {
  /** 四个圆角的顺时针半径。 */
  const [tl, tr, br, bl] = rect.radii;
  /** 矩形右边界。 */
  const right = rect.x + rect.width;
  /** 矩形下边界。 */
  const bottom = rect.y + rect.height;
  return `M${rect.x + tl} ${rect.y}H${right - tr}`
    + (tr ? `A${tr} ${tr} 0 0 1 ${right} ${rect.y + tr}` : `L${right} ${rect.y}`)
    + `V${bottom - br}`
    + (br ? `A${br} ${br} 0 0 1 ${right - br} ${bottom}` : `L${right} ${bottom}`)
    + `H${rect.x + bl}`
    + (bl ? `A${bl} ${bl} 0 0 1 ${rect.x} ${bottom - bl}` : `L${rect.x} ${bottom}`)
    + `V${rect.y + tl}`
    + (tl ? `A${tl} ${tl} 0 0 1 ${rect.x + tl} ${rect.y}` : `L${rect.x} ${rect.y}`)
    + 'Z';
}

/**
 * 按每像素 4×4 次采样绘制蓝底白色分区 F。
 * @param {number} size - 输出边长，单位为像素
 * @returns {Buffer} RGBA 像素；透明边缘按预乘颜色累计，避免缩小后出现黑边
 */
function raster(size) {
  /** 当前尺寸的透明像素缓冲区。 */
  const buffer = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      /** 覆盖底板的采样数。 */
      let coverage = 0;
      /** 覆盖白色字形的采样数。 */
      let white = 0;
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          /** 映射到矢量画布的采样横坐标。 */
          const x = (px + (sx + 0.5) / 4) * 256 / size;
          /** 映射到矢量画布的采样纵坐标。 */
          const y = (py + (sy + 0.5) / 4) * 256 / size;
          if (!contains(x, y, TILE)) continue;
          coverage += 1;
          if (F.some((rect) => contains(x, y, rect))) white += 1;
        }
      }
      if (coverage === 0) continue;
      /** 当前输出像素的首通道偏移量。 */
      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        buffer[offset + channel] = Math.round((BRAND_RGB[channel] * (coverage - white) + 255 * white) / coverage);
      }
      buffer[offset + 3] = Math.round(coverage * 255 / 16);
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

/** 标题栏直接使用的 SVG 母稿，与所有位图共用底板和三块字形。 */
const svg = `<!-- Forge 分区 F：由 scripts/make-icons.mjs 的共享几何生成。 -->
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-labelledby="forge-title">
  <title id="forge-title">Forge</title>
  <path fill="#3871e1" d="${rectanglePath(TILE)}"/>
  <path fill="#ffffff" d="${F.map(rectanglePath).join(' ')}"/>
</svg>
`;
writeFileSync(`${OUT_DIR}icon.svg`, svg);
/** 保留未压缩 DIB 格式供 Windows 资源编译器读取。 */
const images = ICON_SIZES.map((size) => ({ size, bytes: toBmpIconImage(size, raster(size)) }));
writeFileSync(`${OUT_DIR}icon.ico`, toIco(images));
writeFileSync(`${OUT_DIR}icon.png`, toPng(PNG_SIZE, raster(PNG_SIZE)));
for (const size of [32, 128]) writeFileSync(`${OUT_DIR}${size}x${size}.png`, toPng(size, raster(size)));
for (const size of [44, 50, 150]) writeFileSync(`${OUT_DIR}Square${size}x${size}Logo.png`, toPng(size, raster(size)));

console.log(
  `icons written to ${OUT_DIR}: icon.svg, icon.ico (${images.length} sizes), icon.png, 32x32.png, 128x128.png, Square{44,50,150}x{44,50,150}Logo.png`
);
