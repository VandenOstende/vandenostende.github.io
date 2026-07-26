// ============================================================
// map3d.js — optional Mapbox GL 3D view (lazy-loaded).
//
// Loaded only when the user switches to 3D and provides their own
// Mapbox access token (kept in their browser's localStorage, never
// committed). Drapes the parking plan onto a 3D map with real
// buildings from the Mapbox "standard" style.
// ============================================================
import { localToLatLon } from './basemap.js';
import { STALL_TYPES } from './solver.js';
import { polyOf } from './geometry.js';

const MB_VERSION = 'v3.7.0';
let mbPromise = null;

// Inject the Mapbox GL script + stylesheet once, on demand.
function loadMapbox() {
  if (window.mapboxgl) return Promise.resolve(window.mapboxgl);
  if (mbPromise) return mbPromise;
  mbPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `https://api.mapbox.com/mapbox-gl-js/${MB_VERSION}/mapbox-gl.css`;
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = `https://api.mapbox.com/mapbox-gl-js/${MB_VERSION}/mapbox-gl.js`;
    s.async = true;
    s.onload = () => (window.mapboxgl ? resolve(window.mapboxgl) : reject(new Error('mapboxgl ontbreekt')));
    s.onerror = () => reject(new Error('Mapbox GL kon niet laden'));
    document.head.appendChild(s);
  });
  return mbPromise;
}

const ring = (poly, geo) => poly.map((p) => {
  const ll = localToLatLon(p, geo);
  return [ll.lon, ll.lat];
});
function polyFeature(poly, geo, props) {
  const r = ring(poly, geo);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
  return { type: 'Feature', properties: props || {}, geometry: { type: 'Polygon', coordinates: [r] } };
}
function lineFeature(pts, geo, props) {
  return { type: 'Feature', properties: props || {}, geometry: { type: 'LineString', coordinates: ring(pts, geo) } };
}

function planToGeoJSON(plan, geo) {
  const anns = plan.annotations || [];
  const stalls = { type: 'FeatureCollection', features: (plan.stalls || []).map((s) =>
    polyFeature(s.poly, geo, { color: (STALL_TYPES[s.type] || STALL_TYPES.standard).color })) };
  const aisles = { type: 'FeatureCollection', features: (plan.aisles || []).map((a) => polyFeature(a.poly, geo, {})) };
  const buildings = { type: 'FeatureCollection', features: (plan.obstacles || []).map((o) => polyFeature(polyOf(o), geo, { height: (o && o.floors ? o.floors : 4) * 3.2 })) };
  const site = { type: 'FeatureCollection', features: plan.site && plan.site.length >= 3 ? [polyFeature(plan.site, geo, {})] : [] };
  // Filled areas: grass, bike parking, and closed line-annotations (pleinen).
  const areas = { type: 'FeatureCollection', features: anns
    .filter((an) => an.points && an.points.length >= 3 && (an.kind === 'grass' || an.kind === 'bikeparking' || an.closed))
    .map((an) => polyFeature(an.points, geo, { color: annColor(an.kind) })) };
  const lines = { type: 'FeatureCollection', features: anns
    .filter((an) => an.points && an.points.length >= 2 && !an.closed && ['road', 'walkway', 'bikepath', 'crosswalk', 'marking'].includes(an.kind))
    .map((an) => lineFeature(an.points, geo, { color: annColor(an.kind), width: an.width || 1 })) };
  const trees = { type: 'FeatureCollection', features: anns
    .filter((an) => an.kind === 'tree' && an.points && an.points[0])
    .map((an) => { const ll = localToLatLon(an.points[0], geo); return { type: 'Feature', properties: { r: (an.width || 5) / 2 }, geometry: { type: 'Point', coordinates: [ll.lon, ll.lat] } }; }) };
  return { stalls, aisles, buildings, site, areas, lines, trees };
}

function annColor(kind) {
  return ({ road: '#3b424e', walkway: '#9aa4b2', bikepath: '#b91c1c', crosswalk: '#e5e7eb',
    marking: '#eab308', grass: '#3f9b46', bikeparking: '#0e7490', tree: '#2f9e44' })[kind] || '#eab308';
}

function addLayers(map, plan, geo) {
  const g = planToGeoJSON(plan, geo);
  const src = (id, data) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data }); };
  src('pp-site', g.site); src('pp-aisles', g.aisles); src('pp-stalls', g.stalls);
  src('pp-buildings', g.buildings); src('pp-lines', g.lines);
  src('pp-areas', g.areas); src('pp-trees', g.trees);

  if (!map.getLayer('pp-areas-fill')) map.addLayer({ id: 'pp-areas-fill', type: 'fill', source: 'pp-areas',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55 } });
  if (!map.getLayer('pp-site-line')) map.addLayer({ id: 'pp-site-line', type: 'line', source: 'pp-site',
    paint: { 'line-color': '#f8b500', 'line-width': 2 } });
  if (!map.getLayer('pp-aisles-fill')) map.addLayer({ id: 'pp-aisles-fill', type: 'fill', source: 'pp-aisles',
    paint: { 'fill-color': '#2b3340', 'fill-opacity': 0.9 } });
  if (!map.getLayer('pp-lines-line')) map.addLayer({ id: 'pp-lines-line', type: 'line', source: 'pp-lines',
    paint: { 'line-color': ['get', 'color'], 'line-width': ['max', 2, ['*', ['get', 'width'], 3]] } });
  if (!map.getLayer('pp-stalls-fill')) map.addLayer({ id: 'pp-stalls-fill', type: 'fill', source: 'pp-stalls',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.9, 'fill-outline-color': 'rgba(0,0,0,0.4)' } });
  if (!map.getLayer('pp-buildings-3d')) map.addLayer({ id: 'pp-buildings-3d', type: 'fill-extrusion', source: 'pp-buildings',
    paint: { 'fill-extrusion-color': '#8a97a8', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.9 } });
  // Trees as green cylinders (canopy radius drives base width).
  if (!map.getLayer('pp-trees-3d')) map.addLayer({ id: 'pp-trees-3d', type: 'circle', source: 'pp-trees',
    paint: { 'circle-color': '#2f9e44', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 3, 20, ['*', ['get', 'r'], 6]], 'circle-stroke-color': '#14532d', 'circle-stroke-width': 1, 'circle-opacity': 0.9 } });
}

function setData(map, plan, geo) {
  if (!map || !map.isStyleLoaded()) return;
  const g = planToGeoJSON(plan, geo);
  const set = (id, data) => { const s = map.getSource(id); if (s) s.setData(data); };
  set('pp-site', g.site); set('pp-aisles', g.aisles); set('pp-stalls', g.stalls);
  set('pp-buildings', g.buildings); set('pp-lines', g.lines);
  set('pp-areas', g.areas); set('pp-trees', g.trees);
}

/**
 * Initialise the 3D map. onError(msg) is called for load/token failures.
 * Returns a controller { update(plan), destroy() } or null on failure.
 */
export async function init3D(container, token, geo, plan, onError) {
  let mapboxgl;
  try { mapboxgl = await loadMapbox(); }
  catch (e) { onError('Mapbox GL kon niet laden — controleer je verbinding.'); return null; }

  mapboxgl.accessToken = token;
  let map;
  try {
    map = new mapboxgl.Map({
      container,
      style: 'mapbox://styles/mapbox/standard',
      center: [geo.lon, geo.lat],
      zoom: 17.5, pitch: 60, bearing: -18, antialias: true,
    });
  } catch (e) { onError('Kaart kon niet starten: ' + e.message); return null; }

  map.on('error', (ev) => {
    const msg = (ev && ev.error && ev.error.message) || '';
    if (/token|unauthorized|401|403/i.test(msg)) onError('Ongeldige of geweigerde Mapbox-token.');
  });
  map.on('style.load', () => { try { addLayers(map, plan, geo); } catch (e) { /* style variants differ */ } });
  try { map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right'); } catch (e) {}

  return {
    update(p) { try { setData(map, p, geo); } catch (e) {} },
    recenter(g) { try { map.easeTo({ center: [g.lon, g.lat] }); } catch (e) {} },
    destroy() { try { map.remove(); } catch (e) {} },
  };
}
