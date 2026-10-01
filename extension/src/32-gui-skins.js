// 32-gui-skins.js
//
// The Skin Changer's own window: a searchable list, one row per gun that
// has at least one past loot-icon or world-sprite version (14-skins-data.js),
// each with a strip of clickable version chips per slot, always ending in a
// synthetic "Current" chip. Picking a chip calls MOUSE.skins.setPick
// (20-skins.js), which owns the actual texture/def swap; this file only
// renders the list and reacts to picks already made (e.g. restoring the
// previous session's selections on reload).
//
// Kept in its own window (MOUSE.gui.createWindow) rather than folded into the
// main panel because it's inherently large - every gun with history gets a
// full row of preview thumbnails - and is opened far less often than the
// main panel. The Skin Changer module itself is registered hidden
// (12-modules.js) precisely so its enable switch and bind field can live
// here, in this window's own header, instead of a row in the main panel.
//
// "Current" is deliberately not shipped as stored art - 14-skins-data.js
// only carries *historical* versions - so its chip is filled from the
// running game's own texture atlas instead (MOUSE.skins.currentThumbForSlot),
// which isn't available until the game has loaded that atlas (it does so for
// the main menu, so this no longer waits on a match) and, for the three LMGs,
// until the gun defs have resolved so the magazine overlay can be placed. Any
// chip still waiting on either is tracked in pendingCurrentThumbs and retried
// every tick until it resolves, rather than each chip running its own timer.
//
// Where a gun's art sits against the hands (gunOffset, leftHandOffset, and
// this client's own rightHandOffset) can't be read out of history, so those
// were measured against the running game with extension/dev/gui-tune.js - a
// dev tool that manifest.json deliberately does not load. See docs/SKINS.md.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const MODULE_ID = "skins";

    const win = MOUSE.gui.createWindow({
        id: "skins",
        title: "Skin Changer",
        width: 640,
        collapsible: true,
        defaultPos: { x: 500, y: 80 },
    });
    win.controls.appendChild(MOUSE.gui.makeModuleSwitch(MODULE_ID));
    win.controls.appendChild(MOUSE.gui.makeBindField(MODULE_ID));

    const toolbar = document.createElement("div");
    toolbar.className = "skins-toolbar";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "skins-search";
    search.placeholder = "Search guns...";
    const resetBtn = document.createElement("div");
    resetBtn.className = "skins-reset-btn";
    resetBtn.textContent = "Reset all to current";
    toolbar.appendChild(search);
    toolbar.appendChild(resetBtn);
    win.body.appendChild(toolbar);

    const list = document.createElement("div");
    list.className = "skins-list";
    win.body.appendChild(list);

    // --- "Current" chip thumbnails: filled from the live game, retried ---
    /** @type {{ gun: any, slot: "world"|"loot", thumbEl: HTMLElement }[]} */
    const pendingCurrentThumbs = [];

    /** @param {{ gun: any, slot: "world"|"loot", thumbEl: HTMLElement }} entry */
    function tryLoadCurrentThumb(entry) {
        const dataUri = MOUSE.skins.currentThumbForSlot(entry.gun.id, entry.slot);
        if (!dataUri) return false;
        const img = document.createElement("img");
        img.src = dataUri;
        img.alt = "Current";
        entry.thumbEl.innerHTML = "";
        entry.thumbEl.appendChild(img);
        entry.thumbEl.classList.remove("pending");
        return true;
    }

    MOUSE.ctx.onTick(function () {
        if (!pendingCurrentThumbs.length) return;
        for (let i = pendingCurrentThumbs.length - 1; i >= 0; i--) {
            if (tryLoadCurrentThumb(pendingCurrentThumbs[i])) pendingCurrentThumbs.splice(i, 1);
        }
    });

    /**
     * @param {any} gun @param {"world"|"loot"} slot @param {string} label
     */
    function renderColumn(gun, slot, label) {
        const col = document.createElement("div");
        col.className = "skins-col";
        const colLabel = document.createElement("div");
        colLabel.className = "skins-col-label";
        colLabel.textContent = label;
        col.appendChild(colLabel);

        const slotData = gun[slot];
        if (!slotData || !slotData.versions || !slotData.versions.length) {
            const none = document.createElement("div");
            none.className = "skins-none";
            none.textContent = "No history";
            col.appendChild(none);
            return col;
        }

        const strip = document.createElement("div");
        strip.className = "skins-chip-strip";

        // "current" (no stored pick, or a pick from an incompatible older
        // config - see 20-skins.js's setPickValue) is the default selected
        // state, so a fresh profile opens with every strip already showing
        // its Current chip highlighted.
        function selectedLabel() {
            const picks = MOUSE.skins.getPicks();
            const forGun = picks[gun.id];
            const v = forGun && forGun[slot];
            return v === undefined || v === null ? "current" : v;
        }
        function refreshSelection() {
            const sel = selectedLabel();
            const chips = strip.children;
            for (let i = 0; i < chips.length; i++) {
                chips[i].classList.toggle("selected", chips[i].dataset.label === sel);
            }
        }

        slotData.versions.forEach(function (version) {
            const chip = document.createElement("div");
            chip.className = "skins-chip";
            chip.dataset.label = version.label;

            const thumb = document.createElement("div");
            thumb.className = "skins-chip-thumb";

            // A version can be a known-but-unfound placeholder (all svgs
            // null, see docs/SKINS.md) - grey it out and make it
            // unclickable rather than hide it, so it's visible that a
            // reskin happened here even though the art wasn't recovered.
            const firstSpriteWithSvg = slotData.sprites.find(function (n) {
                return !!version.svgs[n];
            });
            if (!firstSpriteWithSvg) {
                chip.classList.add("missing");
                chip.title = version.label + " (" + version.date + ") - art not found, see docs/SKINS.md";
            } else {
                chip.title = version.label + " (" + version.date + ")";
                // versionThumb assembles the whole thing the way the game
                // would - body plus magazine overlay for the LMGs - and bakes
                // in that version's own tint, without which any gun on one of
                // survev's shared, deliberately colourless capsule sprites
                // would preview as a white blob.
                MOUSE.skins
                    .versionThumb(gun.id, slot, version)
                    .then(function (dataUri) {
                        if (!dataUri) return;
                        const img = document.createElement("img");
                        img.src = dataUri;
                        img.alt = version.label;
                        thumb.appendChild(img);
                    })
                    .catch(function () {
                        /* leave the thumb empty - not worth surfacing a decode failure here */
                    });
                chip.addEventListener("click", function () {
                    MOUSE.skins.setPick(gun.id, slot, version.label);
                    refreshSelection();
                });
            }

            const lbl = document.createElement("div");
            lbl.className = "skins-chip-label";
            lbl.textContent = version.label;

            chip.appendChild(thumb);
            chip.appendChild(lbl);
            strip.appendChild(chip);
        });

        // Current always comes last, and is always clickable even before
        // its thumbnail has loaded (see tryLoadCurrentThumb/pendingCurrentThumbs).
        const currentChip = document.createElement("div");
        currentChip.className = "skins-chip";
        currentChip.dataset.label = "current";
        currentChip.title = "Current";

        const currentThumbEl = document.createElement("div");
        currentThumbEl.className = "skins-chip-thumb pending";
        const pendingEntry = { gun, slot, thumbEl: currentThumbEl };
        if (!tryLoadCurrentThumb(pendingEntry)) pendingCurrentThumbs.push(pendingEntry);

        const currentLbl = document.createElement("div");
        currentLbl.className = "skins-chip-label";
        currentLbl.textContent = "Current";

        currentChip.appendChild(currentThumbEl);
        currentChip.appendChild(currentLbl);
        currentChip.addEventListener("click", function () {
            MOUSE.skins.setPick(gun.id, slot, null);
            refreshSelection();
        });
        strip.appendChild(currentChip);

        refreshSelection();
        col.appendChild(strip);
        return col;
    }

    /** @param {any} gun @param {boolean} ambiguous true if another gun shares this display name (e.g. the 9mm and .45 ACP Vector) */
    function renderRow(gun, ambiguous) {
        const row = document.createElement("div");
        row.className = "skins-row";
        row.dataset.search = (gun.name + " " + gun.id).toLowerCase();

        const name = document.createElement("div");
        name.className = "skins-gun-name";
        name.textContent = ambiguous ? gun.name + " (" + gun.id + ")" : gun.name;
        row.appendChild(name);

        row.appendChild(renderColumn(gun, "loot", "Icon"));
        row.appendChild(renderColumn(gun, "world", "World sprite"));
        return row;
    }

    function render() {
        list.innerHTML = "";
        const guns = (MOUSE.skins && MOUSE.skins.guns) || [];
        // The game gives more than one gun the same display name (e.g. the
        // 9mm and .45 ACP Vector are both just "Vector") - fall back to the
        // internal id for any name that isn't unique in this list.
        const nameCounts = new Map();
        for (let i = 0; i < guns.length; i++) {
            nameCounts.set(guns[i].name, (nameCounts.get(guns[i].name) || 0) + 1);
        }
        for (let i = 0; i < guns.length; i++) {
            list.appendChild(renderRow(guns[i], nameCounts.get(guns[i].name) > 1));
        }
    }
    render();

    search.addEventListener("input", function () {
        const q = search.value.trim().toLowerCase();
        const rows = list.children;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            row.classList.toggle("hidden", !!q && row.dataset.search.indexOf(q) === -1);
        }
    });

    resetBtn.addEventListener("click", function () {
        const picks = MOUSE.skins.getPicks();
        for (const gunId in picks) {
            if (!Object.prototype.hasOwnProperty.call(picks, gunId)) continue;
            const forGun = picks[gunId];
            if (forGun.world !== undefined) MOUSE.skins.setPick(gunId, "world", null);
            if (forGun.loot !== undefined) MOUSE.skins.setPick(gunId, "loot", null);
        }
        render();
    });

    MOUSE.log("skin changer gui mounted");
})();
