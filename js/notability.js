// Notability import.
// Notability's "export with audio" gives a zip per note:  <Title>/<Title>.pdf  +  <Title>/Recordings/Recording N.m4a
// The handwriting is already drawn into that PDF (it can't be edited as Inkwell ink) and the export carries no
// per-stroke timing, so recordings come in unsynced: they play, scrub and export normally, but tapping ink can't jump.
// Native .note archives (Session.plist, no PDF) aren't supported: we say so and suggest the PDF + audio export.
import { isZip, listZip, readEntry } from './unzip.js';
import * as store from './store.js';

export const looksNotability = (bytes, name = '') => isZip(bytes) || /\.(note|zip)$/i.test(name);

// MP4/M4A duration from the 'mvhd' box (no decoding needed)
export function m4aDuration(b) {
  const box = (s, e, type) => {
    for (let p = s; p + 8 <= e;) {
      let size = (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0, hdr = 8;
      const t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (size === 1) { size = ((b[p + 8] << 24 | b[p + 9] << 16 | b[p + 10] << 8 | b[p + 11]) >>> 0) * 2 ** 32 + ((b[p + 12] << 24 | b[p + 13] << 16 | b[p + 14] << 8 | b[p + 15]) >>> 0); hdr = 16; }
      if (size === 0) size = e - p;
      if (size < hdr) return null;
      if (t === type) return [p + hdr, p + size];
      p += size;
    }
    return null;
  };
  try {
    const moov = box(0, b.length, 'moov'); if (!moov) return 0;
    const mv = box(moov[0], moov[1], 'mvhd'); if (!mv) return 0;
    const v = new DataView(b.buffer, b.byteOffset + mv[0]);
    const ver = v.getUint8(0);
    const ts = ver === 1 ? v.getUint32(20) : v.getUint32(12);
    const dur = ver === 1 ? v.getUint32(24) * 2 ** 32 + v.getUint32(28) : v.getUint32(16);
    return ts ? Math.round(dur / ts * 1000) : 0;
  } catch { return 0; }
}

// -> [{title, pdf: Uint8Array, recordings: [{name, bytes}]}]
export async function readNotabilityZip(bytes) {
  const ents = listZip(bytes).filter((e) => !e.dir && !/(^|\/)(__MACOSX|\._)/.test(e.name));
  const pdfs = ents.filter((e) => /\.pdf$/i.test(e.name) && !/\/PDFs\//i.test(e.name));
  if (!pdfs.length) {
    if (ents.some((e) => /Session\.plist$/i.test(e.name))) {
      const err = new Error('This is a Notability “.note” file. Inkwell can’t read that format yet: in Notability, export the note as PDF (with audio) and import the zip.');
      err.notability = 'native'; throw err;
    }
    throw Object.assign(new Error('No PDF found in this zip (expected a Notability export: a PDF plus a Recordings folder).'), { notability: 'nopdf' });
  }
  const dirOf = (n) => n.includes('/') ? n.slice(0, n.lastIndexOf('/') + 1) : '';
  const notes = [];
  for (const p of pdfs) {
    const dir = dirOf(p.name);
    const recs = ents.filter((e) => e.name.startsWith(dir + 'Recordings/') && /\.(m4a|mp4|aac|caf|wav|mp3)$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const title = p.name.slice(dir.length).replace(/\.pdf$/i, '');
    notes.push({ title, pdf: await readEntry(bytes, p), recordings: await Promise.all(recs.map(async (r) => ({ name: r.name.slice(r.name.lastIndexOf('/') + 1), bytes: await readEntry(bytes, r) }))) });
  }
  return notes;
}

const MIME = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', caf: 'audio/x-caf', wav: 'audio/wav', mp3: 'audio/mpeg' };
// importPdf(bytes, title, folderId, driveId) -> doc id (the normal PDF import, incl. white-border trim)
export async function importNotability(bytes, name, folderId, driveId, importPdf) {
  const notes = await readNotabilityZip(bytes);
  const ids = [];
  for (const n of notes) {
    const id = await importPdf(n.pdf, (notes.length === 1 ? (name.replace(/\.(zip|note)$/i, '') || n.title) : n.title) + '.pdf', folderId, notes.length === 1 ? driveId : null);
    if (n.recordings.length) {
      const d = await store.loadDoc(id);
      d.body.recordings = d.body.recordings || [];
      for (const r of n.recordings) {
        const rid = store.uid();
        const ext = (r.name.split('.').pop() || 'm4a').toLowerCase();
        const mime = MIME[ext] || 'audio/mp4';
        await store.saveAudio({ id: rid, docId: id, folderId, mime, bytes: r.bytes });
        d.body.recordings.push({ id: rid, startedAt: d.meta.createdAt, dur: m4aDuration(r.bytes), mime, size: r.bytes.length, title: r.name.replace(/\.[^.]+$/, ''), source: 'notability', unsynced: true });
      }
      d.meta.source = 'notability';
      await store.saveDoc(d);
    }
    ids.push(id);
  }
  return ids;
}
