// The note editor: scrolling page column, Apple Pencil drawing, palm rejection, pinch zoom, undo/redo.
import {
  drawPaper, drawStroke, drawStrokes, strokePath2D, strokeOutline, outlineToPath, strokeHit, hlBlend, hlAlpha,
} from './render.js';
import { uid } from './store.js';

const MAX_CANVAS_PX = 4_500_000; // per canvas; iOS Safari has a tight total canvas memory budget
const MIN_ZOOM = 0.5, MAX_ZOOM = 5;
const SNAP_RANGE = 0.08;   // a pinch that ends within ±8% of 100% eases to exactly 100% (page fills the width)
const SNAP_MS = 170;

export class Editor {
  constructor({ scroll, wrap, settings, onChange, onPageChange, onZoomChange, onZoomSnap, onHistoryChange }) {
    Object.assign(this, { scroll, wrap, settings, onChange, onPageChange, onZoomChange, onZoomSnap, onHistoryChange });
    this.doc = null;
    this.zoom = 1;
    this.scale = 1;
    this.cur = null;      // active stroke
    this.sel = null; this.lasso = null; this.moving = null; this.clip = [];
    this.erasing = null;  // active eraser drag
    this.pinch = null;
    this.live = document.createElement('canvas');
    this.live.className = 'layer live';
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.bind();
  }

  /* ---------------- lifecycle ---------------- */
  open(doc) {
    this.doc = doc;
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
    }
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
    this.redrawInk(el, W, H);
  }

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
    if (!this.doc || !this.canDraw(e)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // palm rejection: once the Pencil is down, ignore every other contact
    if (this.cur || this.erasing) return;
    const el = e.target.closest('.page');
    if (!el) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
    const tool = this.settings.tool;
    if (tool === 'lasso') { this.onLassoDown(e, el); return; }
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

  onLassoDown(e, el) {
    const [x, y] = this.toPage(e, el);
    if (this.sel && this.sel.el === el && this.hitSel(x, y)) {
      this.moving = { pointerId: e.pointerId, last: [x, y], handle: this.hitHandle(x, y), origin: this.sel.bounds, base: this.sel.strokes.map((st) => st.pts.map((pt) => pt.slice())) };
      try { el.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    this.clearSelection();
    this.lasso = { el, pointerId: e.pointerId, pts: [[x, y]], mode: this.settings.lassoMode || 'free' };
    try { el.setPointerCapture(e.pointerId); } catch {}
    this.attachLive(el, 6);
    this.drawLasso();
  }
  hitSel(x, y) {
    const b = this.sel && this.sel.bounds;
    if (!b) return false;
    return x >= b.x - 8 && x <= b.x + b.w + 8 && y >= b.y - 8 && y <= b.y + b.h + 8;
  }
  hitHandle(x, y) {
    const b = this.sel.bounds, m = 14;
    const corners = [[b.x, b.y, 'nw'], [b.x + b.w, b.y, 'ne'], [b.x, b.y + b.h, 'sw'], [b.x + b.w, b.y + b.h, 'se']];
    for (const [cx, cy, name] of corners) if (Math.hypot(x - cx, y - cy) < m) return name;
    return null;
  }
  drawLasso() {
    if (!this.lasso || !this.live) return;
    const ctx = this.live.getContext('2d');
    const k = this.live._k;
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    const pts = this.lasso.pts;
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#2f6bff';
    ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx.setLineDash([6 * (window.devicePixelRatio || 1), 5 * (window.devicePixelRatio || 1)]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * k, pts[0][1] * k);
    for (const pt of pts) ctx.lineTo(pt[0] * k, pt[1] * k);
    if (this.lasso.mode === 'box') ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  finishLasso() {
    const L = this.lasso;
    this.lasso = null;
    this.detachLive();
    if (!L || L.pts.length < 2) return;
    const inside = L.mode === 'box' ? this.boxTest(L.pts) : this.polyTest(L.pts);
    const hits = L.el._page.strokes.filter((st) => st.pts.some((pt) => inside(pt[0], pt[1])));
    if (!hits.length) { this.clearSelection(); return; }
    this.sel = { el: L.el, strokes: hits };
    this.fitSel();
    this.onSelection?.(this.selectionInfo());
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
  fitSel() {
    const pts = this.sel.strokes.flatMap((st) => st.pts);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const pad = 8;
    this.sel.bounds = { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
    this.paintSel();
  }
  paintSel() {
    this.clearOverlay();
    const el = this.sel.el, b = this.sel.bounds, sc = this.scale;
    const box = document.createElement('div');
    box.className = 'sel-box';
    box.style.left = b.x * sc + 'px';
    box.style.top = b.y * sc + 'px';
    box.style.width = b.w * sc + 'px';
    box.style.height = b.h * sc + 'px';
    el.appendChild(box);
    this.sel.box = box;
  }
  clearOverlay() {
    if (this.sel && this.sel.box) this.sel.box.remove();
  }
  clearSelection() {
    this.clearOverlay();
    this.sel = null;
    this.onSelection?.(null);
  }
  selectionInfo() { return { bounds: this.sel.bounds, count: this.sel.strokes.length, hasClip: this.clip.length > 0 }; }
  nudge(dx, dy, record = true) {
    if (!this.sel) return;
    for (const st of this.sel.strokes) for (const pt of st.pts) { pt[0] += dx; pt[1] += dy; }
    this.sel.bounds.x += dx; this.sel.bounds.y += dy;
    this.redrawInk(this.sel.el);
    this.paintSel();
    if (record) this.push({ t: 'nudge', pageId: this.sel.el._page.id, ids: this.sel.strokes.map((st) => st.id), dx, dy });
  }
  scaleSel(handle, x, y) {
    const b = this.moving.origin;
    const ax = handle.includes('w') ? b.x + b.w : b.x;
    const ay = handle.includes('n') ? b.y + b.h : b.y;
    const sx = Math.max(0.2, Math.min(6, (x - ax) / ((handle.includes('w') ? b.x : b.x + b.w) - ax || 1)));
    const sy = Math.max(0.2, Math.min(6, (y - ay) / ((handle.includes('n') ? b.y : b.y + b.h) - ay || 1)));
    this.sel.strokes.forEach((st, i) => {
      const base = this.moving.base[i];
      st.pts.forEach((pt, j) => { pt[0] = ax + (base[j][0] - ax) * sx; pt[1] = ay + (base[j][1] - ay) * sy; });
    });
    this.redrawInk(this.sel.el);
    this.fitSel();
  }
  duplicateSelection() {
    if (!this.sel) return;
    const clones = this.sel.strokes.map((st) => ({ ...st, id: uid(), pts: st.pts.map((pt) => [pt[0] + 16, pt[1] + 16]) }));
    this.sel.el._page.strokes.push(...clones);
    this.push({ t: 'addMany', pageId: this.sel.el._page.id, strokes: clones });
    this.sel.strokes = clones;
    this.fitSel();
    this.redrawInk(this.sel.el);
    this.onSelection?.(this.selectionInfo());
  }
  copySelection() {
    if (!this.sel) return;
    this.clip = this.sel.strokes.map((st) => ({ ...st, id: uid(), pts: st.pts.map((pt) => pt.slice()) }));
    this.onSelection?.(this.selectionInfo());
  }
  cutSelection() {
    if (!this.sel) return;
    this.copySelection();
    const el = this.sel.el;
    const items = this.sel.strokes.map((st) => ({ stroke: st, index: el._page.strokes.indexOf(st) })).filter((it) => it.index >= 0);
    for (const st of this.sel.strokes) { const i = el._page.strokes.indexOf(st); if (i >= 0) el._page.strokes.splice(i, 1); }
    this.push({ t: 'erase', pageId: el._page.id, items });
    this.redrawInk(el);
    this.clearSelection();
  }
  pasteSelection() {
    if (!this.clip.length || !this.doc) return;
    const el = (this.sel && this.sel.el) || this.pageEls[this.currentIndex] || this.pageEls[0];
    if (!el) return;
    const clones = this.clip.map((st) => ({ ...st, id: uid(), pts: st.pts.map((pt) => [pt[0] + 16, pt[1] + 16]) }));
    el._page.strokes.push(...clones);
    this.push({ t: 'addMany', pageId: el._page.id, strokes: clones });
    this.sel = { el, strokes: clones };
    this.fitSel();
    this.redrawInk(el);
    this.onSelection?.(this.selectionInfo());
  }
  styleSelection(color) {
    if (!this.sel || !color) return;
    const items = this.sel.strokes.map((st) => ({ id: st.id, from: st.color, to: color }));
    for (const st of this.sel.strokes) st.color = color;
    this.push({ t: 'recolor', pageId: this.sel.el._page.id, items });
    this.redrawInk(this.sel.el);
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
      const [x, y] = this.toPage(e, this.sel.el);
      if (this.moving.handle) this.scaleSel(this.moving.handle, x, y);
      else { const dx = x - this.moving.last[0], dy = y - this.moving.last[1]; this.nudge(dx, dy, false); this.moving.last = [x, y]; this.moving.dx = (this.moving.dx || 0) + dx; this.moving.dy = (this.moving.dy || 0) + dy; }
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
    if (this.lasso && (!e || e.pointerId === this.lasso.pointerId)) { this.finishLasso(); return; }
    if (this.moving && (!e || e.pointerId === this.moving.pointerId)) {
      if (!this.moving.handle && (this.moving.dx || this.moving.dy)) this.push({ t: 'nudge', pageId: this.sel.el._page.id, ids: this.sel.strokes.map((st) => st.id), dx: this.moving.dx || 0, dy: this.moving.dy || 0 });
      else if (this.moving.handle) this.push({ t: 'reshape', pageId: this.sel.el._page.id, ids: this.sel.strokes.map((st) => st.id), base: this.moving.base, next: this.sel.strokes.map((st) => st.pts.map((pt) => pt.slice())) });
      this.moving = null;
      return;
    }
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
  push(action) {
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
      case 'addMany':
        if (undo) { for (const st of a.strokes) { const i = strokes.indexOf(st); if (i >= 0) strokes.splice(i, 1); } }
        else strokes.push(...a.strokes);
        this.redrawInk(el); break;
      case 'nudge': {
        const sign = undo ? -1 : 1;
        for (const st of strokes) if (a.ids.includes(st.id)) for (const pt of st.pts) { pt[0] += a.dx * sign; pt[1] += a.dy * sign; }
        this.redrawInk(el); break;
      }
      case 'reshape':
        strokes.forEach((st) => {
          const i = a.ids.indexOf(st.id);
          if (i >= 0) st.pts = (undo ? a.base : a.next)[i].map((pt) => pt.slice());
        });
        this.redrawInk(el); break;
      case 'recolor':
        for (const it of a.items) { const st = strokes.find((x) => x.id === it.id); if (st) st.color = undo ? it.from : it.to; }
        this.redrawInk(el); break;
    }
  }
  undo() {
    if (this.cur || this.erasing) return;
    const a = this.undoStack.pop(); if (!a) return;
    this.apply(a, true); this.redoStack.push(a); this.changed();
  }
  redo() {
    if (this.cur || this.erasing) return;
    const a = this.redoStack.pop(); if (!a) return;
    this.apply(a, false); this.undoStack.push(a); this.changed();
  }
}
