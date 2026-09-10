/* Watershed — src/render/renderer.js — export WS.Renderer (facade used by the Game, SPEC §10)
   Composes WS.Scene + WS.TerrainMesh + WS.WaterMesh + WS.Props + WS.Effects through their spec'd APIs.
   Every method is safe before init() and tolerates any sub-module being absent. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var R = WS.Renderer = {};

  var ctx = null, world = null, state = null;
  var terrain = null, water = null, props = null, fx = null;
  var heightAt = null, dom = null;
  var clickFns = [], hoverFns = [];
  var hovered = { x: -1, y: -1, i: -1 }, hoverValid = false, lastHoverT = 0;
  var down = { x: 0, y: 0, t: 0, active: false, button: -1 };
  var placementType = null, overlayMode = 'none', season = 0, seasonClimate = null;
  var lastWind = { dir: 0.8, mph: 8 };
  var broken = { water: false, props: false, fx: false };
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

  /* ---------- pointer → cell events ---------- */
  function emit(fns, cell) {
    for (var i = 0; i < fns.length; i++) { try { fns[i](cell); } catch (err) { console.error('[Renderer] cell handler failed:', err); } }
  }
  function updateHover(clientX, clientY, force) {
    var t = nowMs();
    if (!force && t - lastHoverT < 33) return;
    lastHoverT = t;
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
  function onPointerDown(e) {
    if (e.pointerType !== 'touch' && e.button !== 0) { down.active = false; return; }
    if (e.ctrlKey || e.shiftKey || e.metaKey) { down.active = false; return; }
    down.x = e.clientX; down.y = e.clientY; down.t = nowMs(); down.active = true; down.button = e.button;
  }
  function onPointerUp(e) {
    if (!down.active) return;
    down.active = false;
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    var dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (dx * dx + dy * dy > 25 || nowMs() - down.t > 300) return;
    var cell = R.pickCell(e.clientX, e.clientY);
    if (cell) {
      hovered.x = cell.x; hovered.y = cell.y; hovered.i = cell.i; hoverValid = true;
      emit(clickFns, cell);
    }
  }
  function onPointerMove(e) { if (e.pointerType === 'touch' && e.buttons === 0) return; updateHover(e.clientX, e.clientY, false); }
  function onPointerLeave() {
    down.active = false;
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
  }
  function unbind() {
    if (!bound || !dom) return; bound = false;
    dom.removeEventListener('pointerdown', onPointerDown);
    dom.removeEventListener('pointerup', onPointerUp);
    dom.removeEventListener('pointermove', onPointerMove);
    dom.removeEventListener('pointerleave', onPointerLeave);
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
      props = guard('Props.build', function () { return WS.Props.build(world, ctx.scene, { heightAt: heightAt }); }) || null;
      if (props && props.group && props.group.isObject3D && !props.group.parent) ctx.scene.add(props.group);
    }
    if (WS.Effects && WS.Effects.init && world) {
      fx = guard('Effects.init', function () { return WS.Effects.init(ctx.scene, world, { heightAt: heightAt, camera: ctx.camera, renderer: ctx.renderer }); }) || null;
      if (fx && typeof fx.onFogChange === 'function') {
        guard('onFogChange', function () { fx.onFogChange(onFxFog); });
      }
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

  R.setState = function (s) { state = s || null; };

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
    if (overlayMode !== 'none' && fx && fx.setOverlay) guard('fx.setOverlay', function () { fx.setOverlay(overlayMode, world, state); });
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
    ctx = null; R._ctx = null; dom = null; terrain = water = props = fx = null; heightAt = null;
    hoverValid = false; hovered.x = hovered.y = hovered.i = -1; down.active = false;
    placementType = null; overlayMode = 'none';
    clickFns.length = 0; hoverFns.length = 0;
  };

  R._ctx = null;
  R._modules = function () { return { ctx: ctx, terrain: terrain, water: water, props: props, fx: fx, world: world, state: state }; };
})();
