// Minimal STL loader (binary + ASCII). Returns a flat Float32Array of triangle
// vertices: [ax,ay,az, bx,by,bz, cx,cy,cz, ...]. Normals are ignored — the
// slicer derives everything from geometry.

export function parseStl(data: Uint8Array): Float32Array {
  if (data.length >= 84) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = dv.getUint32(80, true);
    if (data.length === 84 + 50 * count) {
      return parseBinary(dv, count);
    }
  }
  return parseAscii(new TextDecoder().decode(data));
}

function parseBinary(dv: DataView, count: number): Float32Array {
  const out = new Float32Array(count * 9);
  let p = 0;
  for (let i = 0; i < count; i++) {
    let base = 84 + i * 50 + 12; // skip normal
    for (let k = 0; k < 9; k++) {
      out[p++] = dv.getFloat32(base, true);
      base += 4;
    }
  }
  return out;
}

function parseAscii(text: string): Float32Array {
  const verts: number[] = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    verts.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  }
  return new Float32Array(verts);
}
