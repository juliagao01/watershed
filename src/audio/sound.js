/* Watershed — synthesized sound. Exports WS.Sound.
   Everything is generated with the Web Audio API (oscillators, filtered noise, envelopes, a feedback-delay reverb): no files,
   no fetches, so it works under the single-file CSP. The AudioContext is created/resumed on the first pointerdown/keydown.
   Never throws: without an AudioContext every call is a no-op.
   API: init(), play(name, opts), loop(name, on, intensity), setMuted(b), isMuted(), setVolume(0..1), getVolume(), attach(game). */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var S = WS.Sound = WS.Sound || {};
  var AC = root.AudioContext || root.webkitAudioContext || null;
  var hasDoc = (typeof document !== 'undefined');

  var ctx = null, master = null, sfx = null, beds = null, verb = null;
  var noiseBuf = null, pinkBuf = null;
  var st = { inited: false, muted: false, volume: 0.6, attached: false, unlocked: false };
  var LOOP_LEVEL = 0.42;            // beds sit well under one-shots
  var LOOPS = {};                   // active loop instances by name
  var pendingLoops = {};            // loop state requested before the gesture unlock
  var schedTimer = null;
  var lastAt = {};                  // throttle bookkeeping
  var MIN_GAP = { click: 40, sandbag: 100, evac: 600, advisor: 300, whoosh: 600, dozer: 1100, good: 300, bad: 300, alert_generic: 300, pump: 400, select: 60, tanker: 800, card: 200, card_choice: 200 };
  var btn = null;

  /* ------------------------------------------------------------------ small helpers */
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d == null ? 0 : d); }
  function clamp(v, a, b) { v = num(v, a); return v < a ? a : (v > b ? b : v); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function warnDev(e) { if (WS.DEBUG && typeof console !== 'undefined') console.warn('[Sound]', e); }
  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { warnDev(e); return undefined; } }; }
  function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, String(v)); } catch (e) { /* private mode etc. */ } }
  function throttled(key, ms) { var t = Date.now(); if (lastAt[key] && t - lastAt[key] < ms) return true; lastAt[key] = t; return false; }
  function hashStr(s) { s = String(s == null ? '' : s); var h = 7; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function now() { return ctx.currentTime; }
  function ready() { return !!(ctx && ctx.state === 'running'); }

  /* ------------------------------------------------------------------ graph */
  function makeNoise(pink) {
    var len = Math.floor(ctx.sampleRate * 2), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      if (!pink) { d[i] = w; continue; }
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    return buf;
  }
  function ensureCtx() {
    if (ctx || !AC) return ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { ctx = null; return null; } }
    master = ctx.createGain(); master.gain.value = st.muted ? 0 : st.volume;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);
    sfx = ctx.createGain(); sfx.gain.value = 1; sfx.connect(master);
    beds = ctx.createGain(); beds.gain.value = LOOP_LEVEL; beds.connect(master);
    // convolver-free reverb: three damped feedback delays feeding a wet bus
    verb = ctx.createGain(); verb.gain.value = 1;
    var wet = ctx.createGain(); wet.gain.value = 0.32; wet.connect(sfx);
    [[0.083, 0.42], [0.127, 0.38], [0.173, 0.34]].forEach(function (d) {
      var dl = ctx.createDelay(1); dl.delayTime.value = d[0];
      var fb = ctx.createGain(); fb.gain.value = d[1];
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      verb.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(wet);
    });
    noiseBuf = makeNoise(false); pinkBuf = makeNoise(true);
    try { ctx.onstatechange = function () { if (ctx && ctx.state === 'running') onRunning(); }; } catch (e) { /* ignore */ }
    return ctx;
  }
  function onRunning() {
    if (st.unlocked) return;
    st.unlocked = true;
    var p = pendingLoops; pendingLoops = {};
    Object.keys(p).forEach(function (n) { S.loop(n, p[n].on, p[n].i); });
  }
  function unlock() {
    var c = ensureCtx(); if (!c) return;
    if (c.state === 'suspended' || c.state === 'interrupted') { try { var p = c.resume(); if (p && p.then) p.then(onRunning, function () { }); } catch (e) { /* ignore */ } }
    else if (c.state === 'running') onRunning();
  }
  function installUnlock() {
    if (!hasDoc) return;
    var opts = { capture: true, passive: true };
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) { root.addEventListener(t, unlock, opts); });
  }

  /* ------------------------------------------------------------------ voice primitives (self-cleaning) */
  function connectChain(nodes, dest) { for (var i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); nodes[nodes.length - 1].connect(dest); }
  function autoKill(src, nodes, t) {
    src.onended = function () { for (var i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) { /* ignore */ } } src.onended = null; };
    try { src.stop(t); } catch (e) { /* ignore */ }
  }
  /* peak→(decay to sustain)→hold until t0+d→release r. Returns a safe stop time. */
  function env(g, t0, peak, a, d, r, dec, sus) {
    var p = g.gain; peak = Math.max(0.0001, peak);
    p.setValueAtTime(0.0001, t0);
    p.linearRampToValueAtTime(peak, t0 + a);
    if (dec && sus != null && sus < 1) p.exponentialRampToValueAtTime(Math.max(0.0001, peak * sus), t0 + a + dec);
    p.setTargetAtTime(0.0001, t0 + d, Math.max(0.004, r / 3));
    return t0 + d + r + 0.05;
  }
  function addFilter(chain, o, t0) {
    var f = o.lp || o.bp || o.hp; if (!f) return null;
    var b = ctx.createBiquadFilter(); b.type = o.lp ? 'lowpass' : (o.bp ? 'bandpass' : 'highpass');
    b.frequency.setValueAtTime(f, t0);
    if (o.f2f) b.frequency.exponentialRampToValueAtTime(o.f2f, t0 + (o.f2d || o.d || 0.2));
    if (o.f3f) b.frequency.exponentialRampToValueAtTime(o.f3f, t0 + (o.d || 0.2));
    if (o.q) b.Q.setValueAtTime(o.q, t0);
    chain.push(b); return b;
  }
  function finish(chain, g, o, t0, d) {
    if (o.pan != null && ctx.createStereoPanner) { var pn = ctx.createStereoPanner(); pn.pan.setValueAtTime(clamp(o.pan, -1, 1), t0); if (o.pan2 != null) pn.pan.linearRampToValueAtTime(clamp(o.pan2, -1, 1), t0 + d); chain.push(pn); }
    connectChain(chain, o.dest || sfx);
    if (o.send && verb) { var sg = ctx.createGain(); sg.gain.value = o.send; g.connect(sg); sg.connect(verb); chain.push(sg); }
  }
  /* tone({type,f,f2,f3,fd,detune,t,d,a,r,dec,s,g,lp|bp|hp,q,send,pan,pan2,dest}) */
  function tone(o) {
    var t0 = o.t != null ? o.t : now(), a = o.a != null ? o.a : 0.005, d = Math.max(o.d || 0.2, a + 0.005), r = o.r != null ? o.r : Math.min(0.12, d * 0.6);
    var osc = ctx.createOscillator(); osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(1, o.f || 440), t0);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t0 + (o.fd || d));
    if (o.f3) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f3), t0 + d);
    if (o.detune) osc.detune.setValueAtTime(o.detune, t0);
    var chain = [osc]; addFilter(chain, o, t0);
    var g = ctx.createGain(); chain.push(g);
    var tEnd = env(g, t0, (o.g == null ? 0.2 : o.g), a, d, r, o.dec, o.s);
    finish(chain, g, o, t0, d);
    osc.start(t0); autoKill(osc, chain, tEnd);
    return g;
  }
  /* noise({pink,rate,t,d,a,r,dec,s,g,lp|bp|hp,q,f2f,f3f,f2d,send,pan,pan2,dest}) */
  function noise(o) {
    var t0 = o.t != null ? o.t : now(), a = o.a != null ? o.a : 0.005, d = Math.max(o.d || 0.2, a + 0.005), r = o.r != null ? o.r : Math.min(0.12, d * 0.6);
    var src = ctx.createBufferSource(); src.buffer = o.pink ? pinkBuf : noiseBuf; src.loop = true;
    if (o.rate) src.playbackRate.setValueAtTime(o.rate, t0);
    var chain = [src]; addFilter(chain, o, t0);
    var g = ctx.createGain(); chain.push(g);
    var tEnd = env(g, t0, (o.g == null ? 0.2 : o.g), a, d, r, o.dec, o.s);
    finish(chain, g, o, t0, d);
    src.start(t0, Math.random() * 1.5); autoKill(src, chain, tEnd);
    return g;
  }
  /* one-shot LFO onto an AudioParam between t0 and t1 */
  function lfo(param, freq, depth, t0, t1, type) {
    var o = ctx.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
    var g = ctx.createGain(); g.gain.setValueAtTime(depth, t0);
    o.connect(g); g.connect(param); o.start(t0); autoKill(o, [o, g], t1);
  }
  function hz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
  /* metallic ping: fundamental + inharmonic partials */
  function ping(t, f, g, d, dest, send) {
    tone({ t: t, f: f, type: 'sine', d: d, a: 0.002, r: d * 0.8, g: g, dest: dest, send: send });
    tone({ t: t, f: f * 2.756, type: 'sine', d: d * 0.6, a: 0.002, r: d * 0.5, g: g * 0.35, dest: dest });
    tone({ t: t, f: f * 5.404, type: 'sine', d: d * 0.3, a: 0.002, r: d * 0.3, g: g * 0.12, dest: dest });
  }

  /* ------------------------------------------------------------------ one-shots */
  var ONE = {};
  ONE.click = function (t, o) {
    tone({ t: t, f: 1900, f2: 1200, type: 'sine', d: 0.03, a: 0.002, r: 0.03, g: 0.11 * o.gain });
    noise({ t: t, hp: 4500, d: 0.015, a: 0.001, r: 0.02, g: 0.05 * o.gain });
  };
  ONE.select = function (t, o) {
    tone({ t: t, f: 880, type: 'sine', d: 0.05, a: 0.003, r: 0.05, g: 0.11 * o.gain });
    tone({ t: t + 0.055, f: 1320, type: 'sine', d: 0.06, a: 0.003, r: 0.08, g: 0.1 * o.gain, send: 0.15 });
    tone({ t: t, f: 440, type: 'triangle', d: 0.07, a: 0.004, r: 0.06, g: 0.05 * o.gain });
  };
  ONE.fund = function (t, o) {
    ping(t, 2637, 0.16 * o.gain, 0.28, null, 0.3);
    ping(t + 0.09, 3520, 0.14 * o.gain, 0.32, null, 0.3);
    tone({ t: t + 0.02, f: 130, f2: 48, type: 'sine', d: 0.16, a: 0.003, r: 0.12, g: 0.35 * o.gain });
    noise({ t: t + 0.02, lp: 900, d: 0.03, a: 0.001, r: 0.03, g: 0.12 * o.gain });
  };
  ONE.build_done = function (t, o) {
    [523.25, 659.25, 783.99].forEach(function (f, i) {
      tone({ t: t + i * 0.09, f: f, type: 'triangle', d: 0.14, a: 0.004, r: 0.14, g: 0.16 * o.gain, send: 0.35 });
      tone({ t: t + i * 0.09, f: f * 2, type: 'sine', d: 0.1, a: 0.004, r: 0.1, g: 0.05 * o.gain });
    });
    tone({ t: t + 0.27, f: 1046.5, type: 'sine', d: 0.35, a: 0.005, r: 0.3, g: 0.14 * o.gain, send: 0.45 });
    tone({ t: t + 0.27, f: 261.6, type: 'triangle', d: 0.3, a: 0.01, r: 0.25, g: 0.07 * o.gain });
  };
  ONE.season_end = function (t, o) {
    [76, 79, 81, 83, 86, 88].forEach(function (m) {
      var dt = rnd(0, 0.38), f = hz(m);
      ping(t + dt, f, 0.075 * o.gain, rnd(0.9, 1.4), null, 0.5);
    });
    noise({ t: t, bp: 2200, q: 0.6, f2f: 900, d: 0.6, a: 0.15, r: 0.5, g: 0.05 * o.gain, pink: true });
  };
  ONE.report = function (t, o) {
    noise({ t: t, bp: 600, q: 0.9, f2f: 2600, f2d: 0.22, d: 0.24, a: 0.03, r: 0.12, g: 0.17 * o.gain, pan: -0.5, pan2: 0.5 });
    tone({ t: t + 0.24, f: 1046.5, type: 'sine', d: 0.3, a: 0.004, r: 0.3, g: 0.11 * o.gain, send: 0.4 });
    tone({ t: t + 0.27, f: 1568, type: 'sine', d: 0.28, a: 0.004, r: 0.3, g: 0.07 * o.gain, send: 0.4 });
  };
  ONE.card = function (t, o) {
    noise({ t: t, bp: 1200, q: 1.1, f2f: 3200, f2d: 0.1, d: 0.11, a: 0.01, r: 0.08, g: 0.15 * o.gain });
    noise({ t: t + 0.09, hp: 3000, d: 0.02, a: 0.001, r: 0.03, g: 0.08 * o.gain });
    tone({ t: t + 0.09, f: 1500, f2: 900, type: 'sine', d: 0.03, a: 0.002, r: 0.03, g: 0.05 * o.gain });
  };
  ONE.card_choice = function (t, o) {
    noise({ t: t, lp: 420, d: 0.06, a: 0.001, r: 0.07, g: 0.4 * o.gain });
    tone({ t: t, f: 95, f2: 42, type: 'sine', d: 0.12, a: 0.002, r: 0.1, g: 0.4 * o.gain });
    noise({ t: t, hp: 3500, d: 0.012, a: 0.001, r: 0.015, g: 0.14 * o.gain });
  };
  ONE.alert_fire = function (t, o) {
    tone({ t: t, f: 440, f2: 540, fd: 0.5, type: 'sawtooth', lp: 1600, d: 0.55, a: 0.01, r: 0.06, g: 0.15 * o.gain });
    tone({ t: t, f: 220, f2: 270, fd: 0.5, type: 'square', lp: 900, d: 0.55, a: 0.01, r: 0.06, g: 0.05 * o.gain });
    tone({ t: t + 0.6, f: 587, f2: 720, fd: 0.55, type: 'sawtooth', lp: 1800, d: 0.6, a: 0.01, r: 0.1, g: 0.15 * o.gain });
    tone({ t: t + 0.6, f: 293, f2: 360, fd: 0.55, type: 'square', lp: 900, d: 0.6, a: 0.01, r: 0.1, g: 0.05 * o.gain });
  };
  ONE.alert_flood = function (t, o) {
    tone({ t: t, f: 920, f2: 300, type: 'sawtooth', lp: 2200, d: 1.15, a: 0.02, r: 0.15, g: 0.14 * o.gain });
    tone({ t: t, f: 920, f2: 300, type: 'triangle', detune: 6, d: 1.15, a: 0.02, r: 0.15, g: 0.09 * o.gain });
    noise({ t: t, bp: 700, q: 0.8, d: 1.0, a: 0.3, r: 0.3, g: 0.05 * o.gain, pink: true });
  };
  ONE.alert_generic = function (t, o) {
    tone({ t: t, f: 880, type: 'sine', d: 0.25, a: 0.004, r: 0.2, g: 0.14 * o.gain, send: 0.3 });
    tone({ t: t, f: 880, type: 'triangle', d: 0.18, a: 0.004, r: 0.15, g: 0.05 * o.gain });
    tone({ t: t, f: 1760, type: 'sine', d: 0.08, a: 0.003, r: 0.08, g: 0.04 * o.gain });
  };
  ONE.tanker = function (t, o) {
    noise({ t: t, bp: 300, q: 1.1, f2f: 2400, f2d: 1.1, f3f: 350, d: 2.4, a: 0.7, r: 0.6, g: 0.3 * o.gain, pan: -0.85, pan2: 0.85, dec: 1.0, s: 0.9 });
    noise({ t: t, lp: 130, pink: true, d: 2.4, a: 0.6, r: 0.5, g: 0.5 * o.gain });
    tone({ t: t, f: 52, f2: 74, fd: 1.1, f3: 46, type: 'sine', d: 2.4, a: 0.5, r: 0.5, g: 0.16 * o.gain });
    tone({ t: t + 0.9, f: 110, f2: 150, fd: 0.3, f3: 95, type: 'sawtooth', lp: 260, d: 1.2, a: 0.2, r: 0.4, g: 0.05 * o.gain });
  };
  ONE.dozer = function (t, o) {
    var g1 = tone({ t: t, f: 38, type: 'sawtooth', lp: 220, d: 1.4, a: 0.12, r: 0.3, g: 0.28 * o.gain });
    lfo(g1.gain, 9, 0.1 * o.gain, t, t + 1.8);
    tone({ t: t, f: 76, type: 'square', lp: 240, d: 1.4, a: 0.12, r: 0.3, g: 0.07 * o.gain });
    noise({ t: t, lp: 190, pink: true, d: 1.4, a: 0.1, r: 0.3, g: 0.22 * o.gain });
    noise({ t: t + 0.2, bp: 1400, q: 2, d: 0.9, a: 0.2, r: 0.3, g: 0.03 * o.gain });
  };
  ONE.engine_siren = function (t, o) {
    tone({ t: t, f: 600, f2: 1100, fd: 0.45, f3: 620, type: 'triangle', d: 0.9, a: 0.02, r: 0.12, g: 0.13 * o.gain });
    tone({ t: t, f: 600, f2: 1100, fd: 0.45, f3: 620, type: 'sawtooth', lp: 2000, detune: -5, d: 0.9, a: 0.02, r: 0.12, g: 0.05 * o.gain });
  };
  ONE.evac = function (t, o) {
    for (var i = 0; i < 3; i++) {
      tone({ t: t + i * 0.25, f: 740, type: 'square', lp: 1300, d: 0.15, a: 0.005, r: 0.04, g: 0.11 * o.gain });
      tone({ t: t + i * 0.25, f: 740, type: 'sine', d: 0.15, a: 0.005, r: 0.04, g: 0.07 * o.gain });
    }
  };
  ONE.sandbag = function (t, o) {
    tone({ t: t, f: 110, f2: 42, type: 'sine', d: 0.14, a: 0.002, r: 0.1, g: 0.42 * o.gain });
    noise({ t: t, lp: 520, d: 0.07, a: 0.001, r: 0.06, g: 0.22 * o.gain });
  };
  ONE.pump = function (t, o) {
    for (var i = 0; i < 6; i++) {
      var tt = t + i * 0.15;
      tone({ t: tt, f: 95, f2: 58, type: 'sine', d: 0.035, a: 0.002, r: 0.04, g: 0.26 * o.gain });
      noise({ t: tt, bp: 950, q: 1.4, d: 0.025, a: 0.001, r: 0.03, g: 0.14 * o.gain });
    }
    tone({ t: t, f: 55, type: 'sawtooth', lp: 200, d: 0.9, a: 0.05, r: 0.15, g: 0.07 * o.gain });
  };
  ONE.spillway = function (t, o) {
    noise({ t: t, pink: true, bp: 500, q: 0.6, f2f: 1400, f2d: 0.45, f3f: 750, d: 1.3, a: 0.05, r: 0.55, g: 0.4 * o.gain });
    noise({ t: t, hp: 3000, d: 1.2, a: 0.1, r: 0.5, g: 0.09 * o.gain });
    tone({ t: t, f: 60, f2: 40, type: 'sine', d: 1.0, a: 0.05, r: 0.5, g: 0.12 * o.gain });
  };
  ONE.mutual_aid = function (t, o) {
    noise({ t: t, bp: 1800, q: 2.2, d: 0.16, a: 0.003, r: 0.05, g: 0.17 * o.gain, dec: 0.1, s: 0.3 });
    tone({ t: t + 0.22, f: 1000, type: 'square', lp: 1400, d: 0.07, a: 0.003, r: 0.03, g: 0.06 * o.gain });
    tone({ t: t + 0.22, f: 1000, type: 'sine', d: 0.07, a: 0.003, r: 0.03, g: 0.08 * o.gain });
    tone({ t: t + 0.34, f: 1000, type: 'sine', d: 0.07, a: 0.003, r: 0.03, g: 0.08 * o.gain });
  };
  ONE.contained = function (t, o) {
    [[523.25, 0, 0.16], [659.25, 0.12, 0.16], [783.99, 0.24, 0.16], [1046.5, 0.36, 0.55]].forEach(function (n) {
      tone({ t: t + n[1], f: n[0], type: 'triangle', d: n[2], a: 0.006, r: 0.18, g: 0.15 * o.gain, send: 0.45 });
      tone({ t: t + n[1], f: n[0], type: 'sawtooth', lp: 2600, detune: 7, d: n[2], a: 0.006, r: 0.18, g: 0.05 * o.gain });
    });
    tone({ t: t, f: 130.8, type: 'triangle', d: 0.9, a: 0.02, r: 0.4, g: 0.08 * o.gain });
    tone({ t: t + 0.36, f: 392, type: 'sine', d: 0.55, a: 0.01, r: 0.3, g: 0.06 * o.gain, send: 0.4 });
  };
  ONE.damage = function (t, o) {
    tone({ t: t, f: 82, f2: 34, type: 'sine', d: 0.4, a: 0.003, r: 0.3, g: 0.5 * o.gain });
    noise({ t: t, lp: 260, d: 0.25, a: 0.002, r: 0.2, g: 0.3 * o.gain });
    tone({ t: t, f: 55, type: 'triangle', d: 0.4, a: 0.01, r: 0.25, g: 0.12 * o.gain });
  };
  ONE.advisor = function (t, o) {
    var h = hashStr(o.id || 'advisor');
    var f = 175 * Math.pow(2, (h % 13) / 12), up = (h >> 4) % 2 === 0, f2 = f * (up ? 1.26 : 0.84);
    var fm1 = 550 + (h % 5) * 90, fm2 = 1100 + ((h >> 3) % 6) * 120;
    tone({ t: t, f: f, type: 'sawtooth', bp: fm1, q: 3.5, d: 0.1, a: 0.015, r: 0.05, g: 0.2 * o.gain });
    tone({ t: t, f: f, type: 'sawtooth', bp: fm2, q: 5, d: 0.1, a: 0.015, r: 0.05, g: 0.1 * o.gain });
    tone({ t: t, f: f, type: 'sine', d: 0.1, a: 0.01, r: 0.05, g: 0.08 * o.gain });
    tone({ t: t + 0.13, f: f2, type: 'sawtooth', bp: fm1 * 1.1, q: 3.5, d: 0.14, a: 0.015, r: 0.07, g: 0.2 * o.gain });
    tone({ t: t + 0.13, f: f2, type: 'sawtooth', bp: fm2, q: 5, d: 0.14, a: 0.015, r: 0.07, g: 0.1 * o.gain });
    tone({ t: t + 0.13, f: f2, type: 'sine', d: 0.14, a: 0.01, r: 0.07, g: 0.08 * o.gain });
  };
  ONE.good = function (t, o) {
    [523.25, 659.25, 783.99].forEach(function (f, i) { tone({ t: t + i * 0.03, f: f, type: 'sine', d: 0.3, a: 0.004, r: 0.25, g: 0.1 * o.gain, send: 0.3 }); });
    tone({ t: t, f: 1046.5, type: 'triangle', d: 0.12, a: 0.004, r: 0.1, g: 0.03 * o.gain });
  };
  ONE.bad = function (t, o) {
    [440, 523.25, 659.25].forEach(function (f, i) { tone({ t: t + i * 0.04, f: f, type: 'triangle', d: 0.4, a: 0.006, r: 0.3, g: 0.09 * o.gain, send: 0.25 }); });
    tone({ t: t, f: 110, type: 'sine', d: 0.35, a: 0.01, r: 0.25, g: 0.07 * o.gain });
  };
  ONE.whoosh = function (t, o) {
    noise({ t: t, bp: 400, q: 0.9, f2f: 1900, f2d: 0.22, f3f: 500, d: 0.5, a: 0.12, r: 0.25, g: 0.12 * o.gain, pan: -0.4, pan2: 0.4 });
    noise({ t: t, lp: 200, pink: true, d: 0.45, a: 0.1, r: 0.25, g: 0.1 * o.gain });
  };

  /* ------------------------------------------------------------------ loops (crossfaded, intensity-controlled, one scheduler) */
  function mkNoise(L, pink) { var s = ctx.createBufferSource(); s.buffer = pink ? pinkBuf : noiseBuf; s.loop = true; s.start(0, Math.random() * 1.5); L.nodes.push(s); return s; }
  function mkFilter(L, type, f, q) { var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; L.nodes.push(b); return b; }
  function mkGain(L, v) { var g = ctx.createGain(); g.gain.value = v; L.nodes.push(g); return g; }
  function mkOsc(L, type, f) { var o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); L.nodes.push(o); return o; }
  function mkLfo(L, param, freq, depth, type) { var o = mkOsc(L, type || 'sine', freq); var g = mkGain(L, depth); o.connect(g); g.connect(param); return g; }
  function mkShaper(L, curveFn) { var ws = ctx.createWaveShaper(), n = 256, c = new Float32Array(n); for (var i = 0; i < n; i++) c[i] = curveFn(i / (n - 1) * 2 - 1); ws.curve = c; L.nodes.push(ws); return ws; }
  function link() { for (var i = 0; i < arguments.length - 1; i++) arguments[i].connect(arguments[i + 1]); }
  function tgt(param, v, tc) { param.setTargetAtTime(v, now(), tc || 0.4); }
  /* schedule fn(t) for every due time before tAhead; L[key] keeps the next due time */
  function every(L, key, tAhead, minS, maxS, fn) {
    var t = L[key] || 0, tn = now(); if (t < tn) t = tn + rnd(0.02, 0.25);
    var guard = 0;
    while (t < tAhead && guard++ < 12) { fn(t); t += rnd(minS, maxS); }
    L[key] = t;
  }
  function crackle(L, out) {   // bursty filtered noise, amplitude driven by a slow noise → threshold shaper (no scheduling needed)
    var src = mkNoise(L, false), bp = mkFilter(L, 'bandpass', 2800, 0.8), g = mkGain(L, 0);
    link(src, bp, g, out);
    var mod = mkNoise(L, false), mlp = mkFilter(L, 'lowpass', 26, 1.2), boost = mkGain(L, 60);
    var sh = mkShaper(L, function (x) { return x <= 0.18 ? 0 : Math.min(1, (x - 0.18) * 2.2); });
    var depth = mkGain(L, 1);
    link(mod, mlp, boost, sh, depth); depth.connect(g.gain);
    return { g: g, depth: depth, bp: bp };
  }
  function pop(t, dest, k) {
    tone({ t: t, f: rnd(160, 260), f2: 60, type: 'sine', d: 0.06, a: 0.002, r: 0.05, g: 0.22 * k, dest: dest });
    noise({ t: t, bp: rnd(1200, 2600), q: 1.5, d: 0.02, a: 0.001, r: 0.02, g: 0.3 * k, dest: dest });
  }
  function rainBed(L, out) {
    var body = mkNoise(L, true), hp = mkFilter(L, 'highpass', 1500), gb = mkGain(L, 0.6);
    link(body, hp, gb, out);
    var hiss = mkNoise(L, false), bp = mkFilter(L, 'bandpass', 6000, 0.5), gh = mkGain(L, 0.12);
    link(hiss, bp, gh, out);
    return { hp: hp, gb: gb, gh: gh };
  }
  function droplet(t, dest, k) {
    var f = rnd(1400, 3600);
    tone({ t: t, f: f, f2: f * 0.7, type: 'sine', d: 0.025, a: 0.002, r: 0.03, g: 0.045 * k, dest: dest, pan: rnd(-0.8, 0.8) });
  }
  function windBed(L, out) {
    var src = mkNoise(L, true), bp = mkFilter(L, 'bandpass', 500, 1.4), g = mkGain(L, 0.6);
    link(src, bp, g, out);
    mkLfo(L, bp.frequency, 0.13, 220);
    mkLfo(L, bp.frequency, 0.031, 140);
    mkLfo(L, g.gain, 0.07, 0.18);
    return { bp: bp, g: g };
  }
  function thunder(t, dest, k) {
    noise({ t: t, hp: 1400, d: 0.07, a: 0.002, r: 0.18, g: 0.28 * k, dest: dest });
    noise({ t: t + 0.05, pink: true, lp: rnd(80, 160), d: rnd(2.0, 3.8), a: 0.08, r: 1.3, g: 1.0 * k, dec: 0.7, s: 0.45, dest: dest, pan: rnd(-0.6, 0.6) });
    tone({ t: t + 0.05, f: 46, f2: 28, type: 'sine', d: 1.6, a: 0.05, r: 1.0, g: 0.35 * k, dest: dest });
  }
  function chirp(t, dest, k) {
    var f = rnd(2300, 4300), n = 2 + ((Math.random() < 0.3) ? 1 : 0);
    for (var i = 0; i < n; i++) {
      var tt = t + i * rnd(0.1, 0.17), fi = f * rnd(0.92, 1.1);
      tone({ t: tt, f: fi, f2: fi * 1.32, fd: 0.05, f3: fi * 1.05, type: 'sine', d: 0.075, a: 0.01, r: 0.04, g: 0.055 * k, dest: dest, send: 0.25, pan: rnd(-0.7, 0.7) });
    }
  }
  function burble(t, dest, k) {
    var f = rnd(300, 900);
    tone({ t: t, f: f, f2: f * 1.8, type: 'sine', d: 0.05, a: 0.01, r: 0.04, g: 0.04 * k, dest: dest, pan: rnd(-0.5, 0.5) });
  }
  function hammer(t, dest, k) {
    noise({ t: t, bp: rnd(1800, 2600), q: 3, d: 0.02, a: 0.001, r: 0.06, g: 0.22 * k, dest: dest });
    tone({ t: t, f: 900, f2: 480, type: 'sine', d: 0.02, a: 0.001, r: 0.05, g: 0.12 * k, dest: dest });
  }

  var LOOP_DEFS = {
    fire: {
      level: function (i) { return 0.35 + 0.65 * i; },
      build: function (L) {
        var roar = mkNoise(L, true), lp = mkFilter(L, 'lowpass', 400, 0.7), g = mkGain(L, 0.7);
        link(roar, lp, g, L.out); mkLfo(L, g.gain, 0.5, 0.12); mkLfo(L, lp.frequency, 0.23, 90);
        L.roar = { lp: lp, g: g }; L.cr = crackle(L, L.out);
      },
      set: function (L, i) { tgt(L.roar.lp.frequency, 250 + 900 * i); tgt(L.roar.g.gain, 0.45 + 0.6 * i); tgt(L.cr.depth.gain, 0.5 + 1.3 * i); tgt(L.cr.bp.frequency, 2400 + 1200 * i); },
      tick: function (L, tAhead) { var i = L.intensity; every(L, 'nextPop', tAhead, 0.25 + (1 - i) * 1.4, 1.0 + (1 - i) * 2.2, function (t) { pop(t, L.out, 0.6 + 0.8 * i); }); }
    },
    mopup: {
      level: function (i) { return 0.3 + 0.5 * i; },
      build: function (L) {
        L.cr = crackle(L, L.out); L.cr.depth.gain.value = 0.35;
        var hiss = mkNoise(L, false), hp = mkFilter(L, 'highpass', 4000), g = mkGain(L, 0.22); link(hiss, hp, g, L.out); L.hiss = g;
      },
      set: function (L, i) { tgt(L.cr.depth.gain, 0.2 + 0.5 * i); tgt(L.hiss.gain, 0.12 + 0.2 * i); },
      tick: function (L, tAhead) { every(L, 'nextPop', tAhead, 1.2, 4.5, function (t) { pop(t, L.out, 0.35 + 0.3 * L.intensity); }); }
    },
    rain: {
      level: function (i) { return 0.3 + 0.7 * i; },
      build: function (L) { L.r = rainBed(L, L.out); },
      set: function (L, i) { tgt(L.r.hp.frequency, 1900 - 1000 * i); tgt(L.r.gb.gain, 0.4 + 0.5 * i); tgt(L.r.gh.gain, 0.06 + 0.14 * i); },
      tick: function (L, tAhead) { var i = L.intensity; every(L, 'nextDrop', tAhead, 0.1 + (1 - i) * 0.3, 0.3 + (1 - i) * 0.6, function (t) { droplet(t, L.out, 0.6 + 0.6 * i); }); }
    },
    storm: {
      level: function (i) { return 0.45 + 0.55 * i; },
      build: function (L) { L.r = rainBed(L, L.out); L.r.gb.gain.value = 0.9; L.w = windBed(L, L.out); L.nextThunder = now() + rnd(1.5, 4); },
      set: function (L, i) { tgt(L.r.hp.frequency, 1300 - 700 * i); tgt(L.r.gb.gain, 0.6 + 0.5 * i); tgt(L.w.bp.frequency, 380 + 420 * i); tgt(L.w.g.gain, 0.45 + 0.5 * i); },
      tick: function (L, tAhead) {
        var i = L.intensity;
        every(L, 'nextDrop', tAhead, 0.08, 0.28, function (t) { droplet(t, L.out, 0.8 + 0.5 * i); });
        every(L, 'nextThunder', tAhead, 5, 12, function (t) { thunder(t, L.out, 0.6 + 0.6 * i); });
        every(L, 'nextGust', tAhead, 3, 7, function (t) { L.w.bp.frequency.setTargetAtTime(700 + 500 * i, t, 0.35); L.w.bp.frequency.setTargetAtTime(380 + 420 * i, t + 1.2, 0.9); });
      }
    },
    wind: {
      level: function (i) { return 0.3 + 0.7 * i; },
      build: function (L) { L.w = windBed(L, L.out); },
      set: function (L, i) { tgt(L.w.bp.frequency, 330 + 520 * i); tgt(L.w.g.gain, 0.35 + 0.6 * i); },
      tick: function (L, tAhead) { var i = L.intensity; every(L, 'nextGust', tAhead, 3, 8, function (t) { L.w.bp.frequency.setTargetAtTime(650 + 500 * i, t, 0.4); L.w.bp.frequency.setTargetAtTime(330 + 520 * i, t + 1.4, 1.0); }); }
    },
    river: {
      level: function (i) { return 0.25 + 0.75 * i; },
      build: function (L) {
        var src = mkNoise(L, true), bp = mkFilter(L, 'bandpass', 700, 0.7), g = mkGain(L, 0.5); link(src, bp, g, L.out);
        mkLfo(L, bp.frequency, 0.4, 140); mkLfo(L, g.gain, 0.9, 0.08);
        var hi = mkNoise(L, false), hp = mkFilter(L, 'highpass', 3500), gh = mkGain(L, 0.07); link(hi, hp, gh, L.out);
        L.bp = bp; L.g = g; L.gh = gh;
      },
      set: function (L, i) { tgt(L.bp.frequency, 550 + 400 * i); tgt(L.g.gain, 0.35 + 0.4 * i); tgt(L.gh.gain, 0.04 + 0.08 * i); },
      tick: function (L, tAhead) { every(L, 'nextBurble', tAhead, 0.15, 0.6, function (t) { burble(t, L.out, 0.5 + 0.7 * L.intensity); }); }
    },
    ambience_day: {
      level: function (i) { return 0.3 + 0.7 * i; },
      build: function (L) { var air = mkNoise(L, true), lp = mkFilter(L, 'lowpass', 320), g = mkGain(L, 0.05); link(air, lp, g, L.out); L.nextChirp = now() + rnd(0.8, 2.5); },
      set: function () { },
      tick: function (L, tAhead) { var i = L.intensity; every(L, 'nextChirp', tAhead, 2.2 + (1 - i) * 2.5, 6 + (1 - i) * 4, function (t) { chirp(t, L.out, 0.7 + 0.5 * i); }); }
    },
    construction: {   // internal: plays while a funded-project build scene runs
      level: function (i) { return 0.35 + 0.5 * i; },
      build: function (L) {
        var saw = mkOsc(L, 'sawtooth', 42), sq = mkOsc(L, 'square', 84), lp = mkFilter(L, 'lowpass', 260), g = mkGain(L, 0.22), gsq = mkGain(L, 0.25);
        saw.connect(lp); sq.connect(gsq); gsq.connect(lp); link(lp, g, L.out); mkLfo(L, g.gain, 11, 0.09);
        var pk = mkNoise(L, true), plp = mkFilter(L, 'lowpass', 200), pg = mkGain(L, 0.18); link(pk, plp, pg, L.out);
      },
      set: function () { },
      tick: function (L, tAhead) { every(L, 'nextTap', tAhead, 0.3, 0.8, function (t) { hammer(t, L.out, 0.8); }); }
    }
  };

  function schedTick() {
    if (!ctx) return;
    var tAhead = now() + 0.5;
    Object.keys(LOOPS).forEach(function (n) { var L = LOOPS[n]; if (L.on && L.def.tick) { try { L.def.tick(L, tAhead); } catch (e) { warnDev(e); } } });
  }
  function startScheduler() { if (!schedTimer) schedTimer = setInterval(schedTick, 220); }
  function stopScheduler() { if (schedTimer) { clearInterval(schedTimer); schedTimer = null; } }
  function killLoop(L) {
    if (L.stopTimer) { clearTimeout(L.stopTimer); L.stopTimer = null; }
    L.nodes.forEach(function (n) { try { if (n.stop) n.stop(); } catch (e) { /* ignore */ } try { n.disconnect(); } catch (e) { /* ignore */ } });
    try { L.out.disconnect(); } catch (e) { /* ignore */ }
    L.nodes.length = 0;
    if (LOOPS[L.name] === L) delete LOOPS[L.name];
    if (!Object.keys(LOOPS).length) stopScheduler();
  }
  function fadeOutLoop(L, sec) {
    if (!L.on && L.stopTimer) return;
    L.on = false;
    var t = now(); L.out.gain.cancelScheduledValues(t); L.out.gain.setTargetAtTime(0, t, Math.max(0.05, sec / 3));
    if (L.stopTimer) clearTimeout(L.stopTimer);
    L.stopTimer = setTimeout(function () { L.stopTimer = null; if (!L.on) killLoop(L); }, sec * 1000 + 250);
  }

  /* ------------------------------------------------------------------ public API */
  S.names = Object.keys(ONE);
  S.loopNames = Object.keys(LOOP_DEFS);
  S.play = safe(function (name, opts) {
    var fn = ONE[name]; if (!fn) return false;
    opts = opts || {};
    if (MIN_GAP[name] && throttled('play:' + name, MIN_GAP[name])) return false;
    if (!ready() || st.muted) return false;
    var o = { gain: clamp(opts.gain == null ? 1 : opts.gain, 0, 4), id: opts.id };
    fn(now() + 0.005, o);
    return true;
  });
  S.loop = safe(function (name, on, intensity) {
    var def = LOOP_DEFS[name]; if (!def) return false;
    on = (on === undefined) ? true : !!on;
    var i = clamp(intensity == null ? 0.6 : +intensity, 0, 1);
    if (!ctx || !st.unlocked) { if (on) pendingLoops[name] = { on: true, i: i }; else delete pendingLoops[name]; return false; }
    var L = LOOPS[name];
    if (!on) { if (L) fadeOutLoop(L, 1.4); return true; }
    if (!L) {
      L = LOOPS[name] = { name: name, def: def, nodes: [], out: ctx.createGain(), intensity: i, on: false, stopTimer: null };
      L.out.gain.value = 0; L.out.connect(beds);
      def.build(L);
      startScheduler();
    }
    if (L.stopTimer) { clearTimeout(L.stopTimer); L.stopTimer = null; }
    L.on = true; L.intensity = i;
    var t = now(); L.out.gain.cancelScheduledValues(t); L.out.gain.setTargetAtTime(def.level(i), t, 0.6);
    if (def.set) def.set(L, i);
    return true;
  });
  S.stopAll = safe(function () { Object.keys(LOOPS).forEach(function (n) { fadeOutLoop(LOOPS[n], 0.6); }); pendingLoops = {}; });
  S.activeLoops = function () { var r = {}; Object.keys(LOOPS).forEach(function (n) { if (LOOPS[n].on) r[n] = LOOPS[n].intensity; }); return r; };
  S.isMuted = function () { return st.muted; };
  S.setMuted = safe(function (b) {
    st.muted = !!b; lsSet('watershed.sound.muted', st.muted ? '1' : '0');
    if (master) { var t = now(); master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(st.muted ? 0 : st.volume, t, 0.03); }
    updateButton();
    return st.muted;
  });
  S.toggleMuted = function () { return S.setMuted(!st.muted); };
  S.getVolume = function () { return st.volume; };
  S.setVolume = safe(function (v) {
    st.volume = clamp(+v, 0, 1); lsSet('watershed.sound.volume', st.volume.toFixed(2));
    if (master && !st.muted) { var t = now(); master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(st.volume, t, 0.03); }
    return st.volume;
  });
  S.context = function () { return ctx; };
  S.state = function () { return { context: ctx ? ctx.state : 'none', unlocked: st.unlocked, muted: st.muted, volume: st.volume, attached: st.attached, loops: S.activeLoops(), scheduler: !!schedTimer }; };

  /* ------------------------------------------------------------------ mute button + keyboard */
  function updateButton() {
    if (!btn) return;
    /* silhouette icon (WS.Icons); plain text fallback when icons.js is not loaded */
    var I = root.WS && root.WS.Icons;
    if (I && typeof I.svg === 'function') btn.innerHTML = I.svg(st.muted ? 'volume-muted' : 'volume', 16);
    else btn.textContent = st.muted ? 'off' : 'on';
    btn.setAttribute('aria-pressed', st.muted ? 'true' : 'false');
    btn.title = (st.muted ? 'Sound off' : 'Sound on') + ' — M toggles';
  }
  function makeButton() {
    if (!hasDoc || btn || !document.body) return;
    btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'sound-toggle'; btn.setAttribute('data-nosound', '1'); btn.setAttribute('aria-label', 'Toggle sound');
    var cs = btn.style;
    cs.position = 'fixed'; cs.right = '14px'; cs.bottom = 'calc(var(--bottom-h, 62px) + 22px)'; cs.width = '34px'; cs.height = '34px';
    /* opaque paper disc with an ink border (matches the field-notebook UI; no translucency, no blur) */
    cs.borderRadius = '50%'; cs.border = '2px solid #2a241d'; cs.background = '#f3ead8'; cs.color = '#2a241d';
    cs.font = '10px/1 system-ui, sans-serif'; cs.padding = '0'; cs.cursor = 'pointer'; cs.zIndex = '120'; cs.display = 'flex'; cs.alignItems = 'center'; cs.justifyContent = 'center';
    cs.boxShadow = '2px 2px 0 #2a241d'; cs.pointerEvents = 'auto'; cs.userSelect = 'none';
    btn.addEventListener('click', function (ev) { ev.preventDefault(); S.toggleMuted(); if (!st.muted) S.play('click'); try { btn.blur(); } catch (e) { /* ignore */ } });
    document.body.appendChild(btn);
    updateButton();
  }
  function isTyping(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
  }
  function installKeys() {
    if (!hasDoc) return;
    root.addEventListener('keydown', function (ev) {
      if (!ev || ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
      if (ev.key !== 'm' && ev.key !== 'M') return;
      if (isTyping(ev.target) || isTyping(document.activeElement)) return;
      S.toggleMuted(); if (!st.muted) S.play('click');
    });
  }
  function installClicks() {
    if (!hasDoc) return;
    document.addEventListener('pointerdown', function (ev) {
      var t = ev && ev.target; if (!t || typeof t.closest !== 'function') return;
      var b = t.closest('button'); if (!b || b.disabled) return;
      if (b.closest('[data-nosound]')) return;
      if (!b.closest('#ui')) return;
      if (throttled('uiclick', 60)) return;
      S.play('click');
    }, true);
  }

  S.init = safe(function () {
    if (st.inited) return S;
    st.inited = true;
    var m = lsGet('watershed.sound.muted'); if (m === '1' || m === 'true') st.muted = true;
    var v = parseFloat(lsGet('watershed.sound.volume')); if (isFinite(v)) st.volume = clamp(v, 0, 1);
    if (!AC) { warnDev('AudioContext unavailable; sound disabled'); }
    installUnlock(); installKeys(); installClicks();
    if (hasDoc) { if (document.body) makeButton(); else document.addEventListener('DOMContentLoaded', makeButton); }
    return S;
  });

  /* ------------------------------------------------------------------ attach: wrap existing functions once (no edits to other files) */
  function wrap(obj, key, before, after) {
    if (!obj || typeof obj[key] !== 'function' || obj[key].__wsSound) return false;
    var orig = obj[key];
    var w = function () {
      var args = arguments;
      if (before) { try { before.apply(null, args); } catch (e) { warnDev(e); } }
      var r = orig.apply(this, args);
      if (after) { try { after(r, args); } catch (e) { warnDev(e); } }
      return r;
    };
    w.__wsSound = true; w.__wsOrig = orig;
    obj[key] = w;
    return true;
  }
  var TACTIC_SOUND = { dozer: 'dozer', engine: 'engine_siren', evacuate: 'evac', mutual_aid: 'mutual_aid', sandbag: 'sandbag', pump: 'pump', spillway: 'spillway' };
  var lastTactic = null, lastPaintEv = null;
  function alertSound(text, kind) {
    text = String(text == null ? '' : text); kind = kind || 'info';
    if (kind === 'fire') return 'alert_fire';
    if (kind === 'flood' || kind === 'storm') return 'alert_flood';
    if (kind === 'good') return 'good';
    if (/wildfire/i.test(text)) return 'alert_fire';
    if (/flash flood/i.test(text)) return 'alert_flood';
    if (/evacuat/i.test(text)) return 'evac';
    if (/spillway|emergency release|gates are open|mutual aid/i.test(text)) return null;   // the tactic hook already played these
    if (kind === 'bad') return 'bad';
    return 'alert_generic';
  }
  function afterActionSound(rep) {
    if (!rep || typeof rep !== 'object') return 'contained';
    if (typeof rep.outcome === 'string') return /win|good|contain|success|held/i.test(rep.outcome) ? 'contained' : 'damage';
    if (rep.mode === 'storm' || rep.kind === 'storm') return (num(rep.floodedHouses) <= 0 && num(rep.damageM) < 0.5) ? 'contained' : 'damage';
    if (rep.structuresLost != null || rep.injuries != null) return (num(rep.structuresLost) <= 0 && num(rep.injuries) <= 0) ? 'contained' : 'damage';
    var stats = Array.isArray(rep.stats) ? rep.stats : [], good = 0;
    stats.forEach(function (s) { if (s && s.good) good++; });
    return good * 2 >= stats.length ? 'contained' : 'damage';
  }
  function fireIntensity(level) {
    var l = clamp(num(level, 0), 0, 1);
    if (l <= 0) { S.loop('fire', false); S.loop('mopup', false); return; }
    S.loop('fire', true, l);
    if (l < 0.3) S.loop('mopup', true, 0.6 + (0.3 - l)); else if (LOOPS.mopup && LOOPS.mopup.on) S.loop('mopup', false);
  }
  function weather(kind, intensity) {
    var k = (typeof kind === 'string' && kind) ? kind : 'clear', i = clamp(num(intensity, 0.5), 0, 1);
    if (k === 'rain') { S.loop('rain', true, i); S.loop('storm', false); S.loop('wind', false); }
    else if (k === 'storm') { S.loop('storm', true, Math.max(0.5, i)); S.loop('rain', false); S.loop('wind', false); }
    else if (k === 'snow') { S.loop('wind', true, 0.25 + 0.4 * i); S.loop('rain', false); S.loop('storm', false); }
    else if (k === 'haze' || k === 'smoke') { S.loop('wind', true, 0.15 + 0.25 * i); S.loop('rain', false); S.loop('storm', false); }
    else { S.loop('rain', false); S.loop('storm', false); S.loop('wind', false); }
  }
  function onPaint(ev) {
    if (!ev || ev === lastPaintEv) return; lastPaintEv = ev;
    var cells = ev.cells || [];
    if (lastTactic === 'dozer' && cells.length) S.play('dozer');
    else if (lastTactic === 'sandbag' && cells.length) S.play('sandbag');
    else if (lastTactic === 'pump' && ev.done) S.play('pump');
  }
  S.attach = safe(function (game) {
    if (st.attached) return true;
    S.init();
    var UI = WS.UI, R = WS.Renderer;
    game = game || root.game || WS.game;
    if (game && typeof game === 'object') {
      wrap(game, 'fundProject', null, function (r) { if (r && r.ok) S.play('fund'); });
      wrap(game, 'endSeason', function () {
        var running = false, ended = false;
        try { running = typeof game.isRunning === 'function' && game.isRunning(); ended = typeof game.isEnded === 'function' && game.isEnded(); } catch (e) { /* ignore */ }
        if (!running && !ended) S.play('season_end');
      });
      var tactic = function (r, args) { if (r && r.ok && TACTIC_SOUND[args[0]]) S.play(TACTIC_SOUND[args[0]]); };
      wrap(game, 'applyTactic', null, tactic);
      wrap(game, 'applyTacticToZone', null, tactic);
      wrap(game, 'selectTactic', null, function (r, args) { lastTactic = r || null; if (args[0]) S.play('select'); });
      wrap(game, 'setPaused', null, function () { S.play('click'); });
      wrap(game, 'askAdvisor', function (id) { S.play('advisor', { id: id }); });
    }
    if (UI) {
      wrap(UI, 'alert', function (text, kind) { var n = alertSound(text, kind); if (n) S.play(n); });
      wrap(UI, 'toast', function (text, kind) {
        if (kind === 'good') { if (!throttled('toast:good', 350)) S.play('good'); }
        else if (kind === 'bad') { if (!throttled('toast:bad', 350)) S.play('bad'); }
        else if (kind === 'warn') { if (!throttled('toast:warn', 350)) S.play('bad', { gain: 0.6 }); }
      });
      wrap(UI, 'showEventCard', function () { S.play('card'); }, function (r) { if (r && typeof r.then === 'function') r.then(function () { S.play('card_choice'); }, function () { }); });
      wrap(UI, 'showSeasonReport', function () { S.play('report'); });
      wrap(UI, 'showAfterAction', function (rep) { S.play(afterActionSound(rep)); });
      wrap(UI, 'showBubble', function (spec) { S.play('advisor', { id: spec && typeof spec === 'object' ? spec.id : spec }); });
      wrap(UI, 'showTactical', function (spec) {
        var mode = (spec && spec.mode === 'storm') ? 'storm' : 'fire';
        if (mode === 'fire') { if (!LOOPS.fire || !LOOPS.fire.on) S.loop('fire', true, 0.5); }
        else if (!LOOPS.storm || !LOOPS.storm.on) S.loop('storm', true, 0.9);
      });
      wrap(UI, 'hideTactical', function () { S.loop('fire', false); S.loop('storm', false); S.loop('mopup', false); });
    }
    if (R) {
      wrap(R, 'setFireIntensity', function (level) { fireIntensity(level); });
      wrap(R, 'setWeather', function (kind, i) { weather(kind, i); });
      wrap(R, 'playRetardantDrop', function () { S.play('tanker'); });
      wrap(R, 'flyTo', function () { S.play('whoosh'); });
      wrap(R, 'flyToZone', function () { S.play('whoosh'); });
      wrap(R, 'setSeason', function () { S.loop('ambience_day', true, 0.5); S.loop('river', true, 0.3); });
      wrap(R, 'playBuild', null, function (r) {
        S.loop('construction', true, 0.7);
        var done = function () { S.loop('construction', false); S.play('build_done'); };
        if (r && typeof r.then === 'function') r.then(done, done); else done();
      });
      if (typeof R.onCellPaint === 'function' && !R.onCellPaint.__wsSound) {
        var origPaint = R.onCellPaint;
        R.onCellPaint = function (fn) {
          if (typeof fn !== 'function') return origPaint.apply(this, arguments);
          return origPaint.call(this, function (ev) { try { onPaint(ev); } catch (e) { warnDev(e); } return fn.apply(this, arguments); });
        };
        R.onCellPaint.__wsSound = true; R.onCellPaint.__wsOrig = origPaint;
      }
    }
    st.attached = true;
    return true;
  });

  /* ------------------------------------------------------------------ auto boot: init now, attach once window.game appears */
  if (hasDoc) {
    var boot = function () {
      S.init();
      var tries = 0;
      var tryAttach = function () { if (root.game && typeof root.game === 'object') { S.attach(root.game); return true; } return false; };
      if (!tryAttach()) {
        var iv = setInterval(function () { tries++; if (tryAttach() || tries >= 80) clearInterval(iv); }, 250);
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }
})();
