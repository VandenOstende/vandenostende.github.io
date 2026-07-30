#!/usr/bin/env node
// ============================================================
// selftest.js — assertions for the pure modules, under plain Node.
//
// The README has always claimed geometry.js, solver.js, drive.js, sun.js,
// light.js, buildings.js, share.js and autopark.js can be tested without a
// browser. This is that claim, executed. No dependencies and no framework:
// `node:assert/strict` and a counter.
//
// `tools/` is outside `hashOf()` in stamp.js, so adding this file changes no
// cache stamp. Run it with:
//
//   node tools/selftest.js
//
// What is here is not "coverage". It is the specific things that have been
// wrong, or that would be expensive to get wrong later: the nested-mix merge,
// the patch allowlist, the two definitions of m² per stall, the plausibility
// gate that used to pass layouts covering 1.8x the available ground, and the
// share budget that decides whether a variant may carry geometry.
// ============================================================
import assert from 'node:assert/strict';
import {
  solveParking, computeMetrics, computeBuildable, decorate, plausibility,
  applyPatch, sanitizePatch, buildSolveInput, expandSweep, stableStringify,
  fnv1a, longestEdgeAngle, VARY_AXES, ORIENT_KEY, axisValueLabel, axisOf,
} from '../src/solver.js';
import { polygonArea } from '../src/geometry.js';
import { shareable, encodeShare, decodeShare, MAX_SHARED_VARIANTS } from '../src/share.js';
import { generateZone, DRESS_OPTIONS, DRESS_DEFAULTS } from '../src/autopark.js';
import { PICTOS } from '../src/pictos.js';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n         ' + (e.message || e).split('\n')[0]); }
};

const P = {
  stallWidth: 2.7, stallDepth: 5.5, aisleWidth: 7.3, angle: 90, setback: 6, padding: 0.6,
  maxRun: 12, islandWidth: 0, compactRatio: 0, evRatio: 0.05, ada: true,
  mix: { compact: 0, ev: 0.05, staff: 0, visitor: 0, reserved: 0 },
  singleLoaded: false, deadEndTurnaround: false, turnaround: 7,
  layout: 'strip', endAisles: 'one', alignLongestEdge: false,
};
const DEMO = [{ x: 0, y: 0 }, { x: 96, y: 0 }, { x: 96, y: 60 }, { x: 0, y: 60 }];
const BUILDING = [{ poly: [{ x: 60, y: 36 }, { x: 96, y: 36 }, { x: 96, y: 60 }, { x: 60, y: 60 }], floors: 3 }];
const ngon = (r, n) => Array.from({ length: n }, (_, i) => {
  const a = (2 * Math.PI * i) / n;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
});
const solveAndDecorate = (site, obs, params) =>
  decorate(solveParking(site, obs, params, 0), { overrides: {}, manualStalls: [], params });

// ---------- applyPatch: the nested-mix trap ----------
await test('applyPatch merges mix rather than replacing it', () => {
  const out = applyPatch(P, { mix: { ev: 0.2 } });
  assert.equal(out.mix.ev, 0.2);
  assert.equal(out.mix.compact, 0, 'a patch naming one type must not wipe the rest');
  assert.equal(out.mix.reserved, 0);
});
await test('applyPatch leaves mix alone when the patch does not mention it', () => {
  assert.equal(applyPatch(P, { angle: 60 }).mix, P.mix, 'same reference — nothing to copy');
});
await test('applyPatch with an empty patch is a no-op', () => {
  assert.deepEqual(applyPatch(P, {}), P);
  assert.equal(applyPatch(P, null), P);
});

// ---------- sanitizePatch: a variant is a layout, not a settings vector ----------
await test('sanitizePatch keeps layout keys and drops everything else', () => {
  assert.deepEqual(
    sanitizePatch({ angle: 60, layout: 'hybrid', designVehicle: 'truck', sunHour: 9, pvTilt: 30, luxTarget: 50 }),
    { angle: 60, layout: 'hybrid' });
  assert.deepEqual(sanitizePatch(null), {});
  assert.deepEqual(sanitizePatch('nope'), {});
});

// ---------- decorate ----------
await test('decorate gives every aisle a poly AND a key', () => {
  const d = solveAndDecorate(DEMO, BUILDING, P);
  assert.ok(d.aisles.length > 0);
  for (const a of d.aisles) {
    assert.ok(a.poly, 'draw() reads .poly; a raw solver aisle is a bare quad');
    assert.ok(a.key, 'and .key — an undefined key compares equal to an undefined selection');
  }
});
await test('decorate honours removals and adds hand-placed stalls', () => {
  const raw = solveParking(DEMO, BUILDING, P, 0);
  const base = decorate(raw, { overrides: {}, manualStalls: [], params: P });
  const gone = base.stalls[0].key;
  const less = decorate(raw, { overrides: { removed: { [gone]: true } }, manualStalls: [], params: P });
  assert.equal(less.stalls.length, base.stalls.length - 1);
  const more = decorate(raw, { overrides: {}, params: P,
    manualStalls: [{ poly: [{ x: 200, y: 200 }, { x: 203, y: 200 }, { x: 203, y: 206 }, { x: 200, y: 206 }], type: 'ev' }] });
  assert.equal(more.stalls.length, base.stalls.length + 1);
  assert.equal(more.stalls[more.stalls.length - 1].manual, true);
});
await test('decorate applies a type override', () => {
  const raw = solveParking(DEMO, BUILDING, P, 0);
  const k = decorate(raw, { overrides: {}, manualStalls: [], params: P }).stalls[0].key;
  const d = decorate(raw, { overrides: { stalls: { [k]: 'reserved' } }, manualStalls: [], params: P });
  assert.equal(d.stalls.find((s) => s.key === k).type, 'reserved');
});

// ---------- the two m² per stall ----------
await test('areaPerStall is buildable-based, not site-based', () => {
  const d = solveAndDecorate(DEMO, BUILDING, P);
  const m = computeMetrics(DEMO, BUILDING, d, P, []);
  const buildable = polygonArea(computeBuildable(DEMO, P.setback));
  assert.ok(Math.abs(m.areaPerStall * m.physicalStalls - buildable) < 1e-6,
    'the compare table used to divide raw SITE area, which is a different number');
});
await test('total counts spaces, physicalStalls counts footprints', () => {
  const raw = solveParking(DEMO, BUILDING, P, 0);
  const d = decorate(raw, { overrides: {}, manualStalls: [], params: P });
  const plain = computeMetrics(DEMO, BUILDING, d, P, []);
  assert.equal(plain.total, plain.physicalStalls, 'no motorcycle stalls, so they agree');
  const k = d.stalls[0].key;
  const moto = decorate(raw, { overrides: { stalls: { [k]: 'motorcycle' } }, manualStalls: [], params: P });
  const mm = computeMetrics(DEMO, BUILDING, moto, P, []);
  assert.equal(mm.total, plain.total + 2, 'one motorcycle bay is three spaces');
});

// ---------- plausibility: the gate that used to pass 1.8x coverage ----------
await test('plausibility rejects the concentric layout on the demo site', () => {
  const p = { ...P, layout: 'perimeter' };
  const d = solveAndDecorate(DEMO, BUILDING, p);
  const pl = plausibility(d, DEMO, p);
  assert.ok(pl.packedRatio > 1.5, 'measured 1.80 — more asphalt than there is ground');
  assert.ok(pl.stallOverlaps > 0, 'measured 43 overlapping pairs');
  assert.equal(pl.plausible, false, 'and the old "20 m² per stall" gate passed it');
});
await test('plausibility accepts a clean strip pack', () => {
  const d = solveAndDecorate(DEMO, BUILDING, P);
  const pl = plausibility(d, DEMO, P);
  assert.ok(pl.packedRatio < 0.8);
  assert.equal(pl.stallOverlaps, 0);
  assert.equal(pl.plausible, true);
});
await test('plausibility demotes the hybrid layout on a 16-gon', () => {
  const site = ngon(150, 16);
  const p = { ...P, layout: 'hybrid' };
  const pl = plausibility(solveAndDecorate(site, [], p), site, p);
  assert.ok(pl.packedRatio > 1.05, 'the optimiser used to apply this one silently');
  assert.equal(pl.plausible, false);
});
await test('a clean pack on a near-circle sits just above 1, which is why the limit is 1.05', () => {
  const site = ngon(150, 16);
  const pl = plausibility(solveAndDecorate(site, [], P), site, P);
  assert.ok(pl.packedRatio > 0.95 && pl.packedRatio < 1.05,
    'the offset of a many-sided polygon is slightly generous; that is the tolerance, not slack');
});

// ---------- buildSolveInput: one definition of what the solver is asked ----------
await test('buildSolveInput aligns to the control points, not the tessellated ring', () => {
  const site = ngon(100, 6);
  const dense = ngon(100, 60); // what tessellation of a curved boundary looks like
  const inp = buildSolveInput({
    site, sitePoly: dense, obstacles: [], roadBlockers: [],
    params: { ...P, alignLongestEdge: true }, orientationIndex: 0, entries: [],
  });
  assert.equal(inp.params.alignAngle, longestEdgeAngle(site));
  assert.notEqual(inp.params.alignAngle, longestEdgeAngle(dense));
});
await test('buildSolveInput folds road blockers into obstacles but not into metrics', () => {
  const road = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 14 }, { x: 10, y: 14 }];
  const inp = buildSolveInput({
    site: DEMO, sitePoly: DEMO, obstacles: BUILDING, roadBlockers: [road],
    params: P, orientationIndex: 0, entries: [],
  });
  assert.equal(inp.obstacles.length, 2, 'the solver drives around roads');
  assert.equal(inp.metricObstacles.length, 1, 'but a road is not a building in the coverage figure');
});
await test('buildSolveInput carries the entrance hint and the row axis', () => {
  const inp = buildSolveInput({
    site: DEMO, sitePoly: DEMO, obstacles: [], roadBlockers: [],
    params: P, orientationIndex: 2, entries: [{ x: 0, y: 30 }],
  });
  assert.deepEqual(inp.params.entries, [{ x: 0, y: 30 }]);
  assert.equal(inp.orientationIndex, 2, 'both precursors hard-coded 0');
});
await test('buildSolveInput sanitises the patch it is given', () => {
  const inp = buildSolveInput({
    site: DEMO, sitePoly: DEMO, obstacles: [], roadBlockers: [],
    params: P, orientationIndex: 0, entries: [], patch: { angle: 45, designVehicle: 'truck' },
  });
  assert.equal(inp.params.angle, 45);
  assert.equal(inp.params.designVehicle, undefined, 'a layout patch cannot change the drivability check');
});

// ---------- the cache key ----------
await test('stableStringify ignores key order, including nested', () => {
  assert.equal(stableStringify({ a: 1, b: { x: 1, y: 2 } }), stableStringify({ b: { y: 2, x: 1 }, a: 1 }));
});
await test('fnv1a moves when a value moves', () => {
  assert.notEqual(fnv1a(stableStringify({ setback: 6 })), fnv1a(stableStringify({ setback: 7 })));
});

// ---------- sweep expansion ----------
await test('the seed is always first and always the empty patch', () => {
  const { jobs } = expandSweep([{ key: 'angle', values: [30, 45] }]);
  assert.equal(jobs[0].label, 'Huidig');
  assert.deepEqual(jobs[0].patch, {});
  assert.equal(jobs[0].orient, null);
});
await test('two axes make a cross product, capped, with the overflow reported', () => {
  const one = expandSweep([{ key: 'angle', values: [30, 45, 60] }]);
  assert.equal(one.jobs.length, 4); // seed + 3
  const big = expandSweep([{ key: 'angle', values: [30, 45, 60, 75, 90] },
    { key: 'stallWidth', values: [2.4, 2.5, 2.7, 3.0] }]);
  assert.equal(big.jobs.length, 12, 'the cap');
  assert.equal(big.dropped, 9, '20 combinations, eleven slots left after the seed');
});
await test('the row axis is routed out of the patch', () => {
  const { jobs } = expandSweep([{ key: ORIENT_KEY, values: [0, 1] }]);
  for (const j of jobs.slice(1)) {
    assert.deepEqual(j.patch, {}, 'it is a solve input, not a parameter');
    assert.equal(typeof j.orient, 'number');
  }
});
await test('duplicate combinations are solved once', () => {
  const { jobs } = expandSweep([{ key: 'angle', values: [60, 60, 60] }]);
  assert.equal(jobs.length, 2, 'seed plus one');
});
await test('every axis names a real key, and degrees close up against the number', () => {
  for (const a of VARY_AXES) assert.ok(a.key && a.values.length, a.key);
  assert.equal(axisValueLabel(axisOf('angle'), 60), '60°');
  assert.equal(axisValueLabel(axisOf('stallWidth'), 2.5), '2,5 m');
  assert.equal(axisValueLabel(axisOf('layout'), 'hybrid'), 'Rand+midden');
});

// ---------- share ----------
const shareDoc = (variants) => ({
  name: 'T', site: DEMO, siteCurved: false, obstacles: [], geo: { lat: 52, lon: 4 },
  params: P, orientationIndex: 0, autoParking: true, overrides: {}, annotations: [],
  junctions: {}, manualStalls: [], buildingStyles: [], variants,
});
const mkVars = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'v' + (i + 1), label: 'Hoek ' + (30 + i), patch: { layout: 'strip', angle: 30 + i }, gen: 'sweep:angle',
}));

await test('patch-only variants are affordable in a link', async () => {
  const code = async (n) => (await encodeShare({ _pp: 1, view: { scale: 6, ox: 0, oy: 0 },
    doc: shareable(shareDoc(mkVars(n))).doc })).length;
  const none = await code(0), eight = await code(8);
  assert.ok(eight - none < 250, `eight variants cost ${eight - none} chars — measured ~150`);
  assert.ok(eight < 900, 'well inside the documented budget for a whole plan');
});
await test('variants survive the round trip', async () => {
  const enc = await encodeShare({ _pp: 1, view: { scale: 6, ox: 0, oy: 0 },
    doc: shareable(shareDoc(mkVars(8))).doc });
  const back = await decodeShare(enc);
  assert.equal(back.doc.variants.length, 8);
  assert.deepEqual(back.doc.variants[0], mkVars(1)[0]);
});
await test('over the cap the extras are reported, not silently dropped', () => {
  const { doc, dropped } = shareable(shareDoc(mkVars(30)));
  assert.equal(doc.variants.length, MAX_SHARED_VARIANTS);
  assert.equal(dropped.variants, 30 - MAX_SHARED_VARIANTS);
});

// ---------- autopark ----------
await test('the zone generator makes grass on every outline shape', () => {
  const shapes = {
    'rectangle ccw': [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 25 }, { x: 0, y: 25 }],
    'rectangle cw': [{ x: 0, y: 25 }, { x: 40, y: 25 }, { x: 40, y: 0 }, { x: 0, y: 0 }],
    'L-shape': [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 20 }, { x: 25, y: 20 }, { x: 25, y: 40 }, { x: 0, y: 40 }],
    'skewed': [{ x: 0, y: 0 }, { x: 60, y: 2 }, { x: 58, y: 30 }, { x: 2, y: 26 }],
  };
  for (const [label, zone] of Object.entries(shapes)) {
    const g = generateZone(zone, { params: P }, DRESS_DEFAULTS);
    assert.ok(g.stalls.length > 0, label + ': expected bays');
    assert.ok(g.annotations.some((a) => a.kind === 'grass'),
      label + ': the verge used to vanish whenever offsetPolygon changed the vertex count');
    assert.ok(g.annotations.some((a) => a.kind === 'tree'), label + ': expected trees');
  }
});
await test('a degenerate zone returns nothing rather than throwing', () => {
  // This runs on every mouse move; half a polygon is a normal state to be in.
  for (const z of [null, [], [{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]]) {
    const g = generateZone(z, { params: P }, DRESS_DEFAULTS);
    assert.equal(g.stalls.length, 0);
    assert.equal(g.annotations.length, 0);
  }
});
await test('unticking everything leaves the bays and nothing else', () => {
  const zone = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
  const bare = generateZone(zone, { params: P }, {});
  assert.ok(bare.stalls.length > 0);
  assert.equal(bare.annotations.length, 0);
  const all = generateZone(zone, { params: P }, Object.fromEntries(DRESS_OPTIONS.map((o) => [o.id, true])));
  assert.ok(all.annotations.length > bare.annotations.length);
});

// ---------- painters ----------
await test('every picto draws inside its unit box', () => {
  const stub = () => {
    const pts = []; let ty = 0;
    return { pts, fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', font: '',
      textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0,
      beginPath() {}, closePath() {}, fill() {}, stroke() {}, save() {}, restore() {},
      scale() {}, rotate() {}, fillText() {}, ellipse() {}, drawImage() {},
      translate(x, y) { ty += y; },
      moveTo(x, y) { pts.push([x, y + ty]); }, lineTo(x, y) { pts.push([x, y + ty]); },
      arc(cx, cy, r) { pts.push([cx - r, cy - r + ty], [cx + r, cy + r + ty]); } };
  };
  for (const [name, painter] of Object.entries(PICTOS)) {
    const c = stub();
    painter(c, { value: 30 });
    for (const [x, y] of c.pts) {
      assert.ok(Math.abs(x) <= 1.001 && Math.abs(y) <= 1.001,
        `${name} draws at ${x.toFixed(2)},${y.toFixed(2)} — the caller scales by the unit box`);
    }
  }
});
await test('the arrow variants that carry no head are vertically centred', () => {
  const mid = (name) => {
    const pts = []; let ty = 0;
    const c = { pts, fillStyle: '', beginPath() {}, closePath() {}, fill() {}, stroke() {},
      save() {}, restore() {}, scale() {}, rotate() {}, translate(x, y) { ty += y; },
      moveTo(x, y) { pts.push(y + ty); }, lineTo(x, y) { pts.push(y + ty); },
      arc(cx, cy, r) { pts.push(cy - r + ty, cy + r + ty); } };
    PICTOS[name](c);
    return (Math.min(...pts) + Math.max(...pts)) / 2;
  };
  assert.ok(Math.abs(mid('arrowLeftRight')) < 0.05,
    'losing the head loses the top half; without recentring it sits low on the tarmac');
  assert.ok(Math.abs(mid('arrowAhead')) < 0.05);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
