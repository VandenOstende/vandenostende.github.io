// ============================================================
// buildings.js — what a drawn footprint looks like from the outside.
//
// A building type turns a grey box into something recognisable: a row of
// houses with gardens, a retail shed with a canopy and a loading yard, an
// office with a set-back top floor and a forecourt. Everything here is derived
// from the footprint alone, so dragging a corner reshapes the design instead of
// leaving a stale one behind — nothing is stored in the document but the type.
//
// Its own module because the canvas renderer, the Mapbox drape and the
// exporters all need it, and none of them may import the entry point.
//
// Every part stays INSIDE the drawn footprint. The footprint is what the solver
// treats as blocked, and a design that grew past it would silently change the
// parking result the moment you picked a type.
// ============================================================
import { polygonCentroid, polygonArea } from './geometry.js?v=6ed44f65';

export const BUILDING_USES = {
  retail:      { key: 'retail',      label: 'Retail',   floors: 1, floorH: 4.5, keywords: 'winkel supermarkt shop baanwinkel' },
  residential: { key: 'residential', label: 'Woningen', floors: 2, floorH: 3.0, keywords: 'huizen rijwoningen wonen appartement' },
  office:      { key: 'office',      label: 'Kantoor',  floors: 4, floorH: 3.6, keywords: 'kantoren bedrijf werkplek' },
};
export const DEFAULT_USE = 'retail';

// Facade materials. `tint` is the wall colour used in plan and as the 3D
// fallback; `tex` names the procedural texture the drape paints on the walls.
// One table so a brick house is the same brick in both views.
export const MATERIALS = {
  brick:    { key: 'brick',    label: 'Gevelsteen', tint: '#a9694f', line: 'rgba(60,30,20,0.30)', tex: 'brick' },
  concrete: { key: 'concrete', label: 'Beton',      tint: '#b9bcc0', line: 'rgba(40,45,55,0.25)', tex: 'panel' },
  wood:     { key: 'wood',     label: 'Hout',       tint: '#b98a52', line: 'rgba(70,45,20,0.32)', tex: 'board' },
  render:   { key: 'render',   label: 'Pleister',   tint: '#dcd9d2', line: 'rgba(80,80,80,0.16)', tex: 'plain' },
  metal:    { key: 'metal',    label: 'Metaal',     tint: '#9aa3ad', line: 'rgba(30,40,55,0.30)', tex: 'rib' },
  glass:    { key: 'glass',    label: 'Glas',       tint: '#8fb0c4', line: 'rgba(20,50,70,0.34)', tex: 'band' },
};
// What each type is usually built of, so picking a use already looks right.
export const DEFAULT_MATERIAL = { retail: 'render', residential: 'brick', office: 'glass' };
export const materialOf = (o) => MATERIALS[(o && o.material)] || MATERIALS[DEFAULT_MATERIAL[(o && o.use) || DEFAULT_USE]] || MATERIALS.render;
// The parts that are actually wall — the ones a facade material applies to.
export const WALL_ROLES = { unit: 1, body: 1, setback: 1 };

// One table, read by the canvas and by the 3D drape, so a roof is never one
// colour in plan and another in the model.
export const PART_COLORS = {
  body:      '#c3c8d0',
  unit:      '#d9c5b0',
  roof:      '#9a5c48',
  parapet:   '#9aa1ab',
  setback:   '#b6c1cd',
  canopy:    '#7f8794',
  dock:      '#8d949f',
  plant:     '#8a919b',
  garden:    '#5fa85a',
  forecourt: '#b9bec6',
  path:      '#c8ccd2',
};

// ---------- small geometry helpers, local to this module ----------

// Direction of the longest edge. The generated layout runs along it, which is
// what makes a row of houses face the way the footprint was drawn.
function axisAngle(poly) {
  let best = 0, bestLen = -1;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) { bestLen = len; best = Math.atan2(b.y - a.y, b.x - a.x); }
  }
  return best;
}

// Keep the side of `poly` where nx*x + ny*y <= d. Clipping against a HALF-PLANE
// (never against another polygon) is what keeps this exact: the result of a
// concave footprint meeting a half-plane is a polygon with a zero-width bridge,
// which fills identically to the true shape.
function clipHalf(poly, nx, ny, d) {
  if (!poly || poly.length < 3) return null;
  const out = [];
  const side = (p) => nx * p.x + ny * p.y - d;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out.length >= 3 ? out : null;
}
// A slab between two parallel cuts along the unit vector (ux, uy).
const slab = (poly, ux, uy, lo, hi) => {
  const a = clipHalf(poly, ux, uy, hi);
  return a ? clipHalf(a, -ux, -uy, -lo) : null;
};
const area = (p) => (p && p.length >= 3 ? Math.abs(polygonArea(p)) : 0);

// Shrink a polygon toward its own centroid. Enough for a set-back storey or a
// roof plinth, and it can never produce the self-intersections a true straight
// skeleton offset does on a concave shape.
function shrink(poly, f) {
  const c = polygonCentroid(poly);
  return poly.map((p) => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f }));
}

/**
 * The exterior of one building.
 *
 * @param poly    footprint in metres
 * @param use     'retail' | 'residential' | 'office'
 * @param floors  storeys, from the document
 * @param toward  a point the entrance should face (the site centroid); optional
 * @returns { use, units, height, areas:[{role,poly,h0,h1}], lines:[{role,a,b}] }
 *          h0/h1 are metres above ground. Areas are drawn back to front.
 */
export function buildingDesign(poly, use, floors, toward) {
  const u = BUILDING_USES[use] || BUILDING_USES[DEFAULT_USE];
  const n = Math.max(1, floors || u.floors);
  const wall = n * u.floorH;
  const empty = { use: u.key, units: 0, height: wall, areas: [], lines: [] };
  if (!poly || poly.length < 3) return empty;

  const c = polygonCentroid(poly);
  const th = axisAngle(poly);
  const ux = Math.cos(th), uy = Math.sin(th);   // along the long axis
  const vx = -uy, vy = ux;                      // across it
  // Coordinates of the footprint projected on the two axes, so the generator
  // can talk in "3 m from the front" without leaving world space.
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const p of poly) {
    const du = (p.x - c.x) * ux + (p.y - c.y) * uy;
    const dv = (p.x - c.x) * vx + (p.y - c.y) * vy;
    if (du < uMin) uMin = du; if (du > uMax) uMax = du;
    if (dv < vMin) vMin = dv; if (dv > vMax) vMax = dv;
  }
  const W = uMax - uMin, D = vMax - vMin;
  if (!(W > 1 && D > 1)) return empty;
  // Cut lines are expressed as world half-planes: n·p <= d with n the axis and
  // d measured from the centroid.
  const cU = c.x * ux + c.y * uy, cV = c.x * vx + c.y * vy;
  const alongSlab = (lo, hi) => slab(poly, ux, uy, cU + lo, cU + hi);
  const acrossSlab = (lo, hi) => slab(poly, vx, vy, cV + lo, cV + hi);

  // Which side is the front? The one whose outward normal points at `toward`
  // (the site centroid) — the entrance should face the car park, not the fence.
  let front = 1; // +1 → vMax side is the front
  if (toward) {
    const dv = (toward.x - c.x) * vx + (toward.y - c.y) * vy;
    front = dv >= 0 ? 1 : -1;
  }
  const frontEdge = front > 0 ? vMax : vMin;
  const backEdge = front > 0 ? vMin : vMax;
  // A band `depth` metres in from the front (or the back) edge.
  const bandFrom = (edge, depth) => (edge === frontEdge
    ? (front > 0 ? acrossSlab(frontEdge - depth, frontEdge) : acrossSlab(frontEdge, frontEdge + depth))
    : (front > 0 ? acrossSlab(backEdge, backEdge + depth) : acrossSlab(backEdge - depth, backEdge)));

  const areas = [], lines = [];
  const add = (role, p, h0, h1) => { if (p && p.length >= 3 && area(p) > 0.4) areas.push({ role, poly: p, h0, h1 }); };
  const world = (du, dv) => ({ x: c.x + ux * du + vx * dv, y: c.y + uy * du + vy * dv });

  if (u.key === 'residential') {
    // Row houses along the long axis, each with a front and a back garden.
    // Gardens only when the plot is deep enough to have any.
    // 11 m is about the shallowest block that still leaves a house between two
    // strips of garden; below that the footprint is all house.
    const frontG = D >= 11 ? Math.min(6, D * 0.24) : 0;
    const backG = D >= 11 ? Math.min(9, D * 0.30) : 0;
    const houseDepth = D - frontG - backG;
    const units = Math.max(1, Math.round(W / 5.5));
    const uw = W / units;
    if (frontG > 0) add('garden', bandFrom(frontEdge, frontG), 0, 0.06);
    if (backG > 0) add('garden', bandFrom(backEdge, backG), 0, 0.06);
    // The strip of footprint the houses themselves occupy.
    const lo = front > 0 ? vMin + backG : vMin + frontG;
    const hi = front > 0 ? vMax - frontG : vMax - backG;
    for (let i = 0; i < units; i++) {
      const a = uMin + i * uw, b = a + uw;
      const col = alongSlab(a, b);
      const body = col ? slab(col, vx, vy, cV + lo, cV + hi) : null;
      add('unit', body, 0, wall);
      // Hipped roof: the same footprint pulled in, sitting on the walls.
      add('roof', body ? shrink(body, 0.72) : null, wall, wall + 2.4);
      // Party wall between neighbours, and the ridge along the unit.
      if (i > 0) lines.push({ role: 'party', a: world(a, lo), b: world(a, hi) });
      lines.push({ role: 'ridge', a: world(a + uw * 0.5, lo + 0.6), b: world(a + uw * 0.5, hi - 0.6) });
      // Front door, on the side that faces the car park.
      const doorV = front > 0 ? hi : lo;
      lines.push({ role: 'door', a: world(a + uw * 0.32, doorV), b: world(a + uw * 0.52, doorV) });
      if (frontG > 0) {
        lines.push({ role: 'path', a: world(a + uw * 0.42, doorV), b: world(a + uw * 0.42, front > 0 ? vMax : vMin) });
      }
    }
    return { use: u.key, units, height: wall + 2.4, areas, lines };
  }

  if (u.key === 'office') {
    const forecourt = D >= 18 ? Math.min(8, D * 0.18) : 0;
    const bodyPoly = forecourt > 0
      ? (front > 0 ? acrossSlab(vMin, vMax - forecourt) : acrossSlab(vMin + forecourt, vMax))
      : poly.slice();
    if (forecourt > 0) add('forecourt', bandFrom(frontEdge, forecourt), 0, 0.05);
    add('body', bodyPoly, 0, wall);
    // A set-back top storey is the single detail that reads as "office" from
    // the air rather than "box".
    if (n >= 3 && bodyPoly) add('setback', shrink(bodyPoly, 0.86), wall, wall + u.floorH);
    add('parapet', bodyPoly ? shrink(bodyPoly, 0.995) : null, wall + (n >= 3 ? u.floorH : 0), wall + (n >= 3 ? u.floorH : 0) + 1.0);
    if (bodyPoly) add('plant', shrink(bodyPoly, 0.3), wall + (n >= 3 ? u.floorH : 0), wall + (n >= 3 ? u.floorH : 0) + 2.2);
    // Curtain-wall rhythm: one line per bay along the entrance elevation.
    const bays = Math.max(2, Math.round(W / 6));
    for (let i = 1; i < bays; i++) {
      const a = uMin + (W * i) / bays;
      lines.push({ role: 'mullion', a: world(a, vMin), b: world(a, vMax) });
    }
    return { use: u.key, units: 1, height: wall + (n >= 3 ? u.floorH : 0) + 1.0, areas, lines };
  }

  // retail
  const canopyD = Math.min(4.5, D * 0.14);
  const dockD = D >= 20 ? Math.min(9, D * 0.2) : 0;
  // The shed stops short of both the loading yard and the canopy. Without that
  // the canopy sits inside the shed and is invisible in 3D — it has to be its
  // own lower volume in front of the shopfront, and everything must still stay
  // within the drawn footprint.
  const shed = front > 0
    ? acrossSlab(vMin + dockD, vMax - canopyD)
    : acrossSlab(vMin + canopyD, vMax - dockD);
  if (dockD > 0) add('dock', bandFrom(backEdge, dockD), 0, 0.06);
  add('body', shed, 0, wall);
  add('parapet', shed ? shrink(shed, 0.99) : null, wall, wall + 0.9);
  // Entrance canopy along the elevation that faces the parking.
  add('canopy', bandFrom(frontEdge, canopyD), 0, wall * 0.62);
  if (shed) add('plant', shrink(shed, 0.34), wall + 0.9, wall + 0.9 + 1.8);
  // Loading bays, as marks on the yard.
  if (dockD > 0) {
    const docks = Math.max(1, Math.min(4, Math.round(W / 12)));
    for (let i = 0; i < docks; i++) {
      const a = uMin + (W * (i + 0.5)) / docks;
      lines.push({ role: 'dockline', a: world(a - 1.6, backEdge), b: world(a + 1.6, backEdge) });
    }
  }
  // Shopfront glazing.
  const bays = Math.max(2, Math.round(W / 8));
  for (let i = 1; i < bays; i++) {
    const a = uMin + (W * i) / bays;
    lines.push({ role: 'mullion', a: world(a, frontEdge), b: world(a, frontEdge - front * canopyD) });
  }
  return { use: u.key, units: 1, height: wall + 0.9 + 1.8, areas, lines };
}
