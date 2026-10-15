// Shape snapping: recognise a hand-drawn stroke as a line, circle/ellipse, rectangle, triangle or arrow.
// recognize(pts) -> { type, verts:[[x,y]...], closed, open:bool } | null.  Only confident fits are returned.
// toPoints(shape, p) -> dense [x,y,p] list, so a snapped shape is an ordinary stroke.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function pathLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; }
function resample(pts, n) {
  const L = pathLen(pts); if (!L) return [];
  const step = L / (n - 1), out = [[pts[0][0], pts[0][1]]]; let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1], b = pts[i], d = dist(a, b);
    while (acc + d >= step && out.length < n) {
      const t = (step - acc) / d, q = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      out.push(q); a = q; d = dist(a, b); acc = 0;
    }
    acc += d;
  }
  while (out.length < n) out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let idx = 0, md = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > md) { md = d; idx = i; } }
  if (md <= eps) return [pts[0], pts[pts.length - 1]];
  const a = rdp(pts.slice(0, idx + 1), eps), b = rdp(pts.slice(idx), eps);
  return a.slice(0, -1).concat(b);
}
function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, d: Math.hypot(x1 - x0, y1 - y0) };
}
const AX = 8 * Math.PI / 180; // snap to the axes within 8°
function snapAngle(a, tol = AX) { const q = Math.PI / 2, r = Math.round(a / q) * q; return Math.abs(a - r) < tol ? r : a; }
const LINE_AX = 3 * Math.PI / 180; // lines only straighten to level/vertical within 3°, otherwise they go exactly start -> end
function polyErr(pts, verts, closed) {
  let m = 0; const n = verts.length;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i < (closed ? n : n - 1); i++) best = Math.min(best, segDist(p, verts[i], verts[(i + 1) % n]));
    m = Math.max(m, best);
  }
  return m;
}
function turn(a, b, c) { // angle (rad) between a->b and b->c
  const u = Math.atan2(b[1] - a[1], b[0] - a[0]), v = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(v - u) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d;
}

export function recognize(raw) {
  if (!raw || raw.length < 4) return null;
  const B = bbox(raw); if (B.d < 14) return null;
  const L = pathLen(raw), R = resample(raw, 96), s = R[0], e = R[R.length - 1], gap = dist(s, e);

  // straight line: open and fairly straight -> exact line from the start point to the end point
  // (judged by the largest sideways wobble relative to the length, so a shaky real-Pencil line still counts)
  const lineErr = Math.max(...R.map((p) => segDist(p, s, e)));
  if (gap > 0.8 * L && lineErr < Math.max(4, 0.09 * gap)) {
    const ang = snapAngle(Math.atan2(e[1] - s[1], e[0] - s[0]), LINE_AX), len = gap;
    return { type: 'line', verts: [[raw[0][0], raw[0][1]], [raw[0][0] + Math.cos(ang) * len, raw[0][1] + Math.sin(ang) * len]], closed: false };
  }

  // arrow: shaft, then both barbs from the tip (S,T,A,T,B) — or S,T,A then a separate jump isn't possible in one stroke
  const simp = rdp(R, 0.06 * B.d);
  if (simp.length === 5 && !(gap < 0.2 * L)) {
    const [S, T, A, T2, Bb] = simp, shaft = dist(S, T);
    const b1 = dist(T, A), b2 = dist(T2, Bb);
    if (dist(T, T2) < 0.15 * shaft && b1 < 0.5 * shaft && b2 < 0.5 * shaft && b1 > 0.08 * shaft && b2 > 0.08 * shaft) {
      const sh = Math.atan2(T[1] - S[1], T[0] - S[0]);
      const rel = (P) => { let d = Math.atan2(P[1] - T[1], P[0] - T[0]) - (sh + Math.PI); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
      const r1 = rel(A), r2 = rel(Bb), lim = (a) => Math.abs(a) > 0.2 && Math.abs(a) < 1.25;
      const shaftErr = Math.max(...R.slice(0, R.indexOf(T) + 1).map((p) => segDist(p, S, T)));
      if (lim(r1) && lim(r2) && Math.sign(r1) !== Math.sign(r2) && shaftErr < 0.06 * shaft) {
        const a = snapAngle(sh), Tt = [S[0] + Math.cos(a) * shaft, S[1] + Math.sin(a) * shaft], hl = (b1 + b2) / 2, ha = 0.5;
        const H = (sg) => [Tt[0] + Math.cos(a + Math.PI + sg * ha) * hl, Tt[1] + Math.sin(a + Math.PI + sg * ha) * hl];
        return { type: 'arrow', verts: [[S[0], S[1]], Tt, H(1), Tt, H(-1)], closed: false };
      }
    }
  }

  if (gap > 0.22 * Math.max(B.w, B.h)) return null; // not closed: leave it

  // drop the overlapping tail of a closed shape, then look for corners
  const C = R.slice(0, -1);
  // polygon corners via RDP on the closed loop (start at the point farthest from the start so a corner isn't split)
  let far = 0; C.forEach((p, i) => { if (dist(p, C[0]) > dist(C[far], C[0])) far = i; });
  const loopA = rdp(C.slice(0, far + 1), 0.07 * B.d), loopB = rdp(C.slice(far).concat([C[0]]), 0.07 * B.d);
  let corners = loopA.slice(0, -1).concat(loopB.slice(0, -1));
  // merge corners that are close together or almost straight
  for (let k = 0; k < 3; k++) {
    corners = corners.filter((p, i, a) => {
      const prev = a[(i - 1 + a.length) % a.length], next = a[(i + 1) % a.length];
      return a.length <= 3 ? true : (turn(prev, p, next) > 0.45 && dist(prev, p) > 0.12 * B.d);
    });
  }
  const sharp = corners.length >= 3 && corners.every((p, i, a) => turn(a[(i - 1 + a.length) % a.length], p, a[(i + 1) % a.length]) > 0.6);

  // ellipse fit (PCA)
  let cx = 0, cy = 0; for (const [x, y] of C) { cx += x; cy += y; } cx /= C.length; cy /= C.length;
  let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of C) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); }
  let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let a = 0, b = 0;
  for (const [x, y] of C) { const u = (x - cx) * Math.cos(th) + (y - cy) * Math.sin(th), v = -(x - cx) * Math.sin(th) + (y - cy) * Math.cos(th); a = Math.max(a, Math.abs(u)); b = Math.max(b, Math.abs(v)); }
  // radii from the mean extent (robust to a little overshoot)
  let su = 0, sv = 0; for (const [x, y] of C) { su += ((x - cx) * Math.cos(th) + (y - cy) * Math.sin(th)) ** 2; sv += (-(x - cx) * Math.sin(th) + (y - cy) * Math.cos(th)) ** 2; }
  a = Math.sqrt(2 * su / C.length); b = Math.sqrt(2 * sv / C.length);
  let eErr = 0;
  if (a > 2 && b > 2) for (const [x, y] of C) { const u = (x - cx) * Math.cos(th) + (y - cy) * Math.sin(th), v = -(x - cx) * Math.sin(th) + (y - cy) * Math.cos(th); eErr += Math.abs(Math.hypot(u / a, v / b) - 1); }
  eErr = a > 2 && b > 2 ? eErr / C.length : 9;

  if (sharp && (corners.length === 3 || corners.length === 4)) {
    if (corners.length === 3) {
      if (polyErr(C, corners, true) < 0.07 * B.d) return { type: 'triangle', verts: corners.map((p) => [p[0], p[1]]), closed: true };
    } else {
      const angOk = corners.every((p, i, q) => Math.abs(turn(q[(i - 1 + 4) % 4], p, q[(i + 1) % 4]) - Math.PI / 2) < 0.4);
      if (angOk) {
        // rectangle frame from the average edge direction
        let ang = 0, best = 0;
        for (let i = 0; i < 4; i++) { const p = corners[i], q = corners[(i + 1) % 4], d = dist(p, q); if (d > best) { best = d; ang = Math.atan2(q[1] - p[1], q[0] - p[0]); } }
        ang = snapAngle(((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) > Math.PI / 4 ? ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 2 : ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2));
        const ca = Math.cos(ang), sa = Math.sin(ang), rot = corners.map(([x, y]) => [x * ca + y * sa, -x * sa + y * ca]);
        const rb = bbox(rot); let w = rb.w, hh = rb.h;
        if (Math.abs(w - hh) < 0.1 * Math.max(w, hh)) w = hh = (w + hh) / 2; // square
        const mx = (rb.x0 + rb.x1) / 2, my = (rb.y0 + rb.y1) / 2;
        const verts = [[-w / 2, -hh / 2], [w / 2, -hh / 2], [w / 2, hh / 2], [-w / 2, hh / 2]].map(([u, v]) => [(mx + u) * ca - (my + v) * sa, (mx + u) * sa + (my + v) * ca]);
        if (polyErr(C, verts, true) < 0.08 * B.d) return { type: w === hh ? 'square' : 'rectangle', verts, closed: true };
      }
    }
  }
  if (eErr < 0.085 && !(sharp && corners.length <= 4 && eErr > 0.05)) {
    if (Math.abs(a - b) < 0.1 * Math.max(a, b)) { a = b = (a + b) / 2; th = 0; } else th = snapAngle(th);
    const verts = []; for (let i = 0; i < 72; i++) { const t = i / 72 * 2 * Math.PI, u = a * Math.cos(t), v = b * Math.sin(t); verts.push([cx + u * Math.cos(th) - v * Math.sin(th), cy + u * Math.sin(th) + v * Math.cos(th)]); }
    return { type: a === b ? 'circle' : 'ellipse', verts, closed: true, smooth: true };
  }
  return null;
}

export function center(shape) {
  if (shape.type === 'line' || shape.type === 'arrow') return shape.verts[0];
  const b = bbox(shape.verts); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
}
// scale + rotate around a pivot
export function transform(shape, pivot, k, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return { ...shape, verts: shape.verts.map(([x, y]) => { const u = (x - pivot[0]) * k, v = (y - pivot[1]) * k; return [pivot[0] + u * c - v * s, pivot[1] + u * s + v * c]; }) };
}

export function toPoints(shape, p = 0.5) {
  if (shape.type === 'line') { const r = (n) => Math.round(n * 100) / 100; return shape.verts.map(([x, y]) => [r(x), r(y), p]); } // exactly 2 points
  const V = shape.closed ? shape.verts.concat([shape.verts[0]]) : shape.verts, out = [];
  const r = (n) => Math.round(n * 100) / 100;
  for (let i = 0; i < V.length - 1; i++) {
    const a = V[i], b = V[i + 1], n = shape.smooth ? 1 : Math.max(1, Math.ceil(dist(a, b) / 3));
    for (let j = 0; j < n; j++) out.push([r(a[0] + (b[0] - a[0]) * j / n), r(a[1] + (b[1] - a[1]) * j / n), p]);
  }
  const z = V[V.length - 1]; out.push([r(z[0]), r(z[1]), p]);
  if (shape.closed) { const q = out[1]; out.push([q[0], q[1], p]); } // overlap a touch so the join closes cleanly
  return out;
}
