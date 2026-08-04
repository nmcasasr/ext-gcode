// Generates a procedural "twisted vase" as a binary STL, for testing the
// vase-mode slicer. Run:  node tools/make-vase-stl.js  -> writes vase.stl
//
// The shape is a single closed contour at every height (no holes, no islands),
// which is exactly what vase mode needs. It has lobes + a bulge + a twist.
const fs = require('fs');
const path = require('path');

const AROUND = 120;   // points around the circumference
const RINGS = 200;    // vertical divisions
const HEIGHT = 60;    // mm
const BASE_R = 28;    // mm
const LOBES = 6;      // star ripples
const LOBE_AMP = 0.10;
const BULGE_AMP = 0.28;
const TWIST = Math.PI * 1.2; // total twist over full height

function radius(theta, t) {
  const bulge = 1 + BULGE_AMP * Math.sin(t * Math.PI);           // fat in the middle
  const star = 1 + LOBE_AMP * Math.cos(LOBES * theta + TWIST * t); // twisting lobes
  return BASE_R * bulge * star;
}

function vertex(i, ring) {
  const theta = (i / AROUND) * Math.PI * 2;
  const t = ring / RINGS;
  const r = radius(theta, t);
  return [r * Math.cos(theta), r * Math.sin(theta), t * HEIGHT];
}

const tris = []; // each: [ax,ay,az, bx,by,bz, cx,cy,cz]
function tri(a, b, c) { tris.push([...a, ...b, ...c]); }

// Side walls (open top so it reads as a real vase).
for (let ring = 0; ring < RINGS; ring++) {
  for (let i = 0; i < AROUND; i++) {
    const i2 = (i + 1) % AROUND;
    const a = vertex(i, ring);
    const b = vertex(i2, ring);
    const c = vertex(i, ring + 1);
    const d = vertex(i2, ring + 1);
    tri(a, b, d);
    tri(a, d, c);
  }
}

// Bottom cap (fan to center) so the vase has a defined floor.
const center = [0, 0, 0];
for (let i = 0; i < AROUND; i++) {
  const i2 = (i + 1) % AROUND;
  tri(center, vertex(i2, 0), vertex(i, 0));
}

// --- Write binary STL -------------------------------------------------------
const buf = Buffer.alloc(84 + 50 * tris.length);
buf.writeUInt32LE(tris.length, 80);
let o = 84;
for (const t of tris) {
  // normal (0,0,0) — our slicer ignores it
  o += 12;
  for (let k = 0; k < 9; k++) { buf.writeFloatLE(t[k], o); o += 4; }
  o += 2; // attribute byte count
}

const out = path.join(__dirname, '..', 'vase.stl');
fs.writeFileSync(out, buf);
console.log(`Wrote ${out} (${tris.length} triangles, ${buf.length} bytes)`);
