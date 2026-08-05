// Pack a plain .gcode into a Bambu .gcode.3mf you can open in Bambu Studio and
// print over LAN — no SD card.
//
// Needs a *template*: a real .gcode.3mf you exported from OrcaSlicer for your
// own machine and nozzle. Its machine start/end G-code and settings are what
// make the result printable; we only graft the toolpath into the middle.
//
// Usage:
//   node tools/make-3mf.js <file.gcode> --template <ref.gcode.3mf> [-o out.gcode.3mf]
//
// Requires `npm run compile` first (it loads the compiled out/bambu.js).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let input = null, template = null, output = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--template' || a === '-t') template = args[++i];
  else if (a === '-o' || a === '--out') output = args[++i];
  else if (!input) input = a;
}

if (!input || !template) {
  console.error('Usage: node tools/make-3mf.js <file.gcode> --template <ref.gcode.3mf> [-o out.gcode.3mf]');
  process.exit(1);
}

let packBambu3mf;
try {
  ({ packBambu3mf } = require(path.join(__dirname, '..', 'out', 'bambu.js')));
} catch (err) {
  console.error('Could not load out/bambu.js — run `npm run compile` first.\n' + err.message);
  process.exit(1);
}

const name = path.basename(input).replace(/\.gcode$/i, '');
output = output || path.join(path.dirname(input), `${name}.gcode.3mf`);

const result = packBambu3mf(fs.readFileSync(template), fs.readFileSync(input, 'utf8'), name);
fs.writeFileSync(output, result.zip);

const s = result.stats;
console.log(`\nWrote ${output}  (${(result.zip.length / 1024).toFixed(0)} KB)`);
console.log(`  template   ${template}`);
console.log(`  size       ${(s.maxx - s.minx).toFixed(1)} x ${(s.maxy - s.miny).toFixed(1)} x ${(s.maxz - s.minz).toFixed(1)} mm`);
console.log(`  layers     ${s.layerCount} at ~${s.layerHeight.toFixed(3)} mm`);
console.log(`  filament   ${s.filamentMm.toFixed(0)} mm`);
console.log(`  est. time  ${Math.round(s.seconds / 60)} min`);
console.log(`  md5        ${result.md5}`);
console.log('\nOpen it in Bambu Studio and press Print. The thumbnail will still be the');
console.log("template's — cosmetic only.\n");
