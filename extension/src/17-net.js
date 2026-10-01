// 17-net.js
//
// Ping/stall telemetry, exposed as MOUSE.net.stats for the FPS/ping HUD and
// Lag Smoothing's buffer readout. Not a toggleable
// module - like 15-defs.js, this is infrastructure other files read,
// registered as a raw ctx.onTick rather than through MOUSE.modules so it keeps
// running (and the HUD keeps showing a number) whether or not any consumer
// module happens to be enabled.
//
// No new patch anchor and no WebSocket hook: client/src/game.ts declares
// `seq`, `seqInFlight`, `seqSendTime`, `pings: number[]`, `lastUpdateTime`
// and `updateIntervals: number[]` without an `m_` prefix, so - like
// ctx.map's mapName/mapDef or ctx.ui2's uiEvents/newState/dom - they survive
// the build's property mangler and are readable straight off ctx.game. Ping
// itself is computed by the game's own m_processGameUpdate: when an
// UpdateMsg's ack matches the seq we last sent, `Date.now() - seqSendTime`
// is pushed onto `pings`; `updateIntervals` gets the wall-clock gap between
// consecutive UpdateMsgs, i.e. exactly what camera.m_interpInterval is set
// from.
//
// Both arrays are a *bucket*, not a log: game.ts sorts each in place and
// empties both every 20 seconds for its own console ping dump. So this
// never holds an index into them - only a length, treating a shrinking
// length as "the bucket was emptied, start counting from zero again" - and
// keeps its own small ring buffers for the HUD's sparkline and jitter/stall
// math.
//
// Ping samples are only kept while the match screen is actually up, and
// only from a short delay after it appears - see SAMPLE_START_DELAY_MS.
// Update intervals are not gated the same way: they feed the stall flag and
// the average interval, which are about the connection rather than about
// the match, and both are read only by code that is already in one.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    /** How long a ping sample stays in the sparkline history. */
    const PING_WINDOW_MS = 120000;
    /** How many raw update-interval samples feed the average interval -
     * about 2-4 seconds of updates at the game's 33Hz net-sync rate. */
    const INTERVAL_WINDOW = 80;
    /** How long without any update before this counts as "stalled" for the
     * stallsPerMin counter and the `stalled` flag, which is also what turns
     * 35-nethud.js's ping row red. */
    const STALL_THRESHOLD_MS = 150;
    /** Rolling window for the "how many separate stalls in the last
     * minute" counter. */
    const STALLS_PER_MIN_WINDOW_MS = 60000;
    /** How old the newest ping sample may be and still be reported as the
     * current ping. The game re-seqs an input at least once a second
     * (client/src/game.ts's `m_inputMsgTimeout = 1` after every send), and
     * every acked seq produces a sample, so a gap much beyond that means
     * the samples on hand describe a connection that no longer exists -
     * during a stall, sitting on the death screen, or the first seconds of
     * a match, where the previous match's numbers would otherwise be shown
     * as if they were live. Reported as pingMs = null ("--") rather than as
     * a stale number. */
    const PING_STALE_MS = 3000;
    /** How long the match screen has to have been up before ping samples
     * start being kept. Ping history is a picture of the match you are in,
     * and both halves of that matter:
     *
     *  - Off the match screen - sitting on the menu, or the seconds after a
     *    match ends - the game carries on acking seqs for a while, and those
     *    samples used to sit inside the sparkline's 60-second window as
     *    though they described play.
     *  - The first seq acked after a join was sent while the client was
     *    still finishing that join (asset loading, the first minimap bake),
     *    so it reads far above the connection's real round trip. The graph
     *    scales to the tallest sample in its window (35-nethud.js), so one
     *    such spike squashes every honest reading after it flat against the
     *    bottom of the canvas for the next minute.
     *
     * Skipped samples are dropped, not deferred - see onTick. */
    const SAMPLE_START_DELAY_MS = 100;

    /** The Game instance the samples below belong to. client/src/game.ts
     * builds a fresh Game per match and resets pings/updateIntervals/
     * lastUpdateTime in its constructor, so this file's own history has to
     * be dropped at the same moment - otherwise the first frames of a new
     * match report the last match's ping and draw the last match's
     * sparkline. */
    let lastGame = null;
    let lastPingsLen = 0;
    let lastIntervalsLen = 0;
    /** @type {Array<{t: number, ms: number}>} Date.now()-timestamped, for the sparkline. */
    let pingSamples = [];
    /** @type {number[]} raw interval samples in ms, most recent last. */
    let intervalSamples = [];
    /** @type {number[]} performance.now() timestamps of stall *onsets*. */
    let stallOnsets = [];
    let wasStalled = false;
    /** performance.now() when the match screen last appeared, or 0 while it
     * is not up. Not reset by reset() below: it tracks the *screen*, which
     * comes up before the new match's Game is built and outlives the old
     * one, so tying it to Game identity would restart the delay at the wrong
     * moment in both directions. */
    let inGameSince = 0;

    const stats = {
        available: false,
        pingMs: /** @type {number | null} */ (null),
        pingAvgMs: /** @type {number | null} */ (null),
        jitterMs: /** @type {number | null} */ (null),
        pingSamples: /** @type {Array<{t: number, ms: number}>} */ ([]),
        intervalAvgMs: /** @type {number | null} */ (null),
        msSinceUpdate: /** @type {number | null} */ (null),
        stalled: false,
        stallMs: 0,
        stallsPerMin: 0,
        /** Lag Smoothing's current jitter allowance on top of one update
         * interval, in ms - 0 while that module is off or disabled. Written
         * by that module directly onto this object; read by the netgraph
         * HUD so the ping row can show "+40ms buf" while it's buffering. */
        interpBufferMs: 0,
    };
    MOUSE.net = { stats: stats };

    function reset() {
        lastPingsLen = 0;
        lastIntervalsLen = 0;
        pingSamples.length = 0;
        intervalSamples.length = 0;
        stallOnsets.length = 0;
        wasStalled = false;
    }

    function onTick(dt, ctx) {
        void dt;
        const game = ctx.game;
        const wallNow = Date.now();
        const perfNow = performance.now();

        if (game !== lastGame) {
            lastGame = game;
            reset();
        }

        const inGame = ctx.inGameScreen();
        if (!inGame) inGameSince = 0;
        else if (!inGameSince) inGameSince = perfNow;
        const collecting = inGame && perfNow - inGameSince >= SAMPLE_START_DELAY_MS;

        if (
            !game
            || typeof game.lastUpdateTime !== "number"
            || !Array.isArray(game.pings)
            || !Array.isArray(game.updateIntervals)
        ) {
            stats.available = false;
            return;
        }
        stats.available = true;

        if (game.pings.length < lastPingsLen) lastPingsLen = 0;
        if (game.pings.length > lastPingsLen) {
            // lastPingsLen advances either way, so samples taken before the
            // match screen settled are discarded outright rather than
            // flushed in as a block the moment collecting turns true.
            if (collecting) {
                for (let i = lastPingsLen; i < game.pings.length; i++) {
                    const ms = game.pings[i];
                    if (typeof ms === "number" && ms >= 0) pingSamples.push({ t: wallNow, ms: ms });
                }
            }
            lastPingsLen = game.pings.length;
        }
        while (pingSamples.length && wallNow - pingSamples[0].t > PING_WINDOW_MS) pingSamples.shift();

        if (game.updateIntervals.length < lastIntervalsLen) lastIntervalsLen = 0;
        if (game.updateIntervals.length > lastIntervalsLen) {
            for (let i = lastIntervalsLen; i < game.updateIntervals.length; i++) {
                const ms = game.updateIntervals[i];
                if (typeof ms === "number" && ms >= 0) {
                    intervalSamples.push(ms);
                    if (intervalSamples.length > INTERVAL_WINDOW) intervalSamples.shift();
                }
            }
            lastIntervalsLen = game.updateIntervals.length;
        }

        const newest = pingSamples.length ? pingSamples[pingSamples.length - 1] : null;
        stats.pingMs = newest && wallNow - newest.t <= PING_STALE_MS ? newest.ms : null;
        if (pingSamples.length) {
            let sum = 0;
            for (let i = 0; i < pingSamples.length; i++) sum += pingSamples[i].ms;
            stats.pingAvgMs = sum / pingSamples.length;
        } else {
            stats.pingAvgMs = null;
        }
        if (pingSamples.length > 1) {
            let jSum = 0;
            for (let i = 1; i < pingSamples.length; i++) jSum += Math.abs(pingSamples[i].ms - pingSamples[i - 1].ms);
            stats.jitterMs = jSum / (pingSamples.length - 1);
        } else {
            stats.jitterMs = null;
        }
        stats.pingSamples = pingSamples;

        if (intervalSamples.length) {
            let sum = 0;
            for (let i = 0; i < intervalSamples.length; i++) sum += intervalSamples[i];
            stats.intervalAvgMs = sum / intervalSamples.length;
        } else {
            stats.intervalAvgMs = null;
        }

        stats.msSinceUpdate = game.lastUpdateTime > 0 ? wallNow - game.lastUpdateTime : null;
        const stalled = stats.msSinceUpdate !== null && stats.msSinceUpdate > STALL_THRESHOLD_MS;
        if (stalled && !wasStalled) stallOnsets.push(perfNow);
        wasStalled = stalled;
        while (stallOnsets.length && perfNow - stallOnsets[0] > STALLS_PER_MIN_WINDOW_MS) stallOnsets.shift();

        stats.stalled = stalled;
        stats.stallMs = stalled ? stats.msSinceUpdate : 0;
        stats.stallsPerMin = stallOnsets.length;
    }

    /** Two separate "start over" signals, and both are needed. The game's
     * own 20-second console ping dump empties game.pings/game.updateIntervals
     * mid-match, which the length-shrink checks above absorb without losing
     * anything. A new match instead replaces the whole Game - and there the
     * history this file keeps really is stale, which is what the identity
     * check at the top of onTick drops. */
    MOUSE.ctx.onTick(onTick);
})();
