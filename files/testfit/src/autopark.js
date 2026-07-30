// ============================================================
// autopark.js — draw a zone, get a parking area.
//
// The site-wide solver answers "fill the whole parcel". This answers a different
// question: "put a car park *here*", where here is an outline you drew. Same
// solver underneath — the zone is simply handed to `solveParking` as if it were
// the site — plus everything that turns a field of rectangles into somewhere
// that looks like a real place: trees on the islands, grass on the verge, lamps
// along the aisles, markings on the tarmac, a way in.
//
// Pure, and deliberately so. It takes an outline and some options and returns
// plain objects; it does not know about React, the canvas, or the document. That
// is what lets the preview run on every mouse move and the commit reuse the
// identical call — what you saw while drawing is what lands, because it is the
// same function with the same arguments.
//
// The output is ordinary stalls and annotations, not a new kind of object. A
// generated tree is a tree: selectable, movable, deletable, exported, extruded
// in 3D, counted in the metrics. Nothing downstream needs to learn a new type,
// and nothing generated here is second-class.
// ============================================================

import {
  polygonArea, polygonCentroid, offsetPolygon, pointInPolygon, boundingBox,
  rectPoly, distPointToPolygonBoundary,
} from './geometry.js?v=fd27eff2';
import { solveParking, aisleAxis, STALL_TYPES } from './solver.js?v=fd27eff2';

/**
 * What the tool can add, in the order the panel lists it. `def` is whether it
 * starts ticked — the four the plan called for, plus the extras that make a zone
 * read as a place rather than a diagram, off by default so the first thing you
 * draw is not a surprise.
 */
export const DRESS_OPTIONS = [
  { id: 'green', label: 'Bomen en gras', def: true,
    desc: 'Bomen op de groeneilanden tussen de rijen, gras op de berm langs de rand.' },
  { id: 'light', label: 'Verlichting', def: true,
    desc: 'Lichtmasten langs de rijstroken. Voeden meteen de lux-kaart.' },
  { id: 'marks', label: 'Belijning en pictogrammen', def: true,
    desc: 'Pijlen op de rijstroken, rolstoel- en laadsymbolen in de vakken die dat zijn.' },
  { id: 'access', label: 'Ontsluiting', def: true,
    desc: 'Een toegangspunt met bord, en een voetpad langs de kopse kant.' },
  { id: 'bike', label: 'Fietsparking', def: false,
    desc: 'Een fietsenstalling bij de ingang; de capaciteit volgt uit het oppervlak.' },
  { id: 'solar', label: 'Zonnecarports', def: false,
    desc: 'Overkapping over de langste rijen. Levert meteen kWp en kWh per jaar.' },
  { id: 'crossing', label: 'Zebrapad', def: false,
    desc: 'Een oversteek over de hoofdrijstrook, op de looproute.' },
];
export const DRESS_DEFAULTS = Object.fromEntries(DRESS_OPTIONS.map((o) => [o.id, o.def]));

// Spacings. Common design values rather than a norm citation, like every other
// dimension in this app — and every one of them is a constant you can find.
const LAMP_SPACING = 22;    // m between lamp posts along an aisle
const TREE_SPACING = 14;    // m between verge trees
const VERGE = 2.5;          // m of grass inside the zone edge
const MIN_ZONE_AREA = 60;   // m² below which there is nothing worth generating
const BIKE_SIZE = 6;        // m, side of the bike parking square
const LAMP_HEIGHT = 6;      // m mounting height, the lightPole default

/** Points along a polygon's boundary, every `step` metres. */
function walkBoundary(poly, step) {
  const out = [];
  const n = poly.length;
  let carry = step / 2; // half a step in, so nothing lands exactly on a corner
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    let d = carry;
    while (d <= len) {
      out.push({ x: a.x + (dx / len) * d, y: a.y + (dy / len) * d, ux: dx / len, uy: dy / len });
      d += step;
    }
    carry = d - len;
  }
  return out;
}

/** The longest edge of a polygon, as { a, b, len, mid, ux, uy }. */
function longestEdge(poly) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || len > best.len) {
      best = { a, b, len, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        ux: (b.x - a.x) / (len || 1), uy: (b.y - a.y) / (len || 1) };
    }
  }
  return best;
}

/** Degrees, clockwise from north, for an annotation `angle`. */
const headingOf = (ux, uy) => ((Math.atan2(uy, ux) * 180) / Math.PI + 360) % 360;

/**
 * Generate a parking area inside `zone`.
 *
 * `zone`      — the outline, world metres, at least 3 points.
 * `ctx`       — { obstacles, params, entryFrom } — what to avoid, how to park,
 *               and a world point the zone should be reachable from (usually the
 *               nearest site corner). All optional.
 * `dress`     — the DRESS_OPTIONS toggles.
 *
 * Returns { stalls, annotations, metrics } where stalls are `{ poly, type }`
 * ready for `doc.manualStalls` and annotations are ready for `doc.annotations`.
 * Returns empty lists rather than throwing on a degenerate zone: this runs on
 * every mouse move while you are still drawing, and a two-point outline is a
 * normal thing to be halfway through, not an error.
 */
export function generateZone(zone, ctx = {}, dress = DRESS_DEFAULTS) {
  const empty = { stalls: [], annotations: [], metrics: { stalls: 0, area: 0 } };
  if (!zone || zone.length < 3) return empty;
  const area = Math.abs(polygonArea(zone));
  if (!(area >= MIN_ZONE_AREA)) return empty;

  const params = ctx.params || {};
  const obstacles = ctx.obstacles || [];
  // The zone is handed to the solver as its own site. The setback becomes the
  // verge: the strip the rows keep clear of the outline, which is exactly where
  // the grass and the trees want to be.
  const solveP = { ...params, setback: dress.green ? Math.max(params.setback || 0, VERGE) : (params.setback || 0) };

  let res;
  try { res = solveParking(zone, obstacles, solveP, 0); }
  catch (e) { return empty; }

  const stalls = (res.stalls || []).map((s) => ({ poly: s.poly, type: s.type }));
  if (!stalls.length) return { ...empty, metrics: { stalls: 0, area } };

  const annotations = [];
  const add = (a) => annotations.push(a);
  const inZone = (p) => pointInPolygon(p, zone);

  // ---- Green: trees on the islands, grass and trees on the verge ----
  if (dress.green) {
    for (const island of res.islands || []) {
      add({ kind: 'grass', points: island.map((p) => ({ ...p })), closed: true, width: 0 });
      const c = polygonCentroid(island);
      add({ kind: 'tree', points: [c], width: 3.5 });
    }
    // The verge as one band per edge, built from each edge's own inward normal.
    //
    // The obvious version — offset the whole outline and pair up the vertices —
    // is wrong in practice: `offsetPolygon` may return a different number of
    // points than it was given (a sharp corner collapses, a thin waist clips),
    // and any guard against that silently drops the grass on exactly the
    // hand-drawn outlines this tool exists for. An edge and its normal always
    // exist.
    //
    // Bands overlap slightly at the corners. That costs nothing and looks right:
    // grass is not counted as paved, so the double-count that would matter for
    // tarmac does not arise.
    const mid = polygonCentroid(zone);
    for (let i = 0; i < zone.length; i++) {
      const a = zone[i], b = zone[(i + 1) % zone.length];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      let nx = -dy / len, ny = dx / len;
      // Point it at the inside, whichever way this outline happens to wind.
      const ex = (a.x + b.x) / 2, ey = (a.y + b.y) / 2;
      if ((mid.x - ex) * nx + (mid.y - ey) * ny < 0) { nx = -nx; ny = -ny; }
      const band = [
        { x: a.x, y: a.y }, { x: b.x, y: b.y },
        { x: b.x + nx * VERGE, y: b.y + ny * VERGE },
        { x: a.x + nx * VERGE, y: a.y + ny * VERGE },
      ];
      if (Math.abs(polygonArea(band)) > 2) add({ kind: 'grass', points: band, closed: true, width: 0 });
      // The trees stand in that band, so they come off the same edge walk and
      // cannot end up somewhere the grass is not.
      const step = Math.max(TREE_SPACING, len / Math.max(1, Math.round(len / TREE_SPACING)));
      for (let d = step / 2; d < len; d += step) {
        add({ kind: 'tree', width: 4, points: [{
          x: a.x + (dx / len) * d + nx * (VERGE / 2),
          y: a.y + (dy / len) * d + ny * (VERGE / 2),
        }] });
      }
    }
  }

  // ---- Light: masts down the aisles ----
  if (dress.light) {
    for (const q of res.aisles || []) {
      const ax = aisleAxis(q);
      const n = Math.max(1, Math.floor(ax.length / LAMP_SPACING));
      for (let i = 0; i <= n; i++) {
        const t = (i / n - 0.5) * ax.length;
        const p = { x: ax.cx + ax.ux * t, y: ax.cy + ax.uy * t };
        if (inZone(p)) add({ kind: 'lightPole', points: [p], width: 1.2, value: LAMP_HEIGHT });
      }
    }
  }

  // ---- Markings: an arrow per aisle, a symbol in every special stall ----
  if (dress.marks) {
    for (const q of res.aisles || []) {
      const ax = aisleAxis(q);
      if (ax.length < 8) continue;
      add({ kind: 'arrowAhead', points: [{ x: ax.cx, y: ax.cy }], width: 3,
        angle: headingOf(ax.ux, ax.uy) });
    }
    for (const s of stalls) {
      const picto = s.type === 'ada' ? 'pictoAda' : s.type === 'ev' ? 'pictoEV' : null;
      if (!picto) continue;
      add({ kind: picto, points: [polygonCentroid(s.poly)], width: 2.4, angle: 0 });
    }
  }

  // ---- Access: a way in, a sign, and a path along the long edge ----
  const edge = longestEdge(zone);
  let entry = null;
  if (dress.access && edge) {
    // The point on the outline nearest wherever you are coming from, so the
    // entrance faces the rest of the site rather than the back fence.
    const from = ctx.entryFrom;
    let best = null;
    for (const p of walkBoundary(zone, 3)) {
      const d = from ? Math.hypot(p.x - from.x, p.y - from.y) : 0;
      if (!best || d < best.d) best = { p, d };
    }
    entry = best ? best.p : edge.mid;
    add({ kind: 'access', points: [{ x: entry.x, y: entry.y }], width: 6 });
    add({ kind: 'signParking', points: [{ x: entry.x, y: entry.y }], width: 1.6, angle: 0 });
    // A footway just inside the long edge, which is where people walk to get
    // from the parked car to whatever the car park serves.
    const inset = offsetPolygon(zone, VERGE + 1.5);
    if (inset && inset.length === zone.length) {
      const e = longestEdge(inset);
      if (e && e.len > 6) add({ kind: 'walkway', points: [{ x: e.a.x, y: e.a.y }, { x: e.b.x, y: e.b.y }], width: 1.8, curved: false });
    }
  }

  // ---- Extras ----
  if (dress.bike && entry) {
    // Just inside the entrance, pushed off the kerb so it does not sit in the
    // gateway itself.
    const c = polygonCentroid(zone);
    const dx = c.x - entry.x, dy = c.y - entry.y, len = Math.hypot(dx, dy) || 1;
    const at = { x: entry.x + (dx / len) * (BIKE_SIZE * 0.9), y: entry.y + (dy / len) * (BIKE_SIZE * 0.9) };
    if (inZone(at)) add({ kind: 'bikeparking', points: rectPoly(at.x - BIKE_SIZE / 2, at.y - BIKE_SIZE / 2, BIKE_SIZE, BIKE_SIZE), closed: true, width: 0 });
  }

  if (dress.solar) {
    // Over the rows, not over the aisles: a canopy adds no impervious area, so
    // this is free in the runoff figure and worth real money in the PV one.
    // One per aisle, covering the parked cars either side of it.
    const depth = (params.stallDepth || 5.5);
    for (const q of res.aisles || []) {
      const ax = aisleAxis(q);
      if (ax.length < 10) continue;
      const half = ax.length / 2, span = ax.width / 2 + depth;
      const nx = -ax.uy, ny = ax.ux;
      const corner = (s, t) => ({ x: ax.cx + ax.ux * half * s + nx * span * t, y: ax.cy + ax.uy * half * s + ny * span * t });
      add({ kind: 'carport', points: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], closed: true, width: 0 });
    }
  }

  if (dress.crossing && edge) {
    // Across the widest aisle, at its middle: the one place everyone walking to
    // the building has to cross traffic.
    let widest = null;
    for (const q of res.aisles || []) {
      const ax = aisleAxis(q);
      if (!widest || ax.length > widest.length) widest = ax;
    }
    if (widest) {
      const nx = -widest.uy, ny = widest.ux, half = widest.width / 2 + 1;
      add({ kind: 'crosswalk', width: 3.5, points: [
        { x: widest.cx - nx * half, y: widest.cy - ny * half },
        { x: widest.cx + nx * half, y: widest.cy + ny * half },
      ] });
    }
  }

  const spaces = stalls.reduce((n, s) => n + ((STALL_TYPES[s.type] || {}).spaces || 1), 0);
  return { stalls, annotations, metrics: { stalls: stalls.length, spaces, area, aisles: (res.aisles || []).length } };
}
