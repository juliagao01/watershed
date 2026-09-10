/* Tests for src/sim/advisors.js and src/sim/casestudies.js. Run: node tests/advisors_cases.test.js */
const fs = require('fs'), path = require('path');
const { load, assert, noNaN, ROOT } = require('./load');

const files = ['src/sim/advisors.js', 'src/sim/casestudies.js'];
const hasState = fs.existsSync(path.join(ROOT, 'src/sim/state.js'));
if (hasState) files.unshift('src/sim/state.js');
const { WS } = load(files);
const C = WS.C, N = C.N;

// ------------------------------------------------------------ fixtures
function literalState() {
  return {
    seed: 7, mode: 'simulated', years: 6, turn: 0, year: 1, season: 0, phase: 'plan',
    budget: 12, annualBudget: 12, emergencyFund: 0,
    outcomes: { W: 70, E: 65, P: 72, F: 68, T: 60 }, resilience: 0,
    population: 12400, growthRate: 0.012,
    climate: { snowpackPct: 100, snowSWEin: 18, precipIn: 3.2, tempAnomF: 0, soilMoisturePct: 45, fireDanger: 0.2, fireDangerLabel: 'Moderate',
      streamflowCfs: 60, windDirRad: 0.8, windMph: 8, drought: 'None', description: '', uncertainty: 0.25 },
    reservoir: { storageAF: 32000, capacityAF: 42000, turbidity: 0.05, ashContam: 0, algae: 0 },
    water: { demands: { households: 400, farms: 900, fire: 600, hydro: 800, recreation: 300, tribal: 375, wildlife: 250, downstream: 2250 },
      alloc: { households: 1, farms: 1, fire: 1, hydro: 1, recreation: 1, tribal: 1, wildlife: 1, downstream: 1 },
      delivered: {}, shortage: {}, availableAF: 30000, inflowAF: 2000, outflowAF: 0, restriction: 'none' },
    fire: { policy: 'managed', activeFire: null, seasonAcres: 0, totalAcres: 0, structuresLost: 0, fires: [], smokeDays: 0 },
    projects: { funded: {}, pendingBurn: null },
    mitigations: [], pendingStorm: null, scheduled: [], log: [], timeline: [], history: [],
    unlockedCases: [], seenCases: [], flags: {},
    stats: { floodDamageM: 0, sedimentTons: 0, contaminationOutageDays: 0, cropLossPct: 0, hydroMWh: 0, recreationVisits: 0 },
    lastSeasonReport: null
  };
}
function makeState() {
  if (hasState && WS.State && typeof WS.State.create === 'function') {
    try { const s = WS.State.create({ seed: 7, years: 6, mode: 'simulated' }); if (s && s.climate && s.reservoir) return s; } catch (e) { /* fall through */ }
  }
  return literalState();
}
function makeWorld() {
  const M = N * N;
  const w = { seed: 7, N: N, cellM: C.CELL_M, fuel: new Float32Array(M), burn: new Float32Array(M), land: new Uint8Array(M),
    cropHealth: new Float32Array(M), habitat: new Float32Array(M), moisture: new Float32Array(M), zones: [],
    reservoir: { cells: new Int32Array(0), capacityAF: 42000, dam: { x: 62, y: 70 }, intake: { x: 60, y: 68 }, center: { x: 53, y: 61 } } };
  const names = ['Cameron Ridge', 'Troublesome Bench', 'North Fork Slopes', 'Kestrel Divide', 'Ponderosa Flats', 'Roaring Gulch'];
  let id = 0;
  names.forEach((name, k) => {
    const cells = [];
    for (let y = 5 + k * 10; y < 12 + k * 10; y++) for (let x = 5; x < 40; x++) { const i = y * N + x; cells.push(i); w.fuel[i] = 0.45 + 0.07 * k; w.land[i] = C.LAND.FOREST; w.habitat[i] = 0.6; }
    w.zones.push({ id: id++, type: 'forest', name, cells: Int32Array.from(cells), center: { x: 20, y: 8 + k * 10 }, upstreamOfReservoir: k < 4, bbox: { x0: 5, y0: 5 + k * 10, x1: 40, y1: 12 + k * 10 } });
  });
  ['Marshall Heights', 'Old Mill'].forEach((name, k) => {
    const cells = [];
    for (let y = 80 + k * 6; y < 84 + k * 6; y++) for (let x = 70; x < 90; x++) { const i = y * N + x; cells.push(i); w.land[i] = C.LAND.RESIDENTIAL; }
    w.zones.push({ id: id++, type: 'neighborhood', name, cells: Int32Array.from(cells), center: { x: 80, y: 82 + k * 6 }, upstreamOfReservoir: false });
  });
  const farmCells = [];
  for (let y = 100; y < 110; y++) for (let x = 60; x < 110; x++) { const i = y * N + x; farmCells.push(i); w.land[i] = C.LAND.FARM; w.cropHealth[i] = 0.85; }
  w.zones.push({ id: id++, type: 'farm', name: 'Lazy J Ranch', cells: Int32Array.from(farmCells), center: { x: 85, y: 105 }, upstreamOfReservoir: false });
  w.zoneById = (zid) => w.zones.find(z => z.id === zid) || null;
  w.zonesOf = (t) => w.zones.filter(z => z.type === t);
  return w;
}
function pushHistory(state, n) {
  for (let t = 0; t < n; t++) {
    state.history.push({ turn: t, year: 1 + Math.floor(t / 4), season: t % 4, storageAF: 30000 - t * 800, snowpackPct: 100 - t * 4, streamflowCfs: 60 - t,
      fireDanger: 0.2 + t * 0.03, fuelAvg: 0.55 + t * 0.01, turbidity: 0.05 + t * 0.02, W: 70 - t, E: 65, P: 72, F: 68, T: 60 - t, R: 65, budget: 12 - t * 0.5,
      cropHealth: 0.85 - t * 0.02, shortagePct: t, trust: 60 - t });
  }
}

const TOPICS = ['budget', 'allocation', 'prescribed_burn', 'fire_policy', 'flood', 'contamination', 'drought'];
const STANCES = ['urge', 'support', 'caution', 'oppose'];
const charIds = WS.Advisors.CHARACTERS.map(c => c.id);

// ------------------------------------------------------------ advisors: characters
assert(WS.Advisors && Array.isArray(WS.Advisors.CHARACTERS) && WS.Advisors.CHARACTERS.length === 6, 'Advisors exports 6 CHARACTERS');
WS.Advisors.CHARACTERS.forEach(c => {
  assert(['id', 'name', 'role', 'color', 'avatarEmoji', 'bio'].every(k => typeof c[k] === 'string' && c[k].length > 0), 'character ' + c.id + ' has all string fields');
});
assert(new Set(charIds).size === 6, 'character ids are unique');
['Reyes', 'Jensen', 'Whitehorse', 'Natarajan', 'Lee', 'Ortiz'].forEach(n => assert(WS.Advisors.CHARACTERS.some(c => c.name.indexOf(n) >= 0), 'character named ' + n + ' present'));

// ------------------------------------------------------------ advisors: recommendations
function checkRecs(state, world, label) {
  TOPICS.forEach(topic => {
    const recs = WS.Advisors.getRecommendations(state, world, topic);
    assert(Array.isArray(recs) && recs.length >= 4 && recs.length <= 6, label + ' ' + topic + ': 4-6 recommendations (' + recs.length + ')');
    const ids = new Set();
    recs.forEach((r, k) => {
      const tag = label + ' ' + topic + '[' + k + ']';
      if (!(charIds.indexOf(r.characterId) >= 0)) throw new Error(tag + ' bad characterId ' + r.characterId);
      if (!(STANCES.indexOf(r.stance) >= 0)) throw new Error(tag + ' bad stance ' + r.stance);
      if (!(typeof r.headline === 'string' && r.headline.length > 0)) throw new Error(tag + ' missing headline');
      if (!(typeof r.text === 'string' && r.text.length >= 40)) throw new Error(tag + ' text too short');
      if (/undefined|NaN|\[object/.test(r.text) || /undefined|NaN/.test(r.headline)) throw new Error(tag + ' text contains undefined/NaN: ' + r.text);
      const e = r.evidence;
      if (!(e && typeof e.label === 'string' && typeof e.unit === 'string')) throw new Error(tag + ' evidence label/unit');
      if (!(Array.isArray(e.series) && e.series.length >= 2 && e.series.every(v => typeof v === 'number' && isFinite(v)))) throw new Error(tag + ' evidence series not numeric');
      if (!(typeof e.current === 'number' && isFinite(e.current))) throw new Error(tag + ' evidence current not finite');
      if (e.threshold != null && !(typeof e.threshold === 'number' && isFinite(e.threshold))) throw new Error(tag + ' evidence threshold not finite');
      ids.add(r.characterId);
    });
    assert(ids.size === recs.length, label + ' ' + topic + ': one recommendation per character');
    assert(new Set(recs.map(r => r.stance)).size >= 2, label + ' ' + topic + ': advisors disagree (>=2 stances)');
    noNaN(recs, label + '.' + topic);
  });
}

const s0 = makeState(), w0 = makeWorld();
checkRecs(s0, w0, 'empty-history');
// evidence synthesised from current when history is empty
const r0 = WS.Advisors.getRecommendations(s0, w0, 'allocation').find(r => r.characterId === 'priya');
assert(r0.evidence.series.length >= 2 && r0.evidence.series[r0.evidence.series.length - 1] === r0.evidence.current, 'empty history: series synthesised from current');

const s10 = makeState(), w10 = makeWorld();
pushHistory(s10, 10);
checkRecs(s10, w10, 'history-10');
const r10 = WS.Advisors.getRecommendations(s10, w10, 'allocation').find(r => r.characterId === 'priya');
assert(r10.evidence.series.length >= 10 && r10.evidence.series[0] === 30000, 'history-10: series comes from state.history');

// numbers are substituted into text
const alloc = WS.Advisors.getRecommendations(s0, w0, 'allocation');
assert(alloc.some(r => /\d/.test(r.text)), 'allocation text contains numbers');
const walt = alloc.find(r => r.characterId === 'walt'), naomi = alloc.find(r => r.characterId === 'naomi');
assert(walt && naomi && walt.evidence.label !== naomi.evidence.label, 'walt and naomi cite different evidence');

// stances react to state
const sCut = makeState(); sCut.water.alloc.tribal = 0.6; sCut.water.alloc.farms = 0.5;
const cut = WS.Advisors.getRecommendations(sCut, w0, 'allocation');
assert(cut.find(r => r.characterId === 'naomi').stance === 'oppose', 'naomi opposes under-allocating the tribal right');
assert(cut.find(r => r.characterId === 'walt').stance === 'oppose', 'walt opposes cutting farms');
const sHot = makeState(); sHot.climate.fireDanger = 0.8; sHot.climate.fireDangerLabel = 'Extreme'; sHot.season = 2;
const burnHot = WS.Advisors.getRecommendations(sHot, w0, 'prescribed_burn');
assert(burnHot.find(r => r.characterId === 'dolores').stance === 'caution', 'dolores cautions on burning at extreme danger');
const sSpring = makeState(); sSpring.season = 1; sSpring.climate.fireDanger = 0.2;
const burnOk = WS.Advisors.getRecommendations(sSpring, w0, 'prescribed_burn');
assert(burnOk.find(r => r.characterId === 'dolores').stance === 'urge', 'dolores urges burning in a good window');
assert(burnOk.find(r => r.characterId === 'dolores').text.indexOf('Cameron Ridge') >= 0 || burnOk.find(r => r.characterId === 'dolores').text.indexOf('Kestrel Divide') >= 0, 'prescribed burn text names a forest sector from world.fuel');

// defensive: missing fields, unknown topic, no world
const bare = WS.Advisors.getRecommendations({}, {}, 'budget');
assert(bare.length >= 4 && bare.every(r => !/undefined|NaN/.test(r.text)), 'empty state/world does not throw and yields clean text');
const nullish = WS.Advisors.getRecommendations(null, null, 'nope');
assert(nullish.length >= 4, 'null state and unknown topic still return recommendations');
TOPICS.forEach(t => { const rs = WS.Advisors.getRecommendations({ history: [{ storageAF: 'x' }, null] }, { fuel: new Float32Array(4), zones: [null, { type: 'forest' }] }, t); assert(rs.length >= 4, 'garbage history/zones tolerated for ' + t); });

// ------------------------------------------------------------ case studies: fields
const CS = WS.CaseStudies;
assert(CS && Array.isArray(CS.LIST) && CS.LIST.length >= 8, 'CaseStudies.LIST has >= 8 cases (' + CS.LIST.length + ')');
const csIds = CS.LIST.map(c => c.id);
assert(new Set(csIds).size === csIds.length, 'case ids unique');
CS.LIST.forEach(cs => {
  const ok = typeof cs.id === 'string' && typeof cs.title === 'string' && typeof cs.year === 'number' && typeof cs.region === 'string' &&
    typeof cs.summary === 'string' && typeof cs.lesson === 'string' && typeof cs.unlock === 'function' && typeof cs.linkTo === 'function';
  if (!ok) throw new Error('case ' + cs.id + ' missing fields');
  const words = cs.summary.trim().split(/\s+/).length;
  if (words > 130) throw new Error('case ' + cs.id + ' summary too long: ' + words + ' words');
  if (!/[.!?]$/.test(cs.lesson.trim())) throw new Error('case ' + cs.id + ' lesson is not a sentence');
});
assert(true, 'all cases have id/title/year/region/summary(<=130 words)/lesson/unlock/linkTo');
['cameron_peak', 'east_troublesome', 'marshall', 'colorado_river', 'shoshone', 'monitoring', 'mussels', 'hayman', 'buffalo_creek', 'grizzly_creek', 'flood_2013', 'beaver_mimicry']
  .forEach(id => assert(!!CS.byId(id), 'case present: ' + id));

// unlock() on a fresh state: no throws, mostly false
const fresh = makeState(), fw = makeWorld();
const unlockedFresh = CS.LIST.filter(cs => cs.unlock(fresh, fw)).map(cs => cs.id);
assert(unlockedFresh.length === 0, 'fresh state unlocks nothing (' + unlockedFresh.join(',') + ')');
CS.LIST.forEach(cs => { cs.unlock({}, {}); cs.unlock(null, null); cs.linkTo({}); });
assert(true, 'unlock/linkTo tolerate empty and null state');
assert(CS.checkUnlocks(fresh, fw).length === 0 && fresh.unlockedCases.length === 0, 'checkUnlocks on fresh state returns []');

// simulate experiences and check the right cases unlock
function unlocks(mutate) { const s = makeState(), w = makeWorld(); mutate(s, w); return { s, w, ids: CS.checkUnlocks(s, w) }; }
let r;
r = unlocks(s => s.fire.fires.push({ year: 1, season: 2, acres: 1200, zoneIds: [0], structures: 0, upstream: true }));
assert(r.ids.indexOf('cameron_peak') >= 0 && r.ids.indexOf('marshall') < 0 && r.ids.indexOf('east_troublesome') < 0, 'first small fire unlocks cameron_peak only: ' + r.ids.join(','));
assert(/1,200 acres/.test(CS.linkTo('cameron_peak', r.s)), 'cameron_peak linkTo cites the player fire acreage');

r = unlocks(s => { s.fire.fires.push({ year: 2, season: 2, acres: 4000, zoneIds: [4, 6], structures: 25, upstream: false }); s.fire.structuresLost = 25; });
assert(r.ids.indexOf('marshall') >= 0 && r.ids.indexOf('east_troublesome') >= 0, 'fire into a neighborhood with 25 structures unlocks marshall + east_troublesome');
assert(/25 structures/.test(CS.linkTo('marshall', r.s)), 'marshall linkTo cites structures lost');

r = unlocks(s => { s.fire.fires.push({ year: 1, season: 2, acres: 900, zoneIds: [0], structures: 0, upstream: true }); s.stats.sedimentTons = 2400; });
assert(r.ids.indexOf('buffalo_creek') >= 0 && r.ids.indexOf('flood_2013') < 0, 'post-fire flood with sediment unlocks buffalo_creek');

r = unlocks(s => { s.fire.fires.push({ acres: 900, zoneIds: [0], upstream: true }); s.stats.floodDamageM = 1.2; });
assert(r.ids.indexOf('grizzly_creek') >= 0 && r.ids.indexOf('flood_2013') < 0, 'post-fire flood damage unlocks grizzly_creek');

r = unlocks(s => { s.stats.floodDamageM = 4.5; });
assert(r.ids.indexOf('flood_2013') >= 0, 'big flood damage unlocks flood_2013');

r = unlocks(s => { s.stats.contaminationOutageDays = 6; });
assert(r.ids.indexOf('hayman') >= 0, 'contamination outage unlocks hayman');

r = unlocks(s => { s.climate.drought = 'D2'; });
assert(r.ids.indexOf('colorado_river') >= 0, 'drought D2 unlocks colorado_river');
r = unlocks(s => { s.water.demands.households = 400; s.water.shortage.households = 60; });
assert(r.ids.indexOf('colorado_river') >= 0, 'household shortage unlocks colorado_river');

r = unlocks(s => { s.water.alloc.tribal = 0.5; });
assert(r.ids.indexOf('shoshone') >= 0, 'under-allocating the tribal right unlocks shoshone');
r = unlocks(s => { s.flags.legalOverride = true; });
assert(r.ids.indexOf('shoshone') >= 0, 'legalOverride flag unlocks shoshone');

r = unlocks(s => { s.projects.funded.streamgages = { level: 1, targets: [], turnFunded: 0 }; });
assert(r.ids.indexOf('monitoring') >= 0, 'funding streamgages unlocks monitoring');

r = unlocks(s => { s.flags.musselEvent = true; });
assert(r.ids.indexOf('mussels') >= 0, 'mussel event flag unlocks mussels');

r = unlocks(s => { s.flags.wetlandRestored = true; });
assert(r.ids.indexOf('beaver_mimicry') >= 0, 'wetland restoration unlocks beaver_mimicry');

// linkTo text is clean for every case under a loaded state
const loaded = makeState(); loaded.fire.fires.push({ acres: 3000, structures: 3, zoneIds: [0], upstream: true }); loaded.stats.sedimentTons = 1500; loaded.stats.floodDamageM = 2;
CS.LIST.forEach(cs => { const t = CS.linkTo(cs.id, loaded); if (!(typeof t === 'string' && t.length > 20 && !/undefined|NaN/.test(t))) throw new Error('linkTo bad for ' + cs.id + ': ' + t); });
assert(true, 'linkTo returns clean sentences for every case');

// checkUnlocks idempotent and cumulative
const sI = makeState(), wI = makeWorld();
sI.fire.fires.push({ acres: 500, zoneIds: [1], upstream: true });
const first = CS.checkUnlocks(sI, wI);
const second = CS.checkUnlocks(sI, wI);
assert(first.length === 1 && second.length === 0 && sI.unlockedCases.length === 1, 'checkUnlocks is idempotent');
sI.stats.sedimentTons = 800;
const third = CS.checkUnlocks(sI, wI);
assert(third.indexOf('buffalo_creek') >= 0 && sI.unlockedCases.length === 2 && CS.checkUnlocks(sI, wI).length === 0, 'checkUnlocks accumulates without duplicates');
const noArr = { fire: { fires: [{ acres: 10 }] } };
assert(CS.checkUnlocks(noArr, {}).indexOf('cameron_peak') >= 0 && Array.isArray(noArr.unlockedCases), 'checkUnlocks creates unlockedCases when missing');

noNaN(s10, 'state after tests');
console.log('ALL PASS');
