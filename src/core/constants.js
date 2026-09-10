/* Watershed — shared constants. Loaded first. Every module attaches to window.WS (or globalThis.WS in Node). */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};

  var C = WS.C = {
    VERSION: '1.0.0',
    N: 128,            // grid is N x N cells
    CELL_M: 100,       // metres per cell edge (map = 12.8 km x 12.8 km)
    ACRES_PER_CELL: 2.47105, // 1 ha = 2.471 acres
    YEARS_DEFAULT: 6,
    SEASONS: ['Winter', 'Spring', 'Summer', 'Fall'],
    SEASON: { WINTER: 0, SPRING: 1, SUMMER: 2, FALL: 3 },

    // land-use enum (Uint8)
    LAND: { RIVER: 0, RESERVOIR: 1, ALPINE: 2, FOREST: 3, SHRUB: 4, FARM: 5, RESIDENTIAL: 6, CIVIC: 7, WETLAND: 8, ROAD: 9, RIPARIAN: 10 },
    LAND_NAMES: ['River', 'Reservoir', 'Alpine/Rock', 'Forest', 'Shrub/Grass', 'Farm', 'Residential', 'Civic', 'Wetland', 'Road', 'Riparian'],

    ZONE_TYPES: ['neighborhood', 'farm', 'forest', 'civic', 'reservoir', 'wetland', 'riparian', 'town'],

    // water sectors, in priority order used by allocation UI
    SECTORS: ['households', 'farms', 'fire', 'hydro', 'recreation', 'tribal', 'wildlife', 'downstream'],
    SECTOR_NAMES: {
      households: 'Households', farms: 'Farms & Ranches', fire: 'Fire Protection Reserve', hydro: 'Hydroelectric',
      recreation: 'Recreation', tribal: 'Tribal Water Right', wildlife: 'Wildlife & Minimum Flow', downstream: 'Colorado River Delivery'
    },

    PHASES: { BOOT: 'boot', INTRO: 'intro', PLAN: 'plan', EVENT: 'event', LIVE: 'live', FLOOD_PREP: 'flood_prep', FLOOD: 'flood', FIRE: 'fire', STORM: 'storm', REPORT: 'report', END: 'end' },

    OUTCOME_KEYS: ['W', 'E', 'P', 'F', 'T'],
    OUTCOME_NAMES: { W: 'Water Security', E: 'Ecosystem Health', P: 'Public Safety', F: 'Food & Economy', T: 'Public Trust' },
    OUTCOME_WEIGHTS: { W: 0.25, E: 0.20, P: 0.20, F: 0.20, T: 0.15 },

    // hydrology reference values
    HYDRO: {
      RESERVOIR_CAPACITY_AF: 42000,
      RESERVOIR_DEAD_POOL_AF: 4000,
      AVG_SNOW_SWE_IN: 18,       // April-1 peak snow water equivalent, inches (avg)
      WATERSHED_AREA_SQMI: 58,
      BASE_POPULATION: 12400,
      GPCD: 118,                 // gallons per capita per day
      IRRIGATED_ACRES: 3100,
      FARM_AF_PER_ACRE_YR: 2.6,
      TRIBAL_RIGHT_AF_YR: 1500,  // senior right, must be met first
      DOWNSTREAM_AF_YR: 9000,    // compact-style delivery obligation
      MIN_FLOW_CFS: 14,          // instream flow right
      AF_PER_CFS_DAY: 1.9835
    },

    // rendering conventions (shared by all render modules)
    RENDER: {
      CELL: 1.0,          // scene units per cell
      ELEV_BASE: 1500,    // metres subtracted before scaling
      ELEV_SCALE: 0.011,  // scene units per metre (exaggerated ~1.4x at this cell size)
      SEA: -2
    },

    PALETTE: {
      sky: 0x9fc7e8, skyLow: 0xf3e6cf, fog: 0xd9e3ec,
      sun: 0xfff1d6, fill: 0xb8c8ff,
      alpine: 0x9a948c, snow: 0xf4f6f8, rock: 0x7d7670,
      forest: 0x35643a, forestDry: 0x5c6b3a, forestDark: 0x2a4f2f,
      shrub: 0xb3a45e, shrubGreen: 0x8fa651, shrubDry: 0xc4a35a,
      farm: 0x8fbf5a, farmDry: 0xc9b26a, farmFallow: 0xa88a5c,
      residential: 0xb9b0a3, civic: 0xc7c2b8, road: 0x6b6560, roadShoulder: 0xa7a08e,
      wetland: 0x4f8f6f, riparian: 0x5f9a4c, aspenFall: 0xe6b422,
      burnLight: 0x5a4d40, burnSevere: 0x1f1b18, ash: 0x8f8a86,
      water: 0x3b7fb0, waterDeep: 0x25597f, waterTurbid: 0x7a6a3d, waterAsh: 0x3d3a37,
      fire: 0xff6a1a, ember: 0xffc14d, smoke: 0x6b6b6b, retardant: 0xe8677a, floodWater: 0x6d7f8f, sandbag: 0xc9b48a,
      houseWall: 0xe8dcc4, houseRoof: 0x8a4b3a, barnRed: 0xa33b2e, school: 0xd9b45a, hospital: 0xf2f2f2, fireStation: 0xc9302c, dam: 0xb5b0a8
    }
  };

  // helpers shared everywhere
  C.idx = function (x, y) { return y * C.N + x; };
  C.xy = function (i) { return { x: i % C.N, y: (i / C.N) | 0 }; };
  C.inBounds = function (x, y) { return x >= 0 && y >= 0 && x < C.N && y < C.N; };
  C.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  C.lerp = function (a, b, t) { return a + (b - a) * t; };
  C.smoothstep = function (a, b, x) { var t = C.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  C.cellsToAcres = function (n) { return n * C.ACRES_PER_CELL; };
  // cell -> scene coordinates (x east, y up, z south)
  C.toScene = function (x, y, elev) {
    return {
      x: (x - C.N / 2 + 0.5) * C.RENDER.CELL,
      y: (elev - C.RENDER.ELEV_BASE) * C.RENDER.ELEV_SCALE,
      z: (y - C.N / 2 + 0.5) * C.RENDER.CELL
    };
  };
  C.elevToScene = function (elev) { return (elev - C.RENDER.ELEV_BASE) * C.RENDER.ELEV_SCALE; };
  C.sceneToCell = function (sx, sz) {
    return { x: Math.floor(sx / C.RENDER.CELL + C.N / 2), y: Math.floor(sz / C.RENDER.CELL + C.N / 2) };
  };
  C.fmt = {
    af: function (v) { return Math.round(v).toLocaleString() + ' AF'; },
    pct: function (v) { return Math.round(v) + '%'; },
    money: function (m) { return '$' + (Math.round(m * 10) / 10).toFixed(1) + 'M'; },
    num: function (v, d) { return Number(v).toFixed(d == null ? 0 : d); }
  };
})();
