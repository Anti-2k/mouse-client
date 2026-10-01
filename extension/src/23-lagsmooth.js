// 23-lagsmooth.js
//
// A snapshot jitter buffer for player positions: every player - and, by
// default, you and therefore the camera - is drawn a small, adaptive delay
// behind the newest server update, interpolating between the updates that
// have actually arrived instead of chasing the latest one. A late or
// bunched-up update is then absorbed inside that delay rather than showing
// up as a freeze followed by a crawl, and a stall longer than the delay is
// bridged by a short, capped extrapolation that eases back onto the real
// position when the server catches up.
//
// What survev does without this: client/src/objects/player.ts's
// m_updateData restarts a lerp on every update, from the *previous wire
// position* (m_pos, not the current visual one) to the new one, over
// camera.m_interpInterval - which client/src/game.ts's m_processGameUpdate
// rewrites on every UpdateMsg to the raw wall-clock gap since the previous
// message. A normal ~30ms gap lerps exactly into the next update. A late
// one freezes at the target for the rest of the gap, and then the next
// update stretches the lerp to the whole stall length: freeze, then crawl.
//
// Why this doesn't just widen that interval: because the lerp restarts
// from the previous *wire* position, any interval longer than the real gap
// makes every update jump the drawn position forward to where the last lerp
// was headed before it got there. Widening the window turns the occasional
// stall stutter into a constant sawtooth. The buffer below replaces the visual position
// outright instead, via an accessor over each Player's m_visualPos (the one
// field the camera, Player.render and everything else downstream read), so
// the game's own lerp still runs but only feeds the fallback.
//
// Timeline: survev's server sends exactly one UpdateMsg per net-sync tick
// (config.ts netSyncTps: 33), so an update's *index* is a far better clock
// than its arrival time - arrivals carry all the network jitter this is
// trying to hide. The earliest arrivals over a few seconds (the lower
// envelope) pin down where each index "should" have arrived on a perfect
// connection, the spread above that envelope is the jitter, and the
// playback position is the newest index minus one interval plus a
// percentile of that jitter. A player the server did not include in an
// update did not move in it (the server only sends players whose position
// changed), so their position at that index is simply their last one.
//
// Everything here is render-side only - nothing sent to the server changes.
// Your own position on the server is never predicted: with "Smooth own
// player" on, you are drawn from the same buffer as everyone else, which
// smooths the camera through a stall but does not make your inputs land
// sooner.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const MODULE_ID = "lagsmooth";

    /** Nominal net-sync interval before enough updates have arrived to
     * measure the real one (config.ts netSyncTps: 33). */
    const DEFAULT_INTERVAL_MS = 1000 / 33;
    /** Update arrivals kept for the envelope/interval fit - ~8s at 33Hz. */
    const ARRIVAL_WINDOW = 256;
    /** Fewest arrivals before the interval is measured rather than assumed. */
    const MIN_FIT_ARRIVALS = 64;
    /** Most recent arrivals the jitter percentile is taken over - ~3s. */
    const LATENESS_WINDOW = 100;
    /** Snapshots kept per player - far more than the deepest the playback
     * position can ever sit behind the newest update. */
    const MAX_SNAPSHOTS = 48;
    /** A move bigger than this between two consecutive updates is a
     * teleport (respawn, spectate switch, re-entering view), never walking:
     * snap across it instead of gliding. World units. */
    const TELEPORT_DIST = 5;
    /** Playback clock steering time constant, and how far (in updates) it
     * may drift from where it should be before it just jumps there (first
     * frame, tab switched back in). */
    const PLAYOUT_TAU_SEC = 0.5;
    const PLAYOUT_SNAP_UPDATES = 10;
    /** The jitter allowance grows quickly after a burst of late updates and
     * shrinks slowly once the connection settles, so one bad second doesn't
     * make it oscillate. */
    const ALLOWANCE_UP_TAU_SEC = 0.3;
    const ALLOWANCE_DOWN_TAU_SEC = 3;

    function getSettings() {
        const get = (key, fallback) => MOUSE.modules.getSetting(MODULE_ID, key, fallback);
        return {
            adaptive: get("adaptive", true),
            fixedBufferMs: get("fixedBufferMs", 40),
            percentile: get("percentile", 90),
            marginMs: get("marginMs", 5),
            minBufferMs: get("minBufferMs", 0),
            maxBufferMs: get("maxBufferMs", 200),
            maxExtrapMs: get("maxExtrapMs", 100),
            correctionMs: get("correctionMs", 120),
            smoothSelf: get("smoothSelf", true),
        };
    }

    let active = false;

    // --- Update timeline -----------------------------------------------------
    /** The Game whose updates are being indexed. */
    let lastGame = null;
    const hookedGames = new WeakSet();
    /** Bumped whenever the index timeline restarts, so per-player snapshot
     * buffers indexed against the old one get dropped lazily. */
    let generation = 0;
    /** Index of the newest UpdateMsg, -1 before the first. */
    let updateIndex = -1;
    /** @type {Array<{k: number, a: number}>} performance.now() arrival per update index, oldest first. */
    const arrivals = [];
    let intervalMs = DEFAULT_INTERVAL_MS;
    /** When the newest update would have arrived on a jitter-free link. */
    let envelopeAt = 0;
    /** The configured percentile of recent updates' lateness past the envelope, ms. */
    let latenessPctlMs = 0;
    /** Smoothed jitter allowance actually applied, ms; null until the first frame after a reset. */
    let allowanceMs = /** @type {number | null} */ (null);
    /** Fractional update index being drawn right now; null until set. */
    let playout = /** @type {number | null} */ (null);

    function resetTimeline() {
        generation++;
        updateIndex = -1;
        arrivals.length = 0;
        intervalMs = DEFAULT_INTERVAL_MS;
        envelopeAt = 0;
        latenessPctlMs = 0;
        allowanceMs = null;
        playout = null;
    }

    /** Sorted-copy percentile over a ~100-entry list, once per update.
     * @param {number[]} arr @param {number} pct 0-100 */
    function percentileOf(arr, pct) {
        if (!arr.length) return 0;
        const sorted = arr.slice().sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((pct / 100) * sorted.length)));
        return sorted[idx];
    }

    /** Refits the interval, the envelope and the jitter percentile after a
     * new arrival. The interval comes from the *earliest* arrival in the
     * oldest and the newest quarter of the window rather than a
     * least-squares fit: late updates are only ever late, never early, so
     * a stall's bunched-up tail would drag a regression but cannot move a
     * minimum. */
    function refitTimeline(settings) {
        const n = arrivals.length;
        const K = updateIndex;
        if (n >= MIN_FIT_ARRIVALS) {
            const q = n >> 2;
            let m1 = Infinity;
            let k1 = 0;
            let m2 = Infinity;
            let k2 = 0;
            for (let i = 0; i < q; i++) {
                const v = arrivals[i].a - arrivals[i].k * intervalMs;
                if (v < m1) {
                    m1 = v;
                    k1 = arrivals[i].k;
                }
            }
            for (let i = n - q; i < n; i++) {
                const v = arrivals[i].a - arrivals[i].k * intervalMs;
                if (v < m2) {
                    m2 = v;
                    k2 = arrivals[i].k;
                }
            }
            if (k2 - k1 >= 32) {
                const fit = intervalMs + (m2 - m1) / (k2 - k1);
                if (fit > 10 && fit < 100) intervalMs += (fit - intervalMs) * 0.1;
            }
        }

        let env = Infinity;
        for (let i = 0; i < n; i++) {
            const e = arrivals[i].a + (K - arrivals[i].k) * intervalMs;
            if (e < env) env = e;
        }
        envelopeAt = env;

        const late = [];
        for (let i = Math.max(0, n - LATENESS_WINDOW); i < n; i++) {
            late.push(arrivals[i].a - (env - (K - arrivals[i].k) * intervalMs));
        }
        latenessPctlMs = percentileOf(late, settings.percentile);
    }

    // --- Per-player snapshot buffers ----------------------------------------
    /**
     * @typedef {{
     *   gen: number, id: any, real: any, out: {x: number, y: number} | null, stamp: number,
     *   snaps: Array<{k: number, x: number, y: number}>, lastRef: any,
     *   offX: number, offY: number, underrun: boolean, underrunAt: number,
     * }} PlayerState
     */
    /** @type {WeakMap<any, PlayerState>} */
    const playerStates = new WeakMap();
    /** Incremented at the top of every tick; a player's accessor only hands
     * back the buffered position if it was computed in the current one. */
    let publishStamp = 0;

    // client/src/objects/player.ts declares m_pos, m_posOld, m_dir,
    // m_dirOld, m_visualPos, m_visualPosOld, m_visualDir, m_visualDirOld,
    // posInterpTicker in that order, all with initializers, and the build
    // keeps class-field order. posInterpTicker has no m_ prefix and so keeps
    // its real name, which makes it an anchor: m_visualPos is always the key
    // four before it.
    let visualPosKey = /** @type {string | null} */ (null);

    /** @param {any} v */
    function isVec(v) {
        return !!v && typeof v.x === "number" && typeof v.y === "number";
    }

    /** @param {any} p */
    function resolveVisualPosKey(p) {
        if (visualPosKey !== null && visualPosKey in p) return visualPosKey;
        const keys = Object.keys(p);
        const i = keys.indexOf("posInterpTicker");
        if (i < 8) return null;
        const key = keys[i - 4];
        if (!isVec(p[key]) || !isVec(p[keys[i - 8]])) return null;
        visualPosKey = key;
        MOUSE.log("lag smoothing: resolved Player visual-position field");
        return key;
    }

    /** The state for `p`, installing its m_visualPos accessor on first
     * sight. Players are pooled, so an object keeps its accessor for the
     * whole match; a recycled one is detected by its __id changing.
     * @param {any} p @returns {PlayerState | null} */
    function stateFor(p) {
        let st = playerStates.get(p);
        if (st) {
            if (st.gen !== generation || st.id !== p.__id) clearState(st, p);
            return st;
        }
        const key = resolveVisualPosKey(p);
        if (key === null) return null;
        const desc = Object.getOwnPropertyDescriptor(p, key);
        if (!desc || !("value" in desc)) return null;
        const state = /** @type {PlayerState} */ ({
            gen: generation,
            id: p.__id,
            real: desc.value,
            out: null,
            stamp: -1,
            snaps: [],
            lastRef: null,
            offX: 0,
            offY: 0,
            underrun: false,
            underrunAt: -1,
        });
        try {
            Object.defineProperty(p, key, {
                configurable: true,
                enumerable: true,
                get() {
                    return active && state.stamp === publishStamp && state.out !== null ? state.out : state.real;
                },
                set(v) {
                    state.real = v;
                },
            });
        } catch (e) {
            MOUSE.warn("lag smoothing: could not install the visual-position accessor", e);
            return null;
        }
        playerStates.set(p, state);
        return state;
    }

    /** @param {PlayerState} st @param {any} p */
    function clearState(st, p) {
        st.gen = generation;
        st.id = p.__id;
        st.out = null;
        st.snaps.length = 0;
        st.lastRef = null;
        st.offX = 0;
        st.offY = 0;
        st.underrun = false;
        st.underrunAt = -1;
    }

    /** Files every player's current wire position under update index `k`.
     * Called at the start of each UpdateMsg for the one before it (so
     * several updates arriving between two frames each keep their own
     * positions) and every frame for the newest one. A position object the
     * game hasn't replaced since the last call is the same update, not a
     * new one - see ctx.netPos.
     * @param {any} ctx @param {number} k */
    function record(ctx, k) {
        const list = ctx.poolArray(ctx.playerBarn.playerPool);
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            const st = stateFor(p);
            if (!st) continue;
            if (!p.active) {
                // Leaving view and coming back later must not glide from
                // wherever they were last seen.
                if (st.snaps.length) clearState(st, p);
                continue;
            }
            const pos = ctx.netPos(p);
            if (!pos || pos === st.lastRef) continue;
            st.lastRef = pos;
            const snaps = st.snaps;
            const last = snaps.length ? snaps[snaps.length - 1] : null;
            if (last && last.k === k) {
                last.x = pos.x;
                last.y = pos.y;
            } else {
                snaps.push({ k: k, x: pos.x, y: pos.y });
                if (snaps.length > MAX_SNAPSHOTS) snaps.shift();
            }
        }
    }

    /** Position at whole update index `j`: the newest snapshot at or before
     * it (no snapshot for an index means no movement in it).
     * @param {Array<{k: number, x: number, y: number}>} snaps @param {number} j */
    function posAt(snaps, j) {
        for (let i = snaps.length - 1; i >= 0; i--) {
            if (snaps[i].k <= j) return snaps[i];
        }
        return snaps[0];
    }

    /** @param {PlayerState} st @param {number} r playback index @param {number} maxExtrapUpdates
     * @returns {{x: number, y: number, underrun: boolean}} */
    function sample(st, r, maxExtrapUpdates) {
        const snaps = st.snaps;
        const K = updateIndex;
        const j0 = Math.floor(r);
        if (j0 + 1 <= K) {
            const a = posAt(snaps, j0);
            const b = posAt(snaps, j0 + 1);
            if (a === b || Math.hypot(b.x - a.x, b.y - a.y) > TELEPORT_DIST) {
                return { x: a.x, y: a.y, underrun: false };
            }
            const f = r - j0;
            return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, underrun: false };
        }
        // Playback has caught up with the newest update: the next one is
        // late. Carry the last step's motion forward for a bounded time,
        // then hold.
        const base = posAt(snaps, K);
        const prev = posAt(snaps, K - 1);
        let vx = base.x - prev.x;
        let vy = base.y - prev.y;
        if (Math.hypot(vx, vy) > TELEPORT_DIST) {
            vx = 0;
            vy = 0;
        }
        const ext = Math.max(0, Math.min(r - K, maxExtrapUpdates));
        return { x: base.x + vx * ext, y: base.y + vy * ext, underrun: true };
    }

    // --- UpdateMsg hook ------------------------------------------------------
    // client/src/game.ts's m_processGameUpdate assigns `this.lastUpdateTime
    // = now` once per UpdateMsg, before it applies any of that message's
    // object updates, and the field is unmangled. An accessor over it is
    // therefore an exact "an update is about to be applied" signal - which
    // a per-frame check cannot be, since several updates can land between
    // two frames after a stall. 17-net.js reads the same field and just
    // sees the value through the getter.

    function onUpdateMsg() {
        const ctx = MOUSE.ctx;
        if (updateIndex >= 0 && ctx.playerBarn) record(ctx, updateIndex);
        updateIndex++;
        arrivals.push({ k: updateIndex, a: performance.now() });
        if (arrivals.length > ARRIVAL_WINDOW) arrivals.shift();
        refitTimeline(getSettings());
    }

    let lastHookThrowLog = 0;
    /** @param {any} game */
    function hookGame(game) {
        if (hookedGames.has(game)) return;
        let real = game.lastUpdateTime;
        if (typeof real !== "number") return;
        try {
            Object.defineProperty(game, "lastUpdateTime", {
                configurable: true,
                enumerable: true,
                get() {
                    return real;
                },
                set(v) {
                    real = v;
                    if (!active || game !== lastGame) return;
                    try {
                        // Game.init() zeroes it for a new match on the same
                        // instance; anything else is an arriving update.
                        if (v > 0) onUpdateMsg();
                        else resetTimeline();
                    } catch (e) {
                        const now = Date.now();
                        if (now - lastHookThrowLog >= 5000) {
                            lastHookThrowLog = now;
                            MOUSE.warn("lag smoothing: update hook threw", e);
                        }
                    }
                },
            });
        } catch (e) {
            MOUSE.warn("lag smoothing: could not hook game.lastUpdateTime", e);
            return;
        }
        hookedGames.add(game);
    }

    // --- Per frame -----------------------------------------------------------

    function onTick(dt, ctx) {
        // First, before anything can return or throw: last tick's positions
        // stop being served, so a tick that doesn't finish falls back to
        // the game's own values instead of freezing everyone in place.
        publishStamp++;
        const stats = MOUSE.net && MOUSE.net.stats;
        if (stats) stats.interpBufferMs = 0;
        if (!ctx.ready || !ctx.game || !ctx.playerBarn) return;

        if (ctx.game !== lastGame) {
            lastGame = ctx.game;
            resetTimeline();
        }
        hookGame(ctx.game);
        if (updateIndex < 1) return;
        record(ctx, updateIndex);

        const settings = getSettings();
        const now = performance.now();

        const target = settings.adaptive
            ? Math.min(settings.maxBufferMs, Math.max(settings.minBufferMs, latenessPctlMs + settings.marginMs))
            : settings.fixedBufferMs;
        if (allowanceMs === null) {
            allowanceMs = target;
        } else {
            const tau = target > allowanceMs ? ALLOWANCE_UP_TAU_SEC : ALLOWANCE_DOWN_TAU_SEC;
            allowanceMs += (target - allowanceMs) * (1 - Math.exp(-dt / tau));
        }

        // One full interval is the floor: interpolating toward index j+1
        // needs j+1 to have arrived. The allowance on top covers late ones.
        const delayMs = intervalMs + allowanceMs;
        const playoutTarget = updateIndex + (now - envelopeAt - delayMs) / intervalMs;
        if (playout === null || Math.abs(playoutTarget - playout) > PLAYOUT_SNAP_UPDATES) {
            playout = playoutTarget;
        } else {
            playout += (dt * 1000) / intervalMs;
            playout += (playoutTarget - playout) * (1 - Math.exp(-dt / PLAYOUT_TAU_SEC));
        }

        const maxExtrapUpdates = settings.maxExtrapMs / intervalMs;
        const decay = settings.correctionMs > 0 ? Math.exp(-(dt * 1000) / settings.correctionMs) : 0;
        const self = ctx.activePlayer;
        const list = ctx.poolArray(ctx.playerBarn.playerPool);
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!p.active || (p === self && !settings.smoothSelf)) continue;
            const st = stateFor(p);
            if (!st || !st.snaps.length) continue;
            const raw = sample(st, playout, maxExtrapUpdates);

            if (st.underrun && st.out !== null && st.underrunAt !== updateIndex) {
                // New data landed while this player was being extrapolated
                // or held: start from where they were actually drawn and
                // ease onto the corrected path instead of snapping to it.
                st.offX = st.out.x - raw.x;
                st.offY = st.out.y - raw.y;
                if (Math.hypot(st.offX, st.offY) > TELEPORT_DIST) {
                    st.offX = 0;
                    st.offY = 0;
                }
            } else {
                st.offX *= decay;
                st.offY *= decay;
            }
            st.underrun = raw.underrun;
            if (raw.underrun) st.underrunAt = updateIndex;

            // A fresh object each frame: the game copies it in most places,
            // but nothing guarantees every reader does.
            st.out = { x: raw.x + st.offX, y: raw.y + st.offY };
            st.stamp = publishStamp;
        }

        if (stats) stats.interpBufferMs = allowanceMs;
    }

    MOUSE.modules.register({
        id: MODULE_ID,
        name: "Lag smoothing",
        description:
            "Jitter buffer for player movement: draws everyone a small adaptive delay behind the newest server update and interpolates between updates that have actually arrived, so late or bunched-up updates no longer freeze and then crawl. A stall longer than the buffer is bridged by a short extrapolation that eases back onto the real position. Render-side only - nothing sent to the server changes.",
        // The buffer settings are jitter allowance on top of one update
        // interval, not a whole interpolation window - hence the *BufferMs
        // names.
        settings: {
            smoothSelf: {
                kind: "bool",
                label: "Smooth own player",
                default: true,
                hint: "Also draw you (and so the camera) from the buffer. Smooths your own view through a stall; your inputs still reach the server exactly as fast as before.",
            },
            adaptive: {
                kind: "bool",
                label: "Adaptive buffer",
                default: true,
                hint: "Size the buffer from how late recent updates actually arrived. Off uses one fixed size.",
            },
            percentile: {
                kind: "number",
                label: "Jitter coverage",
                default: 90,
                min: 50,
                max: 99,
                step: 1,
                unit: "%",
                hint: "Share of recent updates the buffer should be deep enough to absorb. Higher is smoother on a bad connection but draws everyone further behind.",
                showIf: (get) => get("adaptive"),
            },
            marginMs: {
                kind: "number",
                label: "Safety margin",
                default: 5,
                min: 0,
                max: 50,
                step: 1,
                unit: "ms",
                hint: "Added on top of the measured jitter.",
                showIf: (get) => get("adaptive"),
            },
            minBufferMs: {
                kind: "number",
                label: "Minimum buffer",
                default: 0,
                min: 0,
                max: 120,
                step: 5,
                unit: "ms",
                hint: "The adaptive buffer never shrinks below this.",
                showIf: (get) => get("adaptive"),
            },
            maxBufferMs: {
                kind: "number",
                label: "Maximum buffer",
                default: 200,
                min: 50,
                max: 500,
                step: 10,
                unit: "ms",
                hint: "The adaptive buffer never grows past this; wins over the minimum if the two cross.",
                showIf: (get) => get("adaptive"),
            },
            fixedBufferMs: {
                kind: "number",
                label: "Buffer",
                default: 40,
                min: 0,
                max: 300,
                step: 5,
                unit: "ms",
                hint: "Delay on top of one update interval (~30 ms). 0 still interpolates between real updates but absorbs no lateness.",
                showIf: (get) => !get("adaptive"),
            },
            maxExtrapMs: {
                kind: "number",
                label: "Max extrapolation",
                default: 100,
                min: 0,
                max: 300,
                step: 10,
                unit: "ms",
                zeroLabel: "off",
                hint: "When an update is later than the buffer covers, keep players moving along their last step for up to this long, then hold them still.",
            },
            correctionMs: {
                kind: "number",
                label: "Correction blend",
                default: 120,
                min: 0,
                max: 500,
                step: 10,
                unit: "ms",
                zeroLabel: "snap",
                hint: "How long a player drawn off their real path (after extrapolating through a stall) takes to ease back onto it.",
            },
        },
        onEnable() {
            active = true;
            lastGame = null; // re-index from scratch; updates were ignored while off
        },
        onDisable() {
            active = false;
            publishStamp++;
            lastGame = null;
            if (MOUSE.net && MOUSE.net.stats) MOUSE.net.stats.interpBufferMs = 0;
        },
        onTick,
    });
})();
