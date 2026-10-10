// Shared drawing code: paper patterns, pressure strokes (perfect-freehand), PDF page rendering.
import { getStroke } from '../vendor/perfect-freehand.js';
import { pageViewport } from './trim.js';

export const PAPER_STYLES = [
  { id: 'plain', name: 'Plain' },
  { id: 'ruled', name: 'Ruled' },
  { id: 'grid', name: 'Grid' },
  { id: 'dotted', name: 'Dotted' },
];
export const PAPER_COLORS = [
  { name: 'White', c: '#ffffff' },
  { name: 'Ivory', c: '#fbf7ec' },
  { name: 'Butter', c: '#fff5cf' },
  { name: 'Mint', c: '#e6f5ec' },
  { name: 'Sky', c: '#e6f0fb' },
  { name: 'Lavender', c: '#efeafb' },
  { name: 'Blush', c: '#fbe9ee' },
  // sampled from David's reference sheet: base #d8ead2 (stored 2 levels lighter because the grain darkens it slightly), ruling #95b898; grain on by default
  { name: 'Sage', c: '#daecd4', line: '#95b898', grain: true, rule: { top: 30, gap: 32, inset: 16 } },
  { name: 'Slate', c: '#2b3038' },
  { name: 'Black', c: '#141518' },
];
export const PEN_COLORS = ['#1c1c1e', '#2f5bea', '#e0352b', '#16a05d', '#8a3ffc', '#f28c0f', '#ffffff'];
export const PEN_SIZES = [0.9, 1.6, 2.6, 4.5];
export const HL_COLORS = ['#ffe24a', '#7ee787', '#ff8fc8', '#7cc8ff', '#ffb35c'];
export const HL_SIZES = [10, 16, 24];
export const ERASER_SIZES = [10, 24];
export const HL_ALPHA = 0.45;

export function hexToRgb(h) {
  h = String(h || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function isDark(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
export const presetFor = (color) => PAPER_COLORS.find((p) => p.c.toLowerCase() === String(color || '').toLowerCase());
// Pattern colour for a given paper colour: {rgb:[0..255], a}. Presets with their own ruling colour (Sage) use it solid.
export function paperInk(bg) {
  const pre = presetFor(bg);
  if (pre && pre.line) return { rgb: hexToRgb(pre.line), a: 1 };
  return isDark(bg) ? { rgb: [255, 255, 255], a: 0.22 } : { rgb: [70, 105, 160], a: 0.24 };
}
// Dot colour (dotted style)
export function paperDot(bg) {
  const pre = presetFor(bg);
  if (pre && pre.line) return { rgb: hexToRgb(pre.line), a: 1 };
  return isDark(bg) ? { rgb: [255, 255, 255], a: 0.28 } : { rgb: [70, 90, 130], a: 0.38 };
}

/* ---------- paper grain ---------- */
// vendor/paper-grain.webp is a seamless 256px grey tile centred on mid-grey (see make_grain.py). It is turned once into an
// RGBA tile of white (lighter than mid) and black (darker) speckles whose alpha is the deviation, so the same tile works on
// any paper colour. Drawn in page units (tile = GRAIN_TILE pt) so it scales with zoom, under the ruling and the ink.
export const GRAIN_TILE = 96;           // page points covered by one tile (fine pass)
const GRAIN_FINE = 0.075, GRAIN_MOTTLE = 0.02, MOTTLE_TILE = 384;
let grainTile = null, mottleTile = null, grainPromise = null;
function loadTile(name) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const n = img.naturalWidth, c = document.createElement('canvas'); c.width = c.height = n;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, n, n), a = d.data;
        for (let i = 0; i < a.length; i += 4) {
          const v = a[i] - 128, w = v > 0 ? 255 : 0;
          a[i] = a[i + 1] = a[i + 2] = w; a[i + 3] = Math.min(255, Math.abs(v) * 3);
        }
        x.putImageData(d, 0, 0); resolve(c);
      } catch (e) { console.warn('grain', e); resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = new URL(`../vendor/${name}`, import.meta.url).href;
  });
}
export function loadGrain() {
  if (!grainPromise) grainPromise = Promise.all([loadTile('paper-grain.webp'), loadTile('paper-mottle.webp')])
    .then(([g, m]) => { grainTile = g; mottleTile = m; return g; });
  return grainPromise;
}
export const grainReady = () => !!grainTile;
// ctx in page units. Two passes: fine grain (96pt tile), then a smooth cloud tile, much larger and rotated, for soft
// mottling, so the repeat of one pass never lines up with the other (no visible tiling).
export function drawGrain(ctx, w, h, dark = false) {
  if (!grainTile) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  for (const [img, tile, rot, alpha] of [[grainTile, GRAIN_TILE, 0, GRAIN_FINE], [mottleTile, MOTTLE_TILE, 0.37, GRAIN_MOTTLE]]) {
    if (!img) continue;
    const pat = ctx.createPattern(img, 'repeat');
    const k = tile / img.width;
    pat.setTransform(new DOMMatrix().rotateSelf(rot * 57.2958).scaleSelf(k, k));
    ctx.globalAlpha = dark ? alpha * 0.8 : alpha;
    ctx.fillStyle = pat; ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}
const css = (o) => `rgba(${o.rgb.join(',')},${o.a})`;

// Pattern geometry in page units (PDF points).
// A preset can bring its own ruling (Sage: wider rule with side margins, measured from the reference sheet).
export function paperGeometry(style, w, h, color) {
  const g = { lines: [], dots: [], margin: null };
  const rule = presetFor(color)?.rule;
  if (style === 'ruled' && rule) {
    for (let y = rule.top; y < h - 8; y += rule.gap) g.lines.push([rule.inset, y, w - rule.inset, y]);
  } else if (style === 'ruled') {
    const s = 26;
    for (let y = 78; y < h - 8; y += s) g.lines.push([0, y, w, y]);
  } else if (style === 'grid') {
    const s = 18, ox = (w % s) / 2, oy = (h % s) / 2;
    for (let x = ox; x <= w; x += s) g.lines.push([x, 0, x, h]);
    for (let y = oy; y <= h; y += s) g.lines.push([0, y, w, y]);
  } else if (style === 'dotted') {
    const s = 18, ox = (w % s) / 2 + s / 2, oy = (h % s) / 2 + s / 2;
    for (let y = oy; y < h; y += s) for (let x = ox; x < w; x += s) g.dots.push([x, y]);
  }
  return g;
}

// ctx is already transformed so that 1 unit = 1 page point. devPerUnit = device pixels per unit.
export function drawPaper(ctx, w, h, paper, devPerUnit) {
  ctx.fillStyle = paper.color || '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (paper.grain) drawGrain(ctx, w, h, isDark(paper.color || '#fff'));
  const g = paperGeometry(paper.style, w, h, paper.color);
  const ink = paperInk(paper.color || '#fff');
  ctx.strokeStyle = css(ink);
  ctx.lineWidth = Math.max(0.6, 1 / devPerUnit);
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of g.lines) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
  ctx.stroke();
  if (g.margin && !isDark(paper.color || '#fff')) {
    ctx.strokeStyle = 'rgba(225,85,85,0.35)';
    ctx.beginPath(); ctx.moveTo(g.margin[0], g.margin[1]); ctx.lineTo(g.margin[2], g.margin[3]); ctx.stroke();
  }
  if (g.dots.length) {
    ctx.fillStyle = css(paperDot(paper.color || '#fff'));
    const r = Math.max(0.9, 1.2 / devPerUnit);
    ctx.beginPath();
    for (const [x, y] of g.dots) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
    ctx.fill();
  }
}

/* ---------- strokes ---------- */
export function strokeOptions(st, last = true) {
  if (st.tool === 'hl') {
    return { size: st.size, thinning: 0, smoothing: 0.6, streamline: 0.55, simulatePressure: false, last, start: { cap: true }, end: { cap: true } };
  }
  return {
    size: st.size, thinning: 0.55, smoothing: 0.55, streamline: 0.42,
    simulatePressure: !st.pr, last,
    start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 },
  };
}

export function strokeOutline(st, last = true) {
  return getStroke(st.pts, strokeOptions(st, last));
}

// Smooth closed path through outline points (quadratic curves through midpoints).
export function outlineToPath(pts, map = null) {
  const n = pts.length;
  if (n < 2) return '';
  const P = map ? pts.map((p) => map(p[0], p[1])) : pts;
  const f = (v) => (Math.round(v * 100) / 100).toString();
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const m0 = mid(P[0], P[1]);
  let d = `M${f(m0[0])} ${f(m0[1])}`;
  for (let i = 1; i <= n; i++) {
    const a = P[i % n], b = P[(i + 1) % n], m = mid(a, b);
    d += `Q${f(a[0])} ${f(a[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return d + 'Z';
}

// Cached outline per stroke. The cache is only valid for the exact points array and size it was built from, so a stroke
// that was moved or resized (the lasso gives it a new pts array / size) is re-outlined instead of drawn at its old place.
const pathCache = new WeakMap();
export function strokePath2D(st) {
  const c = pathCache.get(st);
  if (c && c.pts === st.pts && c.n === st.pts.length && c.size === st.size) return c.path;
  const path = new Path2D(outlineToPath(strokeOutline(st)));
  pathCache.set(st, { pts: st.pts, n: st.pts.length, size: st.size, path });
  return path;
}

export function drawStroke(ctx, st, path, hlAlpha = HL_ALPHA, fade = 1) {
  ctx.globalAlpha = (st.tool === 'hl' ? hlAlpha : 1) * fade;
  ctx.fillStyle = st.color;
  ctx.fill(path || strokePath2D(st));
  ctx.globalAlpha = 1;
}

// fade(st) -> opacity multiplier (audio playback dims ink written after the playhead)
export function drawStrokes(ctx, strokes, tool, hlAlpha = HL_ALPHA, fade = null) {
  for (const st of strokes) if (st.tool === tool) drawStroke(ctx, st, null, hlAlpha, fade ? fade(st) : 1);
}

const boundsCache = new WeakMap();
export function strokeBounds(st) {
  const c = boundsCache.get(st);
  if (c && c.pts === st.pts && c.n === st.pts.length && c.size === st.size) return c.b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of st.pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const pad = st.size;
  const b = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  boundsCache.set(st, { pts: st.pts, n: st.pts.length, size: st.size, b });
  return b;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}
export function strokeHit(st, x, y, r) {
  const b = strokeBounds(st);
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const tol = r + st.size / 2;
  const p = st.pts;
  if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) <= tol;
  for (let i = 1; i < p.length; i++) if (distSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= tol) return true;
  return false;
}

// Highlighter blends with multiply on light paper / PDFs (keeps text crisp), normally on dark paper.
export function hlBlend(page, paper) {
  return page.kind === 'pdf' || !isDark((paper && paper.color) || '#fff') ? 'multiply' : 'source-over';
}

// On dark paper a translucent highlighter looks muddy; draw it more opaque there.
export function hlAlpha(page, paper) {
  return hlBlend(page, paper) === 'multiply' ? HL_ALPHA : 0.62;
}

/* ---------- full page render (thumbnails, library previews) ---------- */
/* ---------- photos ----------
   page.images = [{id, src, x, y, w, h}] in page units; src is a key into body.assets = {key: 'data:image/jpeg;base64,…'}.
   Photos sit above the paper / PDF page and under all ink. */
const imgCache = new Map(); // data URL -> Promise<HTMLImageElement>
export function loadImage(url) {
  if (!url) return Promise.resolve(null);
  let p = imgCache.get(url);
  if (!p) {
    p = new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
    imgCache.set(url, p);
    if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value);
  }
  return p;
}
export async function drawImages(ctx, page, assets) {
  for (const im of page.images || []) {
    const pic = await loadImage(assets && assets[im.src]);
    if (pic) ctx.drawImage(pic, im.x, im.y, im.w, im.h);
  }
}

export async function renderPageInto(canvas, page, paper, pdfDoc, pxPerUnit, assets) {
  const W = Math.max(1, Math.round(page.w * pxPerUnit)), H = Math.max(1, Math.round(page.h * pxPerUnit));
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (page.kind === 'pdf' && pdfDoc) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    try {
      const pg = await pdfDoc.getPage(page.pdfIndex + 1);
      const vp = pageViewport(pg, page, pxPerUnit);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch (e) { console.warn('thumb render', e); }
  } else {
    ctx.setTransform(pxPerUnit, 0, 0, pxPerUnit, 0, 0);
    drawPaper(ctx, page.w, page.h, paper, pxPerUnit);
  }
  ctx.setTransform(pxPerUnit, 0, 0, pxPerUnit, 0, 0);
  if (page.images && page.images.length) await drawImages(ctx, page, assets);
  ctx.globalCompositeOperation = hlBlend(page, paper);
  drawStrokes(ctx, page.strokes, 'hl', hlAlpha(page, paper));
  ctx.globalCompositeOperation = 'source-over';
  drawStrokes(ctx, page.strokes, 'pen');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}
