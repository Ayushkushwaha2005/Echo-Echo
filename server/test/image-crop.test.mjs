/* The crop tool's geometry (packages/ui/image-crop.js): the frame keeps the
   chosen shape, never leaves the image, and zoom shrinks it about the centre. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRect, ASPECTS } from '../../packages/ui/image-crop.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test('the largest frame of the chosen shape, centred', () => {
  const r = cropRect({ imgW: 4000, imgH: 3000, ratio: ASPECTS.square.ratio });
  assert.deepEqual(r, { x: 500, y: 0, w: 3000, h: 3000 });
  const w = cropRect({ imgW: 1000, imgH: 1000, ratio: ASPECTS.wide.ratio });
  close(w.w / w.h, 16 / 9); close(w.w, 1000);
  const o = cropRect({ imgW: 1200, imgH: 800, ratio: ASPECTS.free.ratio });
  assert.deepEqual(o, { x: 0, y: 0, w: 1200, h: 800 }, 'Original keeps the whole image');
});

test('zoom shrinks the frame; positioning never leaves the image', () => {
  const z = cropRect({ imgW: 2000, imgH: 2000, ratio: 1, zoom: 2 });
  assert.deepEqual(z, { x: 500, y: 500, w: 1000, h: 1000 });
  for (const [cx, cy] of [[-5, -5], [5, 5], [0, 1], [1, 0]]) {
    const r = cropRect({ imgW: 2000, imgH: 1500, ratio: 4 / 3, zoom: 3, cx, cy });
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 2000 + 1e-9 && r.y + r.h <= 1500 + 1e-9, JSON.stringify(r));
    close(r.w / r.h, 4 / 3);
  }
});
