// Minimal ZIP reader (stored + deflate) using the browser's DecompressionStream('deflate-raw') (Safari 16.4+).
// Reads the central directory, so data descriptors and odd local headers are fine. ZIP64 sizes are supported for
// entries/offsets that need them.
const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const u64 = (d, o) => u32(d, o) + u32(d, o + 4) * 2 ** 32;

export const isZip = (b) => b && b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) ;

export function listZip(d) {
  let e = -1;
  for (let i = d.length - 22; i >= Math.max(0, d.length - 65558); i--) if (u32(d, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Not a zip file');
  let n = u16(d, e + 10), off = u32(d, e + 16);
  if (off === 0xffffffff || n === 0xffff) { // ZIP64 end of central directory
    const loc = e - 20;
    if (u32(d, loc) === 0x07064b50) { const z = u64(d, loc + 8); n = u64(d, z + 32); off = u64(d, z + 48); }
  }
  const out = [], dec = new TextDecoder();
  for (let k = 0, p = off; k < n; k++) {
    if (u32(d, p) !== 0x02014b50) throw new Error('Damaged zip file');
    const method = u16(d, p + 10), flags = u16(d, p + 8);
    let csize = u32(d, p + 20), size = u32(d, p + 24), loff = u32(d, p + 42);
    const nl = u16(d, p + 28), xl = u16(d, p + 30), cl = u16(d, p + 32);
    const name = flags & 0x800 ? dec.decode(d.subarray(p + 46, p + 46 + nl)) : dec.decode(d.subarray(p + 46, p + 46 + nl));
    // ZIP64 extra field
    for (let x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {
      const id = u16(d, x), len = u16(d, x + 2); let q = x + 4;
      if (id === 1) { if (size === 0xffffffff) { size = u64(d, q); q += 8; } if (csize === 0xffffffff) { csize = u64(d, q); q += 8; } if (loff === 0xffffffff) { loff = u64(d, q); } }
      x += 4 + len;
    }
    const tm = u16(d, p + 12), dt = u16(d, p + 14); // DOS local time
    const mtime = dt ? new Date(1980 + (dt >> 9), ((dt >> 5) & 15) - 1, dt & 31, tm >> 11, (tm >> 5) & 63, (tm & 31) * 2).getTime() : null;
    out.push({ name, method, csize, size, loff, mtime, dir: name.endsWith('/') });
    p += 46 + nl + xl + cl;
  }
  return out;
}

export async function readEntry(d, ent) {
  const p = ent.loff;
  if (u32(d, p) !== 0x04034b50) throw new Error('Damaged zip entry');
  const start = p + 30 + u16(d, p + 26) + u16(d, p + 28);
  const raw = d.subarray(start, start + ent.csize);
  if (ent.method === 0) return raw.slice();
  if (ent.method !== 8) throw new Error('Unsupported zip compression');
  if (typeof DecompressionStream === 'undefined') throw new Error('This iPad is too old to open zip files (needs iPadOS 16.4)');
  const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
