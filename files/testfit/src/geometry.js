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
  const mid = ribbonCentre(points, width, align, curved);
  if (!mid) return null;
  const hw = Math.max(0.25, (width || 3) / 2);
  const left = [], right = [];
  for (const p of mid) {
    left.push({ x: p.x + p.nx * hw, y: p.y + p.ny * hw });
    right.push({ x: p.x - p.nx * hw, y: p.y - p.ny * hw });
  }
  return [...left, ...right.reverse()];
}

/**
 * The centreline of that same carriageway: the middle of the asphalt, not the
 * line the user drew. For `align: 'left'` or `'right'` those are half a
 * carriageway apart, and anything that reasons about where you can drive has to
 * use this one — measuring a turn on the kerb instead of the middle of the road
 * is wrong by exactly half the width.
 *
 * Each point carries the unit normal used to build it (`nx`, `ny`, pointing
 * left of travel), so callers that need the edges do not recompute it.
 */
export function ribbonCentre(points, width, align, curved) {
  const pts = tessellateOpen(points || [], !!curved, 10);
  if (pts.length < 2) return null;
  const hw = Math.max(0.25, (width || 3) / 2);
  const shift = align === 'left' ? hw : align === 'right' ? -hw : 0;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    let dx = 0, dy = 0;
    if (i > 0) { dx += pts[i].x - pts[i - 1].x; dy += pts[i].y - pts[i - 1].y; }
    if (i < pts.length - 1) { dx += pts[i + 1].x - pts[i].x; dy += pts[i + 1].y - pts[i].y; }
    const len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    out.push({ x: pts[i].x + nx * shift, y: pts[i].y + ny * shift, nx, ny });
  }
  return out;
}

/**
 * Points every `step` metres along a closed polygon's edges, each with the
 * outward unit normal of the edge it sits on. Used to walk a building facade.
 * The polygon is assumed counter-clockwise in screen space (y down), which is
 * what `ensureCCW` produces.
 */
export function sampleEdges(poly, step = 2) {
  const out = [];
  if (!poly || poly.length < 3) return out;
  const c = polygonCentroid(poly);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const ux = ex / len, uy = ey / len;
    // Outward = away from the centroid, decided per edge so a concave
    // footprint does not flip half its normals inward.
    let nx = -uy, ny = ux;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((mx - c.x) * nx + (my - c.y) * ny < 0) { nx = -nx; ny = -ny; }
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push({ x: a.x + ex * t, y: a.y + ey * t, nx, ny, edge: i });
    }
  }
  return out;
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

// ---------- Painted stripes ----------
// The stripe geometry lives here because two renderers need the same answer:
// the 2D canvas paints it and the 3D drape extrudes it, and until now each had
// its own copy of the numbers — which is why a zebra crossing was a proper set
// of bars in plan and a single grey hairline in 3D.

/** Zebra bars for a crossing centreline, in world metres. */
export function zebraQuads(points, width, step = 1.2, stripe = 0.6) {
  const A = points && points[0], B = points && points[1];
  if (!A || !B) return [];
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
  if (len < 0.1) return [];
  const ux = dx / len, uy = dy / len, px = -uy, py = ux, half = (width || 3.5) / 2;
  const out = [];
  for (let s = 0; s < len; s += step) {
    if (len - s < 1e-6) break;      // a float remainder is not a stripe
    const s2 = Math.min(s + stripe, len);
    out.push([
      { x: A.x + ux * s + px * half, y: A.y + uy * s + py * half },
      { x: A.x + ux * s2 + px * half, y: A.y + uy * s2 + py * half },
      { x: A.x + ux * s2 - px * half, y: A.y + uy * s2 - py * half },
      { x: A.x + ux * s - px * half, y: A.y + uy * s - py * half },
    ]);
  }
  return out;
}

// Spacing and line weight per hatched kind, in metres. The 2D canvas reads the
// same constants but keeps its own legibility floor, so zoomed far out its
// stripes stay readable instead of merging — the two are deliberately not
// identical at every zoom, and sharing the constants is what stops them drifting.
export const STRIPE_SPEC = {
  bayLines: { spacing: 2.7, diagonal: false, weight: 0.12 },
  hatchZone: { spacing: 1.2, diagonal: true, weight: 0.15 },
};

/** Where a segment runs inside a polygon, as a list of [t0, t1] parameter pairs. */
function insideRuns(a, b, poly) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ts = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q.x - p.x, ey = q.y - p.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / den;
    const u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((m, n) => m - n);
  const runs = [];
  let inside = pointInPolygon(a, poly), enter = inside ? 0 : -1;
  for (const t of ts) {
    if (inside) { if (t - enter > 1e-9) runs.push([enter, t]); inside = false; }
    else { enter = t; inside = true; }
  }
  if (inside && enter >= 0 && 1 - enter > 1e-9) runs.push([enter, 1]);
  return runs;
}

/**
 * Hatch or bay stripes clipped to a polygon, as thin quads in world metres.
 *
 * The 2D canvas gets its clipping from `ctx.clip()`; there is no such thing in a
 * GeoJSON source, so the clipping happens here — the same interval walk that
 * decides where a ray is inside a footprint.
 */
export function hatchQuads(poly, spec) {
  if (!poly || poly.length < 3 || !spec) return [];
  const bb = boundingBox(poly);
  const hw = spec.weight / 2;
  const out = [];
  const emit = (a, b) => {
    for (const [t0, t1] of insideRuns(a, b, poly)) {
      const p = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
      const q = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
      const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * hw, ny = (dx / len) * hw;
      out.push([
        { x: p.x + nx, y: p.y + ny }, { x: q.x + nx, y: q.y + ny },
        { x: q.x - nx, y: q.y - ny }, { x: p.x - nx, y: p.y - ny },
      ]);
    }
  };
  // Run the scan lines a metre past the box on both ends. Starting exactly on
  // the boundary makes the first crossing land at t = 0, which the interval walk
  // reads as leaving rather than entering — and a rectangle came out with no
  // stripes at all.
  const y0 = bb.minY - 1, y1 = bb.maxY + 1, span = y1 - y0;
  if (spec.diagonal) {
    for (let x = bb.minX - span; x <= bb.maxX + 1; x += spec.spacing) {
      emit({ x, y: y0 }, { x: x + span, y: y1 });
    }
  } else {
    for (let x = bb.minX; x <= bb.maxX; x += spec.spacing) {
      emit({ x, y: y0 }, { x, y: y1 });
    }
  }
  return out;
}
