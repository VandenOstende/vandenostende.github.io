// ============================================================
// app.js — ParkPlanner React UI (no build step; htm + React ESM)
// ============================================================
import React, { useReducer, useRef, useState, useEffect, useCallback, useMemo } from '../vendor/react.mjs';
import { createRoot } from '../vendor/react-dom-client.mjs';
import htm from '../vendor/htm.mjs';
import { solveParking, computeMetrics, STALL_TYPES, stallKey, aisleKey, aisleAxis } from './solver.js';
import {
  offsetPolygon, boundingBox, polygonCentroid, polygonArea, dist, distPointSegment,
  pointInPolygon, rectPoly,
} from './geometry.js';
import * as basemap from './basemap.js';
import { BASEMAPS, geocode } from './basemap.js';

const html = htm.bind(React.createElement);
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
  compactRatio: 0, evRatio: 0.05, ada: true,
};

// Default demo site: an L-shaped parcel (rectangle with a building in the corner).
const DEFAULT_SITE = [
  { x: 0, y: 0 }, { x: 96, y: 0 }, { x: 96, y: 60 }, { x: 0, y: 60 },
];
const DEFAULT_OBSTACLES = [
  rectPoly(60, 36, 36, 24), // building footprint, top-right
];

// Geographic anchor for local origin (0,0). Default: Amsterdam Zuidas.
const DEFAULT_GEO = { lat: 52.3390, lon: 4.8730 };

// ---------- Document reducer + undo/redo ----------
// Infrastructure annotations you can draw over the plan.
//   mode 'line'  → click points, finish on dbl-click/first point (Esc cancels)
//   mode 'cross' → 2 clicks define a crossing centreline (zebra stripes)
//   mode 'area'  → drag a rectangle
// `under: true` draws beneath the parking (roads, bike parking).
export const ANNOT_TYPES = {
  road:        { label: 'Weg',          color: '#3b424e', width: 6.0, mode: 'line', curved: true, under: true },
  walkway:     { label: 'Wandelpad',    color: '#9aa4b2', width: 1.8, mode: 'line', curved: true },
  bikepath:    { label: 'Fietspad',     color: '#b91c1c', width: 2.0, mode: 'line', curved: true },
  crosswalk:   { label: 'Zebrapad',     color: '#e5e7eb', width: 3.5, mode: 'cross' },
  bikeparking: { label: 'Fietsparking', color: '#0e7490', width: 0,   mode: 'area', under: true },
  marking:     { label: 'Markering',    color: '#eab308', width: 0.3, mode: 'line', curved: false },
};

// `overrides` are manual, position-keyed marks that persist across
// re-solves: stall type per stall, one-way + direction per aisle.
const initialDoc = {
  site: DEFAULT_SITE, obstacles: DEFAULT_OBSTACLES, geo: DEFAULT_GEO,
  params: DEFAULT_PARAMS, orientationIndex: 0,
  overrides: { stalls: {}, aisles: {} },
  annotations: [], // { kind, points:[{x,y}], width, curved }
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

// ---------- Rendering ----------
function draw(ctx, opts) {
  const { view, doc, result, layers, dpr, drawing, hover, selection, size, basemapStyle,
          stallSel, aisleSel, marquee } = opts;
  const { w2s } = makeTransform(view);
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size.w, size.h);

  // Basemap tiles (under everything)
  if (basemapStyle && basemapStyle !== 'none') {
    basemap.drawBasemap(ctx, { style: basemapStyle, geo: doc.geo, view, size, w2s });
  }

  const selAnnIdx = selection && selection.type === 'annot' ? selection.index : -1;

  // Grid
  if (layers.grid) drawGrid(ctx, view, size);

  // Infrastructure drawn under the parking (roads, bike parking)
  if (layers.infra && doc.annotations) {
    drawAnnotations(ctx, doc.annotations, w2s, view.scale, true, selAnnIdx);
  }

  // Site fill + outline
  if (layers.site && doc.site.length >= 2) {
    pathPoly(ctx, doc.site, w2s, doc.site.length >= 3);
    ctx.fillStyle = 'rgba(248,181,0,0.05)';
    if (doc.site.length >= 3) ctx.fill();
    ctx.strokeStyle = '#f8b500';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Setback line (dashed inward offset)
  if (layers.setback && doc.site.length >= 3 && doc.params.setback > 0) {
    const off = offsetPolygon(doc.site, doc.params.setback);
    if (off) {
      pathPoly(ctx, off, w2s, true);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#6ee7ff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Aisles (drawn under stalls) with one-way arrows and selection highlight
  if (layers.parking) {
    for (const a of result.aisles) {
      pathPoly(ctx, a.poly, w2s, true);
      ctx.fillStyle = aisleSel === a.key ? 'rgba(59,130,246,0.32)' : 'rgba(43,51,64,0.9)';
      ctx.fill();
      if (aisleSel === a.key) { ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2; ctx.stroke(); }
      if (a.oneway) drawAisleArrows(ctx, a, w2s, view.scale);
    }
  }

  // Buildings / exclusion zones
  if (layers.building) {
    doc.obstacles.forEach((o, i) => {
      pathPoly(ctx, o, w2s, true);
      ctx.fillStyle = selection && selection.type === 'obs' && selection.index === i
        ? 'rgba(239,68,68,0.28)' : 'rgba(100,116,139,0.5)';
      ctx.fill();
      ctx.strokeStyle = selection && selection.type === 'obs' && selection.index === i ? '#ef4444' : '#7c8896';
      ctx.lineWidth = 1.5;
      ctx.stroke();
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
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.35)';
      ctx.lineWidth = selected ? 2 : 0.6;
      ctx.stroke();
      if (showGlyph && info.glyph) {
        const s = w2s(polygonCentroid(st.poly));
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
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

  // Rectangle preview (obstacle / bike-parking area drag)
  if (hover && hover.preview) {
    const r = hover.preview;
    const a = w2s({ x: r.x, y: r.y }), b = w2s({ x: r.x + r.w, y: r.y + r.h });
    ctx.strokeStyle = '#22c55e';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.4;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
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

  // In-progress polygon
  if (drawing && drawing.points.length) {
    const pts = hover ? [...drawing.points, hover] : drawing.points;
    pathPoly(ctx, pts, w2s, false);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of drawing.points) drawHandle(ctx, w2s(p), '#22c55e');
  }

  // Vertex handles for site (select tool)
  if (opts.showHandles) {
    for (const p of doc.site) drawHandle(ctx, w2s(p), '#f8b500');
    for (const o of doc.obstacles) for (const p of o) drawHandle(ctx, w2s(p), '#7c8896');
  }

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
  ctx.fillStyle = '#0f1216';
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
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
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

function drawAnnotation(ctx, ann, w2s, scale, selected) {
  const t = ANNOT_TYPES[ann.kind];
  if (!t || !ann.points || ann.points.length < 2) return;

  if (t.mode === 'cross') {
    const A = ann.points[0], B = ann.points[1];
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
    if (len < 0.1) return;
    const ux = dx / len, uy = dy / len, px = -uy, py = ux, half = (ann.width || 3.5) / 2;
    const step = 1.2, stripe = 0.6;
    ctx.fillStyle = selected ? '#ffffff' : '#e9edf2';
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
    ctx.fillStyle = 'rgba(14,116,144,0.35)';
    ctx.fill();
    ctx.strokeStyle = selected ? '#ffffff' : t.color;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.stroke();
    const cap = Math.floor(polygonArea(ann.points) / 1.5); // ~1.5 m² per bike
    const c = w2s(polygonCentroid(ann.points));
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('~' + cap + ' fietsen', c.x, c.y);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    return;
  }

  // Line kinds (road, walkway, bikepath, marking)
  const pts = ann.points.map(w2s);
  const wpx = Math.max(1.5, (ann.width || 0.3) * scale);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (selected) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = wpx + 4;
    buildAnnotPath(ctx, pts, ann.curved);
    ctx.stroke();
  }
  ctx.strokeStyle = t.color;
  ctx.lineWidth = wpx;
  buildAnnotPath(ctx, pts, ann.curved);
  ctx.stroke();
  if (ann.kind === 'bikepath') { // dashed centre line
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
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
    drawAnnotation(ctx, anns[i], w2s, scale, i === selIdx);
  }
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
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
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
  const [tool, setTool] = useState('select');
  const [layers, setLayers] = useState({ grid: true, site: true, setback: true, building: true, parking: true, infra: true });
  const [annotKind, setAnnotKind] = useState('road'); // active infra kind when drawing
  const [annotWidth, setAnnotWidth] = useState(6);
  const [annotCurved, setAnnotCurved] = useState(true);
  const [view, setView] = useState({ scale: 8, ox: 60, oy: 60 });
  const [drawing, setDrawing] = useState(null); // { points: [] }
  const [hover, setHover] = useState(null);
  const [selection, setSelection] = useState(null);       // obstacle selection
  const [stallSel, setStallSel] = useState([]);           // selected stall keys
  const [aisleSel, setAisleSel] = useState(null);         // selected aisle key
  const [result, setResult] = useState({ stalls: [], aisles: [], orientationCount: 0 });
  const [solving, setSolving] = useState(false);
  const [basemapStyle, setBasemapStyle] = useState('none');
  const [geoSearch, setGeoSearch] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoMsg, setGeoMsg] = useState('');
  const [viewMode, setViewMode] = useState('2d');            // '2d' | '3d'
  const [mbToken, setMbToken] = useState(() => { try { return localStorage.getItem('pp_mapbox_token') || ''; } catch (e) { return ''; } });
  const [mbTokenInput, setMbTokenInput] = useState('');
  const [map3dError, setMap3dError] = useState('');

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const sizeRef = useRef({ w: 800, h: 600 });
  const dragRef = useRef(null);
  const solveTimer = useRef(null);
  const fittedRef = useRef(false);
  const renderRef = useRef(() => {}); // always points at the latest renderNow
  const drewRef = useRef(false); // set once the first frame draws (breadcrumb)
  const marqueeRef = useRef(null); // {x0,y0,x1,y1} in world coords while dragging
  const map3dRef = useRef(null);   // Mapbox controller when in 3D view

  // Once mounted, cancel the index.html boot-failure fallback and let
  // the tile loader trigger redraws as tiles arrive.
  useEffect(() => {
    if (window.__pp_boot) { clearTimeout(window.__pp_boot); window.__pp_boot = null; }
    basemap.setRedraw(() => renderRef.current());
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
      renderRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced solve whenever inputs change.
  useEffect(() => {
    clearTimeout(solveTimer.current);
    setSolving(true);
    solveTimer.current = setTimeout(() => {
      const r = solveParking(doc.site, doc.obstacles, doc.params, doc.orientationIndex);
      setResult(r);
      setSolving(false);
    }, 90);
    return () => clearTimeout(solveTimer.current);
  }, [doc.site, doc.obstacles, doc.params, doc.orientationIndex]);

  // Apply manual overrides (stall type, aisle one-way) on top of the
  // solver output, keyed by position so marks survive re-solves.
  const deco = useMemo(() => {
    const ov = doc.overrides || {};
    const ovStalls = ov.stalls || {}, ovAisles = ov.aisles || {};
    const stalls = result.stalls.map((st) => {
      const key = stallKey(st.poly);
      return { ...st, key, type: ovStalls[key] || st.type };
    });
    const aisles = result.aisles.map((q) => {
      const key = aisleKey(q);
      const o = ovAisles[key] || {};
      return { poly: q, key, oneway: !!o.oneway, dir: o.dir || 1 };
    });
    return { stalls, aisles, orientationCount: result.orientationCount };
  }, [result, doc.overrides]);

  const renderNow = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sz = sizeRef.current;
    // Never draw with a zero canvas or a non-finite scale — those are the
    // conditions that turn world-space draw loops into infinite loops.
    if (!(sz.w > 0) || !(sz.h > 0) || !(view.scale > 0) || !isFinite(view.scale)) return;
    const ctx = canvas.getContext('2d');
    draw(ctx, {
      view, doc, result: deco, layers,
      dpr: Math.min(2, window.devicePixelRatio || 1),
      drawing, hover, selection, size: sizeRef.current,
      showHandles: tool === 'select', basemapStyle,
      stallSel, aisleSel, marquee: marqueeRef.current,
    });
    if (!drewRef.current) { drewRef.current = true; mark('ok'); }
  }, [view, doc, deco, layers, drawing, hover, selection, tool, basemapStyle, stallSel, aisleSel]);

  renderRef.current = renderNow;
  useEffect(() => { renderNow(); }, [renderNow]);

  // Snapshot of everything the 3D view draws.
  const buildPlan = useCallback(() => ({
    site: doc.site, obstacles: doc.obstacles,
    stalls: deco.stalls, aisles: deco.aisles, annotations: doc.annotations,
  }), [doc.site, doc.obstacles, deco, doc.annotations]);

  // Create/destroy the Mapbox 3D map when entering/leaving 3D (needs a token).
  useEffect(() => {
    if (viewMode !== '3d' || !mbToken) {
      if (map3dRef.current) { map3dRef.current.destroy(); map3dRef.current = null; }
      return;
    }
    let cancelled = false;
    setMap3dError('');
    const container = document.getElementById('pp-map3d');
    if (!container) return;
    import('./map3d.js').then(async (m) => {
      if (cancelled) return;
      const ctrl = await m.init3D(container, mbToken, doc.geo, buildPlan(), (msg) => setMap3dError(msg));
      if (cancelled) { if (ctrl) ctrl.destroy(); return; }
      map3dRef.current = ctrl;
    }).catch(() => setMap3dError('3D-weergave kon niet laden.'));
    return () => { cancelled = true; if (map3dRef.current) { map3dRef.current.destroy(); map3dRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, mbToken]);

  // Push plan updates into an existing 3D map.
  useEffect(() => {
    if (map3dRef.current && map3dRef.current.update) map3dRef.current.update(buildPlan());
  }, [buildPlan]);

  const metrics = useMemo(
    () => computeMetrics(doc.site, doc.obstacles, deco, doc.params),
    [doc.site, doc.obstacles, deco, doc.params]
  );

  // ---------- Param helpers ----------
  const setParam = (key, value, commit = true) =>
    dispatch({ type: commit ? 'COMMIT' : 'LIVE', updater: (d) => ({ ...d, params: { ...d.params, [key]: value } }) });

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

  // ---------- Override actions (manual marks) ----------
  const ovOf = (d) => ({ stalls: { ...(d.overrides && d.overrides.stalls) }, aisles: { ...(d.overrides && d.overrides.aisles) } });
  const setStallTypes = (keys, type) => dispatch({ type: 'COMMIT', updater: (d) => {
    const ov = ovOf(d);
    for (const k of keys) { if (type === null) delete ov.stalls[k]; else ov.stalls[k] = type; }
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

  // ---------- Annotation (infrastructure) actions ----------
  const addAnnotation = (ann) =>
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, annotations: [...(d.annotations || []), ann] }) });
  const deleteAnnotation = (index) =>
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, annotations: (d.annotations || []).filter((_, i) => i !== index) }) });
  const startAnnot = (kind) => {
    const t = ANNOT_TYPES[kind];
    setAnnotKind(kind);
    setAnnotWidth(t.width || 2);
    setAnnotCurved(!!t.curved);
    setTool('annot'); setDrawing(null); clearSel();
  };
  const finishAnnotLine = (points) => {
    const t = ANNOT_TYPES[annotKind];
    if (points.length >= 2) {
      addAnnotation({ kind: annotKind, points, width: annotWidth, curved: t.mode === 'line' ? annotCurved : false });
    }
    setDrawing(null);
  };

  // Nearest annotation to a screen point (for selection), or -1.
  const hitAnnotation = (sp) => {
    const { w2s } = makeTransform(view);
    const anns = doc.annotations || [];
    for (let i = anns.length - 1; i >= 0; i--) {
      const ann = anns[i];
      const t = ANNOT_TYPES[ann.kind];
      if (!t || !ann.points || ann.points.length < 2) continue;
      const pts = ann.points.map(w2s);
      const tol = Math.max(6, ((ann.width || 1) * view.scale) / 2 + 4);
      if (t.mode === 'area') {
        if (pointInPolygon(makeTransform(view).s2w(sp), ann.points)) return i;
        continue;
      }
      for (let s = 0; s < pts.length - 1; s++) {
        if (distPointSegment(sp, pts[s], pts[s + 1]) < tol) return i;
      }
    }
    return -1;
  };

  const hitVertex = (sp) => {
    const { w2s } = makeTransform(view);
    for (let i = 0; i < doc.site.length; i++)
      if (dist(w2s(doc.site[i]), sp) < 9) return { type: 'site', index: i };
    for (let oi = 0; oi < doc.obstacles.length; oi++)
      for (let vi = 0; vi < doc.obstacles[oi].length; vi++)
        if (dist(w2s(doc.obstacles[oi][vi]), sp) < 9) return { type: 'obsV', obs: oi, index: vi };
    return null;
  };

  const onPointerDown = (e) => {
    e.target.setPointerCapture?.(e.pointerId);
    const sp = getScreen(e);
    const wp = getWorld(e);

    // Middle-button or pan tool → pan.
    if (e.button === 1 || tool === 'pan') {
      dragRef.current = { mode: 'pan', start: sp, view: { ...view } };
      return;
    }

    if (tool === 'select') {
      const v = hitVertex(sp);
      if (v) { dragRef.current = { mode: 'vertex', target: v }; return; }
      // Stall? (topmost first) — click selects, shift+click toggles.
      for (let i = deco.stalls.length - 1; i >= 0; i--) {
        if (pointInPolygon(wp, deco.stalls[i].poly)) {
          const key = deco.stalls[i].key;
          setSelection(null); setAisleSel(null);
          setStallSel((cur) => e.shiftKey
            ? (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key])
            : [key]);
          return;
        }
      }
      // Aisle?
      for (let i = deco.aisles.length - 1; i >= 0; i--) {
        if (pointInPolygon(wp, deco.aisles[i].poly)) {
          setSelection(null); setStallSel([]); setAisleSel(deco.aisles[i].key);
          return;
        }
      }
      // Obstacle interior?
      for (let i = doc.obstacles.length - 1; i >= 0; i--) {
        if (pointInPolygon(wp, doc.obstacles[i])) {
          setSelection({ type: 'obs', index: i }); setStallSel([]); setAisleSel(null); return;
        }
      }
      // Infrastructure annotation?
      const ai = hitAnnotation(sp);
      if (ai >= 0) { setSelection({ type: 'annot', index: ai }); setStallSel([]); setAisleSel(null); return; }
      // Empty space → marquee-select stalls (drag a box).
      if (!e.shiftKey) { setSelection(null); setStallSel([]); setAisleSel(null); }
      marqueeRef.current = { x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y };
      dragRef.current = { mode: 'marquee', add: e.shiftKey };
      return;
    }

    if (tool === 'site') {
      const first = drawing && drawing.points[0];
      const { w2s } = makeTransform(view);
      if (first && drawing.points.length >= 3 && dist(w2s(first), sp) < 12) {
        commitSite(drawing.points); setDrawing(null); setTool('select'); return;
      }
      setDrawing((d) => ({ points: [...(d ? d.points : []), wp] }));
      return;
    }

    if (tool === 'obstacle') {
      dragRef.current = { mode: 'rect', start: wp, cur: wp };
      return;
    }

    if (tool === 'annot') {
      const t = ANNOT_TYPES[annotKind];
      if (t.mode === 'area') { dragRef.current = { mode: 'annotArea', start: wp, cur: wp }; return; }
      // line / cross: accumulate points
      const first = drawing && drawing.points[0];
      const { w2s } = makeTransform(view);
      if (t.mode === 'line' && first && drawing.points.length >= 2 && dist(w2s(first), sp) < 12) {
        finishAnnotLine(drawing.points); return;
      }
      const pts = [...((drawing && drawing.points) || []), wp];
      if (t.mode === 'cross' && pts.length >= 2) { finishAnnotLine(pts); return; }
      setDrawing({ points: pts });
      return;
    }
  };

  const onPointerMove = (e) => {
    const sp = getScreen(e);
    const wp = getWorld(e);
    const drag = dragRef.current;

    if (!drag) {
      if ((tool === 'site' || tool === 'annot') && drawing) setHover(wp);
      return;
    }
    if (drag.mode === 'pan') {
      const dx = sp.x - drag.start.x, dy = sp.y - drag.start.y;
      setView({ ...drag.view, ox: drag.view.ox + dx, oy: drag.view.oy + dy });
    } else if (drag.mode === 'annotArea') {
      drag.cur = wp;
      setHover({ preview: rectFrom(drag.start, wp) });
    } else if (drag.mode === 'vertex') {
      const t = drag.target;
      dispatch({ type: 'LIVE', updater: (d) => {
        if (t.type === 'site') {
          const site = d.site.slice(); site[t.index] = wp; return { ...d, site };
        }
        const obstacles = d.obstacles.map((o) => o.slice());
        obstacles[t.obs][t.index] = wp; return { ...d, obstacles };
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

  const onPointerUp = (e) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode === 'vertex') {
      // Promote the live drag into a committed history entry.
      dispatch({ type: 'COMMIT', updater: (d) => d });
    } else if (drag.mode === 'rect') {
      const r = rectFrom(drag.start, drag.cur);
      if (Math.abs(r.w) > 1 && Math.abs(r.h) > 1) {
        const poly = rectPoly(r.x, r.y, r.w, r.h);
        dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: [...d.obstacles, poly] }) });
      }
      setHover(null);
      setTool('select');
    } else if (drag.mode === 'annotArea') {
      const r = rectFrom(drag.start, drag.cur);
      if (Math.abs(r.w) > 0.5 && Math.abs(r.h) > 0.5) {
        addAnnotation({ kind: annotKind, points: rectPoly(r.x, r.y, r.w, r.h), width: 0 });
      }
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

  const onDoubleClick = () => {
    if (tool === 'site' && drawing && drawing.points.length >= 3) {
      commitSite(drawing.points); setDrawing(null); setTool('select');
    } else if (tool === 'annot' && drawing && drawing.points.length >= 2) {
      finishAnnotLine(drawing.points);
    }
  };

  const commitSite = (points) =>
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, site: points, obstacles: [] }) });

  const onWheel = (e) => {
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.max(1, Math.min(60, view.scale * factor));
    const k = newScale / view.scale;
    setView({ scale: newScale, ox: cx - (cx - view.ox) * k, oy: cy - (cy - view.oy) * k });
  };

  // ---------- Keyboard ----------
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'REDO' : 'UNDO' }); return; }
      if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); dispatch({ type: 'REDO' }); return; }
      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break;
        case 'p': setTool('site'); setDrawing({ points: [] }); break;
        case 'b': setTool('obstacle'); break;
        case ' ': setTool('pan'); break;
        case 'g': setLayers((l) => ({ ...l, grid: !l.grid })); break;
        case 'escape': setDrawing(null); setTool('select'); setSelection(null); setStallSel([]); setAisleSel(null); break;
        case 'delete': case 'backspace':
          if (selection && selection.type === 'obs') {
            dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: d.obstacles.filter((_, i) => i !== selection.index) }) });
            setSelection(null);
          } else if (selection && selection.type === 'annot') {
            deleteAnnotation(selection.index); setSelection(null);
          }
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  // ---------- Toolbar actions ----------
  const cycleAxis = () =>
    dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, orientationIndex: (d.orientationIndex + 1) % Math.max(1, result.orientationCount || 1) }) });
  const resetAxis = () => dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, orientationIndex: 0 }) });
  const fitToSite = () => {
    const fv = fitView(doc.site, sizeRef.current.w, sizeRef.current.h);
    if (fv) setView(fv);
  };

  const saveJSON = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'parkplanner.json');
  };
  const loadJSON = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (d.site && d.params) { dispatch({ type: 'RESET', doc: { ...initialDoc, ...d } }); fitToSite(); }
      } catch (err) { alert('Ongeldig bestand'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };
  const exportPNG = () => {
    canvasRef.current.toBlob((blob) => downloadBlob(blob, 'parkplanner.png'));
  };
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
      const hit = await geocode(q);
      if (!hit) { setGeoMsg('Niet gevonden'); }
      else {
        centerOnLatLon(hit.lat, hit.lon);
        if (basemapStyle === 'none') setBasemapStyle('satellite');
        setGeoMsg(hit.label.split(',').slice(0, 3).join(', '));
      }
    } catch (err) {
      setGeoMsg('Zoeken mislukt (netwerk/CORS)');
    } finally { setGeoBusy(false); }
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

  // ---------- Render UI ----------
  const hintText = {
    site: 'Klik om punten te plaatsen · klik het eerste punt of dubbelklik om te sluiten · Esc annuleert',
    obstacle: 'Sleep een rechthoek voor een gebouw / uitsluitingszone',
    pan: 'Sleep om te verschuiven',
    annot: ANNOT_TYPES[annotKind] && ANNOT_TYPES[annotKind].mode === 'area'
      ? `${ANNOT_TYPES[annotKind].label}: sleep een rechthoek`
      : ANNOT_TYPES[annotKind] && ANNOT_TYPES[annotKind].mode === 'cross'
        ? `${ANNOT_TYPES[annotKind].label}: klik begin- en eindpunt van de oversteek`
        : `${ANNOT_TYPES[annotKind] ? ANNOT_TYPES[annotKind].label : ''}: klik punten · dubbelklik of klik beginpunt om te eindigen · Esc annuleert`,
    select: (stallSel.length || aisleSel) ? null
      : 'Klik een vak of rijbaan om te markeren · sleep een kader om meerdere vakken te selecteren · Shift = bij selectie voegen',
  }[tool];

  return html`
    <div className="app">
      <div className="toolbar">
        <div className="brand"><span className="logo">🅿️</span><span>ParkPlanner<br/><small>TestFit-kloon</small></span></div>
        <div className="tb-sep"></div>
        ${toolBtn('select', 'Selecteer', 'V', tool, setTool, setDrawing)}
        ${toolBtn('site', 'Site', 'P', tool, setTool, setDrawing)}
        ${toolBtn('obstacle', 'Gebouw', 'B', tool, setTool, setDrawing)}
        ${toolBtn('pan', 'Pan', '␣', tool, setTool, setDrawing)}
        <button className="btn ghost" onClick=${newRect}>Nieuwe site</button>
        <div className="tb-sep"></div>
        <button className="btn" onClick=${cycleAxis} title="Wissel rij-oriëntatie">↻ Rij-as ${result.orientationCount ? `(${doc.orientationIndex + 1}/${result.orientationCount})` : ''}</button>
        <button className="btn ghost" onClick=${resetAxis}>Reset</button>
        <div className="tb-sep"></div>
        <button className="btn ghost" onClick=${() => dispatch({ type: 'UNDO' })} disabled=${!hist.past.length}>↶ Undo</button>
        <button className="btn ghost" onClick=${() => dispatch({ type: 'REDO' })} disabled=${!hist.future.length}>↷ Redo</button>
        <div className="tb-sep"></div>
        <button className=${'btn' + (viewMode === '3d' ? ' active' : '')} onClick=${() => setViewMode(viewMode === '3d' ? '2d' : '3d')} title="Wissel 2D/3D">${viewMode === '3d' ? '🧊 3D' : '🗺 2D'}</button>
        <div className="tb-spacer"></div>
        <button className="btn ghost" onClick=${fitToSite}>⤢ Fit</button>
        <button className="btn ghost" onClick=${saveJSON}>Opslaan</button>
        <label className="btn ghost">Laden<input type="file" accept="application/json" onChange=${loadJSON} style=${{ display: 'none' }} /></label>
        <button className="btn ghost" onClick=${exportPNG}>PNG</button>
      </div>

      <div className="panel left">
        <div className="section">
          <h3>Kaart (onderlaag)</h3>
          <select className="preset" style=${{ marginBottom: '10px' }}
            value=${basemapStyle} onChange=${(e) => setBasemapStyle(e.target.value)}>
            ${Object.entries(BASEMAPS).map(([k, m]) => html`<option key=${k} value=${k}>${m.label}</option>`)}
          </select>
          <form onSubmit=${(e) => { e.preventDefault(); doGeocode(); }} className="geo-form">
            <input type="text" placeholder="Zoek adres of plaats…" value=${geoSearch}
              onChange=${(e) => setGeoSearch(e.target.value)} />
            <button type="submit" className="btn" disabled=${geoBusy}>${geoBusy ? '…' : 'Ga'}</button>
          </form>
          ${geoMsg && html`<div className="geo-msg">${geoMsg}</div>`}
          <div className="geo-coord">📍 ${doc.geo.lat.toFixed(5)}, ${doc.geo.lon.toFixed(5)}</div>
        </div>
        <div className="section">
          <h3>Teken (infrastructuur)</h3>
          <div className="type-grid">
            ${Object.entries(ANNOT_TYPES).map(([k, t]) => html`
              <button key=${k} className=${'type-btn' + (tool === 'annot' && annotKind === k ? ' active' : '')}
                onClick=${() => startAnnot(k)}>
                <span className="dot" style=${{ background: t.color }}></span>${t.label}
              </button>`)}
          </div>
          ${tool === 'annot' && ANNOT_TYPES[annotKind].mode !== 'area' && html`
            <div className="field" style=${{ marginTop: '10px', marginBottom: 0 }}>
              <label>Breedte<span className="val">${annotWidth.toFixed(1)} m</span></label>
              <input type="range" min="0.2" max="12" step="0.1" value=${annotWidth}
                onInput=${(e) => setAnnotWidth(parseFloat(e.target.value))} />
              ${ANNOT_TYPES[annotKind].mode === 'line' && html`
                <label className="toggle" style=${{ marginTop: '8px' }}>
                  <span>Vloeiende bochten</span>
                  <input type="checkbox" checked=${annotCurved} onChange=${(e) => setAnnotCurved(e.target.checked)} />
                </label>`}
            </div>`}
        </div>
        <div className="section">
          <h3>Lagen</h3>
          ${layerRow('grid', 'Raster', '#3b4453', layers, setLayers)}
          ${layerRow('site', 'Site-grens', '#f8b500', layers, setLayers)}
          ${layerRow('setback', 'Setback', '#6ee7ff', layers, setLayers)}
          ${layerRow('building', 'Gebouwen', '#64748b', layers, setLayers)}
          ${layerRow('parking', 'Parkeren', '#3b82f6', layers, setLayers)}
          ${layerRow('infra', 'Infrastructuur', '#0e7490', layers, setLayers)}
        </div>
        <div className="section">
          <h3>Preset</h3>
          <select className="preset" onChange=${(e) => applyPreset(e.target.value)}>
            <option value="">— kies afmetingen —</option>
            ${Object.entries(PRESETS).map(([k, p]) => html`<option key=${k} value=${k}>${p.label}</option>`)}
          </select>
        </div>
        <div className="foot">
          Open-source demonstrator van een parametrische parkeer­generator, geïnspireerd op TestFit's Parking Solver.
          De solver draait volledig in de browser: setback-offset → oriëntatie­zoektocht → strip-packing van dubbel-belaste modules.
        </div>
      </div>

      <div className="canvas-wrap" ref=${wrapRef}>
        <canvas ref=${canvasRef}
          onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp}
          onDoubleClick=${onDoubleClick} onWheel=${onWheel}
          style=${{ cursor: tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }} />
        ${hintText && html`<div className="hint">${hintText}</div>`}
        <div className="hud">
          <span><b>${metrics.total}</b> vakken</span>
          <span>·</span>
          <span>schaal <b>${view.scale.toFixed(1)}</b> px/m</span>
          <span>·</span>
          <span>${solving ? 'rekenen…' : 'live'}</span>
        </div>
        ${basemapStyle !== 'none' && viewMode === '2d' && BASEMAPS[basemapStyle].attribution && html`
          <div className="attrib">${BASEMAPS[basemapStyle].attribution}</div>`}

        ${viewMode === '3d' && html`
          <div id="pp-map3d" className="map3d"></div>
          ${!mbToken && html`
            <div className="token-panel">
              <h4>🧊 3D-gebouwen via Mapbox</h4>
              <p>Voer je eigen Mapbox <b>public token</b> (pk.…) in. Die wordt alleen lokaal in je browser bewaard.</p>
              <input type="text" placeholder="pk.eyJ…" value=${mbTokenInput} onInput=${(e) => setMbTokenInput(e.target.value)} />
              <div className="sel-actions">
                <button className="btn" onClick=${saveMbToken}>3D starten</button>
                <button className="btn ghost" onClick=${() => setViewMode('2d')}>Terug naar 2D</button>
              </div>
              <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noopener">Gratis token aanmaken →</a>
            </div>`}
          ${mbToken && map3dError && html`
            <div className="token-panel">
              <h4>3D niet beschikbaar</h4>
              <p>${map3dError}</p>
              <div className="sel-actions">
                <button className="btn" onClick=${clearMbToken}>Andere token invoeren</button>
                <button className="btn ghost" onClick=${() => setViewMode('2d')}>Terug naar 2D</button>
              </div>
            </div>`}
          ${mbToken && !map3dError && html`<div className="attrib">Mapbox · plan in 3D</div>`}`}
      </div>

      <div className="panel right">
        ${selection && selection.type === 'annot' && doc.annotations[selection.index] && html`
        <div className="section sel-section">
          <h3>${ANNOT_TYPES[doc.annotations[selection.index].kind].label} geselecteerd</h3>
          <div className="sel-actions">
            <button className="btn" onClick=${() => { deleteAnnotation(selection.index); setSelection(null); }}>🗑 Verwijder</button>
            <button className="btn ghost" onClick=${() => setSelection(null)}>Deselecteer</button>
          </div>
        </div>`}
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
            <div className="sel-actions">
              <button className="btn ghost" onClick=${() => setStallTypes(stallSel, null)}>↺ Wis markering</button>
              <button className="btn ghost" onClick=${clearSel}>Deselecteer</button>
            </div>
          `}
          ${aisleSel && (() => {
            const a = deco.aisles.find((x) => x.key === aisleSel);
            const oneway = a && a.oneway;
            return html`
            <h3>Rijbaan geselecteerd</h3>
            <label className="toggle" style=${{ marginBottom: '8px' }}>
              <span>Eenrichting (met pijlen)</span>
              <input type="checkbox" checked=${!!oneway} onChange=${(e) => setAisleOneway(aisleSel, e.target.checked)} />
            </label>
            <div className="sel-actions">
              <button className="btn" onClick=${() => flipAisle(aisleSel)} disabled=${!oneway}>⇄ Draai richting om</button>
              <button className="btn ghost" onClick=${clearSel}>Deselecteer</button>
            </div>`;
          })()}
        </div>`}
        <div className="section">
          <h3>Metrics</h3>
          <div className="metric-grid">
            <div className="metric big"><div className="k">Totaal vakken</div><div className="v">${metrics.total}</div></div>
            <div className="metric"><div className="k">Site</div><div className="v">${fmt(metrics.siteArea)}<small> m²</small></div></div>
            <div className="metric"><div className="k">Bebouwd</div><div className="v">${(metrics.coverage * 100).toFixed(0)}<small>%</small></div></div>
            <div className="metric"><div className="k">m² / vak</div><div className="v">${metrics.areaPerStall ? metrics.areaPerStall.toFixed(1) : '—'}</div></div>
            <div className="metric"><div className="k">Oriëntaties</div><div className="v">${metrics.orientationCount}</div></div>
          </div>
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
        </div>

        <div className="section">
          <h3>Vak & rijstrook</h3>
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
        </div>

        <div className="section">
          <h3>Site-constraints</h3>
          ${slider('Setback', 'setback', doc.params.setback, 0, 20, 0.5, 'm', setParam)}
          ${slider('Padding (buffer)', 'padding', doc.params.padding, 0, 3, 0.1, 'm', setParam)}
          ${slider('Max. rijlengte', 'maxRun', doc.params.maxRun, 0, 30, 1, 'vak', setParam)}
        </div>

        <div className="section">
          <h3>Vaktypes-mix</h3>
          ${slider('Compact', 'compactRatio', doc.params.compactRatio, 0, 0.5, 0.05, '', setParam, (v) => `${Math.round(v * 100)}%`)}
          ${slider('EV', 'evRatio', doc.params.evRatio, 0, 0.5, 0.05, '', setParam, (v) => `${Math.round(v * 100)}%`)}
          <div className="toggle">
            <span>ADA-vakken (auto-tabel)</span>
            <input type="checkbox" checked=${doc.params.ada} onChange=${(e) => setParam('ada', e.target.checked)} />
          </div>
        </div>
      </div>
    </div>
  `;
}

// ---------- Small UI helpers ----------
function toolBtn(id, label, key, tool, setTool, setDrawing) {
  return html`<button className=${'btn' + (tool === id ? ' active' : '')}
    onClick=${() => { setTool(id); if (id === 'site') setDrawing({ points: [] }); else setDrawing(null); }}>
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
