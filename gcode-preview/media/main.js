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

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // --- G-code parsing -------------------------------------------------------
  // Produces two arrays of vertices+colors: extrusion segments (colored by fan)
  // and travel segments (dim gray). Handles G90/G91, M82/M83, G92, M106/M107.
  function parse(text) {
    const lines = text.split(/\r?\n/);
    let absPos = true;    // G90 default
    let absExt = true;    // M82 default (many printers use M83 relative; slicer sets it)
    let fan = 0;          // 0..1
    const pos = { x: 0, y: 0, z: 0, e: 0 };

    const extV = [];   // extrusion vertices (pairs)
    const extC = [];   // extrusion colors
    const trvV = [];   // travel vertices
    const bbox = { minx: Infinity, miny: Infinity, minz: Infinity, maxx: -Infinity, maxy: -Infinity, maxz: -Infinity };

    const cold = new THREE.Color(0xff5a3c); // fan off
    const hot = new THREE.Color(0x2f7fff);  // fan on
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
        if (extruding) {
          extV.push(start.x, start.y, start.z, pos.x, pos.y, pos.z);
          tmp.copy(cold).lerp(hot, fan);
          extC.push(tmp.r, tmp.g, tmp.b, tmp.r, tmp.g, tmp.b);
          bump(start.x, start.y, start.z);
          bump(pos.x, pos.y, pos.z);
        } else {
          trvV.push(start.x, start.y, start.z, pos.x, pos.y, pos.z);
        }
      }
    }
    return { extV, extC, trvV, bbox };
  }

  function rebuild(text) {
    const t0 = performance.now();
    const { extV, extC, trvV, bbox } = parse(text);

    if (printGroup) {
      scene.remove(printGroup);
      printGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    printGroup = new THREE.Group();

    if (extV.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(extV, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(extC, 3));
      const m = new THREE.LineBasicMaterial({ vertexColors: true });
      printGroup.add(new THREE.LineSegments(g, m));
    }
    if (trvV.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(trvV, 3));
      const m = new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.35 });
      printGroup.add(new THREE.LineSegments(g, m));
    }
    scene.add(printGroup);

    // Center the model on the origin and frame the camera to fit.
    let info = 'no extrusion moves found';
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
      const segs = extV.length / 6;
      info =
        `${segs} extrusion segs · ` +
        `bbox ${sx.toFixed(1)}×${sy.toFixed(1)}×${sz.toFixed(1)} mm · ` +
        `parsed in ${(performance.now() - t0).toFixed(0)} ms`;
    }
    hud.textContent = info;
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
