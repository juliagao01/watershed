/* Watershed — wildfire model. Export WS.Fire.
   Cellular-automaton spread on the 128x128 grid with wind, slope, fuel, moisture, land cover,
   thinning / fuel breaks / home hardening (from WS.Projects.effects) and suppression near fire
   stations. Pure sim: runs in Node, no DOM. All randomness via the rng passed in. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C, L = C.LAND, N = C.N, NN = N * N;
  var clamp = C.clamp;

  /* ---------- tunables ---------- */
  var BASE_SPREAD = 0.28;          // per spec
  var DANGER_F0 = 0.10, DANGER_F1 = 3.9; // dangerFactor = F0 + F1*danger  (0.3 -> 1.27, 0.9 -> 3.61)
  var DIAG_FACTOR = 0.72;          // diagonal neighbours are farther away
  var STATION_RADIUS = 10;         // cells
  var BURN_STEPS_MIN = 2, BURN_STEPS_MAX = 3;
  var CAP_FRACTION = 0.45;         // single fire <= 45% of forest(+shrub) cells

  // spread multiplier by land cover (index = WS.C.LAND enum)
  var LAND_FACTOR = new Float32Array(16);
  LAND_FACTOR[L.RIVER] = 0; LAND_FACTOR[L.RESERVOIR] = 0; LAND_FACTOR[L.ALPINE] = 0.05;
  LAND_FACTOR[L.FOREST] = 1.0; LAND_FACTOR[L.SHRUB] = 0.8; LAND_FACTOR[L.FARM] = 0.25;
  LAND_FACTOR[L.RESIDENTIAL] = 0.55; LAND_FACTOR[L.CIVIC] = 0.3; LAND_FACTOR[L.WETLAND] = 0.1;
  LAND_FACTOR[L.ROAD] = 0.05; LAND_FACTOR[L.RIPARIAN] = 0.35;
  // default fuel load for land covers where world.fuel is 0 (structures, grass, cottonwoods...)
  var BASE_FUEL = new Float32Array(16);
  BASE_FUEL[L.ALPINE] = 0.15; BASE_FUEL[L.FOREST] = 0.6; BASE_FUEL[L.SHRUB] = 0.45; BASE_FUEL[L.FARM] = 0.35;
  BASE_FUEL[L.RESIDENTIAL] = 0.5; BASE_FUEL[L.CIVIC] = 0.35; BASE_FUEL[L.WETLAND] = 0.3; BASE_FUEL[L.RIPARIAN] = 0.55;

  var DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  var ANG = [], DIAG = [];
  for (var k = 0; k < 8; k++) { ANG.push(Math.atan2(DY[k], DX[k])); DIAG.push(DX[k] !== 0 && DY[k] !== 0); }

  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function seasonOf(state) { return state && isFinite(state.season) ? (state.season | 0) : (state && isFinite(state.turn) ? (state.turn % 4) : 2); }

  function effectsOf(state) {
    var e = null;
    try { if (WS.Projects && typeof WS.Projects.effects === 'function') e = WS.Projects.effects(state); } catch (err) { e = null; }
    if (!e || typeof e !== 'object') e = {};
    return {
      thinnedZones: e.thinnedZones || {}, fuelBreakZones: e.fuelBreakZones || {}, hardenedZones: e.hardenedZones || {},
      warningSystem: !!e.warningSystem, shelters: !!e.shelters
    };
  }

  /* ---------- lazily cached per-world helper maps (private cache on world) ---------- */
  function ensureInit(world) {
    if (!world) return null;
    if (!world._fireInit && world.treeDensity) {
      world._fireInit = { treeDensity: new Float32Array(world.treeDensity), habitat: world.habitat ? new Float32Array(world.habitat) : null };
    }
    return world._fireInit;
  }

  function ensureMaps(world) {
    var buildings = world.buildings || [];
    var nStations = 0;
    for (var b = 0; b < buildings.length; b++) if (buildings[b] && buildings[b].type === 'fire_station') nStations++;
    var m = world._fireMaps;
    if (m && m.nBuildings === buildings.length && m.nStations === nStations && m.land === world.land) return m;
    m = { nBuildings: buildings.length, nStations: nStations, land: world.land,
          stationDist: new Uint8Array(NN), humanProx: new Float32Array(NN), area: new Uint8Array(NN), upstream: new Uint8Array(NN) };
    m.stationDist.fill(255);
    var x, y, i, dx, dy, nx, ny, d;
    for (b = 0; b < buildings.length; b++) {
      var bd = buildings[b];
      if (!bd || bd.type !== 'fire_station') continue;
      var bx = bd.x | 0, by = bd.y | 0;
      for (dy = -STATION_RADIUS; dy <= STATION_RADIUS; dy++) for (dx = -STATION_RADIUS; dx <= STATION_RADIUS; dx++) {
        nx = bx + dx; ny = by + dy; if (!C.inBounds(nx, ny)) continue;
        d = Math.max(Math.abs(dx), Math.abs(dy)); i = ny * N + nx;
        if (d < m.stationDist[i]) m.stationDist[i] = d;
      }
    }
    var land = world.land;
    if (land) {
      var R = 6;
      for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
        i = y * N + x; var lv = land[i];
        var human = (lv === L.ROAD || lv === L.RESIDENTIAL || lv === L.CIVIC);
        var farm = (lv === L.FARM);
        var town = (lv === L.RESIDENTIAL || lv === L.CIVIC);
        if (!human && !farm) continue;
        for (dy = -R; dy <= R; dy++) for (dx = -R; dx <= R; dx++) {
          nx = x + dx; ny = y + dy; if (!C.inBounds(nx, ny)) continue;
          d = Math.max(Math.abs(dx), Math.abs(dy)); var j = ny * N + nx;
          if (human) { var p = 1 - Math.max(0, d - 2) / (R - 2); if (p > m.humanProx[j]) m.humanProx[j] = p; }
          if (town && d <= 4) m.area[j] |= 1;
          if (farm && d <= 3) m.area[j] |= 2;
        }
      }
    }
    if (typeof world.isUpstreamOfReservoir === 'function') {
      for (i = 0; i < NN; i++) { try { m.upstream[i] = world.isUpstreamOfReservoir(i) ? 1 : 0; } catch (e) { m.upstream[i] = 0; } }
    }
    world._fireMaps = m;
    return m;
  }

  function effFuel(world, i) {
    var lv = world.land ? world.land[i] : L.FOREST;
    var f = world.fuel ? fin(world.fuel[i], 0) : 0;
    if (lv === L.FOREST || lv === L.SHRUB) return clamp(f, 0, 1);
    return clamp(Math.max(f, BASE_FUEL[lv] || 0), 0, 1);
  }

  function burnableCells(world) {
    var forest = 0, shrub = 0;
    if (world.land) for (var i = 0; i < NN; i++) { var lv = world.land[i]; if (lv === L.FOREST) forest++; else if (lv === L.SHRUB) shrub++; }
    return { forest: forest, shrub: shrub };
  }

  function zoneOf(world, i) { return (world.zone && world.zone[i] != null) ? world.zone[i] : -1; }

  function nearZoneFlag(world, i, map) {
    var z = zoneOf(world, i);
    if (z >= 0 && map[z]) return true;
    var x = i % N, y = (i / N) | 0;
    for (var k = 0; k < 8; k++) {
      var nx = x + DX[k], ny = y + DY[k]; if (!C.inBounds(nx, ny)) continue;
      z = zoneOf(world, ny * N + nx); if (z >= 0 && map[z]) return true;
    }
    return false;
  }

  /* ---------- danger ---------- */
  function fuelStats(world) {
    var out = { avg: 0, byZone: {} };
    if (!world || !world.fuel || !world.land) return out;
    var sum = 0, n = 0, i, lv;
    for (i = 0; i < NN; i++) { lv = world.land[i]; if (lv === L.FOREST || lv === L.SHRUB) { sum += fin(world.fuel[i], 0); n++; } }
    out.avg = n ? sum / n : 0;
    var zones = world.zones || [];
    for (var z = 0; z < zones.length; z++) {
      var zn = zones[z]; if (!zn || !zn.cells) continue;
      var zs = 0, zc = 0;
      for (var c = 0; c < zn.cells.length; c++) { i = zn.cells[c]; lv = world.land[i]; if (lv === L.FOREST || lv === L.SHRUB) { zs += fin(world.fuel[i], 0); zc++; } }
      if (zc > 0) out.byZone[zn.id] = zs / zc;
    }
    if (!isFinite(out.avg)) out.avg = 0;
    return out;
  }

  var DROUGHT_BONUS = { None: 0, D0: 0.02, D1: 0.05, D2: 0.09, D3: 0.13, D4: 0.18 };
  function danger(state, world) {
    var cl = (state && state.climate) || {};
    var season = seasonOf(state);
    var temp = clamp(fin(cl.tempAnomF, 0) / 10, -0.6, 1.2);      // +10F anomaly -> +1
    var precip = fin(cl.precipIn, 3);
    var soil = clamp(fin(cl.soilMoisturePct, 45) / 100, 0, 1);
    var fuelAvg = clamp(fuelStats(world).avg, 0, 1);
    var seasonBase = [0.05, 0.25, 0.42, 0.30][season] || 0.3;
    var d = seasonBase
      + 0.22 * temp
      + 0.18 * clamp(1 - precip / 4, 0, 1)
      + 0.18 * (1 - soil)
      + 0.20 * fuelAvg
      + (DROUGHT_BONUS[cl.drought] || 0);
    // wind days push danger up a notch
    d += 0.06 * clamp((fin(cl.windMph, 8) - 12) / 20, 0, 1);
    if (season === C.SEASON.WINTER) d *= 0.5;
    return clamp(isFinite(d) ? d : 0.2, 0, 1);
  }
  function dangerLabel(d) {
    d = fin(d, 0);
    return d < 0.2 ? 'Low' : d < 0.4 ? 'Moderate' : d < 0.6 ? 'High' : d < 0.8 ? 'Very High' : 'Extreme';
  }

  /* ---------- ignition ---------- */
  function seasonIgnitionChance(state, world) {
    var season = seasonOf(state);
    if (season === C.SEASON.WINTER) return 0;
    var cl = (state && state.climate) || {};
    var d = clamp(fin(cl.fireDanger, NaN), 0, 1);
    if (!isFinite(d)) d = danger(state, world);
    // piecewise-linear: Moderate ~8%, High ~20%, Very High ~38%, Extreme ~60%
    var xs = [0, 0.3, 0.5, 0.7, 0.9, 1.0], ys = [0.02, 0.08, 0.20, 0.38, 0.60, 0.70];
    var p = ys[ys.length - 1];
    for (var i = 1; i < xs.length; i++) if (d <= xs[i]) { p = C.lerp(ys[i - 1], ys[i], (d - xs[i - 1]) / (xs[i] - xs[i - 1])); break; }
    var seasonMult = season === C.SEASON.SUMMER ? 1.0 : season === C.SEASON.FALL ? 0.8 : 0.6;
    var windMult = clamp(1 + 0.012 * (fin(cl.windMph, 8) - 8), 0.8, 1.4);
    var dr = cl.drought; var droughtMult = dr === 'D4' ? 1.35 : dr === 'D3' ? 1.25 : dr === 'D2' ? 1.15 : 1;
    return clamp(p * seasonMult * windMult * droughtMult, 0, 0.85);
  }

  function pickIgnitionCell(state, world, rng, zoneId) {
    var maps = ensureMaps(world);
    var cand = null;
    if (zoneId != null && zoneId >= 0 && world.zones) {
      var zn = null;
      for (var z = 0; z < world.zones.length; z++) if (world.zones[z] && world.zones[z].id === zoneId) { zn = world.zones[z]; break; }
      if (zn && zn.cells && zn.cells.length) cand = zn.cells;
    }
    var w = new Float32Array(cand ? cand.length : NN), total = 0, i, c;
    var n = w.length;
    for (c = 0; c < n; c++) {
      i = cand ? cand[c] : c;
      var lv = world.land ? world.land[i] : L.FOREST;
      var lf = LAND_FACTOR[lv] || 0; if (lf <= 0.1) continue;
      var f = effFuel(world, i); if (f < 0.1) continue;
      var m = world.moisture ? clamp(fin(world.moisture[i], 0.5), 0, 1) : 0.5;
      var burnt = world.burn ? clamp(fin(world.burn[i], 0), 0, 1) : 0;
      var wt = f * Math.pow(1 - m, 1.5) * lf * (1 - 0.8 * burnt) * (1 + 1.2 * maps.humanProx[i]);
      if (!(wt > 0)) continue;
      w[c] = wt; total += wt;
    }
    if (!(total > 0)) {
      // nothing burnable in the requested set: fall back to any forest cell
      if (cand) return pickIgnitionCell(state, world, rng, null);
      return -1;
    }
    var r = rng.next() * total, acc = 0;
    for (c = 0; c < n; c++) { acc += w[c]; if (r < acc) return cand ? cand[c] : c; }
    for (c = n - 1; c >= 0; c--) if (w[c] > 0) return cand ? cand[c] : c;
    return -1;
  }

  function createSim(state, world, rng, startCell, opts) {
    opts = opts || {};
    var cl = (state && state.climate) || {};
    var d = clamp(fin(opts.danger, NaN), 0, 1);
    if (!isFinite(d)) { d = clamp(fin(cl.fireDanger, NaN), 0, 1); if (!isFinite(d)) d = danger(state, world); }
    var bc = burnableCells(world);
    var burnable = bc.forest + bc.shrub;
    var fs = {
      id: 'fire-' + ((state && state.turn) | 0) + '-' + (((state && state.fire && state.fire.fires) || []).length + 1),
      seed: (rng.next() * 4294967296) >>> 0,
      startCell: startCell, startZone: zoneOf(world, startCell),
      year: (state && state.year) || 1, season: seasonOf(state),
      burning: new Set(), burnedSet: new Set(),
      burnState: new Uint8Array(NN), burnAge: new Uint8Array(NN), burnTime: new Uint8Array(NN), severity: new Float32Array(NN),
      cellsBurned: [], zonesTouched: new Set(),
      stepCount: 0, maxSteps: 35 + Math.round(35 * d),
      windDir: fin(cl.windDirRad, 0.8), windSpeed: clamp(fin(cl.windMph, 8), 0, 80),
      danger: d, dangerLabel: dangerLabel(d),
      capCells: Math.max(50, Math.round(CAP_FRACTION * burnable)),
      acres: 0, perimeterCells: 0, done: false, extinguishedCount: 0,
      prescribedEscape: !!opts.prescribedEscape, forced: !!opts.forced
    };
    igniteCell(fs, world, startCell, d, rng);
    // a lightning/human start usually involves a small cluster
    var x = startCell % N, y = (startCell / N) | 0;
    for (var k = 0; k < 8; k++) {
      var nx = x + DX[k], ny = y + DY[k]; if (!C.inBounds(nx, ny)) continue;
      var j = ny * N + nx;
      if ((LAND_FACTOR[world.land ? world.land[j] : L.FOREST] || 0) > 0.3 && rng.chance(0.35)) igniteCell(fs, world, j, d, rng);
    }
    fs.acres = fs.cellsBurned.length * C.ACRES_PER_CELL;
    fs.perimeterCells = fs.burning.size;
    return fs;
  }

  function severityFor(world, i, d) {
    var f = effFuel(world, i);
    var td = world.treeDensity ? clamp(fin(world.treeDensity[i], 0.5), 0, 1) : 0.5;
    var lv = world.land ? world.land[i] : L.FOREST;
    var s = 0.2 + 0.4 * f + 0.25 * td + 0.3 * (d - 0.4);
    if (lv !== L.FOREST) s *= 0.8;
    return clamp(s, 0.1, 1);
  }

  function igniteCell(fs, world, i, d, rng) {
    if (fs.burnState[i] !== 0) return false;
    fs.burnState[i] = 1; fs.burnAge[i] = 0;
    fs.burnTime[i] = (effFuel(world, i) > 0.6 || rng.chance(0.4)) ? BURN_STEPS_MAX : BURN_STEPS_MIN;
    fs.severity[i] = severityFor(world, i, d);
    fs.burning.add(i); fs.cellsBurned.push(i);
    var z = zoneOf(world, i); if (z >= 0) fs.zonesTouched.add(z);
    return true;
  }
  function burnOut(fs, i) { fs.burnState[i] = 2; fs.burning.delete(i); fs.burnedSet.add(i); }

  function maybeIgnite(state, world, rng, forced) {
    if (!world || !rng) return null;
    ensureInit(world);
    state = state || {};
    state.fire = state.fire || {};
    if (!forced && state.fire.forcedIgnition) { forced = state.fire.forcedIgnition; state.fire.forcedIgnition = null; }
    if (!forced) {
      var p = seasonIgnitionChance(state, world);
      if (!rng.chance(p)) return null;
    }
    var start = -1;
    if (forced && forced.cell != null && forced.cell >= 0 && forced.cell < NN) start = forced.cell | 0;
    else start = pickIgnitionCell(state, world, rng, forced ? forced.zoneId : null);
    if (start < 0) return null;
    var fs = createSim(state, world, rng, start, { forced: !!forced, danger: forced && isFinite(forced.danger) ? forced.danger : undefined });
    return fs;
  }

  /* ---------- spread step ---------- */
  function step(fs, state, world, rng) {
    var out = { newlyBurning: [], extinguished: [], done: true, acres: 0, perimeterCells: 0 };
    if (!fs || !world) return out;
    out.acres = fs.acres; out.perimeterCells = fs.perimeterCells;
    if (fs.done) return out;
    rng = rng || WS.RNG.create(fs.seed + ':' + fs.stepCount);
    state = state || {};
    var fire = state.fire || {};
    var eff = effectsOf(state);
    var maps = ensureMaps(world);
    var d = fs.danger;
    var dangerFactor = DANGER_F0 + DANGER_F1 * d;
    // gusty wind: direction and speed wander a little each step (deterministic via rng)
    var wdir = fs.windDir + rng.gauss(0, 0.22);
    var wspd = fs.windSpeed * clamp(rng.gauss(1, 0.15), 0.6, 1.5);
    var ws = clamp(wspd / 22, 0, 1.15);
    var wf = new Float32Array(8);
    for (var k = 0; k < 8; k++) wf[k] = clamp(1 + ws * 0.85 * Math.cos(ANG[k] - wdir), 0.4, 1.8);
    fs.gustDir = wdir; fs.gustMph = wspd;

    var rb = fin(fire.responseBudget, 1);
    var strength = clamp(0.5 + 0.5 * rb, 0.4, 1.6);
    var focus = fire.crewFocus || null;
    var suppressAll = fire.policy === 'suppress_all';
    var elev = world.elev, land = world.land, moisture = world.moisture;
    var small = fs.cellsBurned.length < 40;
    var capReached = fs.cellsBurned.length >= fs.capCells;

    var cells = Array.from(fs.burning);
    for (var c = 0; c < cells.length; c++) {
      var i = cells[c];
      // --- suppression ---
      var s = 0;
      var sd = maps.stationDist[i];
      if (sd <= STATION_RADIUS) s = 0.25 + 0.35 * (1 - sd / STATION_RADIUS);
      var zi = zoneOf(world, i);
      if ((zi >= 0 && eff.hardenedZones[zi]) || nearZoneFlag(world, i, eff.fuelBreakZones)) s = Math.max(s, 0.35);
      s += 0.05 * (1 - d) * (suppressAll ? 1.5 : 1);
      if (small) s += 0.08 * (1 - d);
      if (focus) {
        var inArea = focus === 'town' ? (maps.area[i] & 1) : focus === 'farms' ? (maps.area[i] & 2) : focus === 'watershed' ? maps.upstream[i] : 0;
        s *= inArea ? 1.6 : 0.8;
      }
      // extreme fire weather overwhelms initial attack (crews pull back in 40 mph wind)
      s *= (1 - 0.5 * d) * (1 - 0.35 * ws);
      s = clamp(s * strength, 0, 0.9);
      if (s > 0 && rng.chance(s)) {
        fs.severity[i] *= 0.5; burnOut(fs, i); fs.extinguishedCount++; out.extinguished.push(i);
        continue;
      }
      // --- burn-out ---
      fs.burnAge[i]++;
      if (fs.burnAge[i] > fs.burnTime[i]) { burnOut(fs, i); continue; }
      if (capReached) continue;
      // --- spread to 8 neighbours ---
      var x = i % N, y = (i / N) | 0;
      for (k = 0; k < 8; k++) {
        var nx = x + DX[k], ny = y + DY[k]; if (!C.inBounds(nx, ny)) continue;
        var j = ny * N + nx;
        if (fs.burnState[j] !== 0) continue;
        var lv = land ? land[j] : L.FOREST;
        var lf = LAND_FACTOR[lv] || 0; if (lf <= 0) continue;
        var zj = zoneOf(world, j);
        if (lv === L.RESIDENTIAL && zj >= 0 && eff.hardenedZones[zj]) lf = 0.2;
        var f = effFuel(world, j); if (f <= 0.02) continue;
        var m = moisture ? clamp(fin(moisture[j], 0.5), 0, 1) : 0.5;
        var thin = (zj >= 0 && eff.thinnedZones[zj]) ? clamp(fin(+eff.thinnedZones[zj], 0), 0, 1) : 0;
        var fb = nearZoneFlag(world, j, eff.fuelBreakZones) ? 0.45 : 1;
        var grade = elev ? (fin(elev[j], 0) - fin(elev[i], 0)) / C.CELL_M : 0;
        var sf = clamp(1 + 1.2 * grade, 0.6, 1.9);
        var p = BASE_SPREAD * f * Math.pow(1 - m, 1.5) * wf[k] * sf * dangerFactor * (1 - thin * 0.6) * lf * fb * (DIAG[k] ? DIAG_FACTOR : 1);
        p = clamp(isFinite(p) ? p : 0, 0, 0.95);
        if (p > 0 && rng.chance(p)) {
          if (igniteCell(fs, world, j, d, rng)) out.newlyBurning.push(j);
          if (fs.cellsBurned.length >= fs.capCells) { capReached = true; break; }
        }
      }
    }
    fs.stepCount++;
    fs.acres = fs.cellsBurned.length * C.ACRES_PER_CELL;
    fs.perimeterCells = fs.burning.size;
    var done = fs.burning.size === 0 || fs.stepCount >= fs.maxSteps;
    if (done) {
      var rest = Array.from(fs.burning);
      for (c = 0; c < rest.length; c++) burnOut(fs, rest[c]);
      fs.done = true; fs.perimeterCells = 0;
    }
    out.done = done; out.acres = fs.acres; out.perimeterCells = fs.perimeterCells;
    return out;
  }

  /* ---------- finalize: write results into world + state ---------- */
  function finalize(fs, state, world) {
    var rep = { acres: 0, upstreamAcres: 0, structuresLost: 0, zoneIds: [], severityAvg: 0, smokeDays: 0, cellsBurned: new Int32Array(0), startCell: -1 };
    if (!fs || !world) return rep;
    ensureInit(world);
    if (!fs.done) { // make sure nothing is left burning
      var rest = Array.from(fs.burning);
      for (var r = 0; r < rest.length; r++) burnOut(fs, rest[r]);
      fs.done = true;
    }
    var maps = ensureMaps(world);
    var eff = effectsOf(state);
    var cells = fs.cellsBurned, n = cells.length;
    var sevSum = 0, up = 0, i, c, sev;
    for (c = 0; c < n; c++) {
      i = cells[c]; sev = clamp(fin(fs.severity[i], 0.3), 0, 1); sevSum += sev;
      if (world.burn) world.burn[i] = Math.max(fin(world.burn[i], 0), sev);
      if (world.fuel) world.fuel[i] = clamp(fin(world.fuel[i], 0) * 0.15, 0, 1);
      if (world.treeDensity) world.treeDensity[i] = clamp(fin(world.treeDensity[i], 0) * (1 - sev * 0.85), 0, 1);
      if (world.moisture) world.moisture[i] = clamp(fin(world.moisture[i], 0.5) - 0.15, 0, 1);
      if (world.habitat) world.habitat[i] = clamp(fin(world.habitat[i], 0) * (1 - 0.6 * sev), 0, 1);
      if (maps.upstream[i]) up++;
    }
    // structures: houses in burned residential cells
    var lost = 0;
    var srng = WS.RNG.create(fs.seed + ':structures');
    var buildings = world.buildings || [];
    for (var b = 0; b < buildings.length; b++) {
      var bd = buildings[b]; if (!bd || bd.type !== 'house' || bd.burned) continue;
      var bi = (bd.y | 0) * N + (bd.x | 0);
      if (bi < 0 || bi >= NN || fs.burnState[bi] !== 2) continue;
      var hardened = bd.zoneId != null && bd.zoneId >= 0 && eff.hardenedZones[bd.zoneId];
      if (srng.chance(hardened ? 0.15 : 0.55)) { lost++; bd.burned = true; }
    }
    rep.acres = n * C.ACRES_PER_CELL;
    rep.upstreamAcres = up * C.ACRES_PER_CELL;
    rep.structuresLost = lost;
    rep.zoneIds = Array.from(fs.zonesTouched).sort(function (a, b2) { return a - b2; });
    rep.severityAvg = n ? sevSum / n : 0;
    rep.smokeDays = n ? clamp(Math.round(2 + rep.acres / 350), 1, 40) : 0;
    rep.cellsBurned = Int32Array.from(cells);
    rep.startCell = fs.startCell;
    rep.extinguishedCells = fs.extinguishedCount;
    rep.danger = fs.danger;
    if (state) {
      state.fire = state.fire || {};
      var sf = state.fire;
      sf.seasonAcres = fin(sf.seasonAcres, 0) + rep.acres;
      sf.totalAcres = fin(sf.totalAcres, 0) + rep.acres;
      sf.structuresLost = fin(sf.structuresLost, 0) + lost;
      sf.smokeDays = fin(sf.smokeDays, 0) + rep.smokeDays;
      sf.fires = sf.fires || [];
      sf.fires.push({ year: fin(state.year, fs.year), season: seasonOf(state), acres: rep.acres, zoneIds: rep.zoneIds.slice(),
                      structures: lost, upstream: rep.upstreamAcres, severityAvg: rep.severityAvg, startCell: fs.startCell, id: fs.id });
    }
    return rep;
  }

  /* ---------- annual bookkeeping (each Winter) ---------- */
  function updateAnnual(state, world) {
    var out = { fuelAvg: 0, burnedCells: 0 };
    if (!world || !world.land) return out;
    var init = ensureInit(world);
    var suppress = state && state.fire && state.fire.policy === 'suppress_all';
    var mult = suppress ? 1.6 : 1;
    var land = world.land, fuel = world.fuel, burn = world.burn, td = world.treeDensity, regrow = world.regrow, hab = world.habitat;
    var burned = 0, fsum = 0, fn = 0;
    for (var i = 0; i < NN; i++) {
      var lv = land[i];
      if (fuel) {
        if (lv === L.FOREST) fuel[i] = clamp(fin(fuel[i], 0) + 0.04 * mult, 0, 1);
        else if (lv === L.SHRUB) fuel[i] = clamp(fin(fuel[i], 0) + 0.03 * mult, 0, 1);
        if (lv === L.FOREST || lv === L.SHRUB) { fsum += fuel[i]; fn++; }
      }
      if (burn) {
        var b = fin(burn[i], 0);
        if (b > 0) {
          var rg = regrow ? 1 + clamp(fin(regrow[i], 0), 0, 1) : 1;
          burn[i] = clamp(b - 0.12 * rg, 0, 1);
          if (burn[i] > 0) burned++;
          if (hab && init && init.habitat) hab[i] = clamp(fin(hab[i], 0) + 0.05 * rg, 0, init.habitat[i]);
        }
      }
      if (td && init && init.treeDensity) {
        var t0 = init.treeDensity[i], t = fin(td[i], 0);
        if (t < t0) td[i] = Math.min(t0, t + 0.015 + 0.01 * (regrow ? clamp(fin(regrow[i], 0), 0, 1) : 0));
      }
    }
    out.fuelAvg = fn ? fsum / fn : 0; out.burnedCells = burned;
    return out;
  }

  /* ---------- prescribed burn ---------- */
  function prescribedBurn(state, world, zoneId, rng) {
    var out = { success: false, escaped: false, cellsTreated: 0, fuelBefore: 0, fuelAfter: 0, escapeFire: null, zoneId: zoneId };
    if (!world || !world.fuel || !world.zones) return out;
    ensureInit(world);
    rng = rng || WS.RNG.create('rxburn:' + zoneId + ':' + ((state && state.turn) | 0));
    var zn = null;
    for (var z = 0; z < world.zones.length; z++) if (world.zones[z] && world.zones[z].id === zoneId) { zn = world.zones[z]; break; }
    if (!zn || !zn.cells) return out;
    var before = 0, after = 0, n = 0, i, c, lv;
    for (c = 0; c < zn.cells.length; c++) {
      i = zn.cells[c]; lv = world.land ? world.land[i] : L.FOREST;
      if (lv !== L.FOREST && lv !== L.SHRUB) continue;
      before += fin(world.fuel[i], 0); n++;
    }
    if (n === 0) return out;
    var cl = (state && state.climate) || {};
    var d = clamp(fin(cl.fireDanger, NaN), 0, 1); if (!isFinite(d)) d = danger(state, world);
    var pEsc = 0.04 * (d > 0.5 ? 3 : 1) * (seasonOf(state) === C.SEASON.WINTER ? 0.5 : 1);
    var escaped = rng.chance(pEsc);
    // treat the sector: with an escape the crews still got most of the unit done
    var treatFrac = escaped ? 0.6 : 1;
    for (c = 0; c < zn.cells.length; c++) {
      i = zn.cells[c]; lv = world.land ? world.land[i] : L.FOREST;
      if (lv !== L.FOREST && lv !== L.SHRUB) continue;
      var f = fin(world.fuel[i], 0);
      if (treatFrac >= 1 || rng.chance(treatFrac)) { f = clamp(f * 0.4, 0, 1); out.cellsTreated++; }
      world.fuel[i] = f; after += f;
    }
    out.fuelBefore = before / n; out.fuelAfter = after / n;
    out.success = !escaped; out.escaped = escaped;
    if (escaped) {
      var start = pickIgnitionCell(state, world, rng, zoneId);
      if (start >= 0) out.escapeFire = createSim(state, world, rng, start, { prescribedEscape: true, danger: clamp(d + 0.1, 0, 1) });
      else out.escaped = false;
    }
    if (state) { state.fire = state.fire || {}; state.fire.prescribedBurns = fin(state.fire.prescribedBurns, 0) + 1; }
    return out;
  }

  WS.Fire = {
    updateAnnual: updateAnnual,
    seasonIgnitionChance: seasonIgnitionChance,
    maybeIgnite: maybeIgnite,
    step: step,
    finalize: finalize,
    prescribedBurn: prescribedBurn,
    danger: danger,
    dangerLabel: dangerLabel,
    fuelStats: fuelStats,
    LAND_FACTOR: LAND_FACTOR
  };
})();
