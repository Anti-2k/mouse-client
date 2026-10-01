// 21-cosmetics.js
//
// Forces every player's outfit back to the plain default look, and their
// heal/boost particles back to the plain default ones - never the melee
// skin (that lives on the weapon def, not the outfit - client/src/objects/
// player.ts:1712-1729), never a ghillie suit (its camouflage is gameplay,
// not decoration, so it is left exactly as the game draws it), and never an
// outfit that is telling you something - see isRoleLockedOutfit below,
// which is the part that has historically been wrong. Optionally also skips
// the decorative animations a melee plays when it is drawn or re-selected.
//
// Outfit: overwrites the mangled m_outfit field inside a player's netData
// (found generically via ctx.readNetData, 10-ctx.js) with "outfitBase" -
// a real entry in shared/defs/gameObjects/outfitDefs.ts's OutfitDefs, the
// plain skin every other outfit is defined as a variant of - then sets the
// plain, unmangled `visualsDirty` flag so the game's own updateVisuals()
// picks it up on its next frame (player.ts:1303-1306). The original value
// is remembered per player so it can be put back exactly if the server
// ever pushes a genuinely different real outfit while overridden, or when
// this module stops touching that player.
//
// Particles: heal/boost skin choice is server-driven network state
// (playerBarn.getPlayerInfo(id).loadout.{heal,boost}, a live object - not
// a clone - shared/net/updateMsg.ts's PlayerInfo), read by both the
// passive-heal and use-item particle effects
// (client/src/objects/player.ts:1209, :1991-2039) through
// GameObjectDefs.typeToDef(loadout.X, "..._effect").emitter. Overwriting
// those two fields to "heal_basic"/"boost_basic" makes both effects
// resolve to the plain red/green particles without touching the emitters
// themselves.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const MODULE_ID = "anticosmetics";

    function getSettings() {
        const get = (key, fallback) => MOUSE.modules.getSetting(MODULE_ID, key, fallback);
        return {
            outfits: get("outfits", true),
            healParticles: get("healParticles", true),
            boostParticles: get("boostParticles", true),
            includeSelf: get("includeSelf", true),
            meleeDeployAnim: get("meleeDeployAnim", true),
            meleeIdleAnim: get("meleeIdleAnim", true),
        };
    }

    // --- What counts as "information" rather than decoration ---------------
    // Exactly one kind of outfit is left alone: a role-locked one, i.e. a
    // skin you cannot choose to wear and that is therefore *stating your
    // role* - cobalt's six classes, outfitClassless, and faction's Red/Blue
    // Leader. Defaulting one would delete the only visible sign of what the
    // player in front of you is.
    //
    // The game already marks precisely those nine and nothing else `noDrop`
    // (shared/defs/gameObjects/outfitDefs.ts), which is exactly the property
    // that matters - you cannot drop it because it is not yours, the role
    // handed it to you (shared/defs/gameObjects/roleDefs.ts). So the test is
    // a single flag on the skin itself, with no mode check anywhere: a
    // cobalt class outfit is exempt because of what it is, not because of
    // where it is being worn, and an outfit added for a future role is
    // covered without anything here changing.
    //
    // What this deliberately does *not* look at is `teamId`. That flag is
    // not a marker of a special skin, it is a restriction saying "in faction
    // mode this one may only be worn by Blue/Red" (outfitDefs.ts's own
    // comment on the field), and 24 of the game's 90 outfits carry it -
    // ordinary shop skins like Cobalt Shell, Target Practice, Key Lime,
    // Falling Star and Casanova Silks. Exempting on it is what used to let
    // more than a quarter of every outfit in the game through untouched, in
    // every mode. Nothing is lost by defaulting one even in a faction mode,
    // either: client/src/objects/player.ts:1517 draws the team patch for
    // every non-ghillie player from playerInfo.teamId, never from the
    // outfit, so which side someone is on stays just as visible.
    //
    // This needs the live def registry, and only the live one - 13-items.js
    // records that a type is an outfit but not which flags it carries. Until
    // MOUSE.gameDefs resolves, outfits are left alone entirely rather than
    // defaulted on incomplete information, which would strip a role outfit
    // for the first few frames of a match.
    /** @param {any} def */
    function isRoleLockedOutfit(def) {
        return !!(def && def.noDrop);
    }

    // --- Outfit field lookup -------------------------------------------
    // The mangled netData field is identified by its *value* - whichever
    // field holds a string that names an outfit - so "is this string an
    // outfit" has to be answerable for every outfit in the game, including
    // ones this client has never heard of.
    //
    // The game's own def registry (MOUSE.gameDefs, 15-defs.js) is therefore
    // asked first, and the hand-maintained table in 13-items.js is only the
    // fallback for the frames before that registry resolves. The table is
    // the half that goes stale: it is copied out of the survev repo by hand,
    // so a skin added by a game update is simply absent from it - and since
    // the value is what identifies the field, a player wearing an unlisted
    // skin made the whole lookup return null and their outfit be left
    // alone, with nothing logged and every other player still defaulting
    // correctly. That is how `outfitMaintainer` went unhandled. The live
    // registry cannot drift that way; `bun tools/check-item-table.ts` keeps
    // the fallback honest for the other modules that read it.
    /** @param {any} v */
    function isOutfitType(v) {
        if (typeof v !== "string") return false;
        if (MOUSE.gameDefs) {
            const def = MOUSE.gameDefs.typeToDefSafe(v);
            if (def) return def.type === "outfit";
        }
        return MOUSE.items.ITEM_CATEGORY[v] === "outfit";
    }

    // Same field on every player's netData, so found once and reused.
    let outfitKey = null;
    /** @param {any} netData */
    function getOutfitKey(netData) {
        if (outfitKey !== null) {
            if (isOutfitType(netData[outfitKey])) return outfitKey;
            outfitKey = null;
        }
        for (const k in netData) {
            if (!Object.prototype.hasOwnProperty.call(netData, k)) continue;
            if (isOutfitType(netData[k])) {
                outfitKey = k;
                return k;
            }
        }
        return null;
    }

    /** @type {WeakMap<any, string>} player -> real outfit type before override */
    const originalOutfit = new WeakMap();

    /** @param {any} p @param {any} netData @param {string} key */
    function applyOutfitDefault(p, netData, key) {
        const current = netData[key];
        if (current === "outfitBase") return;
        originalOutfit.set(p, current);
        netData[key] = "outfitBase";
        p.visualsDirty = true;
    }

    /** @param {any} p @param {any} netData @param {string} key */
    function restoreOutfit(p, netData, key) {
        if (!originalOutfit.has(p)) return;
        const real = originalOutfit.get(p);
        if (netData[key] !== real) {
            netData[key] = real;
            p.visualsDirty = true;
        }
        originalOutfit.delete(p);
    }

    // --- Melee deploy/idle animations -----------------------------------
    // Two decorative flourishes, both from the weapon's own def
    // (shared/defs/gameObjects/meleeDefs.ts):
    //  - Anim.DeployMelee, `deployAnims` - played when the melee comes out
    //    (the karambit spin, the bayonet unsheathe, the knuckle slam), from
    //    weaponManager.ts's playMeleeDeployAnim.
    //  - Anim.IdleMelee, `idleAnims` - played when you press Equip Melee or
    //    Stow while already holding it, from playMeleeIdleAnim
    //    (server/src/game/objects/player.ts's input handler).
    // Both do nothing but pose bones for deployAnimTime/idleAnimTime
    // seconds. Nothing about reach, cooldown or when a swing lands is tied to
    // them, and the game itself treats them as skippable (neither plays while
    // any other animation is running, and a swing overwrites either).
    //
    // So suppressing one is a matter of turning that animation type into
    // Anim.None as it is handed to playAnim - the same thing a melee with no
    // such anims of its own already gets. The wrap goes on Player.prototype
    // (playAnim and its Anim argument are plain, unmangled - only m_-prefixed
    // members get renamed) so it covers every player from one install, and
    // the sequence number is passed through untouched, which is what keeps
    // client/src/objects/player.ts's `data.animSeq != this.anim.seq` test
    // agreeing with the server about which animations have been seen.
    const ANIM_NONE = 0;
    const ANIM_DEPLOY_MELEE = 7;
    const ANIM_IDLE_MELEE = 8;

    let deployAnimHookInstalled = false;
    /** @param {any} ctx */
    function installDeployAnimHook(ctx) {
        if (deployAnimHookInstalled) return;
        const activePlayer = ctx.activePlayer;
        if (!activePlayer) return;
        const proto = Object.getPrototypeOf(activePlayer);
        if (!proto || typeof proto.playAnim !== "function") return;
        const original = proto.playAnim;
        proto.playAnim = function (type, seq) {
            if ((type === ANIM_DEPLOY_MELEE || type === ANIM_IDLE_MELEE) && suppressMeleeAnim(type, this)) {
                return original.call(this, ANIM_NONE, seq);
            }
            return original.call(this, type, seq);
        };
        deployAnimHookInstalled = true;
        MOUSE.log("melee deploy/idle anim hook installed (Player.prototype.playAnim)");
    }

    /** Asked per animation rather than at install time, so the setting (and
     * the module's own switch) takes effect the moment it is flipped.
     * @param {number} type ANIM_DEPLOY_MELEE or ANIM_IDLE_MELEE
     * @param {any} p the Player about to play the animation */
    function suppressMeleeAnim(type, p) {
        if (!MOUSE.modules.isActive(MODULE_ID)) return false;
        const key = type === ANIM_IDLE_MELEE ? "meleeIdleAnim" : "meleeDeployAnim";
        if (!MOUSE.modules.getSetting(MODULE_ID, key, true)) return false;
        if (!MOUSE.modules.getSetting(MODULE_ID, "includeSelf", true)) {
            const activePlayer = MOUSE.ctx.activePlayer;
            if (activePlayer && p && p.__id === activePlayer.__id) return false;
        }
        return true;
    }

    // --- Particle loadout ---------------------------------------------
    /** @type {Map<number, {heal: string, boost: string}>} playerId -> real loadout */
    const originalLoadout = new Map();

    /** @param {number} id @param {any} info @param {{healParticles: boolean, boostParticles: boolean}} settings */
    function applyParticles(id, info, settings) {
        if (!info.loadout) return;
        if (!originalLoadout.has(id)) {
            originalLoadout.set(id, { heal: info.loadout.heal, boost: info.loadout.boost });
        }
        const orig = originalLoadout.get(id);
        info.loadout.heal = settings.healParticles ? "heal_basic" : orig.heal;
        info.loadout.boost = settings.boostParticles ? "boost_basic" : orig.boost;
    }

    function restoreAll() {
        const ctx = MOUSE.ctx;
        if (ctx.playerBarn) {
            const players = ctx.poolArray(ctx.playerBarn.playerPool);
            for (let i = 0; i < players.length; i++) {
                const p = players[i];
                if (!originalOutfit.has(p)) continue;
                const netData = ctx.readNetData(p);
                const key = netData && getOutfitKey(netData);
                if (key) restoreOutfit(p, netData, key);
            }
        }
        originalLoadout.forEach(function (orig, id) {
            const info = ctx.playerBarn && ctx.playerBarn.getPlayerInfo(id);
            if (info && info.loadout) {
                info.loadout.heal = orig.heal;
                info.loadout.boost = orig.boost;
            }
        });
        originalLoadout.clear();
    }

    function onTick(dt, ctx) {
        if (!ctx.ready) return;
        const settings = getSettings();
        installDeployAnimHook(ctx);
        const defaultOutfits = settings.outfits && !!MOUSE.gameDefs;
        const players = ctx.poolArray(ctx.playerBarn.playerPool);
        const activeId = ctx.activePlayer.__id;

        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (!p.active) continue;
            if (!settings.includeSelf && p.__id === activeId) continue;

            const netData = ctx.readNetData(p);
            const key = netData && getOutfitKey(netData);
            if (key) {
                const current = netData[key];
                const def = MOUSE.gameDefs && MOUSE.gameDefs.typeToDefSafe(current);
                const isGhillie = !!(def && def.ghillie);

                if (defaultOutfits && !isGhillie && !isRoleLockedOutfit(def)) {
                    applyOutfitDefault(p, netData, key);
                } else if (originalOutfit.has(p)) {
                    if (current === "outfitBase") {
                        // Still wearing this module's own override while it
                        // has stopped applying to them - the setting being
                        // switched off mid-match, or the server having put
                        // them in a role-locked skin since. A real
                        // outfitBase is never tracked
                        // (applyOutfitDefault returns early for it), so
                        // this is unambiguously ours to put back.
                        restoreOutfit(p, netData, key);
                    } else {
                        // `current` here is already the outfit we want to keep (a ghillie or a role-locked
                        // skin, which this module never overrides) - it's whatever the server just pushed,
                        // not necessarily the value `originalOutfit` remembers (that's from whenever
                        // the override last started, which can be stale if the server changed the
                        // player's real outfit while it was active). restoreOutfit would overwrite
                        // netData with that stale value, so just drop the tracking instead; there's
                        // nothing to put back since netData was never touched this tick.
                        originalOutfit.delete(p);
                    }
                }
            }

            if (settings.healParticles || settings.boostParticles) {
                const info = ctx.playerBarn.getPlayerInfo(p.__id);
                if (info) applyParticles(p.__id, info, settings);
            }
        }
    }

    MOUSE.modules.register({
        id: MODULE_ID,
        name: "Anti-Cosmetics",
        description:
            "Forces outfits and heal/boost particles back to their default look for every player, and can skip the melee deploy and idle flourishes. Ghillie suits and role-locked skins (cobalt classes, faction leaders) are left alone.",
        settings: {
            includeSelf: {
                kind: "bool",
                label: "Include myself",
                default: true,
                hint: "Apply everything below to your own player too, not just everyone else.",
            },
            outfits: {
                kind: "bool",
                label: "Default outfits",
                default: true,
                hint: "Every outfit shows as the plain default, except ghillie suits and role skins (cobalt classes, faction leaders).",
            },
            healParticles: {
                kind: "bool",
                label: "Default heal particles",
                default: true,
            },
            boostParticles: {
                kind: "bool",
                label: "Default boost particles",
                default: true,
            },
            meleeDeployAnim: {
                kind: "bool",
                label: "No melee pull-out animation",
                default: true,
                hint: "Skips the flourish a melee plays when it comes out (karambit spin, bayonet unsheathe). Purely visual - reach, cooldown and swing timing are unchanged.",
            },
            meleeIdleAnim: {
                kind: "bool",
                label: "No melee idle animation",
                default: true,
                hint: "Skips the flourish played when you press Equip Melee while already holding it. Purely visual.",
            },
        },
        onDisable() {
            restoreAll();
        },
        onTick,
    });
})();
