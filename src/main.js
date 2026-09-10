/* Watershed — game controller (§12). Exports WS.Game (+ window.game in the browser).
   The same turn loop (beginSeason / endSeason) drives both the browser game and the headless test driver:
   UI and Renderer are injected as adapters (real ones wrap WS.UI / WS.Renderer; headless ones are no-ops + decide callbacks). */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C;
  var SEASON = C.SEASON, PH = C.PHASES;

  /* ------------------------------------------------------------------ helpers */
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d == null ? 0 : d); }
  function clamp(v, a, b) { v = num(v, a); return v < a ? a : (v > b ? b : v); }
  function pct(v) { return Math.round(clamp(v, 0, 10) * 100) + '%'; }
  function fmtN(v) { return Math.round(num(v)).toLocaleString(); }
  function fmtAF(v) { return fmtN(v) + ' AF'; }
  function fmtM(v) { return '$' + (Math.round(num(v) * 10) / 10).toFixed(1) + 'M'; }
  function seasonName(s) { return C.SEASONS[((s % 4) + 4) % 4]; }
  function has(mod, fn) { return !!(WS[mod] && typeof WS[mod][fn] === 'function'); }
  function call(mod, fn) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (!has(mod, fn)) return undefined;
    try { return WS[mod][fn].apply(WS[mod], args); }
    catch (e) { if (typeof console !== 'undefined') console.error('WS.' + mod + '.' + fn + ' failed:', e); return undefined; }
  }
  function warn() { if (WS.DEBUG && typeof console !== 'undefined') console.warn.apply(console, arguments); }
  function zoneName(world, id) {
    if (!world || id == null || id < 0) return 'an unnamed sector';
    var z = (typeof world.zoneById === 'function') ? world.zoneById(id) : (world.zones || [])[id];
    return (z && z.name) ? z.name : ('sector ' + id);
  }
  function zonesOf(world, type) {
    if (!world) return [];
    if (typeof world.zonesOf === 'function') { try { return world.zonesOf(type) || []; } catch (e) { return []; } }
    return (world.zones || []).filter(function (z) { return z.type === type; });
  }
  function scarCellsOf(world) {
    var out = [];
    if (!world || !world.burn) return out;
    for (var i = 0; i < world.burn.length; i++) if (world.burn[i] > 0.15) out.push(i);
    return out;
  }
  function stripTyped(obj, depth) {
    // JSON-safe shallow copy for state.lastSeasonReport (drops typed arrays / functions / huge frame lists)
    depth = depth || 0;
    if (obj == null || typeof obj !== 'object' || depth > 4) return (typeof obj === 'function') ? undefined : obj;
    if (ArrayBuffer.isView(obj)) return { length: obj.length };
    if (Array.isArray(obj)) return obj.slice(0, 64).map(function (v) { return stripTyped(v, depth + 1); });
    var out = {};
    Object.keys(obj).forEach(function (k) {
      if (k === 'frames' || k === 'cellsBurned' || k === 'floodedCells' || k === 'placeable' || k === 'scarCells' || k === 'sim' || k === 'floodTimeline' || k === 'arrivalFrame' || k === 'floodedByFrame' || k === 'report') return;
      var v = stripTyped(obj[k], depth + 1);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }
  function fallbackState(opts) {
    // Only used when WS.State is missing (graceful degradation). Mirrors §3.
    var alloc = {}, zero = {};
    C.SECTORS.forEach(function (s) { alloc[s] = 1; zero[s] = 0; });
    return {
      seed: opts.seed, mode: opts.mode || 'simulated', years: opts.years || C.YEARS_DEFAULT, turn: 0, year: 1, season: 0, phase: PH.BOOT,
      budget: 12, annualBudget: 12, emergencyFund: 0,
      outcomes: { W: 70, E: 65, P: 72, F: 68, T: 60 }, resilience: 0, population: C.HYDRO.BASE_POPULATION, growthRate: 0.012,
      climate: { snowpackPct: 100, snowSWEin: 18, precipIn: 3.2, tempAnomF: 0, soilMoisturePct: 45, fireDanger: 0.2, fireDangerLabel: 'Moderate', streamflowCfs: 60, windDirRad: 0.8, windMph: 8, drought: 'None', description: '', uncertainty: 0.15 },
      reservoir: { storageAF: 32000, capacityAF: C.HYDRO.RESERVOIR_CAPACITY_AF, turbidity: 0.05, ashContam: 0, algae: 0 },
      water: { demands: Object.assign({}, zero), alloc: alloc, delivered: Object.assign({}, zero), shortage: Object.assign({}, zero), availableAF: 0, inflowAF: 0, outflowAF: 0, restriction: 'none' },
      fire: { policy: 'managed', activeFire: null, seasonAcres: 0, totalAcres: 0, structuresLost: 0, fires: [], smokeDays: 0 },
      projects: { funded: {}, pendingBurn: null }, mitigations: [], pendingStorm: null, scheduled: [], log: [], timeline: [], history: [],
      unlockedCases: [], seenCases: [], flags: {}, stats: { floodDamageM: 0, sedimentTons: 0, contaminationOutageDays: 0, cropLossPct: 0, hydroMWh: 0, recreationVisits: 0 },
      lastSeasonReport: null
    };
  }

  /* ------------------------------------------------------------------ adapters */
  // Renderer adapter: every method is a guarded call into WS.Renderer (or a no-op when headless / missing).
  var RENDER_FNS = ['init', 'setSeason', 'refreshWorld', 'setReservoir', 'setRiverFlow', 'setFire', 'setWeather', 'setWind', 'showDebris', 'clearDebris',
    'setOverlay', 'setHighlight', 'addMarker', 'removeMarker', 'clearMarkers', 'setPlacementCursor', 'flyTo', 'flyToZone', 'setTimeOfDay', 'onCellClick', 'onCellHover', 'getStats', 'dispose',
    // SPEC2 §C tactical APIs (guarded: a v1 renderer simply ignores them)
    'setTacticalMode', 'onCellPaint', 'setFlooded', 'playRetardantDrop', 'setFireIntensity', 'pulseZone'];
  function makeRenderer(real) {
    var r = { real: !!real };
    RENDER_FNS.forEach(function (fn) {
      r[fn] = real ? function () { return call.apply(null, ['Renderer', fn].concat(Array.prototype.slice.call(arguments))); } : function () { };
    });
    return r;
  }
  // UI adapter: every method returns a Promise. Headless: `decide` callbacks answer cards; everything else is a no-op.
  var UI_FNS = ['init', 'refresh', 'setPhase', 'showIntro', 'showEventCard', 'showEvidenceBoard', 'showSeasonReport', 'showCaseStudy', 'showEnd', 'showHelp', 'toast', 'ticker',
    'showFireBanner', 'startPlacement', 'updatePlacement', 'endPlacement', 'renderProjects', 'renderWater', 'renderFire', 'renderConditions', 'renderLog', 'setBusy', 'flashOutcome', 'tutorialStep', 'closeModal',
    // SPEC2 §D tactical HUD / after-action (guarded: missing fns resolve immediately, so crisis loops never stall)
    'showTactical', 'updateTactical', 'hideTactical', 'alert', 'showAfterAction'];
  function makeUI(real, decide) {
    var u = { real: !!real, decide: decide || {} };
    UI_FNS.forEach(function (fn) {
      u[fn] = real
        ? function () { try { return Promise.resolve(call.apply(null, ['UI', fn].concat(Array.prototype.slice.call(arguments)))); } catch (e) { return Promise.resolve(); } }
        : function () { return Promise.resolve(); };
    });
    if (!real) {
      u.showEventCard = function (card) {
        var idx = 0;
        try { if (typeof u.decide.card === 'function') idx = u.decide.card(card); } catch (e) { idx = 0; }
        idx = clamp(Math.floor(num(idx, 0)), 0, Math.max(0, ((card && card.choices) || []).length - 1));
        return Promise.resolve(idx);
      };
    }
    return u;
  }

  /* ------------------------------------------------------------------ game factory */
  /** createGame(opts) → game. opts: { seed, years, mode, tutorial, ui, renderer, decide, headless, save } */
  function createGame(opts) {
    opts = opts || {};
    var headless = !!opts.headless;
    var ui = opts.ui || makeUI(!headless, opts.decide);
    var renderer = opts.renderer || makeRenderer(!headless);
    var decide = opts.decide || {};
    var game = { formatters: C.fmt, headless: headless, ui: ui, renderer: renderer };
    var state = null, world = null, rng = null, speed = 1, ended = false, begun = false, running = false;
    var placement = null;      // active flood-prep placement session
    var crisis = null;         // active real-time crisis (SPEC2 §E): { mode:'fire'|'storm', paused, selected, ... }
    var paintUnsub = null, clickUnsub = null;   // renderer subscriptions (made once per renderer init, released on dispose/restart)
    var turnNotes = null;      // per-turn scratch used by the timeline builder
    var stats = { fires: 0, floods: 0, storms: 0, burns: 0, cards: 0, turns: 0 };
    var overlayModes = ['none', 'watershed', 'fire', 'moisture', 'burn'];
    var overlayMode = 'none';
    var evidenceShown = {};    // "topic:year" → true (auto-open once per season/year)
    var tutorialDone = false;

    // Skips waiting when the page is hidden (browsers throttle timers to ~1/s in background tabs, which would stall the season).
    function sleep(ms) { if (headless || (typeof document !== 'undefined' && document.hidden)) return Promise.resolve(); return new Promise(function (res) { setTimeout(res, Math.max(0, ms)); }); }
    function log(text, kind) {
      if (!state || !text) return;
      if (has('State', 'log')) call('State', 'log', state, text, kind || 'info');
      else { state.log = state.log || []; state.log.push({ turn: state.turn, text: text, kind: kind || 'info' }); }
    }
    function toast(text, kind) { if (text) ui.toast(text, kind || 'info'); }
    function effects() { return call('Projects', 'effects', state) || {}; }
    function fail(where, e) {
      if (typeof console !== 'undefined') console.error('Watershed error in ' + where + ':', e);
      toast('Something went wrong: ' + (e && e.message ? e.message : e), 'bad');
    }
    function setPhase(phase, info) { if (state) state.phase = phase; ui.setPhase(phase, info || {}); }
    function refresh() { ui.refresh(); }
    function capacity() {
      var cap = num(state && state.reservoir && state.reservoir.capacityAF, C.HYDRO.RESERVOIR_CAPACITY_AF);
      return cap * (1 + num(effects().reservoirCapacityBonus, 0));
    }
    function storageFrac() { return clamp(num(state.reservoir.storageAF) / Math.max(1, capacity()), 0, 1.2); }
    function pushReservoirVisual() {
      renderer.setReservoir(storageFrac(), num(state.reservoir.turbidity), num(state.reservoir.ashContam));
      renderer.setRiverFlow(num(state.climate.streamflowCfs, 40), num(state.reservoir.turbidity));
    }
    function weatherFromClimate(cl) {
      cl = cl || state.climate || {};
      var s = state.season;
      if (state.fire && state.fire.activeFire) return ['smoke', 0.9];
      if (s === SEASON.WINTER && num(cl.precipIn) > 0.4) return ['snow', clamp(num(cl.precipIn) / 4, 0.2, 1)];
      if (num(cl.fireDanger) > 0.7) return ['haze', clamp((num(cl.fireDanger) - 0.7) / 0.3 * 0.6 + 0.3, 0.3, 0.9)];
      if ((s === SEASON.SUMMER || s === SEASON.FALL) && num(cl.precipIn) > 2.2) return ['rain', clamp(num(cl.precipIn) / 6, 0.2, 0.8)];
      if (s === SEASON.SPRING && num(cl.precipIn) > 3.5) return ['rain', 0.35];
      return ['clear', 0];
    }
    function applyWeather() { var w = weatherFromClimate(); renderer.setWeather(w[0], w[1]); renderer.setWind(num(state.climate.windDirRad, 0.8), num(state.climate.windMph, 8)); }
    function affordable(costM) { return num(costM, 0) <= num(state.budget, 0) + 1e-9; }
    function scarAcres() { return scarCellsOf(world).length * C.ACRES_PER_CELL; }
    // localStorage can throw on access itself in sandboxed/previews contexts; always go through this guard.
    function storage() { try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; } }
    function autosave() {
      if (headless) return;
      try { var ls = storage(); if (ls) ls.setItem('watershed.save', game.serialize()); } catch (e) { warn('autosave failed', e); }
    }

    /* ---------------------------------------------------- world / state construction */
    function build(o) {
      var seed = (o.seed == null) ? 1 : o.seed;
      world = has('World', 'generate') ? call('World', 'generate', seed) : null;
      state = has('State', 'create') ? call('State', 'create', { seed: seed, years: o.years || C.YEARS_DEFAULT, mode: o.mode || 'simulated' }) : null;
      if (!state) state = fallbackState({ seed: seed, years: o.years, mode: o.mode });
      if (!state.years) state.years = o.years || C.YEARS_DEFAULT;
      if (!state.timeline) state.timeline = [];
      if (!state.flags) state.flags = {};
      if (!state.stats) state.stats = {};
      state.tutorial = !!o.tutorial;
      rng = WS.RNG.create(seed);
      endCrisis();
      ended = false; begun = false; running = false; placement = null; evidenceShown = {}; tutorialDone = false;
      game.state = state; game.world = world;
      if (world && world.reservoir && state.reservoir && !state.reservoir.capacityAF) state.reservoir.capacityAF = world.reservoir.capacityAF;
    }
    game.serialize = function () {
      var s = has('State', 'serialize') ? call('State', 'serialize', state) : JSON.stringify(state);
      var layers = {};
      if (world) ['burn', 'fuel', 'moisture', 'treeDensity', 'cropHealth', 'habitat', 'regrow'].forEach(function (k) {
        if (world[k] && world[k].length) { var a = new Array(world[k].length); for (var i = 0; i < a.length; i++) a[i] = Math.round(world[k][i] * 1000) / 1000; layers[k] = a; }
      });
      return JSON.stringify({ v: C.VERSION, state: s, layers: layers, speed: speed, ended: ended, begun: begun });
    };
    game.deserialize = function (str) {
      var blob = JSON.parse(str);
      var st = has('State', 'deserialize') ? call('State', 'deserialize', blob.state) : JSON.parse(blob.state);
      if (!st) throw new Error('save file could not be parsed');
      build({ seed: st.seed, years: st.years, mode: st.mode, tutorial: false });
      state = st; game.state = state; state.timeline = state.timeline || []; state.flags = state.flags || {};
      if (world && blob.layers) Object.keys(blob.layers).forEach(function (k) {
        var src = blob.layers[k]; if (!src) return;
        if (!world[k]) world[k] = new Float32Array(src.length);
        for (var i = 0; i < Math.min(src.length, world[k].length); i++) world[k][i] = num(src[i]);
      });
      ended = !!blob.ended; begun = !!blob.begun;
      state.fire = state.fire || {}; state.fire.activeFire = null;
      turnNotes = freshNotes();
      if (state.phase === PH.LIVE || state.phase === PH.FLOOD || state.phase === PH.FLOOD_PREP || state.phase === PH.FIRE || state.phase === PH.STORM || state.phase === PH.REPORT) state.phase = PH.PLAN;
    };

    /* ---------------------------------------------------- evidence board / tutorial */
    async function openEvidence(topic, opts) {
      if (headless) return;
      var recs = call('Advisors', 'getRecommendations', state, world, topic) || [];
      opts = opts || {};
      opts.title = opts.title || ({ budget: 'Evidence Board — Winter budget', allocation: 'Evidence Board — Spring water allocation', prescribed_burn: 'Evidence Board — Prescribed burn', flood: 'Evidence Board — Storm over the burn scar', fire_policy: 'Evidence Board — Fire policy', contamination: 'Evidence Board — Water quality', drought: 'Evidence Board — Drought' }[topic] || 'Evidence Board');
      try { await ui.showEvidenceBoard(topic, recs, opts); } catch (e) { fail('evidence board', e); }
    }
    async function autoEvidence(topic, key, intro) {
      if (headless || evidenceShown[key]) return;
      evidenceShown[key] = true;
      await openEvidence(topic, { intro: intro });
    }
    async function runTutorial() {
      if (headless || tutorialDone || !state.tutorial) return;
      tutorialDone = true;
      // SPEC2 §D: three coach marks max — conditions → End Season → "when a fire starts you fight it live".
      var steps = [
        ['Welcome to Bitterbrush Creek. The Conditions panel shows this season\'s measurements — snowpack, reservoir storage, streamflow, fire danger and drought. Projects on the right cost money from your ' + fmtM(state.budget) + ' budget and change how fire, floods and drought play out later.', '#conditions'],
        ['When you are ready, press End Season ▶ (or Space). The season then plays out live: runoff fills or drains the reservoir, fires may ignite, and storms may hit burn scars.', '#primary-btn'],
        ['When a fire starts you fight it live: drag on the map to cut dozer lines, click to drop retardant, station engines and evacuate neighborhoods with a crew-point budget. Space pauses, 1–5 pick tools. Storms over a burn scar work the same way with sandbags, pumps and the spillway.', '#primary-btn']
      ];
      for (var i = 0; i < steps.length; i++) {
        try { var r = await ui.tutorialStep(steps[i][0], steps[i][1]); if (r === false || (r && r.skip)) break; } catch (e) { break; }
      }
    }

    /* ---------------------------------------------------- event cards */
    async function playCard(card, rngCards) {
      if (!card || !card.choices || !card.choices.length) return null;
      stats.cards++;
      var idx = 0;
      try { idx = await ui.showEventCard(card); } catch (e) { fail('event card', e); idx = 0; }
      idx = clamp(Math.floor(num(idx, 0)), 0, card.choices.length - 1);
      var choice = card.choices[idx];
      if (num(choice.costM, 0) > 0 && !affordable(choice.costM)) {
        // pick the first affordable choice instead (UI should have disabled it; be defensive)
        for (var j = 0; j < card.choices.length; j++) if (affordable(card.choices[j].costM)) { idx = j; choice = card.choices[j]; break; }
      }
      var res = null;
      try { res = (typeof choice.apply === 'function') ? choice.apply(state, world, rngCards.fork(card.id + ':' + idx)) : null; } catch (e) { fail('card ' + card.id, e); }
      if (num(choice.costM, 0) > 0) state.budget = Math.max(0, num(state.budget) - num(choice.costM));
      res = res || {};
      // NOTE: WS.Events choice.apply() already applies its delta (W/E/P/F → outcomes, T → trustDelta); we only flash + log it.
      if (res.delta) C.OUTCOME_KEYS.forEach(function (k) { if (num(res.delta[k], 0)) ui.flashOutcome(k); });
      C.OUTCOME_KEYS.forEach(function (k) { state.outcomes[k] = clamp(num(state.outcomes[k], 50), 0, 100); });
      var text = res.text || (card.title + ': ' + choice.label);
      log(card.title + ' — ' + choice.label + '. ' + (res.text || ''), card.severity === 'crisis' ? 'bad' : 'event');
      turnNotes.cards.push({ id: card.id, title: card.title, choice: choice.label, text: text, delta: res.delta || null, severity: card.severity });
      return { card: card, index: idx, result: res };
    }

    /* ---------------------------------------------------- beginSeason */
    async function beginSeason() {
      begun = true;
      turnNotes = freshNotes();
      state.year = 1 + Math.floor(state.turn / 4);
      state.season = state.turn % 4;
      state.trustDelta = 0;
      state.fire.seasonAcres = 0;
      state.mitigations = state.mitigations || [];
      var turnRng = rng.fork('turn' + state.turn);

      if (state.turn > 0 && state.season === SEASON.WINTER) {
        var growth = num(state.population) / C.HYDRO.BASE_POPULATION - 1;
        var bonus = Math.max(0, num(state.annualBudget, 12) * 0.5 * growth);
        state.budget = num(state.budget) + num(state.annualBudget, 12) + bonus;
        log('New year: budget +' + fmtM(num(state.annualBudget, 12) + bonus) + (bonus > 0.05 ? ' (includes ' + fmtM(bonus) + ' growth revenue)' : ''), 'good');
        call('Projects', 'tick', state, world);
        call('Fire', 'updateAnnual', state, world);
        state.population = Math.round(num(state.population, C.HYDRO.BASE_POPULATION) * (1 + num(state.growthRate, 0.012)));
      }
      call('Hydrology', 'generateSeasonClimate', state, world, turnRng.fork('climate'));
      if (!isFinite(num(state.climate.fireDanger, NaN))) state.climate.fireDanger = 0.2;
      turnNotes.preClimate = JSON.parse(JSON.stringify(state.climate));
      renderer.setSeason(state.season, state.climate);
      applyWeather();

      var scheduledTexts = call('Events', 'runScheduled', state, world) || [];
      scheduledTexts.forEach(function (t) { if (t) { log(t, 'event'); toast(t, 'warn'); turnNotes.scheduled.push(String(t)); } });

      call('Hydrology', 'computeDemands', state, world);
      call('Hydrology', 'computeAvailable', state, world);
      turnNotes.preStorage = num(state.reservoir.storageAF);
      turnNotes.preCrop = cropHealthAvg();
      call('State', 'pushHistory', state, world);
      pushReservoirVisual();
      refresh();

      var cards = call('Events', 'draw', state, world, turnRng.fork('events')) || [];
      setPhase(PH.EVENT, { cards: cards.length });
      for (var i = 0; i < cards.length; i++) { await playCard(cards[i], turnRng.fork('cards')); refresh(); }

      setPhase(PH.PLAN, { year: state.year, season: seasonName(state.season) });
      refresh();
      autosave();
      if (state.turn === 0) await runTutorial();
      // SPEC2 §D: the Evidence Board never auto-opens in Winter/Spring (the UI shows a pulsing "Advisors" button instead);
      // it still auto-opens before a prescribed burn and before a storm (see runPrescribedBurn / runFloodPrep).
      refresh();
    }
    function freshNotes() {
      return { cards: [], scheduled: [], preStorage: num(state && state.reservoir && state.reservoir.storageAF), preCrop: cropHealthAvg(),
               preClimate: state && state.climate ? JSON.parse(JSON.stringify(state.climate)) : null, notes: [], stormRisk: NaN };
    }
    function cropHealthAvg() {
      if (!world || !world.cropHealth || !world.land) return null;
      var s = 0, n = 0;
      for (var i = 0; i < world.land.length; i++) if (world.land[i] === C.LAND.FARM) { s += world.cropHealth[i]; n++; }
      return n ? s / n : null;
    }

    /* ---------------------------------------------------- Live phase pieces */
    async function runPrescribedBurn(turnRng) {
      var pb = state.projects && state.projects.pendingBurn;
      if (!pb) return null;
      var zoneId = (typeof pb === 'object') ? pb.zoneId : pb;
      await autoEvidence('prescribed_burn', 'burn:' + state.turn, 'Crews are ready to light the prescribed burn in ' + zoneName(world, zoneId) + '. Fire danger is ' + (state.climate.fireDangerLabel || 'unknown') + '.');
      renderer.flyToZone(zoneId);
      ui.ticker('Prescribed burn under way in ' + zoneName(world, zoneId));
      var res = call('Fire', 'prescribedBurn', state, world, zoneId, turnRng.fork('rxburn')) || null;
      state.projects.pendingBurn = null;
      stats.burns++;
      if (res) {
        res.zoneId = zoneId; res.zoneName = zoneName(world, zoneId);
        log('Prescribed burn in ' + res.zoneName + (res.escaped ? ' ESCAPED containment.' : ': fuel ' + Math.round(num(res.fuelBefore) * 100) + '% → ' + Math.round(num(res.fuelAfter) * 100) + '%.'), res.escaped ? 'bad' : 'good');
        renderer.refreshWorld();
        await sleep(600);
      }
      return res;
    }
    async function animateReservoir(fromAF, toAF, ms) {
      var frames = headless ? 1 : 20, cap = Math.max(1, capacity());
      for (var i = 1; i <= frames; i++) {
        var t = i / frames, af = fromAF + (toAF - fromAF) * t;
        renderer.setReservoir(clamp(af / cap, 0, 1.2), num(state.reservoir.turbidity), num(state.reservoir.ashContam));
        renderer.setRiverFlow(num(state.climate.streamflowCfs, 40), num(state.reservoir.turbidity));
        await sleep(ms / frames);
      }
    }
    function threatenedZones(cells) {
      var seen = {}, out = [];
      if (!world || !world.zone) return out;
      for (var i = 0; i < cells.length; i++) { var z = world.zone[cells[i]]; if (z >= 0 && !seen[z]) { seen[z] = true; out.push(z); } }
      return out;
    }
    /* ---------------------------------------------------- real-time crises (SPEC2 §E) */
    var INTENSITY = { creeping: 0.25, active: 0.5, running: 0.8, extreme: 1 };
    var FIRE_TOOL_ORDER = ['dozer', 'retardant', 'engine', 'evacuate', 'mutual_aid'];
    var STORM_TOOL_ORDER = ['sandbag', 'pump', 'evacuate', 'spillway'];
    var STORM_MARKER = { sandbag: 'sandbag', pump: 'pump', evacuate: 'evac', spillway: 'spillway' };
    var CORE_PROJECTS = ['streamgages', 'forest_thinning', 'prescribed_burn', 'home_hardening', 'wetland', 'irrigation', 'treatment', 'warning_system'];
    function fireTacticsAvailable() { return has('Fire', 'startTactics') && has('Fire', 'applyTactic'); }
    function liveToolsAvailable() { var T = WS.Flood && WS.Flood.TOOLS; return has('Flood', 'simulate') && !!(T && T.sandbag && T.sandbag.live); }
    // Pause = a promise the resume path resolves; nothing spins while paused (or while the tab is hidden and paused).
    function waitWhilePaused() {
      if (!crisis || !crisis.paused || headless) return Promise.resolve();
      return new Promise(function (res) { crisis.resume = res; });
    }
    function resumeCrisis() { if (crisis && crisis.resume) { var r = crisis.resume; crisis.resume = null; r(); } }
    function endCrisis() {
      if (!crisis) return;
      crisis.paused = false; resumeCrisis();
      crisis = null;
      renderer.setTacticalMode(false);
      renderer.setPlacementCursor(null);
      renderer.setHighlight(null, null);
      ui.hideTactical();
    }
    function currentSpec() { return !crisis ? null : (crisis.mode === 'fire' ? fireSpec() : stormSpec()); }
    function pushTactical() { if (crisis) ui.updateTactical(currentSpec()); }
    function alertOnce(key, text, kind, zoneId, color) {
      if (!crisis || crisis.alerted[key]) return;
      crisis.alerted[key] = true;
      ui.alert(text, kind || 'warn');
      if (zoneId != null && zoneId >= 0) renderer.pulseZone(zoneId, color || 0xff5a3c);
      log(text, kind === 'good' ? 'good' : (kind === 'info' ? 'info' : 'bad'));
    }
    function numWord(n) { n = Math.round(num(n)); var w = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']; return (n >= 0 && n < w.length) ? w[n] : fmtN(n); }
    function plural(n, one, many) { return Math.round(num(n)) === 1 ? one : (many || one + 's'); }
    function joinList(parts) { if (!parts.length) return ''; if (parts.length === 1) return parts[0]; return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]; }
    function compass(deg) { if (!isFinite(deg)) return ''; var n = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']; return n[Math.round((((deg % 360) + 360) % 360) / 45) % 8]; }
    function zoneCenterCell(zoneId) {
      var z = (world && typeof world.zoneById === 'function') ? world.zoneById(zoneId) : null;
      if (!z || !z.center) return -1;
      return C.idx(clamp(num(z.center.x) | 0, 0, C.N - 1), clamp(num(z.center.y) | 0, 0, C.N - 1));
    }
    function isNeighborhood(zoneId) { var z = (world && typeof world.zoneById === 'function') ? world.zoneById(zoneId) : null; return !!(z && z.type === 'neighborhood'); }
    function neighborhoodList() { return zonesOf(world, 'neighborhood').map(function (z) { return { id: z.id, name: z.name }; }); }
    function round2(v) { return Math.round(num(v) * 100) / 100; }

    /* ---- fire: threat / HUD spec / tactic application ---- */
    function fallbackThreat(fireSim, burningArr, prevAcres) {
      var acres = num(fireSim.acres), growth = acres - num(prevAcres, acres);
      var thr = threatenedZones(burningArr).map(function (z) { var zz = (world && world.zoneById) ? world.zoneById(z) : null; return { zoneId: z, name: zoneName(world, z), type: zz ? zz.type : 'forest', distanceCells: 0, burningInside: true }; }).slice(0, 6);
      return { acres: acres, perimeterCells: num(fireSim.perimeterCells), headingDeg: Math.round((num(fireSim.windDir, 0.8) * 180 / Math.PI + 360) % 360), windMph: num(fireSim.windSpeed, 8), windDirRad: num(fireSim.windDir, 0.8),
               threatened: thr, structuresLost: 0, structuresAtRisk: 0, upstreamAcres: 0, intensity: growth > 60 ? 'extreme' : growth > 30 ? 'running' : growth > 10 ? 'active' : 'creeping' };
    }
    function fireToolSpec() {
      var T = (WS.Fire && WS.Fire.TACTICS) || {}, cr = crisis, tac = cr.tactics || {};
      var pts = num(tac.crewPts), engines = Object.keys(tac.engines || {}).length;
      return FIRE_TOOL_ORDER.filter(function (t) { return T[t]; }).map(function (type) {
        var d = T[type], remaining = null, cooldown = null, disabled = false, reason = '', cost = '';
        if (type === 'dozer') { cost = num(d.costPts, 1) + ' pt/cell'; if (pts < num(d.costPts, 1)) { disabled = true; reason = 'No crew points left'; } }
        else if (type === 'retardant') {
          cost = num(d.costPts, 5) + ' pts'; remaining = Math.max(0, num(d.maxUses, 4) - num(tac.drops)); cooldown = num(tac.dropCooldown) > 0 ? Math.ceil(num(tac.dropCooldown)) : null;
          if (!remaining) { disabled = true; reason = 'No tanker sorties left'; } else if (cooldown) { disabled = true; reason = 'Tanker reloading (' + cooldown + ' steps)'; } else if (pts < num(d.costPts, 5)) { disabled = true; reason = 'Need ' + num(d.costPts, 5) + ' crew points'; }
        } else if (type === 'engine') {
          cost = num(d.costPts, 6) + ' pts'; remaining = Math.max(0, num(d.max, 2) - engines);
          if (!remaining) { disabled = true; reason = 'Every engine is deployed'; } else if (pts < num(d.costPts, 6)) { disabled = true; reason = 'Need ' + num(d.costPts, 6) + ' crew points'; }
        } else if (type === 'evacuate') { cost = 'free'; }
        else if (type === 'mutual_aid') {
          cost = fmtM(num(d.costM, 1.5)); remaining = tac.mutualAidUsed ? 0 : 1;
          if (tac.mutualAidUsed) { disabled = true; reason = 'Already called'; } else if (num(state.budget) + num(state.emergencyFund) < num(d.costM, 1.5)) { disabled = true; reason = 'Cannot afford ' + fmtM(num(d.costM, 1.5)); }
        }
        var out = { type: type, name: d.name || type, icon: d.icon || '', desc: d.desc || '', cost: cost, remaining: remaining, cooldown: cooldown, selected: cr.selected === type, disabled: disabled, reason: reason };
        if (type === 'engine' || type === 'evacuate') { out.zone = 'neighborhood'; out.zones = neighborhoodList(); }
        return out;
      });
    }
    function fireSpec() {
      var cr = crisis, th = cr.threat || {}, tac = cr.tactics || {};
      var dir = compass(th.headingDeg), first = (th.threatened || [])[0];
      var headline = 'Fire ' + (th.intensity || 'active') + ((th.intensity === 'running' || th.intensity === 'extreme') && dir ? ' ' + dir : '') + ' in ' + Math.round(num(th.windMph, 8)) + ' mph wind' +
        (first ? ' — ' + first.name + (first.burningInside ? ' burning' : ' ' + fmtN(first.distanceCells) + ' cells away') : '');
      var hint = { dozer: 'Drag on the map to cut a line', retardant: 'Click the map to drop retardant', engine: 'Pick a neighborhood for the engine', evacuate: 'Pick a neighborhood to evacuate', mutual_aid: 'Calls neighboring counties (+10 crew points)' }[cr.selected] || 'Pick a tool (1–5); Space pauses';
      return {
        mode: 'fire', title: 'WILDFIRE — ' + fmtN(th.acres) + ' acres', subtitle: cr.startName, step: cr.step, maxSteps: cr.maxSteps, paused: !!cr.paused, speed: speed,
        points: { label: 'Crew points', value: Math.round(num(tac.crewPts) * 10) / 10, max: num(tac.crewMax, 30), unit: 'pts' },
        tools: fireToolSpec(),
        threat: {
          headline: headline,
          rows: [
            { label: 'Acres', value: fmtN(th.acres), bad: num(th.acres) > 500 },
            { label: 'Homes at risk', value: fmtN(th.structuresAtRisk), bad: num(th.structuresAtRisk) > 0 },
            { label: 'Homes lost', value: fmtN(th.structuresLost), bad: num(th.structuresLost) > 0 },
            { label: 'Above reservoir', value: fmtN(th.upstreamAcres) + ' ac', bad: num(th.upstreamAcres) > 100 },
            { label: 'Wind', value: Math.round(num(th.windMph, 8)) + ' mph' + (dir ? ' → ' + dir : ''), bad: num(th.windMph) > 20 }
          ],
          threatened: (th.threatened || []).map(function (t) { return { name: t.name, type: t.type, distance: num(t.distanceCells), burning: !!t.burningInside }; })
        },
        hint: hint, zones: neighborhoodList()
      };
    }
    function applyFireTactic(type, target) {
      if (!crisis || crisis.mode !== 'fire') return { ok: false, reason: 'No fire to fight.' };
      var fs = crisis.fireSim, NN = C.N * C.N;
      if (type === 'dozer') target = (Array.isArray(target) ? target : (target != null ? [target] : [])).map(function (c) { return c | 0; }).filter(function (c) { return c >= 0 && c < NN; });
      if (type === 'retardant' && target != null && typeof target === 'object') target = C.idx(target.x | 0, target.y | 0);
      if ((type === 'engine' || type === 'evacuate') && (target == null || !isNeighborhood(+target))) return { ok: false, reason: 'Pick a neighborhood for ' + type + '.' };
      if (type === 'mutual_aid') target = null;
      var res = call('Fire', 'applyTactic', fs, state, world, type, target);
      if (!res) return { ok: false, reason: 'Tactics unavailable.' };
      if (res.ok) {
        var cells = res.cells || [];
        crisis.tactics = fs.tactics || crisis.tactics;
        if (type === 'dozer') {
          cells.forEach(function (i) { if (crisis.dig[i]) return; var p = C.xy(i); var id = 'dz-' + i; crisis.dig[i] = id; renderer.addMarker(id, 'digging', p.x, p.y); });
        } else if (type === 'retardant') {
          var p2 = C.xy(num(target, 0) | 0);   // the renderer's drop animation leaves the persistent 'retardant' tint marker itself
          renderer.playRetardantDrop(p2.x, p2.y, num(((WS.Fire.TACTICS || {}).retardant || {}).radius, 2));
        } else if (type === 'engine' || type === 'evacuate') {
          var zc = zoneCenterCell(+target);
          if (zc >= 0) { var p3 = C.xy(zc); renderer.addMarker(type + '-' + target, type === 'engine' ? 'engine' : 'evac', p3.x, p3.y); }
          renderer.pulseZone(+target, type === 'engine' ? 0xff3b30 : 0xffd166);
        } else if (type === 'mutual_aid') { ui.alert('Mutual aid is rolling — +10 crew points', 'good'); }
        if (res.text) { ui.ticker(res.text); log(res.text, 'info'); }
        crisis.actions.push({ type: type, step: crisis.step, cost: num(res.cost), cells: cells.length, target: (type === 'dozer') ? null : target, text: res.text || '' });
      }
      pushTactical();
      return res;
    }
    function lineHolding(tac, burning) {
      // a finished break cell with a burning 8-neighbour that itself has not ignited → "line holding"
      if (!tac || !tac.breaks || !crisis) return false;
      var keys = Object.keys(crisis.dig), N = C.N;
      for (var k = 0; k < keys.length; k++) {
        var i = +keys[k]; if (tac.breaks[i] !== 2 || burning[i]) continue;
        var x = i % N, y = (i / N) | 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue; var nx = x + dx, ny = y + dy;
          if (C.inBounds(nx, ny) && burning[ny * N + nx]) return true;
        }
      }
      return false;
    }
    function describeFireTactics(t) {
      var parts = [];
      if (num(t.cellsBroken) > 0) parts.push('dozer line');
      if (num(t.drops) > 0) parts.push(numWord(t.drops) + ' ' + plural(t.drops, 'drop'));
      if ((t.engines || []).length) parts.push(plural(t.engines.length, 'engine crew'));
      if ((t.evacuated || []).length) parts.push(plural(t.evacuated.length, 'evacuation'));
      if (t.mutualAid) parts.push('mutual aid');
      return joinList(parts);
    }
    function fallbackFireTactics(report) {
      // Used only when Fire.finalize did not attach `tactics` (older sim): built from what the player did + replayWithoutTactics.
      var tac = (crisis && crisis.tactics) || {}, used = {}, cellsBroken = 0, i;
      (crisis ? crisis.actions : []).forEach(function (a) { used[a.type] = (used[a.type] || 0) + 1; if (a.type === 'dozer') cellsBroken += a.cells; });
      if (tac.breaks) { cellsBroken = 0; for (i = 0; i < tac.breaks.length; i++) if (tac.breaks[i]) cellsBroken++; }
      var cf = call('Fire', 'replayWithoutTactics', crisis.fireSim, state, world) || null;
      var cfo = { acres: num(cf && cf.acres, num(report.acres)), structuresLost: num(cf && cf.structuresLost, num(report.structuresLost)), upstreamAcres: num(cf && cf.upstreamAcres, num(report.upstreamAcres)) };
      return { used: used, cellsBroken: cellsBroken, drops: num(tac.drops, used.retardant || 0), engines: Object.keys(tac.engines || {}).map(function (z) { return zoneName(world, +z); }), evacuated: Object.keys(tac.evacuated || {}).map(function (z) { return zoneName(world, +z); }),
               mutualAid: !!tac.mutualAidUsed, counterfactual: cfo, acresSaved: Math.max(0, cfo.acres - num(report.acres)), structuresSaved: Math.max(0, cfo.structuresLost - num(report.structuresLost)), injuries: 0, unnecessaryEvacs: 0, fallback: true };
    }
    function fireAfterAction(report) {
      var t = report.tactics || {}, cf = t.counterfactual || {};
      var did = [];
      if (num(t.cellsBroken) > 0) did.push('Cut ' + fmtN(t.cellsBroken) + ' cell' + (num(t.cellsBroken) === 1 ? '' : 's') + ' of dozer / hand line');
      if (num(t.drops) > 0) did.push(fmtN(t.drops) + ' air-tanker ' + plural(t.drops, 'drop'));
      (t.engines || []).forEach(function (n) { did.push('Engine crew stationed in ' + n); });
      (t.evacuated || []).forEach(function (n) { did.push('Evacuated ' + n); });
      if (t.mutualAid) did.push('Called mutual aid (+10 crew points)');
      if (!did.length) did.push('No tactics used — the fire ran unopposed');
      var what = describeFireTactics(t) || 'tactics';
      var summary = 'Without your ' + what + ': ' + fmtN(cf.acres) + ' acres and ' + fmtN(cf.structuresLost) + ' ' + plural(cf.structuresLost, 'home') + '. With them: ' + fmtN(report.acres) + ' acres and ' + fmtN(report.structuresLost) + ' ' + plural(report.structuresLost, 'home') + '.';
      return {
        mode: 'fire', kind: 'fire', title: 'After-action report — ' + (report.startZoneName || 'wildfire'), headline: fmtN(report.acres) + ' acres burned, ' + fmtN(report.structuresLost) + ' ' + plural(report.structuresLost, 'structure') + ' lost',
        acres: num(report.acres), structuresLost: num(report.structuresLost), upstreamAcres: num(report.upstreamAcres), injuries: num(t.injuries), unnecessaryEvacs: num(t.unnecessaryEvacs),
        stats: [
          { label: 'Acres burned', value: fmtN(report.acres), counterfactual: fmtN(cf.acres), good: num(cf.acres) > num(report.acres) },
          { label: 'Structures lost', value: fmtN(report.structuresLost), counterfactual: fmtN(cf.structuresLost), good: num(cf.structuresLost) > num(report.structuresLost) },
          { label: 'Acres above the reservoir', value: fmtN(report.upstreamAcres), counterfactual: fmtN(cf.upstreamAcres), good: num(cf.upstreamAcres) > num(report.upstreamAcres) }
        ],
        actions: did,
        // numeric counterfactual + the {label,value} columns / summary the after-action card renders
        counterfactual: {
          acres: num(cf.acres), structuresLost: num(cf.structuresLost), upstreamAcres: num(cf.upstreamAcres), summary: summary,
          without: [{ label: 'Acres burned', value: fmtN(cf.acres) }, { label: 'Homes lost', value: fmtN(cf.structuresLost) }, { label: 'Acres above the reservoir', value: fmtN(cf.upstreamAcres) }],
          'with': [{ label: 'Acres burned', value: fmtN(report.acres) }, { label: 'Homes lost', value: fmtN(report.structuresLost) }, { label: 'Acres above the reservoir', value: fmtN(report.upstreamAcres) }]
        },
        saved: { acres: num(t.acresSaved), structures: num(t.structuresSaved) }, summary: summary, tactics: t,
        lessons: [].concat(
          num(t.unnecessaryEvacs) > 0 ? ['Evacuating ' + numWord(t.unnecessaryEvacs) + ' ' + plural(t.unnecessaryEvacs, 'neighborhood') + ' the fire never reached cost public trust.'] : [],
          num(t.injuries) > 0 ? ['Fire reached homes that had not been evacuated — order evacuations before the front arrives.'] : [],
          num(report.upstreamAcres) > 100 ? [fmtN(report.upstreamAcres) + ' burned acres drain to the reservoir: expect a debris-flow storm within two seasons.'] : [])
      };
    }
    async function runFireTactical(fireSim, turnRng, origin, start, startName, zoneStart, initial) {
      var tac = call('Fire', 'startTactics', fireSim, state, world);
      tac = fireSim.tactics || tac;
      if (!tac || !tac.breaks) return null;          // sim could not start tactics → caller runs the watch-only fire
      var burning = {}, burned = {}, burningArr = [], burnedArr = [], acres = 0, steps = 0, prevAcres = 0;
      var maxSteps = Math.max(10, num(fireSim.maxSteps, 60)) + 5;
      var fireRng = turnRng.fork('firesteps');
      initial.forEach(function (i) { burning[i] = true; });
      burningArr = initial.slice();
      crisis = { mode: 'fire', fireSim: fireSim, tactics: tac, paused: false, selected: headless ? null : 'dozer', step: 0, maxSteps: Math.max(1, num(fireSim.maxSteps, 60)), threat: null,
                 alerted: {}, dig: {}, actions: [], startName: startName, lastPaintCell: null, holdStep: -99, resume: null };
      setPhase(PH.FIRE, { crisis: 'fire', acres: 0, name: startName, origin: origin });
      renderer.setTacticalMode(true);
      renderer.setFire(burningArr, []);
      crisis.threat = call('Fire', 'threat', fireSim, state, world) || fallbackThreat(fireSim, burningArr, 0);
      renderer.setFireIntensity(INTENSITY[crisis.threat.intensity] != null ? INTENSITY[crisis.threat.intensity] : 0.5);
      ui.showTactical(fireSpec());
      ui.alert('WILDFIRE — ' + startName + (origin === 'escape' ? ' (escaped burn)' : ''), 'fire');
      while (steps < maxSteps && crisis) {
        await waitWhilePaused();
        if (!crisis) break;
        if (headless && typeof decide.tactics === 'function') {
          try { (decide.tactics(fireSim, crisis.threat, steps) || []).forEach(function (a) { if (a && a.type) applyFireTactic(a.type, a.target); }); } catch (e) { fail('decide.tactics', e); }
          if (!crisis) break;
        }
        var r = call('Fire', 'step', fireSim, state, world, fireRng);
        steps++; crisis.step = steps;
        if (!r) break;
        (r.newlyBurning || []).forEach(function (i) { burning[i] = true; });
        (r.extinguished || []).forEach(function (i) { delete burning[i]; burned[i] = true; });
        burningArr = Object.keys(burning).map(Number); burnedArr = Object.keys(burned).map(Number);
        acres = num(r.acres, acres);
        state.fire.seasonAcres = acres;
        // digging → finished dozer line markers
        tac = fireSim.tactics || tac; crisis.tactics = tac;
        Object.keys(crisis.dig).forEach(function (k) {
          var i = +k, st = crisis.dig[k]; if (st === 'done' || st === 'lost' || !tac.breaks) return;
          if (tac.breaks[i] === 2) { var p = C.xy(i); renderer.removeMarker(st); renderer.addMarker('dzd-' + i, 'dozer', p.x, p.y); crisis.dig[k] = 'done'; }
          else if (tac.breaks[i] === 0) { renderer.removeMarker(st); crisis.dig[k] = 'lost'; }   // the fire overran the crew before the line was finished
        });
        var th = call('Fire', 'threat', fireSim, state, world) || fallbackThreat(fireSim, burningArr, prevAcres);
        crisis.threat = th;
        renderer.setFire(burningArr, burnedArr);
        renderer.setFireIntensity(INTENSITY[th.intensity] != null ? INTENSITY[th.intensity] : 0.5);
        (th.threatened || []).forEach(function (t) {
          if (!t || !t.burningInside || t.zoneId == null) return;
          if (t.type === 'neighborhood' || t.type === 'farm' || t.type === 'civic') alertOnce('zone:' + t.zoneId, 'Fire has reached ' + t.name + '!', 'bad', t.zoneId);
        });
        if (num(th.upstreamAcres) > 0) alertOnce('upstream', 'Fire is burning above the reservoir — ' + fmtN(th.upstreamAcres) + ' acres drain to your water supply', 'bad');
        if (steps - crisis.holdStep > 12 && lineHolding(tac, burning)) { crisis.holdStep = steps; ui.alert('Dozer line holding', 'good'); log('The dozer line is holding the fire.', 'good'); }
        if (!has('UI', 'showTactical')) ui.showFireBanner({ acres: Math.round(acres), threatened: (th.threatened || []).map(function (t) { return t.name; }), step: steps, perimeter: num(r.perimeterCells) });
        pushTactical();
        ui.ticker('Fire ' + (th.intensity || 'active') + ' — ' + fmtN(acres) + ' acres, ' + Math.round(num(tac.crewPts)) + ' crew pts');
        prevAcres = acres;
        if (r.done) break;
        await sleep(520 / speed);
      }
      var report = call('Fire', 'finalize', fireSim, state, world) || { acres: acres, upstreamAcres: 0, structuresLost: 0, zoneIds: threatenedZones(burnedArr), severityAvg: 0, smokeDays: 0, cellsBurned: new Int32Array(burnedArr), startCell: start };
      if (!report.tactics && crisis) { try { report.tactics = fallbackFireTactics(report); } catch (e) { warn('fallback tactics failed', e); } }
      report.startCell = report.startCell != null ? report.startCell : start;
      report.startZoneId = zoneStart; report.startZoneName = startName; report.origin = origin || 'ignition';
      report.actions = crisis ? crisis.actions.slice() : [];
      endCrisis();
      state.fire.activeFire = null;
      state.fire.seasonAcres = num(report.acres, acres);
      if (!has('Fire', 'finalize')) { state.fire.totalAcres = num(state.fire.totalAcres) + num(report.acres); state.fire.structuresLost = num(state.fire.structuresLost) + num(report.structuresLost); state.fire.smokeDays = num(state.fire.smokeDays) + num(report.smokeDays); }
      renderer.setFire([], burnedArr);
      renderer.setFireIntensity(0);
      renderer.refreshWorld();
      ui.showFireBanner(null);
      ui.ticker('Fire contained: ' + fmtN(report.acres) + ' acres burned' + (num(report.structuresLost) ? ', ' + fmtN(report.structuresLost) + ' structures lost' : ''));
      log('Fire contained at ' + fmtN(report.acres) + ' acres (' + fmtN(report.upstreamAcres) + ' above the reservoir); ' + fmtN(report.structuresLost) + ' structures lost.', 'bad');
      renderer.removeMarker('fire-start');
      report.afterAction = fireAfterAction(report);
      try { await ui.showAfterAction(report.afterAction); } catch (e) { fail('after-action report', e); }
      return report;
    }

    async function runFire(fireSim, turnRng, origin) {
      stats.fires++;
      state.fire.activeFire = fireSim;
      var start = (fireSim.startCell != null && fireSim.startCell >= 0) ? fireSim.startCell : (fireSim.start != null ? fireSim.start : null);
      var initial = [];
      if (fireSim.burning && typeof fireSim.burning.forEach === 'function') fireSim.burning.forEach(function (i) { initial.push(i); }); // Set or Array
      if (start == null && initial.length) start = initial[0];
      if (start != null && world) { var p = C.xy(start); renderer.addMarker('fire-start', 'fireStart', p.x, p.y); renderer.flyTo(p.x, p.y, 45); }
      renderer.setWeather('smoke', 0.8);
      var zoneStart = (world && world.zone && start != null) ? world.zone[start] : -1;
      var startName = zoneStart >= 0 ? zoneName(world, zoneStart)
        : (world && world.land && start != null ? 'the ' + (C.LAND_NAMES[world.land[start]] || 'open').toLowerCase() + ' country' + (world.isUpstreamOfReservoir && world.isUpstreamOfReservoir(start) ? ' above the reservoir' : ' below the dam') : 'the foothills');
      ui.ticker('Wildfire reported in ' + startName + (origin === 'escape' ? ' — the prescribed burn escaped!' : '!'));
      log('Wildfire ignited in ' + startName + (origin === 'escape' ? ' (escaped prescribed burn).' : '.'), 'bad');
      // fire response card: v1 only. The browser flow skips it when tactics exist (the player fights the fire live);
      // headless keeps it so decide.card / card counts behave as in v1.
      var tactical = fireTacticsAvailable();
      var card = call('Events', 'fireResponseCard', state, world, fireSim);
      if (card && (headless || !tactical)) await playCard(card, turnRng.fork('fireresp'));
      if (tactical) {
        var tr = null;
        try { tr = await runFireTactical(fireSim, turnRng, origin, start, startName, zoneStart, initial); } catch (e) { fail('fire tactics', e); endCrisis(); tr = null; }
        if (tr) return tr;
        if (fireSim.done) { // tactics loop failed after the sim ran out: finalize what we have rather than re-running it
          var rep0 = call('Fire', 'finalize', fireSim, state, world) || { acres: num(fireSim.acres), upstreamAcres: 0, structuresLost: 0, zoneIds: [], severityAvg: 0, smokeDays: 0, cellsBurned: new Int32Array(0), startCell: start };
          rep0.startCell = start; rep0.startZoneId = zoneStart; rep0.startZoneName = startName; rep0.origin = origin || 'ignition';
          state.fire.activeFire = null; renderer.setFire([], []); renderer.refreshWorld(); ui.showFireBanner(null); renderer.removeMarker('fire-start');
          return rep0;
        }
      }
      var burning = {}, burned = {}, burningArr = [], burnedArr = [], acres = 0, steps = 0;
      var maxSteps = Math.max(10, num(fireSim.maxSteps, 60)) + 5;
      var fireRng = turnRng.fork('firesteps');
      initial.forEach(function (i) { burning[i] = true; });
      while (steps < maxSteps) {
        var r = call('Fire', 'step', fireSim, state, world, fireRng);
        steps++;
        if (!r) break;
        (r.newlyBurning || []).forEach(function (i) { burning[i] = true; });
        (r.extinguished || []).forEach(function (i) { delete burning[i]; burned[i] = true; });
        burningArr = Object.keys(burning).map(Number); burnedArr = Object.keys(burned).map(Number);
        acres = num(r.acres, acres);
        state.fire.seasonAcres = acres;
        var threats = threatenedZones(burningArr).map(function (z) { return zoneName(world, z); });
        renderer.setFire(burningArr, burnedArr);
        ui.showFireBanner({ acres: Math.round(acres), threatened: threats, crewFocus: state.fire.crewFocus || null, step: steps, perimeter: num(r.perimeterCells) });
        ui.ticker('Fire spreading in ' + (threats[0] || startName) + ' — ' + fmtN(acres) + ' acres');
        if (r.done) break;
        await sleep(1000 / (6 * speed));
      }
      var report = call('Fire', 'finalize', fireSim, state, world) || { acres: acres, upstreamAcres: 0, structuresLost: 0, zoneIds: threatenedZones(burnedArr), severityAvg: 0, smokeDays: 0, cellsBurned: new Int32Array(burnedArr), startCell: start };
      report.startCell = report.startCell != null ? report.startCell : start;
      report.startZoneId = zoneStart; report.startZoneName = startName; report.origin = origin || 'ignition';
      state.fire.activeFire = null;
      state.fire.seasonAcres = num(report.acres, acres);
      // WS.Fire.finalize already accumulates totalAcres/structuresLost/smokeDays and pushes to state.fire.fires;
      // only do it here when the fallback report (module absent) was used.
      if (!has('Fire', 'finalize')) {
        state.fire.totalAcres = num(state.fire.totalAcres) + num(report.acres);
        state.fire.structuresLost = num(state.fire.structuresLost) + num(report.structuresLost);
        state.fire.smokeDays = num(state.fire.smokeDays) + num(report.smokeDays);
      }
      renderer.setFire([], burnedArr);
      renderer.refreshWorld();
      ui.showFireBanner(null);
      ui.ticker('Fire contained: ' + fmtN(report.acres) + ' acres burned' + (num(report.structuresLost) ? ', ' + fmtN(report.structuresLost) + ' structures lost' : ''));
      log('Fire contained at ' + fmtN(report.acres) + ' acres (' + fmtN(report.upstreamAcres) + ' above the reservoir); ' + fmtN(report.structuresLost) + ' structures lost.', 'bad');
      renderer.removeMarker('fire-start');
      await sleep(700);
      return report;
    }

    /* ---- flood prep + placement ---- */
    function toolList(prep) {
      var T = (WS.Flood && WS.Flood.TOOLS) || {};
      var eff = effects(), free = num(eff.stockpileBonus, 0);
      // live (during-storm) tools belong to the STORM phase toolbar, not the pre-storm placement one
      return Object.keys(T).filter(function (type) { return !(T[type] && T[type].live); }).map(function (type) {
        var d = T[type] || {};
        var sites = prep && prep.placeable && prep.placeable[type] ? prep.placeable[type].length : 0;
        return { type: type, name: d.name || type, desc: d.desc || '', costM: num(d.costM, 0.3), max: d.max || null, sites: sites, count: 0, free: (type === 'mulch' || type === 'barrier') ? free : 0 };
      });
    }
    function placementSpec() {
      if (!placement) return null;
      var p = placement, st = p.storm, fund = Math.round(num(state.emergencyFund) * 100) / 100;
      return {
        storm: st, prep: p.prep, tools: p.tools, budgetM: fund, budget: fund, emergencyBudget: Math.round(num(p.fundStart) * 100) / 100, spent: Math.round((num(p.fundStart) - fund) * 100) / 100,
        intensityIn: num(st.intensityIn), turnsUntil: num(st.turnsUntil, 0), daysUntil: Math.max(1, Math.round(num(st.turnsUntil, 0) * 30 || 3)),
        selected: p.selected, placed: state.mitigations.slice(),
        freeLeft: p.freeLeft, scarAcres: Math.round(num(p.prep && p.prep.scarAcres)), atRiskZones: (p.prep && p.prep.atRiskZones || []).map(function (z) { return zoneName(world, z); }),
        countdown: 'Storm arrives in ' + Math.max(1, Math.round(num(st.turnsUntil, 0) * 30 || 3)) + ' days — ' + num(st.intensityIn).toFixed(1) + ' in forecast',
        predictedPeakCfs: Math.round(num(p.prep && p.prep.predictedPeakCfs)), predictedSedimentTons: Math.round(num(p.prep && p.prep.predictedSedimentTons))
      };
    }
    function placeTool(type, x, y) {
      if (!placement || !placement.prep) return { ok: false, reason: 'No storm to prepare for.' };
      var tool = placement.tools.filter(function (t) { return t.type === type; })[0];
      if (!tool) return { ok: false, reason: 'Unknown tool ' + type };
      var i = C.idx(x, y);
      if (!C.inBounds(x, y)) return { ok: false, reason: 'Outside the map.' };
      var ok = has('Flood', 'canPlace') ? !!call('Flood', 'canPlace', placement.prep, type, i) : true;
      if (!ok) return { ok: false, reason: (tool.name || type) + ' cannot go there.' };
      if (state.mitigations.some(function (m) { return m.type === type && m.x === x && m.y === y; })) return { ok: false, reason: 'Already placed here.' };
      if (tool.max && tool.count >= tool.max) return { ok: false, reason: 'Only ' + tool.max + ' allowed.' };
      var isFree = tool.free > 0 && placement.freeLeft > 0;
      var cost = isFree ? 0 : tool.costM;
      if (cost > num(state.emergencyFund) + 1e-9) return { ok: false, reason: 'Emergency fund exhausted (' + fmtM(state.emergencyFund) + ' left).' };
      state.emergencyFund = num(state.emergencyFund) - cost;
      if (isFree) { placement.freeLeft--; tool.free--; }
      tool.count++;
      var m = { type: type, x: x, y: y, i: i, costM: cost };
      state.mitigations.push(m);
      renderer.addMarker('mit-' + state.mitigations.length, type, x, y);
      ui.updatePlacement(placementSpec());
      return { ok: true, mitigation: m };
    }
    async function runFloodPrep(storm, prep) {
      var eff = effects();
      // Emergency fund = $2.5M county baseline + $0.5M per stockpile placement + top-ups event cards already added to
      // state.emergencyFund (county reserve, state declaration, federal grant) + any explicit grant flag.
      var grant = 0;
      if (state.flags) { if (typeof state.flags.federalGrantM === 'number') grant += num(state.flags.federalGrantM); else if (state.flags.federalGrant === true || state.flags.federalFunding === true) grant += 2; }
      var base = 2.5 + 0.5 * num(eff.stockpileBonus, 0);
      state.emergencyFund = Math.round((base + grant + Math.max(0, num(state.emergencyFund))) * 100) / 100;
      state.mitigations = [];
      placement = { storm: storm, prep: prep, tools: toolList(prep), selected: null, freeLeft: num(eff.stockpileBonus, 0), done: null, fundStart: state.emergencyFund };
      setPhase(PH.FLOOD_PREP, { storm: storm });
      renderer.setWeather('rain', 0.25);
      if (prep && prep.scarCells && prep.scarCells.length && world) {
        var sx = 0, sy = 0, n = prep.scarCells.length;
        for (var k = 0; k < n; k++) { var p = C.xy(prep.scarCells[k]); sx += p.x; sy += p.y; }
        renderer.flyTo(Math.round(sx / n), Math.round(sy / n), 70);
      }
      log('Storm forecast: ' + num(storm.intensityIn).toFixed(1) + ' in over a ' + fmtN(prep && prep.scarAcres) + '-acre burn scar. Emergency fund ' + fmtM(state.emergencyFund) + '.', 'warn');
      if (headless) {
        var picks = [];
        try { if (typeof decide.placements === 'function') picks = decide.placements(prep, placement.tools, state.emergencyFund) || []; } catch (e) { fail('decide.placements', e); }
        picks.forEach(function (pk) { if (pk && pk.type != null) placeTool(pk.type, pk.x | 0, pk.y | 0); });
      } else {
        await autoEvidence('flood', 'flood:' + state.turn, 'A storm is forecast over the burn scar. Your advisors argue over where the ' + fmtM(state.emergencyFund) + ' emergency fund should go.');
        var donePromise = new Promise(function (res) { placement.done = res; });
        try { await Promise.race([ui.startPlacement(placementSpec()), donePromise]); } catch (e) { fail('placement', e); }
      }
      renderer.setPlacementCursor(null);
      ui.endPlacement();
      var summary = {};
      state.mitigations.forEach(function (m) { summary[m.type] = (summary[m.type] || 0) + 1; });
      var parts = Object.keys(summary).map(function (t) { return summary[t] + ' × ' + t.replace('_', ' '); });
      toast(parts.length ? 'Bracing for the storm with ' + parts.join(', ') : 'No mitigation placed — bracing for the storm.', parts.length ? 'info' : 'warn');
      placement = null;
      return state.mitigations.slice();
    }
    /* ---- storm: live tools / HUD spec ---- */
    function damCell() {
      if (has('Flood', 'placeableLive') && crisis) { var pl = call('Flood', 'placeableLive', crisis.prep, world, 'spillway'); if (pl && pl.length) return pl[0] | 0; }
      if (world && world.reservoir && world.reservoir.dam) return C.idx(world.reservoir.dam.x | 0, world.reservoir.dam.y | 0);
      return -1;
    }
    function liveCount(type) { return crisis ? crisis.live.filter(function (m) { return m.type === type; }).length : 0; }
    function placeLive(type, x, y, zoneId) {
      if (!crisis || crisis.mode !== 'storm') return { ok: false, reason: 'No storm under way.' };
      var T = (WS.Flood && WS.Flood.TOOLS) || {}, d = T[type];
      if (!d || !d.live) return { ok: false, reason: 'Unknown live tool ' + type + '.' };
      var name = d.name || type, i = -1, isZone = (type === 'evacuate' || !!d.zone), isOnce = (type === 'spillway' || !!d.once);
      if (isZone) {
        if (zoneId == null && x != null && y != null && world && world.zone && C.inBounds(x | 0, y | 0)) zoneId = world.zone[C.idx(x | 0, y | 0)];
        zoneId = (zoneId == null) ? -1 : +zoneId;
        if (!isNeighborhood(zoneId)) return { ok: false, reason: 'Pick a neighborhood to evacuate.' };
        if (crisis.evacuated[zoneId]) return { ok: false, reason: zoneName(world, zoneId) + ' is already evacuated.' };
        i = zoneCenterCell(zoneId);
      } else if (isOnce) {
        if (liveCount(type) > 0) return { ok: false, reason: name + ' can only be used once.' };
        i = damCell();
      } else {
        x = x | 0; y = y | 0;
        if (!C.inBounds(x, y)) return { ok: false, reason: 'Outside the map.' };
        i = C.idx(x, y);
      }
      if (i < 0) return { ok: false, reason: 'No place for ' + name + '.' };
      var p = C.xy(i); x = p.x; y = p.y;
      if (has('Flood', 'canPlace') && !call('Flood', 'canPlace', crisis.prep, type, i)) return { ok: false, reason: name + ' cannot go there.' };
      if (crisis.live.some(function (m) { return m.type === type && m.i === i; })) return { ok: false, reason: 'Already placed here.' };
      if (d.max && liveCount(type) >= d.max) return { ok: false, reason: 'Only ' + d.max + ' ' + plural(d.max, name) + ' available.' };
      var cost = Math.max(0, num(d.costM, 0));
      if (cost > num(state.emergencyFund) + 1e-9) return { ok: false, reason: 'Emergency fund exhausted (' + fmtM(state.emergencyFund) + ' left).' };
      state.emergencyFund = round2(num(state.emergencyFund) - cost);
      var m = { type: type, x: x, y: y, i: i, costM: cost, atFrame: crisis.frame, live: true };
      if (isZone) m.zoneId = zoneId;
      crisis.live.push(m); state.mitigations.push(m);
      renderer.addMarker('live-' + type + '-' + i + '-' + crisis.live.length, STORM_MARKER[type] || type, x, y);
      if (isZone) { crisis.evacuated[zoneId] = true; renderer.pulseZone(zoneId, 0xffd166); ui.alert('Evacuating ' + zoneName(world, zoneId), 'warn'); log('Evacuation ordered for ' + zoneName(world, zoneId) + '.', 'warn'); }
      else if (isOnce) { ui.alert('Emergency release — the dam gates are open', 'warn'); log('Emergency spillway release ordered at frame ' + (crisis.frame + 1) + '.', 'warn'); }
      pushTactical();
      return { ok: true, mitigation: m };
    }
    function stormToolSpec() {
      var T = (WS.Flood && WS.Flood.TOOLS) || {}, cr = crisis, fund = num(state.emergencyFund);
      return STORM_TOOL_ORDER.filter(function (t) { return T[t] && T[t].live; }).map(function (type) {
        var d = T[type], cost = num(d.costM, 0), remaining = null, disabled = false, reason = '';
        var costStr = cost > 0 ? ((cost < 0.1 ? '$' + Math.round(cost * 1000) + 'k' : fmtM(cost)) + (type === 'sandbag' ? '/cell' : '')) : 'free';
        if (d.max) { remaining = Math.max(0, d.max - liveCount(type)); if (!remaining) { disabled = true; reason = 'All ' + plural(d.max, d.name || type) + ' deployed'; } }
        if (type === 'spillway' || d.once) { remaining = liveCount(type) ? 0 : 1; if (!remaining) { disabled = true; reason = 'Gates already open'; } }
        if (!disabled && cost > fund + 1e-9) { disabled = true; reason = 'Emergency fund exhausted'; }
        var out = { type: type, name: d.name || type, icon: d.icon || '', desc: d.desc || '', cost: costStr, remaining: remaining, cooldown: null, selected: cr.selected === type, disabled: disabled, reason: reason };
        if (type === 'evacuate' || d.zone) { out.zone = 'neighborhood'; out.zones = neighborhoodList(); }
        return out;
      });
    }
    function stormSpec() {
      var cr = crisis, st = cr.storm || {}, prep = cr.prep || {}, first = cr.first || {};
      var nF = Math.max(1, cr.nFrames), f = cr.frame;
      var fbf = first.floodedByFrame, floodedNow = (fbf && fbf.length) ? num(fbf[Math.min(f, fbf.length - 1)], cr.flooded.length) : cr.flooded.length;
      var atRisk = (prep.atRiskZones || []).map(function (z) { return { id: z, name: zoneName(world, z), type: (world && world.zoneById && world.zoneById(z)) ? world.zoneById(z).type : 'neighborhood' }; });
      var wet = cr.lastZoneName;
      var headline = 'Flash flood — ' + num(st.intensityIn).toFixed(1) + ' in on the scar; ' + (wet ? 'water in ' + wet : (atRisk[0] ? 'water heading for ' + atRisk[0].name : 'water heading for town'));
      var hint = { sandbag: 'Drag along a street to lay sandbags', pump: 'Click a flooded street to pump it out', evacuate: 'Pick a neighborhood to evacuate', spillway: 'Opens the dam gates early (once)' }[cr.selected] || 'Pick a tool (1–4); Space pauses';
      return {
        mode: 'storm', title: 'FLASH FLOOD — ' + num(st.intensityIn).toFixed(1) + ' in', subtitle: fmtN(prep.scarAcres) + '-acre burn scar', step: Math.min(f + 1, nF), maxSteps: nF, paused: !!cr.paused, speed: speed,
        points: { label: 'Emergency fund', value: round2(state.emergencyFund), max: round2(cr.fundStart), unit: '$M' },
        tools: stormToolSpec(),
        threat: {
          headline: headline,
          rows: [
            { label: 'Rain', value: num(st.intensityIn).toFixed(1) + ' in / ' + num(st.durationHr, 2).toFixed(1) + ' h', bad: num(st.intensityIn) > 1.5 },
            { label: 'Peak through town', value: fmtN(first.peakCfsTown != null ? first.peakCfsTown : prep.predictedPeakCfsTown) + ' cfs', bad: num(first.peakCfsTown, prep.predictedPeakCfsTown) > 300 },
            { label: 'Flooded cells', value: fmtN(floodedNow), bad: floodedNow > 0 },
            { label: 'Damage (forecast)', value: fmtM(first.damageM != null ? first.damageM : prep.predictedDamageM), bad: num(first.damageM, prep.predictedDamageM) > 0.5 },
            { label: 'Sediment to reservoir', value: fmtN(first.sedimentToReservoir != null ? first.sedimentToReservoir : prep.predictedSedimentTons) + ' t', bad: num(first.sedimentToReservoir, prep.predictedSedimentTons) > 500 }
          ],
          threatened: atRisk.map(function (z) { return { name: z.name, type: z.type, distance: null, burning: !!cr.wetZones[z.id], flooded: !!cr.wetZones[z.id] }; })
        },
        hint: hint, zones: neighborhoodList()
      };
    }
    function describeStormTactics(t) {
      var parts = [];
      if (num(t.sandbagCells) > 0) parts.push('sandbag line');
      if (num(t.pumps) > 0) parts.push(numWord(t.pumps) + ' ' + plural(t.pumps, 'pump crew'));
      if ((t.evacuated || []).length) parts.push(plural(t.evacuated.length, 'evacuation'));
      if (t.spillwayUsed) parts.push('emergency release');
      return joinList(parts);
    }
    function fallbackStormTactics(first, final, live) {
      // Used only when Flood.simulate did not attach `tactics` (older sim). `first` = same storm, same pre-storm mitigations, no live tools.
      var ev = [], sb = 0, pumps = 0, spill = false;
      live.forEach(function (m) { if (m.type === 'sandbag') sb++; else if (m.type === 'pump') pumps++; else if (m.type === 'evacuate') ev.push(zoneName(world, m.zoneId)); else if (m.type === 'spillway') spill = true; });
      var cf = { damageM: num(first.damageM), floodedHouses: num(first.floodedHouses), injuriesRisk: num(first.injuriesRisk) };
      return { sandbagCells: sb, pumps: pumps, evacuated: ev, spillwayUsed: spill, counterfactual: cf, damageSaved: Math.max(0, cf.damageM - num(final.damageM)), housesSaved: Math.max(0, cf.floodedHouses - num(final.floodedHouses)), unnecessaryEvacs: 0, fallback: true };
    }
    function stormAfterAction(result, first) {
      var t = result.tactics || {}, cf = t.counterfactual || { damageM: num(first.damageM), floodedHouses: num(first.floodedHouses), injuriesRisk: num(first.injuriesRisk) };
      var did = [];
      if (num(t.sandbagCells) > 0) did.push('Sandbag line: ' + fmtN(t.sandbagCells) + ' cells');
      if (num(t.pumps) > 0) did.push(fmtN(t.pumps) + ' pump ' + plural(t.pumps, 'crew'));
      (t.evacuated || []).forEach(function (n) { did.push('Evacuated ' + n); });
      if (t.spillwayUsed) did.push('Emergency spillway release (' + fmtAF(num(result.releasedAF, 1500)) + ')');
      if (!did.length) did.push('No live measures — the water ran its course');
      var what = describeStormTactics(t) || 'live measures';
      var summary = 'Without your ' + what + ': ' + fmtM(cf.damageM) + ' and ' + fmtN(cf.floodedHouses) + ' ' + plural(cf.floodedHouses, 'home') + '. With them: ' + fmtM(result.damageM) + ' and ' + fmtN(result.floodedHouses) + ' ' + plural(result.floodedHouses, 'home') + '.';
      return {
        mode: 'storm', kind: 'storm', title: 'After-action report — burn-scar storm', headline: fmtM(result.damageM) + ' of flood damage, ' + fmtN(result.floodedHouses) + ' ' + plural(result.floodedHouses, 'home') + ' flooded',
        damageM: num(result.damageM), floodedHouses: num(result.floodedHouses), injuriesRisk: num(result.injuriesRisk), sedimentToReservoir: num(result.sedimentToReservoir), unnecessaryEvacs: num(t.unnecessaryEvacs, num(result.unnecessaryEvacs)),
        stats: [
          { label: 'Flood damage', value: fmtM(result.damageM), counterfactual: fmtM(cf.damageM), good: num(cf.damageM) > num(result.damageM) + 0.005 },
          { label: 'Homes flooded', value: fmtN(result.floodedHouses), counterfactual: fmtN(cf.floodedHouses), good: num(cf.floodedHouses) > num(result.floodedHouses) },
          { label: 'Injury risk', value: Math.round(num(result.injuriesRisk) * 100) + '%', counterfactual: Math.round(num(cf.injuriesRisk) * 100) + '%', good: num(cf.injuriesRisk) > num(result.injuriesRisk) + 0.005 }
        ],
        actions: did,
        counterfactual: {
          damageM: num(cf.damageM), floodedHouses: num(cf.floodedHouses), injuriesRisk: num(cf.injuriesRisk), summary: summary,
          without: [{ label: 'Flood damage', value: fmtM(cf.damageM) }, { label: 'Homes flooded', value: fmtN(cf.floodedHouses) }, { label: 'Injury risk', value: Math.round(num(cf.injuriesRisk) * 100) + '%' }],
          'with': [{ label: 'Flood damage', value: fmtM(result.damageM) }, { label: 'Homes flooded', value: fmtN(result.floodedHouses) }, { label: 'Injury risk', value: Math.round(num(result.injuriesRisk) * 100) + '%' }]
        },
        saved: { damageM: num(t.damageSaved), houses: num(t.housesSaved) }, summary: summary, tactics: t,
        lessons: [].concat(
          (num(t.sandbagCells) > 0 && num(t.damageSaved) < 0.05) ? ['Sandbags laid after the water arrives work at 40% — lay them ahead of the flow next time.'] : [],
          t.spillwayUsed ? ['The emergency release blunted the pulse but cost ' + fmtAF(num(result.releasedAF, 1500)) + ' of storage and surged the downstream farms.'] : [],
          num(t.unnecessaryEvacs, num(result.unnecessaryEvacs)) > 0 ? ['A neighborhood was evacuated that never flooded — trust dips.'] : [],
          num(result.sedimentToReservoir) > 500 ? [fmtN(result.sedimentToReservoir) + ' t of sediment reached the reservoir; pre-storm mulch and debris basins are what stop that.'] : [])
      };
    }
    async function runFlood(storm, prep, mitigations) {
      stats.floods++;
      var pre = (mitigations || []).slice(), live = [];
      var tactical = liveToolsAvailable();
      setPhase(tactical ? PH.STORM : PH.FLOOD, { storm: storm, crisis: tactical ? 'storm' : null });
      renderer.setWeather('storm', 1);
      ui.ticker('Storm over the burn scar — ' + num(storm.intensityIn).toFixed(1) + ' in of rain');
      // 1. first pass: the storm with only the pre-storm measures — its frames/floodTimeline are what the player watches and fights
      var first = call('Flood', 'simulate', state, world, storm, pre) || null;
      var result = first, cf = null, attrib = [], aa = null;
      if (first && tactical) {
        crisis = { mode: 'storm', storm: storm, prep: prep, first: first, frame: 0, nFrames: Math.max((first.frames || []).length, (first.floodTimeline || []).length), live: live, evacuated: {}, wetZones: {}, lastZoneName: null,
                   paused: false, selected: headless ? null : 'sandbag', alerted: {}, flooded: [], floodedSet: new Uint8Array(C.N * C.N), resume: null, fundStart: num(state.emergencyFund), lastPaintCell: null };
        renderer.setTacticalMode(true);
        ui.showTactical(stormSpec());
        ui.alert('FLASH FLOOD — ' + num(storm.intensityIn).toFixed(1) + ' in on the burn scar', 'flood');
      }
      try {
        if (first) {
          var frames = first.frames || [], timeline = first.floodTimeline || [], turb0 = num(state.reservoir.turbidity), dT = num(first.contamination && first.contamination.turbidityDelta, 0), cap = Math.max(1, capacity());
          var nF = Math.max(frames.length, timeline.length), flooded = crisis ? crisis.flooded : [], floodedSet = crisis ? crisis.floodedSet : new Uint8Array(C.N * C.N);
          for (var f = 0; f < nF; f++) {
            if (crisis) {
              await waitWhilePaused();
              if (!crisis) break;
              crisis.frame = f;
              if (headless && typeof decide.liveTools === 'function') {
                try { (decide.liveTools(first, f, { prep: prep, storm: storm, world: world, live: live }) || []).forEach(function (a) { if (a && a.type) placeLive(a.type, a.x, a.y, a.zoneId); }); } catch (e) { fail('decide.liveTools', e); }
                if (!crisis) break;
              }
            }
            if (frames[f]) renderer.showDebris(frames[f]);
            var tl = timeline[f];
            if (tl && tl.length) {
              var newZones = [];
              for (var k = 0; k < tl.length; k++) { var ci = tl[k]; if (ci >= 0 && ci < floodedSet.length && !floodedSet[ci]) { floodedSet[ci] = 1; flooded.push(ci); var z = world && world.zone ? world.zone[ci] : -1; if (crisis && z >= 0 && !crisis.wetZones[z]) { crisis.wetZones[z] = true; newZones.push(z); } } }
              renderer.setFlooded(flooded);
              newZones.forEach(function (z) { var zz = (world && world.zoneById) ? world.zoneById(z) : null; if (crisis && zz && (zz.type === 'neighborhood' || zz.type === 'farm' || zz.type === 'civic')) { crisis.lastZoneName = zz.name; alertOnce('wet:' + z, 'Water has reached ' + zz.name + '!', 'bad', z, 0x4fa3ff); } });
            }
            var t = (f + 1) / nF;
            var turb = (frames[f] && isFinite(frames[f].reservoirTurbidity)) ? frames[f].reservoirTurbidity : (turb0 + dT * t);
            renderer.setReservoir(clamp(num(state.reservoir.storageAF) / cap, 0, 1.2), clamp(turb, 0, 1), num(state.reservoir.ashContam));
            if (!crisis && f === Math.floor(nF / 2) && world && world.reservoir && world.reservoir.center) renderer.flyTo(world.reservoir.center.x, world.reservoir.center.y, 60);
            if (crisis) { pushTactical(); ui.ticker('Flood water spreading — ' + fmtN(flooded.length) + ' cells under water, ' + fmtM(state.emergencyFund) + ' left'); }
            await sleep(1000 / (8 * speed));
          }
          // 2. final numbers: pre-storm + live measures (the live tools' atFrame decides their effectiveness)
          var all = pre.concat(live);
          if (live.length) result = call('Flood', 'simulate', state, world, storm, all) || first;
          cf = call('Flood', 'counterfactual', state, world, storm) || null;
          attrib = call('Flood', 'attribute', state, world, storm, all) || [];
          if (tactical && result && !result.tactics) result.tactics = fallbackStormTactics(first, result, live);
          var preBudget = num(state.budget), preFund = num(state.emergencyFund), preAF = num(state.reservoir.storageAF);
          call('Flood', 'applyResult', state, world, result);
          // spillway release: Flood.applyResult deducts result.releasedAF from storage; guard in case an older applyResult does not
          if (result.spillwayUsed && num(result.releasedAF) > 0 && Math.abs(num(state.reservoir.storageAF) - preAF) < 1) state.reservoir.storageAF = Math.max(0, preAF - num(result.releasedAF));
          result.paidM = Math.max(0, (preBudget + preFund) - (num(state.budget) + num(state.emergencyFund)));
          log('Storm: peak ' + fmtN(result.peakCfsReservoir) + ' cfs at the reservoir, ' + fmtN(result.sedimentToReservoir) + ' t of sediment reached the water, ' + fmtN(result.floodedHouses) + ' homes flooded, ' + fmtM(result.damageM) + ' damage.', 'bad');
          if (tactical) aa = stormAfterAction(result, first);
        }
      } catch (e) { fail('storm', e); }
      endCrisis();
      renderer.setFlooded([]);
      renderer.clearDebris();
      renderer.refreshWorld();
      pushReservoirVisual();
      renderer.setWeather('rain', 0.3);
      if (aa) { result.afterAction = aa; try { await ui.showAfterAction(aa); } catch (e) { fail('after-action report', e); } }
      await sleep(400);
      return { result: result, counterfactual: cf, attribution: attrib, first: first, live: live };
    }
    function stormThisSeason(turnRng) {
      var ps = state.pendingStorm;
      if (ps && typeof ps === 'object') {
        if (num(ps.turnsUntil, 0) <= 1) return { intensityIn: clamp(num(ps.intensityIn, 1.5), 0.8, 3.0), durationHr: num(ps.durationHr, 2), turnsUntil: 0, source: ps.source || 'event' };
        ps.turnsUntil = num(ps.turnsUntil) - 1;
        return null;
      }
      if ((state.season === SEASON.SUMMER || state.season === SEASON.FALL) && scarAcres() >= 300 && has('Flood', 'stormRisk')) {
        var risk = clamp(num(call('Flood', 'stormRisk', state, world), 0), 0, 1);
        turnNotes.stormRisk = risk;
        if (turnRng.fork('storm').chance(risk)) {
          var r2 = turnRng.fork('stormsize');
          return { intensityIn: Math.round(r2.range(0.8, 2.6) * 10) / 10, durationHr: Math.round(r2.range(1, 4) * 10) / 10, turnsUntil: 0, source: 'random' };
        }
      }
      return null;
    }

    /* ---------------------------------------------------- timeline (cause & effect) */
    function thinnedComparison(fireReport) {
      // acres burned within thinned vs unthinned forest sectors, as share of each sector
      if (!world || !world.zone || !fireReport || !fireReport.cellsBurned) return null;
      var thinned = effects().thinnedZones || {}, per = {};
      var cells = fireReport.cellsBurned;
      for (var k = 0; k < cells.length; k++) { var z = world.zone[cells[k]]; if (z >= 0) per[z] = (per[z] || 0) + 1; }
      var tBurn = 0, tTot = 0, uBurn = 0, uTot = 0, tName = null, uName = null, tShare = -1, uShare = -1;
      Object.keys(per).forEach(function (zid) {
        var z = (typeof world.zoneById === 'function') ? world.zoneById(+zid) : null;
        if (!z || z.type !== 'forest' || !z.cells) return;
        var share = per[zid] / Math.max(1, z.cells.length);
        if (num(thinned[zid], 0) > 0.1) { tBurn += per[zid]; tTot += z.cells.length; if (share > tShare) { tShare = share; tName = z.name; } }
        else { uBurn += per[zid]; uTot += z.cells.length; if (share > uShare) { uShare = share; uName = z.name; } }
      });
      if (!tTot || !uTot) return null;
      return { thinnedPct: Math.round(100 * tBurn / tTot), unthinnedPct: Math.round(100 * uBurn / uTot), thinnedAcres: Math.round(tBurn * C.ACRES_PER_CELL), unthinnedAcres: Math.round(uBurn * C.ACRES_PER_CELL), tName: tName, uName: uName };
    }
    function buildTimeline(ctx) {
      var out = [], hydro = ctx.hydro || {}, sName = seasonName(state.season).toLowerCase();
      var cl = turnNotes.preClimate || state.climate || {};
      var cap = Math.max(1, capacity());
      var dem = (state.water && state.water.demands) || {}, del = hydro.deliveries || (state.water && state.water.delivered) || {}, sh = hydro.shortages || (state.water && state.water.shortage) || {};
      function add(text, kind, delta) { if (text) out.push({ text: text, kind: kind || 'info', delta: delta || null }); }

      // 1. delayed consequences of earlier decisions
      (turnNotes.scheduled || []).forEach(function (t) { add('Consequence of an earlier decision: ' + t, 'event'); });

      // 2. climate → inflow
      if (state.season === SEASON.WINTER) {
        add('Snowpack reached ' + Math.round(num(cl.snowpackPct, 100)) + '% of average (' + num(cl.snowSWEin, 18).toFixed(1) + ' in SWE)' + (num(cl.uncertainty, 0.15) > 0.2 ? ' — but without streamgages your forecast carries ±' + Math.round(num(cl.uncertainty) * 100) + '% uncertainty' : '') + '; the reservoir ended winter at ' + Math.round(100 * num(hydro.endStorageAF, state.reservoir.storageAF) / cap) + '%.', 'info');
      } else {
        add((state.season === SEASON.SPRING ? 'Snowmelt' : 'Inflow') + ' delivered ' + fmtAF(hydro.inflowAF != null ? hydro.inflowAF : state.water.inflowAF) + ' this ' + sName + ' (drought stage ' + (cl.drought || 'None') + ', ' + (num(cl.tempAnomF) >= 0 ? '+' : '') + num(cl.tempAnomF).toFixed(1) + '°F); storage ended at ' + Math.round(100 * num(hydro.endStorageAF, state.reservoir.storageAF) / cap) + '% of capacity' + (num(hydro.spillAF) > 50 ? ' after spilling ' + fmtAF(hydro.spillAF) : '') + '.', 'info');
      }

      // 3. allocation consequences with counterfactual storage
      var totalShort = 0; Object.keys(sh).forEach(function (k) { totalShort += num(sh[k]); });
      var endAF = num(hydro.endStorageAF, state.reservoir.storageAF), cfAF = Math.max(0, endAF - totalShort);
      var farmReq = num(dem.farms), farmDel = num(del.farms);
      var crop = ctx.cropNow, cropBefore = turnNotes.preCrop;
      if (farmReq > 50) {
        var ratio = clamp(farmDel / farmReq, 0, 1.2);
        if (ratio < 0.97) {
          add('You delivered ' + Math.round(ratio * 100) + '% of farm requests: crop health ' + (crop != null && cropBefore != null ? (crop < cropBefore - 0.005 ? 'fell to ' : 'held at ') + Math.round(crop * 100) + '%' : 'suffered') + ', but the reservoir ended ' + sName + ' at ' + Math.round(100 * endAF / cap) + '% instead of ~' + Math.round(100 * cfAF / cap) + '%.', 'warn', { F: -1 });
        } else {
          add('Farms received their full ' + fmtAF(farmReq) + ' request' + (crop != null ? '; crop health ' + (cropBefore != null && crop > cropBefore + 0.005 ? 'recovered to ' : 'held at ') + Math.round(crop * 100) + '%' : '') + (totalShort < 50 ? ' — every sector was met, leaving storage at ' + Math.round(100 * endAF / cap) + '%.' : '.'), 'good');
        }
      }
      var hhReq = num(dem.households), hhShort = num(sh.households);
      if (hhReq > 0 && hhShort / hhReq > 0.03) add('Households were shorted ' + fmtAF(hhShort) + ' (' + Math.round(100 * hhShort / hhReq) + '% of demand)' + (state.water.restriction && state.water.restriction !== 'none' ? ' under ' + state.water.restriction + ' restrictions' : '') + ' — public trust and water security take the hit.', 'bad', { W: -1, T: -1 });
      if (hydro.legalOverride) add('You under-allocated a senior right: the tribal right and Colorado River delivery are legally senior, so ' + fmtAF(num(del.tribal) + num(del.downstream)) + ' was released from storage regardless, and the community noticed the attempt.', 'bad', { T: -2 });
      if (hydro.minFlowMet === false) add('Releases fell below the ' + C.HYDRO.MIN_FLOW_CFS + ' cfs instream flow right below the dam — fish and riparian habitat degrade until flows recover.', 'bad', { E: -1 });
      if (num(hydro.hydroMWh) > 0 && num(sh.hydro) / Math.max(1, num(dem.hydro)) > 0.3) add('Cutting hydro releases saved storage but generated only ' + fmtN(hydro.hydroMWh) + ' MWh — the co-op buys the difference on the market.', 'warn');

      // 4. prescribed burn
      var b = ctx.burnResult;
      if (b) {
        if (b.escaped) add('The prescribed burn in ' + b.zoneName + ' escaped containment' + (num(cl.fireDanger) > 0.5 ? ' — fire danger was ' + (cl.fireDangerLabel || 'High') + ', which triples escape risk' : ' (a 4% base risk that came true)') + '.', 'bad', { T: -3 });
        else add('Prescribed burn treated ' + fmtN(num(b.cellsTreated) * C.ACRES_PER_CELL) + ' acres of ' + b.zoneName + ': fuel load ' + Math.round(num(b.fuelBefore) * 100) + '% → ' + Math.round(num(b.fuelAfter) * 100) + '%, at the cost of a few smoky days.', 'good', { P: 1 });
      }

      // 5. fire
      var fr = ctx.fireReport, fuelStats = call('Fire', 'fuelStats', world) || {};
      if (fr) {
        add((fr.origin === 'escape' ? 'The escaped burn' : 'A wildfire') + ' in ' + fr.startZoneName + ' burned ' + fmtN(fr.acres) + ' acres' + (num(fr.upstreamAcres) > 0 ? ' — ' + fmtN(fr.upstreamAcres) + ' of them draining to the reservoir' : '') + (num(fr.structuresLost) > 0 ? ' — and destroyed ' + fmtN(fr.structuresLost) + ' structures' : '') + ' under ' + (cl.fireDangerLabel || 'unknown') + ' danger and ' + Math.round(num(cl.windMph, 8)) + ' mph winds.', 'bad', { P: -2, E: -1 });
        // SPEC2 §E: tactical counterfactual ("Your dozer line and two drops held the fire to 1,900 acres; without them it would have run 4,600 acres and taken 11 homes.")
        var ft = fr.tactics, fcf = ft && ft.counterfactual;
        if (ft && fcf) {
          var whatF = describeFireTactics(ft), fSaved = num(ft.acresSaved, num(fcf.acres) - num(fr.acres)), hSaved = num(ft.structuresSaved, num(fcf.structuresLost) - num(fr.structuresLost));
          if (whatF && (fSaved >= 25 || hSaved >= 1)) add('Your ' + whatF + ' held the fire to ' + fmtN(fr.acres) + ' acres; without ' + (whatF.indexOf(' and ') >= 0 || whatF.indexOf(',') >= 0 ? 'them' : 'it') + ' it would have run ' + fmtN(fcf.acres) + ' acres' + (num(fcf.structuresLost) > num(fr.structuresLost) ? ' and taken ' + fmtN(fcf.structuresLost) + ' ' + plural(fcf.structuresLost, 'home') + ' instead of ' + fmtN(fr.structuresLost) : '') + '.', 'good', { P: 1 });
          else if (whatF) add('Your ' + whatF + ' did not change the outcome much: ' + fmtN(fr.acres) + ' acres burned versus ' + fmtN(fcf.acres) + ' had you done nothing' + (num(fcf.structuresLost) !== num(fr.structuresLost) ? ' (' + fmtN(fr.structuresLost) + ' vs ' + fmtN(fcf.structuresLost) + ' homes)' : '') + '.', 'info');
          else add('No tactics were used against this fire; it ran its full ' + fmtN(fr.acres) + ' acres unopposed.', 'warn');
          if (num(ft.unnecessaryEvacs) > 0) add('You evacuated ' + numWord(ft.unnecessaryEvacs) + ' ' + plural(ft.unnecessaryEvacs, 'neighborhood') + ' the fire never reached — residents grumble about the false alarm.', 'warn', { T: -1 });
          if (num(ft.injuries) > 0) add('Fire reached ' + (ft.injuries === 1 ? 'a neighborhood' : 'neighborhoods') + ' that had not been evacuated — ' + fmtN(ft.injuries) + ' ' + plural(ft.injuries, 'injury', 'injuries') + ' reported.', 'bad', { P: -1 });
        }
        var cmp = thinnedComparison(fr);
        if (cmp) add('Thinning paid off: the fire burned ' + cmp.thinnedPct + '% of thinned ' + cmp.tName + ' but ' + cmp.unthinnedPct + '% of untreated ' + cmp.uName + ' (' + fmtN(cmp.thinnedAcres) + ' vs ' + fmtN(cmp.unthinnedAcres) + ' acres).', cmp.thinnedPct < cmp.unthinnedPct ? 'good' : 'info');
        else if (Object.keys(effects().thinnedZones || {}).length === 0) add('No sector had been thinned; every burned stand carried its full fuel load (watershed average fuel ' + Math.round(num(fuelStats.avg, 0.6) * 100) + '%).', 'warn');
        if (state.fire.policy === 'suppress_all') add('Your suppress-all policy builds fuel 60% faster than managed fire — average forest fuel now ' + Math.round(num(fuelStats.avg, 0.6) * 100) + '%, which drives both spread rate and burn severity (' + Math.round(num(fr.severityAvg) * 100) + '% average severity).', 'warn');
        else if (num(fr.severityAvg) > 0) add('Managed-fire policy kept average fuel near ' + Math.round(num(fuelStats.avg, 0.6) * 100) + '%; burn severity averaged ' + Math.round(num(fr.severityAvg) * 100) + '%.', 'info');
      } else if (num(cl.fireDanger) > 0.5 && state.season !== SEASON.WINTER) {
        var ch = call('Fire', 'seasonIgnitionChance', state, world);
        add('Fire danger was ' + (cl.fireDangerLabel || 'High') + (isFinite(ch) ? ' (' + Math.round(ch * 100) + '% ignition chance)' : '') + ', but no fire started this ' + sName + (state.fire.policy === 'suppress_all' ? ' — meanwhile fuel keeps accumulating under suppress-all (avg ' + Math.round(num(fuelStats.avg, 0.6) * 100) + '%)' : '') + '.', 'info');
      }

      // 6. flood / storm
      var fl = ctx.flood, res = fl && fl.result, cf = fl && fl.counterfactual, at = (fl && fl.attribution) || [];
      if (res) {
        var mit = ctx.mitigations || [], counts = {};
        mit.forEach(function (m) { counts[m.type] = (counts[m.type] || 0) + 1; });
        var mulchAcres = Math.round((counts.mulch || 0) * C.ACRES_PER_CELL * (1 + 2 * num((WS.Flood && WS.Flood.TOOLS && WS.Flood.TOOLS.mulch && WS.Flood.TOOLS.mulch.radius), 1)) * 1.0);
        var parts = [];
        if (counts.mulch) parts.push('mulch on ' + fmtN(mulchAcres) + ' acres');
        if (counts.debris_basin) parts.push(counts.debris_basin + (counts.debris_basin === 1 ? ' debris basin' : ' debris basins'));
        if (counts.barrier) parts.push(counts.barrier + ' log barriers');
        if (effects().wetlandRestored) parts.push('the restored wetland');
        var outage = num(res.contamination && res.contamination.outageDays), cfOutage = num(cf && cf.contamination && cf.contamination.outageDays);
        var turbNow = clamp(num(state.reservoir.turbidity), 0, 1), cfTurb = clamp(turbNow - num(res.contamination && res.contamination.turbidityDelta) + num(cf && cf.contamination && cf.contamination.turbidityDelta), 0, 1);
        if (parts.length && cf) {
          var trapped = num(res.trappedTons) || Math.max(0, num(cf.sedimentToReservoir) - num(res.sedimentToReservoir));
          var lead = parts.join(', ').replace(/^./, function (c) { return c.toUpperCase(); });
          if (cfTurb - turbNow >= 0.02 || cfOutage > outage) {
            add(lead + ' trapped ' + fmtN(trapped) + ' t of sediment; without them turbidity would have hit ' + cfTurb.toFixed(2) + ' instead of ' + turbNow.toFixed(2) + (cfOutage > outage ? ' and the treatment plant would have shut ' + fmtN(cfOutage) + ' days instead of ' + fmtN(outage) : outage > 0 ? '; the plant still shut ' + fmtN(outage) + ' days' : '') + '.', 'good', { W: 1 });
          } else if (trapped >= 20) {
            add(lead + ' trapped ' + fmtN(trapped) + ' t of sediment before it reached the water (' + fmtN(res.sedimentToReservoir) + ' t still got through); turbidity settled at ' + turbNow.toFixed(2) + ', low enough that the treatment plant ran normally.', 'good');
          } else {
            add('The ' + num(ctx.storm.intensityIn).toFixed(1) + ' in storm moved ' + fmtN(res.sedimentTons) + ' t of sediment off the scar, but only ' + fmtN(res.sedimentToReservoir) + ' t reached the reservoir (' + lead.toLowerCase() + ' caught ' + fmtN(trapped) + ' t); turbidity stayed near ' + turbNow.toFixed(2) + '.', 'info');
          }
          if (num(cf.damageM) > num(res.damageM) + 0.05) add('Flood damage came to ' + fmtM(res.damageM) + ' (' + fmtN(res.floodedHouses) + ' homes) versus ' + fmtM(cf.damageM) + ' had nothing been placed' + (num(cf.peakCfsTown) > 0 ? ' — peak flow through town ' + fmtN(res.peakCfsTown) + ' cfs instead of ' + fmtN(cf.peakCfsTown) + ' cfs' : '') + '.', 'good');
          else add('Flooding still caused ' + fmtM(res.damageM) + ' of damage (' + fmtN(res.floodedHouses) + ' homes); peak flow ' + fmtN(res.peakCfsReservoir) + ' cfs at the reservoir.', 'bad', { P: -1 });
        } else {
          add('With no mitigation on the scar, ' + num(ctx.storm.intensityIn).toFixed(1) + ' in of rain sent ' + fmtN(res.sedimentToReservoir) + ' t of sediment and ash into the reservoir (turbidity ' + turbNow.toFixed(2) + (outage > 0 ? ', treatment plant shut ' + fmtN(outage) + ' days' : '') + ') and caused ' + fmtM(res.damageM) + ' of flood damage.', 'bad', { W: -2, P: -1 });
        }
        // SPEC2 §E: live-tool counterfactual (same storm, same pre-storm measures, no live tools)
        var stt = res.tactics, scf = stt && stt.counterfactual;
        if (stt && scf) {
          var whatS = describeStormTactics(stt), dSaved = num(scf.damageM) - num(res.damageM), hS = num(scf.floodedHouses) - num(res.floodedHouses);
          if (whatS && (dSaved >= 0.05 || hS >= 1)) add('Your ' + whatS + ' held flood damage to ' + fmtM(res.damageM) + ' (' + fmtN(res.floodedHouses) + ' homes); without ' + (whatS.indexOf(' and ') >= 0 || whatS.indexOf(',') >= 0 ? 'them' : 'it') + ' it would have been ' + fmtM(scf.damageM) + ' and ' + fmtN(scf.floodedHouses) + ' homes.', 'good', { P: 1 });
          else if (whatS) add('Your ' + whatS + ' barely moved the needle: ' + fmtM(res.damageM) + ' of damage versus ' + fmtM(scf.damageM) + ' without them — sandbags laid after the water arrives work at 40%.', 'info');
          if (stt.spillwayUsed) add('Opening the spillway early swallowed the pulse below the dam but dumped ' + fmtAF(num(res.releasedAF, 1500)) + ' of storage and sent a surge through the downstream farms.', 'warn', { W: -1 });
          if (num(stt.unnecessaryEvacs, num(res.unnecessaryEvacs)) > 0) add('You evacuated ' + numWord(num(stt.unnecessaryEvacs, num(res.unnecessaryEvacs))) + ' ' + plural(num(stt.unnecessaryEvacs, num(res.unnecessaryEvacs)), 'neighborhood') + ' the water never reached — trust dips.', 'warn', { T: -1 });
        }
        var top = at.filter(function (a) { return a && (num(a.preventedDamageM) > 0.05 || num(a.preventedSedimentTons) > 20); }).sort(function (a, b) { return num(b.preventedDamageM) + num(b.preventedSedimentTons) / 1000 - num(a.preventedDamageM) - num(a.preventedSedimentTons) / 1000; })[0];
        if (top) {
          var gains = [];
          if (num(top.preventedDamageM) >= 0.05) gains.push(fmtM(top.preventedDamageM) + ' of damage');
          if (num(top.preventedSedimentTons) >= 1) gains.push(fmtN(top.preventedSedimentTons) + ' t of sediment');
          if (num(top.preventedOutageDays) >= 0.5) gains.push(Math.round(num(top.preventedOutageDays)) + ' outage days');
          if (gains.length) add('Biggest single contribution: ' + top.label + ' prevented ' + gains.join(' and ') + (isFinite(top.pct) && num(top.preventedSedimentTons) >= 1 ? ' (' + Math.round(num(top.pct) * (num(top.pct) <= 1 ? 100 : 1)) + '% of the sediment kept out of the reservoir)' : '') + '.', 'good');
        }
        var plume = outage > 0 || cfOutage > 0 || num(res.contamination && res.contamination.ashDelta) > 0.01 || num(res.contamination && res.contamination.turbidityDelta) > 0.03;
        if (res.earlyWarning && plume) add('The streamgage/sensor above the intake caught the turbidity plume early, so operators switched intakes in time — contamination outage ' + (outage > 0 ? 'halved to ' + fmtN(outage) + ' days' : 'avoided') + '.', 'good');
        else if (num(effects().sensorCoverage) === 0 && outage > 0) add('No sensor sat between the scar and the intake, so the plant learned of the plume when it arrived — outage lasted the full ' + fmtN(outage) + ' days.', 'warn');
        if (num(res.injuriesRisk) > 0.3 && !counts.warning && !effects().warningSystem) add('Injury risk in the flooded neighborhoods reached ' + Math.round(num(res.injuriesRisk) * 100) + '% — a warning system or siren placements would have cut it 80%.', 'bad');
      } else if (scarAcres() >= 300 && (state.season === SEASON.SUMMER || state.season === SEASON.SPRING) && isFinite(turnNotes.stormRisk)) {
        add('A ' + fmtN(scarAcres()) + '-acre burn scar sits in the watershed; a damaging storm had a ' + Math.round(turnNotes.stormRisk * 100) + '% chance this season and remains likely until the scar revegetates.', 'warn');
      }

      // 7. trust & other scoring reasons
      var reasons = (ctx.scoring && ctx.scoring.reasons) || [];
      var trust = reasons.filter(function (r) { return r && r.key === 'T' && r.text; });
      trust.slice(0, 2).forEach(function (r) { add('Trust: ' + r.text, num(r.delta) >= 0 ? 'good' : 'bad', { T: Math.round(num(r.delta) * 10) / 10 }); });
      reasons.filter(function (r) { return r && r.key !== 'T' && r.text && Math.abs(num(r.delta)) >= 2; }).sort(function (a, b) { return Math.abs(num(b.delta)) - Math.abs(num(a.delta)); }).slice(0, 2)
        .forEach(function (r) { add((C.OUTCOME_NAMES[r.key] || r.key) + ': ' + r.text, num(r.delta) >= 0 ? 'good' : 'bad'); });

      // 8. always give the player at least three sentences
      if (out.length < 3) {
        var d = ctx.scoring && ctx.scoring.delta;
        if (d) { var best = C.OUTCOME_KEYS.slice().sort(function (a, b2) { return Math.abs(num(d[b2])) - Math.abs(num(d[a])); })[0]; add((C.OUTCOME_NAMES[best]) + ' moved ' + (num(d[best]) >= 0 ? '+' : '') + num(d[best]).toFixed(1) + ' this season; resilience score now ' + Math.round(num(state.resilience)) + '.', num(d[best]) >= 0 ? 'good' : 'bad'); }
        add('Budget stands at ' + fmtM(state.budget) + '; ' + Object.keys((state.projects && state.projects.funded) || {}).length + ' projects funded so far, population ' + fmtN(state.population) + '.', 'info');
        if (out.length < 3) add('Water quality: turbidity ' + num(state.reservoir.turbidity).toFixed(2) + ', ash ' + num(state.reservoir.ashContam).toFixed(2) + '; fuel in the forest averages ' + Math.round(num(fuelStats.avg, 0.6) * 100) + '%.', 'info');
      }
      return out.slice(0, 8);
    }

    /* ---------------------------------------------------- endSeason */
    async function endSeasonCore() {
      var turnRng = rng.fork('turn' + state.turn);
      if (!turnNotes) turnNotes = freshNotes();   // e.g. resumed from a save made during planning
      setPhase(PH.LIVE, { year: state.year, season: seasonName(state.season) });
      ui.setBusy(true);
      renderer.setOverlay('none');
      renderer.clearMarkers();
      if (world && world.reservoir && world.reservoir.center) renderer.flyTo(world.reservoir.center.x, world.reservoir.center.y, 80);
      var ctx = { storm: null, burnResult: null, fireReport: null, flood: null, mitigations: [], hydro: null, scoring: null, unlocked: [] };

      // prescribed burn first (it can become the season's fire)
      var escapeFire = null;
      if (state.projects && state.projects.pendingBurn) { ctx.burnResult = await runPrescribedBurn(turnRng); if (ctx.burnResult && ctx.burnResult.escaped && ctx.burnResult.escapeFire) escapeFire = ctx.burnResult.escapeFire; }

      // hydrology
      var preAF = num(state.reservoir.storageAF);
      ctx.hydro = call('Hydrology', 'runSeason', state, world, turnRng.fork('hydro')) || { season: state.season, year: state.year, inflowAF: num(state.water.inflowAF), endStorageAF: num(state.reservoir.storageAF), deliveries: state.water.delivered || {}, shortages: state.water.shortage || {}, notes: [] };
      ui.ticker(seasonName(state.season) + ' runoff: ' + fmtAF(ctx.hydro.inflowAF) + ' in, reservoir ' + Math.round(100 * num(ctx.hydro.endStorageAF, state.reservoir.storageAF) / Math.max(1, capacity())) + '%');
      await animateReservoir(preAF, num(state.reservoir.storageAF), 2500);
      (ctx.hydro.notes || []).forEach(function (n) { if (n) log(n, 'info'); });
      ctx.cropNow = cropHealthAvg();

      // fire
      var forced = state.fire.forcedIgnition || null;
      var fireSim = escapeFire;
      if (!fireSim && state.season !== SEASON.WINTER) fireSim = call('Fire', 'maybeIgnite', state, world, turnRng.fork('ignite'), forced) || null;
      state.fire.forcedIgnition = null;
      if (fireSim) ctx.fireReport = await runFire(fireSim, turnRng, escapeFire ? 'escape' : (forced ? 'lightning' : 'ignition'));
      applyWeather();

      // storm
      ctx.storm = stormThisSeason(turnRng);
      if (ctx.storm && has('Flood', 'prepare')) {
        stats.storms++;
        var prep = call('Flood', 'prepare', state, world, ctx.storm) || null;
        ctx.prep = prep;
        ctx.mitigations = await runFloodPrep(ctx.storm, prep);
        ctx.flood = await runFlood(ctx.storm, prep, ctx.mitigations);
        state.pendingStorm = null;
        renderer.clearMarkers();
      } else if (ctx.storm) { state.pendingStorm = null; }

      // scoring + cases
      var before = Object.assign({}, state.outcomes);
      ctx.scoring = call('Scoring', 'updateOutcomes', state, world, ctx.hydro, { fire: ctx.fireReport, flood: ctx.flood && ctx.flood.result, counterfactual: ctx.flood && ctx.flood.counterfactual, storm: ctx.storm, burn: ctx.burnResult }) || null;
      if (!ctx.scoring) { ctx.scoring = { before: before, after: Object.assign({}, state.outcomes), delta: {}, reasons: [] }; C.OUTCOME_KEYS.forEach(function (k) { ctx.scoring.delta[k] = 0; }); }
      C.OUTCOME_KEYS.forEach(function (k) { state.outcomes[k] = clamp(num(state.outcomes[k], 50), 0, 100); });
      var R = call('Scoring', 'resilience', state.outcomes);
      if (!isFinite(R)) { R = 0; C.OUTCOME_KEYS.forEach(function (k) { R += num(state.outcomes[k]) * C.OUTCOME_WEIGHTS[k]; }); }
      state.resilience = clamp(R, 0, 100);
      state.trustDelta = 0;
      var newly = call('CaseStudies', 'checkUnlocks', state, world) || [];
      state.unlockedCases = state.unlockedCases || []; state.seenCases = state.seenCases || [];
      newly.forEach(function (id) { if (state.unlockedCases.indexOf(id) < 0) state.unlockedCases.push(id); });
      ctx.unlocked = newly.slice();

      // timeline + report
      var entries = buildTimeline(ctx);
      state.timeline.push({ turn: state.turn, year: state.year, season: state.season, entries: entries });
      var report = {
        turn: state.turn, year: state.year, season: state.season, seasonName: seasonName(state.season),
        hydro: ctx.hydro, fire: ctx.fireReport, storm: ctx.storm, flood: ctx.flood && ctx.flood.result, counterfactual: ctx.flood && ctx.flood.counterfactual, attribution: ctx.flood && ctx.flood.attribution,
        burnResult: ctx.burnResult, mitigations: ctx.mitigations, liveMitigations: (ctx.flood && ctx.flood.live) || [], cards: turnNotes.cards, scheduled: turnNotes.scheduled,
        // SPEC2 §E: the after-action card of the season's latest crisis (a storm follows a fire), plus both when the season had both
        afterAction: (ctx.flood && ctx.flood.result && ctx.flood.result.afterAction) || (ctx.fireReport && ctx.fireReport.afterAction) || null,
        afterActions: [ctx.fireReport && ctx.fireReport.afterAction, ctx.flood && ctx.flood.result && ctx.flood.result.afterAction].filter(function (a) { return !!a; }),
        outcomes: { before: ctx.scoring.before || before, after: ctx.scoring.after || Object.assign({}, state.outcomes), delta: ctx.scoring.delta || {} }, reasons: ctx.scoring.reasons || [],
        resilience: state.resilience, grade: call('Scoring', 'grade', state.resilience) || null, timeline: entries, unlocked: ctx.unlocked, budget: state.budget
      };
      state.lastSeasonReport = stripTyped(report);
      stats.turns++;
      setPhase(PH.REPORT, { report: report });
      ui.setBusy(false);
      pushReservoirVisual();
      refresh();
      try { await ui.showSeasonReport(report); } catch (e) { fail('season report', e); }
      if (ctx.storm && num(state.emergencyFund) > 0.005) { log('Unspent emergency funds (' + fmtM(state.emergencyFund) + ') returned to the county.', 'info'); state.emergencyFund = 0; }
      for (var u = 0; u < newly.length; u++) {
        var cs = ((WS.CaseStudies && WS.CaseStudies.LIST) || []).filter(function (c) { return c.id === newly[u]; })[0];
        if (cs) { if (state.seenCases.indexOf(cs.id) < 0) state.seenCases.push(cs.id); try { await ui.showCaseStudy(cs); } catch (e) { fail('case study', e); } }
      }
      renderer.clearMarkers();
      renderer.setFire([], []);
      renderer.setFireIntensity(0);
      renderer.setFlooded([]);
      state.turn++;
      if (state.turn >= num(state.years, C.YEARS_DEFAULT) * 4) {
        ended = true;
        setPhase(PH.END, {});
        var summary = call('Scoring', 'finalSummary', state) || { R: state.resilience, grade: report.grade, outcomes: Object.assign({}, state.outcomes), highlights: [], lessons: [], stats: state.stats };
        state.finalSummary = stripTyped(summary);
        autosave();
        try { await ui.showEnd(summary); } catch (e) { fail('end screen', e); }
      }
      return report;
    }

    /* ---------------------------------------------------- game facade (§11) */
    function guardSync(name, fn) { return function () { try { return fn.apply(null, arguments); } catch (e) { fail(name, e); return { ok: false, reason: String(e && e.message || e) }; } }; }
    game.fundProject = guardSync('fundProject', function (id, targetZoneId) {
      if (!state) return { ok: false, reason: 'No game.' };
      if (state.phase !== PH.PLAN && !headless) return { ok: false, reason: 'Projects can only be funded during planning.' };
      var chk = has('Projects', 'canFund') ? call('Projects', 'canFund', state, world, id, targetZoneId) : { ok: has('Projects', 'fund') };
      if (!chk || !chk.ok) { var reason = (chk && chk.reason) || 'Cannot fund ' + id + '.'; if (!headless) toast(reason, 'warn'); return { ok: false, reason: reason }; }
      var before = num(state.budget);
      var res = call('Projects', 'fund', state, world, id, targetZoneId, rng.fork('fund:' + state.turn + ':' + id + ':' + targetZoneId)) || { ok: false, reason: 'Projects module unavailable.' };
      if (res.ok) {
        var cost = Math.max(0, before - num(state.budget));
        if (id === 'prescribed_burn') { if (!state.projects.pendingBurn) state.projects.pendingBurn = { zoneId: targetZoneId, turn: state.turn }; if (typeof state.projects.pendingBurn === 'object') state.projects.pendingBurn.costM = cost; }
        // Projects.fund already writes its own log line; only log here if it did not.
        var lastLog = state.log && state.log.length ? state.log[state.log.length - 1] : null;
        if (!(lastLog && res.text && lastLog.text === res.text)) log(res.text || ('Funded ' + id + (targetZoneId != null ? ' in ' + zoneName(world, targetZoneId) : '') + ' for ' + fmtM(cost) + '.'), 'good');
        if (!headless) toast(res.text || ('Funded ' + id), 'good');
        renderer.refreshWorld();
        refresh();
      } else if (!headless) toast(res.reason || res.text || 'Could not fund ' + id, 'warn');
      return res;
    });
    game.setAllocation = guardSync('setAllocation', function (sector, frac) {
      if (!state || !state.water) return;
      var v = clamp(num(frac, 1), 0, 1);
      if (sector === 'power_rec') { state.water.alloc.hydro = v; state.water.alloc.recreation = v; ui.renderWater(); return v; }   // SPEC2 §D combined slider
      if (C.SECTORS.indexOf(sector) < 0) return;
      state.water.alloc[sector] = v;
      ui.renderWater();
      return state.water.alloc[sector];
    });
    game.getCoreProjects = function () { return CORE_PROJECTS.slice(); };

    /* ---- crisis facade (SPEC2 §E) ---- */
    game.selectTactic = guardSync('selectTactic', function (type) {
      if (!crisis) return null;
      var order = crisis.mode === 'fire' ? FIRE_TOOL_ORDER : STORM_TOOL_ORDER;
      crisis.selected = (type && order.indexOf(type) >= 0) ? type : null;
      var sel = crisis.selected;
      if (crisis.mode === 'storm' && sel && has('Flood', 'placeableLive')) { var pl = call('Flood', 'placeableLive', crisis.prep, world, sel); renderer.setHighlight(pl && pl.length ? Array.prototype.slice.call(pl) : null, 0x7fd4ff); }
      else renderer.setHighlight(null, null);
      renderer.setPlacementCursor((sel === 'dozer' || sel === 'retardant' || sel === 'sandbag' || sel === 'pump') ? sel : null);
      pushTactical();
      return sel;
    });
    game.setPaused = function (b) {
      if (!crisis) return false;
      crisis.paused = !!b;
      if (!crisis.paused) resumeCrisis();
      pushTactical();
      ui.ticker(crisis.paused ? 'Paused — Space resumes' : 'Resumed');
      return crisis.paused;
    };
    game.isPaused = function () { return !!(crisis && crisis.paused); };
    game.getCrisis = function () { return currentSpec(); };
    game.applyTactic = guardSync('applyTactic', function (type, target) {
      if (!crisis) return { ok: false, reason: 'No crisis under way.' };
      var r;
      if (crisis.mode === 'fire') r = applyFireTactic(type, target === undefined ? null : target);
      else if (Array.isArray(target)) {           // list of cell indices (or {x,y}) for map tools such as sandbags
        var okN = 0, lastR = { ok: false, reason: 'No cells given.' };
        for (var ti = 0; ti < target.length; ti++) {
          var tc = (target[ti] && typeof target[ti] === 'object') ? target[ti] : C.xy(target[ti] | 0);
          lastR = placeLive(type, tc.x, tc.y, tc.zoneId); if (lastR.ok) okN++;
        }
        r = okN ? { ok: true, placed: okN } : lastR;
      }
      else if (typeof target === 'number' && crisis.mode !== 'fire') { var tcell = C.xy(target | 0); r = placeLive(type, tcell.x, tcell.y, null); }
      else if (target && typeof target === 'object') r = placeLive(type, target.x, target.y, target.zoneId);
      else if (type === 'evacuate') r = placeLive(type, null, null, target);
      else r = placeLive(type, null, null, null);
      if (!r.ok && !headless) toast(r.reason || 'Cannot do that now.', 'warn');
      return r;
    });
    game.applyTacticToZone = guardSync('applyTacticToZone', function (type, zoneId) {
      if (!crisis) return { ok: false, reason: 'No crisis under way.' };
      zoneId = (zoneId == null || zoneId === '') ? -1 : +zoneId;
      var r = crisis.mode === 'fire' ? applyFireTactic(type, zoneId) : placeLive(type, null, null, zoneId);
      if (!r.ok && !headless) toast(r.reason || 'Cannot do that now.', 'warn');
      return r;
    });
    // Renderer paint stream (tactical mode): { cells:number[] new since last emit, done:boolean }; a click arrives as a single-cell paint.
    function onPaint(ev) {
      if (!crisis || !ev) return;
      var cells = (ev.cells || []).map(function (c) { return (c && typeof c === 'object') ? C.idx(c.x | 0, c.y | 0) : (c | 0); }).filter(function (c) { return c >= 0 && c < C.N * C.N; });
      var done = !!ev.done, sel = crisis.selected;
      if (cells.length) crisis.lastPaintCell = cells[cells.length - 1];
      var last = crisis.lastPaintCell;
      if (!sel) { if (done && !headless) toast('Pick a tool first (1–' + (crisis.mode === 'fire' ? 5 : 4) + ').', 'warn'); return; }
      var r = null;
      try {
        if (crisis.mode === 'fire') {
          if (sel === 'dozer') { if (cells.length) { r = applyFireTactic('dozer', cells); if (!r.ok && done && !headless) toast(r.reason, 'warn'); } }
          else if (sel === 'retardant') { if (done && last != null) { r = applyFireTactic('retardant', last); if (!r.ok && !headless) toast(r.reason, 'warn'); } }
          else if (sel === 'engine' || sel === 'evacuate') { if (done && last != null) { var z = world && world.zone ? world.zone[last] : -1; r = game.applyTacticToZone(sel, z); } }
          else if (sel === 'mutual_aid') { if (done) r = game.applyTactic('mutual_aid'); }
        } else {
          if (sel === 'sandbag') { var firstFail = null; cells.forEach(function (c) { var p = C.xy(c); var rr = placeLive('sandbag', p.x, p.y); if (!rr.ok && !firstFail) firstFail = rr.reason; }); if (firstFail && done && !headless) toast(firstFail, 'warn'); }
          else if (sel === 'pump') { if (done && last != null) { var pp = C.xy(last); r = placeLive('pump', pp.x, pp.y); if (!r.ok && !headless) toast(r.reason, 'warn'); } }
          else if (sel === 'evacuate') { if (done && last != null) { var z2 = world && world.zone ? world.zone[last] : -1; r = game.applyTacticToZone('evacuate', z2); } }
          else if (sel === 'spillway') { if (done) r = game.applyTactic('spillway'); }
        }
      } catch (e) { fail('paint', e); }
      if (done) crisis.lastPaintCell = null;
    }
    game.initRenderer = function (host) {
      if (host) game.container = host;
      if (paintUnsub) { try { paintUnsub(); } catch (e) { } paintUnsub = null; }
      if (clickUnsub) { try { clickUnsub(); } catch (e) { } clickUnsub = null; }
      renderer.init(game.container, world, state);
      var cu = renderer.onCellClick(game.handleCellClick); clickUnsub = (typeof cu === 'function') ? cu : null;
      if (has('Renderer', 'onCellPaint')) { var pu = renderer.onCellPaint(onPaint); paintUnsub = (typeof pu === 'function') ? pu : function () { }; }
    };
    game.dispose = function () {
      endCrisis();
      if (paintUnsub) { try { paintUnsub(); } catch (e) { } paintUnsub = null; }
      if (clickUnsub) { try { clickUnsub(); } catch (e) { } clickUnsub = null; }
      renderer.dispose();
    };
    game.setRestriction = guardSync('setRestriction', function (level) {
      if (!state) return; if (['none', 'voluntary', 'stage1', 'stage2'].indexOf(level) < 0) return;
      state.water.restriction = level;
      call('Hydrology', 'computeDemands', state, world); call('Hydrology', 'computeAvailable', state, world);
      log('Water restrictions set to ' + level + '.', 'info'); refresh();
    });
    game.setFirePolicy = guardSync('setFirePolicy', function (policy) {
      if (!state) return; if (policy !== 'managed' && policy !== 'suppress_all') return;
      if (state.fire.policy !== policy) log('Fire policy: ' + (policy === 'managed' ? 'managed fire (let remote fires burn under monitoring)' : 'suppress every ignition') + '.', 'info');
      state.fire.policy = policy; ui.renderFire();
    });
    game.scheduleBurn = guardSync('scheduleBurn', function (zoneId) { return game.fundProject('prescribed_burn', zoneId); });
    game.cancelBurn = guardSync('cancelBurn', function () {
      if (!state || !state.projects.pendingBurn) return false;
      var pb = state.projects.pendingBurn;
      if (typeof pb === 'object' && num(pb.costM) > 0 && pb.turn === state.turn) { state.budget = num(state.budget) + num(pb.costM); log('Prescribed burn cancelled; ' + fmtM(pb.costM) + ' returned to the budget.', 'info'); }
      state.projects.pendingBurn = null; refresh(); return true;
    });
    game.endSeason = function () {
      if (!state || running || ended) return Promise.resolve(null);
      if (state.phase !== PH.PLAN) { return Promise.resolve(null); }
      running = true;
      return (async function () {
        var report = null;
        try { report = await endSeasonCore(); } catch (e) { fail('endSeason', e); ui.setBusy(false); }
        try { if (!ended) await beginSeason(); } catch (e) { fail('beginSeason', e); setPhase(PH.PLAN, {}); refresh(); }
        running = false;
        return report;
      })();
    };
    game.setSpeed = function (n) { speed = clamp(num(n, 1), 1, 8); pushTactical(); return speed; };
    game.getSpeed = function () { return speed; };
    game.setOverlay = function (mode) { overlayMode = overlayModes.indexOf(mode) >= 0 ? mode : 'none'; renderer.setOverlay(overlayMode); return overlayMode; };
    game.cycleOverlay = function () { return game.setOverlay(overlayModes[(overlayModes.indexOf(overlayMode) + 1) % overlayModes.length]); };
    game.highlightZone = function (zoneId) {
      if (zoneId == null || zoneId < 0 || !world) { renderer.setHighlight(null, null); return; }
      var z = (typeof world.zoneById === 'function') ? world.zoneById(zoneId) : null;
      renderer.setHighlight(z && z.cells ? Array.prototype.slice.call(z.cells) : null, 0xffd166);
    };
    game.focusZone = function (zoneId) { renderer.flyToZone(zoneId); };
    game.focusCell = function (x, y) { renderer.flyTo(x, y); };
    game.selectPlacementTool = function (type) {
      if (!placement) return null;
      placement.selected = (type && placement.tools.some(function (t) { return t.type === type; })) ? type : null;
      renderer.setPlacementCursor(placement.selected);
      if (placement.selected && placement.prep && placement.prep.placeable && placement.prep.placeable[placement.selected]) renderer.setHighlight(Array.prototype.slice.call(placement.prep.placeable[placement.selected]), 0x7fd4ff);
      else renderer.setHighlight(null, null);
      ui.updatePlacement(placementSpec());
      return placement.selected;
    };
    game.placeTool = function (type, x, y) { var r = placeTool(type, x, y); if (!r.ok && !headless && placement) toast(r.reason, 'warn'); return r; };
    game.finishPlacement = function () { if (placement && placement.done) { renderer.setHighlight(null, null); placement.done(); } };
    game.openEvidence = function (topic) { return openEvidence(topic || 'budget', {}); };
    game.openCaseStudy = function (id) {
      var cs = ((WS.CaseStudies && WS.CaseStudies.LIST) || []).filter(function (c) { return c.id === id; })[0];
      if (!cs) return Promise.resolve();
      if (state && state.seenCases.indexOf(id) < 0) state.seenCases.push(id);
      return ui.showCaseStudy(cs);
    };
    game.save = function () {
      try {
        var s = game.serialize();
        var ls = storage(); if (ls) ls.setItem('watershed.save', s);
        if (!headless) toast('Game saved.', 'good');
        return s;
      } catch (e) { fail('save', e); return null; }
    };
    game.load = function (str) {
      if (running && !headless) { toast('Wait for the season to finish before loading.', 'warn'); return false; }
      try {
        if (str == null) { var ls2 = storage(); str = ls2 ? ls2.getItem('watershed.save') : null; }
        if (!str) { if (!headless) toast('No saved game found.', 'warn'); return false; }
        game.deserialize(str);
        if (!headless) {
          game.initRenderer();
          renderer.setSeason(state.season, state.climate);
          pushReservoirVisual(); applyWeather();
          ui.init(game); refresh(); setPhase(state.phase, {});
          toast('Game loaded — Year ' + state.year + ', ' + seasonName(state.season) + '.', 'good');
        }
        return true;
      } catch (e) { fail('load', e); return false; }
    };
    game.restart = function (o) {
      o = o || {};
      var seed = o.seed != null ? o.seed : (state ? state.seed : 1);
      build({ seed: seed, years: o.years || (state && state.years) || C.YEARS_DEFAULT, mode: o.mode || (state && state.mode) || 'simulated', tutorial: o.tutorial != null ? o.tutorial : false });
      if (!headless) { game.initRenderer(); ui.init(game); }
      return game.start();
    };
    game.start = function () {
      if (begun) return Promise.resolve();
      running = true;
      return beginSeason().catch(function (e) { fail('beginSeason', e); setPhase(PH.PLAN, {}); refresh(); }).then(function () { running = false; });
    };
    game.getProjectList = function () { return call('Projects', 'listFor', state, world) || []; };
    game.getAdvisors = function (topic) { return call('Advisors', 'getRecommendations', state, world, topic) || []; };
    game.listZones = function (type) { return (type ? zonesOf(world, type) : (world && world.zones) || []).map(function (z) { return { id: z.id, name: z.name, type: z.type, center: z.center, upstreamOfReservoir: !!z.upstreamOfReservoir }; }); };
    game.getPlacement = function () { return placementSpec(); };
    game.getStats = function () { return Object.assign({}, stats); };
    game.isEnded = function () { return ended; };
    game.isRunning = function () { return running; };
    game.build = function (o) { build(o); return game; };
    game.handleCellClick = function (c) {
      if (!c || !state) return;
      // During a crisis the renderer's paint stream carries clicks too (single-cell paint); only fall back to clicks when no paint stream exists.
      if (crisis) { if (!paintUnsub) onPaint({ cells: [c.i != null ? c.i : C.idx(c.x | 0, c.y | 0)], done: true }); return; }
      if (placement && placement.selected && state.phase === PH.FLOOD_PREP) { game.placeTool(placement.selected, c.x, c.y); return; }
      if (world && world.zone && world.zone[c.i] >= 0 && state.phase === PH.PLAN) { game.highlightZone(world.zone[c.i]); }
    };
    game.handleKey = function (ev) {
      if (!state || !ev) return false;
      var tag = (ev.target && ev.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return false;
      var k = ev.key;
      if (crisis) {   // SPEC2 §E: Space = pause/resume, 1–5 = tools, Esc = deselect
        if (k === ' ' || k === 'Spacebar') { game.setPaused(!crisis.paused); return true; }
        if (/^[1-5]$/.test(k)) { var order = crisis.mode === 'fire' ? FIRE_TOOL_ORDER : STORM_TOOL_ORDER; if (order[+k - 1]) game.selectTactic(order[+k - 1]); return true; }
        if (k === 'Escape' || k === 'Esc') { if (crisis.selected) { game.selectTactic(null); return true; } return false; }
      }
      if (k === ' ' || k === 'Spacebar') { if (state.phase === PH.PLAN && !running) { game.endSeason(); return true; } return false; }
      if (k === '1' || k === '2' || k === '3' || k === '4') { game.setSpeed([1, 2, 4, 8][+k - 1]); ui.ticker('Speed ' + speed + '×'); return true; }
      if (k === 'v' || k === 'V') { game.cycleOverlay(); ui.ticker('Overlay: ' + overlayMode); return true; }
      // Escape: WS.UI closes its own modal on keydown; nothing to do here.
      return false;
    };

    /* headless driver (§13) */
    game.runSeason = async function () {
      if (ended) return null;
      if (!begun) await beginSeason();
      if (ended) return null;
      try { if (typeof decide.plan === 'function') decide.plan(game); } catch (e) { fail('decide.plan', e); }
      var report = await endSeasonCore();
      if (!ended) await beginSeason();
      return report;
    };
    game.runAll = async function () {
      var reports = [], guard = 0;
      while (!ended && guard++ < 400) reports.push(await game.runSeason());
      return reports;
    };

    if (opts.save) game.deserialize(opts.save);
    else build(opts);
    return game;
  }

  /* ------------------------------------------------------------------ public API */
  WS.Game = {
    create: createGame,
    makeUI: makeUI,
    makeRenderer: makeRenderer,
    /** createHeadless({seed, years, mode, decide, save}) → { state, world, game, runSeason(), runAll(), save(), load(str), stats() } */
    createHeadless: function (o) {
      o = o || {};
      var g = createGame({ seed: o.seed != null ? o.seed : 1, years: o.years || 8, mode: o.mode || 'simulated', headless: true, decide: o.decide || {}, save: o.save || null });
      var drv = {
        game: g,
        runSeason: function () { return g.runSeason().then(function (r) { drv.state = g.state; drv.world = g.world; return r; }); },
        runAll: function () { return g.runAll().then(function (r) { drv.state = g.state; drv.world = g.world; return r; }); },
        save: function () { return g.serialize(); },
        load: function (str) { g.deserialize(str); drv.state = g.state; drv.world = g.world; return drv; },
        stats: function () { return g.getStats(); },
        isEnded: function () { return g.isEnded(); }
      };
      drv.state = g.state; drv.world = g.world;
      return drv;
    }
  };

  /* ------------------------------------------------------------------ browser boot */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    var bootGame = function () {
      var host = document.getElementById('canvas-host') || document.body;
      var game = createGame({ seed: 1, years: C.YEARS_DEFAULT, mode: 'simulated', tutorial: true, headless: false });
      game.container = host;
      window.game = game; WS.game = game;
      (async function () {
        try {
          game.initRenderer(host);
          await game.ui.init(game);
          var intro = null;
          try { intro = await game.ui.showIntro(); } catch (e) { intro = null; }
          intro = intro || {};
          var seed = (intro.seed === '' || intro.seed == null) ? Math.floor(Math.random() * 1e6) : (isFinite(+intro.seed) ? +intro.seed : intro.seed);
          game.build({ seed: seed, years: +intro.years || C.YEARS_DEFAULT, mode: intro.mode || 'simulated', tutorial: intro.tutorial !== false });
          game.initRenderer(host);   // re-inits the renderer for the real world and (re)subscribes cell click + paint exactly once
          await game.ui.init(game);
          game.ui.refresh();
          await game.start();
        } catch (e) { console.error('Watershed boot failed:', e); if (WS.UI && WS.UI.toast) { try { WS.UI.toast('Something went wrong: ' + (e && e.message), 'bad'); } catch (e2) { } } }
      })();
      window.addEventListener('keydown', function (ev) { if (game.handleKey(ev)) ev.preventDefault(); });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootGame); else bootGame();
  }
})();
