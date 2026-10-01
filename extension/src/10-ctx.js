// 10-ctx.js
//
// Turns whatever 00-loader.js managed to capture into a stable, friendly
// handle: window.__MOUSE.ctx. Everything here is duck-typed against shape
// (which methods/fields an object has) rather than assumed by import path,
// because the objects we get from the patched bundle are raw runtime
// instances of minified classes with no exported names to check against.
//
// ctx.ready is false until every lookup below succeeds. Modules must check
// it before touching anything; when it is false they should simply do
// nothing for that tick rather than throw.
//
// Caching strategy: cache the *key name*, never the value. `Game.init()`
// (client/src/game.ts) constructs a brand new Renderer/PlayerBarn/LootBarn/
// UiManager on every single match join and `Game.free()` discards them when
// a match ends - but `Game` itself is one long-lived object for the whole
// page session, and the mangled property name a subsystem lives under does
// not change between builds. So the *first* time a lookup succeeds, this
// remembers which property name on `game` held it, and every later tick
// just reads `game[thatName]` fresh - which automatically follows whatever
// Game.init() most recently assigned there, with no per-match reset logic
// needed at all. (v1 cached the resolved *object* instead, which is why it
// only ever worked for the first match.)

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    // Mirrors shared/gameConfig.ts Input enum. Only the four movement
    // entries are named - Null binds is the one module that needs any - but
    // each has to land on exactly the index the real enum gives it, because
    // these numbers are what the game itself passes to isBindDown: a wrong
    // index silently listens to (or suppresses) a different action entirely,
    // whatever the player has bound. Re-check them against
    // shared/gameConfig.ts whenever MOUSE.TARGET moves.
    const Input = {
        MoveLeft: 0,
        MoveRight: 1,
        MoveUp: 2,
        MoveDown: 3,
    };

    const ctx = {
        ready: false,
        renderer: /** @type {any} */ (null),
        game: /** @type {any} */ (null),
        playerBarn: /** @type {any} */ (null),
        inputBinds: /** @type {any} */ (null),
        activePlayer: /** @type {any} */ (null),
        /** The live client/src/map.ts Map, or null before one exists. */
        map: /** @type {any} */ (null),
        /** Which game mode is being played - see readMode below. Null until a
         * map has actually loaded. */
        mode: /** @type {any} */ (null),
        /** The live client/src/map.ts Map's obstacle Pool, or null before it
         * can be located (see findObstaclePool below). */
        obstaclePool: /** @type {any} */ (null),
        /** The live client/src/map.ts Map's building Pool, or null before it
         * can be located (see findBuildingPool below). */
        buildingPool: /** @type {any} */ (null),
        /** The live client/src/map.ts Map's structure Pool, or null before
         * it can be located (see findStructurePool below). */
        structurePool: /** @type {any} */ (null),
        /** The live client/src/ui/ui2.ts UiManager2. Exposes newState/
         * oldState/dom for HUD readouts. */
        ui2: /** @type {any} */ (null),
        /** The live client/src/gas.ts Gas, or null before one exists. */
        gas: /** @type {any} */ (null),
        /** The live client/src/camera.ts Camera, or null until a Player has
         * rendered at least once - see installCameraCapture below. */
        camera: /** @type {any} */ (null),
        Input: Input,
        /** Reasons the last resolve attempt failed, for the GUI status panel. */
        missing: /** @type {string[]} */ ([]),
    };

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    /**
     * @param {any} obj
     * @param {string} prop
     */
    function hasFn(obj, prop) {
        return !!obj && typeof obj[prop] === "function";
    }

    /**
     * @param {any} v
     * @param {string[]} shapeKeys
     */
    function matchesShape(v, shapeKeys) {
        if (!v || typeof v !== "object") return false;
        for (let i = 0; i < shapeKeys.length; i++) {
            if (v[shapeKeys[i]] === undefined) return false;
        }
        return true;
    }

    /**
     * Finds the *name* of the first own-property of `obj` whose value
     * matches `shapeKeys`. Returns the key, not the value, so callers can
     * cache it and keep reading `obj[key]` live afterward.
     * @param {any} obj
     * @param {string[]} shapeKeys
     */
    function findKeyByShape(obj, shapeKeys) {
        if (!obj) return null;
        for (const k in obj) {
            if (!hasOwn(obj, k)) continue;
            if (matchesShape(obj[k], shapeKeys)) return k;
        }
        return null;
    }

    /**
     * Finds the one own-property of `obj` whose value is an Array. Used to
     * locate a Pool's internal storage array, whose real field name (m_pool)
     * is mangled but is reliably the pool's only array-valued own property.
     * @param {any} obj
     */
    function findArrayProp(obj) {
        if (!obj) return null;
        for (const k in obj) {
            if (hasOwn(obj, k) && Array.isArray(obj[k])) return obj[k];
        }
        return null;
    }

    /**
     * @param {any} pool a captured *Barn's `xPool` field (a Pool instance)
     * @returns {any[]} the pool's backing array (may be empty, never null)
     */
    function poolArray(pool) {
        return findArrayProp(pool) || [];
    }
    ctx.poolArray = poolArray;

    /**
     * Mirrors shared/utils/util.ts sameLayer(): two layers are "the same"
     * for visibility purposes if their ground/underground bit matches, or
     * either one is flagged as a stairs-transition layer (bit 2).
     * @param {number} a
     * @param {number} b
     */
    function sameLayer(a, b) {
        return (a & 1) === (b & 1) || Boolean(a & 2 && b & 2);
    }
    ctx.sameLayer = sameLayer;

    /**
     * True once the game's own in-match screen is actually showing -
     * independent of ctx.ready, which stays true well past a match ending.
     * Game.free() (client/src/game.ts) only empties the PIXI stage; it never
     * touches playerBarn/lootBarn/activePlayer on the `game` object itself,
     * so those keep answering with the previous match's now-dead data all
     * the way until the *next* match's Game.init() replaces them - which
     * can be indefinitely, if you sit on the main menu between matches. That
     * staleness is harmless for a module that only touches game-owned PIXI
     * sprites (they vanished with the stage regardless), but a module that
     * writes to its own plain DOM elements - the HUD readouts - has to check
     * this too, or it keeps showing frozen numbers back on the menu.
     *
     * client/src/main.ts's App toggles `#game-area-wrapper` between
     * `display: none` (the element's own default in index.html, shown while
     * on the main menu) and `display: block` the moment tryJoinGame
     * succeeds (`refreshUi`'s `this.active` flag) - so its computed display
     * is a direct, always-current answer to "is the match screen up right
     * now", with no caching needed since App is the one thing that toggles
     * it and does so exactly on the transitions that matter.
     */
    function inGameScreen() {
        const el = document.getElementById("game-area-wrapper");
        return !!el && getComputedStyle(el).display !== "none";
    }
    ctx.inGameScreen = inGameScreen;

    /**
     * True while the game's own death/game-over screen (`#ui-stats`) is up -
     * shown by both showStats() (full team elimination or match end) and
     * showTeamAd() (you died but your squad/team lives on), client/src/ui/
     * ui.ts. `inGameScreen()` alone cannot tell this apart from being alive
     * mid-match, since `#game-area-wrapper` stays visible under the stats
     * screen too.
     */
    function showingStats() {
        const el = document.getElementById("ui-stats");
        return !!el && getComputedStyle(el).display !== "none";
    }
    ctx.showingStats = showingStats;

    // --- Key-name-cached lookups off `game` --------------------------------
    // One entry per subsystem: the shape used to find it, and the cached key
    // name once found. `read()` trusts the cached key until it stops
    // producing a value matching the shape, which only happens if the game
    // itself changes structure (a real update), never across ordinary
    // match joins.
    function makeLookup(shapeKeys) {
        let key = null;
        return {
            read(game) {
                if (!game) return null;
                if (key !== null) {
                    const cached = game[key];
                    if (matchesShape(cached, shapeKeys)) return cached;
                    key = null; // stale; fall through and re-scan once
                }
                key = findKeyByShape(game, shapeKeys);
                return key !== null ? game[key] : null;
            },
        };
    }

    const playerBarnLookup = makeLookup(["playerPool", "getPlayerById"]);
    const inputBindsLookup = makeLookup(["isBindPressed", "isBindDown"]);
    const activePlayerLookup = makeLookup(["bodySprite", "container", "__id"]);
    // UiManager2 (client/src/ui/ui2.ts) is the HUD state/render manager.
    // uiEvents/newState/dom are all plain fields declared without an m_
    // prefix.
    const ui2Lookup = makeLookup(["uiEvents", "newState", "dom"]);
    // client/src/gas.ts's Gas - circleOld/circleNew/duration are plain
    // fields set in its constructor, present from the moment Game.init()
    // builds one. `mode` (its GasMode enum: 0 Inactive, 1 Waiting,
    // 2 Moving) is what 36-timerhud.js's match-timer tracking watches for
    // transitions.
    const gasLookup = makeLookup(["circleOld", "circleNew", "duration"]);
    // The Map is where the game's own answer to "which mode is this?" lives.
    // mapName/mapDef/factionMode/perkMode are all plain, unmangled fields on
    // client/src/map.ts's Map (only its m_-prefixed members get mangled), and
    // all four are initialized at construction, so this shape matches from
    // the moment Game.init() builds one rather than only once a map loads.
    const mapLookup = makeLookup(["mapName", "mapDef", "factionMode", "perkMode"]);

    /**
     * The gameMode flags from shared/defs/mapDefs.ts for the map currently
     * loaded, or null until one actually has (Map starts life with an empty
     * mapDef). Read off mapDef rather than off Map's own mirrored fields
     * because Map only mirrors some of them - woodsMode and desertMode exist
     * on the def but never make it onto the instance.
     * @param {any} map
     */
    function readMode(map) {
        const gm = map && map.mapDef && map.mapDef.gameMode;
        if (!gm || typeof gm !== "object") return null;
        return {
            /** the MapDefs key, e.g. "woods_snow" or "cobalt" */
            name: typeof map.mapName === "string" ? map.mapName : "",
            woods: !!gm.woodsMode,
            desert: !!gm.desertMode,
            potato: !!gm.potatoMode,
            faction: !!gm.factionMode,
            perk: !!gm.perkMode,
            turkey: !!gm.turkeyMode,
        };
    }

    // --- netData: activePlayer.<mangled netData> ---------------------------
    // netData is identified by carrying both an "outfit"-classified and a
    // "backpack"-classified string field at once - both are always non-empty
    // (default outfit and a level-0 "Pouch" backpack are equipped from the
    // moment you spawn), so this signature is available immediately, unlike
    // helmet/chest which start out as "" (no armor equipped yet). netData is
    // what carries a player's outfit, which Anti-Cosmetics rewrites, and
    // their raw networked position, which Lag smoothing buffers (netPos
    // below).
    function looksLikeNetData(v) {
        if (!v || typeof v !== "object" || Array.isArray(v)) return false;
        let hasOutfit = false;
        let hasBackpack = false;
        for (const k in v) {
            if (!hasOwn(v, k)) continue;
            const val = v[k];
            if (typeof val !== "string" || !val) continue;
            const cat = MOUSE.items.ITEM_CATEGORY[val];
            if (cat === "outfit") hasOutfit = true;
            else if (cat === "backpack") hasBackpack = true;
        }
        return hasOutfit && hasBackpack;
    }

    let netDataKey = null;
    /**
     * Public on purpose: the mangled key
     * is the same field name on every Player instance, so once found off
     * any one player it applies to all of them - a module that needs a
     * *third-party* player's netData (Anti-Cosmetics, Lag smoothing) has no
     * other way to reach it.
     * @param {any} activePlayer really: any live Player instance
     */
    function readNetData(activePlayer) {
        if (!activePlayer) return null;
        if (netDataKey !== null) {
            const cached = activePlayer[netDataKey];
            if (looksLikeNetData(cached)) return cached;
            netDataKey = null;
        }
        for (const k in activePlayer) {
            if (!hasOwn(activePlayer, k)) continue;
            if (looksLikeNetData(activePlayer[k])) {
                netDataKey = k;
                return activePlayer[k];
            }
        }
        return null;
    }
    ctx.readNetData = readNetData;

    // --- Obstacles: map.<mangled obstaclePool> -----------------------------
    // Every Pool instance (obstaclePool, buildingPool, structurePool, ...)
    // is the same generic class with the same mangled backing-array field,
    // so a Pool cannot be told apart from another Pool by its own shape -
    // only by what is *inside* it. isWall/isBush/isDoor/type are plain
    // fields on client/src/objects/obstacle.ts's Obstacle, so the first
    // live obstacle in a candidate pool's array is enough to identify it.
    function looksLikeObstacle(v) {
        return (
            !!v
            && typeof v === "object"
            && typeof v.type === "string"
            && (v.isWall !== undefined || v.isBush !== undefined || v.isDoor !== undefined)
        );
    }

    let obstaclePoolKey = null;
    /** @param {any} map */
    function findObstaclePool(map) {
        if (!map) return null;
        if (obstaclePoolKey !== null) {
            const cached = map[obstaclePoolKey];
            const arr = findArrayProp(cached);
            if (arr && arr.length && looksLikeObstacle(arr[0])) return cached;
            obstaclePoolKey = null; // stale; re-scan once
        }
        for (const k in map) {
            if (!hasOwn(map, k)) continue;
            const arr = findArrayProp(map[k]);
            // A freshly-loaded map's obstacle array is not empty by the time
            // a match is playable, but guard anyway and simply retry next
            // tick rather than caching an empty/wrong pool.
            if (arr && arr.length && looksLikeObstacle(arr[0])) {
                obstaclePoolKey = k;
                return map[k];
            }
        }
        return null;
    }

    // --- Buildings: map.<mangled buildingPool> ------------------------------
    // Same trick as findObstaclePool, one level up: type/ori/ceilingDead are
    // plain fields on client/src/objects/building.ts's Building, present on
    // every building (hasPuzzle or not) from construction.
    function looksLikeBuilding(v) {
        return (
            !!v
            && typeof v === "object"
            && typeof v.type === "string"
            && typeof v.ori === "number"
            && v.ceilingDead !== undefined
        );
    }

    let buildingPoolKey = null;
    /** @param {any} map */
    function findBuildingPool(map) {
        if (!map) return null;
        if (buildingPoolKey !== null) {
            const cached = map[buildingPoolKey];
            const arr = findArrayProp(cached);
            if (arr && arr.length && looksLikeBuilding(arr[0])) return cached;
            buildingPoolKey = null; // stale; re-scan once
        }
        for (const k in map) {
            if (!hasOwn(map, k)) continue;
            const arr = findArrayProp(map[k]);
            if (arr && arr.length && looksLikeBuilding(arr[0])) {
                buildingPoolKey = k;
                return map[k];
            }
        }
        return null;
    }

    // --- Structures: map.<mangled structurePool> ----------------------------
    // Same trick again. A Structure (client/src/objects/structure.ts) is the
    // object that ties a bunker's surface building to its sublevel one and
    // owns the stairs between them, and layers/stairs/mask are all plain
    // fields on it, rebuilt on every full update. Nothing else in the map
    // carries a `stairs` array, so that alone identifies the pool.
    function looksLikeStructure(v) {
        return (
            !!v
            && typeof v === "object"
            && typeof v.type === "string"
            && Array.isArray(v.stairs)
            && Array.isArray(v.layers)
        );
    }

    let structurePoolKey = null;
    /** @param {any} map */
    function findStructurePool(map) {
        if (!map) return null;
        if (structurePoolKey !== null) {
            const cached = map[structurePoolKey];
            const arr = findArrayProp(cached);
            if (arr && arr.length && looksLikeStructure(arr[0])) return cached;
            structurePoolKey = null; // stale; re-scan once
        }
        for (const k in map) {
            if (!hasOwn(map, k)) continue;
            const arr = findArrayProp(map[k]);
            if (arr && arr.length && looksLikeStructure(arr[0])) {
                structurePoolKey = k;
                return map[k];
            }
        }
        return null;
    }

    /** Attempts to fill in every ctx field from what has been captured so far. */
    function resolve() {
        const missing = [];

        const renderer = MOUSE.captured.renderer;
        if (!renderer) {
            missing.push("renderer (waiting on addPIXIObj call)");
            ctx.ready = false;
            ctx.missing = missing;
            return;
        }
        ctx.renderer = renderer;
        notifyRendererChange(renderer);

        // renderer.game is a plain, non-mangled field on the live Renderer.
        const game = renderer.game;
        if (!game) missing.push("game (renderer.game was empty)");
        ctx.game = game || null;

        let playerBarn = playerBarnLookup.read(game);
        if (!playerBarn && MOUSE.captured.playerBarn) {
            // Fallback: the getPlayerById patch anchor captures directly,
            // independent of walking `game`'s own properties.
            playerBarn = MOUSE.captured.playerBarn;
        }
        if (!playerBarn) missing.push("playerBarn");
        ctx.playerBarn = playerBarn || null;

        const inputBinds = inputBindsLookup.read(game);
        if (!inputBinds) {
            missing.push("inputBinds");
        } else {
            installInputOverride(inputBinds);
        }
        ctx.inputBinds = inputBinds || null;

        const activePlayer = activePlayerLookup.read(game);
        ctx.activePlayer = activePlayer || null;
        if (!activePlayer) missing.push("activePlayer (not in a match yet)");
        if (activePlayer) installCameraCapture(activePlayer);

        // Deliberately not part of ctx.ready: a module that does not care
        // which mode it is should keep working if this one lookup ever
        // stops resolving.
        const map = mapLookup.read(game);
        ctx.map = map || null;
        ctx.mode = readMode(map);
        ctx.obstaclePool = findObstaclePool(map);
        ctx.buildingPool = findBuildingPool(map);
        ctx.structurePool = findStructurePool(map);

        ctx.ui2 = ui2Lookup.read(game) || null;
        ctx.gas = gasLookup.read(game) || null;

        ctx.missing = missing;
        ctx.ready = !!(renderer && game && playerBarn && inputBinds && activePlayer);
    }

    // --- Renderer-change notification --------------------------------------
    // Fires whenever the *instance* behind ctx.renderer changes, which
    // happens exactly once per match (Game.init() builds a fresh Renderer
    // each join). 16-overlay.js uses this to rebuild its graphics for the
    // new instance instead of quietly drawing into one nobody uses anymore.
    let lastRenderer = null;
    const rendererChangeListeners = /** @type {Array<(renderer: any) => void>} */ ([]);
    function notifyRendererChange(renderer) {
        if (renderer === lastRenderer) return;
        lastRenderer = renderer;
        for (let i = 0; i < rendererChangeListeners.length; i++) {
            try {
                rendererChangeListeners[i](renderer);
            } catch (e) {
                MOUSE.warn("onRendererChange listener threw", e);
            }
        }
    }
    /** @param {(renderer: any) => void} fn called immediately with the current renderer if one exists, then again every time it changes. */
    function onRendererChange(fn) {
        rendererChangeListeners.push(fn);
        if (ctx.renderer) fn(ctx.renderer);
    }
    ctx.onRendererChange = onRendererChange;

    // --- Camera capture -----------------------------------------------------
    // client/src/objects/player.ts's Player.prototype.render(camera, debug)
    // is a plain, non-mangled method that every Player instance shares and
    // that runs once per player per frame - so wrapping it on the prototype
    // (found off any live Player, not just the active one) hands over the
    // live Camera with no extra bundle patch anchor. The prototype is the
    // same object for the whole page session (Game.init() only replaces
    // *instances*, never the class), so this installs exactly once and
    // never needs a re-attach hook the way renderer wraps do.
    let cameraCaptureInstalled = false;
    /** @param {any} activePlayer */
    function installCameraCapture(activePlayer) {
        if (cameraCaptureInstalled) return;
        const proto = Object.getPrototypeOf(activePlayer);
        if (!proto || typeof proto.render !== "function") return;
        const original = proto.render;
        proto.render = function (camera, debug) {
            ctx.camera = camera;
            return original.call(this, camera, debug);
        };
        cameraCaptureInstalled = true;
        MOUSE.log("camera capture installed (Player.prototype.render)");
    }

    // client/src/camera.ts's Camera class has every single field m_-prefixed
    // (so all 11 get a fresh random name every build) and no public methods
    // either - but property declaration order is preserved by the engine
    // regardless of what the names get mangled to, and the class is small
    // enough that a positional read plus a value sanity check is reliable:
    // fields 0/1/2/3/4/5 in declaration order are m_pos ({x,y}), m_ppu
    // (always exactly 16 - never modified anywhere in the client), m_zoom
    // and m_targetZoom (small positive numbers), and m_screenWidth/
    // m_screenHeight (real pixel dimensions). Fields 8 and 10 are
    // m_interpEnabled (a bool) and m_interpInterval (a non-negative number
    // of seconds); nothing reads them, but their types are two more cheap
    // checks that the positional guess landed on the right class. This is
    // deliberately *not* a method-probing approach: calling an unknown
    // zero-arg method on Camera to see what it returns risks tripping one
    // of its three boolean setters (m_setShakeEnabled/m_setInterpEnabled/
    // m_setRotationEnabled) with a wrong argument, which a pure property
    // read can never do.
    let cameraFieldKeys = null;
    /** @param {any} camera */
    function resolveCameraFields(camera) {
        if (!camera) return null;
        if (cameraFieldKeys) {
            const c = cameraFieldKeys;
            const pos = camera[c.pos];
            if (
                camera[c.ppu] === 16
                && pos && typeof pos.x === "number" && typeof pos.y === "number"
                && typeof camera[c.zoom] === "number" && camera[c.zoom] > 0
                && typeof camera[c.targetZoom] === "number"
                && typeof camera[c.screenW] === "number" && camera[c.screenW] > 0
                && typeof camera[c.screenH] === "number" && camera[c.screenH] > 0
                && typeof camera[c.interpEnabled] === "boolean"
                && typeof camera[c.interpInterval] === "number" && camera[c.interpInterval] >= 0
            ) {
                return c;
            }
            cameraFieldKeys = null; // stale; re-scan once
        }
        const keys = Object.keys(camera);
        if (keys.length < 11) return null;
        const posKey = keys[0];
        const ppuKey = keys[1];
        const zoomKey = keys[2];
        const targetZoomKey = keys[3];
        const screenWKey = keys[4];
        const screenHKey = keys[5];
        const interpEnabledKey = keys[8];
        const interpIntervalKey = keys[10];
        const pos = camera[posKey];
        if (
            camera[ppuKey] === 16
            && pos && typeof pos.x === "number" && typeof pos.y === "number"
            && typeof camera[zoomKey] === "number" && camera[zoomKey] > 0
            && typeof camera[targetZoomKey] === "number"
            && typeof camera[screenWKey] === "number" && camera[screenWKey] > 0
            && typeof camera[screenHKey] === "number" && camera[screenHKey] > 0
            && typeof camera[interpEnabledKey] === "boolean"
            && typeof camera[interpIntervalKey] === "number" && camera[interpIntervalKey] >= 0
        ) {
            cameraFieldKeys = {
                pos: posKey,
                ppu: ppuKey,
                zoom: zoomKey,
                targetZoom: targetZoomKey,
                screenW: screenWKey,
                screenH: screenHKey,
                interpEnabled: interpEnabledKey,
                interpInterval: interpIntervalKey,
            };
            return cameraFieldKeys;
        }
        return null;
    }

    /**
     * Reimplements Camera.prototype.m_pointToScreen without ever needing
     * its mangled name: screen.x = screenWidth/2 + (worldX - camX) * ppu *
     * zoom, screen.y = screenHeight/2 - (worldY - camY) * ppu * zoom (world
     * y is up, screen y is down). Returns null until the camera has been
     * captured and its fields resolved.
     * @param {{x: number, y: number}} p world position
     */
    function worldToScreen(p) {
        const camera = ctx.camera;
        const k = resolveCameraFields(camera);
        if (!k) return null;
        const z = camera[k.ppu] * camera[k.zoom];
        const camPos = camera[k.pos];
        return {
            x: camera[k.screenW] * 0.5 + (p.x - camPos.x) * z,
            y: camera[k.screenH] * 0.5 - (p.y - camPos.y) * z,
        };
    }
    ctx.worldToScreen = worldToScreen;

    /**
     * The active player's own world position, or null until the camera has
     * been captured. Taken off the camera rather than off the player
     * because the player's own position field is m_-prefixed and therefore
     * mangled, while client/src/game.ts's update copies the active player's
     * visual position straight onto the camera every frame
     * (`camera.m_pos = v2.copy(activePlayer.m_visualPos)`) - so this is the
     * rendered player position, off by at most the sub-unit interpolation
     * the camera itself applies.
     */
    function playerPos() {
        const camera = ctx.camera;
        const k = resolveCameraFields(camera);
        if (!k) return null;
        const p = camera[k.pos];
        return p && typeof p.x === "number" ? { x: p.x, y: p.y } : null;
    }

    /** Screen pixels per world unit at the current zoom, or null until the
     * camera has been captured. Mirrors Camera.prototype.m_scaleToScreen. */
    function worldScale() {
        const camera = ctx.camera;
        const k = resolveCameraFields(camera);
        if (!k) return null;
        return camera[k.ppu] * camera[k.zoom];
    }
    ctx.worldScale = worldScale;

    /**
     * Whether a PIXI display object the game owns is still usable. PIXI's
     * destroy() leaves the object reachable but nulls its internals, and
     * `position` is a getter over `transform.position` - so merely *reading*
     * container.position on a destroyed container throws "Cannot read
     * properties of null (reading 'position')". client/src/game.ts's
     * Game.free() destroys the whole stage with `destroy({children: true})`
     * every time a match ends, and nothing about the game's own state says
     * "freed" (see 16-overlay.js's header for the same problem one level
     * up), so ctx can still be holding an activePlayer whose container has
     * been gutted for a few frames afterwards. Anything that reads
     * `.position` off a game display object goes through this first.
     * @param {any} obj
     */
    function displayAlive(obj) {
        return !!(obj && !obj.destroyed && obj.transform);
    }
    ctx.displayAlive = displayAlive;

    // --- Raw networked position ---------------------------------------------
    // netData's m_pos is the position exactly as the last UpdateMsg carried
    // it - no interpolation, no camera shake - which is what anything that
    // timestamps positions needs (Lag smoothing's snapshot buffer). The field
    // is mangled, but it is the same name on every Player's netData for the
    // life of the page, so it is resolved once by agreement with the camera
    // position (the active player's rendered position, never more than a
    // few units behind the wire one) and then only re-resolved if it stops
    // holding a vector. m_dir is the only other {x,y} field on netData and
    // is a unit vector, so it cannot pass that check unless you are
    // standing within 2.5 units of world origin - not a real case.
    let netPosKey = /** @type {string | null} */ (null);

    function resolveNetPosKey() {
        const netData = readNetData(ctx.activePlayer);
        const ref = playerPos();
        if (!netData || !ref) return null;
        for (const k in netData) {
            const v = netData[k];
            if (!v || typeof v.x !== "number" || typeof v.y !== "number") continue;
            if (Math.hypot(v.x - ref.x, v.y - ref.y) < 2.5) return k;
        }
        return null;
    }

    /**
     * `p`'s position as last received from the server, or null until the
     * field has been resolved. The returned object is the game's own: treat
     * it as read-only. client/src/objects/player.ts replaces it with a fresh
     * copy on every update that includes the player rather than mutating it
     * in place, so holding on to the reference is itself a valid snapshot,
     * and a reference change means a new update arrived.
     * @param {any} p @returns {{x: number, y: number} | null}
     */
    function netPos(p) {
        const netData = readNetData(p);
        if (!netData) return null;
        let v = netPosKey !== null ? netData[netPosKey] : null;
        if (!v || typeof v.x !== "number" || typeof v.y !== "number") {
            netPosKey = resolveNetPosKey();
            v = netPosKey !== null ? netData[netPosKey] : null;
        }
        return v && typeof v.x === "number" && typeof v.y === "number" ? v : null;
    }
    ctx.netPos = netPos;

    // --- Input suppression -------------------------------------------------
    // Wraps inputBinds.isBindPressed/isBindDown exactly once. A per-input
    // flag set by ctx.suppressInput() makes both report that input as not
    // held. It is level-triggered: a module that wants "this input reads as
    // not-held right now" (Null binds suppressing whichever of a held
    // opposing pair lost) has to keep re-asserting it every tick, because
    // the game samples isBindDown continuously rather than once. Flags are
    // cleared at the top of this file's own frame callback (see the tick
    // loop below), so a module that stops calling ctx.suppressInput(x) -
    // disabled, threw, unloaded - has the suppression lift again within one
    // frame with no separate teardown path needed.
    //
    // Nothing here ever *raises* an input: the client only ever withholds
    // one of the player's own held keys, never presses anything for them.
    //
    // inputBinds itself is owned by the outer Application (passed into Game
    // as a constructor parameter) and is never recreated by Game.init(), so
    // this override does not need any re-attach logic - it is installed
    // once and stays valid for the life of the page.
    const suppressed = /** @type {Record<number, boolean>} */ ({});
    let overrideInstalled = false;

    /** The unwrapped isBindDown, once captured - lets a module (Null binds)
     * read the player's genuine hold state for the very input it might
     * itself be suppressing, without seeing its own output. */
    let rawIsBindDown = /** @type {((bind: number) => any) | null} */ (null);

    /** @param {any} inputBinds */
    function installInputOverride(inputBinds) {
        if (overrideInstalled) return;
        if (!hasFn(inputBinds, "isBindPressed") || !hasFn(inputBinds, "isBindDown")) return;
        const original = inputBinds.isBindPressed.bind(inputBinds);
        const originalDown = inputBinds.isBindDown.bind(inputBinds);
        rawIsBindDown = originalDown;

        inputBinds.isBindPressed = function (bind) {
            if (suppressed[bind]) return false;
            return original(bind);
        };

        // isBindDown drives movement directly - game.ts builds
        // inputMsg.moveLeft/Right/Up/Down from exactly these four calls -
        // so suppressing here is what makes the server see one direction
        // instead of two cancelling each other out.
        inputBinds.isBindDown = function (bind) {
            if (suppressed[bind]) return false;
            return originalDown(bind);
        };

        overrideInstalled = true;
        MOUSE.log("input override installed");
    }

    /**
     * Makes isBindDown (and isBindPressed) report `input` as not held, for
     * as long as something keeps calling this every tick - see the note
     * above for why this is level- rather than edge-triggered. Pass
     * `on: false` (or simply stop calling it) to let the real value through
     * again.
     * @param {number} input one of the ctx.Input values
     * @param {boolean} on
     */
    function suppressInput(input, on) {
        suppressed[input] = !!on;
    }
    ctx.suppressInput = suppressInput;

    /** The real, unwrapped isBindDown for one input - what the player is
     * genuinely holding, ignoring any suppression this file is applying.
     * Null before inputBinds has been captured at least once.
     * @param {number} input one of the ctx.Input values
     */
    function rawBindDown(input) {
        if (!rawIsBindDown) return null;
        try {
            return !!rawIsBindDown(input);
        } catch (_e) {
            return null;
        }
    }
    ctx.rawBindDown = rawBindDown;

    /** Drops every suppression flag. Called once at the top of the frame
     * callback below, so a suppression stops the instant its owning module
     * stops re-asserting it. */
    function clearSuppressedInputs() {
        for (const key in suppressed) {
            if (suppressed[key]) suppressed[key] = false;
        }
    }

    // --- Tick loop ---------------------------------------------------------
    const tickListeners = /** @type {Array<(dt: number, ctx: any) => void>} */ ([]);
    /** @param {(dt: number, ctx: any) => void} fn */
    function onTick(fn) {
        tickListeners.push(fn);
    }
    ctx.onTick = onTick;

    let lastTime = performance.now();
    function frame(now) {
        const dt = Math.min((now - lastTime) / 1000, 0.25);
        lastTime = now;

        clearSuppressedInputs();
        resolve();

        for (let i = 0; i < tickListeners.length; i++) {
            try {
                tickListeners[i](dt, ctx);
            } catch (e) {
                MOUSE.warn("tick listener threw", e);
            }
        }

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    MOUSE.ctx = ctx;
    MOUSE.log("ctx resolver installed");
})();
