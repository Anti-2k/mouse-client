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
// "Which one is next" is read off each matched obstacle's own networked
// button.onOff (true once you've flipped it): the order is walked claiming
// one pressed slot per step, and the first step with no pressed slot left
// for its name is "next". Claiming slots instead of testing names is what
// makes the reserve vault work - its order is 1,2,3,4,2,5 over two separate
// "2" switches. This is a best-effort reconstruction, not a mirror of the
// server's own `inputCode` progress (which is never sent to the client at
// all): onOff only says a button is switched on, not that pressing it was
// the correct next step. In ordinary play - pressing pieces in the order
// this module is already showing you - the two agree. A reset (wrong
// sequence, or the per-piece idle timeout) is seen through its real,
// networked effect: the server flips every piece's onOff back to false.
//
// Each slot's state is remembered while its obstacle is out of view, since
// the server culls obstacles outside your view rect and the saloon is
// taller than it - see `states` below for that and for how a reset that
// happened out of view is still caught.
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

    /**
     * Last known state of every puzzle slot, per building. Needed because
     * the server culls obstacles outside your view rect (server/src/game/
     * client.ts sends delObjIds for them), and a puzzle building can be
     * bigger than that rect: walking from the saloon's red bottle to its
     * orange one deletes the red bottle client-side, and reading progress
     * only off live obstacles then forgot it was ever pressed. So a slot
     * keeps its onOff while out of view.
     *
     * A reset the player didn't see (wrong order, idle timeout) still has to
     * clear those remembered presses. The server's resetPuzzle switches
     * every piece off and bumps its button.seq, so any live piece that reads
     * off with a seq different from the one last seen means a reset has
     * happened since, and every slot not in view is cleared with it.
     * @type {Map<number, {type: string, x: number, y: number, seen: boolean, clock: number, slots: Array<{onOff: boolean, seq: number | undefined, pressedAt: number}>}>}
     */
    const states = new Map();

    /** @param {any} b @param {number} slotCount */
    function stateFor(b, slotCount) {
        let st = states.get(b.__id);
        // Pool objects and ids are reused between buildings and games.
        if (!st || st.type !== b.type || st.x !== b.pos.x || st.y !== b.pos.y || st.slots.length !== slotCount) {
            st = { type: b.type, x: b.pos.x, y: b.pos.y, seen: false, clock: 0, slots: [] };
            for (let i = 0; i < slotCount; i++) st.slots.push({ onOff: false, seq: undefined, pressedAt: 0 });
            states.set(b.__id, st);
        }
        return st;
    }

    /** @param {any} st @param {Map<number, any>} live slot index -> obstacle */
    function syncSlots(st, live) {
        let reset = false;
        live.forEach((o, j) => {
            if (!o.button) return;
            const slot = st.slots[j];
            if (!o.button.onOff && slot.seq !== undefined && o.button.seq !== slot.seq) reset = true;
        });
        if (reset) {
            for (let j = 0; j < st.slots.length; j++) st.slots[j].onOff = false;
        }
        live.forEach((o, j) => {
            if (!o.button) return;
            st.seen = true;
            const slot = st.slots[j];
            if (o.button.onOff && !slot.onOff) slot.pressedAt = ++st.clock;
            slot.onOff = !!o.button.onOff;
            slot.seq = o.button.seq;
        });
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

            /** slot index -> the live obstacle sitting in it this tick */
            const live = new Map();
            for (let i = 0; i < obstacles.length; i++) {
                const o = obstacles[i];
                if (!o.active || !o.isPuzzlePiece || o.parentBuildingId !== b.__id || !o.pos) continue;
                let bestIdx = -1;
                let bestDist = Infinity;
                for (let j = 0; j < expected.length; j++) {
                    const d = Math.hypot(o.pos.x - expected[j].pos.x, o.pos.y - expected[j].pos.y);
                    if (d < bestDist) {
                        bestDist = d;
                        bestIdx = j;
                    }
                }
                if (bestIdx >= 0 && bestDist < 0.5) live.set(bestIdx, o);
            }

            const state = stateFor(b, expected.length);
            syncSlots(state, live);
            if (!state.seen) continue; // no piece of this puzzle has been in view yet

            // Walk the order claiming one pressed slot per step, earliest
            // press first. Claiming slots rather than testing names is what
            // lets a name repeat: the reserve vault's order is 1,2,3,4,2,5
            // over two separate "2" switches, and the second "2" step is
            // only done once a *second* "2" slot is on.
            const claimed = new Set();
            const pressedOrder = [];
            for (let j = 0; j < expected.length; j++) {
                if (state.slots[j].onOff) pressedOrder.push(j);
            }
            pressedOrder.sort((x, y) => state.slots[x].pressedAt - state.slots[y].pressedAt);
            let nextIdx = order.length;
            let currentSlot = -1;
            for (let i = 0; i < order.length; i++) {
                const slot = pressedOrder.find((j) => !claimed.has(j) && expected[j].name === order[i]);
                if (slot === undefined) {
                    nextIdx = i;
                    break;
                }
                claimed.add(slot);
                currentSlot = slot;
            }
            if (nextIdx >= order.length) continue; // every step already reads as pressed

            // Of the unpressed slots carrying the next name (more than one
            // only for the vault's "2"), the server accepts any - point at
            // the one nearest the step just pressed, or nearest you.
            const from = currentSlot >= 0 ? expected[currentSlot].pos : activePlayer.pos;
            let nextSlot = -1;
            let nextDist = Infinity;
            for (let j = 0; j < expected.length; j++) {
                if (expected[j].name !== order[nextIdx] || state.slots[j].onOff) continue;
                const d = Math.hypot(expected[j].pos.x - from.x, expected[j].pos.y - from.y);
                if (d < nextDist) {
                    nextDist = d;
                    nextSlot = j;
                }
            }
            if (nextSlot < 0) continue;

            const next = expected[nextSlot];
            const current = currentSlot >= 0 ? expected[currentSlot] : null;

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
