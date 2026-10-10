// Flatten a note (paper pages and/or original PDF pages + ink) into a new PDF using pdf-lib.
// Ink is written as vector paths, so it stays crisp at any zoom.
import { PDFDocument, rgb, BlendMode, degrees } from '../vendor/pdf-lib.esm.min.js';
import { paperGeometry, paperInk, paperDot, isDark, hexToRgb, strokeOutline, outlineToPath, HL_ALPHA, loadGrain, drawGrain } from './render.js';

// Paper colour + grain as a raster (JPEG) page background, so exports match the screen. Ruling and ink stay vector on top.
async function grainBackground(out, paper, w, h, cache) {
  const key = `${w}x${h}`;
  if (cache.has(key)) return cache.get(key);
  await loadGrain();
  const k = 2.5, c = document.createElement('canvas');            // ~180 dpi
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = paper.color || '#ffffff'; ctx.fillRect(0, 0, w, h);
  drawGrain(ctx, w, h, isDark(paper.color || '#fff'));
  const bytes = await (await fetch(c.toDataURL('image/jpeg', 0.86))).arrayBuffer();
  c.width = c.height = 0;
  const img = await out.embedJpg(bytes);
  cache.set(key, img);
  return img;
}

async function embedPhoto(out, assets, key, cache) {
  if (cache.has(key)) return cache.get(key);
  let img = null;
  const url = assets && assets[key];
  if (url) {
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      img = /^data:image\/png/.test(url) ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    } catch (e) { console.warn('photo export', e); }
  }
  cache.set(key, img);
  return img;
}

const col = (hex) => { const [r, g, b] = hexToRgb(hex); return rgb(r / 255, g / 255, b / 255); };

export async function exportNoteAsPdf({ meta, body, pdfBytes, pdfDoc }) {
  const out = await PDFDocument.create();
  out.setTitle(meta.title || 'Note');
  out.setProducer('Inkwell');
  out.setCreator('Inkwell');

  let copied = new Map();
  const pdfIdx = [...new Set(body.pages.filter((p) => p.kind === 'pdf').map((p) => p.pdfIndex))];
  if (pdfIdx.length && pdfBytes) {
    const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, pdfIdx);
    pdfIdx.forEach((idx, i) => copied.set(idx, pages[i]));
  }

  const paper = meta.paper || { style: 'plain', color: '#ffffff' };
  const bgCache = new Map(), photoCache = new Map();
  for (const pg of body.pages) {
    let page, map;
    if (pg.kind === 'pdf' && copied.has(pg.pdfIndex)) {
      let cp = copied.get(pg.pdfIndex);
      if (out.getPages().includes(cp)) {
        // same source page used twice: copy again
        const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        [cp] = await out.copyPages(src, [pg.pdfIndex]);
      }
      page = out.addPage(cp);
      // map viewport coords (what the user drew on) to PDF user space, handling /Rotate and offset boxes
      const vp = (await pdfDoc.getPage(pg.pdfIndex + 1)).getViewport({ scale: 1 });
      const ox = pg.cropped && pg.trim ? pg.trim.x : 0, oy = pg.cropped && pg.trim ? pg.trim.y : 0;
      map = (x, y) => vp.convertToPdfPoint(x + ox, y + oy);
      if (pg.cropped) { // trimmed white border: export with the same crop box (original page content untouched)
        const [ax, ay] = map(0, 0), [bx, by] = map(pg.w, pg.h);
        page.setCropBox(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      }
    } else {
      page = out.addPage([pg.w, pg.h]);
      page.drawRectangle({ x: 0, y: 0, width: pg.w, height: pg.h, color: col(paper.color || '#ffffff') });
      if (paper.grain) {
        try { page.drawImage(await grainBackground(out, paper, pg.w, pg.h, bgCache), { x: 0, y: 0, width: pg.w, height: pg.h }); }
        catch (e) { console.warn('grain export', e); }
      }
      const g = paperGeometry(paper.style, pg.w, pg.h, paper.color);
      const ink = paperInk(paper.color || '#fff');
      const ic = rgb(ink.rgb[0] / 255, ink.rgb[1] / 255, ink.rgb[2] / 255);
      for (const [x1, y1, x2, y2] of g.lines) page.drawLine({ start: { x: x1, y: pg.h - y1 }, end: { x: x2, y: pg.h - y2 }, thickness: 0.6, color: ic, opacity: ink.a });
      if (g.margin && !isDark(paper.color || '#fff')) page.drawLine({ start: { x: g.margin[0], y: pg.h }, end: { x: g.margin[2], y: 0 }, thickness: 0.6, color: rgb(0.88, 0.33, 0.33), opacity: 0.35 });
      if (g.dots.length) {
        const dot = paperDot(paper.color || '#fff'), dc = rgb(dot.rgb[0] / 255, dot.rgb[1] / 255, dot.rgb[2] / 255);
        for (const [x, y] of g.dots) page.drawCircle({ x, y: pg.h - y, size: 1.1, color: dc, opacity: dot.a });
      }
      map = (x, y) => [x, pg.h - y];
    }
    // photos: above the page, under the ink. Mapped through the same transform as the ink, so rotated PDF pages work too.
    for (const im of pg.images || []) {
      const emb = await embedPhoto(out, body.assets, im.src, photoCache);
      if (!emb) continue;
      const [ax, ay] = map(im.x, im.y + im.h);      // bottom-left of the photo
      const [bx, by] = map(im.x + im.w, im.y + im.h); // bottom-right
      const [cx, cy] = map(im.x, im.y);             // top-left
      page.drawImage(emb, { x: ax, y: ay, width: Math.hypot(bx - ax, by - ay), height: Math.hypot(cx - ax, cy - ay), rotate: degrees(Math.atan2(by - ay, bx - ax) * 180 / Math.PI) });
    }
    // drawSvgPath flips y (svg y-down). Feed PDF-space points with y negated.
    const svgMap = (x, y) => { const [X, Y] = map(x, y); return [X, -Y]; };
    const lightBg = pg.kind === 'pdf' || !isDark(paper.color || '#fff');
    for (const tool of ['hl', 'pen']) {
      for (const st of pg.strokes) {
        if (st.tool !== tool) continue;
        const d = outlineToPath(strokeOutline(st), svgMap);
        if (!d) continue;
        page.drawSvgPath(d, {
          x: 0, y: 0, color: col(st.color), borderWidth: 0,
          opacity: tool === 'hl' ? (lightBg ? HL_ALPHA : 0.62) : 1,
          blendMode: tool === 'hl' && lightBg ? BlendMode.Multiply : BlendMode.Normal,
        });
      }
    }
  }
  return out.save();
}
