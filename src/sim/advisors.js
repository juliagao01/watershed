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
      bio: 'Twenty-two seasons on engines and hand crews. Blunt, operational, allergic to wishful thinking. Measures every plan in crew-hours, fuel loads and the distance from a fire station.' },
    { id: 'walt', name: 'Walt Jensen', role: 'Rancher, Lazy J', color: '#b9863c', avatarEmoji: '🤠',
      bio: 'Third-generation cattle and hay operator holding a decree older than the town. Pragmatic about senior water rights, hay prices and what a dry summer does to a herd. Distrusts studies that cost more than ditches.' },
    { id: 'naomi', name: 'Naomi Whitehorse', role: 'Tribal Water Representative', color: '#7b4fa8', avatarEmoji: '🪶',
      bio: 'Represents a Ute-descended community whose reserved water right predates every other decree in the valley and was quantified in a treaty-era settlement. Speaks of the river as a relative with obligations flowing both ways. Written respectfully and generally; she speaks for no real tribe.' },
    { id: 'priya', name: 'Dr. Priya Natarajan', role: 'Hydrologist', color: '#2f7fb8', avatarEmoji: '📈',
      bio: 'Runs the basin water-supply forecast. Cites measurements first, models second, and always says how uncertain the number is. Would rather fund a streamgage than an opinion.' },
    { id: 'marcus', name: 'Marcus Lee', role: 'Resident and Parent, Marshall Heights', color: '#3f9a6a', avatarEmoji: '🏡',
      bio: 'Two kids at the elementary school, a mortgage in the wildland-urban interface and a water bill he reads line by line. Cares about smoke days, school closures and whether the lawn ban is really necessary.' },
    { id: 'ana', name: 'Dr. Ana Ortiz', role: 'Wildlife Biologist', color: '#5a8a3a', avatarEmoji: '🦌',
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
      budget: fin(state.budget), annualBudget: fin(state.annualBudget, 12), emergencyFund: fin(state.emergencyFund),
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
  var TOPIC_FNS = {};

  TOPIC_FNS.budget = function (x) {
    var s = x.state, out = [];
    var worst = x.fuel.worst || { name: 'the upper forest', avg: x.fuel.avg };
    var thinned = obj(x.effects.thinnedZones);
    var worstTreated = worst.id != null && thinned[worst.id] > 0.2;
    out.push(rec('dolores', worst.avg > 0.6 && !worstTreated ? 'urge' : 'support',
      worst.avg > 0.6 ? 'Put money in the fuel, not the paperwork' : 'Keep a line item for the WUI',
      'Fuel in ' + worst.name + ' is averaging ' + num(worst.avg * 100) + '% of load and fire danger sits at ' + x.dangerLabel + '. ' +
      (worst.avg > 0.6 && !worstTreated ? 'Thinning that sector now costs a fraction of one suppression season; every year we wait the load climbs another 4 points. ' : 'Thinning is in place there, so the next dollar goes to hardening homes in ' + x.wuiName + '. ') +
      'With ' + money(x.budget) + ' in hand I would commit at least a third of it to the fire line.',
      evidence(s, 'fuelAvg', 'Mean forest fuel load', 'index 0-1', x.fuel.avg, 0.6)));

    out.push(rec('walt', x.cropHealth < 0.7 || x.farmShort > 0.1 ? 'urge' : 'caution',
      x.cropHealth < 0.7 ? 'Ditches before dashboards' : 'Do not spend it all on studies',
      'Crop health on the valley floor is ' + num(x.cropHealth * 100) + '% and farm shortfall last season was ' + pct(x.farmShort * 100) + '. ' +
      'Irrigation efficiency upgrades return water to the system every year and keep hay on the market; I have watched ' + money(x.annualBudget) + ' budgets vanish into reports that never moved a drop. ' +
      'Fund the ditch improvements first, then argue about the rest.',
      evidence(s, 'cropHealth', 'Farm crop health', 'index 0-1', x.cropHealth, 0.7)));

    out.push(rec('naomi', x.effects.wetlandRestored ? 'support' : 'urge',
      x.effects.wetlandRestored ? 'Keep caring for the restored ground' : 'Spend on the river, which will repay you',
      'The reservoir holds ' + af(x.storage) + ' of ' + af(x.capacity) + ' (' + pct(x.storagePct) + ') and the river below the dam is running ' + num(x.streamflow) + ' cfs. ' +
      'Our people have said for generations that the water is a relative, not a resource; the wetland and riparian work is the budget line that treats it that way, storing water in the ground and cleaning what comes down. ' +
      (x.effects.wetlandRestored ? 'It is funded; protect it from cuts.' : 'It costs less than a single flood repair.'),
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.capacity * 0.5)));

    out.push(rec('priya', x.uncertainty > 0.1 ? 'urge' : 'support',
      x.uncertainty > 0.1 ? 'Buy the measurement before the decision' : 'Now invest in storage and treatment',
      'Snowpack is reading ' + pct(x.snowpackPct) + ' of average with a forecast uncertainty of ±' + pct(x.uncertainty * 100) + ', which on ' + af(x.available) + ' of available supply is an error bar of about ' + af(x.available * x.uncertainty) + '. ' +
      (x.uncertainty > 0.1 ? 'Streamgages and SNOTEL telemetry shrink that band to ±5% for the price of one small culvert. ' : 'With gauges in place, the next most valuable dollar is treatment capacity or the reservoir upgrade. ') +
      'I would not commit the rest of the ' + money(x.budget) + ' until we know which number we are planning for.',
      evidence(s, 'snowpackPct', 'Snowpack, % of average', '%', x.snowpackPct, 100)));

    out.push(rec('marcus', x.effects.upkeepM > x.annualBudget * 0.25 ? 'caution' : 'support',
      x.effects.upkeepM > x.annualBudget * 0.25 ? 'Upkeep is a bill with my name on it' : 'Fix the leaks, warn the families',
      'Ongoing upkeep is already ' + money(x.effects.upkeepM) + ' a year against a ' + money(x.annualBudget) + ' budget, and every recurring cost ends up on ' + Math.round(x.population).toLocaleString() + ' residents\' water bills. ' +
      'Leak detection pays for itself and a warning system is the one thing I would want at 2 a.m. with a storm over the burn scar. ' +
      'Public trust is at ' + num(x.outcomes.T) + '; show people where the money goes.',
      evidence(s, 'budget', 'Budget on hand', '$M', x.budget, x.annualBudget)));

    out.push(rec('ana', x.habitat < 0.5 || x.turbidity > 0.3 ? 'urge' : 'support',
      'Habitat has no line item unless you give it one',
      'Mean habitat quality is ' + num(x.habitat * 100) + '% and reservoir turbidity is ' + num(x.turbidity * 100) + '%. ' +
      'Wetland restoration and a wildlife corridor are cheap relative to fire and flood projects and they buffer both: wet meadows trap sediment, hold water in drought and give elk winter range that is not a subdivision. ' +
      'Ecosystem health scores ' + num(x.outcomes.E) + ' right now; it will not improve on its own.',
      evidence(s, 'turbidity', 'Reservoir turbidity', 'index 0-1', x.turbidity, 0.3)));
    return out;
  };

  TOPIC_FNS.allocation = function (x) {
    var s = x.state, out = [];
    var farmAlloc = fin(x.alloc.farms, 1), tribalAlloc = fin(x.alloc.tribal, 1), wildAlloc = fin(x.alloc.wildlife, 1), fireAlloc = fin(x.alloc.fire, 1);
    var ratio = x.totalDemand > 0 ? x.available / x.totalDemand : 1;
    var farmAF = fin(x.demands.farms), tribalAF = fin(x.demands.tribal, H.TRIBAL_RIGHT_AF_YR / 4), wildAF = fin(x.demands.wildlife, x.minFlowAF), fireAF = fin(x.demands.fire, 600);
    var wildCfs = wildAF / (H.AF_PER_CFS_DAY * 91);

    out.push(rec('walt', farmAlloc < 1 ? 'oppose' : 'urge',
      farmAlloc < 1 ? 'You are cutting the oldest decree in the valley' : 'Deliver the farm water in full',
      'Farms are asking ' + af(farmAF) + ' this season and the slider sits at ' + pct(farmAlloc * 100) + '. ' +
      'Hay that does not get water in ' + C.SEASONS[x.season] + ' does not come back in ' + C.SEASONS[(x.season + 1) % 4] + '; crop health is ' + num(x.cropHealth * 100) + '% and every 10% shortfall is a cut herd or bought feed at whatever the market says. ' +
      'If someone has to go short, fallow us for a fee and pay it, do not just turn the wheel.',
      evidence(s, 'cropHealth', 'Farm crop health', 'index 0-1', x.cropHealth, 0.7)));

    out.push(rec('ana', wildAlloc < 1 || x.streamflow < H.MIN_FLOW_CFS ? 'urge' : 'support',
      'Hold the ' + H.MIN_FLOW_CFS + ' cfs minimum flow',
      'The instream flow right is ' + H.MIN_FLOW_CFS + ' cfs, which is only ' + af(wildAF) + ' for the season (about ' + num(wildCfs) + ' cfs). Flow below the dam is ' + num(x.streamflow) + ' cfs now. ' +
      'Releases for wildlife are non-consumptive, the water still reaches the farms and the state line, and below ' + H.MIN_FLOW_CFS + ' cfs the cutthroat pools warm and disconnect. ' +
      (x.streamflow < H.MIN_FLOW_CFS ? 'We are already under it; a fish kill is a season away.' : 'Do not trade that for a lawn.'),
      evidence(s, 'streamflowCfs', 'Streamflow below dam', 'cfs', x.streamflow, H.MIN_FLOW_CFS)));

    out.push(rec('naomi', tribalAlloc < 1 ? 'oppose' : 'support',
      tribalAlloc < 1 ? 'The senior right is not a slider' : 'The senior right comes first, then we talk',
      'The tribal right is ' + af(tribalAF) + ' this season, ' + af(H.TRIBAL_RIGHT_AF_YR) + ' a year, senior to every other use here and settled long before this town had a name. ' +
      (tribalAlloc < 1 ? 'Setting it to ' + pct(tribalAlloc * 100) + ' does not save water; the law delivers it anyway and the community learns the town tried. ' : 'It is set to be delivered in full, which is the only lawful place to start. ') +
      'Meet it, then bring the shortage to the table and we will share the rest as relatives share.',
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.deadPool)));

    out.push(rec('priya', x.storagePct < 50 || ratio < 1 ? 'caution' : 'support',
      x.storagePct < 50 ? 'Protect carryover storage' : 'Supply covers requests, keep a cushion',
      'Available supply is ' + af(x.available) + ' against ' + af(x.totalDemand) + ' requested (' + num(ratio * 100) + '% coverage) and storage is ' + pct(x.storagePct) + ' of capacity. ' +
      'Every acre-foot delivered above inflow comes out of next year; with snowpack at ' + pct(x.snowpackPct) + ' and ±' + pct(x.uncertainty * 100) + ' uncertainty I would keep end-of-season storage above ' + af(x.capacity * 0.5) + '. ' +
      'Dead pool is ' + af(x.deadPool) + ' and nothing comes out below it.',
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.capacity * 0.5)));

    out.push(rec('marcus', x.householdShort > 0.05 ? 'support' : 'oppose',
      x.householdShort > 0.05 ? 'Fine, restrict, but explain it' : 'No lawn ban without a reason',
      'Household shortfall last season was ' + pct(x.householdShort * 100) + ' and the restriction level is "' + x.restriction + '". ' +
      (x.householdShort > 0.05 ? 'If the taps are short, stage restrictions are fair, but publish the numbers so people know it is real. ' : 'Nobody in ' + x.wuiName + ' will accept a watering ban while the reservoir sits at ' + pct(x.storagePct) + '. ') +
      'Trust is ' + num(x.outcomes.T) + ' out of 100; it drops fastest when rules feel arbitrary.',
      evidence(s, 'shortagePct', 'Household shortage', '%', x.householdShort * 100, 5)));

    out.push(rec('dolores', x.fireDanger > 0.5 && fireAlloc < 1 ? 'urge' : (x.fireDanger > 0.5 ? 'support' : 'caution'),
      x.fireDanger > 0.5 ? 'Do not touch the fire reserve' : 'The reserve can flex in a wet season',
      'Fire danger is ' + x.dangerLabel + ' (' + num(x.fireDanger * 100) + '/100) and the reserve request is ' + af(fireAF) + '. ' +
      (x.fireDanger > 0.5 ? 'That is engine refills and helicopter dips for one bad week; when the call comes there is no time to renegotiate with the ditch company. ' : 'With danger this low I can live with a partial reserve, but it must be back to full before summer. ') +
      'Fuel is at ' + num(x.fuel.avg * 100) + '% and the wind forecast is ' + num(x.wind) + ' mph.',
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
      goodWindow ? 'Burn it while the window is open' : 'Not in this wind, not at this danger',
      target.name + ' carries a fuel load of ' + num(target.avg * 100) + '% across ' + acres(C.cellsToAcres(target.cells)) + '; a burn drops that to about ' + num(target.avg * 40) + '%. ' +
      'Escape chance is roughly ' + escape + '% at ' + x.dangerLabel + ' danger with ' + num(x.wind) + ' mph wind. ' +
      (goodWindow ? 'That is a risk I will take with crews staged; the wildfire that finds this fuel later will not ask permission.' : 'Above 50 danger the escape odds triple and I will not put a crew on a line I cannot hold.'),
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));

    out.push(rec('priya', x.soil >= 40 && x.fireDanger <= 0.5 ? 'support' : 'caution',
      x.soil >= 40 ? 'Soil moisture says yes' : 'Wait for wetter ground',
      'Soil moisture in the forest is ' + pct(x.soil) + ' and the temperature anomaly is ' + (x.tempAnom >= 0 ? '+' : '') + num(x.tempAnom, 1) + ' °F. ' +
      'A low-intensity burn on moist duff consumes surface fuel without cooking the soil, so runoff and sediment after the next storm barely change; a hot burn on dry ground behaves like a wildfire hydrologically. ' +
      'Snowpack at ' + pct(x.snowpackPct) + ' also tells us how green the understory will be.',
      evidence(s, 'fuelAvg', 'Mean forest fuel load', 'index 0-1', x.fuel.avg, 0.6)));

    out.push(rec('marcus', x.effects.outreach || x.effects.shelters ? 'support' : 'caution',
      x.effects.outreach || x.effects.shelters ? 'We were warned, so go ahead' : 'Tell the school before you light it',
      'A burn in ' + target.name + ' means roughly ' + smokeDays + ' smoke days for town, on top of the ' + num(x.smokeDays) + ' we have already logged. ' +
      (x.effects.outreach ? 'Outreach has been done, people know the difference between a planned burn and a wildfire, and the school has a plan. ' : 'Without notice, parents see smoke over the ridge and assume the worst; the elementary school has no filtration and no plan for recess. ') +
      'I would rather breathe a few planned days than a summer of the other kind, but say so in advance.',
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));

    out.push(rec('ana', x.season === C.SEASON.FALL ? 'support' : 'caution',
      'Fire belongs here, timing matters',
      'Ponderosa and the drier mixed conifer here evolved with frequent low-severity fire; the fuel load of ' + num(target.avg * 100) + '% is what a century of suppression looks like. ' +
      'I support the burn, but keep it out of the riparian strip and off elk winter range while animals are concentrated; habitat quality is ' + num(x.habitat * 100) + '% and a fall burn after the first snow moves elk is the cleanest window. ' +
      'Leave the big snags standing.',
      evidence(s, 'fuelAvg', 'Mean forest fuel load', 'index 0-1', x.fuel.avg, 0.6)));

    out.push(rec('walt', target.upstream ? 'support' : 'caution',
      target.upstream ? 'Burn the high country, not my fence line' : 'Keep it well away from the hay',
      (target.upstream ? target.name + ' is above the reservoir, so if it does escape it is not into my hay meadows. ' : target.name + ' sits above the valley floor and an escape with ' + num(x.wind) + ' mph wind runs straight downslope into cured grass and stacked bales. ') +
      'Grazing after a burn comes back better within two seasons, and a black hillside in fall beats a black valley in July. ' +
      'Just make sure the ' + af(fin(x.demands.fire, 600)) + ' fire reserve is actually in the reservoir before anyone strikes a match.',
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));

    out.push(rec('naomi', 'support',
      'Good fire is old knowledge',
      'Cultural burning kept these slopes open long before the first decree; low fires in the right season renewed forage, berries and the springs that feed the creek. ' +
      'The load in ' + target.name + ' at ' + num(target.avg * 100) + '% is the debt from a century of putting every fire out. ' +
      'Burn with humility, in ' + (x.season === C.SEASON.SPRING || x.season === C.SEASON.FALL ? 'this' : 'the shoulder') + ' season, and the river will carry less ash for it.',
      evidence(s, 'fuelAvg', 'Mean forest fuel load', 'index 0-1', x.fuel.avg, 0.6)));
    return out;
  };

  TOPIC_FNS.fire_policy = function (x) {
    var s = x.state, out = [];
    var suppress = x.policy === 'suppress_all';
    var worst = x.fuel.worst || { name: 'the upper forest', avg: x.fuel.avg };
    var hardened = Object.keys(obj(x.effects.hardenedZones)).length;

    out.push(rec('dolores', suppress ? 'caution' : 'support',
      suppress ? 'Suppress-all builds the fire that beats us' : 'Managed fire, with a hard line at the WUI',
      'Under suppress-all, fuel accumulates about 1.6 times faster; ' + worst.name + ' is already at ' + num(worst.avg * 100) + '%. ' +
      'Managed fire lets a wet-season lightning start clean up a ridge for free, but I will full-suppress anything within reach of ' + x.wuiName + ' regardless of policy. ' +
      'We have lost ' + Math.round(x.structuresLost) + ' structures so far; the question is which fire you want, the one you choose or the one you get.',
      evidence(s, 'fuelAvg', 'Mean forest fuel load', 'index 0-1', x.fuel.avg, 0.6)));

    out.push(rec('marcus', x.structuresLost > 0 || x.fireDanger > 0.6 ? 'urge' : 'caution',
      x.structuresLost > 0 ? 'Put them out, all of them' : 'Managed sounds fine until it is my street',
      (x.structuresLost > 0 ? 'We have already lost ' + Math.round(x.structuresLost) + ' homes and logged ' + num(x.smokeDays) + ' smoke days; letting anything burn is a hard sell on my block. ' : 'Fire danger is ' + x.dangerLabel + ' and ' + num(x.smokeDays) + ' smoke days so far; a fire allowed to burn for a month is a month of kids indoors. ') +
      (hardened > 0 ? 'Home hardening is funded in ' + hardened + ' neighborhood' + (hardened > 1 ? 's' : '') + ', which makes managed fire easier to accept. ' : 'Nobody has hardened a single neighborhood yet, so the town is the fuel. ') +
      'Public safety scores ' + num(x.outcomes.P) + '.',
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.6)));

    out.push(rec('ana', suppress ? 'oppose' : 'urge',
      'The forest needs fire more than it needs us',
      'Ecosystem health sits at ' + num(x.outcomes.E) + '. Mixed-severity fire creates the openings, snags and aspen regeneration that elk and cavity nesters depend on; a century of suppression is why crown fires now sterilise whole drainages. ' +
      'Managed fire in the back country with a wet-season start is the cheapest restoration tool we have. ' +
      'Suppress-all trades small fires now for a stand-replacing one later, and that fire is what fills the reservoir with ash.',
      evidence(s, 'fuelAvg', 'Mean forest fuel load', 'index 0-1', x.fuel.avg, 0.6)));

    out.push(rec('priya', x.upstreamAcres > 1000 ? 'caution' : 'support',
      'Judge the policy by what it does to the water',
      'Burned area upstream of the reservoir totals ' + acres(x.upstreamAcres) + ' and mean burn severity on the map is ' + num(x.burnMean * 100) + '%. ' +
      'Low-severity managed fire raises runoff only slightly; high-severity crown fire can raise post-storm sediment tenfold and turbidity is already ' + num(x.turbidity * 100) + '%. ' +
      'The measurement that matters is severity, not acres, so any policy that lowers fuel before the dry years wins on the water balance.',
      evidence(s, 'turbidity', 'Reservoir turbidity', 'index 0-1', x.turbidity, 0.3)));

    out.push(rec('walt', 'caution',
      'Managed above the dam, suppressed above the hay',
      'A fire that runs onto the valley floor in August takes the second cutting with it, and grass fire in ' + num(x.wind) + ' mph wind moves faster than any engine. ' +
      'I can accept managed fire in the upper sectors where fuel is ' + num(worst.avg * 100) + '%, but ' + x.farmName + ' needs a suppression commitment in writing. ' +
      'Insurance on the barns is already asking what the county policy is.',
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));

    out.push(rec('naomi', suppress ? 'caution' : 'support',
      'Choose the fire that respects the river',
      'Our elders describe fire as a tool that was taken away by law, and the ' + num(x.fuel.avg * 100) + '% fuel load is the result. ' +
      'Managed fire that keeps severity low protects the springs and the trout the community depends on; a suppress-all policy protects houses this year and hands the reservoir an ash load in a dry one. ' +
      'Whatever you choose, make the decision with the people downstream in the room.',
      evidence(s, 'fuelAvg', 'Mean forest fuel load', 'index 0-1', x.fuel.avg, 0.6)));
    return out;
  };

  TOPIC_FNS.flood = function (x) {
    var s = x.state, out = [];
    var scar = x.scarAcres;
    var peakEst = Math.round(120 + scar * 0.55 * Math.max(0.5, x.stormIn / 2));
    var sedEst = Math.round(scar * 0.8 * Math.max(0.5, x.stormIn / 2) * Math.max(0.3, x.burnMean + 0.3));

    out.push(rec('dolores', 'urge',
      'Sirens first, then the basin above town',
      'A ' + num(x.stormIn, 1) + ' in storm on ' + acres(scar) + ' of scar could push peak flow near ' + peakEst.toLocaleString() + ' cfs, versus roughly 120 cfs unburned. ' +
      'Warning markers in ' + x.wuiName + ' cut injury risk by about 80% and a debris basin on the main channel catches the boulders before the bridge. ' +
      'Emergency fund is ' + money(x.emergencyFund) + '; spend it on the things that keep people out of the water.',
      evidence(s, 'fireDanger', 'Fire danger', 'index 0-1', x.fireDanger, 0.5)));

    out.push(rec('priya', 'urge',
      'Protect the intake and put a sensor upstream',
      'Sediment yield from the scar could be on the order of ' + sedEst.toLocaleString() + ' t; even a tenth of that reaching the reservoir lifts turbidity from ' + num(x.turbidity * 100) + '% into treatment-plant trouble. ' +
      'Intake protection at the dam plus a sensor on the river above it halves outage days because the plant can switch or shut before the plume arrives. ' +
      (x.effects.sensorCoverage ? 'Streamgages are funded, so the sensor reading will be trusted.' : 'Without gauges we will be guessing the arrival time.'),
      evidence(s, 'turbidity', 'Reservoir turbidity', 'index 0-1', x.turbidity, 0.3)));

    out.push(rec('ana', x.effects.wetlandRestored ? 'support' : 'urge',
      'Mulch the scar, let the wetland work',
      'Mulch on the burned slopes cuts sediment at the source by roughly 60%, which is worth more to the trout than any wall downstream. ' +
      (x.effects.wetlandRestored ? 'The restored wetland will trap about a third of what passes and knock 30% off the peak. ' : 'A restored wetland would trap about a third of the sediment and cut the peak 30%; it is not funded. ') +
      'Please keep hard bank armour to the reach by the treatment plant; riprap everywhere is a sterile channel for decades.',
      evidence(s, 'turbidity', 'Reservoir turbidity', 'index 0-1', x.turbidity, 0.3)));

    out.push(rec('marcus', x.effects.warningSystem ? 'support' : 'urge',
      x.effects.warningSystem ? 'The sirens are in, now use them' : 'Get a warning into every neighborhood',
      'The storm is ' + Math.round(x.stormTurns) + ' step' + (x.stormTurns === 1 ? '' : 's') + ' out and people in ' + x.wuiName + ' are asking whether to move cars and kids. ' +
      (x.effects.warningSystem ? 'The town-wide warning system is funded; pair it with the marker in each neighborhood so the message is local. ' : 'A warning marker costs a quarter million and covers a whole neighborhood; there is no cheaper life saved. ') +
      'Flood damage so far is ' + money(x.stats.floodDamageM) + ' and none of it was budgeted.',
      evidence(s, 'P', 'Public safety score', '0-100', x.outcomes.P, 60)));

    out.push(rec('walt', 'caution',
      'Barriers on the ditches, not just the canyon',
      'Mud that comes over the headgate fills the lateral ditches for a season and the fields go dry in the middle of irrigation; crop health is ' + num(x.cropHealth * 100) + '% and cannot take that. ' +
      'Log barriers on the side draws above ' + x.farmName + ' are cheap, and I would put two there before a second sensor. ' +
      'Do not spend the whole ' + money(x.emergencyFund) + ' on town; the valley floods too.',
      evidence(s, 'cropHealth', 'Farm crop health', 'index 0-1', x.cropHealth, 0.7)));

    out.push(rec('naomi', 'support',
      'Slow the water, do not fight it',
      'The river is doing what a burned watershed makes it do; the work is to slow it. ' +
      'Mulch, wetland and beaver-style structures keep sediment on the slope and water in the ground, where our people have always understood it belongs; concrete moves the problem to whoever lives below. ' +
      'The scar is ' + acres(scar) + ' and the reservoir is ' + pct(x.storagePct) + ' full; there is room to hold a pulse if it arrives clean.',
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.capacity)));
    return out;
  };

  TOPIC_FNS.contamination = function (x) {
    var s = x.state, out = [];
    var bad = x.ash > 0.3 || x.turbidity > 0.4;

    out.push(rec('priya', bad ? 'urge' : 'support',
      bad ? 'Treatment capacity is the bottleneck' : 'Watch the decay curve before spending',
      'Turbidity is ' + num(x.turbidity * 100) + '% and ash contamination ' + num(x.ash * 100) + '%; both decay roughly 35% and 25% per season, so without intervention ash is still about ' + num(x.ash * 0.75 * 100) + '% next season. ' +
      (x.effects.multiLevelIntake ? 'The multi-level intake lets the plant draw from the cleanest layer. ' : 'A multi-level intake would let the plant draw clear water from above the plume. ') +
      (x.effects.treatment ? 'The treatment upgrade is in place; outage days so far: ' + Math.round(x.stats.outageDays) + '.' : 'The plant has ' + Math.round(x.stats.outageDays) + ' outage days already; the treatment upgrade is the direct fix.'),
      evidence(s, 'turbidity', 'Reservoir turbidity', 'index 0-1', x.turbidity, 0.4)));

    out.push(rec('marcus', x.stats.outageDays > 0 ? 'urge' : 'caution',
      x.stats.outageDays > 0 ? 'Bottled water is not a plan' : 'Do not let it get to boil notices',
      (x.stats.outageDays > 0 ? 'We have had ' + Math.round(x.stats.outageDays) + ' days of outage or boil notice and the school closed the fountains. ' : 'No outages yet, but ash at ' + num(x.ash * 100) + '% is one storm from a boil notice. ') +
      'Whatever it costs, the treatment upgrade is cheaper than a town of ' + Math.round(x.population).toLocaleString() + ' buying water by the case, and trust (' + num(x.outcomes.T) + ') does not survive brown tap water. ' +
      'Tell people what the numbers mean before they see the colour.',
      evidence(s, 'W', 'Water security score', '0-100', x.outcomes.W, 50)));

    out.push(rec('dolores', 'support',
      'Stop it on the slope',
      'Every ton of ash in the reservoir started on ' + acres(x.scarAcres) + ' of burn scar; mulch and barriers on the steep drainages are the only measures that reduce the next plume rather than treat it. ' +
      'For suppression I can draft turbid water all day, so do not hold the fire reserve for quality reasons. ' +
      'Sediment delivered so far: ' + Math.round(x.stats.sedimentTons).toLocaleString() + ' t.',
      evidence(s, 'turbidity', 'Reservoir turbidity', 'index 0-1', x.turbidity, 0.4)));

    out.push(rec('ana', x.turbidity > 0.3 ? 'urge' : 'support',
      'Turbid water is a fish problem too',
      'Fine sediment at ' + num(x.turbidity * 100) + '% turbidity smothers the gravel where cutthroat spawn and the algae index is ' + num(x.algae * 100) + '%. ' +
      'Releasing a flushing pulse below the dam clears the plant intake faster but scours the redds, so time any flush for late fall after spawning. ' +
      'The lasting fix is upstream: mulch, wetland, riparian shade, not just filters.',
      evidence(s, 'turbidity', 'Reservoir turbidity', 'index 0-1', x.turbidity, 0.3)));

    out.push(rec('walt', 'support',
      'Farms can take the dirty water',
      'Irrigation water does not need to meet drinking standards; if the plant is struggling, route the turbid releases to the ditches and keep the clean layer for town. ' +
      'Farm delivery this season is ' + af(fin(x.delivered.farms, fin(x.demands.farms))) + ' and ash-laden water is fine on hay as long as the headgates do not silt up. ' +
      'Charge the ditch cleaning to the flood account, not to us.',
      evidence(s, 'cropHealth', 'Farm crop health', 'index 0-1', x.cropHealth, 0.7)));

    out.push(rec('naomi', 'caution',
      'What we send downstream is a promise',
      'The delivery obligation is ' + af(H.DOWNSTREAM_AF_YR) + ' a year and it does not say the water may arrive black; communities below us drink from the same relative. ' +
      'Ash at ' + num(x.ash * 100) + '% will pass the dam whether or not the town plant copes, so the measures that matter are the ones that clean the water, not just the ones that protect the intake. ' +
      'Fund the wetland and mulch alongside the plant.',
      evidence(s, 'turbidity', 'Reservoir turbidity', 'index 0-1', x.turbidity, 0.3)));
    return out;
  };

  TOPIC_FNS.drought = function (x) {
    var s = x.state, out = [];
    var severe = x.droughtLevel >= 3 || x.snowpackPct < 70;
    var carryTurns = x.consumptive > 0 ? (x.storage - x.deadPool) / (x.consumptive) : 8;
    carryTurns = C.clamp(fin(carryTurns, 8), 0, 40);

    out.push(rec('priya', severe ? 'urge' : 'caution',
      severe ? 'Plan on the low forecast' : 'Dry, not yet a crisis',
      'Snowpack is ' + pct(x.snowpackPct) + ' of average (' + num(x.swe, 1) + ' in SWE against ' + num(H.AVG_SNOW_SWE_IN) + ' in), drought category ' + x.drought + ', soil moisture ' + pct(x.soil) + '. ' +
      'At current consumptive demand the reservoir has about ' + num(carryTurns, 1) + ' seasons of usable storage above dead pool. ' +
      'Uncertainty is ±' + pct(x.uncertainty * 100) + '; plan on the lower bound, because a second dry winter is the historical norm, not the exception.',
      evidence(s, 'snowpackPct', 'Snowpack, % of average', '%', x.snowpackPct, 70)));

    out.push(rec('walt', x.farmShort > 0.2 ? 'oppose' : 'caution',
      x.farmShort > 0.2 ? 'You cannot dry us up twice' : 'Pay for fallowing, do not order it',
      'Farm shortfall is ' + pct(x.farmShort * 100) + ' and crop health ' + num(x.cropHealth * 100) + '%; hay was already scarce on the Front Range in the last dry year and the price follows the snowpack. ' +
      'If cuts are coming, a voluntary paid fallowing program lets me choose which field to idle and keeps the herd; a mandatory cut sells cows at the bottom of the market. ' +
      'Our decree is senior to the town\'s; do not forget that when the sliders move.',
      evidence(s, 'cropHealth', 'Farm crop health', 'index 0-1', x.cropHealth, 0.7)));

    out.push(rec('marcus', severe && x.restriction === 'none' ? 'support' : (severe ? 'support' : 'oppose'),
      severe ? 'Stage restrictions now, before the panic' : 'Restrictions can wait',
      'Restriction level is "' + x.restriction + '" and household shortfall is ' + pct(x.householdShort * 100) + '. ' +
      (severe ? 'With snowpack at ' + pct(x.snowpackPct) + ', early voluntary or stage-1 rules spread the pain and are far cheaper on the bill than an emergency purchase later. ' : 'The reservoir is ' + pct(x.storagePct) + ' full; asking families to let the yard die now is a trust cost with no water benefit. ') +
      'Say plainly what triggers the next stage.',
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.capacity * 0.4)));

    out.push(rec('ana', x.streamflow < H.MIN_FLOW_CFS * 1.5 ? 'urge' : 'caution',
      'Drought is when the minimum flow matters most',
      'Flow below the dam is ' + num(x.streamflow) + ' cfs against a ' + H.MIN_FLOW_CFS + ' cfs instream right, and warm low water is how a fish kill starts; the temperature anomaly is ' + (x.tempAnom >= 0 ? '+' : '') + num(x.tempAnom, 1) + ' °F. ' +
      'The wildlife release is non-consumptive; it reaches the state line and counts toward the downstream obligation, so holding it costs the ledger nothing. ' +
      'Elk winter range on the shrub benches is ' + num(x.habitat * 100) + '% quality and drought pushes them into the hayfields, which is Walt\'s problem next.',
      evidence(s, 'streamflowCfs', 'Streamflow below dam', 'cfs', x.streamflow, H.MIN_FLOW_CFS)));

    out.push(rec('naomi', 'caution',
      'Senior rights are not a hardship exemption',
      'The tribal right of ' + af(H.TRIBAL_RIGHT_AF_YR) + ' a year and the ' + af(H.DOWNSTREAM_AF_YR) + ' Colorado River delivery are met before any local shortage is shared; that is settled law and the community will not renegotiate it under pressure. ' +
      'What we will do is conserve alongside you, because the river is a relative in a hard year too. ' +
      'Storage is ' + af(x.storage) + '; show the numbers openly and the sharing goes easier.',
      evidence(s, 'storageAF', 'Reservoir storage', 'AF', x.storage, x.deadPool)));

    out.push(rec('dolores', x.fireDanger > 0.5 ? 'urge' : 'support',
      'Drought is fire season with a different name',
      'Fire danger is ' + x.dangerLabel + ' with soil moisture at ' + pct(x.soil) + ' and fuel at ' + num(x.fuel.avg * 100) + '%; the same numbers that dry the reservoir dry the crowns. ' +
      'Keep the ' + af(fin(x.demands.fire, 600)) + ' reserve whole and do not let the fire stations\' hydrant pressure drop with the pool. ' +
      'Every drought year on record in this state ends with a big fire somewhere.',
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
        rec('priya', 'caution', 'Check the measurements', 'Storage is ' + af(x2.storage) + ' and snowpack ' + pct(x2.snowpackPct) + '. Decide with the numbers in view.', evidence(state, 'storageAF', 'Reservoir storage', 'AF', x2.storage)),
        rec('dolores', 'caution', 'Watch the fuel', 'Fuel averages ' + num(x2.fuel.avg * 100) + '% and danger is ' + x2.dangerLabel + '.', evidence(state, 'fuelAvg', 'Mean forest fuel load', 'index 0-1', x2.fuel.avg)),
        rec('marcus', 'caution', 'Keep people informed', 'Trust is ' + num(x2.outcomes.T) + '; explain the decision.', evidence(state, 'T', 'Public trust', '0-100', x2.outcomes.T)),
        rec('ana', 'caution', 'Mind the river', 'Flow is ' + num(x2.streamflow) + ' cfs.', evidence(state, 'streamflowCfs', 'Streamflow below dam', 'cfs', x2.streamflow))
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
