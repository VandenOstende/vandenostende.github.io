// ============================================================
// app.js — ParkPlanner React UI (no build step; htm + React ESM)
// ============================================================
import React, { useReducer, useRef, useState, useEffect, useCallback, useMemo } from '../vendor/react.mjs';
import { createRoot } from '../vendor/react-dom-client.mjs';
import htm from '../vendor/htm.mjs';
import { solveParking, computeMetrics, computeBuildable, STALL_TYPES, stallKey, aisleKey, aisleAxis, longestEdgeAngle } from './solver.js?v=c8e60896';
import {
  offsetPolygon, boundingBox, polygonCentroid, polygonArea, dist, distPointSegment,
  pointInPolygon, rectPoly, tessellateClosed, polyOf, ribbonPoly, segmentCross,
  tessellateOpen, polylineCum, polylineAt, nearestOnPolyline, zebraQuads, hatchQuads, STRIPE_SPEC,
} from './geometry.js?v=c8e60896';
import { PICTOS, pathFrom, glyph, plate } from './pictos.js?v=c8e60896';
import { geocode, latLonToLocal, localToLatLon } from './basemap.js?v=c8e60896';
import { toGeoJSON, toDXF, toCSV } from './exporters.js?v=c8e60896';
import { parseParcel, simplifyRing } from './importers.js?v=c8e60896';
import { ANNOT_TYPES, ANNOT_GROUPS, SURFACES, surfaceOf, descOf, registerAsset, hideAsset, assetKindOf, assetIdOf, COMBOS, comboOf } from './annots.js?v=c8e60896';
import { buildingDesign, BUILDING_USES, DEFAULT_USE, PART_COLORS, MATERIALS, DEFAULT_MATERIAL, materialOf, WALL_ROLES,
  registerBuildingStyle, removeBuildingStyle, styleSpec, BUILDING_GENERATORS } from './buildings.js?v=c8e60896';
import { junctionKey, findCrossings, branchHeading, analysePlan, centrelineOf, junctionArms, armMouth, VEHICLES, DEFAULT_VEHICLE, vehicleOf } from './drive.js?v=c8e60896';
import { sunPosition, shadowPolys, stallsInShadow, momentUTC, zoneOffsetHours } from './sun.js?v=c8e60896';
import { sampleGrid, illuminance, sunSteps, annualIrradiance, canopyYield, gridStats, DEFAULT_POLE_H } from './light.js?v=c8e60896';
import { BUILD_ID } from './build.js?v=c8e60896';
import { shareURL, decodeShare, shareCodeOf } from './share.js?v=c8e60896';

const html = htm.bind(React.createElement);
const ANGLE_SNAP = Math.PI / 12; // 15° increments for hold-to-align drawing
const ANGLE_SNAP_DEG = 15;       // same step, for the R rotate key
const FLOOR_H = 3.2;             // metres per building floor (for 3D + height)
const WHEEL_GAP_MS = 160;        // quiet time that ends a wheel/trackpad gesture
const mark = (s) => { try { window.__pp_mark && window.__pp_mark(s); } catch (e) {} };
mark('1-module-uitgevoerd');

// ---------- Presets & defaults ----------
const PRESETS = {
  us_standard: { label: 'VS — Standaard (9×18 ft)', stallWidth: 2.7, stallDepth: 5.5, aisleWidth: 7.3 },
  us_large:    { label: 'VS — SUV (10×20 ft)',       stallWidth: 3.0, stallDepth: 6.1, aisleWidth: 7.3 },
  eu_metric:   { label: 'EU — Metrisch (2,5×5,0 m)', stallWidth: 2.5, stallDepth: 5.0, aisleWidth: 6.0 },
  compact:     { label: 'Compact (2,4×4,9 m)',       stallWidth: 2.4, stallDepth: 4.9, aisleWidth: 6.0 },
};

const DEFAULT_PARAMS = {
  stallWidth: 2.7, stallDepth: 5.5, aisleWidth: 7.3,
  angle: 90, setback: 6, padding: 0.6, maxRun: 12,
  islandWidth: 0, // width (m) of landscape islands inserted every maxRun stalls (0 = off)
  compactRatio: 0, evRatio: 0.05, ada: true,
  mix: { compact: 0, ev: 0.05, staff: 0, visitor: 0, reserved: 0 }, // target share per type
  singleLoaded: false, deadEndTurnaround: false, turnaround: 7,
  buildingGLA: 0, parkingRatio: 0, // GLA (m²) + stalls per 100 m² (zoning)
  layout: 'strip', // 'strip' (straight rows) | 'perimeter' (follows the curve)
  // The solver lays its own cross-aisle at one end of the rows. Without it the
  // rows are parallel islands you cannot drive between — which is what the
  // drivability check reported the day it was built.
  endAisles: 'one',     // 'none' | 'one' | 'both'
  designVehicle: 'car', // what the drivability check has to fit
  fireMaxDist: 60,      // m from a facade to where a fire appliance can stand
  sunDate: '2026-06-21', // which moment the shadow study shows
  sunHour: 15,
  // How much light lands here — the same grid answered by two sources.
  lightSource: 'lamps', // 'lamps' (lux tonight) | 'sun' (kWh/m² over a year)
  lightStep: 3,         // m between grid samples
  poleLumens: 12000,    // lm per luminaire
  poleMaint: 0.8,       // maintenance factor: dirt and ageing
  luxTarget: 10,        // lx average — a common design value, not a norm citation
  u0Target: 0.25,       // Emin/Eavg
  pvGHI: 1050,          // kWh/m²/yr on the horizontal (BE/NL)
  pvDiffuse: 0.55,      // annual diffuse share; it sets the tilt gain
  pvTilt: 10,           // ° — carports are laid flat to keep the height down
  pvAzimuth: 180,       // ° clockwise from north
  pvDensity: 0.2,       // kWp per m² of canopy
  pvPerf: 0.8,          // performance ratio
  pvHeight: 3,          // m clearance under the canopy
  alignLongestEdge: false, // align rows to the site's longest edge
};

// Default demo site: an L-shaped parcel (rectangle with a building in the corner).
const DEFAULT_SITE = [
  { x: 0, y: 0 }, { x: 96, y: 0 }, { x: 96, y: 60 }, { x: 0, y: 60 },
];
const DEFAULT_OBSTACLES = [
  { poly: rectPoly(60, 36, 36, 24), floors: 3 }, // building footprint, top-right
];

// Geographic anchor for local origin (0,0). Default: Amsterdam Zuidas.
const DEFAULT_GEO = { lat: 52.3390, lon: 4.8730 };

// ---------- Document reducer + undo/redo ----------

// Nearest point on a polygon boundary, with the local edge tangent and the
// inward unit normal (pointing toward the polygon centroid). Used to snap a
// driveway onto the site edge.
function siteEdgeFrame(wp, poly, centroid) {
  let best = null, bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    let t = len2 ? ((wp.x - a.x) * dx + (wp.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx, py = a.y + t * dy, d = Math.hypot(wp.x - px, wp.y - py);
    if (d < bestD) {
      bestD = d;
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len; // normal candidate
      if ((centroid.x - px) * nx + (centroid.y - py) * ny < 0) { nx = -nx; ny = -ny; } // point inward
      best = { point: { x: px, y: py }, tx: dx / len, ty: dy / len, nx, ny };
    }
  }
  return best;
}

// Build a fixed rectangular driveway straddling the site edge: `width` along
// the edge, `depth` into the site (plus a short apron outside).
function makeDriveway(frame, width, depth) {
  const { point: c, tx, ty, nx, ny } = frame;
  const hw = width / 2, apron = 1.5;
  const points = [
    { x: c.x + tx * hw - nx * apron, y: c.y + ty * hw - ny * apron },
    { x: c.x - tx * hw - nx * apron, y: c.y - ty * hw - ny * apron },
    { x: c.x - tx * hw + nx * depth, y: c.y - ty * hw + ny * depth },
    { x: c.x + tx * hw + nx * depth, y: c.y + ty * hw + ny * depth },
  ];
  return { kind: 'driveway', points, closed: true, anchor: { x: c.x, y: c.y }, nx, ny, tx, ty, width, depth };
}

/**
 * A road drawn as an object: a rectangle whose corners are DERIVED from a
 * centre, a width, a length and a heading.
 *
 * Before this, an object road was four loose corner points with `width: 0` and
 * nothing else. Everything downstream that wanted a centreline and a width got
 * neither: `roadLines` read the corner ring as if it were the centre of the
 * road, so a stall snapped to the outline instead of alongside it; `roadPolys`
 * dropped it in 3D because it is `closed`; and the inspector had no block for
 * it at all. Storing the recipe instead of only its result fixes all three at
 * the source.
 *
 * `prev` is the record being rebuilt. Passing it through is not politeness — it
 * is the bug `setDrivewayWidth` still has: that one rebuilds from a literal, so
 * every field not named there is silently gone the moment the width changes.
 */
function makeRoadRect(center, width, length, rot, prev) {
  const c = Math.cos(rot || 0), s = Math.sin(rot || 0);
  const hl = Math.max(0.5, length) / 2, hw = Math.max(0.5, width) / 2;
  // Local (along, across) → world. Same rotation as stallAt.
  const at = (u, v) => ({ x: center.x + u * c - v * s, y: center.y + u * s + v * c });
  return {
    ...(prev || {}),
    kind: (prev && prev.kind) || 'road',
    shape: 'object',
    points: [at(-hl, -hw), at(hl, -hw), at(hl, hw), at(-hl, hw)],
    closed: true,
    at: { x: center.x, y: center.y },
    width, length, rot: rot || 0,
  };
}

/** Is this annotation a parametric road object? */
const isRoadObject = (a) => !!a && a.shape === 'object' && Array.isArray(a.points) && a.points.length === 4;

/**
 * Read the parameters back out of a bare four-corner rectangle.
 *
 * Plans saved before the object road became parametric carry only the corners.
 * Recovering width, length and heading from them means such a plan keeps its
 * exact geometry instead of snapping to a default the first time it is touched.
 */
function roadRectParams(a) {
  const p = a.points;
  const cx = (p[0].x + p[1].x + p[2].x + p[3].x) / 4;
  const cy = (p[0].y + p[1].y + p[2].y + p[3].y) / 4;
  const e0 = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);   // along
  const e1 = Math.hypot(p[2].x - p[1].x, p[2].y - p[1].y);   // across
  return {
    at: { x: cx, y: cy },
    length: e0, width: e1,
    rot: Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x),
  };
}

const CAR_LEN = 6; // metres of queue per stacked vehicle in a drive-thru

// Total length of an open polyline (metres).
function polylineLen(pts) {
  let L = 0;
  for (let i = 0; i < (pts || []).length - 1; i++) L += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  return L;
}
function drivethruStacks(pts) { return Math.max(0, Math.floor(polylineLen(pts) / CAR_LEN)); }

// Fillet a corner a-v-b with radius R: returns the arc centre, tangent points
// and whether the turn is too tight for the adjacent segment lengths.
function filletAt(a, v, b, R) {
  const da = { x: a.x - v.x, y: a.y - v.y }, db = { x: b.x - v.x, y: b.y - v.y };
  const la = Math.hypot(da.x, da.y), lb = Math.hypot(db.x, db.y);
  if (la < 1e-3 || lb < 1e-3) return null;
  const ua = { x: da.x / la, y: da.y / la }, ub = { x: db.x / lb, y: db.y / lb };
  let cph = Math.max(-0.9999, Math.min(0.9999, ua.x * ub.x + ua.y * ub.y));
  const phi = Math.acos(cph);
  if (phi < 0.08 || phi > Math.PI - 0.08) return null; // ~straight, nothing to fillet
  const T = R / Math.tan(phi / 2);
  const bx = ua.x + ub.x, by = ua.y + ub.y, bl = Math.hypot(bx, by) || 1;
  const O = { x: v.x + (bx / bl) * (R / Math.sin(phi / 2)), y: v.y + (by / bl) * (R / Math.sin(phi / 2)) };
  const pa = { x: v.x + ua.x * T, y: v.y + ua.y * T }, pb = { x: v.x + ub.x * T, y: v.y + ub.y * T };
  return { O, pa, pb, tight: T > la - 0.1 || T > lb - 0.1 };
}

// A circle approximated as an n-gon polygon (so all polygon code just works).
function circlePoly(cx, cy, r, n = 40) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
  return pts;
}

// Turn a blocking annotation (road / driveway) into a clearance polygon the
// parking solver must avoid. Closed pleinen block their whole area; open lines
// become a ribbon of their width.
// Thin wrapper so callers can pass an annotation instead of loose numbers; the
// geometry itself is shared with the exporters and the 3D drape.
function ribbon(ann, t) {
  // A road object already IS its polygon — its four corners are the carriageway,
  // not a centreline to lay a ribbon along.
  if (ann && ann.shape === 'object' && ann.points && ann.points.length === 4) return ann.points;
  const ty = t || ANNOT_TYPES[ann.kind] || {};
  return ribbonPoly(ann.points, ann.width || ty.width || 3, ann.align, ann.curved);
}

function annotationBlocker(ann) {
  const t = ANNOT_TYPES[ann.kind];
  if (!t || !ann.points || ann.points.length < 2) return null;
  if (ann.closed && ann.points.length >= 3) return ann.points.slice();
  // Same polygon the road is drawn as, so the corridor the parking avoids is
  // exactly the asphalt you see — including the offset when you drew a kerb.
  return ribbon(ann, t);
}

// `overrides` are manual, position-keyed marks that persist across
// re-solves: stall type per stall, one-way + direction per aisle.
const initialDoc = {
  name: 'Naamloos plan',
  site: DEFAULT_SITE, siteCurved: false, obstacles: DEFAULT_OBSTACLES, geo: DEFAULT_GEO,
  params: DEFAULT_PARAMS, orientationIndex: 0, autoParking: true,
  overrides: { stalls: {}, aisles: {}, locks: { stalls: {}, aisles: {} }, removed: {}, angles: {} },
  annotations: [], // { kind, points:[{x,y}], width, curved }
  junctions: {}, // crossing key -> { mode: 'merged'|'break'|'none', dir? }; absent = undecided
  manualStalls: [], // hand-placed stalls: { poly, type }
  assets: [], // imported symbols used by this plan: { id, name, src, w, h, height }
  buildingStyles: [], // imported building styles used by this plan (see buildings.js)
};

// Simple history wrapper: { past[], present, future[] }.
function historyReducer(state, action) {
  const { past, present, future } = state;
  switch (action.type) {
    case 'COMMIT': {
      const next = typeof action.updater === 'function' ? action.updater(present) : action.updater;
      if (next === present) return state;
      return { past: [...past, present].slice(-60), present: next, future: [] };
    }
    case 'LIVE': {
      // Transient change that replaces present without a history entry.
      const next = typeof action.updater === 'function' ? action.updater(present) : action.updater;
      return { ...state, present: next };
    }
    case 'CHECKPOINT': {
      // Snapshot present into history before a live drag, so it's undoable.
      return { past: [...past, present].slice(-60), present, future: [] };
    }
    case 'UNDO': {
      if (!past.length) return state;
      return { past: past.slice(0, -1), present: past[past.length - 1], future: [present, ...future] };
    }
    case 'REDO': {
      if (!future.length) return state;
      return { past: [...past, present], present: future[0], future: future.slice(1) };
    }
    case 'RESET': return { past: [], present: action.doc, future: [] };
    default: return state;
  }
}

// ---------- View / coordinate transforms ----------
function makeTransform(view) {
  const w2s = (p) => ({ x: p.x * view.scale + view.ox, y: p.y * view.scale + view.oy });
  const s2w = (p) => ({ x: (p.x - view.ox) / view.scale, y: (p.y - view.oy) / view.scale });
  return { w2s, s2w };
}

// Mapbox style URLs per toggle option. 'none' → no map (dark planner backdrop).
const MAP_STYLES = {
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
  streets: 'mapbox://styles/mapbox/streets-v12',
  standard: 'mapbox://styles/mapbox/standard',
};

// Translate our flat canvas camera (view) into a Mapbox {center, zoom} so the
// basemap tracks it exactly in 2D. Web-mercator: mpp = 40075016.686·cos(lat)/(512·2^z).
function mapCamFromView(view, size, geo) {
  const cx = size.w / 2, cy = size.h / 2;
  const wc = { x: (cx - view.ox) / view.scale, y: (cy - view.oy) / view.scale };
  const ll = localToLatLon(wc, geo);
  const mpp = 1 / view.scale;
  const zoom = Math.log2((40075016.686 * Math.cos((ll.lat * Math.PI) / 180)) / (512 * mpp));
  return { center: [ll.lon, ll.lat], zoom: Math.max(1, Math.min(22, zoom)) };
}

function fitView(site, width, height, pad = 60) {
  const bb = boundingBox(site);
  // Can't fit before layout has a real size — signal "not yet".
  if (!(width > 0) || !(height > 0) || !(bb.w > 0) || !(bb.h > 0)) return null;
  const usableW = Math.max(20, width - pad * 2);
  const usableH = Math.max(20, height - pad * 2);
  // Always a finite, positive scale — a negative/NaN scale would make the
  // world-space draw loops run forever and crash the tab.
  const scale = Math.max(0.2, Math.min(200, Math.min(usableW / bb.w, usableH / bb.h)));
  const ox = (width - bb.w * scale) / 2 - bb.minX * scale;
  const oy = (height - bb.h * scale) / 2 - bb.minY * scale;
  return { scale, ox, oy };
}

// ---------- Hideable UI parts ----------
// Nothing in the shell carried a stable identifier, so these ids are invented
// and become the keys in the saved layout — renaming one silently resets that
// part to visible for existing users.
//
// The Weergave menu itself is deliberately absent: making it hideable would let
// you lock yourself out with no way back.
export const UI_GROUPS = ['Panelen', 'Linkerpaneel', 'Rechterpaneel', 'Werkbalk', 'Canvas'];
export const UI_PARTS = [
  { id: 'panelLeft', group: 'Panelen', label: 'Linkerpaneel' },
  { id: 'panelRight', group: 'Panelen', label: 'Rechterpaneel' },

  { id: 'secToolOpts', group: 'Linkerpaneel', label: 'Gereedschapsopties' },
  { id: 'secObjects', group: 'Linkerpaneel', label: 'Objecten' },
  { id: 'secSiteShape', group: 'Linkerpaneel', label: 'Site-vorm' },
  // The palette and the asset importer are both fully covered by the library
  // dialog now. They stay switchable — typing a name in the side list is still
  // the fastest route once you know it — but off by default, because they were
  // what pushed the tool options and the object list below the fold.
  { id: 'secDraw', group: 'Linkerpaneel', label: 'Gereedschapslijst (palet)' },
  { id: 'secAssets', group: 'Linkerpaneel', label: 'Eigen assets (paneel)' },
  { id: 'secFoot', group: 'Linkerpaneel', label: 'Voettekst' },

  { id: 'secMetrics', group: 'Rechterpaneel', label: 'Metrics' },
  { id: 'secDrive', group: 'Rechterpaneel', label: 'Bereikbaarheid' },
  { id: 'secSun', group: 'Rechterpaneel', label: 'Zon en schaduw' },
  { id: 'secLight', group: 'Rechterpaneel', label: 'Licht en opbrengst' },
  { id: 'secStallAisle', group: 'Rechterpaneel', label: 'Vak & rijstrook' },
  { id: 'secConstraints', group: 'Rechterpaneel', label: 'Site-constraints' },
  { id: 'secMix', group: 'Rechterpaneel', label: 'Vaktypes (mix)' },
  { id: 'secProgram', group: 'Rechterpaneel', label: 'Programma & ratio' },

  { id: 'tbProject', group: 'Werkbalk', label: 'Plannaam' },
  { id: 'tbTools', group: 'Werkbalk', label: 'Gereedschappen' },
  { id: 'tbLibrary', group: 'Werkbalk', label: 'Bibliotheek' },
  { id: 'tbNewSite', group: 'Werkbalk', label: 'Nieuwe site' },
  { id: 'tbAxis', group: 'Werkbalk', label: 'Rij-as & Reset' },
  { id: 'tbUndo', group: 'Werkbalk', label: 'Undo / Redo' },
  { id: 'tbView', group: 'Werkbalk', label: '2D / 3D' },
  { id: 'tbZoom', group: 'Werkbalk', label: 'Zoom & Fit' },
  { id: 'tbShare', group: 'Werkbalk', label: 'Delen (link)' },
  { id: 'tbFile', group: 'Werkbalk', label: 'Opslaan / Laden / Perceel' },
  { id: 'tbExport', group: 'Werkbalk', label: 'Export' },

  { id: 'ovDealbar', group: 'Canvas', label: 'Tabulatiebalk' },
  { id: 'ovHud', group: 'Canvas', label: 'HUD (vakken, schaal)' },
  { id: 'ovHint', group: 'Canvas', label: 'Hint-balk' },
  { id: 'ovAttrib', group: 'Canvas', label: 'Kaartattributie' },
];
// Ready-made layouts. Anything not listed is hidden, so adding a part later
// does not silently join every preset.
const WORKSPACE_PRESETS = {
  Alles: null, // null = everything visible
  Minimaal: ['tbTools', 'tbView', 'tbZoom', 'ovHud'],
  Tekenen: ['panelLeft', 'secToolOpts', 'secObjects', 'secSiteShape', 'tbTools', 'tbLibrary', 'tbNewSite', 'tbUndo', 'tbView', 'tbZoom', 'ovHud', 'ovHint'],
  Analyse: ['panelRight', 'secMetrics', 'secDrive', 'secLight', 'secStallAisle', 'secMix', 'secProgram', 'tbTools', 'tbView', 'tbZoom', 'tbExport', 'ovDealbar', 'ovHud'],
};
const PANEL_W = { left: { min: 170, max: 420, def: 210 }, right: { min: 240, max: 560, def: 300 } };

// One line per tool for the options panel, so it says something even when the
// active tool has nothing to set. The canvas hint says what to *do*; this says
// what the tool *is*.
// The three generator families, with the one sentence each needs. A style card
// says what it builds; the family says what kind of thing it is.
const BUILD_FAMILIES = [
  ['shed', 'Één volume', 'Eén hal. Optioneel een luifel aan de voorkant en een laadkade aan de achterkant.'],
  ['rows', 'Rijen woningen', 'Herhaalde eenheden langs de lange as, met of zonder voor- en achtertuin.'],
  ['block', 'Blok', 'Eén volume met eventueel een voorplein en een terugliggende bovenste laag.'],
];

// A document can always name a style this browser has not got: a plan shared
// without its styles, or one whose style was deleted since. Every lookup goes
// through here, because the one that did not crashed the whole canvas.
const styleOf = (key) => BUILDING_USES[key] || BUILDING_USES[DEFAULT_USE];

const TOOL_HELP = {
  select: 'Klik iets aan om het te bewerken, of sleep een kader voor meerdere objecten. Kies een gereedschap in de bibliotheek.',
  site: 'Teken de kavelgrens. De solver vult alleen wat binnen deze grens ligt.',
  obstacle: 'Gebouw of uitsluitingszone als rechthoek.',
  obstaclepoly: 'Gebouw of uitsluitingszone in vrije vorm.',
  placestall: 'Zet losse parkeervakken neer, ook buiten wat de solver bedacht.',
  measure: 'Meet een afstand of een reeks afstanden op de plattegrond.',
  pan: 'Sleep om de plattegrond te verschuiven.',
};

// The four tools the toolbar has and the catalogue does not: they draw the site
// and the buildings themselves rather than something laid on top. The library
// opens with the promise "alles wat je op het kavel kunt tekenen", and left
// these out — so the four things a new plan needs first were the only ones the
// dialog would not show. They are `tool` values, not annotation kinds, hence a
// list of their own rather than an ANNOT_TYPES group.
const PRIMARY_GROUP = 'Site & gebouw';
const PRIMARY_TOOLS = [
  { id: 'site', label: 'Site tekenen', key: 'P', color: '#b8860b',
    desc: 'Klik punten voor de siterand; dubbelklik of het beginpunt sluit de vorm.' },
  { id: 'obstacle', label: 'Gebouw (rechthoek)', key: 'B', color: '#64748b',
    desc: 'Sleep een rechthoek voor een gebouw of uitsluitingszone.' },
  { id: 'obstaclepoly', label: 'Gebouw (vrije vorm)', key: 'N', color: '#94a3b8',
    desc: 'Klik punten; dubbelklik sluit. Een hoek verslepen hertekent het exterieur.' },
  { id: 'placestall', label: 'Parkeervak plaatsen', key: 'K', color: '#2563eb',
    desc: 'Losse vakken plaatsen; ze snappen aan bestaande vakken en aan wegen.' },
];
// The keyboard letters that really exist, for the card badges. Only these three
// annotations have one; the rest of the catalogue has none, and the design
// leaves that badge empty for them.
const ANNOT_KEYS = { road: 'W', driveway: 'I', drivethru: 'D' };

// ---------- Canvas theme ----------
// Only the colours that actually break when the backdrop flips. Meaning-bearing
// colours (STALL_TYPES, ANNOT_TYPES, the green previews, the orange drive-thru)
// stay as they are. Roles, not hues, so a change of ground is a
// data change.
// The plan's own ink, on the design's light ground. One set: the design
// specifies a light interface, and a second palette nobody drew is a liability
// dressed up as a feature.
const TH_BASE = {
  grid: 'rgba(28,29,41,0.07)',
  ink: 'rgba(28,29,41,0.92)',         // glyphs and labels drawn on the plan
  inkSoft: 'rgba(28,29,41,0.62)',
  inkFaint: 'rgba(28,29,41,0.45)',
  onStall: 'rgba(255,255,255,0.9)',   // stalls stay saturated, so keep white here
  outline: 'rgba(0,0,0,0.28)',
  sel: '#6a5bc4',                     // selection halo — the design's accent
  plate: 'rgba(255,255,255,0.94)',    // small label plates
  plateInk: '#4a3d99',
  handleCore: '#ffffff',
  aisle: 'rgba(111,114,133,0.35)',
  building: 'rgba(58,61,82,0.30)',
  buildingLine: '#6f7285',
  badge: 'rgba(28,29,41,0.9)',
  pictoHalo: 'rgba(28,29,41,0.75)',
};

// Set once per frame by draw(). Module-level so the paint helpers don't each
// need a theme parameter threaded through them; rendering is synchronous.
// The light map's sequential ramp: one hue (amber — it is light, after all),
// The light map's sequential ramp: one hue (amber — it is light, after all),
// six steps, monotonic on the design's light ground. Alpha stays well under 1
// because this is a wash over a drawing that still has to be readable under it.
const LIGHT_RAMP = ['rgba(254,243,199,0.55)', 'rgba(253,230,138,0.60)', 'rgba(252,211,77,0.65)',
  'rgba(251,191,36,0.70)', 'rgba(245,158,11,0.72)', 'rgba(217,119,6,0.75)'];


let TH = TH_BASE;

// ---------- Rendering ----------
function draw(ctx, opts) {
  const { view, doc, result, layers, dpr, drawing, hover, selection, size,
          stallSel, aisleSel, marquee, sitePoly, crossings } = opts;
  TH = TH_BASE;
  const site = sitePoly || doc.site;
  const { w2s } = makeTransform(view);
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size.w, size.h); // transparent — the Mapbox basemap shows through

  // A Set, not an index: selecting one branch of a junction network highlights
  // the whole network, because that is what a drag will move.
  const selAnnIdx = new Set();
  if (selection && selection.type === 'annot') {
    const roots = opts.netRoot || [];
    if (roots[selection.index] != null) {
      roots.forEach((r, i) => { if (r === roots[selection.index]) selAnnIdx.add(i); });
    } else selAnnIdx.add(selection.index);
  }
  const multi = opts.multiSel || { anns: [], obs: [] };
  for (const i of multi.anns) selAnnIdx.add(i);
  const selObs = new Set(multi.obs);
  if (selection && selection.type === 'obs') selObs.add(selection.index);

  // Grid
  if (layers.grid) drawGrid(ctx, view, size);

  // All tarmac in ONE path and ONE fill: drive aisles, bays and every drawn
  // carriageway. Filling them separately painted a translucent grey twice
  // wherever two of them overlapped, which is exactly the seam you see where a
  // road meets an aisle or another road. One fill composites once, and with no
  // per-shape outline the internal edges are simply not there.
  {
    ctx.beginPath();
    const addRing = (poly) => {
      if (!poly || poly.length < 3) return;
      poly.forEach((q, i) => { const sp = w2s(q); if (i) ctx.lineTo(sp.x, sp.y); else ctx.moveTo(sp.x, sp.y); });
      ctx.closePath();
    };
    if (layers.parking) {
      for (const a of result.aisles) addRing(a.poly);
      for (const st of result.stalls) addRing(st.poly);
    }
    if (layers.infra) {
      for (const an of doc.annotations || []) {
        const t = ANNOT_TYPES[an.kind];
        // A road object is `closed` because it is a rectangle, not because it is a
      // plaza — it is still carriageway and belongs in the one tarmac surface.
      if (t && t.body && (!an.closed || an.shape === 'object')) addRing(ribbon(an, t));
      }
    }
    ctx.fillStyle = TH.aisle;
    ctx.fill();
  }

  // Infrastructure drawn under the parking (roads, bike parking)
  if (layers.infra && doc.annotations) {
    drawAnnotations(ctx, doc.annotations, w2s, view.scale, true, selAnnIdx);
  }

  // Site fill + outline (highlighted when the whole site is selected)
  if (layers.site && site.length >= 2) {
    const siteSel = selection && selection.type === 'site';
    pathPoly(ctx, site, w2s, site.length >= 3);
    ctx.fillStyle = siteSel ? 'rgba(248,181,0,0.12)' : 'rgba(248,181,0,0.05)';
    if (site.length >= 3) ctx.fill();
    ctx.strokeStyle = siteSel ? '#ffd24a' : '#f8b500';
    ctx.lineWidth = siteSel ? 3.5 : 2;
    ctx.stroke();
  }

  // Setback line (dashed inward offset)
  if (layers.setback && site.length >= 3 && doc.params.setback > 0) {
    const off = offsetPolygon(site, doc.params.setback);
    if (off) {
      pathPoly(ctx, off, w2s, true);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#6ee7ff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Turnarounds: the pocket the dead-end option already reserved. Drawn as
  // tarmac, under the parking, so it reads as part of the carriageway.
  if (layers.parking && result.turnarounds) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    for (const t of result.turnarounds) { pathPoly(ctx, t, w2s, true); ctx.fill(); }
  }

  // Landscape islands (green planters that break up long rows)
  if (layers.parking && result.islands) {
    for (const is of result.islands) {
      pathPoly(ctx, is, w2s, true);
      ctx.fillStyle = 'rgba(63,155,70,0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(34,110,40,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Aisles: selection, arrows and locks. The surface itself is already painted.
  if (layers.parking) {
    for (const a of result.aisles) {
      if (aisleSel === a.key) {
        pathPoly(ctx, a.poly, w2s, true);
        ctx.fillStyle = 'rgba(59,130,246,0.32)';
        ctx.fill();
        ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2; ctx.stroke();
      }
      if (a.oneway) drawAisleArrows(ctx, a, w2s, view.scale);
      if (a.locked) {
        const c = w2s(polygonCentroid(a.poly));
        ctx.font = '13px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🔒', c.x, c.y);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
      }
    }
  }

  // Buildings / exclusion zones
  if (layers.building) {
    const siteC = sitePoly && sitePoly.length >= 3 ? polygonCentroid(sitePoly) : null;
    doc.obstacles.forEach((o, i) => {
      const op = polyOf(o);
      const sel = selObs.has(i);
      const floors = (o && o.floors) || 1;
      const design = buildingDesign(op, (o && o.use) || DEFAULT_USE, floors, siteC);
      // The generated exterior, back to front. It lives entirely inside the
      // footprint, which is still the only thing the solver sees as blocked.
      pathPoly(ctx, op, w2s, true);
      ctx.fillStyle = sel ? 'rgba(239,68,68,0.28)' : TH.building;
      ctx.fill();
      const mat = materialOf(o);
      for (const part of design.areas) {
        if (part.h1 <= 0.5 && part.role !== 'garden' && part.role !== 'forecourt' && part.role !== 'dock') continue;
        const isWall = !!WALL_ROLES[part.role];
        pathPoly(ctx, part.poly, w2s, true);
        ctx.fillStyle = isWall ? mat.tint : hexA(PART_COLORS[part.role] || '#c3c8d0', part.role === 'plant' ? 0.55 : 0.92);
        ctx.fill();
        ctx.strokeStyle = isWall ? mat.line : 'rgba(15,23,42,0.28)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      // Ridges, party walls, doors and mullions: the detail that makes a shape
      // read as a house or a shopfront rather than a filled rectangle.
      if (design.lines.length && view.scale >= 2.5) {
        ctx.lineCap = 'butt';
        for (const ln of design.lines) {
          const a = w2s(ln.a), b = w2s(ln.b);
          const heavy = ln.role === 'party' || ln.role === 'ridge';
          ctx.strokeStyle = ln.role === 'door' ? '#5b4636'
            : ln.role === 'path' ? 'rgba(200,204,210,0.9)'
            : heavy ? 'rgba(15,23,42,0.45)' : 'rgba(15,23,42,0.22)';
          ctx.lineWidth = ln.role === 'door' ? 2.2 : heavy ? 1.1 : 0.7;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      pathPoly(ctx, op, w2s, true);
      ctx.strokeStyle = sel ? '#ef4444' : TH.buildingLine;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Type + floor badge when zoomed in.
      if (view.scale >= 4 && op.length >= 3) {
        const c = w2s(polygonCentroid(op));
        const use = BUILDING_USES[(o && o.use) || DEFAULT_USE] || BUILDING_USES[DEFAULT_USE];
        const label = use.label + ' · ' + floors + ' verd.' + (design.units > 1 ? ' · ' + design.units + '×' : '');
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = TH.plate;
        ctx.fillRect(c.x - tw / 2, c.y - 8, tw, 16);
        ctx.fillStyle = TH.plateInk;
        ctx.fillText(label, c.x, c.y);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
      }
    });
  }

  // Stalls: asphalt with real bay markings, tinted by type.
  if (layers.parking) {
    const selSet = new Set(stallSel || []);
    const showGlyph = view.scale >= 5.5;
    // Below this the whole bay is a few pixels wide and a 0.12 m line is a
    // smudge, so the markings are skipped — a limit of the screen, not a
    // decision to show less.
    const showMarks = view.scale >= 2.2;
    const aislePolys = (result.aisles || []).map((a) => a.poly);
    const lineW = Math.max(1, 0.12 * view.scale);
    for (const st of result.stalls) {
      const info = STALL_TYPES[st.type] || STALL_TYPES.standard;
      const selected = selSet.has(st.key);
      const p = st.poly;
      // The tarmac under this bay is already down (one surface for the whole
      // car park); only the type tint and the markings belong here.
      // Only the special types are tinted. A standard bay is plain tarmac with
      // white lines, which is what one looks like — and it makes the bays that
      // DO mean something (accessible, EV, reserved) stand out instead of
      // competing with 96 blue rectangles.
      if (st.type !== 'standard') {
        pathPoly(ctx, p, w2s, true);
        ctx.fillStyle = info.color;
        ctx.globalAlpha = st.type === 'ada' ? 0.42 : 0.3;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      if (showMarks && p.length === 4) {
        // A real bay is marked on three sides; the mouth faces the aisle.
        const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        const edges = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([i, j]) => ({
          a: p[i], b: p[j], len: dist(p[i], p[j]), m: mid(p[i], p[j]),
        }));
        // The two short edges are the head and the mouth.
        const order = edges.map((e, i) => i).sort((i, j) => edges[i].len - edges[j].len);
        let mouth = -1;
        if (aislePolys.length) {
          // Distance to the aisle SHAPE, not to its centroid: an aisle is long,
          // so its centre point is nowhere near most of the bays it serves and
          // picking by centroid opened the wrong end half the time.
          let bestD = Infinity;
          for (const ei of [order[0], order[1]]) {
            for (const ap of aislePolys) {
              for (let k = 0; k < ap.length; k++) {
                const d = distPointSegment(edges[ei].m, ap[k], ap[(k + 1) % ap.length]);
                if (d < bestD) { bestD = d; mouth = ei; }
              }
            }
          }
        }
        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = lineW;
        ctx.lineCap = 'butt';
        ctx.beginPath();
        edges.forEach((e, i) => {
          if (i === mouth) return;
          const a = w2s(e.a), b = w2s(e.b);
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        });
        ctx.stroke();
      }
      if (selected) {
        pathPoly(ctx, p, w2s, true);
        ctx.strokeStyle = TH.sel; ctx.lineWidth = 2; ctx.stroke();
      }
      if (st.locked) { // dashed white outline marks a locked stall
        pathPoly(ctx, p, w2s, true);
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = TH.onStall;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (st.type === 'motorcycle') { // subdivide into 3 motorcycle bays
        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = Math.max(1, lineW);
        for (const t of [1 / 3, 2 / 3]) {
          const a = w2s({ x: p[0].x + (p[1].x - p[0].x) * t, y: p[0].y + (p[1].y - p[0].y) * t });
          const b = w2s({ x: p[3].x + (p[2].x - p[3].x) * t, y: p[3].y + (p[2].y - p[3].y) * t });
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      // The floor symbol for the types that have one in the real world, drawn
      // by the same painters as the road pictograms.
      const picto = STALL_PICTOS[st.type];
      if (picto && showGlyph) {
        const ax = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
        drawPicto(ctx, { angle: (ax * 180) / Math.PI + 90, width: dist(p[0], p[1]) * 0.62 },
          { picto, width: 2 }, w2s(polygonCentroid(p)), view.scale, false);
      } else if (showGlyph && info.glyph) {
        const s = w2s(polygonCentroid(p));
        ctx.fillStyle = TH.onStall;
        ctx.font = Math.max(8, view.scale * 1.15) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(info.glyph, s.x, s.y);
      }
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // The light map: how much light lands on each cell — from the sun over a
  // whole year, or from the lamp posts tonight.
  //
  // One hue, stepping monotonically away from the surface. A sequential ramp,
  // never a rainbow: the question here is *how much*, and a rainbow makes the
  // reader decode a legend where they should simply see more and less. The
  // The steps are chosen against this ground; they are not a formula, so a
  // different ground would want its own set rather than an inversion.
  // Nothing to say when nothing arrives: with no lamps placed every cell reads
  // zero, and painting the whole site in the palest step would claim a faint
  // glow that is not there. Darkness is the absence of the wash, not its first
  // rung — so a cell at zero stays bare and the plan shows through.
  if (layers.lightmap && opts.lightField && opts.lightGrid && opts.lightField.stats.max > 0) {
    const { values, stats } = opts.lightField;
    const ramp = LIGHT_RAMP;
    const hi = stats.max;
    const s = opts.lightGrid.step, half = s / 2;
    ctx.save();
    // One path per step, so neighbouring cells of the same value share a fill
    // and no seam shows between them.
    for (let k = 0; k < ramp.length; k++) {
      ctx.fillStyle = ramp[k];
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < values.length; i++) {
        if (values[i] <= 0) continue;
        const f = values[i] / hi;
        if (Math.min(ramp.length - 1, Math.floor(f * ramp.length)) !== k) continue;
        const p = opts.lightGrid.pts[i];
        const a = w2s({ x: p.x - half, y: p.y - half });
        const b = w2s({ x: p.x + half, y: p.y + half });
        ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
        any = true;
      }
      if (any) ctx.fill();
    }
    ctx.restore();
  }

  // Building shadows, over the ground surfaces rather than under them: a shadow
  // falls on whatever is there, and drawn any earlier the tarmac and the stalls
  // paint straight over it.
  //
  // Every quad goes into ONE path and is filled once. Fill them separately and
  // the overlaps double up, so two buildings whose shadows cross would show a
  // darker patch that means nothing at all.
  if (layers.shadow && opts.shadows) {
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.22)';
    ctx.beginPath();
    for (const sh of opts.shadows) {
      if (!sh || sh.length < 3) continue;
      const a = w2s(sh[0]);
      ctx.moveTo(a.x, a.y);
      for (let i = 1; i < sh.length; i++) { const q = w2s(sh[i]); ctx.lineTo(q.x, q.y); }
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
  }

  // Infrastructure drawn over the parking (paths, crosswalks, markings)
  if (layers.infra && doc.annotations) {
    drawAnnotations(ctx, doc.annotations, w2s, view.scale, false, selAnnIdx);
    if (crossings) drawCrossings(ctx, crossings, doc.annotations, w2s, view.scale);
    if (opts.pickArms) drawArmPicker(ctx, opts.pickArms, w2s, view.scale);
  }

  // Driveway placement preview (snapped to the site edge)
  if (hover && hover.driveway) {
    drawDriveway(ctx, hover.driveway, w2s, view.scale, true);
  }

  // Road-object placement preview: the real object, drawn where it would land.
  if (hover && hover.roadRect) {
    pathPoly(ctx, hover.roadRect.points, w2s, true);
    ctx.fillStyle = 'rgba(34,197,94,0.30)'; ctx.fill();
    ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 1.5; ctx.stroke();
    drawDims(ctx, [hover.roadRect.points[0], hover.roadRect.points[1], hover.roadRect.points[2]], w2s);
  }

  // Circle area preview
  if (hover && hover.circle) {
    const c = w2s(hover.circle.c), rpx = hover.circle.r * view.scale;
    ctx.beginPath(); ctx.arc(c.x, c.y, rpx, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(63,155,70,0.3)'; ctx.fill();
    ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = TH.plateInk; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('r ' + hover.circle.r.toFixed(1) + ' m', c.x, c.y);
    ctx.textAlign = 'start';
  }

  // Manual stall placement preview
  if (hover && hover.stallPreview) {
    pathPoly(ctx, hover.stallPreview, w2s, true);
    ctx.fillStyle = 'rgba(34,197,94,0.35)';
    ctx.fill();
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Rectangle preview (obstacle / bike-parking area drag) with dimensions
  if (hover && hover.preview) {
    const r = hover.preview;
    const a = w2s({ x: r.x, y: r.y }), b = w2s({ x: r.x + r.w, y: r.y + r.h });
    ctx.strokeStyle = '#22c55e';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.4;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
    drawDims(ctx, [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h },
    ], w2s);
  }

  // Marquee selection box
  if (marquee) {
    const a = w2s({ x: marquee.x0, y: marquee.y0 });
    const b = w2s({ x: marquee.x1, y: marquee.y1 });
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    ctx.fillStyle = 'rgba(59,130,246,0.12)';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  }

  // In-progress polygon / polyline with live dimension labels
  if (drawing && drawing.points.length) {
    const hoverPt = hover && hover.x != null ? hover : null;
    const pts = hoverPt ? [...drawing.points, hoverPt] : drawing.points;
    pathPoly(ctx, pts, w2s, false);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of drawing.points) drawHandle(ctx, w2s(p), '#22c55e');
    drawDims(ctx, pts, w2s);
  }

  // Vertex handles for site (select tool)
  if (opts.showHandles) {
    for (const p of doc.site) drawHandle(ctx, w2s(p), '#f8b500');
    for (const o of doc.obstacles) for (const p of polyOf(o)) drawHandle(ctx, w2s(p), '#7c8896');
    // Resize handles on the selected annotation. A driveway keeps its edge-frame
    // shape and a road object its rectangle, so neither offers loose corners —
    // the object gets a length grip on each end and a rotate grip beside it.
    if (selection && selection.type === 'annot') {
      const a = (doc.annotations || [])[selection.index];
      if (isRoadObject(a)) {
        for (const g of roadRectGrips(a)) {
          if (g.kind === 'rot') drawRotGrip(ctx, w2s(g.at));
          else drawHandle(ctx, w2s(g.at), '#60a5fa');
        }
      } else if (a && a.kind !== 'driveway' && a.points) {
        for (const p of a.points) drawHandle(ctx, w2s(p), '#60a5fa');
      }
    }
  }

  // Knelpunten last of all — they are a verdict on the plan, not part of it.
  if (opts.driveIssues && opts.driveIssues.length) {
    drawIssues(ctx, opts.driveIssues, opts.focusIssue == null ? -1 : opts.focusIssue, w2s, view.scale);
  }

  // Alignment guides sit above everything: they are transient feedback, not plan.
  if (opts.guides && opts.guides.length) {
    ctx.save();
    ctx.strokeStyle = '#ec4899'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    for (const g of opts.guides) {
      ctx.beginPath();
      if (g.x != null) { const sx = w2s({ x: g.x, y: 0 }).x; ctx.moveTo(sx, 0); ctx.lineTo(sx, size.h); }
      else { const sy = w2s({ x: 0, y: g.y }).y; ctx.moveTo(0, sy); ctx.lineTo(size.w, sy); }
      ctx.stroke();
    }
    ctx.restore();
  }
  if (opts.measure) drawMeasure(ctx, opts.measure, w2s, view.scale);

  ctx.restore();
}

function pathPoly(ctx, poly, w2s, close) {
  ctx.beginPath();
  poly.forEach((p, i) => {
    const s = w2s(p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (close) ctx.closePath();
}

/**
 * The grips of a road object, in world coordinates.
 *
 * Two length grips on the short ends and one rotate grip standing off the side.
 * Derived from the stored parameters, so they follow the object rather than
 * needing to be kept in step with it.
 */
function roadRectGrips(a) {
  const { at, width, length, rot } = a;
  const c = Math.cos(rot || 0), s = Math.sin(rot || 0);
  const to = (u, v) => ({ x: at.x + u * c - v * s, y: at.y + u * s + v * c });
  const hl = length / 2;
  return [
    { kind: 'len', end: -1, at: to(-hl, 0) },
    { kind: 'len', end: 1, at: to(hl, 0) },
    // Clear of the body, so grabbing it can never be mistaken for a drag.
    { kind: 'rot', at: to(0, -(width / 2) - Math.max(2.5, width * 0.45)) },
  ];
}

// The rotate grip reads as a turn, not as another corner.
function drawRotGrip(ctx, s) {
  ctx.beginPath();
  ctx.arc(s.x, s.y, 6.5, -Math.PI * 0.75, Math.PI * 0.6);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s.x + 3.2, s.y - 6.6);
  ctx.lineTo(s.x + 7.4, s.y - 4.2);
  ctx.lineTo(s.x + 2.6, s.y - 1.6);
  ctx.closePath();
  ctx.fillStyle = '#f59e0b';
  ctx.fill();
}

/**
 * A thumbnail of what a tool draws, painted with the app's own painters.
 *
 * Not a bespoke icon set: a road is a ribbon of the real width, a marking is
 * the real PICTOS painter, a zebra is the real bar geometry. That means the
 * library can never show something the canvas would not draw, and it costs no
 * second set of artwork to keep in step.
 */
// The four primary tools have no ANNOT_TYPES entry to paint from, so each gets
// its own thumbnail. Same rule as the rest of the library: what the card shows
// is the shape the tool actually leaves on the plan.
function drawPrimaryPreview(ctx, id, w, h) {
  const pad = Math.min(w, h) * 0.16;
  if (id === 'site') {
    ctx.strokeStyle = '#b8860b'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(184,134,11,0.10)';
    ctx.fillRect(pad, pad, w - pad * 2, h - pad * 2);
    for (const [x, y] of [[pad, pad], [w - pad, pad], [w - pad, h - pad], [pad, h - pad]]) {
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#b8860b'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    return;
  }
  if (id === 'obstacle' || id === 'obstaclepoly') {
    const pts = id === 'obstacle'
      ? [[pad * 1.6, pad * 1.3], [w - pad * 1.6, pad * 1.3], [w - pad * 1.6, h - pad * 1.3], [pad * 1.6, h - pad * 1.3]]
      : [[pad * 1.4, pad * 2], [w * 0.46, pad * 1.1], [w - pad * 1.3, pad * 1.8],
         [w - pad * 1.8, h - pad * 1.2], [pad * 2.2, h - pad * 1.5]];
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(100,116,139,0.42)'; ctx.fill();
    ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1.6; ctx.stroke();
    return;
  }
  // placestall — a short run of bays off an aisle, which is what one click gives
  // you: the stall, snapped to whatever is already there.
  ctx.fillStyle = 'rgba(111,114,133,0.30)';
  ctx.fillRect(0, h * 0.62, w, h * 0.38);
  const bw = w / 5.5;
  for (let i = 0; i < 5; i++) {
    const x = bw * 0.35 + i * bw;
    ctx.fillStyle = i === 2 ? '#2563eb' : 'rgba(37,99,235,0.28)';
    ctx.fillRect(x, h * 0.2, bw * 0.78, h * 0.42);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
    ctx.strokeRect(x, h * 0.2, bw * 0.78, h * 0.42);
  }
}

function drawToolPreview(ctx, kind, w, h, value) {
  const t = ANNOT_TYPES[kind] || {};
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  // A dark plate for the road family, a light one for paint and greenery — the
  // same contrast the plan itself has.
  // Paint needs asphalt under it. Two of the markings are near-white lines with
  // no picto and no body, so they went on the pale plate and came out invisible
  // — the group is the honest signal that a thing is paint on a road.
  const onTarmac = !!t.body || t.mode === 'cross' || t.picto
    || t.group === 'Markeringen' || kind === 'hatchZone' || kind === 'bayLines';
  ctx.fillStyle = onTarmac ? '#2e3140' : '#e9ebf3';
  ctx.fillRect(0, 0, w, h);
  if (PRIMARY_TOOLS.some((p) => p.id === kind)) {
    drawPrimaryPreview(ctx, kind, w, h);
    ctx.restore();
    return;
  }
  const cx = w / 2, cy = h / 2;

  if (t.mode === 'point' && t.picto && PICTOS[t.picto]) {
    ctx.save();
    ctx.translate(cx, cy);
    const r = Math.min(w, h) * 0.34;
    ctx.scale(r, r);
    ctx.shadowColor = 'rgba(15,23,42,0.6)'; ctx.shadowBlur = 0.22;
    PICTOS[t.picto](ctx, { value: value != null ? value : t.value });
    ctx.restore();
  } else if (t.mode === 'point') {
    ctx.beginPath(); ctx.arc(cx, cy, Math.min(w, h) * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = t.color || '#94a3b8'; ctx.fill();
  } else if (t.mode === 'cross') {
    // Real zebra bars from the shared helper.
    const bars = zebraQuads([{ x: 0, y: 0 }, { x: 12, y: 0 }], 4);
    const k = w / 12;
    ctx.fillStyle = '#e9edf2';
    for (const q of bars) {
      ctx.beginPath();
      q.forEach((pt, i) => { const X = pt.x * k, Y = cy + pt.y * k; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.closePath(); ctx.fill();
    }
  } else if (kind === 'hatchZone' || kind === 'bayLines') {
    const poly = [{ x: 1, y: 1 }, { x: 11, y: 1 }, { x: 11, y: 6 }, { x: 1, y: 6 }];
    const k = w / 12;
    // The stripes are filled quads, so the paint colour has to be set before the
    // loop — leaving the plate colour in place fills dark on dark and the card
    // comes out blank.
    ctx.fillStyle = '#f8fafc';
    for (const q of hatchQuads(poly, STRIPE_SPEC[kind])) {
      ctx.beginPath();
      q.forEach((pt, i) => { const X = pt.x * k, Y = (pt.y + 0.5) * k; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.closePath(); ctx.fill();
    }
  } else if (t.mode === 'area') {
    ctx.fillStyle = hexA(t.color || '#0e7490', 0.45);
    ctx.fillRect(w * 0.12, h * 0.2, w * 0.76, h * 0.6);
    ctx.strokeStyle = t.color || '#0e7490'; ctx.lineWidth = 1.5;
    ctx.strokeRect(w * 0.12, h * 0.2, w * 0.76, h * 0.6);
  } else {
    // A way: the real ribbon, at the real width, across the plate.
    const wide = (t.width || 3);
    const k = w / 14;
    // A shallow curve, not a mountain: at ±3 m the ribbon of a 4 m way folds
    // over its own centreline and fills as a blob instead of a road.
    const pts = t.curved
      ? [{ x: 0.5, y: 4.2 }, { x: 5, y: 3.0 }, { x: 9.5, y: 4.2 }, { x: 13.5, y: 3.4 }]
      : [{ x: 0.5, y: 3.6 }, { x: 13.5, y: 3.6 }];
    const poly = ribbonPoly(pts, wide, undefined, !!t.curved);
    if (poly) {
      ctx.beginPath();
      poly.forEach((pt, i) => { const X = pt.x * k, Y = pt.y * k; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.closePath();
      ctx.fillStyle = t.aisleColor ? 'rgba(148,163,184,0.55)' : hexA(t.color || '#94a3b8', 0.9);
      ctx.fill();
      // A road gets its centre dashes, the way it has them in plan.
      if (t.aisleColor) {
        ctx.strokeStyle = 'rgba(248,250,252,0.9)'; ctx.lineWidth = 1.4;
        ctx.setLineDash([7, 6]);
        ctx.beginPath(); ctx.moveTo(0.5 * k, 3.6 * k); ctx.lineTo(13.5 * k, 3.6 * k); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  ctx.restore();
}

/**
 * A thumbnail of a building style, drawn by the same generator the plan uses.
 *
 * A sample footprint through `buildingDesign`, painted with the shared part
 * colours — so a card cannot promise a canopy the plan would not build, and an
 * imported style gets a picture without shipping one.
 */
function drawBuildStyle(ctx, key, w, h) {
  const u = BUILDING_USES[key] || BUILDING_USES[DEFAULT_USE];
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#e9ebf3';
  ctx.fillRect(0, 0, w, h);
  // 60 x 34 m of ground, seen from above, with the car park to the south — the
  // same "toward" the plan passes, so the entrance faces the viewer.
  const FW = 60, FD = 34, pad = 6;
  const k = Math.min((w - pad * 2) / FW, (h - pad * 2) / FD);
  const ox = (w - FW * k) / 2, oy = (h - FD * k) / 2;
  const poly = [{ x: 0, y: 0 }, { x: FW, y: 0 }, { x: FW, y: FD }, { x: 0, y: FD }];
  let d;
  try { d = buildingDesign(poly, u.key, u.floors, { x: FW / 2, y: FD * 3 }); } catch (e) { ctx.restore(); return; }
  const mat = MATERIALS[u.material] || MATERIALS.render;
  for (const a of d.areas) {
    ctx.beginPath();
    a.poly.forEach((p, i) => { const X = ox + p.x * k, Y = oy + p.y * k; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.closePath();
    // Wall roles take the style's own facade colour; everything else is the
    // shared part colour, exactly as the canvas does it.
    ctx.fillStyle = WALL_ROLES[a.role] ? mat.tint : (PART_COLORS[a.role] || '#c3c8d0');
    ctx.fill();
    ctx.strokeStyle = 'rgba(28,29,41,0.22)'; ctx.lineWidth = 0.7; ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(28,29,41,0.5)'; ctx.lineWidth = 1;
  for (const l of d.lines) {
    ctx.beginPath();
    ctx.moveTo(ox + l.a.x * k, oy + l.a.y * k);
    ctx.lineTo(ox + l.b.x * k, oy + l.b.y * k);
    ctx.stroke();
  }
  ctx.restore();
}
function BuildPreview({ styleKey }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 240, h = c.clientHeight || 74;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try { drawBuildStyle(ctx, styleKey, w, h); } catch (e) {}
  }, [styleKey]);
  return html`<canvas ref=${ref} className="lib-prev"></canvas>`;
}

// A canvas that paints itself once from drawToolPreview, at device resolution.
// `value` repaints it when the number on the card changes, so a speed marking
// set to 30 shows a 30 rather than the catalogue's default.
function ToolPreview({ kind, value }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 240, h = c.clientHeight || 72;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try { drawToolPreview(ctx, kind, w, h, value); } catch (e) {}
  }, [kind, value]);
  return html`<canvas ref=${ref} className="lib-prev"></canvas>`;
}

function drawHandle(ctx, s, color) {
  ctx.beginPath();
  ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = TH.handleCore;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Chevron arrows along a one-way aisle, pointing in its travel direction.
function drawAisleArrows(ctx, aisle, w2s, scale) {
  const ax = aisleAxis(aisle.poly);
  if (!(ax.length > 0)) return;
  const dir = aisle.dir || 1;
  const tvx = ax.ux * dir, tvy = ax.uy * dir;       // travel direction (unit)
  const pvx = -ax.uy, pvy = ax.ux;                  // perpendicular (unit)
  const spacing = 9;                                // meters between arrows
  const n = Math.max(1, Math.round(ax.length / spacing));
  const L = Math.min(2.6, ax.width * 0.55);         // arrow length (m)
  const W = Math.min(1.8, ax.width * 0.42);         // arrow half-span (m)
  ctx.strokeStyle = TH.onStall;
  ctx.lineWidth = Math.max(1.2, scale * 0.13);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < n; i++) {
    const along = -ax.length / 2 + ((i + 0.5) * ax.length) / n;
    const px = ax.cx + ax.ux * along, py = ax.cy + ax.uy * along;
    const tip = w2s({ x: px + tvx * (L / 2), y: py + tvy * (L / 2) });
    const bl = w2s({ x: px - tvx * (L / 2) + pvx * W, y: py - tvy * (L / 2) + pvy * W });
    const br = w2s({ x: px - tvx * (L / 2) - pvx * W, y: py - tvy * (L / 2) - pvy * W });
    ctx.beginPath();
    ctx.moveTo(bl.x, bl.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(br.x, br.y);
    ctx.stroke();
  }
}

// Translucent fill colour from a #rrggbb hex.
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Live segment-length labels while drawing (metres).
function drawDims(ctx, pts, w2s) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.05) continue;
    const m = w2s({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    // Bearing in degrees (0° = east, CCW positive), normalised to 0–360.
    let deg = (-Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    const label = len.toFixed(1) + ' m · ' + Math.round(deg) + '°';
    const w = ctx.measureText(label).width + 8;
    ctx.fillStyle = TH.plate;
    ctx.fillRect(m.x - w / 2, m.y - 9, w, 16);
    ctx.fillStyle = TH.plateInk;
    ctx.fillText(label, m.x, m.y);
  }
  ctx.restore();
}

// Tree sprites: empty by default (procedural trees are drawn). Once the
// user supplies tree images, register them here and they're used instead.
// e.g. window.ParkPlanner.setTreeImages(['data:image/png;base64,…', …])
const TREE_SPRITES = [];
if (typeof window !== 'undefined') {
  window.ParkPlanner = window.ParkPlanner || {};
  window.ParkPlanner.setTreeImages = (urls) => {
    TREE_SPRITES.length = 0;
    (urls || []).forEach((u) => { const im = new Image(); im.src = u; TREE_SPRITES.push(im); });
  };
}


// ---------- Imported assets ----------
// An imported symbol becomes an ordinary point annotation with a painter that
// happens to draw a bitmap, so the palette, selection, the inspector sliders,
// the object list, copy/paste and the exporters need no special case at all.
const ASSET_MAX_PX = 512;              // long side after normalisation
const ASSET_MAX_CHARS = 256 * 1024;    // per asset, as stored (data-URL text)
const ASSET_LIB_MAX_CHARS = 2 * 1024 * 1024; // whole library
const ASSET_DEF_H = 2.5;               // default height in metres, for 3D
const ASSETS_KEY = 'pp_assets';

const ASSET_IMAGES = new Map(); // id → HTMLImageElement
let assetRepaint = () => {};    // wired to the canvas renderer once it exists

function assetPainter(id) {
  return (ctx) => {
    const img = ASSET_IMAGES.get(id);
    if (!img || !img.complete || !img.naturalWidth) return;
    const a = img.naturalHeight / img.naturalWidth;
    // The halo exists to keep thin white road paint legible on pale asphalt;
    // on a photo or a logo it only smears the edges.
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    ctx.drawImage(img, -1, -a, 2, 2 * a);
  };
}

// Idempotent: called on boot, after loading a file, and from the effect that
// watches doc.assets — all three can fire for an asset that is already live.
// `inPalette` false keeps a type registered (so placed instances keep drawing)
// while hiding it from the palette.
function installAsset(asset, inPalette) {
  if (!asset || !asset.id) return;
  const kind = registerAsset(asset);
  ANNOT_TYPES[kind].hidden = !inPalette;
  PICTOS[kind] = assetPainter(asset.id);
  if (ASSET_IMAGES.has(asset.id)) return;
  const img = new Image();
  // A bitmap finishes decoding after the render pass that wanted it, and
  // nothing else re-triggers the canvas — without this the asset stays
  // invisible until the user happens to pan. (TREE_SPRITES has exactly this
  // bug, which is why tree images never appear until something else redraws.)
  img.onload = () => { try { assetRepaint(); } catch (e) {} };
  img.src = asset.src;
  ASSET_IMAGES.set(asset.id, img);
}

function readAssetLib() {
  try { return JSON.parse(localStorage.getItem(ASSETS_KEY) || '[]') || []; } catch (e) { return []; }
}
// The one localStorage write in this app that must not swallow its error.
// Everything else here (workspaces, panel widths, clipboard, theme) fails
// silently, so a quota blown by a fat image would break all of them at once
// with no visible cause. Returns '' on success, a message on failure.
function writeAssetLib(list) {
  try { localStorage.setItem(ASSETS_KEY, JSON.stringify(list)); return ''; }
  catch (e) { return 'Opslag zit vol — verwijder een asset en probeer opnieuw.'; }
}
const assetLibChars = (list) => list.reduce((n, a) => n + (a.src || '').length, 0);

// Read a file into a decoded image. SVG arrives as a data URL too, so the same
// path serves both.
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('lezen mislukt'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('geen geldig beeld'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Re-encode until the stored text fits the budget. A photo blows a PNG budget
// long before its detail matters at plan scale, so stepping the raster down is
// the right trade — silently storing 2 MB is not.
function encodeWithin(canvas) {
  let src = canvas.toDataURL('image/png');
  let w = canvas.width, h = canvas.height;
  while (src.length > ASSET_MAX_CHARS && Math.max(w, h) > 96) {
    w = Math.max(1, Math.round(w * 0.75)); h = Math.max(1, Math.round(h * 0.75));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(canvas, 0, 0, w, h);
    src = c.toDataURL('image/png');
  }
  return { src, w, h };
}

// Normalise any supported image to a single PNG of at most ASSET_MAX_PX on the
// long side. One code path for PNG/JPG/WebP/SVG, and it fixes SVGs that carry
// no intrinsic size (browsers fall back to 0×0 or 300×150 for those).
async function normalizeAsset(file) {
  const img = await fileToImage(file);
  const isSvg = /svg/i.test(file.type || '') || /\.svg$/i.test(file.name || '');
  let iw = img.naturalWidth || 0, ih = img.naturalHeight || 0;
  if (!(iw > 0 && ih > 0)) { iw = ASSET_MAX_PX; ih = ASSET_MAX_PX; }
  // A viewBox-only SVG reports the browser's 300×150 placeholder, and a logo
  // drawn as an icon reports whatever tiny size it was authored at. Vectors
  // re-rasterise cleanly, so always take them at full resolution rather than
  // freezing in whatever the intrinsic size happened to be.
  const k = isSvg ? ASSET_MAX_PX / Math.max(iw, ih) : Math.min(1, ASSET_MAX_PX / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const enc = encodeWithin(c);
  return {
    id: 'a' + Math.random().toString(36).slice(2, 9),
    name: (file.name || 'asset').replace(/\.[^.]+$/, '').slice(0, 40) || 'asset',
    src: enc.src, w: enc.w, h: enc.h,
    mWidth: 2, height: ASSET_DEF_H,
  };
}

// Floor symbols painted in a bay, by stall type. Reuses the road pictograms —
// they already draw in a unit box and rotate onto any angle.
const STALL_PICTOS = { ada: 'ada', ev: 'ev' };

// Haaientanden: triangles along one side of the line, points facing the
// traffic that must give way — the Belgian "voorrang verlenen" marking.
function drawSharkTeeth(ctx, ann, w2s, scale, selected) {
  const pts = (ann.points || []).map(w2s);
  if (pts.length < 2) return;
  const base = Math.max(4, (ann.width || 2.5) * scale * 0.45);
  ctx.save();
  ctx.shadowColor = TH.pictoHalo; ctx.shadowBlur = Math.max(2, base * 0.3);
  ctx.fillStyle = selected ? TH.sel : '#f8fafc';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const nx = -uy, ny = ux;
    const step = base * 1.6;
    for (let d = base * 0.4; d < len - base * 0.4; d += step) {
      const px = a.x + ux * d, py = a.y + uy * d;
      pathFrom(ctx, [
        [px - ux * base * 0.45, py - uy * base * 0.45],
        [px + ux * base * 0.45, py + uy * base * 0.45],
        [px + nx * base * 1.15, py + ny * base * 1.15],
      ], true);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Kruisarcering (a no-parking wedge) and vakbelijning (bay lines) share a
// polygon and differ only in how the interior is striped.
function drawHatchOrBays(ctx, ann, w2s, scale, selected) {
  const pts = (ann.points || []).map(w2s);
  if (pts.length < 3) return;
  const bays = ann.kind === 'bayLines';
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  ctx.save();
  pathFrom(ctx, pts.map((p) => [p.x, p.y]), true);
  ctx.clip();
  ctx.strokeStyle = selected ? TH.sel : '#f8fafc';
  // Spacing and weight come from the shared spec, so plan and drape cannot
  // drift apart. The screen-space floor stays: zoomed far out the stripes would
  // otherwise merge into a solid block.
  const spec = STRIPE_SPEC[bays ? 'bayLines' : 'hatchZone'];
  ctx.lineWidth = Math.max(1, spec.weight * scale);
  const gap = Math.max(8, spec.spacing * scale);
  ctx.beginPath();
  if (bays) {
    for (let x = minX; x <= maxX; x += gap) { ctx.moveTo(x, minY); ctx.lineTo(x, maxY); }
  } else {
    for (let x = minX - (maxY - minY); x <= maxX; x += gap) { ctx.moveTo(x, minY); ctx.lineTo(x + (maxY - minY), maxY); }
  }
  ctx.stroke();
  ctx.restore();
  pathFrom(ctx, pts.map((p) => [p.x, p.y]), true);
  ctx.strokeStyle = selected ? TH.sel : '#f8fafc';
  ctx.lineWidth = Math.max(1.2, 0.16 * scale);
  ctx.stroke();
}

// A point marking: positioned, scaled to its width in metres, rotated to its
// own angle. Signs get a post shadow so they read as vertical, not painted.
function drawPicto(ctx, ann, t, s, scale, selected) {
  const painter = PICTOS[t.picto];
  if (!painter) return;
  const r = Math.max(6, ((ann.width || t.width || 3) / 2) * scale);
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(((ann.angle || 0) * Math.PI) / 180);
  if (t.sign) {
    ctx.save();
    ctx.globalAlpha = 0.28; ctx.fillStyle = '#000000';
    ctx.beginPath(); ctx.ellipse(0, r * 0.55, r * 0.85, r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.scale(r, r);
  // Road paint is white, which vanishes on a light backdrop. A soft dark halo
  // under every stroke keeps it legible on pale asphalt without making the
  // marking itself the wrong colour.
  ctx.shadowColor = TH.pictoHalo;
  ctx.shadowBlur = 0.22;
  painter(ctx, ann);
  ctx.restore();
  if (selected) {
    ctx.strokeStyle = TH.sel; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function drawTree(ctx, s, rpx, index, selected) {
  const sprite = TREE_SPRITES.length ? TREE_SPRITES[index % TREE_SPRITES.length] : null;
  // soft ground shadow
  ctx.beginPath();
  ctx.ellipse(s.x, s.y + rpx * 0.25, rpx * 0.95, rpx * 0.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fill();
  if (sprite && sprite.complete && sprite.naturalWidth) {
    const d = rpx * 2;
    ctx.drawImage(sprite, s.x - rpx, s.y - d + rpx * 0.6, d, d);
  } else {
    const g = ctx.createRadialGradient(s.x - rpx * 0.3, s.y - rpx * 0.3, rpx * 0.2, s.x, s.y, rpx);
    g.addColorStop(0, '#5fd97f');
    g.addColorStop(1, '#166534');
    ctx.beginPath();
    ctx.arc(s.x, s.y, rpx, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (selected) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, rpx + 3, 0, Math.PI * 2);
    ctx.strokeStyle = TH.sel;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// Access point / entrance marker on the site boundary.
function drawAccess(ctx, s, rpx, selected) {
  const r = Math.max(7, rpx * 0.7);
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#22d3ee';
  ctx.fill();
  ctx.strokeStyle = selected ? TH.sel : TH.outline;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.stroke();
  ctx.strokeStyle = '#06323a';
  ctx.lineWidth = Math.max(1.5, r * 0.22);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s.x - r * 0.4, s.y + r * 0.18);
  ctx.lineTo(s.x, s.y - r * 0.35);
  ctx.lineTo(s.x + r * 0.4, s.y + r * 0.18);
  ctx.stroke();
}

// ---- Annotation (infrastructure) rendering ----
function buildAnnotPath(ctx, pts, curved) {
  ctx.beginPath();
  if (pts.length < 2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (!curved || pts.length === 2) {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    return;
  }
  // Catmull-Rom → cubic bezier for a smooth curve through the points.
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y);
  }
}

// A driveway: filled rectangle straddling the site edge with an inward arrow.
function drawDriveway(ctx, ann, w2s, scale, selected) {
  const pts = (ann.points || []).map(w2s);
  if (pts.length < 3) return;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = selected ? 'rgba(82,91,104,0.9)' : 'rgba(82,91,104,0.72)';
  ctx.fill();
  ctx.strokeStyle = selected ? '#93c5fd' : '#6b7280';
  ctx.lineWidth = selected ? 2 : 1.2;
  ctx.stroke();
  // Inward direction arrow.
  if (ann.anchor && ann.nx != null) {
    const o = w2s(ann.anchor);
    const tip = w2s({ x: ann.anchor.x + ann.nx * (ann.depth || 10) * 0.7, y: ann.anchor.y + ann.ny * (ann.depth || 10) * 0.7 });
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    const ang = Math.atan2(tip.y - o.y, tip.x - o.x), h = Math.max(5, scale * 1.1);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - h * Math.cos(ang - 0.5), tip.y - h * Math.sin(ang - 0.5));
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - h * Math.cos(ang + 0.5), tip.y - h * Math.sin(ang + 0.5));
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
}

// Drive-thru lane: an orange queue lane with per-car tick marks, a direction
// arrow, a pickup window at the end, and the stacking count.
function drawDriveThru(ctx, ann, w2s, scale, selected) {
  const P = ann.points; if (!P || P.length < 2) return;
  const pts = P.map(w2s), hw = (ann.width || 3.5) / 2;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.strokeStyle = selected ? 'rgba(249,115,22,0.55)' : 'rgba(249,115,22,0.42)';
  ctx.lineWidth = Math.max(3, (ann.width || 3.5) * scale); ctx.stroke();
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.strokeStyle = '#f97316'; ctx.lineWidth = selected ? 2 : 1.2; ctx.stroke();
  ctx.lineCap = 'butt';
  // Per-car tick marks (queue positions) every CAR_LEN along the path.
  let acc = 0, next = CAR_LEN * 0.5;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, px = -uy, py = ux;
    while (next <= acc + len) {
      const t = next - acc, cx = a.x + ux * t, cy = a.y + uy * t;
      const e1 = w2s({ x: cx + px * hw * 0.85, y: cy + py * hw * 0.85 }), e2 = w2s({ x: cx - px * hw * 0.85, y: cy - py * hw * 0.85 });
      ctx.strokeStyle = TH.inkFaint; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(e1.x, e1.y); ctx.lineTo(e2.x, e2.y); ctx.stroke();
      next += CAR_LEN;
    }
    acc += len;
  }
  // Pickup window marker at the last point.
  const end = pts[pts.length - 1], prev = pts[pts.length - 2] || end, r = Math.max(4, scale * 1.3);
  ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.arc(end.x, end.y, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `${Math.max(8, r)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('W', end.x, end.y);
  // Direction arrow just before the window.
  const ang = Math.atan2(end.y - prev.y, end.x - prev.x), h = Math.max(5, scale * 1.2);
  const ax = end.x - Math.cos(ang) * r * 1.6, ay = end.y - Math.sin(ang) * r * 1.6;
  ctx.strokeStyle = '#fdba74'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ax - h * Math.cos(ang - 0.5), ay - h * Math.sin(ang - 0.5));
  ctx.lineTo(ax, ay);
  ctx.lineTo(ax - h * Math.cos(ang + 0.5), ay - h * Math.sin(ang + 0.5));
  ctx.stroke();
  // Turn-radius fillets at each interior bend (green = OK, red = too tight).
  const R = ann.turnR || 7.5;
  for (let i = 1; i < P.length - 1; i++) {
    const fl = filletAt(P[i - 1], P[i], P[i + 1], R);
    if (!fl) continue;
    const O = w2s(fl.O), rp = R * scale;
    let a0 = Math.atan2(w2s(fl.pa).y - O.y, w2s(fl.pa).x - O.x), a1 = Math.atan2(w2s(fl.pb).y - O.y, w2s(fl.pb).x - O.x);
    let d = a1 - a0; while (d < -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
    const col = fl.tight ? '#ef4444' : '#22c55e';
    for (const rr of [rp - hw * scale, rp, rp + hw * scale]) {
      if (rr <= 0) continue;
      ctx.beginPath(); ctx.arc(O.x, O.y, rr, a0, a1, d < 0);
      ctx.strokeStyle = rr === rp ? col : 'rgba(253,186,116,0.6)';
      ctx.setLineDash(rr === rp ? [4, 3] : []); ctx.lineWidth = 1.2; ctx.stroke();
    }
    ctx.setLineDash([]);
    if (fl.tight) {
      const c = w2s(P[i]);
      ctx.fillStyle = '#ef4444'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('R ' + R.toFixed(1) + ' m krap', c.x, c.y - 8);
      ctx.textAlign = 'start';
    }
  }

  // Stacking count label at the midpoint.
  const mid = pts[Math.floor(pts.length / 2)] || pts[0], label = drivethruStacks(P) + ' auto\'s';
  ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(label).width + 8;
  ctx.fillStyle = TH.plate; ctx.fillRect(mid.x - w / 2, mid.y - 18, w, 15);
  ctx.fillStyle = '#fdba74'; ctx.fillText(label, mid.x, mid.y - 10);
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

function drawAnnotation(ctx, ann, w2s, scale, selected, index) {
  const t = ANNOT_TYPES[ann.kind];
  if (!t || !ann.points || ann.points.length < 1) return;

  if (t.mode === 'point') {
    if (t.picto) { drawPicto(ctx, ann, t, w2s(ann.points[0]), scale, selected); return; }
    const rpx = Math.max(3, ((ann.width || t.width || 5) / 2) * scale);
    if (ann.kind === 'access') drawAccess(ctx, w2s(ann.points[0]), rpx, selected);
    else drawTree(ctx, w2s(ann.points[0]), rpx, index || 0, selected);
    return;
  }
  if (ann.kind === 'sharkTeeth') { drawSharkTeeth(ctx, ann, w2s, scale, selected); return; }
  if (ann.kind === 'hatchZone' || ann.kind === 'bayLines') { drawHatchOrBays(ctx, ann, w2s, scale, selected); return; }
  if (t.mode === 'driveway') { drawDriveway(ctx, ann, w2s, scale, selected); return; }
  if (ann.kind === 'drivethru') { if (ann.points.length >= 2) drawDriveThru(ctx, ann, w2s, scale, selected); return; }
  if (ann.points.length < 2) return;

  if (t.mode === 'cross') {
    // The bar geometry comes from geometry.js so the 3D drape lays down exactly
    // the same zebra; it used to be computed here and nowhere else, which is why
    // a crossing was a set of bars in plan and a single grey line in 3D.
    ctx.fillStyle = selected ? TH.sel : '#e9edf2';
    for (const bar of zebraQuads(ann.points, ann.width)) {
      ctx.beginPath();
      bar.map(w2s).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    }
    return;
  }

  if (t.mode === 'area') {
    const pts = ann.points.map(w2s);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    // Every area but grass used to be the same teal. A chosen material is what
    // the surface actually is, so it decides the colour.
    const mat = surfaceOf(ann);
    ctx.fillStyle = mat ? hexA(mat.tint, 0.55) : (ann.kind === 'grass' ? hexA(t.color, 0.5) : 'rgba(14,116,144,0.35)');
    ctx.fill();
    ctx.strokeStyle = selected ? TH.sel : t.color;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.stroke();
    if (ann.kind !== 'bikeparking') return;
    const cap = Math.floor(polygonArea(ann.points) / 1.5); // ~1.5 m² per bike
    const c = w2s(polygonCentroid(ann.points));
    ctx.fillStyle = TH.ink;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('~' + cap + ' fietsen', c.x, c.y);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    return;
  }

  // A carriageway is filled, not stroked: a fat stroke rounds every join and
  // cap and cannot be offset off its own centreline.
  if (t.body && !ann.closed) {
    const body = ribbon(ann, t);
    if (body && body.length >= 3) {
      const bp = body.map(w2s);
      ctx.save();
      ctx.lineJoin = 'miter'; ctx.miterLimit = 8; ctx.lineCap = 'butt';
      ctx.beginPath();
      bp.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      // The tarmac is laid in one pass for the whole plan so roads flow into
      // each other without a seam; a kind that is NOT the aisle colour still
      // paints itself, and only a selected road gets an outline.
      if (!t.aisleColor) { ctx.fillStyle = hexA(t.color, 0.9); ctx.fill(); }
      if (selected) { ctx.strokeStyle = TH.sel; ctx.lineWidth = 2.5; ctx.stroke(); }
      // When the line you drew is a kerb it no longer runs down the middle, so
      // show it while the road is selected — otherwise the handles look adrift.
      if (selected && ann.align) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = TH.inkFaint; ctx.lineWidth = 1.2;
        buildAnnotPath(ctx, ann.points.map(w2s), !!ann.curved);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
    return;
  }

  // Line kinds (walkway, bikepath, marking); `closed` = filled area (plein).
  const pts = ann.points.map(w2s);
  const closed = !!ann.closed;
  const wpx = closed ? 2 : Math.max(1.5, (ann.width || 0.3) * scale);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (closed) {
    buildAnnotPath(ctx, pts, false); ctx.closePath();
    ctx.fillStyle = hexA(t.color, 0.55);
    ctx.fill();
    const c = w2s(polygonCentroid(ann.points));
    ctx.fillStyle = TH.ink;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(polygonArea(ann.points)) + ' m²', c.x, c.y);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
  if (selected) {
    ctx.strokeStyle = TH.sel;
    ctx.lineWidth = (closed ? 2 : wpx) + 4;
    buildAnnotPath(ctx, pts, ann.curved && !closed); if (closed) ctx.closePath();
    ctx.stroke();
  }
  ctx.strokeStyle = t.color;
  ctx.lineWidth = wpx;
  buildAnnotPath(ctx, pts, ann.curved && !closed); if (closed) ctx.closePath();
  ctx.stroke();
  if (ann.kind === 'bikepath' && !closed) { // dashed centre line
    ctx.strokeStyle = TH.inkSoft;
    ctx.lineWidth = Math.max(1, wpx * 0.12);
    ctx.setLineDash([6, 6]);
    buildAnnotPath(ctx, pts, ann.curved);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// Knelpunten from the drivability check. Numbered so a row in the panel and a
// mark on the plan are obviously the same thing, and drawn last so nothing
// hides them. Nothing here appears unless the user asked for it.
function drawIssues(ctx, list, focus, w2s, scale) {
  ctx.save();
  list.forEach((it, i) => {
    if (!it.at) return;
    const active = i === focus;
    if (!active && focus >= 0) ctx.globalAlpha = 0.45;
    const p = w2s(it.at);
    const col = it.sev === 'warn' ? '#f59e0b' : '#ef4444';
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = col;
    ctx.lineWidth = active ? 2.5 : 1.5;
    if (it.kind === 'corner' && it.want > 0) {
      // The radius the vehicle needs, at the corner that does not offer it.
      ctx.beginPath(); ctx.arc(p.x, p.y, it.want * scale, 0, Math.PI * 2); ctx.stroke();
    } else if (it.kind === 'fire' && it.to) {
      const q = w2s(it.to);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    } else {
      const r = Math.max(10, 4 * scale);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
    // Numbered badge.
    ctx.beginPath(); ctx.arc(p.x, p.y, active ? 11 : 9, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = (active ? 'bold 12px ' : '11px ') + 'system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), p.x, p.y + 0.5);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  });
  ctx.restore();
}

// A crossing that has not been made into a junction gets a red bar across it:
// the two ways only look joined because the tarmac is one surface, and nothing
// should ever be silently connected.
// The arms of a junction, lit up so one can be clicked. Deliberately fat and
// translucent: it is a target, not a drawing.
function drawArmPicker(ctx, arms, w2s, scale) {
  ctx.save();
  ctx.lineCap = 'round';
  for (const arm of arms) {
    const tip = { x: arm.at.x + arm.ux * Math.min(arm.run, 10), y: arm.at.y + arm.uy * Math.min(arm.run, 10) };
    const a = w2s(arm.at), b = w2s(tip);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = 'rgba(239,68,68,0.55)';
    ctx.lineWidth = Math.max(6, arm.width * scale);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCrossings(ctx, list, anns, w2s, scale) {
  for (const c of list) {
    if (c.mode === 'merged') continue;
    const s = w2s(c.at);
    if (c.mode === 'break') {
      // Bollards across the arm that is closed, standing at the MOUTH of that
      // arm — flush with the kerb of the road it meets. They used to be centred
      // on the crossing point itself, which put them in the middle of the road
      // being crossed instead of at the head of the street.
      const arms = junctionArms(anns, c);
      if (!arms.length) continue;
      // Which arm: an explicit heading if the choice recorded one, otherwise the
      // legacy mod-180 `dir`, which named a whole way and so closes both of its
      // arms.
      const pick = c.arm != null
        ? arms.filter((a) => Math.abs(((a.heading - c.arm + 540) % 360) - 180) < 30)
        : arms.filter((a) => Math.abs((((a.heading % 180) - (c.dir || 0) + 270) % 180) - 90) < 30);
      const chosen = pick.length ? pick : arms.slice(0, 1);
      ctx.fillStyle = '#e2e8f0';
      ctx.strokeStyle = 'rgba(15,23,42,0.55)';
      ctx.lineWidth = 1;
      for (const arm of chosen) {
        const at = armMouth(anns, c, arm);
        const nx = -arm.uy, ny = arm.ux;          // across the arm
        const half = Math.max(0.6, arm.width / 2 - 0.35);
        const n = Math.max(2, Math.round((half * 2) / 1.4));
        for (let k = 0; k <= n; k++) {
          const t = -half + (2 * half * k) / n;
          const p = w2s({ x: at.x + nx * t, y: at.y + ny * t });
          const r = Math.max(1.6, 0.22 * scale);
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
      continue;
    }
    const r = Math.max(7, 1.8 * scale);
    ctx.save();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = Math.max(2, 0.3 * scale);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r);
    ctx.moveTo(s.x - r, s.y + r); ctx.lineTo(s.x + r, s.y - r);
    ctx.stroke();
    ctx.restore();
  }
}

function drawAnnotations(ctx, anns, w2s, scale, under, selIdx) {
  for (let i = 0; i < anns.length; i++) {
    const t = ANNOT_TYPES[anns[i].kind];
    if (!t || !!t.under !== under) continue;
    drawAnnotation(ctx, anns[i], w2s, scale, !!(selIdx && selIdx.has(i)), i);
  }
}

// Measuring tape: each leg labelled, the running total at the cursor, and the
// enclosed area once three points make a shape. Deliberately drawn last and in
// the accent colour so it reads as a tool, not as part of the plan.
function drawMeasure(ctx, m, w2s, scale) {
  const pts = (m.points || []).slice();
  if (m.cur && !m.done) pts.push(m.cur);
  if (pts.length < 1) return;
  const sp = pts.map(w2s);
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (pts.length >= 3) {
    ctx.beginPath();
    sp.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(37,99,235,0.10)';
    ctx.fill();
  }
  ctx.beginPath();
  sp.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.setLineDash([7, 4]);
  ctx.stroke(); ctx.setLineDash([]);
  let total = 0;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    total += len;
    const mid = { x: (sp[i].x + sp[i + 1].x) / 2, y: (sp[i].y + sp[i + 1].y) / 2 };
    const label = len.toFixed(len < 10 ? 2 : 1) + ' m';
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = TH.plate; ctx.fillRect(mid.x - w / 2, mid.y - 9, w, 17);
    ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1; ctx.strokeRect(mid.x - w / 2, mid.y - 9, w, 17);
    ctx.fillStyle = '#2563eb'; ctx.fillText(label, mid.x, mid.y);
  }
  for (const p of sp) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = TH.handleCore; ctx.fill();
    ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.stroke();
  }
  if (pts.length >= 2) {
    const end = sp[sp.length - 1];
    const parts = ['totaal ' + total.toFixed(1) + ' m'];
    if (pts.length >= 3) parts.push(Math.abs(polygonArea(pts)).toFixed(1) + ' m²');
    const label = parts.join('  ·  ');
    ctx.font = '600 12px system-ui, sans-serif';
    const w = ctx.measureText(label).width + 14;
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(end.x + 12, end.y - 26, w, 20);
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left';
    ctx.fillText(label, end.x + 19, end.y - 16);
  }
  ctx.restore();
}

function drawGrid(ctx, view, size) {
  // Adaptive metric grid: pick a step that renders ~45px+ apart.
  const steps = [1, 2, 5, 10, 20, 50, 100, 200];
  const stepM = steps.find((s) => s * view.scale >= 45) || 200;
  const px = stepM * view.scale;
  // Hard guard: a non-positive/non-finite pixel step would loop forever.
  if (!(px > 0) || !isFinite(px)) return;
  const startX = ((view.ox % px) + px) % px;
  const startY = ((view.oy % px) + px) % px;
  ctx.strokeStyle = TH.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x < size.w; x += px) { ctx.moveTo(x, 0); ctx.lineTo(x, size.h); }
  for (let y = startY; y < size.h; y += px) { ctx.moveTo(0, y); ctx.lineTo(size.w, y); }
  ctx.stroke();
}

// ---------- Main component ----------
function App() {
  const [hist, dispatch] = useReducer(historyReducer, { past: [], present: initialDoc, future: [] });
  const doc = hist.present;
  // Effective site polygon: control points, or a tessellated spline when
  // curved. Everything geometric (solve, metrics, render, export) uses this;
  // editing (vertex handles, move) still uses the control points doc.site.
  const sitePoly = useMemo(
    () => (doc.siteCurved && doc.site.length >= 3 ? tessellateClosed(doc.site, 14) : doc.site),
    [doc.site, doc.siteCurved]
  );
  // Roads / driveways carve clear corridors the parking must avoid.
  const roadBlockers = useMemo(
    () => (doc.annotations || [])
      .filter((a) => ANNOT_TYPES[a.kind] && ANNOT_TYPES[a.kind].blocks)
      .map(annotationBlocker).filter(Boolean),
    [doc.annotations]
  );
  const [tool, setTool] = useState('select');
  const [measure, setMeasure] = useState(null); // { points:[], cur } while measuring
  const [layers, setLayers] = useState({ grid: true, site: true, setback: true, building: true, parking: true, infra: true, context: true, shadow: false, lightmap: false });
  const [annotKind, setAnnotKind] = useState('road'); // active infra kind when drawing
  const [annotWidth, setAnnotWidth] = useState(6);
  // The editable number a speed marking or a lamp post carries, chosen before
  // the thing is placed rather than corrected afterwards. Null for the tools
  // that have no such number.
  const [annotValue, setAnnotValue] = useState(null);
  const [areaShape, setAreaShape] = useState('poly'); // 'rect' | 'poly' | 'circle' for area infra
  const [roadShape, setRoadShape] = useState('line'); // 'line' | 'rect' (object) | 'multi'
  const [annotLength, setAnnotLength] = useState(20); // m — the road object's length
  const [annotRot, setAnnotRot] = useState(0);        // deg — the road object's heading
  const [annotMaterial, setAnnotMaterial] = useState('');  // '' = leave it unset
  const [annotCurved, setAnnotCurved] = useState(true);
  // What the line you draw means for a carriageway: its centre, or one of its
  // kerbs (seen in the direction you draw).
  const [annotAlign, setAnnotAlign] = useState('center');
  const [buildUse, setBuildUse] = useState(DEFAULT_USE);
  const [buildMat, setBuildMat] = useState('');   // '' = whatever the type usually is
  // Alt+drag carries whatever stands on a road, but most Linux desktops and
  // some Windows setups grab Alt+drag to move windows, so the browser never
  // sees it. This is the same thing without a modifier.
  const [carryRiders, setCarryRiders] = useState(false);
  // Snapping is a preference, not a law. It sticks across sessions because it is
  // a way of working rather than a property of the plan.
  const [snapOn, setSnapOn] = useState(() => {
    try { return localStorage.getItem('pp_snap') !== 'off'; } catch (e) { return true; }
  });
  const [staleBuild, setStaleBuild] = useState('');
  const [askJunction, setAskJunction] = useState(null);
  // While set, the junction's arms are lit up on the plan and the next click
  // picks one. Naming an arm by clicking it beats choosing between two buttons
  // labelled "Weg 3" and "Weg 5", which say nothing about where they are.
  const [pickArm, setPickArm] = useState(null);
  // The library: the tool palette as something you browse rather than squint at.
  const [libOpen, setLibOpen] = useState(false);
  const [libTab, setLibTab] = useState('infra');   // 'infra' | 'assets'
  const [libQuery, setLibQuery] = useState('');
  const [libPick, setLibPick] = useState(''); // the kind the dialog has highlighted
  // Which member of each combo family is chosen, family id → kind. Remembered
  // across opens: having to re-pick "keren" every time would defeat the card.
  const [comboPick, setComboPick] = useState({});
  // The value the next placement carries, edited on the card before drawing.
  const [libValue, setLibValue] = useState({}); // kind → number
  // When the plan was last written to a file. Not stored in the document: it is
  // a fact about this session's browser, and a loaded file's own timestamp
  // would say "saved" about a plan you have since changed.
  const [savedAt, setSavedAt] = useState(null);
  const [placing, setPlacing] = useState(0); // >0 while a duplicated group follows the cursor
  const [toolQuery, setToolQuery] = useState('');
  const [objQuery, setObjQuery] = useState('');
  const [objEdit, setObjEdit] = useState('');  // the row whose name is being typed
  // Imported symbols. The library is per-browser; a document carries its own
  // copies so a shared plan is not full of holes.
  const [assetLib, setAssetLib] = useState(() => readAssetLib());
  // Imported building styles. Same shape as the symbol library: kept per browser
  // so they are there for the next plan, and copied into the document so a saved
  // or shared plan renders its buildings even for someone who never imported
  // them. buildings.js does the clamping; nothing unvalidated reaches geometry.
  const [styleLib, setStyleLib] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pp_build_styles') || '[]') || []; } catch (e) { return []; }
  });
  const [styleMsg, setStyleMsg] = useState('');
  const [assetMsg, setAssetMsg] = useState('');
  // Saved layout. Absent id => visible, so a part added later is on by default
  // rather than silently missing for everyone who already saved a layout.
  // Parts that start off. A stored preference wins, including a stored `false`,
  // so switching one on is remembered and a later default cannot override it.
  const HIDDEN_BY_DEFAULT = { secDraw: true, secAssets: true };
  const [hidden, setHidden] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('pp_ui_hidden') || '{}') || {};
      return { ...HIDDEN_BY_DEFAULT, ...saved };
    } catch (e) { return { ...HIDDEN_BY_DEFAULT }; }
  });
  const [panelW, setPanelW] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem('pp_panel_widths') || '{}') || {};
      return { left: +v.left || PANEL_W.left.def, right: +v.right || PANEL_W.right.def };
    } catch (e) { return { left: PANEL_W.left.def, right: PANEL_W.right.def }; }
  });
  const [workspaces, setWorkspaces] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pp_workspaces') || '{}') || {}; } catch (e) { return {}; }
  });
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [wsName, setWsName] = useState('');
  const resizeRef = useRef(null);
  const [openGroups, setOpenGroups] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pp_tool_groups') || '{}') || {}; } catch (e) { return {}; }
  });
  const toolSearchRef = useRef(null);
  const [view, setView] = useState({ scale: 8, ox: 60, oy: 60 });
  const [drawing, setDrawing] = useState(null); // { points: [] }
  const [hover, setHover] = useState(null);
  const [selection, setSelection] = useState(null);       // obstacle selection
  const [stallSel, setStallSel] = useState([]);           // selected stall keys
  // A second selection channel, for picking several things of different kinds at
  // once. Stalls keep using stallSel — one channel per kind of thing, so there
  // is never a question of which one a button means. Everything that reads
  // `selection` also has to say what it does with this; where it doesn't, the
  // panel would show five objects and the button would act on one.
  const [multiSel, setMultiSel] = useState({ anns: [], obs: [] });
  const multiCount = multiSel.anns.length + multiSel.obs.length + stallSel.length;
  const [aisleSel, setAisleSel] = useState(null);         // selected aisle key
  const [result, setResult] = useState({ stalls: [], aisles: [], islands: [], turnarounds: [], orientationCount: 0 });
  const [solving, setSolving] = useState(false);
  const [geoSearch, setGeoSearch] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoMsg, setGeoMsg] = useState('');
  const [viewMode, setViewMode] = useState('2d');            // '2d' (flat map) | '3d' (tilted map)
  const [mbToken, setMbToken] = useState(() => { try { return localStorage.getItem('pp_mapbox_token') || ''; } catch (e) { return ''; } });
  const [mapStyle, setMapStyle] = useState(() => { try { return localStorage.getItem('pp_map_style') || 'satellite'; } catch (e) { return 'satellite'; } });
  // Light by default; the stored choice wins, then the OS preference.
  const [mbTokenInput, setMbTokenInput] = useState('');
  const [map3dError, setMap3dError] = useState('');
  // The error card sits over the middle of the canvas. It has to be dismissable:
  // a late map error would otherwise drop an undismissable 380px block on the
  // plan and swallow every drag started under it.
  const [mapErrHidden, setMapErrHidden] = useState(false);
  const [mapDiag, setMapDiag] = useState({});      // per-stage basemap status
  const [diagOpen, setDiagOpen] = useState(false);
  const [mapNonce, setMapNonce] = useState(0);     // bump to force a map retry
  const [mapReady, setMapReady] = useState(0);     // bumped once the controller exists
  const [stallRot, setStallRot] = useState(0);     // extra stall rotation in degrees (R key)
  const [exportOpen, setExportOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(true);   // welcome overlay on open
  const [schemes, setSchemes] = useState(null);           // generated layout variants
  const [optState, setOptState] = useState(null);         // { running, i, n } | { done, label, before, after }
  const [dealbarOpen, setDealbarOpen] = useState(true);   // bottom deal-tabulation bar

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const sizeRef = useRef({ w: 800, h: 600 });
  const dragRef = useRef(null);
  const solveTimer = useRef(null);
  const fittedRef = useRef(false);
  const renderRef = useRef(() => {}); // always points at the latest renderNow
  const libOpenRef = useRef(() => {}); // latest openLib (for T)
  const dupRef = useRef(() => {});    // latest duplicateSelection (for Cmd/Ctrl+D)
  const clipRef = useRef({});        // latest copy/cut/paste (for Cmd/Ctrl+C/X/V)
  const docRef = useRef(null);        // latest doc for the window key handler
  const vmRef = useRef('2d');          // latest viewMode (for the native wheel handler)
  const viewRef = useRef(null);        // latest view (async map init reads this, not a stale capture)
  const geoRef = useRef(null);         // latest doc.geo, same reason
  const drewRef = useRef(false); // set once the first frame draws (breadcrumb)
  const marqueeRef = useRef(null); // {x0,y0,x1,y1} in world coords while dragging
  const netRootRef = useRef([]); // per-annotation junction-network root, for the pointer handlers
  const placingRef = useRef(null); // the group hanging off the cursor, waiting to be dropped
  const leftPanelRef = useRef(null);
  const carryRidersRef = useRef(false); // read inside the drag handler
  const snapRef = useRef(true);         // ditto — pointer handlers are not re-created
  const wheelRef = useRef({ at: -1e9, zoom: true }); // latched wheel gesture mode
  const spaceRef = useRef(null); // tool to restore when Space (hold-to-pan) is released
  const geoAppliedRef = useRef(null); // last geo anchor pushed to the 3D camera
  const guidesRef = useRef(null);  // alignment guides shown during a move drag
  const mouseRef = useRef(null);   // last canvas mouse position, in world units
  const map3dRef = useRef(null);   // Mapbox controller when in 3D view
  const workerRef = useRef(null);  // solver web worker (null → inline solve)
  const reqRef = useRef(0);        // latest solve request id (stale-drop)
  const lastArgsRef = useRef(null); // last solve args (for worker-error fallback)

  // Once mounted, cancel the index.html boot-failure fallback.
  useEffect(() => {
    if (window.__pp_boot) { clearTimeout(window.__pp_boot); window.__pp_boot = null; }
    mark('3-gemount');
  }, []);

  // Resize handling + initial fit. DPR capped at 2 to avoid huge canvas
  // backing stores that can crash mobile Safari on hi-DPI screens.
  useEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      const canvas = canvasRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
      if (!fittedRef.current && r.width > 0 && r.height > 0) {
        const fv = fitView(doc.site, r.width, r.height);
        if (fv) { setView(fv); fittedRef.current = true; }
      }
      if (map3dRef.current) {
        map3dRef.current.resize();
        // mapCamFromView derives the centre from the viewport's midpoint, so a
        // changed size moves that midpoint. sizeRef is a ref and not an effect
        // dependency, so without this the map keeps a camera computed from the
        // old height and sits at a constant offset until the user pans.
        if (vmRef.current !== '3d' && viewRef.current && geoRef.current) {
          const c = mapCamFromView(viewRef.current, sizeRef.current, geoRef.current);
          map3dRef.current.follow2D(c.center, c.zoom);
        }
      }
      renderRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Where the site is entered, best source first: the access points you placed,
  // then the inner edge of any driveway, then the corner of the largest building
  // nearest the parking — a stand-in for the shop door, since buildings have no
  // modelled entrance. Empty means "nothing said", and the solver then behaves
  // exactly as it always did.
  const entries = useMemo(() => {
    const anns = doc.annotations || [];
    const acc = anns.filter((a) => a.kind === 'access' && a.points && a.points[0]).map((a) => ({ x: a.points[0].x, y: a.points[0].y }));
    if (acc.length) return acc;
    const dw = anns.filter((a) => a.kind === 'driveway' && a.points && a.points.length >= 4)
      .map((a) => { const c = polygonCentroid(a.points); return { x: c.x, y: c.y }; });
    if (dw.length) return dw;
    const obs = doc.obstacles || [];
    if (!obs.length || !sitePoly || sitePoly.length < 3) return [];
    let big = null, bigA = -1;
    for (const o of obs) { const a = polygonArea(polyOf(o)); if (a > bigA) { bigA = a; big = polyOf(o); } }
    if (!big) return [];
    const sc = polygonCentroid(sitePoly);
    let best = big[0], bestD = Infinity;
    for (const p of big) { const d = dist(p, sc); if (d < bestD) { bestD = d; best = p; } }
    return [{ x: best.x, y: best.y }];
  }, [doc.annotations, doc.obstacles, sitePoly]);

  // Solve off the main thread via a web worker, so big sites don't freeze
  // the UI. Falls back to an inline solve if workers aren't available.
  useEffect(() => {
    let w;
    try { w = new Worker(new URL('./solver.worker.js?v=c8e60896', import.meta.url), { type: 'module' }); }
    catch (e) { w = null; }
    if (w) {
      w.onmessage = (e) => {
        const { reqId, result } = e.data || {};
        if (result && reqId === reqRef.current) { setResult(result); setSolving(false); }
      };
      w.onerror = () => {
        workerRef.current = null; // give up on the worker; solve inline
        const a = lastArgsRef.current;
        if (a) { setResult(solveParking(a[0], a[1], a[2], a[3])); setSolving(false); }
      };
      workerRef.current = w;
    }
    return () => { if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null; } };
  }, []);

  // Debounced solve whenever inputs change.
  useEffect(() => {
    clearTimeout(solveTimer.current);
    // Auto-parking off: keep the canvas free for manual placement only.
    if (!doc.autoParking) {
      reqRef.current++;
      setResult({ stalls: [], aisles: [], islands: [], turnarounds: [], orientationCount: 0 });
      setSolving(false);
      return;
    }
    setSolving(true);
    solveTimer.current = setTimeout(() => {
      // Align rows to the site's longest (control-point) edge when requested.
      const base = doc.params.alignLongestEdge && doc.site.length >= 2
        ? { ...doc.params, alignAngle: longestEdgeAngle(doc.site) }
        : doc.params;
      // Where people arrive, so the accessible spaces can land near it. Plain
      // {x,y} only: this crosses postMessage into the worker.
      const solveP = entries.length ? { ...base, entries } : base;
      const solveObstacles = roadBlockers.length ? [...doc.obstacles, ...roadBlockers] : doc.obstacles;
      const args = [sitePoly, solveObstacles, solveP, doc.orientationIndex];
      lastArgsRef.current = args;
      const reqId = ++reqRef.current;
      if (workerRef.current) {
        workerRef.current.postMessage({ reqId, site: args[0], obstacles: args[1], params: args[2], orientationIndex: args[3] });
      } else {
        setResult(solveParking(args[0], args[1], args[2], args[3]));
        setSolving(false);
      }
    }, 90);
    return () => clearTimeout(solveTimer.current);
  }, [sitePoly, doc.obstacles, roadBlockers, doc.params, doc.orientationIndex, doc.autoParking, entries]);

  // Apply manual overrides (stall type, aisle one-way) on top of the
  // solver output, keyed by position so marks survive re-solves.
  const deco = useMemo(() => {
    const ov = doc.overrides || {};
    const ovStalls = ov.stalls || {}, ovAisles = ov.aisles || {}, ovAngles = ov.angles || {};
    const locks = ov.locks || {}, lockS = locks.stalls || {}, lockA = locks.aisles || {};
    const removed = ov.removed || {};
    const w = doc.params.stallWidth, d = doc.params.stallDepth;
    // Re-orient a stall to an absolute angle about its own centre (the key is
    // centroid-based, so it's unchanged by the rotation and the override sticks).
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
    const stalls = result.stalls.map((st) => {
      const key = stallKey(st.poly);
      return { ...st, key, poly: reangle(st.poly, key), type: ovStalls[key] || st.type, locked: !!lockS[key], angle: ovAngles[key], manual: false };
    }).filter((st) => !removed[st.key]);
    // Hand-placed stalls, markable/lockable like solver stalls.
    for (const ms of doc.manualStalls || []) {
      const key = stallKey(ms.poly);
      stalls.push({ poly: reangle(ms.poly, key), key, type: ovStalls[key] || ms.type || 'standard', locked: !!lockS[key], angle: ovAngles[key], manual: true });
    }
    const gone = ov.aislesRemoved || {};
    const aisles = result.aisles.map((q) => {
      const key = aisleKey(q);
      const o = ovAisles[key] || {};
      return { poly: q, key, oneway: !!o.oneway, dir: o.dir || 1, locked: !!lockA[key] };
    }).filter((a) => !gone[a.key]);
    return { stalls, aisles, islands: result.islands || [], turnarounds: result.turnarounds || [], orientationCount: result.orientationCount };
  }, [result, doc.overrides, doc.manualStalls, doc.params.stallWidth, doc.params.stallDepth]);

  // Every place two drawn ways meet, with whatever was decided about it.
  // ---------- Sun and shadow ----------
  // Derived every render from the plan's own moment. Cheap: one almanac
  // evaluation plus a sweep per building edge.
  const sun = useMemo(
    () => sunPosition(momentUTC(doc.params.sunDate || '2026-06-21',
      doc.params.sunHour == null ? 15 : doc.params.sunHour, (doc.geo || {}).lon),
    (doc.geo || {}).lat || 52, (doc.geo || {}).lon || 5),
    [doc.params.sunDate, doc.params.sunHour, doc.geo]
  );
  const shadows = useMemo(
    () => (layers.shadow ? shadowPolys(doc.obstacles, sun) : []),
    [doc.obstacles, sun, layers.shadow]
  );
  const shadedStalls = useMemo(
    () => (layers.shadow ? stallsInShadow(deco.stalls, shadows, polygonCentroid) : []),
    [deco.stalls, shadows, layers.shadow]
  );

  // ---------- How much light lands here ----------
  // Two sources, one grid. Neither is cheap enough to run on a keystroke, so
  // the whole thing is shut behind the layer and the panel: with both closed no
  // sample is ever taken. Same bargain the drivability check makes.
  const P = doc.params;
  const lightOn = layers.lightmap || !hidden.secLight;
  const lightSource = P.lightSource || 'lamps';
  const poles = useMemo(() => (doc.annotations || [])
    .filter((a) => a.kind === 'lightPole' && a.points && a.points[0])
    .map((a) => ({
      x: a.points[0].x, y: a.points[0].y,
      h: a.value != null ? a.value : DEFAULT_POLE_H,
      lumens: P.poleLumens || 12000,
    })), [doc.annotations, P.poleLumens]);
  const canopies = useMemo(() => (doc.annotations || [])
    .filter((a) => a.kind === 'carport' && a.points && a.points.length >= 3)
    .map((a) => ({ poly: a.points })), [doc.annotations]);

  const lightGrid = useMemo(
    () => (lightOn && sitePoly.length >= 3
      ? sampleGrid(sitePoly, Math.max(1, P.lightStep || 3)) : { step: 3, pts: [] }),
    [lightOn, sitePoly, P.lightStep]
  );
  // The sun's positions are shared by the map and the canopies, so they are
  // computed once here rather than twice inside the two calls below.
  const steps = useMemo(
    () => (lightOn && lightSource === 'sun'
      ? sunSteps((doc.geo || {}).lat || 51, (doc.geo || {}).lon || 4) : null),
    [lightOn, lightSource, doc.geo]
  );
  const pvOpts = useMemo(() => ({
    lat: (doc.geo || {}).lat || 51, lon: (doc.geo || {}).lon || 4,
    ghi: P.pvGHI || 1050, diffuse: P.pvDiffuse == null ? 0.55 : P.pvDiffuse,
    pv: {
      tilt: P.pvTilt == null ? 10 : P.pvTilt, azimuth: P.pvAzimuth == null ? 180 : P.pvAzimuth,
      density: P.pvDensity || 0.2, perf: P.pvPerf || 0.8, height: P.pvHeight || 3,
    },
  }), [doc.geo, P.pvGHI, P.pvDiffuse, P.pvTilt, P.pvAzimuth, P.pvDensity, P.pvPerf, P.pvHeight]);

  const lightField = useMemo(() => {
    if (!lightOn || !lightGrid.pts.length) return null;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const values = lightSource === 'sun'
      ? annualIrradiance(lightGrid.pts, doc.obstacles, { ...pvOpts, steps })
      : illuminance(lightGrid.pts, poles, doc.obstacles, { maintenance: P.poleMaint == null ? 0.8 : P.poleMaint });
    const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    return { values, stats: gridStats(values), unit: lightSource === 'sun' ? 'kWh/m²' : 'lx', ms };
  }, [lightOn, lightSource, lightGrid, poles, doc.obstacles, steps, pvOpts, P.poleMaint]);

  const pvReport = useMemo(
    () => (lightOn && lightSource === 'sun' && canopies.length
      ? canopyYield(canopies, doc.obstacles, { ...pvOpts, steps }) : null),
    [lightOn, lightSource, canopies, doc.obstacles, pvOpts, steps]
  );

  // The grid is the picture; the stalls are the measurement.
  //
  // Averaging over the whole parcel reads U₀ = 0 on any real plan, because the
  // setback strip and the landscape edges are unlit by design and drag the
  // minimum to zero. A lighting requirement covers the surface people park and
  // walk on, so that is what gets averaged — and the darkest stall becomes a
  // place you can click rather than a statistic.
  const stallLight = useMemo(() => {
    if (!lightOn || lightSource !== 'lamps' || !deco.stalls.length || !poles.length) return null;
    const values = illuminance(deco.stalls.map((s) => polygonCentroid(s.poly)), poles,
      doc.obstacles, { maintenance: P.poleMaint == null ? 0.8 : P.poleMaint });
    let worst = -1, wv = Infinity;
    for (let i = 0; i < values.length; i++) if (values[i] < wv) { wv = values[i]; worst = i; }
    return { stats: gridStats(values), worst, worstLux: wv };
  }, [lightOn, lightSource, deco.stalls, poles, doc.obstacles, P.poleMaint]);

  // ---------- Drivability ----------
  // The check runs on demand, never in the render loop: it builds a network and
  // measures every corner on it, which has no business happening on a keystroke.
  // Hidden panel plus markers off → the memo does not run at all.
  const [showIssues, setShowIssues] = useState(false);
  const [focusIssue, setFocusIssue] = useState(-1);
  const designVehicle = doc.params.designVehicle || DEFAULT_VEHICLE;
  const fireMaxDist = doc.params.fireMaxDist > 0 ? doc.params.fireMaxDist : 60;
  const driveReport = useMemo(() => {
    if (hidden.secDrive && !showIssues) return null;
    try {
      return analysePlan({
        site: sitePoly,
        buildable: computeBuildable(sitePoly, doc.params.setback),
        obstacles: doc.obstacles,
        aisles: deco.aisles,
        turnarounds: deco.turnarounds,
        stalls: deco.stalls,
        annotations: doc.annotations,
        junctions: doc.junctions,
        params: doc.params,
      }, designVehicle, { fireMaxDist });
    } catch (e) {
      // A geometry failure must never take the whole app down with it.
      return { issues: [], reach: { total: 0, ok: 0, bad: [] }, empty: true, failed: String(e && e.message || e) };
    }
  }, [sitePoly, doc.obstacles, doc.annotations, doc.junctions, doc.params, deco, designVehicle, fireMaxDist, hidden, showIssues]);
  const driveIssues = driveReport ? driveReport.issues : [];
  useEffect(() => { setFocusIssue(-1); }, [designVehicle, driveIssues.length]);

  const crossings = useMemo(() => {
    const jn = doc.junctions || {};
    return findCrossings(doc.annotations).map((c) => {
      const rec = jn[c.key] || {};
      return { ...c, mode: rec.mode || '', dir: rec.dir, arm: rec.arm };
    });
  }, [doc.annotations, doc.junctions]);
  // Which network each way belongs to: union–find over the joined crossings.
  // Derived, never stored on the annotations — so a duplicate can never inherit
  // the original's network, and taking a junction apart dissolves it by itself.
  const netRoot = useMemo(() => {
    const par = (doc.annotations || []).map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (const c of crossings) {
      if (c.mode !== 'merged' && c.mode !== 'break') continue;
      const a = find(c.i), b = find(c.j);
      if (a !== b) par[a] = b;
    }
    return par.map((_, i) => find(i));
  }, [crossings, doc.annotations]);
  netRootRef.current = netRoot;
  const openCrossings = crossings.filter((c) => !c.mode);
  // Ask as soon as a crossing appears. It is a small popover on the crossing
  // itself rather than a modal: you can ignore it and keep drawing, and the red
  // cross stays behind as the reminder.
  useEffect(() => {
    if (!openCrossings.length) { setAskJunction((cur) => (cur ? null : cur)); return; }
    setAskJunction((cur) => (cur && openCrossings.some((c) => c.key === cur.key) ? cur : openCrossings[0]));
  }, [crossings]);

  // Record what a crossing is. Joining is not written onto the ways themselves:
  // it is a fact about the *place*, so it lives in `junctions` under the position
  // key and the networks fall out of it. The closed branch of an interruption is
  // stored as its heading, not its index, so it survives ways being reordered.
  const setJunction = (c, mode, branch, armHeading) => {
    const rec = { mode };
    // A full-circle heading names ONE arm. The old mod-180 `dir` named a whole
    // way and so closed both of its arms; it stays readable so no saved plan
    // changes behaviour, but new decisions are per arm.
    if (mode === 'break' && armHeading != null) rec.arm = armHeading;
    else if (mode === 'break') rec.dir = branchHeading(doc.annotations, c, branch);
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, junctions: { ...(d.junctions || {}), [c.key]: rec } }) });
    setAskJunction(null);
  };


  const renderNow = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sz = sizeRef.current;
    // Never draw with a zero canvas or a non-finite scale — those are the
    // conditions that turn world-space draw loops into infinite loops.
    if (!(sz.w > 0) || !(sz.h > 0) || !(view.scale > 0) || !isFinite(view.scale)) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // 3D is rendered by the Mapbox map (the canvas overlay is hidden); the
    // canvas draws the editable plan only in 2D, transparently over the map.
    if (viewMode === '3d' && map3dRef.current) { ctx.clearRect(0, 0, canvas.width, canvas.height); }
    else {
      draw(ctx, {
        view, doc, result: deco, layers, dpr,
        drawing, hover, selection, size: sizeRef.current,
        showHandles: tool === 'select', measure, guides: guidesRef.current,
        stallSel, aisleSel, marquee: marqueeRef.current, sitePoly, crossings, netRoot, multiSel, shadows,
        lightField, lightGrid,
        pickArms: pickArm ? junctionArms(doc.annotations, pickArm) : null,
        // Only when asked: a checkbox, or a row the user clicked.
        driveIssues: showIssues ? driveIssues : (focusIssue >= 0 && driveIssues[focusIssue] ? [driveIssues[focusIssue]] : null),
        focusIssue: showIssues ? focusIssue : (focusIssue >= 0 ? 0 : -1),
      });
    }
    if (!drewRef.current) { drewRef.current = true; mark('ok'); }
  }, [view, doc, deco, layers, drawing, hover, selection, tool, stallSel, aisleSel, viewMode, sitePoly, measure, crossings, multiSel, driveIssues, showIssues, focusIssue, shadows, lightField, lightGrid, pickArm]);

  renderRef.current = renderNow;
  carryRidersRef.current = carryRiders;
  snapRef.current = snapOn;
  useEffect(() => { try { localStorage.setItem('pp_snap', snapOn ? 'on' : 'off'); } catch (e) {} }, [snapOn]);
  docRef.current = doc;
  vmRef.current = viewMode;
  // The map lifecycle effect finishes asynchronously, long after the render that
  // started it. Reading view/geo from refs keeps the first sync on the CURRENT
  // camera instead of the one captured when the effect ran.
  viewRef.current = view;
  geoRef.current = doc.geo;
  useEffect(() => { renderNow(); }, [renderNow]);

  // Is this tab running the build that is actually deployed? The ?v= stamp
  // busts the cache for every module, but not for index.html itself — a browser
  // holding an old copy of that loads an old app.js and silently misses
  // everything shipped since. Nothing told you that; the build id only appeared
  // inside the map diagnostics. Once, at boot, and it fails quietly: an offline
  // tab should not be nagged about something that does not matter.
  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const r = await fetch('index.html', { cache: 'no-store' });
        if (!r.ok) return;
        const m = (await r.text()).match(/app\.js\?v=([0-9a-f]+)/);
        if (!gone && m && m[1] && m[1] !== BUILD_ID) setStaleBuild(m[1]);
      } catch (e) { /* offline, or served from a file:// URL */ }
    })();
    return () => { gone = true; };
  }, []);

  // The tool options sit at the top of the left panel, but the panel keeps its
  // scroll position across renders — so after scrolling down to hunt for a
  // setting, the block appears above the fold you are no longer looking at.
  // Only on an actual tool change: this panel re-renders on every mouse move
  // while drawing, and resetting there would pin it to the top for good.
  useEffect(() => {
    const el = leftPanelRef.current;
    if (!el) return;
    if (tool !== 'annot' && tool !== 'obstacle' && tool !== 'obstaclepoly') return;
    el.scrollTop = 0;
  }, [tool, annotKind]);

  // Asset types must exist in ANNOT_TYPES before anything tries to draw them:
  // drawAnnotation bails without a sound on an unknown kind, so a document
  // loaded ahead of its registrations renders a blank spot where the objects
  // should be. This runs on every library/document change, which also covers
  // undo, redo and paste.
  useEffect(() => { assetRepaint = () => renderRef.current(); }, []);
  useEffect(() => {
    const inLib = new Set();
    assetLib.forEach((a) => { inLib.add(a.id); installAsset(a, true); });
    // Assets that arrived with a document but are not in this browser's library
    // stay drawable while staying out of the palette.
    (doc.assets || []).forEach((a) => { if (!inLib.has(a.id)) installAsset(a, false); });
    renderRef.current();
  }, [assetLib, doc.assets]);

  // The same for building styles: this browser's imports first, then anything a
  // document brought with it. Without the second half a shared plan draws its
  // warehouses as the default retail shed and nothing says why.
  useEffect(() => {
    styleLib.forEach((s) => registerBuildingStyle(s));
    (doc.buildingStyles || []).forEach((s) => { if (!BUILDING_USES[s.key]) registerBuildingStyle(s); });
    renderRef.current();
  }, [styleLib, doc.buildingStyles]);

  // A plan records the imported styles it actually uses, so it travels complete.
  useEffect(() => {
    const used = new Set((doc.obstacles || []).map((o) => (o && o.use) || DEFAULT_USE));
    const want = [...used].filter((k) => (BUILDING_USES[k] || {}).imported).map((k) => styleSpec(BUILDING_USES[k]));
    const cur = doc.buildingStyles || [];
    if (JSON.stringify(want.map((s) => s.key).sort()) === JSON.stringify(cur.map((s) => s.key).sort())) return;
    dispatch({ type: 'LIVE', updater: (d) => ({ ...d, buildingStyles: want }) });
  }, [doc.obstacles, styleLib]);

  // Snapshot of everything the 3D view draws.
  // Islands and turnarounds belong here too. They were drawn on the canvas and
  // in no export at all — a rebuilt literal that quietly dropped a field, the
  // same trap that nearly ate `use` on the buildings.
  const buildPlan = useCallback(() => ({
    site: sitePoly, obstacles: doc.obstacles,
    stalls: deco.stalls, aisles: deco.aisles, annotations: doc.annotations,
    islands: deco.islands, turnarounds: deco.turnarounds,
    // The 3D drape needs the carport clearance to know how high to hang the roof.
    params: doc.params,
  }), [sitePoly, doc.obstacles, deco, doc.annotations, doc.params]);

  // The Mapbox basemap lives for the whole session once a token is set. It sits
  // behind the canvas: flat in 2D (tracking our camera), tilted in 3D (with the
  // plan draped as GeoJSON layers).
  // Survives a style switch: the camera the previous map instance was left on.
  const mapCamRef = useRef(null);
  useEffect(() => {
    // No token or style 'Geen' → no map; the plan renders on the dark backdrop.
    if (!mbToken || mapStyle === 'none') { if (map3dRef.current) { map3dRef.current.destroy(); map3dRef.current = null; } return; }
    let cancelled = false;
    setMap3dError(''); setMapErrHidden(false);
    const container = document.getElementById('pp-map');
    if (!container) return;
    import('./map3d.js?v=c8e60896').then(async (m) => {
      if (cancelled) return;
      const onDiag = (d) => setMapDiag((prev) => ({ ...prev, ...d }));
      const ctrl = await m.initMap(container, mbToken, doc.geo, buildPlan(), (msg) => { setMap3dError(msg); if (msg) setMapErrHidden(false); }, MAP_STYLES[mapStyle], onDiag, mapCamRef.current);
      if (cancelled || !ctrl) { if (ctrl) ctrl.destroy(); return; }
      map3dRef.current = ctrl;
      ctrl.setMode(vmRef.current === '3d');
      // In 2D our canvas owns the camera, so re-aim from the app's own view. In
      // 3D Mapbox owns it and there is nothing in app state to restore from —
      // which is why the saved camera above is the only thing that can carry a
      // style switch across.
      if (vmRef.current !== '3d') { const c = mapCamFromView(viewRef.current, sizeRef.current, geoRef.current); ctrl.follow2D(c.center, c.zoom); }
      setTimeout(() => ctrl.resize(), 100);
      // map3dRef is a ref, so assigning it re-renders nothing and the follow
      // effect below would never re-run. Bump state so it syncs now rather than
      // waiting for the user to pan.
      setMapReady((n) => n + 1);
    }).catch(() => setMap3dError('Mapbox kon niet laden.'));
    return () => {
      cancelled = true;
      if (map3dRef.current) {
        // Hand the camera to whatever instance comes next, before this one goes.
        if (map3dRef.current.camera) mapCamRef.current = map3dRef.current.camera();
        map3dRef.current.destroy();
        map3dRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mbToken, mapStyle, mapNonce]);

  // Keep the flat basemap locked to our canvas camera in 2D.
  useEffect(() => {
    const ctrl = map3dRef.current;
    if (!ctrl) return;
    // The anchor converts the plan to GeoJSON, so this has to happen in BOTH
    // modes — it used to sit below the 3D early-return, which is the one case
    // its own comment was written for. A location search in 3D changed nothing
    // at all: no re-drape, no camera move, just a new number in the sidebar.
    if (ctrl.setGeo) ctrl.setGeo(doc.geo);
    if (viewMode === '3d') {
      // Only on an actual anchor change. This effect also runs on sitePoly and
      // view changes, and yanking the camera back mid-orbit would be worse than
      // the bug it fixes.
      const g = doc.geo, prev = geoAppliedRef.current;
      if (g && isFinite(g.lat) && isFinite(g.lon) && (!prev || prev.lat !== g.lat || prev.lon !== g.lon)) {
        geoAppliedRef.current = { lat: g.lat, lon: g.lon };
        if (ctrl.recenter) ctrl.recenter(g);
      }
      return;
    }
    geoAppliedRef.current = doc.geo;
    const c = mapCamFromView(view, sizeRef.current, doc.geo);
    ctrl.follow2D(c.center, c.zoom);
  }, [view, viewMode, doc.geo, sitePoly, mapReady]);

  // Drive the CSS token set off the root element and remember the choice.

  // Tilt / plan-drape on 2D↔3D switch, and keep the draped plan fresh in 3D.
  useEffect(() => { if (map3dRef.current) map3dRef.current.setMode(viewMode === '3d'); }, [viewMode]);
  // The Lagen switches drive the 3D drape too. The controller decides what that
  // means for the current mode, so the order of these two effects cannot matter.
  useEffect(() => { if (map3dRef.current && map3dRef.current.setLayers) map3dRef.current.setLayers(layers); }, [layers, viewMode, mapReady]);
  // `mapReady` matters as much as the plan itself: a map that finishes
  // initialising after the user already switched to 3D would otherwise never be
  // handed the current plan, because nothing re-runs this effect.
  useEffect(() => { if (map3dRef.current && viewMode === '3d') map3dRef.current.setPlan(buildPlan()); }, [buildPlan, viewMode, mapReady]);
  // The 3D light follows the same sun the 2D shadows use, so the two views can
  // never disagree about where it is.
  useEffect(() => {
    if (map3dRef.current && map3dRef.current.setSun) map3dRef.current.setSun(sun.azimuth, sun.altitude);
  }, [sun, mapReady, viewMode]);

  const metrics = useMemo(
    () => computeMetrics(sitePoly, doc.obstacles, deco, doc.params, doc.annotations),
    [sitePoly, doc.obstacles, deco, doc.params, doc.annotations]
  );

  // ---------- Param helpers ----------
  const setParam = (key, value, commit = true) =>
    dispatch({ type: commit ? 'COMMIT' : 'LIVE', updater: (d) => ({ ...d, params: { ...d.params, [key]: value } }) });
  const setAutoParking = (v) => dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, autoParking: v }) });
  const setMix = (key, value) => dispatch({ type: 'COMMIT', updater: (d) => {
    const cur = d.params.mix || { compact: d.params.compactRatio || 0, ev: d.params.evRatio || 0, staff: 0, visitor: 0, reserved: 0 };
    return { ...d, params: { ...d.params, mix: { ...cur, [key]: value } } };
  } });

  const applyPreset = (key) => {
    const p = PRESETS[key];
    if (!p) return;
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, params: { ...d.params, stallWidth: p.stallWidth, stallDepth: p.stallDepth, aisleWidth: p.aisleWidth } }) });
  };

  // ---------- Pointer interactions ----------
  const getWorld = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const sp = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return makeTransform(view).s2w(sp);
  };
  const getScreen = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Snap a screen point to the nearest existing vertex (infrastructure,
  // site, obstacles) within ~11px; otherwise return the plain world point.
  const snapPoint = (sp) => {
    const { w2s, s2w } = makeTransform(view);
    // Off means off: the point goes exactly where the cursor is, not onto a
    // quarter-metre grid and not onto a neighbour.
    if (!snapRef.current) return s2w(sp);
    let best = null, bestD = 11;
    const consider = (pt) => { const d = dist(w2s(pt), sp); if (d < bestD) { bestD = d; best = pt; } };
    (doc.annotations || []).forEach((a) => (a.points || []).forEach(consider));
    (doc.site || []).forEach(consider);
    (doc.obstacles || []).forEach((o) => polyOf(o).forEach(consider));
    return best ? { x: best.x, y: best.y } : s2w(sp);
  };

  // Constrain a segment (prev → wp) to the nearest 15° increment, keeping its
  // length — used while a modifier key is held during drawing.
  const angleSnap = (prev, wp) => {
    const dx = wp.x - prev.x, dy = wp.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { x: wp.x, y: wp.y };
    const ang = Math.round(Math.atan2(dy, dx) / ANGLE_SNAP) * ANGLE_SNAP;
    return { x: prev.x + Math.cos(ang) * len, y: prev.y + Math.sin(ang) * len };
  };
  // Point for the in-progress line: vertex-snap by default, or angle-snap from
  // the previous vertex while Shift is held.
  const drawPoint = (sp, useAngle) => {
    const pts = drawing && drawing.points;
    const prev = pts && pts.length ? pts[pts.length - 1] : null;
    if (useAngle && prev) return angleSnap(prev, makeTransform(view).s2w(sp));
    return snapPoint(sp);
  };

  // Closest point on the site boundary (for placing access points).
  const nearestOnSiteEdge = (wp) => {
    const site = doc.site;
    if (!site || site.length < 2) return wp;
    let best = wp, bestD = Infinity;
    for (let i = 0; i < site.length; i++) {
      const a = site[i], b = site[(i + 1) % site.length];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      let t = len2 ? ((wp.x - a.x) * dx + (wp.y - a.y) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx, py = a.y + t * dy, d = Math.hypot(wp.x - px, wp.y - py);
      if (d < bestD) { bestD = d; best = { x: px, y: py }; }
    }
    return best;
  };

  // ---------- Override actions (manual marks) ----------
  const ovOf = (d) => {
    const o = d.overrides || {}, l = o.locks || {};
    return {
      stalls: { ...o.stalls }, aisles: { ...o.aisles },
      locks: { stalls: { ...l.stalls }, aisles: { ...l.aisles } },
      removed: { ...o.removed }, angles: { ...o.angles },
      aislesRemoved: { ...o.aislesRemoved },
    };
  };
  const setStallTypes = (keys, type) => dispatch({ type: 'COMMIT', updater: (d) => {
    const ov = ovOf(d);
    for (const k of keys) {
      if (type === null) { if (!ov.locks.stalls[k]) delete ov.stalls[k]; } // keep locked marks
      else ov.stalls[k] = type;
    }
    return { ...d, overrides: ov };
  } });
  // Per-stall angle override (null = back to the solver's angle).
  const setStallAngles = (keys, deg) => dispatch({ type: 'COMMIT', updater: (d) => {
    const ov = ovOf(d);
    for (const k of keys) { if (deg == null) delete ov.angles[k]; else ov.angles[k] = deg; }
    return { ...d, overrides: ov };
  } });
  const toggleLockStalls = (keys, lock) => dispatch({ type: 'COMMIT', updater: (d) => {
    const ov = ovOf(d);
    for (const k of keys) { if (lock) ov.locks.stalls[k] = 1; else delete ov.locks.stalls[k]; }
    return { ...d, overrides: ov };
  } });
  const toggleLockAisle = (key, lock) => dispatch({ type: 'COMMIT', updater: (d) => {
    const ov = ovOf(d);
    if (lock) ov.locks.aisles[key] = 1; else delete ov.locks.aisles[key];
    return { ...d, overrides: ov };
  } });
  const setAisleOneway = (key, oneway) => dispatch({ type: 'COMMIT', updater: (d) => {
    const ov = ovOf(d);
    ov.aisles[key] = { ...(ov.aisles[key] || { dir: 1 }), oneway };
    return { ...d, overrides: ov };
  } });
  const flipAisle = (key) => dispatch({ type: 'COMMIT', updater: (d) => {
    const ov = ovOf(d);
    const cur = ov.aisles[key] || { oneway: true, dir: 1 };
    ov.aisles[key] = { ...cur, oneway: true, dir: (cur.dir || 1) * -1 };
    return { ...d, overrides: ov };
  } });
  // Solver aisles have no stored identity, so removal is a position-keyed mark
  // like every other override — it survives a re-solve, and undo puts it back.
  const deleteAisle = (key) => {
    if (!key) return;
    dispatch({ type: 'COMMIT', updater: (d) => {
      const ov = ovOf(d);
      ov.aislesRemoved[key] = 1;
      delete ov.locks.aisles[key];
      return { ...d, overrides: ov };
    } });
    setAisleSel(null);
  };
  const restoreAisles = () => dispatch({ type: 'COMMIT', updater: (d) => {
    const ov = ovOf(d);
    ov.aislesRemoved = {};
    return { ...d, overrides: ov };
  } });
  const clearSel = () => { setStallSel([]); setAisleSel(null); setSelection(null); setMultiSel({ anns: [], obs: [] }); };

  // ---------- Manual stall placement + delete ----------
  const stallAt = (center, theta) => {
    const w = doc.params.stallWidth, d = doc.params.stallDepth;
    const c = Math.cos(theta), s = Math.sin(theta);
    const ux = c, uy = s, vx = -s, vy = c, hw = w / 2, hd = d / 2;
    return [
      { x: center.x - ux * hw - vx * hd, y: center.y - uy * hw - vy * hd },
      { x: center.x + ux * hw - vx * hd, y: center.y + uy * hw - vy * hd },
      { x: center.x + ux * hw + vx * hd, y: center.y + uy * hw + vy * hd },
      { x: center.x - ux * hw + vx * hd, y: center.y - uy * hw + vy * hd },
    ];
  };
  // Snap a click to the lattice of the nearest existing stall (so hand-placed
  // stalls tile next to solver stalls); otherwise a coarse metric grid.
  // Drivable lines a stall can park against, sampled the way they are drawn so
  // snapping follows the visible curve rather than the control points.
  // Where the drivable ways actually run, for snapping stalls and orienting
  // markings. The centreline comes from drive.js so there is exactly one answer
  // to "where is the middle of this road" — this used to be a second, simpler
  // rule that read an object road's four corners as a centreline and made a
  // stall cling to the outline instead of lying alongside it.
  const roadLines = useMemo(() => (doc.annotations || [])
    .filter((a) => {
      const t = ANNOT_TYPES[a.kind];
      return t && t.blocks && a.points && a.points.length >= 2
        && (t.mode === 'line' || a.shape === 'object');
    })
    .map((a) => {
      const c = centrelineOf({ ann: a });
      if (!c || c.pts.length < 2) return null;
      const pts = a.shape === 'object' ? c.pts : tessellateOpen(c.pts, !!a.curved);
      const cum = polylineCum(pts);
      return { pts, cum, len: cum[cum.length - 1], half: c.width / 2 };
    })
    .filter((l) => l && l.len > 0.1), [doc.annotations]);

  // Heading of the nearest road at a point, in degrees, for orienting markings.
  // 0 when there is no road nearby — an arrow then points up until you press R.
  const roadAngleAt = (pt) => {
    let best = null;
    for (const line of roadLines) {
      const hit = nearestOnPolyline(pt, line.pts, line.cum);
      if (hit && (!best || hit.dd < best.hit.dd)) best = { line, hit };
    }
    if (!best || best.hit.dd > best.line.half + 25) return 0;
    const at = polylineAt(best.line.pts, best.line.cum, best.hit.s);
    // Painters draw pointing "up" (-y), so rotate the tangent by a quarter turn.
    return (Math.atan2(at.ty, at.tx) * 180) / Math.PI + 90;
  };

  /**
   * Park a stall against the nearest road: aligned to the road's tangent, offset
   * clear of its edge on the side that was clicked, and slotted to whole stall
   * widths along the road so neighbours abut exactly. Null when no road is near.
   */
  const snapStallToRoad = (click) => {
    const w = doc.params.stallWidth, d = doc.params.stallDepth;
    let best = null;
    for (const line of roadLines) {
      const hit = nearestOnPolyline(click, line.pts, line.cum);
      if (hit && (!best || hit.dd < best.hit.dd)) best = { line, hit };
    }
    if (!best) return null;
    if (best.hit.dd > best.line.half + d * 1.75) return null;
    const slotted = (Math.floor(best.hit.s / w) + 0.5) * w;
    const s = Math.min(Math.max(slotted, w / 2), Math.max(w / 2, best.line.len - w / 2));
    const at = polylineAt(best.line.pts, best.line.cum, s);
    const nx = -at.ty, ny = at.tx;
    const side = (click.x - at.x) * nx + (click.y - at.y) * ny >= 0 ? 1 : -1;
    const off = best.line.half + d / 2;
    return {
      center: { x: at.x + nx * side * off, y: at.y + ny * side * off },
      theta: Math.atan2(at.ty, at.tx),
      onRoad: true,
    };
  };

  // Road snap wins; otherwise fall back to the neighbouring-stall lattice.
  const snapStall = (click) => {
    // With snapping off the stall goes exactly where you clicked, at whatever
    // rotation R has set — no road, no lattice, no rounding.
    if (!snapRef.current) return { center: { x: click.x, y: click.y }, theta: (stallRot * Math.PI) / 180, onRoad: false };
    const r = snapStallToRoad(click);
    const base = r || { center: snapStallCenter(click), theta: result.angleUsed || 0, onRoad: false };
    return { ...base, theta: base.theta + (stallRot * Math.PI) / 180 };
  };

  const snapStallCenter = (click) => {
    const theta = result.angleUsed || 0;
    const w = doc.params.stallWidth, d = doc.params.stallDepth;
    const ux = Math.cos(theta), uy = Math.sin(theta), vx = -Math.sin(theta), vy = Math.cos(theta);
    let best = null, bestD = Infinity;
    for (const st of deco.stalls) { const ct = polygonCentroid(st.poly); const dd = dist(ct, click); if (dd < bestD) { bestD = dd; best = ct; } }
    if (best && bestD < 3 * Math.max(w, d)) {
      const dx = click.x - best.x, dy = click.y - best.y;
      const su = Math.round((dx * ux + dy * uy) / w) * w;
      const sv = Math.round((dx * vx + dy * vy) / d) * d;
      return { x: best.x + su * ux + sv * vx, y: best.y + su * uy + sv * vy };
    }
    return { x: Math.round(click.x * 4) / 4, y: Math.round(click.y * 4) / 4 };
  };
  const addManualStall = (poly) =>
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, manualStalls: [...(d.manualStalls || []), { poly, type: 'standard' }] }) });
  const deleteStalls = (keys) => dispatch({ type: 'COMMIT', updater: (d) => {
    const manualKeys = new Set((d.manualStalls || []).map((ms) => stallKey(ms.poly)));
    const keep = (d.manualStalls || []).filter((ms) => !keys.includes(stallKey(ms.poly)));
    const ov = ovOf(d);
    for (const k of keys) { if (!manualKeys.has(k)) ov.removed[k] = 1; }
    return { ...d, manualStalls: keep, overrides: ov };
  } });

  // ---------- Annotation (infrastructure) actions ----------
  // A placed asset carries its own definition into the document, so a saved
  // plan still draws on a machine whose asset library has never seen it.
  const embedAssets = (d, anns) => {
    const have = new Set((d.assets || []).map((a) => a.id));
    const add = [];
    for (const an of anns || []) {
      const id = assetIdOf(an && an.kind);
      if (!id || have.has(id)) continue;
      const t = ANNOT_TYPES[an.kind];
      if (t && t.asset) { have.add(id); add.push(t.asset); }
    }
    return add.length ? { ...d, assets: [...(d.assets || []), ...add] } : d;
  };
  const addAnnotation = (ann) =>
    dispatch({ type: 'COMMIT', updater: (d) => embedAssets({ ...d, annotations: [...(d.annotations || []), ann] }, [ann]) });
  // selection is {type, index} against a live array, so removing an entry has
  // to move the selection with it — otherwise the inspector silently starts
  // showing a different object.
  const reindexAfterDelete = (type, removed) => setSelection((cur) => {
    if (!cur || cur.type !== type) return cur;
    if (cur.index === removed) return null;
    return cur.index > removed ? { ...cur, index: cur.index - 1 } : cur;
  });
  const deleteAnnotation = (index) => {
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, annotations: (d.annotations || []).filter((_, i) => i !== index) }) });
    reindexAfterDelete('annot', index);
  };
  // Removing a whole junction network at once. Doing it one index at a time
  // would shift the indices under the remaining ones.
  const deleteAnnotations = (indices) => {
    const kill = new Set(indices);
    if (!kill.size) return;
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, annotations: (d.annotations || []).filter((_, i) => !kill.has(i)) }) });
    setSelection((cur) => (cur && cur.type === 'annot' ? null : cur));
  };
  // Every branch of the junction network a way belongs to, itself included. An
  // unjoined way is its own network of one, so callers never have to branch.
  // Through the ref because the pointer handlers run outside this render.
  const netIndices = (index) => {
    const roots = netRootRef.current || [];
    if (roots[index] == null) return [index];
    const out = [];
    roots.forEach((r, i) => { if (r === roots[index]) out.push(i); });
    return out.length ? out : [index];
  };
  const deleteObstacle = (index) => {
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: d.obstacles.filter((_, i) => i !== index) }) });
    reindexAfterDelete('obs', index);
  };
  // Resize a driveway in place: rebuild its rectangle from the stored edge frame.
  const setDrivewayWidth = (index, width) => dispatch({ type: 'COMMIT', updater: (d) => {
    const anns = (d.annotations || []).slice();
    const a = anns[index];
    if (!a || a.kind !== 'driveway') return d;
    anns[index] = makeDriveway({ point: a.anchor, tx: a.tx, ty: a.ty, nx: a.nx, ny: a.ny }, width, a.depth || 12);
    return { ...d, annotations: anns };
  } });
  // Generic per-annotation patch. Everything before this had to hand-roll its
  // own updater, so only driveway width and drive-thru radius were editable.
  const updateAnnotation = (index, patch) => dispatch({ type: 'COMMIT', updater: (d) => {
    const anns = (d.annotations || []).slice();
    if (!anns[index]) return d;
    anns[index] = { ...anns[index], ...patch };
    return { ...d, annotations: anns };
  } });
  const setDrivethruTurnR = (index, R) => dispatch({ type: 'COMMIT', updater: (d) => {
    const anns = (d.annotations || []).slice();
    if (!anns[index] || anns[index].kind !== 'drivethru') return d;
    anns[index] = { ...anns[index], turnR: R };
    return { ...d, annotations: anns };
  } });
  const startAnnot = (kind, value) => {
    const t = ANNOT_TYPES[kind];
    setAnnotKind(kind);
    setAnnotWidth(t.width || 2);
    setAnnotCurved(!!t.curved);
    setAnnotValue(t.value == null ? null : (value == null ? t.value : value));
    setTool('annot'); setDrawing(null); clearSel();
  };
  const finishAnnotLine = (points, closed = false) => {
    const t = ANNOT_TYPES[annotKind];
    // The double-click that ends a line lands on top of the last click, so the
    // final point arrives two or three times. Those zero-length segments break
    // tangent and arc-length maths downstream (snapping, point editing).
    points = (points || []).filter((p, i, a) => i === 0 || dist(p, a[i - 1]) > 1e-6);
    if (points.length >= (closed ? 3 : 2)) {
      addAnnotation({
        kind: annotKind, points, width: annotWidth,
        curved: t.mode === 'line' && !closed ? annotCurved : false,
        closed: !!closed,
        ...(t.body && !closed && annotAlign !== 'center' ? { align: annotAlign } : {}),
      });
    }
    setDrawing(null);
  };
  // Finish an area drawn as a free polygon (grass/fietsparking via points).
  const finishAreaPoly = (points) => {
    if (points && points.length >= 3) addAnnotation({ kind: annotKind, points: points.slice(), closed: true, width: 0 });
    setDrawing(null);
  };

  // Nearest annotation to a screen point (for selection), or -1.
  // Same radius test as hitAnnotation, restricted to point-mode kinds.
  const hitPointAnnotation = (sp) => {
    const { w2s } = makeTransform(view);
    const anns = doc.annotations || [];
    for (let i = anns.length - 1; i >= 0; i--) {
      const ann = anns[i], t = ANNOT_TYPES[ann.kind];
      if (!t || t.mode !== 'point' || !ann.points || !ann.points[0]) continue;
      if (dist(w2s(ann.points[0]), sp) < Math.max(9, ((ann.width || t.width || 5) / 2) * view.scale)) return i;
    }
    return -1;
  };

  // What is sitting on this carriageway. There is no stored link between a sign
  // and the road it was snapped to — the snap only set an angle — so the only
  // honest answer is geometric: anything whose position lies on the asphalt,
  // plus a metre of tolerance for things placed against the kerb.
  const ridersOn = (ann, index) => {
    const t = ANNOT_TYPES[ann.kind] || {};
    if (!t.body || ann.closed) return null;
    const body = ribbon(ann, t);
    if (!body || body.length < 3) return null;
    const grown = offsetPolygon(body, 1) || body;
    const inside = (p) => pointInPolygon(p, grown);
    const anns = [];
    (doc.annotations || []).forEach((o, i) => {
      if (i === index || !o.points || !o.points.length) return;
      // Every point has to be on the road, or a long road crossing this one
      // would be dragged along by its single overlapping end.
      if (o.points.every(inside)) anns.push({ i, orig: o.points, anchor: o.anchor });
    });
    const stalls = [];
    (doc.manualStalls || []).forEach((ms, i) => {
      if (ms && ms.poly && inside(polygonCentroid(ms.poly))) stalls.push({ i, orig: ms.poly });
    });
    return anns.length || stalls.length ? { anns, stalls } : null;
  };

  const hitAnnotation = (sp) => {
    const { w2s } = makeTransform(view);
    const anns = doc.annotations || [];
    for (let i = anns.length - 1; i >= 0; i--) {
      const ann = anns[i];
      const t = ANNOT_TYPES[ann.kind];
      if (!t || !ann.points || ann.points.length < 1) continue;
      if (t.mode === 'point') {
        if (dist(w2s(ann.points[0]), sp) < Math.max(8, ((ann.width || 5) / 2) * view.scale)) return i;
        continue;
      }
      if (ann.points.length < 2) continue;
      const pts = ann.points.map(w2s);
      const tol = Math.max(6, ((ann.width || 1) * view.scale) / 2 + 4);
      // A carriageway can sit entirely to one side of the line it was drawn
      // from, so hit the asphalt, not the line.
      if (t.body && !ann.closed) {
        const body = ribbon(ann, t);
        if (body && pointInPolygon(makeTransform(view).s2w(sp), body)) return i;
      }
      if (t.mode === 'area' || ann.closed) {
        if (pointInPolygon(makeTransform(view).s2w(sp), ann.points)) return i;
        if (t.mode === 'area') continue;
      }
      for (let s = 0; s < pts.length - 1; s++) {
        if (distPointSegment(sp, pts[s], pts[s + 1]) < tol) return i;
      }
    }
    return -1;
  };

  // Is the screen point near the site's boundary line (not a vertex)?
  const hitSiteEdge = (sp) => {
    if (!sitePoly || sitePoly.length < 2) return false;
    const { w2s } = makeTransform(view);
    for (let i = 0; i < sitePoly.length; i++) {
      const a = w2s(sitePoly[i]), b = w2s(sitePoly[(i + 1) % sitePoly.length]);
      if (distPointSegment(sp, a, b) < 7) return true;
    }
    return false;
  };

  const hitVertex = (sp) => {
    const { w2s } = makeTransform(view);
    for (let i = 0; i < doc.site.length; i++)
      if (dist(w2s(doc.site[i]), sp) < 9) return { type: 'site', index: i };
    for (let oi = 0; oi < doc.obstacles.length; oi++) {
      const op = polyOf(doc.obstacles[oi]);
      for (let vi = 0; vi < op.length; vi++)
        if (dist(w2s(op[vi]), sp) < 9) return { type: 'obsV', obs: oi, index: vi };
    }
    // Handles on the selected annotation. A driveway keeps its edge-frame shape
    // and a road object its rectangle, so instead of four loose corners the
    // object offers a length grip per end and a rotate grip beside it — dragging
    // a parameter, not a point.
    if (selection && selection.type === 'annot') {
      const a = (doc.annotations || [])[selection.index];
      if (isRoadObject(a)) {
        for (const g of roadRectGrips(a)) {
          if (dist(w2s(g.at), sp) < 10) {
            return g.kind === 'rot'
              ? { type: 'annRot', ann: selection.index }
              : { type: 'annLen', ann: selection.index, end: g.end };
          }
        }
      } else if (a && a.kind !== 'driveway' && a.points) {
        for (let vi = 0; vi < a.points.length; vi++)
          if (dist(w2s(a.points[vi]), sp) < 9) return { type: 'annV', ann: selection.index, index: vi };
      }
    }
    return null;
  };

  // What a Shift+click means, in the same priority order a plain click uses:
  // small point markings first, then stalls, then ways, then buildings.
  const toggleUnderCursor = (sp, wp) => {
    const toggleAnn = (i) => {
      setMultiSel((cur) => ({ ...cur, anns: cur.anns.includes(i) ? cur.anns.filter((x) => x !== i) : [...cur.anns, i] }));
      setSelection(null); setAisleSel(null);
    };
    const pi = hitPointAnnotation(sp);
    if (pi >= 0) return toggleAnn(pi);
    for (let i = deco.stalls.length - 1; i >= 0; i--) {
      if (pointInPolygon(wp, deco.stalls[i].poly)) {
        const key = deco.stalls[i].key;
        setSelection(null); setAisleSel(null);
        setStallSel((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
        return;
      }
    }
    const ai = hitAnnotation(sp);
    if (ai >= 0) return toggleAnn(ai);
    for (let i = doc.obstacles.length - 1; i >= 0; i--) {
      if (pointInPolygon(wp, polyOf(doc.obstacles[i]))) {
        setMultiSel((cur) => ({ ...cur, obs: cur.obs.includes(i) ? cur.obs.filter((x) => x !== i) : [...cur.obs, i] }));
        setSelection(null); setAisleSel(null);
        return;
      }
    }
  };

  const onPointerDown = (e) => {
    if (viewMode !== '2d') return; // 3D is handled by the Mapbox map (canvas is pass-through)
    // While a group hangs off the cursor a click only ever drops it. The right
    // button puts it back — the same escape hatch as Escape, within reach of
    // the hand that is already on the mouse.
    if (placingRef.current && !placingRef.current.drag) {
      if (e.button === 2) cancelPlacing(); else dropPlacing();
      return;
    }
    // A throw here used to abort the whole handler before dragRef was set, so
    // the drag silently did nothing — including the grid.
    try { e.target.setPointerCapture?.(e.pointerId); } catch (err) {}
    const sp = getScreen(e);
    const wp = getWorld(e);

    // Right-drag pans, on any mouse, in any tool, with no modifier. A right
    // *click* that never moves still adds a vertex (onContextMenu), so the two
    // do not collide — and Shift stays free for additive selection.
    if (e.button === 2) {
      dragRef.current = { mode: 'pan', start: sp, view: { ...view }, right: true, moved: false };
      return;
    }

    // Middle button or the Pan tool → pan.
    if (e.button === 1 || tool === 'pan') {
      dragRef.current = { mode: 'pan', start: sp, view: { ...view } };
      return;
    }

    if (tool === 'measure') {
      const pts = (measure && measure.points) || [];
      const at = e.shiftKey && pts.length ? angleSnap(pts[pts.length - 1], wp) : snapPoint(sp);
      setMeasure({ points: [...pts, at] });
      return;
    }
    if (tool === 'placestall') {
      const s = snapStall(wp);
      addManualStall(stallAt(s.center, s.theta));
      return;
    }

    if (tool === 'select') {
      // Shift+drag always draws a selection box, wherever it starts. Without
      // this the box could only begin on bare ground, which on a full site is
      // nowhere — and a box you cannot start is a box you do not have. A
      // Shift+click that never travels still toggles whatever is under it, so
      // the old additive click keeps working; that is decided on release.
      if (e.button === 0 && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        marqueeRef.current = { x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y };
        dragRef.current = { mode: 'marquee', add: true, at: sp, atWorld: wp };
        return;
      }
      // A whole group picked → dragging any member moves all of it. Without
      // this the panel would say five objects while the drag moved one.
      if (multiCount > 1 && e.button === 0 && !(e.shiftKey || e.metaKey || e.ctrlKey)) {
        const onAnn = multiSel.anns.some((i) => {
          const a = (doc.annotations || [])[i];
          return a && a.points && (pointInPolygon(wp, a.closed ? a.points : (annotationBlocker(a) || [])) || a.points.some((q) => dist(makeTransform(view).w2s(q), sp) < 10));
        });
        const onObs = multiSel.obs.some((i) => doc.obstacles[i] && pointInPolygon(wp, polyOf(doc.obstacles[i])));
        const onStall = stallSel.some((k) => { const st = deco.stalls.find((x) => x.key === k); return st && pointInPolygon(wp, st.poly); });
        if (onAnn || onObs || onStall) {
          dispatch({ type: 'CHECKPOINT' });
          placingRef.current = {
            drag: true,
            anns: multiSel.anns.filter((i) => (doc.annotations || [])[i]).map((i) => ({ i, pts: doc.annotations[i].points, anchor: doc.annotations[i].anchor })),
            obs: multiSel.obs.filter((i) => doc.obstacles[i]).map((i) => ({ i, pts: polyOf(doc.obstacles[i]) })),
            stalls: [],
            start: wp,
          };
          dragRef.current = { mode: 'group' };
          return;
        }
      }
      // A red crossing is a question, so clicking it asks again. Tested first:
      // it sits on top of the tarmac it is marking.
      const { w2s: w2sJ } = makeTransform(view);
      const askHit = crossings.find((c) => c.mode !== 'merged' && c.mode !== 'break' && dist(w2sJ(c.at), sp) < 12);
      if (pickArm) {
        // Nearest arm to the click, measured at the stub the plan is showing.
        const arms = junctionArms(doc.annotations, pickArm);
        let best = null, bestD = Infinity;
        for (const arm of arms) {
          const tip = { x: arm.at.x + arm.ux * Math.min(arm.run, 10), y: arm.at.y + arm.uy * Math.min(arm.run, 10) };
          const d = distPointSegment(wp, arm.at, tip);
          if (d < bestD) { bestD = d; best = arm; }
        }
        if (best && bestD < Math.max(4, best.width)) setJunction(pickArm, 'break', null, best.heading);
        setPickArm(null);
        return;
      }
      if (askHit) { setAskJunction(askHit); return; }
      const v = hitVertex(sp);
      // CHECKPOINT here, not COMMIT on pointer-up: an identity updater is a
      // no-op in the reducer, so a reshape used not to be its own undo step.
      if (v) { dispatch({ type: 'CHECKPOINT' }); dragRef.current = { mode: 'vertex', target: v }; return; }
      // Site boundary → select the whole site; drag the border to move it.
      if (hitSiteEdge(sp)) {
        setSelection({ type: 'site' }); setStallSel([]); setAisleSel(null);
        dispatch({ type: 'CHECKPOINT' });
        dragRef.current = { mode: 'siteMove', start: wp, orig: doc.site };
        return;
      }
      // Point markings and signs first: they are small targets deliberately
      // placed on top of stalls and aisles, so testing stalls first would make
      // them unselectable.
      const pi = hitPointAnnotation(sp);
      if (pi >= 0) {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          setMultiSel((cur) => ({ ...cur, anns: cur.anns.includes(pi) ? cur.anns.filter((x) => x !== pi) : [...cur.anns, pi] }));
          setSelection(null); setAisleSel(null);
          return;
        }
        setSelection({ type: 'annot', index: pi }); setStallSel([]); setAisleSel(null); setMultiSel({ anns: [], obs: [] });
        const pa = (doc.annotations || [])[pi];
        dispatch({ type: 'CHECKPOINT' });
        dragRef.current = { mode: 'annotMove', start: wp, index: pi, orig: pa.points, origAnchor: pa.anchor };
        return;
      }
      // Stall? (topmost first) — click selects, shift+click toggles, drag moves.
      for (let i = deco.stalls.length - 1; i >= 0; i--) {
        if (pointInPolygon(wp, deco.stalls[i].poly)) {
          const key = deco.stalls[i].key;
          setSelection(null); setAisleSel(null);
          const multi = e.shiftKey || e.metaKey || e.ctrlKey;
          const keys = multi
            ? (stallSel.includes(key) ? stallSel.filter((k) => k !== key) : [...stallSel, key])
            : (stallSel.includes(key) ? stallSel : [key]);
          setStallSel(keys);
          if (!multi) {
            // Solver stalls have no stored position, and stallKey is centroid-
            // based, so moving one would be undone by the next solve. Convert
            // it to a hand-placed stall first (the user's chosen behaviour).
            const moving = keys.map((k) => deco.stalls.find((s) => s.key === k)).filter(Boolean);
            if (moving.length) {
              dispatch({ type: 'CHECKPOINT' });
              const solverOnes = moving.filter((s) => !s.manual);
              const added = solverOnes.map((s) => ({ poly: s.poly.map((p) => ({ ...p })), type: s.type }));
              // Snapshot the post-conversion array and the indices this drag
              // owns. Keys are centroid-based and change as the stall moves, so
              // indices are the only stable handle mid-drag.
              const baseManual = [...(doc.manualStalls || []), ...added];
              const movingKeys = new Set(moving.map((s) => s.key));
              const idxs = baseManual.reduce((acc, ms, i) => (movingKeys.has(stallKey(ms.poly)) ? [...acc, i] : acc), []);
              if (solverOnes.length) {
                dispatch({ type: 'LIVE', updater: (d) => {
                  const ov = ovOf(d);
                  for (const s of solverOnes) ov.removed[s.key] = 1;
                  return { ...d, overrides: ov, manualStalls: baseManual };
                } });
              }
              dragRef.current = { mode: 'stallMove', start: wp, baseManual, idxs };
            }
          }
          return;
        }
      }
      // Infrastructure annotation (checked before aisles so a lane drawn over
      // a drive aisle is still selectable)?
      const ai = hitAnnotation(sp);
      if (ai >= 0) {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          setMultiSel((cur) => ({ ...cur, anns: cur.anns.includes(ai) ? cur.anns.filter((x) => x !== ai) : [...cur.anns, ai] }));
          setSelection(null); setAisleSel(null);
          return;
        }
        setSelection({ type: 'annot', index: ai }); setStallSel([]); setAisleSel(null); setMultiSel({ anns: [], obs: [] });
        const a = (doc.annotations || [])[ai];
        if (a && a.points) {
          dispatch({ type: 'CHECKPOINT' });
          dragRef.current = {
            mode: 'annotMove', start: wp, index: ai, orig: a.points, origAnchor: a.anchor,
            // Gathered at pointer-down so Alt can be pressed and released mid
            // drag and the riders follow live.
            riders: ridersOn(a, ai),
            // The other branches of the junction network. Unlike the riders
            // these are not optional: a junction is one object.
            mates: netIndices(ai).filter((i) => i !== ai)
              .map((i) => ({ i, orig: doc.annotations[i].points, anchor: doc.annotations[i].anchor })),
            // Junction decisions are keyed on position, so a rigid move of the
            // whole network would otherwise leave every one of its crossings
            // behind and ask about them again. Both arms travel together here,
            // so the crossing travels with them — carry the keys along.
            junc: doc.junctions || {},
            juncAt: (() => {
              const set = new Set(netIndices(ai));
              return crossings.filter((c) => set.has(c.i) && set.has(c.j) && c.mode).map((c) => ({ key: c.key, at: c.at }));
            })(),
          };
        }
        return;
      }
      // Aisle?
      for (let i = deco.aisles.length - 1; i >= 0; i--) {
        if (pointInPolygon(wp, deco.aisles[i].poly)) {
          setSelection(null); setStallSel([]); setAisleSel(deco.aisles[i].key);
          return;
        }
      }
      // Obstacle interior? — click selects, drag moves.
      for (let i = doc.obstacles.length - 1; i >= 0; i--) {
        if (pointInPolygon(wp, polyOf(doc.obstacles[i]))) {
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            setMultiSel((cur) => ({ ...cur, obs: cur.obs.includes(i) ? cur.obs.filter((x) => x !== i) : [...cur.obs, i] }));
            setSelection(null); setAisleSel(null);
            return;
          }
          setSelection({ type: 'obs', index: i }); setStallSel([]); setAisleSel(null); setMultiSel({ anns: [], obs: [] });
          dispatch({ type: 'CHECKPOINT' });
          dragRef.current = { mode: 'obsMove', start: wp, index: i, orig: polyOf(doc.obstacles[i]) };
          return;
        }
      }
      // Empty space → marquee-select stalls (drag a box).
      const addSel = e.shiftKey || e.metaKey || e.ctrlKey;
      if (!addSel) { setSelection(null); setStallSel([]); setAisleSel(null); setMultiSel({ anns: [], obs: [] }); }
      marqueeRef.current = { x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y };
      dragRef.current = { mode: 'marquee', add: addSel };
      return;
    }

    if (tool === 'site') {
      const first = drawing && drawing.points[0];
      const { w2s } = makeTransform(view);
      if (first && drawing.points.length >= 3 && dist(w2s(first), sp) < 12) {
        commitSite(drawing.points); setDrawing(null); setTool('select'); return;
      }
      const pt = drawPoint(sp, e.shiftKey);
      setDrawing((d) => ({ points: [...(d ? d.points : []), pt] }));
      return;
    }

    if (tool === 'obstacle') {
      dragRef.current = { mode: 'rect', start: wp, cur: wp };
      return;
    }

    if (tool === 'obstaclepoly') {
      const first = drawing && drawing.points[0];
      const { w2s } = makeTransform(view);
      if (first && drawing.points.length >= 3 && dist(w2s(first), sp) < 12) {
        commitObstaclePoly(drawing.points); setDrawing(null); setTool('select'); return;
      }
      const pt = drawPoint(sp, e.shiftKey);
      setDrawing((d) => ({ points: [...(d ? d.points : []), pt] }));
      return;
    }

    if (tool === 'annot') {
      const t = ANNOT_TYPES[annotKind];
      const snap = snapPoint(sp);
      if (t.mode === 'driveway') {
        if (!sitePoly || sitePoly.length < 3) return;
        const frame = siteEdgeFrame(wp, sitePoly, polygonCentroid(sitePoly));
        if (frame) addAnnotation(makeDriveway(frame, annotWidth, t.depth || 12));
        return;
      }
      if (t.mode === 'point') {
        const at = annotKind === 'access' ? nearestOnSiteEdge(wp) : snap;
        const ann = { kind: annotKind, points: [at], width: annotWidth };
        // Carry the number chosen in the library, so a run of 30-signs does not
        // have to be corrected one at a time after the fact.
        if (t.value != null && annotValue != null) ann.value = annotValue;
        // Markings and signs read along the road they belong to, so line them
        // up with the nearest one. R adjusts from there.
        if (t.picto) ann.angle = (roadAngleAt(wp) + stallRot) % 360;
        addAnnotation(ann);
        return;
      }
      // A road drawn as an object is placed with one click at a fixed size and
      // reshaped afterwards — by its fields or by its grips. Same two-call
      // symmetry as the driveway above: the preview builds the real object and
      // the click stores that same object. It used to be a rectangle you dragged
      // out, which left it with four loose corners and no width at all, so
      // nothing downstream could find its centreline.
      // Multipoint: a free-form road surface. Points clicked like a polygon, and
      // it closes into a shape rather than a ribbon of fixed width — what it IS
      // is decided by its material, not by being called a road.
      if (annotKind === 'road' && roadShape === 'multi') {
        const first = drawing && drawing.points[0];
        const { w2s: w2sM } = makeTransform(view);
        if (first && drawing.points.length >= 3 && dist(w2sM(first), sp) < 12) {
          addAnnotation({ kind: 'road', shape: 'multi', points: drawing.points, closed: true, width: 0, material: annotMaterial || 'asphalt' });
          setDrawing(null); setTool('select'); return;
        }
        setDrawing((d) => ({ points: [...(d ? d.points : []), snap] }));
        return;
      }
      if (annotKind === 'road' && roadShape === 'rect') {
        addAnnotation(makeRoadRect(snap, annotWidth, annotLength, (annotRot * Math.PI) / 180));
        setSelection({ type: 'annot', index: (doc.annotations || []).length });
        setTool('select');
        return;
      }
      if (t.mode === 'area') {
        if (areaShape === 'rect') { dragRef.current = { mode: 'annotArea', start: snap, cur: snap }; return; }
        if (areaShape === 'circle') { dragRef.current = { mode: 'annotCircle', center: snap, cur: snap }; return; }
        // polygon by points: click points, close on the first point / double-click
        const f0 = drawing && drawing.points[0];
        const { w2s: w2sA } = makeTransform(view);
        if (f0 && drawing.points.length >= 3 && dist(w2sA(f0), sp) < 12) { finishAreaPoly(drawing.points); return; }
        setDrawing({ points: [...((drawing && drawing.points) || []), drawPoint(sp, e.shiftKey)] });
        return;
      }
      // line / cross: accumulate points; clicking the first point closes it
      // into a filled area (weg/plein).
      const first = drawing && drawing.points[0];
      const { w2s } = makeTransform(view);
      if (t.mode === 'line' && first && drawing.points.length >= 2 && dist(w2s(first), sp) < 12) {
        finishAnnotLine(drawing.points, true); return;
      }
      const pts = [...((drawing && drawing.points) || []), drawPoint(sp, e.shiftKey)];
      if (t.mode === 'cross' && pts.length >= 2) { finishAnnotLine(pts, false); return; }
      setDrawing({ points: pts });
      return;
    }
  };

  const onPointerMove = (e) => {
    const sp = getScreen(e);
    const wp = getWorld(e);
    mouseRef.current = wp;
    // A group hanging off the cursor owns every move until it is dropped.
    if (placingRef.current) { movePlacing(wp); return; }
    const drag = dragRef.current;

    if (!drag) {
      if (tool === 'annot' && annotKind === 'driveway') {
        if (sitePoly && sitePoly.length >= 3) {
          const frame = siteEdgeFrame(wp, sitePoly, polygonCentroid(sitePoly));
          setHover(frame ? { driveway: makeDriveway(frame, annotWidth, ANNOT_TYPES.driveway.depth || 12) } : null);
        }
        return;
      }
      if (tool === 'annot' && annotKind === 'road' && roadShape === 'rect') {
        setHover({ roadRect: makeRoadRect(snapPoint(sp), annotWidth, annotLength, (annotRot * Math.PI) / 180) });
        return;
      }
      if (tool === 'measure' && measure && measure.points.length) {
        const pts = measure.points;
        const at = e.shiftKey ? angleSnap(pts[pts.length - 1], wp) : snapPoint(sp);
        setMeasure({ points: pts, cur: at });
        return;
      }
      if ((tool === 'site' || tool === 'annot' || tool === 'obstaclepoly') && drawing) setHover(drawPoint(sp, e.shiftKey));
      else if (tool === 'placestall') { const s = snapStall(wp); setHover({ stallPreview: stallAt(s.center, s.theta), onRoad: s.onRoad }); }
      return;
    }
    if (drag.mode === 'pan') {
      const dx = sp.x - drag.start.x, dy = sp.y - drag.start.y;
      // A right-drag that actually travelled must not also fire the context
      // action on release; a few pixels of hand tremor still counts as a click.
      if (drag.right && !drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
      setView({ ...drag.view, ox: drag.view.ox + dx, oy: drag.view.oy + dy });
    } else if (drag.mode === 'siteMove') {
      const dx = wp.x - drag.start.x, dy = wp.y - drag.start.y;
      dispatch({ type: 'LIVE', updater: (d) => ({ ...d, site: drag.orig.map((p) => ({ x: p.x + dx, y: p.y + dy })) }) });
    } else if (drag.mode === 'annotMove') {
      // Always rebuilt from the pre-drag geometry + total delta, so the move is
      // idempotent and cannot drift.
      const a0 = alignSnap(drag.orig, wp.x - drag.start.x, wp.y - drag.start.y);
      const dx = a0.dx, dy = a0.dy;
      guidesRef.current = a0.guides;
      // Alt takes everything standing on the road with it. Held live, so you can
      // press and release it mid-drag and watch the difference.
      const withRiders = (e.altKey || carryRidersRef.current) && drag.riders ? drag.riders : null;
      const moved = new Map();
      for (const r of (drag.mates || [])) moved.set(r.i, r);
      if (withRiders) for (const r of withRiders.anns) moved.set(r.i, r);
      dispatch({ type: 'LIVE', updater: (d) => ({
        ...d,
        annotations: (d.annotations || []).map((a, i) => {
          if (i === drag.index) return {
            ...a,
            points: drag.orig.map((p) => ({ x: p.x + dx, y: p.y + dy })),
            ...(drag.origAnchor ? { anchor: { x: drag.origAnchor.x + dx, y: drag.origAnchor.y + dy } } : {}),
          };
          const r = moved.get(i);
          if (!r) return a;
          return {
            ...a,
            points: r.orig.map((p) => ({ x: p.x + dx, y: p.y + dy })),
            ...(r.anchor ? { anchor: { x: r.anchor.x + dx, y: r.anchor.y + dy } } : {}),
          };
        }),
        junctions: drag.juncAt && drag.juncAt.length ? (() => {
          // Rebuilt from the pre-drag map every frame, so the remap is
          // idempotent no matter how many times the pointer moves.
          const jn = { ...drag.junc };
          for (const j of drag.juncAt) delete jn[j.key];
          for (const j of drag.juncAt) jn[junctionKey({ x: j.at.x + dx, y: j.at.y + dy })] = drag.junc[j.key];
          return jn;
        })() : d.junctions,
        manualStalls: withRiders && withRiders.stalls.length
          ? (d.manualStalls || []).map((ms, i) => {
            const r = withRiders.stalls.find((x) => x.i === i);
            return r ? { ...ms, poly: r.orig.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : ms;
          })
          : d.manualStalls,
      }) });
    } else if (drag.mode === 'obsMove') {
      const a1 = alignSnap(drag.orig, wp.x - drag.start.x, wp.y - drag.start.y);
      const dx = a1.dx, dy = a1.dy;
      guidesRef.current = a1.guides;
      dispatch({ type: 'LIVE', updater: (d) => ({
        ...d,
        obstacles: d.obstacles.map((o, i) => (i !== drag.index ? o
          : { ...(o && o.poly ? o : {}), poly: drag.orig.map((p) => ({ x: p.x + dx, y: p.y + dy })), floors: (o && o.floors) || 1, use: (o && o.use) || DEFAULT_USE })),
      }) });
    } else if (drag.mode === 'stallMove') {
      const base = drag.idxs.length ? drag.baseManual[drag.idxs[0]].poly : null;
      const a2 = alignSnap(base, wp.x - drag.start.x, wp.y - drag.start.y);
      const dx = a2.dx, dy = a2.dy;
      guidesRef.current = a2.guides;
      drag.dx = dx; drag.dy = dy; // pointer-up needs the final delta to re-key
      const own = new Set(drag.idxs);
      dispatch({ type: 'LIVE', updater: (d) => ({
        ...d,
        manualStalls: drag.baseManual.map((ms, i) => (own.has(i)
          ? { ...ms, poly: ms.poly.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
          : ms)),
      }) });
    } else if (drag.mode === 'annotArea') {
      drag.cur = wp;
      setHover({ preview: rectFrom(drag.start, wp) });
    } else if (drag.mode === 'annotCircle') {
      drag.cur = wp;
      setHover({ circle: { c: drag.center, r: Math.hypot(wp.x - drag.center.x, wp.y - drag.center.y) } });
    } else if (drag.mode === 'vertex') {
      const t = drag.target;
      dispatch({ type: 'LIVE', updater: (d) => {
        if (t.type === 'site') {
          const site = d.site.slice(); site[t.index] = wp; return { ...d, site };
        }
        if (t.type === 'annV') {
          const anns = (d.annotations || []).map((a, i) => (i === t.ann ? { ...a, points: a.points.map((p, j) => (j === t.index ? { x: wp.x, y: wp.y } : p)) } : a));
          return { ...d, annotations: anns };
        }
        // A road object's grips move a parameter, not a point: the rectangle is
        // rebuilt from the recipe, so it stays a rectangle no matter where the
        // cursor wanders.
        if (t.type === 'annLen' || t.type === 'annRot') {
          const anns = (d.annotations || []).slice();
          const a = anns[t.ann];
          if (!isRoadObject(a)) return d;
          if (t.type === 'annRot') {
            let rot = Math.atan2(wp.y - a.at.y, wp.x - a.at.x) + Math.PI / 2;
            if (e.shiftKey) rot = Math.round(rot / ANGLE_SNAP) * ANGLE_SNAP;
            anns[t.ann] = makeRoadRect(a.at, a.width, a.length, rot, a);
          } else {
            // Drag one end; the other stays put, so the object grows from the
            // end you took hold of instead of from its middle.
            const c = Math.cos(a.rot), s2 = Math.sin(a.rot);
            const along = (wp.x - a.at.x) * c + (wp.y - a.at.y) * s2;
            const fixed = -t.end * (a.length / 2);
            const length = Math.max(1, Math.abs(along - fixed));
            const mid = fixed + t.end * (length / 2);
            anns[t.ann] = makeRoadRect(
              { x: a.at.x + c * mid, y: a.at.y + s2 * mid }, a.width, length, a.rot, a);
          }
          return { ...d, annotations: anns };
        }
        const obstacles = d.obstacles.map((o) => (Array.isArray(o) ? o.slice() : { ...o, poly: o.poly.slice() }));
        const tgt = obstacles[t.obs];
        if (Array.isArray(tgt)) tgt[t.index] = wp; else tgt.poly[t.index] = wp;
        return { ...d, obstacles };
      }});
    } else if (drag.mode === 'rect') {
      drag.cur = wp;
      const r = rectFrom(drag.start, wp);
      setHover({ preview: r });
    } else if (drag.mode === 'marquee') {
      marqueeRef.current.x1 = wp.x; marqueeRef.current.y1 = wp.y;
      renderRef.current();
    }
  };

  // Right-click on a site or building edge inserts a new vertex there. Driven
  // from pointer-up, not from the contextmenu event: Chromium fires contextmenu
  // on mouse-DOWN, so a right-drag would have inserted a vertex before the pan
  // had moved a single pixel.
  const insertVertexAt = (sp, wp) => {
    const { w2s } = makeTransform(view);
    const TOL = 14;
    const projectOnSeg = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      return { x: a.x + t * dx, y: a.y + t * dy };
    };
    let best = null; // { kind, oi, i, d }
    const site = doc.site;
    if (site && site.length >= 2) {
      for (let i = 0; i < site.length; i++) {
        const d = distPointSegment(sp, w2s(site[i]), w2s(site[(i + 1) % site.length]));
        if (d < TOL && (!best || d < best.d)) best = { kind: 'site', i, d };
      }
    }
    doc.obstacles.forEach((o, oi) => {
      const op = polyOf(o);
      for (let i = 0; i < op.length; i++) {
        const d = distPointSegment(sp, w2s(op[i]), w2s(op[(i + 1) % op.length]));
        if (d < TOL && (!best || d < best.d)) best = { kind: 'obs', oi, i, d };
      }
    });
    if (!best) return false;
    if (best.kind === 'site') {
      const a = site[best.i], b = site[(best.i + 1) % site.length];
      const np = projectOnSeg(wp, a, b);
      dispatch({ type: 'COMMIT', updater: (d) => { const s = d.site.slice(); s.splice(best.i + 1, 0, np); return { ...d, site: s }; } });
      setSelection({ type: 'site' });
    } else {
      const op = polyOf(doc.obstacles[best.oi]);
      const a = op[best.i], b = op[(best.i + 1) % op.length];
      const np = projectOnSeg(wp, a, b);
      dispatch({ type: 'COMMIT', updater: (d) => {
        const obs = d.obstacles.map((o, k) => { if (k !== best.oi) return o; const p = polyOf(o).slice(); p.splice(best.i + 1, 0, np); return Array.isArray(o) ? p : { ...o, poly: p }; });
        return { ...d, obstacles: obs };
      } });
      setSelection({ type: 'obs', index: best.oi });
    }
    return true;
  };
  // Always swallow the native menu over the canvas: the right button is the pan
  // gesture now, and a menu popping up mid-drag would abort it.
  const onContextMenu = (e) => { if (viewMode === '2d') e.preventDefault(); };

  const onPointerUp = (e) => {
    const drag = dragRef.current;
    dragRef.current = null;
    guidesRef.current = null;
    if (!drag) return;
    // A group drag ends on release; the CHECKPOINT at pointer-down already made
    // it one undo step, so there is nothing left to commit.
    if (drag.mode === 'group') { placingRef.current = null; renderRef.current(); return; }
    // A right-click that never travelled is still a click: run the edge action.
    if (drag.right) { if (!drag.moved) insertVertexAt(getScreen(e), getWorld(e)); return; }
    if (drag.mode === 'vertex') {
      // History is already handled by the CHECKPOINT taken at pointer-down.
    } else if (drag.mode === 'stallMove') {
      // Keys are centroid-based, so the moved stalls have new ones — re-select
      // them or the selection would silently point at their old positions.
      const dx = drag.dx || 0, dy = drag.dy || 0;
      setStallSel(drag.idxs.map((i) => stallKey(drag.baseManual[i].poly.map((p) => ({ x: p.x + dx, y: p.y + dy })))));
    } else if (drag.mode === 'rect') {
      const r = rectFrom(drag.start, drag.cur);
      if (Math.abs(r.w) > 1 && Math.abs(r.h) > 1) {
        const poly = rectPoly(r.x, r.y, r.w, r.h);
        dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: [...d.obstacles, newBuilding(poly)] }) });
      }
      setHover(null);
      setTool('select');
    } else if (drag.mode === 'annotArea') {
      const r = rectFrom(drag.start, drag.cur);
      if (Math.abs(r.w) > 0.5 && Math.abs(r.h) > 0.5) {
        // An area is a closed ring whichever tool drew it. Rectangles used to be
        // the exception, and that exception was invisible until you switched to
        // 3D and found the same shape present when drawn as a polygon and gone
        // when dragged as a rectangle.
        const isArea = (ANNOT_TYPES[annotKind] || {}).mode === 'area';
        addAnnotation({ kind: annotKind, points: rectPoly(r.x, r.y, r.w, r.h), width: 0, closed: isArea });
      }
      setHover(null);
    } else if (drag.mode === 'annotCircle') {
      const rad = Math.hypot(drag.cur.x - drag.center.x, drag.cur.y - drag.center.y);
      if (rad > 0.5) addAnnotation({ kind: annotKind, points: circlePoly(drag.center.x, drag.center.y, rad), closed: true, width: 0 });
      setHover(null);
    } else if (drag.mode === 'marquee') {
      const m = marqueeRef.current;
      marqueeRef.current = null;
      if (m) {
        const minX = Math.min(m.x0, m.x1), maxX = Math.max(m.x0, m.x1);
        const minY = Math.min(m.y0, m.y1), maxY = Math.max(m.y0, m.y1);
        if (!(maxX - minX > 0.5 || maxY - minY > 0.5) && drag.at) {
          // A Shift+click, not a box: toggle whatever is under the cursor.
          toggleUnderCursor(drag.at, drag.atWorld);
        } else if (maxX - minX > 0.5 || maxY - minY > 0.5) {
          const inBox = (p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
          const hitKeys = deco.stalls.filter((st) => inBox(polygonCentroid(st.poly))).map((st) => st.key);
          // Annotations and buildings are caught by the same box: it is one
          // gesture, so it should not matter what kind of thing is under it.
          // A way counts when all of it is inside, so half-covering a long road
          // never drags it off with the rest.
          const hitAnns = [];
          (doc.annotations || []).forEach((a, i) => {
            if (a && a.points && a.points.length && a.points.every(inBox)) hitAnns.push(i);
          });
          const hitObs = [];
          (doc.obstacles || []).forEach((o, i) => { if (inBox(polygonCentroid(polyOf(o)))) hitObs.push(i); });
          if (hitKeys.length || hitAnns.length || hitObs.length) {
            setSelection(null); setAisleSel(null);
            setStallSel((cur) => drag.add ? Array.from(new Set([...cur, ...hitKeys])) : hitKeys);
            setMultiSel((cur) => drag.add
              ? { anns: Array.from(new Set([...cur.anns, ...hitAnns])), obs: Array.from(new Set([...cur.obs, ...hitObs])) }
              : { anns: hitAnns, obs: hitObs });
          }
        }
        renderRef.current();
      }
    }
  };

  const onDoubleClick = (e) => {
    if (tool === 'measure') { setMeasure((m) => (m ? { points: m.points, done: true } : m)); return; }
    if (tool === 'site' && drawing && drawing.points.length >= 3) {
      commitSite(drawing.points); setDrawing(null); setTool('select');
    } else if (tool === 'obstaclepoly' && drawing && drawing.points.length >= 3) {
      commitObstaclePoly(drawing.points); setDrawing(null); setTool('select');
    } else if (tool === 'annot' && annotKind === 'road' && roadShape === 'multi' && drawing && drawing.points.length >= 3) {
      addAnnotation({ kind: 'road', shape: 'multi', points: drawing.points, closed: true, width: 0, material: annotMaterial || 'asphalt' });
      setDrawing(null); setTool('select');
    } else if (tool === 'annot' && ANNOT_TYPES[annotKind].mode === 'area' && drawing && drawing.points.length >= 3) {
      finishAreaPoly(drawing.points);
    } else if (tool === 'annot' && drawing && drawing.points.length >= 2) {
      finishAnnotLine(drawing.points, false);
    } else if (!drawing) {
      // Double-click a road (or any annotation) to add a point where you
      // clicked, so the shape can be refined by dragging. Selection itself
      // already happened on the preceding pointer-down.
      const sp = getScreen(e);
      // A junction first: double-clicking one reopens the choice, so a decision
      // is never final. This has to come before the vertex insert below, which
      // would otherwise splice a point into the road you were aiming at.
      const { w2s: w2sD } = makeTransform(view);
      const cross = crossings.find((c) => dist(w2sD(c.at), sp) < 14);
      if (cross) { setAskJunction(cross); return; }
      const ai = hitAnnotation(sp);
      if (ai < 0) return;
      setTool('select'); setStallSel([]); setAisleSel(null);
      setSelection({ type: 'annot', index: ai });
      const ann = (doc.annotations || [])[ai];
      // A driveway and a road object are rectangles derived from parameters;
      // splicing a fifth point into one would break that relationship silently.
      if (!ann || ann.kind === 'driveway' || isRoadObject(ann) || !ann.points || ann.points.length < 2) return;
      const { w2s } = makeTransform(view);
      // Insert on the segment nearest the click, in the raw (control) points.
      let best = null;
      const closed = ann.closed || (ANNOT_TYPES[ann.kind] || {}).mode === 'area';
      const n = ann.points.length;
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const a = w2s(ann.points[i]), b = w2s(ann.points[(i + 1) % n]);
        const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
        if (len2 < 1e-6) continue;
        let t = ((sp.x - a.x) * dx + (sp.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(sp.x - (a.x + t * dx), sp.y - (a.y + t * dy));
        if (!best || d < best.d) best = { d, i, t };
      }
      if (!best || best.d > 14) return;
      const p1 = ann.points[best.i], p2 = ann.points[(best.i + 1) % n];
      const np = { x: p1.x + (p2.x - p1.x) * best.t, y: p1.y + (p2.y - p1.y) * best.t };
      dispatch({ type: 'COMMIT', updater: (d) => ({
        ...d,
        annotations: (d.annotations || []).map((a, i) => (i !== ai ? a
          : { ...a, points: [...a.points.slice(0, best.i + 1), np, ...a.points.slice(best.i + 1)] })),
      }) });
    }
  };

  const commitSite = (points) =>
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, site: points, obstacles: [] }) });
  const commitObstaclePoly = (points) => {
    if (!points || points.length < 3) return;
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: [...d.obstacles, newBuilding(points.slice())] }) });
  };
  // Every building carries its use; the storey default follows from it.
  const newBuilding = (poly) => ({
    poly, use: buildUse, floors: (BUILDING_USES[buildUse] || {}).floors || 1,
    material: buildMat || DEFAULT_MATERIAL[buildUse] || 'render',
  });
  const setObsUse = (index, use) => dispatch({ type: 'COMMIT', updater: (d) => ({
    ...d,
    obstacles: d.obstacles.map((o, i) => (i === index
      ? { ...(o && o.poly ? o : { poly: polyOf(o) }), poly: polyOf(o).slice(), use,
          floors: (BUILDING_USES[use] || {}).floors || 1,
          material: DEFAULT_MATERIAL[use] || 'render' } : o)),
  }) });
  const setObsMaterial = (index, material) => dispatch({ type: 'COMMIT', updater: (d) => ({
    ...d,
    obstacles: d.obstacles.map((o, i) => (i === index
      ? { ...(o && o.poly ? o : { poly: polyOf(o) }), poly: polyOf(o).slice(), material } : o)),
  }) });
  const setObsFloors = (index, floors) => dispatch({ type: 'COMMIT', updater: (d) => ({
    ...d,
    // Spread the original: this used to write { poly, floors } and nothing
    // else, so changing the storeys silently threw the building type away.
    obstacles: d.obstacles.map((o, i) => (i === index
      ? { ...(o && o.poly ? o : {}), poly: polyOf(o).slice(), floors: Math.max(1, floors || 1) } : o)),
  }) });
  const deleteObs = (index) => dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: d.obstacles.filter((_, i) => i !== index) }) });

  // Duplicate whatever is selected (building, annotation, or stalls), offset a
  // little so the copy is visible, and select the copy.
  const offsetPts = (pts, dx, dy) => pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  // ---------- Object list ----------
  // Everything the user placed, grouped. Solver stalls are summarised per type
  // rather than listed: 105 rows would make the list useless.
  const aislesRemovedCount = Object.keys(((doc.overrides || {}).aislesRemoved) || {}).length;
  const objectRows = useMemo(() => {
    const q = objQuery.trim().toLowerCase();
    const groups = new Map();
    const push = (grp, row) => { if (!groups.has(grp)) groups.set(grp, []); groups.get(grp).push(row); };
    // A junction network is one object, so it is one row — listing its branches
    // separately would contradict the fact that they select and move together.
    const netsDone = new Set();
    (doc.annotations || []).forEach((a, i) => {
      const t = ANNOT_TYPES[a.kind] || {};
      const grp = netRoot[i] != null ? netIndices(i) : [i];
      if (grp.length > 1) {
        if (netsDone.has(netRoot[i])) return;
        netsDone.add(netRoot[i]);
        push(t.group || 'Rijden', {
          key: 'n' + netRoot[i], kind: 'net', net: netRoot[i], index: i, color: t.color || '#94a3b8', type: t,
          // A network's name lives on its first segment in document order, which
          // is where `index` points. Split the network and the name follows that
          // segment — the alternative is a name on nothing.
          label: 'Wegennet', custom: a.label || '', sub: grp.length + ' segmenten',
        });
        return;
      }
      push(t.group || 'Overig', {
        key: 'a' + i, kind: 'annot', index: i, color: t.color || '#94a3b8', type: t,
        label: t.label || a.kind, custom: a.label || '',
        sub: a.points && a.points.length > 1 ? a.points.length + ' punten' : '',
      });
    });
    (doc.obstacles || []).forEach((o, i) => push('Gebouwen', {
      key: 'o' + i, kind: 'obs', index: i,
      color: PART_COLORS[(o && o.use) === 'residential' ? 'roof' : 'body'],
      label: (BUILDING_USES[(o && o.use) || DEFAULT_USE] || {}).label || 'Gebouw',
      custom: (o && o.label) || '',
      sub: ((o && o.floors) || 1) + ' verd.',
    }));
    (doc.manualStalls || []).forEach((ms, i) => push('Handmatige vakken', {
      key: 'm' + i, kind: 'manual', index: i, color: (STALL_TYPES[ms.type] || STALL_TYPES.standard).color,
      label: (STALL_TYPES[ms.type] || STALL_TYPES.standard).label, custom: ms.label || '', sub: 'vak',
    }));
    deco.aisles.forEach((a, i) => push('Rijbanen', {
      key: 'ai' + a.key, kind: 'aisle', aisleKey: a.key, color: '#94a3b8',
      // An aisle is derived, so its name goes where its other manual decisions
      // go: the position-keyed override, which is what survives a re-solve.
      label: 'Rijbaan ' + (i + 1), custom: ((doc.overrides.aisles || {})[a.key] || {}).label || '',
      sub: (a.oneway ? 'eenrichting' : '') + (a.locked ? ' 🔒' : ''),
    }));
    const byType = new Map();
    for (const st of deco.stalls) if (!st.manual) byType.set(st.type, (byType.get(st.type) || 0) + 1);
    for (const [type, n] of byType) push('Solver-vakken', {
      key: 's' + type, kind: 'stallGroup', stallType: type,
      color: (STALL_TYPES[type] || STALL_TYPES.standard).color,
      label: (STALL_TYPES[type] || STALL_TYPES.standard).label, sub: n + ' vakken',
    });
    const out = [];
    for (const [grp, rows] of groups) {
      const hit = q ? rows.filter((r) => (r.label + ' ' + (r.custom || '') + ' ' + grp).toLowerCase().includes(q)) : rows;
      if (hit.length) out.push([grp, hit]);
    }
    return out;
  }, [doc.annotations, doc.obstacles, doc.manualStalls, doc.overrides, deco.stalls, deco.aisles, objQuery, netRoot]);

  // An imported symbol shows its own thumbnail where the built-in kinds show a
  // colour dot — otherwise every custom asset is the same grey circle.
  const dotStyle = (t) => (t && t.asset
    ? { backgroundImage: 'url(' + t.asset.src + ')', backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat', borderRadius: 0 }
    // A carriageway is painted like the solver's aisles, so the swatch has to
    // be that colour too — otherwise the palette promises a different road.
    : t && t.aisleColor ? { background: TH_BASE.aisle }
    : { background: (t && t.color) || '#94a3b8' });

  // Bring an object into view without changing the zoom more than needed.
  const focusPoly = (poly) => {
    if (!poly || poly.length < 1) return;
    const b = boundingBox(poly);
    const sz = sizeRef.current;
    const cx = b.minX + b.w / 2, cy = b.minY + b.h / 2;
    setView((v) => ({ ...v, ox: sz.w / 2 - cx * v.scale, oy: sz.h / 2 - cy * v.scale }));
  };
  const selectRow = (r) => {
    if (r.kind === 'stallGroup') {
      setSelection(null); setAisleSel(null);
      setStallSel(deco.stalls.filter((s) => !s.manual && s.type === r.stallType).map((s) => s.key));
      return;
    }
    if (r.kind === 'manual') {
      const ms = (doc.manualStalls || [])[r.index];
      setSelection(null); setAisleSel(null); setStallSel(ms ? [stallKey(ms.poly)] : []);
      return;
    }
    if (r.kind === 'aisle') {
      setSelection(null); setStallSel([]); setAisleSel(r.aisleKey);
      return;
    }
    setStallSel([]); setAisleSel(null);
    setSelection({ type: r.kind === 'obs' ? 'obs' : 'annot', index: r.index });
  };
  const rowPoly = (r) => {
    if (r.kind === 'net') return netIndices(r.index).flatMap((i) => doc.annotations[i].points);
    if (r.kind === 'annot') return (doc.annotations || [])[r.index]?.points;
    if (r.kind === 'obs') return polyOf(doc.obstacles[r.index]);
    if (r.kind === 'manual') return (doc.manualStalls || [])[r.index]?.poly;
    if (r.kind === 'aisle') return (deco.aisles.find((a) => a.key === r.aisleKey) || {}).poly;
    if (r.kind === 'stallGroup') {
      const all = deco.stalls.filter((s) => !s.manual && s.type === r.stallType);
      return all.length ? all.flatMap((s) => s.poly) : null;
    }
    return null;
  };
  const deleteRow = (r) => {
    if (r.kind === 'net') deleteAnnotations(netIndices(r.index));
    else if (r.kind === 'annot') deleteAnnotation(r.index);
    else if (r.kind === 'obs') deleteObstacle(r.index);
    else if (r.kind === 'manual') {
      const ms = (doc.manualStalls || [])[r.index];
      if (ms) { deleteStalls([stallKey(ms.poly)]); setStallSel([]); }
    } else if (r.kind === 'aisle') deleteAisle(r.aisleKey);
  };
  // Give a listed object a name of your own. Written onto the record itself, so
  // it travels with save, undo and a shared link; an aisle is derived and gets
  // its name in the position-keyed override, where its other manual decisions
  // already live. A solver stall group is a type rather than an object and is
  // deliberately not renameable — there is nothing to hang the name on.
  const canRename = (r) => r.kind === 'net' || r.kind === 'annot' || r.kind === 'obs'
    || r.kind === 'manual' || r.kind === 'aisle';
  const renameRow = (r, raw) => {
    const label = String(raw || '').trim().slice(0, 60);
    dispatch({ type: 'COMMIT', updater: (d) => {
      const set = (obj) => { const o = { ...obj }; if (label) o.label = label; else delete o.label; return o; };
      if (r.kind === 'net' || r.kind === 'annot') {
        const anns = (d.annotations || []).slice();
        if (!anns[r.index]) return d;
        anns[r.index] = set(anns[r.index]);
        return { ...d, annotations: anns };
      }
      if (r.kind === 'obs') {
        const obs = (d.obstacles || []).slice();
        if (!obs[r.index]) return d;
        obs[r.index] = set(obs[r.index]);
        return { ...d, obstacles: obs };
      }
      if (r.kind === 'manual') {
        const ms = (d.manualStalls || []).slice();
        if (!ms[r.index]) return d;
        ms[r.index] = set(ms[r.index]);
        return { ...d, manualStalls: ms };
      }
      if (r.kind === 'aisle') {
        const aisles = { ...(d.overrides.aisles || {}) };
        const cur = set(aisles[r.aisleKey] || {});
        // An override that holds nothing but a deleted name is litter.
        if (Object.keys(cur).length) aisles[r.aisleKey] = cur; else delete aisles[r.aisleKey];
        return { ...d, overrides: { ...d.overrides, aisles } };
      }
      return d;
    } });
  };

  const isRowSelected = (r) => {
    if (r.kind === 'net') return !!(selection && selection.type === 'annot'
      && netRoot[selection.index] === r.net);
    if (r.kind === 'annot') return selection && selection.type === 'annot' && selection.index === r.index;
    if (r.kind === 'obs') return selection && selection.type === 'obs' && selection.index === r.index;
    if (r.kind === 'aisle') return aisleSel === r.aisleKey;
    return false;
  };

  // ---------- Clipboard ----------
  // Stored in localStorage so a set of signs or a worked-out entrance can be
  // reused in another project or tab, not just within this session.
  const CLIP_KEY = 'pp_clipboard';
  const readClip = () => {
    try { return JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch (e) { return null; }
  };
  const writeClip = (clip) => {
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch (e) {}
  };
  // Centre of everything copied, so pasting keeps the group's internal spacing.
  const clipCentre = (items) => {
    let n = 0, sx = 0, sy = 0;
    for (const it of items) for (const p of (it.points || it.poly || [])) { sx += p.x; sy += p.y; n++; }
    return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
  };
  const copySelection = () => {
    const d = docRef.current || doc;
    let items = null;
    if (multiCount > 1) {
      const g = groupCopies();
      items = [...g.anns.map((a) => ({ what: 'annot', data: a })),
        ...g.obs.map((o) => ({ what: 'obs', data: o })),
        ...g.stalls.map((m) => ({ what: 'stall', data: m }))];
    } else if (selection && selection.type === 'annot' && (d.annotations || [])[selection.index]) {
      // A junction network is one object everywhere else, so it copies as one.
      items = netIndices(selection.index).map((i) => ({ what: 'annot', data: d.annotations[i] }));
    } else if (selection && selection.type === 'obs' && d.obstacles[selection.index]) {
      const o = d.obstacles[selection.index];
      items = [{ what: 'obs', data: { ...(o && o.poly ? o : {}), poly: polyOf(o), floors: (o && o.floors) || 1, use: (o && o.use) || DEFAULT_USE } }];
    } else if (stallSel.length) {
      const st = stallSel.map((k) => deco.stalls.find((x) => x.key === k)).filter(Boolean);
      if (st.length) items = st.map((x) => ({ what: 'stall', data: { poly: x.poly, type: x.type } }));
    }
    if (!items || !items.length) return false;
    const geo = items.map((i) => i.data);
    writeClip({ items, centre: clipCentre(geo) });
    return true;
  };
  const cutSelection = () => {
    if (!copySelection()) return;
    if (multiCount > 1) { deleteGroup(); return; }
    // Reuse the delete paths so override cleanup and reindexing are not bypassed.
    if (selection && selection.type === 'annot') {
      const grp = netIndices(selection.index);
      if (grp.length > 1) deleteAnnotations(grp); else deleteAnnotation(selection.index);
    } else if (selection && selection.type === 'obs') deleteObstacle(selection.index);
    else if (stallSel.length) { deleteStalls(stallSel); setStallSel([]); }
  };
  const pasteClipboard = () => {
    const clip = readClip();
    if (!clip || !clip.items || !clip.items.length) return;
    // Land on the cursor when it is over the canvas; otherwise offset like Cmd+D.
    const at = mouseRef.current;
    const dx = at ? at.x - clip.centre.x : 4;
    const dy = at ? at.y - clip.centre.y : 4;
    const shift = (pts) => pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    const anns = [], obs = [], stalls = [];
    for (const it of clip.items) {
      if (it.what === 'annot') {
        const c = { ...it.data, points: shift(it.data.points) };
        if (it.data.anchor) c.anchor = { x: it.data.anchor.x + dx, y: it.data.anchor.y + dy };
        anns.push(c);
      } else if (it.what === 'obs') obs.push({ ...it.data, poly: shift(it.data.poly) });
      else if (it.what === 'stall') stalls.push({ ...it.data, poly: shift(it.data.poly) });
    }
    // More than one thing: let it follow the cursor so it can be snapped into
    // place, rather than landing wherever the copy happened to be taken from.
    if (anns.length + obs.length + stalls.length > 1) { startPlacing({ anns, obs, stalls }); return; }
    dispatch({ type: 'COMMIT', updater: (d) => embedAssets({
      ...d,
      annotations: anns.length ? [...(d.annotations || []), ...anns] : d.annotations,
      obstacles: obs.length ? [...d.obstacles, ...obs] : d.obstacles,
      manualStalls: stalls.length ? [...(d.manualStalls || []), ...stalls] : d.manualStalls,
    }, anns) });
    // Select what was just pasted, matching duplicateSelection's behaviour.
    if (anns.length) { setSelection({ type: 'annot', index: (doc.annotations || []).length + anns.length - 1 }); setStallSel([]); }
    else if (obs.length) { setSelection({ type: 'obs', index: doc.obstacles.length + obs.length - 1 }); setStallSel([]); }
    else if (stalls.length) { setSelection(null); setStallSel(stalls.map((c) => stallKey(c.poly))); }
  };

  // ---------- Placing a duplicated group ----------
  // The copies go into the document straight away and then follow the cursor
  // until you click. A CHECKPOINT is taken first, so Escape is simply an undo
  // and the plan is left exactly as it was — there is no half-placed state to
  // clean up, and no second code path that could forget to.
  const startPlacing = ({ anns = [], obs = [], stalls = [] }) => {
    if (!anns.length && !obs.length && !stalls.length) return;
    const nA = (doc.annotations || []).length, nO = (doc.obstacles || []).length, nS = (doc.manualStalls || []).length;
    dispatch({ type: 'CHECKPOINT' });
    dispatch({ type: 'LIVE', updater: (d) => embedAssets({
      ...d,
      annotations: [...(d.annotations || []), ...anns],
      obstacles: [...(d.obstacles || []), ...obs],
      manualStalls: [...(d.manualStalls || []), ...stalls],
    }, anns) });
    const all = [...anns.map((a) => a.points), ...obs.map((o) => polyOf(o)), ...stalls.map((m) => m.poly)];
    let n = 0, sx = 0, sy = 0;
    for (const pts of all) for (const p of pts) { sx += p.x; sy += p.y; n++; }
    placingRef.current = {
      anns: anns.map((a, k) => ({ i: nA + k, pts: a.points, anchor: a.anchor })),
      obs: obs.map((o, k) => ({ i: nO + k, pts: polyOf(o) })),
      stalls: stalls.map((m, k) => ({ i: nS + k, pts: m.poly })),
      // Anchored on the cursor if it is over the canvas, else on the group's
      // own centre, so the group does not jump when the mouse first moves.
      start: mouseRef.current || { x: sx / (n || 1), y: sy / (n || 1) },
    };
    clearSel();
    setPlacing((v) => v + 1);
  };
  const movePlacing = (wp) => {
    const P = placingRef.current;
    if (!P) return;
    const parts = [...P.anns, ...P.obs, ...P.stalls];
    if (!parts.length) return;
    const a0 = alignSnap(parts[0].pts, wp.x - P.start.x, wp.y - P.start.y);
    let dx = a0.dx, dy = a0.dy, guides = a0.guides;
    const v = groupVertexSnap(parts.flatMap((q) => q.pts), dx, dy);
    if (v) { dx = v.dx; dy = v.dy; guides = [{ x: v.at.x }, { y: v.at.y }]; }
    guidesRef.current = guides;
    const shift = (pts) => pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    const byI = (list) => new Map(list.map((q) => [q.i, q]));
    const mA = byI(P.anns), mO = byI(P.obs), mS = byI(P.stalls);
    dispatch({ type: 'LIVE', updater: (d) => ({
      ...d,
      annotations: (d.annotations || []).map((a, i) => {
        const q = mA.get(i);
        if (!q) return a;
        return { ...a, points: shift(q.pts), ...(q.anchor ? { anchor: { x: q.anchor.x + dx, y: q.anchor.y + dy } } : {}) };
      }),
      obstacles: (d.obstacles || []).map((o, i) => {
        const q = mO.get(i);
        if (!q) return o;
        return { ...(o && o.poly ? o : {}), poly: shift(q.pts), floors: (o && o.floors) || 1, use: (o && o.use) || DEFAULT_USE };
      }),
      manualStalls: (d.manualStalls || []).map((m, i) => {
        const q = mS.get(i);
        return q ? { ...m, poly: shift(q.pts) } : m;
      }),
    }) });
  };
  const dropPlacing = () => {
    if (!placingRef.current) return;
    placingRef.current = null;
    guidesRef.current = [];
    setPlacing(0);
  };
  const cancelPlacing = () => {
    if (!placingRef.current) return;
    placingRef.current = null;
    guidesRef.current = [];
    setPlacing(0);
    dispatch({ type: 'UNDO' });
  };

  // Everything currently picked, as plain copies ready to be placed.
  const groupCopies = () => {
    const d = docRef.current || doc;
    const anns = multiSel.anns.map((i) => (d.annotations || [])[i]).filter(Boolean).map((a) => ({ ...a, points: a.points.map((p) => ({ ...p })) }));
    const obs = multiSel.obs.map((i) => (d.obstacles || [])[i]).filter(Boolean)
      .map((o) => ({ ...(o && o.poly ? o : {}), poly: polyOf(o).map((p) => ({ ...p })), floors: (o && o.floors) || 1, use: (o && o.use) || DEFAULT_USE }));
    const stalls = stallSel.map((k) => deco.stalls.find((x) => x.key === k)).filter(Boolean)
      .map((x) => ({ poly: x.poly.map((p) => ({ ...p })), type: x.type }));
    return { anns, obs, stalls };
  };
  const deleteGroup = () => {
    const kA = new Set(multiSel.anns), kO = new Set(multiSel.obs);
    if (stallSel.length) { deleteStalls(stallSel); setStallSel([]); }
    if (kA.size || kO.size) {
      dispatch({ type: 'COMMIT', updater: (d) => ({
        ...d,
        annotations: (d.annotations || []).filter((_, i) => !kA.has(i)),
        obstacles: (d.obstacles || []).filter((_, i) => !kO.has(i)),
      }) });
    }
    setMultiSel({ anns: [], obs: [] });
    setSelection(null);
  };

  const duplicateSelection = () => {
    // More than one thing picked → copy them all and hang the group off the
    // cursor. The single-object paths below stay exactly as they were.
    if (multiCount > 1) { startPlacing(groupCopies()); return; }
    const D = 4;
    if (selection && selection.type === 'obs' && doc.obstacles[selection.index]) {
      const o = doc.obstacles[selection.index];
      const copy = Array.isArray(o) ? offsetPts(o, D, D) : { ...o, poly: offsetPts(polyOf(o), D, D) };
      const idx = doc.obstacles.length;
      dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: [...d.obstacles, copy] }) });
      setSelection({ type: 'obs', index: idx });
    } else if (selection && selection.type === 'annot' && (doc.annotations || [])[selection.index]) {
      // The whole network, so what you duplicate is what the object list calls
      // one thing. The copies cross each other again in their new place, so the
      // app asks about those crossings afresh rather than assuming.
      const copies = netIndices(selection.index).map((i) => {
        const a = doc.annotations[i];
        const c = { ...a, points: offsetPts(a.points, D, D) };
        if (a.anchor) c.anchor = { x: a.anchor.x + D, y: a.anchor.y + D };
        return c;
      });
      const idx = (doc.annotations || []).length;
      dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, annotations: [...(d.annotations || []), ...copies] }) });
      setSelection({ type: 'annot', index: idx });
    } else if (stallSel.length) {
      const copies = stallSel.map((k) => { const st = deco.stalls.find((s) => s.key === k); return st ? { poly: offsetPts(st.poly, D, D), type: st.type } : null; }).filter(Boolean);
      if (!copies.length) return;
      dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, manualStalls: [...(d.manualStalls || []), ...copies] }) });
      setStallSel(copies.map((c) => stallKey(c.poly)));
    }
  };
  dupRef.current = duplicateSelection;
  clipRef.current = { copy: copySelection, cut: cutSelection, paste: pasteClipboard };

  // Wheel handling is attached natively (passive:false) so preventDefault works.
  //
  // A mouse wheel zooms; a trackpad's two-finger scroll pans. Deciding that per
  // event tore a single diagonal swipe into alternating pan and zoom (measured:
  // 12 pan / 12 zoom on one 45° gesture), which felt like panning was broken —
  // so the decision is latched for the whole burst and only re-taken after the
  // gesture goes quiet.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheelNative = (e) => {
      if (vmRef.current === '3d') return; // 3D wheel is handled by the Mapbox map
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;

      const now = performance.now();
      const w = wheelRef.current;
      const fresh = now - w.at > WHEEL_GAP_MS;
      w.at = now;
      if (fresh) {
        // A mouse wheel arrives as whole notches; a trackpad sends fine-grained
        // deltas. Judge on the first event of the gesture, where the two are
        // still easy to tell apart, and read every signal the engines give:
        // Firefox reports lines (deltaMode 1); Chrome and Safari both expose the
        // legacy wheelDeltaY, which is an exact multiple of 120 for a wheel and
        // 3× the raw delta for a trackpad; Safari's mouse deltaY is far smaller
        // than Chrome's 100, so the size test alone would call it a trackpad.
        const wd = Math.abs(e.wheelDeltaY != null ? e.wheelDeltaY : (e.wheelDelta || 0));
        w.zoom = e.deltaMode !== 0
          || (wd > 0 && wd % 120 === 0)
          || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));
      }
      // Modifiers always win, and never latch: pinch-zoom on a trackpad is
      // ctrl+wheel, and Shift is the escape hatch for panning with a wheel.
      const zooming = e.ctrlKey || e.metaKey ? true : e.shiftKey ? false : w.zoom;

      if (!zooming) {
        setView((v) => ({ ...v, ox: v.ox - e.deltaX, oy: v.oy - e.deltaY }));
        return;
      }
      // Normalise to notches first. Feeding the raw delta into exp() made one
      // mouse click a 2.7× jump that overshot the whole site.
      const perNotch = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 1 : 1 / 100;
      const notches = Math.max(-4, Math.min(4, e.deltaY * perNotch));
      setView((v) => {
        const s = Math.max(1, Math.min(60, v.scale * Math.exp(-notches * 0.22)));
        const k = s / v.scale;
        return { scale: s, ox: cx - (cx - v.ox) * k, oy: cy - (cy - v.oy) * k };
      });
    };
    canvas.addEventListener('wheel', onWheelNative, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheelNative);
  }, []);

  // ---------- Keyboard ----------
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'REDO' : 'UNDO' }); return; }
      if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); dispatch({ type: 'REDO' }); return; }
      if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); dupRef.current(); return; }
      if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); clipRef.current.copy(); return; }
      if (meta && e.key.toLowerCase() === 'x') { e.preventDefault(); clipRef.current.cut(); return; }
      if (meta && e.key.toLowerCase() === 'v') { e.preventDefault(); clipRef.current.paste(); return; }
      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break;
        case 'p': setTool('site'); setDrawing({ points: [] }); break;
        case 'b': setTool('obstacle'); break;
        case 'n': setTool('obstaclepoly'); setDrawing({ points: [] }); break;
        case 'k': setTool('placestall'); break;
        case 'm': setTool('measure'); setMeasure({ points: [] }); setDrawing(null); break;
        // The three ways in and out. The design puts a letter on these cards, so
        // the letter has to do something — a badge for a key that does not exist
        // is worse than no badge. They are the only annotations with one.
        case 'w': startAnnot('road'); break;
        case 'i': startAnnot('driveway'); break;
        case 'd': startAnnot('drivethru'); break;
        // Hold to pan, release to go back. Without preventDefault the browser
        // also "clicks" whatever toolbar button still has focus, which set the
        // tool straight back and made Space-to-pan do nothing at all after you
        // had touched the toolbar — which is most of the time.
        case ' ':
          e.preventDefault();
          if (!spaceRef.current) { spaceRef.current = tool === 'pan' ? null : tool || 'select'; setTool('pan'); }
          break;
        case 'g': setLayers((l) => ({ ...l, grid: !l.grid })); break;
        case 's': setSnapOn((v) => !v); break;
        case 't': libOpenRef.current(); break;
        case '?': setKeysOpen((o) => !o); break;
        case '/': if (toolSearchRef.current) { e.preventDefault(); toolSearchRef.current.focus(); toolSearchRef.current.select(); } break;
        // R rotates in 15° steps: the stall about to be placed, or the selected
        // ones. Shift+R goes back. The HUD reports the current offset.
        case 'r': {
          const step = e.shiftKey ? -ANGLE_SNAP_DEG : ANGLE_SNAP_DEG;
          // Through the ref: the listener is only re-registered on selection
          // change, so a captured doc would go stale after the first press.
          const selAnn = selection && selection.type === 'annot' ? ((docRef.current || {}).annotations || [])[selection.index] : null;
          if (selAnn && (ANNOT_TYPES[selAnn.kind] || {}).picto) {
            updateAnnotation(selection.index, { angle: ((((selAnn.angle || 0) + step) % 360) + 360) % 360 });
          } else if (stallSel.length) {
            const cur = deco.stalls.find((s) => s.key === stallSel[0]);
            const base = cur && cur.angle != null ? cur.angle : Math.round(((result.angleUsed || 0) * 180) / Math.PI);
            setStallAngles(stallSel, (((base + step) % 360) + 360) % 360);
          } else {
            setStallRot((r) => (((r + step) % 360) + 360) % 360);
          }
          break;
        }
        case '+': case '=': zoomBy(1.2); break;
        case '-': case '_': zoomBy(1 / 1.2); break;
        case 'escape':
          // Menus first, outermost thing last: Escape should undo the most
          // recent layer, and an open dropdown stayed open through it.
          if (viewMenuOpen || exportOpen || fileOpen) { setViewMenuOpen(false); setExportOpen(false); setFileOpen(false); break; }
          if (libOpen) { setLibOpen(false); break; }
          if (placingRef.current) { cancelPlacing(); break; }
          setDrawing(null); setMeasure(null); setTool('select'); setSelection(null); setStallSel([]); setAisleSel(null); setMultiSel({ anns: [], obs: [] });
          break;
        case 'delete': case 'backspace':
          if (multiSel.anns.length || multiSel.obs.length) {
            deleteGroup();
          } else if (stallSel.length) {
            deleteStalls(stallSel); setStallSel([]);
          } else if (aisleSel) {
            deleteAisle(aisleSel);
          } else if (selection && selection.type === 'obs') {
            deleteObstacle(selection.index);
          } else if (selection && selection.type === 'annot') {
            // A junction network goes as one; that is what the object list shows.
            const anns = (docRef.current || {}).annotations || [];
            const grp = netIndices(selection.index);
            if (grp.length > 1) deleteAnnotations(grp);
            else { deleteAnnotation(selection.index); setSelection(null); }
          } else if (selection && selection.type === 'site') {
            dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, site: [] }) }); setSelection(null);
          }
          break;
        default: break;
      }
    };
    const onKeyUp = (e) => {
      if (e.key !== ' ') return;
      const back = spaceRef.current;
      spaceRef.current = null;
      if (back) setTool(back);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  }, [selection, stallSel, aisleSel, tool, multiSel, placing, libOpen, viewMenuOpen, exportOpen, fileOpen]);

  // ---------- Toolbar actions ----------
  const cycleAxis = () =>
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, orientationIndex: (d.orientationIndex + 1) % Math.max(1, result.orientationCount || 1) }) });
  const resetAxis = () => dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, orientationIndex: 0 }) });
  const fitToSite = () => {
    const fv = fitView(sitePoly, sizeRef.current.w, sizeRef.current.h);
    if (fv) setView(fv);
  };
  // Design schemes: solve a handful of layout variants and compare their yield,
  // so the user can pick the best (TestFit "Design Schemes").
  const genSchemes = () => {
    const site = sitePoly;
    if (!site || site.length < 3) { setSchemes([]); return; }
    const align = site.length >= 2 ? longestEdgeAngle(site) : 0;
    const siteArea = polygonArea(site);
    const variants = [
      { label: 'Recht 90°', patch: { layout: 'strip', angle: 90, alignLongestEdge: false } },
      { label: 'Schuin 60°', patch: { layout: 'strip', angle: 60, alignLongestEdge: false } },
      { label: 'Schuin 45°', patch: { layout: 'strip', angle: 45, alignLongestEdge: false } },
      { label: 'Uitgelijnd op rand', patch: { layout: 'strip', angle: 90, alignLongestEdge: true } },
    ];
    // Curved layouts only make sense (and only pack cleanly) on curved sites.
    if (doc.siteCurved) {
      variants.push({ label: 'Rand + midden', patch: { layout: 'hybrid' } });
      variants.push({ label: 'Concentrisch', patch: { layout: 'perimeter' } });
    }
    const out = variants.map((v) => {
      const p = { ...doc.params, ...v.patch };
      const solveP = p.alignLongestEdge ? { ...p, alignAngle: align } : p;
      let res;
      try { res = solveParking(site, doc.obstacles, solveP, 0); } catch (e) { res = { stalls: [] }; }
      const physical = (res.stalls || []).length;
      const density = physical > 0 ? siteArea / physical : 0; // m² of site per stall
      return { label: v.label, patch: v.patch, physical, density };
    });
    // "Best" = most stalls among plausible (non-overlapping) layouts. A density
    // below ~20 m²/stall means stalls overlap, so those never win the star.
    const eligible = out.filter((o) => o.density >= 20);
    const max = Math.max(1, ...(eligible.length ? eligible : out).map((o) => o.physical));
    out.forEach((o) => { o.best = o.physical === max && (o.density >= 20 || !eligible.length); });
    out.sort((a, b) => b.physical - a.physical);
    setSchemes(out);
  };
  const applyScheme = (patch) => {
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, params: { ...d.params, ...patch } }) });
    setSchemes(null);
  };

  // Automatic optimisation: search the parameter space (angle sweep + a fine
  // refinement pass, alignment, and curved layouts where applicable) and apply
  // the highest-yield plausible layout automatically. Solves are yielded
  // between candidates so the UI stays responsive, and roads/driveways are
  // respected just like the live solve.
  const evalPatch = (patch, siteArea) => {
    const p = { ...doc.params, ...patch };
    const solveP = p.alignLongestEdge ? { ...p, alignAngle: longestEdgeAngle(sitePoly) } : p;
    const obs = roadBlockers.length ? [...doc.obstacles, ...roadBlockers] : doc.obstacles;
    let res;
    try { res = solveParking(sitePoly, obs, solveP, 0); } catch (e) { res = { stalls: [] }; }
    const physical = (res.stalls || []).length;
    const spaces = (res.stalls || []).reduce((s, st) => s + (STALL_TYPES[st.type] ? STALL_TYPES[st.type].spaces || 1 : 1), 0);
    return { physical, spaces, density: physical > 0 ? siteArea / physical : 0 };
  };
  const autoOptimize = async () => {
    const site = sitePoly;
    if (!site || site.length < 3) return;
    const siteArea = polygonArea(site);
    const before = metrics.total;
    // Phase 1 — coarse candidates (the current setup is always included so the
    // result can never be worse than what you already have).
    const coarse = [
      { label: 'Huidig', patch: {} },
      { label: 'Recht 90°', patch: { layout: 'strip', angle: 90, alignLongestEdge: false } },
      { label: 'Schuin 75°', patch: { layout: 'strip', angle: 75, alignLongestEdge: false } },
      { label: 'Schuin 60°', patch: { layout: 'strip', angle: 60, alignLongestEdge: false } },
      { label: 'Schuin 45°', patch: { layout: 'strip', angle: 45, alignLongestEdge: false } },
      { label: 'Schuin 30°', patch: { layout: 'strip', angle: 30, alignLongestEdge: false } },
      { label: 'Uitgelijnd 90°', patch: { layout: 'strip', angle: 90, alignLongestEdge: true } },
    ];
    if (doc.siteCurved) {
      coarse.push({ label: 'Rand + midden', patch: { layout: 'hybrid' } });
      coarse.push({ label: 'Concentrisch', patch: { layout: 'perimeter' } });
    }
    const scored = [];
    const better = (a, b) => !b || a.spaces > b.spaces; // a beats b?
    const plausible = (r) => r.density >= 20 && r.physical > 0;
    let best = null;
    // Phase 2 refine steps depend on phase-1 winner, so build the total up front.
    const totalEst = coarse.length + 4;
    for (let i = 0; i < coarse.length; i++) {
      setOptState({ running: true, i: i + 1, n: totalEst });
      await new Promise((r) => setTimeout(r, 0));
      const r = { ...coarse[i], ...evalPatch(coarse[i].patch, siteArea) };
      scored.push(r);
      if (plausible(r) && better(r, best)) best = r;
    }
    if (!best) best = scored.slice().sort((a, b) => b.spaces - a.spaces)[0];
    // Phase 2 — refine the angle ±5°/±10° around a straight-layout winner.
    if (best && best.patch.layout === 'strip' && !best.patch.alignLongestEdge && typeof best.patch.angle === 'number') {
      const base = best.patch.angle;
      const refine = [base - 10, base - 5, base + 5, base + 10].filter((a) => a >= 30 && a <= 90);
      for (let j = 0; j < refine.length; j++) {
        setOptState({ running: true, i: coarse.length + j + 1, n: totalEst });
        await new Promise((r) => setTimeout(r, 0));
        const patch = { layout: 'strip', angle: refine[j], alignLongestEdge: false };
        const r = { label: `Recht ${refine[j]}°`, patch, ...evalPatch(patch, siteArea) };
        if (plausible(r) && better(r, best)) best = r;
      }
    }
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, params: { ...d.params, ...best.patch } }) });
    setSchemes(null);
    setOptState({ done: true, label: best.label, before, after: best.spaces });
  };
  const zoomBy = (factor) => setView((v) => {
    const cx = sizeRef.current.w / 2, cy = sizeRef.current.h / 2;
    const s = Math.max(1, Math.min(60, v.scale * factor));
    const k = s / v.scale;
    return { scale: s, ox: cx - (cx - v.ox) * k, oy: cy - (cy - v.oy) * k };
  });

  const saveJSON = () => {
    // Save the plan together with the current camera and basemap so a reload
    // returns to the exact same view and geographic location.
    const payload = { _pp: 1, doc, view, viewMode: '2d' };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    // The file is named after the plan, so a folder of them is readable.
    const slug = String(doc.name || 'parkplanner').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'parkplanner';
    downloadBlob(blob, slug + '.json');
    setSavedAt(new Date());
  };

  // Put the plan in a link. There is no server, so the plan travels inside the
  // URL itself — see share.js for why that fits. The link is copied to the
  // clipboard and the address bar is updated, so a reload of this tab lands on
  // the same plan too.
  const [shareMsg, setShareMsg] = useState('');
  const shareLink = async () => {
    try {
      const { url, chars, dropped } = await shareURL(window.location.href, doc, view);
      try { await navigator.clipboard.writeText(url); }
      catch (e) { /* no clipboard permission — the address bar still carries it */ }
      window.history.replaceState(null, '', url);
      const lost = [];
      if (dropped.assets) lost.push(dropped.assets + ' eigen symbool' + (dropped.assets > 1 ? 'en' : ''));
      if (dropped.objects) lost.push(dropped.objects + ' object' + (dropped.objects > 1 ? 'en' : '') + ' daarmee geplaatst');
      setShareMsg('Link gekopieerd — ' + fmt(chars) + ' tekens'
        + (lost.length ? '. Niet meegereisd: ' + lost.join(' en ') + '; stuur daarvoor het JSON-bestand.' : '.'));
    } catch (e) {
      setShareMsg('Delen lukte niet: ' + (e && e.message ? e.message : 'onbekende fout'));
    }
  };
  // A link is a one-off message, not a state; it should not sit there for ever.
  useEffect(() => {
    if (!shareMsg) return;
    const t = setTimeout(() => setShareMsg(''), 9000);
    return () => clearTimeout(t);
  }, [shareMsg]);
  // Apply a loaded file. Accepts the new wrapped format ({_pp, doc, view,
  // basemapStyle}) as well as a bare document from older saves.
/**
 * Bring an older document up to date.
 *
 * A road drawn as an object used to be stored as four loose corners with
 * `width: 0`. Recovering its width, length and heading from the rectangle keeps
 * such a plan exactly the shape it was — the alternative is that it silently
 * takes a default size the first time anything touches it.
 */
function migrateDoc(d) {
  const anns = (d.annotations || []).map((a) => {
    if (!a || a.kind !== 'road' || a.shape || !a.closed) return a;
    if (!Array.isArray(a.points) || a.points.length !== 4) return a;
    const q = roadRectParams(a);
    return { ...a, shape: 'object', at: q.at, width: q.width, length: q.length, rot: q.rot };
  });
  return anns === d.annotations ? d : { ...d, annotations: anns };
}

  const applyLoaded = (payload) => {
    const d = payload && payload.doc && payload.doc.site ? payload.doc : payload;
    if (!(d && d.site && d.params)) { alert('Ongeldig bestand'); return false; }
    const merged = migrateDoc({ ...initialDoc, ...d });
    // Register the document's own symbols before the first draw. The effect on
    // doc.assets would catch up a frame later, but that frame is a plan with
    // visible holes in it.
    const lib = new Set(assetLib.map((a) => a.id));
    (merged.assets || []).forEach((a) => installAsset(a, lib.has(a.id)));
    // Same for its building styles, and for the same reason: the effect would
    // catch up a frame later, and that frame draws a building whose style does
    // not exist yet.
    (merged.buildingStyles || []).forEach((s) => { if (!BUILDING_USES[s.key]) registerBuildingStyle(s); });
    dispatch({ type: 'RESET', doc: merged });
    // Restore the exact camera if it was saved; otherwise fit to the loaded
    // site (computed from the loaded polygon, not the stale sitePoly memo).
    fittedRef.current = true;
    const sv = payload && payload.view;
    if (sv && isFinite(sv.scale) && sv.scale > 0 && isFinite(sv.ox) && isFinite(sv.oy)) {
      setView({ scale: sv.scale, ox: sv.ox, oy: sv.oy });
    } else {
      const poly = merged.siteCurved && merged.site.length >= 3 ? tessellateClosed(merged.site, 14) : merged.site;
      const fv = fitView(poly, sizeRef.current.w, sizeRef.current.h);
      if (fv) setView(fv);
    }
    setOnboardOpen(false);
    return true;
  };
  const loadJSON = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { applyLoaded(JSON.parse(reader.result)); }
      catch (err) { alert('Ongeldig bestand'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // A shared plan opens instead of the welcome overlay. Once, on the first
  // render: `applyLoaded` is the same path a file takes, so a link and a file
  // cannot drift apart in what they restore. The hash stays in the address bar
  // so the tab can be reloaded or bookmarked.
  const sharedRef = useRef(false);
  useEffect(() => {
    if (sharedRef.current) return;
    sharedRef.current = true;
    const code = shareCodeOf(window.location.hash);
    if (!code) return;
    setOnboardOpen(false);
    decodeShare(code).then((payload) => {
      if (payload && applyLoaded(payload)) setShareMsg('Plan uit een gedeelde link geopend.');
      else setShareMsg('De gedeelde link is onleesbaar — hij is misschien afgekapt bij het kopiëren.');
    });
  }, []);

  // Import a real parcel boundary from GeoJSON or KML: anchor the geo frame at
  // the ring centroid, convert to local metres, simplify, and use it as the site.
  const applyParcel = (ring) => {
    const lat = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
    const lon = ring.reduce((s, p) => s + p.lon, 0) / ring.length;
    const geo = { lat, lon };
    let site = simplifyRing(ring.map((p) => latLonToLocal(p, geo)), 0.5, 120);
    if (site.length < 3) { alert('Geen bruikbare perceelgrens gevonden.'); return; }
    dispatch({ type: 'RESET', doc: { ...initialDoc, site, geo, obstacles: [] } });
    fittedRef.current = true;
    const fv = fitView(site, sizeRef.current.w, sizeRef.current.h);
    if (fv) setView(fv);
    setOnboardOpen(false);
  };
  // ---------- Building styles ----------
  const saveStyleLib = (list) => {
    setStyleLib(list);
    try { localStorage.setItem('pp_build_styles', JSON.stringify(list)); return true; }
    catch (e) { setStyleMsg('Opslaan in deze browser lukte niet — de stijl werkt wel deze sessie.'); return false; }
  };
  const importStyle = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setStyleMsg('');
    const reader = new FileReader();
    reader.onload = () => {
      let raw;
      try { raw = JSON.parse(reader.result); }
      catch (err) { setStyleMsg('Dit is geen JSON-bestand.'); return; }
      // One style or a whole exported set — both are what someone would send.
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw.styles) ? raw.styles : [raw]);
      const added = [];
      for (const spec of list) {
        const key = registerBuildingStyle(spec);
        if (key) added.push(styleSpec(BUILDING_USES[key]));
      }
      if (!added.length) { setStyleMsg('Geen bruikbare stijl gevonden — een stijl heeft minstens een "key" nodig.'); return; }
      const keys = new Set(added.map((s) => s.key));
      saveStyleLib([...styleLib.filter((s) => !keys.has(s.key)), ...added]);
      setStyleMsg(added.length + ' stijl' + (added.length > 1 ? 'en' : '') + ' geïmporteerd: ' + added.map((s) => s.label).join(', '));
      setBuildUse(added[0].key);
      setTool('obstacle');
    };
    reader.readAsText(file);
  };
  const exportStyles = () => {
    // Every style, built-in included: someone who wants to tweak "Magazijn"
    // should not have to retype it from a screenshot.
    const styles = Object.values(BUILDING_USES).map(styleSpec);
    downloadBlob(new Blob([JSON.stringify({ _ppStyles: 1, styles }, null, 2)], { type: 'application/json' }),
      'parkplanner-gebouwstijlen.json');
  };
  const dropStyle = (key) => {
    if (!removeBuildingStyle(key)) return;
    saveStyleLib(styleLib.filter((s) => s.key !== key));
    if (buildUse === key) setBuildUse(DEFAULT_USE);
    renderRef.current();
  };

  // ---------- Asset library ----------
  const saveAssetLib = (list) => {
    setAssetLib(list);
    const err = writeAssetLib(list);
    setAssetMsg(err);
    return !err;
  };
  const importAsset = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setAssetMsg('');
    let asset;
    try { asset = await normalizeAsset(file); }
    catch (err) { setAssetMsg('Kon dit bestand niet lezen als beeld (PNG, JPG, WebP of SVG).'); return; }
    if (assetLibChars(assetLib) + asset.src.length > ASSET_LIB_MAX_CHARS) {
      setAssetMsg('De bibliotheek zit vol (max ' + Math.round(ASSET_LIB_MAX_CHARS / 1024) + ' kB). Verwijder eerst een asset.');
      return;
    }
    // Install before saving: even if the write fails on quota, the symbol is
    // usable this session and the message says why it will not come back.
    installAsset(asset, true);
    saveAssetLib([...assetLib, asset]);
    startAnnot(assetKindOf(asset.id));
  };
  const patchAsset = (id, patch) => {
    const next = assetLib.map((a) => (a.id === id ? { ...a, ...patch } : a));
    const hit = next.find((a) => a.id === id);
    if (hit) installAsset(hit, true);
    saveAssetLib(next);
    renderRef.current();
  };
  const removeAsset = (id) => {
    hideAsset(id);
    saveAssetLib(assetLib.filter((a) => a.id !== id));
    // Placed instances stay: the document keeps its own copy of the definition.
    if (tool === 'annot' && annotKind === assetKindOf(id)) setTool('select');
  };
  const importParcel = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ring = parseParcel(reader.result, file.name);
      if (!ring || ring.length < 3) { alert('Geen perceelgrens gevonden in dit bestand (GeoJSON of KML verwacht).'); return; }
      applyParcel(ring);
    };
    reader.readAsText(file);
    e.target.value = '';
  };
  const exportPNG = () => {
    canvasRef.current.toBlob((blob) => downloadBlob(blob, 'parkplanner.png'));
  };
  const exportGeoJSON = () =>
    downloadBlob(new Blob([JSON.stringify(toGeoJSON(buildPlan(), doc.geo), null, 2)], { type: 'application/geo+json' }), 'parkplanner.geojson');
  const exportDXF = () =>
    downloadBlob(new Blob([toDXF(buildPlan())], { type: 'application/dxf' }), 'parkplanner.dxf');
  const exportCSV = () =>
    downloadBlob(new Blob([toCSV(buildPlan(), metrics, { pv: pvReport, lux: stallLight && stallLight.stats })],
      { type: 'text/csv;charset=utf-8' }), 'parkplanner.csv');
  const newRect = () => {
    dispatch({ type: 'RESET', doc: { ...initialDoc, site: rectPoly(0, 0, 80, 50), obstacles: [] } });
    setTimeout(fitToSite, 0);
  };

  // Re-anchor the plan so the site centroid sits at a geographic point.
  const centerOnLatLon = (lat, lon) => {
    if (!isFinite(lat) || !isFinite(lon)) return;
    // polygonCentroid of an empty ring is {NaN, NaN}, and deleting the site is
    // two clicks away. That wrote a NaN anchor, which Mapbox rejects and
    // follow2D used to swallow — leaving every later search dead with the
    // coordinate readout stuck on "NaN, NaN". Fall back to the origin instead.
    const c0 = polygonCentroid(doc.site);
    const c = isFinite(c0.x) && isFinite(c0.y) ? c0 : { x: 0, y: 0 };
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const geo = { lat: lat + c.y / 111320, lon: lon - c.x / (111320 * cosLat) };
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, geo }) });
    setTimeout(fitToSite, 0);
  };
  const doGeocode = async () => {
    const q = geoSearch.trim();
    if (!q) return;
    setGeoBusy(true); setGeoMsg('');
    try {
      const hit = await geocode(q, mbToken);
      if (!hit) { setGeoMsg('Niet gevonden'); }
      else {
        centerOnLatLon(hit.lat, hit.lon);
        setGeoMsg(hit.label.split(',').slice(0, 3).join(', '));
      }
    } catch (err) {
      setGeoMsg('Zoeken mislukt (netwerk/CORS)');
    } finally { setGeoBusy(false); }
  };
  // From the onboarding overlay: search a location, then dismiss the overlay.
  const onboardGeocode = async () => {
    if (!geoSearch.trim()) return;
    await doGeocode();
    setOnboardOpen(false);
  };

  // ---------- Mapbox 3D token ----------
  const saveMbToken = () => {
    const t = mbTokenInput.trim();
    if (!t) return;
    try { localStorage.setItem('pp_mapbox_token', t); } catch (e) {}
    setMbToken(t); setMbTokenInput(''); setMap3dError(''); setMapErrHidden(false);
  };
  const clearMbToken = () => {
    try { localStorage.removeItem('pp_mapbox_token'); } catch (e) {}
    setMbToken(''); setMap3dError(''); setMapErrHidden(false);
  };
  const changeMapStyle = (s) => {
    try { localStorage.setItem('pp_map_style', s); } catch (e) {}
    setMap3dError(''); setMapErrHidden(false); setMapDiag({}); setMapStyle(s);
  };
  const retryMap = () => { setMap3dError(''); setMapErrHidden(false); setMapDiag({}); setMapNonce((n) => n + 1); };

  // Palette grouped and filtered. A query searches label + synonyms and forces
  // every matching group open, so results are never hidden behind a collapse.
  // The library's own grouping. Same catalogue as the palette — one source of
  // truth for what exists — but split by tab and filtered by the dialog's search.
  // Every card is normalised to one shape here — a plain annotation, a combo
  // family, or one of the four primary tools — so the render loop below has a
  // single kind of thing to draw instead of three branches per card.
  const libGroups = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    const hay = (k, t) => (t.label + ' ' + k + ' ' + (t.keywords || '') + ' ' + descOf(k)).toLowerCase();
    const out = [];
    if (libTab === 'infra') {
      const prims = PRIMARY_TOOLS
        .filter((p) => !q || (p.label + ' ' + p.id + ' ' + p.desc).toLowerCase().includes(q))
        .map((p) => ({ k: p.id, kind: p.id, t: null, prim: true, fam: null,
          label: p.label, desc: p.desc, color: p.color, key: p.key }));
      if (prims.length) out.push([PRIMARY_GROUP, prims]);
    }
    for (const grp of ANNOT_GROUPS) {
      const items = [], famSeen = new Set();
      for (const [k, t] of Object.entries(ANNOT_TYPES)) {
        if ((t.group || 'Overig') !== grp || t.hidden) continue;
        if ((libTab === 'assets') !== !!t.asset) continue;
        const member = comboOf(k);
        if (member) {
          if (famSeen.has(member.id)) continue;
          const fam = COMBOS[member.id];
          // A family answers to any of its members, so "keren" finds the arrow
          // card rather than nothing at all.
          if (q && !(fam.label + ' ' + fam.desc).toLowerCase().includes(q)
            && !fam.members.some((m) => hay(m.kind, ANNOT_TYPES[m.kind]).includes(q))) continue;
          famSeen.add(member.id);
          const pick = comboPick[member.id] || fam.members[0].kind;
          items.push({ k: 'combo:' + member.id, kind: pick, t: ANNOT_TYPES[pick], prim: false,
            fam, famId: member.id, label: fam.label, desc: fam.desc,
            color: ANNOT_TYPES[pick].color, key: '' });
          continue;
        }
        if (q && !hay(k, t).includes(q)) continue;
        items.push({ k, kind: k, t, prim: false, fam: null,
          label: t.label, desc: descOf(k), color: t.color, key: ANNOT_KEYS[k] || '' });
      }
      if (items.length) out.push([grp, items]);
    }
    return out;
  }, [libQuery, libTab, assetLib, comboPick]);
  // Cards, not kinds — a combo folds eight arrows onto one, and a tab total that
  // did not agree with the group counts beside it would just look like a bug.
  const libCounts = useMemo(() => {
    let infra = PRIMARY_TOOLS.length, assets = 0;
    const fams = new Set();
    for (const [k, t] of Object.entries(ANNOT_TYPES)) {
      if (t.hidden) continue;
      if (t.asset) { assets++; continue; }
      const member = comboOf(k);
      if (member) { fams.add(member.id); continue; }
      infra++;
    }
    return { infra: infra + fams.size, assets };
  }, [assetLib]);

  const paletteGroups = useMemo(() => {
    const q = toolQuery.trim().toLowerCase();
    const out = [];
    for (const grp of ANNOT_GROUPS) {
      const items = Object.entries(ANNOT_TYPES).filter(([k, t]) => (t.group || 'Overig') === grp && !t.hidden
        && (!q || (t.label + ' ' + k + ' ' + (t.keywords || '')).toLowerCase().includes(q)));
      if (items.length) out.push([grp, items]);
    }
    return out;
    // assetLib is not read here, but importing or removing a symbol changes
    // which types ANNOT_TYPES holds — without it the palette keeps the old set.
  }, [toolQuery, assetLib]);
  const toggleGroup = (grp) => setOpenGroups((cur) => {
    const next = { ...cur, [grp]: cur[grp] === false };
    try { localStorage.setItem('pp_tool_groups', JSON.stringify(next)); } catch (e) {}
    return next;
  });

  // Smart alignment while dragging: snap the moving object's edges and centre
  // to those of everything else, and report the lines that matched so they can
  // be drawn. Threshold is in screen pixels so it feels the same at any zoom.
  const alignTargets = useMemo(() => {
    const xs = [], ys = [];
    const add = (poly) => {
      if (!poly || poly.length < 2) return;
      const b = boundingBox(poly);
      xs.push(b.minX, b.minX + b.w / 2, b.maxX);
      ys.push(b.minY, b.minY + b.h / 2, b.maxY);
    };
    add(sitePoly);
    for (const o of doc.obstacles || []) add(polyOf(o));
    for (const a of doc.annotations || []) add(a.points);
    return { xs, ys };
  }, [sitePoly, doc.obstacles, doc.annotations]);

  // Vertex snap for a whole group: if any point of the moving group lands close
  // to a point already in the plan, pull the group so the two coincide exactly.
  // The offset is applied on top of alignSnap's, and wins, because landing on a
  // corner is a stronger statement than lining up with an edge.
  const groupVertexSnap = (pts, dx, dy) => {
    if (!snapRef.current) return { dx, dy };
    const tol = 12 / view.scale;
    const targets = [];
    (doc.site || []).forEach((p) => targets.push(p));
    (doc.obstacles || []).forEach((o) => polyOf(o).forEach((p) => targets.push(p)));
    const moving = new Set(pts);
    (doc.annotations || []).forEach((a) => (a.points || []).forEach((p) => { if (!moving.has(p)) targets.push(p); }));
    let best = null;
    for (const p of pts) {
      const q = { x: p.x + dx, y: p.y + dy };
      for (const t of targets) {
        const d = Math.hypot(t.x - q.x, t.y - q.y);
        if (d < tol && (!best || d < best.d)) best = { d, ddx: t.x - q.x, ddy: t.y - q.y, at: t };
      }
    }
    return best ? { dx: dx + best.ddx, dy: dy + best.ddy, at: best.at } : null;
  };

  const alignSnap = (origPts, dx, dy) => {
    const tol = 7 / view.scale; // 7 screen px
    if (!origPts || origPts.length < 1) return { dx, dy, guides: [] };
    const b = boundingBox(origPts.map((p) => ({ x: p.x + dx, y: p.y + dy })));
    const guides = [];
    const fit = (cands, vals) => {
      let best = null;
      for (const v of vals) for (const c of cands) {
        const d = c - v;
        if (Math.abs(d) < tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: c };
      }
      return best;
    };
    const fx = fit(alignTargets.xs, [b.minX, b.minX + b.w / 2, b.maxX]);
    const fy = fit(alignTargets.ys, [b.minY, b.minY + b.h / 2, b.maxY]);
    if (fx) { dx += fx.d; guides.push({ x: fx.at }); }
    if (fy) { dy += fy.d; guides.push({ y: fy.at }); }
    return { dx, dy, guides };
  };

  // ---------- Layout: visibility, panel widths, workspaces ----------
  const vis = (id) => !hidden[id];
  const persist = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} };
  const setHiddenSaved = (next) => { setHidden(next); persist('pp_ui_hidden', next); };
  const togglePart = (id) => setHiddenSaved({ ...hidden, [id]: !hidden[id] });
  const showAll = () => setHiddenSaved({});
  const applyVisibleList = (ids) => {
    if (!ids) return showAll();
    const keep = new Set(ids);
    const next = {};
    for (const p of UI_PARTS) if (!keep.has(p.id)) next[p.id] = true;
    setHiddenSaved(next);
  };
  const applyWorkspace = (name) => {
    if (WORKSPACE_PRESETS[name] !== undefined) return applyVisibleList(WORKSPACE_PRESETS[name]);
    const ws = workspaces[name];
    if (!ws) return;
    setHiddenSaved(ws.hidden || {});
    if (ws.widths) { setPanelW(ws.widths); persist('pp_panel_widths', ws.widths); }
  };
  // A workspace stores widths as well as visibility: both describe the same
  // arrangement, and restoring one without the other looks broken.
  const saveWorkspace = () => {
    const name = wsName.trim();
    if (!name) return;
    const next = { ...workspaces, [name]: { hidden, widths: panelW } };
    setWorkspaces(next); persist('pp_workspaces', next); setWsName('');
  };
  const deleteWorkspace = (name) => {
    const next = { ...workspaces }; delete next[name];
    setWorkspaces(next); persist('pp_workspaces', next);
  };

  // Panel resize. The canvas pointer pipeline is bound to the canvas element,
  // so a panel edge needs its own handling; pointer capture on the handle keeps
  // the drag alive when the cursor crosses the canvas or leaves the window.
  const startResize = (side) => (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = panelW[side];
    resizeRef.current = { side, startX, startW };
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    document.body.classList.add('resizing');
  };
  const onResizeMove = (e) => {
    const r = resizeRef.current;
    if (!r) return;
    const lim = PANEL_W[r.side];
    const delta = r.side === 'left' ? e.clientX - r.startX : r.startX - e.clientX;
    const w = Math.max(lim.min, Math.min(lim.max, r.startW + delta));
    setPanelW((cur) => (cur[r.side] === w ? cur : { ...cur, [r.side]: w }));
  };
  const endResize = (e) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    document.body.classList.remove('resizing');
    try { e.target.releasePointerCapture(e.pointerId); } catch (err) {}
    setPanelW((cur) => { persist('pp_panel_widths', cur); return cur; });
  };
  const resizer = (side) => html`
    <div className=${'panel-resize ' + side} onPointerDown=${startResize(side)}
      onPointerMove=${onResizeMove} onPointerUp=${endResize} onPointerCancel=${endResize}
      onDoubleClick=${() => { const w = { ...panelW, [side]: PANEL_W[side].def }; setPanelW(w); persist('pp_panel_widths', w); }}
      title=${'Sleep om te verbreden · dubbelklik voor standaard'}></div>`;

  // Fold a panel away from the panel itself. It could already be hidden through
  // the Weergave menu, but a control you have to go looking for in a menu is not
  // one you use to make room for a moment — and getting it back meant
  // remembering which menu it was. The reopen tab is the other half.
  // Right-panel sections fold one at a time, and a search at the top of the panel
  // keeps only the ones that match. Nine sections is more than a laptop screen
  // holds, and scrolling past eight to reach the ninth is not an interface.
  //
  // The words are what people would type, not the heading again: "schaduw" has
  // to find "Zon en schaduw", and "regenwater" has to find the runoff figure
  // even though no heading says either.
  const SEC_ORDER = [
    ['secMetrics', 'Metrics'], ['secDrive', 'Bereikbaarheid'], ['secSun', 'Zon en schaduw'],
    ['secLight', 'Licht en opbrengst'], ['secStallAisle', 'Vak & rijstrook'],
    ['secConstraints', 'Site-constraints'], ['secMix', 'Vaktypes (mix)'],
    ['secProgram', 'Programma & parkeer\u00adratio'],
  ];
  const SEC_WORDS = {
    secMetrics: 'vakken totaal oppervlak site bebouwd verhard runoff regenwater far ratio oriëntaties samenvatting minder-valide',
    secDrive: 'bereikbaarheid rijden voertuig vrachtwagen brandweer knelpunt draaicirkel doodlopend',
    secSun: 'zon schaduw datum uur seizoen bezonning',
    secLight: 'licht lux verlichting lichtmast uniformiteit carport pv zonnepanelen opbrengst kwh',
    secStallAisle: 'vak rijstrook rijbaan breedte diepte hoek layout automatisch parkeren perimeter',
    secConstraints: 'setback padding buffer rijlengte groeneiland single-loaded constraints',
    secMix: 'mix vaktypes compact ev laadpunt personeel bezoeker gereserveerd motor aandeel',
    secProgram: 'programma gla vloeroppervlak parkeerratio zoning vereist',
  };
  const [secShut, setSecShut] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pp_sec_shut') || '{}') || {}; } catch (e) { return {}; }
  });
  const [panelQuery, setPanelQuery] = useState('');
  const toggleSec = (id) => setSecShut((cur) => {
    const next = { ...cur, [id]: !cur[id] };
    try { localStorage.setItem('pp_sec_shut', JSON.stringify(next)); } catch (e) {}
    return next;
  });
  // While searching every hit is open: a result you still have to unfold is not
  // a result. Closing one by hand during a search still works and is remembered.
  const secIsOpen = (id) => !secShut[id] || !!panelQuery.trim();
  const secShow = (id, title) => {
    if (!vis(id)) return false;
    const q = panelQuery.trim().toLowerCase();
    return !q || (title + ' ' + (SEC_WORDS[id] || '')).toLowerCase().includes(q);
  };
  const secHead = (id, title, extra) => html`
    <h3 className="sec-h">
      <button className="sec-t" onClick=${() => toggleSec(id)} aria-expanded=${secIsOpen(id)}
        title=${secIsOpen(id) ? 'Inklappen' : 'Uitklappen'}>
        <span className="sec-caret">${secIsOpen(id) ? '▾' : '▸'}</span><span>${title}</span>
      </button>
      ${extra || ''}
    </h3>`;

  // A sticky strip of its own rather than a button floated over the content: the
  // first section's heading is not always the same section, and an absolutely
  // positioned chevron sat on top of whichever one it was — "Metrics" read
  // ":trics".
  const panelFold = (id, label, extra) => html`
    <div className=${'panel-head ' + (id === 'panelLeft' ? 'left' : 'right')}>
      <button className="panel-fold" title=${label + ' inklappen'} aria-label=${label + ' inklappen'}
        onClick=${() => togglePart(id)}>${id === 'panelLeft' ? '‹' : '›'}</button>
      ${extra || ''}
    </div>`;
  const panelReopen = (id, label) => html`
    <button className=${'panel-reopen ' + (id === 'panelLeft' ? 'left' : 'right')}
      title=${label + ' uitklappen'} aria-label=${label + ' uitklappen'}
      onClick=${() => togglePart(id)}>${id === 'panelLeft' ? '›' : '‹'}</button>`;

  // Every shortcut in one place. Half of these existed but were invisible —
  // nothing on screen mentioned G, R, Esc, Delete or Cmd+D.
  const SHORTCUTS = [
    ['Gereedschap', [['V', 'Selecteren'], ['P', 'Site tekenen'], ['B', 'Gebouw (rechthoek)'], ['N', 'Gebouw (vrije vorm)'], ['K', 'Parkeervak plaatsen'], ['M', 'Meetlint'], ['T', 'Bibliotheek'], ['Spatie', 'Pannen']]],
    ['Infrastructuur', [['W', 'Weg'], ['I', 'In/uitrit'], ['D', 'Drive-thru']]],
    ['Bewerken', [['Alt + slepen', 'Weg mét alles erop verplaatsen'], ['Cmd/Ctrl + Z', 'Ongedaan maken'], ['Shift + Cmd/Ctrl + Z', 'Opnieuw'], ['Cmd/Ctrl + D', 'Dupliceren'], ['Delete', 'Verwijderen'], ['Esc', 'Annuleren / deselecteren']]],
    ['Tekenen', [['Shift (slepen)', 'Uitlijnen per 15 graden'], ['R', 'Draai 15 graden'], ['Shift + R', 'Draai terug'], ['Dubbelklik op weg', 'Punt toevoegen'], ['Rechtsklik op rand', 'Punt toevoegen aan site']]],
    ['Pannen & zoomen', [['Rechtermuis slepen', 'Pannen'], ['Middelste muisknop', 'Pannen'], ['Spatie ingedrukt', 'Pannen'], ['Muiswiel', 'In- en uitzoomen'], ['Trackpad (2 vingers)', 'Pannen'], ['Shift + scrollen', 'Pannen'], ['Ctrl + scrollen / knijpen', 'In- en uitzoomen'], ['+ / -', 'In- en uitzoomen']]],
    ['Weergave', [['G', 'Raster aan/uit'], ['S', 'Vastklikken aan/uit'], ['/', 'Zoek gereedschap'], ['?', 'Dit overzicht']]],
  ];
  const keysModal = () => html`
    <div className="modal-backdrop" onClick=${() => setKeysOpen(false)}>
      <div className="modal keys-modal" onClick=${(e) => e.stopPropagation()}>
        <div className="sum-h" style=${{ marginTop: 0 }}>Sneltoetsen</div>
        <div className="keys-grid">
          ${SHORTCUTS.map(([grp, rows]) => html`
            <div key=${grp} className="keys-col">
              <div className="keys-h">${grp}</div>
              ${rows.map(([k, d]) => html`
                <div key=${k} className="keys-row"><kbd>${k}</kbd><span>${d}</span></div>`)}
            </div>`)}
        </div>
        <div className="sel-actions" style=${{ marginTop: '14px' }}>
          <button className="btn" onClick=${() => setKeysOpen(false)}>Sluiten</button>
        </div>
      </div>
    </div>`;

  // ---------- The library ----------
  // The same catalogue as the side palette, but wide enough to show what each
  // tool actually draws. The palette stays: it is the fast path once you know
  // the name. This is the path for when you do not.
  const openLib = (tab) => {
    // A search from last time is why the dialog would open showing nothing —
    // especially on a tab the old query cannot match.
    setLibQuery('');
    setLibTab(tab || 'infra');
    // Open on whatever is in your hand. A folded arrow is highlighted through
    // its family, since that is the card the grid actually draws.
    const mem = tool === 'annot' ? comboOf(annotKind) : null;
    setLibPick(mem ? 'combo:' + mem.id
      : tool === 'annot' ? annotKind
      : PRIMARY_TOOLS.some((p) => p.id === tool) ? tool : '');
    if (mem) setComboPick((c) => ({ ...c, [mem.id]: annotKind }));
    setLibOpen(true);
  };
  // Through a ref, because the key listener is only re-registered on selection
  // change and a captured openLib would highlight yesterday's tool.
  // Assigned on every render, so it always closes over the current tool. T
  // toggles: the same key gets you out again.
  libOpenRef.current = () => { if (libOpen) setLibOpen(false); else openLib(); };
  // The badge slot. The design puts a keyboard letter there, and where one
  // exists that is what it shows — the four primary tools, and W/I/D on the
  // three ways in and out. The rest of the catalogue has no key (the design
  // leaves those blank), and the draw mode is more use to a reader than an empty
  // box, so it fills in.
  const drawModeOf = (t) => (t.mode === 'point' ? 'punt'
    : t.mode === 'area' ? 'vlak'
    : t.mode === 'cross' ? 'zebra'
    : t.body ? 'weg' : 'lijn');
  const badgeOf = (e) => e.key || (e.t ? drawModeOf(e.t) : '');
  // What the footer and the Tekenen button act on. A combo resolves to the
  // member whose pill is lit; a primary tool has no ANNOT_TYPES entry at all.
  const libEntry = useMemo(() => {
    for (const [, items] of libGroups) for (const e of items) if (e.k === libPick) return e;
    return null;
  }, [libGroups, libPick]);
  const libPickT = libEntry ? libEntry.t : null;
  const valueOf = (e) => {
    if (!e || !e.t || e.t.value == null) return null;
    return libValue[e.kind] != null ? libValue[e.kind] : e.t.value;
  };
  // Picking up a tool. A combo carries the chosen direction, a value-bearing
  // tool carries its number, and a primary tool is just a tool.
  const libTake = (e) => {
    if (!e) return;
    if (e.prim) { setTool(e.kind); if (e.kind === 'site' || e.kind === 'obstaclepoly') setDrawing({ points: [] }); clearSel(); }
    else startAnnot(e.kind, valueOf(e));
    setLibOpen(false);
  };
  const libraryModal = () => html`
    <div className="dialog-backdrop" onClick=${() => setLibOpen(false)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Teken infrastructuur"
        onClick=${(e) => e.stopPropagation()}>
        <header className="dialog-h">
          <div className="dialog-h-row">
            <div>
              <span className="dialog-eyebrow">Bibliotheek</span>
              <h2 className="dialog-title">Teken infrastructuur</h2>
              <p className="dialog-sub">
                Alles wat je op het kavel kunt tekenen, per categorie. Elke voorbeeldweergave is
                met de tekenaars van de plattegrond zelf gemaakt — wat je hier ziet, krijg je.
              </p>
            </div>
            <button className="btn ghost dialog-x" aria-label="Sluiten" onClick=${() => setLibOpen(false)}>✕</button>
          </div>
          <div className="dialog-tabs">
            <button className=${'dialog-tab' + (libTab === 'infra' ? ' active' : '')}
              onClick=${() => setLibTab('infra')}>Infrastructuur <span>${libCounts.infra}</span></button>
            <button className=${'dialog-tab' + (libTab === 'assets' ? ' active' : '')}
              onClick=${() => setLibTab('assets')}>Eigen assets <span>${libCounts.assets}</span></button>
            <button className=${'dialog-tab' + (libTab === 'build' ? ' active' : '')}
              onClick=${() => setLibTab('build')}>Gebouwstijlen <span>${Object.keys(BUILDING_USES).length}</span></button>
            <span className="dialog-tabs-gap"></span>
            <input className="lib-search" type="search" placeholder="Zoeken in bibliotheek…"
              value=${libQuery} onInput=${(e) => setLibQuery(e.target.value)}
              onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); setLibQuery(''); } }} />
          </div>
        </header>

        <div className="dialog-body tk-scroll">
          ${libTab === 'assets' && html`
            <div className="lib-assets-head">
              <label className="btn asset-import">
                Symbool importeren…
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  onChange=${importAsset} style=${{ display: 'none' }} />
              </label>
              <span className="mix-note" style=${{ margin: 0 }}>
                PNG, JPG, WebP of SVG — verkleind tot ${ASSET_MAX_PX} px en daarna gewoon een gereedschap.
              </span>
            </div>
            ${assetMsg && html`<div className="asset-msg">${assetMsg}</div>`}`}
          ${libTab === 'build' && html`
            <div className="lib-assets-head">
              <label className="btn asset-import">
                Stijl importeren…
                <input type="file" accept="application/json,.json" onChange=${importStyle} style=${{ display: 'none' }} />
              </label>
              <button className="btn ghost" onClick=${exportStyles}>Alle stijlen exporteren</button>
              <span className="mix-note" style=${{ margin: 0 }}>
                Een stijl is een parameterset — verdiepingen, gevel, luifel, laadkade, tuin —
                geen model. Exporteer, pas de getallen aan, importeer terug.
              </span>
            </div>
            ${styleMsg && html`<div className="asset-msg">${styleMsg}</div>`}
            ${BUILD_FAMILIES.map(([gen, title, note]) => {
              const q = libQuery.trim().toLowerCase();
              const items = Object.values(BUILDING_USES).filter((u) => u.gen === gen
                && (!q || (u.label + ' ' + u.key + ' ' + (u.keywords || '')).toLowerCase().includes(q)));
              if (!items.length) return '';
              return html`
                <section className="lib-sec" key=${gen}>
                  <div className="lib-sec-h">
                    <span className="lib-sec-tick"></span>
                    <h3>${title}</h3>
                    <span className="lib-sec-n">${items.length}</span>
                    <span className="lib-sec-rule"></span>
                  </div>
                  <div className="lib-grid">
                    ${items.map((u) => html`
                      <div key=${u.key} role="button" tabIndex="0"
                        className=${'lib-card' + (buildUse === u.key ? ' active' : '')}
                        onClick=${() => { setBuildUse(u.key); setBuildMat(''); setTool('obstacle'); setLibOpen(false); }}
                        onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBuildUse(u.key); setBuildMat(''); setTool('obstacle'); setLibOpen(false); } }}>
                        <${BuildPreview} styleKey=${u.key} />
                        <span className="lib-card-h">
                          <span className="dot" style=${{ background: (MATERIALS[u.material] || MATERIALS.render).tint }}></span>
                          <span className="lib-card-name">${u.label}</span>
                          <span className="lib-card-gap"></span>
                          <span className="lib-card-key">${u.floors}×${u.floorH} m</span>
                        </span>
                        <span className="lib-card-desc">${u.desc || note}</span>
                        ${u.imported && html`
                          <span className="lib-card-actions">
                            <span className="tag tag-imported">geïmporteerd</span>
                            <button className="btn ghost" onClick=${(e) => { e.stopPropagation(); dropStyle(u.key); }}>Verwijderen</button>
                          </span>`}
                      </div>`)}
                  </div>
                </section>`;
            })}`}
          ${libTab !== 'build' && libGroups.length === 0 && html`<p className="mix-note">
            ${libQuery
              ? html`Niets gevonden voor "${libQuery}".`
              : libTab === 'assets'
                ? 'Nog geen eigen symbolen geïmporteerd.'
                : 'Niets in deze categorie.'}
          </p>`}
          ${libTab !== 'build' && libGroups.map(([grp, items]) => html`
            <section className="lib-sec" key=${grp}>
              <div className="lib-sec-h">
                <span className="lib-sec-tick"></span>
                <h3>${grp}</h3>
                <span className="lib-sec-n">${items.length}</span>
                <span className="lib-sec-rule"></span>
              </div>
              <div className="lib-grid">
                ${items.map((e) => html`
                  <div key=${e.k} role="button" tabIndex="0" aria-pressed=${libPick === e.k}
                    className=${'lib-card' + (libPick === e.k ? ' active' : '')}
                    ${/* A card selects; Tekenen in the footer draws. A card can
                          now carry a direction and a value, and picking one up
                          the instant you touch it would slam the dialog shut
                          before you could set either. Double-click is the
                          shortcut for when there is nothing to set. */ ''}
                    onClick=${() => setLibPick(e.k)}
                    onDblClick=${() => libTake(e)}
                    onKeyDown=${(ev) => {
                      if (ev.key === 'Enter') { ev.preventDefault(); libTake(e); }
                      else if (ev.key === ' ') { ev.preventDefault(); setLibPick(e.k); }
                    }}>
                    <${ToolPreview} kind=${e.kind} value=${valueOf(e)} />
                    <span className="lib-card-h">
                      <span className="dot" style=${e.t ? dotStyle(e.t) : { background: e.color }}></span>
                      <span className="lib-card-name">${e.label}</span>
                      <span className="lib-card-gap"></span>
                      ${badgeOf(e) && html`<span className="lib-card-key">${badgeOf(e)}</span>`}
                    </span>
                    <span className="lib-card-desc">${e.desc}</span>
                    ${e.fam && html`
                      <span className="lib-combo">
                        <span className="lib-combo-h">Combinatie</span>
                        <span className="lib-combo-pills">
                          ${e.fam.members.map((m) => html`
                            <button key=${m.kind} type="button"
                              className=${'tag lib-pill' + (e.kind === m.kind ? ' on' : '')}
                              title=${(ANNOT_TYPES[m.kind] || {}).label || m.label}
                              aria-pressed=${e.kind === m.kind}
                              onClick=${(ev) => {
                                ev.stopPropagation();
                                setComboPick((c) => ({ ...c, [e.famId]: m.kind }));
                                setLibPick(e.k);
                              }}>
                              <span className="lib-pill-g">${m.glyph}</span><span>${m.label}</span>
                            </button>`)}
                        </span>
                      </span>`}
                    ${e.t && e.t.value != null && html`
                      <span className="lib-card-val">
                        <input className="input" type="number" aria-label=${e.t.valueLabel || 'Waarde'}
                          min=${e.t.valueMin == null ? 5 : e.t.valueMin}
                          max=${e.t.valueMax == null ? 130 : e.t.valueMax}
                          step=${e.t.valueStep == null ? 5 : e.t.valueStep}
                          value=${valueOf(e)}
                          onClick=${(ev) => ev.stopPropagation()}
                          onChange=${(ev) => {
                            const v = parseFloat(ev.target.value);
                            if (isFinite(v)) setLibValue((s) => ({ ...s, [e.kind]: v }));
                          }} />
                        <span className="lib-card-val-u">${e.t.valueUnit || ''} — aanpasbaar bij plaatsen</span>
                      </span>`}
                    ${e.t && e.t.asset && html`
                      <span className="lib-card-actions">
                        <button className="btn ghost" onClick=${(ev) => { ev.stopPropagation(); removeAsset(assetIdOf(e.kind)); }}>Verwijderen</button>
                      </span>`}
                  </div>`)}
              </div>
            </section>`)}
        </div>

        <footer className="dialog-f">
          <span className="dialog-f-sel">Geselecteerd: <strong>${libEntry ? libEntry.label : '—'}</strong></span>
          ${libEntry && badgeOf(libEntry) && html`<span className="dialog-f-hint">${badgeOf(libEntry)}</span>`}
          ${libEntry && valueOf(libEntry) != null && html`
            <label className="dialog-f-val">
              <span>Waarde bij plaatsen</span>
              <input className="input" type="number" aria-label="Waarde bij plaatsen"
                min=${libEntry.t.valueMin == null ? 5 : libEntry.t.valueMin}
                max=${libEntry.t.valueMax == null ? 130 : libEntry.t.valueMax}
                step=${libEntry.t.valueStep == null ? 5 : libEntry.t.valueStep}
                value=${valueOf(libEntry)}
                onChange=${(ev) => {
                  const v = parseFloat(ev.target.value);
                  if (isFinite(v)) setLibValue((s) => ({ ...s, [libEntry.kind]: v }));
                }} />
              <span className="dialog-f-hint">${libEntry.t.valueUnit || ''}</span>
            </label>`}
          <span className="dialog-f-gap"></span>
          <span className="dialog-f-hint">Dubbelklik een kaart om direct te tekenen · Esc sluit</span>
          <button className="btn ghost" onClick=${() => setLibOpen(false)}>Sluiten</button>
          <button className="btn primary" disabled=${!libEntry} onClick=${() => libTake(libEntry)}>Tekenen</button>
        </footer>
      </div>
    </div>`;

  // The one control that is never hideable — hiding it would lock you out.
  // Locatie, Lagen en Preset live in this menu rather than in the left panel.
  // They answer "what am I looking at", not "what am I drawing", and in the
  // panel they pushed the two things you actually work in below the fold. Same
  // state, same handlers — only the place changed.
  const vmLocation = () => html`
    <div className="vm-group vm-wide">
      <div className="vm-h">Locatie</div>
      <form onSubmit=${(e) => { e.preventDefault(); doGeocode(); }} className="geo-form">
        <input type="text" placeholder="Zoek adres of plaats…" value=${geoSearch}
          onChange=${(e) => setGeoSearch(e.target.value)} />
        <button type="submit" className="btn" disabled=${geoBusy}>${geoBusy ? '…' : 'Ga'}</button>
      </form>
      ${geoMsg && html`<div className="geo-msg">${geoMsg}</div>`}
      <div className="geo-coord">📍 ${doc.geo.lat.toFixed(5)}, ${doc.geo.lon.toFixed(5)}</div>
      <div className="geo-coord" style=${{ marginTop: '6px' }}>
        ${mbToken ? html`🗺️ Kaart-token ✓ · <a href="#" onClick=${(e) => { e.preventDefault(); clearMbToken(); }} style=${{ color: 'var(--accent)' }}>wijzigen</a>` : '🗺️ Geen kaart-token'}
      </div>
      <div className="seg style-seg" style=${{ marginTop: '8px' }}>
        ${[['satellite', 'Satelliet'], ['streets', 'Straten'], ['standard', 'Standaard'], ['none', 'Geen']].map(([s, lbl]) => html`
          <button key=${s} className=${mapStyle === s ? 'active' : ''} onClick=${() => changeMapStyle(s)}>${lbl}</button>`)}
      </div>
      ${map3dError && html`<div className="geo-msg" style=${{ color: 'var(--danger)' }}>${map3dError}</div>`}
      ${mbToken && mapStyle !== 'none' && html`
        <div className="geo-coord" style=${{ marginTop: '8px' }}>
          <a href="#" onClick=${(e) => { e.preventDefault(); setDiagOpen(!diagOpen); }} style=${{ color: 'var(--accent)' }}>
            ${diagOpen ? '▾' : '▸'} Kaart-diagnose
          </a>
          ${' · '}
          <a href="#" onClick=${(e) => { e.preventDefault(); retryMap(); }} style=${{ color: 'var(--accent)' }}>opnieuw proberen</a>
        </div>
        ${diagOpen && html`
          <div className="map-diag">
            <div><span>WebGL</span><b>${mapDiag.webgl || '—'}</b></div>
            <div><span>Bibliotheek</span><b>${mapDiag.lib || '—'}</b></div>
            <div><span>Stijl</span><b>${mapDiag.style || '—'}</b></div>
            <div><span>Tegels</span><b>${mapDiag.tiles == null ? '—' : mapDiag.tiles}</b></div>
            <div><span>Canvas</span><b>${mapDiag.canvas || '—'}</b></div>
            <div><span>Build</span><b>${BUILD_ID}</b></div>
            ${mapDiag.detail && html`<div className="map-diag-detail">${mapDiag.detail}</div>`}
          </div>`}`}
    </div>`;
  const vmLayers = () => html`
    <div className="vm-group vm-wide">
      <div className="vm-h">Lagen <span className="vm-n">${Object.values(layers).filter(Boolean).length}</span></div>
      ${layerRow('grid', 'Raster', '#3b4453', layers, setLayers)}
      ${layerRow('site', 'Site-grens', '#f8b500', layers, setLayers)}
      ${layerRow('setback', 'Setback', '#6ee7ff', layers, setLayers)}
      ${layerRow('building', 'Gebouwen', '#64748b', layers, setLayers)}
      ${layerRow('parking', 'Parkeren', '#3b82f6', layers, setLayers)}
      ${layerRow('infra', 'Infrastructuur', '#0e7490', layers, setLayers)}
      ${layerRow('context', 'Omgeving (3D)', '#c3c8d2', layers, setLayers)}
      ${layerRow('shadow', 'Schaduw', '#334155', layers, setLayers)}
      ${layerRow('lightmap', 'Lichtkaart', '#f59e0b', layers, setLayers)}
      <div className="mix-note">Omgeving = de bestaande bebouwing rondom; die bestaat alleen in de 3D-weergave.</div>
    </div>`;
  const vmPreset = () => html`
    <div className="vm-group vm-wide">
      <div className="vm-h">Afmetingen-preset</div>
      <select className="preset" onChange=${(e) => applyPreset(e.target.value)}>
        <option value="">— kies afmetingen —</option>
        ${Object.entries(PRESETS).map(([k, p]) => html`<option key=${k} value=${k}>${p.label}</option>`)}
      </select>
    </div>`;

  const viewMenu = () => html`
    <div className="dropdown">
      <button className=${'btn ghost' + (viewMenuOpen ? ' active' : '')} onClick=${() => setViewMenuOpen((o) => !o)}
        title="Locatie, lagen, presets en welke onderdelen zichtbaar zijn">👁 Weergave ▾</button>
      ${viewMenuOpen && html`
        <div className="menu view-menu" onMouseLeave=${() => setViewMenuOpen(false)}>
          ${vmLocation()}
          ${vmLayers()}
          ${vmPreset()}
          <div className="vm-group">
            <div className="vm-h">Werkruimte</div>
            <div className="vm-row vm-actions">
              ${Object.keys(WORKSPACE_PRESETS).map((n) => html`
                <button key=${n} className="btn ghost" onClick=${() => applyWorkspace(n)}>${n}</button>`)}
            </div>
          </div>
          ${UI_GROUPS.map((g) => html`
            <div key=${g} className="vm-group">
              <div className="vm-h">${g}</div>
              ${UI_PARTS.filter((pt) => pt.group === g).map((pt) => html`
                <label key=${pt.id} className="vm-item">
                  <input type="checkbox" checked=${vis(pt.id)} onChange=${() => togglePart(pt.id)} />
                  <span>${pt.label}</span>
                </label>`)}
            </div>`)}
          <div className="vm-group">
            <div className="vm-h">Werkruimtes</div>
            ${Object.keys(workspaces).length === 0 && html`<div className="vm-empty">Nog geen eigen werkruimte opgeslagen.</div>`}
            ${Object.keys(workspaces).map((n) => html`
              <div key=${n} className="vm-row">
                <button className="btn ghost vm-ws" onClick=${() => applyWorkspace(n)}>${n}</button>
                <button className="btn ghost" title="Verwijderen" onClick=${() => deleteWorkspace(n)}>✕</button>
              </div>`)}
            <div className="vm-row">
              <input type="text" placeholder="Naam…" value=${wsName}
                onInput=${(e) => setWsName(e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter') saveWorkspace(); }} />
              <button className="btn" onClick=${saveWorkspace} disabled=${!wsName.trim()}>Bewaar</button>
            </div>
          </div>
        </div>`}
    </div>`;

  // ---------- Render UI ----------
  const hintText = {
    site: 'Klik om punten te plaatsen · Shift ingedrukt = uitlijnen per 15° · klik het eerste punt of dubbelklik om te sluiten · Esc annuleert',
    obstacle: 'Sleep een rechthoek voor een gebouw / uitsluitingszone',
    obstaclepoly: 'Klik punten voor een gebouw in vrije vorm · Shift = 15° · klik beginpunt of dubbelklik om te sluiten · Esc annuleert',
    pan: 'Sleep om te verschuiven',
    placestall: 'Klik om een parkeervak te plaatsen (snapt aan bestaande vakken) · Esc stopt',
    measure: 'Klik punten om af te meten · Shift = 15° · dubbelklik of Esc sluit af · toont lengte, totaal en oppervlak',
    annot: annotKind === 'road' && roadShape === 'rect'
      ? 'Weg-object: sleep een rechthoek · selecteer daarna en sleep de hoeken om te vergroten'
      : ANNOT_TYPES[annotKind] && ANNOT_TYPES[annotKind].mode === 'driveway'
      ? 'In/uitrit: klik op de siterand om te plaatsen · breedte instelbaar links · Esc stopt'
      : ANNOT_TYPES[annotKind] && ANNOT_TYPES[annotKind].mode === 'point'
      ? `${ANNOT_TYPES[annotKind].label}: klik om te plaatsen · Esc stopt`
      : ANNOT_TYPES[annotKind] && ANNOT_TYPES[annotKind].mode === 'area'
      ? `${ANNOT_TYPES[annotKind].label}: ${areaShape === 'poly' ? 'klik punten · dubbelklik/beginpunt sluit' : areaShape === 'circle' ? 'klik midden + sleep straal' : 'sleep een rechthoek'}`
      : ANNOT_TYPES[annotKind] && ANNOT_TYPES[annotKind].mode === 'cross'
        ? `${ANNOT_TYPES[annotKind].label}: klik begin- en eindpunt van de oversteek`
        : `${ANNOT_TYPES[annotKind] ? ANNOT_TYPES[annotKind].label : ''}: klik punten (snapt aan bestaande) · Shift = uitlijnen per 15° · dubbelklik = lijn · klik beginpunt = gesloten vlak/plein · Esc annuleert`,
    select: (stallSel.length || aisleSel || (selection && selection.type)) ? null
      : (doc.site.length < 3
        ? 'Geen site — kies "Site" (P) om er een te tekenen'
        : 'Klik de site-rand om te verplaatsen/verwijderen · rechtermuisklik op een rand voegt een punt toe · klik een vak of rijbaan om te markeren · sleep een kader voor meerdere objecten · Shift+klik voegt toe'),
  }[tool];
  // The placing mode swallows clicks, so it has to announce itself; a mode you
  // cannot see is a mode you get stuck in.
  const modeHint = placing
    ? 'Klik om de kopie neer te zetten · snapt op bestaande punten en lijnt uit · Esc of rechtsklik annuleert'
    : hintText;

  return html`
    <div className="app" style=${{
      '--left-w': (vis('panelLeft') ? panelW.left : 0) + 'px',
      '--right-w': (vis('panelRight') ? panelW.right : 0) + 'px',
    }}>
      <div className="toolbar">
        <div className="brand"><span className="brand-name">ParkPlanner</span></div>
        ${vis('tbProject') && html`
          <div className="tb-project">
            <input className="proj-name" type="text" value=${doc.name || ''} placeholder="Naamloos plan"
              title="Naam van dit plan — komt terug in de bestandsnaam bij Opslaan"
              onChange=${(e) => dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, name: e.target.value.slice(0, 60) }) })} />
            <span className="proj-meta">
              ${savedAt
                ? 'Laatst opgeslagen om ' + savedAt.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })
                : 'Nog niet opgeslagen in deze sessie'}
            </span>
          </div>`}
        ${/* The order is the design's: named tools, the measure icon, the library
              as the one accent button, then a spacer and the view cluster. No
              rules between groups — the spacer does that work. */ ''}
        ${vis('tbTools') && html`
          ${toolBtn('select', 'Selecteren', 'V', tool, setTool, setDrawing)}
          ${toolBtn('site', 'Site', 'P', tool, setTool, setDrawing)}
          ${toolBtn('obstacle', 'Gebouw ▭', 'B', tool, setTool, setDrawing)}
          ${toolBtn('obstaclepoly', 'Gebouw ⬠', 'N', tool, setTool, setDrawing)}
          ${toolBtn('placestall', 'Vak +', 'K', tool, setTool, setDrawing)}
          ${toolBtn('pan', 'Pan', '␣', tool, setTool, setDrawing)}
          <button className=${'btn icon' + (tool === 'measure' ? ' active' : '')} aria-label="Meetlint"
            title="Meetlint (M)"
            onClick=${() => { setTool('measure'); setMeasure({ points: [] }); setDrawing(null); }}>📏</button>`}
        ${vis('tbLibrary') && html`
          <button className=${'btn primary icon' + (libOpen ? ' active' : '')} onClick=${() => libOpenRef.current()}
            aria-label="Teken infrastructuur" title="Teken infrastructuur (T) — alles wat je kunt tekenen, met voorbeeldweergave">▦</button>`}
        <div className="tb-spacer"></div>
        ${vis('tbAxis') && html`
          <button className="btn ghost" onClick=${cycleAxis} title="Wissel rij-oriëntatie">↻ Rij-as${result.orientationCount ? html` <span className="tb-n">${doc.orientationIndex + 1}/${result.orientationCount}</span>` : ''}</button>
          ${/* Only once you have moved off the default: with nothing to undo the
                button is furniture, and the design's bar does not carry it. */ ''}
          ${(doc.orientationIndex || 0) !== 0 && html`
            <button className="btn ghost icon" onClick=${resetAxis}
              title="Rij-as terugzetten op de standaard" aria-label="Rij-as terugzetten">↺</button>`}`}
        ${vis('tbView') && html`
          <div className="seg view-seg">
            ${[['2d', '2D'], ['3d', '3D']].map(([m, lbl]) => html`
              <button key=${m} className=${viewMode === m ? 'active' : ''} onClick=${() => setViewMode(m)}>${lbl}</button>`)}
          </div>`}
        ${vis('tbZoom') && html`
          <button className="btn ghost" onClick=${fitToSite} title="Zoom naar de hele site">⤢ Fit</button>`}
        ${viewMenu()}
        ${vis('tbUndo') && html`
          <button className="btn ghost icon" title="Ongedaan maken (Cmd/Ctrl+Z)" aria-label="Ongedaan maken"
            onClick=${() => dispatch({ type: 'UNDO' })} disabled=${!hist.past.length}>↶</button>
          <button className="btn ghost icon" title="Opnieuw (Shift+Cmd/Ctrl+Z)" aria-label="Opnieuw"
            onClick=${() => dispatch({ type: 'REDO' })} disabled=${!hist.future.length}>↷</button>`}
        ${/* One dropdown for everything that reads or writes a file, the way the
              design has a single save icon and a single export icon. Zes losse
              knoppen namen een tweede rij. */ ''}
        ${vis('tbFile') && html`
        <div className="dropdown">
          <button className=${'btn ghost icon' + (fileOpen ? ' active' : '')} onClick=${() => setFileOpen((o) => !o)}
            title="Plan — opslaan, laden, delen, nieuw" aria-label="Plan">💾</button>
          ${fileOpen && html`
            <div className="menu" onMouseLeave=${() => setFileOpen(false)}>
              <button onClick=${() => { saveJSON(); setFileOpen(false); }}>Opslaan als JSON</button>
              <label className="menu-file">Plan laden…<input type="file" accept="application/json"
                onChange=${(e) => { loadJSON(e); setFileOpen(false); }} style=${{ display: 'none' }} /></label>
              <label className="menu-file">Perceelgrens importeren…<input type="file"
                accept=".geojson,.json,.kml,application/geo+json,application/vnd.google-earth.kml+xml"
                onChange=${(e) => { importParcel(e); setFileOpen(false); }} style=${{ display: 'none' }} /></label>
              ${vis('tbShare') && html`<button onClick=${() => { shareLink(); setFileOpen(false); }}>🔗 Deelbare link kopiëren</button>`}
              ${vis('tbNewSite') && html`<button onClick=${() => { newRect(); setFileOpen(false); }}>Nieuw leeg perceel</button>`}
            </div>`}
        </div>`}
        ${vis('tbExport') && html`
        <div className="dropdown">
          <button className=${'btn ghost icon' + (exportOpen ? ' active' : '')} onClick=${() => setExportOpen((o) => !o)}
            title="Export (PNG, GeoJSON, DXF, CSV)" aria-label="Export">⬆</button>
          ${exportOpen && html`
            <div className="menu" onMouseLeave=${() => setExportOpen(false)}>
              <button onClick=${() => { exportPNG(); setExportOpen(false); }}>PNG-afbeelding</button>
              <button onClick=${() => { exportGeoJSON(); setExportOpen(false); }}>GeoJSON</button>
              <button onClick=${() => { exportDXF(); setExportOpen(false); }}>DXF (CAD)</button>
              <button onClick=${() => { exportCSV(); setExportOpen(false); }}>CSV (takeoff)</button>
            </div>`}
        </div>`}
        <button className="btn ghost icon" title="Sneltoetsen (?)" aria-label="Sneltoetsen"
          onClick=${() => setKeysOpen(true)}>?</button>
      </div>

      ${vis('panelLeft') && html`
      <div className="panel left tk-scroll" ref=${leftPanelRef}>
        ${resizer('left')}
        ${panelFold('panelLeft', 'Linkerpaneel')}
        ${/* Options for whatever tool is active, at the very top of the panel.
              They used to sit under the palette — 2000 px below the fold, so
              the building-type choice existed and could never be found. */ ''}
        ${vis('secToolOpts') && html`
        <div className="section tool-opts">
          <h3>${tool === 'annot' ? ANNOT_TYPES[annotKind].label : tool === 'obstacle' || tool === 'obstaclepoly' ? 'Gebouw' : 'Gereedschapsopties'}</h3>
          ${/* Full width under the help line, not squeezed into the heading: at
                the panel's default 210 px it was clipped to "▦ Bi". */ ''}
          <button className="btn primary lib-open" onClick=${() => openLib()}
            title="Alles wat je kunt tekenen, met voorbeeldweergave">▦ Bibliotheek <kbd>T</kbd></button>
          ${/* What this tool is for, in one line. The same sentence the library
                card shows, so a tool never means two different things. With no
                drawing tool active this section is where the hint lives — the
                design has it always present, and an empty panel says nothing. */ ''}
          <div className="tool-help">${tool === 'annot' ? descOf(annotKind) : TOOL_HELP[tool] || TOOL_HELP.select}</div>
          <div className="toggle" style=${{ marginTop: '4px' }}>
            <span>Vastklikken <span style=${{ color: 'var(--muted)', fontSize: '11px' }}>S</span></span>
            <input type="checkbox" checked=${snapOn} onChange=${(e) => setSnapOn(e.target.checked)} />
          </div>
          <div className="mix-note" style=${{ marginTop: 0 }}>
            ${snapOn
              ? 'Punten klikken vast op bestaande hoekpunten, vakken langs een weg of tegen hun buren.'
              : 'Uit — alles gaat exact waar je klikt.'}
          </div>
          ${(tool === 'obstacle' || tool === 'obstaclepoly') && html`
            <div>
          ${/* Ten styles will not fit a segmented control, so this is the same
                grid the materials use, grouped by family. */ ''}
          <button className="btn primary lib-open" onClick=${() => openLib('build')}
            title="Alle gebouwstijlen, met voorbeeldweergave">▦ Gebouwstijlen</button>
          <div className="type-grid">
            ${Object.values(BUILDING_USES).map((u) => html`
              <button key=${u.key} className=${'type-btn' + (buildUse === u.key ? ' active' : '')}
                title=${(u.keywords || '') + ' · ' + u.floors + ' verd. × ' + u.floorH + ' m'}
                onClick=${() => setBuildUse(u.key)}>
                <span className="dot" style=${{ background: (MATERIALS[u.material] || MATERIALS.render).tint }}></span>${u.label}
              </button>`)}
          </div>
          <label style=${{ display: 'block', marginTop: '10px' }}>Gevel</label>
          <div className="type-grid">
            ${Object.values(MATERIALS).map((m) => html`
              <button key=${m.key} className=${'type-btn' + ((buildMat || DEFAULT_MATERIAL[buildUse]) === m.key ? ' active' : '')}
                onClick=${() => setBuildMat(m.key)}>
                <span className="dot" style=${{ background: m.tint }}></span>${m.label}
              </button>`)}
          </div>
          <div className="mix-note">
            ${styleOf(buildUse).floors} verdieping${styleOf(buildUse).floors > 1 ? 'en' : ''} × ${styleOf(buildUse).floorH} m standaard ·
            het exterieur volgt de vorm, dus een hoek verslepen hertekent het.
          </div>
            </div>`}
          ${tool === 'annot' && annotKind === 'driveway' && html`
            <div className="field" style=${{ marginTop: '10px', marginBottom: 0 }}>
              <label>Breedte in/uitrit</label>
              <div className="row">
                <input type="number" min="3" max="20" step="0.5" value=${annotWidth}
                  onChange=${(e) => setAnnotWidth(Math.max(3, Math.min(20, parseFloat(e.target.value) || 6.5)))} />
                <span style=${{ alignSelf: 'center', color: 'var(--muted)', fontSize: '12px' }}>m</span>
              </div>
              <div className="mix-note">Klik op de siterand om te plaatsen — de in/uitrit snapt op de rand.</div>
            </div>`}
          ${tool === 'annot' && ANNOT_TYPES[annotKind].mode === 'area' && html`
            <div className="field" style=${{ marginTop: '10px', marginBottom: 0 }}>
              <label>Vorm</label>
              <div className="seg">
                <button className=${areaShape === 'poly' ? 'active' : ''} onClick=${() => setAreaShape('poly')}>Veelhoek</button>
                <button className=${areaShape === 'rect' ? 'active' : ''} onClick=${() => setAreaShape('rect')}>Rechthoek</button>
                <button className=${areaShape === 'circle' ? 'active' : ''} onClick=${() => setAreaShape('circle')}>Cirkel</button>
              </div>
              <div className="mix-note">${areaShape === 'poly' ? 'Klik punten · klik beginpunt of dubbelklik om te sluiten.' : areaShape === 'circle' ? 'Klik het midden en sleep voor de straal.' : 'Sleep een rechthoek.'}</div>
            </div>`}
          ${tool === 'annot' && annotKind === 'road' && html`
            <div className="field" style=${{ marginTop: '10px', marginBottom: 0 }}>
              <label>Weg tekenen als</label>
              <div className="seg">
                <button className=${roadShape === 'line' ? 'active' : ''} onClick=${() => setRoadShape('line')}>Lijn</button>
                <button className=${roadShape === 'rect' ? 'active' : ''} onClick=${() => setRoadShape('rect')}>Object</button>
                <button className=${roadShape === 'multi' ? 'active' : ''} onClick=${() => setRoadShape('multi')}>Multipoint</button>
              </div>
              <div className="mix-note">${roadShape === 'rect'
                ? 'Klik om een weg van vaste maat neer te zetten. Daarna: breedte in het veld, lengte aan de kopse grepen, draaien aan de oranje greep.'
                : roadShape === 'multi'
                  ? 'Klik punten voor een vrij gevormd wegvlak. Niet rijdbaar — het materiaal bepaalt of het als verhard telt.'
                  : 'Klik punten voor een weglijn.'}</div>
            </div>`}
          ${tool === 'annot' && (roadShape === 'multi' || ANNOT_TYPES[annotKind].mode === 'area' || ANNOT_TYPES[annotKind].body) && html`
            <div className="field" style=${{ marginTop: '10px', marginBottom: 0 }}>
              <label>Ondergrond</label>
              <div className="mat-grid">
                <button className=${'type-btn' + (annotMaterial === '' ? ' active' : '')} onClick=${() => setAnnotMaterial('')}>Standaard</button>
                ${Object.values(SURFACES).map((m) => html`
                  <button key=${m.key} className=${'type-btn' + (annotMaterial === m.key ? ' active' : '')}
                    title=${`Afstroming ${m.runoff.toFixed(2)}`} onClick=${() => setAnnotMaterial(m.key)}>
                    <span className="dot" style=${{ background: m.tint }}></span>${m.label}
                  </button>`)}
              </div>
              <div className="mix-note">${annotMaterial
                ? `Afstroming ${SURFACES[annotMaterial].runoff.toFixed(2)} — ${SURFACES[annotMaterial].runoff >= 1 ? 'telt volledig als verhard' : `telt voor ${Math.round(SURFACES[annotMaterial].runoff * 100)} % mee als verhard`}.`
                : 'Geen keuze — telt volledig als verhard, zoals voorheen.'}</div>
            </div>`}
          ${tool === 'annot' && annotKind === 'road' && roadShape === 'rect' && html`
            <div className="field" style=${{ marginTop: '10px', marginBottom: 0 }}>
              <label>Lengte <span className="val">${annotLength.toFixed(1)} m</span></label>
              <input type="range" min="3" max="120" step="0.5" value=${annotLength}
                onInput=${(e) => setAnnotLength(+e.target.value)} />
              <label style=${{ marginTop: '8px' }}>Draaiing <span className="val">${annotRot}°</span></label>
              <input type="range" min="0" max="355" step="5" value=${annotRot}
                onInput=${(e) => setAnnotRot(+e.target.value)} />
            </div>`}
          ${tool === 'annot' && ANNOT_TYPES[annotKind].body && !(annotKind === 'road' && roadShape === 'rect') && html`
            <div className="field" style=${{ marginTop: '10px', marginBottom: 0 }}>
              <label>De lijn is</label>
              <div className="seg">
                <button className=${annotAlign === 'center' ? 'active' : ''} onClick=${() => setAnnotAlign('center')}>Hartlijn</button>
                <button className=${annotAlign === 'left' ? 'active' : ''} onClick=${() => setAnnotAlign('left')}>Linkerrand</button>
                <button className=${annotAlign === 'right' ? 'active' : ''} onClick=${() => setAnnotAlign('right')}>Rechterrand</button>
              </div>
              <div className="mix-note">${annotAlign === 'center'
                ? 'De weg ligt half links en half rechts van je lijn.'
                : 'De weg ligt volledig aan de ' + (annotAlign === 'left' ? 'rechter' : 'linker') + 'kant van je lijn, gezien in de richting waarin je tekent — teken langs een gevel of perceelgrens.'}</div>
            </div>`}
          ${tool === 'annot' && ANNOT_TYPES[annotKind].mode !== 'area' && ANNOT_TYPES[annotKind].mode !== 'driveway' && !(annotKind === 'road' && roadShape === 'rect') && html`
            <div className="field" style=${{ marginTop: '10px', marginBottom: 0 }}>
              <label>${annotKind === 'tree' ? 'Kroondiameter' : annotKind === 'access' ? 'Poortbreedte' : 'Breedte'}<span className="val">${annotWidth.toFixed(1)} m</span></label>
              <input type="range" min=${ANNOT_TYPES[annotKind].mode === 'point' ? 1 : 0.2} max=${ANNOT_TYPES[annotKind].mode === 'point' ? 15 : 12} step="0.1" value=${annotWidth}
                onInput=${(e) => setAnnotWidth(parseFloat(e.target.value))} />
              ${ANNOT_TYPES[annotKind].mode === 'line' && html`
                <label className="toggle" style=${{ marginTop: '8px' }}>
                  <span>Vloeiende bochten</span>
                  <input type="checkbox" checked=${annotCurved} onChange=${(e) => setAnnotCurved(e.target.checked)} />
                </label>`}
            </div>`}
        </div>`}
        ${vis('secDraw') && html`
        <div className="section">
          <h3>Gereedschapslijst</h3>
          <input className="tool-search" type="search" placeholder="Zoek gereedschap…  /"
            ref=${toolSearchRef} value=${toolQuery} onInput=${(e) => setToolQuery(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Escape') { setToolQuery(''); e.target.blur(); } }} />
          ${paletteGroups.length === 0 && html`<div className="mix-note">Niets gevonden voor "${toolQuery}".</div>`}
          ${paletteGroups.map(([grp, items]) => html`
            <div className="tool-group" key=${grp}>
              <button className="tool-group-h" onClick=${() => toggleGroup(grp)}>
                <span>${openGroups[grp] === false && !toolQuery ? '▸' : '▾'} ${grp}</span>
                <span className="tool-group-n">${items.length}</span>
              </button>
              ${(openGroups[grp] !== false || toolQuery) && html`
                <div className="type-grid">
                  ${items.map(([k, t]) => html`
                    <button key=${k} title=${t.keywords || t.label}
                      className=${'type-btn' + (tool === 'annot' && annotKind === k ? ' active' : '')}
                      onClick=${() => startAnnot(k)}>
                      <span className="dot" style=${dotStyle(t)}></span>${t.label}
                    </button>`)}
                </div>`}
            </div>`)}
        </div>`}
        ${vis('secAssets') && html`
        <div className="section">
          <h3>Eigen assets <span className="obj-count">${assetLib.length}</span></h3>
          <label className="btn ghost asset-import">
            Symbool importeren…
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange=${importAsset} style=${{ display: 'none' }} />
          </label>
          ${assetMsg && html`<div className="asset-msg">${assetMsg}</div>`}
          ${assetLib.length === 0 && html`<div className="mix-note">
            PNG, JPG, WebP of SVG. Het beeld wordt verkleind tot ${ASSET_MAX_PX} px en verschijnt in het palet onder "Eigen".
          </div>`}
          ${assetLib.map((a) => html`
            <div className="asset-row" key=${a.id}>
              <span className="asset-thumb" style=${{ backgroundImage: 'url(' + a.src + ')' }}></span>
              <div className="asset-body">
                <input className="asset-name" type="text" value=${a.name}
                  onChange=${(e) => patchAsset(a.id, { name: e.target.value.slice(0, 40) })} />
                <div className="asset-meta">
                  <span>${a.w}×${a.h}</span>
                  <label>H
                    <input type="number" min="0" max="60" step="0.5" value=${a.height}
                      onChange=${(e) => patchAsset(a.id, { height: Math.max(0, Math.min(60, parseFloat(e.target.value) || 0)) })} />
                    m
                  </label>
                  <span>${Math.round((a.src || '').length / 1024)} kB</span>
                </div>
              </div>
              <button className="obj-x" title="Uit bibliotheek verwijderen"
                onClick=${() => removeAsset(a.id)}>✕</button>
            </div>`)}
          ${assetLib.length > 0 && html`<div className="mix-note">
            ${Math.round(assetLibChars(assetLib) / 1024)} van ${Math.round(ASSET_LIB_MAX_CHARS / 1024)} kB gebruikt ·
            verwijderen laat geplaatste exemplaren staan · hoogte geldt voor 3D.
          </div>`}
        </div>`}
        ${vis('secObjects') && html`
        <div className="section">
          <h3>Objecten <span className="obj-count">${objectRows.reduce((n, g) => n + g[1].length, 0)}</span></h3>
          <input className="tool-search" type="search" placeholder="Zoek object…"
            value=${objQuery} onInput=${(e) => setObjQuery(e.target.value)} />
          ${objectRows.length === 0 && html`<div className="mix-note">Nog niets geplaatst.</div>`}
          ${aislesRemovedCount > 0 && html`
            <div className="mix-note" style=${{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>${aislesRemovedCount} rijbaan${aislesRemovedCount > 1 ? 'en' : ''} verwijderd</span>
              <button className="btn ghost" style=${{ padding: '2px 8px' }} onClick=${restoreAisles}>Herstel</button>
            </div>`}
          ${objectRows.map(([grp, rows]) => html`
            <div className="tool-group" key=${grp}>
              <div className="tool-group-h" style=${{ cursor: 'default' }}>
                <span>${grp}</span><span className="tool-group-n">${rows.length}</span>
              </div>
              ${rows.map((r) => (objEdit === r.key ? html`
                <div key=${r.key} className="obj-row editing">
                  <span className="dot" style=${r.type ? dotStyle(r.type) : { background: r.color }}></span>
                  <input className="obj-name" type="text" autoFocus
                    defaultValue=${r.custom || ''} placeholder=${r.label}
                    title="Eigen naam · leeg laten geeft de standaardnaam terug"
                    onKeyDown=${(e) => {
                      if (e.key === 'Enter') { renameRow(r, e.target.value); setObjEdit(''); }
                      if (e.key === 'Escape') { e.stopPropagation(); setObjEdit(''); }
                    }}
                    onBlur=${(e) => { renameRow(r, e.target.value); setObjEdit(''); }} />
                </div>` : html`
                <div key=${r.key} className=${'obj-row' + (isRowSelected(r) ? ' active' : '')}
                  onClick=${() => selectRow(r)}
                  onDoubleClick=${() => { selectRow(r); focusPoly(rowPoly(r)); }}
                  title=${(r.custom ? r.custom + ' — ' + r.label + ' · ' : '') + 'klik selecteert · dubbelklik brengt in beeld'}>
                  <span className="dot" style=${r.type ? dotStyle(r.type) : { background: r.color }}></span>
                  <span className=${'obj-label' + (r.custom ? ' named' : '')}>${r.custom || r.label}</span>
                  <span className="obj-sub">${r.sub}</span>
                  ${canRename(r) && html`
                    <button className="obj-x" title="Naam geven"
                      onClick=${(e) => { e.stopPropagation(); setObjEdit(r.key); }}>✎</button>`}
                  ${r.kind !== 'stallGroup' && html`
                    <button className="obj-x" title="Verwijderen"
                      onClick=${(e) => { e.stopPropagation(); deleteRow(r); }}>✕</button>`}
                </div>`))}
            </div>`)}
        </div>`}

        ${vis('secSiteShape') && html`
        <div className="section">
          <h3>Site-vorm</h3>
          <div className="toggle" style=${{ marginBottom: 0 }}>
            <span>Vloeiende bochten (spline)</span>
            <input type="checkbox" checked=${!!doc.siteCurved}
              onChange=${(e) => dispatch({ type: 'COMMIT', updater: (d) => ({
                ...d, siteCurved: e.target.checked,
                // On enabling curves, switch a straight layout to the hybrid
                // "edge follows the curve + straight middle" default.
                params: e.target.checked && (d.params.layout || 'strip') === 'strip'
                  ? { ...d.params, layout: 'hybrid' } : d.params,
              }) })} />
          </div>
        </div>`}
        ${vis('secFoot') && html`<div className="foot">
          Open-source demonstrator van een parametrische parkeer­generator, geïnspireerd op TestFit's Parking Solver.
          De solver draait volledig in de browser: setback-offset → oriëntatie­zoektocht → strip-packing van dubbel-belaste modules.
        </div>`}
      </div>`}

      <div className="canvas-wrap" ref=${wrapRef}>
        <div id="pp-map" className="pp-map"></div>
        ${!vis('panelLeft') && panelReopen('panelLeft', 'Linkerpaneel')}
        ${!vis('panelRight') && panelReopen('panelRight', 'Rechterpaneel')}
        ${askJunction && viewMode === '2d' && (() => {
          const { w2s } = makeTransform(view);
          const p = w2s(askJunction.at);
          const anns = doc.annotations || [];
          // Numbered, because two roads crossing are both called "Weg" and a
          // choice between two identical buttons is not a choice.
          const nameOf = (i) => ((ANNOT_TYPES[(anns[i] || {}).kind] || {}).label || 'weg') + ' ' + (i + 1);
          return html`
            <div className="cross-ask" style=${{ left: Math.round(p.x) + 'px', top: Math.round(p.y) + 'px' }}>
              <div className="cross-ask-h">Kruising · ${nameOf(askJunction.i)} × ${nameOf(askJunction.j)}</div>
              <button className="btn" onClick=${() => setJunction(askJunction, 'merged')}>Kruispunt</button>
              <button className="btn ghost" onClick=${() => { setPickArm(askJunction); setAskJunction(null); }}>
                Onderbreking — klik de tak aan
              </button>
              <button className="btn ghost" onClick=${() => setJunction(askJunction, 'none')}>Niet koppelen</button>
              <button className="cross-ask-x" title="Later beslissen" onClick=${() => setAskJunction(null)}>✕</button>
            </div>`;
        })()}
        ${pickArm && html`
          <button className="cross-pending" onClick=${() => setPickArm(null)}>
            Klik de tak die dicht moet — Esc annuleert
          </button>`}
        ${openCrossings.length > 0 && !askJunction && !pickArm && html`
          <button className="cross-pending" onClick=${() => setAskJunction(openCrossings[0])}>
            ${openCrossings.length} onbesliste kruising${openCrossings.length > 1 ? 'en' : ''} — beslissen
          </button>`}
        ${shareMsg && html`
          <div className="share-bar">
            <span>${shareMsg}</span>
            <button className="cross-ask-x" title="Sluiten" onClick=${() => setShareMsg('')}>✕</button>
          </div>`}
        ${staleBuild && html`
          <div className="stale-bar">
            <span>Nieuwe versie beschikbaar — je tab draait build <b>${BUILD_ID}</b>, live staat <b>${staleBuild}</b>.</span>
            <button className="btn" onClick=${() => window.location.reload(true)}>Herladen</button>
          </div>`}
        <canvas ref=${canvasRef}
          onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp}
          onDoubleClick=${onDoubleClick} onContextMenu=${onContextMenu}
          style=${{ pointerEvents: viewMode === '3d' ? 'none' : 'auto', cursor: tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }} />
        ${vis('ovHint') && viewMode === '2d' && modeHint && html`<div className="hint">${modeHint}</div>`}
        ${vis('ovHint') && viewMode === '3d' && html`<div className="hint">3D · sleep om te draaien/kantelen · scroll om te zoomen · alleen-lezen</div>`}
        ${vis('ovHud') && html`<div className="hud" style=${{ bottom: (dealbarOpen ? 96 : 12) + 'px' }}>
          <span><b>${metrics.total}</b> vakken</span>
          <span>·</span>
          <span>schaal <b>${ratioScale(view.scale)}</b></span>
          <span>·</span>
          <span title=${view.scale.toFixed(2) + ' px/m'}>${view.scale.toFixed(1)} px/m</span>
          <span>·</span>
          <span>${solving ? 'rekenen…' : 'live'}</span>
          ${tool === 'placestall' && html`
            <span>·</span>
            <span className="hud-rot">gedraaid <b>${stallRot}°</b>${stallRot ? '' : ' · R draait 15°'}</span>`}
        </div>`}
        ${vis('ovAttrib') && mbToken && mapStyle !== 'none' && !map3dError && html`<div className="attrib" style=${{ bottom: (dealbarOpen ? 96 : 6) + 'px' }}>© Mapbox © OpenStreetMap</div>`}

        ${vis('ovDealbar') && html`
          <div className=${'dealbar' + (dealbarOpen ? '' : ' closed')}>
            <button className="dealbar-toggle" onClick=${() => setDealbarOpen((o) => !o)}>${dealbarOpen ? '▾ Tabulatie verbergen' : '▴ Tabulatie tonen'}</button>
            ${dealbarOpen && html`
              <div className="dealbar-cols">
                <div className="deal-col">
                  <div className="deal-h">Site</div>
                  <div className="deal-row"><span>Oppervlak</span><b>${fmt(metrics.siteArea)} m²</b></div>
                  <div className="deal-row"><span>Bebouwd</span><b>${(metrics.coverage * 100).toFixed(0)}%</b></div>
                  <div className="deal-row"><span>Verhard</span><b>${(metrics.imperviousPct * 100).toFixed(0)}%</b></div>
                  <div className="deal-row"><span>FAR</span><b>${metrics.far.toFixed(2)}</b></div>
                </div>
                <div className="deal-col">
                  <div className="deal-h">Gebouw</div>
                  <div className="deal-row"><span>Voetafdruk</span><b>${fmt(metrics.buildingArea)} m²</b></div>
                  <div className="deal-row"><span>Vloeropp. (GLA)</span><b>${fmt(metrics.grossFloorArea)} m²</b></div>
                  <div className="deal-row"><span>Beschikbaar</span><b>${fmt(metrics.buildableArea)} m²</b></div>
                </div>
                <div className="deal-col">
                  <div className="deal-h">Parking</div>
                  <div className="deal-row"><span>Plaatsen</span><b>${metrics.total}</b></div>
                  <div className="deal-row"><span>Fysieke vakken</span><b>${metrics.physicalStalls}</b></div>
                  <div className="deal-row"><span>m² / vak</span><b>${metrics.areaPerStall ? metrics.areaPerStall.toFixed(1) : '—'}</b></div>
                  <div className="deal-row"><span>Rijstroken</span><b>${metrics.aisleCount}</b></div>
                </div>
                <div className="deal-col">
                  <div className="deal-h">Toegankelijk</div>
                  <div className="deal-row"><span>Minder-valide</span><b>${metrics.adaProvided}/${metrics.adaRequired}</b></div>
                  <div className="deal-row"><span>Toegangspunten</span><b>${metrics.accessCount}</b></div>
                  <div className="deal-row"><span>Oriëntaties</span><b>${metrics.orientationCount}</b></div>
                </div>
                ${metrics.requiredStalls != null && html`
                <div className="deal-col">
                  <div className="deal-h">Zoning</div>
                  <div className="deal-row"><span>Vereist</span><b>${metrics.requiredStalls}</b></div>
                  <div className="deal-row"><span>Geleverd</span><b>${metrics.total}</b></div>
                  <div className="deal-row"><span>Saldo</span><b className=${metrics.total >= metrics.requiredStalls ? 'ok' : 'bad'}>${metrics.total - metrics.requiredStalls >= 0 ? '+' : ''}${metrics.total - metrics.requiredStalls}</b></div>
                </div>`}
              </div>`}
          </div>`}

        ${!mbToken && mapStyle !== 'none' && html`
          <div className="token-panel">
            <h4>🗺️ Mapbox-kaart activeren</h4>
            <p>De planner draait op een Mapbox Standard-kaart. Voer je eigen Mapbox <b>public token</b> (pk.…) in — die blijft lokaal in je browser.</p>
            <input type="text" placeholder="pk.eyJ…" value=${mbTokenInput} onInput=${(e) => setMbTokenInput(e.target.value)} />
            <div className="sel-actions">
              <button className="btn" onClick=${saveMbToken}>Kaart starten</button>
            </div>
            <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noopener">Gratis token aanmaken →</a>
          </div>`}
        ${mbToken && map3dError && !mapErrHidden && html`
          <div className="token-panel">
            <button className="token-x" title="Wegklikken" onClick=${() => setMapErrHidden(true)}>✕</button>
            <h4>Kaart niet beschikbaar</h4>
            <p>${map3dError}</p>
            <div className="sel-actions">
              <button className="btn" onClick=${clearMbToken}>Andere token invoeren</button>
            </div>
          </div>`}
      </div>

      ${vis('panelRight') && html`
      <div className="panel right tk-scroll">
        ${resizer('right')}
        ${panelFold('panelRight', 'Rechterpaneel', html`
          <input className="panel-search" type="search" placeholder="Zoek in dit paneel…"
            value=${panelQuery} onInput=${(e) => setPanelQuery(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); setPanelQuery(''); e.target.blur(); } }} />`)}
        ${panelQuery.trim() && !SEC_ORDER.some((s) => secShow(s[0], s[1])) && html`
          <div className="section"><div className="mix-note" style=${{ margin: 0 }}>Geen sectie gevonden voor "${panelQuery}".</div></div>`}
        ${multiCount > 1 && html`
        <div className="section sel-section">
          <h3>${multiCount} objecten geselecteerd</h3>
          <p className="multi-sub">
            ${[multiSel.anns.length && multiSel.anns.length + ' getekend', multiSel.obs.length && multiSel.obs.length + ' gebouw' + (multiSel.obs.length > 1 ? 'en' : ''), stallSel.length && stallSel.length + ' vak' + (stallSel.length > 1 ? 'ken' : '')].filter(Boolean).join(' · ')}
          </p>
          <div className="sel-actions">
            <button className="btn" onClick=${() => startPlacing(groupCopies())}>⧉ Dupliceren</button>
            <button className="btn ghost" onClick=${copySelection}>Kopiëren</button>
            <button className="btn ghost" onClick=${deleteGroup}>🗑 Verwijderen</button>
            <button className="btn ghost" onClick=${() => { setMultiSel({ anns: [], obs: [] }); setStallSel([]); }}>Deselecteer</button>
          </div>
          <div className="mix-note" style=${{ marginTop: 8 }}>Na dupliceren hangt de groep aan de cursor: klik om neer te zetten, Esc of rechtsklik om te annuleren.</div>
        </div>`}
        ${selection && selection.type === 'site' && html`
        <div className="section sel-section">
          <h3>Site geselecteerd</h3>
          <p style=${{ fontSize: '12px', color: 'var(--muted)', margin: '0 0 10px' }}>Sleep de rand om te verplaatsen · Delete om te verwijderen.</p>
          <div className="sel-actions">
            <button className="btn" onClick=${() => { dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, site: [] }) }); setSelection(null); }}>🗑 Verwijder site</button>
            <button className="btn ghost" onClick=${() => setSelection(null)}>Deselecteer</button>
          </div>
        </div>`}
        ${selection && selection.type === 'annot' && doc.annotations[selection.index] && html`
        <div className="section sel-section">
          <h3>${(ANNOT_TYPES[doc.annotations[selection.index].kind] || { label: 'Object' }).label} geselecteerd</h3>
          ${(() => {
            const ai = selection.index, ann = doc.annotations[ai];
            const t = ANNOT_TYPES[ann.kind] || {};
            if (!t.picto) return null;
            return html`
              <div className="field">
                <label>Hoek <span className="val">${Math.round(ann.angle || 0)}°</span></label>
                <input type="range" min="0" max="359" step="5" value=${Math.round(ann.angle || 0)}
                  onInput=${(e) => updateAnnotation(ai, { angle: +e.target.value })} />
                <div className="mix-note">R draait 15° · Shift+R terug</div>
              </div>
              <div className="field">
                <label>Grootte <span className="val">${(ann.width || t.width || 3).toFixed(1)} m</span></label>
                <input type="range" min="1" max="12" step="0.2" value=${ann.width || t.width || 3}
                  onInput=${(e) => updateAnnotation(ai, { width: +e.target.value })} />
              </div>
              ${t.value != null && html`
                <div className="field">
                  <label>${t.valueLabel || 'Waarde (km/u)'}</label>
                  <input type="number" min=${t.valueMin == null ? 5 : t.valueMin}
                    max=${t.valueMax == null ? 130 : t.valueMax}
                    step=${t.valueStep == null ? 5 : t.valueStep}
                    value=${ann.value != null ? ann.value : t.value}
                    onChange=${(e) => updateAnnotation(ai, { value: +e.target.value })} />
                </div>`}`;
          })()}
          ${doc.annotations[selection.index].kind === 'driveway' && html`
            <div className="field">
              <label>Breedte</label>
              <div className="row">
                <input type="number" min="3" max="20" step="0.5" value=${doc.annotations[selection.index].width || 6.5}
                  onChange=${(e) => setDrivewayWidth(selection.index, Math.max(3, Math.min(20, parseFloat(e.target.value) || 6.5)))} />
                <span style=${{ alignSelf: 'center', color: 'var(--muted)', fontSize: '12px' }}>m</span>
              </div>
            </div>`}
          ${(() => {
            const a = doc.annotations[selection.index], ai = selection.index;
            const t = ANNOT_TYPES[a.kind] || {};
            if (!(t.mode === 'area' || t.body || a.shape)) return '';
            const cur = a.material || '';
            return html`
              <div className="field">
                <label>Ondergrond</label>
                <div className="mat-grid">
                  <button className=${'type-btn' + (cur === '' ? ' active' : '')}
                    onClick=${() => updateAnnotation(ai, { material: undefined })}>Standaard</button>
                  ${Object.values(SURFACES).map((m) => html`
                    <button key=${m.key} className=${'type-btn' + (cur === m.key ? ' active' : '')}
                      title=${`Afstroming ${m.runoff.toFixed(2)}`}
                      onClick=${() => updateAnnotation(ai, { material: m.key })}>
                      <span className="dot" style=${{ background: m.tint }}></span>${m.label}
                    </button>`)}
                </div>
                <div className="mix-note">${cur
                  ? `Afstroming ${SURFACES[cur].runoff.toFixed(2)} — telt voor ${Math.round(SURFACES[cur].runoff * 100)} % mee als verhard oppervlak.`
                  : 'Geen keuze — telt volledig als verhard.'}</div>
              </div>`;
          })()}
          ${isRoadObject(doc.annotations[selection.index]) && (() => {
            const a = doc.annotations[selection.index], ai = selection.index;
            // Every edit rebuilds the rectangle from the recipe and passes the
            // old record through, so nothing else on it is lost on the way.
            const set = (patch) => dispatch({ type: 'COMMIT', updater: (d) => {
              const anns = (d.annotations || []).slice();
              const cur = anns[ai];
              if (!isRoadObject(cur)) return d;
              anns[ai] = makeRoadRect(patch.at || cur.at,
                patch.width == null ? cur.width : patch.width,
                patch.length == null ? cur.length : patch.length,
                patch.rot == null ? cur.rot : patch.rot, cur);
              return { ...d, annotations: anns };
            } });
            const deg = Math.round((((a.rot * 180) / Math.PI) % 360 + 360) % 360);
            return html`
              <div className="field">
                <label>Breedte</label>
                <div className="row">
                  <input type="number" min="1" max="40" step="0.5" value=${a.width.toFixed(1)}
                    onChange=${(e) => set({ width: Math.max(1, Math.min(40, parseFloat(e.target.value) || 6)) })} />
                  <span style=${{ alignSelf: 'center', color: 'var(--muted)', fontSize: '12px' }}>m</span>
                </div>
              </div>
              <div className="field">
                <label>Lengte</label>
                <div className="row">
                  <input type="number" min="1" max="400" step="0.5" value=${a.length.toFixed(1)}
                    onChange=${(e) => set({ length: Math.max(1, Math.min(400, parseFloat(e.target.value) || 20)) })} />
                  <span style=${{ alignSelf: 'center', color: 'var(--muted)', fontSize: '12px' }}>m</span>
                </div>
              </div>
              <div className="field">
                <label>Draaiing <span className="val">${deg}°</span></label>
                <input type="range" min="0" max="355" step="5" value=${deg}
                  onInput=${(e) => set({ rot: (+e.target.value * Math.PI) / 180 })} />
                <div className="mix-note">Of sleep de oranje greep naast de weg; Shift klemt op 15°.</div>
              </div>`;
          })()}
          ${doc.annotations[selection.index].kind === 'drivethru' && (() => {
            const a = doc.annotations[selection.index];
            const len = polylineLen(a.points), R = a.turnR || 7.5;
            let tight = 0;
            for (let i = 1; i < a.points.length - 1; i++) { const fl = filletAt(a.points[i - 1], a.points[i], a.points[i + 1], R); if (fl && fl.tight) tight++; }
            return html`<table className="sum-table" style=${{ marginBottom: '8px' }}>
              <tr><td>Lengte</td><td>${len.toFixed(1)} m</td></tr>
              <tr className="sum-tot"><td>Wachtplaatsen</td><td>${drivethruStacks(a.points)}</td></tr>
              <tr><td>Afhaalpunt</td><td>einde (W)</td></tr>
            </table>
            <div className="field">
              <label>Draaistraal</label>
              <div className="row">
                <input type="number" min="3" max="20" step="0.5" value=${R}
                  onChange=${(e) => setDrivethruTurnR(selection.index, Math.max(3, Math.min(20, parseFloat(e.target.value) || 7.5)))} />
                <span style=${{ alignSelf: 'center', color: 'var(--muted)', fontSize: '12px' }}>m</span>
              </div>
            </div>
            ${tight > 0 ? html`<div className="mix-warn">${tight} bocht${tight > 1 ? 'en' : ''} te krap voor R ${R.toFixed(1)} m.</div>` : ''}
            <div className="mix-note" style=${{ marginTop: 0 }}>Sleep de hoeken om de wachtrij te verlengen (~6 m per auto).</div>`;
          })()}
          ${(ANNOT_TYPES[doc.annotations[selection.index].kind] || {}).body && !doc.annotations[selection.index].closed && (() => {
            const ai = selection.index, ann = doc.annotations[ai];
            const al = ann.align || 'center';
            return html`
              <div className="field">
                <label>Breedte <span className="val">${(ann.width || 6).toFixed(1)} m</span></label>
                <input type="range" min="2" max="20" step="0.1" value=${ann.width || 6}
                  onInput=${(e) => updateAnnotation(ai, { width: +e.target.value })} />
              </div>
              <div className="field">
                <label>De lijn is</label>
                <div className="seg">
                  <button className=${al === 'center' ? 'active' : ''} onClick=${() => updateAnnotation(ai, { align: undefined })}>Hartlijn</button>
                  <button className=${al === 'left' ? 'active' : ''} onClick=${() => updateAnnotation(ai, { align: 'left' })}>Linkerrand</button>
                  <button className=${al === 'right' ? 'active' : ''} onClick=${() => updateAnnotation(ai, { align: 'right' })}>Rechterrand</button>
                </div>
                <div className="mix-note">Omschakelen verlegt de weg zonder je lijn te verplaatsen.</div>
              </div>
              <label className="toggle">
                <span>Objecten op de weg meenemen</span>
                <input type="checkbox" checked=${carryRiders} onChange=${(e) => setCarryRiders(e.target.checked)} />
              </label>
              <div className="mix-note">Borden, markeringen en handmatige vakken die op het asfalt staan schuiven mee bij het verslepen. <b>Alt</b> ingedrukt houden doet hetzelfde, maar veel bureaubladen kapen Alt+slepen om vensters te verplaatsen.</div>
              <label className="toggle">
                <span>Vloeiende bochten</span>
                <input type="checkbox" checked=${!!ann.curved}
                  onChange=${(e) => updateAnnotation(ai, { curved: e.target.checked })} />
              </label>`;
          })()}
          <div className="sel-actions" style=${{ flexWrap: 'wrap' }}>
            <button className="btn ghost" onClick=${duplicateSelection}>⧉ Dupliceer</button>
            <button className="btn" onClick=${() => { deleteAnnotation(selection.index); setSelection(null); }}>🗑 Verwijder</button>
            <button className="btn ghost" onClick=${() => setSelection(null)}>Deselecteer</button>
          </div>
        </div>`}
        ${selection && selection.type === 'obs' && doc.obstacles[selection.index] && (() => {
          const o = doc.obstacles[selection.index];
          const floors = (o && o.floors) || 1;
          const footprint = polygonArea(polyOf(o));
          return html`
        <div className="section sel-section">
          <h3>${styleOf((o && o.use) || DEFAULT_USE).label} geselecteerd</h3>
          <div className="field">
            <label>Type</label>
            <div className="type-grid">
              ${Object.values(BUILDING_USES).map((u) => html`
                <button key=${u.key} className=${'type-btn' + (((o && o.use) || DEFAULT_USE) === u.key ? ' active' : '')}
                  title=${(u.keywords || '') + ' · ' + u.floors + ' verd. × ' + u.floorH + ' m'}
                  onClick=${() => setObsUse(selection.index, u.key)}>
                  <span className="dot" style=${{ background: (MATERIALS[u.material] || MATERIALS.render).tint }}></span>${u.label}
                </button>`)}
            </div>
            <div className="mix-note">Wisselen zet ook de standaard verdiepingen en gevel van die stijl.</div>
          </div>
          <div className="field">
            <label>Gevel</label>
            <div className="type-grid">
              ${Object.values(MATERIALS).map((m) => html`
                <button key=${m.key} className=${'type-btn' + (materialOf(o).key === m.key ? ' active' : '')}
                  onClick=${() => setObsMaterial(selection.index, m.key)}>
                  <span className="dot" style=${{ background: m.tint }}></span>${m.label}
                </button>`)}
            </div>
          </div>
          <div className="field">
            <label>Verdiepingen<span className="val">${floors}</span></label>
            <div className="row">
              <input type="range" min="1" max="40" step="1" value=${floors}
                onInput=${(e) => setObsFloors(selection.index, parseInt(e.target.value, 10))} style=${{ flex: 1 }} />
              <input type="number" min="1" max="200" step="1" value=${floors}
                onChange=${(e) => setObsFloors(selection.index, Math.max(1, parseInt(e.target.value, 10) || 1))} />
            </div>
          </div>
          <table className="sum-table">
            <tr><td>Voetafdruk</td><td>${fmt(footprint)} m²</td></tr>
            <tr><td>Vloeroppervlak (GLA)</td><td>${fmt(footprint * floors)} m²</td></tr>
            <tr><td>Hoogte</td><td>${(floors * FLOOR_H).toFixed(1)} m</td></tr>
          </table>
          <div className="sel-actions" style=${{ marginTop: '10px', flexWrap: 'wrap' }}>
            <button className="btn ghost" onClick=${duplicateSelection}>⧉ Dupliceer</button>
            <button className="btn" onClick=${() => { deleteObs(selection.index); setSelection(null); }}>🗑 Verwijder</button>
            <button className="btn ghost" onClick=${() => setSelection(null)}>Deselecteer</button>
          </div>
        </div>`;
        })()}
        ${(stallSel.length > 0 || aisleSel) && html`
        <div className="section sel-section">
          ${stallSel.length > 0 && html`
            <h3>${stallSel.length} vak${stallSel.length > 1 ? 'ken' : ''} geselecteerd</h3>
            <div className="type-grid">
              ${Object.values(STALL_TYPES).map((t) => html`
                <button key=${t.key} className="type-btn" onClick=${() => setStallTypes(stallSel, t.key)}>
                  <span className="dot" style=${{ background: t.color }}></span>${t.label}
                </button>`)}
            </div>
            <div className="field" style=${{ marginTop: '4px', marginBottom: '8px' }}>
              <label>Hoek van deze vak(ken)</label>
              <div className="seg">
                ${[30, 45, 60, 75, 90].map((a) => html`<button key=${a} onClick=${() => setStallAngles(stallSel, a)}>${a}°</button>`)}
                <button onClick=${() => setStallAngles(stallSel, null)} title="Terug naar automatische hoek">Auto</button>
              </div>
            </div>
            ${(() => {
              const lockedSet = (doc.overrides.locks && doc.overrides.locks.stalls) || {};
              const allLocked = stallSel.every((k) => lockedSet[k]);
              return html`<div className="sel-actions" style=${{ flexWrap: 'wrap' }}>
                <button className="btn ghost" onClick=${() => setStallTypes(stallSel, null)}>↺ Wis</button>
                <button className="btn ghost" onClick=${duplicateSelection}>⧉ Dupliceer</button>
                <button className="btn ghost" onClick=${() => toggleLockStalls(stallSel, !allLocked)}>${allLocked ? '🔓' : '🔒'}</button>
                <button className="btn ghost" onClick=${() => { deleteStalls(stallSel); setStallSel([]); }}>🗑 Verwijder</button>
                <button className="btn ghost" onClick=${clearSel}>✕</button>
              </div>`;
            })()}
          `}
          ${aisleSel && (() => {
            const a = deco.aisles.find((x) => x.key === aisleSel);
            const oneway = a && a.oneway;
            const locked = a && a.locked;
            return html`
            <h3>Rijbaan geselecteerd</h3>
            <label className="toggle" style=${{ marginBottom: '8px' }}>
              <span>Eenrichting (met pijlen)</span>
              <input type="checkbox" checked=${!!oneway} onChange=${(e) => setAisleOneway(aisleSel, e.target.checked)} />
            </label>
            <div className="sel-actions" style=${{ flexWrap: 'wrap' }}>
              <button className="btn" onClick=${() => flipAisle(aisleSel)} disabled=${!oneway}>⇄ Draai richting om</button>
              <button className="btn" onClick=${() => deleteAisle(aisleSel)}>🗑 Verwijder rijbaan</button>
              <button className="btn ghost" onClick=${() => toggleLockAisle(aisleSel, !locked)}>${locked ? '🔓 Ontgrendel' : '🔒 Vergrendel'}</button>
              <button className="btn ghost" onClick=${clearSel}>Deselecteer</button>
            </div>
            <div className="mix-note">De vakken langs deze rijbaan blijven staan — verwijder ze apart als ze ook weg moeten.</div>`;
          })()}
        </div>`}
        ${secShow('secMetrics', 'Metrics') && html`
        <div className="section">
          ${secHead('secMetrics', 'Metrics', html`
            <button className="btn ghost" style=${{ padding: '3px 8px', fontSize: '11px' }} onClick=${() => setSummaryOpen(true)}>📋 Samenvatting</button>
          `)}
          ${secIsOpen('secMetrics') && html`
          <div className="metric-grid">
            <div className="metric big">
              <div className="k">Totaal vakken</div>
              <div className="v">${metrics.total}</div>
              <div className="sub">
                ${metrics.physicalStalls !== metrics.total
                  ? html`${metrics.physicalStalls} fysieke vakken · ${metrics.aisleCount} rijstroken`
                  : html`${metrics.aisleCount} rijstro${metrics.aisleCount === 1 ? 'ok' : 'ken'}${metrics.areaPerStall ? ' · ' + metrics.areaPerStall.toFixed(1) + ' m² per vak' : ''}`}
              </div>
            </div>
            <div className="metric"><div className="k">Site</div><div className="v">${fmt(metrics.siteArea)}<small> m²</small></div></div>
            <div className="metric"><div className="k">Bebouwd</div><div className="v">${(metrics.coverage * 100).toFixed(0)}<small>%</small></div></div>
            <div className="metric"><div className="k">m² / vak</div><div className="v">${metrics.areaPerStall ? metrics.areaPerStall.toFixed(1) : '—'}</div></div>
            <div className="metric"><div className="k">Verhard</div><div className="v">${(metrics.imperviousPct * 100).toFixed(0)}<small>%</small></div></div>
            <div className="metric"><div className="k">Oriëntaties</div><div className="v">${metrics.orientationCount}</div></div>
          </div>
          ${metrics.requiredStalls != null && html`<div style=${{ fontSize: '11.5px', color: 'var(--muted)', marginTop: '10px' }}>
            Zoning-eis: <b style=${{ color: metrics.total >= metrics.requiredStalls ? '#22c55e' : '#f59e0b' }}>${metrics.total}</b> / ${metrics.requiredStalls} vereiste plaatsen.
          </div>`}
          ${metrics.accessCount > 0 && html`<div style=${{ fontSize: '11.5px', color: 'var(--muted)', marginTop: '4px' }}>
            Toegangspunten: <b style=${{ color: 'var(--text)' }}>${metrics.accessCount}</b>.
          </div>`}
          <div className="legend">
            ${Object.values(STALL_TYPES).map((t) => html`
              <div className="row" key=${t.key}>
                <span className="dot" style=${{ background: t.color }}></span>
                <span>${t.label}</span>
                <span className="count">${metrics.counts[t.key] || 0}</span>
              </div>`)}
          </div>
          <div style=${{ fontSize: '11.5px', color: 'var(--muted)', marginTop: '10px' }}>
            Minder-valide (Tabel 208.2): <b style=${{ color: metrics.adaProvided >= metrics.adaRequired ? '#22c55e' : '#f59e0b' }}>${metrics.adaProvided}</b> / ${metrics.adaRequired} vereist${metrics.adaRequired ? `, waarvan ${metrics.adaVan} van-accessible` : ''}.
          </div>
          ${metrics.onewayAisles > 0 && html`<div style=${{ fontSize: '11.5px', color: 'var(--muted)', marginTop: '4px' }}>
            Eenrichtings-rijbanen: <b style=${{ color: 'var(--text)' }}>${metrics.onewayAisles}</b> / ${metrics.aisleCount}.
          </div>`}
          `}
        </div>`}

        ${secShow('secDrive', 'Bereikbaarheid') && html`
        <div className="section">
          ${secHead('secDrive', 'Bereikbaarheid', html`
            <label className="toggle" style=${{ fontSize: '11px' }}>
            <input type="checkbox" checked=${showIssues} onChange=${(e) => setShowIssues(e.target.checked)} />
            <span>toon op plan</span>
            </label>
          `)}
          ${secIsOpen('secDrive') && html`
          <div className="field"><label>Ontwerpvoertuig</label></div>
          <div className="veh-grid">
            ${Object.values(VEHICLES).map((v) => html`
              <button key=${v.key}
                className=${'type-btn' + (designVehicle === v.key ? ' active' : '')}
                title=${`${v.label} · ${v.length.toFixed(1)}×${v.width.toFixed(2)} m · draaistraal ${v.rDesign.toFixed(1)} m`}
                onClick=${() => setParam('designVehicle', v.key)}>${v.icon} ${v.label}</button>`)}
          </div>
          ${(() => {
            if (!driveReport) return '';
            if (driveReport.failed) return html`<div className="mix-warn">De controle kon niet draaien: ${driveReport.failed}</div>`;
            if (driveReport.empty) return html`<div className="mix-note">Geen rijweg getekend. Teken een weg of in/uitrit — de rijbanen van de solver staan los van elkaar en van de openbare weg.</div>`;
            const n = driveIssues.length;
            return html`
              <div className="kn-head">${n ? `⚠ ${n} knelpunt${n > 1 ? 'en' : ''}` : '✓ geen knelpunten'}</div>
              ${driveIssues.map((it, i) => html`
                <div key=${i} className=${'obj-row kn-row' + (focusIssue === i ? ' active' : '')}
                  onClick=${() => { setFocusIssue(i); focusPoly(it.poly || [it.at]); }}>
                  <span className="dot" style=${{ background: it.sev === 'warn' ? '#f59e0b' : '#ef4444' }}></span>
                  <span className="kn-text">
                    <span className="kn-label">${i + 1}. ${it.label}</span>
                    <span className="kn-need">${it.need}</span>
                  </span>
                </div>`)}
              <div className=${driveReport.reach.ok === driveReport.reach.total ? 'kn-ok' : 'mix-warn'}>
                ${driveReport.reach.ok === driveReport.reach.total
                  ? `✓ Alle ${driveReport.reach.total} vakken bereikbaar met het gekozen voertuig`
                  : `${driveReport.reach.ok} van ${driveReport.reach.total} vakken bereikbaar met een ${vehicleOf(designVehicle).label.toLowerCase()}`}
              </div>`;
          })()}
          <div className="field" style=${{ marginTop: 8 }}>
            <label>Brandweer max. afstand tot gevel <span className="val">${fireMaxDist} m</span></label>
            <input type="range" min="20" max="120" step="5" value=${fireMaxDist}
              onInput=${(e) => setParam('fireMaxDist', +e.target.value, false)}
              onChange=${(e) => setParam('fireMaxDist', +e.target.value)} />
          </div>
          <div className="mix-note">Gangbare ontwerpwaarden, geen normcitaat — maten verschillen per gemeente en per brandweerzone.</div>
          `}
        </div>`}

        ${secShow('secSun', 'Zon en schaduw') && html`
        <div className="section">
          ${secHead('secSun', 'Zon en schaduw', html`
            <label className="toggle" style=${{ fontSize: '11px' }}>
            <input type="checkbox" checked=${!!layers.shadow} onChange=${(e) => setLayers((l) => ({ ...l, shadow: e.target.checked }))} />
            <span>toon</span>
            </label>
          `)}
          ${secIsOpen('secSun') && html`
          <div className="field">
            <label>Datum</label>
            <input type="date" value=${doc.params.sunDate || '2026-06-21'}
              onChange=${(e) => setParam('sunDate', e.target.value)} />
          </div>
          ${slider('Tijd', 'sunHour', doc.params.sunHour == null ? 15 : doc.params.sunHour, 0, 23.5, 0.5, 'u', setParam)}
          <div className="mix-note">
            ${sun.altitude > 0
              ? `Zon staat ${sun.altitude.toFixed(0)}° hoog, azimut ${sun.azimuth.toFixed(0)}°.`
              : 'De zon staat onder de horizon — alles ligt in de schaduw.'}
            ${layers.shadow ? ` ${shadedStalls.length} van ${deco.stalls.length} vakken in de schaduw.` : ''}
          </div>
          <div className="mix-note">Klok is zonnetijd voor deze lengtegraad (UTC${zoneOffsetHours((doc.geo || {}).lon) >= 0 ? '+' : ''}${zoneOffsetHours((doc.geo || {}).lon)}); geen zomertijd.</div>
          `}
        </div>`}

        ${secShow('secLight', 'Licht en opbrengst') && html`
        <div className="section">
          ${secHead('secLight', 'Licht en opbrengst', html`
            <label className="toggle" style=${{ fontSize: '11px' }}>
            <input type="checkbox" checked=${!!layers.lightmap} onChange=${(e) => setLayers((l) => ({ ...l, lightmap: e.target.checked }))} />
            <span>toon</span>
            </label>
          `)}
          ${secIsOpen('secLight') && html`
          <div className="field">
            <label>Bron</label>
            <div className="seg">
              <button className=${lightSource === 'lamps' ? 'active' : ''} onClick=${() => setParam('lightSource', 'lamps')}>Kunstlicht</button>
              <button className=${lightSource === 'sun' ? 'active' : ''} onClick=${() => setParam('lightSource', 'sun')}>Zon (jaar)</button>
            </div>
          </div>
          ${slider('Rasterstap', 'lightStep', doc.params.lightStep || 3, 1, 8, 0.5, 'm', setParam)}

          ${lightSource === 'lamps' ? html`
            <div className="field">
              <label>Lichtstroom per armatuur</label>
              <input type="number" min="1000" max="80000" step="500" value=${doc.params.poleLumens || 12000}
                onChange=${(e) => setParam('poleLumens', Math.max(1000, +e.target.value || 12000))} />
            </div>
            ${slider('Onderhoudsfactor', 'poleMaint', doc.params.poleMaint == null ? 0.8 : doc.params.poleMaint, 0.5, 1, 0.05, '', setParam)}
            ${(() => {
              if (!poles.length) return html`<div className="mix-note">Nog geen lichtmasten. Plaats ze met de tool <b>Lichtmast</b>; de lichtpunthoogte stel je per mast in.</div>`;
              const st = stallLight ? stallLight.stats : null;
              if (!st || st.avg == null) return html`<div className="mix-note">Zet de laag aan om te rekenen.</div>`;
              const luxT = doc.params.luxTarget || 10, u0T = doc.params.u0Target || 0.25;
              const okE = st.avg >= luxT, okU = st.u0 >= u0T;
              return html`
                <div className="kn-head">${poles.length} mast${poles.length > 1 ? 'en' : ''} · gemeten op ${st.n} vakken</div>
                <div className="obj-row kn-row">
                  <span className="dot" style=${{ background: okE ? '#22c55e' : '#f59e0b' }}></span>
                  <span className="kn-text">
                    <span className="kn-label">${st.avg.toFixed(1)} lx gemiddeld</span>
                    <span className="kn-need">streefwaarde ${luxT} lx · laagste punt ${st.min.toFixed(1)} lx</span>
                  </span>
                </div>
                <div className="obj-row kn-row">
                  <span className="dot" style=${{ background: okU ? '#22c55e' : '#f59e0b' }}></span>
                  <span className="kn-text">
                    <span className="kn-label">U₀ = ${st.u0.toFixed(2)}</span>
                    <span className="kn-need">streefwaarde ${u0T.toFixed(2)} — gelijkmatigheid Emin/Egem</span>
                  </span>
                </div>
                ${stallLight.worst >= 0 && deco.stalls[stallLight.worst] && html`
                  <div className="obj-row kn-row"
                    onClick=${() => focusPoly(deco.stalls[stallLight.worst].poly)}>
                    <span className="dot" style=${{ background: '#64748b' }}></span>
                    <span className="kn-text">
                      <span className="kn-label">Donkerste vak: ${stallLight.worstLux.toFixed(1)} lx</span>
                      <span className="kn-need">klik om het aan te wijzen</span>
                    </span>
                  </div>`}
                <div className="mix-note">Gemeten op het parkeervlak zelf, niet over de hele kavel — de setbackstrook is per definitie onverlicht en zou de gelijkmatigheid altijd op nul zetten.</div>
                <div className="mix-note">Puntbron, gelijkmatig over de onderste halve bol. Dit is de eerste-orde handberekening, <b>geen fotometrisch bestand</b>: een echt ontwerp leest een IES-curve per armatuur. De streefwaarden zijn gangbaar, geen normcitaat.</div>`;
            })()}
          ` : html`
            <div className="field">
              <label>Jaarlijkse instraling (horizontaal)</label>
              <input type="number" min="600" max="2400" step="10" value=${doc.params.pvGHI || 1050}
                onChange=${(e) => setParam('pvGHI', Math.max(600, +e.target.value || 1050))} />
            </div>
            ${slider('Diffuus aandeel', 'pvDiffuse', doc.params.pvDiffuse == null ? 0.55 : doc.params.pvDiffuse, 0.3, 0.75, 0.01, '', setParam)}
            ${slider('Helling', 'pvTilt', doc.params.pvTilt == null ? 10 : doc.params.pvTilt, 0, 60, 1, '°', setParam)}
            ${slider('Oriëntatie', 'pvAzimuth', doc.params.pvAzimuth == null ? 180 : doc.params.pvAzimuth, 90, 270, 5, '°', setParam)}
            ${(() => {
              if (!canopies.length) return html`<div className="mix-note">Nog geen carports. Teken ze met de tool <b>Zonnecarport</b> over de parkeerrijen — de kaart toont ondertussen de instraling op maaiveld.</div>`;
              if (!pvReport) return html`<div className="mix-note">Zet de laag aan om te rekenen.</div>`;
              const r = pvReport;
              return html`
                <div className="kn-head">${r.area.toFixed(0)} m² overkapt · ${r.kWp.toFixed(0)} kWp</div>
                <div className="obj-row kn-row">
                  <span className="dot" style=${{ background: '#f59e0b' }}></span>
                  <span className="kn-text">
                    <span className="kn-label">${(r.kWh / 1000).toFixed(1)} MWh per jaar</span>
                    <span className="kn-need">${r.specific.toFixed(0)} kWh/kWp · schaduwverlies ${(r.shadeLoss * 100).toFixed(1)} %</span>
                  </span>
                </div>
                <div className="mix-note">Heldere-hemelmodel geijkt op de instraling en het diffuse aandeel hierboven; twaalf representatieve dagen per uur. Geen weerjaar, geen temperatuur- of vervuilingsmodel buiten de prestatieverhouding.</div>`;
            })()}
          `}
          ${lightField && lightField.stats.max > 0 && html`
            <div className="ramp">
              <div className="ramp-bar"></div>
              <div className="ramp-ends">
                <span>0</span>
                <span>${lightField.stats.max.toFixed(lightSource === 'sun' ? 0 : 1)} ${lightField.unit}</span>
              </div>
              <div className="mix-note">Kaart over ${lightField.stats.n} rasterpunten, gerekend in ${lightField.ms.toFixed(0)} ms.</div>
            </div>`}
          `}
        </div>`}

        ${secShow('secStallAisle', 'Vak & rijstrook') && html`
        <div className="section">
          ${secHead('secStallAisle', 'Vak & rijstrook')}
          ${secIsOpen('secStallAisle') && html`
          <div className="toggle" style=${{ marginBottom: '10px' }}>
            <span>Automatisch parkeren</span>
            <input type="checkbox" checked=${doc.autoParking !== false} onChange=${(e) => setAutoParking(e.target.checked)} />
          </div>
          ${doc.autoParking === false && html`<div className="mix-note" style=${{ marginTop: 0, marginBottom: '10px' }}>Uit — teken je site vrij; plaats vakken met de Vak-tool (K).</div>`}
          <div className="field">
            <label>Layout</label>
            <div className="seg">
              <button className=${(doc.params.layout || 'strip') === 'strip' ? 'active' : ''} onClick=${() => setParam('layout', 'strip')} title="Rechte rijen">Recht</button>
              <button className=${doc.params.layout === 'hybrid' ? 'active' : ''} onClick=${() => setParam('layout', 'hybrid')} title="Rand volgt de curve + recht in het midden">Rand+midden</button>
              <button className=${doc.params.layout === 'perimeter' ? 'active' : ''} onClick=${() => setParam('layout', 'perimeter')} title="Volledig concentrisch, volgt de rand">Concentrisch</button>
            </div>
          </div>
          <div className="toggle">
            <span>Lijn rijen uit met langste rand</span>
            <input type="checkbox" checked=${!!doc.params.alignLongestEdge} onChange=${(e) => setParam('alignLongestEdge', e.target.checked)} />
          </div>
          <div className="field" style=${{ display: 'flex', gap: '6px' }}>
            <button className="btn ghost" style=${{ flex: 1, justifyContent: 'center' }} onClick=${genSchemes}>⚖️ Vergelijk</button>
            <button className="btn" style=${{ flex: 1, justifyContent: 'center' }} disabled=${!!(optState && optState.running)} onClick=${autoOptimize}>
              ${optState && optState.running ? `Bezig… ${optState.i}/${optState.n}` : '✨ Optimaliseer'}
            </button>
          </div>
          ${optState && optState.done && html`
            <div className="opt-result">
              Beste layout: <b>${optState.label}</b> —
              ${optState.after} plaatsen${optState.after > optState.before ? html` <span className="opt-up">(+${optState.after - optState.before})</span>`
                : optState.after < optState.before ? ` (${optState.after - optState.before})` : ' — al optimaal'}
            </div>`}
          ${schemes && html`
            <div className="schemes">
              ${schemes.length === 0 ? html`<div className="scheme-empty">Teken eerst een site.</div>` : ''}
              ${schemes.map((s) => html`
                <div key=${s.label} className=${'scheme-row' + (s.best ? ' best' : '')}>
                  <div className="scheme-info">
                    <span className="scheme-label">${s.label}${s.best ? ' ★' : ''}</span>
                    <span className="scheme-count">${s.physical} vakken · ${Math.round(s.density)} m²/vak</span>
                  </div>
                  <button className="btn ghost" onClick=${() => applyScheme(s.patch)}>Toepassen</button>
                </div>`)}
            </div>`}
          ${slider('Vakbreedte', 'stallWidth', doc.params.stallWidth, 2.2, 3.5, 0.1, 'm', setParam)}
          ${slider('Vakdiepte', 'stallDepth', doc.params.stallDepth, 4.5, 6.5, 0.1, 'm', setParam)}
          ${slider('Rijstrook', 'aisleWidth', doc.params.aisleWidth, 5, 8, 0.1, 'm', setParam)}
          <div className="field">
            <label>Parkeerhoek<span className="val">${doc.params.angle}°</span></label>
            <div className="seg" style=${{ marginBottom: '6px' }}>
              ${[30, 45, 60, 75, 90].map((a) => html`<button key=${a} className=${doc.params.angle === a ? 'active' : ''} onClick=${() => setParam('angle', a)}>${a}°</button>`)}
            </div>
            <div className="row">
              <input type="range" min="30" max="90" step="1" value=${doc.params.angle}
                onInput=${(e) => setParam('angle', parseInt(e.target.value, 10), false)}
                onChange=${(e) => setParam('angle', parseInt(e.target.value, 10), true)}
                style=${{ flex: 1 }} />
              <input type="number" min="30" max="90" step="1" value=${doc.params.angle}
                onChange=${(e) => { const v = Math.max(30, Math.min(90, parseInt(e.target.value, 10) || 90)); setParam('angle', v); }}
                style=${{ width: '58px' }} />
            </div>
          </div>
          `}
        </div>`}

        ${secShow('secConstraints', 'Site-constraints') && html`
        <div className="section">
          ${secHead('secConstraints', 'Site-constraints')}
          ${secIsOpen('secConstraints') && html`
          ${slider('Setback', 'setback', doc.params.setback, 0, 20, 0.5, 'm', setParam)}
          ${slider('Padding (buffer)', 'padding', doc.params.padding, 0, 3, 0.1, 'm', setParam)}
          ${slider('Max. rijlengte', 'maxRun', doc.params.maxRun, 0, 30, 1, 'vak', setParam)}
          ${slider('Groeneilanden (breedte)', 'islandWidth', doc.params.islandWidth, 0, 6, 0.5, 'm', setParam, (v) => v > 0 ? `${(+v).toFixed(1)} m` : 'uit')}
          <div className="toggle">
            <span>Single-loaded reststroken</span>
            <input type="checkbox" checked=${!!doc.params.singleLoaded} onChange=${(e) => setParam('singleLoaded', e.target.checked)} />
          </div>
          <div className="toggle">
            <span>Dead-end turnarounds</span>
            <input type="checkbox" checked=${!!doc.params.deadEndTurnaround} onChange=${(e) => setParam('deadEndTurnaround', e.target.checked)} />
          </div>
          ${doc.params.deadEndTurnaround && slider('Turnaround-ruimte', 'turnaround', doc.params.turnaround, 4, 12, 0.5, 'm', setParam)}
          <div className="field">
            <label>Kopse rijbaan</label>
            <div className="seg">
              ${[['none', 'Geen'], ['one', 'Eén kant'], ['both', 'Beide']].map(([v, lab]) => html`
                <button key=${v}
                  className=${(doc.params.endAisles || 'one') === v ? 'active' : ''}
                  title=${v === 'none' ? 'Geen verbinding tussen de rijen — teken die zelf'
                    : v === 'one' ? 'Eén dwarsrijbaan verbindt alle rijen'
                    : 'Aan beide uiteinden, dus een lus zonder doodlopende rijen'}
                  onClick=${() => setParam('endAisles', v)}>${lab}</button>`)}
            </div>
            <div className="mix-note">Verbindt de rijen met elkaar en met je in/uitrit. Kost vakken — zonder is het terrein niet berijdbaar.</div>
          </div>
          `}
        </div>`}

        ${secShow('secMix', 'Vaktypes (mix)') && html`
        <div className="section">
          ${secHead('secMix', 'Vaktypes (mix)')}
          ${secIsOpen('secMix') && html`
          ${(() => {
            const keys = ['compact', 'ev', 'staff', 'visitor', 'reserved'];
            const mix = doc.params.mix || { compact: doc.params.compactRatio || 0, ev: doc.params.evRatio || 0 };
            const sum = keys.reduce((s, k) => s + (mix[k] || 0), 0);
            return html`
              <table className="mix-table">
                <thead><tr><th>Type</th><th>Aandeel</th><th>Aantal</th></tr></thead>
                <tbody>
                  <tr>
                    <td><span className="dot" style=${{ background: STALL_TYPES.standard.color }}></span>Standaard</td>
                    <td className="mix-rem">${Math.max(0, Math.round((1 - sum) * 100))}%</td>
                    <td>${metrics.counts.standard || 0}</td>
                  </tr>
                  ${keys.map((k) => html`
                    <tr key=${k}>
                      <td><span className="dot" style=${{ background: STALL_TYPES[k].color }}></span>${STALL_TYPES[k].label}</td>
                      <td><input className="mix-in" type="number" min="0" max="100" step="5" value=${Math.round((mix[k] || 0) * 100)}
                        onChange=${(e) => setMix(k, Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)) / 100)} />%</td>
                      <td>${metrics.counts[k] || 0}</td>
                    </tr>`)}
                  <tr>
                    <td><span className="dot" style=${{ background: STALL_TYPES.ada.color }}></span>Minder-valide</td>
                    <td>auto</td>
                    <td>${metrics.counts.ada || 0}</td>
                  </tr>
                  <tr>
                    <td><span className="dot" style=${{ background: STALL_TYPES.motorcycle.color }}></span>Motor</td>
                    <td>handmatig</td>
                    <td>${metrics.counts.motorcycle || 0}</td>
                  </tr>
                </tbody>
              </table>
              ${sum > 1 ? html`<div className="mix-warn">Totaal ${Math.round(sum * 100)}% &gt; 100% — er blijft geen standaard over.</div>` : ''}
              <div className="toggle">
                <span>Minder-valide (ADA) automatisch</span>
                <input type="checkbox" checked=${doc.params.ada} onChange=${(e) => setParam('ada', e.target.checked)} />
              </div>
              <div className="mix-note">Motor markeer je handmatig op een vak (telt als 3 plaatsen).</div>`;
          })()}
          `}
        </div>`}

        ${secShow('secProgram', 'Programma & parkeer­ratio') && html`
        <div className="section">
          ${secHead('secProgram', 'Programma & parkeer­ratio')}
          ${secIsOpen('secProgram') && html`
          <div className="field">
            <label>Gebouw-GLA<span className="val">${doc.params.buildingGLA || 0} m²</span></label>
            <input type="number" min="0" step="50" value=${doc.params.buildingGLA || 0}
              onChange=${(e) => setParam('buildingGLA', Math.max(0, parseFloat(e.target.value) || 0))} />
          </div>
          <div className="field">
            <label>Ratio<span className="val">${doc.params.parkingRatio || 0} / 100 m²</span></label>
            <input type="number" min="0" step="0.1" value=${doc.params.parkingRatio || 0}
              onChange=${(e) => setParam('parkingRatio', Math.max(0, parseFloat(e.target.value) || 0))} />
          </div>
          ${metrics.requiredStalls != null
            ? html`<div style=${{ fontSize: '12px', marginTop: '2px' }}>
                <b style=${{ color: metrics.total >= metrics.requiredStalls ? '#22c55e' : '#f59e0b' }}>${metrics.total}</b>
                <span style=${{ color: 'var(--muted)' }}> / ${metrics.requiredStalls} vereist — ${metrics.total >= metrics.requiredStalls ? 'voldoet ✓' : (metrics.requiredStalls - metrics.total) + ' tekort'}</span>
              </div>`
            : html`<div style=${{ fontSize: '11.5px', color: 'var(--muted)' }}>Vul GLA en ratio in voor een zoning-check.</div>`}
          `}
        </div>`}
      </div>`}

      ${libOpen && libraryModal()}
      ${keysOpen && keysModal()}
      ${summaryOpen && html`
        <div className="modal-backdrop" onClick=${() => setSummaryOpen(false)}>
          <div className="modal" onClick=${(e) => e.stopPropagation()}>
            <h3 style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 0 }}>
              <span>Samenvatting</span>
              <button className="btn ghost" style=${{ padding: '2px 8px' }} onClick=${() => setSummaryOpen(false)}>✕</button>
            </h3>
            <div className="sum-h">Parkeerplaatsen per type</div>
            <table className="sum-table">
              ${Object.values(STALL_TYPES).map((t) => (metrics.counts[t.key] > 0) ? html`
                <tr key=${t.key}>
                  <td><span className="dot" style=${{ background: t.color, display: 'inline-block', width: '10px', height: '10px', borderRadius: '3px', marginRight: '6px' }}></span>${t.label}${t.spaces ? ` (${t.spaces}/vak)` : ''}</td>
                  <td>${metrics.counts[t.key]}</td>
                </tr>` : '')}
              <tr className="sum-tot"><td>Totaal plaatsen</td><td>${metrics.total}</td></tr>
              <tr><td>Fysieke vakken</td><td>${metrics.physicalStalls}</td></tr>
            </table>
            <div className="sum-h">Oppervlaktes</div>
            <table className="sum-table">
              <tr><td>Site</td><td>${fmt(metrics.siteArea)} m²</td></tr>
              <tr><td>Bebouwd</td><td>${fmt(metrics.buildingArea)} m² · ${(metrics.coverage * 100).toFixed(0)}%</td></tr>
              ${metrics.grossFloorArea > 0 && html`<tr><td>Vloeroppervlak (GLA)</td><td>${fmt(metrics.grossFloorArea)} m² · FAR ${metrics.far.toFixed(2)}</td></tr>`}
              <tr><td>Beschikbaar</td><td>${fmt(metrics.buildableArea)} m²</td></tr>
              <tr><td>m² per vak</td><td>${metrics.areaPerStall ? metrics.areaPerStall.toFixed(1) : '—'}</td></tr>
              <tr><td>Verhard</td><td>${(metrics.imperviousPct * 100).toFixed(0)}%</td></tr>
            </table>
            <div className="sum-h">Toegankelijkheid & circulatie</div>
            <table className="sum-table">
              <tr><td>Minder-valide</td><td>${metrics.adaProvided} / ${metrics.adaRequired} vereist · ${metrics.adaVan} van</td></tr>
              <tr><td>Rijstroken</td><td>${metrics.aisleCount} · ${metrics.onewayAisles} eenrichting</td></tr>
              <tr><td>Toegangspunten</td><td>${metrics.accessCount}</td></tr>
              <tr><td>Oriëntaties</td><td>${metrics.orientationCount}</td></tr>
            </table>
            ${metrics.requiredStalls != null && html`
              <div className="sum-h">Zoning</div>
              <table className="sum-table">
                <tr><td>Geleverd / vereist</td><td>${metrics.total} / ${metrics.requiredStalls}${metrics.total >= metrics.requiredStalls ? ' ✓' : ''}</td></tr>
              </table>`}
            <div className="sel-actions" style=${{ marginTop: '14px' }}>
              <button className="btn" onClick=${() => setSummaryOpen(false)}>Sluiten</button>
            </div>
          </div>
        </div>`}

      ${onboardOpen && html`
        <div className="modal-backdrop onboard-backdrop">
          <div className="modal onboard">
            <div className="onboard-hero">
              <div className="onboard-logo">P</div>
              <div>
                <h2 style=${{ margin: '0 0 2px' }}>ParkPlanner</h2>
                <div className="onboard-sub">Parametrische parkeerplanner — teken een terrein, genereer parkeervakken en bekijk de cijfers live.</div>
              </div>
            </div>

            <div className="onboard-grid">
              <button className="onboard-card" onClick=${() => setOnboardOpen(false)}>
                <div className="oc-ico">▦</div>
                <div className="oc-t">Voorbeeldsite</div>
                <div className="oc-d">Start met de meegeleverde demo en pas alles aan.</div>
              </button>
              <button className="onboard-card" onClick=${() => { newRect(); setOnboardOpen(false); }}>
                <div className="oc-ico">＋</div>
                <div className="oc-t">Leeg terrein</div>
                <div className="oc-d">Begin met een blanco rechthoek en teken je eigen site.</div>
              </button>
              <label className="onboard-card">
                <div className="oc-ico">📂</div>
                <div className="oc-t">Project laden</div>
                <div className="oc-d">Open een eerder opgeslagen .json — locatie en camera worden hersteld.</div>
                <input type="file" accept="application/json" onChange=${loadJSON} style=${{ display: 'none' }} />
              </label>
              <label className="onboard-card">
                <div className="oc-ico">🗺️</div>
                <div className="oc-t">Perceel importeren</div>
                <div className="oc-d">Laad een echte perceelgrens uit GeoJSON of KML en plan erop.</div>
                <input type="file" accept=".geojson,.json,.kml,application/geo+json,application/vnd.google-earth.kml+xml" onChange=${importParcel} style=${{ display: 'none' }} />
              </label>
            </div>

            <div className="onboard-search">
              <div className="sum-h" style=${{ marginTop: 0 }}>Zoek een locatie</div>
              <div className="onboard-row">
                <input type="text" placeholder="Adres of plaats…" value=${geoSearch}
                  onInput=${(e) => setGeoSearch(e.target.value)}
                  onKeyDown=${(e) => { if (e.key === 'Enter') onboardGeocode(); }} />
                <button className="btn" disabled=${geoBusy} onClick=${onboardGeocode}>
                  ${geoBusy ? '…' : 'Zoek'}
                </button>
              </div>
              ${geoMsg && html`<div className="onboard-msg">${geoMsg}</div>`}
            </div>

            <div className="onboard-foot">
              <button className="btn ghost" onClick=${() => setOnboardOpen(false)}>Overslaan</button>
            </div>
          </div>
        </div>`}
    </div>
  `;
}

// ---------- Small UI helpers ----------
function toolBtn(id, label, key, tool, setTool, setDrawing) {
  return html`<button className=${'btn' + (tool === id ? ' active' : '')}
    onClick=${() => { setTool(id); if (id === 'site' || id === 'obstaclepoly') setDrawing({ points: [] }); else setDrawing(null); }}>
    ${label} <kbd>${key}</kbd></button>`;
}

function layerRow(id, label, color, layers, setLayers) {
  return html`<label className="layer">
    <input type="checkbox" checked=${layers[id]} onChange=${() => setLayers((l) => ({ ...l, [id]: !l[id] }))} />
    <span className="swatch" style=${{ background: color }}></span>
    <span>${label}</span>
  </label>`;
}

function slider(label, key, value, min, max, step, unit, setParam, format) {
  const shown = format ? format(value) : `${(+value).toFixed(step < 1 ? 1 : 0)}${unit ? ' ' + unit : ''}`;
  return html`<div className="field">
    <label>${label}<span className="val">${shown}</span></label>
    <input type="range" min=${min} max=${max} step=${step} value=${value}
      onInput=${(e) => setParam(key, parseFloat(e.target.value), false)}
      onChange=${(e) => setParam(key, parseFloat(e.target.value), true)} />
  </div>`;
}

function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
function fmt(n) { return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n).toLocaleString('nl-NL'); }

// px/m as the drawing scale everyone in the trade actually says out loud.
//
// A CSS pixel is 1/96 inch by definition — 0.2645833 mm — so one metre drawn at
// `scale` px covers scale × 0.2645833 mm of screen, and 1000 mm of world over
// that is the ratio. It is honest about the browser's *nominal* pixel, not the
// physical glass: a page zoom or a lying DPI would change what a ruler reads.
const MM_PER_CSS_PX = 25.4 / 96;
export function ratioScale(scale) {
  if (!(scale > 0)) return '—';
  const n = 1000 / (scale * MM_PER_CSS_PX);
  // Rounded to a step that reads like a drawing title block rather than to the
  // unit: 1:1250, not 1:1247.
  const step = n >= 2000 ? 500 : n >= 500 ? 50 : n >= 100 ? 10 : n >= 20 ? 5 : 1;
  return '1:' + (Math.round(n / step) * step).toLocaleString('nl-NL');
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Guard the mount so any error surfaces through the boot overlay
// (index.html) rather than as a silent blank screen.
try {
  if (!window.React || !window.ReactDOM || !window.htm) {
    throw new Error('Kernbibliotheken ontbreken (React/ReactDOM/htm niet geladen).');
  }
  mark('2-mount-start');
  createRoot(document.getElementById('root')).render(html`<${App} />`);
} catch (err) {
  window.dispatchEvent(new ErrorEvent('error', { message: 'Mount-fout: ' + (err && err.message), error: err }));
  throw err;
}
