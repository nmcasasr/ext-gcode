// Shared contour extraction: slice a triangle mesh into per-layer closed
// loops, resampled and seam-aligned. Used by both the vase slicer and the
// overhang clamp so they see identical geometry.

export interface Pt { x: number; y: number; }

export interface Layers {
  loops: Pt[][];   // one closed loop per layer, bottom -> top, all N points
  loopZ: number[]; // Z height of each loop (mm), parallel to loops
  minZ: number;
  maxZ: number;
  minX: number; minY: number; maxX: number; maxY: number;
  layerHeight: number;
  resample: number;
}

export function sliceMeshToLayers(tris: Float32Array, layerHeight: number, resampleN: number): Layers {
  const triCount = tris.length / 9;
  let minZ = Infinity, maxZ = -Infinity;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const layerCount = Math.max(1, Math.floor((maxZ - minZ) / layerHeight));

  const loops: Pt[][] = [];
  const loopZ: number[] = [];
  let prevStart: Pt | null = null;
  for (let i = 0; i < layerCount; i++) {
    const z = minZ + (i + 0.5) * layerHeight; // mid-layer dodges coplanar caps
    const raw = pickLargestLoop(sliceAt(tris, triCount, z));
    if (!raw || raw.length < 3) continue;
    let loop = resample(raw, resampleN);
    if (signedArea(loop) < 0) loop.reverse();
    if (prevStart) loop = rotateToNearest(loop, prevStart);
    prevStart = loop[0];
    loops.push(loop);
    loopZ.push(z);
  }
  return { loops, loopZ, minZ, maxZ, minX, minY, maxX, maxY, layerHeight, resample: resampleN };
}

// --- plane intersection ----------------------------------------------------

export function sliceAt(tris: Float32Array, triCount: number, z: number): Pt[][] {
  const segs: Pt[][] = [];
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const az = tris[o + 2], bz = tris[o + 5], cz = tris[o + 8];
    if ((az < z && bz < z && cz < z) || (az > z && bz > z && cz > z)) continue;
    const pts: Pt[] = [];
    cross(tris[o], tris[o + 1], az, tris[o + 3], tris[o + 4], bz, z, pts);
    cross(tris[o + 3], tris[o + 4], bz, tris[o + 6], tris[o + 7], cz, z, pts);
    cross(tris[o + 6], tris[o + 7], cz, tris[o], tris[o + 1], az, z, pts);
    if (pts.length === 2) segs.push(pts);
  }
  return stitch(segs);
}

function cross(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, z: number, out: Pt[]) {
  const below1 = z1 < z, below2 = z2 < z;
  if (below1 === below2) return;
  const t = (z - z1) / (z2 - z1);
  out.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
}

interface GNode { x: number; y: number; nbr: string[]; }

function stitch(segs: Pt[][]): Pt[][] {
  const eps = 1e-3;
  const key = (p: Pt): string => `${Math.round(p.x / eps)},${Math.round(p.y / eps)}`;
  const nodes = new Map<string, GNode>();
  const ensureNode = (p: Pt): string => {
    const k = key(p);
    let g = nodes.get(k);
    if (!g) { g = { x: p.x, y: p.y, nbr: [] }; nodes.set(k, g); }
    return k;
  };
  for (const [a, b] of segs) {
    const ka = ensureNode(a), kb = ensureNode(b);
    if (ka === kb) continue;
    nodes.get(ka)!.nbr.push(kb);
    nodes.get(kb)!.nbr.push(ka);
  }
  const loops: Pt[][] = [];
  const used = new Set<string>();
  for (const start of nodes.keys()) {
    if (used.has(start)) continue;
    const loop: Pt[] = [];
    let cur: string | null = start;
    let prev: string | null = null;
    while (cur && !used.has(cur)) {
      used.add(cur);
      const g: GNode = nodes.get(cur)!;
      loop.push({ x: g.x, y: g.y });
      let next: string | null = null;
      for (const k of g.nbr) { if (k !== prev && !used.has(k)) { next = k; break; } }
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export function pickLargestLoop(loops: Pt[][]): Pt[] | null {
  let best: Pt[] | null = null, bestArea = 0;
  for (const l of loops) {
    const a = Math.abs(signedArea(l));
    if (a > bestArea) { bestArea = a; best = l; }
  }
  return best;
}

export function signedArea(loop: Pt[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function resample(loop: Pt[], n: number): Pt[] {
  const m = loop.length;
  const seglen: number[] = [];
  let perim = 0;
  for (let i = 0; i < m; i++) {
    const p = loop[i], q = loop[(i + 1) % m];
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    seglen.push(d); perim += d;
  }
  if (perim === 0) return loop.slice();
  const out: Pt[] = [];
  const step = perim / n;
  let idx = 0, acc = 0, target = 0;
  for (let k = 0; k < n; k++) {
    while (idx < m && acc + seglen[idx] < target) { acc += seglen[idx]; idx++; }
    if (idx >= m) { out.push({ ...loop[0] }); target += step; continue; }
    const p = loop[idx], q = loop[(idx + 1) % m];
    const t = seglen[idx] > 0 ? (target - acc) / seglen[idx] : 0;
    out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    target += step;
  }
  return out;
}

export function rotateToNearest(loop: Pt[], ref: Pt): Pt[] {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const d = (loop[i].x - ref.x) ** 2 + (loop[i].y - ref.y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best === 0 ? loop : loop.slice(best).concat(loop.slice(0, best));
}
