/* Watershed — UI: Actions-panel tabs (Projects / Water / Fire), all modals, flood-prep toolbar, coach marks.
   Adds to WS.UI (hud.js must load first). Reads game.state fresh on every call. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var UI = WS.UI = WS.UI || {};
  var C = WS.C || {};
  var SEASONS = C.SEASONS || ['Winter', 'Spring', 'Summer', 'Fall'];
  var SECTORS = C.SECTORS || ['households', 'farms', 'fire', 'hydro', 'recreation', 'tribal', 'wildlife', 'downstream'];
  var SECTOR_NAMES = C.SECTOR_NAMES || {};
  var OUT_KEYS = C.OUTCOME_KEYS || ['W', 'E', 'P', 'F', 'T'];
  var OUT_NAMES = C.OUTCOME_NAMES || {};
  var OUT_WEIGHTS = C.OUTCOME_WEIGHTS || { W: 0.25, E: 0.2, P: 0.2, F: 0.2, T: 0.15 };
  var PH = C.PHASES || { PLAN: 'plan', FLOOD_PREP: 'flood_prep' };
  var SENIOR = { tribal: true, downstream: true };
  var NONCONS = { hydro: true, recreation: true, wildlife: true };
  var CATEGORY_NAMES = { monitor: 'Monitoring', water: 'Water', fire: 'Wildfire', flood: 'Flood', community: 'Community' };
  var CATEGORY_ICONS = { monitor: 'gauge', water: 'drop', fire: 'fire', flood: 'wave', community: 'houses' };
  function icon(name, size, cls) { return UI.icon(name, size, cls); }
  var CATEGORY_ORDER = ['monitor', 'water', 'fire', 'flood', 'community'];

  function h() { return UI.h.apply(null, arguments); }
  function hs() { return UI.hs.apply(null, arguments); }
  function clear(el) { return UI.clear(el); }
  function fin(v, d) { return UI.fmt.fin(v, d); }
  function num(v, d) { return UI.fmt.num(v, d); }
  function money(v) { return UI.fmt.money(v); }
  function af(v) { return UI.fmt.af(v); }
  function clamp(v, a, b) { return UI.fmt.clamp(v, a, b); }
  function signed(v, d) { return UI.fmt.signed(v, d); }
  function seasonName(i) { return UI.fmt.seasonName(i); }
  function st() { return (UI.game && UI.game.state) || {}; }
  function wd() { return (UI.game && UI.game.world) || {}; }
  function call(fn, args, then) { return UI.callGame(fn, args, then); }
  function sectorName(s) { return SECTOR_NAMES[s] || s; }
  function deltaNode(v, d, suffix) {
    v = fin(v);
    var cls = v > 0.05 ? 'up' : (v < -0.05 ? 'down' : 'flat');
    var arrow = v > 0.05 ? '▲' : (v < -0.05 ? '▼' : '•');
    return h('span', { class: 'delta ' + cls }, arrow + ' ' + num(Math.abs(v), d == null ? 0 : d) + (suffix || ''));
  }
  function safeList(x) { return Array.isArray(x) ? x : (x ? [x] : []); }
  function zoneList(type) {
    var out = null;
    try { if (UI.game && typeof UI.game.listZones === 'function') out = UI.game.listZones(type); } catch (e) { out = null; }
    if (!Array.isArray(out)) {
      var w = wd();
      try { if (typeof w.zonesOf === 'function') out = w.zonesOf(type); } catch (e) { out = null; }
      if (!Array.isArray(out)) out = (w.zones || []).filter(function (z) { return z && z.type === type; });
    }
    return out || [];
  }

  /* ================================================================== PROJECTS */
  var CORE_PROJECTS = ['streamgages', 'forest_thinning', 'prescribed_burn', 'home_hardening', 'wetland', 'irrigation', 'treatment', 'warning_system'];
  function coreProjectIds() {
    var ids = null;
    try { if (UI.game && typeof UI.game.getCoreProjects === 'function') ids = UI.game.getCoreProjects(); } catch (e) { ids = null; }
    return (Array.isArray(ids) && ids.length) ? ids.map(String) : CORE_PROJECTS.slice();
  }
  UI.renderProjects = function () {
    var box = UI.els.tabBody; if (!box) return;
    clear(box);
    var s = st();
    var list = [];
    try { list = safeList(UI.game && UI.game.getProjectList && UI.game.getProjectList()); } catch (e) { console.error(e); list = []; }
    if (!list.length) { box.appendChild(h('p', { class: 'muted small', 'aria-label': 'No projects available yet' }, '—')); return; }
    var showAll = UI.pref('allProjects') === true;
    var coreIds = coreProjectIds();
    var byId = {}; list.forEach(function (it) { var id = ((it || {}).def || {}).id; if (id != null) byId[String(id)] = it; });
    var core = coreIds.map(function (id) { return byId[id]; }).filter(Boolean);
    var extra = list.length - core.length;
    if (!core.length) showAll = true;
    /* "+3 ▾" shows the rest; the words live in the tooltip / aria-label */
    var toggleLabel = showAll ? 'Core projects only' : 'Show all projects (' + extra + ' more)';
    var toggle = h('button', { class: 'ghost tiny proj-toggle', type: 'button', id: 'projects-toggle', 'aria-expanded': showAll ? 'true' : 'false', hidden: !core.length || extra <= 0, 'aria-label': toggleLabel, 'data-tip': toggleLabel },
      showAll ? icon('chevron-up', 12) : ['+' + extra + ' ', icon('chevron-down', 12)]);
    toggle.addEventListener('click', function () { UI.pref('allProjects', !showAll); UI.renderProjects(); });
    box.appendChild(h('div', { class: 'row between tabhead' }, [
      h('span', { class: 'chip money', 'data-tip': 'Budget ' + money(s.budget) + ' · emergency fund ' + money(s.emergencyFund), 'aria-label': 'Budget ' + money(s.budget) }, [icon('coins', 12), money(s.budget)]),
      toggle
    ]));
    if (!showAll) {
      var g = h('div', { class: 'tiles', role: 'list', 'aria-label': 'Core projects' });
      core.forEach(function (it) { g.appendChild(projectTile(it, s)); });
      box.appendChild(g);
      return;
    }
    var groups = {};
    list.forEach(function (it) { var cat = ((it || {}).def || {}).category || 'community'; (groups[cat] = groups[cat] || []).push(it); });
    var cats = CATEGORY_ORDER.filter(function (c) { return groups[c]; }).concat(Object.keys(groups).filter(function (c) { return CATEGORY_ORDER.indexOf(c) < 0; }));
    cats.forEach(function (cat) {
      var g = h('div', { class: 'group', 'data-category': cat }, h('div', { class: 'label' }, [icon(CATEGORY_ICONS[cat] || 'dot', 12), ' ', CATEGORY_NAMES[cat] || cat]));
      var tiles = h('div', { class: 'tiles', role: 'list' });
      groups[cat].forEach(function (it) { tiles.appendChild(projectTile(it, s)); });
      g.appendChild(tiles); box.appendChild(g);
    });
  };
  /** Project tile: icon + 2-word name + price chip + level dots (+ zone select when a target must be chosen) + Fund. Everything else is the ⓘ tooltip. */
  function projectTile(it, s) {
    it = it || {}; var d = it.def || {};
    var id = d.id || 'unknown', level = fin(it.level), maxLevel = Math.max(1, fin(d.maxLevel, 1));
    var funded = !!it.funded || level > 0;
    var targets = safeList(it.targets);
    var zoneTargeted = (d.targetType && d.targetType !== 'global') || targets.length > 0;
    var maxed = funded && level >= maxLevel;
    var canFund = it.canFund !== false && !maxed;
    var reason = it.reason || (maxed ? 'Fully built' : '');
    var seasonOk = !Array.isArray(d.seasonsAllowed) || d.seasonsAllowed.indexOf(fin(s.season)) >= 0;
    if (!seasonOk && !reason) reason = 'Only in ' + d.seasonsAllowed.map(function (i) { return seasonName(i); }).join('/');
    if (!seasonOk) canFund = false;
    if (fin(d.costM) > fin(s.budget) + 1e-9 && !reason) { reason = 'Needs ' + money(d.costM) + ', budget ' + money(s.budget); canFund = false; }
    var openTargets = targets.filter(function (t) { return !t.funded; });
    var fundedTargets = targets.filter(function (t) { return t.funded; });
    var sel = UI._targetSel[id];
    if (sel == null || !targets.some(function (t) { return String(t.zoneId) === String(sel); })) sel = openTargets.length ? openTargets[0].zoneId : (targets.length ? targets[0].zoneId : null);
    if (zoneTargeted && targets.length && !openTargets.length && !reason) { reason = 'All sectors covered'; canFund = false; }
    var fullName = d.name || id, shortName = UI.shortName(UI.PROJECT_SHORT, id, fullName, UI.WORD_CAPS.label);
    var status = maxLevel > 1 ? 'level ' + level + ' of ' + maxLevel : (funded ? 'funded' : 'not funded');
    var a11y = fullName + ', ' + money(d.costM) + ', ' + status + (fundedTargets.length ? ' in ' + fundedTargets.map(function (t) { return t.name || UI.zoneName(t.zoneId); }).join(', ') : '') + (reason ? '. ' + reason : '');

    var tile = h('div', { class: 'tile' + (funded ? ' funded' : '') + (!canFund ? ' locked' : '') + (maxed ? ' maxed' : ''), 'data-project': id, role: 'listitem', 'aria-label': a11y });
    /* ⓘ popover: name + ≤ 2 short lines (summary, trade-off) */
    var line1 = UI.short(d.summary || d.detail || '', 12), line2 = d.tradeoff ? UI.short(d.tradeoff, 10) : '';
    var tip = fullName + (line1 ? ' — ' + line1 : '') + (line2 ? ' · Trade-off: ' + line2 : '');
    /* d.icon is the project's emoji from src/sim/projects.js → silhouette via WS.Icons.forEmoji */
    tile.appendChild(h('div', { class: 'top' }, [h('span', { class: 'icon', 'aria-hidden': 'true' }, icon(d.icon || 'dot', 22)), UI.info(tip)]));
    tile.appendChild(h('div', { class: 'name', 'data-tip': shortName !== fullName ? fullName : null }, shortName));
    var pips = null;
    if (maxLevel > 1 && level > 0) {   /* pips only once funded: six empty squares per tile read as a dashed line across the panel */
      pips = h('span', { class: 'pips', role: 'img', 'aria-label': 'Level ' + level + ' of ' + maxLevel, 'data-tip': 'Level ' + level + ' / ' + maxLevel });
      for (var i = 0; i < maxLevel; i++) pips.appendChild(h('i', { class: i < level ? 'on' : '' }));
    }
    tile.appendChild(h('div', { class: 'meta' }, [
      h('span', { class: 'chip cost', 'data-tip': money(d.costM) + (fin(d.upkeepM) > 0 ? ' + ' + money(d.upkeepM) + '/yr upkeep' : '') }, money(d.costM)),
      pips || (funded ? h('span', { class: 'chip good tiny', 'data-tip': 'Funded' }, icon('check', 11)) : null),
      fundedTargets.length && !openTargets.length ? h('span', { class: 'chip good tiny', 'data-tip': fundedTargets.map(function (t) { return t.name || UI.zoneName(t.zoneId); }).join(', ') }, [icon('check', 11), String(fundedTargets.length)]) : null
    ]));
    var select = null;
    if (zoneTargeted && openTargets.length) {
      /* option text = first word of the zone (tiles are ~90 px); the full name is the select's tooltip + aria-label */
      var zname = function (t) { return t.name || UI.zoneName(t.zoneId); };
      select = h('select', { 'aria-label': 'Target for ' + fullName, 'data-tip': 'Where to build' }, targets.map(function (t) {
        return h('option', { value: String(t.zoneId), selected: String(t.zoneId) === String(sel) ? true : null, disabled: t.funded ? true : null, title: zname(t) }, UI.cap(zname(t), 1) + (t.funded ? ' ✓' : ''));
      }));
      var syncSel = function () { var t = targets.filter(function (x) { return String(x.zoneId) === String(select.value); })[0]; var n = t ? zname(t) : ''; select.setAttribute('data-tip', 'Where to build · ' + n); select.setAttribute('aria-label', 'Target for ' + fullName + ': ' + n); };
      syncSel();
      select.addEventListener('change', function () { UI._targetSel[id] = select.value; syncSel(); call('highlightZone', [Number(select.value)]); });
      select.addEventListener('focus', function () { call('highlightZone', [Number(select.value)]); });
      tile.appendChild(select);
    }
    var btnText = maxed ? icon('check', 12) : (!canFund ? icon('lock', 12) : (funded ? [icon('arrow-up', 11), ' Fund'] : 'Fund'));
    var btn = h('button', { class: 'primary tiny fund', type: 'button', disabled: !canFund ? true : null, 'aria-label': (funded && !maxed ? 'Upgrade ' : 'Fund ') + fullName + ' for ' + money(d.costM) + (reason ? '. ' + reason : ''), 'data-tip': !canFund && reason ? reason : (funded && !maxed ? 'Upgrade · ' + money(d.costM) : 'Fund · ' + money(d.costM)) }, btnText);
    btn.addEventListener('click', function () {
      var target = select ? Number(select.value) : (targets.length ? sel : undefined);
      btn.disabled = true;
      call('fundProject', [id, target], function (r) {
        if (r && r.ok === false) UI.toast(r.reason || r.text || 'Cannot fund ' + fullName, 'warn');
        else if (r && r.text) UI.toast(r.text, 'good');
        else if (r !== false) UI.toast(shortName + ' funded', 'good');
        UI.refresh();
      });
    });
    tile.appendChild(btn);
    var hoverZone = fundedTargets.length ? fundedTargets[0].zoneId : null;
    if (hoverZone != null) {
      tile.addEventListener('mouseenter', function () { call('highlightZone', [Number(hoverZone)]); });
      tile.addEventListener('mouseleave', function () { call('highlightZone', [null]); });
    }
    return tile;
  }
  UI.projectTile = projectTile;

  /* ================================================================== WATER */
  /* Five sliders; hydro+recreation move together as 'power_rec'. Tribal and downstream are fixed senior rows. */
  /* name = ≤ 2 words on screen; `full` is the aria-label / tooltip name */
  var WATER_ROWS = [
    { key: 'households', name: 'Households', full: 'Households', sectors: ['households'], icon: 'houses', color: '#1f6f8b', tip: 'Households — indoor and outdoor use for every home. Restrictions trim this demand.' },
    { key: 'farms', name: 'Farms', full: 'Farms & Ranches', sectors: ['farms'], icon: 'bales', color: '#a8741a', tip: 'Farms & Ranches — irrigation for hay, pasture and orchards. Short deliveries cut crop health and the farm economy.' },
    { key: 'wildlife', name: 'Wildlife', full: 'River & Wildlife', sectors: ['wildlife'], icon: 'elk', color: '#3f6b3a', nonc: true, tip: 'River & Wildlife — instream flow below the dam keeps fish, the riparian corridor and elk habitat alive. Non-consumptive: the water keeps flowing downstream.' },
    { key: 'power_rec', name: 'Power & Rec', full: 'Power & Recreation', sectors: ['hydro', 'recreation'], readKey: 'hydro', icon: 'bolt', color: '#6b4fbb', nonc: true, tip: 'Power & Recreation — hydropower releases and rafting flows, moved together. Non-consumptive: the water returns to the river.' },
    { key: 'fire', name: 'Fire reserve', full: 'Fire Reserve', sectors: ['fire'], icon: 'engine', color: '#c1440e', tip: 'Fire Reserve — storage held back for firefighting and treatment-plant flushing. Cutting it saves water now and hurts when a fire comes.' }
  ];
  var SENIOR_ROWS = [
    { key: 'tribal', name: 'Tribal right', full: 'Tribal Water Right', icon: 'feather', color: '#8b5e1a', tip: 'Tribal Water Right — senior (Winters doctrine, 1908); always delivered.' },
    { key: 'downstream', name: 'Downstream', full: 'Colorado River Delivery', icon: 'stream', color: '#2f7f75', tip: 'Colorado River Delivery — senior under the 1922 Compact; always delivered.' }
  ];
  UI.renderWater = function () {
    var box = UI.els.tabBody; if (!box) return;
    clear(box);
    var s = st(), w = s.water || {}, dem = w.demands || {}, alloc = w.alloc || {}, del = w.delivered || {};
    var available = fin(w.availableAF);
    var sum = function (obj, keys) { var t = 0, any = false; keys.forEach(function (k) { if (obj[k] != null && isFinite(Number(obj[k]))) { t += Number(obj[k]); any = true; } }); return any ? t : null; };
    var rows = WATER_ROWS.map(function (r) {
      var a = clamp(alloc[r.readKey || r.key] == null ? 1 : alloc[r.readKey || r.key], 0, 1);
      return { def: r, req: fin(sum(dem, r.sectors)), a: a, last: sum(del, r.sectors) };
    });
    var seniors = SENIOR_ROWS.map(function (r) { return { def: r, req: fin(sum(dem, [r.key])), a: 1, last: sum(del, [r.key]) }; });
    var all = rows.concat(seniors);
    var totalAlloc = 0; all.forEach(function (r) { totalAlloc += r.req * r.a; });

    /* one compact available / requested bar: numbers + ⓘ, no captions */
    var scale = Math.max(available, totalAlloc, 1), over = totalAlloc > available;
    var bar = h('div', { class: 'stackbar', role: 'img', 'aria-label': 'Requested ' + af(totalAlloc) + ' of ' + af(available) + ' available' });
    all.forEach(function (r) {
      var v = r.req * r.a;
      if (v > 0) bar.appendChild(h('i', { style: { width: (v / scale * 100) + '%', background: r.def.color }, 'data-tip': r.def.full + ' ' + af(v) }));
    });
    bar.appendChild(h('span', { class: 'avail', style: { left: clamp(available / scale * 100, 0, 100) + '%' }, 'data-tip': 'Available ' + af(available) }));
    var unc = fin((s.climate || {}).uncertainty, 0.15);
    box.appendChild(h('div', { class: 'wbar' }, [
      h('div', { class: 'row between small num' }, [
        h('span', { class: 'wn', 'data-tip': 'Available this season · inflow ' + af(w.inflowAF) + ' + storage ' + af((s.reservoir || {}).storageAF) + (unc > 0.1 ? ' (±' + Math.round(unc * 100) + '%)' : ''), 'aria-label': 'Available ' + af(available) }, [icon('drop', 12), ' ', af(available)]),
        h('span', { class: 'wn' + (over ? ' bad' : ''), 'data-tip': 'Requested = each use\'s need × your allocation' + (over ? ' · over what is available: lower-priority uses go short' : ''), 'aria-label': 'Requested ' + af(totalAlloc) + (over ? ', more than available' : '') }, [h('span', { 'aria-hidden': 'true' }, '→ '), af(totalAlloc), over ? [' ', icon('alert', 12)] : null]),
        UI.info('Available = inflow + storage above dead pool. Requested = need × allocation. Deliveries run in priority order: households, senior rights, farms, wildlife, fire reserve, power & recreation. Non-consumptive releases return to the river.')
      ]),
      bar
    ]));

    /* restriction: icon + a short select (details in the tooltip) */
    var restr = h('select', { id: 'restriction-select', 'aria-label': 'Water restriction level', 'data-tip': 'Restrictions cut household demand: voluntary ≈ 5–10%, Stage 1 ≈ 15–20% (watering 2 days/week), Stage 2 ≈ 30%+ (outdoor ban). Costs some trust.' }, [['none', 'No limits'], ['voluntary', 'Voluntary'], ['stage1', 'Stage 1'], ['stage2', 'Stage 2']].map(function (o) {
      return h('option', { value: o[0], selected: (w.restriction || 'none') === o[0] ? true : null }, o[1]);
    }));
    restr.addEventListener('change', function () { call('setRestriction', [restr.value], function () { UI.refresh(); }); });
    box.appendChild(h('div', { class: 'row restrict' }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('tap-off', 16)), restr]));
    box.appendChild(h('hr', { class: 'rule' }));

    /* slider rows: icon + name + % + AF */
    rows.forEach(function (r) {
      var d = r.def, req = r.req, a = r.a, est = req * a;
      var row = h('div', { class: 'sector', 'data-sector': d.key, role: 'group', 'aria-label': d.full });
      var pctEl = h('span', { class: 'pct num' }, Math.round(a * 100) + '%');
      var afEl = h('span', { class: 'af num', 'data-tip': 'Delivery ≈ ' + af(est) + ' of ' + af(req) + ' requested' + (r.last != null ? ' · last season ' + af(r.last) : '') }, af(est));
      row.appendChild(h('div', { class: 't' }, [
        h('span', { class: 'ic', 'aria-hidden': 'true' }, icon(d.icon, 15)), h('span', { class: 'name', 'data-tip': d.full !== d.name ? d.full : null }, d.name), UI.info(d.tip),
        d.nonc ? h('span', { class: 'glyph nonc', role: 'img', 'aria-label': 'Non-consumptive', 'data-tip': 'Non-consumptive · the water keeps flowing downstream' }, icon('refresh', 11)) : null,
        pctEl, afEl
      ]));
      var slider = h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round(a * 100), 'aria-label': 'Allocation for ' + d.full });
      slider.addEventListener('input', function () {
        var v = clamp(Number(slider.value), 0, 100);
        pctEl.textContent = v + '%'; afEl.textContent = af(req * v / 100);
        afEl.setAttribute('data-tip', 'Delivery ≈ ' + af(req * v / 100) + ' of ' + af(req) + ' requested');
        row.classList.toggle('short', v < 100);
      });
      slider.addEventListener('change', function () { call('setAllocation', [d.key, clamp(Number(slider.value), 0, 100) / 100]); });
      row.appendChild(slider);
      if (a < 0.999) row.classList.add('short');
      box.appendChild(row);
    });
    /* fixed senior rows: icon + name + lock + AF */
    seniors.forEach(function (r) {
      var d = r.def;
      box.appendChild(h('div', { class: 'sector senior', 'data-sector': d.key, role: 'group', 'aria-label': d.full + ', senior right, always delivered, ' + af(r.req) }, [
        h('div', { class: 't' }, [
          h('span', { class: 'ic', 'aria-hidden': 'true' }, icon(d.icon, 15)), h('span', { class: 'name', 'data-tip': d.full }, d.name),
          h('span', { class: 'glyph lock', role: 'img', 'aria-label': 'Senior right, always delivered', 'data-tip': d.tip }, icon('lock', 11)),
          h('span', { class: 'af num', 'data-tip': 'Delivered in full' + (r.last != null ? ' · last season ' + af(r.last) : '') }, af(r.req))
        ])
      ]));
    });
  };

  /* ================================================================== FIRE */
  function zoneFuel(z) {
    var w = wd();
    try { if (WS.Fire && typeof WS.Fire.fuelStats === 'function') { var fs = WS.Fire.fuelStats(w); if (fs && fs.byZone && isFinite(Number(fs.byZone[z.id]))) return Number(fs.byZone[z.id]); } } catch (e) { /* fall through */ }
    if (isFinite(Number(z.fuel))) return Number(z.fuel);
    var cells = z.cells, fuel = w.fuel;
    if (!cells || !fuel || !cells.length) return NaN;
    var sum = 0, n = 0;
    for (var i = 0; i < cells.length; i++) { var f = fuel[cells[i]]; if (isFinite(f)) { sum += f; n++; } }
    return n ? sum / n : NaN;
  }
  function projectEffects() {
    try { if (WS.Projects && typeof WS.Projects.effects === 'function') return WS.Projects.effects(st()) || {}; } catch (e) { /* ignore */ }
    var funded = ((st().projects || {}).funded) || {}, eff = { thinnedZones: {}, fuelBreakZones: {}, hardenedZones: {} };
    var th = funded.forest_thinning; if (th && th.targets) th.targets.forEach(function (z) { eff.thinnedZones[z] = 1; });
    return eff;
  }
  function pendingBurnZone() {
    var pb = (st().projects || {}).pendingBurn;
    if (pb == null) return null;
    if (typeof pb === 'object') return pb.zoneId != null ? pb.zoneId : (pb.target != null ? pb.target : null);
    return pb;
  }
  UI.renderFire = function () {
    var box = UI.els.tabBody; if (!box) return;
    clear(box);
    var s = st(), f = s.fire || {}, policy = f.policy === 'suppress_all' ? 'suppress_all' : 'managed';
    var season = fin(s.season), burnSeason = season === 1 || season === 3;
    var eff = projectEffects(), thinned = eff.thinnedZones || {}, breaks = eff.fuelBreakZones || {};
    var pending = pendingBurnZone();

    /* policy = two icon buttons; the fire paradox lives in the ⓘ tooltip */
    var paradox = 'The fire paradox — putting out every small fire lets fuel pile up; Colorado\'s forests historically burned every 10–30 years at low intensity, and a century of suppression fed the 2020 fires. Managed: some low-intensity fire burns under watch (some smoke and risk). Suppress all: fewer small fires now, fuel builds ~60% faster, the eventual fire burns hotter.';
    var seg = h('div', { class: 'seg policy', role: 'group', 'aria-label': 'Fire policy' }, [
      h('button', { type: 'button', class: policy === 'managed' ? 'active' : '', 'aria-pressed': policy === 'managed', 'data-tip': 'Managed fire · low-intensity fires may burn under watch; fuel stays down', onclick: function () { call('setFirePolicy', ['managed'], function () { UI.refresh(); }); } }, [icon('leaf', 13), ' Managed fire']),
      h('button', { type: 'button', class: policy === 'suppress_all' ? 'active' : '', 'aria-pressed': policy === 'suppress_all', 'data-tip': 'Suppress all fires · every start is attacked; fuel builds ~60% faster', onclick: function () { call('setFirePolicy', ['suppress_all'], function () { UI.refresh(); }); } }, [icon('extinguisher', 13), ' Suppress all'])
    ]);
    box.appendChild(h('div', { class: 'row between tabhead' }, [seg, UI.info(paradox)]));

    /* sector rows: name · fuel bar · one status chip · one action */
    var zones = zoneList('forest');
    if (!zones.length) { box.appendChild(h('p', { class: 'muted small', 'aria-label': 'Forest sectors appear once the world is loaded' }, '—')); return; }
    var list = h('div', { id: 'fuel-table', role: 'list', 'aria-label': 'Forest sectors, fuel load' });
    zones.forEach(function (z) {
      z = z || {};
      var fuel = zoneFuel(z), fpct = isFinite(fuel) ? Math.round(clamp(fuel, 0, 1) * 100) : null;
      var isPending = String(pending) === String(z.id);
      var burnedPct = zoneBurnedPct(z), tstr = thinned[z.id];
      /* candidate chips in priority order; the first is shown, the rest go into the row tooltip */
      /* chip = [class, [icon name, text], tooltip] */
      var status = [];
      if (isPending) status.push(['fire', ['fire', null, 'play'], 'Prescribed burn scheduled']);
      if (burnedPct > 5) status.push(['danger', ['fire', burnedPct + '%'], burnedPct + '% of this sector already burned']);
      if (tstr) status.push(['forest', ['axe', Math.round(clamp(typeof tstr === 'number' ? tstr : 1, 0, 1) * 100) + '%'], 'Thinned · benefit fades ~12%/yr as the stand regrows']);
      if (breaks[z.id]) status.push(['forest', ['axe', '═'], 'Fuel break']);
      if (z.upstreamOfReservoir) status.push(['upstream', ['dam', '↑'], 'Upstream of the reservoir · a severe burn here sends ash and sediment into the water supply']);
      var first = status[0], rest = status.slice(1).map(function (c) { return c[2]; });
      function chipBody(c) { return [icon(c[0], 11), c[1] != null ? ' ' + c[1] : null, c[2] ? icon(c[2], 10) : null]; }
      var canSchedule = burnSeason && pending == null && s.phase !== 'live';
      var tip = isPending ? 'Cancel the scheduled burn' : (!burnSeason ? 'Prescribed burns only in Spring or Fall' : (pending != null ? 'One burn per season' : 'Prescribed burn · fuel −60%, ~4% escape risk (more in high danger)'));
      var btn = h('button', { class: 'tiny act' + (isPending ? ' active' : ''), type: 'button', disabled: (!isPending && !canSchedule) ? true : null, 'data-tip': tip, 'aria-label': (isPending ? 'Cancel prescribed burn in ' : 'Schedule prescribed burn in ') + (z.name || 'zone') + '. ' + tip }, icon(isPending ? 'cross' : 'fire', 14));
      btn.addEventListener('click', function () {
        if (isPending) call('cancelBurn', [], function () { UI.toast('Prescribed burn cancelled', 'info'); UI.refresh(); });
        else call('scheduleBurn', [z.id], function (r) { if (r && r.ok === false) UI.toast(r.reason || r.text || 'Could not schedule burn', 'warn'); else UI.toast('Burn scheduled · ' + (z.name || 'sector'), 'good'); UI.refresh(); });
      });
      var name = z.name || ('Sector ' + z.id), shortName = UI.cap(name, 2);
      var row = h('div', { class: 'fz', role: 'listitem', 'data-zone': z.id, 'aria-label': name + ', fuel ' + (fpct == null ? 'unknown' : fpct + '%') + (status.length ? ', ' + status.map(function (c) { return c[2]; }).join(', ') : ''), 'data-tip': rest.length ? rest.join(' · ') : null }, [
        h('button', { class: 'name', type: 'button', 'data-tip': 'Fly to ' + name, 'aria-label': 'Fly to ' + name, onclick: function () { call('focusZone', [z.id]); call('highlightZone', [z.id]); } }, shortName),
        h('div', { class: 'fuel', 'data-tip': 'Fuel load ' + (fpct == null ? '—' : fpct + '%') }, [h('span', { class: 'num' }, fpct == null ? '—' : fpct + '%'), h('div', { class: 'meter thin' }, h('i', { class: fpct > 70 ? 'danger' : (fpct > 55 ? 'fire' : 'forest'), style: { width: (fpct || 0) + '%' } }))]),
        h('div', { class: 'chips' }, first ? h('span', { class: 'chip ' + first[0], 'data-tip': first[2], 'aria-label': first[2] }, chipBody(first[1])) : null),
        btn
      ]);
      row.addEventListener('mouseenter', function () { call('highlightZone', [z.id]); });
      row.addEventListener('mouseleave', function () { call('highlightZone', [null]); });
      list.appendChild(row);
    });
    var fires = safeList(f.fires);
    box.appendChild(h('div', { class: 'row between firehead' }, [
      h('span', { class: 'chip tiny ' + (burnSeason ? 'good' : ''), 'data-tip': burnSeason ? 'Burn window open (Spring / Fall)' : 'Burns only in Spring and Fall', 'aria-label': burnSeason ? 'Burn window open' : 'Burn window closed' }, [icon('calendar', 11), ' ', icon(burnSeason ? 'check' : 'cross', 11)]),
      h('span', { class: 'row small num', 'aria-label': Math.round(fin(f.totalAcres)).toLocaleString() + ' acres burned in ' + fires.length + ' fires, ' + Math.round(fin(f.structuresLost)) + ' structures lost' }, [
        h('span', { 'data-tip': 'Acres burned so far · ' + fires.length + ' fire' + (fires.length === 1 ? '' : 's') }, [icon('fire', 12), ' ', Math.round(fin(f.totalAcres)).toLocaleString()]),
        h('span', { 'data-tip': 'Structures lost' }, [icon('house', 12), ' ', String(Math.round(fin(f.structuresLost)))])
      ])
    ]));
    box.appendChild(list);
  };
  function zoneBurnedPct(z) {
    var w = wd(), cells = z.cells, burn = w.burn;
    if (!cells || !burn || !cells.length) return 0;
    var n = 0; for (var i = 0; i < cells.length; i++) if (burn[cells[i]] > 0.2) n++;
    return Math.round(n / cells.length * 100);
  }

  /* ================================================================== CHARACTER CREATOR */
  var CREATOR_LABELS = { body: 'Gender', skin: 'Skin', hair: 'Hair', hairColor: 'Hair colour', eyes: 'Eyes', brows: 'Brows', mouth: 'Mouth', facialHair: 'Facial hair', glasses: 'Glasses', hat: 'Hat', outfit: 'Outfit', accessory: 'Accessory' };
  var THUMB_PX = 46, ZOOM_KINDS = { eyes: true, brows: true, mouth: true, facialHair: true, glasses: true };
  var CREATOR_ORDER = ['body', 'skin', 'hair', 'hairColor', 'eyes', 'facialHair', 'glasses', 'hat', 'outfit', 'accessory']; /* brows/mouth keep sensible defaults (player feedback: simpler) */
  var SWATCH_KINDS = { skin: 1, hairColor: 1, outfit: 1 };
  function optLabel(kind, id) {
    var L = (WS.Faces && WS.Faces.LABELS && WS.Faces.LABELS.values) || {};
    if (L[id]) return L[id];
    return String(id).charAt(0).toUpperCase() + String(id).slice(1);
  }
  /**
   * "Your character" panel. initial: { name, face }. onChange(player) fires on every edit.
   * Returns { el, get() → { name, face }, set(player) }.
   */
  UI.characterCreator = function (initial, onChange) {
    var F = WS.Faces;
    initial = initial || {};
    var name = String(initial.name || 'Director Rivera');
    var face = F ? F.normalize(initial.face) : (initial.face || {});
    var el = h('div', { class: 'creator', role: 'group', 'aria-label': 'Your character' });
    var portrait = null, portraitBox = h('div', { class: 'pbox' });
    var nameInput = h('input', { type: 'text', id: 'creator-name', value: name, maxlength: 28, 'aria-label': 'Character name', placeholder: 'Your name' });
    nameInput.addEventListener('input', function () { name = nameInput.value; emit(); });
    var rows = h('div', { class: 'c-rows' });
    var buttons = {};   /* kind → [button] */
    function emit() { if (typeof onChange === 'function') { try { onChange(get()); } catch (e) { console.error(e); } } }
    function get() { return { name: (String(name || '').trim() || 'Director Rivera').slice(0, 28), face: F ? F.normalize(face) : face }; }
    function renderPortrait() {
      clear(portraitBox);
      portrait = UI.portrait(face, 128, { title: 'Portrait preview' });
      portraitBox.appendChild(portrait);
    }
    var thumbSrc = null; /* offscreen portrait canvas reused for every thumbnail */
    function drawThumb(b) {
      if (!F || !b._thumb) return;
      var spec = {}; for (var k in face) spec[k] = face[k]; spec[b._kind] = b.dataset.value;
      if (!thumbSrc) { thumbSrc = document.createElement('canvas'); thumbSrc.width = thumbSrc.height = 192; }
      try { F.draw(thumbSrc, spec, { bg: null }); } catch (e) { return; }
      var cv = b._thumb, g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
      if (ZOOM_KINDS[b._kind]) g.drawImage(thumbSrc, 40, 24, 112, 112, 0, 0, cv.width, cv.height);   /* eyes / mouth / glasses… zoomed to the face */
      else g.drawImage(thumbSrc, 0, 0, 192, 192, 0, 0, cv.width, cv.height);
    }
    function syncButtons() {
      for (var kind in buttons) buttons[kind].forEach(function (b) { var on = b.dataset.value === face[kind]; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); drawThumb(b); });
    }
    function setFace(next) { face = F ? F.normalize(next) : (next || {}); renderPortrait(); syncButtons(); emit(); }
    function pick(kind, id) { var n = {}; for (var k in face) n[k] = face[k]; n[kind] = id; setFace(n); }
    if (!F) { el.appendChild(h('p', { class: 'muted small' }, 'Portraits unavailable (faces.js not loaded).')); }
    else {
      CREATOR_ORDER.forEach(function (kind) {
        var list = F.OPTIONS[kind] || []; if (!list.length) return;
        var group;
        if (SWATCH_KINDS[kind]) {
          group = h('div', { class: 'swatches', role: 'group', 'aria-label': CREATOR_LABELS[kind] || kind });
          buttons[kind] = list.map(function (o) {
            var b = h('button', { type: 'button', class: 'swatch', style: { '--c': o.hex }, 'data-value': o.id, 'aria-label': (CREATOR_LABELS[kind] || kind) + ' ' + o.id.replace(/^\D+/, ''), 'data-tip': o.hex, 'aria-pressed': 'false' });
            b.dataset.value = o.id;
            b.addEventListener('click', function () { pick(kind, o.id); });
            group.appendChild(b); return b;
          });
        } else {
          /* picture pickers: each option is a small portrait of the CURRENT character with that option applied
             (face details are shown zoomed in). Labels live in the tooltip / aria-label only. */
          group = h('div', { class: 'seg mini thumbs', role: 'group', 'aria-label': CREATOR_LABELS[kind] || kind });
          buttons[kind] = list.map(function (id) {
            var cv = h('canvas', { class: 'opt-thumb', width: THUMB_PX * 2, height: THUMB_PX * 2, 'aria-hidden': 'true' });
            var b = h('button', { type: 'button', class: 'thumb', 'aria-pressed': 'false', 'aria-label': (CREATOR_LABELS[kind] || kind) + ': ' + optLabel(kind, id), 'data-tip': optLabel(kind, id) }, [cv]);
            b.dataset.value = id; b._thumb = cv; b._kind = kind;
            b.addEventListener('click', function () { pick(kind, id); });
            group.appendChild(b); return b;
          });
        }
        rows.appendChild(h('div', { class: 'crow', 'data-kind': kind }, [h('span', { class: 'k' }, CREATOR_LABELS[kind] || kind), group]));
      });
    }
    var presets = h('div', { class: 'presets', role: 'group', 'aria-label': 'Presets' }, ((F && F.PRESETS) || []).slice(0, 4).map(function (p) {
      var b = h('button', { type: 'button', 'data-tip': 'Start from the ' + p.name.toLowerCase() + ' preset' }, p.name);
      b.addEventListener('click', function () { setFace(p.face); });
      return b;
    }));
    var rand = h('button', { type: 'button', class: 'rand', 'aria-label': 'Randomise', 'data-tip': 'Roll a random look' }, [icon('dice', 13), ' Random']);
    rand.addEventListener('click', function () { if (F) setFace(F.random(null)); });
    el.appendChild(h('div', { class: 'c-title' }, [h('span', { class: 'label', 'data-tip': 'This is who walks the watershed and gives the orders.' }, 'Your character')]));
    el.appendChild(h('div', { class: 'c-left' }, [portraitBox, nameInput, rand, presets]));
    el.appendChild(rows);
    renderPortrait(); syncButtons();
    return { el: el, get: get, set: function (p) { p = p || {}; if (p.name != null) { name = String(p.name); nameInput.value = name; } if (p.face) setFace(p.face); else emit(); } };
  };

  /* ================================================================== INTRO */
  /* ================================================================== TITLE SCREEN
     Opaque paper page: the wordmark in a rounded font, a drop that falls into expanding ripples, Play. */
  UI.showTitle = function () {
    return new Promise(function (resolve) {
      UI.applyPrefs();
      var word = 'WATERSHED';
      var cv = h('canvas', { 'aria-hidden': 'true' });
      var letters = h('div', { class: 't-word', role: 'heading', 'aria-level': '1', 'aria-label': 'Watershed' },
        word.split('').map(function (ch, i) { return h('span', { style: { '--i': String(i) }, 'aria-hidden': 'true' }, ch); }));
      var play = h('button', { type: 'button', class: 't-play', id: 'title-play' }, 'Play');
      var el = h('div', { id: 'title-screen', role: 'dialog', 'aria-label': 'Watershed title' }, [
        cv,
        h('div', { class: 't-inner' }, [letters, h('div', { class: 't-sub' }, 'A Colorado water game'), play, h('div', { class: 't-hint' }, 'Press Enter or Space')])
      ]);
      document.body.appendChild(el);
      try { play.focus(); } catch (e) { /* ignore */ }

      /* --- ripple animation ------------------------------------------------- */
      var ctx = cv.getContext('2d'), dpr = Math.min(2, window.devicePixelRatio || 1), W = 0, H = 0;
      var reduced = reducedMotion();
      var ripples = [], drops = [], t0 = 0, raf = 0, nextDrop = 0, alive = true;
      var ink = '#1f6f8b', paper = '#f3ead8', line = '#d9cfb3';
      function resize() { W = el.clientWidth || innerWidth; H = el.clientHeight || innerHeight; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
      function spawnDrop(x) { drops.push({ x: x, y: -30, vy: 0, r: 9 + Math.random() * 5 }); }
      function splash(x, y, big) {
        var n = big ? 4 : 3;
        for (var i = 0; i < n; i++) ripples.push({ x: x, y: y, r: 4 + i * 6, v: 55 + i * 12, a: 0.9 - i * 0.18, w: big ? 3 : 2, born: i * 0.12 });
      }
      function waterLine() { return H * 0.78; }
      function frame(ts) {
        if (!alive) return;
        if (!t0) t0 = ts;
        var t = (ts - t0) / 1000, dt = 1 / 60;
        ctx.clearRect(0, 0, W, H);
        /* faint contour lines (paper texture) */
        ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.globalAlpha = 1;
        for (var c = 0; c < 9; c++) { var yy = 40 + c * (H / 9); ctx.beginPath(); for (var x = 0; x <= W; x += 24) { var y = yy + Math.sin(x * 0.012 + c * 1.7) * 9 + Math.sin(x * 0.03 + c) * 3; if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke(); }
        var wl = waterLine();
        /* still water surface: a soft band */
        ctx.fillStyle = '#e4dcc4'; ctx.fillRect(0, wl - 2, W, 4);
        /* drops */
        if (!reduced && t > nextDrop) { spawnDrop(W * (0.3 + Math.random() * 0.4)); nextDrop = t + 1.6 + Math.random() * 1.4; }
        for (var i = drops.length - 1; i >= 0; i--) {
          var d = drops[i]; d.vy += 900 * dt; d.y += d.vy * dt;
          ctx.fillStyle = ink; ctx.beginPath(); ctx.moveTo(d.x, d.y - d.r * 1.6); ctx.quadraticCurveTo(d.x + d.r * 1.1, d.y - d.r * 0.2, d.x, d.y + d.r * 0.9); ctx.quadraticCurveTo(d.x - d.r * 1.1, d.y - d.r * 0.2, d.x, d.y - d.r * 1.6); ctx.fill();
          ctx.fillStyle = paper; ctx.beginPath(); ctx.arc(d.x - d.r * 0.3, d.y - d.r * 0.4, d.r * 0.22, 0, Math.PI * 2); ctx.fill();
          if (d.y >= wl) { splash(d.x, wl, d.r > 12); drops.splice(i, 1); }
        }
        /* ripples: expanding ellipses (perspective-flattened) */
        for (i = ripples.length - 1; i >= 0; i--) {
          var rp = ripples[i]; rp.born -= dt; if (rp.born > 0) continue;
          rp.r += rp.v * dt; rp.a -= dt * 0.32; if (rp.a <= 0) { ripples.splice(i, 1); continue; }
          ctx.globalAlpha = Math.max(0, rp.a); ctx.strokeStyle = ink; ctx.lineWidth = rp.w;
          ctx.beginPath(); ctx.ellipse(rp.x, rp.y, rp.r, rp.r * 0.28, 0, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        /* reflection of the word: a rippled mirror hint below the surface */
        ctx.save(); ctx.globalAlpha = 0.14; ctx.fillStyle = ink; ctx.font = '700 ' + Math.round(Math.min(148, Math.max(56, W * 0.11)) * 0.9) + 'px Fredoka, "IBM Plex Sans", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.translate(W / 2, wl + 8); ctx.scale(1, -0.32);
        for (var s2 = 0; s2 < 5; s2++) { var off = Math.sin(t * 2.2 + s2) * 3; ctx.fillText(word, off, -s2 * 4); }
        ctx.restore();
        raf = requestAnimationFrame(frame);
      }
      function finish() {
        if (!alive) return; alive = false; cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize); document.removeEventListener('keydown', onKey);
        el.classList.add('leaving');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); resolve(); }, reduced ? 0 : 520);
      }
      function onKey(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(); } }
      window.addEventListener('resize', resize); document.addEventListener('keydown', onKey);
      play.addEventListener('click', finish);
      resize();
      if (reduced) { /* one static splash so the page still reads */ splash(W / 2, waterLine(), true); ripples.forEach(function (r) { r.born = 0; r.r = 60; }); }
      raf = requestAnimationFrame(frame);
      /* the first drop lands right under the word */
      setTimeout(function () { if (alive) spawnDrop(W / 2); }, 400);
    });
  };

  /* ================================================================== MENU PAGE (title → menu → setup)
     Opaque paper page in the title style: static contour lines, a smaller wordmark, three stacked paper buttons.
     Settings and Credits open as modals over the page and return to it; Start Game resolves 'start'. */
  function reducedMotion() {
    try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true; } catch (e) { /* ignore */ }
    return !!(document.documentElement && document.documentElement.classList.contains('reduce-motion'));
  }
  UI.reducedMotion = reducedMotion;
  /** static HiDPI copy of the title page's contour lines */
  function paintContours(cv, el) {
    var ctx = cv.getContext('2d'), dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = el.clientWidth || innerWidth, H = el.clientHeight || innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H); ctx.strokeStyle = '#d9cfb3'; ctx.lineWidth = 1;
    for (var c = 0; c < 9; c++) { var yy = 40 + c * (H / 9); ctx.beginPath(); for (var x = 0; x <= W; x += 24) { var y = yy + Math.sin(x * 0.012 + c * 1.7) * 9 + Math.sin(x * 0.03 + c) * 3; if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke(); }
  }
  /** Camera pan speed (0.6–1.6): applied when the renderer's controls expose a speed field; otherwise only stored. */
  UI.applyPanSpeed = function (v) {
    v = Number(v); if (!isFinite(v)) return false;
    v = clamp(v, 0.6, 1.6);
    var c = WS.Renderer && WS.Renderer._ctx && WS.Renderer._ctx.controls;
    if (!c) return false;
    if ('panSpeed' in c) c.panSpeed = v; else if (typeof c.setPanSpeed === 'function') c.setPanSpeed(v); else if ('speed' in c) c.speed = v; else return false;
    return true;
  };
  /** Applies the persisted page-wide preferences (html.reduce-motion, camera pan speed). Safe to call any time. */
  UI.applyPrefs = function () {
    try { document.documentElement.classList.toggle('reduce-motion', UI.pref('reduceMotion') === true); } catch (e) { /* ignore */ }
    UI.applyPanSpeed(UI.pref('panSpeed'));
  };

  /** showMenu() → Promise<'start'>. Keys: ↑/↓ (or ←/→) move, Enter picks, 1/2/3 pick directly, Esc does nothing. */
  UI.showMenu = function () {
    UI.applyPrefs();
    return new Promise(function (resolve) {
      var host = UI.els.ui || document.body;
      var cv = h('canvas', { 'aria-hidden': 'true' });
      var word = h('div', { class: 't-word', role: 'heading', 'aria-level': '1', 'aria-label': 'Watershed' },
        'WATERSHED'.split('').map(function (ch) { return h('span', { 'aria-hidden': 'true' }, ch); }));
      var items = [
        { id: 'start', icon: 'play', label: 'Start Game', tip: 'Choose years, climate, seed, difficulty and your character', run: function () { finish('start'); } },
        { id: 'multiplayer', icon: 'people', label: 'Multiplayer', tip: 'Play with friends', run: function () {
          UI.toast('Multiplayer is not available yet', 'info'); refocus();
        } },
        { id: 'settings', icon: 'tools', label: 'Settings', tip: 'Sound, tutorial hints, motion, camera', run: function () { UI.showSettings().then(refocus); } },
        { id: 'credits', icon: 'book', label: 'Credits', tip: 'Who and what made Watershed', run: function () { UI.showCredits().then(refocus); } }
      ];
      var sel = 0, alive = true;
      var btns = items.map(function (it, i) {
        var b = h('button', { type: 'button', class: 'm-btn', id: 'menu-' + it.id, 'data-tip': it.tip, 'aria-label': it.label + ' (' + (i + 1) + ')' }, [
          h('span', { class: 'ic', 'aria-hidden': 'true' }, icon(it.icon, 24)), h('span', { class: 'lbl' }, it.label),
          it.soon ? h('span', { class: 'soon' }, 'Soon') : null,
          h('span', { class: 'key', 'aria-hidden': 'true' }, String(i + 1))]);
        if (it.soon) b.classList.add('soon');
        b.addEventListener('click', function () { sel = i; mark(); it.run(); });
        b.addEventListener('focus', function () { sel = i; mark(); });
        return b;
      });
      var el = h('div', { id: 'menu-screen', role: 'dialog', 'aria-label': 'Watershed menu' }, [
        cv,
        h('div', { class: 'm-inner' }, [word, h('div', { class: 'm-sub' }, 'A Colorado water game'), h('div', { class: 'm-list', role: 'menu' }, btns), h('div', { class: 't-hint' }, 'Arrows · Enter · 1–4')])
      ]);
      host.appendChild(el); document.body.classList.add('menu-open');
      function mark() { btns.forEach(function (b, i) { b.classList.toggle('sel', i === sel); }); }
      function refocus() { if (!alive) return; mark(); try { btns[sel].focus(); } catch (e) { /* ignore */ } }
      function onKey(e) {
        if (!alive || UI.modalIsOpen()) return;   /* Settings / Credits own the keyboard while open */
        var k = e.key, handled = true;
        if (k === 'ArrowDown' || k === 'ArrowRight') { sel = (sel + 1) % btns.length; refocus(); }
        else if (k === 'ArrowUp' || k === 'ArrowLeft') { sel = (sel + btns.length - 1) % btns.length; refocus(); }
        else if (k === 'Home') { sel = 0; refocus(); }
        else if (k === 'End') { sel = btns.length - 1; refocus(); }
        else if (k === 'Enter') { items[sel].run(); }
        else if (/^[1-9]$/.test(k) && +k <= items.length) { sel = +k - 1; refocus(); items[sel].run(); }
        else handled = false;   /* Esc and everything else: nothing */
        if (handled) { e.preventDefault(); e.stopPropagation(); }   /* 1–3 must not reach the game's speed keys */
      }
      function resize() { paintContours(cv, el); }
      function finish(v) {
        if (!alive) return; alive = false;
        document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', resize);
        el.classList.add('leaving');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); document.body.classList.remove('menu-open'); resolve(v); }, reducedMotion() ? 0 : 420);
      }
      document.addEventListener('keydown', onKey, true); window.addEventListener('resize', resize);
      resize(); mark();
      setTimeout(refocus, 30);
    });
  };

  /* ================================================================== SETTINGS (≤ 40 visible words) */
  UI.showSettings = function () {
    var S = WS.Sound || null;
    return UI.modal({
      icon: 'tools', eyebrow: 'Menu', title: 'Settings', className: 'narrow settings',
      render: function (body) {
        function row(label, ic, ctl, tip) { return h('div', { class: 'srow', 'data-tip': tip || null }, [h('span', { class: 'k' }, [icon(ic, 13), ' ', label]), h('span', { class: 'c' }, ctl)]); }
        function toggle(id, on, label, onChange) { var cb = h('input', { type: 'checkbox', id: id, checked: on ? true : null, 'aria-label': label }); cb.addEventListener('change', function () { onChange(!!cb.checked); }); return cb; }
        /* sound: volume + mute, persisted by sound.js */
        var vol0 = (S && typeof S.getVolume === 'function') ? clamp(Number(S.getVolume()), 0, 1) : 0.8;
        var vol = h('input', { type: 'range', id: 'set-volume', min: 0, max: 100, step: 5, value: Math.round(vol0 * 100), 'aria-label': 'Sound volume', disabled: S ? null : true });
        var volV = h('span', { class: 'v num' }, Math.round(vol0 * 100) + '%');
        vol.addEventListener('input', function () { var v = clamp(Number(vol.value), 0, 100); volV.textContent = v + '%'; if (S && typeof S.setVolume === 'function') S.setVolume(v / 100); });
        body.appendChild(row('Sound', 'volume', [vol, volV], S ? 'Volume · remembered in this browser' : 'Sound unavailable'));
        body.appendChild(row('Mute', 'volume-muted', toggle('set-mute', !!(S && typeof S.isMuted === 'function' && S.isMuted()), 'Mute', function (on) { if (S && typeof S.setMuted === 'function') S.setMuted(on); }), 'Silence all game audio'));
        /* tutorial hints: also the setup modal's default */
        body.appendChild(row('Tutorial hints', 'grad', toggle('set-tutorial', UI.pref('tutorial') !== false, 'Tutorial hints', function (on) { UI.pref('tutorial', on); }), 'Coach marks on the first turn · the setup default'));
        /* reduced motion: html.reduce-motion, honoured like prefers-reduced-motion */
        body.appendChild(row('Reduced motion', 'pause', toggle('set-motion', UI.pref('reduceMotion') === true, 'Reduced motion', function (on) { UI.pref('reduceMotion', on); UI.applyPrefs(); }), 'Turns page animations off'));
        /* camera pan speed 0.6–1.6× */
        var ps0 = clamp(Number(UI.pref('panSpeed')) || 1, 0.6, 1.6);
        var ps = h('input', { type: 'range', id: 'set-pan', min: 60, max: 160, step: 10, value: Math.round(ps0 * 100), 'aria-label': 'Camera pan speed' });
        var psV = h('span', { class: 'v num' }, ps0.toFixed(1) + '×');
        ps.addEventListener('input', function () { var v = clamp(Number(ps.value), 60, 160) / 100; psV.textContent = v.toFixed(1) + '×'; UI.pref('panSpeed', v); UI.applyPanSpeed(v); });
        body.appendChild(row('Camera pan speed', 'compass', [ps, psV], 'Drag and keyboard pan · 0.6× to 1.6×'));
        /* forget the remembered character */
        var reset = h('button', { type: 'button', class: 'tiny', id: 'set-reset-player', 'data-tip': 'Forget the remembered name and face', disabled: UI.pref('player') ? null : true }, [icon('refresh', 12), ' Reset saved character']);
        reset.addEventListener('click', function () { UI.pref('player', null); reset.disabled = true; UI.toast('Character reset', 'info'); });
        body.appendChild(row('', 'idcard', reset, null));
      },
      foot: function (foot, close) { foot.appendChild(h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { close(); } }, 'Done')); }
    });
  };

  /* ================================================================== CREDITS (≤ 120 visible words; the numbers list is a disclosure) */
  UI.showCredits = function () {
    var srcs = (C.SOURCES && C.SOURCES.length) ? C.SOURCES : [];
    return UI.modal({
      icon: 'book', eyebrow: 'Menu', title: 'Credits', className: 'narrow credits',
      render: function (body) {
        body.appendChild(h('p', { class: 'lead' }, 'Watershed — a Colorado water-resilience game'));
        body.appendChild(h('ul', { class: 'small' }, [
          h('li', {}, 'Built with Three.js (r128)'),
          h('li', {}, 'IBM Plex Sans / Mono and Fredoka via Google Fonts'),
          h('li', {}, 'Synthesized audio')
        ]));
        body.appendChild(h('h3', {}, 'Where the numbers come from'));
        var list = h('ul', { class: 'small sources', id: 'credits-sources', hidden: true }, srcs.map(function (r) {
          return h('li', { 'data-tip': r.note || null }, [h('b', {}, String(r.label || '')), r.value ? ' · ' + r.value : '']);
        }));
        body.appendChild(disclosureButton('Show list', list, { controls: 'credits-sources' })); body.appendChild(list);
        body.appendChild(h('p', { class: 'small', style: { marginTop: '12px' } }, 'Inspired by the Cameron Peak, East Troublesome and Marshall fires and the Colorado River.'));
        body.appendChild(h('p', { class: 'small', style: { marginTop: '10px', fontWeight: '600' } }, '\u00A9 ' + new Date().getFullYear() + ' Julia Gao and Bettina Lee'));
        body.appendChild(h('p', { class: 'small muted num' }, 'Version ' + (C.VERSION || '—')));
      },
      foot: function (foot, close) { foot.appendChild(h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { close(); } }, 'Close')); }
    });
  };

  UI.showIntro = function () {
    return UI.showTitle().then(function () { return UI.showMenu(); }).then(function () { return UI._showSetup(); });
  };
  UI._showSetup = function () {
    return UI.modal({
      className: 'intro wide', critical: true,
      render: function (body, close) {
        /* brand mark + one line (≤ 12 words); the longer pitch is the tooltip */
        body.appendChild(h('div', { class: 'intro-hero' }, [
          h('span', { html: UI.BRAND_SVG }),
          h('div', { class: 'wordmark' }, 'WATERSHED'),
          h('div', { class: 'tag', 'data-tip': 'You run the Bitterbrush Creek watershed: a snow-fed reservoir, a mountain town, four farms, a century of unburned forest and neighbours with senior water rights. What burns above the reservoir ends up in the tap — and when a fire or flood hits, you fight it live.' },
            UI.cap('Run a Colorado watershed: snow, fire, floods, water rights.', UI.WORD_CAPS.intro))
        ]));
        var years = 6, mode = 'simulated', tutorial = UI.pref('tutorial') !== false;   /* Settings → Tutorial hints is the default */
        var diffPref = UI.pref('difficulty'), difficulty = (C.DIFFICULTY && C.DIFFICULTY[diffPref]) ? diffPref : 'normal';
        /* four pickers: years · climate · difficulty · seed (segmented buttons; explanations in tooltips). opts: [value, label, tip, icon?] */
        function segPick(name, opts, current, onPick) {
          var seg = h('div', { class: 'seg', role: 'group', 'aria-label': name });
          var btns = opts.map(function (o) {
            var b = h('button', { type: 'button', class: o[0] === current ? 'active' : '', 'aria-pressed': o[0] === current ? 'true' : 'false', 'data-tip': o[2] || null, 'aria-label': o[1] + (o[2] ? ' · ' + o[2] : '') }, o[3] ? [icon(o[3], 12), ' ', o[1]] : o[1]);
            b.addEventListener('click', function () { btns.forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); }); b.classList.add('active'); b.setAttribute('aria-pressed', 'true'); onPick(o[0]); });
            seg.appendChild(b); return b;
          });
          return seg;
        }
        var yearsOpt = h('div', { class: 'opt' }, [h('span', { class: 'k' }, [icon('calendar', 11), ' Years']),
          segPick('Game length', [[4, '4', 'Quick game'], [6, '6', 'Recommended'], [8, '8', 'Full arc']], years, function (v) { years = v; })]);
        var modeOpt = h('div', { class: 'opt' }, [h('span', { class: 'k' }, [icon('sun', 11), ' Climate']),
          segPick('Climate', [['simulated', 'Simulated', 'Seeded weather; varies by seed'], ['historical', 'Historical', 'Approximate Colorado snowpack sequence']], mode, function (v) { mode = v; })]);
        var diffOpts = (C.DIFFICULTY ? (C.DIFFICULTY_ORDER || Object.keys(C.DIFFICULTY)) : []).map(function (k) { var d = C.DIFFICULTY[k]; return [k, d.label, d.desc, d.icon]; });
        var diffOpt = diffOpts.length ? h('div', { class: 'opt', id: 'intro-difficulty' }, [h('span', { class: 'k' }, [icon('scales', 11), ' Difficulty']),
          segPick('Difficulty', diffOpts, difficulty, function (v) { difficulty = v; })]) : null;
        var seedInput = h('input', { type: 'text', id: 'intro-seed', value: String(Math.floor(Math.random() * 90000) + 10000), 'aria-label': 'Seed', maxlength: 24, 'data-tip': 'Same seed, same world and weather' });
        var seedOpt = h('div', { class: 'opt' }, [h('span', { class: 'k' }, [icon('dice', 11), ' Seed']), h('div', { class: 'seed' }, [seedInput, h('button', { type: 'button', 'aria-label': 'Random seed', 'data-tip': 'Random seed', onclick: function () { seedInput.value = String(Math.floor(Math.random() * 90000) + 10000); } }, icon('dice', 14))])]);
        /* "Your character": live 128 px portrait, name, pickers, Randomise, presets. Remembered in localStorage (guarded by UI.pref). */
        var remembered = UI.pref('player');
        var creator = UI.characterCreator({ name: (remembered && remembered.name) || 'Director Rivera', face: (remembered && remembered.face) || (WS.Faces && WS.Faces.PRESETS && WS.Faces.PRESETS[0].face) || null });
        body.appendChild(creator.el);
        body.appendChild(h('div', { class: 'opts ' + (diffOpt ? 'four' : 'three') }, [yearsOpt, modeOpt, diffOpt, seedOpt]));
        var tutLabel = h('label', { class: 'tut small', 'data-tip': 'Coach marks on the first turn (skippable)' }, [h('input', { type: 'checkbox', id: 'intro-tutorial', checked: tutorial ? true : null, onchange: function (e) { tutorial = !!e.target.checked; } }), icon('grad', 13), ' Tutorial']);
        body.appendChild(h('div', { class: 'row', style: { justifyContent: 'center', gap: '16px', marginTop: '16px' } }, [tutLabel, h('button', { class: 'primary big', type: 'button', id: 'intro-begin', autofocus: true, onclick: function () {
          var raw = (seedInput.value || '').trim(); var seed = /^-?\d+$/.test(raw) ? parseInt(raw, 10) : (raw || String(Date.now()));
          var player = creator.get();
          UI.pref('player', player); UI.pref('difficulty', difficulty); UI.pref('tutorial', tutorial);
          close({ years: years, mode: mode, seed: seed, tutorial: tutorial, player: player, difficulty: difficulty });
        } }, ['Begin ', icon('play', 13)])]));
      }
    });
  };

  /* ================================================================== EVENT CARD */
  UI.showEventCard = function (card) {
    card = card || {};
    var s = st();
    var sev = card.severity || 'info';
    var fullTitle = String(card.title || 'Something happens'), title = UI.cap(fullTitle, UI.WORD_CAPS.eventTitle);
    return UI.modal({
      icon: card.icon || 'bolt', eyebrow: 'Event · ' + seasonName(s.season) + ' Y' + fin(s.year, 1), title: title, critical: true, className: 'event',
      render: function (body, close) {
        var fullText = String(card.text || ''), line = UI.short(fullText, UI.WORD_CAPS.eventText);
        var src = card.source ? String(card.source).replace(/^\s*why this happens in colorado\s*[:\-–—]\s*/i, '') : '';
        /* severity chip · one line of text · "why" ⓘ (full text + Colorado source in the tooltip) */
        body.appendChild(h('div', { class: 'severity-row' }, [
          h('span', { class: 'chip ' + sev, 'data-tip': card.once ? 'One-time event' : null }, sev === 'crisis' ? 'Crisis' : sev === 'warn' ? 'Warning' : 'Notice'),
          fullTitle !== title ? h('span', { class: 'small dim', 'data-tip': fullTitle, 'aria-label': fullTitle }, '…') : null,
          h('span', { class: 'grow' }),
          (fullText || src) ? h('button', { class: 'info why', type: 'button', 'aria-label': 'Why this happens' + (src ? ': ' + src : ''), 'data-tip': (line !== fullText ? fullText + ' ' : '') + (src ? '— Why this happens in Colorado: ' + src : '') }, 'i') : null
        ]));
        if (line) body.appendChild(h('p', { class: 'lead one-line', 'data-tip': line !== fullText ? fullText : null }, line));
        var choices = safeList(card.choices);
        if (!choices.length) choices = [{ label: 'OK', desc: '' }];
        var affordable = choices.map(function (ch) { return !(fin(ch.costM) > fin(s.budget) + fin(s.emergencyFund) + 1e-9); });
        var anyAffordable = affordable.some(Boolean);
        var list = h('div', { class: 'event-choices', role: 'group', 'aria-label': 'Choices' });
        choices.forEach(function (ch, i) {
          ch = ch || {};
          var canPick = affordable[i] || !anyAffordable;
          var eff = [];
          if (ch.delta && typeof ch.delta === 'object') OUT_KEYS.forEach(function (k) { if (isFinite(Number(ch.delta[k])) && Number(ch.delta[k]) !== 0) eff.push(h('span', { class: 'chip tiny', 'data-tip': OUT_NAMES[k] || k }, [k + ' ', deltaNode(ch.delta[k])])); });
          var fullLabel = String(ch.label || ('Option ' + (i + 1))), label = UI.cap(fullLabel, UI.WORD_CAPS.choice);
          var tipParts = [];
          if (label !== fullLabel) tipParts.push(fullLabel);
          if (ch.desc) tipParts.push(String(ch.desc));
          if (ch.preview) tipParts.push(String(ch.preview));
          if (!canPick) tipParts.push('Not enough budget (' + money(fin(s.budget) + fin(s.emergencyFund)) + ' available)');
          var b = h('button', { class: 'choice', type: 'button', disabled: canPick ? null : true, 'data-choice': i, 'data-tip': tipParts.length ? tipParts.join(' · ') : null, 'aria-label': fullLabel + (fin(ch.costM) > 0 ? ', ' + money(ch.costM) : ', free') + (ch.desc ? '. ' + ch.desc : '') + (!canPick ? '. Not enough budget' : ''), onclick: function () { close(i); } }, [
            h('span', { class: 'lbl' }, label),
            eff.length ? h('span', { class: 'eff' }, eff) : null,
            h('span', { class: 'chip cost ' + (fin(ch.costM) > 0 ? '' : 'free') }, fin(ch.costM) > 0 ? money(ch.costM) : 'Free'),
            !canPick ? h('span', { class: 'noafford', 'aria-hidden': 'true' }, icon('lock', 14)) : null
          ]);
          list.appendChild(b);
        });
        body.appendChild(list);
      }
    });
  };

  /* ================================================================== EVIDENCE BOARD */
  function characterFor(rec) {
    rec = rec || {};
    if (rec.character && typeof rec.character === 'object') return rec.character;
    var list = (WS.Advisors && WS.Advisors.CHARACTERS) || [];
    if (!Array.isArray(list)) list = Object.keys(list).map(function (k) { return list[k]; });
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === rec.characterId) return list[i];
    return { id: rec.characterId, name: rec.name || rec.characterId || 'Advisor', role: rec.role || '', color: rec.color || '#1f6f8b', avatarEmoji: rec.avatarEmoji || 'person' };
  }
  var STANCE_LABEL = { urge: 'Urges', support: 'Supports', caution: 'Cautions', oppose: 'Opposes' };
  var STANCE_ICON = { urge: 'arrow-up', support: 'check', caution: 'alert', oppose: 'cross' };
  var STANCE_EXPR = { urge: 'worried', support: 'happy', caution: 'neutral', oppose: 'worried' };
  /** Evidence Board = a row of portrait tiles (64 px, name, stance chip, ≤ 6-word headline). Clicking one shows its sentence + chart in one strip. */
  UI.showEvidenceBoard = function (topic, recs, opts) {
    opts = opts || {}; recs = safeList(recs);
    var topicName = (UI.EVIDENCE_TOPICS.filter(function (t) { return t[0] === topic; })[0] || [topic, String(topic || 'Decision')])[1];
    return UI.modal({
      icon: 'bars', eyebrow: 'Evidence board', title: opts.title || topicName, className: 'wide evidence',
      render: function (body) {
        if (!recs.length) { body.appendChild(h('p', { class: 'muted small', 'aria-label': 'No advisor has weighed in on this yet' }, '—')); return; }
        var row = h('div', { class: 'adv-tiles', role: 'list' });
        var strip = h('div', { class: 'adv-strip', id: 'adv-strip', hidden: true, role: 'region', 'aria-live': 'polite', 'aria-label': 'Advisor detail' });
        var tiles = [];
        function select(i) {
          tiles.forEach(function (t, j) { t.classList.toggle('active', i === j); t.setAttribute('aria-pressed', i === j ? 'true' : 'false'); });
          clear(strip);
          var rec = recs[i] || {}, ch = characterFor(rec), ev = rec.evidence || null;
          strip.style.setProperty('--adv', ch.color || '#4aa3df');
          var sentence = rec.text ? UI.firstSentence(rec.text, 1) : '';
          strip.appendChild(h('div', { class: 'grow' }, [
            h('div', { class: 'sentence', 'data-tip': rec.text && sentence !== String(rec.text).trim() ? String(rec.text) : null }, sentence || String(rec.headline || '')),
            ev && isFinite(Number(ev.current)) ? h('div', { class: 'cl small num' }, [UI.cap(ev.label || 'Measurement', 2) + ' ', h('b', {}, num(Number(ev.current), Math.abs(Number(ev.current)) < 10 ? 1 : 0) + (ev.unit ? ' ' + ev.unit : '')), isFinite(Number(ev.threshold)) ? h('span', { class: 'dim', 'data-tip': 'Threshold' }, [' · ', icon('flag', 10), ' ' + num(ev.threshold, Math.abs(ev.threshold) < 10 ? 1 : 0)]) : null]) : null
          ]));
          if (ev && (Array.isArray(ev.series) || isFinite(Number(ev.current)))) strip.appendChild(h('div', { class: 'chart' }, UI.lineChart(ev.series || [], { threshold: ev.threshold, current: isFinite(Number(ev.current)) ? Number(ev.current) : null, color: ch.color })));
          strip.hidden = false;
        }
        recs.forEach(function (rec, i) {
          rec = rec || {}; var ch = characterFor(rec);
          var stance = rec.stance || 'support', headline = UI.cap(rec.headline || '', UI.WORD_CAPS.headline);
          var tile = h('button', { type: 'button', class: 'adv-tile', role: 'listitem', 'aria-pressed': 'false', 'data-advisor': ch.id || '', style: { '--adv': ch.color || '#4aa3df' },
            'aria-label': (ch.name || 'Advisor') + (ch.role ? ', ' + ch.role : '') + ', ' + (STANCE_LABEL[stance] || stance) + '. ' + String(rec.headline || ''), 'data-tip': (ch.role ? ch.role + ' · ' : '') + String(rec.headline || '') }, [
            UI.faceOf(ch) ? UI.portrait(UI.faceOf(ch), 64, { expression: STANCE_EXPR[stance] || 'neutral' }) : h('div', { class: 'avatar', style: { background: ch.color || '#1f6f8b' }, 'aria-hidden': 'true' }, icon(ch.avatarEmoji || 'person', 30)),
            h('div', { class: 'name' }, UI.cap(String(ch.name || 'Advisor').replace(/^(Capt\.|Dr\.|Mr\.|Ms\.)\s*/, ''), 2)),
            h('span', { class: 'chip ' + stance }, [icon(STANCE_ICON[stance] || 'dot', 11), STANCE_LABEL[stance] || stance]),
            headline ? h('div', { class: 'headline' }, headline) : null
          ]);
          tile.addEventListener('click', function () { select(i); });
          tiles.push(tile); row.appendChild(tile);
        });
        body.appendChild(row);
        body.appendChild(strip);
      },
      foot: function (foot, close) {
        foot.appendChild(h('button', { class: 'primary', type: 'button', onclick: function () { close(); } }, opts.decideLabel || 'Decide'));
      }
    });
  };

  /* ================================================================== SEASON REPORT */
  var TL_ICONS = UI.KIND_ICONS;   /* icon names: info/good/bad/warn/event/fire/flood/water/money/forest/trust/project/drought */
  function tlIcon(kind, size) { return icon(TL_ICONS[kind] || 'info', size || 14); }
  /** Timeline row text: main.js may prefix an emoji (the card icon) → row icon; nothing pictographic is left in the text. */
  function tlRow(e, brief) {
    var raw = String(typeof e === 'string' ? e : (e && e.text) || ''), kind = (e && e.kind) || 'info';
    var lead = UI.splitLeadEmoji(raw), text = UI.stripEmoji(lead.text);
    return { text: text, brief: brief ? UI.short(text, UI.WORD_CAPS.happened) : text, kind: kind, icon: lead.icon || TL_ICONS[kind] || 'info' };
  }
  /* stat value: 'check' / 'cross' render as icons */
  function statValue(v) { return (v === 'check' || v === 'cross') ? icon(v, 16) : v; }
  function stat(k, v, unit, cls) { return h('div', { class: 'stat' + (cls ? ' ' + cls : '') }, [h('span', { class: 'k' }, k), h('span', { class: 'v' }, [statValue(v), unit ? h('span', { class: 'unit' }, unit) : null])]); }
  var SEASON_ICONS = ['snowflake', 'soil', 'sun', 'leaf'];
  UI.showSeasonReport = function (report) {
    report = report || {};
    var hy = report.hydro || {}, fire = report.fire, flood = report.flood, burn = report.burnResult, oc = report.outcomes || {};
    var s = st();
    var seasonLabel = report.seasonName || seasonName(report.season != null ? report.season : s.season);
    var year = report.year != null ? report.year : s.year;
    return UI.modal({
      icon: SEASON_ICONS[fin(report.season != null ? report.season : s.season) & 3], eyebrow: 'Season report', title: seasonLabel + ', Year ' + fin(year, 1), className: 'wide report', critical: true,
      head: UI.playerBadge(28),
      render: function (body, close) {
        /* 4–6 stat tiles (water + the season's crisis) */
        var cap = fin((s.reservoir || {}).capacityAF, 42000);
        var storagePct = isFinite(Number(hy.storagePct)) ? Number(hy.storagePct) * (Number(hy.storagePct) <= 1.5 ? 100 : 1) : (fin(hy.endStorageAF) / Math.max(cap, 1) * 100);
        var sh = hy.shortages || {}, shortTotal = 0; SECTORS.forEach(function (k) { shortTotal += fin(sh[k]); });
        var tiles = [
          stat('Inflow', af(hy.inflowAF)),
          stat('Reservoir', Math.round(storagePct) + '%', null, storagePct < 35 ? 'bad' : ''),
          stat('Short', shortTotal > 1 ? af(shortTotal) : '0', null, shortTotal > 1 ? 'bad' : 'good'),
          stat('Min flow', hy.minFlowMet === false ? 'cross' : 'check', null, hy.minFlowMet === false ? 'bad' : 'good'),
          fire ? stat('Burned', Math.round(fin(fire.acres)).toLocaleString(), 'ac', 'bad') : null,
          fire && fin(fire.structuresLost) > 0 ? stat('Homes lost', Math.round(fin(fire.structuresLost)), null, 'bad') : null,
          flood ? stat('Flood', money(flood.damageM), null, fin(flood.damageM) > 0.5 ? 'bad' : '') : null,
          flood && fin(flood.sedimentToReservoir) > 0 ? stat('Sediment', Math.round(fin(flood.sedimentToReservoir)).toLocaleString(), 't', fin(flood.sedimentToReservoir) > 2000 ? 'bad' : '') : null,
          burn ? stat('Burn', burn.escaped ? 'cross' : (burn.success === false ? '—' : 'check'), null, burn.escaped ? 'bad' : 'good') : null
        ].filter(Boolean).slice(0, 6);
        var tileTips = { Reservoir: af(hy.endStorageAF) + ' in storage', Short: 'Shortages across all uses', 'Min flow': hy.minFlowMet === false ? 'Minimum flow missed' : 'Minimum flow met', Burn: burn ? (burn.escaped ? 'Prescribed burn escaped' : burn.success === false ? 'Burn called off' : 'Prescribed burn done') : '', Flood: 'Flood damage' };
        tiles.forEach(function (t) { var k = t.querySelector('.k').textContent; if (tileTips[k]) t.setAttribute('data-tip', tileTips[k]); });
        if (hy.legalOverride) tiles = tiles.slice(0, 5);   /* keep 4–6 tiles in total */
        if (hy.legalOverride) tiles.push(h('div', { class: 'stat bad', 'data-tip': 'Senior rights were under-allocated; the tribal right and Colorado River delivery were served from storage anyway. Trust took a hit.', role: 'img', 'aria-label': 'Senior rights served by override; trust fell' }, [h('span', { class: 'k' }, 'Rights'), h('span', { class: 'v' }, [icon('scales', 16), ' ', icon('cross', 14)])]));
        body.appendChild(h('div', { class: 'kv' }, tiles));

        /* what happened: ≤ 4 rows, icon + ≤ 10 words (full sentence in the tooltip) */
        var tl = safeList(report.timeline).slice(0, 4);
        if (tl.length) body.appendChild(h('ul', { class: 'timeline happened', 'aria-label': 'What happened' }, tl.map(function (e) {
          var r = tlRow(e, true);
          return h('li', { class: r.kind, 'data-tip': r.brief !== r.text ? r.text : null, 'aria-label': r.text }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, icon(r.icon, 14)), h('span', {}, r.brief)]);
        })));

        /* outcomes as delta chips: W ▲2 · E ▼5 … */
        var after = oc.after || s.outcomes || {}, before = oc.before || {}, delta = oc.delta || {};
        body.appendChild(h('div', { class: 'outcome-chips', role: 'list', 'aria-label': 'Outcome changes' }, OUT_KEYS.map(function (k) {
          var a = clamp(after[k], 0, 100), d = isFinite(Number(delta[k])) ? Number(delta[k]) : (isFinite(Number(before[k])) ? a - Number(before[k]) : 0);
          var cls = d > 0.05 ? 'up' : (d < -0.05 ? 'down' : 'flat');
          return h('span', { class: 'chip oc ' + cls, role: 'listitem', 'data-key': k, 'data-tip': (OUT_NAMES[k] || k) + ' · now ' + Math.round(a), 'aria-label': (OUT_NAMES[k] || k) + ' ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'unchanged') + ' ' + num(Math.abs(d), 1) + ', now ' + Math.round(a) }, [
            h('span', { class: 'k' }, UI.OUTCOME_SHORT[k] || k), deltaNode(d, Math.abs(d) < 1 && d !== 0 ? 1 : 0)
          ]);
        })));

        /* details (collapsed): deliveries table, fire/flood/burn detail, outcome reasons */
        var details = h('div', { class: 'report-details', id: 'report-details', hidden: true });
        var cols = h('div', { class: 'report-cols' });
        var left = h('div');
        left.appendChild(h('h3', {}, 'Deliveries'));
        var dl = hy.deliveries || {}, sp = hy.shortagePct || {};
        var rows = SECTORS.filter(function (k) { return dl[k] != null || sh[k] != null; });
        if (!rows.length) left.appendChild(h('p', { class: 'muted small' }, 'No delivery data this season.'));
        else {
          var tbl = h('table', { class: 'tbl' }, [h('thead', {}, h('tr', {}, [h('th', {}, 'Sector'), h('th', { class: 'r' }, 'Delivered'), h('th', { class: 'r' }, 'Short')]))]);
          var tb = h('tbody');
          rows.forEach(function (k) {
            var short = fin(sh[k]), spct = isFinite(Number(sp[k])) ? Number(sp[k]) * (Number(sp[k]) <= 1 ? 100 : 1) : (short > 0 && fin(dl[k]) + short > 0 ? short / (fin(dl[k]) + short) * 100 : 0);
            tb.appendChild(h('tr', { class: short > 1 ? 'short' : '' }, [
              h('td', {}, [icon(UI.SECTOR_ICONS[k] || 'dot', 12), ' ', sectorName(k)]),
              h('td', { class: 'r' }, af(dl[k])),
              h('td', { class: 'r del' }, short > 1 ? '−' + af(short) + ' (' + Math.round(spct) + '%)' : '—')
            ]));
          });
          tbl.appendChild(tb); left.appendChild(h('div', { class: 'tbl-wrap' }, tbl));
        }
        left.appendChild(h('div', { class: 'kv', style: { marginTop: '8px' } }, [
          stat('Delivered', af(hy.outflowAF)),
          hy.spillAF > 0 ? stat('Spilled', af(hy.spillAF)) : null,
          isFinite(Number(hy.cropHealthAvg)) ? stat('Crop health', Math.round(clamp(hy.cropHealthAvg, 0, 1) * 100) + '%') : null,
          isFinite(Number(hy.hydroMWh)) ? stat('Hydropower', Math.round(fin(hy.hydroMWh)).toLocaleString(), 'MWh') : null
        ]));
        if (safeList(hy.notes).length) left.appendChild(h('ul', { class: 'small muted', style: { marginTop: '8px' } }, safeList(hy.notes).map(function (n) { return h('li', {}, String(n)); })));
        cols.appendChild(left);

        var right = h('div');
        if (burn) {
          right.appendChild(h('h3', {}, 'Prescribed burn'));
          right.appendChild(h('div', { class: 'note ' + (burn.escaped ? 'bad' : 'fire') }, burn.escaped ? [icon('alert', 13), ' The prescribed burn escaped containment and became a wildfire.'] :
            (burn.success === false ? 'The burn was called off — conditions were unsafe.' : [icon('check', 13), ' Treated ' + Math.round(fin(burn.cellsTreated) * fin(C.ACRES_PER_CELL, 2.47)).toLocaleString() + ' acres; fuel ' + Math.round(fin(burn.fuelBefore) * 100) + '% → ' + Math.round(fin(burn.fuelAfter) * 100) + '%.'])));
        }
        if (fire) {
          right.appendChild(h('h3', {}, 'Wildfire'));
          right.appendChild(h('div', { class: 'kv' }, [
            stat('Burned', Math.round(fin(fire.acres)).toLocaleString(), 'acres', 'bad'),
            stat('Above reservoir', Math.round(fin(fire.upstreamAcres)).toLocaleString(), 'acres', fin(fire.upstreamAcres) > 500 ? 'bad' : ''),
            stat('Structures lost', Math.round(fin(fire.structuresLost)), null, fin(fire.structuresLost) > 0 ? 'bad' : 'good'),
            isFinite(Number(fire.severityAvg)) ? stat('Severity', Math.round(clamp(fire.severityAvg, 0, 1) * 100) + '%') : null,
            isFinite(Number(fire.smokeDays)) ? stat('Smoke days', Math.round(fin(fire.smokeDays))) : null
          ]));
          var zn = safeList(fire.zoneNames || fire.zoneIds).map(function (z) { return UI.zoneName(z); }).filter(Boolean);
          if (zn.length) right.appendChild(h('p', { class: 'small muted' }, 'Sectors touched: ' + zn.join(', ')));
          var ft = fire.tactics;
          if (ft && typeof ft === 'object' && (isFinite(Number(ft.acresSaved)) || isFinite(Number(ft.structuresSaved)))) right.appendChild(h('p', { class: 'small muted' }, 'Your response saved about ' + Math.round(fin(ft.acresSaved)).toLocaleString() + ' acres and ' + Math.round(fin(ft.structuresSaved)) + ' homes versus letting it run.'));
        }
        if (flood) {
          right.appendChild(h('h3', {}, 'Post-fire storm'));
          var cont = flood.contamination || {};
          right.appendChild(h('div', { class: 'kv' }, [
            stat('Peak at reservoir', Math.round(fin(flood.peakCfsReservoir)).toLocaleString(), 'cfs', fin(flood.peakCfsReservoir) > 800 ? 'bad' : ''),
            stat('Peak at town', Math.round(fin(flood.peakCfsTown)).toLocaleString(), 'cfs'),
            stat('Sediment to reservoir', Math.round(fin(flood.sedimentToReservoir)).toLocaleString(), 't', fin(flood.sedimentToReservoir) > 2000 ? 'bad' : ''),
            stat('Trapped by mitigations', Math.round(fin(flood.trappedTons)).toLocaleString(), 't', fin(flood.trappedTons) > 0 ? 'good' : ''),
            stat('Damage', money(flood.damageM), null, fin(flood.damageM) > 0.5 ? 'bad' : ''),
            stat('Homes flooded', Math.round(fin(flood.floodedHouses)), null, fin(flood.floodedHouses) > 0 ? 'bad' : 'good'),
            isFinite(Number(cont.outageDays)) ? stat('Treatment outage', Math.round(fin(cont.outageDays)), 'days', fin(cont.outageDays) > 0 ? 'bad' : 'good') : null,
            flood.earlyWarning ? stat('Early warning', 'Yes', null, 'good') : null
          ]));
          var cf = report.counterfactual || report.cf;
          if (cf && isFinite(Number(cf.damageM))) right.appendChild(h('p', { class: 'small muted' }, 'Without your measures: ' + money(cf.damageM) + ' damage and ' + Math.round(fin(cf.sedimentToReservoir)).toLocaleString() + ' t of sediment into the reservoir.'));
          var attrib = safeList(report.attribution || report.attrib);
          if (attrib.length) right.appendChild(h('ul', { class: 'small muted' }, attrib.map(function (a) { return h('li', {}, String(a.label || a.type || 'Measure') + ': prevented ' + money(a.preventedDamageM) + ' and ' + Math.round(fin(a.preventedSedimentTons)).toLocaleString() + ' t'); })));
        }
        if (!burn && !fire && !flood) { right.appendChild(h('h3', {}, 'Fire & flood')); right.appendChild(h('p', { class: 'muted small' }, 'No wildfire or damaging storm this season.')); }
        var reasons = safeList(oc.reasons);
        if (reasons.length) { right.appendChild(h('h3', {}, 'Why the outcomes moved')); right.appendChild(h('ul', { class: 'small muted' }, reasons.slice(0, 8).map(function (r) { return h('li', {}, [String(r.text || ''), ' ', r.delta != null ? deltaNode(r.delta, 1) : null]); }))); }
        cols.appendChild(right);
        /* the rest of the timeline (rows 5+) and the full-log link also live under Details */
        var moreTl = safeList(report.timeline).slice(4);
        if (moreTl.length) details.insertBefore(h('ul', { class: 'timeline', style: { marginBottom: '10px' } }, moreTl.map(function (e) {
          var r = tlRow(e, false);
          return h('li', { class: r.kind }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, icon(r.icon, 14)), h('span', {}, r.text)]);
        })), details.firstChild);
        details.appendChild(cols);
        var logBtn = h('button', { class: 'ghost tiny', type: 'button', 'data-tip': 'Full cause-and-effect timeline and log' }, [icon('notebook', 12), ' Timeline ', icon('chevron-right', 10)]);
        logBtn.addEventListener('click', function () { if (UI.showLog) UI.showLog(); });
        details.appendChild(h('div', { class: 'row', style: { marginTop: '10px' } }, logBtn));
        var detBtn = disclosureButton('Details', details, { id: 'report-details-btn', controls: 'report-details' });
        /* case study unlocked: one teaser button (title only) */
        var unlocked = safeList(report.unlocked);
        var teasers = unlocked.length ? h('div', { class: 'teasers' }, unlocked.map(function (id) {
          var cs = findCase(id) || {};
          var b = h('button', { class: 'teaser tiny', type: 'button', 'data-tip': 'Case study unlocked · ' + (cs.year ? cs.year + ' · ' : '') + (cs.region || 'Colorado') + ' · opens after this report', 'aria-label': 'Open case study ' + (cs.title || String(id)) + ' after this report' }, [icon('book', 12), ' ', UI.cap(cs.title || String(id), 4)]);
          b.addEventListener('click', function () { b.classList.add('queued'); b.disabled = true; b.appendChild(h('span', {}, [' ', icon('check', 11)])); call('openCaseStudy', [id]); });
          return b;
        })) : null;
        body.appendChild(h('div', { class: 'row', style: { marginTop: '10px', gap: '10px' } }, [detBtn, teasers]));
        body.appendChild(details);
      },
      foot: function (foot, close) {
        foot.appendChild(h('span', { class: 'left num', 'data-tip': 'Budget', 'aria-label': 'Budget ' + money(s.budget) }, [icon('coins', 12), ' ', money(s.budget)]));
        foot.appendChild(h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { close(); } }, ['Continue ', icon('play', 12)]));
      }
    });
  };
  /** "Details" toggle button with a chevron icon that flips; `panel` is the element it shows/hides. */
  function disclosureButton(label, panel, opts) {
    opts = opts || {};
    var chev = h('span', { class: 'caret', 'aria-hidden': 'true' }, icon('chevron-down', 11));
    var btn = h('button', { class: 'ghost tiny', type: 'button', id: opts.id || null, 'aria-expanded': 'false', 'aria-controls': opts.controls || null, style: opts.style || null }, [label + ' ', chev]);
    btn.addEventListener('click', function () { var open = panel.hidden; panel.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false'); clear(chev).appendChild(icon(open ? 'chevron-up' : 'chevron-down', 11)); });
    return btn;
  }
  function findCase(id) {
    var list = (WS.CaseStudies && WS.CaseStudies.LIST) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /* ================================================================== CASE STUDY / CASES */
  UI.showCaseStudy = function (cs) {
    cs = (typeof cs === 'string' ? findCase(cs) : cs) || {};
    return UI.modal({
      icon: 'book', eyebrow: 'Case study', title: cs.title || 'Case study', className: 'case',
      render: function (body) {
        body.appendChild(h('div', { class: 'case-meta' }, [cs.year ? h('span', { class: 'chip trust' }, String(cs.year)) : null, cs.region ? h('span', { class: 'chip' }, String(cs.region)) : null]));
        if (cs.summary) body.appendChild(h('p', { class: 'lead' }, String(cs.summary)));
        if (cs.lesson) body.appendChild(h('div', { class: 'source' }, [h('b', {}, 'Lesson'), String(cs.lesson)]));
        // linkTo may be a string or a function(state) → sentence (case studies build it from the player's own numbers)
        var linkText = '';
        try { linkText = (typeof cs.linkTo === 'function') ? cs.linkTo(game && game.state) : (cs.linkTo || ''); } catch (e) { linkText = ''; }
        if (typeof linkText !== 'string') linkText = '';
        if (linkText) {
          var pl = UI.player();
          body.appendChild(pl
            ? h('div', { class: 'case-link with-portrait' }, [UI.portrait(pl.face, 28, { title: pl.name }), h('div', {}, [h('b', {}, 'Linked to what ' + pl.name + ' just experienced'), linkText])])
            : h('div', { class: 'case-link' }, [h('b', {}, 'Linked to what you just experienced'), linkText]));
        }
        if (cs.sources) body.appendChild(h('p', { class: 'small dim', style: { marginTop: '10px' } }, String(cs.sources)));
      },
      foot: function (foot, close) { foot.appendChild(h('button', { class: 'primary', type: 'button', onclick: function () { close(); } }, 'Close')); }
    });
  };
  UI.showCases = function () {
    var list = safeList((WS.CaseStudies && WS.CaseStudies.LIST) || (UI.game && UI.game.caseStudies));
    var s = st(), unlocked = safeList(s.unlockedCases), seen = safeList(s.seenCases);
    return UI.modal({
      icon: 'book', eyebrow: 'Library', title: 'Case studies', className: 'cases',
      render: function (body, close) {
        body.appendChild(h('p', { class: 'muted' }, 'Real Colorado events that mirror what happens in this watershed. They unlock as you experience the same dynamics.'));
        if (!list.length) { body.appendChild(h('p', { class: 'muted' }, 'No case studies loaded.')); return; }
        var wrap = h('div', { class: 'case-list' });
        list.forEach(function (cs) {
          cs = cs || {}; var ok = unlocked.indexOf(cs.id) >= 0;
          var row = h('div', { class: 'case' + (ok ? '' : ' locked'), 'data-case': cs.id || '' }, [
            h('span', { class: 'yr' }, cs.year != null ? String(cs.year) : '—'),
            h('div', { class: 'grow' }, [h('div', { class: 'n' }, cs.title || String(cs.id)), h('div', { class: 's' }, ok ? (cs.region || '') : 'Unlocks when you meet the conditions this case describes.')]),
            ok ? h('div', { class: 'actions' }, h('button', { class: 'tiny', type: 'button', onclick: function () { close(); if (UI.game && typeof UI.game.openCaseStudy === 'function') call('openCaseStudy', [cs.id]); else UI.showCaseStudy(cs); } }, seen.indexOf(cs.id) >= 0 ? 'Read again' : 'Read')) : h('span', { class: 'actions dim', 'aria-hidden': 'true' }, icon('lock', 14))
          ]);
          wrap.appendChild(row);
        });
        body.appendChild(wrap);
      },
      foot: function (foot, close) { foot.appendChild(h('span', { class: 'left' }, unlocked.length + ' of ' + list.length + ' unlocked')); foot.appendChild(h('button', { class: 'primary', type: 'button', onclick: function () { close(); } }, 'Close')); }
    });
  };

  /* ================================================================== FIELD QUIZ (one case-study question after each season report) */
  /** q: { caseId, caseTitle, q, options:[3 strings], answer, why } → Promise<{ choice, correct }>. Keys 1/2/3 answer, Enter continues. */
  UI.showQuiz = function (q) {
    q = (q && typeof q === 'object') ? q : {};
    var options = safeList(q.options).slice(0, 3).map(String), answer = Math.round(fin(q.answer, 0));
    if (!options.length) return Promise.resolve({ choice: -1, correct: false });
    var LETTERS = ['A', 'B', 'C'], s = st();
    var choice = -1, buttons = [], continueBtn = null, why = null, closeFn = null, onKey = null;
    function sound(name) { try { if (WS.Sound && typeof WS.Sound.play === 'function') WS.Sound.play(name); } catch (e) { /* silent */ } }
    function result() { return { choice: choice, correct: choice === answer }; }
    function finish() { if (choice >= 0 && closeFn) closeFn(result()); }
    function pick(i) {
      if (choice >= 0 || i < 0 || i >= options.length) return;
      choice = i;
      var ok = i === answer;
      buttons.forEach(function (b, k) {
        b.disabled = true;
        if (k === answer) { b.classList.add('right'); b.setAttribute('aria-label', b.getAttribute('aria-label') + ', correct answer'); }
        else if (k === i) { b.classList.add('wrong'); b.setAttribute('aria-label', b.getAttribute('aria-label') + ', your answer, wrong'); }
      });
      if (why) {
        clear(why);
        why.appendChild(h('span', { class: 'ic', 'aria-hidden': 'true' }, icon(ok ? 'check' : 'cross', 14)));
        why.appendChild(h('span', {}, [h('b', {}, ok ? 'Right.' : 'Not quite.'), String(q.why || '')]));
        var xpv = q.xp && (ok ? q.xp.onCorrect : q.xp.onWrong);
        if (xpv && xpv.gain > 0) why.appendChild(h('span', { class: 'chip xp', 'data-tip': xpv.levelUp ? 'Level ' + xpv.level + ' · ' + xpv.title + ' · +$0.5M grant' : xpv.next + ' XP to the next level' }, [icon('star', 11), '+' + xpv.gain + ' XP' + (xpv.levelUp ? ' · Level up!' : '')]));
        why.classList.toggle('bad', !ok); why.hidden = false;
      }
      sound(ok ? 'good' : 'bad');
      if (continueBtn) { continueBtn.disabled = false; setTimeout(function () { try { continueBtn.focus(); } catch (e) { /* ignore */ } }, 0); }
    }
    return UI.modal({
      icon: 'book', eyebrow: 'Field quiz', title: 'Year ' + fin(s.year, 1) + ' · ' + seasonName(s.season), className: 'narrow quiz', critical: true,
      render: function (body, close) {
        closeFn = close;
        if (q.caseTitle) body.appendChild(h('div', { class: 'case-meta' }, h('span', { class: 'chip trust', 'data-tip': 'From the case study: ' + q.caseTitle }, [icon('book', 11), ' ', UI.cap(q.caseTitle, 5)])));
        body.appendChild(h('p', { class: 'lead quiz-q' }, String(q.q || '')));
        var list = h('div', { class: 'quiz-opts', role: 'group', 'aria-label': 'Answers: press 1, 2 or 3' });
        options.forEach(function (text, i) {
          var b = h('button', { class: 'quiz-opt', type: 'button', 'data-choice': i, 'aria-label': LETTERS[i] + '. ' + text, 'data-tip': 'Key ' + (i + 1), onclick: function () { pick(i); } },
            [h('span', { class: 'letter', 'aria-hidden': 'true' }, LETTERS[i]), h('span', { class: 'txt' }, text)]);
          buttons.push(b); list.appendChild(b);
        });
        body.appendChild(list);
        why = h('div', { class: 'quiz-why', role: 'status', 'aria-live': 'polite', hidden: true });
        body.appendChild(why);
        onKey = function (ev) {
          var tag = (ev.target && ev.target.tagName) || '';
          if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
          if (choice < 0 && /^[1-3]$/.test(ev.key)) { pick(+ev.key - 1); ev.preventDefault(); ev.stopPropagation(); }
          else if (choice >= 0 && ev.key === 'Enter') { finish(); ev.preventDefault(); ev.stopPropagation(); }
          else if (/^[1-4]$/.test(ev.key)) ev.stopPropagation();   /* keep the speed keys out of the quiz */
        };
        document.addEventListener('keydown', onKey);
      },
      foot: function (foot, close) {
        var read = h('button', { class: 'ghost', type: 'button', 'data-tip': 'Opens the case study after this quiz', 'aria-label': 'Read the case study ' + (q.caseTitle || '') + ' after this quiz',
          onclick: function () { read.disabled = true; read.classList.add('queued'); read.appendChild(h('span', {}, [' ', icon('check', 11)])); call('openCaseStudy', [q.caseId]); } }, [icon('book', 12), ' Read the case']);
        continueBtn = h('button', { class: 'primary', type: 'button', disabled: true, onclick: function () { finish(); } }, ['Continue ', icon('play', 12)]);
        foot.appendChild(h('span', { class: 'left' }, q.caseId ? read : null));
        foot.appendChild(continueBtn);
      },
      onClose: function () { if (onKey) document.removeEventListener('keydown', onKey); }
    }).then(function (v) { return (v && typeof v === 'object') ? v : result(); });
  };

  /* ================================================================== END */
  /** Field-quiz score tile: correct/total (green from 70%); best streak in the tooltip. Nothing when no question was asked. */
  function knowledgeTile(qz) {
    qz = (qz && typeof qz === 'object') ? qz : {};
    var total = Math.round(fin(qz.total)), correct = Math.round(fin(qz.correct)), best = Math.round(fin(qz.best));
    if (total <= 0) return null;
    var xp = (UI.game && typeof UI.game.getXP === 'function') ? UI.game.getXP() : null;
    var el = stat('Knowledge', correct + '/' + total + (xp ? ' · Lv ' + xp.level : ''), null, correct / total >= 0.7 ? 'good' : '');
    el.setAttribute('data-tip', 'Field quiz: ' + correct + ' of ' + total + ' correct' + (best > 1 ? ' · best streak ' + best : ''));
    el.setAttribute('aria-label', 'Field quiz: ' + correct + ' of ' + total + ' correct');
    return el;
  }
  UI.showEnd = function (summary) {
    summary = summary || {};
    var s = st();
    var R = isFinite(Number(summary.R)) ? Number(summary.R) : UI.resilienceOf(s);
    var g;
    if (summary.grade && typeof summary.grade === 'object') g = { letter: summary.grade.letter || summary.grade.grade || '—', title: summary.grade.title || summary.grade.name || '' };
    else if (typeof summary.grade === 'string') { var m = summary.grade.match(/^\s*([A-F][+-]?)\s*[—–\-:·]?\s*(.*)$/); g = m ? { letter: m[1], title: m[2] } : { letter: summary.grade, title: '' }; }
    else g = UI.gradeOf(R);
    var oc = summary.outcomes || s.outcomes || {};
    return UI.modal({
      icon: 'flag', eyebrow: 'After ' + fin(s.years, fin(summary.years, 6)) + ' years', title: 'How the watershed fared', className: 'wide end', critical: true,
      render: function (body) {
        body.appendChild(h('div', { class: 'end-score' }, [h('div', { class: 'big' }, Math.round(R)), h('div', { class: 'grade' }, [h('div', { class: 'g' }, g.letter || '—'), h('div', { class: 'title' }, g.title || 'Colorado Resilience Score')])]));
        /* difficulty: level + the score bonus it carries (also a tile below) */
        var dkey = summary.difficulty || s.difficulty || 'normal', dd = (C.DIFFICULTY && C.DIFFICULTY[dkey]) || null;
        var dbonus = isFinite(Number(summary.difficultyBonus)) ? Number(summary.difficultyBonus) : (dd ? fin(dd.scoreBonus) : 0);
        if (dd && dbonus) body.appendChild(h('div', { class: 'end-diff', 'data-tip': dd.label + ' · ' + signed(dbonus, 0) + ' added to the score (base ' + Math.round(fin(summary.baseR, R - dbonus)) + ')' }, [icon(dd.icon || 'dot', 13), ' Difficulty bonus ', h('b', { class: 'num' }, signed(dbonus, 0))]));
        body.appendChild(h('div', { class: 'end-bars' }, OUT_KEYS.map(function (k) {
          var v = clamp(oc[k], 0, 100);
          return h('div', { class: 'eb', 'data-tip': (OUT_NAMES[k] || k) + ' · weight ' + Math.round((OUT_WEIGHTS[k] || 0) * 100) + '%' }, [h('span', { class: 'label' }, UI.OUTCOME_SHORT[k] || k), h('div', { class: 'meter' }, h('i', { class: UI.OUTCOME_CLASS[k] || 'water', style: { width: v + '%' } })), h('span', { class: 'n' }, Math.round(v))]);
        })));
        var stats = summary.stats || s.stats || {}, fire = s.fire || {};
        body.appendChild(h('div', { class: 'kv', style: { marginTop: '12px' } }, [
          stat('Burned', Math.round(fin(fire.totalAcres)).toLocaleString(), 'ac'),
          stat('Homes lost', Math.round(fin(fire.structuresLost))),
          stat('Flood', money(stats.floodDamageM)),
          stat('Sediment', Math.round(fin(stats.sedimentTons)).toLocaleString(), 't'),
          stat('Outage', Math.round(fin(stats.contaminationOutageDays)), 'd'),
          stat('People', Math.round(fin(s.population)).toLocaleString()),
          dd ? h('div', { class: 'stat', id: 'end-difficulty', 'data-tip': 'Difficulty · ' + dd.label + ' — ' + dd.desc + (dbonus ? ' · bonus ' + signed(dbonus, 0) : '') }, [h('span', { class: 'k' }, 'Difficulty'), h('span', { class: 'v' }, [icon(dd.icon || 'dot', 16), ' ', dd.label, dbonus ? h('span', { class: 'unit num' }, signed(dbonus, 0)) : null])]) : null,
          knowledgeTile(summary.quiz || s.quiz)
        ]));
        /* highlights: ≤ 3 icon rows of ≤ 10 words; lessons behind Details */
        var hl = safeList(summary.highlights).slice(0, 3), ls = safeList(summary.lessons);
        if (hl.length) body.appendChild(h('ul', { class: 'timeline happened', style: { marginTop: '12px' }, 'aria-label': 'Highlights' }, hl.map(function (t) {
          var text = UI.stripEmoji(t && typeof t === 'object' ? (t.text || t.label || '') : t), brief = UI.short(text, UI.WORD_CAPS.happened);
          return h('li', { class: 'info', 'data-tip': brief !== text ? text : null, 'aria-label': text }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('star', 14)), h('span', {}, brief)]);
        })));
        if (ls.length) {
          var det = h('div', { class: 'report-details', hidden: true }, [h('h3', {}, 'Lessons'), h('ul', {}, ls.map(function (t) { return h('li', {}, UI.stripEmoji(t)); }))]);
          body.appendChild(disclosureButton('Details', det, { style: { marginTop: '10px' } })); body.appendChild(det);
        }
      },
      foot: function (foot, close) {
        foot.appendChild(h('button', { class: 'ghost', type: 'button', onclick: function () { UI.showCases(); } }, 'Case studies'));
        foot.appendChild(h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { close(); call('restart'); } }, ['Play again ', icon('refresh', 13)]));
      }
    });
  };

  /* ================================================================== AFTER-ACTION CARD (live crisis) */
  /** report: { mode:'fire'|'storm', title, headline, stats:[{label,value,bad}], actions:[string], counterfactual:{without:[{label,value}], with:[{label,value}], summary}, lessons:[string] } */
  UI.showAfterAction = function (report) {
    report = (report && typeof report === 'object') ? report : {};
    var mode = report.mode === 'storm' ? 'storm' : 'fire';
    var stats = safeList(report.stats), actions = safeList(report.actions), lessons = safeList(report.lessons);
    var cf = (report.counterfactual && typeof report.counterfactual === 'object') ? report.counterfactual : {};
    var without = safeList(cf.without), withL = safeList(cf['with']);
    /* "without / with" = two columns of numbers; the row label (≤ 2 words) sits between them */
    function cfTable() {
      var keys = [], byLabel = {};
      function add(items, side) { items.forEach(function (it) { it = (it && typeof it === 'object') ? it : { label: String(it) }; var k = String(it.label == null ? '' : it.label); if (!byLabel[k]) { byLabel[k] = {}; keys.push(k); } byLabel[k][side] = it.value == null ? '—' : String(it.value); }); }
      add(without, 'w'); add(withL, 'y');
      var t = h('div', { class: 'cf-table', role: 'table', 'aria-label': 'Without your response versus with it' }, [
        h('div', { class: 'cf-head', role: 'row' }, [h('span', { class: 'without', role: 'columnheader', 'data-tip': 'Without your response' }, [icon('cross', 11), ' Without']), h('span', { role: 'columnheader' }, ''), h('span', { class: 'with', role: 'columnheader', 'data-tip': 'With your response' }, [icon('check', 11), ' With'])])
      ]);
      keys.forEach(function (k) {
        var r = byLabel[k], lbl = UI.cap(k, 2);
        t.appendChild(h('div', { class: 'cf-row', role: 'row' }, [h('b', { class: 'num without', role: 'cell' }, r.w || '—'), h('span', { class: 'k', role: 'rowheader', 'data-tip': lbl !== k ? k : null }, lbl), h('b', { class: 'num with', role: 'cell' }, r.y || '—')]));
      });
      return t;
    }
    var sentenceFull = UI.stripEmoji(cf.summary || report.headline || ''), sentence = UI.short(sentenceFull, UI.WORD_CAPS.afterAction);
    var extra = [].concat(actions.map(function (a) { return UI.stripEmoji(a && typeof a === 'object' ? (a.text || a.label || '') : a); }), lessons.map(UI.stripEmoji)).filter(Boolean);
    return UI.modal({
      icon: mode === 'storm' ? 'wave' : 'fire', eyebrow: 'After-action', title: UI.cap(UI.stripEmoji(report.title || (mode === 'storm' ? 'Storm defense' : 'Fire response')), 5), className: 'wide afteraction ' + mode, critical: true,
      head: UI.playerBadge(28, { expression: 'worried' }),
      render: function (body) {
        /* 3 stat tiles */
        if (stats.length) body.appendChild(h('div', { class: 'kv three' }, stats.slice(0, 3).map(function (x) {
          x = (x && typeof x === 'object') ? x : { label: String(x) };
          var lbl = String(x.label == null ? '' : x.label), el = stat(UI.cap(lbl, 2), String(x.value == null ? '—' : x.value), x.unit ? String(x.unit) : null, x.bad ? 'bad' : (x.good ? 'good' : ''));
          if (UI.cap(lbl, 2) !== lbl) el.setAttribute('data-tip', lbl);
          return el;
        })));
        /* without / with numbers */
        if (without.length || withL.length) body.appendChild(cfTable());
        /* ONE sentence (≤ 14 words); what you did + lessons are the ⓘ tooltip, not a list */
        if (sentence || extra.length) body.appendChild(h('p', { class: 'cf-summary one-line', 'data-tip': sentence !== sentenceFull ? sentenceFull : null }, [
          sentence, extra.length ? h('button', { class: 'info', type: 'button', 'aria-label': 'What you did and lessons: ' + extra.join('. '), 'data-tip': extra.join(' · ') }, 'i') : null
        ]));
      },
      foot: function (foot, close) {
        foot.appendChild(h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { close(); } }, ['Continue ', icon('play', 12)]));
      }
    });
  };

  /* ================================================================== HELP */
  UI.showHelp = function () {
    return UI.modal({
      icon: 'question', eyebrow: 'Help', title: 'How to play Watershed', className: 'wide help',
      render: function (body) {
        /* tabbed: only one section is visible at a time (help is opt-in, so prose is allowed inside) */
        var sections = [
          ['season', ['calendar', 'Season'], h('ul', {}, [
            h('li', {}, [h('b', {}, 'Conditions'), ' — snowpack, storage, fire danger, drought (left). Ranges shrink once you fund streamgages.']),
            h('li', {}, [h('b', {}, 'Events'), ' — a card may interrupt with a choice; some consequences arrive later.']),
            h('li', {}, [h('b', {}, 'Plan'), ' — fund projects, allocate water, set fire policy (right). Click an advisor in town for their take.']),
            h('li', {}, [h('b', {}, 'End Season'), ' — deliveries, maybe a fire, maybe a storm on a burn scar, then a short report.']),
            h('li', {}, [h('b', {}, 'Crisis'), ' — fight fires and floods live: lines, tankers, engines, evacuations, sandbags, pumps, spillway.'])
          ])],
          ['controls', ['keyboard', 'Controls'], h('ul', {}, [
            h('li', {}, [h('kbd', {}, 'Drag'), ' pan · ', h('kbd', {}, 'Right-drag'), ' / ', h('kbd', {}, 'Ctrl-drag'), ' orbit · ', h('kbd', {}, 'Wheel'), ' zoom']),
            h('li', {}, [h('kbd', {}, 'W A S D'), ' / arrows pan · ', h('kbd', {}, 'Q'), ' ', h('kbd', {}, 'E'), ' rotate']),
            h('li', {}, [h('kbd', {}, 'Space'), ' end season · ', h('kbd', {}, '1'), '–', h('kbd', {}, '4'), ' speed · ', h('kbd', {}, 'V'), ' overlay · ', h('kbd', {}, 'Esc'), ' close']),
            h('li', {}, [h('b', {}, 'Crisis: '), h('kbd', {}, '1'), '–', h('kbd', {}, '5'), ' tool · ', h('kbd', {}, 'Drag'), ' paint · ', h('kbd', {}, 'Space'), ' pause · ', h('kbd', {}, 'Esc'), ' deselect'])
          ])],
          ['scoring', ['flag', 'Scoring'], h('div', {}, [
            h('div', { class: 'formula' }, 'Resilience = ' + OUT_KEYS.map(function (k) { return Math.round((OUT_WEIGHTS[k] || 0) * 100) + '%·' + k; }).join(' + ')),
            h('ul', { class: 'small', style: { marginTop: '8px' } }, [
              h('li', {}, 'Five outcomes, 0–100, each drifting 45% of the way toward a target each season — bad years linger.'),
              h('li', {}, 'Trust moves only through your decisions.')
            ].concat(OUT_KEYS.map(function (k) { return h('li', {}, [h('b', {}, (OUT_NAMES[k] || k) + '. '), UI.short((UI.OUTCOME_TIPS[k] || '').replace(/^[^—]+—\s*/, ''), 14)]); })))
          ])],
          ['sources', ['book', 'Sources'], h('ul', { class: 'small' },((C.SOURCES && C.SOURCES.length) ? C.SOURCES : [{ label: 'Sources', value: '', note: 'Calibrated to typical Colorado Front Range / West Slope figures.' }]).map(function (r) {
            return h('li', {}, [h('b', {}, String(r.label || '') + (r.value ? ' · ' + r.value : '') + '. '), String(r.note || '')]);
          }))],
          ['law', ['scales', 'Water law'], h('ul', { class: 'small' }, [
            h('li', {}, 'Prior appropriation: first in time, first in right.'),
            h('li', {}, 'The tribal right and the Colorado River delivery are senior — delivered even if you cut them, at a cost to trust.'),
            h('li', {}, 'Hydro, recreation and wildlife releases are non-consumptive: the water keeps flowing.')
          ])],
          ['firewater', ['fire', 'Fire & water', 'drop'], h('ul', { class: 'small' }, [
            h('li', {}, 'Burned soil sheds water: a modest storm on a fresh scar can run 10–30× the normal flow.'),
            h('li', {}, 'Ash and sediment reach the reservoir and the treatment intake.'),
            h('li', {}, 'Thinning, prescribed fire, wetlands, mulch and debris basins change that math.')
          ])]
        ];
        var current = UI.pref('helpTab') || 'season';
        if (!sections.some(function (sct) { return sct[0] === current; })) current = 'season';
        var tabs = h('div', { class: 'tabs help-tabs', role: 'tablist' }), panes = h('div', { class: 'help-panes' });
        sections.forEach(function (sct) {
          var pane = h('div', { class: 'help-pane', role: 'tabpanel', id: 'help-' + sct[0], hidden: sct[0] !== current }, sct[2]);
          var tab = h('button', { type: 'button', role: 'tab', 'data-tab': sct[0], 'aria-selected': sct[0] === current ? 'true' : 'false', 'aria-controls': 'help-' + sct[0], class: sct[0] === current ? 'active' : '' }, [icon(sct[1][0], 12), sct[1][2] ? icon(sct[1][2], 12) : null, ' ' + sct[1][1]]);
          tab.addEventListener('click', function () {
            current = sct[0]; UI.pref('helpTab', current);
            tabs.querySelectorAll('[role="tab"]').forEach(function (t) { var on = t.getAttribute('data-tab') === current; t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
            panes.querySelectorAll('.help-pane').forEach(function (p) { p.hidden = p.id !== 'help-' + current; });
          });
          tabs.appendChild(tab); panes.appendChild(pane);
        });
        body.appendChild(tabs); body.appendChild(panes);
      },
      foot: function (foot, close) { foot.appendChild(h('button', { class: 'primary', type: 'button', onclick: function () { close(); } }, 'Got it')); }
    });
  };

  /* ================================================================== LOG MODAL */
  UI.showLog = function () {
    return UI.modal({
      icon: 'notebook', eyebrow: 'Field notebook', title: 'Log & timeline', className: 'wide logm',
      render: function (body) {
        var s = st(), tl = safeList(s.timeline);
        var cols = h('div', { class: 'two-col' });
        var left = h('div', {}, h('h3', {}, 'Cause-and-effect timeline'));
        if (!tl.length) left.appendChild(h('p', { class: 'muted small' }, 'The timeline fills in as seasons are played.'));
        else tl.slice().reverse().slice(0, 24).forEach(function (t) {
          t = t || {};
          left.appendChild(h('div', { class: 'label', style: { margin: '10px 0 4px' } }, seasonName(t.season) + ' · Year ' + fin(t.year, 1)));
          left.appendChild(h('ul', { class: 'timeline' }, safeList(t.entries).map(function (e) {
            var r = tlRow(e, false);
            return h('li', { class: r.kind }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, icon(r.icon, 14)), h('span', {}, r.text)]);
          })));
        });
        var right = h('div', {}, h('h3', {}, 'Log'));
        var logBox = h('div'); UI.renderLog(logBox, 300); right.appendChild(logBox);
        cols.appendChild(left); cols.appendChild(right); body.appendChild(cols);
      },
      foot: function (foot, close) { foot.appendChild(h('button', { class: 'primary', type: 'button', onclick: function () { close(); } }, 'Close')); }
    });
  };

  /* ================================================================== FLOOD PREP TOOLBAR */
  function normalizeTools(spec) {
    var tools = spec.tools;
    var base = (WS.Flood && WS.Flood.TOOLS) || {};
    var placed = spec.placed || {}, free = spec.free || spec.freePlacements || {};
    var out = [];
    if (Array.isArray(tools)) out = tools.map(function (t) { return typeof t === 'string' ? { type: t } : (t || {}); });
    else if (tools && typeof tools === 'object') out = Object.keys(tools).map(function (k) { var t = tools[k] || {}; return Object.assign({ type: k }, t); });
    else out = Object.keys(base).map(function (k) { return { type: k }; });
    return out.map(function (t) {
      var b = base[t.type] || {};
      var type = t.type || t.id || 'tool';
      var maxN = t.max != null ? t.max : (b.max != null ? b.max : null);
      var n = fin(placed[type], fin(t.placed));
      var rem = t.remaining != null ? t.remaining : (maxN != null ? Math.max(0, maxN - n) : null);
      return { type: type, name: t.name || b.name || type.replace(/_/g, ' '), icon: t.icon || UI.TOOL_ICONS[type] || 'dot', costM: fin(t.costM, fin(b.costM)), desc: t.desc || b.desc || '', remaining: rem, placed: n, free: fin(free[type], fin(t.free)), disabled: !!t.disabled || rem === 0 };
    });
  }
  function renderPlacement(spec) {
    var E = UI.els, box = E.placement; if (!box) return;
    spec = spec || {}; clear(box);
    var storm = spec.storm || {}, prep = spec.prep || {};
    var days = spec.daysUntil != null ? spec.daysUntil : (storm.daysUntil != null ? storm.daysUntil : (spec.turnsUntil != null ? spec.turnsUntil : storm.turnsUntil));
    var inches = fin(spec.intensityIn, fin(storm.intensityIn));
    var budget = spec.emergencyBudget != null ? spec.emergencyBudget : (spec.budget != null ? spec.budget : st().emergencyFund);
    /* countdown = numbers ([storm] 3 d · 2.1 in); the sentence is the tooltip */
    var countdownFull = UI.stripEmoji(spec.countdown || ('Storm arrives in ' + (days != null ? fin(days) + ' day' + (fin(days) === 1 ? '' : 's') : 'days') + ' — ' + num(inches, 1) + ' in forecast' + (storm.durationHr ? ' over ' + Math.round(fin(storm.durationHr)) + ' h' : '')));
    var zones = safeList(prep.atRiskZones).map(function (z) { return UI.zoneName(z); }).filter(Boolean);
    box.appendChild(h('div', { class: 'countdown' }, [
      h('div', { class: 't num', 'data-tip': countdownFull, 'aria-label': countdownFull }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('storm', 16)), (days != null ? fin(days) + ' d · ' : ''), num(inches, 1) + ' in', storm.durationHr ? ' / ' + Math.round(fin(storm.durationHr)) + ' h' : '']),
      h('div', { class: 'row small num prep' }, [
        prep.scarAcres != null ? h('span', { 'data-tip': 'Burn scar, acres' }, [icon('fire', 12), ' ', Math.round(fin(prep.scarAcres)).toLocaleString()]) : null,
        prep.predictedPeakCfs != null ? h('span', { 'data-tip': 'Predicted peak flow, cfs' }, [icon('chart', 12), ' ', Math.round(fin(prep.predictedPeakCfs)).toLocaleString()]) : null,
        prep.predictedSedimentTons != null ? h('span', { 'data-tip': 'Predicted sediment, tons' }, [icon('rock', 12), ' ', Math.round(fin(prep.predictedSedimentTons)).toLocaleString()]) : null,
        zones.length ? h('span', { class: 'chips' }, zones.slice(0, 3).map(function (z) { return h('span', { class: 'chip danger tiny', 'data-tip': 'At risk · ' + z }, UI.cap(z, 2)); })) : null
      ]),
      h('div', { class: 'budget small num', 'data-tip': 'Emergency fund' + (spec.spent != null ? ' · spent ' + money(spec.spent) : ''), 'aria-label': 'Emergency fund ' + money(budget) }, [icon('coins', 12), ' ', h('b', {}, money(budget))])
    ]));
    var tools = normalizeTools(spec), selected = spec.selected != null ? spec.selected : UI._placementSelected;
    var grid = h('div', { class: 'tools', role: 'group', 'aria-label': 'Mitigation tools' });
    tools.forEach(function (t) {
      var shortName = UI.shortName(UI.TOOL_SHORT, t.type, t.name, UI.WORD_CAPS.tool);
      var b = h('button', { class: 'tool' + (t.type === selected ? ' selected' : '') + (t.free > 0 ? ' free' : ''), type: 'button', 'data-tool': t.type, 'aria-pressed': t.type === selected ? 'true' : 'false', disabled: t.disabled ? true : null,
        'data-tip': (t.name !== shortName ? t.name + ' · ' : '') + (t.desc || ''), 'aria-label': t.name + ', ' + (t.free > 0 ? t.free + ' free' : money(t.costM)) + (t.remaining != null ? ', ' + t.remaining + ' left' : '') + (t.desc ? '. ' + t.desc : '') }, [
        h('span', { class: 'ic', 'aria-hidden': 'true' }, icon(t.icon, 18)),
        h('span', { class: 'n' }, shortName),
        h('span', { class: 'c num' }, [t.free > 0 ? h('b', {}, '×' + t.free + ' free') : h('b', {}, money(t.costM)), t.remaining != null ? ' · ×' + t.remaining : (t.placed ? [' · ' + t.placed + ' ', icon('check', 10)] : null)])
      ]);
      b.addEventListener('click', function () { UI._placementSelected = t.type; call('selectPlacementTool', [t.type]); renderPlacement(Object.assign({}, spec, { selected: t.type })); });
      grid.appendChild(b);
    });
    box.appendChild(grid);
    var sel = tools.filter(function (t) { return t.type === selected; })[0];
    var hintFull = sel ? ('Click the map to place ' + sel.name.toLowerCase() + ' where allowed. ' + (sel.desc || '')) : 'Pick a tool, then click the map. Valid cells are highlighted.';
    var hint = sel ? UI.cap('Click the map to place ' + UI.shortName(UI.TOOL_SHORT, sel.type, sel.name, UI.WORD_CAPS.tool).toLowerCase(), UI.WORD_CAPS.coach) : 'Pick a tool, then click the map';
    box.appendChild(h('div', { class: 'foot' }, [
      h('div', { class: 'hint', 'data-tip': hintFull, 'aria-label': hintFull }, hint),
      h('button', { class: 'primary warn', type: 'button', id: 'brace-btn', onclick: function () { UI._finishPlacement(); } }, ['Brace ', icon('storm', 13)])
    ]));
    box.hidden = false;
  }
  /** Hide the placement toolbar without triggering game.finishPlacement (used by the game when the storm proceeds). */
  UI.endPlacement = function () {
    var r = UI._placementResolve; UI._placementResolve = null;
    var E = UI.els; if (E.placement) E.placement.hidden = true;
    UI._placementSelected = null;
    if (r) r();
  };
  UI._finishPlacement = function () {
    var r = UI._placementResolve; UI._placementResolve = null;
    var E = UI.els; if (E.placement) E.placement.hidden = true;
    UI._placementSelected = null;
    call('finishPlacement');
    if (r) r();
  };
  UI.startPlacement = function (spec) {
    if (UI._placementResolve) { var prev = UI._placementResolve; UI._placementResolve = null; prev(); }
    UI._placementSelected = (spec || {}).selected || null;
    return new Promise(function (resolve) {
      UI._placementResolve = resolve;
      renderPlacement(spec);
      UI.setPhase(PH.FLOOD_PREP || 'flood_prep', { ticker: (spec && spec.countdown) || 'Storm approaching — place emergency measures, then brace.' });
      var first = UI.els.placement && UI.els.placement.querySelector('.tool:not(:disabled)'); if (first) { try { first.focus(); } catch (e) { /* ignore */ } }
    });
  };
  UI.updatePlacement = function (spec) { if (UI.els.placement && (!UI.els.placement.hidden || UI._placementResolve)) renderPlacement(spec); };

  /* ================================================================== TUTORIAL COACH MARKS */
  UI.tutorialStep = function (text, anchorSelector) {
    var E = UI.els, coach = E.coach;
    if (!coach) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var anchor = null;
      try { anchor = anchorSelector ? document.querySelector(anchorSelector) : null; } catch (e) { anchor = null; }
      if (anchor) anchor.classList.add('coach-target');
      clear(coach);
      var arrow = h('span', { class: 'arrow top', 'aria-hidden': 'true' });
      var done = function (v) { coach.hidden = true; if (anchor) anchor.classList.remove('coach-target'); window.removeEventListener('resize', place); clear(coach); resolve(v); };
      /* ≤ 8 words on the card; the full sentence is the tooltip + aria-label */
      var full = UI.stripEmoji(text), brief = UI.short(full, UI.WORD_CAPS.coach);
      coach.appendChild(arrow);
      coach.appendChild(h('div', { class: 'eyebrow', 'aria-hidden': 'true' }, [icon('grad', 14), ' Tutorial']));
      coach.appendChild(h('div', { class: 'body', 'data-tip': brief !== full ? full : null, 'aria-label': full }, brief));
      coach.appendChild(h('div', { class: 'foot' }, [
        h('button', { type: 'button', 'aria-label': 'Skip tutorial', onclick: function () { done(false); } }, 'Skip'),
        h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { done(true); } }, ['Next ', icon('play', 12)])
      ]));
      coach.hidden = false;
      function place() {
        var vw = window.innerWidth, vh = window.innerHeight, cw = coach.offsetWidth, chh = coach.offsetHeight;
        var x, y, side = 'top';
        if (anchor) {
          var r = anchor.getBoundingClientRect();
          if (r.bottom + chh + 16 < vh) { y = r.bottom + 12; x = r.left; side = 'top'; }
          else if (r.top - chh - 16 > 0) { y = r.top - chh - 12; x = r.left; side = 'bottom'; }
          else if (r.right + cw + 16 < vw) { y = r.top; x = r.right + 12; side = 'left'; }
          else { y = r.top; x = r.left - cw - 12; side = 'right'; }
          x = Math.max(8, Math.min(vw - cw - 8, x)); y = Math.max(8, Math.min(vh - chh - 8, y));
        } else { x = (vw - cw) / 2; y = (vh - chh) / 2; side = ''; }
        coach.style.left = x + 'px'; coach.style.top = y + 'px';
        arrow.className = 'arrow ' + side; arrow.hidden = !side;
      }
      place();
      window.addEventListener('resize', place);
      setTimeout(function () { var b = coach.querySelector('button.primary'); if (b) { try { b.focus(); } catch (e) { /* ignore */ } } }, 20);
    });
  };
})();
