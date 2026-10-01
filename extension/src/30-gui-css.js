// 30-gui-css.js
//
// Stylesheet for the click GUI, kept as a plain string so it can be dropped
// into the shadow root's <style> tag without any build step. Shadow DOM
// already isolates these rules from the game's own CSS (and vice versa), so
// this does not need to fight for specificity against anything the page
// defines.
//
// The look is survev's own menu kit rather than a generic settings pane, so
// the client reads as part of the game it sits on:
//   - Panels are the game's modal smoke - plain black, at 85% rather than
//     its 75% so settings stay legible over busy map art - with its 5px
//     corners, not a tinted opaque card.
//   - Buttons are the game's chunky buttons: a flat face plus a darker 3px
//     bottom lip (an inset shadow), which shrinks when pressed. Module rows
//     are these buttons, lit in the cyan of the menu's Create Team / Join
//     Team buttons (app.css .btn-team-option: #50afab / lip #387c79) while
//     the module is on - the one loud element in the GUI.
//     Action buttons use the game's crate brown (#8f5827 / #563619), and the
//     off state of a toggle its grey (#7a7a7a / #3e3e3e).
//   - "This one is selected" is the game's own selected-tab marker: a 2px
//     #00ff00 outline (see its game.css .btn-game-menu-selected). Used for
//     the picked skin chip, a bind waiting for a key and keyboard focus -
//     nothing else.
// Font: Roboto Condensed, which survev.io's own page already loads from
// Google Fonts for its UI. Fonts loaded by the document are usable inside a
// shadow root, so this costs no extra fetch; the fallbacks cover ?nomouse-style
// pages or a future survev build that drops it. Numbers use tabular figures
// rather than a monospace face so readouts don't jitter as they change.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    MOUSE.guiCss = `
        :host {
            all: initial;
            --smoke: rgba(0, 0, 0, 0.85);
            --ink: #ffffff;
            --ink-muted: rgba(255, 255, 255, 0.62);
            --ink-faint: rgba(255, 255, 255, 0.38);
            --well: rgba(0, 0, 0, 0.38);
            --rule: rgba(255, 255, 255, 0.16);
            --face: rgba(255, 255, 255, 0.07);
            --face-hover: rgba(255, 255, 255, 0.12);
            --lip-dark: rgba(0, 0, 0, 0.42);
            --lit: #50afab;
            --lit-lip: #387c79;
            --lit-hover: #5cbbb7;
            --lit-idle: #4e7472;
            --lit-idle-lip: #395553;
            --crate: #8f5827;
            --crate-lip: #563619;
            --grey: #7a7a7a;
            --grey-lip: #3e3e3e;
            --select: #00ff00;
            --warn: #ffb03a;
            --danger: #ff5a4a;
        }
        * {
            box-sizing: border-box;
            font-family: "Roboto Condensed", "Arial Narrow", Arial, sans-serif;
        }
        .panel {
            position: fixed;
            top: 80px;
            left: 80px;
            width: 380px;
            max-height: 78vh;
            background: var(--smoke);
            border-radius: 5px;
            color: var(--ink);
            font-size: 14px;
            line-height: 1.25;
            display: flex;
            flex-direction: column;
            z-index: 2147483647;
            user-select: none;
        }
        .panel.hidden {
            display: none;
        }

        /* --- Header: drag handle, title, window controls ----------------- */
        .header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 9px 10px 9px 12px;
            background: rgba(0, 0, 0, 0.4);
            border-radius: 5px 5px 0 0;
            cursor: grab;
        }
        .panel.collapsed .header {
            border-radius: 5px;
        }
        .header:active {
            cursor: grabbing;
        }
        .title {
            font-weight: 700;
            font-size: 18px;
            display: flex;
            align-items: baseline;
            gap: 6px;
            white-space: nowrap;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
        }
        .title-tag {
            font-size: 12px;
            font-weight: 400;
            color: var(--ink-faint);
            text-shadow: none;
        }
        .header-controls {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-left: auto;
        }
        .collapse-arrow {
            cursor: pointer;
            color: var(--ink-muted);
            font-size: 11px;
            width: 22px;
            height: 22px;
            line-height: 22px;
            text-align: center;
            border-radius: 4px;
        }
        .collapse-arrow:hover {
            color: var(--ink);
            background: var(--face-hover);
        }
        .panel.collapsed .body,
        .panel.collapsed .footer {
            display: none;
        }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--danger);
            align-self: center;
            flex-shrink: 0;
        }
        .status-dot.ready {
            background: var(--lit);
        }

        /* --- Scrolling body ----------------------------------------------- */
        .body {
            overflow-y: auto;
            padding: 8px;
            scrollbar-width: thin;
            scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
        }
        .body::-webkit-scrollbar,
        .skins-list::-webkit-scrollbar {
            width: 6px;
        }
        .body::-webkit-scrollbar-track,
        .skins-list::-webkit-scrollbar-track {
            background: transparent;
        }
        .body::-webkit-scrollbar-thumb,
        .skins-list::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.25);
            border-radius: 3px;
        }

        /* --- Module rows: the whole row is the on/off button -------------- */
        .module + .module {
            margin-top: 4px;
        }
        .module-row {
            display: flex;
            align-items: center;
            gap: 8px;
            height: 38px;
            padding: 0 6px 3px 12px;
            border-radius: 5px;
            background: var(--face);
            box-shadow: inset 0 -3px var(--lip-dark);
            cursor: pointer;
            transition: background-color 80ms linear;
        }
        .module-row:hover {
            background: var(--face-hover);
        }
        .module-row:active {
            padding-bottom: 1px;
            box-shadow: inset 0 -1px var(--lip-dark);
        }
        .module-row.on {
            background: var(--lit);
            box-shadow: inset 0 -3px var(--lit-lip);
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        }
        .module-row.on:hover {
            background: var(--lit-hover);
        }
        .module-row.on:active {
            box-shadow: inset 0 -1px var(--lit-lip);
        }
        /* Switched on, but the master switch has everything paused: still
           visibly "on", just not live. */
        .panel.master-off .module-row.on {
            background: var(--lit-idle);
            box-shadow: inset 0 -3px var(--lit-idle-lip);
            color: rgba(255, 255, 255, 0.8);
        }
        .module-name {
            flex: 1;
            font-size: 15px;
            font-weight: 700;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .expand-btn {
            width: 26px;
            height: 26px;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            color: var(--ink-muted);
        }
        .expand-btn:empty {
            visibility: hidden;
        }
        .expand-btn:hover {
            background: rgba(0, 0, 0, 0.28);
            color: var(--ink);
        }
        .module-row.on .expand-btn {
            color: rgba(255, 255, 255, 0.85);
        }
        .expand-chevron {
            width: 7px;
            height: 7px;
            border-right: 2px solid currentColor;
            border-bottom: 2px solid currentColor;
            transform: translateY(-2px) rotate(45deg);
            transition: transform 120ms ease-out;
        }
        .expand-btn.open .expand-chevron {
            transform: translateY(1px) rotate(-135deg);
        }

        /* --- Keycap: every bind field -------------------------------------- */
        .bind-field {
            min-width: 36px;
            height: 24px;
            padding: 0 7px 2px;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.35);
            box-shadow: inset 0 -2px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 255, 255, 0.16);
            color: var(--ink);
            font-size: 12px;
            font-weight: 700;
            line-height: 22px;
            text-align: center;
            white-space: nowrap;
            text-shadow: none;
            cursor: pointer;
            flex-shrink: 0;
        }
        .bind-field:hover {
            background: rgba(0, 0, 0, 0.5);
        }
        /* An unbound keycap is a blank key; hovering it says what clicking
           it does. The text itself is cleared by the GUI (setBindText). */
        .bind-field.unbound {
            color: var(--ink-faint);
            font-weight: 400;
            background: transparent;
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
        }
        .bind-field.unbound:empty::before {
            content: "\\2013";
        }
        .bind-field.unbound:empty:hover::before {
            content: "Bind";
        }
        .module-row.on .bind-field.unbound {
            color: rgba(255, 255, 255, 0.7);
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
        }
        .bind-field.capturing,
        .bind-field.capturing.unbound {
            color: var(--ink);
            font-weight: 700;
            background: rgba(0, 0, 0, 0.6);
            box-shadow: inset 0 0 0 2px var(--select);
        }

        /* --- On/Off toggle: header master switch, bool settings ----------- */
        .switch {
            position: relative;
            width: 44px;
            height: 24px;
            padding-bottom: 2px;
            border-radius: 4px;
            background: var(--grey);
            box-shadow: inset 0 -2px var(--grey-lip);
            color: rgba(255, 255, 255, 0.78);
            font-size: 13px;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
            flex-shrink: 0;
            cursor: pointer;
        }
        .switch::after {
            content: "Off";
        }
        .switch.on {
            background: var(--lit);
            box-shadow: inset 0 -2px var(--lit-lip);
            color: var(--ink);
        }
        .switch.on::after {
            content: "On";
        }
        .switch:active {
            padding-bottom: 0;
            box-shadow: inset 0 -1px var(--grey-lip);
        }
        .switch.on:active {
            box-shadow: inset 0 -1px var(--lit-lip);
        }
        .switch-knob {
            display: none;
        }

        /* --- Settings tray, pulled out from under its row ----------------- */
        .settings {
            margin: -3px 0 0 12px;
            padding: 11px 10px 10px 12px;
            border-radius: 0 0 5px 5px;
            background: rgba(0, 0, 0, 0.3);
            border-left: 2px solid var(--rule);
            display: flex;
            flex-direction: column;
            gap: 9px;
        }
        .module-row.on + .settings {
            border-left-color: var(--lit-lip);
        }
        .settings.collapsed {
            display: none;
        }
        .setting-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            min-height: 24px;
        }
        .setting-label {
            color: rgba(255, 255, 255, 0.86);
            font-size: 14px;
        }
        .setting-label.has-hint {
            cursor: help;
            text-decoration: underline dotted var(--ink-faint);
            text-underline-offset: 3px;
        }
        .number-value {
            font-size: 13px;
            color: var(--ink-muted);
            min-width: 50px;
            white-space: nowrap;
            text-align: right;
            font-variant-numeric: tabular-nums;
        }

        /* Slider: a groove filled up to the value (--p, set by the GUI as the
           value changes), with the game's chunky handle. */
        input[type="range"] {
            -webkit-appearance: none;
            appearance: none;
            width: 118px;
            height: 18px;
            margin: 0;
            background: transparent;
            cursor: pointer;
        }
        input[type="range"]::-webkit-slider-runnable-track {
            height: 6px;
            border-radius: 3px;
            background: linear-gradient(90deg, rgba(255, 255, 255, 0.78) var(--p, 0%), rgba(255, 255, 255, 0.16) var(--p, 0%));
        }
        input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 11px;
            height: 18px;
            margin-top: -6px;
            border-radius: 3px;
            background: #ffffff;
            box-shadow: inset 0 -3px #a0a0a0, 0 1px 3px rgba(0, 0, 0, 0.5);
        }
        input[type="range"]::-moz-range-track {
            height: 6px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.16);
        }
        input[type="range"]::-moz-range-progress {
            height: 6px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.78);
        }
        input[type="range"]::-moz-range-thumb {
            width: 11px;
            height: 18px;
            border: none;
            border-radius: 3px;
            background: #ffffff;
            box-shadow: inset 0 -3px #a0a0a0, 0 1px 3px rgba(0, 0, 0, 0.5);
        }

        input[type="color"] {
            -webkit-appearance: none;
            appearance: none;
            width: 34px;
            height: 22px;
            padding: 0;
            border: none;
            border-radius: 4px;
            background: none;
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.3);
            cursor: pointer;
        }
        input[type="color"]::-webkit-color-swatch-wrapper {
            padding: 2px;
        }
        input[type="color"]::-webkit-color-swatch {
            border: none;
            border-radius: 3px;
        }
        input[type="color"]::-moz-color-swatch {
            border: none;
            border-radius: 3px;
        }

        select {
            -webkit-appearance: none;
            appearance: none;
            height: 26px;
            padding: 0 24px 2px 8px;
            border: none;
            border-radius: 4px;
            background:
                url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0h8L4 5z' fill='%23ffffff' fill-opacity='.7'/%3E%3C/svg%3E")
                    no-repeat right 8px center,
                rgba(0, 0, 0, 0.38);
            box-shadow: inset 0 -2px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 255, 255, 0.16);
            color: var(--ink);
            font-size: 14px;
            cursor: pointer;
        }
        select:hover {
            background-color: rgba(0, 0, 0, 0.55);
        }
        option {
            background: #2a2a2a;
            color: #ffffff;
        }

        .action-btn,
        .skins-reset-btn {
            height: 28px;
            padding: 0 12px 3px;
            border-radius: 5px;
            background: var(--crate);
            box-shadow: inset 0 -3px var(--crate-lip);
            color: #ffffff;
            font-size: 14px;
            font-weight: 700;
            line-height: 25px;
            text-align: center;
            white-space: nowrap;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
            cursor: pointer;
        }
        .action-btn:hover,
        .skins-reset-btn:hover {
            background: #9c6230;
        }
        .action-btn:active,
        .skins-reset-btn:active {
            padding-bottom: 1px;
            box-shadow: inset 0 -1px var(--crate-lip);
        }

        .skins-search {
            height: 28px;
            padding: 0 10px;
            border: none;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.45);
            box-shadow: inset 0 2px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.14);
            color: var(--ink);
            font-size: 14px;
            outline: none;
        }
        .skins-search::placeholder {
            color: var(--ink-faint);
        }

        /* --- Footer ------------------------------------------------------ */
        .footer {
            display: flex;
            gap: 10px;
            justify-content: space-between;
            padding: 7px 12px 8px;
            font-size: 12px;
            color: var(--ink-faint);
            border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        .footer:empty {
            display: none;
        }
        .footer-status.ready {
            color: var(--ink-muted);
        }
        .footer-warn {
            color: var(--warn);
        }

        /* --- Skin Changer window ----------------------------------------- */
        .skins-toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 0 10px;
        }
        .skins-search {
            flex: 1;
        }
        .skins-list {
            overflow-y: auto;
            max-height: 56vh;
            margin-right: -4px;
            padding-right: 4px;
            scrollbar-width: thin;
            scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
        }
        .skins-row {
            display: flex;
            gap: 12px;
            padding: 10px 10px 12px;
            border-radius: 5px;
        }
        .skins-row:nth-child(odd) {
            background: rgba(255, 255, 255, 0.04);
        }
        .skins-row.hidden {
            display: none;
        }
        .skins-gun-name {
            flex: 0 0 96px;
            font-weight: 700;
            font-size: 15px;
            padding-top: 2px;
        }
        .skins-col {
            flex: 1;
            min-width: 0;
        }
        .skins-col-label {
            font-size: 12px;
            color: var(--ink-faint);
            margin-bottom: 5px;
        }
        .skins-chip-strip {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        .skins-none {
            font-size: 13px;
            color: var(--ink-faint);
            padding-top: 4px;
        }
        .skins-chip {
            width: 52px;
            cursor: pointer;
            text-align: center;
        }
        .skins-chip-thumb {
            width: 52px;
            height: 52px;
            border-radius: 5px;
            border: 2px solid transparent;
            background: rgba(0, 0, 0, 0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }
        .skins-chip-thumb img {
            max-width: 80%;
            max-height: 80%;
        }
        .skins-chip:hover .skins-chip-thumb {
            background: rgba(255, 255, 255, 0.1);
        }
        .skins-chip.selected .skins-chip-thumb {
            border-color: var(--select);
            background: rgba(0, 0, 0, 0.55);
        }
        .skins-chip.missing {
            cursor: default;
            opacity: 0.4;
        }
        .skins-chip.missing .skins-chip-thumb,
        .skins-chip-thumb.pending {
            border: 2px dashed rgba(255, 255, 255, 0.2);
        }
        .skins-chip.selected .skins-chip-thumb.pending {
            border-color: var(--select);
        }
        .skins-chip-label {
            font-size: 12px;
            margin-top: 3px;
            color: var(--ink-muted);
            font-variant-numeric: tabular-nums;
        }
        .skins-chip.selected .skins-chip-label {
            color: var(--ink);
            font-weight: 700;
        }

        /* --- Recorder window --------------------------------------------- */
        /* The record button is a .module-row; these only add its dot and
           the clock that replaces the keycap slot. */
        .rec-btn {
            margin-top: 4px;
        }
        .rec-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            flex-shrink: 0;
            background: var(--ink-faint);
        }
        .rec-dot.live {
            background: var(--danger);
            box-shadow: 0 0 0 2px var(--lit-lip);
        }
        .rec-clock {
            padding-right: 6px;
            font-size: 14px;
            font-weight: 700;
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
        }
        .rec-settings {
            display: flex;
            flex-direction: column;
            gap: 9px;
            padding: 12px 4px 4px;
        }

        /* --- Keyboard focus, reduced motion ------------------------------ */
        input:focus-visible,
        select:focus-visible {
            outline: 2px solid var(--select);
            outline-offset: 1px;
        }
        input[type="range"]:focus-visible {
            outline-offset: 3px;
        }
        @media (prefers-reduced-motion: reduce) {
            * {
                transition: none !important;
            }
        }
    `;
    MOUSE.log("gui css loaded");
})();
