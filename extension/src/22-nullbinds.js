// 22-nullbinds.js
//
// Null binds: holding one move key then tapping the opposite one currently
// stops you dead, because client/src/game.ts sends moveLeft/moveRight (and
// moveUp/moveDown) as two independent booleans and the server's movement
// integration just cancels them out. This module makes the most recently
// pressed of an opposing pair win instead, and releasing it re-activates
// whichever key is still held - "null binds" in the FPS sense.
//
// Entirely bind-index based: it watches ctx.Input.MoveLeft/Right/Up/Down via
// ctx.rawBindDown, which is whatever the player has those bound to, WASD or
// otherwise. There is nothing to configure for "which keys" and no reason to
// add such a setting - it could only ever disagree with the game.
//
// Detection is per-frame edge detection on isBindDown rather than a raw
// keydown/mousedown listener, on purpose: a move bind can be a mouse button
// or wheel notch (client/src/inputBinds.ts's BindDefs places no restriction
// on it), which a keyboard listener cannot see at all, and 31-gui.js installs
// its own capture-phase key/mouse listeners for bind-capture and the R-Shift
// toggle that can intercept an event before the game (or a listener here)
// ever sees it. isBindDown reads the game's own InputHandler state, so it is
// by construction the same truth the game acts on - and frame granularity
// costs nothing, since the game itself only samples input once per rendered
// frame before diff-gating the packet.
//
// Suppression (ctx.suppressInput, 10-ctx.js) is level-triggered: this module
// re-asserts it every tick for as long as the conflict lasts, and clearing
// happens automatically - one frame after this module stops calling it,
// whether because the conflict ended, the module was disabled, or the whole
// extension's master switch went off - with no separate teardown needed.
//
// Known limitation: client/src/game.ts also has an *unbound-arrow-key*
// movement fallback (`keyDown(Key.Left) && !isKeyBound(Key.Left)`, and the
// same for Right/Up/Down) that only this module's own suppression cannot
// reach, since it reads straight off the game's own mangled input handler
// rather than through isBindDown. If your move binds are not the arrow keys,
// the arrow keys still move you and are not covered by null binds.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;
    const Input = MOUSE.ctx ? MOUSE.ctx.Input : null;

    const MODULE_ID = "nullbinds";

    /** Which of an opposing pair currently "wins", per axis - null means no
     * conflict is being resolved (nothing held, or only one side held).
     * @type {Array<number | null>} */
    const winner = [null, null];
    /** @type {Record<number, boolean>} */
    const prevDown = {};

    function getSettings() {
        const get = (key, fallback) => MOUSE.modules.getSetting(MODULE_ID, key, fallback);
        return {
            horizontal: get("horizontal", true),
            vertical: get("vertical", true),
        };
    }

    /**
     * Resolves one axis's winner from this frame's raw hold state and last
     * frame's, then applies (or clears) suppression on the loser.
     * @param {any} ctx @param {number} axisIdx @param {number} a @param {number} b @param {boolean} enabled
     */
    function resolveAxis(ctx, axisIdx, a, b, enabled) {
        const aDown = !!ctx.rawBindDown(a);
        const bDown = !!ctx.rawBindDown(b);
        const aWasDown = !!prevDown[a];
        const bWasDown = !!prevDown[b];
        let w = winner[axisIdx];

        if (aDown && !aWasDown) w = bDown ? a : (w === null ? a : w);
        if (bDown && !bWasDown) w = aDown ? b : (w === null ? b : w);
        if (aDown && bDown && !aWasDown && !bWasDown) w = null; // both appeared this frame: no ordering info
        if (!aDown && w === a) w = bDown ? b : null;
        if (!bDown && w === b) w = aDown ? a : null;
        if (!aDown && !bDown) w = null;

        winner[axisIdx] = w;
        prevDown[a] = aDown;
        prevDown[b] = bDown;

        const conflict = enabled && aDown && bDown && w !== null;
        ctx.suppressInput(a, conflict && w === b);
        ctx.suppressInput(b, conflict && w === a);
    }

    function onTick(dt, ctx) {
        void dt;
        if (!ctx.ready || !Input || typeof ctx.rawBindDown !== "function") return;
        const settings = getSettings();
        resolveAxis(ctx, 0, Input.MoveLeft, Input.MoveRight, settings.horizontal);
        resolveAxis(ctx, 1, Input.MoveUp, Input.MoveDown, settings.vertical);
    }

    /** Small reverse lookup for the legacy keyCodes survev's own bind menu
     * uses (client/src/input.ts's Key enum), just for a readable console
     * line - not exhaustive, only what a move bind is plausibly set to. */
    const KEY_NAMES = {
        8: "Backspace", 13: "Enter", 16: "Shift", 17: "Ctrl", 18: "Alt", 27: "Escape",
        32: "Space", 37: "Left", 38: "Up", 39: "Right", 40: "Down",
        48: "0", 49: "1", 50: "2", 51: "3", 52: "4", 53: "5", 54: "6", 55: "7", 56: "8", 57: "9",
        65: "A", 66: "B", 67: "C", 68: "D", 69: "E", 70: "F", 71: "G", 72: "H", 73: "I", 74: "J",
        75: "K", 76: "L", 77: "M", 78: "N", 79: "O", 80: "P", 81: "Q", 82: "R", 83: "S", 84: "T",
        85: "U", 86: "V", 87: "W", 88: "X", 89: "Y", 90: "Z",
    };

    /** @param {any} bind InputBinds.getBind()'s return: {type, code} | null | undefined */
    function bindName(bind) {
        if (!bind) return "unbound";
        if (bind.type === 2) return "Mouse" + (bind.code + 1); // InputType.MouseButton
        if (bind.type === 3) return bind.code === 1 ? "Wheel up" : "Wheel down"; // InputType.MouseWheel
        return KEY_NAMES[bind.code] || ("key " + bind.code);
    }

    function logDetectedBinds() {
        const ctx = MOUSE.ctx;
        const binds = ctx && ctx.inputBinds;
        if (!binds || typeof binds.getBind !== "function") {
            MOUSE.log("null binds: not in a match yet, can't read binds");
            return;
        }
        MOUSE.log(
            "null binds detected move keys - Left: " + bindName(binds.getBind(Input.MoveLeft))
                + " · Right: " + bindName(binds.getBind(Input.MoveRight))
                + " · Up: " + bindName(binds.getBind(Input.MoveUp))
                + " · Down: " + bindName(binds.getBind(Input.MoveDown)),
        );
    }

    MOUSE.modules.register({
        id: MODULE_ID,
        name: "Null binds",
        description:
            "Last-key-priority movement: holding one direction then tapping its opposite switches to the new one instead of cancelling out, and releasing it hands control back to whichever key is still held. Works with any keybinds - nothing is hardcoded to WASD. Does not cover the game's unbound-arrow-key fallback if your move binds aren't the arrow keys - see this module's file header.",
        settings: {
            horizontal: { kind: "bool", label: "Left / Right", default: true },
            vertical: { kind: "bool", label: "Up / Down", default: true },
            logBinds: {
                kind: "action",
                label: "Detected move binds",
                buttonLabel: "Log to console",
                default: null,
                onClick: logDetectedBinds,
            },
        },
        onDisable() {
            if (!Input) return;
            MOUSE.ctx.suppressInput(Input.MoveLeft, false);
            MOUSE.ctx.suppressInput(Input.MoveRight, false);
            MOUSE.ctx.suppressInput(Input.MoveUp, false);
            MOUSE.ctx.suppressInput(Input.MoveDown, false);
            winner[0] = null;
            winner[1] = null;
        },
        onTick,
    });
})();
