/* Watershed — Projects: fundable resilience investments. Exports WS.Projects (LIST, canFund, fund, effects, tick, listFor).
   Runs in Node (no DOM). All randomness via the rng passed in. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C;

  var ALL_SEASONS = [0, 1, 2, 3];
  var num = function (v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); };
  var clamp01 = function (v) { return C.clamp(num(v, 0), 0, 1); };
  var round1 = function (v) { return Math.round(num(v, 0) * 100) / 100; };

  /* ------------------------------------------------------------------ definitions */
  var LIST = [
    {
      id: 'streamgages', name: 'Streamgage Network', icon: '📡', category: 'monitor',
      costM: 1.2, upkeepM: 0.1, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Real-time stream and snow data; sharper forecasts.',
      detail: 'USGS and Colorado DWR gages report every 15 minutes. Paired with SNOTEL sites they cut forecast uncertainty to ±5%.',
      tradeoff: 'Adds no water; only tells you sooner.',
      effects: { sensorCoverage: 1, uncertainty: 0.05 }
    },
    {
      id: 'irrigation', name: 'Irrigation Modernization', icon: '🚜', category: 'water',
      costM: 2.4, upkeepM: 0, maxLevel: 3, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Sprinklers, drip, lined ditches: +12% efficiency per level.',
      detail: 'Agriculture diverts 85-90% of Colorado water, much through unlined ditches. CWCB and NRCS EQIP cost-share upgrades; water courts guard return flows.',
      tradeoff: 'Shrinks return flows downstream ditches and wetlands need.',
      effects: { irrigationEfficiencyPerLevel: 0.12 }
    },
    {
      id: 'leak_detection', name: 'Leak Detection', icon: '🔧', category: 'water',
      costM: 1.6, upkeepM: 0.05, maxLevel: 3, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Acoustic loggers, district metering: -6% demand per level.',
      detail: 'Colorado utilities lose 10-20% of treated water to old mains and freeze-thaw. Loggers and metering find leaks before they become breaks.',
      tradeoff: 'Found leaks must be fixed; pipe replacement eats budget.',
      effects: { leakReductionPerLevel: 0.06 }
    },
    {
      id: 'forest_thinning', name: 'Forest Thinning', icon: '🌲', category: 'fire',
      costM: 2.8, upkeepM: 0, maxLevel: 6, targetType: 'forest', seasonsAllowed: ALL_SEASONS,
      summary: 'One sector: fuel x0.55, fades over ~8 years.',
      detail: 'Crown fire drops to the ground where crews can catch it. Denver Water\'s Forests to Faucets pays for this; fades in 8-12 years.',
      tradeoff: '$1,000-3,000 per acre, leaves slash, fades unless maintained.',
      effects: { fuelMultiplier: 0.55, strength: 1.0, decayPerYear: 0.12, refundableBelowStrength: 0.6 }
    },
    {
      id: 'prescribed_burn', name: 'Prescribed Burn', icon: '🔥', category: 'fire',
      costM: 0.6, upkeepM: 0, maxLevel: 99, targetType: 'forest', seasonsAllowed: [1, 3], repeatable: true,
      summary: 'One sector, Spring/Fall, fuel x0.4 at season end.',
      detail: 'Cheapest fuel treatment; ponderosa evolved with low fire. Needs a CDPHE smoke permit and a weather window; 2012\'s Lower North Fork escape tightened rules.',
      tradeoff: '4% escape, smoke on town, residents push back.',
      effects: { fuelMultiplier: 0.4, escapeChanceBase: 0.04 }
    },
    {
      id: 'reservoir_upgrade', name: 'Reservoir Upgrade', icon: '🏗️', category: 'water',
      costM: 5.0, costs: [5.0, 4.0], upkeepM: 0.1, maxLevel: 2, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'L1: +15% capacity. L2: multi-level clean-water intake.',
      detail: 'Raising the dam adds storage without a new site (Gross Reservoir). A multi-level intake let Fort Collins draw clear water after Cameron Peak.',
      tradeoff: 'Expensive, slow, floods shoreline, adds no water in drought.',
      effects: { capacityBonusL1: 0.15, multiLevelIntakeL2: true }
    },
    {
      id: 'rain_capture', name: 'Rain Capture', icon: '🌧️', category: 'water',
      costM: 1.5, upkeepM: 0, maxLevel: 2, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Barrels, basins, permeable pavement: +450 AF/yr per level.',
      detail: 'Colorado legalized rain barrels only in 2016 (110 gallons) because rain was owed downstream. Green streets and basins slow stormwater and shave peak demand.',
      tradeoff: 'Small yield; larger capture needs augmentation plans.',
      effects: { rainCaptureAFPerLevel: 450, floodDamageReduction: 0.3 }
    },
    {
      id: 'home_hardening', name: 'Home Hardening', icon: '🏠', category: 'fire',
      costM: 1.8, upkeepM: 0, maxLevel: 4, targetType: 'neighborhood', seasonsAllowed: ALL_SEASONS,
      summary: 'Class A roofs, ember vents, 0-5 ft zone.',
      detail: 'Embers ignite most homes: roofs, vents, 0-5 ft zone matter most. Marshall Fire 2021 spread house to house; hardened blocks lose 73% fewer.',
      tradeoff: 'Owners must maintain it; some resist losing landscaping.',
      effects: { structureLossMultiplier: 0.27, spreadMultiplier: 0.36 }
    },
    {
      id: 'fuel_break', name: 'Shaded Fuel Break', icon: '🪓', category: 'fire',
      costM: 0.9, upkeepM: 0.05, maxLevel: 4, targetType: 'neighborhood', seasonsAllowed: ALL_SEASONS,
      summary: '100-300 ft thinned strip where crews hold fire.',
      detail: 'A thinned strip along the subdivision edge gives crews a place to hold. County Wildfire Protection Plans prioritize them; embers still jump, flames shorten.',
      tradeoff: 'Embers jump breaks; re-treat every few years.',
      effects: { edgeFuelMultiplier: 0.6, suppressionBonus: true }
    },
    {
      id: 'wetland', name: 'Wetland Restoration', icon: '🦫', category: 'flood',
      costM: 2.2, upkeepM: 0.05, maxLevel: 1, targetType: 'wetland', seasonsAllowed: ALL_SEASONS,
      summary: 'Beaver-dam analogs and willows: -35% sediment, -30% peaks.',
      detail: 'Beaver-dam analogs and willows reconnect the creek to its meadow, slowing pulses. Post-fire work on the Poudre and Big Thompson uses the same methods.',
      tradeoff: 'Soaks up water ranchers count on; years to mature.',
      effects: { sedimentTrap: 0.35, peakAttenuation: 0.3, habitatBonus: 0.2 }
    },
    {
      id: 'shelters', name: 'Clean-Air Shelters', icon: '🏫', category: 'community',
      costM: 1.4, upkeepM: 0.1, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'HEPA shelters with backup power: -70% smoke harm.',
      detail: 'A school gym with HEPA filtration, backup power and cots. Colorado\'s 2020 smoke sat at very unhealthy for weeks; the same building serves evacuations.',
      tradeoff: 'Sits unused between emergencies; staff and filters cost.',
      effects: { smokeHarmReduction: 0.7 }
    },
    {
      id: 'warning_system', name: 'Warning System', icon: '🚨', category: 'flood',
      costM: 1.0, upkeepM: 0.1, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Scar gages plus mass alerts: -80% injury risk.',
      detail: 'Debris flows arrive minutes after rain hits a scar. Gages plus Wireless Emergency Alerts buy evacuation time, as 2013 and Glenwood Canyon 2021 taught.',
      tradeoff: 'False alarms erode trust; opt-outs get nothing.',
      effects: { injuryRiskReduction: 0.8, earlyWarning: true }
    },
    {
      id: 'outreach', name: 'Community Outreach', icon: '📣', category: 'community',
      costM: 0.5, upkeepM: 0.5, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Turf rebates, watering rules, meetings: -8% demand yearly.',
      detail: 'Turf rebates and watering rules cut peak demand 10-20% in Aurora and Colorado Springs. Public meetings build the trust hard decisions need.',
      tradeoff: 'Costs every year; savings fade if it lapses.',
      effects: { demandReduction: 0.08, trustPerYear: 1 }
    },
    {
      id: 'treatment', name: 'Treatment Upgrade', icon: '💧', category: 'water',
      costM: 3.5, upkeepM: 0.15, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Coagulation and carbon for ash: -50% outage days.',
      detail: 'Ash brings carbon, manganese and fine sediment that clog filters. Fort Collins and Greeley added coagulation and activated carbon after the 2020 fires.',
      tradeoff: 'Costly; the intake still closes when turbidity spikes.',
      effects: { contaminationDecayBonus: 0.25, outageReduction: 0.5 }
    },
    {
      id: 'stockpile', name: 'Erosion Stockpile', icon: '📦', category: 'flood',
      costM: 0.7, upkeepM: 0, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Straw, wattles, mulch on hand: +3 free placements.',
      detail: 'Mulch must hit the scar within days, before the first monsoon storm. NRCS Emergency Watershed Protection pre-positioned materials after Cameron Peak and East Troublesome.',
      tradeoff: 'Materials degrade; money tied up if no fire comes.',
      effects: { freePlacements: 3 }
    },
    {
      id: 'mussel_inspection', name: 'Boat Inspection Stations', icon: '🛥️', category: 'water',
      costM: 0.8, upkeepM: 0.3, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Inspect every trailered boat: mussel risk x0.1.',
      detail: 'Established mussels foul intakes forever. CPW has inspected boats since 2008; zebra mussels reached Highline Lake in 2022 and the Colorado River in 2024.',
      tradeoff: 'Ramp lines annoy boaters; $0.3M yearly staffing.',
      effects: { musselRiskMultiplier: 0.1 }
    },
    {
      id: 'wildlife_corridor', name: 'Wildlife Corridor', icon: '🦌', category: 'community',
      costM: 0.9, upkeepM: 0, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Friendly fencing, underpass, plantings: +15% habitat.',
      detail: 'Elk cross roads and fences between summer forest and winter benches. Colorado\'s 2019 migration-corridor order funds this; connected habitat recovers faster after fire.',
      tradeoff: 'Cheap, but limits building along the corridor.',
      effects: { habitatBonus: 0.15 }
    }
  ];
  var BY_ID = {};
  LIST.forEach(function (d) { BY_ID[d.id] = d; });

  /* ------------------------------------------------------------------ helpers */
  function ensure(state) {
    if (!state) return null;
    if (!state.projects) state.projects = { funded: {}, pendingBurn: null };
    if (!state.projects.funded) state.projects.funded = {};
    if (state.projects.pendingBurn === undefined) state.projects.pendingBurn = null;
    if (typeof state.projects._rev !== 'number') state.projects._rev = 0;
    if (!state.flags) state.flags = {};
    return state.projects;
  }
  function bump(state) { var p = ensure(state); if (p) p._rev = (p._rev | 0) + 1; }
  function isZoneProject(def) { return def.targetType && def.targetType !== 'global'; }
  function costFor(def, level) {
    var L = Math.max(1, level | 0);
    if (def.costs && def.costs[L - 1] != null) return num(def.costs[L - 1], def.costM);
    if (def.repeatable) return num(def.costM, 0);
    return round1(num(def.costM, 0) * (1 + 0.15 * (L - 1)));
  }
  function zonesFor(world, def) {
    if (!world || !isZoneProject(def)) return [];
    var zs = null;
    try {
      if (typeof world.zonesOf === 'function') zs = world.zonesOf(def.targetType);
      else if (Array.isArray(world.zones)) zs = world.zones.filter(function (z) { return z && z.type === def.targetType; });
    } catch (e) { zs = null; }
    return Array.isArray(zs) ? zs.filter(Boolean) : [];
  }
  function zoneById(world, id) {
    if (!world || id == null) return null;
    try {
      if (typeof world.zoneById === 'function') { var z = world.zoneById(id); if (z) return z; }
      if (Array.isArray(world.zones)) { for (var i = 0; i < world.zones.length; i++) if (world.zones[i] && world.zones[i].id === id) return world.zones[i]; }
    } catch (e) { /* defensive */ }
    return null;
  }
  function zoneName(world, id) { var z = zoneById(world, id); return z && z.name ? z.name : ('zone ' + id); }
  function fundedRec(state, id) { var p = ensure(state); return p && p.funded[id] ? p.funded[id] : null; }
  function levelOf(state, id) { var r = fundedRec(state, id); return r ? (r.level | 0) : 0; }
  function targetsOf(rec) { return (rec && Array.isArray(rec.targets)) ? rec.targets : []; }
  function hasTarget(rec, zoneId) { return targetsOf(rec).indexOf(zoneId) >= 0; }
  function thinningStrength(state, zoneId) {
    var r = fundedRec(state, 'forest_thinning');
    if (!r || !r.strength) return 0;
    return clamp01(r.strength[zoneId]);
  }
  function eachZoneCell(zone, fn) {
    if (!zone || !zone.cells) return;
    var cells = zone.cells, n = cells.length;
    for (var k = 0; k < n; k++) fn(cells[k] | 0);
  }
  function seasonOk(def, state) {
    var s = state && typeof state.season === 'number' ? state.season : 0;
    return !def.seasonsAllowed || def.seasonsAllowed.indexOf(s) >= 0;
  }
  function seasonNames(def) {
    return (def.seasonsAllowed || ALL_SEASONS).map(function (s) { return C.SEASONS[s]; }).join(' or ');
  }

  /* ------------------------------------------------------------------ canFund */
  function canFund(state, world, id, targetZoneId) {
    var def = BY_ID[id];
    if (!def) return { ok: false, reason: 'Unknown project "' + id + '".' };
    if (!state) return { ok: false, reason: 'No game state.' };
    ensure(state);
    if (!seasonOk(def, state)) return { ok: false, reason: def.name + ' can only be scheduled in ' + seasonNames(def) + '.' };
    var rec = fundedRec(state, id);
    var level = rec ? (rec.level | 0) : 0;
    if (!def.repeatable && level >= def.maxLevel) {
      return { ok: false, reason: def.maxLevel > 1 ? 'Already at maximum level (' + def.maxLevel + ').' : 'Already funded.' };
    }
    if (isZoneProject(def)) {
      if (targetZoneId == null) return { ok: false, reason: 'Choose a ' + def.targetType + ' target on the map first.' };
      var zone = zoneById(world, targetZoneId);
      if (!zone || zone.type !== def.targetType) return { ok: false, reason: 'Target must be a ' + def.targetType + ' zone.' };
      if (id === 'forest_thinning') {
        var str = thinningStrength(state, targetZoneId);
        if (str >= def.effects.refundableBelowStrength) return { ok: false, reason: zone.name + ' was thinned recently (treatment ' + Math.round(str * 100) + '% effective); wait until it fades.' };
      } else if (id === 'prescribed_burn') {
        if (state.projects.pendingBurn) return { ok: false, reason: 'A burn is already scheduled in ' + zoneName(world, state.projects.pendingBurn.zoneId) + ' this season.' };
        if (state.fire && state.fire.activeFire) return { ok: false, reason: 'No prescribed burns while a wildfire is active.' };
      } else if (hasTarget(rec, targetZoneId)) {
        return { ok: false, reason: zone.name + ' already has this project.' };
      }
    }
    var cost = costFor(def, level + 1);
    var budget = num(state.budget, 0);
    if (budget + 1e-9 < cost) {
      return { ok: false, reason: 'Needs ' + C.fmt.money(cost) + '; only ' + C.fmt.money(budget) + ' left this year.' };
    }
    return { ok: true, reason: '', costM: cost };
  }

  /* ------------------------------------------------------------------ fund */
  function fund(state, world, id, targetZoneId, rng) {
    var chk = canFund(state, world, id, targetZoneId);
    if (!chk.ok) return { ok: false, text: chk.reason };
    var def = BY_ID[id];
    var p = ensure(state);
    var cost = chk.costM;
    state.budget = Math.max(0, round1(num(state.budget, 0) - cost));

    var rec = p.funded[id];
    if (!rec) rec = p.funded[id] = { level: 0, targets: [], turnFunded: state.turn | 0 };
    if (!Array.isArray(rec.targets)) rec.targets = [];
    rec.turnFunded = state.turn | 0;
    var zone = isZoneProject(def) ? zoneById(world, targetZoneId) : null;
    var text = '';

    switch (id) {
      case 'forest_thinning': {
        if (!rec.strength) rec.strength = {};
        var cellsTreated = 0, before = 0, after = 0;
        if (world && world.fuel) {
          eachZoneCell(zone, function (i) {
            if (i < 0 || i >= world.fuel.length) return;
            before += world.fuel[i];
            world.fuel[i] = clamp01(world.fuel[i] * def.effects.fuelMultiplier);
            after += world.fuel[i];
            cellsTreated++;
          });
        }
        rec.strength[targetZoneId] = def.effects.strength;
        if (!hasTarget(rec, targetZoneId)) rec.targets.push(targetZoneId);
        rec.level = rec.targets.length;
        var acres = Math.round(C.cellsToAcres(cellsTreated));
        text = zone.name + ' thinned (' + acres.toLocaleString() + ' acres): fuel ' + (cellsTreated ? Math.round(100 * before / cellsTreated) : '?') + '% → ' + (cellsTreated ? Math.round(100 * after / cellsTreated) : '?') + '%.';
        break;
      }
      case 'prescribed_burn': {
        p.pendingBurn = { zoneId: targetZoneId, turn: state.turn | 0 };
        rec.level = (rec.level | 0) + 1;
        rec.targets.push(targetZoneId);
        text = 'Burn plan filed for ' + zone.name + '; lights at ' + C.SEASONS[state.season | 0] + '\'s end.';
        break;
      }
      case 'wetland': {
        state.flags.wetlandRestored = true;
        if (world && world.habitat) eachZoneCell(zone, function (i) { if (i >= 0 && i < world.habitat.length) world.habitat[i] = clamp01(world.habitat[i] + def.effects.habitatBonus); });
        rec.targets.push(targetZoneId); rec.level = rec.targets.length;
        text = 'Beaver-dam analogs and willows in at ' + zone.name + '.';
        break;
      }
      case 'home_hardening': {
        rec.targets.push(targetZoneId); rec.level = rec.targets.length;
        text = zone.name + ' hardened: Class A roofs, ember vents, cleared zones.';
        break;
      }
      case 'fuel_break': {
        rec.targets.push(targetZoneId); rec.level = rec.targets.length;
        var edge = 0;
        if (world && world.fuel && world.land && zone && zone.bbox) {
          var LAND = C.LAND, b = zone.bbox, m = 2;
          for (var y = Math.max(0, b.y0 - m); y <= Math.min(C.N - 1, b.y1 + m); y++) {
            for (var x = Math.max(0, b.x0 - m); x <= Math.min(C.N - 1, b.x1 + m); x++) {
              var i = C.idx(x, y), l = world.land[i];
              if (l === LAND.FOREST || l === LAND.SHRUB) { world.fuel[i] = clamp01(world.fuel[i] * def.effects.edgeFuelMultiplier); edge++; }
            }
          }
        }
        text = 'Fuel break rings ' + zone.name + (edge ? ': ' + Math.round(C.cellsToAcres(edge)) + ' edge acres thinned' : '') + '.';
        break;
      }
      case 'wildlife_corridor': {
        rec.level = 1;
        if (world && world.habitat && world.land) {
          var LND = C.LAND;
          for (var k = 0; k < world.habitat.length; k++) {
            var lk = world.land[k];
            if (lk === LND.SHRUB || lk === LND.RIPARIAN) world.habitat[k] = clamp01(world.habitat[k] + def.effects.habitatBonus);
          }
        }
        text = 'Fencing and underpass reconnect elk winter range.';
        break;
      }
      case 'mussel_inspection': {
        rec.level = 1; state.flags.musselInspection = true;
        text = 'Inspection stations now check every trailered boat.';
        break;
      }
      case 'streamgages': {
        rec.level = 1; if (state.climate) state.climate.uncertainty = def.effects.uncertainty;
        text = 'Streamgages and SNOTEL online; forecast uncertainty ±5%.';
        break;
      }
      default: {
        rec.level = (rec.level | 0) + 1;
        text = def.name + (def.maxLevel > 1 ? ' L' + rec.level : '') + ' funded: ' + C.fmt.money(cost) + '.';
      }
    }
    bump(state);
    if (WS.State && typeof WS.State.log === 'function') { try { WS.State.log(state, text, 'good'); } catch (e) { /* ignore */ } }
    return { ok: true, text: text, costM: cost };
  }

  /* ------------------------------------------------------------------ effects (memoised) */
  var cache = { state: null, turn: -1, rev: -1, value: null };
  function defaults() {
    return {
      sensorCoverage: 0, irrigationEfficiency: 0, leakReduction: 0, thinnedZones: {}, fuelBreakZones: {}, hardenedZones: {},
      reservoirCapacityBonus: 0, multiLevelIntake: false, rainCaptureAF: 0, wetlandRestored: false, shelters: false,
      warningSystem: false, outreach: false, treatment: false, stockpileBonus: 0, musselInspection: false, wildlifeCorridor: false, upkeepM: 0
    };
  }
  function compute(state) {
    var e = defaults();
    if (!state) return e;
    var p = ensure(state), f = p.funded, flags = state.flags || {};
    var lvl = function (id) { return f[id] ? (f[id].level | 0) : 0; };
    e.sensorCoverage = lvl('streamgages') > 0 ? 1 : 0;
    e.irrigationEfficiency = C.clamp(Math.min(3, lvl('irrigation')) * BY_ID.irrigation.effects.irrigationEfficiencyPerLevel, 0, 0.36);
    e.leakReduction = C.clamp(Math.min(3, lvl('leak_detection')) * BY_ID.leak_detection.effects.leakReductionPerLevel, 0, 0.18);
    var th = f.forest_thinning;
    if (th && th.strength) {
      Object.keys(th.strength).forEach(function (z) { var s = clamp01(th.strength[z]); if (s > 0) e.thinnedZones[z] = s; });
    }
    targetsOf(f.fuel_break).forEach(function (z) { e.fuelBreakZones[z] = true; });
    targetsOf(f.home_hardening).forEach(function (z) { e.hardenedZones[z] = true; });
    e.reservoirCapacityBonus = lvl('reservoir_upgrade') >= 1 ? BY_ID.reservoir_upgrade.effects.capacityBonusL1 : 0;
    e.multiLevelIntake = lvl('reservoir_upgrade') >= 2;
    e.rainCaptureAF = C.clamp(Math.min(2, lvl('rain_capture')) * BY_ID.rain_capture.effects.rainCaptureAFPerLevel, 0, 900);
    e.wetlandRestored = lvl('wetland') > 0 || !!flags.wetlandRestored;
    e.shelters = lvl('shelters') > 0;
    e.warningSystem = lvl('warning_system') > 0;
    e.outreach = lvl('outreach') > 0;
    e.treatment = lvl('treatment') > 0;
    e.stockpileBonus = lvl('stockpile') > 0 ? BY_ID.stockpile.effects.freePlacements : 0;
    e.musselInspection = lvl('mussel_inspection') > 0 || !!flags.musselInspection;
    e.wildlifeCorridor = lvl('wildlife_corridor') > 0;
    var up = 0;
    Object.keys(f).forEach(function (id) { var d = BY_ID[id]; if (d && f[id] && (f[id].level | 0) > 0) up += num(d.upkeepM, 0); });
    e.upkeepM = round1(up);
    return e;
  }
  function effects(state) {
    if (!state) return defaults();
    var p = ensure(state);
    var turn = state.turn | 0, rev = p._rev | 0;
    if (cache.state === state && cache.turn === turn && cache.rev === rev && cache.value) return cache.value;
    var v = compute(state);
    cache.state = state; cache.turn = turn; cache.rev = rev; cache.value = v;
    return v;
  }

  /* ------------------------------------------------------------------ tick (each Winter) */
  function tick(state, world) {
    var out = { upkeepM: 0, shortfallM: 0, expired: [], text: [] };
    if (!state) return out;
    var p = ensure(state), f = p.funded;
    var e = compute(state);
    var upkeep = num(e.upkeepM, 0);
    if (upkeep > 0) {
      var budget = num(state.budget, 0);
      var paid = Math.min(budget, upkeep);
      state.budget = Math.max(0, round1(budget - paid));
      out.upkeepM = round1(paid);
      out.shortfallM = round1(upkeep - paid);
      if (out.shortfallM > 0) {
        state.flags.upkeepShortfall = round1(num(state.flags.upkeepShortfall, 0) + out.shortfallM);
        // outreach is the first program cut when money runs out
        if (f.outreach && (f.outreach.level | 0) > 0) { f.outreach.level = 0; out.expired.push('outreach'); out.text.push('Outreach lapsed: upkeep unpaid.'); }
      }
      out.text.push('Upkeep charged: ' + C.fmt.money(out.upkeepM) + '.');
    }
    var th = f.forest_thinning;
    if (th && th.strength) {
      var decay = BY_ID.forest_thinning.effects.decayPerYear;
      Object.keys(th.strength).forEach(function (z) {
        var s = clamp01(th.strength[z]) - decay;
        if (s <= 0.005) {
          delete th.strength[z];
          var zi = Number(z); var idx = th.targets ? th.targets.indexOf(zi) : -1; if (idx >= 0) th.targets.splice(idx, 1);
          out.expired.push('forest_thinning:' + z);
          out.text.push('Regrowth erased thinning in ' + (world ? zoneName(world, zi) : 'zone ' + z) + '.');
        } else th.strength[z] = round1(s);
      });
      th.level = th.targets ? th.targets.length : 0;
    }
    if (f.prescribed_burn && p.pendingBurn && (state.turn | 0) - (p.pendingBurn.turn | 0) > 1) {
      p.pendingBurn = null; out.text.push('Stale burn plan cancelled.');
    }
    bump(state);
    return out;
  }

  /* ------------------------------------------------------------------ listFor (UI) */
  function listFor(state, world) {
    return LIST.map(function (def) {
      var rec = fundedRec(state, def.id);
      var level = rec ? (rec.level | 0) : 0;
      var targets = zonesFor(world, def).map(function (z) {
        var fundedHere = def.id === 'forest_thinning' ? thinningStrength(state, z.id) > 0 :
          def.id === 'prescribed_burn' ? !!(state && state.projects && state.projects.pendingBurn && state.projects.pendingBurn.zoneId === z.id) :
          hasTarget(rec, z.id);
        var chk = canFund(state, world, def.id, z.id);
        return { zoneId: z.id, name: z.name || ('Zone ' + z.id), funded: fundedHere, canFund: chk.ok, reason: chk.reason, strength: def.id === 'forest_thinning' ? thinningStrength(state, z.id) : undefined };
      });
      var chk;
      if (isZoneProject(def)) {
        var firstOk = null;
        for (var i = 0; i < targets.length; i++) if (targets[i].canFund) { firstOk = targets[i]; break; }
        chk = firstOk ? { ok: true, reason: '' } : (targets.length ? { ok: false, reason: targets[0].reason } : { ok: false, reason: 'No ' + def.targetType + ' zones on this map.' });
      } else chk = canFund(state, world, def.id, null);
      var nextLevel = Math.min(def.repeatable ? 1 : def.maxLevel, level + 1);
      return {
        def: def, funded: level > 0 || (def.id === 'prescribed_burn' && !!(state && state.projects && state.projects.pendingBurn)),
        level: level, canFund: chk.ok, reason: chk.reason || '', costM: costFor(def, nextLevel), targets: targets
      };
    });
  }

  WS.Projects = {
    LIST: LIST,
    byId: function (id) { return BY_ID[id] || null; },
    costFor: function (id, level) { var d = BY_ID[id]; return d ? costFor(d, level) : 0; },
    canFund: canFund,
    fund: fund,
    effects: effects,
    tick: tick,
    listFor: listFor
  };
})();
