// ============================================================
// map3d.js — Mapbox GL basemap controller (style chosen by the caller).
//
// The whole planner sits on a live Mapbox map. In 2D the map is a flat
// basemap that follows our canvas camera (the plan is drawn on the
// transparent canvas overlay). In 3D the map tilts and the plan is
// draped onto it as GeoJSON layers with Mapbox Standard's real 3D
// buildings. Requires the user's own Mapbox public token.
// ============================================================
import { localToLatLon } from './basemap.js';
import { STALL_TYPES } from './solver.js';
import { polyOf } from './geometry.js';

const MB_VERSION = 'v3.7.0';
let mbPromise = null;

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
  return {
    stalls: fc((plan.stalls || []).map((s) => polyFeature(s.poly, geo, { color: (STALL_TYPES[s.type] || STALL_TYPES.standard).color }))),
    aisles: fc((plan.aisles || []).map((a) => polyFeature(a.poly, geo, {}))),
    buildings: fc((plan.obstacles || []).map((o) => polyFeature(polyOf(o), geo, { height: (o && o.floors ? o.floors : 4) * 3.2 }))),
    site: fc(plan.site && plan.site.length >= 3 ? [polyFeature(plan.site, geo, {})] : []),
    areas: fc(anns.filter((an) => an.points && an.points.length >= 3 && (an.kind === 'grass' || an.kind === 'bikeparking' || an.closed)).map((an) => polyFeature(an.points, geo, { color: annColor(an.kind) }))),
    lines: fc(anns.filter((an) => an.points && an.points.length >= 2 && !an.closed && ['road', 'walkway', 'bikepath', 'crosswalk', 'marking', 'drivethru'].includes(an.kind)).map((an) => lineFeature(an.points, geo, { color: annColor(an.kind), width: an.width || 1 }))),
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
export async function initMap(container, token, geo, plan, onError, styleUrl) {
  let mapboxgl;
  try { mapboxgl = await loadMapbox(); }
  catch (e) { onError('Mapbox GL kon niet laden — controleer je verbinding.'); return null; }
  mapboxgl.accessToken = token;
  const style = styleUrl || 'mapbox://styles/mapbox/satellite-streets-v12';
  let map;
  try {
    map = new mapboxgl.Map({
      container, style,
      center: [geo.lon, geo.lat], zoom: 17, pitch: 0, bearing: 0,
      interactive: false, antialias: true, attributionControl: false,
    });
  } catch (e) { onError('Kaart kon niet starten: ' + e.message); return null; }

  let ready = false, pending3d = false, lastPlan = plan;
  const loadTimer = setTimeout(() => { if (!ready) onError('De kaart laadt niet — controleer je Mapbox-token en internetverbinding.'); }, 9000);
  map.on('error', (ev) => {
    const err = ev && ev.error;
    const msg = (err && err.message) || String(err || 'onbekende kaartfout');
    const status = err && err.status;
    // eslint-disable-next-line no-console
    console.warn('[ParkPlanner map]', status || '', msg);
    if (status === 401 || status === 403 || /token|unauthorized|access|forbidden/i.test(msg)) {
      onError('Mapbox-token geweigerd (401/403). Gebruik een public token (pk.…) zonder URL-restrictie, of voeg vandenostende.github.io toe aan de toegestane URLs.');
    } else if (!ready) onError('Kaartfout: ' + msg);
  });
  map.on('style.load', () => {
    ready = true;
    clearTimeout(loadTimer);
    onError('');
    try { addPlanLayers(map, lastPlan, geo); } catch (e) {}
    if (pending3d) { setPlanVisible(map, true); }
    setTimeout(() => { try { map.resize(); } catch (e) {} }, 60);
  });

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
    resize() { try { map.resize(); } catch (e) {} },
    recenter(g) { try { map.jumpTo({ center: [g.lon, g.lat] }); } catch (e) {} },
    destroy() { try { map.remove(); } catch (e) {} },
  };
}
