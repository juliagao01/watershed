/* Watershed — Events: seasonal event cards with choices and delayed consequences.
   Exports WS.Events (CARDS, draw, runScheduled, HANDLERS, fireResponseCard, applyDelta).
   Runs in Node (no DOM). All randomness via the rng passed in.
   NOTE: choice.apply() already applies its delta (W/E/P/F to state.outcomes, T to state.trustDelta) — the Game should only log/toast the returned {text, delta}. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C;
  var S = C.SEASON;
  var COOLDOWN_TURNS = 3;

  /* ------------------------------------------------------------------ small helpers */
  var num = function (v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d == null ? 0 : d); };
  var r1 = function (v) { return Math.round(num(v, 0) * 100) / 100; };
  function flags(state) { if (!state.flags) state.flags = {}; return state.flags; }
  function climate(state) { return (state && state.climate) ? state.climate : {}; }
  function fire(state) { if (!state.fire) state.fire = { policy: 'managed', activeFire: null, seasonAcres: 0, totalAcres: 0, structuresLost: 0, fires: [], smokeDays: 0 }; return state.fire; }
  function water(state) { if (!state.water) state.water = { alloc: {}, demands: {}, restriction: 'none' }; if (!state.water.alloc) state.water.alloc = {}; return state.water; }
  function stats(state) { if (!state.stats) state.stats = { floodDamageM: 0, sedimentTons: 0, contaminationOutageDays: 0, cropLossPct: 0, hydroMWh: 0, recreationVisits: 0 }; return state.stats; }
  function reservoir(state) { return (state && state.reservoir) ? state.reservoir : { storageAF: 0, capacityAF: C.HYDRO.RESERVOIR_CAPACITY_AF, turbidity: 0, ashContam: 0, algae: 0 }; }
  function storagePct(state) { var r = reservoir(state); var cap = num(r.capacityAF, C.HYDRO.RESERVOIR_CAPACITY_AF) || 1; return C.clamp(num(r.storageAF, 0) / cap, 0, 1.2); }
  function season(state) { return state ? (num(state.season, 0) | 0) : 0; }
  function droughtLevel(state) { var d = String(climate(state).drought || 'None'); var m = d.match(/^D(\d)$/); return m ? Number(m[1]) + 1 : 0; } // None=0, D0=1 .. D4=5
  function fx(state) {
    try { if (WS.Projects && typeof WS.Projects.effects === 'function') return WS.Projects.effects(state) || {}; } catch (e) { /* defensive */ }
    return {};
  }
  function projectLevel(state, id) { var f = state && state.projects && state.projects.funded && state.projects.funded[id]; return f ? (f.level | 0) : 0; }
  function ctx(state, id) { var f = flags(state); if (!f.cardCtx) f.cardCtx = {}; if (!f.cardCtx[id]) f.cardCtx[id] = {}; return f.cardCtx[id]; }
  function zonesOf(world, type) {
    if (!world) return [];
    try {
      if (typeof world.zonesOf === 'function') return (world.zonesOf(type) || []).filter(Boolean);
      if (Array.isArray(world.zones)) return world.zones.filter(function (z) { return z && z.type === type; });
    } catch (e) { /* defensive */ }
    return [];
  }
  function zoneById(world, id) {
    if (!world || id == null) return null;
    try {
      if (typeof world.zoneById === 'function') { var z = world.zoneById(id); if (z) return z; }
      if (Array.isArray(world.zones)) for (var i = 0; i < world.zones.length; i++) if (world.zones[i] && world.zones[i].id === id) return world.zones[i];
    } catch (e) { /* defensive */ }
    return null;
  }
  function zoneName(world, id, fallback) { var z = zoneById(world, id); return (z && z.name) ? z.name : (fallback || 'the sector'); }
  function zoneMeanFuel(world, zone) {
    if (!world || !world.fuel || !zone || !zone.cells || !zone.cells.length) return 0;
    var s = 0, n = zone.cells.length; for (var k = 0; k < n; k++) s += num(world.fuel[zone.cells[k] | 0], 0);
    return s / n;
  }
  function adjustZoneFuel(world, zoneId, mult, add) {
    var z = zoneById(world, zoneId); if (!z || !z.cells || !world.fuel) return 0;
    var n = z.cells.length; for (var k = 0; k < n; k++) { var i = z.cells[k] | 0; if (i >= 0 && i < world.fuel.length) world.fuel[i] = C.clamp(num(world.fuel[i], 0) * mult + add, 0, 1); }
    return n;
  }
  function scarCells(world) {
    if (!world || !world.burn) return 0;
    var n = 0, b = world.burn; for (var i = 0; i < b.length; i++) if (b[i] > 0.3) n++;
    return n;
  }
  function upstreamForestZones(world) {
    var fz = zonesOf(world, 'forest');
    var up = fz.filter(function (z) { return z.upstreamOfReservoir; });
    return up.length ? up : fz;
  }
  function pickFuelyZone(world, rng, zones) {
    if (!zones.length) return null;
    var scored = zones.map(function (z) { return { z: z, f: zoneMeanFuel(world, z) }; }).sort(function (a, b) { return b.f - a.f; });
    var top = scored.slice(0, Math.min(2, scored.length));
    return (rng && typeof rng.pick === 'function') ? rng.pick(top).z : top[0].z;
  }

  /* ------------------------------------------------------------------ deltas, money, scheduling */
  function applyDelta(state, delta) {
    if (!state || !delta) return;
    if (!state.outcomes) state.outcomes = { W: 70, E: 65, P: 72, F: 68, T: 60 };
    ['W', 'E', 'P', 'F'].forEach(function (k) {
      var d = num(delta[k], 0); if (!d) return;
      state.outcomes[k] = C.clamp(num(state.outcomes[k], 50) + d, 0, 100);
    });
    var t = num(delta.T, 0);
    if (t) state.trustDelta = r1(num(state.trustDelta, 0) + t);
  }
  /** Pay costM from budget, then emergency fund; never negative. Returns { paid, shortfall }. */
  function pay(state, costM) {
    var cost = Math.max(0, num(costM, 0));
    if (!cost) return { paid: 0, shortfall: 0 };
    var b = num(state.budget, 0), fromB = Math.min(b, cost);
    state.budget = r1(b - fromB);
    var rem = cost - fromB;
    var ef = num(state.emergencyFund, 0), fromE = Math.min(ef, rem);
    state.emergencyFund = r1(ef - fromE);
    rem = r1(rem - fromE);
    if (rem > 0) {
      state.emergencyDebt = true;
      flags(state).emergencyDebt = true;
      flags(state).emergencyDebtM = r1(num(flags(state).emergencyDebtM, 0) + rem);
    }
    return { paid: r1(cost - rem), shortfall: rem };
  }
  function sched(state, turnsAhead, label, effect) {
    if (!state) return;
    if (WS.State && typeof WS.State.schedule === 'function') { try { WS.State.schedule(state, turnsAhead, label, effect); return; } catch (e) { /* fall through */ } }
    if (!Array.isArray(state.scheduled)) state.scheduled = [];
    state.scheduled.push({ dueTurn: (state.turn | 0) + (turnsAhead | 0), label: label, effect: effect });
  }
  function addBudget(state, m) { state.budget = Math.max(0, r1(num(state.budget, 0) + num(m, 0))); }
  function setRestriction(state, level) { water(state).restriction = level; }

  /** choice(label, desc, costM, fn) — fn(state, world, rng) -> { text, delta? }; wrapper pays cost and applies delta. */
  function choice(label, desc, costM, fn) {
    return {
      label: label, desc: desc, costM: num(costM, 0),
      apply: function (state, world, rng) {
        if (!state) return { text: label, delta: {} };
        var bill = pay(state, costM);
        var r = null;
        try { r = fn(state, world, rng) || {}; } catch (e) { r = { text: label + '.', delta: {} }; }
        var delta = Object.assign({}, r.delta || {});
        var text = String(r.text || label);
        if (bill.shortfall > 0) {
          delta.T = num(delta.T, 0) - 1;
          text += ' Emergency debt ' + C.fmt.money(bill.shortfall) + '.';
        }
        applyDelta(state, delta);
        return { text: text, delta: delta };
      }
    };
  }

  /* ------------------------------------------------------------------ scheduled-effect handlers */
  var HANDLERS = {
    snowpackFollowup: function (state) {
      var pct = num(climate(state).snowpackPct, 100);
      if (pct < 80) { applyDelta(state, { W: -3, T: -2 }); return 'Snowpack ended at ' + Math.round(pct) + '%; waiting cost credibility.'; }
      applyDelta(state, { T: 1 }); return 'Late storms: snowpack ' + Math.round(pct) + '%. Waiting paid off.';
    },
    musselFouling: function (state) {
      if (fx(state).musselInspection || flags(state).musselInspection) return 'Inspectors caught 2 fouled boats; reservoir clean.';
      addBudget(state, -1.5); flags(state).musselsEstablished = true; stats(state).contaminationOutageDays += 2;
      applyDelta(state, { W: -4, E: -4, T: -1 });
      return 'Zebra mussels on the intake: $1.5M, permanent.';
    },
    pipeBurst: function (state) {
      if (projectLevel(state, 'leak_detection') >= 2) { addBudget(state, -0.3); return 'Patched main split; metering caught it. $0.3M.'; }
      addBudget(state, -1.8); flags(state).mainBreaks = num(flags(state).mainBreaks, 0) + 1; stats(state).contaminationOutageDays += 2;
      applyDelta(state, { W: -4, P: -1, T: -3 });
      return 'Main Street main burst: 2 dry days, $1.8M.';
    },
    callRuling: function (state) {
      addBudget(state, -0.8); applyDelta(state, { F: -2, T: -1 });
      return 'Senior call upheld: $0.8M legal fees, ditches shut.';
    },
    algaeToxin: function (state) {
      stats(state).contaminationOutageDays += 3; applyDelta(state, { P: -3, W: -2, T: -3 });
      return 'Bloom toxin at intake: 3-day do-not-drink notice.';
    },
    wuiExposure: function (state, world, value) {
      var zid = value && value.zoneId != null ? value.zoneId : null;
      var hardened = zid != null && fx(state).hardenedZones && fx(state).hardenedZones[zid];
      if (hardened || flags(state).wuiCode) { applyDelta(state, { P: -1 }); return zoneName(world, zid, 'New subdivision') + ' subdivision passed fire inspection.'; }
      flags(state).insuranceRetreatReady = true; applyDelta(state, { P: -3 });
      return zoneName(world, zid, 'New subdivision') + ' subdivision: highest hazard class, insurers notice.';
    },
    fairPlan: function (state) { addBudget(state, -0.3); applyDelta(state, { T: 1 }); return 'FAIR Plan enrollment opened; town paid $0.3M.'; },
    mutualAidDeclined: function (state) {
      flags(state).mutualAidDenied = true; var f = fire(state); f.preResponse = r1(num(f.preResponse, 0) - 0.15);
      return 'Counties remember the refusal; mutual aid slows.';
    },
    beetleFuel: function (state, world, value) {
      var zid = value && value.zoneId != null ? value.zoneId : null;
      if (zid != null) adjustZoneFuel(world, zid, 1, 0.1);
      applyDelta(state, { P: -1 });
      return 'Beetle-kill blowdown in ' + zoneName(world, zid, 'the forest') + ': fuel +15%.';
    },
    fishKillFollowup: function (state) {
      if (num(climate(state).streamflowCfs, 60) < C.HYDRO.MIN_FLOW_CFS * 1.2) { applyDelta(state, { E: -3, F: -1, T: -2 }); return 'Trout kill below town; guide season cancelled.'; }
      return 'Cooler weather spared the trout.';
    },
    grantAwarded: function (state, world, value) {
      var m = num(value && value.amountM != null ? value.amountM : value, 2.5);
      addBudget(state, m); flags(state).federalGrant = true; applyDelta(state, { T: 1 });
      return 'Grant awarded: ' + C.fmt.money(m) + ' for mitigation work.';
    },
    earlyMeltLoss: function (state) {
      if (fx(state).sensorCoverage) { applyDelta(state, { W: 1 }); return 'Gages caught the early melt; reservoir filled early.'; }
      applyDelta(state, { W: -3 }); return 'Runoff peaked 3 weeks early; much spilled uncaught.';
    },
    farmLeaseEnd: function (state) { flags(state).leaseActive = false; applyDelta(state, { F: 1 }); return 'Fallow lease ended; fields back in production.'; }
  };

  /* ------------------------------------------------------------------ cards */
  var CARDS = [
    {
      id: 'low_snowpack', title: 'Thin Snowpack', icon: '🏔️', severity: 'warn',
      text: 'SNOTEL reads snowpack well under 80% of median; runoff forecasts cut sharply.',
      source: 'Colorado: ~80% of water supply starts as snow; April 1 snowpack sets the forecast.',
      when: function (state) { var s = season(state); return (s === S.WINTER || s === S.SPRING) && num(climate(state).snowpackPct, 100) < 80; },
      weight: function (state) { return 1.5 + (80 - num(climate(state).snowpackPct, 100)) / 20; }, once: false,
      choices: [
        choice('Drought watch', 'Voluntary restrictions and a public briefing.', 0, function (state) {
          setRestriction(state, 'voluntary'); flags(state).droughtDeclared = true;
          return { text: 'Drought watch declared; voluntary cutbacks, straight talk appreciated.', delta: { W: 2, F: -1, T: 1 } };
        }),
        choice('Wait for storms', 'March-April are snowiest; it may recover.', 0, function (state) {
          sched(state, 1, 'Snowpack follow-up', { type: 'custom', key: 'snowpackFollowup', value: null, text: '' });
          return { text: 'No restrictions; betting on late storms. Answer next season.', delta: {} };
        }),
        choice('Lease ranch water', 'Pay Lazy J to fallow hay for a year.', 1.2, function (state) {
          flags(state).leaseActive = true; sched(state, 4, 'Fallow lease ends', { type: 'custom', key: 'farmLeaseEnd', value: null, text: '' });
          return { text: 'Fallow lease banks ~900 AF; 2 ranch hands laid off.', delta: { W: 4, F: -3, E: 1 } };
        })
      ]
    },
    {
      id: 'heat_wave', title: 'Heat Dome', icon: '🌡️', severity: 'warn',
      text: 'Day 5 at 98°F; sprinklers now take over half the plant\'s output.',
      source: 'Colorado: lawns use half of summer water; state has warmed ~2°F since 1980.',
      when: function (state) { return season(state) === S.SUMMER && num(climate(state).tempAnomF, 0) > 1.5; },
      weight: function (state) { return 1 + num(climate(state).tempAnomF, 0) / 3; }, once: false,
      choices: [
        choice('Stage 1 restrictions', 'Two watering days a week, enforced.', 0, function (state) {
          setRestriction(state, 'stage1');
          return { text: 'Stage 1 cut outdoor use sharply; the golf course is furious.', delta: { W: 3, F: -1, T: -1 } };
        }),
        choice('Open cooling centers', 'Library and rec center, extended hours.', 0.3, function (state) {
          return { text: 'Cooling centers emptied the ER; watering ran unchecked.', delta: { P: 2, W: -2 } };
        }),
        choice('Ride it out', 'Heat waves end; do nothing.', 0, function (state) {
          sched(state, 1, 'Warm-water aftermath', { type: 'outcome', key: 'E', value: -2, text: 'Heat dome aftermath: stressed trout, algae downstream.' });
          return { text: 'Demand stayed high; 2 heat hospitalizations made the paper.', delta: { W: -2, P: -1 } };
        })
      ]
    },
    {
      id: 'mussels', title: 'Mussel-Fouled Boat', icon: '🐚', severity: 'warn',
      text: 'A Lake Powell boat arrives crusted with mussels; 1 launch could foul the intake forever.',
      source: 'Colorado: zebra mussels found at Highline Lake 2022, Colorado River 2024; boats spread them.',
      when: function (state) { return (season(state) === S.SPRING || season(state) === S.SUMMER) && !fx(state).musselInspection; },
      weight: function () { return 1.2; }, once: true,
      choices: [
        choice('Fund inspection stations', 'CPW-certified inspection at every ramp.', 0.8, function (state, world, rng) {
          flags(state).musselInspection = true;
          if (WS.Projects && !projectLevel(state, 'mussel_inspection')) {
            state.budget = r1(num(state.budget, 0) + 0.8); // the choice paid; let the project record the funding
            var r = WS.Projects.fund(state, world, 'mussel_inspection', null, rng);
            if (!r.ok) state.budget = Math.max(0, r1(num(state.budget, 0) - 0.8));
          }
          return { text: 'Stations up in a week; boat decontaminated at 140°F.', delta: { E: 2, T: 1 } };
        }),
        choice('Signs and volunteers', 'Clean-Drain-Dry signs; volunteers eyeball boats.', 0.05, function (state) {
          flags(state).musselRisk = true;
          sched(state, 4, 'Mussel survey at the intake', { type: 'custom', key: 'musselFouling', value: null, text: '' });
          return { text: 'Volunteers check 1 boat in 5; divers inspect next year.', delta: {} };
        }),
        choice('Close the ramp', 'No motorboats this season; paddlecraft only.', 0, function (state) {
          flags(state).rampClosed = true;
          return { text: 'Ramp closed: reservoir clean, marina lost its summer.', delta: { E: 3, F: -3, T: -2 } };
        })
      ]
    },
    {
      id: 'lightning_fire', title: 'Dry Lightning', icon: '⚡', severity: 'crisis',
      text: 'Dry lightning overnight, 1 smoke column above the reservoir; wind rising by afternoon.',
      source: 'Colorado: lightning started the 2020 Pine Gulch Fire, ~139,000 acres near Grand Junction.',
      when: function (state, world) {
        var s = season(state); var f = fire(state);
        return (s === S.SUMMER || s === S.FALL) && num(climate(state).fireDanger, 0.2) >= 0.3 && !f.activeFire && !f.forcedIgnition && zonesOf(world, 'forest').length > 0;
      },
      weight: function (state) { return 0.6 + num(climate(state).fireDanger, 0.2) * 2; }, once: false,
      prepare: function (state, world, rng) {
        var z = pickFuelyZone(world, rng, upstreamForestZones(world));
        var c = ctx(state, 'lightning_fire');
        if (z) { c.zoneId = z.id; c.name = z.name; fire(state).forcedIgnition = { zoneId: z.id }; }
      },
      choices: [
        choice('Order air tankers', 'State and federal aircraft before the wind.', 1.0, function (state) {
          var f = fire(state); f.preResponse = r1(num(f.preResponse, 0) + 0.25);
          return { text: 'Tankers over ' + (ctx(state, 'lightning_fire').name || 'the sector') + ' by noon; retardant lines down.', delta: { P: 1 } };
        }),
        choice('Manage for benefit', 'Monitor; let it clean surface fuels.', 0.2, function (state) {
          var f = fire(state); f.preResponse = r1(num(f.preResponse, 0) - 0.2); flags(state).managedFire = true;
          var managed = f.policy !== 'suppress_all';
          return { text: managed ? 'Crews monitor from the ridge; a gamble on the weather.' : 'Contradicts your suppress-all policy; crews slow, critics loud.', delta: managed ? { E: 2, P: -1 } : { P: -2, T: -1 } };
        }),
        choice('Standard attack', 'Local engines and hand crews; escalate if needed.', 0.3, function (state) {
          return { text: 'Both stations and a hand crew up the ridge road.', delta: {} };
        })
      ]
    },
    {
      id: 'storm_forecast', title: 'Flash-Flood Watch', icon: '⛈️', severity: 'crisis',
      text: 'NWS flash-flood watch: 1 inch an hour on the burn scar within 3 days.',
      source: 'Colorado: burned soil repels water; 2021 Glenwood Canyon debris flows closed I-70.',
      when: function (state, world) { var s = season(state); return (s === S.SUMMER || s === S.FALL) && !state.pendingStorm && scarCells(world) >= 40; },
      weight: function (state, world) { return 1.5 + Math.min(2, scarCells(world) / 400); }, once: false,
      prepare: function (state, world, rng) {
        var inten = r1(1.0 + (rng ? rng.next() : 0.5) * 1.5);
        state.pendingStorm = { intensityIn: inten, durationHr: 1.5, turnsUntil: 0, source: 'event' };
        ctx(state, 'storm_forecast').intensityIn = inten;
      },
      choices: [
        choice('Pre-position crews', 'Road crews, sandbags and pumps below the scar.', 0.4, function (state) {
          if (!state.pendingStorm) state.pendingStorm = { intensityIn: 1.6, durationHr: 1.5, turnsUntil: 0, source: 'event' };
          flags(state).stormPrepped = true; state.emergencyFund = r1(num(state.emergencyFund, 0) + 0.5);
          return { text: 'Crews staged, residents briefed; emergency fund +$0.5M.', delta: { P: 1 } };
        }),
        choice('State emergency declaration', 'Unlocks state funds; cost-share follows.', 0, function (state) {
          if (!state.pendingStorm) state.pendingStorm = { intensityIn: 1.6, durationHr: 1.5, turnsUntil: 0, source: 'event' };
          state.emergencyFund = r1(num(state.emergencyFund, 0) + 1.5); flags(state).stateEmergency = true;
          sched(state, 2, 'Disaster cost-share due', { type: 'budget', key: 'budget', value: -0.5, text: 'Disaster declaration cost-share due: -$0.5M.' });
          return { text: 'Governor signed: $1.5M emergency funds, cost-share due later.', delta: { T: -1 } };
        }),
        choice('Wait for update', 'Monsoon cells are fickle; watch may lift.', 0, function (state) {
          if (!state.pendingStorm) state.pendingStorm = { intensityIn: 1.6, durationHr: 1.5, turnsUntil: 0, source: 'event' };
          return { text: 'Watch still in effect; crews will scramble when rain starts.', delta: { P: -1 } };
        })
      ]
    },
    {
      id: 'pipe_leak', title: 'Main Street Leak', icon: '🚰', severity: 'info',
      text: 'A 1950s cast-iron main under Main Street leaks ~40 gallons a minute.',
      source: 'Colorado utilities lose 10-20% of treated water; freeze-thaw and clay crack old mains.',
      when: function (state) { return num(fx(state).leakReduction, 0) < 0.18; },
      weight: function (state) { return season(state) === S.WINTER ? 1.4 : 0.9; }, once: false,
      choices: [
        choice('Replace it now', 'Full repair; road closed a week.', 0.6, function (state) {
          return { text: 'Main replaced in 5 days; leak gone, traffic grumbled.', delta: { W: 1 } };
        }),
        choice('Clamp and defer', 'A clamp buys time; real fix later.', 0.1, function (state) {
          sched(state, 2, 'Deferred main repair', { type: 'custom', key: 'pipeBurst', value: null, text: '' });
          return { text: 'Clamp holds for now; the main is 70 years old.', delta: {} };
        }),
        choice('Leak-detection program', 'Acoustic loggers and district metering system-wide.', 0, function (state, world, rng) {
          if (WS.Projects && projectLevel(state, 'leak_detection') < 3) {
            var r = WS.Projects.fund(state, world, 'leak_detection', null, rng);
            if (r.ok) return { text: 'Leak detection funded; Main Street was 1 of 11 leaks found.', delta: { W: 2, T: 1 } };
            pay(state, 0.1); sched(state, 2, 'Deferred main repair', { type: 'custom', key: 'pipeBurst', value: null, text: '' });
            return { text: 'Unaffordable; the crew clamped the leak instead.', delta: {} };
          }
          return { text: 'Program already at full strength; main fixed from the list.', delta: { W: 1 } };
        })
      ]
    },
    {
      id: 'federal_funding', title: 'Grant Window Opens', icon: '🏛️', severity: 'info',
      text: '2 grant rounds close this month; both need a local match, awards take a year.',
      source: 'FEMA BRIC and CWCB Colorado Water Plan grants fund local mitigation, with a match.',
      when: function (state) { return (state.turn | 0) >= 1; },
      weight: function () { return 0.8; }, once: false,
      choices: [
        choice('Watershed grant', '$0.5M match toward forest and wetland work.', 0.5, function (state) {
          sched(state, 3, 'Watershed grant decision', { type: 'custom', key: 'grantAwarded', value: { amountM: 3.0 }, text: '' });
          return { text: 'Application in, $0.5M match reserved; decision in a year.', delta: {} };
        }),
        choice('Hazard-mitigation grant', '$0.8M match; also raises emergency fund.', 0.8, function (state) {
          sched(state, 4, 'Hazard-mitigation award', { type: 'custom', key: 'grantAwarded', value: { amountM: 2.5 }, text: '' });
          sched(state, 4, 'Federal grant flag', { type: 'flag', key: 'federalGrant', value: true, text: 'Federal mitigation status now boosts storm emergency funds.' });
          return { text: 'County co-signed; if it lands, emergency response gains permanently.', delta: {} };
        }),
        choice('Skip this round', 'Staff are stretched; let it pass.', 0, function (state) {
          return { text: 'Deadline passed; there will be another cycle.', delta: {} };
        })
      ]
    },
    {
      id: 'residents_oppose_burn', title: 'Residents Oppose the Burn', icon: '🪧', severity: 'warn',
      text: '"Say NO to the burn" flyers; homeowners packed the council, burn window 3 weeks wide.',
      source: 'Colorado: the 2012 Lower North Fork burn escaped and killed 3, prompting new rules.',
      when: function (state) { return !!(state.projects && state.projects.pendingBurn); },
      weight: function () { return 2.5; }, once: false,
      choices: [
        choice('Meeting, then proceed', 'Walk residents through plan, crews, smoke forecast.', 0.15, function (state) {
          flags(state).townHallHeld = true;
          return { text: 'Burn boss took questions for 2 hours; burn stays on.', delta: { T: 2 } };
        }),
        choice('Cancel the burn', 'Pull the plan; refund half the cost.', 0, function (state) {
          var pb = state.projects ? state.projects.pendingBurn : null;
          if (pb) { state.projects.pendingBurn = null; addBudget(state, 0.3); flags(state).burnCancelled = num(flags(state).burnCancelled, 0) + 1; if (state.projects._rev != null) state.projects._rev++; }
          return { text: 'Burn cancelled, half the cost recovered; fuel stays.', delta: { T: 1, E: -1 } };
        }),
        choice('Proceed regardless', 'The window is short; ignore the flyers.', 0, function (state) {
          return { text: 'Burn proceeded over objections; trust in fire program hit.', delta: { T: -4 } };
        })
      ]
    },
    {
      id: 'fire_response', title: 'Wildfire Response', icon: '🚒', severity: 'crisis',
      text: 'A wildfire is burning. Decide where the crews go.',
      source: 'Colorado: local districts, sheriffs, DFPC and federal crews share initial attack.',
      when: function () { return false; }, weight: function () { return 0; }, once: false,
      choices: []
    },
    {
      id: 'senior_call', title: 'Senior Call on the Creek', icon: '⚖️', severity: 'warn',
      text: 'An 1880s senior right placed a call; junior ditches and 2 farms must shut headgates.',
      source: 'Prior appropriation: oldest rights first; a senior call curtails every junior diversion upstream.',
      when: function (state) { var s = season(state); var w = water(state); return (s === S.SUMMER || s === S.FALL) && (droughtLevel(state) >= 2 || num(w.alloc.downstream, 1) < 1 || num(w.alloc.tribal, 1) < 1 || storagePct(state) < 0.5); },
      weight: function (state) { return 1 + droughtLevel(state) * 0.3; }, once: false,
      choices: [
        choice('Honor the call', 'Curtail junior farm diversions; law is law.', 0, function (state) {
          var w = water(state); w.alloc.farms = Math.min(num(w.alloc.farms, 1), 0.6); w.alloc.downstream = 1;
          return { text: 'Junior headgates closed; 2 farms lost their second cutting.', delta: { F: -3, W: -1, T: 1 } };
        }),
        choice('Negotiate a lease', 'Pay the senior holder to defer the call.', 1.0, function (state) {
          water(state).alloc.downstream = 1;
          return { text: 'One-season lease satisfied the call; most ditches kept running.', delta: { F: -1 } };
        }),
        choice('Contest the call', 'Argue futility before the Division Engineer.', 0.2, function (state) {
          sched(state, 1, 'Division Engineer ruling', { type: 'custom', key: 'callRuling', value: null, text: '' });
          return { text: 'Futile-call petition filed; senior holder furious, ruling next season.', delta: { T: -3 } };
        })
      ]
    },
    {
      id: 'algae_bloom', title: 'Algae Bloom', icon: '🟢', severity: 'warn',
      text: 'Cyanobacteria confirmed on the warm upper reservoir; 1 dog sick, taste complaints rising.',
      source: 'Colorado: warm low pools feed cyanobacteria; toxic-algae advisories post most summers.',
      when: function (state) { var r = reservoir(state); return season(state) === S.SUMMER && (num(r.algae, 0) > 0.3 || (storagePct(state) < 0.55 && num(climate(state).tempAnomF, 0) > 1)); },
      weight: function (state) { return 1 + num(reservoir(state).algae, 0) * 2; }, once: false,
      choices: [
        choice('Treat and switch intake', 'Algaecide; draw deeper if the intake allows.', 0.4, function (state) {
          var multi = !!fx(state).multiLevelIntake; if (state.reservoir) state.reservoir.algae = C.clamp(num(state.reservoir.algae, 0) * 0.4, 0, 1);
          return { text: multi ? 'Multi-level intake went deep; bloom treated, tap water unchanged.' : 'Bloom treated, but the fixed intake drew murky water 1 week.', delta: multi ? { W: 3, E: -1 } : { W: 1, E: -1 } };
        }),
        choice('Advisory, close beach', 'No swimming, no dogs, honest signage.', 0.05, function (state) {
          return { text: 'Beach closed; boaters kept boating, the marina lost trade.', delta: { P: 1, F: -2, T: 1 } };
        }),
        choice('Wait it out', 'Blooms crash with the first cold nights.', 0, function (state) {
          sched(state, 1, 'Bloom toxin at the intake', { type: 'custom', key: 'algaeToxin', value: null, text: '' });
          return { text: 'Bloom left alone; cold nights are weeks away.', delta: {} };
        })
      ]
    },
    {
      id: 'smoke_event', title: 'Smoke in the Valley', icon: '🌫️', severity: 'warn',
      text: 'Western smoke pools in the valley: AQI "very unhealthy", maybe for 7 days.',
      source: 'Colorado: 2020-21 smoke gave Denver some of the world\'s worst air days.',
      when: function (state) { var s = season(state); return (s === S.SUMMER || s === S.FALL) && (num(climate(state).fireDanger, 0.2) >= 0.35 || num(fire(state).smokeDays, 0) > 0); },
      weight: function (state) { return 0.8 + num(climate(state).fireDanger, 0.2); }, once: false,
      choices: [
        choice('Open clean-air shelters', 'HEPA rooms for the vulnerable; rent if needed.', 0.3, function (state) {
          var has = !!fx(state).shelters;
          fire(state).smokeDays = num(fire(state).smokeDays, 0) + (has ? 2 : 4);
          return { text: has ? 'Clean-air shelters opened in hours; the clinic stayed quiet.' : 'Rented HEPA units made the gym a makeshift shelter.', delta: has ? { P: 3, T: 1 } : { P: 1 } };
        }),
        choice('Cancel events, masks', 'Close pool, cancel rodeo, hand out N95s.', 0.1, function (state) {
          fire(state).smokeDays = num(fire(state).smokeDays, 0) + 4;
          return { text: 'Rodeo and market cancelled; N95s handed out.', delta: { P: 1, F: -1 } };
        }),
        choice('Business as usual', 'Only smoke; people can stay indoors.', 0, function (state) {
          fire(state).smokeDays = num(fire(state).smokeDays, 0) + 6;
          return { text: '12 respiratory visits; a grandmother flown to Denver.', delta: { P: -2, T: -1 } };
        })
      ]
    },
    {
      id: 'subdivision_proposal', title: 'Forest-Edge Subdivision', icon: '🏘️', severity: 'info',
      text: '180 homes proposed where pines meet sagebrush, one road out; fire chief appalled.',
      source: 'Nearly half of Coloradans live in the WUI; a 2023 board writes WUI codes.',
      when: function (state) { return (state.turn | 0) >= 1 && !fire(state).activeFire; },
      weight: function () { return 0.7; }, once: false,
      prepare: function (state, world, rng) {
        var nb = zonesOf(world, 'neighborhood'); if (!nb.length) return;
        var z = (rng && typeof rng.pick === 'function') ? rng.pick(nb) : nb[0];
        var c = ctx(state, 'subdivision_proposal'); c.zoneId = z.id; c.name = z.name;
      },
      choices: [
        choice('Approve as proposed', 'Maximum revenue; no fire requirements.', 0, function (state) {
          var c = ctx(state, 'subdivision_proposal');
          state.population = Math.round(num(state.population, C.HYDRO.BASE_POPULATION) + 600); addBudget(state, 1.5);
          flags(state).wuiGrowth = num(flags(state).wuiGrowth, 0) + 1;
          sched(state, 4, 'Subdivision fire-season review', { type: 'custom', key: 'wuiExposure', value: { zoneId: c.zoneId != null ? c.zoneId : null }, text: '' });
          return { text: 'Approved by ' + (c.name || 'the forest edge') + ': 600 residents, $1.5M in fees.', delta: { F: 2, E: -1 } };
        }),
        choice('Approve with WUI code', 'Class A roofs, defensible space, second road.', 0, function (state) {
          var c = ctx(state, 'subdivision_proposal');
          state.population = Math.round(num(state.population, C.HYDRO.BASE_POPULATION) + 450); addBudget(state, 0.8);
          flags(state).wuiCode = true; flags(state).wuiGrowth = num(flags(state).wuiGrowth, 0) + 1;
          sched(state, 4, 'Subdivision fire-season review', { type: 'custom', key: 'wuiExposure', value: { zoneId: c.zoneId != null ? c.zoneId : null }, text: '' });
          return { text: 'Approved with conditions: 140 hardened homes, 2 roads out.', delta: { F: 1, P: 1 } };
        }),
        choice('Deny the plat', 'Keep the forest edge undeveloped.', 0, function (state) {
          return { text: 'Denied; developer suing, elk keep their winter range.', delta: { E: 2, F: -1, T: -2 } };
        })
      ]
    },
    {
      id: 'fish_kill_warning', title: 'Fish Kill Warning', icon: '🐟', severity: 'warn',
      text: 'Creek below the dam at 71°F and a trickle; trout die within days.',
      source: 'Colorado: trout die past ~70°F at low flow; CWCB instream rights hold a minimum.',
      when: function (state) { var s = season(state); return (s === S.SUMMER || s === S.FALL) && (num(climate(state).streamflowCfs, 60) < C.HYDRO.MIN_FLOW_CFS * 1.4 || num(water(state).alloc.wildlife, 1) < 1); },
      weight: function (state) { return 1.2 + Math.max(0, (C.HYDRO.MIN_FLOW_CFS * 1.4 - num(climate(state).streamflowCfs, 60)) / 10); }, once: false,
      choices: [
        choice('Release instream flow', 'Open the outlet; the reservoir drops.', 0, function (state) {
          water(state).alloc.wildlife = 1; if (state.climate) state.climate.streamflowCfs = Math.max(num(state.climate.streamflowCfs, 0), C.HYDRO.MIN_FLOW_CFS * 1.5);
          return { text: 'Cold outlet water lifted the creek overnight; ~300 AF spent.', delta: { E: 3, W: -2 } };
        }),
        choice('Fishing closure only', 'Anglers off the water after noon; no release.', 0, function (state) {
          sched(state, 1, 'Fish kill outcome', { type: 'custom', key: 'fishKillFollowup', value: null, text: '' });
          return { text: 'Afternoon closure posted; trout survival depends on weather.', delta: { E: 1, F: -1 } };
        }),
        choice('Hold the water', 'Storage is for people; fish cope.', 0, function (state) {
          water(state).alloc.wildlife = Math.min(num(water(state).alloc.wildlife, 1), 0.5);
          sched(state, 1, 'Fish kill outcome', { type: 'custom', key: 'fishKillFollowup', value: null, text: '' });
          return { text: 'Outlet stayed shut; dead-trout photos already circulating.', delta: { E: -4, T: -1 } };
        })
      ]
    },
    {
      id: 'hydro_shortfall', title: 'Hydropower Shortfall', icon: '⚡', severity: 'info',
      text: 'Low pool, little head: turbine output is down 60%; co-op wants power or water.',
      source: 'Small municipal hydro depends on head and release; both fall in dry years.',
      when: function (state) { var s = season(state); return (s === S.FALL || s === S.WINTER) && (storagePct(state) < 0.5 || num(water(state).alloc.hydro, 1) < 0.8); },
      weight: function () { return 0.8; }, once: false,
      choices: [
        choice('Buy replacement power', 'Wholesale market covers it; keep the water.', 0.7, function (state) {
          return { text: 'Co-op bought market power for $0.7M; every acre-foot kept.', delta: {} };
        }),
        choice('Release more water', 'Raise hydro release; storage drops.', 0, function (state) {
          water(state).alloc.hydro = 1; stats(state).hydroMWh = num(stats(state).hydroMWh, 0) + 400;
          return { text: 'Turbine hummed all winter (+400 MWh); spring storage lower.', delta: { F: 2, W: -2 } };
        }),
        choice('Accept the shortfall', 'Co-op passes cost to ratepayers.', 0, function (state) {
          return { text: 'Electric bills rose a few dollars; council took the calls.', delta: { F: -2, T: -1 } };
        })
      ]
    },
    {
      id: 'well_failure', title: 'Rural Wells Running Dry', icon: '🪣', severity: 'warn',
      text: '3 bench households are hauling water; shallow wells dropped, rig booked 6 weeks out.',
      source: 'Hundreds of thousands of Coloradans use household wells; shallow ones drop in drought.',
      when: function (state) { var s = season(state); return (s === S.SUMMER || s === S.FALL) && (droughtLevel(state) >= 2 || storagePct(state) < 0.45); },
      weight: function (state) { return 0.8 + droughtLevel(state) * 0.25; }, once: false,
      choices: [
        choice('Haul water', 'Bulk fill station and county hauling.', 0.5, function (state) {
          return { text: 'Fairgrounds fill station and county trucks; nobody went without.', delta: { P: 2, T: 2, W: -1 } };
        }),
        choice('Well-deepening grants', 'Cost-share deeper wells for affected households.', 0.9, function (state) {
          flags(state).wellGrants = true;
          return { text: 'Grants brought the rig 1 month sooner; deeper wells last.', delta: { P: 1, T: 1 } };
        }),
        choice('Leave it to owners', 'Private wells are private responsibility.', 0, function (state) {
          return { text: 'Families hauled their own water; 2 homes listed for sale.', delta: { P: -2, T: -3 } };
        })
      ]
    },
    {
      id: 'tourism_boom', title: 'Boaters Discover the Reservoir', icon: '⛵', severity: 'info',
      text: '1 viral video: Front Range trailers overflow the marina every weekend, shorebirds gone.',
      source: 'Outdoor recreation is a multi-billion-dollar Colorado industry; full reservoirs draw boaters.',
      when: function (state) { var s = season(state); return (s === S.SPRING || s === S.SUMMER) && storagePct(state) > 0.65 && num(reservoir(state).turbidity, 0) < 0.3 && !fire(state).activeFire; },
      weight: function () { return 0.9; }, once: false,
      choices: [
        choice('Promote it', 'More visitors, revenue and shoreline pressure.', 0.2, function (state) {
          stats(state).recreationVisits = num(stats(state).recreationVisits, 0) + 20000; flags(state).tourismPromoted = true;
          return { text: 'Visits doubled (+20,000), sales tax too; shorebirds gone.', delta: { F: 3, E: -1 } };
        }),
        choice('Cap daily launches', 'Permits limit boats; protects the shore.', 0.05, function (state) {
          stats(state).recreationVisits = num(stats(state).recreationVisits, 0) + 8000;
            return { text: 'Permits sold out weekends (+8,000 visits); shoreline held.', delta: { F: 1, E: 1 } };
        }),
        choice('Add a visitor fee', '$10 day-use fee funds ramp and inspections.', 0, function (state) {
          addBudget(state, 0.6); stats(state).recreationVisits = num(stats(state).recreationVisits, 0) + 12000;
          return { text: 'Fees brought $0.6M; locals resent paying for their lake.', delta: { F: 1, T: -1 } };
        })
      ]
    },
    {
      id: 'ski_area_request', title: 'Snowmaking Water Request', icon: '⛷️', severity: 'info',
      text: 'The ski hill wants 600 AF for snowmaking through December, the creek\'s low point.',
      source: 'Colorado ski areas make snow Oct-Dec at baseflow; part sublimates before spring.',
      when: function (state) { var s = season(state); return s === S.FALL || s === S.WINTER; },
      weight: function () { return 0.7; }, once: false,
      choices: [
        choice('Full lease', 'They pay $0.8M; reservoir drops all winter.', 0, function (state) {
          addBudget(state, 0.8); if (state.reservoir) state.reservoir.storageAF = Math.max(0, num(state.reservoir.storageAF, 0) - 600);
          return { text: 'Lifts spun by Thanksgiving: +$0.8M, 600 AF gone.', delta: { F: 3, W: -2, E: -1 } };
        }),
        choice('Limited lease', 'Half the volume, spring return-flow credit.', 0, function (state) {
          addBudget(state, 0.4); if (state.reservoir) state.reservoir.storageAF = Math.max(0, num(state.reservoir.storageAF, 0) - 300);
          return { text: 'Half lease: +$0.4M, 300 AF; both sides called it fair.', delta: { F: 1, W: -1 } };
        }),
        choice('Deny the request', 'Storage stays; the hill opens when it snows.', 0, function (state) {
          return { text: 'Hill opened 3 weeks late; lift operators unpaid meanwhile.', delta: { F: -2, T: -1, W: 1 } };
        })
      ]
    },
    {
      id: 'insurance_retreat', title: 'Insurers Leave the WUI', icon: '📉', severity: 'warn',
      text: '2 carriers quit the high-hazard zones, the rest tripled premiums; home sales stalled.',
      source: 'After the 2021 Marshall Fire insurers dropped thousands of WUI policies; FAIR Plan 2023.',
      when: function (state) { var f = fire(state); return num(f.structuresLost, 0) > 0 || !!flags(state).insuranceRetreatReady || num(f.totalAcres, 0) > 3000; },
      weight: function (state) { return flags(state).insuranceRetreatReady ? 2.2 : 1.0; }, once: false,
      prepare: function (state, world, rng) {
        var nb = zonesOf(world, 'neighborhood'); if (!nb.length) return;
        var hz = fx(state).hardenedZones || {};
        var cand = nb.filter(function (z) { return !hz[z.id]; }); if (!cand.length) cand = nb;
        var z = (rng && typeof rng.pick === 'function') ? rng.pick(cand) : cand[0];
        var c = ctx(state, 'insurance_retreat'); c.zoneId = z.id; c.name = z.name;
      },
      choices: [
        choice('Home-hardening program', 'Harden the most exposed neighborhood; insurers re-rate.', 0, function (state, world, rng) {
          var c = ctx(state, 'insurance_retreat');
          if (WS.Projects && c.zoneId != null) {
            var r = WS.Projects.fund(state, world, 'home_hardening', c.zoneId, rng);
            if (r.ok) { flags(state).insuranceRetreatReady = false; return { text: 'Hardening funded; 1 carrier will write hardened homes again.', delta: { P: 2, T: 2 } }; }
            return { text: 'Hardening unaffordable; homeowners left with the FAIR Plan.', delta: { T: -1, F: -1 } };
          }
          flags(state).hardeningPledged = true;
          return { text: 'Council pledged hardening; insurers want roofs replaced first.', delta: { T: 1 } };
        }),
        choice('Petition FAIR Plan', 'State insurer of last resort for residents.', 0.1, function (state) {
          sched(state, 2, 'FAIR Plan enrollment', { type: 'custom', key: 'fairPlan', value: null, text: '' });
          return { text: 'Residents applied to FAIR Plan: thin coverage, mortgages close.', delta: { T: 1, F: -1 } };
        }),
        choice('Private matter', 'Insurance is between owners and carriers.', 0, function (state) {
          state.population = Math.max(1000, Math.round(num(state.population, C.HYDRO.BASE_POPULATION) - 200));
          return { text: '20 families sold at a loss and left.', delta: { F: -3, T: -2 } };
        })
      ]
    },
    {
      id: 'mutual_aid', title: 'Mutual-Aid Request', icon: '🤝', severity: 'info',
      text: 'The state asks for 1 engine, 1 tender, 6 firefighters for 2 weeks; your danger is high.',
      source: 'Colorado\'s Resource Mobilization Plan moves engines between counties; favours are returned.',
      when: function (state) { return season(state) === S.SUMMER && !fire(state).activeFire; },
      weight: function () { return 0.8; }, once: false,
      choices: [
        choice('Send engine and crew', 'Answer the call; your coverage thins.', 0.4, function (state) {
          var f = fire(state); f.preResponse = r1(num(f.preResponse, 0) - 0.15); flags(state).crewsAway = true; flags(state).mutualAidGiven = num(flags(state).mutualAidGiven, 0) + 1;
          return { text: 'Engine 2 saved a subdivision; WUI station short-handed 2 weeks.', delta: { T: 2, P: -1 } };
        }),
        choice('Send water instead', 'A tender and water exchange; crews stay.', 0, function (state) {
          addBudget(state, 0.5); if (state.reservoir) state.reservoir.storageAF = Math.max(0, num(state.reservoir.storageAF, 0) - 400);
          return { text: 'Tender and 400 AF exchange sent; neighbours paid $0.5M.', delta: { T: 1, W: -1, F: 1 } };
        }),
        choice('Decline', 'Your own danger is too high.', 0, function (state) {
          sched(state, 3, 'Mutual-aid memory', { type: 'custom', key: 'mutualAidDeclined', value: null, text: '' });
          return { text: 'Declined; the mobilization center noted it.', delta: { T: -2 } };
        })
      ]
    },
    {
      id: 'dust_on_snow', title: 'Dust on the Snowpack', icon: '🟤', severity: 'info',
      text: 'Four Corners dust browned the snowpack; melt comes 3 weeks early, reservoir still low.',
      source: 'Plateau dust advances Colorado melt by weeks; Silverton\'s Dust-on-Snow program tracks it.',
      when: function (state) { return season(state) === S.SPRING && num(climate(state).snowpackPct, 100) > 55; },
      weight: function () { return 0.9; }, once: false,
      choices: [
        choice('Fill reservoir early', 'Shift the schedule; catch the early pulse.', 0.1, function (state) {
          var r = state.reservoir; if (r) r.storageAF = Math.min(num(r.capacityAF, C.HYDRO.RESERVOIR_CAPACITY_AF), num(r.storageAF, 0) + 1200);
          return { text: 'Fill schedule moved up 3 weeks; ~1,200 AF banked.', delta: { W: 2 } };
        }),
        choice('Keep normal schedule', 'Forecasts are uncertain; stick to plan.', 0, function (state) {
          sched(state, 1, 'Early melt outcome', { type: 'custom', key: 'earlyMeltLoss', value: null, text: '' });
          return { text: 'Plan unchanged; catching the melt depends on operators noticing.', delta: {} };
        }),
        choice('Fund melt monitoring', 'Snow-survey flight and melt-front sensors.', 0.15, function (state) {
          flags(state).dustMonitoring = true; if (state.climate) state.climate.uncertainty = Math.min(num(state.climate.uncertainty, 0.15), 0.1);
          return { text: 'Survey flight and gages tracked the melt daily; operators adjusted.', delta: { W: 1 } };
        })
      ]
    },
    {
      id: 'beetle_kill', title: 'Beetle Kill', icon: '🪲', severity: 'warn',
      text: '1 sector went rust-red in a summer; dead pines fall as fuel within 4 seasons.',
      source: 'Pine beetle killed ~3.4 million Colorado acres in the 2000s; gray-phase stands fall.',
      when: function (state, world) { var s = season(state); return (s === S.FALL || s === S.WINTER) && zonesOf(world, 'forest').length > 0; },
      weight: function (state) { return 0.7 + (droughtLevel(state) >= 2 ? 0.4 : 0); }, once: false,
      prepare: function (state, world, rng) {
        var fz = zonesOf(world, 'forest'); if (!fz.length) return;
        var z = (rng && typeof rng.pick === 'function') ? rng.pick(fz) : fz[0];
        var c = ctx(state, 'beetle_kill'); c.zoneId = z.id; c.name = z.name;
        adjustZoneFuel(world, z.id, 1, 0.15);
        if (world && world.treeDensity && z.cells) { for (var k = 0; k < z.cells.length; k++) { var i = z.cells[k] | 0; if (i >= 0 && i < world.treeDensity.length) world.treeDensity[i] = C.clamp(world.treeDensity[i] - 0.05, 0, 1); } }
      },
      choices: [
        choice('Salvage log', 'Remove dead trees while they have value.', 1.2, function (state, world) {
          var c = ctx(state, 'beetle_kill'); if (c.zoneId != null) adjustZoneFuel(world, c.zoneId, 0.7, 0);
          return { text: 'Salvage crews worked ' + (c.name || 'the sector') + ' all winter; fuel down 30%.', delta: { P: 1, E: -1 } };
        }),
        choice('Leave it standing', 'Snags are woodpecker and elk habitat.', 0, function (state) {
          var c = ctx(state, 'beetle_kill');
          sched(state, 4, 'Gray-phase blowdown', { type: 'custom', key: 'beetleFuel', value: { zoneId: c.zoneId != null ? c.zoneId : null }, text: '' });
          return { text: 'Snags stay; woodpeckers now, fuel problem in 4 seasons.', delta: { E: 1 } };
        }),
        choice('Forest-health grant', 'State Forest Service cost-share next year.', 0.1, function (state) {
          var c = ctx(state, 'beetle_kill');
          sched(state, 2, 'Forest-health grant award', { type: 'budget', key: 'budget', value: 0.8, text: 'State Forest Service awarded $0.8M for beetle-kill.' });
          return { text: 'Grant filed for ' + (c.name || 'the sector') + '; $0.8M next year, maybe.', delta: {} };
        })
      ]
    },
    {
      id: 'flash_drought', title: 'Flash Drought', icon: '☀️', severity: 'crisis',
      text: '6 rainless weeks near 100°F; Drought Monitor jumped 2 categories, demand spiking.',
      source: 'Colorado flash droughts in 2012 and 2020 hit severe drought within one summer.',
      when: function (state) { var c = climate(state); return season(state) === S.SUMMER && num(c.precipIn, 3) < 1.2 && num(c.tempAnomF, 0) > 1; },
      weight: function (state) { return 1.3 + droughtLevel(state) * 0.2; }, once: false,
      choices: [
        choice('Stage 2 restrictions', 'Ban outdoor watering; sharp savings, sharp complaints.', 0, function (state) {
          setRestriction(state, 'stage2'); flags(state).droughtDeclared = true;
          return { text: 'Stage 2 overnight: lawns died, demand fell 25%.', delta: { W: 4, F: -2, T: -2 } };
        }),
        choice('Pay farms to fallow', 'Fallowing payments keep water in storage.', 0.8, function (state) {
          water(state).alloc.farms = Math.min(num(water(state).alloc.farms, 1), 0.7);
          return { text: 'Fallowing idled 800 acres; ranchers paid, reservoir kept water.', delta: { W: 2, F: -1, T: 1 } };
        }),
        choice('Ride it out', 'Monsoon rain could still come in August.', 0, function (state) {
          sched(state, 1, 'Drought aftermath', { type: 'outcome', key: 'E', value: -2, text: 'Flash drought killed willows; creek warm into fall.' });
          return { text: 'Monsoon rain came late and light.', delta: { W: -3, F: -3 } };
        })
      ]
    }
  ];
  var CARD_BY_ID = {};
  CARDS.forEach(function (c) { CARD_BY_ID[c.id] = c; });

  /* ------------------------------------------------------------------ fire response card */
  function fireResponseCard(state, world, fireSim) {
    if (!state) state = {};
    fire(state); // ensure state.fire exists
    var startCell = fireSim ? (fireSim.startCell != null ? fireSim.startCell : (fireSim.ignitionCell != null ? fireSim.ignitionCell : (fireSim.start != null ? fireSim.start : null))) : null;
    var zid = fireSim && fireSim.zoneId != null ? fireSim.zoneId : (startCell != null && world && world.zone ? world.zone[startCell | 0] : null);
    if (zid === -1) zid = null;
    var zname = zid != null ? zoneName(world, zid, 'the forest') : 'the forest';
    var upstream = false;
    try { if (startCell != null && world && typeof world.isUpstreamOfReservoir === 'function') upstream = !!world.isUpstreamOfReservoir(startCell | 0); } catch (e) { upstream = false; }
    if (!upstream && zid != null) { var z = zoneById(world, zid); upstream = !!(z && z.upstreamOfReservoir); }
    var acres = Math.round(num(fireSim && fireSim.acres, 0));
    var wind = num(climate(state).windMph, 8);
    var text = 'Wildfire in ' + zname + (acres ? ', ' + acres.toLocaleString() + ' acres' : '') + ', ' + Math.round(wind) + ' mph wind, ' + (upstream ? 'above the reservoir' : 'below the reservoir') + ': where do crews go?';
    function respond(focus, budgetLevel, costM, note, delta) {
      return function (state) {
        var fr = fire(state);
        var pre = C.clamp(num(fr.preResponse, 0), -0.5, 0.5); // bonus/penalty banked by earlier cards (tankers, mutual aid)
        fr.crewFocus = focus;
        fr.responseBudget = C.clamp(budgetLevel + pre, 0.5, 1.5);
        fr.preResponse = 0;
        return { text: note + ' Effort ' + Math.round(fr.responseBudget * 100) + '%.', delta: delta };
      };
    }
    var choices = [
      choice('Protect the town', 'Structure protection in the WUI; forest burns.', 1.5, respond('town', 1.3, 1.5, 'Every engine to the neighborhoods.', { P: 2 })),
      choice('Protect the watershed', 'Hold fire out of sectors draining to the intake.', 1.2, respond('watershed', 1.2, 1.2, 'Crews and retardant to the slopes above the reservoir.', { W: 1, E: 1 })),
      choice('Protect the farms', 'Keep it off the valley floor and headgates.', 0.8, respond('farms', 1.1, 0.8, 'Crews cut line along the ditches.', { F: 2 })),
      choice('Split the crews', 'A little of everything, full strength nowhere.', 1.0, respond(null, 0.85, 1.0, 'Crews split 3 ways; strength nowhere.', {}))
    ];
    // fire-response spending is allowed to run past the budget (emergency debt); the shared choice wrapper handles the trust penalty.
    return {
      id: 'fire_response', title: 'Wildfire: ' + zname, icon: '🚒', severity: 'crisis',
      text: text, source: CARD_BY_ID.fire_response.source,
      when: function () { return false; }, weight: function () { return 0; }, once: false,
      zoneId: zid, upstream: upstream, choices: choices
    };
  }

  /* ------------------------------------------------------------------ draw */
  function safeWhen(card, state, world) { try { return !!card.when(state, world); } catch (e) { return false; } }
  function safeWeight(card, state, world) { try { var w = num(card.weight(state, world), 1); return w > 0 ? w : 0; } catch (e) { return 1; } }
  function draw(state, world, rng) {
    if (!state) return [];
    var fl = flags(state);
    if (!fl.cardCooldown) fl.cardCooldown = {};
    if (!fl.cardsSeen) fl.cardsSeen = {};
    var turn = state.turn | 0;
    var cands = CARDS.filter(function (c) {
      if (c.id === 'fire_response') return false;
      if (c.once && fl.cardsSeen[c.id]) return false;
      var last = fl.cardCooldown[c.id];
      if (typeof last === 'number' && turn - last < COOLDOWN_TURNS) return false;
      return safeWhen(c, state, world);
    });
    if (!cands.length) return [];
    var roll = rng && typeof rng.next === 'function' ? rng.next() : 0.5;
    var count = roll < 0.25 ? 0 : (roll < 0.75 ? 1 : 2);
    if (turn === 0) count = Math.min(count, 1);
    // a crisis-severity card that is eligible always gets at least one slot
    if (count === 0 && cands.some(function (c) { return c.severity === 'crisis'; })) count = 1;
    count = Math.min(count, cands.length);
    var out = [];
    var pool = cands.slice();
    for (var n = 0; n < count && pool.length; n++) {
      var weights = pool.map(function (c) { return safeWeight(c, state, world); });
      var total = weights.reduce(function (a, b) { return a + b; }, 0);
      var idx = 0;
      if (total > 0) {
        var r = (rng && typeof rng.next === 'function' ? rng.next() : 0.5) * total;
        for (idx = 0; idx < pool.length - 1; idx++) { r -= weights[idx]; if (r <= 0) break; }
      }
      var card = pool.splice(idx, 1)[0];
      if (typeof card.prepare === 'function') { try { card.prepare(state, world, rng); } catch (e) { /* defensive */ } }
      fl.cardCooldown[card.id] = turn;
      if (card.once) fl.cardsSeen[card.id] = true;
      out.push(card);
    }
    return out;
  }

  /* ------------------------------------------------------------------ scheduled effects */
  function runScheduled(state, world) {
    var texts = [];
    if (!state || !Array.isArray(state.scheduled)) return texts;
    var turn = state.turn | 0, keep = [];
    for (var i = 0; i < state.scheduled.length; i++) {
      var s = state.scheduled[i];
      if (!s || num(s.dueTurn, 0) > turn) { if (s) keep.push(s); continue; }
      var e = s.effect || {}, txt = e.text || '';
      try {
        switch (e.type) {
          case 'outcome': { var d = {}; d[e.key] = num(e.value, 0); applyDelta(state, d); break; }
          case 'budget': addBudget(state, e.value); break;
          case 'flag': flags(state)[e.key] = e.value; break;
          case 'demand': { var f = flags(state); if (!f.demandMult) f.demandMult = {}; f.demandMult[e.key] = num(e.value, 1); break; }
          case 'custom': { var h = HANDLERS[e.key]; if (typeof h === 'function') { var r = h(state, world, e.value); if (typeof r === 'string' && r) txt = r; } break; }
          default: break;
        }
      } catch (err) { txt = txt || (s.label || 'Scheduled effect') + ' failed.'; }
      if (!txt) txt = s.label || 'Scheduled consequence arrived.';
      texts.push(txt);
      if (WS.State && typeof WS.State.log === 'function') { try { WS.State.log(state, txt, 'event'); } catch (err2) { /* ignore */ } }
    }
    state.scheduled = keep;
    return texts;
  }

  WS.Events = {
    CARDS: CARDS,
    byId: function (id) { return CARD_BY_ID[id] || null; },
    HANDLERS: HANDLERS,
    draw: draw,
    runScheduled: runScheduled,
    fireResponseCard: fireResponseCard,
    applyDelta: applyDelta,
    pay: pay,
    COOLDOWN_TURNS: COOLDOWN_TURNS
  };
})();
