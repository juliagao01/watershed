/* Watershed — seeded RNG + simplex noise. Deterministic given seed. Works in Node and browser. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashSeed(seed) {
    if (typeof seed === 'number') return seed >>> 0;
    var s = String(seed), h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  WS.RNG = {
    hashSeed: hashSeed,
    /** create(seed) -> rng object */
    create: function (seed) {
      var next = mulberry32(hashSeed(seed == null ? Date.now() : seed));
      var rng = {
        seed: seed,
        next: next,                                   // [0,1)
        range: function (a, b) { return a + (b - a) * next(); },
        int: function (a, b) { return a + Math.floor(next() * (b - a + 1)); }, // inclusive
        chance: function (p) { return next() < p; },
        pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
        shuffle: function (arr) { for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(next() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; },
        gauss: function (mu, sigma) {
          var u = 0, v = 0; while (u === 0) u = next(); while (v === 0) v = next();
          return (mu || 0) + (sigma == null ? 1 : sigma) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        },
        fork: function (label) { return WS.RNG.create(hashSeed(String(seed) + ':' + label)); }
      };
      return rng;
    }
  };

  /* 2D simplex noise (Stefan Gustavson style), seeded permutation */
  var grad3 = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  var F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;

  WS.Noise = {
    /** create(seed) -> { simplex2(x,y) in [-1,1], fbm(x,y,oct,lac,gain) in ~[-1,1], ridged(x,y,oct) in [0,1] } */
    create: function (seed) {
      var r = WS.RNG.create(seed);
      var p = new Uint8Array(256); for (var i = 0; i < 256; i++) p[i] = i;
      for (i = 255; i > 0; i--) { var j = Math.floor(r.next() * (i + 1)); var t = p[i]; p[i] = p[j]; p[j] = t; }
      var perm = new Uint8Array(512), permMod8 = new Uint8Array(512);
      for (i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod8[i] = perm[i] & 7; }

      function simplex2(xin, yin) {
        var n0 = 0, n1 = 0, n2 = 0;
        var s = (xin + yin) * F2, i = Math.floor(xin + s), j = Math.floor(yin + s);
        var t = (i + j) * G2, X0 = i - t, Y0 = j - t, x0 = xin - X0, y0 = yin - Y0;
        var i1, j1; if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
        var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
        var ii = i & 255, jj = j & 255;
        var t0 = 0.5 - x0 * x0 - y0 * y0;
        if (t0 >= 0) { var g0 = grad3[permMod8[ii + perm[jj]]]; t0 *= t0; n0 = t0 * t0 * (g0[0] * x0 + g0[1] * y0); }
        var t1 = 0.5 - x1 * x1 - y1 * y1;
        if (t1 >= 0) { var g1 = grad3[permMod8[ii + i1 + perm[jj + j1]]]; t1 *= t1; n1 = t1 * t1 * (g1[0] * x1 + g1[1] * y1); }
        var t2 = 0.5 - x2 * x2 - y2 * y2;
        if (t2 >= 0) { var g2 = grad3[permMod8[ii + 1 + perm[jj + 1]]]; t2 *= t2; n2 = t2 * t2 * (g2[0] * x2 + g2[1] * y2); }
        return 70 * (n0 + n1 + n2);
      }
      function fbm(x, y, oct, lac, gain) {
        oct = oct || 5; lac = lac || 2.0; gain = gain || 0.5;
        var a = 1, f = 1, sum = 0, norm = 0;
        for (var o = 0; o < oct; o++) { sum += a * simplex2(x * f, y * f); norm += a; a *= gain; f *= lac; }
        return sum / norm;
      }
      function ridged(x, y, oct) {
        oct = oct || 4; var a = 1, f = 1, sum = 0, norm = 0;
        for (var o = 0; o < oct; o++) { var n = 1 - Math.abs(simplex2(x * f, y * f)); sum += a * n * n; norm += a; a *= 0.5; f *= 2.1; }
        return sum / norm;
      }
      return { simplex2: simplex2, fbm: fbm, ridged: ridged };
    }
  };

  /* tiny event bus */
  WS.Bus = (function () {
    var h = {};
    return {
      on: function (ev, fn) { (h[ev] = h[ev] || []).push(fn); return function () { WS.Bus.off(ev, fn); }; },
      off: function (ev, fn) { if (!h[ev]) return; h[ev] = h[ev].filter(function (f) { return f !== fn; }); },
      emit: function (ev, data) { (h[ev] || []).slice().forEach(function (f) { try { f(data); } catch (e) { console.error('Bus handler error for', ev, e); } }); }
    };
  })();
})();
