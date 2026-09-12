/* Watershed — src/render/renderer.js — export WS.Renderer (facade used by the Game, SPEC §10)
   Composes WS.Scene + WS.TerrainMesh + WS.WaterMesh + WS.Props + WS.Effects through their spec'd APIs.
   Every method is safe before init() and tolerates any sub-module being absent. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var R = WS.Renderer = {};

  var ctx = null, world = null, state = null;
  var terrain = null, water = null, props = null, fx = null, builds = null;
  var heightAt = null, dom = null;
  var clickFns = [], hoverFns = [], paintFns = [], advClickFns = [], advHoverFns = [];
  var advHovered = null, advRay = null, advNdc = null, cursorSet = false;
  var hovered = { x: -1, y: -1, i: -1 }, hoverValid = false, lastHoverT = 0;
  var down = { x: 0, y: 0, t: 0, active: false, button: -1 };
  /* tactical paint stroke: Uint8 stamp per stroke (stroke id, array cleared on wrap), pending cells collected into one
     small array handed to listeners at ≤ 30 Hz. Nothing else is allocated per pointermove. */
  var tactical = false;
  var paint = { active: false, id: 0, stamp: null, pending: [], lastEmit: 0, lastX: -1, lastY: -1, pointerId: -1, pickV: null };
  var pulseSeq = 0, pulseTimer = null, hlOwner = null;
  var placementType = null, overlayMode = 'none', season = 0, seasonClimate = null;
  var lastWind = { dir: 0.8, mph: 8 };
  var broken = { water: false, props: false, fx: false, builds: false };
  var bound = false;

  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function nowMs() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }
  function guard(label, fn) {
    try { return fn(); } catch (err) { console.error('[Renderer] ' + label + ' failed:', err); return undefined; }
  }

  /* fallback height sampler when TerrainMesh is absent: nearest-cell elevation */
  function fallbackHeightAt(w) {
    var C = WS.C;
    if (!w || !w.elev || !C) return function () { return 0; };
    return function (sx, sz) {
      var c = C.sceneToCell(sx, sz), x = clamp(c.x, 0, C.N - 1), y = clamp(c.y, 0, C.N - 1);
      var h = C.elevToScene(w.elev[y * C.N + x]);
      return isFinite(h) ? h : 0;
    };
  }

  function snowlineFor(s, climate) {
    var base = num(world && world.snowlineElev, 2600), sl;
    switch (s) { case 0: sl = base; break; case 1: sl = base + 500; break; case 2: sl = 3600; break; default: sl = 3300; }
    if ((s === 0 || s === 1) && climate && isFinite(+climate.snowpackPct)) {
      sl += clamp((100 - climate.snowpackPct) * 3, -300, 300); // thin snow years: snow line retreats uphill
    }
    return clamp(sl, 1500, 5000);
  }
  function stateSeason() { return (state && isFinite(+state.season)) ? clamp(state.season | 0, 0, 3) : season; }

  /* ---------- advisors ---------- */
  function advisorUnderPointer(clientX, clientY) {
    if (!ctx || !props || typeof props.advisorAt !== 'function') return null;
    var id = null;
    if (typeof props.advisorHit === 'function' && dom && ctx.camera) {           // raycast the figures first (clicking the head/torso)
      if (!advRay) { advRay = new THREE.Raycaster(); advNdc = new THREE.Vector2(); }
      var r = dom.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        advNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
        ctx.camera.updateMatrixWorld();
        advRay.setFromCamera(advNdc, ctx.camera);
        id = guard('props.advisorHit', function () { return props.advisorHit(advRay); }) || null;
      }
    }
    if (!id) {                                                                   // else nearest figure to the picked terrain point
      var p = ctx.pick(clientX, clientY, terrain ? terrain.mesh : null);
      if (p) id = guard('props.advisorAt', function () { return props.advisorAt(p.sx, p.sz, 1.2); }) || null;
    }
    return id;
  }
  function setAdvisorHover(id) {
    if (id === advHovered) return;
    advHovered = id;
    var el = (ctx && ctx.container) ? ctx.container : dom;
    if (el && el.style) {
      if (id) { el.style.cursor = 'pointer'; cursorSet = true; }
      else if (cursorSet) { el.style.cursor = ''; cursorSet = false; }
    }
    for (var i = 0; i < advHoverFns.length; i++) { try { advHoverFns[i](id); } catch (err) { console.error('[Renderer] advisor hover handler failed:', err); } }
  }
  function advisorOf(id) {
    if (!props || typeof props.advisors !== 'function') return null;
    var list = guard('props.advisors', function () { return props.advisors(); }) || [];
    for (var k = 0; k < list.length; k++) if (list[k] && list[k].id === id) return list[k];
    return null;
  }

  /* ---------- pointer → cell events ---------- */
  function emit(fns, cell) {
    for (var i = 0; i < fns.length; i++) { try { fns[i](cell); } catch (err) { console.error('[Renderer] cell handler failed:', err); } }
  }
  function updateHover(clientX, clientY, force) {
    var t = nowMs();
    if (!force && t - lastHoverT < 33) return;
    lastHoverT = t;
    if (!tactical && !paint.active) setAdvisorHover(advisorUnderPointer(clientX, clientY));
    else if (advHovered) setAdvisorHover(null);
    var cell = R.pickCell(clientX, clientY);
    if (cell) {
      if (hoverValid && cell.i === hovered.i) return;
      hovered.x = cell.x; hovered.y = cell.y; hovered.i = cell.i; hoverValid = true;
      if (placementType && fx && fx.setPlacementCursor) guard('setPlacementCursor', function () { fx.setPlacementCursor(placementType, cell.x, cell.y); });
      emit(hoverFns, cell);
    } else if (hoverValid) {
      hoverValid = false; hovered.x = hovered.y = hovered.i = -1;
      if (placementType && fx && fx.setPlacementCursor) guard('setPlacementCursor', function () { fx.setPlacementCursor(null, 0, 0); });
      emit(hoverFns, null);
    }
  }
  /* ---------- tactical paint ---------- */
  function emitPaint(done) {
    if (paint.pending.length === 0 && !done) return;
    var cells = paint.pending; paint.pending = []; paint.lastEmit = nowMs();
    if (cells.length) emit(paintFns, { cells: cells, done: false });
    if (done) emit(paintFns, { cells: [], done: true });
  }
  /* cell index under the pointer without allocating (uses the controls' pickAt with a reusable vector) */
  function pickIdx(clientX, clientY) {
    if (!ctx || !WS.C) return -1;
    var C = WS.C, mesh = terrain ? terrain.mesh : null, sx, sz;
    if (ctx.controls && typeof ctx.controls.pickAt === 'function') {
      if (!paint.pickV) paint.pickV = new THREE.Vector3();
      if (!ctx.controls.pickAt(clientX, clientY, mesh || ctx.controls.pickMesh, paint.pickV)) return -1;
      sx = paint.pickV.x; sz = paint.pickV.z;
    } else { var p = ctx.pick(clientX, clientY, mesh); if (!p) return -1; sx = p.sx; sz = p.sz; }
    var cx = Math.floor(sx / C.RENDER.CELL + C.N / 2), cy = Math.floor(sz / C.RENDER.CELL + C.N / 2);
    if (cx < 0 || cy < 0 || cx >= C.N || cy >= C.N) return -1;
    return cy * C.N + cx;
  }
  function stampCell(i) {
    if (paint.stamp[i] === paint.id) return;
    paint.stamp[i] = paint.id; paint.pending.push(i);
  }
  /* walk the grid line from the last painted cell to (x,y) so fast strokes still make continuous lines */
  function paintTo(x, y) {
    var N = WS.C.N;
    if (paint.lastX < 0) { stampCell(y * N + x); paint.lastX = x; paint.lastY = y; return; }
    var x0 = paint.lastX, y0 = paint.lastY, dx = Math.abs(x - x0), dy = Math.abs(y - y0), sx = x0 < x ? 1 : -1, sy = y0 < y ? 1 : -1, err = dx - dy, guard = 0;
    while (guard++ < 512) {
      stampCell(y0 * N + x0);
      if (x0 === x && y0 === y) break;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    paint.lastX = x; paint.lastY = y;
  }
  function beginPaint(e) {
    if (!paint.stamp) paint.stamp = new Uint8Array(WS.C.N * WS.C.N);
    paint.id++; if (paint.id > 255) { paint.stamp.fill(0); paint.id = 1; }
    paint.active = true; paint.pending = []; paint.lastX = paint.lastY = -1; paint.lastEmit = 0; paint.pointerId = e.pointerId;
    try { dom.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    var i = pickIdx(e.clientX, e.clientY);
    if (i >= 0) paintTo(i % WS.C.N, (i / WS.C.N) | 0);
  }
  function endPaint() {
    if (!paint.active) return;
    paint.active = false;
    if (dom && paint.pointerId >= 0) { try { dom.releasePointerCapture(paint.pointerId); } catch (err) { /* ignore */ } }
    paint.pointerId = -1;
    emitPaint(true);
  }

  function onPointerDown(e) {
    if (e.pointerType !== 'touch' && e.button !== 0) { down.active = false; return; }
    if (e.ctrlKey || e.shiftKey || e.metaKey) { down.active = false; return; }
    down.x = e.clientX; down.y = e.clientY; down.t = nowMs(); down.active = true; down.button = e.button;
    if (tactical && (e.pointerType !== 'touch' || e.isPrimary !== false)) beginPaint(e);
  }
  function onPointerUp(e) {
    if (paint.active && (e.pointerId === paint.pointerId || e.pointerType !== 'touch')) endPaint();
    if (!down.active) return;
    down.active = false;
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    var dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (dx * dx + dy * dy > 25 || nowMs() - down.t > 300) return;
    if (!tactical && advClickFns.length) {
      var aid = advisorUnderPointer(e.clientX, e.clientY);
      if (aid) { emit(advClickFns, aid); return; }                                 // advisor click swallows the cell click
    }
    var cell = R.pickCell(e.clientX, e.clientY);
    if (cell) {
      hovered.x = cell.x; hovered.y = cell.y; hovered.i = cell.i; hoverValid = true;
      emit(clickFns, cell);
    }
  }
  function onPointerMove(e) {
    if (e.pointerType === 'touch' && e.buttons === 0) return;
    if (paint.active) {
      if (e.buttons === 0 && e.pointerType !== 'touch') { endPaint(); }
      else if (e.pointerType !== 'touch' || e.pointerId === paint.pointerId) {
        var i = pickIdx(e.clientX, e.clientY);
        if (i >= 0) paintTo(i % WS.C.N, (i / WS.C.N) | 0);
        if (paint.pending.length && nowMs() - paint.lastEmit >= 33) emitPaint(false);
      }
    }
    updateHover(e.clientX, e.clientY, false);
  }
  function onPointerCancel() { endPaint(); down.active = false; }
  function onPointerLeave() {
    down.active = false;
    if (advHovered) setAdvisorHover(null);
    if (paint.active && !(dom && dom.hasPointerCapture && paint.pointerId >= 0 && dom.hasPointerCapture(paint.pointerId))) endPaint();
    if (hoverValid) {
      hoverValid = false; hovered.x = hovered.y = hovered.i = -1;
      if (placementType && fx && fx.setPlacementCursor) guard('setPlacementCursor', function () { fx.setPlacementCursor(null, 0, 0); });
      emit(hoverFns, null);
    }
  }
  function bind() {
    if (bound || !dom) return; bound = true;
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerleave', onPointerLeave);
    dom.addEventListener('pointercancel', onPointerCancel);
  }
  function unbind() {
    if (!bound || !dom) return; bound = false;
    dom.removeEventListener('pointerdown', onPointerDown);
    dom.removeEventListener('pointerup', onPointerUp);
    dom.removeEventListener('pointermove', onPointerMove);
    dom.removeEventListener('pointerleave', onPointerLeave);
    dom.removeEventListener('pointercancel', onPointerCancel);
  }

  /* ---------- Effects fog bridge ----------
     Effects reports absolute fog {color, density, skyTint} relative to its own clear baseline (palette fog/sky,
     lowest density seen). We turn that into a modulation over the season lighting so weather and season compose. */
  var fogBaseD = Infinity, fogMul = null, skyMul = null, baseCol = null;
  function onFxFog(a, b) {
    if (!ctx) return;
    var isPayload = a && typeof a === 'object' && !a.isColor && (a.color != null || a.density != null);
    if (!isPayload) { ctx.setFog(a, b); return; }
    var d = num(a.density, 0); if (d < fogBaseD) fogBaseD = d;
    if (!(a.color && a.color.isColor && ctx.setFogModulation && WS.C)) { ctx.setFog(a.color, a.density); return; }
    if (!fogMul) { fogMul = new THREE.Color(); skyMul = new THREE.Color(); baseCol = new THREE.Color(); }
    baseCol.setHex(WS.C.PALETTE.fog);
    fogMul.setRGB(clamp(a.color.r / Math.max(baseCol.r, 1e-3), 0, 2.5), clamp(a.color.g / Math.max(baseCol.g, 1e-3), 0, 2.5), clamp(a.color.b / Math.max(baseCol.b, 1e-3), 0, 2.5));
    if (a.skyTint && a.skyTint.isColor) {
      baseCol.setHex(WS.C.PALETTE.sky);
      skyMul.setRGB(clamp(a.skyTint.r / Math.max(baseCol.r, 1e-3), 0, 2.5), clamp(a.skyTint.g / Math.max(baseCol.g, 1e-3), 0, 2.5), clamp(a.skyTint.b / Math.max(baseCol.b, 1e-3), 0, 2.5));
    } else skyMul.setRGB(1, 1, 1);
    ctx.setFogModulation(fogMul, d - fogBaseD, skyMul);
  }

  /* ---------- per-frame ---------- */
  function tick(dt) {
    if (water && water.update && !broken.water) {
      try { water.update(dt); } catch (err) { broken.water = true; console.error('[Renderer] water.update failed; disabled:', err); }
    }
    if (props && props.update && !broken.props) {
      try { props.update(dt, state); } catch (err) { broken.props = true; console.error('[Renderer] props.update failed; disabled:', err); }
    }
    if (fx && fx.update && !broken.fx) {
      try { fx.update(dt, ctx.camera); } catch (err) { broken.fx = true; console.error('[Renderer] fx.update failed; disabled:', err); }
    }
    if (builds && builds.update && !broken.builds) {
      try { builds.update(dt); } catch (err) { broken.builds = true; console.error('[Renderer] builds.update failed; disabled:', err); }
    }
  }

  /* ---------- API ---------- */
  R.init = function (containerEl, w, s) {
    if (ctx) R.dispose();
    world = w || null; state = s || null;
    if (!containerEl || !WS.Scene || typeof THREE === 'undefined') return null;
    ctx = WS.Scene.init(containerEl, world);
    if (!ctx) return null;
    R._ctx = ctx; dom = ctx.renderer.domElement;
    broken.water = broken.props = broken.fx = false; fogBaseD = Infinity;
    season = stateSeason(); seasonClimate = state ? state.climate : null;

    if (WS.TerrainMesh && WS.TerrainMesh.build && world) {
      terrain = guard('TerrainMesh.build', function () { return WS.TerrainMesh.build(world); }) || null;
      if (terrain && terrain.mesh) ctx.scene.add(terrain.mesh);
      if (terrain && typeof terrain.heightAt === 'function') heightAt = terrain.heightAt;
    }
    if (!heightAt) heightAt = fallbackHeightAt(world);
    ctx.setTerrain(terrain ? terrain.mesh : null, heightAt);

    if (WS.WaterMesh && WS.WaterMesh.build && world) {
      water = guard('WaterMesh.build', function () { return WS.WaterMesh.build(world, { heightAt: heightAt }); }) || null;
      if (water && water.group && !water.group.parent) ctx.scene.add(water.group);
    }
    if (WS.Props && WS.Props.build && world) {
      props = guard('Props.build', function () { return WS.Props.build(world, ctx.scene, { heightAt: heightAt, camera: ctx.camera, viewHeight: function () { return ctx._h; } }); }) || null;
      if (props && props.group && props.group.isObject3D && !props.group.parent) ctx.scene.add(props.group);
    }
    if (WS.Effects && WS.Effects.init && world) {
      fx = guard('Effects.init', function () { return WS.Effects.init(ctx.scene, world, { heightAt: heightAt, camera: ctx.camera, renderer: ctx.renderer }); }) || null;
      if (fx && typeof fx.onFogChange === 'function') {
        guard('onFogChange', function () { fx.onFogChange(onFxFog); });
      }
    }
    if (WS.Builds && WS.Builds.init && world) {
      builds = guard('Builds.init', function () { return WS.Builds.init(ctx.scene, world, { props: props, fx: fx, heightAt: heightAt, camera: ctx.camera }); }) || null;
      if (builds && builds.installed) guard('builds.installed', function () { builds.installed(state, world); });
    }

    // initial state
    R.setSeason(season, seasonClimate);
    if (state && state.reservoir) {
      var cap = num(state.reservoir.capacityAF, WS.C ? WS.C.HYDRO.RESERVOIR_CAPACITY_AF : 42000) || 1;
      R.setReservoir(num(state.reservoir.storageAF, 0) / cap, num(state.reservoir.turbidity, 0), num(state.reservoir.ashContam, 0));
    }
    if (state && state.climate) {
      R.setRiverFlow(num(state.climate.streamflowCfs, 60), state.reservoir ? num(state.reservoir.turbidity, 0) : 0);
      R.setWind(num(state.climate.windDirRad, 0.8), num(state.climate.windMph, 8));
    }
    bind();
    ctx.startLoop(tick);
    return R;
  };

  R.setState = function (s) { state = s || null; if (builds && builds.installed) guard('builds.installed', function () { builds.installed(state, world); }); };

  R.pickCell = function (clientX, clientY) {
    if (!ctx || !WS.C) return null;
    var p = ctx.pick(clientX, clientY, terrain ? terrain.mesh : null);
    if (!p) return null;
    var c = WS.C.sceneToCell(p.sx, p.sz);
    if (!WS.C.inBounds(c.x, c.y)) return null;
    return { x: c.x, y: c.y, i: WS.C.idx(c.x, c.y) };
  };
  R.onCellClick = function (fn) {
    if (typeof fn !== 'function') return function () {};
    clickFns.push(fn);
    return function () { var k = clickFns.indexOf(fn); if (k >= 0) clickFns.splice(k, 1); };
  };
  R.onCellHover = function (fn) {
    if (typeof fn !== 'function') return function () {};
    hoverFns.push(fn);
    return function () { var k = hoverFns.indexOf(fn); if (k >= 0) hoverFns.splice(k, 1); };
  };
  R.getHoveredCell = function () { return hoverValid ? { x: hovered.x, y: hovered.y, i: hovered.i } : null; };

  /* ---------- advisors (people avatars in the scene) ---------- */
  R.onAdvisorClick = function (fn) {        // fn(id) — a plain click on an advisor figure (not in tactical mode); the cell click is not emitted
    if (typeof fn !== 'function') return function () {};
    advClickFns.push(fn);
    return function () { var k = advClickFns.indexOf(fn); if (k >= 0) advClickFns.splice(k, 1); };
  };
  R.onAdvisorHover = function (fn) {        // fn(id|null) — pointer enters/leaves an advisor; cursor becomes a pointer meanwhile
    if (typeof fn !== 'function') return function () {};
    advHoverFns.push(fn);
    return function () { var k = advHoverFns.indexOf(fn); if (k >= 0) advHoverFns.splice(k, 1); };
  };
  R.getAdvisors = function () { return (props && typeof props.advisors === 'function') ? (guard('props.advisors', function () { return props.advisors(); }) || []) : []; };
  R.getHoveredAdvisor = function () { return advHovered; };
  /* screen position of the advisor's head (+1.9 units): { sx, sy, x, y, visible, dist } (x/y alias sx/sy) or null when unknown */
  R.advisorScreenPos = function (id) {
    if (!ctx) return null;
    var a = advisorOf(id); if (!a || !a.position) return null;
    var p = ctx.project(a.position.x, a.position.y + 1.9, a.position.z);
    var dist = ctx.camera ? ctx.camera.position.distanceTo(a.position) : 0;
    var vis = !!p.visible && p.sx >= 0 && p.sy >= 0 && p.sx <= ctx._w && p.sy <= ctx._h;
    return { sx: p.sx, sy: p.sy, x: p.sx, y: p.sy, visible: vis, dist: dist };
  };
  R.setAdvisorTalking = function (id) { if (props && props.setAdvisorTalking) guard('props.setAdvisorTalking', function () { props.setAdvisorTalking(id == null ? null : String(id)); }); };
  R.setAdvisorAlert = function (id, on) { if (props && props.setAdvisorAlert) guard('props.setAdvisorAlert', function () { props.setAdvisorAlert(String(id), !!on); }); };
  R.flyToAdvisor = function (id, dist) {
    if (!ctx) return;
    var a = advisorOf(id); if (!a || !a.position) return;
    ctx.focus(a.position.x, a.position.z, dist == null ? 22 : num(dist, 22), { smooth: true });
  };

  /* ---------- tactical mode (SPEC2 §C) ---------- */
  R.setTacticalMode = function (on) {
    var v = !!on;
    if (v === tactical) return;
    tactical = v;
    if (!tactical) endPaint();
    if (ctx && ctx.setPanEnabled) ctx.setPanEnabled(!tactical);
  };
  R.isTacticalMode = function () { return tactical; };
  R.onCellPaint = function (fn) {
    if (typeof fn !== 'function') return function () {};
    paintFns.push(fn);
    return function () { var k = paintFns.indexOf(fn); if (k >= 0) paintFns.splice(k, 1); };
  };
  R.setFlooded = function (cells) {
    if (!fx || !fx.setFlooded) return;
    guard('fx.setFlooded', function () { fx.setFlooded(cells || []); });
  };
  R.playRetardantDrop = function (x, y, radius) {
    if (!fx || !fx.playRetardantDrop) return;
    guard('fx.playRetardantDrop', function () { fx.playRetardantDrop(num(x, 0) | 0, num(y, 0) | 0, radius == null ? 2 : num(radius, 2)); });
  };
  R.setFireIntensity = function (level) {
    var l = clamp(num(level, 0), 0, 1);
    if (fx && fx.setFireIntensity) guard('fx.setFireIntensity', function () { fx.setFireIntensity(l); });
    if (props && props.setFireIntensity) guard('props.setFireIntensity', function () { props.setFireIntensity(l); });
  };
  function zoneOf(zoneId) {
    if (!world) return null;
    var z = null;
    if (typeof world.zoneById === 'function') z = guard('zoneById', function () { return world.zoneById(zoneId); }) || null;
    if (!z && world.zones) { for (var k = 0; k < world.zones.length; k++) if (world.zones[k] && world.zones[k].id === zoneId) { z = world.zones[k]; break; } }
    return z;
  }
  /* 1.2 s highlight pulse on a zone; a later external setHighlight() takes precedence and is not cleared by the pulse */
  R.pulseZone = function (zoneId, colorHex) {
    var z = zoneOf(zoneId);
    if (!z || !z.cells || !fx || !fx.setHighlight) return;
    var mine = ++pulseSeq;
    hlOwner = 'pulse';
    guard('fx.setHighlight', function () { fx.setHighlight(z.cells, colorHex == null ? 0xffd24a : colorHex); });
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(function () {
      pulseTimer = null;
      if (mine !== pulseSeq || hlOwner !== 'pulse' || !fx || !fx.setHighlight) return;
      hlOwner = null;
      guard('fx.setHighlight', function () { fx.setHighlight(null, null); });
    }, 1200);
  };

  R.setSeason = function (seasonIdx, climate) {
    season = clamp(num(seasonIdx, season) | 0, 0, 3);
    seasonClimate = climate || (state && state.climate) || null;
    if (!ctx) return;
    guard('setSeasonLighting', function () { ctx.setSeasonLighting(season, seasonClimate); });
    var sl = snowlineFor(season, seasonClimate);
    if (terrain && terrain.recolor) guard('terrain.recolor', function () { terrain.recolor(world, state, season, { snowlineElev: sl }); });
    if (props && props.setSeason) guard('props.setSeason', function () { props.setSeason(season, { snowlineElev: sl }); });
    if (water && water.setSeason) guard('water.setSeason', function () { water.setSeason(season); });
  };

  R.refreshWorld = function () {
    if (!ctx) return;
    var sl = snowlineFor(season, seasonClimate);
    if (terrain && terrain.recolor) guard('terrain.recolor', function () { terrain.recolor(world, state, season, { snowlineElev: sl }); });
    if (props && props.refresh) guard('props.refresh', function () { props.refresh(world, state); });
    if (builds && builds.installed) guard('builds.installed', function () { builds.installed(state, world); });
    if (overlayMode !== 'none' && fx && fx.setOverlay) guard('fx.setOverlay', function () { fx.setOverlay(overlayMode, world, state); });
  };

  /* Funded-project build scene (WS.Builds): fly the camera to the site (~0.6 s), play the 3–5 s in-world construction,
     then refresh persistent installations. Always resolves; resolves immediately when Builds is absent or the id is unknown. */
  R.playBuild = function (projectId, targetZoneId, s) {
    if (s) state = s;
    if (!ctx || !builds || !builds.play) return Promise.resolve();
    var site = guard('builds.siteFor', function () { return builds.siteFor(projectId, targetZoneId); }) || null;
    var wait = 0;
    if (site) { R.flyTo(site.x, site.y, site.dist == null ? 30 : site.dist); wait = 650; }
    return new Promise(function (resolve) { setTimeout(resolve, wait); })
      .then(function () { return builds.play(projectId, targetZoneId, state); })
      .catch(function (err) { console.error('[Renderer] playBuild failed:', err); })
      .then(function () { R.refreshWorld(); });
  };

  R.setReservoir = function (fracFull, turbidity, ash) {
    if (!water || !water.setReservoir) return;
    var f = clamp(num(fracFull, 0.75), 0, 1.2), t = clamp(num(turbidity, 0), 0, 1), a = clamp(num(ash, 0), 0, 1);
    guard('water.setReservoir', function () { water.setReservoir(f, t, a); });
  };
  R.setRiverFlow = function (cfs, turbidity) {
    if (!water || !water.setRiver) return;
    var c = clamp(num(cfs, 60), 0, 20000), t = clamp(num(turbidity, 0), 0, 1);
    guard('water.setRiver', function () { water.setRiver(c, t); });
  };
  R.setFire = function (burningIdx, burnedIdx) {
    var b = burningIdx || [], d = burnedIdx || [];
    if (fx && fx.setFire) guard('fx.setFire', function () { fx.setFire(b, d); });
    if (props && props.setFire) guard('props.setFire', function () { props.setFire(b); });
    if (props && props.setBurningCells) guard('props.setBurningCells', function () { props.setBurningCells(b); });
  };
  R.setWeather = function (kind, intensity) {
    if (!fx || !fx.setWeather) return;
    var k = (typeof kind === 'string' && kind) ? kind : 'clear', i = clamp(num(intensity, 0.5), 0, 1);
    guard('fx.setWeather', function () { fx.setWeather(k, i); });
  };
  R.setWind = function (dirRad, mph) {
    lastWind.dir = num(dirRad, lastWind.dir); lastWind.mph = clamp(num(mph, lastWind.mph), 0, 120);
    if (fx && fx.setWind) guard('fx.setWind', function () { fx.setWind(lastWind.dir, lastWind.mph); });
    if (props && props.setWind) guard('props.setWind', function () { props.setWind(lastWind.dir, lastWind.mph); });
    if (ctx && ctx.setWind) ctx.setWind(lastWind.dir, lastWind.mph);
  };
  R.showDebris = function (frame) {
    if (!fx || !fx.showDebris || !frame) return;
    guard('fx.showDebris', function () { fx.showDebris(frame); });
  };
  R.clearDebris = function () {
    if (!fx || !fx.clearDebris) return;
    guard('fx.clearDebris', function () { fx.clearDebris(); });
  };
  R.setOverlay = function (mode) {
    overlayMode = (typeof mode === 'string' && mode) ? mode : 'none';
    if (!fx || !fx.setOverlay) return;
    guard('fx.setOverlay', function () { fx.setOverlay(overlayMode, world, state); });
  };
  R.getOverlay = function () { return overlayMode; };
  R.setHighlight = function (indices, colorHex) {
    hlOwner = (indices && indices.length) ? 'ext' : null;
    if (!fx || !fx.setHighlight) return;
    guard('fx.setHighlight', function () { fx.setHighlight(indices || null, colorHex == null ? null : colorHex); });
  };
  R.addMarker = function (id, type, x, y) {
    if (!fx || !fx.addMarker) return;
    guard('fx.addMarker', function () { fx.addMarker(id, type, num(x, 0) | 0, num(y, 0) | 0); });
  };
  R.removeMarker = function (id) {
    if (!fx || !fx.removeMarker) return;
    guard('fx.removeMarker', function () { fx.removeMarker(id); });
  };
  R.clearMarkers = function () {
    if (!fx || !fx.clearMarkers) return;
    guard('fx.clearMarkers', function () { fx.clearMarkers(); });
  };
  R.setPlacementCursor = function (type) {
    placementType = (typeof type === 'string' && type) ? type : null;
    if (!fx || !fx.setPlacementCursor) return;
    guard('fx.setPlacementCursor', function () {
      if (placementType && hoverValid) fx.setPlacementCursor(placementType, hovered.x, hovered.y);
      else fx.setPlacementCursor(null, 0, 0);
    });
  };
  R.flyTo = function (x, y, dist) {
    if (!ctx || !WS.C) return;
    var C = WS.C, cx = clamp(num(x, C.N / 2) | 0, 0, C.N - 1), cy = clamp(num(y, C.N / 2) | 0, 0, C.N - 1);
    var elev = (world && world.elev) ? world.elev[C.idx(cx, cy)] : C.RENDER.ELEV_BASE;
    var p = C.toScene(cx, cy, isFinite(elev) ? elev : C.RENDER.ELEV_BASE);
    ctx.focus(p.x, p.z, dist == null ? null : num(dist, 60), { smooth: true });
  };
  R.flyToZone = function (zoneId) {
    if (!ctx || !world) return;
    var z = null;
    if (typeof world.zoneById === 'function') z = guard('zoneById', function () { return world.zoneById(zoneId); }) || null;
    if (!z && world.zones) { for (var k = 0; k < world.zones.length; k++) if (world.zones[k] && world.zones[k].id === zoneId) { z = world.zones[k]; break; } }
    if (!z || !z.center) return;
    var dist = 60;
    if (z.bbox) { var dx = num(z.bbox.x1, 0) - num(z.bbox.x0, 0), dy = num(z.bbox.y1, 0) - num(z.bbox.y0, 0); dist = clamp(Math.sqrt(dx * dx + dy * dy) * 1.7 + 12, 30, 130); }
    R.flyTo(z.center.x, z.center.y, dist);
  };
  R.setTimeOfDay = function (t) { if (ctx) ctx.setTimeOfDay(t); };
  R.setControlsEnabled = function (b) { if (ctx) ctx.setControlsEnabled(b); };
  R.getStats = function () {
    if (!ctx) return { fps: 0, drawCalls: 0, triangles: 0 };
    var info = ctx.renderer.info.render;
    return { fps: Math.round(ctx.getFps()), drawCalls: info.calls, triangles: info.triangles };
  };
  R.dispose = function () {
    unbind();
    if (ctx) ctx.stopLoop();
    if (props && props.dispose) guard('props.dispose', function () { props.dispose(); });
    if (builds && builds.dispose) guard('builds.dispose', function () { builds.dispose(); });
    if (fx && fx.dispose) guard('fx.dispose', function () { fx.dispose(); });
    if (water && water.dispose) guard('water.dispose', function () { water.dispose(); });
    if (terrain) {
      if (terrain.dispose) guard('terrain.dispose', function () { terrain.dispose(); });
      else if (terrain.mesh) {
        if (terrain.mesh.geometry) terrain.mesh.geometry.dispose();
        if (terrain.mesh.material && terrain.mesh.material.dispose) terrain.mesh.material.dispose();
      }
    }
    if (ctx) guard('ctx.dispose', function () { ctx.dispose(); });
    ctx = null; R._ctx = null; dom = null; terrain = water = props = fx = builds = null; heightAt = null;
    hoverValid = false; hovered.x = hovered.y = hovered.i = -1; down.active = false;
    placementType = null; overlayMode = 'none'; tactical = false; paint.active = false; paint.pending = []; paint.pointerId = -1;
    if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null; } hlOwner = null;
    clickFns.length = 0; hoverFns.length = 0; paintFns.length = 0; advClickFns.length = 0; advHoverFns.length = 0;
    advHovered = null; cursorSet = false;
  };

  R._ctx = null;
  R._modules = function () { return { ctx: ctx, terrain: terrain, water: water, props: props, fx: fx, builds: builds, world: world, state: state }; };
})();
