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
  pointInPolygon, distPointToPolygonBoundary,
} from './geometry.js';

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
  const empty = { stalls: [], aisles: [], angleUsed: 0, orientationCount: 0 };
  const buildable = computeBuildable(site, params.setback);
  if (!buildable || polygonArea(buildable) < 1) return empty;

  // Expand obstacles by the padding buffer so stalls keep clearance.
  const pad = params.padding || 0;
  const blockers = (obstacles || [])
    .map((o) => (pad > 0 ? offsetPolygon(o, -pad) : o.slice()))
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
  const chosen = results[Math.min(orientationIndex, results.length - 1)] || { stalls: [], aisles: [], angleUsed: 0 };
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
  return { stalls, aisles, angleUsed: 0 };
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
  assignStallTypes(stalls, params);
  return { stalls, aisles, angleUsed: 0 };
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
  const maxRun = params.maxRun > 0 ? params.maxRun : Infinity;
  const singleLoaded = !!params.singleLoaded;
  const deadEnd = !!params.deadEndTurnaround;
  const turn = params.turnaround > 0 ? params.turnaround : 7;

  // Place one row of stalls; returns how many were placed.
  const placeRow = (y0, y1, dir, spans) => {
    let placed = 0, run = 0;
    for (let x = bb.minX; x + pitch <= bb.maxX + 1e-6; x += pitch) {
      if (run >= maxRun) { run = 0; continue; }                 // planter gap
      if (spans && !inAllowedSpan(x, x + pitch, spans, turn)) { run = 0; continue; } // turnaround
      const quad = stallQuad(x, y0, y1, pitch, shear, dir);
      if (!quadInsidePolygon(quad, local)) { run = 0; continue; }
      if (localBlockers.some((b) => quadIntersectsPolygon(quad, b))) { run = 0; continue; }
      stalls.push({ poly: quad.map((p) => rotatePoint(p, theta, pivot)), type: 'standard' });
      placed++; run++;
    }
    return placed;
  };
  const pushAisle = (y0, y1) => aisles.push(
    [{ x: bb.minX, y: y0 }, { x: bb.maxX, y: y0 }, { x: bb.maxX, y: y1 }, { x: bb.minX, y: y1 }]
      .map((p) => rotatePoint(p, theta, pivot)));

  // Double-loaded modules bottom-to-top.
  let yBase = bb.minY;
  for (; yBase + moduleH <= bb.maxY + 1e-6; yBase += moduleH) {
    const aisleY0 = yBase + rowDepth, aisleY1 = aisleY0 + aisle;
    const spans = deadEnd ? insideSpans(local, (aisleY0 + aisleY1) / 2, bb.minX, bb.maxX, Math.min(pitch, aisle)) : null;
    const placed = placeRow(yBase, yBase + rowDepth, 1, spans) + placeRow(aisleY1, aisleY1 + rowDepth, -1, spans);
    if (placed > 0) pushAisle(aisleY0, aisleY1);
  }

  // Single-loaded module (aisle + one row) in a shallow leftover band.
  if (singleLoaded && bb.maxY - yBase >= aisle + rowDepth - 1e-6) {
    const aisleY0 = yBase, aisleY1 = yBase + aisle;
    const spans = deadEnd ? insideSpans(local, (aisleY0 + aisleY1) / 2, bb.minX, bb.maxX, Math.min(pitch, aisle)) : null;
    if (placeRow(aisleY1, aisleY1 + rowDepth, -1, spans) > 0) pushAisle(aisleY0, aisleY1);
  }

  assignStallTypes(stalls, params);
  return { stalls, aisles, angleUsed: theta };
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
 * Distribute stall types across the placed stalls by ratio, then carve
 * out the ADA-required accessible spaces (placed nearest the centroid,
 * a stand-in for "closest to the entrance").
 */
function assignStallTypes(stalls, params) {
  const n = stalls.length;
  if (n === 0) return;
  const compactRatio = params.compactRatio || 0;
  const evRatio = params.evRatio || 0;

  // Deterministic spread so the mix is visually even.
  const compactEvery = compactRatio > 0 ? Math.round(1 / compactRatio) : 0;
  const evEvery = evRatio > 0 ? Math.round(1 / evRatio) : 0;
  stalls.forEach((st, i) => {
    if (evEvery && i % evEvery === evEvery - 1) st.type = 'ev';
    else if (compactEvery && i % compactEvery === 0) st.type = 'compact';
    else st.type = 'standard';
  });

  if (params.ada) {
    const { required } = adaRequirement(n);
    // Mark the first `required` stalls as ADA (kept near the front row).
    for (let i = 0; i < Math.min(required, n); i++) stalls[i].type = 'ada';
  }
}

/** Aggregate live metrics for the dashboard. */
export function computeMetrics(site, obstacles, result, params, annotations) {
  const siteArea = site && site.length >= 3 ? polygonArea(site) : 0;
  const buildingArea = (obstacles || []).reduce((s, o) => s + polygonArea(o), 0);
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
  for (const an of annotations || []) {
    if (!an.points || an.kind === 'grass' || an.kind === 'tree' || an.kind === 'access') continue;
    if (an.points.length >= 3 && (an.closed || an.kind === 'bikeparking')) paved += polygonArea(an.points);
    else if (an.points.length >= 2 && (an.kind === 'road' || an.kind === 'walkway' || an.kind === 'bikepath')) {
      let len = 0;
      for (let i = 0; i < an.points.length - 1; i++) len += Math.hypot(an.points[i + 1].x - an.points[i].x, an.points[i + 1].y - an.points[i].y);
      paved += len * (an.width || 1);
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
    areaPerStall,
    coverage: siteArea > 0 ? buildingArea / siteArea : 0,
    imperviousPct,
    adaRequired: ada.required, adaVan: ada.van,
    adaProvided: counts.ada || 0,
    requiredStalls, accessCount,
    orientationCount: result.orientationCount || 0,
    aisleCount: (result.aisles || []).length, onewayAisles,
  };
}
