// ============================================================
// map3d.js — Mapbox GL basemap controller (style chosen by the caller).
//
// The whole planner sits on a live Mapbox map. In 2D the map is a flat
// basemap that follows our canvas camera (the plan is drawn on the
// transparent canvas overlay). In 3D the map tilts and the plan is
// draped onto it as GeoJSON layers with Mapbox Standard's real 3D
// buildings. Requires the user's own Mapbox public token.
// ============================================================
import { localToLatLon } from './basemap.js?v=30378781';
import { STALL_TYPES } from './solver.js?v=30378781';
import { polyOf, ribbonPoly } from './geometry.js?v=30378781';
import { ANNOT_TYPES } from './annots.js?v=30378781';
import { buildingDesign, DEFAULT_USE, PART_COLORS, materialOf, WALL_ROLES } from './buildings.js?v=30378781';

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
  // `body` kinds drape as asphalt polygons alongside the solver's aisles, not
  // as a hairline down their centre.
  return !!t && !t.body && (t.mode === 'line' || t.mode === 'cross');
}
// Drawn carriageways, in the same collection (and so the same colour) as the
// generated drive aisles.
function roadPolys(anns) {
  const out = [];
  for (const an of anns) {
    const t = ANNOT_TYPES[an.kind];
    if (!t || !t.body || an.closed || !an.points || an.points.length < 2) continue;
    const poly = ribbonPoly(an.points, an.width || t.width || 6, an.align, an.curved);
    if (poly && poly.length >= 3) out.push(poly);
  }
  return out;
}
// Imported symbols stand up in 3D as an extruded footprint sized from the
// bitmap's aspect and rotated onto the annotation's own angle. The metadata
// comes straight out of the registered type, so nothing extra has to be passed
// in from the app.
function assetFootprint(an, t) {
  const a = t.asset || {};
  const w = an.width || t.width || 2;
  const d = w * ((a.h && a.w) ? a.h / a.w : 1);
  const c = an.points[0];
  const rad = ((an.angle || 0) * Math.PI) / 180;
  const cs = Math.cos(rad), sn = Math.sin(rad);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([x, y]) => ({ x: c.x + x * cs - y * sn, y: c.y + x * sn + y * cs }));
}

// A building drapes as its generated exterior: walls, roofs, canopy, gardens.
// One grey extrusion per footprint is what made every building look the same
// from the air regardless of what it was.
function buildingParts(plan, geo) {
  const site = plan.site && plan.site.length >= 3 ? plan.site : null;
  const toward = site ? site.reduce((a, p) => ({ x: a.x + p.x / site.length, y: a.y + p.y / site.length }), { x: 0, y: 0 }) : null;
  const out = [];
  for (const o of plan.obstacles || []) {
    const poly = polyOf(o);
    const d = buildingDesign(poly, (o && o.use) || DEFAULT_USE, (o && o.floors) || 1, toward);
    const mat = materialOf(o);
    if (!d.areas.length) { out.push(polyFeature(poly, geo, { base: 0, height: 12, color: PART_COLORS.body, wall: 0 })); continue; }
    for (const part of d.areas) {
      const isWall = !!WALL_ROLES[part.role];
      out.push(polyFeature(part.poly, geo, {
        base: part.h0, height: Math.max(part.h0 + 0.05, part.h1),
        color: isWall ? mat.tint : (PART_COLORS[part.role] || PART_COLORS.body),
        wall: isWall ? 1 : 0,
        pattern: 'pp-tex-' + mat.tex,
      }));
    }
  }
  return out;
}

// The three marked sides of a bay. The fourth is the mouth the car drives
// through, so it stays open — the same rule the 2D plan draws by.
function bayMarks(p) {
  if (!p || p.length !== 4) return [];
  const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const e = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([i, j]) => ({ a: p[i], b: p[j], l: len(p[i], p[j]) }));
  // Drop one of the two short edges; without an aisle to test against, the
  // convention "the first short edge" keeps 3-sided bays without guessing.
  const idx = e.map((x, i) => i).sort((i, j) => e[i].l - e[j].l);
  return e.filter((_, i) => i !== idx[0]).map((x) => [x.a, x.b]);
}

// Exported so the drape can be checked without a Mapbox token: it is a pure
// function of the plan, and everything downstream of it needs the network.
export function planToGeoJSON(plan, geo) {
  const anns = plan.annotations || [];
  const fc = (features) => ({ type: 'FeatureCollection', features });
  const assetAnns = anns.filter((an) => {
    const t = ANNOT_TYPES[an.kind];
    return t && t.asset && an.points && an.points[0];
  });
  return {
    assets: fc(assetAnns.map((an) => {
      const t = ANNOT_TYPES[an.kind];
      return polyFeature(assetFootprint(an, t), geo, { height: (t.asset.height != null ? t.asset.height : 2.5) });
    })),
    // A standard bay is tarmac, like it is in plan; only the types that mean
    // something keep their colour. 95 blue rectangles is a diagram, not a
    // car park.
    stalls: fc((plan.stalls || []).map((s) => polyFeature(s.poly, geo, {
      color: s.type && s.type !== 'standard' ? (STALL_TYPES[s.type] || STALL_TYPES.standard).color : '#3f4650',
    }))),
    aisles: fc([...(plan.aisles || []).map((a) => a.poly), ...roadPolys(anns)].map((q) => polyFeature(q, geo, {}))),
    buildings: fc(buildingParts(plan, geo)),
    bays: fc((plan.stalls || []).flatMap((s) => bayMarks(s.poly)).map((seg) => lineFeature(seg, geo, {}))),
    site: fc(plan.site && plan.site.length >= 3 ? [polyFeature(plan.site, geo, {})] : []),
    areas: fc(anns.filter((an) => an.points && an.points.length >= 3 && (an.kind === 'grass' || an.kind === 'bikeparking' || an.closed)).map((an) => polyFeature(an.points, geo, { color: annColor(an.kind) }))),
    lines: fc(anns.filter((an) => an.points && an.points.length >= 2 && !an.closed && isLineKind(an.kind)).map((an) => lineFeature(an.points, geo, { color: annColor(an.kind), width: an.width || 1 }))),
    trees: fc(anns.filter((an) => an.kind === 'tree' && an.points && an.points[0]).map((an) => { const ll = localToLatLon(an.points[0], geo); return { type: 'Feature', properties: { r: (an.width || 5) / 2 }, geometry: { type: 'Point', coordinates: [ll.lon, ll.lat] } }; })),
  };
}

// Procedural facade textures. Small tiling bitmaps built on a canvas and
// registered with the map, so a brick wall is brick in the model and not a
// flat brown slab. No image files and nothing to fetch.
const TEX_PAINT = {
  brick: (x, w, h) => {
    x.fillStyle = '#a9694f'; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(255,255,255,0.35)'; x.lineWidth = 1;
    const bh = h / 4, bw = w / 2;
    for (let r = 0; r < 4; r++) {
      const y = r * bh, off = (r % 2) * (bw / 2);
      x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke();
      for (let c = -1; c < 3; c++) { const bx = off + c * bw; x.beginPath(); x.moveTo(bx, y); x.lineTo(bx, y + bh); x.stroke(); }
    }
  },
  panel: (x, w, h) => {
    x.fillStyle = '#b9bcc0'; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(60,66,74,0.35)'; x.lineWidth = 1.5;
    x.strokeRect(0.75, 0.75, w - 1.5, h - 1.5);
    x.strokeStyle = 'rgba(255,255,255,0.18)';
    x.beginPath(); x.moveTo(0, h / 2); x.lineTo(w, h / 2); x.stroke();
  },
  board: (x, w, h) => {
    x.fillStyle = '#b98a52'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) {
      x.fillStyle = i % 2 ? 'rgba(255,240,215,0.12)' : 'rgba(80,50,20,0.14)';
      x.fillRect((i * w) / 8, 0, w / 8, h);
      x.strokeStyle = 'rgba(70,45,20,0.35)'; x.lineWidth = 1;
      x.beginPath(); x.moveTo((i * w) / 8, 0); x.lineTo((i * w) / 8, h); x.stroke();
    }
  },
  plain: (x, w, h) => {
    x.fillStyle = '#dcd9d2'; x.fillRect(0, 0, w, h);
    // A touch of grain, or a rendered wall reads as a solid colour swatch.
    x.fillStyle = 'rgba(120,118,112,0.10)';
    for (let i = 0; i < 90; i++) x.fillRect((i * 37) % w, (i * 53) % h, 1, 1);
  },
  rib: (x, w, h) => {
    x.fillStyle = '#9aa3ad'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 10; i++) {
      x.fillStyle = i % 2 ? 'rgba(255,255,255,0.16)' : 'rgba(35,45,60,0.16)';
      x.fillRect((i * w) / 10, 0, w / 20, h);
    }
  },
  band: (x, w, h) => {
    x.fillStyle = '#8fb0c4'; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(18,42,60,0.42)';
    for (let r = 0; r < 4; r++) x.fillRect(0, r * (h / 4) + h / 16, w, h / 8);
    x.fillStyle = 'rgba(255,255,255,0.20)';
    for (let c = 0; c < 4; c++) x.fillRect(c * (w / 4), 0, 1.5, h);
  },
};
function addFacadeTextures(map) {
  const S = 64;
  for (const [name, paint] of Object.entries(TEX_PAINT)) {
    const id = 'pp-tex-' + name;
    try {
      if (map.hasImage && map.hasImage(id)) continue;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const x = c.getContext('2d');
      paint(x, S, S);
      map.addImage(id, x.getImageData(0, 0, S, S), { pixelRatio: 2 });
    } catch (e) { /* a style without image support just keeps the flat colour */ }
  }
}

const PLAN_LAYERS = ['pp-osm-3d', 'pp-areas-fill', 'pp-site-line', 'pp-aisles-fill', 'pp-lines-line', 'pp-stalls-fill', 'pp-bays-line', 'pp-buildings-3d', 'pp-walls-3d', 'pp-trees-3d', 'pp-assets-3d'];

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
  addFacadeTextures(map);
  const g = planToGeoJSON(plan, geo);
  const src = (id, data) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data }); };
  src('pp-site', g.site); src('pp-aisles', g.aisles); src('pp-stalls', g.stalls);
  src('pp-buildings', g.buildings); src('pp-lines', g.lines); src('pp-areas', g.areas); src('pp-trees', g.trees);
  src('pp-assets', g.assets); src('pp-bays', g.bays);
  const L = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
  L({ id: 'pp-areas-fill', type: 'fill', source: 'pp-areas', layout: { visibility: 'none' }, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55 } });
  L({ id: 'pp-site-line', type: 'line', source: 'pp-site', layout: { visibility: 'none' }, paint: { 'line-color': '#f8b500', 'line-width': 2.5 } });
  L({ id: 'pp-aisles-fill', type: 'fill', source: 'pp-aisles', layout: { visibility: 'none' }, paint: { 'fill-color': '#2b3340', 'fill-opacity': 0.9 } });
  L({ id: 'pp-lines-line', type: 'line', source: 'pp-lines', layout: { visibility: 'none' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['max', 2, ['*', ['get', 'width'], 3]] } });
  L({ id: 'pp-stalls-fill', type: 'fill', source: 'pp-stalls', layout: { visibility: 'none' }, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.95 } });
  // Bay markings, so the car park has the same white lines in 3D as in plan.
  L({ id: 'pp-bays-line', type: 'line', source: 'pp-bays', layout: { visibility: 'none' },
    paint: { 'line-color': '#f8fafc', 'line-width': ['interpolate', ['linear'], ['zoom'], 16, 0.4, 20, 2.2], 'line-opacity': 0.9 } });
  // Ambient occlusion and a vertical gradient are what stop an extrusion from
  // reading as a flat coloured slab; both ship with Mapbox GL 3.
  const EXTRUDE = {
    'fill-extrusion-base': ['coalesce', ['get', 'base'], 0],
    'fill-extrusion-height': ['get', 'height'],
    'fill-extrusion-opacity': 0.97,
    'fill-extrusion-vertical-gradient': true,
    'fill-extrusion-ambient-occlusion-intensity': 0.35,
    'fill-extrusion-ambient-occlusion-radius': 3.5,
  };
  // Roofs, canopies, gardens and plant: flat colour.
  L({ id: 'pp-buildings-3d', type: 'fill-extrusion', source: 'pp-buildings', layout: { visibility: 'none' },
    filter: ['!=', ['get', 'wall'], 1],
    paint: { ...EXTRUDE, 'fill-extrusion-color': ['coalesce', ['get', 'color'], '#8a97a8'] } });
  // Walls get the facade texture. A pattern replaces the colour outright, so
  // this has to be its own layer — patterning the roofs too would put brick
  // courses on a pitched roof.
  L({ id: 'pp-walls-3d', type: 'fill-extrusion', source: 'pp-buildings', layout: { visibility: 'none' },
    filter: ['==', ['get', 'wall'], 1],
    paint: { ...EXTRUDE, 'fill-extrusion-color': ['coalesce', ['get', 'color'], '#c3c8d0'], 'fill-extrusion-pattern': ['get', 'pattern'] } });
  L({ id: 'pp-assets-3d', type: 'fill-extrusion', source: 'pp-assets', layout: { visibility: 'none' }, paint: { 'fill-extrusion-color': '#cbd5e1', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.95 } });
  L({ id: 'pp-trees-3d', type: 'circle', source: 'pp-trees', layout: { visibility: 'none' }, paint: { 'circle-color': '#2f9e44', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 3, 20, ['*', ['get', 'r'], 6]], 'circle-stroke-color': '#14532d', 'circle-stroke-width': 1, 'circle-opacity': 0.9 } });
}
// Which Lagen switch owns which drape layer. The 2D canvas already honours
// these; in 3D nothing did, so "Gebouwen uit" was a switch that stopped
// halfway. `context` is the surrounding real-world buildings, which only exist
// here and could not be turned off at all.
const LAYER_OWNER = {
  'pp-osm-3d': 'context',
  'pp-buildings-3d': 'building',
  'pp-walls-3d': 'building',
  'pp-stalls-fill': 'parking',
  'pp-bays-line': 'parking',
  'pp-aisles-fill': 'parking',
  'pp-site-line': 'site',
  'pp-lines-line': 'infra',
  'pp-areas-fill': 'infra',
  'pp-assets-3d': 'infra',
  'pp-trees-3d': 'infra',
};
// Visible = we are in 3D AND the layer is switched on. The mode leads: in 2D
// every drape layer must stay off whatever the switches say, or the plan is on
// screen twice — once on the canvas, once on the map underneath it.
function applyVisibility(map, is3d, layers) {
  for (const id of PLAN_LAYERS) {
    if (!map.getLayer(id)) continue;
    const owner = LAYER_OWNER[id];
    const on = is3d && (!owner || !layers || layers[owner] !== false);
    map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}
function setData(map, plan, geo) {
  if (!map || !map.isStyleLoaded()) return;
  const g = planToGeoJSON(plan, geo);
  const set = (id, data) => { const s = map.getSource(id); if (s) s.setData(data); };
  set('pp-site', g.site); set('pp-aisles', g.aisles); set('pp-stalls', g.stalls);
  set('pp-buildings', g.buildings); set('pp-lines', g.lines); set('pp-areas', g.areas); set('pp-trees', g.trees);
  set('pp-assets', g.assets); set('pp-bays', g.bays);
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

  let ready = false, pending3d = false, lastPlan = plan, tiles = 0, layerState = null;
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
    // Only before the style has loaded. This handler stays registered for the
    // life of the map, so without the guard a single refused tile or sprite
    // long after a successful load re-raised the full-canvas "token geweigerd"
    // card over a map that was working fine. `access` came out of the pattern
    // for the same reason: it matches far too much ordinary error text.
    if (!ready && (status === 401 || status === 403 || /token|unauthorized|forbidden/i.test(msg))) {
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
    // Sun and sky. Only Mapbox Standard honours these, and an older style
    // throws rather than ignoring them, so it stays advisory.
    try {
      if (map.setLights) {
        map.setLights([
          { id: 'sky', type: 'ambient', properties: { color: '#ffffff', intensity: 0.55 } },
          { id: 'sun', type: 'directional', properties: { color: '#fff4e0', intensity: 0.75, direction: [200, 42], 'cast-shadows': true, 'shadow-intensity': 0.7 } },
        ]);
      }
    } catch (e) { /* style has no lighting model */ }
    clearTimeout(loadTimer);
    diag({ style: 'ok' });
    setTimeout(reportCanvas, 120);
    onError('');
    try { addPlanLayers(map, lastPlan, geo); } catch (e) {}
    try { applyVisibility(map, pending3d, layerState); } catch (e) {}
    setTimeout(() => { try { map.resize(); } catch (e) {} }, 60);
  });
  map.on('data', (e) => { if (e && e.tile) tiles++; });
  map.on('idle', () => { diag({ tiles }); reportCanvas(); });

  return {
    map,
    // A bare catch here meant a rejected camera (a NaN anchor, say) froze the
    // basemap under a plan that kept moving, with nothing reported anywhere.
    follow2D(center, zoom) {
      if (!center || !isFinite(center[0]) || !isFinite(center[1]) || !isFinite(zoom)) {
        diag({ detail: 'ongeldige camera genegeerd (' + center + ' @ ' + zoom + ')' });
        return;
      }
      try { map.jumpTo({ center, zoom, bearing: 0, pitch: 0 }); }
      catch (e) { diag({ detail: 'kaartcamera weigerde: ' + (e && e.message) }); }
    },
    setMode(is3d) {
      pending3d = is3d;
      try {
        map.easeTo({ pitch: is3d ? 55 : 0, duration: 300 });
        if (ready) applyVisibility(map, is3d, layerState);
        // In 3D the user drives the map directly; in 2D our canvas drives it.
        for (const k of ['dragPan', 'scrollZoom', 'dragRotate', 'touchZoomRotate', 'keyboard', 'doubleClickZoom', 'touchPitch']) {
          if (map[k]) { is3d ? map[k].enable() : map[k].disable(); }
        }
      } catch (e) {}
    },
    setPlan(p) { lastPlan = p; try { setData(map, p, geo); } catch (e) {} },
    // The mode is read from the controller, not passed in: two React effects
    // write the same visibility, and whichever ran last would otherwise win.
    setLayers(l) { layerState = l; if (ready) { try { applyVisibility(map, pending3d, layerState); } catch (e) {} } },
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
