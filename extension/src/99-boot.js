// 99-boot.js
//
// Last file loaded. By this point every module has already registered
// itself (registration happens as each module's own file executes) and the
// GUI has built its DOM tree but not attached it to the page yet - this is
// the one line that actually does that, kept separate so 31-gui.js stays
// focused on building the panel rather than deciding when it should appear.
//
// If the kill switch (?nomouse / localStorage.mouseDisable) was tripped in
// 00-loader.js, the game bundle was never intercepted or patched at all, so
// there is nothing for the GUI to attach to or control - skip mounting it
// entirely so ?nomouse gives a genuinely vanilla page, not a non-functional
// panel sitting on top of one.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    if (MOUSE.disabled) {
        return;
    }

    MOUSE.gui.mount();
})();
