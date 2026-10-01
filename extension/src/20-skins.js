// 20-skins.js
//
// Skin Changer: overrides specific guns' loot icon and/or in-world sprite
// with an older version, sourced from 14-skins-data.js (generated from the
// asset library under assets/ by tools/gen-skins-data.py - see that file and
// docs/SKINS.md). The GUI for
// picking versions lives in 32-gui-skins.js; this file only owns the actual
// texture-swap engine and the module's enabled/disabled lifecycle. A hidden
// module (see 12-modules.js) - it is enabled, ticked, and bindable exactly
// like any other module, it just renders its controls in its own window
// (32-gui-skins.js) instead of a row in the main panel.
//
// How the swap works: every sprite in the game resolves through
// PIXI.Texture.from("<name>.img") (client/src/objects/loot.ts,
// client/src/objects/player.ts) against PIXI's own global texture cache -
// there is one such cache for the whole page, not one per match. Swapping a
// cache entry (Texture.removeFromCache + Texture.addToCache) redirects every
// *future* Texture.from(name) call, which is enough for anything not yet on
// screen (a fresh loot spawn, a player who re-equips). Anything already
// rendered is still holding a reference to the *old* Texture object, so
// after swapping the cache entry this also walks the live scene graph
// (ctx.renderer.layers, non-mangled) and repoints any Sprite already
// displaying the old Texture at the new one.
//
// The Texture class comes from 15-defs.js (MOUSE.pixiTexture), which finds it
// by re-importing the game's own chunks and matching PIXI's Texture by
// shape. That resolves at page load, before any match, which is what lets
// the Skin Changer window fill in its "Current" thumbnails while you're
// still on the menu - the gun art lives in the `loadout` atlas, and the
// game loads that for the menu itself. If that scan ever comes up empty
// this falls back to reading the class off a live Sprite instance
// (ctx.activePlayer's bodySprite, already part of 10-ctx.js's activePlayer
// shape check), which is the older, match-only path.
//
// A sprite alone is not enough for an accurate revert: survev colours and
// scales guns at draw time rather than in the art itself (the same shared
// capsule sprite renders as a short black pistol for one gun and a longer
// grey one for another, purely from that gun's own def - see
// client/src/objects/player.ts's `this.gunBarrel.tint = imgDef.tint` and
// client/src/objects/loot.ts's `this.sprite.tint = itemDef.lootImg.tint`).
// So each version in 14-skins-data.js can carry a `def` snapshot (tint,
// scale, hand offset, magazine position - whatever gunDefs.ts held at that
// version's commit) alongside its art, and this file patches that onto the
// game's own live def object (resolved by 15-defs.js) before swapping the
// texture, restoring the pristine def underneath whenever a pick is cleared
// or the module is disabled. Def patching is optional, not load-bearing:
// if MOUSE.gameDefs never resolves (15-defs.js couldn't find it, e.g. after a
// survev update changes its bundling), everything below degrades gracefully
// to a texture-only swap - old data, and any version without a `def`, is
// unaffected by any of this.
//
// One place a loot icon is drawn without going through PIXI at all: the HUD's
// weapon slots (bottom right), which are DOM <img> elements pointing at the
// icon's .svg file. That copy is redirected separately - see setHudOverride.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const MODULE_ID = "skins";

    /** Which def sub-object a slot corresponds to on the item def survev
     * hands back from typeToDefSafe - see GameObjectDefs.gunDefs.ts. */
    const DEF_KEY = { world: "worldImg", loot: "lootImg" };

    /** @type {any} PIXI's Texture class, resolved lazily from a live sprite. */
    let TextureClass = null;

    /** spriteName -> the game's own original Texture, captured the first
     * time this module ever touches that name. */
    const originals = new Map();
    /** spriteName -> the override Texture currently installed, if any. */
    const liveTextures = new Map();
    /** spriteName -> Texture, cache of already-built override textures so
     * re-picking a version already seen this session doesn't redecode.
     * Keyed by the version's label since picks are stored by label too -
     * see setPickValue. */
    const builtTextures = new Map();

    /** "<gunId>|<slot>" -> the version label currently patched into the live
     * def, or null for "reverted to the game's own". applySlot re-runs while
     * it waits for the game's atlas, and this is what keeps that retry from
     * asking every player to rebuild its sprites on every frame. */
    const appliedLabels = new Map();

    /** "<gunId>|<slot>" -> a deep clone of that gun's worldImg/lootImg def
     * object exactly as survev shipped it, captured the first time this
     * module ever touches that gun+slot. Lets a pick be reverted (or the
     * whole module disabled) without drifting from the true original. */
    const originalDefs = new Map();

    /** spriteName -> { gunId, slot, isMain }, built lazily since
     * 14-skins-data.js is static and this never changes at runtime. Lets
     * restoreAllLive (module disable) look up which gun/slot/tint a bare
     * spriteName belongs to without a specific applySlot call in hand. */
    let spriteIndex = null;
    function buildSpriteIndex() {
        spriteIndex = new Map();
        const guns = (MOUSE.skins && MOUSE.skins.guns) || [];
        for (let i = 0; i < guns.length; i++) {
            const gun = guns[i];
            for (const slot in DEF_KEY) {
                const slotData = gun[slot];
                if (!slotData) continue;
                for (let j = 0; j < slotData.sprites.length; j++) {
                    spriteIndex.set(slotData.sprites[j], { gunId: gun.id, slot, isMain: j === 0 });
                }
            }
        }
    }

    function resolveTextureClass() {
        if (TextureClass) return TextureClass;
        if (MOUSE.pixiTexture) {
            TextureClass = MOUSE.pixiTexture;
            MOUSE.log("skins: texture class resolved (module graph)");
            return TextureClass;
        }
        const ctx = MOUSE.ctx;
        const spr = ctx && ctx.activePlayer && ctx.activePlayer.bodySprite;
        if (spr && spr.texture && spr.texture.constructor) {
            TextureClass = spr.texture.constructor;
            MOUSE.log("skins: texture class resolved (live sprite)");
        }
        return TextureClass;
    }

    /**
     * Marks every player's visuals dirty, so the game re-runs
     * updateVisuals() -> Gun.setType() for them on its next frame and picks
     * up whatever this module just wrote into their weapon's def. Without
     * it a def patch only takes effect the next time the player happens to
     * switch weapons: setType is what reads scale, tint, hand offset and
     * magazine position out of the def, and it only runs on a visuals
     * update. (`visualsDirty` is not name-mangled - see 00-loader.js on
     * which names survive minification.)
     */
    function refreshPlayerVisuals() {
        const ctx = MOUSE.ctx;
        const barn = ctx && ctx.playerBarn;
        if (!barn || !barn.playerPool) return;
        const players = ctx.poolArray(barn.playerPool);
        for (let i = 0; i < players.length; i++) {
            if (players[i]) players[i].visualsDirty = true;
        }
    }

    /** @param {string} svgText @returns {{w: number, h: number}} */
    function parseSvgSize(svgText) {
        const tagMatch = svgText.match(/<svg\b[^>]*>/);
        const tag = tagMatch ? tagMatch[0] : "";
        const w2 = tag.match(/\swidth="([0-9.]+)"/);
        const h2 = tag.match(/\sheight="([0-9.]+)"/);
        if (w2 && h2) {
            return { w: Math.max(1, Math.ceil(parseFloat(w2[1]))), h: Math.max(1, Math.ceil(parseFloat(h2[1]))) };
        }
        return { w: 128, h: 128 };
    }

    /** @param {string} svgText @returns {Promise<any>} resolves to a Texture */
    function svgToTexture(svgText) {
        return new Promise(function (resolve, reject) {
            const dims = parseSvgSize(svgText);
            const img = new Image();
            img.onload = function () {
                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = dims.w;
                    canvas.height = dims.h;
                    const c2d = canvas.getContext("2d");
                    c2d.drawImage(img, 0, 0, dims.w, dims.h);
                    resolve(TextureClass.from(canvas));
                } catch (e) {
                    reject(e);
                }
            };
            img.onerror = function () {
                reject(new Error("svg decode failed"));
            };
            img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
        });
    }

    /**
     * Walks the live scene graph and repoints any Sprite currently showing
     * `oldTex` to `newTex` - covers loot already on the ground and any
     * player already holding/wearing the swapped sprite. Also refreshes
     * `.tint` on those same nodes when a tint is given, since a def change
     * alone (see applyDefForSlot) only affects sprites *constructed* after
     * the change - anything already on screen keeps whatever tint it was
     * given at construction time otherwise.
     * @param {any} oldTex @param {any} newTex @param {number} [tint]
     */
    function refreshLiveSprites(oldTex, newTex, tint) {
        const renderer = MOUSE.ctx && MOUSE.ctx.renderer;
        const layers = renderer && renderer.layers;
        if (!layers) return;
        const stack = layers.slice();
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (node.texture !== undefined && node.texture === oldTex) {
                node.texture = newTex;
                if (tint !== undefined && node.tint !== undefined) node.tint = tint;
            }
            const children = node.children;
            if (children && children.length) {
                for (let i = 0; i < children.length; i++) stack.push(children[i]);
            }
        }
    }

    /**
     * The Texture the game currently has cached under `name`, or null if the
     * atlas holding it has not been parsed yet.
     *
     * TextureClass.from() must not be used for this. For a name it does not
     * know, `from` *invents* a texture that tries to load "gun-long-01.img"
     * as a relative URL and caches it under that name - which the game's own
     * spritesheet would then collide with ("Texture added to the cache with
     * an id that already had an entry") when it finally parses. That never
     * came up while this module only ran inside a match, but picks are now
     * applied as soon as the page has a texture class, which can be before
     * the menu's atlas is ready. removeFromCache returns the entry or null
     * and addToCache puts it straight back, so this is a lookup with no
     * lasting effect either way.
     * @param {string} name
     */
    function cachedTexture(name) {
        if (!TextureClass) return null;
        try {
            const tex = TextureClass.removeFromCache(name);
            if (!tex) return null;
            TextureClass.addToCache(tex, name);
            return tex;
        } catch (_e) {
            return null;
        }
    }

    /** @param {string} name @param {any} newTex @param {number} [tint]
     * @returns {boolean} false if the game has not cached `name` yet */
    function installTexture(name, newTex, tint) {
        const old = cachedTexture(name);
        if (!old) return false;
        if (!originals.has(name)) originals.set(name, old);
        if (old === newTex) return true;
        TextureClass.removeFromCache(name);
        TextureClass.addToCache(newTex, name);
        liveTextures.set(name, newTex);
        rebuildOverrideOwners();
        refreshLiveSprites(old, newTex, tint);
        return true;
    }

    /** @param {string} name @param {number} [tint] */
    function restoreOriginal(name, tint) {
        if (!originals.has(name)) return;
        const old = cachedTexture(name);
        const orig = originals.get(name);
        if (!old || old === orig) {
            liveTextures.delete(name);
            rebuildOverrideOwners();
            return;
        }
        TextureClass.removeFromCache(name);
        TextureClass.addToCache(orig, name);
        liveTextures.delete(name);
        rebuildOverrideOwners();
        refreshLiveSprites(old, orig, tint);
    }

    function restoreAllLive() {
        hudOverrides.clear();
        syncHudObserver();
        sweepHudImages();
        if (!spriteIndex) buildSpriteIndex();
        for (const name of Array.from(liveTextures.keys())) {
            const info = spriteIndex.get(name);
            let tint;
            if (info && info.isMain && info.slot === "world" && MOUSE.gameDefs) {
                const liveDef = MOUSE.gameDefs.typeToDefSafe(info.gunId);
                const imgDef = liveDef && liveDef[DEF_KEY[info.slot]];
                if (imgDef) tint = imgDef.tint;
            }
            restoreOriginal(name, tint);
        }
    }

    /** Deep-clones a def sub-object (worldImg/lootImg) so a captured
     * "original" can never be mutated by later resets. @param {any} obj */
    function cloneDefObj(obj) {
        if (!obj || typeof obj !== "object") return obj;
        const out = /** @type {any} */ ({});
        for (const k in obj) {
            const v = obj[k];
            out[k] = v && typeof v === "object" ? cloneDefObj(v) : v;
        }
        return out;
    }

    /** Resets every key on `liveObj` to the captured original, key by key,
     * rather than replacing the object wholesale - the game keeps its own
     * reference to this exact object, so identity has to be preserved.
     * @param {any} liveObj @param {any} originalObj */
    function resetToOriginal(liveObj, originalObj) {
        for (const k in originalObj) {
            const v = originalObj[k];
            liveObj[k] = v && typeof v === "object" ? cloneDefObj(v) : v;
        }
    }

    /** Applies a (possibly partial, possibly nested) set of overrides onto
     * a def sub-object already reset to original - see resetToOriginal.
     * Recurses into matching nested objects (e.g. magImg) so an override
     * only naming magImg.pos does not clobber magImg.top.
     * @param {any} liveObj @param {any} overrides */
    function applyOverrides(liveObj, overrides) {
        if (!overrides) return;
        for (const k in overrides) {
            const v = overrides[k];
            if (v && typeof v === "object" && liveObj[k] && typeof liveObj[k] === "object") {
                applyOverrides(liveObj[k], v);
            } else {
                liveObj[k] = v;
            }
        }
    }

    /**
     * Resets the given gun+slot's live def to its true original, then
     * layers on `version.def[slot]` if the picked version carries one. A
     * `null`/undefined version (Current, or def patching unavailable) just
     * leaves it at original. Always resets-then-applies rather than
     * mutating cumulatively, so switching between versions (or back to
     * Current) never stacks old overrides on top of new ones.
     * @param {any} gun @param {"world"|"loot"} slot @param {any} version
     */
    function applyDefForSlot(gun, slot, version) {
        const gameDefs = MOUSE.gameDefs;
        if (!gameDefs) return;
        const liveDef = gameDefs.typeToDefSafe(gun.id);
        const key = DEF_KEY[slot];
        if (!liveDef || !liveDef[key]) return;
        patchOneDef(gun.id, slot, key, liveDef[key], version);

        const twinId = dualTwinSharingSprite(gameDefs, gun.id, slot, key, liveDef);
        if (twinId) {
            const twinDef = gameDefs.typeToDefSafe(twinId);
            patchOneDef(twinId, slot, key, twinDef[key], version);
        }
    }

    /**
     * The id of `gun`'s dual-wield counterpart when the two genuinely share
     * this slot's sprite, or null.
     *
     * A dual-wielded pistol is a separate gun def with its own worldImg, and
     * survev points several of them at the single gun's sprite rather than
     * at art of their own - deagle_dual, flare_gun_dual and ot38_dual all
     * draw the same sprite the single version does, twice. Swapping the
     * texture behind that sprite therefore changes the dual gun too, but
     * patching only the single's def left the dual rendering the historical
     * capsule with today's tint and scale still on it: an untinted white
     * capsule in each hand, which is very nearly what dual Peacemakers look
     * like. Hence the sprite-equality test rather than a blanket "also do
     * the dual": it is exactly the condition under which one texture swap
     * reaches two defs, and it is false for loot icons, which always have
     * separate single/dual art.
     * @param {any} gameDefs @param {string} gunId @param {"world"|"loot"} slot
     * @param {string} key @param {any} liveDef
     */
    function dualTwinSharingSprite(gameDefs, gunId, slot, key, liveDef) {
        const twinId = liveDef.dualWieldType;
        if (!twinId) return null;
        const twinDef = gameDefs.typeToDefSafe(twinId);
        if (!twinDef || !twinDef[key]) return null;
        // Prefer the captured originals where they exist, so the test
        // cannot be confused by a pick that is already applied. (No version
        // in 14-skins-data.js overrides `sprite` - the swap replaces the
        // texture behind the name - but this costs nothing.)
        const ownOriginal = originalDefs.get(gunId + "|" + slot) || liveDef[key];
        const twinOriginal = originalDefs.get(twinId + "|" + slot) || twinDef[key];
        return ownOriginal.sprite && ownOriginal.sprite === twinOriginal.sprite ? twinId : null;
    }

    /**
     * Resets one gun+slot's live def to its captured original and layers
     * the picked version's overrides back on. Split out of applyDefForSlot
     * so a dual-wield twin can be given the identical treatment.
     * @param {string} gunId @param {"world"|"loot"} slot @param {string} key
     * @param {any} liveImgDef @param {any} version
     */
    function patchOneDef(gunId, slot, key, liveImgDef, version) {
        const defKey = gunId + "|" + slot;
        if (!originalDefs.has(defKey)) {
            originalDefs.set(defKey, cloneDefObj(liveImgDef));
        }
        resetToOriginal(liveImgDef, originalDefs.get(defKey));
        // rightHandOffset is this client's own field, not the game's (see
        // applyRearHands). resetToOriginal only rewrites the keys the
        // original def had, so ours has to be cleared by hand or it would
        // outlive the pick that introduced it.
        delete liveImgDef.rightHandOffset;
        if (version && version.def && version.def[slot]) {
            applyOverrides(liveImgDef, version.def[slot]);
        }
        if (slot === "world") applyTune(liveImgDef, gunId);
    }

    // --- Dev position tuning (optional, not shipped) -----------------------
    // extension/dev/gui-tune.js - which manifest.json deliberately does not
    // load - installs a function here to layer live position overrides onto a
    // def as it is being patched, so gunOffset / leftHandOffset /
    // rightHandOffset can be dialled in against the running game and the
    // numbers folded back into assets/sprites/manifest.tsv. In the shipped
    // client the hook is absent and this is one property read per pick.
    /** @param {any} imgDef @param {string} gunId */
    function applyTune(imgDef, gunId) {
        const hook = MOUSE.skins.tuneHook;
        if (typeof hook === "function") hook(imgDef, gunId);
    }

    // --- The rear hand ----------------------------------------------------
    // The game has no rear-hand offset. `leftHandOffset` moves the leading
    // hand, `gunOffset` moves the gun, and the rear hand is pinned to the
    // animation bone at (14, 12.25) for every gun there is - which is a
    // problem for reverted art, whose grip does not sit where the modern
    // art's does, leaving the gun's rear end poking out from under a hand
    // that should be covering it.
    //
    // It can be moved anyway, without touching the game's code: `handRSprite`
    // is positioned exactly once, at construction, and the game never writes
    // to it again (it sets that sprite's texture, scale, tint and visibility
    // and nothing else - client/src/objects/player.ts). The bone animation
    // and the shot recoil both move the *container*, so an offset on the
    // sprite inside it rides along with them instead of fighting them.
    //
    // So `worldImg.rightHandOffset` is a field this client invents and
    // implements itself. The game ignores unknown worldImg keys, which lets
    // it be carried, patched and reverted exactly like a real def value -
    // it just gets applied from here, per frame, rather than by setType.
    //
    // Which players it applies to is decided by what they are actually
    // holding: a player's gun barrel texture is looked up among the
    // overrides this module has installed. Every gun covered here has its
    // own dedicated sprite today (that is what made it a resprite), so that
    // identity check names exactly one gun - and it means the offset applies
    // only while the reverted art is really on screen. A player holding the
    // modern art is never touched.

    /** override Texture -> the gun id it was installed for. */
    const overrideOwners = new Map();
    /** Players whose rear hand this module has moved, so it can be put back. */
    const movedHands = new Set();

    function rebuildOverrideOwners() {
        overrideOwners.clear();
        if (!spriteIndex) buildSpriteIndex();
        for (const [name, tex] of liveTextures) {
            const info = spriteIndex.get(name);
            if (info && info.isMain && info.slot === "world") overrideOwners.set(tex, info.gunId);
        }
    }

    /**
     * Moves one player's rear hand, or reports that there is no longer a
     * sprite to move.
     *
     * The liveness test has to be 16-overlay.js's, not a null check on
     * `position`: leaving a match runs the game's own Game.free(), which
     * destroys the whole PIXI stage with `{children: true}` and so every
     * player sprite along with it, while the barn holding those players
     * stays reachable until the next match's init() replaces it. A
     * destroyed display object is still an object, but PIXI's `position` is
     * a getter off `transform`, which destroy() nulls - so *reading*
     * `sprite.position` to check it is exactly what throws.
     * @param {any} player @param {number} x @param {number} y
     * @returns {boolean} false if the sprite is gone
     */
    function setRearHand(player, x, y) {
        const sprite = player.handRSprite;
        if (!MOUSE.overlay.isAlive(sprite)) return false;
        if (sprite.position.x !== x || sprite.position.y !== y) sprite.position.set(x, y);
        return true;
    }

    function applyRearHands() {
        const ctx = MOUSE.ctx;
        const barn = ctx && ctx.playerBarn;
        if (!barn || !barn.playerPool) return;
        if (!overrideOwners.size && !movedHands.size) return;
        // Players from an earlier match are still in `movedHands` but are
        // not in this barn's pool, so nothing below would ever reach them:
        // their hands went with the stage (see setRearHand) and there is
        // nothing left to put back. Dropping them here keeps the set from
        // pinning a match's worth of player objects for the whole session.
        for (const player of movedHands) {
            if (!MOUSE.overlay.isAlive(player.handRSprite)) movedHands.delete(player);
        }
        const players = ctx.poolArray(barn.playerPool);
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (!player || !player.handRSprite) continue;
            let offset = null;
            const gun = player.gunRSprites;
            const texture = gun && gun.gunBarrel && gun.gunBarrel.texture;
            const gunId = texture ? overrideOwners.get(texture) : undefined;
            if (gunId && MOUSE.gameDefs) {
                const def = MOUSE.gameDefs.typeToDefSafe(gunId);
                const world = def && def.worldImg;
                if (world && world.rightHandOffset) offset = world.rightHandOffset;
            }
            if (offset) {
                setRearHand(player, offset.x || 0, offset.y || 0);
                movedHands.add(player);
            } else if (movedHands.has(player)) {
                setRearHand(player, 0, 0);
                movedHands.delete(player);
            }
        }
    }

    function clearRearHands() {
        for (const player of movedHands) setRearHand(player, 0, 0);
        movedHands.clear();
    }

    /**
     * Re-runs a gun's current world pick and forces the visuals kick that
     * applySlot itself skips when the picked version hasn't changed. Exported
     * for the dev tuning tool, whose whole job is changing a def underneath a
     * pick that is staying put.
     * @param {string} gunId
     */
    function reapplyWorld(gunId) {
        const gun = findGun(gunId);
        if (!gun || !TextureClass) return;
        const forGun = getPicks()[gunId] || {};
        applySlot(gun, "world", forGun.world);
        refreshPlayerVisuals();
    }

    /** Restores every def this module has ever touched back to its
     * captured original - the def-patching counterpart to restoreAllLive.
     * Safe to call even if MOUSE.gameDefs never resolved (originalDefs would
     * simply be empty in that case). */
    function restoreAllDefs() {
        const gameDefs = MOUSE.gameDefs;
        for (const [defKey, original] of originalDefs) {
            if (!gameDefs) break;
            const sep = defKey.indexOf("|");
            const gunId = defKey.slice(0, sep);
            const slot = defKey.slice(sep + 1);
            const liveDef = gameDefs.typeToDefSafe(gunId);
            const key = DEF_KEY[slot];
            if (liveDef && liveDef[key]) resetToOriginal(liveDef[key], original);
        }
        originalDefs.clear();
        appliedLabels.clear();
    }

    /** @param {string} gunId */
    function findGun(gunId) {
        const guns = MOUSE.skins.guns;
        for (let i = 0; i < guns.length; i++) {
            if (guns[i].id === gunId) return guns[i];
        }
        return null;
    }

    /** @param {any} slotData @param {string} label */
    function findVersion(slotData, label) {
        if (!slotData || !slotData.versions) return null;
        for (let i = 0; i < slotData.versions.length; i++) {
            if (slotData.versions[i].label === label) return slotData.versions[i];
        }
        return null;
    }

    function getPicks() {
        return MOUSE.modules.getSetting(MODULE_ID, "picks", {}) || {};
    }

    /**
     * Picks are keyed by version label ("v2"), not array index - an index
     * silently pointed at the wrong version (or threw) the moment
     * 14-skins-data.js was regenerated with a different version order. A
     * pick saved by an older build of this client under the old, numeric
     * scheme will simply never match any label in findVersion above and is
     * treated as absent - a one-time, silent reset back to Current for
     * that slot, not a migration worth writing code for.
     * @param {string} gunId @param {"world"|"loot"} slot @param {string | null} label
     */
    function setPickValue(gunId, slot, label) {
        const picks = getPicks();
        const forGun = Object.assign({}, picks[gunId]);
        if (label === null || label === undefined) delete forGun[slot];
        else forGun[slot] = label;
        const nextPicks = Object.assign({}, picks);
        if (Object.keys(forGun).length === 0) delete nextPicks[gunId];
        else nextPicks[gunId] = forGun;
        MOUSE.modules.setSetting(MODULE_ID, "picks", nextPicks);
    }

    /**
     * @param {any} gun @param {"world"|"loot"} slot @param {string | null | undefined} label
     * @returns {boolean} false if the game's own art for this slot is not in
     * PIXI's cache yet, i.e. the caller should try again on a later frame.
     */
    function applySlot(gun, slot, label) {
        const slotData = gun[slot];
        if (!slotData || !TextureClass) return false;
        const version = label === null || label === undefined ? null : findVersion(slotData, label);
        applyDefForSlot(gun, slot, version);

        const gameDefs = MOUSE.gameDefs;
        const liveDef = gameDefs && gameDefs.typeToDefSafe(gun.id);
        const imgDef = liveDef && liveDef[DEF_KEY[slot]];

        // A def change only reaches an already-drawn gun via setType, so ask
        // the game to re-run it; the texture swap below covers loot on the
        // ground, which has no equivalent hook.
        const defKey = gun.id + "|" + slot;
        const nextLabel = version ? version.label : null;
        if (appliedLabels.get(defKey) !== nextLabel) {
            appliedLabels.set(defKey, nextLabel);
            if (version || originalDefs.has(defKey)) refreshPlayerVisuals();
        }

        let ready = true;
        for (let i = 0; i < slotData.sprites.length; i++) {
            const spriteName = slotData.sprites[i];
            const svg = version ? version.svgs[spriteName] : null;
            // Only the world slot's primary sprite (index 0) is tinted here.
            // A magazine overlay (index 1, e.g. DP-28/M249/QBB-97) is always
            // rendered plain white by the game itself regardless of the
            // gun's own tint (player.ts hardcodes `this.gunMag.tint =
            // 0xffffff`), so it must never be recoloured. Loot icons are
            // full-colour art and this module never overrides lootImg.tint,
            // so there is nothing to re-apply for that slot either - passing
            // its tint through would only re-assert the value the game
            // already set (an inherited 0x00ff00 that every gun def has
            // carried since 2018, see assets/sprites/README.md).
            const tint = slot === "world" && i === 0 && imgDef ? imgDef.tint : undefined;
            // The HUD's weapon slots draw the loot icon straight from its
            // .svg file rather than from PIXI, so that copy has to be
            // redirected separately - see setHudOverride.
            if (slot === "loot") setHudOverride(spriteName, svg);
            if (!svg) {
                restoreOriginal(spriteName, tint);
                continue;
            }
            const cacheKey = spriteName + " " + version.label;
            const cached = builtTextures.get(cacheKey);
            if (cached) {
                if (!installTexture(spriteName, cached, tint)) ready = false;
                continue;
            }
            // The install is asynchronous (the SVG has to be decoded), so it
            // can't report readiness back to this call - it retries itself
            // through the bootstrap tick instead, by leaving `bootstrapped`
            // alone until an install actually lands.
            svgToTexture(svg)
                .then(function (tex) {
                    builtTextures.set(cacheKey, tex);
                    if (!installTexture(spriteName, tex, tint)) bootstrapped = false;
                })
                .catch(function (e) {
                    MOUSE.warn("skins: failed to build texture for " + spriteName, e);
                });
        }
        return ready;
    }

    /** @returns {boolean} false if any pick still needs the game's atlas */
    function applyAllSavedPicks() {
        const picks = getPicks();
        let ready = true;
        for (const gunId in picks) {
            if (!Object.prototype.hasOwnProperty.call(picks, gunId)) continue;
            const gun = findGun(gunId);
            if (!gun) continue;
            const forGun = picks[gunId];
            if (forGun.world !== undefined && !applySlot(gun, "world", forGun.world)) ready = false;
            if (forGun.loot !== undefined && !applySlot(gun, "loot", forGun.loot)) ready = false;
        }
        return ready;
    }

    // Resolving TextureClass runs independent of whether this module is
    // enabled - the skin list GUI (32-gui-skins.js) needs it too, purely to
    // render the "Current" thumbnail preview (see currentThumbForSlot), and
    // browsing the list should work before the module itself is turned on.
    // A module's own onTick only fires while it is enabled (12-modules.js),
    // so this is registered directly on the shared ctx tick loop instead.
    MOUSE.ctx.onTick(function () {
        if (!TextureClass) resolveTextureClass();
    });

    // Applying picks needs nothing but the texture class: the PIXI texture
    // cache and the gun defs are both page-wide singletons, so a swap made
    // while the menu is up is already in place when a match starts (and
    // survives every later match - Game.init() never touches either).
    // Waiting for ctx.ready would mean nothing changed until the first
    // match had loaded.
    let bootstrapped = false;
    function onTick(_dt, _ctx) {
        if (!bootstrapped && TextureClass) {
            // Keep retrying until every pick has actually landed: the gun art
            // is in the `loadout` atlas, which the game parses a moment after
            // the page's own module graph is up.
            bootstrapped = applyAllSavedPicks();
        }
        applyRearHands();
    }

    MOUSE.modules.register({
        id: MODULE_ID,
        name: "Skin Changer",
        hidden: true,
        description:
            "Reverts specific guns' loot icon and/or in-world sprite to an older version. Pick versions from the Skin Changer window.",
        settings: {},
        onEnable() {
            if (resolveTextureClass()) bootstrapped = applyAllSavedPicks();
        },
        onDisable() {
            restoreAllDefs();
            restoreAllLive();
            clearRearHands();
            refreshPlayerVisuals();
        },
        onTick,
    });

    /**
     * Called by the skin list GUI (32-gui-skins.js) when a version chip is
     * clicked. Persists the pick regardless of module state, and applies it
     * immediately if the module is on and the texture class is known - a
     * pick made before either of those is ready is picked up by the next
     * bootstrap tick once the module is enabled and a match is joined.
     * @param {string} gunId @param {"world"|"loot"} slot @param {string | null} label
     */
    function setPick(gunId, slot, label) {
        setPickValue(gunId, slot, label);
        if (MOUSE.modules.isActive(MODULE_ID) && TextureClass) {
            const gun = findGun(gunId);
            // A pick made before the atlas has parsed goes back on the
            // bootstrap tick's queue rather than being silently dropped.
            if (gun && !applySlot(gun, slot, label)) bootstrapped = false;
        }
    }

    // --- HUD icons --------------------------------------------------------
    // The bottom-right weapon slots are plain DOM <img> elements, not PIXI
    // sprites: ui2.ts sets `img.src = helpers.getSvgFromGameType(type)`,
    // which resolves a loot icon's *file* path straight off the def
    // (`img/loot/<lootImg.sprite minus .img>.svg`). Nothing about that goes
    // through PIXI's texture cache, so the swap this module does for loot on
    // the ground cannot reach it. Rather than fight the game for ownership
    // of that attribute, this watches for it: whenever a src matching an
    // overridden icon appears, it is rewritten to the replacement art, and
    // put back the moment the pick is cleared.
    //
    // Only <img> src is handled. A couple of rarer spots (the "rare loot"
    // pickup banner) use a CSS background-image instead and are left alone -
    // catching those would mean observing `style`, which the HUD rewrites
    // constantly for slot widths and opacities.

    /** loot icon file path ("img/loot/loot-weapon-ak.svg") -> data URI. */
    const hudOverrides = new Map();
    /** img element -> the src the *game* last set on it, for restoring. */
    const hudTouched = new Map();
    let hudObserver = null;

    /** @param {string} spriteName e.g. "loot-weapon-ak.img" */
    function hudPathFor(spriteName) {
        return "img/loot/" + spriteName.slice(0, -4) + ".svg";
    }

    /** @param {string} src an <img> src as the game wrote it (may be absolute) */
    function hudOverrideFor(src) {
        for (const [path, uri] of hudOverrides) {
            if (src === path || src.endsWith("/" + path)) return uri;
        }
        return null;
    }

    /** @param {any} el */
    function refreshHudImage(el) {
        const attr = el.getAttribute("src") || "";
        // Anything that is not one of our data URIs is the game's own value,
        // and becomes the new thing to restore to.
        if (attr && attr.indexOf("data:") !== 0) hudTouched.set(el, attr);
        const orig = hudTouched.get(el) || "";
        if (!orig) return;
        const uri = hudOverrideFor(orig);
        const want = uri || orig;
        if (el.getAttribute("src") !== want) el.setAttribute("src", want);
        if (!uri) hudTouched.delete(el);
    }

    function sweepHudImages() {
        const imgs = document.getElementsByTagName("img");
        for (let i = 0; i < imgs.length; i++) refreshHudImage(imgs[i]);
        for (const el of Array.from(hudTouched.keys())) {
            if (!el.isConnected) hudTouched.delete(el);
        }
    }

    function syncHudObserver() {
        if (hudOverrides.size && !hudObserver) {
            hudObserver = new MutationObserver(function (records) {
                for (let i = 0; i < records.length; i++) {
                    const rec = records[i];
                    if (rec.type === "attributes") {
                        if (rec.target && rec.target.tagName === "IMG") refreshHudImage(rec.target);
                        continue;
                    }
                    for (let j = 0; j < rec.addedNodes.length; j++) {
                        const node = rec.addedNodes[j];
                        if (!node || node.nodeType !== 1) continue;
                        if (node.tagName === "IMG") refreshHudImage(node);
                        const nested = node.getElementsByTagName ? node.getElementsByTagName("img") : [];
                        for (let k = 0; k < nested.length; k++) refreshHudImage(nested[k]);
                    }
                }
            });
            hudObserver.observe(document.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["src"],
            });
        } else if (!hudOverrides.size && hudObserver) {
            hudObserver.disconnect();
            hudObserver = null;
        }
    }

    /** @param {string} spriteName @param {string | null} svgText null clears */
    function setHudOverride(spriteName, svgText) {
        const path = hudPathFor(spriteName);
        if (svgText) {
            hudOverrides.set(path, "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText));
        } else {
            hudOverrides.delete(path);
        }
        syncHudObserver();
        sweepHudImages();
    }

    // --- Thumbnails -------------------------------------------------------
    // A gun's world art is not a single sprite for the three LMGs: the body
    // and the magazine overlay are separate textures the game assembles at
    // draw time out of the def (player.ts's Gun.setType), the body anchored
    // at the bottom centre of its frame and the magazine centred on
    // magImg.pos. Previewing sprites[0] alone showed a DP-28/M249/QBB-97 as
    // a bare barrel with its magazine missing, so the chips below run that
    // same assembly on a canvas.

    /** How many pixels the longer side of a composed thumbnail gets. */
    const THUMB_PX = 128;

    /**
     * Paints `draw` into a fresh canvas, then recolors it to `tint` while
     * preserving the source's exact alpha silhouette - the standard
     * "multiply, then destination-in the original alpha mask" trick, since
     * a plain multiply alone would also paint the source's transparent
     * background opaque (destination alpha 0 * source alpha 1 = opaque
     * fill everywhere). White is a no-op multiply, skipped both for guns
     * with modern dedicated art (tint 0xffffff) and an unknown tint. The
     * runtime engine's own installTexture/refreshLiveSprites path never
     * needs this at all, since that one leaves tinting to the game's own
     * PIXI `sprite.tint` instead of baking it into pixels.
     * @param {number} w @param {number} h @param {number | undefined | null} tint
     * @param {(c2d: CanvasRenderingContext2D) => void} draw
     * @returns {HTMLCanvasElement}
     */
    function tintedCanvas(w, h, tint, draw) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(w));
        canvas.height = Math.max(1, Math.ceil(h));
        const c2d = canvas.getContext("2d");
        draw(c2d);
        if (tint !== undefined && tint !== null && tint !== 0xffffff) {
            c2d.globalCompositeOperation = "multiply";
            c2d.fillStyle = "#" + (tint >>> 0).toString(16).padStart(6, "0").slice(-6);
            c2d.fillRect(0, 0, canvas.width, canvas.height);
            c2d.globalCompositeOperation = "destination-in";
            draw(c2d);
        }
        return canvas;
    }

    /** svg source text -> a promise for its decoded Image, so re-rendering
     * the list does not decode the same art again. */
    const svgImages = new Map();

    /** @param {string} svgText @returns {Promise<{ image: any, w: number, h: number }>} */
    function decodeSvg(svgText) {
        const cached = svgImages.get(svgText);
        if (cached) return cached;
        const promise = new Promise(function (resolve, reject) {
            const dims = parseSvgSize(svgText);
            const img = new Image();
            img.onload = function () {
                resolve({ image: img, w: dims.w, h: dims.h });
            };
            img.onerror = function () {
                reject(new Error("svg decode failed"));
            };
            img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
        });
        svgImages.set(svgText, promise);
        return promise;
    }

    /**
     * The game's *current* art for one sprite name, as something drawable:
     * a source image plus the frame rectangle inside the shared atlas page.
     * Prefers the captured original Texture (`originals`) if this session
     * has already swapped that name, since by then the cache entry is this
     * module's own override instead. Returns null whenever the atlas is not
     * loaded yet or the name is unknown to it - callers retry (see
     * 32-gui-skins.js's pendingCurrentThumbs).
     * @param {string} spriteName
     * @returns {{ image: any, sx: number, sy: number, w: number, h: number } | null}
     */
    function atlasFrame(spriteName) {
        if (!TextureClass) return null;
        const tex = originals.get(spriteName) || cachedTexture(spriteName);
        const base = tex && tex.baseTexture;
        if (!base || base.valid === false) return null;
        const src = base.resource && base.resource.source;
        const frame = tex.frame;
        if (!src || !frame || !frame.width || !frame.height) return null;
        return { image: src, sx: frame.x, sy: frame.y, w: frame.width, h: frame.height };
    }

    /**
     * The def a given version renders with: the gun's true original def
     * (captured the first time this module touched it, or read live while
     * still untouched) with that version's overrides layered on - exactly
     * what applyDefForSlot installs, computed on a copy so nothing live is
     * disturbed. A version with no def, or a gun the defs resolver never
     * reached, simply yields whichever half of that is available.
     * @param {string} gunId @param {"world"|"loot"} slot @param {any} version
     */
    function effectiveDef(gunId, slot, version) {
        const captured = originalDefs.get(gunId + "|" + slot);
        let base = captured;
        if (!base && MOUSE.gameDefs) {
            const liveDef = MOUSE.gameDefs.typeToDefSafe(gunId);
            base = liveDef && liveDef[DEF_KEY[slot]];
        }
        const out = base ? cloneDefObj(base) : /** @type {any} */ ({});
        if (version && version.def && version.def[slot]) applyOverrides(out, version.def[slot]);
        return out;
    }

    /**
     * Lays a body sprite and an optional magazine overlay out the way
     * player.ts's Gun.setType does, in the game's own container units: the
     * body is `scale * 0.5` of its frame, anchored bottom-centre at the
     * origin and extending along -y; the magazine is a flat 0.25 of its own
     * frame (that factor is hardcoded in the client, not read from the def)
     * centred on magImg.pos. The result is cropped to the union of the two
     * and scaled to THUMB_PX.
     * @param {{ draw: (c2d: any, x: number, y: number, w: number, h: number) => void, w: number, h: number }} body
     * @param {{ draw: (c2d: any, x: number, y: number, w: number, h: number) => void, w: number, h: number } | null} mag
     * @param {any} def @param {number | undefined} tint
     * @returns {string | null}
     */
    function composeWorld(body, mag, def, tint) {
        const scale = (def && def.scale) || {};
        const sx = typeof scale.x === "number" ? scale.x : 0.5;
        const sy = typeof scale.y === "number" ? scale.y : 0.5;
        const bw = body.w * sx * 0.5;
        const bh = body.h * sy * 0.5;
        if (!(bw > 0) || !(bh > 0)) return null;

        let minX = -bw / 2;
        let maxX = bw / 2;
        let minY = -bh;
        let maxY = 0;

        const magImg = def && def.magImg;
        let magBox = null;
        if (mag && magImg && magImg.pos) {
            const mw = mag.w * 0.25;
            const mh = mag.h * 0.25;
            magBox = { x: magImg.pos.x - mw / 2, y: magImg.pos.y - mh / 2, w: mw, h: mh };
            minX = Math.min(minX, magBox.x);
            maxX = Math.max(maxX, magBox.x + mw);
            minY = Math.min(minY, magBox.y);
            maxY = Math.max(maxY, magBox.y + mh);
        }

        const k = THUMB_PX / Math.max(maxX - minX, maxY - minY);
        if (!isFinite(k) || k <= 0) return null;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil((maxX - minX) * k));
        canvas.height = Math.max(1, Math.ceil((maxY - minY) * k));
        const c2d = canvas.getContext("2d");

        function drawMag() {
            if (!magBox) return;
            mag.draw(c2d, (magBox.x - minX) * k, (magBox.y - minY) * k, magBox.w * k, magBox.h * k);
        }
        // magImg.top is the game's own layering flag - the DP-28's pan sits
        // over the barrel, the M249's and QBB-97's boxes under it.
        if (!(magImg && magImg.top)) drawMag();
        const bodyCanvas = tintedCanvas(bw * k, bh * k, tint, function (bc) {
            body.draw(bc, 0, 0, bw * k, bh * k);
        });
        c2d.drawImage(bodyCanvas, (-bw / 2 - minX) * k, (-bh - minY) * k);
        if (magImg && magImg.top) drawMag();
        return canvas.toDataURL();
    }

    /** @param {{ image: any, sx: number, sy: number, w: number, h: number }} f */
    function frameDrawer(f) {
        return {
            w: f.w,
            h: f.h,
            draw: function (c2d, x, y, w, h) {
                c2d.drawImage(f.image, f.sx, f.sy, f.w, f.h, x, y, w, h);
            },
        };
    }

    /** @param {{ image: any, w: number, h: number }} d */
    function imageDrawer(d) {
        return {
            w: d.w,
            h: d.h,
            draw: function (c2d, x, y, w, h) {
                c2d.drawImage(d.image, x, y, w, h);
            },
        };
    }

    /**
     * Thumbnail of the game's *current*, unmodified art for a gun+slot -
     * the only place this client ever reads out of the game's own texture
     * atlas rather than swapping into it. Synchronous (every source is
     * already-decoded atlas pixels), and returns null whenever something is
     * not ready yet: the atlas still loading, or - for a gun whose world art
     * has a magazine overlay - the gun defs not resolved, since without
     * magImg.pos there is no way to place that overlay and the preview would
     * silently be a bare barrel.
     * @param {string} gunId @param {"world"|"loot"} slot
     * @returns {string | null}
     */
    function currentThumbForSlot(gunId, slot) {
        const gun = findGun(gunId);
        const slotData = gun && gun[slot];
        if (!slotData || !slotData.sprites.length) return null;
        const def = effectiveDef(gunId, slot, null);
        const body = atlasFrame(slotData.sprites[0]);
        if (!body) return null;
        // Loot icons are full-colour art drawn as-is; see applySlot for why
        // the def's own lootImg.tint is not a colour to paint with.
        const tint = slot === "world" ? def.tint : undefined;
        if (slot !== "world") {
            return tintedCanvas(body.w, body.h, tint, function (c2d) {
                frameDrawer(body).draw(c2d, 0, 0, body.w, body.h);
            }).toDataURL();
        }
        let mag = null;
        if (slotData.sprites.length > 1) {
            if (!def.magImg || !def.magImg.pos) return null;
            const magFrame = atlasFrame(slotData.sprites[1]);
            if (!magFrame) return null;
            mag = frameDrawer(magFrame);
        }
        return composeWorld(frameDrawer(body), mag, def, tint);
    }

    /**
     * The same for one historical version: each sprite comes from that
     * version's own stored SVG, falling back to the game's current art for
     * any sprite the version does not replace - which is exactly what
     * applySlot installs, so the chip previews the real result. Raw SVG
     * rendered without the def's tint would look white/grey for every gun on
     * one of survev's shared capsule sprites, since those are deliberately
     * colourless in the art itself.
     * @param {string} gunId @param {"world"|"loot"} slot @param {any} version
     * @returns {Promise<string | null>}
     */
    function versionThumb(gunId, slot, version) {
        const gun = findGun(gunId);
        const slotData = gun && gun[slot];
        if (!slotData || !version) return Promise.resolve(null);
        const def = effectiveDef(gunId, slot, version);
        const tint = slot === "world" ? def.tint : undefined;

        /** @param {number} i @returns {Promise<any>} */
        function drawerFor(i) {
            const name = slotData.sprites[i];
            const svg = name ? version.svgs[name] : null;
            if (svg) return decodeSvg(svg).then(imageDrawer);
            const frame = name ? atlasFrame(name) : null;
            return Promise.resolve(frame ? frameDrawer(frame) : null);
        }

        return drawerFor(0).then(function (body) {
            if (!body) return null;
            if (slot !== "world") {
                return tintedCanvas(body.w, body.h, tint, function (c2d) {
                    body.draw(c2d, 0, 0, body.w, body.h);
                }).toDataURL();
            }
            if (slotData.sprites.length < 2 || !def.magImg || !def.magImg.pos) {
                return composeWorld(body, null, def, tint);
            }
            return drawerFor(1).then(function (mag) {
                return composeWorld(body, mag, def, tint);
            });
        });
    }

    MOUSE.skins.setPick = setPick;
    MOUSE.skins.getPicks = getPicks;
    MOUSE.skins.versionThumb = versionThumb;
    MOUSE.skins.reapplyWorld = reapplyWorld;
    MOUSE.skins.currentThumbForSlot = currentThumbForSlot;
    MOUSE.log("skin changer engine installed");
})();
