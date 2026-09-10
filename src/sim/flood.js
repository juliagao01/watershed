/* Watershed — post-fire storm / debris-flow model. Export WS.Flood.
   Deterministic runoff + sediment routing along world.flowDir in topological order, with the
   player's emergency mitigations (mulch, log barriers, debris basins, bank stabilisation, intake
   boom, sensors, warning sirens) and project effects (restored wetland, rain capture). Runs in Node. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C, L = C.LAND, N = C.N, NN = N * N;
  var clamp = C.clamp;
  var CELL_AREA_M2 = C.CELL_M * C.CELL_M;   // 10,000 m2
  var CFS_PER_CMS = 35.3147;
  var IN_TO_M = 0.0254;
  var SCAR_MIN_BURN = 0.2;
  var FRAME_COUNT = 32, MAX_PARTICLES = 3000;

  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function seasonOf(state) { return state && isFinite(state.season) ? (state.season | 0) : (state && isFinite(state.turn) ? (state.turn % 4) : 2); }
  function hash32(i, salt) { var h = (i | 0) ^ ((salt | 0) * 0x9E3779B1); h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B); h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35); return (h ^ (h >>> 16)) >>> 0; }
  function hash01(i, salt) { return hash32(i, salt) / 4294967296; }

  // runoff coefficient (fraction of rain that becomes runoff) and "fast" fraction (share that
  // arrives during the peak instead of soaking in / trickling out as interflow) by land cover
  var COEFF = new Float32Array(16), FAST = new Float32Array(16);
  COEFF[L.RIVER] = 0.30; FAST[L.RIVER] = 0.30;        // a creek is a few metres wide; most of the cell is bank
  COEFF[L.RESERVOIR] = 1.0; FAST[L.RESERVOIR] = 1.0;
  COEFF[L.ALPINE] = 0.30; FAST[L.ALPINE] = 0.05;
  COEFF[L.FOREST] = 0.15; FAST[L.FOREST] = 0.07;
  COEFF[L.SHRUB] = 0.20; FAST[L.SHRUB] = 0.06;
  COEFF[L.FARM] = 0.22; FAST[L.FARM] = 0.12;
  COEFF[L.RESIDENTIAL] = 0.35; FAST[L.RESIDENTIAL] = 0.5;
  COEFF[L.CIVIC] = 0.40; FAST[L.CIVIC] = 0.6;
  COEFF[L.WETLAND] = 0.05; FAST[L.WETLAND] = 0.05;
  COEFF[L.ROAD] = 0.85; FAST[L.ROAD] = 0.9;
  COEFF[L.RIPARIAN] = 0.18; FAST[L.RIPARIAN] = 0.10;

  var TOOLS = {
    mulch: { name: 'Straw / wood mulch', desc: 'Aerial mulch covers bare burned soil so rain soaks in instead of stripping ash and topsoil. Cuts hillslope erosion about 60% within its footprint.', costM: 0.35, radius: 1, effect: 'Erosion -60% in a 3x3 patch; slightly less runoff.' },
    barrier: { name: 'Log erosion barrier', desc: 'Felled logs or straw wattles staked across small burned drainages slow water and trap sediment before it reaches a creek.', costM: 0.15, effect: 'Traps 50% of passing sediment, up to 300 t.', capacityTons: 300 },
    debris_basin: { name: 'Debris basin', desc: 'An excavated catch basin on a channel below the scar captures boulders, logs and mud from a debris flow. Must be cleaned out after each storm.', costM: 1.2, capacityTons: 4000, effect: 'Traps up to 4,000 t of sediment.' },
    bank_stab: { name: 'Bank stabilisation', desc: 'Rock, root wads and willow plantings hold streambanks below the dam so a flood pulse does not carve new sediment from the banks.', costM: 0.5, effect: 'Stops bank erosion on that reach.' },
    intake_protect: { name: 'Intake protection', desc: 'A floating boom and curtain around the treatment intake keeps floating ash and the muddiest water away from the pumps.', costM: 0.8, max: 1, effect: 'Contamination at the intake -40%.' },
    sensor: { name: 'Stream sensor', desc: 'A turbidity and stage sensor on the river above the intake gives the treatment plant hours of warning to shut the intake before the ash slug arrives.', costM: 0.2, effect: 'Early detection halves any treatment outage.' },
    warning: { name: 'Flash-flood siren', desc: 'A siren and reverse-911 alert for a neighbourhood in the flood path. Flash floods off burn scars can arrive in minutes.', costM: 0.25, effect: 'Injury risk -80% in that neighbourhood.' }
  };

  /* ---------- topological order along flowDir (cached on world._topo) ---------- */
  function topo(world) {
    var fd = world.flowDir;
    if (world._topo && world._topo.flowDir === fd && world._topo.n === NN) return world._topo;
    var order = new Int32Array(NN), dir = new Int32Array(NN), indeg = new Int32Array(NN), i, d;
    if (!fd || fd.length !== NN) {
      for (i = 0; i < NN; i++) { order[i] = i; dir[i] = -1; }
      world._topo = { order: order, dir: dir, flowDir: fd, n: NN, cyclic: 0 };
      return world._topo;
    }
    for (i = 0; i < NN; i++) { d = fd[i]; dir[i] = (d >= 0 && d < NN && d !== i) ? d : -1; }
    for (i = 0; i < NN; i++) { d = dir[i]; if (d >= 0) indeg[d]++; }
    var head = 0, tail = 0;
    for (i = 0; i < NN; i++) if (indeg[i] === 0) order[tail++] = i;
    while (head < tail) { i = order[head++]; d = dir[i]; if (d >= 0 && --indeg[d] === 0) order[tail++] = d; }
    var cyclic = NN - tail;
    if (cyclic > 0) { // malformed loops: cut them (treated as sinks) so routing terminates
      for (i = 0; i < NN; i++) if (indeg[i] > 0) { dir[i] = -1; order[tail++] = i; }
    }
    world._topo = { order: order, dir: dir, flowDir: fd, n: NN, cyclic: cyclic };
    return world._topo;
  }

  /* ---------- per-world static masks (cached on world._floodMaps) ---------- */
  function ensureMaps(world) {
    var m = world._floodMaps;
    if (m && m.land === world.land && m.zones === world.zones && m.nBuildings === (world.buildings || []).length) return m;
    var land = world.land, i, x, y, k;
    m = { land: land, zones: world.zones, nBuildings: (world.buildings || []).length,
          isRes: new Uint8Array(NN), town: new Uint8Array(NN), wetAdj: new Uint8Array(NN), wetAdjCount: 0, upstream: new Uint8Array(NN),
          houses: new Int32Array(NN), intake: -1, damCell: -1 };
    var rc = world.reservoir && world.reservoir.cells;
    if (rc) for (i = 0; i < rc.length; i++) m.isRes[rc[i]] = 1;
    else if (land) for (i = 0; i < NN; i++) if (land[i] === L.RESERVOIR) m.isRes[i] = 1;
    if (world.reservoir && world.reservoir.intake) m.intake = C.idx(world.reservoir.intake.x | 0, world.reservoir.intake.y | 0);
    if (world.reservoir && world.reservoir.dam) m.damCell = C.idx(world.reservoir.dam.x | 0, world.reservoir.dam.y | 0);
    // town = neighbourhood + civic zone bboxes (+1), fallback residential/civic cells
    var zones = world.zones || [], any = false;
    for (var z = 0; z < zones.length; z++) {
      var zn = zones[z]; if (!zn || (zn.type !== 'neighborhood' && zn.type !== 'civic' && zn.type !== 'town')) continue;
      if (zn.bbox) {
        any = true;
        for (y = Math.max(0, zn.bbox.y0 - 1); y <= Math.min(N - 1, zn.bbox.y1 + 1); y++) for (x = Math.max(0, zn.bbox.x0 - 1); x <= Math.min(N - 1, zn.bbox.x1 + 1); x++) m.town[y * N + x] = 1;
      } else if (zn.cells) { any = true; for (k = 0; k < zn.cells.length; k++) m.town[zn.cells[k]] = 1; }
    }
    if (!any && land) for (i = 0; i < NN; i++) if (land[i] === L.RESIDENTIAL || land[i] === L.CIVIC) m.town[i] = 1;
    // river cells adjacent to the wetland act as its floodplain connection
    var wc = world.wetland && world.wetland.cells;
    if (wc && land) {
      var isWet = new Uint8Array(NN);
      for (i = 0; i < wc.length; i++) isWet[wc[i]] = 1;
      for (i = 0; i < NN; i++) {
        if (land[i] !== L.RIVER && land[i] !== L.RIPARIAN && !isWet[i]) continue;
        if (isWet[i]) { m.wetAdj[i] = 1; continue; }
        x = i % N; y = (i / N) | 0;
        for (var dy = -2; dy <= 2 && !m.wetAdj[i]; dy++) for (var dx = -2; dx <= 2; dx++) {
          var nx = x + dx, ny = y + dy; if (!C.inBounds(nx, ny)) continue;
          if (isWet[ny * N + nx]) { m.wetAdj[i] = 1; break; }
        }
      }
      var cnt = 0; for (i = 0; i < NN; i++) if (m.wetAdj[i] && land[i] === L.RIVER) cnt++;
      m.wetAdjCount = cnt;
    }
    if (typeof world.isUpstreamOfReservoir === 'function') {
      for (i = 0; i < NN; i++) { try { m.upstream[i] = world.isUpstreamOfReservoir(i) ? 1 : 0; } catch (e) { m.upstream[i] = 0; } }
    }
    var bl = world.buildings || [];
    for (i = 0; i < bl.length; i++) { var b = bl[i]; if (b && b.type === 'house') { var bi = C.idx(b.x | 0, b.y | 0); if (bi >= 0 && bi < NN) m.houses[bi]++; } }
    world._floodMaps = m;
    return m;
  }

  function effectsOf(state, opts) {
    var e = null;
    try { if (WS.Projects && typeof WS.Projects.effects === 'function') e = WS.Projects.effects(state); } catch (err) { e = null; }
    if (!e || typeof e !== 'object') e = {};
    var flags = (state && state.flags) || {};
    var out = {
      wetlandRestored: !!(e.wetlandRestored || flags.wetlandRestored),
      rainCapture: clamp(fin(e.rainCaptureAF, 0) / 900, 0, 1),
      warningSystem: !!e.warningSystem, sensorCoverage: fin(e.sensorCoverage, 0) > 0, treatment: !!e.treatment
    };
    if (opts && opts.disableWetland) out.wetlandRestored = false;
    if (opts && opts.disableRainCapture) out.rainCapture = 0;
    return out;
  }

  function normStorm(storm) {
    storm = storm || {};
    return { intensityIn: clamp(fin(storm.intensityIn, 1.5), 0.3, 4.5), durationHr: clamp(fin(storm.durationHr, 2), 0.5, 12), turnsUntil: fin(storm.turnsUntil, 0) };
  }

  function mitIndex(mt) {
    if (!mt) return -1;
    if (mt.i != null && isFinite(mt.i)) return mt.i | 0;
    if (mt.x != null && mt.y != null && C.inBounds(mt.x | 0, mt.y | 0)) return C.idx(mt.x | 0, mt.y | 0);
    return -1;
  }

  function scarCells(world) {
    var out = [];
    if (!world || !world.burn) return out;
    for (var i = 0; i < NN; i++) if (fin(world.burn[i], 0) >= SCAR_MIN_BURN) out.push(i);
    return out;
  }

  /* ---------- the storm ---------- */
  function simulate(state, world, storm, mitigations, opts) {
    opts = opts || {};
    var res = { peakCfsReservoir: 0, peakCfsTown: 0, sedimentTons: 0, sedimentToReservoir: 0, ashToReservoir: 0, trappedTons: 0,
                floodedCells: new Int32Array(0), floodedHouses: 0, damageM: 0, injuriesRisk: 0,
                contamination: { turbidityDelta: 0, ashDelta: 0, outageDays: 0 }, earlyWarning: false, frames: [],
                floodedResidential: 0, floodedFarm: 0, floodedCivic: 0, runoffAF: 0, bankErosionTons: 0, scarAcres: 0, storm: normStorm(storm) };
    if (!world || !world.land) return res;
    var st = res.storm;
    var eff = effectsOf(state, opts);
    var maps = ensureMaps(world), tp = topo(world);
    var order = tp.order, dir = tp.dir;
    var land = world.land, burn = world.burn, slope = world.slope, moist = world.moisture;
    var i, k, x, y, lv;

    // --- mitigation sets ---
    var mulch = new Uint8Array(NN), barrierCap = new Float32Array(NN), basinCap = new Float32Array(NN), bank = new Uint8Array(NN);
    var sensorCells = [], warnZones = {}, intakeProtect = false;
    var mits = Array.isArray(mitigations) ? mitigations : [];
    for (k = 0; k < mits.length; k++) {
      var mt = mits[k]; var mi = mitIndex(mt); if (mi < 0 || !mt.type) continue;
      var t = mt.type;
      if (t === 'mulch') {
        x = mi % N; y = (mi / N) | 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { var nx = x + dx, ny = y + dy; if (C.inBounds(nx, ny)) mulch[ny * N + nx] = 1; }
      } else if (t === 'barrier') barrierCap[mi] += TOOLS.barrier.capacityTons;
      else if (t === 'debris_basin') basinCap[mi] += TOOLS.debris_basin.capacityTons;
      else if (t === 'bank_stab') { x = mi % N; y = (mi / N) | 0; for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) { nx = x + dx; ny = y + dy; if (C.inBounds(nx, ny)) bank[ny * N + nx] = 1; } }
      else if (t === 'intake_protect') intakeProtect = true;
      else if (t === 'sensor') sensorCells.push(mi);
      else if (t === 'warning') { var wz = world.zone ? world.zone[mi] : -1; if (wz >= 0) warnZones[wz] = true; else warnZones['cell' + mi] = mi; }
    }

    var rainM = st.intensityIn * IN_TO_M;
    var Tpeak = 3600 * clamp(1.5 + 0.75 * st.durationHr, 2, 6);   // seconds over which the fast runoff arrives
    var flow = new Float32Array(NN), sed = new Float32Array(NN), ash = new Float32Array(NN);
    var runoffTotal = 0, sedTotal = 0, scarN = 0;

    // --- local generation ---
    for (i = 0; i < NN; i++) {
      lv = land[i];
      var b = burn ? clamp(fin(burn[i], 0), 0, 1) : 0;
      if (b >= SCAR_MIN_BURN) scarN++;
      var coeff = COEFF[lv] || 0.2, fast = FAST[lv] || 0.2;
      if (lv === L.RESIDENTIAL || lv === L.CIVIC) coeff -= 0.1 * eff.rainCapture;
      coeff += 0.55 * b; fast += 0.9 * b;
      if (mulch[i]) { coeff -= 0.12 * b; }
      if (moist) coeff += 0.15 * clamp((fin(moist[i], 0.5) - 0.6) / 0.4, 0, 1);
      coeff = clamp(coeff, 0.02, 0.95); fast = clamp(fast, 0.02, 1);
      var vol = rainM * coeff * CELL_AREA_M2;      // m3
      runoffTotal += vol;
      flow[i] += vol * fast;
      if (b > 0.03 && lv !== L.RIVER && lv !== L.RESERVOIR) {
        var sl = slope ? clamp(fin(slope[i], 0.1), 0.02, 1.5) : 0.2;
        var src = (rainM * coeff) * b * sl * 900;    // tons
        if (mulch[i]) src *= 0.4;
        sed[i] += src; ash[i] += src * b; sedTotal += src;
      }
    }
    res.scarAcres = scarN * C.ACRES_PER_CELL;

    // --- routing ---
    var storagePct = state && state.reservoir ? fin(state.reservoir.storageAF, 30000) / Math.max(1, fin(state.reservoir.capacityAF, C.HYDRO.RESERVOIR_CAPACITY_AF)) : 0.7;
    var resAtt = storagePct > 0.95 ? 0.7 : 0.35;
    var wetF = eff.wetlandRestored ? 0.70 : 0.90, wetS = eff.wetlandRestored ? 0.65 : 0.90;
    var nWet = Math.max(1, maps.wetAdjCount);
    var wetFcell = Math.pow(wetF, 1 / nWet), wetScell = Math.pow(wetS, 1 / nWet);
    var trapped = 0, wetTrapped = 0, resInflow = 0, sedRes = 0, ashRes = 0, peakTown = 0, bankTons = 0;
    var flooded = new Uint8Array(NN);
    var THR_RES = 60 / CFS_PER_CMS * Tpeak, THR_FARM = 120 / CFS_PER_CMS * Tpeak;   // in m3 fast-volume units
    for (k = 0; k < NN; k++) {
      i = order[k]; lv = land[i];
      var f = flow[i], s = sed[i], a = ash[i];
      if (f <= 0 && s <= 0) continue;
      var cms = f / Tpeak;
      // bank erosion on unarmoured river/riparian reaches below the dam
      if ((lv === L.RIVER || lv === L.RIPARIAN) && !maps.upstream[i] && !bank[i] && cms > 0.5) {
        var be = 0.05 * (cms - 0.5); s += be; bankTons += be; sedTotal += be;
      }
      // barriers / basins trap sediment
      if (barrierCap[i] > 0 && s > 0) { var tb = Math.min(s * 0.5, barrierCap[i]); barrierCap[i] -= tb; var fr = tb / s; s -= tb; a -= a * fr; trapped += tb; }
      if (basinCap[i] > 0 && s > 0) { var tbb = Math.min(s * 0.9, basinCap[i]); basinCap[i] -= tbb; var fr2 = tbb / s; s -= tbb; a -= a * fr2; trapped += tbb; }
      // flooding of developed / farmed cells
      if (lv === L.RESIDENTIAL || lv === L.CIVIC) { if (f >= THR_RES) flooded[i] = 1; }
      else if (lv === L.FARM) { if (f >= THR_FARM) flooded[i] = 1; }
      if (maps.town[i] && cms > peakTown) peakTown = cms;
      var d = dir[i];
      if (d < 0) continue;
      if (maps.wetAdj[i] && lv === L.RIVER) { var wt = s * (1 - wetScell); s -= wt; a *= wetScell; wetTrapped += wt; trapped += wt; f *= wetFcell; }
      if (maps.isRes[d] && !maps.isRes[i]) {           // entering the reservoir
        resInflow += f; sedRes += s; ashRes += a;
        flow[d] += f; sed[d] += s * 0.03; ash[d] += a * 0.03;
      } else if (maps.isRes[i] && !maps.isRes[d]) {    // leaving over the dam: pool attenuates the pulse
        flow[d] += f * resAtt; sed[d] += s; ash[d] += a;
      } else { flow[d] += f; sed[d] += s; ash[d] += a; }
    }
    // overbank flooding next to the river below the dam
    for (i = 0; i < NN; i++) {
      if (land[i] !== L.RIVER || maps.upstream[i]) continue;
      var rcms = flow[i] / Tpeak * CFS_PER_CMS;
      if (rcms < 900) continue;
      var rad = rcms > 3000 ? 2 : 1;
      x = i % N; y = (i / N) | 0;
      for (dy = -rad; dy <= rad; dy++) for (dx = -rad; dx <= rad; dx++) {
        nx = x + dx; ny = y + dy; if (!C.inBounds(nx, ny)) continue;
        var j = ny * N + nx, lj = land[j];
        if (lj === L.RESIDENTIAL || lj === L.CIVIC || lj === L.FARM) flooded[j] = 1;
      }
    }

    // --- damage ---
    var fl = [], dmg = 0, houses = 0, nRes = 0, nFarm = 0, nCiv = 0, risk = 0;
    for (i = 0; i < NN; i++) {
      if (!flooded[i]) continue;
      fl.push(i); lv = land[i];
      var z = world.zone ? world.zone[i] : -1;
      if (lv === L.RESIDENTIAL) {
        nRes++; dmg += 0.12 * (1 - eff.rainCapture * 0.3);
        var warned = eff.warningSystem || (z >= 0 && warnZones[z]);
        risk += (0.015 + 0.03 * maps.houses[i]) * (warned ? 0.2 : 1);
      } else if (lv === L.CIVIC) { nCiv++; dmg += 0.2; risk += 0.01 * (eff.warningSystem ? 0.2 : 1); }
      else if (lv === L.FARM) { nFarm++; dmg += 0.03; }
      houses += maps.houses[i];
    }
    var peakTownCfs = peakTown * CFS_PER_CMS;
    risk += peakTownCfs / 12000 * (eff.warningSystem ? 0.3 : 1);
    res.floodedCells = Int32Array.from(fl);
    res.floodedHouses = houses; res.floodedResidential = nRes; res.floodedFarm = nFarm; res.floodedCivic = nCiv;
    res.damageM = Math.round(dmg * 100) / 100;
    res.injuriesRisk = clamp(risk, 0, 1);
    res.peakCfsReservoir = Math.round(resInflow / Tpeak * CFS_PER_CMS);
    res.peakCfsTown = Math.round(peakTownCfs);
    res.sedimentTons = Math.round(sedTotal);
    res.sedimentToReservoir = Math.round(sedRes);
    res.ashToReservoir = Math.round(Math.min(ashRes, sedRes));
    res.trappedTons = Math.round(trapped);
    res.wetlandTrappedTons = Math.round(wetTrapped);
    res.bankErosionTons = Math.round(bankTons);
    res.runoffAF = Math.round(runoffTotal / 1233.48);
    res.intakeProtected = intakeProtect;

    // --- early warning: a sensor on a river cell above the intake ---
    var early = false;
    for (k = 0; k < sensorCells.length; k++) { var sc = sensorCells[k]; if (land[sc] === L.RIVER && (maps.upstream[sc] || maps.isRes[sc])) { early = true; break; } }
    if (eff.sensorCoverage && sensorCells.length) early = true;
    res.earlyWarning = early;

    // --- contamination preview (never mutates the real state) ---
    res.contamination = contaminationPreview(state, world, res.sedimentToReservoir, res.sedimentToReservoir > 0 ? res.ashToReservoir / res.sedimentToReservoir : 0, intakeProtect, early, eff);

    // --- animation frames ---
    if (!opts.noFrames) res.frames = buildFrames(world, maps, dir, burn, mulch, barrierCap, basinCap, res, eff, st);
    finiteCheck(res);
    return res;
  }

  function contaminationPreview(state, world, sedTons, ashFrac, intakeProtect, early, eff) {
    var out = null;
    if (WS.Hydrology && typeof WS.Hydrology.contaminate === 'function' && state) {
      try {
        var clone = Object.assign({}, state);
        clone.reservoir = Object.assign({}, state.reservoir || {});
        clone.stats = Object.assign({}, state.stats || {});
        clone.flags = Object.assign({}, state.flags || {});
        clone.mitigations = (state.mitigations || []).slice();
        if (intakeProtect && !clone.mitigations.some(function (m) { return m && m.type === 'intake_protect'; })) clone.mitigations.push({ type: 'intake_protect' });
        clone.log = []; clone.timeline = [];
        var r = WS.Hydrology.contaminate(clone, world, sedTons, ashFrac);
        if (r && typeof r === 'object') out = { turbidityDelta: fin(r.turbidityDelta, 0), ashDelta: fin(r.ashDelta, 0), outageDays: fin(r.outageDays, 0) };
      } catch (e) { out = null; }
    }
    if (!out) out = simpleContamination(state, sedTons, ashFrac, intakeProtect, eff);
    if (early) out.outageDays = Math.round(out.outageDays * 0.5 * 10) / 10;
    out.turbidityDelta = clamp(out.turbidityDelta, 0, 1); out.ashDelta = clamp(out.ashDelta, 0, 1); out.outageDays = clamp(out.outageDays, 0, 90);
    return out;
  }
  function simpleContamination(state, sedTons, ashFrac, intakeProtect, eff) {
    var storage = Math.max(2000, fin(state && state.reservoir && state.reservoir.storageAF, 30000));
    var rel = sedTons / storage;                      // tons per AF
    var turb = clamp(rel * 1.6, 0, 1);                // 10,000 t into 30,000 AF -> +0.53
    var ashD = clamp(rel * 1.4 * clamp(ashFrac, 0, 1), 0, 1);
    var mult = (intakeProtect ? 0.6 : 1) * (eff && eff.treatment ? 0.6 : 1);
    turb *= mult; ashD *= mult;
    var outage = ashD > 0.1 ? Math.round(ashD * 20 * (eff && eff.treatment ? 0.5 : 1)) : 0;
    return { turbidityDelta: turb, ashDelta: ashD, outageDays: outage };
  }

  function buildFrames(world, maps, dir, burn, mulch, barrierCap, basinCap, res, eff, st) {
    var frames = [];
    var seeds = [], i, k;
    var scar = scarCells(world);
    var salt = 7;
    if (scar.length) {
      var stride = Math.max(1, scar.length / MAX_PARTICLES);
      for (var p = 0; p < scar.length; p += stride) seeds.push(scar[Math.floor(p)]);
    } else if (world.flowAcc) {
      var chan = [];
      for (i = 0; i < NN; i++) if (fin(world.flowAcc[i], 0) > 40 && !maps.isRes[i]) chan.push(i);
      var stride2 = Math.max(1, chan.length / 800);
      for (p = 0; p < chan.length; p += stride2) seeds.push(chan[Math.floor(p)]);
    }
    var n = Math.min(seeds.length, MAX_PARTICLES);
    var pos = new Int32Array(n), sf = new Float32Array(n), delay = new Uint8Array(n), speed = new Uint8Array(n), alive = new Uint8Array(n), weight = new Float32Array(n);
    var totalW = 0;
    for (k = 0; k < n; k++) {
      i = seeds[k]; pos[k] = i; alive[k] = 1;
      var b = burn ? clamp(fin(burn[i], 0), 0, 1) : 0;
      sf[k] = clamp(0.08 + 0.9 * b * (mulch[i] ? 0.4 : 1), 0, 1);
      delay[k] = hash32(i, salt) % 7;
      var acc = world.flowAcc ? fin(world.flowAcc[i], 0) : 0;
      speed[k] = 1 + (acc > 40 ? 1 : 0) + (acc > 200 ? 1 : 0);
      weight[k] = sf[k]; totalW += sf[k];
    }
    var arrived = 0, storm = st || res.storm;
    var turbScale = clamp(res.sedimentToReservoir / 6000, 0.05, 1);
    var bCap = Float32Array.from(barrierCap), dCap = Float32Array.from(basinCap);
    for (var fidx = 0; fidx < FRAME_COUNT; fidx++) {
      var buf = new Float32Array(3 * n), cnt = 0;
      for (k = 0; k < n; k++) {
        if (!alive[k]) continue;
        if (fidx >= delay[k]) {
          var acc2 = world.flowAcc ? fin(world.flowAcc[pos[k]], 0) : 0;
          var sp = 1 + (acc2 > 40 ? 1 : 0) + (acc2 > 200 ? 1 : 0);
          for (var m = 0; m < sp && alive[k]; m++) {
            var cur = pos[k], d = dir[cur];
            if (d < 0) { alive[k] = 0; break; }
            if (maps.isRes[d]) { alive[k] = 0; arrived += weight[k]; break; }
            pos[k] = d;
            var h = hash01(d * 31 + k, fidx + 11);
            if (bCap[d] > 0 && h < 0.5) { alive[k] = 0; bCap[d] -= 50; break; }
            if (dCap[d] > 0 && h < 0.9) { alive[k] = 0; dCap[d] -= 50; break; }
            if (maps.wetAdj[d] && eff.wetlandRestored && h < 0.35 / Math.max(1, maps.wetAdjCount) * 3) { alive[k] = 0; break; }
          }
          if (!alive[k]) continue;
        }
        var cx = pos[k] % N, cy = (pos[k] / N) | 0;
        buf[cnt * 3] = cx + 0.5 + (hash01(k, 3) - 0.5) * 0.6;
        buf[cnt * 3 + 1] = cy + 0.5 + (hash01(k, 5) - 0.5) * 0.6;
        buf[cnt * 3 + 2] = sf[k];
        cnt++;
      }
      var positions = cnt === n ? buf : buf.subarray(0, cnt * 3);
      var frame = { positions: new Float32Array(positions), count: cnt, reservoirTurbidity: clamp((totalW > 0 ? arrived / totalW : 0) * turbScale, 0, 1) };
      if (fidx === 0) frame.notes = storm.intensityIn.toFixed(1) + ' in of rain hits the burn scar';
      else if (fidx === Math.floor(FRAME_COUNT / 2)) frame.notes = res.peakCfsReservoir > 300 ? 'Debris flow reaches the reservoir' : 'Runoff reaches the creek';
      else if (fidx === FRAME_COUNT - 1) frame.notes = res.sedimentToReservoir + ' t of sediment delivered';
      frames.push(frame);
    }
    return frames;
  }

  function finiteCheck(res) {
    var keys = ['peakCfsReservoir', 'peakCfsTown', 'sedimentTons', 'sedimentToReservoir', 'ashToReservoir', 'trappedTons', 'floodedHouses', 'damageM', 'injuriesRisk'];
    for (var k = 0; k < keys.length; k++) if (!isFinite(res[keys[k]])) res[keys[k]] = 0;
    var c = res.contamination; if (c) { c.turbidityDelta = fin(c.turbidityDelta, 0); c.ashDelta = fin(c.ashDelta, 0); c.outageDays = fin(c.outageDays, 0); }
  }

  /* ---------- risk / prep ---------- */
  function stormRisk(state, world) {
    var season = seasonOf(state);
    var base = [0.02, 0.12, 0.35, 0.30][season] || 0.2;
    var scar = world ? scarCells(world).length : 0;
    var scarAcres = scar * C.ACRES_PER_CELL;
    var scarF = scar > 0 ? Math.pow(clamp(scarAcres / 3000, 0, 1), 0.6) : 0.05;
    var cl = (state && state.climate) || {};
    var wet = clamp(1 + 0.3 * (fin(cl.precipIn, 3) - 3) / 3, 0.7, 1.4);
    return clamp(base * Math.max(0.05, scarF) * wet, 0, 0.7);
  }

  function prepare(state, world, storm) {
    var prep = { scarCells: new Int32Array(0), scarAcres: 0, atRiskZones: [], predictedPeakCfs: 0, predictedSedimentTons: 0, storm: normStorm(storm),
                 placeable: { mulch: new Int32Array(0), barrier: new Int32Array(0), debris_basin: new Int32Array(0), bank_stab: new Int32Array(0), intake_protect: new Int32Array(0), sensor: new Int32Array(0), warning: new Int32Array(0) } };
    if (!world || !world.land) { prep._sets = {}; return prep; }
    var maps = ensureMaps(world), tp = topo(world), order = tp.order, dir = tp.dir;
    var land = world.land, acc = world.flowAcc, i, k;
    var scar = scarCells(world);
    prep.scarCells = Int32Array.from(scar);
    prep.scarAcres = scar.length * C.ACRES_PER_CELL;
    // downstream-of-scar and reaches-town masks
    var dos = new Uint8Array(NN), rt = new Uint8Array(NN);
    for (k = 0; k < scar.length; k++) dos[scar[k]] = 1;
    for (k = 0; k < NN; k++) { i = order[k]; var d = dir[i]; if (d >= 0 && dos[i] && !maps.isRes[i]) dos[d] = 1; }   // debris settles in the reservoir
    for (k = NN - 1; k >= 0; k--) { i = order[k]; d = dir[i]; if (d >= 0 && (maps.town[d] || rt[d])) rt[i] = 1; }
    var mulch = [], barrier = [], basin = [], bankS = [], sensor = [], warning = [];
    for (i = 0; i < NN; i++) {
      var lv = land[i], fa = acc ? fin(acc[i], 0) : 0;
      var isScar = k = (world.burn && fin(world.burn[i], 0) >= SCAR_MIN_BURN);
      if (isScar) mulch.push(i);
      if ((isScar || lv === L.SHRUB) && fa >= 5 && fa <= 60 && lv !== L.RIVER) barrier.push(i);
      if (fa > 60 && !maps.isRes[i] && !maps.town[i] && dos[i] && lv !== L.RESERVOIR && (maps.upstream[i] || rt[i])) basin.push(i);
      if ((lv === L.RIVER || lv === L.RIPARIAN) && !maps.upstream[i] && !maps.isRes[i]) bankS.push(i);
      if (lv === L.RIVER) sensor.push(i);
    }
    var zones = world.zones || [];
    for (k = 0; k < zones.length; k++) { var zn = zones[k]; if (zn && zn.type === 'neighborhood' && zn.center) warning.push(C.idx(zn.center.x | 0, zn.center.y | 0)); }
    prep.placeable.mulch = Int32Array.from(mulch);
    prep.placeable.barrier = Int32Array.from(barrier);
    prep.placeable.debris_basin = Int32Array.from(basin);
    prep.placeable.bank_stab = Int32Array.from(bankS);
    prep.placeable.intake_protect = maps.intake >= 0 ? Int32Array.from([maps.intake]) : new Int32Array(0);
    prep.placeable.sensor = Int32Array.from(sensor);
    prep.placeable.warning = Int32Array.from(warning);
    prep._sets = {};
    for (var t in prep.placeable) if (Object.prototype.hasOwnProperty.call(prep.placeable, t)) prep._sets[t] = new Set(prep.placeable[t]);
    // prediction: unmitigated run
    var base = simulate(state, world, prep.storm, [], { noFrames: true });
    prep.predictedPeakCfs = base.peakCfsReservoir;
    prep.predictedPeakCfsTown = base.peakCfsTown;
    prep.predictedSedimentTons = base.sedimentToReservoir;
    prep.predictedDamageM = base.damageM;
    var zset = {};
    for (k = 0; k < base.floodedCells.length; k++) { var z = world.zone ? world.zone[base.floodedCells[k]] : -1; if (z >= 0) zset[z] = true; }
    if (world.reservoir && world.reservoir.zoneId != null && base.sedimentToReservoir > 200) zset[world.reservoir.zoneId] = true;
    if (world.wetland && world.wetland.zoneId != null && base.peakCfsTown > 300) zset[world.wetland.zoneId] = true;
    prep.atRiskZones = Object.keys(zset).map(Number).sort(function (a, b) { return a - b; });
    return prep;
  }

  function canPlace(prep, type, i) {
    if (!prep || !type || !TOOLS[type] || !isFinite(i)) return false;
    i = i | 0;
    if (!prep._sets) { prep._sets = {}; for (var t in prep.placeable || {}) if (Object.prototype.hasOwnProperty.call(prep.placeable, t)) prep._sets[t] = new Set(prep.placeable[t]); }
    var s = prep._sets[type];
    return !!(s && s.has(i));
  }

  /* ---------- counterfactual & attribution ---------- */
  function counterfactual(state, world, storm) {
    return simulate(state, world, storm, [], { disableWetland: true, disableRainCapture: true, noFrames: true });
  }
  function lossOf(r) { return fin(r.damageM, 0) + fin(r.sedimentToReservoir, 0) / 2000 + fin(r.injuriesRisk, 0) * 2; }
  function attribute(state, world, storm, mitigations) {
    var mits = Array.isArray(mitigations) ? mitigations : [];
    var withAll = simulate(state, world, storm, mits, { noFrames: true });
    var eff = effectsOf(state);
    var entries = [], types = [], seen = {}, k;
    for (k = 0; k < mits.length; k++) { var t = mits[k] && mits[k].type; if (t && TOOLS[t] && !seen[t]) { seen[t] = true; types.push(t); } }
    var rows = [];
    for (k = 0; k < types.length; k++) {
      var t2 = types[k];
      var without = simulate(state, world, storm, mits.filter(function (m) { return !m || m.type !== t2; }), { noFrames: true });
      rows.push({ key: t2, label: TOOLS[t2].name, count: mits.filter(function (m) { return m && m.type === t2; }).length, without: without });
    }
    if (eff.wetlandRestored) rows.push({ key: 'wetland', label: 'Restored wetland', count: 1, without: simulate(state, world, storm, mits, { noFrames: true, disableWetland: true }) });
    if (eff.rainCapture > 0) rows.push({ key: 'rain_capture', label: 'Rain capture', count: 1, without: simulate(state, world, storm, mits, { noFrames: true, disableRainCapture: true }) });
    var total = 0;
    for (k = 0; k < rows.length; k++) {
      var r = rows[k], w = r.without;
      r.preventedDamageM = Math.max(0, Math.round((fin(w.damageM, 0) - fin(withAll.damageM, 0)) * 100) / 100);
      r.preventedSedimentTons = Math.max(0, Math.round(fin(w.sedimentToReservoir, 0) - fin(withAll.sedimentToReservoir, 0)));
      r.preventedOutageDays = Math.max(0, fin(w.contamination.outageDays, 0) - fin(withAll.contamination.outageDays, 0));
      r.preventedPeakCfsTown = Math.max(0, fin(w.peakCfsTown, 0) - fin(withAll.peakCfsTown, 0));
      r.loss = Math.max(0, lossOf(w) - lossOf(withAll)); total += r.loss;
    }
    for (k = 0; k < rows.length; k++) {
      var e = rows[k];
      entries.push({ key: e.key, label: e.label, count: e.count, preventedDamageM: e.preventedDamageM, preventedSedimentTons: e.preventedSedimentTons,
                     preventedOutageDays: e.preventedOutageDays, preventedPeakCfsTown: e.preventedPeakCfsTown,
                     pct: total > 0 ? Math.round(100 * e.loss / total) : 0 });
    }
    return entries;
  }

  /* ---------- apply to state / world ---------- */
  function logLine(state, text, kind) {
    if (!state) return;
    if (WS.State && typeof WS.State.log === 'function') { try { WS.State.log(state, text, kind); return; } catch (e) { /* fall through */ } }
    state.log = state.log || []; state.log.push({ turn: fin(state.turn, 0), text: text, kind: kind || 'info' });
  }
  function applyResult(state, world, result) {
    if (!state || !result) return null;
    state.stats = state.stats || {};
    state.flags = state.flags || {};
    state.reservoir = state.reservoir || {};
    var dmg = Math.max(0, fin(result.damageM, 0));
    var fromEmergency = Math.min(dmg, Math.max(0, fin(state.emergencyFund, 0)));
    state.emergencyFund = fin(state.emergencyFund, 0) - fromEmergency;
    var remainder = dmg - fromEmergency;
    var fromBudget = Math.min(remainder, Math.max(0, fin(state.budget, 0)));
    state.budget = fin(state.budget, 0) - fromBudget;
    state.stats.floodDamageM = fin(state.stats.floodDamageM, 0) + dmg;
    state.stats.uncoveredDamageM = fin(state.stats.uncoveredDamageM, 0) + (remainder - fromBudget);
    state.stats.sedimentTons = fin(state.stats.sedimentTons, 0) + fin(result.sedimentToReservoir, 0);
    // crops
    var farmHit = 0, farmTotal = 0, i;
    if (world && world.cropHealth && world.land) {
      var fl = result.floodedCells || [];
      for (i = 0; i < fl.length; i++) if (world.land[fl[i]] === L.FARM) { world.cropHealth[fl[i]] = clamp(fin(world.cropHealth[fl[i]], 0.85) - 0.4, 0, 1); farmHit++; }
      for (i = 0; i < NN; i++) if (world.land[i] === L.FARM) farmTotal++;
    }
    if (farmHit > 0) state.stats.cropLossPct = fin(state.stats.cropLossPct, 0) + Math.round(100 * 0.4 * farmHit / Math.max(1, farmTotal));
    // contamination (the real thing this time)
    var sedRes = fin(result.sedimentToReservoir, 0), ashFrac = sedRes > 0 ? fin(result.ashToReservoir, 0) / sedRes : 0;
    var contam = null;
    if (WS.Hydrology && typeof WS.Hydrology.contaminate === 'function') {
      try {
        var r = WS.Hydrology.contaminate(state, world, sedRes, ashFrac);
        if (r && typeof r === 'object') contam = { turbidityDelta: fin(r.turbidityDelta, 0), ashDelta: fin(r.ashDelta, 0), outageDays: fin(r.outageDays, 0) };
      } catch (e) { contam = null; }
    }
    if (!contam) {
      contam = simpleContamination(state, sedRes, ashFrac, !!result.intakeProtected, effectsOf(state));
      state.reservoir.turbidity = clamp(fin(state.reservoir.turbidity, 0) + contam.turbidityDelta, 0, 1);
      state.reservoir.ashContam = clamp(fin(state.reservoir.ashContam, 0) + contam.ashDelta, 0, 1);
    }
    if (result.earlyWarning) contam.outageDays = Math.round(contam.outageDays * 0.5);
    contam.outageDays = clamp(fin(contam.outageDays, 0), 0, 90);
    state.stats.contaminationOutageDays = fin(state.stats.contaminationOutageDays, 0) + contam.outageDays;
    if (contam.outageDays > 0) state.flags.contaminationEvents = fin(state.flags.contaminationEvents, 0) + 1;
    state.flags.lastFloodDamageM = dmg;
    state.flags.floods = fin(state.flags.floods, 0) + 1;
    // recovery boost under mulch, and a slightly lighter scar there
    if (world && world.burn) {
      var mits = state.mitigations || [];
      var regrow = world.regrow || (world.regrow = new Float32Array(NN));
      for (i = 0; i < mits.length; i++) {
        var m = mits[i]; if (!m || m.type !== 'mulch') continue;
        var mi = mitIndex(m); if (mi < 0) continue;
        var x = mi % N, y = (mi / N) | 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var nx = x + dx, ny = y + dy; if (!C.inBounds(nx, ny)) continue;
          var j = ny * N + nx;
          regrow[j] = Math.max(fin(regrow[j], 0), 0.5);
          world.burn[j] = clamp(fin(world.burn[j], 0) * 0.9, 0, 1);
        }
      }
    }
    // log lines
    var s = result.storm || {};
    logLine(state, 'Storm (' + fin(s.intensityIn, 0).toFixed(1) + ' in): peak ' + fin(result.peakCfsReservoir, 0).toLocaleString() + ' cfs into the reservoir, ' + sedRes.toLocaleString() + ' t of sediment delivered.', sedRes > 1000 ? 'bad' : 'warn');
    if (dmg > 0) logLine(state, 'Flooding damaged ' + fin(result.floodedHouses, 0) + ' homes and cost $' + dmg.toFixed(2) + 'M (' + (result.floodedCells ? result.floodedCells.length : 0) + ' cells).', 'bad');
    if (fin(result.trappedTons, 0) > 0) logLine(state, 'Your mitigations trapped ' + fin(result.trappedTons, 0).toLocaleString() + ' t of sediment before it reached the water supply.', 'good');
    if (contam.outageDays > 0) logLine(state, 'Ash and turbidity overwhelmed the treatment plant: ' + contam.outageDays + ' days of water restrictions.' + (result.earlyWarning ? ' Early warning from your sensors halved the outage.' : ''), 'bad');
    var applied = { damageM: dmg, fromEmergency: fromEmergency, fromBudget: fromBudget, contamination: contam, cropCellsHit: farmHit };
    result.applied = applied;
    return applied;
  }

  WS.Flood = {
    TOOLS: TOOLS,
    stormRisk: stormRisk,
    prepare: prepare,
    canPlace: canPlace,
    simulate: simulate,
    counterfactual: counterfactual,
    attribute: attribute,
    applyResult: applyResult,
    topoOrder: function (world) { return world ? topo(world).order : new Int32Array(0); }
  };
})();
