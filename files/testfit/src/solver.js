// ============================================================
// solver.js — automatic parking layout generator.
//
// Pipeline (mirrors the public patent-described approach used by
// surface-parking solvers):
//   1. buildable = offset(site, -setback) minus obstacles/building
//   2. candidate orientations = each site edge direction (+ its 90°)
//   3. for each orientation: rotate into a local frame, tile
//      double-loaded modules (stall + aisle + stall), and shape
//      each usable slot into a stall, testing containment
//   4. keep the orientation yielding the most stalls
// ============================================================

import {
  offsetPolygon, boundingBox, rotatePolygon, rotatePoint,
  quadInsidePolygon, quadIntersectsPolygon, edgeAngles, polygonArea, polygonCentroid,
  pointInPolygon, distPointToPolygonBoundary, polyOf,
} from './geometry.js?v=cad5baee';
import { ANNOT_TYPES, runoffOf } from './annots.js?v=cad5baee';

// Contiguous x-spans where the point (x, y) lies inside `poly`.
function insideSpans(poly, y, xMin, xMax, step) {
  const spans = [];
  let start = null;
  for (let x = xMin; x <= xMax + 1e-9; x += step) {
    const inside = pointInPolygon({ x, y }, poly);
    if (inside && start === null) start = x;
    else if (!inside && start !== null) { spans.push([start, x - step]); start = null; }
  }
  if (start !== null) spans.push([start, xMax]);
  return spans;
}

// Containment tests use ray casting, which is ambiguous for a point sitting
// exactly ON the boundary — and asymmetric: a quad flush against the low-x edge
// reads as inside while the identical quad at the high-x edge reads as outside.
// Test a hair-shrunk copy and emit the real one.
function insetQuad(q, e = 1e-3) {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => {
    const dx = cx - p.x, dy = cy - p.y, len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * e, y: p.y + (dy / len) * e };
  });
}

// A stall [x0,x1] is allowed if it sits in an aisle span and (for dead-end
// turnarounds) clears `turn` metres from both ends of that span.
function inAllowedSpan(x0, x1, spans, turn) {
  const mid = (x0 + x1) / 2;
  for (const [s0, s1] of spans) {
    if (mid >= s0 && mid <= s1) return x0 >= s0 + turn - 1e-6 && x1 <= s1 - turn + 1e-6;
  }
  return false;
}

// Stall type catalogue. `glyph` is a single char drawn on the stall when
// zoomed in; `label` is shown in the UI. Order defines legend/button order.
export const STALL_TYPES = {
  standard:   { key: 'standard',   label: 'Standaard',    color: '#3b82f6', glyph: '' },
  compact:    { key: 'compact',    label: 'Compact',      color: '#0ea5e9', glyph: 'C' },
  ev:         { key: 'ev',         label: 'EV / laadpunt', color: '#22c55e', glyph: 'E' },
  ada:        { key: 'ada',        label: 'Minder-valide', color: '#6366f1', glyph: '♿' },
  staff:      { key: 'staff',      label: 'Personeel',    color: '#f59e0b', glyph: 'P' },
  visitor:    { key: 'visitor',    label: 'Bezoeker',     color: '#ec4899', glyph: 'B' },
  reserved:   { key: 'reserved',   label: 'Gereserveerd', color: '#ef4444', glyph: 'R' },
  motorcycle: { key: 'motorcycle', label: 'Motor',        color: '#a855f7', glyph: 'M', spaces: 3 },
};

// Stable position keys so manual overrides survive re-solves. Stalls are
// grid-placed, so rounding the centroid to 0.5 m gives a robust identity.
export function stallKey(poly) {
  const c = polygonCentroid(poly);
  return Math.round(c.x * 2) / 2 + ',' + Math.round(c.y * 2) / 2;
}
export function aisleKey(quad) {
  const c = polygonCentroid(quad);
  return Math.round(c.x) + ',' + Math.round(c.y);
}

/** Long-axis unit vector and centre of an aisle quad (for arrows). */
export function aisleAxis(quad) {
  const a = quad[0], b = quad[1], c = quad[2], d = quad[3];
  const cx = (a.x + b.x + c.x + d.x) / 4, cy = (a.y + b.y + c.y + d.y) / 4;
  const len01 = Math.hypot(b.x - a.x, b.y - a.y);
  const len12 = Math.hypot(c.x - b.x, c.y - b.y);
  // The longer edge pair is the driving direction.
  let vx, vy, longLen, wide;
  if (len01 >= len12) { vx = b.x - a.x; vy = b.y - a.y; longLen = len01; wide = len12; }
  else { vx = c.x - b.x; vy = c.y - b.y; longLen = len12; wide = len01; }
  const inv = longLen > 0 ? 1 / longLen : 0;
  return { cx, cy, ux: vx * inv, uy: vy * inv, length: longLen, width: wide };
}

/**
 * Build the drivable/buildable region: the site shrunk by the setback,
 * with the building footprint and exclusion zones removed at solve time.
 */
export function computeBuildable(site, setback) {
  if (!site || site.length < 3) return null;
  return setback > 0 ? offsetPolygon(site, setback) : site.slice();
}

/**
 * Required ADA-accessible spaces from the 2010 ADA Standards Table 208.2,
 * plus the 1-in-6 van rule (§208.2.4).
 */
export function adaRequirement(totalStalls) {
  const table = [
    [25, 1], [50, 2], [75, 3], [100, 4], [150, 5], [200, 6],
    [300, 7], [400, 8], [500, 9], [1000, null],
  ];
  let required = 0;
  if (totalStalls <= 0) return { required: 0, van: 0 };
  if (totalStalls <= 500) {
    for (const [upTo, count] of table) {
      if (totalStalls <= upTo) { required = count; break; }
    }
  } else if (totalStalls <= 1000) {
    required = Math.ceil((totalStalls - 500) / 100) + 9;
  } else {
    required = Math.ceil(totalStalls / 100) + 11;
  }
  const van = Math.max(1, Math.ceil(required / 6));
  return { required, van };
}

/**
 * Core solve. Returns { stalls, aisles, angleUsed, orientations }.
 * `params` carries stall/aisle dimensions and layout options.
 * `orientationIndex` picks among the ranked candidate orientations
 * (the "Row Axis change" cycle); defaults to the best.
 */
export function solveParking(site, obstacles, params, orientationIndex = 0) {
  const empty = { stalls: [], aisles: [], islands: [], turnarounds: [], angleUsed: 0, orientationCount: 0 };
  const buildable = computeBuildable(site, params.setback);
  if (!buildable || polygonArea(buildable) < 1) return empty;

  // Expand obstacles by the padding buffer so stalls keep clearance.
  const pad = params.padding || 0;
  const blockers = (obstacles || [])
    .map((o) => { const p = polyOf(o); return pad > 0 ? offsetPolygon(p, -pad) : p.slice(); })
    .filter(Boolean);

  if (params.layout === 'perimeter') return { ...packConcentric(buildable, blockers, params), orientationCount: 1 };
  if (params.layout === 'hybrid') return { ...packHybrid(buildable, blockers, params), orientationCount: 1 };
  return packStripBest(buildable, blockers, params, orientationIndex);
}

/** Direction (rad, in [0,PI)) of the longest edge of a polygon. */
export function longestEdgeAngle(poly) {
  let best = 0, bestLen = -1;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) { bestLen = len; best = Math.atan2(b.y - a.y, b.x - a.x); }
  }
  return ((best % Math.PI) + Math.PI) % Math.PI;
}

// Straight strip packing across candidate orientations; returns the best.
// Orientations = each edge direction (+ normal), deduped ~2° and capped so a
// many-vertex spline boundary doesn't explode into hundreds of them.
// If params.alignAngle is set, only that angle (+ its normal) is tried, so
// rows line up with the chosen site edge.
function packStripBest(buildable, blockers, params, orientationIndex = 0) {
  let angleSet;
  if (typeof params.alignAngle === 'number') {
    const a = ((params.alignAngle % Math.PI) + Math.PI) % Math.PI;
    angleSet = [a, ((a + Math.PI / 2) % Math.PI + Math.PI) % Math.PI];
  } else {
    const base = edgeAngles(buildable);
    const TOL = 0.035, CAP = 40;
    angleSet = [];
    for (const a of base) {
      for (const cand of [a, a + Math.PI / 2]) {
        const norm = ((cand % Math.PI) + Math.PI) % Math.PI;
        if (!angleSet.some((x) => Math.abs(x - norm) < TOL || Math.abs(x - norm) > Math.PI - TOL)) angleSet.push(norm);
      }
      if (angleSet.length >= CAP) break;
    }
  }
  if (angleSet.length === 0) angleSet.push(0);
  const results = angleSet.map((theta) => packOrientation(buildable, blockers, params, theta));
  results.sort((a, b) => b.stalls.length - a.stalls.length);
  const chosen = results[Math.min(orientationIndex, results.length - 1)] || { stalls: [], aisles: [], islands: [], turnarounds: [], angleUsed: 0 };
  return { ...chosen, orientationCount: results.length };
}

// Sample a polygon perimeter every `step`, returning points with an inward
// unit normal (oriented toward `interior`). Used for curved parking rows.
function sampleRing(poly, step, interior) {
  const out = [];
  const n = poly.length;
  let carry = 0; // distance already consumed into the current edge
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const ux = ex / len, uy = ey / len;
    let nx = -uy, ny = ux;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((interior.x - mx) * nx + (interior.y - my) * ny < 0) { nx = -nx; ny = -ny; }
    let dpos = carry;
    while (dpos <= len + 1e-9) {
      out.push({ x: a.x + ux * dpos, y: a.y + uy * dpos, nx, ny });
      dpos += step;
    }
    carry = dpos - len; // leftover carried into the next edge
  }
  return out;
}

// Lay a curved band whose outer edge is offset(buildable, outerInset),
// extending inward by `dep`. Returns the quads that fit (curved stalls or an
// aisle band). Outer corners hug the boundary, so validity is tested on the
// interior side (centre + inner-edge midpoint).
function layBand(buildable, blockers, interior, centroids, minSep, outerInset, dep, isStall, w) {
  const ring = outerInset === 0 ? buildable : offsetPolygon(buildable, outerInset);
  if (!ring || polygonArea(ring) < 4) return [];
  const samples = sampleRing(ring, w, interior);
  const quads = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const p0 = samples[i], p1 = samples[i + 1];
    if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > w * 2.2) continue; // wrap seam
    const quad = [
      { x: p0.x, y: p0.y },
      { x: p1.x, y: p1.y },
      { x: p1.x + p1.nx * dep, y: p1.y + p1.ny * dep },
      { x: p0.x + p0.nx * dep, y: p0.y + p0.ny * dep },
    ];
    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    if (isStall && centroids.some((c) => Math.hypot(c.x - cx, c.y - cy) < minSep)) continue;
    const imx = (quad[2].x + quad[3].x) / 2, imy = (quad[2].y + quad[3].y) / 2;
    if (!pointInPolygon({ x: cx, y: cy }, buildable)) continue;
    if (!pointInPolygon({ x: imx, y: imy }, buildable)) continue;
    if (blockers.some((b) => quadIntersectsPolygon(quad, b))) continue;
    if (isStall) centroids.push({ x: cx, y: cy });
    quads.push(quad);
  }
  return quads;
}

/**
 * Concentric / perimeter parking: offset the boundary inward in
 * double-loaded modules and lay curved rows of stalls (perpendicular to
 * the boundary) that follow the site's curves, with curved drive aisles.
 */
function packConcentric(buildable, blockers, params) {
  const w = params.stallWidth, d = params.stallDepth, aisle = params.aisleWidth;
  const moduleH = 2 * d + aisle;
  const interior = polygonCentroid(buildable);
  const stalls = [], aisles = [], centroids = [];
  const minSep = 0.6 * Math.min(w, d);
  for (let k = 0; k < 60; k++) {
    const o0 = k * moduleH;
    const outer = layBand(buildable, blockers, interior, centroids, minSep, o0, d, true, w);
    const aq = layBand(buildable, blockers, interior, centroids, minSep, o0 + d, aisle, false, w);
    const inner = layBand(buildable, blockers, interior, centroids, minSep, o0 + d + aisle, d, true, w);
    if (outer.length === 0 && inner.length === 0) break;
    for (const q of outer) stalls.push({ poly: q, type: 'standard' });
    for (const q of inner) stalls.push({ poly: q, type: 'standard' });
    if (outer.length || inner.length) for (const q of aq) aisles.push(q);
  }
  assignStallTypes(stalls, params);
  return { stalls, aisles, islands: [], turnarounds: [], angleUsed: 0 };
}

/**
 * Hybrid: one perimeter row of curved stalls hugging the boundary + a curved
 * drive aisle, then straight strip packing for the interior. Best of both —
 * the edge follows the curve, the middle stays dense.
 */
function packHybrid(buildable, blockers, params) {
  const w = params.stallWidth, d = params.stallDepth, aisle = params.aisleWidth;
  const interior = polygonCentroid(buildable);
  const stalls = [], aisles = [], centroids = [];
  const minSep = 0.6 * Math.min(w, d);
  const outer = layBand(buildable, blockers, interior, centroids, minSep, 0, d, true, w);
  const aq = layBand(buildable, blockers, interior, centroids, minSep, d, aisle, false, w);
  for (const q of outer) stalls.push({ poly: q, type: 'standard' });
  for (const q of aq) aisles.push(q);

  // Straight interior: strip-pack the full buildable, then keep only stalls
  // deep enough to clear the perimeter module. (Offsetting the boundary that
  // deep can collapse on curved splines, so we filter by distance instead.)
  const strip = packStripBest(buildable, blockers, params, 0);
  const inset = d + aisle;
  for (const st of strip.stalls) {
    if (distPointToPolygonBoundary(polygonCentroid(st.poly), buildable) > inset) stalls.push(st);
  }
  for (const a of strip.aisles) {
    if (distPointToPolygonBoundary(polygonCentroid(a), buildable) > d) aisles.push(a);
  }
  // Straight interior can carry landscape islands.
  const islands = strip.islands ? strip.islands.filter((is) => distPointToPolygonBoundary(polygonCentroid(is), buildable) > d) : [];
  assignStallTypes(stalls, params);
  return { stalls, aisles, islands, turnarounds: [], angleUsed: 0 };
}

/**
 * Pack one orientation: rotate the world so aisles run horizontally,
 * tile double-loaded modules bottom-to-top, place stalls per column,
 * then rotate the placed geometry back to world space.
 */
function packOrientation(buildable, blockers, params, theta) {
  const pivot = { x: 0, y: 0 };
  // Rotate buildable & blockers into the local (aligned) frame.
  const local = rotatePolygon(buildable, -theta, pivot);
  const localBlockers = blockers.map((b) => rotatePolygon(b, -theta, pivot));
  const bb = boundingBox(local);

  const angleRad = (params.angle * Math.PI) / 180;
  const w = params.stallWidth;
  const d = params.stallDepth;
  const aisle = params.aisleWidth;

  // Angled-parking geometry. For 90° this reduces to pitch=w, rowDepth=d.
  const sinA = Math.sin(angleRad);
  const cosA = Math.cos(angleRad);
  const pitch = w / sinA;                 // along-aisle spacing per stall
  const rowDepth = d * sinA + w * cosA;   // perpendicular depth of a row
  const shear = d * cosA;                 // horizontal skew front→back
  const moduleH = 2 * rowDepth + aisle;   // double-loaded module height

  const stalls = [];
  const aisles = [];
  const islands = [];
  const turnarounds = [];
  const maxRun = params.maxRun > 0 ? params.maxRun : Infinity;
  const islandW = params.islandWidth > 0 ? params.islandWidth : 0;
  const singleLoaded = !!params.singleLoaded;
  const deadEnd = !!params.deadEndTurnaround;
  const turn = params.turnaround > 0 ? params.turnaround : 7;

  // Landscape-island columns: after every `maxRun` stalls reserve a strip of
  // width `islandW`. Positions are constant across modules so the green
  // islands line up in columns (like TestFit's "Max stall run" planters).
  let islandRanges = null;
  if (islandW > 0 && isFinite(maxRun) && maxRun >= 1) {
    islandRanges = [];
    const period = maxRun * pitch + islandW;
    for (let x = bb.minX + maxRun * pitch; x + islandW <= bb.maxX + 1e-6; x += period) islandRanges.push([x, x + islandW]);
    if (islandRanges.length === 0) islandRanges = null;
  }
  const overlapsIsland = (x0, x1) => islandRanges && islandRanges.some(([a, b]) => x0 < b - 1e-6 && x1 > a + 1e-6);

  // End aisles: a cross-aisle at one or both ends of the rows, running
  // perpendicular to them. Without it the rows are parallel islands that touch
  // nothing — the solver has never laid a connector, so a freshly solved plan
  // was not drivable at all. Reserved exactly like the island columns above, so
  // the stall loop needs one more test and nothing else.
  const endMode = params.endAisles === 'none' || params.endAisles === 'both' ? params.endAisles : 'one';
  const endW = aisle;
  let endBands = null;
  if (endMode !== 'none' && bb.maxX - bb.minX > endW * 2 + pitch) {
    // With one band, put it at the end nearest an entrance so the drive in is
    // short; with none given, the low-x end is as good as any.
    let atLow = true;
    if (endMode === 'one' && (params.entries || []).length) {
      const local0 = (params.entries || []).map((e) => rotatePoint(e, -theta, pivot));
      const mid = (bb.minX + bb.maxX) / 2;
      atLow = local0.reduce((s, p) => s + (p.x < mid ? 1 : -1), 0) >= 0;
    }
    endBands = [];
    if (endMode === 'both' || atLow) endBands.push([bb.minX, bb.minX + endW]);
    if (endMode === 'both' || !atLow) endBands.push([bb.maxX - endW, bb.maxX]);
  }
  const overlapsEnd = (x0, x1) => endBands && endBands.some(([a, b]) => x0 < b - 1e-6 && x1 > a + 1e-6);

  // Place one row of stalls; returns how many were placed.
  const placeRow = (y0, y1, dir, spans) => {
    let placed = 0, run = 0;
    for (let x = bb.minX; x + pitch <= bb.maxX + 1e-6; x += pitch) {
      if (overlapsIsland(x, x + pitch)) { run = 0; continue; }   // landscape island
      if (overlapsEnd(x, x + pitch)) { run = 0; continue; }       // end cross-aisle
      if (!islandRanges && run >= maxRun) { run = 0; continue; } // planter gap (no island strip)
      if (spans && !inAllowedSpan(x, x + pitch, spans, turn)) { run = 0; continue; } // turnaround
      const quad = stallQuad(x, y0, y1, pitch, shear, dir);
      if (!quadInsidePolygon(quad, local)) { run = 0; continue; }
      if (localBlockers.some((b) => quadIntersectsPolygon(quad, b))) { run = 0; continue; }
      stalls.push({ poly: quad.map((p) => rotatePoint(p, theta, pivot)), type: 'standard' });
      placed++; run++;
    }
    return placed;
  };
  const aisleYs = [];   // [y0,y1] of every emitted aisle, for the end connectors
  const pushAisle = (y0, y1) => (aisleYs.push([y0, y1]), aisles.push(
    [{ x: bb.minX, y: y0 }, { x: bb.maxX, y: y0 }, { x: bb.maxX, y: y1 }, { x: bb.minX, y: y1 }]
      .map((p) => rotatePoint(p, theta, pivot))));
  // Emit landscape islands filling a single row band (only where inside the
  // buildable area and clear of blockers).
  const addIslandBand = (ry0, ry1) => {
    if (!islandRanges) return;
    for (const [a, b] of islandRanges) {
      const c = { x: (a + b) / 2, y: (ry0 + ry1) / 2 };
      if (!pointInPolygon(c, local)) continue;
      if (localBlockers.some((bl) => pointInPolygon(c, bl))) continue;
      islands.push([{ x: a, y: ry0 }, { x: b, y: ry0 }, { x: b, y: ry1 }, { x: a, y: ry1 }]
        .map((p) => rotatePoint(p, theta, pivot)));
    }
  };

  // The dead-end reservation already keeps stalls `turn` metres clear of both
  // ends of every aisle span, in both rows — that pocket costs real stalls and
  // until now showed nothing at all. Emit the hammerhead that lives in it.
  //
  // One is emitted at EVERY span end, not only at true dead ends: the solver
  // has no network, roads reach it only as blockers. That is harmless — extra
  // tarmac at a connected end is corner widening, which helps a vehicle turn —
  // and drive.js decides which of them is load-bearing.
  const addTurnarounds = (spans, ry0, ry1) => {
    if (!spans) return;
    const arm = Math.min(turn, 12);
    for (const [s0, s1] of spans) {
      if (s1 - s0 < 2 * arm) continue;   // no room for two, and no dead end worth the name
      for (const [x0, x1] of [[s0, s0 + arm], [s1 - arm, s1]]) {
        const quad = [{ x: x0, y: ry0 }, { x: x1, y: ry0 }, { x: x1, y: ry1 }, { x: x0, y: ry1 }];
        if (!quadInsidePolygon(insetQuad(quad), local)) continue;
        if (localBlockers.some((b) => quadIntersectsPolygon(quad, b))) continue;
        turnarounds.push(quad.map((p) => rotatePoint(p, theta, pivot)));
      }
    }
  };

  // Double-loaded modules bottom-to-top.
  let yBase = bb.minY;
  for (; yBase + moduleH <= bb.maxY + 1e-6; yBase += moduleH) {
    const aisleY0 = yBase + rowDepth, aisleY1 = aisleY0 + aisle;
    const spans = deadEnd ? insideSpans(local, (aisleY0 + aisleY1) / 2, bb.minX, bb.maxX, Math.min(pitch, aisle)) : null;
    const p1 = placeRow(yBase, yBase + rowDepth, 1, spans);
    const p2 = placeRow(aisleY1, aisleY1 + rowDepth, -1, spans);
    if (p1 + p2 > 0) pushAisle(aisleY0, aisleY1);
    if (p1 > 0) addIslandBand(yBase, yBase + rowDepth);
    if (p2 > 0) addIslandBand(aisleY1, aisleY1 + rowDepth);
    if (p1 + p2 > 0) addTurnarounds(spans, yBase, aisleY1 + rowDepth);
  }

  // Single-loaded module (aisle + one row) in a shallow leftover band.
  if (singleLoaded && bb.maxY - yBase >= aisle + rowDepth - 1e-6) {
    const aisleY0 = yBase, aisleY1 = yBase + aisle;
    const spans = deadEnd ? insideSpans(local, (aisleY0 + aisleY1) / 2, bb.minX, bb.maxX, Math.min(pitch, aisle)) : null;
    if (placeRow(aisleY1, aisleY1 + rowDepth, -1, spans) > 0) {
      pushAisle(aisleY0, aisleY1);
      addIslandBand(aisleY1, aisleY1 + rowDepth);
      addTurnarounds(spans, aisleY0, aisleY1 + rowDepth);
    }
  }

  // Close the network. One quad per gap between consecutive aisles, inside each
  // reserved end band: short pieces fit an irregular buildable where one band
  // over the full height would fail containment and connect nothing at all.
  if (endBands && aisleYs.length > 1) {
    aisleYs.sort((a, b) => a[0] - b[0]);
    for (const [x0, x1] of endBands) {
      for (let i = 0; i + 1 < aisleYs.length; i++) {
        const quad = [
          { x: x0, y: aisleYs[i][1] }, { x: x1, y: aisleYs[i][1] },
          { x: x1, y: aisleYs[i + 1][0] }, { x: x0, y: aisleYs[i + 1][0] },
        ];
        if (!quadInsidePolygon(insetQuad(quad), local)) continue;
        if (localBlockers.some((b) => quadIntersectsPolygon(quad, b))) continue;
        aisles.push(quad.map((p) => rotatePoint(p, theta, pivot)));
      }
    }
    // And reach the street: a spur from the end band out across the setback, at
    // the height of the nearest entrance. The buildable is the site shrunk by
    // `setback`, so that is exactly how far there is to go.
    const ent = (params.entries || []).map((e) => rotatePoint(e, -theta, pivot));
    const reach = (params.setback || 0) + 1;
    if (ent.length && reach > 1) {
      const lo = aisleYs[0][0], hi = aisleYs[aisleYs.length - 1][1];
      for (const [x0, x1] of endBands) {
        const outward = x0 <= bb.minX + 1e-6;
        // The entrance nearest this band, and the y where the spur leaves.
        let best = null;
        for (const e of ent) {
          const d = Math.abs(e.x - (outward ? x0 : x1));
          if (!best || d < best.d) best = { d, y: Math.max(lo, Math.min(hi, e.y)) };
        }
        if (!best) continue;
        const y0 = Math.max(lo, Math.min(hi - aisle, best.y - aisle / 2));
        const quad = outward
          ? [{ x: x0 - reach, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y0 + aisle }, { x: x0 - reach, y: y0 + aisle }]
          : [{ x: x0, y: y0 }, { x: x1 + reach, y: y0 }, { x: x1 + reach, y: y0 + aisle }, { x: x0, y: y0 + aisle }];
        if (localBlockers.some((b) => quadIntersectsPolygon(quad, b))) continue;
        aisles.push(quad.map((p) => rotatePoint(p, theta, pivot)));
      }
    }
  }

  assignStallTypes(stalls, params);
  return { stalls, aisles, islands, turnarounds, angleUsed: theta };
}

/**
 * A single stall as a 4-corner quad in the local frame.
 * `dir` mirrors the skew so the two rows form a herringbone for
 * angled layouts (no visual effect at 90°).
 */
function stallQuad(x, y0, y1, pitch, shear, dir) {
  const s = shear * dir;
  if (dir > 0) {
    return [
      { x, y: y0 },
      { x: x + pitch, y: y0 },
      { x: x + pitch - s, y: y1 },
      { x: x - s, y: y1 },
    ];
  }
  return [
    { x: x + s, y: y0 },
    { x: x + pitch + s, y: y0 },
    { x: x + pitch, y: y1 },
    { x, y: y1 },
  ];
}

/**
 * Distribute stall types across the placed stalls by ratio, then carve out the
 * ADA-required accessible spaces — nearest an entrance, when the plan says
 * where its entrances are (`params.entries`, world points).
 *
 * With no entries the old behaviour is kept exactly: the first stalls in
 * placement order. That used to be described as "nearest the centroid, a
 * stand-in for closest to the entrance", which it never was — on the demo plan
 * it put every accessible space in the far south-west corner.
 *
 * Straight-line distance, not a routed accessible path. An accessible route
 * along the drivable network would be better and is a follow-up; this at least
 * puts them at the right end of the site.
 */
function assignStallTypes(stalls, params) {
  const n = stalls.length;
  if (n === 0) return;
  // Target mix: a table of type → share of total. Falls back to the legacy
  // compactRatio/evRatio params when no table is supplied (older saves).
  const mix = params.mix || { compact: params.compactRatio || 0, ev: params.evRatio || 0 };
  const order = ['ev', 'compact', 'staff', 'visitor', 'reserved']; // assignment priority

  for (const st of stalls) st.type = 'standard';
  const taken = new Array(n).fill(false);
  for (const key of order) {
    const r = mix[key] || 0;
    if (r <= 0 || !STALL_TYPES[key]) continue;
    const count = Math.min(n, Math.round(r * n));
    if (count <= 0) continue;
    const stride = n / count;
    for (let k = 0; k < count; k++) {
      let idx = Math.round(k * stride) % n, guard = 0;
      while (taken[idx] && guard < n) { idx = (idx + 1) % n; guard++; }
      if (guard >= n) break;
      taken[idx] = true; stalls[idx].type = key;
    }
  }

  if (params.ada) {
    const { required } = adaRequirement(n);
    const entries = (params.entries || []).filter((e) => e && isFinite(e.x) && isFinite(e.y));
    let order = null;
    if (entries.length && params.adaNearEntry !== false) {
      order = stalls.map((st, i) => {
        const c = polygonCentroid(st.poly);
        let d = Infinity;
        for (const e of entries) d = Math.min(d, Math.hypot(c.x - e.x, c.y - e.y));
        // The key breaks ties deterministically: equal distances must never
        // flip between two solves of the same plan.
        return { i, d, k: stallKey(st.poly) };
      }).sort((a, b) => (a.d - b.d) || (a.k < b.k ? -1 : 1)).map((x) => x.i);
    }
    for (let k = 0; k < Math.min(required, n); k++) stalls[order ? order[k] : k].type = 'ada';
  }
}

// ============================================================
// One definition of "what the solver is asked", and one of "how good was it".
//
// Two features scored layouts before this — the compare table and the
// auto-optimiser — and each assembled its own solve arguments. They disagreed:
// one passed the road blockers and the other did not, neither passed the
// entrance hint the live solve passes, both hard-coded orientation 0, and both
// aligned to the tessellated ring rather than the control points the live solve
// uses. A variant that scores differently from the plan you get when you adopt
// it is worse than no variant at all, so the assembly lives here now and every
// caller goes through it.
// ============================================================

/** The params keys a layout variant is allowed to touch. */
export const VARY_KEYS = [
  'stallWidth', 'stallDepth', 'aisleWidth', 'angle', 'setback', 'padding',
  'maxRun', 'islandWidth', 'singleLoaded', 'deadEndTurnaround', 'turnaround',
  'layout', 'endAisles', 'alignLongestEdge', 'ada', 'mix', 'compactRatio', 'evRatio',
];

/**
 * Merge a patch over params. Shallow, except `mix`, which is a nested object:
 * every other patch path in this app spreads it and would silently replace the
 * whole table when a patch mentions one type.
 */
export function applyPatch(params, patch) {
  if (!patch) return params;
  const next = { ...params, ...patch };
  if (patch.mix) next.mix = { ...(params.mix || {}), ...patch.mix };
  return next;
}

/** Drop anything from a patch that is not a layout key (see VARY_KEYS). */
export function sanitizePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const k of VARY_KEYS) if (patch[k] !== undefined) out[k] = patch[k];
  return out;
}

/**
 * Everything the solver needs, assembled once.
 *
 * `alignAngle` comes from the *control points* (`site`), not the tessellated
 * ring (`sitePoly`): on a curved boundary the tessellation's longest edge is an
 * arbitrary 1/14th of an arc, which is not an edge anybody drew.
 */
export function buildSolveInput({ site, sitePoly, obstacles, roadBlockers, params, orientationIndex, entries, patch }) {
  const p = applyPatch(params, patch ? sanitizePatch(patch) : null);
  const solveP = { ...p };
  if (p.alignLongestEdge && site && site.length >= 2) solveP.alignAngle = longestEdgeAngle(site);
  if (entries && entries.length) solveP.entries = entries;
  return {
    site: sitePoly,
    // What the solver must drive around...
    obstacles: roadBlockers && roadBlockers.length ? [...(obstacles || []), ...roadBlockers] : (obstacles || []),
    // ...but roads are not buildings, so the coverage and FAR figures see only
    // the real ones. Keeping the split here is what stops a variant card and the
    // dealbar disagreeing for reasons that have nothing to do with the variant.
    metricObstacles: obstacles || [],
    params: solveP,
    orientationIndex: orientationIndex || 0,
  };
}

/**
 * Layer the document's manual decisions over a raw solve, exactly as the live
 * plan does. Metrics are computed on the result of this, so a variant's numbers
 * and the plan's numbers come from the same function rather than from two
 * definitions that drift.
 */
export function decorate(result, { overrides, manualStalls, params } = {}) {
  const ov = overrides || {};
  const ovStalls = ov.stalls || {}, ovAisles = ov.aisles || {}, ovAngles = ov.angles || {};
  const locks = ov.locks || {}, lockS = locks.stalls || {}, lockA = locks.aisles || {};
  const removed = ov.removed || {};
  const w = (params || {}).stallWidth, d = (params || {}).stallDepth;
  const reangle = (poly, key) => {
    const deg = ovAngles[key];
    if (deg == null) return poly;
    const c = polygonCentroid(poly), th = (deg * Math.PI) / 180;
    const ux = Math.cos(th), uy = Math.sin(th), vx = -Math.sin(th), vy = Math.cos(th), hw = w / 2, hd = d / 2;
    return [
      { x: c.x - ux * hw - vx * hd, y: c.y - uy * hw - vy * hd },
      { x: c.x + ux * hw - vx * hd, y: c.y + uy * hw - vy * hd },
      { x: c.x + ux * hw + vx * hd, y: c.y + uy * hw + vy * hd },
      { x: c.x - ux * hw + vx * hd, y: c.y - uy * hw + vy * hd },
    ];
  };
  const stalls = (result.stalls || []).map((st) => {
    const key = stallKey(st.poly);
    return { ...st, key, poly: reangle(st.poly, key), type: ovStalls[key] || st.type, locked: !!lockS[key], angle: ovAngles[key], manual: false };
  }).filter((st) => !removed[st.key]);
  for (const ms of manualStalls || []) {
    const key = stallKey(ms.poly);
    stalls.push({ poly: reangle(ms.poly, key), key, type: ovStalls[key] || ms.type || 'standard', locked: !!lockS[key], angle: ovAngles[key], manual: true });
  }
  const gone = ov.aislesRemoved || {};
  const aisles = (result.aisles || []).map((q) => {
    const key = aisleKey(q);
    const o = ovAisles[key] || {};
    return { poly: q, key, oneway: !!o.oneway, dir: o.dir || 1, locked: !!lockA[key] };
  }).filter((a) => !gone[a.key]);
  return { stalls, aisles, islands: result.islands || [], turnarounds: result.turnarounds || [], orientationCount: result.orientationCount };
}

/**
 * Is this layout physically possible?
 *
 * The old test was "at least 20 m² of site per stall", a threshold on a
 * dimensioned quantity with no basis behind it. Measured on the demo site, the
 * concentric layout passes it at 21.7 m²/stall while overlapping 43 pairs of
 * stalls and covering 1.80× the ground that exists; on a curved site the
 * optimiser picked the hybrid layout at 1.12× and applied it without asking.
 *
 *  - `stallOverlaps` — a stall on a stall is never acceptable. Hard reject.
 *  - `packedRatio`   — paved area over buildable area. Dimensionless, so it does
 *                      not care how big the site is.
 *
 * The 1.05 tolerance is empirical rather than principled, and the number matters:
 * a clean strip pack on a 16-gon measures 1.02, because `computeBuildable` is a
 * polygon offset and the offset of a many-sided near-circle is slightly generous.
 * Anything under that is noise; 1.12 is a layout claiming ground it does not have.
 *
 * Known bias, stated rather than hidden: the denominator does not subtract
 * building footprints, because `computeBuildable` does not either and this
 * project deliberately carries no boolean polygon clipping. A site with a large
 * building therefore reads lower than the truth — the check under-flags, which
 * is the safe direction for a test that demotes candidates.
 */
export const PACKED_LIMIT = 1.05;

export function plausibility(decorated, site, params) {
  const buildable = computeBuildable(site, params.setback);
  const bArea = buildable ? polygonArea(buildable) : 0;
  let paved = 0;
  for (const s of decorated.stalls) paved += polygonArea(s.poly);
  for (const a of decorated.aisles || []) paved += polygonArea(a.poly || a);
  for (const t of decorated.turnarounds || []) paved += polygonArea(t.poly || t);

  // Stall-on-stall, via a grid bucket so this stays linear on a 7000-stall plan.
  const lim = 0.75 * Math.min(params.stallWidth, params.stallDepth);
  const cell = Math.max(lim, 1e-6);
  const grid = new Map();
  let stallOverlaps = 0;
  for (const s of decorated.stalls) {
    const c = polygonCentroid(s.poly);
    const gx = Math.floor(c.x / cell), gy = Math.floor(c.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get((gx + dx) + ':' + (gy + dy));
        if (!bucket) continue;
        for (const o of bucket) if (Math.hypot(o.x - c.x, o.y - c.y) < lim) stallOverlaps++;
      }
    }
    const k = gx + ':' + gy;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  const packedRatio = bArea > 0 ? paved / bArea : 0;
  return { packedRatio, stallOverlaps, plausible: stallOverlaps === 0 && packedRatio <= PACKED_LIMIT };
}

/** Aggregate live metrics for the dashboard. */
// Kinds that add no paved surface of their own. Paint on existing asphalt and
// signs on posts do not make a site more impervious, and this is an exclusion
// list — anything not named here counts as paving, so new kinds must be added.
const NON_PAVED = new Set([
  'grass', 'tree', 'access',
  // paint on top of surfaces that are already counted
  'marking', 'crosswalk', 'sharkTeeth', 'stopLine', 'hatchZone', 'bayLines',
  'arrowAhead', 'arrowLeft', 'arrowRight', 'arrowAheadL', 'arrowAheadR', 'speedMark',
  'pictoBike', 'pictoEV', 'pictoAda', 'pictoWalk', 'pictoP', 'familyBay',
  // signage stands on a post
  'signYield', 'signStop', 'signSpeed', 'signNoEntry', 'signParking',
  'signOneWay', 'signAda', 'signEV',
  // a lamp post stands on a post too, and a carport roofs over parking that is
  // already counted — adding its footprint again would raise the impervious
  // share without a square metre of new paving
  'lightPole', 'carport',
]);

export function computeMetrics(site, obstacles, result, params, annotations) {
  const siteArea = site && site.length >= 3 ? polygonArea(site) : 0;
  const buildingArea = (obstacles || []).reduce((s, o) => s + polygonArea(polyOf(o)), 0);
  // Gross floor area = footprint × number of floors (default 1); FAR vs. site.
  const grossFloorArea = (obstacles || []).reduce((s, o) => s + polygonArea(polyOf(o)) * (o && o.floors ? o.floors : 1), 0);
  // Counts are in parking *spaces*: a motorcycle stall provides 3 spaces.
  const counts = {};
  for (const k of Object.keys(STALL_TYPES)) counts[k] = 0;
  for (const st of result.stalls) counts[st.type] = (counts[st.type] || 0) + (STALL_TYPES[st.type] ? STALL_TYPES[st.type].spaces || 1 : 1);
  const physicalStalls = result.stalls.length;               // stall footprints
  const total = Object.values(counts).reduce((a, b) => a + b, 0); // spaces (motor ×3)
  const buildable = computeBuildable(site, params.setback);
  const buildableArea = buildable ? polygonArea(buildable) : 0;
  // Gross area per stall footprint (lower is a denser, more efficient layout).
  const areaPerStall = physicalStalls > 0 ? buildableArea / physicalStalls : 0;
  const ada = adaRequirement(physicalStalls);
  const onewayAisles = (result.aisles || []).filter((a) => a.oneway).length;

  // Impervious (paved) coverage: buildings + parking + paved infrastructure,
  // excluding grass. Capped at the site area (overlaps inflate the raw sum).
  let paved = buildingArea;
  for (const st of result.stalls) paved += polygonArea(st.poly);
  for (const a of result.aisles || []) paved += polygonArea(a.poly || a);
  // Turnarounds are new paved surface that is NOT an annotation, so the
  // NON_PAVED exclusion list never sees them — they have to be added by hand or
  // the impervious percentage is quietly wrong forever.
  for (const t of result.turnarounds || []) paved += polygonArea(t.poly || t);
  for (const an of annotations || []) {
    if (!an.points || NON_PAVED.has(an.kind)) continue;
    // What the surface is made of scales its contribution: gravel and grass let
    // most of the rain through, asphalt none of it. Without a material chosen
    // this is 1, so the number is exactly what it was before materials existed.
    const ro = runoffOf(an);
    if (an.points.length >= 3 && (an.closed || an.kind === 'bikeparking')) paved += polygonArea(an.points) * ro;
    else if (an.points.length >= 2 && (an.kind === 'road' || an.kind === 'walkway' || an.kind === 'bikepath' || an.kind === 'drivethru')) {
      let len = 0;
      for (let i = 0; i < an.points.length - 1; i++) len += Math.hypot(an.points[i + 1].x - an.points[i].x, an.points[i + 1].y - an.points[i].y);
      paved += len * (an.width || (ANNOT_TYPES[an.kind] || {}).width || 1) * ro;
    }
  }
  const imperviousPct = siteArea > 0 ? Math.min(1, paved / siteArea) : 0;

  // Zoning parking requirement from building GLA (stalls per 100 m²).
  const gla = params.buildingGLA || 0;
  const ratio = params.parkingRatio || 0;
  const requiredStalls = gla > 0 && ratio > 0 ? Math.ceil((gla / 100) * ratio) : null;
  const accessCount = (annotations || []).filter((a) => a.kind === 'access').length;

  return {
    siteArea, buildingArea, buildableArea, total, physicalStalls, counts,
    areaPerStall, grossFloorArea,
    far: siteArea > 0 ? grossFloorArea / siteArea : 0,
    coverage: siteArea > 0 ? buildingArea / siteArea : 0,
    imperviousPct,
    adaRequired: ada.required, adaVan: ada.van,
    adaProvided: counts.ada || 0,
    requiredStalls, accessCount,
    orientationCount: result.orientationCount || 0,
    aisleCount: (result.aisles || []).length, onewayAisles,
  };
}
