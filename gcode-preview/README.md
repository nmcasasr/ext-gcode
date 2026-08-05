# G-code Live Preview (VS Code)

Edit a `.gcode` file in VS Code and see a live 3D preview in a side panel. Extrusion
moves are colored by fan state so you can see where cooling is on/off:

- **blue** = fan on (`M106 S255`)
- **red** = fan off (`M107`)
- **dim gray** = travel moves

Handles `G0/G1`, `G90/G91` (abs/rel), `M82/M83` (extruder abs/rel), `G92`, and
`M106/M107`. Works with continuous spiral (vase mode) g-code since it just plots the
extrusion path.

The preview also has a **timelapse scrub bar** (play/pause + move slider, spacebar
to toggle) and a **vertical layer slider** on the right, both synced — drag layers
for coarse control, moves for fine.

**Overhang heat map:** the **Color: Fan / Overhang** button (top-right) recolors
the print by local overhang angle. For each extrusion it looks one layer height
below for supporting wall and measures the perpendicular gap → angle from vertical:
green (0–30°, safe) → yellow (~45°) → orange (~55°) → red (65°+, likely fails). The
HUD shows the worst angle. Works on any g-code, and correctly handles vase-mode
spirals (layers are detected by real Z / revolutions, not by "Z went up").

## Vase-mode slicer (STL → G-code)

There's a built-in **spiralize / vase-mode slicer**: it takes an `.stl` with a
single closed contour per layer (vase, cup, cone, twisted tube…) and emits one
continuous helical extrusion path.

1. Right-click an `.stl` in the Explorer (or open one) → **"STL → Vase G-code"**.
   A `<name>.vase.gcode` is written next to it and opens in the preview.
2. Generate a test model any time with `node tools/make-vase-stl.js` → `vase.stl`.

Defaults live in `src/vase.ts` (`DEFAULT_OPTIONS`): 0.3 mm layers, 0.45 mm line,
1.75 mm filament, 210/60 °C, centered on a 110×110 bed. The floor is left open
(pure vase); a solid base would need scanline infill — see next steps.

## Overhang clamp (STL → printable STL)

**"STL → Clamp Overhangs"** reshapes a vase-like model so no wall leans past a
target angle from vertical (setting `gcodePreview.clampAngle`, default 45°). It
slices into aligned contours, then walks bottom→top pulling any point that sits
more than `layerHeight · tan(angle)` from the wall below back toward its support
— shaving bulges and over-aggressive twists into a printable shape. Writes
`<name>.fixed.stl`. It matches the preview's overhang metric, so it targets
exactly the red zones. (Single-contour models only; changes the design.)

## Orca CLI + full pipeline

- **"STL → Slice with OrcaSlicer"** shells out to the real Orca CLI headlessly,
  extracts the plain g-code from the `.gcode.3mf` archive, and previews it.
  Configure `gcodePreview.orcaBinary` and the machine/process/filament JSON paths
  (export those from OrcaSlicer) in Settings.
- **"STL → Pipeline"** chains it all: clamp overhangs → Orca slice → preview the
  overhang heat map, in one command.
- **"G-code: Watch File for Changes"** watches a file on disk (e.g. one Orca keeps
  re-exporting) and auto-refreshes the preview — no reopen/save needed.
- **"G-code: Watch Folder (preview newest)"** watches a whole directory and always
  previews the newest g-code in it (also on the right-click menu of any folder).

## Live loop with a g-code generator

Watching a folder turns the preview into the viewer for any tool that writes
g-code — in particular the FullControl lamp generators in `../vacante-g-code`,
which write a new `output/<nombre>.gcode` per run:

1. Right-click `fullcontrol-lamparas/output/` → **"G-code: Watch Folder"**
   (the folder can still be empty).
2. `python -m lamparas.bowls celosia --altura 70` → the preview picks it up.
3. Change parameters, re-run. Each run replaces the view; the layer slider and
   the overhang heat map come along for free.

An eye icon in the status bar shows what's being watched; click it to stop.

Two details that make this reliable, both load-bearing:

- **The watcher watches the directory, not the file.** `fs.watch` on a path
  follows the inode, so a generator that writes a temp file and renames it over
  the target goes completely undetected (measured on macOS: zero events, from
  the first rename on). Directory watching also lets you arm the watcher before
  the file exists, which is the normal case for a gitignored `output/`.
- **It waits for the write to settle.** A multi-MB export fires its first change
  event long before it is done, so the watcher polls until the file size stops
  moving before parsing. On the generator side `guardar_gcode()` writes
  `.gcode.tmp` and renames, so a reader sees either the old file or the whole
  new one — never half of either.

## Printing it — no SD card

The A1 will not start a plain `.gcode`: Bambu Studio and the firmware only accept
a `.gcode.3mf` container. And the OrcaSlicer CLI cannot send one — checked
against 2.4.2, there is no `--send`, `--upload` or `--print-host`; "Upload &
Print" exists only in the GUI. So we build the container ourselves.

**"G-code → Bambu 3mf (printable over LAN)"** (also on the right-click menu of
any `.gcode`) wraps a toolpath in a real `.gcode.3mf`. Open the result in Bambu
Studio and press Print.

It needs a **template** the first time: a `.gcode.3mf` you exported from
OrcaSlicer for *your* printer and nozzle (slice anything — a cube is ideal — and
"Export plate sliced file"). The command asks for it once and remembers it in
`gcodePreview.bambuTemplate`. The template is what makes the output
machine-correct: its machine start/end g-code, its bed levelling, its filament
settings are all reused verbatim. We never synthesise Bambu start g-code.

What gets rebuilt around your toolpath:

- The **md5** in `Metadata/plate_1.gcode.md5`. The firmware checks it; leaving
  the template's would get the job rejected.
- The **adaptive bed mesh** (`G29 A1 X… Y… I… J…`), re-aimed at your model's
  real first-layer footprint. The template's numbers probe the *old* object's
  area — a 29.6 mm cube's mesh levels nothing under a 150 mm lamp.
- **Progress**: `M73` percent/time and layer markers, spread across the body.
  Without this the display jumps to 47 % before the first extrusion (the cube's
  start g-code alone climbs that high), sits there all print, then snaps to 98 %.
- **Layer markers** — `; CHANGE_LAYER` / `; Z_HEIGHT:` / `; LAYER_HEIGHT:` per
  layer, against real Z. These are not decoration: a slicer's viewer builds its
  layer slider from them and takes `; Z_HEIGHT:` as authoritative over the Z in
  the moves. Emitting one at the top of the graft rendered a 58 mm bowl as a flat
  pancake. `; LAYER_HEIGHT:` is the *bead* height (derived from the flow), not
  the spiral pitch — viewers draw width as volume / (length · that), so the pitch
  drew 0.277 mm beads for a 0.800 mm bead and the whole model looked full of
  holes.
- **The five preview PNGs**, rendered from the toolpath in the filament colour.
- Header layer count / max Z, the plate bbox, and the weight and time estimates.

Your g-code's own start/end block is stripped. It recognises the FullControl
lamps' `;===== FIN DEL START GCODE =====` markers, an existing Orca export, or
falls back to dropping `G28`/`G29`/`M104`/`M109`/`M140`/`M190`/`M84`. The
positioning and extrusion mode (`G90`/`G91`, `M82`/`M83`) is carried across the
cut and re-declared — FullControl puts its `M83` in the header, above the
marker, so a body read as absolute decodes to nonsense.

From the terminal instead:

```bash
node tools/make-3mf.js path/to/file.gcode --template ref.gcode.3mf
```

Two things to know:

- **The thumbnails are rendered from the toolpath**, not from a mesh — the 3mf
  has no geometry. For spiralised and openwork pieces that is exactly right, the
  object *is* its toolpath. A densely infilled solid would read as a scribble;
  slice those normally instead. (`src/thumbnail.ts` + `src/png.ts`, no deps.)
- **The nozzle must match.** The template records a nozzle diameter and the
  printer refuses the job if it differs from the one installed. Temperatures come
  from the template too, not from your generator's start g-code.

Test fixtures: `node tools/make-vase-stl.js` (twisted vase) and `cone.stl` (a
steep 62° flare — good for seeing the clamp work). Report any g-code's overhangs
from the terminal with `node tools/overhang-report.js <file.gcode>`.

## Install it (normal use)

```bash
npm install
npm run reinstall    # packages a .vsix and installs it into VS Code
```

Reload the window afterwards (`Developer: Reload Window`). The commands are then
available in **every** VS Code window — no F5, no Extension Development Host, no
special workspace needed. Re-run `npm run reinstall` after changing the source.

## Run it instead (development host)

Only needed when you want breakpoints in the extension itself.

```bash
npm install
npm run compile      # or: npm run watch  (recompiles on change)
```

Then in VS Code:

1. Open **this folder** in VS Code — not a parent folder, since `launch.json`
   resolves the extension path from `${workspaceFolder}`.
2. Press **F5** (Run > Start Debugging). A second VS Code window opens
   ("Extension Development Host").
3. In that window, open a `.gcode` file (there's `sample.gcode` here).
4. Command Palette (Cmd+Shift+P) -> **"G-code: Open Live Preview"**, or click the
   preview icon in the editor title bar.
5. Edit the g-code and **save** (or just type — it live-updates after 300 ms).

## How the live preview works

- `extension.ts` opens a Webview panel beside the editor and sends the document
  text to it. It re-sends on save (`onDidSaveTextDocument`) and, debounced, on every
  edit (`onDidChangeTextDocument`). That's the whole hot-reload loop.
- `media/main.js` parses the text and draws it with three.js, coloring each
  extrusion segment by the current fan value.

## Notes / next steps

- three.js is loaded from cdnjs (needs internet). To go fully offline, download
  `three.min.js` + `OrbitControls.js` into `media/` and point the `<script>` tags in
  `extension.ts` (`getHtml`) at local `webview.asWebviewUri(...)` paths, and drop the
  cdn entry from the CSP.
- For your use case (turning the fan on/off over the pico bands), you can extend the
  parser to also draw a Z ruler or highlight specific Z ranges.
- Big files: this draws every segment as a line. If you throw a huge print at it and
  it gets slow, the usual fix is to decimate travel moves or use a single merged
  geometry per color.
