// Render a toolpath to the preview PNGs a Bambu `.gcode.3mf` carries.
//
// This draws the *toolpath*, not a mesh — there is no mesh to draw, since the
// 3mf we build has empty geometry. For spiralised / openwork pieces (the lamps
// this exists for) that is not a compromise: the object really is its toolpath,
// so a depth-shaded path render looks like the printed part. For a densely
// infilled solid it would read as a scribble; those are better sliced normally.
//
// Everything here is plain arithmetic into an RGBA buffer — no canvas, no deps.

import { encodePng } from './png';

export interface ThumbSeg {
  x1: number; y1: number; z1: number;
  x2: number; y2: number; z2: number;
}

export interface Camera {
  azimuth: number;   // radians, rotation about Z
  elevation: number; // radians, 0 = side on, PI/2 = straight down
}

export const ISO: Camera = { azimuth: Math.PI / 6, elevation: Math.PI / 6 };
export const TOP: Camera = { azimuth: 0, elevation: Math.PI / 2 };

export interface RenderOptions {
  size: number;              // output edge, px
  colour: [number, number, number];
  camera: Camera;
  beadMm: number;            // extrusion width, so density matches the real part
  shade: boolean;            // depth shading (off for the flat silhouettes)
  supersample?: number;
}

// Project to screen space. Returns screen x/y in model units (scaled later) and
// a depth that grows with distance from the camera, for painter's ordering.
function projector(cam: Camera) {
  const ca = Math.cos(cam.azimuth), sa = Math.sin(cam.azimuth);
  const ce = Math.cos(cam.elevation), se = Math.sin(cam.elevation);
  return (x: number, y: number, z: number) => {
    const u = x * ca - y * sa;
    const v = x * sa + y * ca;
    return { sx: u, sy: z * ce - v * se, depth: v * ce + z * se };
  };
}

export function renderToolpath(segs: ThumbSeg[], opts: RenderOptions): Buffer {
  const ss = opts.supersample ?? 3;
  const N = opts.size * ss;
  const buf = Buffer.alloc(N * N * 4); // zeroed = fully transparent
  if (!segs.length) return downsample(buf, N, opts.size, ss);

  const project = projector(opts.camera);

  // Fit: project everything once to find the screen-space bounds.
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  let mind = Infinity, maxd = -Infinity;
  const proj = new Array(segs.length);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const a = project(s.x1, s.y1, s.z1);
    const b = project(s.x2, s.y2, s.z2);
    proj[i] = { a, b, depth: (a.depth + b.depth) / 2 };
    minx = Math.min(minx, a.sx, b.sx); maxx = Math.max(maxx, a.sx, b.sx);
    miny = Math.min(miny, a.sy, b.sy); maxy = Math.max(maxy, a.sy, b.sy);
    mind = Math.min(mind, proj[i].depth); maxd = Math.max(maxd, proj[i].depth);
  }

  const margin = 0.08;
  const span = Math.max(maxx - minx, maxy - miny, 1e-6);
  const scale = (N * (1 - 2 * margin)) / span;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const toPx = (sx: number, sy: number) => ({
    px: N / 2 + (sx - cx) * scale,
    py: N / 2 - (sy - cy) * scale // screen y grows downward
  });

  // Painter's algorithm: farthest first, so nearer passes cover them.
  const order = proj.map((_: unknown, i: number) => i).sort((i: number, j: number) => proj[j].depth - proj[i].depth);

  const r = Math.max(0.6 * ss, (opts.beadMm * scale) / 2);
  const dRange = Math.max(1e-6, maxd - mind);
  const [cr, cg, cb] = opts.colour;

  for (const i of order) {
    const { a, b, depth } = proj[i];
    const p1 = toPx(a.sx, a.sy), p2 = toPx(b.sx, b.sy);

    // Near geometry reads brighter. Cheap, but it gives the round, lit look the
    // real thumbnails have without any normals or light model.
    let k = 1;
    if (opts.shade) {
      const t = (depth - mind) / dRange; // 0 = nearest
      k = 1 - 0.45 * t;
    }
    const R = Math.round(cr * k), G = Math.round(cg * k), B = Math.round(cb * k);

    stroke(buf, N, p1.px, p1.py, p2.px, p2.py, r, R, G, B);
  }

  return downsample(buf, N, opts.size, ss);
}

// Draw a round-capped line by testing distance to the segment. The capsule test
// gives joins and caps for free, which matters: a spiral is tens of thousands of
// short segments and any gap at the joints would show up as stippling.
function stroke(
  buf: Buffer, N: number,
  x1: number, y1: number, x2: number, y2: number,
  r: number, R: number, G: number, B: number
): void {
  const lo = (v: number) => Math.max(0, Math.floor(v - r - 1));
  const hi = (v: number) => Math.min(N - 1, Math.ceil(v + r + 1));
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;

  for (let py = lo(Math.min(y1, y2)); py <= hi(Math.max(y1, y2)); py++) {
    for (let px = lo(Math.min(x1, x2)); px <= hi(Math.max(x1, x2)); px++) {
      const qx = px + 0.5, qy = py + 0.5;
      let t = len2 > 0 ? ((qx - x1) * dx + (qy - y1) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(qx - (x1 + t * dx), qy - (y1 + t * dy));
      const cov = Math.min(1, Math.max(0, r + 0.5 - d));
      if (cov <= 0) continue;

      const o = (py * N + px) * 4;
      const sa = cov, da = buf[o + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      buf[o] = Math.round((R * sa + buf[o] * da * (1 - sa)) / outA);
      buf[o + 1] = Math.round((G * sa + buf[o + 1] * da * (1 - sa)) / outA);
      buf[o + 2] = Math.round((B * sa + buf[o + 2] * da * (1 - sa)) / outA);
      buf[o + 3] = Math.round(outA * 255);
    }
  }
}

// Box-filter down from the supersampled buffer. Averaging happens in
// premultiplied space, otherwise transparent pixels drag their (black) colour
// into the edges and the model gets a dark fringe.
function downsample(src: Buffer, N: number, size: number, ss: number): Buffer {
  if (ss === 1) return src;
  const out = Buffer.alloc(size * size * 4);
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const o = ((y * ss + j) * N + (x * ss + i)) * 4;
          const al = src[o + 3] / 255;
          r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

export function renderPng(segs: ThumbSeg[], opts: RenderOptions): Buffer {
  return encodePng(renderToolpath(segs, opts), opts.size, opts.size);
}

export function parseHexColour(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
