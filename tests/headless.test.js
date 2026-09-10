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
    if (a.world && b.world) { let same = true; for (let i = 0; i < a.world.burn.length; i++) if (Math.abs(a.world.burn[i] - b.world.burn[i]) > 0.002) { same = false; break; } assert(same, 'world burn layer survived the round-trip'); }
    for (let i = 0; i < 3; i++) await b.runSeason();
    let e2 = null; try { noNaN(b.state, 'loaded'); } catch (e) { e2 = e; }
    assert(!e2 && b.state.turn === a.state.turn + 3 && b.state.timeline.length === b.state.turn, 'continued 3 seasons after load with no NaN');
    // the driver also exposes load(str)
    const c = WS.Game.createHeadless({ seed: 99, years: 4, decide: policy() }).load(blob);
    assert(c.state.seed === a.state.seed, 'driver.load(str) restores the saved seed');
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
  assert(dt < 90, 'whole run took ' + dt.toFixed(1) + ' s (< 90 s; v2 runs tactical + storm counterfactuals for 7 seeded games)');
  console.log('DONE: ' + (process.exitCode ? 'FAILURES' : 'all passed') + ' in ' + dt.toFixed(1) + 's; modules present: ' + Object.keys(HAS).filter(k => HAS[k]).join(', '));
})().catch(e => { console.error('FAIL: unhandled', e); process.exitCode = 1; });
