// dev/gui-tune.js  -  NOT SHIPPED. manifest.json does not load this file.
//
// A measuring tool for the three values that decide where a reverted gun's
// art sits against the player's hands. Nothing about them can be recovered
// from the gun's own history: they describe the relationship between the art
// and the hands, and reverted art has different proportions to the art the
// live numbers were written for. So they get dialled in against the running
// game and the result is folded back into the asset library.
//
//   Rear hand X      worldImg.rightHandOffset - this client's own field (the
//                    game pins that hand to an animation bone; 20-skins.js's
//                    applyRearHands is what implements the offset). Negative
//                    pulls the hand back over the gun's rear end.
//                    -> assets/sprites/manifest.tsv, right_hand_x
//   Gun offset X     worldImg.gunOffset - moves the whole gun, barrel and
//                    magazine together. The hands do not follow it.
//                    -> tools/gen-skins-data.py (no manifest column; the two
//                       guns that carry one keep the live game's value)
//   Leading hand X   worldImg.leftHandOffset - moves only the upper hand,
//                    along the gun.
//                    -> assets/sprites/manifest.tsv, left_hand_x
//
// To use it, add "dev/gui-tune.js" to the js[] array in manifest.json, right
// before "src/99-boot.js", and reload the extension. It hooks
// MOUSE.skins.tuneHook (see applyTune in 20-skins.js), which layers these
// overrides onto a def as the Skin Changer patches it, so a value applies to
// whatever version is currently picked and disappears cleanly when the pick
// is cleared or the module is switched off.
//
// Values are stored in the Skin Changer's own settings, so they survive a
// reload - which is deliberate, since finding a number usually means looking
// at it again after a match. "Clear tuning" wipes them. Nothing here writes
// to the asset library: read the numbers off the readout and edit the files.
//
// Styling deliberately reuses the shipped GUI's own classes plus a few inline
// rules, so this file needs no changes to 30-gui-css.js.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const MODULE_ID = "skins";

    // --- storage ---------------------------------------------------------
    function getTunes() {
        return MOUSE.modules.getSetting(MODULE_ID, "tune", {}) || {};
    }

    /** @param {string} gunId */
    function getTune(gunId) {
        return getTunes()[gunId] || {};
    }

    /**
     * The hook 20-skins.js calls while patching a gun's worldImg, after the
     * picked version's own def has been laid down.
     * @param {any} imgDef @param {string} gunId
     */
    function applyTune(imgDef, gunId) {
        const tune = getTune(gunId);
        if (typeof tune.gunOffsetX === "number") {
            const y = (imgDef.gunOffset && imgDef.gunOffset.y) || 0;
            imgDef.gunOffset = { x: tune.gunOffsetX, y: y };
        }
        if (typeof tune.leftHandX === "number") {
            const y = (imgDef.leftHandOffset && imgDef.leftHandOffset.y) || 0;
            imgDef.leftHandOffset = { x: tune.leftHandX, y: y };
        }
        if (typeof tune.rightHandX === "number") {
            const y = (imgDef.rightHandOffset && imgDef.rightHandOffset.y) || 0;
            imgDef.rightHandOffset = { x: tune.rightHandX, y: y };
        }
    }
    MOUSE.skins.tuneHook = applyTune;

    /**
     * @param {string} gunId @param {"gunOffsetX"|"leftHandX"|"rightHandX"} key
     * @param {number | null} value null clears that one override
     */
    function setTune(gunId, key, value) {
        const tunes = Object.assign({}, getTunes());
        const forGun = Object.assign({}, tunes[gunId]);
        if (value === null || value === undefined) delete forGun[key];
        else forGun[key] = value;
        if (Object.keys(forGun).length) tunes[gunId] = forGun;
        else delete tunes[gunId];
        MOUSE.modules.setSetting(MODULE_ID, "tune", tunes);
        // The pick isn't changing, only the def underneath it, which is the
        // one case applySlot's own "did the version change" guard skips.
        MOUSE.skins.reapplyWorld(gunId);
    }

    function clearTunes() {
        const gunIds = Object.keys(getTunes());
        MOUSE.modules.setSetting(MODULE_ID, "tune", {});
        for (const gunId of gunIds) MOUSE.skins.reapplyWorld(gunId);
    }

    /**
     * What the live def says right now - after the pick and any tuning have
     * been applied. This is the number to copy into the asset library, not
     * the stored override, since a gun with no override still has a value.
     * @param {string} gunId
     * @returns {{ gunOffsetX: number, leftHandX: number, rightHandX: number } | null}
     */
    function liveGeometry(gunId) {
        const def = MOUSE.gameDefs && MOUSE.gameDefs.typeToDefSafe(gunId);
        const world = def && def.worldImg;
        if (!world) return null;
        return {
            gunOffsetX: (world.gunOffset && world.gunOffset.x) || 0,
            leftHandX: (world.leftHandOffset && world.leftHandOffset.x) || 0,
            rightHandX: (world.rightHandOffset && world.rightHandOffset.x) || 0,
        };
    }

    // --- window ----------------------------------------------------------
    const win = MOUSE.gui.createWindow({
        id: "skins-tune",
        title: "Position tuning (dev)",
        width: 360,
        collapsible: true,
        defaultPos: { x: 500, y: 620 },
    });

    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.alignItems = "center";
    head.style.gap = "8px";
    head.style.marginBottom = "6px";

    const gunSelect = document.createElement("select");
    gunSelect.style.flex = "1";
    for (const gun of (MOUSE.skins && MOUSE.skins.guns) || []) {
        if (!gun.world) continue;
        const opt = document.createElement("option");
        opt.value = gun.id;
        opt.textContent = gun.name + " (" + gun.id + ")";
        gunSelect.appendChild(opt);
    }
    gunSelect.addEventListener("change", syncFields);

    const clearBtn = document.createElement("div");
    clearBtn.className = "skins-reset-btn";
    clearBtn.textContent = "Clear tuning";
    clearBtn.addEventListener("click", function () {
        clearTunes();
        syncFields();
    });

    head.appendChild(gunSelect);
    head.appendChild(clearBtn);
    win.body.appendChild(head);

    /**
     * One slider plus an editable number, both writing the same value. The
     * number box is the one that matters - it is what gets read off.
     * @param {string} label @param {"gunOffsetX"|"leftHandX"|"rightHandX"} key
     * @param {number} min @param {number} max @param {string} hint
     */
    function makeRow(label, key, min, max, hint) {
        const row = document.createElement("div");
        row.className = "setting-row";

        const lbl = document.createElement("div");
        lbl.className = "setting-label";
        lbl.textContent = label;
        lbl.title = hint;

        const wrap = document.createElement("div");
        wrap.style.display = "flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "6px";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(min);
        slider.max = String(max);
        slider.step = "0.25";

        const number = document.createElement("input");
        number.type = "number";
        number.step = "0.25";
        number.style.width = "62px";
        number.style.background = "rgba(0, 0, 0, 0.45)";
        number.style.border = "1px solid rgba(255, 255, 255, 0.16)";
        number.style.borderRadius = "4px";
        number.style.color = "#ffffff";
        number.style.fontSize = "11px";
        number.style.padding = "2px 4px";
        number.style.fontFamily = 'ui-monospace, "Cascadia Code", "Consolas", monospace';

        function push(value) {
            if (!isFinite(value)) return;
            slider.value = String(value);
            number.value = String(value);
            setTune(gunSelect.value, key, value);
        }
        slider.addEventListener("input", function () {
            push(parseFloat(slider.value));
        });
        number.addEventListener("change", function () {
            push(parseFloat(number.value));
        });

        wrap.appendChild(slider);
        wrap.appendChild(number);
        row.appendChild(lbl);
        row.appendChild(wrap);
        win.body.appendChild(row);
        return { slider: slider, number: number, key: key };
    }

    const rows = [
        makeRow("Rear hand X", "rightHandX", -24, 24,
            "Moves the rear (gun-holding) hand along the gun. Negative pulls it back toward the player, over the gun's rear end."),
        makeRow("Gun offset X", "gunOffsetX", -24, 24,
            "Moves the whole gun - barrel and magazine - along the aim axis. The hands do not follow it."),
        makeRow("Leading hand X", "leftHandX", -12, 32,
            "Moves only the leading (upper) hand along the gun."),
    ];

    const note = document.createElement("div");
    note.style.fontSize = "10px";
    note.style.opacity = "0.6";
    note.style.marginTop = "4px";
    note.style.fontFamily = 'ui-monospace, "Cascadia Code", "Consolas", monospace';
    win.body.appendChild(note);

    function syncFields() {
        const live = liveGeometry(gunSelect.value);
        for (const row of rows) {
            const value = live ? live[row.key] : 0;
            row.slider.value = String(value);
            row.number.value = String(value);
            row.slider.disabled = !live;
            row.number.disabled = !live;
        }
        note.textContent = live
            ? "rightHandOffset x " + live.rightHandX
                + "   gunOffset x " + live.gunOffsetX
                + "   leftHandOffset x " + live.leftHandX
            : "waiting for the game's gun defs...";
    }

    // The values only become readable once 15-defs.js has resolved the gun
    // defs, and they change under us whenever a chip is picked, so keep the
    // fields in step rather than reading them once.
    MOUSE.ctx.onTick(syncFields);
    syncFields();

    // Anything already stored has to be pushed into the live defs, since the
    // Skin Changer applied its picks before this file installed the hook.
    for (const gunId in getTunes()) MOUSE.skins.reapplyWorld(gunId);

    MOUSE.log("dev tuning panel mounted");
})();
