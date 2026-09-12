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
        try { r = fn(state, world, rng) || {}; } catch (e) { r = { text: label + ' (no further effect).', delta: {} }; }
        var delta = Object.assign({}, r.delta || {});
        var text = String(r.text || label);
        if (bill.shortfall > 0) {
          delta.T = num(delta.T, 0) - 1;
          text += ' The town could not cover ' + C.fmt.money(bill.shortfall) + ' and took on emergency debt.';
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
      if (pct < 80) { applyDelta(state, { W: -3, T: -2 }); return 'The spring storms never came: snowpack finished at ' + Math.round(pct) + '% of average and the wait-and-see plan cost the town credibility.'; }
      applyDelta(state, { T: 1 }); return 'Late storms rescued the snowpack (' + Math.round(pct) + '% of average); waiting paid off this time.';
    },
    musselFouling: function (state) {
      if (fx(state).musselInspection || flags(state).musselInspection) return 'Boat inspectors intercepted two mussel-fouled hulls from Lake Powell; the reservoir stays clean.';
      addBudget(state, -1.5); flags(state).musselsEstablished = true; stats(state).contaminationOutageDays += 2;
      applyDelta(state, { W: -4, E: -4, T: -1 });
      return 'Zebra mussels have colonized the intake screens. Divers and chlorination cost $1.5M, and the reservoir now carries them forever.';
    },
    pipeBurst: function (state) {
      if (projectLevel(state, 'leak_detection') >= 2) { addBudget(state, -0.3); return 'The patched main finally split, but district metering flagged it within an hour; a $0.3M repair and no boil order.'; }
      addBudget(state, -1.8); flags(state).mainBreaks = num(flags(state).mainBreaks, 0) + 1; stats(state).contaminationOutageDays += 2;
      applyDelta(state, { W: -4, P: -1, T: -3 });
      return 'The patched main burst under Main Street: two days without water downtown, a boil order, and a $1.8M emergency rebuild.';
    },
    callRuling: function (state) {
      addBudget(state, -0.8); applyDelta(state, { F: -2, T: -1 });
      return 'The Division Engineer upheld the senior call. Legal fees ran $0.8M and the ditches were shut off anyway.';
    },
    algaeToxin: function (state) {
      stats(state).contaminationOutageDays += 3; applyDelta(state, { P: -3, W: -2, T: -3 });
      return 'Microcystin toxin from the ignored bloom reached the intake: a three-day do-not-drink notice and angry residents.';
    },
    wuiExposure: function (state, world, value) {
      var zid = value && value.zoneId != null ? value.zoneId : null;
      var hardened = zid != null && fx(state).hardenedZones && fx(state).hardenedZones[zid];
      if (hardened || flags(state).wuiCode) { applyDelta(state, { P: -1 }); return 'The new subdivision at ' + zoneName(world, zid, 'the forest edge') + ' passed its first fire-season inspection; hardened homes kept exposure manageable.'; }
      flags(state).insuranceRetreatReady = true; applyDelta(state, { P: -3 });
      return 'The unhardened subdivision at ' + zoneName(world, zid, 'the forest edge') + ' now sits in the highest hazard class; insurers are taking notice.';
    },
    fairPlan: function (state) { addBudget(state, -0.3); applyDelta(state, { T: 1 }); return 'The state FAIR Plan opened enrollment; the town paid $0.3M toward outreach and premium assistance.'; },
    mutualAidDeclined: function (state) {
      flags(state).mutualAidDenied = true; var f = fire(state); f.preResponse = r1(num(f.preResponse, 0) - 0.15);
      return 'Neighbouring counties remember the refusal: the next call for mutual-aid engines will be answered slowly.';
    },
    beetleFuel: function (state, world, value) {
      var zid = value && value.zoneId != null ? value.zoneId : null;
      if (zid != null) adjustZoneFuel(world, zid, 1, 0.1);
      applyDelta(state, { P: -1 });
      return 'Gray-phase beetle-kill in ' + zoneName(world, zid, 'the forest') + ' is blowing down; heavy dead fuel now carpets the sector.';
    },
    fishKillFollowup: function (state) {
      if (num(climate(state).streamflowCfs, 60) < C.HYDRO.MIN_FLOW_CFS * 1.2) { applyDelta(state, { E: -3, F: -1, T: -2 }); return 'Dead brown trout lined the creek below town; the fishing outfitters cancelled the rest of the season.'; }
      return 'Cooler weather and better flows spared the trout this time.';
    },
    grantAwarded: function (state, world, value) {
      var m = num(value && value.amountM != null ? value.amountM : value, 2.5);
      addBudget(state, m); flags(state).federalGrant = true; applyDelta(state, { T: 1 });
      return 'Grant awarded: ' + C.fmt.money(m) + ' arrived for watershed and hazard-mitigation work.';
    },
    earlyMeltLoss: function (state) {
      if (fx(state).sensorCoverage) { applyDelta(state, { W: 1 }); return 'Gage data caught the early melt and operators filled the reservoir ahead of schedule.'; }
      applyDelta(state, { W: -3 }); return 'Runoff peaked three weeks early and much of it spilled past the dam before anyone adjusted the diversion schedule.';
    },
    farmLeaseEnd: function (state) { flags(state).leaseActive = false; applyDelta(state, { F: 1 }); return 'The one-year fallow lease ended and the leased fields are back in production.'; }
  };

  /* ------------------------------------------------------------------ cards */
  var CARDS = [
    {
      id: 'low_snowpack', title: 'Thin Snowpack', icon: '🏔️', severity: 'warn',
      text: 'SNOTEL sites on the divide report snow water equivalent far below the median for this date, and the south faces above the creek are already brown. Ranchers are eyeing their ditch schedules, the ski hill closed early, and runoff forecasts have been cut sharply.',
      source: 'Why this happens in Colorado: about 80% of the state\'s water supply starts as mountain snow, and the April 1 snowpack reading sets the year\'s runoff forecast.',
      when: function (state) { var s = season(state); return (s === S.WINTER || s === S.SPRING) && num(climate(state).snowpackPct, 100) < 80; },
      weight: function (state) { return 1.5 + (80 - num(climate(state).snowpackPct, 100)) / 20; }, once: false,
      choices: [
        choice('Declare a drought watch', 'Voluntary watering restrictions and an honest public briefing now.', 0, function (state) {
          setRestriction(state, 'voluntary'); flags(state).droughtDeclared = true;
          return { text: 'You declared a drought watch and asked for voluntary cutbacks. Demand should soften, and people appreciated the straight talk.', delta: { W: 2, F: -1, T: 1 } };
        }),
        choice('Wait for spring storms', 'March and April are the snowiest months; the forecast could still recover.', 0, function (state) {
          sched(state, 1, 'Snowpack follow-up', { type: 'custom', key: 'snowpackFollowup', value: null, text: '' });
          return { text: 'You held off on restrictions and bet on late-season storms. The answer comes next season.', delta: {} };
        }),
        choice('Lease water from a ranch', 'Pay Lazy J to fallow hay fields for a year and leave the water in the reservoir.', 1.2, function (state) {
          flags(state).leaseActive = true; sched(state, 4, 'Fallow lease ends', { type: 'custom', key: 'farmLeaseEnd', value: null, text: '' });
          return { text: 'A one-year fallow lease keeps roughly 900 AF in storage. The hay meadow goes brown and two ranch hands are laid off.', delta: { W: 4, F: -3, E: 1 } };
        })
      ]
    },
    {
      id: 'heat_wave', title: 'Heat Dome', icon: '🌡️', severity: 'warn',
      text: 'A ridge of high pressure parks over the Rockies: 98°F in town for the fifth day, red-flag winds every afternoon, and lawns turning to straw. Sprinklers account for more than half of the water leaving the treatment plant, and the reservoir drops each morning.',
      source: 'Why this happens in Colorado: outdoor irrigation drives half or more of Front Range summer water use, and the state has warmed about 2°F since the 1980s, lengthening these spells.',
      when: function (state) { return season(state) === S.SUMMER && num(climate(state).tempAnomF, 0) > 1.5; },
      weight: function (state) { return 1 + num(climate(state).tempAnomF, 0) / 3; }, once: false,
      choices: [
        choice('Stage 1 watering restrictions', 'Two watering days a week, enforced; saves water, annoys lawn owners.', 0, function (state) {
          setRestriction(state, 'stage1');
          return { text: 'Stage 1 restrictions cut outdoor use sharply. Code enforcement is busy and the golf course is furious.', delta: { W: 3, F: -1, T: -1 } };
        }),
        choice('Open cooling centers', 'Run the library and rec center as cooling centers with extended hours.', 0.3, function (state) {
          return { text: 'Cooling centers kept the elderly out of the ER, but watering continued unchecked and the reservoir paid for it.', delta: { P: 2, W: -2 } };
        }),
        choice('Ride it out', 'Heat waves end; do nothing special.', 0, function (state) {
          sched(state, 1, 'Warm-water aftermath', { type: 'outcome', key: 'E', value: -2, text: 'Warm, low flows from the heat dome stressed trout and fed algae downstream.' });
          return { text: 'You waited it out. Demand stayed high all week and two heat-related hospitalizations made the paper.', delta: { W: -2, P: -1 } };
        })
      ]
    },
    {
      id: 'mussels', title: 'Mussel-Fouled Boat at the Ramp', icon: '🐚', severity: 'warn',
      text: 'A wakeboard boat trailered up from Lake Powell arrives at the marina with a crust of tiny striped shells on its outdrive. The ramp volunteer is unsure what to do. If quagga or zebra mussels reach the reservoir, they will coat the intake screens forever.',
      source: 'Why this happens in Colorado: adult zebra mussels were found in the state for the first time at Highline Lake in 2022 and in the Colorado River near Grand Junction in 2024; infested boats from Lake Powell are the main pathway.',
      when: function (state) { return (season(state) === S.SPRING || season(state) === S.SUMMER) && !fx(state).musselInspection; },
      weight: function () { return 1.2; }, once: true,
      choices: [
        choice('Fund inspection stations now', 'Stand up CPW-certified inspection and decontamination at every ramp.', 0.8, function (state, world, rng) {
          flags(state).musselInspection = true;
          if (WS.Projects && !projectLevel(state, 'mussel_inspection')) {
            state.budget = r1(num(state.budget, 0) + 0.8); // the choice paid; let the project record the funding
            var r = WS.Projects.fund(state, world, 'mussel_inspection', null, rng);
            if (!r.ok) state.budget = Math.max(0, r1(num(state.budget, 0) - 0.8));
          }
          return { text: 'Inspection stations went up within the week; the boat was decontaminated with 140°F water and sent on its way.', delta: { E: 2, T: 1 } };
        }),
        choice('Signs and volunteer checks', 'Post Clean-Drain-Dry signs and ask volunteers to look at boats.', 0.05, function (state) {
          flags(state).musselRisk = true;
          sched(state, 4, 'Mussel survey at the intake', { type: 'custom', key: 'musselFouling', value: null, text: '' });
          return { text: 'Signs went up. Volunteers check maybe one boat in five. Divers will inspect the intake next year.', delta: {} };
        }),
        choice('Close the ramp to trailered boats', 'No motorboats this season; paddlecraft only.', 0, function (state) {
          flags(state).rampClosed = true;
          return { text: 'The ramp closed. The reservoir stays clean, the marina lost its summer, and the town council heard about it.', delta: { E: 3, F: -3, T: -2 } };
        })
      ]
    },
    {
      id: 'lightning_fire', title: 'Dry Lightning Over the Divide', icon: '⚡', severity: 'crisis',
      text: 'An evening thunderstorm rolls off the peaks with lightning and almost no rain. By dawn a lookout reports a smoke column in the timber above the reservoir. Fuels are cured, wind is forecast to rise by afternoon, and the sector has not burned in decades.',
      source: 'Why this happens in Colorado: dry lightning from monsoon-edge storms starts many of the state\'s largest fires; the lightning-caused 2020 Pine Gulch Fire near Grand Junction burned about 139,000 acres.',
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
        choice('Order air tankers early', 'Request state and federal aircraft before the wind picks up.', 1.0, function (state) {
          var f = fire(state); f.preResponse = r1(num(f.preResponse, 0) + 0.25);
          return { text: 'Tankers and a Type 1 helicopter were on scene by noon over ' + (ctx(state, 'lightning_fire').name || 'the sector') + '. Retardant lines give the crews a chance.', delta: { P: 1 } };
        }),
        choice('Manage it for resource benefit', 'Under managed-fire policy, monitor and let it clean out surface fuels.', 0.2, function (state) {
          var f = fire(state); f.preResponse = r1(num(f.preResponse, 0) - 0.2); flags(state).managedFire = true;
          var managed = f.policy !== 'suppress_all';
          return { text: managed ? 'Crews monitor from the ridge. If the weather holds, the sector gets the fire it needs; if it does not, this was a gamble.' : 'Your suppress-all policy is on the books, so the decision drew criticism, and the crews were slow to reorganize.', delta: managed ? { E: 2, P: -1 } : { P: -2, T: -1 } };
        }),
        choice('Standard initial attack', 'Send the local engines and hand crews; call for more if it grows.', 0.3, function (state) {
          return { text: 'Engines from both stations and a hand crew went up the ridge road. The rest depends on wind and fuel.', delta: {} };
        })
      ]
    },
    {
      id: 'storm_forecast', title: 'Flash-Flood Watch on the Burn Scar', icon: '⛈️', severity: 'crisis',
      text: 'The National Weather Service has issued a flash-flood watch for the burn scar: a slow monsoon cell could drop an inch in an hour on slopes that now shed water like pavement. Debris flows can reach the creek in minutes. The county has three days.',
      source: 'Why this happens in Colorado: burned soils repel water and have lost their needle cover, so NWS issues flash-flood watches for burn scars at rain rates harmless on healthy forest, as after the 2020 fires and the 2021 Glenwood Canyon debris flows.',
      when: function (state, world) { var s = season(state); return (s === S.SUMMER || s === S.FALL) && !state.pendingStorm && scarCells(world) >= 40; },
      weight: function (state, world) { return 1.5 + Math.min(2, scarCells(world) / 400); }, once: false,
      prepare: function (state, world, rng) {
        var inten = r1(1.0 + (rng ? rng.next() : 0.5) * 1.5);
        state.pendingStorm = { intensityIn: inten, durationHr: 1.5, turnsUntil: 0, source: 'event' };
        ctx(state, 'storm_forecast').intensityIn = inten;
      },
      choices: [
        choice('Pre-position crews and sandbags', 'Stage county road crews, sandbags and pumps at the base of the scar.', 0.4, function (state) {
          if (!state.pendingStorm) state.pendingStorm = { intensityIn: 1.6, durationHr: 1.5, turnsUntil: 0, source: 'event' };
          flags(state).stormPrepped = true; state.emergencyFund = r1(num(state.emergencyFund, 0) + 0.5);
          return { text: 'Crews are staged and residents below the scar have been briefed. The emergency fund got a $0.5M top-up from county reserves.', delta: { P: 1 } };
        }),
        choice('Request a state emergency declaration', 'Unlocks state disaster funds, but paperwork and a cost-share follow.', 0, function (state) {
          if (!state.pendingStorm) state.pendingStorm = { intensityIn: 1.6, durationHr: 1.5, turnsUntil: 0, source: 'event' };
          state.emergencyFund = r1(num(state.emergencyFund, 0) + 1.5); flags(state).stateEmergency = true;
          sched(state, 2, 'Disaster cost-share due', { type: 'budget', key: 'budget', value: -0.5, text: 'The state disaster declaration cost-share came due: -$0.5M.' });
          return { text: 'The governor signed the declaration; $1.5M in state emergency funds are available for the storm, with a cost-share due later.', delta: { T: -1 } };
        }),
        choice('Wait for the next forecast update', 'Monsoon cells are fickle; the watch may be cancelled.', 0, function (state) {
          if (!state.pendingStorm) state.pendingStorm = { intensityIn: 1.6, durationHr: 1.5, turnsUntil: 0, source: 'event' };
          return { text: 'You waited. The watch stayed in effect and the crews will be scrambling when the rain starts.', delta: { P: -1 } };
        })
      ]
    },
    {
      id: 'pipe_leak', title: 'Water Main Leak on Main Street', icon: '🚰', severity: 'info',
      text: 'Public works found a wet patch of asphalt that never dries; a listening rod confirms a 1950s cast-iron main is weeping under the street, losing maybe 40 gallons a minute. The crew can dig now or patch and defer.',
      source: 'Why this happens in Colorado: utilities commonly lose 10-20% of treated water to leaks, and freeze-thaw cycles plus expansive clay soils crack old cast-iron mains.',
      when: function (state) { return num(fx(state).leakReduction, 0) < 0.18; },
      weight: function (state) { return season(state) === S.WINTER ? 1.4 : 0.9; }, once: false,
      choices: [
        choice('Dig and replace the main now', 'Full repair with a road closure for a week.', 0.6, function (state) {
          return { text: 'The main was replaced in five days. Traffic grumbled; the leak is gone.', delta: { W: 1 } };
        }),
        choice('Clamp it and defer', 'A repair clamp buys time; schedule the real fix for a future budget.', 0.1, function (state) {
          sched(state, 2, 'Deferred main repair', { type: 'custom', key: 'pipeBurst', value: null, text: '' });
          return { text: 'A clamp stopped the visible leak. The main is still 70 years old.', delta: {} };
        }),
        choice('Start a leak-detection program', 'Fund acoustic loggers and district metering system-wide.', 0, function (state, world, rng) {
          if (WS.Projects && projectLevel(state, 'leak_detection') < 3) {
            var r = WS.Projects.fund(state, world, 'leak_detection', null, rng);
            if (r.ok) return { text: 'Leak detection funded: ' + r.text + ' The Main Street leak was the first of eleven found.', delta: { W: 2, T: 1 } };
            pay(state, 0.1); sched(state, 2, 'Deferred main repair', { type: 'custom', key: 'pipeBurst', value: null, text: '' });
            return { text: 'The program was unaffordable (' + r.text + '), so the crew clamped the leak and moved on.', delta: {} };
          }
          return { text: 'The program is already at full strength; the crew fixed the main from its work list.', delta: { W: 1 } };
        })
      ]
    },
    {
      id: 'federal_funding', title: 'Grant Window Opens', icon: '🏛️', severity: 'info',
      text: 'A regional planner emails: a federal hazard-mitigation grant round and a Colorado Water Plan grant cycle both close this month. Applications need staff time and a local match, and awards take a year or more. Small towns rarely win without a shovel-ready project list.',
      source: 'Why this happens in Colorado: the 2021 infrastructure law, FEMA\'s BRIC program and Colorado Water Plan grants administered by the CWCB fund local watershed and hazard-mitigation work, usually with a local match.',
      when: function (state) { return (state.turn | 0) >= 1; },
      weight: function () { return 0.8; }, once: false,
      choices: [
        choice('Apply for the watershed grant', 'Put up a $0.5M match toward forest and wetland work.', 0.5, function (state) {
          sched(state, 3, 'Watershed grant decision', { type: 'custom', key: 'grantAwarded', value: { amountM: 3.0 }, text: '' });
          return { text: 'The application went in with the match reserved. Expect a decision in about a year.', delta: {} };
        }),
        choice('Apply for hazard-mitigation funds', 'A larger match, but the award also raises the emergency fund ceiling.', 0.8, function (state) {
          sched(state, 4, 'Hazard-mitigation award', { type: 'custom', key: 'grantAwarded', value: { amountM: 2.5 }, text: '' });
          sched(state, 4, 'Federal grant flag', { type: 'flag', key: 'federalGrant', value: true, text: 'Federal hazard-mitigation status now adds to each storm\'s emergency fund.' });
          return { text: 'The county co-signed the mitigation application. If it lands, emergency response gets a permanent boost.', delta: {} };
        }),
        choice('Skip this round', 'Staff are stretched; let the deadline pass.', 0, function (state) {
          return { text: 'The deadline passed. The planner shrugged; there will be another cycle.', delta: {} };
        })
      ]
    },
    {
      id: 'residents_oppose_burn', title: 'Residents Oppose the Burn', icon: '🪧', severity: 'warn',
      text: 'Flyers appear at the post office: "Say NO to the burn." A homeowners\' group near the sector remembers a prescribed fire that escaped a decade ago and wants the plan pulled. They have packed the council meeting; the burn window is only weeks wide.',
      source: 'Why this happens in Colorado: the 2012 Lower North Fork prescribed burn near Conifer escaped and killed three people, prompting a moratorium and new certification rules; smoke permits come from the state health department.',
      when: function (state) { return !!(state.projects && state.projects.pendingBurn); },
      weight: function () { return 2.5; }, once: false,
      choices: [
        choice('Hold a community meeting, then proceed', 'Walk residents through the burn plan, contingency crews and smoke forecast.', 0.15, function (state) {
          flags(state).townHallHeld = true;
          return { text: 'The burn boss answered questions for two hours. Most residents left reassured; the burn stays on the calendar.', delta: { T: 2 } };
        }),
        choice('Cancel the burn', 'Pull the plan and refund half the preparation cost.', 0, function (state) {
          var pb = state.projects ? state.projects.pendingBurn : null;
          if (pb) { state.projects.pendingBurn = null; addBudget(state, 0.3); flags(state).burnCancelled = num(flags(state).burnCancelled, 0) + 1; if (state.projects._rev != null) state.projects._rev++; }
          return { text: 'The burn was cancelled and half the cost recovered. The fuel stays in the woods.', delta: { T: 1, E: -1 } };
        }),
        choice('Proceed without a meeting', 'The window is short; ignore the flyers.', 0, function (state) {
          return { text: 'The burn went ahead over loud objections. Trust in the fire program took a hit that will outlast the smoke.', delta: { T: -4 } };
        })
      ]
    },
    {
      id: 'fire_response', title: 'Wildfire Response', icon: '🚒', severity: 'crisis',
      text: 'A wildfire is burning. Decide where the crews go.',
      source: 'Why this happens in Colorado: initial attack is shared between local fire districts, county sheriffs, the Division of Fire Prevention and Control and federal agencies; protecting homes and protecting the watershed compete for the same crews.',
      when: function () { return false; }, weight: function () { return 0; }, once: false,
      choices: []
    },
    {
      id: 'senior_call', title: 'Senior Water Right Places a Call', icon: '⚖️', severity: 'warn',
      text: 'The water commissioner phones: a senior downstream right from the 1880s has placed a call on the creek. Under prior appropriation, every junior diverter, including the town\'s ditches and two farms, must shut headgates until it is satisfied. The farms have hay in the ground.',
      source: 'Why this happens in Colorado: prior appropriation gives the oldest rights first claim; when a senior right places a "call", the Division Engineer curtails junior diversions upstream regardless of who needs the water most.',
      when: function (state) { var s = season(state); var w = water(state); return (s === S.SUMMER || s === S.FALL) && (droughtLevel(state) >= 2 || num(w.alloc.downstream, 1) < 1 || num(w.alloc.tribal, 1) < 1 || storagePct(state) < 0.5); },
      weight: function (state) { return 1 + droughtLevel(state) * 0.3; }, once: false,
      choices: [
        choice('Honor the call', 'Curtail junior farm diversions; the law is the law.', 0, function (state) {
          var w = water(state); w.alloc.farms = Math.min(num(w.alloc.farms, 1), 0.6); w.alloc.downstream = 1;
          return { text: 'Headgates closed on the junior ditches. Two farms lost their second cutting; the commissioner noted the town\'s cooperation.', delta: { F: -3, W: -1, T: 1 } };
        }),
        choice('Negotiate a temporary lease', 'Pay the senior holder to defer part of the call this season.', 1.0, function (state) {
          water(state).alloc.downstream = 1;
          return { text: 'A one-season lease satisfied the call on paper and kept most ditches running.', delta: { F: -1 } };
        }),
        choice('Contest the call', 'Argue futility (the water would not reach them anyway) before the Division Engineer.', 0.2, function (state) {
          sched(state, 1, 'Division Engineer ruling', { type: 'custom', key: 'callRuling', value: null, text: '' });
          return { text: 'Lawyers filed a futile-call petition. The senior holder is not amused, and the ruling comes next season.', delta: { T: -3 } };
        })
      ]
    },
    {
      id: 'algae_bloom', title: 'Algae Bloom at the Reservoir', icon: '🟢', severity: 'warn',
      text: 'A pea-green scum has spread across the warm, shrunken upper end of the reservoir, and a dog that swam there is sick. The lab confirms cyanobacteria. The intake is drawing from the same warm layer, and the treatment operators are already reporting taste-and-odour complaints.',
      source: 'Why this happens in Colorado: warm water, low pools and nutrient runoff feed cyanobacteria; state health and wildlife agencies post toxic-algae advisories at Colorado reservoirs most summers.',
      when: function (state) { var r = reservoir(state); return season(state) === S.SUMMER && (num(r.algae, 0) > 0.3 || (storagePct(state) < 0.55 && num(climate(state).tempAnomF, 0) > 1)); },
      weight: function (state) { return 1 + num(reservoir(state).algae, 0) * 2; }, once: false,
      choices: [
        choice('Treat and switch intake depth', 'Algaecide on the bloom; draw from deeper, colder water if the intake allows.', 0.4, function (state) {
          var multi = !!fx(state).multiLevelIntake; if (state.reservoir) state.reservoir.algae = C.clamp(num(state.reservoir.algae, 0) * 0.4, 0, 1);
          return { text: multi ? 'The multi-level intake dropped to the cold hypolimnion and the bloom was treated; tap water never changed.' : 'The bloom was treated, but with a single fixed intake the plant still drew murky warm water for a week.', delta: multi ? { W: 3, E: -1 } : { W: 1, E: -1 } };
        }),
        choice('Post an advisory and close the beach', 'No swimming, no dogs, and honest signage.', 0.05, function (state) {
          return { text: 'Signs went up and lifeguards went home. Boaters kept boating; the marina did not.', delta: { P: 1, F: -2, T: 1 } };
        }),
        choice('Wait for it to die back', 'Blooms usually crash with the first cold nights.', 0, function (state) {
          sched(state, 1, 'Bloom toxin at the intake', { type: 'custom', key: 'algaeToxin', value: null, text: '' });
          return { text: 'You left the bloom alone. Cold nights are weeks away.', delta: {} };
        })
      ]
    },
    {
      id: 'smoke_event', title: 'Smoke Settles in the Valley', icon: '🌫️', severity: 'warn',
      text: 'Smoke from fires across the West pours over the divide and pools in the valley, hiding the ridge. The air-quality index reads "very unhealthy," the school cancels recess, and the clinic fills with wheezing kids and elderly ranchers. It may last a week.',
      source: 'Why this happens in Colorado: smoke from fires in Colorado and neighbouring states pushed Denver-area air quality among the worst in the world on some days in 2020 and 2021.',
      when: function (state) { var s = season(state); return (s === S.SUMMER || s === S.FALL) && (num(climate(state).fireDanger, 0.2) >= 0.35 || num(fire(state).smokeDays, 0) > 0); },
      weight: function (state) { return 0.8 + num(climate(state).fireDanger, 0.2); }, once: false,
      choices: [
        choice('Open clean-air shelters', 'HEPA-filtered rooms for the vulnerable; rent filters if you have no shelters.', 0.3, function (state) {
          var has = !!fx(state).shelters;
          fire(state).smokeDays = num(fire(state).smokeDays, 0) + (has ? 2 : 4);
          return { text: has ? 'Your clean-air shelters opened within hours; the clinic stayed quiet.' : 'Rented HEPA units turned the gym into a makeshift clean-air room. It helped, but it was improvised.', delta: has ? { P: 3, T: 1 } : { P: 1 } };
        }),
        choice('Cancel outdoor events, hand out masks', 'Close the pool, cancel the rodeo, distribute N95s.', 0.1, function (state) {
          fire(state).smokeDays = num(fire(state).smokeDays, 0) + 4;
          return { text: 'The rodeo and the farmers\' market were cancelled; masks went out at the library.', delta: { P: 1, F: -1 } };
        }),
        choice('Business as usual', 'It is only smoke; people can stay indoors on their own.', 0, function (state) {
          fire(state).smokeDays = num(fire(state).smokeDays, 0) + 6;
          return { text: 'Life went on. The clinic logged a dozen respiratory visits and a grandmother was flown to Denver.', delta: { P: -2, T: -1 } };
        })
      ]
    },
    {
      id: 'subdivision_proposal', title: 'Subdivision Proposal on the Forest Edge', icon: '🏘️', severity: 'info',
      text: 'A developer wants to build 180 homes on the bench where the pines meet the sagebrush, one road in and out. The tax base needs it, the school needs the families, and the fire chief is quietly appalled.',
      source: 'Why this happens in Colorado: nearly half of the state\'s residents live in the wildland-urban interface, and the legislature created a Wildfire Resiliency Code Board in 2023 to write statewide WUI building standards.',
      when: function (state) { return (state.turn | 0) >= 1 && !fire(state).activeFire; },
      weight: function () { return 0.7; }, once: false,
      prepare: function (state, world, rng) {
        var nb = zonesOf(world, 'neighborhood'); if (!nb.length) return;
        var z = (rng && typeof rng.pick === 'function') ? rng.pick(nb) : nb[0];
        var c = ctx(state, 'subdivision_proposal'); c.zoneId = z.id; c.name = z.name;
      },
      choices: [
        choice('Approve as proposed', 'Maximum tax revenue and growth; no special fire requirements.', 0, function (state) {
          var c = ctx(state, 'subdivision_proposal');
          state.population = Math.round(num(state.population, C.HYDRO.BASE_POPULATION) + 600); addBudget(state, 1.5);
          flags(state).wuiGrowth = num(flags(state).wuiGrowth, 0) + 1;
          sched(state, 4, 'Subdivision fire-season review', { type: 'custom', key: 'wuiExposure', value: { zoneId: c.zoneId != null ? c.zoneId : null }, text: '' });
          return { text: 'Approved. Foundations are being poured next to ' + (c.name || 'the forest edge') + '; 600 new residents and $1.5M in fees arrive with them.', delta: { F: 2, E: -1 } };
        }),
        choice('Approve with WUI code conditions', 'Class A roofs, defensible space, a second access road and fewer lots.', 0, function (state) {
          var c = ctx(state, 'subdivision_proposal');
          state.population = Math.round(num(state.population, C.HYDRO.BASE_POPULATION) + 450); addBudget(state, 0.8);
          flags(state).wuiCode = true; flags(state).wuiGrowth = num(flags(state).wuiGrowth, 0) + 1;
          sched(state, 4, 'Subdivision fire-season review', { type: 'custom', key: 'wuiExposure', value: { zoneId: c.zoneId != null ? c.zoneId : null }, text: '' });
          return { text: 'Approved with conditions: 140 hardened homes, two roads out, and a fee schedule the developer grumbled about.', delta: { F: 1, P: 1 } };
        }),
        choice('Deny the plat', 'Keep the forest edge undeveloped.', 0, function (state) {
          return { text: 'Denied. The developer is suing; the elk keep their winter range and the fire chief bought you a coffee.', delta: { E: 2, F: -1, T: -2 } };
        })
      ]
    },
    {
      id: 'fish_kill_warning', title: 'Low-Flow Fish Kill Warning', icon: '🐟', severity: 'warn',
      text: 'The creek below the dam is down to a warm trickle over exposed cobbles; the afternoon temperature logger reads 71°F. The state fisheries biologist warns that brown trout will start dying within days unless flows come up. The fly shop has already stopped booking guides.',
      source: 'Why this happens in Colorado: when streams warm past about 70°F at low flow, trout stress and die; CPW issues voluntary fishing closures, and CWCB instream-flow rights hold a legal minimum in many reaches.',
      when: function (state) { var s = season(state); return (s === S.SUMMER || s === S.FALL) && (num(climate(state).streamflowCfs, 60) < C.HYDRO.MIN_FLOW_CFS * 1.4 || num(water(state).alloc.wildlife, 1) < 1); },
      weight: function (state) { return 1.2 + Math.max(0, (C.HYDRO.MIN_FLOW_CFS * 1.4 - num(climate(state).streamflowCfs, 60)) / 10); }, once: false,
      choices: [
        choice('Release instream flow from storage', 'Open the outlet to hold the legal minimum flow; the reservoir drops.', 0, function (state) {
          water(state).alloc.wildlife = 1; if (state.climate) state.climate.streamflowCfs = Math.max(num(state.climate.streamflowCfs, 0), C.HYDRO.MIN_FLOW_CFS * 1.5);
          return { text: 'Cold water from the outlet brought the creek up overnight. The reservoir gave up a few hundred acre-feet to do it.', delta: { E: 3, W: -2 } };
        }),
        choice('Voluntary fishing closure only', 'Ask anglers to stay off the water after noon; do not release water.', 0, function (state) {
          sched(state, 1, 'Fish kill outcome', { type: 'custom', key: 'fishKillFollowup', value: null, text: '' });
          return { text: 'A voluntary afternoon closure went out. Whether the trout survive depends on the weather.', delta: { E: 1, F: -1 } };
        }),
        choice('Hold the water', 'Storage is for people; the fish will have to cope.', 0, function (state) {
          water(state).alloc.wildlife = Math.min(num(water(state).alloc.wildlife, 1), 0.5);
          sched(state, 1, 'Fish kill outcome', { type: 'custom', key: 'fishKillFollowup', value: null, text: '' });
          return { text: 'The outlet stayed shut. Photographs of dead trout are already circulating.', delta: { E: -4, T: -1 } };
        })
      ]
    },
    {
      id: 'hydro_shortfall', title: 'Hydropower Shortfall', icon: '⚡', severity: 'info',
      text: 'The turbine at the dam is producing a fraction of its rated output: with the pool this low there is little head, and releases have favoured storage. The co-op says the town must buy replacement power or release more water through the penstock.',
      source: 'Why this happens in Colorado: small hydro plants on municipal dams depend on head and release volume, and both fall with the reservoir in a dry year.',
      when: function (state) { var s = season(state); return (s === S.FALL || s === S.WINTER) && (storagePct(state) < 0.5 || num(water(state).alloc.hydro, 1) < 0.8); },
      weight: function () { return 0.8; }, once: false,
      choices: [
        choice('Buy replacement power', 'Cover the shortfall on the wholesale market and keep the water.', 0.7, function (state) {
          return { text: 'The co-op bought market power for the winter. Expensive, but the reservoir keeps every acre-foot.', delta: {} };
        }),
        choice('Release more through the turbine', 'Raise the hydro release; water still flows downstream, but storage drops.', 0, function (state) {
          water(state).alloc.hydro = 1; stats(state).hydroMWh = num(stats(state).hydroMWh, 0) + 400;
          return { text: 'Releases went up and the turbine hummed all winter. Downstream users got a bonus; spring storage will be lower.', delta: { F: 2, W: -2 } };
        }),
        choice('Accept the shortfall', 'Let the co-op pass the cost to ratepayers.', 0, function (state) {
          return { text: 'Electric bills rose a few dollars a month and the council took the calls.', delta: { F: -2, T: -1 } };
        })
      ]
    },
    {
      id: 'well_failure', title: 'Rural Wells Running Dry', icon: '🪣', severity: 'warn',
      text: 'Families on the sagebrush bench outside town report sputtering taps: their shallow alluvial wells have dropped below the pump intake as the creek and the water table fell. Three households are hauling water in pickup tanks. A drilling rig is booked out six weeks.',
      source: 'Why this happens in Colorado: hundreds of thousands of residents rely on permitted household wells, and shallow alluvial wells drop with stream stage and neighbouring pumping during drought.',
      when: function (state) { var s = season(state); return (s === S.SUMMER || s === S.FALL) && (droughtLevel(state) >= 2 || storagePct(state) < 0.45); },
      weight: function (state) { return 0.8 + droughtLevel(state) * 0.25; }, once: false,
      choices: [
        choice('Haul water and open a fill station', 'Run a bulk-water fill station and county water hauling.', 0.5, function (state) {
          return { text: 'A fill station opened at the fairgrounds and county trucks made rounds. Nobody went without.', delta: { P: 2, T: 2, W: -1 } };
        }),
        choice('Emergency well-deepening grants', 'Cost-share deeper wells for affected households.', 0.9, function (state) {
          flags(state).wellGrants = true;
          return { text: 'Cost-share grants got the rig to the bench a month sooner; deeper wells should last through the next drought.', delta: { P: 1, T: 1 } };
        }),
        choice('Leave it to the homeowners', 'Private wells are private responsibility.', 0, function (state) {
          return { text: 'The families hauled their own water. Two put their homes up for sale.', delta: { P: -2, T: -3 } };
        })
      ]
    },
    {
      id: 'tourism_boom', title: 'Boaters Discover the Reservoir', icon: '⛵', severity: 'info',
      text: 'A full reservoir, a clear creek and a viral video have the marina lot overflowing every weekend with Front Range trailers. Motels are booked, fly shops are hiring, and the ramp line reaches the highway. The shorebirds have left the north shore.',
      source: 'Why this happens in Colorado: outdoor recreation is a multi-billion-dollar part of the state economy, and reservoirs full of snowmelt draw boaters from across the Front Range.',
      when: function (state) { var s = season(state); return (s === S.SPRING || s === S.SUMMER) && storagePct(state) > 0.65 && num(reservoir(state).turbidity, 0) < 0.3 && !fire(state).activeFire; },
      weight: function () { return 0.9; }, once: false,
      choices: [
        choice('Promote it and extend marina hours', 'Lean in: more visitors, more revenue, more pressure on the shoreline.', 0.2, function (state) {
          stats(state).recreationVisits = num(stats(state).recreationVisits, 0) + 20000; flags(state).tourismPromoted = true;
          return { text: 'Summer visitation doubled and sales-tax receipts with it. The shorebirds did not come back.', delta: { F: 3, E: -1 } };
        }),
        choice('Cap daily launches', 'A permit system limits boats and protects the shore.', 0.05, function (state) {
          stats(state).recreationVisits = num(stats(state).recreationVisits, 0) + 8000;
            return { text: 'Launch permits sold out every weekend; visitors grumbled but the shoreline held up.', delta: { F: 1, E: 1 } };
        }),
        choice('Add a visitor fee', 'A $10 day-use fee funds the ramp and the inspection crew.', 0, function (state) {
          addBudget(state, 0.6); stats(state).recreationVisits = num(stats(state).recreationVisits, 0) + 12000;
          return { text: 'Day-use fees brought in $0.6M. Locals resent paying to visit their own lake.', delta: { F: 1, T: -1 } };
        })
      ]
    },
    {
      id: 'ski_area_request', title: 'Ski Area Asks for Snowmaking Water', icon: '⛷️', severity: 'info',
      text: 'The ski hill, the valley\'s biggest winter employer, wants to open early and asks to pump reservoir water for snowmaking through December, when the creek is lowest. Most of that water melts back into the creek in April, but not all, and not this winter.',
      source: 'Why this happens in Colorado: ski areas make snow in October-December when streams are at baseflow; snowmaking water is usually pumped from reservoirs, and a share is lost to sublimation before spring.',
      when: function (state) { var s = season(state); return s === S.FALL || s === S.WINTER; },
      weight: function () { return 0.7; }, once: false,
      choices: [
        choice('Grant the full lease', 'They pay $0.8M; the reservoir drops through winter.', 0, function (state) {
          addBudget(state, 0.8); if (state.reservoir) state.reservoir.storageAF = Math.max(0, num(state.reservoir.storageAF, 0) - 600);
          return { text: 'The lifts spun by Thanksgiving and $0.8M landed in the budget. Six hundred acre-feet left the reservoir in November.', delta: { F: 3, W: -2, E: -1 } };
        }),
        choice('Grant a limited lease', 'Half the volume, with a return-flow credit in spring.', 0, function (state) {
          addBudget(state, 0.4); if (state.reservoir) state.reservoir.storageAF = Math.max(0, num(state.reservoir.storageAF, 0) - 300);
          return { text: 'A half lease opened the front side of the mountain in December. Both sides called it fair.', delta: { F: 1, W: -1 } };
        }),
        choice('Deny the request', 'Storage stays for summer; the ski hill opens when it snows.', 0, function (state) {
          return { text: 'The hill opened three weeks late on natural snow. Lift operators went unpaid in the meantime.', delta: { F: -2, T: -1, W: 1 } };
        })
      ]
    },
    {
      id: 'insurance_retreat', title: 'Insurers Pull Out of the WUI', icon: '📉', severity: 'warn',
      text: 'Non-renewal letters are landing in mailboxes in the forest-edge neighborhoods: two national carriers are leaving the county\'s high-hazard zones outright, and the rest are tripling premiums. Mortgages require coverage, so home sales have stalled and the realtors are at the council meeting.',
      source: 'Why this happens in Colorado: after the 2021 Marshall Fire, insurers non-renewed thousands of WUI policies statewide, and the legislature created the FAIR Plan in 2023 as an insurer of last resort.',
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
        choice('Launch a home-hardening program', 'Fund hardening in the most exposed neighborhood so insurers can re-rate it.', 0, function (state, world, rng) {
          var c = ctx(state, 'insurance_retreat');
          if (WS.Projects && c.zoneId != null) {
            var r = WS.Projects.fund(state, world, 'home_hardening', c.zoneId, rng);
            if (r.ok) { flags(state).insuranceRetreatReady = false; return { text: r.text + ' One carrier agreed to write policies again for hardened homes.', delta: { P: 2, T: 2 } }; }
            return { text: 'The hardening program could not be funded (' + r.text + '). Homeowners were left with the FAIR Plan.', delta: { T: -1, F: -1 } };
          }
          flags(state).hardeningPledged = true;
          return { text: 'The council pledged a hardening program; insurers want to see roofs replaced before they return.', delta: { T: 1 } };
        }),
        choice('Petition for FAIR Plan coverage', 'Get residents into the state insurer of last resort.', 0.1, function (state) {
          sched(state, 2, 'FAIR Plan enrollment', { type: 'custom', key: 'fairPlan', value: null, text: '' });
          return { text: 'The town helped residents apply to the FAIR Plan. Coverage is thin and premiums are high, but mortgages can close.', delta: { T: 1, F: -1 } };
        }),
        choice('It is a private matter', 'Insurance is between homeowners and their carriers.', 0, function (state) {
          state.population = Math.max(1000, Math.round(num(state.population, C.HYDRO.BASE_POPULATION) - 200));
          return { text: 'Twenty families sold at a loss and left. The forest-edge streets have a few dark windows now.', delta: { F: -3, T: -2 } };
        })
      ]
    },
    {
      id: 'mutual_aid', title: 'Mutual-Aid Request', icon: '🤝', severity: 'info',
      text: 'The neighbouring county has a fire running toward a town of 3,000, and the state asks for an engine, a water tender and six firefighters for two weeks. Your own danger is high; crews you send will not be here if lightning finds your ridge.',
      source: 'Why this happens in Colorado: the Resource Mobilization Plan, run by the Division of Fire Prevention and Control, moves engines and crews between counties during large fires, on the understanding that the favour is returned.',
      when: function (state) { return season(state) === S.SUMMER && !fire(state).activeFire; },
      weight: function () { return 0.8; }, once: false,
      choices: [
        choice('Send an engine and crew', 'Answer the call; your own coverage thins for the season.', 0.4, function (state) {
          var f = fire(state); f.preResponse = r1(num(f.preResponse, 0) - 0.15); flags(state).crewsAway = true; flags(state).mutualAidGiven = num(flags(state).mutualAidGiven, 0) + 1;
          return { text: 'Engine 2 rolled out at dawn. The crew saved a subdivision and came home as heroes; for two weeks the WUI station ran short-handed.', delta: { T: 2, P: -1 } };
        }),
        choice('Send water instead', 'Offer a water exchange and a tender, keep the firefighters home.', 0, function (state) {
          addBudget(state, 0.5); if (state.reservoir) state.reservoir.storageAF = Math.max(0, num(state.reservoir.storageAF, 0) - 400);
          return { text: 'A tender and a temporary water exchange helped without stripping the station. The neighbours paid for the water.', delta: { T: 1, W: -1, F: 1 } };
        }),
        choice('Decline', 'Your own fire danger is too high to spare anyone.', 0, function (state) {
          sched(state, 3, 'Mutual-aid memory', { type: 'custom', key: 'mutualAidDeclined', value: null, text: '' });
          return { text: 'You declined. The mobilization center noted it. Regional goodwill is a resource too.', delta: { T: -2 } };
        })
      ]
    },
    {
      id: 'dust_on_snow', title: 'Dust on the Snowpack', icon: '🟤', severity: 'info',
      text: 'A spring windstorm out of the Four Corners has painted the high snowfields rusty brown. Dark snow soaks up sunlight; melt will come weeks early and fast. Ditches are not ready and the reservoir is still drawn down; the early pulse could run past uncaught.',
      source: 'Why this happens in Colorado: dust from the Colorado Plateau darkens the snowpack and can advance melt by several weeks; the Colorado Dust-on-Snow program in Silverton has tracked the events for two decades.',
      when: function (state) { return season(state) === S.SPRING && num(climate(state).snowpackPct, 100) > 55; },
      weight: function () { return 0.9; }, once: false,
      choices: [
        choice('Fill the reservoir early', 'Shift the operating schedule; open ditches early and store the early pulse.', 0.1, function (state) {
          var r = state.reservoir; if (r) r.storageAF = Math.min(num(r.capacityAF, C.HYDRO.RESERVOIR_CAPACITY_AF), num(r.storageAF, 0) + 1200);
          return { text: 'Operators moved the fill schedule up three weeks and caught the early pulse: roughly 1,200 AF banked that would have spilled.', delta: { W: 2 } };
        }),
        choice('Keep the normal schedule', 'Forecasts are uncertain; stick to the operating plan.', 0, function (state) {
          sched(state, 1, 'Early melt outcome', { type: 'custom', key: 'earlyMeltLoss', value: null, text: '' });
          return { text: 'The plan stayed on the calendar. Whether the early melt is caught depends on how quickly operators notice it.', delta: {} };
        }),
        choice('Fund dust and melt monitoring', 'Pay for a snow-survey flight and stream sensors on the melt front.', 0.15, function (state) {
          flags(state).dustMonitoring = true; if (state.climate) state.climate.uncertainty = Math.min(num(state.climate.uncertainty, 0.15), 0.1);
          return { text: 'A survey flight and extra gages tracked the melt front day by day; operators adjusted as it came.', delta: { W: 1 } };
        })
      ]
    },
    {
      id: 'beetle_kill', title: 'Beetle Kill in the Timber', icon: '🪲', severity: 'warn',
      text: 'Hillsides in one forest sector have gone rust-red in a single summer: bark beetles have killed most of the mature pines. Within a few years the needles drop and the dead trunks fall, leaving a jackstraw of dry fuel where a fire would run hardest.',
      source: 'Why this happens in Colorado: mountain pine beetle killed about 3.4 million acres of forest in the 2000s, followed by spruce beetle, and the dead "gray phase" stands eventually fall and add heavy fuel.',
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
        choice('Salvage log and thin', 'Contract salvage logging to remove dead trees while they still have value.', 1.2, function (state, world) {
          var c = ctx(state, 'beetle_kill'); if (c.zoneId != null) adjustZoneFuel(world, c.zoneId, 0.7, 0);
          return { text: 'Salvage crews worked ' + (c.name || 'the sector') + ' through the winter; log trucks paid part of the bill and the fuel load fell.', delta: { P: 1, E: -1 } };
        }),
        choice('Leave it standing', 'Dead trees are woodpecker and elk habitat; let the forest sort itself out.', 0, function (state) {
          var c = ctx(state, 'beetle_kill');
          sched(state, 4, 'Gray-phase blowdown', { type: 'custom', key: 'beetleFuel', value: { zoneId: c.zoneId != null ? c.zoneId : null }, text: '' });
          return { text: 'The snags stay. Woodpeckers arrived within weeks; the fuel problem arrives in a few years.', delta: { E: 1 } };
        }),
        choice('Apply for a state forest-health grant', 'Colorado State Forest Service cost-share for treatment next year.', 0.1, function (state) {
          var c = ctx(state, 'beetle_kill');
          sched(state, 2, 'Forest-health grant award', { type: 'budget', key: 'budget', value: 0.8, text: 'The Colorado State Forest Service awarded $0.8M for beetle-kill treatment.' });
          return { text: 'A grant application went to the State Forest Service for ' + (c.name || 'the sector') + '. Money arrives next year, if it arrives.', delta: {} };
        })
      ]
    },
    {
      id: 'flash_drought', title: 'Flash Drought', icon: '☀️', severity: 'crisis',
      text: 'Six weeks without rain and afternoon highs in the upper 90s have crashed soil moisture from adequate to bone-dry. Pastures are brown, the second hay cutting is gone, and the Drought Monitor just jumped two categories. Demand is spiking as the supply forecast collapses.',
      source: 'Why this happens in Colorado: flash droughts in 2012 and 2020 crashed soil moisture in a matter of weeks and pushed most of the state into severe drought within a single summer.',
      when: function (state) { var c = climate(state); return season(state) === S.SUMMER && num(c.precipIn, 3) < 1.2 && num(c.tempAnomF, 0) > 1; },
      weight: function (state) { return 1.3 + droughtLevel(state) * 0.2; }, once: false,
      choices: [
        choice('Stage 2 restrictions', 'Ban outdoor watering, close car washes; sharp savings, sharp complaints.', 0, function (state) {
          setRestriction(state, 'stage2'); flags(state).droughtDeclared = true;
          return { text: 'Stage 2 restrictions took effect overnight. Lawns died, the car wash closed, and demand fell by a quarter.', delta: { W: 4, F: -2, T: -2 } };
        }),
        choice('Pay farms to fallow', 'Emergency fallowing payments keep irrigation water in the reservoir.', 0.8, function (state) {
          water(state).alloc.farms = Math.min(num(water(state).alloc.farms, 1), 0.7);
          return { text: 'Fallowing payments idled 800 acres. Ranchers took the money without much joy; the reservoir kept the water.', delta: { W: 2, F: -1, T: 1 } };
        }),
        choice('Ride it out', 'Monsoon rains could still arrive in August.', 0, function (state) {
          sched(state, 1, 'Drought aftermath', { type: 'outcome', key: 'E', value: -2, text: 'The flash drought left riparian willows dead and the creek warm into fall.' });
          return { text: 'You hoped for monsoon rain. It came late and light.', delta: { W: -3, F: -3 } };
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
    var text = 'A wildfire is running in ' + zname + (acres ? ' (' + acres.toLocaleString() + ' acres and growing)' : '') + ' with ' + Math.round(wind) + ' mph winds. ' +
      (upstream ? 'It is above the reservoir: every acre that burns there is ash and sediment in next year\'s water supply. ' : 'It is below the reservoir, closer to town than to the intake. ') +
      'The incident commander needs to know where to put the engines and crews. Houses, the watershed, and the hay meadows cannot all be first.';
    function respond(focus, budgetLevel, costM, note, delta) {
      return function (state) {
        var fr = fire(state);
        var pre = C.clamp(num(fr.preResponse, 0), -0.5, 0.5); // bonus/penalty banked by earlier cards (tankers, mutual aid)
        fr.crewFocus = focus;
        fr.responseBudget = C.clamp(budgetLevel + pre, 0.5, 1.5);
        fr.preResponse = 0;
        return { text: note + ' Response effort ' + Math.round(fr.responseBudget * 100) + '%.', delta: delta };
      };
    }
    var choices = [
      choice('Protect the town', 'Structure protection in the WUI neighborhoods; the forest burns.', 1.5, respond('town', 1.3, 1.5, 'Every engine went to the neighborhoods: sprinklers on roofs, dozer lines at the subdivision edge.', { P: 2 })),
      choice('Protect the watershed above the reservoir', 'Hold the fire out of the sectors that drain to the intake.', 1.2, respond('watershed', 1.2, 1.2, 'Hand crews and retardant went to the slopes above the reservoir to keep ash out of the water supply.', { W: 1, E: 1 })),
      choice('Protect the farms', 'Keep it off the valley floor: barns, hay and the irrigation headgates.', 0.8, respond('farms', 1.1, 0.8, 'Crews cut line along the ditches and wet down the barns; the valley floor held.', { F: 2 })),
      choice('Split the crews', 'A little of everything; nothing gets full strength.', 1.0, respond(null, 0.85, 1.0, 'Crews were split three ways. Coverage everywhere, decisive strength nowhere.', {}))
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
      } catch (err) { txt = txt || (s.label || 'A scheduled effect') + ' could not be applied.'; }
      if (!txt) txt = s.label || 'A scheduled consequence arrived.';
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
