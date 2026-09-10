# Watershed

A Colorado water-resilience simulation game. You are the water-resilience director of the fictional Bitterbrush Creek watershed: a snow-fed tributary of the Colorado River with a reservoir, a mountain town, four farms, forests that haven't burned in a century, and neighbours with senior water rights. Each season you read real measurements, fund projects, allocate a shrinking supply, live with fire, and then watch what the watershed does with your choices — including post-fire storms that carry ash and mud into the reservoir.

Play it: https://claude.ai/code/artifact/a1074db5-7d22-45d7-bb86-5b53e17404a4

## Run locally

```bash
python3 dev/serve.py 8765
# open http://localhost:8765/index.html   (dev, loads src/ files)
# open http://localhost:8765/dist/index.html   (single-file build)
```

Three.js r128 is loaded from cdnjs; everything else is vanilla JS/CSS with no build tooling.

## Build and test

```bash
node build.js                  # inlines src/ into dist/index.html
for t in tests/*.test.js; do node "$t" || break; done
```

`tests/headless.test.js` plays complete 8-year games without a browser and asserts no NaN, bounded storage, outcomes in range, fires, floods, save/load round-trips, and historical mode.

## Architecture

See `SPEC.md`. Modules attach to a single `WS` namespace and load in this order:

- `src/core` — constants, seeded RNG + simplex noise, event bus
- `src/world/terrain.js` — deterministic 128×128 world: mountains, creek, reservoir, dam, forest sectors, town, farms, wetland, D8 drainage
- `src/sim` — state, hydrology (acre-feet water balance, senior rights), fire (cellular spread), flood (post-fire runoff and sediment routing with mitigations and counterfactuals), projects, event cards, advisors, scoring, case studies
- `src/render` — Three.js "living diorama": faceted terrain, water, instanced trees/buildings/wildlife, fire/weather/debris effects, overlays, custom camera
- `src/ui` — HUD, panels, modals, flood-prep toolbar
- `src/main.js` — turn loop, cause-and-effect timeline, save/load, headless driver

Scoring: `R = 0.25W + 0.20E + 0.20P + 0.20F + 0.15T` (water security, ecosystem health, public safety, food & economy, public trust).
