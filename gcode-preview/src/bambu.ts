// Pack arbitrary G-code into a Bambu `.gcode.3mf` so it can be printed over LAN
// without an SD card.
//
// Why this exists: the A1 will not start a plain `.gcode`. Bambu Studio and the
// firmware only accept a `.gcode.3mf` container. The OrcaSlicer CLI cannot send
// either — checked against 2.4.2, there is no --send/--upload/--print-host, and
// "Upload & Print" lives only in the GUI. So we build the container ourselves,
// and the user opens it in Bambu Studio and hits Print.
//
// How it works: take a real `.gcode.3mf` the user exported from Orca for their
// machine (the *template*), keep its machine start/end G-code and all its
// metadata, and graft our own toolpath into the middle. The template is what
// makes the result machine-correct — we never synthesise Bambu start G-code.
//
// The 3mf carries no geometry at all (its 3D/3dmodel.model has empty
// <resources/> and <build/>), so swapping the G-code really is the whole job.

import * as crypto from 'crypto';
import { listZipEntries, writeZip, findEntry, ZipEntry } from './zip';
import { renderPng, parseHexColour, ThumbSeg, ISO, TOP } from './thumbnail';

const PLATE_GCODE = 'Metadata/plate_1.gcode';
const PLATE_MD5 = 'Metadata/plate_1.gcode.md5';
const PLATE_JSON = 'Metadata/plate_1.json';
const SLICE_INFO = 'Metadata/slice_info.config';
const PROJECT_SETTINGS = 'Metadata/project_settings.config';

// Where the template's machine start G-code ends. `; CHANGE_LAYER` appears once
// per layer; the first one is the handover from start G-code to the print.
const HEAD_END = /^; CHANGE_LAYER\s*$/;
// Where the machine end G-code begins. Appears exactly once in an Orca export.
const TAIL_START = /^M981 S0 P20000\b/;

// --- template splitting -----------------------------------------------------

export interface Template {
  head: string[]; // header + config block + machine start G-code
  tail: string[]; // machine end G-code + trailing filament comments
}

export function splitTemplate(plateGcode: string): Template {
  const lines = plateGcode.split('\n');
  const headEnd = lines.findIndex((l) => HEAD_END.test(l));
  const tailStart = lines.findIndex((l) => TAIL_START.test(l));
  if (headEnd < 0 || tailStart < 0 || tailStart <= headEnd) {
    throw new Error(
      'Could not find the start/end G-code boundaries in the template. Expected a ' +
        '"; CHANGE_LAYER" line and an "M981 S0 P20000" line. Re-export the template ' +
        'from OrcaSlicer (a plain single-object plate works best).'
    );
  }
  return { head: lines.slice(0, headEnd), tail: lines.slice(tailStart) };
}

// --- body extraction --------------------------------------------------------

// The FullControl lamp generators bracket their toolpath with these, which
// makes extraction exact. See vacante-g-code/fullcontrol-lamparas.
const FC_BODY_START = /^;=+\s*FIN DEL START GCODE/i;
const FC_BODY_END = /^;=+\s*END GCODE\b/i;

// Commands that set up or tear down the machine. The template's own start/end
// G-code already does all of this — and does it correctly for the A1 — so any
// copy coming from the source file must go, or we would home mid-print or drop
// the hotend to 0 °C before the real end G-code runs.
//
// Note what is NOT here: M106/M107 (fan) and G92 stay, because they are part of
// the toolpath's intent. G90/M83 stay too: they are already the template's
// state, so they are harmless, and keeping them protects us from a source file
// that assumes the opposite.
const SETUP_TEARDOWN = /^(G28|G29(\.\d+)?|M104|M109|M140|M190|M84|M18|M17)\b/i;

export interface Body {
  lines: string[];
  // Positioning/extrusion mode the body inherits from the preamble we cut away.
  // FullControl puts its `M83` in the header, above the marker, so a body sliced
  // at the marker contains no mode command at all — read as absolute it decodes
  // to nonsense (a 150 mm lamp came out as 120 mm of filament). We have to carry
  // the mode across the cut, and re-declare it in the graft.
  absPos: boolean;
  absExt: boolean;
  // Part-cooling fan, same story and a far more expensive one to get wrong.
  // FullControl sets `M106 S255` inside its start-gcode block, above the marker,
  // so cutting at the marker leaves the fan-on behind and the whole print runs
  // with no cooling: the extrudate never sets, strands sag into each other and
  // an openwork pattern collapses into a solid blob. null = source said nothing,
  // so leave whatever the template's start G-code left.
  fan: number | null;
}

// Pull the printable toolpath out of an arbitrary G-code file.
export function extractBody(gcode: string): Body {
  const lines = gcode.split(/\r?\n/);

  // G-code defaults: absolute positioning, absolute extrusion. Replay whatever
  // the discarded preamble set, so the body keeps the mode it was written in.
  const modeAt = (end: number) => {
    let absPos = true, absExt = true;
    let fan: number | null = null;
    for (let i = 0; i < end; i++) {
      const t = lines[i].trim();
      const c = t.split(/[\s;]/)[0].toUpperCase();
      if (c === 'G90') absPos = true;
      else if (c === 'G91') absPos = false;
      else if (c === 'M82') absExt = true;
      else if (c === 'M83') absExt = false;
      else if (c === 'M107') fan = 0;
      else if (c === 'M106') {
        // Only the part-cooling fan. M106 P1/P2/P3 address the aux, chamber and
        // remote fans, which are the machine's business, not the toolpath's.
        if (!/\bP[1-9]/i.test(t)) {
          const m = /\bS([\d.]+)/i.exec(t);
          fan = m ? Math.round(parseFloat(m[1])) : 255;
        }
      }
    }
    return { absPos, absExt, fan };
  };

  const fcStart = lines.findIndex((l) => FC_BODY_START.test(l));
  const fcEnd = lines.findIndex((l) => FC_BODY_END.test(l));
  if (fcStart >= 0 && fcEnd > fcStart) {
    return { lines: lines.slice(fcStart + 1, fcEnd), ...modeAt(fcStart) };
  }

  // Already a Bambu/Orca export (e.g. the output of "STL → Slice with OrcaSlicer",
  // possibly hand-edited). Cut it exactly where we cut the template — its own
  // machine start/end G-code goes, the template's stays.
  const orcaStart = lines.findIndex((l) => HEAD_END.test(l));
  const orcaEnd = lines.findIndex((l) => TAIL_START.test(l));
  if (orcaStart >= 0 && orcaEnd > orcaStart) {
    return { lines: lines.slice(orcaStart, orcaEnd), ...modeAt(orcaStart) };
  }

  // No markers: keep the whole file minus the machine setup/teardown, so its own
  // mode commands survive and the defaults apply until they do.
  // No markers: keep the whole file minus the machine setup/teardown, so its own
  // mode and fan commands survive in place.
  return { lines: lines.filter((l) => !SETUP_TEARDOWN.test(l.trim())), absPos: true, absExt: true, fan: null };
}

// --- G-code scanning --------------------------------------------------------

export interface Stats {
  minx: number; miny: number; maxx: number; maxy: number;
  minz: number; maxz: number;
  firstLayer: { minx: number; miny: number; maxx: number; maxy: number };
  filamentMm: number;
  extrudedMm: number; // length of extruding moves, for the bead cross-section
  seconds: number;
  layerHeight: number;
  layerCount: number;
  cum: number[]; // cumulative seconds at each body line
  zAt: number[]; // current Z at each body line
  path: ThumbSeg[]; // extruding moves only, for the preview thumbnails
}

interface Seg { x1: number; y1: number; z1: number; x2: number; y2: number; z: number; ext: boolean }

function scan(body: Body): { segs: Seg[]; filamentMm: number; seconds: number; extrudedMm: number; cum: number[]; zAt: number[] } {
  let absPos = body.absPos, absExt = body.absExt;
  let feed = 1800;
  const pos = { x: 0, y: 0, z: 0, e: 0 };
  const segs: Seg[] = [];
  let filamentMm = 0, seconds = 0, extrudedMm = 0;
  // Cumulative seconds and current Z at each source line, so progress and layer
  // markers can be dropped back into the body at the right places.
  const cum: number[] = new Array(body.lines.length).fill(0);
  const zAt: number[] = new Array(body.lines.length).fill(0);

  for (let li = 0; li < body.lines.length; li++) {
    let raw = body.lines[li];
    cum[li] = seconds;
    zAt[li] = pos.z;
    const semi = raw.indexOf(';');
    if (semi >= 0) raw = raw.slice(0, semi);
    raw = raw.trim();
    if (!raw) continue;
    const t = raw.split(/\s+/);
    const cmd = t[0].toUpperCase();

    if (cmd === 'G90') { absPos = true; continue; }
    if (cmd === 'G91') { absPos = false; continue; }
    if (cmd === 'M82') { absExt = true; continue; }
    if (cmd === 'M83') { absExt = false; continue; }
    if (cmd === 'G92') {
      for (let i = 1; i < t.length; i++) {
        const c = t[i][0].toUpperCase(), v = parseFloat(t[i].slice(1));
        if (isNaN(v)) continue;
        if (c === 'X') pos.x = v; else if (c === 'Y') pos.y = v;
        else if (c === 'Z') pos.z = v; else if (c === 'E') pos.e = v;
      }
      continue;
    }
    if (cmd !== 'G0' && cmd !== 'G1') continue;

    const sx = pos.x, sy = pos.y, sz = pos.z;
    let de = 0;
    for (let i = 1; i < t.length; i++) {
      const c = t[i][0].toUpperCase(), v = parseFloat(t[i].slice(1));
      if (isNaN(v)) continue;
      if (c === 'X') pos.x = absPos ? v : pos.x + v;
      else if (c === 'Y') pos.y = absPos ? v : pos.y + v;
      else if (c === 'Z') pos.z = absPos ? v : pos.z + v;
      else if (c === 'F') feed = v;
      else if (c === 'E') { if (absExt) { de = v - pos.e; pos.e = v; } else { de = v; pos.e += v; } }
    }
    const ext = de > 1e-6;
    if (ext) { filamentMm += de; extrudedMm += Math.hypot(pos.x - sx, pos.y - sy, pos.z - sz); }
    const dist = Math.hypot(pos.x - sx, pos.y - sy, pos.z - sz);
    if (feed > 0) seconds += (dist / feed) * 60;
    segs.push({ x1: sx, y1: sy, z1: sz, x2: pos.x, y2: pos.y, z: pos.z, ext });
  }
  return { segs, filamentMm, seconds, extrudedMm, cum, zAt };
}

// Median XY of the extrusion path — the axis to count revolutions around.
// NOT the bbox centre: purge/prime lines at the edge of the bed drag that centre
// onto the toolpath itself and the angle stops accumulating a full turn per
// revolution. Mirrors extrusionCentre() in tools/overhang-report.js.
function extrusionCentre(segs: Seg[]): [number, number] {
  const xs: number[] = [], ys: number[] = [];
  const step = Math.max(1, Math.floor(segs.length / 20000));
  for (let i = 0; i < segs.length; i += step) {
    if (!segs[i].ext) continue;
    xs.push(segs[i].x2); ys.push(segs[i].y2);
  }
  if (!xs.length) return [0, 0];
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  return [xs[xs.length >> 1], ys[ys.length >> 1]];
}

// Layer height by real Z over revolutions, not by "Z went up" — that breaks on
// vase-mode spirals, where Z rises continuously and there is no layer change.
// Same algorithm as the preview's heat map (media/main.js, tools/overhang-report.js).
function estimateLayerHeight(segs: Seg[], minz: number, maxz: number): number {
  const span = maxz - minz;
  if (!(span > 1e-6)) return 0.2;

  const zset = new Set<number>();
  let nExt = 0;
  for (const s of segs) { if (!s.ext) continue; nExt++; zset.add(Math.round(s.z * 1000)); }
  if (nExt < 2) return 0.2;

  // Discrete Z (a normally-sliced print): the median gap between Z levels.
  if (zset.size < nExt * 0.4) {
    const sorted = [...zset].map((v) => v / 1000).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) { const g = sorted[i] - sorted[i - 1]; if (g > 1e-4) gaps.push(g); }
    gaps.sort((a, b) => a - b);
    return gaps.length ? gaps[gaps.length >> 1] : span / Math.max(1, sorted.length - 1);
  }

  // Continuous Z (a spiral): height climbed divided by turns taken. Skip the
  // leading constant-Z run — a solid base or brim gains no height and would
  // drag the estimate down (a 0.40 mm bowl measured 0.31 mm before this).
  const [cx, cy] = extrusionCentre(segs);
  let z0: number | null = null, start = 0;
  for (let i = 0; i < segs.length; i++) {
    if (!segs[i].ext) continue;
    if (z0 === null) { z0 = segs[i].z; start = i; continue; }
    if (Math.abs(segs[i].z - z0) > 1e-6) { start = i; break; }
  }
  const climb = maxz - (z0 === null ? minz : z0);
  if (climb <= 1e-6) return span;

  let prev: number | null = null, total = 0;
  for (let i = start; i < segs.length; i++) {
    if (!segs[i].ext) continue;
    const a = Math.atan2(segs[i].y2 - cy, segs[i].x2 - cx);
    if (prev !== null) {
      let d = a - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      total += d;
    }
    prev = a;
  }
  return climb / Math.max(1, Math.abs(total) / (2 * Math.PI));
}

// Segments up to the first big drop in Z among extrusions — i.e. the first
// object on the plate. A sequential-print plate finishes one piece and starts
// the next back down at the first layer; that drop is the object boundary.
function firstObject(segs: Seg[]): Seg[] {
  let alto = -Infinity;
  for (let i = 0; i < segs.length; i++) {
    if (!segs[i].ext) continue;
    if (segs[i].z < alto - 2) return segs.slice(0, i);
    alto = Math.max(alto, segs[i].z);
  }
  return segs;
}

export function bodyStats(body: Body): Stats {
  const { segs, filamentMm, seconds, extrudedMm, cum, zAt } = scan(body);
  const ext = segs.filter((s) => s.ext);
  if (!ext.length) throw new Error('The G-code has no extrusion moves — nothing to print.');

  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  let minz = Infinity, maxz = -Infinity;
  for (const s of ext) {
    minx = Math.min(minx, s.x1, s.x2); maxx = Math.max(maxx, s.x1, s.x2);
    miny = Math.min(miny, s.y1, s.y2); maxy = Math.max(maxy, s.y1, s.y2);
    minz = Math.min(minz, s.z); maxz = Math.max(maxz, s.z);
  }

  // Layer height is estimated on the FIRST object only. On a plate with several
  // objects the toolpath jumps back down to the first layer for each one, and
  // the revolution counter — which unwraps the angle about a single centre —
  // reads the jump between two objects as thousands of turns. Measured: a
  // two-specimen plate came out as 0.002 mm layers, i.e. 7638 of them.
  const primero = firstObject(segs);
  let z1 = Infinity, z2 = -Infinity;
  for (const s of primero) { if (!s.ext) continue; z1 = Math.min(z1, s.z); z2 = Math.max(z2, s.z); }
  const layerHeight = estimateLayerHeight(primero, isFinite(z1) ? z1 : minz, isFinite(z2) ? z2 : maxz);
  const layerCount = Math.max(1, Math.round((maxz - minz) / layerHeight) + 1);

  // First-layer footprint drives the adaptive bed mesh (G29 A1 ...), so it has
  // to be the real first layer, not the whole model.
  const zCut = minz + 1.5 * layerHeight;
  const first = ext.filter((s) => s.z <= zCut);
  const fl = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  for (const s of first.length ? first : ext) {
    fl.minx = Math.min(fl.minx, s.x1, s.x2); fl.maxx = Math.max(fl.maxx, s.x1, s.x2);
    fl.miny = Math.min(fl.miny, s.y1, s.y2); fl.maxy = Math.max(fl.maxy, s.y1, s.y2);
  }

  return { minx, miny, maxx, maxy, minz, maxz, firstLayer: fl, filamentMm, extrudedMm, seconds, layerHeight, layerCount, cum, zAt,
    path: ext.map((s) => ({ x1: s.x1, y1: s.y1, z1: s.z1, x2: s.x2, y2: s.y2, z2: s.z })) };
}

// Progress and layer reporting. Two different consumers need this, and getting
// it wrong is what makes a technically-correct file look broken:
//
//   * The printer drives its progress bar and time-remaining readout from
//     M73 P<percent> R<minutes>. The template's head carries the *old* object's
//     markers — the cube's start G-code alone climbs to P47 — so without a
//     rewrite the display jumps to 47 % before the first extrusion, sits there
//     all print, then snaps to 98 %.
//
//   * Slicer G-code viewers (Orca, Bambu Studio) build their layer slider from
//     "; CHANGE_LAYER" + "; Z_HEIGHT:", NOT from the Z in the moves. And
//     "; Z_HEIGHT:" is authoritative: emit it once and the viewer pins the whole
//     print to that height. Measured — a single "; Z_HEIGHT: 0.40" at the top of
//     the graft rendered a 58 mm bowl as a flat pancake and reported Z 0.400 in
//     the status bar for a move whose text said Z57.104454. Harmless to the
//     printer (it is a comment) but it destroys the preview.
//
// So layers are emitted by *real Z*, one block per layer height climbed.
const BODY_START_PCT = 2;
const BODY_END_PCT = 98;

// Viewers colour by "; FEATURE:" and count only recognised features as model
// time; unannotated extrusion lands in "Custom" and reads as ~0 s of printing.
// Spiralised lamps are outer wall essentially everywhere.
const FEATURE = '; FEATURE: Outer wall';

// The height of the extruded bead — NOT the same thing as the spiral pitch.
//
// Viewers render an extrusion's width as volume / (length · LAYER_HEIGHT), so a
// wrong LAYER_HEIGHT draws the wrong width. Feeding it the pitch of a spiralised
// lamp (1.156 mm) made Orca draw 0.277 mm beads instead of the real 0.800 mm —
// the whole model appeared full of gaps, including a base that is in fact solid
// (0.800 mm beads laid 0.614 mm apart, i.e. 23 % overlap).
//
// The bead's cross-section comes straight from the flow. Anchor it on the
// template's nominal line width to split that area into width × height.
function beadHeight(st: Stats, lineWidth: number, fallback: number): number {
  if (!(st.extrudedMm > 0)) return fallback;
  const area = (st.filamentMm * Math.PI * (1.75 / 2) ** 2) / st.extrudedMm;
  const h = area / lineWidth;
  return h > 0.01 && h < 5 ? h : fallback;
}

function injectProgress(body: Body, st: Stats, bead: number): { lines: string[]; layers: number } {
  const out: string[] = [];
  const total = Math.max(1, st.seconds);
  const lh = st.layerHeight;
  let lastPct = -1, layer = 0;

  const openLayer = (z: number) => {
    layer++;
    out.push(
      '; CHANGE_LAYER',
      `; Z_HEIGHT: ${z.toFixed(3)}`,
      `; LAYER_HEIGHT: ${bead.toFixed(3)}`,
      // total is patched in afterwards, once we know how many we emitted
      `; layer num/total_layer_count: ${layer}/@@TOTAL@@`,
      `M73 L${layer}`,
      FEATURE
    );
  };

  openLayer(st.minz);
  // Track the last Z we announced and react to any move away from it, in either
  // direction. A rising threshold breaks the moment Z is not monotonic: a plate
  // with several objects lifts to travel and then starts the next one back down
  // at the first layer, and a monotonic counter would fire once on the lift and
  // never again — the later objects then land in the last declared layer and the
  // viewer draws nothing for them.
  let lastZ = st.minz;

  for (let i = 0; i < body.lines.length; i++) {
    const z = st.zAt[i];
    if (Math.abs(z - lastZ) >= lh) {
      openLayer(z);
      lastZ = z;
    }

    const pct = Math.floor(BODY_START_PCT + (st.cum[i] / total) * (BODY_END_PCT - BODY_START_PCT));
    if (pct > lastPct) {
      out.push(`M73 P${pct} R${Math.round((total - st.cum[i]) / 60)}`);
      lastPct = pct;
    }
    out.push(body.lines[i]);
  }

  const total_ = String(layer);
  return { lines: out.map((l) => (l.includes('@@TOTAL@@') ? l.replace('@@TOTAL@@', total_) : l)), layers: layer };
}

// --- header / metadata patching ---------------------------------------------

function replaceLine(lines: string[], re: RegExp, next: string): void {
  const i = lines.findIndex((l) => re.test(l));
  if (i >= 0) lines[i] = next;
}

function hhmmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m ${r}s` : `${m}m ${r}s`;
}

// Filament volume/weight for 1.75 mm PLA at 1.26 g/cm³ — the density the
// template's own header reports.
function filamentGrams(mm: number): { cm3: number; grams: number } {
  const cm3 = (mm * Math.PI * (1.75 / 2) ** 2) / 1000;
  return { cm3, grams: cm3 * 1.26 };
}

function patchHead(head: string[], st: Stats, name: string, body: Body): string[] {
  const out = head.slice();
  const { cm3, grams } = filamentGrams(st.filamentMm);

  replaceLine(out, /^; total layer number:/, `; total layer number: ${st.layerCount}`);
  replaceLine(out, /^; max_z_height:/, `; max_z_height: ${st.maxz.toFixed(2)}`);
  replaceLine(out, /^; model printing time:/,
    `; model printing time: ${hhmmss(st.seconds)}; total estimated time: ${hhmmss(st.seconds * 1.15)}`);
  replaceLine(out, /^; estimated first layer printing time/,
    `; estimated first layer printing time (normal mode) = ${hhmmss(st.seconds / Math.max(1, st.layerCount))}`);

  // Adaptive bed mesh. X/Y is the minimum corner of the first layer and I/J its
  // size; leaving the template's numbers would probe the old object's footprint
  // and level nothing under ours.
  // Rescale the template's own progress markers into the 0–BODY_START_PCT band
  // reserved for the start G-code (see injectProgress).
  let headMax = 0;
  for (const l of out) {
    const m = /^M73 P(\d+)/.exec(l);
    if (m) headMax = Math.max(headMax, parseInt(m[1], 10));
  }
  if (headMax > 0) {
    const mins = Math.round(st.seconds / 60);
    for (let k = 0; k < out.length; k++) {
      const m = /^M73 P(\d+)/.exec(out[k]);
      if (m) out[k] = `M73 P${Math.round((parseInt(m[1], 10) / headMax) * BODY_START_PCT)} R${mins}`;
    }
  }

  const i = out.findIndex((l) => /^\s*G29 A1 X/.test(l));
  if (i >= 0) {
    const indent = out[i].match(/^\s*/)?.[0] ?? '';
    const w = Math.max(1, st.firstLayer.maxx - st.firstLayer.minx);
    const h = Math.max(1, st.firstLayer.maxy - st.firstLayer.miny);
    out[i] = `${indent}G29 A1 X${st.firstLayer.minx.toFixed(3)} Y${st.firstLayer.miny.toFixed(3)} I${w.toFixed(3)} J${h.toFixed(3)}`;
  }

  out.push(
    '',
    `; ---- gcode-preview: body grafted from ${name} ----`,
    `; ${cm3.toFixed(2)} cm3 / ${grams.toFixed(2)} g, ${st.layerCount} layers at ~${st.layerHeight.toFixed(3)} mm`,
    // Re-declare the mode the body was written in. The template leaves the
    // machine in G90/M83, so for FullControl output this is a no-op — but a
    // source in absolute extrusion would otherwise be read as relative and
    // extrude its entire cumulative E on every move.
    // No "; CHANGE_LAYER" here — injectProgress opens the first layer, so that
    // every layer marker is emitted in one place against real Z.
    body.absPos ? 'G90' : 'G91',
    body.absExt ? 'M82' : 'M83',
    // The template's start G-code stops just short of its first layer move, so
    // nothing has lifted the nozzle yet: it is still down by the purge line with
    // the extruder primed. Retract and clear before the body's first travel.
    'G1 E-.8 F1800',
    'G1 Z5 F42000',
    // Zero the extruder *after* retracting, so an absolute-E body starting near
    // E0 lines up with where the filament actually is instead of reading as one
    // enormous retract.
    'G92 E0',
    // Restore the cooling the discarded preamble had asked for. The template's
    // start G-code ends with the fan off (it is about to print a first layer);
    // without this the whole body prints uncooled.
    ...(body.fan === null ? [] : [`M106 S${body.fan}`]),
    ''
  );
  return out;
}

function patchTail(tail: string[], st: Stats): string[] {
  const { cm3, grams } = filamentGrams(st.filamentMm);
  const out = ['', '; ---- gcode-preview: end of grafted body ----', 'M106 S0', ...tail];
  replaceLine(out, /^; filament used \[mm\]/, `; filament used [mm] = ${st.filamentMm.toFixed(2)}`);
  replaceLine(out, /^; filament used \[cm3\]/, `; filament used [cm3] = ${cm3.toFixed(2)}`);
  replaceLine(out, /^; filament used \[g\]/, `; filament used [g] = ${grams.toFixed(2)}`);
  return out;
}

function patchPlateJson(json: string, st: Stats, name: string): string {
  const d = JSON.parse(json);
  const bbox = [st.minx, st.miny, st.maxx, st.maxy];
  d.bbox_all = bbox;
  if (Array.isArray(d.bbox_objects) && d.bbox_objects.length) {
    d.bbox_objects[0].bbox = bbox;
    d.bbox_objects[0].name = name;
    d.bbox_objects[0].area = (st.maxx - st.minx) * (st.maxy - st.miny);
    d.bbox_objects[0].layer_height = st.layerHeight;
  }
  d.first_layer_time = st.seconds / Math.max(1, st.layerCount);
  return JSON.stringify(d);
}

function patchSliceInfo(xml: string, st: Stats, name: string): string {
  const { grams } = filamentGrams(st.filamentMm);
  return xml
    .replace(/(<metadata key="prediction" value=")[^"]*(")/, `$1${Math.round(st.seconds)}$2`)
    .replace(/(<metadata key="weight" value=")[^"]*(")/, `$1${grams.toFixed(2)}$2`)
    .replace(/(<metadata key="first_layer_time" value=")[^"]*(")/, `$1${(st.seconds / Math.max(1, st.layerCount)).toFixed(6)}$2`)
    .replace(/(<object identify_id="\d+" name=")[^"]*(")/, `$1${name}$2`)
    .replace(/(used_m=")[^"]*(")/, `$1${(st.filamentMm / 1000).toFixed(2)}$2`)
    .replace(/(used_g=")[^"]*(")/, `$1${grams.toFixed(2)}$2`);
}

// --- preview thumbnails -----------------------------------------------------

// The five PNGs a plate carries. plate_1 (and its 128 px twin) is what you
// actually see in the slicer, on the printer screen and in Handy. top_1 and
// pick_1 are flat overhead silhouettes — pick_1 is the object-picking buffer,
// so it is a solid ID colour rather than the filament colour.
const PICK_COLOUR: [number, number, number] = [0x59, 0x08, 0x08];

function renderThumbnails(
  path: ThumbSeg[],
  colour: [number, number, number],
  beadMm: number
): Record<string, Buffer> {
  const iso = { camera: ISO, beadMm, shade: true, colour };
  return {
    'Metadata/plate_1.png': renderPng(path, { ...iso, size: 512 }),
    'Metadata/plate_1_small.png': renderPng(path, { ...iso, size: 128 }),
    'Metadata/plate_no_light_1.png': renderPng(path, { ...iso, size: 512, shade: false }),
    'Metadata/top_1.png': renderPng(path, { camera: TOP, beadMm, shade: false, colour, size: 512 }),
    'Metadata/pick_1.png': renderPng(path, { camera: TOP, beadMm, shade: false, colour: PICK_COLOUR, size: 512 })
  };
}

// --- the whole job ----------------------------------------------------------

export interface PackResult {
  zip: Buffer;
  stats: Stats;
  md5: string;
  plateGcode: string;
}

export function packBambu3mf(template: Buffer, gcode: string, name = 'gcode-preview'): PackResult {
  const entries = listZipEntries(template);
  const plate = findEntry(entries, (n) => n === PLATE_GCODE);
  if (!plate) throw new Error(`Template is missing ${PLATE_GCODE} — is it really a .gcode.3mf exported from OrcaSlicer?`);

  const { head, tail } = splitTemplate(plate.data.toString('utf8'));
  const body = extractBody(gcode);
  const stats = bodyStats(body);

  // Nominal bead geometry from the template's own profile, used only to render
  // the toolpath at the right thickness in a slicer preview.
  const settings = findEntry(entries, (n) => n === PROJECT_SETTINGS);
  let lineWidth = 0.42, layerHeight = 0.2;
  if (settings) {
    try {
      const cfg = JSON.parse(settings.data.toString('utf8'));
      lineWidth = parseFloat(cfg.line_width) || lineWidth;
      layerHeight = parseFloat(cfg.layer_height) || layerHeight;
    } catch { /* keep the defaults; this only affects preview thickness */ }
  }
  const bead = beadHeight(stats, lineWidth, layerHeight);

  // The body is built first: how many layers it really contains only falls out
  // of walking it, and the header has to agree with the markers inside.
  const cuerpo = injectProgress(body, stats, bead);
  const real: Stats = { ...stats, layerCount: cuerpo.layers };

  // Orca writes LF only and ends the file with a newline; the md5 is over these
  // exact bytes, so keep both.
  const plateGcode =
    [...patchHead(head, real, name, body), ...cuerpo.lines, ...patchTail(tail, real)].join('\n') + '\n';
  const plateBuf = Buffer.from(plateGcode, 'utf8');
  const md5 = crypto.createHash('md5').update(plateBuf).digest('hex').toUpperCase();

  // Preview thumbnails. Rendered in the filament colour the template records,
  // which is what Bambu's own previews use.
  const plateJson = findEntry(entries, (n) => n === PLATE_JSON);
  let colour: [number, number, number] = [0x26, 0xa6, 0x9a];
  if (plateJson) {
    try {
      const c = JSON.parse(plateJson.data.toString('utf8')).filament_colors?.[0];
      if (typeof c === 'string') colour = parseHexColour(c, colour);
    } catch { /* keep the default teal */ }
  }
  const thumbs = renderThumbnails(stats.path, colour, lineWidth);

  const next: ZipEntry[] = entries.map((e) => {
    if (thumbs[e.name]) return { ...e, data: thumbs[e.name] };
    if (e.name === PLATE_GCODE) return { ...e, data: plateBuf };
    // The firmware checks this. An unchanged md5 means the job is rejected.
    if (e.name === PLATE_MD5) return { ...e, data: Buffer.from(md5, 'ascii') };
    if (e.name === PLATE_JSON) {
      return { ...e, data: Buffer.from(patchPlateJson(e.data.toString('utf8'), stats, name), 'utf8') };
    }
    if (e.name === SLICE_INFO) {
      return { ...e, data: Buffer.from(patchSliceInfo(e.data.toString('utf8'), stats, name), 'utf8') };
    }
    return e; // everything else (thumbnails, settings, rels) rides along untouched
  });

  return { zip: writeZip(next), stats: real, md5, plateGcode };
}
