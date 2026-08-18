'use strict';

const { nativeImage } = require('electron');

/**
 * Tray icons are drawn as raw bitmaps rather than shipped as assets, so the
 * state colour is generated rather than maintained as three PNG files.
 *
 * A microphone glyph turns to mush at 16px, so the mark is a ring with a
 * filled centre — read as a status lamp, which is what it actually is.
 */
const COLORS = {
  idle:         [0xb4, 0xb4, 0xc2],
  recording:    [0x6d, 0x61, 0xf0],
  transcribing: [0x7c, 0x6c, 0xf0],
};

const cache = new Map();

function draw(size, [r, g, b], filled) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = size * 0.30;
  const dot = size * 0.17;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);

      // Ring, then the centre dot. `cov` is crude coverage antialiasing over
      // a one-pixel band, which is enough at these sizes.
      let alpha = 0;
      if (d <= outer && d >= inner) alpha = Math.min(1, outer - d, d - inner + 1);
      if (d <= dot) alpha = Math.max(alpha, Math.min(1, dot - d + 0.5));
      if (filled && d <= inner) alpha = Math.max(alpha, Math.min(1, inner - d + 0.5) * 0.9);

      const i = (y * size + x) * 4;
      const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
      buf[i] = b;         // Windows bitmaps are BGRA
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
  return buf;
}

function makeTrayIcon(state = 'idle') {
  if (cache.has(state)) return cache.get(state);

  const color = COLORS[state] || COLORS.idle;
  const filled = state === 'recording';

  const img = nativeImage.createEmpty();
  for (const size of [16, 32]) {
    img.addRepresentation({
      width: size,
      height: size,
      scaleFactor: size / 16,
      buffer: draw(size, color, filled),
    });
  }

  cache.set(state, img);
  return img;
}

module.exports = { makeTrayIcon };
