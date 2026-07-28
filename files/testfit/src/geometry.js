// ============================================================
// geometry.js — pure 2D polygon geometry helpers (no deps)
// All units are world units (meters). Points are {x, y}.
// ============================================================

export const EPS = 1e-9;

/**
 * Normalise a "building/obstacle" to its point ring. Buildings are stored as
 * { poly, floors } objects, but legacy saves (and some call sites) use a bare
 * point array — this accepts either.
 */
export function polyOf(o) {
  return Array.isArray(o) ? o : (o && o.poly) || [];
}

/** Shoelace area (absolute value), m². */
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Signed area (>0 == counter-clockwise in standard math axes). */
export function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Ensure a polygon winds counter-clockwise. */
export function ensureCCW(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
}

export function polygonCentroid(poly) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < EPS) {
    // Degenerate — fall back to vertex average.
    const s = poly.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: s.x / poly.length, y: s.y / poly.length };
  }
  a *= 0.5;
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function boundingBox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Ray-casting point-in-polygon (edges count as inside within EPS). */
export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    const intersect =
      (a.y > pt.y) !== (b.y > pt.y) &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shortest distance from point to a segment. */
export function distPointSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Min distance from a point to any edge of the polygon. */
export function distPointToPolygonBoundary(p, poly) {
  let min = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const d = distPointSegment(p, poly[i], poly[(i + 1) % n]);
    if (d < min) min = d;
  }
  return min;
}

/** Do segments p1p2 and p3p4 properly intersect? */
export function segmentsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

/** Does any edge of poly cross any edge of the quad? */
export function polyEdgesCrossQuad(poly, quad) {
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    for (let j = 0; j < quad.length; j++) {
      const c = quad[j], dd = quad[(j + 1) % quad.length];
      if (segmentsIntersect(a, b, c, dd)) return true;
    }
  }
  return false;
}

/**
 * Is the convex quad fully contained within poly?
 * Corners inside AND no boundary crossings.
 */
export function quadInsidePolygon(quad, poly) {
  for (const c of quad) if (!pointInPolygon(c, poly)) return false;
  if (polyEdgesCrossQuad(poly, quad)) return false;
  return true;
}

/** Do the quad and polygon overlap at all (used for obstacle rejection)? */
export function quadIntersectsPolygon(quad, poly) {
  for (const c of quad) if (pointInPolygon(c, poly)) return true;
  for (const p of poly) if (pointInPolygon(p, quad)) return true;
  if (polyEdgesCrossQuad(poly, quad)) return true;
  return false;
}

/** Rotate a point around a pivot by angle (radians). */
export function rotatePoint(p, angle, pivot = { x: 0, y: 0 }) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = p.x - pivot.x, dy = p.y - pivot.y;
  return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c };
}

export function rotatePolygon(poly, angle, pivot = { x: 0, y: 0 }) {
  return poly.map((p) => rotatePoint(p, angle, pivot));
}

/**
 * Inward polygon offset (positive `d` shrinks the polygon).
 * Edge-offset with miter joins — exact for convex polygons and
 * rectangles, adequate for the mild concavity of typical sites.
 * Returns null if the offset collapses the polygon.
 */
export function offsetPolygon(poly, d) {
  if (d === 0) return poly.slice();
  const pts = ensureCCW(poly);
  const n = pts.length;
  if (n < 3) return null;
  // For CCW polygons, the inward normal of edge (i -> i+1) points left.
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const len = Math.hypot(nx, ny);
    if (len < EPS) continue;
    nx /= len; ny /= len;
    lines.push({
      a: { x: a.x + nx * d, y: a.y + ny * d },
      b: { x: b.x + nx * d, y: b.y + ny * d },
    });
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const prev = lines[(i - 1 + lines.length) % lines.length];
    const cur = lines[i];
    const p = lineIntersection(prev.a, prev.b, cur.a, cur.b);
    out.push(p || cur.a);
  }
  if (out.length < 3 || polygonArea(out) < EPS) return null;
  // Reject if winding flipped (over-offset).
  if (signedArea(out) * signedArea(pts) < 0) return null;
  return out;
}

/** Infinite-line intersection of a1a2 and b1b2. */
export function lineIntersection(a1, a2, b1, b2) {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < EPS) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

/** Unique edge directions of a polygon, in [0, PI). */
export function edgeAngles(poly) {
  const set = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    let ang = Math.atan2(b.y - a.y, b.x - a.x);
    // Normalise to [0, PI).
    ang = ((ang % Math.PI) + Math.PI) % Math.PI;
    if (!set.some((e) => Math.abs(e - ang) < 1e-4)) set.push(ang);
  }
  return set;
}

/**
 * Closed Catmull-Rom spline through `pts`, sampled `seg` times per span,
 * returned as a dense polygon. Used for curved site boundaries so the
 * containment-based solver fills stalls into the curves for free.
 */
export function tessellateClosed(pts, seg = 12) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let t = 0; t < seg; t++) {
      const s = t / seg, s2 = s * s, s3 = s2 * s;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * s + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * s2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * s3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * s + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * s2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * s3),
      });
    }
  }
  return out;
}

/**
 * Sample an OPEN polyline the way the canvas draws it: straight segments when
 * not curved, otherwise the same Catmull-Rom → cubic Bézier as buildAnnotPath.
 * Snapping must follow the line the user actually sees, not the control points.
 */
export function tessellateOpen(pts, curved, seg = 10) {
  if (!pts || pts.length < 2) return (pts || []).slice();
  if (!curved || pts.length === 2) return pts.slice();
  const out = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    for (let k = 1; k <= seg; k++) {
      const t = k / seg, m = 1 - t;
      const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, e = t * t * t;
      out.push({
        x: a * p1.x + b * c1x + c * c2x + e * p2.x,
        y: a * p1.y + b * c1y + c * c2y + e * p2.y,
      });
    }
  }
  return out;
}

/** Cumulative arc lengths for a polyline; cum[i] is the distance to pts[i]. */
export function polylineCum(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return cum;
}

/** Point and unit tangent at arc length s along a polyline. */
export function polylineAt(pts, cum, s) {
  const total = cum[cum.length - 1] || 0;
  const q = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < q) i++;
  const a = pts[i - 1], b = pts[i];
  const seg = cum[i] - cum[i - 1];
  const t = seg > EPS ? (q - cum[i - 1]) / seg : 0;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: a.x + dx * t, y: a.y + dy * t, tx: dx / len, ty: dy / len };
}

/**
 * Nearest point on a polyline to p. Returns the arc length of that point plus
 * the perpendicular distance, or null for a degenerate line.
 */
export function nearestOnPolyline(p, pts, cum) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < EPS) continue;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + t * dx, qy = a.y + t * dy;
    const dd = Math.hypot(p.x - qx, p.y - qy);
    if (!best || dd < best.dd) best = { dd, s: cum[i] + t * Math.sqrt(len2), x: qx, y: qy };
  }
  return best;
}

/** Axis-aligned rectangle → polygon (4 CCW points). */
export function rectPoly(x, y, w, h) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/**
 * The carriageway of a drawn line, as a closed polygon.
 *
 * `align` says what the line means: 'center' (default) puts half the width on
 * each side, 'left' treats the line as the road's left kerb and 'right' as its
 * right kerb — left and right seen in the direction the points run. The normal
 * (-dy, dx) points right of travel because y grows downward.
 *
 * Shared by the canvas renderer, the solver's blocker corridor, the exporters
 * and the 3D drape, so all four agree on where the asphalt actually is.
 */
export function ribbonPoly(points, width, align, curved) {
  const pts = tessellateOpen(points || [], !!curved, 10);
  if (pts.length < 2) return null;
  const hw = Math.max(0.25, (width || 3) / 2);
  const shift = align === 'left' ? hw : align === 'right' ? -hw : 0;
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    let dx = 0, dy = 0;
    if (i > 0) { dx += pts[i].x - pts[i - 1].x; dy += pts[i].y - pts[i - 1].y; }
    if (i < pts.length - 1) { dx += pts[i + 1].x - pts[i].x; dy += pts[i + 1].y - pts[i].y; }
    const len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    const cx = pts[i].x + nx * shift, cy = pts[i].y + ny * shift;
    left.push({ x: cx + nx * hw, y: cy + ny * hw });
    right.push({ x: cx - nx * hw, y: cy - ny * hw });
  }
  return [...left, ...right.reverse()];
}

/**
 * Where two segments cross, or null. Endpoints touching count: a T-junction is
 * a junction too. Parallel and collinear segments never report a crossing —
 * there is no single point to ask a question about.
 */
export function segmentCross(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + rx * t, y: a.y + ry * t };
}
