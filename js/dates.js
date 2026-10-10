// Original "date created" for imported notes (Notability / scanned PDFs keep their real date in the name or the audio,
// while the PDF's own CreationDate is usually the export time).
// Order: date in the file name -> recording's MP4 creation time -> PDF CreationDate -> zip entry time.
// The last two only count when clearly older than the import (> 7 days), so an export timestamp is never mistaken for it.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEK = 7 * 864e5;
const sane = (t) => Number.isFinite(t) && t > Date.UTC(1990, 0, 1) && t < Date.now() + 864e5;

// 'Note Sep 30, 2017 8_09_12 PM', 'Dec 4, 2018 Pacer', 'Dec 13 2018 …', '30 Sep 2017', '2017-09-30 08.09', '20170930_080912'
export function dateFromName(name) {
  if (!name) return null;
  const s = String(name).replace(/\.(pdf|zip|note)$/i, '');
  const time = (rest) => {
    const m = /^[\s_,at-]*(\d{1,2})[_:.](\d{2})(?:[_:.](\d{2}))?\s*([AaPp])?\.?[Mm]?\b/.exec(rest || '');
    if (!m) return [0, 0, 0];
    let hh = +m[1]; const ap = (m[4] || '').toLowerCase();
    if (ap === 'p' && hh < 12) hh += 12; if (ap === 'a' && hh === 12) hh = 0;
    return hh < 24 && +m[2] < 60 ? [hh, +m[2], +(m[3] || 0)] : [0, 0, 0];
  };
  const mk = (y, mo, d, rest) => { if (mo < 0 || mo > 11 || d < 1 || d > 31) return null; const [hh, mi, se] = time(rest); const t = new Date(y, mo, d, hh, mi, se).getTime(); return sane(t) ? t : null; };
  let m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})(.*)$/i.exec(s);
  if (m) return mk(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2], m[4]);
  m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+((?:19|20)\d{2})(.*)$/i.exec(s);
  if (m) return mk(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1], m[4]);
  m = /\b((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ T_-]+(\d{2})[-_.:]?(\d{2})(?:[-_.:]?(\d{2}))?)?/.exec(s);
  if (m) { const t = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime(); return +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 && sane(t) ? t : null; }
  return null;
}

// PDF date string "D:20171005083000-05'00'"
export function parsePdfDate(v) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(String(v || ''));
  if (!m) return null;
  const [y, mo, d, hh, mi, se] = [+m[1], +(m[2] || 1) - 1, +(m[3] || 1), +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
  let t = Date.UTC(y, mo, d, hh, mi, se);
  if (m[7] === '+' || m[7] === '-') t -= (m[7] === '+' ? 1 : -1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000;
  else if (!m[7]) t = new Date(y, mo, d, hh, mi, se).getTime();
  return sane(t) ? t : null;
}

// MP4/M4A creation time from 'mvhd' (seconds since 1904-01-01 UTC)
export function m4aCreated(b) {
  try {
    const find = (s, e, type) => { for (let p = s; p + 8 <= e;) { const size = new DataView(b.buffer, b.byteOffset + p, 8).getUint32(0); const t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]); if (size < 8) return null; if (t === type) return [p + 8, p + size]; p += size; } return null; };
    const moov = find(0, b.length, 'moov'); if (!moov) return null;
    const mv = find(moov[0], moov[1], 'mvhd'); if (!mv) return null;
    const v = new DataView(b.buffer, b.byteOffset + mv[0]);
    const secs = v.getUint8(0) === 1 ? v.getUint32(4) * 2 ** 32 + v.getUint32(8) : v.getUint32(4);
    const t = (secs - 2082844800) * 1000;
    return secs && sane(t) ? t : null;
  } catch { return null; }
}

// pick the best candidate. c = {name, audio: [ms], pdf: ms, zip: ms, importedAt: ms} -> {t, src} | null
export function pickCreated(c) {
  const fromName = dateFromName(c.name);
  if (fromName) return { t: fromName, src: 'name' };
  const aud = (c.audio || []).filter(sane);
  if (aud.length) return { t: Math.min(...aud), src: 'audio' };
  const old = (t) => sane(t) && (!c.importedAt || t < c.importedAt - WEEK);
  if (old(c.pdf)) return { t: c.pdf, src: 'pdf' };
  if (old(c.zip)) return { t: c.zip, src: 'zip' };
  return null;
}
