// ============================================================
// basemap.js — slippy-map raster tiles under the plan.
//
// The plan lives in a local "ground meters" frame whose origin
// (0,0) is pinned to a geographic anchor {lat, lon}. Tiles are
// web-mercator; at parcel scale the equirectangular ↔ mercator
// mismatch is negligible, so each visible tile is placed by
// converting its geographic corners into local meters.
// ============================================================

const R = 111320; // meters per degree of latitude (mean)

// ---- Geographic <-> local meters (anchor-relative, equirectangular) ----
export function localToLatLon(p, geo) {
  const lat = geo.lat - p.y / R;
  const lon = geo.lon + p.x / (R * Math.cos((geo.lat * Math.PI) / 180));
  return { lat, lon };
}
export function latLonToLocal(ll, geo) {
  const x = (ll.lon - geo.lon) * R * Math.cos((geo.lat * Math.PI) / 180);
  const y = (geo.lat - ll.lat) * R;
  return { x, y };
}

// ---- Geographic <-> slippy tile coordinates ----
function latLonToTileF(lat, lon, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}
function tileToLatLon(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lat: (latRad * 180) / Math.PI, lon };
}

// ---- Basemap styles ----
// Each style is an ordered list of tile layers (base first, labels on top).
export const BASEMAPS = {
  none: { label: 'Geen', layers: [], attribution: '' },
  osm: {
    label: 'OpenStreetMap',
    layers: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
  },
  satellite: {
    label: 'Satelliet',
    layers: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Bron: Esri, Maxar, Earthstar Geographics',
  },
  hybrid: {
    label: 'Hybride',
    layers: [
      'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: 'Bron: Esri, Maxar, Earthstar Geographics',
  },
};

// ---- Tile cache & async loader ----
const cache = new Map(); // key -> HTMLImageElement (may be loading/failed)
const MAX_TILES = 500;
let redraw = () => {};
export function setRedraw(fn) { redraw = fn; }

function tileURL(tpl, z, x, y) {
  return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

function getTile(tpl, z, x, y) {
  const key = tpl + '|' + z + '|' + x + '|' + y;
  let img = cache.get(key);
  if (img) return img;
  img = new Image();
  img.crossOrigin = 'anonymous'; // keep the canvas exportable (servers send CORS)
  img._ok = false;
  img.onload = () => { img._ok = true; redraw(); };
  img.onerror = () => { img._failed = true; };
  img.src = tileURL(tpl, z, x, y);
  cache.set(key, img);
  if (cache.size > MAX_TILES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return img;
}

/**
 * Pick the web-mercator zoom whose native ground resolution best
 * matches the current on-screen scale (CSS px per ground meter).
 */
export function pickZoom(view, geo) {
  const latRad = (geo.lat * Math.PI) / 180;
  const targetRes = 1 / view.scale; // meters per CSS pixel
  let z = Math.round(Math.log2((156543.033928 * Math.cos(latRad)) / targetRes));
  return Math.max(2, Math.min(19, z));
}

/**
 * Draw the active basemap under the plan. `w2s` maps local meters to
 * screen (CSS px); `view`/`size` define the visible rectangle.
 */
export function drawBasemap(ctx, { style, geo, view, size, w2s }) {
  const meta = BASEMAPS[style];
  if (!meta || meta.layers.length === 0) return;
  const z = pickZoom(view, geo);
  const n = 2 ** z;

  // Visible local-meter rectangle → geographic → tile index range.
  const s2w = (p) => ({ x: (p.x - view.ox) / view.scale, y: (p.y - view.oy) / view.scale });
  const corners = [
    { x: 0, y: 0 }, { x: size.w, y: 0 }, { x: 0, y: size.h }, { x: size.w, y: size.h },
  ].map((c) => latLonToTileF(...llArgs(localToLatLon(s2w(c), geo)), z));
  const minX = Math.floor(Math.min(...corners.map((t) => t.x)));
  const maxX = Math.floor(Math.max(...corners.map((t) => t.x)));
  const minY = Math.floor(Math.min(...corners.map((t) => t.y)));
  const maxY = Math.floor(Math.max(...corners.map((t) => t.y)));

  // Bail out on absurd ranges (guards against degenerate views).
  if ((maxX - minX) * (maxY - minY) > 600) return;

  ctx.imageSmoothingEnabled = true;
  for (const tpl of meta.layers) {
    for (let ty = minY; ty <= maxY; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = minX; tx <= maxX; tx++) {
        const wx = ((tx % n) + n) % n;
        const img = getTile(tpl, z, wx, ty);
        if (!img._ok) continue;
        const nw = w2s(latLonToLocal(tileToLatLon(tx, ty, z), geo));
        const se = w2s(latLonToLocal(tileToLatLon(tx + 1, ty + 1, z), geo));
        // +1px overdraw hides hairline seams between adjacent tiles.
        ctx.drawImage(img, nw.x, nw.y, se.x - nw.x + 1, se.y - nw.y + 1);
      }
    }
  }
}

function llArgs(ll) { return [ll.lat, ll.lon]; }

// A blocked host can leave fetch pending indefinitely; without a deadline the
// primary provider never fails and the fallback never runs, so search just
// hangs with no message.
const GEOCODE_TIMEOUT_MS = 6000;
async function fetchJSON(url, opts) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) {} }, GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...(opts || {}), signal: ctl ? ctl.signal : undefined });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function geocodeNominatim(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query);
  const data = await fetchJSON(url, { headers: { 'Accept-Language': 'nl' } });
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: data[0].display_name };
}

async function geocodeMapbox(query, token) {
  const url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(query)
    + '.json?limit=1&language=nl&access_token=' + encodeURIComponent(token);
  const data = await fetchJSON(url);
  const f = data && data.features && data.features[0];
  if (!f || !f.center) return null;
  return { lat: f.center[1], lon: f.center[0], label: f.place_name || query };
}

/**
 * Geocode a free-text query. Prefers Mapbox when a token is available — it is
 * CORS-clean and meant for browser use, whereas Nominatim's usage policy
 * discourages it and rate-limits hard. Falls back to Nominatim either way, so
 * search keeps working without a token.
 * Returns { lat, lon, label } or null.
 */
export async function geocode(query, token) {
  if (token) {
    try {
      const hit = await geocodeMapbox(query, token);
      if (hit) return hit;
    } catch (e) { /* fall through to Nominatim */ }
  }
  return geocodeNominatim(query);
}
