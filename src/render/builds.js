/* Watershed — builds: in-world construction scenes when a project is funded + the persistent installations that stay
   on the map (siren poles, gauges, pivots, beaver dams, tanks, cabinets ...). Export WS.Builds. Browser only (THREE r128).
     WS.Builds.init(scene, world, { props, fx, heightAt, camera }) → builds
     builds.play(projectId, targetZoneId, state) → Promise<void>   // 3–5 s scene; unknown ids resolve at once; never throws
                                      // (SPEC3 §C) first runs the player figure to ~2 cells from the site (2.5 s cap → teleport),
                                      // keeps it facing the site with action 'point' during the scene, clears the action after
     builds.installed(state, world)   // (re)create every persistent installation from state.projects.funded (idempotent)
     builds.update(dt)                // animation: pivots rotate, sirens blink, scenes advance
     builds.siteFor(projectId, targetZoneId) → { x, y, dist } | null   // cell to fly the camera to before play()
     builds.stats() → { drawCalls, items, sceneActive }
     builds.dispose()
   Draw-call budget: persistent = 1 merged "uniques" mesh + 5 InstancedMeshes (rings, strip squares, willows, pivot arms,
   blink bulbs) + 1 wetland water sheet = 7 when everything is funded; a running scene adds ≤ 6 temporary meshes. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};

  var CAP_RINGS = 500, CAP_SQUARES = 1400, CAP_WILLOWS = 300, CAP_PIVOTS = 8, CAP_BULBS = 64, CAP_CREW = 8;
  var GLOBAL_IDS = ['streamgages', 'irrigation', 'leak_detection', 'reservoir_upgrade', 'rain_capture', 'shelters', 'warning_system', 'outreach', 'treatment', 'stockpile', 'mussel_inspection', 'wildlife_corridor'];
  var ZONE_KEY = { forest_thinning: 'thinned', home_hardening: 'hardened', fuel_break: 'fuelBreak', wetland: 'wetland' };
  var THIN_FRAC = 0.4, BREAK_FRAC = 0.5, MANY_ITEMS = 8, ACTOR_SCALE = 1.7, CREW_SCALE = 1.6;

  function hash(i, k) { var x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function ease(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }
  function easeOut(u) { u = clamp(u, 0, 1); return 1 - (1 - u) * (1 - u) * (1 - u); }
  function pop(u) { u = clamp(u, 0, 1); return u < 0.7 ? 1.15 * easeOut(u / 0.7) : 1.15 - 0.15 * ease((u - 0.7) / 0.3); }
  function noop() {}
  function resolved() { return Promise.resolve(); }
  function nullBuilds() {
    return { play: resolved, installed: noop, update: noop, siteFor: function () { return null; }, stats: function () { return { drawCalls: 0, items: 0, sceneActive: false }; }, dispose: noop, group: null };
  }

  function init(scene, world, opts) {
    var THREE = root.THREE, C = WS.C;
    if (!THREE || !C || !scene || !world || !world.elev) return nullBuilds();
    opts = opts || {};
    var props = opts.props || null, fx = opts.fx || null;
    var N = world.N || C.N, NN = N * N, LAND = C.LAND, PAL = C.PALETTE, CELL = C.RENDER.CELL || 1;
    var heightAt = (typeof opts.heightAt === 'function') ? opts.heightAt : function (sx, sz) {
      var c = C.sceneToCell(sx, sz), x = clamp(c.x, 0, N - 1), y = clamp(c.y, 0, N - 1);
      return C.elevToScene(fin(world.elev[y * N + x], C.RENDER.ELEV_BASE));
    };
    function hAt(sx, sz) { return fin(heightAt(sx, sz), 0); }
    function sX(cx) { return (cx - N / 2 + 0.5) * CELL; }
    function sZ(cy) { return (cy - N / 2 + 0.5) * CELL; }
    function cellAt(sx, sz) { var c = C.sceneToCell(sx, sz); return (c.x < 0 || c.y < 0 || c.x >= N || c.y >= N) ? -1 : c.y * N + c.x; }
    function landXY(x, y) { x = Math.round(x); y = Math.round(y); return (x < 0 || y < 0 || x >= N || y >= N || !world.land) ? -1 : world.land[y * N + x]; }
    function isWater(l) { return l === LAND.RIVER || l === LAND.RESERVOIR; }
    function zoneById(id) {
      if (typeof world.zoneById === 'function') { try { var z = world.zoneById(id); if (z) return z; } catch (e) { /* fallthrough */ } }
      var zs = world.zones || []; for (var k = 0; k < zs.length; k++) if (zs[k] && zs[k].id === id) return zs[k]; return null;
    }
    function zonesOf(type) {
      if (typeof world.zonesOf === 'function') { try { return world.zonesOf(type) || []; } catch (e) { /* fallthrough */ } }
      return (world.zones || []).filter(function (z) { return z && z.type === type; });
    }
    function cellX(i) { return i % N; }
    function cellY(i) { return (i / N) | 0; }

    // ---------------------------------------------------------------- geometry kit (unit primitives, vertex-coloured merges)
    var _o = new THREE.Object3D(), _zero = new THREE.Matrix4().makeScale(0, 0, 0);
    var BOX = new THREE.BoxGeometry(1, 1, 1), CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, false), CYL5 = new THREE.CylinderGeometry(0.5, 0.5, 1, 5, 1, true);
    var CONE4 = new THREE.ConeGeometry(0.5, 1, 4, 1, false); CONE4.rotateY(Math.PI / 4);
    var SPH = new THREE.SphereGeometry(0.5, 6, 4), ICO = new THREE.IcosahedronGeometry(0.5, 0), DISC = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, false);
    var baseGeoms = [BOX, CYL8, CYL5, CONE4, SPH, ICO, DISC];
    function part(g, c, x, y, z, ry, sx, sy, sz, rx, rz) {
      _o.position.set(x || 0, y || 0, z || 0); _o.rotation.set(rx || 0, ry || 0, rz || 0);
      _o.scale.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz); _o.updateMatrix();
      return { g: g, m: _o.matrix.clone(), c: c };
    }
    function xform(x, y, z, ry, s) { _o.position.set(x, y, z); _o.rotation.set(0, ry || 0, 0); _o.scale.set(s || 1, s || 1, s || 1); _o.updateMatrix(); return _o.matrix.clone(); }
    function mergeParts(parts, xf) {
      var geoms = [], total = 0, i, g, p;
      for (i = 0; i < parts.length; i++) {
        p = parts[i]; g = p.g.index ? p.g.toNonIndexed() : p.g.clone();
        if (p.m) g.applyMatrix4(p.m); if (xf) g.applyMatrix4(xf);
        if (!g.attributes.normal) g.computeVertexNormals();
        geoms.push(g); total += g.attributes.position.count;
      }
      var pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3), off = 0;
      for (i = 0; i < geoms.length; i++) {
        g = geoms[i]; p = parts[i]; var cnt = g.attributes.position.count;
        pos.set(g.attributes.position.array, off * 3); nor.set(g.attributes.normal.array, off * 3);
        for (var v = 0; v < cnt; v++) { col[(off + v) * 3] = p.c[0]; col[(off + v) * 3 + 1] = p.c[1]; col[(off + v) * 3 + 2] = p.c[2]; }
        off += cnt; g.dispose();
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeBoundingSphere();
      return geo;
    }
    var matLit = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 });
    var waterCol = new THREE.Color(PAL.wetland).lerp(new THREE.Color(PAL.water), 0.55);
    var matWater = new THREE.MeshStandardMaterial({ color: waterCol, transparent: true, opacity: 0.55, roughness: 0.25, metalness: 0.05, depthWrite: false });
    var matBulb = new THREE.MeshBasicMaterial({ color: 0xffffff });
    var group = new THREE.Group(); group.name = 'builds'; scene.add(group);
    var tempGroup = new THREE.Group(); tempGroup.name = 'buildScene'; group.add(tempGroup);
    var disposables = [matLit, matWater, matBulb];

    // colours
    var YEL = [0.95, 0.72, 0.12], DARK = [0.16, 0.16, 0.17], GREY = [0.55, 0.56, 0.58], LIGHT = [0.86, 0.87, 0.88], WHITE = [0.96, 0.96, 0.96];
    var RED = [0.85, 0.16, 0.14], ORANGE = [0.98, 0.5, 0.1], BROWN = [0.45, 0.31, 0.18], LOG = [0.42, 0.28, 0.16], BLUE = [0.2, 0.4, 0.75];
    var TAN = [0.8, 0.7, 0.52], STRAW = [0.85, 0.75, 0.42], SKIN = [0.86, 0.66, 0.5], HIVIS = [0.98, 0.78, 0.12], RAIL = [0.55, 0.45, 0.3];

    // ---------------------------------------------------------------- part library (local coords, forward = +z, y up)
    function wheels(p, w, l, r, y) { for (var k = 0; k < 4; k++) p.push(part(BOX, DARK, (k & 1 ? w : -w), y || 0.05, (k & 2 ? l : -l), 0, r * 0.5, r, r)); }
    function tracks(p, w, l) { p.push(part(BOX, DARK, w, 0.08, 0, 0, 0.14, 0.16, l), part(BOX, DARK, -w, 0.08, 0, 0, 0.14, 0.16, l)); }
    var PARTS = {
      siren: function () {
        return [part(CYL8, DARK, 0, 0.03, 0, 0, 0.3, 0.06, 0.3), part(CYL8, GREY, 0, 0.6, 0, 0, 0.09, 1.2, 0.09),
          part(BOX, RED, 0, 1.28, 0, 0, 0.24, 0.2, 0.24), part(BOX, DARK, 0, 1.28, 0.15, 0, 0.12, 0.1, 0.06), part(BOX, DARK, 0, 1.28, -0.15, 0, 0.12, 0.1, 0.06)];
      },
      gauge: function () {
        return [part(BOX, GREY, 0, 0.04, 0, 0, 0.42, 0.08, 0.4), part(BOX, WHITE, 0, 0.24, 0, 0, 0.34, 0.32, 0.3), part(BOX, [0.3, 0.32, 0.35], 0, 0.42, 0, 0, 0.4, 0.05, 0.36),
          part(CYL8, GREY, 0.12, 0.7, 0, 0, 0.025, 0.5, 0.025), part(BOX, [0.15, 0.25, 0.55], -0.1, 0.46, 0, 0, 0.14, 0.02, 0.14, -0.5),
          part(BOX, WHITE, 0, 0.3, 0.5, 0, 0.14, 0.6, 0.06), part(BOX, RED, 0, 0.15, 0.5, 0, 0.145, 0.04, 0.065), part(BOX, RED, 0, 0.35, 0.5, 0, 0.145, 0.04, 0.065), part(BOX, RED, 0, 0.55, 0.5, 0, 0.145, 0.04, 0.065)];
      },
      snotel: function () {
        var p = [], k;
        for (k = 0; k < 3; k++) { var a = k * 2.094; p.push(part(CYL8, GREY, Math.cos(a) * 0.16, 0.9, Math.sin(a) * 0.16, 0, 0.03, 1.8, 0.03)); }
        p.push(part(BOX, GREY, 0, 0.6, 0, 0, 0.36, 0.03, 0.36), part(BOX, GREY, 0, 1.2, 0, 0.5, 0.36, 0.03, 0.36), part(BOX, LIGHT, 0, 1.82, 0, 0, 0.3, 0.12, 0.3));
        p.push(part(BOX, [0.15, 0.25, 0.55], 0.3, 1.55, 0, 0, 0.36, 0.02, 0.26, -0.6));
        p.push(part(CYL8, WHITE, -0.45, 0.35, 0.25, 0, 0.12, 0.6, 0.12), part(BOX, [0.5, 0.5, 0.52], 0.55, 0.015, 0.6, 0, 0.8, 0.03, 0.8));
        return p;
      },
      beaverDam: function (len) {
        var p = [], k, n = Math.max(2, Math.round(len * 2.5));
        p.push(part(CYL8, LOG, 0, 0.06, 0, 0, 0.11, len, 0.11, 0, Math.PI / 2), part(CYL8, LOG, 0, 0.15, 0.05, 0, 0.1, len * 0.9, 0.1, 0, Math.PI / 2));
        p.push(part(CYL8, [0.5, 0.34, 0.2], 0, 0.23, -0.03, 0, 0.08, len * 0.7, 0.08, 0, Math.PI / 2));
        for (k = 0; k < n; k++) { var x = (k / (n - 1) - 0.5) * len * 0.9; p.push(part(BOX, [0.36, 0.25, 0.14], x, 0.2, 0.08 * (k % 2 ? 1 : -1), 0, 0.035, 0.42, 0.035, 0.4 * (k % 2 ? 1 : -1), 0)); }
        p.push(part(ICO, [0.4, 0.3, 0.2], 0, 0.04, -0.2, 0, len * 0.8, 0.14, 0.36));
        return p;
      },
      pivotHub: function () { return [part(CYL8, DARK, 0, 0.02, 0, 0, 0.4, 0.04, 0.4), part(CYL8, GREY, 0, 0.18, 0, 0, 0.14, 0.36, 0.14), part(BOX, [0.3, 0.5, 0.75], 0.12, 0.12, 0.12, 0, 0.12, 0.16, 0.1)]; },
      tank: function () {
        return [part(CYL8, [0.78, 0.8, 0.82], 0, 0.3, 0, 0, 0.62, 0.6, 0.62), part(CYL8, [0.6, 0.62, 0.65], 0, 0.62, 0, 0, 0.66, 0.04, 0.66),
          part(CYL8, [0.7, 0.72, 0.74], 0.85, 0.07, 0, 0, 0.7, 0.14, 0.7), part(CYL8, [0.35, 0.55, 0.7], 0.85, 0.15, 0, 0, 0.5, 0.03, 0.5),
          part(BOX, GREY, 0.42, 0.3, 0, 0, 0.3, 0.05, 0.05), part(BOX, [0.45, 0.47, 0.5], 0.85, 0.32, 0, 0, 0.72, 0.03, 0.05)];
      },
      intakeTower: function (h) { return [part(CYL8, [0.75, 0.75, 0.72], 0, h / 2, 0, 0, 0.44, h, 0.44), part(BOX, [0.55, 0.55, 0.55], 0, h + 0.1, 0, 0, 0.5, 0.2, 0.5), part(BOX, GREY, 0, h + 0.22, 0.28, 0, 0.5, 0.03, 0.05)]; },
      cabinet: function () { return [part(CYL8, GREY, 0, 0.15, 0, 0, 0.04, 0.3, 0.04), part(BOX, [0.2, 0.42, 0.28], 0, 0.4, 0, 0, 0.2, 0.24, 0.14), part(BOX, DARK, 0, 0.4, 0.075, 0, 0.1, 0.1, 0.01)]; },
      shelterSign: function () { return [part(CYL8, GREY, 0, 0.35, 0, 0, 0.04, 0.7, 0.04), part(BOX, BLUE, 0, 0.6, 0, 0, 0.34, 0.22, 0.03), part(BOX, WHITE, 0, 0.6, 0.02, 0, 0.2, 0.06, 0.01), part(BOX, WHITE, 0, 0.6, 0.02, 0, 0.06, 0.16, 0.01)]; },
      hvac: function () { return [part(BOX, [0.68, 0.7, 0.72], 0, 0.08, 0, 0, 0.3, 0.16, 0.24), part(CYL8, DARK, 0, 0.17, 0, 0, 0.18, 0.03, 0.18), part(BOX, GREY, 0.18, 0.04, 0, 0, 0.08, 0.06, 0.06)]; },
      tent: function () {
        var p = [], k;
        for (k = 0; k < 4; k++) p.push(part(CYL8, GREY, (k & 1 ? 0.4 : -0.4), 0.22, (k & 2 ? 0.3 : -0.3), 0, 0.03, 0.44, 0.03));
        p.push(part(CONE4, WHITE, 0, 0.62, 0, 0, 1.05, 0.4, 0.85), part(BOX, BLUE, 0, 0.43, 0, 0, 1.0, 0.04, 0.8), part(BOX, BLUE, 0, 0.3, 0.42, 0, 0.5, 0.18, 0.02));
        p.push(part(CONE4, ORANGE, -0.7, 0.11, 0.5, 0, 0.14, 0.22, 0.14), part(CONE4, ORANGE, 0.7, 0.11, 0.5, 0, 0.14, 0.22, 0.14));
        return p;
      },
      cistern: function () { return [part(CYL8, [0.2, 0.36, 0.24], 0, 0.12, 0, 0, 0.2, 0.24, 0.2), part(CYL8, [0.16, 0.28, 0.2], 0, 0.255, 0, 0, 0.22, 0.03, 0.22), part(BOX, GREY, 0, 0.3, -0.08, 0, 0.04, 0.3, 0.04)]; },
      stockpile: function () {
        var p = [], k;
        for (k = 0; k < 6; k++) p.push(part(CYL8, STRAW, (k % 3 - 1) * 0.24, 0.1 + (k >= 3 ? 0.19 : 0), (k >= 3 ? 0.02 : -0.1), 0, 0.2, 0.24, 0.2, 0, Math.PI / 2));
        for (k = 0; k < 3; k++) p.push(part(CYL8, BROWN, 0.5, 0.07 + k * 0.13, 0.25, 0, 0.13, 0.7, 0.13, 0, Math.PI / 2));
        p.push(part(BOX, [0.2, 0.35, 0.6], -0.5, 0.14, 0.3, 0, 0.36, 0.28, 0.3));
        return p;
      },
      wildlife: function () {
        var p = [part(CYL8, GREY, 0, 0.45, 0, 0, 0.05, 0.9, 0.05), part(BOX, [0.95, 0.78, 0.1], 0, 0.85, 0, 0, 0.32, 0.32, 0.03, 0, Math.PI / 4), part(BOX, DARK, 0, 0.85, 0.02, 0, 0.14, 0.1, 0.01)];
        for (var zz = -2.2; zz <= 2.21; zz += 0.55) { if (Math.abs(zz) < 0.8) continue; p.push(part(BOX, RAIL, 0.6, 0.2, zz, 0, 0.05, 0.4, 0.05)); }   // fence parallel to the road, with a gap
        p.push(part(BOX, RAIL, 0.6, 0.3, -1.5, 0, 0.03, 0.03, 1.5), part(BOX, RAIL, 0.6, 0.3, 1.5, 0, 0.03, 0.03, 1.5), part(BOX, RAIL, 0.6, 0.16, -1.5, 0, 0.03, 0.03, 1.5), part(BOX, RAIL, 0.6, 0.16, 1.5, 0, 0.03, 0.03, 1.5));
        return p;
      },
      banner: function () {
        return [part(CYL8, GREY, -0.6, 0.5, 0, 0, 0.04, 1.0, 0.04), part(CYL8, GREY, 0.6, 0.5, 0, 0, 0.04, 1.0, 0.04), part(BOX, [0.12, 0.55, 0.55], 0, 0.78, 0, 0, 1.2, 0.36, 0.02),
          part(BOX, WHITE, -0.2, 0.84, 0.012, 0, 0.6, 0.05, 0.01), part(BOX, WHITE, -0.1, 0.72, 0.012, 0, 0.8, 0.05, 0.01), part(BOX, [0.95, 0.8, 0.2], 0.4, 0.82, 0.012, 0, 0.14, 0.14, 0.01)];
      },
      dirt: function () {
        return [part(BOX, [0.3, 0.25, 0.2], 0, 0.02, 0, 0, 0.9, 0.04, 0.9), part(ICO, [0.4, 0.28, 0.16], 0, 0.1, -0.1, 0, 0.6, 0.3, 0.5),
          part(CONE4, ORANGE, 0.5, 0.11, 0.45, 0, 0.12, 0.22, 0.12), part(CONE4, ORANGE, -0.5, 0.11, 0.45, 0, 0.12, 0.22, 0.12), part(CONE4, ORANGE, 0, 0.11, -0.55, 0, 0.12, 0.22, 0.12)];
      },
      // machines
      feller: function () {
        var p = []; tracks(p, 0.2, 0.62);
        p.push(part(BOX, YEL, 0, 0.28, -0.02, 0, 0.5, 0.22, 0.52), part(BOX, DARK, -0.1, 0.5, -0.08, 0, 0.24, 0.22, 0.24), part(BOX, [0.6, 0.62, 0.65], -0.1, 0.5, 0.045, 0, 0.2, 0.16, 0.01), part(CYL8, DARK, 0.15, 0.5, -0.2, 0, 0.04, 0.2, 0.04));
        return p;
      },
      fellerBoom: function () { return [part(BOX, YEL, 0, 0, 0.35, 0, 0.08, 0.08, 0.7), part(BOX, YEL, 0, 0.02, 0.72, 0, 0.06, 0.12, 0.06), part(BOX, GREY, 0, -0.1, 0.78, 0, 0.22, 0.22, 0.12), part(CYL8, [0.6, 0.6, 0.6], 0, -0.2, 0.8, 0, 0.24, 0.03, 0.24)]; },
      dozer: function () {
        var p = []; tracks(p, 0.2, 0.6);
        p.push(part(BOX, YEL, 0, 0.26, -0.04, 0, 0.46, 0.2, 0.5), part(BOX, DARK, -0.02, 0.46, -0.1, 0, 0.28, 0.2, 0.24), part(BOX, GREY, 0, 0.16, 0.4, 0, 0.62, 0.22, 0.05),
          part(BOX, YEL, 0.18, 0.18, 0.2, 0, 0.04, 0.04, 0.36), part(BOX, YEL, -0.18, 0.18, 0.2, 0, 0.04, 0.04, 0.36), part(CYL8, DARK, 0.12, 0.48, -0.2, 0, 0.04, 0.2, 0.04));
        return p;
      },
      excavator: function () {
        var p = []; tracks(p, 0.2, 0.6);
        p.push(part(BOX, YEL, 0, 0.26, -0.06, 0, 0.44, 0.2, 0.46), part(BOX, DARK, -0.12, 0.46, -0.1, 0, 0.22, 0.2, 0.24), part(BOX, YEL, 0, 0.4, -0.28, 0, 0.4, 0.14, 0.14));
        return p;
      },
      excavatorBoom: function () { return [part(BOX, YEL, 0, 0.2, 0.3, 0, 0.09, 0.09, 0.7, -0.6), part(BOX, YEL, 0, 0.25, 0.72, 0, 0.07, 0.07, 0.5, 0.9), part(BOX, GREY, 0, 0.02, 0.9, 0, 0.2, 0.14, 0.16)]; },
      pickup: function () {
        var p = [part(BOX, WHITE, 0, 0.16, 0.08, 0, 0.26, 0.16, 0.3), part(BOX, WHITE, 0, 0.1, -0.22, 0, 0.26, 0.1, 0.3), part(BOX, [0.5, 0.6, 0.7], 0, 0.22, 0.16, 0, 0.22, 0.06, 0.02),
          part(BOX, ORANGE, 0, 0.26, 0.02, 0, 0.2, 0.04, 0.06), part(BOX, DARK, 0, 0.13, -0.22, 0, 0.22, 0.03, 0.26)];
        wheels(p, 0.12, 0.15, 0.1); return p;
      },
      crewTruck: function () {
        var p = [part(BOX, WHITE, 0, 0.24, -0.1, 0, 0.3, 0.28, 0.5), part(BOX, WHITE, 0, 0.16, 0.28, 0, 0.3, 0.18, 0.24), part(BOX, ORANGE, 0, 0.2, -0.1, 0, 0.31, 0.05, 0.5), part(BOX, [0.5, 0.6, 0.7], 0, 0.2, 0.405, 0, 0.26, 0.08, 0.02)];
        wheels(p, 0.14, 0.2, 0.11); p.push(part(BOX, DARK, 0.14, 0.05, 0, 0, 0.055, 0.11, 0.11), part(BOX, DARK, -0.14, 0.05, 0, 0, 0.055, 0.11, 0.11)); return p;
      },
      torchCan: function () { return [part(CYL8, RED, 0.09, 0.1, 0.06, 0, 0.06, 0.12, 0.06), part(BOX, DARK, 0.09, 0.04, 0.12, 0, 0.02, 0.02, 0.1)]; }
    };
    var crewGeo = mergeParts([part(BOX, DARK, 0.03, 0.04, 0, 0, 0.04, 0.08, 0.04), part(BOX, DARK, -0.03, 0.04, 0, 0, 0.04, 0.08, 0.04),
      part(CYL5, HIVIS, 0, 0.15, 0, 0, 0.1, 0.16, 0.1), part(BOX, [0.9, 0.9, 0.9], 0, 0.15, 0.052, 0, 0.09, 0.02, 0.01),
      part(SPH, SKIN, 0, 0.26, 0, 0, 0.08, 0.08, 0.08), part(SPH, WHITE, 0, 0.29, 0, 0, 0.1, 0.06, 0.1)]);
    var willowGeo = mergeParts([part(CYL5, [0.45, 0.35, 0.22], 0.03, 0.12, 0, 0, 0.025, 0.28, 0.025, 0, -0.15), part(CYL5, [0.45, 0.35, 0.22], -0.04, 0.12, 0.02, 0, 0.025, 0.26, 0.025, 0.1, 0.2),
      part(ICO, [0.62, 0.75, 0.32], 0, 0.34, 0, 0, 0.34, 0.3, 0.32), part(ICO, [0.55, 0.7, 0.28], 0.08, 0.26, 0.06, 0.6, 0.22, 0.2, 0.22)]);
    var ringGeo = mergeParts([part(DISC, TAN, 0, 0.5, 0, 0, 1, 1, 1)]);
    var squareGeo = mergeParts([part(BOX, [0.74, 0.64, 0.46], 0, 0.5, 0, 0, 0.96, 1, 0.96)]);
    var armGeo = (function () {
      var p = [part(BOX, LIGHT, 0.5, 0.36, 0, 0, 1, 0.035, 0.035), part(BOX, LIGHT, 0.5, 0.28, 0, 0, 1, 0.02, 0.02)];
      for (var k = 1; k <= 4; k++) { var x = k * 0.25; p.push(part(BOX, GREY, x, 0.18, 0, 0, 0.03, 0.36, 0.03), part(BOX, DARK, x, 0.05, 0.05, 0, 0.05, 0.1, 0.1), part(BOX, DARK, x, 0.05, -0.05, 0, 0.05, 0.1, 0.1)); }
      return mergeParts(p);
    })();
    var bulbGeo = new THREE.SphereGeometry(0.5, 8, 6);
    disposables.push(crewGeo, willowGeo, ringGeo, squareGeo, armGeo, bulbGeo);

    function instanced(geo, cap, name, mat, shadow) {
      var im = new THREE.InstancedMesh(geo, mat || matLit, cap);
      im.name = name; im.frustumCulled = false; im.castShadow = !!shadow; im.receiveShadow = true; im.count = 0;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(im); return im;
    }
    var ringsMesh = instanced(ringGeo, CAP_RINGS, 'clearedRings'), squaresMesh = instanced(squareGeo, CAP_SQUARES, 'breakStrip');
    var willowMesh = instanced(willowGeo, CAP_WILLOWS, 'willows', null, true), armMesh = instanced(armGeo, CAP_PIVOTS, 'pivotArms', null, true);
    var bulbMesh = instanced(bulbGeo, CAP_BULBS, 'blinkBulbs', matBulb);
    bulbMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP_BULBS * 3), 3);
    var crewMesh = instanced(crewGeo, CAP_CREW, 'crew', null, true);
    var uniquesMesh = new THREE.Mesh(new THREE.BufferGeometry(), matLit); uniquesMesh.name = 'installations'; uniquesMesh.castShadow = true; uniquesMesh.receiveShadow = true; uniquesMesh.visible = false;
    group.add(uniquesMesh);
    var waterMesh = null, waterKey = '', water = { reveal: -1, cx: 0, cz: 0 };

    function setInst(mesh, k, x, y, z, ry, sx, sy, sz) {
      _o.position.set(x, y, z); _o.rotation.set(0, ry || 0, 0); _o.scale.set(sx, sy, sz); _o.updateMatrix(); mesh.setMatrixAt(k, _o.matrix);
    }

    // ---------------------------------------------------------------- locations (resolved once)
    var loc = (function () {
      var o = {}, k, i;
      o.hoods = zonesOf('neighborhood'); o.civic = zonesOf('civic')[0] || null; o.farms = zonesOf('farm'); o.wets = zonesOf('wetland'); o.forests = zonesOf('forest');
      o.town = (world.townCenter && isFinite(world.townCenter.x)) ? world.townCenter : (o.civic && o.civic.center ? o.civic.center : { x: N / 2, y: N / 2 });
      var blds = Array.isArray(world.buildings) ? world.buildings : [];
      function bld(type) { for (var q = 0; q < blds.length; q++) if (blds[q] && blds[q].type === type && isFinite(blds[q].x)) return blds[q]; return null; }
      o.school = bld('school'); o.hall = bld('town_hall'); o.fireStation = bld('fire_station'); o.tp = bld('treatment_plant');
      // river / reservoir
      var rv = world.river || {}, path = Array.isArray(rv.path) ? rv.path : [], K = path.length, dI = fin(rv.damIndex, -1), eI = fin(rv.entryIndex, -1);
      o.path = path; o.K = K; o.damIndex = dI;
      o.dam = (world.reservoir && world.reservoir.dam && isFinite(world.reservoir.dam.x)) ? world.reservoir.dam : null;
      o.intake = (world.reservoir && world.reservoir.intake && isFinite(world.reservoir.intake.x)) ? world.reservoir.intake : o.dam;
      o.resCenter = (world.reservoir && world.reservoir.center) ? world.reservoir.center : (o.dam || o.town);
      function bankSpot(kk) {
        if (K < 3) return null;
        kk = clamp(kk, 1, K - 2);
        var p = path[kk], a = path[Math.max(0, kk - 2)], b = path[Math.min(K - 1, kk + 2)], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
        dx /= l; dy /= l; var px = -dy, py = dx, offs = [1.3, 2.3, 3.3, 4.5, 6];
        for (var q = 0; q < offs.length; q++) for (var s = 1; s >= -1; s -= 2) {
          var x = p.x + px * offs[q] * s, y = p.y + py * offs[q] * s, ld = landXY(x, y);
          if (ld < 0 || isWater(ld)) continue;
          return { x: x, y: y, rot: Math.atan2(-px * s, -py * s), node: kk };
        }
        return null;
      }
      o.gauges = [];
      if (K > 6) {
        var dd = dI >= 0 ? dI : Math.floor(K * 0.5), ee = eI >= 0 ? eI : Math.floor(K * 0.35);
        [ee - 8, dd - 2, Math.round(dd + (K - 1 - dd) * 0.55)].forEach(function (kk) { var s = bankSpot(kk); if (s) o.gauges.push(s); });
      }
      // highest forest cell → SNOTEL
      var best = -1, be = -Infinity;
      for (i = 0; i < NN; i++) if (world.land && world.land[i] === LAND.FOREST && world.elev[i] > be) { be = world.elev[i]; best = i; }
      o.snotel = best >= 0 ? { x: cellX(best), y: cellY(best) } : null;
      // boat ramp: reservoir shore cell ≥ 3 cells from the dam
      o.ramp = null;
      if (o.dam && world.land) {
        var bd = Infinity;
        for (i = 0; i < NN; i++) {
          var l0 = world.land[i]; if (isWater(l0)) continue;
          var x0 = cellX(i), y0 = cellY(i), d0 = Math.hypot(x0 - o.dam.x, y0 - o.dam.y); if (d0 < 3 || d0 > 14 || d0 >= bd) continue;
          var shore = false;
          for (var oy = -1; oy <= 1 && !shore; oy++) for (var ox = -1; ox <= 1; ox++) if (landXY(x0 + ox, y0 + oy) === LAND.RESERVOIR) { shore = true; break; }
          if (shore) { bd = d0; o.ramp = { x: x0, y: y0 }; }
        }
      }
      // leak sites: road cells around town, sorted by angle so the first four are spread out
      var rc = [];
      if (world.land) for (i = 0; i < NN; i++) if (world.land[i] === LAND.ROAD) { var rx = cellX(i), ry = cellY(i), rd = Math.hypot(rx - o.town.x, ry - o.town.y); if (rd > 1.5 && rd < 11) rc.push({ x: rx, y: ry, a: Math.atan2(ry - o.town.y, rx - o.town.x) }); }
      rc.sort(function (a, b) { return a.a - b.a; });
      o.leak = [];
      for (k = 0; k < 12 && rc.length; k++) o.leak.push(rc[Math.floor(((k % 4) * 3 + Math.floor(k / 4)) * rc.length / 12) % rc.length]);
      // wildlife crossing: point on the main road in shrub ~16 cells from town
      o.wildlife = null;
      var roads = Array.isArray(world.roads) ? world.roads : [], main = null, mlen = 0;
      for (k = 0; k < roads.length; k++) { var pl = roads[k], ln = 0; if (!pl || pl.length < 2) continue; for (i = 1; i < pl.length; i++) ln += Math.hypot(pl[i].x - pl[i - 1].x, pl[i].y - pl[i - 1].y); if (ln > mlen) { mlen = ln; main = pl; } }
      if (main) {
        var bestD = Infinity;
        for (i = 0; i < main.length - 1; i++) {
          var a0 = main[i], b0 = main[i + 1], seg = Math.max(1, Math.round(Math.hypot(b0.x - a0.x, b0.y - a0.y)));
          for (var t = 0; t <= seg; t++) {
            var qx = a0.x + (b0.x - a0.x) * t / seg, qy = a0.y + (b0.y - a0.y) * t / seg;
            var lq = landXY(qx, qy), side = landXY(qx + (b0.y - a0.y) / seg * 2, qy - (b0.x - a0.x) / seg * 2);
            if (lq !== LAND.ROAD && lq !== LAND.SHRUB) continue;
            if (side !== LAND.SHRUB && side !== LAND.RIPARIAN) continue;
            var dq = Math.abs(Math.hypot(qx - o.town.x, qy - o.town.y) - 16);
            if (dq < bestD) { bestD = dq; o.wildlife = { x: qx, y: qy, rot: Math.atan2(b0.x - a0.x, b0.y - a0.y) }; }
          }
        }
      }
      // beaver-dam rows across each wetland
      o.dams = {};
      o.wets.forEach(function (z) {
        var bb = z.bbox, rows = [], w = bb.x1 - bb.x0 + 1, h = bb.y1 - bb.y0 + 1, alongX = h >= w, nd = clamp(Math.round((alongX ? h : w) / 2.5), 4, 6), q;
        for (q = 0; q < nd; q++) {
          var line = Math.round((alongX ? bb.y0 : bb.x0) + (q + 0.5) * (alongX ? h : w) / nd - 0.5), lo = Infinity, hi = -Infinity, cnt = 0;
          for (i = 0; i < z.cells.length; i++) {
            var cx = cellX(z.cells[i]), cy = cellY(z.cells[i]);
            if ((alongX ? cy : cx) !== line) continue;
            var v = alongX ? cx : cy; if (v < lo) lo = v; if (v > hi) hi = v; cnt++;
          }
          if (cnt < 2) continue;
          var mid = (lo + hi) / 2, len = clamp(cnt * 0.8, 1.2, 3.4);
          rows.push(alongX ? { x: mid, y: line, rot: Math.PI / 2, len: len } : { x: line, y: mid, rot: 0, len: len });
        }
        o.dams[z.id] = rows;
      });
      // center pivots: one per farm zone, on a farm cell nearest the centre
      o.pivots = [];
      o.farms.forEach(function (z) {
        if (!z.cells || !z.cells.length) return;
        var bb = z.bbox, len = clamp(Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2 - 1, 1.5, 4), bc = -1, bdd = Infinity;
        var wide = (bb.x1 - bb.x0) >= (bb.y1 - bb.y0), want = { x: z.center.x + (wide ? len + 1.5 : 0), y: z.center.y + (wide ? 0 : len + 1.5) }; // the barn sits at the centre cell
        for (var pass = 0; pass < 2 && bc < 0; pass++) {
          for (i = 0; i < z.cells.length; i++) { var c = z.cells[i], d1 = Math.hypot(cellX(c) - want.x, cellY(c) - want.y); if (d1 < bdd) { bdd = d1; bc = c; } }
          if (bdd > 3) { bc = -1; bdd = Infinity; want = { x: z.center.x - (wide ? len + 1.5 : 0), y: z.center.y - (wide ? 0 : len + 1.5) }; }
        }
        if (bc < 0) { bdd = Infinity; for (i = 0; i < z.cells.length; i++) { var c1 = z.cells[i], d2 = Math.hypot(cellX(c1) - z.center.x, cellY(c1) - z.center.y); if (d2 < bdd) { bdd = d2; bc = c1; } } }
        if (bc < 0) return;
        var px = cellX(bc), py = cellY(bc), cells = [];
        for (i = 0; i < z.cells.length; i++) { var c2 = z.cells[i]; if (Math.hypot(cellX(c2) - px, cellY(c2) - py) <= len) cells.push(c2); }
        o.pivots.push({ zone: z, x: px, y: py, len: len, cells: cells });
      });
      return o;
    })();

    function fuelBreakCells(zone) {
      var out = [];
      if (!zone || !zone.bbox || !world.land) return out;
      var b = zone.bbox, m = 2;
      for (var y = Math.max(0, b.y0 - m); y <= Math.min(N - 1, b.y1 + m); y++) for (var x = Math.max(0, b.x0 - m); x <= Math.min(N - 1, b.x1 + m); x++) {
        var l = world.land[y * N + x]; if (l === LAND.FOREST || l === LAND.SHRUB) out.push(y * N + x);
      }
      return out;
    }
    function local(bx, by, rot, ox, oz) { // building-local offset (rot 0 faces +y/south) → cell coords
      return { x: bx + Math.cos(rot) * ox + Math.sin(rot) * oz, y: by - Math.sin(rot) * ox + Math.cos(rot) * oz };
    }
    function houseList(zoneId) { return (props && typeof props.housesInZone === 'function') ? (props.housesInZone(zoneId) || []) : []; }
    /** the ignition line for a prescribed burn: ≤ 40 cells along the sector's lower (downhill/town-side) edge, sorted west → east */
    function burnLine(z) {
      if (!z || !z.cells || !z.cells.length) return null;
      var bb = z.bbox, line = [], k, c;
      for (k = 0; k < z.cells.length; k++) { c = z.cells[k]; if (cellY(c) >= bb.y1 - 2) line.push(c); }
      if (line.length < 6) { line = []; for (k = 0; k < z.cells.length; k++) { c = z.cells[k]; if (Math.abs(cellY(c) - z.center.y) <= 1) line.push(c); } }
      if (line.length < 4) line = Array.prototype.slice.call(z.cells, 0, Math.min(z.cells.length, 24));
      line.sort(function (a, b) { return cellX(a) - cellX(b) || cellY(a) - cellY(b); });
      if (line.length > 40) { var step = line.length / 40, sub = []; for (k = 0; k < 40; k++) sub.push(line[Math.floor(k * step)]); line = sub; }
      var sx = 0, sy = 0; for (k = 0; k < line.length; k++) { sx += cellX(line[k]); sy += cellY(line[k]); }
      return { cells: line, x: sx / line.length, y: sy / line.length };
    }

    // ---------------------------------------------------------------- configuration derived from state
    function derive(state) {
      var cfg = { thinned: {}, hardened: [], fuelBreak: [], wetland: [], lvl: {} }, k;
      var f = (state && state.projects && state.projects.funded) ? state.projects.funded : {};
      function targets(id) { var r = f[id]; return (r && Array.isArray(r.targets)) ? r.targets.map(Number) : []; }
      var eff = null;
      try { if (WS.Projects && typeof WS.Projects.effects === 'function' && state) eff = WS.Projects.effects(state); } catch (e) { eff = null; }
      if (eff) {
        Object.keys(eff.thinnedZones || {}).forEach(function (z) { if (eff.thinnedZones[z] > 0) cfg.thinned[+z] = eff.thinnedZones[z]; });
        cfg.hardened = Object.keys(eff.hardenedZones || {}).map(Number); cfg.fuelBreak = Object.keys(eff.fuelBreakZones || {}).map(Number);
      } else {
        var th = f.forest_thinning && f.forest_thinning.strength;
        if (th) Object.keys(th).forEach(function (z) { if (th[z] > 0) cfg.thinned[+z] = th[z]; });
        cfg.hardened = targets('home_hardening'); cfg.fuelBreak = targets('fuel_break');
      }
      cfg.wetland = targets('wetland');
      if (!cfg.wetland.length && ((eff && eff.wetlandRestored) || (state && state.flags && state.flags.wetlandRestored))) cfg.wetland = loc.wets.map(function (z) { return z.id; });
      for (k = 0; k < GLOBAL_IDS.length; k++) { var id = GLOBAL_IDS[k]; cfg.lvl[id] = f[id] ? Math.max(0, f[id].level | 0) : 0; }
      return cfg;
    }
    function cloneCfg(c) { return { thinned: Object.assign({}, c.thinned), hardened: c.hardened.slice(), fuelBreak: c.fuelBreak.slice(), wetland: c.wetland.slice(), lvl: Object.assign({}, c.lvl) }; }
    function includes(cfg, id, zone) {
      if (id === 'forest_thinning') return cfg.thinned[zone] > 0;
      if (ZONE_KEY[id]) return cfg[ZONE_KEY[id]].indexOf(zone) >= 0;
      return cfg.lvl[id] > 0;
    }
    function adjust(cfg, id, zone, delta) {
      cfg = cloneCfg(cfg);
      if (id === 'forest_thinning') { if (delta > 0) cfg.thinned[zone] = 1; else delete cfg.thinned[zone]; }
      else if (ZONE_KEY[id]) { var arr = cfg[ZONE_KEY[id]], at = arr.indexOf(zone); if (delta > 0 && at < 0) arr.push(zone); if (delta < 0 && at >= 0) arr.splice(at, 1); }
      else if (cfg.lvl.hasOwnProperty(id)) cfg.lvl[id] = Math.max(0, cfg.lvl[id] + delta);
      return cfg;
    }
    var pending = [];   // [{id, zone, lvl}] played but not yet reflected in state.projects (game may fund after the scene)
    function currentCfg(state) {
      var cfg = derive(state), keep = [];
      for (var k = 0; k < pending.length; k++) {
        var p = pending[k], has = (ZONE_KEY[p.id] || p.id === 'forest_thinning') ? includes(cfg, p.id, p.zone) : cfg.lvl[p.id] >= p.lvl;
        if (!has) { cfg = adjust(cfg, p.id, p.zone, 1); keep.push(p); }
      }
      pending = keep;
      return cfg;
    }

    // ---------------------------------------------------------------- collect: cfg → concrete installation records
    function collect(cfg) {
      var out = { items: [], bulbs: [], rings: [], squares: [], willows: [], pivots: [], waterCells: [], waterZones: [], clearCells: [], cropCells: [], thinned: cfg.thinned, hardened: cfg.hardened };
      var k, i, q, z;
      function item(tag, parts, x, y, z, rot, s, key) { out.items.push({ tag: tag, parts: parts, x: x, y: y, z: z, rot: rot || 0, s: s || 1, key: tag + '|' + (key != null ? key : (x.toFixed(2) + ',' + z.toFixed(2))) }); }
      function bulb(tag, x, y, z, hex, period, duty, size) { out.bulbs.push({ tag: tag, x: x, y: y, z: z, hex: hex, period: period, duty: duty, size: size || 0.09 }); }
      function ground(sx, sz) { return hAt(sx, sz); }
      // home hardening: cleared discs around each house
      cfg.hardened.forEach(function (zid) {
        houseList(zid).forEach(function (h) { if (!h.burned) out.rings.push({ tag: 'home_hardening', zone: zid, x: h.x, y: h.y + 0.025, z: h.z, d: 0.95 * h.s }); });
      });
      // fuel break: bare strip squares + cleared trees on the ring of forest/shrub cells around the neighbourhood
      cfg.fuelBreak.forEach(function (zid) {
        var cells = fuelBreakCells(zoneById(zid));
        for (i = 0; i < cells.length; i++) { var cx = cellX(cells[i]), cy = cellY(cells[i]); out.squares.push({ tag: 'fuel_break', zone: zid, cell: cells[i], x: sX(cx), y: ground(sX(cx), sZ(cy)) + 0.03, z: sZ(cy) }); }
        out.clearCells = out.clearCells.concat(cells);
      });
      // wetland: beaver dams, willows, water sheet
      cfg.wetland.forEach(function (zid) {
        z = zoneById(zid); if (!z || !z.cells) return;
        out.waterZones.push(zid);
        for (i = 0; i < z.cells.length; i++) out.waterCells.push(z.cells[i]);
        (loc.dams[zid] || []).forEach(function (d, di) { item('wetland', PARTS.beaverDam(d.len), sX(d.x), ground(sX(d.x), sZ(d.y)) - 0.02, sZ(d.y), d.rot, 1, zid + ':' + di); });
        for (i = 0; i < z.cells.length; i++) {
          var c = z.cells[i]; if (hash(c, 501) > 0.34) continue;
          var wx = sX(cellX(c)) + (hash(c, 502) - 0.5) * 0.7, wz = sZ(cellY(c)) + (hash(c, 503) - 0.5) * 0.7;
          out.willows.push({ tag: 'wetland', x: wx, y: ground(wx, wz) - 0.02, z: wz, rot: hash(c, 504) * 6.28, s: 0.75 + 0.5 * hash(c, 505), key: c });
        }
      });
      // irrigation: 2 pivots per level
      var np = Math.min(loc.pivots.length, 2 * cfg.lvl.irrigation);
      for (k = 0; k < np; k++) {
        var pv = loc.pivots[k], px = sX(pv.x), pz = sZ(pv.y), py = ground(px, pz);
        item('irrigation', PARTS.pivotHub(), px, py, pz, 0, 1, 'hub' + pv.zone.id);
        out.pivots.push({ tag: 'irrigation', x: px, y: py, z: pz, len: pv.len, key: pv.zone.id });
        out.cropCells = out.cropCells.concat(pv.cells);
      }
      // leak detection: 4 meter cabinets per level
      var nc = Math.min(loc.leak.length, 4 * cfg.lvl.leak_detection);
      for (k = 0; k < nc; k++) {
        var lk = loc.leak[k], lx = sX(lk.x) + 0.34, lz = sZ(lk.y) + 0.34, ly = ground(lx, lz);
        item('leak_detection', PARTS.cabinet(), lx, ly, lz, lk.a + Math.PI / 2, 1, 'cab' + k);
        bulb('leak_detection', lx, ly + 0.54, lz, 0x3cff6a, 2.2, 0.12, 0.05);
      }
      // reservoir upgrade: raised crest (L1) + intake tower (L2)
      if (cfg.lvl.reservoir_upgrade >= 1 && loc.dam) {
        var d = loc.dam, dx = 1, dy = 1, path = loc.path, di = loc.damIndex;
        if (path.length > 1 && di >= 0 && di < path.length) { var a = path[Math.max(0, di - 2)], b2 = path[Math.min(path.length - 1, di + 2)]; dx = b2.x - a.x; dy = b2.y - a.y; }
        var dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
        var res = world.reservoir || {}, spill = fin(res.spillElev, NaN), ci = clamp(Math.round(d.y), 0, N - 1) * N + clamp(Math.round(d.x), 0, N - 1);
        var bed = Math.min(fin(res.bedElev, world.elev[ci]), fin(world.elev[ci], 2200)); if (!isFinite(spill)) spill = bed + 45;
        var topY = C.elevToScene(spill) + 0.18, wc = 2; if (world.river && world.river.widths && di >= 0) wc = fin(world.river.widths[di], 2);
        var chord = clamp(wc + 4, 5, 9), segs = 10, sag = chord * 0.22, cp = [], pxr = -dy, pzr = dx;
        var bulge = function (t) { return sag * (1 - 4 * t * t); };
        for (q = 0; q < segs; q++) {
          var t0 = q / segs - 0.5, t1 = (q + 1) / segs - 0.5, tm = (t0 + t1) / 2;
          var x0 = pxr * t0 * chord - dx * bulge(t0), z0 = pzr * t0 * chord - dy * bulge(t0), x1 = pxr * t1 * chord - dx * bulge(t1), z1 = pzr * t1 * chord - dy * bulge(t1);
          var len = Math.hypot(x1 - x0, z1 - z0) * 1.08, ang = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
          cp.push(part(BOX, [0.8, 0.79, 0.76], pxr * tm * chord - dx * bulge(tm), 0.11, pzr * tm * chord - dy * bulge(tm), ang, len, 0.22, 0.5));
          if (q % 2 === 0) cp.push(part(BOX, [0.45, 0.46, 0.48], pxr * tm * chord - dx * bulge(tm), 0.3, pzr * tm * chord - dy * bulge(tm), ang, 0.1, 0.16, 0.06));
        }
        item('reservoir_upgrade', cp, sX(d.x), topY, sZ(d.y), 0, 1, 'crest');
        if (cfg.lvl.reservoir_upgrade >= 2 && loc.intake) {
          var ix = sX(loc.intake.x), iz = sZ(loc.intake.y), iy = C.elevToScene(bed) - 0.3, ih = Math.max(0.8, C.elevToScene(spill) + 0.4 - iy);
          item('reservoir_upgrade', PARTS.intakeTower(ih), ix, iy, iz, 0, 1, 'intake');
        }
      }
      // rain capture: cisterns beside houses (every 3rd at L1, two of three at L2)
      if (cfg.lvl.rain_capture >= 1) {
        var cis = [], sel = cfg.lvl.rain_capture >= 2 ? 1 : 0;
        loc.hoods.forEach(function (hz) { houseList(hz.id).forEach(function (h) { if (!h.burned && (h.i % 3 === 0 || (sel && h.i % 3 === 2))) cis.push(h); }); });
        cis.forEach(function (h) {
          var ox = 0.36 * h.s, oz = -0.08, cx = h.x + Math.cos(h.rot) * ox + Math.sin(h.rot) * oz, cz = h.z - Math.sin(h.rot) * ox + Math.cos(h.rot) * oz;
          item('rain_capture', PARTS.cistern(), cx, h.y + 0.02, cz, h.rot, 1, 'c' + h.i);
        });
      }
      // streamgages: 3 huts + SNOTEL
      if (cfg.lvl.streamgages >= 1) {
        loc.gauges.forEach(function (g, gi) { var gx = sX(g.x), gz = sZ(g.y), gy = ground(gx, gz); item('streamgages', PARTS.gauge(), gx, gy, gz, g.rot, 1, 'g' + gi); bulb('streamgages', gx + Math.cos(g.rot) * 0.12, gy + 0.97, gz - Math.sin(g.rot) * 0.12, 0x3cff6a, 1.6, 0.18, 0.06); });
        if (loc.snotel) { var nx = sX(loc.snotel.x), nz = sZ(loc.snotel.y), ny = ground(nx, nz); item('streamgages', PARTS.snotel(), nx, ny, nz, 0.4, 1, 'snotel'); bulb('streamgages', nx, ny + 1.92, nz, 0xffb03a, 2.4, 0.1, 0.06); }
      }
      // warning system: siren pole in each neighbourhood + civic core
      if (cfg.lvl.warning_system >= 1) {
        var sites = loc.hoods.map(function (hz) { return { x: hz.center.x + 0.45, y: hz.center.y + 0.45, key: 'h' + hz.id }; });
        sites.push({ x: loc.town.x + 0.45, y: loc.town.y - 0.45, key: 'civic' });
        sites.forEach(function (s) { var sx = sX(s.x), sz = sZ(s.y), sy = ground(sx, sz); item('warning_system', PARTS.siren(), sx, sy, sz, 0, 1, s.key); bulb('warning_system', sx, sy + 1.45, sz, 0xff3a2a, 1.0, 0.5, 0.1); });
      }
      // shelters: sign + rooftop HVAC on the school
      if (cfg.lvl.shelters >= 1 && loc.school) {
        var sb = loc.school, ss = clamp(fin(sb.scale, 1), 0.4, 3), sp = local(sb.x, sb.y, fin(sb.rot, 0), 0.95, 0.55), hp = local(sb.x, sb.y, fin(sb.rot, 0), 0.35 * ss, 0.05);
        var spx = sX(sp.x), spz = sZ(sp.y), hpx = sX(hp.x), hpz = sZ(hp.y);
        item('shelters', PARTS.shelterSign(), spx, ground(spx, spz), spz, fin(sb.rot, 0), 1, 'sign');
        item('shelters', PARTS.hvac(), hpx, ground(sX(sb.x), sZ(sb.y)) - 0.02 + 0.45 * ss, hpz, fin(sb.rot, 0), 1, 'hvac');
      }
      // treatment: tank + clarifier beside the plant
      if (cfg.lvl.treatment >= 1 && loc.tp) {
        var tp = loc.tp, tpp = local(tp.x, tp.y, fin(tp.rot, 0), -1.0, 0.1), tx = sX(tpp.x), tz = sZ(tpp.y);
        item('treatment', PARTS.tank(), tx, ground(tx, tz) - 0.02, tz, fin(tp.rot, 0) + Math.PI, 1, 'tank');   // rotated so the clarifier extends away from the plant
      }
      // stockpile at the fire station
      if (cfg.lvl.stockpile >= 1 && loc.fireStation) {
        var fs = loc.fireStation, fsp = local(fs.x, fs.y, fin(fs.rot, 0), -1.2, 0.25), fsx = sX(fsp.x), fsz = sZ(fsp.y);
        item('stockpile', PARTS.stockpile(), fsx, ground(fsx, fsz) - 0.02, fsz, fin(fs.rot, 0), 1, 'pile');
      }
      // boat inspection tent at the ramp
      if (cfg.lvl.mussel_inspection >= 1 && loc.ramp) {
        var rx2 = sX(loc.ramp.x), rz2 = sZ(loc.ramp.y), rrot = Math.atan2(sX(loc.resCenter.x) - rx2, sZ(loc.resCenter.y) - rz2);
        item('mussel_inspection', PARTS.tent(), rx2, ground(rx2, rz2) - 0.02, rz2, rrot, 1, 'tent');
      }
      // wildlife crossing sign + fence gap on the main road
      if (cfg.lvl.wildlife_corridor >= 1 && loc.wildlife) {
        var wl = loc.wildlife, wlp = local(wl.x, wl.y, wl.rot, 0.9, 0), wx2 = sX(wlp.x), wz2 = sZ(wlp.y);
        item('wildlife_corridor', PARTS.wildlife(), wx2, ground(wx2, wz2) - 0.02, wz2, wl.rot, 1, 'xing');
      }
      // outreach banner in front of the town hall
      if (cfg.lvl.outreach >= 1 && loc.hall) {
        var hb = loc.hall, hs = clamp(fin(hb.scale, 1), 0.4, 3), hbp = local(hb.x, hb.y, fin(hb.rot, 0), 0, 0.75 * hs), bx = sX(hbp.x), bz = sZ(hbp.y);
        item('outreach', PARTS.banner(), bx, ground(bx, bz) - 0.02, bz, fin(hb.rot, 0), 1, 'banner');
      }
      return out;
    }

    // ---------------------------------------------------------------- apply: write records into the persistent meshes
    var live = { rec: null, cfg: null, key: '', bulbs: [], pivots: [], willowBorn: null, ringN: 0, squareN: 0 };
    var time = 0;
    function rebuildUniques(items) {
      var parts = [], k, j;
      for (k = 0; k < items.length; k++) {
        var it = items[k], xf = xform(it.x, it.y, it.z, it.rot, it.s);
        for (j = 0; j < it.parts.length; j++) { var p = it.parts[j]; parts.push({ g: p.g, m: xf.clone().multiply(p.m), c: p.c }); }
      }
      if (uniquesMesh.geometry) uniquesMesh.geometry.dispose();
      if (!parts.length) { uniquesMesh.geometry = new THREE.BufferGeometry(); uniquesMesh.visible = false; return; }
      uniquesMesh.geometry = mergeParts(parts); uniquesMesh.visible = true;
    }
    function writeRings(list) {
      var n = Math.min(list.length, CAP_RINGS);
      for (var k = 0; k < n; k++) setInst(ringsMesh, k, list[k].x, list[k].y, list[k].z, 0, list[k].d, 0.03, list[k].d);
      ringsMesh.count = n; ringsMesh.instanceMatrix.needsUpdate = true; live.ringN = n;
    }
    function writeSquares(list) {
      var n = Math.min(list.length, CAP_SQUARES);
      for (var k = 0; k < n; k++) setInst(squaresMesh, k, list[k].x, list[k].y, list[k].z, 0, 1, 0.03, 1);
      squaresMesh.count = n; squaresMesh.instanceMatrix.needsUpdate = true; live.squareN = n;
    }
    function writeWillows(list, bornAt) {
      var n = Math.min(list.length, CAP_WILLOWS);
      live.willowBorn = new Float32Array(n); live.willows = list.slice(0, n);
      for (var k = 0; k < n; k++) { live.willowBorn[k] = bornAt == null ? -100 : bornAt + k * 0.03; writeWillow(k, bornAt == null ? 1 : 0); }
      willowMesh.count = n; willowMesh.instanceMatrix.needsUpdate = true;
    }
    function writeWillow(k, sc) { var w = live.willows[k]; setInst(willowMesh, k, w.x, w.y, w.z, w.rot, w.s * sc, w.s * sc, w.s * sc); }
    function writeBulbs(list) {
      var n = Math.min(list.length, CAP_BULBS), c = new THREE.Color();
      live.bulbs = list.slice(0, n);
      for (var k = 0; k < n; k++) { c.setHex(list[k].hex); bulbMesh.instanceColor.setXYZ(k, c.r, c.g, c.b); list[k].phase = hash(k, 9) * 3; }
      bulbMesh.count = n; bulbMesh.instanceColor.needsUpdate = true;
    }
    function setPivots(list) {
      var n = Math.min(list.length, CAP_PIVOTS);
      live.pivots = list.slice(0, n).map(function (p, k) { return { x: p.x, y: p.y, z: p.z, len: p.len, ang: hash(k, 17) * 6.28, grow: p.grow == null ? -100 : p.grow }; });
      armMesh.count = n;
    }
    function showWater(cells, zones, reveal) {
      var key = zones.join(',') + ':' + cells.length;
      if (key === waterKey) { if (reveal != null && waterMesh) water.reveal = reveal; return; }
      waterKey = key;
      if (waterMesh) { group.remove(waterMesh); waterMesh.geometry.dispose(); waterMesh = null; }
      if (!cells.length) return;
      var pos = [], sx = 0, sz = 0, k;
      for (k = 0; k < cells.length; k++) { sx += sX(cellX(cells[k])); sz += sZ(cellY(cells[k])); }
      water.cx = sx / cells.length; water.cz = sz / cells.length;
      for (k = 0; k < cells.length; k++) {
        var x0 = sX(cellX(cells[k])) - 0.5, z0 = sZ(cellY(cells[k])) - 0.5, x1 = x0 + 1, z1 = z0 + 1;
        var y00 = hAt(x0, z0) + 0.06, y10 = hAt(x1, z0) + 0.06, y01 = hAt(x0, z1) + 0.06, y11 = hAt(x1, z1) + 0.06;
        pos.push(x0 - water.cx, y00, z0 - water.cz, x0 - water.cx, y01, z1 - water.cz, x1 - water.cx, y11, z1 - water.cz, x0 - water.cx, y00, z0 - water.cz, x1 - water.cx, y11, z1 - water.cz, x1 - water.cx, y10, z0 - water.cz);
      }
      var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); g.computeBoundingSphere();
      waterMesh = new THREE.Mesh(g, matWater); waterMesh.name = 'wetlandWater'; waterMesh.position.set(water.cx, 0, water.cz); waterMesh.renderOrder = 2; waterMesh.frustumCulled = false;
      group.add(waterMesh);
      water.reveal = reveal == null ? -100 : reveal;
    }
    function applyRec(rec, opts2) {
      opts2 = opts2 || {};
      rebuildUniques(rec.items);
      writeRings(rec.rings); writeSquares(rec.squares); writeBulbs(rec.bulbs); setPivots(rec.pivots);
      writeWillows(rec.willows, opts2.willowBorn);
      showWater(rec.waterCells, rec.waterZones, opts2.waterReveal);
      if (props) {
        try {
          if (props.setThinnedZones) props.setThinnedZones(rec.thinned);
          if (props.setRoofStyle) loc.hoods.forEach(function (hz) { props.setRoofStyle(hz.id, rec.hardened.indexOf(hz.id) >= 0 ? 'metal' : 'default', 1); });
          if (props.clearCells && rec.clearCells.length) props.clearCells(rec.clearCells, BREAK_FRAC);
          if (props.setCropsCleared) props.setCropsCleared(rec.cropCells);
        } catch (e) { if (WS.DEBUG) console.error('[Builds] props hooks failed', e); }
      }
      live.rec = rec;
    }
    function apply(cfg, force, opts2) {
      var key = JSON.stringify(cfg);
      if (!force && key === live.key) return live.rec;
      live.key = key; live.cfg = cloneCfg(cfg);
      var rec = collect(cfg);
      applyRec(rec, opts2);
      return rec;
    }

    // ---------------------------------------------------------------- scene machinery
    var active = null, queue = Promise.resolve(), temps = [], crew = [], refreshAfter = null;
    function actor(kind) {
      var g = new THREE.Group(), body = new THREE.Mesh(mergeParts(PARTS[kind]()), matLit); body.castShadow = true; g.add(body); g.scale.setScalar(ACTOR_SCALE);
      if (PARTS[kind + 'Boom']) { var boom = new THREE.Mesh(mergeParts(PARTS[kind + 'Boom']()), matLit); boom.castShadow = true; boom.position.set(0.12, 0.5, 0.14); g.add(boom); g.userData.boom = boom; }
      tempGroup.add(g); temps.push(g); return g;
    }
    function placeActor(g, sx, sz, heading, lift) { g.position.set(sx, hAt(sx, sz) + (lift == null ? 0.02 : lift), sz); g.rotation.y = heading; }
    function riser(it, t0, dur) {
      var m = new THREE.Mesh(mergeParts(it.parts), matLit); m.castShadow = true;
      m.position.set(it.x, it.y, it.z); m.rotation.y = it.rot || 0; m.scale.set(it.s || 1, 0.001, it.s || 1); m.visible = false;
      tempGroup.add(m); temps.push(m);
      return { mesh: m, t0: t0, dur: dur, it: it, started: false, done: false };
    }
    function stepRisers(rs, t) {
      for (var k = 0; k < rs.length; k++) {
        var r = rs[k], u = (t - r.t0) / r.dur;
        if (u < 0) continue;
        if (!r.started) { r.started = true; r.mesh.visible = true; if (fx && fx.dustPuff) { var c = cellAt(r.it.x, r.it.z); if (c >= 0) fx.dustPuff(cellX(c), cellY(c), 5); } }
        r.mesh.scale.y = (r.it.s || 1) * Math.max(0.001, easeOut(Math.min(1, u)));
        if (u >= 1 && !r.done) { r.done = true; if (fx && fx.sparkle) { var c2 = cellAt(r.it.x, r.it.z); if (c2 >= 0) fx.sparkle(cellX(c2), cellY(c2), 6); } }
      }
    }
    function mergedRiser(items, t0, dur) { // many small items rise together as one mesh (rain-capture cisterns)
      var parts = [], k, j, cx = 0, cz = 0, cy = Infinity;
      for (k = 0; k < items.length; k++) { cx += items[k].x; cz += items[k].z; if (items[k].y < cy) cy = items[k].y; }
      cx /= items.length; cz /= items.length;
      for (k = 0; k < items.length; k++) {
        var it = items[k], xf = xform(it.x - cx, it.y - cy, it.z - cz, it.rot, it.s);
        for (j = 0; j < it.parts.length; j++) { var p = it.parts[j]; parts.push({ g: p.g, m: xf.clone().multiply(p.m), c: p.c }); }
      }
      return riser({ parts: parts, x: cx, y: cy, z: cz, rot: 0, s: 1 }, t0, dur);
    }
    function setCrew(list) { crew = list; crewMesh.count = Math.min(list.length, CAP_CREW); }
    function stepCrew() {
      for (var k = 0; k < crew.length && k < CAP_CREW; k++) {
        var c = crew[k], bob = c.walking ? 0.03 * Math.abs(Math.sin(time * 10 + k * 1.3)) : 0.006 * Math.sin(time * 2 + k);
        setInst(crewMesh, k, c.x, hAt(c.x, c.z) + bob, c.z, c.heading, CREW_SCALE, CREW_SCALE, CREW_SCALE);
      }
      if (crew.length) crewMesh.instanceMatrix.needsUpdate = true;
    }
    function cleanupTemp() {
      for (var k = 0; k < temps.length; k++) {
        var t = temps[k]; tempGroup.remove(t);
        t.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
      }
      temps.length = 0; setCrew([]); crewMesh.count = 0;
    }
    function pathAt(pts, u, out) { // polyline [{x,z}], u 0..1 → position + heading
      var total = 0, k, segs = [];
      for (k = 1; k < pts.length; k++) { var l = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z); segs.push(l); total += l; }
      var s = clamp(u, 0, 1) * total, acc = 0;
      for (k = 0; k < segs.length; k++) {
        if (s <= acc + segs[k] || k === segs.length - 1) {
          var t = segs[k] > 1e-6 ? clamp((s - acc) / segs[k], 0, 1) : 0, a = pts[k], b = pts[k + 1];
          out.x = a.x + (b.x - a.x) * t; out.z = a.z + (b.z - a.z) * t; out.heading = Math.atan2(b.x - a.x, b.z - a.z); return out;
        }
        acc += segs[k];
      }
      out.x = pts[0].x; out.z = pts[0].z; out.heading = 0; return out;
    }
    function driveIn(target, heading, dist) { // straight approach path ending at target
      return [{ x: target.x - Math.sin(heading) * dist, z: target.z - Math.cos(heading) * dist }, { x: target.x, z: target.z }];
    }
    function nearestRoadPath(cx, cy, span) { // scene-space polyline along the road polyline nearest to cell (cx,cy)
      var roads = Array.isArray(world.roads) ? world.roads : [], best = null, bd = Infinity, k, i;
      for (k = 0; k < roads.length; k++) {
        var pl = roads[k]; if (!pl || pl.length < 2) continue;
        for (i = 0; i < pl.length; i++) { var d = Math.hypot(pl[i].x - cx, pl[i].y - cy); if (d < bd) { bd = d; best = pl; } }
      }
      if (!best) return null;
      var pts = best.map(function (p) { return { x: sX(p.x), z: sZ(p.y) }; });
      if (span && pts.length === 2) { // trim a long two-point road to a window around the site
        var a = pts[0], b = pts[1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1, ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
        var t0 = clamp(((sX(cx) - a.x) * ux + (sZ(cy) - a.z) * uz) - span, 0, L), t1 = clamp(t0 + 2 * span, 0, L);
        pts = [{ x: a.x + ux * t0, z: a.z + uz * t0 }, { x: a.x + ux * t1, z: a.z + uz * t1 }];
      }
      return pts;
    }
    function diffItems(recA, recB, tag) { // records in B (tag) whose key is absent in A
      var have = {}, k, out = [];
      for (k = 0; k < recA.items.length; k++) have[recA.items[k].key] = 1;
      for (k = 0; k < recB.items.length; k++) if (recB.items[k].tag === tag && !have[recB.items[k].key]) out.push(recB.items[k]);
      return out;
    }

    // ---------------------------------------------------------------- per-project scenes
    // each maker(ctx) → { dur, update(t, dt), end() } or null;  ctx = { id, zone, zoneId, recStart, recEnd, cfgEnd }
    function genericScene(ctx, vehicleKind, site, heading, opts3) {
      opts3 = opts3 || {};
      var items = diffItems(ctx.recStart, ctx.recEnd, ctx.id);
      if (!items.length && !opts3.allowEmpty) return null;
      var t0 = 1.1, risers = [], k;
      if (items.length > MANY_ITEMS) risers.push(mergedRiser(items, t0, 1.6));
      else for (k = 0; k < items.length; k++) risers.push(riser(items[k], t0 + k * 0.45, 1.0));
      var dur = clamp(t0 + (items.length > MANY_ITEMS ? 1.6 : items.length * 0.45 + 1.0) + 0.8, 3.2, 5.2);
      var veh = vehicleKind ? actor(vehicleKind) : null, vpath = veh ? driveIn(site, heading, 3.5) : null, pt = { x: 0, z: 0, heading: 0 };
      var crewN = opts3.crew == null ? 3 : opts3.crew, list = [];
      for (k = 0; k < crewN; k++) list.push({ x: site.x, z: site.z, heading: 0, walking: true, tx: site.x, tz: site.z });
      setCrew(list);
      return {
        dur: dur,
        update: function (t, dt) {
          if (veh) { pathAt(vpath, Math.min(1, t / 1.0), pt); placeActor(veh, pt.x, pt.z, pt.heading, 0.02); }
          for (k = 0; k < list.length; k++) {
            var c = list[k], goal = items.length ? items[Math.min(items.length - 1, Math.floor(k * items.length / Math.max(1, list.length)))] : site;
            var gx = (goal.x != null ? goal.x : site.x) + 0.55 * Math.cos(k * 2.1 + 0.4), gz = (goal.z != null ? goal.z : site.z) + 0.55 * Math.sin(k * 2.1 + 0.4);
            if (t < 0.7) { c.x = site.x + (k - 1) * 0.3; c.z = site.z + 0.5; c.walking = false; c.heading = 0; }
            else { var dx = gx - c.x, dz = gz - c.z, d = Math.hypot(dx, dz); if (d > 0.05) { var st = Math.min(d, 1.4 * dt); c.x += dx / d * st; c.z += dz / d * st; c.heading = Math.atan2(dx, dz); c.walking = true; } else c.walking = false; }
          }
          stepRisers(risers, t);
        },
        end: noop
      };
    }
    var SCENES = {
      forest_thinning: function (ctx) {
        var z = ctx.zone; if (!z || !z.bbox) return null;
        var bb = z.bbox, w = bb.x1 - bb.x0, h = bb.y1 - bb.y0, alongX = w >= h, R = clamp((alongX ? w : h) / 2 - 1, 3, 7);
        var cx = sX(z.center.x), cz = sZ(z.center.y), dx = alongX ? 1 : 0, dz = alongX ? 0 : 1;
        var pts = [{ x: cx - dx * R, z: cz - dz * R }, { x: cx + dx * R, z: cz + dz * R }], pt = { x: 0, z: 0, heading: 0 };
        var mach = actor('feller'), dropAcc = 0, dur = 4.6, list = [{ x: cx, z: cz, heading: 0, walking: true }, { x: cx, z: cz, heading: 0, walking: true }];
        setCrew(list);
        return {
          dur: dur,
          update: function (t, dt) {
            var u = ease(Math.min(1, t / (dur - 0.4)));
            pathAt(pts, u, pt); placeActor(mach, pt.x, pt.z, pt.heading, 0.02 + 0.01 * Math.sin(t * 15));
            if (mach.userData.boom) { mach.userData.boom.rotation.x = -0.35 + 0.3 * Math.sin(t * 5.5); mach.userData.boom.rotation.y = 0.25 * Math.sin(t * 2.1); }
            for (var k = 0; k < 2; k++) { var c = list[k]; c.x = pt.x - Math.sin(pt.heading) * (1.1 + k * 0.5) + Math.cos(pt.heading) * (k ? 0.35 : -0.35); c.z = pt.z - Math.cos(pt.heading) * (1.1 + k * 0.5) - Math.sin(pt.heading) * (k ? 0.35 : -0.35); c.heading = pt.heading; c.walking = u < 1; }
            dropAcc += dt;
            while (dropAcc >= 0.12) {
              dropAcc -= 0.12;
              if (!props || !props.dropTree) break;
              var cands = [], ci = cellAt(pt.x, pt.z);
              if (ci < 0) break;
              var x0 = cellX(ci), y0 = cellY(ci);
              for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) { var xx = x0 + ox, yy = y0 + oy; if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue; var cc = yy * N + xx; if (world.zone && world.zone[cc] !== z.id) continue; if (props.treesInCell(cc) > 0) cands.push(cc); }
              if (!cands.length) continue;
              var pick = cands[Math.floor(Math.random() * cands.length)];
              if (props.dropTree(pick) && fx && fx.dustPuff) fx.dustPuff(cellX(pick), cellY(pick), 4);
            }
            if (fx && fx.dustPuff && Math.random() < dt * 6) { var mc = cellAt(pt.x, pt.z); if (mc >= 0) fx.dustPuff(cellX(mc), cellY(mc), 2); }
          },
          end: noop
        };
      },
      prescribed_burn: function (ctx) {
        var bl = burnLine(ctx.zone); if (!bl) return null;
        var line = bl.cells;
        var pts = line.map(function (ci) { return { x: sX(cellX(ci)), z: sZ(cellY(ci)) }; }), pt = { x: 0, z: 0, heading: 0 }, pt2 = { x: 0, z: 0, heading: 0 };
        var list = [{ x: pts[0].x, z: pts[0].z, heading: 0, walking: true }, { x: pts[0].x, z: pts[0].z, heading: 0, walking: true }];
        setCrew(list);
        var torch = new THREE.Mesh(mergeParts(PARTS.torchCan()), matLit); torch.scale.setScalar(CREW_SCALE); tempGroup.add(torch); temps.push(torch);
        var dur = 4.4, fireAcc = 0, lit = 0;
        return {
          dur: dur,
          update: function (t, dt) {
            var u = Math.min(1, t / (dur - 0.6));
            pathAt(pts, u, pt); pathAt(pts, Math.max(0, u - 0.06), pt2);
            list[0].x = pt.x + Math.cos(pt.heading) * 0.3; list[0].z = pt.z - Math.sin(pt.heading) * 0.3; list[0].heading = pt.heading; list[0].walking = u < 1;
            list[1].x = pt2.x - Math.cos(pt.heading) * 0.3; list[1].z = pt2.z + Math.sin(pt.heading) * 0.3; list[1].heading = pt2.heading; list[1].walking = u < 1;
            torch.position.set(list[0].x, hAt(list[0].x, list[0].z) + 0.02, list[0].z); torch.rotation.y = pt.heading;
            fireAcc += dt;
            if (fireAcc >= 0.15 && fx && fx.setFire) {
              fireAcc = 0;
              var upto = Math.min(line.length, Math.floor(u * line.length) + 1);
              lit = upto;
              var burning = line.slice(Math.max(0, upto - 5), upto), trail = line.slice(Math.max(0, upto - 15), Math.max(0, upto - 5));
              if (u >= 1) { burning = []; trail = line.slice(Math.max(0, line.length - 15)); }
              fx.setFire(burning, trail);
            }
          },
          end: function () { if (fx && fx.setFire) fx.setFire([], []); }
        };
      },
      home_hardening: function (ctx) {
        var z = ctx.zone; if (!z) return null;
        var houses = houseList(z.id), rings = ctx.recEnd.rings.filter(function (r) { return r.zone === z.id; }), road = nearestRoadPath(z.center.x, z.center.y, 4);
        var truck = actor('pickup'), pt = { x: 0, z: 0, heading: 0 }, dur = 4.5, placed = 0, k;
        var list = [], base = live.ringN, spots = houses.length ? houses : [{ x: sX(z.center.x), z: sZ(z.center.y) }];
        for (k = 0; k < 3; k++) list.push({ x: sX(z.center.x), z: sZ(z.center.y), heading: 0, walking: false });
        setCrew(list);
        if (props && props.setRoofStyle) props.setRoofStyle(z.id, 'default', 1);
        return {
          dur: dur,
          update: function (t) {
            var u = Math.min(1, t / (dur - 0.5));
            if (road) { pathAt(road, 0.5 + 0.45 * Math.sin(t * 0.9), pt); placeActor(truck, pt.x, pt.z, pt.heading + (Math.cos(t * 0.9) < 0 ? Math.PI : 0)); }
            else placeActor(truck, sX(z.center.x) + 0.6, sZ(z.center.y), 0.3);
            var want = Math.min(rings.length, Math.floor(u * rings.length));
            while (placed < want && base + placed < CAP_RINGS) {
              var r = rings[placed]; setInst(ringsMesh, base + placed, r.x, r.y, r.z, 0, r.d, 0.03, r.d); placed++;
              ringsMesh.count = base + placed; ringsMesh.instanceMatrix.needsUpdate = true;
              if (fx && fx.sparkle && (placed % 2 === 0)) { var c = cellAt(r.x, r.z); if (c >= 0) fx.sparkle(cellX(c), cellY(c), 4); }
            }
            if (props && props.setRoofStyle) props.setRoofStyle(z.id, 'metal', u);
            for (k = 0; k < list.length; k++) { var h = spots[Math.min(spots.length - 1, Math.floor(u * spots.length * 0.97) + k) % spots.length]; list[k].x = h.x + 0.45 * Math.cos(t * 1.4 + k * 2); list[k].z = h.z + 0.45 * Math.sin(t * 1.4 + k * 2); list[k].heading = t * 1.4 + k * 2 + Math.PI / 2; list[k].walking = true; }
          },
          end: noop
        };
      },
      fuel_break: function (ctx) {
        var z = ctx.zone; if (!z || !z.bbox) return null;
        var bb = z.bbox, x0 = sX(bb.x0) - 1.5, x1 = sX(bb.x1) + 1.5, z0 = sZ(bb.y0) - 1.5, z1 = sZ(bb.y1) + 1.5;
        var pts = [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }, { x: x0, z: z0 }], pt = { x: 0, z: 0, heading: 0 };
        var squares = ctx.recEnd.squares.filter(function (s) { return s.zone === z.id; }), doneCell = {}, base = live.squareN, placed = 0, dur = 5.0, dozer = actor('dozer');
        var list = [{ x: x0, z: z0, heading: 0, walking: true }, { x: x0, z: z0, heading: 0, walking: true }];
        setCrew(list);
        return {
          dur: dur,
          update: function (t, dt) {
            var u = Math.min(1, t / (dur - 0.3));
            pathAt(pts, u, pt); placeActor(dozer, pt.x, pt.z, pt.heading, 0.02 + 0.008 * Math.sin(t * 17));
            for (var k = 0; k < 2; k++) { list[k].x = pt.x - Math.sin(pt.heading) * (0.9 + k * 0.45) + Math.cos(pt.heading) * (k ? 0.3 : -0.3); list[k].z = pt.z - Math.cos(pt.heading) * (0.9 + k * 0.45) - Math.sin(pt.heading) * (k ? 0.3 : -0.3); list[k].heading = pt.heading; list[k].walking = u < 1; }
            var dropped = 0;
            for (var q = 0; q < squares.length; q++) {
              var s = squares[q]; if (doneCell[s.cell]) continue;
              if (Math.hypot(s.x - pt.x, s.z - pt.z) > 1.7) continue;
              doneCell[s.cell] = 1;
              if (base + placed < CAP_SQUARES) { setInst(squaresMesh, base + placed, s.x, s.y, s.z, 0, 1, 0.03, 1); placed++; squaresMesh.count = base + placed; squaresMesh.instanceMatrix.needsUpdate = true; }
              if (props && props.dropTree && dropped < 3 && hash(s.cell, 321) < BREAK_FRAC) { if (props.dropTree(s.cell)) dropped++; }
              if (fx && fx.dustPuff) fx.dustPuff(cellX(s.cell), cellY(s.cell), 3);
            }
            if (fx && fx.dustPuff && Math.random() < dt * 8) { var mc = cellAt(pt.x, pt.z); if (mc >= 0) fx.dustPuff(cellX(mc), cellY(mc), 2); }
          },
          end: noop
        };
      },
      warning_system: function (ctx) { var s = { x: sX(loc.town.x), z: sZ(loc.town.y) }; return genericScene(ctx, 'crewTruck', s, 0.6); },
      streamgages: function (ctx) { var g = loc.gauges[1] || loc.gauges[0], s = g ? { x: sX(g.x) + 0.8, z: sZ(g.y) + 0.6 } : { x: sX(loc.town.x), z: sZ(loc.town.y) }; return genericScene(ctx, 'crewTruck', s, 1.2); },
      wetland: function (ctx) {
        var z = ctx.zone; if (!z) return null;
        var dams = diffItems(ctx.recStart, ctx.recEnd, 'wetland'), risers = [], k, t0 = 0.6;
        for (k = 0; k < dams.length; k++) risers.push(riser(dams[k], t0 + k * 0.45, 0.9));
        var tw = t0 + dams.length * 0.45 + 0.4, dur = clamp(tw + 2.4, 3.5, 5.4), revealed = false, list = [];
        for (k = 0; k < 3; k++) list.push({ x: sX(z.center.x), z: sZ(z.center.y), heading: 0, walking: true });
        setCrew(list);
        var willows = ctx.recEnd.willows.filter(function (w) { return w.tag === 'wetland'; });
        return {
          dur: dur,
          update: function (t) {
            stepRisers(risers, t);
            for (k = 0; k < list.length; k++) { var d = dams[Math.min(dams.length - 1, Math.floor(Math.min(0.999, t / Math.max(0.1, tw)) * dams.length) + k) % Math.max(1, dams.length)] || { x: sX(z.center.x), z: sZ(z.center.y) }; list[k].x = d.x + 0.7 * Math.cos(k * 2.1 + t * 0.6); list[k].z = d.z + 0.7 * Math.sin(k * 2.1 + t * 0.6); list[k].heading = k * 2.1 + t * 0.6 + Math.PI / 2; }
            if (!revealed && t >= tw) {
              revealed = true;
              showWater(ctx.recEnd.waterCells, ctx.recEnd.waterZones, time);
              writeWillows(willows, time + 0.6);
            }
          },
          end: noop
        };
      },
      irrigation: function (ctx) {
        var hubs = diffItems(ctx.recStart, ctx.recEnd, 'irrigation'); if (!hubs.length) return null;
        var site = { x: hubs[0].x + 1.2, z: hubs[0].z + 0.8 }, sc = genericScene(ctx, 'crewTruck', site, 0.9); if (!sc) return null;
        var have = {}, k; for (k = 0; k < live.pivots.length; k++) have[live.pivots[k].key] = 1;
        var fresh = ctx.recEnd.pivots.filter(function (p) { return !have[p.key]; }), added = false, inner = sc.update;
        sc.update = function (t, dt) {
          inner(t, dt);
          if (!added && t >= 1.9) { added = true; var list = live.pivots.slice(); for (k = 0; k < fresh.length; k++) list.push({ x: fresh[k].x, y: fresh[k].y, z: fresh[k].z, len: fresh[k].len, key: fresh[k].key, grow: time }); setPivots(list); if (props && props.setCropsCleared) props.setCropsCleared(ctx.recEnd.cropCells); }
        };
        return sc;
      },
      treatment: function (ctx) { var tp = loc.tp; if (!tp) return null; return genericScene(ctx, 'crewTruck', { x: sX(tp.x) - 0.4, z: sZ(tp.y) + 1.3 }, 0.2); },
      reservoir_upgrade: function (ctx) { var d = loc.dam; if (!d) return null; return genericScene(ctx, 'crewTruck', { x: sX(d.x) + 1.6, z: sZ(d.y) + 1.4 }, 0.5, { crew: 3 }); },
      leak_detection: function (ctx) {
        var cabs = diffItems(ctx.recStart, ctx.recEnd, 'leak_detection'); if (!cabs.length) return null;
        var site = { x: cabs[0].x - 0.5, z: cabs[0].z - 0.3 }, exc = actor('excavator'), dirt = riser({ parts: PARTS.dirt(), x: site.x + 0.9, y: hAt(site.x + 0.9, site.z) - 0.02, z: site.z, rot: 0, s: 1 }, 0.3, 0.6), risers = [dirt], k, dur = 4.8;
        placeActor(exc, site.x, site.z, Math.PI / 2);
        for (k = 0; k < cabs.length; k++) risers.push(riser(cabs[k], 2.6 + k * 0.35, 0.8));
        var list = []; for (k = 0; k < 3; k++) list.push({ x: site.x + 0.7 * Math.cos(k * 2.1), z: site.z + 0.7 * Math.sin(k * 2.1), heading: k * 2.1 + Math.PI, walking: false });
        setCrew(list);
        var puffAcc = 0;
        return {
          dur: dur,
          update: function (t, dt) {
            if (exc.userData.boom) { exc.userData.boom.rotation.x = -0.5 + 0.45 * Math.sin(t * 3.2); exc.userData.boom.rotation.y = 0.35 * Math.sin(t * 1.6); }
            puffAcc += dt; if (puffAcc > 0.5 && fx && fx.dustPuff) { puffAcc = 0; var c = cellAt(site.x + 0.9, site.z); if (c >= 0) fx.dustPuff(cellX(c), cellY(c), 5); }
            stepRisers(risers, t);
          },
          end: noop
        };
      },
      shelters: function (ctx) { var sb = loc.school; if (!sb) return null; return genericScene(ctx, 'pickup', { x: sX(sb.x) + 1.4, z: sZ(sb.y) + 1.2 }, 0.3, { crew: 2 }); },
      mussel_inspection: function (ctx) { var r = loc.ramp; if (!r) return null; return genericScene(ctx, 'crewTruck', { x: sX(r.x) + 1.2, z: sZ(r.y) + 0.9 }, 2.0, { crew: 2 }); },
      rain_capture: function (ctx) { var hz = loc.hoods[0]; if (!hz) return null; return genericScene(ctx, 'pickup', { x: sX(hz.center.x), z: sZ(hz.center.y) }, 0.6, { crew: 2 }); },
      stockpile: function (ctx) { var fs = loc.fireStation; if (!fs) return null; return genericScene(ctx, 'crewTruck', { x: sX(fs.x) - 1.6, z: sZ(fs.y) + 1.1 }, 1.0, { crew: 2 }); },
      wildlife_corridor: function (ctx) { var w = loc.wildlife; if (!w) return null; return genericScene(ctx, 'pickup', { x: sX(w.x) + 0.6, z: sZ(w.y) - 0.6 }, w.rot, { crew: 2 }); },
      outreach: function (ctx) { var hb = loc.hall; if (!hb) return null; return genericScene(ctx, null, { x: sX(hb.x) + 0.8, z: sZ(hb.y) + 1.4 }, 0, { crew: 2 }); }
    };

    // ---------------------------------------------------------------- play / installed / update
    function runScene(projectId, zoneId, state) {
      return new Promise(function (resolve) {
        var maker = SCENES[projectId], done = false, sc = null, zone = zoneId == null ? null : zoneById(zoneId), timer = null;
        var cfgFull, cfgStart, recStart, recEnd;
        function finish() {
          if (done) return; done = true;
          if (timer) clearTimeout(timer);
          try { if (sc && sc.end) sc.end(); } catch (e) { if (WS.DEBUG) console.error('[Builds] scene end failed', e); }
          cleanupTemp(); active = null;
          try {
            var cfgEnd = currentCfg(state), global = !ZONE_KEY[projectId] && projectId !== 'forest_thinning';
            // did the game record this project in state? (normal flow: fund → play). If not, keep showing it via `pending`
            // until state catches up. A replay of an already-funded project therefore never adds phantom levels.
            var has = includes(cfgEnd, projectId, zoneId);
            if (!has && projectId !== 'prescribed_burn' && (global ? cfgEnd.lvl.hasOwnProperty(projectId) : true)) {
              cfgEnd = adjust(cfgEnd, projectId, zoneId, 1);
              pending.push({ id: projectId, zone: zoneId, lvl: global ? cfgEnd.lvl[projectId] : 1 });
            }
            apply(cfgEnd, true);
          } catch (e2) { if (WS.DEBUG) console.error('[Builds] finalize failed', e2); }
          resolve();
        }
        try {
          if (!maker || ((ZONE_KEY[projectId] || projectId === 'forest_thinning' || projectId === 'prescribed_burn') && !zone)) { resolve(); return; }
          cfgFull = currentCfg(state);
          cfgStart = adjust(cfgFull, projectId, zoneId, -1);
          recStart = apply(cfgStart, true);
          recEnd = collect(adjust(cfgStart, projectId, zoneId, 1));
          sc = maker({ id: projectId, zone: zone, zoneId: zoneId, recStart: recStart, recEnd: recEnd });
          if (!sc) { finish(); return; }
          sc.t = 0; active = { sc: sc, finish: finish };
          timer = setTimeout(finish, (sc.dur + 2.5) * 1000);   // resolves even if the render loop is paused
        } catch (e) { if (WS.DEBUG) console.error('[Builds] play failed', e); finish(); }
      });
    }
    // ---- player approach (SPEC3 §C): the director runs to a spot ~2 cells from the site, faces it and points for the scene
    var PLAYER_CAP_MS = 2500, PLAYER_STAND = 2;
    function hasPlayer() { return !!(props && typeof props.movePlayerTo === 'function' && typeof props.playerObject === 'function' && props.playerObject()); }
    function standSpot(site) {
      var pp = (typeof props.playerPosition === 'function') ? props.playerPosition() : null;
      var ang0 = pp ? Math.atan2(pp.y - site.y, pp.x - site.x) : 0.8, k, a, x, y, l;
      for (k = 0; k < 8; k++) {                                     // nearest side first, then fan out around the site
        a = ang0 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 0.8;
        x = site.x + Math.cos(a) * PLAYER_STAND; y = site.y + Math.sin(a) * PLAYER_STAND;
        l = landXY(x, y);
        if (l >= 0 && !isWater(l)) return { x: x, y: y };
      }
      return null;
    }
    function approach(id, zid) {
      var site = null, spot = null, timer = null;
      try { if (hasPlayer()) { site = siteFor(id, zid); spot = site ? standSpot(site) : null; } } catch (e) { spot = null; }
      if (!spot) return Promise.resolve();
      var face = { x: site.x, y: site.y };
      var walk = Promise.resolve().then(function () { return props.movePlayerTo(spot.x, spot.y, { run: true, face: face }); });
      var cap = new Promise(function (res) { timer = setTimeout(function () { res('late'); }, PLAYER_CAP_MS); });
      return Promise.race([walk, cap]).then(function (r) {
        if (timer) clearTimeout(timer);
        if (r === 'late' && typeof props.teleportPlayer === 'function') props.teleportPlayer(spot.x, spot.y, { face: face });
        if ((r === true || r === 'late') && typeof props.setPlayerAction === 'function') props.setPlayerAction('point');
      }).catch(function () { if (timer) clearTimeout(timer); });
    }
    function clearPlayerAction() { try { if (hasPlayer() && typeof props.setPlayerAction === 'function') props.setPlayerAction(null); } catch (e) { /* ignore */ } }
    function play(projectId, zoneId, state) {
      var id = String(projectId || ''), zid = (zoneId == null || zoneId === '') ? null : +zoneId;
      var p = queue.then(function () { return approach(id, zid); })
        .then(function () { return runScene(id, zid, state); })
        .catch(function () {})
        .then(clearPlayerAction);
      queue = p;
      return p;
    }
    function installed(state) {
      try {
        if (active) { refreshAfter = state; return; }
        apply(currentCfg(state), false);
      } catch (e) { if (WS.DEBUG) console.error('[Builds] installed failed', e); }
    }
    function update(dt) {
      dt = clamp(fin(dt, 0.016), 0, 0.1); time += dt;
      var k;
      if (active) {
        var sc = active.sc; sc.t += dt;
        try { sc.update(sc.t, dt); } catch (e) { if (WS.DEBUG) console.error('[Builds] scene update failed', e); sc.t = sc.dur; }
        if (sc.t >= sc.dur) { var fin_ = active.finish; fin_(); if (refreshAfter) { var s = refreshAfter; refreshAfter = null; installed(s); } }
      }
      stepCrew();
      // blinking bulbs
      var nb = Math.min(live.bulbs.length, CAP_BULBS);
      for (k = 0; k < nb; k++) { var b = live.bulbs[k], on = ((time + b.phase) % b.period) < b.period * b.duty, s2 = on ? b.size : 0.0001; setInst(bulbMesh, k, b.x, b.y, b.z, 0, s2, s2, s2); }
      if (nb) bulbMesh.instanceMatrix.needsUpdate = true;
      // pivot arms
      for (k = 0; k < live.pivots.length; k++) { var p = live.pivots[k]; p.ang += dt * 0.12; var g = easeOut((time - p.grow) / 1.2); setInst(armMesh, k, p.x, p.y, p.z, p.ang, Math.max(0.001, p.len * g), 1, 1); }
      if (live.pivots.length) armMesh.instanceMatrix.needsUpdate = true;
      // willow pop-in
      if (live.willowBorn && live.willows) {
        var any = false;
        for (k = 0; k < live.willows.length; k++) { var age = time - live.willowBorn[k]; if (age < 0) { writeWillow(k, 0.001); any = true; } else if (age < 1.2) { writeWillow(k, pop(age / 1.0)); any = true; } else if (age < 1.3) { writeWillow(k, 1); any = true; } }
        if (any) willowMesh.instanceMatrix.needsUpdate = true;
      }
      // wetland water spread
      if (waterMesh) {
        var wu = water.reveal < 0 ? 1 : clamp((time - water.reveal) / 2.0, 0, 1), ws = 0.15 + 0.85 * easeOut(wu);
        waterMesh.scale.set(ws, 1, ws); matWater.opacity = 0.55 * easeOut(wu);
      }
    }
    function siteFor(projectId, zoneId) {
      var id = String(projectId || ''), z = zoneId == null ? null : zoneById(+zoneId), o = null;
      function at(x, y, d) { return (x == null || y == null || !isFinite(x)) ? null : { x: Math.round(x), y: Math.round(y), dist: d }; }
      if (id === 'prescribed_burn' && z) { var bl = burnLine(z); if (bl) return at(bl.x, bl.y, 30); }
      if (z && z.center) { o = at(z.center.x, z.center.y, z.type === 'forest' ? 26 : (z.type === 'farm' ? 34 : 30)); if (o) return o; }
      switch (id) {
        case 'warning_system': return at(loc.town.x, loc.town.y, 40);
        case 'streamgages': { var g = loc.gauges[1] || loc.gauges[0]; return g ? at(g.x, g.y, 34) : at(loc.town.x, loc.town.y, 40); }
        case 'irrigation': { var pv = loc.pivots[0]; return pv ? at(pv.x, pv.y, 34) : null; }
        case 'treatment': return loc.tp ? at(loc.tp.x, loc.tp.y, 26) : null;
        case 'reservoir_upgrade': return loc.dam ? at(loc.dam.x, loc.dam.y, 30) : null;
        case 'leak_detection': { var lk = loc.leak[0]; return lk ? at(lk.x, lk.y, 26) : at(loc.town.x, loc.town.y, 30); }
        case 'shelters': return loc.school ? at(loc.school.x, loc.school.y, 24) : null;
        case 'mussel_inspection': return loc.ramp ? at(loc.ramp.x, loc.ramp.y, 26) : null;
        case 'rain_capture': { var hz = loc.hoods[0]; return hz ? at(hz.center.x, hz.center.y, 30) : null; }
        case 'stockpile': return loc.fireStation ? at(loc.fireStation.x, loc.fireStation.y, 24) : null;
        case 'wildlife_corridor': return loc.wildlife ? at(loc.wildlife.x, loc.wildlife.y, 26) : null;
        case 'outreach': return loc.hall ? at(loc.hall.x, loc.hall.y, 24) : null;
      }
      return null;
    }
    function stats() {
      var dc = 0;
      group.traverse(function (o) { if (o.isMesh && o.visible && (o.count == null || o.count > 0) && o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.count > 0) dc++; });
      return { drawCalls: dc, items: live.rec ? live.rec.items.length : 0, sceneActive: !!active, pending: pending.length };
    }
    function dispose() {
      if (active) { try { active.finish(); } catch (e) { /* ignore */ } }
      cleanupTemp();
      try { if (group.parent) group.parent.remove(group); } catch (e) { /* ignore */ }
      if (waterMesh) waterMesh.geometry.dispose();
      if (uniquesMesh.geometry) uniquesMesh.geometry.dispose();
      for (var k = 0; k < disposables.length; k++) { try { disposables[k].dispose(); } catch (e) { /* ignore */ } }
      for (k = 0; k < baseGeoms.length; k++) baseGeoms[k].dispose();
      live.bulbs = []; live.pivots = []; live.willows = []; live.willowBorn = null;
    }

    return { play: play, installed: installed, update: update, siteFor: siteFor, stats: stats, dispose: dispose, group: group, _loc: loc, _live: live };
  }

  WS.Builds = { init: init, PROJECT_IDS: Object.keys(ZONE_KEY).concat(['prescribed_burn'], GLOBAL_IDS) };
})();
