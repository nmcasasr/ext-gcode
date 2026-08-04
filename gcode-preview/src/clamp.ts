// Overhang clamp: reshape a vase-like STL so no wall leans past a target angle
// from vertical. It slices the mesh into aligned contours, then walks bottom ->
// top limiting how far each point may sit from the wall directly below it
// (maxShift = layerHeight * tan(maxAngle)). Any point further than that is
// pulled toward its nearest support, so bulges AND aggressive twists get shaved
// into a printable shape. Re-lofted into a new STL.
//
// This matches the preview's overhang metric (perpendicular gap to the layer
// below), so it targets exactly the zones the heat map paints red. Assumes a
// single contour per layer (vase / cup / cone), like the vase slicer.

import { sliceMeshToLayers, Pt } from './contours';

export interface ClampOptions {
  layerHeight: number;
  resample: number;
  maxAngle: number; // degrees from vertical; walls steeper than this are pulled in
}

export const DEFAULT_CLAMP: ClampOptions = {
  layerHeight: 0.3,
  resample: 200,
  maxAngle: 45,
};

export interface ClampStats {
  layers: number;
  clampedPoints: number;
  totalPoints: number;
  maxPullMm: number;
}

export function clampOverhangs(
  tris: Float32Array,
  opts: ClampOptions = DEFAULT_CLAMP
): { stl: Buffer; stats: ClampStats } {
  const L = sliceMeshToLayers(tris, opts.layerHeight, opts.resample);
  const cx = (L.minX + L.maxX) / 2;
  const cy = (L.minY + L.maxY) / 2;
  const maxShift = opts.layerHeight * Math.tan((opts.maxAngle * Math.PI) / 180);
  const maxShift2 = maxShift * maxShift;

  const loops = L.loops.map((l) => l.map((p) => ({ x: p.x, y: p.y })));
  let clampedPoints = 0, totalPoints = 0, maxPull = 0;

  // Each layer is clamped against the layer below (already clamped), so the
  // constraint propagates upward and a bulge is progressively shaved to a cone.
  for (let i = 1; i < loops.length; i++) {
    const below = loops[i - 1];
    const loop = loops[i];
    for (let j = 0; j < loop.length; j++) {
      totalPoints++;
      const p = loop[j];
      // Nearest support point on the layer below.
      let qx = 0, qy = 0, best = Infinity;
      for (let k = 0; k < below.length; k++) {
        const d = (below[k].x - p.x) ** 2 + (below[k].y - p.y) ** 2;
        if (d < best) { best = d; qx = below[k].x; qy = below[k].y; }
      }
      if (best > maxShift2) {
        const d = Math.sqrt(best);
        const t = maxShift / d; // pull P toward Q until the gap == maxShift
        p.x = qx + (p.x - qx) * t;
        p.y = qy + (p.y - qy) * t;
        const pull = d - maxShift;
        if (pull > maxPull) maxPull = pull;
        clampedPoints++;
      }
    }
  }
  totalPoints += loops.length ? loops[0].length : 0; // count layer 0 too

  const stl = buildStl(loops, L.loopZ, cx, cy);
  return {
    stl,
    stats: { layers: loops.length, clampedPoints, totalPoints, maxPullMm: maxPull },
  };
}

// Re-loft the clamped loops into a binary STL: side walls between consecutive
// loops + a bottom cap fan. Top is left open (a vase).
function buildStl(loops: Pt[][], loopZ: number[], cx: number, cy: number): Buffer {
  const tris: number[] = []; // flat [ax,ay,az, bx,by,bz, cx,cy,cz, ...]
  const push = (a: number[], b: number[], c: number[]) => tris.push(...a, ...b, ...c);

  for (let i = 0; i < loops.length - 1; i++) {
    const lo = loops[i], hi = loops[i + 1];
    const z0 = loopZ[i], z1 = loopZ[i + 1];
    const n = Math.min(lo.length, hi.length);
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      const a = [lo[j].x, lo[j].y, z0];
      const b = [lo[j2].x, lo[j2].y, z0];
      const c = [hi[j].x, hi[j].y, z1];
      const d = [hi[j2].x, hi[j2].y, z1];
      push(a, b, d);
      push(a, d, c);
    }
  }

  // Bottom cap (fan to center of the first loop).
  if (loops.length) {
    const lo = loops[0], z0 = loopZ[0];
    const center = [cx, cy, z0];
    const n = lo.length;
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      push(center, [lo[j2].x, lo[j2].y, z0], [lo[j].x, lo[j].y, z0]);
    }
  }

  const count = tris.length / 9;
  const buf = Buffer.alloc(84 + 50 * count);
  buf.writeUInt32LE(count, 80);
  let o = 84;
  for (let t = 0; t < count; t++) {
    o += 12; // zero normal
    for (let k = 0; k < 9; k++) { buf.writeFloatLE(tris[t * 9 + k], o); o += 4; }
    o += 2; // attribute byte count
  }
  return buf;
}
