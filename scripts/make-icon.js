// Genera build/icon.ico (256x256, BGRA de 32 bits) sin dependencias externas.
// Dibuja el prompt ">_" sobre una tarjeta redondeada oscura.
const fs = require('fs');
const path = require('path');

const SIZE = 256;
const SS = 4; // supersampling para bordes suaves

const COLORS = {
  card: [0x12, 0x16, 0x1f],
  border: [0x2f, 0x39, 0x4b],
  chevron: [0xff, 0xb4, 0x54],
  bar: [0x5c, 0xcf, 0xe6],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/** Color del icono en coordenadas continuas, o null si es transparente. */
function shade(x, y) {
  const box = sdRoundedBox(x, y, 128, 128, 122, 122, 46);
  if (box > 0) return null;
  if (box > -4) return COLORS.border;

  const chevron = Math.min(
    sdCapsule(x, y, 80, 82, 132, 128, 11),
    sdCapsule(x, y, 132, 128, 80, 174, 11)
  );
  if (chevron <= 0) return COLORS.chevron;
  if (sdRoundedBox(x, y, 174, 170, 32, 8, 5) <= 0) return COLORS.bar;
  return COLORS.card;
}

function renderPixels() {
  // BGRA, de abajo hacia arriba (formato DIB).
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const samples = SS * SS;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; hits++;
        }
      }
      const off = ((SIZE - 1 - y) * SIZE + x) * 4;
      if (!hits) continue;
      px[off] = Math.round(b / hits);
      px[off + 1] = Math.round(g / hits);
      px[off + 2] = Math.round(r / hits);
      px[off + 3] = Math.round((hits / samples) * 255);
    }
  }
  return px;
}

function buildIco() {
  const pixels = renderPixels();
  const maskRowBytes = Math.ceil(SIZE / 8 / 4) * 4;
  const mask = Buffer.alloc(maskRowBytes * SIZE); // todo 0 = opaco segun el canal alfa

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(SIZE, 4);
  header.writeInt32LE(SIZE * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(pixels.length + mask.length, 20);

  const image = Buffer.concat([header, pixels, mask]);

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // 0 = 256 px
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(6 + 16, 12);

  return Buffer.concat([dir, entry, image]);
}

const out = path.resolve(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildIco());
console.log(`[icon] escrito ${out} (${fs.statSync(out).size} bytes)`);
