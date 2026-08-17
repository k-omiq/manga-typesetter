// Generates the app icon from one definition: an SVG for the repo and a
// 1024x1024 PNG for `tauri icon` to fan out into every platform size.
//
// Hand-rolled rasterizer rather than a dependency: the art is a rounded square
// and one straight-edged polygon, both of which a scanline fill with 4x4
// supersampling draws exactly, and adding a native SVG renderer to a desktop
// app's build chain for one file is a poor trade.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;
const SS = 4; // supersampling factor per axis

// macOS rounds its app icons with a superellipse; a plain rounded rect at this
// radius is within a pixel or two of it at icon sizes and needs no curve
// rasterizer. The 1024 canvas is 100% of the tile, so the art is inset the way
// Apple's own template insets it (~10%) rather than filling the corners.
const MARGIN = 100;
const RADIUS = 200;

// A dark tile with a light pointer, which is the way round that survives macOS.
//
// This was black-on-white first, and on macOS 26 in Dark appearance it read as
// nothing at all: the system applies an automatic dark treatment to a legacy
// .icns app icon, darkening the light tile, and a black pointer on a tile that
// has just been darkened has no contrast left. An app opts out of that by
// shipping an Icon Composer .icon asset carrying explicit light and dark
// artwork, which Tauri's bundler does not emit — it writes .icns and nothing
// else — so the artwork has to survive the treatment unaided.
//
// Light-on-dark does. A dark tile is already where the treatment is trying to
// take it, so the pointer keeps its contrast in Dark appearance, and in Light
// appearance the same icon reads as a crisp black tile rather than as a washed
// one. The cost is that this is the inverse of the black-pointer-on-white the
// icon started as; that version is one swap of these two constants away if
// Tauri ever grows .icon support.
const TILE = 0x11; // near-black, not pure black: a pure-black tile loses its
// rounded silhouette against a dark Dock, and this is dark enough that the
// system's treatment has nothing left to darken.
const INK = 0xff;

// The classic arrow cursor, in its own 24x24 space, tip at the origin. Straight
// edges only — every point is a line, so the fill below is exact.
const POINTER = [
  [0, 0], [0, 17.4], [4.7, 13.1], [7.7, 20.2], [10.6, 19.0],
  [7.7, 12.1], [13.4, 11.6],
];
const POINTER_BOX = 24;

// Scale the pointer to sit inside the white field, centred by its own bounding
// box rather than by its 24x24 frame: the arrow does not fill that frame, and
// centring the frame leaves the drawn shape visibly low and left.
function pointerPolygon() {
  const xs = POINTER.map((p) => p[0]);
  const ys = POINTER.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const field = SIZE - MARGIN * 2;
  const scale = (field * 0.62) / Math.max(maxX - minX, maxY - minY);
  const w = (maxX - minX) * scale;
  const h = (maxY - minY) * scale;
  const ox = (SIZE - w) / 2 - minX * scale;
  const oy = (SIZE - h) / 2 - minY * scale;
  return POINTER.map(([x, y]) => [x * scale + ox, y * scale + oy]);
}

const poly = pointerPolygon();

function insidePolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideRoundRect(px, py) {
  const x0 = MARGIN, y0 = MARGIN, x1 = SIZE - MARGIN, y1 = SIZE - MARGIN;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + RADIUS), x1 - RADIUS);
  const cy = Math.min(Math.max(py, y0 + RADIUS), y1 - RADIUS);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

// One pass, 16 samples per pixel: coverage of the white field becomes alpha,
// coverage of the pointer darkens within it. Compositing at sample level rather
// than layer level keeps the pointer's edge clean against the white instead of
// blending twice.
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let field = 0, ink = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (!insideRoundRect(px, py)) continue;
        field++;
        if (insidePolygon(px, py, poly)) ink++;
      }
    }
    const n = SS * SS;
    const i = (y * SIZE + x) * 4;
    const alpha = field / n;
    // Ink is expressed as a value, not as a second alpha: the pixel is the
    // opaque tile colour where the field is covered and shades toward the
    // pointer's colour as the pointer takes it, so a partially-covered edge
    // pixel carries one honest colour.
    const v = field ? Math.round(TILE + (INK - TILE) * (ink / field)) : TILE;
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
    rgba[i + 3] = Math.round(alpha * 255);
  }
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // truecolour with alpha
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const hex = (v) => '#' + v.toString(16).padStart(2, '0').repeat(3);

const [outPng, outSvg] = process.argv.slice(2);
writeFileSync(outPng, png);

const pts = poly.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
writeFileSync(
  outSvg,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <title>Manga Typesetter</title>
  <rect x="${MARGIN}" y="${MARGIN}" width="${SIZE - MARGIN * 2}" height="${SIZE - MARGIN * 2}" rx="${RADIUS}" ry="${RADIUS}" fill="${hex(TILE)}"/>
  <polygon points="${pts}" fill="${hex(INK)}"/>
</svg>
`,
);
console.log('wrote', outPng, outSvg);
