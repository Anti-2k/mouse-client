# Architecture

How survev.io's bundle behaves under the hood, and the mechanisms the client is built on top of.
This is the "why is it written this way" document — for what each module actually does, see
[MODULES.md](MODULES.md); for what to check when a game update breaks something, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## How it works

survev.io ships a single minified JS module per release. Digging into the production bundle
(verified against the live site, not just the GitHub source) turned up the load-bearing facts below.

- **Only properties prefixed `m_` are name-mangled.** Everything else — `playerPool`,
  `getPlayerById`, `addPIXIObj`, `container`, `bodySprite`, `isBindPressed`, `isBindDown`, and so on —
  survives minification with its real name intact. That's what makes duck-typing the game's internals
  (see `extension/src/10-ctx.js`) hold up release to release, as long as the *names* don't change.
- **Inside the ordinary, masked layers, depth is the def's own `zIdx`.** An `Obstacle` renders at
  whatever `img.zIdx` its def declares (10 for the indoor furniture that puzzle switches and planters
  are), loot at 13, a player at 18, and anything at 50 or above gets 100 added on top of that so trees
  and smoke clear bunker interiors. `16-overlay.js`'s one drawing surface, `MOUSE.overlay.above`, sits
  at 16 inside that masked space: above the object it marks (being drawn under the thing you are
  pointing at defeats the point — the chrysanthemum bunker's wide planters used to swallow the Puzzle
  helper's outline exactly that way) and below whoever is standing on it. Because it is in the masked
  layer, it disappears under a roof the same way the world does; nothing this client draws shows
  through a ceiling.
- **Every sprite resolves through `PIXI.Texture.from("<name>.img")` against one global texture
  cache**, not a per-match one. The Skin Changer (`extension/src/20-skins.js`) swaps a cache entry to
  redirect every future lookup, then walks the live render tree once to repoint any sprite already on
  screen — the override survives new matches for free (`Game.init()` never touches PIXI's cache) and
  needs no per-tick upkeep.

`extension/src/00-loader.js` intercepts the game's single `<script type="module">` tag at
`document_start` (before it can execute), fetches its real text, inserts two capture calls at method
definitions that match the non-mangled names above, and re-injects the patched text as a blob module.
Everything else in `extension/src/` is built on whatever that capture hands back. The two anchors
(`addPIXIObj` → the renderer, `getPlayerById` → the player barn) are deliberately redundant: either
one alone is enough to bootstrap everything downstream.

**The game's own definitions are reachable without another patch.** The gun and map-object def
registries live in a chunk the entry bundle imports, not in the entry bundle itself. ES module imports
are cached per resolved URL for the whole document, so a second `import()` of that same chunk URL from
`15-defs.js` hands back the very instance the game is using. That is how `MOUSE.gameDefs` (guns,
outfits, ...) and `MOUSE.mapDefs` (obstacles, buildings) are found. PIXI's `Graphics` and `Texture`
classes are tree-shaken out of every export, so they are taken off live objects instead — the
renderer's own `ground`/`layerMask` graphics and a player's body sprite.

**Matches don't survive a page refresh, but the client does.** `Game.init()` builds a brand new
renderer, player barn, and UI manager on every single match join, and `Game.free()` tears them down
when it ends — only the outer `Game` object and the input-bind handler live for the whole page
session. `extension/src/10-ctx.js` never caches the subsystem *objects* themselves; it caches which
(mangled) property name on `game` held them the first time, then keeps reading `game[thatName]` fresh
every frame, which automatically follows whatever the *next* match's `Game.init()` assigns there. The
overlay rebuilds its graphics the same way, via `ctx.onRendererChange`, which fires once per new
match.

**Anything this client parents into the game's display tree is destroyed with it.** `Game.free()`
empties the whole PIXI stage with `destroy({children: true})`, and so does `LoadoutDisplay.free()`
(the menu character has a `Renderer` of its own, which is why this happens when you *start* a match as
well as when one ends). That takes the shared overlay's Graphics with it. A destroyed PIXI object
keeps its identity but has its internals nulled out, so `clear()` on one throws — and nothing
announces the destruction, while `ctx.ready` stays true for a few frames afterwards because the freed
subsystems are all still hanging off `game`. So no file here trusts a display object it created on a
previous frame: `16-overlay.js` checks liveness every frame (`MOUSE.overlay.isAlive`) and rebuilds on
the spot, and it refuses to hand objects to a `Renderer` whose own layer containers have been
destroyed.

**The game's *own* sprites are destroyed by that same sweep, and they stay reachable afterwards.**
`Game.free()` destroys every player's sprites along with the rest of the stage, but the player barn
holding those players is only replaced by the *next* match's `Game.init()` — so from the moment a
match ends until another one starts, `ctx.playerBarn` still lists last match's players with every
sprite on them already dead. Anything that writes to *or reads* a game-owned display object each frame
has to run the same liveness check the client's own objects get: `20-skins.js` moves `handRSprite` to
place the rear hand on reverted gun art, and a plain `if (!sprite.position)` guard is not enough,
because PIXI's `position` is a getter off the `transform` that `destroy()` nulls — *reading* it to
check it is itself what throws. The check lives on `ctx` as `ctx.displayAlive(obj)`
(`!obj.destroyed && obj.transform`).

**`ctx.ready` staying stale-true between matches is invisible for a PIXI-sprite module, but not for
one that owns plain DOM.** The HUD readouts (`33-hud.js`, `35-nethud.js`, `36-timerhud.js`) write to
their own plain `<div>`s outside the PIXI stage entirely, which survive a `Game.free()` untouched, so
without an extra check they'd keep showing the last match's frozen health/ping/timer numbers over the
main menu. `ctx.inGameScreen()` is that extra check: `client/src/main.ts`'s App toggles
`#game-area-wrapper` between `display: none` on the menu and `display: block` the instant a match is
actually joined, so reading that one computed style is a direct, always-current answer to "is the
match screen up right now" — independent of anything cached off `game`.

**One module throwing doesn't stop the others.** `12-modules.js` drives every enabled module's
`onTick` from one shared frame callback. Each module ticks inside its own try/catch, so a throw in one
can't abort the loop for every module registered after it, and the throw is reported with the
module's id, rate-limited to one line every five seconds because anything that throws in a frame
callback throws sixty times a second.

**Input isolation is a fixed set of always-installed listeners, not ones added and removed as things
happen.** survev.io's own input handler listens on `window` in the *bubble* phase, so a permanent
capture-phase listener per event type (checking a plain flag rather than being added/removed) is what
`extension/src/31-gui.js` uses for bind capture and the Right Shift toggle — there is no listener to
leak. The same file also uses Pointer Events with `setPointerCapture` for panel dragging, so releasing
the mouse button outside the browser window still ends the drag instead of leaving the panel stuck
following the cursor. A module hotkey never swallows its key: binding a module to a key the game also
uses does both.

**The client only ever withholds input, never raises it.** `10-ctx.js` wraps the game's
`isBindPressed`/`isBindDown` once, and the only thing the wrap can do is make an input read as *not*
held. Null binds needs that answered continuously — "is this input not held, right now, for as long as
I say so", which `isBindDown` gets asked dozens of times a frame by the game's own update pass — so
`ctx.suppressInput` is level-triggered: a module re-asserts it every tick for as long as the
suppression should hold, and every flag is cleared at the top of the next frame, so a module that stops
asserting (disabled, threw) lets go within one frame with no teardown path. `ctx.rawBindDown` reads the
player's genuine hold state underneath, so Null binds never sees its own output. Everything is keyed
on the game's `Input` enum indices rather than on keys, so it works with any bindings.

**A player's drawn position is one field everything downstream reads, and its lerp restarts from the
wrong place.** `client/src/objects/player.ts`'s `m_updateData` restarts a lerp on every update from
the player's *previous wire position* (`m_pos`) — not from where they are currently drawn — to the new
one, over `camera.m_interpInterval`, which `client/src/game.ts` rewrites every `UpdateMsg` to the raw
wall-clock gap since the previous one. A late update freezes the lerp at its target and the next one
crawls over the whole stall. Widening that interval makes it worse, not better: each update then lands
before the lerp finishes and jumps the drawn position forward, a constant sawtooth. Lag smoothing
instead puts an accessor on each Player's `m_visualPos` — found as the field four before the unmangled
`posInterpTicker`, since the build keeps class-field order — and serves its own buffered position from
it, so the camera, `Player.render` and the overlay follow without further hooks. Updates are indexed
through an accessor on the unmangled `Game.lastUpdateTime`, which `m_processGameUpdate` assigns once
per message *before* applying it — the only way to keep each of several updates that land between two
frames. The server sends exactly one update per 33Hz net-sync and only includes players that moved, so
an update's index is a jitter-free clock and a missing player means "didn't move". The raw wire
position each player is filed under comes from `ctx.netPos`, which finds netData's mangled position
field by agreement with the camera.

**Ping is the game's own measurement, read off unmangled fields.** `client/src/game.ts` declares
`seq`, `seqSendTime`, `pings`, `lastUpdateTime` and `updateIntervals` without an `m_` prefix, and
computes ping itself when an `UpdateMsg` acks the seq it last sent. `17-net.js` reads those arrays as a
*bucket*, not a log — the game sorts and empties both every 20 seconds for its own console dump — so it
only ever tracks a length and keeps its own ring buffers for the HUD's graph and stall math.

**A puzzle's solution order is static shared code; which real obstacle is which named piece is not.**
`shared/defs/puzzles.ts` and each building's own `puzzle`/`mapObjects` def are ordinary
client-reachable data — no server round-trip needed to know a twin bunker's order is scout, sniper,
medic, demo, assault, tank. But `shared/net/objectSerializeFns.ts` only ever sends an obstacle's
`isPuzzlePiece` flag and its `parentBuildingId`, never the piece's own name, so the Puzzle helper
recomputes each named piece's expected world position from the building def's local offsets and
nearest-matches real obstacles to those slots. Progress then falls out for free: a piece's own
networked `onOff` state is true once pressed, and the server's own wrong-sequence reset flips every
piece back to `onOff: false` and bumps its `button.seq`. Two catches: piece names aren't unique within
a puzzle (the reserve vault has two "2" switches, and its order presses "2" twice), so progress has to
claim individual pieces rather than test names; and the server culls obstacles outside the player's
view rect (`server/src/game/client.ts`, `delObjIds`), which a building as tall as the saloon exceeds,
so pressed state has to be remembered across culling — with a changed `seq` on a piece that reads off
as the sign a reset happened while it was out of view.

**An outfit's own flags say everything about it; the game mode says nothing.**
`shared/defs/gameObjects/outfitDefs.ts` marks role-granted skins `noDrop` — exactly nine of them, the
six cobalt classes plus outfitClassless and the two faction leader skins — and that flag *is* the
property worth testing: you cannot drop it because it was never yours, the role handed it to you. One
flag on the skin replaces checking the mode and then the outfit, and covers a future role's skin for
free. `teamId` looks similar and is not: the def file's own comment calls it a restriction ("in
faction mode, the skin will only work for the specified ID"), and 24 of the game's 90 outfits carry
it, ordinary shop skins like Cobalt Shell and Target Practice among them. It needs no special case even
in a faction mode, because `client/src/objects/player.ts` draws the team patch for every non-ghillie
player from `playerInfo.teamId` and never from the outfit — so defaulting a faction skin costs no
information. The ghillie suit is the other outfit with a flag that carries meaning (`ghillie`), and
Anti-Cosmetics leaves it alone entirely.

**`Anim.DeployMelee` and `Anim.IdleMelee` are decoration with no gameplay attached.**
`server/src/game/weaponManager.ts`'s `playMeleeDeployAnim` (on drawing a melee) and
`playMeleeIdleAnim` (on pressing Equip Melee or Stow while already holding one) both decline to play at
all if any other animation is running, and all either one does is pose bones for the weapon def's
`deployAnimTime`/`idleAnimTime`. Turning either into `Anim.None` as it reaches
`Player.prototype.playAnim` is therefore the whole of Anti-Cosmetics' two melee-flourish options —
passing the sequence number through untouched, which is what keeps `data.animSeq != this.anim.seq`
agreeing with the server about what has been seen.

**Chrome's MediaRecorder MP4 is fragmented, with gaps.** It writes `ftyp`, a `moov` with empty sample
tables and a `trex` per track, then one `moof`+`mdat` per second or so, each `moof` holding a `traf`
per track (`tfhd` default-base-is-moof, a 64-bit `tfdt`, and a `trun` with per-sample durations and
sizes). The `tfdt`s leave small gaps between fragments that the durations don't cover, so rewriting
samples into different fragments has to take each duration from the next sample's time. The video is
`avc3` Constrained Baseline with SPS/PPS both in the `avcC` and in-band. Chrome's software H.264
encoder (OpenH264, the one WebCodecs gets on Linux) has a quality floor it won't go below whatever
bitrate it's asked for, but it scales frames to its configured size by itself, and it doesn't support
`bitrateMode: "quantizer"`.

## Project layout

```
extension/
  manifest.json          MV3, world: "MAIN", document_start, survev.io only
  jsconfig.json          editor type-checking (checkJs) over the plain-JS source, no build step
  src/
    00-loader.js         intercepts + patches + re-injects the game bundle
    10-ctx.js            duck-types the game's subsystems; input suppression; drives the shared frame tick
    11-config.js         schema-driven settings persistence (localStorage)
    12-modules.js        module registry: enabled state, binds, settings lifecycle, master switch
    13-items.js          item -> category table (hand-maintained)
    14-skins-data.js     gun skin version data - GENERATED by tools/gen-skins-data.py, see docs/SKINS.md
    15-defs.js           resolves MOUSE.gameDefs/MOUSE.mapDefs/MOUSE.pixi (the game's own def
                         registries and PIXI classes) via the chunk re-import trick
    16-overlay.js        shared world-space PIXI.Graphics surface for the puzzle helper
    17-net.js            MOUSE.net.stats: ping/stall telemetry off ctx.game's own non-mangled fields
    20-skins.js          skin changer: the texture-swap engine
    21-cosmetics.js      anti-cosmetics
    22-nullbinds.js      last-key-priority movement
    23-lagsmooth.js      jitter buffer for player positions (absorbs late updates/stalls)
    24-puzzles.js        outlines a bunker/vault puzzle's next step, across layers
    30-gui-css.js        the GUI stylesheet, built from survev's own menu button/panel kit
    31-gui.js            the click GUI - window factory, input hardening, main panel
    32-gui-skins.js      the skin changer's own window
    33-hud.js            health/adrenaline numeric readouts
    34-hudstack.js       shared vertical HUD row stack, anchored under #ui-top-left
    35-nethud.js         FPS / ping readouts, in the HUD stack
    36-timerhud.js       match timers (50v50 promotions / Cobalt twins bunker), in the HUD stack
    37-recorder.js       tab recorder window - outside the module registry, so the master switch
                         never stops it; its hotkey is a 31-gui.js tool bind
    38-recompress.js     MOUSE.recompress: re-encodes a finished MP4 recording to just under the
                         recorder's size limit (WebCodecs, its own fragmented-MP4 reader/writer)
    99-boot.js           mounts the GUI once everything above has registered
  dev/
    gui-tune.js          NOT LOADED by manifest.json - sliders for the three
                         values that place a reverted gun against the hands
docs/
  MODULES.md             per-module reference - what each one does and why
  ARCHITECTURE.md        this file
  TROUBLESHOOTING.md     what to check when a game update breaks something
  LIMITATIONS.md         known scope boundaries
  SKINS.md               per-gun skin version table, what's missing, how to add a version
assets/
  sprites/               retired world sprites: untinted templates in defs/, manifest.tsv, provenance
  icons/                 retired loot icons
tools/
  gen-skins-data.py      regenerates extension/src/14-skins-data.js from assets/ (dev-only, Python 3.9+)
  fetch-survev.ts        clones survev into survev-pinned/ at MOUSE.TARGET.build (dev-only,
                         `bun tools/fetch-survev.ts`)
  check-item-table.ts    diffs 13-items.js's table against survev-pinned/'s own defs (dev-only,
                         `bun tools/check-item-table.ts`) - run it whenever MOUSE.TARGET moves
survev-pinned/           gitignored - the upstream checkout fetch-survev.ts creates
README.md                public-facing intro: what this is, install, usage
LICENSE                  GPL-3.0
```

There is no build step for the extension. Edit a file under `extension/src/`, reload the extension,
refresh the survev.io tab.
