# Skin Changer data

Everything about the retired gun art the Skin Changer can revert to: where it comes from, what is
covered, and — the part you'll actually come back for — **how to add a gun when survev.io reskins one
in the future**.

Current data: **40 guns** — 29 retired world sprites (20 survev.io-era, 9 surviv.io-era) and 15 retired
loot icons across 14 guns. Tagged to survev.io build `6d25af64` (v0.4.3).

---

## How the data is produced

```
assets/sprites/    manifest.tsv + defs/*.svg (untinted templates) + *__mag.svg
assets/icons/      retired loot icons
        │
        │   python tools/gen-skins-data.py
        ▼
extension/src/14-skins-data.js      ← GENERATED, do not hand-edit
```

`extension/src/14-skins-data.js` is **generated**. Edit the asset library and re-run the script; a hand
edit will be silently destroyed the next time anyone regenerates.

```sh
python tools/gen-skins-data.py                 # sprites + icons
SKINS_ICONS=0 python tools/gen-skins-data.py   # sprites only (isolates the loot path)
```

Needs Python 3.9+, no packages. There is still no build step for the extension itself — this script is
dev-only tooling and is not shipped.

### Why the shipped art is untinted

None of the 29 retired world sprites is unique art. Every one of those guns shared one of **three
colourless capsule templates** (`gun-long-01`, `gun-med-01`, `gun-short-01`) and got its identity purely
from `gunDefs` — a tint, a non-uniform scale, a hand offset, a magazine position. A resprite is the moment
a gun stopped sharing a capsule and got a model of its own.

So the data ships the **untinted, unscaled template** plus a `def` snapshot, not finished art:

- the extension applies colour through PIXI (`imgDef.tint`, `20-skins.js`)
- the game applies size through its own `worldImg.scale`

Shipping pre-coloured, pre-sized art *and* a `def` would double-apply both — the gun renders too dark and
too small. This is also why the data file is smaller than it looks: 29 guns share just **9 SVG strings**,
hoisted into consts at the top of the file.

`assets/sprites/*__v1.svg` (as opposed to `assets/sprites/defs/*.svg`) **are** pre-tinted and pre-scaled.
They exist for previewing the art in a browser. Never feed them to the generator.

### Framing: `crop` and `out`

The `.svg` files that survive in the repos and archives are *authoring canvases*, not the frames the game
draws. Both eras' atlas builders packed each drawing at its **bounding box**, at roughly twice the size of
the source file. survev v0.1.1 ships its built atlas manifest (`client/atlas-builder/out/high.json` at
commit `6ab329ee`), which states the shipped frame for every id outright:

| sprite id | shipped frame | source `.svg` |
|---|---|---|
| `gun-long-01.img` | 28 × 184 | 14 × 92 |
| `gun-med-01.img` | 28 × 124 | 14 × 62 |
| `gun-short-01.img` | 28 × 96 | 14 × 48 |
| `gun-dp28-top-01.img` | 70 × 70 | 34.6 × 34.6 |
| `gun-m249-bot-01.img` | 72 × 40 | 38 × 63 (36 × 20 of drawing) |
| `gun-qbb97-bot-01.img` | 64 × 32 | 64 × 32 — **already 1×** |

That table is the whole ball game for placement, because of *where* the game anchors things
(`client/src/objects/player.ts`, `Gun.setType`):

- the gun body is anchored at the **bottom centre** of its frame, at the hand
- a magazine overlay is anchored at its frame's **centre**, on `magImg.pos`

So transparent padding in a frame is not slack — it pushes the art off the hand, or off the barrel, by
exactly that much. Each template in the generator therefore carries two values:

- **`crop`** — the drawing's bounding box `(x, y, w, h)` in the source file's own units, for a file that is
  a larger canvas. All three surviv.io-era templates draw their capsule on a shared 16 × 127 frame,
  bottom-aligned at y = 96, leaving 31px of dead space *underneath*; the 2018 M249 ammo box is 36 × 20 of
  drawing on a 38 × 63 canvas.
- **`out`** — the frame size the game ships, from the table above.

Both are applied with a `viewBox`: the templates carry literal `width`/`height` and (mostly) no `viewBox`,
and `svgToTexture` (`20-skins.js`) sizes its canvas from those literal attributes, so the generator writes
`viewBox="<crop>"` and sets `width`/`height` to `out`. A file that already has a `viewBox` can't be cropped
this way (its crop box would be in the wrong units) and the generator refuses rather than emit bad art.

Get the frames right and **every `def` number is its era's `gunDefs` value used verbatim** — `tint`,
`scale`, `leftHandOffset` and `magImg.pos` are all in the game's own container units, which never changed
when the art was redrawn at 2×. Nothing is scaled by anything.

> This is what the *old* `RENDER_SCALE` knob got wrong. It doubled the source art (right, for most of it)
> but also doubled `magImg.pos` and `leftHandOffset` (wrong — absolute units), and doubled the QBB-97's
> magazine, which had always shipped at 1×. Combined with the uncropped 2018 canvases, that produced the
> "gun floats away from the player" gap on every surviv.io-era gun and put the DP-28's pan at the muzzle.

One value is deliberately **not** reverted: `gunOffset`. It shifts the whole gun container relative to the
hand (`setType` adds it to the fixed `-4.25`), and two guns carry one today — QBB-97 and FAMAS, both `-8`.
No historical def has one, and survev introduced the QBB-97's in the same commit as its dedicated art
(`3efad98e`), so on paper the right historical value is `0`. In the running game that reads as the gap bug
all over again: barrel, magazine and all slide 8 units out from the hand together. The live value stays.

That distinction is worth keeping straight when reading a def, because the two offsets do different
things: `gunOffset` moves **the gun**, while `leftHandOffset` moves only the **left hand sprite** along
it. The gun itself hangs off the *right* hand bone (`handRContainer`), so `leftHandOffset` never changes
where a gun sits — only where the supporting hand lands on it.

### `rightHandOffset` — a field the game doesn't have

survev has no rear-hand offset: that hand is pinned to the animation bone at `(14, 12.25)` for every gun
there is. Reverted art doesn't put its grip where the modern art does, though, so the gun's rear end can
end up poking out from under a hand that ought to be covering it, and no def value moves it.

This client adds one. `handRSprite` is positioned exactly once, at construction, and the game never writes
to it again — it only ever sets that sprite's texture, scale, tint and visibility. The bone animation and
the shot recoil both move the *container*, so an offset written on the sprite inside it rides along with
them rather than fighting them. `applyRearHands` in `20-skins.js` does that each frame, and
`worldImg.rightHandOffset` carries the value: an invented key that survev ignores, which lets it be
snapshotted, patched and reverted exactly like a real def field.

Who it applies to is decided by what is actually being drawn — a player's gun barrel texture is looked up
among the overrides this module installed, so the offset only lands while the reverted art is really on
screen, and a player holding the modern gun is never touched.

`manifest.tsv` carries it in the optional `right_hand_x` column. Two guns need it so far - **QBB-97 and
FAMAS, both `-8`** - and they are exactly the two whose live def has a `gunOffset` pulling the gun 8 units
back toward the player: the gun moves, the bone-pinned hand does not, so the hand has to be given the same
shift to stay over the grip. Everything else leaves the column blank and nothing is emitted.

### The tuning tool

Those three values are the one part of a revert that history can't answer. Every other number describes
the art itself (its frame, colour, size); these describe where the art sits against the hands, and old art
with different proportions can need different numbers than any def recorded. They get measured against the
running game with **`extension/dev/gui-tune.js`** - a window with a slider per value, which applies over
whatever version is picked and shows the live numbers to read off.

It is **not shipped**: `manifest.json` does not load it. To use it, add `"dev/gui-tune.js"` to that file's
`js[]` array just before `"src/99-boot.js"` and reload the extension. It works through a single hook,
`MOUSE.skins.tuneHook` (see `applyTune` in `20-skins.js`), so the shipped client carries nothing of it but
one property read.

It is a measuring tool, not a second source of truth. Fold whatever you land on back into
`assets/sprites/manifest.tsv` (`left_hand_x`, `right_hand_x`) or, for a `gunOffset`, into the generator,
re-run it, and clear the tuning.

---

## What's covered

### World sprites

| Gun | id | Era | Retired in | Base template | Magazine |
|---|---|---|---|---|---|
| MP220 | `mp220` | surviv.io | v0.6.0 — 2018-09-07 | `gun-med-01` | — |
| AWM-S | `awc` | surviv.io | v0.6.7 — 2018-11-29 | `gun-long-01` | — |
| M1 Garand | `garand` | surviv.io | v0.6.7 — 2018-11-29 | `gun-long-01` | — |
| M249 | `m249` | surviv.io | v0.6.7 — 2018-11-29 | `gun-long-01` | yes (`gun-m249-bot-01.img`) |
| M4A1-S | `m4a1` | surviv.io | v0.6.7 — 2018-11-29 | `gun-long-01` | — |
| USAS-12 | `usas` | surviv.io | v0.6.71 — 2018-12-06 | `gun-long-01` | — |
| Saiga-12 | `saiga` | surviv.io | v0.7.1 — 2019-02-22 | `gun-long-01` | — |
| FAMAS | `famas` | surviv.io | v0.7.8 — 2019-06-07 | `gun-med-01` | — |
| DEagle 50 | `deagle` | surviv.io | v0.8.8 — 2019-12-02 | `gun-short-01` | — |
| AN-94 | `an94` | survev.io | v0.1.2 — 2025-07-23 | `gun-long-01` | — |
| BAR M1918 | `bar` | survev.io | v0.1.2 — 2025-07-23 | `gun-long-01` | — |
| DP-28 | `dp28` | survev.io | v0.1.2 — 2025-07-23 | `gun-long-01` | yes (`gun-dp28-top-01.img`) |
| Flare Gun | `flare_gun` | survev.io | v0.1.2 — 2025-07-23 | `gun-short-01` | — |
| M1014 (Super 90) | `m1014` | survev.io | v0.1.2 — 2025-07-23 | `gun-long-01` | — |
| QBB-97 | `qbb97` | survev.io | v0.1.2 — 2025-07-23 | `gun-long-01` | yes (`gun-qbb97-bot-01.img`) |
| M1100 | `m1100` | survev.io | v0.1.31 — 2025-12-13 | `gun-long-01` | — |
| Model 94 | `model94` | survev.io | v0.1.31 — 2025-12-13 | `gun-long-01` | — |
| Mosin-Nagant | `mosin` | survev.io | v0.1.31 — 2025-12-13 | `gun-long-01` | — |
| Peacemaker | `colt45` | survev.io | v0.1.31 — 2025-12-13 | `gun-short-01` | — |
| SCAR-H | `scar` | survev.io | v0.1.31 — 2025-12-13 | `gun-long-01` | — |
| Scout Elite | `scout_elite` | survev.io | v0.1.31 — 2025-12-13 | `gun-long-01` | — |
| Vector (9mm) | `vector` | survev.io | v0.1.31 — 2025-12-13 | `gun-med-01` | — |
| Vector (.45 ACP) | `vector45` | survev.io | v0.1.31 — 2025-12-13 | `gun-med-01` | — |
| L86A2 | `l86` | survev.io | v0.2.0 — 2026-01-18 | `gun-long-01` | — |
| SV-98 | `sv98` | survev.io | v0.2.0 — 2026-01-18 | `gun-long-01` | — |
| SVD-63 | `svd` | survev.io | v0.2.0 — 2026-01-18 | `gun-long-01` | — |
| BLR 81 | `blr` | survev.io | v0.2.1 — 2026-02-02 | `gun-long-01` | — |
| Mk45G | `mkg45` | survev.io | v0.2.1 — 2026-02-02 | `gun-long-01` | — |
| SPAS-12 | `spas12` | survev.io | v0.3.0 — 2026-05-11 | `gun-long-01` | — |

"Retired in" is the update that *replaced* this art — the version chip's date is when the art stopped
being used, not when it started.

### Loot icons

| Gun | id | Versions | Retired | Sprite |
|---|---|---|---|---|
| Mosin-Nagant | `mosin` | v1 | 2018-06-06 | `loot-weapon-mosin.img` |
| MP220 | `mp220` | v1 | 2018-09-07 | `loot-weapon-mp220.img` |
| AK-47 | `ak47` | v1, v2 | 2019-01-31 | `loot-weapon-ak.img` |
| Saiga-12 | `saiga` | v1 | 2019-02-22 | `loot-weapon-saiga.img` |
| M870 | `m870` | v1 | 2019-10-08 | `loot-weapon-m870.img` |
| G18C | `glock` | v1 | 2026-03-09 | `loot-weapon-glock.img` |
| Dual G18C | `glock_dual` | v1 | 2026-03-09 | `loot-weapon-glock-dual.img` |
| M416 | `hk416` | v1 | 2026-03-09 | `loot-weapon-hk416.img` |
| MAC-10 | `mac10` | v1 | 2026-03-09 | `loot-weapon-mac10.img` |
| MP5 | `mp5` | v1 | 2026-03-09 | `loot-weapon-mp5.img` |
| UMP9 | `ump9` | v1 | 2026-03-09 | `loot-weapon-ump9.img` |
| OT-38 | `ot38` | v1 | 2026-03-09 | `loot-weapon-ot38.img` |
| Dual OT-38 | `ot38_dual` | v1 | 2026-03-09 | `loot-weapon-ot38-dual.img` |
| M39 EMR | `m39` | v1 | 2026-09-25 | `loot-weapon-m39.img` |

Icons carry **no `def`** — they are full-colour art, and `lootImg`'s tint/scale/border never changed. They
are a pure texture swap, which is why they were the part that worked first try.

MP220 and Saiga-12 are the only two guns whose icon and sprite were replaced in the *same* update, so they
appear in both tables.

---

## Adding a gun after a future reskin

This is the whole workflow. Say survev ships v0.4.0 and the changelog says "Updated Groza world image."

### 1. Confirm it is a real art change

Version numbering rule: **`v1` is a gun's first artwork; a new version only exists when the drawing
actually changed.** A file that was re-exported, re-cropped, minified, or committed twice on the same day
is *not* a new version. Compare the actual drawing — geometry, fills — not the file bytes or the commit
date. Several apparent "versions" in survev's git history are just SVG optimiser passes.

Also check it is not a no-op: if the "old" art is byte-identical to what the game ships today, the chip
would do nothing and the gun should not be added.

### 2. Grab the art from before the change

For a **survev.io-era** change, use the repo:

```sh
git clone --filter=blob:none --no-checkout https://github.com/leia-uwu/survev.git
git -C survev log --oneline -- client/public/img/guns/gun-groza-01.svg
git -C survev show <commit-before>:client/public/img/guns/gun-groza-01.svg > gun-groza-01.svg
git -C survev show <commit-before>:shared/defs/gameObjects/gunDefs.ts | grep -A20 'groza:'
```

For a **surviv.io-era** change (2017–2020), the repo does not go back that far — use archived game bundles
and sprite captures from the Wayback Machine. `assets/sprites/README.md` documents the exact bundles and
capture timestamps that were used, and the gotchas (late-2019 bundles arrive gzipped from the `id_`
endpoint; several sprites were never captured at all).

You need two things: the **art** and the **`worldImg` block** from that same point in time.

### 3. Add it to the asset library

- If the gun was on a shared capsule, no new SVG is needed — the three templates in `assets/sprites/defs/`
  already cover it. Only if it had unique art do you add a file.
- Add a row to `assets/sprites/manifest.tsv`. The columns the generator reads are: `era`, `gun_key`,
  `display_name`, `ammo`, `base_texture`, `tint_dec`, `scale_x`, `scale_y`, `left_hand_x`, `left_hand_y`,
  `mag_sprite`, `mag_pos_x`, `mag_pos_y`, `mag_top`, `replaced_in`, `replaced_date`.
- For a loot icon, drop the SVG into `assets/icons/` as `<gun>__v1.svg` and add a row to `ICON_MAP` in the
  generator.

### 4. Point the generator at today's sprite name

Add the gun to `CURRENT_WORLD` in `tools/gen-skins-data.py`:

```python
"groza": "gun-groza-01.img",
```

**This must be the name the game uses *now*, not the historical one.** The swap works by replacing an entry
in PIXI's global texture cache, so the key has to match what the live game asks for. When a gun goes from
a shared capsule to unique art its sprite name changes, and it is the *new* name you need here. QBB-97 is
the cautionary example: its overlay was renamed `gun-qbb97-bot-01` → `gun-qbb97-top-01` upstream.

For a two-texture gun, also add entries to `MAG_TEMPLATES` (with the overlay's `crop` and `out` — see
**Framing**) and `MAG_CURRENT`.

### 5. Regenerate, re-tag, verify

```sh
python tools/gen-skins-data.py
```

Update `MOUSE.TARGET` in `extension/src/00-loader.js` to the new build first — the generator reads the tag
block from there, and the GUI footer turns amber when the live game has moved past it.

Then reload the extension, refresh survev.io, and check the console for:

```
[mouse] skin data loaded (N guns, tagged ...)
[mouse] gun defs resolved (<chunk>.js)
```

**The second line is not optional.** Without it `MOUSE.gameDefs` never resolved, the def patcher is inactive,
and the untinted template renders under the gun's *current* tint — usually a white capsule. Every visual
judgement is meaningless until that line appears. See `extension/src/15-defs.js`.

Then in game: pick up the gun, select the version, and check colour, length, hand position, and — for a
magazine gun — that the overlay sits right and is **not** tinted. The Skin Changer window's own chips are
a first check without joining anything: each one composites body and magazine exactly the way the game
does, so an overlay that is the wrong size or in the wrong place shows up there too.

If the gun sits away from the hand, or the magazine is off, suspect the **frame** before the def — see
**Framing** above, and check `crop`/`out` against the shipped atlas manifest rather than the `.svg`.

---

## Gotchas

- **`sprites[]` index 0 is the body and takes the tint; index 1+ is a magazine overlay and is never
  tinted.** The overlays ship already-coloured; tinting them twice is wrong. `player.ts` hardcodes
  `gunMag.tint = 0xffffff`.
- **`svgToTexture` ignores `viewBox` when sizing its canvas** — it reads the literal `width`/`height`
  attributes and defaults to 128×128 if they are missing. Any SVG you add must carry both.
- **Do not put gameplay stats in `def`.** `recoil` is captured in the manifest but deliberately never
  emitted: this is a cosmetic revert, not a gameplay one.
- **`leftHandOffset` must be `{x, y}`.** surviv.io wrote it as a bare scalar in 2018, but the live modern
  def is an object and that is what gets patched.
- **Version labels are the persistence key.** Picks are stored by label string, so renaming `v1` → `v2`
  silently repoints everyone's saved pick at different art. Add new labels; don't renumber existing ones.
- **A `def` change only reaches a drawn gun through `Gun.setType`.** `refreshLiveSprites` repoints
  `texture` and `tint` and nothing else, so scale, hand offset and magazine position would otherwise sit
  stale until the player next switched weapons. `20-skins.js` flags every player's `visualsDirty` after a
  def patch, which makes the game re-run `updateVisuals` → `setType` on its next frame.
- **A sprite's frame is its atlas frame, not its `.svg` canvas.** See **Framing** above. The symptom of
  getting this wrong is spatial, not visual: the art looks right but sits at the wrong distance — a gap
  between the hand and the gun, or a magazine sliding toward the muzzle.

## Known gaps

- **Winter variants are not covered.** SV-98 and SVD-63 have `-02` sprites alongside their `-01`; only the
  `-01` is swapped, so the winter skin stays current art.
- **`gun-med-01.svg` was never captured in the surviv.io era.** It affects FAMAS and MP220 only. The
  template in `assets/sprites/defs/gun-med-01__surviv-2018-reconstructed.svg` is rebuilt from the legacy
  `gun-med.svg` drawing on the era's 16×127 frame. Flagged as a reconstruction, not a capture.
- **surviv.io template captures are from April 2018.** For FAMAS (Jun 2019), Saiga-12 (Feb 2019) and
  DEagle 50 (Nov 2019) this assumes the template was unchanged in between. The artwork is byte-stable
  across every crawl through Dec 2018 and survives to survev `HEAD`, so only the exact 2019 canvas is
  unverified.
- **AWM-S's loot icon was never archived** and is not included.
- **Guns that never had unique art have nothing to revert.** Eight guns still use a shared capsule today
  (G18C, Dual G18C, M416, MAC-10, MP5, OT-38, Dual OT-38, UMP9) — their sprite has never changed, so they
  appear under Icon only.
- Melee weapons, throwables, gear and outfits are out of scope entirely.

## Provenance

`assets/sprites/README.md` is the authority on where every file came from: source commits, Wayback capture
timestamps and CDX digests, per-gun tint/scale/hand/magazine parameters, the two eras' differing sprite
frames, and which entries are flagged as inference rather than capture.
`survev-gun-sprite-icon-changelog.md` in the repo root is the compiled changelog all the dates come from.
