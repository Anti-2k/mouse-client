// 24-puzzles.js
//
// Puzzle helper: outlines the step to press next in a bunker or vault
// puzzle's solution order, with a line back to the step you just pressed -
// twin bunker, eye bunker, chrysanthemum bunker, the saloon's secret door
// and the reserve vault.
//
// Only the next node is outlined; the step just pressed is tracked (for the
// line's other end) but no longer circled. Steps further ahead are
// deliberately not shown either: the useful question at any moment is
// "which one now", and a full path drawn over a bunker floor is mostly
// clutter that makes the one node that matters harder to pick out.
//
// The solution order is fully derivable client-side: shared/defs/puzzles.ts
// is a tiny, static Record<string, string[]> (hand-copied below - update it
// if MOUSE.TARGET moves and the game adds/changes a puzzle), and
// MapObjectDefs.typeToDef(building.type, "building").puzzle.name is the key
// into it. No server data needed for the order itself.
//
// What IS missing is the piece *name* on each individual obstacle:
// shared/net/objectSerializeFns.ts only ever sends `isPuzzlePiece` (a bool)
// and `parentBuildingId` for an obstacle - never which named piece it is.
// So this reconstructs the name -> world-position mapping from the building
// def's own mapObjects geometry (server/src/game/map.ts's own transform:
// partPos = addAdjust(buildingPos, localPos, buildingOri), i.e. a 90-degree-
// step rotation of the local offset followed by translation - only the
// building's ori, not the piece's own inheritOri/ori, which just rotates
// how the piece is drawn), then nearest-matches each real obstacle in the
// building to the closest named slot. A ~0.5 unit tolerance is generous
// against the closest two named slots in any puzzle here (saloon's `orange`
// and `column` sit 1.75 units apart) and comfortably covers the ~0.016 unit
// quantization writeMapPos already rounds positions to.
//
// "Which one is next" is read straight off each matched obstacle's own
// networked button.onOff (true once you've flipped it) - the first name in
// the order whose obstacle isn't yet onOff is "next", and the one before it
// in the order is "current". This is a best-effort reconstruction, not a
// mirror of the server's own `inputCode` progress (which is never sent to
// the client at all): a button's onOff simply reflects whether it's
// currently switched on, not whether pressing it was the objectively
// correct next step. In ordinary play - pressing pieces in the order this
// module is already showing you - the two agree. A reset (wrong sequence,
// or the per-piece idle timeout) is invisible to this module except through
// its real, networked effect: the server flips every piece's onOff back to
// false, which snaps the highlight back to the first step on its own, with
// no separate error-tracking needed here.
//
// Decoy pieces (the saloon's barrel/gun/column, `modeBuildingDefs.ts`) do
// carry `isPuzzlePiece`/`puzzlePiece` like real ones, so they show up in the
// geometric match - but since their names are never in the solution order,
// they're simply never looked up and can't affect the highlight.
//
// Layers. A puzzle's pieces do not all have to sit on the puzzle building's
// own layer: bunker_twins is one puzzle whose six switches are split three
// on the surface and three in the sublevel (`layer: 0` on half of the
// sublevel building's own mapObjects, bunkerDefs.ts). Gating the whole
// building on the player's layer - what this module used to do - therefore
// made the twins puzzle appear only once you were already underground, and
// then drew its surface half at positions you could not see. Each node
// carries its own layer here instead, and a link between two nodes on
// different layers is routed through the bunker's own opening: the enclosing
// Structure's stairs (client/src/objects/structure.ts, reached via
// ctx.structurePool), of which the pair picks whichever makes the shortest
// path. Only the half of that route on your current layer is drawn, so on
// the surface the line runs from the last surface switch into the stairwell,
// and once you are down it picks up from the same stairwell to the next
// switch below.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const MODULE_ID = "puzzles";

    // shared/defs/puzzles.ts, verbatim.
    const PUZZLES = {
        bunker_eye_02: ["egg", "hydra", "storm", "conch", "crossing", "hatchet"],
        bunker_eye_02_woods: [
            "swine", "hydra", "crossing", "hatchet", "harpsichord",
            "caduceus", "egg", "cloud", "storm", "conch",
        ],
        bunker_chrys_01: ["ichi", "ni", "san", "shi"],
        bunker_chrys_02: ["flower", "leaves", "moon", "frost"],
        saloon: ["red", "orange", "yellow", "green", "blue", "indigo", "violet"],
        club_01: ["1", "2", "3", "4"],
        club_02: ["1"],
        bunker_twins: ["scout", "sniper", "medic", "demo", "assault", "tank"],
        reserve_vault: ["1", "2", "3", "4", "2", "5"],
    };

    function getSettings() {
        const get = (key, fallback) => MOUSE.modules.getSetting(MODULE_ID, key, fallback);
        return {
            nextColor: get("nextColor", 0x00ff88),
            pathColor: get("pathColor", 0xffcc00),
            outlineWidth: get("outlineWidth", 2),
            nodeRadius: get("nodeRadius", 1.2),
        };
    }

    /** server/src/game/map.ts's own transform for a building's mapObjects -
     * only the building's ori, not the piece's own ori/inheritOri (those
     * only rotate how the piece is drawn, not where it sits).
     * @param {{x:number,y:number}} basePos @param {{x:number,y:number}} localPos @param {number} ori */
    function addAdjust(basePos, localPos, ori) {
        let x, y;
        switch (((ori % 4) + 4) % 4) {
            case 1:
                x = -localPos.y;
                y = localPos.x;
                break;
            case 2:
                x = -localPos.x;
                y = -localPos.y;
                break;
            case 3:
                x = localPos.y;
                y = -localPos.x;
                break;
            default:
                x = localPos.x;
                y = localPos.y;
        }
        return { x: basePos.x + x, y: basePos.y + y };
    }

    /** @param {any} ctx @param {any} def @returns {string[] | null} */
    function orderFor(ctx, def) {
        let name = def.puzzle.name;
        if (name === "bunker_eye_02" && ctx.mode && ctx.mode.woods) name = "bunker_eye_02_woods";
        return PUZZLES[name] || null;
    }

    /**
     * The walkable stairs of the Structure this building belongs to, in
     * world coordinates. A Structure lists its own layer buildings by id
     * (`layers[].objId`, client/src/objects/structure.ts), which is the only
     * link back from a sublevel building to the thing holding its stairs.
     * `lootOnly` stairs are chutes loot is dropped down rather than a way
     * between layers, so they're skipped.
     * @param {any} ctx @param {any} building @returns {Array<{x:number,y:number}>}
     */
    function stairsFor(ctx, building) {
        if (!ctx.structurePool) return [];
        const structures = ctx.poolArray(ctx.structurePool);
        for (let i = 0; i < structures.length; i++) {
            const s = structures[i];
            if (!s.active || !Array.isArray(s.layers) || !Array.isArray(s.stairs)) continue;
            let owns = false;
            for (let j = 0; j < s.layers.length; j++) {
                if (s.layers[j] && s.layers[j].objId === building.__id) {
                    owns = true;
                    break;
                }
            }
            if (!owns) continue;
            const out = [];
            for (let j = 0; j < s.stairs.length; j++) {
                const st = s.stairs[j];
                if (st && st.center && !st.lootOnly) out.push(st.center);
            }
            return out;
        }
        return [];
    }

    /** Whichever stairwell makes `a -> stairs -> b` shortest, or null if the
     * building's structure could not be resolved.
     * @param {Array<{x:number,y:number}>} stairs
     * @param {{x:number,y:number}} a @param {{x:number,y:number}} b */
    function shortestVia(stairs, a, b) {
        let best = null;
        let bestLen = Infinity;
        for (let i = 0; i < stairs.length; i++) {
            const c = stairs[i];
            const len = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y);
            if (len < bestLen) {
                bestLen = len;
                best = c;
            }
        }
        return best;
    }

    function onTick(dt, ctx) {
        void dt;
        if (!ctx.ready || !ctx.buildingPool || !MOUSE.mapDefs) return;
        const activePlayer = ctx.activePlayer;
        const buildings = ctx.poolArray(ctx.buildingPool);
        if (!buildings.length) return;
        const obstacles = ctx.obstaclePool ? ctx.poolArray(ctx.obstaclePool) : [];
        if (!obstacles.length) return;

        const settings = getSettings();
        const myLayer = activePlayer.layer;

        for (let bi = 0; bi < buildings.length; bi++) {
            const b = buildings[bi];
            if (!b.active || !b.hasPuzzle || b.puzzleSolved) continue;
            const def = MOUSE.mapDefs.typeToDefSafe(b.type);
            if (!def || !def.puzzle || !Array.isArray(def.mapObjects)) continue;
            const order = orderFor(ctx, def);
            // A one-step "puzzle" (club_02) is a single switch that opens a
            // door - there is no sequence to remember and nothing a helper
            // can add, so it is skipped rather than permanently outlining
            // the only button in the room.
            if (!order || order.length < 2) continue;

            const expected = [];
            for (let i = 0; i < def.mapObjects.length; i++) {
                const mo = def.mapObjects[i];
                if (!mo.puzzlePiece || !mo.pos) continue;
                expected.push({
                    name: mo.puzzlePiece,
                    pos: addAdjust(b.pos, mo.pos, b.ori),
                    // A piece can override the building's own layer - which
                    // is exactly what splits bunker_twins across two of them.
                    layer: typeof mo.layer === "number" ? mo.layer : b.layer,
                });
            }
            if (!expected.length) continue;

            /** @type {Map<string, any[]>} name -> matched obstacle instance(s) */
            const matched = new Map();
            for (let i = 0; i < obstacles.length; i++) {
                const o = obstacles[i];
                if (!o.active || !o.isPuzzlePiece || o.parentBuildingId !== b.__id || !o.pos) continue;
                let bestName = null;
                let bestDist = Infinity;
                for (let j = 0; j < expected.length; j++) {
                    const d = Math.hypot(o.pos.x - expected[j].pos.x, o.pos.y - expected[j].pos.y);
                    if (d < bestDist) {
                        bestDist = d;
                        bestName = expected[j].name;
                    }
                }
                if (bestName !== null && bestDist < 0.5) {
                    if (!matched.has(bestName)) matched.set(bestName, []);
                    matched.get(bestName).push(o);
                }
            }
            if (!matched.size) continue; // couldn't geometrically resolve any piece this tick

            /** The live obstacle wins over the def's geometry for both
             * position and layer when there is one - it is what the server
             * actually placed. @param {string} name */
            const nodeFor = (name) => {
                const list = matched.get(name);
                const e = expected.find((x) => x.name === name);
                if (list && list.length) {
                    const o = list[0];
                    return { pos: o.pos, layer: typeof o.layer === "number" ? o.layer : e ? e.layer : b.layer };
                }
                return e ? { pos: e.pos, layer: e.layer } : null;
            };
            const isPressed = (name) => {
                const list = matched.get(name);
                return !!list && list.some((o) => o.button && o.button.onOff);
            };

            let nextIdx = order.length;
            for (let i = 0; i < order.length; i++) {
                if (!isPressed(order[i])) {
                    nextIdx = i;
                    break;
                }
            }
            if (nextIdx >= order.length) continue; // every step already reads as pressed

            const next = nodeFor(order[nextIdx]);
            const current = nextIdx > 0 ? nodeFor(order[nextIdx - 1]) : null;
            if (!next) continue;

            const nextHere = ctx.sameLayer(next.layer, myLayer);
            const currentHere = !!current && ctx.sameLayer(current.layer, myLayer);
            if (!nextHere && !currentHere) continue; // this puzzle is entirely on the other layer

            if (!MOUSE.overlay.ensureFrame()) return;
            // The overlay sits in the ordinary, ceiling-masked layer
            // (16-overlay.js): puzzle switches are always something you're
            // either standing under or not, so this behaves like a normal
            // in-world object and disappears under a roof (e.g. the
            // clubhouse's top bunker entrance) exactly like the switches
            // themselves do.
            //
            // And above the world objects rather than below them, which is
            // where this started: drawing *below* them let a puzzle piece
            // wide enough to cover its own marker hide it completely. The
            // chrysanthemum bunker's greenhouse is the case that exposed
            // that - its pieces are planter_04s, 3 units across, instead of
            // the palm-sized switch_01 every other puzzle uses, so both the
            // outline and the end of the link line disappeared under the
            // flower pots while the same drawing showed fine everywhere
            // else.
            const gfx = MOUSE.overlay.above;
            const px = 1 / ctx.worldScale();

            // The link, drawn before the nodes so an outline is never drawn
            // over by the line that ends at it.
            if (current) {
                gfx.lineStyle(settings.outlineWidth * px, settings.pathColor, 0.9);
                if (currentHere && nextHere) {
                    gfx.moveTo(current.pos.x, current.pos.y);
                    gfx.lineTo(next.pos.x, next.pos.y);
                } else {
                    const from = currentHere ? current.pos : next.pos;
                    const via = shortestVia(stairsFor(ctx, b), current.pos, next.pos);
                    // No resolvable structure (the pool has not been located
                    // yet, or the puzzle is not inside one): a straight line
                    // toward the off-layer node still points the right way,
                    // which beats drawing nothing at all.
                    const to = via || (currentHere ? next.pos : current.pos);
                    gfx.moveTo(from.x, from.y);
                    gfx.lineTo(to.x, to.y);
                }
            }

            if (nextHere) {
                gfx.lineStyle(settings.outlineWidth * px, settings.nextColor, 0.95);
                gfx.drawCircle(next.pos.x, next.pos.y, settings.nodeRadius);
            }
        }
    }

    MOUSE.modules.register({
        id: MODULE_ID,
        name: "Puzzle helper",
        description:
            "Outlines the puzzle step to press next, with a line back to the step you just pressed - twin bunker, eye bunker, chrysanthemum bunker, the saloon and the reserve vault. Puzzles split across two layers route their line through the bunker's stairs, so each half is drawn on the layer you're actually on.",
        settings: {
            nextColor: { kind: "color", label: "Next step colour", default: 0x00ff88 },
            pathColor: { kind: "color", label: "Line colour", default: 0xffcc00 },
            outlineWidth: { kind: "number", label: "Outline width", default: 3, min: 2, max: 5, step: 0.5 },
            nodeRadius: { kind: "number", label: "Node radius", default: 0.7, min: 0.5, max: 1, step: 0.05 },
        },
        onTick,
    });
})();
