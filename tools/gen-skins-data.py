#!/usr/bin/env python3
# tools/gen-skins-data.py
#
# Regenerates extension/src/14-skins-data.js from the compiled asset library
# under assets/. Not part of the shipped extension - this is a dev-only script
# for when the asset library gains a gun, a version, or an icon.
#
# Usage:
#   python tools/gen-skins-data.py
#
# Requires Python 3.9+. Rewrites 14-skins-data.js wholesale because every line
# of that file's data is derived from the inputs below.
#
# Inputs
#   assets/sprites/manifest.tsv          one row per gun: era, tint, scale,
#                                        hand offsets, magazine, replaced-in
#   assets/sprites/defs/*.svg            the untinted, unscaled base templates
#   assets/sprites/*__v1__mag.svg        untinted magazine overlays
#   assets/icons/*.svg                   retired loot icons
#   assets/survev-repo-guns/{world,loot} authoritative CURRENT atlas filenames
#   extension/src/00-loader.js           MOUSE.TARGET, for the data's tag block
#
# Why the templates and not assets/sprites/<gun>__v1.svg:
#   Those files are pre-tinted AND pre-scaled (see assets/sprites/README.md).
#   The extension applies tint via PIXI (imgDef.tint) and scale via the game's
#   own worldImg.scale, so shipping baked art plus a def would double-apply
#   both. We ship the neutral template and put all per-gun identity in `def`.

import collections
import csv
import json
import os
import re
import sys
import xml.dom.minidom

# --------------------------------------------------------------- framing
# Every sprite the game draws is an atlas frame, and both eras' atlases packed
# each drawing at its own BOUNDING BOX, at roughly twice the size of the .svg
# source files that survive in the repos/archives. survev v0.1.1 ships its
# built atlas manifest (client/atlas-builder/out/high.json in commit 6ab329ee),
# which states the shipped frame for every id outright:
#
#   gun-long-01.img   28 x 184     (source svg 14 x 92)
#   gun-med-01.img    28 x 124     (source svg 14 x 62)
#   gun-short-01.img  28 x 96      (source svg 14 x 48)
#   gun-dp28-top-01.img  70 x 70   (source svg 34.6 x 34.6)
#   gun-m249-bot-01.img  72 x 40
#   gun-qbb97-bot-01.img 64 x 32   (source svg 64 x 32 - already 1x)
#
# That is the whole ball game for placement, because the game anchors the gun
# body at the BOTTOM CENTRE of its frame (player.ts: gunBarrel.anchor(0.5, 1))
# and a magazine overlay at its frame's CENTRE (gunMag.anchor(0.5, 0.5)). A
# frame carrying transparent padding therefore pushes the art off the hand or
# off the barrel by exactly that padding - it is not cosmetic slack.
#
# Two consequences, both of which this generator now handles per template
# rather than with one global multiplier:
#
#   1. CROP. The surviv.io-era .svg captures are authoring canvases: all three
#      2018 templates draw their capsule on a shared 16 x 127 frame, bottom-
#      aligned at y = 96, leaving 31px of dead space underneath. The atlas
#      trimmed that away (v0.1.1 ships the identical drawing as a tight
#      28 x 184), so it has to be cropped here too - otherwise the gun renders
#      31 * 2 * scale.y * 0.5 units clear of the player's hand, which is the
#      "gap between the player and the gun" bug. Same for the 2018 M249 ammo
#      box, whose 38 x 63 canvas holds a 36 x 20 drawing.
#
#   2. PER-SPRITE OUTPUT SIZE, not one shared scale factor. Most of the art is
#      2x its .svg, but gun-qbb97-bot-01 shipped at 1x - the magazine sprite's
#      scale is hardcoded (gunMag.scale = 0.25, it is NOT read from the def),
#      so emitting that one at 2x drew the QBB-97's magazine at double size.
#
# `out` below is therefore the exact frame the game itself ships for that id,
# and `crop` (x, y, w, h in the source file's own units) is the drawing's
# bounding box within its authoring canvas. Get these right and the historical
# `scale`, `leftHandOffset` and `magImg.pos` numbers - which are in absolute
# container units and never changed when the art was redrawn at 2x - can be
# used exactly as their era's gunDefs wrote them, with no scaling at all.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
SPRITES = os.path.join(ASSETS, "sprites")
ICONS = os.path.join(ASSETS, "icons")
REPO = os.path.join(ASSETS, "survev-repo-guns")
OUT = os.path.join(ROOT, "extension", "src", "14-skins-data.js")

errors = []


def fail(msg):
    errors.append(msg)


# --------------------------------------------------------------- current atlas
def atlas(kind):
    """Filenames survev ships TODAY, as .img ids. The texture swap is keyed by
    the live cache name, so every sprites[] entry must exist in here.

    Optional: assets/survev-repo-guns/ is a checkout of survev's current art,
    kept only to cross-check the hardcoded names below. If it isn't present the
    check is skipped - the names were verified against it when they were
    written, and the generator has no other need for it."""
    d = os.path.join(REPO, kind)
    if not os.path.isdir(d):
        return None
    return {f[:-4] + ".img" for f in os.listdir(d) if f.endswith(".svg")}


WORLD_ATLAS = atlas("world")
LOOT_ATLAS = atlas("loot")
if WORLD_ATLAS is None or LOOT_ATLAS is None:
    print("note: assets/survev-repo-guns/ not present - skipping live-atlas "
          "name cross-check (see atlas() for why that is fine)")

# --------------------------------------------------------------- gun -> today
# Body sprite each gun uses now. survev-era values come from og-survev-guns/
# gun-defs.json's current_world_sprite; surviv-era ones follow the same
# gun-<key>-01 convention. Every one is asserted against WORLD_ATLAS below.
CURRENT_WORLD = {
    "an94": "gun-an94-01.img", "bar": "gun-bar-01.img", "blr": "gun-blr-01.img",
    "colt45": "gun-colt45-01.img", "dp28": "gun-dp28-01.img",
    "flare_gun": "gun-flare-01.img", "l86": "gun-l86-01.img",
    "m1014": "gun-m1014-01.img", "m1100": "gun-m1100-01.img",
    "mkg45": "gun-mkg45-01.img", "model94": "gun-model94-01.img",
    "mosin": "gun-mosin-01.img", "qbb97": "gun-qbb97-top-01.img",
    "scar": "gun-scar-01.img", "scout_elite": "gun-scout_elite-01.img",
    "spas12": "gun-spas12-01.img", "sv98": "gun-sv98-01.img",
    "svd": "gun-svd-01.img", "vector": "gun-vector-01.img",
    "vector45": "gun-vector45-01.img",
    # surviv.io era
    "awc": "gun-awc-01.img", "deagle": "gun-deagle-01.img",
    "famas": "gun-famas-01.img", "garand": "gun-garand-01.img",
    "m249": "gun-m249-top-01.img", "m4a1": "gun-m4a1-01.img",
    "mp220": "gun-mp220-01.img", "saiga": "gun-saiga-01.img",
    "usas": "gun-usas-01.img",
}

# The GUI disambiguates duplicate names with "(id)", but these read better spelled out.
NAME_OVERRIDE = {
    "vector": "Vector (9mm)",
    "vector45": "Vector (.45 ACP)",
    "m1014": "M1014 (Super 90)",
}

# --------------------------------------------------------------- templates
# (const, file, crop, out) - see the framing note at the top of this file.
# crop is (x, y, w, h) in the source file's own units, or None for a file that
# is already its own bounding box; out is the frame size the game ships.
Tpl = collections.namedtuple("Tpl", "const file crop out")

TEMPLATES = {
    # survev v0.1.1's own files are already tight bounding boxes.
    ("survev", "gun-long-01.img"): Tpl("LONG_SURVEV", "defs/gun-long-01__survev-v0.1.1.svg", None, (28, 184)),
    ("survev", "gun-med-01.img"): Tpl("MED_SURVEV", "defs/gun-med-01__survev-v0.1.1.svg", None, (28, 124)),
    ("survev", "gun-short-01.img"): Tpl("SHORT_SURVEV", "defs/gun-short-01__survev-v0.1.1.svg", None, (28, 96)),
    # The 2018 captures share one 16 x 127 authoring canvas, capsule bottom-
    # aligned at y = 96 and horizontally centred (x 1..15). Cropping to the
    # capsule makes them geometrically identical to the survev-era files above,
    # which is what the shipped frames say they always were.
    ("surviv", "gun-long-01.img"): Tpl("LONG_2018", "defs/gun-long-01__surviv-2018.svg", (1, 4, 14, 92), (28, 184)),
    # 128 rather than 124: the reconstruction keeps the 2018 template's own
    # 64-unit capsule (see caveat 1 in assets/sprites/README.md), so its
    # bounding box is 14 x 64 and doubling it is the consistent choice.
    ("surviv", "gun-med-01.img"): Tpl("MED_2018", "defs/gun-med-01__surviv-2018-reconstructed.svg", (1, 32, 14, 64), (28, 128)),
    ("surviv", "gun-short-01.img"): Tpl("SHORT_2018", "defs/gun-short-01__surviv-2018.svg", (1, 48, 14, 48), (28, 96)),
}
MAG_TEMPLATES = {
    # A pan magazine drawn edge to edge - v0.1.1 packed it untrimmed at 70 x 70.
    "dp28": Tpl("MAG_DP28", "dp28__v1__mag.svg", None, (70, 70)),
    # Already at the size the game ships. Emitting this one at 2x is what made
    # the QBB-97's magazine render twice as large as it should.
    "qbb97": Tpl("MAG_QBB97", "qbb97__v1__mag.svg", None, (64, 32)),
    # 36 x 20 of drawing (rect 31.612 x 15.612 at 3.194, 9.523 plus its 4.388
    # stroke) on a 38 x 63 canvas; cropped and doubled it is the 72 x 40 the
    # game has shipped for this id in every era since.
    "m249": Tpl("MAG_M249", "m249__v1__mag.svg", (1, 7.329, 36, 20), (72, 40)),
}
# Overlay each mag gun uses TODAY, and the historical magImg placement.
MAG_CURRENT = {
    "dp28": "gun-dp28-top-01.img",
    "qbb97": "gun-qbb97-bot-01.img",
    "m249": "gun-m249-bot-01.img",
}

# gunOffset is deliberately NOT reverted, even though no historical def has one.
#
# It shifts the whole gun container relative to the hand (setType adds it to the
# fixed -4.25 hand offset), and two guns here carry one today: QBB-97 and FAMAS,
# both -8. survev introduced the QBB-97's in the same commit as its dedicated
# art (3efad98e), so on paper the right historical value is 0 - and an earlier
# revision of this generator emitted exactly that. In the running game it reads
# as the gap bug all over again: the barrel, magazine and all slide 8 units out
# from the hand together. Whatever the field was tuned for, the live value is
# what makes a gun sit on its hand in the modern client, so it is left alone.


def _fmt(v):
    return ("%.6f" % v).rstrip("0").rstrip(".")


def frame(text, crop, out, rel):
    """Re-frame a source drawing onto the atlas frame the game actually ships.

    Both jobs are done with a viewBox: it maps a rectangle of the source's own
    user units onto the new width/height, so `crop` selects the drawing's
    bounding box out of a larger authoring canvas and `out` states the pixel
    size to rasterise it at. svgToTexture (20-skins.js) sizes its canvas from
    the literal width/height attributes, so those must end up correct.
    """
    head_end = text.index(">", text.index("<svg"))
    head, rest = text[:head_end], text[head_end:]

    mw = re.search(r'\bwidth="([0-9.]+)"', head)
    mh = re.search(r'\bheight="([0-9.]+)"', head)
    if not mw or not mh:
        fail("SVG lacks literal width/height (svgToTexture needs them): " + rel)
        return text
    w, h = float(mw.group(1)), float(mh.group(1))

    existing = re.search(r'\bviewBox="([^"]+)"', head)
    if crop:
        # A file that already carries a viewBox draws in units of its own, so a
        # crop box measured in pixels would land somewhere else entirely. None
        # of the cropped templates has one; refuse rather than emit bad art.
        if existing:
            fail("crop requested for a file that already has a viewBox: " + rel)
            return text
        box = " ".join(_fmt(v) for v in crop)
    elif existing:
        box = existing.group(1)
    else:
        box = "0 0 %s %s" % (_fmt(w), _fmt(h))

    if existing:
        head = re.sub(r'\bviewBox="[^"]+"', 'viewBox="%s"' % box, head, count=1)
    else:
        head += ' viewBox="%s"' % box
    head = re.sub(r'\bwidth="[0-9.]+"', 'width="%s"' % _fmt(out[0]), head, count=1)
    head = re.sub(r'\bheight="[0-9.]+"', 'height="%s"' % _fmt(out[1]), head, count=1)
    return head + rest


def read_svg(rel, base=SPRITES, crop=None, out=None):
    p = os.path.join(base, rel)
    if not os.path.isfile(p):
        fail("missing asset: " + p)
        return ""
    text = open(p, encoding="utf-8").read().strip()
    # svgToTexture (20-skins.js) sizes the canvas from the literal width/height
    # attributes and ignores viewBox, so both must be present.
    if not re.search(r'<svg[^>]*\bwidth="', text) or not re.search(r'<svg[^>]*\bheight="', text):
        fail("SVG lacks literal width/height (svgToTexture needs them): " + rel)
    if out:
        text = frame(text, crop, out, rel)
    try:
        xml.dom.minidom.parseString(text)
    except Exception as e:
        fail("malformed SVG %s: %s" % (rel, e))
    return text


class Raw(str):
    """Emitted unquoted - used to reference a hoisted template const."""


def js(value, indent=0):
    pad = "    " * indent
    if isinstance(value, Raw):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        if not value:
            return "[]"
        inner = ",\n".join(pad + "    " + js(v, indent + 1) for v in value)
        return "[\n" + inner + "\n" + pad + "]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        inner = ",\n".join(
            pad + "    " + json.dumps(k) + ": " + js(v, indent + 1)
            for k, v in value.items()
        )
        return "{\n" + inner + "\n" + pad + "}"
    raise TypeError(type(value))


def num(s):
    f = float(s)
    return int(f) if f == int(f) else f


# --------------------------------------------------------------- world sprites
rows = list(csv.DictReader(open(os.path.join(SPRITES, "manifest.tsv"), encoding="utf-8"),
                           delimiter="\t"))
used_templates = {}
guns = {}
order = []

for r in rows:
    key, era = r["gun_key"], r["era"]
    current = CURRENT_WORLD.get(key)
    if not current:
        fail("no current world sprite mapped for " + key)
        continue
    if WORLD_ATLAS is not None and current not in WORLD_ATLAS:
        fail("%s: %s not in survev-repo-guns/world" % (key, current))

    tpl = TEMPLATES.get((era, r["base_texture"]))
    if not tpl:
        fail("no template for %s / %s / %s" % (key, era, r["base_texture"]))
        continue
    used_templates.setdefault(tpl.const, tpl)

    sprites = [current]
    svgs = {current: Raw(tpl.const)}

    world_def = {
        "tint": int(r["tint_dec"]),
        # Every number below is used exactly as its era's gunDefs wrote it.
        # They are all in the game's own container units, which did not change
        # when the art was redrawn - the templates are emitted at the frame
        # size the game ships (see the framing note at the top), so there is
        # nothing to compensate for. scale is a multiplier on that frame.
        "scale": {"x": num(r["scale_x"]), "y": num(r["scale_y"])},
        # surviv.io wrote leftHandOffset as a bare scalar, but we patch the
        # LIVE modern def, which is {x, y}.
        "leftHandOffset": {"x": num(r["left_hand_x"]),
                           "y": num(r["left_hand_y"])},
    }

    # rightHandOffset is not a survev def field - the game pins the rear hand
    # to an animation bone, and extension/src/20-skins.js implements this one
    # itself (see applyRearHands there). Reverted art puts its grip somewhere
    # else than the modern art does, so the hand that should cover the gun's
    # rear end sometimes has to be nudged along it. Optional column: leave it
    # blank and nothing is emitted.
    if r.get("right_hand_x"):
        world_def["rightHandOffset"] = {"x": num(r["right_hand_x"]),
                                        "y": num(r.get("right_hand_y") or 0)}

    if r["mag_sprite"]:
        mtpl = MAG_TEMPLATES[key]
        mconst = mtpl.const
        used_templates.setdefault(mconst, mtpl)
        mag_now = MAG_CURRENT[key]
        if WORLD_ATLAS is not None and mag_now not in WORLD_ATLAS:
            fail("%s: mag %s not in survev-repo-guns/world" % (key, mag_now))
        sprites.append(mag_now)
        svgs[mag_now] = Raw(mconst)
        # Only pos/top are overridden - the overlay is swapped by cache name,
        # so magImg.sprite must keep pointing at today's id. `top` is stated
        # explicitly (not just when true) so the historical layering wins
        # regardless of what the current def says.
        world_def["magImg"] = {
            # Historical units, unscaled - magImg.pos places the overlay's
            # CENTRE in container units measured from the hand, and the
            # magazine sprite's own scale is hardcoded in the client
            # (gunMag.scale = 0.25) rather than read from the def, so nothing
            # here moves when the art is re-framed.
            "pos": {"x": num(r["mag_pos_x"]), "y": num(r["mag_pos_y"])},
            "top": r["mag_top"] == "yes",
        }

    guns[key] = {
        "id": key,
        "name": NAME_OVERRIDE.get(key, r["display_name"]),
        "world": {
            "sprites": sprites,
            "versions": [{
                "label": "v1",
                # The date this art was REPLACED - the library indexes art by
                # the update that retired it, matching the changelog.
                "date": r["replaced_date"],
                "svgs": svgs,
                "def": {"world": world_def},
            }],
        },
    }
    order.append(key)

# --------------------------------------------------------------- loot icons
# <file stem> -> (gun id, display name, current loot .img, version label)
ICON_MAP = [
    ("ak47__v1", "ak47", "AK-47", "loot-weapon-ak.img", "v1", "2019-01-31"),
    ("ak47_v2", "ak47", "AK-47", "loot-weapon-ak.img", "v2", "2019-01-31"),
    ("glock__v1", "glock", "G18C", "loot-weapon-glock.img", "v1", "2026-03-09"),
    ("glock-dual__v1", "glock_dual", "Dual G18C", "loot-weapon-glock-dual.img", "v1", "2026-03-09"),
    ("hk416__v1", "hk416", "M416", "loot-weapon-hk416.img", "v1", "2026-03-09"),
    ("mac10__v1", "mac10", "MAC-10", "loot-weapon-mac10.img", "v1", "2026-03-09"),
    ("mp5__v1", "mp5", "MP5", "loot-weapon-mp5.img", "v1", "2026-03-09"),
    ("ump9__v1", "ump9", "UMP9", "loot-weapon-ump9.img", "v1", "2026-03-09"),
    ("ot38__v1", "ot38", "OT-38", "loot-weapon-ot38.img", "v1", "2026-03-09"),
    ("ot38-dual__v1", "ot38_dual", "Dual OT-38", "loot-weapon-ot38-dual.img", "v1", "2026-03-09"),
    ("m870__v1", "m870", "M870", "loot-weapon-m870.img", "v1", "2019-10-08"),
    ("mosin__v1", "mosin", "Mosin-Nagant", "loot-weapon-mosin.img", "v1", "2018-06-06"),
    ("mp220__v1", "mp220", "MP220", "loot-weapon-mp220.img", "v1", "2018-09-07"),
    ("saiga__v1", "saiga", "Saiga-12", "loot-weapon-saiga.img", "v1", "2019-02-22"),
    ("m39__v1", "m39", "M39 EMR", "loot-weapon-m39.img", "v1", "2026-09-25"),
]

INCLUDE_ICONS = os.environ.get("SKINS_ICONS", "1") != "0"

if INCLUDE_ICONS:
    for stem, gid, name, img, label, date in ICON_MAP:
        svg = read_svg(stem + ".svg", base=ICONS)
        if LOOT_ATLAS is not None and img not in LOOT_ATLAS:
            fail("%s: %s not in survev-repo-guns/loot" % (gid, img))
        gun = guns.get(gid)
        if gun is None:
            gun = {"id": gid, "name": name}
            guns[gid] = gun
            order.append(gid)
        slot = gun.setdefault("loot", {"sprites": [img], "versions": []})
        # Icons are full-colour art and lootImg's tint/scale/border are
        # unchanged from the historical defs, so no `def` is needed.
        slot["versions"].append({"label": label, "date": date, "svgs": {img: svg}})

# --------------------------------------------------------------- validate
for key in order:
    g = guns[key]
    for slot_name in ("world", "loot"):
        slot = g.get(slot_name)
        if not slot:
            continue
        for v in slot["versions"]:
            for n in v["svgs"]:
                if n not in slot["sprites"]:
                    fail("%s/%s %s: svgs key %r not in sprites[]" % (key, slot_name, v["label"], n))
        labels = [v["label"] for v in slot["versions"]]
        if len(labels) != len(set(labels)):
            fail("%s/%s: duplicate version labels %r" % (key, slot_name, labels))
    if not g.get("world") and not g.get("loot"):
        fail(key + ": entry has neither slot")

if errors:
    print("FAILED - not writing output:", file=sys.stderr)
    for e in errors:
        print("  - " + e, file=sys.stderr)
    sys.exit(1)

# --------------------------------------------------------------- tag
loader = open(os.path.join(ROOT, "extension", "src", "00-loader.js"), encoding="utf-8").read()
m = re.search(r'TARGET:\s*\{\s*survev:\s*"([^"]+)",\s*build:\s*"([^"]+)"', loader)
if not m:
    print("FAILED - could not read MOUSE.TARGET from 00-loader.js", file=sys.stderr)
    sys.exit(1)
survev_ver, build = m.group(1), m.group(2)

# --------------------------------------------------------------- emit
TEMPLATE_ORDER = ["LONG_SURVEV", "MED_SURVEV", "SHORT_SURVEV",
                  "LONG_2018", "MED_2018", "SHORT_2018",
                  "MAG_DP28", "MAG_QBB97", "MAG_M249"]
TEMPLATE_NOTE = {
    "LONG_SURVEV": "survev v0.1.1 long capsule, 14x92 (cropped to its bounding box)",
    "MED_SURVEV": "survev v0.1.1 medium capsule, 14x62",
    "SHORT_SURVEV": "survev v0.1.1 short capsule, 14x48",
    "LONG_2018": "surviv.io long capsule, cropped off the shared 16x127 authoring frame (capsule at y 4-96)",
    "MED_2018": "surviv.io medium capsule, cropped off 16x127 (capsule at y 32-96) - reconstructed, no 2018 capture exists",
    "SHORT_2018": "surviv.io short capsule, cropped off 16x127 (capsule at y 48-96)",
    "MAG_DP28": "DP-28 pan magazine - already coloured, never tinted",
    "MAG_QBB97": "QBB-97 magazine housing - already coloured, never tinted",
    "MAG_M249": "M249 ammo box, cropped off its 38x63 canvas - already coloured, never tinted",
}

out = []
out.append('''// 14-skins-data.js
//
// GENERATED by tools/gen-skins-data.py - do not edit by hand; edit the asset
// library under assets/ and re-run the script.
//
// Each gun's retired loot icon / world sprite art. Every version here is a
// real, changelog-confirmed art change, cross-checked against archived
// surviv.io bundles (Wayback Machine) and survev's own repo - see
// assets/sprites/README.md for provenance, per-gun parameters, and caveats.
//
// Shape:
//   MOUSE.skins.tag            the survev.io client build this data is tagged to
//   MOUSE.skins.guns[]         { id, name, loot?, world? }
//     .loot / .world         { sprites: string[], versions: Version[] }
//     Version                { label, date, svgs: { [spriteName]: svgText | null }, def? }
//       svgs[name] === null  a known version whose art could not be found -
//                            render greyed out, not selectable.
//       def                  { world?: {...} } or { loot?: {...} } - only the
//                            rendering fields (tint, scale, hand offset,
//                            magazine position) that differ from the CURRENT
//                            def. Deliberately excludes gameplay stats
//                            (e.g. recoil) - this is a cosmetic revert, not a
//                            gameplay one.
//   `date` is when the art was RETIRED, i.e. the update that replaced it.
//   `sprites[]` are TODAY's atlas ids, because the swap is keyed by the live
//   PIXI texture-cache name; index 0 is the body and takes the tint, index 1+
//   is a magazine overlay and is never tinted.
//
// None of the world sprites here is unique art: all 29 guns shared one of
// three colourless capsule templates, and got their identity purely from
// gunDefs. So the SVGs below are the untinted, unscaled templates, hoisted
// into consts and shared, with each gun's tint/scale/hand/magazine carried in
// its `def`. Shipping pre-tinted art instead would double-apply both the tint
// (PIXI applies imgDef.tint) and the scale (the game applies worldImg.scale).
//
// Each template is emitted at the exact frame size the game's own atlas ships
// for that sprite id, cropped to the drawing where its source file is a larger
// authoring canvas - see the framing note at the top of the generator. That
// matters because the game anchors a gun body at the BOTTOM of its frame and a
// magazine at its frame's CENTRE, so leftover transparent padding is not slack:
// it pushes the art off the hand. With the frames right, every `def` number
// below is its era's gunDefs value used verbatim, unscaled.
//
// There is deliberately no "current" version in this file - the Skin Changer's
// GUI appends its own synthetic "Current" chip, filled from the running game.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;
''')

for const in TEMPLATE_ORDER:
    if const not in used_templates:
        continue
    tpl = used_templates[const]
    note = TEMPLATE_NOTE[const] + " - emitted at %g x %g%s" % (
        tpl.out[0], tpl.out[1], ", cropped to the drawing" if tpl.crop else "")
    out.append("    // " + note)
    out.append("    const %s =" % const)
    out.append("        %s;\n" % json.dumps(read_svg(tpl.file, crop=tpl.crop, out=tpl.out)))

data = {
    "tag": {"build": build, "short": build[:8], "survev": survev_ver},
    "guns": [guns[k] for k in order],
}
out.append("    const SKINS_DATA = " + js(data, 1) + ";\n")
out.append('''
    MOUSE.skins = SKINS_DATA;
    MOUSE.log("skin data loaded (" + SKINS_DATA.guns.length + " guns, tagged " + SKINS_DATA.tag.short + ")");
})();
''')

open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(out))

world_n = sum(1 for k in order if guns[k].get("world"))
loot_n = sum(1 for k in order if guns[k].get("loot"))
loot_v = sum(len(guns[k]["loot"]["versions"]) for k in order if guns[k].get("loot"))
print("wrote %s" % os.path.relpath(OUT, ROOT))
print("  %d guns  (%d with world sprites, %d with loot icons / %d icon versions)"
      % (len(order), world_n, loot_n, loot_v))
print("  %d shared templates, %d bytes" % (len(used_templates), os.path.getsize(OUT)))
