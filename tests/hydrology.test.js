/* Hydrology + State + Scoring smoke test. Run: node tests/hydrology.test.js */
const fs = require('fs'), path = require('path');
const { load, assert, noNaN, ROOT } = require('./load');

const FILES = ['src/sim/state.js', 'src/sim/hydrology.js', 'src/sim/scoring.js'];
const hasTerrain = fs.existsSync(path.join(ROOT, 'src/world/terrain.js'));
let WS, ctx;
try { ({ WS, ctx } = load(hasTerrain ? ['src/world/terrain.js'].concat(FILES) : FILES)); }
catch (e) { console.log('note: terrain.js failed to load (' + e.message + '); using stub world'); ({ WS, ctx } = load(FILES)); }
const C = WS.C, L = C.LAND, N = C.N;

/* ---- stub world: 128x128 typed arrays with a plausible layout ---- */
function makeStubWorld(seed) {
  const rng = WS.RNG.create('stub:' + seed), noise = WS.Noise.create('stubnoise:' + seed);
  const NN = N * N;
  const elev = new Float32Array(NN), land = new Uint8Array(NN), fuel = new Float32Array(NN), moisture = new Float32Array(NN), burn = new Float32Array(NN);
  const treeDensity = new Float32Array(NN), cropHealth = new Float32Array(NN), habitat = new Float32Array(NN), zone = new Int16Array(NN).fill(-1);
  const resCells = [], farmCells = [], forestCells = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const d = Math.hypot(x - 53, y - 61);
    elev[i] = 3700 - 12 * (x + y) / 2 + 60 * noise.fbm(x / 20, y / 20, 3);
    let t = L.SHRUB;
    if (d < 8) t = L.RESERVOIR;
    else if (x < 22 && y < 18) t = L.ALPINE;
    else if (x < 60 && y < 50) t = L.FOREST;
    else if (x > 66 && x < 96 && y > 58 && y < 92) t = ((x % 9 === 0) || (y % 9 === 0)) ? L.ROAD : L.RESIDENTIAL;
    else if (y > 98 && x > 36 && x < 112) t = L.FARM;
    else if (x > 62 && x < 70 && y > 76 && y < 83) t = L.WETLAND;
    else if (Math.abs(x - y - 0) < 1.5 && x > 60) t = L.RIVER;
    land[i] = t;
    const n1 = 0.5 + 0.5 * noise.fbm(x / 9, y / 9, 3);
    if (t === L.FOREST) { fuel[i] = 0.45 + 0.4 * n1; treeDensity[i] = 0.35 + 0.65 * n1; moisture[i] = 0.6; forestCells.push(i); }
    else if (t === L.SHRUB) { fuel[i] = 0.3 + 0.2 * n1; moisture[i] = 0.45; }
    else moisture[i] = 0.45;
    if (t === L.FARM) { cropHealth[i] = 0.85; farmCells.push(i); }
    if (t === L.RESERVOIR) resCells.push(i);
    habitat[i] = (t === L.SHRUB || t === L.RIPARIAN || t === L.WETLAND) ? 0.5 + 0.4 * n1 : (t === L.FOREST ? 0.4 : 0.05);
  }
  const zones = [];
  const names = ['Cameron Ridge', 'Troublesome Bench', 'North Fork Slopes', 'Kestrel Divide', 'Ponderosa Flats', 'Roaring Gulch'];
  for (let k = 0; k < 6; k++) {
    const cells = forestCells.filter((i, j) => j % 6 === k);
    zones.push({ id: k, type: 'forest', name: names[k], cells: Int32Array.from(cells), center: { x: 30, y: 25 }, upstreamOfReservoir: k < 4, bbox: { x0: 0, y0: 0, x1: 60, y1: 50 } });
    for (const i of cells) zone[i] = k;
  }
  const hoods = ['Marshall Heights', 'Old Mill', 'Riverbend', 'Sagebrush Estates'];
  for (let k = 0; k < 4; k++) {
    const cells = [];
    for (let i = 0; i < NN; i++) if (land[i] === L.RESIDENTIAL && (i % 4) === k) cells.push(i);
    zones.push({ id: 6 + k, type: 'neighborhood', name: hoods[k], cells: Int32Array.from(cells), center: { x: 80, y: 75 }, upstreamOfReservoir: false, bbox: { x0: 66, y0: 58, x1: 96, y1: 92 } });
  }
  const farms = ['Lazy J Ranch', 'Two Rivers Farm', 'Hay Meadows Co-op', 'Orchard Bench'];
  for (let k = 0; k < 4; k++) {
    const cells = farmCells.filter((i, j) => j % 4 === k);
    zones.push({ id: 10 + k, type: 'farm', name: farms[k], cells: Int32Array.from(cells), center: { x: 70, y: 110 }, upstreamOfReservoir: false, bbox: { x0: 36, y0: 98, x1: 112, y1: 127 } });
  }
  const cap = C.HYDRO.RESERVOIR_CAPACITY_AF;
  const world = {
    seed, N, cellM: C.CELL_M, elev, land, slope: new Float32Array(NN).fill(0.2), aspect: new Float32Array(NN), fuel, moisture, burn, treeDensity, cropHealth, habitat,
    flowDir: new Int32Array(NN).fill(-1), flowAcc: new Float32Array(NN), zone, zones,
    river: { path: [{ x: 12, y: 10 }, { x: 53, y: 61 }, { x: 118, y: 124 }], widths: new Float32Array(3), damIndex: 1, cellsAbove: new Int32Array(0), cellsBelow: new Int32Array(0) },
    reservoir: { cells: Int32Array.from(resCells), depth: new Float32Array(resCells.length).fill(20), bedElev: 2100, spillElev: 2130, capacityAF: cap,
      dam: { x: 60, y: 66 }, intake: { x: 58, y: 64 }, center: { x: 53, y: 61 },
      levelForStorage: af => 2100 + 30 * Math.sqrt(Math.max(0, af) / cap), areaForStorage: af => resCells.length * Math.pow(Math.max(0, af) / cap, 0.6), zoneId: -1 },
    wetland: { cells: new Int32Array(0), zoneId: -1, center: { x: 66, y: 79 } }, buildings: [], roads: [], snowlineElev: 2600, treeline: 3450,
    idx: (x, y) => y * N + x, xy: i => ({ x: i % N, y: (i / N) | 0 }), inBounds: (x, y) => x >= 0 && y >= 0 && x < N && y < N,
    cellsOf: t => { const o = []; for (let i = 0; i < NN; i++) if (land[i] === t) o.push(i); return Int32Array.from(o); },
    zoneById: id => zones.find(z => z.id === id) || null, zonesOf: t => zones.filter(z => z.type === t),
    isUpstreamOfReservoir: i => (i % N) < 62 && ((i / N) | 0) < 56,
    summary: () => ({ forest: forestCells.length, farm: farmCells.length, reservoir: resCells.length })
  };
  return world;
}
function makeWorld(seed) {
  if (WS.World && typeof WS.World.generate === 'function') { try { const w = WS.World.generate(seed); if (w && w.land && w.land.length === N * N) return w; } catch (e) { console.log('note: World.generate threw (' + e.message + '); using stub'); } }
  return makeStubWorld(seed);
}
const eps = 1e-6;
function stepSeason(state, world, rng) {
  WS.Hydrology.generateSeasonClimate(state, world, rng.fork('climate' + state.turn));
  WS.Hydrology.computeDemands(state, world);
  WS.Hydrology.computeAvailable(state, world);
  const rep = WS.Hydrology.runSeason(state, world, rng.fork('season' + state.turn));
  const sc = WS.Scoring.updateOutcomes(state, world, rep, {});
  WS.State.pushHistory(state, world);
  state.turn++; state.year = 1 + Math.floor(state.turn / 4); state.season = state.turn % 4;
  return { rep, sc };
}
function stripFns(v, seen = new Set()) {
  if (v == null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (ArrayBuffer.isView(v)) return Array.from(v);
  if (Array.isArray(v)) return v.map(x => stripFns(x, seen));
  const o = {}; for (const k of Object.keys(v)) { if (typeof v[k] === 'function') continue; o[k] = stripFns(v[k], seen); } return o;
}
function deepEq(a, b, p = '') {
  a = stripFns(a); b = stripFns(b);
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { let i = 0; while (i < ja.length && ja[i] === jb[i]) i++; throw new Error('mismatch near: ' + ja.slice(Math.max(0, i - 60), i + 60) + ' vs ' + jb.slice(Math.max(0, i - 60), i + 60)); }
  return true;
}

/* ---- 1. multi-seed simulation ---- */
const SEASONS = 32;
let annualInflows = [];
for (let seed = 1; seed <= 5; seed++) {
  const world = makeWorld(seed);
  const state = WS.State.create({ seed, years: 8, mode: 'simulated' });
  const rng = WS.RNG.create(seed);
  let yearIn = 0, springIn = 0, annual = [], springs = [];
  for (let t = 0; t < SEASONS; t++) {
    const { rep, sc } = stepSeason(state, world, rng);
    noNaN(state, 'state[seed ' + seed + ' turn ' + t + ']');
    noNaN(rep, 'report'); noNaN(sc, 'scoring');
    const cap = state.reservoir.capacityAF;
    if (!(state.reservoir.storageAF >= 0 && state.reservoir.storageAF <= cap * 1.15)) throw new Error('storage out of bounds: ' + state.reservoir.storageAF);
    for (const k of C.OUTCOME_KEYS) if (!(state.outcomes[k] >= 0 && state.outcomes[k] <= 100)) throw new Error('outcome ' + k + ' out of range');
    const d = state.water.demands;
    for (const k of C.SECTORS) { if (!(d[k] >= 0)) throw new Error('negative demand ' + k); if (k !== 'farms' && !(d[k] > 0)) throw new Error('zero demand ' + k); }
    if (rep.season !== C.SEASON.WINTER && !(d.farms > 0)) throw new Error('farm demand zero outside winter');
    const committed = rep.consumptiveAF + rep.releaseAF + rep.fireReserveAF;
    if (committed > rep.availableAF + 1 + eps) throw new Error('over-allocated: ' + committed + ' > ' + rep.availableAF);
    if (rep.outflowAF - rep.spillAF > rep.availableAF + 1 + eps) throw new Error('outflow exceeds available');
    for (const k of C.SECTORS) if (rep.deliveries[k] > d[k] + eps) throw new Error('delivered > requested for ' + k);
    if (rep.legalOverride) throw new Error('legalOverride with full alloc');
    if (sc.reasons.length !== 5 || sc.reasons.some(r => typeof r.text !== 'string' || !/\d/.test(r.text))) throw new Error('reasons must be 5 sentences with numbers');
    if (rep.season === C.SEASON.SPRING) springIn = rep.inflowAF;
    yearIn += rep.inflowAF;
    if (rep.season === C.SEASON.FALL) { annual.push(yearIn); springs.push(springIn / yearIn); yearIn = 0; }
  }
  annualInflows.push({ seed, annual, springShare: springs.map(s => Math.round(s * 100)) });
  assert(state.history.length === SEASONS, 'seed ' + seed + ': ' + SEASONS + ' seasons simulated; final storage ' + state.reservoir.storageAF + ' AF, R=' + state.resilience + ', outcomes ' + JSON.stringify(state.outcomes));
}
console.log('calibration — annual inflow AF by seed/year:', JSON.stringify(annualInflows.map(a => ({ seed: a.seed, annual: a.annual.map(Math.round), springSharePct: a.springShare }))));
const allAnnual = [].concat(...annualInflows.map(a => a.annual));
const medianAnnual = allAnnual.slice().sort((a, b) => a - b)[Math.floor(allAnnual.length / 2)];
assert(medianAnnual > 20000 && medianAnnual < 50000, 'median annual inflow plausible: ' + Math.round(medianAnnual) + ' AF (normal-year model value ' + Math.round(WS.Hydrology.NORMAL_ANNUAL_INFLOW_AF) + ' AF)');
{
  const normalSpring = WS.Hydrology.normalSeasonInflow(1) / WS.Hydrology.NORMAL_ANNUAL_INFLOW_AF;
  assert(normalSpring > 0.5 && normalSpring < 0.72, 'spring carries ~60% of a normal year (' + Math.round(normalSpring * 100) + '%)');
}

/* ---- 2. forced low snowpack → household shortage ---- */
{
  const world = makeStubWorld(99);
  const state = WS.State.create({ seed: 99, years: 4 });
  const rng = WS.RNG.create(99);
  state.reservoir.storageAF = C.HYDRO.RESERVOIR_DEAD_POOL_AF + 500;
  let anyShort = false, maxShort = 0;
  for (let t = 0; t < 12; t++) {
    WS.Hydrology.generateSeasonClimate(state, world, rng.fork('c' + t));
    state.climate.snowpackPct = 12; state.climate.model.snowYear = 12; state.climate.precipIn = 0.2; state.climate.tempAnomF = 6; state.climate.droughtIndex = -1.2; state.climate.drought = 'D4';
    WS.Hydrology.computeDemands(state, world); WS.Hydrology.computeAvailable(state, world);
    const rep = WS.Hydrology.runSeason(state, world, rng.fork('s' + t));
    noNaN(state, 'lowsnow state'); noNaN(rep, 'lowsnow report');
    if (rep.shortagePct.households > 0) { anyShort = true; maxShort = Math.max(maxShort, rep.shortagePct.households); }
    WS.Scoring.updateOutcomes(state, world, rep, {});
    state.turn++; state.year = 1 + Math.floor(state.turn / 4); state.season = state.turn % 4;
  }
  assert(anyShort, 'forced 12% snowpack at dead pool produced a household shortage (max ' + Math.round(maxShort * 100) + '%)');
  assert(state.outcomes.W < 60, 'water security fell under sustained drought (W=' + state.outcomes.W + ')');
}

/* ---- 3. burn scar increases runoff and turbidity vs. same climate unburned ---- */
{
  const wA = makeStubWorld(5), wB = makeStubWorld(5);
  for (let i = 0; i < N * N; i++) if (wB.isUpstreamOfReservoir(i) && (wB.land[i] === L.FOREST || wB.land[i] === L.SHRUB)) wB.burn[i] = 0.7;
  const mk = () => { const s = WS.State.create({ seed: 5 }); s.turn = 1; s.season = 1; s.year = 1; return s; };
  const sA = mk(), sB = mk();
  const rng = WS.RNG.create(5);
  WS.Hydrology.generateSeasonClimate(sA, wA, WS.RNG.create('x')); WS.Hydrology.generateSeasonClimate(sB, wB, WS.RNG.create('x'));
  sB.climate.snowpackPct = sA.climate.snowpackPct; sB.climate.model.snowYear = sA.climate.model.snowYear; sB.climate.precipIn = sA.climate.precipIn; sB.climate.tempAnomF = sA.climate.tempAnomF; sB.climate.soilMoisturePct = sA.climate.soilMoisturePct;
  WS.Hydrology.computeDemands(sA, wA); WS.Hydrology.computeDemands(sB, wB);
  WS.Hydrology.computeAvailable(sA, wA); WS.Hydrology.computeAvailable(sB, wB);
  const rA = WS.Hydrology.runSeason(sA, wA, rng.fork('a')), rB = WS.Hydrology.runSeason(sB, wB, rng.fork('b'));
  assert(rB.inflowAF > rA.inflowAF, 'burn scar raises spring inflow (' + rA.inflowAF + ' → ' + rB.inflowAF + ' AF)');
  assert(rB.turbidity > rA.turbidity, 'burn scar raises turbidity (' + rA.turbidity + ' → ' + rB.turbidity + ')');
  assert(rB.notes.some(n => /burn scar/i.test(n)), 'report notes mention the burn scar');
}

/* ---- 4. legal seniority ---- */
{
  const world = makeStubWorld(3), state = WS.State.create({ seed: 3 }), rng = WS.RNG.create(3);
  WS.Hydrology.generateSeasonClimate(state, world, rng); WS.Hydrology.computeDemands(state, world); WS.Hydrology.computeAvailable(state, world);
  state.water.alloc.tribal = 0; state.water.alloc.downstream = 0.3;
  const trustBefore = state.trustDelta;
  const rep = WS.Hydrology.runSeason(state, world, rng);
  assert(rep.legalOverride === true, 'under-allocating senior rights sets legalOverride');
  assert(rep.deliveries.tribal === state.water.demands.tribal && rep.deliveries.downstream === state.water.demands.downstream, 'tribal and downstream delivered in full anyway (' + rep.deliveries.tribal + ' / ' + rep.deliveries.downstream + ' AF)');
  assert(state.trustDelta < trustBefore, 'trust delta accumulated negative (' + state.trustDelta + ')');
  const sc = WS.Scoring.updateOutcomes(state, world, rep, {});
  assert(sc.delta.T < 0 && state.trustDelta === 0, 'Scoring consumed trustDelta (T ' + sc.delta.T + ')');
  // non-consumptive: release equals the largest non-consumptive delivery, not their sum
  const nonc = Math.max(rep.deliveries.downstream, rep.deliveries.wildlife, rep.deliveries.hydro, rep.deliveries.recreation);
  assert(Math.abs(rep.releaseAF - nonc) <= 1, 'non-consumptive sectors share one release (' + rep.releaseAF + ' AF = max of ' + nonc + ')');
}

/* ---- 5. contaminate ---- */
{
  const world = makeStubWorld(4), state = WS.State.create({ seed: 4 });
  const t0 = state.reservoir.turbidity, a0 = state.reservoir.ashContam;
  const res = WS.Hydrology.contaminate(state, world, 18000, 0.6);
  noNaN(res, 'contaminate');
  assert(res.turbidityDelta > 0 && state.reservoir.turbidity > t0 && state.reservoir.ashContam > a0, 'contaminate raised turbidity by ' + res.turbidityDelta + ' and ash by ' + res.ashDelta + ' (' + res.outageDays + ' outage days)');
  assert(res.outageDays > 0 && state.stats.contaminationOutageDays === res.outageDays, 'big sediment slug causes a treatment outage');
  const small = WS.Hydrology.contaminate(WS.State.create({ seed: 4 }), world, 150, 0.2);
  assert(small.turbidityDelta > 0 && small.turbidityDelta < 0.05 && small.outageDays === 0, 'small slug: tiny delta, no outage (' + small.turbidityDelta + ')');
  const st2 = WS.State.create({ seed: 4 }); st2.mitigations = [{ type: 'intake_protect', x: 58, y: 64 }, { type: 'sensor', x: 50, y: 50 }];
  const prot = WS.Hydrology.contaminate(st2, world, 18000, 0.6);
  assert(prot.turbidityDelta < res.turbidityDelta && prot.outageDays < res.outageDays, 'intake protection + sensor reduce impact (' + prot.turbidityDelta + ', ' + prot.outageDays + ' days)');
  assert(isFinite(WS.Hydrology.contaminate(null, null, NaN, NaN).turbidityDelta), 'contaminate is defensive with bad input');
}

/* ---- 6. serialize / deserialize ---- */
{
  const world = makeStubWorld(7), state = WS.State.create({ seed: 7, years: 6 }), rng = WS.RNG.create(7);
  for (let t = 0; t < 6; t++) stepSeason(state, world, rng);
  WS.State.log(state, 'hello', 'good'); WS.State.schedule(state, 2, 'test', { type: 'budget', key: 'budget', value: 1.5, text: 'grant' });
  state.fire.activeFire = { burning: new Int32Array([1, 2, 3]) };
  state.flags.someTyped = new Float32Array([1.5, 2.5]);
  const str = WS.State.serialize(state);
  assert(typeof str === 'string' && str.length > 100, 'serialize returns a string (' + str.length + ' chars)');
  const back = WS.State.deserialize(str);
  state.fire.activeFire = null;
  deepEq(state, back);
  assert(true, 'serialize/deserialize round-trips deep-equal (typed arrays and functions handled)');
  assert(back.flags.someTyped instanceof ctx.Float32Array || ArrayBuffer.isView(back.flags.someTyped), 'typed arrays revive as typed arrays');
  const old = WS.State.deserialize(JSON.stringify({ seed: 11, turn: 5, outcomes: { W: 50 }, reservoir: { storageAF: 1e9 }, climate: { snowpackPct: NaN } }));
  noNaN(old, 'old save');
  const def = WS.State.create({ seed: 11 });
  for (const k of Object.keys(def)) if (!(k in old)) throw new Error('missing top-level key after deserialize: ' + k);
  for (const k of Object.keys(def.climate)) if (!(k in old.climate)) throw new Error('missing climate key: ' + k);
  for (const k of Object.keys(def.water)) if (!(k in old.water)) throw new Error('missing water key: ' + k);
  assert(old.year === 2 && old.season === 1 && old.outcomes.E === 65 && old.reservoir.storageAF <= old.reservoir.capacityAF * 1.2 && old.water.alloc.households === 1, 'old/partial save gets defaults filled and clamped');
  assert(WS.State.deserialize('not json').seed === 1, 'garbage input → default state');
}

/* ---- 7. historical mode ---- */
{
  const world = makeStubWorld(8), state = WS.State.create({ seed: 8, years: 12, mode: 'historical' }), rng = WS.RNG.create(8);
  const peaks = [];
  for (let t = 0; t < 48; t++) { const { rep } = stepSeason(state, world, rng); if (rep.season === C.SEASON.SPRING) peaks.push(state.climate.snowpackPct); }
  noNaN(state, 'historical state');
  assert(WS.Hydrology.HISTORICAL.values.length === 12 && /approximate/i.test(WS.Hydrology.HISTORICAL.note), 'HISTORICAL has 12 values and an "approximate" note');
  const close = peaks.filter((p, i) => Math.abs(p - WS.Hydrology.HISTORICAL.values[i % 12]) < 16).length;
  assert(close >= 10, 'historical mode tracks the record (' + close + '/12 years within ±15%: ' + peaks.join(',') + ')');
  assert(/Historical/.test(state.climate.description), 'historical description labels the year');
}

/* ---- 8. grade / finalSummary / defensive calls ---- */
{
  assert(WS.Scoring.grade(95).letter === 'A' && WS.Scoring.grade(72).letter === 'C' && WS.Scoring.grade(NaN).letter === 'F', 'grade() letters');
  assert(Math.abs(WS.Scoring.resilience({ W: 100, E: 100, P: 100, F: 100, T: 100 }) - 100) < 1e-9, 'resilience of all-100 is 100');
  const world = makeStubWorld(2), state = WS.State.create({ seed: 2 }), rng = WS.RNG.create(2);
  for (let t = 0; t < 8; t++) stepSeason(state, world, rng);
  const fs2 = WS.Scoring.finalSummary(state);
  noNaN(fs2, 'finalSummary');
  assert(fs2.highlights.length >= 3 && fs2.lessons.length >= 2 && fs2.grade.letter, 'finalSummary has highlights/lessons/grade (' + fs2.grade.letter + ' ' + fs2.R + ')');
  const s0 = WS.State.create({});
  noNaN(WS.Hydrology.generateSeasonClimate(s0, null, null), 'climate without world');
  WS.Hydrology.computeDemands(s0, null); WS.Hydrology.computeAvailable(s0, null);
  const r0 = WS.Hydrology.runSeason(s0, null, null); noNaN(r0, 'runSeason without world'); noNaN(s0, 'state without world');
  noNaN(WS.Scoring.updateOutcomes(s0, null, r0, null), 'scoring without world');
  assert(true, 'all APIs run without a world or rng');
  const s1 = WS.State.create({ seed: 1 }); s1.turn = 2; s1.season = 2;
  WS.Hydrology.generateSeasonClimate(s1, world, WS.RNG.create(1));
  assert(s1.climate.uncertainty === 0.25, 'uncertainty is 0.25 without sensors (Projects absent)');
  const rep1 = WS.Hydrology.runSeason(s1, world, WS.RNG.create(1));
  assert(rep1.notes.length > 0 && rep1.notes.every(n => typeof n === 'string' && n.length > 10), 'report.notes are sentences: ' + JSON.stringify(rep1.notes[0]));
}
console.log('ALL PASS');
