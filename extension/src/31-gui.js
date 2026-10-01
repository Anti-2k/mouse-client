// 31-gui.js
//
// The click GUI: one or more draggable windows in a shared, closed shadow
// DOM tree. The main panel (toggled by Right Shift) renders itself from the
// module registry (12-modules.js) and each module's settings schema
// (11-config.js's SettingDef shape), so adding a module elsewhere in this
// extension does not require touching this file. Other files (32-gui-skins.js,
// 37-recorder.js) can open additional windows via MOUSE.gui.createWindow.
//
// Opening a window changes nothing about the game itself - you can still
// move, aim, and shoot normally while any window is open. Input isolation is
// scoped tightly and, unlike the first version of this file, lives in a
// small, fixed set of *permanently installed* listeners rather than ones
// that get added and removed as things happen:
//  - A single capture-phase `keydown`/`mousedown` pair on `window`, checked
//    in a fixed priority order every time (bind capture, then Right Shift,
//    then "is a GUI text field focused", then module hotkeys). Because
//    nothing is ever added or removed here, there is no listener to leak -
//    an interrupted bind capture cannot orphan anything and eat future
//    input, which a design that adds and removes listeners as it goes can.
//  - Bind capture (clicking a bind field, or a module's own hotkey) sets a
//    single `capturing` flag the two listeners above already check every
//    time - see startCapture/finishCapture. It also self-cancels on window
//    blur, on its owning window closing, and after 5s of no input.
//  - A click/scroll/drag that *lands on a window* does not also reach the
//    game underneath it - see attachPanelSwallow. It only swallows a
//    mouseup if that same window already swallowed the matching mousedown,
//    so releasing a game-started action (e.g. holding fire) over a window
//    still reaches the game instead of getting stuck held down.
//  - A module's own configurable hotkey toggles it without ever calling
//    preventDefault/stopPropagation - binding a module to a key is an
//    addition on top of normal play, not a replacement for whatever that
//    key already does in the game.
//  - While a GUI text field has focus, keydown is stopped from reaching the
//    game (so typing "ak" cannot walk you into the open) but keyup is never
//    touched, so a key held before focusing the field can still be released
//    normally instead of sticking down in the game.
//
// Every window shares one master visibility flag driven by Right Shift -
// there is no per-window ✕/open state, so it is not possible to hide the
// client while leaving another window (e.g. the skin changer) on screen. A
// window can still opt into being independently collapsible (its body/footer
// hidden behind a header arrow, see the `collapsible` createWindow option)
// which is a distinct, per-window, persisted concern from whether the whole
// client is showing at all.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;
    const config = MOUSE.config;

    const host = document.createElement("div");
    host.id = "mouse-client-gui-host";
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = MOUSE.guiCss;
    shadow.appendChild(style);

    // --- Bind capture ---------------------------------------------------
    // A single persistent flag, not a listener that gets installed/removed -
    // see the file header for why that distinction is the actual bug fix.
    /** @type {null | { fieldEl: HTMLElement, onSet: (bind: any) => void, timeoutId: any }} */
    let capturing = null;

    function bindLabel(bind) {
        if (!bind) return "None";
        if (bind.type === "key") return prettyKeyCode(bind.code);
        if (bind.type === "mouse") return "M" + (bind.button + 1);
        return "?";
    }

    function prettyKeyCode(code) {
        if (!code) return "?";
        if (code.startsWith("Key")) return code.slice(3);
        if (code.startsWith("Digit")) return code.slice(5);
        if (code.startsWith("Arrow")) return code.slice(5);
        const map = {
            ShiftLeft: "LShift",
            ShiftRight: "RShift",
            ControlLeft: "LCtrl",
            ControlRight: "RCtrl",
            AltLeft: "LAlt",
            AltRight: "RAlt",
            Space: "Space",
            Backquote: "`",
        };
        return map[code] || code;
    }

    /** Writes a bind's label into a keycap, dimming it while unbound.
     * @param {HTMLElement} fieldEl @param {any} bind */
    function setBindText(fieldEl, bind) {
        fieldEl.textContent = bind ? bindLabel(bind) : "";
        fieldEl.classList.toggle("unbound", !bind);
    }

    /** @param {HTMLElement} fieldEl @param {(bind: any) => void} onSet */
    function startCapture(fieldEl, onSet) {
        if (capturing) cancelCapture();
        fieldEl.classList.add("capturing");
        fieldEl.textContent = "Press a key...";
        const timeoutId = setTimeout(function () {
            if (capturing && capturing.fieldEl === fieldEl) finishCapture(null);
        }, 5000);
        capturing = { fieldEl, onSet, timeoutId };
    }

    /** @param {any} bind */
    function finishCapture(bind) {
        if (!capturing) return;
        const { fieldEl, onSet, timeoutId } = capturing;
        clearTimeout(timeoutId);
        capturing = null;
        fieldEl.classList.remove("capturing");
        onSet(bind);
    }

    /** Cancels without committing a bind - used for blur/hide/timeout. */
    function cancelCapture() {
        finishCapture(null);
    }

    window.addEventListener("blur", cancelCapture);

    // --- Window factory ---------------------------------------------------
    // Every window (the main panel, the skin changer, ...) is one of these,
    // living in the same shared shadow root so they share one input-capture
    // surface and one z-order space.
    //
    // Raising a window just swaps it onto the one "front" z-index and
    // demotes whichever window held it, rather than handing out an
    // ever-increasing z-index per click - a naive incrementing counter
    // would (very slowly, but for real, over enough clicks in a long play
    // session) walk past the maximum value CSS z-index accepts.
    let frontRoot = null;
    const Z_BACK = "2147483000";
    const Z_FRONT = "2147483001";

    // --- Master visibility -------------------------------------------------
    // One Right-Shift-driven flag shared by every window, rather than each
    // window remembering its own open/closed state - see the file header for
    // why. `windows` collects every root createWindow has ever produced so
    // setVisible can drive them all at once.
    /** @type {{ root: HTMLElement }[]} */
    const windows = [];
    let visible = !!config.get("gui.visible", false);
    function applyVisibility() {
        for (let i = 0; i < windows.length; i++) {
            windows[i].root.classList.toggle("hidden", !visible);
        }
    }
    function setVisible(value) {
        visible = value;
        config.set("gui.visible", value);
        applyVisibility();
        if (!value) cancelCapture();
    }
    function toggleAll() {
        setVisible(!visible);
    }

    /**
     * @param {{ id: string, title: string, tag?: string, width?: number, statusDot?: boolean, collapsible?: boolean, defaultPos?: {x:number,y:number} }} opts
     */
    function createWindow(opts) {
        const POS_KEY = "gui." + opts.id + ".pos";
        const COLLAPSE_KEY = "gui." + opts.id + ".collapsed";

        const root = document.createElement("div");
        root.className = "panel hidden";
        if (opts.width) root.style.width = opts.width + "px";

        const header = document.createElement("div");
        header.className = "header";
        const titleEl = document.createElement("div");
        titleEl.className = "title";
        let statusDot = null;
        if (opts.statusDot) {
            statusDot = document.createElement("span");
            statusDot.className = "status-dot";
            titleEl.appendChild(statusDot);
        }
        titleEl.appendChild(document.createTextNode(opts.title));
        if (opts.tag) {
            const tagEl = document.createElement("span");
            tagEl.className = "title-tag";
            tagEl.textContent = opts.tag;
            titleEl.appendChild(tagEl);
        }
        header.appendChild(titleEl);

        // Callers (e.g. 32-gui-skins.js, for its module switch + bind field)
        // append their own header controls in here rather than into `header`
        // directly, so control order stays predictable regardless of what a
        // window adds - see the CSS: .header-controls sits between the title
        // and the collapse arrow via margin-left: auto.
        const controls = document.createElement("div");
        controls.className = "header-controls";
        header.appendChild(controls);

        let collapsed = false;
        let collapseArrow = null;
        function applyCollapsed() {
            root.classList.toggle("collapsed", collapsed);
            if (collapseArrow) collapseArrow.textContent = collapsed ? "▶" : "▼";
        }
        if (opts.collapsible) {
            collapsed = !!config.get(COLLAPSE_KEY, false);
            collapseArrow = document.createElement("div");
            collapseArrow.className = "collapse-arrow";
            collapseArrow.addEventListener("pointerdown", function (e) {
                e.stopPropagation();
            });
            collapseArrow.addEventListener("click", function (e) {
                e.stopPropagation();
                collapsed = !collapsed;
                config.set(COLLAPSE_KEY, collapsed);
                applyCollapsed();
            });
            header.appendChild(collapseArrow);
        }
        applyCollapsed();

        root.appendChild(header);

        const body = document.createElement("div");
        body.className = "body";
        root.appendChild(body);

        const footer = document.createElement("div");
        footer.className = "footer";
        root.appendChild(footer);

        shadow.appendChild(root);

        function raise() {
            if (frontRoot === root) return;
            if (frontRoot) frontRoot.style.zIndex = Z_BACK;
            root.style.zIndex = Z_FRONT;
            frontRoot = root;
        }
        raise();
        root.addEventListener("pointerdown", raise, true);

        const savedPos = config.get(POS_KEY, null);
        if (savedPos && typeof savedPos.x === "number" && typeof savedPos.y === "number") {
            root.style.left = savedPos.x + "px";
            root.style.top = savedPos.y + "px";
        } else if (opts.defaultPos) {
            root.style.left = opts.defaultPos.x + "px";
            root.style.top = opts.defaultPos.y + "px";
        }

        windows.push({ root });
        root.classList.toggle("hidden", !visible);

        // --- Drag ---------------------------------------------------------
        // Pointer Events + setPointerCapture, not mousedown/mousemove/mouseup:
        // capturing the pointer on the header means it keeps receiving
        // pointermove/pointerup even if the cursor leaves the browser window
        // entirely mid-drag, so releasing the button outside the window still
        // ends the drag instead of leaving the panel chasing the cursor.
        (function setupDrag() {
            let dragging = false;
            let startX = 0;
            let startY = 0;
            let originX = 0;
            let originY = 0;

            header.addEventListener("pointerdown", function (e) {
                if (e.target === collapseArrow || controls.contains(e.target)) return;
                dragging = true;
                startX = e.clientX;
                startY = e.clientY;
                const rect = root.getBoundingClientRect();
                originX = rect.left;
                originY = rect.top;
                try {
                    header.setPointerCapture(e.pointerId);
                } catch (_e) {
                    /* ignore - unsupported pointer type */
                }
                e.preventDefault();
            });
            header.addEventListener("pointermove", function (e) {
                if (!dragging) return;
                const x = Math.max(0, originX + (e.clientX - startX));
                const y = Math.max(0, originY + (e.clientY - startY));
                root.style.left = x + "px";
                root.style.top = y + "px";
            });
            function endDrag() {
                if (!dragging) return;
                dragging = false;
                const rect = root.getBoundingClientRect();
                config.set(POS_KEY, { x: rect.left, y: rect.top });
            }
            header.addEventListener("pointerup", endDrag);
            header.addEventListener("pointercancel", endDrag);
            window.addEventListener("blur", endDrag);
        })();

        attachPanelSwallow(root);

        return {
            id: opts.id,
            root,
            header,
            controls,
            body,
            footer,
            statusDot,
        };
    }

    // A click/scroll/drag that *lands on* a window does not also reach the
    // game underneath it (so toggling a switch does not also fire a shot).
    // Only the mouseup matching a button this same window already swallowed
    // the mousedown for is itself swallowed - a mouseup whose mousedown the
    // game already saw (e.g. you started holding fire over the game, then
    // moved over the panel before releasing) passes through untouched, so
    // fire does not get stuck held down.
    function attachPanelSwallow(root) {
        const heldButtons = new Set();
        root.addEventListener("mousedown", function (e) {
            heldButtons.add(e.button);
            e.stopPropagation();
        });
        root.addEventListener("mouseup", function (e) {
            if (heldButtons.has(e.button)) {
                heldButtons.delete(e.button);
                e.stopPropagation();
            }
        });
        root.addEventListener("click", function (e) {
            e.stopPropagation();
        });
        root.addEventListener("wheel", function (e) {
            e.stopPropagation();
        });
        root.addEventListener("contextmenu", function (e) {
            e.stopPropagation();
        });
        window.addEventListener("blur", function () {
            heldButtons.clear();
        });
    }

    // --- Setting renderers ----------------------------------------------
    /**
     * @param {string} moduleId
     * @param {string} key
     * @param {import("./11-config.js").SettingDef} def
     * @param {() => void} [onChanged] called after every edit, so the module's
     *   panel can re-evaluate its settings' showIf conditions
     */
    function renderSetting(moduleId, key, def, onChanged) {
        return renderSettingRow(
            def,
            () => MOUSE.modules.getSetting(moduleId, key, def.default),
            (v) => {
                MOUSE.modules.setSetting(moduleId, key, v);
                if (onChanged) onChanged();
            },
        );
    }

    /**
     * One setting's row, wired to arbitrary get/set rather than a module's
     * settings - renderSetting is this bound to MOUSE.modules, and a window
     * whose settings are not a module's (the recorder, 37-recorder.js)
     * passes its own.
     * @param {import("./11-config.js").SettingDef} def
     * @param {() => any} get
     * @param {(v: any) => void} set
     */
    function renderSettingRow(def, get, set) {
        const row = document.createElement("div");
        row.className = "setting-row";

        const label = document.createElement("div");
        label.className = "setting-label";
        label.textContent = def.label;
        if (def.hint) {
            label.title = def.hint;
            label.classList.add("has-hint");
        }

        if (def.kind === "bool") {
            row.appendChild(label);
            const sw = document.createElement("div");
            sw.className = "switch" + (get() ? " on" : "");
            sw.appendChild(Object.assign(document.createElement("div"), { className: "switch-knob" }));
            sw.addEventListener("click", function () {
                const v = !get();
                set(v);
                sw.classList.toggle("on", v);
            });
            row.appendChild(sw);
        } else if (def.kind === "number") {
            row.appendChild(label);
            const wrap = document.createElement("div");
            wrap.style.display = "flex";
            wrap.style.alignItems = "center";
            wrap.style.gap = "6px";
            const input = document.createElement("input");
            input.type = "range";
            input.min = String(def.min ?? 0);
            input.max = String(def.max ?? 100);
            input.step = String(def.step ?? 1);
            input.value = String(get());
            paintRange(input);
            const valueLabel = document.createElement("span");
            valueLabel.className = "number-value";
            valueLabel.textContent = formatNumber(def, get());
            input.addEventListener("input", function () {
                const v = parseFloat(input.value);
                set(v);
                paintRange(input);
                valueLabel.textContent = formatNumber(def, v);
            });
            input.addEventListener("change", function () {
                input.blur();
            });
            wrap.appendChild(input);
            wrap.appendChild(valueLabel);
            row.appendChild(wrap);
        } else if (def.kind === "color") {
            row.appendChild(label);
            const input = document.createElement("input");
            input.type = "color";
            input.value = intToHex(get());
            input.addEventListener("input", function () {
                set(hexToInt(input.value));
            });
            input.addEventListener("change", function () {
                input.blur();
            });
            row.appendChild(input);
        } else if (def.kind === "enum") {
            row.appendChild(label);
            const select = document.createElement("select");
            for (const opt of def.options || []) {
                const o = document.createElement("option");
                o.value = opt.value;
                o.textContent = opt.label;
                select.appendChild(o);
            }
            select.value = get();
            select.addEventListener("change", function () {
                set(select.value);
            });
            row.appendChild(select);
        } else if (def.kind === "action") {
            row.appendChild(label);
            const btn = document.createElement("div");
            btn.className = "action-btn";
            btn.textContent = def.buttonLabel || "Open";
            btn.addEventListener("click", function () {
                if (def.onClick) def.onClick();
            });
            row.appendChild(btn);
        }

        return row;
    }
    /** A slider's readout: `zeroLabel` in place of 0 when the setting has one
     * (for "0 = off"-style settings), otherwise the value rounded to the
     * step's precision - a 0.05 step can otherwise read 0.35000000000000003 -
     * followed by the unit.
     * @param {import("./11-config.js").SettingDef} def @param {number} v */
    function formatNumber(def, v) {
        if (v === 0 && def.zeroLabel) return def.zeroLabel;
        const stepStr = String(def.step ?? 1);
        const decimals = stepStr.indexOf(".") === -1 ? 0 : stepStr.length - stepStr.indexOf(".") - 1;
        const text = Number(v).toFixed(decimals);
        return def.unit ? text + " " + def.unit : text;
    }

    /** Fills a slider's groove up to its value - the CSS reads --p, since
     * WebKit has no native "progress" part to style.
     * @param {HTMLInputElement} input */
    function paintRange(input) {
        const min = parseFloat(input.min) || 0;
        const max = parseFloat(input.max) || 100;
        const pct = max > min ? ((parseFloat(input.value) - min) / (max - min)) * 100 : 0;
        input.style.setProperty("--p", Math.max(0, Math.min(100, pct)) + "%");
    }

    function intToHex(n) {
        return "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6);
    }
    function hexToInt(hex) {
        return parseInt(hex.replace("#", ""), 16);
    }

    // --- Reusable module controls ----------------------------------------
    // A switch and a bind field, each wired straight to MOUSE.modules, factored
    // out of renderModule so a window that renders its own header (the skin
    // changer - see 32-gui-skins.js) can reuse the exact same widgets and
    // bind-capture wiring instead of duplicating them.
    /** @param {string} moduleId */
    function makeModuleSwitch(moduleId) {
        const sw = document.createElement("div");
        sw.className = "switch" + (MOUSE.modules.isEnabled(moduleId) ? " on" : "");
        sw.appendChild(Object.assign(document.createElement("div"), { className: "switch-knob" }));
        sw.addEventListener("pointerdown", function (e) {
            e.stopPropagation();
        });
        // The click only asks the registry to toggle; repainting the switch
        // is left entirely to the subscription below, so a module flipped by
        // its own hotkey or by toggleAll updates the switch through the exact
        // same path a click does and the two can never disagree.
        sw.addEventListener("click", function (e) {
            e.stopPropagation();
            MOUSE.modules.toggle(moduleId);
        });
        MOUSE.modules.onChange(function (id, enabled) {
            if (id !== moduleId) return;
            // render() replaces the main window's contents wholesale, which
            // would otherwise leave this listener repainting a detached
            // switch forever. Checking isConnected is cheaper than handing
            // out unsubscribe handles for it; elements inside an attached
            // shadow root report connected once the host is in the document.
            if (!sw.isConnected) return;
            sw.classList.toggle("on", enabled);
        });
        return sw;
    }

    /** @param {string} moduleId */
    function makeBindField(moduleId) {
        const field = document.createElement("div");
        field.className = "bind-field";
        setBindText(field, MOUSE.modules.getBind(moduleId));
        field.addEventListener("pointerdown", function (e) {
            e.stopPropagation();
        });
        field.addEventListener("click", function (e) {
            e.stopPropagation();
            startCapture(field, function (bind) {
                MOUSE.modules.setBind(moduleId, bind);
                setBindText(field, bind);
            });
        });
        return field;
    }

    /**
     * The same switch/bind pair as makeModuleSwitch/makeBindField, but wired
     * to arbitrary getters/setters instead of a module id - the master
     * switch is the one control that is not a module.
     * @param {() => boolean} isOn @param {() => void} toggleFn @param {(fn: (on: boolean) => void) => void} subscribe
     */
    function makeGenericSwitch(isOn, toggleFn, subscribe) {
        const sw = document.createElement("div");
        sw.className = "switch" + (isOn() ? " on" : "");
        sw.appendChild(Object.assign(document.createElement("div"), { className: "switch-knob" }));
        sw.addEventListener("pointerdown", function (e) {
            e.stopPropagation();
        });
        sw.addEventListener("click", function (e) {
            e.stopPropagation();
            toggleFn();
        });
        subscribe(function (on) {
            if (!sw.isConnected) return;
            sw.classList.toggle("on", on);
        });
        return sw;
    }

    /** @param {() => any} getBindFn @param {(bind: any) => void} setBindFn */
    function makeGenericBindField(getBindFn, setBindFn) {
        const field = document.createElement("div");
        field.className = "bind-field";
        setBindText(field, getBindFn());
        field.addEventListener("pointerdown", function (e) {
            e.stopPropagation();
        });
        field.addEventListener("click", function (e) {
            e.stopPropagation();
            startCapture(field, function (bind) {
                setBindFn(bind);
                setBindText(field, bind);
            });
        });
        return field;
    }

    // --- Main window ------------------------------------------------------
    // Header: title, then the master switch's bind + toggle in the header
    // controls - the same place the skin changer keeps its own module's
    // switch and bind. Below it every module as a stack of row-buttons, in
    // registration (manifest.json) order: there are few enough of them that
    // one list reads better than splitting them into tabs.
    const mainWin = createWindow({
        id: "main",
        title: "Mouse Client",
        tag: MOUSE.VERSION,
        width: 380,
        statusDot: true,
        defaultPos: { x: 80, y: 80 },
    });

    const masterBind = makeGenericBindField(MOUSE.modules.getMasterBind, MOUSE.modules.setMasterBind);
    const masterSwitch = makeGenericSwitch(
        MOUSE.modules.isMasterEnabled,
        MOUSE.modules.toggleMaster,
        MOUSE.modules.onMasterChange,
    );
    masterSwitch.title =
        "Client enabled: master switch for every module at once. Turning it off undoes what each enabled module has applied, without forgetting which ones were on. Unbound by default.";
    masterBind.title = "Master switch hotkey";
    mainWin.controls.appendChild(masterBind);
    mainWin.controls.appendChild(masterSwitch);

    // Modules stay lit while the master switch is off (they are still
    // switched on, and come back when it is) but in a muted cyan, so the
    // panel never claims something is running when it is not.
    function applyMasterState() {
        mainWin.root.classList.toggle("master-off", !MOUSE.modules.isMasterEnabled());
    }
    applyMasterState();
    MOUSE.modules.onMasterChange(applyMasterState);

    /** A module is one row-button: clicking it toggles the module, lit
     * cyan while on. Settings open from the chevron at the row's end (or a
     * right-click anywhere on the row) into a tray underneath it. */
    function renderModule(def) {
        const wrap = document.createElement("div");
        wrap.className = "module";

        const row = document.createElement("div");
        row.className = "module-row" + (MOUSE.modules.isEnabled(def.id) ? " on" : "");

        const hasSettings = !!def.settings && Object.keys(def.settings).length > 0;

        const name = document.createElement("div");
        name.className = "module-name";
        name.textContent = def.name;
        name.title = def.description || "";

        // An empty button still takes its slot (hidden via :empty), so bind
        // keycaps line up down the column whether or not a module has
        // anything to configure.
        const expandBtn = document.createElement("div");
        expandBtn.className = "expand-btn";
        if (hasSettings) {
            expandBtn.title = "Settings";
            expandBtn.appendChild(Object.assign(document.createElement("div"), { className: "expand-chevron" }));
        }

        row.appendChild(name);
        row.appendChild(makeBindField(def.id));
        row.appendChild(expandBtn);

        row.addEventListener("click", function () {
            MOUSE.modules.toggle(def.id);
        });
        // Repainting is left to the registry's change notification, as with
        // makeModuleSwitch, so a hotkey toggle lights the row the same way a
        // click does.
        MOUSE.modules.onChange(function (id, enabled) {
            if (id !== def.id || !row.isConnected) return;
            row.classList.toggle("on", enabled);
        });

        wrap.appendChild(row);
        if (!hasSettings) return wrap;

        const settingsEl = document.createElement("div");
        settingsEl.className = "settings collapsed";
        // Settings with a showIf only appear while it holds (e.g. a fixed
        // value only while "adaptive" is off). Re-evaluated after any edit
        // in this panel, which is the only place these values change.
        /** @type {Array<{el: HTMLElement, showIf: (get: (key: string) => any) => boolean}>} */
        const conditional = [];
        const getOwn = (key) => MOUSE.modules.getSetting(def.id, key, def.settings[key] ? def.settings[key].default : undefined);
        const refreshVisibility = () => {
            for (const c of conditional) c.el.style.display = c.showIf(getOwn) ? "" : "none";
        };
        for (const key in def.settings) {
            const sdef = def.settings[key];
            const el = renderSetting(def.id, key, sdef, refreshVisibility);
            if (typeof sdef.showIf === "function") conditional.push({ el: el, showIf: sdef.showIf });
            settingsEl.appendChild(el);
        }
        refreshVisibility();

        function toggleSettings() {
            const nowCollapsed = settingsEl.classList.toggle("collapsed");
            expandBtn.classList.toggle("open", !nowCollapsed);
        }
        expandBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            toggleSettings();
        });
        row.addEventListener("contextmenu", function (e) {
            e.preventDefault();
            toggleSettings();
        });

        wrap.appendChild(settingsEl);
        return wrap;
    }

    function render() {
        mainWin.body.innerHTML = "";
        for (const def of MOUSE.modules.list()) {
            // A hidden module (the skin changer) renders its own controls in
            // its own window instead of a row here - see 12-modules.js's
            // ModuleDef typedef.
            if (def.hidden) continue;
            mainWin.body.appendChild(renderModule(def));
        }
    }

    // --- Status footer, updated every tick -------------------------------
    // Two pieces sharing one footer: the status text (rewritten every tick -
    // it genuinely changes, e.g. ctx.missing) and the survev target tag
    // (effectively static - only the live-vs-tagged comparison can change,
    // and only once, when MOUSE.gameVersion resolves asynchronously - so it
    // uses the same "skip if nothing changed" sentinel 32-gui-skins.js used
    // to use for its own now-removed footer).
    const footerStatus = document.createElement("span");
    footerStatus.className = "footer-status";
    const footerTag = document.createElement("span");
    mainWin.footer.appendChild(footerStatus);
    mainWin.footer.appendChild(footerTag);

    const tagText = "for survev " + MOUSE.TARGET.survev + " (" + MOUSE.TARGET.build.slice(0, 8) + ")";
    let lastLiveForFooter; // sentinel: undefined never matches a real value/null
    function updateFooterTag() {
        const live = MOUSE.gameVersion;
        if (live === lastLiveForFooter) return;
        lastLiveForFooter = live;
        const mismatch = !!live && live.slice(0, 8) !== MOUSE.TARGET.build.slice(0, 8);
        footerTag.textContent = tagText;
        footerTag.className = mismatch ? "footer-warn" : "";
        footerTag.title = mismatch ? "live build " + live.slice(0, 8) : "";
    }
    updateFooterTag();

    MOUSE.ctx.onTick(function (dt, ctx) {
        mainWin.statusDot.classList.toggle("ready", ctx.ready);
        let text;
        if (MOUSE.disabled) {
            text = "Disabled (?nomouse)";
        } else if (!MOUSE.modules.isMasterEnabled()) {
            text = "Off";
        } else if (ctx.ready) {
            text = "Ready";
        } else if (!MOUSE.loaderStatus.attached) {
            text = "Waiting for game bundle...";
        } else {
            text = "Waiting: " + (ctx.missing.join(", ") || "resolving...");
        }
        if (footerStatus.textContent !== text) footerStatus.textContent = text;
        footerStatus.classList.toggle("ready", text === "Ready");
        updateFooterTag();
    });

    // --- Unified input gate ------------------------------------------------
    // See the file header for why this is two permanently-installed
    // listeners rather than short-lived ones. Priority order, checked fresh
    // on every event: bind capture > Right Shift > GUI text field > module
    // hotkeys.
    function isTypingInGui() {
        const active = shadow.activeElement;
        if (!active) return false;
        if (active.tagName === "SELECT" || active.tagName === "TEXTAREA") return true;
        if (active.tagName === "INPUT") {
            const t = (active.type || "text").toLowerCase();
            return t === "text" || t === "search";
        }
        return false;
    }
    function matchesBind(bind, e, kind) {
        if (!bind || bind.type !== kind) return false;
        if (kind === "key") return bind.code === e.code;
        if (kind === "mouse") return bind.button === e.button;
        return false;
    }

    // Binds owned by something that is not a module (the recorder's record
    // hotkey, 37-recorder.js). Unlike module binds these fire whatever the
    // master switch says: the master switch governs modules, and the recorder
    // is deliberately outside it. Never swallowed, same as every bind here.
    /** @type {Array<{ getBind: () => any, onPress: () => void }>} */
    const toolBinds = [];
    /** @param {() => any} getBind @param {() => void} onPress */
    function addToolBind(getBind, onPress) {
        toolBinds.push({ getBind, onPress });
    }
    function dispatchToolBinds(e, kind) {
        for (const b of toolBinds) {
            if (!matchesBind(b.getBind(), e, kind)) continue;
            try {
                b.onPress();
            } catch (err) {
                MOUSE.warn("tool bind threw", err);
            }
        }
    }

    window.addEventListener(
        "keydown",
        function (e) {
            if (capturing) {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (e.code === "Escape" || e.code === "Backspace") {
                    finishCapture(null);
                } else {
                    finishCapture({ type: "key", code: e.code });
                }
                return;
            }
            if (e.code === "ShiftRight") {
                e.preventDefault();
                e.stopImmediatePropagation();
                toggleAll();
                return;
            }
            if (isTypingInGui()) {
                if (e.code === "Escape" && shadow.activeElement) {
                    shadow.activeElement.blur();
                }
                // stopPropagation only - never preventDefault, so the
                // browser still inserts the character into the focused
                // field. This only stops the game's own bubble-phase
                // keydown listener (client/src/input.ts) from also seeing
                // it, so typing here can't walk you into the open.
                e.stopPropagation();
                return;
            }
            if (e.repeat) return;
            if (matchesBind(MOUSE.modules.getMasterBind(), e, "key")) {
                MOUSE.modules.toggleMaster();
            }
            for (const def of MOUSE.modules.list()) {
                if (matchesBind(MOUSE.modules.getBind(def.id), e, "key")) {
                    MOUSE.modules.toggle(def.id);
                }
            }
            dispatchToolBinds(e, "key");
        },
        true,
    );

    window.addEventListener(
        "mousedown",
        function (e) {
            if (capturing) {
                e.preventDefault();
                e.stopImmediatePropagation();
                finishCapture({ type: "mouse", button: e.button });
                return;
            }
            if (isTypingInGui()) return;
            if (matchesBind(MOUSE.modules.getMasterBind(), e, "mouse")) {
                MOUSE.modules.toggleMaster();
            }
            for (const def of MOUSE.modules.list()) {
                if (matchesBind(MOUSE.modules.getBind(def.id), e, "mouse")) {
                    MOUSE.modules.toggle(def.id);
                }
            }
            dispatchToolBinds(e, "mouse");
        },
        true,
    );

    MOUSE.gui = {
        createWindow,
        makeModuleSwitch,
        makeBindField,
        makeGenericBindField,
        renderSettingRow,
        addToolBind,
        setVisible,
        mount() {
            document.documentElement.appendChild(host);
            render();
            MOUSE.log("gui mounted (Right Shift to toggle)");
        },
    };
})();
