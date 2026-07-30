// ============================================================
// exporters.js — GeoJSON / DXF / CSV export of the plan.
//
// The plan lives in a local metre frame anchored to doc.geo; GeoJSON is
// produced in real lng/lat via the same anchor used by the basemap tiles
// and the 3D view. DXF/CSV use the raw local metres.
// ============================================================
import { localToLatLon } from './basemap.js?v=5757c07f';
import { polyOf, ribbonPoly } from './geometry.js?v=5757c07f';
import { ANNOT_TYPES } from './annots.js?v=5757c07f';

// A drawn carriageway is an area, not a centreline: exporting the hairline lost
// its width, its offset and its corners.
function bodyPoly(an) {
  const t = ANNOT_TYPES[an.kind];
  if (!t || !t.body || an.closed || !an.points || an.points.length < 2) return null;
  const p = ribbonPoly(an.points, an.width || t.width || 6, an.align, an.curved);
  return p && p.length >= 3 ? p : null;
}

const AREA_KINDS = ['bikeparking', 'grass']; // annotation kinds that are filled areas
// Any single-point annotation exports as a point. Previously only 'tree' did,
// so every marking, pictogram and sign was silently dropped from the export.
const isPoint = (an) => an.points.length === 1;

// ---------- GeoJSON ----------
export function toGeoJSON(plan, geo) {
  const ll = (p) => { const g = localToLatLon(p, geo); return [g.lon, g.lat]; };
  const ring = (poly) => {
    const r = poly.map(ll);
    if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
    return r;
  };
  const poly = (pts, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring(pts)] } });
  const line = (pts, props) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts.map(ll) } });
  const point = (pt, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: ll(pt) } });

  const feats = [];
  if (plan.site && plan.site.length >= 3) feats.push(poly(plan.site, { kind: 'site' }));
  (plan.obstacles || []).forEach((o) => feats.push(poly(polyOf(o), { kind: 'building', floors: (o && o.floors) || 1 })));
  (plan.aisles || []).forEach((a) => feats.push(poly(a.poly, { kind: 'aisle', oneway: !!a.oneway })));
  (plan.turnarounds || []).forEach((t) => feats.push(poly(t.poly || t, { kind: 'turnaround' })));
  (plan.islands || []).forEach((i) => feats.push(poly(i.poly || i, { kind: 'island' })));
  (plan.stalls || []).forEach((s) => feats.push(poly(s.poly, { kind: 'stall', type: s.type })));
  (plan.annotations || []).forEach((an) => {
    if (!an.points || !an.points.length) return;
    const body = bodyPoly(an);
    if (body) { feats.push(poly(body, { kind: an.kind, material: an.material, width: an.width || 6, align: an.align || 'center' })); return; }
    if (isPoint(an)) {
      const props = { kind: an.kind, material: an.material, diameter: an.width || 5 };
      if (an.angle != null) props.angle = an.angle;
      if (an.value != null) props.value = an.value;
      feats.push(point(an.points[0], props));
    } else if (an.points.length >= 3 && (AREA_KINDS.includes(an.kind) || an.closed)) feats.push(poly(an.points, { kind: an.kind, material: an.material }));
    else if (an.points.length >= 2) feats.push(line(an.points, { kind: an.kind, material: an.material, width: an.width || 1 }));
  });
  return { type: 'FeatureCollection', features: feats };
}

// ---------- DXF (ASCII, minimal R12-style ENTITIES) ----------
export function toDXF(plan) {
  const out = [];
  const g = (code, val) => { out.push(String(code)); out.push(String(val)); };
  // CAD is Y-up; the app frame is Y-down, so negate Y.
  const addPoly = (pts, layer, closed) => {
    g(0, 'LWPOLYLINE'); g(8, layer); g(90, pts.length); g(70, closed ? 1 : 0);
    pts.forEach((p) => { g(10, p.x.toFixed(3)); g(20, (-p.y).toFixed(3)); });
  };
  const addCircle = (c, r, layer) => { g(0, 'CIRCLE'); g(8, layer); g(10, c.x.toFixed(3)); g(20, (-c.y).toFixed(3)); g(40, r.toFixed(3)); };

  g(0, 'SECTION'); g(2, 'ENTITIES');
  if (plan.site && plan.site.length >= 3) addPoly(plan.site, 'SITE', true);
  (plan.obstacles || []).forEach((o) => addPoly(polyOf(o), 'BUILDINGS', true));
  (plan.aisles || []).forEach((a) => addPoly(a.poly, 'AISLES', true));
  (plan.turnarounds || []).forEach((t) => addPoly(t.poly || t, 'TURNAROUNDS', true));
  (plan.islands || []).forEach((i) => addPoly(i.poly || i, 'ISLANDS', true));
  (plan.stalls || []).forEach((s) => addPoly(s.poly, 'STALLS_' + (s.type || 'standard').toUpperCase(), true));
  (plan.annotations || []).forEach((an) => {
    if (!an.points || !an.points.length) return;
    // A material can only travel in the layer name here — DXF entities carry no
  // attributes in this writer.
  const layer = String(an.kind).toUpperCase() + (an.material ? '_' + String(an.material).toUpperCase() : '');
    const body = bodyPoly(an);
    if (body) { addPoly(body, layer, true); return; }
    if (isPoint(an)) addCircle(an.points[0], (an.width || 5) / 2, an.kind === 'tree' ? 'TREES' : layer);
    else if (an.points.length >= 3 && (AREA_KINDS.includes(an.kind) || an.closed)) addPoly(an.points, layer, true);
    else if (an.points.length >= 2) addPoly(an.points, layer, false);
  });
  g(0, 'ENDSEC'); g(0, 'EOF');
  return out.join('\n');
}

// ---------- CSV (quantity takeoff) ----------
// `light` is optional: the lighting and yield figures only exist once those
// panels have been opened, and a takeoff must never claim a number that was
// never computed.
export function toCSV(plan, metrics, light) {
  const rows = [['Categorie', 'Waarde']];
  rows.push(['Totaal vakken', metrics.total]);
  Object.entries(metrics.counts || {}).forEach(([k, v]) => rows.push(['Vakken — ' + k, v]));
  rows.push(['Site oppervlak (m2)', Math.round(metrics.siteArea)]);
  rows.push(['Bebouwd (m2)', Math.round(metrics.buildingArea)]);
  rows.push(['Beschikbaar/buildable (m2)', Math.round(metrics.buildableArea)]);
  rows.push(['m2 per vak', metrics.total ? metrics.areaPerStall.toFixed(1) : '0']);
  rows.push(['Bebouwingsgraad (%)', (metrics.coverage * 100).toFixed(0)]);
  if (metrics.imperviousPct != null) rows.push(['Verhard/impervious (%)', (metrics.imperviousPct * 100).toFixed(0)]);
  rows.push(['Minder-valide vereist', metrics.adaRequired]);
  rows.push(['Minder-valide geleverd', metrics.adaProvided]);
  rows.push(['Eenrichtings-rijbanen', (metrics.onewayAisles || 0) + '/' + (metrics.aisleCount || 0)]);
  if ((plan.turnarounds || []).length) rows.push(['Keerruimtes', plan.turnarounds.length]);
  if ((plan.islands || []).length) rows.push(['Plantvakken', plan.islands.length]);
  if (metrics.requiredStalls != null) rows.push(['Vereiste plaatsen (zoning)', metrics.requiredStalls]);
  const pv = light && light.pv;
  if (pv && pv.area > 0) {
    rows.push(['Carport overkapt (m2)', Math.round(pv.area)]);
    rows.push(['PV vermogen (kWp)', pv.kWp.toFixed(1)]);
    rows.push(['PV opbrengst (kWh/jaar)', Math.round(pv.kWh)]);
    rows.push(['PV specifiek (kWh/kWp)', Math.round(pv.specific)]);
    rows.push(['PV schaduwverlies (%)', (pv.shadeLoss * 100).toFixed(1)]);
  }
  const lx = light && light.lux;
  if (lx && lx.avg != null) {
    rows.push(['Verlichting gemiddeld (lx)', lx.avg.toFixed(1)]);
    rows.push(['Verlichting minimum (lx)', lx.min.toFixed(1)]);
    rows.push(['Verlichting gelijkmatigheid U0', lx.u0.toFixed(2)]);
  }
  const esc = (c) => '"' + String(c).replace(/"/g, '""') + '"';
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}
