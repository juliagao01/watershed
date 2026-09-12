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
  var PH = C.PHASES || { BOOT: 'boot', INTRO: 'intro', PLAN: 'plan', EVENT: 'event', LIVE: 'live', FLOOD_PREP: 'flood_prep', FLOOD: 'flood', FIRE: 'fire', STORM: 'storm', REPORT: 'report', END: 'end' };
  var PH_FIRE = PH.FIRE || 'fire', PH_STORM = PH.STORM || 'storm';

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
  /** Small persisted UI preference (localStorage, guarded). pref(key) → value|null; pref(key, value) stores. */
  UI.pref = function (key, value) {
    var k = 'watershed.ui.' + key;
    try {
      if (value === undefined) { var raw = root.localStorage ? root.localStorage.getItem(k) : null; return raw == null ? null : JSON.parse(raw); }
      if (root.localStorage) root.localStorage.setItem(k, JSON.stringify(value));
    } catch (e) { /* storage unavailable or full: ignore */ }
    return value === undefined ? null : value;
  };

  /* ------------------------------------------------------------------ portraits (WS.Faces) */
  /** UI.portrait(spec, size, opts) → <canvas class="portrait"> (HiDPI-crisp). opts: { expression:'neutral'|'worried'|'happy', bg: hex|null, title } */
  UI.portrait = function (spec, size, opts) {
    size = Math.max(12, Math.round(Number(size) || 40)); opts = opts || {};
    var dpr = Math.min(3, Math.max(1, Number(root.devicePixelRatio) || 1));
    var c = h('canvas', { class: 'portrait', width: Math.round(size * dpr), height: Math.round(size * dpr), role: opts.title ? 'img' : null, 'aria-label': opts.title || null, 'aria-hidden': opts.title ? null : 'true' });
    c.style.width = size + 'px'; c.style.height = size + 'px';
    try { if (WS.Faces && typeof WS.Faces.draw === 'function') WS.Faces.draw(c, spec, { expression: opts.expression, bg: opts.bg === undefined ? '#efe4d0' : opts.bg }); }
    catch (e) { console.error('portrait failed', e); }
    return c;
  };
  /** Advisor character by id (WS.Advisors.byId or a CHARACTERS scan) → object|null */
  UI.characterById = function (id) {
    if (id == null) return null;
    var A = WS.Advisors || {};
    try { if (typeof A.byId === 'function') { var c = A.byId(id); if (c) return c; } } catch (e) { /* ignore */ }
    var list = A.CHARACTERS || [];
    if (!Array.isArray(list)) list = Object.keys(list).map(function (k) { return list[k]; });
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  };
  /** Face spec for a bubble spec / character / recommendation ({face} directly, else looked up by id/characterId) → spec|null */
  UI.faceOf = function (o) {
    if (!o || typeof o !== 'object') return null;
    if (o.face && typeof o.face === 'object') return o.face;
    var ch = UI.characterById(o.id != null ? o.id : o.characterId);
    return (ch && ch.face && typeof ch.face === 'object') ? ch.face : null;
  };
  /** Player (game.state.player) → { name, face, title } with defaults, or null when no player has been created yet. */
  UI.player = function () {
    var p = st().player;
    if (!p || typeof p !== 'object') return null;
    return { name: String(p.name || 'Director'), face: (p.face && typeof p.face === 'object') ? p.face : (WS.Faces ? WS.Faces.DEFAULT : {}), title: String(p.title || 'Water-Resilience Director') };
  };
  /** Small "portrait + name + title" badge for the player (report headers, case-study links). size defaults to 28. Returns null when there is no player. */
  UI.playerBadge = function (size, opts) {
    var p = UI.player(); if (!p) return null; opts = opts || {};
    return h('div', { class: 'player-badge' + (opts.className ? ' ' + opts.className : '') }, [
      UI.portrait(p.face, size || 28, { expression: opts.expression, title: p.name }),
      opts.nameless ? null : h('div', { class: 'grow' }, [h('div', { class: 'pn' }, p.name), opts.noTitle ? null : h('div', { class: 'pt' }, p.title)])
    ]);
  };

  /* ------------------------------------------------------------------ text trimming (player feedback: less text) */
  /** Split prose into sentences (keeps the terminal punctuation). Abbreviations like "Dr." / "Capt." / "U.S." and decimals stay intact. */
  UI.sentences = function (text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!s) return [];
    var guarded = s.replace(/\b(Dr|Capt|Mr|Mrs|Ms|St|No|vs|approx|U\.S|a\.m|p\.m)\./g, function (m) { return m.replace(/\./g, ''); }).replace(/(\d)\.(\d)/g, '$1$2');
    var parts = guarded.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [guarded];
    return parts.map(function (p) { return p.replace(//g, '.').trim(); }).filter(Boolean);
  };
  /** First `n` sentences of `text` (default 1). */
  UI.firstSentence = function (text, n) {
    var parts = UI.sentences(text); n = Math.max(1, fin(n, 1));
    return parts.slice(0, n).join(' ');
  };
  /** Everything after the first `n` sentences ('' if none). */
  UI.restSentences = function (text, n) { return UI.sentences(text).slice(Math.max(1, fin(n, 1))).join(' '); };
  /** Trim to ≤ maxWords, cutting at a sentence boundary when one fits, otherwise at a word boundary + "…". */
  UI.short = function (text, maxWords) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    maxWords = Math.max(3, fin(maxWords, 22));
    var words = s ? s.split(' ') : [];
    if (words.length <= maxWords) return s;
    var parts = UI.sentences(s), acc = '', count = 0;
    for (var i = 0; i < parts.length; i++) {
      var w = parts[i].split(' ').length;
      if (count + w > maxWords) break;
      acc += (acc ? ' ' : '') + parts[i]; count += w;
    }
    if (acc) return acc + (count < words.length ? ' …' : '');
    var cut = words.slice(0, maxWords).join(' ').replace(/[,;:\-–—]+$/, '');
    return cut + '…';
  };
  /** Lead text + a "more…" disclosure for the rest. opts: { sentences:2, className, moreLabel, lessLabel } → element (or null when text empty). */
  UI.disclosure = function (text, opts) {
    opts = opts || {};
    var n = Math.max(1, fin(opts.sentences, 2));
    var lead = UI.firstSentence(text, n), rest = UI.restSentences(text, n);
    if (!lead) return null;
    var wrap = h('div', { class: 'disclose' + (opts.className ? ' ' + opts.className : '') });
    var leadEl = h('span', { class: 'lead-text' }, lead);
    wrap.appendChild(leadEl);
    if (rest) {
      var restEl = h('span', { class: 'rest', hidden: true }, ' ' + rest);
      var btn = h('button', { class: 'more', type: 'button', 'aria-expanded': 'false' }, opts.moreLabel || 'more…');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = restEl.hidden; restEl.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = open ? (opts.lessLabel || 'less') : (opts.moreLabel || 'more…');
      });
      wrap.appendChild(restEl); wrap.appendChild(document.createTextNode(' ')); wrap.appendChild(btn);
    }
    return wrap;
  };

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
  /** opts: { title, eyebrow, icon, head:<element>, className, critical, render(body, close), foot(footEl, close), onClose } → Promise */
  UI.modal = function (opts) {
    return new Promise(function (resolve) { modalQueue.push({ opts: opts || {}, resolve: resolve }); pumpModal(); });
  };
  UI.modalQueueLength = function () { return modalQueue.length + (modalActive ? 1 : 0); };
  function pumpModal() {
    if (modalActive || !modalQueue.length) return;
    var m = modalQueue.shift(); modalActive = m;
    var o = m.opts, rootEl = UI.els.modalRoot;
    if (!rootEl) { m.resolve(undefined); modalActive = null; return; }
    if (UI.hideBubble) UI.hideBubble();   /* an advisor bubble never sits on top of a dialog */
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
        h('div', { class: 'mtitle' }, [o.eyebrow ? h('span', { class: 'eyebrow' }, o.eyebrow) : null, o.title || '']),
        (o.head && o.head.nodeType) ? h('div', { class: 'head-extra' }, o.head) : null   /* e.g. the player's portrait badge */
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
    /* "Advisors" opens the full Evidence Board on demand (topic popover). The in-town 3D advisors are the everyday path. */
    E.btnEvidence = h('button', { id: 'btn-advisors', type: 'button', 'aria-haspopup': 'menu', 'data-tip': 'Open the Evidence Board: six advisors, one set of numbers, different conclusions' }, [h('span', { 'aria-hidden': 'true' }, '🗣 '), h('span', { class: 'txt' }, 'Advisors')]);
    E.btnEvidence.addEventListener('click', function (e) { e.stopPropagation(); UI.toggleEvidenceMenu(); });
    E.btnAdvisors = E.btnEvidence;
    E.btnCases = h('button', { id: 'btn-cases', type: 'button', 'data-tip': 'Case studies from Colorado\'s recent fires, floods and water fights' }, [h('span', { class: 'txt' }, 'Cases'), h('span', { 'aria-hidden': 'true' }, ' 📚')]);
    E.btnCases.addEventListener('click', function () { if (UI.showCases) UI.showCases(); });
    E.btnSave = h('button', { id: 'btn-save', type: 'button', 'data-tip': 'Save to this browser' }, [h('span', { class: 'txt' }, 'Save'), h('span', { 'aria-hidden': 'true' }, ' 💾')]);
    E.btnSave.addEventListener('click', function () { UI.callGame('save', [], function (r) { UI.toast(r === false ? 'Save failed' : 'Game saved', r === false ? 'bad' : 'good'); UI.refresh(); }); });
    E.btnLoad = h('button', { id: 'btn-load', type: 'button', 'data-tip': 'Load the saved game' }, [h('span', { class: 'txt' }, 'Load'), h('span', { 'aria-hidden': 'true' }, ' 📂')]);
    E.btnLoad.addEventListener('click', function () { UI.callGame('load', [], function (r) { UI.toast(r === false ? 'No saved game found' : 'Game loaded', r === false ? 'warn' : 'good'); UI.refresh(); }); });
    E.btnHelp = h('button', { id: 'btn-help', type: 'button', 'data-tip': 'Controls, phases and how scoring works' }, [h('span', { class: 'txt' }, 'Help'), h('span', { 'aria-hidden': 'true' }, ' ?')]);
    E.btnHelp.addEventListener('click', function () { if (UI.showHelp) UI.showHelp(); });
    E.btnrow = h('div', { class: 'btnrow' }, [E.btnOverlay, E.btnEvidence, E.btnCases, E.btnSave, E.btnLoad, E.btnHelp]);
    /* crisis chip: shown in the top bar while a fire/storm is fought live */
    E.crisisChip = h('div', { id: 'crisis-chip', class: 'crisis-chip', hidden: true, role: 'status', 'aria-live': 'polite' }, [h('span', { class: 'siren', 'aria-hidden': 'true' }, '🚨'), h('span', { class: 'txt' }, '')]);
    /* player portrait chip (far left): portrait + name + title; click flies the camera to the player figure */
    E.playerChip = h('button', { id: 'player-chip', class: 'player-chip', type: 'button', hidden: true, 'data-tip': 'Your character — click to fly to where they are' });
    E.playerChip.addEventListener('click', function () { UI.callGame('focusPlayer'); });
    E.playerChipKey = '';
    E.topbar.appendChild(E.playerChip);
    E.topbar.appendChild(E.brand); E.topbar.appendChild(E.date); E.topbar.appendChild(E.budget); E.topbar.appendChild(E.crisisChip); E.topbar.appendChild(E.outcomes); E.topbar.appendChild(E.score); E.topbar.appendChild(E.btnrow);
    ui.appendChild(E.topbar);

    /* evidence topic menu (popover) */
    E.evidenceMenu = h('div', { id: 'evidence-menu', class: 'menu advisors-menu', hidden: true, role: 'menu' });
    UI.buildEvidenceMenu();
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
    /* The Log tab is gone (player feedback: too much text). UI.renderLog / UI.showLog stay; the season report links to them. */
    var tabDefs = [['projects', 'Projects'], ['water', 'Water'], ['fire', 'Fire']];
    E.tabbar = h('div', { class: 'tabs', role: 'tablist' }, tabDefs.map(function (t) {
      var b = h('button', { type: 'button', role: 'tab', 'data-tab': t[0], 'aria-selected': 'false', onclick: function () { UI.setTab(t[0]); } }, [t[1], h('span', { class: 'badge', hidden: true }, '')]);
      E.tabs[t[0]] = b; return b;
    }));
    if (UI._tab === 'log') UI._tab = 'projects';
    E.panelRight = h('section', { id: 'panel-right', class: 'panel side right', 'aria-label': 'Actions' }, [
      h('div', { class: 'head' }, [h('span', { class: 'title' }, 'Actions'), h('div', { class: 'row' }, [h('button', { class: 'ghost tiny', type: 'button', 'aria-label': 'Collapse actions', onclick: function () { UI.togglePanel('right', false); } }, '▶')])]),
      E.tabbar,
      E.tabBody = h('div', { class: 'body', id: 'tab-body', role: 'tabpanel' })
    ]);
    ui.appendChild(E.panelRight);
    E.toggleRight = h('button', { class: 'panel-toggle right', type: 'button', 'aria-label': 'Show actions', onclick: function () { UI.togglePanel('right'); } }, '🛠 Actions');
    ui.appendChild(E.toggleRight);

    /* placement toolbar */
    E.placement = h('div', { id: 'placement', class: 'placement panel', hidden: true, role: 'region', 'aria-label': 'Storm preparation' });
    ui.appendChild(E.placement);

    /* tactical HUD (live fire / storm) + centre alerts */
    E.tactical = h('div', { id: 'tactical', class: 'tactical panel', hidden: true, role: 'region', 'aria-label': 'Crisis response' });
    ui.appendChild(E.tactical);
    E.alert = h('div', { id: 'alert', class: 'alert', hidden: true, role: 'alert', 'aria-live': 'assertive' });
    ui.appendChild(E.alert);

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
    /* advisor speech bubble (anchored to a 3D avatar by UI.moveBubble) + the one-time hint */
    E.bubble = h('div', { id: 'advisor-bubble', class: 'bubble', hidden: true, role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Advisor' }); ui.appendChild(E.bubble);
    E.advisorHint = h('div', { id: 'advisor-hint', class: 'advisor-hint', hidden: true, role: 'status' }); ui.appendChild(E.advisorHint);
    E.modalRoot = h('div', { id: 'modal-root', class: 'modal-root' }); ui.appendChild(E.modalRoot);
    BUB.el = E.bubble; BUB.visible = false;

    bindTooltips(ui);
    /* clicking anywhere outside the bubble (map, panels, buttons) dismisses it; the click that opened it is ignored */
    document.addEventListener('pointerdown', function (e) {
      if (!BUB.visible || Date.now() < BUB.ignoreUntil) return;
      if (E.bubble.contains(e.target)) return;
      UI.hideBubble();
    }, true);
    window.addEventListener('resize', function () { UI.syncPanelToggles(); });
    document.addEventListener('keydown', function (e) {
      var tag = ((e.target && e.target.tagName) || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || !!(e.target && e.target.isContentEditable);
      if (e.key === 'Escape') {
        if (UI.toggleEvidenceMenu(false)) return;
        if (!modalActive && UI.bubbleVisible()) { e.preventDefault(); UI.hideBubble(); return; }
        if (modalActive && !modalActive.critical) { e.preventDefault(); modalActive.close(undefined); return; }
        if (!modalActive && UI.tacticalVisible()) { e.preventDefault(); UI.tacticalDeselect(); }
        return;
      }
      /* crisis keys: only while the tactical HUD is up and no modal is open */
      if (!UI.tacticalVisible() || modalActive || typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); UI.tacticalTogglePause(); return; }
      if (/^[1-5]$/.test(e.key)) { e.preventDefault(); UI.tacticalSelectIndex(Number(e.key) - 1); }
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
  /** (Re)build the Advisors popover: each advisor with a 24 px portrait (click → game.askAdvisor), then the Evidence Board topics. */
  UI.buildEvidenceMenu = function () {
    var m = UI.els.evidenceMenu; if (!m) return;
    clear(m);
    var list = (WS.Advisors && WS.Advisors.CHARACTERS) || [];
    if (!Array.isArray(list)) list = Object.keys(list).map(function (k) { return list[k]; });
    if (list.length) {
      m.appendChild(h('div', { class: 'label' }, 'Advisors'));
      list.forEach(function (ch) {
        if (!ch) return;
        var face = UI.faceOf(ch);
        m.appendChild(h('button', { type: 'button', role: 'menuitem', class: 'adv-row', style: { '--adv': ch.color || '#4aa3df' }, 'data-advisor': ch.id || '', onclick: function () {
          UI.toggleEvidenceMenu(false);
          if (UI.game && typeof UI.game.askAdvisor === 'function') UI.callGame('askAdvisor', [ch.id]);
          else UI.callGame('openEvidence', [UI.EVIDENCE_TOPICS[0][0]]);
        } }, [
          face ? UI.portrait(face, 24) : h('span', { class: 'av', style: { background: ch.color || '#4aa3df' }, 'aria-hidden': 'true' }, ch.avatarEmoji || '🧑'),
          h('div', { class: 'grow' }, [h('div', { class: 'an' }, ch.name || 'Advisor'), ch.role ? h('div', { class: 'ar' }, ch.role) : null])
        ]));
      });
      m.appendChild(h('hr', { class: 'rule' }));
    }
    m.appendChild(h('div', { class: 'label' }, 'Ask everyone about…'));
    UI.EVIDENCE_TOPICS.forEach(function (t) {
      m.appendChild(h('button', { type: 'button', role: 'menuitem', onclick: function () { UI.toggleEvidenceMenu(false); UI.callGame('openEvidence', [t[0]]); } }, t[1]));
    });
  };
  /** Toggle the advisor popover. `anchor` (optional) is the button it hangs from; defaults to the top-bar Advisors button. */
  UI.toggleEvidenceMenu = function (force, anchor) {
    var m = UI.els.evidenceMenu; if (!m) return false;
    var wasOpen = !m.hidden;
    var open = force == null ? !wasOpen : !!force;
    m.hidden = !open;
    if (open) {
      UI.buildEvidenceMenu();   /* advisors may have loaded after init; portraits are cheap (6 × 24 px) */
      var a = (anchor && anchor.getBoundingClientRect) ? anchor : UI.els.btnEvidence;
      var r = a.getBoundingClientRect();
      m.style.top = (r.bottom + 6) + 'px';
      m.style.left = Math.max(8, Math.min(window.innerWidth - 266, r.left)) + 'px';
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
    else if (p === PH_FIRE) label = 'Fighting fire 🔥';
    else if (p === PH_STORM) label = 'Storm defense 🌊';
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
    /* no auto-pulse on the Advisors button any more: the 3D advisors in town carry the "someone has something to say" signal */
  };

  /* ------------------------------------------------------------------ phase / toast / ticker / banner */
  /** info: { label, enabled, action, hint, ticker } (all optional) */
  UI.setPhase = function (phase, info) {
    UI._phase = phase || PH.BOOT; info = info || {};
    UI._primaryOverride = (info.label || info.action || info.enabled != null) ? { label: info.label, action: info.action, enabled: info.enabled } : null;
    var E = UI.els; if (!E.phaseChip) return;
    var names = { boot: 'Loading', intro: 'Welcome', plan: 'Plan', event: 'Event', live: 'Season live', flood_prep: 'Storm prep', flood: 'Flood', fire: 'Fighting fire', storm: 'Storm defense', report: 'Report', end: 'Finished' };
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
    UI.renderPlayerChip();
    if (s.phase && s.phase !== UI._phase && !UI._primaryOverride) UI._phase = s.phase;
    UI.updatePrimary();
    E.phaseChip.className = 'chip phase-chip ' + UI._phase;
    UI.renderConditions();
    UI.renderTab();
    var badge = E.tabs.log && E.tabs.log.querySelector('.badge'); if (badge) badge.hidden = true;
    var fire = (s.fire || {}).activeFire;
    if (fire && typeof fire === 'object' && E.fireBanner.hidden && isFinite(Number(fire.acres)) && !UI.tacticalVisible()) UI.showFireBanner(fire);
    if (!fire && !E.fireBanner.hidden && UI._phase !== PH.LIVE) UI.showFireBanner(null);
    UI.syncPanelToggles();
  };

  /** Top-bar player chip: rebuilt only when name/title/face change. Hidden until state.player exists. */
  UI.renderPlayerChip = function () {
    var E = UI.els, chip = E.playerChip; if (!chip) return;
    var p = UI.player();
    if (!p) { chip.hidden = true; E.playerChipKey = ''; return; }
    var key = p.name + '|' + p.title + '|' + JSON.stringify(p.face);
    if (key === E.playerChipKey && !chip.hidden) return;
    E.playerChipKey = key;
    clear(chip);
    chip.appendChild(UI.portrait(p.face, 28, { title: p.name }));
    chip.appendChild(h('div', { class: 'grow' }, [h('div', { class: 'pn' }, p.name), h('div', { class: 'pt' }, p.title)]));
    chip.setAttribute('aria-label', p.name + ', ' + p.title + ' — fly to your character');
    chip.hidden = false;
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
    /* six core gauges; the rest live under "More readings" (choice remembered) */
    var moreOpen = UI.pref('condMore') === true;
    var core = h('div', { class: 'gauges core' }), more = h('div', { class: 'gauges more', id: 'cond-more', hidden: !moreOpen });

    /* snowpack */
    var sp = fin(cl.snowpackPct, 100), swe = fin(cl.snowSWEin, 0);
    core.appendChild(gauge({
      id: 'snowpack', label: 'Snowpack',
      tip: 'Snow water equivalent (SWE) is the water stored in the snowpack, measured on April 1 against the long-term median. Roughly 70–80% of Colorado\'s streamflow starts as snowmelt, so this is the best early forecast of the year\'s supply.' + uncTip,
      spark: UI.sparkline(historyValues('snowpackPct'), { color: '#bfe1f7', min: 0 }),
      value: uncertain ? [h('span', { class: 'range' }, '≈ ' + rangeText(sp, unc, function (v) { return Math.round(v) + '%'; })), h('span', { class: 'unit' }, 'of avg')] : [Math.round(sp) + '%', h('span', { class: 'unit' }, 'of avg')],
      sub: 'SWE ' + (uncertain ? '≈ ' + rangeText(swe, unc, function (v) { return num(v, 1); }) : num(swe, 1)) + ' in · avg ' + fin((C.HYDRO || {}).AVG_SNOW_SWE_IN, 18) + ' in'
    }));
    /* precipitation */
    more.appendChild(gauge({
      id: 'precip', label: 'Precipitation',
      tip: 'Rain and snow this season, in inches. Summer monsoon moisture and fall storms matter most after a fire: intense rain on a burn scar produces flash floods and debris flows.',
      spark: UI.sparkline(historyValues('precipIn'), { color: '#7dd3c0', min: 0 }),
      value: [num(cl.precipIn, 1), h('span', { class: 'unit' }, 'in')]
    }));
    /* temperature anomaly */
    var ta = fin(cl.tempAnomF);
    more.appendChild(gauge({
      id: 'temp', label: 'Temperature anomaly',
      tip: 'Departure from the seasonal average in °F. Warm seasons melt snow early, dry out fuels and soils, raise crop water demand and evaporate reservoir water.',
      spark: UI.sparkline(historyValues('tempAnomF'), { color: ta > 2 ? '#ff7a33' : '#e9c46a' }),
      value: [signed(ta, 1) + ' °F', h('span', { class: 'unit' }, ta > 3 ? 'hot' : ta < -2 ? 'cool' : 'near normal')]
    }));
    /* reservoir */
    var spct = cap > 0 ? stor / cap * 100 : 0;
    core.appendChild(gauge({
      id: 'reservoir', label: 'Reservoir storage',
      tip: 'Water in storage in acre-feet (1 AF ≈ 326,000 gallons, about what two Colorado households use in a year). Storage buffers dry years — but the bottom ' + fin((C.HYDRO || {}).RESERVOIR_DEAD_POOL_AF, 4000).toLocaleString() + ' AF is dead pool that cannot be delivered.',
      spark: UI.sparkline(historyValues('storageAF'), { color: UI.COLORS.water, min: 0, max: cap }),
      value: [af(stor), h('span', { class: 'unit' }, Math.round(spct) + '% full')],
      bar: h('div', { class: 'meter' }, [h('i', { class: 'water', style: { width: clamp(spct, 0, 100) + '%' } }), h('span', { class: 'mark', style: { left: clamp(fin((C.HYDRO || {}).RESERVOIR_DEAD_POOL_AF, 4000) / Math.max(cap, 1) * 100, 0, 100) + '%' }, 'data-tip': 'Dead pool' })])
    }));
    /* soil moisture */
    var sm = clamp(cl.soilMoisturePct, 0, 100);
    more.appendChild(gauge({
      id: 'soil', label: 'Soil moisture',
      tip: 'Percent of field capacity. Dry soils absorb the first snowmelt before it reaches the stream (lower runoff efficiency), stress crops and forests, and let fires spread faster.',
      spark: UI.sparkline(historyValues('soilMoisturePct'), { color: '#a5843c', min: 0, max: 100 }),
      value: [Math.round(sm) + '%'],
      bar: h('div', { class: 'meter thin' }, h('i', { class: 'turbid', style: { width: sm + '%' } }))
    }));
    /* streamflow */
    var cfs = fin(cl.streamflowCfs), minf = fin((C.HYDRO || {}).MIN_FLOW_CFS, 14);
    core.appendChild(gauge({
      id: 'flow', label: 'Streamflow below dam',
      tip: 'Cubic feet per second in Bitterbrush Creek below the dam. The instream-flow right needs ' + minf + ' cfs to keep fish and the riparian corridor alive; hydropower and rafting also depend on releases.' + uncTip,
      spark: UI.sparkline(historyValues('streamflowCfs'), { color: '#38bdf8', min: 0 }),
      value: uncertain ? [h('span', { class: 'range' }, '≈ ' + rangeText(cfs, unc, function (v) { return Math.round(v).toString(); })), h('span', { class: 'unit' }, 'cfs')] : [Math.round(cfs).toLocaleString(), h('span', { class: 'unit' }, 'cfs')],
      sub: cfs < minf ? h('span', { style: { color: '#ffb3ba' } }, '⚠ below the ' + minf + ' cfs minimum flow') : 'Minimum flow ' + minf + ' cfs met'
    }));
    /* fire danger */
    var lvl = dangerLevel(cl.fireDanger, cl.fireDangerLabel);
    core.appendChild(gauge({
      id: 'danger', label: 'Fire danger',
      tip: 'Combines heat, dryness, soil moisture, wind and how much fuel has built up in the forest. Colorado\'s biggest fires (2020) came after a hot, dry summer with a century of accumulated fuel.',
      spark: UI.sparkline(historyValues('fireDanger'), { color: UI.COLORS.fire, min: 0, max: 1 }),
      value: [cl.fireDangerLabel || DANGER_LABELS[lvl], h('span', { class: 'unit' }, num(clamp(cl.fireDanger, 0, 1) * 100, 0) + '/100')],
      bar: h('div', { class: 'dial', 'aria-label': 'Fire danger level ' + (lvl + 1) + ' of 5' }, [0, 1, 2, 3, 4].map(function (i) { return h('i', { class: i <= lvl ? 'on l' + (lvl + 1) : '' }); })),
      sub: 'Wind ' + Math.round(fin(cl.windMph)) + ' mph' + (cl.windDirRad != null ? ' from the ' + compass(cl.windDirRad) : '')
    }));
    /* drought */
    var dc = String(cl.drought || 'None'), di = ['D0', 'D1', 'D2', 'D3', 'D4'].indexOf(dc);
    core.appendChild(gauge({
      id: 'drought', label: 'Drought status',
      tip: 'U.S. Drought Monitor categories: D0 abnormally dry, D1 moderate, D2 severe, D3 extreme, D4 exceptional. Built from cumulative precipitation deficit; Colorado has spent much of the 21st century in some level of drought.',
      value: [dc === 'None' ? 'None' : dc, h('span', { class: 'unit' }, ['', 'abnormally dry', 'moderate', 'severe', 'extreme', 'exceptional'][di + 1] || '')],
      bar: h('div', { class: 'drought' }, [0, 1, 2, 3, 4].map(function (i) { return h('i', { class: i <= di ? 'on d' + i : '' }); }))
    }));
    /* population */
    more.appendChild(gauge({
      id: 'pop', label: 'Population',
      tip: 'Residents served. Every new home adds demand at ~' + fin((C.HYDRO || {}).GPCD, 118) + ' gallons per person per day — and homes in the wildland-urban interface add fire exposure.',
      spark: UI.sparkline(historyValues('population'), { color: '#c9c4b8' }),
      value: [Math.round(fin(s.population)).toLocaleString(), h('span', { class: 'unit' }, s.growthRate != null ? '+' + num(fin(s.growthRate) * 100, 1) + '%/yr' : '')]
    }));
    /* water quality */
    var turb = clamp(rv.turbidity, 0, 1), ash = clamp(rv.ashContam, 0, 1), alg = clamp(rv.algae, 0, 1);
    core.appendChild(gauge({
      id: 'quality', label: 'Water quality',
      tip: 'Turbidity is suspended sediment; ash carries nutrients, metals and organic carbon that treatment plants struggle with. After the 2020 fires, Front Range utilities faced years of sediment and taste-and-odour problems.',
      spark: UI.sparkline(historyValues('turbidity'), { color: '#a5843c', min: 0, max: 1 }),
      value: [turb < 0.15 && ash < 0.1 ? 'Clear' : (ash > 0.4 || turb > 0.6 ? 'Contaminated' : 'Turbid'), h('span', { class: 'unit' }, 'turbidity ' + Math.round(turb * 100) + ' · ash ' + Math.round(ash * 100) + (alg > 0.2 ? ' · algae ' + Math.round(alg * 100) : ''))],
      bar: h('div', { class: 'stack' }, [
        h('div', { class: 'meter thin', 'data-tip': 'Turbidity ' + Math.round(turb * 100) + '/100' }, h('i', { class: 'turbid', style: { width: turb * 100 + '%' } })),
        h('div', { class: 'meter thin', 'data-tip': 'Ash contamination ' + Math.round(ash * 100) + '/100' }, h('i', { class: 'ash', style: { width: ash * 100 + '%' } }))
      ])
    }));
    box.appendChild(core);
    var moreBtn = h('button', { class: 'ghost tiny cond-more-btn', type: 'button', id: 'cond-more-btn', 'aria-expanded': moreOpen ? 'true' : 'false', 'aria-controls': 'cond-more' }, moreOpen ? 'Fewer readings ▴' : 'More readings ▾ (precipitation, temperature, soil, population)');
    moreBtn.addEventListener('click', function () {
      var open = more.hidden; more.hidden = !open;
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      moreBtn.textContent = open ? 'Fewer readings ▴' : 'More readings ▾ (precipitation, temperature, soil, population)';
      UI.pref('condMore', open);
    });
    box.appendChild(moreBtn);
    box.appendChild(more);
    if (cl.description) box.appendChild(h('p', { class: 'small muted', style: { marginTop: '8px' } }, String(cl.description)));
  };
  function compass(rad) {
    var d = ((fin(rad) * 180 / Math.PI) % 360 + 360) % 360;
    var names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return names[Math.round(d / 45) % 8];
  }

  /* ------------------------------------------------------------------ Tactical HUD (live fire / storm), crisis chip, alerts */
  var TAC = UI._tac = { spec: null, order: '', tools: {}, zoneKey: '', built: false, on: false };
  var ZONE_TOOLS = { engine: 1, evacuate: 1 }, INSTANT_TOOLS = { spillway: 1, mutual_aid: 1 };
  var ZONE_TYPE_ICONS = { neighborhood: '🏘', farm: '🌾', civic: '🏛', forest: '🌲', reservoir: '💧', wetland: '🌿', town: '🏙' };
  function setText(el, s) { s = String(s == null ? '' : s); if (el && el.textContent !== s) el.textContent = s; }
  function setAttr(el, k, v) {
    if (!el) return;
    if (v == null || v === false) { if (el.hasAttribute(k)) el.removeAttribute(k); return; }
    v = v === true ? '' : String(v);
    if (el.getAttribute(k) !== v) el.setAttribute(k, v);
  }
  /** Reuse existing children in `box` for `items` (make(item,i) → el; update(el,item,i)); trims extras. */
  function syncChildren(box, items, make, update) {
    items = Array.isArray(items) ? items : [];
    while (box.children.length > items.length) box.removeChild(box.lastChild);
    for (var i = 0; i < items.length; i++) {
      var el = box.children[i];
      if (!el) { el = make(items[i], i); box.appendChild(el); }
      update(el, items[i], i);
    }
  }
  /** 'map' (paint/click cells) | 'zone' (needs a neighborhood) | 'instant' (applies immediately) */
  function toolKind(t) {
    t = t || {};
    if (t.kind === 'map' || t.kind === 'zone' || t.kind === 'instant') return t.kind;
    if (t.zone || ZONE_TOOLS[t.type]) return 'zone';
    if (t.instant || INSTANT_TOOLS[t.type]) return 'instant';
    return 'map';
  }
  function fmtPoints(v, unit) {
    v = fin(v);
    if (unit === '$M') return money(v);
    return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1);
  }
  function tacTools() { return (TAC.spec && Array.isArray(TAC.spec.tools)) ? TAC.spec.tools : []; }
  function tacTool(type) { var ts = tacTools(); for (var i = 0; i < ts.length; i++) if (ts[i] && ts[i].type === type) return ts[i]; return null; }
  function tacSelected() { var ts = tacTools(); for (var i = 0; i < ts.length; i++) if (ts[i] && ts[i].selected) return ts[i]; return null; }
  function tacticResult(r) {
    if (!r || typeof r !== 'object') return;
    if (r.ok === false) UI.toast(r.reason || r.text || 'That is not possible right now', 'warn');
    else if (r.text) UI.toast(r.text, 'good');
  }

  function buildTactical() {
    var E = UI.els, box = E.tactical; if (!box || TAC.built) return;
    clear(box);
    E.tacIcon = h('span', { class: 'mode-ic', 'aria-hidden': 'true' }, '🔥');
    E.tacTitle = h('div', { class: 't' }, ''); E.tacSub = h('div', { class: 'sub' }, '');
    E.tacStepN = h('span', { class: 'n num' }, ''); E.tacStepBar = h('i', { style: { width: '0%' } });
    E.tacPause = h('button', { id: 'tac-pause', type: 'button', 'aria-pressed': 'false', 'data-tip': 'Space: pause / resume' }, '⏸ Pause');
    E.tacPause.addEventListener('click', function () { UI.tacticalTogglePause(); });
    E.tacSpeedBtns = {};
    E.tacSpeed = h('div', { class: 'seg', id: 'tac-speed', role: 'group', 'aria-label': 'Speed' }, [1, 2].map(function (n) {
      var b = h('button', { type: 'button', 'data-speed': n, 'aria-label': n + 'x speed', onclick: function () { UI.tacticalSpeed(n); } }, n + '×');
      E.tacSpeedBtns[n] = b; return b;
    }));
    box.appendChild(h('div', { class: 'thead' }, [
      E.tacIcon, h('div', { class: 'tt' }, [E.tacTitle, E.tacSub]),
      h('div', { class: 'stepc', 'data-tip': 'Steps so far / longest this crisis can run' }, [h('span', { class: 'label' }, 'Step'), E.tacStepN, h('div', { class: 'meter thin' }, E.tacStepBar)]),
      h('div', { class: 'ctrl' }, [E.tacPause, E.tacSpeed])
    ]));
    E.tacPointsLabel = h('span', { class: 'label' }, 'Points'); E.tacPointsN = h('span', { class: 'n num' }, ''); E.tacPointsBar = h('i', { style: { width: '0%' } });
    E.tacPoints = h('div', { class: 'points', id: 'tac-points' }, [h('div', { class: 'row between' }, [E.tacPointsLabel, E.tacPointsN]), h('div', { class: 'meter' }, E.tacPointsBar)]);
    E.tacTools = h('div', { class: 'tools', id: 'tac-tools', role: 'group', 'aria-label': 'Tools (keys 1–5)' });
    E.tacZoneSel = h('select', { id: 'tac-zone-select', 'aria-label': 'Neighborhood' });
    E.tacZoneSel.addEventListener('change', function () { var v = Number(E.tacZoneSel.value); if (isFinite(v)) UI.callGame('highlightZone', [v]); });
    E.tacZoneApply = h('button', { class: 'primary tiny', id: 'tac-zone-apply', type: 'button' }, 'Apply');
    E.tacZoneApply.addEventListener('click', function () { UI.tacticalApplyZone(); });
    E.tacZoneLabel = h('span', { class: 'label' }, 'Neighborhood');
    E.tacZone = h('div', { class: 'zone-row', id: 'tac-zone', hidden: true }, [E.tacZoneLabel, E.tacZoneSel, E.tacZoneApply]);
    E.tacHint = h('div', { class: 'hint', id: 'tac-hint' }, '');
    E.tacHeadline = h('div', { class: 'headline' }, '');
    E.tacRows = h('div', { class: 'rows' });
    E.tacThreatened = h('div', { class: 'threatened' });
    E.tacThreatLabel = h('div', { class: 'label', style: { marginTop: '6px' } }, 'Threatened');
    E.tacThreat = h('div', { class: 'threat', id: 'tac-threat', role: 'status', 'aria-live': 'polite' }, [E.tacHeadline, E.tacRows, E.tacThreatLabel, E.tacThreatened]);
    box.appendChild(h('div', { class: 'tgrid' }, [h('div', { class: 'tleft' }, [E.tacPoints, E.tacTools, E.tacZone, E.tacHint]), E.tacThreat]));
    TAC.built = true;
  }

  function renderTacTools() {
    var E = UI.els, tools = tacTools();
    var order = tools.map(function (t) { return (t && t.type) || ''; }).join(',');
    if (order !== TAC.order) {
      clear(E.tacTools); TAC.tools = {}; TAC.order = order;
      tools.forEach(function (t, i) {
        t = t || {}; var type = t.type || ('tool' + i);
        var r = { btn: null, ic: h('span', { class: 'ic', 'aria-hidden': 'true' }, ''), n: h('span', { class: 'n' }, ''), cost: h('b', {}, ''), rem: h('span', { class: 'rem' }, '') };
        r.btn = h('button', { class: 'tool', type: 'button', 'data-tool': type, 'aria-pressed': 'false' }, [
          i < 9 ? h('kbd', { class: 'key', 'aria-hidden': 'true' }, String(i + 1)) : null, r.ic, r.n, h('span', { class: 'c' }, [r.cost, r.rem])
        ]);
        r.btn.addEventListener('click', function () { UI.tacticalToolClick(type); });
        TAC.tools[type] = r; E.tacTools.appendChild(r.btn);
      });
    }
    tools.forEach(function (t) {
      t = t || {}; var r = TAC.tools[t.type]; if (!r) return;
      setText(r.ic, t.icon || '▪'); setText(r.n, t.name || t.type); setText(r.cost, t.cost || '');
      var cd = fin(t.cooldown, 0), remaining = t.remaining;
      var remText = cd > 0 ? ' · ⏱ ' + Math.ceil(cd) : (remaining != null && isFinite(Number(remaining)) ? ' · ' + Math.max(0, Math.round(remaining)) + ' left' : '');
      setText(r.rem, remText);
      var disabled = !!t.disabled || cd > 0 || (remaining != null && fin(remaining) <= 0);
      r.btn.classList.toggle('selected', !!t.selected);
      r.btn.classList.toggle('disabled', disabled);
      r.btn.classList.toggle('cooling', cd > 0);
      setAttr(r.btn, 'aria-pressed', t.selected ? 'true' : 'false');
      setAttr(r.btn, 'aria-disabled', disabled ? 'true' : null);
      var tip = disabled && t.reason ? String(t.reason) : (t.desc || t.name || '');
      setAttr(r.btn, 'data-tip', tip || null);
    });
  }
  function renderTacZone() {
    var E = UI.els, sel = tacSelected();
    var show = !!sel && toolKind(sel) === 'zone';
    if (E.tacZone.hidden === show) E.tacZone.hidden = !show;
    if (!show) return;
    var ztype = typeof sel.zone === 'string' ? sel.zone : 'neighborhood';
    var zones = [];
    try { if (UI.game && typeof UI.game.listZones === 'function') zones = UI.game.listZones(ztype); } catch (e) { zones = null; }
    if (!Array.isArray(zones)) {
      var w = wd(); zones = null;
      try { if (typeof w.zonesOf === 'function') zones = w.zonesOf(ztype); } catch (e) { zones = null; }
      if (!Array.isArray(zones)) zones = (w.zones || []).filter(function (z) { return z && z.type === ztype; });
    }
    var key = ztype + ':' + zones.map(function (z) { return z && z.id; }).join(',');
    if (key !== TAC.zoneKey) {
      TAC.zoneKey = key; clear(E.tacZoneSel);
      zones.forEach(function (z) { if (z) E.tacZoneSel.appendChild(h('option', { value: String(z.id) }, z.name || ('Zone ' + z.id))); });
      if (!zones.length) E.tacZoneSel.appendChild(h('option', { value: '' }, 'No ' + ztype + 's'));
    }
    setText(E.tacZoneLabel, ztype === 'neighborhood' ? 'Neighborhood' : ztype);
    setText(E.tacZoneApply, (sel.icon ? sel.icon + ' ' : '') + (sel.type === 'evacuate' ? 'Evacuate' : sel.type === 'engine' ? 'Station' : 'Apply'));
    E.tacZoneApply.disabled = !zones.length;
  }
  function renderTacThreat() {
    var E = UI.els, th = (TAC.spec && TAC.spec.threat) || {};
    setText(E.tacHeadline, th.headline || (TAC.spec && TAC.spec.subtitle) || '');
    syncChildren(E.tacRows, Array.isArray(th.rows) ? th.rows : [],
      function () { return h('div', { class: 'r' }, [h('span', { class: 'k' }, ''), h('span', { class: 'v num' }, '')]); },
      function (el, r) { r = r || {}; setText(el.firstChild, r.label); setText(el.lastChild, r.value); el.classList.toggle('bad', !!r.bad); });
    var list = Array.isArray(th.threatened) ? th.threatened : [];
    E.tacThreatLabel.hidden = !list.length;
    syncChildren(E.tacThreatened, list,
      function () { return h('div', { class: 'tz' }, [h('span', { class: 'ic', 'aria-hidden': 'true' }, ''), h('span', { class: 'n' }, ''), h('span', { class: 'd num' }, ''), h('span', { class: 'burning' }, 'burning')]); },
      function (el, z) {
        z = z || {}; var kids = el.children;
        setText(kids[0], ZONE_TYPE_ICONS[z.type] || '📍'); setText(kids[1], z.name || UI.zoneName(z.zoneId) || 'Zone');
        var d = Number(z.distance != null ? z.distance : z.distanceCells);
        setText(kids[2], z.burning ? '' : (isFinite(d) ? (d <= 0 ? 'here' : Math.round(d) + ' cells') : ''));
        var storm = !!(TAC.spec && TAC.spec.mode === 'storm');
        setText(kids[3], storm ? 'flooding' : 'burning');
        kids[3].hidden = !z.burning; el.classList.toggle('is-burning', !!z.burning);
        setAttr(el, 'data-tip', (z.name || 'Zone') + (z.type ? ' · ' + z.type : '') + (z.burning ? (storm ? ' · water is in the streets' : ' · fire is inside') : (isFinite(d) ? ' · ' + Math.round(d) + ' cells (' + Math.round(d * fin(C.CELL_M, 100)) + ' m) from the ' + (storm ? 'water' : 'fire line') : '')));
      });
  }
  function renderTacHead() {
    var E = UI.els, s = TAC.spec || {}, mode = s.mode === 'storm' ? 'storm' : 'fire';
    E.tactical.classList.toggle('fire', mode === 'fire'); E.tactical.classList.toggle('storm', mode === 'storm');
    setText(E.tacIcon, mode === 'storm' ? '⛈' : '🔥');
    setText(E.tacTitle, s.title || (mode === 'storm' ? 'Storm defense' : 'Wildfire response'));
    setText(E.tacSub, s.subtitle || '');
    var step = fin(s.step), max = fin(s.maxSteps);
    setText(E.tacStepN, max > 0 ? Math.round(step) + ' / ' + Math.round(max) : String(Math.round(step)));
    var w = (max > 0 ? clamp(step / max * 100, 0, 100) : 0) + '%'; if (E.tacStepBar.style.width !== w) E.tacStepBar.style.width = w;
    var paused = !!s.paused;
    setText(E.tacPause, paused ? '▶ Resume' : '⏸ Pause'); E.tacPause.classList.toggle('paused', paused); setAttr(E.tacPause, 'aria-pressed', paused ? 'true' : 'false');
    var sp = Number(s.speed) === 2 ? 2 : 1;
    for (var k in E.tacSpeedBtns) E.tacSpeedBtns[k].classList.toggle('active', Number(k) === sp);
    if (E.speedBtns) for (var k2 in E.speedBtns) E.speedBtns[k2].classList.toggle('active', Number(k2) === sp);
    var p = s.points || {};
    setText(E.tacPointsLabel, p.label || (mode === 'storm' ? 'Emergency fund' : 'Crew points'));
    var pv = fin(p.value), pm = fin(p.max);
    setText(E.tacPointsN, fmtPoints(pv, p.unit) + (pm > 0 ? ' / ' + fmtPoints(pm, p.unit) : '') + (p.unit === 'pts' ? ' pts' : ''));
    var pw = (pm > 0 ? clamp(pv / pm * 100, 0, 100) : 0) + '%'; if (E.tacPointsBar.style.width !== pw) E.tacPointsBar.style.width = pw;
    E.tacPoints.classList.toggle('low', pm > 0 && pv / pm < 0.15);
    var sel = tacSelected(), hint = s.hint;
    if (!hint) {
      if (!sel) hint = 'Pick a tool (keys 1–5). Space pauses; Esc deselects.';
      else if (toolKind(sel) === 'zone') hint = 'Choose a neighborhood and apply.';
      else if (toolKind(sel) === 'instant') hint = 'Applies immediately.';
      else hint = 'Click or drag on the map to place ' + (sel.name || sel.type) + '.';
    }
    setText(E.tacHint, hint);
    var chip = s.chip || s.alarm || s.title || (mode === 'storm' ? 'FLASH FLOOD' : 'WILDFIRE');
    setText(E.crisisChip.querySelector('.txt'), chip); E.crisisChip.hidden = false;
    E.topbar.classList.toggle('crisis-fire', mode === 'fire'); E.topbar.classList.toggle('crisis-storm', mode === 'storm');
  }
  function applyTactical(spec) {
    TAC.spec = spec && typeof spec === 'object' ? spec : {};
    renderTacHead(); renderTacTools(); renderTacZone(); renderTacThreat();
  }

  UI.tacticalVisible = function () { return !!(TAC.on && UI.els.tactical && !UI.els.tactical.hidden); };
  UI.handlesCrisisKeys = true; /* main.js may skip its own 1–5 / Space / Esc handling while UI.tacticalVisible() */
  /** Show the tactical HUD for a live fire or storm. spec: see SPEC2 §D. */
  UI.showTactical = function (spec) {
    var E = UI.els; if (!E.tactical) return;
    buildTactical();
    TAC.order = ''; TAC.zoneKey = ''; TAC.on = true;
    E.ui.classList.add('crisis-on');
    E.tactical.hidden = false;
    if (E.placement) E.placement.hidden = true;
    if (E.fireBanner) E.fireBanner.hidden = true;
    UI.toggleEvidenceMenu(false);
    applyTactical(spec);
    var mode = (TAC.spec.mode === 'storm') ? PH_STORM : PH_FIRE;
    if (UI._phase !== mode) UI.setPhase(mode);
  };
  /** Diff-update: called ~2×/s by the game; only touches text/classes that changed. */
  UI.updateTactical = function (spec) {
    if (!TAC.on || !UI.els.tactical || UI.els.tactical.hidden) { UI.showTactical(spec); return; }
    applyTactical(spec);
  };
  UI.hideTactical = function () {
    var E = UI.els; if (!E.tactical) return;
    TAC.on = false; TAC.spec = null;
    E.tactical.hidden = true;
    E.ui.classList.remove('crisis-on');
    E.topbar.classList.remove('crisis-fire'); E.topbar.classList.remove('crisis-storm');
    E.crisisChip.hidden = true;
    if (UI._phase === PH_FIRE || UI._phase === PH_STORM) UI.setPhase(PH.LIVE || 'live');
    UI.syncPanelToggles();
  };
  UI.tacticalToolClick = function (type) {
    var t = tacTool(type); if (!t) return;
    var cd = fin(t.cooldown, 0);
    if (t.disabled || cd > 0 || (t.remaining != null && fin(t.remaining) <= 0)) {
      UI.toast(t.reason || (cd > 0 ? (t.name || type) + ' ready in ' + Math.ceil(cd) + ' steps' : (t.name || type) + ' is used up'), 'warn'); return;
    }
    if (toolKind(t) === 'instant') { UI.callGame('applyTactic', [type], tacticResult); return; }
    var next = t.selected ? null : type;
    tacTools().forEach(function (x) { if (x) x.selected = !!next && x.type === next; }); /* optimistic; next update overrides */
    renderTacTools(); renderTacZone(); renderTacHead();
    UI.callGame('selectTactic', [next]);
  };
  UI.tacticalSelectIndex = function (i) { var t = tacTools()[i]; if (t && t.type) UI.tacticalToolClick(t.type); };
  UI.tacticalDeselect = function () {
    tacTools().forEach(function (x) { if (x) x.selected = false; });
    renderTacTools(); renderTacZone(); renderTacHead();
    UI.callGame('selectTactic', [null]);
  };
  UI.tacticalTogglePause = function () {
    if (!TAC.spec) return;
    var p = !TAC.spec.paused; TAC.spec.paused = p; renderTacHead();
    UI.callGame('setPaused', [p]);
  };
  UI.tacticalSpeed = function (n) {
    n = Number(n) === 2 ? 2 : 1; if (TAC.spec) TAC.spec.speed = n; UI._speed = n; renderTacHead();
    UI.callGame('setSpeed', [n]);
  };
  UI.tacticalApplyZone = function () {
    var E = UI.els, sel = tacSelected(); if (!sel || toolKind(sel) !== 'zone') return;
    var zid = Number(E.tacZoneSel.value); if (!isFinite(zid)) return;
    UI.callGame('applyTacticToZone', [sel.type, zid], tacticResult);
  };

  /* --- centre alerts: large 2 s flash, queued --- */
  var alertQ = [], alertBusy = false;
  UI.alert = function (text, kind) {
    var E = UI.els; if (!E.alert) return;
    alertQ.push({ text: String(text == null ? '' : text), kind: kind || 'info' });
    if (alertQ.length > 6) alertQ.splice(0, alertQ.length - 6);
    pumpAlert();
  };
  function pumpAlert() {
    if (alertBusy || !alertQ.length) return;
    var a = alertQ.shift(), E = UI.els; alertBusy = true;
    clear(E.alert);
    var icon = UI.KIND_ICONS[a.kind] || (a.kind === 'storm' ? '⛈' : '');
    var card = h('div', { class: 'alert-card ' + a.kind }, [icon ? h('span', { class: 'ic', 'aria-hidden': 'true' }, icon) : null, h('span', { class: 'txt' }, a.text)]);
    E.alert.appendChild(card); E.alert.hidden = false;
    setTimeout(function () {
      card.classList.add('leaving');
      setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
        if (!E.alert.children.length) E.alert.hidden = true;
        alertBusy = false; pumpAlert();
      }, 260);
    }, 2000);
  }

  /* ------------------------------------------------------------------ Advisor speech bubbles (3D avatars in town) */
  var BUB = UI._bubble = { el: null, visible: false, spec: null, ignoreUntil: 0, hideTimer: null, x: NaN, y: NaN, side: 'above' };
  /**
   * Show one bubble for an advisor. spec: { id, name, role, color, avatarEmoji, text, actions:[{label,onClick}], onClose }
   * ≤ 240 px wide: name + one-line role, the text, optional buttons ("Full advice" / "Ask again"). Position it with UI.moveBubble.
   */
  UI.showBubble = function (spec) {
    var E = UI.els, el = E.bubble; if (!el) return null;
    spec = (spec && typeof spec === 'object') ? spec : { text: String(spec == null ? '' : spec) };
    if (BUB.hideTimer) { clearTimeout(BUB.hideTimer); BUB.hideTimer = null; }
    var prev = BUB.spec;
    if (prev && prev !== spec && typeof prev.onClose === 'function' && BUB.visible && prev.id !== spec.id) { try { prev.onClose('replaced'); } catch (e) { console.error(e); } }
    BUB.spec = spec;
    clear(el);
    var color = spec.color || '#4aa3df';
    el.style.setProperty('--adv', color);
    el.dataset.advisor = spec.id || '';
    el.appendChild(h('span', { class: 'tail', 'aria-hidden': 'true' }));
    /* 40 px portrait (WS.Faces) replaces the emoji dot; the emoji stays as a fallback when no face is known */
    var face = UI.faceOf(spec);
    el.appendChild(h('div', { class: 'who' }, [
      face ? UI.portrait(face, 40, { expression: spec.expression }) : (spec.avatarEmoji ? h('span', { class: 'av', style: { background: color }, 'aria-hidden': 'true' }, spec.avatarEmoji) : null),
      h('div', { class: 'grow' }, [h('div', { class: 'name' }, spec.name || 'Advisor'), spec.role ? h('div', { class: 'role' }, spec.role) : null]),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: function () { UI.hideBubble(); } }, '×')
    ]));
    el.appendChild(h('div', { class: 'txt' }, String(spec.text == null ? '' : spec.text)));
    var actions = Array.isArray(spec.actions) ? spec.actions.filter(Boolean) : [];
    if (actions.length) {
      el.appendChild(h('div', { class: 'acts' }, actions.map(function (a, i) {
        return h('button', { class: 'tiny' + (i === 0 ? ' primary' : ''), type: 'button', onclick: function (e) { e.stopPropagation(); try { if (typeof a.onClick === 'function') a.onClick(); } catch (err) { console.error(err); } } }, a.label || 'OK');
      })));
    }
    BUB.ignoreUntil = Date.now() + 300;
    el.hidden = false;
    BUB.visible = true;
    el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
    if (isFinite(BUB.x) && isFinite(BUB.y)) UI.moveBubble(BUB.x, BUB.y, true);
    else { el.style.left = '50%'; el.style.top = '40%'; }
    return el;
  };
  /** Put the bubble's tail at screen point (sx, sy); clamps to the viewport; hides (keeps state) when !visible. */
  UI.moveBubble = function (sx, sy, visible) {
    var el = BUB.el; if (!el || !BUB.spec) return;
    if (visible === false || !isFinite(Number(sx)) || !isFinite(Number(sy))) { if (!el.hidden) el.classList.add('offscreen'); return; }
    sx = Number(sx); sy = Number(sy);
    BUB.x = sx; BUB.y = sy;
    if (!BUB.visible) return;
    el.classList.remove('offscreen'); el.hidden = false;
    var vw = window.innerWidth, vh = window.innerHeight, bw = el.offsetWidth || 240, bh = el.offsetHeight || 120;
    var gap = 14, pad = 8;
    var side = (sy - bh - gap < pad) ? 'below' : 'above';
    var top = side === 'above' ? sy - bh - gap : sy + gap;
    top = Math.max(pad, Math.min(vh - bh - pad, top));
    var left = sx - bw / 2;
    left = Math.max(pad, Math.min(vw - bw - pad, left));
    var tailX = Math.max(14, Math.min(bw - 14, sx - left));
    if (el.style.left !== left + 'px') el.style.left = left + 'px';
    if (el.style.top !== top + 'px') el.style.top = top + 'px';
    el.style.setProperty('--tail-x', tailX + 'px');
    if (BUB.side !== side) { BUB.side = side; el.classList.toggle('below', side === 'below'); }
  };
  UI.hideBubble = function () {
    var el = BUB.el, spec = BUB.spec;
    if (!el || !BUB.visible) return false;
    BUB.visible = false; BUB.spec = null; BUB.x = NaN; BUB.y = NaN;
    el.classList.remove('in');
    el.classList.add('out');
    BUB.hideTimer = setTimeout(function () { el.hidden = true; el.classList.remove('out'); el.classList.remove('offscreen'); BUB.hideTimer = null; }, 160);
    if (spec && typeof spec.onClose === 'function') { try { spec.onClose('hidden'); } catch (e) { console.error(e); } }
    return true;
  };
  UI.bubbleVisible = function () { return !!BUB.visible; };
  UI.bubbleAdvisor = function () { return BUB.visible && BUB.spec ? (BUB.spec.id || null) : null; };
  /** Small unobtrusive hint near the bottom-left ("Click an advisor in town to hear their take"). null hides it. */
  UI.setAdvisorHint = function (text) {
    var el = UI.els.advisorHint; if (!el) return;
    if (text == null || text === false || text === '') { el.classList.remove('in'); el.hidden = true; return; }
    clear(el);
    el.appendChild(h('span', { class: 'ic', 'aria-hidden': 'true' }, '🗣'));
    el.appendChild(h('span', { class: 'txt' }, String(text)));
    el.appendChild(h('button', { class: 'x', type: 'button', 'aria-label': 'Dismiss hint', onclick: function () { UI.setAdvisorHint(null); } }, '×'));
    el.hidden = false;
    el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
  };

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
