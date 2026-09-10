/* Watershed — DEV ONLY fallback world for render checks. Exports WS.StubWorld.generate(seed).
   Builds a plausible 128x128 world with the SPEC §2 fields (valley, basin, river path, reservoir stage-storage,
   zones, buildings, roads). Not loaded by the game; used by dev/water_terrain_check.html when src/world/terrain.js is absent. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C, L = C.LAND;

  function generate(seed) {
    seed = seed == null ? 7 : seed;
    var N = C.N, NN = N * N;
    var rng = WS.RNG.create(seed), noise = WS.Noise.create(String(seed) + ':stub');
    var elev = new Float32Array(NN), land = new Uint8Array(NN).fill(L.SHRUB);
    var i, x, y;

    /* base relief: mountains NW -> valley SE */
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      var u = x / N, v = y / N;
      var g = C.smoothstep(0.1, 0.95, u * 0.62 + v * 0.62 + 0.12 * noise.fbm(u * 3 + 5, v * 3 + 2, 3));
      var mtn = 1 - g;
      elev[y * N + x] = 1990 + 1480 * mtn + noise.ridged(u * 4.5 + 7, v * 4.5 + 3, 4) * (80 + 330 * mtn) + noise.fbm(u * 7, v * 7, 4) * (20 + 90 * mtn);
    }

    /* river path through waypoints (~1 cell spacing) */
    var wps = [[12, 10], [18, 20], [26, 30], [34, 40], [42, 50], [49, 57], [55, 63], [60, 68], [65, 76], [72, 86], [82, 96], [94, 106], [106, 116], [118, 124]];
    var path = [];
    for (i = 0; i < wps.length - 1; i++) {
      var ax = wps[i][0], ay = wps[i][1], bx = wps[i + 1][0], by = wps[i + 1][1];
      var steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (var s = 0; s < steps; s++) {
        var t = s / steps, wig = Math.sin(path.length * 0.35) * 1.2;
        var px = Math.round(ax + (bx - ax) * t + wig * (by - ay) / steps * 0.5), py = Math.round(ay + (by - ay) * t - wig * (bx - ax) / steps * 0.5);
        px = C.clamp(px, 0, N - 1); py = C.clamp(py, 0, N - 1);
        if (!path.length || path[path.length - 1].x !== px || path[path.length - 1].y !== py) path.push({ x: px, y: py });
      }
    }
    path.push({ x: wps[wps.length - 1][0], y: wps[wps.length - 1][1] });
    var PL = path.length;

    /* basin + dam */
    var center = { x: 53, y: 61 }, RAD = 8.5;
    var damIndex = 0;
    for (i = 0; i < PL; i++) if (Math.hypot(path[i].x - center.x, path[i].y - center.y) <= RAD) damIndex = i;
    var entryIdx = PL;
    for (i = 0; i < PL; i++) if (Math.hypot(path[i].x - center.x, path[i].y - center.y) <= RAD) { entryIdx = i; break; }
    var spillElev = 2135, bedBase = 2090;
    /* bed profile: strictly decreasing along the path */
    var bed = new Float32Array(PL);
    for (i = 0; i < PL; i++) {
      var f;
      if (i < entryIdx) { f = i / entryIdx; bed[i] = 3040 - (3040 - 2140) * (1 - Math.pow(1 - f, 1.6)); }
      else if (i <= damIndex) { f = (i - entryIdx) / Math.max(1, damIndex - entryIdx); bed[i] = 2138 - (2138 - bedBase) * f; }
      else { f = (i - damIndex) / Math.max(1, PL - 1 - damIndex); bed[i] = 2080 - (2080 - 1965) * f; }
    }
    for (i = 1; i < PL; i++) if (bed[i] >= bed[i - 1]) bed[i] = bed[i - 1] - 0.3;
    var widths = new Float32Array(PL);
    for (i = 0; i < PL; i++) widths[i] = 1 + 1.6 * i / (PL - 1);

    /* carve the valley + channel */
    var nearest = new Int32Array(NN), nearD = new Float32Array(NN);
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      var bi = 0, bd = 1e9;
      for (i = 0; i < PL; i++) { var d = (path[i].x - x) * (path[i].x - x) + (path[i].y - y) * (path[i].y - y); if (d < bd) { bd = d; bi = i; } }
      i = y * N + x; nearest[i] = bi; nearD[i] = Math.sqrt(bd);
      var w = widths[bi] * 0.5, dd = nearD[i];
      if (dd <= w + 0.01) { land[i] = L.RIVER; elev[i] = bed[bi]; }
      else if (dd < 7) { var lim = bed[bi] + 5 + 16 * Math.pow(dd - w, 1.35); if (elev[i] > lim) elev[i] = lim; }
    }
    /* reservoir bowl */
    var resList = [];
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      var r = Math.hypot(x - center.x, y - center.y) + noise.fbm(x * 0.15, y * 0.15, 2) * 1.5;
      if (r < RAD + 1.5) {
        i = y * N + x;
        var depth = 38 * Math.pow(Math.max(0, 1 - (r / (RAD + 1.5)) * (r / (RAD + 1.5))), 0.8);
        var e = spillElev - depth;
        if (r < RAD) { elev[i] = Math.min(elev[i], e); }
        if (elev[i] < spillElev - 0.5 && r < RAD) { land[i] = L.RESERVOIR; resList.push(i); }
      }
    }
    /* keep the dam lip: cells just downstream of the dam node are river bed */
    for (i = damIndex + 1; i < PL; i++) { var k = path[i].y * N + path[i].x; if (land[k] === L.RESERVOIR) { land[k] = L.RIVER; elev[k] = bed[i]; } }
    var resCells = Int32Array.from(resList);
    var depthArr = new Float32Array(resCells.length), sumDepth = 0;
    for (i = 0; i < resCells.length; i++) { depthArr[i] = spillElev - elev[resCells[i]]; sumDepth += depthArr[i]; }
    var AF_PER_HA_M = 8.10714;
    var scale = C.HYDRO.RESERVOIR_CAPACITY_AF / Math.max(1, sumDepth * AF_PER_HA_M);
    for (i = 0; i < resCells.length; i++) { depthArr[i] *= scale; elev[resCells[i]] = spillElev - depthArr[i]; }
    var bedElev = spillElev; for (i = 0; i < resCells.length; i++) if (elev[resCells[i]] < bedElev) bedElev = elev[resCells[i]];
    /* stage-storage table */
    var TAB = 64, stageAF = new Float32Array(TAB), stageCells = new Float32Array(TAB);
    for (var ti = 0; ti < TAB; ti++) {
      var lvl = bedElev + (spillElev - bedElev) * ti / (TAB - 1), af = 0, cnt = 0;
      for (i = 0; i < resCells.length; i++) { var dz = lvl - elev[resCells[i]]; if (dz > 0) { af += dz * AF_PER_HA_M; cnt++; } }
      stageAF[ti] = af; stageCells[ti] = cnt;
    }
    stageAF[TAB - 1] = C.HYDRO.RESERVOIR_CAPACITY_AF;
    function levelForStorage(af) {
      af = C.clamp(isFinite(af) ? af : 0, 0, stageAF[TAB - 1]);
      for (var q = 1; q < TAB; q++) if (stageAF[q] >= af) {
        var a0 = stageAF[q - 1], a1 = stageAF[q], f2 = a1 > a0 ? (af - a0) / (a1 - a0) : 0;
        return bedElev + (spillElev - bedElev) * ((q - 1 + f2) / (TAB - 1));
      }
      return spillElev;
    }
    function areaForStorage(af) {
      af = C.clamp(isFinite(af) ? af : 0, 0, stageAF[TAB - 1]);
      for (var q = 1; q < TAB; q++) if (stageAF[q] >= af) return stageCells[q];
      return resCells.length;
    }

    /* land classes */
    var treeline = 3450;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = y * N + x; if (land[i] === L.RIVER || land[i] === L.RESERVOIR) continue;
      var e2 = elev[i];
      if (e2 > treeline) land[i] = L.ALPINE;
      else if (e2 > 2200 && noise.fbm(x * 0.05 + 3, y * 0.05, 3) > -0.35) land[i] = L.FOREST;
      else land[i] = L.SHRUB;
    }
    /* town bench E/SE of the reservoir */
    var town = { x0: 66, y0: 58, x1: 86, y1: 76 };
    for (y = town.y0; y <= town.y1; y++) for (x = town.x0; x <= town.x1; x++) {
      i = y * N + x; if (land[i] === L.RIVER || land[i] === L.RESERVOIR || nearD[i] < 2) continue;
      elev[i] = 2085 + (x - town.x0) * 1.2 + noise.fbm(x * 0.2, y * 0.2, 2) * 6;
      land[i] = ((x - town.x0) % 5 === 0 || (y - town.y0) % 6 === 0) ? L.ROAD : L.RESIDENTIAL;
    }
    for (y = 65; y <= 68; y++) for (x = 73; x <= 79; x++) { i = y * N + x; if (land[i] === L.RESIDENTIAL) land[i] = L.CIVIC; }
    /* farms on the southern valley floor */
    for (y = 84; y < N; y++) for (x = 56; x < N; x++) {
      i = y * N + x;
      if (land[i] === L.SHRUB && nearD[i] > 1.8 && nearD[i] < 13 && elev[i] < 2090 && noise.fbm(x * 0.08, y * 0.08, 2) > -0.5) land[i] = L.FARM;
    }
    /* wetland below the dam */
    var wi = Math.min(PL - 1, damIndex + 14), wc = path[wi], wetList = [];
    for (y = wc.y - 5; y <= wc.y + 5; y++) for (x = wc.x - 5; x <= wc.x + 5; x++) {
      if (!C.inBounds(x, y)) continue; i = y * N + x;
      if (Math.hypot(x - wc.x, y - wc.y) < 4.4 && land[i] !== L.RIVER && land[i] !== L.RESERVOIR && land[i] !== L.ROAD) { land[i] = L.WETLAND; wetList.push(i); }
    }
    /* riparian strips */
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = y * N + x;
      if (!(land[i] === L.RIVER && nearest[i] > damIndex) && land[i] !== L.RESERVOIR) continue;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        if (!C.inBounds(x + dx, y + dy)) continue; var j = (y + dy) * N + x + dx;
        if (land[j] === L.SHRUB || land[j] === L.FOREST || land[j] === L.FARM) land[j] = L.RIPARIAN;
      }
    }
    /* roads: main road town -> dam, town -> valley */
    var dam = path[damIndex];
    var roads = [[{ x: 76, y: 66 }, { x: 70, y: 66 }, { x: dam.x + 2, y: dam.y - 1 }], [{ x: 76, y: 66 }, { x: 80, y: 80 }, { x: 88, y: 96 }, { x: 100, y: 110 }, { x: 108, y: 122 }]];
    roads.forEach(function (pl) {
      for (var q = 0; q < pl.length - 1; q++) {
        var a = pl[q], b = pl[q + 1], n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        for (var s2 = 0; s2 <= n; s2++) {
          var rx = Math.round(a.x + (b.x - a.x) * s2 / n), ry = Math.round(a.y + (b.y - a.y) * s2 / n), ri = ry * N + rx;
          if (land[ri] !== L.RIVER && land[ri] !== L.RESERVOIR) land[ri] = L.ROAD;
        }
      }
    });

    /* derived fields */
    var slope = new Float32Array(NN), aspect = new Float32Array(NN);
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      var xl = Math.max(0, x - 1), xr = Math.min(N - 1, x + 1), yu = Math.max(0, y - 1), yd = Math.min(N - 1, y + 1);
      var dzx = (elev[y * N + xr] - elev[y * N + xl]) / ((xr - xl) * C.CELL_M), dzy = (elev[yd * N + x] - elev[yu * N + x]) / ((yd - yu) * C.CELL_M);
      i = y * N + x; slope[i] = Math.hypot(dzx, dzy); aspect[i] = Math.atan2(-dzx, dzy);
    }
    var fuel = new Float32Array(NN), moisture = new Float32Array(NN), burn = new Float32Array(NN), treeDensity = new Float32Array(NN);
    var cropHealth = new Float32Array(NN), habitat = new Float32Array(NN);
    for (i = 0; i < NN; i++) {
      x = i % N; y = (i / N) | 0;
      var ld = land[i], n1 = noise.fbm(x * 0.06 + 11, y * 0.06 + 4, 3);
      if (ld === L.FOREST) { treeDensity[i] = C.clamp(0.65 + 0.35 * n1, 0.35, 1); fuel[i] = C.clamp(0.6 + 0.15 * n1 + 0.08 * -Math.cos(aspect[i]), 0.45, 0.85); moisture[i] = 0.6; }
      else if (ld === L.SHRUB) { fuel[i] = C.clamp(0.5 + 0.1 * n1, 0.45, 0.7); moisture[i] = 0.45; treeDensity[i] = 0.05; }
      else { moisture[i] = 0.45; }
      if (ld === L.RIPARIAN) treeDensity[i] = 0.4;
      if (ld === L.FARM) cropHealth[i] = 0.85;
      habitat[i] = (ld === L.SHRUB || ld === L.RIPARIAN) ? C.clamp(0.5 + 0.4 * n1, 0, 1) : (ld === L.FOREST ? 0.3 : 0);
    }
    /* D8 flow (no sink filling — dev stub) */
    var flowDir = new Int32Array(NN).fill(-1), flowAcc = new Float32Array(NN);
    var order = new Int32Array(NN); for (i = 0; i < NN; i++) order[i] = i;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = y * N + x; var best = -1, bdrop = 0;
      for (var dy2 = -1; dy2 <= 1; dy2++) for (var dx2 = -1; dx2 <= 1; dx2++) {
        if (!dx2 && !dy2) continue; if (!C.inBounds(x + dx2, y + dy2)) continue;
        var j2 = (y + dy2) * N + x + dx2, drop = (elev[i] - elev[j2]) / ((dx2 && dy2) ? 1.414 : 1);
        if (drop > bdrop) { bdrop = drop; best = j2; }
      }
      flowDir[i] = best;
    }
    Array.prototype.sort.call(order, function (a, b) { return elev[b] - elev[a]; });
    for (i = 0; i < NN; i++) flowAcc[i] = 1;
    for (var oi = 0; oi < NN; oi++) { var ci = order[oi], dn = flowDir[ci]; if (dn >= 0) flowAcc[dn] += flowAcc[ci]; }
    var upMask = new Uint8Array(NN);
    for (i = 0; i < NN; i++) { var cur = i, hops = 0; while (cur >= 0 && hops++ < 400) { if (land[cur] === L.RESERVOIR) { upMask[i] = 1; break; } cur = flowDir[cur]; } }

    /* zones */
    var zones = [], zone = new Int16Array(NN).fill(-1);
    function addZone(type, name, cellsArr, extra) {
      var id = zones.length, cells = Int32Array.from(cellsArr), sx = 0, sy = 0, x0 = N, y0 = N, x1 = -1, y1 = -1;
      for (var q = 0; q < cells.length; q++) { var cx = cells[q] % N, cy = (cells[q] / N) | 0; sx += cx; sy += cy; zone[cells[q]] = id; if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy; }
      var z = { id: id, type: type, name: name, cells: cells, center: { x: cells.length ? Math.round(sx / cells.length) : 0, y: cells.length ? Math.round(sy / cells.length) : 0 }, upstreamOfReservoir: !!(extra && extra.up), bbox: { x0: x0, y0: y0, x1: x1, y1: y1 } };
      zones.push(z); return z;
    }
    var fSeeds = [[20, 18, 'Cameron Ridge'], [40, 20, 'Troublesome Bench'], [18, 45, 'North Fork Slopes'], [42, 42, 'Kestrel Divide'], [70, 40, 'Ponderosa Flats'], [95, 60, 'Roaring Gulch']];
    var fBuckets = fSeeds.map(function () { return []; });
    for (i = 0; i < NN; i++) if (land[i] === L.FOREST) {
      x = i % N; y = (i / N) | 0; var bi2 = 0, bd2 = 1e9;
      for (var q2 = 0; q2 < fSeeds.length; q2++) { var d2 = Math.hypot(fSeeds[q2][0] - x, fSeeds[q2][1] - y); if (d2 < bd2) { bd2 = d2; bi2 = q2; } }
      fBuckets[bi2].push(i);
    }
    fSeeds.forEach(function (sd, q) { addZone('forest', sd[2], fBuckets[q], { up: q < 4 }); });
    var nb = [['Marshall Heights', town.x0, town.y0, 76, 66], ['Old Mill', 77, town.y0, town.x1, 66], ['Riverbend', town.x0, 67, 76, town.y1], ['Sagebrush Estates', 77, 67, town.x1, town.y1]];
    nb.forEach(function (n2) {
      var cells = [];
      for (var yy = n2[2]; yy <= n2[4]; yy++) for (var xx = n2[1]; xx <= n2[3]; xx++) { var ii = yy * N + xx; if (land[ii] === L.RESIDENTIAL) cells.push(ii); }
      addZone('neighborhood', n2[0], cells);
    });
    var civ = []; for (i = 0; i < NN; i++) if (land[i] === L.CIVIC) civ.push(i); addZone('civic', 'Downtown', civ);
    var farmNames = ['Lazy J Ranch', 'Two Rivers Farm', 'Hay Meadows Co-op', 'Orchard Bench'], farmB = [[], [], [], []];
    for (i = 0; i < NN; i++) if (land[i] === L.FARM) { y = (i / N) | 0; farmB[Math.min(3, ((y - 84) / 11) | 0)].push(i); }
    farmNames.forEach(function (nm, q) { addZone('farm', nm, farmB[q]); });
    var wz = addZone('wetland', 'Bitterbrush Marsh', wetList);
    var rz = addZone('reservoir', 'Bitterbrush Reservoir', resList);

    /* buildings */
    var buildings = [];
    for (i = 0; i < NN; i++) if (land[i] === L.RESIDENTIAL && rng.chance(0.5)) {
      x = i % N; y = (i / N) | 0;
      buildings.push({ type: 'house', x: x, y: y, rot: ((x - town.x0) % 5 === 1 || (x - town.x0) % 5 === 4) ? Math.PI / 2 : 0, zoneId: zone[i], scale: 0.85 + rng.next() * 0.3 });
    }
    var civicZone = zones.filter(function (z) { return z.type === 'civic'; })[0];
    [['town_hall', 74, 66], ['school', 76, 65], ['hospital', 78, 67], ['fire_station', 75, 68], ['church', 79, 65], ['shop', 77, 66], ['shop', 78, 66]].forEach(function (b) {
      buildings.push({ type: b[0], x: b[1], y: b[2], rot: 0, zoneId: civicZone ? civicZone.id : -1, scale: 1 });
    });
    buildings.push({ type: 'fire_station', x: town.x0 + 1, y: town.y0 + 1, rot: 0, zoneId: zones[6].id, scale: 1 });
    buildings.push({ type: 'treatment_plant', x: dam.x + 3, y: dam.y, rot: 0, zoneId: -1, scale: 1 });
    buildings.push({ type: 'shelter', x: 80, y: 70, rot: 0, zoneId: -1, scale: 1 });
    buildings.push({ type: 'dam', x: dam.x, y: dam.y, rot: Math.atan2(path[Math.min(PL - 1, damIndex + 2)].y - path[Math.max(0, damIndex - 2)].y, path[Math.min(PL - 1, damIndex + 2)].x - path[Math.max(0, damIndex - 2)].x), zoneId: rz.id, scale: 1 });
    zones.filter(function (z) { return z.type === 'farm' && z.cells.length; }).forEach(function (z) { buildings.push({ type: 'barn', x: z.center.x, y: z.center.y, rot: 0.3, zoneId: z.id, scale: 1 }); });

    var cellsAbove = [], cellsBelow = [];
    for (i = 0; i < NN; i++) if (land[i] === L.RIVER) (nearest[i] <= damIndex ? cellsAbove : cellsBelow).push(i);

    var world = {
      seed: seed, N: N, cellM: C.CELL_M,
      elev: elev, land: land, slope: slope, aspect: aspect, fuel: fuel, moisture: moisture, burn: burn, treeDensity: treeDensity,
      cropHealth: cropHealth, habitat: habitat, flowDir: flowDir, flowAcc: flowAcc, zone: zone, zones: zones,
      river: { path: path, widths: widths, damIndex: damIndex, cellsAbove: Int32Array.from(cellsAbove), cellsBelow: Int32Array.from(cellsBelow) },
      reservoir: { cells: resCells, depth: depthArr, bedElev: bedElev, spillElev: spillElev, capacityAF: C.HYDRO.RESERVOIR_CAPACITY_AF, dam: { x: dam.x, y: dam.y },
        intake: { x: dam.x - 1, y: dam.y - 1 }, center: center, levelForStorage: levelForStorage, areaForStorage: areaForStorage, zoneId: rz.id },
      wetland: { cells: Int32Array.from(wetList), zoneId: wz.id, center: { x: wc.x, y: wc.y } },
      buildings: buildings, roads: roads, snowlineElev: 2600, treeline: treeline,
      idx: function (x, y) { return y * N + x; }, xy: function (i) { return { x: i % N, y: (i / N) | 0 }; }, inBounds: C.inBounds,
      neighbors8: function (i) { var x = i % N, y = (i / N) | 0, out = []; for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { if ((dx || dy) && C.inBounds(x + dx, y + dy)) out.push((y + dy) * N + x + dx); } return Int32Array.from(out); },
      cellsOf: function (le) { var o = []; for (var q = 0; q < NN; q++) if (land[q] === le) o.push(q); return Int32Array.from(o); },
      zoneById: function (id) { return zones[id] || null; },
      zonesOf: function (type) { return zones.filter(function (z) { return z.type === type; }); },
      isUpstreamOfReservoir: function (i) { return upMask[i] === 1; },
      summary: function () { var cnt = {}; for (var q = 0; q < NN; q++) cnt[C.LAND_NAMES[land[q]]] = (cnt[C.LAND_NAMES[land[q]]] || 0) + 1; return { land: cnt, zones: zones.length, buildings: buildings.length, reservoirCells: resCells.length, pathLen: PL }; }
    };
    return world;
  }

  WS.StubWorld = { generate: generate };
})();
