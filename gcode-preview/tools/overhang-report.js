// Overhang report for any G-code file. Same algorithm as the live preview's
// heat map: bins segments into layers by real Z (works for vase spirals),
// then for each extrusion measures the perpendicular gap to the supporting
// wall one layer below -> overhang angle from vertical.
//
// Usage:  node tools/overhang-report.js path/to/file.gcode
const fs = require('fs');

const OVH_MAX_DIST = 3.0;
const OVH_WARN = 45;
const OVH_FAIL = 65;

const file = process.argv[2];
if (!file) { console.error('Usage: node tools/overhang-report.js <file.gcode>'); process.exit(1); }
const text = fs.readFileSync(file, 'utf8');

// --- parse (handles G90/G91, M82/M83, G92) --------------------------------
function parse(text) {
  const lines = text.split(/\r?\n/);
  let absPos = true, absExt = true;
  const pos = { x: 0, y: 0, z: 0, e: 0 };
  const V = [], ext = [], segZ = [];
  const bbox = { minx: Infinity, miny: Infinity, minz: Infinity, maxx: -Infinity, maxy: -Infinity, maxz: -Infinity };
  const bump = (x, y, z) => {
    if (x < bbox.minx) bbox.minx = x; if (y < bbox.miny) bbox.miny = y; if (z < bbox.minz) bbox.minz = z;
    if (x > bbox.maxx) bbox.maxx = x; if (y > bbox.maxy) bbox.maxy = y; if (z > bbox.maxz) bbox.maxz = z;
  };
  const num = (tok) => parseFloat(tok.slice(1));
  for (let raw of lines) {
    const semi = raw.indexOf(';'); if (semi >= 0) raw = raw.slice(0, semi);
    raw = raw.trim(); if (!raw) continue;
    const t = raw.split(/\s+/); const cmd = t[0].toUpperCase();
    if (cmd === 'G90') { absPos = true; continue; }
    if (cmd === 'G91') { absPos = false; continue; }
    if (cmd === 'M82') { absExt = true; continue; }
    if (cmd === 'M83') { absExt = false; continue; }
    if (cmd === 'G92') {
      for (let i = 1; i < t.length; i++) { const c = t[i][0].toUpperCase(), v = num(t[i]);
        if (c === 'X') pos.x = v; else if (c === 'Y') pos.y = v; else if (c === 'Z') pos.z = v; else if (c === 'E') pos.e = v; }
      continue;
    }
    if (cmd === 'G0' || cmd === 'G1') {
      const start = { x: pos.x, y: pos.y, z: pos.z }; let de = 0;
      for (let i = 1; i < t.length; i++) { const c = t[i][0].toUpperCase(), v = num(t[i]); if (isNaN(v)) continue;
        if (c === 'X') pos.x = absPos ? v : pos.x + v;
        else if (c === 'Y') pos.y = absPos ? v : pos.y + v;
        else if (c === 'Z') pos.z = absPos ? v : pos.z + v;
        else if (c === 'E') { if (absExt) { de = v - pos.e; pos.e = v; } else { de = v; pos.e += v; } } }
      const e = de > 1e-6;
      V.push(start.x, start.y, start.z, pos.x, pos.y, pos.z); ext.push(e ? 1 : 0); segZ.push(pos.z);
      if (e) { bump(start.x, start.y, start.z); bump(pos.x, pos.y, pos.z); }
    }
  }
  return { V, ext, segZ, bbox };
}

// Median XY of the extrusion path — the axis to count revolutions around.
// NOT the bbox centre: purge/prime lines at the edge of the bed drag that
// centre onto the toolpath itself, and the angle stops accumulating one turn
// per revolution (measured: 86 revolutions instead of 375 on a lamp, i.e. a
// 1.74 mm layer height reported for a 0.4 mm print). Sampled, so it stays
// cheap on big files.
function extrusionCentre(V, ext) {
  const xs = [], ys = [];
  const step = Math.max(1, Math.floor(ext.length / 20000));
  for (let s = 0; s < ext.length; s += step) {
    if (!ext[s]) continue;
    xs.push(V[s * 6 + 3]); ys.push(V[s * 6 + 4]);
  }
  if (!xs.length) return [0, 0];
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  return [xs[xs.length >> 1], ys[ys.length >> 1]];
}

function estimateLayerHeight(V, ext, bbox) {
  const span = bbox.maxz - bbox.minz;
  if (!isFinite(span) || span <= 1e-6) return 0.2;
  const zset = new Set(); let nExt = 0;
  for (let s = 0; s < ext.length; s++) { if (!ext[s]) continue; nExt++; zset.add(Math.round(V[s * 6 + 5] * 1000)); }
  if (nExt < 2) return 0.2;
  if (zset.size < nExt * 0.4) {
    const sorted = [...zset].map((v) => v / 1000).sort((a, b) => a - b); const gaps = [];
    for (let i = 1; i < sorted.length; i++) { const g = sorted[i] - sorted[i - 1]; if (g > 1e-4) gaps.push(g); }
    gaps.sort((a, b) => a - b);
    return gaps.length ? gaps[gaps.length >> 1] : span / Math.max(1, sorted.length - 1);
  }
  const [cx, cy] = extrusionCentre(V, ext);
  // Skip the leading constant-Z run (solid-base spiral, brim, flat first turn):
  // those turns gain no height and shrink the estimate. A 0.40 mm bowl with an
  // Archimedean floor measured 0.31 mm; a 1.19 mm celosia pitch measured 0.62 mm.
  let z0 = null, start = 0;
  for (let s = 0; s < ext.length; s++) { if (!ext[s]) continue;
    const z = V[s * 6 + 5];
    if (z0 === null) { z0 = z; start = s; continue; }
    if (Math.abs(z - z0) > 1e-6) { start = s; break; } }
  const climb = bbox.maxz - (z0 === null ? bbox.minz : z0);
  if (climb <= 1e-6) { return span; }
  let prev = null, total = 0;
  for (let s = start; s < ext.length; s++) { if (!ext[s]) continue;
    const a = Math.atan2(V[s * 6 + 4] - cy, V[s * 6 + 3] - cx);
    if (prev !== null) { let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; total += d; }
    prev = a; }
  return climb / Math.max(1, Math.abs(total) / (2 * Math.PI));
}

function distToSegSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
}

const { V, ext, segZ, bbox } = parse(text);
const layerH = estimateLayerHeight(V, ext, bbox);
const layers = Math.max(1, Math.round((bbox.maxz - bbox.minz) / layerH) + 1);

const cell = OVH_MAX_DIST, zb = (z) => Math.round(z / layerH), key = (b, gx, gy) => b + ':' + gx + ':' + gy;
const grid = new Map();
const put = (b, gx, gy, e) => { const kk = key(b, gx, gy); let a = grid.get(kk); if (!a) { a = []; grid.set(kk, a); } a.push(e); };
for (let s = 0; s < ext.length; s++) { if (!ext[s]) continue; const o = s * 6;
  const x1 = V[o], y1 = V[o + 1], x2 = V[o + 3], y2 = V[o + 4], b = zb(segZ[s]), e = [x1, y1, x2, y2, segZ[s]];
  put(b, Math.floor(x1 / cell), Math.floor(y1 / cell), e);
  const k1 = key(b, Math.floor(x1 / cell), Math.floor(y1 / cell)), k2 = key(b, Math.floor(x2 / cell), Math.floor(y2 / cell));
  if (k1 !== k2) put(b, Math.floor(x2 / cell), Math.floor(y2 / cell), e); }

const bedZ = bbox.minz + 1.5 * layerH;
let maxDeg = 0, maxZ = 0, nExt = 0;
const hist = {};
const riskyByLayer = new Map(); // layer -> count of segments > WARN
for (let s = 0; s < ext.length; s++) { if (!ext[s]) continue; nExt++;
  const o = s * 6, mx = (V[o] + V[o + 3]) / 2, my = (V[o + 1] + V[o + 4]) / 2, mz = segZ[s]; let deg;
  if (mz <= bedZ) deg = 0; else {
    const gx = Math.floor(mx / cell), gy = Math.floor(my / cell), qb = zb(mz); let bestH = Infinity, bestDV = layerH;
    for (let bz = qb - 1; bz >= qb - 2; bz--) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = grid.get(key(bz, gx + dx, gy + dy)); if (!a) continue;
        for (let i = 0; i < a.length; i++) { const e = a[i], dv = mz - e[4]; if (dv < 0.4 * layerH || dv > 2 * layerH) continue;
          const h2 = distToSegSq(mx, my, e[0], e[1], e[2], e[3]); if (h2 < bestH) { bestH = h2; bestDV = dv; } } }
      if (bestH !== Infinity) break; }
    const dist = bestH === Infinity ? OVH_MAX_DIST : Math.min(OVH_MAX_DIST, Math.sqrt(bestH));
    deg = Math.atan2(dist, bestDV) * 180 / Math.PI;
  }
  if (deg > maxDeg) { maxDeg = deg; maxZ = mz; }
  hist[Math.floor(deg / 10) * 10] = (hist[Math.floor(deg / 10) * 10] || 0) + 1;
  if (deg >= OVH_WARN) { const l = Math.round((mz - bbox.minz) / layerH); riskyByLayer.set(l, (riskyByLayer.get(l) || 0) + 1); }
}

// --- report ---------------------------------------------------------------
const risk = maxDeg >= OVH_FAIL ? 'LIKELY FAILS' : maxDeg >= OVH_WARN ? 'RISKY' : 'OK';
console.log(`\nFile: ${file}`);
console.log(`Layer height: ${layerH.toFixed(3)} mm   Layers: ${layers}   Extrusion moves: ${nExt}`);
console.log(`Model: ${(bbox.maxx - bbox.minx).toFixed(1)} x ${(bbox.maxy - bbox.miny).toFixed(1)} x ${(bbox.maxz - bbox.minz).toFixed(1)} mm`);
console.log(`\nMAX overhang: ${maxDeg.toFixed(1)}deg at Z=${maxZ.toFixed(1)}mm  ->  ${risk}`);
console.log(`(warn >=${OVH_WARN}deg, likely-fail >=${OVH_FAIL}deg; angle from vertical)\n`);

console.log('Angle histogram:');
for (const k of Object.keys(hist).sort((a, b) => a - b)) {
  const pct = (100 * hist[k] / nExt).toFixed(1).padStart(5);
  console.log(`  ${String(k).padStart(2)}-${+k + 10}deg: ${pct}%  ${'#'.repeat(Math.round(40 * hist[k] / nExt))}`);
}

const risky = [...riskyByLayer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
if (risky.length) {
  console.log('\nRiskiest layers (most segments over ' + OVH_WARN + 'deg):');
  risky.sort((a, b) => a[0] - b[0]);
  for (const [l, c] of risky) console.log(`  Z=${(bbox.minz + l * layerH).toFixed(1).padStart(5)}mm (layer ${l}): ${c} risky segments`);
  console.log('\n-> Fix these Z heights in Fusion: make the wall steeper (less outward flare) there.');
} else {
  console.log('\nNo segments over ' + OVH_WARN + 'deg — should print clean in vase mode. ✅');
}
console.log('');
