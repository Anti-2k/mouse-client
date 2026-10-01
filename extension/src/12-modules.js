// 12-modules.js
//
// The module registry. A "module" is one feature of the client (Null binds,
// Lag smoothing, ...) described declaratively so the GUI can render it
// without bespoke markup per module. This file owns enabled state and key
// bindings; the modules themselves (22-nullbinds.js, 23-lagsmooth.js) only
// implement onEnable/onDisable/onTick.
//
// Every module starts disabled with bind: null. Nothing in this extension
// assigns a default keybind to a module - the GUI toggle and the user's own
// bind choice are the only ways a module turns on.
//
// A module with hidden: true (e.g. the skin changer) is enabled/disabled,
// ticked, and bindable exactly like any other module - it just does not get
// a row in the main panel, because it renders its own controls somewhere
// else (31-gui.js's render loop skips it; the hotkey matching loop does
// not).

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;
    const config = MOUSE.config;

    /**
     * @typedef {{
     *   id: string,
     *   name: string,
     *   description: string,
     *   settings: Record<string, import("./11-config.js").SettingDef>,
     *   hidden?: boolean,
     *   onEnable?: () => void,
     *   onDisable?: () => void,
     *   onTick?: (dt: number, ctx: any) => void,
     * }} ModuleDef
     */

    /** @type {Map<string, ModuleDef>} */
    const defs = new Map();
    /** @type {Map<string, boolean>} */
    const enabledCache = new Map();
    /** Notified whenever a module's enabled state actually changes, by any
     * route. The GUI's toggle switches subscribe so a module flipped by its
     * hotkey (or by toggleAll) redraws its switch instead of sitting there
     * showing the state it had before the keypress. Kept here rather than in
     * the GUI because the registry is the only place that sees every change.
     * @type {Array<(id: string, enabled: boolean) => void>} */
    const changeListeners = [];

    /** @param {(id: string, enabled: boolean) => void} fn */
    function onChange(fn) {
        changeListeners.push(fn);
    }

    // --- Master switch ---------------------------------------------------
    // One global "everything off" toggle sitting above per-module enabled
    // state, with its own bindable hotkey (unbound by default, like every
    // other bind here). Distinct from the ?nomouse kill switch in 00-loader.js:
    // that one is decided before the game bundle is even patched and needs a
    // reload to undo, whereas this is a runtime toggle for stepping out of
    // everything at once and back in without losing which modules were on.
    //
    // Turning it off runs each *individually enabled* module's own onDisable,
    // so anything a module has painted, tinted or tagged is properly undone
    // rather than merely frozen in place; turning it back on runs onEnable
    // for that same set. Per-module enabled state is never written during
    // this, so it survives untouched.
    config.ensureDefaults("global", { enabled: true, bind: null });
    let masterEnabled = config.get("global.enabled", true);
    /** @type {Array<(enabled: boolean) => void>} */
    const masterChangeListeners = [];

    /** @param {(enabled: boolean) => void} fn */
    function onMasterChange(fn) {
        masterChangeListeners.push(fn);
    }

    function isMasterEnabled() {
        return masterEnabled;
    }

    /** @param {boolean} value */
    function setMasterEnabled(value) {
        value = !!value;
        if (masterEnabled === value) return;
        masterEnabled = value;
        config.set("global.enabled", value);
        defs.forEach(function (def, id) {
            if (!enabledCache.get(id)) return;
            try {
                if (value && def.onEnable) def.onEnable();
                if (!value && def.onDisable) def.onDisable();
            } catch (e) {
                MOUSE.warn("module " + id + " threw during master enable/disable", e);
            }
        });
        for (let i = 0; i < masterChangeListeners.length; i++) {
            try {
                masterChangeListeners[i](value);
            } catch (e) {
                MOUSE.warn("master change listener threw", e);
            }
        }
    }

    function toggleMaster() {
        setMasterEnabled(!masterEnabled);
    }

    function getMasterBind() {
        return config.get("global.bind", null);
    }

    /** @param {any} bind serialized bind descriptor, or null to clear */
    function setMasterBind(bind) {
        config.set("global.bind", bind);
    }

    /** @param {string} id */
    function basePath(id) {
        return "modules." + id;
    }

    /**
     * @param {ModuleDef} def
     */
    function register(def) {
        if (defs.has(def.id)) {
            MOUSE.warn("module already registered: " + def.id);
            return;
        }
        defs.set(def.id, def);

        // Build the settings defaults object from the schema, then merge it
        // under whatever was already saved so old configs are not clobbered
        // when a module gains a new setting.
        /** @type {Record<string, any>} */
        const settingDefaults = {};
        for (const key in def.settings) {
            settingDefaults[key] = def.settings[key].default;
        }
        config.ensureDefaults(basePath(def.id) + ".settings", settingDefaults);
        config.ensureDefaults(basePath(def.id), { enabled: false, bind: null });

        const enabled = config.get(basePath(def.id) + ".enabled", false);
        enabledCache.set(def.id, false); // start neutral; setEnabled below fires onEnable correctly
        if (enabled) {
            setEnabled(def.id, true);
        }

        MOUSE.log("registered module: " + def.id);
    }

    /**
     * @param {string} id
     * @param {string} key
     * @param {any} fallback
     */
    function getSetting(id, key, fallback) {
        return config.get(basePath(id) + ".settings." + key, fallback);
    }

    /**
     * @param {string} id
     * @param {string} key
     * @param {any} value
     */
    function setSetting(id, key, value) {
        config.set(basePath(id) + ".settings." + key, value);
    }

    /** Whether the user has this module switched on - independent of the
     * master switch, so the GUI keeps showing which modules are on while
     * everything is globally off.
     * @param {string} id */
    function isEnabled(id) {
        return !!enabledCache.get(id);
    }

    /** Whether this module should actually be doing anything right now: its
     * own switch *and* the master switch. The tick loop below gates on this,
     * so a module driven purely by onTick never has to ask. A module hooking
     * something else (21-cosmetics.js, via a Player.prototype.playAnim wrap)
     * does have to ask, and should ask with this rather than isEnabled.
     * @param {string} id */
    function isActive(id) {
        return masterEnabled && !!enabledCache.get(id);
    }

    /**
     * @param {string} id
     * @param {boolean} value
     */
    function setEnabled(id, value) {
        const def = defs.get(id);
        if (!def) return;
        const was = enabledCache.get(id);
        if (was === value) return;
        enabledCache.set(id, value);
        config.set(basePath(id) + ".enabled", value);
        try {
            if (value && def.onEnable) def.onEnable();
            if (!value && def.onDisable) def.onDisable();
        } catch (e) {
            MOUSE.warn("module " + id + " threw during enable/disable", e);
        }
        // After the hooks, so a listener always observes settled state - and
        // outside the try above, so a module throwing in onEnable cannot
        // also leave the GUI showing the wrong thing.
        for (let i = 0; i < changeListeners.length; i++) {
            try {
                changeListeners[i](id, value);
            } catch (e) {
                MOUSE.warn("module change listener threw", e);
            }
        }
    }

    /** @param {string} id */
    function toggle(id) {
        setEnabled(id, !isEnabled(id));
    }

    /** @param {string} id */
    function getBind(id) {
        return config.get(basePath(id) + ".bind", null);
    }

    /**
     * @param {string} id
     * @param {any} bind serialized bind descriptor, or null to clear
     */
    function setBind(id, bind) {
        config.set(basePath(id) + ".bind", bind);
    }

    function list() {
        return Array.from(defs.values());
    }

    /** @param {string} id */
    function get(id) {
        return defs.get(id) || null;
    }

    // Drive every enabled module's onTick from the shared ctx tick loop.
    // Modules are expected to no-op quickly if ctx.ready is false.
    //
    // Each module is ticked inside its own try/catch. Without one, a single
    // module throwing aborted the whole forEach, so every module registered
    // after it silently stopped ticking too, and the only sign was one "tick
    // listener threw" line from 10-ctx.js that named no module. Throws are reported per module and then rate-limited to one
    // line every THROW_LOG_INTERVAL ms, because anything that throws once
    // in a frame callback usually throws sixty times a second.
    /** @type {Map<string, number>} */
    const lastThrowLog = new Map();
    const THROW_LOG_INTERVAL = 5000;

    MOUSE.ctx.onTick(function (dt, ctx) {
        if (!masterEnabled) return;
        defs.forEach(function (def, id) {
            if (!enabledCache.get(id)) return;
            if (!def.onTick) return;
            try {
                def.onTick(dt, ctx);
            } catch (e) {
                const now = Date.now();
                const last = lastThrowLog.get(id) || 0;
                if (now - last >= THROW_LOG_INTERVAL) {
                    lastThrowLog.set(id, now);
                    MOUSE.warn("module " + id + " threw during onTick", e);
                }
            }
        });
    });

    MOUSE.modules = {
        register,
        list,
        get,
        isEnabled,
        isActive,
        setEnabled,
        toggle,
        getBind,
        setBind,
        getSetting,
        setSetting,
        onChange,
        isMasterEnabled,
        setMasterEnabled,
        toggleMaster,
        getMasterBind,
        setMasterBind,
        onMasterChange,
    };
    MOUSE.log("module registry installed");
})();
