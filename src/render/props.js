/* Watershed — props renderer (trees, buildings, farms, roads, dam, life). Export WS.Props.
   Browser only (needs global THREE r128). API:
     WS.Props.build(world, scene, opts) → props
       opts = { heightAt(sx, sz) → sceneY }   (fallback: cell elevation via WS.C.toScene)
     props.refresh(world, state)      // after fire/flood/season: snags, burned houses, crops, snow
     props.setSeason(seasonIdx, {snowlineElev})
     props.update(dt, state)          // life animation, burning-tree flicker
     props.setFire(burningIdx)        // [] to clear
     props.setBurningCells(cells)     // houses in these cells flicker toward orange (instanceColor); [] to clear
     props.setFireIntensity(level)    // 0..1, strengthens the house flicker
     props.setWind(dirRad, mph)
     props.setCamera(camera)          // camera used to size name tags (or pass opts.camera / opts.viewHeight() to build)
     props.advisors()                 // [{id, name, role, color, avatarEmoji, position:Vector3 (live), object:Object3D}]
     props.setAdvisorTalking(id|null) // bouncing arrow + pulsing ring on that advisor
     props.setAdvisorAlert(id, bool)  // "!" bubble above the name tag
     props.advisorAt(sx, sz, r=1.2)   // id|null — nearest advisor within r scene units of (sx, sz)
     props.advisorHit(raycaster)      // id|null — raycast against the six figures
     -- build-scene hooks (used by WS.Builds) --
     props.treesInCell(i) → count     // live (visible) conifers + aspens standing in cell i
     props.dropTree(i) → bool         // one live tree in cell i tilts, shrinks and vanishes over 0.8 s (stays hidden); false if none
     props.setThinnedZones({zoneId:strength}) // deterministically hide ~40% of live trees in those zones; re-applied on refresh
     props.clearCells(cells, frac=1)  // permanently hide (a deterministic fraction of) trees in these cells
     props.setRoofStyle(zoneId, 'metal'|'default', frac=1) // roofs of the first frac of houses in the zone
     props.housesInZone(zoneId) → [{i, x, y, z, rot, s, cell}] (scene coords)
     props.setCropsCleared(cells)     // crop rows in these cells hidden (full set; [] restores all)
     -- player avatar (SPEC3 §C) --
     props.setPlayer(spec, name)      // build/rebuild the director figure from a WS.Faces spec (parts swapped, old ones disposed)
     props.movePlayerTo(x, y, {run, face:{x,y}, maxSecs}) → Promise<bool>  // walk (4 cells/s; run 7) over terrain; straight line when clear,
                                      //   a water target snaps to the nearest dry cell; maxSecs (optional) teleports the rest of the way on expiry;
                                      //   else an A* route around water (smoothed to straight legs); per-step heading fan as safety;
                                      //   resolves true on arrival, false when cancelled by a newer call / teleport
     props.teleportPlayer(x, y, {face:{x,y}})
     props.playerPosition()           // {x, y (fractional cells), sx, sz, i, walking, heading} | null
     props.setPlayerAction('point'|'radio'|'dig'|'wave'|null)
     props.playerObject()             // THREE.Group | null (position live)
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
    return { group: null, meshes: [], stats: { instances: 0, drawCalls: 0 }, refresh: noop, setSeason: noop, update: noop, setFire: noop, setWind: noop, dispose: noop,
      setCamera: noop, advisors: function () { return []; }, setAdvisorTalking: noop, setAdvisorAlert: noop, advisorAt: function () { return null; }, advisorHit: function () { return null; },
      treesInCell: function () { return 0; }, dropTree: function () { return false; }, setThinnedZones: noop, clearCells: function () { return 0; }, setRoofStyle: function () { return 0; },
      housesInZone: function () { return []; }, setCropsCleared: noop,
      setPlayer: function () { return null; }, movePlayerTo: function () { return Promise.resolve(false); }, teleportPlayer: noop,
      playerPosition: function () { return null; }, setPlayerAction: noop, playerObject: function () { return null; } };
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
        rot: new Float32Array(cap), s: new Float32Array(cap), sy: new Float32Array(cap), col: new Float32Array(cap * 3), hidden: new Uint8Array(cap), mesh: null,
        thinned: new Uint8Array(cap), dropped: new Uint8Array(cap), cellStart: null, cellItems: null };
    }
    /** hidden = burned (snag) | thinned (project) | dropped (build scene / cleared cell) */
    function computeHidden(set, i) {
      var burn = world.burn;
      return ((burn && burn[set.cell[i]] > SNAG_BURN) || set.thinned[i] || set.dropped[i]) ? 1 : 0;
    }
    /** lazy CSR index cell → instances of a set */
    function cellIndex(set) {
      if (set.cellStart) return set;
      var start = new Int32Array(NN + 1), items = new Int32Array(Math.max(1, set.n)), i, c;
      for (i = 0; i < set.n; i++) { c = set.cell[i]; if (c >= 0 && c < NN) start[c + 1]++; }
      for (c = 0; c < NN; c++) start[c + 1] += start[c];
      var fill = new Int32Array(NN);
      for (i = 0; i < set.n; i++) { c = set.cell[i]; if (c >= 0 && c < NN) items[start[c] + fill[c]++] = i; }
      set.cellStart = start; set.cellItems = items;
      return set;
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
      rot: new Float32Array(MAX_HOUSES), s: new Float32Array(MAX_HOUSES), wc: new Uint8Array(MAX_HOUSES), rc: new Uint8Array(MAX_HOUSES), burned: new Uint8Array(MAX_HOUSES),
      zone: new Int16Array(MAX_HOUSES).fill(-1), roof: new Uint8Array(MAX_HOUSES) /* 0 default, 1 metal */ };
    var METAL_ROOF = rgb(0x9da4aa);
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
          houses.zone[i] = isFinite(b.zoneId) ? (b.zoneId | 0) : ((world.zone && houses.cell[i] >= 0) ? world.zone[houses.cell[i]] : -1);
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
    var crops = { n: 0, cell: new Int32Array(MAX_CROPS) }, cropMat0 = null, cropsCleared = new Uint8Array(NN);
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
      cropMat0 = new Float32Array(cropMesh.instanceMatrix.array.subarray(0, crops.n * 16));
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

    // ================================================================= ADVISORS (six named figures that wander like Sims)
    // Individual merged meshes (≤ ~300 tris each) sharing one body material; name tags are canvas sprites; one shared
    // "!" sprite material; one glow material for the talking ring + arrow. Update cost: 6 figures + 6 sprites / frame.
    var ADV_FALLBACK = [
      { id: 'dolores', name: 'Capt. Dolores Reyes', role: 'Wildland Fire Captain', color: '#d9532b', avatarEmoji: '🚒' },
      { id: 'walt', name: 'Walt Jensen', role: 'Rancher, Lazy J', color: '#b9863c', avatarEmoji: '🤠' },
      { id: 'naomi', name: 'Naomi Whitehorse', role: 'Tribal Water Representative', color: '#7b4fa8', avatarEmoji: '🪶' },
      { id: 'priya', name: 'Dr. Priya Natarajan', role: 'Hydrologist', color: '#2f7fb8', avatarEmoji: '📈' },
      { id: 'marcus', name: 'Marcus Lee', role: 'Resident and Parent, Marshall Heights', color: '#3f9a6a', avatarEmoji: '🏡' },
      { id: 'ana', name: 'Dr. Ana Ortiz', role: 'Wildlife Biologist', color: '#5a8a3a', avatarEmoji: '🦌' }
    ];
    var ADV_ROAM = 3.0, ADV_SPEED = 0.55, ADV_TAG_PX = 18, ADV_TAG_MAX_DIST = 130, ADV_TAG_MIN_H = 0.25, ADV_TAG_MAX_H = 1.5;
    var advWalkable = new Uint8Array(16);
    [LAND.ROAD, LAND.RESIDENTIAL, LAND.CIVIC, LAND.FARM, LAND.SHRUB, LAND.RIPARIAN, LAND.WETLAND].forEach(function (l) { advWalkable[l] = 1; });
    function advCellOk(sx, sz) { var ci = cellAtScene(sx, sz); return ci >= 0 && advWalkable[world.land[ci]] === 1; }
    var camera = (opts.camera && opts.camera.isCamera) ? opts.camera : null;
    var viewHeightFn = (typeof opts.viewHeight === 'function') ? opts.viewHeight : function () { return (root.innerHeight || 800); };
    var advBodyMat = mat(), advGlowMat = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.85, depthWrite: false });
    materials.push(advBodyMat, advGlowMat);
    var advGroup = new THREE.Group(); advGroup.name = 'advisors'; group.add(advGroup);
    var advisors = [], advById = {}, advTalking = null, advList = null;
    var _v3 = new THREE.Vector3();

    function hexToRgb(hex) { var c = new THREE.Color(String(hex || '#888888')); return [c.r, c.g, c.b]; }
    function firstName(name) {
      var parts = String(name || '').split(/\s+/).filter(function (p) { return p && !/\.$/.test(p); });
      return parts[0] || String(name || '?');
    }
    /** stylised low-poly person, ~1.6 units tall, forward = +z. `sig` picks the signature outfit. */
    function figureGeo(ch) {
      var body = hexToRgb(ch.color), skin = [0.86, 0.66, 0.5], hair = [0.16, 0.12, 0.1], pants = [0.24, 0.26, 0.32], shoes = [0.15, 0.12, 0.1];
      var torso = body, sleeve = [body[0] * 0.85, body[1] * 0.85, body[2] * 0.85], p = [];
      switch (ch.id) {
        case 'dolores': skin = [0.72, 0.5, 0.36]; torso = [0.78, 0.16, 0.14]; sleeve = [0.7, 0.14, 0.12]; pants = [0.16, 0.16, 0.2]; break;
        case 'walt': skin = [0.82, 0.6, 0.45]; pants = [0.22, 0.28, 0.42]; hair = [0.55, 0.52, 0.5]; break;
        case 'naomi': skin = [0.68, 0.46, 0.32]; hair = [0.08, 0.06, 0.06]; pants = [0.3, 0.2, 0.18]; break;
        case 'priya': skin = [0.62, 0.42, 0.3]; hair = [0.1, 0.08, 0.08]; torso = [0.94, 0.94, 0.95]; sleeve = [0.9, 0.9, 0.92]; pants = [0.2, 0.22, 0.3]; break;
        case 'marcus': skin = [0.9, 0.72, 0.56]; torso = [0.22, 0.42, 0.78]; sleeve = [0.2, 0.38, 0.72]; pants = [0.26, 0.26, 0.28]; break;
        case 'ana': skin = [0.78, 0.58, 0.42]; hair = [0.3, 0.2, 0.12]; pants = [0.42, 0.36, 0.26]; break;
      }
      // legs + shoes
      p.push(part(BOX, pants, 0.1, 0.33, 0, 0, 0.15, 0.62, 0.17), part(BOX, pants, -0.1, 0.33, 0, 0, 0.15, 0.62, 0.17));
      p.push(part(BOX, shoes, 0.1, 0.03, 0.02, 0, 0.16, 0.07, 0.22), part(BOX, shoes, -0.1, 0.03, 0.02, 0, 0.16, 0.07, 0.22));
      // torso + arms + neck + head + hair
      p.push(part(BOX, torso, 0, 0.94, 0, 0, 0.44, 0.62, 0.27));
      p.push(part(BOX, sleeve, 0.29, 0.92, 0, 0, 0.13, 0.54, 0.14, 0, 0.08), part(BOX, sleeve, -0.29, 0.92, 0, 0, 0.13, 0.54, 0.14, 0, -0.08));
      p.push(part(BOX, skin, 0.3, 0.62, 0, 0, 0.11, 0.1, 0.11), part(BOX, skin, -0.3, 0.62, 0, 0, 0.11, 0.1, 0.11));
      p.push(part(CYL8, skin, 0, 1.27, 0, 0, 0.14, 0.08, 0.14));
      p.push(part(SPH, skin, 0, 1.44, 0, 0, 0.34, 0.36, 0.34));
      if (ch.id !== 'dolores' && ch.id !== 'walt') p.push(part(SPH, hair, 0, 1.5, -0.02, 0, 0.36, 0.26, 0.36));
      if (ch.id === 'naomi') p.push(part(BOX, hair, 0, 1.3, -0.16, 0, 0.22, 0.5, 0.08));           // long hair at the back
      // signature items
      switch (ch.id) {
        case 'dolores': // yellow helmet with brim + reflective stripes on the red jacket
          p.push(part(SPH, [1, 0.82, 0.16], 0, 1.54, 0, 0, 0.42, 0.3, 0.42), part(CYL8, [1, 0.82, 0.16], 0, 1.43, 0.02, 0, 0.5, 0.04, 0.54));
          p.push(part(BOX, [0.95, 0.95, 0.4], 0, 0.86, 0.14, 0, 0.44, 0.06, 0.02), part(BOX, [0.95, 0.95, 0.4], 0, 1.06, 0.14, 0, 0.44, 0.06, 0.02));
          break;
        case 'walt': // wide-brimmed hat + belt buckle
          p.push(part(CYL8, [0.42, 0.3, 0.18], 0, 1.62, 0, 0, 0.3, 0.2, 0.3), part(CYL8, [0.42, 0.3, 0.18], 0, 1.53, 0, 0, 0.66, 0.035, 0.66));
          p.push(part(BOX, [0.85, 0.7, 0.3], 0, 0.64, 0.14, 0, 0.1, 0.07, 0.02));
          break;
        case 'naomi': // turquoise sash across the torso + ribbon
          p.push(part(BOX, [0.22, 0.78, 0.74], 0, 0.94, 0.15, 0, 0.11, 0.7, 0.03, 0, 0.62));
          p.push(part(BOX, [0.22, 0.78, 0.74], 0.12, 1.5, -0.12, 0, 0.06, 0.16, 0.03, 0, 0.3));
          break;
        case 'priya': // white coat (open front shows her blue shirt) + clipboard
          p.push(part(BOX, body, 0, 0.94, 0.135, 0, 0.14, 0.58, 0.02));
          p.push(part(BOX, [0.5, 0.36, 0.22], -0.3, 0.96, 0.16, 0, 0.2, 0.26, 0.03, -0.3), part(BOX, [0.97, 0.97, 0.97], -0.3, 0.965, 0.18, 0, 0.16, 0.2, 0.01, -0.3));
          break;
        case 'marcus': // blue hoodie: hood behind the head + kangaroo pocket + drawstrings
          p.push(part(SPH, torso, 0, 1.4, -0.1, 0, 0.42, 0.4, 0.34), part(BOX, torso, 0, 0.76, 0.14, 0, 0.26, 0.14, 0.03));
          p.push(part(BOX, [0.95, 0.95, 0.95], 0.05, 1.08, 0.15, 0, 0.02, 0.16, 0.01), part(BOX, [0.95, 0.95, 0.95], -0.05, 1.08, 0.15, 0, 0.02, 0.16, 0.01));
          break;
        case 'ana': // green field vest + binoculars on a strap
          p.push(part(BOX, [0.18, 0.42, 0.2], 0.16, 0.96, 0, 0, 0.16, 0.56, 0.3), part(BOX, [0.18, 0.42, 0.2], -0.16, 0.96, 0, 0, 0.16, 0.56, 0.3));
          p.push(part(CYL8, [0.1, 0.1, 0.12], 0.06, 1.02, 0.17, 0, 0.09, 0.14, 0.09, Math.PI / 2), part(CYL8, [0.1, 0.1, 0.12], -0.06, 1.02, 0.17, 0, 0.09, 0.14, 0.09, Math.PI / 2));
          break;
      }
      return mergeParts(p);
    }
    function roundRect(g, x, y, w, h, r) {
      g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r);
      g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
    }
    function makeTagSprite(ch, labelOverride, register) {
      if (typeof document === 'undefined') return null;
      var cv = document.createElement('canvas'); cv.width = 320; cv.height = 80;
      var g = cv.getContext('2d'); if (!g) return null;
      var label = labelOverride != null ? String(labelOverride) : (ch.avatarEmoji || '') + ' ' + firstName(ch.name);
      g.font = 'bold 40px system-ui, -apple-system, "Segoe UI", sans-serif'; g.textBaseline = 'middle';
      var tw = Math.min(300, g.measureText(label).width + 40), x0 = (320 - tw) / 2;
      g.fillStyle = 'rgba(18,22,28,0.82)'; roundRect(g, x0, 6, tw, 68, 20); g.fill();
      g.lineWidth = 5; g.strokeStyle = String(ch.color || '#fff'); roundRect(g, x0 + 2.5, 8.5, tw - 5, 63, 18); g.stroke();
      g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.fillText(label, 160, 42, 290);
      var tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
      if ('encoding' in tex && THREE.sRGBEncoding != null) tex.encoding = THREE.sRGBEncoding;
      var sm = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
      var sp = new THREE.Sprite(sm); sp.center.set(0.5, 0); sp.renderOrder = 30; sp.frustumCulled = false;
      if (register !== false) { materials.push(sm); geometries.push({ dispose: function () { tex.dispose(); } }); }
      return sp;
    }
    var alertMat = (function () {
      if (typeof document === 'undefined') return null;
      var cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      var g = cv.getContext('2d'); if (!g) return null;
      g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fillStyle = '#ffd24a'; g.fill(); g.lineWidth = 4; g.strokeStyle = '#3a2a08'; g.stroke();
      g.fillStyle = '#3a2a08'; g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', 32, 34);
      var tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
      var m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
      materials.push(m); geometries.push({ dispose: function () { tex.dispose(); } });
      return m;
    })();

    // ---- home spots (scene xz), derived from world.buildings / zones / river / wetland
    function zoneName(z) { return z && z.name ? String(z.name).toLowerCase() : ''; }
    function findZone(type, re) {
      var zs = zonesOf(type), k;
      for (k = 0; k < zs.length; k++) if (re.test(zoneName(zs[k]))) return zs[k];
      return zs[0] || null;
    }
    function bldgsOf(type) { return buildings.filter(function (b) { return b && b.type === type && isFinite(b.x) && isFinite(b.y); }); }
    /** nearest walkable cell to (cx,cy) in cell space, preferring land types in `prefer` (array) within `r` */
    function walkableNear(cx, cy, r, prefer) {
      cx = clamp(Math.round(fin(cx, N / 2)), 0, N - 1); cy = clamp(Math.round(fin(cy, N / 2)), 0, N - 1);
      var pass, best = null, bd = Infinity, dx, dy, x, y, l, i, d;
      for (pass = 0; pass < 2; pass++) {
        for (dy = -r; dy <= r; dy++) for (dx = -r; dx <= r; dx++) {
          x = cx + dx; y = cy + dy; if (x < 0 || y < 0 || x >= N || y >= N) continue;
          i = y * N + x; l = world.land[i];
          if (advWalkable[l] !== 1) continue;
          if (pass === 0 && prefer && prefer.indexOf(l) < 0) continue;
          d = dx * dx + dy * dy; if (d < bd) { bd = d; best = { x: x, y: y }; }
        }
        if (best) break;
        if (!prefer) break;
      }
      return best;
    }
    function frontOf(b, dist) { // spot in front of a building (rot 0 faces +y/south)
      var rot = fin(b.rot, 0), x = fin(b.x, N / 2) + Math.sin(rot) * dist, y = fin(b.y, N / 2) + Math.cos(rot) * dist;
      return walkableNear(x, y, 4, [LAND.ROAD, LAND.CIVIC, LAND.RESIDENTIAL, LAND.FARM]);
    }
    var townC = (world.townCenter && isFinite(world.townCenter.x)) ? world.townCenter : ((findZone('civic', /./) || {}).center || { x: N / 2, y: N / 2 });
    function homeFor(id) {
      var spot = null, b, list, k, z;
      switch (id) {
        case 'dolores': // the WUI fire station = the station farthest from the civic core
          list = bldgsOf('fire_station'); b = null;
          for (k = 0; k < list.length; k++) if (!b || Math.hypot(list[k].x - townC.x, list[k].y - townC.y) > Math.hypot(b.x - townC.x, b.y - townC.y)) b = list[k];
          if (b) spot = frontOf(b, 1.4);
          break;
        case 'walt': // Lazy J barn (by zone name), else any barn, else the farm zone centre
          list = bldgsOf('barn'); b = null;
          for (k = 0; k < list.length; k++) { z = zoneById(list[k].zoneId); if (/lazy/.test(zoneName(z))) { b = list[k]; break; } }
          if (!b && list.length) b = list[0];
          if (b) spot = frontOf(b, 1.6);
          if (!spot) { z = findZone('farm', /lazy/); if (z && z.center) spot = walkableNear(z.center.x, z.center.y, 6, [LAND.FARM, LAND.ROAD]); }
          break;
        case 'naomi': { // riverbank a few nodes below the dam
          var rp = world.river && world.river.path, di = world.river ? fin(world.river.damIndex, -1) : -1;
          if (rp && rp.length && di >= 0) { var node = rp[clamp(di + 7, 0, rp.length - 1)]; spot = walkableNear(node.x, node.y, 5, [LAND.RIPARIAN, LAND.SHRUB, LAND.WETLAND]); }
          break;
        }
        case 'priya': // treatment plant, else the dam
          list = bldgsOf('treatment_plant');
          if (list.length) spot = frontOf(list[0], 1.4);
          if (!spot && world.reservoir && world.reservoir.dam) spot = walkableNear(world.reservoir.dam.x, world.reservoir.dam.y, 6, [LAND.ROAD, LAND.CIVIC, LAND.SHRUB, LAND.RIPARIAN]);
          break;
        case 'marcus': { // a street in Old Mill (road cell nearest the zone centre), else any neighbourhood
          z = findZone('neighborhood', /old\s*mill/);
          if (z && z.center) spot = walkableNear(z.center.x, z.center.y, 8, [LAND.ROAD]);
          break;
        }
        case 'ana': { // the wetland
          var wc = (world.wetland && world.wetland.center && isFinite(world.wetland.center.x)) ? world.wetland.center : ((findZone('wetland', /./) || {}).center || null);
          if (wc) spot = walkableNear(wc.x, wc.y, 8, [LAND.WETLAND, LAND.RIPARIAN, LAND.SHRUB]);
          break;
        }
      }
      if (!spot) spot = walkableNear(townC.x, townC.y, 20, null) || { x: N / 2, y: N / 2 };
      return { x: sceneX(spot.x), z: sceneZ(spot.y), cx: spot.x, cy: spot.y };
    }
    function advPathClear(x0, z0, x1, z1) {
      var d = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(d / 0.4)), k;
      for (k = 1; k <= n; k++) { var t = k / n; if (!advCellOk(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false; }
      return true;
    }
    function advPickTarget(a) {
      for (var t = 0; t < 10; t++) {
        var ang = Math.random() * 6.283185, r = 0.6 + Math.random() * (ADV_ROAM - 0.6);
        var tx = a.home.x + Math.cos(ang) * r, tz = a.home.z + Math.sin(ang) * r;
        if (Math.abs(tx) > N / 2 - 1 || Math.abs(tz) > N / 2 - 1) continue;
        if (!advCellOk(tx, tz) || !advPathClear(a.x, a.z, tx, tz)) continue;
        a.tx = tx; a.tz = tz; a.walking = true; return;
      }
      a.wait = 1 + Math.random() * 2; a.walking = false;
    }
    (function buildAdvisors() {
      var chars = (WS.Advisors && Array.isArray(WS.Advisors.CHARACTERS) && WS.Advisors.CHARACTERS.length) ? WS.Advisors.CHARACTERS : ADV_FALLBACK;
      for (var k = 0; k < chars.length && k < 8; k++) {
        var ch = chars[k]; if (!ch || !ch.id) continue;
        var geo = figureGeo(ch), mesh = new THREE.Mesh(geo, advBodyMat);
        mesh.name = 'advisor:' + ch.id; mesh.castShadow = true; mesh.receiveShadow = false; mesh.frustumCulled = false;
        mesh.userData.advisorId = ch.id;
        geometries.push(geo); meshes.push(mesh); advGroup.add(mesh);
        var home = homeFor(ch.id);
        var a = { id: ch.id, name: String(ch.name || ch.id), role: String(ch.role || ''), color: String(ch.color || '#888'), emoji: String(ch.avatarEmoji || ''),
          object: mesh, home: home, x: home.x, z: home.z, tx: home.x, tz: home.z, heading: Math.random() * 6.283185, wait: 0.5 + hash(k, 91) * 2, walking: false,
          ph: hash(k, 92) * 6.283185, tag: makeTagSprite(ch), alert: null, alertOn: false, tagH: 1 };
        if (a.tag) { advGroup.add(a.tag); }
        if (alertMat) { a.alert = new THREE.Sprite(alertMat); a.alert.center.set(0.5, 0); a.alert.renderOrder = 31; a.alert.visible = false; a.alert.frustumCulled = false; advGroup.add(a.alert); }
        mesh.position.set(a.x, hAt(a.x, a.z), a.z); mesh.rotation.y = a.heading;
        advisors.push(a); advById[a.id] = a;
      }
    })();
    // talking indicator: pulsing ring at the feet (mesh) + bouncing arrow over the name tag (camera-facing sprite, always on
    // top like the tags — a depth-tested mesh up there is unreliable against the overlays). One of each, moved to the talker.
    var ringGeo = new THREE.RingGeometry(0.5, 0.72, 24); ringGeo.rotateX(-Math.PI / 2);
    var talkRing = new THREE.Mesh(ringGeo, advGlowMat);
    talkRing.visible = false; talkRing.renderOrder = 20; talkRing.frustumCulled = false;
    advGroup.add(talkRing); geometries.push(ringGeo);
    var talkArrow = (function () {
      if (typeof document === 'undefined') { var o = new THREE.Object3D(); o.visible = false; return o; }
      var cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      var g = cv.getContext('2d'); if (!g) { var o2 = new THREE.Object3D(); o2.visible = false; return o2; }
      g.beginPath(); g.moveTo(8, 10); g.lineTo(56, 10); g.lineTo(32, 56); g.closePath();
      g.fillStyle = '#ffd24a'; g.fill(); g.lineWidth = 5; g.lineJoin = 'round'; g.strokeStyle = '#3a2a08'; g.stroke();
      var tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
      var m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
      var sp = new THREE.Sprite(m); sp.center.set(0.5, 0); sp.renderOrder = 32; sp.frustumCulled = false; sp.visible = false;
      materials.push(m); geometries.push({ dispose: function () { tex.dispose(); } });
      advGroup.add(sp);
      return sp;
    })();

    var _cam = { has: false, x: 0, y: 0, z: 0, tanHalf: 0.4142, viewH: 800 };
    function readCam() {
      _cam.has = !!camera;
      if (!_cam.has) return;
      _cam.x = camera.position.x; _cam.y = camera.position.y; _cam.z = camera.position.z;
      _cam.tanHalf = camera.isPerspectiveCamera ? Math.tan(fin(camera.fov, 45) * Math.PI / 360) : 0.4142;
      _cam.viewH = Math.max(100, fin(viewHeightFn(), 800));
    }
    function updateAdvisors(dt) {
      var k, a, camX = _cam.x, camY = _cam.y, camZ = _cam.z, tanHalf = _cam.tanHalf, viewH = _cam.viewH, hasCam = _cam.has;
      for (k = 0; k < advisors.length; k++) {
        a = advisors[k];
        // --- wander
        if (a.walking) {
          var dx = a.tx - a.x, dz = a.tz - a.z, d = Math.hypot(dx, dz);
          if (d < 0.08) { a.walking = false; a.wait = 1.5 + Math.random() * 4; }
          else {
            var step = Math.min(d, ADV_SPEED * dt), nx = a.x + dx / d * step, nz = a.z + dz / d * step;
            if (advCellOk(nx, nz)) { a.x = nx; a.z = nz; } else { a.walking = false; a.wait = 0.6; }
            var th = Math.atan2(dx, dz), dh = th - a.heading; while (dh > Math.PI) dh -= 6.283185; while (dh < -Math.PI) dh += 6.283185;
            a.heading += dh * Math.min(1, dt * 7);
          }
        } else {
          a.wait -= dt;
          if (a.wait <= 0) advPickTarget(a);
          else if (Math.random() < dt * 0.15) { a.heading += (Math.random() - 0.5) * 0.6; } // occasional idle glance
        }
        var baseY = hAt(a.x, a.z), bob = a.walking ? 0.035 * Math.abs(Math.sin(time * 9 + a.ph)) : 0.008 * Math.sin(time * 1.8 + a.ph);
        var o = a.object;
        o.position.set(a.x, baseY + bob, a.z); o.rotation.set(a.walking ? 0.06 : 0, a.heading, a.walking ? 0.03 * Math.sin(time * 9 + a.ph) : 0);
        var br = a.walking ? 1 : 1 + 0.012 * Math.sin(time * 1.8 + a.ph); o.scale.set(1, br, 1);
        // --- name tag: constant ~ADV_TAG_PX pixels tall, hidden beyond ADV_TAG_MAX_DIST
        var tagTop = baseY + 1.85, dist = hasCam ? Math.hypot(camX - a.x, camY - baseY, camZ - a.z) : 60;
        var h = clamp(ADV_TAG_PX * 2 * dist * tanHalf / viewH, ADV_TAG_MIN_H, ADV_TAG_MAX_H);
        a.tagH = h;
        if (a.tag) {
          var show = dist <= ADV_TAG_MAX_DIST;
          a.tag.visible = show;
          if (show) { a.tag.scale.set(h * 4, h, 1); a.tag.position.set(a.x, tagTop, a.z); tagTop += h; }
        }
        if (a.alert) {
          a.alert.visible = a.alertOn && dist <= ADV_TAG_MAX_DIST;
          if (a.alert.visible) { var ah = h * 0.9; a.alert.scale.set(ah, ah, 1); a.alert.position.set(a.x, tagTop + 0.05 * h + 0.06 * h * Math.sin(time * 5 + a.ph), a.z); tagTop += ah * 1.1; }
        }
        if (advTalking === a.id) {
          var pulse = 0.5 + 0.5 * Math.sin(time * 4);
          talkRing.visible = talkArrow.visible = true;
          talkRing.position.set(a.x, baseY + 0.1, a.z); var rs = 1 + 0.18 * pulse; talkRing.scale.set(rs, 1, rs);
          advGlowMat.opacity = 0.55 + 0.35 * pulse;
          var as = h * 0.85;
          talkArrow.scale.set(as, as, 1); talkArrow.position.set(a.x, tagTop + 0.1 * h + 0.35 * h * Math.abs(Math.sin(time * 3.2)), a.z);
        }
      }
      if (advTalking && !advById[advTalking]) advTalking = null;
      if (!advTalking) talkRing.visible = talkArrow.visible = false;
    }
    function advisorList() {
      if (!advList) advList = advisors.map(function (a) { return { id: a.id, name: a.name, role: a.role, color: a.color, avatarEmoji: a.emoji, position: a.object.position, object: a.object }; });
      return advList;
    }
    function advisorAt(sx, sz, radius) {
      var r = fin(radius, 1.2), best = null, bd = r * r, k, a, d;
      for (k = 0; k < advisors.length; k++) { a = advisors[k]; d = (a.x - sx) * (a.x - sx) + (a.z - sz) * (a.z - sz); if (d <= bd) { bd = d; best = a.id; } }
      return best;
    }
    var advMeshes = advisors.map(function (a) { return a.object; });
    function advisorHit(raycaster) {
      if (!raycaster || typeof raycaster.intersectObjects !== 'function' || !advMeshes.length) return null;
      var hits = raycaster.intersectObjects(advMeshes, false);
      return (hits && hits.length) ? (hits[0].object.userData.advisorId || null) : null;
    }

    // ================================================================= PLAYER (SPEC3 §C) — the director's avatar
    // One figure built from the advisor part kit: merged body (torso, head, hair cap, hat, glasses band, chest accessory)
    // + two legs + two 2-segment arms as separate meshes so it can stride / point / hold a radio, a curved face patch on
    // the front of the head textured with the WS.Faces portrait, and a name-tag sprite. ≤ 8 draw calls, one figure.
    var PLAYER_SCALE = 1.08, PLAYER_WALK = 4.0, PLAYER_RUN = 7.0, PLAYER_TURN = 9, PLAYER_LOOKAHEAD = 0.7, PLAYER_STUCK_S = 1.0;
    var PLAYER_OFFS = [0, 0.8, -0.8, 1.5, -1.5, 2.2, -2.2];           // heading offsets tried when the next cell is water (last pair backs out of bays)
    var FACE_CROP = { rx: 0.72, ry: 0.72, ox: 0.14, oy: 0.26 };         // portrait region shown on the head (head-and-shoulders → head)
    var FACE_FALLBACK = {                                               // colour tables when WS.Faces is absent
      skin: { s1: '#f6d3b8', s2: '#e8b894', s3: '#c98f66', s4: '#a56a45', s5: '#7a4a2e', s6: '#4d2f1e' },
      hairColor: { h1: '#2b1d14', h2: '#5a3a22', h3: '#a3652f', h4: '#d9b06a', h5: '#b5b5b5', h6: '#c0392b' },
      outfit: { o1: '#2f6fb3', o2: '#c0392b', o3: '#2e8b57', o4: '#e2a93b', o5: '#6b4fbb', o6: '#444444' }
    };
    var playerMat = mat({ emissive: 0xffffff, emissiveIntensity: 0.05 }); materials.push(playerMat);
    var playerGroup = new THREE.Group(); playerGroup.name = 'player'; group.add(playerGroup);
    var player = null;

    function faceHex(kind, id, dflt) {
      var F = WS.Faces;
      if (F && typeof F.hexOf === 'function') { try { var h = F.hexOf(kind, id); if (h) return String(h); } catch (e) { /* fallthrough */ } }
      if (typeof id === 'string' && id.charAt(0) === '#') return id;
      var t = FACE_FALLBACK[kind]; return (t && t[id]) || dflt;
    }
    function pcol(hex, mul) { var c = hexToRgb(hex); mul = mul == null ? 1 : mul; return [Math.min(1, c[0] * mul), Math.min(1, c[1] * mul), Math.min(1, c[2] * mul)]; }
    function normSpec(spec) {
      var F = WS.Faces, s = (spec && typeof spec === 'object') ? spec : {};
      if (F && typeof F.normalize === 'function') { try { var n = F.normalize(s); if (n && typeof n === 'object') s = n; } catch (e) { /* keep */ } }
      var o = {};
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) o[k] = s[k];
      o.skin = o.skin || 's3'; o.hair = o.hair || 'short'; o.hairColor = o.hairColor || 'h1'; o.glasses = o.glasses || 'none';
      o.hat = o.hat || 'none'; o.outfit = o.outfit || 'o1'; o.accessory = o.accessory || 'none';
      return o;
    }
    function playerColours(s) {
      var outfit = faceHex('outfit', s.outfit, '#2f6fb3'), skinHex = faceHex('skin', s.skin, '#c98f66');
      return { skinHex: skinHex, outfitHex: outfit, skin: pcol(skinHex, 1.04), hair: pcol(faceHex('hairColor', s.hairColor, '#2b1d14')),
        torso: pcol(outfit, 1.1), sleeve: pcol(outfit, 0.92), trim: pcol(outfit, 0.72), pants: [0.24, 0.26, 0.32], shoes: [0.15, 0.12, 0.1] };
    }
    /** merged body: torso, neck, head, hair silhouette, hat, glasses band, chest accessory (legs/arms are separate) */
    function playerBodyGeo(s, c) {
      var p = [], hair = c.hair, hatOn = s.hat && s.hat !== 'none', hs = s.hair;
      p.push(part(BOX, c.torso, 0, 0.94, 0, 0, 0.44, 0.62, 0.27), part(BOX, c.trim, 0, 0.655, 0, 0, 0.46, 0.07, 0.29));
      p.push(part(CYL8, c.skin, 0, 1.27, 0, 0, 0.14, 0.08, 0.14), part(SPH, c.skin, 0, 1.44, 0, 0, 0.34, 0.36, 0.34));
      // hair: ten styles collapsed to a few silhouettes (big styles shrink to a short cap under a hat)
      if (hatOn && (hs === 'afro' || hs === 'curly' || hs === 'wavy')) hs = 'short';
      switch (hs) {
        case 'bald': break;
        case 'buzz': p.push(part(SPH, hair, 0, 1.5, -0.02, 0, 0.345, 0.24, 0.345)); break;
        case 'afro': p.push(part(SPH, hair, 0, 1.53, -0.03, 0, 0.54, 0.5, 0.54)); break;
        case 'long': p.push(part(SPH, hair, 0, 1.5, -0.02, 0, 0.37, 0.28, 0.37), part(BOX, hair, 0, 1.27, -0.15, 0, 0.3, 0.52, 0.1)); break;
        case 'braids': p.push(part(SPH, hair, 0, 1.5, -0.02, 0, 0.37, 0.27, 0.37), part(BOX, hair, 0.15, 1.2, -0.08, 0, 0.07, 0.5, 0.07), part(BOX, hair, -0.15, 1.2, -0.08, 0, 0.07, 0.5, 0.07)); break;
        case 'bun': p.push(part(SPH, hair, 0, 1.5, -0.02, 0, 0.36, 0.26, 0.36), part(SPH, hair, 0, hatOn ? 1.5 : 1.6, hatOn ? -0.2 : -0.17, 0, 0.16, 0.14, 0.16)); break;
        case 'ponytail': p.push(part(SPH, hair, 0, 1.5, -0.02, 0, 0.36, 0.26, 0.36), part(BOX, hair, 0, 1.3, -0.2, 0, 0.09, 0.42, 0.09, 0.35)); break;
        case 'curly': p.push(part(SPH, hair, 0, 1.51, -0.02, 0, 0.41, 0.3, 0.41), part(SPH, hair, 0.15, 1.45, -0.08, 0, 0.16, 0.16, 0.16), part(SPH, hair, -0.15, 1.45, -0.08, 0, 0.16, 0.16, 0.16)); break;
        case 'wavy': p.push(part(SPH, hair, 0, 1.5, -0.03, 0, 0.38, 0.28, 0.39), part(BOX, hair, 0, 1.36, -0.13, 0, 0.32, 0.2, 0.1)); break;
        default: p.push(part(SPH, hair, 0, 1.5, -0.02, 0, 0.36, 0.26, 0.36)); // short
      }
      var hc;
      switch (s.hat) {
        case 'cap': hc = pcol(c.outfitHex, 0.85); p.push(part(SPH, hc, 0, 1.53, 0, 0, 0.4, 0.3, 0.4), part(BOX, hc, 0, 1.5, 0.23, 0, 0.3, 0.03, 0.2)); break;
        case 'widebrim': hc = [0.42, 0.3, 0.18]; p.push(part(CYL8, hc, 0, 1.64, 0, 0, 0.3, 0.2, 0.3), part(CYL8, hc, 0, 1.55, 0, 0, 0.68, 0.035, 0.68)); break;
        case 'beanie': hc = pcol(c.outfitHex, 0.7); p.push(part(SPH, hc, 0, 1.57, 0, 0, 0.4, 0.34, 0.4), part(CYL8, pcol(c.outfitHex, 0.5), 0, 1.5, 0, 0, 0.41, 0.08, 0.41)); break;
        case 'helmet': hc = [0.85, 0.16, 0.14]; p.push(part(SPH, hc, 0, 1.55, 0, 0, 0.43, 0.32, 0.43), part(CYL8, hc, 0, 1.45, 0.02, 0, 0.52, 0.04, 0.56), part(BOX, [0.95, 0.95, 0.5], 0, 1.56, 0.19, 0, 0.12, 0.08, 0.02)); break;
        case 'hardhat': hc = [1, 0.8, 0.16]; p.push(part(SPH, hc, 0, 1.55, 0, 0, 0.42, 0.3, 0.42), part(CYL8, hc, 0, 1.47, 0.03, 0, 0.5, 0.035, 0.52)); break;
      }
      if (s.glasses && s.glasses !== 'none') {
        var gc = s.glasses === 'sun' ? [0.06, 0.06, 0.08] : [0.18, 0.18, 0.2], gh = s.glasses === 'sun' ? 0.06 : 0.03;
        p.push(part(BOX, gc, 0, 1.465, 0.185, 0, 0.3, gh, 0.02), part(BOX, gc, 0.155, 1.465, 0.07, 0, 0.012, 0.014, 0.22), part(BOX, gc, -0.155, 1.465, 0.07, 0, 0.012, 0.014, 0.22));
      }
      if (s.accessory === 'binoculars') {
        p.push(part(BOX, [0.15, 0.12, 0.1], 0, 1.16, 0.135, 0, 0.3, 0.02, 0.02));
        p.push(part(CYL8, [0.1, 0.1, 0.12], 0.06, 1.02, 0.17, 0, 0.09, 0.14, 0.09, Math.PI / 2), part(CYL8, [0.1, 0.1, 0.12], -0.06, 1.02, 0.17, 0, 0.09, 0.14, 0.09, Math.PI / 2));
      } else if (s.accessory === 'scarf') {
        var sc = (s.outfit === 'o2' || s.outfit === 'o6') ? [0.2, 0.7, 0.7] : [0.85, 0.24, 0.2];
        p.push(part(CYL8, sc, 0, 1.24, 0, 0, 0.32, 0.1, 0.32), part(BOX, sc, 0.1, 1.05, 0.15, 0, 0.1, 0.32, 0.03, 0, 0.15));
      }
      return mergeParts(p);
    }
    /** limb geometries, pivot at the joint, hanging down -y (leg: hip; upper arm: shoulder; forearm: elbow, hand + hand-held prop) */
    function playerLegGeo(c) { return mergeParts([part(BOX, c.pants, 0, -0.31, 0, 0, 0.15, 0.62, 0.17), part(BOX, c.shoes, 0, -0.61, 0.02, 0, 0.16, 0.07, 0.22)]); }
    function playerUpperArmGeo(c) { return mergeParts([part(BOX, c.sleeve, 0, -0.15, 0, 0, 0.13, 0.32, 0.14)]); }
    function playerForearmGeo(c, held) {
      var p = [part(BOX, c.sleeve, 0, -0.14, 0, 0, 0.125, 0.28, 0.135), part(BOX, c.skin, 0, -0.33, 0, 0, 0.11, 0.1, 0.11)];
      if (held === 'clipboard') p.push(part(BOX, [0.5, 0.36, 0.22], 0, -0.36, 0.11, 0, 0.2, 0.26, 0.02), part(BOX, [0.97, 0.97, 0.97], 0, -0.365, 0.125, 0, 0.16, 0.2, 0.01), part(BOX, [0.3, 0.3, 0.32], 0, -0.25, 0.12, 0, 0.06, 0.03, 0.03));
      else if (held === 'radio') p.push(part(BOX, [0.12, 0.12, 0.14], 0, -0.36, 0.08, 0, 0.07, 0.15, 0.05), part(CYL8, [0.1, 0.1, 0.1], 0.02, -0.21, 0.08, 0, 0.012, 0.16, 0.012), part(BOX, [0.9, 0.3, 0.2], 0, -0.31, 0.11, 0, 0.03, 0.02, 0.01));
      return mergeParts(p);
    }
    /** curved patch on the front of the head (±54° wide, ±57° tall) so the portrait wraps instead of floating as a card */
    function playerFaceGeo() {
      var g = new THREE.SphereGeometry(0.5, 12, 10, Math.PI / 2 - 0.95, 1.9, Math.PI / 2 - 1.0, 2.0);
      g.scale(0.353, 0.374, 0.353); g.translate(0, 1.44, 0);
      return g;
    }
    function fallbackFaceURL(skinHex) {
      if (typeof document === 'undefined') return null;
      var cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      var g = cv.getContext('2d'); if (!g) return null;
      g.fillStyle = skinHex; g.beginPath(); g.ellipse(32, 30, 22, 26, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#2a201a'; g.beginPath(); g.arc(23, 27, 3.2, 0, Math.PI * 2); g.arc(41, 27, 3.2, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#3a2a22'; g.lineWidth = 2.2; g.lineCap = 'round'; g.beginPath(); g.arc(32, 36, 8, 0.25, Math.PI - 0.25); g.stroke();
      try { return cv.toDataURL(); } catch (e) { return null; }
    }
    function loadPlayerFace(P, s, skinHex) {
      var gen = ++P.gen, url = null, F = WS.Faces;
      if (F && typeof F.dataURL === 'function') { try { url = F.dataURL(s, 64, { bg: null }); } catch (e) { url = null; } }
      if (!url) url = fallbackFaceURL(skinHex);
      if (!url || typeof Image === 'undefined') return;
      var img = new Image();
      img.onload = function () {
        if (gen !== P.gen || player !== P || !P.faceMat) return;
        var tex = new THREE.Texture(img);
        tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
        if ('encoding' in tex && THREE.sRGBEncoding != null) tex.encoding = THREE.sRGBEncoding;
        tex.repeat.set(FACE_CROP.rx, FACE_CROP.ry); tex.offset.set(FACE_CROP.ox, FACE_CROP.oy);
        tex.needsUpdate = true;
        if (P.faceTex) P.faceTex.dispose();
        P.faceTex = tex; P.faceMat.map = tex; P.faceMat.needsUpdate = true; P.face.visible = true;
      };
      img.src = url;
    }
    function disposePlayerParts(P) {
      var k;
      while (P.obj.children.length) P.obj.remove(P.obj.children[0]);
      for (k = 0; k < P.geoms.length; k++) P.geoms[k].dispose();
      P.geoms.length = 0;
      if (P.faceTex) { P.faceTex.dispose(); P.faceTex = null; }
      if (P.faceMat) { P.faceMat.dispose(); P.faceMat = null; }
      if (P.tag) { if (P.tag.parent) P.tag.parent.remove(P.tag); if (P.tag.material) { if (P.tag.material.map) P.tag.material.map.dispose(); P.tag.material.dispose(); } P.tag = null; }
      P.body = P.legL = P.legR = P.armL = P.armR = P.foreL = P.foreR = P.face = null;
    }
    function buildPlayerParts(P, s, name) {
      var c = playerColours(s), o = P.obj;
      function mesh(g, shadow) { var m = new THREE.Mesh(g, playerMat); m.castShadow = shadow !== false; m.receiveShadow = false; m.frustumCulled = false; m.userData.player = true; P.geoms.push(g); return m; }
      P.body = mesh(playerBodyGeo(s, c)); o.add(P.body);
      var legG = playerLegGeo(c);
      P.legL = new THREE.Mesh(legG, playerMat); P.legR = new THREE.Mesh(legG, playerMat); P.geoms.push(legG);
      P.legL.position.set(0.1, 0.64, 0); P.legR.position.set(-0.1, 0.64, 0);
      P.legL.castShadow = P.legR.castShadow = true; P.legL.frustumCulled = P.legR.frustumCulled = false; o.add(P.legL, P.legR);
      var upG = playerUpperArmGeo(c);
      P.armL = new THREE.Group(); P.armR = new THREE.Group(); P.foreL = new THREE.Group(); P.foreR = new THREE.Group();
      P.armL.position.set(0.29, 1.19, 0); P.armR.position.set(-0.29, 1.19, 0); P.foreL.position.set(0, -0.3, 0); P.foreR.position.set(0, -0.3, 0);
      var uL = new THREE.Mesh(upG, playerMat), uR = new THREE.Mesh(upG, playerMat); P.geoms.push(upG);
      uL.castShadow = uR.castShadow = true; uL.frustumCulled = uR.frustumCulled = false;
      // figure faces +z; its right hand is at -x. Radio in the right hand, clipboard in the left.
      var fL = mesh(playerForearmGeo(c, s.accessory === 'clipboard' ? 'clipboard' : null)), fR = mesh(playerForearmGeo(c, s.accessory === 'radio' ? 'radio' : null));
      P.armL.add(uL, P.foreL); P.foreL.add(fL); P.armR.add(uR, P.foreR); P.foreR.add(fR); o.add(P.armL, P.armR);
      P.faceMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x202020, transparent: true, alphaTest: 0.4 });
      P.face = mesh(playerFaceGeo(), false); P.face.material = P.faceMat; P.face.visible = false; o.add(P.face);
      P.tag = makeTagSprite({ name: name, color: c.outfitHex, avatarEmoji: '★' }, '★ ' + name, false);
      if (P.tag) playerGroup.add(P.tag);
      loadPlayerFace(P, s, c.skinHex);
    }
    function playerOk(sx, sz) {
      if (Math.abs(sx) > N / 2 - 0.6 || Math.abs(sz) > N / 2 - 0.6) return false;
      var l = landOf(cellAtScene(sx, sz));
      return l >= 0 && l !== LAND.RIVER && l !== LAND.RESERVOIR;
    }
    /** A* over the cell grid (8-connected, water blocked, no corner cutting) → smoothed list of scene-space waypoints, or null.
        Runs once per movePlayerTo; typed arrays are reused with a generation stamp so nothing is allocated per call but the path. */
    var ROUTE_MAX_NODES = 24000;
    var routeG = new Float32Array(NN), routeF = new Float32Array(NN), routeFrom = new Int32Array(NN), routeSeen = new Int32Array(NN), routeClosed = new Int32Array(NN), routeGen = 0;
    var routeHeap = new Int32Array(NN + 1), routeHeapN = 0;
    function routeOk(i) { var l = world.land[i]; return l !== LAND.RIVER && l !== LAND.RESERVOIR; }
    function heapPush(i) {
      var k = routeHeapN++; routeHeap[k] = i;
      while (k > 0) { var pa = (k - 1) >> 1; if (routeF[routeHeap[pa]] <= routeF[routeHeap[k]]) break; var t = routeHeap[pa]; routeHeap[pa] = routeHeap[k]; routeHeap[k] = t; k = pa; }
    }
    function heapPop() {
      var top = routeHeap[0], last = routeHeap[--routeHeapN], k = 0; routeHeap[0] = last;
      for (;;) { var l = k * 2 + 1, r = l + 1, m = k; if (l < routeHeapN && routeF[routeHeap[l]] < routeF[routeHeap[m]]) m = l; if (r < routeHeapN && routeF[routeHeap[r]] < routeF[routeHeap[m]]) m = r; if (m === k) break; var t = routeHeap[m]; routeHeap[m] = routeHeap[k]; routeHeap[k] = t; k = m; }
      return top;
    }
    function routeCells(from, to) {
      if (from < 0 || to < 0 || from === to || !routeOk(to) || !routeOk(from)) return null;
      var gen = ++routeGen, tx = to % N, ty = (to / N) | 0, expanded = 0;
      routeHeapN = 0; routeG[from] = 0; routeF[from] = Math.hypot(tx - from % N, ty - ((from / N) | 0)); routeFrom[from] = -1; routeSeen[from] = gen; heapPush(from);
      while (routeHeapN > 0) {
        var cur = heapPop(); if (routeClosed[cur] === gen) continue; routeClosed[cur] = gen;
        if (cur === to) break;
        if (++expanded > ROUTE_MAX_NODES) return null;
        var cx = cur % N, cy = (cur / N) | 0, dx, dy;
        for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          var ni = ny * N + nx; if (routeClosed[ni] === gen || !routeOk(ni)) continue;
          if (dx && dy && (!routeOk(cy * N + nx) || !routeOk(ny * N + cx))) continue;   // no cutting a water corner
          var ng = routeG[cur] + ((dx && dy) ? 1.41421 : 1);
          if (routeSeen[ni] === gen && ng >= routeG[ni]) continue;
          routeSeen[ni] = gen; routeG[ni] = ng; routeF[ni] = ng + Math.hypot(tx - nx, ty - ny); routeFrom[ni] = cur; heapPush(ni);
        }
      }
      if (routeClosed[to] !== gen) return null;
      var cells = []; for (var c = to; c >= 0; c = routeFrom[c]) cells.push(c);
      cells.reverse(); return cells;
    }
    function playerLineClear(x0, z0, x1, z1) {
      var d = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(d / 0.35)), k;
      for (k = 1; k <= n; k++) { var t = k / n; if (!playerOk(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false; }
      return true;
    }
    /** waypoints (scene xz) from the player to (tx,tz): straight when clear, else A* cells string-pulled into straight legs */
    function playerRoute(P, tx, tz) {
      if (playerLineClear(P.x, P.z, tx, tz)) return [{ x: tx, z: tz }];
      var cells = routeCells(cellAtScene(P.x, P.z), cellAtScene(tx, tz));
      if (!cells) return null;
      var pts = [{ x: P.x, z: P.z }], k;
      for (k = 1; k < cells.length - 1; k++) pts.push({ x: sceneX(cells[k] % N), z: sceneZ((cells[k] / N) | 0) });
      pts.push({ x: tx, z: tz });
      var out = [], anchor = pts[0], i = 0;
      while (i < pts.length - 1) {                       // furthest waypoint visible from the anchor
        var j = pts.length - 1;
        while (j > i + 1 && !playerLineClear(anchor.x, anchor.z, pts[j].x, pts[j].z)) j--;
        out.push(pts[j]); anchor = pts[j]; i = j;
      }
      return out;
    }
    function dryNear(cx, cy, r) {
      cx = clamp(Math.round(cx), 0, N - 1); cy = clamp(Math.round(cy), 0, N - 1);
      var best = null, bd = Infinity, dx, dy, x, y, l, d;
      for (dy = -r; dy <= r; dy++) for (dx = -r; dx <= r; dx++) {
        x = cx + dx; y = cy + dy; if (x < 0 || y < 0 || x >= N || y >= N) continue;
        l = world.land[y * N + x]; if (l === LAND.RIVER || l === LAND.RESERVOIR) continue;
        d = dx * dx + dy * dy; if (d < bd) { bd = d; best = { x: x, y: y }; }
      }
      return best;
    }
    function playerArrive(P, ok) {
      var r = P.resolve; P.resolve = null; P.walking = false;
      if (P.faceAt) { P.headTarget = Math.atan2(P.faceAt.sx - P.x, P.faceAt.sz - P.z); P.faceAt = null; }
      if (r) { try { r(ok); } catch (e) { /* ignore */ } }
    }
    function playerCancel(P) { if (P.resolve) { var r = P.resolve; P.resolve = null; P.walking = false; try { r(false); } catch (e) { /* ignore */ } } P.walking = false; }
    function faceOf(opts) { return (opts && opts.face && isFinite(+opts.face.x) && isFinite(+opts.face.y)) ? { sx: sceneX(+opts.face.x), sz: sceneZ(+opts.face.y) } : null; }
    function lerpTo(cur, tgt, k) { return cur + (tgt - cur) * k; }
    function updatePlayer(dt) {
      var P = player; if (!P) return;
      var walking = P.walking, step = 0, dx, dz, d;
      if (walking) {
        var wp = (P.route && P.wp < P.route.length) ? P.route[P.wp] : null, gx = wp ? wp.x : P.tx, gz = wp ? wp.z : P.tz;
        dx = gx - P.x; dz = gz - P.z; d = Math.hypot(dx, dz);
        P.elapsed += dt;
        if (wp && P.wp < P.route.length - 1 && d < 0.2) { P.wp++; wp = P.route[P.wp]; gx = wp.x; gz = wp.z; dx = gx - P.x; dz = gz - P.z; d = Math.hypot(dx, dz); }
        if (d < 0.06 || P.elapsed > P.maxT) { P.x = P.tx; P.z = P.tz; playerArrive(P, true); walking = false; }
        else {
          step = Math.min(d, P.speed * dt);
          var want = Math.atan2(dx, dz), moved = false, k, h, la = Math.min(PLAYER_LOOKAHEAD, d);
          for (k = 0; k < PLAYER_OFFS.length; k++) {
            h = want + PLAYER_OFFS[k] * P.detour;
            var nx = P.x + Math.sin(h) * step, nz = P.z + Math.cos(h) * step;
            if (!playerOk(nx, nz) || !playerOk(P.x + Math.sin(h) * la, P.z + Math.cos(h) * la)) continue;
            P.x = nx; P.z = nz; P.headTarget = h; moved = true;
            if (k > 0 && (k % 2) === 0) P.detour = -P.detour;   // keep skirting the water on the side that worked
            break;
          }
          if (moved) { P.stuck = 0; P.cycle += step * (P.speed > 5 ? 4.2 : 5.4); }
          else { P.stuck += dt; if (P.stuck > PLAYER_STUCK_S) { P.x = P.tx; P.z = P.tz; playerArrive(P, true); walking = false; } }
        }
      }
      var dh = P.headTarget - P.heading; while (dh > Math.PI) dh -= 6.283185; while (dh < -Math.PI) dh += 6.283185;
      P.heading += dh * Math.min(1, dt * PLAYER_TURN);
      // --- pose targets (ux/uz: upper-arm rotation x/z, fx/fz: forearm rotation x/z, lg: leg rotation x)
      var L = P.pose.L, R = P.pose.R, act = walking ? 'walk' : (P.action || 'idle'), t = time, rate = Math.min(1, dt * 10);
      var tL = P.tmpL, tR = P.tmpR, bob = 0, tilt = 0, roll = 0, sy = 1, run = P.speed > 5;
      tL.ux = 0; tL.uz = 0.08; tL.fx = -0.05; tL.fz = 0; tL.lg = 0; tR.ux = 0; tR.uz = -0.08; tR.fx = -0.05; tR.fz = 0; tR.lg = 0;
      switch (act) {
        case 'walk': {
          var sw = Math.sin(P.cycle), amp = run ? 1.0 : 0.7;
          tL.ux = -sw * amp * 0.7; tL.fx = -0.35 - (run ? 0.5 : 0); tL.lg = sw * amp * 0.75;
          tR.ux = sw * amp * 0.7; tR.fx = -0.35 - (run ? 0.5 : 0); tR.lg = -sw * amp * 0.75;
          bob = (run ? 0.05 : 0.035) * Math.abs(sw); tilt = run ? 0.14 : 0.05; roll = 0.03 * sw; rate = Math.min(1, dt * 30);
          break;
        }
        case 'point': tR.ux = -1.35 + 0.05 * Math.sin(t * 3); tR.uz = -0.1; tR.fx = -0.1; break;
        case 'radio': tR.ux = -1.2; tR.uz = -0.35; tR.fx = -2.25; tL.ux = 0.1; break;
        case 'dig': {
          var dg = Math.sin(t * 6);
          tL.ux = tR.ux = -0.85 + 0.45 * dg; tL.fx = tR.fx = -0.7 - 0.2 * dg; tL.uz = 0.05; tR.uz = -0.05;
          tilt = 0.25 + 0.08 * dg; bob = 0.02 * Math.abs(dg); sy = 0.97;
          break;
        }
        case 'wave': tR.ux = -2.9; tR.uz = 0.35; tR.fx = -0.25; tR.fz = 0.45 * Math.sin(t * 9); break;
        default: bob = 0.008 * Math.sin(t * 1.8); sy = 1 + 0.012 * Math.sin(t * 1.8);
      }
      L.ux = lerpTo(L.ux, tL.ux, rate); L.uz = lerpTo(L.uz, tL.uz, rate); L.fx = lerpTo(L.fx, tL.fx, rate); L.fz = lerpTo(L.fz, tL.fz, rate); L.lg = lerpTo(L.lg, tL.lg, rate);
      R.ux = lerpTo(R.ux, tR.ux, rate); R.uz = lerpTo(R.uz, tR.uz, rate); R.fx = lerpTo(R.fx, tR.fx, rate); R.fz = lerpTo(R.fz, tR.fz, rate); R.lg = lerpTo(R.lg, tR.lg, rate);
      if (P.armL) {
        P.armL.rotation.set(L.ux, 0, L.uz); P.foreL.rotation.set(L.fx, 0, L.fz); P.legL.rotation.x = L.lg;
        P.armR.rotation.set(R.ux, 0, R.uz); P.foreR.rotation.set(R.fx, 0, R.fz); P.legR.rotation.x = R.lg;
      }
      var baseY = hAt(P.x, P.z), o = P.obj;
      o.position.set(P.x, baseY + bob, P.z); o.rotation.set(tilt, P.heading, roll); o.scale.set(PLAYER_SCALE, PLAYER_SCALE * sy, PLAYER_SCALE);
      // --- name tag (same sizing rule as the advisors)
      if (P.tag) {
        var dist = _cam.has ? Math.hypot(_cam.x - P.x, _cam.y - baseY, _cam.z - P.z) : 60;
        var h2 = clamp(ADV_TAG_PX * 2 * dist * _cam.tanHalf / _cam.viewH, ADV_TAG_MIN_H, ADV_TAG_MAX_H), show = dist <= ADV_TAG_MAX_DIST;
        P.tag.visible = show;
        if (show) { P.tag.scale.set(h2 * 4, h2, 1); P.tag.position.set(P.x, baseY + 1.85 * PLAYER_SCALE, P.z); }
      }
    }
    function setPlayer(spec, name) {
      var s = normSpec(spec), nm = String(name == null || name === '' ? 'Director' : name);
      if (!player) {
        var hall = bldgsOf('town_hall')[0], spot = hall ? frontOf(hall, 1.8) : null;   // start in front of the town hall, else a street near the civic core
        if (!spot) spot = walkableNear(townC.x, townC.y, 20, [LAND.ROAD]) || walkableNear(townC.x, townC.y, 20, null) || { x: N / 2, y: N / 2 };
        player = { obj: new THREE.Group(), geoms: [], x: sceneX(spot.x), z: sceneZ(spot.y), heading: Math.PI, headTarget: Math.PI, walking: false, tx: 0, tz: 0,
          speed: PLAYER_WALK, resolve: null, action: null, cycle: 0, detour: 1, stuck: 0, elapsed: 0, maxT: 0, faceAt: null, gen: 0, spec: s, name: nm, route: null, wp: 0,
          pose: { L: { ux: 0, uz: 0.08, fx: -0.05, fz: 0, lg: 0 }, R: { ux: 0, uz: -0.08, fx: -0.05, fz: 0, lg: 0 } },
          tmpL: { ux: 0, uz: 0, fx: 0, fz: 0, lg: 0 }, tmpR: { ux: 0, uz: 0, fx: 0, fz: 0, lg: 0 },
          body: null, legL: null, legR: null, armL: null, armR: null, foreL: null, foreR: null, face: null, faceMat: null, faceTex: null, tag: null };
        player.obj.name = 'player'; player.obj.userData.player = true; playerGroup.add(player.obj);
      } else disposePlayerParts(player);
      player.spec = s; player.name = nm;
      buildPlayerParts(player, s, nm);
      updatePlayer(0);
      return player.obj;
    }
    function playerPosition() {
      if (!player) return null;
      var cx = player.x / C.RENDER.CELL + N / 2 - 0.5, cy = player.z / C.RENDER.CELL + N / 2 - 0.5;
      return { x: cx, y: cy, sx: player.x, sz: player.z, i: cellAtScene(player.x, player.z), walking: player.walking, heading: player.heading };
    }

    // ================================================================= STATE
    var season = 0, snowline = fin(world.snowlineElev, 2600) + SNOWLINE_BY_SEASON[0], drought = false, windDir = 0, windMph = 0, time = 0;
    var cellBurning = new Uint8Array(NN), burningInst = new Int32Array(MAX_BURNING_INST), burningN = 0;
    var burningInstA = new Int32Array(MAX_BURNING_INST), burningNA = 0; // aspens
    var cellBurnH = new Uint8Array(NN), burnHouses = new Int32Array(MAX_HOUSES), burnHousesN = 0, fireLevel = 0; // flickering houses
    var FLAME_COL = rgb(0xff7a2a), FLAME_HOT = rgb(0xffc24a);
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
      for (i = 0; i < houses.n; i++) writeHouseColor(i, wa, ra);
      houseWalls.instanceColor.needsUpdate = true; houseRoofs.instanceColor.needsUpdate = true;
    }
    function writeHouseColor(i, wa, ra) {
      var w = (season === 0), elev = world.elev;
      var wc = houses.burned[i] ? CHAR_WALL : WALL_COLS[houses.wc[i]], rc = houses.burned[i] ? CHAR_ROOF : (houses.roof[i] === 1 ? METAL_ROOF : ROOF_COLS[houses.rc[i]]);
      wa[i * 3] = wc[0]; wa[i * 3 + 1] = wc[1]; wa[i * 3 + 2] = wc[2];
      var e = houses.cell[i] >= 0 ? elev[houses.cell[i]] : 0;
      if (!houses.burned[i] && e > snowline) lerp3(ra, i * 3, rc, SNOW, w ? 0.85 : 0.6); else { ra[i * 3] = rc[0]; ra[i * 3 + 1] = rc[1]; ra[i * 3 + 2] = rc[2]; }
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
        var h = computeHidden(conifers, i);
        if (h !== conifers.hidden[i]) { conifers.hidden[i] = h; writeInst(conifers, i); changed = true; }
      }
      if (changed) conifers.mesh.instanceMatrix.needsUpdate = true;
      changed = false;
      for (i = 0; i < aspens.n; i++) {
        var ha = computeHidden(aspens, i);
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

    // ---- build-scene tree drops (tilt + shrink over DROP_DUR, then hidden for good)
    var DROP_DUR = 0.8, MAX_DROPS = 96;
    var drops = { n: 0, set: [], i: new Int32Array(MAX_DROPS), t: new Float32Array(MAX_DROPS), ax: new Float32Array(MAX_DROPS) };
    function writeDropInst(set, i, u, ax) {
      var tilt = u * u * 1.35, shrink = 1 - 0.7 * Math.max(0, (u - 0.6) / 0.4), s = set.s[i] * shrink;
      _o.position.set(set.x[i], set.y[i], set.z[i]);
      _o.rotation.set(tilt * Math.cos(ax), set.rot[i], tilt * Math.sin(ax));
      _o.scale.set(s, set.s[i] * set.sy[i] * shrink * ((set === aspens && season === 0) ? 0.85 : 1), s);
      _o.updateMatrix(); set.mesh.setMatrixAt(i, _o.matrix);
    }
    function updateDrops(dt) {
      if (!drops.n) return;
      var dc = false, da = false, k = 0;
      while (k < drops.n) {
        drops.t[k] += dt;
        var dset = drops.set[k], di = drops.i[k], u = drops.t[k] / DROP_DUR;
        if (dset === conifers) dc = true; else da = true;
        if (u >= 1) {
          dset.hidden[di] = 1; dset.mesh.setMatrixAt(di, _zero);
          var last = drops.n - 1;
          drops.set[k] = drops.set[last]; drops.i[k] = drops.i[last]; drops.t[k] = drops.t[last]; drops.ax[k] = drops.ax[last]; drops.n--;
          continue;
        }
        writeDropInst(dset, di, u, drops.ax[k]);
        k++;
      }
      if (dc) conifers.mesh.instanceMatrix.needsUpdate = true;
      if (da) aspens.mesh.instanceMatrix.needsUpdate = true;
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
        props.stats.instances = conifers.n + aspens.n + snags.count + sage.n + houses.n * 2 + barnCount + crops.n + hayMesh.count + fenceMesh.count + people.n + elk.n + trucks.n + cars.n + birds.n + advisors.length;
        props.stats.drawCalls = meshes.filter(function (m) { return m.count == null || m.count > 0; }).length + (player ? 8 : 0);
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

      /* ---- advisors ---- */
      setCamera: function (cam) { camera = (cam && cam.isCamera) ? cam : null; },
      advisors: advisorList,
      setAdvisorTalking: function (id) { advTalking = (id != null && advById[id]) ? String(id) : null; if (!advTalking) talkRing.visible = talkArrow.visible = false; },
      setAdvisorAlert: function (id, on) { var a = advById[id]; if (a) { a.alertOn = !!on; if (a.alert && !a.alertOn) a.alert.visible = false; } },
      advisorAt: advisorAt,
      advisorHit: advisorHit,

      /* ---- player avatar (SPEC3 §C) ---- */
      setPlayer: setPlayer,
      movePlayerTo: function (x, y, opts) {
        if (!player) return Promise.resolve(false);
        var P = player, gx = clamp(fin(+x, N / 2), 0, N - 1), gy = clamp(fin(+y, N / 2), 0, N - 1);
        var gl = landOf(clamp(Math.round(gy), 0, N - 1) * N + clamp(Math.round(gx), 0, N - 1));
        if (gl === LAND.RIVER || gl === LAND.RESERVOIR) { var dryC = dryNear(gx, gy, 8); if (dryC) { gx = dryC.x; gy = dryC.y; } }   // never aim at water
        var tx = sceneX(gx), tz = sceneZ(gy);
        playerCancel(P);
        P.tx = tx; P.tz = tz; P.speed = (opts && opts.run) ? PLAYER_RUN : PLAYER_WALK; P.elapsed = 0; P.stuck = 0; P.faceAt = faceOf(opts);
        var d0 = Math.hypot(tx - P.x, tz - P.z), route = null, len = d0, k;
        try { route = playerRoute(P, tx, tz); } catch (e) { route = null; }
        if (route) { len = 0; var px = P.x, pz = P.z; for (k = 0; k < route.length; k++) { len += Math.hypot(route[k].x - px, route[k].z - pz); px = route[k].x; pz = route[k].z; } }
        P.route = route; P.wp = 0; P.detour = 1;
        P.maxT = len / P.speed * (route ? 1.6 : 2.5) + 3;   // never walks forever: teleports when badly blocked (no route / stuck)
        if (opts && isFinite(+opts.maxSecs) && +opts.maxSecs > 0) P.maxT = Math.min(P.maxT, +opts.maxSecs);   // caller's cap → teleport on expiry
        P.walking = true;
        return new Promise(function (resolve) { P.resolve = resolve; if (d0 < 0.06) { P.x = tx; P.z = tz; playerArrive(P, true); } });
      },
      teleportPlayer: function (x, y, opts) {
        if (!player) return;
        var P = player; playerCancel(P);
        P.x = sceneX(clamp(fin(+x, N / 2), 0, N - 1)); P.z = sceneZ(clamp(fin(+y, N / 2), 0, N - 1));
        var f = faceOf(opts); if (f) P.heading = P.headTarget = Math.atan2(f.sx - P.x, f.sz - P.z);
        updatePlayer(0);
      },
      playerPosition: playerPosition,
      setPlayerAction: function (kind) { if (player) player.action = (kind === 'point' || kind === 'radio' || kind === 'dig' || kind === 'wave') ? kind : null; },
      playerObject: function () { return player ? player.obj : null; },

      /* houses standing in currently burning cells flicker toward orange (instanceColor only — no geometry work) */
      setBurningCells: function (cells) {
        var k, i, wa = houseWalls.instanceColor.array, ra = houseRoofs.instanceColor.array;
        for (k = 0; k < burnHousesN; k++) writeHouseColor(burnHouses[k], wa, ra); // restore previous set
        if (burnHousesN) { houseWalls.instanceColor.needsUpdate = true; houseRoofs.instanceColor.needsUpdate = true; }
        burnHousesN = 0; cellBurnH.fill(0);
        if (!cells || !cells.length) return;
        for (k = 0; k < cells.length; k++) { i = cells[k] | 0; if (i >= 0 && i < NN) cellBurnH[i] = 1; }
        for (i = 0; i < houses.n && burnHousesN < MAX_HOUSES; i++) if (houses.cell[i] >= 0 && cellBurnH[houses.cell[i]]) burnHouses[burnHousesN++] = i;
      },
      setFireIntensity: function (level) { fireLevel = clamp(fin(level, 0), 0, 1); },

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
        // burning houses flicker toward orange
        if (burnHousesN) {
          var wa = houseWalls.instanceColor.array, ra = houseRoofs.instanceColor.array;
          for (k = 0; k < burnHousesN; k++) {
            var hi = burnHouses[k], ho = hi * 3;
            writeHouseColor(hi, wa, ra);
            var fl = clamp(0.4 + 0.3 * fireLevel + 0.22 * Math.sin(time * 13 + hi * 1.7) * Math.sin(time * 5.1 + hi), 0.15, 0.95);
            var hot = 0.5 + 0.5 * Math.sin(time * 21 + hi);
            var tr = FLAME_COL[0] + (FLAME_HOT[0] - FLAME_COL[0]) * hot, tg = FLAME_COL[1] + (FLAME_HOT[1] - FLAME_COL[1]) * hot, tb = FLAME_COL[2] + (FLAME_HOT[2] - FLAME_COL[2]) * hot;
            wa[ho] += (tr - wa[ho]) * fl; wa[ho + 1] += (tg - wa[ho + 1]) * fl; wa[ho + 2] += (tb - wa[ho + 2]) * fl;
            ra[ho] += (tr - ra[ho]) * fl * 0.8; ra[ho + 1] += (tg - ra[ho + 1]) * fl * 0.8; ra[ho + 2] += (tb - ra[ho + 2]) * fl * 0.8;
          }
          houseWalls.instanceColor.needsUpdate = true; houseRoofs.instanceColor.needsUpdate = true;
        }
        // burning trees flicker / shrink
        if (burningN || burningNA) {
          for (k = 0; k < burningN; k++) { var ii = burningInst[k]; writeInst(conifers, ii, 0.75 + 0.15 * Math.sin(time * 21 + ii), 0.55 + 0.2 * Math.sin(time * 17 + ii * 0.7)); }
          if (burningN) conifers.mesh.instanceMatrix.needsUpdate = true;
          for (k = 0; k < burningNA; k++) { var ia = burningInstA[k]; writeInst(aspens, ia, 0.7 + 0.15 * Math.sin(time * 19 + ia), 0.6 + 0.2 * Math.sin(time * 15 + ia)); }
          if (burningNA) aspens.mesh.instanceMatrix.needsUpdate = true;
        }
        updateDrops(dt);
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
        // advisors (six named figures) + the player figure
        readCam();
        updateAdvisors(dt);
        updatePlayer(dt);
      },

      /* ---- build-scene hooks (WS.Builds) ---- */
      treesInCell: function (ci) {
        ci = ci | 0; if (ci < 0 || ci >= NN) return 0;
        var n = 0, s, k, set;
        for (s = 0; s < 2; s++) {
          set = cellIndex(s ? aspens : conifers);
          for (k = set.cellStart[ci]; k < set.cellStart[ci + 1]; k++) if (!set.hidden[set.cellItems[k]] && !set.dropped[set.cellItems[k]]) n++;
        }
        return n;
      },
      dropTree: function (ci) {
        ci = ci | 0; if (ci < 0 || ci >= NN || drops.n >= MAX_DROPS) return false;
        var s, k, set, best = -1, bestSet = null, pref = false;
        for (s = 0; s < 2 && !pref; s++) {
          set = cellIndex(s ? aspens : conifers);
          for (k = set.cellStart[ci]; k < set.cellStart[ci + 1]; k++) {
            var ii = set.cellItems[k]; if (set.hidden[ii] || set.dropped[ii]) continue;
            var p = hash(ii, 123) < 0.4;                        // prefer trees the thinning pass will hide anyway
            if (best < 0 || p) { best = ii; bestSet = set; pref = p; if (p) break; }
          }
        }
        if (best < 0) return false;
        bestSet.dropped[best] = 1;                              // reserved now; hidden once the fall ends
        var d = drops.n++; drops.set[d] = bestSet; drops.i[d] = best; drops.t[d] = 0; drops.ax[d] = hash(best, 77) * 6.283;
        return true;
      },
      setThinnedZones: function (map) {
        var zid = world.zone; if (!zid) return;
        var s, set, i, z, want, h, changed;
        for (s = 0; s < 2; s++) {
          set = s ? aspens : conifers; changed = false;
          for (i = 0; i < set.n; i++) {
            z = zid[set.cell[i]];
            want = (z >= 0 && map && map[z] > 0 && hash(i, 123) < 0.4) ? 1 : 0;
            if (want !== set.thinned[i]) { set.thinned[i] = want; changed = true; }
            h = computeHidden(set, i);
            if (h !== set.hidden[i]) { set.hidden[i] = h; changed = true; if (!s) writeInst(set, i); }
          }
          if (changed) { if (s) updateAspenMatrices(); else set.mesh.instanceMatrix.needsUpdate = true; }
        }
      },
      clearCells: function (cells, frac) {
        if (!cells || !cells.length) return 0;
        frac = frac == null ? 1 : clamp(fin(frac, 1), 0, 1);
        var s, set, k, c, j, n = 0, changed;
        for (s = 0; s < 2; s++) {
          set = cellIndex(s ? aspens : conifers); changed = false;
          for (k = 0; k < cells.length; k++) {
            c = cells[k] | 0; if (c < 0 || c >= NN) continue;
            for (j = set.cellStart[c]; j < set.cellStart[c + 1]; j++) {
              var ii = set.cellItems[j];
              if (set.dropped[ii] || hash(ii, 321) >= frac) continue;
              set.dropped[ii] = 1; n++;
              if (!set.hidden[ii]) { set.hidden[ii] = 1; if (!s) writeInst(set, ii); changed = true; }
            }
          }
          if (changed) { if (s) updateAspenMatrices(); else set.mesh.instanceMatrix.needsUpdate = true; }
        }
        return n;
      },
      setRoofStyle: function (zoneId, style, frac) {
        var metal = style === 'metal' ? 1 : 0, list = [], i;
        for (i = 0; i < houses.n; i++) if (houses.zone[i] === (zoneId | 0)) list.push(i);
        if (!list.length) return 0;
        var upto = frac == null ? list.length : Math.round(clamp(fin(frac, 1), 0, 1) * list.length);
        var wa = houseWalls.instanceColor.array, ra = houseRoofs.instanceColor.array, changed = 0;
        for (i = 0; i < list.length; i++) {
          var hi = list[i], want = i < upto ? metal : houses.roof[hi];
          if (want !== houses.roof[hi]) { houses.roof[hi] = want; writeHouseColor(hi, wa, ra); changed++; }
        }
        if (changed) { houseWalls.instanceColor.needsUpdate = true; houseRoofs.instanceColor.needsUpdate = true; }
        return upto;
      },
      housesInZone: function (zoneId) {
        var out = [], i;
        for (i = 0; i < houses.n; i++) if (houses.zone[i] === (zoneId | 0)) out.push({ i: i, x: houses.x[i], y: houses.y[i], z: houses.z[i], rot: houses.rot[i], s: houses.s[i], cell: houses.cell[i], burned: !!houses.burned[i] });
        return out;
      },
      setCropsCleared: function (cells) {
        if (!cropMat0) return;
        cropsCleared.fill(0);
        var k, i, a = cropMesh.instanceMatrix.array;
        if (cells) for (k = 0; k < cells.length; k++) { i = cells[k] | 0; if (i >= 0 && i < NN) cropsCleared[i] = 1; }
        for (i = 0; i < crops.n; i++) {
          if (cropsCleared[crops.cell[i]]) cropMesh.setMatrixAt(i, _zero);
          else a.set(cropMat0.subarray(i * 16, i * 16 + 16), i * 16);
        }
        cropMesh.instanceMatrix.needsUpdate = true;
      },

      dispose: function () {
        try { if (group.parent) group.parent.remove(group); } catch (e) { /* ignore */ }
        var k;
        if (player) { playerCancel(player); disposePlayerParts(player); playerGroup.remove(player.obj); player = null; }
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
