// ============================================================
// app.js — ParkPlanner React UI (no build step; htm + React ESM)
// ============================================================
import React, { useReducer, useRef, useState, useEffect, useCallback, useMemo } from '../vendor/react.mjs';
import { createRoot } from '../vendor/react-dom-client.mjs';
import htm from '../vendor/htm.mjs';
import { solveParking, computeMetrics, STALL_TYPES, stallKey, aisleKey, aisleAxis, longestEdgeAngle } from './solver.js?v=b5dc4bf3';
import {
  offsetPolygon, boundingBox, polygonCentroid, polygonArea, dist, distPointSegment,
  pointInPolygon, rectPoly, tessellateClosed, polyOf,
  tessellateOpen, polylineCum, polylineAt, nearestOnPolyline,
} from './geometry.js?v=b5dc4bf3';
import { geocode, latLonToLocal, localToLatLon } from './basemap.js?v=b5dc4bf3';
import { toGeoJSON, toDXF, toCSV } from './exporters.js?v=b5dc4bf3';
import { parseParcel, simplifyRing } from './importers.js?v=b5dc4bf3';
import { ANNOT_TYPES, ANNOT_GROUPS } from './annots.js?v=b5dc4bf3';
import { BUILD_ID } from './build.js?v=b5dc4bf3';

const html = htm.bind(React.createElement);
const ANGLE_SNAP = Math.PI / 12; // 15° increments for hold-to-align drawing
const ANGLE_SNAP_DEG = 15;       // same step, for the R rotate key
const FLOOR_H = 3.2;             // metres per building floor (for 3D + height)
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
function annotationBlocker(ann) {
  const t = ANNOT_TYPES[ann.kind];
  if (!t || !ann.points || ann.points.length < 2) return null;
  if (ann.closed && ann.points.length >= 3) return ann.points.slice();
  const hw = Math.max(0.5, (ann.width || t.width || 3) / 2);
  const pts = ann.points, left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    let dx = 0, dy = 0;
    if (i > 0) { dx += pts[i].x - pts[i - 1].x; dy += pts[i].y - pts[i - 1].y; }
    if (i < pts.length - 1) { dx += pts[i + 1].x - pts[i].x; dy += pts[i + 1].y - pts[i].y; }
    const len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    left.push({ x: pts[i].x + nx * hw, y: pts[i].y + ny * hw });
    right.push({ x: pts[i].x - nx * hw, y: pts[i].y - ny * hw });
  }
  return [...left, ...right.reverse()];
}

// `overrides` are manual, position-keyed marks that persist across
// re-solves: stall type per stall, one-way + direction per aisle.
const initialDoc = {
  site: DEFAULT_SITE, siteCurved: false, obstacles: DEFAULT_OBSTACLES, geo: DEFAULT_GEO,
  params: DEFAULT_PARAMS, orientationIndex: 0, autoParking: true,
  overrides: { stalls: {}, aisles: {}, locks: { stalls: {}, aisles: {} }, removed: {}, angles: {} },
  annotations: [], // { kind, points:[{x,y}], width, curved }
  manualStalls: [], // hand-placed stalls: { poly, type }
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

  { id: 'secLocation', group: 'Linkerpaneel', label: 'Locatie' },
  { id: 'secDraw', group: 'Linkerpaneel', label: 'Teken (infrastructuur)' },
  { id: 'secSiteShape', group: 'Linkerpaneel', label: 'Site-vorm' },
  { id: 'secLayers', group: 'Linkerpaneel', label: 'Lagen' },
  { id: 'secPreset', group: 'Linkerpaneel', label: 'Preset' },
  { id: 'secFoot', group: 'Linkerpaneel', label: 'Voettekst' },

  { id: 'secMetrics', group: 'Rechterpaneel', label: 'Metrics' },
  { id: 'secStallAisle', group: 'Rechterpaneel', label: 'Vak & rijstrook' },
  { id: 'secConstraints', group: 'Rechterpaneel', label: 'Site-constraints' },
  { id: 'secMix', group: 'Rechterpaneel', label: 'Vaktypes (mix)' },
  { id: 'secProgram', group: 'Rechterpaneel', label: 'Programma & ratio' },

  { id: 'tbTools', group: 'Werkbalk', label: 'Gereedschappen' },
  { id: 'tbNewSite', group: 'Werkbalk', label: 'Nieuwe site' },
  { id: 'tbAxis', group: 'Werkbalk', label: 'Rij-as & Reset' },
  { id: 'tbUndo', group: 'Werkbalk', label: 'Undo / Redo' },
  { id: 'tbView', group: 'Werkbalk', label: '2D / 3D' },
  { id: 'tbTheme', group: 'Werkbalk', label: 'Thema-knop' },
  { id: 'tbZoom', group: 'Werkbalk', label: 'Zoom & Fit' },
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
  Tekenen: ['panelLeft', 'secDraw', 'secLayers', 'secSiteShape', 'tbTools', 'tbNewSite', 'tbUndo', 'tbView', 'tbZoom', 'ovHud', 'ovHint'],
  Analyse: ['panelRight', 'secMetrics', 'secStallAisle', 'secMix', 'secProgram', 'tbTools', 'tbView', 'tbZoom', 'tbExport', 'ovDealbar', 'ovHud'],
};
const PANEL_W = { left: { min: 170, max: 420, def: 210 }, right: { min: 240, max: 560, def: 300 } };

// ---------- Canvas theme ----------
// Only the colours that actually break when the backdrop flips. Meaning-bearing
// colours (STALL_TYPES, ANNOT_TYPES, the green previews, the orange drive-thru)
// stay as they are — they read on both. Roles, not hues, so a future theme is a
// data change.
const THEMES = {
  dark: {
    grid: 'rgba(255,255,255,0.045)',
    ink: 'rgba(255,255,255,0.95)',      // glyphs and labels drawn on the plan
    inkSoft: 'rgba(255,255,255,0.7)',
    inkFaint: 'rgba(255,255,255,0.5)',
    onStall: 'rgba(255,255,255,0.85)',  // dividers/arrows painted on filled shapes
    outline: 'rgba(0,0,0,0.35)',
    sel: '#ffffff',                     // selection halo
    plate: 'rgba(15,18,22,0.85)',       // small label plates
    plateInk: '#a7f3d0',
    handleCore: '#0f1216',
    aisle: 'rgba(43,51,64,0.9)',
    building: 'rgba(100,116,139,0.5)',
    buildingLine: '#7c8896',
    badge: 'rgba(230,234,239,0.9)',
    pictoHalo: 'rgba(0,0,0,0.55)',
  },
  light: {
    grid: 'rgba(15,23,42,0.07)',
    ink: 'rgba(17,24,39,0.92)',
    inkSoft: 'rgba(17,24,39,0.62)',
    inkFaint: 'rgba(17,24,39,0.45)',
    onStall: 'rgba(255,255,255,0.9)',   // stalls stay saturated, so keep white here
    outline: 'rgba(0,0,0,0.28)',
    sel: '#111827',
    plate: 'rgba(255,255,255,0.92)',
    plateInk: '#047857',
    handleCore: '#ffffff',
    aisle: 'rgba(148,163,184,0.45)',
    building: 'rgba(100,116,139,0.35)',
    buildingLine: '#64748b',
    badge: 'rgba(30,41,59,0.9)',
    pictoHalo: 'rgba(15,23,42,0.75)',
  },
};
// Set once per frame by draw(). Module-level so the paint helpers don't each
// need a theme parameter threaded through them; rendering is synchronous.
let TH = THEMES.dark;

// ---------- Rendering ----------
function draw(ctx, opts) {
  const { view, doc, result, layers, dpr, drawing, hover, selection, size,
          stallSel, aisleSel, marquee, sitePoly } = opts;
  TH = THEMES[opts.theme] || THEMES.dark;
  const site = sitePoly || doc.site;
  const { w2s } = makeTransform(view);
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size.w, size.h); // transparent — the Mapbox basemap shows through

  const selAnnIdx = selection && selection.type === 'annot' ? selection.index : -1;

  // Grid
  if (layers.grid) drawGrid(ctx, view, size);

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

  // Aisles (drawn under stalls) with one-way arrows and selection highlight
  if (layers.parking) {
    for (const a of result.aisles) {
      pathPoly(ctx, a.poly, w2s, true);
      ctx.fillStyle = aisleSel === a.key ? 'rgba(59,130,246,0.32)' : TH.aisle;
      ctx.fill();
      if (aisleSel === a.key) { ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2; ctx.stroke(); }
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
    doc.obstacles.forEach((o, i) => {
      const op = polyOf(o);
      pathPoly(ctx, op, w2s, true);
      ctx.fillStyle = selection && selection.type === 'obs' && selection.index === i
        ? 'rgba(239,68,68,0.28)' : TH.building;
      ctx.fill();
      ctx.strokeStyle = selection && selection.type === 'obs' && selection.index === i ? '#ef4444' : TH.buildingLine;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Floor count badge when zoomed in.
      const floors = (o && o.floors) || 1;
      if (view.scale >= 4 && op.length >= 3) {
        const c = w2s(polygonCentroid(op));
        ctx.fillStyle = TH.badge;
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(floors + (floors > 1 ? ' verd.' : ' verd.'), c.x, c.y);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
      }
    });
  }

  // Stalls (coloured by type, with glyphs when zoomed in + selection)
  if (layers.parking) {
    const selSet = new Set(stallSel || []);
    const showGlyph = view.scale >= 5.5;
    for (const st of result.stalls) {
      pathPoly(ctx, st.poly, w2s, true);
      const info = STALL_TYPES[st.type] || STALL_TYPES.standard;
      ctx.fillStyle = info.color;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      const selected = selSet.has(st.key);
      ctx.strokeStyle = selected ? TH.sel : TH.outline;
      ctx.lineWidth = selected ? 2 : 0.6;
      ctx.stroke();
      if (st.locked) { // dashed white outline marks a locked stall
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = TH.onStall;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (st.type === 'motorcycle') { // subdivide into 3 motorcycle bays
        const p = st.poly;
        ctx.strokeStyle = TH.onStall;
        ctx.lineWidth = 0.8;
        for (const t of [1 / 3, 2 / 3]) {
          const a = w2s({ x: p[0].x + (p[1].x - p[0].x) * t, y: p[0].y + (p[1].y - p[0].y) * t });
          const b = w2s({ x: p[3].x + (p[2].x - p[3].x) * t, y: p[3].y + (p[2].y - p[3].y) * t });
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      if (showGlyph && info.glyph) {
        const s = w2s(polygonCentroid(st.poly));
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

  // Infrastructure drawn over the parking (paths, crosswalks, markings)
  if (layers.infra && doc.annotations) {
    drawAnnotations(ctx, doc.annotations, w2s, view.scale, false, selAnnIdx);
  }

  // Driveway placement preview (snapped to the site edge)
  if (hover && hover.driveway) {
    drawDriveway(ctx, hover.driveway, w2s, view.scale, true);
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
    // Resize handles on the selected annotation (except driveways).
    if (selection && selection.type === 'annot') {
      const a = (doc.annotations || [])[selection.index];
      if (a && a.kind !== 'driveway' && a.points) for (const p of a.points) drawHandle(ctx, w2s(p), '#60a5fa');
    }
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

// ---------- Belgian markings, pictograms and signage ----------
// Each painter draws inside a unit box centred on the origin (-1..1) with the
// caller handling position, scale and rotation. Keeps them resolution-free and
// lets any of them be rotated onto a road tangent.
function pathFrom(ctx, pts, close) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  if (close) ctx.closePath();
}
// A road arrow: shaft plus head, optionally with a branch to one side.
function arrow(ctx, branch) {
  ctx.fillStyle = '#f8fafc';
  pathFrom(ctx, [[-0.16, 0.95], [0.16, 0.95], [0.16, -0.3], [-0.16, -0.3]], true);
  ctx.fill();
  pathFrom(ctx, [[-0.45, -0.25], [0.45, -0.25], [0, -0.95]], true);
  ctx.fill();
  if (branch) {
    const sx = branch === 'left' ? -1 : 1;
    pathFrom(ctx, [[0, 0.35], [sx * 0.62, 0.35], [sx * 0.62, 0.12], [0, 0.12]], true);
    ctx.fill();
    pathFrom(ctx, [[sx * 0.55, 0.46], [sx * 0.55, 0.01], [sx * 0.95, 0.235]], true);
    ctx.fill();
  }
}
function glyph(ctx, txt, size, color) {
  ctx.fillStyle = color || '#f8fafc';
  ctx.font = `bold ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, 0, 0);
}
// Plate shapes for vertical signage, drawn face-on with a small post shadow.
function plate(ctx, shape, fill, rim) {
  ctx.fillStyle = fill;
  if (shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); }
  else if (shape === 'triangle') { pathFrom(ctx, [[0, -1], [1, 0.82], [-1, 0.82]], true); ctx.fill(); }
  else if (shape === 'octagon') {
    const p = []; for (let i = 0; i < 8; i++) { const a = (Math.PI / 4) * i + Math.PI / 8; p.push([Math.cos(a), Math.sin(a)]); }
    pathFrom(ctx, p, true); ctx.fill();
  } else { pathFrom(ctx, [[-1, -1], [1, -1], [1, 1], [-1, 1]], true); ctx.fill(); }
  if (rim) {
    ctx.strokeStyle = rim; ctx.lineWidth = 0.22; ctx.stroke();
  }
}
const PICTOS = {
  arrowAhead: (ctx) => arrow(ctx),
  arrowLeft: (ctx) => { ctx.rotate(-Math.PI / 2); arrow(ctx); },
  arrowRight: (ctx) => { ctx.rotate(Math.PI / 2); arrow(ctx); },
  arrowAheadL: (ctx) => arrow(ctx, 'left'),
  arrowAheadR: (ctx) => arrow(ctx, 'right'),
  speed: (ctx, ann) => {
    ctx.fillStyle = '#f8fafc';
    glyph(ctx, String(ann && ann.value != null ? ann.value : 20), 1.5, '#f8fafc');
  },
  bike: (ctx) => {
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 0.16; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(-0.55, 0.42, 0.4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0.55, 0.42, 0.4, 0, Math.PI * 2); ctx.stroke();
    pathFrom(ctx, [[-0.55, 0.42], [-0.1, -0.35], [0.35, -0.35], [0.55, 0.42]], false); ctx.stroke();
    pathFrom(ctx, [[-0.1, -0.35], [0.55, 0.42]], false); ctx.stroke();
    pathFrom(ctx, [[0.2, -0.62], [0.5, -0.62]], false); ctx.stroke();
  },
  ev: (ctx) => {
    ctx.fillStyle = '#f8fafc';
    pathFrom(ctx, [[0.18, -0.95], [-0.5, 0.1], [-0.05, 0.1], [-0.22, 0.95], [0.5, -0.15], [0.02, -0.15]], true);
    ctx.fill();
  },
  ada: (ctx) => {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath(); ctx.arc(-0.05, -0.62, 0.24, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 0.19; ctx.lineCap = 'round';
    pathFrom(ctx, [[-0.05, -0.3], [-0.05, 0.2], [0.45, 0.2]], false); ctx.stroke();
    ctx.beginPath(); ctx.arc(-0.08, 0.35, 0.5, -0.5, Math.PI * 0.95); ctx.stroke();
    pathFrom(ctx, [[0.45, 0.2], [0.62, 0.75]], false); ctx.stroke();
  },
  walk: (ctx) => {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath(); ctx.arc(0, -0.68, 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 0.18; ctx.lineCap = 'round';
    pathFrom(ctx, [[0, -0.4], [0, 0.15]], false); ctx.stroke();
    pathFrom(ctx, [[-0.35, -0.15], [0.35, -0.2]], false); ctx.stroke();
    pathFrom(ctx, [[0, 0.15], [-0.28, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[0, 0.15], [0.3, 0.88]], false); ctx.stroke();
  },
  letterP: (ctx) => glyph(ctx, 'P', 1.8, '#f8fafc'),
  family: (ctx) => {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath(); ctx.arc(-0.4, -0.55, 0.24, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(0.42, -0.28, 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 0.17; ctx.lineCap = 'round';
    pathFrom(ctx, [[-0.4, -0.28], [-0.4, 0.35]], false); ctx.stroke();
    pathFrom(ctx, [[-0.4, 0.35], [-0.62, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[-0.4, 0.35], [-0.18, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[0.42, -0.08], [0.42, 0.42]], false); ctx.stroke();
    pathFrom(ctx, [[0.42, 0.42], [0.26, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[0.42, 0.42], [0.6, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[-0.4, 0.02], [0.42, 0.06]], false); ctx.stroke();
  },
  // ---- signage ----
  signYield: (ctx) => { plate(ctx, 'triangle', '#ffffff', '#d92b2b'); },
  signStop: (ctx) => { plate(ctx, 'octagon', '#d92b2b'); glyph(ctx, 'STOP', 0.52, '#ffffff'); },
  signSpeed: (ctx, ann) => {
    plate(ctx, 'circle', '#ffffff', '#d92b2b');
    glyph(ctx, String(ann && ann.value != null ? ann.value : 20), 0.95, '#111827');
  },
  signNoEntry: (ctx) => {
    plate(ctx, 'circle', '#d92b2b');
    ctx.fillStyle = '#ffffff';
    pathFrom(ctx, [[-0.62, -0.17], [0.62, -0.17], [0.62, 0.17], [-0.62, 0.17]], true); ctx.fill();
  },
  signParking: (ctx) => { plate(ctx, 'rect', '#1d4ed8'); glyph(ctx, 'P', 1.3, '#ffffff'); },
  signOneWay: (ctx) => {
    plate(ctx, 'rect', '#1d4ed8');
    ctx.fillStyle = '#ffffff';
    pathFrom(ctx, [[-0.6, -0.12], [0.25, -0.12], [0.25, -0.38], [0.75, 0], [0.25, 0.38], [0.25, 0.12], [-0.6, 0.12]], true);
    ctx.fill();
  },
  signAda: (ctx) => { plate(ctx, 'rect', '#1d4ed8'); ctx.save(); ctx.scale(0.62, 0.62); PICTOS.ada(ctx); ctx.restore(); },
  signEV: (ctx) => { plate(ctx, 'rect', '#15803d'); ctx.save(); ctx.scale(0.62, 0.62); PICTOS.ev(ctx); ctx.restore(); },
};

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
  ctx.lineWidth = Math.max(1, (bays ? 0.12 : 0.15) * scale);
  const gap = Math.max(8, (bays ? 2.7 : 1.2) * scale);
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
    const A = ann.points[0], B = ann.points[1];
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
    if (len < 0.1) return;
    const ux = dx / len, uy = dy / len, px = -uy, py = ux, half = (ann.width || 3.5) / 2;
    const step = 1.2, stripe = 0.6;
    ctx.fillStyle = selected ? TH.sel : '#e9edf2';
    for (let s = 0; s < len; s += step) {
      const s2 = Math.min(s + stripe, len);
      const q = [
        { x: A.x + ux * s + px * half, y: A.y + uy * s + py * half },
        { x: A.x + ux * s2 + px * half, y: A.y + uy * s2 + py * half },
        { x: A.x + ux * s2 - px * half, y: A.y + uy * s2 - py * half },
        { x: A.x + ux * s - px * half, y: A.y + uy * s - py * half },
      ].map(w2s);
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
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
    ctx.fillStyle = ann.kind === 'grass' ? hexA(t.color, 0.5) : 'rgba(14,116,144,0.35)';
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

  // Line kinds (road, walkway, bikepath, marking); `closed` = filled area (plein).
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

function drawAnnotations(ctx, anns, w2s, scale, under, selIdx) {
  for (let i = 0; i < anns.length; i++) {
    const t = ANNOT_TYPES[anns[i].kind];
    if (!t || !!t.under !== under) continue;
    drawAnnotation(ctx, anns[i], w2s, scale, i === selIdx, i);
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
  const [layers, setLayers] = useState({ grid: true, site: true, setback: true, building: true, parking: true, infra: true });
  const [annotKind, setAnnotKind] = useState('road'); // active infra kind when drawing
  const [annotWidth, setAnnotWidth] = useState(6);
  const [areaShape, setAreaShape] = useState('poly'); // 'rect' | 'poly' | 'circle' for area infra
  const [roadShape, setRoadShape] = useState('line'); // 'line' | 'rect' for roads (draggable object)
  const [annotCurved, setAnnotCurved] = useState(true);
  const [toolQuery, setToolQuery] = useState('');
  // Saved layout. Absent id => visible, so a part added later is on by default
  // rather than silently missing for everyone who already saved a layout.
  const [hidden, setHidden] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pp_ui_hidden') || '{}') || {}; } catch (e) { return {}; }
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
  const [aisleSel, setAisleSel] = useState(null);         // selected aisle key
  const [result, setResult] = useState({ stalls: [], aisles: [], orientationCount: 0 });
  const [solving, setSolving] = useState(false);
  const [geoSearch, setGeoSearch] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoMsg, setGeoMsg] = useState('');
  const [viewMode, setViewMode] = useState('2d');            // '2d' (flat map) | '3d' (tilted map)
  const [mbToken, setMbToken] = useState(() => { try { return localStorage.getItem('pp_mapbox_token') || ''; } catch (e) { return ''; } });
  const [mapStyle, setMapStyle] = useState(() => { try { return localStorage.getItem('pp_map_style') || 'satellite'; } catch (e) { return 'satellite'; } });
  // Light by default; the stored choice wins, then the OS preference.
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('pp_theme');
      if (saved === 'light' || saved === 'dark') return saved;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  });
  const [mbTokenInput, setMbTokenInput] = useState('');
  const [map3dError, setMap3dError] = useState('');
  const [mapDiag, setMapDiag] = useState({});      // per-stage basemap status
  const [diagOpen, setDiagOpen] = useState(false);
  const [mapNonce, setMapNonce] = useState(0);     // bump to force a map retry
  const [mapReady, setMapReady] = useState(0);     // bumped once the controller exists
  const [stallRot, setStallRot] = useState(0);     // extra stall rotation in degrees (R key)
  const [exportOpen, setExportOpen] = useState(false);
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
  const dupRef = useRef(() => {});    // latest duplicateSelection (for Cmd/Ctrl+D)
  const docRef = useRef(null);        // latest doc for the window key handler
  const vmRef = useRef('2d');          // latest viewMode (for the native wheel handler)
  const viewRef = useRef(null);        // latest view (async map init reads this, not a stale capture)
  const geoRef = useRef(null);         // latest doc.geo, same reason
  const drewRef = useRef(false); // set once the first frame draws (breadcrumb)
  const marqueeRef = useRef(null); // {x0,y0,x1,y1} in world coords while dragging
  const guidesRef = useRef(null);  // alignment guides shown during a move drag
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

  // Solve off the main thread via a web worker, so big sites don't freeze
  // the UI. Falls back to an inline solve if workers aren't available.
  useEffect(() => {
    let w;
    try { w = new Worker(new URL('./solver.worker.js?v=b5dc4bf3', import.meta.url), { type: 'module' }); }
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
      setResult({ stalls: [], aisles: [], islands: [], orientationCount: 0 });
      setSolving(false);
      return;
    }
    setSolving(true);
    solveTimer.current = setTimeout(() => {
      // Align rows to the site's longest (control-point) edge when requested.
      const solveP = doc.params.alignLongestEdge && doc.site.length >= 2
        ? { ...doc.params, alignAngle: longestEdgeAngle(doc.site) }
        : doc.params;
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
  }, [sitePoly, doc.obstacles, roadBlockers, doc.params, doc.orientationIndex, doc.autoParking]);

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
    const aisles = result.aisles.map((q) => {
      const key = aisleKey(q);
      const o = ovAisles[key] || {};
      return { poly: q, key, oneway: !!o.oneway, dir: o.dir || 1, locked: !!lockA[key] };
    });
    return { stalls, aisles, islands: result.islands || [], orientationCount: result.orientationCount };
  }, [result, doc.overrides, doc.manualStalls, doc.params.stallWidth, doc.params.stallDepth]);

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
        showHandles: tool === 'select', theme, measure, guides: guidesRef.current,
        stallSel, aisleSel, marquee: marqueeRef.current, sitePoly,
      });
    }
    if (!drewRef.current) { drewRef.current = true; mark('ok'); }
  }, [view, doc, deco, layers, drawing, hover, selection, tool, stallSel, aisleSel, viewMode, sitePoly, theme, measure]);

  renderRef.current = renderNow;
  docRef.current = doc;
  vmRef.current = viewMode;
  // The map lifecycle effect finishes asynchronously, long after the render that
  // started it. Reading view/geo from refs keeps the first sync on the CURRENT
  // camera instead of the one captured when the effect ran.
  viewRef.current = view;
  geoRef.current = doc.geo;
  useEffect(() => { renderNow(); }, [renderNow]);

  // Snapshot of everything the 3D view draws.
  const buildPlan = useCallback(() => ({
    site: sitePoly, obstacles: doc.obstacles,
    stalls: deco.stalls, aisles: deco.aisles, annotations: doc.annotations,
  }), [sitePoly, doc.obstacles, deco, doc.annotations]);

  // The Mapbox basemap lives for the whole session once a token is set. It sits
  // behind the canvas: flat in 2D (tracking our camera), tilted in 3D (with the
  // plan draped as GeoJSON layers).
  useEffect(() => {
    // No token or style 'Geen' → no map; the plan renders on the dark backdrop.
    if (!mbToken || mapStyle === 'none') { if (map3dRef.current) { map3dRef.current.destroy(); map3dRef.current = null; } return; }
    let cancelled = false;
    setMap3dError('');
    const container = document.getElementById('pp-map');
    if (!container) return;
    import('./map3d.js?v=b5dc4bf3').then(async (m) => {
      if (cancelled) return;
      const onDiag = (d) => setMapDiag((prev) => ({ ...prev, ...d }));
      const ctrl = await m.initMap(container, mbToken, doc.geo, buildPlan(), (msg) => setMap3dError(msg), MAP_STYLES[mapStyle], onDiag);
      if (cancelled || !ctrl) { if (ctrl) ctrl.destroy(); return; }
      map3dRef.current = ctrl;
      ctrl.setMode(vmRef.current === '3d');
      if (vmRef.current !== '3d') { const c = mapCamFromView(viewRef.current, sizeRef.current, geoRef.current); ctrl.follow2D(c.center, c.zoom); }
      setTimeout(() => ctrl.resize(), 100);
      // map3dRef is a ref, so assigning it re-renders nothing and the follow
      // effect below would never re-run. Bump state so it syncs now rather than
      // waiting for the user to pan.
      setMapReady((n) => n + 1);
    }).catch(() => setMap3dError('Mapbox kon niet laden.'));
    return () => { cancelled = true; if (map3dRef.current) { map3dRef.current.destroy(); map3dRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mbToken, mapStyle, mapNonce]);

  // Keep the flat basemap locked to our canvas camera in 2D.
  useEffect(() => {
    const ctrl = map3dRef.current;
    if (!ctrl) return;
    if (viewMode === '3d') return;
    const c = mapCamFromView(view, sizeRef.current, doc.geo);
    ctrl.follow2D(c.center, c.zoom);
    // Keep the controller's geo anchor current too: it converts the plan to
    // GeoJSON, so a location search would otherwise drape the plan at the old
    // anchor in 3D.
    if (ctrl.setGeo) ctrl.setGeo(doc.geo);
  }, [view, viewMode, doc.geo, sitePoly, mapReady]);

  // Drive the CSS token set off the root element and remember the choice.
  useEffect(() => {
    try {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('pp_theme', theme);
    } catch (e) {}
  }, [theme]);

  // Tilt / plan-drape on 2D↔3D switch, and keep the draped plan fresh in 3D.
  useEffect(() => { if (map3dRef.current) map3dRef.current.setMode(viewMode === '3d'); }, [viewMode]);
  useEffect(() => { if (map3dRef.current && viewMode === '3d') map3dRef.current.setPlan(buildPlan()); }, [buildPlan, viewMode]);

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
  const clearSel = () => { setStallSel([]); setAisleSel(null); setSelection(null); };

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
  const roadLines = useMemo(() => (doc.annotations || [])
    .filter((a) => {
      const t = ANNOT_TYPES[a.kind];
      return t && t.mode === 'line' && t.blocks && a.points && a.points.length >= 2;
    })
    .map((a) => {
      const pts = tessellateOpen(a.points, !!a.curved);
      const cum = polylineCum(pts);
      return { pts, cum, len: cum[cum.length - 1], half: (a.width || ANNOT_TYPES[a.kind].width || 6) / 2 };
    })
    .filter((l) => l.len > 0.1), [doc.annotations]);

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
  const addAnnotation = (ann) =>
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, annotations: [...(d.annotations || []), ann] }) });
  const deleteAnnotation = (index) =>
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, annotations: (d.annotations || []).filter((_, i) => i !== index) }) });
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
  const startAnnot = (kind) => {
    const t = ANNOT_TYPES[kind];
    setAnnotKind(kind);
    setAnnotWidth(t.width || 2);
    setAnnotCurved(!!t.curved);
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
    // Corner handles on the selected annotation (resize by dragging) — not for
    // driveways, which keep their edge-frame shape.
    if (selection && selection.type === 'annot') {
      const a = (doc.annotations || [])[selection.index];
      if (a && a.kind !== 'driveway' && a.points) {
        for (let vi = 0; vi < a.points.length; vi++)
          if (dist(w2s(a.points[vi]), sp) < 9) return { type: 'annV', ann: selection.index, index: vi };
      }
    }
    return null;
  };

  const onPointerDown = (e) => {
    if (viewMode !== '2d') return; // 3D is handled by the Mapbox map (canvas is pass-through)
    if (e.button === 2) return;    // right-click handled by onContextMenu (add vertex)
    e.target.setPointerCapture?.(e.pointerId);
    const sp = getScreen(e);
    const wp = getWorld(e);

    // Middle-button or pan tool → pan.
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
        setSelection({ type: 'annot', index: pi }); setStallSel([]); setAisleSel(null);
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
        setSelection({ type: 'annot', index: ai }); setStallSel([]); setAisleSel(null);
        const a = (doc.annotations || [])[ai];
        if (a && a.points) {
          dispatch({ type: 'CHECKPOINT' });
          dragRef.current = { mode: 'annotMove', start: wp, index: ai, orig: a.points, origAnchor: a.anchor };
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
          setSelection({ type: 'obs', index: i }); setStallSel([]); setAisleSel(null);
          dispatch({ type: 'CHECKPOINT' });
          dragRef.current = { mode: 'obsMove', start: wp, index: i, orig: polyOf(doc.obstacles[i]) };
          return;
        }
      }
      // Empty space → marquee-select stalls (drag a box).
      const addSel = e.shiftKey || e.metaKey || e.ctrlKey;
      if (!addSel) { setSelection(null); setStallSel([]); setAisleSel(null); }
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
        // Markings and signs read along the road they belong to, so line them
        // up with the nearest one. R adjusts from there.
        if (t.picto) ann.angle = (roadAngleAt(wp) + stallRot) % 360;
        addAnnotation(ann);
        return;
      }
      // Road as a draggable rectangle object (resize afterwards via corners).
      if (annotKind === 'road' && roadShape === 'rect') {
        dragRef.current = { mode: 'annotArea', start: snap, cur: snap, roadRect: true };
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
    const drag = dragRef.current;

    if (!drag) {
      if (tool === 'annot' && annotKind === 'driveway') {
        if (sitePoly && sitePoly.length >= 3) {
          const frame = siteEdgeFrame(wp, sitePoly, polygonCentroid(sitePoly));
          setHover(frame ? { driveway: makeDriveway(frame, annotWidth, ANNOT_TYPES.driveway.depth || 12) } : null);
        }
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
      dispatch({ type: 'LIVE', updater: (d) => ({
        ...d,
        annotations: (d.annotations || []).map((a, i) => (i !== drag.index ? a : {
          ...a,
          points: drag.orig.map((p) => ({ x: p.x + dx, y: p.y + dy })),
          ...(drag.origAnchor ? { anchor: { x: drag.origAnchor.x + dx, y: drag.origAnchor.y + dy } } : {}),
        })),
      }) });
    } else if (drag.mode === 'obsMove') {
      const a1 = alignSnap(drag.orig, wp.x - drag.start.x, wp.y - drag.start.y);
      const dx = a1.dx, dy = a1.dy;
      guidesRef.current = a1.guides;
      dispatch({ type: 'LIVE', updater: (d) => ({
        ...d,
        obstacles: d.obstacles.map((o, i) => (i !== drag.index ? o
          : { ...(o && o.poly ? o : {}), poly: drag.orig.map((p) => ({ x: p.x + dx, y: p.y + dy })), floors: (o && o.floors) || 1 })),
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

  // Right-click on a site or building edge inserts a new vertex there.
  const onContextMenu = (e) => {
    if (viewMode !== '2d') return;
    const sp = getScreen(e);
    const wp = getWorld(e);
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
    if (!best) return; // not near an edge → leave the native menu alone
    e.preventDefault();
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
  };

  const onPointerUp = (e) => {
    const drag = dragRef.current;
    dragRef.current = null;
    guidesRef.current = null;
    if (!drag) return;
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
        dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: [...d.obstacles, { poly, floors: 1 }] }) });
      }
      setHover(null);
      setTool('select');
    } else if (drag.mode === 'annotArea') {
      const r = rectFrom(drag.start, drag.cur);
      if (Math.abs(r.w) > 0.5 && Math.abs(r.h) > 0.5) {
        const isRoad = !!drag.roadRect;
        addAnnotation({ kind: annotKind, points: rectPoly(r.x, r.y, r.w, r.h), width: 0, closed: isRoad });
        if (isRoad) { setSelection({ type: 'annot', index: (doc.annotations || []).length }); setTool('select'); }
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
        if (maxX - minX > 0.5 || maxY - minY > 0.5) {
          const hitKeys = deco.stalls.filter((st) => {
            const c = polygonCentroid(st.poly);
            return c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY;
          }).map((st) => st.key);
          if (hitKeys.length) {
            setSelection(null); setAisleSel(null);
            setStallSel((cur) => drag.add ? Array.from(new Set([...cur, ...hitKeys])) : hitKeys);
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
    } else if (tool === 'annot' && ANNOT_TYPES[annotKind].mode === 'area' && drawing && drawing.points.length >= 3) {
      finishAreaPoly(drawing.points);
    } else if (tool === 'annot' && drawing && drawing.points.length >= 2) {
      finishAnnotLine(drawing.points, false);
    } else if (!drawing) {
      // Double-click a road (or any annotation) to add a point where you
      // clicked, so the shape can be refined by dragging. Selection itself
      // already happened on the preceding pointer-down.
      const sp = getScreen(e);
      const ai = hitAnnotation(sp);
      if (ai < 0) return;
      setTool('select'); setStallSel([]); setAisleSel(null);
      setSelection({ type: 'annot', index: ai });
      const ann = (doc.annotations || [])[ai];
      if (!ann || ann.kind === 'driveway' || !ann.points || ann.points.length < 2) return;
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
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: [...d.obstacles, { poly: points.slice(), floors: 1 }] }) });
  };
  const setObsFloors = (index, floors) => dispatch({ type: 'COMMIT', updater: (d) => ({
    ...d,
    obstacles: d.obstacles.map((o, i) => (i === index ? { poly: polyOf(o).slice(), floors: Math.max(1, floors || 1) } : o)),
  }) });
  const deleteObs = (index) => dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: d.obstacles.filter((_, i) => i !== index) }) });

  // Duplicate whatever is selected (building, annotation, or stalls), offset a
  // little so the copy is visible, and select the copy.
  const offsetPts = (pts, dx, dy) => pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  const duplicateSelection = () => {
    const D = 4;
    if (selection && selection.type === 'obs' && doc.obstacles[selection.index]) {
      const o = doc.obstacles[selection.index];
      const copy = Array.isArray(o) ? offsetPts(o, D, D) : { ...o, poly: offsetPts(polyOf(o), D, D) };
      const idx = doc.obstacles.length;
      dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: [...d.obstacles, copy] }) });
      setSelection({ type: 'obs', index: idx });
    } else if (selection && selection.type === 'annot' && (doc.annotations || [])[selection.index]) {
      const a = doc.annotations[selection.index];
      const copy = { ...a, points: offsetPts(a.points, D, D) };
      if (a.anchor) copy.anchor = { x: a.anchor.x + D, y: a.anchor.y + D };
      const idx = (doc.annotations || []).length;
      dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, annotations: [...(d.annotations || []), copy] }) });
      setSelection({ type: 'annot', index: idx });
    } else if (stallSel.length) {
      const copies = stallSel.map((k) => { const st = deco.stalls.find((s) => s.key === k); return st ? { poly: offsetPts(st.poly, D, D), type: st.type } : null; }).filter(Boolean);
      if (!copies.length) return;
      dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, manualStalls: [...(d.manualStalls || []), ...copies] }) });
      setStallSel(copies.map((c) => stallKey(c.poly)));
    }
  };
  dupRef.current = duplicateSelection;

  // Wheel handling is attached natively (passive:false) so preventDefault
  // works — see the effect below. Pinch/Ctrl+wheel zooms; two-finger
  // trackpad scroll pans.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheelNative = (e) => {
      if (vmRef.current === '3d') return; // 3D wheel is handled by the Mapbox map
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        setView((v) => {
          const s = Math.max(1, Math.min(60, v.scale * Math.exp(-e.deltaY * 0.01)));
          const k = s / v.scale;
          return { scale: s, ox: cx - (cx - v.ox) * k, oy: cy - (cy - v.oy) * k };
        });
      } else {
        setView((v) => ({ ...v, ox: v.ox - e.deltaX, oy: v.oy - e.deltaY }));
      }
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
      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break;
        case 'p': setTool('site'); setDrawing({ points: [] }); break;
        case 'b': setTool('obstacle'); break;
        case 'n': setTool('obstaclepoly'); setDrawing({ points: [] }); break;
        case 'k': setTool('placestall'); break;
        case 'm': setTool('measure'); setMeasure({ points: [] }); setDrawing(null); break;
        case ' ': setTool('pan'); break;
        case 'g': setLayers((l) => ({ ...l, grid: !l.grid })); break;
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
        case 'escape': setDrawing(null); setMeasure(null); setTool('select'); setSelection(null); setStallSel([]); setAisleSel(null); break;
        case 'delete': case 'backspace':
          if (stallSel.length) {
            deleteStalls(stallSel); setStallSel([]);
          } else if (selection && selection.type === 'obs') {
            dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: d.obstacles.filter((_, i) => i !== selection.index) }) });
            setSelection(null);
          } else if (selection && selection.type === 'annot') {
            deleteAnnotation(selection.index); setSelection(null);
          } else if (selection && selection.type === 'site') {
            dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, site: [] }) }); setSelection(null);
          }
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, stallSel]);

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
    downloadBlob(blob, 'parkplanner.json');
  };
  // Apply a loaded file. Accepts the new wrapped format ({_pp, doc, view,
  // basemapStyle}) as well as a bare document from older saves.
  const applyLoaded = (payload) => {
    const d = payload && payload.doc && payload.doc.site ? payload.doc : payload;
    if (!(d && d.site && d.params)) { alert('Ongeldig bestand'); return false; }
    const merged = { ...initialDoc, ...d };
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
    downloadBlob(new Blob([toCSV(buildPlan(), metrics)], { type: 'text/csv;charset=utf-8' }), 'parkplanner.csv');
  const newRect = () => {
    dispatch({ type: 'RESET', doc: { ...initialDoc, site: rectPoly(0, 0, 80, 50), obstacles: [] } });
    setTimeout(fitToSite, 0);
  };

  // Re-anchor the plan so the site centroid sits at a geographic point.
  const centerOnLatLon = (lat, lon) => {
    const c = polygonCentroid(doc.site);
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
    setMbToken(t); setMbTokenInput(''); setMap3dError('');
  };
  const clearMbToken = () => {
    try { localStorage.removeItem('pp_mapbox_token'); } catch (e) {}
    setMbToken(''); setMap3dError('');
  };
  const changeMapStyle = (s) => {
    try { localStorage.setItem('pp_map_style', s); } catch (e) {}
    setMap3dError(''); setMapDiag({}); setMapStyle(s);
  };
  const retryMap = () => { setMap3dError(''); setMapDiag({}); setMapNonce((n) => n + 1); };

  // Palette grouped and filtered. A query searches label + synonyms and forces
  // every matching group open, so results are never hidden behind a collapse.
  const paletteGroups = useMemo(() => {
    const q = toolQuery.trim().toLowerCase();
    const out = [];
    for (const grp of ANNOT_GROUPS) {
      const items = Object.entries(ANNOT_TYPES).filter(([k, t]) => (t.group || 'Overig') === grp
        && (!q || (t.label + ' ' + k + ' ' + (t.keywords || '')).toLowerCase().includes(q)));
      if (items.length) out.push([grp, items]);
    }
    return out;
  }, [toolQuery]);
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
      onDblClick=${() => { const w = { ...panelW, [side]: PANEL_W[side].def }; setPanelW(w); persist('pp_panel_widths', w); }}
      title=${'Sleep om te verbreden · dubbelklik voor standaard'}></div>`;

  // Every shortcut in one place. Half of these existed but were invisible —
  // nothing on screen mentioned G, R, Esc, Delete or Cmd+D.
  const SHORTCUTS = [
    ['Gereedschap', [['V', 'Selecteren'], ['P', 'Site tekenen'], ['B', 'Gebouw (rechthoek)'], ['N', 'Gebouw (vrije vorm)'], ['K', 'Parkeervak plaatsen'], ['M', 'Meetlint'], ['Spatie', 'Pannen']]],
    ['Bewerken', [['Cmd/Ctrl + Z', 'Ongedaan maken'], ['Shift + Cmd/Ctrl + Z', 'Opnieuw'], ['Cmd/Ctrl + D', 'Dupliceren'], ['Delete', 'Verwijderen'], ['Esc', 'Annuleren / deselecteren']]],
    ['Tekenen', [['Shift (slepen)', 'Uitlijnen per 15 graden'], ['R', 'Draai 15 graden'], ['Shift + R', 'Draai terug'], ['Dubbelklik op weg', 'Punt toevoegen'], ['Rechtsklik op rand', 'Punt toevoegen aan site']]],
    ['Weergave', [['G', 'Raster aan/uit'], ['+ / -', 'In- en uitzoomen'], ['/', 'Zoek gereedschap'], ['?', 'Dit overzicht']]],
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

  // The one control that is never hideable — hiding it would lock you out.
  const viewMenu = () => html`
    <div className="dropdown">
      <button className="btn ghost" onClick=${() => setViewMenuOpen((o) => !o)} title="Toon of verberg onderdelen">👁 Weergave ▾</button>
      ${viewMenuOpen && html`
        <div className="menu view-menu" onMouseLeave=${() => setViewMenuOpen(false)}>
          <div className="vm-row vm-actions">
            ${Object.keys(WORKSPACE_PRESETS).map((n) => html`
              <button key=${n} className="btn ghost" onClick=${() => applyWorkspace(n)}>${n}</button>`)}
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
        : 'Klik de site-rand om te verplaatsen/verwijderen · rechtermuisklik op een rand voegt een punt toe · klik een vak of rijbaan om te markeren · sleep een kader voor meerdere vakken'),
  }[tool];

  return html`
    <div className="app" style=${{
      '--left-w': (vis('panelLeft') ? panelW.left : 0) + 'px',
      '--right-w': (vis('panelRight') ? panelW.right : 0) + 'px',
    }}>
      <div className="toolbar">
        <div className="brand"><span className="logo">🅿️</span><span>ParkPlanner</span></div>
        <div className="tb-sep"></div>
        ${vis('tbTools') && html`
          ${toolBtn('select', 'Selecteer', 'V', tool, setTool, setDrawing)}
          ${toolBtn('site', 'Site', 'P', tool, setTool, setDrawing)}
          ${toolBtn('obstacle', 'Gebouw ▭', 'B', tool, setTool, setDrawing)}
          ${toolBtn('obstaclepoly', 'Gebouw ⬠', 'N', tool, setTool, setDrawing)}
          ${toolBtn('placestall', 'Vak +', 'K', tool, setTool, setDrawing)}
          ${toolBtn('pan', 'Pan', '␣', tool, setTool, setDrawing)}
          <button className=${'btn' + (tool === 'measure' ? ' active' : '')}
            onClick=${() => { setTool('measure'); setMeasure({ points: [] }); setDrawing(null); }}>📏 Meet <kbd>M</kbd></button>`}
        ${vis('tbNewSite') && html`<button className="btn ghost" onClick=${newRect}>Nieuwe site</button>`}
        <div className="tb-sep"></div>
        ${vis('tbAxis') && html`
          <button className="btn" onClick=${cycleAxis} title="Wissel rij-oriëntatie">↻ Rij-as ${result.orientationCount ? `(${doc.orientationIndex + 1}/${result.orientationCount})` : ''}</button>
          <button className="btn ghost" onClick=${resetAxis}>Reset</button>`}
        ${vis('tbUndo') && html`
          <button className="btn ghost" onClick=${() => dispatch({ type: 'UNDO' })} disabled=${!hist.past.length}>↶ Undo</button>
          <button className="btn ghost" onClick=${() => dispatch({ type: 'REDO' })} disabled=${!hist.future.length}>↷ Redo</button>`}
        <div className="tb-sep"></div>
        ${vis('tbView') && html`
          <div className="seg view-seg">
            ${[['2d', '2D'], ['3d', '3D']].map(([m, lbl]) => html`
              <button key=${m} className=${viewMode === m ? 'active' : ''} onClick=${() => setViewMode(m)}>${lbl}</button>`)}
          </div>`}
        ${vis('tbTheme') && html`
          <button className="btn ghost" title=${theme === 'dark' ? 'Licht thema' : 'Donker thema'}
            onClick=${() => setTheme(theme === 'dark' ? 'light' : 'dark')}>${theme === 'dark' ? '☀️' : '🌙'}</button>`}
        <div className="tb-spacer"></div>
        ${vis('tbZoom') && html`
          <button className="btn ghost" onClick=${() => zoomBy(1 / 1.2)} title="Uitzoomen">−</button>
          <button className="btn ghost" onClick=${() => zoomBy(1.2)} title="Inzoomen">＋</button>
          <button className="btn ghost" onClick=${fitToSite}>⤢ Fit</button>`}
        ${vis('tbFile') && html`<button className="btn ghost" onClick=${saveJSON}>Opslaan</button>
        <label className="btn ghost">Laden<input type="file" accept="application/json" onChange=${loadJSON} style=${{ display: 'none' }} /></label>
        <label className="btn ghost" title="Perceelgrens importeren (GeoJSON of KML)">Perceel<input type="file" accept=".geojson,.json,.kml,application/geo+json,application/vnd.google-earth.kml+xml" onChange=${importParcel} style=${{ display: 'none' }} /></label>`}
        ${vis('tbExport') && html`
        <div className="dropdown">
          <button className="btn ghost" onClick=${() => setExportOpen((o) => !o)}>Export ▾</button>
          ${exportOpen && html`
            <div className="menu" onMouseLeave=${() => setExportOpen(false)}>
              <button onClick=${() => { exportPNG(); setExportOpen(false); }}>PNG-afbeelding</button>
              <button onClick=${() => { exportGeoJSON(); setExportOpen(false); }}>GeoJSON</button>
              <button onClick=${() => { exportDXF(); setExportOpen(false); }}>DXF (CAD)</button>
              <button onClick=${() => { exportCSV(); setExportOpen(false); }}>CSV (takeoff)</button>
            </div>`}
        </div>`}
        ${viewMenu()}
        <button className="btn ghost" title="Sneltoetsen (?)" onClick=${() => setKeysOpen(true)}>?</button>
      </div>

      ${vis('panelLeft') && html`
      <div className="panel left">
        ${resizer('left')}
        ${vis('secLocation') && html`
        <div className="section">
          <h3>Locatie</h3>
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
        </div>`}
        ${vis('secDraw') && html`
        <div className="section">
          <h3>Teken (infrastructuur)</h3>
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
                      <span className="dot" style=${{ background: t.color }}></span>${t.label}
                    </button>`)}
                </div>`}
            </div>`)}
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
                <button className=${roadShape === 'rect' ? 'active' : ''} onClick=${() => setRoadShape('rect')}>Object (rechthoek)</button>
              </div>
              <div className="mix-note">${roadShape === 'rect' ? 'Sleep een rechthoek; daarna selecteren en aan de hoeken slepen om te vergroten.' : 'Klik punten voor een weglijn.'}</div>
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
        ${vis('secLayers') && html`
        <div className="section">
          <h3>Lagen</h3>
          ${layerRow('grid', 'Raster', '#3b4453', layers, setLayers)}
          ${layerRow('site', 'Site-grens', '#f8b500', layers, setLayers)}
          ${layerRow('setback', 'Setback', '#6ee7ff', layers, setLayers)}
          ${layerRow('building', 'Gebouwen', '#64748b', layers, setLayers)}
          ${layerRow('parking', 'Parkeren', '#3b82f6', layers, setLayers)}
          ${layerRow('infra', 'Infrastructuur', '#0e7490', layers, setLayers)}
        </div>`}
        ${vis('secPreset') && html`
        <div className="section">
          <h3>Preset</h3>
          <select className="preset" onChange=${(e) => applyPreset(e.target.value)}>
            <option value="">— kies afmetingen —</option>
            ${Object.entries(PRESETS).map(([k, p]) => html`<option key=${k} value=${k}>${p.label}</option>`)}
          </select>
        </div>`}
        ${vis('secFoot') && html`<div className="foot">
          Open-source demonstrator van een parametrische parkeer­generator, geïnspireerd op TestFit's Parking Solver.
          De solver draait volledig in de browser: setback-offset → oriëntatie­zoektocht → strip-packing van dubbel-belaste modules.
        </div>`}
      </div>`}

      <div className="canvas-wrap" ref=${wrapRef}>
        <div id="pp-map" className="pp-map"></div>
        <canvas ref=${canvasRef}
          onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp}
          onDoubleClick=${onDoubleClick} onContextMenu=${onContextMenu}
          style=${{ pointerEvents: viewMode === '3d' ? 'none' : 'auto', cursor: tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }} />
        ${vis('ovHint') && viewMode === '2d' && hintText && html`<div className="hint">${hintText}</div>`}
        ${vis('ovHint') && viewMode === '3d' && html`<div className="hint">3D · sleep om te draaien/kantelen · scroll om te zoomen · alleen-lezen</div>`}
        ${vis('ovHud') && html`<div className="hud" style=${{ bottom: (dealbarOpen ? 96 : 12) + 'px' }}>
          <span><b>${metrics.total}</b> vakken</span>
          <span>·</span>
          <span>schaal <b>${view.scale.toFixed(1)}</b> px/m</span>
          <span>·</span>
          <span>${solving ? 'rekenen…' : 'live'}</span>
          ${tool === 'placestall' && html`
            <span>·</span>
            <span className="hud-rot">gedraaid <b>${stallRot}°</b>${stallRot ? '' : ' · R draait 15°'}</span>`}
        </div>`}
        ${vis('ovAttrib') && mbToken && mapStyle !== 'none' && !map3dError && html`<div className="attrib" style=${{ bottom: (dealbarOpen ? 96 : 6) + 'px' }}>© Mapbox © OpenStreetMap</div>`}

        ${vis('ovDealbar') && html`
          <div className=${'dealbar' + (dealbarOpen ? '' : ' closed')}>
            <button className="dealbar-toggle" onClick=${() => setDealbarOpen((o) => !o)}>${dealbarOpen ? '▾' : '▴'} Tabulatie</button>
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
        ${mbToken && map3dError && html`
          <div className="token-panel">
            <h4>Kaart niet beschikbaar</h4>
            <p>${map3dError}</p>
            <div className="sel-actions">
              <button className="btn" onClick=${clearMbToken}>Andere token invoeren</button>
            </div>
          </div>`}
      </div>

      ${vis('panelRight') && html`
      <div className="panel right">
        ${resizer('right')}
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
                  <label>Waarde (km/u)</label>
                  <input type="number" min="5" max="130" step="5" value=${ann.value != null ? ann.value : t.value}
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
          <h3>Gebouw geselecteerd</h3>
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
            <div className="sel-actions">
              <button className="btn" onClick=${() => flipAisle(aisleSel)} disabled=${!oneway}>⇄ Draai richting om</button>
              <button className="btn ghost" onClick=${() => toggleLockAisle(aisleSel, !locked)}>${locked ? '🔓 Ontgrendel' : '🔒 Vergrendel'}</button>
              <button className="btn ghost" onClick=${clearSel}>Deselecteer</button>
            </div>`;
          })()}
        </div>`}
        ${vis('secMetrics') && html`
        <div className="section">
          <h3 style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Metrics</span>
            <button className="btn ghost" style=${{ padding: '3px 8px', fontSize: '11px' }} onClick=${() => setSummaryOpen(true)}>📋 Samenvatting</button>
          </h3>
          <div className="metric-grid">
            <div className="metric big"><div className="k">Totaal vakken</div><div className="v">${metrics.total}</div></div>
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
        </div>`}

        ${vis('secStallAisle') && html`
        <div className="section">
          <h3>Vak & rijstrook</h3>
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
        </div>`}

        ${vis('secConstraints') && html`
        <div className="section">
          <h3>Site-constraints</h3>
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
        </div>`}

        ${vis('secMix') && html`
        <div className="section">
          <h3>Vaktypes (mix)</h3>
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
        </div>`}

        ${vis('secProgram') && html`
        <div className="section">
          <h3>Programma & parkeer­ratio</h3>
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
        </div>`}
      </div>`}

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
