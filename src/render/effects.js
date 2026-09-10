/* Watershed — effects: fire (flames/embers/smoke/glow), weather (rain/snow/storm clouds/lightning/fog),
   flood debris particles, data overlays + flow network, cell highlights, mitigation markers, placement cursor.
   Browser only (needs THREE r128). Exports WS.Effects.init(scene, world, opts) -> fx. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C;
  var PAL = C.PALETTE;
  var N = C.N;
  var TAU = Math.PI * 2;

  // ---- capacities -------------------------------------------------------
  var FLAME_CAP = 5000, MAX_FIRE_CELLS = 1000, EMBER_CAP = 500, SMOKE_CAP = 1500, WISP_CAP = 400;
  var RAIN_CAP = 2500, SNOW_CAP = 1800, DEBRIS_CAP = 4000, HILITE_CAP = 3000;
  var BOX_W = 60, BOX_H = 40;
  var BASE_FOG_DENSITY = 0.0065;

  function rnd(a, b) { return a + (b - a) * Math.random(); }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function wrap(v, lo, size) { v -= lo; v -= Math.floor(v / size) * size; return lo + v; }

  // ---- canvas textures --------------------------------------------------
  function makeCanvas(size) {
    var cv = document.createElement('canvas'); cv.width = cv.height = size;
    return cv;
  }
  function radialTex(size, stops, sx, sy) {
    var cv = makeCanvas(size), ctx = cv.getContext('2d'), h = size / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.save(); ctx.translate(h, h); ctx.scale(sx || 1, sy || 1);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, h);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], 'rgba(255,255,255,' + stops[i][1] + ')');
    ctx.fillStyle = g; ctx.fillRect(-h * 4, -h * 4, size * 4, size * 4);
    ctx.restore();
    var t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    return t;
  }
  function cloudTex(size) {
    var cv = makeCanvas(size), ctx = cv.getContext('2d'), h = size / 2;
    ctx.clearRect(0, 0, size, size);
    var r = WS.RNG ? WS.RNG.create('clouds') : { range: rnd };
    for (var i = 0; i < 26; i++) {
      var a = r.range(0, TAU), d = r.range(0, h * 0.55), cx = h + Math.cos(a) * d, cy = h + Math.sin(a) * d, rad = r.range(h * 0.25, h * 0.5);
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.28)'); g.addColorStop(0.6, 'rgba(255,255,255,0.10)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    }
    var t = new THREE.CanvasTexture(cv); return t;
  }

  // ---- shaders ------------------------------------------------------------
  var SPRITE_VS = [
    'attribute float aSize; attribute float aAlpha; attribute vec3 aColor; attribute float aPhase;',
    'uniform float uScale; uniform float uTime; uniform float uFlicker; uniform float uOpacity;',
    'varying vec4 vColor;',
    '#include <fog_pars_vertex>',
    'void main(){',
    '  vec3 p = position; float s = aSize; float heat = 0.0;',
    '  if (uFlicker > 0.5) {',
    '    float f = sin(uTime*9.0 + aPhase)*0.5+0.5; float f2 = sin(uTime*14.3 + aPhase*2.7)*0.5+0.5;',
    '    p.y += f*0.22*aSize; p.x += (f2-0.5)*0.12*aSize; p.z += (f-0.5)*0.08*aSize;',
    '    s *= 0.7 + 0.55*f; heat = f2;',
    '  }',
    '  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);',
    '  gl_PointSize = s * uScale / max(0.5, -mvPosition.z);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  vColor = vec4(mix(aColor, vec3(1.0, 0.92, 0.5), heat*0.65*uFlicker), aAlpha*uOpacity);',
    '#include <fog_vertex>',
    '}'].join('\n');
  var SPRITE_FS = [
    'uniform sampler2D map; varying vec4 vColor;',
    '#include <fog_pars_fragment>',
    'void main(){',
    '  vec4 t = texture2D(map, gl_PointCoord);',
    '  float a = t.a * vColor.a; if (a < 0.004) discard;',
    '  gl_FragColor = vec4(vColor.rgb * t.rgb, a);',
    '#include <tonemapping_fragment>',
    '#include <encodings_fragment>',
    '#include <fog_fragment>',
    '}'].join('\n');
  var OV_VS = [
    'attribute vec3 aColor; attribute float aAlpha; varying vec4 vC;',
    'void main(){ vC = vec4(aColor, aAlpha); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'].join('\n');
  var OV_FS = [
    'uniform float uOpacity; varying vec4 vC;',
    'void main(){ float a = vC.a * uOpacity; if (a < 0.003) discard; gl_FragColor = vec4(vC.rgb, a);',
    '#include <tonemapping_fragment>',
    '#include <encodings_fragment>',
    '}'].join('\n');
  var LINE_VS = [
    'attribute float aDist; attribute vec3 aColor; varying vec3 vColor; varying float vDist;',
    'void main(){ vColor = aColor; vDist = aDist; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'].join('\n');
  var LINE_FS = [
    'uniform float uTime; uniform float uOpacity; varying vec3 vColor; varying float vDist;',
    'void main(){',
    '  float s = fract((vDist + uTime*3.2) / 2.4);',
    '  float stripe = smoothstep(0.0, 0.3, s) * (1.0 - smoothstep(0.5, 0.72, s));',
    '  gl_FragColor = vec4(vColor * (0.7 + 0.7*stripe), uOpacity * (0.5 + 0.5*stripe));',
    '#include <tonemapping_fragment>',
    '#include <encodings_fragment>',
    '}'].join('\n');

  // ---- init ----------------------------------------------------------------
  function init(scene, world, opts) {
    opts = opts || {};
    var curWorld = world || null;
    var srgb = !opts.renderer || opts.renderer.outputEncoding === THREE.sRGBEncoding;
    var time = 0, uScale = 400;
    var wind = { dir: 0.8, mph: 8, x: Math.cos(0.8), z: Math.sin(0.8) };
    var focus = new THREE.Vector3(0, 10, 0);
    var tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4();
    var tmpS = new THREE.Vector3(1, 1, 1), UP = new THREE.Vector3(0, 1, 0), tmpC = new THREE.Color(), tmpC2 = new THREE.Color();
    var rootGroup = new THREE.Group(); rootGroup.name = 'effects'; scene.add(rootGroup);
    var disposables = [];

    function col(hex) { tmpC.setHex(hex); if (srgb) tmpC.convertSRGBToLinear(); return tmpC; }
    function colObj(hex) { var c = new THREE.Color(hex); if (srgb) c.convertSRGBToLinear(); return c; }

    // ---- heights ----------------------------------------------------------
    function fallbackH(sx, sz) {
      var w = curWorld; if (!w || !w.elev) return 0;
      var fx = sx + N / 2 - 0.5, fz = sz + N / 2 - 0.5;
      fx = fx < 0 ? 0 : (fx > N - 1 ? N - 1 : fx); fz = fz < 0 ? 0 : (fz > N - 1 ? N - 1 : fz);
      var x0 = Math.floor(fx), z0 = Math.floor(fz), x1 = Math.min(x0 + 1, N - 1), z1 = Math.min(z0 + 1, N - 1);
      var tx = fx - x0, tz = fz - z0, e = w.elev;
      var a = e[z0 * N + x0] * (1 - tx) + e[z0 * N + x1] * tx, b = e[z1 * N + x0] * (1 - tx) + e[z1 * N + x1] * tx;
      return fin(C.elevToScene(a * (1 - tz) + b * tz), 0);
    }
    function H(sx, sz) {
      var f = opts.heightAt;
      if (typeof f === 'function') { var v = f(sx, sz); if (typeof v === 'number' && isFinite(v)) return v; }
      return fallbackH(sx, sz);
    }
    function hasRealHeights() { return typeof opts.heightAt === 'function'; }
    function cellH(x, y) { return H(x - N / 2 + 0.5, y - N / 2 + 0.5); }
    function sceneX(x) { return x - N / 2 + 0.5; }
    function sceneZ(y) { return y - N / 2 + 0.5; }

    // ---- textures & sprite systems ---------------------------------------
    var texSoft = radialTex(64, [[0, 1], [0.35, 0.75], [0.7, 0.25], [1, 0]]);
    var texFlame = radialTex(64, [[0, 1], [0.22, 0.95], [0.55, 0.4], [1, 0]], 0.75, 1.0);
    var texEmber = radialTex(32, [[0, 1], [0.3, 0.9], [1, 0]]);
    var texRain = radialTex(64, [[0, 0.9], [0.5, 0.5], [1, 0]], 0.16, 1.0);
    var texSnow = radialTex(32, [[0, 1], [0.5, 0.8], [1, 0]]);
    var texCloud = cloudTex(256);
    var texDebris = radialTex(32, [[0, 1], [0.6, 0.9], [0.85, 0.3], [1, 0]]);
    disposables.push(texSoft, texFlame, texEmber, texRain, texSnow, texCloud, texDebris);

    function makeSystem(cap, tex, blending, flicker, useFog, name) {
      var geo = new THREE.BufferGeometry();
      var s = {
        cap: cap, n: 0, geo: geo,
        pos: new Float32Array(cap * 3), size: new Float32Array(cap), alpha: new Float32Array(cap),
        color: new Float32Array(cap * 3), phase: new Float32Array(cap)
      };
      s.aPos = new THREE.BufferAttribute(s.pos, 3); s.aSize = new THREE.BufferAttribute(s.size, 1);
      s.aAlpha = new THREE.BufferAttribute(s.alpha, 1); s.aColor = new THREE.BufferAttribute(s.color, 3);
      s.aPhase = new THREE.BufferAttribute(s.phase, 1);
      s.attrs = [s.aPos, s.aSize, s.aAlpha, s.aColor, s.aPhase];
      for (var i = 0; i < s.attrs.length; i++) s.attrs[i].setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', s.aPos); geo.setAttribute('aSize', s.aSize); geo.setAttribute('aAlpha', s.aAlpha);
      geo.setAttribute('aColor', s.aColor); geo.setAttribute('aPhase', s.aPhase);
      geo.setDrawRange(0, 0);
      var uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        map: { value: null }, uScale: { value: 400 }, uTime: { value: 0 }, uOpacity: { value: 1 }, uFlicker: { value: flicker ? 1 : 0 }
      }]);
      uniforms.map.value = tex;
      s.mat = new THREE.ShaderMaterial({
        uniforms: uniforms, vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS,
        transparent: true, depthWrite: false, depthTest: true, blending: blending, fog: !!useFog
      });
      s.points = new THREE.Points(geo, s.mat); s.points.frustumCulled = false; s.points.name = name || 'fx';
      s.points.renderOrder = 10;
      rootGroup.add(s.points);
      disposables.push(geo, s.mat);
      return s;
    }
    function flush(s, n) {
      s.n = n; s.geo.setDrawRange(0, n);
      s.points.visible = n > 0;
      if (n <= 0) return;
      for (var i = 0; i < s.attrs.length; i++) {
        var a = s.attrs[i]; a.needsUpdate = true; a.updateRange.offset = 0; a.updateRange.count = n * a.itemSize;
      }
    }
    function setColor(s, i, r, g, b) { var o = i * 3; s.color[o] = r; s.color[o + 1] = g; s.color[o + 2] = b; }
    // swap particle j into slot i (for CPU-simulated pools)
    function swapParticle(s, extra, i, j) {
      if (i === j) return;
      var p = s.pos, o = i * 3, q = j * 3;
      p[o] = p[q]; p[o + 1] = p[q + 1]; p[o + 2] = p[q + 2];
      s.size[i] = s.size[j]; s.alpha[i] = s.alpha[j]; s.phase[i] = s.phase[j];
      s.color[o] = s.color[q]; s.color[o + 1] = s.color[q + 1]; s.color[o + 2] = s.color[q + 2];
      var v = extra.vel; v[o] = v[q]; v[o + 1] = v[q + 1]; v[o + 2] = v[q + 2];
      extra.age[i] = extra.age[j]; extra.life[i] = extra.life[j]; extra.size0[i] = extra.size0[j]; extra.kind[i] = extra.kind[j];
    }
    function makeExtra(cap) {
      return { vel: new Float32Array(cap * 3), age: new Float32Array(cap), life: new Float32Array(cap), size0: new Float32Array(cap), kind: new Uint8Array(cap), spawnAcc: 0 };
    }

    // =====================================================================
    // FIRE
    // =====================================================================
    var fireCol = colObj(PAL.fire), emberCol = colObj(PAL.ember), emberRed = colObj(0xff4a1a);
    var smokeDark = colObj(0x3a3634), smokeLight = colObj(0x9a9a9a), wispCol = colObj(0xb0aca8);
    var flames = makeSystem(FLAME_CAP, texFlame, THREE.AdditiveBlending, true, false, 'flames');
    var embers = makeSystem(EMBER_CAP, texEmber, THREE.AdditiveBlending, false, false, 'embers'); var emberX = makeExtra(EMBER_CAP);
    var smoke = makeSystem(SMOKE_CAP, texSoft, THREE.NormalBlending, false, true, 'smoke'); var smokeX = makeExtra(SMOKE_CAP);
    smoke.points.renderOrder = 9;
    var fire = {
      cells: new Int32Array(MAX_FIRE_CELLS), cx: new Float32Array(MAX_FIRE_CELLS), cy: new Float32Array(MAX_FIRE_CELLS), cz: new Float32Array(MAX_FIRE_CELLS),
      n: 0, fade: 0, active: false, centroid: new THREE.Vector3(), flick: 0,
      wisp: new Int32Array(WISP_CAP), wispX: new Float32Array(WISP_CAP), wispY: new Float32Array(WISP_CAP), wispZ: new Float32Array(WISP_CAP),
      wispT: new Float32Array(WISP_CAP), wispN: 0, wispRate: 0, quickFade: false
    };
    var fireLight = new THREE.PointLight(0xff7a2a, 0, 30, 2); fireLight.name = 'fireLight'; fireLight.castShadow = false;
    rootGroup.add(fireLight);

    function setFire(burningIdx, burnedIdx) {
      burningIdx = burningIdx || []; burnedIdx = burnedIdx || [];
      var total = burningIdx.length | 0;
      var n = Math.min(total, MAX_FIRE_CELLS), stride = total > 0 ? total / n : 1;
      var k = 0, sx = 0, sy = 0, sz = 0, f = 0;
      for (var c = 0; c < n; c++) {
        var i = burningIdx[Math.floor(c * stride)] | 0;
        if (i < 0 || i >= N * N) continue;
        var x = i % N, y = (i / N) | 0;
        var px = sceneX(x), pz = sceneZ(y), py = cellH(x, y);
        fire.cells[k] = i; fire.cx[k] = px; fire.cy[k] = py; fire.cz[k] = pz; k++;
        sx += px; sy += py; sz += pz;
        var per = 3 + Math.floor(Math.random() * 3);
        for (var q = 0; q < per && f < FLAME_CAP; q++, f++) {
          var o = f * 3;
          flames.pos[o] = px + rnd(-0.42, 0.42); flames.pos[o + 1] = py + rnd(0.05, 0.4); flames.pos[o + 2] = pz + rnd(-0.42, 0.42);
          flames.size[f] = rnd(0.7, 1.3); flames.alpha[f] = rnd(0.45, 0.75); flames.phase[f] = rnd(0, TAU * 4);
          // deep orange-red core, a few hotter yellow tongues; kept dark enough that additive stacking reads as fire, not white glare
          var t = Math.random();
          setColor(flames, f, 1.0, 0.22 + 0.4 * t * t, 0.03 + 0.08 * t);
        }
      }
      fire.n = k;
      flush(flames, f);
      if (k > 0) { fire.centroid.set(sx / k, sy / k + 1.5, sz / k); fire.active = true; fire.quickFade = false; }
      // wisps on burned cells
      var bt = burnedIdx.length | 0;
      if (bt > 0) {
        var wn = Math.min(bt, WISP_CAP), ws = bt / wn, m = 0;
        for (c = 0; c < wn; c++) {
          i = burnedIdx[Math.floor(c * ws)] | 0; if (i < 0 || i >= N * N) continue;
          x = i % N; y = (i / N) | 0;
          fire.wisp[m] = i; fire.wispX[m] = sceneX(x); fire.wispZ[m] = sceneZ(y); fire.wispY[m] = cellH(x, y); fire.wispT[m] = 1; m++;
        }
        fire.wispN = m;
      } else if (total === 0) {
        fire.wispN = 0; fire.quickFade = true;
      }
    }

    function spawnEmber() {
      var n = embers.n; if (n >= EMBER_CAP || fire.n === 0) return;
      var c = (Math.random() * fire.n) | 0, o = n * 3;
      embers.pos[o] = fire.cx[c] + rnd(-0.4, 0.4); embers.pos[o + 1] = fire.cy[c] + rnd(0.2, 0.6); embers.pos[o + 2] = fire.cz[c] + rnd(-0.4, 0.4);
      var ws = wind.mph * 0.06;
      emberX.vel[o] = wind.x * ws + rnd(-0.5, 0.5); emberX.vel[o + 1] = rnd(1.6, 3.6); emberX.vel[o + 2] = wind.z * ws + rnd(-0.5, 0.5);
      emberX.age[n] = 0; emberX.life[n] = rnd(1.2, 2.6); emberX.size0[n] = rnd(0.1, 0.2); emberX.kind[n] = 0;
      embers.size[n] = emberX.size0[n]; embers.alpha[n] = 1; embers.phase[n] = 0;
      setColor(embers, n, emberCol.r, emberCol.g, emberCol.b);
      embers.n = n + 1;
    }
    function spawnSmoke(px, py, pz, wisp) {
      var n = smoke.n; if (n >= SMOKE_CAP) return;
      var o = n * 3, ws = wind.mph * 0.045;
      smoke.pos[o] = px + rnd(-0.5, 0.5); smoke.pos[o + 1] = py + (wisp ? 0.1 : 0.35); smoke.pos[o + 2] = pz + rnd(-0.5, 0.5);
      smokeX.vel[o] = wind.x * ws + rnd(-0.25, 0.25); smokeX.vel[o + 1] = wisp ? rnd(0.5, 1.0) : rnd(1.2, 2.5); smokeX.vel[o + 2] = wind.z * ws + rnd(-0.25, 0.25);
      smokeX.age[n] = 0; smokeX.life[n] = wisp ? rnd(4, 7) : rnd(6, 10); smokeX.size0[n] = wisp ? rnd(0.4, 0.7) : rnd(0.5, 0.9); smokeX.kind[n] = wisp ? 1 : 0;
      smoke.size[n] = smokeX.size0[n]; smoke.alpha[n] = 0; smoke.phase[n] = rnd(0, TAU);
      setColor(smoke, n, smokeDark.r, smokeDark.g, smokeDark.b);
      smoke.n = n + 1;
    }
    function updateFire(dt) {
      var target = fire.n > 0 ? 1 : 0;
      if (fire.fade < target) fire.fade = Math.min(1, fire.fade + dt * 2); else if (fire.fade > target) fire.fade = Math.max(0, fire.fade - dt);
      fire.flick = 0.85 + 0.15 * Math.sin(time * 23) * Math.sin(time * 7.3) + 0.1 * Math.sin(time * 41);
      flames.mat.uniforms.uOpacity.value = fire.fade; flames.mat.uniforms.uTime.value = time;
      var strength = Math.min(1, fire.n / 60 + 0.25);
      fireLight.intensity = fire.fade * strength * 1.6 * fire.flick;
      fireLight.position.copy(fire.centroid); // light stays in the scene (intensity 0) so shaders never recompile
      if (fire.fade <= 0 && fire.n === 0) { if (flames.n > 0) flush(flames, 0); fire.active = false; }
      // embers
      var ws = wind.mph * 0.06;
      if (fire.n > 0) {
        emberX.spawnAcc += dt * Math.min(fire.n, 300) * 1.2;
        while (emberX.spawnAcc >= 1) { emberX.spawnAcc -= 1; spawnEmber(); }
      }
      var i = 0, o, t;
      while (i < embers.n) {
        emberX.age[i] += dt; t = emberX.age[i] / emberX.life[i];
        if (t >= 1) { swapParticle(embers, emberX, i, embers.n - 1); embers.n--; continue; }
        o = i * 3;
        emberX.vel[o] += (wind.x * ws - emberX.vel[o]) * dt * 0.8 + rnd(-2, 2) * dt;
        emberX.vel[o + 2] += (wind.z * ws - emberX.vel[o + 2]) * dt * 0.8 + rnd(-2, 2) * dt;
        emberX.vel[o + 1] -= 1.2 * dt;
        embers.pos[o] += emberX.vel[o] * dt; embers.pos[o + 1] += emberX.vel[o + 1] * dt; embers.pos[o + 2] += emberX.vel[o + 2] * dt;
        embers.alpha[i] = (1 - t * t) * (0.6 + 0.4 * Math.sin(time * 30 + i));
        embers.size[i] = emberX.size0[i] * (1 - 0.5 * t);
        setColor(embers, i, emberCol.r + (emberRed.r - emberCol.r) * t, emberCol.g + (emberRed.g - emberCol.g) * t, emberCol.b + (emberRed.b - emberCol.b) * t);
        i++;
      }
      embers.mat.uniforms.uOpacity.value = fire.fade; embers.mat.uniforms.uScale.value = uScale; flames.mat.uniforms.uScale.value = uScale;
      flush(embers, embers.n);
      // smoke spawning
      if (fire.n > 0) {
        smokeX.spawnAcc += dt * Math.min(fire.n * 0.8, 240);
        while (smokeX.spawnAcc >= 1) { smokeX.spawnAcc -= 1; var c = (Math.random() * fire.n) | 0; spawnSmoke(fire.cx[c], fire.cy[c], fire.cz[c], false); }
      }
      if (fire.wispN > 0) {
        var decay = dt / 45;
        var acc = 0;
        for (i = 0; i < fire.wispN; i++) { fire.wispT[i] -= decay; acc += Math.max(0, fire.wispT[i]); }
        if (acc <= 0) fire.wispN = 0;
        else {
          fire.wispRate += dt * Math.min(acc * 0.06, 24);
          while (fire.wispRate >= 1) {
            fire.wispRate -= 1; var wc = (Math.random() * fire.wispN) | 0;
            if (fire.wispT[wc] > 0 && Math.random() < fire.wispT[wc]) spawnSmoke(fire.wispX[wc], fire.wispY[wc], fire.wispZ[wc], true);
          }
        }
      }
      // smoke sim
      var ageMul = fire.quickFade ? 4 : 1, wsm = wind.mph * 0.045;
      i = 0;
      while (i < smoke.n) {
        smokeX.age[i] += dt * ageMul; t = smokeX.age[i] / smokeX.life[i];
        if (t >= 1) { swapParticle(smoke, smokeX, i, smoke.n - 1); smoke.n--; continue; }
        o = i * 3;
        smokeX.vel[o] += (wind.x * wsm - smokeX.vel[o]) * dt * 0.5; smokeX.vel[o + 2] += (wind.z * wsm - smokeX.vel[o + 2]) * dt * 0.5;
        smoke.pos[o] += (smokeX.vel[o] + Math.sin(time * 0.7 + smoke.phase[i]) * 0.15) * dt;
        smoke.pos[o + 1] += smokeX.vel[o + 1] * dt; smoke.pos[o + 2] += smokeX.vel[o + 2] * dt;
        var wisp = smokeX.kind[i] === 1;
        smoke.size[i] = smokeX.size0[i] + t * (wisp ? 1.6 : 2.8);
        var a = (t < 0.15 ? t / 0.15 : 1) * Math.pow(1 - t, 1.3) * (wisp ? 0.14 : 0.34);
        smoke.alpha[i] = a;
        var tt = Math.min(1, t * 1.4);
        if (wisp) setColor(smoke, i, wispCol.r, wispCol.g, wispCol.b);
        else setColor(smoke, i, smokeDark.r + (smokeLight.r - smokeDark.r) * tt, smokeDark.g + (smokeLight.g - smokeDark.g) * tt, smokeDark.b + (smokeLight.b - smokeDark.b) * tt);
        i++;
      }
      smoke.mat.uniforms.uScale.value = uScale;
      flush(smoke, smoke.n);
    }

    // =====================================================================
    // WEATHER
    // =====================================================================
    var rain = makeSystem(RAIN_CAP, texRain, THREE.NormalBlending, false, true, 'rain');
    var snow = makeSystem(SNOW_CAP, texSnow, THREE.NormalBlending, false, true, 'snow');
    var rainCol = colObj(0xc4d6e8), snowCol = colObj(0xffffff);
    (function initPrecip() {
      for (var i = 0; i < RAIN_CAP; i++) {
        var o = i * 3; rain.pos[o] = rnd(-30, 30); rain.pos[o + 1] = rnd(0, 40); rain.pos[o + 2] = rnd(-30, 30);
        rain.size[i] = rnd(0.7, 1.1); rain.alpha[i] = rnd(0.35, 0.6); rain.phase[i] = rnd(0, TAU); setColor(rain, i, rainCol.r, rainCol.g, rainCol.b);
      }
      for (i = 0; i < SNOW_CAP; i++) {
        o = i * 3; snow.pos[o] = rnd(-30, 30); snow.pos[o + 1] = rnd(0, 40); snow.pos[o + 2] = rnd(-30, 30);
        snow.size[i] = rnd(0.16, 0.3); snow.alpha[i] = rnd(0.7, 0.95); snow.phase[i] = rnd(0, TAU); setColor(snow, i, snowCol.r, snowCol.g, snowCol.b);
      }
    })();
    var weather = { kind: 'clear', intensity: 0, ramp: 0, precip: 'none', cloudOp: 0, lightningT: rnd(4, 9), flashFrames: 0, flashing: false };
    var cloudGeo = new THREE.PlaneGeometry(90, 90); cloudGeo.rotateX(-Math.PI / 2);
    var cloudMat = new THREE.MeshBasicMaterial({ map: texCloud, color: 0x2b3038, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: false });
    disposables.push(cloudGeo, cloudMat);
    var clouds = [], cloudOff = new Float32Array(8);
    for (var ci = 0; ci < 4; ci++) {
      var cm = new THREE.Mesh(cloudGeo, cloudMat); cm.frustumCulled = false; cm.renderOrder = 8; cm.visible = false; cm.rotation.y = rnd(0, TAU);
      clouds.push(cm); rootGroup.add(cm); cloudOff[ci * 2] = rnd(-40, 40); cloudOff[ci * 2 + 1] = rnd(-40, 40);
    }
    var flashLight = new THREE.HemisphereLight(0xe6eeff, 0x8f9bb3, 0); flashLight.name = 'lightning'; rootGroup.add(flashLight);

    function setWeather(kind, intensity) {
      kind = (typeof kind === 'string') ? kind : 'clear';
      if (['clear', 'rain', 'storm', 'snow', 'smoke', 'haze'].indexOf(kind) < 0) kind = 'clear';
      intensity = clamp01(fin(intensity, kind === 'clear' ? 0 : 0.7));
      if (kind === 'clear') intensity = 0;
      if (kind !== weather.kind) weather.ramp = 0;
      weather.kind = kind; weather.intensity = intensity;
      weather.precip = (kind === 'rain' || kind === 'storm') ? 'rain' : (kind === 'snow' ? 'snow' : 'none');
      fogDirty = true;
    }
    function setWind(dirRad, mph) {
      wind.dir = fin(dirRad, wind.dir); wind.mph = C.clamp(fin(mph, wind.mph), 0, 120);
      wind.x = Math.cos(wind.dir); wind.z = Math.sin(wind.dir);
    }
    function updatePrecip(s, count, dt, isSnow) {
      var bx = focus.x - BOX_W / 2, bz = focus.z - BOX_W / 2, by = focus.y - 4;
      var fall = isSnow ? (1.3 + 0.9 * weather.intensity) : (15 + 7 * weather.intensity);
      var wx = wind.x * wind.mph * (isSnow ? 0.06 : 0.09), wz = wind.z * wind.mph * (isSnow ? 0.06 : 0.09);
      for (var i = 0; i < count; i++) {
        var o = i * 3;
        var px = s.pos[o] + wx * dt, py = s.pos[o + 1] - fall * dt * (isSnow ? (0.7 + 0.3 * Math.sin(s.phase[i])) : (0.85 + 0.15 * Math.sin(s.phase[i]))), pz = s.pos[o + 2] + wz * dt;
        if (isSnow) { px += Math.sin(time * 1.3 + s.phase[i]) * 0.5 * dt; pz += Math.cos(time * 1.1 + s.phase[i] * 1.7) * 0.5 * dt; }
        if (py < by) py += BOX_H; else if (py > by + BOX_H) py -= BOX_H;
        if (px < bx || px >= bx + BOX_W) px = wrap(px, bx, BOX_W);
        if (pz < bz || pz >= bz + BOX_W) pz = wrap(pz, bz, BOX_W);
        s.pos[o] = px; s.pos[o + 1] = py; s.pos[o + 2] = pz;
      }
      s.mat.uniforms.uScale.value = uScale; s.mat.uniforms.uOpacity.value = weather.ramp * (0.6 + 0.4 * weather.intensity);
      flush(s, count);
    }
    function updateWeather(dt) {
      weather.ramp = Math.min(1, weather.ramp + dt);
      var k = weather.intensity;
      var rainN = weather.precip === 'rain' ? Math.round(RAIN_CAP * (weather.kind === 'storm' ? Math.max(0.5, k) : 0.25 + 0.75 * k)) : 0;
      var snowN = weather.precip === 'snow' ? Math.round(SNOW_CAP * (0.3 + 0.7 * k)) : 0;
      if (rainN > 0) updatePrecip(rain, rainN, dt, false); else if (rain.n > 0) flush(rain, 0);
      if (snowN > 0) updatePrecip(snow, snowN, dt, true); else if (snow.n > 0) flush(snow, 0);
      // clouds
      var cloudTarget = weather.kind === 'storm' ? 0.45 + 0.35 * k : (weather.kind === 'rain' ? 0.25 * k : (weather.kind === 'snow' ? 0.18 * k : 0));
      weather.cloudOp += (cloudTarget - weather.cloudOp) * Math.min(1, dt * 1.2);
      cloudMat.opacity = weather.cloudOp;
      var cv = weather.cloudOp > 0.005;
      var dx = wind.x * wind.mph * 0.05 * dt, dz = wind.z * wind.mph * 0.05 * dt;
      for (var i = 0; i < 4; i++) {
        var m = clouds[i]; m.visible = cv; if (!cv) continue;
        cloudOff[i * 2] = wrap(cloudOff[i * 2] + dx, -60, 120); cloudOff[i * 2 + 1] = wrap(cloudOff[i * 2 + 1] + dz, -60, 120);
        m.position.set(focus.x + cloudOff[i * 2], focus.y + 30 + i * 1.6, focus.z + cloudOff[i * 2 + 1]);
      }
      // lightning
      if (weather.kind === 'storm' && k > 0.05) {
        if (weather.flashFrames > 0) {
          weather.flashFrames--;
          if (weather.flashFrames === 0) { flashLight.intensity = 0; weather.flashing = false; fogDirty = true; }
        } else {
          weather.lightningT -= dt;
          if (weather.lightningT <= 0) {
            weather.lightningT = rnd(4, 9); weather.flashFrames = 2; weather.flashing = true;
            flashLight.intensity = 1.2 + 0.8 * k; fogDirty = true;
          }
        }
      } else if (weather.flashing || flashLight.intensity > 0) { flashLight.intensity = 0; weather.flashing = false; weather.flashFrames = 0; fogDirty = true; }
    }

    // ---- fog --------------------------------------------------------------
    var fogCb = null, fogDirty = true;
    var fogState = { color: new THREE.Color(PAL.fog), density: BASE_FOG_DENSITY, skyTint: new THREE.Color(PAL.sky) };
    var fogCur = { color: new THREE.Color(PAL.fog), density: BASE_FOG_DENSITY, sky: new THREE.Color(PAL.sky) };
    var fogTarget = { color: new THREE.Color(PAL.fog), density: BASE_FOG_DENSITY, sky: new THREE.Color(PAL.sky) };
    var FOG_KIND = {
      clear: [PAL.fog, 0, PAL.sky], rain: [0xb8c2cb, 0.004, 0x8fa2b4], storm: [0x7d858e, 0.0075, 0x566068],
      snow: [0xe6ebf0, 0.005, 0xb9c6d2], smoke: [0xa8866a, 0.018, 0xc09a6c], haze: [0xcdbfa6, 0.008, 0xb9b09a]
    };
    function computeFogTarget() {
      var k = weather.intensity, def = FOG_KIND[weather.kind] || FOG_KIND.clear;
      var base = (weather.kind === 'smoke' || weather.kind === 'haze') ? 0.010 : BASE_FOG_DENSITY;
      fogTarget.color.setHex(PAL.fog); tmpC2.setHex(def[0]); fogTarget.color.lerp(tmpC2, k);
      fogTarget.sky.setHex(PAL.sky); tmpC2.setHex(def[2]); fogTarget.sky.lerp(tmpC2, k);
      fogTarget.density = (weather.kind === 'clear' ? BASE_FOG_DENSITY : base) + def[1] * k;
      // active fire adds a little smoke to the air
      var ff = Math.min(1, fire.n / 300) * fire.fade * 0.45;
      if (ff > 0) { tmpC2.setHex(0xa8866a); fogTarget.color.lerp(tmpC2, ff); tmpC2.setHex(0xc09a6c); fogTarget.sky.lerp(tmpC2, ff * 0.6); fogTarget.density += 0.006 * ff; }
    }
    function updateFog(dt) {
      computeFogTarget();
      var r = Math.min(1, dt * 1.4);
      var dc = Math.abs(fogCur.color.r - fogTarget.color.r) + Math.abs(fogCur.color.g - fogTarget.color.g) + Math.abs(fogCur.color.b - fogTarget.color.b);
      var dd = Math.abs(fogCur.density - fogTarget.density), ds = Math.abs(fogCur.sky.r - fogTarget.sky.r) + Math.abs(fogCur.sky.g - fogTarget.sky.g) + Math.abs(fogCur.sky.b - fogTarget.sky.b);
      var moving = dc > 0.002 || dd > 1e-5 || ds > 0.002;
      if (moving) { fogCur.color.lerp(fogTarget.color, r); fogCur.sky.lerp(fogTarget.sky, r); fogCur.density += (fogTarget.density - fogCur.density) * r; }
      else { fogCur.color.copy(fogTarget.color); fogCur.sky.copy(fogTarget.sky); fogCur.density = fogTarget.density; }
      if (!fogCb || !(moving || fogDirty)) return;
      fogDirty = false;
      fogState.color.copy(fogCur.color); fogState.skyTint.copy(fogCur.sky); fogState.density = fogCur.density;
      if (weather.flashing) { tmpC2.setHex(0xf4f7ff); fogState.color.lerp(tmpC2, 0.7); fogState.skyTint.lerp(tmpC2, 0.8); fogState.density *= 0.75; fogDirty = true; }
      try { fogCb(fogState); } catch (e) { if (WS.DEBUG) console.error(e); }
    }
    function onFogChange(fn) { fogCb = (typeof fn === 'function') ? fn : null; fogDirty = true; }

    // =====================================================================
    // DEBRIS
    // =====================================================================
    var debrisMain = makeSystem(DEBRIS_CAP, texDebris, THREE.NormalBlending, false, true, 'debris');
    var debrisTrail = makeSystem(DEBRIS_CAP, texDebris, THREE.NormalBlending, false, true, 'debrisTrail');
    debrisMain.points.renderOrder = 7; debrisTrail.points.renderOrder = 6;
    var mudCol = colObj(0xb98c4a), ashCol = colObj(0x3a322c);
    var debris = {
      A: new Float32Array(DEBRIS_CAP * 3), B: new Float32Array(DEBRIS_CAP * 3), sA: new Float32Array(DEBRIS_CAP), sB: new Float32Array(DEBRIS_CAP),
      nA: 0, nB: 0, elapsed: 0, interval: 0.125, sinceLast: 0, active: false, fade: 0
    };
    function showDebris(frame) {
      if (!frame || !frame.positions) return;
      var pos = frame.positions, cnt = Math.min(fin(frame.count, (pos.length / 3) | 0) | 0, DEBRIS_CAP, (pos.length / 3) | 0);
      if (cnt < 0) cnt = 0;
      // previous B -> A
      debris.A.set(debris.B.subarray(0, debris.nB * 3)); debris.sA.set(debris.sB.subarray(0, debris.nB)); debris.nA = debris.nB;
      for (var k = 0; k < cnt; k++) {
        var o = k * 3, cx = fin(pos[o], 0), cy = fin(pos[o + 1], 0), s = clamp01(fin(pos[o + 2], 0));
        var sx = sceneX(cx), sz = sceneZ(cy);
        debris.B[o] = sx; debris.B[o + 1] = H(sx, sz) + 0.15; debris.B[o + 2] = sz; debris.sB[k] = s;
        var c = k, r = mudCol.r + (ashCol.r - mudCol.r) * s, g = mudCol.g + (ashCol.g - mudCol.g) * s, b = mudCol.b + (ashCol.b - mudCol.b) * s;
        setColor(debrisMain, c, r, g, b); setColor(debrisTrail, c, r * 0.9, g * 0.9, b * 0.9);
        debrisMain.size[c] = 0.8 + 0.6 * s; debrisTrail.size[c] = (0.8 + 0.6 * s) * 0.8;
        debrisMain.alpha[c] = 0.9; debrisTrail.alpha[c] = 0.35; debrisMain.phase[c] = 0; debrisTrail.phase[c] = 0;
      }
      debris.nB = cnt;
      if (debris.nA === 0 || !debris.active) { debris.A.set(debris.B.subarray(0, cnt * 3)); debris.sA.set(debris.sB.subarray(0, cnt)); debris.nA = cnt; }
      debris.interval = debris.active ? C.clamp(debris.sinceLast, 0.04, 0.5) : 0.125;
      debris.sinceLast = 0; debris.elapsed = 0; debris.active = true;
    }
    function clearDebris() { debris.active = false; debris.nA = debris.nB = 0; }
    function updateDebris(dt) {
      var target = debris.active ? 1 : 0;
      debris.fade += (target - debris.fade) * Math.min(1, dt * 4);
      if (debris.fade < 0.01 && !debris.active) { if (debrisMain.n > 0) { flush(debrisMain, 0); flush(debrisTrail, 0); } return; }
      debris.sinceLast += dt; debris.elapsed += dt;
      var t = Math.min(1, debris.elapsed / debris.interval), tt = t * 0.55;
      var n = debris.nB, same = debris.nA === n, A = debris.A, B = debris.B, P = debrisMain.pos, T = debrisTrail.pos;
      for (var k = 0; k < n; k++) {
        var o = k * 3;
        if (same) {
          P[o] = A[o] + (B[o] - A[o]) * t; P[o + 1] = A[o + 1] + (B[o + 1] - A[o + 1]) * t; P[o + 2] = A[o + 2] + (B[o + 2] - A[o + 2]) * t;
          T[o] = A[o] + (B[o] - A[o]) * tt; T[o + 1] = A[o + 1] + (B[o + 1] - A[o + 1]) * tt; T[o + 2] = A[o + 2] + (B[o + 2] - A[o + 2]) * tt;
        } else {
          P[o] = B[o]; P[o + 1] = B[o + 1]; P[o + 2] = B[o + 2];
          var S = k < debris.nA ? A : B; T[o] = S[o]; T[o + 1] = S[o + 1]; T[o + 2] = S[o + 2];
        }
      }
      debrisMain.mat.uniforms.uOpacity.value = debris.fade; debrisTrail.mat.uniforms.uOpacity.value = debris.fade;
      debrisMain.mat.uniforms.uScale.value = uScale; debrisTrail.mat.uniforms.uScale.value = uScale;
      flush(debrisMain, n); flush(debrisTrail, n);
    }

    // =====================================================================
    // OVERLAY (plane + flow network)
    // =====================================================================
    var OV_VERTS = (N + 1) * (N + 1);
    var ovGeo = new THREE.BufferGeometry();
    var ovPos = new Float32Array(OV_VERTS * 3), ovCol = new Float32Array(OV_VERTS * 3), ovAlpha = new Float32Array(OV_VERTS);
    var ovIdx = new Uint16Array(N * N * 6); // (N+1)^2 = 16,641 verts < 65,536
    (function buildOverlayIndex() {
      var k = 0, row = N + 1;
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        var a = y * row + x;
        ovIdx[k++] = a; ovIdx[k++] = a + row; ovIdx[k++] = a + 1;
        ovIdx[k++] = a + 1; ovIdx[k++] = a + row; ovIdx[k++] = a + row + 1;
      }
    })();
    var ovPosAttr = new THREE.BufferAttribute(ovPos, 3), ovColAttr = new THREE.BufferAttribute(ovCol, 3), ovAlphaAttr = new THREE.BufferAttribute(ovAlpha, 1);
    ovColAttr.setUsage(THREE.DynamicDrawUsage); ovAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    ovGeo.setAttribute('position', ovPosAttr); ovGeo.setAttribute('aColor', ovColAttr); ovGeo.setAttribute('aAlpha', ovAlphaAttr);
    ovGeo.setIndex(new THREE.BufferAttribute(ovIdx, 1));
    var ovMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } }, vertexShader: OV_VS, fragmentShader: OV_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    var ovMesh = new THREE.Mesh(ovGeo, ovMat); ovMesh.frustumCulled = false; ovMesh.visible = false; ovMesh.renderOrder = 2; ovMesh.name = 'overlay';
    rootGroup.add(ovMesh); disposables.push(ovGeo, ovMat);
    var overlay = { mode: 'none', opacity: 0, world: null, heightsReal: false, cellRGBA: new Float32Array(N * N * 4) };

    function buildOverlayHeights() {
      var k = 0;
      for (var vy = 0; vy <= N; vy++) for (var vx = 0; vx <= N; vx++) {
        var sx = vx - N / 2, sz = vy - N / 2;
        ovPos[k++] = sx; ovPos[k++] = H(sx, sz) + 0.06; ovPos[k++] = sz;
      }
      ovPosAttr.needsUpdate = true; overlay.heightsReal = hasRealHeights();
    }
    function ensureOverlayGeom(w) {
      if (w !== overlay.world || (!overlay.heightsReal && hasRealHeights())) { overlay.world = w; buildOverlayHeights(); }
    }
    // colour ramps (linear space)
    var RAMP = {
      fire: [colObj(0x3fa34d), colObj(0xe8d34a), colObj(0xd8352b)],
      moist: [colObj(0x8a6a3a), colObj(0x5f8fb8), colObj(0x2f7fd0)],
      burn: [colObj(0xf08a2a), colObj(0xf08a2a), colObj(0x121010)],
      upstream: colObj(0x4f8fd8)
    };
    function ramp3(c, t, out, o) {
      var a, b, u;
      if (t < 0.5) { a = c[0]; b = c[1]; u = t * 2; } else { a = c[1]; b = c[2]; u = (t - 0.5) * 2; }
      out[o] = a.r + (b.r - a.r) * u; out[o + 1] = a.g + (b.g - a.g) * u; out[o + 2] = a.b + (b.b - a.b) * u;
    }
    function computeOverlayColors(mode, w) {
      var rgba = overlay.cellRGBA, NN = N * N, i, o;
      var land = w.land, fuel = w.fuel, moist = w.moisture, burn = w.burn;
      var LR = C.LAND.RIVER, LRES = C.LAND.RESERVOIR;
      for (i = 0; i < NN; i++) {
        o = i * 4; rgba[o] = rgba[o + 1] = rgba[o + 2] = 0; rgba[o + 3] = 0;
        var isWater = land && (land[i] === LR || land[i] === LRES);
        if (mode === 'watershed') {
          var up = false; try { up = !!(w.isUpstreamOfReservoir && w.isUpstreamOfReservoir(i)); } catch (e) { up = false; }
          if (up) { rgba[o] = RAMP.upstream.r; rgba[o + 1] = RAMP.upstream.g; rgba[o + 2] = RAMP.upstream.b; rgba[o + 3] = 0.3; }
        } else if (mode === 'fire') {
          var f = fuel ? fin(fuel[i], 0) : 0; if (f <= 0.001 || isWater) continue;
          var v = clamp01(f * (1 - (moist ? clamp01(fin(moist[i], 0.5)) : 0.5)));
          ramp3(RAMP.fire, clamp01(v * 1.6), rgba, o); rgba[o + 3] = 0.55;
        } else if (mode === 'moisture') {
          if (isWater) continue;
          ramp3(RAMP.moist, moist ? clamp01(fin(moist[i], 0.5)) : 0.5, rgba, o); rgba[o + 3] = 0.5;
        } else if (mode === 'burn') {
          var bv = burn ? clamp01(fin(burn[i], 0)) : 0; if (bv <= 0.02) continue;
          ramp3(RAMP.burn, bv, rgba, o); rgba[o + 3] = Math.min(1, bv * 1.6) * 0.75;
        }
      }
      // vertex = average of adjacent cells
      var k = 0;
      for (var vy = 0; vy <= N; vy++) {
        var y0 = vy > 0 ? vy - 1 : 0, y1 = vy < N ? vy : N - 1;
        for (var vx = 0; vx <= N; vx++) {
          var x0 = vx > 0 ? vx - 1 : 0, x1 = vx < N ? vx : N - 1;
          var a = (y0 * N + x0) * 4, b = (y0 * N + x1) * 4, c = (y1 * N + x0) * 4, d = (y1 * N + x1) * 4;
          var al = (rgba[a + 3] + rgba[b + 3] + rgba[c + 3] + rgba[d + 3]);
          if (al > 0) {
            // alpha-weighted colour average so transparent cells don't darken edges
            ovCol[k * 3] = (rgba[a] * rgba[a + 3] + rgba[b] * rgba[b + 3] + rgba[c] * rgba[c + 3] + rgba[d] * rgba[d + 3]) / al;
            ovCol[k * 3 + 1] = (rgba[a + 1] * rgba[a + 3] + rgba[b + 1] * rgba[b + 3] + rgba[c + 1] * rgba[c + 3] + rgba[d + 1] * rgba[d + 3]) / al;
            ovCol[k * 3 + 2] = (rgba[a + 2] * rgba[a + 3] + rgba[b + 2] * rgba[b + 3] + rgba[c + 2] * rgba[c + 3] + rgba[d + 2] * rgba[d + 3]) / al;
          } else { ovCol[k * 3] = ovCol[k * 3 + 1] = ovCol[k * 3 + 2] = 0; }
          ovAlpha[k] = al * 0.25; k++;
        }
      }
      ovColAttr.needsUpdate = true; ovAlphaAttr.needsUpdate = true;
    }

    // flow network lines
    var lines = { world: null, mesh: null, geo: null, mat: null, segCount: 0, a: null, b: null, dist: new Float32Array(N * N), stack: new Int32Array(N * N) };
    var lineMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } }, vertexShader: LINE_VS, fragmentShader: LINE_FS,
      transparent: true, depthWrite: false
    });
    disposables.push(lineMat);
    var waterLine = colObj(0x5fb8ff), brownLine = colObj(0x8a5a2a), blackLine = colObj(0x1a1512);
    function computeFlowDistance(w) {
      var fd = w.flowDir, dist = lines.dist, stack = lines.stack, NN = N * N;
      dist.fill(-1);
      for (var i = 0; i < NN; i++) {
        if (dist[i] >= 0) continue;
        var sp = 0, c = i, guard = 0;
        while (c >= 0 && c < NN && dist[c] < 0 && guard++ < NN) {
          if (dist[c] === -2) break; // cycle
          dist[c] = -2; stack[sp++] = c; c = fd[c];
        }
        var base = (c >= 0 && c < NN && dist[c] >= 0) ? dist[c] : 0, prev = (c >= 0 && c < NN && dist[c] >= 0) ? c : -1;
        while (sp > 0) {
          var cell = stack[--sp], len = 1;
          if (prev >= 0) { var dx = (cell % N) - (prev % N), dy = ((cell / N) | 0) - ((prev / N) | 0); len = (dx !== 0 && dy !== 0) ? Math.SQRT2 : 1; }
          base += len; dist[cell] = base; prev = cell;
        }
      }
    }
    function buildLines(w) {
      if (lines.mesh) { rootGroup.remove(lines.mesh); lines.geo.dispose(); lines.mesh = null; lines.geo = null; }
      lines.world = w; lines.segCount = 0;
      if (!w || !w.flowDir || !w.flowAcc) return;
      var fd = w.flowDir, fa = w.flowAcc, NN = N * N, cnt = 0, i;
      for (i = 0; i < NN; i++) if (fa[i] > 8 && fd[i] >= 0 && fd[i] < NN) cnt++;
      if (cnt === 0) return;
      computeFlowDistance(w);
      var pos = new Float32Array(cnt * 6), dst = new Float32Array(cnt * 2), colr = new Float32Array(cnt * 6);
      var a = new Int32Array(cnt), b = new Int32Array(cnt), k = 0;
      for (i = 0; i < NN; i++) {
        if (!(fa[i] > 8 && fd[i] >= 0 && fd[i] < NN)) continue;
        var j = fd[i], x0 = i % N, y0 = (i / N) | 0, x1 = j % N, y1 = (j / N) | 0;
        var o = k * 6;
        pos[o] = sceneX(x0); pos[o + 1] = cellH(x0, y0) + 0.12; pos[o + 2] = sceneZ(y0);
        pos[o + 3] = sceneX(x1); pos[o + 4] = cellH(x1, y1) + 0.12; pos[o + 5] = sceneZ(y1);
        dst[k * 2] = lines.dist[i]; dst[k * 2 + 1] = lines.dist[j];
        a[k] = i; b[k] = j; k++;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aDist', new THREE.BufferAttribute(dst, 1));
      lines.colAttr = new THREE.BufferAttribute(colr, 3); lines.colAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aColor', lines.colAttr);
      lines.geo = geo; lines.a = a; lines.b = b; lines.segCount = cnt; lines.col = colr;
      lines.mesh = new THREE.LineSegments(geo, lineMat); lines.mesh.frustumCulled = false; lines.mesh.renderOrder = 3; lines.mesh.visible = false;
      rootGroup.add(lines.mesh);
    }
    function colorLines(w) {
      if (!lines.mesh) return;
      var fa = w.flowAcc, burn = w.burn, maxAcc = 1, i;
      for (i = 0; i < lines.segCount; i++) if (fa[lines.a[i]] > maxAcc) maxAcc = fa[lines.a[i]];
      var lm = Math.log(maxAcc + 1), colr = lines.col;
      for (i = 0; i < lines.segCount; i++) {
        var ia = lines.a[i], ib = lines.b[i], br = Math.max(burn ? fin(burn[ia], 0) : 0, burn ? fin(burn[ib], 0) : 0);
        var bright = 0.35 + 0.65 * clamp01(Math.log(fa[ia] + 1) / lm);
        var o = i * 6, r, g, b;
        if (br > 0.3) {
          var t = clamp01((br - 0.3) / 0.7);
          r = brownLine.r + (blackLine.r - brownLine.r) * t; g = brownLine.g + (blackLine.g - brownLine.g) * t; b = brownLine.b + (blackLine.b - brownLine.b) * t;
          bright = Math.max(bright, 0.8);
        } else { r = waterLine.r; g = waterLine.g; b = waterLine.b; }
        colr[o] = colr[o + 3] = r * bright; colr[o + 1] = colr[o + 4] = g * bright; colr[o + 2] = colr[o + 5] = b * bright;
      }
      lines.colAttr.needsUpdate = true;
    }
    function setOverlay(mode, w, state) {
      void state;
      mode = (typeof mode === 'string') ? mode : 'none';
      if (['none', 'watershed', 'fire', 'moisture', 'burn'].indexOf(mode) < 0) mode = 'none';
      if (w) curWorld = w; w = curWorld;
      overlay.mode = mode;
      if (mode === 'none' || !w) { if (lines.mesh) lines.mesh.visible = false; overlay.showLines = false; return; }
      ensureOverlayGeom(w);
      computeOverlayColors(mode, w);
      ovMesh.visible = true;
      if (mode === 'watershed') {
        if (lines.world !== w || !lines.mesh) buildLines(w);
        colorLines(w);
        if (lines.mesh) lines.mesh.visible = true;
        overlay.showLines = true;
      } else { if (lines.mesh) lines.mesh.visible = false; overlay.showLines = false; }
    }
    function updateOverlay(dt) {
      var target = overlay.mode === 'none' ? 0 : 1;
      overlay.opacity += (target - overlay.opacity) * Math.min(1, dt * 5);
      if (overlay.opacity < 0.01 && target === 0) { overlay.opacity = 0; ovMesh.visible = false; if (lines.mesh) lines.mesh.visible = false; }
      ovMat.uniforms.uOpacity.value = overlay.opacity;
      lineMat.uniforms.uTime.value = time; lineMat.uniforms.uOpacity.value = overlay.showLines ? overlay.opacity : 0;
    }

    // =====================================================================
    // HIGHLIGHT
    // =====================================================================
    var hlGeo = new THREE.PlaneGeometry(0.92, 0.92); hlGeo.rotateX(-Math.PI / 2);
    var hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    var hlMesh = new THREE.InstancedMesh(hlGeo, hlMat, HILITE_CAP); hlMesh.count = 0; hlMesh.visible = false; hlMesh.frustumCulled = false; hlMesh.renderOrder = 4;
    hlMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); rootGroup.add(hlMesh); disposables.push(hlGeo, hlMat);
    var hl = { n: 0 };
    function placeFlat(mat, x, y, lift, scale) {
      var sx = sceneX(x), sz = sceneZ(y), h = H(sx, sz);
      var dx = H(sx + 0.5, sz) - H(sx - 0.5, sz), dz = H(sx, sz + 0.5) - H(sx, sz - 0.5);
      tmpV2.set(-dx, 1, -dz).normalize(); tmpQ.setFromUnitVectors(UP, tmpV2);
      tmpV.set(sx, h + lift, sz); tmpS.set(scale, scale, scale);
      mat.compose(tmpV, tmpQ, tmpS);
    }
    function setHighlight(indices, colorHex) {
      if (!indices || !indices.length) { hl.n = 0; hlMesh.count = 0; hlMesh.visible = false; return; }
      var n = Math.min(indices.length, HILITE_CAP), k = 0;
      for (var c = 0; c < n; c++) {
        var i = indices[c] | 0; if (i < 0 || i >= N * N) continue;
        placeFlat(tmpM, i % N, (i / N) | 0, 0.1, 1); hlMesh.setMatrixAt(k++, tmpM);
      }
      hl.n = k; hlMesh.count = k; hlMesh.visible = k > 0; hlMesh.instanceMatrix.needsUpdate = true;
      hlMat.color.setHex(fin(colorHex, 0xffd24a)); if (srgb) hlMat.color.convertSRGBToLinear();
    }
    function updateHighlight() { if (hl.n > 0) hlMat.opacity = 0.3 + 0.18 * Math.sin(time * 4); }

    // =====================================================================
    // MARKERS + PLACEMENT CURSOR
    // =====================================================================
    var geoCache = {}, matCache = {}, ghostCache = {}, basicCache = {};
    function G(key, make) { if (!geoCache[key]) { geoCache[key] = make(); disposables.push(geoCache[key]); } return geoCache[key]; }
    function Mlit(hex) { if (!matCache[hex]) { matCache[hex] = new THREE.MeshLambertMaterial({ color: colObj(hex) }); disposables.push(matCache[hex]); } return matCache[hex]; }
    function Mbasic(hex) { if (!basicCache[hex]) { basicCache[hex] = new THREE.MeshBasicMaterial({ color: colObj(hex) }); disposables.push(basicCache[hex]); } return basicCache[hex]; }
    function Mghost(hex) {
      if (!ghostCache[hex]) { ghostCache[hex] = new THREE.MeshBasicMaterial({ color: colObj(hex), transparent: true, opacity: 0.45, depthWrite: false }); disposables.push(ghostCache[hex]); }
      return ghostCache[hex];
    }
    function mesh(geo, mat, x, y, z, rx, ry, rz) {
      var m = new THREE.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0);
      if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
      return m;
    }
    var BUILDERS = {
      mulch: function (M) {
        var g = new THREE.Group(); g.add(mesh(G('disc', function () { return new THREE.CylinderGeometry(0.42, 0.42, 0.06, 14); }), M(0xd9b85a), 0, 0.03, 0)); return g;
      },
      barrier: function (M) {
        var g = new THREE.Group(), lg = G('log', function () { return new THREE.CylinderGeometry(0.06, 0.06, 0.62, 6); });
        g.add(mesh(lg, M(0x6b4a2b), 0, 0.07, -0.13, 0, 0, Math.PI / 2));
        g.add(mesh(lg, M(0x6b4a2b), 0, 0.07, 0.13, 0, 0, Math.PI / 2));
        g.add(mesh(lg, M(0x7a5533), 0, 0.18, 0, 0, 0, Math.PI / 2));
        return g;
      },
      debris_basin: function (M) {
        var g = new THREE.Group(); g.add(mesh(G('ring', function () { return new THREE.TorusGeometry(0.38, 0.07, 6, 18); }), M(0x8d8d8d), 0, 0.05, 0, Math.PI / 2)); return g;
      },
      bank_stab: function (M) {
        var g = new THREE.Group(), st = G('stone', function () { return new THREE.BoxGeometry(0.2, 0.14, 0.18); });
        for (var i = 0; i < 4; i++) g.add(mesh(st, M(i % 2 ? 0x9a9590 : 0x7f7a74), (i - 1.5) * 0.22, 0.07, (i % 2) * 0.06 - 0.03, 0, (i * 0.7) % 1, 0));
        return g;
      },
      intake_protect: function (M) {
        var g = new THREE.Group(), bx = G('boom', function () { return new THREE.BoxGeometry(0.17, 0.12, 0.17); });
        for (var i = 0; i < 8; i++) { var a = i / 8 * TAU; g.add(mesh(bx, M(0x2f7fd0), Math.cos(a) * 0.42, 0.05, Math.sin(a) * 0.42, 0, -a, 0)); }
        return g;
      },
      sensor: function (M, B) {
        var g = new THREE.Group(); g.add(mesh(G('post', function () { return new THREE.BoxGeometry(0.08, 0.7, 0.08); }), M(0xf2f2f2), 0, 0.35, 0));
        var light = mesh(G('bulb', function () { return new THREE.SphereGeometry(0.07, 8, 6); }), B(0x3cff6a), 0, 0.76, 0); light.name = 'light'; g.add(light);
        return g;
      },
      warning: function (M, B) {
        var g = new THREE.Group(); g.add(mesh(G('pole', function () { return new THREE.BoxGeometry(0.07, 0.95, 0.07); }), M(0x8d8d8d), 0, 0.47, 0));
        var top = mesh(G('siren', function () { return new THREE.BoxGeometry(0.2, 0.16, 0.2); }), M(0xe03030), 0, 1.0, 0); g.add(top);
        var light = mesh(G('bulb', function () { return new THREE.SphereGeometry(0.07, 8, 6); }), B(0xff5a4a), 0, 1.13, 0); light.name = 'light'; g.add(light);
        return g;
      },
      pin: function (M) {
        var g = new THREE.Group(); g.add(mesh(G('pinCone', function () { return new THREE.ConeGeometry(0.15, 0.5, 8); }), M(0xe0453a), 0, 0.25, 0, Math.PI, 0, 0));
        g.add(mesh(G('pinHead', function () { return new THREE.SphereGeometry(0.18, 10, 8); }), M(0xe0453a), 0, 0.55, 0)); g.userData.float = true;
        return g;
      },
      fireStart: function (M, B) {
        var g = new THREE.Group(); g.add(mesh(G('fireRing', function () { return new THREE.TorusGeometry(0.36, 0.05, 6, 20); }), B(0xff3a1a), 0, 0.08, 0, Math.PI / 2));
        g.add(mesh(G('fireCore', function () { return new THREE.SphereGeometry(0.12, 8, 6); }), B(0xffb03a), 0, 0.2, 0));
        return g;
      }
    };
    var markerGroup = new THREE.Group(); markerGroup.name = 'markers'; rootGroup.add(markerGroup);
    var markers = {}, markerList = [], pool = {};
    function buildMarker(type, ghost) {
      var b = BUILDERS[type] || BUILDERS.pin;
      var g = ghost ? b(Mghost, Mghost) : b(Mlit, Mbasic);
      g.userData.type = type; g.userData.phase = rnd(0, TAU); g.userData.light = g.getObjectByName('light');
      return g;
    }
    function addMarker(id, type, x, y) {
      if (id == null) return;
      if (markers[id]) removeMarker(id);
      type = BUILDERS[type] ? type : 'pin';
      x = C.clamp(fin(x, 0) | 0, 0, N - 1); y = C.clamp(fin(y, 0) | 0, 0, N - 1);
      var p = pool[type], m = (p && p.length) ? p.pop() : buildMarker(type, false);
      m.position.set(sceneX(x), cellH(x, y), sceneZ(y)); m.userData.baseY = m.position.y; m.userData.id = id; m.visible = true;
      markerGroup.add(m); markers[id] = m; markerList.push(m);
    }
    function removeMarker(id) {
      var m = markers[id]; if (!m) return;
      delete markers[id]; markerGroup.remove(m);
      var ix = markerList.indexOf(m); if (ix >= 0) markerList.splice(ix, 1);
      (pool[m.userData.type] = pool[m.userData.type] || []).push(m);
    }
    function clearMarkers() { var ids = Object.keys(markers); for (var i = 0; i < ids.length; i++) removeMarker(ids[i]); }
    function animateMarker(m, dt) {
      var t = m.userData.type, ph = m.userData.phase;
      if (t === 'sensor') { if (m.userData.light) m.userData.light.visible = ((time + ph) % 1.4) < 0.3; }
      else if (t === 'warning') { if (m.userData.light) m.userData.light.visible = ((time + ph) % 2.0) < 0.5; }
      else if (t === 'fireStart') { var s = 1 + 0.25 * Math.sin(time * 6 + ph); m.scale.set(s, 1, s); m.rotation.y += dt * 1.5; }
      else if (t === 'pin') { m.position.y = m.userData.baseY + 0.7 + 0.12 * Math.sin(time * 2.5 + ph); m.rotation.y = time * 0.8 + ph; }
      else if (t === 'intake_protect') { m.position.y = m.userData.baseY + 0.03 * Math.sin(time * 2 + ph); }
    }
    function updateMarkers(dt) { for (var i = 0; i < markerList.length; i++) animateMarker(markerList[i], dt); if (cursor.visible && cursor.ghost) animateMarker(cursor.ghost, dt); }

    var cursor = new THREE.Group(); cursor.name = 'placementCursor'; cursor.visible = false; rootGroup.add(cursor);
    var cursorSquare = new THREE.Mesh(G('cursorSq', function () { var g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); return g; }),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }));
    disposables.push(cursorSquare.material); cursorSquare.position.y = 0.08; cursor.add(cursorSquare);
    var ghosts = {}; cursor.ghost = null;
    function setPlacementCursor(type, x, y) {
      if (!type) { cursor.visible = false; return; }
      type = BUILDERS[type] ? type : 'pin';
      if (!ghosts[type]) { ghosts[type] = buildMarker(type, true); cursor.add(ghosts[type]); }
      for (var k in ghosts) ghosts[k].visible = (k === type);
      cursor.ghost = ghosts[type];
      x = C.clamp(fin(x, 0) | 0, 0, N - 1); y = C.clamp(fin(y, 0) | 0, 0, N - 1);
      cursor.position.set(sceneX(x), cellH(x, y), sceneZ(y)); cursor.ghost.userData.baseY = 0; cursor.visible = true;
    }

    // =====================================================================
    // UPDATE / DISPOSE
    // =====================================================================
    var tmpDir = new THREE.Vector3();
    function computeFocus(camera) {
      if (!camera || !camera.position) { focus.set(0, H(0, 0), 0); return; }
      camera.getWorldDirection(tmpDir);
      var gy = H(camera.position.x, camera.position.z);
      var t = tmpDir.y < -0.05 ? (camera.position.y - gy) / (-tmpDir.y) : 60;
      t = C.clamp(fin(t, 40), 5, 150);
      var fx = C.clamp(camera.position.x + tmpDir.x * t, -N / 2 - 10, N / 2 + 10), fz = C.clamp(camera.position.z + tmpDir.z * t, -N / 2 - 10, N / 2 + 10);
      focus.set(fx, H(fx, fz), fz);
    }
    function update(dt, camera) {
      dt = fin(dt, 0.016); if (dt <= 0) dt = 0.016; if (dt > 0.1) dt = 0.1;
      time += dt;
      var rr = opts.renderer;
      uScale = (rr && rr.domElement && rr.domElement.height) ? rr.domElement.height * 0.5 : 400;
      computeFocus(camera || opts.camera);
      updateFire(dt);
      updateWeather(dt);
      updateFog(dt);
      updateDebris(dt);
      updateOverlay(dt);
      updateHighlight();
      updateMarkers(dt);
    }
    function disposeObj(o) {
      if (!o) return;
      if (o.geometry && disposables.indexOf(o.geometry) < 0) o.geometry.dispose();
      if (o.material && disposables.indexOf(o.material) < 0) o.material.dispose();
    }
    function dispose() {
      clearMarkers();
      scene.remove(rootGroup);
      rootGroup.traverse(disposeObj);
      for (var k in pool) for (var i = 0; i < pool[k].length; i++) pool[k][i].traverse(disposeObj);
      if (lines.geo) lines.geo.dispose();
      for (i = 0; i < disposables.length; i++) { try { disposables[i].dispose(); } catch (e) { /* ignore */ } }
      disposables.length = 0; fogCb = null; markerList.length = 0; pool = {}; ghosts = {};
    }

    if (curWorld) { try { ensureOverlayGeom(curWorld); } catch (e) { if (WS.DEBUG) console.error(e); } }

    var fx = {
      update: update, setFire: setFire, setWind: setWind, setWeather: setWeather, onFogChange: onFogChange,
      showDebris: showDebris, clearDebris: clearDebris, setOverlay: setOverlay, setHighlight: setHighlight,
      addMarker: addMarker, removeMarker: removeMarker, clearMarkers: clearMarkers, setPlacementCursor: setPlacementCursor, dispose: dispose,
      group: rootGroup, wind: wind,
      // read-only stats for dev pages
      stats: function () { return { flames: flames.n, embers: embers.n, smoke: smoke.n, rain: rain.n, snow: snow.n, debris: debrisMain.n, lines: lines.segCount, markers: markerList.length, highlight: hl.n, fireCells: fire.n, fog: fogCur.density }; }
    };
    setWind(wind.dir, wind.mph);
    return fx;
  }

  WS.Effects = { init: init, CAPS: { FLAME_CAP: FLAME_CAP, EMBER_CAP: EMBER_CAP, SMOKE_CAP: SMOKE_CAP, RAIN_CAP: RAIN_CAP, SNOW_CAP: SNOW_CAP, DEBRIS_CAP: DEBRIS_CAP, HILITE_CAP: HILITE_CAP } };
})();
