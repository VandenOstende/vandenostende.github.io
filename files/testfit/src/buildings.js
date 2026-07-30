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
import { polygonCentroid, polygonArea } from './geometry.js?v=92666330';

/**
 * The building catalogue.
 *
 * A style is a parameter set over one of three generators, not code of its own:
 *
 *   shed   one volume, optional entrance canopy and loading yard  (retail, big box, warehouse)
 *   rows   repeated units along the long axis, optional gardens   (row houses, terraces)
 *   block  one volume, optional forecourt and set-back top storey (offices, apartments)
 *
 * That split is what makes a style importable: everything below is data, so a
 * style someone else wrote is a JSON object rather than a function this app
 * would have to run.
 *
 * The first three keys are the original ones and keep their exact numbers, so
 * every saved plan renders as it did.
 */
export const BUILDING_USES = {
  retail:      { key: 'retail',      label: 'Retail',        gen: 'shed',  floors: 1, floorH: 4.5, material: 'render',
                 canopy: 0.14, canopyMax: 4.5, dock: 0.20, dockMin: 20, dockMax: 9, parapet: 0.9, plant: 1.8, bay: 8,
                 keywords: 'winkel supermarkt shop baanwinkel', desc: 'Winkel met luifel over de voorgevel en een laadkade achteraan.' },
  residential: { key: 'residential', label: 'Woningen',      gen: 'rows',  floors: 2, floorH: 3.0, material: 'brick',
                 frontGarden: 0.24, frontMax: 6, backGarden: 0.30, backMax: 9, gardenMin: 11, unitW: 5.5, roof: 2.4,
                 keywords: 'huizen rijwoningen wonen tuin', desc: 'Rij eengezinswoningen met voortuin, achtertuin en een zadeldak.' },
  office:      { key: 'office',      label: 'Kantoor',       gen: 'block', floors: 4, floorH: 3.6, material: 'glass',
                 forecourt: 0.18, forecourtMax: 8, forecourtMin: 18, setbackFrom: 3, setback: 0.86, parapet: 1.0, plant: 2.2, bay: 6,
                 keywords: 'kantoren bedrijf werkplek', desc: 'Kantoor met voorplein, terugliggende bovenste laag en een vliesgevel.' },

  // ---- the variants ----
  bigbox:      { key: 'bigbox',      label: 'Baanwinkel',    gen: 'shed',  floors: 1, floorH: 6.0, material: 'concrete',
                 canopy: 0.07, canopyMax: 3, dock: 0.22, dockMin: 18, dockMax: 11, parapet: 1.4, plant: 2.4, bay: 12,
                 keywords: 'retailpark doe-het-zelf tuincentrum grootschalig', desc: 'Grootschalige baanwinkel: hoge doos, kleine luifel, brede laadzone.' },
  warehouse:   { key: 'warehouse',   label: 'Magazijn',      gen: 'shed',  floors: 1, floorH: 9.5, material: 'metal',
                 canopy: 0, dock: 0.26, dockMin: 14, dockMax: 14, docks: 8, parapet: 1.2, plant: 0, bay: 0,
                 keywords: 'warehouse loods distributie logistiek hal opslag laadkade', desc: 'Logistieke hal van 9,5 m met acht laadpoorten en geen winkelpui.' },
  shed:        { key: 'shed',        label: 'Kaal blok',     gen: 'shed',  floors: 1, floorH: 5.0, material: 'concrete',
                 canopy: 0, dock: 0, parapet: 0.6, plant: 0, bay: 0,
                 keywords: 'kaal eenvoudig doos zonder luifel productie', desc: 'Kale doos zonder luifel of kade — productie, opslag, techniek.' },
  terrace:     { key: 'terrace',     label: 'Rij zonder tuin', gen: 'rows', floors: 3, floorH: 3.0, material: 'brick',
                 frontGarden: 0, backGarden: 0, unitW: 5.5, roof: 0,
                 keywords: 'gesloten bouwblok stadswoningen zonder tuin rijhuizen', desc: 'Gesloten bouwblok: rijhuizen zonder tuin, drie lagen, plat dak.' },
  townhouse:   { key: 'townhouse',   label: 'Woningen, diepe tuin', gen: 'rows', floors: 2, floorH: 3.0, material: 'brick',
                 frontGarden: 0.14, frontMax: 4, backGarden: 0.44, backMax: 16, gardenMin: 14, unitW: 6.5, roof: 2.8,
                 keywords: 'vrijstaand halfopen ruime tuin verkaveling', desc: 'Ruimere woningen met een diepe achtertuin en een smalle voortuin.' },
  apartment:   { key: 'apartment',   label: 'Appartementen', gen: 'block', floors: 5, floorH: 2.9, material: 'render',
                 forecourt: 0.10, forecourtMax: 5, forecourtMin: 16, setbackFrom: 4, setback: 0.9, parapet: 1.1, plant: 1.4, bay: 4,
                 keywords: 'appartementsblok flat wonen gestapeld', desc: 'Appartementsblok van vijf lagen met een klein voorplein.' },
  officeCore:  { key: 'officeCore',  label: 'Kantoor, geen plein', gen: 'block', floors: 6, floorH: 3.6, material: 'glass',
                 forecourt: 0, setbackFrom: 3, setback: 0.88, parapet: 1.0, plant: 2.2, bay: 6,
                 keywords: 'kantoortoren binnenstedelijk zonder voorplein', desc: 'Binnenstedelijk kantoor van zes lagen, tot op de rooilijn gebouwd.' },
};

/**
 * Add a style at runtime, the way an imported symbol joins the annotation
 * catalogue. Every field is clamped here rather than trusted: an imported style
 * is a file, and a floor height of -5 or a generator name that is not one of the
 * three would reach the geometry.
 */
export const BUILDING_GENERATORS = ['shed', 'rows', 'block'];
const num = (v, lo, hi, dflt) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : dflt);
export function registerBuildingStyle(spec) {
  if (!spec || !spec.key || typeof spec.key !== 'string') return null;
  const key = spec.key.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '');
  if (!key) return null;
  const gen = BUILDING_GENERATORS.includes(spec.gen) ? spec.gen : 'shed';
  const base = {
    key, gen, imported: true,
    label: String(spec.label || key).slice(0, 40),
    floors: Math.round(num(spec.floors, 1, 40, 1)),
    floorH: num(spec.floorH, 2, 20, 4),
    material: MATERIALS[spec.material] ? spec.material : 'render',
    keywords: String(spec.keywords || '').slice(0, 200),
    desc: String(spec.desc || '').slice(0, 160),
  };
  if (gen === 'shed') Object.assign(base, {
    canopy: num(spec.canopy, 0, 0.4, 0), canopyMax: num(spec.canopyMax, 0, 12, 4.5),
    dock: num(spec.dock, 0, 0.4, 0), dockMin: num(spec.dockMin, 0, 60, 20), dockMax: num(spec.dockMax, 0, 20, 9),
    docks: spec.docks == null ? null : Math.round(num(spec.docks, 1, 12, 4)),
    parapet: num(spec.parapet, 0, 4, 0.9), plant: num(spec.plant, 0, 6, 0), bay: num(spec.bay, 0, 40, 0),
  });
  if (gen === 'rows') Object.assign(base, {
    frontGarden: num(spec.frontGarden, 0, 0.45, 0), frontMax: num(spec.frontMax, 0, 30, 6),
    backGarden: num(spec.backGarden, 0, 0.6, 0), backMax: num(spec.backMax, 0, 40, 9),
    gardenMin: num(spec.gardenMin, 0, 60, 11), unitW: num(spec.unitW, 3, 30, 5.5), roof: num(spec.roof, 0, 8, 2.4),
  });
  if (gen === 'block') Object.assign(base, {
    forecourt: num(spec.forecourt, 0, 0.4, 0), forecourtMax: num(spec.forecourtMax, 0, 20, 8),
    forecourtMin: num(spec.forecourtMin, 0, 60, 18), setbackFrom: Math.round(num(spec.setbackFrom, 1, 40, 3)),
    setback: num(spec.setback, 0.5, 1, 0.86), parapet: num(spec.parapet, 0, 4, 1.0),
    plant: num(spec.plant, 0, 6, 0), bay: num(spec.bay, 0, 40, 0),
  });
  BUILDING_USES[key] = base;
  return key;
}
/** Drop an imported style again. Built-ins are refused, not silently kept. */
export function removeBuildingStyle(key) {
  const t = BUILDING_USES[key];
  if (!t || !t.imported) return false;
  delete BUILDING_USES[key];
  return true;
}
/** The fields a style is made of, for export. */
export const styleSpec = (u) => {
  const out = {};
  for (const k of Object.keys(u)) if (k !== 'imported') out[k] = u[k];
  return out;
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
// Kept as a name because callers use it; the answer now comes from the style
// itself, so a new style does not need a second table edited to look right.
export const DEFAULT_MATERIAL = new Proxy({}, {
  get: (_t, k) => (BUILDING_USES[k] || {}).material || 'render',
  has: (_t, k) => k in BUILDING_USES,
});
export const materialOf = (o) => MATERIALS[(o && o.material)]
  || MATERIALS[(BUILDING_USES[(o && o.use) || DEFAULT_USE] || {}).material] || MATERIALS.render;
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

  if (u.gen === 'rows') {
    // Repeated units along the long axis, with optional strips of garden front
    // and back. `gardenMin` is the shallowest block that still leaves a house
    // between two strips; below that the footprint is all house.
    const deep = D >= (u.gardenMin || 0);
    const frontG = deep ? Math.min(u.frontMax || 0, D * (u.frontGarden || 0)) : 0;
    const backG = deep ? Math.min(u.backMax || 0, D * (u.backGarden || 0)) : 0;
    const units = Math.max(1, Math.round(W / (u.unitW || 5.5)));
    const uw = W / units;
    const roofH = u.roof || 0;
    if (frontG > 0) add('garden', bandFrom(frontEdge, frontG), 0, 0.06);
    if (backG > 0) add('garden', bandFrom(backEdge, backG), 0, 0.06);
    // The strip of footprint the houses themselves occupy.
    const lo = front > 0 ? vMin + backG : vMin + frontG;
    const hi = front > 0 ? vMax - frontG : vMax - backG;
    for (let i = 0; i < units; i++) {
      const a2 = uMin + i * uw, b2 = a2 + uw;
      const col = alongSlab(a2, b2);
      const body = col ? slab(col, vx, vy, cV + lo, cV + hi) : null;
      add('unit', body, 0, wall);
      // A pitched roof is the same footprint pulled in, sitting on the walls; a
      // style with roof 0 is flat and gets a parapet instead, which is what a
      // closed terrace block actually looks like from above.
      if (roofH > 0) add('roof', body ? shrink(body, 0.72) : null, wall, wall + roofH);
      else add('parapet', body ? shrink(body, 0.99) : null, wall, wall + 0.6);
      if (i > 0) lines.push({ role: 'party', a: world(a2, lo), b: world(a2, hi) });
      if (roofH > 0) lines.push({ role: 'ridge', a: world(a2 + uw * 0.5, lo + 0.6), b: world(a2 + uw * 0.5, hi - 0.6) });
      // Front door, on the side that faces the car park.
      const doorV = front > 0 ? hi : lo;
      lines.push({ role: 'door', a: world(a2 + uw * 0.32, doorV), b: world(a2 + uw * 0.52, doorV) });
      if (frontG > 0) {
        lines.push({ role: 'path', a: world(a2 + uw * 0.42, doorV), b: world(a2 + uw * 0.42, front > 0 ? vMax : vMin) });
      }
    }
    return { use: u.key, units, height: wall + (roofH > 0 ? roofH : 0.6), areas, lines };
  }

  if (u.gen === 'block') {
    const forecourt = D >= (u.forecourtMin || 0) ? Math.min(u.forecourtMax || 0, D * (u.forecourt || 0)) : 0;
    const bodyPoly = forecourt > 0
      ? (front > 0 ? acrossSlab(vMin, vMax - forecourt) : acrossSlab(vMin + forecourt, vMax))
      : poly.slice();
    if (forecourt > 0) add('forecourt', bandFrom(frontEdge, forecourt), 0, 0.05);
    add('body', bodyPoly, 0, wall);
    // A set-back top storey is the single detail that reads as "office" from
    // the air rather than "box" — but only once the block is tall enough to have
    // a top storey worth setting back.
    const stepped = u.setbackFrom > 0 && n >= u.setbackFrom;
    if (stepped && bodyPoly) add('setback', shrink(bodyPoly, u.setback || 0.86), wall, wall + u.floorH);
    const top = wall + (stepped ? u.floorH : 0);
    if (u.parapet > 0) add('parapet', bodyPoly ? shrink(bodyPoly, 0.995) : null, top, top + u.parapet);
    if (u.plant > 0 && bodyPoly) add('plant', shrink(bodyPoly, 0.3), top, top + u.plant);
    // Curtain-wall rhythm: one line per bay along the entrance elevation.
    if (u.bay > 0) {
      const bays = Math.max(2, Math.round(W / u.bay));
      for (let i = 1; i < bays; i++) {
        const a2 = uMin + (W * i) / bays;
        lines.push({ role: 'mullion', a: world(a2, vMin), b: world(a2, vMax) });
      }
    }
    return { use: u.key, units: 1, height: top + (u.parapet || 0), areas, lines };
  }

  // shed — one volume, with an optional canopy at the front and an optional
  // loading yard at the back.
  const canopyD = u.canopy > 0 ? Math.min(u.canopyMax || 4.5, D * u.canopy) : 0;
  const dockD = (u.dock > 0 && D >= (u.dockMin || 0)) ? Math.min(u.dockMax || 9, D * u.dock) : 0;
  // The shed stops short of both the loading yard and the canopy. Without that
  // the canopy sits inside the shed and is invisible in 3D — it has to be its
  // own lower volume in front of the shopfront, and everything must still stay
  // within the drawn footprint.
  const shed = front > 0
    ? acrossSlab(vMin + dockD, vMax - canopyD)
    : acrossSlab(vMin + canopyD, vMax - dockD);
  if (dockD > 0) add('dock', bandFrom(backEdge, dockD), 0, 0.06);
  add('body', shed, 0, wall);
  if (u.parapet > 0) add('parapet', shed ? shrink(shed, 0.99) : null, wall, wall + u.parapet);
  if (canopyD > 0) add('canopy', bandFrom(frontEdge, canopyD), 0, wall * 0.62);
  if (u.plant > 0 && shed) add('plant', shrink(shed, 0.34), wall + (u.parapet || 0), wall + (u.parapet || 0) + u.plant);
  // Loading bays, as marks on the yard.
  if (dockD > 0) {
    const docks = u.docks || Math.max(1, Math.min(4, Math.round(W / 12)));
    for (let i = 0; i < docks; i++) {
      const a2 = uMin + (W * (i + 0.5)) / docks;
      lines.push({ role: 'dockline', a: world(a2 - 1.6, backEdge), b: world(a2 + 1.6, backEdge) });
    }
  }
  // Shopfront glazing.
  if (u.bay > 0 && canopyD > 0) {
    const bays = Math.max(2, Math.round(W / u.bay));
    for (let i = 1; i < bays; i++) {
      const a2 = uMin + (W * i) / bays;
      lines.push({ role: 'mullion', a: world(a2, frontEdge), b: world(a2, frontEdge - front * canopyD) });
    }
  }
  return { use: u.key, units: 1, height: wall + (u.parapet || 0) + (u.plant || 0), areas, lines };
}
