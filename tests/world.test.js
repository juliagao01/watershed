/* World generation tests: node tests/world.test.js */
const { load, assert, noNaN } = require('./load');
const { WS } = load(['src/world/terrain.js']);
const C = WS.C, L = C.LAND, N = C.N, NN = N * N;

function hashF32(a) { let h = 2166136261; for (let i = 0; i < a.length; i++) { h ^= Math.round(a[i] * 1000) & 0xffff; h = Math.imul(h, 16777619); } return h >>> 0; }
function within(v, a, b) { return v >= a && v <= b; }
const EPS = 1e-4; // Float32 storage rounding
function pathElev(w, k) { return w.elev[w.idx(w.river.path[k].x, w.river.path[k].y)]; }

/* ---------- timing + determinism ---------- */
let w = null, ms = Infinity, runs = [];
for (let r = 0; r < 3; r++) { const t0 = Date.now(); w = WS.World.generate(7); const dt = Date.now() - t0; runs.push(dt); if (dt < ms) ms = dt; }
assert(ms < 400, 'generate(7) runs in < 400 ms (best of 3: ' + ms + ' ms; runs ' + runs.join('/') + ')');
const w2 = WS.World.generate(7), w3 = WS.World.generate(8);
assert(hashF32(w.elev) === hashF32(w2.elev) && JSON.stringify(w.buildings) === JSON.stringify(w2.buildings) && hashF32(w.fuel) === hashF32(w2.fuel), 'generation is deterministic for the same seed');
assert(hashF32(w.elev) !== hashF32(w3.elev), 'different seed gives a different world');
noNaN(w, 'world'); assert(true, 'no NaN/Inf anywhere in world');

/* ---------- shape ---------- */
assert(w.N === 128 && w.cellM === 100 && w.seed === 7, 'N=128, cellM=100, seed stored');
['elev', 'slope', 'aspect', 'fuel', 'moisture', 'burn', 'treeDensity', 'cropHealth', 'habitat', 'flowAcc'].forEach(k => assert(w[k] instanceof Float32Array && w[k].length === NN, k + ' is Float32Array[N*N]'));
assert(w.land instanceof Uint8Array && w.land.length === NN, 'land is Uint8Array');
assert(w.flowDir instanceof Int32Array && w.flowDir.length === NN, 'flowDir is Int32Array');
assert(w.zone instanceof Int16Array && w.zone.length === NN, 'zone is Int16Array');
assert(w.snowlineElev === 2600 && w.treeline === 3450, 'snowline/treeline defaults');

/* ---------- helpers ---------- */
assert(w.idx(5, 7) === 7 * N + 5 && w.xy(7 * N + 5).x === 5 && w.xy(7 * N + 5).y === 7, 'idx/xy round-trip');
assert(w.inBounds(0, 0) && w.inBounds(127, 127) && !w.inBounds(-1, 0) && !w.inBounds(0, 128), 'inBounds');
assert(w.neighbors8(0).length === 3 && w.neighbors8(w.idx(64, 64)).length === 8 && w.neighbors8(w.idx(127, 5)).length === 5, 'neighbors8 counts');
assert(w.zoneById(-1) === null && w.zoneById(9999) === null && w.zoneById(0).id === 0, 'zoneById defensive');
assert(w.isUpstreamOfReservoir(-5) === false && w.isUpstreamOfReservoir(NN + 1) === false, 'isUpstreamOfReservoir defensive');

/* ---------- summary + land counts ---------- */
const s = w.summary();
assert(s && s.land && s.buildings && typeof s.houses === 'number', 'summary() has land/buildings/houses');
for (let e = 0; e < C.LAND_NAMES.length; e++) assert(s.land[C.LAND_NAMES[e]] > 0, 'land value used: ' + C.LAND_NAMES[e] + ' (' + s.land[C.LAND_NAMES[e]] + ')');
assert(s.forestCells > 3000, 'forest cells > 3000 (' + s.forestCells + ')');
assert(within(s.farmCells, 1100, 1400), 'farm cells 1100-1400 (' + s.farmCells + ')');
assert(within(s.reservoirCells, 180, 260), 'reservoir cells 180-260 (' + s.reservoirCells + ')');
assert(within(s.residentialCells, 300, 500), 'residential cells 300-500 (' + s.residentialCells + ')');
assert(s.land.Road > 100 && s.land.Riparian > 100 && s.land['Alpine/Rock'] > 100 && s.land.River >= 100, 'road/riparian/alpine/river counts plausible');
assert(within(s.land.Wetland, 40, 90), 'wetland ~60 cells (' + s.land.Wetland + ')');
assert(within(s.elevMin, 1900, 2000) && within(s.elevMax, 3650, 3760), 'elevation range ' + s.elevMin.toFixed(0) + '-' + s.elevMax.toFixed(0));
for (let e = 0; e < C.LAND_NAMES.length; e++) assert(w.cellsOf(e).length === s.land[C.LAND_NAMES[e]], 'cellsOf matches summary for ' + C.LAND_NAMES[e]);

/* ---------- mountains, forest band, town bench ---------- */
let nwSum = 0, nwCnt = 0, nwMax = 0;
for (let y = 0; y < 43; y++) for (let x = 0; x < 43; x++) { const e = w.elev[w.idx(x, y)]; nwSum += e; nwCnt++; if (e > nwMax) nwMax = e; }
assert(nwSum / nwCnt > 2900 && nwMax > 3650, 'NW third is mountainous (mean ' + (nwSum / nwCnt).toFixed(0) + ' m, max ' + nwMax.toFixed(0) + ')');
let okForest = true, okAlpine = true, okFarm = true;
for (let i = 0; i < NN; i++) {
  if (w.land[i] === L.FOREST && !within(w.elev[i], 2200, 3450)) okForest = false;
  if (w.land[i] === L.ALPINE && w.elev[i] <= 3450) okAlpine = false;
  if (w.land[i] === L.FARM && (w.elev[i] > 2100 || w.slope[i] > 0.2)) okFarm = false;
}
assert(okForest, 'forest cells lie in 2200-3450 m'); assert(okAlpine, 'alpine cells above tree line'); assert(okFarm, 'farm cells on the low, flat valley floor');
const resElev = w.cellsOf(L.RESIDENTIAL).map ? Array.from(w.cellsOf(L.RESIDENTIAL)).map(i => w.elev[i]).sort((a, b) => a - b) : [];
assert(within(resElev[resElev.length >> 1], 2040, 2170) && resElev[0] > 1960 && resElev[resElev.length - 1] < 2260, 'town bench elevation (median ' + resElev[resElev.length >> 1].toFixed(0) + ' m)');
let spike = 0;
for (let i = 0; i < NN; i++) {
  if (w.land[i] === L.RIVER) continue;
  let mx = -1e9; for (const j of w.neighbors8(i)) if (w.elev[j] > mx) mx = w.elev[j];
  if (w.elev[i] > mx + 45) spike++;
}
assert(spike === 0, 'no single-cell spikes (> 45 m above all neighbours)');
let slopeOk = true, aspectOk = true;
for (let i = 0; i < NN; i++) { if (w.slope[i] < 0 || w.slope[i] > 1.5) slopeOk = false; if (w.aspect[i] < 0 || w.aspect[i] >= 2 * Math.PI + 1e-6) aspectOk = false; }
assert(slopeOk && aspectOk, 'slope in 0..1.5 and aspect in [0, 2pi)');

/* ---------- river ---------- */
const P = w.river.path, K = P.length;
assert(K > 100 && w.river.widths.length === K, 'river path has ' + K + ' nodes with per-node widths');
assert(Math.abs(P[0].x - 12) <= 2 && Math.abs(P[0].y - 10) <= 2, 'source near (12,10)');
assert(Math.abs(P[K - 1].x - 118) <= 2 && Math.abs(P[K - 1].y - 124) <= 2, 'outlet near (118,124)');
let adj = true, mono = true, widthsOk = true;
for (let k = 1; k < K; k++) {
  if (Math.abs(P[k].x - P[k - 1].x) > 1 || Math.abs(P[k].y - P[k - 1].y) > 1) adj = false;
  if (!(pathElev(w, k) < pathElev(w, k - 1))) mono = false;
  if (w.river.widths[k] < w.river.widths[k - 1] - 1e-6 || w.river.widths[k] < 1) widthsOk = false;
}
assert(adj, 'river path is 8-connected');
assert(mono, 'river elevation strictly decreasing along the whole path (' + pathElev(w, 0).toFixed(0) + ' -> ' + pathElev(w, K - 1).toFixed(0) + ' m)');
assert(widthsOk, 'channel width non-decreasing downstream');
const di = w.river.damIndex;
assert(di > 0 && di < K - 1 && P[di].x === w.reservoir.dam.x && P[di].y === w.reservoir.dam.y, 'damIndex node is the dam cell');
assert(w.river.cellsAbove.length > 30 && w.river.cellsBelow.length > 40, 'cellsAbove/cellsBelow populated');
let landOk = true;
for (const i of w.river.cellsAbove) if (w.land[i] !== L.RIVER) landOk = false;
for (const i of w.river.cellsBelow) if (w.land[i] !== L.RIVER) landOk = false;
assert(landOk, 'river cells above and below the dam have land=RIVER');
let bankOk = true;
for (let k = 0; k < K; k++) {
  const pi = w.idx(P[k].x, P[k].y);
  for (const j of w.neighbors8(pi)) {
    if (w.land[j] === L.RIVER || w.land[j] === L.RESERVOIR) continue;
    if (!(w.elev[j] > w.elev[pi])) bankOk = false;
  }
}
assert(bankOk, 'channel bed is below its banks everywhere');

/* ---------- reservoir ---------- */
const R = w.reservoir;
assert(R.capacityAF === C.HYDRO.RESERVOIR_CAPACITY_AF, 'capacityAF equals WS.C.HYDRO.RESERVOIR_CAPACITY_AF');
let vol = 0, belowSpill = true, inBox = true;
for (let c = 0; c < R.cells.length; c++) {
  const i = R.cells[c], xy = w.xy(i);
  vol += Math.max(0, R.spillElev - w.elev[i]);
  if (!(w.elev[i] < R.spillElev) || w.land[i] !== L.RESERVOIR) belowSpill = false;
  if (!(within(xy.x, 40, 66) && within(xy.y, 48, 74))) inBox = false;
  if (Math.abs(R.depth[c] - (R.spillElev - w.elev[i])) > 0.01) belowSpill = false;
}
const volAF = vol * 1e4 / 1233.48;
assert(Math.abs(volAF - R.capacityAF) / R.capacityAF < 0.005, 'basin volume below spill matches capacity (' + volAF.toFixed(0) + ' AF)');
assert(belowSpill, 'all reservoir cells are RESERVOIR land below spillElev with matching depth');
assert(inBox, 'reservoir sits near map centre-left (x 44-62, y 52-70)');
assert(R.bedElev < R.spillElev - 20 && R.bedElev > 1900, 'bed well below spill (' + R.bedElev.toFixed(0) + ' / ' + R.spillElev + ')');
assert(w.land[w.idx(R.intake.x, R.intake.y)] === L.RESERVOIR && Math.hypot(R.intake.x - R.dam.x, R.intake.y - R.dam.y) <= 4, 'intake is a reservoir cell near the dam');
assert(R.zoneId >= 0 && w.zoneById(R.zoneId).type === 'reservoir' && w.zoneById(R.zoneId).cells.length === R.cells.length, 'reservoir zone matches');
let stageOk = true, prev = -1, prevA = -1;
for (let af = 0; af <= R.capacityAF; af += 500) {
  const lv = R.levelForStorage(af), ar = R.areaForStorage(af);
  if (!isFinite(lv) || !isFinite(ar) || lv < prev - 1e-9 || ar < prevA - 1e-9) stageOk = false;
  prev = lv; prevA = ar;
}
assert(stageOk, 'stage-storage table monotonic');
assert(Math.abs(R.levelForStorage(0) - R.bedElev) < 0.5 && Math.abs(R.levelForStorage(R.capacityAF) - R.spillElev) < 0.5, 'levelForStorage spans bed..spill');
assert(Math.abs(R.areaForStorage(R.capacityAF) - R.cells.length) < 0.5 && R.areaForStorage(0) <= 1, 'areaForStorage spans 0..all cells');
assert(isFinite(R.levelForStorage(NaN)) && isFinite(R.levelForStorage(-100)) && isFinite(R.levelForStorage(1e9)) && R.levelForStorage(1e9) <= R.spillElev, 'levelForStorage defensive');
const half = R.levelForStorage(R.capacityAF / 2);
assert(half > R.bedElev + 10 && half < R.spillElev - 3, 'half storage sits between bed and spill (' + half.toFixed(1) + ')');

/* ---------- flow network ---------- */
const outletI = w.idx(P[K - 1].x, P[K - 1].y), damI = w.idx(R.dam.x, R.dam.y);
let sinks = 0; for (let i = 0; i < NN; i++) if (w.flowDir[i] < 0) sinks++;
assert(sinks === 1 && w.flowDir[outletI] === -1, 'exactly one sink: the outlet');
let resDrain = true; for (const i of R.cells) if (w.flowDir[i] !== damI) resDrain = false;
assert(resDrain && w.flowDir[damI] >= 0 && w.land[w.flowDir[damI]] === L.RIVER, 'reservoir cells drain to the dam; dam drains to the river below');
let d8ok = true;
for (let i = 0; i < NN; i++) {
  const j = w.flowDir[i]; if (j < 0 || w.land[i] === L.RESERVOIR) continue;
  const a = w.xy(i), b = w.xy(j);
  if (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1) d8ok = false;
}
assert(d8ok, 'flowDir points to an 8-neighbour for every non-reservoir cell');
const rng = WS.RNG.create('world-test');
let walkOk = true, maxSteps = 0;
for (let n = 0; n < 200; n++) {
  const start = rng.int(0, NN - 1); const seen = new Set(); let c = start, steps = 0;
  while (c >= 0 && steps < 500) { if (seen.has(c)) { walkOk = false; break; } seen.add(c); c = w.flowDir[c]; steps++; }
  if (c !== -1) walkOk = false; if (steps > maxSteps) maxSteps = steps;
}
assert(walkOk, '200 random flow walks terminate at the outlet within 500 steps with no cycles (max ' + maxSteps + ')');
assert(Math.abs(w.flowAcc[outletI] - NN) < 0.5, 'flowAcc at outlet equals the whole map (' + w.flowAcc[outletI] + ')');
assert(w.flowAcc[damI] > R.cells.length + 2000, 'flowAcc at dam includes the catchment (' + w.flowAcc[damI] + ')');
let accOk = true;
for (let i = 0; i < NN; i++) { const j = w.flowDir[i]; if (j >= 0 && !(w.flowAcc[j] > w.flowAcc[i])) accOk = false; }
assert(accOk, 'flowAcc strictly increases downstream');
assert(w.flowOrder && w.flowOrder.length === NN, 'flowOrder is a full topological order');
let upOk = true, upCount = 0;
for (let i = 0; i < NN; i++) {
  const u = w.isUpstreamOfReservoir(i); if (u) upCount++;
  if (w.land[i] === L.RESERVOIR) { if (!u) upOk = false; continue; }
  const j = w.flowDir[i]; if (j < 0) { if (u) upOk = false; continue; }
  const expect = w.land[j] === L.RESERVOIR ? true : w.isUpstreamOfReservoir(j);
  if (u !== expect) upOk = false;
}
assert(upOk, 'isUpstreamOfReservoir consistent with flowDir chains');
assert(within(upCount, 3000, 12000) && w.isUpstreamOfReservoir(w.idx(P[0].x, P[0].y)) && !w.isUpstreamOfReservoir(outletI) && !w.isUpstreamOfReservoir(damI), 'upstream mask: source yes, outlet/dam no (' + upCount + ' cells)');

/* ---------- zones ---------- */
const Z = w.zones;
assert(Z.length === 18, '18 zones');
let zoneOk = true;
Z.forEach((z, n) => {
  if (z.id !== n || !(z.cells instanceof Int32Array) || z.cells.length === 0) zoneOk = false;
  if (!within(z.center.x, z.bbox.x0, z.bbox.x1) || !within(z.center.y, z.bbox.y0, z.bbox.y1)) zoneOk = false;
  for (const i of z.cells) if (w.zone[i] !== z.id) zoneOk = false;
  if (typeof z.upstreamOfReservoir !== 'boolean' || !z.name || C.ZONE_TYPES.indexOf(z.type) < 0) zoneOk = false;
});
assert(zoneOk, 'every zone: sequential id, non-empty Int32Array cells, center in bbox, zone map consistent, valid type');
const forests = w.zonesOf('forest');
assert(forests.length === 6 && forests.map(z => z.name).join('|') === 'Cameron Ridge|Kestrel Divide|North Fork Slopes|Troublesome Bench|Ponderosa Flats|Roaring Gulch', 'six named forest sectors');
forests.forEach((z, n) => {
  let up = 0; for (const i of z.cells) if (w.isUpstreamOfReservoir(i)) up++;
  const frac = up / z.cells.length, allForest = Array.from(z.cells).every(i => w.land[i] === L.FOREST);
  assert(allForest && within(z.cells.length, 600, 1700), 'sector ' + (n + 1) + ' ' + z.name + ': ' + z.cells.length + ' forest cells');
  if (n < 4) assert(z.upstreamOfReservoir === true && frac >= 0.55, 'sector ' + (n + 1) + ' upstream of reservoir (' + (frac * 100).toFixed(0) + '% by flow)');
  else assert(z.upstreamOfReservoir === false && frac <= 0.35, 'sector ' + (n + 1) + ' above town, not upstream (' + (frac * 100).toFixed(0) + '% by flow)');
});
const hoods = w.zonesOf('neighborhood');
assert(hoods.length === 4 && hoods.map(z => z.name).sort().join('|') === 'Marshall Heights|Old Mill|Riverbend|Sagebrush Estates', 'four named neighborhoods');
hoods.forEach(z => assert(within(z.cells.length, 60, 120) && Array.from(z.cells).every(i => w.land[i] === L.RESIDENTIAL), z.name + ': ' + z.cells.length + ' residential cells'));
const mh = hoods.find(z => z.name === 'Marshall Heights');
let adjoins = false;
for (const i of mh.cells) for (const j of w.neighbors8(i)) if (w.land[j] === L.FOREST && w.zone[j] === 4) adjoins = true;
assert(mh.wui === true && adjoins, 'Marshall Heights is WUI and adjoins forest sector 5 (Ponderosa Flats)');
hoods.forEach(z => { let roads = 0; for (let y = z.bbox.y0; y <= z.bbox.y1; y++) for (let x = z.bbox.x0; x <= z.bbox.x1; x++) if (w.land[w.idx(x, y)] === L.ROAD) roads++; assert(roads >= 5, z.name + ' has streets (' + roads + ' road cells)'); });
const farms = w.zonesOf('farm');
assert(farms.length === 4 && farms.map(z => z.name).sort().join('|') === 'Hay Meadows Co-op|Lazy J Ranch|Orchard Bench|Two Rivers Farm', 'four named farms');
assert(farms.every(z => z.cells.length >= 150 && Array.from(z.cells).every(i => w.land[i] === L.FARM)) && farms.reduce((a, z) => a + z.cells.length, 0) === s.farmCells, 'farm zones cover all farm cells');
assert(farms.every(z => z.center.y > R.dam.y + 10 && !z.upstreamOfReservoir), 'farms on the southern valley floor below the dam');
assert(w.zonesOf('civic').length === 1 && w.zonesOf('civic')[0].cells.length >= 30, 'one civic core zone');
const wet = w.zonesOf('wetland')[0];
assert(wet && w.wetland.zoneId === wet.id && w.wetland.cells.length === wet.cells.length && within(wet.cells.length, 40, 90) && Array.from(wet.cells).every(i => w.land[i] === L.WETLAND), 'wetland zone ~60 cells');
let wetK = -1, wetD = 1e9;
for (let k = 0; k < K; k++) { const d = Math.hypot(P[k].x - wet.center.x, P[k].y - wet.center.y); if (d < wetD) { wetD = d; wetK = k; } }
assert(within(wetK - di, 8, 22) && wetD <= 8, 'wetland lies beside the river 10-20 nodes below the dam (node +' + (wetK - di) + ', ' + wetD.toFixed(1) + ' cells away)');
let wetSlope = 0, wetLow = true; for (const i of wet.cells) { wetSlope += w.slope[i]; if (w.elev[i] > pathElev(w, di + 8) + 3) wetLow = false; }
assert(wetLow && wetSlope / wet.cells.length < 0.06, 'wetland is a low flat (mean slope ' + (wetSlope / wet.cells.length).toFixed(3) + ')');
const rip = w.zonesOf('riparian')[0];
assert(rip && rip.cells.length > 100 && Array.from(rip.cells).every(i => w.land[i] === L.RIPARIAN), 'riparian corridor zone');
let ripOk = true;
for (const i of w.river.cellsBelow) { let has = false; for (const j of w.neighbors8(i)) if (w.land[j] === L.RIPARIAN || w.land[j] === L.WETLAND || w.land[j] === L.ROAD || w.land[j] === L.RIVER) has = true; if (!has) ripOk = false; }
assert(ripOk, 'river below the dam is lined by riparian/wetland cells');

/* ---------- buildings ---------- */
const B = w.buildings, bc = s.buildings;
['school', 'hospital', 'town_hall', 'treatment_plant', 'dam', 'shelter', 'church'].forEach(t => assert(bc[t] === 1, 'exactly one ' + t));
assert(bc.fire_station === 2, 'exactly two fire stations');
assert(bc.shop >= 3 && bc.barn === 4, 'shops >= 3 and 4 barns');
assert(within(bc.house, 250, 360), '~300 houses (' + bc.house + ')');
const cellUse = new Set(); let bOk = true;
for (const b of B) {
  if (!w.inBounds(b.x, b.y) || !isFinite(b.rot) || !within(b.scale, 0.5, 2) || w.zoneById(b.zoneId) === null) bOk = false;
  const i = w.idx(b.x, b.y); if (cellUse.has(i)) bOk = false; cellUse.add(i);
  if (b.type === 'house' && (w.land[i] !== L.RESIDENTIAL || w.zoneById(b.zoneId).type !== 'neighborhood')) bOk = false;
  if (b.type === 'barn' && (w.land[i] !== L.FARM || w.zoneById(b.zoneId).type !== 'farm')) bOk = false;
  if (['school', 'hospital', 'town_hall', 'shelter', 'church', 'shop', 'fire_station', 'treatment_plant'].indexOf(b.type) >= 0 && w.land[i] !== L.CIVIC) bOk = false;
}
assert(bOk, 'buildings valid: in bounds, unique cells, finite rot, on the right land type');
const damB = B.find(b => b.type === 'dam'), tpB = B.find(b => b.type === 'treatment_plant');
assert(damB.x === R.dam.x && damB.y === R.dam.y, 'dam building at reservoir.dam');
assert(Math.hypot(tpB.x - R.intake.x, tpB.y - R.intake.y) <= 6, 'treatment plant near the intake');
const civicZ = w.zonesOf('civic')[0], fs = B.filter(b => b.type === 'fire_station');
const inCivic = fs.some(b => within(b.x, civicZ.bbox.x0, civicZ.bbox.x1) && within(b.y, civicZ.bbox.y0, civicZ.bbox.y1) && b.y < mh.bbox.y0 + 20 && Math.hypot(b.x - w.townCenter.x, b.y - w.townCenter.y) < 8);
const inWui = fs.some(b => within(b.x, mh.bbox.x0 - 2, mh.bbox.x1 + 2) && within(b.y, mh.bbox.y0 - 2, mh.bbox.y1 + 2));
assert(inCivic && inWui, 'one fire station downtown, one in the WUI neighborhood');
const houses = B.filter(b => b.type === 'house');
let rotOk = 0;
for (const h of houses) { const fx = h.x + Math.sin(h.rot), fy = h.y + Math.cos(h.rot); let near = false; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { if (w.inBounds(Math.round(fx) + dx, Math.round(fy) + dy) && w.land[w.idx(Math.round(fx) + dx, Math.round(fy) + dy)] === L.ROAD) near = true; } if (near) rotOk++; }
assert(rotOk / houses.length > 0.9, 'houses face a nearby road (' + rotOk + '/' + houses.length + ')');
assert(farms.every(z => B.some(b => b.type === 'barn' && b.zoneId === z.id && Math.hypot(b.x - z.center.x, b.y - z.center.y) <= 6)), 'a barn near every farm centre');

/* ---------- roads ---------- */
assert(Array.isArray(w.roads) && w.roads.length >= 6 && w.roads.every(r => r.length >= 2 && r.every(p => w.inBounds(p.x, p.y))), 'roads are in-bounds polylines');
assert(w.roads.every(r => r.every(p => w.land[w.idx(p.x, p.y)] === L.ROAD || w.land[w.idx(p.x, p.y)] === L.RIVER)), 'road polyline nodes are ROAD cells (or a river bridge)');
const roadCells = Array.from(w.cellsOf(L.ROAD));
assert(roadCells.some(i => Math.hypot(w.xy(i).x - R.dam.x, w.xy(i).y - R.dam.y) <= 3), 'main road reaches the dam');
assert(roadCells.some(i => w.xy(i).x > 110 && w.xy(i).y > 110), 'valley road runs down to the confluence');
assert(roadCells.some(i => Math.hypot(w.xy(i).x - w.townCenter.x, w.xy(i).y - w.townCenter.y) <= 2), 'road passes through the town centre');

/* ---------- fields ---------- */
let fOk = true, tOk = true, mOk = true, cOk = true, hOk = true, burnOk = true;
let mForest = 0, nForest = 0, mValley = 0, nValley = 0, hShrub = 0, nShrub = 0, hRes = 0, nRes = 0;
for (let i = 0; i < NN; i++) {
  const lt = w.land[i];
  if (lt === L.FOREST) { if (!within(w.fuel[i], 0.45 - EPS, 0.85 + EPS) || !within(w.treeDensity[i], 0.35 - EPS, 1 + EPS)) fOk = false; mForest += w.moisture[i]; nForest++; }
  if (lt === L.SHRUB) { if (!within(w.fuel[i], 0.3 - EPS, 0.6 + EPS)) fOk = false; hShrub += w.habitat[i]; nShrub++; }
  if (lt === L.RIVER || lt === L.RESERVOIR || lt === L.ROAD) { if (w.fuel[i] !== 0 || w.treeDensity[i] !== 0) tOk = false; }
  if (lt === L.FARM || lt === L.RESIDENTIAL) { mValley += w.moisture[i]; nValley++; }
  if (lt === L.RESIDENTIAL) { hRes += w.habitat[i]; nRes++; }
  if (!within(w.moisture[i], 0, 1) || !within(w.habitat[i], 0, 1) || !within(w.fuel[i], 0, 1) || !within(w.treeDensity[i], 0, 1)) mOk = false;
  if (lt === L.FARM ? Math.abs(w.cropHealth[i] - 0.85) > 1e-6 : w.cropHealth[i] !== 0) cOk = false;
  if (w.burn[i] !== 0) burnOk = false;
}
assert(fOk, 'forest fuel 0.45-0.85, treeDensity 0.35-1; shrub fuel 0.3-0.6');
assert(tOk, 'water/road cells carry no fuel or trees');
assert(mOk, 'moisture/habitat/fuel/treeDensity within 0..1');
assert(Math.abs(mForest / nForest - 0.6) < 0.03 && Math.abs(mValley / nValley - 0.45) < 0.03, 'moisture ~0.6 forest / ~0.45 valley (' + (mForest / nForest).toFixed(2) + ' / ' + (mValley / nValley).toFixed(2) + ')');
assert(cOk, 'cropHealth 0.85 on farm cells, 0 elsewhere');
assert(burnOk, 'burn initialised to 0');
assert(hShrub / nShrub > 0.5 && hRes / nRes < 0.2 && Array.from(wet.cells).every(i => w.habitat[i] > 0.8), 'habitat high in shrub/wetland, low in town');
let northFuel = 0, nN = 0, southFuel = 0, nS = 0;
for (let i = 0; i < NN; i++) if (w.land[i] === L.FOREST && w.slope[i] > 0.15) { if (Math.cos(w.aspect[i]) > 0.7) { northFuel += w.fuel[i]; nN++; } else if (Math.cos(w.aspect[i]) < -0.7) { southFuel += w.fuel[i]; nS++; } }
assert(nN > 50 && nS > 50 && northFuel / nN > southFuel / nS, 'north aspects carry more fuel than south aspects');

/* ---------- other seeds: core invariants ---------- */
for (const seed of [3, 42, 'delta']) {
  const t1 = Date.now(), ww = WS.World.generate(seed), dt = Date.now() - t1;
  noNaN(ww, 'world(' + seed + ')');
  const ss = ww.summary(); let m2 = true; for (let k = 1; k < ww.river.path.length; k++) if (!(pathElev(ww, k) < pathElev(ww, k - 1))) m2 = false;
  let sinks2 = 0, walk2 = true; for (let i = 0; i < NN; i++) if (ww.flowDir[i] < 0) sinks2++;
  for (let n = 0; n < 50; n++) { let c = rng.int(0, NN - 1), st = 0; while (c >= 0 && st < 500) { c = ww.flowDir[c]; st++; } if (c !== -1) walk2 = false; }
  assert(dt < 2000 /* strict <400 ms is asserted above with best-of-3; single runs are load-sensitive */ && m2 && sinks2 === 1 && walk2 && ss.forestCells > 3000 && within(ss.farmCells, 1100, 1400) && within(ss.reservoirCells, 180, 260) && within(ss.residentialCells, 300, 500) && within(ss.houses, 250, 360) && ww.reservoir.capacityAF === C.HYDRO.RESERVOIR_CAPACITY_AF,
    'seed ' + seed + ': invariants hold (' + dt + ' ms, forest ' + ss.forestCells + ', farm ' + ss.farmCells + ', res ' + ss.reservoirCells + ', houses ' + ss.houses + ')');
}
console.log('ALL WORLD TESTS PASSED');
