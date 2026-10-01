// 00-loader.js
//
// Runs at document_start, in the page's MAIN world, before the game's own
// script tag has been parsed. Its job is narrow: intercept the single
// <script type="module"> that boots survev.io, fetch its real text, patch in
// a couple of capture hooks at method names that survive minification, and
// re-inject the patched text as a blob module. Everything else (the modules,
// the GUI) is built on top of what gets captured here.
//
// If a game update moves the anchors this patches, this file is designed to
// fail soft: the original bundle still gets injected unmodified, the game
// still plays, and later files just see "ctx never became ready" instead of
// a blank page.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;

    const LOG_PREFIX = "[mouse]";

    /**
     * Shared namespace every other file in this extension hangs its state
     * off of. Kept as plain fields (no framework) since this is a handful of
     * files sharing one global on purpose.
     */
    w.__MOUSE = {
        /** @param {...any} args */
        log(...args) {
            console.log(LOG_PREFIX, ...args);
        },
        /** @param {...any} args */
        warn(...args) {
            console.warn(LOG_PREFIX, ...args);
        },
        disabled: false,
        /** This client's own version. Bump this, TARGET and `version` in
         * manifest.json together when cutting a release. */
        VERSION: "1.0.0",
        /** The survev.io build this client release is built and tested
         * against. `build` is the full git commit survev.io embeds in its
         * own bundle as `clientGitVersion` (see the versionMatch regex
         * below); `survev` is the human version number survev.io shows
         * next to "ver" in its own footer for that same build. Compared
         * against the live gameVersion below so the GUI can warn if the
         * running game has shipped a newer build than this client was
         * tagged against. */
        TARGET: {
            survev: "0.4.3",
            build: "6d25af641dbf83bced9a65fc55148a2503832c65",
        },
        captured: /** @type {Record<string, any>} */ ({}),
        /** Absolute URLs of every chunk the bundle statically imports,
         * collected while absolutizing import specifiers in patchBundle
         * below. 15-defs.js re-imports these to reach the game's own gun
         * defs object - re-importing the same URL a module has already
         * been loaded from hands back the very same live instance rather
         * than a fresh copy, since the browser's module cache is keyed by
         * URL. */
        chunkUrls: /** @type {string[]} */ ([]),
        /** The live game's own build commit, scraped from the bundle text
         * in patchBundle below; null until the bundle has been fetched. */
        gameVersion: /** @type {string | null} */ (null),
        /**
         * Called from inside the patched bundle, every time the patched
         * method runs - which is constantly (addPIXIObj fires every frame
         * for every visible object). Game.init() rebuilds the renderer,
         * player barn, and loot barn from scratch on every single match
         * join and Game.free() discards them when a match ends, so this
         * has to track whichever instance is *currently* live rather than
         * remembering only the first one it ever saw - otherwise the whole
         * client goes dead the moment a second match starts. The identity
         * check keeps this cheap on the hot path: no allocation, and a log
         * line only when the instance actually changed.
         * @param {string} name
         * @param {any} obj
         */
        capture(name, obj) {
            if (w.__MOUSE.captured[name] !== obj) {
                w.__MOUSE.captured[name] = obj;
                w.__MOUSE.log("captured " + name);
            }
        },
        loaderStatus: {
            patchedAnchors: 0,
            totalAnchors: 2,
            attached: false,
        },
    };

    // --- Kill switch ---------------------------------------------------
    // ?nomouse on the URL, or localStorage.mouseDisable set, loads the vanilla
    // game with nothing patched. This is the escape hatch for when a game
    // update breaks the patch below.
    let disabled = false;
    try {
        disabled = new URLSearchParams(location.search).has("nomouse");
    } catch (_e) {
        /* ignore */
    }
    try {
        if (!disabled && localStorage.getItem("mouseDisable")) {
            disabled = true;
        }
    } catch (_e) {
        /* localStorage inaccessible; treat as not disabled */
    }
    if (disabled) {
        w.__MOUSE.disabled = true;
        w.__MOUSE.log("disabled via nomouse / mouseDisable, loading vanilla game");
        return;
    }

    // --- Track whether the page's own load events already fired --------
    // We run at document_start, so DOMContentLoaded/load have not fired yet
    // *now*, but by the time our fetch-and-patch round trip finishes they
    // may well have, since removing the blocking <script type=module> lets
    // the parser reach the end of the document immediately. If that happens
    // before the game's own Application() has registered its listeners for
    // those events, the game hangs on "loading" forever. See
    // maybeRedispatchPageEvents() below.
    const pageEvents = { dclFired: false, loadFired: false, redispatched: false };
    document.addEventListener(
        "DOMContentLoaded",
        function () {
            pageEvents.dclFired = true;
        },
        { once: true },
    );
    window.addEventListener(
        "load",
        function () {
            pageEvents.loadFired = true;
        },
        { once: true },
    );

    function maybeRedispatchPageEvents() {
        if (pageEvents.redispatched) return;
        pageEvents.redispatched = true;
        if (pageEvents.dclFired) {
            w.__MOUSE.log("re-dispatching DOMContentLoaded for the game's own listeners");
            document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true, cancelable: true }));
        }
        if (pageEvents.loadFired) {
            w.__MOUSE.log("re-dispatching load for the game's own listeners");
            window.dispatchEvent(new Event("load"));
        }
    }

    // --- Patch anchors ---------------------------------------------------
    // Both are non-mangled method definitions in the minified bundle, found
    // by shape rather than by name-with-source-formatting since the build
    // strips all whitespace. Verified against the live bundle at time of
    // writing:
    //   addPIXIObj(e,t,n,r){...       -> renderer, and renderer.game is Game
    //   getPlayerById(e){...          -> the PlayerBarn instance
    // Either one alone is enough to bootstrap everything downstream, so the
    // two are deliberately redundant.
    const PATCHES = [
        {
            name: "addPIXIObj -> renderer",
            re: /addPIXIObj\((\w+),(\w+),(\w+),(\w+)\)\{/,
            replace: function (_m, a, b, c, d) {
                return (
                    "addPIXIObj(" +
                    a +
                    "," +
                    b +
                    "," +
                    c +
                    "," +
                    d +
                    '){window.__MOUSE.capture("renderer",this);'
                );
            },
        },
        {
            name: "getPlayerById -> playerBarn",
            re: /getPlayerById\((\w+)\)\{/,
            replace: function (_m, a) {
                return "getPlayerById(" + a + '){window.__MOUSE.capture("playerBarn",this);';
            },
        },
    ];

    /**
     * @param {string} text
     * @param {string} baseUrl absolute URL of the original script, used to
     *   resolve the relative import specifiers that a blob module cannot
     *   resolve on its own.
     */
    function patchBundle(text, baseUrl) {
        let patched = text;
        let patchedCount = 0;

        for (let i = 0; i < PATCHES.length; i++) {
            const patch = PATCHES[i];
            if (patch.re.test(patched)) {
                patched = patched.replace(patch.re, patch.replace);
                patchedCount++;
            } else {
                w.__MOUSE.warn("patch anchor missing: " + patch.name + " (game may have updated)");
            }
        }

        // Absolutize relative static/dynamic import specifiers so they
        // resolve against the real script origin instead of the blob URL.
        // The live bundle only ever uses double-quoted specifiers
        // (from"./chunk.js"), so only that form is handled.
        const base = baseUrl.slice(0, baseUrl.lastIndexOf("/") + 1);
        patched = patched.replace(/((?:from|import)\s*\(?\s*)"(\.\/[^"]+)"/g, function (_full, prefix, spec) {
            const abs = base + spec.slice(2);
            if (w.__MOUSE.chunkUrls.indexOf(abs) === -1) w.__MOUSE.chunkUrls.push(abs);
            return prefix + '"' + abs + '"';
        });

        // The bundle embeds its own build's git commit (used for the
        // in-game error reporter) as a plain string literal, e.g.
        // clientGitVersion:`506abe6a...`. Reading it costs nothing since
        // the text is already in hand, and it's the only reliable signal
        // for whether survev.io has shipped a build newer than the one
        // extension/src/14-skins-data.js (the skin changer's sprite data)
        // is tagged to - see docs/SKINS.md.
        const versionMatch = patched.match(/clientGitVersion\s*:\s*[`"']([0-9a-f]{7,40})[`"']/);
        w.__MOUSE.gameVersion = versionMatch ? versionMatch[1] : null;

        w.__MOUSE.loaderStatus.patchedAnchors = patchedCount;
        w.__MOUSE.loaderStatus.totalAnchors = PATCHES.length;
        return patched;
    }

    /**
     * Fetches, patches, and injects one intercepted entry-module script tag.
     * Chained through a shared promise so relative order is preserved if
     * more than one matching tag ever shows up.
     * @param {HTMLScriptElement} node
     */
    async function reinject(node) {
        const src = node.src; // resolved absolute URL, not the raw attribute
        let text;
        try {
            const res = await fetch(src, { credentials: "same-origin" });
            text = await res.text();
        } catch (e) {
            w.__MOUSE.warn("failed to fetch bundle, falling back to a plain script tag", e);
            const fallback = document.createElement("script");
            fallback.type = "module";
            fallback.src = src;
            document.documentElement.appendChild(fallback);
            return;
        }

        let patched;
        try {
            patched = patchBundle(text, src);
        } catch (e) {
            w.__MOUSE.warn("patching threw, injecting the original bundle unmodified", e);
            patched = text;
        }

        const blob = new Blob([patched], { type: "text/javascript" });
        const blobUrl = URL.createObjectURL(blob);

        const replacement = document.createElement("script");
        replacement.type = "module";
        replacement.src = blobUrl;
        replacement.addEventListener("load", function () {
            w.__MOUSE.loaderStatus.attached = true;
            w.__MOUSE.log(
                "bundle evaluated (" +
                    w.__MOUSE.loaderStatus.patchedAnchors +
                    "/" +
                    w.__MOUSE.loaderStatus.totalAnchors +
                    " anchors patched)",
            );
            maybeRedispatchPageEvents();
            // Blob URLs are cheap to leak for the page lifetime of a single
            // SPA load, but there is no reason to hold onto it once the
            // module graph has finished evaluating.
            URL.revokeObjectURL(blobUrl);
        });
        replacement.addEventListener("error", function (e) {
            w.__MOUSE.warn("patched bundle failed to evaluate", e);
        });

        document.documentElement.appendChild(replacement);
    }

    const ENTRY_RE = /\/js\/[A-Za-z0-9_-]+\.js$/;
    let chain = Promise.resolve();

    function isEntryModuleScript(node) {
        if (!(node instanceof HTMLScriptElement)) return false;
        if (node.type !== "module" || !node.src) return false;
        let url;
        try {
            url = new URL(node.src, location.href);
        } catch (_e) {
            return false;
        }
        return url.origin === location.origin && ENTRY_RE.test(url.pathname);
    }

    /** @param {HTMLScriptElement} node */
    function intercept(node) {
        // Neutralize execution immediately. This has to happen synchronously
        // inside the observer callback, before the parser gets a chance to
        // treat the node as a module script to run.
        node.type = "mouse/blocked";
        node.remove();
        chain = chain.then(function () {
            return reinject(node);
        });
    }

    const observer = new MutationObserver(function (mutations) {
        for (let i = 0; i < mutations.length; i++) {
            const addedNodes = mutations[i].addedNodes;
            for (let j = 0; j < addedNodes.length; j++) {
                const added = addedNodes[j];
                if (isEntryModuleScript(added)) {
                    intercept(/** @type {HTMLScriptElement} */ (added));
                }
                // Some browsers/pages insert scripts via a wrapping
                // DocumentFragment; walk descendants defensively.
                if (added instanceof Element && added.querySelectorAll) {
                    const nested = added.querySelectorAll("script[type=module][src]");
                    for (let k = 0; k < nested.length; k++) {
                        if (isEntryModuleScript(nested[k])) {
                            intercept(/** @type {HTMLScriptElement} */ (nested[k]));
                        }
                    }
                }
            }
        }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    w.__MOUSE.log("loader installed, waiting for the game bundle");
})();
