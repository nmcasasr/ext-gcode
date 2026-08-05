// Minimal ZIP reader/writer — enough for Bambu/Orca `.gcode.3mf` archives.
//
// A `.gcode.3mf` is just a ZIP. We need to read one apart, swap an entry, and
// write it back, so this does both halves. No external dependency (zlib only),
// matching the rest of the project.
//
// Deliberately narrow: no ZIP64, no encryption, no data descriptors on write
// (we always know the sizes up front). Orca's own archives use stored (0) for
// the PNGs and deflate (8) for everything else; both are handled.

import * as zlib from 'zlib';

const LFH_SIG = 0x04034b50; // local file header
const CDH_SIG = 0x02014b50; // central directory header
const EOCD_SIG = 0x06054b50; // end of central directory

export interface ZipEntry {
  name: string;
  data: Buffer; // uncompressed
  store: boolean; // true = write back as-is, false = deflate
}

// --- CRC32 ------------------------------------------------------------------
// Hand-rolled rather than zlib.crc32: that landed in Node 22 and the extension
// still compiles against older @types/node.

let CRC_TABLE: Int32Array | null = null;
function crcTable(): Int32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(buf: Buffer): number {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// --- Read -------------------------------------------------------------------

// Walk the central directory and return every entry, decompressed.
export function listZipEntries(zip: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');

  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];

  for (let e = 0; e < count; e++) {
    if (zip.readUInt32LE(p) !== CDH_SIG) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const fnLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + fnLen);

    // The local header repeats the name/extra lengths, and they can differ from
    // the central directory's — always take the data offset from the local one.
    const lFnLen = zip.readUInt16LE(localOff + 26);
    const lExtraLen = zip.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lFnLen + lExtraLen;
    const raw = zip.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);

    // Directory markers carry no payload; skip them so a round-trip is clean.
    if (!name.endsWith('/')) out.push({ name, data, store: method === 0 });
    p += 46 + fnLen + extraLen + commentLen;
  }
  return out;
}

export function findEntry(entries: ZipEntry[], pred: (name: string) => boolean): ZipEntry | undefined {
  return entries.find((e) => pred(e.name));
}

// --- Write ------------------------------------------------------------------

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

// Build a ZIP from `entries`, preserving their order.
export function writeZip(entries: ZipEntry[], when: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.store ? 0 : 8;
    const body = entry.store ? entry.data : zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags: no data descriptor, sizes are known here
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(entry.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(CDH_SIG, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(date, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(entry.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk number
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}
