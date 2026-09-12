/* Watershed — wildfire model. Export WS.Fire.
   Cellular-automaton spread on the 128x128 grid with wind, slope, fuel, moisture, land cover,
   thinning / fuel breaks / home hardening (from WS.Projects.effects) and suppression near fire
   stations. Pure sim: runs in Node, no DOM.
   v2: real-time tactics (dozer lines, air-tanker drops, engine crews, evacuations, mutual aid),
   gusting wind, a threat summary for the tactical HUD and a deterministic no-tactics replay
   for the after-action counterfactual. Every random draw inside a fire is a pure function of
   (fireSim.seed, step, cell) so a fire can be replayed exactly from its seed + startCell. */
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
  // Tactical (player-fought) fires run at ~0.8 s/step: each cell burns 4-6 steps so the front is wide and glowing,
  // and per-step spread / suppression are scaled by TAC_RATE so the fire's total growth per cell-lifetime stays
  // the same as v1 (2-3 step cells). maxSteps 55..90 instead of 45..70; a fire that would die before
  // SMOULDER_UNTIL steps keeps a few cells smouldering (low spread, no suppression) so the player has time to act.
  var TAC_BURN_MIN = 4, TAC_BURN_MAX = 6, TAC_RATE = 0.62, TAC_STEPS_MIN = 55, TAC_STEPS_SPAN = 35;
  var SMOULDER_UNTIL = 18, SMOULDER_CELLS = 3, SMOULDER_SPREAD = 0.35;
  var CAP_FRACTION = 0.45;         // single fire <= 45% of forest(+shrub) cells
  var IGNITION_MULT = 1.35;        // v2: fires happen more often
  var IGNITION_CAP = 0.68;         // keeps Extreme summers below a near-certainty
  var LATE_GAME_MIN_CHANCE = 0.55; // a fire-less game gets a hot summer from year 2 on
  var GUST_DEG = 25, GUST_MIN = 6, GUST_MAX = 10;
  var BREAK_CROSS = 0.05;          // spread across a finished dozer line
  var WET_BLOCK = 0.85, WET_DECAY = 0.02;
  var ENGINE_SPREAD = 0.35, ENGINE_LOSS = 0.15, HARDENED_LOSS = 0.15, BASE_LOSS = 0.55;
  var THREAT_SAMPLE = 400;         // burning cells sampled for zone distances
  var AT_RISK_RADIUS = 4;

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

  var TACTICS = {
    dozer:      { name: 'Dozer / hand line', icon: '🚜', costPts: 1 /* per cell */, digSteps: 2, desc: 'Scrape a fuel break. Cells become a firebreak after 2 steps; fire almost never crosses a finished line.' },
    retardant:  { name: 'Air tanker drop',   icon: '✈️', costPts: 5, radius: 2, cooldownSteps: 8, maxUses: 4, desc: 'Retardant coats a 5×5 patch: spread through it drops ~85% and slowly weakens.' },
    engine:     { name: 'Engine crew',       icon: '🚒', costPts: 6, max: 2, desc: 'Station an engine in a neighborhood: fire entering it slows and only 15% of reached homes are lost.' },
    evacuate:   { name: 'Evacuation order',  icon: '📢', costPts: 0, desc: 'Empty a neighborhood: no injuries if fire reaches it; trust dips if it never did.' },
    mutual_aid: { name: 'Call mutual aid',   icon: '📞', costPts: 0, costM: 1.5, maxUses: 1, gainPts: 10, desc: 'Neighboring counties send crews: +10 crew points now, $1.5M from the budget.' }
  };
  var CREW_START = 12, CREW_PER_STATION = 4, CREW_MAX = 30, REGEN = 0.3, REGEN_SUPPRESS = 0.45;

  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function seasonOf(state) { return state && isFinite(state.season) ? (state.season | 0) : (state && isFinite(state.turn) ? (state.turn % 4) : 2); }

  /* ---------- deterministic per-(seed, step, cell, channel) uniform in [0,1) ---------- */
  function mix(h) { h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B); h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35); return (h ^ (h >>> 16)) >>> 0; }
  function u01(seed, step, cell, ch) {
    var h = (seed ^ Math.imul((step | 0) + 1, 0x9E3779B1)) | 0;
    h = mix(h + Math.imul((cell | 0) + 1, 0x85EBCA77));
    h = mix(h ^ Math.imul((ch | 0) + 1, 0xC2B2AE3D));
    return h / 4294967296;
  }
  // channels: 8 suppression, 9 spread (k added), 10 burn time, 11 start cluster, 200 structure loss, 201 injury

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
          stationDist: new Uint8Array(NN), humanProx: new Float32Array(NN), area: new Uint8Array(NN), upstream: new Uint8Array(NN), zoneDist: {} };
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
      // Chebyshev distance to the nearest road/house/civic cell (human proximity for ignition weighting,
      // 0..6), to the nearest town cell (<=4: crewFocus 'town' area) and farm cell (<=3: 'farms' area).
      // Multi-source BFS over 8-neighbours is exact for Chebyshev distance and O(N*N) (~5 ms vs ~130 ms).
      var R = 6, dist = new Uint8Array(NN), queue = new Int32Array(NN);
      var bfs = function (isSrc, maxD) {
        dist.fill(255);
        var head = 0, tail = 0, q;
        for (q = 0; q < NN; q++) if (isSrc(land[q])) { dist[q] = 0; queue[tail++] = q; }
        while (head < tail) {
          q = queue[head++]; var nd = dist[q] + 1; if (nd > maxD) continue;
          var qx = q % N, qy = (q / N) | 0;
          for (var k = 0; k < 8; k++) {
            var ax = qx + DX[k], ay = qy + DY[k]; if (ax < 0 || ay < 0 || ax >= N || ay >= N) continue;
            var aj = ay * N + ax; if (dist[aj] > nd) { dist[aj] = nd; queue[tail++] = aj; }
          }
        }
      };
      bfs(function (lv) { return lv === L.ROAD || lv === L.RESIDENTIAL || lv === L.CIVIC; }, R);
      for (i = 0; i < NN; i++) { d = dist[i]; if (d <= R) m.humanProx[i] = 1 - Math.max(0, d - 2) / (R - 2); }
      bfs(function (lv) { return lv === L.RESIDENTIAL || lv === L.CIVIC; }, 4);
      for (i = 0; i < NN; i++) if (dist[i] <= 4) m.area[i] |= 1;
      bfs(function (lv) { return lv === L.FARM; }, 3);
      for (i = 0; i < NN; i++) if (dist[i] <= 3) m.area[i] |= 2;
    }
    if (typeof world.isUpstreamOfReservoir === 'function') {
      for (i = 0; i < NN; i++) { try { m.upstream[i] = world.isUpstreamOfReservoir(i) ? 1 : 0; } catch (e) { m.upstream[i] = 0; } }
    }
    world._fireMaps = m;
    return m;
  }

  /* Chebyshev distance field to a zone (multi-source BFS over 8-neighbours), cached per world. */
  function zoneDistField(maps, zn) {
    var f = maps.zoneDist[zn.id];
    if (f) return f;
    f = new Uint8Array(NN); f.fill(255);
    var queue = new Int32Array(NN), head = 0, tail = 0, c, i;
    for (c = 0; c < zn.cells.length; c++) { i = zn.cells[c]; if (i >= 0 && i < NN && f[i] !== 0) { f[i] = 0; queue[tail++] = i; } }
    while (head < tail) {
      i = queue[head++]; var x = i % N, y = (i / N) | 0, nd = f[i] + 1; if (nd > 254) continue;
      for (var k = 0; k < 8; k++) {
        var nx = x + DX[k], ny = y + DY[k]; if (!C.inBounds(nx, ny)) continue;
        var j = ny * N + nx; if (f[j] > nd) { f[j] = nd; queue[tail++] = j; }
      }
    }
    maps.zoneDist[zn.id] = f;
    return f;
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
  function hasKeys(o) { if (!o) return false; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return true; return false; }
  function zoneById(world, id) {
    if (!world || id == null || id < 0) return null;
    if (typeof world.zoneById === 'function') { try { var z = world.zoneById(id); if (z) return z; } catch (e) { /* fall through */ } }
    var zones = world.zones || [];
    for (var k = 0; k < zones.length; k++) if (zones[k] && zones[k].id === id) return zones[k];
    return null;
  }
  function zoneName(world, id) { var z = zoneById(world, id); return z && z.name ? z.name : ('Zone ' + id); }

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
    // piecewise-linear (v1): Moderate ~8%, High ~20%, Very High ~38%, Extreme ~60%; v2 scales ×1.35 (capped)
    var xs = [0, 0.3, 0.5, 0.7, 0.9, 1.0], ys = [0.02, 0.08, 0.20, 0.38, 0.60, 0.70];
    var p = ys[ys.length - 1];
    for (var i = 1; i < xs.length; i++) if (d <= xs[i]) { p = C.lerp(ys[i - 1], ys[i], (d - xs[i - 1]) / (xs[i] - xs[i - 1])); break; }
    var seasonMult = season === C.SEASON.SUMMER ? 1.0 : season === C.SEASON.FALL ? 0.8 : 0.6;
    var windMult = clamp(1 + 0.012 * (fin(cl.windMph, 8) - 8), 0.8, 1.4);
    var dr = cl.drought; var droughtMult = dr === 'D4' ? 1.35 : dr === 'D3' ? 1.25 : dr === 'D2' ? 1.15 : 1;
    p = clamp(p * seasonMult * windMult * droughtMult * IGNITION_MULT, 0, IGNITION_CAP);
    // a game that has had no fire by its second summer gets one soon: the roll is bumped to >= 55%
    var fires = (state && state.fire && state.fire.fires) || [];
    if (fires.length === 0 && fin(state && state.year, 1) >= 2 && season === C.SEASON.SUMMER) p = Math.max(p, LATE_GAME_MIN_CHANCE);
    return p;
  }

  function pickIgnitionCell(state, world, rng, zoneId) {
    var maps = ensureMaps(world);
    var cand = null;
    if (zoneId != null && zoneId >= 0 && world.zones) {
      var zn = zoneById(world, zoneId);
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
      // favour well-connected fuel: count burnable 8-neighbours so forced/lightning fires don't fizzle on rock or the map edge
      var px = i % N, py = (i / N) | 0, nb = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; var qx = px + dx, qy = py + dy; if (qx < 0 || qy < 0 || qx >= N || qy >= N) continue;
        var q = qy * N + qx; if ((LAND_FACTOR[world.land ? world.land[q] : L.FOREST] || 0) > 0.3 && effFuel(world, q) >= 0.3) nb++;
      }
      wt *= (nb < 5) ? 0.05 : (f >= 0.4 ? 1.5 : 1);
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
    var seed = (opts.seed != null) ? (opts.seed >>> 0) : (rng ? (rng.next() * 4294967296) >>> 0 : (Math.random() * 4294967296) >>> 0);
    var fs = {
      id: opts.id || ('fire-' + ((state && state.turn) | 0) + '-' + (((state && state.fire && state.fire.fires) || []).length + 1)),
      seed: seed,
      startCell: startCell, startZone: zoneOf(world, startCell),
      year: (state && state.year) || 1, season: seasonOf(state),
      burning: new Set(), burnedSet: new Set(),
      burnState: new Uint8Array(NN), burnAge: new Uint8Array(NN), burnTime: new Uint8Array(NN), severity: new Float32Array(NN),
      cellsBurned: [], zonesTouched: new Set(),
      stepCount: 0, maxSteps: (opts.maxSteps != null) ? (opts.maxSteps | 0) : 45 + Math.round(25 * d), // v2: 45..70 (v1 tests cap at 70); startTactics raises this to 55..90
      windDir: fin(opts.windDir, fin(cl.windDirRad, 0.8)), windSpeed: (opts.windSpeed != null) ? fin(opts.windSpeed, 8) : clamp(fin(cl.windMph, 8), 0, 80),
      danger: d, dangerLabel: dangerLabel(d),
      capCells: (opts.capCells != null) ? (opts.capCells | 0) : Math.max(50, Math.round(CAP_FRACTION * burnable)),
      acres: 0, perimeterCells: 0, done: false, extinguishedCount: 0,
      prescribedEscape: !!opts.prescribedEscape, forced: !!opts.forced,
      // gusts + growth history (for threat())
      gustOff: 0, gustSpd: 1, nextGust: 0, gustDir: 0, gustMph: 0,
      hist: [], bx0: N, by0: N, bx1: -1, by1: -1, sumX: 0, sumY: 0,
      tactics: null, tacticalMode: !!opts.tacticalMode
    };
    fs.gustDir = fs.windDir; fs.gustMph = fs.windSpeed;
    fs.nextGust = GUST_MIN + Math.floor(u01(seed, 0, 0, 12) * (GUST_MAX - GUST_MIN + 1));
    igniteCell(fs, world, startCell, d);
    // a lightning/human start usually involves a small cluster
    var x = startCell % N, y = (startCell / N) | 0;
    for (var k = 0; k < 8; k++) {
      var nx = x + DX[k], ny = y + DY[k]; if (!C.inBounds(nx, ny)) continue;
      var j = ny * N + nx;
      if ((LAND_FACTOR[world.land ? world.land[j] : L.FOREST] || 0) > 0.3 && u01(seed, 0, j, 11) < 0.35) igniteCell(fs, world, j, d);
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

  function igniteCell(fs, world, i, d) {
    if (fs.burnState[i] !== 0) return false;
    fs.burnState[i] = 1; fs.burnAge[i] = 0;
    fs.burnTime[i] = burnTimeFor(fs, world, i);
    fs.severity[i] = severityFor(world, i, d);
    fs.burning.add(i); fs.cellsBurned.push(i);
    var z = zoneOf(world, i); if (z >= 0) fs.zonesTouched.add(z);
    var x = i % N, y = (i / N) | 0;
    if (x < fs.bx0) fs.bx0 = x; if (x > fs.bx1) fs.bx1 = x; if (y < fs.by0) fs.by0 = y; if (y > fs.by1) fs.by1 = y;
    fs.sumX += x; fs.sumY += y;
    return true;
  }
  function burnOut(fs, i) { fs.burnState[i] = 2; fs.burning.delete(i); fs.burnedSet.add(i); }
  // Steps a cell burns: 2-3 in v1 (watch-only) fires, 4-6 in tactical ones. Deterministic in (seed, cell) so the replay matches.
  function burnTimeFor(fs, world, i) {
    var heavy = effFuel(world, i) > 0.6, u = u01(fs.seed, 0, i, 10);
    if (!fs.tacticalMode) return (heavy || u < 0.4) ? BURN_STEPS_MAX : BURN_STEPS_MIN;
    return TAC_BURN_MIN + (heavy ? 1 : 0) + ((u < 0.4) ? 1 : 0); // 4, 5 or 6
  }

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

  /* ---------- gusting wind: ±25° shifts every 6–10 steps plus a little per-step wander ---------- */
  function updateGust(fs, srng) {
    if (fs.stepCount >= fs.nextGust) {
      fs.gustOff = srng.range(-1, 1) * GUST_DEG * Math.PI / 180;
      fs.gustSpd = clamp(srng.gauss(1, 0.18), 0.7, 1.4);
      fs.nextGust = fs.stepCount + srng.int(GUST_MIN, GUST_MAX);
    }
    fs.gustDir = fs.windDir + fs.gustOff + srng.gauss(0, 0.06);
    fs.gustMph = clamp(fs.windSpeed * fs.gustSpd * clamp(srng.gauss(1, 0.08), 0.8, 1.25), 0, 90);
  }

  /* ---------- tactics ---------- */
  function startTactics(fs, state, world) {
    if (!fs) return null;
    var wasTactical = !!fs.tacticalMode;
    fs.tacticalMode = true; // player-fought fire: automatic station suppression is reduced (see step); the replay inherits this flag
    if (!wasTactical) {
      // longer, slower-paced fire: cells already alight get tactical burn times and the step budget grows to 55..90
      fs.burning.forEach(function (i) { fs.burnTime[i] = burnTimeFor(fs, world, i); });
      if (fs.stepCount === 0) fs.maxSteps = TAC_STEPS_MIN + Math.round(TAC_STEPS_SPAN * clamp(fin(fs.danger, 0.5), 0, 1));
    }
    var nSt = 0;
    if (world) { try { nSt = ensureMaps(world).nStations; } catch (e) { nSt = 0; } }
    var suppressAll = !!(state && state.fire && state.fire.policy === 'suppress_all');
    var T = {
      crewPts: CREW_START + CREW_PER_STATION * nSt, crewMax: CREW_MAX, regenPerStep: suppressAll ? REGEN_SUPPRESS : REGEN,
      breaks: new Uint8Array(NN), digTimer: new Uint8Array(NN), wet: new Float32Array(NN),
      engines: {}, evacuated: {}, drops: 0, dropCooldown: 0, mutualAidUsed: false, used: {}, log: [],
      digging: 0, wetCells: 0, digLost: 0, stations: nSt
    };
    T.crewPts = Math.min(T.crewMax, T.crewPts);
    T.log.push({ step: fs.stepCount, text: 'Initial attack: ' + T.crewPts + ' crew points (' + nSt + ' fire station' + (nSt === 1 ? '' : 's') + ').' });
    fs.tactics = T;
    return T;
  }

  function tacticsTick(fs, T) {
    T.crewPts = Math.min(T.crewMax, T.crewPts + T.regenPerStep);
    if (T.dropCooldown > 0) T.dropCooldown--;
    var i;
    if (T.digging > 0) {
      var left = 0;
      for (i = 0; i < NN; i++) {
        if (T.breaks[i] !== 1) continue;
        if (T.digTimer[i] > 1) { T.digTimer[i]--; left++; continue; }
        T.digTimer[i] = 0;
        if (fs.burnState[i] === 0) T.breaks[i] = 2; else { T.breaks[i] = 0; T.digLost++; }
      }
      T.digging = left;
    }
    if (T.wetCells > 0) {
      var wc = 0;
      for (i = 0; i < NN; i++) { var w = T.wet[i]; if (w > 0) { w -= WET_DECAY; T.wet[i] = w > 0 ? w : 0; if (w > 0) wc++; } }
      T.wetCells = wc;
    }
  }

  function dozerAccepts(fs, world, T, i) {
    if (!(i >= 0 && i < NN)) return false;
    if (fs.burnState[i] !== 0 || T.breaks[i] !== 0) return false;
    var lv = world.land ? world.land[i] : L.FOREST;
    return !(lv === L.RIVER || lv === L.RESERVOIR || lv === L.ROAD);
  }

  function canApply(fs, state, world, type, target) {
    var def = TACTICS[type];
    if (!def) return { ok: false, reason: 'Unknown tactic.', cost: 0 };
    if (!fs || !world) return { ok: false, reason: 'No active fire.', cost: 0 };
    var T = fs.tactics;
    if (!T) return { ok: false, reason: 'Tactics have not been started for this fire.', cost: 0 };
    if (fs.done) return { ok: false, reason: 'The fire is out.', cost: 0 };
    var pts = Math.floor(T.crewPts + 1e-9);
    var zn, count;
    switch (type) {
      case 'dozer':
        if (!target || !target.length) return { ok: false, reason: 'Drag on the map to cut a line.', cost: 0 };
        count = 0;
        for (var c = 0; c < target.length; c++) if (dozerAccepts(fs, world, T, target[c] | 0)) count++;
        if (count === 0) return { ok: false, reason: 'No workable cells: lines cannot cross burning, burned, water or road cells.', cost: 0 };
        if (pts < 1) return { ok: false, reason: 'Not enough crew points (need 1 per cell).', cost: count };
        return { ok: true, reason: pts < count ? 'Crews can only cut ' + pts + ' of ' + count + ' cells right now.' : '', cost: Math.min(count, pts) };
      case 'retardant':
        if (!(target >= 0 && target < NN)) return { ok: false, reason: 'Pick a cell for the drop.', cost: def.costPts };
        if (T.drops >= def.maxUses) return { ok: false, reason: 'No air tankers left this fire (' + def.maxUses + ' drops max).', cost: def.costPts };
        if (T.dropCooldown > 0) return { ok: false, reason: 'Tanker reloading — ' + T.dropCooldown + ' more step' + (T.dropCooldown === 1 ? '' : 's') + '.', cost: def.costPts };
        if (pts < def.costPts) return { ok: false, reason: 'Not enough crew points (need ' + def.costPts + ').', cost: def.costPts };
        return { ok: true, reason: '', cost: def.costPts };
      case 'engine':
        zn = zoneById(world, target);
        if (!zn || zn.type !== 'neighborhood') return { ok: false, reason: 'Engines can only be stationed in a neighborhood.', cost: def.costPts };
        if (T.engines[zn.id]) return { ok: false, reason: 'An engine is already stationed in ' + zn.name + '.', cost: def.costPts };
        if (Object.keys(T.engines).length >= def.max) return { ok: false, reason: 'All ' + def.max + ' engines are committed.', cost: def.costPts };
        if (pts < def.costPts) return { ok: false, reason: 'Not enough crew points (need ' + def.costPts + ').', cost: def.costPts };
        return { ok: true, reason: '', cost: def.costPts };
      case 'evacuate':
        zn = zoneById(world, target);
        if (!zn || zn.type !== 'neighborhood') return { ok: false, reason: 'Evacuation orders apply to neighborhoods.', cost: 0 };
        if (T.evacuated[zn.id]) return { ok: false, reason: zn.name + ' is already evacuated.', cost: 0 };
        return { ok: true, reason: '', cost: 0 };
      case 'mutual_aid':
        if (T.mutualAidUsed) return { ok: false, reason: 'Mutual aid has already been called.', cost: 0 };
        var budget = fin(state && state.budget, 0), fund = fin(state && state.emergencyFund, 0);
        if (budget + 1e-9 < def.costM && fund + 1e-9 < def.costM) return { ok: false, reason: 'Cannot fund mutual aid: needs $' + def.costM.toFixed(1) + 'M from the budget or emergency fund.', cost: 0 };
        return { ok: true, reason: '', cost: 0 };
    }
    return { ok: false, reason: 'Unknown tactic.', cost: 0 };
  }

  function applyTactic(fs, state, world, type, target) {
    var chk = canApply(fs, state, world, type, target);
    var res = { ok: chk.ok, reason: chk.reason, cost: 0, cells: [], text: '' };
    if (!chk.ok) return res;
    var def = TACTICS[type], T = fs.tactics, c, i, x, y, zn, name;
    T.used[type] = (T.used[type] || 0) + 1;
    switch (type) {
      case 'dozer': {
        var seen = {};
        for (c = 0; c < target.length; c++) {
          i = target[c] | 0;
          if (seen[i] || !dozerAccepts(fs, world, T, i)) continue;
          if (T.crewPts + 1e-9 < def.costPts) { res.reason = 'Crews ran out of points after ' + res.cells.length + ' cells.'; break; }
          seen[i] = true;
          T.breaks[i] = 1; T.digTimer[i] = def.digSteps; T.digging++;
          T.crewPts -= def.costPts; res.cost += def.costPts; res.cells.push(i);
        }
        res.text = 'Line cut: ' + res.cells.length + ' cell' + (res.cells.length === 1 ? '' : 's') + ' (' + res.cost + ' pts); ready in ' + def.digSteps + ' steps.';
        break;
      }
      case 'retardant': {
        T.crewPts -= def.costPts; res.cost = def.costPts;
        T.drops++; T.dropCooldown = def.cooldownSteps;
        x = target % N; y = (target / N) | 0;
        var knocked = 0;
        for (var dy = -def.radius; dy <= def.radius; dy++) for (var dx = -def.radius; dx <= def.radius; dx++) {
          var nx = x + dx, ny = y + dy; if (!C.inBounds(nx, ny)) continue;
          i = ny * N + nx;
          if (T.wet[i] <= 0) T.wetCells++;
          T.wet[i] = 1;
          if (fs.burnState[i] === 1) { fs.burnAge[i] = fs.burnTime[i]; fs.severity[i] *= 0.7; knocked++; } // flames knocked down: burns out next step
          res.cells.push(i);
        }
        res.text = 'Air tanker drop at (' + x + ', ' + y + '): ' + res.cells.length + ' cells coated' + (knocked ? ', ' + knocked + ' burning cells knocked down' : '') + '.';
        break;
      }
      case 'engine': {
        zn = zoneById(world, target); name = zn.name;
        T.crewPts -= def.costPts; res.cost = def.costPts;
        T.engines[zn.id] = true;
        for (c = 0; c < zn.cells.length; c++) res.cells.push(zn.cells[c]);
        res.text = 'Engine crew stationed in ' + name + '.';
        break;
      }
      case 'evacuate': {
        zn = zoneById(world, target); name = zn.name;
        T.evacuated[zn.id] = true;
        for (c = 0; c < zn.cells.length; c++) res.cells.push(zn.cells[c]);
        res.text = 'Evacuation ordered for ' + name + '.';
        break;
      }
      case 'mutual_aid': {
        var src = 'budget';
        if (fin(state.budget, 0) + 1e-9 >= def.costM) state.budget = fin(state.budget, 0) - def.costM;
        else { state.emergencyFund = fin(state.emergencyFund, 0) - def.costM; src = 'emergency fund'; }
        T.mutualAidUsed = true;
        T.crewPts = Math.min(T.crewMax, T.crewPts + def.gainPts);
        res.costM = def.costM;
        res.text = 'Mutual aid arrives: +' + def.gainPts + ' crew points ($' + def.costM.toFixed(1) + 'M from the ' + src + ').';
        break;
      }
    }
    T.log.push({ step: fs.stepCount, text: res.text });
    return res;
  }

  /* ---------- spread step ---------- */
  function step(fs, state, world, rng) {
    var out = { newlyBurning: [], extinguished: [], done: true, acres: 0, perimeterCells: 0 };
    if (!fs || !world) return out;
    out.acres = fs.acres; out.perimeterCells = fs.perimeterCells;
    if (fs.done) return out;
    // The fire owns its randomness (pure function of seed/step/cell) so replayWithoutTactics is exact.
    // The caller's rng is accepted for API compatibility but not consumed.
    var seed = fs.seed >>> 0, stepNo = fs.stepCount;
    var srng = WS.RNG.create(seed + ':' + stepNo);
    state = state || {};
    var fire = state.fire || {};
    var eff = effectsOf(state);
    var maps = ensureMaps(world);
    var T = fs.tactics || null;
    var d = fs.danger;
    var dangerFactor = DANGER_F0 + DANGER_F1 * d;
    updateGust(fs, srng);
    var wdir = fs.gustDir, wspd = fs.gustMph;
    var ws = clamp(wspd / 22, 0, 1.15);
    var wf = new Float32Array(8);
    for (var k = 0; k < 8; k++) wf[k] = clamp(1 + ws * 0.85 * Math.cos(ANG[k] - wdir), 0.4, 1.8);
    if (T) tacticsTick(fs, T);

    var rb = fin(fire.responseBudget, 1);
    var strength = clamp(0.5 + 0.5 * rb, 0.4, 1.6);
    var focus = fire.crewFocus || null;
    var suppressAll = fire.policy === 'suppress_all';
    var elev = world.elev, land = world.land, moisture = world.moisture;
    var small = fs.cellsBurned.length < 40;
    var capReached = fs.cellsBurned.length >= fs.capCells;
    var tactical = !!fs.tacticalMode;
    // hot-loop shortcuts: the 8-neighbour zone scans only matter when such a zone exists
    var anyFB = hasKeys(eff.fuelBreakZones), anyHard = hasKeys(eff.hardenedZones), anyThin = hasKeys(eff.thinnedZones);

    var cells = Array.from(fs.burning);
    for (var c = 0; c < cells.length; c++) {
      var i = cells[c];
      // --- suppression ---
      var s = 0;
      var sd = maps.stationDist[i];
      if (sd <= STATION_RADIUS) s = 0.25 + 0.35 * (1 - sd / STATION_RADIUS);
      // In tactical (player-fought) fires the stations' crews are the player's crew points: automatic station
      // suppression is off while initial attack is en route (first 6 steps) and weak afterwards, so every fire is a fight.
      if (fs.tacticalMode) s *= (stepNo < 6) ? 0 : 0.35;
      var zi = zoneOf(world, i);
      if ((anyHard && zi >= 0 && eff.hardenedZones[zi]) || (anyFB && nearZoneFlag(world, i, eff.fuelBreakZones))) s = Math.max(s, 0.35);
      s += 0.05 * (1 - d) * (suppressAll ? 1.5 : 1);
      if (small) s += 0.08 * (1 - d);
      if (focus) {
        var inArea = focus === 'town' ? (maps.area[i] & 1) : focus === 'farms' ? (maps.area[i] & 2) : focus === 'watershed' ? maps.upstream[i] : 0;
        s *= inArea ? 1.6 : 0.8;
      }
      // extreme fire weather overwhelms initial attack (crews pull back in 40 mph wind)
      s *= (1 - 0.5 * d) * (1 - 0.35 * ws);
      if (tactical) s *= TAC_RATE; // cells burn ~2x longer, so per-step extinguish chance halves
      s = clamp(s * strength, 0, 0.9);
      // minimum spectacle: in a tactical fire the last few cells smoulder (no suppression, low spread) until step 18
      var smoulder = tactical && !capReached && stepNo < SMOULDER_UNTIL && fs.burning.size <= SMOULDER_CELLS;
      if (!smoulder && s > 0 && u01(seed, stepNo, i, 8) < s) {
        fs.severity[i] *= 0.5; burnOut(fs, i); fs.extinguishedCount++; out.extinguished.push(i);
        continue;
      }
      // --- burn-out ---
      fs.burnAge[i]++;
      var spent = fs.burnAge[i] > fs.burnTime[i];
      if (spent) { if (!smoulder) { burnOut(fs, i); continue; } fs.burnAge[i] = fs.burnTime[i] + 1; }
      if (capReached) continue;
      var pMul = spent ? SMOULDER_SPREAD * TAC_RATE : (tactical ? TAC_RATE : 1);
      // --- spread to 8 neighbours ---
      var x = i % N, y = (i / N) | 0;
      for (k = 0; k < 8; k++) {
        var nx = x + DX[k], ny = y + DY[k]; if (!C.inBounds(nx, ny)) continue;
        var j = ny * N + nx;
        var cross = 1;
        if (T && T.breaks[j] === 2) {
          // a finished line never ignites; the fire can only jump it (spot over) at 5% of the normal spread
          nx += DX[k]; ny += DY[k]; if (!C.inBounds(nx, ny)) continue;
          j = ny * N + nx; if (T.breaks[j] === 2) continue;
          cross = BREAK_CROSS;
        }
        if (fs.burnState[j] !== 0) continue;
        var lv = land ? land[j] : L.FOREST;
        var lf = LAND_FACTOR[lv] || 0; if (lf <= 0) continue;
        var zj = zoneOf(world, j);
        if (anyHard && lv === L.RESIDENTIAL && zj >= 0 && eff.hardenedZones[zj]) lf = 0.2;
        var f = effFuel(world, j); if (f <= 0.02) continue;
        var m = moisture ? clamp(fin(moisture[j], 0.5), 0, 1) : 0.5;
        var thin = (anyThin && zj >= 0 && eff.thinnedZones[zj]) ? clamp(fin(+eff.thinnedZones[zj], 0), 0, 1) : 0;
        var fb = (anyFB && nearZoneFlag(world, j, eff.fuelBreakZones)) ? 0.45 : 1;
        var grade = elev ? (fin(elev[j], 0) - fin(elev[i], 0)) / C.CELL_M : 0;
        var sf = clamp(1 + 1.2 * grade, 0.6, 1.9);
        var p = BASE_SPREAD * f * Math.pow(1 - m, 1.5) * wf[k] * sf * dangerFactor * (1 - thin * 0.6) * lf * fb * (DIAG[k] ? DIAG_FACTOR : 1) * cross * pMul;
        if (T) {
          if (T.wet[j] > 0) p *= (1 - WET_BLOCK * T.wet[j]);
          if (zj >= 0 && T.engines[zj]) p *= ENGINE_SPREAD;
        }
        p = clamp(isFinite(p) ? p : 0, 0, 0.95);
        if (p > 0 && u01(seed, stepNo, j, 9 + k) < p) {
          if (T && T.breaks[j] === 1) { T.breaks[j] = 0; T.digTimer[j] = 0; T.digging = Math.max(0, T.digging - 1); T.digLost++; }
          if (igniteCell(fs, world, j, d)) out.newlyBurning.push(j);
          if (fs.cellsBurned.length >= fs.capCells) { capReached = true; break; }
        }
      }
    }
    // growth history for threat(): last few steps of newly-burning centroids
    var nb = out.newlyBurning, hx = 0, hy = 0;
    for (c = 0; c < nb.length; c++) { hx += nb[c] % N; hy += (nb[c] / N) | 0; }
    fs.hist.push({ n: nb.length, sx: hx, sy: hy });
    if (fs.hist.length > 4) fs.hist.shift();
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

  /* ---------- threat summary for the tactical HUD (cheap: called every step) ---------- */
  function houseLossRate(bd, eff, T) {
    var z = bd.zoneId;
    var hardened = z != null && z >= 0 && !!eff.hardenedZones[z];
    var engine = !!(T && z != null && z >= 0 && T.engines[z]);
    return (hardened && engine) ? 0.08 : (hardened || engine) ? Math.min(HARDENED_LOSS, ENGINE_LOSS) : BASE_LOSS;
  }
  function houseLost(fs, bd, bi, eff, T) { return u01(fs.seed, 0, bi, 200) < houseLossRate(bd, eff, T); }

  function intensityOf(fs) {
    var g = 0, n = 0;
    for (var h = Math.max(0, fs.hist.length - 3); h < fs.hist.length; h++) { g += fs.hist[h].n; n++; }
    g = n ? g / n : 0;
    if (fs.done || fs.burning.size === 0) return 'creeping';
    g *= 1 + 0.4 * clamp(fin(fs.gustMph, 8) / 30, 0, 1);
    return g < 4 ? 'creeping' : g < 12 ? 'active' : g < 30 ? 'running' : 'extreme';
  }

  function headingOf(fs) {
    // blend the wind vector with the direction of recent growth relative to the fire's centroid
    var wd = fin(fs.gustDir, fs.windDir);
    var vx = Math.cos(wd), vy = Math.sin(wd);
    var rn = 0, rx = 0, ry = 0;
    for (var h = Math.max(0, fs.hist.length - 3); h < fs.hist.length; h++) { rn += fs.hist[h].n; rx += fs.hist[h].sx; ry += fs.hist[h].sy; }
    var tot = fs.cellsBurned.length;
    if (rn >= 3 && tot > rn) {
      var cx = (fs.sumX - rx) / (tot - rn), cy = (fs.sumY - ry) / (tot - rn);
      var gx = rx / rn - cx, gy = ry / rn - cy, gl = Math.sqrt(gx * gx + gy * gy);
      if (gl > 0.2) { vx = 0.5 * vx + 0.5 * gx / gl; vy = 0.5 * vy + 0.5 * gy / gl; }
    }
    // compass degrees: 0 = north (−y), 90 = east (+x)
    var deg = Math.atan2(vx, -vy) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
  }

  var THREAT_TYPES = { neighborhood: 0, civic: 1, farm: 2, reservoir: 3, forest: 4 };

  function threat(fs, state, world) {
    var out = { acres: 0, perimeterCells: 0, headingDeg: 0, windMph: 0, windDirRad: 0, threatened: [],
                structuresLost: 0, structuresAtRisk: 0, upstreamAcres: 0, intensity: 'creeping' };
    if (!fs || !world) return out;
    var maps = ensureMaps(world);
    var eff = effectsOf(state);
    var T = fs.tactics || null;
    out.acres = fs.acres; out.perimeterCells = fs.perimeterCells;
    out.windMph = Math.round(fin(fs.gustMph, fs.windSpeed) * 10) / 10;
    out.windDirRad = fin(fs.gustDir, fs.windDir);
    out.headingDeg = Math.round(headingOf(fs));
    out.intensity = intensityOf(fs);
    // sample <= THREAT_SAMPLE burning cells (or burned cells once the fire is out)
    var src = fs.burning.size > 0 ? fs.burning : fs.burnedSet;
    var total = src.size, stride = Math.max(1, Math.ceil(total / THREAT_SAMPLE));
    var sample = [], idx = 0;
    src.forEach(function (i) { if ((idx++ % stride) === 0) sample.push(i); });
    var zones = world.zones || [], z, zn, c, i;
    var burningIn = {};
    fs.burning.forEach(function (i2) { var zz = zoneOf(world, i2); if (zz >= 0) burningIn[zz] = true; });
    var list = [];
    for (z = 0; z < zones.length; z++) {
      zn = zones[z];
      if (!zn || !zn.cells || !zn.cells.length || !(zn.type in THREAT_TYPES)) continue;
      var lb = 0;
      if (zn.bbox && fs.bx1 >= 0) {
        lb = Math.max(0, zn.bbox.x0 - fs.bx1, fs.bx0 - zn.bbox.x1, zn.bbox.y0 - fs.by1, fs.by0 - zn.bbox.y1);
        if (lb > 60) continue; // bbox prefilter: far away, not a threat
      }
      var dist = 255;
      if (burningIn[zn.id]) dist = 0;
      else if (sample.length) {
        var f = zoneDistField(maps, zn);
        for (c = 0; c < sample.length; c++) { var dv = f[sample[c]]; if (dv < dist) dist = dv; if (dist === 0) break; }
      }
      if (dist === 255) continue;
      list.push({ zoneId: zn.id, name: zn.name, type: zn.type, distanceCells: dist, burningInside: !!burningIn[zn.id], _rank: THREAT_TYPES[zn.type] });
    }
    list.sort(function (a, b) { return a.distanceCells - b.distanceCells || a._rank - b._rank || a.zoneId - b.zoneId; });
    for (c = 0; c < list.length && c < 6; c++) { delete list[c]._rank; out.threatened.push(list[c]); }
    // structures: lost so far (houses on burned cells, same draw as finalize) and at risk (within 4 cells of flames)
    var buildings = world.buildings || [], lost = 0, risk = 0;
    var ex0 = fs.bx0 - AT_RISK_RADIUS, ex1 = fs.bx1 + AT_RISK_RADIUS, ey0 = fs.by0 - AT_RISK_RADIUS, ey1 = fs.by1 + AT_RISK_RADIUS;
    for (var b = 0; b < buildings.length; b++) {
      var bd = buildings[b]; if (!bd || bd.type !== 'house') continue;
      var bx = bd.x | 0, by = bd.y | 0, bi = by * N + bx;
      if (bi < 0 || bi >= NN) continue;
      if (fs.burnState[bi] === 2) { if (!bd.burned && houseLost(fs, bd, bi, eff, T)) lost++; continue; }
      if (bd.burned || fs.burning.size === 0 || bx < ex0 || bx > ex1 || by < ey0 || by > ey1) continue;
      var near = false;
      for (var dy = -AT_RISK_RADIUS; dy <= AT_RISK_RADIUS && !near; dy++) for (var dx = -AT_RISK_RADIUS; dx <= AT_RISK_RADIUS; dx++) {
        var nx = bx + dx, ny = by + dy; if (!C.inBounds(nx, ny)) continue;
        if (fs.burnState[ny * N + nx] === 1) { near = true; break; }
      }
      if (near) risk++;
    }
    out.structuresLost = lost; out.structuresAtRisk = risk;
    var up = 0;
    for (c = 0; c < fs.cellsBurned.length; c++) { i = fs.cellsBurned[c]; if (maps.upstream[i]) up++; }
    out.upstreamAcres = up * C.ACRES_PER_CELL;
    return out;
  }

  /* ---------- summarize a finished (or running) sim without touching world/state ---------- */
  function summarize(fs, state, world) {
    var maps = ensureMaps(world);
    var eff = effectsOf(state);
    var T = fs.tactics || null;
    var cells = fs.cellsBurned, n = cells.length;
    var sevSum = 0, up = 0, i, c;
    for (c = 0; c < n; c++) { i = cells[c]; sevSum += clamp(fin(fs.severity[i], 0.3), 0, 1); if (maps.upstream[i]) up++; }
    var lostIdx = [], reached = 0, injuries = 0;
    var buildings = world.buildings || [];
    for (var b = 0; b < buildings.length; b++) {
      var bd = buildings[b]; if (!bd || bd.type !== 'house' || bd.burned) continue;
      var bi = (bd.y | 0) * N + (bd.x | 0);
      if (bi < 0 || bi >= NN || fs.burnState[bi] !== 2) continue;
      reached++;
      if (houseLost(fs, bd, bi, eff, T)) lostIdx.push(b);
      var z = bd.zoneId;
      var evac = !!(T && z != null && z >= 0 && T.evacuated[z]);
      if (!evac) {
        var rate = 0.05 * (eff.warningSystem ? 0.3 : 1) * (T && z != null && z >= 0 && T.engines[z] ? 0.5 : 1);
        if (u01(fs.seed, 0, bi, 201) < rate) injuries++;
      }
    }
    var zoneIds = Array.from(fs.zonesTouched).sort(function (a, b2) { return a - b2; });
    return { acres: n * C.ACRES_PER_CELL, upstreamAcres: up * C.ACRES_PER_CELL, structuresLost: lostIdx.length, zoneIds: zoneIds,
             severityAvg: n ? sevSum / n : 0, lostIdx: lostIdx, housesReached: reached, injuries: injuries };
  }

  /* ---------- deterministic no-tactics replay (the after-action counterfactual) ---------- */
  function replayWithoutTactics(fs, state, world) {
    var out = { acres: 0, structuresLost: 0, upstreamAcres: 0, zoneIds: [] };
    if (!fs || !world || !(fs.startCell >= 0)) return out;
    if (fs._counterfactual && fs._counterfactual.seed === fs.seed) return fs._counterfactual.result;
    var sim = createSim(state, world, null, fs.startCell, {
      seed: fs.seed, id: fs.id + ':replay', danger: fs.danger, windDir: fs.windDir, windSpeed: fs.windSpeed,
      maxSteps: fs.maxSteps, capCells: fs.capCells, prescribedEscape: fs.prescribedEscape, forced: fs.forced, tacticalMode: !!fs.tacticalMode
    });
    var guard = 0;
    while (!sim.done && guard++ < 500) step(sim, state, world, null);
    var sum = summarize(sim, state, world);
    out.acres = sum.acres; out.structuresLost = sum.structuresLost; out.upstreamAcres = sum.upstreamAcres; out.zoneIds = sum.zoneIds;
    fs._counterfactual = { seed: fs.seed, result: out };
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
      fs.done = true; fs.perimeterCells = 0;
    }
    var T = fs.tactics || null;
    // counterfactual must run before the world is mutated
    var sum = summarize(fs, state, world);
    var cf = T ? replayWithoutTactics(fs, state, world) : { acres: sum.acres, structuresLost: sum.structuresLost, upstreamAcres: sum.upstreamAcres, zoneIds: sum.zoneIds.slice() };
    var maps = ensureMaps(world);
    var cells = fs.cellsBurned, n = cells.length;
    var i, c, sev;
    for (c = 0; c < n; c++) {
      i = cells[c]; sev = clamp(fin(fs.severity[i], 0.3), 0, 1);
      if (world.burn) world.burn[i] = Math.max(fin(world.burn[i], 0), sev);
      if (world.fuel) world.fuel[i] = clamp(fin(world.fuel[i], 0) * 0.15, 0, 1);
      if (world.treeDensity) world.treeDensity[i] = clamp(fin(world.treeDensity[i], 0) * (1 - sev * 0.85), 0, 1);
      if (world.moisture) world.moisture[i] = clamp(fin(world.moisture[i], 0.5) - 0.15, 0, 1);
      if (world.habitat) world.habitat[i] = clamp(fin(world.habitat[i], 0) * (1 - 0.6 * sev), 0, 1);
    }
    // structures: houses in burned residential cells
    var buildings = world.buildings || [];
    for (c = 0; c < sum.lostIdx.length; c++) { var bd = buildings[sum.lostIdx[c]]; if (bd) bd.burned = true; }
    var lost = sum.structuresLost;
    rep.acres = sum.acres;
    rep.upstreamAcres = sum.upstreamAcres;
    rep.structuresLost = lost;
    rep.zoneIds = sum.zoneIds;
    rep.severityAvg = sum.severityAvg;
    rep.smokeDays = n ? clamp(Math.round(2 + rep.acres / 350), 1, 40) : 0;
    rep.cellsBurned = Int32Array.from(cells);
    rep.startCell = fs.startCell;
    rep.extinguishedCells = fs.extinguishedCount;
    rep.danger = fs.danger;
    void maps;
    // tactics report + counterfactual
    var engines = [], evacuated = [], unnecessary = 0, cellsBroken = 0, used = {}, k;
    if (T) {
      for (k in T.used) if (Object.prototype.hasOwnProperty.call(T.used, k)) used[k] = T.used[k];
      for (k in T.engines) if (T.engines[k]) engines.push(zoneName(world, +k));
      for (k in T.evacuated) if (T.evacuated[k]) {
        evacuated.push(zoneName(world, +k));
        var zn = zoneById(world, +k), touched = false;
        if (zn && zn.cells) for (c = 0; c < zn.cells.length; c++) if (fs.burnState[zn.cells[c]] !== 0) { touched = true; break; }
        if (!touched) unnecessary++;
      }
      for (i = 0; i < NN; i++) if (T.breaks[i] === 2) cellsBroken++;
    }
    rep.tactics = {
      used: used, cellsBroken: cellsBroken, drops: T ? T.drops : 0, engines: engines, evacuated: evacuated, mutualAid: !!(T && T.mutualAidUsed),
      counterfactual: { acres: fin(cf.acres, rep.acres), structuresLost: fin(cf.structuresLost, lost), upstreamAcres: fin(cf.upstreamAcres, rep.upstreamAcres) },
      acresSaved: Math.max(0, fin(cf.acres, rep.acres) - rep.acres),
      structuresSaved: Math.max(0, fin(cf.structuresLost, lost) - lost),
      injuries: sum.injuries, unnecessaryEvacs: unnecessary,
      crewPtsLeft: T ? Math.round(T.crewPts * 10) / 10 : 0, log: T ? T.log.slice() : []
    };
    rep.injuries = sum.injuries;
    if (state) {
      state.fire = state.fire || {};
      var sf = state.fire;
      sf.seasonAcres = fin(sf.seasonAcres, 0) + rep.acres;
      sf.totalAcres = fin(sf.totalAcres, 0) + rep.acres;
      sf.structuresLost = fin(sf.structuresLost, 0) + lost;
      sf.smokeDays = fin(sf.smokeDays, 0) + rep.smokeDays;
      sf.injuries = fin(sf.injuries, 0) + sum.injuries;
      sf.fires = sf.fires || [];
      sf.fires.push({ year: fin(state.year, fs.year), season: seasonOf(state), acres: rep.acres, zoneIds: rep.zoneIds.slice(),
                      structures: lost, upstream: rep.upstreamAcres, severityAvg: rep.severityAvg, startCell: fs.startCell, id: fs.id,
                      injuries: sum.injuries, acresSaved: rep.tactics.acresSaved, structuresSaved: rep.tactics.structuresSaved,
                      counterfactual: { acres: rep.tactics.counterfactual.acres, structuresLost: rep.tactics.counterfactual.structuresLost, upstreamAcres: rep.tactics.counterfactual.upstreamAcres } });
      // an evacuation that turned out to be unnecessary dents public trust a little
      if (unnecessary > 0) state.trustDelta = Math.round((fin(state.trustDelta, 0) - unnecessary) * 100) / 100;
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
    var zn = zoneById(world, zoneId);
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
    LAND_FACTOR: LAND_FACTOR,
    // v2 tactics
    TACTICS: TACTICS,
    startTactics: startTactics,
    canApply: canApply,
    applyTactic: applyTactic,
    threat: threat,
    replayWithoutTactics: replayWithoutTactics
  };
})();
