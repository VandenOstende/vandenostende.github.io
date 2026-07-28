// ============================================================
// light.js — how much light lands here.
//
// Two sources, one question. The sun over a whole year (kWh/m²) and a lamp
// post at night (lux) are the same sum: a grid over the site, a source, and
// the question of whether a building stands in between. So they are one
// module, and the only real difference is what the source is and what the
// answer is measured in.
//
// Pure: no DOM, no canvas, no Mapbox. A light calculation deserves assertions
// that need no browser, and every number below is checked with bare Node.
// ============================================================

import { boundingBox, pointInPolygon, polyOf } from './geometry.js?v=8c2bb381';
import { sunPosition, momentUTC, buildingHeight, shadowPolys } from './sun.js?v=8c2bb381';

const RAD = Math.PI / 180;

// ------------------------------------------------------------
// The grid
// ------------------------------------------------------------

/**
 * Sample points on a regular grid inside a region, one per cell centre.
 *
 * Cells are anchored to the region's bounding box rather than to the world
 * origin, so the same site always samples the same way no matter where on
 * earth it sits.
 */
export function sampleGrid(region, step = 3) {
  if (!region || region.length < 3) return { step, pts: [] };
  const bb = boundingBox(region);
  const cols = Math.max(1, Math.ceil(bb.w / step));
  const rows = Math.max(1, Math.ceil(bb.h / step));
  const pts = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = { x: bb.minX + (i + 0.5) * step, y: bb.minY + (j + 0.5) * step };
      if (pointInPolygon(p, region)) pts.push(p);
    }
  }
  return { step, pts };
}

// ------------------------------------------------------------
// Occlusion
// ------------------------------------------------------------

const RAY_EPS = 1e-6;

/**
 * Does a building stand in the way of the light?
 *
 * The ray runs from `from` at height `hFrom` to `to` at height `hTo`, so its
 * height is linear in the parameter t. For each footprint it collects the
 * boundary crossings, pairs them into the runs where the ray is actually
 * *inside* the footprint, and asks whether the ray is still below the roof
 * when it leaves that run. If it is, it went into the building rather than
 * over it.
 *
 * Two things the interval walk buys, both of which a plain "does the segment
 * touch the outline" test gets wrong: a target standing in the courtyard of a
 * U-shaped building is lit if the ray cleared the near wing, and a source
 * standing inside a footprint is handled rather than assumed away. For a ray
 * that only descends the last exit is always the binding one, so the walk is
 * not cheaper than tracking min..max — it is written this way because it stays
 * correct if the two ends ever swap heights.
 */
export function rayBlocked(from, to, hFrom, hTo, obstacles) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const hAt = (t) => hFrom + (hTo - hFrom) * t;
  for (const o of (obstacles || [])) {
    const poly = polyOf(o);
    if (!poly || poly.length < 3) continue;
    const H = buildingHeight(o);
    // A building no taller than both ends of the ray can never be in the way.
    if (H <= Math.min(hFrom, hTo) + RAY_EPS) continue;

    const ts = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b.x - a.x, ey = b.y - a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;               // parallel
      const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / den;
      const u = ((a.x - from.x) * dy - (a.y - from.y) * dx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
    }
    if (!ts.length) {
      // No crossing: either wholly outside, or the whole ray is inside.
      if (pointInPolygon(from, poly) && hAt(1) < H - RAY_EPS) return true;
      continue;
    }
    ts.sort((a, b) => a - b);
    // Walk the crossings, tracking whether we are inside. Starting state comes
    // from the source end, so a lamp standing inside a building works too.
    let inside = pointInPolygon(from, poly);
    let enter = inside ? 0 : -1;
    for (const t of ts) {
      if (inside) {
        if (hAt(t) < H - RAY_EPS) return true;           // left below the roof
        inside = false;
      } else {
        enter = t;
        inside = true;
      }
    }
    // Still inside at the far end: the target itself stands under the building.
    if (inside && enter >= 0 && hAt(1) < H - RAY_EPS) return true;
  }
  return false;
}

// ------------------------------------------------------------
// Artificial light
// ------------------------------------------------------------

export const DEFAULT_POLE_H = 6;        // m, mounting height
export const DEFAULT_LUMENS = 12000;    // lm, a common LED road luminaire
export const DEFAULT_MF = 0.8;          // maintenance factor (dirt and ageing)

// Common design targets for a surface car park. Editable, and NOT a verified
// norm citation — required levels differ per country, per road authority and
// per surrounding land use.
export const LUX_TARGET = 10;
export const U0_TARGET = 0.25;

/**
 * Horizontal illuminance in lux at each point, summed over every pole.
 *
 * The source is treated as a point radiating uniformly into the lower
 * hemisphere, so its intensity is `lm / 2π` candela and the horizontal
 * illuminance follows the textbook `E = I·cos³γ / h²`.
 *
 * This is the first-pass hand calculation, not photometry. A real design reads
 * an IES intensity distribution per luminaire; without that file any
 * distribution would be invented, and the uniform hemisphere is at least the
 * one everybody recognises. The panel says so.
 */
export function illuminance(pts, poles, obstacles, opts = {}) {
  const mf = opts.maintenance == null ? DEFAULT_MF : opts.maintenance;
  const out = new Float32Array(pts.length);
  if (!poles || !poles.length) return out;
  for (const pole of poles) {
    const h = Math.max(0.5, pole.h || DEFAULT_POLE_H);
    const I = (pole.lumens || DEFAULT_LUMENS) / (2 * Math.PI);
    const top = { x: pole.x, y: pole.y };
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const d2 = (p.x - top.x) * (p.x - top.x) + (p.y - top.y) * (p.y - top.y);
      // cos γ = h / √(h² + d²); E = I·cos³γ / h² collapses to this.
      const cos = h / Math.sqrt(h * h + d2);
      const e = I * cos * cos * cos / (h * h) * mf;
      if (e < 0.01) continue;                             // below reading, skip the ray
      if (rayBlocked(top, p, h, 0, obstacles)) continue;
      out[i] += e;
    }
  }
  return out;
}

// ------------------------------------------------------------
// The sun over a year
// ------------------------------------------------------------

// The Klein representative days: the day of each month whose declination sits
// closest to the monthly mean, so twelve days stand in for three hundred.
const REP_DAY = [17, 16, 16, 15, 15, 11, 17, 16, 15, 15, 14, 10];
const MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Sun positions to integrate over, with the weight in days each one stands for.
 *
 * Twelve representative days sampled hourly — 288 positions instead of 8760.
 * How far that shortcut is off is measured against the full hour-by-hour year
 * rather than assumed; see the module's tests.
 */
export function sunSteps(lat, lon, opts = {}) {
  const year = opts.year || 2026;
  const perDay = opts.perDay || 24;
  const dt = 24 / perDay;
  const steps = [];
  for (let m = 0; m < 12; m++) {
    const date = `${year}-${String(m + 1).padStart(2, '0')}-${String(REP_DAY[m]).padStart(2, '0')}`;
    for (let k = 0; k < perDay; k++) {
      const sun = sunPosition(momentUTC(date, (k + 0.5) * dt, lon), lat, lon);
      if (sun.altitude <= 0) continue;                    // night contributes nothing
      steps.push({ sun, weight: MONTH_DAYS[m] * dt });    // days × hours = hours
    }
  }
  return steps;
}

const SOLAR_CONST = 1367;   // W/m²
const MAX_AM = 38;          // air mass at the horizon; past this it is night anyway
const MIN_SIN = 0.05;       // ≈ 3° — below this, dividing by sin(alt) is nonsense

/** Clear-sky irradiance on the horizontal, in W/m². Shape only — see below. */
function clearSky(altitude) {
  const s = Math.sin(altitude * RAD);
  if (s <= 0) return { ghi: 0, sin: 0 };
  const am = Math.min(MAX_AM, 1 / s);
  return { ghi: SOLAR_CONST * Math.pow(0.7, Math.pow(am, 0.678)) * s, sin: s };
}

// Annual diffuse share of GHI. Published BE/NL figures sit around 0.50–0.55;
// at the top of that range the model puts the optimum tilt for this latitude
// at 36°, which is where it belongs.
export const DEFAULT_DIFFUSE = 0.55;

/**
 * Split a calibrated hourly total into beam and diffuse.
 *
 * This is the second calibration, and it is not cosmetic. The clear-sky model
 * is beam-dominated — barely a tenth of it is diffuse — while a Belgian or
 * Dutch year is about half diffuse, because half of it is cloud. Scaling the
 * annual total onto a published figure fixes how *much* light arrives but
 * leaves that split untouched, and the split is exactly what decides how much
 * a tilt gains and how much a building costs. Left alone it puts the tilt gain
 * at three times life size.
 *
 * So the model supplies the shape over time, and two published climate numbers
 * — annual irradiation and annual diffuse fraction — supply both magnitudes.
 */
function split(ghi, sin, kd) {
  const dhi = ghi * kd;
  const bhi = ghi - dhi;
  return { ghi, dhi, bhi, sin, dni: bhi / Math.max(MIN_SIN, sin) };
}

/** Cosine of the incidence angle on a tilted plane. */
function cosIncidence(sun, tilt, azimuth) {
  const a = sun.altitude * RAD, b = tilt * RAD;
  return Math.sin(a) * Math.cos(b) +
    Math.cos(a) * Math.sin(b) * Math.cos((sun.azimuth - azimuth) * RAD);
}

/**
 * Irradiance on a tilted plane, Hay–Davies.
 *
 * The isotropic sky — every patch of it equally bright — is the obvious first
 * model and it is wrong in a way that shows up immediately here: it cannot
 * reproduce the gain from tilting. Measured against published yields for this
 * latitude it left 10° too high and 35° too low *at the same time*, and no
 * diffuse fraction fixes both, because the error is shape and not scale.
 *
 * Hay–Davies splits the diffuse into a circumsolar part, which comes from
 * around the sun and therefore behaves like beam, and an isotropic remainder.
 * The anisotropy index `Ai` is how clear the moment is. Three extra lines, and
 * both tilts land where the published figures put them.
 */
function poaTilted(sky, sun, tilt, azimuth, albedo) {
  const b = tilt * RAD;
  const cosB = Math.cos(b);
  const ci = Math.max(0, cosIncidence(sun, tilt, azimuth));
  const rb = ci / Math.max(MIN_SIN, sky.sin);
  const ai = Math.min(1, sky.dni / SOLAR_CONST);
  return {
    beam: sky.dni * ci,
    rest: sky.dhi * (ai * rb + (1 - ai) * (1 + cosB) / 2) +
      sky.ghi * albedo * (1 - cosB) / 2,
  };
}

export const DEFAULT_GHI = 1050;   // kWh/m²/yr on the horizontal, BE/NL

/**
 * The scale factor that ties the clear-sky model to a real climate.
 *
 * The model gives the *shape* — how much a tilt gains, how much a building
 * costs — but a cloudless year overstates the total badly. Normalising the
 * unshaded horizontal sum onto a published annual figure removes that error in
 * one move, and makes the calibration itself testable: an unshaded horizontal
 * point must read exactly the configured value.
 */
export function irradianceScale(steps, ghi = DEFAULT_GHI) {
  let model = 0;
  for (const s of steps) model += clearSky(s.sun.altitude).ghi * s.weight / 1000;
  return { scale: model > 0 ? ghi / model : 0, model };
}

/**
 * Annual irradiance on the horizontal ground at each point, in kWh/m²/yr.
 *
 * Buildings block the beam; the diffuse sky is left alone. A wall does take a
 * bite out of the sky dome too, but modelling that needs a view factor per
 * point, and pretending shade is black would be the bigger error of the two —
 * north-facing shade is not dark.
 */
export function annualIrradiance(pts, obstacles, opts = {}) {
  const steps = opts.steps || sunSteps(opts.lat || 51, opts.lon || 4, opts);
  const { scale } = irradianceScale(steps, opts.ghi == null ? DEFAULT_GHI : opts.ghi);
  const kd = opts.diffuse == null ? DEFAULT_DIFFUSE : opts.diffuse;
  const at = opts.atHeight || 0;
  const out = new Float32Array(pts.length);
  for (const st of steps) {
    const cs = clearSky(st.sun.altitude);
    // Calibrated W/m² first, hours applied after — the anisotropy index in the
    // tilted model is a ratio of irradiances and means nothing on an energy.
    const sky = split(cs.ghi * scale, cs.sin, kd);
    const w = st.weight / 1000;
    const beam = sky.bhi * w;
    const diff = sky.dhi * w;
    const shadows = (obstacles && obstacles.length) ? shadowPolys(obstacles, st.sun, at) : [];
    for (let i = 0; i < pts.length; i++) {
      let lit = true;
      if (shadows) {
        for (const sh of shadows) { if (pointInPolygon(pts[i], sh)) { lit = false; break; } }
      }
      out[i] += diff + (lit ? beam : 0);
    }
  }
  return out;
}

// ------------------------------------------------------------
// Solar carports
// ------------------------------------------------------------

export const DEFAULT_PV = {
  tilt: 10,          // ° — carports are laid nearly flat to keep the height down
  azimuth: 180,      // ° clockwise from north; 180 = due south
  density: 0.20,     // kWp per m² of canopy (≈ 200 W/m² module)
  perf: 0.80,        // performance ratio: inverter, wiring, heat, soiling
  height: 3.0,       // m — clearance under the canopy
  albedo: 0.2,
};

/**
 * What the canopies produce in a year.
 *
 * Sampled on the canopy surfaces themselves, so a canopy in the lee of a
 * building genuinely loses its beam while one in the open does not, and the
 * shading loss is a measured difference rather than a rule of thumb.
 */
export function canopyYield(canopies, obstacles, opts = {}) {
  const pv = { ...DEFAULT_PV, ...(opts.pv || {}) };
  const steps = opts.steps || sunSteps(opts.lat || 51, opts.lon || 4, opts);
  const { scale } = irradianceScale(steps, opts.ghi == null ? DEFAULT_GHI : opts.ghi);
  const step = opts.sample || 5;

  // Sample points and the area each one stands for.
  let area = 0;
  const pts = [];
  for (const c of (canopies || [])) {
    const poly = polyOf(c);
    if (!poly || poly.length < 3) continue;
    const g = sampleGrid(poly, step);
    area += polygonAreaOf(poly);
    for (const p of g.pts) pts.push(p);
  }
  if (!pts.length) {
    return { area: 0, kWp: 0, kWh: 0, specific: 0, shadeLoss: 0, poaOpen: 0 };
  }
  const cellArea = area / pts.length;   // spread the true area over the samples

  const kd = opts.diffuse == null ? DEFAULT_DIFFUSE : opts.diffuse;
  let poaSum = 0, poaOpen = 0;
  for (const st of steps) {
    const cs = clearSky(st.sun.altitude);
    const sky = split(cs.ghi * scale, cs.sin, kd);
    const w = st.weight / 1000;
    const p = poaTilted(sky, st.sun, pv.tilt, pv.azimuth, pv.albedo);
    const beam = p.beam * w, rest = p.rest * w;
    poaOpen += beam + rest;
    const shadows = (obstacles && obstacles.length) ? shadowPolys(obstacles, st.sun, pv.height) : [];
    for (const p of pts) {
      let lit = true;
      if (shadows) {
        for (const sh of shadows) { if (pointInPolygon(p, sh)) { lit = false; break; } }
      }
      poaSum += (rest + (lit ? beam : 0)) * cellArea;
    }
  }
  const poaAvg = poaSum / area;                        // kWh/m²/yr actually received
  const kWp = area * pv.density;
  const kWh = poaSum * pv.perf * pv.density;           // kWh/m² × m² × kWp/m² × PR
  return {
    area,
    kWp,
    kWh,
    specific: kWp > 0 ? kWh / kWp : 0,
    shadeLoss: poaOpen > 0 ? 1 - poaAvg / poaOpen : 0,
    poaOpen,
  };
}

// Local, so the module keeps its single geometry import small.
function polygonAreaOf(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

// ------------------------------------------------------------
// Reading the grid
// ------------------------------------------------------------

/**
 * Minimum, average, maximum and uniformity over a grid.
 *
 * `u0 = Emin / Eavg` is the ratio lighting design actually judges by: a bright
 * average with a black hole in it is a worse car park than an even dim one.
 * With nothing to average, everything is null rather than NaN — no lamps is an
 * empty state, not an answer.
 */
export function gridStats(values, mask) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; n++;
  }
  if (!n) return { min: null, avg: null, max: null, u0: null, n: 0 };
  const avg = sum / n;
  return { min, avg, max, u0: avg > 0 ? min / avg : 0, n };
}
