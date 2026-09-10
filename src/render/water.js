/* Watershed — water render module. Exports WS.WaterMesh.
   build(world, opts?) -> { group, update(dt), setReservoir(fracFull, turbidity, ash), setRiver(cfs, turbidity), setSeason(seasonIdx), dispose() }
   opts.heightAt(sx, sz) -> scene Y (from WS.TerrainMesh); falls back to world.elev at the cell. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C, R = C.RENDER, PAL = C.PALETTE;

  function s2l(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function unpack(hex) {
    return new Float32Array([s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)]);
  }
  var P = {
    water: unpack(PAL.water), waterDeep: unpack(PAL.waterDeep), waterTurbid: unpack(PAL.waterTurbid), waterAsh: unpack(PAL.waterAsh),
    ice: unpack(0xd8e6ee), foam: unpack(0xeaf4fa), white: unpack(0xffffff)
  };
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function fin(v, d) { return isFinite(v) ? +v : d; }

  /* colour registers */
  var cr = 0, cg = 0, cb = 0;
  function setC(p) { cr = p[0]; cg = p[1]; cb = p[2]; }
  function toward(p, t) { if (!(t > 0)) return; if (t > 1) t = 1; cr += (p[0] - cr) * t; cg += (p[1] - cg) * t; cb += (p[2] - cb) * t; }

  /* ---------- shaders (onBeforeCompile patches) ---------- */
  var RIVER_KEY = 'ws-river-v1', RES_KEY = 'ws-reservoir-v1';

  function patchRiver(mat, U) {
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uTime = U.uTime; shader.uniforms.uSpeed = U.uSpeed; shader.uniforms.uFoam = U.uFoam; shader.uniforms.uFreq = U.uFreq;
      shader.vertexShader = 'varying vec2 vRUv;\n' + shader.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vRUv = uv;');
      shader.fragmentShader = 'uniform float uTime;\nuniform float uSpeed;\nuniform float uFoam;\nuniform float uFreq;\nvarying vec2 vRUv;\n' + shader.fragmentShader
        .replace('#include <emissivemap_fragment>', [
          '#include <emissivemap_fragment>',
          ' float rEdge = min(vRUv.x, 1.0 - vRUv.x) * 2.0;',
          ' float ph = vRUv.y * uFreq - uTime * uSpeed;',
          ' float flow = sin(ph * 6.2831 + sin(vRUv.x * 11.0 + vRUv.y * 2.3) * 2.0);',
          ' float streak = smoothstep(0.55, 1.0, flow) * (0.35 + 0.65 * rEdge);',
          ' float edgeFoam = smoothstep(0.6, 0.0, rEdge) * (0.55 + 0.45 * sin(vRUv.y * 23.0 - uTime * uSpeed * 9.0));',
          ' float foam = (streak * 0.6 + edgeFoam * 0.5) * uFoam;',
          ' totalEmissiveRadiance += vec3(foam);',
          ' diffuseColor.a *= smoothstep(0.0, 0.3, rEdge) * 0.85 + 0.15;'
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () { return RIVER_KEY; };
  }

  function patchReservoir(mat, U) {
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uTime = U.uTime; shader.uniforms.uRipple = U.uRipple; shader.uniforms.uSparkle = U.uSparkle;
      shader.vertexShader = 'uniform float uTime;\nuniform float uRipple;\nattribute float aIn;\nvarying float vIn;\nvarying vec3 vWp;\n' + shader.vertexShader
        .replace('#include <beginnormal_vertex>', [
          '#include <beginnormal_vertex>',
          ' float nwa = position.x * 0.9 + uTime * 1.4;',
          ' float nwb = position.y * 1.15 - uTime * 1.0 + position.x * 0.3;',
          ' objectNormal.x -= cos(nwa) * 0.9 * 0.035 * uRipple * 3.0;',
          ' objectNormal.y -= cos(nwb) * 1.15 * 0.035 * uRipple * 3.0;',
          ' objectNormal = normalize(objectNormal);'
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          ' float wa = position.x * 0.9 + uTime * 1.4;',
          ' float wb = position.y * 1.15 - uTime * 1.0 + position.x * 0.3;',
          ' transformed.z += (sin(wa) + sin(wb)) * 0.035 * uRipple;',
          ' vIn = aIn;',
          ' vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;'
        ].join('\n'));
      shader.fragmentShader = 'uniform float uTime;\nuniform float uSparkle;\nvarying float vIn;\nvarying vec3 vWp;\n' + shader.fragmentShader
        .replace('#include <emissivemap_fragment>', [
          '#include <emissivemap_fragment>',
          ' float s1 = sin(vWp.x * 9.0 + uTime * 1.8 + sin(vWp.z * 5.0 + uTime * 0.7) * 1.5);',
          ' float s2 = sin(vWp.z * 8.1 - uTime * 1.3 + sin(vWp.x * 4.1) * 1.5);',
          ' float sp = pow(max(s1 * s2, 0.0), 20.0);',
          ' totalEmissiveRadiance += vec3(sp * uSparkle);',
          ' diffuseColor.a *= smoothstep(0.2, 0.7, vIn);'
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () { return RES_KEY; };
  }

  /* ---------- build ---------- */
  function build(world, opts) {
    if (typeof THREE === 'undefined' || !world) return null;
    opts = opts || {};
    var N = world.N || C.N, NN = N * N, CELL = R.CELL, half = N / 2;
    var elev = world.elev;
    var heightAt = (typeof opts.heightAt === 'function') ? opts.heightAt : function (sx, sz) {
      var cx = Math.floor(sx / CELL + half), cz = Math.floor(sz / CELL + half);
      if (cx < 0) cx = 0; else if (cx >= N) cx = N - 1;
      if (cz < 0) cz = 0; else if (cz >= N) cz = N - 1;
      var e = elev ? elev[cz * N + cx] : R.ELEV_BASE;
      return C.elevToScene(isFinite(e) ? e : R.ELEV_BASE);
    };
    var group = new THREE.Group();
    group.name = 'water';

    var uTime = { value: 0 };
    var season = C.SEASON.SPRING;
    var res = world.reservoir || {};
    var resCells = res.cells || new Int32Array(0);
    var river = world.river || {};
    var path = river.path || [];
    var widths = river.widths || null;
    var damIndex = fin(river.damIndex, Math.max(0, (path.length / 2) | 0)) | 0;
    if (damIndex >= path.length) damIndex = Math.max(0, path.length - 1);

    /* reservoir mask + dilated mask (excluding the river below the dam) */
    var resMask = new Uint8Array(NN), inMask = new Uint8Array(NN), belowMask = new Uint8Array(NN);
    var i, k;
    for (i = 0; i < resCells.length; i++) { k = resCells[i]; if (k >= 0 && k < NN) resMask[k] = 1; }
    if (river.cellsBelow) { for (i = 0; i < river.cellsBelow.length; i++) { k = river.cellsBelow[i]; if (k >= 0 && k < NN) belowMask[k] = 1; } }
    else { for (i = damIndex + 1; i < path.length; i++) { k = path[i].y * N + path[i].x; if (k >= 0 && k < NN) belowMask[k] = 1; } }
    for (i = 0; i < NN; i++) {
      if (!resMask[i]) continue;
      var x = i % N, y = (i / N) | 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        var j = yy * N + xx;
        if (!belowMask[j] || resMask[j]) inMask[j] = 1;
      }
    }
    if (res.dam && C.inBounds(res.dam.x | 0, res.dam.y | 0)) inMask[(res.dam.y | 0) * N + (res.dam.x | 0)] = 1;

    /* ---------- reservoir plane ---------- */
    var resMesh = null, resMat = null, resU = { uTime: uTime, uRipple: { value: 1 }, uSparkle: { value: 0.35 } };
    var bedElev = fin(res.bedElev, R.ELEV_BASE + 500), spillElev = fin(res.spillElev, bedElev + 30);
    var capacityAF = fin(res.capacityAF, C.HYDRO.RESERVOIR_CAPACITY_AF);
    var levelY = NaN, targetY = C.elevToScene(spillElev);
    if (resCells.length > 0) {
      var bx0 = N, by0 = N, bx1 = -1, by1 = -1;
      for (i = 0; i < resCells.length; i++) {
        k = resCells[i]; if (k < 0 || k >= NN) continue;
        var rx = k % N, ry = (k / N) | 0;
        if (rx < bx0) bx0 = rx; if (rx > bx1) bx1 = rx; if (ry < by0) by0 = ry; if (ry > by1) by1 = ry;
      }
      var pw = (bx1 - bx0 + 5) * CELL, pd = (by1 - by0 + 5) * CELL;
      var pcx = ((bx0 + bx1 + 1) / 2 - half) * CELL, pcz = ((by0 + by1 + 1) / 2 - half) * CELL;
      var segs = 40;
      var resGeo = new THREE.PlaneGeometry(pw, pd, segs, segs);
      var rpos = resGeo.attributes.position, aIn = new Float32Array(rpos.count);
      for (i = 0; i < rpos.count; i++) {
        var wx = pcx + rpos.getX(i), wz = pcz - rpos.getY(i); // plane rotated -90deg about X: world z = -local y
        var cx2 = Math.floor(wx / CELL + half), cz2 = Math.floor(wz / CELL + half);
        aIn[i] = C.inBounds(cx2, cz2) ? inMask[cz2 * N + cx2] : 0;
      }
      resGeo.setAttribute('aIn', new THREE.BufferAttribute(aIn, 1));
      resMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(P.water[0], P.water[1], P.water[2]), transparent: true, opacity: 0.82,
        roughness: 0.15, metalness: 0.05, side: THREE.DoubleSide
      });
      patchReservoir(resMat, resU);
      resMesh = new THREE.Mesh(resGeo, resMat);
      resMesh.name = 'reservoir';
      resMesh.rotation.x = -Math.PI / 2;
      resMesh.position.set(pcx, targetY, pcz);
      resMesh.receiveShadow = true; resMesh.castShadow = false;
      resMesh.renderOrder = 2;
      group.add(resMesh);
    }

    /* ---------- river samples (cached geometry-independent data) ---------- */
    var S = 0, cxA = null, czA = null, sxA = null, szA = null, wA = null, vA = null, insideA = null;
    if (path.length >= 2) {
      var pts = [];
      for (i = 0; i < path.length; i++) {
        var px = fin(path[i].x, 0), py = fin(path[i].y, 0);
        var sc = C.toScene(px, py, 0);
        var ei = C.inBounds(px | 0, py | 0) && elev ? elev[(py | 0) * N + (px | 0)] : R.ELEV_BASE;
        pts.push(new THREE.Vector3(sc.x, C.elevToScene(fin(ei, R.ELEV_BASE)), sc.z));
      }
      var curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
      var PER = 4, segsN = path.length - 1;
      S = segsN * PER + 1;
      cxA = new Float32Array(S); czA = new Float32Array(S); sxA = new Float32Array(S); szA = new Float32Array(S);
      wA = new Float32Array(S); vA = new Float32Array(S); insideA = new Uint8Array(S);
      var tmpP = new THREE.Vector3(), tmpT = new THREE.Vector3(), acc = 0, lx = 0, lz = 0;
      for (i = 0; i < S; i++) {
        var t = i / (S - 1);
        curve.getPoint(t, tmpP); curve.getTangent(t, tmpT);
        var tl = Math.hypot(tmpT.x, tmpT.z) || 1;
        cxA[i] = tmpP.x; czA[i] = tmpP.z;
        sxA[i] = tmpT.z / tl; szA[i] = -tmpT.x / tl;         // side = cross(tangent, up)
        var seg = Math.min(segsN - 1, (i / PER) | 0), f = i / PER - seg;
        var w0 = widths ? fin(widths[seg], 1) : 1, w1 = widths ? fin(widths[Math.min(seg + 1, path.length - 1)], w0) : 1;
        wA[i] = Math.max(0.4, w0 + (w1 - w0) * f);
        if (i > 0) acc += Math.hypot(tmpP.x - lx, tmpP.z - lz);
        vA[i] = acc / CELL; lx = tmpP.x; lz = tmpP.z;
        var cc = C.sceneToCell(tmpP.x, tmpP.z);
        insideA[i] = C.inBounds(cc.x, cc.y) ? resMask[cc.y * N + cc.x] : 0;
      }
    }

    /* ribbon builder: shares the sample arrays, owns its own position buffer */
    function makeRibbon(s0, s1, lift, widthMul, mat, skipInside) {
      var n = s1 - s0 + 1; if (n < 2) return null;
      var pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), idx = [];
      for (var q = 0; q < n; q++) {
        uv[q * 4] = 0; uv[q * 4 + 1] = vA[s0 + q]; uv[q * 4 + 2] = 1; uv[q * 4 + 3] = vA[s0 + q];
        if (q < n - 1) {
          var a = s0 + q;
          if (skipInside && insideA[a] && insideA[a + 1]) continue;
          var l0 = q * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
          idx.push(l0, l1, r0, r0, l1, r1);
        }
      }
      var geo = new THREE.BufferGeometry();
      var pattr = new THREE.BufferAttribute(pos, 3); pattr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', pattr);
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      // ribbons lie on the terrain: a static up normal is enough (no recompute when widths change)
      var nrm = new Float32Array(n * 2 * 3);
      for (var q2 = 1; q2 < nrm.length; q2 += 3) nrm[q2] = 1;
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setIndex(idx);
      var mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true;
      var rib = { mesh: mesh, geo: geo, pos: pos, s0: s0, s1: s1, lift: lift, widthMul: widthMul };
      return rib;
    }
    function layRibbon(rib, widthScale) {
      var pos = rib.pos, p = 0;
      for (var s = rib.s0; s <= rib.s1; s++) {
        var hw = wA[s] * CELL * widthScale * rib.widthMul * 0.5;
        var cx = cxA[s], cz = czA[s], sx = sxA[s] * hw, sz = szA[s] * hw;
        var hc = heightAt(cx, cz);
        var lxp = cx + sx, lzp = cz + sz, rxp = cx - sx, rzp = cz - sz;
        var hl = heightAt(lxp, lzp), hr = heightAt(rxp, rzp);
        if (!(hl > hc)) hl = hc; if (!(hr > hc)) hr = hc;
        if (!isFinite(hl)) hl = 0; if (!isFinite(hr)) hr = 0;
        pos[p++] = lxp; pos[p++] = hl + rib.lift; pos[p++] = lzp;
        pos[p++] = rxp; pos[p++] = hr + rib.lift; pos[p++] = rzp;
      }
      rib.geo.attributes.position.needsUpdate = true;
    }

    var riverU = { uTime: uTime, uSpeed: { value: 1 }, uFoam: { value: 0.28 }, uFreq: { value: 0.5 } };
    var wwU = { uTime: uTime, uSpeed: { value: 3 }, uFoam: { value: 1.1 }, uFreq: { value: 1.5 } };
    var spU = { uTime: uTime, uSpeed: { value: 2.5 }, uFoam: { value: 1.0 }, uFreq: { value: 3.0 } };
    var riverMat = null, wwMat = null, spMat = null, riverRib = null, wwRib = null, spMesh = null, spPos = null;
    if (S >= 2) {
      riverMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(P.water[0], P.water[1], P.water[2]), transparent: true, opacity: 0.9, roughness: 0.3, metalness: 0.05, depthWrite: false, side: THREE.DoubleSide });
      patchRiver(riverMat, riverU);
      wwMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(P.foam[0], P.foam[1], P.foam[2]), transparent: true, opacity: 0.85, roughness: 0.5, metalness: 0, depthWrite: false, side: THREE.DoubleSide });
      patchRiver(wwMat, wwU);
      spMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(P.foam[0], P.foam[1], P.foam[2]), transparent: true, opacity: 0.7, roughness: 0.4, metalness: 0, depthWrite: false, side: THREE.DoubleSide });
      patchRiver(spMat, spU);

      riverRib = makeRibbon(0, S - 1, 0.08, 1, riverMat, true);
      riverRib.mesh.name = 'river'; riverRib.mesh.renderOrder = 1;
      group.add(riverRib.mesh);

      var dS = Math.min(S - 2, damIndex * 4 + 2), dE = Math.min(S - 1, dS + 12);
      if (dE - dS >= 2) {
        wwRib = makeRibbon(dS, dE, 0.11, 1.15, wwMat, false);
        wwRib.mesh.name = 'whitewater'; wwRib.mesh.renderOrder = 3;
        group.add(wwRib.mesh);
      }

      /* spillway sheen: quad from the dam crest down to the tailwater */
      var sTop = Math.min(S - 1, damIndex * 4), sBot = Math.min(S - 1, sTop + 4);
      spPos = new Float32Array(4 * 3);
      var spGeo = new THREE.BufferGeometry();
      var spAttr = new THREE.BufferAttribute(spPos, 3); spAttr.setUsage(THREE.DynamicDrawUsage);
      spGeo.setAttribute('position', spAttr);
      spGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
      spGeo.setIndex([0, 2, 1, 1, 2, 3]);
      spMesh = new THREE.Mesh(spGeo, spMat);
      spMesh.name = 'spillway'; spMesh.frustumCulled = false; spMesh.renderOrder = 3;
      group.add(spMesh);
      var laySpill = function () {
        var hw = 0.42 * CELL;
        var tx = cxA[sTop], tz = czA[sTop], ty = C.elevToScene(spillElev) + 0.06;
        var bx = cxA[sBot], bz = czA[sBot], by = heightAt(bx, bz) + 0.12;
        if (by > ty - 0.05) by = ty - 0.05;
        var sx = sxA[sTop] * hw, sz = szA[sTop] * hw;
        spPos[0] = tx + sx; spPos[1] = ty; spPos[2] = tz + sz;
        spPos[3] = tx - sx; spPos[4] = ty; spPos[5] = tz - sz;
        spPos[6] = bx + sx; spPos[7] = by; spPos[8] = bz + sz;
        spPos[9] = bx - sx; spPos[10] = by; spPos[11] = bz - sz;
        spAttr.needsUpdate = true;
      };
      laySpill();
      spGeo.computeVertexNormals(); // static quad: computed once at build
    }

    /* ---------- state + look application ---------- */
    var lastFrac = 0.75, lastTurb = 0.05, lastAsh = 0, lastCfs = 60, lastRTurb = 0.05;

    function applyReservoirLook() {
      if (!resMat) return;
      var winter = season === C.SEASON.WINTER;
      setC(P.water);
      toward(P.waterTurbid, lastTurb);
      toward(P.waterAsh, lastAsh);
      if (winter) toward(P.ice, 0.55);
      resMat.color.setRGB(cr, cg, cb);
      resMat.opacity = winter ? 0.94 : 0.82 + 0.12 * Math.max(lastTurb, lastAsh);
      resMat.roughness = winter ? 0.5 : 0.15 + 0.4 * Math.max(lastTurb, lastAsh);
      resU.uRipple.value = winter ? 0.15 : 1;
      resU.uSparkle.value = winter ? 0.04 : 0.35 * (1 - 0.7 * Math.max(lastTurb, lastAsh));
    }
    function applyRiverLook() {
      if (!riverMat) return;
      var winter = season === C.SEASON.WINTER;
      var cf = Math.min(1, lastCfs / 400), cf2 = Math.min(1, lastCfs / 600);
      setC(P.water);
      toward(P.white, 0.12);
      toward(P.waterTurbid, lastRTurb);
      if (winter) toward(P.ice, 0.45);
      riverMat.color.setRGB(cr, cg, cb);
      riverMat.opacity = winter ? 0.95 : 0.9;
      riverMat.roughness = winter ? 0.55 : 0.3 + 0.3 * lastRTurb;
      riverU.uSpeed.value = (0.5 + 1.5 * cf2) * (winter ? 0.5 : 1);
      riverU.uFoam.value = (winter ? 0.08 : 0.22 + 0.18 * cf) * (1 - 0.6 * lastRTurb);
      if (wwMat) {
        setC(P.foam); toward(P.waterTurbid, lastRTurb * 0.6);
        wwMat.color.setRGB(cr, cg, cb);
        wwU.uSpeed.value = (2 + 2 * cf) * (winter ? 0.6 : 1);
        wwU.uFoam.value = winter ? 0.3 : 0.6 + 0.8 * cf;
        wwMat.opacity = 0.55 + 0.35 * cf;
      }
      if (spMat) {
        spMat.color.setRGB(cr, cg, cb);
        spU.uSpeed.value = (1.5 + 2 * cf) * (winter ? 0.6 : 1);
        spU.uFoam.value = winter ? 0.25 : 0.5 + 0.7 * cf;
        spMat.opacity = 0.45 + 0.4 * cf;
      }
    }

    function setReservoir(fracFull, turbidity, ash) {
      lastFrac = C.clamp(fin(fracFull, lastFrac), 0, 1.1);
      lastTurb = clamp01(fin(turbidity, lastTurb));
      lastAsh = clamp01(fin(ash, lastAsh));
      var lvl;
      if (typeof res.levelForStorage === 'function') lvl = fin(res.levelForStorage(lastFrac * capacityAF), NaN);
      if (!isFinite(lvl)) lvl = bedElev + (spillElev - bedElev) * Math.min(1, lastFrac);
      targetY = C.elevToScene(lvl) + 0.03;
      if (!isFinite(levelY)) { levelY = targetY; if (resMesh) resMesh.position.y = levelY; }
      applyReservoirLook();
    }
    function setRiver(cfs, turbidity) {
      lastCfs = Math.max(0, fin(cfs, lastCfs));
      lastRTurb = clamp01(fin(turbidity, lastRTurb));
      var widthScale = 0.55 + 0.45 * Math.min(1, lastCfs / 400);
      if (riverRib) layRibbon(riverRib, widthScale);
      if (wwRib) layRibbon(wwRib, widthScale);
      applyRiverLook();
    }
    function setSeason(seasonIdx) {
      seasonIdx = seasonIdx | 0; if (seasonIdx < 0 || seasonIdx > 3) seasonIdx = 0;
      season = seasonIdx;
      applyReservoirLook(); applyRiverLook();
    }
    function update(dt) {
      if (!(dt > 0)) dt = 0; if (dt > 0.1) dt = 0.1;
      var tv = uTime.value + dt; if (tv > 1e5) tv = 0;
      uTime.value = tv;
      if (resMesh && isFinite(levelY) && Math.abs(targetY - levelY) > 1e-4) {
        levelY += (targetY - levelY) * (1 - Math.exp(-dt * 1.6));
        if (Math.abs(targetY - levelY) <= 1e-4) levelY = targetY;
        resMesh.position.y = levelY;
      }
    }
    function dispose() {
      group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }

    setReservoir(lastFrac, lastTurb, lastAsh);
    setRiver(lastCfs, lastRTurb);
    setSeason(season);

    return {
      group: group, update: update, setReservoir: setReservoir, setRiver: setRiver, setSeason: setSeason, dispose: dispose,
      meshes: { reservoir: resMesh, river: riverRib ? riverRib.mesh : null, whitewater: wwRib ? wwRib.mesh : null, spillway: spMesh },
      getLevelY: function () { return levelY; }
    };
  }

  WS.WaterMesh = { build: build };
})();
