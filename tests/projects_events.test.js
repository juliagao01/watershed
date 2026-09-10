/* Tests for WS.Projects and WS.Events. Run: node tests/projects_events.test.js */
const fs = require('fs'), path = require('path');
const { load, assert, noNaN, ROOT } = require('./load');

const exists = f => fs.existsSync(path.join(ROOT, f));
const files = [];
if (exists('src/world/terrain.js')) files.push('src/world/terrain.js');
if (exists('src/sim/state.js')) files.push('src/sim/state.js');
files.push('src/sim/projects.js', 'src/sim/events.js');
const { WS } = load(files);
const C = WS.C, N = C.N;

/* ------------------------------------------------------------------ stub world */
function makeStubWorld() {
  const size = N * N;
  const w = {
    seed: 1, N, cellM: C.CELL_M,
    elev: new Float32Array(size), land: new Uint8Array(size).fill(C.LAND.SHRUB), slope: new Float32Array(size), aspect: new Float32Array(size),
    fuel: new Float32Array(size), moisture: new Float32Array(size).fill(0.45), burn: new Float32Array(size), treeDensity: new Float32Array(size),
    cropHealth: new Float32Array(size), habitat: new Float32Array(size).fill(0.3), flowDir: new Int32Array(size).fill(-1), flowAcc: new Float32Array(size),
    zone: new Int16Array(size).fill(-1), zones: [], buildings: [], roads: [], snowlineElev: 2600, treeline: 3450
  };
  let id = 0;
  function rect(type, name, x0, y0, x1, y1, land, extra) {
    const cells = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = C.idx(x, y); cells.push(i); w.land[i] = land; w.zone[i] = id; }
    const z = Object.assign({ id, type, name, cells: Int32Array.from(cells), center: { x: (x0 + x1) >> 1, y: (y0 + y1) >> 1 }, bbox: { x0, y0, x1, y1 }, upstreamOfReservoir: false }, extra || {});
    w.zones.push(z); id++; return z;
  }
  const forestNames = ['Cameron Ridge', 'Troublesome Bench', 'North Fork Slopes', 'Kestrel Divide', 'Ponderosa Flats', 'Roaring Gulch'];
  forestNames.forEach((name, k) => {
    const x0 = 4 + (k % 3) * 22, y0 = 4 + Math.floor(k / 3) * 22;
    const z = rect('forest', name, x0, y0, x0 + 19, y0 + 19, C.LAND.FOREST, { upstreamOfReservoir: k < 4 });
    for (let c = 0; c < z.cells.length; c++) { w.fuel[z.cells[c]] = 0.65; w.treeDensity[z.cells[c]] = 0.7; w.moisture[z.cells[c]] = 0.6; }
  });
  ['Marshall Heights', 'Old Mill', 'Riverbend', 'Sagebrush Estates'].forEach((name, k) => rect('neighborhood', name, 80 + (k % 2) * 12, 60 + Math.floor(k / 2) * 12, 89 + (k % 2) * 12, 69 + Math.floor(k / 2) * 12, C.LAND.RESIDENTIAL));
  ['Lazy J Ranch', 'Two Rivers Farm', 'Hay Meadows Co-op', 'Orchard Bench'].forEach((name, k) => {
    const z = rect('farm', name, 70 + k * 14, 100, 81 + k * 14, 117, C.LAND.FARM);
    for (let c = 0; c < z.cells.length; c++) w.cropHealth[z.cells[c]] = 0.85;
  });
  const wet = rect('wetland', 'Willow Bottom', 66, 78, 73, 85, C.LAND.WETLAND);
  rect('civic', 'Downtown', 104, 60, 111, 65, C.LAND.CIVIC);
  const res = rect('reservoir', 'Bitterbrush Reservoir', 46, 54, 60, 68, C.LAND.RESERVOIR);
  w.wetland = { cells: wet.cells, zoneId: wet.id, center: wet.center };
  w.reservoir = {
    cells: res.cells, depth: new Float32Array(res.cells.length).fill(20), bedElev: 2100, spillElev: 2140, capacityAF: C.HYDRO.RESERVOIR_CAPACITY_AF,
    dam: { x: 61, y: 68 }, intake: { x: 59, y: 66 }, center: res.center, zoneId: res.id,
    levelForStorage: af => 2100 + 40 * Math.min(1, Math.max(0, af / C.HYDRO.RESERVOIR_CAPACITY_AF)),
    areaForStorage: af => Math.round(res.cells.length * Math.min(1, Math.max(0, af / C.HYDRO.RESERVOIR_CAPACITY_AF)))
  };
  w.buildings = [
    { type: 'fire_station', x: 106, y: 62, rot: 0, zoneId: 15, scale: 1 }, { type: 'fire_station', x: 84, y: 63, rot: 0, zoneId: 6, scale: 1 },
    { type: 'school', x: 108, y: 63, rot: 0, zoneId: 15, scale: 1 }, { type: 'hospital', x: 110, y: 64, rot: 0, zoneId: 15, scale: 1 },
    { type: 'town_hall', x: 105, y: 61, rot: 0, zoneId: 15, scale: 1 }, { type: 'treatment_plant', x: 62, y: 69, rot: 0, zoneId: -1, scale: 1 },
    { type: 'dam', x: 61, y: 68, rot: 0, zoneId: -1, scale: 1 }
  ];
  for (let k = 0; k < 40; k++) w.buildings.push({ type: 'house', x: 80 + (k % 20), y: 60 + Math.floor(k / 20) * 2, rot: 0, zoneId: 6 + (k % 4), scale: 1 });
  w.idx = C.idx; w.xy = C.xy; w.inBounds = C.inBounds;
  w.zonesOf = type => w.zones.filter(z => z.type === type);
  w.zoneById = zid => w.zones.find(z => z.id === zid) || null;
  w.cellsOf = l => { const out = []; for (let i = 0; i < size; i++) if (w.land[i] === l) out.push(i); return Int32Array.from(out); };
  w.isUpstreamOfReservoir = i => { const z = w.zone[i]; if (z >= 0) return !!w.zones[z].upstreamOfReservoir; const p = C.xy(i); return p.x < 60 && p.y < 60; };
  w.summary = () => ({ zones: w.zones.length, buildings: w.buildings.length });
  return w;
}

function makeState(opts) {
  opts = opts || {};
  if (WS.State && typeof WS.State.create === 'function') return WS.State.create({ seed: opts.seed || 7, years: 8, mode: 'simulated' });
  const sectors = {}; C.SECTORS.forEach(s => { sectors[s] = 0; });
  const alloc = {}; C.SECTORS.forEach(s => { alloc[s] = 1; });
  return {
    seed: opts.seed || 7, mode: 'simulated', years: 8, turn: 0, year: 1, season: 0, phase: 'plan',
    budget: 12, annualBudget: 12, emergencyFund: 0,
    outcomes: { W: 70, E: 65, P: 72, F: 68, T: 60 }, resilience: 0,
    population: 12400, growthRate: 0.012,
    climate: { snowpackPct: 100, snowSWEin: 18, precipIn: 3.2, tempAnomF: 0, soilMoisturePct: 45, fireDanger: 0.2, fireDangerLabel: 'Moderate', streamflowCfs: 60, windDirRad: 0.8, windMph: 8, drought: 'None', description: '', uncertainty: 0.15 },
    reservoir: { storageAF: 32000, capacityAF: 42000, turbidity: 0.05, ashContam: 0, algae: 0 },
    water: { demands: Object.assign({}, sectors), alloc, delivered: Object.assign({}, sectors), shortage: Object.assign({}, sectors), availableAF: 0, inflowAF: 0, outflowAF: 0, restriction: 'none' },
    fire: { policy: 'managed', activeFire: null, seasonAcres: 0, totalAcres: 0, structuresLost: 0, fires: [], smokeDays: 0 },
    projects: { funded: {}, pendingBurn: null },
    mitigations: [], pendingStorm: null, scheduled: [], log: [], timeline: [], history: [], unlockedCases: [], seenCases: [], flags: {},
    stats: { floodDamageM: 0, sedimentTons: 0, contaminationOutageDays: 0, cropLossPct: 0, hydroMWh: 0, recreationVisits: 0 },
    lastSeasonReport: null
  };
}
function makeWorld() {
  if (WS.World && typeof WS.World.generate === 'function') { try { return WS.World.generate(7); } catch (e) { /* fall back */ } }
  return makeStubWorld();
}
const zoneMeanFuel = (w, z) => { let s = 0; for (let k = 0; k < z.cells.length; k++) s += w.fuel[z.cells[k]]; return s / z.cells.length; };

/* ================================================================== PROJECTS */
const P = WS.Projects;
assert(P && Array.isArray(P.LIST), 'WS.Projects.LIST exists');
const REQUIRED_PROJECTS = ['streamgages', 'irrigation', 'leak_detection', 'forest_thinning', 'prescribed_burn', 'reservoir_upgrade', 'rain_capture', 'home_hardening', 'fuel_break', 'wetland', 'shelters', 'warning_system', 'outreach', 'treatment', 'stockpile', 'mussel_inspection', 'wildlife_corridor'];
const byId = {}; P.LIST.forEach(d => { byId[d.id] = d; });
REQUIRED_PROJECTS.forEach(id => {
  const d = byId[id];
  assert(!!d, 'project ' + id + ' present');
  ['name', 'icon', 'category', 'summary', 'detail', 'tradeoff'].forEach(k => assert(typeof d[k] === 'string' && d[k].length > 0, id + '.' + k + ' is a non-empty string'));
  assert(['monitor', 'water', 'fire', 'flood', 'community'].includes(d.category), id + ' has valid category');
  assert(typeof d.costM === 'number' && d.costM > 0 && typeof d.upkeepM === 'number' && d.upkeepM >= 0, id + ' has costM/upkeepM');
  assert(typeof d.maxLevel === 'number' && d.maxLevel >= 1, id + ' has maxLevel');
  assert(['global', 'forest', 'neighborhood', 'wetland', 'farm'].includes(d.targetType), id + ' has valid targetType');
  assert(d.effects && typeof d.effects === 'object' && Array.isArray(d.seasonsAllowed), id + ' has effects + seasonsAllowed');
  const sentences = d.detail.split(/[.!?](\s|$)/).filter(s => s.trim().length > 5).length;
  assert(sentences >= 2 && sentences <= 4, id + ' detail is 2-3 sentences (' + sentences + ')');
});
assert(byId.irrigation.maxLevel === 3 && byId.leak_detection.maxLevel === 3 && byId.reservoir_upgrade.maxLevel === 2 && byId.rain_capture.maxLevel === 2 && byId.outreach.maxLevel === 1, 'max levels match spec');
assert(byId.forest_thinning.targetType === 'forest' && byId.prescribed_burn.targetType === 'forest' && byId.home_hardening.targetType === 'neighborhood' && byId.fuel_break.targetType === 'neighborhood' && byId.wetland.targetType === 'wetland', 'target types match spec');
assert(byId.prescribed_burn.seasonsAllowed.length === 2 && byId.prescribed_burn.seasonsAllowed.includes(C.SEASON.SPRING) && byId.prescribed_burn.seasonsAllowed.includes(C.SEASON.FALL), 'prescribed_burn only Spring/Fall');

// effects defaults
{
  const st = makeState();
  const e = P.effects(st);
  const expected = { sensorCoverage: 0, irrigationEfficiency: 0, leakReduction: 0, reservoirCapacityBonus: 0, multiLevelIntake: false, rainCaptureAF: 0, wetlandRestored: false, shelters: false, warningSystem: false, outreach: false, treatment: false, stockpileBonus: 0, musselInspection: false, wildlifeCorridor: false, upkeepM: 0 };
  Object.keys(expected).forEach(k => assert(e[k] === expected[k], 'effects default ' + k + ' = ' + JSON.stringify(expected[k])));
  ['thinnedZones', 'fuelBreakZones', 'hardenedZones'].forEach(k => assert(e[k] && typeof e[k] === 'object' && Object.keys(e[k]).length === 0, 'effects default ' + k + ' is empty map'));
  assert(P.effects(st) === e, 'effects memoised within a turn');
}

// budget math
{
  const st = makeState(), w = makeWorld(), rng = WS.RNG.create(1);
  assert(P.canFund(st, w, 'streamgages').ok === true, 'canFund streamgages with $12M');
  const r = P.fund(st, w, 'streamgages', null, rng);
  assert(r.ok && typeof r.text === 'string', 'fund streamgages ok with text');
  assert(Math.abs(st.budget - 10.8) < 1e-9, 'budget exactly 12 - 1.2 = 10.8 (got ' + st.budget + ')');
  assert(P.effects(st).sensorCoverage === 1, 'sensorCoverage=1 after streamgages (memo invalidated by _rev)');
  const again = P.canFund(st, w, 'streamgages');
  assert(!again.ok && /funded/i.test(again.reason), 'streamgages cannot be funded twice');
  st.budget = 3;
  const poor = P.canFund(st, w, 'reservoir_upgrade');
  assert(!poor.ok && /\$/.test(poor.reason), 'insufficient budget refused with friendly $ reason: ' + poor.reason);
  const rf = P.fund(st, w, 'reservoir_upgrade', null, rng);
  assert(!rf.ok && st.budget === 3, 'fund refuses and does not charge when insufficient');
  st.budget = 20;
  assert(P.fund(st, w, 'irrigation', null, rng).ok && P.fund(st, w, 'irrigation', null, rng).ok && P.fund(st, w, 'irrigation', null, rng).ok, 'irrigation funded to level 3');
  assert(!P.canFund(st, w, 'irrigation').ok, 'irrigation refused at max level');
  assert(Math.abs(P.effects(st).irrigationEfficiency - 0.36) < 1e-9, 'irrigationEfficiency 0.36 at level 3');
  assert(P.fund(st, w, 'reservoir_upgrade', null, rng).ok, 'reservoir_upgrade level 1');
  assert(P.effects(st).reservoirCapacityBonus === 0.15 && P.effects(st).multiLevelIntake === false, 'level 1 = +15% capacity, no intake');
  st.budget = 20;
  assert(P.fund(st, w, 'reservoir_upgrade', null, rng).ok, 'reservoir_upgrade level 2');
  assert(P.effects(st).multiLevelIntake === true, 'level 2 = multi-level intake');
  assert(P.effects(st).upkeepM > 0, 'upkeepM accumulates');
  const unknown = P.canFund(st, w, 'nonsense');
  assert(!unknown.ok, 'unknown project refused');
  assert(!P.fund(null, w, 'streamgages', null, rng).ok, 'fund with null state does not throw');
}

// thinning + tick
{
  const st = makeState(), w = makeWorld(), rng = WS.RNG.create(2);
  const forest = w.zonesOf('forest');
  assert(forest.length >= 1, 'stub/generated world has forest zones');
  const z = forest[0];
  const before = zoneMeanFuel(w, z);
  const noTarget = P.canFund(st, w, 'forest_thinning', null);
  assert(!noTarget.ok && /target|choose|sector/i.test(noTarget.reason), 'thinning without target refused with reason');
  const wrongType = P.canFund(st, w, 'forest_thinning', w.zonesOf('neighborhood')[0].id);
  assert(!wrongType.ok, 'thinning on a neighborhood refused');
  const r = P.fund(st, w, 'forest_thinning', z.id, rng);
  assert(r.ok, 'thinning funded in ' + z.name);
  const after = zoneMeanFuel(w, z);
  assert(Math.abs(after - before * 0.55) < 1e-4, 'zone fuel multiplied by 0.55 (' + before.toFixed(3) + ' -> ' + after.toFixed(3) + ')');
  assert(Math.abs(st.budget - (12 - byId.forest_thinning.costM)) < 1e-9, 'thinning cost deducted exactly');
  assert(P.effects(st).thinnedZones[z.id] === 1, 'thinnedZones strength 1.0');
  assert(!P.canFund(st, w, 'forest_thinning', z.id).ok, 'same zone cannot be re-thinned while fresh');
  assert(P.canFund(st, w, 'forest_thinning', forest[1].id).ok, 'another forest zone can be thinned');
  st.budget = 5; P.fund(st, w, 'outreach', null, rng);
  const budgetBeforeTick = st.budget;
  st.turn = 4; st.season = 0; st.year = 2;
  const t = P.tick(st, w);
  const expectedUpkeep = byId.outreach.upkeepM + byId.forest_thinning.upkeepM;
  assert(Math.abs(t.upkeepM - expectedUpkeep) < 1e-9 && Math.abs(st.budget - (budgetBeforeTick - expectedUpkeep)) < 1e-9, 'tick charged upkeep ' + t.upkeepM);
  assert(Math.abs(P.effects(st).thinnedZones[z.id] - 0.88) < 1e-9, 'thinning strength decayed to 0.88');
  for (let k = 0; k < 8; k++) { st.turn += 4; P.tick(st, w); }
  assert(P.effects(st).thinnedZones[z.id] === undefined, 'thinning expires after ~8 years');
  assert(P.canFund(st, w, 'forest_thinning', z.id).ok === false || st.budget < byId.forest_thinning.costM, 'expired zone is fundable again (budget permitting)');
  st.budget = 10;
  assert(P.canFund(st, w, 'forest_thinning', z.id).ok, 'expired zone fundable again with budget');
  // upkeep shortfall never drives budget negative
  st.budget = 0.1; P.tick(st, w);
  assert(st.budget >= 0, 'tick never pushes budget negative');
  noNaN(st, 'state-after-tick');
  assert(true, 'no NaN after tick');
}

// prescribed burn + zone projects + listFor
{
  const st = makeState(), w = makeWorld(), rng = WS.RNG.create(3);
  const forest = w.zonesOf('forest'), nb = w.zonesOf('neighborhood'), wet = w.zonesOf('wetland');
  st.season = C.SEASON.SUMMER;
  const summer = P.canFund(st, w, 'prescribed_burn', forest[0].id);
  assert(!summer.ok && /Spring|Fall/.test(summer.reason), 'prescribed burn refused in Summer with season reason');
  st.season = C.SEASON.SPRING;
  const b = P.fund(st, w, 'prescribed_burn', forest[2].id, rng);
  assert(b.ok && st.projects.pendingBurn && st.projects.pendingBurn.zoneId === forest[2].id && st.projects.pendingBurn.turn === st.turn, 'prescribed burn sets pendingBurn {zoneId, turn}');
  assert(Math.abs(st.budget - (12 - byId.prescribed_burn.costM)) < 1e-9, 'prescribed burn charged');
  assert(!P.canFund(st, w, 'prescribed_burn', forest[3].id).ok, 'only one pending burn at a time');
  assert(P.fund(st, w, 'home_hardening', nb[0].id, rng).ok && P.effects(st).hardenedZones[nb[0].id] === true, 'home_hardening sets hardenedZones');
  assert(!P.canFund(st, w, 'home_hardening', nb[0].id).ok, 'home_hardening not repeatable in the same neighborhood');
  assert(P.fund(st, w, 'fuel_break', nb[1].id, rng).ok && P.effects(st).fuelBreakZones[nb[1].id] === true, 'fuel_break sets fuelBreakZones');
  assert(P.fund(st, w, 'wetland', wet[0].id, rng).ok && P.effects(st).wetlandRestored === true && st.flags.wetlandRestored === true, 'wetland sets wetlandRestored + flag');
  st.budget = 10;
  assert(P.fund(st, w, 'stockpile', null, rng).ok && P.effects(st).stockpileBonus === 3, 'stockpile bonus 3');
  assert(P.fund(st, w, 'mussel_inspection', null, rng).ok && P.effects(st).musselInspection === true, 'mussel inspection effect');
  const list = P.listFor(st, w);
  assert(list.length === P.LIST.length, 'listFor returns an entry per project');
  list.forEach(en => {
    assert(en.def && typeof en.funded === 'boolean' && typeof en.level === 'number' && typeof en.canFund === 'boolean' && typeof en.reason === 'string' && Array.isArray(en.targets), 'listFor entry shape for ' + en.def.id);
    if (en.def.targetType !== 'global') {
      assert(en.targets.length > 0, en.def.id + ' has targets');
      en.targets.forEach(t => assert(typeof t.zoneId === 'number' && typeof t.name === 'string' && typeof t.funded === 'boolean', en.def.id + ' target shape'));
    }
  });
  const hh = list.find(e => e.def.id === 'home_hardening');
  assert(hh.targets.find(t => t.zoneId === nb[0].id).funded === true && hh.level === 1, 'listFor marks the hardened neighborhood as funded');
  const pb = list.find(e => e.def.id === 'prescribed_burn');
  assert(pb.targets.find(t => t.zoneId === forest[2].id).funded === true, 'listFor marks the pending-burn sector');
  assert(P.listFor(null, null).length === P.LIST.length, 'listFor tolerates null state/world');
  noNaN(st, 'state-after-projects');
  assert(true, 'no NaN after project funding');
}

/* ================================================================== EVENTS */
const E = WS.Events;
assert(E && Array.isArray(E.CARDS) && E.CARDS.length >= 18, 'WS.Events.CARDS has >= 18 cards (' + E.CARDS.length + ')');
const REQUIRED_CARDS = ['low_snowpack', 'heat_wave', 'mussels', 'lightning_fire', 'storm_forecast', 'pipe_leak', 'federal_funding', 'residents_oppose_burn', 'fire_response', 'senior_call', 'algae_bloom', 'smoke_event', 'subdivision_proposal', 'fish_kill_warning', 'hydro_shortfall', 'well_failure', 'tourism_boom', 'ski_area_request', 'insurance_retreat', 'mutual_aid', 'dust_on_snow', 'beetle_kill', 'flash_drought'];
const cardById = {}; E.CARDS.forEach(c => { cardById[c.id] = c; });
let delayedCards = 0;
REQUIRED_CARDS.forEach(id => {
  const c = cardById[id];
  assert(!!c, 'card ' + id + ' exists');
  assert(typeof c.title === 'string' && typeof c.icon === 'string' && typeof c.text === 'string' && typeof c.source === 'string' && c.source.length > 20, id + ' has title/icon/text/source');
  assert(['info', 'warn', 'crisis'].includes(c.severity) && typeof c.when === 'function' && typeof c.weight === 'function' && typeof c.once === 'boolean', id + ' has severity/when/weight/once');
  if (id === 'fire_response') { assert(c.when(makeState(), makeWorld()) === false, 'fire_response never drawn randomly'); return; }
  assert(Array.isArray(c.choices) && c.choices.length >= 2, id + ' has >= 2 choices');
  let scheduledAny = false;
  c.choices.forEach((ch, k) => {
    assert(typeof ch.label === 'string' && typeof ch.desc === 'string' && typeof ch.apply === 'function', id + ' choice ' + k + ' shape');
    const st = makeState(), w = makeWorld(), rng = WS.RNG.create(100 + k);
    if (typeof c.prepare === 'function') c.prepare(st, w, rng);
    const before = st.scheduled.length;
    const r = ch.apply(st, w, rng);
    assert(r && typeof r.text === 'string' && r.text.length > 0, id + ' choice ' + k + ' apply returns text');
    assert(!r.delta || typeof r.delta === 'object', id + ' choice ' + k + ' delta is object or absent');
    Object.keys(r.delta || {}).forEach(key => assert(C.OUTCOME_KEYS.includes(key) && isFinite(r.delta[key]), id + ' choice ' + k + ' delta key ' + key + ' valid'));
    C.OUTCOME_KEYS.forEach(key => assert(st.outcomes[key] >= 0 && st.outcomes[key] <= 100, id + ' choice ' + k + ' outcomes clamped'));
    assert(st.budget >= 0, id + ' choice ' + k + ' budget never negative');
    if (st.scheduled.length > before) scheduledAny = true;
    noNaN(st, id + '/' + k);
    // fresh state without prepare must also work
    const st2 = makeState(); const r2 = ch.apply(st2, makeWorld(), WS.RNG.create(5));
    assert(r2 && typeof r2.text === 'string', id + ' choice ' + k + ' works on a fresh state without prepare');
  });
  if (scheduledAny) delayedCards++;
});
assert(delayedCards >= 8, 'at least 8 cards schedule delayed consequences (' + delayedCards + ')');

// delta helper: W/E/P/F to outcomes, T to trustDelta
{
  const st = makeState();
  E.applyDelta(st, { W: -100, T: 3 });
  assert(st.outcomes.W === 0 && st.outcomes.T === 60 && st.trustDelta === 3, 'applyDelta clamps outcomes and routes T to trustDelta');
  const st2 = makeState();
  const r = cardById.residents_oppose_burn.choices[2].apply(st2, makeWorld(), WS.RNG.create(1));
  assert(r.delta.T < 0 && st2.trustDelta === r.delta.T && st2.outcomes.T === 60, 'choice T delta lands in state.trustDelta only');
}

// lightning_fire prepare sets forcedIgnition for an upstream sector; storm_forecast sets pendingStorm
{
  const st = makeState(), w = makeWorld(), rng = WS.RNG.create(9);
  st.season = C.SEASON.SUMMER; st.climate.fireDanger = 0.6;
  cardById.lightning_fire.prepare(st, w, rng);
  const fz = st.fire.forcedIgnition && w.zoneById(st.fire.forcedIgnition.zoneId);
  assert(fz && fz.type === 'forest' && fz.upstreamOfReservoir, 'lightning_fire sets forcedIgnition on an upstream forest sector (' + fz.name + ')');
  for (let k = 0; k < 200; k++) w.burn[w.zonesOf('forest')[0].cells[k]] = 0.7;
  assert(cardById.storm_forecast.when(st, w) === true, 'storm_forecast eligible with a burn scar');
  cardById.storm_forecast.prepare(st, w, rng);
  assert(st.pendingStorm && st.pendingStorm.intensityIn >= 0.8 && st.pendingStorm.intensityIn <= 3.0 && st.pendingStorm.source === 'event', 'storm_forecast sets pendingStorm');
  assert(cardById.storm_forecast.when(st, w) === false, 'storm_forecast not eligible while a storm is pending');
  st.projects.pendingBurn = { zoneId: 0, turn: 0 };
  assert(cardById.residents_oppose_burn.when(st, w) === true, 'residents_oppose_burn eligible when a burn is pending');
  cardById.residents_oppose_burn.choices[1].apply(st, w, rng);
  assert(st.projects.pendingBurn === null, 'cancel choice clears pendingBurn');
}

// runScheduled
{
  const st = makeState(), w = makeWorld();
  st.turn = 3;
  const sched = (n, label, effect) => { if (WS.State && WS.State.schedule) WS.State.schedule(st, n, label, effect); else st.scheduled.push({ dueTurn: st.turn + n, label, effect }); };
  sched(2, 'W boost', { type: 'outcome', key: 'W', value: 5, text: 'Water boost arrived.' });
  sched(2, 'Trust', { type: 'outcome', key: 'T', value: -2, text: 'Trust dip.' });
  sched(1, 'Money', { type: 'budget', key: 'budget', value: 2.5, text: 'Grant landed.' });
  sched(1, 'Flag', { type: 'flag', key: 'federalGrant', value: true, text: 'Flag set.' });
  sched(1, 'Demand', { type: 'demand', key: 'households', value: 0.9, text: 'Demand multiplier.' });
  sched(1, 'Custom', { type: 'custom', key: 'grantAwarded', value: { amountM: 1.0 }, text: '' });
  sched(1, 'Bad custom', { type: 'custom', key: 'doesNotExist', value: null, text: 'fallback text' });
  const none = E.runScheduled(st, w);
  assert(none.length === 0 && st.scheduled.length === 7, 'nothing due at turn 3');
  st.turn = 4; const b0 = st.budget;
  const t4 = E.runScheduled(st, w);
  assert(t4.length === 5 && st.scheduled.length === 2, 'five effects applied at turn 4');
  assert(Math.abs(st.budget - (b0 + 2.5 + 1.0)) < 1e-9 && st.flags.federalGrant === true && st.flags.demandMult.households === 0.9, 'budget/flag/demand/custom effects applied');
  assert(t4.every(t => typeof t === 'string' && t.length > 0), 'runScheduled returns text lines');
  st.turn = 5; const w0 = st.outcomes.W, td0 = st.trustDelta || 0;
  const t5 = E.runScheduled(st, w);
  assert(t5.length === 2 && st.outcomes.W === w0 + 5 && Math.abs(st.trustDelta - (td0 - 2)) < 1e-9 && st.scheduled.length === 0, 'outcome effects applied at turn 5 (T -> trustDelta)');
  assert(Array.isArray(E.runScheduled({ turn: 0 }, null)) && Array.isArray(E.runScheduled(null, null)), 'runScheduled tolerates missing scheduled/state');
  Object.keys(E.HANDLERS).forEach(h => {
    const s2 = makeState(); s2.turn = 2; const out = E.HANDLERS[h](s2, makeWorld(), { zoneId: 0, amountM: 1 });
    assert(typeof out === 'string' && out.length > 0, 'HANDLERS.' + h + ' returns text on a fresh state'); noNaN(s2, 'handler ' + h);
  });
}

// fireResponseCard
{
  const st = makeState(), w = makeWorld(), rng = WS.RNG.create(11);
  const fz = w.zonesOf('forest')[0];
  const fireSim = { startCell: fz.cells[10], acres: 340, zoneId: fz.id };
  const card = E.fireResponseCard(st, w, fireSim);
  assert(card && card.id === 'fire_response' && card.choices.length === 4 && /forest|Ridge|Bench|Slopes|Divide|Flats|Gulch/i.test(card.text), 'fireResponseCard returns 4 choices with zone-specific text');
  const focuses = [];
  card.choices.forEach((ch, k) => {
    const s = makeState(); const r = ch.apply(s, w, rng);
    assert(typeof r.text === 'string' && s.fire.responseBudget >= 0.5 && s.fire.responseBudget <= 1.5, 'fire choice ' + k + ' sets responseBudget in 0.5..1.5 (' + s.fire.responseBudget + ')');
    assert(s.fire.crewFocus === null || ['town', 'watershed', 'farms'].includes(s.fire.crewFocus), 'fire choice ' + k + ' crewFocus valid');
    assert(Math.abs(s.budget - (12 - ch.costM)) < 1e-9, 'fire choice ' + k + ' charged ' + ch.costM);
    focuses.push(s.fire.crewFocus);
  });
  assert(focuses.includes('town') && focuses.includes('watershed') && focuses.includes('farms') && focuses.includes(null), 'all four crew focuses available');
  const broke = makeState(); broke.budget = 0.2; broke.emergencyFund = 0;
  const rb = card.choices[0].apply(broke, w, rng);
  assert(broke.budget === 0 && broke.emergencyDebt === true && rb.delta.T < 0 && broke.trustDelta < 0, 'unaffordable fire response allowed: budget 0, emergencyDebt flag, trust penalty');
  const pre = makeState(); pre.fire.preResponse = 0.25;
  card.choices[0].apply(pre, w, rng);
  assert(pre.fire.responseBudget === 1.5 && pre.fire.preResponse === 0, 'early-tanker bonus raises response and is consumed');
  assert(E.fireResponseCard(makeState(), null, null).choices.length === 4, 'fireResponseCard tolerates null world/fireSim');
}

// draw over 40 turns
{
  const st = makeState(), w = makeWorld(), rng = WS.RNG.create(2024);
  const seen = {}, drawnTurn = {};
  let total = 0, onceCount = 0;
  for (let turn = 0; turn < 40; turn++) {
    st.turn = turn; st.season = turn % 4; st.year = 1 + Math.floor(turn / 4);
    if (st.season === 0) { st.budget = 12; P.tick(st, w); }
    st.fire.forcedIgnition = null; st.fire.activeFire = null; st.pendingStorm = null;
    st.climate.snowpackPct = rng.range(40, 140); st.climate.tempAnomF = rng.range(-2, 6); st.climate.fireDanger = rng.range(0, 0.9);
    st.climate.precipIn = rng.range(0.3, 4); st.climate.streamflowCfs = rng.range(8, 120); st.climate.drought = rng.pick(['None', 'D0', 'D1', 'D2', 'D3', 'D4']);
    st.reservoir.storageAF = rng.range(8000, 42000); st.reservoir.algae = rng.range(0, 0.6);
    if (turn === 12) for (let k = 0; k < 300; k++) w.burn[w.zonesOf('forest')[1].cells[k]] = 0.8;
    if (turn === 20) st.fire.structuresLost = 12;
    if (st.season === 1 && rng.chance(0.5) && P.canFund(st, w, 'prescribed_burn', 0).ok) P.fund(st, w, 'prescribed_burn', 0, rng);
    E.runScheduled(st, w);
    const eligible = E.CARDS.filter(c => c.id !== 'fire_response' && c.when(st, w)).map(c => c.id);
    const cards = E.draw(st, w, rng);
    assert(cards.length >= 0 && cards.length <= 2, 'turn ' + turn + ': drew ' + cards.length + ' cards');
    cards.forEach(c => {
      assert(c.id !== 'fire_response' && eligible.includes(c.id), 'turn ' + turn + ': ' + c.id + ' was eligible (when()==true)');
      assert(drawnTurn[c.id] === undefined || turn - drawnTurn[c.id] >= 3, 'turn ' + turn + ': ' + c.id + ' respects 3-turn cooldown');
      if (c.once) { onceCount++; assert(!seen[c.id], c.id + ' (once) not repeated'); }
      seen[c.id] = (seen[c.id] || 0) + 1; drawnTurn[c.id] = turn;
      const ch = rng.pick(c.choices);
      const r = ch.apply(st, w, rng);
      assert(typeof r.text === 'string', 'turn ' + turn + ': applied "' + ch.label + '" on ' + c.id);
    });
    total += cards.length;
    st.projects.pendingBurn = null;
  }
  assert(total >= 15, 'drew a healthy number of cards over 40 turns (' + total + ')');
  assert(Object.keys(seen).length >= 8, 'variety: ' + Object.keys(seen).length + ' distinct cards drawn');
  assert(onceCount <= 1, 'once cards drawn at most once');
  assert(E.draw(st, w, rng).every(c => !c.once || true) && Array.isArray(E.draw(null, w, rng)), 'draw tolerates null state');
  C.OUTCOME_KEYS.forEach(k => assert(st.outcomes[k] >= 0 && st.outcomes[k] <= 100, 'outcome ' + k + ' within 0..100 after 40 turns'));
  assert(st.budget >= 0 && st.emergencyFund >= 0, 'budget and emergency fund never negative');
  noNaN(st, 'state-after-40-turns');
  noNaN({ fuel: w.fuel, burn: w.burn, habitat: w.habitat, treeDensity: w.treeDensity }, 'world-after-40-turns');
  assert(true, 'no NaN anywhere in state or world after 40 turns');
  assert(JSON.stringify(st).length > 0, 'state remains JSON-serialisable');
}

console.log('\nALL PASS: projects_events');
