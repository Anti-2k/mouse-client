// 33-hud.js
//
// Health / adrenaline numbers: a numeric readout layered on top of the
// game's own bars rather than replacing them. Values come straight off
// client/src/ui/ui2.ts's UiManager2 (ctx.ui2, 10-ctx.js): `newState.health`
// and `newState.boost` are plain fields the game itself keeps up to date
// every frame, so this only ever displays what the game already computed -
// no separate health/boost tracking of its own.
//
// The match timers (36-timerhud.js) and the FPS/ping readouts
// (35-nethud.js) are separate modules that render into 34-hudstack.js's
// shared stack; this one only overlays the game's own two bars.
//
// No settings of its own on purpose: the module's enable switch already
// answers "show these numbers or not", so a second `numbers` toggle inside
// it was a distinction without a difference - removing it also means no
// expand arrow in the panel (MOUSE.modules.register's settings: {} is what
// 31-gui.js's hasSettings check reads to skip the arrow).

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const MODULE_ID = "hud";

    const NUM_STYLE = {
        position: "absolute",
        right: "6px",
        fontSize: "14px",
        fontWeight: "bold",
        fontFamily: "Arial, sans-serif",
        color: "#ffffff",
        textShadow: "0 0 2px #000, 0 0 2px #000, 0 0 2px #000",
        pointerEvents: "none",
        userSelect: "none",
        zIndex: "5",
    };

    /** Fallback for the health bar's height, matching game.css's
     * `#ui-health-counter .ui-bar-inner { height: 32px }` at desktop
     * widths. It drops to 18px under the small-viewport media query, which
     * is why the real value is measured below rather than assumed. */
    const HEALTH_BAR_HEIGHT = 32;

    /** How far below the health bar's centre the number sits, in px.
     * Centring the element on the bar is not the same as centring the digits
     * in it: the line box is centred on its own font metrics, which reserve
     * room under the baseline for descenders the digits do not have, so the
     * number reads high without this. Was briefly a slider while the right
     * value was being found; 8 is that value, so it is a constant again. */
    const HEALTH_NUM_OFFSET = 8;

    function ensureElements() {
        if (document.getElementById("mouse-hud-health-num")) return;
        const healthContainer = document.getElementById("ui-health-container");
        const boostCounter = document.getElementById("ui-boost-counter");
        if (!healthContainer || !boostCounter) return;

        if (getComputedStyle(healthContainer).position === "static") {
            healthContainer.style.position = "relative";
        }
        if (getComputedStyle(boostCounter).position === "static") {
            boostCounter.style.position = "relative";
        }

        // #ui-health-container is a positioning context with no height of
        // its own: both of its children are the absolutely-positioned bar
        // fills, so nothing is in flow and the box collapses to zero. A
        // `top: 50%` therefore resolves to 0 and puts the number on the
        // bar's top edge rather than through its middle. The real box is
        // measured off the bar itself in layoutHealthNum below.
        const healthNum = document.createElement("div");
        healthNum.id = "mouse-hud-health-num";
        Object.assign(healthNum.style, NUM_STYLE, {
            top: "0",
            height: HEALTH_BAR_HEIGHT + "px",
            display: "flex",
            alignItems: "center",
        });
        healthContainer.appendChild(healthNum);

        const boostNum = document.createElement("div");
        boostNum.id = "mouse-hud-boost-num";
        Object.assign(boostNum.style, NUM_STYLE, { bottom: "100%", marginBottom: "2px" });
        boostCounter.appendChild(boostNum);
    }

    /** The last layout actually written, so this is a compare on a normal
     * frame rather than three style writes. */
    let lastTop = -1;
    let lastHeight = -1;
    /** The bar's box as measured at the start of this frame, or null. */
    let barTop = 0;
    let barHeight = 0;
    let barMeasured = false;

    /**
     * Measures the health bar - at frame start (ctx.onFrameStart), before
     * anything has written to the DOM this frame, so the read never forces
     * a layout of its own.
     *
     * offsetTop/offsetHeight are unscaled CSS pixels relative to the
     * offsetParent - which is #ui-health-container, the very box this
     * element is positioned inside. getBoundingClientRect would need the
     * game's own UI-scale transform undone first; these do not.
     */
    MOUSE.ctx.onFrameStart(function () {
        barMeasured = false;
        if (!MOUSE.modules.isActive(MODULE_ID)) return;
        const bar = document.getElementById("ui-health-actual");
        if (!bar) return;
        barTop = bar.offsetParent === document.getElementById("ui-health-container") ? bar.offsetTop : 0;
        barHeight = bar.offsetHeight || HEALTH_BAR_HEIGHT;
        barMeasured = true;
    });

    /** Sits the health number on the bar, measured rather than assumed. */
    function layoutHealthNum() {
        const el = document.getElementById("mouse-hud-health-num");
        if (!el || !barMeasured) return;
        if (barTop === lastTop && barHeight === lastHeight) return;
        lastTop = barTop;
        lastHeight = barHeight;
        el.style.top = barTop + "px";
        el.style.height = barHeight + "px";
        el.style.transform = "translateY(" + HEALTH_NUM_OFFSET + "px)";
    }

    /** Text nodes are replaced on every textContent write, which dirties
     * layout even when the text is the same, so only write a change.
     * @param {HTMLElement} el @param {string} text */
    function setText(el, text) {
        if (el.textContent !== text) el.textContent = text;
    }

    function setVisible(visible) {
        const display = visible ? "" : "none";
        const healthNum = document.getElementById("mouse-hud-health-num");
        const boostNum = document.getElementById("mouse-hud-boost-num");
        if (healthNum && healthNum.style.display !== display) healthNum.style.display = display;
        if (boostNum && boostNum.style.display !== display) boostNum.style.display = display;
    }

    function onTick(dt, ctx) {
        void dt;
        if (!ctx.ready || !ctx.inGameScreen()) {
            setVisible(false);
            return;
        }

        if (!ctx.ui2 || !ctx.ui2.newState) {
            setVisible(false);
            return;
        }
        ensureElements();
        const healthNum = document.getElementById("mouse-hud-health-num");
        const boostNum = document.getElementById("mouse-hud-boost-num");
        if (healthNum && boostNum) {
            layoutHealthNum();
            setVisible(true);
            setText(healthNum, String(Math.ceil(ctx.ui2.newState.health)));
            setText(boostNum, String(Math.ceil(ctx.ui2.newState.boost)));
        }
    }

    MOUSE.modules.register({
        id: MODULE_ID,
        name: "Health numbers",
        description: "Numeric readouts on the health and adrenaline bars, on top of the game's own bars.",
        settings: {},
        onDisable() {
            setVisible(false);
        },
        onTick,
    });
})();
