// 15-defs.js
//
// Resolves MOUSE.gameDefs: the same GameObjectDefs-style registry instance
// survev's own client uses internally (see shared/defs/gameObjectDefs.ts -
// a small class with typeToDef/typeToDefSafe, one instance per definition
// group), reached without any new bundle patch anchor.
//
// The gun defs never appear in the entry bundle 00-loader.js patches - they
// live in one of the chunks that entry bundle statically imports, which
// 00-loader.js only rewrites the *specifier* of (making it absolute, and
// recording it into MOUSE.chunkUrls) rather than patching. But ES module
// imports are cached per resolved URL for the whole document, not per
// importing script - so a *second*, independent `import()` of that same
// absolute URL from here hands back the exact live module instance the
// game's own entry bundle is using, not a fresh copy. No capture hook
// inside the patched bundle is needed at all, unlike renderer/playerBarn in
// 00-loader.js.
//
// The same scan also picks up MOUSE.pixiTexture: PIXI's own Texture class,
// which the skin changer needs to build and install replacement textures.
// It used to be read off a live sprite (ctx.activePlayer.bodySprite), which
// meant the whole Skin Changer - including the "Current" thumbnails in its
// window - stayed blank until a match had actually been joined, even though
// the gun art itself is in the `loadout` atlas the game loads for the main
// menu. Reaching the class through the module graph instead makes it
// available at menu time, with the live-sprite path kept as a fallback.
//
// Because there is no anchor to fail, this can't warn "the game updated"
// the way 00-loader.js's PATCHES do - if survev restructures its chunks
// enough that no export matches the shapes below, this simply never
// resolves and the affected MOUSE.* fields stay null forever. Every consumer
// is written to treat that as "unavailable" and fall back, so a failure
// here degrades a module rather than breaking it: 20-skins.js falls back on
// gameDefs/pixiTexture, and the Puzzle helper (via 16-overlay.js) goes quiet
// without MOUSE.pixi / MOUSE.mapDefs.
//
// Two more resolves piggyback on the exact same chunk rescan:
//  - MOUSE.pixi: {Graphics, Texture}. The chunk scan looks for a whole PIXI
//    namespace object carrying both together, which is the cheapest answer
//    when the bundler happens to emit one.
//  - MOUSE.mapDefs: the sibling "Map" def registry mentioned in
//    looksLikeGunDefs' own comment below - same typeToDefSafe shape as the
//    gun defs, but keyed on obstacle/building types instead of guns.
//
// As of survev 0.3.13 the bundler emits no such namespace: PIXI lives in a
// chunk that exports 68 individually-mangled bindings, and Graphics/Texture
// are not among them at all (the entry bundle imports what it needs by
// binding name). Read off the chunk alone, MOUSE.pixi stays null forever and
// everything built on 16-overlay.js silently draws nothing.
//
// So the classes are taken off *live objects* instead, which needs no
// export at all and cannot be broken by re-bundling:
//   Graphics <- renderer.ground / renderer.layerMask (client/src/renderer.ts
//               declares both as plain, unmangled PIXI.Graphics fields)
//   Texture  <- MOUSE.pixiTexture, or a live sprite's own texture
// Each candidate is still validated by the same looksLike* shape checks
// used for the chunk scan, so a wrong guess is rejected rather than
// installed. The chunk scan is kept as the first thing tried, because it
// resolves at menu time where the live path has to wait for a match.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    MOUSE.gameDefs = null;
    MOUSE.pixiTexture = null;
    MOUSE.pixi = null;
    MOUSE.mapDefs = null;

    /**
     * A def registry instance is identified by shape, not by its mangled
     * export name (which changes across survev builds): it must expose
     * typeToDefSafe, and asking it for "mp5" must return something with a
     * worldImg - narrow enough that nothing else in the bundle plausibly
     * matches, since only the gun def group has worldImg (the sibling "Map"
     * def registry the same chunk also exports has the same typeToDefSafe
     * shape, but returns undefined for a gun id).
     * @param {any} v
     */
    function looksLikeGunDefs(v) {
        if (!v || typeof v.typeToDefSafe !== "function") return false;
        try {
            const mp5 = v.typeToDefSafe("mp5");
            return !!(mp5 && mp5.worldImg);
        } catch (_e) {
            return false;
        }
    }

    /**
     * PIXI's Texture class, identified by its three static cache methods
     * rather than by name - `from` alone is far too common a static to be
     * conclusive, but nothing else in the bundle carries all of
     * from/addToCache/removeFromCache together.
     * @param {any} v
     */
    function looksLikeTextureClass(v) {
        return (
            typeof v === "function" &&
            typeof v.from === "function" &&
            typeof v.addToCache === "function" &&
            typeof v.removeFromCache === "function"
        );
    }

    /**
     * PIXI's Graphics class, identified by three real (unmangled - esbuild's
     * default minifier does not rename object property names) prototype
     * methods that only a drawing class would carry together.
     * @param {any} v
     */
    function looksLikeGraphicsClass(v) {
        return (
            typeof v === "function" &&
            !!v.prototype &&
            typeof v.prototype.beginFill === "function" &&
            typeof v.prototype.drawCircle === "function" &&
            typeof v.prototype.lineStyle === "function"
        );
    }

    /**
     * The whole PIXI namespace object, i.e. something carrying Texture and
     * Graphics together - only true when the bundler re-export
     * this chunk uses is a single namespace blob rather than per-class named
     * exports (see the header comment above for what happens otherwise).
     * @param {any} v
     */
    function looksLikePixiNamespace(v) {
        return (
            !!v &&
            typeof v === "object" &&
            looksLikeTextureClass(v.Texture) &&
            looksLikeGraphicsClass(v.Graphics)
        );
    }

    /**
     * The obstacle/building/map-object def registry - shares typeToDefSafe
     * with the gun defs (looksLikeGunDefs above already notes the two are
     * siblings from the same chunk) but is told apart by what it returns
     * for a *map* type id: "stone_04" (an eye rock, shared/defs/
     * mapObjectDefs.ts) resolves to something with both `.map` and `.img`,
     * which no gun id ever does.
     * @param {any} v
     */
    function looksLikeMapDefs(v) {
        if (!v || typeof v.typeToDefSafe !== "function") return false;
        try {
            const stone = v.typeToDefSafe("stone_04");
            return !!(stone && stone.map && stone.img);
        } catch (_e) {
            return false;
        }
    }

    // --- PIXI off live objects -------------------------------------------
    // See the header: the chunk scan cannot reach Graphics on current
    // survev builds, so this is the path that actually resolves in practice.
    // Both sources appear at match time (a Renderer and a Player have to
    // exist), which is exactly when anything drawing into the overlay could
    // start caring, so nothing is lost by the wait.

    /** The constructor an existing instance was built from. @param {any} obj */
    function ctorOf(obj) {
        if (!obj || typeof obj !== "object") return null;
        const proto = Object.getPrototypeOf(obj);
        return (proto && proto.constructor) || null;
    }

    /** True once MOUSE.pixi is an object this file built (and may still fill
     * in), as opposed to a real module namespace, which is immutable. */
    let pixiIsSynthetic = false;

    function resolvePixiFromLive() {
        const ctx = MOUSE.ctx;
        const renderer = ctx && ctx.renderer;
        const activePlayer = ctx && ctx.activePlayer;

        if (!MOUSE.pixi && renderer) {
            // `ground` and `layerMask` by name first, then anything else the
            // renderer happens to be holding - if survev ever renames or
            // drops both, some other Graphics on the same object will still
            // answer. Every candidate goes through the same shape check, so
            // a wrong guess is rejected rather than installed.
            const named = [renderer.ground, renderer.layerMask, renderer.debugLayerMask];
            let Graphics = null;
            for (let i = 0; i < named.length && !Graphics; i++) {
                const c = ctorOf(named[i]);
                if (looksLikeGraphicsClass(c)) Graphics = c;
            }
            for (const key in renderer) {
                if (Graphics) break;
                const c = ctorOf(renderer[key]);
                if (looksLikeGraphicsClass(c)) Graphics = c;
            }
            if (Graphics) {
                MOUSE.pixi = { Graphics: Graphics, Texture: MOUSE.pixiTexture || null };
                pixiIsSynthetic = true;
                MOUSE.log("pixi graphics class resolved (live renderer)");
            }
        }

        if (!MOUSE.pixiTexture && activePlayer) {
            const spr = activePlayer.bodySprite;
            const Texture = ctorOf(spr && spr.texture);
            if (looksLikeTextureClass(Texture)) {
                MOUSE.pixiTexture = Texture;
                MOUSE.log("pixi texture class resolved (live sprite)");
            }
        }

        if (pixiIsSynthetic && !MOUSE.pixi.Texture && MOUSE.pixiTexture) {
            MOUSE.pixi.Texture = MOUSE.pixiTexture;
        }
    }

    const triedUrls = new Set();
    let resolving = false;

    function allResolved() {
        return !!(MOUSE.gameDefs && MOUSE.pixiTexture && MOUSE.pixi && MOUSE.mapDefs);
    }

    async function tryResolve() {
        if (allResolved() || resolving) return;
        const urls = /** @type {string[]} */ (MOUSE.chunkUrls || []);
        const fresh = urls.filter(function (u) {
            return !triedUrls.has(u);
        });
        if (!fresh.length) return;
        resolving = true;
        try {
            for (let i = 0; i < fresh.length; i++) {
                const url = fresh[i];
                triedUrls.add(url);
                let ns;
                try {
                    ns = await import(url);
                } catch (_e) {
                    continue; // not a module, or failed to fetch - not our chunk
                }
                const name = url.split("/").pop();
                for (const key in ns) {
                    const v = ns[key];
                    if (!MOUSE.gameDefs && looksLikeGunDefs(v)) {
                        MOUSE.gameDefs = v;
                        MOUSE.log("gun defs resolved (" + name + ")");
                    }
                    if (!MOUSE.mapDefs && looksLikeMapDefs(v)) {
                        MOUSE.mapDefs = v;
                        MOUSE.log("map defs resolved (" + name + ")");
                    }
                    // PIXI may be re-exported either as the class itself or
                    // as a whole namespace object, depending on how the
                    // bundler split it up; accept both.
                    if (!MOUSE.pixiTexture) {
                        if (looksLikeTextureClass(v)) {
                            MOUSE.pixiTexture = v;
                        } else if (v && typeof v === "object" && looksLikeTextureClass(v.Texture)) {
                            MOUSE.pixiTexture = v.Texture;
                        }
                        if (MOUSE.pixiTexture) MOUSE.log("pixi texture class resolved (" + name + ")");
                    }
                    if (!MOUSE.pixi && looksLikePixiNamespace(v)) {
                        MOUSE.pixi = v;
                        MOUSE.log("pixi namespace resolved (" + name + ")");
                    }
                    if (allResolved()) return;
                }
            }
        } finally {
            resolving = false;
        }
    }

    // MOUSE.chunkUrls is only populated once the entry bundle has actually
    // been fetched and patched (asynchronous - see 00-loader.js), so this
    // is a no-op most early ticks until it fills in, then resolves once and
    // goes quiet (the `allResolved()` guard above, plus `triedUrls`, which
    // means a chunk is only ever imported and scanned once).
    MOUSE.ctx.onTick(function () {
        if (allResolved()) return;
        tryResolve();
        resolvePixiFromLive();
    });

    MOUSE.log("defs resolver installed");
})();
