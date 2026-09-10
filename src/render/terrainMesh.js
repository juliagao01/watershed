/* Watershed — terrain mesh (render). Exports WS.TerrainMesh.
   build(world) -> { mesh, geometry, skirt, heightAt(sx,sz), recolor(world,state,seasonIdx,opts), colorForCell(i,world,state,seasonIdx,out), dispose() }
   Non-indexed BufferGeometry, 2 triangles per cell, flat shaded, per-face vertex colours. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C, R = C.RENDER, L = C.LAND, PAL = C.PALETTE;

  /* ---------- palette (sRGB hex -> linear float triplets, once) ---------- */
  function s2l(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function unpack(hex) {
    return new Float32Array([s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)]);
  }
  function mixed(a, b, t) {
    return new Float32Array([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  var P = {};
  Object.keys(PAL).forEach(function (k) { P[k] = unpack(PAL[k]); });
  P.riverBed = mixed(P.waterDeep, P.burnLight, 0.4);
  P.reservoirBed = mixed(P.waterDeep, P.burnLight, 0.6);
  P.earth = unpack(0x4a3b2e);
  P.earthDark = unpack(0x2b221b);
  P.table = unpack(0x3a322c);
  P.roadSnow = mixed(P.road, P.snow, 0.55);

  /* scratch colour registers (module-local; recolor is single-threaded) */
  var cr = 0, cg = 0, cb = 0;
  function setC(p) { cr = p[0]; cg = p[1]; cb = p[2]; }
  function toward(p, t) {
    if (!(t > 0)) return;
    if (t > 1) t = 1;
    cr += (p[0] - cr) * t; cg += (p[1] - cg) * t; cb += (p[2] - cb) * t;
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function snowlineFor(seasonIdx, world, opts) {
    var sl = opts && isFinite(opts.snowlineElev) ? +opts.snowlineElev : NaN;
    if (isFinite(sl)) return sl;
    var base = (world && isFinite(world.snowlineElev)) ? world.snowlineElev : 2600;
    switch (seasonIdx | 0) {
      case C.SEASON.WINTER: return base;
      case C.SEASON.SPRING: return base + 500;
      case C.SEASON.SUMMER: return 3600;
      case C.SEASON.FALL: return 3300;
      default: return base;
    }
  }

  function build(world) {
    if (typeof THREE === 'undefined' || !world || !world.elev) return null;
    var N = world.N || C.N, NN = N * N, CELL = R.CELL, half = N / 2;
    var elev = world.elev, land = world.land;
    var isWater = new Uint8Array(NN);
    for (var i = 0; i < NN; i++) isWater[i] = (land && (land[i] === L.RIVER || land[i] === L.RESERVOIR)) ? 1 : 0;

    /* ---------- corner grid (N+1)^2, scene Y ---------- */
    var NC = N + 1;
    var cornerY = new Float32Array(NC * NC);
    for (var cy = 0; cy <= N; cy++) {
      for (var cx = 0; cx <= N; cx++) {
        var sum = 0, cnt = 0, wsum = 0, wcnt = 0;
        for (var dy = -1; dy <= 0; dy++) {
          var yy = cy + dy; if (yy < 0 || yy >= N) continue;
          for (var dx = -1; dx <= 0; dx++) {
            var xx = cx + dx; if (xx < 0 || xx >= N) continue;
            var ci = yy * N + xx, e = elev[ci];
            if (!isFinite(e)) e = R.ELEV_BASE;
            sum += e; cnt++;
            if (isWater[ci]) { wsum += e; wcnt++; }
          }
        }
        // water-adjacent corners follow the water cells so channels/basins stay carved (crack-free shared grid)
        var m = wcnt > 0 ? wsum / wcnt : (cnt > 0 ? sum / cnt : R.ELEV_BASE);
        cornerY[cy * NC + cx] = C.elevToScene(m);
      }
    }

    /* ---------- geometry: 6 verts per cell ---------- */
    var VERTS = NN * 6;
    var positions = new Float32Array(VERTS * 3);
    var colors = new Float32Array(VERTS * 3);
    var p = 0;
    function v(x, y, z) { positions[p++] = x; positions[p++] = y; positions[p++] = z; }
    for (var y = 0; y < N; y++) {
      var z0 = (y - half) * CELL, z1 = z0 + CELL;
      for (var x = 0; x < N; x++) {
        var x0 = (x - half) * CELL, x1 = x0 + CELL;
        var h00 = cornerY[y * NC + x], h10 = cornerY[y * NC + x + 1];
        var h01 = cornerY[(y + 1) * NC + x], h11 = cornerY[(y + 1) * NC + x + 1];
        // choose the diagonal with the smaller height difference (avoids saddle spikes); CCW from above
        if (Math.abs(h00 - h11) <= Math.abs(h10 - h01)) {
          v(x0, h00, z0); v(x1, h11, z1); v(x1, h10, z0);
          v(x0, h00, z0); v(x0, h01, z1); v(x1, h11, z1);
        } else {
          v(x0, h00, z0); v(x0, h01, z1); v(x1, h10, z0);
          v(x1, h10, z0); v(x0, h01, z1); v(x1, h11, z1);
        }
      }
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var colorAttr = new THREE.BufferAttribute(colors, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', colorAttr);
    geometry.computeVertexNormals(); // per-face normals on non-indexed geometry
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    var material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
    var mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'terrain';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    /* ---------- static per-cell shading: elevation banding, aspect, jitter, snow-edge noise ---------- */
    var staticMul = new Float32Array(NN);
    var snowNoise = new Float32Array(NN);
    var jrng = WS.RNG.create(String(world.seed == null ? 0 : world.seed) + ':terrainJitter');
    var snoise = WS.Noise.create(String(world.seed == null ? 0 : world.seed) + ':snowEdge');
    for (i = 0; i < NN; i++) {
      var e2 = isFinite(elev[i]) ? elev[i] : R.ELEV_BASE;
      var t = clamp01((e2 - 1800) / 2000);
      var light = 0.93 + 0.13 * t;                                   // gentle lift with altitude
      var band = 1 + ((((e2 / 120) | 0) & 1) ? 0.022 : -0.022);      // subtle contour banding
      var sl = world.slope ? world.slope[i] : 0, asp = world.aspect ? world.aspect[i] : 0;
      if (!isFinite(sl)) sl = 0; if (!isFinite(asp)) asp = 0;
      var shade = 1 + 0.09 * Math.min(1, sl * 1.6) * (-Math.cos(asp)); // north-facing (aspect 0) darker
      var jit = 1 + (jrng.next() * 2 - 1) * 0.04;
      staticMul[i] = light * band * shade * jit;
      var xx2 = i % N, yy2 = (i / N) | 0;
      snowNoise[i] = snoise.fbm(xx2 * 0.07, yy2 * 0.07, 3) * 90;   // metres of snowline wobble
    }

    /* ---------- colour for one cell ---------- */
    var cachedSeason = -1, cachedSnowline = 2600, activeOpts = null;
    function colorForCell(i, w, state, seasonIdx, out) {
      w = w || world;
      i = i | 0; if (i < 0 || i >= NN) { out[0] = out[1] = out[2] = 0; return out; }
      seasonIdx = seasonIdx | 0;
      if (seasonIdx !== cachedSeason) { cachedSeason = seasonIdx; cachedSnowline = snowlineFor(seasonIdx, w, activeOpts); }
      var ld = w.land ? w.land[i] : L.SHRUB;
      var e = w.elev[i]; if (!isFinite(e)) e = R.ELEV_BASE;
      var moist = w.moisture ? w.moisture[i] : 0.45; if (!isFinite(moist)) moist = 0.45;
      var dry = clamp01(1 - (moist - 0.15) / 0.45);
      var td = w.treeDensity ? w.treeDensity[i] : 0.6; if (!isFinite(td)) td = 0.6;
      var isFall = seasonIdx === C.SEASON.FALL;
      var water = false;

      switch (ld) {
        case L.RIVER: setC(P.riverBed); water = true; break;
        case L.RESERVOIR: setC(P.reservoirBed); water = true; break;
        case L.ALPINE:
          setC(P.alpine);
          toward(P.rock, clamp01((e - ((w.treeline || 3450) + 120)) / 250) * 0.7);
          break;
        case L.FOREST:
          setC(P.forest);
          toward(P.forestDark, td * 0.5);
          toward(P.shrubGreen, (1 - td) * 0.35);
          toward(P.forestDry, 0.35 * dry);
          break;
        case L.SHRUB:
          setC(P.shrubGreen);
          toward(P.shrub, Math.min(1, dry * 2));
          toward(P.shrubDry, Math.max(0, dry * 2 - 1));
          if (isFall) toward(P.shrubDry, 0.25);
          break;
        case L.FARM: {
          var h = w.cropHealth ? w.cropHealth[i] : 0.85; if (!isFinite(h)) h = 0.85;
          setC(P.farm);
          toward(P.farmDry, 1 - h);
          toward(P.farmFallow, dry * 0.35);
          if (isFall) toward(P.farmDry, 0.3);
          break;
        }
        case L.RESIDENTIAL: setC(P.residential); break;
        case L.CIVIC: setC(P.civic); break;
        case L.WETLAND: setC(P.wetland); toward(P.shrub, dry * 0.3); break;
        case L.ROAD: setC(P.roadShoulder || P.road); break; // the props road ribbon draws the asphalt; the cell reads as gravel shoulder/yard
        case L.RIPARIAN:
          setC(P.riparian);
          toward(P.shrubDry, dry * 0.4);
          if (isFall) toward(P.aspenFall, 0.55);
          break;
        default: setC(P.shrub); break;
      }

      // burn: blend to burnLight->burnSevere with an ash tint
      var b = w.burn ? w.burn[i] : 0;
      if (b > 0 && !water) {
        if (b > 1) b = 1;
        var wb = Math.min(1, b * 1.4);
        var bl = P.burnLight, bs = P.burnSevere, ash = P.ash;
        var br = bl[0] + (bs[0] - bl[0]) * b, bg = bl[1] + (bs[1] - bl[1]) * b, bb = bl[2] + (bs[2] - bl[2]) * b;
        var at = 0.25 * b;
        br += (ash[0] - br) * at; bg += (ash[1] - bg) * at; bb += (ash[2] - bb) * at;
        cr += (br - cr) * wb; cg += (bg - cg) * wb; cb += (bb - cb) * wb;
      }

      // snow above the seasonal snowline with a soft noisy edge (not on water; partial on roads)
      if (!water) {
        var sl2 = cachedSnowline;
        var s = C.smoothstep(sl2 - 70, sl2 + 70, e + snowNoise[i]);
        if (s > 0) {
          var slope = w.slope ? w.slope[i] : 0; if (!isFinite(slope)) slope = 0;
          s *= 1 - 0.45 * Math.min(1, slope);
          if (ld === L.ROAD) toward(P.roadSnow, s); else toward(P.snow, s);
        }
      }

      var m = staticMul[i];
      out[0] = clamp01(cr * m); out[1] = clamp01(cg * m); out[2] = clamp01(cb * m);
      return out;
    }

    var scratch = new Float32Array(3);
    function recolor(w, state, seasonIdx, opts) {
      w = w || world;
      activeOpts = opts || null;
      cachedSeason = -1; // force snowline recompute with new opts
      var col = colors;
      for (var ci = 0, j = 0; ci < NN; ci++, j += 18) {
        colorForCell(ci, w, state, seasonIdx, scratch);
        var r0 = scratch[0], g0 = scratch[1], b0 = scratch[2];
        col[j] = r0; col[j + 1] = g0; col[j + 2] = b0;
        col[j + 3] = r0; col[j + 4] = g0; col[j + 5] = b0;
        col[j + 6] = r0; col[j + 7] = g0; col[j + 8] = b0;
        col[j + 9] = r0; col[j + 10] = g0; col[j + 11] = b0;
        col[j + 12] = r0; col[j + 13] = g0; col[j + 14] = b0;
        col[j + 15] = r0; col[j + 16] = g0; col[j + 17] = b0;
      }
      colorAttr.needsUpdate = true;
    }

    /* ---------- bilinear height lookup on the corner grid ---------- */
    function heightAt(sx, sz) {
      var fx = sx / CELL + half, fz = sz / CELL + half;
      if (!isFinite(fx)) fx = half; if (!isFinite(fz)) fz = half;
      if (fx < 0) fx = 0; else if (fx > N) fx = N;
      if (fz < 0) fz = 0; else if (fz > N) fz = N;
      var ix = fx | 0, iz = fz | 0;
      if (ix >= N) ix = N - 1; if (iz >= N) iz = N - 1;
      var tx = fx - ix, tz = fz - iz;
      var a = cornerY[iz * NC + ix], b2 = cornerY[iz * NC + ix + 1];
      var c2 = cornerY[(iz + 1) * NC + ix], d = cornerY[(iz + 1) * NC + ix + 1];
      var top = a + (b2 - a) * tx, bot = c2 + (d - c2) * tx;
      return top + (bot - top) * tz;
    }

    /* ---------- skirt: walls down to SEA + table top ---------- */
    var SEA = R.SEA;
    var wallVerts = N * 4 * 6;
    var wpos = new Float32Array(wallVerts * 3), wcol = new Float32Array(wallVerts * 3);
    var wp = 0;
    function wallV(x, yv, z) {
      wpos[wp * 3] = x; wpos[wp * 3 + 1] = yv; wpos[wp * 3 + 2] = z;
      var t = clamp01((yv - SEA) / 4);
      var strata = ((((yv * 3) | 0) & 1) ? 0.06 : -0.06);
      var k = 0.55 + 0.45 * t + strata;
      wcol[wp * 3] = P.earthDark[0] + (P.earth[0] - P.earthDark[0]) * k;
      wcol[wp * 3 + 1] = P.earthDark[1] + (P.earth[1] - P.earthDark[1]) * k;
      wcol[wp * 3 + 2] = P.earthDark[2] + (P.earth[2] - P.earthDark[2]) * k;
      wp++;
    }
    // quad from corner a to corner b along an edge (dir chosen so cross(dir, up) faces outward)
    function wallQuad(ax, az, ah, bx, bz, bh) {
      wallV(ax, SEA, az); wallV(bx, SEA, bz); wallV(bx, bh, bz);
      wallV(ax, SEA, az); wallV(bx, bh, bz); wallV(ax, ah, az);
    }
    var xs, zs;
    for (i = 0; i < N; i++) {
      // north edge (z = -half): traverse -x so the normal points -z
      xs = (N - i - half) * CELL; zs = -half * CELL;
      wallQuad(xs, zs, cornerY[N - i], xs - CELL, zs, cornerY[N - i - 1]);
      // south edge (z = +half): traverse +x
      xs = (i - half) * CELL; zs = half * CELL;
      wallQuad(xs, zs, cornerY[N * NC + i], xs + CELL, zs, cornerY[N * NC + i + 1]);
      // east edge (x = +half): traverse -z
      xs = half * CELL; zs = (N - i - half) * CELL;
      wallQuad(xs, zs, cornerY[(N - i) * NC + N], xs, zs - CELL, cornerY[(N - i - 1) * NC + N]);
      // west edge (x = -half): traverse +z
      xs = -half * CELL; zs = (i - half) * CELL;
      wallQuad(xs, zs, cornerY[i * NC], xs, zs + CELL, cornerY[(i + 1) * NC]);
    }
    var wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
    wallGeo.setAttribute('color', new THREE.BufferAttribute(wcol, 3));
    wallGeo.computeVertexNormals();
    var wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 });
    var walls = new THREE.Mesh(wallGeo, wallMat);
    walls.name = 'terrainSkirtWalls';
    walls.receiveShadow = true; walls.castShadow = false;

    var tableGeo = new THREE.PlaneGeometry(N * CELL * 6, N * CELL * 6);
    var tableMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(P.table[0], P.table[1], P.table[2]), roughness: 1, metalness: 0 });
    var table = new THREE.Mesh(tableGeo, tableMat);
    table.rotation.x = -Math.PI / 2;
    table.position.y = SEA - 0.02;
    table.name = 'dioramaTable';
    table.receiveShadow = true; table.castShadow = false;

    var skirt = new THREE.Group();
    skirt.name = 'terrainSkirt';
    skirt.add(walls); skirt.add(table);

    recolor(world, null, C.SEASON.SPRING, null);

    function dispose() {
      geometry.dispose(); material.dispose(); wallGeo.dispose(); wallMat.dispose(); tableGeo.dispose(); tableMat.dispose();
    }

    return {
      mesh: mesh, geometry: geometry, material: material, skirt: skirt,
      heightAt: heightAt, recolor: recolor, colorForCell: colorForCell,
      cornerHeights: cornerY, dispose: dispose
    };
  }

  WS.TerrainMesh = { build: build, snowlineFor: snowlineFor };
})();
