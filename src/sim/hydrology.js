/* Watershed — hydrology: seasonal climate, demands, supply, allocation, water quality. Runs in Node (no DOM).
   Units: acre-feet (AF) per season; cfs for displayed flow; inches for precip/SWE; degrees F for temperature anomaly. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C, H = C.HYDRO, S = C.SEASON, L = C.LAND;

  var DAYS = 91.25;                                   // days per season
  var GAL_PER_AF = 325851;
  var WATERSHED_ACRES = H.WATERSHED_AREA_SQMI * 640;  // 37,120 acres
  var AF_PER_INCH = WATERSHED_ACRES / 12;             // ≈3,093 AF per inch of water over the watershed
  var AF_PER_SEASON_PER_CFS = DAYS * H.AF_PER_CFS_DAY; // ≈181 AF per cfs held for a season

  /* Calibration (normal year ≈ 35,000 AF total inflow; spring ≈ 62%). */
  var CAL = {
    MELT_NORMAL_AF: 26000,                      // snowmelt runoff reaching the reservoir in a 100%-of-average snow year
    SPRING_MELT_FRAC: 0.79,                     // share of the melt arriving in Spring (rest in Summer)
    BASEFLOW_AF: [2400, 1800, 1900, 2300],      // groundwater / baseflow by season (Winter, Spring, Summer, Fall)
    PRECIP_NORMAL_IN: [2.4, 3.4, 3.0, 2.4],     // seasonal precipitation, inches
    RAIN_RUNOFF_COEF: [0.0, 0.12, 0.08, 0.10],  // fraction of seasonal rain that becomes streamflow (unburned; winter precip is snow)
    HOUSEHOLD_SEASON: [0.7, 0.95, 1.45, 0.9],   // seasonal multipliers on per-capita use (mean 1.0)
    FARM_SEASON: [0, 0.30, 0.55, 0.15],         // share of annual AF/acre applied per season
    HYDRO_REQ_AF: [2000, 3000, 3000, 2500],     // firm turbine release request (non-consumptive)
    REC_REQ_AF: [150, 1000, 1500, 500],         // boating/rafting release request (non-consumptive)
    REC_POOL_TARGET: [0.5, 0.55, 0.7, 0.5],     // reservoir fraction that keeps ramps and beaches usable
    REC_VISITS: [8000, 25000, 60000, 20000],
    EVAP_FT: [0.15, 0.65, 1.5, 0.7],            // net reservoir evaporation (feet) per season
    FULL_POOL_ACRES: 560,
    TURBINE_CAP_AF: 10800,                      // ≈60 cfs turbine capacity over a season
    MWH_PER_AF_AT_40M: 0.114,
    FIRE_RESERVE_AF: 600,
    RESTRICTION_MULT: { none: 1, voluntary: 0.92, stage1: 0.82, stage2: 0.68 },
    SEASON_DANGER_BASE: [0.06, 0.25, 0.5, 0.33],
    TEMP_TREND_F: 0.8, TEMP_TREND_PER_YEAR_F: 0.12,
    TEMP_SIGMA_F: [3.0, 2.5, 2.0, 2.5],
    WIND_EVENT_P: [0.08, 0.12, 0.05, 0.14],
    ORDER: ['tribal', 'downstream', 'households', 'farms', 'fire', 'wildlife', 'hydro', 'recreation']
  };

  /* Approximate Colorado statewide April-1 snowpack, % of median (NRCS SNOTEL, rounded; approximate). */
  var HISTORICAL = {
    note: 'Approximate Colorado statewide April-1 snowpack as a percent of median (NRCS SNOTEL), rounded; temperature anomalies are approximate too. Used in Historical mode in order, repeating.',
    years: [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023],
    values: [52, 80, 112, 70, 95, 110, 68, 135, 104, 86, 91, 127],
    tempAnomF: [3.5, 1.0, 0.2, 1.5, 1.2, 1.6, 2.4, -0.5, 1.4, 1.5, 1.8, 0.4],
    labels: ['2012 — very low snowpack, hot dry spring; large Front Range fires', '2013 — below-average pack; historic September Front Range floods',
      '2014 — above-average pack, strong runoff', '2015 — low pack rescued by a wet May', '2016 — near-average', '2017 — above-average',
      '2018 — very low pack, especially in the southwest; large fires', '2019 — big snow year, late melt', '2020 — near-average pack, then a hot dry summer; record fire season',
      '2021 — below-average; dry soils soaked up the melt', '2022 — below-average; early melt', '2023 — big snow year, high runoff']
  };
  for (var hi = 0; hi < HISTORICAL.values.length; hi++) HISTORICAL[hi] = HISTORICAL.values[hi];
  HISTORICAL.length = HISTORICAL.values.length;

  /* ---------- helpers ---------- */
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function clamp(v, a, b) { v = fin(v, a); return v < a ? a : (v > b ? b : v); }
  function fx(state) {
    var e = null;
    try { if (WS.Projects && typeof WS.Projects.effects === 'function') e = WS.Projects.effects(state); } catch (err) { e = null; }
    e = e || {};
    return {
      sensorCoverage: fin(e.sensorCoverage, 0), irrigationEfficiency: clamp(e.irrigationEfficiency, 0, 0.6), leakReduction: clamp(e.leakReduction, 0, 0.5),
      reservoirCapacityBonus: clamp(e.reservoirCapacityBonus, 0, 0.5), multiLevelIntake: !!e.multiLevelIntake, rainCaptureAF: clamp(e.rainCaptureAF, 0, 5000),
      wetlandRestored: !!e.wetlandRestored, treatment: !!e.treatment, musselInspection: !!e.musselInspection, warningSystem: !!e.warningSystem,
      thinnedZones: e.thinnedZones || {}, hardenedZones: e.hardenedZones || {}, fuelBreakZones: e.fuelBreakZones || {}
    };
  }
  function rngOf(rng, state, label) {
    if (rng && typeof rng.next === 'function') return rng;
    return WS.RNG.create(String(state && state.seed) + ':hydro:' + label + ':' + (state ? state.turn : 0));
  }
  function ensureModel(state) {
    if (!state.climate) state.climate = WS.State ? WS.State.defaults({}).climate : {};
    var m = state.climate.model;
    if (!m || typeof m !== 'object') m = state.climate.model = {};
    m.ar = fin(m.ar, 0); m.enso = fin(m.enso, 0); m.ensoPhase = fin(m.ensoPhase, 0); m.tempAr = fin(m.tempAr, 0); m.deficit = fin(m.deficit, 0);
    m.snowYear = fin(m.snowYear, 100); m.lastSnowYear = fin(m.lastSnowYear, 100); m.meltUsed = clamp(m.meltUsed, 0, 1);
    m.winterMeltFrac = clamp(m.winterMeltFrac, 0, 0.5); m.monsoon = m.monsoon || 'normal'; m.windEvent = !!m.windEvent;
    return m;
  }
  function sectorFill(obj, v) { obj = obj || {}; for (var i = 0; i < C.SECTORS.length; i++) obj[C.SECTORS[i]] = v; return obj; }
  function ensureWater(state) {
    var w = state.water = state.water || {};
    w.demands = w.demands || sectorFill({}, 0); w.alloc = w.alloc || sectorFill({}, 1);
    w.delivered = w.delivered || sectorFill({}, 0); w.shortage = w.shortage || sectorFill({}, 0);
    for (var i = 0; i < C.SECTORS.length; i++) {
      var k = C.SECTORS[i];
      w.demands[k] = Math.max(0, fin(w.demands[k], 0)); w.alloc[k] = clamp(w.alloc[k], 0, 1);
      w.delivered[k] = Math.max(0, fin(w.delivered[k], 0)); w.shortage[k] = Math.max(0, fin(w.shortage[k], 0));
    }
    if (!CAL.RESTRICTION_MULT[w.restriction]) w.restriction = 'none';
    return w;
  }
  function ensureReservoir(state) {
    var r = state.reservoir = state.reservoir || {};
    r.capacityAF = Math.max(1, fin(r.capacityAF, H.RESERVOIR_CAPACITY_AF));
    r.storageAF = clamp(r.storageAF, 0, r.capacityAF * 1.5);
    r.turbidity = clamp(r.turbidity, 0, 1); r.ashContam = clamp(r.ashContam, 0, 1); r.algae = clamp(r.algae, 0, 1);
    return r;
  }
  function seasonOf(state) { return ((fin(state.season, 0) % 4) + 4) % 4; }
  function effCapacity(state) { return ensureReservoir(state).capacityAF * (1 + fx(state).reservoirCapacityBonus); }

  /* Per-world caches (cell index lists) — never mutate the world object. */
  var cache = (typeof WeakMap === 'function') ? new WeakMap() : null;
  function worldInfo(world) {
    if (!world || !world.land) return null;
    var info = cache ? cache.get(world) : (world.__wsHydroInfo || null);
    if (info && info.n === world.land.length) return info;
    var n = world.land.length, forest = [], upstream = [], valley = [], farm = [], land = world.land;
    var up = (typeof world.isUpstreamOfReservoir === 'function') ? world.isUpstreamOfReservoir : null;
    for (var i = 0; i < n; i++) {
      var t = land[i];
      if (t === L.RIVER || t === L.RESERVOIR) continue;
      if (t === L.FOREST) forest.push(i);
      if (t === L.FARM) farm.push(i);
      if (t === L.FARM || t === L.SHRUB || t === L.RESIDENTIAL || t === L.CIVIC || t === L.WETLAND || t === L.RIPARIAN || t === L.ROAD) valley.push(i);
      var isUp = false;
      if (up) { try { isUp = !!up.call(world, i); } catch (e) { isUp = false; } }
      if (isUp && t !== L.ALPINE) upstream.push(i);
    }
    info = { n: n, forest: Int32Array.from(forest), upstream: Int32Array.from(upstream), valley: Int32Array.from(valley), farm: Int32Array.from(farm) };
    if (cache) cache.set(world, info); else world.__wsHydroInfo = info;
    return info;
  }
  function meanOver(arr, idx) { if (!arr || !idx || !idx.length) return 0; var s = 0; for (var i = 0; i < idx.length; i++) s += fin(arr[idx[i]], 0); return s / idx.length; }
  function burnStats(world) {
    var info = worldInfo(world);
    if (!info || !world.burn) return { burnMean: 0, scarFrac: 0, scarAcres: 0 };
    var idx = info.upstream.length ? info.upstream : info.forest, s = 0, scar = 0;
    for (var i = 0; i < idx.length; i++) { var b = fin(world.burn[idx[i]], 0); s += b; if (b > 0.2) scar++; }
    var n = idx.length || 1;
    return { burnMean: clamp(s / n, 0, 1), scarFrac: scar / n, scarAcres: C.cellsToAcres(scar) };
  }
  function soilMoistureMean(world) {
    var info = worldInfo(world);
    if (!info || !world.moisture) return 0.45;
    var s = 0, n = 0;
    for (var i = 0; i < info.forest.length; i++) { s += fin(world.moisture[info.forest[i]], 0.6); n++; }
    for (i = 0; i < info.valley.length; i++) { s += fin(world.moisture[info.valley[i]], 0.45); n++; }
    return n ? clamp(s / n, 0, 1) : 0.45;
  }
  function farmAcres(world) {
    var info = worldInfo(world);
    if (info && info.farm.length) return C.cellsToAcres(info.farm.length);
    return H.IRRIGATED_ACRES;
  }
  function reservoirAcres(state, world) {
    var r = ensureReservoir(state), frac = clamp(r.storageAF / effCapacity(state), 0, 1.2);
    if (world && world.reservoir && typeof world.reservoir.areaForStorage === 'function') {
      try { var cells = fin(world.reservoir.areaForStorage(r.storageAF), 0); if (cells > 0) return C.cellsToAcres(cells); } catch (e) { /* fall through */ }
    }
    return CAL.FULL_POOL_ACRES * Math.pow(frac, 0.6);
  }
  function droughtCategory(index) {
    if (index >= -0.12) return 'None';
    if (index > -0.25) return 'D0';
    if (index > -0.4) return 'D1';
    if (index > -0.6) return 'D2';
    if (index > -0.85) return 'D3';
    return 'D4';
  }
  var DROUGHT_LEVEL = { None: 0, D0: 1, D1: 2, D2: 3, D3: 4, D4: 5 };
  function dangerLabel(d) { return d < 0.2 ? 'Low' : d < 0.4 ? 'Moderate' : d < 0.6 ? 'High' : d < 0.8 ? 'Very High' : 'Extreme'; }
  function pct(v) { return Math.round(v * 100); }
  function afStr(v) { return Math.round(v).toLocaleString() + ' AF'; }
  function demandMult(state, key) {
    var dm = state.flags && state.flags.demandMult;
    return dm && isFinite(dm[key]) ? clamp(dm[key], 0.2, 3) : 1;
  }

  /* ---------- inflow model (deterministic given state) ---------- */
  function meltVolume(state, world) {
    var m = ensureModel(state), cl = state.climate;
    var soil = clamp(fin(cl.soilMoisturePct, 45) / 100, 0, 1);
    var bs = burnStats(world);
    var snowF = Math.pow(clamp(m.snowYear, 0, 250) / 100, 1.35);          // runoff efficiency collapses in thin years
    var soilF = clamp(1 + 0.9 * (soil - 0.45), 0.6, 1.25);                 // dry soils soak up melt
    var burnF = 1 + 0.45 * bs.burnMean;                                    // less canopy interception / transpiration on a scar
    var tempF = clamp(1 - 0.03 * Math.max(0, fin(cl.tempAnomF, 0)), 0.8, 1.05); // hot springs sublimate / evaporate more
    return CAL.MELT_NORMAL_AF * snowF * soilF * burnF * tempF;
  }
  function meltFracThisSeason(state) {
    var m = ensureModel(state), s = seasonOf(state), cl = state.climate;
    if (s === S.WINTER) return m.winterMeltFrac;
    if (s === S.SPRING) {
      var f = CAL.SPRING_MELT_FRAC + 0.03 * fin(cl.tempAnomF, 0) + (state.flags && state.flags.dustOnSnow ? 0.08 : 0);
      return clamp(Math.min(clamp(f, 0.6, 0.95), 1 - m.meltUsed), 0, 1);
    }
    if (s === S.SUMMER) return clamp(1 - m.meltUsed, 0, 1);
    return 0;
  }
  function baseflowAF(state) {
    var m = ensureModel(state), s = seasonOf(state);
    var droughtF = clamp(1 + 0.6 * fin(state.climate.droughtIndex, 0), 0.35, 1.3);
    var carryF = 0.7 + 0.3 * clamp(m.lastSnowYear / 100, 0, 1.6);
    return CAL.BASEFLOW_AF[s] * droughtF * carryF;
  }
  function rainRunoffAF(state, world) {
    var s = seasonOf(state), cl = state.climate, bs = burnStats(world);
    var soil = clamp(fin(cl.soilMoisturePct, 45) / 100, 0, 1);
    var coef = CAL.RAIN_RUNOFF_COEF[s] * (1 + 2.5 * bs.burnMean) * clamp(1 + 0.6 * (soil - 0.45), 0.6, 1.5);
    return Math.max(0, fin(cl.precipIn, 0)) * AF_PER_INCH * coef;
  }
  function seasonInflow(state, world) {
    var melt = meltVolume(state, world) * meltFracThisSeason(state);
    var v = melt + baseflowAF(state) + rainRunoffAF(state, world);
    return { total: Math.max(0, fin(v, 0)), melt: melt, base: baseflowAF(state), rain: rainRunoffAF(state, world) };
  }
  function normalSeasonInflow(s) {
    var meltN = [0, CAL.SPRING_MELT_FRAC, 1 - CAL.SPRING_MELT_FRAC, 0][s] * CAL.MELT_NORMAL_AF;
    return meltN + CAL.BASEFLOW_AF[s] + CAL.PRECIP_NORMAL_IN[s] * AF_PER_INCH * CAL.RAIN_RUNOFF_COEF[s];
  }
  var NORMAL_ANNUAL_INFLOW = normalSeasonInflow(0) + normalSeasonInflow(1) + normalSeasonInflow(2) + normalSeasonInflow(3);

  /* ---------- API ---------- */
  var Hydrology = WS.Hydrology = {
    CAL: CAL, HISTORICAL: HISTORICAL, NORMAL_ANNUAL_INFLOW_AF: NORMAL_ANNUAL_INFLOW,

    /** generateSeasonClimate(state, world, rng) — sets state.climate for the new season. */
    generateSeasonClimate: function (state, world, rng) {
      if (!state) return null;
      var cl = state.climate = state.climate || {};
      var m = ensureModel(state), s = seasonOf(state), year = Math.max(1, fin(state.year, 1));
      var r = rngOf(rng, state, 'climate');
      var f = fx(state), notes = [];
      var historical = state.mode === 'historical';
      var hIdx = (year - 1) % HISTORICAL.values.length;

      // soil moisture & fuel from the world (before this season's nudge)
      var soil = soilMoistureMean(world);
      cl.soilMoisturePct = Math.round(soil * 1000) / 10;
      var info = worldInfo(world);
      cl.fuelAvg = info && world.fuel && info.forest.length ? clamp(meanOver(world.fuel, info.forest), 0, 1) : fin(cl.fuelAvg, 0.62);
      cl.cropHealthAvg = info && world.cropHealth && info.farm.length ? clamp(meanOver(world.cropHealth, info.farm), 0, 1) : fin(cl.cropHealthAvg, 0.85);
      var bs = burnStats(world);
      cl.burnScarPct = Math.round(bs.scarFrac * 1000) / 10;

      // temperature anomaly: warming trend + AR(1) persistence + seasonal noise (historical: labelled year anomaly + jitter)
      var trend = CAL.TEMP_TREND_F + CAL.TEMP_TREND_PER_YEAR_F * (year - 1);
      m.tempAr = 0.45 * m.tempAr + r.gauss(0, CAL.TEMP_SIGMA_F[s] * 0.9);
      var tempAnom = historical ? HISTORICAL.tempAnomF[hIdx] + r.gauss(0, 1.0) : trend + m.tempAr;
      if (s === S.SUMMER && DROUGHT_LEVEL[cl.drought] >= 3) tempAnom += 0.8; // dry soils → hotter summers
      cl.tempAnomF = Math.round(clamp(tempAnom, -12, 14) * 10) / 10;

      var precipNormal = CAL.PRECIP_NORMAL_IN[s], precip;
      if (s === S.WINTER) {
        // snowpack: AR(1) around average (sigma ≈ 25%) plus a slow ENSO-like drift
        m.lastSnowYear = m.snowYear;
        m.ensoPhase += (2 * Math.PI) / (4 + 3 * r.next()) + r.gauss(0, 0.15);
        m.enso = 0.10 * Math.sin(m.ensoPhase);
        var phi = 0.35, sigma = 0.25 * C.diff(state, 'climateSigma');   // difficulty widens / narrows snowpack variance
        m.ar = phi * m.ar + sigma * Math.sqrt(1 - phi * phi) * r.gauss(0, 1);
        var snow = historical ? HISTORICAL.values[hIdx] * (1 + r.gauss(0, 0.04)) : 100 * (1 + m.ar + m.enso);
        snow = clamp(snow, 30, 200);
        // warm winter: part of the pack melts (or never accumulates) early
        m.winterMeltFrac = clamp(0.045 * (cl.tempAnomF - 2.5), 0, 0.22);
        m.snowYear = snow * (1 - 0.5 * m.winterMeltFrac);
        m.meltUsed = 0;
        m.monsoon = 'normal';
        precip = precipNormal * (m.snowYear / 100) * clamp(1 + r.gauss(0, 0.12), 0.6, 1.5);
        cl.snowpackPct = Math.round(m.snowYear);
        cl.snowpackPeakPct = cl.snowpackPct;
        cl.snowSWEin = Math.round(H.AVG_SNOW_SWE_IN * m.snowYear / 100 * 10) / 10;
        if (m.winterMeltFrac > 0.05) notes.push('A warm winter: about ' + pct(m.winterMeltFrac) + '% of the snowpack melted before spring.');
        if (state.flags) state.flags.dustOnSnow = false;          // annual: an event card may set it again before spring melt
      } else if (s === S.SPRING) {
        precip = precipNormal * clamp(Math.exp(r.gauss(0, 0.35)), 0.3, 2.5);
        cl.snowpackPct = Math.round(m.snowYear);
        cl.snowpackPeakPct = cl.snowpackPct;
        cl.snowSWEin = Math.round(H.AVG_SNOW_SWE_IN * m.snowYear / 100 * (1 - m.meltUsed) * 10) / 10;
      } else if (s === S.SUMMER) {
        if (m.meltUsed < CAL.SPRING_MELT_FRAC) m.meltUsed = clamp(CAL.SPRING_MELT_FRAC + m.winterMeltFrac, 0, 1); // spring was skipped (mid-year start): its melt already passed
        var u = r.next();
        m.monsoon = u < 0.28 ? 'strong' : (u < 0.53 ? 'weak' : 'normal');
        var mMult = m.monsoon === 'strong' ? 1.6 : (m.monsoon === 'weak' ? 0.5 : 1);
        precip = precipNormal * mMult * clamp(Math.exp(r.gauss(0, 0.25)), 0.4, 2);
        var residual = clamp(1 - m.meltUsed, 0, 1);
        cl.snowpackPct = Math.round(m.snowYear * residual * 0.5);
        cl.snowpackPeakPct = Math.round(m.snowYear);
        cl.snowSWEin = Math.round(H.AVG_SNOW_SWE_IN * m.snowYear / 100 * residual * 0.5 * 10) / 10;
      } else {
        m.meltUsed = 1;
        precip = precipNormal * clamp(Math.exp(r.gauss(0, 0.35)), 0.3, 2.5);
        if (r.chance(0.15)) { precip *= 1.8; notes.push('A slow-moving fall storm system parked over the foothills.'); }
        cl.snowpackPct = 0; cl.snowpackPeakPct = Math.round(m.snowYear); cl.snowSWEin = 0;
      }
      cl.precipIn = Math.round(clamp(precip, 0, 20) * 100) / 100;

      // drought index: decaying cumulative deficit (negative = dry) → US Drought Monitor-style category
      var anom;
      if (s === S.WINTER) anom = 0.8 * (m.snowYear - 100) / 100;
      else if (s === S.SPRING) anom = 0.15 * (cl.precipIn / precipNormal - 1) + 0.25 * (m.snowYear - 100) / 100 - 0.02 * Math.max(0, cl.tempAnomF);
      else if (s === S.SUMMER) anom = 0.2 * (cl.precipIn / precipNormal - 1) - 0.03 * Math.max(0, cl.tempAnomF);
      else anom = 0.15 * (cl.precipIn / precipNormal - 1) - 0.02 * Math.max(0, cl.tempAnomF);
      m.deficit = clamp(m.deficit * 0.72 + anom, -2, 1.5);
      cl.droughtIndex = Math.round(m.deficit * 1000) / 1000;
      cl.drought = droughtCategory(m.deficit);

      // wind
      var windEvent = r.chance(CAL.WIND_EVENT_P[s]);
      m.windEvent = windEvent;
      cl.windDirRad = ((0.8 + r.gauss(0, 0.5)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      cl.windMph = Math.round(clamp(windEvent ? r.range(28, 50) : r.gauss(8 + [1, 3, 0, 2][s], 2.5), 2, 60));
      if (windEvent) notes.push('A downslope wind event is forecast: gusts near ' + cl.windMph + ' mph.');

      // fire danger 0..1
      var danger = CAL.SEASON_DANGER_BASE[s] + 0.045 * cl.tempAnomF - 0.05 * (cl.precipIn - precipNormal) - 0.5 * (soil - 0.45)
        + 0.4 * (cl.fuelAvg - 0.62) - 0.12 * m.deficit + 0.004 * (cl.windMph - 8);
      cl.fireDanger = Math.round(clamp(danger, 0, 1) * 100) / 100;
      cl.fireDangerLabel = dangerLabel(cl.fireDanger);

      // expected natural streamflow above the reservoir
      var inflow = seasonInflow(state, world);
      cl.streamflowCfs = Math.round(clamp(inflow.total / AF_PER_SEASON_PER_CFS, 0, 1e5));

      // uncertainty: stream gages / SNOTEL sensors narrow the forecast range
      cl.uncertainty = f.sensorCoverage > 0 ? 0.05 : 0.25;

      // description
      var d = [];
      var snowWord = m.snowYear < 65 ? 'a thin' : m.snowYear < 90 ? 'a below-average' : m.snowYear < 115 ? 'a near-average' : 'a deep';
      if (s === S.WINTER) d.push('Snowpack is tracking ' + cl.snowpackPct + '% of average — ' + snowWord + ' winter' + (cl.tempAnomF > 2.5 ? ' and a warm one' : '') + '.');
      else if (s === S.SPRING) d.push('Melt is under way from ' + snowWord + ' pack (' + cl.snowpackPct + '% of average)' + (cl.tempAnomF > 2 ? '; a warm spring is bringing runoff early' : cl.tempAnomF < -2 ? '; a cool spring is holding snow high' : '') + '.');
      else if (s === S.SUMMER) d.push((cl.tempAnomF > 3 ? 'A hot summer' : 'Summer') + ' with a ' + m.monsoon + ' monsoon (' + cl.precipIn.toFixed(1) + ' in of rain expected).');
      else d.push('Fall' + (cl.precipIn > precipNormal * 1.4 ? ' storms are lining up' : cl.precipIn < precipNormal * 0.6 ? ' is running dry' : ' brings typical weather') + '.');
      if (cl.drought !== 'None') d.push('Drought status: ' + cl.drought + '.');
      d.push('Fire danger ' + cl.fireDangerLabel.toLowerCase() + '.');
      if (bs.scarFrac > 0.05) d.push('About ' + pct(bs.scarFrac) + '% of the upstream watershed is burn scar; runoff will be flashier and dirtier.');
      if (historical) d.push('(Historical: ' + HISTORICAL.labels[hIdx] + ')');
      cl.description = d.concat(notes).join(' ');
      cl.notes = notes;
      return cl;
    },

    /** computeDemands(state, world) — fills state.water.demands (AF this season). */
    computeDemands: function (state, world) {
      if (!state) return null;
      var w = ensureWater(state), cl = state.climate || {}, s = seasonOf(state), f = fx(state), d = w.demands;
      var pop = Math.max(0, fin(state.population, H.BASE_POPULATION));
      var precipNormal = CAL.PRECIP_NORMAL_IN[s], precipRatio = clamp(fin(cl.precipIn, precipNormal) / precipNormal, 0, 3);

      // households: population × GPCD × days, seasonal shape, less leaks, restrictions, rain capture
      var hh = pop * H.GPCD * DAYS / GAL_PER_AF * CAL.HOUSEHOLD_SEASON[s];
      hh *= (1 - f.leakReduction) * CAL.RESTRICTION_MULT[w.restriction] * demandMult(state, 'households');
      var rain = f.rainCaptureAF / 4 * [0.4, 1.0, 1.6, 1.0][s] * clamp(precipRatio, 0.3, 1.5);
      hh -= Math.min(rain, 0.3 * hh);
      d.households = Math.max(0, hh);

      // farms: acres × AF/acre × seasonal share, minus efficiency; a wet season needs a little less
      var farms = farmAcres(world) * H.FARM_AF_PER_ACRE_YR * CAL.FARM_SEASON[s] * (1 - f.irrigationEfficiency);
      farms *= (1 - 0.1 * clamp(precipRatio - 1, 0, 1)) * demandMult(state, 'farms');
      d.farms = Math.max(0, farms);

      d.fire = CAL.FIRE_RESERVE_AF * (fin(cl.fireDanger, 0) > 0.6 ? 2 : 1) * demandMult(state, 'fire');
      d.hydro = CAL.HYDRO_REQ_AF[s] * demandMult(state, 'hydro');
      d.recreation = CAL.REC_REQ_AF[s] * demandMult(state, 'recreation');
      d.tribal = H.TRIBAL_RIGHT_AF_YR / 4 * demandMult(state, 'tribal');
      d.wildlife = H.MIN_FLOW_CFS * AF_PER_SEASON_PER_CFS * demandMult(state, 'wildlife');
      d.downstream = H.DOWNSTREAM_AF_YR / 4 * demandMult(state, 'downstream');
      for (var i = 0; i < C.SECTORS.length; i++) d[C.SECTORS[i]] = Math.round(Math.max(0, fin(d[C.SECTORS[i]], 0)));
      return d;
    },

    /** computeAvailable(state, world) — inflowAF this season and availableAF = inflow + usable storage. */
    computeAvailable: function (state, world) {
      if (!state) return 0;
      var w = ensureWater(state), r = ensureReservoir(state), cl = state.climate || {};
      var inflow = seasonInflow(state, world);
      w.inflowAF = Math.round(inflow.total);
      w.inflowParts = { melt: Math.round(inflow.melt), baseflow: Math.round(inflow.base), rain: Math.round(inflow.rain) };
      cl.streamflowCfs = Math.round(clamp(inflow.total / AF_PER_SEASON_PER_CFS, 0, 1e5));
      var evap = reservoirAcres(state, world) * CAL.EVAP_FT[seasonOf(state)] * clamp(1 + 0.04 * fin(cl.tempAnomF, 0), 0.7, 1.6);
      w.evapAF = Math.round(clamp(evap, 0, r.storageAF));
      var usable = Math.max(0, r.storageAF - w.evapAF - H.RESERVOIR_DEAD_POOL_AF);
      w.availableAF = Math.round(Math.max(0, w.inflowAF + usable));
      return w.availableAF;
    },

    /** runSeason(state, world, rng) → report. Resolves allocation, storage, quality, soils, crops, streamflow. */
    runSeason: function (state, world, rng) {
      if (!state) return null;
      var w = ensureWater(state), r = ensureReservoir(state), cl = state.climate || {}, m = ensureModel(state);
      var s = seasonOf(state), f = fx(state), notes = [], stats = state.stats = state.stats || {};
      var flags = state.flags = state.flags || {};
      if (!isFinite(state.trustDelta)) state.trustDelta = 0;
      var dm = w.demands, sumD = 0;
      for (var i = 0; i < C.SECTORS.length; i++) sumD += dm[C.SECTORS[i]];
      if (sumD <= 0) Hydrology.computeDemands(state, world);
      Hydrology.computeAvailable(state, world);
      var capacity = effCapacity(state);
      var startStorage = r.storageAF, inflow = w.inflowAF, available = w.availableAF, evap = w.evapAF;
      var bs = burnStats(world);

      // ---- allocation ----
      var delivered = sectorFill({}, 0), shortage = sectorFill({}, 0), shortagePct = sectorFill({}, 0);
      var remaining = available;        // water not yet committed this season
      var consumptive = 0, release = 0, fireReserve = 0, legalOverride = false;
      var CONSUMPTIVE = { tribal: 1, households: 1, farms: 1 }, SENIOR = { tribal: 1, downstream: 1 };
      for (i = 0; i < CAL.ORDER.length; i++) {
        var k = CAL.ORDER[i], req = Math.max(0, fin(dm[k], 0)), alloc = clamp(w.alloc[k], 0, 1), want = req * alloc, got;
        if (SENIOR[k]) {
          if (alloc < 0.999 && req > 0) legalOverride = true;
          want = req;                                    // senior rights are delivered regardless of the player's slider
        }
        if (CONSUMPTIVE[k]) { got = Math.min(want, remaining); remaining -= got; consumptive += got; }
        else if (k === 'fire') { got = Math.min(want, remaining); remaining -= got; fireReserve = got; }
        else {                                            // downstream / wildlife / hydro / recreation share one release
          got = Math.min(want, release + remaining);
          var extra = Math.max(0, got - release);
          remaining -= extra; release += extra;
        }
        got = Math.max(0, fin(got, 0));
        delivered[k] = got;
        shortage[k] = Math.max(0, req - got);
        shortagePct[k] = req > 0 ? clamp(shortage[k] / req, 0, 1) : 0;
      }
      if (legalOverride) {
        state.trustDelta -= 3;
        notes.push('You tried to hold back senior water: the tribal right and the Colorado River delivery were released anyway — they are legally senior, and cutting them costs trust.');
      }

      // fire reserve: held in storage; only partly consumed if a fire burned last season
      var lastFire = null, fires = (state.fire && Array.isArray(state.fire.fires)) ? state.fire.fires : [];
      for (i = fires.length - 1; i >= 0; i--) { var ff = fires[i]; if (ff && (fin(ff.year, 0) - 1) * 4 + fin(ff.season, 0) === fin(state.turn, 0) - 1) { lastFire = ff; break; } }
      var fireUsed = lastFire ? Math.min(fireReserve, 0.4 * fireReserve + 0.02 * fin(lastFire.acres, 0)) : 0;
      fireUsed = clamp(fireUsed, 0, fireReserve);

      // ---- storage ----
      var endStorage = startStorage + inflow - evap - consumptive - release - fireUsed;
      var spill = 0;
      if (endStorage > capacity) { spill = endStorage - capacity; endStorage = capacity; }
      endStorage = clamp(endStorage, 0, capacity);
      r.storageAF = Math.round(endStorage);
      var storagePct = capacity > 0 ? endStorage / capacity : 0;
      var outflow = consumptive + release + fireUsed + spill;
      w.outflowAF = Math.round(outflow);
      w.delivered = delivered; w.shortage = shortage;
      for (i = 0; i < C.SECTORS.length; i++) { delivered[C.SECTORS[i]] = Math.round(delivered[C.SECTORS[i]]); shortage[C.SECTORS[i]] = Math.round(shortage[C.SECTORS[i]]); }

      // ---- streamflow below the dam ----
      var releaseCfs = (release + spill) / AF_PER_SEASON_PER_CFS;
      w.releaseCfs = Math.round(releaseCfs * 10) / 10;
      var minFlowMet = releaseCfs >= H.MIN_FLOW_CFS * 0.98;
      flags.minFlowStreak = minFlowMet ? fin(flags.minFlowStreak, 0) + 1 : 0;
      if (minFlowMet) state.trustDelta += 0.25;

      // ---- hydro ----
      var head = 30 + 20 * storagePct;
      var turbined = Math.min(release + spill, CAL.TURBINE_CAP_AF * clamp(delivered.hydro / Math.max(1, dm.hydro), 0.25, 1));
      var hydroMWh = Math.round(turbined * CAL.MWH_PER_AF_AT_40M * head / 40);
      stats.hydroMWh = fin(stats.hydroMWh, 0) + hydroMWh;

      // ---- melt bookkeeping (commit this season's melt share) ----
      m.meltUsed = clamp(m.meltUsed + meltFracThisSeason(state), 0, 1);

      // ---- water quality ----
      r.turbidity *= 0.65;
      r.ashContam *= f.treatment ? 0.55 : 0.75;
      var normalIn = normalSeasonInflow(s);
      var dTurb = clamp(0.3 * bs.burnMean * (inflow / Math.max(1, normalIn)) * [0.3, 1, 0.8, 0.7][s], 0, 0.5);
      r.turbidity = clamp(r.turbidity + dTurb, 0, 1);
      r.ashContam = clamp(r.ashContam + 0.5 * dTurb * (f.multiLevelIntake ? 0.7 : 1), 0, 1);
      if (dTurb > 0.06) notes.push('Runoff off the burn scar carried ash and sediment into the reservoir: turbidity rose to ' + pct(r.turbidity) + '%.');
      var farmRatio = dm.farms > 0 ? clamp(delivered.farms / dm.farms, 0, 1) : 0;
      var bloom = clamp(0.25 * Math.max(0, fin(cl.tempAnomF, 0)) / 3 + 0.35 * (1 - storagePct) + 0.15 * farmRatio * (s === S.SUMMER ? 1 : 0.3) + 0.1 * r.ashContam, 0, 1);
      r.algae = clamp(r.algae * 0.5 + bloom * (s === S.SUMMER ? 0.6 : 0.15) + (flags.algaeBloom ? 0.2 : 0), 0, 1);
      if (flags.algaeBloom) flags.algaeBloom = false;
      if (r.algae > 0.5) notes.push('A warm, shallow pool is feeding an algae bloom (' + pct(r.algae) + '%), which fouls treatment and closes beaches.');

      // ---- soil moisture per cell ----
      var info = worldInfo(world), precipNormal = CAL.PRECIP_NORMAL_IN[s];
      var precipAnom = clamp(fin(cl.precipIn, precipNormal) / precipNormal - 1, -1, 2);
      var tAdj = -0.02 * fin(cl.tempAnomF, 0);
      var meltBonus = s === S.SPRING ? 0.08 * clamp(m.snowYear / 100, 0, 1.5) : 0;
      if (info && world.moisture) {
        var mo = world.moisture, land = world.land, burn = world.burn, rate = 0.35;
        var irrig = 0.25 * farmRatio * (CAL.FARM_SEASON[s] > 0 ? 1 : 0);
        for (i = 0; i < info.forest.length; i++) {
          var ci = info.forest[i];
          var target = 0.6 + 0.2 * precipAnom + tAdj + meltBonus - (burn ? 0.12 * fin(burn[ci], 0) : 0);
          mo[ci] = clamp(fin(mo[ci], 0.6) + (clamp(target, 0.05, 0.95) - fin(mo[ci], 0.6)) * rate, 0.05, 0.95);
        }
        for (i = 0; i < info.valley.length; i++) {
          ci = info.valley[i];
          var t = land[ci], base = t === L.FARM ? 0.45 + irrig : t === L.WETLAND ? 0.8 : t === L.RIPARIAN ? 0.65 : 0.4;
          target = base + 0.25 * precipAnom + tAdj + meltBonus * 0.5 - (burn ? 0.12 * fin(burn[ci], 0) : 0);
          mo[ci] = clamp(fin(mo[ci], 0.45) + (clamp(target, 0.05, 0.95) - fin(mo[ci], 0.45)) * rate, 0.05, 0.95);
        }
        cl.soilMoisturePct = Math.round(soilMoistureMean(world) * 1000) / 10;
      } else {
        var sm = clamp(fin(cl.soilMoisturePct, 45) / 100, 0, 1);
        cl.soilMoisturePct = Math.round(clamp(sm + (0.45 + 0.2 * precipAnom + tAdj - sm) * 0.35, 0.05, 0.95) * 1000) / 10;
      }

      // ---- crops ----
      var cropAvg = fin(cl.cropHealthAvg, 0.85);
      if (info && world.cropHealth && info.farm.length) {
        var ch = world.cropHealth, sumC = 0, irrigating = CAL.FARM_SEASON[s] > 0;
        var cropTarget = irrigating ? clamp(0.3 + 0.6 * farmRatio + 0.1 * clamp(precipAnom, -0.5, 0.5) - 0.06 * Math.max(0, fin(cl.tempAnomF, 0) - 3), 0.05, 1) : 0.75;
        var cropRate = s === S.SUMMER ? 0.5 : (irrigating ? 0.35 : 0.15);
        for (i = 0; i < info.farm.length; i++) {
          ci = info.farm[i];
          var v = fin(ch[ci], 0.85);
          v += (cropTarget - v) * cropRate;
          if (world.burn && fin(world.burn[ci], 0) > 0.3) v = Math.min(v, 0.3);
          ch[ci] = clamp(v, 0, 1); sumC += ch[ci];
        }
        cropAvg = sumC / info.farm.length;
      } else if (CAL.FARM_SEASON[s] > 0) {
        cropAvg = clamp(cropAvg + (0.3 + 0.6 * farmRatio - cropAvg) * 0.4, 0, 1);
      } else cropAvg = clamp(cropAvg + (0.75 - cropAvg) * 0.15, 0, 1);
      cl.cropHealthAvg = Math.round(cropAvg * 1000) / 1000;
      stats.cropLossPct = Math.round(100 * clamp(1 - cropAvg / 0.85, 0, 1));

      // ---- recreation ----
      var poolScore = clamp(storagePct / CAL.REC_POOL_TARGET[s], 0, 1);
      var flowScore = dm.recreation > 0 ? clamp(delivered.recreation / dm.recreation, 0, 1) : 1;
      var recIndex = clamp((0.6 * poolScore + 0.4 * flowScore) * (1 - 0.5 * r.algae) * (1 - 0.3 * r.turbidity) * (flags.musselClosure ? 0.5 : 1), 0, 1);
      var visits = Math.round(CAL.REC_VISITS[s] * recIndex * (flags.tourismBoom ? 1.3 : 1));
      stats.recreationVisits = fin(stats.recreationVisits, 0) + visits;

      // ---- trust from service levels ----
      var hhShort = shortagePct.households;
      if (hhShort > 0.05) { state.trustDelta -= Math.min(4, hhShort * 10); notes.push('Households went short by ' + pct(hhShort) + '% (' + afStr(shortage.households) + ') — taps sputtered and complaints piled up.'); }
      else if (storagePct > 0.6 && shortagePct.farms < 0.05) state.trustDelta += 0.5;
      if (w.restriction === 'stage2') state.trustDelta -= 1; else if (w.restriction === 'stage1') state.trustDelta -= 0.5;
      if (shortagePct.farms > 0.15) notes.push('Farms received only ' + pct(1 - shortagePct.farms) + '% of their irrigation request; crop health is now ' + pct(cropAvg) + '%.');
      if (shortagePct.wildlife > 0.2 || !minFlowMet) notes.push('Releases below the dam fell to ' + Math.round(releaseCfs) + ' cfs, under the ' + H.MIN_FLOW_CFS + ' cfs instream-flow right — trout and cottonwoods suffer.');

      // ---- narrative notes ----
      var snowNote = null;
      if (s === S.SPRING) {
        var springShare = clamp(m.meltUsed - m.winterMeltFrac, 0, 1);
        if (cl.tempAnomF > 2 && springShare > 0.85) snowNote = 'Spring runoff came early: a warm April melted most of the ' + cl.snowpackPct + '% snowpack in a few weeks, leaving little for summer.';
        else if (m.snowYear < 70) snowNote = 'A thin snowpack (' + cl.snowpackPct + '% of average) and thirsty soils produced only ' + afStr(inflow) + ' of spring runoff, versus about ' + afStr(normalIn) + ' in a normal year.';
        else if (m.snowYear > 125) snowNote = 'Big snow year: ' + afStr(inflow) + ' of runoff arrived this spring' + (spill > 0 ? ' and the reservoir spilled ' + afStr(spill) : '') + '.';
        else snowNote = 'Spring runoff delivered ' + afStr(inflow) + ' (' + Math.round(100 * inflow / Math.max(1, normalIn)) + '% of normal).';
      } else if (s === S.WINTER && m.winterMeltFrac > 0.05) snowNote = 'Warm winter weather melted about ' + pct(m.winterMeltFrac) + '% of the pack early; it ran off in winter rather than filling the reservoir in spring.';
      else if (s === S.SUMMER && m.monsoon === 'strong') snowNote = 'A strong monsoon brought ' + cl.precipIn.toFixed(1) + ' in of rain' + (bs.scarFrac > 0.05 ? ' — and flashy, muddy flows off the burn scar' : ', easing irrigation demand') + '.';
      else if (s === S.SUMMER && m.monsoon === 'weak') snowNote = 'The monsoon never arrived: only ' + cl.precipIn.toFixed(1) + ' in of summer rain' + (cl.tempAnomF > 1 ? ' and temperatures ' + cl.tempAnomF.toFixed(1) + ' °F above normal' : '') + ' pushed demand to its peak.';
      if (snowNote) notes.unshift(snowNote);
      notes.unshift(C.SEASONS[s] + ' inflow was ' + afStr(inflow) + ' (' + Math.round(100 * inflow / Math.max(1, normalIn)) + '% of normal); the reservoir ended at ' + pct(storagePct) + '% of capacity with ' + afStr(endStorage) + ' in storage.');
      if (spill > 0 && s !== S.SPRING) notes.push('The reservoir filled and spilled ' + afStr(spill) + ' over the dam.');
      if (storagePct < 0.25) notes.push('Storage is down to ' + pct(storagePct) + '% of capacity (' + afStr(endStorage) + '); the dead pool is ' + afStr(H.RESERVOIR_DEAD_POOL_AF) + '.');
      if (bs.scarFrac > 0.05 && inflow > normalIn * 1.1) notes.push('The burn scar sped up runoff: inflow was ' + Math.round(100 * inflow / Math.max(1, normalIn)) + '% of normal for the season.');

      var report = {
        season: s, year: fin(state.year, 1), turn: fin(state.turn, 0),
        inflowAF: Math.round(inflow), availableAF: Math.round(available), outflowAF: Math.round(outflow), spillAF: Math.round(spill),
        evapAF: Math.round(evap), consumptiveAF: Math.round(consumptive), releaseAF: Math.round(release), fireReserveAF: Math.round(fireReserve), fireUsedAF: Math.round(fireUsed),
        startStorageAF: Math.round(startStorage), endStorageAF: Math.round(endStorage), storagePct: Math.round(storagePct * 1000) / 10,
        deliveries: delivered, shortages: shortage, shortagePct: shortagePct,
        releaseCfs: Math.round(releaseCfs * 10) / 10, minFlowMet: minFlowMet, legalOverride: legalOverride,
        cropHealthAvg: Math.round(cropAvg * 1000) / 1000, turbidity: Math.round(r.turbidity * 1000) / 1000, ashContam: Math.round(r.ashContam * 1000) / 1000,
        algae: Math.round(r.algae * 1000) / 1000, hydroMWh: hydroMWh, recreationIndex: Math.round(recIndex * 1000) / 1000, recreationVisits: visits,
        burnScarPct: Math.round(bs.scarFrac * 1000) / 10, inflowParts: w.inflowParts || { melt: 0, baseflow: 0, rain: 0 },
        notes: notes
      };
      state.lastSeasonReport = report;
      return report;
    },

    /** contaminate(state, world, sedimentTons, ashFraction) → { turbidityDelta, ashDelta, outageDays } (called by Flood). */
    contaminate: function (state, world, sedimentTons, ashFraction) {
      var out = { turbidityDelta: 0, ashDelta: 0, outageDays: 0 };
      if (!state) return out;
      var r = ensureReservoir(state), f = fx(state), flags = state.flags = state.flags || {}, stats = state.stats = state.stats || {};
      sedimentTons = Math.max(0, fin(sedimentTons, 0)); ashFraction = clamp(ashFraction, 0, 1);
      if (sedimentTons <= 0) return out;
      var storage = Math.max(500, r.storageAF);
      var dTurb = 0.9 * (1 - Math.exp(-sedimentTons / (0.25 * storage)));
      var mit = Array.isArray(state.mitigations) ? state.mitigations : [];
      var intakeProtect = false, sensor = false;
      for (var i = 0; i < mit.length; i++) { if (mit[i] && mit[i].type === 'intake_protect') intakeProtect = true; if (mit[i] && mit[i].type === 'sensor') sensor = true; }
      var dAsh = clamp(dTurb * ashFraction * 1.2, 0, 1);
      if (intakeProtect) { dTurb *= 0.55; dAsh *= 0.5; }
      if (f.multiLevelIntake) { dTurb *= 0.8; dAsh *= 0.75; }
      if (f.treatment) dAsh *= 0.7;
      dTurb = clamp(dTurb, 0, 1); dAsh = clamp(dAsh, 0, 1);
      var before = { t: r.turbidity, a: r.ashContam };
      r.turbidity = clamp(r.turbidity + dTurb, 0, 1);
      r.ashContam = clamp(r.ashContam + dAsh, 0, 1);
      // treatment capacity: beyond these levels the plant cannot make safe water
      var turbCap = f.treatment ? 0.75 : 0.55, ashCap = f.treatment ? 0.5 : 0.35;
      var excess = Math.max(0, r.turbidity - turbCap) + 1.5 * Math.max(0, r.ashContam - ashCap);
      var outage = excess > 0 ? Math.round(3 + excess * 60) : 0;
      if (outage > 0 && (sensor || f.sensorCoverage > 0)) outage = Math.round(outage / 2);
      outage = clamp(outage, 0, 45);
      if (outage > 0) {
        stats.contaminationOutageDays = fin(stats.contaminationOutageDays, 0) + outage;
        flags.contaminationEvents = fin(flags.contaminationEvents, 0) + 1;
        flags.outageDaysThisTurn = fin(flags.outageDaysThisTurn, 0) + outage;
        state.trustDelta = fin(state.trustDelta, 0) - Math.min(4, 1 + outage / 8);
        if (WS.State && WS.State.log) WS.State.log(state, 'Ash and sediment overwhelmed the treatment plant: boil-water notice for ' + outage + ' days.', 'bad');
      }
      stats.sedimentTons = fin(stats.sedimentTons, 0) + sedimentTons;
      out.turbidityDelta = Math.round((r.turbidity - before.t) * 1000) / 1000;
      out.ashDelta = Math.round((r.ashContam - before.a) * 1000) / 1000;
      out.outageDays = outage;
      return out;
    },

    /* exposed for tests / other modules (not part of the required API) */
    burnStats: burnStats, normalSeasonInflow: normalSeasonInflow, seasonInflow: function (state, world) { return seasonInflow(state, world).total; }, fx: fx
  };
})();
