# WATERSHED — Architecture Spec (v1)

A Colorado water-resilience simulation game. Browser, single page, Three.js r128 (UMD global `THREE`, loaded from cdnjs) + vanilla JS/CSS. No build tooling, no ES modules, no other libraries.

Read `src/core/constants.js` and `src/core/rng.js` first — they are already written and define `WS.C` (constants + helpers), `WS.RNG`, `WS.Noise`, `WS.Bus`. **Use them; do not redefine them.**

## 0. Coding rules (every module)

- Each file is one IIFE: `(function(){ 'use strict'; var root=(typeof window!=='undefined')?window:globalThis; var WS=root.WS=root.WS||{}; ... })();`
- Attach exactly the exports listed for your module to `WS`. Never touch other modules' internals; call only their **spec'd** API.
- ES5-compatible syntax is fine but ES2017 (`const/let`, arrow fns, template strings, classes) is allowed. NO `import/export`, NO `async` at top level. `async/await` inside functions is fine in UI/main.
- `sim/*` and `world/*` modules must run in **Node** with no DOM (used for tests): never reference `window`, `document`, `THREE`, `performance` at top level or in sim logic.
- Every function in your spec'd API must exist with that exact name and signature, and must be **defensive**: never throw on missing optional data; clamp numeric ranges; no NaN leaks (assert with `isFinite` where numbers are produced).
- Zero console errors/warnings at runtime. No `debugger`. Keep `console.log` out except behind `WS.DEBUG`.
- Deterministic: all randomness through an `rng` object passed in (`WS.RNG.create(seed)` / `rng.fork(label)`). Never `Math.random()` in sim/world. Render/UI may use Math.random for purely cosmetic jitter.
- Performance: grid is 128×128 = 16,384 cells. Use typed arrays. No per-cell object allocation in hot loops. Render must hold 60 fps on an integrated GPU: InstancedMesh for repeated props, one draw call per material family, shadow map ≤ 2048.
- Before finishing: run `node --check` on your file(s). Sim/world modules: also write and run a small Node smoke test (`tests/<module>.test.js`) that loads constants.js, rng.js, your deps, and your module via `require`/`vm` and exercises the API (see §9). Delete nothing that isn't yours.
- Numbers must be plausible for a Colorado Front-Range/West-Slope foothills community (see §4 reference values). Text must be accurate about Colorado water/fire facts; when unsure, phrase generally.

File loading order (dev `index.html` and build): core/constants, core/rng, world/terrain, sim/state, sim/projects, sim/hydrology, sim/fire, sim/flood, sim/events, sim/advisors, sim/scoring, sim/casestudies, render/terrainMesh, render/water, render/props, render/effects, render/scene, render/renderer, ui/hud, ui/panels, main.

## 1. Visual style: "Living Diorama"

Distinct from Minecraft (no cubes as the unit) and The Sims (not realistic). Think a hand-built faceted model of a Colorado valley on a table: flat-shaded low-poly terrain with vertex colours, exaggerated relief, warm low sun with long soft shadows, cool fill, pale haze fog at distance, tiny stylised props with slight random hue/scale jitter. Seasons visibly change the world (snow line, aspen gold, brown drought grass, green spring, high/low reservoir ring). Fire is bright emissive quads + rising smoke drifting with wind. Post-fire storm: dark clouds, rain streaks, and brown/black debris particles racing down the drainage into the river and reservoir, water turning turbid. Palette in `WS.C.PALETTE`.

Camera: perspective, orbit around a target on the terrain. Left-drag pans, right-drag/ctrl-drag orbits, wheel zooms, WASD/arrows pan, Q/E rotate. Pitch clamped 22°–80°, distance 12–220 units. Terrain is ~128×128 scene units. `WS.C.toScene(x,y,elev)` converts cell → scene position (x east, y up, z south).

## 2. World (`src/world/terrain.js`) — export `WS.World`

`WS.World.generate(seed) → world` builds the whole map deterministically. Layout (cell coords x→east 0..127, y→south 0..127):

- **Mountains** NW third: elevation 2,900–3,750 m (alpine/rock above ~3,450 m tree line). Ridged noise, a couple of distinct peaks, cirques.
- **Tributary river** ("Bitterbrush Creek", of the Colorado River): source high NW (~x 12,y 10), flows generally SE in a canyon through forested slopes, enters a **reservoir** basin near map centre-left (~x 44–62, y 52–70), leaves over a **dam** at the basin's SE lip, continues SE through a lower valley past the **town** and **farms**, exits at the S/SE edge (~x 118,y 124) — the outlet is labelled the confluence with the Colorado River. Path is a smooth polyline; carve a channel 1–3 cells wide with elevation strictly decreasing along the path (monotonic — verify). Width grows downstream.
- **Reservoir**: basin cells below spill elevation, roughly 180–260 cells (each cell = 2.47 acres → 450–650 acres). Store `bedElev`, `spillElev`, per-cell depth; `capacityAF` must equal `WS.C.HYDRO.RESERVOIR_CAPACITY_AF` (scale depth to hit it). Provide `levelForStorage(af) → elevation` and `areaForStorage(af)` via a stage-storage table.
- **Forest** on slopes 2,200–3,450 m, partitioned into **6 forest sectors** (zones type `forest`) with names (e.g. "Cameron Ridge", "Troublesome Bench", "North Fork Slopes", "Kestrel Divide", "Ponderosa Flats", "Roaring Gulch"). Sectors 1–4 are upstream of the reservoir, 5–6 are above town. Each sector: ~800–1,600 cells. `treeDensity` 0.35–1.0 from noise; `fuel` 0.45–0.85 initial (higher on north aspects and denser stands).
- **Shrub/grass** foothills between forest and valley floor; **riparian** strip 1 cell each side of the river below the dam and around the reservoir shore; one **wetland** site (~60 cells) in a low flat beside the river 10–20 cells below the dam.
- **Town** on a bench E/SE of the reservoir at ~2,050–2,150 m: **4 neighborhoods** (zones type `neighborhood`, each 60–120 residential cells, names like "Marshall Heights" (a WUI neighborhood adjoining forest sector 5), "Old Mill", "Riverbend", "Sagebrush Estates"), a **civic** core (town hall, school, hospital, water treatment plant near the dam intake, 2 fire stations — one downtown, one WUI). Roads: a main road from town to the dam and along the valley, plus streets through neighborhoods (`land=ROAD` cells).
- **Farms**: 4 farm/ranch zones on the southern valley floor along the river ("Lazy J Ranch", "Two Rivers Farm", "Hay Meadows Co-op", "Orchard Bench"), total farm cells ≈ 1,250 (≈3,100 acres = `IRRIGATED_ACRES`). Barns at zone centres.
- **Wildlife habitat**: elk winter range in shrub/riparian, hinted by `world.habitat` Float32Array (0..1).

Returned `world` object (all typed arrays length N*N):
```js
{
  seed, N, cellM,
  elev: Float32Array,        // metres
  land: Uint8Array,          // WS.C.LAND enum
  slope: Float32Array,       // rise/run (0..~1.5)
  aspect: Float32Array,      // radians, 0 = north-facing
  fuel: Float32Array,        // 0..1 (forest/shrub only; 0 elsewhere)
  moisture: Float32Array,    // 0..1 soil moisture (init 0.45 valley, 0.6 forest)
  burn: Float32Array,        // 0..1 burn severity, init 0
  treeDensity: Float32Array, // 0..1
  cropHealth: Float32Array,  // 0..1 (farm cells only), init 0.85
  habitat: Float32Array,     // 0..1
  flowDir: Int32Array,       // D8 downhill neighbour index, -1 at outlet/sinks (fill sinks so every non-water cell drains; reservoir cells drain to dam; dam → downstream river)
  flowAcc: Float32Array,     // upstream cell count (computed via topological order)
  zone: Int16Array,          // zone id or -1
  zones: [ { id, type, name, cells: Int32Array, center:{x,y}, upstreamOfReservoir:boolean, bbox:{x0,y0,x1,y1} } ],
  river: { path: [{x,y}], widths: Float32Array /* cells, per path node */, damIndex: number /* path node index at the dam */, cellsAbove: Int32Array, cellsBelow: Int32Array },
  reservoir: { cells: Int32Array, depth: Float32Array /* per reservoir cell, m at full pool */, bedElev, spillElev, capacityAF, dam:{x,y}, intake:{x,y}, center:{x,y},
               levelForStorage(af)→elevation m, areaForStorage(af)→cells, zoneId },
  wetland: { cells: Int32Array, zoneId, center:{x,y} },
  buildings: [ { type:'house'|'school'|'hospital'|'fire_station'|'town_hall'|'treatment_plant'|'barn'|'dam'|'shelter'|'church'|'shop', x, y, rot /* radians */, zoneId, scale } ],
  roads: [ [{x,y},...] ],    // polylines (cells also flagged land=ROAD)
  snowlineElev: 2600,        // winter default; render will vary with season/climate
  treeline: 3450,
  idx(x,y), xy(i), inBounds(x,y), neighbors8(i)→Int32Array-like array of indices,
  cellsOf(landEnum)→Int32Array, zoneById(id), zonesOf(type)→array,
  isUpstreamOfReservoir(i)→bool  // uses flowDir chain / precomputed mask
}
```
Houses: place 1 building per ~2 residential cells (≈300 houses), rotated to nearest road. Ensure school, hospital, town hall, treatment plant, 2 fire stations exist exactly once (except fire_station ×2). Provide `world.summary()` returning counts for tests. Runs in < 400 ms.

## 3. Game state (`src/sim/state.js`) — export `WS.State`

`WS.State.create(opts) → state` where `opts = { seed, years, mode:'simulated'|'historical' }`. Also `WS.State.serialize(state)→string`, `WS.State.deserialize(str)→state`, `WS.State.pushHistory(state)` (appends snapshot to `state.history`), `WS.State.log(state, text, kind)` (kind: 'info'|'good'|'bad'|'warn'|'event'), `WS.State.schedule(state, turnsAhead, label, effect)` where `effect` is a serialisable object `{ type:'outcome'|'budget'|'flag'|'demand'|'custom', key, value, text }` applied by `WS.Events.runScheduled`. Custom effects reference a handler name in `WS.Events.HANDLERS[name]`.

```js
state = {
  seed, mode, years, turn:0, year:1, season:0 /* WS.C.SEASON */, phase:'boot',
  budget: 12, annualBudget: 12, emergencyFund: 0,    // $M
  outcomes: { W:70, E:65, P:72, F:68, T:60 }, resilience: 0,
  population: 12400, growthRate: 0.012,
  climate: { snowpackPct:100, snowSWEin:18, precipIn:3.2, tempAnomF:0, soilMoisturePct:45, fireDanger:0.2, fireDangerLabel:'Moderate',
             streamflowCfs:60, windDirRad:0.8, windMph:8, drought:'None'|'D0'..'D4', description:'' , uncertainty:0.15 },
  reservoir: { storageAF:32000, capacityAF:42000, turbidity:0.05, ashContam:0, algae:0 },
  water: { demands:{households:0,farms:0,fire:0,hydro:0,recreation:0,tribal:0,wildlife:0,downstream:0} /* AF this season */,
           alloc:{households:1,farms:1,fire:1,hydro:1,recreation:1,tribal:1,wildlife:1,downstream:1} /* fraction of request the player chooses to deliver */,
           delivered:{...}, shortage:{...}, availableAF:0, inflowAF:0, outflowAF:0, restriction:'none'|'voluntary'|'stage1'|'stage2' },
  fire: { policy:'managed'|'suppress_all', activeFire:null, seasonAcres:0, totalAcres:0, structuresLost:0, fires:[ {year,season,acres,zoneIds,structures,upstream} ], smokeDays:0 },
  projects: { funded:{ /* id -> { level, targets:[zoneId], turnFunded } */ }, pendingBurn:null },
  mitigations: [],                 // flood placements this storm: { type, x, y }
  pendingStorm: null,              // { intensityIn, turnsUntil, source:'event'|'random' }
  scheduled: [],                   // [{ dueTurn, label, effect }]
  log: [], timeline: [],           // timeline: [{ turn, year, season, entries:[{ text, kind, delta:{W,E,P,F,T} }] }]
  history: [],                     // per-turn snapshots { turn, year, season, storageAF, snowpackPct, streamflowCfs, fireDanger, fuelAvg, turbidity, W,E,P,F,T, R, budget, cropHealth, shortagePct, trust }
  unlockedCases: [], seenCases: [],
  flags: {},                       // free-form booleans/counters: e.g. droughtDeclared, musselInspection, townHallHeld, contaminationEvents
  stats: { floodDamageM:0, sedimentTons:0, contaminationOutageDays:0, cropLossPct:0, hydroMWh:0, recreationVisits:0 },
  lastSeasonReport: null
}
```
`state.turn` counts seasons from 0; `year = 1 + floor(turn/4)`, `season = turn % 4`; game ends after `years*4` turns. Year 1 starts in Winter.

## 4. Hydrology (`src/sim/hydrology.js`) — export `WS.Hydrology`

Reference values in `WS.C.HYDRO`. Units: acre-feet (AF) per season; cfs for displayed flow.

- `generateSeasonClimate(state, world, rng)` — sets `state.climate` for the new season. Winter: snowpack accumulates (SWE % of avg drawn from an AR(1) process with sigma ≈ 25% and an El Niño-ish multi-year drift; historical mode uses `WS.Hydrology.HISTORICAL` — an array of ~12 approximate Colorado statewide April-1 snowpack % of median values, labelled "approximate"). Spring: melt; Summer: heat (temp anomaly), monsoon precip chance; Fall: storms. Also computes `fireDanger` 0..1 from temp anomaly, precip, soil moisture, mean fuel of forest cells, and a label (Low/Moderate/High/Very High/Extreme), drought category D0–D4 from cumulative deficit, wind. Sets `uncertainty` (0.05 if `streamgages` funded else 0.25) — UI shows ranges when uncertain.
- `computeDemands(state, world)` — fills `state.water.demands` (AF for the season) from population×GPCD (seasonal factor: summer 1.45, winter 0.7), farm acres × AF/acre (spring 0.3, summer 0.55, fall 0.15, winter 0) adjusted by irrigation efficiency, fire reserve (fixed 600 AF, ×2 if fireDanger>0.6), hydro (non-consumptive release request), recreation (target pool level), tribal (fixed senior right ÷ seasons), wildlife (min flow cfs → AF), downstream (delivery obligation ÷ seasons). Applies effects from `WS.Projects.effects(state)` (leak reduction, irrigation efficiency, rain capture) and restriction level.
- `computeAvailable(state, world)` — `state.water.inflowAF` (snowmelt runoff this season ← snowpack, soil moisture, burn scar increases runoff volume but lowers quality; baseflow; monsoon) and `availableAF = inflow + max(0, storage − deadPool)`.
- `runSeason(state, world, rng) → report` — resolves allocation: **tribal right and downstream obligation are legally senior** — if the player under-allocates them, deliver anyway from storage and set `report.legalOverride=true` (trust −, and the Evidence board warns). Deliveries = min(request×alloc, remaining) in sector order of `state.water.alloc` priority (households, tribal, downstream first, then farms, wildlife, fire, hydro, recreation — hydro/recreation/wildlife are non-consumptive: released water still flows downstream). Updates `state.reservoir.storageAF` (clamped to capacity; spill counted), `turbidity` decay 35%/season, `ashContam` decay 25%/season (faster with treatment upgrade), algae (warm + low pool), soil moisture per-cell nudge (`world.moisture`: valley cells toward precipitation/irrigation, forest cells toward precip/temperature), `cropHealth` per farm cell from farm delivery ratio (+ recovers slowly), streamflow cfs below dam from releases. Returns:
```js
report = { season, year, inflowAF, availableAF, outflowAF, spillAF, endStorageAF, storagePct, deliveries:{...}, shortages:{...}, shortagePct:{...},
           minFlowMet:boolean, legalOverride:boolean, cropHealthAvg, turbidity, ashContam, hydroMWh, recreationIndex, notes:[string] }
```
- `contaminate(state, world, sedimentTons, ashFraction)` — called by Flood: raises turbidity/ashContam by amounts scaled by sediment relative to reservoir volume, reduced by `intake_protect` mitigation / `treatment` project; returns `{turbidityDelta, ashDelta, outageDays}` (outage days when contamination exceeds treatment capacity; halved if sensors detect early).
- `WS.Hydrology.HISTORICAL` — approximate annual snowpack % array with a `note` string.
- All results finite; storage never < 0 or > capacity (+ reservoir_upgrade bonus from Projects effects).

## 5. Fire (`src/sim/fire.js`) — export `WS.Fire`

- `updateAnnual(state, world)` — each Winter: fuel accumulates (+0.04/yr forest, +0.03 shrub; ×1.6 if `state.fire.policy==='suppress_all'`), burned cells regrow (`burn` −0.12/yr, faster with mulch/reseed flag in `world.regrow` if present; `treeDensity` recovers slowly), thinning effects decay (Projects handles its own bookkeeping; Fire reads `WS.Projects.effects(state).thinnedZones` map zoneId→strength 0..1 and `fuelBreakZones`, `hardenedZones`).
- `seasonIgnitionChance(state, world)` → probability of a wildfire this season (0 in Winter; Summer highest; f(fireDanger, wind, drought)). Typical: Moderate danger ≈ 8%, High 20%, Very High 38%, Extreme 60%.
- `maybeIgnite(state, world, rng, forced?) → fireSim|null`. `forced = { zoneId }` from an event card. Picks an ignition cell weighted by fuel×(1−moisture) and human proximity (roads/WUI) unless forced. Returns a simulation object.
- `step(fireSim, state, world, rng) → { newlyBurning: number[], extinguished: number[], done: boolean, acres: number, perimeterCells: number }` — cellular spread: for each burning cell, each 8-neighbour ignites with p = base(0.28) × fuel × (1−moisture)^1.5 × windFactor(direction alignment 0.4–1.8) × slopeFactor(upslope 1.0–1.9) × dangerFactor × (1 − thinning×0.6) × landFactor (forest 1.0, shrub 0.8, riparian 0.35, farm 0.25, residential 0.55 (0.2 if hardened), road 0.05, water 0, alpine 0.05). Cells burn for 2–3 steps then become burned with severity = f(fuel, treeDensity, danger). Suppression: each step, cells within 10 cells of a fire station or within a hardened/fuel-break zone have 25–60% chance to be extinguished; `state.fire.crewFocus` ('town'|'watershed'|'farms'|null, set by the fire response event card) boosts suppression in that area; total suppression strength scales with `state.fire.responseBudget`. Fire ends when no burning cells or after `fireSim.maxSteps` (35–70 depending on danger). Hard cap: a single fire ≤ 45% of forest cells.
- `finalize(fireSim, state, world) → fireReport` — writes `world.burn` (max with severity), reduces `world.fuel` (×0.15), `world.treeDensity` (×(1−severity×0.85)), `world.moisture` (−0.15), sets `world.habitat` down in burned cells, counts `acres`, `structuresLost` (houses in burned residential cells: 55% each, 15% if hardened), `upstreamAcres` (cells upstream of reservoir), `zoneIds` touched, and appends to `state.fire.fires`. Returns `{ acres, upstreamAcres, structuresLost, zoneIds, severityAvg, smokeDays, cellsBurned:Int32Array, startCell }`.
- `prescribedBurn(state, world, zoneId, rng) → { success, escaped, cellsTreated, fuelBefore, fuelAfter, escapeFire:fireSim|null }` — reduces fuel ×0.4 in the sector; escape chance 4% base, ×3 if fireDanger>0.5.
- `danger(state, world)` → recompute fire danger 0..1 (used by hydrology too if convenient; Hydrology owns `state.climate.fireDanger` but may call this).
- Provide `fuelStats(world) → { avg, byZone:{zoneId:avg} }`.

## 6. Post-fire flood (`src/sim/flood.js`) — export `WS.Flood`

The signature level. A storm over a burn scar sends water and sediment downhill.

- `stormRisk(state, world)` → probability of a damaging storm this season given burn scar presence (Fall/Summer highest) — Game uses it when `pendingStorm` is null.
- `prepare(state, world, storm) → prep` where `storm = { intensityIn (0.8–3.0), durationHr, turnsUntil }`. Returns `{ scarCells:Int32Array, scarAcres, atRiskZones:[zoneId], predictedPeakCfs, predictedSedimentTons, placeable:{ mulch:Int32Array, barrier:Int32Array, debris_basin:Int32Array, bank_stab:Int32Array, intake_protect:Int32Array, sensor:Int32Array, warning:Int32Array } }` — arrays of cell indices where each tool may be placed (mulch on scar cells; barriers on scar/shrub cells with flowAcc between 5 and 60; debris basins on channel cells with flowAcc > 60 below the scar and above the reservoir/town; bank_stab on riparian/river cells below the dam; intake_protect only at reservoir.intake; sensor on river cells; warning at neighborhood centres).
- `TOOLS` — `{ mulch:{name,desc,costM:0.35,radius:1,effect}, barrier:{costM:0.15}, debris_basin:{costM:1.2,capacityTons:4000}, bank_stab:{costM:0.5}, intake_protect:{costM:0.8, max:1}, sensor:{costM:0.2}, warning:{costM:0.25} }` with short educational `desc` strings.
- `canPlace(prep, type, i) → boolean`.
- `simulate(state, world, storm, mitigations) → result` — deterministic given inputs (no rng needed). Model: for each cell, runoff = rain × runoffCoeff (base by land 0.15–0.35; burn severity adds up to +0.55; wetland cells 0.05; moisture saturation adds); sediment source = runoff × burn × slope × 900 (tons scale) reduced 60% under mulch radius; route along `flowDir` in topological order accumulating `flow` and `sediment`; barriers on a cell trap 50% of passing sediment (cap 300 t); debris basins trap up to capacity; wetland (if `restored` effect) traps 35% of sediment and attenuates peak 30% for flow passing through; bank_stab prevents bank erosion (which otherwise adds sediment proportional to flow on riparian/river cells with no stabilisation); reservoir cells receive → `sedimentToReservoir`, `ashToReservoir` (sediment × mean burn severity of contributing cells); flow through residential/civic/farm cells above threshold → flooded cells and damage $ (residential $0.12M per flooded cell ×(1−rainCapture×0.3), farms $0.03M + cropHealth −0.4); `warning` markers in a neighborhood cut injury risk 80%; `sensor` on a river cell above the intake gives early detection (halves contamination outage). Peak flow at the reservoir/town in cfs from accumulated runoff (calibrate so a 2-inch storm on a 5,000-acre high-severity scar gives ~1,500–4,000 cfs at the reservoir versus ~120 cfs unburned).
  Result:
```js
{ peakCfsReservoir, peakCfsTown, sedimentTons, sedimentToReservoir, ashToReservoir, trappedTons, floodedCells:Int32Array, floodedHouses, damageM, injuriesRisk(0..1),
  contamination:{turbidityDelta, ashDelta, outageDays} /* via Hydrology.contaminate */, earlyWarning:boolean, frames:[Frame] }
```
  Frames for animation: 24–40 frames; each `Frame = { positions: Float32Array (3*k cell-space: x, y, sedimentFraction), count:k, reservoirTurbidity, notes? }` — particles travel down flow paths from scar to river/reservoir; use cell coords (x,y) + sediment fraction; the renderer lifts them to terrain. Keep total particles ≤ 4,000 per frame.
- `counterfactual(state, world, storm) → result` = `simulate(..., [])` also with `wetland`/rain-capture effects disabled (so the timeline can quantify what each measure prevented). Also `attribute(state, world, storm, mitigations) → [{ label, preventedDamageM, preventedSedimentTons, pct }]` by removing each mitigation type in turn.
- `applyResult(state, world, result)` — mutates state (damage costs from budget/emergencyFund, stats, cropHealth, reservoir contamination via Hydrology.contaminate, log lines). Also leaves `world.burn` a bit lower where mulch was applied (recovery boost via `world.regrow` Float32Array created lazily).

## 7. Projects (`src/sim/projects.js`) — export `WS.Projects`

`WS.Projects.LIST` — array of definitions:
```js
{ id, name, icon /* emoji */, category:'monitor'|'water'|'fire'|'flood'|'community', costM, upkeepM, maxLevel, targetType:'global'|'forest'|'neighborhood'|'wetland'|'farm', 
  summary, detail /* 2–3 sentences of accurate Colorado context */, tradeoff /* one sentence on the downside */, effects:{...static numbers}, seasonsAllowed:[0,1,2,3] }
```
Required ids: `streamgages`, `irrigation` (max 3), `leak_detection` (max 3), `forest_thinning` (forest sector), `prescribed_burn` (forest sector; seasons Spring/Fall; creates `state.projects.pendingBurn` executed at season end by Game via `WS.Fire.prescribedBurn`; may trigger the "residents oppose" event), `reservoir_upgrade` (max 2: capacity +15%, then multi-level intake), `rain_capture` (max 2), `home_hardening` (neighborhood), `fuel_break` (neighborhood), `wetland` (wetland), `shelters`, `warning_system`, `outreach` (annual, max 1, upkeep), `treatment` (treatment upgrade), `stockpile` (emergency erosion stockpile: +3 free barrier/mulch placements in flood prep), `mussel_inspection` (boat inspection stations; upkeep; unlocked/relevant after mussel event but always fundable), `wildlife_corridor` (habitat/ecosystem+, small).
Costs in $M, calibrated so a $12M/yr budget funds 2–4 things a year.

API: `canFund(state, world, id, targetZoneId) → { ok, reason }`, `fund(state, world, id, targetZoneId, rng) → { ok, text }` (deducts budget, records, applies immediate world effects such as thinning fuel ×0.55 in the zone, wetland `land` unchanged but `state.flags.wetlandRestored=true`, etc.), `effects(state) → effectsObject` (memoised per turn):
```js
{ sensorCoverage:0|1, irrigationEfficiency:0..0.36, leakReduction:0..0.18, thinnedZones:{zoneId:strength}, fuelBreakZones:{zoneId:true}, hardenedZones:{zoneId:true},
  reservoirCapacityBonus:0|0.15, multiLevelIntake:bool, rainCaptureAF:0..900, wetlandRestored:bool, shelters:bool, warningSystem:bool, outreach:bool, treatment:bool,
  stockpileBonus:0|3, musselInspection:bool, wildlifeCorridor:bool, upkeepM:number }
```
`tick(state, world)` — each Winter: charge upkeep, decay thinning strength (−0.12/yr), expire outreach unless re-funded (or make outreach an ongoing upkeep). `listFor(state, world) → [{def, funded, level, canFund, reason, targets:[{zoneId,name,funded}]}]` for the UI.

## 8. Events (`src/sim/events.js`) — export `WS.Events`

`WS.Events.CARDS` — ≥ 18 cards. Card:
```js
{ id, title, icon, text /* 2–4 sentences, vivid, accurate */, source /* short "Why this happens in Colorado" line */, severity:'info'|'warn'|'crisis',
  when(state, world) → boolean, weight(state) → number, once:boolean,
  choices: [ { label, desc, costM?, apply(state, world, rng) → { text, delta?:{W,E,P,F,T} } } ] }
```
Required ids: `low_snowpack`, `heat_wave`, `mussels`, `lightning_fire` (sets `state.fire.forcedIgnition={zoneId}` for an upstream sector), `storm_forecast` (requires burn scar; sets `state.pendingStorm`), `pipe_leak`, `federal_funding`, `residents_oppose_burn` (when `pendingBurn`), `fire_response` (special: not drawn randomly — returned by `WS.Events.fireResponseCard(state, world, fireSim)` at ignition; choices set `state.fire.crewFocus` and `responseBudget`), `senior_call` (downstream senior right places a call), `algae_bloom`, `smoke_event` (regional smoke; shelters help), `subdivision_proposal` (WUI growth: population + budget + exposure), `fish_kill_warning` (low flows), `hydro_shortfall`, `well_failure` (rural wells dry), `tourism_boom`, `ski_area_request`, `insurance_retreat` (post-fire insurers leave WUI; hardening helps), `mutual_aid` (neighbouring county asks for water/crews), `dust_on_snow` (early melt), `beetle_kill` (fuel up in a sector), `flash_drought`.
`draw(state, world, rng) → card[]` (0–2 per season, weighted, respects `when`/`once`, never repeats a card within 3 turns), `runScheduled(state, world) → string[]` (applies due scheduled effects; see State.schedule — effect types: `outcome` (add to outcomes[key]), `budget` (add $M), `flag` (set flags[key]=value), `demand` (state.flags.demandMult[key]), `custom` (calls `WS.Events.HANDLERS[key](state, world, value)`)), `HANDLERS`.
Delayed consequences must be used meaningfully (e.g. ignoring the pipe leak → 2 turns later bigger failure; skipping mussel inspection → intake fouling; approving the subdivision → 4 turns later "insurance retreat"/higher fire exposure).

## 9. Advisors, scoring, case studies

`src/sim/advisors.js` — `WS.Advisors.CHARACTERS` (firefighter Capt. Dolores Reyes, rancher Walt Jensen, tribal water representative Naomi Whitehorse (Southern Ute-inspired, written respectfully and generally), hydrologist Dr. Priya Natarajan, resident/parent Marcus Lee, wildlife biologist Dr. Ana Ortiz) with `{ id, name, role, color, avatarEmoji, bio }`. `getRecommendations(state, world, topic) → [{ characterId, stance:'urge'|'support'|'caution'|'oppose', headline, text /* 2–3 sentences grounded in the current numbers */, evidence:{ label, unit, series:number[] /* from state.history */, current:number, threshold?:number } }]`. Topics: `'budget'`, `'allocation'`, `'prescribed_burn'`, `'fire_policy'`, `'flood'`, `'contamination'`, `'drought'`. Each topic returns 4–6 legitimate, different priorities; no one is "the right answer".

`src/sim/scoring.js` — `WS.Scoring.updateOutcomes(state, world, seasonReport, extras) → { before, after, delta, reasons:[{key, text, delta}] }` — computes target values for W,E,P,F from state (see below), moves each outcome 45% toward its target (momentum), T only via deltas accumulated in `state.trustDelta` this turn plus slow regression toward 55 (±1/turn); clamps 0..100; `resilience(outcomes)` = weighted sum; `grade(R)` → letter+title; `finalSummary(state) → { R, grade, outcomes, highlights:[string], lessons:[string], stats }`.
Targets: W = 100×(0.45×storage/capacity_norm + 0.35×(1−householdShortagePct) + 0.2×(1−ashContam)) − contamination outage penalty; E = f(minFlowMet streak, mean habitat, mean treeDensity vs initial, turbidity, wetlandRestored, burn extent); P = f(structures lost, flood damage, smokeDays w/o shelters, warning/shelter projects, hardened share of WUI homes, fire danger near town); F = f(cropHealth avg, farm shortagePct, recreationIndex, hydroMWh, damage costs, tourism flags).

`src/sim/casestudies.js` — `WS.CaseStudies.LIST`: `{ id, title, year, region, summary (≤120 words, accurate, cite figures conservatively: e.g. Cameron Peak Fire 2020 — Colorado's largest at ~208,000 acres, burned much of the Cache la Poudre watershed above Fort Collins' supply; East Troublesome 2020 — ~193,000 acres, ran ~17 miles in a day into Grand Lake/Rocky Mountain NP; Marshall Fire Dec 30 2021 — a grass fire driven by 100+ mph winds destroyed >1,000 homes in Louisville/Superior, the most destructive in state history; Colorado River — 40 million people, 1922 Compact over-allocated, Lake Powell/Mead record lows 2022; Shoshone water right — 1902 senior non-consumptive right at Glenwood Canyon hydro plant keeps water in the river, 2024 purchase agreement by Colorado River District; streamgages — USGS/Colorado DWR network, ~ real-time data; invasive mussels — zebra/quagga, boat inspection program, first adult zebra mussels found in Colorado in Highline Lake 2022 and Colorado River near Grand Junction 2024), lesson, unlock(state, world) → boolean, linkTo:'what you just experienced' string }`. `checkUnlocks(state, world) → newlyUnlockedIds`.

## 10. Rendering

Shared conventions: scene position via `WS.C.toScene`. All render modules receive `world` and `state`. Never mutate world/state.

### `src/render/terrainMesh.js` — `WS.TerrainMesh`
- `build(world) → { mesh: THREE.Mesh, geometry, heightAt(sx, sz) → sceneY (bilinear), recolor(world, state, seasonIdx, opts) }`. Non-indexed BufferGeometry (2 tris per cell, 128×128 cells → ~98k tris; vertex heights from the 129×129 corner grid — compute corner elevations by averaging adjacent cells), `MeshStandardMaterial({ vertexColors:true, flatShading:true, roughness:0.95, metalness:0 })`, receives + casts shadows. Per-face colour from the cell: base by `land`, modulated by elev banding, aspect shading (subtle), noise jitter ±4%, `burn` (blend to burnLight→burnSevere by severity, ash tint), `moisture` (drought browning for shrub/farm/forest), `cropHealth` for farms, snow above the season's snowline (winter: `world.snowlineElev`; spring: +500 m; summer none except > 3,600 m; fall: > 3,300 m) with a soft noisy edge, aspen gold in riparian in fall, roads dark grey, river/reservoir cells a dark bed colour (water mesh sits on top). `recolor` must run < 60 ms (typed arrays, no allocations per call). Also expose `colorForCell(i, world, state, seasonIdx, out)`.
- Skirt: add a thin skirt/ base box under the terrain edges so the diorama has a visible "table edge" (dark earth colour) — the diorama look.

### `src/render/water.js` — `WS.WaterMesh`
- `build(world) → { group: THREE.Group, update(dt), setReservoir(fracFull, turbidity, ash), setRiver(cfs, turbidity), setSeason(seasonIdx) }`. Reservoir: a plane over the basin bbox at elevation `world.reservoir.levelForStorage(storage)`; translucent (opacity 0.85), custom shader or `onBeforeCompile` ripple (gentle vertex/normal wobble + moving specular sparkle). Exposed shoreline ("bathtub ring") appears naturally as terrain shows. River: a ribbon mesh along `world.river.path` (Catmull-Rom smoothed), width from `widths` × (0.6 + cfs factor), 0.08 units above terrain, animated flow (scroll UV noise), colour lerps water → waterTurbid → waterAsh by turbidity/ash. Below the dam a small spillway/white-water strip. Frozen look in winter (lighter, no sparkle) when storage low temps.

### `src/render/props.js` — `WS.Props`
- `build(world, scene) → props`, `props.refresh(world, state)` (after fire/flood/season: burned trees → snags, crops colour by health, snow caps in winter), `props.setSeason(seasonIdx)`, `props.update(dt, state)` (animations), `props.setFire(burningIdx)` optional (trees in burning cells flicker/shrink), `props.dispose()`.
- Trees: InstancedMesh, conifers (2–3 stacked cones + trunk, merged into one geometry, ~40 tris), 1–4 per forest cell by `treeDensity` (target 12k–20k instances), hue/scale jitter; aspens (small sphere-ish canopy on thin trunk) in riparian and lower forest — gold in fall; snags (bare trunk + 2 stubs) InstancedMesh for burned cells; sagebrush blobs on shrub cells (sparse). Hide (scale 0) instances of live trees in burned cells and show snags.
- Buildings from `world.buildings`: houses (box + gable roof, chimney, varied wall/roof colours), barns (red gambrel), school (long yellow block with flag pole), hospital (white block with red cross box), fire stations (red with white door), town hall (dome/clock tower), treatment plant (grey tanks), dam (concrete arc at `world.reservoir.dam`), shelter, church (steeple), shops. Use a few InstancedMeshes for houses; individual meshes for uniques. Burned houses → charred foundation. Farm cells: instanced crop rows (thin boxes) coloured by `cropHealth`; a few hay bales; fences optional. Roads: thin dark strips slightly above terrain along `world.roads` (ribbon mesh) OR rely on terrain colour + add centre stripes — pick the one that looks best.
- Life: ~40 people (capsule body + head, 2 colours) walking along roads in town; ~24 elk/deer (box body, neck, head, 4 legs — abstract) grazing/moving in shrub/riparian habitat, fleeing away from fire cells when a fire is active; 3 fire trucks parked at stations that drive along roads toward the fire when `state.fire.activeFire`; a couple of cars looping on the main road; birds (tiny V shapes) circling the reservoir. Keep all life in InstancedMeshes; update matrices each frame (cheap).
- Snow: in winter, houses/trees above snowline get a white cap — implement as tinting via per-instance colour (`instanceColor`) rather than extra geometry.

### `src/render/effects.js` — `WS.Effects`
- `init(scene, world) → fx` with `fx.update(dt, camera)`, `fx.setFire(burningIdx:number[], burnedIdx:number[])` (emissive quads/points at burning cells with flicker, embers, smoke particles rising and drifting with wind; glow light), `fx.setWind(dirRad, mph)`, `fx.setWeather(kind:'clear'|'rain'|'storm'|'snow'|'smoke'|'haze', intensity 0..1)` (rain/snow as Points in a box that follows the camera; storm adds dark cloud layer (large soft translucent planes) + occasional lightning flash via ambient light spike; smoke/haze adjusts scene fog density & colour through a callback set by Scene: `fx.onFogChange(fn)`), `fx.showDebris(frame)` where frame is the Flood Frame (cell-space particles → lift to terrain via a `heightAt` supplied in init opts, brown→black by sediment fraction, small trail), `fx.clearDebris()`, `fx.setOverlay(mode, world, state)` — `'watershed'`: draw flow arrows/lines along the D8 network for cells with `flowAcc>8` (LineSegments, blue, thickness by accumulation), brighter in burned areas and coloured brown where burn>0.3; a semi-transparent tint on cells upstream of the reservoir; `'fire'`: tint cells by fuel×(1−moisture) (green→red); `'moisture'`: blue scale; `'burn'`: burn severity; `'none'`. Overlay is a single translucent plane mesh with vertex colours just above terrain (or a texture on a plane) — must update < 50 ms. `fx.setHighlight(indices:number[]|null, colorHex)` (pulsing translucent cells) and `fx.addMarker(id, type, x, y)`, `fx.removeMarker(id)`, `fx.clearMarkers()` — marker types: mitigation tools (`mulch`=straw-yellow disc, `barrier`=brown log row, `debris_basin`=grey ring, `bank_stab`=stone strip, `intake_protect`=blue boom, `sensor`=white post with blinking light, `warning`=siren pole), plus `'pin'` and `'fireStart'` — small clear geometry, all instanced or pooled; `fx.setPlacementCursor(type|null, x, y)`.

### `src/render/scene.js` — `WS.Scene`
- `init(containerEl, world) → scene ctx` `{ renderer, scene, camera, controls, sun, ambient, hemi, setSeasonLighting(seasonIdx, climate), setTimeOfDay(t), setFog(color, density), startLoop(tickFn(dt)), stopLoop(), resize(), project(x,y,z)→{sx,sy}, pick(clientX, clientY, terrainMesh)→{sx,sy,sz}|null, focus(sx,sz,dist), setControlsEnabled(bool), dispose() }`.
  WebGLRenderer antialias, `setPixelRatio(min(devicePixelRatio,2))`, shadows PCFSoft, tone mapping ACESFilmic exposure 1.05, sRGB output (`renderer.outputEncoding = THREE.sRGBEncoding` in r128). Sky: large inverted sphere with gradient shader (sky → skyLow), plus fog `THREE.FogExp2`. Sun: DirectionalLight with shadow camera covering the map (orthographic ±80, mapSize 2048), warm; hemisphere light sky/ground; ambient low. Season lighting: winter cooler/low sun, summer high warm, fall golden, smoke → orange-grey. Custom orbit controls (see §1) with inertia and target clamped to map bounds; touch support (1-finger pan, 2-finger pinch/rotate). Also drifting cloud shadows optional (a large soft noise texture on a plane moving slowly — cheap and pretty).
- Resize handling via `ResizeObserver` on container.

### `src/render/renderer.js` — `WS.Renderer` (facade used by the Game)
```js
WS.Renderer.init(containerEl, world, state)       // builds Scene, TerrainMesh, WaterMesh, Props, Effects; starts loop
WS.Renderer.pickCell(clientX, clientY) → {x,y,i}|null
WS.Renderer.onCellClick(fn), onCellHover(fn)      // fn({x,y,i}) — click = pointerdown+up within 5px & 300ms
WS.Renderer.setSeason(seasonIdx, climate)         // lighting, snowline, terrain recolor, props season, water season
WS.Renderer.refreshWorld()                        // terrain recolor + props refresh (after fire/flood/projects)
WS.Renderer.setReservoir(fracFull, turbidity, ash)
WS.Renderer.setRiverFlow(cfs, turbidity)
WS.Renderer.setFire(burningIdx, burnedIdx)        // [] [] to clear
WS.Renderer.setWeather(kind, intensity)
WS.Renderer.setWind(dirRad, mph)
WS.Renderer.showDebris(frame) / clearDebris()
WS.Renderer.setOverlay(mode)
WS.Renderer.setHighlight(indices, colorHex|null)
WS.Renderer.addMarker(id, type, x, y) / removeMarker(id) / clearMarkers()
WS.Renderer.setPlacementCursor(type|null)
WS.Renderer.flyTo(x, y, dist?)                    // smooth camera move to cell
WS.Renderer.flyToZone(zoneId)
WS.Renderer.setTimeOfDay(t)
WS.Renderer.getStats() → { fps, drawCalls, triangles }
WS.Renderer.dispose()
```

## 11. UI (`src/ui/hud.js`, `src/ui/panels.js`, `src/ui/style.css`) — `WS.UI`

Overlay HTML on top of the canvas (`#app` contains `#canvas-host` and `#ui`). Style: clean, warm, slightly "field notebook / park-service signage" typography (system font stack + one Google Font optional: Inter or "IBM Plex Sans" — with fallback). Dark translucent panels with rounded corners, high contrast, keyboard accessible, ≥ 13px text. Must be usable at 1280×720 and 1920×1080; panels collapse on narrow widths.

Layout:
- **Top bar**: game title mark, `Year n · Season`, budget (`$12.0M`) + emergency fund, five outcome bars (W,E,P,F,T with tooltips explaining what feeds each), Colorado Resilience Score (big number + grade), and buttons: Overlay (none/watershed/fire/moisture/burn), Evidence Board, Log, Case Studies, Save/Load, Help.
- **Left panel "Conditions"**: this season's measurements as gauges/sparklines: snowpack (% of avg and SWE inches, shown as a range when uncertain), precipitation, temperature anomaly, reservoir storage (AF and %), soil moisture, streamflow (cfs), fire danger (5-level dial), drought category, population, water quality (turbidity/ash). Each has an ⓘ explanation of what the measurement means and why it matters. Reads directly from `state.climate`, `state.reservoir`, `state.history`.
- **Right panel "Actions"** tabs: **Projects** (cards grouped by category with cost, level, target selector for zone-targeted projects — selecting a target highlights the zone on the map via `game.highlightZone(zoneId)`; fund button disabled with reason when not affordable), **Water** (allocation sliders per sector: request AF, slider 0–100%, delivered estimate, warnings for senior rights; total available vs total requested bar; restriction level select; a note that non-consumptive uses return water), **Fire** (policy toggle managed/suppress-all with explanation, sector fuel table with thinning status, prescribed-burn scheduling), **Log**.
- **Bottom bar**: phase indicator and the primary button (`End Season ▶`), sim speed (1×/2×/4×) during Live, a live ticker (`"Fire spreading in Cameron Ridge — 1,240 acres"`), and a mini legend.
- **Modals** (Promise-based): Intro (title screen with the narrative, choose years 4/6/8, climate mode simulated/historical, seed; tutorial toggle), Event card (title, icon, text, "why this happens" line, choice buttons with cost and preview of effects), Evidence Board (6 advisor cards with portrait colour/emoji, stance chip, text, small SVG sparkline chart with threshold line; a "Decide" button), Season Report (headline numbers: inflow, deliveries table with shortages, fire/flood summary, outcome deltas with arrows, **Cause-and-effect timeline** entries listed as sentences, unlocked case study teaser), Case Study (title, year, region, summary, lesson, "linked to what you just experienced"), End screen (final score, grade, radar/bars, highlights, lessons, restart), Help (controls + how scoring works + formula).
- **Flood prep toolbar** (`startPlacement(spec)`): countdown banner ("Storm arrives in 3 days — 2.1 in forecast"), tools with icon/name/cost/remaining, emergency budget remaining, "Brace for storm" button; selected tool highlighted. Game calls `updatePlacement(spec)` after each placement.
- **Fire banner** while a fire burns: acres, threatened zones, crew focus.
- Toasts (bottom-left, auto-dismiss). Tooltip system.

API (`WS.UI`): `init(game)`, `refresh()`, `setPhase(phase, info)`, `showIntro()→Promise<{years,mode,seed,tutorial}>`, `showEventCard(card)→Promise<choiceIndex>`, `showEvidenceBoard(topic, recs, opts:{title, intro})→Promise<void>`, `showSeasonReport(report)→Promise<void>` (report shape built by Game: `{ year, season, seasonName, hydro, fire, flood, burnResult, outcomes:{before,after,delta}, timeline:[{text,kind}], unlocked:[caseId] }`), `showCaseStudy(cs)→Promise<void>`, `showEnd(summary)→Promise<void>`, `showHelp()`, `toast(text, kind)`, `ticker(text)`, `showFireBanner(info|null)`, `startPlacement(spec)→Promise<void>`, `updatePlacement(spec)`, `renderProjects()`, `renderWater()`, `renderFire()`, `renderConditions()`, `renderLog()`, `setBusy(bool)`, `flashOutcome(key)`, `tutorialStep(text, anchorSelector)→Promise` (simple coach marks; skippable).

The `game` object passed to `init` (implemented by main.js):
```js
{ state, world,
  fundProject(id, targetZoneId), setAllocation(sector, frac), setRestriction(level), setFirePolicy(policy), scheduleBurn(zoneId), cancelBurn(),
  endSeason(), setSpeed(n), setOverlay(mode), highlightZone(zoneId|null), focusZone(zoneId), focusCell(x,y),
  selectPlacementTool(type), finishPlacement(), openEvidence(topic), openCaseStudy(id), save(), load(), restart(),
  getProjectList(), getAdvisors(topic), listZones(type), formatters: WS.C.fmt }
```
UI must re-read `game.state` on every `refresh()` (state object identity can change on load/restart → always use `game.state`, never cache).

## 12. Game controller (`src/main.js`) — `WS.Game`

Boots on `DOMContentLoaded`: create world (`WS.World.generate(seed)`), state, `WS.Renderer.init`, `WS.UI.init(game)`, show intro, then run the turn loop:

```
beginSeason():
  if turn>0 && season==WINTER: year bookkeeping: budget += annualBudget (+ growth bonus), Projects.tick, Fire.updateAnnual, population growth
  Hydrology.generateSeasonClimate; Renderer.setSeason; Renderer.setWeather by climate
  scheduledTexts = Events.runScheduled → toasts/log
  Hydrology.computeDemands / computeAvailable
  State.pushHistory (pre-season snapshot)
  cards = Events.draw → for each: UI.showEventCard → apply choice → log/toast
  phase = PLAN; UI.refresh; tutorial hints on turn 0
endSeason():   (player clicks)
  phase = LIVE; UI.setPhase; Renderer.setOverlay('none') optional
  hydro = Hydrology.runSeason → animate reservoir level & river over ~3 s
  if pendingBurn: Fire.prescribedBurn → may produce escapeFire
  fire = Fire.maybeIgnite(forced?) or escapeFire → if fire: card = Events.fireResponseCard → UI.showEventCard → then loop Fire.step at (6 × speed) steps/s, Renderer.setFire each step, fire banner, elk flee; Fire.finalize → Renderer.refreshWorld
  storm: if pendingStorm due OR (burn scar acres > 300 and rng < Flood.stormRisk): phase = FLOOD_PREP → prep = Flood.prepare → UI.startPlacement (player places via clicks; game validates with Flood.canPlace, adds markers, deducts emergency budget) → phase = FLOOD → Renderer.setWeather('storm') → result = Flood.simulate; cf = Flood.counterfactual; attrib = Flood.attribute → animate frames (Renderer.showDebris per frame at 8 fps × speed; reservoir turbidity rising) → Flood.applyResult → Renderer.refreshWorld, setReservoir
  Scoring.updateOutcomes; CaseStudies.checkUnlocks
  build timeline entries (cause-and-effect explanations using real numbers from hydro/fire/flood/cf/attrib, e.g. "Your wetland restoration trapped 1,870 t of sediment and cut peak flow at Riverbend 30% (counterfactual: $4.1M damage vs $1.2M).") → state.timeline push
  UI.showSeasonReport → show any unlocked case study
  turn++ ; if turn >= years*4 → END (Scoring.finalSummary → UI.showEnd) else beginSeason()
```
Also: autosave to `localStorage['watershed.save']` at each PLAN phase; `save/load/restart`; keyboard: Space = End Season (in PLAN), 1–4 speeds, V overlay cycle, Esc closes modal. Emergency fund each storm = $2.5M + stockpile bonus + any federal grant flags. Guard all awaits with try/catch → `UI.toast('Something went wrong: …','bad')` and console.error, never a frozen UI. Expose `WS.Game` and `window.game` for debugging.

## 13. Tests

`tests/` — Node scripts, run with `node tests/<name>.test.js`; they must exit 0 and print PASS lines. A tiny loader `tests/load.js` exports `load(files[])` that reads each file and evaluates it in a shared `vm` context with `globalThis.WS` (constants/rng first). Sim tests must simulate a full 8-year game headlessly (`tests/headless.test.js` — written by the main.js author — drives the season loop without UI/Renderer using stubbed decisions and asserts: no NaN anywhere in state, storage within bounds, outcomes within 0..100, at least one fire in 8 years for seed 7, flood pipeline runs when a scar exists, serialize/deserialize round-trips).

## 14. Dev page & build

`index.html` (dev): loads three.min.js from cdnjs, `src/ui/style.css`, then all `src/**` files in the order in §0. `build.js` (Node) inlines CSS + JS into `dist/index.html` (single file, script tags in order, no external refs except the Three.js CDN script tag). Do not use `<!DOCTYPE>`/`<html>`/`<head>`/`<body>` in `dist/index.html`; start with `<title>Watershed</title>` then `<style>`, then markup, then scripts. Both pages must work.
