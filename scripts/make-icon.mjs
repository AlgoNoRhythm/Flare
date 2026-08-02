/**
 * Generate build/icon.png — the source electron-builder derives .ico and .icns
 * from, and the icon Linux installs verbatim.
 *
 * Written by hand rather than pulled from a design tool so the mark is in the
 * repo and regenerable: no binary blob nobody can edit. Pure Node, no image
 * dependency — a PNG is a zlib stream with a header, and the drawing is a
 * coverage field stamped along a few Bézier curves.
 *
 * The mark: one node with edges departing, curved rather than straight, so the
 * dependency graph reads as a flare. Run `npm run icon` after changing it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// ICON_SIZE renders a small preview, to check the mark survives a taskbar
const SIZE = Number(process.env.ICON_SIZE) || 1024;

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const BG_TOP = hex('#1d2331');
const BG_BOT = hex('#0d1015');
const RIM = hex('#2d3543');
/** Rays run hot at the core and cool as they travel — heat leaving a source. */
const RAY_HOT = hex('#ffd9a0');
const RAY_MID = hex('#e8a33f');
const RAY_TIP = hex('#c2603a');
const CORE = hex('#fffaf0');
const CORE_RING = hex('#e09434');
const TIP_NODE = hex('#f2c877');

/*
 * A small source, low and left, with everything sweeping up and out.
 *
 * Two earlier versions read as animals. Radial symmetry made a starfish:
 * equal arms in every direction is a creature, not a flare. Then a large
 * core with arms alternating their curve made a squid. What actually reads
 * as a flare is a *small* bright source, edges that are the dominant
 * element, and every one of them bending the same way — sweep, not reach.
 */
/*
 * Sized and placed so the mark fills the plate. The first version that read
 * correctly still sat small and right-of-centre, which at 32px left it looking
 * like a smudge in a large dark square.
 */
const SCALE = 1.16;
const CX = 0.295;
const CY = 0.575;
const MARGIN = 0.085;
const RADIUS = 0.235;

/** Is this point inside the rounded plate? */
function inPlate(x, y) {
  const lo = MARGIN;
  const hi = 1 - MARGIN;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + RADIUS), hi - RADIUS);
  const cy = Math.min(Math.max(y, lo + RADIUS), hi - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  if ((x < lo + RADIUS || x > hi - RADIUS) && (y < lo + RADIUS || y > hi - RADIUS)) {
    return dx * dx + dy * dy <= RADIUS * RADIUS;
  }
  return true;
}

/**
 * Each ray is a cubic curve leaving the core, bending as it goes. `bend`
 * decides which way and how hard; alternating signs stop the whole thing
 * looking like a pinwheel.
 */
const RAYS = [
  { angle: -72, len: 0.300, bend: 0.55, w: 0.020, tip: true },
  { angle: -42, len: 0.430, bend: 0.50, w: 0.023, tip: false },
  { angle: -14, len: 0.480, bend: 0.44, w: 0.021, tip: true },
  { angle: 14, len: 0.360, bend: 0.38, w: 0.017, tip: false },
];

function rayPoints(ray) {
  const a = (ray.angle * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  // perpendicular, for the bend
  const px = -uy;
  const py = ux;
  const len = ray.len * SCALE;
  const p0 = [CX + ux * 0.05, CY + uy * 0.05];
  const p3 = [CX + ux * len, CY + uy * len];
  const c1 = [
    p0[0] + ux * len * 0.35 + px * ray.bend * 0.10,
    p0[1] + uy * len * 0.35 + py * ray.bend * 0.10,
  ];
  const c2 = [
    p0[0] + ux * len * 0.72 + px * ray.bend * 0.22,
    p0[1] + uy * len * 0.72 + py * ray.bend * 0.22,
  ];
  return { p0, c1, c2, p3 };
}

function cubic(p0, c1, c2, p3, t) {
  const m = 1 - t;
  const a = m * m * m;
  const b = 3 * m * m * t;
  const c = 3 * m * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
  ];
}

// coverage (0..1) and heat (0 at core, 1 at tip) fields, in pixels
const cover = new Float32Array(SIZE * SIZE);
const heat = new Float32Array(SIZE * SIZE);

/**
 * Stamp a soft disc, keeping the highest coverage and the heat that came with
 * it.
 *
 * `force` exists for the core. Without it the core was drawn and then not
 * seen: it sits exactly where the rays converge at full coverage, and
 * "keep the higher coverage" is never true there, so the hot centre kept the
 * rays' colour and the node read as a flat amber ball.
 */
function stamp(cxp, cyp, rp, h, force = false) {
  const aa = 1.2;
  const x0 = Math.max(0, Math.floor(cxp - rp - aa));
  const x1 = Math.min(SIZE - 1, Math.ceil(cxp + rp + aa));
  const y0 = Math.max(0, Math.floor(cyp - rp - aa));
  const y1 = Math.min(SIZE - 1, Math.ceil(cyp + rp + aa));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cxp, y + 0.5 - cyp);
      const a = Math.max(0, Math.min(1, (rp + aa - d) / (2 * aa)));
      if (a <= 0) continue;
      const i = y * SIZE + x;
      if (force ? a > 0.02 : a > cover[i]) {
        cover[i] = Math.max(cover[i], a);
        heat[i] = h;
      }
    }
  }
}

for (const ray of RAYS) {
  const { p0, c1, c2, p3 } = rayPoints(ray);
  const steps = 340;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const [x, y] = cubic(p0, c1, c2, p3, t);
    // taper: wide at the core, drawn to a point
    // thick enough at the root to survive a 32px icon, drawn to a point
    const w = (ray.w * (1 - t) ** 1.05 + 0.0042) * SCALE;
    stamp(x * SIZE, y * SIZE, w * SIZE, t);
  }
  if (ray.tip) {
    const [x, y] = cubic(p0, c1, c2, p3, 1);
    stamp(x * SIZE, y * SIZE, 0.0195 * SCALE * SIZE, 1.15); // >1 marks a terminal node
  }
}

// the core last, so it sits over every ray root. Two discs, not one: a flat
// amber ball read as a ball, where a hot centre inside a rim reads as a node.
stamp(CX * SIZE, CY * SIZE, 0.050 * SCALE * SIZE, -1, true); // <0 marks the core ring
stamp(CX * SIZE, CY * SIZE, 0.030 * SCALE * SIZE, -2, true); // <-1 marks the core itself

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = y * SIZE + x;
    const o = i * 4;
    const fx = (x + 0.5) / SIZE;
    const fy = (y + 0.5) / SIZE;

    // plate coverage, antialiased by sampling the boundary at 3x3
    let plate = 0;
    for (let sy = 0; sy < 3; sy++) {
      for (let sx = 0; sx < 3; sx++) {
        if (inPlate((x + (sx + 0.5) / 3) / SIZE, (y + (sy + 0.5) / 3) / SIZE)) plate++;
      }
    }
    plate /= 9;
    if (plate === 0) continue;

    const t = (fy - MARGIN) / (1 - 2 * MARGIN);
    let col = mix(BG_TOP, BG_BOT, Math.max(0, Math.min(1, t)));

    // hairline of light on the plate edge
    const edge = Math.min(fx - MARGIN, 1 - MARGIN - fx, fy - MARGIN, 1 - MARGIN - fy);
    if (edge < 0.007) col = mix(col, RIM, 0.85);

    // a soft warm bloom around the core, so the flare sits in light
    const dCore = Math.hypot(fx - CX, fy - CY);
    const bloom = Math.max(0, 1 - dCore / 0.5) ** 2.2;
    col = mix(col, RAY_MID, bloom * 0.2);

    const c = cover[i];
    if (c > 0) {
      const h = heat[i];
      let ink;
      if (h <= -2) ink = CORE;
      else if (h < 0) ink = CORE_RING;
      else if (h > 1) ink = TIP_NODE;
      else ink = h < 0.5 ? mix(RAY_HOT, RAY_MID, h / 0.5) : mix(RAY_MID, RAY_TIP, (h - 0.5) / 0.5);
      col = mix(col, ink, c);
    }

    pixels[o] = Math.round(col[0]);
    pixels[o + 1] = Math.round(col[1]);
    pixels[o + 2] = Math.round(col[2]);
    pixels[o + 3] = Math.round(plate * 255);
  }
}

/* ---- PNG container ---- */
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // truecolour + alpha
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join('build', SIZE === 1024 ? 'icon.png' : `icon-${SIZE}.png`);
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} kB)`);
