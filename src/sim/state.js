/* Watershed — game state: create / serialize / deserialize / history / log / schedule. Runs in Node (no DOM). */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C;

  var TYPED = { Float32Array: root.Float32Array, Float64Array: root.Float64Array, Int32Array: root.Int32Array, Int16Array: root.Int16Array,
    Int8Array: root.Int8Array, Uint8Array: root.Uint8Array, Uint16Array: root.Uint16Array, Uint32Array: root.Uint32Array };

  function sectorObj(v) { var o = {}; for (var i = 0; i < C.SECTORS.length; i++) o[C.SECTORS[i]] = v; return o; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v); }

  /* ---- SPEC3 §C: player avatar ---- */
  var PLAYER_NAME_MAX = 24, PLAYER_DEFAULT_NAME = 'Director Rivera', PLAYER_TITLE = 'Water-Resilience Director';
  // Fixed, sensible default look (ids from SPEC3 §A): a field director with a cap and a clipboard.
  var DEFAULT_FACE = { skin: 's3', hair: 'short', hairColor: 'h1', eyes: 'round', brows: 'soft', mouth: 'smile', facialHair: 'none', glasses: 'none', hat: 'cap', outfit: 'o1', accessory: 'clipboard' };
  function defaultFace() { var f = {}; for (var k in DEFAULT_FACE) if (Object.prototype.hasOwnProperty.call(DEFAULT_FACE, k)) f[k] = DEFAULT_FACE[k]; return f; }
  function defaultPlayer() { return { name: PLAYER_DEFAULT_NAME, face: defaultFace(), title: PLAYER_TITLE }; }
  function normalizeFace(face, base) {
    var out = defaultFace(), src, k;
    if (isPlain(base)) for (k in base) if (Object.prototype.hasOwnProperty.call(base, k) && typeof base[k] === 'string') out[k] = base[k];
    if (isPlain(face)) for (k in face) if (Object.prototype.hasOwnProperty.call(face, k) && typeof face[k] === 'string') out[k] = face[k];
    // WS.Faces (SPEC3 §A) knows the option space; when it is loaded it fixes invalid ids so the spec always renders.
    if (WS.Faces && typeof WS.Faces.normalize === 'function') { try { src = WS.Faces.normalize(out); if (isPlain(src)) out = src; } catch (e) { /* keep out */ } }
    return out;
  }
  /** normalizePlayer(p, base?) → { name, face, title }: name trimmed / ≤ 24 chars (fallback default), face filled from `base` then defaults. */
  function normalizePlayer(p, base) {
    base = isPlain(base) ? base : defaultPlayer();
    p = isPlain(p) ? p : {};
    var raw = (p.name != null) ? p.name : base.name;
    var name = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, PLAYER_NAME_MAX).trim();
    if (!name) name = PLAYER_DEFAULT_NAME;
    var title = (typeof p.title === 'string' && p.title.trim()) ? p.title.trim().slice(0, 32) : PLAYER_TITLE;   // XP levels rename the title
    return { name: name, face: normalizeFace(p.face, base.face), title: title };
  }

  /** Full default state for the given opts. Every field in SPEC §3 is present. */
  function defaults(opts) {
    opts = opts || {};
    var seed = (opts.seed == null) ? 1 : opts.seed;
    var years = Math.max(1, Math.min(40, Math.round(num(opts.years, C.YEARS_DEFAULT))));
    var mode = (opts.mode === 'historical') ? 'historical' : 'simulated';
    return {
      seed: seed, mode: mode, years: years, turn: 0, year: 1, season: C.SEASON.WINTER, phase: C.PHASES.BOOT,
      budget: 8.5, annualBudget: 8.5, emergencyFund: 0,
      outcomes: { W: 70, E: 65, P: 72, F: 68, T: 60 }, resilience: 0, trustDelta: 0,
      population: C.HYDRO.BASE_POPULATION, growthRate: 0.012,
      climate: { snowpackPct: 100, snowpackPeakPct: 100, snowSWEin: C.HYDRO.AVG_SNOW_SWE_IN, precipIn: 3.2, tempAnomF: 0, soilMoisturePct: 45,
        fireDanger: 0.2, fireDangerLabel: 'Moderate', streamflowCfs: 60, windDirRad: 0.8, windMph: 8, drought: 'None', description: '',
        uncertainty: 0.15, fuelAvg: 0.62, cropHealthAvg: 0.85, burnScarPct: 0, droughtIndex: 0,
        model: { ar: 0, enso: 0, ensoPhase: 0, tempAr: 0, deficit: 0, snowYear: 100, lastSnowYear: 100, meltUsed: 0, winterMeltFrac: 0, monsoon: 'normal', windEvent: false } },
      reservoir: { storageAF: 32000, capacityAF: C.HYDRO.RESERVOIR_CAPACITY_AF, turbidity: 0.05, ashContam: 0, algae: 0 },
      water: { demands: sectorObj(0), alloc: sectorObj(1), delivered: sectorObj(0), shortage: sectorObj(0),
        availableAF: 0, inflowAF: 0, outflowAF: 0, releaseCfs: 0, restriction: 'none' },
      fire: { policy: 'managed', activeFire: null, seasonAcres: 0, totalAcres: 0, structuresLost: 0, fires: [], smokeDays: 0,
        crewFocus: null, responseBudget: 0, forcedIgnition: null },
      projects: { funded: {}, pendingBurn: null },
      mitigations: [], pendingStorm: null, scheduled: [],
      log: [], timeline: [], history: [],
      unlockedCases: [], seenCases: [],
      flags: {},
      stats: { floodDamageM: 0, sedimentTons: 0, contaminationOutageDays: 0, cropLossPct: 0, hydroMWh: 0, recreationVisits: 0 },
      lastSeasonReport: null,
      quiz: { asked: [], correct: 0, total: 0, streak: 0, best: 0, lastUnlocked: [] },   // field quiz: question ids asked, score, current / best streak
      xp: { points: 0, level: 1, grants: 0 },   // field XP from correct quiz answers; levels pay a knowledge grant and a title
      player: defaultPlayer()   // SPEC3 §C: set from the intro creator (main.js), carried by saves
    };
  }

  /** Deep-fill: every key in `def` exists in the result; values from `src` override (recursively for plain objects). */
  function fill(def, src) {
    if (!isPlain(src)) return def;
    var out = isPlain(def) ? def : {};
    var k;
    for (k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      var sv = src[k], dv = out[k];
      if (isPlain(sv) && isPlain(dv)) out[k] = fill(dv, sv);
      else if (typeof sv === 'number' && !isFinite(sv)) out[k] = (typeof dv === 'number') ? dv : 0;
      else if (sv === undefined) continue;
      else out[k] = sv;
    }
    return out;
  }

  function replacer(key, value) {
    if (key === 'activeFire') return null;               // live fire sims are never persisted
    if (typeof value === 'function') return undefined;
    if (value && typeof value === 'object' && ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      return { __typed: value.constructor.name, data: Array.prototype.slice.call(value) };
    }
    return value;
  }
  function reviver(key, value) {
    if (value && typeof value === 'object' && typeof value.__typed === 'string' && Array.isArray(value.data)) {
      var Ctor = TYPED[value.__typed] || root[value.__typed];
      if (typeof Ctor === 'function') { try { return new Ctor(value.data); } catch (e) { return value.data; } }
      return value.data;
    }
    return value;
  }

  var State = WS.State = {
    defaults: defaults,
    defaultPlayer: defaultPlayer,
    normalizePlayer: normalizePlayer,

    /** create({seed, years, mode}) -> state */
    create: function (opts) {
      var s = defaults(opts);
      s.phase = C.PHASES.BOOT;
      return s;
    },

    /** serialize(state) -> JSON string. Typed arrays are tagged; functions dropped; fire.activeFire saved as null. */
    serialize: function (state) {
      if (!state || typeof state !== 'object') state = defaults({});
      try { return JSON.stringify(state, replacer); }
      catch (e) { return JSON.stringify(defaults({ seed: state.seed, years: state.years, mode: state.mode }), replacer); }
    },

    /** deserialize(str) -> state with every spec'd field present (defaults fill anything missing or non-finite). */
    deserialize: function (str) {
      var parsed = null;
      if (str && typeof str === 'object') parsed = str;
      else { try { parsed = JSON.parse(String(str), reviver); } catch (e) { parsed = null; } }
      if (!isPlain(parsed)) return defaults({});
      var s = fill(defaults({ seed: parsed.seed, years: parsed.years, mode: parsed.mode }), parsed);
      // derived / invariants
      s.turn = Math.max(0, Math.round(num(s.turn, 0)));
      s.year = 1 + Math.floor(s.turn / 4);
      s.season = s.turn % 4;
      s.fire.activeFire = null;
      if (!Array.isArray(s.log)) s.log = [];
      if (!Array.isArray(s.timeline)) s.timeline = [];
      if (!Array.isArray(s.history)) s.history = [];
      if (!Array.isArray(s.scheduled)) s.scheduled = [];
      if (!Array.isArray(s.mitigations)) s.mitigations = [];
      if (!Array.isArray(s.unlockedCases)) s.unlockedCases = [];
      if (!Array.isArray(s.seenCases)) s.seenCases = [];
      if (!Array.isArray(s.fire.fires)) s.fire.fires = [];
      var ks = C.OUTCOME_KEYS;
      for (var i = 0; i < ks.length; i++) s.outcomes[ks[i]] = C.clamp(num(s.outcomes[ks[i]], 60), 0, 100);
      var cap = Math.max(1, num(s.reservoir.capacityAF, C.HYDRO.RESERVOIR_CAPACITY_AF));
      s.reservoir.capacityAF = cap;
      s.reservoir.storageAF = C.clamp(num(s.reservoir.storageAF, cap * 0.75), 0, cap * 1.2);
      for (i = 0; i < C.SECTORS.length; i++) {
        var k = C.SECTORS[i];
        s.water.alloc[k] = C.clamp(num(s.water.alloc[k], 1), 0, 1);
        s.water.demands[k] = Math.max(0, num(s.water.demands[k], 0));
        s.water.delivered[k] = Math.max(0, num(s.water.delivered[k], 0));
        s.water.shortage[k] = Math.max(0, num(s.water.shortage[k], 0));
      }
      s.player = normalizePlayer(s.player);
      if (!isPlain(s.quiz)) s.quiz = defaults({}).quiz;
      if (!Array.isArray(s.quiz.asked)) s.quiz.asked = [];
      if (!Array.isArray(s.quiz.lastUnlocked)) s.quiz.lastUnlocked = [];
      ['correct', 'total', 'streak', 'best'].forEach(function (k) { s.quiz[k] = Math.max(0, Math.round(num(s.quiz[k], 0))); });
      return s;
    },

    /** pushHistory(state, world?) — appends a per-turn snapshot. `world` is optional (used for fuelAvg / cropHealth if given). */
    pushHistory: function (state, world) {
      if (!state) return null;
      if (!Array.isArray(state.history)) state.history = [];
      var o = state.outcomes || {}, cl = state.climate || {}, r = state.reservoir || {}, w = state.water || {};
      var fuelAvg = num(cl.fuelAvg, 0.6), crop = num(cl.cropHealthAvg, 0.85);
      if (world && world.fuel && world.land) {
        var sum = 0, n = 0, cs = 0, cn = 0, L = C.LAND;
        for (var i = 0; i < world.land.length; i++) {
          if (world.land[i] === L.FOREST) { sum += world.fuel[i]; n++; }
          else if (world.land[i] === L.FARM && world.cropHealth) { cs += world.cropHealth[i]; cn++; }
        }
        if (n) fuelAvg = sum / n;
        if (cn) crop = cs / cn;
      }
      var hh = num(w.demands && w.demands.households, 0);
      var shortagePct = hh > 0 ? 100 * C.clamp(num(w.shortage && w.shortage.households, 0) / hh, 0, 1) : 0;
      var R = num(state.resilience, 0);
      if (!R && WS.Scoring && WS.Scoring.resilience) R = num(WS.Scoring.resilience(o), 0);
      var snap = {
        turn: num(state.turn, 0), year: num(state.year, 1), season: num(state.season, 0),
        storageAF: num(r.storageAF, 0), snowpackPct: num(cl.snowpackPct, 100), streamflowCfs: num(cl.streamflowCfs, 0),
        fireDanger: num(cl.fireDanger, 0), fuelAvg: fuelAvg, turbidity: num(r.turbidity, 0),
        W: num(o.W, 0), E: num(o.E, 0), P: num(o.P, 0), F: num(o.F, 0), T: num(o.T, 0), R: R,
        budget: num(state.budget, 0), cropHealth: crop, shortagePct: shortagePct, trust: num(o.T, 0)
      };
      state.history.push(snap);
      if (state.history.length > 400) state.history.splice(0, state.history.length - 400);
      return snap;
    },

    /** log(state, text, kind) kind: 'info'|'good'|'bad'|'warn'|'event' */
    log: function (state, text, kind) {
      if (!state) return null;
      if (!Array.isArray(state.log)) state.log = [];
      var kinds = { info: 1, good: 1, bad: 1, warn: 1, event: 1 };
      var entry = { turn: num(state.turn, 0), year: num(state.year, 1), season: num(state.season, 0),
        text: String(text == null ? '' : text), kind: kinds[kind] ? kind : 'info' };
      state.log.push(entry);
      if (state.log.length > 600) state.log.splice(0, state.log.length - 600);
      return entry;
    },

    /** schedule(state, turnsAhead, label, effect) — effect: { type:'outcome'|'budget'|'flag'|'demand'|'custom', key, value, text } */
    schedule: function (state, turnsAhead, label, effect) {
      if (!state) return null;
      if (!Array.isArray(state.scheduled)) state.scheduled = [];
      var ahead = Math.max(0, Math.round(num(turnsAhead, 1)));
      var eff = isPlain(effect) ? effect : { type: 'flag', key: String(label || 'scheduled'), value: true, text: '' };
      var types = { outcome: 1, budget: 1, flag: 1, demand: 1, custom: 1 };
      var item = { dueTurn: num(state.turn, 0) + ahead, label: String(label == null ? '' : label),
        effect: { type: types[eff.type] ? eff.type : 'flag', key: eff.key == null ? '' : eff.key, value: eff.value === undefined ? true : eff.value, text: eff.text == null ? '' : String(eff.text) } };
      state.scheduled.push(item);
      return item;
    }
  };
})();
