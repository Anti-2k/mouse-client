# Module reference

Every module the client ships, what it actually does, and the reasoning behind anything
non-obvious about how it does it. See the main [README](../README.md) for install/usage and
[ARCHITECTURE.md](ARCHITECTURE.md) for the shared mechanisms (texture cache, mangled-field
resolution, ...) several of these lean on.

The main panel lists the modules in this order. The Skin Changer and the Recorder have windows of
their own.

### Anti-Cosmetics

Forces every player's outfit and heal/boost particles back to the plain defaults, for players other
than yourself as well as yourself (toggle "Include myself" to exempt yourself). Works for every skin
in the game, including ones added after this client was last updated: the outfit field is found on a
player by asking the game's own definition registry whether a value names an outfit, with the
client's own item table used only as a fallback for the moment before that registry resolves. Never
touches the melee skin.

Two kinds of outfit are left exactly as the game draws them:

- **The ghillie suit.** Its camouflage is gameplay, not decoration, so it is never defaulted or
  recoloured.
- **A role-locked skin** — one you can't choose to wear, which is therefore stating your role rather
  than decorating you. That's the six cobalt classes, outfitClassless, and faction's Red/Blue Leader.
  Defaulting one would delete the only visible sign of what the player in front of you *is*, so it
  isn't a toggle.

The role test is a single flag on the skin itself, with no game-mode check anywhere: the game already
marks exactly those nine (and nothing else) `noDrop`, which is precisely the property that matters —
you can't drop it because it was never yours, the role handed it to you. A cobalt class outfit is
exempt because of what it is, not because of where it's worn, so ordinary skins worn in cobalt are
defaulted normally, and a skin added for some future role is covered with nothing here changing.

`teamId` deliberately isn't an exemption. It isn't a marker of a special skin — it's a restriction
("in faction mode, only Blue may wear this"), and 24 of the game's 90 outfits carry one, including
Cobalt Shell, Target Practice, Key Lime, Falling Star and Casanova Silks. Nothing is lost by
defaulting one even in a faction mode: the game draws its team patch from the player's `teamId`
directly, never from the outfit, so which side someone is on stays just as visible.

"No melee pull-out animation" skips the flourish a melee plays as it comes out: the karambit spin,
the bayonet unsheathe, the knuckle slam. "No melee idle animation" does the same for the one it plays
when you press Equip Melee (or Stow) while already holding it. Both are decoration and nothing else —
the server plays them purely to pose bones for the weapon's `deployAnimTime`/`idleAnimTime`, and
nothing about reach, cooldown or when a swing lands is tied to either (the game itself skips them
whenever any other animation is running, and a swing overwrites them). Each is its own toggle, and
both honour "Include myself" like the rest of the module.

### Null binds

Last-key-priority movement: holding one direction then tapping its opposite switches to the new one
instead of the two canceling out (survev sends `moveLeft`/`moveRight`/`moveUp`/`moveDown` as four
independent booleans, and the server's movement integration just subtracts opposing pairs), and
releasing the winner hands control back to whichever key is still held. It only ever *withholds* the
losing key of a pair you are physically holding — it never presses anything for you.

Entirely bind-index based — it watches whichever inputs are actually bound to movement, so there is
nothing to configure for "which keys" and it works the same on WASD, ESDF, or anything else. A "Log
detected move binds" button prints what it found to the console. Doesn't cover the game's own
unbound-arrow-key movement fallback if your move binds aren't the arrow keys.

### Lag smoothing

A jitter buffer for player movement. survev never predicts anything client-side: every update
restarts a lerp from the player's *previous wire position* to the new one, over a window sized from
the raw gap since the last update. A late update therefore freezes everyone at the last target and
the next one stretches the window to the whole stall (a crawl) — freeze, then crawl. This module
instead draws every player (and, with "Smooth own player", you and the camera) a small delay behind
the newest update, interpolating between updates that have actually arrived.

The delay is one update interval plus a jitter allowance: adaptive (a percentile of how late recent
updates arrived relative to the server's own fixed 33Hz send rate, plus a margin, clamped to the
min/max) or fixed. A stall longer than that is bridged by extrapolating each player's last step for up
to "Max extrapolation", then holding; when the server catches up, the drawn position eases onto the
real one over "Correction blend" instead of snapping. Teleports (respawns, re-entering view) always
snap. The FPS/ping HUD shows the current allowance as "+Nms buf".

Only player positions are buffered — loot, projectiles and gas keep the game's own interpolation, and
facing direction is left alone. Purely render-side: nothing sent to the server changes, and your own
inputs don't land any sooner.

### Puzzle helper

Outlines the next step of a bunker or vault puzzle, with a line back to the step you just pressed. As
each step is pressed, the outlined node walks forward to the new next step. Twin bunker, eye bunker,
chrysanthemum bunker, the saloon's secret door and the reserve vault. Steps further ahead and steps
already done are deliberately not drawn — the useful question at any moment is "which one now", and a
full path over a bunker floor is mostly clutter around the one node that matters. One-step "puzzles"
(the club basement's single switch) are skipped entirely: there is no sequence to remember, so there
is nothing a helper can add.

The outline and line are drawn in the game's normal, ceiling-masked render layer, so they disappear
under a roof you're not standing beneath — e.g. the clubhouse's top bunker entrance — the same way the
real switches do, instead of showing through it. Within that layer they sit above the map objects and
below the players: a puzzle piece is never drawn over its own marker (the chrysanthemum bunker's
greenhouse uses wide planters rather than the palm-sized switches every other puzzle has), while a
player standing on the piece still passes over it normally.

The solution order itself is fully derivable client-side — `shared/defs/puzzles.ts` is a tiny, static
table and the building's own def names which entry applies — but which *named* piece each real
obstacle in the world actually is isn't sent over the network at all, only "this is *a* puzzle piece
belonging to building N". This module reconstructs that mapping from the building def's own geometry
(the same 90°-step rotate-then-translate the server itself uses to place map objects) and matches
each real obstacle to the closest expected slot. Progress is read straight off each matched piece's
own networked on/off state, so a wrong-sequence reset (which the server broadcasts by switching every
piece back off) is reflected automatically with no separate error-tracking needed here.

**Puzzles that span two layers** are handled per node rather than per building. A puzzle's pieces do
not all have to sit on the puzzle building's own layer: twin bunker splits its six switches three on
the surface and three in the sublevel. Each node carries its own layer, only nodes on your current
layer are outlined, and a link between two nodes on different layers is routed through the bunker's
own opening — the enclosing Structure's stairs, picking whichever stairwell makes the shortest path.
Only the half of that route on your layer is drawn: on the surface the line runs from the last
surface switch into the stairwell, and once you're down it picks up from that same stairwell to the
next switch below.

### Health numbers

Numeric readouts on top of the game's own health and adrenaline bars. No settings of its own — the
module's own row already is the "show these numbers or not" toggle, so there's no settings chevron
on it in the panel.

### FPS / Ping

An FPS counter and a ping readout, stacked above Match timers in the same shared HUD stack, since
survev.io shows neither anywhere outside its own hidden debug HUD (dev-only, never reachable in the
shipped game). Ping comes straight off the game's own RTT measurement rather than anything measured
separately. The ping row goes red and appends a stall duration whenever more than 150ms
has passed since the last server update, and shows how much extra buffer Lag smoothing is currently
adding if that module is on, so the one readout answers both "am I lagging" and "is the smoothing
doing anything about it". A small graph plots ping over a configurable recent window (30–90s); it is
its own row in the stack rather than a canvas nested under the number, so the sparkline can be shown
with the number switched off and vice versa. Both readouts update a few times a second off a short
accumulation window rather than every rendered frame, since the underlying numbers don't change fast
enough to be worth redrawing at 60fps and it just reads as flicker.

The graph only records while you are actually in a match, and only from 100ms after the match screen
comes up. Samples taken on the menu or in the seconds after a match ends would otherwise sit inside
the graph's window as though they described play, and the very first round trip of a join is measured
against an input sent while the client is still finishing that join — it reads far above the real
connection, and since the graph scales to the tallest sample in its window, that one spike would
flatten every honest reading after it against the bottom of the canvas for the next minute.

The number itself is measured only where survev measures it — the time between sending an input
carrying a new `seq` and receiving the `UpdateMsg` that acks it — so it includes however long the
server sat on that input before its next 33Hz sync went out (up to ~30ms) and reads a little above a
raw network RTT, exactly like the graph in survev's own debug HUD. A sample only counts as the
*current* ping for 3 seconds: the game re-seqs an input at least once a second, so a longer gap means
the samples on hand describe a connection that is no longer live, and the row shows `--` rather than
a stale number that looks healthy mid-stall.

Hidden while the death/game-over screen (`#ui-stats`) is up, same as Match timers below.

### Match timers

A countdown for two events the game shows no clock for: 50v50 (Faction) mode's staggered role
promotions (Leader, Lieutenant, Marksman, Recon, Grenadier, Medic, Bugler, all within the first ~75
seconds) and Cobalt's twins bunker unlock. Renders into the same HUD stack as FPS/Ping, below both.
Cobalt's counts all the way back from the first gas circle (80s waiting + 30s moving + the 30s the
bunker itself waits) rather than only the last 30 seconds, so it is useful from early in the match
instead of appearing with half a minute left on it. Correct even when you join a match already in
progress — it reads the live gas stage's own clock rather than reconstructing one by counting
transitions from the start of the match.

The shared stack itself (`extension/src/34-hudstack.js`) is one `position: fixed` flex column,
anchored under the team HUD panel, so it holds still even as the team member list resizes;
FPS/Ping and Match timers each ask it for a row rather than owning their own positioned element.

### Skin Changer

Its own window rather than a row in the main panel, since the full per-gun version list is large;
its On/Off switch and bind keycap live in *its own* header instead (next to the ▼/▶ collapse arrow).
Search for a gun, then click a version chip under **Icon** or **World sprite** to switch to it; every
strip always ends in a **Current** chip (highlighted by default, so a fresh profile opens with
nothing reverted) that restores the game's own art. Click "Reset all to current" to clear every pick
at once. Picks persist across reloads and apply immediately — from the menu, before any match, since
PIXI's texture cache and the gun defs are both page-wide and survive every later match join. Only
you see the result: nothing about which art you picked is sent anywhere.

Reverting a gun also puts the player's **hands** where that art needs them, including the rear one —
which survev itself cannot move, since it pins that hand to an animation bone. This client offsets
it by nudging the hand sprite inside its bone-driven container, which the game never writes to, and
only for players actually holding the reverted art (`applyRearHands` in `extension/src/20-skins.js`).
Where the art sits against the hands is the one thing the historical defs can't answer, so those
values were measured against the running game with `extension/dev/gui-tune.js` — a slider window
that **`manifest.json` deliberately does not load**; add it to the `js[]` array if you ever need to
measure another gun. See [SKINS.md](SKINS.md).

A pick follows a gun everywhere it is drawn: on the ground, in a player's hands, and in the HUD's
weapon slots. That last one isn't a sprite at all — the slots are DOM `<img>` elements pointing
straight at the icon's `.svg` file, so the texture-cache swap can't reach them and they're
redirected separately (`setHudOverride` in `extension/src/20-skins.js`). The "rare loot" pickup
banner uses a CSS background image and is deliberately left alone.

Reverting isn't just a texture swap: each historical version can carry a snapshot of that gun's own
tint/scale/hand-and-magazine-position from survev's `gunDefs.ts` at that point in time (see
`extension/src/20-skins.js`'s file header), so a gun that used to share a plain, colourless capsule
sprite with several others comes back in its correct historical colour and size rather than survev's
*current* tint painted onto old art. That def-patching needs `extension/src/15-defs.js` to resolve
the game's own gun-def registry asynchronously; it degrades gracefully to an art-only swap if that
never resolves. Each chip previews the real result rather than the raw art: the version's own tint
baked in, and — for the DP-28, M249 and QBB-97 — the magazine overlay composited onto the body at the
position that version's def puts it, the same assembly the game performs. The sprite data is tagged
to a specific survev.io build, shown in the main panel's footer, which flags amber if the live game
has moved past it.

> **Data status:** `extension/src/14-skins-data.js` covers **40 guns** — 29 retired world sprites
> (20 survev.io-era, 9 surviv.io-era) and 15 retired loot icons across 14 guns. The surviv.io-era
> art (2018–2019), which predates survev's repository, was recovered from archived game bundles and
> sprite captures via the Wayback Machine.
>
> That file is **generated** — it is rebuilt from the asset library under `assets/` by
> `tools/gen-skins-data.py` (dev-only, needs Python 3.9+, not shipped with the extension). Edit the
> assets and re-run the script rather than editing the data file by hand. See [SKINS.md](SKINS.md)
> for the full per-gun version table, what couldn't be found, and how to add a version, and
> [`assets/sprites/README.md`](../assets/sprites/README.md) for every sprite's tint, scale, hand
> offset and magazine placement, plus provenance.

### Recorder

Records the tab to a video file and saves it through Chrome's own downloads, so it lands in your
Downloads folder on Windows and Linux alike (or wherever Chrome is set to save, or a Save-as dialog if
Chrome is set to ask). It records exactly what's on screen, client windows included if they're open.
Like the Skin Changer it's its own window, shown and hidden with the rest by Right Shift. The keycap in
its header is the record hotkey, unbound by default, and the hotkey or the **Record** button starts and
stops a recording. While one runs, the button lights up with the elapsed time and file size.

The first recording after the page loads opens Chrome's "share this tab" prompt, with this tab
already picked; leave "Also share tab audio" ticked to get game sound. After that the tab stays shared
until you reload or click Chrome's own **Stop sharing**, so later recordings start without asking.
Chrome shows its blue border and sharing bar for as long as the tab is shared. Stop sharing
mid-recording saves what was recorded so far, and the next recording asks again.

Starting a recording closes every client window, then waits half a second so the first frame doesn't
catch them half-closed. Pressing the hotkey again inside that half second calls the start off.
Stopping doesn't reopen them. To keep the client's effects out of a video, turn **Client enabled**
off before you start. The recorder isn't a module, so the master switch never stops it and its hotkey works while
the client is off.

Files are named after their start time (`survev-2026-09-29_21-14-03.mp4`), which is a valid name on
every OS. The format is H.264 MP4 with AAC audio on Windows and macOS, and Opus audio on Linux, where
Chrome has no AAC encoder. It uses the `avc3` flavour of H.264 rather than the usual `avc1`: Chrome's
MP4 writer stores an `avc1` stream's frame size only in the file header, so resizing the window or
toggling fullscreen mid-recording left the rest of the file undecodable in testing, while `avc3`
switches size cleanly. Chromium builds without H.264 fall back to WebM. **Resolution** (a maximum: a
larger tab is scaled down to fit, keeping its shape), **Frame rate** and **Bitrate** apply from the next
recording on.

## Turning everything off

Two separate switches, for two different situations.

**Client enabled** is the On/Off switch in the main panel's header: a master switch over all modules
at once, with its own bindable hotkey in the keycap beside it (unbound by default, like every other
bind here). Turning it off runs each individually enabled module's own cleanup, so anything a module
has changed is properly undone rather than merely frozen on screen, and turning it back on restores
exactly the set that was on before. Per-module switches are never written while it's off, so nothing
is forgotten: rows that are switched on stay lit in a muted colour while it's off, and the panel
footer reads `Off`, so the state is never ambiguous. The [Recorder](#recorder) isn't a module and
keeps running either way.

**The kill switch** is for when a game update breaks something badly enough that you want the
extension not to run at all. Load survev.io with `?nomouse` on the URL
(`https://survev.io/?nomouse`), or run `localStorage.setItem('mouseDisable', '1')` in the console, to
get the completely unmodified game with this extension fully inactive. Remove the query param / clear
that key to turn it back on. Unlike the master switch this is decided before the game bundle is even
patched, so it needs a reload either way.
