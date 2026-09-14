/* Watershed — Advisors. Six characters with distinct priorities give recommendations grounded in the current state numbers.
   Exports WS.Advisors = { CHARACTERS, TOPICS, getRecommendations(state, world, topic), byId(id) }. Runs in Node (no DOM). */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C;
  var fmt = C.fmt;
  var H = C.HYDRO;

  // ---------------------------------------------------------------- characters
  var CHARACTERS = [
    { id: 'dolores', name: 'Capt. Dolores Reyes', role: 'Wildland Fire Captain', color: '#d9532b', avatarEmoji: '🚒',
      face: { skin: 's4', hair: 'bun', hairColor: 'h1', eyes: 'almond', brows: 'straight', mouth: 'neutral', facialHair: 'none', glasses: 'none', hat: 'helmet', outfit: 'o4', accessory: 'radio' },
      bio: 'Twenty-two seasons on engines and hand crews. Blunt, operational, allergic to wishful thinking. Measures every plan in crew-hours, fuel loads and the distance from a fire station.' },
    { id: 'walt', name: 'Walt Jensen', role: 'Rancher, Lazy J', color: '#b9863c', avatarEmoji: '🤠',
      face: { skin: 's3', hair: 'short', hairColor: 'h5', eyes: 'narrow', brows: 'straight', mouth: 'neutral', facialHair: 'moustache', glasses: 'none', hat: 'widebrim', outfit: 'o2', accessory: 'none' },
      bio: 'Third-generation cattle and hay operator holding a decree older than the town. Pragmatic about senior water rights, hay prices and what a dry summer does to a herd. Distrusts studies that cost more than ditches.' },
    { id: 'naomi', name: 'Naomi Whitehorse', role: 'Tribal Water Representative', color: '#7b4fa8', avatarEmoji: '🪶',
      face: { skin: 's3', hair: 'long', hairColor: 'h1', eyes: 'almond', brows: 'soft', mouth: 'smile', facialHair: 'none', glasses: 'none', hat: 'none', outfit: 'o3', accessory: 'scarf' },
      bio: 'Represents a Ute-descended community whose reserved water right predates every other decree in the valley and was quantified in a treaty-era settlement. Speaks of the river as a relative with obligations flowing both ways. Written respectfully and generally; she speaks for no real tribe.' },
    { id: 'priya', name: 'Dr. Priya Natarajan', role: 'Hydrologist', color: '#2f7fb8', avatarEmoji: '📈',
      face: { skin: 's4', hair: 'bun', hairColor: 'h1', eyes: 'round', brows: 'arched', mouth: 'smile', facialHair: 'none', glasses: 'round', hat: 'none', outfit: 'o1', accessory: 'clipboard' },
      bio: 'Runs the basin water-supply forecast. Cites measurements first, models second, and always says how uncertain the number is. Would rather fund a streamgage than an opinion.' },
    { id: 'marcus', name: 'Marcus Lee', role: 'Resident and Parent, Marshall Heights', color: '#3f9a6a', avatarEmoji: '🏡',
      face: { skin: 's4', hair: 'short', hairColor: 'h1', eyes: 'round', brows: 'soft', mouth: 'grin', facialHair: 'stubble', glasses: 'none', hat: 'none', outfit: 'o1', accessory: 'none' },
      bio: 'Two kids at the elementary school, a mortgage in the wildland-urban interface and a water bill he reads line by line. Cares about smoke days, school closures and whether the lawn ban is really necessary.' },
    { id: 'ana', name: 'Dr. Ana Ortiz', role: 'Wildlife Biologist', color: '#5a8a3a', avatarEmoji: '🦌',
      face: { skin: 's2', hair: 'ponytail', hairColor: 'h3', eyes: 'round', brows: 'soft', mouth: 'smile', facialHair: 'none', glasses: 'sun', hat: 'none', outfit: 'o3', accessory: 'binoculars' },
      bio: 'State wildlife biologist for the district. Counts elk on winter range, snorkels the creek for native cutthroat trout, and argues for instream flows and riparian habitat that have no lawyer of their own.' }
  ];
  var CHAR_BY_ID = {};
  CHARACTERS.forEach(function (c) { CHAR_BY_ID[c.id] = c; });

  var TOPICS = ['budget', 'allocation', 'prescribed_burn', 'fire_policy', 'flood', 'contamination', 'drought'];

  // ---------------------------------------------------------------- helpers
  function fin(v, d) { v = Number(v); return isFinite(v) ? v : (d == null ? 0 : d); }
  function obj(o) { return (o && typeof o === 'object') ? o : {}; }
  function arr(a) { return Array.isArray(a) ? a : []; }
  function money(m) { return fmt.money(fin(m)); }
  function af(v) { return fmt.af(fin(v)); }
  function pct(v) { return fmt.pct(fin(v)); }
  function num(v, d) { return fmt.num(fin(v), d); }
  function acres(v) { return Math.round(fin(v)).toLocaleString() + ' acres'; }

  /** Build an evidence series for `key` from state.history; synthesise from current when history is short. */
  function series(state, key, current) {
    var h = arr(obj(state).history), out = [], i, v;
    for (i = 0; i < h.length; i++) {
      v = h[i] ? Number(h[i][key]) : NaN;
      if (isFinite(v)) out.push(v);
    }
    current = fin(current);
    if (out.length < 2) {
      var base = out.length ? out[0] : current;
      out = [base, base, base, current];
    } else if (out[out.length - 1] !== current) {
      out.push(current);
    }
    if (out.length > 32) out = out.slice(out.length - 32);
    return out;
  }
  function evidence(state, key, label, unit, current, threshold) {
    var e = { label: label, unit: unit, series: series(state, key, current), current: fin(current) };
    if (threshold != null && isFinite(threshold)) e.threshold = Number(threshold);
    return e;
  }

  /** Mean fuel per forest zone from world.fuel (guarded). */
  function fuelByZone(world) {
    var res = { avg: 0, zones: [], worst: null, upstreamWorst: null };
    var w = obj(world), fuel = w.fuel, zones = arr(w.zones);
    if (!fuel || !fuel.length) return res;
    var total = 0, count = 0;
    zones.forEach(function (z) {
      if (!z || z.type !== 'forest') return;
      var cells = z.cells || [], s = 0, n = 0, i, f;
      for (i = 0; i < cells.length; i++) { f = fuel[cells[i]]; if (isFinite(f)) { s += f; n++; } }
      var avg = n ? s / n : 0;
      total += s; count += n;
      var rec = { id: z.id, name: z.name || ('Sector ' + z.id), avg: avg, cells: n, upstream: !!z.upstreamOfReservoir };
      res.zones.push(rec);
      if (!res.worst || avg > res.worst.avg) res.worst = rec;
      if (rec.upstream && (!res.upstreamWorst || avg > res.upstreamWorst.avg)) res.upstreamWorst = rec;
    });
    if (count) res.avg = total / count;
    else { var s2 = 0, n2 = 0; for (var i = 0; i < fuel.length; i++) if (fuel[i] > 0) { s2 += fuel[i]; n2++; } res.avg = n2 ? s2 / n2 : 0; }
    return res;
  }

  function meanOf(arrLike, filterArr, filterVal) {
    if (!arrLike || !arrLike.length) return NaN;
    var s = 0, n = 0;
    for (var i = 0; i < arrLike.length; i++) {
      if (filterArr && filterArr[i] !== filterVal) continue;
      if (isFinite(arrLike[i])) { s += arrLike[i]; n++; }
    }
    return n ? s / n : NaN;
  }

  function droughtLevel(label) {
    var m = /D([0-4])/.exec(String(label || ''));
    return m ? Number(m[1]) + 1 : 0; // None=0, D0=1 .. D4=5
  }

  function projectEffects(state) {
    try { if (WS.Projects && typeof WS.Projects.effects === 'function') return obj(WS.Projects.effects(state)); } catch (e) { /* ignore */ }
    return {};
  }

  function firstZoneName(world, type, fallback) {
    var zs = arr(obj(world).zones);
    for (var i = 0; i < zs.length; i++) if (zs[i] && zs[i].type === type && zs[i].name) return zs[i].name;
    return fallback;
  }

  /** Gather every number the advisors need, with defaults so nothing is ever undefined. */
  function context(state, world) {
    state = obj(state); world = obj(world);
    var cl = obj(state.climate), rv = obj(state.reservoir), wt = obj(state.water), fr = obj(state.fire), oc = obj(state.outcomes), st = obj(state.stats), fl = obj(state.flags);
    var effects = projectEffects(state);
    var capacity = fin(rv.capacityAF, H.RESERVOIR_CAPACITY_AF) * (1 + fin(effects.reservoirCapacityBonus));
    if (capacity <= 0) capacity = H.RESERVOIR_CAPACITY_AF;
    var storage = C.clamp(fin(rv.storageAF, 0), 0, capacity);
    var demands = obj(wt.demands), alloc = obj(wt.alloc), shortage = obj(wt.shortage), delivered = obj(wt.delivered);
    var totalDemand = 0; C.SECTORS.forEach(function (s) { totalDemand += fin(demands[s]); });
    var consumptive = fin(demands.households) + fin(demands.farms) + fin(demands.tribal) + fin(demands.downstream) + fin(demands.fire);
    var available = fin(wt.availableAF, Math.max(0, storage - H.RESERVOIR_DEAD_POOL_AF));
    var fires = arr(fr.fires);
    var lastFire = fires.length ? obj(fires[fires.length - 1]) : null;
    var upstreamAcres = 0; fires.forEach(function (f) { f = obj(f); if (f.upstream) upstreamAcres += fin(f.acres); });
    var fuel = fuelByZone(world);
    var burnMean = fin(meanOf(world.burn), 0);
    var scarCells = 0; if (world.burn && world.burn.length) for (var i = 0; i < world.burn.length; i++) if (world.burn[i] > 0.2) scarCells++;
    var cropHealth = meanOf(world.cropHealth, world.land, C.LAND.FARM);
    if (!isFinite(cropHealth)) { var hh = arr(state.history); cropHealth = hh.length ? fin(obj(hh[hh.length - 1]).cropHealth, 0.85) : 0.85; }
    var habitat = fin(meanOf(world.habitat), 0.5);
    var householdShort = fin(shortage.households) / Math.max(1, fin(demands.households));
    var farmShort = fin(shortage.farms) / Math.max(1, fin(demands.farms));
    var population = fin(state.population, H.BASE_POPULATION);
    var wuiName = firstZoneName(world, 'neighborhood', 'the WUI neighborhood');
    var farmName = firstZoneName(world, 'farm', 'the valley farms');
    var minFlowAF = H.MIN_FLOW_CFS * H.AF_PER_CFS_DAY * 91;
    var pendingStorm = obj(state.pendingStorm);
    return {
      state: state, world: world, effects: effects, flags: fl,
      season: fin(state.season), year: fin(state.year, 1), turn: fin(state.turn),
      budget: fin(state.budget), annualBudget: fin(state.annualBudget, 8.5), emergencyFund: fin(state.emergencyFund),
      storage: storage, capacity: capacity, storagePct: 100 * storage / capacity, deadPool: H.RESERVOIR_DEAD_POOL_AF,
      snowpackPct: fin(cl.snowpackPct, 100), swe: fin(cl.snowSWEin, H.AVG_SNOW_SWE_IN), precip: fin(cl.precipIn), tempAnom: fin(cl.tempAnomF),
      soil: fin(cl.soilMoisturePct, 45), fireDanger: C.clamp(fin(cl.fireDanger, 0.2), 0, 1), dangerLabel: cl.fireDangerLabel || 'Moderate',
      streamflow: fin(cl.streamflowCfs, 60), wind: fin(cl.windMph, 8), drought: cl.drought || 'None', droughtLevel: droughtLevel(cl.drought),
      uncertainty: fin(cl.uncertainty, 0.25),
      turbidity: C.clamp(fin(rv.turbidity), 0, 1), ash: C.clamp(fin(rv.ashContam), 0, 1), algae: C.clamp(fin(rv.algae), 0, 1),
      demands: demands, alloc: alloc, shortage: shortage, delivered: delivered, totalDemand: totalDemand, consumptive: consumptive, available: available,
      restriction: wt.restriction || 'none', householdShort: householdShort, farmShort: farmShort,
      outcomes: { W: fin(oc.W, 70), E: fin(oc.E, 65), P: fin(oc.P, 72), F: fin(oc.F, 68), T: fin(oc.T, 60) },
      policy: fr.policy || 'managed', seasonAcres: fin(fr.seasonAcres), totalAcres: fin(fr.totalAcres), structuresLost: fin(fr.structuresLost),
      fires: fires, lastFire: lastFire, upstreamAcres: upstreamAcres, smokeDays: fin(fr.smokeDays),
      fuel: fuel, burnMean: burnMean, scarAcres: C.cellsToAcres(scarCells), cropHealth: C.clamp(fin(cropHealth, 0.85), 0, 1), habitat: habitat,
      population: population, wuiName: wuiName, farmName: farmName, minFlowAF: minFlowAF,
      stats: { floodDamageM: fin(st.floodDamageM), sedimentTons: fin(st.sedimentTons), outageDays: fin(st.contaminationOutageDays), cropLossPct: fin(st.cropLossPct) },
      pendingStorm: pendingStorm, stormIn: fin(pendingStorm.intensityIn, 2.0), stormTurns: fin(pendingStorm.turnsUntil, 1)
    };
  }

  function rec(characterId, stance, headline, text, ev) {
    return { characterId: characterId, stance: stance, headline: headline, text: text, evidence: ev };
  }

  // ---------------------------------------------------------------- topics
  // Caps (tests/wordcaps.test.js): headline ≤ 6 words; text = ONE sentence ≤ 16 words carrying a number; evidence label ≤ 3 words.
  var TOPIC_FNS = {};

  TOPIC_FNS.budget = function (x) {
    var s = x.state, out = [];
    var worst = x.fuel.worst || { name: 'the upper forest', avg: x.fuel.avg };
    var thinned = obj(x.effects.thinnedZones);
    var worstTreated = worst.id != null && thinned[worst.id] > 0.2;
    out.push(rec('dolores', worst.avg > 0.6 && !worstTreated ? 'urge' : 'support',
      worst.avg > 0.6 ? 'Put money in the fuel' : 'Keep a WUI line item',
      (worst.avg > 0.6 && !worstTreated ? 'Fuel in ' + worst.name + ' is ' + num(worst.avg * 100) + '%; thinning it costs less than one suppression season.' : 'Fuel in ' + worst.name + ' is ' + num(worst.avg * 100) + '%, so next dollar hardens homes in ' + x.wuiName + '.'),
      evidence(s, 'fuelAvg', 'Forest fuel', 'index 0-1', x.fuel.avg, 0.6)));
    out.push(rec('walt', x.cropHealth < 0.7 || x.farmShort > 0.1 ? 'urge' : 'caution',
      x.cropHealth < 0.7 ? 'Ditches before dashboards' : 'No money for studies',
      'Crop health is ' + num(x.cropHealth * 100) + '% and farms went short ' + pct(x.farmShort * 100) + '; fund the ditch upgrades first.',
      evidence(s, 'cropHealth', 'Crop health', 'index 0-1', x.cropHealth, 0.7)));
    out.push(rec('naomi', x.effects.wetlandRestored ? 'support' : 'urge',
      x.effects.wetlandRestored ? 'Protect the restored ground' : 'Spend on the river',
      'The reservoir holds ' + pct(x.storagePct) + '; ' + (x.effects.wetlandRestored ? 'keep the wetland funded, it stores water in the ground.' : 'wetland restoration costs less than one flood repair.'),
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.capacity * 0.5)));
    out.push(rec('priya', x.uncertainty > 0.1 ? 'urge' : 'support',
      x.uncertainty > 0.1 ? 'Buy the measurement first' : 'Now fund storage and treatment',
      (x.uncertainty > 0.1 ? 'Forecast uncertainty is ±' + pct(x.uncertainty * 100) + ', an error bar of ' + af(x.available * x.uncertainty) + '; gauges shrink it to ±5%.' : 'With uncertainty at ±' + pct(x.uncertainty * 100) + ', the next dollar belongs in treatment or storage.'),
      evidence(s, 'snowpackPct', 'Snowpack', '%', x.snowpackPct, 100)));
    out.push(rec('marcus', x.effects.upkeepM > x.annualBudget * 0.25 ? 'caution' : 'support',
      x.effects.upkeepM > x.annualBudget * 0.25 ? 'Upkeep lands on my bill' : 'Fix leaks, warn families',
      'Upkeep is ' + money(x.effects.upkeepM) + ' a year on ' + Math.round(x.population).toLocaleString() + ' residents\' bills; leak detection pays for itself.',
      evidence(s, 'budget', 'Budget', '$M', x.budget, x.annualBudget)));
    out.push(rec('ana', x.habitat < 0.5 || x.turbidity > 0.3 ? 'urge' : 'support',
      'Habitat has no line item',
      'Habitat quality is ' + num(x.habitat * 100) + '% and ecosystem score ' + num(x.outcomes.E) + '; wetlands and corridors are cheap and buffer floods.',
      evidence(s, 'turbidity', 'Turbidity', 'index 0-1', x.turbidity, 0.3)));
    return out;
  };

  TOPIC_FNS.allocation = function (x) {
    var s = x.state, out = [];
    var farmAlloc = fin(x.alloc.farms, 1), tribalAlloc = fin(x.alloc.tribal, 1), wildAlloc = fin(x.alloc.wildlife, 1), fireAlloc = fin(x.alloc.fire, 1);
    var ratio = x.totalDemand > 0 ? x.available / x.totalDemand : 1;
    var farmAF = fin(x.demands.farms), tribalAF = fin(x.demands.tribal, H.TRIBAL_RIGHT_AF_YR / 4), fireAF = fin(x.demands.fire, 600);
    out.push(rec('walt', farmAlloc < 1 ? 'oppose' : 'urge',
      farmAlloc < 1 ? 'You cut the oldest decree' : 'Deliver farm water in full',
      'Farms asked ' + af(farmAF) + ', slider at ' + pct(farmAlloc * 100) + '; pay us to fallow instead.',
      evidence(s, 'cropHealth', 'Crop health', 'index 0-1', x.cropHealth, 0.7)));
    out.push(rec('ana', wildAlloc < 1 || x.streamflow < H.MIN_FLOW_CFS ? 'urge' : 'support',
      'Hold the ' + H.MIN_FLOW_CFS + ' cfs minimum',
      'Flow is ' + num(x.streamflow) + ' cfs against the ' + H.MIN_FLOW_CFS + ' cfs right; ' + (x.streamflow < H.MIN_FLOW_CFS ? 'a fish kill is a season away.' : 'do not trade it for lawns.'),
      evidence(s, 'streamflowCfs', 'Streamflow', 'cfs', x.streamflow, H.MIN_FLOW_CFS)));
    out.push(rec('naomi', tribalAlloc < 1 ? 'oppose' : 'support',
      tribalAlloc < 1 ? 'Senior right is not a slider' : 'Senior right first',
      'Tribal right ' + af(tribalAF) + ' this season' + (tribalAlloc < 1 ? '; setting ' + pct(tribalAlloc * 100) + ' saves nothing, law delivers it anyway.' : ', senior to every use, is met in full.'),
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.deadPool)));
    out.push(rec('priya', x.storagePct < 50 || ratio < 1 ? 'caution' : 'support',
      x.storagePct < 50 ? 'Protect carryover storage' : 'Supply covers requests',
      'Supply is ' + af(x.available) + ' against ' + af(x.totalDemand) + ' requested; keep end-of-season storage above ' + af(x.capacity * 0.5) + '.',
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.capacity * 0.5)));
    out.push(rec('marcus', x.householdShort > 0.05 ? 'support' : 'oppose',
      x.householdShort > 0.05 ? 'Restrict, but explain it' : 'No lawn ban without reason',
      (x.householdShort > 0.05 ? 'Households went short ' + pct(x.householdShort * 100) + ' last season; publish the numbers so restrictions feel real.' : 'Nobody accepts a watering ban with the reservoir at ' + pct(x.storagePct) + ' and trust at ' + num(x.outcomes.T) + '.'),
      evidence(s, 'shortagePct', 'Household shortage', '%', x.householdShort * 100, 5)));
    out.push(rec('dolores', x.fireDanger > 0.5 && fireAlloc < 1 ? 'urge' : (x.fireDanger > 0.5 ? 'support' : 'caution'),
      x.fireDanger > 0.5 ? 'Do not touch the fire reserve' : 'The reserve can flex',
      'Fire danger ' + num(x.fireDanger * 100) + '/100, reserve request ' + af(fireAF) + (x.fireDanger > 0.5 ? '; that is one bad week of refills.' : '; a partial reserve is fine until summer.'),
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));
    return out;
  };

  TOPIC_FNS.prescribed_burn = function (x) {
    var s = x.state, out = [];
    var pending = obj(obj(x.state.projects).pendingBurn);
    var target = null;
    x.fuel.zones.forEach(function (z) { if (pending.zoneId != null && z.id === pending.zoneId) target = z; });
    if (!target) target = x.fuel.upstreamWorst || x.fuel.worst || { name: 'the target sector', avg: x.fuel.avg, cells: 0 };
    var escape = 4 * (x.fireDanger > 0.5 ? 3 : 1);
    var goodWindow = x.fireDanger <= 0.5 && x.wind < 15 && (x.season === C.SEASON.SPRING || x.season === C.SEASON.FALL);
    var smokeDays = Math.max(2, Math.round(2 + target.avg * 4));
    out.push(rec('dolores', goodWindow ? 'urge' : 'caution',
      goodWindow ? 'Burn while the window is open' : 'Not in this wind',
      target.name + ' carries ' + num(target.avg * 100) + '% fuel; escape chance is ' + escape + '% in ' + num(x.wind) + ' mph wind.',
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));
    out.push(rec('priya', x.soil >= 40 && x.fireDanger <= 0.5 ? 'support' : 'caution',
      x.soil >= 40 ? 'Soil moisture says yes' : 'Wait for wetter ground',
      'Soil moisture is ' + pct(x.soil) + '; moist duff barely changes runoff, dry ground burns like wildfire.',
      evidence(s, 'fuelAvg', 'Forest fuel', 'index 0-1', x.fuel.avg, 0.6)));
    out.push(rec('marcus', x.effects.outreach || x.effects.shelters ? 'support' : 'caution',
      x.effects.outreach || x.effects.shelters ? 'We were warned, go ahead' : 'Tell the school first',
      'A burn means about ' + smokeDays + ' smoke days on top of ' + num(x.smokeDays) + ' already; ' + (x.effects.outreach ? 'people know the plan.' : 'warn the school first.'),
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));
    out.push(rec('ana', x.season === C.SEASON.FALL ? 'support' : 'caution',
      'Fire belongs here; timing matters',
      'A ' + num(target.avg * 100) + '% fuel load is a century of suppression; burn in fall, off elk range.',
      evidence(s, 'fuelAvg', 'Forest fuel', 'index 0-1', x.fuel.avg, 0.6)));
    out.push(rec('walt', target.upstream ? 'support' : 'caution',
      target.upstream ? 'Burn high, not my fence' : 'Keep it off the hay',
      target.name + (target.upstream ? ' is above the reservoir; an escape in ' : ' is above the valley; an escape in ') + num(x.wind) + ' mph wind ' + (target.upstream ? 'misses my hay.' : 'hits cured hay.'),
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));
    out.push(rec('naomi', 'support',
      'Good fire is old knowledge',
      'The ' + num(target.avg * 100) + '% load in ' + target.name + ' is the debt from a century without cultural burning.',
      evidence(s, 'fuelAvg', 'Forest fuel', 'index 0-1', x.fuel.avg, 0.6)));
    return out;
  };

  TOPIC_FNS.fire_policy = function (x) {
    var s = x.state, out = [];
    var suppress = x.policy === 'suppress_all';
    var worst = x.fuel.worst || { name: 'the upper forest', avg: x.fuel.avg };
    var hardened = Object.keys(obj(x.effects.hardenedZones)).length;
    out.push(rec('dolores', suppress ? 'caution' : 'support',
      suppress ? 'Suppress-all builds the big fire' : 'Managed fire, hard WUI line',
      'Suppress-all builds fuel 1.6 times faster and ' + worst.name + ' is already at ' + num(worst.avg * 100) + '%.',
      evidence(s, 'fuelAvg', 'Forest fuel', 'index 0-1', x.fuel.avg, 0.6)));
    out.push(rec('marcus', x.structuresLost > 0 || x.fireDanger > 0.6 ? 'urge' : 'caution',
      x.structuresLost > 0 ? 'Put them all out' : 'Fine until my street',
      (x.structuresLost > 0 ? 'We lost ' + Math.round(x.structuresLost) + ' homes and logged ' + num(x.smokeDays) + ' smoke days; letting fires burn is a hard sell.' : 'Fire danger is ' + num(x.fireDanger * 100) + '/100 and ' + hardened + ' neighborhoods are hardened; a month-long fire means kids indoors.'),
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.6)));
    out.push(rec('ana', suppress ? 'oppose' : 'urge',
      'The forest needs fire',
      'Ecosystem health is ' + num(x.outcomes.E) + '; managed backcountry fire is the cheapest restoration tool we have.',
      evidence(s, 'fuelAvg', 'Forest fuel', 'index 0-1', x.fuel.avg, 0.6)));
    out.push(rec('priya', x.upstreamAcres > 1000 ? 'caution' : 'support',
      'Judge the policy by water',
      'Burn above the reservoir: ' + acres(x.upstreamAcres) + ' at ' + num(x.burnMean * 100) + '% severity; severity, not acres, makes ash.',
      evidence(s, 'turbidity', 'Turbidity', 'index 0-1', x.turbidity, 0.3)));
    out.push(rec('walt', 'caution',
      'Managed above the dam, not hay',
      'Grass fire in ' + num(x.wind) + ' mph wind outruns engines; ' + x.farmName + ' needs a written suppression commitment.',
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));
    out.push(rec('naomi', suppress ? 'caution' : 'support',
      'Choose the fire respecting the river',
      'The ' + num(x.fuel.avg * 100) + '% fuel load is what happens when fire is outlawed; low severity protects the springs.',
      evidence(s, 'fuelAvg', 'Forest fuel', 'index 0-1', x.fuel.avg, 0.6)));
    return out;
  };

  TOPIC_FNS.flood = function (x) {
    var s = x.state, out = [];
    var scar = x.scarAcres;
    var peakEst = Math.round(120 + scar * 0.55 * Math.max(0.5, x.stormIn / 2));
    var sedEst = Math.round(scar * 0.8 * Math.max(0.5, x.stormIn / 2) * Math.max(0.3, x.burnMean + 0.3));
    out.push(rec('dolores', 'urge',
      'Sirens first, then the basin',
      'A ' + num(x.stormIn, 1) + ' in storm on ' + acres(scar) + ' of scar could push peak flow near ' + peakEst.toLocaleString() + ' cfs.',
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));
    out.push(rec('priya', 'urge',
      'Protect the intake, sensor upstream',
      'Sediment yield could reach ' + sedEst.toLocaleString() + ' t; a sensor above the intake halves outage days.',
      evidence(s, 'turbidity', 'Turbidity', 'index 0-1', x.turbidity, 0.3)));
    out.push(rec('ana', x.effects.wetlandRestored ? 'support' : 'urge',
      'Mulch the scar, use the wetland',
      'Mulch cuts sediment at the source by 60%; ' + (x.effects.wetlandRestored ? 'the restored wetland traps a third more.' : 'an unfunded wetland would trap a third more.'),
      evidence(s, 'turbidity', 'Turbidity', 'index 0-1', x.turbidity, 0.3)));
    out.push(rec('marcus', x.effects.warningSystem ? 'support' : 'urge',
      x.effects.warningSystem ? 'The sirens are in, use them' : 'Get a warning to every neighborhood',
      'The storm is ' + Math.round(x.stormTurns) + ' step' + (x.stormTurns === 1 ? '' : 's') + ' out and ' + (x.effects.warningSystem ? 'the warning system is funded; pair it with local markers.' : 'a $0.25M warning marker covers a whole neighborhood.'),
      evidence(s, 'P', 'Public safety', '0-100', x.outcomes.P, 60)));
    out.push(rec('walt', 'caution',
      'Barriers on the ditches too',
      'Crop health is ' + num(x.cropHealth * 100) + '%; log barriers above ' + x.farmName + ' beat a second sensor.',
      evidence(s, 'cropHealth', 'Crop health', 'index 0-1', x.cropHealth, 0.7)));
    out.push(rec('naomi', 'support',
      'Slow the water',
      'The scar is ' + acres(scar) + ', reservoir ' + pct(x.storagePct) + ' full; mulch and wetland keep sediment uphill.',
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.capacity)));
    return out;
  };

  TOPIC_FNS.contamination = function (x) {
    var s = x.state, out = [];
    var bad = x.ash > 0.3 || x.turbidity > 0.4;
    out.push(rec('priya', bad ? 'urge' : 'support',
      bad ? 'Treatment capacity is the bottleneck' : 'Watch the decay curve',
      'Turbidity is ' + num(x.turbidity * 100) + '% and ash ' + num(x.ash * 100) + '%; ' + (x.effects.treatment ? 'the upgrade is in, outage days so far ' + Math.round(x.stats.outageDays) + '.' : 'the treatment upgrade is the direct fix.'),
      evidence(s, 'turbidity', 'Turbidity', 'index 0-1', x.turbidity, 0.4)));
    out.push(rec('marcus', x.stats.outageDays > 0 ? 'urge' : 'caution',
      x.stats.outageDays > 0 ? 'Bottled water is not a plan' : 'No boil notices',
      (x.stats.outageDays > 0 ? 'We have had ' + Math.round(x.stats.outageDays) + ' outage days; ' : 'Ash at ' + num(x.ash * 100) + '% is one storm from a boil notice; ') + 'trust (' + num(x.outcomes.T) + ') cannot survive brown water.',
      evidence(s, 'W', 'Water security', '0-100', x.outcomes.W, 50)));
    out.push(rec('dolores', 'support',
      'Stop it on the slope',
      'All ash started on ' + acres(x.scarAcres) + ' of scar; mulch and barriers there cut the next plume.',
      evidence(s, 'turbidity', 'Turbidity', 'index 0-1', x.turbidity, 0.4)));
    out.push(rec('ana', x.turbidity > 0.3 ? 'urge' : 'support',
      'Turbid water is a fish problem',
      'Turbidity at ' + num(x.turbidity * 100) + '% smothers cutthroat spawning gravel; time any flushing pulse for late fall.',
      evidence(s, 'turbidity', 'Turbidity', 'index 0-1', x.turbidity, 0.3)));
    out.push(rec('walt', 'support',
      'Farms can take dirty water',
      'Farm delivery is ' + af(fin(x.delivered.farms, fin(x.demands.farms))) + '; send turbid releases to ditches, clean water to town.',
      evidence(s, 'cropHealth', 'Crop health', 'index 0-1', x.cropHealth, 0.7)));
    out.push(rec('naomi', 'caution',
      'Downstream water is a promise',
      'The ' + af(H.DOWNSTREAM_AF_YR) + ' delivery must not arrive black; fund wetland and mulch alongside the plant.',
      evidence(s, 'turbidity', 'Turbidity', 'index 0-1', x.turbidity, 0.3)));
    return out;
  };

  TOPIC_FNS.drought = function (x) {
    var s = x.state, out = [];
    var severe = x.droughtLevel >= 3 || x.snowpackPct < 70;
    var carryTurns = x.consumptive > 0 ? (x.storage - x.deadPool) / (x.consumptive) : 8;
    carryTurns = C.clamp(fin(carryTurns, 8), 0, 40);
    out.push(rec('priya', severe ? 'urge' : 'caution',
      severe ? 'Plan on the low forecast' : 'Dry, not yet a crisis',
      'Snowpack is ' + pct(x.snowpackPct) + ' (drought ' + x.drought + ') and storage covers about ' + num(carryTurns, 1) + ' seasons above dead pool.',
      evidence(s, 'snowpackPct', 'Snowpack', '%', x.snowpackPct, 70)));
    out.push(rec('walt', x.farmShort > 0.2 ? 'oppose' : 'caution',
      x.farmShort > 0.2 ? 'You cannot dry us twice' : 'Pay for fallowing, not orders',
      'Farm shortfall ' + pct(x.farmShort * 100) + ', crop health ' + num(x.cropHealth * 100) + '%; paid fallowing keeps the herd, mandatory cuts sell cows.',
      evidence(s, 'cropHealth', 'Crop health', 'index 0-1', x.cropHealth, 0.7)));
    out.push(rec('marcus', severe ? 'support' : 'oppose',
      severe ? 'Stage restrictions before the panic' : 'Restrictions can wait',
      (severe ? 'With snowpack at ' + pct(x.snowpackPct) + ', early stage-1 rules spread the pain cheaply; say what triggers stage 2.' : 'The reservoir is ' + pct(x.storagePct) + ' full; a yard ban now costs trust for no water.'),
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.capacity * 0.4)));
    out.push(rec('ana', x.streamflow < H.MIN_FLOW_CFS * 1.5 ? 'urge' : 'caution',
      'Minimum flow matters most now',
      'Flow is ' + num(x.streamflow) + ' cfs against the ' + H.MIN_FLOW_CFS + ' cfs right; the wildlife release costs the ledger nothing.',
      evidence(s, 'streamflowCfs', 'Streamflow', 'cfs', x.streamflow, H.MIN_FLOW_CFS)));
    out.push(rec('naomi', 'caution',
      'Senior rights are not exempt',
      'The ' + af(H.TRIBAL_RIGHT_AF_YR) + ' tribal right is met before shortage is shared; show the numbers openly.',
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.deadPool)));
    out.push(rec('dolores', x.fireDanger > 0.5 ? 'urge' : 'support',
      'Drought is fire season',
      'Soil moisture is ' + pct(x.soil) + ' and fuel ' + num(x.fuel.avg * 100) + '%; keep the ' + af(fin(x.demands.fire, 600)) + ' reserve whole.',
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));
    return out;
  };

  // ---------------------------------------------------------------- API
  function sanitize(r) {
    if (!r.characterId || !CHAR_BY_ID[r.characterId]) r.characterId = CHARACTERS[0].id;
    if (['urge', 'support', 'caution', 'oppose'].indexOf(r.stance) < 0) r.stance = 'caution';
    r.headline = String(r.headline || 'Recommendation');
    r.text = String(r.text || '').replace(/\b(undefined|NaN|null)\b/g, '?');
    var e = r.evidence = obj(r.evidence);
    e.label = String(e.label || 'Measurement'); e.unit = String(e.unit || '');
    e.current = fin(e.current);
    e.series = arr(e.series).map(function (v) { return fin(v); });
    if (e.series.length < 2) e.series = [e.current, e.current];
    if (e.threshold != null && !isFinite(e.threshold)) delete e.threshold;
    return r;
  }

  function getRecommendations(state, world, topic) {
    var fn = TOPIC_FNS[topic] || TOPIC_FNS.budget;
    var x, recs;
    try { x = context(state, world); recs = fn(x); } catch (err) {
      if (WS.DEBUG) console.error('Advisors error', err);
      recs = [];
    }
    recs = arr(recs).map(sanitize);
    if (recs.length < 4) {
      // Should never happen, but keep the contract: pad with neutral, grounded notes.
      var x2;
      try { x2 = x || context(state, world); } catch (err2) { x2 = context({}, {}); }
      var pads = [
        rec('priya', 'caution', 'Check the measurements', 'Storage is ' + af(x2.storage) + ' and snowpack ' + pct(x2.snowpackPct) + '; decide with the numbers in view.', evidence(state, 'storageAF', 'Reservoir storage', 'AF', x2.storage)),
        rec('dolores', 'caution', 'Watch the fuel', 'Fuel averages ' + num(x2.fuel.avg * 100) + '% and fire danger reads ' + x2.dangerLabel + ' this season.', evidence(state, 'fuelAvg', 'Forest fuel', 'index 0-1', x2.fuel.avg)),
        rec('marcus', 'caution', 'Keep people informed', 'Public trust sits at ' + num(x2.outcomes.T) + ' out of 100; explain every decision plainly.', evidence(state, 'T', 'Public trust', '0-100', x2.outcomes.T)),
        rec('ana', 'caution', 'Mind the river', 'Flow below the dam is ' + num(x2.streamflow) + ' cfs against a ' + H.MIN_FLOW_CFS + ' cfs instream right.', evidence(state, 'streamflowCfs', 'Streamflow', 'cfs', x2.streamflow))
      ];
      for (var i = 0; recs.length < 4 && i < pads.length; i++) recs.push(sanitize(pads[i]));
    }
    if (recs.length > 6) recs = recs.slice(0, 6);
    return recs;
  }

  WS.Advisors = {
    CHARACTERS: CHARACTERS,
    TOPICS: TOPICS.slice(),
    byId: function (id) { return CHAR_BY_ID[id] || null; },
    getRecommendations: getRecommendations,
    _series: series,
    _fuelByZone: fuelByZone
  };
})();
