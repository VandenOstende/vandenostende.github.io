// ============================================================
// app.js — ParkPlanner React UI (no build step; htm + React ESM)
// ============================================================
import React, { useReducer, useRef, useState, useEffect, useCallback, useMemo } from '../vendor/react.mjs';
import { createRoot } from '../vendor/react-dom-client.mjs';
import htm from '../vendor/htm.mjs';
import { solveParking, computeMetrics, STALL_TYPES } from './solver.js';
import {
  offsetPolygon, boundingBox, polygonCentroid, dist, pointInPolygon, rectPoly,
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
const initialDoc = {
  site: DEFAULT_SITE, obstacles: DEFAULT_OBSTACLES, geo: DEFAULT_GEO,
  params: DEFAULT_PARAMS, orientationIndex: 0,
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
  const { view, doc, result, layers, dpr, drawing, hover, selection, size, basemapStyle } = opts;
  const { w2s } = makeTransform(view);
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size.w, size.h);

  // Basemap tiles (under everything)
  if (basemapStyle && basemapStyle !== 'none') {
    basemap.drawBasemap(ctx, { style: basemapStyle, geo: doc.geo, view, size, w2s });
  }

  // Grid
  if (layers.grid) drawGrid(ctx, view, size);

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

  // Aisles (drawn under stalls)
  if (layers.parking) {
    ctx.fillStyle = 'rgba(43,51,64,0.9)';
    for (const a of result.aisles) { pathPoly(ctx, a, w2s, true); ctx.fill(); }
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

  // Stalls
  if (layers.parking) {
    for (const st of result.stalls) {
      pathPoly(ctx, st.poly, w2s, true);
      const c = STALL_TYPES[st.type] ? STALL_TYPES[st.type].color : '#3b82f6';
      ctx.fillStyle = c;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
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
  const [layers, setLayers] = useState({ grid: true, site: true, setback: true, building: true, parking: true });
  const [view, setView] = useState({ scale: 8, ox: 60, oy: 60 });
  const [drawing, setDrawing] = useState(null); // { points: [] }
  const [hover, setHover] = useState(null);
  const [selection, setSelection] = useState(null);
  const [result, setResult] = useState({ stalls: [], aisles: [], orientationCount: 0 });
  const [solving, setSolving] = useState(false);
  const [basemapStyle, setBasemapStyle] = useState('none');
  const [geoSearch, setGeoSearch] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoMsg, setGeoMsg] = useState('');

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const sizeRef = useRef({ w: 800, h: 600 });
  const dragRef = useRef(null);
  const solveTimer = useRef(null);
  const fittedRef = useRef(false);
  const renderRef = useRef(() => {}); // always points at the latest renderNow
  const drewRef = useRef(false); // set once the first frame draws (breadcrumb)

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

  const renderNow = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sz = sizeRef.current;
    // Never draw with a zero canvas or a non-finite scale — those are the
    // conditions that turn world-space draw loops into infinite loops.
    if (!(sz.w > 0) || !(sz.h > 0) || !(view.scale > 0) || !isFinite(view.scale)) return;
    const ctx = canvas.getContext('2d');
    draw(ctx, {
      view, doc, result, layers,
      dpr: Math.min(2, window.devicePixelRatio || 1),
      drawing, hover, selection, size: sizeRef.current,
      showHandles: tool === 'select', basemapStyle,
    });
    if (!drewRef.current) { drewRef.current = true; mark('ok'); }
  }, [view, doc, result, layers, drawing, hover, selection, tool, basemapStyle]);

  renderRef.current = renderNow;
  useEffect(() => { renderNow(); }, [renderNow]);

  const metrics = useMemo(
    () => computeMetrics(doc.site, doc.obstacles, result, doc.params),
    [doc.site, doc.obstacles, result, doc.params]
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

    // Middle-button or pan tool or space → pan.
    if (e.button === 1 || tool === 'pan' || e.shiftKey) {
      dragRef.current = { mode: 'pan', start: sp, view: { ...view } };
      return;
    }

    if (tool === 'select') {
      const v = hitVertex(sp);
      if (v) { dragRef.current = { mode: 'vertex', target: v }; return; }
      // Select obstacle by interior click.
      for (let i = doc.obstacles.length - 1; i >= 0; i--) {
        if (pointInPolygon(wp, doc.obstacles[i])) { setSelection({ type: 'obs', index: i }); return; }
      }
      setSelection(null);
      dragRef.current = { mode: 'pan', start: sp, view: { ...view } };
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
  };

  const onPointerMove = (e) => {
    const sp = getScreen(e);
    const wp = getWorld(e);
    const drag = dragRef.current;

    if (!drag) {
      if (tool === 'site' && drawing) setHover(wp);
      return;
    }
    if (drag.mode === 'pan') {
      const dx = sp.x - drag.start.x, dy = sp.y - drag.start.y;
      setView({ ...drag.view, ox: drag.view.ox + dx, oy: drag.view.oy + dy });
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
    }
  };

  const onDoubleClick = () => {
    if (tool === 'site' && drawing && drawing.points.length >= 3) {
      commitSite(drawing.points); setDrawing(null); setTool('select');
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
        case 'escape': setDrawing(null); setTool('select'); setSelection(null); break;
        case 'delete': case 'backspace':
          if (selection && selection.type === 'obs') {
            dispatch({ type: 'COMMIT', updater: (d) => ({ ...d, obstacles: d.obstacles.filter((_, i) => i !== selection.index) }) });
            setSelection(null);
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

  // ---------- Render UI ----------
  const hintText = {
    site: 'Klik om punten te plaatsen · klik het eerste punt of dubbelklik om te sluiten · Esc annuleert',
    obstacle: 'Sleep een rechthoek voor een gebouw / uitsluitingszone',
    pan: 'Sleep om te verschuiven',
    select: null,
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
          <h3>Lagen</h3>
          ${layerRow('grid', 'Raster', '#3b4453', layers, setLayers)}
          ${layerRow('site', 'Site-grens', '#f8b500', layers, setLayers)}
          ${layerRow('setback', 'Setback', '#6ee7ff', layers, setLayers)}
          ${layerRow('building', 'Gebouwen', '#64748b', layers, setLayers)}
          ${layerRow('parking', 'Parkeren', '#3b82f6', layers, setLayers)}
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
        ${basemapStyle !== 'none' && BASEMAPS[basemapStyle].attribution && html`
          <div className="attrib">${BASEMAPS[basemapStyle].attribution}</div>`}
      </div>

      <div className="panel right">
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
          ${doc.params.ada && html`<div style=${{ fontSize: '11.5px', color: 'var(--muted)', marginTop: '10px' }}>
            ADA-vereiste (Tabel 208.2): <b style=${{ color: 'var(--text)' }}>${metrics.adaRequired}</b> toegankelijk, waarvan <b style=${{ color: 'var(--text)' }}>${metrics.adaVan}</b> van-accessible.
          </div>`}
        </div>

        <div className="section">
          <h3>Vak & rijstrook</h3>
          ${slider('Vakbreedte', 'stallWidth', doc.params.stallWidth, 2.2, 3.5, 0.1, 'm', setParam)}
          ${slider('Vakdiepte', 'stallDepth', doc.params.stallDepth, 4.5, 6.5, 0.1, 'm', setParam)}
          ${slider('Rijstrook', 'aisleWidth', doc.params.aisleWidth, 5, 8, 0.1, 'm', setParam)}
          <div className="field">
            <label>Parkeerhoek</label>
            <div className="seg">
              ${[45, 60, 90].map((a) => html`<button key=${a} className=${doc.params.angle === a ? 'active' : ''} onClick=${() => setParam('angle', a)}>${a}°</button>`)}
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
