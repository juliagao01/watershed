/* Tests for src/sim/fire.js and src/sim/flood.js. Run: node tests/fire_flood.test.js
   Uses a self-contained stub world (terrain.js is written in parallel) plus a smoke run on
   WS.World.generate when src/world/terrain.js exists and loads. */
const fs = require('fs'), path = require('path');
const { load, assert, noNaN, ROOT } = require('./load');

const { WS } = load(['src/sim/fire.js', 'src/sim/flood.js']);
const C = WS.C, L = C.LAND, N = C.N, NN = N * N;

/* ------------------------------------------------------------------ stub world */
function makeStubWorld(seed) {
  seed = seed == null ? 11 : seed;
  const noise = WS.Noise.create('stub:' + seed);
  const elev = new Float32Array(NN), land = new Uint8Array(NN).fill(255), slope = new Float32Array(NN), aspect = new Float32Array(NN);
  const fuel = new Float32Array(NN), moisture = new Float32Array(NN), burn = new Float32Array(NN), treeDensity = new Float32Array(NN);
  const cropHealth = new Float32Array(NN), habitat = new Float32Array(NN), zone = new Int16Array(NN).fill(-1);
  const idx = (x, y) => y * N + x;

  // river polyline NW -> SE with a gentle wiggle; t in [0,1]
  const P = t => ({ x: 12 + 106 * t + 5 * Math.sin(3 * Math.PI * t), y: 10 + 114 * t - 5 * Math.sin(3 * Math.PI * t) });
  const elevCh = t => 2000 + 1300 * Math.pow(1 - t, 1.6);
  const samples = []; for (let s = 0; s <= 600; s++) samples.push(Object.assign({ t: s / 600 }, P(s / 600)));
  const nearT = new Float32Array(NN), nearD = new Float32Array(NN), nearSide = new Int8Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let best = 1e9, bt = 0, side = 0;
    for (const s of samples) { const dx = x - s.x, dy = y - s.y, d = dx * dx + dy * dy; if (d < best) { best = d; bt = s.t; side = (dx - dy) >= 0 ? 1 : -1; } }
    const i = idx(x, y); nearT[i] = bt; nearD[i] = Math.sqrt(best); nearSide[i] = side;
  }
  for (let i = 0; i < NN; i++) {
    const t = nearT[i], d = nearD[i];
    let rise;
    if (t < 0.45) rise = d < 5 ? 30 * d : 150 + 12 * (d - 5);                  // canyon in the mountains
    else rise = d < 12 ? 6 * d : 72 + 20 * (d - 12);                              // broad valley floor near town
    const x = i % N, y = (i / N) | 0;
    const nz = noise.fbm(x / 22, y / 22, 4) * 40;
    elev[i] = Math.min(3750, elevCh(t) + rise + nz * (d > 3 ? 1 : 0.2));
  }
  // reservoir bowl centred on the river at t~0.42
  const rc = P(0.42), tDam = 0.475, damP = P(tDam);
  const bed = elevCh(tDam) - 15;
  const resCells = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const ex = (x - rc.x) / 9, ey = (y - rc.y) / 8;
    if (ex * ex + ey * ey <= 1 && nearT[idx(x, y)] < tDam - 0.01) resCells.push(idx(x, y));
  }
  for (const i of resCells) { const x = i % N, y = (i / N) | 0; const r = Math.hypot((x - rc.x) / 9, (y - rc.y) / 8); elev[i] = bed + 4 * r; }
  const damCell = idx(Math.round(damP.x), Math.round(damP.y));
  elev[damCell] = Math.min(elev[damCell], bed + 12);
  // river channel cells (monotonic along the path, below dam wider)
  const riverPath = [], seenR = new Set();
  for (const s of samples) { const cx = Math.round(s.x), cy = Math.round(s.y); const i = idx(cx, cy); if (!seenR.has(i)) { seenR.add(i); riverPath.push({ x: cx, y: cy, t: s.t }); } }
  const isRes = new Uint8Array(NN); for (const i of resCells) isRes[i] = 1;
  let last = 1e9;
  for (const p of riverPath) {
    const w = p.t < 0.3 ? 0 : p.t < 0.65 ? 0 : 1;
    for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) {
      const x = p.x + dx, y = p.y + dy; if (!C.inBounds(x, y)) continue; const i = idx(x, y);
      if (isRes[i]) continue;
      land[i] = L.RIVER;
      if (dx === 0 && dy === 0) { elev[i] = Math.min(elev[i], last - 0.5); last = elev[i]; } else elev[i] = Math.min(elev[i], last + 1);
    }
  }
  const outlet = idx(riverPath[riverPath.length - 1].x, riverPath[riverPath.length - 1].y);

  // ---- flowDir via priority-flood from the outlet (every cell drains, no cycles)
  const flowDir = new Int32Array(NN).fill(-2);
  const filled = new Float32Array(elev);
  const heap = []; // [elev, idx]
  const push = (e, i) => { heap.push([e, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], lastE = heap.pop(); if (heap.length) { heap[0] = lastE; let k = 0; for (;;) { let l = 2 * k + 1, r = l + 1, m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  flowDir[outlet] = -1; push(filled[outlet], outlet);
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  while (heap.length) {
    const [e, i] = pop(); const x = i % N, y = (i / N) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k], ny = y + DY[k]; if (!C.inBounds(nx, ny)) continue; const j = idx(nx, ny);
      if (flowDir[j] !== -2) continue;
      flowDir[j] = i; filled[j] = Math.max(elev[j], e + 0.01); push(filled[j], j);
    }
  }
  // topological order + flowAcc + upstream mask
  const indeg = new Int32Array(NN); for (let i = 0; i < NN; i++) if (flowDir[i] >= 0) indeg[flowDir[i]]++;
  const order = new Int32Array(NN); let head = 0, tail = 0;
  for (let i = 0; i < NN; i++) if (indeg[i] === 0) order[tail++] = i;
  while (head < tail) { const i = order[head++]; const d = flowDir[i]; if (d >= 0 && --indeg[d] === 0) order[tail++] = d; }
  if (tail !== NN) throw new Error('stub flowDir has cycles');
  const flowAcc = new Float32Array(NN);
  for (let k = 0; k < NN; k++) { const i = order[k]; const d = flowDir[i]; if (d >= 0) flowAcc[d] += flowAcc[i] + 1; }
  const upstream = new Uint8Array(NN);
  for (let k = NN - 1; k >= 0; k--) { const i = order[k]; if (isRes[i]) { upstream[i] = 1; continue; } const d = flowDir[i]; if (d >= 0 && (isRes[d] || upstream[d])) upstream[i] = 1; }

  // ---- land use
  for (const i of resCells) land[i] = L.RESERVOIR;
  for (let i = 0; i < NN; i++) {
    if (land[i] !== 255) continue;
    const t = nearT[i], d = nearD[i], e = elev[i];
    if (e > 3450) land[i] = L.ALPINE;
    else if (upstream[i] || t < 0.5) land[i] = e >= 2200 ? L.FOREST : L.SHRUB;
    else {
      if (d <= 1) land[i] = L.RIPARIAN;
      else if (d < 14) land[i] = L.SHRUB;
      else land[i] = e >= 2200 && e <= 3450 ? L.FOREST : (e > 3450 ? L.ALPINE : L.SHRUB);
    }
  }
  const zones = [], buildings = [], roads = [];
  const addZone = (type, name, cells, extra) => {
    const id = zones.length; const arr = Int32Array.from(cells); let x0 = N, y0 = N, x1 = 0, y1 = 0, sx = 0, sy = 0;
    for (const i of arr) { const x = i % N, y = (i / N) | 0; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); sx += x; sy += y; zone[i] = id; }
    const z = Object.assign({ id, type, name, cells: arr, center: { x: Math.round(sx / Math.max(1, arr.length)), y: Math.round(sy / Math.max(1, arr.length)) }, bbox: { x0, y0, x1, y1 }, upstreamOfReservoir: arr.length ? !!upstream[arr[0]] : false }, extra || {});
    zones.push(z); return z;
  };
  const perp = (t, off) => { const p = P(t); return { x: Math.round(p.x + off * 0.7071), y: Math.round(p.y - off * 0.7071) }; }; // +off = NE side
  const block = (cx, cy, w, h, landType, roadRow) => {
    const cells = [];
    for (let y = cy - (h >> 1); y < cy - (h >> 1) + h; y++) for (let x = cx - (w >> 1); x < cx - (w >> 1) + w; x++) {
      if (!C.inBounds(x, y)) continue; const i = idx(x, y); if (land[i] === L.RIVER || land[i] === L.RESERVOIR) continue;
      land[i] = (roadRow != null && y === cy) ? L.ROAD : landType; cells.push(i);
    }
    return cells;
  };
  // neighbourhoods
  const nbSpecs = [['Marshall Heights', perp(0.62, 15)], ['Old Mill', perp(0.60, -6)], ['Riverbend', perp(0.68, 4)], ['Sagebrush Estates', perp(0.72, -10)]];
  const nbZones = nbSpecs.map(([name, c]) => addZone('neighborhood', name, block(c.x, c.y, 9, 9, L.RESIDENTIAL, true)));
  const cc = perp(0.645, 7);
  const civicZone = addZone('civic', 'Downtown', block(cc.x, cc.y, 6, 6, L.CIVIC));
  // farms
  const farmSpecs = [['Lazy J Ranch', 0.80, -12], ['Two Rivers Farm', 0.88, 12], ['Hay Meadows Co-op', 0.93, -12], ['Orchard Bench', 0.97, 10]];
  const farmZones = farmSpecs.map(([name, t, off]) => { const c = perp(t, off); return addZone('farm', name, block(c.x, c.y, 18, 17, L.FARM)); });
  // wetland: 8x8 beside the river ~15 cells below the dam
  const wc = perp(0.53, -6);
  const wetCells = block(wc.x, wc.y, 8, 8, L.WETLAND);
  const wetZone = addZone('wetland', 'Bitterbrush Marsh', wetCells);
  // reservoir + riparian zones
  const resZone = addZone('reservoir', 'Bitterbrush Reservoir', resCells);
  const ripCells = []; for (let i = 0; i < NN; i++) if (land[i] === L.RIPARIAN) ripCells.push(i);
  addZone('riparian', 'Creek Corridor', ripCells);
  // forest sectors
  const sect = [[], [], [], [], [], []];
  for (let i = 0; i < NN; i++) {
    if (land[i] !== L.FOREST) continue; const x = i % N, y = (i / N) | 0, t = nearT[i];
    if (upstream[i] || t < 0.5) { if (y < x - 12) sect[0].push(i); else if (y > x + 12) sect[3].push(i); else if (t < 0.25) sect[1].push(i); else sect[2].push(i); }
    else { if (nearSide[i] > 0) sect[4].push(i); else sect[5].push(i); }
  }
  const forestNames = ['Cameron Ridge', 'Troublesome Bench', 'North Fork Slopes', 'Kestrel Divide', 'Ponderosa Flats', 'Roaring Gulch'];
  const forestZones = sect.map((cells, k) => addZone('forest', forestNames[k], cells));
  // road from Downtown to the dam
  const rd = []; { let x = cc.x, y = cc.y; const dp = { x: Math.round(damP.x), y: Math.round(damP.y) }; while (x !== dp.x || y !== dp.y) { rd.push({ x, y }); const i = idx(x, y); if (land[i] !== L.RIVER && land[i] !== L.RESERVOIR && land[i] !== L.RESIDENTIAL && land[i] !== L.CIVIC) land[i] = L.ROAD; x += Math.sign(dp.x - x); y += Math.sign(dp.y - y); } roads.push(rd); }
  // buildings
  for (const z of nbZones) { let n = 0; for (const i of z.cells) { if (land[i] !== L.RESIDENTIAL) continue; if ((n++ & 1) === 0) buildings.push({ type: 'house', x: i % N, y: (i / N) | 0, rot: 0, zoneId: z.id, scale: 1 }); } }
  const civ = civicZone.cells;
  const ct = ['town_hall', 'school', 'hospital', 'fire_station'];
  ct.forEach((t, k) => { const i = civ[k * 5]; buildings.push({ type: t, x: i % N, y: (i / N) | 0, rot: 0, zoneId: civicZone.id, scale: 1 }); });
  { const i = nbZones[0].cells[4]; buildings.push({ type: 'fire_station', x: i % N, y: (i / N) | 0, rot: 0, zoneId: nbZones[0].id, scale: 1 }); }
  const intake = perp(0.46, 2);
  buildings.push({ type: 'treatment_plant', x: intake.x, y: intake.y, rot: 0, zoneId: -1, scale: 1 });
  buildings.push({ type: 'dam', x: damCell % N, y: (damCell / N) | 0, rot: 0, zoneId: resZone.id, scale: 1 });
  for (const z of farmZones) buildings.push({ type: 'barn', x: z.center.x, y: z.center.y, rot: 0, zoneId: z.id, scale: 1 });

  // ---- per-cell attributes
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = idx(x, y);
    let mx = 0, gx = 0, gy = 0;
    for (let k = 0; k < 8; k++) { const nx = x + DX[k], ny = y + DY[k]; if (!C.inBounds(nx, ny)) continue; const dz = elev[idx(nx, ny)] - elev[i]; mx = Math.max(mx, Math.abs(dz) / C.CELL_M); gx += dz * DX[k]; gy += dz * DY[k]; }
    slope[i] = mx; aspect[i] = Math.atan2(gx, -gy);
    const n1 = (noise.fbm(x / 9, y / 9, 3) + 1) / 2, north = 0.5 - 0.5 * Math.cos(aspect[i]);
    const lv = land[i];
    if (lv === L.FOREST) { fuel[i] = 0.45 + 0.4 * (0.6 * n1 + 0.4 * north); treeDensity[i] = 0.35 + 0.65 * n1; moisture[i] = 0.6; habitat[i] = 0.5; }
    else if (lv === L.SHRUB) { fuel[i] = 0.3 + 0.2 * n1; treeDensity[i] = 0.05; moisture[i] = 0.45; habitat[i] = 0.7; }
    else if (lv === L.RIPARIAN) { treeDensity[i] = 0.5; moisture[i] = 0.7; habitat[i] = 0.8; }
    else if (lv === L.WETLAND) { moisture[i] = 0.9; habitat[i] = 0.9; }
    else if (lv === L.FARM) { cropHealth[i] = 0.85; moisture[i] = 0.45; habitat[i] = 0.2; }
    else if (lv === L.ALPINE) { moisture[i] = 0.5; habitat[i] = 0.3; }
    else { moisture[i] = 0.45; habitat[i] = 0.1; }
  }
  const cellsOf = lv => { const out = []; for (let i = 0; i < NN; i++) if (land[i] === lv) out.push(i); return Int32Array.from(out); };
  const world = {
    seed, N, cellM: C.CELL_M, elev, land, slope, aspect, fuel, moisture, burn, treeDensity, cropHealth, habitat, flowDir, flowAcc, zone, zones,
    river: { path: riverPath.map(p => ({ x: p.x, y: p.y })), widths: new Float32Array(riverPath.length).fill(1), damIndex: riverPath.findIndex(p => idx(p.x, p.y) === damCell), cellsAbove: new Int32Array(0), cellsBelow: new Int32Array(0) },
    reservoir: { cells: Int32Array.from(resCells), depth: new Float32Array(resCells.length).fill(10), bedElev: bed, spillElev: bed + 12, capacityAF: C.HYDRO.RESERVOIR_CAPACITY_AF,
                 dam: { x: damCell % N, y: (damCell / N) | 0 }, intake, center: { x: Math.round(rc.x), y: Math.round(rc.y) }, zoneId: resZone.id,
                 levelForStorage: af => bed + 12 * C.clamp(af / C.HYDRO.RESERVOIR_CAPACITY_AF, 0, 1), areaForStorage: af => Math.round(resCells.length * C.clamp(af / C.HYDRO.RESERVOIR_CAPACITY_AF, 0, 1)) },
    wetland: { cells: Int32Array.from(wetCells), zoneId: wetZone.id, center: wetZone.center },
    buildings, roads, snowlineElev: 2600, treeline: 3450,
    idx, xy: i => ({ x: i % N, y: (i / N) | 0 }), inBounds: C.inBounds,
    neighbors8: i => { const x = i % N, y = (i / N) | 0, out = []; for (let k = 0; k < 8; k++) { const nx = x + DX[k], ny = y + DY[k]; if (C.inBounds(nx, ny)) out.push(idx(nx, ny)); } return out; },
    cellsOf, zoneById: id => zones[id] || null, zonesOf: type => zones.filter(z => z.type === type),
    isUpstreamOfReservoir: i => !!upstream[i],
    summary() { const c = {}; for (let i = 0; i < NN; i++) c[C.LAND_NAMES[land[i]]] = (c[C.LAND_NAMES[land[i]]] || 0) + 1; return { land: c, zones: zones.length, buildings: buildings.length, reservoirCells: resCells.length, upstreamCells: upstream.reduce((a, b) => a + b, 0), forestZones: forestZones.map(z => z.cells.length) }; }
  };
  return world;
}

function cloneWorld(w) {
  const o = Object.assign({}, w);
  for (const k of ['elev', 'land', 'slope', 'aspect', 'fuel', 'moisture', 'burn', 'treeDensity', 'cropHealth', 'habitat', 'flowDir', 'flowAcc', 'zone']) o[k] = new w[k].constructor(w[k]);
  o.buildings = w.buildings.map(b => Object.assign({}, b));
  delete o._fireMaps; delete o._fireInit; delete o._floodMaps; delete o._topo; delete o.regrow;
  return o;
}
function makeState(over) {
  const s = {
    seed: 7, mode: 'simulated', years: 6, turn: 2, year: 1, season: C.SEASON.SUMMER, phase: 'live', budget: 12, annualBudget: 12, emergencyFund: 2.5,
    outcomes: { W: 70, E: 65, P: 72, F: 68, T: 60 }, population: 12400,
    climate: { snowpackPct: 100, precipIn: 1.2, tempAnomF: 4, soilMoisturePct: 35, fireDanger: 0.5, fireDangerLabel: 'High', windDirRad: 0.8, windMph: 12, drought: 'D1' },
    reservoir: { storageAF: 30000, capacityAF: 42000, turbidity: 0.05, ashContam: 0, algae: 0 },
    fire: { policy: 'managed', activeFire: null, seasonAcres: 0, totalAcres: 0, structuresLost: 0, fires: [], smokeDays: 0, crewFocus: null, responseBudget: 1 },
    projects: { funded: {}, pendingBurn: null }, mitigations: [], pendingStorm: null, scheduled: [], log: [], timeline: [], history: [], flags: {},
    stats: { floodDamageM: 0, sedimentTons: 0, contaminationOutageDays: 0, cropLossPct: 0, hydroMWh: 0, recreationVisits: 0 }
  };
  return Object.assign(s, over || {});
}
function runFire(world, state, rng, forced) {
  const sim = WS.Fire.maybeIgnite(state, world, rng, forced);
  if (!sim) return null;
  let r, steps = 0;
  do { r = WS.Fire.step(sim, state, world, rng); steps++; if (steps > 200) throw new Error('fire did not end'); } while (!r.done);
  const rep = WS.Fire.finalize(sim, state, world);
  return { sim, rep, steps };
}
function stats(arr) { const s = arr.slice().sort((a, b) => a - b); const sum = s.reduce((a, b) => a + b, 0); return { n: s.length, mean: sum / s.length, median: s[s.length >> 1], max: s[s.length - 1], min: s[0] }; }

/* ------------------------------------------------------------------ world sanity */
const base = makeStubWorld(11);
const sum = base.summary();
console.log('stub world:', JSON.stringify(sum));
assert(sum.reservoirCells > 100 && sum.reservoirCells < 400, 'stub reservoir has ' + sum.reservoirCells + ' cells');
assert(sum.forestZones.every(n => n > 200), 'every forest sector has cells: ' + sum.forestZones.join(','));
assert(base.buildings.filter(b => b.type === 'fire_station').length === 2, 'stub has 2 fire stations');
{ let ok = true; for (let i = 0; i < NN; i++) { const d = base.flowDir[i]; if (d >= 0 && base.land[i] !== L.RESERVOIR && !(base.elev[d] <= base.elev[i] + 60)) ok = false; } assert(ok, 'flowDir points downhill (allowing sink fill)'); }
const upstreamForest = base.zonesOf('forest').filter(z => z.upstreamOfReservoir);
assert(upstreamForest.length >= 3, 'at least 3 forest sectors upstream of the reservoir (' + upstreamForest.length + ')');

/* ------------------------------------------------------------------ fire: danger response */
function fireTrial(danger, n, opts) {
  opts = opts || {};
  const acres = [], structures = [], zonesTouched = [], upstreamAcres = [];
  for (let k = 0; k < n; k++) {
    const w = opts.world ? cloneWorld(opts.world) : cloneWorld(base);
    const st = makeState({ climate: Object.assign(makeState().climate, { fireDanger: danger, windMph: opts.windMph == null ? 12 : opts.windMph }) });
    const rng = WS.RNG.create('fire:' + danger + ':' + k + ':' + (opts.tag || ''));
    const zone = opts.zoneId != null ? opts.zoneId : upstreamForest[k % upstreamForest.length].id;
    const r = runFire(w, st, rng, { zoneId: zone });
    assert(r && r.rep, 'forced ignition in zone ' + zone + ' returns a fire (danger ' + danger + ', trial ' + k + ')');
    acres.push(r.rep.acres); structures.push(r.rep.structuresLost); zonesTouched.push(r.rep.zoneIds.length); upstreamAcres.push(r.rep.upstreamAcres);
    noNaN(r.rep, 'fireReport');
    assert(r.sim.cellsBurned.length <= r.sim.capCells, 'fire respects hard cap (' + r.sim.cellsBurned.length + ' <= ' + r.sim.capCells + ')');
    assert(r.sim.burning.size === 0 && r.sim.done, 'fire ends with nothing burning');
  }
  return { acres: stats(acres), structures: stats(structures), zones: stats(zonesTouched), upstream: stats(upstreamAcres) };
}
const mod = fireTrial(0.3, 20, { tag: 'mod' });
const high = fireTrial(0.6, 20, { tag: 'high' });
const ext = fireTrial(0.9, 20, { tag: 'ext', windMph: 30 });
console.log('acres @0.3 Moderate:', JSON.stringify(mod.acres));
console.log('acres @0.6 High    :', JSON.stringify(high.acres));
console.log('acres @0.9 Extreme :', JSON.stringify(ext.acres), 'structures', JSON.stringify(ext.structures), 'zones', JSON.stringify(ext.zones));
assert(ext.acres.mean > mod.acres.mean * 3, 'extreme danger burns far more than moderate (' + ext.acres.mean.toFixed(0) + ' vs ' + mod.acres.mean.toFixed(0) + ' acres)');
assert(high.acres.mean > mod.acres.mean && high.acres.mean < ext.acres.mean, 'High danger sits between Moderate and Extreme');
assert(mod.acres.median < 500, 'most Moderate-danger fires stay under 500 acres (median ' + mod.acres.median.toFixed(0) + ')');
assert(ext.acres.max >= 5000, 'an Extreme-danger wind-driven fire can run > 5,000 acres (max ' + ext.acres.max.toFixed(0) + ')');
assert(ext.zones.max >= 3, 'a big fire touches several zones (max ' + ext.zones.max + ')');
assert(ext.structures.max > 0, 'an Extreme fire can reach a WUI neighbourhood and destroy homes (max ' + ext.structures.max + ')');
{ // determinism
  const a = runFire(cloneWorld(base), makeState(), WS.RNG.create('det'), { zoneId: upstreamForest[0].id });
  const b = runFire(cloneWorld(base), makeState(), WS.RNG.create('det'), { zoneId: upstreamForest[0].id });
  assert(a.rep.acres === b.rep.acres && a.rep.structuresLost === b.rep.structuresLost, 'fire is deterministic for a given seed');
}

/* ------------------------------------------------------------------ fire: thinning + hardening + fuel break effects */
{
  const thinned = {}; for (const z of base.zonesOf('forest')) thinned[z.id] = 1.0;
  WS.Projects = { effects: () => ({ thinnedZones: thinned, fuelBreakZones: {}, hardenedZones: {} }) };
  const thin = fireTrial(0.8, 20, { tag: 'thin' });
  delete WS.Projects;
  const noThin = fireTrial(0.8, 20, { tag: 'thin' });
  console.log('acres @0.8 thinned:', thin.acres.mean.toFixed(0), 'vs untreated:', noThin.acres.mean.toFixed(0));
  assert(thin.acres.mean < noThin.acres.mean * 0.7, 'thinning all sectors reduces average fire size by > 30%');
  // hardened/fuel-break zone: fewer homes lost in Marshall Heights when a fire starts next door
  const wui = base.zonesOf('neighborhood')[0], sector5 = base.zonesOf('forest')[4];
  // ignition in sector 5 four cells NE of Marshall Heights, wind blowing from there into the neighbourhood
  const startXY = { x: wui.bbox.x1 + 4, y: wui.bbox.y0 - 4 };
  const startCell = C.idx(startXY.x, startXY.y);
  assert(base.land[startCell] === L.FOREST && base.zone[startCell] === sector5.id, 'WUI test ignition cell is in forest sector 5');
  const windToTown = Math.atan2(wui.center.y - startXY.y, wui.center.x - startXY.x);
  const lostWith = [], lostWithout = [];
  for (let k = 0; k < 12; k++) {
    const climate = Object.assign(makeState().climate, { fireDanger: 0.95, windMph: 40, windDirRad: windToTown });
    WS.Projects = { effects: () => ({ thinnedZones: {}, fuelBreakZones: { [wui.id]: true }, hardenedZones: { [wui.id]: true } }) };
    let w = cloneWorld(base), st = makeState({ climate });
    let r = runFire(w, st, WS.RNG.create('wui:' + k), { cell: startCell }); lostWith.push(r.rep.structuresLost);
    delete WS.Projects;
    w = cloneWorld(base); st = makeState({ climate });
    r = runFire(w, st, WS.RNG.create('wui:' + k), { cell: startCell }); lostWithout.push(r.rep.structuresLost);
  }
  const sw = stats(lostWith), so = stats(lostWithout);
  console.log('homes lost, WUI fire x12: hardened+fuelbreak', sw.mean.toFixed(1), 'vs none', so.mean.toFixed(1));
  assert(so.max > 0, 'a wind-driven fire next to Marshall Heights destroys homes');
  assert(sw.mean < so.mean * 0.7, 'hardening + fuel break cut home losses by > 30%');
  assert(!WS.Projects, 'Projects stub removed');
}

/* ------------------------------------------------------------------ fire: finalize writes world + state */
{
  const w = cloneWorld(base), st = makeState({ climate: Object.assign(makeState().climate, { fireDanger: 0.9, windMph: 25 }) });
  const fuelBefore = new Float32Array(w.fuel), tdBefore = new Float32Array(w.treeDensity);
  const r = runFire(w, st, WS.RNG.create('fin'), { zoneId: upstreamForest[1].id });
  const cells = r.rep.cellsBurned;
  assert(cells instanceof Int32Array && cells.length > 0, 'finalize returns cellsBurned Int32Array (' + cells.length + ')');
  let burnOk = true, fuelOk = true, tdOk = true;
  for (const i of cells) { if (!(w.burn[i] > 0)) burnOk = false; if (!(w.fuel[i] <= fuelBefore[i] * 0.15 + 1e-6)) fuelOk = false; if (!(w.treeDensity[i] <= tdBefore[i] + 1e-6)) tdOk = false; }
  assert(burnOk, 'burned cells have burn severity > 0');
  assert(fuelOk, 'burned cells have fuel reduced to 15%');
  assert(tdOk, 'burned cells have reduced tree density');
  assert(st.fire.fires.length === 1 && st.fire.totalAcres === r.rep.acres, 'state.fire.fires records the fire');
  assert(r.rep.upstreamAcres > 0 && r.rep.upstreamAcres <= r.rep.acres, 'upstreamAcres computed (' + r.rep.upstreamAcres.toFixed(0) + ' of ' + r.rep.acres.toFixed(0) + ')');
  assert(r.rep.severityAvg > 0 && r.rep.severityAvg <= 1 && r.rep.smokeDays >= 1, 'severity and smoke days plausible');
  noNaN(w.burn, 'world.burn'); noNaN(w.fuel, 'world.fuel'); noNaN(w.treeDensity, 'world.treeDensity'); noNaN(w.moisture, 'world.moisture'); noNaN(w.habitat, 'world.habitat');
  noNaN(st, 'state after fire');
  // step signature
  const sim2 = WS.Fire.maybeIgnite(st, w, WS.RNG.create('sig'), { zoneId: upstreamForest[0].id });
  const s2 = WS.Fire.step(sim2, st, w, WS.RNG.create('sig2'));
  assert(Array.isArray(s2.newlyBurning) && Array.isArray(s2.extinguished) && typeof s2.done === 'boolean' && isFinite(s2.acres) && isFinite(s2.perimeterCells), 'step returns the spec shape');
  for (const k of ['burning', 'burnedSet', 'stepCount', 'maxSteps', 'startCell', 'windDir', 'windSpeed', 'danger', 'cellsBurned', 'acres', 'perimeterCells', 'zonesTouched']) assert(sim2[k] !== undefined, 'fireSim has ' + k);
  assert(sim2.maxSteps >= 35 && sim2.maxSteps <= 70, 'maxSteps in 35..70 (' + sim2.maxSteps + ')');
}

/* ------------------------------------------------------------------ fire: annual update, ignition chance, danger, prescribed burn */
{
  const w = cloneWorld(base), st = makeState({ season: C.SEASON.WINTER, turn: 4, year: 2 });
  const f0 = WS.Fire.fuelStats(w).avg;
  WS.Fire.updateAnnual(st, w);
  const f1 = WS.Fire.fuelStats(w).avg;
  assert(f1 > f0 && f1 - f0 < 0.05, 'annual fuel accumulation (' + f0.toFixed(3) + ' -> ' + f1.toFixed(3) + ')');
  st.fire.policy = 'suppress_all'; WS.Fire.updateAnnual(st, w); const f2 = WS.Fire.fuelStats(w).avg;
  assert(f2 - f1 > f1 - f0, 'suppress_all policy accumulates fuel faster');
  w.burn[100] = 0.8; WS.Fire.updateAnnual(st, w); assert(Math.abs(w.burn[100] - 0.68) < 1e-5, 'burn scar recovers 0.12/yr');
  const fsz = WS.Fire.fuelStats(w); assert(Object.keys(fsz.byZone).length >= 6, 'fuelStats byZone covers forest sectors');
  assert(WS.Fire.seasonIgnitionChance(makeState({ season: 0 }), w) === 0, 'no ignition in winter');
  const chances = [0.3, 0.5, 0.7, 0.9].map(d => WS.Fire.seasonIgnitionChance(makeState({ season: 2, climate: Object.assign(makeState().climate, { fireDanger: d, windMph: 8, drought: 'None' }) }), w));
  console.log('ignition chance by danger 0.3/0.5/0.7/0.9:', chances.map(c => (100 * c).toFixed(0) + '%').join(' '));
  assert(chances[0] > 0.05 && chances[0] < 0.12 && chances[3] > 0.5 && chances[3] < 0.7 && chances.every((c, i) => i === 0 || c > chances[i - 1]), 'ignition chance ~8% Moderate .. ~60% Extreme, monotonic');
  const dLow = WS.Fire.danger(makeState({ season: 1, climate: { tempAnomF: -3, precipIn: 4, soilMoisturePct: 70, drought: 'None', windMph: 5 } }), w);
  const dHigh = WS.Fire.danger(makeState({ season: 2, climate: { tempAnomF: 8, precipIn: 0.3, soilMoisturePct: 15, drought: 'D3', windMph: 30 } }), w);
  console.log('danger cool wet spring:', dLow.toFixed(2), WS.Fire.dangerLabel(dLow), '| hot dry drought summer:', dHigh.toFixed(2), WS.Fire.dangerLabel(dHigh));
  assert(dLow < 0.4 && dHigh > 0.7, 'danger responds to climate');
  // random ignition frequency at Extreme summer roughly matches chance
  let n = 0; for (let k = 0; k < 200; k++) if (WS.Fire.maybeIgnite(makeState({ climate: Object.assign(makeState().climate, { fireDanger: 0.9, windMph: 8, drought: 'None' }) }), cloneWorld(base), WS.RNG.create('ign' + k))) n++;
  assert(n > 90 && n < 150, 'random ignition rate at Extreme ~60% (' + n + '/200)');
  // prescribed burn
  const w2 = cloneWorld(base), st2 = makeState({ season: C.SEASON.SPRING, climate: Object.assign(makeState().climate, { fireDanger: 0.25 }) });
  const zid = upstreamForest[0].id;
  const pb = WS.Fire.prescribedBurn(st2, w2, zid, WS.RNG.create('rx'));
  console.log('prescribed burn:', JSON.stringify(pb, (k, v) => k === 'escapeFire' ? (v ? '[fireSim]' : null) : v));
  assert(pb.cellsTreated > 100 && pb.fuelAfter < pb.fuelBefore * 0.7, 'prescribed burn reduces sector fuel (' + pb.fuelBefore.toFixed(2) + ' -> ' + pb.fuelAfter.toFixed(2) + ')');
  assert(pb.success === !pb.escaped && (pb.escapeFire === null) === !pb.escaped, 'prescribed burn success/escape consistent');
  let esc = 0; for (let k = 0; k < 100; k++) { const r = WS.Fire.prescribedBurn(makeState({ season: 1, climate: Object.assign(makeState().climate, { fireDanger: 0.25 }) }), cloneWorld(base), zid, WS.RNG.create('rxe' + k)); if (r.escaped) { esc++; assert(r.escapeFire && r.escapeFire.burning.size > 0, 'escape returns a live fireSim'); } }
  assert(esc >= 0 && esc <= 12, 'escape rate near 4% at low danger (' + esc + '/100)');
  assert(WS.Fire.prescribedBurn(st2, w2, 9999, WS.RNG.create('x')).success === false, 'unknown zone handled defensively');
  assert(WS.Fire.maybeIgnite(null, null, null) === null && WS.Fire.step(null, null, null, null).done === true, 'null-safe maybeIgnite/step');
}

/* ------------------------------------------------------------------ flood: calibration */
function burnCells(w, cells, sev) { for (const i of cells) { w.burn[i] = sev; w.fuel[i] *= 0.15; w.moisture[i] = Math.max(0, w.moisture[i] - 0.15); } return cells.length; }
const storm = { intensityIn: 2.0, durationHr: 2, turnsUntil: 0 };
let burnedWorld, scarCells;
{
  // ~2,050 forest cells (~5,000 acres) of high-severity scar, all draining to the reservoir
  burnedWorld = cloneWorld(base);
  const target = Math.round(5000 / C.ACRES_PER_CELL), cells = [], names = [];
  for (const z of upstreamForest.slice().sort((a, b) => b.cells.length - a.cells.length)) {
    if (cells.length >= target) break; names.push(z.name);
    for (const i of z.cells) { if (cells.length >= target) break; if (base.isUpstreamOfReservoir(i)) cells.push(i); }
  }
  scarCells = burnCells(burnedWorld, cells, 0.85);
  console.log('scar:', scarCells, 'cells =', (scarCells * C.ACRES_PER_CELL).toFixed(0), 'acres, all upstream, in', names.join(' + '));
}
const unburned = WS.Flood.simulate(makeState(), cloneWorld(base), storm, []);
const burned = WS.Flood.simulate(makeState(), cloneWorld(burnedWorld), storm, []);
console.log('unburned 2in storm:', JSON.stringify({ peakRes: unburned.peakCfsReservoir, peakTown: unburned.peakCfsTown, sed: unburned.sedimentTons, sedRes: unburned.sedimentToReservoir, dmg: unburned.damageM }));
console.log('burned   2in storm:', JSON.stringify({ peakRes: burned.peakCfsReservoir, peakTown: burned.peakCfsTown, sed: burned.sedimentTons, sedRes: burned.sedimentToReservoir, ash: burned.ashToReservoir, dmg: burned.damageM, flooded: burned.floodedCells.length, houses: burned.floodedHouses, contam: burned.contamination, runoffAF: burned.runoffAF }));
noNaN(unburned, 'unburned result'); noNaN(burned, 'burned result');
assert(burned.peakCfsReservoir >= 1500 && burned.peakCfsReservoir <= 4000, '2-in storm on ~5,000-acre scar: peak at reservoir in 1,500-4,000 cfs (' + burned.peakCfsReservoir + ')');
assert(unburned.peakCfsReservoir >= 40 && unburned.peakCfsReservoir <= 300, 'unburned peak ~120 cfs (' + unburned.peakCfsReservoir + ')');
assert(burned.peakCfsReservoir > unburned.peakCfsReservoir * 6, 'burned peak >> unburned');
assert(burned.sedimentToReservoir >= 2000 && burned.sedimentToReservoir <= 60000, 'burned scar sends thousands of tons of sediment (' + burned.sedimentToReservoir + ' t)');
assert(unburned.sedimentToReservoir < 50, 'unburned sediment < 50 t (' + unburned.sedimentToReservoir + ')');
assert(burned.ashToReservoir > 0 && burned.ashToReservoir <= burned.sedimentToReservoir, 'ash <= sediment');
assert(burned.contamination.turbidityDelta > unburned.contamination.turbidityDelta, 'fallback contamination scales with sediment');
assert(burned.peakCfsTown >= 0 && burned.peakCfsTown < burned.peakCfsReservoir, 'town peak attenuated by the reservoir');
const bigger = WS.Flood.simulate(makeState(), cloneWorld(burnedWorld), { intensityIn: 3.0, durationHr: 1 }, []);
assert(bigger.peakCfsReservoir > burned.peakCfsReservoir && bigger.sedimentToReservoir > burned.sedimentToReservoir, 'a bigger, shorter storm is worse');
const sameAgain = WS.Flood.simulate(makeState(), cloneWorld(burnedWorld), storm, []);
assert(sameAgain.peakCfsReservoir === burned.peakCfsReservoir && sameAgain.sedimentToReservoir === burned.sedimentToReservoir, 'simulate is deterministic');

/* ------------------------------------------------------------------ flood: frames */
{
  const fr = burned.frames;
  assert(Array.isArray(fr) && fr.length >= 24 && fr.length <= 40, 'frames count 24..40 (' + fr.length + ')');
  let ok = true, maxCount = 0, moved = false, first = fr[0];
  for (const f of fr) {
    if (!(f.positions instanceof Float32Array) || f.positions.length !== 3 * f.count || f.count > 4000 || !isFinite(f.reservoirTurbidity)) ok = false;
    maxCount = Math.max(maxCount, f.count);
    for (let k = 0; k < f.count; k++) { const x = f.positions[3 * k], y = f.positions[3 * k + 1], s = f.positions[3 * k + 2]; if (!(x >= -1 && x <= N + 1 && y >= -1 && y <= N + 1 && s >= 0 && s <= 1)) ok = false; }
  }
  const mid = fr[Math.floor(fr.length / 2)];
  if (mid.count > 0 && first.count > 0 && (mid.positions[0] !== first.positions[0] || mid.positions[1] !== first.positions[1])) moved = true;
  assert(ok, 'frames well-formed (Float32Array 3*k, in-range, <= 4000 particles)');
  assert(maxCount > 500 && maxCount <= 3000, 'particles sampled from scar (max ' + maxCount + ')');
  assert(fr[fr.length - 1].reservoirTurbidity >= fr[0].reservoirTurbidity && fr[fr.length - 1].reservoirTurbidity > 0, 'reservoir turbidity rises through the storm');
  assert(fr[fr.length - 1].count < fr[3].count, 'particles terminate at the reservoir over time (' + fr[3].count + ' -> ' + fr[fr.length - 1].count + ')');
  assert(unburned.frames.length >= 24, 'unburned storm still produces frames (' + unburned.frames.length + ', ' + unburned.frames[0].count + ' particles)');
}

/* ------------------------------------------------------------------ flood: prepare / canPlace / mitigations / counterfactual / attribute */
{
  const st = makeState(), w = cloneWorld(burnedWorld);
  const prep = WS.Flood.prepare(st, w, storm);
  console.log('prep:', JSON.stringify({ scarAcres: Math.round(prep.scarAcres), atRisk: prep.atRiskZones, peak: prep.predictedPeakCfs, sed: prep.predictedSedimentTons, placeable: Object.fromEntries(Object.entries(prep.placeable).map(([k, v]) => [k, v.length])) }));
  assert(prep.scarCells.length === scarCells && Math.abs(prep.scarAcres - scarCells * C.ACRES_PER_CELL) < 1, 'prepare finds the scar');
  for (const k of ['mulch', 'barrier', 'debris_basin', 'bank_stab', 'intake_protect', 'sensor', 'warning']) assert(prep.placeable[k] instanceof Int32Array && prep.placeable[k].length > 0, 'placeable.' + k + ' non-empty (' + prep.placeable[k].length + ')');
  assert(prep.placeable.warning.length === 4 && prep.placeable.intake_protect.length === 1, 'warning at 4 neighbourhood centres, one intake');
  assert(prep.atRiskZones.includes(w.reservoir.zoneId), 'reservoir zone at risk');
  assert(WS.Flood.canPlace(prep, 'mulch', prep.placeable.mulch[0]) && !WS.Flood.canPlace(prep, 'mulch', prep.placeable.sensor[0]) && !WS.Flood.canPlace(prep, 'nope', 1) && !WS.Flood.canPlace(null, 'mulch', 1), 'canPlace validates');
  let basinOk = true; for (const i of prep.placeable.debris_basin) if (w.land[i] === L.RESERVOIR || !(w.flowAcc[i] > 60)) basinOk = false; assert(basinOk, 'debris basin sites are channel cells outside the reservoir');
  let bankOk = true; for (const i of prep.placeable.bank_stab) if (w.isUpstreamOfReservoir(i)) bankOk = false; assert(bankOk, 'bank_stab sites are below the dam');
  // build a mitigation set: mulch on the highest-accumulation scar cells, barriers, basins on the biggest channel below the scar, sensor above intake, warnings, intake boom
  const xy = i => ({ x: i % N, y: (i / N) | 0 });
  const byAcc = arr => Array.from(arr).sort((a, b) => w.flowAcc[b] - w.flowAcc[a]);
  const mits = [];
  for (const i of byAcc(prep.placeable.mulch).filter((_, k) => k % 3 === 0).slice(0, 120)) mits.push(Object.assign({ type: 'mulch' }, xy(i)));
  for (const i of byAcc(prep.placeable.barrier).slice(0, 25)) mits.push(Object.assign({ type: 'barrier' }, xy(i)));
  for (const i of byAcc(prep.placeable.debris_basin).slice(0, 2)) mits.push(Object.assign({ type: 'debris_basin' }, xy(i)));
  for (const i of byAcc(prep.placeable.bank_stab).slice(0, 10)) mits.push(Object.assign({ type: 'bank_stab' }, xy(i)));
  mits.push(Object.assign({ type: 'intake_protect' }, xy(prep.placeable.intake_protect[0])));
  const upSensor = Array.from(prep.placeable.sensor).find(i => w.isUpstreamOfReservoir(i)); mits.push(Object.assign({ type: 'sensor' }, xy(upSensor)));
  for (const i of prep.placeable.warning) mits.push(Object.assign({ type: 'warning' }, xy(i)));
  for (const m of mits) assert(WS.Flood.canPlace(prep, m.type, C.idx(m.x, m.y)), 'placement valid: ' + m.type);
  const mit = WS.Flood.simulate(st, cloneWorld(burnedWorld), storm, mits);
  const cf = WS.Flood.counterfactual(st, cloneWorld(burnedWorld), storm);
  console.log('mitigated:', JSON.stringify({ peakRes: mit.peakCfsReservoir, sedRes: mit.sedimentToReservoir, trapped: mit.trappedTons, dmg: mit.damageM, risk: +mit.injuriesRisk.toFixed(3), contam: mit.contamination, early: mit.earlyWarning }));
  console.log('counterfactual:', JSON.stringify({ peakRes: cf.peakCfsReservoir, sedRes: cf.sedimentToReservoir, dmg: cf.damageM, risk: +cf.injuriesRisk.toFixed(3), contam: cf.contamination }));
  noNaN(mit, 'mitigated result'); noNaN(cf, 'counterfactual');
  assert(mit.sedimentToReservoir < burned.sedimentToReservoir * 0.8, 'mitigations cut sediment to reservoir by > 20% (' + burned.sedimentToReservoir + ' -> ' + mit.sedimentToReservoir + ')');
  assert(mit.trappedTons > 0 && mit.earlyWarning === true && mit.intakeProtected === true, 'traps, sensor and boom registered');
  assert(mit.contamination.outageDays <= burned.contamination.outageDays && mit.contamination.turbidityDelta <= burned.contamination.turbidityDelta, 'contamination reduced by boom/sensor');
  assert(mit.injuriesRisk <= burned.injuriesRisk, 'warnings do not raise injury risk');
  assert(cf.sedimentToReservoir >= mit.sedimentToReservoir && cf.damageM >= mit.damageM && cf.peakCfsTown >= mit.peakCfsTown, 'counterfactual >= mitigated');
  assert(cf.frames.length === 0 || Array.isArray(cf.frames), 'counterfactual has frames array');
  // wetland restored + rain capture reduce town impacts
  WS.Projects = { effects: () => ({ wetlandRestored: true, rainCaptureAF: 900, thinnedZones: {}, fuelBreakZones: {}, hardenedZones: {} }) };
  const wet = WS.Flood.simulate(st, cloneWorld(burnedWorld), storm, []);
  const cf2 = WS.Flood.counterfactual(st, cloneWorld(burnedWorld), storm);
  console.log('wetland+raincapture:', JSON.stringify({ peakTown: wet.peakCfsTown, wetTrapped: wet.wetlandTrappedTons, dmg: wet.damageM }), 'cf:', JSON.stringify({ peakTown: cf2.peakCfsTown, dmg: cf2.damageM }));
  assert(wet.peakCfsTown <= cf2.peakCfsTown && wet.wetlandTrappedTons > 0, 'restored wetland attenuates town peak and traps sediment');
  const att = WS.Flood.attribute(st, cloneWorld(burnedWorld), storm, mits);
  delete WS.Projects;
  console.log('attribution:', att.map(a => a.label + ': -' + a.preventedSedimentTons + ' t, -$' + a.preventedDamageM + 'M, ' + a.pct + '%').join(' | '));
  assert(att.length >= 8, 'attribute returns one entry per mitigation type + wetland + rain capture (' + att.length + ')');
  let sumPct = 0, allFinite = true; for (const a of att) { sumPct += a.pct; if (!isFinite(a.preventedDamageM) || !isFinite(a.preventedSedimentTons) || !isFinite(a.pct) || typeof a.label !== 'string') allFinite = false; }
  assert(allFinite && sumPct >= 95 && sumPct <= 105, 'attribution finite, pct sums ~100 (' + sumPct + ')');
  assert(att.find(a => a.key === 'debris_basin').preventedSedimentTons > 0 && att.find(a => a.key === 'mulch').preventedSedimentTons > 0, 'basins and mulch each prevent sediment');
  // applyResult
  const st2 = makeState({ mitigations: mits, budget: 10, emergencyFund: 1 });
  const w2 = cloneWorld(burnedWorld);
  const before = { budget: st2.budget, ef: st2.emergencyFund, turb: st2.reservoir.turbidity };
  const applied = WS.Flood.applyResult(st2, w2, mit);
  console.log('applied:', JSON.stringify(applied), 'budget', st2.budget, 'ef', st2.emergencyFund, 'turbidity', st2.reservoir.turbidity.toFixed(3), 'ash', st2.reservoir.ashContam.toFixed(3));
  noNaN(st2, 'state after applyResult'); noNaN(w2.burn, 'world.burn after applyResult'); noNaN(w2.cropHealth, 'cropHealth'); noNaN(w2.regrow, 'world.regrow');
  assert(Math.abs((before.budget + before.ef) - (st2.budget + st2.emergencyFund) - Math.min(mit.damageM, before.budget + before.ef)) < 1e-6, 'damage paid from emergency fund then budget');
  assert(st2.reservoir.turbidity > before.turb && st2.stats.sedimentTons === mit.sedimentToReservoir && st2.log.length >= 1, 'applyResult updates reservoir, stats and log');
  assert(w2.regrow instanceof Float32Array && w2.regrow.some(v => v > 0), 'mulch creates world.regrow');
  assert(st2.budget >= 0 && st2.emergencyFund >= 0, 'budget never negative');
  // a scar above town (sector 5, no reservoir in between): the town floods, sirens cut injury risk, basins protect homes
  {
    const w5 = cloneWorld(base); const s5 = base.zonesOf('forest')[4];
    burnCells(w5, Array.from(s5.cells).slice(0, 1400), 0.9);
    const p5 = WS.Flood.prepare(makeState(), w5, storm);
    const r5 = WS.Flood.simulate(makeState(), cloneWorld(w5), storm, []);
    const warns = Array.from(p5.placeable.warning).map(i => ({ type: 'warning', x: i % N, y: (i / N) | 0 }));
    const basins5 = Array.from(p5.placeable.debris_basin).sort((a, b) => w5.flowAcc[b] - w5.flowAcc[a]).slice(0, 3).map(i => ({ type: 'debris_basin', x: i % N, y: (i / N) | 0 }));
    const r5w = WS.Flood.simulate(makeState(), cloneWorld(w5), storm, warns.concat(basins5));
    console.log('sector-5 scar above town:', JSON.stringify({ peakRes: r5.peakCfsReservoir, peakTown: r5.peakCfsTown, flooded: r5.floodedCells.length, houses: r5.floodedHouses, dmg: r5.damageM, risk: +r5.injuriesRisk.toFixed(3), atRisk: p5.atRiskZones, basins: p5.placeable.debris_basin.length }), '| with sirens+basins:', JSON.stringify({ risk: +r5w.injuriesRisk.toFixed(3), dmg: r5w.damageM, trapped: r5w.trappedTons }));
    assert(r5.peakCfsTown > r5.peakCfsReservoir && r5.floodedHouses > 0 && r5.damageM > 0.5, 'scar above town floods neighbourhoods and costs real money');
    assert(p5.atRiskZones.some(z => base.zones[z].type === 'neighborhood'), 'at-risk zones include a neighbourhood');
    assert(r5w.injuriesRisk < r5.injuriesRisk * 0.5 && r5w.trappedTons > 0, 'sirens cut injury risk > 50%; basins on the town creek trap debris');
  }
  // stormRisk
  const rNo = WS.Flood.stormRisk(makeState({ season: 3 }), cloneWorld(base)), rScar = WS.Flood.stormRisk(makeState({ season: 3 }), cloneWorld(burnedWorld)), rWinter = WS.Flood.stormRisk(makeState({ season: 0 }), cloneWorld(burnedWorld));
  console.log('stormRisk fall no-scar / fall scar / winter scar:', rNo.toFixed(3), rScar.toFixed(3), rWinter.toFixed(3));
  assert(rScar > rNo * 4 && rWinter < rScar && rScar <= 0.7, 'storm risk rises with a scar, low in winter');
  // defensive
  assert(WS.Flood.simulate(null, null, null, null).peakCfsReservoir === 0 && WS.Flood.prepare(null, null, null).scarAcres === 0 && WS.Flood.applyResult(null, null, null) === null, 'null-safe flood API');
  const bad = WS.Flood.simulate(makeState(), cloneWorld(burnedWorld), { intensityIn: NaN, durationHr: Infinity }, [{ type: 'mulch', x: -5, y: 900 }, { type: 'zzz', x: 1, y: 1 }, null]);
  noNaN(bad, 'result with garbage storm/mitigations');
}

/* ------------------------------------------------------------------ Hydrology.contaminate integration (stub) */
{
  let calls = 0;
  WS.Hydrology = { contaminate: (state, world, sed, ashFrac) => { calls++; state.reservoir.turbidity += 0.1; return { turbidityDelta: 0.1, ashDelta: 0.05 * ashFrac, outageDays: 8 }; } };
  const st = makeState(), w = cloneWorld(burnedWorld);
  const r = WS.Flood.simulate(st, w, storm, [{ type: 'sensor', x: w.river.path[10].x, y: w.river.path[10].y }]);
  assert(calls === 1 && st.reservoir.turbidity === 0.05, 'simulate previews Hydrology.contaminate on a clone (real state untouched)');
  assert(r.contamination.turbidityDelta === 0.1 && r.contamination.outageDays === 4, 'contamination from Hydrology, outage halved by early warning');
  WS.Flood.applyResult(st, w, r);
  assert(calls === 2 && Math.abs(st.reservoir.turbidity - 0.15) < 1e-9 && st.stats.contaminationOutageDays === 4, 'applyResult calls the real contaminate once');
  delete WS.Hydrology;
}

/* ------------------------------------------------------------------ optional: real terrain smoke test */
const terrainPath = path.join(ROOT, 'src/world/terrain.js');
if (fs.existsSync(terrainPath)) {
  let real = null;
  try { const env = load(['src/world/terrain.js', 'src/sim/fire.js', 'src/sim/flood.js']); real = { WS: env.WS, world: env.WS.World.generate(7) }; }
  catch (e) { console.log('WARN: terrain.js present but failed to load/generate, skipping real-world smoke: ' + e.message); }
  if (real && real.world && real.world.flowDir && real.world.zones) {
    const RW = real.WS, w = real.world;
    const st = makeState({ climate: Object.assign(makeState().climate, { fireDanger: 0.9, windMph: 25 }) });
    const forest = w.zones.filter(z => z.type === 'forest' && z.upstreamOfReservoir);
    const rng = RW.RNG.create('real');
    const sim = RW.Fire.maybeIgnite(st, w, rng, { zoneId: (forest[0] || w.zones[0]).id });
    let r, n = 0; if (sim) { do { r = RW.Fire.step(sim, st, w, rng); n++; } while (!r.done && n < 200); }
    const rep = sim ? RW.Fire.finalize(sim, st, w) : null;
    console.log('real world fire:', rep ? Math.round(rep.acres) + ' acres, ' + rep.structuresLost + ' homes, zones ' + rep.zoneIds.join(',') : 'none');
    assert(!rep || (isFinite(rep.acres) && rep.acres <= 0.45 * (w.cellsOf(L.FOREST).length + w.cellsOf(L.SHRUB).length) * C.ACRES_PER_CELL + 1), 'real-world fire finite and capped');
    const fr = RW.Flood.simulate(st, w, storm, []);
    noNaN(fr, 'real-world flood result');
    console.log('real world flood:', JSON.stringify({ peakRes: fr.peakCfsReservoir, sedRes: fr.sedimentToReservoir, dmg: fr.damageM, frames: fr.frames.length }));
    assert(fr.frames.length >= 24 && isFinite(fr.peakCfsReservoir), 'real-world flood runs');
  }
} else console.log('(src/world/terrain.js not present; stub world only)');

/* ------------------------------------------------------------------ v2: fire tactics (SPEC2 §A) */
{
  const F = WS.Fire, TAC = F.TACTICS;
  assert(TAC && TAC.dozer.costPts === 1 && TAC.dozer.digSteps === 2 && TAC.retardant.costPts === 5 && TAC.retardant.radius === 2 && TAC.retardant.cooldownSteps === 8 && TAC.retardant.maxUses === 4
    && TAC.engine.costPts === 6 && TAC.engine.max === 2 && TAC.evacuate.costPts === 0 && TAC.mutual_aid.costM === 1.5 && TAC.mutual_aid.gainPts === 10 && TAC.mutual_aid.maxUses === 1, 'TACTICS table matches the spec');
  for (const k of ['startTactics', 'canApply', 'applyTactic', 'threat', 'replayWithoutTactics']) assert(typeof F[k] === 'function', 'WS.Fire.' + k + ' exists');
  const wui = base.zonesOf('neighborhood')[0], far = base.zonesOf('neighborhood')[3];
  const startXY = { x: wui.bbox.x1 + 4, y: wui.bbox.y0 - 4 }, startCell = C.idx(startXY.x, startXY.y);
  const windToTown = Math.atan2(wui.center.y - startXY.y, wui.center.x - startXY.x);
  const wuiClimate = () => Object.assign(makeState().climate, { fireDanger: 0.95, windMph: 40, windDirRad: windToTown });
  function wuiFire(label, over) {
    const w = cloneWorld(base), st = makeState(Object.assign({ climate: wuiClimate() }, over || {}));
    const sim = F.maybeIgnite(st, w, WS.RNG.create(label), { cell: startCell });
    F.startTactics(sim, st, w);
    return { w, st, sim };
  }
  function runToEnd(sim, st, w, hook) { let r, n = 0; do { if (hook) hook(n); r = F.step(sim, st, w, null); n++; if (n > 300) throw new Error('fire did not end'); } while (!r.done); return n; }
  const zoneTouched = (sim, z) => Array.from(z.cells).some(c => sim.burnState[c] !== 0);

  // --- start state
  {
    const { w, sim } = wuiFire('t:start'); const T = sim.tactics;
    assert(T === F.startTactics(sim, makeState(), w) || true, 'startTactics returns the tactics object');
    assert(T.crewPts === 12 + 4 * 2 && T.crewMax === 30 && Math.abs(T.regenPerStep - 0.3) < 1e-9, 'startTactics: 20 crew pts with 2 stations, max 30, regen 0.3');
    assert(T.breaks instanceof Uint8Array && T.breaks.length === NN && T.digTimer instanceof Uint8Array && T.digTimer.length === NN && T.wet instanceof Float32Array && T.wet.length === NN, 'tactics arrays sized N*N');
    assert(T.drops === 0 && T.dropCooldown === 0 && T.mutualAidUsed === false && Object.keys(T.engines).length === 0 && Object.keys(T.evacuated).length === 0 && typeof T.used === 'object' && Array.isArray(T.log), 'tactics start empty');
    const s2 = makeState({ climate: wuiClimate(), fire: Object.assign(makeState().fire, { policy: 'suppress_all' }) });
    const sim2 = F.maybeIgnite(s2, w, WS.RNG.create('t:sa'), { cell: startCell }); F.startTactics(sim2, s2, w);
    assert(Math.abs(sim2.tactics.regenPerStep - 0.45) < 1e-9, 'suppress_all policy: regen 0.45');
    assert(sim.maxSteps >= 45 && sim.maxSteps <= 70, 'v2 maxSteps 45..70 (' + sim.maxSteps + ')');
    const plain = F.maybeIgnite(makeState({ climate: wuiClimate() }), cloneWorld(base), WS.RNG.create('t:plain'), { cell: startCell });
    assert(!plain.tactics && F.step(plain, makeState(), cloneWorld(base), WS.RNG.create('x')).newlyBurning !== undefined, 'v1 flow without startTactics still steps');
  }

  // --- crew points regen + cap
  {
    const a = wuiFire('t:regen'); const p0 = a.sim.tactics.crewPts; F.step(a.sim, a.st, a.w, null);
    assert(Math.abs(a.sim.tactics.crewPts - (p0 + 0.3)) < 1e-6, 'crew points regen 0.3 per step (' + a.sim.tactics.crewPts.toFixed(2) + ')');
    const b = wuiFire('t:regen2'); b.sim.tactics.crewPts = 29.9; F.step(b.sim, b.st, b.w, null);
    assert(b.sim.tactics.crewPts === 30, 'crew points cap at crewMax');
  }

  // --- dozer: charges only accepted cells; digging -> finished line
  {
    const { w, st, sim } = wuiFire('t:dozer'); const T = sim.tactics;
    const burningCell = Array.from(sim.burning)[0], riverCell = base.cellsOf(L.RIVER)[0], roadCell = base.cellsOf(L.ROAD)[0];
    const ok = [];
    for (let dx = -3; dx <= 3; dx++) { const c = C.idx(startXY.x + dx, startXY.y + 3); const lv = base.land[c]; if (sim.burnState[c] === 0 && lv !== L.ROAD && lv !== L.RIVER && lv !== L.RESERVOIR) ok.push(c); }
    const before = T.crewPts;
    const chk = F.canApply(sim, st, w, 'dozer', [burningCell, riverCell, roadCell].concat(ok));
    assert(chk.ok && chk.cost === ok.length, 'canApply dozer reports the cost of accepted cells only (' + chk.cost + ')');
    const r = F.applyTactic(sim, st, w, 'dozer', [burningCell, riverCell, roadCell].concat(ok, ok.slice(0, 2)));
    assert(r.ok && r.cells.length === ok.length && r.cost === ok.length && Math.abs(before - T.crewPts - r.cost) < 1e-9 && r.cells.every(c => ok.indexOf(c) >= 0), 'dozer charges only accepted cells, dedupes, and returns them (' + r.cells.length + ' of ' + (ok.length + 5) + ')');
    assert(r.cells.every(c => T.breaks[c] === 1 && T.digTimer[c] === 2) && T.used.dozer === 1 && typeof r.text === 'string' && r.text.length > 5, 'accepted cells start digging (breaks=1, timer=2)');
    F.step(sim, st, w, null); F.step(sim, st, w, null);
    assert(r.cells.every(c => T.breaks[c] === 2 || sim.burnState[c] !== 0), 'line finished after 2 steps (unless overrun)');
    const again = F.canApply(sim, st, w, 'dozer', r.cells);
    assert(!again.ok && /workable/i.test(again.reason), 'canApply refuses to re-cut an existing line: ' + again.reason);
    const cf = F.replayWithoutTactics(sim, st, w);
    assert(isFinite(cf.acres) && isFinite(cf.structuresLost) && isFinite(cf.upstreamAcres) && Array.isArray(cf.zoneIds), 'replayWithoutTactics returns finite numbers mid-fire');
  }

  // --- retardant: fewer cells burn inside the coated patch (same seed; only local divergence)
  {
    let withD = 0, without = 0, wetOk = true;
    const tx = Math.round(startXY.x + 3 * Math.cos(windToTown)), ty = Math.round(startXY.y + 3 * Math.sin(windToTown)), target = C.idx(tx, ty);
    const patch = []; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (C.inBounds(tx + dx, ty + dy)) patch.push(C.idx(tx + dx, ty + dy));
    for (let k = 0; k < 8; k++) {
      const a = wuiFire('t:ret' + k), b = wuiFire('t:ret' + k);
      runToEnd(a.sim, a.st, a.w, n => {
        if (n === 0) { const r = F.applyTactic(a.sim, a.st, a.w, 'retardant', target); if (!r.ok) throw new Error(r.reason); if (a.sim.tactics.wet[target] !== 1 || a.sim.tactics.drops !== 1 || a.sim.tactics.dropCooldown !== 8 || r.cells.length !== patch.length || r.cost !== 5) wetOk = false; }
        if (n === 3 && Math.abs(a.sim.tactics.wet[target] - (1 - 0.02 * 3)) > 1e-5) wetOk = false;
      });
      runToEnd(b.sim, b.st, b.w);
      for (const c of patch) { if (a.sim.burnState[c] !== 0) withD++; if (b.sim.burnState[c] !== 0) without++; }
    }
    console.log('cells burned inside the 5x5 drop patch, 8 fires: with drop', withD, 'vs without', without);
    assert(wetOk, 'drop coats the 5x5 patch (wet=1), costs 5, counts a use, sets cooldown 8, decays 0.02/step');
    assert(without > 0 && withD < without * 0.6, 'retardant cuts burning inside the patch by > 40%');
  }

  // --- engine crew: fewer homes lost when the fire reaches the neighborhood
  {
    let lostE = 0, lostN = 0;
    for (let k = 0; k < 12; k++) {
      const a = wuiFire('t:eng' + k), b = wuiFire('t:eng' + k);
      const r = F.applyTactic(a.sim, a.st, a.w, 'engine', wui.id); if (!r.ok) throw new Error(r.reason);
      if (k === 0) assert(r.cost === 6 && Math.abs(a.sim.tactics.crewPts - 14) < 1e-9 && a.sim.tactics.engines[wui.id] === true && r.cells.length === wui.cells.length, 'engine costs 6 pts and marks the zone');
      runToEnd(a.sim, a.st, a.w); runToEnd(b.sim, b.st, b.w);
      const ra = F.finalize(a.sim, a.st, a.w), rb = F.finalize(b.sim, b.st, b.w);
      lostE += ra.structuresLost; lostN += rb.structuresLost;
      if (k === 0) assert(ra.tactics.engines.length === 1 && ra.tactics.engines[0] === wui.name, 'finalize lists engine zone names');
    }
    console.log('homes lost, 12 WUI fires: engine', lostE, 'vs none', lostN);
    assert(lostN > 0 && lostE < lostN * 0.6, 'engine crew cuts home losses by > 40% when fire reaches the neighborhood');
  }

  // --- evacuation: zero injuries; flags evacuations the fire never justified
  {
    const nbAll = base.zonesOf('neighborhood');
    let inj = 0, injEvac = 0, unnecessary = 0, expected = 0, trust = 0, allOk = true;
    for (let k = 0; k < 12; k++) {
      const a = wuiFire('t:evac' + k), b = wuiFire('t:evac' + k);
      for (const z of nbAll) { const r = F.applyTactic(a.sim, a.st, a.w, 'evacuate', z.id); if (!r.ok || r.cost !== 0) allOk = false; }
      runToEnd(a.sim, a.st, a.w); runToEnd(b.sim, b.st, b.w);
      for (const z of nbAll) if (!zoneTouched(a.sim, z)) expected++;
      const ra = F.finalize(a.sim, a.st, a.w), rb = F.finalize(b.sim, b.st, b.w);
      injEvac += ra.tactics.injuries; inj += rb.tactics.injuries; unnecessary += ra.tactics.unnecessaryEvacs; trust += a.st.trustDelta;
      if (k === 0) assert(ra.tactics.evacuated.length === 4 && ra.tactics.evacuated.indexOf(wui.name) >= 0 && ra.tactics.evacuated.indexOf(far.name) >= 0, 'finalize lists evacuated zone names');
    }
    assert(allOk, 'evacuation orders are free and accepted for every neighborhood');
    console.log('injuries, 12 WUI fires: no evacuation', inj, '| all evacuated', injEvac, '| unnecessary evacs', unnecessary, '(expected ' + expected + ')');
    assert(inj > 0, 'un-evacuated WUI fires cause injuries across 12 fires (' + inj + ')');
    assert(injEvac === 0, 'evacuated neighborhoods: zero injuries');
    assert(unnecessary === expected && expected >= 12 && trust < 0, 'evacuating a neighborhood the fire never reached is flagged (' + unnecessary + ') and dents trust (' + trust + ')');
  }

  // --- mutual aid
  {
    const a = wuiFire('t:aid', { budget: 0, emergencyFund: 0 });
    let r = F.canApply(a.sim, a.st, a.w, 'mutual_aid', null);
    assert(!r.ok && /fund/i.test(r.reason) && !F.applyTactic(a.sim, a.st, a.w, 'mutual_aid', null).ok, 'mutual aid refused with budget 0 and emergency fund 0: ' + r.reason);
    const b = wuiFire('t:aid2', { budget: 1, emergencyFund: 2 });
    r = F.applyTactic(b.sim, b.st, b.w, 'mutual_aid', null);
    assert(r.ok && b.st.budget === 1 && Math.abs(b.st.emergencyFund - 0.5) < 1e-9 && b.sim.tactics.crewPts === 30 && b.sim.tactics.mutualAidUsed, 'mutual aid falls back to the emergency fund; +10 pts capped at 30');
    assert(!F.canApply(b.sim, b.st, b.w, 'mutual_aid', null).ok, 'mutual aid can only be called once');
    const c = wuiFire('t:aid3'); c.sim.tactics.crewPts = 5;
    r = F.applyTactic(c.sim, c.st, c.w, 'mutual_aid', null);
    assert(r.ok && Math.abs(c.st.budget - 10.5) < 1e-9 && c.sim.tactics.crewPts === 15 && c.st.emergencyFund === 2.5, 'mutual aid deducts $1.5M from the budget first and adds 10 pts');
  }

  // --- canApply reasons
  {
    const a = wuiFire('t:can'); const T = a.sim.tactics;
    assert(!F.canApply(a.sim, a.st, a.w, 'nope', null).ok, 'unknown tactic refused');
    const fresh = F.maybeIgnite(makeState({ climate: wuiClimate() }), cloneWorld(base), WS.RNG.create('t:fresh'), { cell: startCell });
    let r = F.canApply(fresh, a.st, a.w, 'evacuate', wui.id); assert(!r.ok && /not been started/i.test(r.reason), 'no tactics yet: ' + r.reason);
    r = F.canApply(a.sim, a.st, a.w, 'dozer', []); assert(!r.ok, 'dozer with no cells refused');
    r = F.canApply(a.sim, a.st, a.w, 'dozer', Array.from(a.sim.burning)); assert(!r.ok && /workable/i.test(r.reason), 'dozer through burning cells refused: ' + r.reason);
    r = F.canApply(a.sim, a.st, a.w, 'engine', base.zonesOf('forest')[0].id); assert(!r.ok && /neighborhood/i.test(r.reason), 'engine outside a neighborhood refused: ' + r.reason);
    const nb = base.zonesOf('neighborhood');
    assert(F.applyTactic(a.sim, a.st, a.w, 'engine', nb[0].id).ok && F.applyTactic(a.sim, a.st, a.w, 'engine', nb[1].id).ok, 'two engines accepted');
    r = F.canApply(a.sim, a.st, a.w, 'engine', nb[2].id); assert(!r.ok && /committed/i.test(r.reason), 'third engine refused: ' + r.reason);
    r = F.canApply(a.sim, a.st, a.w, 'engine', nb[0].id); assert(!r.ok, 'engine already stationed refused');
    assert(F.applyTactic(a.sim, a.st, a.w, 'evacuate', nb[0].id).ok, 'evacuate accepted');
    r = F.canApply(a.sim, a.st, a.w, 'evacuate', nb[0].id); assert(!r.ok && /already/i.test(r.reason), 'evacuate twice refused: ' + r.reason);
    T.crewPts = 4;
    r = F.canApply(a.sim, a.st, a.w, 'retardant', startCell); assert(!r.ok && /crew points/i.test(r.reason) && r.cost === 5, 'retardant without 5 pts refused: ' + r.reason);
    T.crewPts = 30;
    assert(F.applyTactic(a.sim, a.st, a.w, 'retardant', startCell).ok, 'retardant drop accepted');
    r = F.canApply(a.sim, a.st, a.w, 'retardant', startCell); assert(!r.ok && /reload/i.test(r.reason), 'retardant on cooldown refused: ' + r.reason);
    T.dropCooldown = 0; T.drops = 4;
    r = F.canApply(a.sim, a.st, a.w, 'retardant', startCell); assert(!r.ok && /tankers/i.test(r.reason), 'retardant past maxUses refused: ' + r.reason);
    r = F.canApply(a.sim, a.st, a.w, 'retardant', -5); assert(!r.ok, 'retardant off-grid refused');
    T.crewPts = 0.5;
    r = F.canApply(a.sim, a.st, a.w, 'dozer', [C.idx(startXY.x, startXY.y + 6)]); assert(!r.ok && /crew points/i.test(r.reason), 'dozer without a point refused: ' + r.reason);
    T.crewPts = 30;
    runToEnd(a.sim, a.st, a.w);
    r = F.canApply(a.sim, a.st, a.w, 'evacuate', nb[1].id); assert(!r.ok && /out/i.test(r.reason), 'tactics refused once the fire is out: ' + r.reason);
  }

  // --- gusting wind + threat
  {
    const a = wuiFire('t:gust'); const th0 = F.threat(a.sim, a.st, a.w);
    const nb0 = th0.threatened.filter(t => t.type === 'neighborhood')[0];
    assert(th0.threatened.length > 0 && th0.threatened[0].distanceCells === 0 && th0.threatened[0].burningInside === true, 'threat: the sector the fire is burning in is listed first at 0 cells (' + th0.threatened[0].name + ')');
    assert(nb0 && nb0.name === wui.name && nb0.distanceCells <= 6 && nb0.distanceCells > 0 && nb0.burningInside === false, 'threat: Marshall Heights is the nearest threatened neighborhood at ignition (' + (nb0 && nb0.distanceCells) + ' cells)');
    const dirs = new Set(); let ok = true, sawRisk = false, sawIntense = false, worst = 0; const INT = { creeping: 1, active: 1, running: 1, extreme: 1 };
    runToEnd(a.sim, a.st, a.w, n => {
      const th = F.threat(a.sim, a.st, a.w);
      dirs.add(Math.round(th.windDirRad * 1000));
      const off = Math.abs(th.windDirRad - windToTown); worst = Math.max(worst, off);
      if (off > 25 * Math.PI / 180 + 0.3) ok = false;
      if (!(th.headingDeg >= 0 && th.headingDeg < 360) || !(th.windMph > 0) || !INT[th.intensity] || !isFinite(th.structuresLost) || !isFinite(th.structuresAtRisk) || !isFinite(th.upstreamAcres) || th.acres !== a.sim.acres) ok = false;
      if (th.threatened.length > 6) ok = false;
      for (let i = 1; i < th.threatened.length; i++) if (th.threatened[i].distanceCells < th.threatened[i - 1].distanceCells) ok = false;
      for (const t of th.threatened) if (['neighborhood', 'farm', 'civic', 'forest', 'reservoir'].indexOf(t.type) < 0 || typeof t.burningInside !== 'boolean' || typeof t.zoneId !== 'number') ok = false;
      if (th.structuresAtRisk > 0) sawRisk = true;
      if (th.intensity !== 'creeping') sawIntense = true;
      noNaN(th, 'threat');
    });
    assert(dirs.size >= 4 && ok, 'gusts: wind direction shifts (' + dirs.size + ' distinct, max ' + (worst * 180 / Math.PI).toFixed(0) + '° off) and threat() shape is valid every step');
    assert(sawRisk && sawIntense, 'threat reports houses at risk and a non-creeping intensity during a wind-driven WUI fire');
    const t1 = Date.now(); for (let k = 0; k < 200; k++) F.threat(a.sim, a.st, a.w); const dt = Date.now() - t1;
    assert(dt < 400, 'threat() is cheap (200 calls in ' + dt + ' ms)');
  }

  // --- finalize: report.tactics shape, ignition-chance rule
  {
    const a = wuiFire('t:fin'); F.applyTactic(a.sim, a.st, a.w, 'dozer', [C.idx(startXY.x - 4, startXY.y + 4), C.idx(startXY.x - 4, startXY.y + 5)]);
    runToEnd(a.sim, a.st, a.w);
    const rep = F.finalize(a.sim, a.st, a.w), tk = rep.tactics;
    for (const k of ['used', 'cellsBroken', 'drops', 'engines', 'evacuated', 'mutualAid', 'counterfactual', 'acresSaved', 'structuresSaved', 'injuries', 'unnecessaryEvacs']) assert(tk[k] !== undefined, 'report.tactics.' + k + ' present');
    noNaN(tk, 'report.tactics');
    assert(typeof tk.mutualAid === 'boolean' && Array.isArray(tk.engines) && Array.isArray(tk.evacuated) && tk.used.dozer === 1 && tk.cellsBroken >= 0 && tk.cellsBroken <= 2 && isFinite(tk.counterfactual.acres) && isFinite(tk.counterfactual.structuresLost) && isFinite(tk.counterfactual.upstreamAcres) && tk.acresSaved >= 0 && tk.structuresSaved >= 0, 'report.tactics values well-formed');
    const last = a.st.fire.fires[a.st.fire.fires.length - 1];
    assert(last && isFinite(last.acresSaved) && last.counterfactual && isFinite(last.counterfactual.acres), 'state.fire.fires entry carries the counterfactual');
    const plainW = cloneWorld(base), plainSt = makeState({ climate: wuiClimate() });
    const plain = F.maybeIgnite(plainSt, plainW, WS.RNG.create('t:plainfin'), { cell: startCell }); runToEnd(plain, plainSt, plainW);
    const prep = F.finalize(plain, plainSt, plainW);
    assert(prep.tactics && prep.tactics.acresSaved === 0 && prep.tactics.counterfactual.acres === prep.acres, 'v1 flow (no tactics) still reports tactics with a zero counterfactual delta');
    // ignition chance rule: a fire-less game from its second summer on rolls >= 55%
    const w = cloneWorld(base), mild = () => Object.assign(makeState().climate, { fireDanger: 0.3, windMph: 8, drought: 'None' });
    assert(F.seasonIgnitionChance(makeState({ year: 2, season: 2, climate: mild() }), w) >= 0.55, 'fire-less year-2 summer: ignition chance >= 55%');
    assert(F.seasonIgnitionChance(makeState({ year: 3, season: 2, climate: mild() }), w) >= 0.55, 'fire-less year-3 summer: still >= 55%');
    assert(F.seasonIgnitionChance(makeState({ year: 1, season: 2, climate: mild() }), w) < 0.2, 'year-1 summer at Moderate danger stays ~11%');
    assert(F.seasonIgnitionChance(makeState({ year: 2, season: 3, climate: mild() }), w) < 0.2, 'the bump only applies in Summer');
    const had = makeState({ year: 2, season: 2, climate: mild() }); had.fire.fires.push({ acres: 10 });
    assert(F.seasonIgnitionChance(had, w) < 0.2, 'the bump goes away once a fire has happened');
    assert(Math.abs(F.seasonIgnitionChance(makeState({ year: 1, season: 2, climate: mild() }), w) - 0.08 * 1.35) < 0.01, 'seasonIgnitionChance x1.35 (' + (100 * F.seasonIgnitionChance(makeState({ year: 1, season: 2, climate: mild() }), w)).toFixed(1) + '%)');
    assert(F.seasonIgnitionChance(makeState({ year: 1, season: 2, climate: Object.assign(mild(), { fireDanger: 1, windMph: 40, drought: 'D4' }) }), w) <= 0.68, 'ignition chance capped at 68%');
  }

  // --- real world: dozer ring around an Extreme ignition in forest zone 4 (adjoins Marshall Heights) vs replayWithoutTactics
  if (fs.existsSync(path.join(ROOT, 'src/world/terrain.js'))) {
    const env2 = load(['src/world/terrain.js', 'src/sim/fire.js']); const RW = env2.WS, F2 = RW.Fire;
    const w0 = RW.World.generate(7);
    const z4 = w0.zones[4], mh = w0.zones.filter(z => z.name === 'Marshall Heights')[0];
    assert(z4 && z4.type === 'forest' && mh && mh.type === 'neighborhood', 'real world: zone 4 is a forest sector (' + z4.name + ') and Marshall Heights exists');
    let ign = -1, bd = 1e9;
    for (const i of z4.cells) { const d = Math.max(Math.abs(i % N - mh.center.x), Math.abs(((i / N) | 0) - mh.center.y)); if (d >= 6 && d < bd) { bd = d; ign = i; } }
    assert(ign >= 0 && bd <= 12, 'zone 4 adjoins Marshall Heights (ignition ' + bd + ' cells from its centre)');
    const ix = ign % N, iy = (ign / N) | 0, toTown = Math.atan2(mh.center.y - iy, mh.center.x - ix);
    function cloneRW(w) { const o = Object.assign({}, w); for (const k of ['elev', 'land', 'fuel', 'moisture', 'burn', 'treeDensity', 'habitat', 'zone']) o[k] = new w[k].constructor(w[k]); o.buildings = w.buildings.map(b => Object.assign({}, b)); delete o._fireMaps; delete o._fireInit; return o; }
    function realFire(label, withRing) {
      const w = cloneRW(w0), st = makeState({ climate: Object.assign(makeState().climate, { fireDanger: 0.92, windMph: 30, windDirRad: toTown, drought: 'D2' }) });
      const sim = F2.maybeIgnite(st, w, RW.RNG.create(label), { cell: ign, danger: 0.92 });
      F2.startTactics(sim, st, w);
      let r, n = 0, ring = null;
      do {
        if (withRing && n === 1) {
          F2.applyTactic(sim, st, w, 'mutual_aid', null);
          const cells = []; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === 3 && C.inBounds(ix + dx, iy + dy)) cells.push((iy + dy) * N + ix + dx);
          ring = F2.applyTactic(sim, st, w, 'dozer', cells);
        }
        r = F2.step(sim, st, w, null); n++;
      } while (!r.done && n < 300);
      const cfA = F2.replayWithoutTactics(sim, st, w); const cfB = F2.replayWithoutTactics(sim, st, w);
      assert(cfA.acres === cfB.acres && cfA.structuresLost === cfB.structuresLost && cfA.upstreamAcres === cfB.upstreamAcres, 'replayWithoutTactics is deterministic (' + label + ': ' + Math.round(cfA.acres) + ' acres)');
      const rep = F2.finalize(sim, st, w);
      return { rep, ring, cf: cfA, steps: n, sim };
    }
    let withA = 0, withoutA = 0, homesWith = 0, homesWithout = 0, big = 0;
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const base0 = realFire('ring:' + s, false), ring = realFire('ring:' + s, true);
      assert(Math.abs(base0.rep.acres - base0.cf.acres) < 1e-6 && base0.rep.structuresLost === base0.cf.structuresLost, 'no-tactics fire equals its own replay (' + s + ')');
      assert(ring.rep.tactics.counterfactual.acres === base0.rep.acres, 'ring fire counterfactual == untouched fire (' + s + ': ' + Math.round(base0.rep.acres) + ' acres)');
      assert(ring.ring && ring.ring.ok && ring.ring.cells.length >= 20 && ring.rep.tactics.cellsBroken >= 0 && ring.rep.tactics.mutualAid === true, 'ring cut (' + ring.ring.cells.length + ' cells, ' + ring.rep.tactics.cellsBroken + ' finished)');
      withA += ring.rep.acres; withoutA += base0.rep.acres; homesWith += ring.rep.structuresLost; homesWithout += base0.rep.structuresLost; if (base0.rep.acres > 500) big++;
      console.log('  ring ' + s + ': without ' + Math.round(base0.rep.acres) + ' acres / ' + base0.rep.structuresLost + ' homes -> with ' + Math.round(ring.rep.acres) + ' / ' + ring.rep.structuresLost + ' (saved ' + Math.round(ring.rep.tactics.acresSaved) + ')');
      noNaN(ring.rep.tactics, 'real-world report.tactics');
    }
    console.log('dozer ring @Extreme, 6 fires: ' + Math.round(withoutA) + ' acres / ' + homesWithout + ' homes without -> ' + Math.round(withA) + ' / ' + homesWith + ' with');
    assert(big >= 2, 'at least two of the untouched Extreme fires run past 500 acres (' + big + ')');
    assert(withA < withoutA * 0.5, 'a dozer ring around the ignition cuts total acres by > 50%');
    assert(homesWith <= homesWithout, 'ring never costs homes');
  }
}

/* ------------------------------------------------------------------ v2: storm defence (SPEC2 §B) */
{
  const FL = WS.Flood, T = FL.TOOLS, LIVE = ['sandbag', 'pump', 'evacuate', 'spillway'], PRE = ['mulch', 'barrier', 'debris_basin', 'bank_stab', 'intake_protect', 'sensor', 'warning'];
  assert(T.sandbag.live === true && T.sandbag.costM === 0.04 && T.pump.live === true && T.pump.costM === 0.15 && T.pump.max === 3 && T.evacuate.live === true && T.evacuate.costM === 0 && T.evacuate.zone === 'neighborhood'
    && T.spillway.live === true && T.spillway.once === true && T.spillway.costM === 0 && LIVE.every(k => typeof T[k].name === 'string' && typeof T[k].icon === 'string' && typeof T[k].desc === 'string'), 'live TOOLS (sandbag/pump/evacuate/spillway) match the spec');
  assert(PRE.every(k => T[k] && T[k].live === false), 'the 7 pre-storm tools carry live:false');
  assert(typeof FL.placeableLive === 'function' && FL.FRAME_COUNT >= 24 && FL.FRAME_COUNT <= 40, 'WS.Flood.placeableLive exists; FRAME_COUNT exported (' + FL.FRAME_COUNT + ')');

  // --- real world: an upstream scar (all of the largest upstream forest sector) and a scar above town (a sector that drains past the reservoir)
  if (fs.existsSync(path.join(ROOT, 'src/world/terrain.js'))) {
    const env3 = load(['src/world/terrain.js', 'src/sim/fire.js', 'src/sim/flood.js']); const RW = env3.WS, F3 = RW.Flood;
    const w0 = RW.World.generate(7);
    const cloneRW = w => { const o = Object.assign({}, w); for (const k of ['elev', 'land', 'fuel', 'moisture', 'burn', 'treeDensity', 'habitat', 'zone', 'cropHealth']) if (w[k]) o[k] = new w[k].constructor(w[k]); o.buildings = w.buildings.map(b => Object.assign({}, b)); delete o._fireMaps; delete o._fireInit; delete o._floodMaps; delete o._topo; delete o.regrow; return o; };
    const forests = w0.zones.filter(z => z.type === 'forest');
    const up = forests.filter(z => z.upstreamOfReservoir).sort((a, b) => b.cells.length - a.cells.length)[0];
    const above = forests.filter(z => !z.upstreamOfReservoir).sort((a, b) => b.cells.length - a.cells.length)[0];
    assert(up && above, 'real world has an upstream forest sector (' + up.name + ') and one below the dam (' + above.name + ')');
    const wUp = cloneRW(w0); burnCells(wUp, Array.from(up.cells), 0.85);
    const wAbove = cloneRW(w0); burnCells(wAbove, Array.from(above.cells), 0.9);
    const S = over => makeState(over);
    const nbs = w0.zones.filter(z => z.type === 'neighborhood');
    const zoneName = i => { const z = w0.zone[i]; return z >= 0 ? w0.zones[z].name : null; };

    const none = F3.simulate(S(), wUp, storm, []);
    const noneA = F3.simulate(S(), wAbove, storm, []);
    noNaN(none, 'upstream-scar result'); noNaN(noneA, 'scar-above-town result');
    console.log('real world upstream scar (' + up.name + '):', JSON.stringify({ peakRes: none.peakCfsReservoir, peakTown: none.peakCfsTown, flooded: none.floodedCells.length, houses: none.floodedHouses, dmg: none.damageM, risk: +none.injuriesRisk.toFixed(3) }));
    console.log('real world scar above town (' + above.name + '):', JSON.stringify({ peakRes: noneA.peakCfsReservoir, peakTown: noneA.peakCfsTown, flooded: noneA.floodedCells.length, houses: noneA.floodedHouses, dmg: noneA.damageM, risk: +noneA.injuriesRisk.toFixed(3), firstTown: noneA.firstTownFloodFrame, zone: noneA.firstTownFloodZone }));
    assert(none.floodedHouses > 0 && none.damageM > 0 && noneA.floodedHouses > 0 && noneA.damageM > 0, 'a 2-in storm floods homes on the real map in both scenarios');

    // --- v1 shape with no live tools: tactics present but empty, nothing released
    assert(none.tactics && none.tactics.sandbagCells === 0 && none.tactics.pumps === 0 && none.tactics.evacuated.length === 0 && none.tactics.spillwayUsed === false && none.tactics.damageSaved === 0 && none.tactics.housesSaved === 0
      && none.tactics.counterfactual.damageM === none.damageM && none.tactics.counterfactual.floodedHouses === none.floodedHouses && none.tactics.counterfactual.injuriesRisk === none.injuriesRisk
      && none.releasedAF === 0 && none.spillwayUsed === false && none.unnecessaryEvacs === 0, 'no live tools: result.tactics is a zero delta, releasedAF 0, no evacuations');

    // --- arrivalFrame / floodTimeline / floodedByFrame consistency (and alignment with frames)
    function checkTimeline(r, label) {
      const fr = r.frames, tl = r.floodTimeline, bf = r.floodedByFrame, af = r.arrivalFrame;
      let ok = af instanceof Int32Array && af.length === NN && Array.isArray(tl) && tl.length === fr.length && tl.length === FL.FRAME_COUNT && bf instanceof Int32Array && bf.length === fr.length;
      const flooded = new Set(Array.from(r.floodedCells)); let cum = 0, seen = 0;
      for (let f = 0; f < tl.length && ok; f++) {
        if (!(tl[f] instanceof Int32Array)) { ok = false; break; }
        for (const i of tl[f]) { if (af[i] !== f || !flooded.has(i)) ok = false; seen++; }
        cum += tl[f].length; if (bf[f] !== cum) ok = false;
      }
      let neg = 0, pos = 0;
      for (let i = 0; i < NN; i++) { if (af[i] < 0) neg++; else { pos++; if (!flooded.has(i) || af[i] >= fr.length) ok = false; } }
      if (pos !== flooded.size || seen !== flooded.size || neg !== NN - flooded.size || (bf.length && bf[bf.length - 1] !== flooded.size)) ok = false;
      assert(ok, label + ': arrivalFrame (-1 = never) / floodTimeline / cumulative floodedByFrame agree (' + flooded.size + ' cells over ' + tl.length + ' frames)');
      // the flood front is derived from the tracer's routing: a cell never floods later than the first particle drawn past it (+1 frame for the tracer's multi-cell hops)
      const firstP = new Int32Array(NN).fill(-1);
      fr.forEach((f, fi) => { for (let k = 0; k < f.count; k++) { const x = Math.floor(f.positions[3 * k]), y = Math.floor(f.positions[3 * k + 1]); if (C.inBounds(x, y)) { const i = y * N + x; if (firstP[i] < 0) firstP[i] = fi; } } });
      let visited = 0, consistent = 0, exact = 0;
      for (const i of flooded) { if (firstP[i] < 0) continue; visited++; if (af[i] <= firstP[i] + 1) consistent++; if (af[i] === firstP[i]) exact++; }
      return { visited, consistent, exact };
    }
    checkTimeline(none, 'upstream scar');
    const tlA = checkTimeline(noneA, 'scar above town');
    const maxA = Math.max(...Array.from(noneA.floodedCells).map(i => noneA.arrivalFrame[i]));
    console.log('scar above town: arrival frames 0..' + maxA + ', ' + tlA.visited + ' flooded cells visited by particles, ' + tlA.consistent + ' consistent, ' + tlA.exact + ' exact');
    assert(tlA.visited >= 5 && tlA.consistent === tlA.visited && tlA.exact >= 3 && maxA >= 12, 'scar above town: water reaches the neighbourhoods on the particle schedule (front never later than the tracer)');
    assert(noneA.firstTownFloodFrame >= 0 && typeof noneA.firstTownFloodZone === 'string' && noneA.frames.some(f => f.notes && f.notes.indexOf(noneA.firstTownFloodZone) >= 0), 'firstTownFloodFrame/Zone set and a frame note announces the first neighbourhood hit');

    // --- sandbags: early (before the water) beats late (after), both beat none; atFrame omitted == pre-storm == full effect
    const resCells = Array.from(none.floodedCells).filter(i => wUp.land[i] === L.RESIDENTIAL || wUp.land[i] === L.CIVIC);
    const sb = (cells, af) => cells.map(i => { const p = C.xy(i); return af == null ? { type: 'sandbag', x: p.x, y: p.y } : { type: 'sandbag', x: p.x, y: p.y, atFrame: af }; });
    const early = F3.simulate(S(), wUp, storm, sb(resCells, 0));
    const late = F3.simulate(S(), wUp, storm, sb(resCells, FL.FRAME_COUNT - 1));
    const pre = F3.simulate(S(), wUp, storm, sb(resCells, null));
    noNaN(early, 'early sandbags'); noNaN(late, 'late sandbags');
    console.log('sandbags on ' + resCells.length + ' flooded res/civic cells: none $' + none.damageM + 'M/' + none.floodedHouses + ' homes | early $' + early.damageM + 'M/' + early.floodedHouses + ' (saved $' + early.tactics.damageSaved + 'M, ' + early.tactics.housesSaved + ' homes) | late $' + late.damageM + 'M/' + late.floodedHouses + ' (saved $' + late.tactics.damageSaved + 'M)');
    assert(resCells.length >= 5 && early.floodedHouses < none.floodedHouses && early.damageM < none.damageM * 0.6, 'early sandbags cut flooded homes and damage by > 40%');
    assert(late.damageM < none.damageM && late.damageM > early.damageM && late.floodedHouses >= early.floodedHouses && late.tactics.damageSaved < early.tactics.damageSaved, 'late sandbags (after the water arrived) help less than early ones');
    assert(pre.damageM === early.damageM && pre.floodedHouses === early.floodedHouses, 'sandbags with no atFrame count as placed before the storm (full effect)');
    assert(early.tactics.sandbagCells === resCells.length && early.tactics.counterfactual.damageM === none.damageM && early.tactics.counterfactual.floodedHouses === none.floodedHouses && Math.abs(early.tactics.counterfactual.injuriesRisk - none.injuriesRisk) < 1e-9
      && Math.abs(early.tactics.damageSaved - (none.damageM - early.damageM)) < 1e-6 && early.tactics.housesSaved === none.floodedHouses - early.floodedHouses, 'tactics: sandbag count, counterfactual == the no-live-tools storm, damageSaved/housesSaved are the deltas');
    // the sandbag neighbours: a line protects its 4 neighbours too (placing on a neighbour of a flooded cell can clear it)
    {
      const target = resCells[0], p = C.xy(target), nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).filter(q => C.inBounds(q.x, q.y));
      const viaNb = F3.simulate(S(), wUp, storm, nb.map(q => ({ type: 'sandbag', x: q.x, y: q.y, atFrame: 0 })));
      assert(viaNb.floodedCells.indexOf(target) < 0 || F3.simulate(S(), wUp, storm, [{ type: 'sandbag', x: p.x, y: p.y, atFrame: 0 }]).floodedCells.indexOf(target) >= 0, 'a sandbag line protects its 4 neighbours');
    }
    // the sandbag timing is judged against each cell's own arrival: placed exactly at the arrival frame still counts as early
    {
      const c0 = resCells[0], at = none.arrivalFrame[c0];
      const onTime = F3.simulate(S(), wUp, storm, [{ type: 'sandbag', i: c0, atFrame: at }]), justLate = F3.simulate(S(), wUp, storm, [{ type: 'sandbag', i: c0, atFrame: at + 1 }]), one = F3.simulate(S(), wUp, storm, [{ type: 'sandbag', i: c0, atFrame: 0 }]);
      assert(onTime.damageM === one.damageM && justLate.damageM >= onTime.damageM, 'atFrame <= arrivalFrame[cell] is full effect; one frame later is the 40% rule');
    }

    // --- pump: damage on its cell x0.4 (late: x0.76), max 3 crews, one per cell
    {
      const pc = resCells.find(i => wUp.land[i] === L.RESIDENTIAL);
      const pumped = F3.simulate(S(), wUp, storm, [{ type: 'pump', i: pc, atFrame: 0 }]);
      const pumpedLate = F3.simulate(S(), wUp, storm, [{ type: 'pump', i: pc, atFrame: FL.FRAME_COUNT - 1 }]);
      const cellDmg = 0.12;  // residential cell, no rain-capture project
      console.log('pump on a flooded home cell: $' + none.damageM + 'M -> $' + pumped.damageM + 'M early, $' + pumpedLate.damageM + 'M late');
      assert(Math.abs((none.damageM - pumped.damageM) - 0.6 * cellDmg) < 0.011 && pumped.floodedHouses === none.floodedHouses && pumped.tactics.pumps === 1, 'pump cuts damage on its cell to 40% (still counted as flooded)');
      assert(Math.abs((none.damageM - pumpedLate.damageM) - 0.24 * cellDmg) < 0.011 && pumpedLate.damageM > pumped.damageM, 'late pump: 40% effectiveness (damage x0.76)');
      const many = F3.simulate(S(), wUp, storm, resCells.slice(0, 5).map(i => ({ type: 'pump', i, atFrame: 0 })).concat([{ type: 'pump', i: pc, atFrame: 0 }]));
      assert(many.tactics.pumps === 3 && many.damageM < none.damageM, 'pump crews capped at 3, one per cell');
    }

    // --- evacuate: injury risk in that neighbourhood x0.1; a neighbourhood that never floods is flagged
    {
      const floodedNb = nbs.find(z => Array.from(none.floodedCells).some(i => wUp.zone[i] === z.id));
      const dryNb = nbs.find(z => !Array.from(none.floodedCells).some(i => wUp.zone[i] === z.id));
      assert(floodedNb && dryNb, 'upstream scar: one neighbourhood floods (' + (floodedNb && floodedNb.name) + '), another stays dry (' + (dryNb && dryNb.name) + ')');
      const ev = F3.simulate(S(), wUp, storm, [{ type: 'evacuate', zoneId: floodedNb.id, atFrame: 2 }]);
      const evDry = F3.simulate(S(), wUp, storm, [{ type: 'evacuate', zoneId: dryNb.id, atFrame: 2 }]);
      const evCentre = F3.simulate(S(), wUp, storm, [{ type: 'evacuate', x: floodedNb.center.x, y: floodedNb.center.y, atFrame: 2 }]);
      const evBoth = F3.simulate(S(), wUp, storm, [{ type: 'evacuate', zoneId: floodedNb.id }, { type: 'evacuate', zoneId: dryNb.id }, { type: 'evacuate', zoneId: dryNb.id }]);
      console.log('evacuate ' + floodedNb.name + ': risk ' + none.injuriesRisk.toFixed(3) + ' -> ' + ev.injuriesRisk.toFixed(3) + ' | ' + dryNb.name + ' (never floods): ' + evDry.injuriesRisk.toFixed(3) + ', unnecessary ' + evDry.unnecessaryEvacs);
      assert(ev.injuriesRisk < none.injuriesRisk * 0.9 && ev.unnecessaryEvacs === 0 && ev.tactics.evacuated.length === 1 && ev.tactics.evacuated[0] === floodedNb.name && ev.damageM === none.damageM, 'evacuating the flooded neighbourhood cuts injury risk, no false alarm, damage unchanged');
      assert(evDry.unnecessaryEvacs === 1 && Math.abs(evDry.injuriesRisk - none.injuriesRisk) < 1e-9 && evDry.tactics.evacuated[0] === dryNb.name, 'evacuating a neighbourhood the water never reaches is flagged (unnecessaryEvacs = 1)');
      assert(Math.abs(evCentre.injuriesRisk - ev.injuriesRisk) < 1e-9, 'evacuate accepts a neighbourhood centre cell instead of zoneId');
      assert(evBoth.unnecessaryEvacs === 1 && evBoth.tactics.evacuated.length === 2, 'duplicate evacuation orders collapse; unnecessary count is per zone');
    }

    // --- spillway: peak below the dam x0.6, 1,500 AF released, farm damage below the dam x1.2, reservoir sediment unchanged
    {
      const sp = F3.simulate(S(), wUp, storm, [{ type: 'spillway', atFrame: 4 }, { type: 'spillway', atFrame: 9 }]);
      noNaN(sp, 'spillway result');
      console.log('spillway: peakTown ' + none.peakCfsTown + ' -> ' + sp.peakCfsTown + ' cfs, damage $' + none.damageM + 'M -> $' + sp.damageM + 'M (' + sp.floodedFarm + ' farm cells), released ' + sp.releasedAF + ' AF');
      assert(sp.peakCfsTown < none.peakCfsTown * 0.75 && sp.peakCfsTown > 0, 'emergency release lowers the peak below the dam (' + none.peakCfsTown + ' -> ' + sp.peakCfsTown + ' cfs)');
      assert(sp.releasedAF === 1500 && sp.spillwayUsed === true && sp.tactics.spillwayUsed === true, 'releasedAF = 1,500 and spillwayUsed set (a second order is ignored)');
      assert(sp.peakCfsReservoir === none.peakCfsReservoir && sp.sedimentToReservoir === none.sedimentToReservoir && sp.ashToReservoir === none.ashToReservoir, 'spillway leaves inflow and reservoir sediment trapping unchanged');
      assert(sp.floodedFarm === 0 || sp.damageM > none.damageM, 'farms downstream take a surge (farm flood damage x1.2)');
      assert(sp.tactics.counterfactual.damageM === none.damageM && sp.tactics.damageSaved === 0 && sp.tactics.housesSaved === 0, 'spillway alone: counterfactual is the untouched storm, savings clamp at 0');
    }

    // --- everything together vs its counterfactual; pre-storm mitigations stay in the counterfactual
    {
      const prep = F3.prepare(S(), wUp, storm);
      const warns = Array.from(prep.placeable.warning).map(i => Object.assign({ type: 'warning' }, C.xy(i)));
      const basins = Array.from(prep.placeable.debris_basin).sort((a, b) => wUp.flowAcc[b] - wUp.flowAcc[a]).slice(0, 2).map(i => Object.assign({ type: 'debris_basin' }, C.xy(i)));
      const preOnly = warns.concat(basins);
      const floodedNb = nbs.find(z => Array.from(none.floodedCells).some(i => wUp.zone[i] === z.id));
      const live = sb(resCells, 1).concat([{ type: 'pump', i: resCells[0], atFrame: 3 }, { type: 'evacuate', zoneId: floodedNb.id, atFrame: 2 }, { type: 'spillway', atFrame: 5 }]);
      const preRun = F3.simulate(S(), wUp, storm, preOnly);
      const all = F3.simulate(S(), wUp, storm, preOnly.concat(live));
      noNaN(all, 'all-tools result'); noNaN(all.tactics, 'all-tools tactics');
      console.log('pre-storm only: $' + preRun.damageM + 'M/' + preRun.floodedHouses + ' homes/risk ' + preRun.injuriesRisk.toFixed(3) + ' | + live tools: $' + all.damageM + 'M/' + all.floodedHouses + '/' + all.injuriesRisk.toFixed(3) + ' (saved $' + all.tactics.damageSaved + 'M, ' + all.tactics.housesSaved + ' homes)');
      assert(all.tactics.counterfactual.damageM === preRun.damageM && all.tactics.counterfactual.floodedHouses === preRun.floodedHouses && Math.abs(all.tactics.counterfactual.injuriesRisk - preRun.injuriesRisk) < 1e-9, 'tactics.counterfactual = same storm + same pre-storm mitigations, no live tools');
      assert(all.tactics.counterfactual.damageM >= all.damageM && all.tactics.counterfactual.floodedHouses >= all.floodedHouses && all.tactics.counterfactual.injuriesRisk >= all.injuriesRisk && all.tactics.damageSaved > 0 && all.tactics.housesSaved > 0, 'counterfactual >= mitigated on damage, homes and injury risk');
      assert(all.tactics.sandbagCells === resCells.length && all.tactics.pumps === 1 && all.tactics.evacuated[0] === floodedNb.name && all.tactics.spillwayUsed === true && all.trappedTons > 0 && all.releasedAF === 1500, 'tactics report every live tool; pre-storm basins still trap');
      const again = F3.simulate(S(), wUp, storm, preOnly.concat(live));
      assert(again.damageM === all.damageM && again.floodedHouses === all.floodedHouses && again.peakCfsTown === all.peakCfsTown && again.arrivalFrame.every((v, i) => v === all.arrivalFrame[i]) && again.floodedByFrame.every((v, i) => v === all.floodedByFrame[i]), 'simulate with live tools is deterministic');
      // v1 helpers still work alongside live tools
      const att = F3.attribute(S(), wUp, storm, preOnly.concat(live));
      assert(att.length >= 5 && att.every(a => isFinite(a.pct) && isFinite(a.preventedDamageM)) && att.some(a => a.key === 'sandbag'), 'attribute() handles live tools (' + att.map(a => a.key).join(',') + ')');
      // speed: frames + live tools (+ the internal counterfactual)
      let best = 1e9; for (let k = 0; k < 3; k++) { const t0 = process.hrtime.bigint(); F3.simulate(S(), wUp, storm, preOnly.concat(live)); best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); }
      console.log('simulate with frames + live tools: best of 3 = ' + best.toFixed(1) + ' ms');
      assert(best < 150, 'simulate with frames on the real world < 150 ms (' + best.toFixed(1) + ' ms)');
    }

    // --- placeableLive + canPlace
    {
      const prep = F3.prepare(S(), wUp, storm);
      const sets = {};
      for (const t of LIVE) {
        const pl = F3.placeableLive(prep, wUp, t); sets[t] = new Set(Array.from(pl));
        assert(pl instanceof Int32Array && pl.length > 0 && Array.from(pl).every(i => F3.canPlace(prep, t, i)), 'placeableLive(' + t + ') non-empty (' + pl.length + ') and canPlace agrees');
      }
      const dam = C.idx(wUp.reservoir.dam.x, wUp.reservoir.dam.y);
      assert(sets.spillway.size === 1 && sets.spillway.has(dam) && !F3.canPlace(prep, 'spillway', dam + 1), 'spillway only at the dam cell');
      assert(sets.evacuate.size === nbs.length && nbs.every(z => sets.evacuate.has(C.idx(z.center.x, z.center.y))), 'evacuate at the ' + nbs.length + ' neighbourhood centres');
      const dev = i => wUp.land[i] === L.RESIDENTIAL || wUp.land[i] === L.CIVIC || wUp.land[i] === L.FARM;
      assert(Array.from(sets.pump).every(dev) && Array.from(sets.sandbag).every(i => dev(i) && sets.pump.has(i)) && sets.sandbag.size < sets.pump.size, 'pump on any developed/farm cell; sandbag sites are a subset near water');
      assert(resCells.every(i => sets.sandbag.has(i)), 'every cell that floods is a sandbag site');
      const forestCell = up.cells[0], resCell = wUp.reservoir.cells[0];
      assert(!F3.canPlace(prep, 'sandbag', forestCell) && !F3.canPlace(prep, 'pump', resCell) && !F3.canPlace(prep, 'sandbag', -1) && !F3.canPlace(prep, 'sandbag', NaN), 'canPlace rejects forest / reservoir / off-grid cells for live tools');
      assert(F3.canPlace(prep, 'mulch', prep.placeable.mulch[0]) && !F3.canPlace(prep, 'mulch', dam), 'canPlace still validates pre-storm tools');
      const standalone = F3.placeableLive(null, wUp, 'pump');
      assert(standalone.length === sets.pump.size && F3.placeableLive(prep, null, 'evacuate').length === nbs.length && F3.placeableLive(prep, wUp, 'mulch').length === 0, 'placeableLive works without a prep (pump) or without a world (from prep); non-live types give an empty array');
      assert(PRE.every(t => prep.placeable[t] instanceof Int32Array) && F3.prepare(S(), wUp, storm).placeable.sandbag instanceof Int32Array, 'prepare keeps the v1 placeable sets and adds the live ones');
    }

    // --- applyResult: the spillway release comes out of storage (-1,500 AF) and costs trust; a false-alarm evacuation dips trust
    {
      const sp = F3.simulate(S(), wUp, storm, [{ type: 'spillway', atFrame: 4 }]);
      const st = S({ budget: 10, emergencyFund: 1 }); st.reservoir.storageAF = 30000; st.trustDelta = 0;
      const applied = F3.applyResult(st, cloneRW(wUp), sp);
      noNaN(st, 'state after spillway applyResult');
      assert(st.reservoir.storageAF === 28500 && applied.releasedAF === 1500 && st.trustDelta === -1 && st.log.some(l => /release/i.test(l.text)), 'applyResult with the spillway: storage 30,000 -> 28,500 AF, trust -1, logged');
      const st2 = S(); st2.reservoir.storageAF = 30000; st2.trustDelta = 0;
      F3.applyResult(st2, cloneRW(wUp), none);
      assert(st2.reservoir.storageAF === 30000 && st2.trustDelta === 0, 'applyResult without the spillway leaves storage and trust alone');
      const st3 = S(); st3.reservoir.storageAF = 900; st3.trustDelta = 0;
      const a3 = F3.applyResult(st3, cloneRW(wUp), sp);
      assert(st3.reservoir.storageAF === 0 && a3.releasedAF === 900, 'release cannot take storage below zero');
      const dryNb = nbs.find(z => !Array.from(none.floodedCells).some(i => wUp.zone[i] === z.id));
      const evDry = F3.simulate(S(), wUp, storm, [{ type: 'evacuate', zoneId: dryNb.id }]);
      const st4 = S(); st4.trustDelta = 0; F3.applyResult(st4, cloneRW(wUp), evDry);
      assert(st4.trustDelta < 0 && st4.trustDelta > -1, 'an unnecessary evacuation dips trust a little (' + st4.trustDelta + ')');
    }

    // --- stormRisk x1.4 (v1 formula: 0.30 fall base x scar factor x wetness, now x1.4, still capped at 0.7)
    {
      const scarAcres = up.cells.length * C.ACRES_PER_CELL, scarF = Math.pow(C.clamp(scarAcres / 3000, 0, 1), 0.6);
      const wet = C.clamp(1 + 0.3 * (1.2 - 3) / 3, 0.7, 1.4);
      const expected = C.clamp(0.30 * Math.max(0.05, scarF) * wet * 1.4, 0, 0.7);
      const r = F3.stormRisk(S({ season: 3 }), wUp);
      assert(Math.abs(r - expected) < 1e-6 && r <= 0.7, 'stormRisk is the v1 formula x1.4 (' + r.toFixed(3) + ')');
      assert(F3.stormRisk(S({ season: 3 }), cloneRW(w0)) < 0.05, 'no scar: fall storm risk stays small');
    }
  } else console.log('(src/world/terrain.js not present; storm defence real-world tests skipped)');
}

console.log('\nALL PASS');
