/* Watershed — world generation (terrain, river, reservoir, zones, buildings). Export WS.World.
   Deterministic from seed (WS.RNG / WS.Noise only). Runs in Node with no DOM. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C, L = C.LAND;
  var N = C.N, NN = N * N;
  var M3_PER_AF = 1233.48;
  var CELL_AREA_M2 = C.CELL_M * C.CELL_M;

  var DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
  var DY8 = [0, 1, 1, 1, 0, -1, -1, -1];

  function idx(x, y) { return y * N + x; }
  function inB(x, y) { return x >= 0 && y >= 0 && x < N && y < N; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function sstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  /* ---------- min-heap on (key, index) for priority flood ---------- */
  function Heap(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = this.n++;
    k[i] = key; v[i] = val;
    while (i > 0) { var p = (i - 1) >> 1; if (k[p] <= k[i]) break; var tk = k[p]; k[p] = k[i]; k[i] = tk; var tv = v[p]; v[p] = v[i]; v[i] = tv; i = p; }
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, top = v[0], n = --this.n;
    if (n > 0) {
      k[0] = k[n]; v[0] = v[n]; var i = 0;
      for (;;) { var l = 2 * i + 1, r = l + 1, m = i; if (l < n && k[l] < k[m]) m = l; if (r < n && k[r] < k[m]) m = r; if (m === i) break; var tk = k[m]; k[m] = k[i]; k[i] = tk; var tv = v[m]; v[m] = v[i]; v[i] = tv; i = m; }
    }
    return top;
  };

  /* ---------- river path: Catmull-Rom through control points, rasterised to an 8-connected cell chain ---------- */
  function catmull(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
    };
  }
  function rasterPath(ctrl) {
    var pts = [];
    for (var i = 0; i < ctrl.length - 1; i++) {
      var p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
      var seg = Math.max(2, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) * 3));
      for (var s = 0; s < seg; s++) pts.push(catmull(p0, p1, p2, p3, s / seg));
    }
    pts.push({ x: ctrl[ctrl.length - 1].x, y: ctrl[ctrl.length - 1].y });
    // to cells, dedupe, make 8-connected
    var cells = [], seen = new Uint8Array(NN);
    function add(x, y) {
      x = clamp(Math.round(x), 0, N - 1); y = clamp(Math.round(y), 0, N - 1);
      var i = idx(x, y);
      if (cells.length) {
        var last = cells[cells.length - 1];
        if (Math.abs(last.x - x) > 1 || Math.abs(last.y - y) > 1) { // bridge gap
          var steps = Math.max(Math.abs(last.x - x), Math.abs(last.y - y));
          for (var s = 1; s < steps; s++) add(last.x + (x - last.x) * s / steps, last.y + (y - last.y) * s / steps);
        }
      }
      if (seen[i]) return;
      seen[i] = 1; cells.push({ x: x, y: y });
    }
    for (var k = 0; k < pts.length; k++) add(pts[k].x, pts[k].y);
    // remove staircase redundancies: if cell k-1 and k+1 are 8-adjacent, drop k
    var out = [cells[0]];
    for (k = 1; k < cells.length - 1; k++) {
      var a = out[out.length - 1], b = cells[k + 1];
      if (Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1) continue;
      out.push(cells[k]);
    }
    out.push(cells[cells.length - 1]);
    return out;
  }
  function bresenham(x0, y0, x1, y1, fn) {
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (var guard = 0; guard < 4 * N; guard++) {
      fn(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /* =====================================================================================
     generate(seed)
     ===================================================================================== */
  function generate(seed) {
    if (seed == null) seed = 1;
    var rng = WS.RNG.create(seed);
    var rJit = rng.fork('layout'), rHouse = rng.fork('houses');
    var noise = WS.Noise.create(WS.RNG.hashSeed(String(seed) + ':terrain'));
    var noise2 = WS.Noise.create(WS.RNG.hashSeed(String(seed) + ':detail'));

    var elev = new Float32Array(NN), land = new Uint8Array(NN), slope = new Float32Array(NN), aspect = new Float32Array(NN);
    var fuel = new Float32Array(NN), moisture = new Float32Array(NN), burn = new Float32Array(NN), treeDensity = new Float32Array(NN);
    var cropHealth = new Float32Array(NN), habitat = new Float32Array(NN), flowDir = new Int32Array(NN), flowAcc = new Float32Array(NN);
    var zone = new Int16Array(NN); zone.fill(-1);

    /* ---------- 1. river path ---------- */
    function jit(x, y, amt) { return { x: x + rJit.range(-amt, amt), y: y + rJit.range(-amt, amt) }; }
    var ctrl = [
      { x: 12, y: 10 }, jit(18, 20, 1.2), jit(26, 30, 1.5), jit(33, 40, 1.5), jit(41, 48, 1.0),
      { x: 47, y: 55 }, { x: 53, y: 61 }, { x: 58, y: 66 }, { x: 62, y: 70 },              // basin + dam (fixed)
      jit(63, 77, 0.8), jit(66, 85, 1.2), jit(72, 92, 1.2), jit(82, 100, 1.2), jit(94, 108, 1.2), jit(106, 116, 1.0), { x: 118, y: 124 }
    ];
    var path = rasterPath(ctrl);
    var K = path.length;
    var pathIdx = new Int32Array(K), PX = new Float64Array(K), PY = new Float64Array(K);
    var onPath = new Int32Array(NN); onPath.fill(-1);
    for (var k = 0; k < K; k++) { pathIdx[k] = idx(path[k].x, path[k].y); onPath[pathIdx[k]] = k; PX[k] = path[k].x; PY[k] = path[k].y; }

    /* ---------- 2. reservoir ellipse (axis inlet -> dam) ---------- */
    var RC = { x: 53, y: 61 }, RA = 11.6, RB = 6.2;                 // centre, semi-axes (cells)
    var AXX = Math.SQRT1_2, AXY = Math.SQRT1_2;                     // along-axis unit vector (NW->SE)
    function ellipseR(x, y) {                                       // normalised radius, 1 = shore (with wobble)
      var dx = x - RC.x, dy = y - RC.y;
      var u = dx * AXX + dy * AXY, v = -dx * AXY + dy * AXX;
      var wob = 1 + 0.12 * noise2.fbm(x * 0.09 + 7, y * 0.09 - 3, 3);
      u /= RA; v /= RB; return Math.sqrt(u * u + v * v) / wob;
    }
    function ellipseProg(x, y) { var u = (x - RC.x) * AXX + (y - RC.y) * AXY; return clamp((u + RA) / (2 * RA), 0, 1); } // 0 inlet .. 1 dam
    var entryIndex = -1, damIndex = -1;
    for (k = 0; k < K; k++) {
      var inside = ellipseR(path[k].x, path[k].y) < 1;
      if (inside && entryIndex < 0) entryIndex = k;
      if (entryIndex >= 0 && !inside && k > entryIndex) { damIndex = k; break; }
    }
    if (entryIndex < 0) entryIndex = Math.floor(K * 0.38);
    if (damIndex < 0) damIndex = Math.floor(K * 0.48);
    var dam = { x: path[damIndex].x, y: path[damIndex].y };
    var damI = pathIdx[damIndex];

    /* ---------- 3. river longitudinal profile (strictly decreasing) ---------- */
    var SPILL = 2120, SRC_ELEV = 3250, OUT_ELEV = 1945;
    var rElev = new Float64Array(K);
    for (k = 0; k < entryIndex; k++) { var u = k / entryIndex; rElev[k] = (SPILL + 8) + (SRC_ELEV - SPILL - 8) * Math.pow(1 - u, 1.55); }
    for (k = entryIndex; k < damIndex; k++) { var ub = (k - entryIndex) / Math.max(1, damIndex - entryIndex); rElev[k] = (SPILL - 2) - 60 * ub; }
    var damBase = rElev[damIndex - 1] - 1.5; rElev[damIndex] = damBase;
    var tail = K - 1 - damIndex, e30 = 1 - Math.exp(-30);
    for (k = damIndex + 1; k < K; k++) {
      var v = (k - damIndex) / tail;
      var g = 0.22 * (1 - Math.exp(-v * 30)) / e30 + 0.78 * (1 - Math.pow(1 - v, 1.35));
      rElev[k] = damBase - (damBase - OUT_ELEV) * g;
    }
    for (k = 1; k < K; k++) if (!(rElev[k] < rElev[k - 1])) rElev[k] = rElev[k - 1] - 0.05;   // safety

    /* channel width per node (cells) */
    var widths = new Float32Array(K);
    for (k = 0; k < K; k++) {
      if (k < entryIndex) widths[k] = 1 + 0.7 * (k / entryIndex);
      else if (k <= damIndex) widths[k] = 1.8;
      else widths[k] = 2 + 1.0 * clamp((k - damIndex) / tail, 0, 1);
    }
    /* valley cross-section parameters for a cell: reference elevation, floor half-width F, wall amplitude A, wall length L.
       side: +1 = right bank (SW/W), -1 = left bank (NE/E, the town side). */
    var XS = { ref: 0, F: 0, A: 0, L: 0 };
    function crossSection(k, side) {
      if (k < entryIndex) { var m = k / entryIndex; XS.ref = rElev[k]; XS.F = 1.5 + 2.5 * m; XS.A = 640 - 200 * m; XS.L = 9 + 3 * m; }
      else if (k < damIndex) { XS.ref = SPILL + 2; if (side < 0) { XS.F = 34; XS.A = 280; XS.L = 12; } else { XS.F = 3; XS.A = 420; XS.L = 11; } }
      else {
        var q = clamp((k - damIndex) / tail, 0, 1); XS.ref = rElev[k];
        if (side < 0) { XS.F = 36 - 20 * sstep(0.15, 0.45, q); XS.A = 300 - 80 * q; XS.L = 12; }
        else { XS.F = 10 + 8 * sstep(0.15, 0.4, q); XS.A = 330 - 60 * q; XS.L = 11; }
      }
      return XS;
    }

    /* ---------- 4. nearest path node per cell (brute force, cheap at this size) ---------- */
    var nearK = new Int32Array(NN), nearD = new Float32Array(NN), sideOf = new Float32Array(NN);
    var x, y, i, k, d, j, nx, ny, n8;
    (function computeNearest() { var x, y, i, k;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = idx(x, y); var best = 1e9, bk = 0, ddx, ddy, d2;
      for (k = 0; k < K; k += 4) { ddx = PX[k] - x; ddy = PY[k] - y; d2 = ddx * ddx + ddy * ddy; if (d2 < best) { best = d2; bk = k; } }
      var kLo = Math.max(0, bk - 6), kHi = Math.min(K - 1, bk + 6);
      for (k = kLo; k <= kHi; k++) { ddx = PX[k] - x; ddy = PY[k] - y; d2 = ddx * ddx + ddy * ddy; if (d2 < best) { best = d2; bk = k; } }
      nearK[i] = bk; nearD[i] = Math.sqrt(best);
      var ka = Math.max(0, bk - 2), kb = Math.min(K - 1, bk + 2);
      var tx = path[kb].x - path[ka].x, ty = path[kb].y - path[ka].y;
      var cr = tx * (y - path[bk].y) - ty * (x - path[bk].x);
      sideOf[i] = cr > 0 ? 1 : (cr < 0 ? -1 : 0);     // +1 = right bank (SW/W side), -1 = left bank (NE/E, town side)
    }
    })();

    /* ---------- 5. base elevation: river profile + valley cross-section + noise + peaks + town bench ---------- */
    var TOWN = { x0: 64, y0: 56, x1: 100, y1: 94 };
    function townBenchW(x, y) {
      var ex = Math.max(TOWN.x0 - x, 0, x - TOWN.x1), ey = Math.max(TOWN.y0 - y, 0, y - TOWN.y1);
      return 1 - sstep(0, 7, Math.sqrt(ex * ex + ey * ey));
    }
    var peaks = [{ x: 30, y: 7, h: 260, r: 9 }, { x: 7, y: 34, h: 230, r: 8 }, { x: 44, y: 22, h: 170, r: 7 }];
    var nRoll = new Float32Array(NN), nFine = new Float32Array(NN);   // cached noise fields reused by later passes
    var ridges = [{ x0: 64, y0: 68, x1: 127, y1: 5, h: 55 }, { x0: 36, y0: 70, x1: 6, y1: 92, h: 90 },   // NE abutment ridge: divides the reservoir rim from the town bench
                  { x0: 84, y0: 56, x1: 102, y1: 56, h: 70 }, { x0: 102, y0: 56, x1: 102, y1: 76, h: 70 }];   // last two: the forested hill above the WUI neighborhood
    // reservoir catchment polygon (cell coords), used to group forest sectors 1-4 (upstream) vs 5-6 (above town)
    var CATCH = [[0, 0], [127, 0], [127, 5], [62, 70], [36, 72], [6, 92], [0, 96]];
    function catchmentSide(x, y) {
      var inside = false;
      for (var a = 0, b = CATCH.length - 1; a < CATCH.length; b = a++) {
        var xa = CATCH[a][0], ya = CATCH[a][1], xb = CATCH[b][0], yb = CATCH[b][1];
        if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) inside = !inside;
      }
      return inside;
    }
    for (var rr = 0; rr < ridges.length; rr++) { var rgb = ridges[rr]; rgb.bx0 = Math.min(rgb.x0, rgb.x1) - 10; rgb.bx1 = Math.max(rgb.x0, rgb.x1) + 10; rgb.by0 = Math.min(rgb.y0, rgb.y1) - 10; rgb.by1 = Math.max(rgb.y0, rgb.y1) + 10; }
    function segDist(px, py, ax, ay, bx, by) {
      var vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay, l2 = vx * vx + vy * vy, tt = l2 > 0 ? clamp((wx * vx + wy * vy) / l2, 0, 1) : 0;
      var qx = px - (ax + vx * tt), qy = py - (ay + vy * tt); return Math.sqrt(qx * qx + qy * qy);
    }
    (function computeBaseElev() { var x, y, i, k, d, j, nx, ny, n8;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = idx(x, y); k = nearK[i];
      var xs = crossSection(k, sideOf[i]);
      var d = nearD[i], f = xs.F, amp = xs.A, ln = xs.L;
      var townSide = sideOf[i] < 0 && k >= entryIndex;
      var rise = Math.min(d, f) * (townSide ? 1.2 : 2.5);
      if (k >= damIndex) amp *= (1 - 0.3 * sstep(100, 127, x)) * (1 - 0.45 * sstep(104, 127, y));   // valley opens toward the confluence
      if (d > f) rise += amp * (1 - Math.exp(-(d - f) / ln));
      // short gorge below the dam: the bench either side stays near spill level for ~10 nodes
      if (k >= damIndex) rise += (SPILL + 2 - rElev[k]) * (1 - sstep(0, 10, k - damIndex)) * sstep(1, 6, d);
      var base = xs.ref + rise;
      var mtn = sstep(2450, 2850, base) * sstep(0.5, 6, d - f);            // ridged mountains, away from the channel
      var ridge = mtn > 0 ? noise.ridged(x * 0.045, y * 0.045, 4) * 2 - 1 : 0;   // ~[-1,1]
      var roll = noise.fbm(x * 0.06 + 11, y * 0.06 - 5, 3, 2.0, 0.5);        // foothill roll
      var fine = noise2.fbm(x * 0.21, y * 0.21, 3, 2.0, 0.5);                // subtle floor texture
      nRoll[i] = roll; nFine[i] = fine;
      var hill = sstep(1, 5, d - f);
      var e = base + mtn * 330 * ridge + hill * (1 - mtn) * 45 * roll + 4 * fine + 12 * roll * (1 - hill) * sstep(0.5, 3, d);
      for (var p = 0; p < peaks.length; p++) { var pk = peaks[p], pdx = x - pk.x, pdy = y - pk.y, pd = Math.sqrt(pdx * pdx + pdy * pdy) / pk.r; if (pd < 1.6) e += pk.h * Math.exp(-pd * pd * 2.2); }
      // drainage divides: two ridges separate the reservoir's catchment from the hills above town (NE) and the lower valley (SW)
      for (p = 0; p < ridges.length; p++) {
        var rg = ridges[p];
        if (x < rg.bx0 || x > rg.bx1 || y < rg.by0 || y > rg.by1) continue;
        var rd = segDist(x, y, rg.x0, rg.y0, rg.x1, rg.y1); if (rd < 10) e += rg.h * Math.exp(-rd * rd / 18) * sstep(2, 6, d);
      }
      elev[i] = clamp(e, 1900, 3760);
    }
    })();
    // gentle smoothing (removes single-cell spikes); river/reservoir carved afterwards
    var tmp = new Float32Array(NN);
    (function smoothElev() { var x, y, i, k, d, j, nx, ny, n8;
    for (var pass = 0; pass < 2; pass++) {
      for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
        i = idx(x, y); var sum = 0, cnt = 0;
        for (n8 = 0; n8 < 8; n8++) { nx = x + DX8[n8]; ny = y + DY8[n8]; if (inB(nx, ny)) { sum += elev[idx(nx, ny)]; cnt++; } }
        tmp[i] = elev[i] * 0.5 + (sum / cnt) * 0.5;
      }
      elev.set(tmp);
    }
    })();
    // town terraces: quantise bench cells into 5 m steps (softly)
    for (y = TOWN.y0; y <= TOWN.y1; y++) for (x = TOWN.x0; x <= TOWN.x1; x++) {
      i = idx(x, y); var w = townBenchW(x, y) * sstep(2.5, 6, nearD[i]);
      if (w > 0) { var qz = Math.round(elev[i] / 5) * 5; elev[i] = elev[i] + (qz - elev[i]) * 0.65 * w; }
    }

    /* ---------- 6. reservoir bowl + rim, dam wall ---------- */
    var protectedC = new Uint8Array(NN);     // cells near the river at/below the dam — never reservoir
    for (k = damIndex + 1; k < Math.min(K, damIndex + 6); k++) for (n8 = -1; n8 <= 1; n8++) for (var m8 = -1; m8 <= 1; m8++) { nx = path[k].x + n8; ny = path[k].y + m8; if (inB(nx, ny)) protectedC[idx(nx, ny)] = 1; }
    for (k = 0; k < K; k++) protectedC[pathIdx[k]] = (k >= damIndex) ? 1 : protectedC[pathIdx[k]];
    var MAXD = 42;
    for (y = Math.max(0, RC.y - 26); y <= Math.min(N - 1, RC.y + 26); y++) for (x = Math.max(0, RC.x - 26); x <= Math.min(N - 1, RC.x + 26); x++) {
      i = idx(x, y); var rn = ellipseR(x, y);
      if (rn >= 1.7) continue;
      if (rn < 1 && !protectedC[i]) {
        var q = ellipseProg(x, y);
        var depth = MAXD * Math.pow(Math.max(0, 1 - rn * rn), 0.75) * (0.3 + 0.7 * q) + 0.6;
        elev[i] = SPILL - depth;
      } else if (rn >= 1 && !protectedC[i]) {
        var rim = SPILL + 2 + 22 * sstep(1, 1.7, rn);
        elev[i] = Math.max(elev[i], rim);
      }
    }
    // dam wall: abutments beside the dam cell, perpendicular to flow
    var tdx = path[Math.min(K - 1, damIndex + 2)].x - path[Math.max(0, damIndex - 2)].x, tdy = path[Math.min(K - 1, damIndex + 2)].y - path[Math.max(0, damIndex - 2)].y;
    var tl = Math.hypot(tdx, tdy) || 1; tdx /= tl; tdy /= tl;
    for (var w2 = -4; w2 <= 4; w2++) for (var a2 = -1; a2 <= 1; a2++) {
      nx = Math.round(dam.x - tdy * w2 + tdx * a2); ny = Math.round(dam.y + tdx * w2 + tdy * a2);
      if (!inB(nx, ny)) continue; i = idx(nx, ny);
      if (onPath[i] >= 0) continue;
      if (Math.abs(w2) <= 1 && a2 === 0) { elev[i] = Math.max(elev[i], SPILL + 6); protectedC[i] = 1; }
      else if (Math.abs(w2) <= 4 && ellipseR(nx, ny) >= 0.9) { elev[i] = Math.max(elev[i], SPILL + 6); }
    }

    /* ---------- 7. carve channel + banks, wetland flat ---------- */
    var wetK0 = damIndex + 11, wetK1 = damIndex + 19;
    var isWet = new Uint8Array(NN);
    for (k = 0; k < K; k++) {
      var pi = pathIdx[k];
      if (k < entryIndex || k >= damIndex) elev[pi] = rElev[k];
    }
    (function carveChannel() { var x, y, i, k, d, j, nx, ny, n8;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = idx(x, y); if (onPath[i] >= 0) continue;
      k = nearK[i]; d = nearD[i];
      var inBasin = (k >= entryIndex && k < damIndex);
      if (inBasin) continue;
      var extra = d <= Math.round((widths[k] - 1) / 2) + 0.01;
      var bankH = (k < entryIndex) ? 3 + 30 * (1 - k / entryIndex) : 4;
      if (d < 1.5) {
        // bed reference = the highest river node this cell touches, so the bank sits above every adjacent bed cell
        var bedRef = -1e9;
        for (n8 = 0; n8 < 8; n8++) { nx = x + DX8[n8]; ny = y + DY8[n8]; if (inB(nx, ny) && onPath[idx(nx, ny)] >= 0) { var kk2 = onPath[idx(nx, ny)]; if (rElev[kk2] > bedRef) bedRef = rElev[kk2]; } }
        if (bedRef < -1e8) bedRef = rElev[k];
        if (extra) elev[i] = bedRef + 0.4 + 0.05 * d;
        else elev[i] = clamp(elev[i], bedRef + 2.5, bedRef + bankH + 6);
      }
      else if (d < 2.5) { elev[i] = Math.max(elev[i], rElev[k] + 3.0); }
      // wetland flat on the SW side 10-20 nodes below the dam
      if (k >= wetK0 && k <= wetK1 && sideOf[i] > 0 && d >= 1.5 && d <= 6.0) { isWet[i] = 1; elev[i] = rElev[k] + 1.2 + 0.12 * d; }
    }
    })();
    // spike clamp (skip river cells)
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = idx(x, y); if (onPath[i] >= 0) continue;
      var mx = -1e9; for (n8 = 0; n8 < 8; n8++) { nx = x + DX8[n8]; ny = y + DY8[n8]; if (inB(nx, ny)) mx = Math.max(mx, elev[idx(nx, ny)]); }
      if (elev[i] > mx + 35) elev[i] = mx + 35;
    }

    /* ---------- 8. reservoir cells by 4-connected fill below SPILL, then scale depth to capacity ---------- */
    var isRes = new Uint8Array(NN), resList = [];
    var start = idx(RC.x, RC.y), stack = [start]; isRes[start] = 1;
    while (stack.length) {
      i = stack.pop(); resList.push(i);
      x = i % N; y = (i / N) | 0;
      for (n8 = 0; n8 < 8; n8 += 2) {
        nx = x + DX8[n8]; ny = y + DY8[n8]; if (!inB(nx, ny)) continue; var j = idx(nx, ny);
        if (isRes[j] || protectedC[j] || elev[j] >= SPILL) continue;
        isRes[j] = 1; stack.push(j);
      }
    }
    var resCells = Int32Array.from(resList);
    // bowl cells that were excluded from the fill (dam abutments / protected bank) become dry shore above spill level
    for (y = Math.max(0, RC.y - 20); y <= Math.min(N - 1, RC.y + 20); y++) for (x = Math.max(0, RC.x - 20); x <= Math.min(N - 1, RC.x + 20); x++) {
      i = idx(x, y);
      if (!isRes[i] && onPath[i] < 0 && elev[i] < SPILL + 1 && ellipseR(x, y) < 1.12) elev[i] = SPILL + 3 + 2 * (1.12 - ellipseR(x, y));
    }
    // monotone bed along the path through the basin
    for (k = entryIndex; k < damIndex; k++) { pi = pathIdx[k]; if (isRes[pi]) { rElev[k] = elev[pi]; } }
    for (k = entryIndex; k < damIndex; k++) { if (!(rElev[k] < rElev[k - 1] - 0.05)) rElev[k] = rElev[k - 1] - 0.05; }
    for (k = entryIndex; k < damIndex; k++) elev[pathIdx[k]] = rElev[k];
    rElev[damIndex] = Math.min(rElev[damIndex], rElev[damIndex - 1] - 0.5);
    for (k = damIndex + 1; k < K; k++) if (!(rElev[k] < rElev[k - 1])) rElev[k] = rElev[k - 1] - 0.05;
    for (k = damIndex; k < K; k++) elev[pathIdx[k]] = rElev[k];
    function capacityOf(cells, sp) { var vol = 0; for (var c = 0; c < cells.length; c++) vol += Math.max(0, sp - elev[cells[c]]); return vol * CELL_AREA_M2 / M3_PER_AF; }
    var cap0 = capacityOf(resCells, SPILL), scale = cap0 > 0 ? C.HYDRO.RESERVOIR_CAPACITY_AF / cap0 : 1;
    for (var c = 0; c < resCells.length; c++) { i = resCells[c]; elev[i] = SPILL - (SPILL - elev[i]) * scale; }
    for (k = entryIndex; k < damIndex; k++) { if (isRes[pathIdx[k]]) rElev[k] = elev[pathIdx[k]]; if (!(rElev[k] < rElev[k - 1] - 0.05)) rElev[k] = rElev[k - 1] - 0.05; elev[pathIdx[k]] = rElev[k]; }
    rElev[damIndex] = Math.min(rElev[damIndex], rElev[damIndex - 1] - 0.5);
    for (k = damIndex + 1; k < K; k++) if (!(rElev[k] < rElev[k - 1])) rElev[k] = rElev[k - 1] - 0.05;
    for (k = damIndex; k < K; k++) elev[pathIdx[k]] = rElev[k];
    var resDepth = new Float32Array(resCells.length), bedElev = SPILL;
    for (c = 0; c < resCells.length; c++) { resDepth[c] = SPILL - elev[resCells[c]]; if (elev[resCells[c]] < bedElev) bedElev = elev[resCells[c]]; }
    var capacityAF = C.HYDRO.RESERVOIR_CAPACITY_AF; // computed volume matches to <0.1% after scaling

    /* ---------- 9. stage-storage table ---------- */
    var STEPS = 64, stLevel = new Float64Array(STEPS + 1), stAF = new Float64Array(STEPS + 1), stArea = new Float64Array(STEPS + 1);
    for (var t = 0; t <= STEPS; t++) {
      var lv = bedElev + (SPILL - bedElev) * t / STEPS, vol = 0, area = 0;
      for (c = 0; c < resCells.length; c++) { var dd = lv - elev[resCells[c]]; if (dd > 0) { vol += dd; area++; } }
      stLevel[t] = lv; stAF[t] = vol * CELL_AREA_M2 / M3_PER_AF; stArea[t] = area;
    }
    if (stAF[STEPS] > 0) { var kk = capacityAF / stAF[STEPS]; for (t = 0; t <= STEPS; t++) stAF[t] *= kk; }
    for (t = 1; t <= STEPS; t++) { if (stAF[t] <= stAF[t - 1]) stAF[t] = stAF[t - 1] + 1e-6; if (stArea[t] < stArea[t - 1]) stArea[t] = stArea[t - 1]; }
    function tableLookup(af, outArr) {
      af = clamp(fin(af, 0), 0, capacityAF);
      var lo = 0, hi = STEPS;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (stAF[mid] <= af) lo = mid; else hi = mid; }
      var span = stAF[hi] - stAF[lo], tt = span > 0 ? clamp((af - stAF[lo]) / span, 0, 1) : 0;
      return outArr[lo] + (outArr[hi] - outArr[lo]) * tt;
    }
    function levelForStorage(af) { return fin(tableLookup(af, stLevel), bedElev); }
    function areaForStorage(af) { return fin(tableLookup(af, stArea), 0); }

    /* ---------- 10. D8 flow network: fixed along river/reservoir, priority-flood elsewhere ---------- */
    flowDir.fill(-2);
    for (k = 0; k < K - 1; k++) flowDir[pathIdx[k]] = pathIdx[k + 1];
    flowDir[pathIdx[K - 1]] = -1;
    for (c = 0; c < resCells.length; c++) flowDir[resCells[c]] = damI;
    var filled = new Float32Array(NN); filled.set(elev);
    var done = new Uint8Array(NN), heap = new Heap(NN * 2);
    for (k = 0; k < K; k++) { done[pathIdx[k]] = 1; heap.push(elev[pathIdx[k]], pathIdx[k]); }
    for (c = 0; c < resCells.length; c++) { i = resCells[c]; if (!done[i]) { done[i] = 1; heap.push(elev[i], i); } }
    while (heap.n > 0) {
      i = heap.pop(); x = i % N; y = (i / N) | 0;
      for (n8 = 0; n8 < 8; n8++) {
        nx = x + DX8[n8]; ny = y + DY8[n8]; if (!inB(nx, ny)) continue; j = idx(nx, ny);
        if (done[j]) continue;
        done[j] = 1;
        if (filled[j] < filled[i]) filled[j] = filled[i] + 0.001;
        flowDir[j] = i;
        heap.push(filled[j], j);
      }
    }
    // steepest-descent refinement on the filled surface where a strictly lower neighbour exists
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = idx(x, y); if (onPath[i] >= 0 || isRes[i]) continue;
      var bestDrop = 0, bj = -1;
      for (n8 = 0; n8 < 8; n8++) {
        nx = x + DX8[n8]; ny = y + DY8[n8]; if (!inB(nx, ny)) continue; j = idx(nx, ny);
        var drop = (filled[i] - filled[j]) / ((n8 & 1) ? 1.41421356 : 1);
        if (drop > bestDrop) { bestDrop = drop; bj = j; }
      }
      if (bj >= 0) flowDir[i] = bj;
      if (flowDir[i] === -2) flowDir[i] = -1;
    }
    // topological order (Kahn) + accumulation
    var indeg = new Int32Array(NN);
    for (i = 0; i < NN; i++) if (flowDir[i] >= 0) indeg[flowDir[i]]++;
    var order = new Int32Array(NN), qh = 0, qt = 0;
    for (i = 0; i < NN; i++) if (indeg[i] === 0) order[qt++] = i;
    while (qh < qt) { i = order[qh++]; j = flowDir[i]; if (j >= 0 && --indeg[j] === 0) order[qt++] = j; }
    var flowOrder = order.subarray(0, qt);
    for (i = 0; i < NN; i++) flowAcc[i] = 1;
    for (var o = 0; o < qt; o++) { i = order[o]; j = flowDir[i]; if (j >= 0) flowAcc[j] += flowAcc[i]; }
    // upstream-of-reservoir mask: 1 = drains into the reservoir (reservoir cells included)
    var upMask = new Uint8Array(NN);           // 0 unknown, 1 upstream, 2 not
    for (c = 0; c < resCells.length; c++) upMask[resCells[c]] = 1;
    upMask[damI] = 2;
    var chain = new Int32Array(NN);
    for (i = 0; i < NN; i++) {
      if (upMask[i]) continue;
      var cn = 0, cur = i, res = 2;
      while (cur >= 0 && cn < NN) { if (upMask[cur]) { res = upMask[cur]; break; } chain[cn++] = cur; cur = flowDir[cur]; }
      for (var cc = 0; cc < cn; cc++) upMask[chain[cc]] = res;
    }

    /* ---------- 11. slope / aspect ---------- */
    (function computeSlopeAspect() { var x, y, i, k, d, j, nx, ny, n8;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = idx(x, y);
      var ex0 = elev[idx(Math.max(0, x - 1), y)], ex1 = elev[idx(Math.min(N - 1, x + 1), y)];
      var ey0 = elev[idx(x, Math.max(0, y - 1))], ey1 = elev[idx(x, Math.min(N - 1, y + 1))];
      var dzdx = (ex1 - ex0) / (2 * C.CELL_M), dzdy = (ey1 - ey0) / (2 * C.CELL_M);
      slope[i] = clamp(Math.sqrt(dzdx * dzdx + dzdy * dzdy), 0, 1.5);
      // downslope direction = (-dzdx, -dzdy) in (east, south); aspect 0 = north-facing, clockwise (east = pi/2)
      var asp = Math.atan2(-dzdx, dzdy);
      if (asp < 0) asp += 2 * Math.PI;
      aspect[i] = (slope[i] < 0.005) ? 0 : asp;
    }
    })();

    /* ---------- 12. land cover ---------- */
    var TREELINE = 3450, FOREST_LO = 2200;
    var riverK = new Int32Array(NN); riverK.fill(-1);   // path node index for river cells (incl. widened channel)
    (function classifyLand() { var x, y, i, k, d, j, nx, ny, n8;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = idx(x, y); k = nearK[i];
      if (isRes[i]) { land[i] = L.RESERVOIR; continue; }
      var isChan = onPath[i] >= 0 || (nearD[i] <= Math.round((widths[k] - 1) / 2) + 0.01 && !(k >= entryIndex && k < damIndex));
      if (isChan) { land[i] = L.RIVER; riverK[i] = onPath[i] >= 0 ? onPath[i] : k; continue; }
      if (elev[i] > TREELINE) { land[i] = L.ALPINE; continue; }
      var fn = 0.75 * nRoll[i] + 0.35 * nFine[i];
      var northness = Math.cos(aspect[i]) * sstep(0.04, 0.3, slope[i]);
      var hiMtn = sstep(2700, 3100, elev[i]);
      var forestness = 0.6 * fn + 0.3 * northness * (1 - hiMtn) + 0.55 * sstep(2200, 2650, elev[i]) + 0.4 * hiMtn - 0.75 * sstep(3300, TREELINE, elev[i]);
      if (elev[i] >= FOREST_LO && forestness > 0.18) land[i] = L.FOREST;
      else land[i] = L.SHRUB;
    }
    })();

    /* ---------- 13. town: neighborhoods, civic core, streets ---------- */
    var hoods = [
      { name: 'Sagebrush Estates', x0: 68, y0: 58, x1: 80, y1: 68, wui: false },
      { name: 'Marshall Heights', x0: 86, y0: 60, x1: 98, y1: 70, wui: true },
      { name: 'Old Mill', x0: 68, y0: 79, x1: 80, y1: 89, wui: false },
      { name: 'Riverbend', x0: 84, y0: 82, x1: 96, y1: 92, wui: false }
    ];
    var civic = { x0: 74, y0: 70, x1: 82, y1: 77 };
    var hoodOf = new Int16Array(NN); hoodOf.fill(-1);
    function placeable(i) { return land[i] !== L.RIVER && land[i] !== L.RESERVOIR && !protectedC[i]; }
    for (var h = 0; h < hoods.length; h++) {
      var hd = hoods[h];
      for (y = hd.y0; y <= hd.y1; y++) for (x = hd.x0; x <= hd.x1; x++) { i = idx(x, y); if (placeable(i) && nearD[i] > 2.5) { land[i] = L.RESIDENTIAL; hoodOf[i] = h; } }
    }
    for (y = civic.y0; y <= civic.y1; y++) for (x = civic.x0; x <= civic.x1; x++) { i = idx(x, y); if (placeable(i)) { land[i] = L.CIVIC; hoodOf[i] = -1; } }
    // roads: polylines (cells flagged ROAD; river cells left as bridges)
    var roads = [];
    function road(pts) { roads.push(pts); for (var r = 0; r < pts.length - 1; r++) bresenham(pts[r].x, pts[r].y, pts[r + 1].x, pts[r + 1].y, function (rx, ry) { if (!inB(rx, ry)) return; var ri = idx(rx, ry); if (land[ri] === L.RIVER || land[ri] === L.RESERVOIR) return; land[ri] = L.ROAD; }); }
    function P(x, y) { return { x: x, y: y }; }
    var damRoadEnd = P(dam.x + 2, dam.y - 1);
    road([damRoadEnd, P(68, 71), P(74, 74), P(82, 74)]);                                                   // main street: dam -> downtown
    road([P(82, 74), P(84, 80), P(90, 96), P(97, 102), P(106, 109), P(115, 116), P(125, 121)]);            // valley road along the river (NE side)
    road([P(90, 96), P(79, 99), P(72, 104), P(62, 112)]);                                                  // bridge road to the SW farms
    road([P(74, 74), P(74, 68)]); road([P(82, 74), P(88, 72), P(92, 70)]); road([P(76, 77), P(76, 82)]);   // connectors
    for (h = 0; h < hoods.length; h++) {
      hd = hoods[h];
      for (y = hd.y0 + 1; y <= hd.y1; y += 3) road([P(hd.x0, y), P(hd.x1, y)]);
      road([P(hd.x0 + 6, hd.y0), P(hd.x0 + 6, hd.y1)]);
    }
    for (i = 0; i < NN; i++) if (land[i] === L.ROAD) hoodOf[i] = -1;

    /* ---------- 14. farms: strips along the lower river (both banks) ---------- */
    var farmDefs = [
      { name: 'Two Rivers Farm', side: 1, f0: 0.30, f1: 0.58 },
      { name: 'Lazy J Ranch', side: -1, f0: 0.42, f1: 0.68 },
      { name: 'Hay Meadows Co-op', side: 1, f0: 0.60, f1: 0.86 },
      { name: 'Orchard Bench', side: -1, f0: 0.70, f1: 0.97 }
    ];
    var farmOf = new Int16Array(NN); farmOf.fill(-1);
    for (var fz = 0; fz < farmDefs.length; fz++) {
      var fd = farmDefs[fz], k0 = damIndex + Math.round(fd.f0 * tail), k1 = damIndex + Math.round(fd.f1 * tail);
      for (i = 0; i < NN; i++) {
        if (land[i] !== L.SHRUB) continue;
        k = nearK[i]; if (k < k0 || k > k1) continue;
        if (sideOf[i] !== fd.side) continue;
        d = nearD[i]; if (d < 2.5 || d > 20.5) continue;
        if (slope[i] > 0.2 || elev[i] > rElev[k] + 60) continue;
        land[i] = L.FARM; farmOf[i] = fz;
      }
    }
    // calibrate total farm area (~1,250 cells): trim the cells farthest from the river
    var farmList = []; for (i = 0; i < NN; i++) if (land[i] === L.FARM) farmList.push(i);
    if (farmList.length > 1300) {
      farmList.sort(function (a, b) { return (nearD[b] - nearD[a]) || (a - b); });
      for (c = 0; c < farmList.length - 1300; c++) { land[farmList[c]] = L.SHRUB; farmOf[farmList[c]] = -1; }
    }
    // wetland flat
    for (i = 0; i < NN; i++) if (isWet[i] && (land[i] === L.SHRUB || land[i] === L.FARM)) { land[i] = L.WETLAND; farmOf[i] = -1; }
    // riparian: 1 cell each side of the river below the dam; reservoir shore
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = idx(x, y); var lt = land[i];
      if (!(lt === L.SHRUB || lt === L.FARM || lt === L.FOREST)) continue;
      var rip = false;
      for (n8 = 0; n8 < 8 && !rip; n8++) {
        nx = x + DX8[n8]; ny = y + DY8[n8]; if (!inB(nx, ny)) continue; j = idx(nx, ny);
        if (land[j] === L.RESERVOIR) rip = true;
        else if (land[j] === L.RIVER && riverK[j] >= damIndex) rip = true;
      }
      if (rip) { land[i] = L.RIPARIAN; farmOf[i] = -1; }
    }
    // ensure the WUI neighborhood adjoins forest: a collar of forest above Marshall Heights
    var mh = hoods[1], collar = [];
    for (y = mh.y0 - 3; y <= mh.y1 + 1; y++) for (x = mh.x0 - 1; x <= mh.x1 + 3; x++) {
      if (!inB(x, y)) continue; i = idx(x, y);
      var outside = (x < mh.x0 || x > mh.x1 || y < mh.y0 || y > mh.y1);
      if (outside && (y < mh.y0 || x > mh.x1) && land[i] === L.SHRUB && elev[i] >= FOREST_LO) { land[i] = L.FOREST; collar.push(i); }
    }
    // treatment plant + WUI fire station footprints
    var intakeK = Math.max(entryIndex, damIndex - 2), intake = { x: path[intakeK].x, y: path[intakeK].y };
    var tp = { x: dam.x + 3, y: dam.y - 3 };
    for (var tries = 0; tries < 12 && !placeable(idx(tp.x, tp.y)); tries++) tp.x++;
    land[idx(tp.x, tp.y)] = L.CIVIC; hoodOf[idx(tp.x, tp.y)] = -1;
    var wuiFS = { x: mh.x0 + 1, y: mh.y1 - 1 };
    if (land[idx(wuiFS.x, wuiFS.y)] === L.ROAD) wuiFS.y--;
    land[idx(wuiFS.x, wuiFS.y)] = L.CIVIC; hoodOf[idx(wuiFS.x, wuiFS.y)] = -1;

    /* ---------- 15. zones ---------- */
    var zones = [];
    function makeZone(type, name, cellList, extra) {
      var z = { id: zones.length, type: type, name: name, cells: Int32Array.from(cellList), center: { x: 0, y: 0 }, upstreamOfReservoir: false, bbox: { x0: N, y0: N, x1: -1, y1: -1 } };
      var sx = 0, sy = 0, up = 0;
      for (var q = 0; q < z.cells.length; q++) {
        var ci = z.cells[q], cx = ci % N, cy = (ci / N) | 0;
        sx += cx; sy += cy; if (upMask[ci] === 1) up++;
        if (cx < z.bbox.x0) z.bbox.x0 = cx; if (cx > z.bbox.x1) z.bbox.x1 = cx; if (cy < z.bbox.y0) z.bbox.y0 = cy; if (cy > z.bbox.y1) z.bbox.y1 = cy;
        zone[ci] = z.id;
      }
      if (z.cells.length) { z.center.x = Math.round(sx / z.cells.length); z.center.y = Math.round(sy / z.cells.length); }
      else { z.bbox = { x0: 0, y0: 0, x1: 0, y1: 0 }; }
      z.upstreamOfReservoir = z.cells.length > 0 && up * 2 > z.cells.length;
      if (extra) for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) z[key] = extra[key];
      zones.push(z);
      return z;
    }
    // forest sectors: 1-4 upstream of the reservoir (Voronoi on 4 seeds), 5-6 above town (2 seeds)
    var upSeeds = [{ x: 50, y: 8, n: 'Cameron Ridge' }, { x: 8, y: 30, n: 'Kestrel Divide' }, { x: 74, y: 40, n: 'North Fork Slopes' }, { x: 26, y: 58, n: 'Troublesome Bench' }];
    var dnSeeds = [{ x: 100, y: 80, n: 'Ponderosa Flats' }, { x: 30, y: 110, n: 'Roaring Gulch' }];
    var sectorCells = [[], [], [], [], [], []];
    var collarSet = new Uint8Array(NN); for (c = 0; c < collar.length; c++) collarSet[collar[c]] = 1;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = idx(x, y); if (land[i] !== L.FOREST) continue;
      var upGeo = catchmentSide(x, y), seeds = upGeo ? upSeeds : dnSeeds, off = upGeo ? 0 : 4, bs = 0, bd = 1e9;
      if (collarSet[i]) { sectorCells[4].push(i); continue; }
      for (var sIx = 0; sIx < seeds.length; sIx++) { var sd2 = (seeds[sIx].x - x) * (seeds[sIx].x - x) + (seeds[sIx].y - y) * (seeds[sIx].y - y); if (sd2 < bd) { bd = sd2; bs = sIx; } }
      sectorCells[off + bs].push(i);
    }
    var sectorNames = ['Cameron Ridge', 'Kestrel Divide', 'North Fork Slopes', 'Troublesome Bench', 'Ponderosa Flats', 'Roaring Gulch'];
    for (var sz = 0; sz < 6; sz++) { var fzn = makeZone('forest', sectorNames[sz], sectorCells[sz], { sector: sz + 1 }); fzn.upstreamOfReservoir = sz < 4; }
    // neighborhoods
    var hoodZone = [];
    for (h = 0; h < hoods.length; h++) {
      var hc = []; for (i = 0; i < NN; i++) if (hoodOf[i] === h && land[i] === L.RESIDENTIAL) hc.push(i);
      hoodZone.push(makeZone('neighborhood', hoods[h].name, hc, { wui: hoods[h].wui, adjoinsForestZoneId: hoods[h].wui ? 4 : -1 }));
    }
    var civicCells = []; for (i = 0; i < NN; i++) if (land[i] === L.CIVIC) civicCells.push(i);
    var civicZone = makeZone('civic', 'Bitterbrush Civic Core', civicCells);
    var farmZone = [];
    for (fz = 0; fz < farmDefs.length; fz++) { var fc = []; for (i = 0; i < NN; i++) if (farmOf[i] === fz && land[i] === L.FARM) fc.push(i); farmZone.push(makeZone('farm', farmDefs[fz].name, fc)); }
    var resZone = makeZone('reservoir', 'Bitterbrush Reservoir', resCells);
    var wetCells = []; for (i = 0; i < NN; i++) if (land[i] === L.WETLAND) wetCells.push(i);
    var wetZone = makeZone('wetland', 'Heron Flats Wetland', wetCells);
    var ripCells = []; for (i = 0; i < NN; i++) if (land[i] === L.RIPARIAN) ripCells.push(i);
    makeZone('riparian', 'Bitterbrush Creek Riparian Corridor', ripCells);

    /* ---------- 16. buildings ---------- */
    var buildings = [];
    var roadCells = []; for (i = 0; i < NN; i++) if (land[i] === L.ROAD) roadCells.push(i);
    function rotToNearestRoad(x, y) {
      var bd2 = 1e9, bx = x, by = y + 1;
      for (var r = 0; r < roadCells.length; r++) { var rx = roadCells[r] % N, ry = (roadCells[r] / N) | 0, dd2 = (rx - x) * (rx - x) + (ry - y) * (ry - y); if (dd2 < bd2 && dd2 > 0) { bd2 = dd2; bx = rx; by = ry; } }
      return Math.atan2(bx - x, by - y);   // yaw: 0 faces south (+y), pi/2 faces east
    }
    function addB(type, x, y, rot, zoneId, scale) { buildings.push({ type: type, x: x, y: y, rot: fin(rot, 0), zoneId: zoneId, scale: fin(scale, 1) }); }
    for (h = 0; h < hoods.length; h++) {
      var zc = hoodZone[h].cells;
      for (c = 0; c < zc.length; c++) {
        if (rHouse.chance(0.1)) continue;
        x = zc[c] % N; y = (zc[c] / N) | 0;
        addB('house', x, y, rotToNearestRoad(x, y) + rHouse.range(-0.12, 0.12), hoodZone[h].id, rHouse.range(0.85, 1.15));
      }
    }
    function civicSpot(x, y) {  // nearest civic cell to (x,y) inside the core
      var best = null, bd = 1e9;
      for (c = 0; c < civicCells.length; c++) { var cx = civicCells[c] % N, cy = (civicCells[c] / N) | 0; if (cx < civic.x0 || cx > civic.x1 || cy < civic.y0 || cy > civic.y1) continue; var dd2 = (cx - x) * (cx - x) + (cy - y) * (cy - y); if (dd2 < bd) { bd = dd2; best = { x: cx, y: cy }; } }
      return best || { x: x, y: y };
    }
    var used = new Uint8Array(NN);
    function civicB(type, x, y, scale) {
      var sp = civicSpot(x, y), guard = 0;
      while (used[idx(sp.x, sp.y)] && guard++ < 6) { sp = civicSpot(sp.x + 1, sp.y + (guard & 1)); }
      used[idx(sp.x, sp.y)] = 1; addB(type, sp.x, sp.y, rotToNearestRoad(sp.x, sp.y), civicZone.id, scale || 1);
    }
    civicB('town_hall', 78, 73, 1.2); civicB('school', 75, 71, 1.1); civicB('hospital', 81, 71, 1.1); civicB('church', 75, 76, 1);
    civicB('shelter', 81, 76, 1); civicB('fire_station', 79, 76, 1); civicB('shop', 76, 73, 0.9); civicB('shop', 80, 73, 0.9); civicB('shop', 78, 75, 0.9);
    addB('fire_station', wuiFS.x, wuiFS.y, rotToNearestRoad(wuiFS.x, wuiFS.y), civicZone.id, 1);
    addB('treatment_plant', tp.x, tp.y, Math.atan2(intake.x - tp.x, intake.y - tp.y), civicZone.id, 1.1);
    addB('dam', dam.x, dam.y, Math.atan2(tdx, tdy), resZone.id, 1);
    for (fz = 0; fz < farmZone.length; fz++) {
      var fzz = farmZone[fz]; if (!fzz.cells.length) continue;
      var bc = fzz.cells[0], bd0 = 1e9;
      for (c = 0; c < fzz.cells.length; c++) { var cx2 = fzz.cells[c] % N, cy2 = (fzz.cells[c] / N) | 0, dd3 = (cx2 - fzz.center.x) * (cx2 - fzz.center.x) + (cy2 - fzz.center.y) * (cy2 - fzz.center.y); if (dd3 < bd0) { bd0 = dd3; bc = fzz.cells[c]; } }
      addB('barn', bc % N, (bc / N) | 0, rotToNearestRoad(bc % N, (bc / N) | 0), fzz.id, 1.2);
    }

    /* ---------- 17. per-cell fields ---------- */
    var riverDist = new Float32Array(NN); // distance to the river below the dam / reservoir (for habitat)
    (function computeFields() { var x, y, i, k, d, j, nx, ny, n8;
    for (i = 0; i < NN; i++) {
      x = i % N; y = (i / N) | 0; k = nearK[i]; d = nearD[i];
      riverDist[i] = (k >= entryIndex) ? d : 99;
      var nz = clamp(0.7 * nRoll[i] - 0.5 * nFine[i], -1, 1), nz2 = clamp(nFine[i] * 1.6, -1, 1);
      var lt = land[i], td = 0, fu = 0, mo = 0.45, hb = 0.05;
      var northness = Math.cos(aspect[i]) * sstep(0.04, 0.25, slope[i]);
      switch (lt) {
        case L.FOREST:
          td = 0.35 + 0.65 * clamp((nz + 0.55) / 1.1, 0, 1) * (1 - 0.45 * sstep(3250, 3450, elev[i]));
          fu = 0.47 + 0.2 * (td - 0.35) / 0.65 + 0.08 * Math.max(0, northness) + 0.05 * (nz2 + 1) / 2;
          mo = 0.6 + 0.05 * nz2 + 0.03 * northness; hb = 0.35 + 0.25 * (1 - td) + 0.05 * nz2; break;
        case L.SHRUB:
          td = 0.03 + 0.09 * clamp((nz2 + 1) / 2, 0, 1); fu = 0.32 + 0.2 * clamp((nz + 1) / 2, 0, 1) + 0.03 * Math.max(0, northness);
          mo = 0.45 + 0.04 * nz2; hb = 0.55 + 0.25 * (1 - sstep(3, 12, riverDist[i])) + 0.1 * clamp((nz + 1) / 2, 0, 1); break;
        case L.RIPARIAN: td = 0.4 + 0.2 * clamp((nz + 1) / 2, 0, 1); fu = 0.25 + 0.12 * clamp((nz + 1) / 2, 0, 1); mo = 0.7; hb = 0.85 + 0.05 * nz2; break;
        case L.WETLAND: td = 0.1; fu = 0.1; mo = 0.9; hb = 0.95; break;
        case L.FARM: td = 0.02; fu = 0.15 + 0.08 * clamp((nz + 1) / 2, 0, 1); mo = 0.45 + 0.03 * nz2; hb = 0.25; cropHealth[i] = 0.85; break;
        case L.RESIDENTIAL: td = 0.08; fu = 0.2 + 0.1 * clamp((nz + 1) / 2, 0, 1); mo = 0.45; hb = 0.05; break;
        case L.CIVIC: td = 0.04; fu = 0.1; mo = 0.45; hb = 0.03; break;
        case L.ROAD: td = 0; fu = 0; mo = 0.4; hb = 0.02; break;
        case L.ALPINE: td = 0; fu = 0.04; mo = 0.5; hb = 0.3; break;
        case L.RIVER: td = 0; fu = 0; mo = 1; hb = 0.6; break;
        case L.RESERVOIR: td = 0; fu = 0; mo = 1; hb = 0.5; break;
        default: td = 0; fu = 0; mo = 0.45; hb = 0.05;
      }
      treeDensity[i] = clamp(td === td ? td : 0, 0, 1); fuel[i] = clamp(fu === fu ? fu : 0, 0, 1); moisture[i] = clamp(mo === mo ? mo : 0.45, 0, 1); habitat[i] = clamp(hb === hb ? hb : 0, 0, 1);
      burn[i] = 0; if (lt !== L.FARM) cropHealth[i] = 0;
      if (!isFinite(elev[i])) elev[i] = 2000; if (!isFinite(slope[i])) slope[i] = 0; if (!isFinite(aspect[i])) aspect[i] = 0;
    }
    })();

    /* ---------- 18. world object ---------- */
    var cellsAbove = [], cellsBelow = [];
    for (k = 0; k < K; k++) { if (k < entryIndex) cellsAbove.push(pathIdx[k]); else if (k > damIndex) cellsBelow.push(pathIdx[k]); }
    var pathOut = path.map(function (p) { return { x: p.x, y: p.y }; });
    var world = {
      seed: seed, N: N, cellM: C.CELL_M,
      elev: elev, land: land, slope: slope, aspect: aspect, fuel: fuel, moisture: moisture, burn: burn, treeDensity: treeDensity,
      cropHealth: cropHealth, habitat: habitat, flowDir: flowDir, flowAcc: flowAcc, flowOrder: Int32Array.from(flowOrder), zone: zone, zones: zones,
      river: { path: pathOut, widths: widths, damIndex: damIndex, entryIndex: entryIndex, elev: Float32Array.from(rElev), cellsAbove: Int32Array.from(cellsAbove), cellsBelow: Int32Array.from(cellsBelow), outlet: { x: path[K - 1].x, y: path[K - 1].y }, source: { x: path[0].x, y: path[0].y } },
      reservoir: { cells: resCells, depth: resDepth, bedElev: bedElev, spillElev: SPILL, capacityAF: capacityAF, dam: dam, intake: intake, center: { x: resZone.center.x, y: resZone.center.y },
                   levelForStorage: levelForStorage, areaForStorage: areaForStorage, zoneId: resZone.id, bbox: resZone.bbox },
      wetland: { cells: wetZone.cells, zoneId: wetZone.id, center: wetZone.center },
      buildings: buildings, roads: roads, snowlineElev: 2600, treeline: TREELINE,
      townCenter: { x: civicZone.center.x, y: civicZone.center.y },
      upstreamMask: upMask
    };
    world.idx = function (x, y) { return idx(x | 0, y | 0); };
    world.xy = function (i) { i = i | 0; return { x: i % N, y: (i / N) | 0 }; };
    world.inBounds = function (x, y) { return inB(x, y); };
    world.neighbors8 = function (i) {
      i = i | 0; var out = [], x = i % N, y = (i / N) | 0;
      for (var n = 0; n < 8; n++) { var nx = x + DX8[n], ny = y + DY8[n]; if (inB(nx, ny)) out.push(ny * N + nx); }
      return out;
    };
    var cellsCache = {};
    world.cellsOf = function (landEnum) {
      if (cellsCache[landEnum]) return cellsCache[landEnum];
      var out = []; for (var q = 0; q < NN; q++) if (land[q] === landEnum) out.push(q);
      return (cellsCache[landEnum] = Int32Array.from(out));
    };
    world.zoneById = function (id) { return (id >= 0 && id < zones.length) ? zones[id] : null; };
    world.zonesOf = function (type) { return zones.filter(function (z) { return z.type === type; }); };
    world.isUpstreamOfReservoir = function (i) { return i >= 0 && i < NN && upMask[i] === 1; };
    world.summary = function () {
      var landCounts = {}, zoneCounts = {}, bCounts = {}, up = 0, mn = Infinity, mx = -Infinity;
      for (var q = 0; q < C.LAND_NAMES.length; q++) landCounts[C.LAND_NAMES[q]] = 0;
      for (q = 0; q < NN; q++) { landCounts[C.LAND_NAMES[land[q]]]++; if (upMask[q] === 1) up++; if (elev[q] < mn) mn = elev[q]; if (elev[q] > mx) mx = elev[q]; }
      zones.forEach(function (z) { zoneCounts[z.type] = (zoneCounts[z.type] || 0) + 1; });
      buildings.forEach(function (b) { bCounts[b.type] = (bCounts[b.type] || 0) + 1; });
      return {
        land: landCounts, zones: zoneCounts, buildings: bCounts, houses: bCounts.house || 0, elevMin: mn, elevMax: mx,
        forestCells: landCounts.Forest, farmCells: landCounts.Farm, residentialCells: landCounts.Residential, reservoirCells: resCells.length,
        capacityAF: capacityAF, riverNodes: K, roadCells: landCounts.Road, upstreamCells: up, zoneList: zones.map(function (z) { return { id: z.id, type: z.type, name: z.name, cells: z.cells.length, up: z.upstreamOfReservoir }; })
      };
    };
    return world;
  }

  WS.World = { generate: generate };
})();
