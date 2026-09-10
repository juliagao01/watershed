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
  var CATEGORY_NAMES = { monitor: 'Monitoring', water: 'Water supply', fire: 'Wildfire', flood: 'Flood & sediment', community: 'Community' };
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
    if (!list.length) { box.appendChild(h('p', { class: 'muted' }, 'No projects available yet.')); return; }
    var showAll = UI.pref('allProjects') === true;
    var coreIds = coreProjectIds();
    var byId = {}; list.forEach(function (it) { var id = ((it || {}).def || {}).id; if (id != null) byId[String(id)] = it; });
    var core = coreIds.map(function (id) { return byId[id]; }).filter(Boolean);
    var extra = list.length - core.length;
    if (!core.length) showAll = true;
    var toggle = h('button', { class: 'ghost tiny proj-toggle', type: 'button', id: 'projects-toggle', 'aria-expanded': showAll ? 'true' : 'false', hidden: !core.length || extra <= 0 },
      showAll ? 'Core projects only ▴' : 'Show all projects ▾ (' + extra + ' more)');
    toggle.addEventListener('click', function () { UI.pref('allProjects', !showAll); UI.renderProjects(); });
    box.appendChild(h('div', { class: 'row between', style: { marginBottom: '6px' } }, [
      h('span', { class: 'label' }, 'Budget ' + money(s.budget)),
      toggle
    ]));
    if (!showAll) {
      var g = h('div', { class: 'group core', 'data-category': 'core' }, h('div', { class: 'label' }, 'Core projects'));
      core.forEach(function (it) { g.appendChild(projectCard(it, s)); });
      box.appendChild(g);
      box.appendChild(h('p', { class: 'small dim', style: { margin: '2px 0 0' } }, 'Eight projects cover most of what the watershed needs. Reservoir, storage, shelters and outreach are under "Show all".'));
      return;
    }
    var groups = {};
    list.forEach(function (it) { var cat = ((it || {}).def || {}).category || 'community'; (groups[cat] = groups[cat] || []).push(it); });
    var cats = CATEGORY_ORDER.filter(function (c) { return groups[c]; }).concat(Object.keys(groups).filter(function (c) { return CATEGORY_ORDER.indexOf(c) < 0; }));
    cats.forEach(function (cat) {
      var g = h('div', { class: 'group', 'data-category': cat }, h('div', { class: 'label' }, CATEGORY_NAMES[cat] || cat));
      groups[cat].forEach(function (it) { g.appendChild(projectCard(it, s)); });
      box.appendChild(g);
    });
  };
  function projectCard(it, s) {
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

    var card = h('div', { class: 'card' + (funded ? ' funded' : '') + (!canFund ? ' locked' : ''), 'data-project': id });
    var pips = h('span', { class: 'pips', 'aria-label': 'Level ' + level + ' of ' + maxLevel });
    for (var i = 0; i < maxLevel; i++) pips.appendChild(h('i', { class: i < level ? 'on' : '' }));
    card.appendChild(h('div', { class: 'head' }, [
      h('div', { class: 'icon', 'aria-hidden': 'true' }, d.icon || '▪'),
      h('div', { class: 'grow' }, [
        h('div', { class: 'row between' }, [h('span', { class: 'name' }, d.name || id), h('span', { class: 'cost' }, [money(d.costM), fin(d.upkeepM) > 0 ? h('span', { class: 'up' }, ' +' + money(d.upkeepM) + '/yr') : null])]),
        h('div', { class: 'row small dim' }, [maxLevel > 1 ? pips : null, maxLevel > 1 ? 'Level ' + level + '/' + maxLevel : (funded ? 'Funded' : 'Not funded'),
          fundedTargets.length ? ' · ' + fundedTargets.map(function (t) { return t.name || UI.zoneName(t.zoneId); }).join(', ') : null])
      ])
    ]));
    if (d.summary) card.appendChild(h('div', { class: 'summary' }, d.summary));
    var detail = h('div', { class: 'detail', hidden: true }, [d.detail ? h('div', {}, d.detail) : null, d.tradeoff ? h('div', { class: 'tradeoff' }, d.tradeoff) : null]);
    card.appendChild(detail);
    var foot = h('div', { class: 'foot' });
    var select = null;
    if (zoneTargeted && targets.length) {
      select = h('select', { 'aria-label': 'Target for ' + (d.name || id) }, targets.map(function (t) {
        return h('option', { value: String(t.zoneId), selected: String(t.zoneId) === String(sel) ? true : null, disabled: t.funded ? true : null }, (t.name || UI.zoneName(t.zoneId)) + (t.funded ? ' ✓' : ''));
      }));
      select.addEventListener('change', function () { UI._targetSel[id] = select.value; call('highlightZone', [Number(select.value)]); });
      select.addEventListener('focus', function () { call('highlightZone', [Number(select.value)]); });
      foot.appendChild(select);
    }
    var btn = h('button', { class: 'primary tiny', type: 'button', disabled: !canFund ? true : null, 'data-tip': !canFund && reason ? reason : null },
      funded && !maxed ? 'Upgrade ' + money(d.costM) : 'Fund ' + money(d.costM));
    btn.addEventListener('click', function () {
      var target = select ? Number(select.value) : (targets.length ? sel : undefined);
      btn.disabled = true;
      call('fundProject', [id, target], function (r) {
        if (r && r.ok === false) UI.toast(r.reason || r.text || 'Cannot fund ' + (d.name || id), 'warn');
        else if (r && r.text) UI.toast(r.text, 'good');
        else if (r !== false) UI.toast((d.name || id) + ' funded', 'good');
        UI.refresh();
      });
    });
    foot.appendChild(btn);
    var more = h('button', { class: 'ghost tiny', type: 'button', 'aria-expanded': 'false' }, 'Details');
    more.addEventListener('click', function () { detail.hidden = !detail.hidden; more.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true'); more.textContent = detail.hidden ? 'Details' : 'Less'; });
    if (d.detail || d.tradeoff) foot.appendChild(more);
    if (reason) foot.appendChild(h('div', { class: 'reason' + (!canFund ? ' bad' : '') }, reason));
    card.appendChild(foot);
    var hoverZone = fundedTargets.length ? fundedTargets[0].zoneId : null;
    if (hoverZone != null) {
      card.addEventListener('mouseenter', function () { call('highlightZone', [Number(hoverZone)]); });
      card.addEventListener('mouseleave', function () { call('highlightZone', [null]); });
    }
    return card;
  }

  /* ================================================================== WATER */
  /* Five sliders; hydro+recreation move together as 'power_rec'. Tribal and downstream are fixed senior rows. */
  var WATER_ROWS = [
    { key: 'households', name: 'Households', sectors: ['households'], icon: '🏘', color: '#4aa3df', tip: 'Indoor and outdoor use for every home. Restrictions trim this demand.' },
    { key: 'farms', name: 'Farms & Ranches', sectors: ['farms'], icon: '🌾', color: '#d4a24c', tip: 'Irrigation for hay, pasture and orchards. Short deliveries cut crop health and the farm economy.' },
    { key: 'wildlife', name: 'River & Wildlife', sectors: ['wildlife'], icon: '🦌', color: '#6fbf73', nonc: true, tip: 'Instream flow below the dam keeps fish, the riparian corridor and elk habitat alive. Non-consumptive: the water keeps flowing downstream.' },
    { key: 'power_rec', name: 'Power & Recreation', sectors: ['hydro', 'recreation'], readKey: 'hydro', icon: '⚡', color: '#a78bfa', nonc: true, tip: 'Hydropower releases and rafting/boating flows, moved together. Non-consumptive: the water returns to the river.' },
    { key: 'fire', name: 'Fire Reserve', sectors: ['fire'], icon: '🚒', color: '#ff7a33', tip: 'Storage held back for firefighting and treatment-plant flushing. Cutting it saves water now and hurts when a fire comes.' }
  ];
  var SENIOR_ROWS = [
    { key: 'tribal', name: 'Tribal Water Right', icon: '🪶', color: '#e9c46a', tip: 'Senior water right. Tribal reserved rights date to reservation creation (Winters doctrine, 1908) and are legally senior to most others in the basin. Always delivered.' },
    { key: 'downstream', name: 'Colorado River Delivery', icon: '🏞', color: '#7dd3c0', tip: 'Legally senior: the 1922 Colorado River Compact obliges the Upper Basin to deliver water downstream. Always delivered.' }
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

    /* stacked bar: requested (allocated) by row vs available */
    var scale = Math.max(available, totalAlloc, 1);
    var bar = h('div', { class: 'stackbar', role: 'img', 'aria-label': 'Requested ' + af(totalAlloc) + ' of ' + af(available) + ' available' });
    all.forEach(function (r) {
      var v = r.req * r.a;
      if (v > 0) bar.appendChild(h('i', { style: { width: (v / scale * 100) + '%', background: r.def.color }, 'data-tip': r.def.name + ' ' + af(v) }));
    });
    bar.appendChild(h('span', { class: 'avail', style: { left: clamp(available / scale * 100, 0, 100) + '%' }, 'data-tip': 'Available this season: ' + af(available) }));
    var over = totalAlloc > available;
    box.appendChild(h('div', { style: { marginBottom: '8px' } }, [
      h('div', { class: 'row between' }, [h('span', { class: 'label' }, 'Available vs requested'), UI.info('Available = this season\'s inflow plus storage above dead pool. Requested = each use\'s need × your allocation. If requests exceed availability, lower-priority uses go short.')]),
      h('div', { class: 'row between small', style: { margin: '4px 0' } }, [h('span', {}, ['Available ', h('b', { class: 'num' }, af(available))]), h('span', { style: { color: over ? '#ffb3ba' : '' } }, ['Requested ', h('b', { class: 'num' }, af(totalAlloc)), over ? ' ⚠ over' : ''])]),
      bar,
      h('div', { class: 'legend-dots' }, all.map(function (r) { return h('span', { style: { '--c': r.def.color } }, r.def.name.split(' ')[0]); }))
    ]));
    box.appendChild(h('div', { class: 'small dim', style: { margin: '0 0 6px' } }, 'Inflow ' + af(w.inflowAF) + ' · storage ' + af((s.reservoir || {}).storageAF) + ' · ' + (fin((s.climate || {}).uncertainty, 0.15) > 0.1 ? 'estimates ±' + Math.round(fin((s.climate || {}).uncertainty, 0.15) * 100) + '%' : 'gauged')));

    /* restriction */
    var restr = h('select', { id: 'restriction-select', 'aria-label': 'Water restriction level' }, [['none', 'No restrictions'], ['voluntary', 'Voluntary conservation'], ['stage1', 'Stage 1 — watering 2 days/week'], ['stage2', 'Stage 2 — outdoor watering ban']].map(function (o) {
      return h('option', { value: o[0], selected: (w.restriction || 'none') === o[0] ? true : null }, o[1]);
    }));
    restr.addEventListener('change', function () { call('setRestriction', [restr.value], function () { UI.refresh(); }); });
    box.appendChild(h('div', { class: 'row', style: { marginBottom: '6px' } }, [h('span', { class: 'label', style: { flex: '0 0 auto' } }, 'Restrictions'), UI.info('Restrictions cut household demand (voluntary ≈ 5–10%, Stage 1 ≈ 15–20%, Stage 2 ≈ 30%+) at a cost to trust and lawns. Front Range cities used staged restrictions in 2002 and 2013.'), restr]));
    box.appendChild(h('hr', { class: 'rule' }));

    /* sliders */
    rows.forEach(function (r) {
      var d = r.def, req = r.req, a = r.a, est = req * a;
      var row = h('div', { class: 'sector', 'data-sector': d.key });
      var tags = [];
      if (d.nonc) tags.push(h('span', { class: 'chip nonc', 'data-tip': 'Non-consumptive: water released for this use keeps flowing downstream, so it also helps meet the downstream delivery and minimum-flow needs.' }, 'non-consumptive'));
      var pctEl = h('span', { class: 'pct num' }, Math.round(a * 100) + '%');
      row.appendChild(h('div', { class: 't' }, [h('span', { 'aria-hidden': 'true' }, d.icon), h('span', { class: 'name' }, d.name), UI.info(d.tip)].concat(tags).concat([pctEl])));
      var slider = h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round(a * 100), 'aria-label': 'Allocation for ' + d.name });
      var delEl = h('span', { class: 'del' }, 'deliver ≈ ' + af(est));
      slider.addEventListener('input', function () {
        var v = clamp(Number(slider.value), 0, 100);
        pctEl.textContent = v + '%'; delEl.textContent = 'deliver ≈ ' + af(req * v / 100);
        row.classList.toggle('short', v < 100);
      });
      slider.addEventListener('change', function () { call('setAllocation', [d.key, clamp(Number(slider.value), 0, 100) / 100]); });
      row.appendChild(slider);
      row.appendChild(h('div', { class: 'nums' }, [h('span', {}, 'request ' + af(req)), delEl, r.last != null ? h('span', { 'data-tip': 'Delivered last season' }, 'last ' + af(r.last)) : null]));
      if (a < 0.999) row.classList.add('short');
      box.appendChild(row);
    });
    /* fixed senior rows */
    seniors.forEach(function (r) {
      var d = r.def;
      var row = h('div', { class: 'sector senior', 'data-sector': d.key }, [
        h('div', { class: 't' }, [h('span', { 'aria-hidden': 'true' }, d.icon), h('span', { class: 'name' }, d.name), h('span', { class: 'chip senior', 'data-tip': d.tip }, 'senior right — always delivered')]),
        h('div', { class: 'nums' }, [h('span', {}, 'request ' + af(r.req)), h('span', { class: 'del' }, 'delivered in full'), r.last != null ? h('span', { 'data-tip': 'Delivered last season' }, 'last ' + af(r.last)) : null])
      ]);
      box.appendChild(row);
    });
    box.appendChild(h('div', { class: 'note' }, 'Deliveries are resolved in priority order when the season runs: households, then the senior tribal and downstream rights, then farms, river & wildlife, fire reserve, power & recreation. Non-consumptive releases return to the river.'));
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

    /* policy */
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Fire policy' }, [
      h('button', { type: 'button', class: policy === 'managed' ? 'active' : '', 'aria-pressed': policy === 'managed', onclick: function () { call('setFirePolicy', ['managed'], function () { UI.refresh(); }); } }, 'Managed fire'),
      h('button', { type: 'button', class: policy === 'suppress_all' ? 'active' : '', 'aria-pressed': policy === 'suppress_all', onclick: function () { call('setFirePolicy', ['suppress_all'], function () { UI.refresh(); }); } }, 'Suppress all')
    ]);
    box.appendChild(h('div', { class: 'row between', style: { marginBottom: '6px' } }, [h('span', { class: 'label' }, 'Policy'), seg]));
    box.appendChild(h('div', { class: 'note fire' }, [
      h('b', {}, 'The fire paradox. '),
      'Putting out every small fire lets needles, deadfall and dense young trees pile up. Colorado\'s ponderosa and mixed-conifer forests historically burned every 10–30 years at low intensity; a century of suppression built the fuel loads that fed the 2020 Cameron Peak and East Troublesome fires. ',
      policy === 'suppress_all' ? h('span', { style: { color: '#ffd3bd' } }, 'Suppress-all: fewer small fires now, fuel accumulates ~60% faster, and the eventual fire burns hotter.') : h('span', { style: { color: '#d1f0d3' } }, 'Managed: some low-intensity fire is allowed to burn under watch, keeping fuel loads down — with some smoke and risk.')
    ]));

    /* sector table */
    var zones = zoneList('forest');
    if (!zones.length) { box.appendChild(h('p', { class: 'muted' }, 'Forest sectors will appear once the world is loaded.')); return; }
    var list = h('div', { id: 'fuel-table', role: 'list' });
    zones.forEach(function (z) {
      z = z || {};
      var fuel = zoneFuel(z), fpct = isFinite(fuel) ? Math.round(clamp(fuel, 0, 1) * 100) : null;
      var status = [];
      var tstr = thinned[z.id];
      if (tstr) status.push(h('span', { class: 'chip forest', 'data-tip': 'Mechanical thinning in effect; the benefit fades ~12%/yr as the stand regrows.' }, 'thinned ' + Math.round(clamp(typeof tstr === 'number' ? tstr : 1, 0, 1) * 100) + '%'));
      if (breaks[z.id]) status.push(h('span', { class: 'chip forest' }, 'fuel break'));
      if (String(pending) === String(z.id)) status.push(h('span', { class: 'chip fire' }, 'burn scheduled'));
      if (z.upstreamOfReservoir) status.push(h('span', { class: 'chip upstream', 'data-tip': 'Drains into the reservoir: a severe burn here sends ash and sediment into the water supply after the next big storm.' }, 'upstream'));
      var burnedPct = zoneBurnedPct(z);
      if (burnedPct > 5) status.push(h('span', { class: 'chip danger', 'data-tip': 'Share of this sector already burned' }, 'burned ' + burnedPct + '%'));
      var isPending = String(pending) === String(z.id);
      var canSchedule = burnSeason && pending == null && s.phase !== 'live';
      var tip = isPending ? 'Cancel the scheduled burn' : (!burnSeason ? 'Prescribed burns are only carried out in Spring or Fall, when fuels are damp enough to control.' : (pending != null ? 'One burn per season' : 'Burn under controlled conditions to reduce fuel ~60% in this sector. ~4% escape risk, higher in high fire danger.'));
      var btn = h('button', { class: 'tiny act' + (isPending ? ' active' : ''), type: 'button', disabled: (!isPending && !canSchedule) ? true : null, 'data-tip': tip, 'aria-label': (isPending ? 'Cancel prescribed burn in ' : 'Schedule prescribed burn in ') + (z.name || 'zone') }, isPending ? 'Cancel burn' : 'Schedule burn');
      btn.addEventListener('click', function () {
        if (isPending) call('cancelBurn', [], function () { UI.toast('Prescribed burn cancelled', 'info'); UI.refresh(); });
        else call('scheduleBurn', [z.id], function (r) { if (r && r.ok === false) UI.toast(r.reason || r.text || 'Could not schedule burn', 'warn'); else UI.toast('Prescribed burn scheduled in ' + (z.name || 'sector') + (r && r.text ? ' — ' + r.text : ''), 'good'); UI.refresh(); });
      });
      var row = h('div', { class: 'fz', role: 'listitem', 'data-zone': z.id }, [
        h('button', { class: 'name', type: 'button', 'data-tip': 'Fly to ' + (z.name || 'sector'), onclick: function () { call('focusZone', [z.id]); call('highlightZone', [z.id]); } }, z.name || ('Sector ' + z.id)),
        h('div', { class: 'fuel', 'aria-label': 'Fuel load' }, [fpct == null ? '—' : fpct + '%', h('div', { class: 'meter thin' }, h('i', { class: fpct > 70 ? 'danger' : (fpct > 55 ? 'fire' : 'forest'), style: { width: (fpct || 0) + '%' } }))]),
        h('div', { class: 'chips' }, status.length ? status : h('span', { class: 'small dim' }, 'untreated')),
        btn
      ]);
      row.addEventListener('mouseenter', function () { call('highlightZone', [z.id]); });
      row.addEventListener('mouseleave', function () { call('highlightZone', [null]); });
      list.appendChild(row);
    });
    box.appendChild(h('div', { class: 'row between', style: { margin: '10px 0 2px' } }, [h('span', { class: 'label' }, 'Forest sectors · fuel load'), h('span', { class: 'small dim' }, burnSeason ? 'Burn window open' : 'Burns: Spring & Fall only')]));
    box.appendChild(list);
    var fires = safeList(f.fires);
    box.appendChild(h('div', { class: 'small dim', style: { marginTop: '8px' } }, 'Burned so far: ' + Math.round(fin(f.totalAcres)).toLocaleString() + ' acres in ' + fires.length + ' fire' + (fires.length === 1 ? '' : 's') + ' · structures lost ' + Math.round(fin(f.structuresLost))));
  };
  function zoneBurnedPct(z) {
    var w = wd(), cells = z.cells, burn = w.burn;
    if (!cells || !burn || !cells.length) return 0;
    var n = 0; for (var i = 0; i < cells.length; i++) if (burn[cells[i]] > 0.2) n++;
    return Math.round(n / cells.length * 100);
  }

  /* ================================================================== INTRO */
  UI.showIntro = function () {
    return UI.modal({
      className: 'intro wide', critical: true,
      render: function (body, close) {
        body.appendChild(h('div', { class: 'intro-hero' }, [
          h('span', { html: UI.BRAND_SVG }),
          h('div', { class: 'wordmark' }, 'WATERSHED'),
          h('div', { class: 'tag' }, 'A Colorado water-resilience simulation')
        ]));
        body.appendChild(h('div', { class: 'intro-narrative' }, [
          h('p', {}, ['Colorado\'s most destructive fires revealed that ', h('b', {}, 'wildfire and water conservation are not separate challenges'), '. When the 2020 Cameron Peak and East Troublesome fires burned the forests above Front Range reservoirs, the next summer\'s storms sent ash, mud and debris straight into the water supply — years after the flames were out.']),
          h('p', {}, ['You manage the Bitterbrush Creek watershed: a snow-fed tributary of the Colorado River, a reservoir, a mountain town, four farms, forests that have not burned in a century, and neighbours with senior water rights. Each season you will fund projects, allocate a shrinking supply, decide how to live with fire — and then watch what the watershed does with your choices.']),
          h('p', { class: 'live-line' }, [h('span', { 'aria-hidden': 'true' }, '🔥 '), h('b', {}, 'When a fire or flood hits, you fight it live.')]),
          h('p', { class: 'small dim' }, 'No decision is free. The advisors disagree for good reasons. The score rewards resilience, not perfection.')
        ]));
        var years = 6, mode = 'simulated', tutorial = true;
        var yearsOpt = h('div', { class: 'opt' }, [h('span', { class: 'k' }, 'Game length')].concat([4, 6, 8].map(function (y) {
          return h('label', {}, [h('input', { type: 'radio', name: 'ws-years', value: y, checked: y === years ? true : null, onchange: function () { years = y; } }), y + ' years', h('span', { class: 'hint' }, y === 4 ? '· quick' : y === 8 ? '· full arc' : '· recommended')]);
        })));
        var modeOpt = h('div', { class: 'opt' }, [h('span', { class: 'k' }, 'Climate'),
          h('label', {}, [h('input', { type: 'radio', name: 'ws-mode', value: 'simulated', checked: true, onchange: function () { mode = 'simulated'; } }), 'Simulated', h('span', { class: 'hint' }, '· seeded, varies by seed')]),
          h('label', {}, [h('input', { type: 'radio', name: 'ws-mode', value: 'historical', onchange: function () { mode = 'historical'; } }), 'Historical', h('span', { class: 'hint' }, '· approximate Colorado snowpack sequence')])
        ]);
        var seedInput = h('input', { type: 'text', id: 'intro-seed', value: String(Math.floor(Math.random() * 90000) + 10000), 'aria-label': 'Seed', maxlength: 24 });
        var seedOpt = h('div', { class: 'opt' }, [h('span', { class: 'k' }, 'Seed'), h('div', { class: 'seed' }, [seedInput, h('button', { type: 'button', 'aria-label': 'Random seed', onclick: function () { seedInput.value = String(Math.floor(Math.random() * 90000) + 10000); } }, '🎲')]), h('div', { class: 'hint small dim', style: { marginTop: '4px' } }, 'Same seed, same world and weather.')]);
        var tutOpt = h('div', { class: 'opt' }, [h('span', { class: 'k' }, 'Guidance'), h('label', {}, [h('input', { type: 'checkbox', id: 'intro-tutorial', checked: true, onchange: function (e) { tutorial = !!e.target.checked; } }), 'Show tutorial hints']),
          h('div', { class: 'hint small dim' }, 'Coach marks on the first turn. Skippable.')]);
        body.appendChild(h('div', { class: 'opts' }, [yearsOpt, modeOpt, seedOpt, tutOpt]));
        body.appendChild(h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '16px' } }, h('button', { class: 'primary big', type: 'button', id: 'intro-begin', autofocus: true, onclick: function () {
          var raw = (seedInput.value || '').trim(); var seed = /^-?\d+$/.test(raw) ? parseInt(raw, 10) : (raw || String(Date.now()));
          close({ years: years, mode: mode, seed: seed, tutorial: tutorial });
        } }, 'Begin ▶')));
      }
    });
  };

  /* ================================================================== EVENT CARD */
  UI.showEventCard = function (card) {
    card = card || {};
    var s = st();
    var sev = card.severity || 'info';
    return UI.modal({
      icon: card.icon || '⚡', eyebrow: 'Event · ' + seasonName(s.season) + ', Year ' + fin(s.year, 1), title: card.title || 'Something happens', critical: true, className: 'event',
      render: function (body, close) {
        body.appendChild(h('div', { class: 'severity-row' }, [h('span', { class: 'chip ' + sev }, sev === 'crisis' ? 'Crisis' : sev === 'warn' ? 'Warning' : 'Notice'), card.once ? h('span', { class: 'small dim' }, 'one-time event') : null]));
        if (card.text) body.appendChild(h('p', { class: 'lead' }, String(card.text)));
        if (card.source) body.appendChild(h('div', { class: 'source' }, [h('b', {}, 'Why this happens in Colorado'), String(card.source)]));
        var choices = safeList(card.choices);
        if (!choices.length) choices = [{ label: 'Acknowledge', desc: '' }];
        var affordable = choices.map(function (ch) { return !(fin(ch.costM) > fin(s.budget) + fin(s.emergencyFund) + 1e-9); });
        var anyAffordable = affordable.some(Boolean);
        var list = h('div', { class: 'event-choices', role: 'group', 'aria-label': 'Choices' });
        choices.forEach(function (ch, i) {
          ch = ch || {};
          var canPick = affordable[i] || !anyAffordable;
          var eff = [];
          if (ch.delta && typeof ch.delta === 'object') OUT_KEYS.forEach(function (k) { if (isFinite(Number(ch.delta[k])) && Number(ch.delta[k]) !== 0) eff.push(h('span', {}, [k + ' ', deltaNode(ch.delta[k])])); });
          if (ch.preview) eff.push(h('span', {}, String(ch.preview)));
          var b = h('button', { class: 'choice', type: 'button', disabled: canPick ? null : true, 'data-choice': i, onclick: function () { close(i); } }, [
            h('div', { class: 'l' }, [h('span', { class: 'lbl' }, ch.label || ('Option ' + (i + 1))), h('span', { class: 'cost ' + (fin(ch.costM) > 0 ? '' : 'free') }, fin(ch.costM) > 0 ? money(ch.costM) : 'no cost')]),
            ch.desc ? h('div', { class: 'd' }, String(ch.desc)) : null,
            eff.length ? h('div', { class: 'eff' }, eff) : null,
            !canPick ? h('div', { class: 'noafford' }, 'Not enough budget (' + money(fin(s.budget) + fin(s.emergencyFund)) + ' available)') : null
          ]);
          list.appendChild(b);
        });
        body.appendChild(list);
        if (!anyAffordable) body.appendChild(h('p', { class: 'small dim', style: { marginTop: '8px' } }, 'Budget is exhausted; paid options will run the budget negative.'));
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
    return { id: rec.characterId, name: rec.name || rec.characterId || 'Advisor', role: rec.role || '', color: rec.color || '#4aa3df', avatarEmoji: rec.avatarEmoji || '🧑' };
  }
  var STANCE_LABEL = { urge: 'Urges action', support: 'Supports', caution: 'Cautions', oppose: 'Opposes' };
  UI.showEvidenceBoard = function (topic, recs, opts) {
    opts = opts || {}; recs = safeList(recs);
    var topicName = (UI.EVIDENCE_TOPICS.filter(function (t) { return t[0] === topic; })[0] || [topic, String(topic || 'Decision')])[1];
    return UI.modal({
      icon: '📊', eyebrow: 'Evidence board', title: opts.title || topicName, className: 'wide evidence',
      render: function (body) {
        body.appendChild(h('p', { class: 'lead' }, opts.intro || 'Your advisors read the same numbers and reach different conclusions. Each has a legitimate priority; none has the whole picture.'));
        if (!recs.length) { body.appendChild(h('p', { class: 'muted' }, 'No advisor has weighed in on this yet.')); return; }
        var grid = h('div', { class: 'advisors' });
        recs.forEach(function (rec) {
          rec = rec || {}; var ch = characterFor(rec), ev = rec.evidence || null;
          var card = h('div', { class: 'advisor', 'data-advisor': ch.id || '' }, [
            h('div', { class: 'who' }, [
              h('div', { class: 'avatar', style: { background: ch.color || '#4aa3df' }, 'aria-hidden': 'true' }, ch.avatarEmoji || '🧑'),
              h('div', { class: 'grow' }, [h('div', { class: 'name' }, ch.name || 'Advisor'), h('div', { class: 'role' }, ch.role || '')]),
              h('span', { class: 'chip ' + (rec.stance || 'support') }, STANCE_LABEL[rec.stance] || rec.stance || 'says')
            ]),
            rec.headline ? h('div', { class: 'headline' }, String(rec.headline)) : null,
            rec.text ? h('div', { class: 'text' }, String(rec.text)) : null
          ]);
          if (ev && (Array.isArray(ev.series) || isFinite(Number(ev.current)))) {
            var cur = isFinite(Number(ev.current)) ? Number(ev.current) : null;
            card.appendChild(h('div', { class: 'chart' }, [
              h('div', { class: 'cl' }, [h('span', {}, (ev.label || 'Measurement') + (ev.unit ? ' (' + ev.unit + ')' : '')), h('b', {}, cur == null ? '' : 'now ' + num(cur, Math.abs(cur) < 10 ? 1 : 0) + (isFinite(Number(ev.threshold)) ? ' · limit ' + num(ev.threshold, Math.abs(ev.threshold) < 10 ? 1 : 0) : ''))]),
              UI.lineChart(ev.series || [], { threshold: ev.threshold, current: cur })
            ]));
          }
          grid.appendChild(card);
        });
        body.appendChild(grid);
      },
      foot: function (foot, close) {
        foot.appendChild(h('span', { class: 'left' }, recs.length + ' advisor' + (recs.length === 1 ? '' : 's')));
        foot.appendChild(h('button', { class: 'primary', type: 'button', onclick: function () { close(); } }, opts.decideLabel || 'Decide'));
      }
    });
  };

  /* ================================================================== SEASON REPORT */
  var TL_ICONS = { info: 'ℹ', good: '✔', bad: '✖', warn: '⚠', event: '⚡', fire: '🔥', flood: '🌊', water: '💧', money: '💵', forest: '🌲', trust: '🤝', project: '🛠', drought: '☀' };
  function stat(k, v, unit, cls) { return h('div', { class: 'stat' + (cls ? ' ' + cls : '') }, [h('span', { class: 'k' }, k), h('span', { class: 'v' }, [v, unit ? h('span', { class: 'unit' }, unit) : null])]); }
  UI.showSeasonReport = function (report) {
    report = report || {};
    var hy = report.hydro || {}, fire = report.fire, flood = report.flood, burn = report.burnResult, oc = report.outcomes || {};
    var s = st();
    var seasonLabel = report.seasonName || seasonName(report.season != null ? report.season : s.season);
    var year = report.year != null ? report.year : s.year;
    return UI.modal({
      icon: ['❄', '🌱', '☀', '🍂'][fin(report.season != null ? report.season : s.season) & 3], eyebrow: 'Season report', title: seasonLabel + ', Year ' + fin(year, 1), className: 'wide report', critical: true,
      render: function (body, close) {
        /* headline stat tiles (water + any crisis) */
        var cap = fin((s.reservoir || {}).capacityAF, 42000);
        var storagePct = isFinite(Number(hy.storagePct)) ? Number(hy.storagePct) * (Number(hy.storagePct) <= 1.5 ? 100 : 1) : (fin(hy.endStorageAF) / Math.max(cap, 1) * 100);
        var sh = hy.shortages || {}, shortTotal = 0; SECTORS.forEach(function (k) { shortTotal += fin(sh[k]); });
        body.appendChild(h('div', { class: 'kv' }, [
          stat('Inflow', af(hy.inflowAF)),
          stat('Reservoir', af(hy.endStorageAF), Math.round(storagePct) + '%', storagePct < 35 ? 'bad' : ''),
          stat('Shortages', shortTotal > 1 ? af(shortTotal) : 'None', null, shortTotal > 1 ? 'bad' : 'good'),
          stat('Min. flow', hy.minFlowMet === false ? 'Missed' : 'Met', null, hy.minFlowMet === false ? 'bad' : 'good'),
          fire ? stat('Wildfire', Math.round(fin(fire.acres)).toLocaleString(), 'acres', 'bad') : null,
          fire && fin(fire.structuresLost) > 0 ? stat('Homes lost', Math.round(fin(fire.structuresLost)), null, 'bad') : null,
          flood ? stat('Flood damage', money(flood.damageM), null, fin(flood.damageM) > 0.5 ? 'bad' : '') : null,
          flood && fin(flood.sedimentToReservoir) > 0 ? stat('Sediment in', Math.round(fin(flood.sedimentToReservoir)).toLocaleString(), 't', fin(flood.sedimentToReservoir) > 2000 ? 'bad' : '') : null,
          burn ? stat('Prescribed burn', burn.escaped ? 'Escaped' : (burn.success === false ? 'Called off' : 'Done'), null, burn.escaped ? 'bad' : 'good') : null
        ]));
        if (hy.legalOverride) body.appendChild(h('div', { class: 'note bad' }, '⚖ Senior rights were under-allocated — the tribal right and Colorado River delivery were served from storage anyway. Trust took a hit.'));

        /* cause and effect first */
        body.appendChild(h('h3', {}, 'Cause and effect'));
        var tl = safeList(report.timeline);
        if (!tl.length) body.appendChild(h('p', { class: 'muted small' }, 'A quiet season. Nothing to explain — yet.'));
        else body.appendChild(h('ul', { class: 'timeline' }, tl.map(function (e) {
          var text = typeof e === 'string' ? e : (e && e.text) || ''; var kind = (e && e.kind) || 'info';
          return h('li', { class: kind }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, TL_ICONS[kind] || 'ℹ'), h('span', {}, String(text))]);
        })));

        /* outcomes */
        body.appendChild(h('h3', {}, 'Outcomes'));
        var after = oc.after || s.outcomes || {}, before = oc.before || {}, delta = oc.delta || {};
        body.appendChild(h('div', { class: 'outcome-deltas' }, OUT_KEYS.map(function (k) {
          var a = clamp(after[k], 0, 100), d = isFinite(Number(delta[k])) ? Number(delta[k]) : (isFinite(Number(before[k])) ? a - Number(before[k]) : 0);
          return h('div', { class: 'od', 'data-key': k }, [h('span', { class: 'k' }, OUT_NAMES[k] || k), h('div', { class: 'n' }, Math.round(a)), deltaNode(d, 1), h('div', { class: 'meter thin' }, h('i', { class: UI.OUTCOME_CLASS[k] || 'water', style: { width: a + '%' } }))]);
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
              h('td', {}, [h('span', { 'aria-hidden': 'true' }, (UI.SECTOR_ICONS[k] || '') + ' '), sectorName(k)]),
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
          right.appendChild(h('div', { class: 'note ' + (burn.escaped ? 'bad' : 'fire') }, burn.escaped ? '⚠ The prescribed burn escaped containment and became a wildfire.' :
            (burn.success === false ? 'The burn was called off — conditions were unsafe.' : '✔ Treated ' + Math.round(fin(burn.cellsTreated) * fin(C.ACRES_PER_CELL, 2.47)).toLocaleString() + ' acres; fuel ' + Math.round(fin(burn.fuelBefore) * 100) + '% → ' + Math.round(fin(burn.fuelAfter) * 100) + '%.')));
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
        details.appendChild(cols);
        var detBtn = h('button', { class: 'ghost tiny', type: 'button', id: 'report-details-btn', 'aria-expanded': 'false', 'aria-controls': 'report-details', style: { marginTop: '10px' } }, 'Details ▾ (deliveries, fire & flood, outcome reasons)');
        detBtn.addEventListener('click', function () { var open = details.hidden; details.hidden = !open; detBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); detBtn.textContent = open ? 'Hide details ▴' : 'Details ▾ (deliveries, fire & flood, outcome reasons)'; });
        body.appendChild(detBtn);
        body.appendChild(details);

        /* case studies */
        var unlocked = safeList(report.unlocked);
        if (unlocked.length) {
          body.appendChild(h('h3', {}, 'Case study unlocked'));
          body.appendChild(h('div', { class: 'teasers' }, unlocked.map(function (id) {
            var cs = findCase(id) || {};
            var b = h('button', { class: 'teaser', type: 'button' }, [h('span', { class: 'n' }, '📚 ' + (cs.title || String(id))), h('span', { class: 's' }, [cs.year ? cs.year + ' · ' : '', cs.region || 'Colorado', ' — opens after this report'])]);
            b.addEventListener('click', function () { b.classList.add('queued'); b.disabled = true; b.querySelector('.s').textContent = 'Queued ✓'; call('openCaseStudy', [id]); });
            return b;
          })));
        }
      },
      foot: function (foot, close) {
        foot.appendChild(h('span', { class: 'left' }, 'Budget ' + money(s.budget)));
        foot.appendChild(h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { close(); } }, 'Continue ▶'));
      }
    });
  };
  function findCase(id) {
    var list = (WS.CaseStudies && WS.CaseStudies.LIST) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /* ================================================================== CASE STUDY / CASES */
  UI.showCaseStudy = function (cs) {
    cs = (typeof cs === 'string' ? findCase(cs) : cs) || {};
    return UI.modal({
      icon: '📚', eyebrow: 'Case study', title: cs.title || 'Case study', className: 'case',
      render: function (body) {
        body.appendChild(h('div', { class: 'case-meta' }, [cs.year ? h('span', { class: 'chip trust' }, String(cs.year)) : null, cs.region ? h('span', { class: 'chip' }, String(cs.region)) : null]));
        if (cs.summary) body.appendChild(h('p', { class: 'lead' }, String(cs.summary)));
        if (cs.lesson) body.appendChild(h('div', { class: 'source' }, [h('b', {}, 'Lesson'), String(cs.lesson)]));
        if (cs.linkTo) body.appendChild(h('div', { class: 'case-link' }, [h('b', {}, 'Linked to what you just experienced'), String(cs.linkTo)]));
        if (cs.sources) body.appendChild(h('p', { class: 'small dim', style: { marginTop: '10px' } }, String(cs.sources)));
      },
      foot: function (foot, close) { foot.appendChild(h('button', { class: 'primary', type: 'button', onclick: function () { close(); } }, 'Close')); }
    });
  };
  UI.showCases = function () {
    var list = safeList((WS.CaseStudies && WS.CaseStudies.LIST) || (UI.game && UI.game.caseStudies));
    var s = st(), unlocked = safeList(s.unlockedCases), seen = safeList(s.seenCases);
    return UI.modal({
      icon: '📚', eyebrow: 'Library', title: 'Case studies', className: 'cases',
      render: function (body, close) {
        body.appendChild(h('p', { class: 'muted' }, 'Real Colorado events that mirror what happens in this watershed. They unlock as you experience the same dynamics.'));
        if (!list.length) { body.appendChild(h('p', { class: 'muted' }, 'No case studies loaded.')); return; }
        var wrap = h('div', { class: 'case-list' });
        list.forEach(function (cs) {
          cs = cs || {}; var ok = unlocked.indexOf(cs.id) >= 0;
          var row = h('div', { class: 'case' + (ok ? '' : ' locked'), 'data-case': cs.id || '' }, [
            h('span', { class: 'yr' }, cs.year != null ? String(cs.year) : '—'),
            h('div', { class: 'grow' }, [h('div', { class: 'n' }, cs.title || String(cs.id)), h('div', { class: 's' }, ok ? (cs.region || '') : 'Unlocks when you meet the conditions this case describes.')]),
            ok ? h('div', { class: 'actions' }, h('button', { class: 'tiny', type: 'button', onclick: function () { close(); if (UI.game && typeof UI.game.openCaseStudy === 'function') call('openCaseStudy', [cs.id]); else UI.showCaseStudy(cs); } }, seen.indexOf(cs.id) >= 0 ? 'Read again' : 'Read')) : h('span', { class: 'actions dim', 'aria-hidden': 'true' }, '🔒')
          ]);
          wrap.appendChild(row);
        });
        body.appendChild(wrap);
      },
      foot: function (foot, close) { foot.appendChild(h('span', { class: 'left' }, unlocked.length + ' of ' + list.length + ' unlocked')); foot.appendChild(h('button', { class: 'primary', type: 'button', onclick: function () { close(); } }, 'Close')); }
    });
  };

  /* ================================================================== END */
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
      icon: '🏁', eyebrow: 'After ' + fin(s.years, fin(summary.years, 6)) + ' years', title: 'How the watershed fared', className: 'wide end', critical: true,
      render: function (body) {
        body.appendChild(h('div', { class: 'end-score' }, [h('div', { class: 'big' }, Math.round(R)), h('div', { class: 'grade' }, [h('div', { class: 'g' }, g.letter || '—'), h('div', { class: 'title' }, g.title || 'Colorado Resilience Score')])]));
        body.appendChild(h('div', { class: 'end-bars' }, OUT_KEYS.map(function (k) {
          var v = clamp(oc[k], 0, 100);
          return h('div', { class: 'eb' }, [h('span', { class: 'label' }, (OUT_NAMES[k] || k) + ' · ' + Math.round((OUT_WEIGHTS[k] || 0) * 100) + '%'), h('div', { class: 'meter' }, h('i', { class: UI.OUTCOME_CLASS[k] || 'water', style: { width: v + '%' } })), h('span', { class: 'n' }, Math.round(v))]);
        })));
        var stats = summary.stats || s.stats || {}, fire = s.fire || {};
        body.appendChild(h('div', { class: 'kv', style: { marginTop: '12px' } }, [
          stat('Acres burned', Math.round(fin(fire.totalAcres)).toLocaleString()),
          stat('Structures lost', Math.round(fin(fire.structuresLost))),
          stat('Flood damage', money(stats.floodDamageM)),
          stat('Sediment', Math.round(fin(stats.sedimentTons)).toLocaleString(), 't'),
          stat('Outage days', Math.round(fin(stats.contaminationOutageDays))),
          stat('Population', Math.round(fin(s.population)).toLocaleString())
        ]));
        var cols = h('div', { class: 'two-col', style: { marginTop: '12px' } });
        var hl = safeList(summary.highlights), ls = safeList(summary.lessons);
        cols.appendChild(h('div', {}, [h('h3', {}, 'Highlights'), hl.length ? h('ul', {}, hl.map(function (t) { return h('li', {}, String(t)); })) : h('p', { class: 'muted small' }, 'A quiet tenure.')]));
        cols.appendChild(h('div', {}, [h('h3', {}, 'Lessons'), ls.length ? h('ul', {}, ls.map(function (t) { return h('li', {}, String(t)); })) : h('p', { class: 'muted small' }, 'Wildfire and water are one system: what burns above the reservoir ends up in the tap.')]));
        body.appendChild(cols);
      },
      foot: function (foot, close) {
        foot.appendChild(h('button', { class: 'ghost', type: 'button', onclick: function () { UI.showCases(); } }, 'Case studies'));
        foot.appendChild(h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { close(); call('restart'); } }, 'Play again ↻'));
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
    function cfCol(title, items, cls) {
      return h('div', { class: 'col ' + cls }, [h('div', { class: 'label' }, title)].concat(items.length ? items.map(function (it) {
        it = (it && typeof it === 'object') ? it : { label: String(it) };
        return h('div', { class: 'li' }, [h('span', {}, String(it.label == null ? '' : it.label)), h('b', { class: 'num' }, String(it.value == null ? '—' : it.value))]);
      }) : [h('div', { class: 'li dim' }, 'No numbers available')]));
    }
    return UI.modal({
      icon: mode === 'storm' ? '🌊' : '🔥', eyebrow: 'After-action report', title: report.title || (mode === 'storm' ? 'Storm defense' : 'Fire response'), className: 'wide afteraction ' + mode, critical: true,
      render: function (body) {
        if (report.headline) body.appendChild(h('p', { class: 'lead' }, String(report.headline)));
        if (stats.length) body.appendChild(h('div', { class: 'kv' }, stats.map(function (x) {
          x = (x && typeof x === 'object') ? x : { label: String(x) };
          return stat(String(x.label == null ? '' : x.label), String(x.value == null ? '—' : x.value), x.unit ? String(x.unit) : null, x.bad ? 'bad' : (x.good ? 'good' : ''));
        })));
        var cols = h('div', { class: 'aa-cols' });
        cols.appendChild(h('div', {}, [h('h3', {}, 'What you did'), actions.length ? h('ul', { class: 'aa-actions' }, actions.map(function (a) { return h('li', {}, String(a && typeof a === 'object' ? (a.text || a.label || '') : a)); })) : h('p', { class: 'muted small' }, 'No tactical actions were taken — the crisis ran its course.')]));
        if (without.length || withL.length || cf.summary) {
          cols.appendChild(h('div', {}, [
            h('h3', {}, 'What your response changed'),
            h('div', { class: 'cf' }, [cfCol('Without your response', without, 'without'), cfCol('With your response', withL, 'with')]),
            cf.summary ? h('p', { class: 'cf-summary' }, String(cf.summary)) : null
          ]));
        }
        body.appendChild(cols);
        if (lessons.length) { body.appendChild(h('h3', {}, 'Lessons')); body.appendChild(h('ul', { class: 'aa-lessons' }, lessons.map(function (l) { return h('li', {}, String(l)); }))); }
      },
      foot: function (foot, close) {
        foot.appendChild(h('span', { class: 'left' }, mode === 'storm' ? 'The season continues once the water recedes.' : 'The season continues once the fire is out.'));
        foot.appendChild(h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { close(); } }, 'Continue ▶'));
      }
    });
  };

  /* ================================================================== HELP */
  UI.showHelp = function () {
    return UI.modal({
      icon: '❔', eyebrow: 'Help', title: 'How to play Watershed', className: 'wide help',
      render: function (body) {
        var grid = h('div', { class: 'help-grid' });
        grid.appendChild(h('div', {}, [
          h('h3', {}, 'A season, in order'),
          h('ul', {}, [
            h('li', {}, [h('b', {}, 'Conditions'), ' — read the snowpack, storage, fire danger and drought on the left. Uncertain readings show ranges until you fund streamgages.']),
            h('li', {}, [h('b', {}, 'Events'), ' — cards may interrupt with a choice. Some consequences arrive turns later.']),
            h('li', {}, [h('b', {}, 'Plan'), ' — fund projects, allocate water and set fire policy on the right. Open the Evidence Board to hear advisors argue with data.']),
            h('li', {}, [h('b', {}, 'End Season'), ' — the watershed runs: deliveries, maybe a fire, maybe a storm over a burn scar, then a report explaining cause and effect.']),
            h('li', {}, [h('b', {}, 'Crisis'), ' — when a fire ignites or a storm hits the scar, you fight it live: cut dozer lines, call air tankers, station engines, evacuate, sandbag, pump, open the spillway. An after-action card shows what your response changed.'])
          ]),
          h('h3', {}, 'Controls'),
          h('ul', {}, [
            h('li', {}, [h('kbd', {}, 'Drag'), ' pan · ', h('kbd', {}, 'Right-drag'), ' / ', h('kbd', {}, 'Ctrl-drag'), ' orbit · ', h('kbd', {}, 'Wheel'), ' zoom']),
            h('li', {}, [h('kbd', {}, 'W A S D'), ' / arrows pan · ', h('kbd', {}, 'Q'), ' ', h('kbd', {}, 'E'), ' rotate']),
            h('li', {}, [h('kbd', {}, 'Space'), ' end season · ', h('kbd', {}, '1'), '–', h('kbd', {}, '4'), ' speed · ', h('kbd', {}, 'V'), ' overlay · ', h('kbd', {}, 'Esc'), ' close']),
            h('li', {}, [h('b', {}, 'During a fire or storm: '), h('kbd', {}, '1'), '–', h('kbd', {}, '5'), ' pick a tool · ', h('kbd', {}, 'Drag'), ' paints lines / sandbags · ', h('kbd', {}, 'Space'), ' pause · ', h('kbd', {}, 'Esc'), ' deselect'])
          ])
        ]));
        grid.appendChild(h('div', {}, [
          h('h3', {}, 'Scoring'),
          h('p', { class: 'small' }, 'Five outcomes, 0–100, each moving 45% of the way toward a target computed from the state of the watershed every season (momentum — bad years linger). Trust moves only through your decisions.'),
          h('div', { class: 'formula' }, 'Resilience = ' + OUT_KEYS.map(function (k) { return Math.round((OUT_WEIGHTS[k] || 0) * 100) + '%·' + k; }).join(' + ')),
          h('ul', { class: 'small', style: { marginTop: '8px' } }, OUT_KEYS.map(function (k) { return h('li', {}, [h('b', {}, (OUT_NAMES[k] || k) + '. '), (UI.OUTCOME_TIPS[k] || '').replace(/^[^—]+—\s*/, '')]); })),
          h('h3', {}, 'Water law, briefly'),
          h('p', { class: 'small' }, 'Colorado runs on prior appropriation: "first in time, first in right". The tribal reserved right and the Colorado River Compact delivery are senior — the sim delivers them even if you cut them, and your trust suffers. Hydro, recreation and wildlife releases are non-consumptive: the water keeps flowing downstream.'),
          h('h3', {}, 'The fire–water link'),
          h('p', { class: 'small' }, 'Burned soils shed water instead of absorbing it. A modest storm over a fresh burn scar can produce ten to thirty times the runoff of an unburned slope, carrying ash and sediment into reservoirs and treatment intakes. Thinning, prescribed fire, wetlands, mulch and debris basins all change that math.')
        ]));
        body.appendChild(grid);
      },
      foot: function (foot, close) { foot.appendChild(h('button', { class: 'primary', type: 'button', onclick: function () { close(); } }, 'Got it')); }
    });
  };

  /* ================================================================== LOG MODAL */
  UI.showLog = function () {
    return UI.modal({
      icon: '📓', eyebrow: 'Field notebook', title: 'Log & timeline', className: 'wide logm',
      render: function (body) {
        var s = st(), tl = safeList(s.timeline);
        var cols = h('div', { class: 'two-col' });
        var left = h('div', {}, h('h3', {}, 'Cause-and-effect timeline'));
        if (!tl.length) left.appendChild(h('p', { class: 'muted small' }, 'The timeline fills in as seasons are played.'));
        else tl.slice().reverse().slice(0, 24).forEach(function (t) {
          t = t || {};
          left.appendChild(h('div', { class: 'label', style: { margin: '10px 0 4px' } }, seasonName(t.season) + ' · Year ' + fin(t.year, 1)));
          left.appendChild(h('ul', { class: 'timeline' }, safeList(t.entries).map(function (e) {
            var kind = (e && e.kind) || 'info';
            return h('li', { class: kind }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, TL_ICONS[kind] || 'ℹ'), h('span', {}, String((e && e.text) || e || ''))]);
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
      return { type: type, name: t.name || b.name || type.replace(/_/g, ' '), icon: t.icon || UI.TOOL_ICONS[type] || '▪', costM: fin(t.costM, fin(b.costM)), desc: t.desc || b.desc || '', remaining: rem, placed: n, free: fin(free[type], fin(t.free)), disabled: !!t.disabled || rem === 0 };
    });
  }
  function renderPlacement(spec) {
    var E = UI.els, box = E.placement; if (!box) return;
    spec = spec || {}; clear(box);
    var storm = spec.storm || {}, prep = spec.prep || {};
    var days = spec.daysUntil != null ? spec.daysUntil : (storm.daysUntil != null ? storm.daysUntil : (spec.turnsUntil != null ? spec.turnsUntil : storm.turnsUntil));
    var inches = fin(spec.intensityIn, fin(storm.intensityIn));
    var budget = spec.emergencyBudget != null ? spec.emergencyBudget : (spec.budget != null ? spec.budget : st().emergencyFund);
    var countdown = spec.countdown || ('Storm arrives in ' + (days != null ? fin(days) + ' day' + (fin(days) === 1 ? '' : 's') : 'days') + ' — ' + num(inches, 1) + ' in forecast' + (storm.durationHr ? ' over ' + Math.round(fin(storm.durationHr)) + ' h' : ''));
    box.appendChild(h('div', { class: 'countdown' }, [
      h('div', { class: 't' }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, '⛈'), countdown]),
      h('div', { class: 'budget small' }, ['Emergency budget ', h('b', {}, money(budget)), spec.spent != null ? h('span', { class: 'dim' }, ' · spent ' + money(spec.spent)) : null])
    ]));
    if (prep.scarAcres != null || prep.predictedPeakCfs != null) {
      var zones = safeList(prep.atRiskZones).map(function (z) { return UI.zoneName(z); }).filter(Boolean);
      box.appendChild(h('div', { class: 'small dim', style: { marginBottom: '8px' } }, [
        prep.scarAcres != null ? 'Burn scar ' + Math.round(fin(prep.scarAcres)).toLocaleString() + ' acres' : null,
        prep.predictedPeakCfs != null ? ' · predicted peak ' + Math.round(fin(prep.predictedPeakCfs)).toLocaleString() + ' cfs' : null,
        prep.predictedSedimentTons != null ? ' · ~' + Math.round(fin(prep.predictedSedimentTons)).toLocaleString() + ' t sediment' : null,
        zones.length ? ' · at risk: ' + zones.join(', ') : null
      ]));
    }
    var tools = normalizeTools(spec), selected = spec.selected != null ? spec.selected : UI._placementSelected;
    var grid = h('div', { class: 'tools', role: 'group', 'aria-label': 'Mitigation tools' });
    tools.forEach(function (t) {
      var b = h('button', { class: 'tool' + (t.type === selected ? ' selected' : '') + (t.free > 0 ? ' free' : ''), type: 'button', 'data-tool': t.type, 'aria-pressed': t.type === selected ? 'true' : 'false', disabled: t.disabled ? true : null, 'data-tip': t.desc || t.name }, [
        h('span', { class: 'ic', 'aria-hidden': 'true' }, t.icon),
        h('span', { class: 'n' }, t.name),
        h('span', { class: 'c' }, [t.free > 0 ? h('b', {}, t.free + ' free') : h('b', {}, money(t.costM)), t.remaining != null ? ' · ' + t.remaining + ' left' : (t.placed ? ' · ' + t.placed + ' placed' : '')])
      ]);
      b.addEventListener('click', function () { UI._placementSelected = t.type; call('selectPlacementTool', [t.type]); renderPlacement(Object.assign({}, spec, { selected: t.type })); });
      grid.appendChild(b);
    });
    box.appendChild(grid);
    var sel = tools.filter(function (t) { return t.type === selected; })[0];
    box.appendChild(h('div', { class: 'foot' }, [
      h('div', { class: 'hint' }, sel ? ('Click the map to place ' + sel.name.toLowerCase() + ' where allowed. ' + (sel.desc || '')) : 'Pick a tool, then click the map. Valid cells are highlighted.'),
      h('button', { class: 'ghost tiny', type: 'button', onclick: function () { if (UI.showHelp) UI.showHelp(); } }, 'What do these do?'),
      h('button', { class: 'primary warn', type: 'button', id: 'brace-btn', onclick: function () { UI._finishPlacement(); } }, 'Brace for storm ⛈')
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
      coach.appendChild(arrow);
      coach.appendChild(h('div', { class: 'eyebrow' }, 'Tutorial'));
      coach.appendChild(h('div', { class: 'body' }, String(text || '')));
      coach.appendChild(h('div', { class: 'foot' }, [
        h('button', { type: 'button', onclick: function () { done(false); } }, 'Skip tutorial'),
        h('button', { class: 'primary', type: 'button', autofocus: true, onclick: function () { done(true); } }, 'Next ▶')
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
