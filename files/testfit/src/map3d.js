// ============================================================
// map3d.js — Mapbox GL basemap controller (style chosen by the caller).
//
// The whole planner sits on a live Mapbox map. In 2D the map is a flat
// basemap that follows our canvas camera (the plan is drawn on the
// transparent canvas overlay). In 3D the map tilts and the plan is
// draped onto it as GeoJSON layers with Mapbox Standard's real 3D
// buildings. Requires the user's own Mapbox public token.
// ============================================================
import { localToLatLon } from './basemap.js?v=b5dc4bf3';
import { STALL_TYPES } from './solver.js?v=b5dc4bf3';
import { polyOf } from './geometry.js?v=b5dc4bf3';
import { ANNOT_TYPES } from './annots.js?v=b5dc4bf3';

const MB_VERSION = 'v3.7.0';
const MB_SEMVER = '3.7.0';
// api.mapbox.com is on some ad-blocker filter lists; fall back to neutral CDNs
// so a blocked library load doesn't kill the whole map.
const MB_SOURCES = [
  { js: `https://api.mapbox.com/mapbox-gl-js/${MB_VERSION}/mapbox-gl.js`, css: `https://api.mapbox.com/mapbox-gl-js/${MB_VERSION}/mapbox-gl.css`, name: 'api.mapbox.com' },
  { js: `https://unpkg.com/mapbox-gl@${MB_SEMVER}/dist/mapbox-gl.js`, css: `https://unpkg.com/mapbox-gl@${MB_SEMVER}/dist/mapbox-gl.css`, name: 'unpkg.com' },
  { js: `https://cdn.jsdelivr.net/npm/mapbox-gl@${MB_SEMVER}/dist/mapbox-gl.js`, css: `https://cdn.jsdelivr.net/npm/mapbox-gl@${MB_SEMVER}/dist/mapbox-gl.css`, name: 'jsdelivr.net' },
];
const LOAD_TIMEOUT_MS = 10000;
let mbPromise = null;

export function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch (e) { return false; }
}

// A <script> that is silently swallowed (blocker/extension/proxy) fires neither
// onload nor onerror — without this timeout the whole init hangs with no signal.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { try { s.remove(); } catch (e) {} finish(reject, new Error('time-out (geen antwoord)')); }, LOAD_TIMEOUT_MS);
    s.src = src; s.async = true;
    s.onload = () => (window.mapboxgl ? finish(resolve, window.mapboxgl) : finish(reject, new Error('script geladen maar mapboxgl ontbreekt')));
    s.onerror = () => { try { s.remove(); } catch (e) {} finish(reject, new Error('geblokkeerd of onbereikbaar')); };
    document.head.appendChild(s);
  });
}

let cssDone = false;
function loadCss(href) {
  if (cssDone) return;
  cssDone = true;
  try {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = href;
    document.head.appendChild(css);
  } catch (e) {}
}

function loadMapbox(diag) {
  // Both early-outs must still report, or the readout is stuck on its initial
  // placeholder while everything downstream is fine (re-init after a style
  // switch hits this path, since the library is already in memory).
  // Even here the stylesheet must be ensured: a re-init reuses the library but
  // may be the first attempt at the CSS.
  if (window.mapboxgl) { loadCss(MB_SOURCES[0].css); diag({ lib: 'ok (al geladen)' }); return Promise.resolve(window.mapboxgl); }
  if (mbPromise) {
    diag({ lib: 'laden…' });
    return mbPromise.then((gl) => { diag({ lib: 'ok (al geladen)' }); return gl; });
  }
  mbPromise = (async () => {
    const tried = [];
    for (const src of MB_SOURCES) {
      try {
        diag({ lib: 'laden via ' + src.name + '…' });
        const gl = await loadScript(src.js);
        loadCss(src.css);
        diag({ lib: 'ok (' + src.name + ')' });
        return gl;
      } catch (e) {
        tried.push(src.name + ': ' + e.message);
      }
    }
    throw new Error('Mapbox GL kon nergens laden — ' + tried.join(' · '));
  })();
  // Never cache a failure: a retry (andere stijl, opnieuw proberen) must retry.
  mbPromise.catch(() => { mbPromise = null; });
  return mbPromise;
}

const ring = (poly, geo) => poly.map((p) => { const ll = localToLatLon(p, geo); return [ll.lon, ll.lat]; });
function polyFeature(poly, geo, props) {
  const r = ring(poly, geo);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
  return { type: 'Feature', properties: props || {}, geometry: { type: 'Polygon', coordinates: [r] } };
}
function lineFeature(pts, geo, props) {
  return { type: 'Feature', properties: props || {}, geometry: { type: 'LineString', coordinates: ring(pts, geo) } };
}
// Colours live in ANNOT_TYPES; this used to keep a second hand-maintained copy
// that silently drifted whenever a kind was added.
function annColor(kind) {
  return (ANNOT_TYPES[kind] || {}).color || '#eab308';
}
// One list, not two: anything drawn as an open line in 2D drapes as a line in
// 3D. Point markings and signage are handled separately.
function isLineKind(kind) {
  const t = ANNOT_TYPES[kind];
  return !!t && (t.mode === 'line' || t.mode === 'cross');
}
function planToGeoJSON(plan, geo) {
  const anns = plan.annotations || [];
  const fc = (features) => ({ type: 'FeatureCollection', features });
  return {
    stalls: fc((plan.stalls || []).map((s) => polyFeature(s.poly, geo, { color: (STALL_TYPES[s.type] || STALL_TYPES.standard).color }))),
    aisles: fc((plan.aisles || []).map((a) => polyFeature(a.poly, geo, {}))),
    buildings: fc((plan.obstacles || []).map((o) => polyFeature(polyOf(o), geo, { height: (o && o.floors ? o.floors : 4) * 3.2 }))),
    site: fc(plan.site && plan.site.length >= 3 ? [polyFeature(plan.site, geo, {})] : []),
    areas: fc(anns.filter((an) => an.points && an.points.length >= 3 && (an.kind === 'grass' || an.kind === 'bikeparking' || an.closed)).map((an) => polyFeature(an.points, geo, { color: annColor(an.kind) }))),
    lines: fc(anns.filter((an) => an.points && an.points.length >= 2 && !an.closed && isLineKind(an.kind)).map((an) => lineFeature(an.points, geo, { color: annColor(an.kind), width: an.width || 1 }))),
    trees: fc(anns.filter((an) => an.kind === 'tree' && an.points && an.points[0]).map((an) => { const ll = localToLatLon(an.points[0], geo); return { type: 'Feature', properties: { r: (an.width || 5) / 2 }, geometry: { type: 'Point', coordinates: [ll.lon, ll.lat] } }; })),
  };
}

const PLAN_LAYERS = ['pp-osm-3d', 'pp-areas-fill', 'pp-site-line', 'pp-aisles-fill', 'pp-lines-line', 'pp-stalls-fill', 'pp-buildings-3d', 'pp-trees-3d'];

function addPlanLayers(map, plan, geo) {
  // Real 3D buildings of the surroundings from the style's vector source.
  try {
    if (map.getSource('composite') && !map.getLayer('pp-osm-3d')) {
      map.addLayer({
        id: 'pp-osm-3d', type: 'fill-extrusion', source: 'composite', 'source-layer': 'building', minzoom: 14,
        layout: { visibility: 'none' },
        paint: { 'fill-extrusion-color': '#c3c8d2', 'fill-extrusion-height': ['coalesce', ['get', 'height'], 8], 'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0], 'fill-extrusion-opacity': 0.9 },
      });
    }
  } catch (e) {}
  const g = planToGeoJSON(plan, geo);
  const src = (id, data) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data }); };
  src('pp-site', g.site); src('pp-aisles', g.aisles); src('pp-stalls', g.stalls);
  src('pp-buildings', g.buildings); src('pp-lines', g.lines); src('pp-areas', g.areas); src('pp-trees', g.trees);
  const L = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
  L({ id: 'pp-areas-fill', type: 'fill', source: 'pp-areas', layout: { visibility: 'none' }, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55 } });
  L({ id: 'pp-site-line', type: 'line', source: 'pp-site', layout: { visibility: 'none' }, paint: { 'line-color': '#f8b500', 'line-width': 2.5 } });
  L({ id: 'pp-aisles-fill', type: 'fill', source: 'pp-aisles', layout: { visibility: 'none' }, paint: { 'fill-color': '#2b3340', 'fill-opacity': 0.9 } });
  L({ id: 'pp-lines-line', type: 'line', source: 'pp-lines', layout: { visibility: 'none' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['max', 2, ['*', ['get', 'width'], 3]] } });
  L({ id: 'pp-stalls-fill', type: 'fill', source: 'pp-stalls', layout: { visibility: 'none' }, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.92, 'fill-outline-color': 'rgba(0,0,0,0.4)' } });
  L({ id: 'pp-buildings-3d', type: 'fill-extrusion', source: 'pp-buildings', layout: { visibility: 'none' }, paint: { 'fill-extrusion-color': '#8a97a8', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.95 } });
  L({ id: 'pp-trees-3d', type: 'circle', source: 'pp-trees', layout: { visibility: 'none' }, paint: { 'circle-color': '#2f9e44', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 3, 20, ['*', ['get', 'r'], 6]], 'circle-stroke-color': '#14532d', 'circle-stroke-width': 1, 'circle-opacity': 0.9 } });
}
function setPlanVisible(map, on) {
  for (const id of PLAN_LAYERS) { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); }
}
function setData(map, plan, geo) {
  if (!map || !map.isStyleLoaded()) return;
  const g = planToGeoJSON(plan, geo);
  const set = (id, data) => { const s = map.getSource(id); if (s) s.setData(data); };
  set('pp-site', g.site); set('pp-aisles', g.aisles); set('pp-stalls', g.stalls);
  set('pp-buildings', g.buildings); set('pp-lines', g.lines); set('pp-areas', g.areas); set('pp-trees', g.trees);
}

/**
 * Initialise the Mapbox basemap. Returns a controller, or null on failure.
 *   follow2D(center,zoom) — flat basemap tracks the canvas camera
 *   setMode(is3d)         — tilt + show/hide the draped plan layers
 *   setPlan(plan)         — refresh the plan GeoJSON
 */
export async function initMap(container, token, geo, plan, onError, styleUrl, onDiag) {
  const diag = (d) => { try { if (onDiag) onDiag(d); } catch (e) {} };
  diag({ lib: '…', webgl: '…', style: '…', tiles: 0, detail: '' });

  if (!webglOk()) {
    diag({ webgl: 'NIET BESCHIKBAAR' });
    onError('WebGL is niet beschikbaar. Zet hardwareversnelling aan in je browser, of zet in Brave de "fingerprinting"-bescherming voor deze site op standaard — Mapbox kan zonder WebGL niet tekenen.');
    return null;
  }
  diag({ webgl: 'ok' });

  let mapboxgl;
  try { mapboxgl = await loadMapbox(diag); }
  catch (e) {
    diag({ lib: 'GEBLOKKEERD', detail: e.message });
    onError('Mapbox GL kon niet laden. Een blocker/extensie of je netwerk houdt het tegen. Details: ' + e.message);
    return null;
  }

  mapboxgl.accessToken = token;
  const style = styleUrl || 'mapbox://styles/mapbox/satellite-streets-v12';
  let map;
  try {
    map = new mapboxgl.Map({
      container, style,
      center: [geo.lon, geo.lat], zoom: 17, pitch: 0, bearing: 0,
      interactive: false, antialias: true, attributionControl: false,
    });
  } catch (e) { diag({ style: 'FOUT', detail: e.message }); onError('Kaart kon niet starten: ' + e.message); return null; }

  let ready = false, pending3d = false, lastPlan = plan, tiles = 0;
  diag({ style: 'laden…' });
  const loadTimer = setTimeout(() => {
    if (ready) return;
    diag({ style: 'TIME-OUT' });
    onError('De kaartstijl laadt niet (time-out). Meestal blokkeert een blocker/extensie api.mapbox.com, of het token mag deze site niet gebruiken.');
  }, 12000);
  map.on('error', (ev) => {
    const err = ev && ev.error;
    const msg = (err && err.message) || String(err || 'onbekende kaartfout');
    const status = err && err.status;
    // eslint-disable-next-line no-console
    console.warn('[ParkPlanner map]', status || '', msg);
    diag({ detail: (status ? status + ' · ' : '') + msg });
    if (status === 401 || status === 403 || /token|unauthorized|access|forbidden/i.test(msg)) {
      diag({ style: 'TOKEN GEWEIGERD (' + (status || '401/403') + ')' });
      onError('Mapbox-token geweigerd (' + (status || '401/403') + '). Gebruik een public token (pk.…) zonder URL-restrictie, of voeg vandenostende.github.io toe aan de toegestane URLs van het token.');
    } else if (!ready) onError('Kaartfout: ' + msg);
  });
  // What actually ended up on screen — the missing link when tiles load fine
  // but nothing is visible.
  const reportCanvas = () => {
    try {
      const c = container.querySelector('canvas');
      if (!c) { diag({ canvas: 'GEEN CANVAS' }); return; }
      const r = c.getBoundingClientRect();
      const box = container.getBoundingClientRect();
      // A canvas smaller than its container means Mapbox is holding a stale
      // measurement — it renders a sliver and the rest stays empty.
      const stale = Math.abs(r.height - box.height) > 4 || Math.abs(r.width - box.width) > 4;
      diag({ canvas: Math.round(r.width) + '×' + Math.round(r.height) + ' · vak ' + Math.round(box.width) + '×' + Math.round(box.height) + (stale ? ' ⚠️ mismatch' : ' ok') });
    } catch (e) {}
  };

  // Mapbox measures its container once at construction and never re-checks on
  // its own. If the grid row had not settled yet it locks in a wrong height
  // (e.g. 300px) and paints only a sliver, hidden behind the plan canvas.
  // Track the container so every layout change re-measures.
  let ro = null;
  try {
    ro = new ResizeObserver(() => {
      try { map.resize(); } catch (e) {}
      reportCanvas();
    });
    ro.observe(container);
  } catch (e) {}
  // Belt and braces for browsers/layouts where the observer fires before the
  // final box is known.
  [0, 150, 500, 1200].forEach((t) => setTimeout(() => { try { map.resize(); } catch (e) {} }, t));

  map.on('style.load', () => {
    ready = true;
    clearTimeout(loadTimer);
    diag({ style: 'ok' });
    setTimeout(reportCanvas, 120);
    onError('');
    try { addPlanLayers(map, lastPlan, geo); } catch (e) {}
    if (pending3d) { setPlanVisible(map, true); }
    setTimeout(() => { try { map.resize(); } catch (e) {} }, 60);
  });
  map.on('data', (e) => { if (e && e.tile) tiles++; });
  map.on('idle', () => { diag({ tiles }); reportCanvas(); });

  return {
    map,
    follow2D(center, zoom) { try { map.jumpTo({ center, zoom, bearing: 0, pitch: 0 }); } catch (e) {} },
    setMode(is3d) {
      pending3d = is3d;
      try {
        map.easeTo({ pitch: is3d ? 55 : 0, duration: 300 });
        if (ready) setPlanVisible(map, is3d);
        // In 3D the user drives the map directly; in 2D our canvas drives it.
        for (const k of ['dragPan', 'scrollZoom', 'dragRotate', 'touchZoomRotate', 'keyboard', 'doubleClickZoom', 'touchPitch']) {
          if (map[k]) { is3d ? map[k].enable() : map[k].disable(); }
        }
      } catch (e) {}
    },
    setPlan(p) { lastPlan = p; try { setData(map, p, geo); } catch (e) {} },
    // A location search moves the geo anchor; without this the draped plan keeps
    // converting against the anchor captured at construction.
    setGeo(g) {
      if (!g || (g.lat === geo.lat && g.lon === geo.lon)) return;
      geo = g;
      try { setData(map, lastPlan, geo); } catch (e) {}
    },
    resize() { try { map.resize(); } catch (e) {} },
    recenter(g) { try { map.jumpTo({ center: [g.lon, g.lat] }); } catch (e) {} },
    destroy() { try { if (ro) ro.disconnect(); } catch (e) {} try { map.remove(); } catch (e) {} },
  };
}
