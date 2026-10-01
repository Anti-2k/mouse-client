// 34-hudstack.js
//
// A shared vertical stack of HUD rows, so the FPS/ping readout (35-nethud.js)
// and the match timer (36-timerhud.js) can each own one line of text without
// either one needing to know the other's height. One `position: fixed` flex
// column, anchored under #ui-top-left with a getBoundingClientRect +
// memo-key recipe - #ui-top-left is the team HUD's container, present,
// empty and positioned even solo, and getBoundingClientRect is what already
// accounts for the game's own UI-scale CSS transform on it.
//
// Rows are addressed by a small string id and kept sorted by an `order`
// number a consumer passes once; nethud uses 10 (FPS) and 20 (ping),
// timerhud uses 30, so FPS/ping render above the timer as asked. The
// container and its rows are created lazily and never removed, only
// hidden - same convention 33-hud.js's own elements use - so there is
// nothing to recreate across a GUI re-render or a match change.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const STACK_ID = "mouse-hud-stack";

    const ROW_STYLE = {
        fontSize: "16px",
        fontWeight: "bold",
        fontFamily: "Arial, sans-serif",
        color: "#ffffff",
        textShadow: "0 0 2px #000, 0 0 2px #000, 0 0 2px #000",
        pointerEvents: "none",
        userSelect: "none",
        whiteSpace: "nowrap",
    };

    /** @type {Map<string, {order: number, el: HTMLDivElement}>} */
    const rows = new Map();

    function ensureStack() {
        let stack = document.getElementById(STACK_ID);
        if (stack) return /** @type {HTMLDivElement} */ (stack);
        stack = document.createElement("div");
        stack.id = STACK_ID;
        Object.assign(stack.style, {
            position: "fixed",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: "4px",
            zIndex: "5",
        });
        document.body.appendChild(stack);
        return /** @type {HTMLDivElement} */ (stack);
    }

    /** Re-inserts every row in ascending `order`, cheap enough to just do
     * on every row() call rather than tracking whether order actually
     * changed - there are only ever a handful of rows. */
    function resort(stack) {
        const sorted = Array.from(rows.values()).sort((a, b) => a.order - b.order);
        for (let i = 0; i < sorted.length; i++) stack.appendChild(sorted[i].el);
    }

    /**
     * Returns the row div for `id`, creating it (and giving it the shared
     * text style) the first time. Safe to call every tick; a second call
     * with the same id is a no-op besides making sure it's visible.
     * @param {string} id
     * @param {number} order lower renders higher in the stack
     * @returns {HTMLDivElement}
     */
    function row(id, order) {
        const stack = ensureStack();
        let entry = rows.get(id);
        if (!entry) {
            const el = document.createElement("div");
            Object.assign(el.style, ROW_STYLE);
            entry = { order: order, el: el };
            rows.set(id, entry);
            resort(stack);
        } else if (entry.order !== order) {
            entry.order = order;
            resort(stack);
        }
        entry.el.style.display = "";
        return entry.el;
    }
    MOUSE.hudStack = MOUSE.hudStack || {};
    MOUSE.hudStack.row = row;

    /** Hides a row without removing it - matches 33-hud.js's own
     * show/hide-only convention for its elements.
     * @param {string} id
     */
    function release(id) {
        const entry = rows.get(id);
        if (entry) entry.el.style.display = "none";
    }
    MOUSE.hudStack.release = release;

    /** The last position actually written, so a normal frame is a rect read
     * plus a string compare rather than a style write. */
    let lastLayout = "";

    function layout() {
        const stack = document.getElementById(STACK_ID);
        const topLeft = document.getElementById("ui-top-left");
        if (!stack || !topLeft) return;
        const rect = topLeft.getBoundingClientRect();
        const key = rect.left + "/" + rect.bottom;
        if (key === lastLayout) return;
        lastLayout = key;
        stack.style.left = rect.left + "px";
        stack.style.top = rect.bottom + 8 + "px";
    }

    MOUSE.ctx.onTick(function (dt, ctx) {
        void dt;
        if (!ctx.ready || rows.size === 0) return;
        layout();
    });
})();
