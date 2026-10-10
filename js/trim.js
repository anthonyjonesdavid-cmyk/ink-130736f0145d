// Trim white borders on PDF pages (e.g. scans exported from another notes app with the page drawn inside a white sheet).
// Non-destructive: the original PDF is never changed. Each page keeps page.trim = {x, y, w, h, ow, oh} (in the PDF's own
// viewport units) and page.cropped says whether it is applied. When applied the page is shown as the trimmed size and
// ink/photos are shifted by the same offset, so they stay on the same spot of the content; turning it off shifts back.

const SIDE = 600;       // detection render size (longest side, px)
const TOL = 12;         // channel difference from the margin colour that counts as content
const MIN_MARGIN = 0.015; // a side must be at least 1.5% of the page to count as a margin

// -> {x, y, w, h, ow, oh} or null when the page has no uniform white margin around a filled page
export async function detectTrim(pdfDoc, pdfIndex) {
  const pg = await pdfDoc.getPage(pdfIndex + 1);
  const v1 = pg.getViewport({ scale: 1 });
  const s = SIDE / Math.max(v1.width, v1.height);
  const vp = pg.getViewport({ scale: s });
  const W = Math.max(1, Math.round(vp.width)), H = Math.max(1, Math.round(vp.height));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  try { await pg.render({ canvasContext: ctx, viewport: vp }).promise; } catch { return null; }
  const d = ctx.getImageData(0, 0, W, H).data;
  c.width = c.height = 0;
  const px = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  // margin colour: the four corners must agree and be (near) white
  const corners = [px(1, 1), px(W - 2, 1), px(1, H - 2), px(W - 2, H - 2)];
  if (corners.some((p) => Math.min(...p) < 225)) return null;
  const m = [0, 1, 2].map((k) => corners.reduce((a, p) => a + p[k], 0) / 4);
  const ink = new Uint8Array(W * H);
  const rows = new Uint32Array(H), cols = new Uint32Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (Math.abs(d[i] - m[0]) > TOL || Math.abs(d[i + 1] - m[1]) > TOL || Math.abs(d[i + 2] - m[2]) > TOL) { ink[y * W + x] = 1; rows[y]++; cols[x]++; }
  }
  const rmin = W * 0.3, cmin = H * 0.3; // an edge of the inner page is a long run, specks/text don't count
  let y0 = 0; while (y0 < H && rows[y0] < rmin) y0++;
  let y1 = H - 1; while (y1 > y0 && rows[y1] < rmin) y1--;
  let x0 = 0; while (x0 < W && cols[x0] < cmin) x0++;
  let x1 = W - 1; while (x1 > x0 && cols[x1] < cmin) x1--;
  if (x1 - x0 < W * 0.3 || y1 - y0 < H * 0.3) return null;
  const margins = [x0 / W, (W - 1 - x1) / W, y0 / H, (H - 1 - y1) / H];
  if (margins.filter((v) => v >= MIN_MARGIN).length < 2) return null;
  // the inner area must be a filled page: its edges are mostly content
  const fill = (ax, ay, bx, by) => { let n = 0, t = 0; for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) { t++; n += ink[y * W + x]; } return n / t; };
  const inset = 3;
  const edges = [fill(x0, y0 + inset, x0 + inset, y1 - inset), fill(x1 - inset, y0 + inset, x1, y1 - inset), fill(x0 + inset, y0, x1 - inset, y0 + inset), fill(x0 + inset, y1 - inset, x1 - inset, y1)];
  if (edges.some((f) => f < 0.6)) return null;
  // nothing (much) outside the inner page
  let outside = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x] && (x < x0 || x > x1 || y < y0 || y > y1)) outside++;
  if (outside > W * H * 0.002) return null;
  const pad = 1.5; // px inwards so no white hairline is left
  const r = (v) => Math.round(v * 100) / 100;
  const x = r((x0 + pad) / s), y = r((y0 + pad) / s);
  return { x, y, w: r((x1 + 1 - pad) / s - x), h: r((y1 + 1 - pad) / s - y), ow: v1.width, oh: v1.height };
}

// apply (on=true) or undo (on=false) a page's trim. Returns true when the page changed.
export function setTrim(page, on) {
  const t = page.trim;
  if (!t || !!page.cropped === !!on) return false;
  const dx = on ? -t.x : t.x, dy = on ? -t.y : t.y;
  for (const st of page.strokes || []) st.pts = st.pts.map((p) => { const q = p.slice(); q[0] = p[0] + dx; q[1] = p[1] + dy; return q; });
  for (const im of page.images || []) { im.x += dx; im.y += dy; }
  page.w = on ? t.w : t.ow; page.h = on ? t.h : t.oh;
  page.cropped = !!on;
  return true;
}
// pdf.js viewport for a (possibly trimmed) page at k device px per unit
export const pageViewport = (pg, page, k) => (page.cropped && page.trim
  ? pg.getViewport({ scale: k, offsetX: -page.trim.x * k, offsetY: -page.trim.y * k })
  : pg.getViewport({ scale: k }));

// find + apply trims on every PDF page of a body. Returns number of pages trimmed.
export async function trimBody(body, pdfDoc) {
  let n = 0;
  for (const p of body.pages) {
    if (p.kind !== 'pdf') continue;
    if (!p.trim) { const t = await detectTrim(pdfDoc, p.pdfIndex); if (t) p.trim = t; }
    if (setTrim(p, true)) n++;
  }
  return n;
}
export const hasTrim = (body) => body.pages.some((p) => p.kind === 'pdf' && p.trim);
export const isTrimmed = (body) => body.pages.some((p) => p.cropped);
