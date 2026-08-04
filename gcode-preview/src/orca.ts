// Drive OrcaSlicer headlessly and get plain G-code back.
//
// Orca's `--export-3mf out.gcode.3mf` writes a ZIP whose sliced G-code lives at
// Metadata/plate_1.gcode. We shell out to the Orca binary, then extract that
// entry from the archive (no external unzip dependency — just zlib).

import { execFile } from 'child_process';
import * as zlib from 'zlib';

export interface OrcaConfig {
  binary: string;          // path to the OrcaSlicer executable
  machineSettings: string; // machine .json (printer)
  processSettings: string; // process .json (print profile)
  filament: string;        // filament .json
  extraArgs: string[];     // any additional flags
}

// Build the CLI args to slice `input` (STL or 3MF) into `output3mf`.
export function buildOrcaArgs(cfg: OrcaConfig, input: string, output3mf: string): string[] {
  const settings = [cfg.machineSettings, cfg.processSettings].filter(Boolean).join(';');
  const args: string[] = ['--slice', '1'];
  if (settings) args.push('--load-settings', settings);
  if (cfg.filament) args.push('--load-filaments', cfg.filament);
  args.push('--allow-newer-file');
  args.push(...cfg.extraArgs);
  args.push('--export-3mf', output3mf);
  args.push(input);
  return args;
}

export function runOrca(
  cfg: OrcaConfig,
  input: string,
  output3mf: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  const args = buildOrcaArgs(cfg, input, output3mf);
  return new Promise((resolve, reject) => {
    execFile(cfg.binary, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Orca CLI failed: ${err.message}\n${stderr || stdout}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// --- Minimal ZIP reader (central-directory based) --------------------------

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

// Extract the first archive entry whose name matches `pred`. Returns its bytes.
export function extractZipEntry(zip: Buffer, pred: (name: string) => boolean): Buffer | null {
  // Locate End Of Central Directory (search backwards; comment is usually empty).
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16); // central directory offset

  for (let e = 0; e < entries; e++) {
    if (zip.readUInt32LE(p) !== CDH_SIG) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const fnLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + fnLen);

    if (pred(name)) {
      // Local header: 30 bytes fixed + filename + extra, then data.
      const lFnLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lFnLen + lExtraLen;
      const data = zip.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data);       // stored
      if (method === 8) return zlib.inflateRawSync(data); // deflate
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    p += 46 + fnLen + extraLen + commentLen;
  }
  return null;
}

// Pull the sliced G-code text out of an Orca `.gcode.3mf` archive.
export function extractGcodeFrom3mf(zip: Buffer): string {
  const entry =
    extractZipEntry(zip, (n) => /Metadata\/plate_\d+\.gcode$/i.test(n)) ||
    extractZipEntry(zip, (n) => /\.gcode$/i.test(n));
  if (!entry) throw new Error('No plate_N.gcode found inside the .gcode.3mf archive.');
  return entry.toString('utf8');
}
