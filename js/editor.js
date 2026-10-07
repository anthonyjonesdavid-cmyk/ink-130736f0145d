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
      this._sraf = requestAnimationFrame(() => { this._sraf = 0; this.updateVisible(); });
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

  onMove(e) {
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

  addPage(afterIndex = this.currentIndex ?? this.pageEls.length - 1) {
    const pages = this.doc.body.pages;
    const ref = pages[afterIndex] || pages[pages.length - 1];
    const page = { id: uid(), kind: 'paper', w: ref ? ref.w : 612, h: ref ? ref.h : 792, strokes: [] };
    const index = afterIndex + 1;
    this.insertPage(index, page);
    this.push({ t: 'addPage', index, page });
    requestAnimationFrame(() => this.scrollToPage(index));
    return index;
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
