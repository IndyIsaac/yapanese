'use strict';

const { nativeImage } = require('electron');

/**
 * Tray icons are drawn as raw bitmaps rather than shipped as assets, so the
 * state colour is generated rather than maintained as three PNG files.
 *
 * The mark is the same microphone as the app icon — capsule, cradle arc and
 * stem — so the tray, the taskbar and the installer all read as one app. It
 * survives 16px: the capsule and the arc under it are distinguishable even
 * when the stem is barely a pixel.
 *
 * Colours match the overlay's state language, so the tray says the same
 * thing the pill does: red while recording, violet while transcribing.
 */
const COLORS = {
  idle:         [0xb4, 0xb4, 0xc2],
  recording:    [0xf0, 0x61, 0x6d],
  transcribing: [0x7c, 0x6c, 0xf0],
};

const cache = new Map();

/** Distance from a point to a line segment. */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Distance to a circular arc with round caps, which is what the cradle is.
 * Inside the swept angle it is the distance to the circle; outside it, the
 * distance to whichever end point is nearer.
 */
function sdArc(px, py, cx, cy, radius, from, to) {
  let a = Math.atan2(py - cy, px - cx);
  if (a < 0) a += Math.PI * 2;
  if (a >= from && a <= to) return Math.abs(Math.hypot(px - cx, py - cy) - radius);
  const ax = cx + Math.cos(from) * radius;
  const ay = cy + Math.sin(from) * radius;
  const bx = cx + Math.cos(to) * radius;
  const by = cy + Math.sin(to) * radius;
  return Math.min(Math.hypot(px - ax, py - ay), Math.hypot(px - bx, py - by));
}

function draw(size, [r, g, b]) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;

  // Proportions taken from the app icon so the two marks match.
  const capW = size * 0.34;
  const capH = size * 0.50;
  const capR = capW / 2;
  const capTop = size * 0.10;
  const capA = capTop + capR;
  const capB = capTop + capH - capR;

  const arcR = size * 0.31;
  const arcY = size * 0.545;
  const stroke = Math.max(0.62, size * 0.0475);   // half the line width

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sample at pixel centres, otherwise the mark sits half a pixel high.
      const px = x + 0.5;
      const py = y + 0.5;

      const d = Math.min(
        sdSegment(px, py, cx + 0.5, capA, cx + 0.5, capB) - capR,
        sdArc(px, py, cx + 0.5, arcY, arcR, Math.PI * 0.16, Math.PI * 0.84) - stroke,
        sdSegment(px, py, cx + 0.5, size * 0.855, cx + 0.5, size * 0.93) - stroke
      );

      // One-pixel coverage band either side of the edge.
      const alpha = Math.max(0, Math.min(1, 0.5 - d));

      const i = (y * size + x) * 4;
      buf[i] = b;         // Windows bitmaps are BGRA
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

function makeTrayIcon(state = 'idle') {
  if (cache.has(state)) return cache.get(state);

  const color = COLORS[state] || COLORS.idle;

  const img = nativeImage.createEmpty();
  for (const size of [16, 32]) {
    img.addRepresentation({
      width: size,
      height: size,
      scaleFactor: size / 16,
      buffer: draw(size, color),
    });
  }

  cache.set(state, img);
  return img;
}

module.exports = { makeTrayIcon, draw, COLORS };
