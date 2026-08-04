/* global THREE, acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const hud = document.getElementById('hud');

  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1e1e1e);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  camera.up.set(0, 0, 1); // printer Z is up
  camera.position.set(200, -200, 200);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));

  let printGroup = null;

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // --- G-code parsing -------------------------------------------------------
  // Produces ONE ordered list of line segments in G-code execution order, so
  // the timelapse bar can reveal them progressively. Each segment carries a
  // baked vertex color (fan-lerp for extrusion, dim gray for travel).
  // Handles G90/G91, M82/M83, G92, M106/M107.
  function parse(text) {
    const lines = text.split(/\r?\n/);
    let absPos = true;    // G90 default
    let absExt = true;    // M82 default (slicer usually sets M83)
    let fan = 0;          // 0..1
    const pos = { x: 0, y: 0, z: 0, e: 0 };

    const V = [];         // ordered segment vertices (6 floats per segment)
    const C = [];         // ordered segment colors (6 floats per segment)
    const ext = [];       // segment index -> 1 if extrusion, 0 if travel
    const segZ = [];      // segment index -> representative Z (mm)
    const bbox = { minx: Infinity, miny: Infinity, minz: Infinity, maxx: -Infinity, maxy: -Infinity, maxz: -Infinity };

    const cold = new THREE.Color(0xff5a3c); // fan off
    const hot = new THREE.Color(0x2f7fff);  // fan on
    const travelCol = new THREE.Color(0x4a4a4a);
    const tmp = new THREE.Color();

    function bump(x, y, z) {
      if (x < bbox.minx) bbox.minx = x;
      if (y < bbox.miny) bbox.miny = y;
      if (z < bbox.minz) bbox.minz = z;
      if (x > bbox.maxx) bbox.maxx = x;
      if (y > bbox.maxy) bbox.maxy = y;
      if (z > bbox.maxz) bbox.maxz = z;
    }

    function num(tok) {
      return parseFloat(tok.slice(1));
    }

    for (let raw of lines) {
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
      if (cmd === 'M107') { fan = 0; continue; }
      if (cmd === 'M106') {
        let s = 255;
        for (let i = 1; i < t.length; i++) {
          if (t[i][0] === 'S' || t[i][0] === 's') s = num(t[i]);
        }
        fan = Math.max(0, Math.min(1, s / 255));
        continue;
      }
      if (cmd === 'G92') {
        for (let i = 1; i < t.length; i++) {
          const c = t[i][0].toUpperCase();
          const v = num(t[i]);
          if (c === 'X') pos.x = v;
          else if (c === 'Y') pos.y = v;
          else if (c === 'Z') pos.z = v;
          else if (c === 'E') pos.e = v;
        }
        continue;
      }
      if (cmd === 'G0' || cmd === 'G1') {
        const start = { x: pos.x, y: pos.y, z: pos.z };
        let de = 0;
        for (let i = 1; i < t.length; i++) {
          const c = t[i][0].toUpperCase();
          const v = num(t[i]);
          if (isNaN(v)) continue;
          if (c === 'X') pos.x = absPos ? v : pos.x + v;
          else if (c === 'Y') pos.y = absPos ? v : pos.y + v;
          else if (c === 'Z') pos.z = absPos ? v : pos.z + v;
          else if (c === 'E') {
            if (absExt) { de = v - pos.e; pos.e = v; }
            else { de = v; pos.e += v; }
          }
        }
        const extruding = de > 1e-6;

        V.push(start.x, start.y, start.z, pos.x, pos.y, pos.z);
        if (extruding) {
          tmp.copy(cold).lerp(hot, fan);
          C.push(tmp.r, tmp.g, tmp.b, tmp.r, tmp.g, tmp.b);
          bump(start.x, start.y, start.z);
          bump(pos.x, pos.y, pos.z);
        } else {
          C.push(travelCol.r, travelCol.g, travelCol.b, travelCol.r, travelCol.g, travelCol.b);
        }
        ext.push(extruding ? 1 : 0);
        segZ.push(pos.z);
      }
    }
    return { V, C, ext, segZ, bbox };
  }

  // Estimate layer height so we can bin segments into layers by real Z. Works
  // for both planar prints (Z jumps between discrete layers) and vase-mode
  // spirals (Z climbs continuously) — the latter is measured by counting how
  // many full revolutions the toolpath makes around the model's center.
  // Median XY of the extrusion path, used as the axis to count revolutions
  // around. NOT the bbox centre: a couple of purge/prime lines at the edge of
  // the bed (every FullControl and slicer start-gcode has them) drag the bbox
  // centre right onto the toolpath, and the angle then wobbles instead of
  // accumulating a full turn per revolution — measured 86 revolutions instead
  // of 375 on a lamp, i.e. a 1.74 mm layer height reported for a 0.4 mm print.
  // The median ignores those outliers; sampling keeps it O(1) memory on big files.
  function extrusionCentre(V, ext) {
    const xs = [], ys = [];
    const step = Math.max(1, Math.floor(ext.length / 20000));
    for (let s = 0; s < ext.length; s += step) {
      if (!ext[s]) continue;
      xs.push(V[s * 6 + 3]);
      ys.push(V[s * 6 + 4]);
    }
    if (!xs.length) return [0, 0];
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    return [xs[xs.length >> 1], ys[ys.length >> 1]];
  }

  function estimateLayerHeight(V, ext, bbox) {
    const span = bbox.maxz - bbox.minz;
    if (!isFinite(span) || span <= 1e-6) return 0.2;

    const zset = new Set();
    let nExt = 0;
    for (let s = 0; s < ext.length; s++) {
      if (!ext[s]) continue;
      nExt++;
      zset.add(Math.round(V[s * 6 + 5] * 1000)); // end Z, µm-rounded
    }
    if (nExt < 2) return 0.2;

    if (zset.size < nExt * 0.4) {
      // Planar: distinct Z levels -> median gap between adjacent levels.
      const sorted = [...zset].map((v) => v / 1000).sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        const g = sorted[i] - sorted[i - 1];
        if (g > 1e-4) gaps.push(g);
      }
      gaps.sort((a, b) => a - b);
      return gaps.length ? gaps[gaps.length >> 1] : span / Math.max(1, sorted.length - 1);
    }

    // Spiral: Z ~ continuous. layers = revolutions = unwrapped angle / 2pi.
    const [cx, cy] = extrusionCentre(V, ext);

    // Skip the leading run at constant Z before counting: a solid-base spiral
    // (a bowl floor is an Archimedean spiral, ~40 turns at one Z), a brim, or
    // just the flat first turn. Those turns gain no height, so counting them
    // shrinks the estimate — a 0.40 mm bowl with a floor measured 0.31 mm, and
    // a 1.19 mm celosia pitch measured 0.62 mm. Height is measured from that
    // same Z so the two stay consistent.
    let z0 = null, start = 0;
    for (let s = 0; s < ext.length; s++) {
      if (!ext[s]) continue;
      const z = V[s * 6 + 5];
      if (z0 === null) { z0 = z; start = s; continue; }
      if (Math.abs(z - z0) > 1e-6) { start = s; break; }
    }
    const climb = bbox.maxz - (z0 === null ? bbox.minz : z0);
    if (climb <= 1e-6) return span;

    let prev = null, total = 0;
    for (let s = start; s < ext.length; s++) {
      if (!ext[s]) continue;
      const a = Math.atan2(V[s * 6 + 4] - cy, V[s * 6 + 3] - cx);
      if (prev !== null) {
        let d = a - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        total += d;
      }
      prev = a;
    }
    const revs = Math.max(1, Math.abs(total) / (2 * Math.PI));
    return climb / revs;
  }

  // --- Overhang heat map ----------------------------------------------------
  // For each extrusion segment, look one layer height below for supporting
  // material. The horizontal offset to the nearest support, over the vertical
  // gap, gives the local overhang angle from vertical: 0deg = vertical wall
  // (safe), 90deg = unsupported ceiling. Works off real Z, so it's correct for
  // vase-mode spirals too. Colors go green -> yellow -> orange -> red.
  const OVH_MAX_DIST = 3.0;   // mm: no support found within this = worst case
  const OVH_WARN = 45;        // deg from vertical where risk starts
  const OVH_FAIL = 65;        // deg where it will likely fail

  function overhangAngleToColor(deg, out) {
    let r, g, b;
    if (deg <= OVH_WARN) {
      const t = deg / OVH_WARN;           // green -> yellow
      r = 0.18 + t * 0.82; g = 0.75; b = 0.30 * (1 - t);
    } else {
      const t = Math.min(1, (deg - OVH_WARN) / (OVH_FAIL - OVH_WARN)); // yellow -> red
      r = 1.0; g = 0.75 * (1 - t); b = 0.0;
    }
    out.setRGB(r, g, b);
  }

  // Squared distance from point (px,py) to segment (x1,y1)-(x2,y2).
  function distToSegSq(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return (px - cx) ** 2 + (py - cy) ** 2;
  }

  // Returns { colors: Float32Array(len like C), maxDeg }.
  function computeOverhang(V, ext, segZ, layerH, bbox, travelCol) {
    const segCount = ext.length;
    const colors = new Float32Array(segCount * 6);
    const cell = OVH_MAX_DIST;
    const zb = (z) => Math.round(z / layerH);
    const key = (b, gx, gy) => b + ':' + gx + ':' + gy;

    // Spatial hash of extrusion SEGMENTS (continuous wall, so distance is the
    // true perpendicular gap — no tangential sampling noise). Each segment is
    // registered in the cells of both its endpoints. Entry: [x1,y1,x2,y2,z].
    const grid = new Map();
    const put = (b, gx, gy, e) => {
      const kk = key(b, gx, gy);
      let arr = grid.get(kk);
      if (!arr) { arr = []; grid.set(kk, arr); }
      arr.push(e);
    };
    for (let s = 0; s < segCount; s++) {
      if (!ext[s]) continue;
      const o = s * 6;
      const x1 = V[o], y1 = V[o + 1], x2 = V[o + 3], y2 = V[o + 4];
      const b = zb(segZ[s]);
      const e = [x1, y1, x2, y2, segZ[s]];
      put(b, Math.floor(x1 / cell), Math.floor(y1 / cell), e);
      const g2 = key(b, Math.floor(x2 / cell), Math.floor(y2 / cell));
      if (g2 !== key(b, Math.floor(x1 / cell), Math.floor(y1 / cell))) {
        put(b, Math.floor(x2 / cell), Math.floor(y2 / cell), e);
      }
    }

    const col = new THREE.Color();
    const bedZ = bbox.minz + 1.5 * layerH; // first ~layer sits on the bed
    let maxDeg = 0;
    for (let s = 0; s < segCount; s++) {
      const o = s * 6;
      if (!ext[s]) {
        colors[o] = travelCol.r; colors[o + 1] = travelCol.g; colors[o + 2] = travelCol.b;
        colors[o + 3] = travelCol.r; colors[o + 4] = travelCol.g; colors[o + 5] = travelCol.b;
        continue;
      }
      const mx = (V[o] + V[o + 3]) / 2;
      const my = (V[o + 1] + V[o + 4]) / 2;
      const mz = segZ[s];

      let deg;
      if (mz <= bedZ) {
        deg = 0;
      } else {
        const gx = Math.floor(mx / cell), gy = Math.floor(my / cell);
        const qb = zb(mz);
        let bestH = Infinity, bestDV = layerH;
        for (let bz = qb - 1; bz >= qb - 2; bz--) {
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const arr = grid.get(key(bz, gx + dx, gy + dy));
              if (!arr) continue;
              for (let i = 0; i < arr.length; i++) {
                const e = arr[i];
                const dv = mz - e[4];
                if (dv < 0.4 * layerH || dv > 2.0 * layerH) continue; // must be below
                const h2 = distToSegSq(mx, my, e[0], e[1], e[2], e[3]);
                if (h2 < bestH) { bestH = h2; bestDV = dv; }
              }
            }
          }
          if (bestH !== Infinity) break; // found support one layer down
        }
        const dist = bestH === Infinity ? OVH_MAX_DIST : Math.min(OVH_MAX_DIST, Math.sqrt(bestH));
        deg = Math.atan2(dist, bestDV) * 180 / Math.PI;
      }
      if (deg > maxDeg) maxDeg = deg;
      overhangAngleToColor(deg, col);
      colors[o] = col.r; colors[o + 1] = col.g; colors[o + 2] = col.b;
      colors[o + 3] = col.r; colors[o + 4] = col.g; colors[o + 5] = col.b;
    }
    return { colors, maxDeg };
  }

  // --- Timelapse state ------------------------------------------------------
  let lineGeom = null;      // the single ordered LineSegments geometry
  let totalSegs = 0;        // number of drawable segments
  let revealed = 0;         // how many segments are currently shown
  let playing = false;
  let segMeta = null;       // { layerAt, layerZ, layers, segsUpToLayer }

  const timebar = document.getElementById('timebar');
  const playBtn = document.getElementById('play');
  const playIcon = document.getElementById('play-icon');
  const scrub = document.getElementById('scrub');
  const tlabel = document.getElementById('tlabel');

  const layerbar = document.getElementById('layerbar');
  const layerSlider = document.getElementById('layer');
  const layerTop = document.getElementById('layer-top');
  const layerBot = document.getElementById('layer-bot');

  const modeBtn = document.getElementById('modeBtn');
  const legendFan = document.getElementById('legend-fan');
  const legendOvh = document.getElementById('legend-ovh');

  // Color mode: 'fan' or 'overhang'. Both color arrays are precomputed on load.
  let colorMode = 'fan';
  let fanColors = null;
  let overhangColors = null;
  let maxOverhang = 0;
  let baseInfo = '';

  const ICON_PLAY = 'M8 5v14l11-7z';
  const ICON_PAUSE = 'M6 5h4v14H6zm8 0h4v14h-4z';

  function applyColorMode() {
    if (lineGeom) {
      const src = colorMode === 'overhang' ? overhangColors : fanColors;
      if (src) {
        lineGeom.getAttribute('color').copyArray(src);
        lineGeom.getAttribute('color').needsUpdate = true;
      }
    }
    const ovh = colorMode === 'overhang';
    if (legendFan) legendFan.style.display = ovh ? 'none' : '';
    if (legendOvh) legendOvh.style.display = ovh ? '' : 'none';
    if (modeBtn) modeBtn.textContent = ovh ? 'Color: Overhang' : 'Color: Fan';
    updateHud();
  }

  function updateHud() {
    let s = baseInfo;
    if (colorMode === 'overhang' && overhangColors) {
      const risk = maxOverhang >= OVH_FAIL ? '⚠ likely fails' : maxOverhang >= OVH_WARN ? 'risky' : 'ok';
      s += `  ·  max overhang ${maxOverhang.toFixed(0)}° (${risk})`;
    }
    hud.textContent = s;
  }

  if (modeBtn) {
    modeBtn.addEventListener('click', () => {
      colorMode = colorMode === 'overhang' ? 'fan' : 'overhang';
      applyColorMode();
    });
  }

  // Reveal roughly the whole model in ~8s regardless of size; feels timelapse-y.
  function segsPerFrame() {
    return Math.max(1, Math.ceil(totalSegs / (8 * 60)));
  }

  function currentLayer() {
    if (!segMeta || !segMeta.layerAt.length) return 1;
    const idx = Math.max(0, Math.min(revealed - 1, segMeta.layerAt.length - 1));
    return segMeta.layerAt[idx] + 1; // 1-based
  }

  function setRevealed(n) {
    revealed = Math.max(0, Math.min(totalSegs, n | 0));
    if (lineGeom) lineGeom.setDrawRange(0, revealed * 2);
    scrub.value = String(revealed);
    if (segMeta) layerSlider.value = String(currentLayer());
    updateLabel();
  }

  // Reveal every segment up to and including layer L (1-based).
  function revealToLayer(L) {
    if (!segMeta) return;
    const l = Math.max(1, Math.min(segMeta.layers, L | 0));
    setRevealed(segMeta.segsUpToLayer[l - 1]);
  }

  function updateLabel() {
    if (!segMeta) { tlabel.textContent = ''; return; }
    tlabel.textContent = `L${currentLayer()}/${segMeta.layers}  ${revealed}/${totalSegs}`;
  }

  function setPlaying(on) {
    playing = on && revealed < totalSegs;
    playIcon.setAttribute('d', playing ? ICON_PAUSE : ICON_PLAY);
  }

  playBtn.addEventListener('click', () => {
    if (playing) { setPlaying(false); return; }
    if (revealed >= totalSegs) setRevealed(0); // replay from start
    setPlaying(true);
  });

  scrub.addEventListener('input', () => {
    setPlaying(false);
    setRevealed(parseInt(scrub.value, 10));
  });

  layerSlider.addEventListener('input', () => {
    setPlaying(false);
    revealToLayer(parseInt(layerSlider.value, 10));
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && totalSegs > 0) {
      e.preventDefault();
      playBtn.click();
    }
  });

  function animate() {
    requestAnimationFrame(animate);
    if (playing) {
      setRevealed(revealed + segsPerFrame());
      if (revealed >= totalSegs) setPlaying(false);
    }
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  function rebuild(text) {
    const t0 = performance.now();
    const { V, C, ext, segZ, bbox } = parse(text);
    const travelCol = new THREE.Color(0x4a4a4a);

    if (printGroup) {
      scene.remove(printGroup);
      printGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    printGroup = new THREE.Group();
    lineGeom = null;
    totalSegs = V.length / 6;

    // Bin segments into layers by real Z (robust for planar and vase spirals).
    const layerH = estimateLayerHeight(V, ext, bbox);
    const layers = totalSegs > 0
      ? Math.max(1, Math.round((bbox.maxz - bbox.minz) / layerH) + 1)
      : 0;
    const layerAt = new Array(totalSegs);
    const layerZ = new Array(layers);
    for (let s = 0; s < totalSegs; s++) {
      let l = Math.round((segZ[s] - bbox.minz) / layerH);
      if (l < 0) l = 0; else if (l >= layers) l = layers - 1;
      layerAt[s] = l;
      layerZ[l] = segZ[s];
    }

    // Prefix sum: segsUpToLayer[l] = # of segments in layers 0..l (inclusive).
    const segsUpToLayer = new Array(layers).fill(0);
    for (let i = 0; i < layerAt.length; i++) segsUpToLayer[layerAt[i]]++;
    for (let l = 1; l < layers; l++) segsUpToLayer[l] += segsUpToLayer[l - 1];
    segMeta = { layerAt, layerZ, layers, segsUpToLayer };

    // Precompute both color schemes: fan (from parse) and overhang heat map.
    fanColors = new Float32Array(C);
    if (V.length) {
      const ovh = computeOverhang(V, ext, segZ, layerH, bbox, travelCol);
      overhangColors = ovh.colors;
      maxOverhang = ovh.maxDeg;
    } else {
      overhangColors = null;
      maxOverhang = 0;
    }

    if (V.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
      const startColors = colorMode === 'overhang' && overhangColors ? overhangColors : fanColors;
      g.setAttribute('color', new THREE.Float32BufferAttribute(startColors.slice(), 3));
      const m = new THREE.LineBasicMaterial({ vertexColors: true });
      printGroup.add(new THREE.LineSegments(g, m));
      lineGeom = g;
    }
    scene.add(printGroup);
    if (modeBtn) modeBtn.style.display = totalSegs > 0 ? '' : 'none';

    // Timelapse + layer bar setup: start fully revealed, ready to scrub/replay.
    setPlaying(false);
    if (totalSegs > 0) {
      timebar.classList.remove('hidden');
      scrub.max = String(totalSegs);
      layerbar.classList.remove('hidden');
      layerSlider.min = '1';
      layerSlider.max = String(layers);
      const topZ = layerZ[layers - 1];
      layerTop.textContent = `${layers}\n${topZ != null ? topZ.toFixed(2) : ''}`.trim();
      layerBot.textContent = '1';
      setRevealed(totalSegs);
    } else {
      timebar.classList.add('hidden');
      layerbar.classList.add('hidden');
    }

    // Center the model on the origin and frame the camera to fit.
    baseInfo = 'no extrusion moves found';
    if (isFinite(bbox.minx)) {
      const cx = (bbox.minx + bbox.maxx) / 2;
      const cy = (bbox.miny + bbox.maxy) / 2;
      const cz = (bbox.minz + bbox.maxz) / 2;
      printGroup.position.set(-cx, -cy, -cz);
      const sx = bbox.maxx - bbox.minx;
      const sy = bbox.maxy - bbox.miny;
      const sz = bbox.maxz - bbox.minz;
      const r = Math.max(sx, sy, sz, 1);
      controls.target.set(0, 0, 0);
      camera.position.set(r * 1.1, -r * 1.1, r * 0.9);
      camera.near = r / 100;
      camera.far = r * 100;
      camera.updateProjectionMatrix();
      baseInfo =
        `${totalSegs} moves · ${layers} layers · ` +
        `bbox ${sx.toFixed(1)}×${sy.toFixed(1)}×${sz.toFixed(1)} mm · ` +
        `parsed in ${(performance.now() - t0).toFixed(0)} ms`;
    }
    applyColorMode();
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.type === 'gcode') {
      try {
        rebuild(msg.text || '');
      } catch (err) {
        hud.textContent = 'parse error: ' + (err && err.message ? err.message : err);
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
