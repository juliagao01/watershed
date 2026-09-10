# WATERSHED — Spec addendum v2: real-time crises + simpler planning

Player feedback on v1: "too complex, and a little boring — there should be more action." v1 is fully working (see SPEC.md; all tests pass; browser playthrough clean). v2 keeps every v1 system but changes two things:

1. **Disasters become playable in real time.** A wildfire is no longer watched: it spreads live and the player fights it (dozer lines, air-tanker drops, engine crews, evacuations, mutual aid) with a crew-point budget. A burn-scar storm is no longer just placement-then-watch: rain starts, flood water and debris spread live, and the player throws down sandbag lines, pumps, evacuations and an emergency spillway release against the clock.
2. **Planning is moderately simplified.** Fewer things up front, the depth stays behind "More"/"Show all"/tabs.

All v1 coding rules (SPEC.md §0) still apply. Every existing API keeps working (tests in `tests/` must still pass). New APIs below are exact.

## A. Fire tactics — `src/sim/fire.js` (extend `WS.Fire`)

```js
WS.Fire.TACTICS = {
  dozer:      { name:'Dozer / hand line', icon:'🚜', costPts:1 /* per cell */, digSteps:2, desc:'Scrape a fuel break. Cells become a firebreak after 2 steps; fire almost never crosses a finished line.' },
  retardant:  { name:'Air tanker drop',   icon:'✈️', costPts:5, radius:2, cooldownSteps:8, maxUses:4, desc:'Retardant coats a 5×5 patch: spread through it drops ~85% and slowly weakens.' },
  engine:     { name:'Engine crew',       icon:'🚒', costPts:6, max:2, desc:'Station an engine in a neighborhood: fire entering it slows and only 15% of reached homes are lost.' },
  evacuate:   { name:'Evacuation order',  icon:'📢', costPts:0, desc:'Empty a neighborhood: no injuries if fire reaches it; trust dips if it never did.' },
  mutual_aid: { name:'Call mutual aid',   icon:'📞', costPts:0, costM:1.5, maxUses:1, gainPts:10, desc:'Neighboring counties send crews: +10 crew points now, $1.5M from the budget.' }
};
WS.Fire.startTactics(fireSim, state, world) → fireSim.tactics = {
  crewPts, crewMax, regenPerStep, breaks:Uint8Array(N*N) /* 0 none, 1 digging, 2 done */, digTimer:Uint8Array(N*N), wet:Float32Array(N*N) /* 0..1 retardant, decays 0.02/step */,
  engines:{zoneId:true}, evacuated:{zoneId:true}, drops:0, dropCooldown:0, mutualAidUsed:false, used:{type:count}, log:[{step,text}] }
  // crewPts start = 12 + 4×(number of fire_station buildings) ; crewMax = 30 ; regenPerStep = 0.3 (0.45 if state.fire.policy==='suppress_all')
WS.Fire.canApply(fireSim, state, world, type, target) → { ok, reason, cost }
WS.Fire.applyTactic(fireSim, state, world, type, target) → { ok, reason, cost, cells:number[] /* affected */, text }
  // target: dozer → number[] cells (cells that are burning/burned/water/road are rejected individually; charge only for accepted cells);
  //         retardant → cell index; engine/evacuate → zoneId (neighborhood); mutual_aid → null (deducts state.budget, or emergencyFund, else refused)
WS.Fire.threat(fireSim, state, world) → { acres, perimeterCells, headingDeg /* mean spread direction from wind+recent growth */, windMph, windDirRad,
  threatened:[{ zoneId, name, type:'neighborhood'|'farm'|'civic'|'forest'|'reservoir', distanceCells, burningInside:boolean }] /* sorted by distance, ≤ 6 */,
  structuresLost, structuresAtRisk /* houses within 4 cells of burning cells */, upstreamAcres, intensity:'creeping'|'active'|'running'|'extreme' }
WS.Fire.replayWithoutTactics(fireSim, state, world) → { acres, structuresLost, upstreamAcres, zoneIds }   // deterministic re-run from fireSim.seed/startCell with no tactics (do not mutate world/state)
```
`step()` changes: a cell with `breaks==2` cannot ignite and passes spread ×0.05; `digTimer` counts down each step from `digSteps` then sets `breaks=2`; `wet[i]` multiplies ignition probability by `(1 − 0.85×wet)` and decays; zones in `engines` get spread-into ×0.35 and structure loss 15%; `evacuated` zones set injuries to 0 in `finalize`. `regen` adds crew points each step (cap crewMax); `dropCooldown--`. Each `finalize` report gains `tactics: { used, cellsBroken, drops, engines:[zoneNames], evacuated:[zoneNames], mutualAid, counterfactual:{acres, structuresLost, upstreamAcres}, acresSaved, structuresSaved, injuries:0|number, unnecessaryEvacs:number }`. Make the fire *look* alive: wind gusts shift ±25° every 6–10 steps and are exposed in `threat`; `maxSteps` 45–80.

Also make fires happen more often and matter more: `seasonIgnitionChance` ×1.35 across the board, and at least one Summer per game should be "Extreme" for 3+ years games (Hydrology already varies; Fire may bump the ignition roll in a year with no fire so far: if `state.fire.fires.length===0 && state.year>=2 && season===SUMMER` then chance ≥ 0.55).

## B. Storm defense — `src/sim/flood.js` (extend `WS.Flood`)

New live tools (added to `TOOLS` with `live:true`; existing 7 pre-storm tools keep `live:false`):
```js
sandbag:  { name:'Sandbag line', icon:'🧱', costM:0.04 /* per cell */, live:true, desc:'Protects this cell and its 4 neighbours: flood threshold ×2.5. Placed before the water arrives = full effect; after = 40%.' }
pump:     { name:'Pump crew',    icon:'🔧', costM:0.15, live:true, max:3, desc:'Clears a flooded street or basement: damage on this cell ×0.4.' }
evacuate: { name:'Evacuate',     icon:'📢', costM:0, live:true, zone:'neighborhood', desc:'Empty a neighborhood: injury risk there ×0.1; trust dips if no water ever arrived.' }
spillway: { name:'Emergency release', icon:'🌊', costM:0, live:true, once:true, desc:'Open the dam gates early: the reservoir swallows the pulse (peak below dam ×0.6) but you dump 1,500 AF and farms downstream see a surge.' }
```
- `mitigations[]` entries may carry `atFrame` (frame index when placed live). `simulate` computes `arrivalFrame: Int32Array(N*N)` (first frame flow ≥ flooding threshold reached the cell; −1 never) and returns it, plus `floodTimeline: Int32Array[]` (per frame: cells that become flooded in that frame) so the renderer can show water spreading, and `floodedByFrame` count array. Live-tool effectiveness: `atFrame==null || atFrame <= arrivalFrame[cell]` → 1.0, else 0.4 (sandbag/pump). `evacuate`: injury contribution of that zone ×0.1; if no cell of the zone floods, `result.unnecessaryEvacs++`. `spillway`: peak below dam ×0.6, reservoir sediment trapping unchanged, `result.releasedAF = 1500` (applyResult deducts from storage), farm flood damage ×1.2, `result.spillwayUsed=true`.
- `placeableLive(prep, world, type) → Int32Array` for live tools (sandbag: residential/civic/farm cells with flowAcc>3 or adjacent to river/flooded-risk cells; pump: any residential/civic/farm cell; evacuate: neighborhood centres; spillway: dam cell).
- `canPlace(prep, type, i)` must accept live tools (via placeableLive).
- `result.tactics = { sandbagCells, pumps, evacuated:[zoneNames], spillwayUsed, counterfactual:{damageM, floodedHouses, injuriesRisk} /* same storm, same pre-storm mitigations, NO live tools */, damageSaved, housesSaved }`.
- Storm risk up: `stormRisk` ×1.4 (a scar should almost always get tested within 2 seasons).

## C. Renderer — `src/render/renderer.js`, `effects.js`, `scene.js`

```js
WS.Renderer.setTacticalMode(on:boolean)       // on: left-drag PAINTS cells instead of panning (right-drag/ctrl-drag still orbits, wheel zooms, WASD pans); off: v1 behaviour
WS.Renderer.onCellPaint(fn)                   // fn({ cells:number[] /* new cells since last emit, deduped */, done:boolean }) during a left-drag in tactical mode; also emits a single-cell paint on click
WS.Renderer.setFlooded(cells:number[])        // translucent blue-brown water sheets 0.05 above flooded cells (InstancedMesh, pooled 3000), rising/fading in; [] clears
WS.Renderer.playRetardantDrop(x, y, radius)   // 2 s animation: an air tanker (small merged mesh) flies over the cell along the wind, releases a pink-red spray (Points) that settles, then a persistent 'retardant' tint marker (5×5 pink translucent cells, fades over 60 s)
WS.Renderer.setFireIntensity(level 0..1)      // scales flame size/count/smoke density and the point-light (running/extreme fires must look scary: taller flames, thick smoke column, orange fog)
WS.Renderer.pulseZone(zoneId, colorHex)       // 1.2 s highlight pulse (uses setHighlight)
```
New marker types in Effects: `dozer` (brown bare-earth strip; `digging` variant = lighter with a small dozer block that vanishes when done), `retardant` (pink tint square), `engine` (red engine block with a white light), `evac` (yellow-black striped sign, blinking), `sandbag` (tan bag row), `pump` (blue box with a spinning top), `spillway` (white-water burst at the dam), `tanker` (the plane). Scene: `setControlsEnabled` already exists; add `ctx.setPanEnabled(bool)` so tactical mode can disable left-drag pan only. Props: burning houses (cells burning & residential) get a flame quad + black smoke — Effects handles by `setFire` receiving those cells; Props should turn them charred on `refresh`. Keep 60 fps: the paint handler must dedupe with a Uint8 stamp array, no allocations per move.

## D. UI — `src/ui/hud.js`, `src/ui/panels.js`, `style.css`

**Tactical HUD** (bottom-centre replacing the placement toolbar, works for both crises):
```js
WS.UI.showTactical(spec)/updateTactical(spec)/hideTactical()
spec = { mode:'fire'|'storm', title, subtitle, step, maxSteps, paused, speed, points:{label:'Crew points'|'Emergency fund', value, max, unit:'pts'|'$M'},
         tools:[{ type, name, icon, desc, cost:'1 pt/cell'|'$0.04M/cell', remaining:number|null, cooldown:number|null, selected, disabled, reason }],
         threat:{ headline /* "Fire running NE at 14 mph — Marshall Heights 6 cells away" */, rows:[{label,value,bad:boolean}], threatened:[{name,type,distance,burning}] },
         hint:'Drag on the map to cut a line' }
```
Buttons: tool select → `game.selectTactic(type)`; Pause/Resume → `game.setPaused(bool)`; speed 1×/2× → `game.setSpeed(n)`; for zone tools a `<select>` of neighborhoods → `game.applyTacticToZone(type, zoneId)`; spillway/mutual aid → `game.applyTactic(type)`. Big alarm styling: the top bar turns crisis-red/amber with a pulsing chip ("WILDFIRE — 1,240 acres" / "FLASH FLOOD — 2.2 in"), sirens icon. `UI.alert(text, kind)` — a large 2 s centre flash (e.g. "Fire has reached Marshall Heights!", "Dozer line holding") — respect reduced motion.
**After-action card** `UI.showAfterAction(report)→Promise` — for fire: acres / structures / upstream acres, "what you did" list, and the counterfactual: "Without your line and 2 drops: 4,600 acres and 11 homes. With them: 1,900 acres and 2 homes." For storm: damage/houses/injury risk vs counterfactual. One "Continue" button.

**Moderate simplification**:
- Conditions: show 6 gauges by default (snowpack, reservoir, streamflow, fire danger, drought, water quality); the rest under a "More readings" toggle (remember state).
- Water tab: 5 sliders — Households, Farms & Ranches, River & Wildlife (=wildlife), Power & Recreation (moves hydro AND recreation together), Fire Reserve (=fire). Tribal right and Colorado River delivery shown as two fixed "senior right — always delivered" rows (no slider). Keep the available-vs-requested bar. `game.setAllocation('power_rec', v)` must set both hydro and recreation (main handles).
- Projects tab: show the 8 core projects (streamgages, forest_thinning, prescribed_burn, home_hardening, wetland, irrigation, treatment, warning_system) with one-line summaries; "Show all projects" toggle reveals the rest. Details behind a "Details" disclosure (already).
- Evidence Board: never auto-opens in Winter/Spring; a pulsing "Advisors" button appears in the plan phase instead (auto-open kept before a prescribed burn and before a storm).
- Tutorial: 3 coach marks max (conditions → End Season → "when a fire starts you fight it live").
- Season report: headline stat tiles + Cause-and-effect list first; deliveries table, fire/flood detail and outcome reasons under a "Details" toggle. When a crisis happened, the after-action card already showed the detail, so the report stays short.
- Intro: default 4 years ("quick") stays selectable; keep 6 as recommended.

## E. Game loop — `src/main.js`

- **FIRE phase** (`WS.C.PHASES.FIRE='fire'` — add to constants): on ignition (or prescribed-burn escape) → `phase=FIRE`, `Fire.startTactics`, `renderer.setTacticalMode(true)`, camera to the ignition, `ui.showTactical`, `ui.alert('WILDFIRE …')`. Loop: while not done: if not paused `await sleep(520/speed)` (hidden-tab guard stays), `Fire.step`, `renderer.setFire(burning, burned)`, `renderer.setFireIntensity(...)` from `threat.intensity`, `threat=Fire.threat`, `ui.updateTactical`, alerts on first entry into a neighborhood/farm/upstream sector, ticker. Tool input: `game.selectTactic(type)`; `renderer.onCellPaint` → dozer: batch cells → `Fire.applyTactic`, add `dozer` markers (`digging` → `dozer` when done); retardant: click → apply + `renderer.playRetardantDrop`; engine/evacuate via `applyTacticToZone`; mutual aid via `applyTactic`. On done: `Fire.finalize` (includes tactics + counterfactual), `renderer.setTacticalMode(false)`, `ui.hideTactical`, `ui.showAfterAction`. The v1 `fire_response` card is no longer shown in the browser flow (headless keeps `decide.card`); `decide.tactics(fireSim, threat, step) → [{type, target}]` optional in headless.
- **STORM phase** (`PHASES.STORM='storm'`): after the pre-storm placement (unchanged, still uses `Flood.prepare`/`startPlacement`), run `first = Flood.simulate(state, world, storm, preMitigations)`; `phase=STORM`; `renderer.setTacticalMode(true)`; `ui.showTactical({mode:'storm'})`; play `first.frames` at 8 fps × speed while calling `renderer.showDebris(frame)`, `renderer.setFlooded(accumulated floodTimeline)`, `renderer.setReservoir(...)` with rising turbidity; live tools placed via paint/click/zone with `atFrame = current frame` and marker types; at the end `final = Flood.simulate(state, world, storm, pre.concat(live))` (numbers) + counterfactual/attribute as v1 → `Flood.applyResult(final)` → `ui.showAfterAction`. Spillway deducts storage in applyResult.
- Timeline entries add the tactical counterfactual sentences.
- `game.setAllocation('power_rec', v)` sets hydro+recreation; `game.getCoreProjects()` returns the 8 ids.
- Keyboard: Space = pause/resume during crises; 1–5 select tools; Esc deselects.
- `tests/headless.test.js`: add a seed run with `decide.tactics` cutting a dozer line ring around the ignition after step 3 and asserting `report.tactics.acresSaved >= 0` and finite; storm run placing sandbags with atFrame; all v1 assertions unchanged.

## F. Constants (`src/core/constants.js`) — already updated by the orchestrator
`PHASES.FIRE='fire'`, `PHASES.STORM='storm'`, `PALETTE.retardant=0xe8677a`, `PALETTE.floodWater=0x6d7f8f`, `PALETTE.sandbag=0xc9b48a`.
