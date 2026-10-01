// 11-config.js
//
// A small schema-driven config store persisted to localStorage. Modules
// (22-nullbinds.js, 23-lagsmooth.js) describe their settings as a schema object;
// the GUI (31-gui.js) renders controls from that schema instead of each
// module hand-rolling markup. Values are deep-merged over defaults on load
// so adding a new setting later does not wipe a saved config, and saved
// values for settings that no longer exist are simply ignored.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const STORAGE_KEY = "mouseclient.config.v1";

    /**
     * @typedef {"bool"|"number"|"color"|"enum"|"action"} SettingKind
     * @typedef {{
     *   kind: SettingKind,
     *   label: string,
     *   default: any,
     *   min?: number,
     *   max?: number,
     *   step?: number,
     *   options?: Array<{value: string, label: string}>,
     *   hint?: string,
     *   unit?: string,
     *   zeroLabel?: string,
     *   showIf?: (get: (key: string) => any) => boolean,
     *   buttonLabel?: string,
     *   onClick?: () => void,
     * }} SettingDef
     */

    /**
     * @param {any} target
     * @param {any} source
     */
    function deepMerge(target, source) {
        if (typeof source !== "object" || source === null || Array.isArray(source)) {
            return source === undefined ? target : source;
        }
        const out = typeof target === "object" && target !== null ? { ...target } : {};
        for (const k in source) {
            if (!Object.prototype.hasOwnProperty.call(source, k)) continue;
            if (
                typeof source[k] === "object" &&
                source[k] !== null &&
                !Array.isArray(source[k]) &&
                typeof out[k] === "object" &&
                out[k] !== null &&
                !Array.isArray(out[k])
            ) {
                out[k] = deepMerge(out[k], source[k]);
            } else {
                out[k] = source[k];
            }
        }
        return out;
    }

    /** @type {Record<string, any>} */
    let store = {};

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                store = JSON.parse(raw);
            }
        } catch (e) {
            MOUSE.warn("failed to load saved config, starting fresh", e);
            store = {};
        }
    }

    let saveScheduled = false;
    function save() {
        if (saveScheduled) return;
        saveScheduled = true;
        // Coalesce bursts of setting changes (e.g. dragging a slider) into
        // one write.
        setTimeout(function () {
            saveScheduled = false;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
            } catch (e) {
                MOUSE.warn("failed to save config", e);
            }
        }, 150);
    }

    load();

    const config = {
        /**
         * Reads a value at a dotted path (e.g. "modules.lagsmooth.settings.percentile"),
         * falling back to `fallback` if nothing is stored yet.
         * @param {string} path
         * @param {any} [fallback]
         */
        get(path, fallback) {
            const parts = path.split(".");
            let node = store;
            for (let i = 0; i < parts.length; i++) {
                if (node === undefined || node === null) return fallback;
                node = node[parts[i]];
            }
            return node === undefined ? fallback : node;
        },
        /**
         * Writes a value at a dotted path, creating intermediate objects as
         * needed, and schedules a debounced save.
         * @param {string} path
         * @param {any} value
         */
        set(path, value) {
            const parts = path.split(".");
            let node = store;
            for (let i = 0; i < parts.length - 1; i++) {
                const key = parts[i];
                if (typeof node[key] !== "object" || node[key] === null) {
                    node[key] = {};
                }
                node = node[key];
            }
            node[parts[parts.length - 1]] = value;
            save();
        },
        /**
         * Merges `defaults` under whatever is already stored at `path`,
         * without discarding unrelated stored fields. Used once per module
         * at registration time so old configs pick up newly-added settings.
         * @param {string} path
         * @param {any} defaults
         */
        ensureDefaults(path, defaults) {
            const current = config.get(path, undefined);
            config.set(path, deepMerge(defaults, current || {}));
        },
        deepMerge,
    };

    MOUSE.config = config;
    MOUSE.log("config loaded");
})();
