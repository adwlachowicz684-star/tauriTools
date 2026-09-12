// 零依赖生成 Tauri 所需图标：手写 PNG + ICO/ICNS 封装
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const T = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  T[n] = c;
}
const crc32 = (b) => { let c = -1; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  // 三个「节点」方块 + 连线，呼应工作流编排
  const boxes = [
    { x: 0.16, y: 0.22, w: 0.22, h: 0.18 },
    { x: 0.58, y: 0.41, w: 0.22, h: 0.18 },
    { x: 0.16, y: 0.60, w: 0.22, h: 0.18 },
  ];
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // 背景：蓝紫渐变
      let r = Math.round(76 + (124 - 76) * v);
      let g = Math.round(141 + (58 - 141) * v);
      let b = Math.round(255 + (237 - 255) * v);
      let a = 255;
      // 连线
      if (Math.abs(v - 0.5) < 0.012 && u > 0.27 && u < 0.69) { r = 255; g = 255; b = 255; a = 220; }
      for (const bx of boxes) {
        if (u >= bx.x && u <= bx.x + bx.w && v >= bx.y && v <= bx.y + bx.h) { r = 255; g = 255; b = 255; a = 255; }
      }
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(pngBuf, size) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngBuf.length, 8); e.writeUInt32LE(22, 12);
  return Buffer.concat([dir, e, pngBuf]);
}

function icns(pngBuf) {
  const inner = Buffer.concat([Buffer.from('ic08'), Buffer.alloc(4), pngBuf]);
  inner.writeUInt32BE(inner.length, 4);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(inner.length + 8, 4);
  return Buffer.concat([head, inner]);
}

const dir = 'src-tauri/icons';
mkdirSync(dir, { recursive: true });
const p32 = png(32), p128 = png(128), p256 = png(256);
writeFileSync(`${dir}/32x32.png`, p32);
writeFileSync(`${dir}/128x128.png`, p128);
writeFileSync(`${dir}/128x128@2x.png`, p256);
writeFileSync(`${dir}/icon.ico`, ico(p256, 256));
writeFileSync(`${dir}/icon.icns`, icns(p128));
console.log('图标已生成到', dir);
