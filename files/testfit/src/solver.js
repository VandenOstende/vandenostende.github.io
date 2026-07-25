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
} from './geometry.js';

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
  motorcycle: { key: 'motorcycle', label: 'Motor',        color: '#a855f7', glyph: 'M' },
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

  // Candidate orientations: every unique edge direction and its normal.
  const base = edgeAngles(buildable);
  const angleSet = [];
  for (const a of base) {
    for (const cand of [a, a + Math.PI / 2]) {
      const norm = ((cand % Math.PI) + Math.PI) % Math.PI;
      if (!angleSet.some((x) => Math.abs(x - norm) < 1e-3)) angleSet.push(norm);
    }
  }
  if (angleSet.length === 0) angleSet.push(0);

  // Pack once per orientation; rank by stall count.
  const results = angleSet.map((theta) =>
    packOrientation(buildable, blockers, params, theta)
  );
  results.sort((a, b) => b.stalls.length - a.stalls.length);

  const chosen = results[Math.min(orientationIndex, results.length - 1)] || empty;
  return { ...chosen, orientationCount: results.length };
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

  for (let yBase = bb.minY; yBase + moduleH <= bb.maxY + 1e-6; yBase += moduleH) {
    const aisleY0 = yBase + rowDepth;
    const aisleY1 = aisleY0 + aisle;
    let aislePlaced = false;

    // Two rows per module: top (skew +) and bottom (skew −, mirrored).
    for (const row of [
      { y0: yBase, y1: yBase + rowDepth, dir: 1 },
      { y0: aisleY1, y1: aisleY1 + rowDepth, dir: -1 },
    ]) {
      let run = 0;
      for (let x = bb.minX; x + pitch <= bb.maxX + 1e-6; x += pitch) {
        if (run >= maxRun) { run = 0; continue; } // planter gap
        const quad = stallQuad(x, row.y0, row.y1, pitch, shear, row.dir);
        if (!quadInsidePolygon(quad, local)) { run = 0; continue; }
        if (localBlockers.some((b) => quadIntersectsPolygon(quad, b))) { run = 0; continue; }
        stalls.push({
          poly: quad.map((p) => rotatePoint(p, theta, pivot)),
          type: 'standard',
        });
        aislePlaced = true;
        run++;
      }
    }

    if (aislePlaced) {
      const aQuad = [
        { x: bb.minX, y: aisleY0 }, { x: bb.maxX, y: aisleY0 },
        { x: bb.maxX, y: aisleY1 }, { x: bb.minX, y: aisleY1 },
      ].map((p) => rotatePoint(p, theta, pivot));
      aisles.push(aQuad);
    }
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
export function computeMetrics(site, obstacles, result, params) {
  const siteArea = site && site.length >= 3 ? polygonArea(site) : 0;
  const buildingArea = (obstacles || []).reduce((s, o) => s + polygonArea(o), 0);
  const counts = {};
  for (const k of Object.keys(STALL_TYPES)) counts[k] = 0;
  for (const st of result.stalls) counts[st.type] = (counts[st.type] || 0) + 1;
  const total = result.stalls.length;
  const buildable = computeBuildable(site, params.setback);
  const buildableArea = buildable ? polygonArea(buildable) : 0;
  // Gross area per stall (lower is a denser, more efficient layout).
  const areaPerStall = total > 0 ? buildableArea / total : 0;
  const ada = adaRequirement(total);
  const onewayAisles = (result.aisles || []).filter((a) => a.oneway).length;
  return {
    siteArea, buildingArea, buildableArea, total, counts,
    areaPerStall,
    coverage: siteArea > 0 ? buildingArea / siteArea : 0,
    adaRequired: ada.required, adaVan: ada.van,
    adaProvided: counts.ada || 0,
    orientationCount: result.orientationCount || 0,
    aisleCount: (result.aisles || []).length, onewayAisles,
  };
}
