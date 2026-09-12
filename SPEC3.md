# WATERSHED — Spec addendum v3: player avatar + advisor faces

Player feedback: "add a genuine avatar so people can choose their character's appearance and have that character carry out the tasks in the simulation; when advisors are opened I want to see their face."

All earlier rules apply (SPEC.md §0). Three agents work in parallel; APIs below are exact contracts.

## A. Faces — `src/ui/faces.js` → `WS.Faces` (new; loads before hud.js)

A deterministic 2-D portrait renderer (Canvas 2D, no images). Style: flat, friendly, slightly stylised "field-guide" portraits that match the diorama world — head-and-shoulders, warm outline, two-tone shading, no gradients.

```js
WS.Faces.OPTIONS = {
  skin:   [ {id:'s1', hex:'#f6d3b8'}, {id:'s2', hex:'#e8b894'}, {id:'s3', hex:'#c98f66'}, {id:'s4', hex:'#a56a45'}, {id:'s5', hex:'#7a4a2e'}, {id:'s6', hex:'#4d2f1e'} ],
  hair:   ['short','buzz','curly','long','ponytail','bun','braids','bald','afro','wavy'],
  hairColor: [ {id:'h1',hex:'#2b1d14'}, {id:'h2',hex:'#5a3a22'}, {id:'h3',hex:'#a3652f'}, {id:'h4',hex:'#d9b06a'}, {id:'h5',hex:'#b5b5b5'}, {id:'h6',hex:'#c0392b'} ],
  eyes:   ['round','almond','narrow'],
  brows:  ['soft','straight','arched'],
  mouth:  ['smile','neutral','grin'],
  facialHair: ['none','stubble','beard','moustache'],
  glasses:['none','round','square','sun'],
  hat:    ['none','cap','widebrim','beanie','helmet','hardhat'],
  outfit: [ {id:'o1',hex:'#2f6fb3'}, {id:'o2',hex:'#c0392b'}, {id:'o3',hex:'#2e8b57'}, {id:'o4',hex:'#e2a93b'}, {id:'o5',hex:'#6b4fbb'}, {id:'o6',hex:'#444'} ],
  accessory: ['none','clipboard','binoculars','radio','scarf']
};
// spec = { skin:'s3', hair:'curly', hairColor:'h1', eyes:'round', brows:'soft', mouth:'smile', facialHair:'none', glasses:'none', hat:'none', outfit:'o1', accessory:'none' }
WS.Faces.draw(canvas, spec, opts)     // renders into the canvas (uses canvas.width/height; opts.bg hex|null, opts.expression 'neutral'|'worried'|'happy')
WS.Faces.dataURL(spec, size, opts)   // cached PNG data URL (size px square) — used for <img> portraits and 3D sprite textures
WS.Faces.random(rng|null)            // random spec (uses Math.random when rng absent)
WS.Faces.normalize(spec)             // fill defaults / fix invalid ids → always renders
WS.Faces.hexOf(kind, id)             // colour lookup for skin/hairColor/outfit
```
Must render in < 3 ms at 96 px. Faces must look distinct across the option space; hats sit on hair correctly; glasses over eyes; facial hair over skin.

## B. Advisor faces — `src/sim/advisors.js`

Add `face` (a Faces spec) to each of the six CHARACTERS so they read as their 3D figure: Dolores (helmet, dark hair, warm-brown skin, radio), Walt (widebrim hat, grey moustache, weathered skin, red outfit), Naomi (long dark hair, medium skin, turquoise accent → outfit o3 + scarf), Priya (dark bun, glasses round, white-coat outfit o6 → actually use o1 with clipboard), Marcus (short dark hair, medium-dark skin, blue hoodie o1), Ana (ponytail, sun glasses, green vest o3, binoculars). Keep everything else.

## C. Player avatar — state, UI, 3D

**State** (`state.player`): `{ name:'Director', face:<Faces spec>, title:'Water-Resilience Director' }`, set from the intro creator, serialised with saves (main.js).

**Intro creator** (`UI.showIntro()` result gains `player: {name, face}`): a "Your character" panel in the intro with a live 128-px portrait, a name input (default "Director Rivera"), option rows (skin swatches, hair, hair colour swatches, eyes, mouth, facial hair, glasses, hat, outfit swatches, accessory) as compact segmented pickers, a "Randomise" button, and 3–4 preset buttons. Remember the last spec in localStorage (guarded).

**HUD**: a portrait chip at the left of the top bar (portrait 28 px + name + title) — clicking it flies the camera to the player figure (`game.focusPlayer()`).

**Portraits everywhere a character speaks**: speech bubble (portrait 40 px replaces the emoji dot), Evidence Board cards (portrait 56 px), after-action and season report headers show the player's portrait (small), the case-study "linked to" box shows the player's portrait 28 px. `UI.portrait(spec, size) → <canvas>` helper.

**3D figure** (`props.js`): `props.setPlayer(spec, name)` builds/updates a player figure with the advisor part kit, coloured from the spec (skin → head/hands, hairColor + hair style → a simple hair cap variant: none/short/long/bun/afro, hat → helmet/cap/widebrim/hardhat/beanie mesh, outfit → body, glasses → thin dark band, accessory → clipboard/binoculars/radio prop), a name tag using the chosen name, an idle bob and walk animation. `props.movePlayerTo(x, y, opts:{run:boolean}) → Promise` walks the figure there over terrain (constant speed ~4 cells/s, run 7; resolves on arrival; a new call cancels the previous), `props.playerPosition() → {x,y}` (cell coords), `props.setPlayerAction(kind|null)` — 'point' (arm raised toward +z), 'radio' (hand to ear), 'dig' (bob faster), 'wave'; `props.playerObject()`.
A **face sprite**: the figure's head shows the actual portrait — apply `WS.Faces.dataURL(spec, 64)` as a texture on a small plane on the front of the head (billboard-free; part of the mesh) so the face is recognisably the player's.

**Renderer facade**: `WS.Renderer.setPlayer(spec, name)`, `movePlayerTo(x, y, opts) → Promise`, `playerScreenPos()`, `flyToPlayer()`.

**Builds** (`builds.js`): every `play()` first awaits `props.movePlayerTo(site, {run:true})` (cap 2.5 s: if not arrived, teleport), sets `setPlayerAction('point')` during the scene and clears it after; the player stands ~2 cells from the site facing it.

**Game wiring** (`main.js`): intro result → `state.player`; `renderer.setPlayer` on init/load/restart; PLAN phase → player at the town hall (walk); FIRE phase → player runs to an incident command post = nearest road/civic cell ≥ 8 cells from the ignition, action 'radio'; retardant/engine/dozer orders → 'point' for 1.5 s; STORM → civic core, 'radio'; flood prep → walks to the first placed mitigation; season report → player at town hall. Save/load carries `state.player`. `game.focusPlayer()`. Headless: no-ops.
