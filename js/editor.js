// The note editor: scrolling page column, Apple Pencil drawing, palm rejection, pinch zoom, undo/redo.
import {
  drawPaper, drawStroke, drawStrokes, strokePath2D, strokeOutline, outlineToPath, strokeHit, strokeBounds, hlBlend, hlAlpha, loadImage,
} from './render.js';
import { uid } from './store.js';

const MAX_CANVAS_PX = 4_500_000; // per canvas; iOS Safari has a tight total canvas memory budget
const MIN_ZOOM = 0.5, MAX_ZOOM = 5;
const SNAP_RANGE = 0.08;   // a pinch that ends within ±8% of 100% eases to exactly 100% (page fills the width)
const SNAP_MS = 170;

export class Editor {
  constructor({ scroll, wrap, settings, onChange, onPageChange, onZoomChange, onZoomSnap, onHistoryChange, onSelection }) {
    Object.assign(this, { scroll, wrap, settings, onChange, onPageChange, onZoomChange, onZoomSnap, onHistoryChange, onSelection });
    this.revs = new WeakMap(); // page -> edit counter (page thumbnails use it to know when to redraw)
    this.doc = null;
    this.zoom = 1;
    this.scale = 1;
    this.cur = null;      // active stroke
    this.sel = null; this.lasso = null; this.moving = null; this.clip = null;
    this.erasing = null;  // active eraser drag
    this.pinch = null;
    this.live = document.createElement('canvas');
    this.live.className = 'layer live';
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.bind();
  }

  /* ---------------- lifecycle ---------------- */
  open(doc) {
    this.resetSelectionState();
    this.doc = doc;
    pruneAssets(doc.body);
    this.undoStack = []; this.redoStack = [];
    this.zoom = 1;
    this.wrap.innerHTML = '';
    this.pageEls = doc.body.pages.map((p) => this.makePageEl(p));
    this.pageEls.forEach((el) => this.wrap.appendChild(el));
    this.layout();
    this.scroll.scrollTop = 0; this.scroll.scrollLeft = 0;
    this.updateVisible();
    this.emitHistory(); this.onZoomChange?.(this.zoom);
  }
  close() {
    this.cancelActive();
    this.resetSelectionState();
    for (const el of this.pageEls || []) this.release(el);
    this.wrap.innerHTML = '';
    this.pageEls = [];
    this.doc = null;
  }

  makePageEl(p) {
    const el = document.createElement('div');
    el.className = 'page' + (p.kind === 'pdf' ? ' pdf' : '');
    el._page = p;
    el._rs = 0;
    return el;
  }

  layout() {
    if (!this.doc) return;
    const cw = this.scroll.clientWidth || 800;
    const maxW = Math.max(...this.doc.body.pages.map((p) => p.w));
    // full-bleed: at 100% the page is exactly as wide as the screen
    this.fit = cw / maxW;
    this.scale = this.fit * this.zoom;
    this.wrap.classList.toggle('zoomed-out', this.zoom < 0.999);
    for (const el of this.pageEls) {
      el.style.width = Math.round(el._page.w * this.scale) + 'px';
      el.style.height = Math.round(el._page.h * this.scale) + 'px';
      if (el._rs) this.renderImages(el);
    }
    if (this.sel) this.paintSel(); // keep the selection box on its strokes after a zoom
  }

  /* ---------------- virtualised rendering ---------------- */
  updateVisible() {
    if (!this.doc) return;
    const top = this.scroll.scrollTop, h = this.scroll.clientHeight, margin = h * 0.9;
    let current = 0, best = -1;
    this.pageEls.forEach((el, i) => {
      const y = el.offsetTop, eh = el.offsetHeight;
      const near = y < top + h + margin && y + eh > top - margin;
      if (near) { if (el._rs !== this.scale) this.renderPage(el); } else if (el._rs) this.release(el);
      const vis = Math.min(y + eh, top + h) - Math.max(y, top);
      if (vis > best) { best = vis; current = i; }
    });
    this.currentIndex = current;
    this.onPageChange?.(current, this.pageEls.length);
  }

  pixelRatio(el) {
    const w = el._page.w * this.scale, h = el._page.h * this.scale;
    return Math.min(this.dpr, Math.sqrt(MAX_CANVAS_PX / (w * h)));
  }

  layer(el, name) {
    let c = el.querySelector('canvas.' + name);
    if (!c) { c = document.createElement('canvas'); c.className = 'layer ' + name; el.appendChild(c); }
    return c;
  }

  renderPage(el) {
    const p = el._page;
    const pr = this.pixelRatio(el);
    const k = this.scale * pr; // device px per page unit
    const W = Math.max(1, Math.round(p.w * k)), H = Math.max(1, Math.round(p.h * k));
    el._rs = this.scale;
    el._k = k;
    // background
    const bg = this.layer(el, 'bg');
    if (p.kind === 'pdf' && this.doc.pdfDoc) {
      if (el._task) { try { el._task.cancel(); } catch {} }
      const tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      const tctx = tmp.getContext('2d');
      tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, W, H);
      const token = (el._token = {});
      this.doc.pdfDoc.getPage(p.pdfIndex + 1).then((pg) => {
        if (el._token !== token) return;
        const vp = pg.getViewport({ scale: k });
        el._task = pg.render({ canvasContext: tctx, viewport: vp });
        return el._task.promise.then(() => {
          if (el._token !== token) return;
          bg.width = W; bg.height = H;
          bg.getContext('2d').drawImage(tmp, 0, 0);
          tmp.width = tmp.height = 0;
          el.classList.add('ready');
        });
      }).catch((e) => { if (e && e.name !== 'RenderingCancelledException') console.warn(e); });
      if (!bg.width) { bg.width = 1; bg.height = 1; }
    } else {
      bg.width = W; bg.height = H;
      const ctx = bg.getContext('2d');
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawPaper(ctx, p.w, p.h, this.doc.meta.paper, k);
      el.classList.add('ready');
    }
    this.renderImages(el);
    this.redrawInk(el, W, H);
  }

  // Photos are <img> elements in their own layer (between the paper and the ink), positioned in CSS px.
  renderImages(el) {
    const list = el._page.images || [];
    let box = el.querySelector(':scope > .imgs');
    if (!list.length) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.className = 'layer imgs'; el.appendChild(box); }
    const assets = (this.doc && this.doc.body.assets) || {};
    const sc = this.scale;
    const have = new Map([...box.children].map((n) => [n.dataset.id, n]));
    list.forEach((im, i) => {
      let n = have.get(im.id);
      if (!n) { n = document.createElement('img'); n.dataset.id = im.id; n.alt = ''; n.draggable = false; n.decoding = 'async'; }
      have.delete(im.id);
      const url = assets[im.src] || '';
      if (n.getAttribute('src') !== url) n.setAttribute('src', url);
      n.style.left = im.x * sc + 'px'; n.style.top = im.y * sc + 'px';
      n.style.width = im.w * sc + 'px'; n.style.height = im.h * sc + 'px';
      if (box.children[i] !== n) box.insertBefore(n, box.children[i] || null);
    });
    for (const n of have.values()) n.remove();
  }
  redraw(el) { if (el && el._rs) { this.renderImages(el); this.redrawInk(el); } }

  redrawInk(el, W, H) {
    if (!el._rs) return;
    const p = el._page, k = el._k;
    W = W || Math.round(p.w * k); H = H || Math.round(p.h * k);
    const hl = this.layer(el, 'hl');
    hl.style.mixBlendMode = hlBlend(p, this.doc.meta.paper) === 'multiply' ? 'multiply' : 'normal';
    const ink = this.layer(el, 'ink');
    for (const [c, tool] of [[hl, 'hl'], [ink, 'pen']]) {
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawStrokes(ctx, p.strokes, tool, hlAlpha(p, this.doc.meta.paper));
    }
  }

  release(el) {
    el._token = null;
    if (el._task) { try { el._task.cancel(); } catch {} el._task = null; }
    for (const c of el.querySelectorAll('canvas')) { if (c !== this.live) { c.width = 0; c.height = 0; c.remove(); } }
    el.querySelector(':scope > .imgs')?.remove();
    el._rs = 0;
    el.classList.remove('ready');
  }

  rerenderAll() {
    for (const el of this.pageEls) if (el._rs) el._rs = -1;
    this.updateVisible();
  }

  /* ---------------- input ---------------- */
  bind() {
    const s = this.scroll;
    s.addEventListener('scroll', () => {
      if (this._sraf) return;
      this._sraf = requestAnimationFrame(() => { this._sraf = 0; this.updateVisible(); this.maybeExtend(); });
    }, { passive: true });
    this.wrap.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e), { passive: false });
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e, true));
    s.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    s.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    s.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    s.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
    s.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => this.relayoutKeepingPosition(), 120); });
  }

  canDraw(e) {
    if (e.pointerType === 'pen' || e.pointerType === 'mouse') return true;
    return e.pointerType === 'touch' && this.settings.fingerDraw && !this.pinch;
  }

  toPage(e, el) {
    const r = el.getBoundingClientRect();
    return [(e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale];
  }

  onDown(e) {
    if (!this.doc) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.target.closest('.page');
    if (!el) return;
    // the Pencil takes over from a finger that is dragging a selection (e.g. a resting palm)
    if (this.moving && this.moving.pointerType === 'touch' && e.pointerType === 'pen') this.endMove();
    // palm rejection: once the Pencil (or a finger) is busy, ignore every other contact
    if (this.cur || this.erasing || this.lasso || this.moving) return;
    // a selection can be dragged / resized with the Pencil or a finger, whatever tool is active
    if (this.sel && this.sel.el === el) {
      const [x, y] = this.toPage(e, el);
      const handle = this.hitHandle(x, y);
      if (handle || this.hitSel(x, y)) { e.preventDefault(); this.startMove(e, el, handle, x, y); return; }
    }
    if (!this.canDraw(e)) {
      // a finger tap (not a scroll) outside the selection drops it
      if (this.sel) this.tapOut = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
    const tool = this.settings.tool;
    if (tool === 'lasso') { this.onLassoDown(e, el); return; }
    // with another tool, the first touch outside a selection just drops it (so it doesn't leave a dot)
    if (this.sel) { this.clearSelection(); this.swallow = e.pointerId; return; }
    if (tool === 'eraser') {
      this.erasing = { el, pointerId: e.pointerId, pointerType: e.pointerType, removed: [], last: null };
      this.attachLive(el, 5);
      this.eraseMove(e);
      return;
    }
    const cfg = this.settings[tool];
    const stroke = { id: uid(), tool: tool === 'hl' ? 'hl' : 'pen', color: cfg.color, size: cfg.size, pr: e.pointerType === 'pen' ? 1 : 0, pts: [] };
    this.cur = { el, stroke, pointerId: e.pointerId, pointerType: e.pointerType, lastP: 0.5 };
    this.addPoints(e);
    this.attachLive(el, tool === 'hl' ? 2 : 4);
    this.live.style.mixBlendMode = tool === 'hl' && hlBlend(el._page, this.doc.meta.paper) === 'multiply' ? 'multiply' : 'normal';
    this.drawLive();
  }

  attachLive(el, z) {
    const pr = this.pixelRatio(el);
    const W = Math.round(el._page.w * this.scale * pr), H = Math.round(el._page.h * this.scale * pr);
    if (this.live.width !== W || this.live.height !== H) { this.live.width = W; this.live.height = H; }
    else this.live.getContext('2d').clearRect(0, 0, W, H);
    this.live.style.zIndex = z;
    this.live._k = this.scale * pr;
    el.appendChild(this.live);
  }
  detachLive() {
    const c = this.live;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    c.remove();
  }

  addPoints(e) {
    const c = this.cur, el = c.el;
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    const r = el.getBoundingClientRect();
    for (const ev of evs) {
      const x = (ev.clientX - r.left) / this.scale, y = (ev.clientY - r.top) / this.scale;
      let p = 0.5;
      if (c.pointerType === 'pen' && c.stroke.tool === 'pen') {
        p = ev.pressure > 0 ? Math.pow(ev.pressure, 0.7) : c.lastP;
        c.lastP = p;
      }
      const pts = c.stroke.pts, last = pts[pts.length - 1];
      if (last && Math.hypot(last[0] - x, last[1] - y) < 0.25 / this.zoom) continue;
      pts.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(p * 1000) / 1000]);
    }
  }

  drawLive() {
    if (this._lraf) return;
    this._lraf = requestAnimationFrame(() => {
      this._lraf = 0;
      if (!this.cur) return;
      const c = this.live, ctx = c.getContext('2d'), k = c._k;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      const st = this.cur.stroke;
      drawStroke(ctx, st, new Path2D(outlineToPath(strokeOutline(st, false))), hlAlpha(this.cur.el._page, this.doc.meta.paper));
    });
  }

  /* ---------------- lasso & selection ----------------
     sel = { el, strokes: [stroke], images: [image], bounds: {x, y, w, h} }   (page units, padded)
     Strokes and photos are never edited in place: a move/resize gives each stroke a new pts array (so the outline and
     bounds caches in render.js notice) and history keeps before/after snapshots ('xform'). */
  resetSelectionState() {
    if (this.lasso) { this.lasso = null; this.detachLive(); }
    if (this._mraf) { cancelAnimationFrame(this._mraf); this._mraf = 0; }
    this.moving = null; this.tapOut = null; this.swallow = null;
    if (this.sel) this.clearSelection();
  }
  onLassoDown(e, el) {
    const [x, y] = this.toPage(e, el);
    if (this.sel) this.clearSelection();
    this.lasso = { el, pointerId: e.pointerId, pts: [[x, y]], mode: this.settings.lassoMode || 'free' };
    this.attachLive(el, 6);
    this.drawLasso();
  }
  hitSel(x, y) {
    const b = this.sel && this.sel.bounds;
    if (!b) return false;
    const m = 10 / this.scale;
    return x >= b.x - m && x <= b.x + b.w + m && y >= b.y - m && y <= b.y + b.h + m;
  }
  // corner handles: a 48px (screen) target around each corner, whatever the zoom
  hitHandle(x, y) {
    const b = this.sel && this.sel.bounds;
    if (!b) return null;
    const r = 24 / this.scale;
    const corners = [[b.x, b.y, 'nw'], [b.x + b.w, b.y, 'ne'], [b.x, b.y + b.h, 'sw'], [b.x + b.w, b.y + b.h, 'se']];
    let best = null, bd = Infinity;
    for (const [cx, cy, name] of corners) { const d = Math.hypot(x - cx, y - cy); if (d < r && d < bd) { bd = d; best = name; } }
    return best;
  }
  drawLasso() {
    if (!this.lasso || !this.live) return;
    const ctx = this.live.getContext('2d');
    const k = this.live._k, pr = k / this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    const pts = this.lasso.pts;
    if (pts.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * k, pts[0][1] * k);
    for (const pt of pts) ctx.lineTo(pt[0] * k, pt[1] * k);
    ctx.closePath();
    ctx.fillStyle = 'rgba(47,107,255,0.07)'; ctx.fill();
    ctx.strokeStyle = '#2f6bff';
    ctx.lineWidth = 1.5 * pr;
    ctx.setLineDash([6 * pr, 5 * pr]);
    ctx.stroke();
    ctx.restore();
  }
  finishLasso(cancelled) {
    const L = this.lasso;
    this.lasso = null;
    this.detachLive();
    if (!L || cancelled) { this.emitSel(); return; }
    const p = L.el._page, imgs = p.images || [];
    const xs = L.pts.map((q) => q[0]), ys = L.pts.map((q) => q[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    let strokes = [], images = [];
    if (L.pts.length < 3 || span < 12 / this.scale) {
      // a tap: select the stroke (topmost) or else the photo under the tip
      const [x, y] = L.pts[L.pts.length - 1];
      const st = [...p.strokes].reverse().find((s) => strokeHit(s, x, y, 6 / this.scale));
      if (st) strokes = [st];
      else { const im = [...imgs].reverse().find((m) => inRect(m, x, y)); if (im) images = [im]; }
    } else {
      const inside = L.mode === 'box' ? this.boxTest(L.pts) : this.polyTest(L.pts);
      strokes = p.strokes.filter((st) => strokeInside(st, inside));
      images = imgs.filter((m) => imageInside(m, inside));
      if (!strokes.length && !images.length) {
        // a loop drawn on top of a photo selects that photo
        const im = [...imgs].reverse().find((m) => L.pts.every(([x, y]) => inRect(m, x, y)));
        if (im) images = [im];
      }
    }
    if (!strokes.length && !images.length) { this.clearSelection(); return; }
    this.select(L.el, strokes, images);
  }
  boxTest(pts) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }
  polyTest(pts) {
    const poly = pts.length > 2 ? pts.concat([pts[0]]) : pts;
    return (x, y) => {
      let n = 0;
      for (let i = 1; i < poly.length; i++) {
        const [x1, y1] = poly[i - 1], [x2, y2] = poly[i];
        if ((y1 > y) !== (y2 > y)) {
          const ix = x1 + (y - y1) * (x2 - x1) / ((y2 - y1) || 1e-9);
          if (x < ix) n++;
        }
      }
      return n % 2 === 1;
    };
  }
  select(el, strokes, images = []) {
    if (this.sel && this.sel.el !== el) this.clearOverlay();
    this.sel = { el, strokes, images, box: this.sel && this.sel.el === el ? this.sel.box : null };
    this.fitSel();
    this.emitSel();
  }
  fitSel() {
    if (!this.sel) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const st of this.sel.strokes) {
      const b = strokeBounds(st);
      const pad = st.size / 2; // strokeBounds pads by the full size; the visible ink is about half of it
      x0 = Math.min(x0, b[0] + pad); y0 = Math.min(y0, b[1] + pad); x1 = Math.max(x1, b[2] - pad); y1 = Math.max(y1, b[3] - pad);
    }
    for (const m of this.sel.images) { x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y); x1 = Math.max(x1, m.x + m.w); y1 = Math.max(y1, m.y + m.h); }
    if (!isFinite(x0)) { this.clearSelection(); return; }
    const pad = this.sel.strokes.length ? 6 : 0; // photos alone: handles sit right on the photo's corners
    this.sel.bounds = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
    this.paintSel();
  }
  paintSel() {
    const S = this.sel;
    if (!S || !S.bounds) return;
    const b = S.bounds, sc = this.scale;
    let box = S.box;
    if (!box || box.parentNode !== S.el) {
      box?.remove();
      box = document.createElement('div');
      box.className = 'sel-box';
      box.innerHTML = '<i class="sel-h nw"></i><i class="sel-h ne"></i><i class="sel-h sw"></i><i class="sel-h se"></i>';
      S.el.appendChild(box);
      S.box = box;
    }
    box.style.left = b.x * sc + 'px';
    box.style.top = b.y * sc + 'px';
    box.style.width = b.w * sc + 'px';
    box.style.height = b.h * sc + 'px';
  }
  clearOverlay() {
    if (this.sel && this.sel.box) { this.sel.box.remove(); this.sel.box = null; }
  }
  clearSelection() {
    this.clearOverlay();
    this.sel = null;
    this.emitSel();
  }
  emitSel() { this.onSelection?.(this.sel ? this.selectionInfo() : null); }
  hasClip() { return !!(this.clip && (this.clip.strokes?.length || this.clip.images?.length)); }
  selectionInfo() {
    const S = this.sel;
    return { bounds: S.bounds, count: S.strokes.length + S.images.length, strokes: S.strokes.length, images: S.images.length, hasClip: this.hasClip() };
  }
  snapshot() {
    return {
      strokes: this.sel.strokes.map((st) => ({ pts: st.pts, size: st.size })),
      images: this.sel.images.map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h, src: m.src })),
    };
  }

  /* move / resize (corner handles keep the aspect ratio; ink widths scale too) */
  startMove(e, el, handle, x, y) {
    try { el.setPointerCapture(e.pointerId); } catch {}
    this.moving = { pointerId: e.pointerId, pointerType: e.pointerType, handle, start: [x, y], origin: { ...this.sel.bounds }, before: this.snapshot(), moved: false };
    this.sel.box?.classList.add('active');
  }
  moveTo(x, y) {
    const M = this.moving, S = this.sel;
    if (!M || !S) return;
    const o = M.origin, B = M.before;
    let f, k = 1;
    if (M.handle) {
      const w = M.handle.includes('w'), n = M.handle.includes('n');
      const ax = w ? o.x + o.w : o.x, ay = n ? o.y + o.h : o.y;          // fixed (opposite) corner
      const vx = (w ? o.x : o.x + o.w) - ax, vy = (n ? o.y : o.y + o.h) - ay; // anchor -> dragged corner
      k = ((x - ax) * vx + (y - ay) * vy) / ((vx * vx + vy * vy) || 1);
      k = Math.max(Math.max(0.05, 20 / Math.max(1, Math.min(o.w, o.h))), Math.min(8, k));
      f = (px, py) => [ax + (px - ax) * k, ay + (py - ay) * k];
    } else {
      let dx = x - M.start[0], dy = y - M.start[1];
      const P = S.el._page, m = 24; // keep a bit of the selection on the page
      dx = Math.max(m - (o.x + o.w), Math.min(P.w - m - o.x, dx));
      dy = Math.max(m - (o.y + o.h), Math.min(P.h - m - o.y, dy));
      f = (px, py) => [px + dx, py + dy];
    }
    const r2 = (v) => Math.round(v * 100) / 100;
    S.strokes.forEach((st, i) => {
      const b = B.strokes[i];
      st.pts = b.pts.map((pt) => { const [X, Y] = f(pt[0], pt[1]); return pt.length > 2 ? [r2(X), r2(Y), pt[2]] : [r2(X), r2(Y)]; });
      st.size = Math.round(b.size * k * 1000) / 1000;
    });
    S.images.forEach((im, i) => {
      const b = B.images[i];
      const [X, Y] = f(b.x, b.y);
      im.x = r2(X); im.y = r2(Y); im.w = r2(b.w * k); im.h = r2(b.h * k);
    });
    M.moved = true;
    this.redraw(S.el);
    this.fitSel();
  }
  endMove() {
    const M = this.moving;
    this.moving = null;
    if (this._mraf) { cancelAnimationFrame(this._mraf); this._mraf = 0; }
    if (!M || !this.sel) return;
    if (M.next) this.moveTo(...M.next);
    this.sel.box?.classList.remove('active');
    if (!M.moved) return;
    this.push({ t: 'xform', pageId: this.sel.el._page.id, strokes: this.sel.strokes.slice(), images: this.sel.images.slice(), before: M.before, after: this.snapshot() });
    this.fitSel();
    this.emitSel();
  }

  /* menu actions */
  cloneItems(strokes, images, dx, dy) {
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      strokes: strokes.map((st) => ({ ...st, id: uid(), pts: st.pts.map((pt) => { const q = pt.slice(); q[0] = r2(q[0] + dx); q[1] = r2(q[1] + dy); return q; }) })),
      images: images.map((m) => ({ ...m, id: uid(), x: r2(m.x + dx), y: r2(m.y + dy) })),
    };
  }
  addItems(el, strokes, images) {
    const p = el._page;
    p.strokes.push(...strokes);
    if (images.length) (p.images || (p.images = [])).push(...images);
    this.push({ t: 'addItems', pageId: p.id, strokes, images });
    this.redraw(el);
    this.select(el, strokes, images);
  }
  duplicateSelection() {
    if (!this.sel) return;
    const c = this.cloneItems(this.sel.strokes, this.sel.images, 16, 16);
    this.addItems(this.sel.el, c.strokes, c.images);
  }
  copySelection() {
    if (!this.sel) return;
    const assets = this.doc.body.assets || {}, used = {};
    for (const m of this.sel.images) used[m.src] = assets[m.src];
    // the clipboard carries the photo data too, so it can be pasted into another note
    this.clip = { ...this.cloneItems(this.sel.strokes, this.sel.images, 0, 0), assets: used, bounds: { ...this.sel.bounds }, pageId: this.sel.el._page.id };
    this.emitSel();
  }
  deleteSelection() {
    if (!this.sel) return;
    const el = this.sel.el, p = el._page;
    const strokes = this.sel.strokes.map((st) => ({ stroke: st, index: p.strokes.indexOf(st) })).filter((it) => it.index >= 0);
    const images = this.sel.images.map((m) => ({ image: m, index: (p.images || []).indexOf(m) })).filter((it) => it.index >= 0);
    for (const { stroke } of strokes) p.strokes.splice(p.strokes.indexOf(stroke), 1);
    for (const { image } of images) p.images.splice(p.images.indexOf(image), 1);
    this.push({ t: 'removeItems', pageId: p.id, strokes, images });
    this.redraw(el);
    this.clearSelection();
  }
  cutSelection() {
    if (!this.sel) return;
    this.copySelection();
    this.deleteSelection();
  }
  // the part of a page that is on screen, in page units
  visibleRect(el) {
    const r = el.getBoundingClientRect(), s = this.scroll.getBoundingClientRect(), sc = this.scale;
    const top = s.top + Math.max(60, (this.topInset && this.topInset()) || 0); // keep clear of the floating toolbars
    const x0 = Math.max(r.left, s.left), x1 = Math.min(r.right, s.right), y0 = Math.max(r.top, top), y1 = Math.min(r.bottom, s.bottom - 60);
    if (x1 - x0 < 40 || y1 - y0 < 40) return { x: 0, y: 0, w: el._page.w, h: el._page.h };
    return { x: (x0 - r.left) / sc, y: (y0 - r.top) / sc, w: (x1 - x0) / sc, h: (y1 - y0) / sc };
  }
  targetPage() { return (this.sel && this.sel.el) || this.pageEls[this.currentIndex] || this.pageEls[0]; }
  pasteSelection() {
    if (!this.hasClip() || !this.doc) return;
    const el = this.targetPage();
    if (!el) return;
    const b = this.clip.bounds, v = this.visibleRect(el);
    let dx = 16, dy = 16;
    const fits = this.clip.pageId === el._page.id && b.x + dx >= v.x && b.y + dy >= v.y && b.x + b.w + dx <= v.x + v.w && b.y + b.h + dy <= v.y + v.h;
    if (!fits) { dx = v.x + v.w / 2 - (b.x + b.w / 2); dy = v.y + v.h / 2 - (b.y + b.h / 2); }
    const c = this.cloneItems(this.clip.strokes, this.clip.images, dx, dy);
    if (c.images.length) {
      const assets = this.doc.body.assets || (this.doc.body.assets = {});
      for (const [k, url] of Object.entries(this.clip.assets || {})) if (url && !assets[k]) assets[k] = url;
    }
    this.addItems(el, c.strokes, c.images);
  }
  styleSelection(penColor, hlColor) {
    if (!this.sel || !this.sel.strokes.length) return;
    const items = this.sel.strokes.map((st) => ({ stroke: st, from: st.color, to: st.tool === 'hl' ? (hlColor || st.color) : penColor }));
    for (const it of items) it.stroke.color = it.to;
    this.push({ t: 'recolor', pageId: this.sel.el._page.id, items });
    this.redraw(this.sel.el);
  }
  // rotate the selected photos a quarter turn clockwise about their centres (the pixels are rotated, so exports match)
  async rotateSelection() {
    const S = this.sel;
    if (!S || !S.images.length) return;
    const assets = this.doc.body.assets || (this.doc.body.assets = {});
    const before = this.snapshot();
    for (const m of S.images) {
      const url = await rotateDataUrl(assets[m.src]);
      if (!url || this.sel !== S) return;
      const key = uid();
      assets[key] = url;
      const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
      Object.assign(m, { src: key, w: m.h, h: m.w, x: cx - m.h / 2, y: cy - m.w / 2 });
    }
    this.push({ t: 'xform', pageId: S.el._page.id, strokes: S.strokes.slice(), images: S.images.slice(), before, after: this.snapshot() });
    this.redraw(S.el);
    this.fitSel();
    this.emitSel();
  }

  /* photos: list = [{url, w, h}] (already downscaled JPEG data URLs, w/h in pixels) */
  insertImages(list) {
    if (!this.doc || !list.length) return;
    const el = this.pageEls[this.currentIndex] || this.pageEls[0];
    const p = el._page, v = this.visibleRect(el);
    const body = this.doc.body, assets = body.assets || (body.assets = {});
    const images = list.map((it, i) => {
      const maxW = Math.min(p.w * 0.7, v.w * 0.8), maxH = Math.min(p.h * 0.7, v.h * 0.8);
      const s = Math.min(maxW / it.w, maxH / it.h);
      const w = Math.round(it.w * s), h = Math.round(it.h * s);
      const off = i * 24;
      const key = uid();
      assets[key] = it.url;
      return { id: uid(), src: key, x: Math.round(Math.max(0, Math.min(p.w - w, v.x + (v.w - w) / 2 + off))), y: Math.round(Math.max(0, Math.min(p.h - h, v.y + (v.h - h) / 2 + off))), w, h };
    });
    this.addItems(el, [], images);
  }

  onMove(e) {
    if (this.lasso && e.pointerId === this.lasso.pointerId) {
      const [x, y] = this.toPage(e, this.lasso.el);
      if (this.lasso.mode === 'box') this.lasso.pts = [this.lasso.pts[0], [x, this.lasso.pts[0][1]], [x, y], [this.lasso.pts[0][0], y]];
      else this.lasso.pts.push([x, y]);
      this.drawLasso();
      return;
    }
    if (this.moving && e.pointerId === this.moving.pointerId) {
      e.preventDefault();
      this.moving.next = this.toPage(e, this.sel.el);
      if (!this._mraf) this._mraf = requestAnimationFrame(() => { this._mraf = 0; if (this.moving && this.moving.next) this.moveTo(...this.moving.next); });
      return;
    }
    if (this.cur && e.pointerId === this.cur.pointerId) {
      e.preventDefault();
      this.addPoints(e);
      this.drawLive();
    } else if (this.erasing && e.pointerId === this.erasing.pointerId) {
      e.preventDefault();
      this.eraseMove(e);
    }
  }

  onUp(e, cancelled) {
    if (this.swallow != null && e.pointerId === this.swallow) { this.swallow = null; return; }
    if (this.tapOut && e.pointerId === this.tapOut.pointerId) {
      const T = this.tapOut; this.tapOut = null;
      if (!cancelled && Math.hypot(e.clientX - T.x, e.clientY - T.y) < 10 && this.sel && !this.moving) this.clearSelection();
    }
    if (this.lasso && e.pointerId === this.lasso.pointerId) { this.finishLasso(cancelled); return; }
    if (this.moving && e.pointerId === this.moving.pointerId) { this.endMove(); return; }
    if (this.cur && e.pointerId === this.cur.pointerId) {
      const { el, stroke } = this.cur;
      this.cur = null;
      if (this._lraf) { cancelAnimationFrame(this._lraf); this._lraf = 0; }
      if (stroke.pts.length && !(cancelled && stroke.pts.length < 3)) {
        el._page.strokes.push(stroke);
        this.paintStroke(el, stroke);
        this.push({ t: 'add', pageId: el._page.id, stroke });
      }
      this.detachLive();
    } else if (this.erasing && e.pointerId === this.erasing.pointerId) {
      const { el, removed } = this.erasing;
      this.erasing = null;
      this.detachLive();
      if (removed.length) this.push({ t: 'erase', pageId: el._page.id, items: removed });
    }
  }

  cancelActive() {
    if (this.cur) { this.cur = null; this.detachLive(); }
    if (this.erasing) {
      const { el, removed } = this.erasing;
      this.erasing = null; this.detachLive();
      if (removed.length) this.push({ t: 'erase', pageId: el._page.id, items: removed });
    }
  }

  paintStroke(el, stroke) {
    if (!el._rs) return;
    const c = this.layer(el, stroke.tool === 'hl' ? 'hl' : 'ink');
    const ctx = c.getContext('2d');
    ctx.setTransform(el._k, 0, 0, el._k, 0, 0);
    drawStroke(ctx, stroke, strokePath2D(stroke), hlAlpha(el._page, this.doc.meta.paper));
  }

  eraseMove(e) {
    const er = this.erasing, el = er.el, p = el._page;
    const [x, y] = this.toPage(e, el);
    const r = this.settings.eraser.size / 2 / this.scale;
    // sample along the drag so fast swipes don't skip strokes
    const samples = [];
    if (er.last) {
      const d = Math.hypot(x - er.last[0], y - er.last[1]);
      const n = Math.min(40, Math.ceil(d / Math.max(1, r * 0.6)));
      for (let i = 1; i <= n; i++) samples.push([er.last[0] + (x - er.last[0]) * i / n, er.last[1] + (y - er.last[1]) * i / n]);
    } else samples.push([x, y]);
    er.last = [x, y];
    let changed = false;
    for (let i = p.strokes.length - 1; i >= 0; i--) {
      const st = p.strokes[i];
      if (samples.some(([sx, sy]) => strokeHit(st, sx, sy, r))) {
        er.removed.push({ stroke: st, index: i });
        p.strokes.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.redrawInk(el);
    // eraser cursor
    const c = this.live, ctx = c.getContext('2d'), k = c._k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,120,128,0.18)'; ctx.fill();
    ctx.lineWidth = 1 / this.scale; ctx.strokeStyle = 'rgba(60,60,67,0.6)'; ctx.stroke();
  }

  /* ---------------- touch: palm rejection + pinch ---------------- */
  fingers(list) { return [...list].filter((t) => t.touchType !== 'stylus'); }

  onTouchStart(e) {
    const stylus = [...e.changedTouches].some((t) => t.touchType === 'stylus');
    if (stylus) { e.preventDefault(); return; } // Pencil never scrolls, never selects text
    if (this.cur && this.cur.pointerType === 'pen') { e.preventDefault(); return; } // palm while writing
    if (!this.settings.pinchZoom) return; // pinch zoom off by default — fingers only scroll
    const f = this.fingers(e.touches);
    if (f.length >= 2) {
      e.preventDefault();
      if (this.cur && this.cur.pointerType === 'touch') { this.cur = null; this.detachLive(); }
      if (this.erasing && this.erasing.pointerType === 'touch') this.cancelActive();
      this.beginPinch(f[0], f[1]);
    }
  }
  onTouchMove(e) {
    if ([...e.touches].some((t) => t.touchType === 'stylus')) { e.preventDefault(); }
    if (this.cur && this.cur.pointerType === 'pen') { e.preventDefault(); return; }
    if (this.erasing && this.erasing.pointerType === 'pen') { e.preventDefault(); return; }
    if (this.pinch) {
      e.preventDefault();
      const f = this.fingers(e.touches);
      if (f.length >= 2) this.updatePinch(f[0], f[1]);
    }
  }
  onTouchEnd(e) {
    if (this.pinch && this.fingers(e.touches).length < 2) this.endPinch();
  }

  beginPinch(a, b) {
    if (this.snapping) return;
    const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    const wr = this.wrap.getBoundingClientRect();
    const anchor = this.anchorAt(cx, cy);
    this.pinch = { d0: d, z0: this.zoom, cx0: cx, cy0: cy, cx, cy, z: this.zoom, anchor, t0: performance.now() };
    this.wrap.style.transformOrigin = `${cx - wr.left}px ${cy - wr.top}px`;
  }
  updatePinch(a, b) {
    const P = this.pinch;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    P.cx = (a.clientX + b.clientX) / 2; P.cy = (a.clientY + b.clientY) / 2;
    P.z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, P.z0 * d / P.d0));
    const r = P.z / P.z0;
    this.wrap.style.transform = `translate(${P.cx - P.cx0}px, ${P.cy - P.cy0}px) scale(${r})`;
  }
  endPinch() {
    const P = this.pinch; this.pinch = null;
    // two-finger tap (no real pinch): two of them in quick succession reset to 100%
    const tap = performance.now() - P.t0 < 280 && Math.abs(P.z / P.z0 - 1) < 0.04 && Math.hypot(P.cx - P.cx0, P.cy - P.cy0) < 14;
    if (tap) {
      this.wrap.style.transform = '';
      const now = performance.now();
      if (now - (this.lastTwoTap || 0) < 450) { this.lastTwoTap = 0; this.resetZoom(); }
      else this.lastTwoTap = now;
      return;
    }
    this.lastTwoTap = 0;
    if (Math.abs(P.z - 1) <= SNAP_RANGE && Math.abs(P.z - 1) > 1e-4) {
      // quick ease into place: animate the live preview to exactly 100%, then lay out at 100%
      this.snapping = true;
      this.wrap.style.transition = `transform ${SNAP_MS}ms cubic-bezier(.2,.8,.3,1)`;
      this.wrap.style.transform = `translate(${P.cx - P.cx0}px, ${P.cy - P.cy0}px) scale(${1 / P.z0})`;
      setTimeout(() => {
        this.wrap.style.transition = ''; this.wrap.style.transform = '';
        this.snapping = false;
        this.setZoom(1, P.anchor, P.cx, P.cy);
        this.onZoomSnap?.();
      }, SNAP_MS + 10);
      return;
    }
    this.wrap.style.transform = '';
    this.setZoom(Math.abs(P.z - 1) <= 1e-4 ? 1 : P.z, P.anchor, P.cx, P.cy);
  }
  // back to 100% (page fills the width), keeping the point under the screen centre in view
  resetZoom() {
    this.setZoom(1);
    this.onZoomSnap?.();
  }

  // remember which page point is under (cx, cy)
  anchorAt(cx, cy) {
    let best = null, bd = Infinity;
    for (const el of this.pageEls) {
      const r = el.getBoundingClientRect();
      const dy = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
      if (dy < bd) { bd = dy; best = { el, fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height }; }
      if (dy === 0) break;
    }
    return best;
  }

  setZoom(z, anchor, cx, cy) {
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const sr = this.scroll.getBoundingClientRect();
    if (cx == null) { cx = sr.left + sr.width / 2; cy = sr.top + sr.height / 2; }
    anchor = anchor || this.anchorAt(cx, cy);
    this.zoom = z;
    this.layout();
    if (anchor) {
      const r = anchor.el.getBoundingClientRect();
      this.scroll.scrollLeft += r.left + anchor.fx * r.width - cx;
      this.scroll.scrollTop += r.top + anchor.fy * r.height - cy;
    }
    this.rerenderAll();
    this.onZoomChange?.(this.zoom);
  }

  onWheel(e) {
    if (!this.settings.pinchZoom) return; // gesture zoom off unless the user turns it on
    if (!e.ctrlKey && !e.metaKey) return; // trackpad pinch / ctrl+wheel
    e.preventDefault();
    this.setZoom(this.zoom * Math.exp(-e.deltaY / 200), null, e.clientX, e.clientY);
  }

  relayoutKeepingPosition() {
    if (!this.doc) return;
    const sr = this.scroll.getBoundingClientRect();
    this.setZoom(this.zoom, this.anchorAt(sr.left + sr.width / 2, sr.top + 10), sr.left + sr.width / 2, sr.top + 10);
  }

  /* ---------------- pages ---------------- */
  scrollToPage(i, smooth = true) {
    const el = this.pageEls[i];
    if (!el) return;
    this.scroll.scrollTo({ top: Math.max(0, el.offsetTop - (this.zoom < 0.999 ? 16 : 0)), behavior: smooth ? 'smooth' : 'auto' });
  }

  addPage(afterIndex = this.currentIndex ?? this.pageEls.length - 1, { scroll = true } = {}) {
    const pages = this.doc.body.pages;
    const ref = pages[afterIndex] || pages[pages.length - 1];
    const page = { id: uid(), kind: 'paper', w: ref ? ref.w : 612, h: ref ? ref.h : 792, strokes: [] };
    const index = afterIndex + 1;
    this.insertPage(index, page);
    this.push({ t: 'addPage', index, page });
    if (scroll) requestAnimationFrame(() => this.scrollToPage(index));
    return index;
  }

  // Keep a blank page waiting when the writer reaches the bottom. Notebooks only.
  maybeExtend() {
    if (!this.doc || this._extending || this.pinch) return;
    if (this.doc.meta && this.doc.meta.kind === 'pdf') return;
    const s = this.scroll;
    if (!s || s.scrollTop < 32) return;
    const remaining = s.scrollHeight - s.scrollTop - s.clientHeight;
    if (remaining > 160) return;
    this._extending = true;
    try { this.addPage(this.pageEls.length - 1, { scroll: false }); }
    finally { this._extending = false; }
  }

  insertPage(index, page) {
    this.doc.body.pages.splice(index, 0, page);
    const el = this.makePageEl(page);
    this.wrap.insertBefore(el, this.pageEls[index] || null);
    this.pageEls.splice(index, 0, el);
    this.layout();
    this.updateVisible();
  }
  removePage(index) {
    const [page] = this.doc.body.pages.splice(index, 1);
    const [el] = this.pageEls.splice(index, 1);
    this.release(el); el.remove();
    this.layout(); this.updateVisible();
    return page;
  }
  deletePage(index) {
    if (this.doc.body.pages.length <= 1) return false;
    const page = this.removePage(index);
    this.push({ t: 'delPage', index, page });
    return true;
  }

  setPaper(paper) {
    const from = { ...this.doc.meta.paper };
    this.doc.meta.paper = { ...paper };
    this.push({ t: 'paper', from, to: { ...paper } });
    this.rerenderAll();
  }

  /* ---------------- history ---------------- */
  rev(page) { return this.revs.get(page) || 0; }
  bump(pageId) { const el = pageId && this.pageElById(pageId); if (el) this.revs.set(el._page, this.rev(el._page) + 1); }
  push(action) {
    this.bump(action.pageId);
    this.undoStack.push(action);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.changed();
  }
  changed() { this.emitHistory(); this.onChange?.(); }
  emitHistory() { this.onHistoryChange?.(this.undoStack.length > 0, this.redoStack.length > 0); }

  pageElById(id) { return this.pageEls.find((el) => el._page.id === id); }

  apply(a, undo) {
    const el = a.pageId ? this.pageElById(a.pageId) : null;
    const strokes = el ? el._page.strokes : null;
    switch (a.t) {
      case 'add':
        if (undo) { const i = strokes.indexOf(a.stroke); if (i >= 0) strokes.splice(i, 1); }
        else strokes.push(a.stroke);
        this.redrawInk(el); break;
      case 'erase':
        if (undo) [...a.items].sort((x, y) => x.index - y.index).forEach(({ stroke, index }) => strokes.splice(Math.min(index, strokes.length), 0, stroke));
        else for (const { stroke } of a.items) { const i = strokes.indexOf(stroke); if (i >= 0) strokes.splice(i, 1); }
        this.redrawInk(el); break;
      case 'addPage':
        if (undo) this.removePage(a.index); else this.insertPage(a.index, a.page);
        break;
      case 'delPage':
        if (undo) this.insertPage(a.index, a.page); else this.removePage(a.index);
        break;
      case 'paper':
        this.doc.meta.paper = { ...(undo ? a.from : a.to) };
        this.rerenderAll(); break;
      case 'addItems':
        if (undo) {
          for (const st of a.strokes) { const i = strokes.indexOf(st); if (i >= 0) strokes.splice(i, 1); }
          const im = el._page.images || [];
          for (const m of a.images) { const i = im.indexOf(m); if (i >= 0) im.splice(i, 1); }
        } else {
          strokes.push(...a.strokes);
          if (a.images.length) (el._page.images || (el._page.images = [])).push(...a.images);
        }
        this.redraw(el); break;
      case 'removeItems': {
        const im = el._page.images || (el._page.images = []);
        if (undo) {
          [...a.strokes].sort((x, y) => x.index - y.index).forEach(({ stroke, index }) => strokes.splice(Math.min(index, strokes.length), 0, stroke));
          [...a.images].sort((x, y) => x.index - y.index).forEach(({ image, index }) => im.splice(Math.min(index, im.length), 0, image));
        } else {
          for (const { stroke } of a.strokes) { const i = strokes.indexOf(stroke); if (i >= 0) strokes.splice(i, 1); }
          for (const { image } of a.images) { const i = im.indexOf(image); if (i >= 0) im.splice(i, 1); }
        }
        this.redraw(el); break;
      }
      case 'xform': {
        const snap = undo ? a.before : a.after;
        a.strokes.forEach((st, i) => { st.pts = snap.strokes[i].pts; st.size = snap.strokes[i].size; });
        a.images.forEach((m, i) => Object.assign(m, snap.images[i]));
        this.redraw(el); break;
      }
      case 'recolor':
        for (const it of a.items) it.stroke.color = undo ? it.from : it.to;
        this.redraw(el); break;
    }
  }
  busy() { return !!(this.cur || this.erasing || this.lasso || this.moving); }
  undo() {
    if (this.busy()) return;
    const a = this.undoStack.pop(); if (!a) return;
    if (this.sel) this.clearSelection(); // the selection may no longer exist after undo
    this.apply(a, true); this.bump(a.pageId); this.redoStack.push(a); this.changed();
  }
  redo() {
    if (this.busy()) return;
    const a = this.redoStack.pop(); if (!a) return;
    if (this.sel) this.clearSelection();
    this.apply(a, false); this.bump(a.pageId); this.undoStack.push(a); this.changed();
  }
}

/* ---------------- helpers ---------------- */
const inRect = (m, x, y) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h;
// A stroke is selected when at least half of it is inside the lasso (a lasso that merely clips the end of a long line
// doesn't grab it). Dots and two-point strokes need any point inside.
function strokeInside(st, inside) {
  const pts = st.pts;
  if (pts.length <= 2) return pts.some((p) => inside(p[0], p[1]));
  let n = 0;
  for (const p of pts) if (inside(p[0], p[1])) n++;
  return n >= pts.length / 2;
}
// A photo is selected when at least half of it (sampled on a 4x4 grid) is inside the lasso.
function imageInside(m, inside) {
  let n = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside(m.x + m.w * (i + 0.5) / 4, m.y + m.h * (j + 0.5) / 4)) n++;
  return n >= 8;
}
// Drop stored photos no page refers to any more (deleted photos, earlier rotations). Run when a note is opened, when
// there is no undo history that could still need them.
export function pruneAssets(body) {
  if (!body || !body.assets) return;
  const used = new Set();
  for (const p of body.pages) for (const m of p.images || []) used.add(m.src);
  for (const k of Object.keys(body.assets)) if (!used.has(k)) delete body.assets[k];
}
async function rotateDataUrl(url) {
  const im = await loadImage(url);
  if (!im) return null;
  const c = document.createElement('canvas');
  c.width = im.naturalHeight; c.height = im.naturalWidth;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2);
  ctx.drawImage(im, 0, 0);
  const out = c.toDataURL('image/jpeg', 0.88);
  c.width = c.height = 0;
  return out;
}
