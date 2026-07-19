# G-code Live Preview (VS Code)

Edit a `.gcode` file in VS Code and see a live 3D preview in a side panel. Extrusion
moves are colored by fan state so you can see where cooling is on/off:

- **blue** = fan on (`M106 S255`)
- **red** = fan off (`M107`)
- **dim gray** = travel moves

Handles `G0/G1`, `G90/G91` (abs/rel), `M82/M83` (extruder abs/rel), `G92`, and
`M106/M107`. Works with continuous spiral (vase mode) g-code since it just plots the
extrusion path.

## Run it (development host)

```bash
npm install
npm run compile      # or: npm run watch  (recompiles on change)
```

Then in VS Code:

1. Open this folder in VS Code.
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
