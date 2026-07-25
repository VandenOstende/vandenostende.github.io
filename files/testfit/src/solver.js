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
  quadInsidePolygon, quadIntersectsPolygon, edgeAngles, polygonArea,
} from './geometry.js';

// Stall type catalogue. Dimensions in meters; ratio drives the mix.
export const STALL_TYPES = {
  standard: { key: 'standard', label: 'Standaard', color: '#3b82f6' },
  compact:  { key: 'compact',  label: 'Compact',   color: '#22c55e' },
  ev:       { key: 'ev',       label: 'EV',        color: '#14b8a6' },
  ada:      { key: 'ada',      label: 'ADA',       color: '#6366f1' },
};

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
  const counts = { standard: 0, compact: 0, ev: 0, ada: 0 };
  for (const st of result.stalls) counts[st.type] = (counts[st.type] || 0) + 1;
  const total = result.stalls.length;
  const buildable = computeBuildable(site, params.setback);
  const buildableArea = buildable ? polygonArea(buildable) : 0;
  // Gross area per stall (lower is a denser, more efficient layout).
  const areaPerStall = total > 0 ? buildableArea / total : 0;
  const ada = adaRequirement(total);
  return {
    siteArea, buildingArea, buildableArea, total, counts,
    areaPerStall,
    coverage: siteArea > 0 ? buildingArea / siteArea : 0,
    adaRequired: ada.required, adaVan: ada.van,
    orientationCount: result.orientationCount || 0,
  };
}
