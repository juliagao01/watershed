/* Watershed — UI: HUD skeleton, top/bottom bars, Conditions panel, toasts, tooltips, modal queue.
   Exports on WS.UI (shared with panels.js). Reads game.state fresh on every call; never caches it. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var UI = WS.UI = WS.UI || {};
  var C = WS.C || {};
  var F = C.fmt || {
    af: function (v) { return Math.round(v || 0).toLocaleString() + ' AF'; },
    pct: function (v) { return Math.round(v || 0) + '%'; },
    money: function (m) { return '$' + (Math.round((m || 0) * 10) / 10).toFixed(1) + 'M'; },
    num: function (v, d) { return Number(v || 0).toFixed(d == null ? 0 : d); }
  };
  var SEASONS = C.SEASONS || ['Winter', 'Spring', 'Summer', 'Fall'];
  var OUT_KEYS = C.OUTCOME_KEYS || ['W', 'E', 'P', 'F', 'T'];
  var OUT_NAMES = C.OUTCOME_NAMES || { W: 'Water Security', E: 'Ecosystem Health', P: 'Public Safety', F: 'Food & Economy', T: 'Public Trust' };
  var OUT_WEIGHTS = C.OUTCOME_WEIGHTS || { W: 0.25, E: 0.2, P: 0.2, F: 0.2, T: 0.15 };
  var PH = C.PHASES || { BOOT: 'boot', INTRO: 'intro', PLAN: 'plan', EVENT: 'event', LIVE: 'live', FLOOD_PREP: 'flood_prep', FLOOD: 'flood', REPORT: 'report', END: 'end' };

  /* ------------------------------------------------------------------ helpers */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function append(el, ch) {
    if (ch == null || ch === false) return;
    if (Array.isArray(ch)) { for (var i = 0; i < ch.length; i++) append(el, ch[i]); return; }
    if (typeof ch === 'string' || typeof ch === 'number') { el.appendChild(document.createTextNode(String(ch))); return; }
    if (ch.nodeType) el.appendChild(ch);
  }
  function applyAttrs(el, attrs) {
    if (!attrs) return;
    for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'style' && typeof v === 'object') { for (var sk in v) el.style[sk] = v[sk]; }
      else if (k === 'dataset') { for (var d in v) el.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; /* trusted static markup only (icons) */
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  function h(tag, attrs, children) { var el = document.createElement(tag); applyAttrs(el, attrs); append(el, children); return el; }
  function hs(tag, attrs, children) { var el = document.createElementNS('http://www.w3.org/2000/svg', tag); applyAttrs(el, attrs); append(el, children); return el; }
  function clear(el) { if (el) while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function fin(v, d) { v = Number(v); return isFinite(v) ? v : (d == null ? 0 : d); }
  function num(v, d) { v = Number(v); return isFinite(v) ? F.num(v, d) : '—'; }
  function money(v) { return isFinite(Number(v)) ? F.money(Number(v)) : '—'; }
  function af(v) { return isFinite(Number(v)) ? F.af(Number(v)) : '—'; }
  function pct(v) { return isFinite(Number(v)) ? F.pct(Number(v)) : '—'; }
  function clamp(v, a, b) { v = fin(v, a); return v < a ? a : (v > b ? b : v); }
  function signed(v, d) { v = fin(v); var s = num(Math.abs(v), d); return (v > 0 ? '+' : (v < 0 ? '−' : '')) + s; }
  function st() { return (UI.game && UI.game.state) || {}; }
  function wd() { return (UI.game && UI.game.world) || {}; }
  function seasonName(i) { return SEASONS[fin(i) & 3] || '—'; }
  function localGrade(R) {
    R = fin(R);
    if (R >= 90) return { letter: 'A+', title: 'Watershed Steward' };
    if (R >= 80) return { letter: 'A', title: 'Resilient Community' };
    if (R >= 70) return { letter: 'B', title: 'Weathering It' };
    if (R >= 60) return { letter: 'C', title: 'Holding On' };
    if (R >= 50) return { letter: 'D', title: 'Strained' };
    return { letter: 'F', title: 'Crisis Cycle' };
  }
  function gradeOf(R) {
    var g = null;
    try { if (WS.Scoring && typeof WS.Scoring.grade === 'function') g = WS.Scoring.grade(R); } catch (e) { g = null; }
    if (!g) g = localGrade(R);
    if (typeof g === 'string') { var m = g.match(/^\s*([A-F][+-]?)\s*[—–\-:·]?\s*(.*)$/); return m ? { letter: m[1], title: m[2] } : { letter: g, title: '' }; }
    return { letter: g.letter || g.grade || '—', title: g.title || g.name || '' };
  }
  function resilienceOf(s) {
    if (isFinite(Number(s.resilience)) && Number(s.resilience) > 0) return Number(s.resilience);
    var o = s.outcomes || {}, r = 0;
    for (var i = 0; i < OUT_KEYS.length; i++) r += fin(o[OUT_KEYS[i]]) * (OUT_WEIGHTS[OUT_KEYS[i]] || 0);
    return r;
  }
  function historyValues(key) {
    var hist = st().history || [], out = [];
    for (var i = 0; i < hist.length; i++) { var v = Number((hist[i] || {})[key]); if (isFinite(v)) out.push(v); }
    return out;
  }
  function turnLabel(e) {
    if (!e) return '';
    if (e.year != null && e.season != null) return 'Y' + e.year + ' ' + seasonName(e.season).slice(0, 3);
    if (e.turn != null) return 'Y' + (1 + Math.floor(fin(e.turn) / 4)) + ' ' + seasonName(fin(e.turn) % 4).slice(0, 3);
    return '';
  }

  UI.h = h; UI.hs = hs; UI.esc = esc; UI.clear = clear; UI.fmt = { num: num, money: money, af: af, pct: pct, signed: signed, fin: fin, clamp: clamp, seasonName: seasonName, turnLabel: turnLabel };
  UI.gradeOf = gradeOf; UI.resilienceOf = resilienceOf;
  UI.els = {};

  UI.COLORS = { W: '#4aa3df', E: '#6fbf73', P: '#e07a5f', F: '#d4a24c', T: '#e9c46a', water: '#4aa3df', fire: '#ff7a33', forest: '#6fbf73', trust: '#e9c46a', danger: '#e63946' };
  UI.OUTCOME_CLASS = { W: 'water', E: 'forest', P: 'fire', F: 'trust', T: 'trust' };
  UI.OUTCOME_SHORT = { W: 'Water', E: 'Ecosystem', P: 'Safety', F: 'Economy', T: 'Trust' };
  UI.OUTCOME_TIPS = {
    W: 'Water Security — fed by reservoir storage relative to capacity, household shortages avoided, and low ash contamination. Treatment outages pull it down.',
    E: 'Ecosystem Health — minimum-flow streak, elk habitat, tree cover versus the start, low turbidity, restored wetland, and how much has burned.',
    P: 'Public Safety — structures lost, flood damage, smoke days without shelters, warning and shelter projects, hardened WUI homes, fire danger near town.',
    F: 'Food & Economy — crop health, farm shortages, recreation index, hydropower output, damage costs and tourism.',
    T: 'Public Trust — moves only through your decisions and their consequences (legal overrides, outreach, crises handled well or badly), regressing slowly toward neutral.'
  };
  UI.KIND_ICONS = { info: 'ℹ', good: '✔', bad: '✖', warn: '⚠', event: '⚡', fire: '🔥', flood: '🌊', water: '💧', money: '💵', forest: '🌲', trust: '🤝' };
  UI.SECTOR_ICONS = { households: '🏘', farms: '🌾', fire: '🚒', hydro: '⚡', recreation: '🛶', tribal: '🪶', wildlife: '🦌', downstream: '🏞' };
  UI.SECTOR_COLORS = { households: '#4aa3df', farms: '#d4a24c', fire: '#ff7a33', hydro: '#a78bfa', recreation: '#38bdf8', tribal: '#e9c46a', wildlife: '#6fbf73', downstream: '#7dd3c0' };
  UI.TOOL_ICONS = { mulch: '🌾', barrier: '🪵', debris_basin: '⭕', bank_stab: '🪨', intake_protect: '🛟', sensor: '📡', warning: '🚨', pin: '📍', fireStart: '🔥' };
  UI.OVERLAYS = ['none', 'watershed', 'fire', 'moisture', 'burn'];
  UI.OVERLAY_NAMES = { none: 'None', watershed: 'Watershed', fire: 'Fire risk', moisture: 'Moisture', burn: 'Burn scar' };
  UI.EVIDENCE_TOPICS = [['budget', 'Budget priorities'], ['allocation', 'Water allocation'], ['prescribed_burn', 'Prescribed burning'], ['fire_policy', 'Fire policy'], ['flood', 'Post-fire flood'], ['contamination', 'Water contamination'], ['drought', 'Drought response']];

  var BRAND_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="ws-g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd0ff"/><stop offset="1" stop-color="#2c6f9e"/></linearGradient><linearGradient id="ws-g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc14d"/><stop offset="1" stop-color="#ff6a1a"/></linearGradient></defs><path d="M12 3c-1 5-7 9-7 15a7 7 0 0 0 14 0c0-6-6-10-7-15z" fill="url(#ws-g1)"/><path d="M22 10c0 3-3 4-3 8a4 4 0 0 0 8 0c0-2-1-3-2-4 0 1-.5 2-1 2 .5-2-1-4-2-6z" fill="url(#ws-g2)"/></svg>';
  UI.BRAND_SVG = BRAND_SVG;

  /* ------------------------------------------------------------------ SVG charts */
  /** Tiny sparkline: values[] -> <svg>. opts: {w,h,color,min,max} */
  UI.sparkline = function (values, opts) {
    opts = opts || {};
    var w = opts.w || 110, hh = opts.h || 30, color = opts.color || UI.COLORS.water;
    var vals = (values || []).filter(function (v) { return isFinite(v); });
    var svg = hs('svg', { viewBox: '0 0 ' + w + ' ' + hh, width: w, height: hh, 'aria-hidden': 'true' });
    if (vals.length < 2) {
      svg.appendChild(hs('line', { x1: 0, y1: hh - 6, x2: w, y2: hh - 6, stroke: 'rgba(255,255,255,.15)', 'stroke-dasharray': '3 3' }));
      svg.appendChild(hs('text', { x: 0, y: hh - 10, class: 'empty' }, vals.length === 1 ? '1 season' : 'no history yet'));
      if (vals.length === 1) svg.appendChild(hs('circle', { cx: w - 3, cy: hh - 6, class: 'dot', fill: color }));
      return svg;
    }
    var mn = opts.min != null ? opts.min : Math.min.apply(null, vals), mx = opts.max != null ? opts.max : Math.max.apply(null, vals);
    if (mx - mn < 1e-9) { mx = mn + 1; mn = mn - 1; }
    var pad = 3, pts = [];
    for (var i = 0; i < vals.length; i++) {
      var x = pad + (w - 2 * pad) * i / (vals.length - 1);
      var y = pad + (hh - 2 * pad) * (1 - (vals[i] - mn) / (mx - mn));
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    svg.appendChild(hs('polygon', { class: 'area', fill: color, points: pad + ',' + (hh - pad) + ' ' + pts.join(' ') + ' ' + (w - pad) + ',' + (hh - pad) }));
    svg.appendChild(hs('polyline', { class: 'line', stroke: color, points: pts.join(' ') }));
    var last = pts[pts.length - 1].split(',');
    svg.appendChild(hs('circle', { cx: last[0], cy: last[1], class: 'dot', fill: color }));
    return svg;
  };

  /** Larger line chart with threshold + current marker (Evidence Board). */
  UI.lineChart = function (series, opts) {
    opts = opts || {};
    var w = opts.w || 240, hh = opts.h || 64, color = opts.color || UI.COLORS.water;
    var vals = (series || []).filter(function (v) { return isFinite(v); });
    if (isFinite(Number(opts.current)) && (vals.length === 0 || vals[vals.length - 1] !== Number(opts.current))) vals = vals.concat([Number(opts.current)]);
    var svg = hs('svg', { viewBox: '0 0 ' + w + ' ' + hh, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    var thr = isFinite(Number(opts.threshold)) ? Number(opts.threshold) : null;
    if (vals.length === 0) { svg.appendChild(hs('text', { x: 4, y: hh / 2, class: 'empty' }, 'No measurements yet')); return svg; }
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (thr != null) { mn = Math.min(mn, thr); mx = Math.max(mx, thr); }
    if (mx - mn < 1e-9) { mx = mn + 1; mn = mn - 1; }
    var padT = 6, padB = 10, padL = 4, padR = 30, iw = w - padL - padR, ih = hh - padT - padB;
    var Y = function (v) { return padT + ih * (1 - (v - mn) / (mx - mn)); };
    var X = function (i) { return padL + (vals.length < 2 ? iw : iw * i / (vals.length - 1)); };
    svg.appendChild(hs('line', { class: 'grid', x1: padL, y1: Y(mn), x2: padL + iw, y2: Y(mn) }));
    var pts = [];
    for (var i = 0; i < vals.length; i++) pts.push(X(i).toFixed(1) + ',' + Y(vals[i]).toFixed(1));
    if (vals.length > 1) {
      svg.appendChild(hs('polygon', { class: 'area', points: padL + ',' + Y(mn).toFixed(1) + ' ' + pts.join(' ') + ' ' + (padL + iw) + ',' + Y(mn).toFixed(1) }));
      svg.appendChild(hs('polyline', { class: 'line', style: { stroke: color }, points: pts.join(' ') }));
    }
    if (thr != null) {
      svg.appendChild(hs('line', { class: 'thr', x1: padL, y1: Y(thr), x2: padL + iw, y2: Y(thr) }));
      svg.appendChild(hs('text', { class: 'thr-l', x: padL + iw + 3, y: Y(thr) + 3 }, num(thr, thr % 1 ? 1 : 0)));
    }
    var lx = X(vals.length - 1), ly = Y(vals[vals.length - 1]);
    svg.appendChild(hs('circle', { class: 'cur', cx: lx, cy: ly, r: 3.2 }));
    svg.appendChild(hs('text', { class: 'ax', x: padL, y: hh - 1 }, num(mn, mn % 1 ? 1 : 0)));
    svg.appendChild(hs('text', { class: 'ax', x: padL, y: padT + 3 }, num(mx, mx % 1 ? 1 : 0)));
    return svg;
  };

  /* ------------------------------------------------------------------ tooltip system */
  var tipTimer = null;
  function showTip(target) {
    var tip = UI.els.tooltip; if (!tip || !target) return;
    var text = target.getAttribute('data-tip'); if (!text) return;
    tip.textContent = text; tip.classList.add('show');
    var r = target.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var x = r.left + r.width / 2 - tw / 2, y = r.bottom + 8;
    if (y + th > vh - 8) y = r.top - th - 8;
    x = Math.max(8, Math.min(vw - tw - 8, x));
    tip.style.left = x + 'px'; tip.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { var tip = UI.els.tooltip; if (tip) tip.classList.remove('show'); }
  function bindTooltips(rootEl) {
    rootEl.addEventListener('mouseover', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      clearTimeout(tipTimer);
      if (t) tipTimer = setTimeout(function () { showTip(t); }, 120); else hideTip();
    });
    rootEl.addEventListener('mouseout', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t) { clearTimeout(tipTimer); hideTip(); }
    });
    rootEl.addEventListener('focusin', function (e) { var t = e.target.closest ? e.target.closest('[data-tip]') : null; if (t) showTip(t); });
    rootEl.addEventListener('focusout', hideTip);
    rootEl.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button.info[data-tip]') : null;
      if (t) { e.preventDefault(); if (UI.els.tooltip.classList.contains('show')) hideTip(); else showTip(t); }
    });
    rootEl.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
  }
  UI.info = function (text) { return h('button', { class: 'info', type: 'button', 'aria-label': 'What this means', 'data-tip': text }, 'i'); };

  /* ------------------------------------------------------------------ modal queue */
  var modalQueue = [], modalActive = null;
  /** opts: { title, eyebrow, icon, className, critical, render(body, close), foot(footEl, close), onClose } → Promise */
  UI.modal = function (opts) {
    return new Promise(function (resolve) { modalQueue.push({ opts: opts || {}, resolve: resolve }); pumpModal(); });
  };
  UI.modalQueueLength = function () { return modalQueue.length + (modalActive ? 1 : 0); };
  function pumpModal() {
    if (modalActive || !modalQueue.length) return;
    var m = modalQueue.shift(); modalActive = m;
    var o = m.opts, rootEl = UI.els.modalRoot;
    if (!rootEl) { m.resolve(undefined); modalActive = null; return; }
    clear(rootEl);
    var closed = false;
    var close = function (value) {
      if (closed) return; closed = true;
      try { if (o.onClose) o.onClose(value); } catch (e) { console.error(e); }
      clear(rootEl); rootEl.classList.remove('open'); modalActive = null;
      if (!modalQueue.length) document.body.classList.remove('modal-open');
      m.resolve(value);
      if (m.prevFocus && m.prevFocus.focus) { try { m.prevFocus.focus(); } catch (e) { /* ignore */ } }
      setTimeout(pumpModal, 0);
    };
    m.close = close; m.critical = !!o.critical;
    m.prevFocus = document.activeElement;
    var modal = h('div', { class: 'modal' + (o.className ? ' ' + o.className : '') + (o.critical ? ' critical' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Dialog', tabindex: '-1' });
    if (o.title || o.icon || o.eyebrow) {
      modal.appendChild(h('div', { class: 'mhead' }, [
        o.icon ? h('div', { class: 'micon' }, o.icon) : null,
        h('div', { class: 'mtitle' }, [o.eyebrow ? h('span', { class: 'eyebrow' }, o.eyebrow) : null, o.title || ''])
      ]));
    }
    if (!o.critical) modal.appendChild(h('button', { class: 'close ghost', type: 'button', 'aria-label': 'Close', onclick: function () { close(undefined); } }, '×'));
    var body = h('div', { class: 'mbody' });
    modal.appendChild(body);
    try { if (o.render) o.render(body, close); } catch (e) { console.error('modal render failed', e); body.appendChild(h('p', { class: 'muted' }, 'Something went wrong rendering this dialog.')); }
    if (o.foot) { var foot = h('div', { class: 'mfoot' }); try { o.foot(foot, close); } catch (e) { console.error(e); } modal.appendChild(foot); }
    var backdrop = h('div', { class: 'modal-backdrop', onclick: function () { if (!o.critical) close(undefined); } });
    rootEl.appendChild(backdrop); rootEl.appendChild(modal);
    rootEl.classList.add('open');
    document.body.classList.add('modal-open');
    setTimeout(function () {
      var f = modal.querySelector('[autofocus]') || modal.querySelector('.mfoot button.primary') || modal.querySelector('.mbody button:not(:disabled), .mbody input, .mbody select') || modal.querySelector('.mfoot button');
      try { (f || modal).focus(); } catch (e) { /* ignore */ }
    }, 30);
  }
  UI.closeModal = function (value) { if (modalActive) modalActive.close(value); };
  UI.modalIsOpen = function () { return !!modalActive; };
  UI.modalIsCritical = function () { return !!(modalActive && modalActive.critical); };

  /* ------------------------------------------------------------------ init & skeleton */
  UI._overlay = 'none'; UI._speed = 1; UI._phase = PH.BOOT; UI._tab = 'projects'; UI._targetSel = {};

  UI.init = function (game) {
    UI.game = game || UI.game || {};
    var ui = document.getElementById('ui');
    if (!ui) { ui = h('div', { id: 'ui' }); (document.getElementById('app') || document.body).appendChild(ui); }
    clear(ui);
    var E = UI.els = { ui: ui };

    /* top bar */
    E.topbar = h('div', { id: 'topbar', class: 'bar panel', role: 'banner' });
    E.brand = h('div', { class: 'brand' }, [h('span', { html: BRAND_SVG }), h('div', {}, [h('span', { class: 'wordmark' }, 'WATERSHED'), h('span', { class: 'sub' }, 'Colorado water resilience')])]);
    E.date = h('div', { class: 'hud-block', id: 'hud-date' }, [h('span', { class: 'label' }, 'Season'), h('span', { class: 'v' }, '—')]);
    E.budget = h('div', { class: 'hud-block', id: 'hud-budget', 'data-tip': 'Annual budget replenishes each Winter. The emergency fund is only available during storm preparation.' }, [h('span', { class: 'label' }, 'Budget'), h('span', { class: 'v' }, '—')]);
    E.outcomes = h('div', { class: 'outcomes', id: 'hud-outcomes' });
    E.outcome = {};
    OUT_KEYS.forEach(function (k) {
      var el = h('div', { class: 'outcome', 'data-key': k, 'data-tip': UI.OUTCOME_TIPS[k] || OUT_NAMES[k], tabindex: '0' }, [
        h('div', { class: 't' }, [h('span', { class: 'k' }, UI.OUTCOME_SHORT[k] || OUT_NAMES[k] || k), h('span', { class: 'n' }, '—')]),
        h('div', { class: 'meter' }, h('i', { class: UI.OUTCOME_CLASS[k] || 'water', style: { width: '0%' } }))
      ]);
      E.outcome[k] = el; E.outcomes.appendChild(el);
    });
    E.score = h('div', { class: 'score', id: 'hud-score', 'data-tip': 'Colorado Resilience Score = weighted outcomes: Water 25%, Ecosystem 20%, Safety 20%, Economy 20%, Trust 15%.' }, [
      h('span', { class: 'big' }, '—'), h('div', { class: 'grade' }, [h('span', { class: 'g' }, ''), h('span', { class: 'title' }, 'Resilience score')])
    ]);
    E.btnOverlay = h('button', { id: 'btn-overlay', type: 'button', 'data-tip': 'Cycle map overlay (V): none → watershed → fire risk → moisture → burn scar' }, [h('span', { 'aria-hidden': 'true' }, '🗺 '), h('span', { class: 'txt' }, 'Overlay: '), h('span', { class: 'mode' }, 'None')]);
    E.btnOverlay.addEventListener('click', function () { UI.cycleOverlay(); });
    E.btnEvidence = h('button', { id: 'btn-evidence', type: 'button', 'data-tip': 'Open the Evidence Board: advisors weigh in with data' }, [h('span', { class: 'txt' }, 'Evidence'), h('span', { 'aria-hidden': 'true' }, ' 📊')]);
    E.btnEvidence.addEventListener('click', function (e) { e.stopPropagation(); UI.toggleEvidenceMenu(); });
    E.btnLog = h('button', { id: 'btn-log', type: 'button', 'data-tip': 'Full log and cause-and-effect timeline' }, [h('span', { class: 'txt' }, 'Log'), h('span', { 'aria-hidden': 'true' }, ' 📓')]);
    E.btnLog.addEventListener('click', function () { if (UI.showLog) UI.showLog(); });
    E.btnCases = h('button', { id: 'btn-cases', type: 'button', 'data-tip': 'Case studies from Colorado\'s recent fires, floods and water fights' }, [h('span', { class: 'txt' }, 'Cases'), h('span', { 'aria-hidden': 'true' }, ' 📚')]);
    E.btnCases.addEventListener('click', function () { if (UI.showCases) UI.showCases(); });
    E.btnSave = h('button', { id: 'btn-save', type: 'button', 'data-tip': 'Save to this browser' }, [h('span', { class: 'txt' }, 'Save'), h('span', { 'aria-hidden': 'true' }, ' 💾')]);
    E.btnSave.addEventListener('click', function () { UI.callGame('save', [], function (r) { UI.toast(r === false ? 'Save failed' : 'Game saved', r === false ? 'bad' : 'good'); UI.refresh(); }); });
    E.btnLoad = h('button', { id: 'btn-load', type: 'button', 'data-tip': 'Load the saved game' }, [h('span', { class: 'txt' }, 'Load'), h('span', { 'aria-hidden': 'true' }, ' 📂')]);
    E.btnLoad.addEventListener('click', function () { UI.callGame('load', [], function (r) { UI.toast(r === false ? 'No saved game found' : 'Game loaded', r === false ? 'warn' : 'good'); UI.refresh(); }); });
    E.btnHelp = h('button', { id: 'btn-help', type: 'button', 'data-tip': 'Controls, phases and how scoring works' }, [h('span', { class: 'txt' }, 'Help'), h('span', { 'aria-hidden': 'true' }, ' ?')]);
    E.btnHelp.addEventListener('click', function () { if (UI.showHelp) UI.showHelp(); });
    E.btnrow = h('div', { class: 'btnrow' }, [E.btnOverlay, E.btnEvidence, E.btnLog, E.btnCases, E.btnSave, E.btnLoad, E.btnHelp]);
    E.topbar.appendChild(E.brand); E.topbar.appendChild(E.date); E.topbar.appendChild(E.budget); E.topbar.appendChild(E.outcomes); E.topbar.appendChild(E.score); E.topbar.appendChild(E.btnrow);
    ui.appendChild(E.topbar);

    /* evidence topic menu (popover) */
    E.evidenceMenu = h('div', { id: 'evidence-menu', class: 'menu', hidden: true, role: 'menu' }, [h('div', { class: 'label' }, 'Ask the advisors about…')].concat(
      UI.EVIDENCE_TOPICS.map(function (t) {
        return h('button', { type: 'button', role: 'menuitem', onclick: function () { UI.toggleEvidenceMenu(false); UI.callGame('openEvidence', [t[0]]); } }, t[1]);
      })));
    ui.appendChild(E.evidenceMenu);
    document.addEventListener('click', function () { UI.toggleEvidenceMenu(false); });

    /* fire banner */
    E.fireBanner = h('div', { id: 'fire-banner', class: 'fire-banner', hidden: true, role: 'status', 'aria-live': 'polite' }, [
      h('span', { class: 'flame', 'aria-hidden': 'true' }, '🔥'), h('div', { class: 'grow' }, [h('div', { class: 't' }, 'Wildfire'), h('div', { class: 'd' }, '')])
    ]);
    ui.appendChild(E.fireBanner);

    /* left: conditions */
    E.panelLeft = h('section', { id: 'panel-left', class: 'panel side left', 'aria-label': 'Conditions' }, [
      h('div', { class: 'head' }, [h('span', { class: 'title' }, 'Conditions'), h('div', { class: 'row' }, [
        h('span', { class: 'small dim', id: 'cond-season' }, ''),
        h('button', { class: 'ghost tiny', type: 'button', 'aria-label': 'Collapse conditions', onclick: function () { UI.togglePanel('left', false); } }, '◀')
      ])]),
      E.conditions = h('div', { class: 'body', id: 'conditions' })
    ]);
    ui.appendChild(E.panelLeft);
    E.toggleLeft = h('button', { class: 'panel-toggle left', type: 'button', 'aria-label': 'Show conditions', onclick: function () { UI.togglePanel('left'); } }, '📈 Conditions');
    ui.appendChild(E.toggleLeft);

    /* right: actions */
    E.tabs = {};
    var tabDefs = [['projects', 'Projects'], ['water', 'Water'], ['fire', 'Fire'], ['log', 'Log']];
    E.tabbar = h('div', { class: 'tabs', role: 'tablist' }, tabDefs.map(function (t) {
      var b = h('button', { type: 'button', role: 'tab', 'data-tab': t[0], 'aria-selected': 'false', onclick: function () { UI.setTab(t[0]); } }, [t[1], h('span', { class: 'badge', hidden: true }, '')]);
      E.tabs[t[0]] = b; return b;
    }));
    E.panelRight = h('section', { id: 'panel-right', class: 'panel side right', 'aria-label': 'Actions' }, [
      h('div', { class: 'head' }, [h('span', { class: 'title' }, 'Actions'), h('button', { class: 'ghost tiny', type: 'button', 'aria-label': 'Collapse actions', onclick: function () { UI.togglePanel('right', false); } }, '▶')]),
      E.tabbar,
      E.tabBody = h('div', { class: 'body', id: 'tab-body', role: 'tabpanel' })
    ]);
    ui.appendChild(E.panelRight);
    E.toggleRight = h('button', { class: 'panel-toggle right', type: 'button', 'aria-label': 'Show actions', onclick: function () { UI.togglePanel('right'); } }, '🛠 Actions');
    ui.appendChild(E.toggleRight);

    /* placement toolbar */
    E.placement = h('div', { id: 'placement', class: 'placement panel', hidden: true, role: 'region', 'aria-label': 'Storm preparation' });
    ui.appendChild(E.placement);

    /* bottom bar */
    E.phaseChip = h('span', { id: 'phase-chip', class: 'chip phase-chip' }, [h('i', { class: 'dot' }), h('span', { class: 'txt' }, 'Boot')]);
    E.primary = h('button', { id: 'primary-btn', class: 'primary', type: 'button', disabled: true }, [h('span', { class: 'spin' }), h('span', { class: 'lbl' }, 'End Season ▶')]);
    E.primary.addEventListener('click', function () { UI.primaryAction(); });
    E.speedBtns = {};
    E.speed = h('div', { class: 'row speed', id: 'speed' }, [h('span', { class: 'label' }, 'Speed'), h('div', { class: 'seg' }, [1, 2, 4].map(function (n) {
      var b = h('button', { type: 'button', 'data-speed': n, 'aria-label': n + 'x speed', onclick: function () { UI.setSpeed(n); } }, n + '×');
      E.speedBtns[n] = b; return b;
    }))]);
    E.ticker = h('div', { class: 'ticker', id: 'ticker', role: 'status', 'aria-live': 'polite' }, [h('span', { class: 'label' }, 'Now'), h('span', { class: 'txt' }, 'Welcome to the Bitterbrush Creek watershed.')]);
    E.legend = h('div', { class: 'legend', id: 'legend', 'aria-label': 'Map legend' }, [
      ['Water', '#3b7fb0'], ['Forest', '#35643a'], ['Farms', '#8fbf5a'], ['Town', '#b9b0a3'], ['Burn scar', '#3a302a'], ['Fire', '#ff6a1a']
    ].map(function (l) { return h('span', { class: 'item', style: { '--c': l[1] } }, l[0]); }));
    E.bottombar = h('div', { id: 'bottombar', class: 'bar panel', role: 'toolbar' }, [E.phaseChip, E.primary, E.speed, E.ticker, E.legend]);
    ui.appendChild(E.bottombar);

    /* toasts, tooltip, coach, modal root */
    E.toasts = h('div', { id: 'toasts', 'aria-live': 'polite' }); ui.appendChild(E.toasts);
    E.tooltip = h('div', { id: 'tooltip', role: 'tooltip' }); ui.appendChild(E.tooltip);
    E.coach = h('div', { id: 'coach', class: 'coach', hidden: true, role: 'dialog', 'aria-label': 'Tutorial' }); ui.appendChild(E.coach);
    E.modalRoot = h('div', { id: 'modal-root', class: 'modal-root' }); ui.appendChild(E.modalRoot);

    bindTooltips(ui);
    window.addEventListener('resize', function () { UI.syncPanelToggles(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (UI.toggleEvidenceMenu(false)) return;
        if (modalActive && !modalActive.critical) { e.preventDefault(); modalActive.close(undefined); }
      }
    });
    UI.setTab(UI._tab);
    UI.setPhase(st().phase || PH.BOOT);
    UI.refresh();
    return UI;
  };

  /* ------------------------------------------------------------------ small controls */
  UI.callGame = function (fn, args, then) {
    var g = UI.game || {};
    if (typeof g[fn] !== 'function') { if (WS.DEBUG) console.warn('game.' + fn + ' not available'); return undefined; }
    try {
      var r = g[fn].apply(g, args || []);
      if (r && typeof r.then === 'function') { r.then(function (v) { if (then) then(v); }, function (err) { console.error(err); UI.toast('Something went wrong: ' + (err && err.message || err), 'bad'); }); }
      else if (then) then(r);
      return r;
    } catch (err) { console.error(err); UI.toast('Something went wrong: ' + (err && err.message || err), 'bad'); return undefined; }
  };
  UI.togglePanel = function (side, open) {
    var el = side === 'left' ? UI.els.panelLeft : UI.els.panelRight; if (!el) return;
    var narrow = window.innerWidth < 1100;
    if (narrow) {
      var willOpen = open == null ? !el.classList.contains('open') : !!open;
      el.classList.toggle('open', willOpen);
      if (willOpen) { var other = side === 'left' ? UI.els.panelRight : UI.els.panelLeft; if (other) other.classList.remove('open'); }
    } else {
      var show = open == null ? el.classList.contains('collapsed') : !!open;
      el.classList.toggle('collapsed', !show);
    }
    UI.syncPanelToggles();
  };
  UI.syncPanelToggles = function () {
    var narrow = window.innerWidth < 1100;
    [['left', UI.els.panelLeft, UI.els.toggleLeft], ['right', UI.els.panelRight, UI.els.toggleRight]].forEach(function (p) {
      if (!p[1] || !p[2]) return;
      var visible = narrow ? !p[1].classList.contains('open') : p[1].classList.contains('collapsed');
      p[2].style.display = visible ? 'inline-flex' : 'none';
    });
  };
  UI.toggleEvidenceMenu = function (force) {
    var m = UI.els.evidenceMenu; if (!m) return false;
    var wasOpen = !m.hidden;
    var open = force == null ? !wasOpen : !!force;
    m.hidden = !open;
    if (open) {
      var r = UI.els.btnEvidence.getBoundingClientRect();
      m.style.top = (r.bottom + 6) + 'px';
      m.style.left = Math.max(8, Math.min(window.innerWidth - 216, r.left)) + 'px';
      var first = m.querySelector('button'); if (first) first.focus();
    }
    return wasOpen && !open;
  };
  UI.setTab = function (tab) {
    UI._tab = tab;
    for (var k in UI.els.tabs) { var on = k === tab; UI.els.tabs[k].classList.toggle('active', on); UI.els.tabs[k].setAttribute('aria-selected', on ? 'true' : 'false'); }
    UI.renderTab();
  };
  UI.renderTab = function () {
    var t = UI._tab;
    try {
      if (t === 'projects' && UI.renderProjects) UI.renderProjects();
      else if (t === 'water' && UI.renderWater) UI.renderWater();
      else if (t === 'fire' && UI.renderFire) UI.renderFire();
      else if (t === 'log') UI.renderLog();
      else clear(UI.els.tabBody).appendChild(h('p', { class: 'muted' }, 'Loading…'));
    } catch (e) { console.error('tab render failed', e); clear(UI.els.tabBody).appendChild(h('p', { class: 'muted' }, 'This panel could not be rendered.')); }
  };
  UI.setSpeed = function (n) {
    n = [1, 2, 4].indexOf(Number(n)) >= 0 ? Number(n) : 1;
    UI._speed = n;
    for (var k in UI.els.speedBtns) UI.els.speedBtns[k].classList.toggle('active', Number(k) === n);
    UI.callGame('setSpeed', [n]);
  };
  UI.cycleOverlay = function () {
    var i = UI.OVERLAYS.indexOf(UI._overlay); UI.setOverlayLabel(UI.OVERLAYS[(i + 1) % UI.OVERLAYS.length]);
    UI.callGame('setOverlay', [UI._overlay]);
  };
  UI.setOverlayLabel = function (mode) {
    UI._overlay = UI.OVERLAYS.indexOf(mode) >= 0 ? mode : 'none';
    var m = UI.els.btnOverlay && UI.els.btnOverlay.querySelector('.mode'); if (m) m.textContent = UI.OVERLAY_NAMES[UI._overlay];
  };
  UI.primaryAction = function () {
    var p = UI._phase;
    if (UI._primaryOverride && typeof UI._primaryOverride.action === 'function') { try { UI._primaryOverride.action(); } catch (e) { console.error(e); } return; }
    if (p === PH.PLAN) UI.callGame('endSeason');
    else if (p === PH.FLOOD_PREP) { if (UI._placementResolve && UI._finishPlacement) UI._finishPlacement(); else UI.callGame('finishPlacement'); }
  };
  UI.setBusy = function (b) {
    if (!UI.els.ui) return;
    UI.els.ui.classList.toggle('busy', !!b);
    UI.updatePrimary();
  };
  UI.updatePrimary = function () {
    var E = UI.els, p = UI._phase, s = st(); if (!E.primary) return;
    var label = 'End Season ▶', enabled = false, warn = false;
    if (p === PH.PLAN) { label = 'End Season ▶'; enabled = true; }
    else if (p === PH.FLOOD_PREP) { label = 'Brace for storm ⛈'; enabled = true; warn = true; }
    else if (p === PH.LIVE) label = 'Season in progress…';
    else if (p === PH.FLOOD) label = 'Storm underway…';
    else if (p === PH.EVENT) label = 'Decide…';
    else if (p === PH.REPORT) label = 'Reviewing…';
    else if (p === PH.END) label = 'Game over';
    else label = 'Starting…';
    if (UI._primaryOverride) { if (UI._primaryOverride.label) label = UI._primaryOverride.label; if (UI._primaryOverride.enabled != null) enabled = !!UI._primaryOverride.enabled; }
    if (E.ui.classList.contains('busy')) enabled = false;
    E.primary.querySelector('.lbl').textContent = label;
    E.primary.disabled = !enabled;
    E.primary.classList.toggle('warn', warn);
    E.primary.title = p === PH.PLAN ? 'Space: end the ' + seasonName(s.season) + ' planning phase and run the season' : '';
  };

  /* ------------------------------------------------------------------ phase / toast / ticker / banner */
  /** info: { label, enabled, action, hint, ticker } (all optional) */
  UI.setPhase = function (phase, info) {
    UI._phase = phase || PH.BOOT; info = info || {};
    UI._primaryOverride = (info.label || info.action || info.enabled != null) ? { label: info.label, action: info.action, enabled: info.enabled } : null;
    var E = UI.els; if (!E.phaseChip) return;
    var names = { boot: 'Loading', intro: 'Welcome', plan: 'Plan', event: 'Event', live: 'Season live', flood_prep: 'Storm prep', flood: 'Flood', report: 'Report', end: 'Finished' };
    E.phaseChip.className = 'chip phase-chip ' + UI._phase;
    E.phaseChip.querySelector('.txt').textContent = (names[UI._phase] || UI._phase) + (info.hint ? ' · ' + info.hint : '');
    if (info.ticker) UI.ticker(info.ticker);
    UI.updatePrimary();
    if (UI._phase !== PH.FLOOD_PREP && !E.placement.hidden && !UI._placementResolve) E.placement.hidden = true;
  };
  UI.toast = function (text, kind) {
    var E = UI.els; if (!E.toasts) return;
    var t = h('div', { class: 'toast ' + (kind || 'info'), role: 'status' }, [h('span', { 'aria-hidden': 'true' }, (UI.KIND_ICONS[kind] || 'ℹ') + ' '), String(text == null ? '' : text)]);
    E.toasts.appendChild(t);
    while (E.toasts.children.length > 5) E.toasts.removeChild(E.toasts.firstChild);
    var ttl = kind === 'bad' ? 7000 : 4500;
    setTimeout(function () { t.classList.add('leaving'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 240); }, ttl);
    return t;
  };
  UI.ticker = function (text) {
    var E = UI.els; if (!E.ticker) return;
    var tx = E.ticker.querySelector('.txt'); tx.textContent = String(text == null ? '' : text);
    tx.classList.remove('fresh'); void tx.offsetWidth; tx.classList.add('fresh');
  };
  /** info: { acres, zones:[names]|zoneNames|zoneIds, crewFocus, name, perimeterCells, threatened:[names] } or null */
  UI.showFireBanner = function (info) {
    var E = UI.els; if (!E.fireBanner) return;
    if (!info) { E.fireBanner.hidden = true; return; }
    var names = info.threatened || info.zoneNames || info.zones || [];
    if (!Array.isArray(names)) names = [names];
    names = names.map(function (z) { if (z && typeof z === 'object') return z.name || ('Zone ' + z.id); var zz = UI.zoneName(z); return zz; }).filter(Boolean);
    var focus = info.crewFocus ? ' · Crews focused on ' + info.crewFocus : '';
    E.fireBanner.querySelector('.t').textContent = (info.name || 'Wildfire') + (isFinite(Number(info.acres)) ? ' — ' + Math.round(info.acres).toLocaleString() + ' acres' : '');
    E.fireBanner.querySelector('.d').textContent = (names.length ? 'Threatening ' + names.join(', ') : 'Spreading through the watershed') + focus;
    E.fireBanner.hidden = false;
  };
  UI.zoneName = function (zoneId) {
    if (zoneId == null) return '';
    if (typeof zoneId === 'string' && !/^\d+$/.test(zoneId)) return zoneId;
    var w = wd();
    try { if (typeof w.zoneById === 'function') { var z = w.zoneById(Number(zoneId)); if (z && z.name) return z.name; } } catch (e) { /* ignore */ }
    var zs = w.zones || [];
    for (var i = 0; i < zs.length; i++) if (zs[i] && zs[i].id === Number(zoneId)) return zs[i].name || ('Zone ' + zoneId);
    return 'Zone ' + zoneId;
  };
  UI.flashOutcome = function (key) {
    var el = UI.els.outcome && UI.els.outcome[key]; if (!el) return;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 1900);
  };

  /* ------------------------------------------------------------------ refresh */
  UI.refresh = function () {
    var E = UI.els; if (!E.ui) return;
    var s = st();
    var seasonStr = seasonName(s.season);
    E.date.querySelector('.v').textContent = 'Year ' + fin(s.year, 1) + (s.years ? ' of ' + s.years : '') + ' · ' + seasonStr;
    var bv = E.budget.querySelector('.v');
    clear(bv); bv.classList.toggle('neg', fin(s.budget) < 0);
    append(bv, [money(s.budget), h('span', { class: 'em' }, '  · fund ' + money(s.emergencyFund))]);
    var o = s.outcomes || {};
    OUT_KEYS.forEach(function (k) {
      var v = clamp(o[k], 0, 100), el = E.outcome[k];
      el.querySelector('.n').textContent = Math.round(v);
      el.querySelector('.meter > i').style.width = v + '%';
    });
    var R = resilienceOf(s), g = gradeOf(R);
    E.score.querySelector('.big').textContent = Math.round(R);
    E.score.querySelector('.g').textContent = g.letter;
    E.score.querySelector('.title').textContent = g.title || 'Resilience score';
    var cs = document.getElementById('cond-season'); if (cs) cs.textContent = seasonStr + ' · Y' + fin(s.year, 1);
    if (s.phase && s.phase !== UI._phase && !UI._primaryOverride) UI._phase = s.phase;
    UI.updatePrimary();
    E.phaseChip.className = 'chip phase-chip ' + UI._phase;
    UI.renderConditions();
    UI.renderTab();
    var badge = E.tabs.log && E.tabs.log.querySelector('.badge'); if (badge) badge.hidden = true;
    var fire = (s.fire || {}).activeFire;
    if (fire && typeof fire === 'object' && E.fireBanner.hidden && isFinite(Number(fire.acres))) UI.showFireBanner(fire);
    if (!fire && !E.fireBanner.hidden && UI._phase !== PH.LIVE) UI.showFireBanner(null);
    UI.syncPanelToggles();
  };

  /* ------------------------------------------------------------------ Conditions panel */
  var DANGER_LABELS = ['Low', 'Moderate', 'High', 'Very High', 'Extreme'];
  function dangerLevel(fd, label) {
    var i = DANGER_LABELS.indexOf(label);
    if (i >= 0) return i;
    fd = clamp(fd, 0, 1);
    return fd < 0.2 ? 0 : fd < 0.4 ? 1 : fd < 0.6 ? 2 : fd < 0.8 ? 3 : 4;
  }
  function gauge(opts) {
    var g = h('div', { class: 'gauge', 'data-cond': opts.id });
    g.appendChild(h('div', { class: 'k' }, [opts.label, opts.tip ? UI.info(opts.tip) : null]));
    if (opts.spark) g.appendChild(h('div', { class: 'spark' }, opts.spark));
    g.appendChild(h('div', { class: 'v' }, opts.value));
    if (opts.bar) g.appendChild(h('div', { class: 'bar' }, opts.bar));
    if (opts.sub) g.appendChild(h('div', { class: 'sub' }, opts.sub));
    return g;
  }
  function rangeText(v, unc, unitFn) {
    var lo = v * (1 - unc), hi = v * (1 + unc);
    return unitFn(lo) + '–' + unitFn(hi);
  }
  UI.renderConditions = function () {
    var E = UI.els; if (!E.conditions) return;
    var s = st(), cl = s.climate || {}, rv = s.reservoir || {};
    var unc = clamp(cl.uncertainty == null ? 0.15 : cl.uncertainty, 0, 0.9), uncertain = unc > 0.1;
    var cap = fin(rv.capacityAF, (C.HYDRO || {}).RESERVOIR_CAPACITY_AF || 42000);
    var stor = clamp(rv.storageAF, 0, Math.max(cap, 1));
    var box = clear(E.conditions);
    var uncTip = uncertain ? ' Measurement uncertainty is ±' + Math.round(unc * 100) + '% — funding streamgages narrows this range.' : '';
    if (uncertain) box.appendChild(h('div', { class: 'note warn small' }, ['Readings are estimates (±' + Math.round(unc * 100) + '%). ', h('b', {}, 'Streamgages'), ' would narrow these ranges.']));

    /* snowpack */
    var sp = fin(cl.snowpackPct, 100), swe = fin(cl.snowSWEin, 0);
    box.appendChild(gauge({
      id: 'snowpack', label: 'Snowpack',
      tip: 'Snow water equivalent (SWE) is the water stored in the snowpack, measured on April 1 against the long-term median. Roughly 70–80% of Colorado\'s streamflow starts as snowmelt, so this is the best early forecast of the year\'s supply.' + uncTip,
      spark: UI.sparkline(historyValues('snowpackPct'), { color: '#bfe1f7', min: 0 }),
      value: uncertain ? [h('span', { class: 'range' }, '≈ ' + rangeText(sp, unc, function (v) { return Math.round(v) + '%'; })), h('span', { class: 'unit' }, 'of avg')] : [Math.round(sp) + '%', h('span', { class: 'unit' }, 'of avg')],
      sub: 'SWE ' + (uncertain ? '≈ ' + rangeText(swe, unc, function (v) { return num(v, 1); }) : num(swe, 1)) + ' in · avg ' + fin((C.HYDRO || {}).AVG_SNOW_SWE_IN, 18) + ' in'
    }));
    /* precipitation */
    box.appendChild(gauge({
      id: 'precip', label: 'Precipitation',
      tip: 'Rain and snow this season, in inches. Summer monsoon moisture and fall storms matter most after a fire: intense rain on a burn scar produces flash floods and debris flows.',
      spark: UI.sparkline(historyValues('precipIn'), { color: '#7dd3c0', min: 0 }),
      value: [num(cl.precipIn, 1), h('span', { class: 'unit' }, 'in')]
    }));
    /* temperature anomaly */
    var ta = fin(cl.tempAnomF);
    box.appendChild(gauge({
      id: 'temp', label: 'Temperature anomaly',
      tip: 'Departure from the seasonal average in °F. Warm seasons melt snow early, dry out fuels and soils, raise crop water demand and evaporate reservoir water.',
      spark: UI.sparkline(historyValues('tempAnomF'), { color: ta > 2 ? '#ff7a33' : '#e9c46a' }),
      value: [signed(ta, 1) + ' °F', h('span', { class: 'unit' }, ta > 3 ? 'hot' : ta < -2 ? 'cool' : 'near normal')]
    }));
    /* reservoir */
    var spct = cap > 0 ? stor / cap * 100 : 0;
    box.appendChild(gauge({
      id: 'reservoir', label: 'Reservoir storage',
      tip: 'Water in storage in acre-feet (1 AF ≈ 326,000 gallons, about what two Colorado households use in a year). Storage buffers dry years — but the bottom ' + fin((C.HYDRO || {}).RESERVOIR_DEAD_POOL_AF, 4000).toLocaleString() + ' AF is dead pool that cannot be delivered.',
      spark: UI.sparkline(historyValues('storageAF'), { color: UI.COLORS.water, min: 0, max: cap }),
      value: [af(stor), h('span', { class: 'unit' }, Math.round(spct) + '% full')],
      bar: h('div', { class: 'meter' }, [h('i', { class: 'water', style: { width: clamp(spct, 0, 100) + '%' } }), h('span', { class: 'mark', style: { left: clamp(fin((C.HYDRO || {}).RESERVOIR_DEAD_POOL_AF, 4000) / Math.max(cap, 1) * 100, 0, 100) + '%' }, 'data-tip': 'Dead pool' })])
    }));
    /* soil moisture */
    var sm = clamp(cl.soilMoisturePct, 0, 100);
    box.appendChild(gauge({
      id: 'soil', label: 'Soil moisture',
      tip: 'Percent of field capacity. Dry soils absorb the first snowmelt before it reaches the stream (lower runoff efficiency), stress crops and forests, and let fires spread faster.',
      spark: UI.sparkline(historyValues('soilMoisturePct'), { color: '#a5843c', min: 0, max: 100 }),
      value: [Math.round(sm) + '%'],
      bar: h('div', { class: 'meter thin' }, h('i', { class: 'turbid', style: { width: sm + '%' } }))
    }));
    /* streamflow */
    var cfs = fin(cl.streamflowCfs), minf = fin((C.HYDRO || {}).MIN_FLOW_CFS, 14);
    box.appendChild(gauge({
      id: 'flow', label: 'Streamflow below dam',
      tip: 'Cubic feet per second in Bitterbrush Creek below the dam. The instream-flow right needs ' + minf + ' cfs to keep fish and the riparian corridor alive; hydropower and rafting also depend on releases.' + uncTip,
      spark: UI.sparkline(historyValues('streamflowCfs'), { color: '#38bdf8', min: 0 }),
      value: uncertain ? [h('span', { class: 'range' }, '≈ ' + rangeText(cfs, unc, function (v) { return Math.round(v).toString(); })), h('span', { class: 'unit' }, 'cfs')] : [Math.round(cfs).toLocaleString(), h('span', { class: 'unit' }, 'cfs')],
      sub: cfs < minf ? h('span', { style: { color: '#ffb3ba' } }, '⚠ below the ' + minf + ' cfs minimum flow') : 'Minimum flow ' + minf + ' cfs met'
    }));
    /* fire danger */
    var lvl = dangerLevel(cl.fireDanger, cl.fireDangerLabel);
    box.appendChild(gauge({
      id: 'danger', label: 'Fire danger',
      tip: 'Combines heat, dryness, soil moisture, wind and how much fuel has built up in the forest. Colorado\'s biggest fires (2020) came after a hot, dry summer with a century of accumulated fuel.',
      spark: UI.sparkline(historyValues('fireDanger'), { color: UI.COLORS.fire, min: 0, max: 1 }),
      value: [cl.fireDangerLabel || DANGER_LABELS[lvl], h('span', { class: 'unit' }, num(clamp(cl.fireDanger, 0, 1) * 100, 0) + '/100')],
      bar: h('div', { class: 'dial', 'aria-label': 'Fire danger level ' + (lvl + 1) + ' of 5' }, [0, 1, 2, 3, 4].map(function (i) { return h('i', { class: i <= lvl ? 'on l' + (lvl + 1) : '' }); })),
      sub: 'Wind ' + Math.round(fin(cl.windMph)) + ' mph' + (cl.windDirRad != null ? ' from the ' + compass(cl.windDirRad) : '')
    }));
    /* drought */
    var dc = String(cl.drought || 'None'), di = ['D0', 'D1', 'D2', 'D3', 'D4'].indexOf(dc);
    box.appendChild(gauge({
      id: 'drought', label: 'Drought status',
      tip: 'U.S. Drought Monitor categories: D0 abnormally dry, D1 moderate, D2 severe, D3 extreme, D4 exceptional. Built from cumulative precipitation deficit; Colorado has spent much of the 21st century in some level of drought.',
      value: [dc === 'None' ? 'None' : dc, h('span', { class: 'unit' }, ['', 'abnormally dry', 'moderate', 'severe', 'extreme', 'exceptional'][di + 1] || '')],
      bar: h('div', { class: 'drought' }, [0, 1, 2, 3, 4].map(function (i) { return h('i', { class: i <= di ? 'on d' + i : '' }); }))
    }));
    /* population */
    box.appendChild(gauge({
      id: 'pop', label: 'Population',
      tip: 'Residents served. Every new home adds demand at ~' + fin((C.HYDRO || {}).GPCD, 118) + ' gallons per person per day — and homes in the wildland-urban interface add fire exposure.',
      spark: UI.sparkline(historyValues('population'), { color: '#c9c4b8' }),
      value: [Math.round(fin(s.population)).toLocaleString(), h('span', { class: 'unit' }, s.growthRate != null ? '+' + num(fin(s.growthRate) * 100, 1) + '%/yr' : '')]
    }));
    /* water quality */
    var turb = clamp(rv.turbidity, 0, 1), ash = clamp(rv.ashContam, 0, 1), alg = clamp(rv.algae, 0, 1);
    box.appendChild(gauge({
      id: 'quality', label: 'Water quality',
      tip: 'Turbidity is suspended sediment; ash carries nutrients, metals and organic carbon that treatment plants struggle with. After the 2020 fires, Front Range utilities faced years of sediment and taste-and-odour problems.',
      spark: UI.sparkline(historyValues('turbidity'), { color: '#a5843c', min: 0, max: 1 }),
      value: [turb < 0.15 && ash < 0.1 ? 'Clear' : (ash > 0.4 || turb > 0.6 ? 'Contaminated' : 'Turbid'), h('span', { class: 'unit' }, 'turbidity ' + Math.round(turb * 100) + ' · ash ' + Math.round(ash * 100) + (alg > 0.2 ? ' · algae ' + Math.round(alg * 100) : ''))],
      bar: h('div', { class: 'stack' }, [
        h('div', { class: 'meter thin', 'data-tip': 'Turbidity ' + Math.round(turb * 100) + '/100' }, h('i', { class: 'turbid', style: { width: turb * 100 + '%' } })),
        h('div', { class: 'meter thin', 'data-tip': 'Ash contamination ' + Math.round(ash * 100) + '/100' }, h('i', { class: 'ash', style: { width: ash * 100 + '%' } }))
      ])
    }));
    if (cl.description) box.appendChild(h('p', { class: 'small muted', style: { marginTop: '8px' } }, String(cl.description)));
  };
  function compass(rad) {
    var d = ((fin(rad) * 180 / Math.PI) % 360 + 360) % 360;
    var names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return names[Math.round(d / 45) % 8];
  }

  /* ------------------------------------------------------------------ Log tab */
  function logEntryNode(e, idx) {
    var text = typeof e === 'string' ? e : (e && (e.text || e.label || e.message)) || '';
    var kind = (e && e.kind) || 'info';
    return h('div', { class: 'entry ' + kind, 'data-i': idx }, [
      h('span', { class: 'ic', 'aria-hidden': 'true' }, UI.KIND_ICONS[kind] || 'ℹ'),
      h('span', { class: 'when' }, turnLabel(e)),
      h('span', { class: 'grow' }, String(text))
    ]);
  }
  UI.logEntryNode = logEntryNode;
  UI.renderLog = function (targetEl, limit) {
    var box = targetEl || UI.els.tabBody; if (!box) return;
    clear(box);
    var log = (st().log || []).slice();
    if (!log.length) { box.appendChild(h('p', { class: 'muted' }, 'Nothing logged yet. Decisions, events and their consequences will appear here.')); return; }
    var list = h('div', { class: 'log' });
    var n = limit || 200, start = Math.max(0, log.length - n);
    for (var i = log.length - 1; i >= start; i--) list.appendChild(logEntryNode(log[i], i));
    box.appendChild(h('div', { class: 'row between', style: { marginBottom: '6px' } }, [h('span', { class: 'label' }, log.length + ' entries · newest first'), h('button', { class: 'tiny ghost', type: 'button', onclick: function () { if (UI.showLog) UI.showLog(); } }, 'Timeline ↗')]));
    box.appendChild(list);
  };
})();
