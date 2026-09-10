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

console.log('\nALL PASS');
