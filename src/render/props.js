/* Watershed — props renderer (trees, buildings, farms, roads, dam, life). Export WS.Props.
   Browser only (needs global THREE r128). API:
     WS.Props.build(world, scene, opts) → props
       opts = { heightAt(sx, sz) → sceneY }   (fallback: cell elevation via WS.C.toScene)
     props.refresh(world, state)      // after fire/flood/season: snags, burned houses, crops, snow
     props.setSeason(seasonIdx, {snowlineElev})
     props.update(dt, state)          // life animation, burning-tree flicker
     props.setFire(burningIdx)        // [] to clear
     props.setWind(dirRad, mph)
     props.dispose()
*/
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};

  // ------------------------------------------------------------------ tuning
  var TARGET_CONIFERS = 16000, MAX_CONIFERS = 20000, CONIFER_FACTOR_MIN = 0.4, CONIFER_FACTOR_MAX = 2.5;
  var MAX_ASPENS = 4000, ASPEN_MAX_ELEV = 2500, ASPEN_FOREST_FRAC = 0.3;
  var MAX_SNAGS = 9000, SNAG_BURN = 0.35, HOUSE_BURN = 0.5;
  var SAGE_EVERY = 3, MAX_SAGE = 4000;
  var MAX_HOUSES = 700, MAX_BARNS = 24, MAX_CROPS = 4000, MAX_HAY = 300, HAY_EVERY = 9, MAX_FENCE = 1600;
  // life
  var N_PEOPLE = 40, N_ELK = 24, N_TRUCKS = 3, N_CARS = 3, N_BIRDS = 10;
  var PEOPLE_SPEED_MIN = 0.25, PEOPLE_SPEED_MAX = 0.45, PEOPLE_SIDE = 0.28;
  var ELK_SPEED = 0.35, ELK_FLEE_SPEED = 1.6, ELK_FLEE_RADIUS = 14, ELK_ROAM = 12;
  var TRUCK_SPEED = 3.0, CAR_SPEED = 2.0, BIRD_HEIGHT = 4.0;
  var ROAD_WIDTH = 0.5, ROAD_LIFT = 0.05, ROAD_STEP = 0.5;
  var MAX_BURNING_INST = 8000;
  var SNOWLINE_BY_SEASON = [0, 500, 1000, 700]; // added to world.snowlineElev when no snowline is supplied (summer → effectively >3600)

  // ------------------------------------------------------------------ helpers
  function hash(i, k) { var x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function rgb(hex, mul) { mul = (mul == null) ? 1 : mul; return [((hex >> 16) & 255) / 255 * mul, ((hex >> 8) & 255) / 255 * mul, (hex & 255) / 255 * mul]; }
  function lerp3(out, o, a, b, t) { out[o] = a[0] + (b[0] - a[0]) * t; out[o + 1] = a[1] + (b[1] - a[1]) * t; out[o + 2] = a[2] + (b[2] - a[2]) * t; }

  function nullProps() {
    var noop = function () {};
    return { group: null, meshes: [], stats: { instances: 0, drawCalls: 0 }, refresh: noop, setSeason: noop, update: noop, setFire: noop, setWind: noop, dispose: noop };
  }

  // ------------------------------------------------------------------ build
  function build(world, scene, opts) {
    var THREE = root.THREE;
    var C = WS.C;
    if (!THREE || !world || !world.elev || !C) return nullProps();
    opts = opts || {};
    var LAND = C.LAND, PAL = C.PALETTE, N = world.N || C.N, NN = N * N;
    var _o = new THREE.Object3D(), _m = new THREE.Matrix4(), _zero = new THREE.Matrix4().makeScale(0, 0, 0), _col = new THREE.Color();

    // ---- terrain height lookup
    var heightAt = (typeof opts.heightAt === 'function') ? opts.heightAt : function (sx, sz) {
      var c = C.sceneToCell(sx, sz), x = clamp(c.x, 0, N - 1), y = clamp(c.y, 0, N - 1);
      return C.elevToScene(fin(world.elev[y * N + x], C.RENDER.ELEV_BASE));
    };
    function hAt(sx, sz) { return fin(heightAt(sx, sz), 0); }
    function sceneX(cx) { return (cx - N / 2 + 0.5) * C.RENDER.CELL; }
    function sceneZ(cy) { return (cy - N / 2 + 0.5) * C.RENDER.CELL; }
    function cellAtScene(sx, sz) { var c = C.sceneToCell(sx, sz); if (c.x < 0 || c.y < 0 || c.x >= N || c.y >= N) return -1; return c.y * N + c.x; }
    function landOf(i) { return (i < 0 || !world.land) ? -1 : world.land[i]; }
    function zoneById(id) {
      if (typeof world.zoneById === 'function') { try { return world.zoneById(id); } catch (e) { /* fallthrough */ } }
      var zs = world.zones || []; for (var k = 0; k < zs.length; k++) if (zs[k] && zs[k].id === id) return zs[k]; return null;
    }
    function zonesOf(type) {
      if (typeof world.zonesOf === 'function') { try { return world.zonesOf(type) || []; } catch (e) { /* fallthrough */ } }
      return (world.zones || []).filter(function (z) { return z && z.type === type; });
    }

    // ---- base geometries (unit-sized, scaled per part)
    var BOX = new THREE.BoxGeometry(1, 1, 1);
    var CYL5 = new THREE.CylinderGeometry(0.5, 0.5, 1, 5, 1, true);
    var CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, false);
    var CONE6 = new THREE.ConeGeometry(0.5, 1, 6, 1, true);
    var CONE4 = new THREE.ConeGeometry(0.5, 1, 4, 1, false); CONE4.rotateY(Math.PI / 4);
    var SPH = new THREE.SphereGeometry(0.5, 6, 4);
    var ICO = new THREE.IcosahedronGeometry(0.5, 0);
    var baseGeoms = [BOX, CYL5, CYL8, CONE6, CONE4, SPH, ICO];

    function part(g, c, x, y, z, ry, sx, sy, sz, rx, rz) {
      _o.position.set(x || 0, y || 0, z || 0);
      _o.rotation.set(rx || 0, ry || 0, rz || 0);
      _o.scale.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz);
      _o.updateMatrix();
      return { g: g, m: _o.matrix.clone(), c: c };
    }
    /** extrude a convex CCW (x,y) profile along z, centred */
    function profilePrism(profile, depth) {
      var h = depth / 2, pos = [], i, n = profile.length, a, b;
      function push(p, z) { pos.push(p[0], p[1], z); }
      for (i = 0; i < n; i++) {
        a = profile[i]; b = profile[(i + 1) % n];
        push(a, h); push(b, -h); push(b, h);
        push(a, h); push(a, -h); push(b, -h);
      }
      for (i = 1; i < n - 1; i++) { push(profile[0], h); push(profile[i], h); push(profile[i + 1], h); }
      for (i = 1; i < n - 1; i++) { push(profile[0], -h); push(profile[i + 1], -h); push(profile[i], -h); }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      return g;
    }
    /** merge parts [{g,m,c}] (optionally pre-multiplied by xform) into one non-indexed geometry with vertex colours */
    function mergeParts(parts, xform) {
      var geoms = [], total = 0, i, g, p;
      for (i = 0; i < parts.length; i++) {
        p = parts[i];
        g = p.g.index ? p.g.toNonIndexed() : p.g.clone();
        if (p.m) g.applyMatrix4(p.m);
        if (xform) g.applyMatrix4(xform);
        if (!g.attributes.normal) g.computeVertexNormals();
        geoms.push(g); total += g.attributes.position.count;
      }
      var pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3), off = 0;
      for (i = 0; i < geoms.length; i++) {
        g = geoms[i]; p = parts[i];
        var cnt = g.attributes.position.count;
        pos.set(g.attributes.position.array, off * 3);
        nor.set(g.attributes.normal.array, off * 3);
        for (var v = 0; v < cnt; v++) { col[(off + v) * 3] = p.c[0]; col[(off + v) * 3 + 1] = p.c[1]; col[(off + v) * 3 + 2] = p.c[2]; }
        off += cnt; g.dispose();
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeBoundingSphere();
      return geo;
    }
    function mat(extra) {
      var o = { vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 };
      if (extra) for (var k in extra) o[k] = extra[k];
      return new THREE.MeshStandardMaterial(o);
    }

    var group = new THREE.Group(); group.name = 'props';
    var meshes = [], geometries = [], materials = [];
    function instanced(geo, cap, name, dynamic, noReceive) {
      var m = mat();
      var im = new THREE.InstancedMesh(geo, m, Math.max(1, cap));
      im.name = name; im.frustumCulled = false; im.castShadow = true; im.receiveShadow = !noReceive;
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, cap) * 3), 3);
      if (dynamic) im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      group.add(im); meshes.push(im); geometries.push(geo); materials.push(m);
      return im;
    }
    function setColor(im, i, r, g, b) { var a = im.instanceColor.array; a[i * 3] = r; a[i * 3 + 1] = g; a[i * 3 + 2] = b; }
    function jitterHex(hex, i, k, hAmt, sAmt, lAmt) {
      _col.setHex(hex); _col.offsetHSL((hash(i, k) - 0.5) * hAmt, (hash(i, k + 1) - 0.5) * sAmt, (hash(i, k + 2) - 0.5) * lAmt);
      return _col;
    }

    // ================================================================= TREES
    var coniferGeo = mergeParts([
      part(CYL5, [1.6, 0.85, 0.6], 0, 0.14, 0, 0, 0.08, 0.28, 0.08),
      part(CONE6, [1, 1, 1], 0, 0.375, 0, 0, 0.8, 0.45, 0.8),
      part(CONE6, [1.06, 1.06, 1.06], 0, 0.6, 0, 0.5, 0.62, 0.4, 0.62),
      part(CONE6, [1.12, 1.12, 1.12], 0, 0.8, 0, 1.0, 0.42, 0.36, 0.42)
    ]);
    var aspenGeo = mergeParts([
      part(CYL5, [1.5, 1.5, 1.4], 0, 0.15, 0, 0, 0.05, 0.3, 0.05),
      part(ICO, [1, 1, 1], 0, 0.44, 0, 0, 0.34, 0.44, 0.3)
    ]);
    var snagGeo = mergeParts([
      part(CYL5, [1, 1, 1], 0, 0.3, 0, 0, 0.07, 0.6, 0.07),
      part(BOX, [0.9, 0.9, 0.9], 0.08, 0.4, 0, 0, 0.03, 0.18, 0.03, 0, -0.9),
      part(BOX, [0.9, 0.9, 0.9], -0.07, 0.5, 0.02, 0, 0.03, 0.15, 0.03, 0, 0.8)
    ]);
    var sageGeo = mergeParts([part(ICO, [1, 1, 1], 0, 0.08, 0, 0, 0.36, 0.2, 0.3)]);

    function makeSet(cap) {
      return { cap: cap, n: 0, cell: new Int32Array(cap), x: new Float32Array(cap), y: new Float32Array(cap), z: new Float32Array(cap),
        rot: new Float32Array(cap), s: new Float32Array(cap), sy: new Float32Array(cap), col: new Float32Array(cap * 3), hidden: new Uint8Array(cap), mesh: null };
    }
    function addInst(set, cell, x, y, z, rot, s, sy, r, g, b) {
      if (set.n >= set.cap) return -1;
      var i = set.n++;
      set.cell[i] = cell; set.x[i] = x; set.y[i] = y; set.z[i] = z; set.rot[i] = rot; set.s[i] = s; set.sy[i] = sy;
      set.col[i * 3] = r; set.col[i * 3 + 1] = g; set.col[i * 3 + 2] = b;
      return i;
    }
    function writeInst(set, i, mul, mulY) {
      if (set.hidden[i]) { set.mesh.setMatrixAt(i, _zero); return; }
      _o.position.set(set.x[i], set.y[i], set.z[i]);
      _o.rotation.set(0, set.rot[i], 0);
      var s = set.s[i] * (mul == null ? 1 : mul);
      _o.scale.set(s, set.s[i] * set.sy[i] * (mulY == null ? 1 : mulY), s);
      _o.updateMatrix();
      set.mesh.setMatrixAt(i, _o.matrix);
    }
    function finishSet(set, geo, name, noReceive) {
      set.mesh = instanced(geo, set.cap, name, false, noReceive);
      set.mesh.count = set.n;
      for (var i = 0; i < set.n; i++) { writeInst(set, i); setColor(set.mesh, i, set.col[i * 3], set.col[i * 3 + 1], set.col[i * 3 + 2]); }
      set.mesh.instanceMatrix.needsUpdate = true; set.mesh.instanceColor.needsUpdate = true;
    }

    var conifers = makeSet(MAX_CONIFERS), aspens = makeSet(MAX_ASPENS), sage = makeSet(MAX_SAGE);
    var treeline = fin(world.treeline, 3450);
    (function placeTrees() {
      var i, x, y, est = 0, d;
      var elev = world.elev, land = world.land, dens = world.treeDensity;
      for (i = 0; i < NN; i++) if (land[i] === LAND.FOREST) est += 0.6 + 3.4 * clamp(fin(dens ? dens[i] : 0.6, 0.6), 0, 1);
      var factor = est > 0 ? clamp(TARGET_CONIFERS / est, CONIFER_FACTOR_MIN, CONIFER_FACTOR_MAX) : 1;
      for (i = 0; i < NN; i++) {
        var l = land[i];
        if (l !== LAND.FOREST && l !== LAND.RIPARIAN) continue;
        x = i % N; y = (i / N) | 0;
        var e = fin(elev[i], 2500);
        if (e > treeline) continue;
        var n, k, isAspen;
        if (l === LAND.FOREST) {
          d = clamp(fin(dens ? dens[i] : 0.6, 0.6), 0, 1);
          var nf = factor * (0.6 + 3.4 * d);
          n = Math.floor(nf) + (hash(i, 99) < (nf - Math.floor(nf)) ? 1 : 0);
          n = clamp(n, 0, 5);
        } else n = 1 + (hash(i, 99) < 0.6 ? 1 : 0);
        for (k = 0; k < n; k++) {
          var sx = sceneX(x) + (hash(i, k * 3 + 1) - 0.5) * 0.9, sz = sceneZ(y) + (hash(i, k * 3 + 2) - 0.5) * 0.9;
          var sy = hAt(sx, sz) - 0.03, rot = hash(i, k * 3 + 3) * Math.PI * 2;
          var sc = 0.7 + 0.6 * hash(i, k * 3 + 4);
          isAspen = (l === LAND.RIPARIAN) || (e < ASPEN_MAX_ELEV && hash(i, k * 3 + 5) < ASPEN_FOREST_FRAC);
          if (isAspen) {
            var ac = jitterHex(0x7fb648, i, k * 3 + 6, 0.04, 0.15, 0.12);
            addInst(aspens, i, sx, sy, sz, rot, sc * 0.9, 0.9 + 0.3 * hash(i, k * 3 + 7), ac.r, ac.g, ac.b);
          } else {
            sc *= C.lerp(1, 0.55, C.smoothstep(3100, treeline, e));
            var cc = jitterHex(hash(i, k * 3 + 8) < 0.25 ? PAL.forestDark : PAL.forest, i, k * 3 + 6, 0.05, 0.16, 0.12);
            addInst(conifers, i, sx, sy, sz, rot, sc, 0.85 + 0.35 * hash(i, k * 3 + 7), cc.r, cc.g, cc.b);
          }
        }
      }
      // sagebrush on shrub cells (sparse)
      for (i = 0; i < NN; i++) {
        if (land[i] !== LAND.SHRUB || hash(i, 7) >= 1 / SAGE_EVERY) continue;
        x = i % N; y = (i / N) | 0;
        var bx = sceneX(x) + (hash(i, 11) - 0.5) * 0.8, bz = sceneZ(y) + (hash(i, 12) - 0.5) * 0.8;
        var bc = jitterHex(0x8d9a6a, i, 13, 0.03, 0.15, 0.15);
        addInst(sage, i, bx, hAt(bx, bz) - 0.02, bz, hash(i, 14) * 6.28, 0.7 + 0.6 * hash(i, 15), 1, bc.r, bc.g, bc.b);
      }
    })();
    finishSet(conifers, coniferGeo, 'conifers', true);
    finishSet(aspens, aspenGeo, 'aspens', true);
    finishSet(sage, sageGeo, 'sage', true);

    // snags: filled in refresh()
    var snags = instanced(snagGeo, MAX_SNAGS, 'snags', false, true);

    // ================================================================= BUILDINGS
    var buildings = Array.isArray(world.buildings) ? world.buildings : [];
    var gable = profilePrism([[-0.32, 0], [0.32, 0], [0, 0.2]], 0.5);
    var houseWallGeo = mergeParts([
      part(BOX, [1, 1, 1], 0, 0.1, 0, 0, 0.55, 0.44, 0.42),
      part(BOX, [0.45, 0.38, 0.32], 0.1, 0.08, 0.215, 0, 0.1, 0.16, 0.02),
      part(BOX, [0.55, 0.65, 0.75], -0.13, 0.2, 0.215, 0, 0.09, 0.09, 0.02),
      part(BOX, [0.55, 0.65, 0.75], 0.29, 0.2, 0.05, 0, 0.02, 0.09, 0.09)
    ]);
    var houseRoofGeo = mergeParts([
      part(gable, [1, 1, 1], 0, 0.32, 0, 0),
      part(BOX, [0.72, 0.66, 0.62], 0.16, 0.42, 0.06, 0, 0.07, 0.18, 0.07)
    ]);
    var gambrel = profilePrism([[-0.47, 0], [0.47, 0], [0.47, 0.12], [0.28, 0.32], [0, 0.42], [-0.28, 0.32], [-0.47, 0.12]], 0.66);
    var barnGeo = mergeParts([
      part(BOX, rgb(PAL.barnRed), 0, 0.14, 0, 0, 0.9, 0.52, 0.6),
      part(BOX, [0.95, 0.93, 0.9], 0, 0.12, 0.305, 0, 0.22, 0.3, 0.02),
      part(BOX, [0.95, 0.93, 0.9], 0, 0.36, 0, 0, 0.92, 0.03, 0.62),
      part(gambrel, [0.36, 0.3, 0.28], 0, 0.37, 0, 0)
    ]);
    var WALL_COLS = [rgb(PAL.houseWall), rgb(0xd6c5a5), rgb(0xc9d3d8)];
    var ROOF_COLS = [rgb(PAL.houseRoof), rgb(0x5b5f66), rgb(0x7a6a4a)];
    var CHAR_WALL = rgb(0x2b2624), CHAR_ROOF = rgb(0x1f1b18);

    var houses = { n: 0, cell: new Int32Array(MAX_HOUSES), x: new Float32Array(MAX_HOUSES), y: new Float32Array(MAX_HOUSES), z: new Float32Array(MAX_HOUSES),
      rot: new Float32Array(MAX_HOUSES), s: new Float32Array(MAX_HOUSES), wc: new Uint8Array(MAX_HOUSES), rc: new Uint8Array(MAX_HOUSES), burned: new Uint8Array(MAX_HOUSES) };
    var houseWalls = instanced(houseWallGeo, MAX_HOUSES, 'houseWalls'), houseRoofs = instanced(houseRoofGeo, MAX_HOUSES, 'houseRoofs');
    var barns = instanced(barnGeo, MAX_BARNS, 'barns');
    var stationPos = [], barnCount = 0, uniqueParts = [], shopIdx = 0, damFromBuilding = null;

    function bScene(b) {
      var sx = sceneX(fin(b.x, N / 2)), sz = sceneZ(fin(b.y, N / 2));
      return { x: sx, y: hAt(sx, sz) - 0.02, z: sz, rot: fin(b.rot, 0), s: clamp(fin(b.scale, 1), 0.4, 3) };
    }
    function pushUnique(parts, p) {
      _o.position.set(p.x, p.y, p.z); _o.rotation.set(0, p.rot, 0); _o.scale.set(p.s, p.s, p.s); _o.updateMatrix();
      var xf = _o.matrix.clone();
      for (var k = 0; k < parts.length; k++) { var q = parts[k]; uniqueParts.push({ g: q.g, m: xf.clone().multiply(q.m), c: q.c }); }
    }
    var civic = rgb(PAL.civic), darkRoof = [0.4, 0.38, 0.36];
    var hallRoof = profilePrism([[-0.62, 0], [0.62, 0], [0, 0.22]], 0.86), churchRoof = profilePrism([[-0.38, 0], [0.38, 0], [0, 0.28]], 1.06);
    baseGeoms.push(gable, gambrel, hallRoof, churchRoof);
    var uniqueBuilders = {
      school: function () {
        return [part(BOX, rgb(PAL.school), 0, 0.14, 0, 0, 1.6, 0.52, 0.7), part(BOX, darkRoof, 0, 0.42, 0, 0, 1.66, 0.06, 0.76),
          part(CYL8, [0.7, 0.7, 0.72], 0.95, 0.5, 0.45, 0, 0.03, 0.8, 0.03), part(BOX, [0.85, 0.2, 0.18], 1.04, 0.82, 0.45, 0, 0.16, 0.1, 0.01)];
      },
      hospital: function () {
        return [part(BOX, rgb(PAL.hospital), 0, 0.24, 0, 0, 1.2, 0.72, 0.9), part(BOX, [0.55, 0.55, 0.58], 0, 0.1, 0.5, 0, 0.36, 0.2, 0.12),
          part(BOX, [0.85, 0.15, 0.12], 0, 0.63, 0, 0, 0.32, 0.06, 0.1), part(BOX, [0.85, 0.15, 0.12], 0, 0.63, 0, 0, 0.1, 0.06, 0.32)];
      },
      fire_station: function () {
        return [part(BOX, rgb(PAL.fireStation), 0, 0.14, 0, 0, 0.9, 0.52, 0.7), part(BOX, darkRoof, 0, 0.42, 0, 0, 0.96, 0.05, 0.76),
          part(BOX, [0.95, 0.95, 0.95], -0.2, 0.14, 0.355, 0, 0.28, 0.28, 0.02), part(BOX, [0.95, 0.95, 0.95], 0.2, 0.14, 0.355, 0, 0.28, 0.28, 0.02)];
      },
      town_hall: function () {
        return [part(BOX, civic, 0, 0.19, 0, 0, 1.2, 0.62, 0.8), part(hallRoof, [0.35, 0.35, 0.4], 0, 0.5, 0, 0),
          part(BOX, [0.82, 0.8, 0.76], 0, 0.85, 0, 0, 0.28, 0.9, 0.28), part(BOX, [1, 1, 1], 0, 1.1, 0.145, 0, 0.14, 0.14, 0.01),
          part(BOX, [1, 1, 1], 0, 1.1, -0.145, 0, 0.14, 0.14, 0.01), part(CONE4, [0.4, 0.35, 0.36], 0, 1.43, 0, 0, 0.36, 0.26, 0.36)];
      },
      treatment_plant: function () {
        var p = [part(BOX, [0.6, 0.6, 0.62], 0, 0.09, 0.15, 0, 1.0, 0.42, 0.6)];
        for (var k = 0; k < 3; k++) p.push(part(CYL8, [0.66, 0.68, 0.7], -0.4 + k * 0.4, 0.16, -0.45, 0, 0.34, 0.32, 0.34));
        return p;
      },
      shelter: function () {
        return [part(BOX, [0.6, 0.66, 0.6], 0, 0.115, 0, 0, 1.1, 0.47, 0.6), part(BOX, [0.4, 0.4, 0.42], 0, 0.36, 0, 0, 1.18, 0.05, 0.68),
          part(BOX, [0.2, 0.5, 0.3], 0, 0.22, 0.31, 0, 0.3, 0.12, 0.02)];
      },
      church: function () {
        return [part(BOX, [0.93, 0.9, 0.85], 0, 0.14, 0, 0, 0.7, 0.52, 1.0), part(churchRoof, [0.4, 0.3, 0.28], 0, 0.4, 0, 0),
          part(BOX, [0.9, 0.88, 0.84], 0, 0.6, 0.3, 0, 0.2, 0.7, 0.2), part(CONE4, [0.45, 0.4, 0.4], 0, 1.12, 0.3, 0, 0.26, 0.34, 0.26),
          part(BOX, [0.9, 0.8, 0.5], 0, 1.35, 0.3, 0, 0.02, 0.12, 0.02), part(BOX, [0.9, 0.8, 0.5], 0, 1.38, 0.3, 0, 0.08, 0.02, 0.02)];
      },
      shop: function () {
        var k = (shopIdx++) % 3;
        var wall = [[0.85, 0.75, 0.6], [0.7, 0.8, 0.85], [0.9, 0.85, 0.8]][k], awn = [[0.8, 0.3, 0.25], [0.25, 0.5, 0.7], [0.3, 0.6, 0.35]][k];
        return [part(BOX, wall, 0, 0.115, 0, 0, 0.7, 0.47, 0.5), part(BOX, [0.3, 0.3, 0.32], 0, 0.36, 0, 0, 0.74, 0.04, 0.54),
          part(BOX, awn, 0, 0.27, 0.3, 0, 0.72, 0.03, 0.2), part(BOX, [0.5, 0.6, 0.7], 0, 0.14, 0.255, 0, 0.4, 0.16, 0.01)];
      }
    };
    (function placeBuildings() {
      for (var k = 0; k < buildings.length; k++) {
        var b = buildings[k]; if (!b) continue;
        var t = b.type, p = bScene(b);
        if (t === 'house') {
          if (houses.n >= MAX_HOUSES) continue;
          var i = houses.n++;
          houses.cell[i] = cellAtScene(p.x, p.z); houses.x[i] = p.x; houses.y[i] = p.y; houses.z[i] = p.z; houses.rot[i] = p.rot; houses.s[i] = p.s;
          houses.wc[i] = Math.floor(hash(k, 21) * 3) % 3; houses.rc[i] = Math.floor(hash(k, 22) * 3) % 3;
        } else if (t === 'barn') {
          if (barnCount >= MAX_BARNS) continue;
          _o.position.set(p.x, p.y, p.z); _o.rotation.set(0, p.rot, 0); _o.scale.set(p.s, p.s, p.s); _o.updateMatrix();
          barns.setMatrixAt(barnCount, _o.matrix);
          var bj = 0.9 + 0.2 * hash(k, 23); setColor(barns, barnCount, bj, bj, bj); barnCount++;
        } else if (t === 'dam') {
          damFromBuilding = b;
        } else if (uniqueBuilders[t]) {
          if (t === 'fire_station') stationPos.push(p);
          pushUnique(uniqueBuilders[t](), p);
        } else {
          pushUnique(uniqueBuilders.shop(), p); // unknown types render as a shop-like block
        }
      }
      barns.count = barnCount; barns.instanceMatrix.needsUpdate = true; barns.instanceColor.needsUpdate = true;
    })();
    function writeHouse(i) {
      var burned = houses.burned[i];
      _o.position.set(houses.x[i], houses.y[i], houses.z[i]); _o.rotation.set(0, houses.rot[i], 0);
      _o.scale.set(houses.s[i], houses.s[i] * (burned ? 0.35 : 1), houses.s[i]); _o.updateMatrix(); houseWalls.setMatrixAt(i, _o.matrix);
      _o.scale.set(houses.s[i], houses.s[i] * (burned ? 0.08 : 1), houses.s[i]); _o.updateMatrix(); houseRoofs.setMatrixAt(i, _o.matrix);
    }
    (function finishHouses() {
      for (var i = 0; i < houses.n; i++) writeHouse(i);
      houseWalls.count = houseRoofs.count = houses.n;
      houseWalls.instanceMatrix.needsUpdate = houseRoofs.instanceMatrix.needsUpdate = true;
    })();

    // ---- dam: concrete arc across the river at reservoir.dam
    (function placeDam() {
      var res = world.reservoir || {};
      var dam = res.dam || (damFromBuilding ? { x: damFromBuilding.x, y: damFromBuilding.y } : null);
      if (!dam || !isFinite(dam.x) || !isFinite(dam.y)) return;
      var dx = 1, dy = 1, path = world.river && world.river.path, di = world.river ? world.river.damIndex : -1;
      if (path && path.length > 1 && di >= 0 && di < path.length) {
        var a = path[Math.max(0, di - 2)], b2 = path[Math.min(path.length - 1, di + 2)];
        dx = b2.x - a.x; dy = b2.y - a.y;
      } else if (world.flowDir) {
        var ci = clamp(Math.round(dam.y), 0, N - 1) * N + clamp(Math.round(dam.x), 0, N - 1), fd = world.flowDir[ci];
        if (fd >= 0) { dx = (fd % N) - (ci % N); dy = ((fd / N) | 0) - ((ci / N) | 0); }
      }
      var dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;            // flow direction (cell space ≈ scene xz)
      var px = -dy, pz = dx;                                             // across-river direction
      var cx = sceneX(dam.x), cz = sceneZ(dam.y);
      var bed = fin(res.bedElev, NaN), spill = fin(res.spillElev, NaN);
      var ci2 = clamp(Math.round(dam.y), 0, N - 1) * N + clamp(Math.round(dam.x), 0, N - 1);
      var cellE = fin(world.elev[ci2], 2200);
      if (!isFinite(bed)) bed = cellE; else bed = Math.min(bed, cellE);
      if (!isFinite(spill)) spill = bed + 45;
      var baseY = C.elevToScene(bed) - 0.15, topY = C.elevToScene(spill) + 0.12;
      var h = Math.max(0.3, topY - baseY);
      var wcells = 2; if (world.river && world.river.widths && di >= 0) wcells = fin(world.river.widths[di], 2);
      var chord = clamp(wcells + 4, 5, 9), segs = 10, sag = chord * 0.22, parts = [], k;
      var col = rgb(PAL.dam), colTop = rgb(PAL.dam, 0.8);
      var bulge = function (t) { return sag * (1 - 4 * t * t); }; // arc bulges upstream (against flow)
      for (k = 0; k < segs; k++) {
        var t0 = k / segs - 0.5, t1 = (k + 1) / segs - 0.5, tm = (t0 + t1) / 2;
        var x0 = cx + px * t0 * chord - dx * bulge(t0), z0 = cz + pz * t0 * chord - dy * bulge(t0);
        var x1 = cx + px * t1 * chord - dx * bulge(t1), z1 = cz + pz * t1 * chord - dy * bulge(t1);
        var len = Math.hypot(x1 - x0, z1 - z0) * 1.08, ang = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
        var mx = cx + px * tm * chord - dx * bulge(tm), mz = cz + pz * tm * chord - dy * bulge(tm);
        parts.push(part(BOX, col, mx, baseY + h / 2, mz, ang, len, h, 0.32));
        parts.push(part(BOX, colTop, mx, baseY + h + 0.03, mz, ang, len, 0.06, 0.44));
      }
      // spillway lip (centre, slightly lower) + powerhouse block at the toe
      parts.push(part(BOX, [0.55, 0.56, 0.58], cx + dx * 0.55, baseY + 0.18, cz + dy * 0.55, Math.atan2(dx, dy), 0.5, 0.36, 0.4));
      for (k = 0; k < parts.length; k++) uniqueParts.push(parts[k]);
    })();

    var uniquesMesh = null;
    if (uniqueParts.length) {
      var ug = mergeParts(uniqueParts), um = mat();
      uniquesMesh = new THREE.Mesh(ug, um); uniquesMesh.name = 'uniques'; uniquesMesh.castShadow = true; uniquesMesh.receiveShadow = true;
      group.add(uniquesMesh); meshes.push(uniquesMesh); geometries.push(ug); materials.push(um);
    }

    // ================================================================= FARMS
    var cropGeo = mergeParts([part(BOX, [1, 1, 1], 0, 0.04, 0, 0, 0.9, 0.08, 0.16)]);
    var hayGeo = mergeParts([part(CYL8, [1, 1, 1], 0, 0.09, 0, 0, 0.18, 0.22, 0.18, 0, Math.PI / 2)]);
    var postGeo = mergeParts([part(BOX, [1, 1, 1], 0, 0.08, 0, 0, 0.04, 0.16, 0.04)]);
    var crops = { n: 0, cell: new Int32Array(MAX_CROPS) };
    var cropMesh = instanced(cropGeo, MAX_CROPS, 'crops', false, true), hayMesh = instanced(hayGeo, MAX_HAY, 'hay', false, true), fenceMesh = instanced(postGeo, MAX_FENCE, 'fence', false, true);
    var CROP_GREEN = rgb(0x6fae3f), CROP_STRAW = rgb(PAL.farmDry), CROP_BROWN = rgb(0x8a6a3c), HAY_COL = rgb(0xd8bf6a), POST_COL = rgb(0x7a6a55);
    (function placeFarms() {
      var i, x, y, zoneAxis = {}, hay = 0, z;
      for (i = 0; i < NN; i++) {
        if (world.land[i] !== LAND.FARM) continue;
        x = i % N; y = (i / N) | 0;
        var zid = world.zone ? world.zone[i] : -1, alongX = true;
        if (zid >= 0) {
          if (zoneAxis[zid] == null) { z = zoneById(zid); zoneAxis[zid] = !(z && z.bbox && (z.bbox.y1 - z.bbox.y0) > (z.bbox.x1 - z.bbox.x0)); }
          alongX = zoneAxis[zid];
        }
        var rot = alongX ? 0 : Math.PI / 2, cx = sceneX(x), cz = sceneZ(y);
        for (var k = 0; k < 2 && crops.n < MAX_CROPS; k++) {
          var off = (k === 0 ? -0.25 : 0.25), px = alongX ? cx : cx + off, pz = alongX ? cz + off : cz;
          _o.position.set(px, hAt(px, pz), pz); _o.rotation.set(0, rot, 0); _o.scale.set(1, 1, 1); _o.updateMatrix();
          cropMesh.setMatrixAt(crops.n, _o.matrix); crops.cell[crops.n] = i; crops.n++;
        }
        if (hay < MAX_HAY && hash(i, 31) < 1 / HAY_EVERY) {
          var hx = cx + (hash(i, 32) - 0.5) * 0.5, hz = cz + (hash(i, 33) - 0.5) * 0.5;
          _o.position.set(hx, hAt(hx, hz), hz); _o.rotation.set(0, rot + (hash(i, 34) - 0.5) * 0.4, 0); _o.scale.set(1, 1, 1); _o.updateMatrix();
          hayMesh.setMatrixAt(hay, _o.matrix); var hj = 0.9 + 0.2 * hash(i, 35); setColor(hayMesh, hay, HAY_COL[0] * hj, HAY_COL[1] * hj, HAY_COL[2] * hj); hay++;
        }
      }
      cropMesh.count = crops.n; cropMesh.instanceMatrix.needsUpdate = true;
      hayMesh.count = hay; hayMesh.instanceMatrix.needsUpdate = true; hayMesh.instanceColor.needsUpdate = true;
      // fences: posts around farm zone bboxes
      var fz = zonesOf('farm'), np = 0;
      for (var f = 0; f < fz.length && np < MAX_FENCE; f++) {
        var bb = fz[f] && fz[f].bbox; if (!bb) continue;
        var x0 = sceneX(bb.x0) - 0.5, x1 = sceneX(bb.x1) + 0.5, z0 = sceneZ(bb.y0) - 0.5, z1 = sceneZ(bb.y1) + 0.5;
        var per = [], t;
        for (t = x0; t <= x1; t += 1) { per.push(t, z0); per.push(t, z1); }
        for (t = z0 + 1; t < z1; t += 1) { per.push(x0, t); per.push(x1, t); }
        for (t = 0; t < per.length && np < MAX_FENCE; t += 2) {
          var ci = cellAtScene(per[t], per[t + 1]); if (ci < 0) continue;
          var l = world.land[ci]; if (l === LAND.RIVER || l === LAND.RESERVOIR || l === LAND.ROAD) continue;
          _o.position.set(per[t], hAt(per[t], per[t + 1]), per[t + 1]); _o.rotation.set(0, 0, 0); _o.scale.set(1, 1, 1); _o.updateMatrix();
          fenceMesh.setMatrixAt(np, _o.matrix); setColor(fenceMesh, np, POST_COL[0], POST_COL[1], POST_COL[2]); np++;
        }
      }
      fenceMesh.count = np; fenceMesh.instanceMatrix.needsUpdate = true; fenceMesh.instanceColor.needsUpdate = true;
    })();

    // ================================================================= ROADS
    var roads = [];
    (function prepRoads() {
      var src = Array.isArray(world.roads) ? world.roads : [];
      for (var r = 0; r < src.length; r++) {
        var pl = src[r]; if (!pl || pl.length < 2) continue;
        var px = [], pz = [], cum = [0], k;
        for (k = 0; k < pl.length; k++) {
          var p = pl[k]; if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
          var sx = sceneX(p.x), sz = sceneZ(p.y);
          if (px.length && Math.abs(sx - px[px.length - 1]) < 1e-6 && Math.abs(sz - pz[pz.length - 1]) < 1e-6) continue;
          if (px.length) cum.push(cum[cum.length - 1] + Math.hypot(sx - px[px.length - 1], sz - pz[pz.length - 1]));
          px.push(sx); pz.push(sz);
        }
        if (px.length < 2) continue;
        roads.push({ px: new Float32Array(px), pz: new Float32Array(pz), cum: new Float32Array(cum), len: cum[cum.length - 1], n: px.length, cells: pl });
      }
    })();
    var _pt = { x: 0, z: 0, dx: 0, dz: 1 };
    function roadPoint(rd, s, out) {
      s = clamp(s, 0, rd.len);
      var j = 0, n = rd.n;
      while (j < n - 2 && rd.cum[j + 1] < s) j++;
      var l = rd.cum[j + 1] - rd.cum[j], t = l > 1e-6 ? (s - rd.cum[j]) / l : 0;
      out.x = rd.px[j] + (rd.px[j + 1] - rd.px[j]) * t; out.z = rd.pz[j] + (rd.pz[j + 1] - rd.pz[j]) * t;
      var dx = rd.px[j + 1] - rd.px[j], dz = rd.pz[j + 1] - rd.pz[j]; l = Math.hypot(dx, dz) || 1;
      out.dx = dx / l; out.dz = dz / l;
      return out;
    }
    function nearestOnRoad(rd, x, z) {
      var best = Infinity, bs = 0;
      for (var j = 0; j < rd.n - 1; j++) {
        var ax = rd.px[j], az = rd.pz[j], bx = rd.px[j + 1], bz = rd.pz[j + 1], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
        var t = l2 > 1e-9 ? clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1) : 0;
        var qx = ax + vx * t, qz = az + vz * t, d = (qx - x) * (qx - x) + (qz - z) * (qz - z);
        if (d < best) { best = d; bs = rd.cum[j] + Math.sqrt(l2) * t; }
      }
      return { s: bs, d: Math.sqrt(best) };
    }
    function nearestRoad(x, z, list) {
      var best = null, bd = Infinity;
      for (var r = 0; r < list.length; r++) { var q = nearestOnRoad(list[r], x, z); if (q.d < bd) { bd = q.d; best = { road: list[r], s: q.s, d: q.d }; } }
      return best;
    }
    var roadMesh = null;
    (function buildRoadRibbon() {
      if (!roads.length) return;
      var pos = [], col = [], rc = rgb(PAL.road, 0.8), sc = [0.58, 0.56, 0.52], r, hw = ROAD_WIDTH / 2, sw = 0.035;
      var a = { x: 0, z: 0, dx: 0, dz: 1 }, prevL = null, prevR = null, prevSL = null, prevSR = null;
      function quad(l0, r0, l1, r1, c) {
        pos.push(l0[0], l0[1], l0[2], r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], l0[0], l0[1], l0[2], r1[0], r1[1], r1[2], l1[0], l1[1], l1[2]);
        for (var q = 0; q < 6; q++) col.push(c[0], c[1], c[2]);
      }
      for (r = 0; r < roads.length; r++) {
        var rd = roads[r]; prevL = null;
        var steps = Math.max(1, Math.ceil(rd.len / ROAD_STEP));
        for (var k = 0; k <= steps; k++) {
          var s = Math.min(rd.len, k * ROAD_STEP);
          roadPoint(rd, s, a);
          var y = hAt(a.x, a.z) + ROAD_LIFT, nx = -a.dz, nz = a.dx;
          var L = [a.x + nx * hw, y, a.z + nz * hw], R = [a.x - nx * hw, y, a.z - nz * hw];
          var SL = [a.x + nx * sw, y + 0.012, a.z + nz * sw], SR = [a.x - nx * sw, y + 0.012, a.z - nz * sw];
          if (prevL) { quad(prevL, prevR, L, R, rc); quad(prevSL, prevSR, SL, SR, sc); }
          prevL = L; prevR = R; prevSL = SL; prevSR = SR;
        }
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals(); g.computeBoundingSphere();
      var m = mat({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, flatShading: false });
      roadMesh = new THREE.Mesh(g, m); roadMesh.name = 'roads'; roadMesh.receiveShadow = true; roadMesh.castShadow = false;
      group.add(roadMesh); meshes.push(roadMesh); geometries.push(g); materials.push(m);
    })();

    // ================================================================= LIFE
    // forward = +z for all life geometries
    var personGeo = mergeParts([
      part(CYL5, [1, 1, 1], 0, 0.07, 0, 0, 0.07, 0.1, 0.07), part(SPH, [1, 1, 1], 0, 0.12, 0, 0, 0.07, 0.07, 0.07),
      part(SPH, [1.7, 1.45, 1.25], 0, 0.185, 0, 0, 0.06, 0.06, 0.06)
    ]);
    var elkGeo = mergeParts([
      part(BOX, [1, 1, 1], 0, 0.24, 0, 0, 0.14, 0.15, 0.34),
      part(BOX, [0.95, 0.95, 0.95], 0, 0.36, 0.2, 0, 0.08, 0.2, 0.09, -0.6),
      part(BOX, [0.9, 0.9, 0.9], 0, 0.46, 0.3, 0, 0.07, 0.07, 0.14),
      part(BOX, [0.5, 0.45, 0.4], 0.035, 0.53, 0.28, 0, 0.015, 0.1, 0.015, 0, -0.5), part(BOX, [0.5, 0.45, 0.4], -0.035, 0.53, 0.28, 0, 0.015, 0.1, 0.015, 0, 0.5),
      part(BOX, [0.7, 0.7, 0.7], 0.05, 0.08, 0.13, 0, 0.03, 0.18, 0.03), part(BOX, [0.7, 0.7, 0.7], -0.05, 0.08, 0.13, 0, 0.03, 0.18, 0.03),
      part(BOX, [0.7, 0.7, 0.7], 0.05, 0.08, -0.13, 0, 0.03, 0.18, 0.03), part(BOX, [0.7, 0.7, 0.7], -0.05, 0.08, -0.13, 0, 0.03, 0.18, 0.03)
    ]);
    var truckGeo = mergeParts([
      part(BOX, rgb(PAL.fireStation), 0, 0.16, -0.06, 0, 0.22, 0.18, 0.4), part(BOX, [0.95, 0.95, 0.95], 0, 0.15, 0.22, 0, 0.22, 0.16, 0.16),
      part(BOX, [0.6, 0.6, 0.62], 0, 0.28, -0.05, 0, 0.05, 0.03, 0.4, -0.12),
      part(BOX, [0.15, 0.15, 0.15], 0.1, 0.05, 0.15, 0, 0.04, 0.1, 0.1), part(BOX, [0.15, 0.15, 0.15], -0.1, 0.05, 0.15, 0, 0.04, 0.1, 0.1),
      part(BOX, [0.15, 0.15, 0.15], 0.1, 0.05, -0.15, 0, 0.04, 0.1, 0.1), part(BOX, [0.15, 0.15, 0.15], -0.1, 0.05, -0.15, 0, 0.04, 0.1, 0.1)
    ]);
    var carGeo = mergeParts([
      part(BOX, [1, 1, 1], 0, 0.07, 0, 0, 0.16, 0.08, 0.3), part(BOX, [0.55, 0.6, 0.65], 0, 0.14, -0.02, 0, 0.14, 0.07, 0.16),
      part(BOX, [0.15, 0.15, 0.15], 0.08, 0.03, 0.09, 0, 0.03, 0.06, 0.06), part(BOX, [0.15, 0.15, 0.15], -0.08, 0.03, 0.09, 0, 0.03, 0.06, 0.06),
      part(BOX, [0.15, 0.15, 0.15], 0.08, 0.03, -0.09, 0, 0.03, 0.06, 0.06), part(BOX, [0.15, 0.15, 0.15], -0.08, 0.03, -0.09, 0, 0.03, 0.06, 0.06)
    ]);
    var birdGeo = mergeParts([
      part(BOX, [1, 1, 1], 0.07, 0, -0.03, 0.55, 0.16, 0.012, 0.03), part(BOX, [1, 1, 1], -0.07, 0, -0.03, -0.55, 0.16, 0.012, 0.03)
    ]);
    var peopleMesh = instanced(personGeo, N_PEOPLE, 'people', true, true), elkMesh = instanced(elkGeo, N_ELK, 'elk', true, true);
    var truckMesh = instanced(truckGeo, N_TRUCKS, 'trucks', true, true), carMesh = instanced(carGeo, N_CARS, 'cars', true, true), birdMesh = instanced(birdGeo, N_BIRDS, 'birds', true, true);
    var dummyRoad = { px: new Float32Array([0, 0]), pz: new Float32Array([0, 0]), cum: new Float32Array([0, 0]), len: 0, n: 2 };

    // --- town roads / main road
    var townRoads = [], mainRoad = null;
    (function classifyRoads() {
      var centres = zonesOf('neighborhood').map(function (z) { return z.center; }).filter(function (c) { return c && isFinite(c.x); });
      if (!centres.length) { // fallback: residential centroid
        var sx = 0, sy = 0, cnt = 0; for (var i = 0; i < NN; i++) if (world.land[i] === LAND.RESIDENTIAL) { sx += i % N; sy += (i / N) | 0; cnt++; }
        if (cnt) centres.push({ x: sx / cnt, y: sy / cnt });
      }
      for (var r = 0; r < roads.length; r++) {
        var rd = roads[r], town = false;
        if (!mainRoad || rd.len > mainRoad.len) mainRoad = rd;
        for (var k = 0; k < rd.n && !town; k += 2) for (var c = 0; c < centres.length; c++) {
          if (Math.hypot(rd.px[k] - sceneX(centres[c].x), rd.pz[k] - sceneZ(centres[c].y)) < 10) { town = true; break; }
        }
        if (town) townRoads.push(rd);
      }
      if (!townRoads.length) townRoads = roads.slice();
    })();

    // --- people
    var people = { n: 0, road: [], s: new Float32Array(N_PEOPLE), dir: new Float32Array(N_PEOPLE), spd: new Float32Array(N_PEOPLE), side: new Float32Array(N_PEOPLE), ph: new Float32Array(N_PEOPLE) };
    var PEOPLE_COLS = [rgb(0x3a6fb0), rgb(0xc94f3d), rgb(0xe8d6a0), rgb(0x4f8a4a), rgb(0x6b4a8a)];
    if (townRoads.length) {
      for (var pi = 0; pi < N_PEOPLE; pi++) {
        var prd = townRoads[Math.floor(hash(pi, 41) * townRoads.length) % townRoads.length];
        people.road.push(prd); people.s[pi] = hash(pi, 42) * prd.len; people.dir[pi] = hash(pi, 43) < 0.5 ? -1 : 1;
        people.spd[pi] = PEOPLE_SPEED_MIN + (PEOPLE_SPEED_MAX - PEOPLE_SPEED_MIN) * hash(pi, 44); people.side[pi] = people.dir[pi] * PEOPLE_SIDE; people.ph[pi] = hash(pi, 45) * 6.28;
        var pc = PEOPLE_COLS[pi % PEOPLE_COLS.length]; setColor(peopleMesh, pi, pc[0], pc[1], pc[2]);
      }
      people.n = N_PEOPLE;
    }
    peopleMesh.count = people.n; peopleMesh.instanceColor.needsUpdate = true;

    // --- elk
    var habitatCells = (function () {
      var out = [], i, hab = world.habitat, land = world.land;
      for (i = 0; i < NN; i++) if ((land[i] === LAND.SHRUB || land[i] === LAND.RIPARIAN) && (hab ? hab[i] > 0.4 : true)) out.push(i);
      if (!out.length) for (i = 0; i < NN; i++) if (land[i] === LAND.SHRUB) out.push(i);
      return new Int32Array(out);
    })();
    var elk = { n: 0, x: new Float32Array(N_ELK), z: new Float32Array(N_ELK), tx: new Float32Array(N_ELK), tz: new Float32Array(N_ELK), head: new Float32Array(N_ELK), wait: new Float32Array(N_ELK), ph: new Float32Array(N_ELK) };
    function elkPickTarget(k) {
      var bx = elk.x[k], bz = elk.z[k], best = -1, bd = Infinity;
      for (var t = 0; t < 8; t++) {
        var ci = habitatCells[Math.floor(Math.random() * habitatCells.length)];
        var cx = sceneX(ci % N), cz = sceneZ((ci / N) | 0), d = Math.hypot(cx - bx, cz - bz);
        if (d < ELK_ROAM) { best = ci; break; }
        if (d < bd) { bd = d; best = ci; }
      }
      if (best < 0) return;
      elk.tx[k] = sceneX(best % N) + (Math.random() - 0.5) * 0.8; elk.tz[k] = sceneZ((best / N) | 0) + (Math.random() - 0.5) * 0.8;
    }
    if (habitatCells.length) {
      for (var ek = 0; ek < N_ELK; ek++) {
        var hc = habitatCells[Math.floor(hash(ek, 51) * habitatCells.length) % habitatCells.length];
        elk.x[ek] = sceneX(hc % N); elk.z[ek] = sceneZ((hc / N) | 0); elk.head[ek] = hash(ek, 52) * 6.28; elk.wait[ek] = hash(ek, 53) * 4; elk.ph[ek] = hash(ek, 54) * 6.28;
        elkPickTarget(ek);
        var ecol = jitterHex(0x7a5a3a, ek, 55, 0.02, 0.1, 0.16); setColor(elkMesh, ek, ecol.r, ecol.g, ecol.b);
      }
      elk.n = N_ELK;
    }
    elkMesh.count = elk.n; elkMesh.instanceColor.needsUpdate = true;

    // --- fire trucks
    var trucks = { n: 0, road: [], home: new Float32Array(N_TRUCKS), s: new Float32Array(N_TRUCKS), target: new Float32Array(N_TRUCKS), side: new Float32Array(N_TRUCKS), dir: new Float32Array(N_TRUCKS), x: new Float32Array(N_TRUCKS), z: new Float32Array(N_TRUCKS), head: new Float32Array(N_TRUCKS), fixed: new Uint8Array(N_TRUCKS) };
    (function placeTrucks() {
      if (!stationPos.length) { // no stations: park at the town-hall-ish civic centroid or map centre
        var sx = 0, sz = 0, cnt = 0; for (var i = 0; i < NN; i++) if (world.land[i] === LAND.CIVIC) { sx += sceneX(i % N); sz += sceneZ((i / N) | 0); cnt++; }
        stationPos.push(cnt ? { x: sx / cnt, y: hAt(sx / cnt, sz / cnt), z: sz / cnt, rot: 0, s: 1 } : { x: 0, y: hAt(0, 0), z: 0, rot: 0, s: 1 });
      }
      for (var k = 0; k < N_TRUCKS; k++) {
        var st = stationPos[k % stationPos.length], q = roads.length ? nearestRoad(st.x, st.z, roads) : null;
        var t = trucks.n++;
        trucks.x[t] = st.x + Math.sin(st.rot) * 0.55; trucks.z[t] = st.z + Math.cos(st.rot) * 0.55; trucks.head[t] = st.rot;
        if (q && q.d < 6) {
          trucks.road.push(q.road); trucks.home[t] = clamp(q.s + (k >= stationPos.length ? 0.7 : 0), 0, q.road.len); trucks.s[t] = trucks.home[t]; trucks.target[t] = trucks.home[t]; trucks.side[t] = 0.14; trucks.dir[t] = 1;
          var q0 = roadPoint(q.road, trucks.home[t], _pt); trucks.head[t] = Math.atan2(q0.dx, q0.dz);
        } else { trucks.road.push(dummyRoad); trucks.fixed[t] = 1; }
        setColor(truckMesh, t, 1, 1, 1);
      }
      truckMesh.count = trucks.n; truckMesh.instanceColor.needsUpdate = true;
    })();

    // --- cars
    var cars = { n: 0, s: new Float32Array(N_CARS), dir: new Float32Array(N_CARS), spd: new Float32Array(N_CARS) };
    var CAR_COLS = [rgb(0xd9d9d9), rgb(0x2f4f8f), rgb(0xb03a2e), rgb(0x3f3f3f)];
    if (mainRoad && mainRoad.len > 4) {
      for (var ck = 0; ck < N_CARS; ck++) {
        cars.s[ck] = hash(ck, 61) * mainRoad.len; cars.dir[ck] = ck % 2 ? -1 : 1; cars.spd[ck] = CAR_SPEED * (0.85 + 0.3 * hash(ck, 62));
        var cc2 = CAR_COLS[ck % CAR_COLS.length]; setColor(carMesh, ck, cc2[0], cc2[1], cc2[2]);
      }
      cars.n = N_CARS;
    }
    carMesh.count = cars.n; carMesh.instanceColor.needsUpdate = true;

    // --- birds
    var resCentre = (world.reservoir && world.reservoir.center && isFinite(world.reservoir.center.x)) ? world.reservoir.center : { x: N / 2, y: N / 2 };
    var birdBaseY = C.elevToScene(fin(world.reservoir && world.reservoir.spillElev, fin(world.elev[clamp(Math.round(resCentre.y), 0, N - 1) * N + clamp(Math.round(resCentre.x), 0, N - 1)], 2200)));
    var birds = { n: N_BIRDS, ang: new Float32Array(N_BIRDS), rad: new Float32Array(N_BIRDS), w: new Float32Array(N_BIRDS), h: new Float32Array(N_BIRDS), ph: new Float32Array(N_BIRDS) };
    for (var bk = 0; bk < N_BIRDS; bk++) {
      birds.ang[bk] = hash(bk, 71) * 6.28; birds.rad[bk] = 2.5 + 4 * hash(bk, 72); birds.w[bk] = (0.25 + 0.25 * hash(bk, 73)) * (hash(bk, 74) < 0.3 ? -1 : 1);
      birds.h[bk] = BIRD_HEIGHT + 1.5 * hash(bk, 75); birds.ph[bk] = hash(bk, 76) * 6.28;
      setColor(birdMesh, bk, 0.2, 0.18, 0.18);
    }
    birdMesh.count = N_BIRDS; birdMesh.instanceColor.needsUpdate = true;

    // ================================================================= STATE
    var season = 0, snowline = fin(world.snowlineElev, 2600) + SNOWLINE_BY_SEASON[0], drought = false, windDir = 0, windMph = 0, time = 0;
    var cellBurning = new Uint8Array(NN), burningInst = new Int32Array(MAX_BURNING_INST), burningN = 0;
    var burningInstA = new Int32Array(MAX_BURNING_INST), burningNA = 0; // aspens
    var fireCX = 0, fireCZ = 0, fireCount = 0, fireBX = new Float32Array(2048), fireBZ = new Float32Array(2048), fireBN = 0;
    var SNOW = rgb(PAL.snow), DRY = rgb(PAL.forestDry), SHRUB_DRY = rgb(PAL.shrubDry), ASPEN_GOLD = rgb(PAL.aspenFall), ASPEN_BARE = rgb(0x8a7a6a);
    var scene_ = scene;
    if (scene_ && typeof scene_.add === 'function') scene_.add(group);

    function recolor() {
      var i, e, snow, a, elev = world.elev, w = (season === 0), sBlend = w ? 0.65 : 0.5;
      // conifers
      a = conifers.mesh.instanceColor.array;
      for (i = 0; i < conifers.n; i++) {
        var r = conifers.col[i * 3], g = conifers.col[i * 3 + 1], b = conifers.col[i * 3 + 2];
        if (drought) { r += (DRY[0] - r) * 0.35; g += (DRY[1] - g) * 0.35; b += (DRY[2] - b) * 0.35; }
        e = elev[conifers.cell[i]]; snow = e > snowline ? sBlend * clamp((e - snowline) / 120, 0.35, 1) : 0;
        if (snow > 0) { r += (SNOW[0] - r) * snow; g += (SNOW[1] - g) * snow; b += (SNOW[2] - b) * snow; }
        a[i * 3] = r; a[i * 3 + 1] = g; a[i * 3 + 2] = b;
      }
      conifers.mesh.instanceColor.needsUpdate = true;
      // aspens
      a = aspens.mesh.instanceColor.array;
      for (i = 0; i < aspens.n; i++) {
        var ar, ag, ab, jl = 0.9 + 0.2 * hash(i, 81);
        if (season === 3) { ar = ASPEN_GOLD[0] * jl; ag = ASPEN_GOLD[1] * jl; ab = ASPEN_GOLD[2] * jl; }
        else if (season === 0) { ar = ASPEN_BARE[0] * jl; ag = ASPEN_BARE[1] * jl; ab = ASPEN_BARE[2] * jl; }
        else { ar = aspens.col[i * 3]; ag = aspens.col[i * 3 + 1]; ab = aspens.col[i * 3 + 2]; if (drought) { ar += (DRY[0] - ar) * 0.25; ag += (DRY[1] - ag) * 0.25; ab += (DRY[2] - ab) * 0.25; } }
        e = elev[aspens.cell[i]]; snow = (season !== 0 && e > snowline) ? 0.4 : 0;
        if (snow > 0) { ar += (SNOW[0] - ar) * snow; ag += (SNOW[1] - ag) * snow; ab += (SNOW[2] - ab) * snow; }
        a[i * 3] = ar; a[i * 3 + 1] = ag; a[i * 3 + 2] = ab;
      }
      aspens.mesh.instanceColor.needsUpdate = true;
      // sage
      a = sage.mesh.instanceColor.array;
      for (i = 0; i < sage.n; i++) {
        var sr = sage.col[i * 3], sg = sage.col[i * 3 + 1], sb = sage.col[i * 3 + 2];
        if (drought || season === 0) { var dt = drought ? 0.4 : 0.2; sr += (SHRUB_DRY[0] - sr) * dt; sg += (SHRUB_DRY[1] - sg) * dt; sb += (SHRUB_DRY[2] - sb) * dt; }
        e = elev[sage.cell[i]]; if (e > snowline) { sr += (SNOW[0] - sr) * 0.6; sg += (SNOW[1] - sg) * 0.6; sb += (SNOW[2] - sb) * 0.6; }
        a[i * 3] = sr; a[i * 3 + 1] = sg; a[i * 3 + 2] = sb;
      }
      sage.mesh.instanceColor.needsUpdate = true;
      // houses
      var wa = houseWalls.instanceColor.array, ra = houseRoofs.instanceColor.array;
      for (i = 0; i < houses.n; i++) {
        var wc = houses.burned[i] ? CHAR_WALL : WALL_COLS[houses.wc[i]], rc = houses.burned[i] ? CHAR_ROOF : ROOF_COLS[houses.rc[i]];
        wa[i * 3] = wc[0]; wa[i * 3 + 1] = wc[1]; wa[i * 3 + 2] = wc[2];
        e = houses.cell[i] >= 0 ? elev[houses.cell[i]] : 0;
        if (!houses.burned[i] && e > snowline) lerp3(ra, i * 3, rc, SNOW, w ? 0.85 : 0.6); else { ra[i * 3] = rc[0]; ra[i * 3 + 1] = rc[1]; ra[i * 3 + 2] = rc[2]; }
      }
      houseWalls.instanceColor.needsUpdate = true; houseRoofs.instanceColor.needsUpdate = true;
    }
    function updateAspenMatrices() {
      var w = (season === 0), i;
      for (i = 0; i < aspens.n; i++) writeInst(aspens, i, w ? 0.6 : 1, w ? 0.85 : 1);
      aspens.mesh.instanceMatrix.needsUpdate = true;
    }
    function refreshBurn() {
      var burn = world.burn, i, changed = false, c;
      if (!burn) return;
      for (i = 0; i < conifers.n; i++) {
        var h = burn[conifers.cell[i]] > SNAG_BURN ? 1 : 0;
        if (h !== conifers.hidden[i]) { conifers.hidden[i] = h; writeInst(conifers, i); changed = true; }
      }
      if (changed) conifers.mesh.instanceMatrix.needsUpdate = true;
      changed = false;
      for (i = 0; i < aspens.n; i++) {
        var ha = burn[aspens.cell[i]] > SNAG_BURN ? 1 : 0;
        if (ha !== aspens.hidden[i]) { aspens.hidden[i] = ha; changed = true; }
      }
      if (changed) updateAspenMatrices();
      changed = false;
      for (i = 0; i < sage.n; i++) {
        var hs = burn[sage.cell[i]] > SNAG_BURN ? 1 : 0;
        if (hs !== sage.hidden[i]) { sage.hidden[i] = hs; writeInst(sage, i); changed = true; }
      }
      if (changed) sage.mesh.instanceMatrix.needsUpdate = true;
      // snags
      var n = 0, land = world.land, x, y;
      for (i = 0; i < NN && n < MAX_SNAGS; i++) {
        if (burn[i] <= SNAG_BURN || (land[i] !== LAND.FOREST && land[i] !== LAND.RIPARIAN)) continue;
        x = i % N; y = (i / N) | 0;
        var cnt = 1 + (burn[i] > 0.6 ? 1 : 0), sev = burn[i];
        for (c = 0; c < cnt && n < MAX_SNAGS; c++) {
          var sx = sceneX(x) + (hash(i, c * 3 + 1) - 0.5) * 0.9, sz = sceneZ(y) + (hash(i, c * 3 + 2) - 0.5) * 0.9, s = 0.7 + 0.6 * hash(i, c * 3 + 4);
          _o.position.set(sx, hAt(sx, sz) - 0.03, sz); _o.rotation.set(0, hash(i, c * 3 + 3) * 6.28, 0); _o.scale.set(s, s * (0.7 + 0.5 * hash(i, c * 3 + 7)), s); _o.updateMatrix();
          snags.setMatrixAt(n, _o.matrix);
          var g = sev > 0.7 ? 0.2 : 0.42, jl = 0.85 + 0.3 * hash(i, c * 3 + 5);
          setColor(snags, n, g * jl, (g - 0.02) * jl, (g - 0.04) * jl); n++;
        }
      }
      snags.count = n; snags.instanceMatrix.needsUpdate = true; snags.instanceColor.needsUpdate = true;
      // houses
      changed = false;
      for (i = 0; i < houses.n; i++) {
        var hb = (houses.cell[i] >= 0 && burn[houses.cell[i]] > HOUSE_BURN) ? 1 : 0;
        if (hb !== houses.burned[i]) { houses.burned[i] = hb; writeHouse(i); changed = true; }
      }
      if (changed) { houseWalls.instanceMatrix.needsUpdate = true; houseRoofs.instanceMatrix.needsUpdate = true; }
    }
    function refreshCrops() {
      var ch = world.cropHealth, a = cropMesh.instanceColor.array, i;
      for (i = 0; i < crops.n; i++) {
        var h = ch ? clamp(fin(ch[crops.cell[i]], 0.85), 0, 1) : 0.85, jl = 0.92 + 0.16 * hash(crops.cell[i], 36);
        if (h >= 0.5) lerp3(a, i * 3, CROP_STRAW, CROP_GREEN, (h - 0.5) * 2); else lerp3(a, i * 3, CROP_BROWN, CROP_STRAW, h * 2);
        a[i * 3] *= jl; a[i * 3 + 1] *= jl; a[i * 3 + 2] *= jl;
      }
      cropMesh.instanceColor.needsUpdate = true;
    }
    function restoreBurningInst() {
      var k;
      for (k = 0; k < burningN; k++) writeInst(conifers, burningInst[k]);
      if (burningN) conifers.mesh.instanceMatrix.needsUpdate = true;
      for (k = 0; k < burningNA; k++) writeInst(aspens, burningInstA[k], season === 0 ? 0.6 : 1, season === 0 ? 0.85 : 1);
      if (burningNA) aspens.mesh.instanceMatrix.needsUpdate = true;
      burningN = burningNA = 0;
    }

    // ================================================================= API
    var props = {
      group: group, meshes: meshes,
      stats: { instances: 0, drawCalls: 0 },

      refresh: function (w, state) {
        if (w && w.elev) world = w;
        drought = !!(state && state.climate && fin(state.climate.soilMoisturePct, 45) < 30 && season === 2);
        refreshBurn(); refreshCrops(); recolor();
        if (state && state.reservoir && world.reservoir && typeof world.reservoir.levelForStorage === 'function') {
          try { var lv = world.reservoir.levelForStorage(fin(state.reservoir.storageAF, 0)); if (isFinite(lv)) birdBaseY = C.elevToScene(lv); } catch (e) { /* keep */ }
        }
        props.stats.instances = conifers.n + aspens.n + snags.count + sage.n + houses.n * 2 + barnCount + crops.n + hayMesh.count + fenceMesh.count + people.n + elk.n + trucks.n + cars.n + birds.n;
        props.stats.drawCalls = meshes.filter(function (m) { return m.count == null || m.count > 0; }).length;
      },

      setSeason: function (seasonIdx, o) {
        var prev = season;
        season = clamp(Math.round(fin(seasonIdx, 0)), 0, 3);
        var sl = o && isFinite(o.snowlineElev) ? o.snowlineElev : fin(world.snowlineElev, 2600) + SNOWLINE_BY_SEASON[season];
        snowline = sl;
        if (season !== 2) drought = false;
        if ((prev === 0) !== (season === 0)) updateAspenMatrices();
        recolor();
      },

      setWind: function (dirRad, mph) { windDir = fin(dirRad, 0); windMph = clamp(fin(mph, 0), 0, 120); },

      setFire: function (burningIdx) {
        var k, i;
        restoreBurningInst();
        cellBurning.fill(0);
        fireBN = 0; fireCount = 0; fireCX = fireCZ = 0;
        if (burningIdx && burningIdx.length) {
          for (k = 0; k < burningIdx.length; k++) {
            i = burningIdx[k] | 0; if (i < 0 || i >= NN) continue;
            cellBurning[i] = 1;
            var sx = sceneX(i % N), sz = sceneZ((i / N) | 0);
            fireCX += sx; fireCZ += sz; fireCount++;
            if (fireBN < fireBX.length) { fireBX[fireBN] = sx; fireBZ[fireBN] = sz; fireBN++; }
          }
          if (fireCount) { fireCX /= fireCount; fireCZ /= fireCount; }
          for (i = 0; i < conifers.n && burningN < MAX_BURNING_INST; i++) if (cellBurning[conifers.cell[i]] && !conifers.hidden[i]) burningInst[burningN++] = i;
          for (i = 0; i < aspens.n && burningNA < MAX_BURNING_INST; i++) if (cellBurning[aspens.cell[i]] && !aspens.hidden[i]) burningInstA[burningNA++] = i;
        }
        // truck targets on their own road
        for (k = 0; k < trucks.n; k++) {
          if (trucks.fixed[k]) continue;
          trucks.target[k] = fireCount ? nearestOnRoad(trucks.road[k], fireCX, fireCZ).s : trucks.home[k];
        }
      },

      update: function (dt, state) {
        dt = clamp(fin(dt, 0.016), 0, 0.1); time += dt;
        var k, p, y, mv;
        // burning trees flicker / shrink
        if (burningN || burningNA) {
          for (k = 0; k < burningN; k++) { var ii = burningInst[k]; writeInst(conifers, ii, 0.75 + 0.15 * Math.sin(time * 21 + ii), 0.55 + 0.2 * Math.sin(time * 17 + ii * 0.7)); }
          if (burningN) conifers.mesh.instanceMatrix.needsUpdate = true;
          for (k = 0; k < burningNA; k++) { var ia = burningInstA[k]; writeInst(aspens, ia, 0.7 + 0.15 * Math.sin(time * 19 + ia), 0.6 + 0.2 * Math.sin(time * 15 + ia)); }
          if (burningNA) aspens.mesh.instanceMatrix.needsUpdate = true;
        }
        // people
        for (k = 0; k < people.n; k++) {
          var rd = people.road[k];
          people.s[k] += people.dir[k] * people.spd[k] * dt;
          if (people.s[k] >= rd.len) { people.s[k] = rd.len; people.dir[k] = -1; people.side[k] = -PEOPLE_SIDE; }
          else if (people.s[k] <= 0) { people.s[k] = 0; people.dir[k] = 1; people.side[k] = PEOPLE_SIDE; }
          p = roadPoint(rd, people.s[k], _pt);
          var px = p.x - p.dz * people.side[k], pz = p.z + p.dx * people.side[k];
          _o.position.set(px, hAt(px, pz) + ROAD_LIFT + 0.012 * Math.abs(Math.sin(time * 9 + people.ph[k])), pz);
          _o.rotation.set(0, Math.atan2(p.dx * people.dir[k], p.dz * people.dir[k]), 0); _o.scale.set(1, 1, 1); _o.updateMatrix();
          peopleMesh.setMatrixAt(k, _o.matrix);
        }
        if (people.n) peopleMesh.instanceMatrix.needsUpdate = true;
        // elk
        var fireActive = fireBN > 0;
        for (k = 0; k < elk.n; k++) {
          var ex = elk.x[k], ez = elk.z[k], vx = 0, vz = 0, speed = 0;
          if (fireActive) {
            var bd = Infinity, bx = 0, bz = 0;
            for (var f = 0; f < fireBN; f++) { var dd = (fireBX[f] - ex) * (fireBX[f] - ex) + (fireBZ[f] - ez) * (fireBZ[f] - ez); if (dd < bd) { bd = dd; bx = fireBX[f]; bz = fireBZ[f]; } }
            if (bd < ELK_FLEE_RADIUS * ELK_FLEE_RADIUS) { var dl = Math.sqrt(bd) || 1; vx = (ex - bx) / dl; vz = (ez - bz) / dl; speed = ELK_FLEE_SPEED; elk.wait[k] = 1; elk.tx[k] = ex + vx * 3; elk.tz[k] = ez + vz * 3; }
          }
          if (!speed) {
            if (elk.wait[k] > 0) elk.wait[k] -= dt;
            else {
              var tdx = elk.tx[k] - ex, tdz = elk.tz[k] - ez, td = Math.hypot(tdx, tdz);
              if (td < 0.25) { elk.wait[k] = 2 + Math.random() * 5; elkPickTarget(k); }
              else { vx = tdx / td; vz = tdz / td; speed = ELK_SPEED; }
            }
          }
          if (speed) {
            var nx = clamp(ex + vx * speed * dt, -N / 2 + 0.5, N / 2 - 0.5), nz = clamp(ez + vz * speed * dt, -N / 2 + 0.5, N / 2 - 0.5);
            var lc = landOf(cellAtScene(nx, nz));
            if (lc !== LAND.RIVER && lc !== LAND.RESERVOIR) { elk.x[k] = nx; elk.z[k] = nz; }
            else { elk.wait[k] = 0.5; elkPickTarget(k); }
            var th = Math.atan2(vx, vz), dh = th - elk.head[k]; while (dh > Math.PI) dh -= 6.283185; while (dh < -Math.PI) dh += 6.283185;
            elk.head[k] += dh * Math.min(1, dt * 6);
          }
          y = hAt(elk.x[k], elk.z[k]) + (speed ? 0.02 * Math.abs(Math.sin(time * (speed > 1 ? 16 : 7) + elk.ph[k])) : 0);
          _o.position.set(elk.x[k], y, elk.z[k]); _o.rotation.set(0, elk.head[k], 0); _o.scale.set(1, 1, 1); _o.updateMatrix();
          elkMesh.setMatrixAt(k, _o.matrix);
        }
        if (elk.n) elkMesh.instanceMatrix.needsUpdate = true;
        // fire trucks
        var dispatch = fireCount > 0 && (state && state.fire ? !!state.fire.activeFire : true);
        for (k = 0; k < trucks.n; k++) {
          if (trucks.fixed[k]) {
            _o.position.set(trucks.x[k], hAt(trucks.x[k], trucks.z[k]) + 0.02, trucks.z[k]); _o.rotation.set(0, trucks.head[k], 0); _o.scale.set(1, 1, 1); _o.updateMatrix();
            truckMesh.setMatrixAt(k, _o.matrix); continue;
          }
          var trd = trucks.road[k], goal = dispatch ? trucks.target[k] : trucks.home[k], ds = goal - trucks.s[k];
          mv = 0;
          if (Math.abs(ds) > 0.02) { mv = ds > 0 ? 1 : -1; trucks.s[k] += mv * Math.min(Math.abs(ds), TRUCK_SPEED * dt); trucks.dir[k] = mv; }
          p = roadPoint(trd, trucks.s[k], _pt);
          var dirT = trucks.dir[k];
          var tx = p.x - p.dz * trucks.side[k] * dirT, tz = p.z + p.dx * trucks.side[k] * dirT;
          if (mv) trucks.head[k] = Math.atan2(p.dx * mv, p.dz * mv);
          _o.position.set(tx, hAt(tx, tz) + ROAD_LIFT + 0.01, tz); _o.rotation.set(0, trucks.head[k], 0); _o.scale.set(1, 1, 1); _o.updateMatrix();
          truckMesh.setMatrixAt(k, _o.matrix);
        }
        if (trucks.n) truckMesh.instanceMatrix.needsUpdate = true;
        // cars (ping-pong along the main road)
        for (k = 0; k < cars.n; k++) {
          cars.s[k] += cars.dir[k] * cars.spd[k] * dt;
          if (cars.s[k] >= mainRoad.len) { cars.s[k] = mainRoad.len; cars.dir[k] = -1; } else if (cars.s[k] <= 0) { cars.s[k] = 0; cars.dir[k] = 1; }
          p = roadPoint(mainRoad, cars.s[k], _pt);
          var cx = p.x - p.dz * 0.12 * cars.dir[k], cz = p.z + p.dx * 0.12 * cars.dir[k];
          _o.position.set(cx, hAt(cx, cz) + ROAD_LIFT + 0.01, cz); _o.rotation.set(0, Math.atan2(p.dx * cars.dir[k], p.dz * cars.dir[k]), 0); _o.scale.set(1, 1, 1); _o.updateMatrix();
          carMesh.setMatrixAt(k, _o.matrix);
        }
        if (cars.n) carMesh.instanceMatrix.needsUpdate = true;
        // birds circling the reservoir (drifting with wind)
        var wdx = Math.sin(windDir) * Math.min(3, windMph * 0.06), wdz = -Math.cos(windDir) * Math.min(3, windMph * 0.06);
        var bcx = sceneX(resCentre.x) + wdx, bcz = sceneZ(resCentre.y) + wdz;
        for (k = 0; k < birds.n; k++) {
          birds.ang[k] += birds.w[k] * dt;
          var a = birds.ang[k], r = birds.rad[k] + 0.4 * Math.sin(time * 0.3 + birds.ph[k]);
          var bxp = bcx + Math.cos(a) * r, bzp = bcz + Math.sin(a) * r, by = birdBaseY + birds.h[k] + 0.35 * Math.sin(time * 0.9 + birds.ph[k]);
          var tdxb = -Math.sin(a) * birds.w[k], tdzb = Math.cos(a) * birds.w[k];
          _o.position.set(bxp, by, bzp); _o.rotation.set(0, Math.atan2(tdxb, tdzb), 0.5 * Math.sin(time * 7 + birds.ph[k])); _o.scale.set(1, 1, 1); _o.updateMatrix();
          birdMesh.setMatrixAt(k, _o.matrix);
        }
        if (birds.n) birdMesh.instanceMatrix.needsUpdate = true;
      },

      dispose: function () {
        try { if (group.parent) group.parent.remove(group); } catch (e) { /* ignore */ }
        var k;
        for (k = 0; k < geometries.length; k++) geometries[k].dispose();
        for (k = 0; k < materials.length; k++) materials[k].dispose();
        for (k = 0; k < baseGeoms.length; k++) baseGeoms[k].dispose();
        meshes.length = 0; geometries.length = 0; materials.length = 0;
      }
    };

    // initial state (season 0 = winter → bare aspens)
    updateAspenMatrices();
    props.setSeason(0);
    props.refresh(world, null);
    return props;
  }

  WS.Props = { build: build };
})();
