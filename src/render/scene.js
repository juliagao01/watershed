/* Watershed — src/render/scene.js — export WS.Scene
   WS.Scene.init(containerEl, world) -> ctx
   Owns: WebGLRenderer, camera, sky dome, FogExp2, sun/hemi/ambient lights (season + time of day),
   drifting cloud shadows, custom orbit/pan controls (mouse, keyboard, touch, inertia), RAF loop.
   Three.js r128 UMD (`THREE`). No OrbitControls dependency. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};

  var DEG = Math.PI / 180;
  var MAP_HALF = 64;                       // map spans ±64 scene units (128 cells)
  var PICK_B = 63.99;                      // clamp for heightAt sampling
  var PITCH_MIN = 22 * DEG, PITCH_MAX = 80 * DEG;
  var DIST_MIN = 12, DIST_MAX = 220;
  var SUN_DIST = 220;
  var Y_MIN = -8, Y_MAX = 36;              // terrain height range in scene units (elev 1500..~3750 m)
  var CAM_FOV = 45;

  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function nowMs() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }

  /* ---------- season lighting presets (sRGB hex) ---------- */
  var SEASONS = [
    { name: 'winter', maxElev: 40, tod: 0.25, sun: 0xe9eefb, sunI: 1.25, hemiSky: 0xb9cbe8, hemiGround: 0x8f8b86, hemiI: 0.55,
      amb: 0x556074, ambI: 0.30, fog: 0xdde5ee, fogD: 0.0032, skyTop: 0x8db6dd, skyLow: 0xe6ebf0, exposure: 1.02 },
    { name: 'spring', maxElev: 60, tod: 0.36, sun: 0xfff3df, sunI: 1.40, hemiSky: 0xb8c8ff, hemiGround: 0x7f8a5a, hemiI: 0.50,
      amb: 0x4a5060, ambI: 0.25, fog: 0xd9e3ec, fogD: 0.0028, skyTop: 0x9fc7e8, skyLow: 0xf3e6cf, exposure: 1.05 },
    { name: 'summer', maxElev: 72, tod: 0.42, sun: 0xfff0cc, sunI: 1.55, hemiSky: 0xb0c6f5, hemiGround: 0x9a8a5a, hemiI: 0.48,
      amb: 0x4a5060, ambI: 0.22, fog: 0xdfe4e6, fogD: 0.0026, skyTop: 0x8fbfe8, skyLow: 0xf0e2c8, exposure: 1.08 },
    { name: 'fall', maxElev: 48, tod: 0.30, sun: 0xffd59c, sunI: 1.35, hemiSky: 0xb8c4e6, hemiGround: 0x9c7f4e, hemiI: 0.50,
      amb: 0x504c5a, ambI: 0.25, fog: 0xe2ddd0, fogD: 0.0030, skyTop: 0x9cc0e0, skyLow: 0xf4e0c0, exposure: 1.05 }
  ];
  var SMOKE = { fog: 0xc7a58b, sun: 0xff9a55, skyTop: 0xb9a89a, skyLow: 0xd9b08a, hemiSky: 0xc9b39c };
  var BLEACH = { fog: 0xe9e4d6, hemiGround: 0xc4b48a, sun: 0xfff8ea };

  function droughtAmount(d) {
    if (typeof d === 'number') return clamp(num(d, 0), 0, 1);
    switch (d) { case 'D1': return 0.15; case 'D2': return 0.4; case 'D3': return 0.7; case 'D4': return 1; }
    return 0;
  }
  function smokeAmount(climate) {
    if (!climate) return 0;
    var s = climate.smoke; if (s === true) s = 0.7; s = num(s, 0);
    var h = climate.haze; if (h === true) h = 0.4; h = num(h, 0);
    if (climate.weather === 'smoke') s = Math.max(s, 0.7);
    if (climate.weather === 'haze') h = Math.max(h, 0.4);
    return clamp(Math.max(s, h), 0, 1);
  }

  /* ---------- sky dome shader ---------- */
  var SKY_VS = [
    'varying vec3 vWorldPosition;',
    'void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vWorldPosition = wp.xyz - cameraPosition;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
  ].join('\n');
  var SKY_FS = [
    'uniform vec3 topColor; uniform vec3 bottomColor; uniform float exponent;',
    'varying vec3 vWorldPosition;',
    'void main(){ float h = normalize(vWorldPosition).y; float t = pow(max(h + 0.02, 0.0), exponent);',
    '  gl_FragColor = vec4(mix(bottomColor, topColor, clamp(t, 0.0, 1.0)), 1.0); }'
  ].join('\n');

  /* ---------- tileable cloud alpha texture ---------- */
  function makeCloudTexture(size) {
    var canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    var g = canvas.getContext('2d'); if (!g) return null;
    var img = g.createImageData(size, size), data = img.data;
    var noise = WS.Noise ? WS.Noise.create('clouds') : null;
    var F = 5.0;
    for (var y = 0; y < size; y++) {
      var v = y / size;
      for (var x = 0; x < size; x++) {
        var u = x / size, n = 0;
        if (noise) { // blend 4 shifted samples so the texture tiles seamlessly
          var a = noise.fbm(u * F, v * F, 4), b = noise.fbm((u - 1) * F, v * F, 4);
          var c = noise.fbm(u * F, (v - 1) * F, 4), d = noise.fbm((u - 1) * F, (v - 1) * F, 4);
          n = (a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v) * 0.5 + 0.5;
        }
        var t = clamp((n - 0.56) / 0.10, 0, 1); t = t * t * (3 - 2 * t);
        var k = (y * size + x) * 4, val = Math.round(t * 255);
        data[k] = val; data[k + 1] = val; data[k + 2] = val; data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /* ---------- controls ---------- */
  function makeControls(ctx) {
    var camera = ctx.camera, dom = ctx.renderer.domElement;
    var target = new THREE.Vector3(2.5, 6, 4.5);
    var st = {
      target: target, az: 45 * DEG, pitch: 48 * DEG, dist: 110, enabled: true,
      heightAt: null, pickMesh: null,
      vPanX: 0, vPanZ: 0, vAz: 0, vPitch: 0, zoomAccum: 0,
      anchor: new THREE.Vector3(), anchorValid: false,
      mode: 0, lastX: 0, lastY: 0, lastT: 0, lastMoveT: 0, capturedId: -1,
      ptr: [{ id: -1, x: 0, y: 0 }, { id: -1, x: 0, y: 0 }], nptr: 0,
      pinchDist: 0, pinchAng: 0, midX: 0, midY: 0,
      keys: { w: false, a: false, s: false, d: false, q: false, e: false },
      anim: { active: false, t: 0, dur: 1, from: new THREE.Vector3(), to: new THREE.Vector3(), fromDist: 0, toDist: 0 }
    };
    var raycaster = new THREE.Raycaster();
    var ndc = new THREE.Vector2();
    var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    var tanHalfFov = Math.tan(CAM_FOV * 0.5 * DEG);

    function heightClamped(x, z) {
      var h = st.heightAt(clamp(x, -PICK_B, PICK_B), clamp(z, -PICK_B, PICK_B));
      return isFinite(h) ? h : 0;
    }

    /* ray-march the heightfield (cheap; no triangle raycast) */
    function march(ray, out) {
      var o = ray.origin, d = ray.direction, t0 = 0, t1 = 4000, ta, tb, tmp;
      if (Math.abs(d.x) < 1e-9) { if (o.x < -MAP_HALF || o.x > MAP_HALF) return null; }
      else { ta = (-MAP_HALF - o.x) / d.x; tb = (MAP_HALF - o.x) / d.x; if (ta > tb) { tmp = ta; ta = tb; tb = tmp; } if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; }
      if (Math.abs(d.z) < 1e-9) { if (o.z < -MAP_HALF || o.z > MAP_HALF) return null; }
      else { ta = (-MAP_HALF - o.z) / d.z; tb = (MAP_HALF - o.z) / d.z; if (ta > tb) { tmp = ta; ta = tb; tb = tmp; } if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; }
      if (Math.abs(d.y) < 1e-9) { if (o.y < Y_MIN || o.y > Y_MAX) return null; }
      else { ta = (Y_MIN - o.y) / d.y; tb = (Y_MAX - o.y) / d.y; if (ta > tb) { tmp = ta; ta = tb; tb = tmp; } if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; }
      if (t1 < t0) return null;
      var t = t0, prev = t0, iter = 0;
      var f = (o.y + d.y * t) - heightClamped(o.x + d.x * t, o.z + d.z * t);
      if (f < 0) { out.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t); return out; }
      while (t < t1 && iter++ < 700) {
        prev = t; t += clamp(f * 0.6, 0.3, 5); if (t > t1) t = t1;
        f = (o.y + d.y * t) - heightClamped(o.x + d.x * t, o.z + d.z * t);
        if (f < 0) {
          var lo = prev, hi = t;
          for (var k = 0; k < 12; k++) {
            var mid = (lo + hi) * 0.5;
            var fm = (o.y + d.y * mid) - heightClamped(o.x + d.x * mid, o.z + d.z * mid);
            if (fm < 0) hi = mid; else lo = mid;
          }
          t = (lo + hi) * 0.5;
          out.set(o.x + d.x * t, heightClamped(o.x + d.x * t, o.z + d.z * t), o.z + d.z * t);
          return out;
        }
      }
      return null;
    }

    /* pick terrain point under client coords into `out` (Vector3). Returns out or null. */
    function pickAt(clientX, clientY, mesh, out) {
      var rect = dom.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return null;
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      camera.updateMatrixWorld(); // picks must be correct right after focus()/setView(), before the next render
      raycaster.setFromCamera(ndc, camera);
      if (st.heightAt) return march(raycaster.ray, out);
      if (mesh) {
        var hits = raycaster.intersectObject(mesh, false);
        if (hits.length) { out.copy(hits[0].point); return out; }
        return null;
      }
      groundPlane.constant = -target.y;
      return raycaster.ray.intersectPlane(groundPlane, out) ? out : null;
    }

    function fwdX() { return -Math.sin(st.az); }
    function fwdZ() { return -Math.cos(st.az); }
    function rightX() { return Math.cos(st.az); }
    function rightZ() { return -Math.sin(st.az); }
    function unitsPerPx() { return 2 * st.dist * tanHalfFov / Math.max(1, ctx._h); }

    function cancelMotion() {
      st.vPanX = st.vPanZ = st.vAz = st.vPitch = 0; st.zoomAccum = 0; st.anim.active = false;
    }
    function panBy(dx, dy, dt) {
      var k = unitsPerPx(), mx = -dx * k, mz = dy * k / Math.max(Math.sin(st.pitch), 0.35);
      var wx = rightX() * mx + fwdX() * mz, wz = rightZ() * mx + fwdZ() * mz;
      target.x += wx; target.z += wz;
      if (dt > 0) {
        st.vPanX = lerp(st.vPanX, wx / dt, 0.5); st.vPanZ = lerp(st.vPanZ, wz / dt, 0.5);
        var vmax = st.dist * 2.5, vm = Math.sqrt(st.vPanX * st.vPanX + st.vPanZ * st.vPanZ); // cap flings (1 ms samples spike)
        if (vm > vmax) { st.vPanX *= vmax / vm; st.vPanZ *= vmax / vm; }
      }
    }
    function orbitBy(dx, dy, dt) {
      var dAz = -dx * 0.005, dP = -dy * 0.005;
      st.az += dAz; st.pitch = clamp(st.pitch + dP, PITCH_MIN, PITCH_MAX);
      if (dt > 0) { st.vAz = clamp(lerp(st.vAz, dAz / dt, 0.5), -4, 4); st.vPitch = clamp(lerp(st.vPitch, dP / dt, 0.5), -3, 3); }
    }
    function applyZoom(f) {
      var nd = clamp(st.dist * f, DIST_MIN, DIST_MAX), r = nd / st.dist;
      if (st.anchorValid) { target.x += (st.anchor.x - target.x) * (1 - r); target.z += (st.anchor.z - target.z) * (1 - r); }
      st.dist = nd;
    }

    /* --- mouse / pen --- */
    function onPointerDown(e) {
      if (!st.enabled) return;
      if (e.pointerType === 'touch') { addTouch(e); return; }
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      var orbit = e.button === 2 || e.button === 1 || e.ctrlKey || e.shiftKey || e.metaKey;
      st.mode = orbit ? 2 : 1; st.lastX = e.clientX; st.lastY = e.clientY; st.lastT = st.lastMoveT = nowMs();
      cancelMotion();
      try { dom.setPointerCapture(e.pointerId); st.capturedId = e.pointerId; } catch (err) { st.capturedId = -1; }
    }
    function onPointerMove(e) {
      if (!st.enabled) return;
      if (e.pointerType === 'touch') { touchMove(e); return; }
      if (st.mode === 0) return;
      if (e.buttons === 0) { endDrag(e); return; }
      var t = nowMs(), dt = Math.max((t - st.lastT) / 1000, 0.001);
      var dx = e.clientX - st.lastX, dy = e.clientY - st.lastY;
      if (st.mode === 1) panBy(dx, dy, dt); else orbitBy(dx, dy, dt);
      st.lastX = e.clientX; st.lastY = e.clientY; st.lastT = t; st.lastMoveT = t;
    }
    function onPointerUp(e) {
      if (e.pointerType === 'touch') { removeTouch(e); return; }
      endDrag(e);
    }
    function endDrag(e) {
      if (st.mode === 0 && st.nptr === 0) return;
      st.mode = 0;
      if (nowMs() - st.lastMoveT > 120) { st.vPanX = st.vPanZ = st.vAz = st.vPitch = 0; }
      if (e && st.capturedId >= 0) { try { dom.releasePointerCapture(st.capturedId); } catch (err) { /* ignore */ } }
      st.capturedId = -1;
    }
    function onWheel(e) {
      if (!st.enabled) return;
      e.preventDefault();
      var d = e.deltaY; if (e.deltaMode === 1) d *= 33; else if (e.deltaMode === 2) d *= 400;
      d = clamp(d, -400, 400);
      st.zoomAccum += d * 0.0012;
      st.anchorValid = !!pickAt(e.clientX, e.clientY, st.pickMesh, st.anchor);
      st.anim.active = false;
    }
    function onContextMenu(e) { e.preventDefault(); }

    /* --- touch --- */
    function slotOf(id) { return st.ptr[0].id === id ? 0 : (st.ptr[1].id === id ? 1 : -1); }
    function initPinch() {
      var a = st.ptr[0], b = st.ptr[1], dx = b.x - a.x, dy = b.y - a.y;
      st.pinchDist = Math.max(1, Math.sqrt(dx * dx + dy * dy)); st.pinchAng = Math.atan2(dy, dx);
      st.midX = (a.x + b.x) * 0.5; st.midY = (a.y + b.y) * 0.5; st.lastT = st.lastMoveT = nowMs();
    }
    function addTouch(e) {
      if (st.nptr >= 2 || slotOf(e.pointerId) >= 0) return;
      var slot = st.ptr[0].id === -1 ? 0 : 1;
      st.ptr[slot].id = e.pointerId; st.ptr[slot].x = e.clientX; st.ptr[slot].y = e.clientY; st.nptr++;
      cancelMotion();
      try { dom.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (st.nptr === 1) { st.mode = 1; st.lastX = e.clientX; st.lastY = e.clientY; st.lastT = st.lastMoveT = nowMs(); }
      else { st.mode = 3; initPinch(); }
    }
    function touchMove(e) {
      var slot = slotOf(e.pointerId); if (slot < 0) return;
      st.ptr[slot].x = e.clientX; st.ptr[slot].y = e.clientY;
      var t = nowMs(), dt = Math.max((t - st.lastT) / 1000, 0.001);
      if (st.nptr === 1) {
        panBy(e.clientX - st.lastX, e.clientY - st.lastY, dt);
        st.lastX = e.clientX; st.lastY = e.clientY;
      } else if (st.nptr === 2) {
        var a = st.ptr[0], b = st.ptr[1], dx = b.x - a.x, dy = b.y - a.y;
        var nd = Math.max(1, Math.sqrt(dx * dx + dy * dy)), ang = Math.atan2(dy, dx);
        var mx = (a.x + b.x) * 0.5, my = (a.y + b.y) * 0.5;
        st.anchorValid = !!pickAt(mx, my, st.pickMesh, st.anchor);
        applyZoom(st.pinchDist / nd);
        var dAng = ang - st.pinchAng; if (dAng > Math.PI) dAng -= 2 * Math.PI; else if (dAng < -Math.PI) dAng += 2 * Math.PI;
        st.az += dAng;
        panBy(mx - st.midX, my - st.midY, 0);
        st.pinchDist = nd; st.pinchAng = ang; st.midX = mx; st.midY = my;
      }
      st.lastT = t; st.lastMoveT = t;
    }
    function removeTouch(e) {
      var slot = slotOf(e.pointerId); if (slot < 0) return;
      st.ptr[slot].id = -1; st.nptr--;
      try { dom.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (st.nptr === 1) {
        var r = st.ptr[0].id !== -1 ? st.ptr[0] : st.ptr[1];
        st.mode = 1; st.lastX = r.x; st.lastY = r.y; st.lastT = st.lastMoveT = nowMs();
        st.vPanX = st.vPanZ = 0;
      } else { st.nptr = 0; st.mode = 0; if (nowMs() - st.lastMoveT > 120) { st.vPanX = st.vPanZ = 0; } }
    }

    /* --- keyboard --- */
    function keyBlocked(e) {
      if (document.body && document.body.classList.contains('modal-open')) return true;
      var el = e.target || document.activeElement;
      if (!el || el === document.body || el === document) return false;
      var tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
    }
    function keyName(e) {
      switch (e.code || e.key) {
        case 'KeyW': case 'ArrowUp': return 'w';
        case 'KeyS': case 'ArrowDown': return 's';
        case 'KeyA': case 'ArrowLeft': return 'a';
        case 'KeyD': case 'ArrowRight': return 'd';
        case 'KeyQ': return 'q';
        case 'KeyE': return 'e';
      }
      return null;
    }
    function onKeyDown(e) {
      if (!st.enabled || e.altKey || e.ctrlKey || e.metaKey) return;
      var k = keyName(e); if (!k) return;
      if (keyBlocked(e)) return;
      if (!st.keys[k]) st.anim.active = false;
      st.keys[k] = true; e.preventDefault();
    }
    function onKeyUp(e) { var k = keyName(e); if (k) st.keys[k] = false; }
    function clearKeys() { var k = st.keys; k.w = k.a = k.s = k.d = k.q = k.e = false; }

    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('pointercancel', onPointerUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', onContextMenu);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('keyup', onKeyUp);
    root.addEventListener('blur', clearKeys);

    function update(dt) {
      var a = st.anim;
      if (a.active) {
        a.t += dt; var u = ease(a.t / a.dur);
        target.lerpVectors(a.from, a.to, u); st.dist = lerp(a.fromDist, a.toDist, u);
        if (a.t >= a.dur) a.active = false;
      } else {
        if (st.enabled) {
          var k = st.keys, sp = st.dist * 0.9 * dt, rot = 1.4 * dt, mv = 0, ms = 0;
          if (k.w) mv += 1; if (k.s) mv -= 1; if (k.d) ms += 1; if (k.a) ms -= 1;
          if (mv !== 0 || ms !== 0) {
            target.x += (fwdX() * mv + rightX() * ms) * sp; target.z += (fwdZ() * mv + rightZ() * ms) * sp;
          }
          if (k.q) st.az += rot; if (k.e) st.az -= rot;
        }
        if (st.mode === 0) {
          if (st.vPanX !== 0 || st.vPanZ !== 0 || st.vAz !== 0 || st.vPitch !== 0) {
            target.x += st.vPanX * dt; target.z += st.vPanZ * dt;
            st.az += st.vAz * dt; st.pitch += st.vPitch * dt;
            var dec = Math.exp(-dt * 7);
            st.vPanX *= dec; st.vPanZ *= dec; st.vAz *= dec; st.vPitch *= dec;
            if (Math.abs(st.vPanX) + Math.abs(st.vPanZ) < 0.02) { st.vPanX = st.vPanZ = 0; }
            if (Math.abs(st.vAz) + Math.abs(st.vPitch) < 0.002) { st.vAz = st.vPitch = 0; }
          }
        }
        if (st.zoomAccum !== 0) {
          var step = st.zoomAccum * Math.min(1, dt * 14);
          if (Math.abs(st.zoomAccum - step) < 1e-4) step = st.zoomAccum;
          st.zoomAccum -= step; applyZoom(Math.exp(step));
        }
      }
      // clamps
      target.x = clamp(target.x, -MAP_HALF, MAP_HALF); target.z = clamp(target.z, -MAP_HALF, MAP_HALF);
      st.pitch = clamp(st.pitch, PITCH_MIN, PITCH_MAX); st.dist = clamp(st.dist, DIST_MIN, DIST_MAX);
      if (st.az > Math.PI) st.az -= 2 * Math.PI; else if (st.az < -Math.PI) st.az += 2 * Math.PI;
      if (st.heightAt) { var ty = heightClamped(target.x, target.z); target.y += (ty - target.y) * Math.min(1, dt * 12); }
      if (!isFinite(target.y)) target.y = 6;
      // camera
      var cp = Math.cos(st.pitch), spitch = Math.sin(st.pitch);
      var px = target.x + st.dist * cp * Math.sin(st.az), py = target.y + st.dist * spitch, pz = target.z + st.dist * cp * Math.cos(st.az);
      if (st.heightAt) { var hy = heightClamped(px, pz) + 1.5; if (py < hy) py = hy; }
      camera.position.set(px, py, pz);
      camera.lookAt(target);
    }

    function focus(sx, sz, dist, opts) {
      sx = clamp(num(sx, target.x), -MAP_HALF, MAP_HALF); sz = clamp(num(sz, target.z), -MAP_HALF, MAP_HALF);
      var d = (dist == null) ? st.dist : clamp(num(dist, st.dist), DIST_MIN, DIST_MAX);
      var smoothMove = !(opts && opts.smooth === false);
      st.vPanX = st.vPanZ = st.vAz = st.vPitch = 0; st.zoomAccum = 0;
      var ty = st.heightAt ? heightClamped(sx, sz) : target.y;
      if (!smoothMove) { target.set(sx, ty, sz); st.dist = d; st.anim.active = false; return; }
      var a = st.anim; a.from.copy(target); a.to.set(sx, ty, sz); a.fromDist = st.dist; a.toDist = d; a.t = 0;
      a.dur = clamp(0.45 + a.from.distanceTo(a.to) * 0.006 + Math.abs(d - st.dist) * 0.003, 0.45, 1.5);
      a.active = true;
    }

    function setEnabled(b) {
      st.enabled = !!b;
      if (!st.enabled) { endDrag(null); st.nptr = 0; st.ptr[0].id = st.ptr[1].id = -1; clearKeys(); cancelMotion(); }
    }
    function dispose() {
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerUp);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('contextmenu', onContextMenu);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('keyup', onKeyUp);
      root.removeEventListener('blur', clearKeys);
    }

    st.update = update; st.focus = focus; st.setEnabled = setEnabled; st.dispose = dispose; st.pickAt = pickAt;
    st.setView = function (az, pitch, dist) { st.az = num(az, st.az); st.pitch = clamp(num(pitch, st.pitch), PITCH_MIN, PITCH_MAX); st.dist = clamp(num(dist, st.dist), DIST_MIN, DIST_MAX); };
    return st;
  }

  /* ---------- Scene.init ---------- */
  var Scene = WS.Scene = {};

  Scene.init = function (containerEl, world) {
    if (typeof THREE === 'undefined' || !containerEl || typeof document === 'undefined') return null;
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (err) { return null; }
    renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputEncoding = THREE.sRGBEncoding;
    var canvas = renderer.domElement;
    canvas.style.display = 'block'; canvas.style.width = '100%'; canvas.style.height = '100%';
    canvas.style.touchAction = 'none'; canvas.style.userSelect = 'none'; canvas.style.webkitUserSelect = 'none';
    canvas.style.outline = 'none';
    canvas.setAttribute('tabindex', '-1');
    containerEl.appendChild(canvas);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.5, 1800);
    scene.fog = new THREE.FogExp2(0xd9e3ec, 0.0028);

    // sky dome
    var skyUniforms = {
      topColor: { value: new THREE.Color(WS.C ? WS.C.PALETTE.sky : 0x9fc7e8) },
      bottomColor: { value: new THREE.Color(WS.C ? WS.C.PALETTE.skyLow : 0xf3e6cf) },
      exponent: { value: 0.55 }
    };
    var sky = new THREE.Mesh(
      new THREE.SphereGeometry(800, 32, 16),
      new THREE.ShaderMaterial({ uniforms: skyUniforms, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false })
    );
    sky.frustumCulled = false; sky.renderOrder = -10; sky.name = 'sky';
    scene.add(sky);

    // lights
    var sun = new THREE.DirectionalLight(0xfff1d6, 1.4);
    sun.name = 'sun'; sun.castShadow = true;
    var sc = sun.shadow.camera;
    sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80; sc.near = 1; sc.far = 400;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
    sun.position.set(80, 140, 120); sun.target.position.set(0, 0, 0);
    scene.add(sun); scene.add(sun.target);
    var hemi = new THREE.HemisphereLight(0xb8c8ff, 0x8a7a5a, 0.5); hemi.name = 'hemi'; scene.add(hemi);
    var ambient = new THREE.AmbientLight(0x404050, 0.25); ambient.name = 'ambient'; scene.add(ambient);

    // drifting cloud shadows: invisible plane that only casts (alpha-tested) shadows
    var clouds = null, cloudTex = null;
    try {
      cloudTex = makeCloudTexture(256);
      if (cloudTex) {
        var cloudMat = new THREE.MeshBasicMaterial({ alphaMap: cloudTex, alphaTest: 0.5, colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
        clouds = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), cloudMat);
        clouds.rotation.x = -Math.PI / 2; clouds.position.y = 72; clouds.castShadow = true; clouds.receiveShadow = false;
        clouds.name = 'cloudShadows'; clouds.frustumCulled = false;
        scene.add(clouds);
      }
    } catch (err) { clouds = null; }
    var cloudDrift = { x: 0.0032, y: 0.0014 };

    var ctx = {
      renderer: renderer, scene: scene, camera: camera, sun: sun, hemi: hemi, ambient: ambient, sky: sky, clouds: clouds,
      container: containerEl, world: world || null, _w: 1, _h: 1, _fps: 60
    };
    var controls = ctx.controls = makeControls(ctx);

    /* --- lighting state --- */
    var L = { season: 1, tod: SEASONS[1].tod, smoke: 0, drought: 0, fogMul: new THREE.Color(1, 1, 1), fogAdd: 0, skyMul: new THREE.Color(1, 1, 1) };
    var cSun = new THREE.Color(), cTmp = new THREE.Color(), cTmp2 = new THREE.Color(), cFog = new THREE.Color();
    var sunDir = new THREE.Vector3();

    function applyLighting() {
      var S = SEASONS[L.season], sm = L.smoke, dr = L.drought;
      var el = Math.max(6 * DEG, S.maxElev * DEG * Math.sin(Math.PI * clamp(L.tod, 0, 1)));
      var az = lerp(Math.PI / 2, -Math.PI / 2, clamp(L.tod, 0, 1)); // east -> south -> west; sun sits in the southern sky (+z)
      sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      sun.position.copy(sunDir).multiplyScalar(SUN_DIST);
      // sun colour: season base, warmer near the horizon, bleached by drought, orange under smoke
      cSun.setHex(S.sun);
      var warmth = 1 - ease((el / DEG - 8) / 40);
      cTmp.setHex(0xffb070); cSun.lerp(cTmp, warmth * 0.55);
      cTmp.setHex(BLEACH.sun); cSun.lerp(cTmp, dr * 0.35);
      cTmp.setHex(SMOKE.sun); cSun.lerp(cTmp, sm * 0.7);
      sun.color.copy(cSun).convertSRGBToLinear();
      sun.intensity = S.sunI * (0.8 + 0.2 * Math.sin(el)) * (1 - 0.45 * sm);
      // hemisphere + ambient
      cTmp.setHex(S.hemiSky); cTmp2.setHex(SMOKE.hemiSky); cTmp.lerp(cTmp2, sm * 0.7);
      hemi.color.copy(cTmp).convertSRGBToLinear();
      cTmp.setHex(S.hemiGround); cTmp2.setHex(BLEACH.hemiGround); cTmp.lerp(cTmp2, dr * 0.5);
      hemi.groundColor.copy(cTmp).convertSRGBToLinear();
      hemi.intensity = S.hemiI * (1 - 0.2 * sm);
      ambient.color.setHex(S.amb).convertSRGBToLinear();
      ambient.intensity = S.ambI + 0.08 * sm;
      renderer.toneMappingExposure = S.exposure + 0.06 * dr - 0.05 * sm;
      // sky
      cTmp.setHex(S.skyTop); cTmp2.setHex(SMOKE.skyTop); cTmp.lerp(cTmp2, sm * 0.8);
      cTmp2.setHex(0xe0d8c8); cTmp.lerp(cTmp2, warmth * 0.15);
      skyUniforms.topColor.value.copy(cTmp).multiply(L.skyMul);
      cTmp.setHex(S.skyLow); cTmp2.setHex(SMOKE.skyLow); cTmp.lerp(cTmp2, sm * 0.8);
      skyUniforms.bottomColor.value.copy(cTmp);
      // fog (season base; Effects may override afterwards via setFog)
      cFog.setHex(S.fog); cTmp2.setHex(BLEACH.fog); cFog.lerp(cTmp2, dr * 0.5);
      cTmp2.setHex(SMOKE.fog); cFog.lerp(cTmp2, sm * 0.85);
      cFog.multiply(L.fogMul);
      setFogInternal(cFog, S.fogD + 0.0045 * sm + L.fogAdd);
    }
    function setFogInternal(color, density) {
      density = clamp(num(density, scene.fog.density), 0, 0.05);
      scene.fog.density = density;
      scene.fog.color.copy(color).convertSRGBToLinear();
      // horizon: pull the sky's low band toward the fog colour so the terrain haze meets the sky
      skyUniforms.bottomColor.value.lerp(color, 0.65);
    }

    ctx.setSeasonLighting = function (seasonIdx, climate) {
      var s = clamp(num(seasonIdx, 1) | 0, 0, 3);
      L.season = s; L.tod = SEASONS[s].tod;
      L.smoke = smokeAmount(climate); L.drought = climate ? droughtAmount(climate.drought) : 0;
      applyLighting();
    };
    ctx.setTimeOfDay = function (t) { L.tod = clamp(num(t, L.tod), 0, 1); applyLighting(); };
    ctx.setFog = function (color, density) {
      if (color != null) {
        if (color.isColor) cTmp.copy(color); else if (typeof color === 'number') cTmp.setHex(color); else cTmp.set(color);
      } else cTmp.copy(scene.fog.color).convertLinearToSRGB();
      setFogInternal(cTmp, density == null ? scene.fog.density : density);
    };
    /* weather fog from Effects, expressed relative to its clear baseline: per-channel colour multiplier,
       additive density, sky-top multiplier. Re-applied on top of every season/time-of-day change. */
    ctx.setFogModulation = function (colorMul, densityAdd, skyMul) {
      if (colorMul && colorMul.isColor) L.fogMul.copy(colorMul); else L.fogMul.set(1, 1, 1);
      L.fogAdd = clamp(num(densityAdd, 0), -0.02, 0.05);
      if (skyMul && skyMul.isColor) L.skyMul.copy(skyMul); else L.skyMul.set(1, 1, 1);
      applyLighting();
    };
    ctx.setSky = function (top, low) {
      if (top != null) skyUniforms.topColor.value.set(top);
      if (low != null) skyUniforms.bottomColor.value.set(low);
    };
    ctx.setCloudShadows = function (on) { if (clouds) clouds.castShadow = !!on; };
    ctx.setWind = function (dirRad, mph) {
      var m = clamp(num(mph, 8), 0, 60) / 8, d = num(dirRad, 0.8);
      cloudDrift.x = 0.0035 * m * Math.sin(d); cloudDrift.y = 0.0035 * m * Math.cos(d);
    };
    ctx.setTerrain = function (mesh, heightAt) {
      controls.pickMesh = mesh || null;
      controls.heightAt = (typeof heightAt === 'function') ? heightAt : null;
      if (controls.heightAt) { controls.target.y = controls.heightAt(controls.target.x, controls.target.z); if (!isFinite(controls.target.y)) controls.target.y = 6; }
    };

    /* --- resize --- */
    var ro = null;
    ctx.resize = function () {
      var w = Math.max(1, containerEl.clientWidth | 0), h = Math.max(1, containerEl.clientHeight | 0);
      if (w === ctx._w && h === ctx._h) return;
      ctx._w = w; ctx._h = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    ctx._w = ctx._h = 0; ctx.resize();
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function () { ctx.resize(); }); ro.observe(containerEl);
    } else { root.addEventListener('resize', ctx.resize); }

    /* --- loop --- */
    var running = false, rafId = 0, lastT = 0, tickFn = null, fpsAcc = 0, fpsN = 0, fpsT = 0;
    function frame(t) {
      if (!running) return;
      rafId = root.requestAnimationFrame(frame);
      var dt = (t - lastT) / 1000; lastT = t;
      if (!(dt > 0)) dt = 0; if (dt > 0.05) dt = 0.05;
      controls.update(dt);
      if (clouds && cloudTex) { cloudTex.offset.x += cloudDrift.x * dt; cloudTex.offset.y += cloudDrift.y * dt; }
      if (tickFn) tickFn(dt);
      renderer.render(scene, camera);
      fpsAcc += dt; fpsN++; if (fpsAcc >= 0.5) { ctx._fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    }
    function onVisibility() {
      if (!running) return;
      if (document.hidden) { if (rafId) root.cancelAnimationFrame(rafId); rafId = 0; }
      else if (!rafId) { lastT = nowMs(); rafId = root.requestAnimationFrame(frame); }
    }
    ctx.startLoop = function (fn) {
      tickFn = (typeof fn === 'function') ? fn : null;
      if (running) return;
      running = true; lastT = nowMs();
      document.addEventListener('visibilitychange', onVisibility);
      if (!document.hidden) rafId = root.requestAnimationFrame(frame);
    };
    ctx.stopLoop = function () {
      running = false;
      if (rafId) root.cancelAnimationFrame(rafId); rafId = 0;
      document.removeEventListener('visibilitychange', onVisibility);
    };
    ctx.renderOnce = function () { controls.update(0); renderer.render(scene, camera); };
    ctx.getFps = function () { return ctx._fps; };

    /* --- picking / projection / camera --- */
    var pv = new THREE.Vector3();
    ctx.project = function (x, y, z) {
      camera.updateMatrixWorld();
      pv.set(num(x, 0), num(y, 0), num(z, 0)).project(camera);
      return { sx: (pv.x + 1) * 0.5 * ctx._w, sy: (1 - pv.y) * 0.5 * ctx._h, visible: pv.z < 1 && pv.z > -1 };
    };
    ctx.pick = function (clientX, clientY, terrainMesh) {
      var hit = controls.pickAt(num(clientX, 0), num(clientY, 0), terrainMesh || controls.pickMesh, pv);
      return hit ? { sx: pv.x, sy: pv.y, sz: pv.z } : null;
    };
    ctx.focus = function (sx, sz, dist, opts) { controls.focus(sx, sz, dist, opts); };
    ctx.setControlsEnabled = function (b) { controls.setEnabled(b); };
    ctx.setView = function (az, pitch, dist) { controls.setView(az, pitch, dist); };

    ctx.dispose = function () {
      ctx.stopLoop();
      controls.dispose();
      if (ro) { ro.disconnect(); ro = null; } else { root.removeEventListener('resize', ctx.resize); }
      sky.geometry.dispose(); sky.material.dispose();
      if (clouds) { clouds.geometry.dispose(); clouds.material.dispose(); }
      if (cloudTex) cloudTex.dispose();
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };

    // initial view: from the SE looking NW over the town toward the reservoir and mountains
    controls.setView(45 * DEG, 48 * DEG, 110);
    controls.target.set(2.5, 6, 4.5);
    ctx.setSeasonLighting(1, null);
    controls.update(0);
    return ctx;
  };

  Scene.SEASONS = SEASONS;
  Scene.LIMITS = { pitchMin: PITCH_MIN, pitchMax: PITCH_MAX, distMin: DIST_MIN, distMax: DIST_MAX, mapHalf: MAP_HALF };
})();
