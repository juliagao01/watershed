/* Headless full-game test (§13): drives WS.Game.createHeadless for seeds 1..6 × 8 years with a simple policy.
   Assertions depending on a module that has not landed yet print SKIP; everything else is strict. */
const fs = require('fs'), path = require('path');
const { load, assert, noNaN, ROOT } = require('./load');

const WANT = ['src/world/terrain.js', 'src/sim/state.js', 'src/sim/projects.js', 'src/sim/hydrology.js', 'src/sim/fire.js', 'src/sim/flood.js',
  'src/sim/events.js', 'src/sim/advisors.js', 'src/sim/scoring.js', 'src/sim/casestudies.js', 'src/main.js'];
const present = WANT.filter(f => fs.existsSync(path.join(ROOT, f)));
const missing = WANT.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) console.log('SKIP: modules not present yet: ' + missing.join(', '));
const { WS } = load(present);
const C = WS.C;
const HAS = { World: !!WS.World, State: !!WS.State, Hydrology: !!WS.Hydrology, Fire: !!WS.Fire, Flood: !!WS.Flood, Events: !!WS.Events, Scoring: !!WS.Scoring, Projects: !!WS.Projects };
function skip(what, needs) { console.log('SKIP: ' + what + ' (needs ' + needs + ')'); }

assert(WS.Game && typeof WS.Game.createHeadless === 'function', 'WS.Game.createHeadless exists');

function policy(log) {
  const funded = {};
  return {
    card(card) {
      // choose the first affordable choice
      const ch = card.choices || [];
      for (let i = 0; i < ch.length; i++) if (!(ch[i].costM > 0)) return i;
      return 0;
    },
    plan(game) {
      const s = game.state, w = game.world;
      if (!s) return;
      const forests = game.listZones('forest');
      const sector1 = forests.length ? forests[0].id : 0;
      if (s.year === 1 && !funded.thin) { funded.thin = true; game.fundProject('forest_thinning', sector1); game.fundProject('streamgages'); }
      if (s.year === 2 && !funded.wet) { funded.wet = true; game.fundProject('wetland', w && w.wetland ? w.wetland.zoneId : undefined); }
      const dry = s.climate && s.climate.snowpackPct < 85;
      game.setAllocation('farms', dry ? 0.8 : 1.0);
    },
    placements(prep, tools, budget) {
      const out = [];
      let left = budget;
      const tool = t => tools.find(x => x.type === t) || { costM: 0.3, free: 0 };
      const basins = prep && prep.placeable && prep.placeable.debris_basin ? prep.placeable.debris_basin : [];
      for (let i = 0; i < basins.length && i < 2; i++) { const c = tool('debris_basin').costM; if (left >= c) { const p = C.xy(basins[i]); out.push({ type: 'debris_basin', x: p.x, y: p.y }); left -= c; } }
      const mulch = prep && prep.placeable && prep.placeable.mulch ? prep.placeable.mulch : [];
      let free = tool('mulch').free || 0;
      for (let i = 0; i < mulch.length; i += 3) { const c = free > 0 ? 0 : tool('mulch').costM; if (c > left) break; const p = C.xy(mulch[i]); out.push({ type: 'mulch', x: p.x, y: p.y }); left -= c; if (free > 0) free--; }
      return out;
    }
  };
}

(async function main() {
  const t0 = Date.now();
  let fires = 0, floods = 0, storms = 0;
  const YEARS = 8;
  for (let seed = 1; seed <= 6; seed++) {
    const drv = WS.Game.createHeadless({ seed, years: YEARS, mode: 'simulated', decide: policy() });
    assert(drv.state && typeof drv.runSeason === 'function' && typeof drv.runAll === 'function', 'seed ' + seed + ': driver created');
    const reports = await drv.runAll();
    const s = drv.state;
    assert(drv.isEnded() && s.turn === YEARS * 4, 'seed ' + seed + ': game ran ' + YEARS * 4 + ' turns and ended');
    assert(reports.length === YEARS * 4 && reports.every(r => r && r.timeline), 'seed ' + seed + ': a report with a timeline for every season');
    let nanErr = null; try { noNaN(s, 'state'); } catch (e) { nanErr = e; }
    assert(!nanErr, 'seed ' + seed + ': no NaN/Inf anywhere in state' + (nanErr ? ' — ' + nanErr.message : ''));
    if (drv.world) { let wErr = null; try { noNaN({ elev: drv.world.elev, burn: drv.world.burn, fuel: drv.world.fuel, moisture: drv.world.moisture, cropHealth: drv.world.cropHealth }, 'world'); } catch (e) { wErr = e; } assert(!wErr, 'seed ' + seed + ': no NaN in world layers'); }
    const cap = s.reservoir.capacityAF || C.HYDRO.RESERVOIR_CAPACITY_AF;
    if (HAS.Hydrology) assert(s.reservoir.storageAF >= 0 && s.reservoir.storageAF <= cap * 1.15, 'seed ' + seed + ': storage ' + Math.round(s.reservoir.storageAF) + ' within [0, capacity×1.15]');
    else skip('storage bounds', 'Hydrology');
    assert(C.OUTCOME_KEYS.every(k => s.outcomes[k] >= 0 && s.outcomes[k] <= 100), 'seed ' + seed + ': outcomes within 0..100');
    assert(s.resilience >= 0 && s.resilience <= 100, 'seed ' + seed + ': resilience ' + s.resilience.toFixed(1) + ' within 0..100');
    assert(s.timeline.length === YEARS * 4 && s.timeline.every(t => t.entries && t.entries.length >= 1 && t.entries.every(e => typeof e.text === 'string' && e.text.length > 10)), 'seed ' + seed + ': timeline non-empty every turn');
    assert(s.history.length >= YEARS * 4 || !HAS.State, 'seed ' + seed + ': history snapshot every turn' + (HAS.State ? '' : ' (fallback state)'));
    const qz = s.quiz || {};
    assert(qz.total === YEARS * 4 && Array.isArray(qz.asked) && qz.asked.length === qz.total, 'seed ' + seed + ': one field-quiz question every season (' + qz.total + ')');
    const bank = WS.CaseStudies.LIST.reduce((n, cs) => n + ((cs.quiz || []).length), 0);
    assert(new Set(qz.asked.slice(0, bank)).size === Math.min(bank, qz.asked.length) && qz.asked.every(id => WS.CaseStudies.byId(id.split(':')[0])), 'seed ' + seed + ': no question repeated before the ' + bank + '-question bank was used up');
    assert(isFinite(qz.correct) && qz.correct === qz.total && qz.best === qz.total && qz.streak === qz.total, 'seed ' + seed + ': default headless answers are right (' + qz.correct + '/' + qz.total + ', streak ' + qz.streak + ')');
    assert(s.timeline.every(t => t.entries.some(e => /^Quiz: (correct|missed) — /.test(e.text))), 'seed ' + seed + ': every season\'s timeline carries a quiz line');
    const st = drv.stats();
    fires += st.fires; floods += st.floods; storms += st.storms;
    console.log('  seed ' + seed + ': R=' + s.resilience.toFixed(1) + ' fires=' + st.fires + ' storms=' + st.storms + ' floods=' + st.floods + ' cards=' + st.cards + ' burnedAcres=' + Math.round(s.fire.totalAcres) + ' budget=' + s.budget.toFixed(1));
  }
  if (HAS.World && HAS.Fire && HAS.Hydrology) assert(fires >= 1, 'at least one wildfire across seeds 1..6 (' + fires + ')'); else skip('≥1 fire', 'World+Fire+Hydrology');
  if (HAS.World && HAS.Fire && HAS.Flood && HAS.Hydrology) assert(floods >= 1, 'flood pipeline ran at least once across seeds (' + floods + ')'); else skip('flood pipeline ran', 'World+Fire+Flood+Hydrology');

  // serialize → deserialize → continue
  {
    const a = WS.Game.createHeadless({ seed: 3, years: 4, decide: policy() });
    for (let i = 0; i < 5; i++) await a.runSeason();
    const blob = a.save();
    assert(typeof blob === 'string' && blob.length > 100, 'serialize produced a string (' + blob.length + ' chars)');
    const b = WS.Game.createHeadless({ seed: 3, years: 4, decide: policy(), save: blob });
    assert(b.state.turn === a.state.turn && b.state.year === a.state.year, 'deserialize restored turn/year (' + b.state.turn + ')');
    if (HAS.State) assert(Math.abs(b.state.reservoir.storageAF - a.state.reservoir.storageAF) < 1e-6 && JSON.stringify(b.state.outcomes) === JSON.stringify(a.state.outcomes), 'deserialize restored storage/outcomes');
    else skip('deserialize fidelity', 'State');
    assert(JSON.stringify(b.state.quiz) === JSON.stringify(a.state.quiz) && b.state.quiz.total === 5, 'deserialize restored the quiz record (' + b.state.quiz.total + ' asked)');
    if (a.world && b.world) { let same = true; for (let i = 0; i < a.world.burn.length; i++) if (Math.abs(a.world.burn[i] - b.world.burn[i]) > 0.002) { same = false; break; } assert(same, 'world burn layer survived the round-trip'); }
    for (let i = 0; i < 3; i++) await b.runSeason();
    let e2 = null; try { noNaN(b.state, 'loaded'); } catch (e) { e2 = e; }
    assert(!e2 && b.state.turn === a.state.turn + 3 && b.state.timeline.length === b.state.turn, 'continued 3 seasons after load with no NaN');
    // the driver also exposes load(str)
    const c = WS.Game.createHeadless({ seed: 99, years: 4, decide: policy() }).load(blob);
    assert(c.state.seed === a.state.seed, 'driver.load(str) restores the saved seed');
  }

  // field quiz: decide.quiz answers, the score in state / finalSummary, and pickQuiz's no-repeat rule
  {
    let seen = 0;
    const dec = policy(); dec.quiz = q => { seen++; return (q.answer + 1) % q.options.length; };   // always wrong
    const w = WS.Game.createHeadless({ seed: 5, years: 2, decide: dec });
    await w.runAll();
    const qz = w.state.quiz;
    assert(seen === 8 && qz.total === 8 && qz.correct === 0 && qz.streak === 0 && qz.best === 0, 'decide.quiz(q) chooses the option: 8 asked, 0 correct when always wrong');
    const fs2 = WS.Scoring.finalSummary(w.state);
    assert(fs2.quiz && fs2.quiz.total === 8 && fs2.highlights.some(h => /^Field quiz: 0 of 8 correct/.test(h)), 'finalSummary carries the quiz score and a "Field quiz: 0 of 8 correct." highlight');
    assert(w.state.log.filter(l => /^Quiz missed: /.test(l.text)).length === 8, 'a "Quiz missed" log line per season');
    const dec2 = policy(); dec2.quiz = q => q.answer;
    const v = WS.Game.createHeadless({ seed: 5, years: 1, decide: dec2 });
    await v.runSeason(); const t1 = v.state.trustDelta; await v.runSeason();
    assert(v.state.quiz.correct === 2 && v.state.log.some(l => /^Quiz correct: /.test(l.text)) && t1 === 0.5, 'a correct answer logs "Quiz correct" and queues +0.5 trust for next season');
    // pickQuiz: 30 draws on one state never repeat a question id until all are used
    const st0 = WS.State.create({ seed: 1, years: 4 }), ids = [];
    const bank = WS.CaseStudies.LIST.reduce((n, cs) => n + cs.quiz.length, 0);
    for (let i = 0; i < 30; i++) { const p = WS.CaseStudies.pickQuiz(st0, WS.RNG.create(i)); if (!p) break; ids.push(p.id); st0.quiz.asked.push(p.id); }
    assert(ids.length === 30 && new Set(ids.slice(0, bank)).size === bank && ids.slice(0, bank).every(id => st0.quiz.asked.indexOf(id) >= 0), 'pickQuiz: 30 draws, the first ' + bank + ' are all distinct, then it starts over');
    assert(ids.every(id => { const p = WS.CaseStudies.byId(id.split(':')[0]); return p && p.quiz[+id.split(':')[1]]; }), 'pickQuiz ids resolve to bank questions');
    // preference: a case unlocked this season comes first, then any unlocked case
    const st1 = WS.State.create({ seed: 1, years: 4 }); st1.unlockedCases = ['mussels', 'hayman']; st1.quiz.lastUnlocked = ['hayman'];
    assert(WS.CaseStudies.pickQuiz(st1, WS.RNG.create(1)).caseId === 'hayman', 'pickQuiz prefers a case unlocked this season');
    st1.quiz.asked = ['hayman:0', 'hayman:1'];
    assert(WS.CaseStudies.pickQuiz(st1, WS.RNG.create(1)).caseId === 'mussels', 'then falls back to another unlocked case once that one is used up');
    assert(WS.CaseStudies.pickQuiz({}, null) && WS.CaseStudies.pickQuiz(null, null), 'pickQuiz tolerates an empty state and no rng');
  }

  // historical mode
  {
    const h = WS.Game.createHeadless({ seed: 7, years: 4, mode: 'historical', decide: policy() });
    await h.runAll();
    let e3 = null; try { noNaN(h.state, 'historical'); } catch (e) { e3 = e; }
    assert(!e3 && h.isEnded() && h.state.mode === 'historical', 'historical mode runs 4 years without NaN');
    if (!HAS.Hydrology) skip('historical snowpack series', 'Hydrology');
  }

  /* ---------------------------------------------------------------- SPEC2 §E: real-time crises through the headless hooks */
  const HAS2 = {
    tactics: !!(WS.Fire && typeof WS.Fire.startTactics === 'function' && typeof WS.Fire.applyTactic === 'function'),
    live: !!(WS.Flood && typeof WS.Flood.simulate === 'function' && WS.Flood.TOOLS && WS.Flood.TOOLS.sandbag && WS.Flood.TOOLS.sandbag.live)
  };
  // facade additions never depend on the sim modules
  {
    const g = WS.Game.createHeadless({ seed: 2, years: 4, decide: policy() });
    const v = g.game.setAllocation('power_rec', 0.6);
    assert(v === 0.6 && g.state.water.alloc.hydro === 0.6 && g.state.water.alloc.recreation === 0.6, "setAllocation('power_rec') sets both hydro and recreation");
    const core = g.game.getCoreProjects();
    assert(Array.isArray(core) && core.length === 8 && core.indexOf('forest_thinning') >= 0 && core.indexOf('warning_system') >= 0, 'getCoreProjects returns the 8 core ids');
    assert(g.game.getCrisis() === null && g.game.isPaused() === false && g.game.selectTactic('dozer') === null, 'no crisis outside a fire/storm: selectTactic/getCrisis/isPaused are inert');
  }

  /* ---------------------------------------------------------------- SPEC3 §C: player avatar — state, intro hook, saves, facade */
  {
    const g0 = WS.Game.createHeadless({ seed: 2, years: 4, decide: policy() });
    const p0 = g0.state.player;
    assert(p0 && typeof p0.name === 'string' && p0.name.length > 0 && p0.face && typeof p0.face === 'object' && typeof p0.face.skin === 'string' && typeof p0.face.hair === 'string' && p0.title === 'Water-Resilience Director', 'state.player exists with name/face/title after createHeadless (' + p0.name + ')');
    // decide.intro stands in for the browser intro creator: its { player } lands in state, normalised
    const dec = policy();
    dec.intro = () => ({ player: { name: '  Dr. Ada   Lovelace-of-the-Watershed-County  ', face: { skin: 's5', hair: 'braids', hat: 'hardhat', accessory: 'radio' } } });
    const g1 = WS.Game.createHeadless({ seed: 2, years: 4, decide: dec });
    const n1 = g1.state.player.name;
    assert(n1.indexOf('Dr. Ada Lovelace') === 0 && n1.length <= 24 && n1 === n1.trim() && n1.indexOf('  ') < 0, 'decide.intro player name is trimmed, whitespace-collapsed and capped at 24 chars ("' + n1 + '")');
    assert(g1.state.player.face.skin === 's5' && g1.state.player.face.hair === 'braids' && g1.state.player.face.hat === 'hardhat' && g1.state.player.face.accessory === 'radio' && typeof g1.state.player.face.eyes === 'string' && typeof g1.state.player.face.outfit === 'string', 'decide.intro face spec kept, missing parts filled from the default spec');
    await g1.runSeason(); await g1.runSeason();
    assert(g1.state.player.name === n1 && g1.state.player.face.hat === 'hardhat', 'player unchanged after two seasons of play');
    const blob = g1.save();
    const g2 = WS.Game.createHeadless({ seed: 2, years: 4, decide: policy(), save: blob });
    assert(JSON.stringify(g2.state.player) === JSON.stringify(g1.state.player), 'player survives serialize → deserialize');
    const p3 = g2.game.setPlayer({ hat: 'widebrim', glasses: 'sun' }, 'Walt Jr.');
    assert(p3 && p3.name === 'Walt Jr.' && p3.face.hat === 'widebrim' && p3.face.glasses === 'sun' && p3.face.skin === 's5' && g2.state.player.name === 'Walt Jr.', 'game.setPlayer(spec, name) updates state (spec merged over the current face)');
    assert(g2.game.setPlayer(null, '   ').name === 'Director Rivera' && g2.state.player.face.hat === 'widebrim', 'blank name falls back to the default; omitted spec keeps the face');
    assert(g2.game.getPlayer().face.hat === 'widebrim' && g2.game.focusPlayer() === undefined && g2.game.getPlayerPosition() === null, 'getPlayer / focusPlayer / getPlayerPosition are inert headless');
    await g2.runSeason();
    const blob2 = g2.save();
    assert(WS.Game.createHeadless({ seed: 9, years: 4, decide: policy() }).load(blob2).state.player.face.hat === 'widebrim', 'edited player carried by a later save/load');
    // a pre-SPEC3 save (no player) gets the default player
    const old = JSON.parse(blob), st = JSON.parse(old.state); delete st.player; old.state = JSON.stringify(st);
    const g4 = WS.Game.createHeadless({ seed: 2, years: 4, decide: policy(), save: JSON.stringify(old) });
    assert(g4.state.player && g4.state.player.name === 'Director Rivera' && typeof g4.state.player.face.skin === 'string' && g4.state.player.title === 'Water-Resilience Director', 'a save without player gets the default player');
    // the headless renderer adapter carries the SPEC3 facade as no-ops
    const r = g4.game.renderer;
    assert(['setPlayer', 'movePlayerTo', 'playerScreenPos', 'flyToPlayer', 'setPlayerAction', 'getPlayerPosition'].every(f => typeof r[f] === 'function') && r.movePlayerTo(1, 1, {}) === undefined, 'renderer adapter exposes the player facade (no-ops headless)');
  }
  if (HAS2.tactics && HAS.World && HAS.Hydrology) {
    // decide.tactics: at step 3 cut a dozer ring at Chebyshev radius 3 around the ignition cell
    let calls = 0, ringCells = 0, fireReport = null, fireSeed = null;
    const dec = policy();
    dec.tactics = (fireSim, threat, step) => {
      calls++;
      if (step !== 3 || !fireSim || !isFinite(fireSim.startCell)) return [];
      const p = C.xy(fireSim.startCell), cells = [];
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 3) continue;
        if (C.inBounds(p.x + dx, p.y + dy)) cells.push(C.idx(p.x + dx, p.y + dy));
      }
      ringCells = cells.length;
      return [{ type: 'dozer', target: cells }];
    };
    for (let seed = 1; seed <= 12 && !fireReport; seed++) {
      const d = WS.Game.createHeadless({ seed, years: 6, mode: 'simulated', decide: dec });
      while (!d.isEnded()) { const r = await d.runSeason(); if (r && r.fire) { fireReport = r.fire; fireSeed = seed; break; } }
    }
    assert(fireReport, 'tactical fire: a wildfire occurred under decide.tactics (seed ' + fireSeed + ')');
    assert(calls > 0 && ringCells >= 20, 'decide.tactics was consulted each step and built a ring (' + ringCells + ' cells)');
    const t = fireReport.tactics;
    assert(t && typeof t === 'object', 'report.tactics present on the fire report');
    assert(isFinite(t.acresSaved) && t.acresSaved >= 0, 'report.tactics.acresSaved finite and ≥ 0 (' + t.acresSaved + ')');
    assert(t.counterfactual && isFinite(t.counterfactual.acres) && t.counterfactual.acres >= fireReport.acres - 1e-6, 'counterfactual acres finite and ≥ actual (' + Math.round(t.counterfactual.acres) + ' vs ' + Math.round(fireReport.acres) + ')');
    assert(isFinite(t.cellsBroken) && t.cellsBroken > 0, 'the dozer ring was accepted (cellsBroken=' + t.cellsBroken + ')');
    assert(fireReport.afterAction && fireReport.afterAction.mode === 'fire' && Array.isArray(fireReport.afterAction.actions) && fireReport.afterAction.counterfactual && typeof fireReport.afterAction.summary === 'string', 'fire after-action report built (mode/actions/counterfactual/summary)');
  } else skip('tactical fire run (decide.tactics)', 'Fire.startTactics/applyTactic + World + Hydrology');
  if (HAS2.live && HAS.World && HAS.Fire && HAS.Hydrology) {
    // decide.liveTools: at frame 2 lay sandbags on up to 6 placeable cells; expect result.tactics with a counterfactual
    let liveCalls = 0, stormReport = null, stormSeed = null, wanted = 0;
    const dec2 = policy();
    dec2.liveTools = (result, frame, info) => {
      liveCalls++;
      if (frame !== 2) return [];
      let cells = [];
      try { if (typeof WS.Flood.placeableLive === 'function' && info && info.prep) cells = Array.from(WS.Flood.placeableLive(info.prep, info.world, 'sandbag')); } catch (e) { cells = []; }
      if (!cells.length && result && result.floodedCells) cells = Array.from(result.floodedCells);
      const out = cells.slice(0, 6).map(i => { const p = C.xy(i); return { type: 'sandbag', x: p.x, y: p.y }; });
      wanted += out.length;
      return out;
    };
    for (let seed = 1; seed <= 12 && !stormReport; seed++) {
      const d = WS.Game.createHeadless({ seed, years: 8, mode: 'simulated', decide: dec2 });
      while (!d.isEnded()) { const r = await d.runSeason(); if (r && r.flood) { stormReport = r; stormSeed = seed; break; } }
    }
    assert(stormReport, 'storm run: a burn-scar storm occurred under decide.liveTools (seed ' + stormSeed + ')');
    assert(liveCalls > 0, 'decide.liveTools was consulted per frame (' + liveCalls + ' calls)');
    const res = stormReport.flood, st = res.tactics;
    assert(st && typeof st === 'object' && st.counterfactual && isFinite(st.counterfactual.damageM), 'result.tactics present with a finite counterfactual damageM');
    const placed = (stormReport.liveMitigations || []).filter(m => m.type === 'sandbag');
    assert(placed.every(m => m.atFrame === 2), 'live sandbags carry atFrame = 2 (' + placed.length + ' placed of ' + wanted + ' requested)');
    if (placed.length) assert(isFinite(st.sandbagCells) && st.sandbagCells >= 1 && isFinite(st.damageSaved) && st.damageSaved >= 0, 'result.tactics counts the sandbag cells (' + st.sandbagCells + ') with damageSaved ≥ 0');
    else skip('sandbag effectiveness', 'a placeable sandbag site at frame 2 on seed ' + stormSeed);
    const saa = stormReport.flood.afterAction;
    assert(saa && saa.mode === 'storm' && Array.isArray(saa.actions) && saa.counterfactual && typeof saa.summary === 'string', 'storm after-action report built (mode/actions/counterfactual/summary)');
    assert(stormReport.afterAction === saa && Array.isArray(stormReport.afterActions) && stormReport.afterActions.indexOf(saa) >= 0, "season report carries the storm's after-action as the latest crisis (afterAction + afterActions)");
    let e4 = null; try { noNaN(stormReport.flood.tactics, 'flood.tactics'); } catch (e) { e4 = e; }
    assert(!e4, 'no NaN in flood tactics');
  } else skip('storm run (decide.liveTools)', 'Flood live tools + World + Fire + Hydrology');

  const dt = (Date.now() - t0) / 1000;
  if (dt < 90) console.log('PASS: whole run took ' + dt.toFixed(1) + ' s (< 90 s)'); else console.log('WARN: whole run took ' + dt.toFixed(1) + ' s (> 90 s — timing depends on machine load; not a failure)');
  console.log('DONE: ' + (process.exitCode ? 'FAILURES' : 'all passed') + ' in ' + dt.toFixed(1) + 's; modules present: ' + Object.keys(HAS).filter(k => HAS[k]).join(', '));
})().catch(e => { console.error('FAIL: unhandled', e); process.exitCode = 1; });
