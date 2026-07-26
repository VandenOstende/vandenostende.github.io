// ============================================================
// map3d.js — real-world 3D map view (lazy-loaded).
//
// Uses MapLibre GL + OpenFreeMap vector tiles: real 3D buildings of
// the surrounding area with NO access token required. The parking plan
// is draped on top. An optional Mapbox token (if the user has one) can
// still be supplied to overlay satellite imagery.
// ============================================================
import { localToLatLon } from './basemap.js';
import { STALL_TYPES } from './solver.js';
import { polyOf } from './geometry.js';

const ML_VERSION = '4.7.1';
const OFM_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
let mlPromise = null;

// Inject the MapLibre GL script + stylesheet once, on demand.
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (mlPromise) return mlPromise;
  mlPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `https://unpkg.com/maplibre-gl@${ML_VERSION}/dist/maplibre-gl.css`;
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = `https://unpkg.com/maplibre-gl@${ML_VERSION}/dist/maplibre-gl.js`;
    s.async = true;
    s.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error('maplibregl ontbreekt')));
    s.onerror = () => reject(new Error('MapLibre kon niet laden'));
    document.head.appendChild(s);
  });
  return mlPromise;
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

function annColor(kind) {
  return ({ road: '#3b424e', walkway: '#9aa4b2', bikepath: '#b91c1c', crosswalk: '#e5e7eb',
    marking: '#eab308', grass: '#3f9b46', bikeparking: '#0e7490', driveway: '#525b68', drivethru: '#f97316' })[kind] || '#eab308';
}

function planToGeoJSON(plan, geo) {
  const anns = plan.annotations || [];
  const fc = (features) => ({ type: 'FeatureCollection', features });
  const stalls = fc((plan.stalls || []).map((s) => polyFeature(s.poly, geo, { color: (STALL_TYPES[s.type] || STALL_TYPES.standard).color })));
  const aisles = fc((plan.aisles || []).map((a) => polyFeature(a.poly, geo, {})));
  const buildings = fc((plan.obstacles || []).map((o) => polyFeature(polyOf(o), geo, { height: (o && o.floors ? o.floors : 4) * 3.2 })));
  const site = fc(plan.site && plan.site.length >= 3 ? [polyFeature(plan.site, geo, {})] : []);
  const areas = fc(anns.filter((an) => an.points && an.points.length >= 3 && (an.kind === 'grass' || an.kind === 'bikeparking' || an.closed))
    .map((an) => polyFeature(an.points, geo, { color: annColor(an.kind) })));
  const lines = fc(anns.filter((an) => an.points && an.points.length >= 2 && !an.closed && ['road', 'walkway', 'bikepath', 'crosswalk', 'marking', 'drivethru'].includes(an.kind))
    .map((an) => lineFeature(an.points, geo, { color: annColor(an.kind), width: an.width || 1 })));
  const trees = fc(anns.filter((an) => an.kind === 'tree' && an.points && an.points[0])
    .map((an) => { const ll = localToLatLon(an.points[0], geo); return { type: 'Feature', properties: { r: (an.width || 5) / 2 }, geometry: { type: 'Point', coordinates: [ll.lon, ll.lat] } }; }));
  return { stalls, aisles, buildings, site, areas, lines, trees };
}

// Real 3D buildings from the vector tiles (OpenMapTiles "building" layer).
function addContextBuildings(map) {
  if (map.getLayer('pp-osm-3d')) return;
  const style = map.getStyle() || {};
  let srcId = map.getSource('openmaptiles') ? 'openmaptiles' : null;
  if (!srcId) for (const [id, src] of Object.entries(style.sources || {})) { if (src && src.type === 'vector') { srcId = id; break; } }
  if (!srcId) return;
  // Draw beneath the first symbol (label) layer so labels stay on top.
  let before;
  for (const l of style.layers || []) { if (l.type === 'symbol') { before = l.id; break; } }
  try {
    map.addLayer({
      id: 'pp-osm-3d', type: 'fill-extrusion', source: srcId, 'source-layer': 'building', minzoom: 14,
      paint: {
        'fill-extrusion-color': '#c3c8d2',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.92,
      },
    }, before);
  } catch (e) { /* style variants differ */ }
}

function addPlanLayers(map, plan, geo) {
  const g = planToGeoJSON(plan, geo);
  const src = (id, data) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data }); };
  src('pp-site', g.site); src('pp-aisles', g.aisles); src('pp-stalls', g.stalls);
  src('pp-buildings', g.buildings); src('pp-lines', g.lines); src('pp-areas', g.areas); src('pp-trees', g.trees);
  const L = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
  L({ id: 'pp-areas-fill', type: 'fill', source: 'pp-areas', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55 } });
  L({ id: 'pp-site-line', type: 'line', source: 'pp-site', paint: { 'line-color': '#f8b500', 'line-width': 2.5 } });
  L({ id: 'pp-aisles-fill', type: 'fill', source: 'pp-aisles', paint: { 'fill-color': '#2b3340', 'fill-opacity': 0.9 } });
  L({ id: 'pp-lines-line', type: 'line', source: 'pp-lines', paint: { 'line-color': ['get', 'color'], 'line-width': ['max', 2, ['*', ['get', 'width'], 3]] } });
  L({ id: 'pp-stalls-fill', type: 'fill', source: 'pp-stalls', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.92, 'fill-outline-color': 'rgba(0,0,0,0.4)' } });
  L({ id: 'pp-buildings-3d', type: 'fill-extrusion', source: 'pp-buildings', paint: { 'fill-extrusion-color': '#8a97a8', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.95 } });
  L({ id: 'pp-trees-3d', type: 'circle', source: 'pp-trees', paint: { 'circle-color': '#2f9e44', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 3, 20, ['*', ['get', 'r'], 6]], 'circle-stroke-color': '#14532d', 'circle-stroke-width': 1, 'circle-opacity': 0.9 } });
}

function setData(map, plan, geo) {
  if (!map || !map.isStyleLoaded()) return;
  const g = planToGeoJSON(plan, geo);
  const set = (id, data) => { const s = map.getSource(id); if (s) s.setData(data); };
  set('pp-site', g.site); set('pp-aisles', g.aisles); set('pp-stalls', g.stalls);
  set('pp-buildings', g.buildings); set('pp-lines', g.lines); set('pp-areas', g.areas); set('pp-trees', g.trees);
}

/**
 * Initialise the 3D map (MapLibre + OpenFreeMap, no token). onError(msg) is
 * called for load failures. Returns { update, recenter, destroy } or null.
 */
export async function init3D(container, geo, plan, onError) {
  let maplibregl;
  try { maplibregl = await loadMapLibre(); }
  catch (e) { onError('3D-kaart kon niet laden — controleer je verbinding.'); return null; }

  let map;
  try {
    map = new maplibregl.Map({
      container, style: OFM_STYLE,
      center: [geo.lon, geo.lat], zoom: 16.6, pitch: 58, bearing: -18, antialias: true,
    });
  } catch (e) { onError('Kaart kon niet starten: ' + e.message); return null; }

  let notified = false;
  map.on('error', (ev) => {
    const msg = (ev && ev.error && ev.error.message) || '';
    if (!notified && /style|failed to fetch|networkerror/i.test(msg)) { notified = true; onError('3D-kaart kon de tegels niet laden.'); }
  });
  map.on('load', () => {
    try { addContextBuildings(map); } catch (e) {}
    try { addPlanLayers(map, plan, geo); } catch (e) {}
  });
  try { map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right'); } catch (e) {}

  return {
    update(p) { try { setData(map, p, geo); } catch (e) {} },
    recenter(g) { try { map.easeTo({ center: [g.lon, g.lat] }); } catch (e) {} },
    destroy() { try { map.remove(); } catch (e) {} },
  };
}
