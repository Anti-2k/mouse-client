// 16-overlay.js
//
// A shared world-space drawing surface for modules that need to render
// geometry the game itself never draws (the Puzzle helper's step outlines)
// instead of merely nudging the game's own display objects.
//
// One PIXI.Graphics, positioned and scaled every frame with the same recipe
// the game's own renderer uses for its layer mask (client/src/renderer.ts's
// redrawLayerMask: position at the screen point world (0,0) maps to, scale
// (ppu*zoom, -ppu*zoom) to flip world-up to screen-down) so that everything
// drawn into it afterward uses plain world coordinates - no per-shape camera
// math required by a consumer.
//
// MOUSE.overlay.above sits in the ordinary, ceiling-masked layer container,
// at a zOrd above the world objects - for marking a *specific* map object,
// where being drawn under the thing being marked defeats the point. See
// ABOVE_Z_ORD below. Being in the masked layer is deliberate: it behaves
// like a real in-world object, visible when you are under the same ceiling
// as it and hidden otherwise, so it never shows anything through a roof.
//
// Consumers must call MOUSE.overlay.ensureFrame() at the top of their own
// onTick before drawing. It is idempotent per animation frame (guarded by
// a counter, not by call order) precisely because tick-listener order
// across files is registration order, not load order relative to the
// module registry's own dispatcher - a module clearing the graphics *after*
// another module already drew into it this frame would erase that frame's
// content before PIXI ever paints it. Whichever consumer's onTick runs first
// each frame does the actual clear+reposition for everyone.
//
// The graphics is a child of the renderer's own layer containers, which
// makes it collateral damage of the game's own teardown: client/src/
// game.ts's Game.free() (and client/src/ui/opponentDisplay.ts's
// LoadoutDisplay.free(), which owns a second Renderer of its own for the
// menu character) empties the PIXI stage with `destroy({children: true})`,
// so every frame a match or the loadout display ends, whatever this file
// built is destroyed underneath it. A destroyed PIXI.Graphics keeps its
// identity but has had its internals nulled out, and clear() on one throws
// "Cannot read properties of null (reading 'clear')". Nothing here can be
// notified of that destruction, so aliveness is checked at the top of every
// frame instead (see isAlive/ensureFrame below) and the graphics is rebuilt
// on the spot.
//
// MOUSE.pixi (15-defs.js) is where the Graphics class comes from, and it
// resolves at match time rather than at load - see that file's header for
// why it has to be taken off live objects. Until it does,
// MOUSE.overlay.available is false and ensureFrame() is a no-op returning
// false; consumers are expected to skip their drawing for the tick.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    // Above every ordinary world object but below a player. Obstacles take
    // their zOrd straight from their def's img.zIdx (client/src/objects/
    // obstacle.ts), which is 10 for the indoor furniture puzzle switches and
    // planters are; loot is 13; a player is 18 (client/src/objects/
    // player.ts's renderZOrd). 16 therefore draws over the object being
    // marked and still passes under whoever is standing on it. The one thing
    // it stays below is the game's own "large/high object" hack, which adds
    // 100 to anything at zOrd >= 50 (trees, smoke) - as it should: a marker
    // painted over a tree canopy would be exactly as misleading as one
    // painted under a planter.
    const ABOVE_Z_ORD = 16;
    const ABOVE_Z_IDX = 1;

    MOUSE.overlay = {
        /** @type {any} */
        above: null,
        available: false,
        ensureFrame() {
            return false;
        },
        /** @param {any} _obj */
        isAlive(_obj) {
            return false;
        },
    };

    /**
     * Whether a display object is still usable - see ctx.displayAlive
     * (10-ctx.js), which owns the actual check.
     * @param {any} obj
     */
    function isAlive(obj) {
        return MOUSE.ctx.displayAlive(obj);
    }
    // Re-exported, because anything that holds on to a display object of the
    // game's (20-skins.js keeps the hand sprites it has moved) has exactly the
    // same problem this file does.
    MOUSE.overlay.isAlive = isAlive;

    function disposeOld() {
        const g = MOUSE.overlay.above;
        if (!isAlive(g)) return;
        if (g.parent) g.parent.removeChild(g);
        try {
            g.destroy({ children: true });
        } catch (e) {
            MOUSE.warn("could not destroy an old overlay graphics", e);
        }
    }

    function build() {
        // A rebuild for a fresh renderer leaves the previous graphics
        // parented to the old one; a rebuild after the game destroyed it
        // leaves nothing to do. Either way the old reference is dropped
        // below, so this is the last chance to let go of its GPU buffers.
        disposeOld();
        MOUSE.overlay.above = null;
        MOUSE.overlay.available = false;
        if (!MOUSE.pixi || typeof MOUSE.pixi.Graphics !== "function") return;
        MOUSE.overlay.above = new MOUSE.pixi.Graphics();
        MOUSE.overlay.available = true;
        MOUSE.log("overlay graphics built");
    }

    // MOUSE.pixi resolves asynchronously (15-defs.js), typically a frame or
    // two after the renderer it is read off of exists, so a fresh
    // onRendererChange match join is not the only moment this needs to run.
    // Retry from the tick loop until it succeeds once; onRendererChange
    // still owns rebuilding the graphics for every match after the first,
    // since a new Renderer means the old graphics' layer container is gone.
    MOUSE.ctx.onRendererChange(function (renderer) {
        if (!renderer) return;
        build();
    });

    /**
     * Re-parents the graphics onto the current renderer and repositions it
     * as a world-space container. Returns false (without touching anything)
     * if the graphics doesn't exist yet or the camera hasn't been captured
     * yet - drawing at a stale or default transform would be worse than not
     * drawing for the handful of ticks this takes.
     */
    function reposition() {
        const ctx = MOUSE.ctx;
        const renderer = ctx.renderer;
        const above = MOUSE.overlay.above;
        if (!renderer || typeof renderer.addPIXIObj !== "function") return false;
        if (!isAlive(above)) return false;
        // The renderer this is about to hand objects to may itself have
        // been freed: Game.free() destroys the layer containers along with
        // the rest of the stage, and nothing about the game's own state
        // says "freed", so ctx can still be holding that Renderer for a few
        // frames afterwards. addPIXIObj would then addChild onto a
        // destroyed container and throw. `layers` is a plain, unmangled
        // field on client/src/renderer.ts's Renderer.
        const layers = renderer.layers;
        if (Array.isArray(layers)) {
            for (let i = 0; i < layers.length; i++) {
                if (!isAlive(layers[i])) return false;
            }
        }

        const p0 = ctx.worldToScreen({ x: 0, y: 0 });
        const s = ctx.worldScale();
        if (!p0 || !s) return false;

        above.position.set(p0.x, p0.y);
        above.scale.set(s, -s);

        const layer = (ctx.activePlayer && ctx.activePlayer.layer) || 0;
        renderer.addPIXIObj(above, layer, ABOVE_Z_ORD, ABOVE_Z_IDX);
        return true;
    }

    let frameCounter = 0;
    let lastEnsuredFrame = -1;
    let lastFrameOk = false;

    function ensureFrame() {
        if (frameCounter === lastEnsuredFrame) return lastFrameOk;
        lastEnsuredFrame = frameCounter;
        // Rebuild rather than merely reporting unavailable: the game
        // destroying the stage (see the file header) is not an error state
        // it will ever tell us about, and a match that carries on around a
        // dead overlay would otherwise never draw again.
        if (!MOUSE.overlay.available || !isAlive(MOUSE.overlay.above)) {
            build();
        }
        if (!MOUSE.overlay.available) {
            lastFrameOk = false;
            return false;
        }
        MOUSE.overlay.above.clear();
        lastFrameOk = reposition();
        return lastFrameOk;
    }
    MOUSE.overlay.ensureFrame = ensureFrame;

    // Advances the per-tick guard above, and retries build() until it
    // succeeds once for the current renderer - MOUSE.pixi resolves
    // asynchronously (15-defs.js) and is still null the first time
    // onRendererChange fires for a given match. Whether this listener
    // happens to fire before or after a consumer's own onTick in a given
    // frame does not matter - see the file header.
    MOUSE.ctx.onTick(function () {
        frameCounter++;
        if (!MOUSE.overlay.available && MOUSE.ctx.renderer) build();
    });

    MOUSE.log("overlay installed");
})();
