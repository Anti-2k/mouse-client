# Troubleshooting

What to check when survev.io ships an update and something in the client stops working. Most of
this client's leverage comes from duck-typing the live game bundle (see
[ARCHITECTURE.md](ARCHITECTURE.md)), so a game update that renames or restructures something is the
main way this client breaks — not a bug in the traditional sense.

Check the console for `[mouse]` lines first. On a working page you should see a run of them, among
them `[mouse] bundle evaluated (2/2 anchors patched)` and `[mouse] gui mounted (Right Shift to
toggle)`, and — once a match has started — `[mouse] gun defs resolved (...)` and `[mouse] map defs
resolved (...)`.

A patch anchor going quiet usually looks like:

```
[mouse] patch anchor missing: addPIXIObj -> renderer (game may have updated)
```

That means the method's minified shape changed. Open the new bundle (`survev.io/js/*.js`) and search
for `addPIXIObj(` or `getPlayerById(` to see how the signature shifted, then update the matching regex
in `extension/src/00-loader.js`'s `PATCHES` array. If only one of the two anchors still matches, the
extension keeps working — they're deliberately redundant.

If the GUI's footer says "Waiting: ..." forever instead of "Ready", that's `extension/src/10-ctx.js`
failing to find one of `playerBarn`/`inputBinds`/`activePlayer` by shape; the missing one is named
right there in the footer. Open `resolve()` in that file and check whether the shape check (which
fields it looks for) still matches the live bundle.

If Anti-Cosmetics stops defaulting outfits, check for `[mouse] gun defs resolved` in the console: the
module leaves outfits alone entirely until the game's own def registry has resolved, rather than
deciding on incomplete information. If that line is there, look at `readNetData` in `10-ctx.js`, which
expects an object carrying both an `outfit`-classified and a `backpack`-classified string field at
once — a game update that restructures the player object could change what that lands on.

If items stop being recognized, the static table in `extension/src/13-items.js` is out of date. Run

```sh
bun tools/fetch-survev.ts        # clone or re-pin survev-pinned/ to MOUSE.TARGET.build
bun tools/check-item-table.ts
```

The check imports the pinned checkout's own definitions and names every item that is missing,
mis-categorized or no longer in the game, and prints the per-category counts the table's comments
quote. Then update `ITEM_CATEGORY` by hand to match each item's declared `type` field (resolving skins
through their base item where the skin itself has no explicit type). The symptoms of a stale table are
quiet rather than loud, which is why the check is worth running on every update rather than waiting
for a report.

If Lag smoothing stops having any effect (players move exactly as they do with it off), check the
console for a `lag smoothing: resolved Player visual-position field` line. It finds `m_visualPos` as
the field four places before the unmangled `posInterpTicker` in `client/src/objects/player.ts`'s
class-field order, and counts updates through an accessor on the unmangled `Game.lastUpdateTime`; a
game update that reorders those Player fields or renames either unmangled one makes the module fall
back to the game's own interpolation rather than break anything. It also reads raw positions through
`ctx.netPos` in `10-ctx.js`, which finds netData's position field by agreement with the camera.

If Null binds stops working, re-check the `Input` enum at the top of `10-ctx.js` against
`shared/gameConfig.ts`: the four movement entries have to land on exactly the indices the game uses.

If the main panel's footer tag turns amber, the live game has moved past the survev.io build
`MOUSE.TARGET`/`extension/src/14-skins-data.js` are tagged to (its tooltip shows the live build) — a
chosen skin can still look wrong (or right, by luck) either way, since the underlying sprite might
have been redrawn again since. Update `TARGET` in `extension/src/00-loader.js`, add the gun's old art
and `worldImg` values to the asset library under `assets/`, then re-run `python
tools/gen-skins-data.py` — do **not** hand-edit `14-skins-data.js`, it is generated and your edit will
be overwritten. See [SKINS.md](SKINS.md) for the per-gun table of known sprite/icon changes and the
full step-by-step for adding one. Nothing else in the client depends on a specific build the way the
skin data does.

See [LIMITATIONS.md](LIMITATIONS.md) for scope boundaries that aren't bugs.
