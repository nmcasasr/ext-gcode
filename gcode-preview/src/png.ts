// Minimal PNG encoder — 8-bit RGBA, no interlacing, no palette.
//
// Bambu's `.gcode.3mf` carries five PNG previews. To replace them we need to
// write PNGs, and the format's happy path is small: a signature, three chunks,
// and zlib (which Node already has, and which the ZIP writer next door already
// depends on). The CRC32 is shared with `zip.ts` — same polynomial, same table.

import * as zlib from 'zlib';
import { crc32 } from './zip';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crcInput = Buffer.concat([head.subarray(4, 8), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([head, data, tail]);
}

// `rgba` is width*height*4 bytes, row-major, non-premultiplied.
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte per scanline. Filter 0 (None) is enough: these previews are
  // mostly flat transparent background, which deflate handles well on its own.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
