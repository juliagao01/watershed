/* Watershed — scoring: outcome targets, momentum update, resilience score, grade, final summary. Runs in Node (no DOM). */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C, L = C.LAND, H = C.HYDRO;

  var MOMENTUM = 0.45;         // fraction of the gap to target closed each season
  var TRUST_ANCHOR = 55;       // trust regresses toward this by ±1 per turn

  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function clamp(v, a, b) { v = fin(v, a); return v < a ? a : (v > b ? b : v); }
  function r1(v) { return Math.round(fin(v, 0) * 10) / 10; }
  function pct(v) { return Math.round(clamp(v, 0, 1) * 100); }
  function fx(state) {
    var e = null;
    try { if (WS.Projects && typeof WS.Projects.effects === 'function') e = WS.Projects.effects(state); } catch (err) { e = null; }
    e = e || {};
    return { wetlandRestored: !!e.wetlandRestored, shelters: !!e.shelters, warningSystem: !!e.warningSystem, hardenedZones: e.hardenedZones || {},
      treatment: !!e.treatment, wildlifeCorridor: !!e.wildlifeCorridor, outreach: !!e.outreach, sensorCoverage: fin(e.sensorCoverage, 0) };
  }

  /* world means (typed loops, no allocation) */
  function worldMeans(world) {
    var out = { habitat: 0.5, treeDensity: 0.6, cropHealth: 0.85, burnForestFrac: 0, townFuel: 0.6, wuiHomes: 0, wuiHardened: 0, ok: false };
    if (!world || !world.land) return out;
    var land = world.land, n = land.length, hs = 0, hn = 0, ts = 0, tn = 0, cs = 0, cn = 0, bf = 0;
    for (var i = 0; i < n; i++) {
      var t = land[i];
      if (t === L.RIVER || t === L.RESERVOIR) continue;
      if (world.habitat) { hs += fin(world.habitat[i], 0); hn++; }
      if (t === L.FOREST) { if (world.treeDensity) { ts += fin(world.treeDensity[i], 0); tn++; } if (world.burn && fin(world.burn[i], 0) > 0.3) bf++; }
      if (t === L.FARM && world.cropHealth) { cs += fin(world.cropHealth[i], 0); cn++; }
    }
    out.ok = true;
    if (hn) out.habitat = hs / hn;
    if (tn) { out.treeDensity = ts / tn; out.burnForestFrac = bf / tn; }
    if (cn) out.cropHealth = cs / cn;
    // fuel in forest sectors above town (not upstream of the reservoir)
    var zones = Array.isArray(world.zones) ? world.zones : [], fs = 0, fn = 0;
    for (i = 0; i < zones.length; i++) {
      var z = zones[i];
      if (!z || z.type !== 'forest' || z.upstreamOfReservoir || !z.cells || !world.fuel) continue;
      for (var j = 0; j < z.cells.length; j++) { fs += fin(world.fuel[z.cells[j]], 0); fn++; }
    }
    if (fn) out.townFuel = fs / fn;
    return out;
  }
  function wuiShare(world, hardened) {
    if (!world || !Array.isArray(world.zones)) return 0;
    var zones = world.zones, homes = 0, hard = 0, wui = {};
    for (var i = 0; i < zones.length; i++) { var z = zones[i]; if (z && z.type === 'neighborhood' && (z.wui || /Marshall/.test(z.name || ''))) wui[z.id] = true; }
    var ids = Object.keys(wui);
    if (!ids.length) { for (i = 0; i < zones.length; i++) if (zones[i] && zones[i].type === 'neighborhood') wui[zones[i].id] = true; }
    for (i = 0; i < zones.length; i++) {
      z = zones[i]; if (!z || !wui[z.id]) continue;
      var cnt = z.cells ? z.cells.length : 1; homes += cnt; if (hardened && hardened[z.id]) hard += cnt;
    }
    return homes ? hard / homes : 0;
  }

  function targets(state, world, rep, extras) {
    var o = state.outcomes || {}, r = state.reservoir || {}, cl = state.climate || {}, w = state.water || {}, f = fx(state);
    var flags = state.flags || {}, stats = state.stats || {}, fire = state.fire || {};
    var wm = worldMeans(world);
    rep = rep || state.lastSeasonReport || {};
    extras = extras || {};
    var flood = extras.flood || null, fireRep = extras.fire || null;
    // baselines recorded on first call so we can measure "vs initial"
    if (!isFinite(flags.habitatInit)) flags.habitatInit = Math.max(0.05, wm.habitat);
    if (!isFinite(flags.treeDensityInit)) flags.treeDensityInit = Math.max(0.05, wm.treeDensity);

    var cap = Math.max(1, fin(r.capacityAF, H.RESERVOIR_CAPACITY_AF));
    var storageFrac = clamp(fin(r.storageAF, 0) / cap, 0, 1.2);
    var sp = rep.shortagePct || {};
    var hhShort = clamp(fin(sp.households, 0), 0, 1), farmShort = clamp(fin(sp.farms, 0), 0, 1);
    var ash = clamp(fin(r.ashContam, 0), 0, 1), turb = clamp(fin(r.turbidity, 0), 0, 1);
    var outageDays = fin(flags.outageDaysThisTurn, 0);

    // ---- W: Water Security ----
    var W = 100 * (0.45 * clamp(storageFrac / 0.8, 0, 1) + 0.35 * (1 - hhShort) + 0.2 * (1 - ash)) - Math.min(25, outageDays * 1.5) - 8 * turb;
    if (w.restriction === 'stage2') W -= 4; else if (w.restriction === 'stage1') W -= 2;
    if (cl.drought === 'D3') W -= 2; else if (cl.drought === 'D4') W -= 4;

    // ---- E: Ecosystem Health ----
    var streak = fin(flags.minFlowStreak, 0);
    var flowScore = rep.minFlowMet === false ? 0.15 : clamp(0.4 + streak / 6, 0, 1);
    var habitatScore = clamp(wm.habitat / flags.habitatInit, 0, 1.15);
    var treeScore = clamp(wm.treeDensity / flags.treeDensityInit, 0, 1.1);
    var burnScore = clamp(1 - 2.2 * wm.burnForestFrac, 0, 1);
    var E = 100 * (0.25 * flowScore + 0.2 * habitatScore + 0.2 * treeScore + 0.15 * (1 - turb) + 0.1 * (f.wetlandRestored ? 1 : 0.35) + 0.1 * burnScore)
      - 10 * clamp(fin(r.algae, 0), 0, 1) + (f.wildlifeCorridor ? 4 : 0) - (flags.musselsEstablished ? 8 : 0);

    // ---- P: Public Safety ----
    var structures = fin(fire.structuresLost, 0), floodDamage = fin(stats.floodDamageM, 0), smoke = fin(fire.smokeDays, 0);
    var hardShare = wuiShare(world, f.hardenedZones);
    var dangerNearTown = clamp(fin(cl.fireDanger, 0), 0, 1) * clamp(wm.townFuel / 0.65, 0, 1.4);
    var P = 88 - Math.min(30, structures * 0.4) - Math.min(25, floodDamage * 1.5) - (f.shelters ? 0 : Math.min(15, smoke * 0.3))
      + (f.warningSystem ? 5 : 0) + (f.shelters ? 4 : 0) + 10 * hardShare - 15 * dangerNearTown;
    if (flood) P -= Math.min(15, 20 * clamp(fin(flood.injuriesRisk, 0), 0, 1)) + Math.min(10, fin(flood.floodedHouses, 0) * 0.3);
    if (fireRep) P -= Math.min(12, fin(fireRep.structuresLost, 0) * 0.6);
    if (flags.subdivisionApproved) P -= 4;
    if (flags.insuranceRetreat) P -= 5;
    if (f.outreach) P += 2;

    // ---- F: Food & Economy ----
    var crop = clamp(fin(rep.cropHealthAvg, wm.cropHealth), 0, 1);
    var rec = clamp(fin(rep.recreationIndex, 0.6), 0, 1);
    var hydroScore = clamp(fin(rep.hydroMWh, 200) / 350, 0, 1);
    var econ = 0.7 + (flags.tourismBoom ? 0.2 : 0) + (flags.federalGrant ? 0.1 : 0) - (flags.insuranceRetreat ? 0.25 : 0) - (flags.wellFailures ? 0.1 : 0);
    var F = 100 * (0.35 * clamp(crop / 0.85, 0, 1) + 0.2 * (1 - farmShort) + 0.2 * rec + 0.1 * hydroScore + 0.15 * clamp(econ, 0, 1));
    if (flood) F -= Math.min(20, 2 * fin(flood.damageM, 0));
    if (fireRep) F -= Math.min(10, fin(fireRep.acres, 0) / 2000);
    F -= Math.min(12, outageDays * 0.6);

    return {
      W: clamp(W, 0, 100), E: clamp(E, 0, 100), P: clamp(P, 0, 100), F: clamp(F, 0, 100),
      ctx: { storageFrac: storageFrac, hhShort: hhShort, farmShort: farmShort, ash: ash, turb: turb, outageDays: outageDays, streak: streak, minFlowMet: rep.minFlowMet,
        habitatScore: habitatScore, treeScore: treeScore, burnForestFrac: wm.burnForestFrac, wetland: f.wetlandRestored, algae: fin(r.algae, 0),
        structures: structures, floodDamage: floodDamage, smoke: smoke, shelters: f.shelters, warning: f.warningSystem, hardShare: hardShare, dangerNearTown: dangerNearTown,
        flood: flood, fireRep: fireRep, crop: crop, rec: rec, hydroMWh: fin(rep.hydroMWh, 0), restriction: w.restriction, drought: cl.drought }
    };
  }

  function signed(d) { d = r1(d); return (d > 0 ? '+' : (d < 0 ? '−' : '±')) + Math.abs(d).toFixed(1); }
  /* reason text ≤ 12 words: "<Outcome> <±delta>: part, part, part." — parts are ≤ 3 words each, 3 at most, most relevant first. */
  function reasonText(key, before, after, tg, c) {
    var parts = [];
    if (key === 'W') {
      parts.push('reservoir ' + pct(c.storageFrac) + '%');
      if (c.outageDays > 0) parts.push('outage ' + c.outageDays + ' days');
      if (c.hhShort > 0.005) parts.push('households short ' + pct(c.hhShort) + '%');
      if (c.ash > 0.02) parts.push('ash ' + pct(c.ash) + '%');
      if (c.turb > 0.15) parts.push('turbidity ' + pct(c.turb) + '%');
      if (c.restriction && c.restriction !== 'none') parts.push(c.restriction + ' restrictions');
      if (c.drought && c.drought !== 'None') parts.push('drought ' + c.drought);
      if (parts.length < 3 && c.hhShort <= 0.005) parts.push('households supplied');
    } else if (key === 'E') {
      parts.push(c.minFlowMet === false ? 'instream flow missed' : 'min-flow streak ' + c.streak);
      if (c.burnForestFrac > 0.01) parts.push('forest burned ' + pct(c.burnForestFrac) + '%');
      if (c.algae > 0.3) parts.push('algae ' + pct(c.algae) + '%');
      if (c.turb > 0.15) parts.push('turbidity ' + pct(c.turb) + '%');
      parts.push('habitat ' + pct(c.habitatScore) + '%');
      parts.push('canopy ' + pct(c.treeScore) + '%');
      parts.push(c.wetland ? 'wetland restored' : 'no wetland');
    } else if (key === 'P') {
      if (c.fireRep) parts.push('fire ' + Math.round(fin(c.fireRep.acres, 0)).toLocaleString() + ' acres');
      if (c.flood) parts.push(fin(c.flood.floodedHouses, 0) + ' homes flooded');
      if (c.structures > 0) parts.push(c.structures + ' structures lost');
      if (c.floodDamage > 0) parts.push('flood damage $' + r1(c.floodDamage).toFixed(1) + 'M');
      if (c.smoke > 0) parts.push('smoke ' + c.smoke + ' days');
      parts.push('town danger ' + pct(c.dangerNearTown) + '%');
      if (c.hardShare > 0) parts.push('WUI hardened ' + pct(c.hardShare) + '%');
      if (c.warning) parts.push('warning system');
      if (c.structures <= 0 && parts.length < 3) parts.push('no structures lost');
    } else if (key === 'F') {
      if (c.flood) parts.push('storm damage $' + r1(fin(c.flood.damageM, 0)).toFixed(1) + 'M');
      if (c.outageDays > 0) parts.push('outage ' + c.outageDays + ' days');
      parts.push('crops ' + pct(c.crop) + '%');
      parts.push(c.farmShort > 0.005 ? 'farms short ' + pct(c.farmShort) + '%' : 'farms supplied');
      parts.push('recreation ' + pct(c.rec) + '%');
      parts.push(Math.round(c.hydroMWh) + ' MWh hydro');
    }
    return C.OUTCOME_NAMES[key] + ' ' + signed(after - before) + ': ' + parts.slice(0, 3).join(', ') + '.';
  }

  var Scoring = WS.Scoring = {
    MOMENTUM: MOMENTUM, TRUST_ANCHOR: TRUST_ANCHOR,

    /** updateOutcomes(state, world, seasonReport, extras) → { before, after, delta, reasons:[{key,text,delta}] } */
    updateOutcomes: function (state, world, seasonReport, extras) {
      if (!state) return { before: {}, after: {}, delta: {}, reasons: [] };
      var o = state.outcomes = state.outcomes || {};
      var keys = C.OUTCOME_KEYS, before = {}, after = {}, delta = {}, reasons = [], i, k;
      for (i = 0; i < keys.length; i++) { k = keys[i]; o[k] = clamp(o[k], 0, 100); before[k] = o[k]; }
      var tg = targets(state, world, seasonReport, extras);
      for (i = 0; i < 4; i++) {
        k = keys[i];
        after[k] = clamp(before[k] + (tg[k] - before[k]) * MOMENTUM, 0, 100);
        delta[k] = r1(after[k] - before[k]);
        reasons.push({ key: k, text: reasonText(k, before[k], after[k], tg[k], tg.ctx), delta: delta[k] });
      }
      // Trust: accumulated deltas this turn + slow regression toward the anchor
      var td = clamp(fin(state.trustDelta, 0), -25, 25);
      var reg = before.T > TRUST_ANCHOR + 1 ? -1 : before.T < TRUST_ANCHOR - 1 ? 1 : 0;
      after.T = clamp(before.T + td + reg, 0, 100);
      delta.T = r1(after.T - before.T);
      var tParts = [];
      if (Math.abs(td) >= 0.05) tParts.push('choices ' + signed(td));
      if (reg !== 0) tParts.push('drift ' + signed(reg));
      if (seasonReport && seasonReport.legalOverride) tParts.push('senior rights overridden');
      if (seasonReport && seasonReport.shortagePct && fin(seasonReport.shortagePct.households, 0) > 0.05) tParts.push('household shortages');
      if (fin(tg.ctx.outageDays, 0) > 0) tParts.push('boil-water notice');
      reasons.push({ key: 'T', text: C.OUTCOME_NAMES.T + ' ' + signed(delta.T) + ': ' + (tParts.length ? tParts.slice(0, 3).join(', ') : 'no notable events') + '; now ' + Math.round(after.T) + '.', delta: delta.T });
      state.trustDelta = 0;
      if (state.flags) state.flags.outageDaysThisTurn = 0;
      for (i = 0; i < keys.length; i++) { k = keys[i]; o[k] = Math.round(after[k] * 10) / 10; after[k] = o[k]; }
      state.resilience = Scoring.resilience(o);
      return { before: before, after: after, delta: delta, reasons: reasons, targets: { W: r1(tg.W), E: r1(tg.E), P: r1(tg.P), F: r1(tg.F) } };
    },

    /** resilience(outcomes) → 0..100 weighted sum */
    resilience: function (outcomes) {
      outcomes = outcomes || {};
      var sum = 0, wsum = 0;
      for (var i = 0; i < C.OUTCOME_KEYS.length; i++) { var k = C.OUTCOME_KEYS[i], w = C.OUTCOME_WEIGHTS[k]; sum += w * clamp(outcomes[k], 0, 100); wsum += w; }
      return wsum > 0 ? Math.round(sum / wsum * 10) / 10 : 0;
    },

    /** grade(R) → { letter, title, R } */
    grade: function (R) {
      R = clamp(R, 0, 100);
      var g = R >= 90 ? ['A', 'Watershed Steward'] : R >= 80 ? ['B', 'Resilient Community'] : R >= 70 ? ['C', 'Holding Steady'] : R >= 60 ? ['D', 'Strained Basin'] : ['F', 'Crisis Basin'];
      return { letter: g[0], title: g[1], R: Math.round(R * 10) / 10 };
    },

    /** finalSummary(state) → { R, grade, outcomes, highlights, lessons, stats } */
    finalSummary: function (state) {
      state = state || {};
      var o = state.outcomes || {}, stats = state.stats || {}, fire = state.fire || {}, flags = state.flags || {}, hist = Array.isArray(state.history) ? state.history : [];
      var R = Scoring.resilience(o), g = Scoring.grade(R), highlights = [], lessons = [];
      var fires = Array.isArray(fire.fires) ? fire.fires : [], biggest = null;
      for (var i = 0; i < fires.length; i++) if (fires[i] && (!biggest || fin(fires[i].acres, 0) > fin(biggest.acres, 0))) biggest = fires[i];
      var minStore = null;
      for (i = 0; i < hist.length; i++) if (hist[i] && (!minStore || fin(hist[i].storageAF, 1e9) < fin(minStore.storageAF, 1e9))) minStore = hist[i];
      var cap = Math.max(1, fin(state.reservoir && state.reservoir.capacityAF, H.RESERVOIR_CAPACITY_AF));
      var yearsPlayed = Math.max(1, Math.floor(fin(state.turn, 0) / 4));

      // highlights ≤ 10 words each, ≤ 4 items; lessons ≤ 12 words each, ≤ 3 items (most relevant first)
      highlights.push('Score ' + g.R + ' · grade ' + g.letter + ' (' + g.title + ') · ' + yearsPlayed + ' year' + (yearsPlayed === 1 ? '' : 's') + '.');
      if (biggest) highlights.push('Largest fire ' + Math.round(fin(biggest.acres, 0)).toLocaleString() + ' acres, year ' + fin(biggest.year, 1) + (fin(biggest.structures, 0) > 0 ? '; ' + biggest.structures + ' structures lost' : '') + '.');
      else highlights.push('No wildfire in ' + yearsPlayed + ' year' + (yearsPlayed === 1 ? '' : 's') + '; fuel kept building.');
      if (minStore) highlights.push('Reservoir low ' + Math.round(fin(minStore.storageAF, 0)).toLocaleString() + ' AF (' + Math.round(100 * fin(minStore.storageAF, 0) / cap) + '%), year ' + fin(minStore.year, 1) + '.');
      if (fin(stats.floodDamageM, 0) > 0) highlights.push('Floods: $' + r1(stats.floodDamageM).toFixed(1) + 'M damage, ' + Math.round(fin(stats.sedimentTons, 0)).toLocaleString() + ' t sediment' + (fin(stats.contaminationOutageDays, 0) > 0 ? ', ' + Math.round(stats.contaminationOutageDays) + ' outage days' : '') + '.');
      else if (fin(stats.contaminationOutageDays, 0) > 0) highlights.push('Treatment plant offline ' + Math.round(stats.contaminationOutageDays) + ' days from ash.');
      else highlights.push('Hydro ' + Math.round(fin(stats.hydroMWh, 0)).toLocaleString() + ' MWh · ' + Math.round(fin(stats.recreationVisits, 0)).toLocaleString() + ' recreation visits.');
      highlights = highlights.slice(0, 4);

      if (fin(o.W, 0) < 60) lessons.push('Water security slipped: leak detection, irrigation and intake protection buy margin early.');
      if (fin(stats.contaminationOutageDays, 0) > 0) lessons.push('Post-fire ash is a drinking-water problem: mulch, basins, intake protection.');
      if (fin(fire.totalAcres, 0) > 5000) lessons.push('Fuel treatment above the reservoir cuts severity; severity makes mudflows.');
      else if (!biggest) lessons.push('A quiet fire history is not safety; fuel builds every year.');
      if (fin(o.T, 0) < 50) lessons.push('Trust drops fast, returns slowly; outreach matters as much as engineering.');
      if (fin(o.E, 0) < 55) lessons.push('Hold the 14 cfs instream flow and restore the wetland.');
      if (fin(o.F, 0) < 55) lessons.push('Farms and tourism feel drought first; efficient irrigation keeps them working.');
      if (flags.legalOverrides || (state.timeline || []).length === 0) lessons.push('Senior rights are met first under prior appropriation; plan around them.');
      if (fin(o.W, 0) >= 60) lessons.push('Storage carried you; keep the reservoir full into summer.');
      lessons.push('Resilience = 0.25 W + 0.20 E + 0.20 P + 0.20 F + 0.15 T.');
      lessons = lessons.slice(0, 3);

      return { R: R, grade: g, outcomes: { W: fin(o.W, 0), E: fin(o.E, 0), P: fin(o.P, 0), F: fin(o.F, 0), T: fin(o.T, 0) }, highlights: highlights, lessons: lessons,
        stats: { floodDamageM: fin(stats.floodDamageM, 0), sedimentTons: fin(stats.sedimentTons, 0), contaminationOutageDays: fin(stats.contaminationOutageDays, 0),
          cropLossPct: fin(stats.cropLossPct, 0), hydroMWh: fin(stats.hydroMWh, 0), recreationVisits: fin(stats.recreationVisits, 0),
          totalAcres: fin(fire.totalAcres, 0), structuresLost: fin(fire.structuresLost, 0), fires: fires.length, years: yearsPlayed } };
    }
  };
})();
