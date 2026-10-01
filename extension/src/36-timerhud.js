// 36-timerhud.js
//
// Match timers: a countdown for the 50v50 (Faction) mode's role promotions
// and Cobalt's twins bunker unlock, neither of which the game shows a clock
// for. Renders as one line in 34-hudstack.js's shared stack, below the
// FPS/ping rows from 35-nethud.js.
//
// Both events are scheduled by the server against `circleIdx` - which is
// server-side state, never sent to the client. This used to reconstruct it
// by counting gas mode transitions and running its own stopwatch off each
// one, which meant the count was only ever as good as having watched the
// whole match from its start, and left this module holding match-scoped
// state that had to be invalidated at exactly the right moment or it would
// bleed a stale countdown into the next match.
//
// None of that is necessary, because the client is told the current gas
// stage's own clock directly. client/src/gas.ts's Gas carries `mode`
// (GasMode: 0 Inactive, 1 Waiting, 2 Moving), `duration` (that stage's full
// length in seconds) and `circleT` (how far through it we are, 0..1) - all
// three set from the server's gas message in setFullState, and the server
// marks its gas time dirty every single tick, so they are as fresh and as
// accurate as the game's own gas countdown, which is computed from these
// very fields (client/src/ui/ui.ts: `duration * (1 - circleT)`).
//
// That leaves only "which stage is this?", and the stage identifies itself:
// server/src/game/objects/gas.ts's GasStages table is fixed and
// map-independent (no map def overrides gas timings), and the three stages
// these timers care about have durations - 80s Waiting, 30s Moving, 65s
// Waiting - that are each unique within their own mode across the whole
// table. So a mode+duration pair names the stage outright, with no
// counting, no stopwatch, and no state carried between frames or between
// matches. Joining a match already in progress reads correctly too, which
// the old stopwatch could never do.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const MODULE_ID = "timers";

    // GasMode from shared/gameConfig.ts.
    const GAS_MODE_WAITING = 1;
    const GAS_MODE_MOVING = 2;

    // The opening entries of server/src/game/objects/gas.ts's GasStages
    // table, which is a fixed constant there - no map def overrides gas
    // timings, so these hold in every mode:
    //
    //   stage 0  Inactive   0s
    //   stage 1  Waiting   80s   <- circleIdx becomes 0 here
    //   stage 2  Moving    30s
    //   stage 3  Waiting   65s   <- circleIdx becomes 1 here
    //
    // Each of these three durations is unique among stages sharing its mode
    // (Waiting runs 80/65/50/40/30/25/20/15, Moving 30/25/20/15/10/5/6/15),
    // which is what lets a live mode+duration pair name the stage outright.
    const STAGE1_WAITING_DURATION = 80;
    const STAGE2_MOVING_DURATION = 30;
    const STAGE3_WAITING_DURATION = 65;

    // shared/defs/maps/factionDefs.ts's gameConfig.roles.timings, all
    // circleIdx: 0 - i.e. all counted from the start of stage 1. Role ->
    // display name mirrors client/src/ui/ui2.ts's getRoleTranslation (the
    // "leader" role is red/blue-leader there, but both promote at the same
    // `wait`, so there is nothing to disambiguate here).
    const FACTION_ROLE_TIMINGS = [
        { role: "leader", wait: 50, label: "Leader" },
        { role: "lieutenant", wait: 54, label: "Lieutenant" },
        { role: "marksman", wait: 58, label: "Marksman" },
        { role: "recon", wait: 62, label: "Recon" },
        { role: "grenadier", wait: 66, label: "Grenadier" },
        { role: "medic", wait: 70, label: "Medic" },
        { role: "bugler", wait: 74, label: "Bugler" },
    ];
    // cobaltDefs.ts's gameConfig.unlocks.timings entry for
    // "bunker_twins_sublevel_01" - circleIdx: 1, wait: 30, i.e. 30s after
    // stage 3 begins.
    const COBALT_BUNKER_WAIT = 30;

    /**
     * Seconds left in whatever gas stage is running right now, straight off
     * the live Gas - the same expression client/src/ui/ui.ts uses for the
     * game's own on-screen gas countdown. Null when the gas has not reported
     * a usable state yet (before a match really starts, or if any of the
     * three fields ever stops resolving).
     * @param {any} gas @returns {number | null}
     */
    function stageTimeLeft(gas) {
        if (!gas) return null;
        if (typeof gas.duration !== "number" || typeof gas.circleT !== "number") return null;
        if (!(gas.duration > 0)) return null;
        return Math.max(gas.duration * (1 - gas.circleT), 0);
    }

    /** @returns {string | null} */
    function matchTimerText(ctx) {
        const gas = ctx.gas;
        if (!ctx.mode || !gas || typeof gas.mode !== "number") return null;
        const left = stageTimeLeft(gas);
        if (left === null) return null;
        const waiting = gas.mode === GAS_MODE_WAITING;
        const moving = gas.mode === GAS_MODE_MOVING;

        if (ctx.mode.faction) {
            // Every role promotion is scheduled from the start of stage 1,
            // so there is nothing to show outside it.
            if (!waiting || gas.duration !== STAGE1_WAITING_DURATION) return null;
            const elapsed = STAGE1_WAITING_DURATION - left;
            for (let i = 0; i < FACTION_ROLE_TIMINGS.length; i++) {
                const t = FACTION_ROLE_TIMINGS[i];
                if (t.wait > elapsed) {
                    return t.label + " promotion in " + Math.ceil(t.wait - elapsed) + "s";
                }
            }
            return null;
        }

        if (ctx.mode.name === "cobalt") {
            // Counted all the way back from stage 1 rather than only once
            // the bunker's own 30s wait has started, so the countdown is
            // useful from early in the match instead of appearing with half
            // a minute left on it.
            let secs = null;
            if (waiting && gas.duration === STAGE1_WAITING_DURATION) {
                secs = left + STAGE2_MOVING_DURATION + COBALT_BUNKER_WAIT;
            } else if (moving && gas.duration === STAGE2_MOVING_DURATION) {
                secs = left + COBALT_BUNKER_WAIT;
            } else if (waiting && gas.duration === STAGE3_WAITING_DURATION) {
                const into = STAGE3_WAITING_DURATION - left;
                if (into < COBALT_BUNKER_WAIT) secs = COBALT_BUNKER_WAIT - into;
            }
            if (secs !== null && secs > 0) {
                return "Twins bunker opens in " + Math.ceil(secs) + "s";
            }
        }
        return null;
    }

    function onTick(dt, ctx) {
        void dt;
        if (!ctx.ready || !ctx.inGameScreen() || ctx.showingStats()) {
            MOUSE.hudStack.release("timer");
            return;
        }
        const text = matchTimerText(ctx);
        if (!text) {
            MOUSE.hudStack.release("timer");
            return;
        }
        MOUSE.hudStack.row("timer", 30).textContent = text;
    }

    MOUSE.modules.register({
        id: MODULE_ID,
        name: "Match timers",
        description:
            "Countdowns the game never shows: 50v50 role promotions and Cobalt's twins bunker unlock. Read off the live gas stage, so they hold up even if you join mid-match. Renders above the health HUD, under the FPS/ping rows.",
        onDisable() {
            MOUSE.hudStack.release("timer");
        },
        onTick,
    });
})();
