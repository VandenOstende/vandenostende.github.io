// ============================================================
// drive.js — does the plan actually work?
//
// Everything else in this app draws what you asked for. This module is the
// only part that pushes back: it builds the network a vehicle can really
// drive, and reports the places where the chosen design vehicle does not fit.
//
// Deliberately pure — no DOM, no React, no canvas — so it can be tested with
// bare Node. Every function takes plain data and returns plain data.
// ============================================================

import {
  dist, distPointSegment, pointInPolygon, polygonCentroid, polyOf,
  ribbonCentre, ribbonPoly, sampleEdges, segmentsIntersect,
  polylineCum, polylineAt, nearestOnPolyline,
} from './geometry.js?v=cc8c8db3';
import { ANNOT_TYPES } from './annots.js?v=cc8c8db3';
import { aisleAxis } from './solver.js?v=cc8c8db3';
import { BUILDING_USES, DEFAULT_USE } from './buildings.js?v=cc8c8db3';

// ---------- Design vehicles ----------
//
// `rMin` is the radius of the REAR AXLE CENTRE at full lock; the outer body
// radius follows from the width and the front overhang, so the published
// "turning circle" is derived rather than stored twice.
//
// These are common design values, not a verified citation. Before this is ever
// presented as compliance with a norm the sources have to be checked — parking
// and fire-access dimensions differ per municipality and per fire zone, which
// is exactly why every one of them is editable.
export const VEHICLES = {
  car: {
    key: 'car', label: 'Personenwagen', icon: '🚗',
    length: 4.80, width: 1.80, wheelbase: 2.80, frontOverhang: 0.90,
    rMin: 3.7,
    // The app's own number: drawDriveThru already defaults its turn radius to
    // 7.5 m, so "< 7,5 m vereist" is internally consistent, not invented.
    rDesign: 7.5, widthReq: 3.0, reverseLimit: 12,
  },
  van: {
    key: 'van', label: 'Bestelwagen', icon: '🚐',
    length: 5.93, width: 2.02, wheelbase: 3.67, frontOverhang: 0.95,
    rMin: 4.0, rDesign: 9.0, widthReq: 3.25, reverseLimit: 12,
  },
  truck: {
    // Rigid two-axle. An articulated tractor-semitrailer off-tracks far more
    // and is deliberately not offered rather than silently under-reported.
    key: 'truck', label: 'Vrachtwagen', icon: '🚚',
    length: 10.00, width: 2.55, wheelbase: 5.60, frontOverhang: 1.45,
    rMin: 7.3, rDesign: 12.0, widthReq: 3.5, reverseLimit: 15,
  },
  fire: {
    // Sized so the model lands on the usual fire-access bend (inner ~11 m,
    // outer ~15 m, 4 m clear width) from independent dimensions — see the
    // calibration assertion in the tests.
    key: 'fire', label: 'Brandweer', icon: '🚒',
    length: 10.00, width: 2.55, wheelbase: 4.60, frontOverhang: 1.45,
    rMin: 13.0, rDesign: 13.0, widthReq: 4.0,
    // A fire appliance may not be asked to reverse out of a dead end.
    reverseLimit: 0,
  },
};
export const DEFAULT_VEHICLE = 'car';
export const vehicleOf = (key) => VEHICLES[key] || VEHICLES[DEFAULT_VEHICLE];

// Kinds you can drive on. Walkways and cycle paths have `body: true` like a
// road — they are surfaces, they take part in the junction question, and they
// are drawn as tarmac — but you do not drive a van down one.
const DRIVABLE = { road: 1, driveway: 1, drivethru: 1 };

const CLEAR = 0.25;   // m of shy distance kept from each kerb
const LINK_SLOP = 0.1; // m of tolerance when deciding two carriageways overlap
// How far a street's head may stop short of, or poke past, another street's
// kerb and still count as meeting it. Half a metre either way is a drawn line
// wobbling, not a different intention.
const T_SLOP = 0.5;

// ---------- The swept-path model ----------

/**
 * Width swept by a vehicle in a steady circular turn of radius `R` (measured to
 * the rear axle centre): the outer front corner sweeps wide, the inner rear
 * wheel cuts in, and the difference is the carriageway the turn eats.
 *
 * This is the closed-form first-pass check every design manual uses. It does
 * NOT model the transition into the turn (the first vehicle length sweeps wider
 * than the steady state), steering rate, articulated vehicles, reversing, or
 * cutting the corner across the opposing lane.
 */
export function sweptWidth(v, R) {
  const lf = v.wheelbase + v.frontOverhang;
  const rIn = R - v.width / 2;
  const rOut = Math.hypot(R + v.width / 2, lf);
  return rOut - rIn;
}

/** Smallest radius whose swept width fits in `w`. Monotone, so bisection. */
export function radiusForWidth(v, w) {
  if (!(w > 0)) return Infinity;
  if (sweptWidth(v, v.rMin) <= w) return v.rMin;
  let lo = v.rMin, hi = Math.max(v.rMin * 4, 200);
  if (sweptWidth(v, hi) > w) return Infinity;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sweptWidth(v, mid) <= w) hi = mid; else lo = mid;
  }
  return hi;
}

// ---------- Polyline helpers ----------

const cumOf = (pts) => {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
  return c;
};
// Unit direction of the polyline at arc-length `s`.
function dirAt(pts, cum, s) {
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < s) i++;
  const a = pts[i], b = pts[i + 1] || pts[i];
  const len = dist(a, b) || 1;
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}
// Closest approach between two segments, as {d, t, u} with t,u in [0,1].
// Endpoint-only comparisons miss the case that matters most here — two roads
// crossing in the middle, where neither endpoint is anywhere near the other.
function segSeg(p1, p2, p3, p4) {
  const ux = p2.x - p1.x, uy = p2.y - p1.y;
  const vx = p4.x - p3.x, vy = p4.y - p3.y;
  const wx = p1.x - p3.x, wy = p1.y - p3.y;
  const a = ux * ux + uy * uy, b = ux * vx + uy * vy, c = vx * vx + vy * vy;
  const d = ux * wx + uy * wy, e = vx * wx + vy * wy;
  const den = a * c - b * b;
  let t, u;
  if (den < 1e-12) {           // parallel
    t = 0;
    u = c > 1e-12 ? e / c : 0;
  } else {
    t = (b * e - c * d) / den;
    u = (a * e - b * d) / den;
  }
  t = Math.max(0, Math.min(1, t));
  u = Math.max(0, Math.min(1, u));
  // One clamped parameter invalidates the other; re-solve each against the
  // clamped partner so a T-touch is measured at the touch, not at a corner.
  u = c > 1e-12 ? Math.max(0, Math.min(1, (b * t + e) / c)) : 0;
  t = a > 1e-12 ? Math.max(0, Math.min(1, (b * u - d) / a)) : 0;
  const qx = p1.x + ux * t - (p3.x + vx * u), qy = p1.y + uy * t - (p3.y + vy * u);
  return { d: Math.hypot(qx, qy), t, u };
}

// Closest approach between two polylines: {d, sa, sb, at}.
function closest(pa, ca, pb, cb) {
  let best = { d: Infinity, sa: 0, sb: 0, at: pa[0] };
  for (let i = 0; i < pa.length - 1; i++) {
    for (let j = 0; j < pb.length - 1; j++) {
      const r = segSeg(pa[i], pa[i + 1], pb[j], pb[j + 1]);
      if (r.d >= best.d) continue;
      const ax = pa[i].x + (pa[i + 1].x - pa[i].x) * r.t;
      const ay = pa[i].y + (pa[i + 1].y - pa[i].y) * r.t;
      const bx = pb[j].x + (pb[j + 1].x - pb[j].x) * r.u;
      const by = pb[j].y + (pb[j + 1].y - pb[j].y) * r.u;
      best = {
        d: r.d,
        sa: ca[i] + (ca[i + 1] - ca[i]) * r.t,
        sb: cb[j] + (cb[j + 1] - cb[j]) * r.u,
        at: { x: (ax + bx) / 2, y: (ay + by) / 2 },
      };
    }
  }
  return best;
}

// ---------- Junction topology ----------
// Moved here from app.js: this is pure network code and the only truth about
// what a crossing means. Two copies would drift.

/**
 * Where drawn ways cross each other. Keyed by position rounded to 0.5 m, the
 * same trick stalls and aisles use — a junction IS a place, and a position key
 * is the only identity two independent polylines can share.
 */
export const junctionKey = (p) => (Math.round(p.x * 2) / 2) + ',' + (Math.round(p.y * 2) / 2);

export function findCrossings(anns) {
  const ways = [];
  (anns || []).forEach((a, i) => {
    const t = ANNOT_TYPES[a.kind];
    // A road object is closed because it is a rectangle, not because it is a
    // plaza — it can still meet another road at a junction.
    const obj = a.shape === 'object' && a.points && a.points.length === 4;
    if (t && t.body && (!a.closed || obj) && a.points && a.points.length >= 2) ways.push({ i, a });
  });
  const out = new Map();
  for (let m = 0; m < ways.length; m++) {
    for (let n = m + 1; n < ways.length; n++) {
      const A = ways[m], B = ways[n];
      for (let p = 0; p < A.a.points.length - 1; p++) {
        for (let q = 0; q < B.a.points.length - 1; q++) {
          const at = segCross(A.a.points[p], A.a.points[p + 1], B.a.points[q], B.a.points[q + 1]);
          if (!at) continue;
          const key = junctionKey(at);
          // Two segments of the same pair can meet twice at a shared vertex;
          // one entry per place is what the user is being asked about.
          if (!out.has(key)) out.set(key, { key, at, i: A.i, j: B.i });
        }
      }
    }
  }

  // T-junctions: a street whose HEAD comes out on another street.
  //
  // The proper-intersection test above needs the two drawn lines to actually
  // cross, with a tolerance of about 1e-9. Draw a side street up to the KERB of
  // a main road — which is what everyone does — and nothing is found at all,
  // while buildDriveNetwork happily links the two on carriageway overlap. So the
  // app never asked, and the T connected in silence.
  //
  // Deliberately NOT the network's own rule ("the carriageways touch"): that is
  // also true of two roads running side by side for fifty metres, and would
  // bury you in junction questions. An ENDPOINT inside someone else's
  // carriageway is precisely "the head of a street meets another street".
  for (let m = 0; m < ways.length; m++) {
    for (let n = 0; n < ways.length; n++) {
      if (m === n) continue;
      const A = ways[m], B = ways[n];
      if (A.a.closed || B.a.closed) continue;
      const line = centrelineOf({ ann: B.a });
      if (!line || line.pts.length < 2) continue;
      const cum = polylineCum(line.pts);
      const reach = line.width / 2 + T_SLOP;
      for (const end of [A.a.points[0], A.a.points[A.a.points.length - 1]]) {
        const foot = nearestOnPolyline(end, line.pts, cum);
        if (!foot || foot.dd > reach) continue;
        // Not at B's own far end — two streets meeting head to head is a
        // continuation, not a junction.
        if (foot.s < 1e-6 || foot.s > cum[cum.length - 1] - 1e-6) continue;
        const at = { x: foot.x, y: foot.y };
        const key = junctionKey(at);
        if (!out.has(key)) out.set(key, { key, at, i: Math.min(A.i, B.i), j: Math.max(A.i, B.i) });
      }
    }
  }
  return [...out.values()];
}

// Local copy of the segment intersection so this module keeps its own name for
// it; geometry.js exports the same maths as `segmentCross`.
function segCross(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + rx * t, y: a.y + ry * t };
}

/**
 * The heading of one branch at a crossing, in degrees 0..180 — a way and its
 * reverse are the same branch. Stored instead of an index so reordering or
 * deleting another way cannot move the bollards to the wrong arm.
 */
export function branchHeading(anns, c, branch) {
  const a = (anns || [])[branch === 'j' ? c.j : c.i];
  if (!a || !a.points || a.points.length < 2) return 0;
  let bi = 0, bd = Infinity;
  for (let k = 0; k < a.points.length - 1; k++) {
    const d = distPointSegment(c.at, a.points[k], a.points[k + 1]);
    if (d < bd) { bd = d; bi = k; }
  }
  const p = a.points[bi], q = a.points[bi + 1];
  return ((Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI + 360) % 180;
}

// ---------- Centrelines ----------

/**
 * The centreline of one drivable thing, or null. Never derived from the drawn
 * points directly: a way drawn as a kerb (`align`) has its asphalt half a
 * carriageway to one side, and measuring a turn on the kerb is wrong by exactly
 * that much.
 */
export function centrelineOf(src) {
  if (src.aisle) {
    const ax = aisleAxis(src.aisle.poly);
    const h = ax.length / 2;
    return {
      pts: [{ x: ax.cx - ax.ux * h, y: ax.cy - ax.uy * h }, { x: ax.cx + ax.ux * h, y: ax.cy + ax.uy * h }],
      width: ax.width,
    };
  }
  const a = src.ann;
  const t = ANNOT_TYPES[a.kind] || {};
  const width = a.width || t.width || 3;
  if (a.kind === 'driveway' || (a.shape === 'object' && a.points && a.points.length === 4)) {
    // A closed 4-point rectangle: a driveway straddling the site edge, or a road
    // drawn as an object. Its axis is the line between the midpoints of the two
    // short sides — derived from the points, so it survives the rectangle being
    // dragged, resized or rotated.
    //
    // Deriving it here rather than trusting a stored heading is what lets one
    // definition serve the drivability network AND the stall snap: before this,
    // app.js had its own idea of where a road's centre was and read an object
    // road's corner ring as if it were the centreline.
    const p = a.points;
    if (!p || p.length < 4) return null;
    const l01 = dist(p[0], p[1]), l12 = dist(p[1], p[2]);
    const mid = (u, v) => ({ x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 });
    return l01 >= l12
      ? { pts: [mid(p[1], p[2]), mid(p[3], p[0])], width: l12 }
      : { pts: [mid(p[0], p[1]), mid(p[2], p[3])], width: l01 };
  }
  const mid = ribbonCentre(a.points, width, a.align, a.curved);
  if (!mid) return null;
  return { pts: mid.map((q) => ({ x: q.x, y: q.y })), width };
}

/**
 * The arms of a junction: every direction you can drive away from it.
 *
 * A crossing knew only its two *ways*, and `branchHeading` reports mod 180°, so
 * the north and the south arm of one street were literally indistinguishable.
 * With no direction there is nowhere to push a bollard row, and a T — three arms,
 * not four — cannot be described at all.
 *
 * An arm exists in a direction if there is meaningful road beyond the junction
 * that way. A side street that ENDS at the junction therefore contributes one
 * arm, not two, which is exactly what makes a T a T.
 */
export function junctionArms(anns, c, minLen = 1.5) {
  const out = [];
  for (const which of ['i', 'j']) {
    const idx = which === 'j' ? c.j : c.i;
    const a = (anns || [])[idx];
    if (!a || !a.points || a.points.length < 2) continue;
    const line = centrelineOf({ ann: a });
    if (!line || line.pts.length < 2) continue;
    const cum = polylineCum(line.pts);
    const total = cum[cum.length - 1];
    const foot = nearestOnPolyline(c.at, line.pts, cum);
    if (!foot) continue;
    // Forward is +1 along the centreline, backward -1. Each is an arm only if
    // enough road is left that way.
    for (const dir of [1, -1]) {
      const run = dir > 0 ? total - foot.s : foot.s;
      if (run < minLen) continue;
      // Probe a couple of metres along that way; the direction from the foot to
      // the probe is the arm's own heading, full circle rather than mod 180.
      const probe = polylineAt(line.pts, cum, Math.min(total, Math.max(0, foot.s + dir * Math.min(run, 2))));
      const ux = probe.x - foot.x, uy = probe.y - foot.y;
      const len = Math.hypot(ux, uy) || 1;
      out.push({
        ann: idx, at: { x: foot.x, y: foot.y },
        ux: ux / len, uy: uy / len,
        heading: ((Math.atan2(uy, ux) * 180) / Math.PI + 360) % 360,
        width: line.width, run,
      });
    }
  }
  return out;
}

/**
 * Where an arm leaves the carriageway of the way it meets — the mouth of the
 * street. Bollards belong here, flush with the kerb, not in the middle of the
 * road being crossed.
 *
 * Walking the arm out of the other way's ribbon polygon rather than solving
 * `hw / sin θ` keeps it right for a kerb-aligned way (whose asphalt is offset
 * from the drawn line) and for a curved one.
 */
export function armMouth(anns, c, arm) {
  const other = (anns || [])[arm.ann === c.i ? c.j : c.i];
  if (!other || !other.points || other.points.length < 2) return arm.at;
  const poly = other.shape === 'object' && other.points.length === 4
    ? other.points
    : ribbonPoly(other.points, other.width || (ANNOT_TYPES[other.kind] || {}).width || 6, other.align, other.curved);
  if (!poly || poly.length < 3) return arm.at;
  const far = { x: arm.at.x + arm.ux * 200, y: arm.at.y + arm.uy * 200 };
  let best = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length];
    const ex = q.x - p.x, ey = q.y - p.y;
    const dx = far.x - arm.at.x, dy = far.y - arm.at.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - arm.at.x) * ey - (p.y - arm.at.y) * ex) / den;
    const u = ((p.x - arm.at.x) * dy - (p.y - arm.at.y) * dx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t > best) best = t;
  }
  return { x: arm.at.x + (far.x - arm.at.x) * best, y: arm.at.y + (far.y - arm.at.y) * best };
}

/**
 * Cut a centreline down to the runs that are really drivable: inside the
 * buildable region and clear of every blocker. The solver's aisle rectangles
 * span the whole bounding box and are never clipped, so without this the
 * network claims tarmac inside a building.
 */
export function trimToRegion(pts, region, blockers, step = 1.0) {
  const hasRegion = region && region.length >= 3;
  const bl = (blockers || []);
  if (!hasRegion && !bl.length) return [pts];
  const okAt = (p) => (!hasRegion || pointInPolygon(p, region)) && !bl.some((b) => pointInPolygon(p, b));
  const runs = [];
  let cur = null;
  // Original vertices are kept. Resampling the whole line would turn every
  // corner into a chain of 1 m segments, and then no corner has arms — which is
  // exactly how a turning-radius check ends up measuring nothing.
  const push = (p) => {
    if (!cur) cur = [];
    const last = cur[cur.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) cur.push({ x: p.x, y: p.y });
  };
  const close = () => { if (cur && cur.length >= 2) runs.push(cur); cur = null; };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = dist(a, b);
    const n = Math.max(1, Math.ceil(len / step));
    let prev = okAt(a);
    if (prev) push(a);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const now = okAt(p);
      if (now === prev) continue;
      push(p);                 // the point where it crosses in or out
      if (!now) close();
      prev = now;
    }
    if (prev) push(b);
  }
  close();
  return runs;
}

/**
 * The narrowest the carriageway actually gets along a centreline.
 *
 * Only a blocker that reaches INTO the carriageway takes width away. A road
 * running tangent to a building wall is still a full-width road, and the
 * setback line is a parking rule, not a kerb — measuring against either of
 * those was the difference between "6 m wide" and "0 m wide".
 */
export function minFreeWidth(pts, nominal, blockers) {
  const hw = nominal / 2;
  let w = nominal;
  for (const p of pts) {
    for (const b of (blockers || [])) {
      const d = distToPoly(p, b);
      // No short-circuit on "inside": trimming already cut the parts that run
      // through a building, and the cut point itself sits exactly ON the wall.
      // Reading that as zero width made the whole way unusable and the required
      // radius infinite — a knelpunt that said "Infinity m vereist".
      if (d < hw) w = Math.min(w, hw + d);        // it eats into one side
    }
  }
  return Math.max(0, w);
}
function distToPoly(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = distPointSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (d < best) best = d;
  }
  return best;
}

// ---------- The network ----------

/**
 * Build the graph of what the given vehicle can drive.
 *
 * Ways stay whole polylines; connections between them are recorded as links
 * with the arc-length position on each side. That answers every question this
 * module asks — components, dead ends, corners — without splitting geometry,
 * which is where a network like this usually goes wrong.
 */
export function buildDriveNetwork(plan, v) {
  const region = plan.buildable && plan.buildable.length >= 3 ? plan.buildable : plan.site;
  // RAW obstacles. The solver pads its blockers outward by `params.padding`;
  // using those here would make every clearance systematically pessimistic.
  const blockers = (plan.obstacles || []).map(polyOf).filter((p) => p && p.length >= 3);
  const ways = [];
  // `clip` differs on purpose. A solver aisle is an unclipped rectangle spanning
  // the whole bounding box, so it has to be cut back to the region it came
  // from. A way you drew is where you said it is — it gets cut only where it
  // runs through a building, never at the setback line.
  const add = (src, name, kind, ref, clip) => {
    const c = centrelineOf(src);
    if (!c || c.pts.length < 2) return;
    for (const run of trimToRegion(c.pts, clip, blockers)) {
      if (run.length < 2) continue;
      const cum = cumOf(run);
      if (cum[cum.length - 1] < 1) continue;
      ways.push({
        id: ways.length, pts: run, cum, length: cum[cum.length - 1],
        width: c.width, wmin: minFreeWidth(run, c.width, blockers),
        kind, name, ref, curved: !!(src.ann && src.ann.curved),
      });
    }
  };

  (plan.aisles || []).forEach((a, i) => add({ aisle: a }, 'Rijbaan ' + (i + 1), 'aisle', { kind: 'aisle', key: a.key }, region));
  (plan.turnarounds || []).forEach((t, i) => add({ aisle: { poly: t.poly || t } }, 'Keerruimte ' + (i + 1), 'turnaround', { kind: 'turnaround', index: i }, region));
  (plan.annotations || []).forEach((a, i) => {
    if (!DRIVABLE[a.kind]) return;
    const t = ANNOT_TYPES[a.kind] || {};
    add({ ann: a }, t.label || a.kind, a.kind, { kind: 'annot', index: i }, null);
  });

  // Junction records, keyed by place, for pairs the app actually asked about.
  const jn = plan.junctions || {};
  const crossings = findCrossings(plan.annotations || []);
  const gate = new Map();  // "annIndexA|annIndexB" -> [{at, mode, closedHeading}]
  for (const c of crossings) {
    const rec = jn[c.key] || {};
    const k = Math.min(c.i, c.j) + '|' + Math.max(c.i, c.j);
    if (!gate.has(k)) gate.set(k, []);
    gate.get(k).push({ at: c.at, mode: rec.mode || '', dir: rec.dir, c });
  }

  const links = [];
  for (let a = 0; a < ways.length; a++) {
    for (let b = a + 1; b < ways.length; b++) {
      const A = ways[a], B = ways[b];
      const near = closest(A.pts, A.cum, B.pts, B.cum);
      if (near.d > (A.width + B.width) / 2 + LINK_SLOP) continue;
      // Only two DRAWN ways can carry a junction decision. A solver aisle was
      // never declared by anyone, so there is nothing to have asked about, and
      // it joins silently.
      if (A.ref.kind === 'annot' && B.ref.kind === 'annot') {
        const recs = gate.get(Math.min(A.ref.index, B.ref.index) + '|' + Math.max(A.ref.index, B.ref.index));
        const rec = recs && recs.reduce((best, r) => (!best || dist(r.at, near.at) < dist(best.at, near.at) ? r : best), null);
        if (rec && dist(rec.at, near.at) < 3) {
          if (rec.mode !== 'merged' && rec.mode !== 'break') continue; // none, or never answered
          if (rec.mode === 'break') {
            // Bollards close ONE arm at this place. The arm whose heading was
            // recorded is severed here; the other passes through.
            const hA = headingAt(A, near.sa), hB = headingAt(B, near.sb);
            const dA = Math.abs(((hA - (rec.dir || 0) + 270) % 180) - 90);
            const dB = Math.abs(((hB - (rec.dir || 0) + 270) % 180) - 90);
            links.push({ a, b, at: near.at, sa: near.sa, sb: near.sb, blocked: dA <= dB ? 'a' : 'b' });
            continue;
          }
        }
      }
      links.push({ a, b, at: near.at, sa: near.sa, sb: near.sb, blocked: null });
    }
  }

  // Components: union-find over the ways. Deliberately its own, not netRoot —
  // that one merges 'break' junctions too, because they are one draggable
  // object, so reusing it would read a bollarded arm as connected.
  const par = ways.map((_, i) => i);
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (const l of links) {
    if (l.blocked) continue;
    const ra = find(l.a), rb = find(l.b);
    if (ra !== rb) par[ra] = rb;
  }
  const comp = ways.map((_, i) => find(i));

  // Entries: a way is an entrance if it is a driveway, if it passes an access
  // point, or if it runs off the parcel.
  const access = (plan.annotations || []).filter((a) => a.kind === 'access' && a.points && a.points[0]);
  const entryComps = new Set();
  const entryWays = new Set();
  for (const w of ways) {
    let isEntry = w.kind === 'driveway';
    if (!isEntry) {
      for (const ap of access) {
        const p = ap.points[0];
        let d = Infinity;
        for (let i = 0; i < w.pts.length - 1; i++) d = Math.min(d, distPointSegment(p, w.pts[i], w.pts[i + 1]));
        if (d <= (w.width + (ap.width || 6)) / 2 + 1) { isEntry = true; break; }
      }
    }
    if (!isEntry && plan.site && plan.site.length >= 3) {
      for (let i = 0; i < w.pts.length - 1 && !isEntry; i++) {
        for (let j = 0; j < plan.site.length; j++) {
          if (segmentsIntersect(w.pts[i], w.pts[i + 1], plan.site[j], plan.site[(j + 1) % plan.site.length])) { isEntry = true; break; }
        }
      }
    }
    if (isEntry) { entryComps.add(comp[w.id]); entryWays.add(w.id); }
  }

  return { ways, links, comp, entryComps, entryWays, crossings, blockers, region, vehicle: v };
}

function headingAt(w, s) {
  const d = dirAt(w.pts, w.cum, s);
  return ((Math.atan2(d.y, d.x) * 180) / Math.PI + 360) % 180;
}

// ---------- The checks ----------

/** Corner issues: every place the network turns, against what the vehicle needs. */
function cornerIssues(net, v) {
  const out = [];
  const { ways, links } = net;
  // Points of interest per way: the ends, plus every link.
  const marks = ways.map((w) => [0, w.length]);
  links.forEach((l) => { marks[l.a].push(l.sa); marks[l.b].push(l.sb); });
  marks.forEach((m) => m.sort((a, b) => a - b));
  const armLen = (w, s, back) => {
    const m = marks[w.id];
    if (back) {
      let prev = 0;
      for (const x of m) if (x < s - 0.5) prev = x;
      return s - prev;
    }
    let next = w.length;
    for (let i = m.length - 1; i >= 0; i--) if (m[i] > s + 0.5) next = m[i];
    return next - s;
  };
  const test = (label, at, phiDeg, la, lb, wAvail, ref) => {
    if (phiDeg > 170) return;                      // effectively straight
    const free = Math.max(0, wAvail - 2 * CLEAR);
    const byWidth = radiusForWidth(v, free);
    // Too narrow to turn in at all is a different problem from too tight a
    // radius, and saying "Infinity m vereist" is not a sentence.
    if (!isFinite(byWidth)) {
      out.push({
        kind: 'corner', sev: 'error', label,
        need: `${wAvail.toFixed(1)} m breed — te smal om hier te draaien`,
        at, ref, value: wAvail, want: null, narrow: true,
      });
      return;
    }
    const need = Math.max(v.rDesign, byWidth);
    const offer = Math.min(la, lb) * Math.tan((phiDeg * Math.PI) / 360);
    if (!(offer < need - 1e-6)) return;
    out.push({
      kind: 'corner', sev: 'error', label,
      need: `R ${offer.toFixed(1)} m · ${need.toFixed(1)} m vereist`,
      at, ref, value: offer, want: need,
    });
  };

  // Corners inside a straight-drawn way. Curved ways are handled below: their
  // points come from tessellation, so a per-vertex angle there measures the
  // tessellator, not the road.
  for (const w of ways) {
    if (w.curved || w.pts.length < 3) continue;
    for (let i = 1; i < w.pts.length - 1; i++) {
      const a = w.pts[i - 1], b = w.pts[i], c = w.pts[i + 1];
      const phi = interiorAngle(a, b, c);
      if (phi > 170) continue;
      test(`Bocht in ${w.name}`, b, phi, w.cum[i] - w.cum[i - 1], w.cum[i + 1] - w.cum[i], w.wmin, w.ref);
    }
  }
  // Smoothly drawn ways are tessellated at 10 points per span, so per-vertex
  // angles are meaningless. Measure the circumradius over a fixed arc-length
  // window instead, and report the TIGHTEST point once per way. A wiggly curve
  // dips below the limit a dozen times; a dozen rows saying the same thing is
  // not a dozen problems, and the row you click has to take you to the worst
  // one anyway.
  for (const w of ways) {
    if (!w.curved || w.pts.length < 5) continue;
    const free = Math.max(0, w.wmin - 2 * CLEAR);
    const byWidth = radiusForWidth(v, free);
    const need = isFinite(byWidth) ? Math.max(v.rDesign, byWidth) : Infinity;
    const WIN = 3;                                   // m of arc on each side
    let worst = null;
    for (let i = 0; i < w.pts.length; i++) {
      const r = circumRadius(atArc(w, w.cum[i] - WIN), w.pts[i], atArc(w, w.cum[i] + WIN));
      if (r < need && (!worst || r < worst.r)) worst = { r, at: w.pts[i] };
    }
    if (worst) out.push(curveIssue(w, worst, need));
  }

  // Corners where two ways meet: turning from one into the other.
  for (const l of links) {
    if (l.blocked) continue;
    const A = ways[l.a], B = ways[l.b];
    const da = dirAt(A.pts, A.cum, l.sa), db = dirAt(B.pts, B.cum, l.sb);
    // Both senses of the turn; the tighter one is the one that has to fit.
    const dot = Math.max(-1, Math.min(1, da.x * db.x + da.y * db.y));
    const turn = (Math.acos(Math.abs(dot)) * 180) / Math.PI;   // 0..90
    const phi = 180 - turn;
    if (phi > 170) continue;
    const la = Math.max(armLen(A, l.sa, true), armLen(A, l.sa, false));
    const lb = Math.max(armLen(B, l.sb, true), armLen(B, l.sb, false));
    test(`Bocht ${A.name} → ${B.name}`, l.at, phi, la, lb, Math.min(A.wmin, B.wmin), A.ref);
  }
  return out;
}

// Point at arc-length `s` on a way, clamped to its ends.
function atArc(w, s) {
  const t = Math.max(0, Math.min(w.length, s));
  let i = 0;
  while (i < w.cum.length - 2 && w.cum[i + 1] < t) i++;
  const seg = w.cum[i + 1] - w.cum[i] || 1;
  const f = (t - w.cum[i]) / seg;
  return { x: w.pts[i].x + (w.pts[i + 1].x - w.pts[i].x) * f, y: w.pts[i].y + (w.pts[i + 1].y - w.pts[i].y) * f };
}
// Radius of the circle through three points; Infinity when they are collinear.
function circumRadius(a, b, c) {
  const A = dist(b, c), B = dist(a, c), C = dist(a, b);
  const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
  if (area2 < 1e-9) return Infinity;
  return (A * B * C) / (2 * area2);
}
const curveIssue = (w, run, need) => ({
  kind: 'corner', sev: 'error', label: `Bocht in ${w.name}`,
  need: isFinite(need)
    ? `R ${run.r.toFixed(1)} m · ${need.toFixed(1)} m vereist`
    : `${w.wmin.toFixed(1)} m breed — te smal om hier te draaien`,
  at: run.at, ref: w.ref, value: run.r, want: isFinite(need) ? need : null,
});

function interiorAngle(a, b, c) {
  const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
  const lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
  const dot = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
  return (Math.acos(dot) * 180) / Math.PI;
}

/** Dead ends with no room to turn round and no way to reverse out. */
function deadEndIssues(net, v, plan) {
  const out = [];
  const { ways, links } = net;
  const turnPolys = (plan.turnarounds || []).map((t) => t.poly || t);
  for (const w of ways) {
    if (w.kind === 'turnaround') continue;
    const onWay = links.filter((l) => (l.a === w.id || l.b === w.id) && !l.blocked)
      .map((l) => (l.a === w.id ? l.sa : l.sb));
    for (const [s, end] of [[0, w.pts[0]], [w.length, w.pts[w.pts.length - 1]]]) {
      if (onWay.some((x) => Math.abs(x - s) < 1.5)) continue;       // joined here
      if (net.entryWays.has(w.id) && isOutside(end, plan.site)) continue; // leaves the site
      // Room to turn round?
      if (turnPolys.some((p) => p && pointInPolygon(end, p))) continue;
      // Reverse out to the nearest junction?
      const back = onWay.length ? Math.min(...onWay.map((x) => Math.abs(x - s))) : Infinity;
      if (back <= v.reverseLimit) continue;
      out.push({
        kind: 'deadend', sev: 'error', label: `${w.name}, doodlopend`,
        need: v.reverseLimit > 0
          ? `geen keerruimte binnen ${v.reverseLimit} m`
          : 'geen keerruimte — dit voertuig mag niet achteruit',
        at: end, ref: w.ref,
      });
    }
  }
  return out;
}
const isOutside = (p, site) => !site || site.length < 3 || !pointInPolygon(p, site);

/** Which stalls a vehicle can actually reach. */
export function reachStalls(net, stalls, params, v) {
  const total = (stalls || []).length;
  let ok = 0;
  const bad = [];
  const depth = (params && params.stallDepth) || 5.5;
  for (const st of (stalls || [])) {
    const c = polygonCentroid(st.poly);
    let served = false;
    for (const w of net.ways) {
      if (w.wmin < v.width + 2 * CLEAR) continue;
      if (!net.entryComps.has(net.comp[w.id])) continue;
      let d = Infinity;
      for (let i = 0; i < w.pts.length - 1; i++) d = Math.min(d, distPointSegment(c, w.pts[i], w.pts[i + 1]));
      if (d <= depth / 2 + w.width / 2 + 0.5) { served = true; break; }
    }
    if (served) ok++; else bad.push(st.key);
  }
  return { total, ok, bad };
}

/** How far the fire vehicle has to stand from each facade. */
export function facadeAccess(net, plan, v, maxDist) {
  const out = [];
  const usable = net.ways.filter((w) => w.wmin >= v.widthReq && net.entryComps.has(net.comp[w.id]));
  if (!usable.length) return out;
  (plan.obstacles || []).forEach((o, oi) => {
    const poly = polyOf(o);
    if (!poly || poly.length < 3) return;
    const label = (BUILDING_USES[(o && o.use) || DEFAULT_USE] || {}).label || 'Gebouw';
    // Grouped per facade side, or a 20-vertex building gives 20 rows.
    const sides = new Map();
    for (const s of sampleEdges(poly, 2)) {
      let best = Infinity, to = null;
      for (const w of usable) {
        for (let i = 0; i < w.pts.length - 1; i++) {
          const d = distPointSegment(s, w.pts[i], w.pts[i + 1]);
          if (d < best) { best = d; to = nearestOnSeg(s, w.pts[i], w.pts[i + 1]); }
        }
      }
      const side = compass(s.nx, s.ny);
      const cur = sides.get(side);
      if (!cur || best > cur.dist) sides.set(side, { dist: best, at: { x: s.x, y: s.y }, to });
    }
    for (const [side, r] of sides) {
      if (!(r.dist > maxDist)) continue;
      out.push({
        kind: 'fire', sev: 'error', label: `Gevel ${label} ${side}`,
        need: `${r.dist.toFixed(0)} m tot brandweertoegang (max ${maxDist} m)`,
        at: r.at, to: r.to, ref: { kind: 'obs', index: oi }, value: r.dist,
      });
    }
  });
  return out;
}
function nearestOnSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + dx * t, y: a.y + dy * t };
}
// y grows downward, so a normal pointing at +y faces south.
function compass(nx, ny) {
  const a = ((Math.atan2(ny, nx) * 180) / Math.PI + 360) % 360;
  if (a < 22.5 || a >= 337.5) return 'oost';
  if (a < 67.5) return 'zuidoost';
  if (a < 112.5) return 'zuid';
  if (a < 157.5) return 'zuidwest';
  if (a < 202.5) return 'west';
  if (a < 247.5) return 'noordwest';
  if (a < 292.5) return 'noord';
  return 'noordoost';
}

// ---------- The report ----------

/**
 * The one call the UI makes. Returns the knelpunten, most severe first, plus
 * how many stalls the vehicle can reach.
 *
 * Root causes suppress their consequences: with no entrance every stall is
 * unreachable and every corner is moot, so reporting 105 rows would say
 * nothing. Two lines that name the cause say everything.
 */
export function analysePlan(plan, vehicle, opts = {}) {
  const v = typeof vehicle === 'string' ? vehicleOf(vehicle) : (vehicle || VEHICLES[DEFAULT_VEHICLE]);
  const maxDist = opts.fireMaxDist > 0 ? opts.fireMaxDist : 60;
  const net = buildDriveNetwork(plan, v);
  const stalls = plan.stalls || [];
  const issues = [];

  if (!net.ways.length) {
    return {
      vehicle: v, net, issues: [], reach: { total: stalls.length, ok: 0, bad: [] },
      empty: true,
    };
  }

  const reach = reachStalls(net, stalls, plan.params || {}, v);

  if (!net.entryComps.size) {
    issues.push({
      kind: 'entry', sev: 'error', label: 'Geen inrit',
      need: 'teken een in/uitrit of zet een toegangspunt op de siterand',
      at: polygonCentroid(net.ways[0].pts.concat(net.ways[0].pts.slice().reverse())),
      ref: net.ways[0].ref,
    });
  }
  // Ways carrying stalls that hang in a component of their own.
  const compsWithStalls = new Set();
  for (const w of net.ways) if (w.kind === 'aisle') compsWithStalls.add(net.comp[w.id]);
  if (compsWithStalls.size > 1) {
    const names = net.ways.filter((w) => w.kind === 'aisle').map((w) => w.name);
    issues.push({
      kind: 'split', sev: 'error',
      label: `${compsWithStalls.size} losse delen`,
      need: `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''} zijn niet met elkaar verbonden`,
      at: net.ways[0].pts[0], ref: net.ways[0].ref,
    });
  }
  // An undecided crossing counts as not connected — the safe side, but it has
  // to be said out loud or the network falls apart with no visible cause.
  const undecided = net.crossings.filter((c) => {
    const rec = (plan.junctions || {})[c.key] || {};
    return !rec.mode;
  });
  if (undecided.length) {
    issues.push({
      kind: 'undecided', sev: 'warn',
      label: `${undecided.length} kruising${undecided.length > 1 ? 'en' : ''} zonder antwoord`,
      need: 'die tellen hier als niet verbonden',
      at: undecided[0].at, ref: { kind: 'annot', index: undecided[0].i },
    });
  }

  // Only once the network is whole and entered do the finer checks mean
  // anything. Reported anyway when there IS an entrance, suppressed when not.
  if (net.entryComps.size) {
    issues.push(...cornerIssues(net, v));
    issues.push(...deadEndIssues(net, v, plan));
    issues.push(...facadeAccess(net, plan, VEHICLES.fire, maxDist));
  }

  const rank = { entry: 0, split: 1, deadend: 2, corner: 3, fire: 4, undecided: 5 };
  issues.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (a.label < b.label ? -1 : 1));
  return { vehicle: v, net, issues, reach, empty: false };
}
