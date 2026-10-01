# Retired gun world sprites — surviv.io + survev.io

Every gun here is shown as it looked **before** its world sprite was replaced. 29 guns across both eras,
in one flat folder: 9 from surviv.io (2018–2019) and 20 from survev.io (2025–2026). No gun key appears
twice, so `<gun_key>__v1.svg` is unambiguous — the `era` column in `manifest.tsv` says which era each
belongs to.

Nothing here is current art. Icons are not covered except for the two guns whose loot icon changed in the
same update as the sprite.

## Layout

```
sprites/
├── README.md
├── manifest.tsv              30 columns x 29 guns — every worldImg field, era-tagged
├── <gun_key>__v1.svg         29 sprites: tinted + scaled, on their era-correct frame
├── <gun_key>__v1__mag.svg    3 second textures (DP-28, QBB-97, M249)
├── icons/                    2 loot icons (MP220, Saiga-12)
└── defs/
    ├── gun-defs-verbatim__surviv.js     the 9 minified surviv.io defs
    ├── gun-defs-verbatim__survev.ts     the survev.io defs
    ├── gun-long-01__surviv-2018.svg     untinted base templates, per era
    ├── gun-short-01__surviv-2018.svg
    ├── gun-med-01__surviv-2018-reconstructed.svg   [reconstruction — see Caveats]
    ├── gun-m249-bot-01__surviv-2018.svg
    ├── gun-long-01__survev-v0.1.1.svg
    ├── gun-med-01__survev-v0.1.1.svg
    └── gun-short-01__survev-v0.1.1.svg
```

## Where each era's data comes from

**survev.io (20 guns)** — a single anchor: commit `6ab329ee46c1e2a2b42aee56bee1e34b73913edd` on
`github.com/leia-uwu/survev`, version **v0.1.1** (June 6, 2025), the last release before survev's first
gun-art change. That one snapshot is the correct "before" state for all 20, including guns not resprited
until v0.2.x or v0.3.0, because those later updates only edited `gunDefs.ts` and reused art already
present. Defs from `shared/defs/gameObjects/gunDefs.ts`, art from `client/public/img/guns/`.

**surviv.io (9 guns)** — no single anchor works, because each gun was resprited in a different update.
Each is read from the last archived bundle before its own change:

| Gun | Resprited in | Def read from bundle | Bundle date | Days before |
|---|---|---|---|---|
| MP220 | v0.6.0 — Sep 7, 2018 | `app.73fa5b5e.js` | 2018-09-06 | 1 |
| AWM-S | v0.6.7 — Nov 29, 2018 | `app.155bc364.js` | 2018-11-22 | 7 |
| M1 Garand | v0.6.7 — Nov 29, 2018 | `app.155bc364.js` | 2018-11-22 | 7 |
| M249 | v0.6.7 — Nov 29, 2018 | `app.155bc364.js` | 2018-11-22 | 7 |
| M4A1-S | v0.6.7 — Nov 29, 2018 | `app.155bc364.js` | 2018-11-22 | 7 |
| USAS-12 | v0.6.71 — Dec 6, 2018 | `app.15adfe9c.js` | 2018-12-05 | 1 |
| Saiga-12 | v0.7.1 — Feb 22, 2019 | `app.8c9b4367.js` | 2019-02-11 | 11 |
| FAMAS | v0.7.8 — Jun 7, 2019 | `app.86dd2275.js` | 2019-06-06 | 1 |
| DEagle 50 | v0.8.8 — Dec 2, 2019 | `app.7dbf9b57.js` | 2019-11-23 | 9 |

Bundles are archived surviv.io builds from the Wayback Machine; art is Wayback captures of
`surviv.io/img/guns/*.svg`. A useful cross-check falls out of the dates: the **2018-12-05 bundle still
shows USAS-12 on the shared base template**, a week *after* v0.6.7 gave AWM-S / Garand / M249 / M4A1-S
dedicated art — independently confirming USAS-12 was not in that batch and changed separately at v0.6.71.

## The frame difference between the eras — read this first

The two eras use the **same drawings on different canvases**, and mixing them up will misplace the gun.

In 2018 every `-01` template shipped on a shared **16 x 127** canvas with the capsule occupying only part
of it:

| Template | Canvas | Capsule | Capsule occupies y | Padding |
|---|---|---|---|---|
| `gun-long-01` (2018) | 16 x 127 | 14 x 92 | **4 → 96** | 1 left/right, 4 top, 31 bottom |
| `gun-short-01` (2018) | 16 x 127 | 14 x 48 | **48 → 96** | 1 left/right, 48 top, 31 bottom |
| `gun-med-01` (2018, reconstructed) | 16 x 127 | 14 x 64 | **32 → 96** | 1 left/right, 32 top, 31 bottom |

Every template is 14 wide at x = 1, and **every one ends at y = 96** with an identical 31-unit tail. That
padding is not slack, it is the registration: the templates are bottom-aligned so the *grip end* lands at
a fixed point no matter how long the barrel is, and length differences show up entirely as empty space at
the **top**.

survev later re-cropped those same drawings to their bare bounding boxes — 14 x 92, 14 x 62, 14 x 48 —
which discards the shared registration. So a survev-era template **cannot** be substituted into a
surviv-era recreation and sit correctly. Files here use their own era's frame, which is why every
surviv-era sprite below has a `frame` taller than its `capsule`, while every survev-era one has the two
equal.

## None of the 29 had unique art

All 29 were shared white/grey capsule templates, given identity purely by `gunDefs` — a tint, a
non-uniform scale, a hand offset and a recoil value. That is exactly what the resprites replaced: v0.6.7
"Community collage" is when AWM-S, M1 Garand, M249 and M4A1-S first got art of their own.

| Template | Used by |
|---|---|
| `gun-long-01` | AWM-S, M1 Garand, M249, M4A1-S, USAS-12, Saiga-12, AN-94, BAR M1918, DP-28, QBB-97, M1014, M1100, Model 94, Mosin-Nagant, SCAR-H, Scout Elite, L86A2, SV-98, SVD-63, BLR 81, Mk45G, SPAS-12 |
| `gun-med-01` | FAMAS, MP220, Vector (9mm), Vector (.45 ACP) |
| `gun-short-01` | DEagle 50, Peacemaker, Flare Gun |

## Only two colours actually render

Each template's drawn `<rect>` carries `clip-path` pointing at a `<clipPath>` whose child rect has the
*same geometry* and a mid-grey `fill` (`#515151` long, `#818181` short, `#8f8f8f` med).

Per the SVG spec a `<clipPath>` child contributes **geometry only** — its `fill` and `stroke` are ignored
and never painted. So that mid-grey is dead paint in the file. What the self-clip actually does is cut
away the *outer* half of the drawn rect's stroke, leaving a hard inner outline.

The rendered sprite is therefore exactly two colours:

- **body** — template `fill` (`#fdfdfd` long, `#ffffff` med/short) x the gun's tint
- **inner outline** — template `stroke` `#4b4b4b` x the gun's tint, at half its nominal 2.117 width

The mid-grey is still tinted in the output files for fidelity to the originals, but it does not show.

## How each `<gun>__v1.svg` was built

The era-correct base template with:

1. **The tint multiplied into every `fill`/`stroke`** — `worldImg.tint`, applied per channel as
   `out = round(base * tint / 255)`, which is what a PIXI sprite tint does (a multiply, not an overlay).
2. **`scale.{x,y}` baked into a wrapping `<g transform="scale(x,y)">`**, with the outer `<svg>`
   width/height updated to match. `scale.x` is `0.5` for all 29; `scale.y` is what sets length.

So opening any file shows the actual in-game look — correct colour, correct proportions, correct frame.

## Full parameter table

`worldImg` verbatim. *Frame* is the whole authoring canvas scaled; *capsule* is just the visible drawn
shape. Both are SVG units x scale.

For the surviv.io set the two differ, because all three 2018 templates draw their capsule on a shared
16 x 127 canvas with 31px of dead space below it — **only the capsule column is what renders.** The atlas
packed the drawing at its bounding box (survev v0.1.1's shipped manifest has the identical drawing as a
tight 28 x 184), so `tools/gen-skins-data.py` crops that padding off; leaving it on anchors the gun a
capsule's-worth of empty frame away from the player's hand. See **Framing** in `docs/SKINS.md`.

Double these numbers for in-game container units: the game draws at `frame * scale * 0.5` and the frames
the atlas ships are 2x these source files (a player is 35 units across, for reference).

### surviv.io era

| Gun | Ammo | Base | Tint | scale (x, y) | Frame | Capsule | Left hand | Recoil | Replaced |
|---|---|---|---|---|---|---|---|---|---|
| MP220 | 12gauge | med-01 | `#331a00` | 0.5, 0.45 | 8 x 57.15 | 7 x 28.80 | 0 | 1.33 | v0.6.0 |
| AWM-S | 308sub | long-01 | `#232804` | 0.5, 0.505 | 8 x 64.14 | 7 x 46.46 | +5.6 | 2.66 | v0.6.7 |
| M1 Garand | 762mm | long-01 | `#261412` | 0.5, 0.485 | 8 x 61.60 | 7 x 44.62 | +3.5 | 1.66 | v0.6.7 |
| M249 | 556mm | long-01 | `#373735` | 0.5, 0.525 | 8 x 66.68 | 7 x 48.30 | +11.2 | 1.33 | v0.6.7 |
| M4A1-S | 556mm | long-01 | `#c1ac7f` | 0.5, 0.45 | 8 x 57.15 | 7 x 41.40 | +2.9 | 1.30 | v0.6.7 |
| USAS-12 | 12gauge | long-01 | `#d8d8d8` | 0.5, 0.425 | 8 x 53.98 | 7 x 39.10 | +4.0 | 1.50 | v0.6.71 |
| Saiga-12 | 12gauge | long-01 | `#232323` | 0.5, 0.435 | 8 x 55.25 | 7 x 40.02 | +4.2 | 1.33 | v0.7.1 |
| FAMAS | 556mm | med-01 | `#998869` | 0.5, 0.53 | 8 x 67.31 | 7 x 33.92 | +5.6 | 1.33 | v0.7.8 |
| DEagle 50 | 50AE | short-01 | `#e1b43f` | 0.5, 0.54 | 8 x 68.58 | 7 x 25.92 | 0 | 1.00 | v0.8.8 |

### survev.io era

| Gun | Ammo | Base | Tint | scale (x, y) | Frame = capsule | Left hand | Recoil | Replaced |
|---|---|---|---|---|---|---|---|---|
| AN-94 | 762mm | long-01 | `#2d2d2d` | 0.5, 0.46 | 7 x 42.32 | +2.85 | 1.33 | v0.1.2 |
| BAR M1918 | 762mm | long-01 | `#4d4c52` | 0.5, 0.52 | 7 x 47.84 | +6.8 | 1.40 | v0.1.2 |
| DP-28 | 762mm | long-01 | `#1a1a1a` | 0.5, 0.53 | 7 x 48.76 | +8.4 | 1.33 | v0.1.2 |
| Flare Gun | flare | short-01 | `#ff5400` | 0.5, 0.4625 | 7 x 22.20 | 0 | 1.00 | v0.1.2 |
| M1014 (Super 90) | 12gauge | long-01 | `#565038` | 0.5, 0.44 | 7 x 40.48 | +4.8 | 1.33 | v0.1.2 |
| QBB-97 | 556mm | long-01 | `#1e1e1e` | 0.5, 0.425 | 7 x 39.10 | +8.4 | 1.33 | v0.1.2 |
| Peacemaker | 45acp | short-01 | `#c4c4c4` | 0.5, 0.52 | 7 x 24.96 | 0 | 1.00 | v0.1.31 |
| M1100 | 12gauge | long-01 | `#2e442e` | 0.5, 0.435 | 7 x 40.02 | +7.0 | 1.33 | v0.1.31 |
| Model 94 | 45acp | long-01 | `#a06120` | 0.5, 0.5175 | 7 x 47.61 | +3.2 | 2.33 | v0.1.31 |
| Mosin-Nagant | 762mm | long-01 | `#331a00` | 0.5, 0.52 | 7 x 47.84 | +2.8 | 2.33 | v0.1.31 |
| SCAR-H | 762mm | long-01 | `#9b7b48` | 0.5, 0.435 | 7 x 40.02 | +2.8 | 1.33 | v0.1.31 |
| Scout Elite | 556mm | long-01 | `#32363b` | 0.5, 0.52 | 7 x 47.84 | +2.8 | 2.33 | v0.1.31 |
| Vector (9mm) | 9mm | med-01 | `#897960` | 0.5, 0.5 | 7 x 31.00 | +7.0 | 0.89 | v0.1.31 |
| Vector (.45 ACP) | 45acp | med-01 | `#897960` | 0.5, 0.5 | 7 x 31.00 | +7.0 | 0.89 | v0.1.31 |
| L86A2 | 556mm | long-01 | `#dcc8a7` | 0.5, 0.46 | 7 x 42.32 | **−3.0** | 1.66 | v0.2.0 |
| SV-98 | 762mm | long-01 | `#658947` | 0.5, 0.4925 | 7 x 45.31 | +2.8 | 2.33 | v0.2.0 |
| SVD-63 | 762mm | long-01 | `#1c1c1c` | 0.5, 0.56 | 7 x 51.52 | +8.0 | 2.00 | v0.2.0 |
| BLR 81 | 762mm | long-01 | `#472706` | 0.5, 0.53 | 7 x 48.76 | +6.4 | 2.75 | v0.2.1 |
| Mk45G | 45acp | long-01 | `#353535` | 0.5, 0.47 | 7 x 43.24 | +4.2 | 1.66 | v0.2.1 |
| SPAS-12 | 12gauge | long-01 | `#2d4251` | 0.5, 0.4 | 7 x 36.80 | +4.9 | 1.33 | v0.3.0 |

Within the surviv.io set the capsule lengths order M249 > AWM-S > Garand > M4A1-S > Saiga-12 > USAS-12 >
FAMAS > MP220 > DEagle 50, matching the real firearms' relative lengths — a good sign the values are read
correctly. Vector 9mm and Vector .45 ACP are byte-identical: same template, tint, scale and offset.

### `leftHandOffset` schema

`leftHandOffset` shifts the left-hand grip container along the gun's local x-axis so it lands on the
correct part of the generic model. `y` is 0 for all 29, and L86A2 is the only **negative** value.

surviv.io wrote it as a bare scalar (`leftHandOffset: 5.6`); survev uses the object form
(`{x: 5.6, y: 0}`). The migration happened between Jun and Nov 2019 — the DEagle def, read from the Nov
2019 bundle, already uses the object form while the other eight surviv-era defs are scalars. Same
meaning. `recoil` is a shot-animation multiplier, not a spatial value. No gun here sets `handsBelow`.

### `right_hand_x` - not a survev value

The rear hand has no def field: survev pins it to an animation bone for every gun there is. The extension
implements an offset for it anyway (`applyRearHands` in `extension/src/20-skins.js`), and this column
feeds it. Only two rows use it, both `-8`: **QBB-97 and FAMAS**, the two guns whose live def carries a
`gunOffset` pulling the whole gun 8 units back toward the player. The gun moves and the bone-pinned hand
does not, so the hand needs the same shift to stay over the grip. Measured in game with
`extension/dev/gui-tune.js`; blank for every other gun.

## Two-component guns

Three of the 29 compose from a second texture via `worldImg.magImg`, layered relative to the gun origin:

| Gun | Era | Body | Overlay | Overlay canvas | Shipped frame | Position | Layer |
|---|---|---|---|---|---|---|---|
| M249 | surviv | `gun-long-01` tinted `#373735` | `gun-m249-bot-01` | 38 x 63 (36 x 20 drawn) | 72 x 40 | x 0, y −16.5 | below the hands |
| DP-28 | survev | `gun-long-01` tinted `#1a1a1a` | `gun-dp28-top-01` | 34.62 x 34.62 | 70 x 70 | x 0, y −22.5 | **`top: true`** — above the hands |
| QBB-97 | survev | `gun-long-01` tinted `#1e1e1e` | `gun-qbb97-bot-01` | 64 x 32 | 64 x 32 | x −1.5, y −14.25 | below the hands |

All three overlays carry **no tint** (`magImg` has no `tint` field), so they are copied verbatim and must
**not** be tinted a second time — which is why they are already coloured rather than white: M249's is an
olive-brown ammo box (`#5d5644` on `#111110`), DP-28's a dark circle (`#181818` on `#080808`) for the pan
magazine, QBB-97's a dark rounded box (`#1e1e1e`). DP-28 is the only one drawn *above* the hands.

Negative `y` moves the overlay toward the muzzle, in the same units as `leftHandOffset`. The overlays stay
separate files rather than being composited onto the body, because that is how the game assembles them:
`Gun.setType` (`client/src/objects/player.ts`) anchors the body at the **bottom centre** of its frame and
the overlay at its frame's **centre**, on `magImg.pos`, at a hardcoded `0.25` scale that is *not* read
from the def.

Two consequences the *Shipped frame* column above exists for. The overlay's scale being hardcoded means
each one has to be emitted at the size the game's own atlas ships — the QBB-97's has always shipped at 1x,
and doubling it drew that magazine at twice its size. And because the overlay is centred rather than
corner-anchored, padding inside its canvas slides it along the barrel: the 2018 M249 box sits in the top
third of a 38 x 63 canvas, so it is cropped to its 36 x 20 drawing first.

## Loot icons

26 of the 29 changed only their world sprite. Two exceptions are in `icons/` — both were still on a
*generic shared* icon matching their generic shared sprite, and both had icon and sprite replaced in the
same update:

| Gun | Old icon id | Became |
|---|---|---|
| MP220 | `loot-weapon-soshotgun.img` | `loot-weapon-mp220.img` at v0.6.0 |
| Saiga-12 | `loot-weapon-autoshotgun.img` | `loot-weapon-saiga.img` at v0.7.1 |

Icons are 128 x 128, `scale: 0.3`, border `loot-circle-outer-01.img`. Every gun def in both eras carries
`lootImg.tint: 0x00ff00`, an identical value across the whole file dating back to 2018 — legacy, not
meaningful art data.

## Caveats

1. **`gun-med-01.svg` was never captured in the surviv.io era** — affects **FAMAS and MP220 only**. The
   Wayback Machine holds the *legacy* `gun-med.svg` (18 x 64, Feb 2018) but no `gun-med-01.svg` from
   2018–2019. `defs/gun-med-01__surviv-2018-reconstructed.svg` rebuilds it from that legacy drawing — an
   identical rect (`3.704 x 16.933`, `rx 2.469`, `ry 3.836`, `#ffffff` on `#4b4b4b`) — placed on the
   16 x 127 frame, bottom-aligned at y = 96 like the other two, at the standard `3.7797` factor every
   2018 template uses. survev's modern `gun-med-01.svg` squashes y to `3.66149` (62 rather than 64), the
   only template deviating from `3.7797`, so that squash looks like a later re-export and was not carried
   back. `defs/gun-med-01__survev-v0.1.1.svg` is there to compare. `[flagged: reconstruction]`
2. **surviv.io template captures are from April 2018** (`gun-long-01` / `gun-short-01` @ 2018-04-15,
   `gun-m249-bot-01` @ 2018-04-07). For the 2018 guns that is within weeks. For **FAMAS (Jun 2019),
   Saiga-12 (Feb 2019) and DEagle 50 (Nov 2019)** it assumes the template was unchanged in between. The
   capture is byte-stable across every crawl through Dec 2018 and the same drawing survives at survev
   `HEAD`, so the *artwork* certainly persisted — only the exact 2019 *canvas* is unverified.
   `[flagged: assumption]`
3. **Byte-identical earlier captures exist.** The 2018-04-03 template files are Inkscape-authored and the
   2018-04-15 ones are minified equivalents of the same drawing (verified attribute by attribute; they
   differ only in a `-0.99946563` → `-1` rounding). The minified ones are used, since those shipped.
4. **AWM-S's loot icon was never archived** and is not included; see
   `assets/organised/reference/awm-s-notes.md`.

## Reproducing

```sh
# survev era
git clone --filter=blob:none --no-checkout https://github.com/leia-uwu/survev.git
git -C survev show 6ab329ee46c1e2a2b42aee56bee1e34b73913edd:shared/defs/gameObjects/gunDefs.ts
git -C survev show 6ab329ee46c1e2a2b42aee56bee1e34b73913edd:client/public/img/guns/gun-long-01.svg

# the frames that build actually shipped (sourceSize per sprite id) - this is
# what the crop/out values in tools/gen-skins-data.py are checked against
git -C survev show 6ab329ee:client/atlas-builder/out/high.json |
  python -c 'import json,sys; f=json.load(sys.stdin)["loadout"][0]["frames"]; print({k:v["sourceSize"] for k,v in f.items() if k.startswith("gun-")})'

# surviv era
grep -o 'awc:{[^}]*worldImg[^}]*}[^}]*}' app.155bc364.js
curl 'https://web.archive.org/web/20180415165329id_/http://surviv.io/img/guns/gun-long-01.svg'
```

Raw untouched snapshots stay in `assets/og-surviv-guns/` (Wayback captures plus a `manifest.tsv` of CDX
digests) and `assets/og-survev-guns/` (the v0.1.1 repo state). `assets/organised/` holds the earlier
cross-era working library. This folder is derived from those three, not a fresh scrape. Change dates come
from `survev-gun-sprite-icon-changelog.md` in the repo root.
