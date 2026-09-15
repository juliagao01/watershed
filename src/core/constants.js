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

    // "Where the numbers come from" — headline figures vs. approximate Colorado references (UI shows this list; wording is deliberately cautious)
    SOURCES: [
      { label: 'Population & water use', value: '12,400 people at 118 gpcd (~1,640 AF/yr)', note: 'Colorado municipal systems typically run roughly 100-160 gallons per person per day system-wide; small mountain towns are often 100-130.' },
      { label: 'Reservoir', value: '42,000 AF, 4,000 AF dead pool', note: 'Comparable to a mid-sized Colorado municipal reservoir (Lemon, Rifle Gap and Vallecito span roughly 14,000-130,000 AF); a dead pool near 10% of capacity is typical.' },
      { label: 'Watershed yield & snowpack', value: '58 sq mi, ~35,000-37,000 AF/yr, 18 in April-1 SWE', note: 'About 620 AF per sq mi (~12 in of runoff), within the roughly 300-1,000 AF/sq mi seen in high-elevation Colorado headwaters; mountain SNOTEL sites typically peak at 15-30 in of SWE.' },
      { label: 'Irrigated farms', value: '3,100 acres at 2.6 AF/acre (~8,100 AF/yr)', note: 'Hay and pasture consumptive use in Colorado mountain valleys is roughly 2-3 AF/acre; headgate diversions run higher because much of the water returns to the stream.' },
      { label: 'Senior rights & minimum flow', value: 'Tribal 1,500 AF/yr; downstream delivery 9,000 AF/yr; instream flow 14 cfs', note: 'Scaled-down stand-ins: settled tribal reserved rights and Colorado River Compact obligations are far larger in reality; CWCB instream-flow rights on small mountain streams are typically about 1-30 cfs.' },
      { label: 'Annual budget & storm fund', value: '$8.5M/yr resilience budget, $2.0M emergency fund', note: 'A county-scale capital and grant budget for water, fire and flood resilience (~$700 per resident per year); Colorado counties lean heavily on state and federal grants for projects this size.' },
      { label: 'Forest thinning', value: '$2.8M per forest sector (1,900-3,600 acres)', note: 'Mechanical thinning in Colorado typically costs roughly $1,000-3,000 per acre; the game price treats about the highest-priority half of a sector.' },
      { label: 'Prescribed burn', value: '$0.6M per burn unit (~2,500 acres)', note: 'Prescribed fire typically runs about $100-500 per acre, cheaper than thinning but weather-limited and with escape risk.' },
      { label: 'Home hardening', value: '$1.8M per neighborhood (~70 homes)', note: 'Defensible-space and ignition-resistant retrofit grants are typically about $5,000-30,000 per home.' },
      { label: 'Streamgages & SNOTEL', value: '$1.2M to build, $0.1M/yr upkeep', note: 'Operating a USGS or Colorado DWR streamgage costs roughly $20,000-40,000 per gage per year; the capital cost covers several gages plus snow telemetry.' },
      { label: 'Wetland restoration', value: '$2.2M for ~150 floodplain acres', note: 'Low-tech beaver-mimicry and floodplain reconnection typically run about $5,000-20,000 per acre; full channel reconstruction costs more.' },
      { label: 'Treatment & warning system', value: 'Treatment upgrade $3.5M; flood & fire warning $1.0M', note: 'Post-fire treatment upgrades (turbidity, taste-and-odour) for a town this size typically cost several million dollars; ALERT-style gage and siren networks run roughly $0.5-2M.' },
      { label: 'Flood damage', value: '$0.12M per flooded residential cell', note: 'NFIP claims in Colorado floods have averaged roughly $30,000-60,000 per home; a 2.5-acre cell holds a few homes.' },
      { label: 'Fire tactics', value: 'Crew points; mutual aid $1.5M', note: 'For scale: a large air-tanker drop costs roughly $10,000-20,000, a dozer line about $2,000-5,000 per 100 m; the mutual-aid fee stands in for a county cost-share on a multi-day incident.' }
    ],

    // difficulty levels: multipliers applied where the base numbers live (see C.diff); scoreBonus is added to the final score
    DIFFICULTY: {
      easy:   { label: 'Easy',   desc: 'More money, calmer weather, fewer fires.',   icon: 'leaf', budget: 1.25, emergencyFund: 1.5, ignition: 0.7, storm: 0.7, crew: 1.3, climateSigma: 0.8,  damage: 0.8, scoreBonus: -4 },
      normal: { label: 'Normal', desc: 'The watershed as designed.',                  icon: 'drop', budget: 1,    emergencyFund: 1,   ignition: 1,   storm: 1,   crew: 1,   climateSigma: 1,    damage: 1,   scoreBonus: 0 },
      hard:   { label: 'Hard',   desc: 'Tight budgets, wild weather, hotter fires.',  icon: 'fire', budget: 0.8,  emergencyFund: 0.7, ignition: 1.4, storm: 1.3, crew: 0.8, climateSigma: 1.25, damage: 1.2, scoreBonus: 6 }
    },
    DIFFICULTY_ORDER: ['easy', 'normal', 'hard'],

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
  /** diffDef(state) → the difficulty definition for state.difficulty ('normal' when missing / unknown). */
  C.diffDef = function (state) { var k = state && state.difficulty; return (C.DIFFICULTY && C.DIFFICULTY[k]) || C.DIFFICULTY.normal; };
  /** diff(state, key) → multiplier for `key` at the state's difficulty; 1 when missing (0 for scoreBonus). */
  C.diff = function (state, key) {
    var d = C.DIFFICULTY && C.DIFFICULTY[state && state.difficulty];
    var v = d ? d[key] : undefined;
    if (typeof v === 'number' && isFinite(v)) return v;
    return key === 'scoreBonus' ? 0 : 1;
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
