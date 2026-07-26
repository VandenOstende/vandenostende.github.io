// ============================================================
// importers.js — read a parcel boundary from GeoJSON or KML.
// Returns the outer ring of the largest polygon as [{lat, lon}, …],
// or null when nothing usable is found.
// ============================================================

// Shoelace area in lon/lat units — only used to compare candidate rings.
function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p.lon * q.lat - q.lon * p.lat;
  }
  return Math.abs(a) / 2;
}

// Drop a duplicated closing vertex if the ring repeats its first point.
function dropClosing(ring) {
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9) return ring.slice(0, -1);
  }
  return ring;
}

// ---- GeoJSON ----
function collectPolygons(geom, out) {
  if (!geom) return;
  if (geom.type === 'Polygon') out.push(geom.coordinates[0]);
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((poly) => out.push(poly[0]));
  else if (geom.type === 'GeometryCollection') (geom.geometries || []).forEach((g) => collectPolygons(g, out));
}

function parseGeoJSON(obj) {
  const rings = [];
  if (obj.type === 'FeatureCollection') (obj.features || []).forEach((f) => collectPolygons(f.geometry, rings));
  else if (obj.type === 'Feature') collectPolygons(obj.geometry, rings);
  else collectPolygons(obj, rings);
  const asLL = rings
    .map((r) => dropClosing((r || []).map((c) => ({ lon: +c[0], lat: +c[1] }))))
    .filter((r) => r.length >= 3 && r.every((p) => isFinite(p.lat) && isFinite(p.lon)));
  if (!asLL.length) return null;
  asLL.sort((a, b) => ringArea(b) - ringArea(a));
  return asLL[0];
}

// ---- KML ----
function parseCoordString(text) {
  return text.trim().split(/\s+/).map((tok) => {
    const [lon, lat] = tok.split(',');
    return { lon: +lon, lat: +lat };
  }).filter((p) => isFinite(p.lat) && isFinite(p.lon));
}

function parseKML(text) {
  let rings = [];
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      // Prefer outer boundaries; fall back to any <coordinates>.
      let nodes = [...doc.getElementsByTagName('outerBoundaryIs')]
        .map((n) => n.getElementsByTagName('coordinates')[0]).filter(Boolean);
      if (!nodes.length) nodes = [...doc.getElementsByTagName('coordinates')];
      rings = nodes.map((n) => dropClosing(parseCoordString(n.textContent || '')));
    } catch (e) { rings = []; }
  }
  if (!rings.length) {
    // Regex fallback when there's no DOMParser.
    const m = text.match(/<coordinates>([\s\S]*?)<\/coordinates>/gi) || [];
    rings = m.map((block) => dropClosing(parseCoordString(block.replace(/<\/?coordinates>/gi, ''))));
  }
  rings = rings.filter((r) => r.length >= 3);
  if (!rings.length) return null;
  rings.sort((a, b) => ringArea(b) - ringArea(a));
  return rings[0];
}

export function parseParcel(text, name = '') {
  const lname = (name || '').toLowerCase();
  const looksKml = lname.endsWith('.kml') || /<kml[\s>]/i.test(text) || (/<coordinates>/i.test(text) && !text.trim().startsWith('{'));
  if (!looksKml) {
    try { return parseGeoJSON(JSON.parse(text)); } catch (e) { /* try KML */ }
  }
  return parseKML(text);
}

// ---- Douglas–Peucker simplification (points in metres) ----
function dpSimplify(pts, tol) {
  if (pts.length <= 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const a = pts[s], b = pts[e];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Simplify a closed metric ring, then hard-cap the vertex count.
export function simplifyRing(pts, tol = 0.5, cap = 120) {
  let out = dpSimplify(pts, tol);
  if (out.length > cap) {
    const step = out.length / cap;
    const dec = [];
    for (let i = 0; i < out.length; i += step) dec.push(out[Math.floor(i)]);
    out = dec;
  }
  return out;
}
