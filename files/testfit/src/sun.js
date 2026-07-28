// ============================================================
// sun.js — where the sun is, and what it puts in shadow.
//
// Pure: no DOM, no Mapbox, no canvas. The 3D view uses it to aim its light and
// the 2D canvas uses it to draw the shadows itself, which is why it cannot
// depend on either — and why it can be checked against an almanac with bare
// Node.
// ============================================================

import { polyOf, pointInPolygon } from './geometry.js?v=8c2bb381';
import { BUILDING_USES, DEFAULT_USE } from './buildings.js?v=8c2bb381';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Solar azimuth and altitude in degrees for a moment and a place.
 *
 * `date` is a Date read in UTC. Azimuth is measured clockwise from north, the
 * convention Mapbox's directional light uses; altitude is degrees above the
 * horizon and goes negative at night.
 *
 * The usual low-precision almanac recipe (Julian day → mean longitude and
 * anomaly → ecliptic longitude → declination and equation of time → hour
 * angle). Good to a few arc-minutes, which is far past what a shadow on a
 * parking plan can show.
 */
export function sunPosition(date, lat, lon) {
  const t = date instanceof Date ? date : new Date(date);
  const jd = t.getTime() / 86400000 + 2440587.5;   // Unix epoch → Julian day
  const n = jd - 2451545.0;                        // days from J2000.0

  const meanLon = (280.460 + 0.9856474 * n) % 360;
  const meanAnom = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.020 * Math.sin(2 * meanAnom)) * RAD;
  const obliq = (23.439 - 0.0000004 * n) * RAD;

  const decl = Math.asin(Math.sin(obliq) * Math.sin(eclLon));
  const ra = Math.atan2(Math.cos(obliq) * Math.sin(eclLon), Math.cos(eclLon));

  // Greenwich mean sidereal time → local hour angle.
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = ((gmst * 15 + lon) % 360 + 360) % 360;
  const ha = (lst - ra * DEG) * RAD;

  const la = lat * RAD;
  const alt = Math.asin(Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha));
  // atan2 form, so the azimuth is right in every quadrant and at the poles.
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(la) - Math.tan(decl) * Math.cos(la));
  return {
    altitude: alt * DEG,
    azimuth: ((az * DEG + 180) % 360 + 360) % 360,   // 0 = north, clockwise
  };
}

/**
 * The mean solar clock offset for a longitude, in hours. A stand-in for a real
 * time zone: `doc.geo` is a latitude and a longitude and nothing else, so this
 * is the honest best guess. It does not know about summer time, and the UI has
 * to say so rather than imply otherwise.
 */
export const zoneOffsetHours = (lon) => Math.round((lon || 0) / 15);

/** A Date in UTC from a local date string, an hour, and a longitude. */
export function momentUTC(dateStr, hours, lon) {
  const [y, m, d] = String(dateStr || '2026-06-21').split('-').map(Number);
  const h = Math.floor(hours), mi = Math.round((hours - h) * 60);
  return new Date(Date.UTC(y || 2026, (m || 6) - 1, d || 21, h - zoneOffsetHours(lon), mi));
}

const MAX_SHADOW = 500;   // m — the sun near the horizon would otherwise cast
                          // a shadow the size of a province.

/** Height of a building in metres, the same way the 3D drape reckons it. */
export function buildingHeight(o) {
  const use = BUILDING_USES[(o && o.use) || DEFAULT_USE] || BUILDING_USES[DEFAULT_USE];
  const per = (use && use.floorH) || 3.5;
  return Math.max(per, ((o && o.floors) || 1) * per);
}

/**
 * Ground shadows as a list of polygons. Not ray tracing: each footprint edge is
 * swept along the ground direction of the sunlight by `height / tan(altitude)`,
 * and the footprint itself comes along. The pieces overlap, and that is fine —
 * see the two callers, neither of which needs a union.
 *
 * With the sun at or below the horizon there is no direction to sweep along, so
 * the answer is `null`: everything is in shadow, and saying that is different
 * from returning an empty list.
 *
 * `atHeight` asks the question on a plane above the ground — a carport roof,
 * say. Only the part of a building that stands above that plane can shade it,
 * so a building at or below it drops out entirely.
 */
export function shadowPolys(obstacles, sun, atHeight = 0) {
  if (!sun || sun.altitude <= 0) return null;
  const len = Math.min(MAX_SHADOW, 1 / Math.tan(sun.altitude * RAD));
  // The shadow points away from the sun. Azimuth is clockwise from north and y
  // grows downward, so north is -y: a sun in the south (180°) throws north.
  const a = (sun.azimuth + 180) * RAD;
  const ux = Math.sin(a), uy = -Math.cos(a);
  const out = [];
  for (const o of (obstacles || [])) {
    const poly = polyOf(o);
    if (!poly || poly.length < 3) continue;
    const above = buildingHeight(o) - atHeight;
    if (above <= 0) continue;                        // not tall enough to reach the plane
    const d = len * above;
    const dx = ux * d, dy = uy * d;
    out.push(poly.map((p) => ({ x: p.x, y: p.y })));
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      out.push([
        { x: p.x, y: p.y }, { x: q.x, y: q.y },
        { x: q.x + dx, y: q.y + dy }, { x: p.x + dx, y: p.y + dy },
      ]);
    }
  }
  return out;
}

/**
 * Which stalls stand in shadow. A point-in-any test, not a union — there is no
 * boolean polygon clipping in this project and this question does not need one.
 */
export function stallsInShadow(stalls, shadows, centroidOf) {
  if (shadows === null) return (stalls || []).map((s) => s.key);   // sun is down
  const out = [];
  for (const st of (stalls || [])) {
    const c = centroidOf(st.poly);
    for (const sh of shadows) {
      if (pointInPolygon(c, sh)) { out.push(st.key); break; }
    }
  }
  return out;
}
