/* Hard word caps on every player-facing string (player feedback: "still wayyyy too text heavy"). Run: node tests/wordcaps.test.js
   A "word" is a whitespace token containing a letter or digit, so "→", "·", "—" and emoji icons do not count.
   Covers: every event card (+ every choice applied on a real state, + the fire-response card), every scheduled-effect handler,
   advisor recs for every topic on three states, every project definition + every fund() result, scoring reasons / highlights / lessons,
   case-study lessons + linkTo, and 8 headless seasons (× 3 seeds, plus one full game for crisis coverage) of timeline, after-action,
   toast, ticker, alert, log and tutorial text built by src/main.js. */
const fs = require('fs'), path = require('path');
const { load, assert, ROOT } = require('./load');

const FILES = ['src/world/terrain.js', 'src/sim/state.js', 'src/sim/projects.js', 'src/sim/hydrology.js', 'src/sim/fire.js', 'src/sim/flood.js',
  'src/sim/events.js', 'src/sim/advisors.js', 'src/sim/scoring.js', 'src/sim/casestudies.js', 'src/main.js'];
const missing = FILES.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) { console.error('FAIL: modules missing: ' + missing.join(', ')); process.exit(1); }
const { WS } = load(FILES);
const C = WS.C;

/* ---------------------------------------------------------------- caps */
const CAP = {
  card: { title: 6, text: 18, source: 14, label: 4, desc: 10, result: 14 },
  advisor: { headline: 6, text: 16, evidenceLabel: 3 },
  project: { name: 3, summary: 8, detail: 24, tradeoff: 10, fundText: 12 },
  scoring: { reason: 12, highlight: 10, highlights: 4, lesson: 12, lessons: 3 },
  cases: { lesson: 12, linkTo: 16 },
  main: { timelineEntry: 12, timelinePerSeason: 4, aaHeadline: 8, aaSummary: 14, aaAction: 6, aaLessons: 1, aaLesson: 12, toast: 10, ticker: 8, tutorial: 8, alert: 5, log: 14 }
};
const OWNED_LOG_FILES = /src\/(main|sim\/events|sim\/projects|sim\/scoring|sim\/casestudies|sim\/advisors)\.js/;

/* ---------------------------------------------------------------- helpers */
const wc = s => String(s == null ? '' : s).trim().split(/\s+/).filter(t => /[A-Za-z0-9]/.test(t)).length;
const sentences = s => (String(s || '').match(/[.!?](?=\s|$)/g) || []).length;
const clean = s => !/undefined|NaN|\[object|null/.test(String(s));
const violations = [];
const stats = {};
function check(group, what, text, cap) {
  const n = wc(text);
  (stats[group] = stats[group] || []).push(n);
  if (n > cap) violations.push(group + ' ' + what + ': ' + n + ' words > ' + cap + ' — "' + text + '"');
  if (!clean(text)) violations.push(group + ' ' + what + ': unclean text — "' + text + '"');
}
function checkGroup(label) {
  const bad = violations.splice(0, violations.length);
  bad.forEach(v => console.error('  ' + v));
  if (bad.length) { console.error('FAIL: ' + label + ' (' + bad.length + ' violations)'); process.exitCode = 1; } else console.log('PASS: ' + label);
}
const avg = a => a && a.length ? Math.round(10 * a.reduce((x, y) => x + y, 0) / a.length) / 10 : 0;

function freshState(seed) { const s = WS.State.create({ seed, years: 8, mode: 'simulated' }); s.budget = 40; return s; }
function stressedState(seed, world) {
  const s = freshState(seed);
  Object.assign(s.climate, { snowpackPct: 52, drought: 'D3', tempAnomF: 3.2, fireDanger: 0.8, fireDangerLabel: 'Very High', streamflowCfs: 9, windMph: 28, soilMoisturePct: 18, uncertainty: 0.3 });
  Object.assign(s.reservoir, { storageAF: 9000, turbidity: 0.55, ashContam: 0.45, algae: 0.6 });
  s.water.alloc.tribal = 0.5; s.water.alloc.downstream = 0.6; s.water.alloc.farms = 0.5; s.water.alloc.wildlife = 0.4; s.water.restriction = 'stage2';
  s.water.demands = { households: 3000, farms: 9000, tribal: 1500, downstream: 4000, wildlife: 600, fire: 600, hydro: 800, recreation: 300 };
  s.water.shortage = { households: 900, farms: 3600 }; s.water.delivered = { farms: 5400 };
  const forest = (world.zones || []).filter(z => z.type === 'forest'), nb = (world.zones || []).filter(z => z.type === 'neighborhood');
  s.fire.fires = [{ acres: 1200, structures: 25, year: 2, upstream: true, zoneIds: [forest[0] ? forest[0].id : 0, nb[0] ? nb[0].id : 0] }, { acres: 4800, structures: 30, year: 3, upstream: true, zoneIds: [] }];
  s.fire.totalAcres = 6000; s.fire.structuresLost = 55; s.fire.smokeDays = 9; s.fire.policy = 'suppress_all';
  s.stats = { floodDamageM: 4.2, sedimentTons: 3800, contaminationOutageDays: 6, cropLossPct: 20, hydroMWh: 300, recreationVisits: 12000 };
  s.flags = Object.assign(s.flags || {}, { legalOverrides: 2, droughtDeclared: true, musselEvent: true, wetlandRestored: true, insuranceRetreatReady: true });
  s.pendingStorm = { intensityIn: 2.4, durationHr: 1.5, turnsUntil: 1, source: 'event' };
  s.outcomes = { W: 41, E: 38, P: 45, F: 40, T: 33 };
  if (world.burn) for (let i = 0; i < world.burn.length; i += 3) world.burn[i] = 0.7;
  return s;
}

(async function main() {
  const world = WS.World.generate(7);
  const fresh = freshState(7);
  const stressed = stressedState(11, WS.World.generate(11));
  const stressedWorld = WS.World.generate(11); stressedState(11, stressedWorld);

  /* ---------------------------------------------------------------- event cards */
  const E = WS.Events;
  E.CARDS.forEach(card => {
    check('card.title', card.id, card.title, CAP.card.title);
    check('card.text', card.id, card.text, CAP.card.text);
    check('card.source', card.id, card.source, CAP.card.source);
    if (sentences(card.text) > 2) violations.push('card.text ' + card.id + ': more than one sentence — "' + card.text + '"');
    if (card.id !== 'fire_response' && !/\d/.test(card.text)) violations.push('card.text ' + card.id + ': no number — "' + card.text + '"');
    card.choices.forEach((ch, k) => {
      check('card.choice.label', card.id + '[' + k + ']', ch.label, CAP.card.label);
      check('card.choice.desc', card.id + '[' + k + ']', ch.desc, CAP.card.desc);
      [7, 11].forEach(seed => {
        const w = WS.World.generate(seed), s = freshState(seed);
        s.season = seed === 7 ? C.SEASON.SPRING : C.SEASON.SUMMER; s.turn = 6;
        if (typeof card.prepare === 'function') { try { card.prepare(s, w, WS.RNG.create(seed)); } catch (e) { /* defensive */ } }
        const r = ch.apply(s, w, WS.RNG.create(seed + k));
        check('card.result', card.id + '[' + k + '] seed ' + seed, r.text, CAP.card.result);
      });
    });
  });
  // the fire-response card is built at run time
  {
    const w = WS.World.generate(7), s = freshState(7);
    const forest = w.zones.filter(z => z.type === 'forest')[0];
    const fc = E.fireResponseCard(s, w, { startCell: forest.cells[0], acres: 320, zoneId: forest.id });
    check('card.title', 'fire_response(live)', fc.title, CAP.card.title);
    check('card.text', 'fire_response(live)', fc.text, CAP.card.text);
    fc.choices.forEach((ch, k) => {
      check('card.choice.label', 'fire_response[' + k + ']', ch.label, CAP.card.label);
      check('card.choice.desc', 'fire_response[' + k + ']', ch.desc, CAP.card.desc);
      const s2 = freshState(7); s2.fire.preResponse = 0.25;
      check('card.result', 'fire_response[' + k + ']', ch.apply(s2, w, WS.RNG.create(1)).text, CAP.card.result);
    });
  }
  // scheduled-effect handlers surface as toasts (≤ 10) and as "Earlier choice: …" timeline entries (≤ 12)
  Object.keys(E.HANDLERS).forEach(h => {
    [freshState(3), stressedState(5, WS.World.generate(5))].forEach((s, i) => {
      const w = WS.World.generate(i ? 5 : 3);
      const out = E.HANDLERS[h](s, w, { zoneId: w.zones[0].id, amountM: 2.5 });
      check('handler', h + (i ? ' (stressed)' : ''), out, CAP.main.toast);
    });
  });
  checkGroup('event cards: title ≤ 6, text ≤ 18, source ≤ 14, label ≤ 4, desc ≤ 10, result ≤ 14, handlers ≤ 10 words');

  /* ---------------------------------------------------------------- advisors */
  const A = WS.Advisors;
  [['fresh', fresh, world], ['stressed', stressed, stressedWorld], ['empty', {}, {}]].forEach(([label, s, w]) => {
    A.TOPICS.forEach(topic => {
      A.getRecommendations(s, w, topic).forEach(r => {
        const tag = label + ' ' + topic + ' ' + r.characterId;
        check('advisor.headline', tag, r.headline, CAP.advisor.headline);
        check('advisor.text', tag, r.text, CAP.advisor.text);
        check('advisor.evidence.label', tag, r.evidence.label, CAP.advisor.evidenceLabel);
        if (sentences(r.text) !== 1) violations.push('advisor.text ' + tag + ': not exactly one sentence — "' + r.text + '"');
        if (!/\d/.test(r.text)) violations.push('advisor.text ' + tag + ': no number — "' + r.text + '"');
        if (r.text.length < 40) violations.push('advisor.text ' + tag + ': shorter than the 40 chars tests/advisors_cases expects — "' + r.text + '"');
      });
    });
  });
  checkGroup('advisors: headline ≤ 6, text = one sentence ≤ 16 words with a number, evidence label ≤ 3');

  /* ---------------------------------------------------------------- projects */
  const P = WS.Projects;
  P.LIST.forEach(d => {
    check('project.name', d.id, d.name, CAP.project.name);
    check('project.summary', d.id, d.summary, CAP.project.summary);
    check('project.detail', d.id, d.detail, CAP.project.detail);
    check('project.tradeoff', d.id, d.tradeoff, CAP.project.tradeoff);
    const s = freshState(7); s.budget = 60; s.season = C.SEASON.SPRING;
    const w = WS.World.generate(7);
    let target = null;
    if (d.targetType !== 'global') { const z = w.zones.filter(z => z.type === d.targetType)[0]; target = z ? z.id : null; }
    for (let lvl = 1; lvl <= Math.min(2, d.maxLevel); lvl++) {
      if (d.id === 'prescribed_burn' && lvl > 1) break;
      if (target != null && lvl > 1) { const z2 = w.zones.filter(z => z.type === d.targetType)[1]; if (!z2) break; target = z2.id; }
      const r = P.fund(s, w, d.id, target, WS.RNG.create(lvl));
      if (!r.ok) { violations.push('project.fund ' + d.id + ' L' + lvl + ' refused: ' + r.text); break; }
      check('project.fundText', d.id + ' L' + lvl, r.text, CAP.project.fundText);
    }
  });
  checkGroup('projects: name ≤ 3, summary ≤ 8, detail ≤ 24, tradeoff ≤ 10, fund result ≤ 12 words');

  /* ---------------------------------------------------------------- scoring + case studies (fresh, stressed; the headless end state is checked below) */
  function checkScoringAndCases(label, s, w, extras) {
    const rep = s.lastSeasonReport || { shortagePct: { households: 0.1, farms: 0.3 }, minFlowMet: false, cropHealthAvg: 0.6, hydroMWh: 120, legalOverride: true };
    const u = WS.Scoring.updateOutcomes(s, w, rep, extras || {});
    u.reasons.forEach(r => check('scoring.reason', label + ' ' + r.key, r.text, CAP.scoring.reason));
    const f = WS.Scoring.finalSummary(s);
    if (f.highlights.length > CAP.scoring.highlights) violations.push('scoring.highlights ' + label + ': ' + f.highlights.length + ' items > ' + CAP.scoring.highlights);
    if (f.lessons.length > CAP.scoring.lessons) violations.push('scoring.lessons ' + label + ': ' + f.lessons.length + ' items > ' + CAP.scoring.lessons);
    f.highlights.forEach((h, i) => check('scoring.highlight', label + '[' + i + ']', h, CAP.scoring.highlight));
    f.lessons.forEach((h, i) => check('scoring.lesson', label + '[' + i + ']', h, CAP.scoring.lesson));
    WS.CaseStudies.LIST.forEach(cs => {
      check('case.lesson', cs.id, cs.lesson, CAP.cases.lesson);
      check('case.linkTo', label + ' ' + cs.id, WS.CaseStudies.linkTo(cs.id, s), CAP.cases.linkTo);
    });
  }
  checkScoringAndCases('fresh', freshState(7), world, {});
  checkScoringAndCases('stressed', stressed, stressedWorld, { flood: { floodedHouses: 6, damageM: 2.4, injuriesRisk: 0.5 }, fire: { acres: 2200, structuresLost: 4 } });
  checkGroup('scoring: reasons ≤ 12; highlights ≤ 10 words × ≤ 4; lessons ≤ 12 words × ≤ 3 — cases: lesson ≤ 12, linkTo ≤ 16');

  /* ---------------------------------------------------------------- main.js: headless seasons with a recording UI + log attribution */
  const logs = [];   // { text, file }
  const origLog = WS.State.log;
  WS.State.log = function (state, text, kind) {
    const frames = String(new Error().stack || '').split('\n').slice(1);
    let file = 'unknown';
    for (const fr of frames) { const m = fr.match(/src\/[\w/]+\.js/); if (m && !/state\.js$/.test(m[0]) && !/wordcaps/.test(fr)) { file = m[0]; break; } }
    logs.push({ text: String(text), file });
    return origLog.call(this, state, text, kind);
  };
  function policy() {
    const funded = {};
    return {
      card: () => 0,
      plan(game) {
        const s = game.state, w = game.world; if (!s) return;
        const forests = game.listZones('forest'), nbs = game.listZones('neighborhood');
        if (s.year === 1 && !funded.a) { funded.a = true; game.fundProject('forest_thinning', forests.length ? forests[0].id : 0); game.fundProject('streamgages'); game.fundProject('warning_system'); }
        if (s.year === 2 && !funded.b) { funded.b = true; game.fundProject('wetland', w && w.wetland ? w.wetland.zoneId : undefined); game.fundProject('home_hardening', nbs.length ? nbs[0].id : 0); game.fundProject('treatment'); }
        if ((s.season === C.SEASON.SPRING || s.season === C.SEASON.FALL) && forests.length > 1 && !funded['burn' + s.turn]) { funded['burn' + s.turn] = true; game.fundProject('prescribed_burn', forests[1].id); }
        game.setAllocation('farms', s.climate && s.climate.snowpackPct < 85 ? 0.7 : 1.0);
        if (s.year >= 2) game.setFirePolicy('suppress_all');
      },
      placements(prep, tools) {
        const out = [], basins = prep && prep.placeable && prep.placeable.debris_basin ? prep.placeable.debris_basin : [], mulch = prep && prep.placeable && prep.placeable.mulch ? prep.placeable.mulch : [];
        if (basins.length) { const p = C.xy(basins[0]); out.push({ type: 'debris_basin', x: p.x, y: p.y }); }
        for (let i = 0; i < mulch.length && i < 6; i += 2) { const p = C.xy(mulch[i]); out.push({ type: 'mulch', x: p.x, y: p.y }); }
        return out;
      },
      tactics(fireSim, threat, step) {
        if (step !== 3 || !fireSim || !isFinite(fireSim.startCell)) return [];
        const p = C.xy(fireSim.startCell), cells = [];
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { if (Math.max(Math.abs(dx), Math.abs(dy)) !== 3) continue; if (C.inBounds(p.x + dx, p.y + dy)) cells.push(C.idx(p.x + dx, p.y + dy)); }
        const nb = (threat && threat.threatened || []).filter(t => t.type === 'neighborhood')[0];
        return [{ type: 'dozer', target: cells }].concat(nb ? [{ type: 'evacuate', target: nb.zoneId }] : []);
      },
      liveTools(result, frame, info) {
        if (frame !== 2) return [];
        let cells = [];
        try { if (info && info.prep) cells = Array.from(WS.Flood.placeableLive(info.prep, info.world, 'sandbag')); } catch (e) { cells = []; }
        return cells.slice(0, 6).map(i => { const p = C.xy(i); return { type: 'sandbag', x: p.x, y: p.y }; });
      }
    };
  }
  const ui = { toasts: [], tickers: [], alerts: [] };
  const timelineCounts = [], afterActions = [];
  async function runGame(seed, years, seasons) {
    const dec = policy();
    const adapter = WS.Game.makeUI(false, dec);
    adapter.toast = t => { ui.toasts.push(String(t)); return Promise.resolve(); };
    adapter.ticker = t => { ui.tickers.push(String(t)); return Promise.resolve(); };
    adapter.alert = t => { ui.alerts.push(String(t)); return Promise.resolve(); };
    const g = WS.Game.create({ seed, years, mode: 'simulated', headless: true, decide: dec, ui: adapter });
    let n = 0;
    while (!g.isEnded() && n < seasons) {
      const r = await g.runSeason(); n++;
      if (!r) break;
      timelineCounts.push(r.timeline.length);
      r.timeline.forEach((e, i) => { check('timeline', 'seed ' + seed + ' turn ' + r.turn + '[' + i + ']', e.text, CAP.main.timelineEntry); if (String(e.text).length <= 10) violations.push('timeline seed ' + seed + ' turn ' + r.turn + ': entry shorter than 11 chars — "' + e.text + '"'); });
      (r.afterActions || []).forEach(aa => afterActions.push({ seed, turn: r.turn, aa }));
    }
    return g;
  }
  let endGame = null;
  for (let seed = 1; seed <= 3; seed++) endGame = await runGame(seed, 2, 8);
  // one full game for crisis coverage (fires, storms, after-action reports)
  const full = await runGame(4, 8, 32);
  const fullStats = full.getStats();
  assert(timelineCounts.every(n => n >= 1 && n <= CAP.main.timelinePerSeason), 'timeline: 1–4 entries every season (max seen ' + Math.max.apply(null, timelineCounts) + ', ' + timelineCounts.length + ' seasons)');
  assert(fullStats.fires >= 1 && fullStats.storms >= 1, 'coverage: the full game had ≥ 1 fire and ≥ 1 storm (fires=' + fullStats.fires + ', storms=' + fullStats.storms + ')');
  assert(afterActions.length >= 1, 'coverage: at least one after-action report was built (' + afterActions.length + ')');
  afterActions.forEach(({ seed, turn, aa }) => {
    const tag = aa.mode + ' seed ' + seed + ' turn ' + turn;
    check('afterAction.headline', tag, aa.headline, CAP.main.aaHeadline);
    check('afterAction.summary', tag, aa.counterfactual && aa.counterfactual.summary, CAP.main.aaSummary);
    if (typeof aa.summary !== 'string') violations.push('afterAction ' + tag + ': summary missing (tests/headless expects a string)');
    (aa.actions || []).forEach((a, i) => check('afterAction.action', tag + '[' + i + ']', a, CAP.main.aaAction));
    if ((aa.lessons || []).length > CAP.main.aaLessons) violations.push('afterAction.lessons ' + tag + ': ' + aa.lessons.length + ' items > ' + CAP.main.aaLessons);
    (aa.lessons || []).forEach((l, i) => check('afterAction.lesson', tag + '[' + i + ']', l, CAP.main.aaLesson));
  });
  ui.toasts.forEach((t, i) => check('toast', '#' + i, t, CAP.main.toast));
  ui.tickers.forEach((t, i) => { check('ticker', '#' + i, t, CAP.main.ticker); if (!/\d/.test(t) && !/Paused|Resumed|burn|Evacuating|Engine/i.test(t)) violations.push('ticker #' + i + ': no number — "' + t + '"'); });
  ui.alerts.forEach((t, i) => check('alert', '#' + i, t, CAP.main.alert));
  WS.Game.TUTORIAL_STEPS.forEach((st, i) => check('tutorial', 'step ' + i, st[0].replace('{budget}', '$8.5M'), CAP.main.tutorial));
  const owned = logs.filter(l => OWNED_LOG_FILES.test(l.file)), foreign = logs.filter(l => !OWNED_LOG_FILES.test(l.file));
  owned.forEach((l, i) => check('log', l.file + ' #' + i, l.text, CAP.main.log));
  const foreignLong = foreign.filter(l => wc(l.text) > CAP.main.log);
  console.log('  (info) ' + foreign.length + ' log lines came from modules outside this cap (hydrology/flood/fire); ' + foreignLong.length + ' of those exceed 14 words');
  WS.State.log = origLog;
  // the headless end state also feeds scoring + case studies
  checkScoringAndCases('headless-end', full.state, full.world, {});
  assert(ui.toasts.length + ui.tickers.length + ui.alerts.length > 20 && owned.length > 20, 'coverage: recorded ' + ui.toasts.length + ' toasts, ' + ui.tickers.length + ' tickers, ' + ui.alerts.length + ' alerts, ' + owned.length + ' owned log lines');
  checkGroup('main.js: timeline ≤ 12 words × ≤ 4; after-action headline ≤ 8, summary ≤ 14, actions ≤ 6, ≤ 1 lesson ≤ 12; toasts ≤ 10; tickers ≤ 8 (numeric); alerts ≤ 5; tutorial ≤ 8; log ≤ 14');

  /* ---------------------------------------------------------------- averages (for the record) */
  const report = {};
  Object.keys(stats).forEach(k => { report[k] = { n: stats[k].length, avg: avg(stats[k]), max: Math.max.apply(null, stats[k]) }; });
  console.log('word counts: ' + JSON.stringify(report));
  console.log(process.exitCode ? 'SOME FAILURES' : 'ALL PASS');
})().catch(e => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
