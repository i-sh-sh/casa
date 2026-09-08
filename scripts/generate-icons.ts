import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

/** Converts RGBA pixels to a valid uncompressed/deflated PNG buffer in pure Node.js */
function createPng(width: number, height: number, draw: (x: number, y: number) => [number, number, number]): Buffer {
  const rowSize = width * 3 + 1;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = draw(x / width * 64, y / height * 64);
      const pxOffset = rowOffset + 1 + x * 3;
      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
    }
  }

  const compressed = deflateSync(rawData);

  // PNG Header
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth: 8
  ihdrData[9] = 2; // Color type: 2 (RGB)
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method
  const ihdrChunk = createChunk('IHDR', ihdrData);

  // IDAT chunk
  const idatChunk = createChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([header, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type: string, data: Buffer): Buffer {
  const len = data.length;
  const buf = Buffer.alloc(8 + len + 4);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, 'ascii');
  data.copy(buf, 8);
  const crc = crc32(buf.subarray(4, 8 + len));
  buf.writeUInt32BE(crc, 8 + len);
  return buf;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Icon rendering matching icon.svg (64x64 coordinate space)
function drawIcon(x: number, y: number): [number, number, number] {
  // Background (#f2ede3)
  const bg: [number, number, number] = [0xf2, 0xed, 0xe3];
  const ink: [number, number, number] = [0x1a, 0x1a, 0x17];
  const lineGrey: [number, number, number] = [0xa9, 0xb4, 0xbd];
  const lineRed: [number, number, number] = [0xa8, 0x32, 0x1e];

  // Outer rect: x: 10..54, y: 7..57, stroke 3px
  const inOuterH = (x >= 8.5 && x <= 55.5) && ((y >= 5.5 && y <= 8.5) || (y >= 55.5 && y <= 58.5));
  const inOuterV = (y >= 5.5 && y <= 58.5) && ((x >= 8.5 && x <= 11.5) || (x >= 52.5 && x <= 55.5));
  if (inOuterH || inOuterV) return ink;

  // Vertical line at x: 40 (3px wide)
  if (y >= 5.5 && y <= 58.5 && x >= 38.5 && x <= 41.5) return ink;

  // Blue-grey horizontal lines at y=20, 28, 36 (x: 17..33, 2.5px wide)
  if (x >= 15.5 && x <= 34.5) {
    if (Math.abs(y - 20) <= 1.25 || Math.abs(y - 28) <= 1.25 || Math.abs(y - 36) <= 1.25) {
      return lineGrey;
    }
    // Red line at y=44
    if (Math.abs(y - 44) <= 1.25) {
      return lineRed;
    }
  }

  // Double rule at y=44 and y=48 (x: 44..50)
  if (x >= 42.5 && x <= 51.5) {
    if (Math.abs(y - 44) <= 1.25 || Math.abs(y - 48) <= 1.25) {
      return ink;
    }
  }

  return bg;
}

const root = resolve(process.cwd());
const sizes = [
  { name: 'icon-180.png', size: 180 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
];

for (const { name, size } of sizes) {
  const png = createPng(size, size, drawIcon);
  writeFileSync(resolve(root, 'public', name), png);
  console.log(`✔ Generated public/${name} (${size}x${size})`);
}
