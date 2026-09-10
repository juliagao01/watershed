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
      id: 'streamgages', name: 'Streamgage & Snow Telemetry Network', icon: '📡', category: 'monitor',
      costM: 1.2, upkeepM: 0.1, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Real-time stream and snow measurements; sharpens every water forecast.',
      detail: 'Streamgages measure stage and discharge continuously and report every 15 minutes. Colorado\'s gage network is run jointly by the USGS and the Colorado Division of Water Resources, whose water commissioners use it to administer water rights in real time. Pairing gages with SNOTEL snow-telemetry sites narrows the runoff forecast that every spring allocation decision depends on.',
      tradeoff: 'Better data does not add a drop of water; it only tells you sooner how little you have.',
      effects: { sensorCoverage: 1, uncertainty: 0.05 }
    },
    {
      id: 'irrigation', name: 'Irrigation Modernization', icon: '🚜', category: 'water',
      costM: 2.4, upkeepM: 0, maxLevel: 3, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Sprinklers, drip and lined ditches cut farm diversions per acre (+12% efficiency per level).',
      detail: 'Agriculture accounts for roughly 85 to 90 percent of the water diverted in Colorado, much of it through unlined ditches and flood irrigation. Converting to sprinklers or drip, lining ditches and automating headgates cuts diversions per acre, and the Colorado Water Conservation Board and NRCS EQIP cost-share these upgrades. Because return flows from inefficient irrigation feed downstream users and wetlands, Colorado water courts treat saved water carefully under the no-injury rule.',
      tradeoff: 'Higher efficiency shrinks the return flows that downstream ditches and riparian wetlands quietly depend on.',
      effects: { irrigationEfficiencyPerLevel: 0.12 }
    },
    {
      id: 'leak_detection', name: 'Leak Detection & Main Repair', icon: '🔧', category: 'water',
      costM: 1.6, upkeepM: 0.05, maxLevel: 3, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Acoustic loggers and district metering cut non-revenue water (6% household demand per level).',
      detail: 'Aging cast-iron and asbestos-cement mains, freeze-thaw cycles and shifting clay soils make Front Range and mountain systems leaky; non-revenue water of 10 to 20 percent is common in Colorado utilities. Acoustic leak loggers, district metering and satellite leak surveys find leaks before they become main breaks. Each program level trims household demand and defers expensive emergency repairs.',
      tradeoff: 'Finding leaks obligates you to fix them, and pipe replacement quickly eats the budget the savings free up.',
      effects: { leakReductionPerLevel: 0.06 }
    },
    {
      id: 'forest_thinning', name: 'Forest Thinning', icon: '🌲', category: 'fire',
      costM: 2.8, upkeepM: 0, maxLevel: 6, targetType: 'forest', seasonsAllowed: ALL_SEASONS,
      summary: 'Mechanical thinning in one forest sector: fuel x0.55 now, effect fades over ~8 years.',
      detail: 'Mechanical thinning and mastication remove ladder fuels and small-diameter trees so a crown fire drops to the ground where crews can catch it. In Colorado this work is coordinated by the Colorado State Forest Service and the U.S. Forest Service, and partnerships such as Denver Water\'s From Forests to Faucets pay for treatments in the watersheds that feed municipal reservoirs. Treatments lose effectiveness as regrowth returns, typically within 8 to 12 years.',
      tradeoff: 'It costs roughly $1,000 to $3,000 per acre, creates slash that must itself be burned or hauled, and the effect fades unless maintained.',
      effects: { fuelMultiplier: 0.55, strength: 1.0, decayPerYear: 0.12, refundableBelowStrength: 0.6 }
    },
    {
      id: 'prescribed_burn', name: 'Prescribed Burn', icon: '🔥', category: 'fire',
      costM: 0.6, upkeepM: 0, maxLevel: 99, targetType: 'forest', seasonsAllowed: [1, 3], repeatable: true,
      summary: 'Schedule a broadcast burn in one sector this Spring or Fall; executed at season end.',
      detail: 'Prescribed fire is the cheapest way to remove surface fuels across a whole sector and mimics the frequent low-intensity fires that ponderosa pine forests evolved with. Burns need a written burn plan, a smoke permit from the Colorado Department of Public Health and Environment, and a narrow weather window in spring or fall; the 2012 Lower North Fork escape led Colorado to tighten certification of burn bosses. Fuel drops sharply where the burn holds.',
      tradeoff: 'A small share of burns escape, smoke settles on the town, and residents may push back hard.',
      effects: { fuelMultiplier: 0.4, escapeChanceBase: 0.04 }
    },
    {
      id: 'reservoir_upgrade', name: 'Reservoir Upgrade', icon: '🏗️', category: 'water',
      costM: 5.0, costs: [5.0, 4.0], upkeepM: 0.1, maxLevel: 2, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Level 1: raise the dam for +15% capacity. Level 2: multi-level intake tower for clean-water selection.',
      detail: 'Raising the dam crest or its spillway gates adds storage without a new dam site, as Denver Water is doing with the Gross Reservoir expansion. A second stage adds a multi-level intake tower so operators can draw from whichever depth is coldest and clearest, the tool Fort Collins and Greeley leaned on when ash from the 2020 Cameron Peak Fire fouled the Cache la Poudre. Both stages must pass Colorado Dam Safety review.',
      tradeoff: 'Expensive and slow, and a bigger pool inundates riparian shoreline and adds no water in a dry year.',
      effects: { capacityBonusL1: 0.15, multiLevelIntakeL2: true }
    },
    {
      id: 'rain_capture', name: 'Rain Capture & Green Streets', icon: '🌧️', category: 'water',
      costM: 1.5, upkeepM: 0, maxLevel: 2, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Rain barrels, detention basins and permeable pavement: +450 AF/yr per level, less street flooding.',
      detail: 'Colorado only legalized residential rain barrels in 2016 (two barrels, 110 gallons total) because captured rain was historically owed to downstream water rights. Larger projects such as green streets, detention basins and permeable pavement slow stormwater, recharge soils and reduce urban flooding under the state\'s stormwater and augmentation rules. The acre-foot gain is modest but shaves peak summer demand.',
      tradeoff: 'Small yields for the cost, and larger capture still needs augmentation plans to protect downstream rights.',
      effects: { rainCaptureAFPerLevel: 450, floodDamageReduction: 0.3 }
    },
    {
      id: 'home_hardening', name: 'Home Hardening & Defensible Space', icon: '🏠', category: 'fire',
      costM: 1.8, upkeepM: 0, maxLevel: 4, targetType: 'neighborhood', seasonsAllowed: ALL_SEASONS,
      summary: 'Class A roofs, ember-resistant vents and a clear 0-5 ft zone in one neighborhood.',
      detail: 'Most homes ignite from embers rather than flames, so hardening focuses on Class A roofs, ember-resistant vents, and keeping the 0 to 5 foot zone around the house free of mulch, wood fences and shrubs. Colorado\'s Wildfire Resilient Homes grants and Colorado State Forest Service defensible-space guidance (Zones 1 to 3) fund this in the wildland-urban interface, a lesson driven home when the 2021 Marshall Fire spread house to house. Hardened neighborhoods lose far fewer structures and are easier to defend.',
      tradeoff: 'Homeowners must keep up the work every year, and some resist replacing beloved landscaping and wood decks.',
      effects: { structureLossMultiplier: 0.27, spreadMultiplier: 0.36 }
    },
    {
      id: 'fuel_break', name: 'Shaded Fuel Break', icon: '🪓', category: 'fire',
      costM: 0.9, upkeepM: 0.05, maxLevel: 4, targetType: 'neighborhood', seasonsAllowed: ALL_SEASONS,
      summary: 'A 100-300 ft thinned strip around one neighborhood where crews can hold a fire.',
      detail: 'A shaded fuel break is a strip 100 to 300 feet wide where trees are thinned and brush removed along a ridgeline, road or subdivision edge, giving crews a place to hold a fire. Colorado\'s Forest Restoration and Wildfire Risk Mitigation grants and county Community Wildfire Protection Plans prioritize breaks around wildland-urban interface neighborhoods. Breaks do not stop wind-driven ember showers but they shorten flame lengths at the edge of town.',
      tradeoff: 'Ember-driven fires jump breaks, and the strip needs re-treatment every few years.',
      effects: { edgeFuelMultiplier: 0.6, suppressionBonus: true }
    },
    {
      id: 'wetland', name: 'Floodplain Wetland Restoration', icon: '🦫', category: 'flood',
      costM: 2.2, upkeepM: 0.05, maxLevel: 1, targetType: 'wetland', seasonsAllowed: ALL_SEASONS,
      summary: 'Beaver-dam analogs and willow planting: traps sediment, cuts flood peaks below the dam.',
      detail: 'Restoring the floodplain wetland reconnects the creek to its meadow: beaver-dam analogs, plugging old drainage ditches and re-planting willows spread flood pulses out, slow them, and trap sediment. Colorado\'s post-fire recovery work on the Cache la Poudre and Big Thompson uses these low-tech, process-based methods. After a fire, a healthy wetland is a sediment trap that protects the intake below it.',
      tradeoff: 'Restored wetlands soak up water that ranchers and downstream rights holders count on, and take several years to mature.',
      effects: { sedimentTrap: 0.35, peakAttenuation: 0.3, habitatBonus: 0.2 }
    },
    {
      id: 'shelters', name: 'Clean-Air & Evacuation Shelters', icon: '🏫', category: 'community',
      costM: 1.4, upkeepM: 0.1, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'HEPA-filtered shelters with backup power for smoke days, fires and floods.',
      detail: 'Wildfire smoke and post-fire floods hit the elderly, children and outdoor workers first; a clean-air shelter is a school gym or community center with HEPA filtration, backup power and cots. Colorado\'s 2020 fire season pushed Front Range air quality into the very unhealthy range for weeks, and the state health department now issues smoke advisories that point to such shelters. The same buildings double as evacuation sites during fire and flood.',
      tradeoff: 'The building sits mostly unused between emergencies while staff and filters still cost money.',
      effects: { smokeHarmReduction: 0.7 }
    },
    {
      id: 'warning_system', name: 'Flood & Fire Warning System', icon: '🚨', category: 'flood',
      costM: 1.0, upkeepM: 0.1, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Rain gages on the scar, stream sensors and mass-notification alerts for evacuations.',
      detail: 'Post-fire debris flows can arrive within minutes of intense rain over a burn scar. Rain gages on the scar, stream sensors and a mass-notification system with Wireless Emergency Alerts let the county issue evacuation orders in time, the lesson of the 2013 Front Range floods and the 2021 Glenwood Canyon debris flows that closed I-70. The same system carries evacuation orders during wildfire.',
      tradeoff: 'False alarms erode trust quickly, and residents who opt out of alerts get no benefit.',
      effects: { injuryRiskReduction: 0.8, earlyWarning: true }
    },
    {
      id: 'outreach', name: 'Conservation & Community Outreach', icon: '📣', category: 'community',
      costM: 0.5, upkeepM: 0.5, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Turf rebates, watering rules and public meetings; ongoing annual program.',
      detail: 'Water-saving programs such as turf-replacement rebates, WaterSense fixture rebates, watering-day rules and school programs reduce peak summer demand 10 to 20 percent in Colorado utilities like Aurora and Colorado Springs, and the state\'s 2024 limits on new non-functional turf push the same way. Public meetings on fire policy and prescribed burns build the trust that makes hard decisions survivable.',
      tradeoff: 'It costs money every year, and the savings fade within a season or two if the program lapses.',
      effects: { demandReduction: 0.08, trustPerYear: 1 }
    },
    {
      id: 'treatment', name: 'Water Treatment Upgrade', icon: '💧', category: 'water',
      costM: 3.5, upkeepM: 0.15, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Coagulation, activated carbon and flexible intake operations for ash-laden water.',
      detail: 'Wildfire ash brings dissolved organic carbon, manganese, nutrients and fine sediment that clog filters and form disinfection by-products. After the 2020 fires, Fort Collins and Greeley added coagulation, powdered activated carbon and more flexible intake operations; Denver Water made similar upgrades after the 1996 Buffalo Creek and 2002 Hayman fires. Upgrades shorten outages and lower the odds of a boil-water notice.',
      tradeoff: 'High capital and operating cost, and even a good plant must close its intake when turbidity spikes past design.',
      effects: { contaminationDecayBonus: 0.25, outageReduction: 0.5 }
    },
    {
      id: 'stockpile', name: 'Emergency Erosion Stockpile', icon: '📦', category: 'flood',
      costM: 0.7, upkeepM: 0, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Straw, wattles, seed and mulch on hand: +3 free barrier/mulch placements in flood prep.',
      detail: 'Straw bales, wattles, coir logs, seed and mulch must be on the ground within days of a fire, before the first monsoon storm hits the scar. Colorado counties and the NRCS Emergency Watershed Protection program pre-position these materials so crews can treat slopes immediately, as they did after the Cameron Peak and East Troublesome fires.',
      tradeoff: 'Materials degrade in storage, and the money is tied up whether or not a fire ever comes.',
      effects: { freePlacements: 3 }
    },
    {
      id: 'mussel_inspection', name: 'Boat Inspection Stations', icon: '🛥️', category: 'water',
      costM: 0.8, upkeepM: 0.3, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Inspect and decontaminate every trailered boat to keep zebra and quagga mussels out.',
      detail: 'Zebra and quagga mussels foul intake pipes, screens and dam gates, and once established they cannot be removed. Colorado Parks and Wildlife\'s Aquatic Nuisance Species program has inspected boats since 2008; adult zebra mussels were found at Highline Lake in 2022 and in the Colorado River near Grand Junction in 2024. Inspection and decontamination stations at every ramp are the only proven defense.',
      tradeoff: 'Ramp lines annoy boaters, and staffing every launch each summer is a recurring cost.',
      effects: { musselRiskMultiplier: 0.1 }
    },
    {
      id: 'wildlife_corridor', name: 'Wildlife Corridor & Fencing', icon: '🦌', category: 'community',
      costM: 0.9, upkeepM: 0, maxLevel: 1, targetType: 'global', seasonsAllowed: ALL_SEASONS,
      summary: 'Wildlife-friendly fencing, a road underpass and habitat plantings on the elk winter range.',
      detail: 'Elk and mule deer move between summer forest and winter range on the shrub benches, crossing roads and fences along the way; wildlife-friendly fencing, an underpass and habitat plantings keep those routes open. Colorado\'s 2019 executive order on big-game migration corridors and Colorado Parks and Wildlife\'s corridor mapping fund exactly this kind of work. Connected habitat recovers faster after fire.',
      tradeoff: 'A small budget item, but it limits where you can build or farm along the corridor.',
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
        text = 'Crews thinned ' + zone.name + ' (' + acres.toLocaleString() + ' acres); fuel loading fell from ' +
          (cellsTreated ? (before / cellsTreated).toFixed(2) : '?') + ' to ' + (cellsTreated ? (after / cellsTreated).toFixed(2) : '?') + '.';
        break;
      }
      case 'prescribed_burn': {
        p.pendingBurn = { zoneId: targetZoneId, turn: state.turn | 0 };
        rec.level = (rec.level | 0) + 1;
        rec.targets.push(targetZoneId);
        text = 'Burn plan filed for ' + zone.name + '. Crews will light it at the end of this ' + C.SEASONS[state.season | 0] + ' if the weather window holds.';
        break;
      }
      case 'wetland': {
        state.flags.wetlandRestored = true;
        if (world && world.habitat) eachZoneCell(zone, function (i) { if (i >= 0 && i < world.habitat.length) world.habitat[i] = clamp01(world.habitat[i] + def.effects.habitatBonus); });
        rec.targets.push(targetZoneId); rec.level = rec.targets.length;
        text = 'Beaver-dam analogs and willow plantings went in at ' + zone.name + '. The meadow will spread and slow the next flood pulse.';
        break;
      }
      case 'home_hardening': {
        rec.targets.push(targetZoneId); rec.level = rec.targets.length;
        text = zone.name + ' now has Class A roofs, ember-resistant vents and cleared 0-5 ft zones on most homes.';
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
        text = 'A shaded fuel break now rings ' + zone.name + (edge ? ' (' + Math.round(C.cellsToAcres(edge)) + ' acres of edge thinned)' : '') + '.';
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
        text = 'Wildlife-friendly fencing and an underpass keep the elk winter range connected to the forest.';
        break;
      }
      case 'mussel_inspection': {
        rec.level = 1; state.flags.musselInspection = true;
        text = 'Inspection and decontamination stations now check every trailered boat at the ramps.';
        break;
      }
      case 'streamgages': {
        rec.level = 1; if (state.climate) state.climate.uncertainty = def.effects.uncertainty;
        text = 'New streamgages and SNOTEL telemetry are online; runoff forecasts are far sharper.';
        break;
      }
      default: {
        rec.level = (rec.level | 0) + 1;
        text = def.name + (def.maxLevel > 1 ? ' level ' + rec.level : '') + ' funded for ' + C.fmt.money(cost) + '.';
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
        if (f.outreach && (f.outreach.level | 0) > 0) { f.outreach.level = 0; out.expired.push('outreach'); out.text.push('Outreach program lapsed: upkeep could not be paid.'); }
      }
      out.text.push('Project upkeep charged: ' + C.fmt.money(out.upkeepM) + '.');
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
          out.text.push('Regrowth has erased the thinning treatment in ' + (world ? zoneName(world, zi) : 'zone ' + z) + '.');
        } else th.strength[z] = round1(s);
      });
      th.level = th.targets ? th.targets.length : 0;
    }
    if (f.prescribed_burn && p.pendingBurn && (state.turn | 0) - (p.pendingBurn.turn | 0) > 1) {
      p.pendingBurn = null; out.text.push('A stale prescribed-burn plan was cancelled.');
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
