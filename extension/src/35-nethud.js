// 35-nethud.js
//
// FPS and ping readouts, stacked above the match timer via 34-hudstack.js.
// Neither number exists anywhere in survev's own shipped UI - only its
// hidden debug HUD (client/src/debug/debugHUD.ts) has them, gated behind a
// dev-only toggle - so this reads the same underlying data MOUSE.net (17-net.js)
// already collects off ctx.game's own non-mangled fields.
//
// The ping row doubles as the "am I lagging right now" indicator: it turns
// red and appends a stall duration whenever MOUSE.net.stats.stalled is true
// (no server update in over 150ms - see 17-net.js), and shows the buffer
// 23-lagsmooth.js is currently forcing so it's clear the smoothing is doing
// something rather than nothing.
//
// The number and the sparkline are two independent hudStack rows rather
// than one row with a canvas inside it, so either can be shown without the
// other - a graph on its own is a perfectly reasonable thing to want, and
// nesting the canvas under the number made that impossible.
//
// What the ping number actually measures is the game's own definition, not
// a separate probe of our own: client/src/game.ts stamps seqSendTime when
// it sends an input carrying a new seq, and records Date.now() - seqSendTime
// when an UpdateMsg acks that seq. That is a real round trip, but it also
// contains however long the server sat on the input before its next
// netSync went out (up to ~30ms at survev's 33Hz sync rate), so it reads a
// little above a raw network RTT - by design, and identically to the number
// survev's own debug HUD graphs.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    const MODULE_ID = "nethud";

    function getSettings() {
        const get = (key, fallback) => MOUSE.modules.getSetting(MODULE_ID, key, fallback);
        return {
            showFps: get("showFps", true),
            showPing: get("showPing", true),
            showGraph: get("showGraph", true),
            graphSeconds: get("graphSeconds", 60),
            normalColor: get("normalColor", 0xffffff),
            lagColor: get("lagColor", 0xff0000),
        };
    }

    function toCss(n) {
        return "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6);
    }

    // --- FPS ----------------------------------------------------------------
    // Same accumulate-then-average recipe as client/src/debug/debugHUD.ts's
    // own fpsGraph: instantaneous 1/dt is dominated by rAF jitter frame to
    // frame, so this sums dt over a short window and reports 1/(mean dt).
    const FPS_UPDATE_MS = 200;
    let fpsAccumDt = 0;
    let fpsAccumFrames = 0;
    let fpsLastUpdateAt = 0;
    let displayFps = 0;

    function updateFps(dt) {
        fpsAccumDt += dt;
        fpsAccumFrames++;
        const now = performance.now();
        if (now - fpsLastUpdateAt >= FPS_UPDATE_MS) {
            if (fpsAccumDt > 0) displayFps = fpsAccumFrames / fpsAccumDt;
            fpsAccumDt = 0;
            fpsAccumFrames = 0;
            fpsLastUpdateAt = now;
        }
    }

    // --- Ping number ----------------------------------------------------
    // The underlying reading changes about once per netSync (~33Hz) but
    // this module's onTick runs once per rendered frame (up to 60+Hz), so
    // rewriting the row from live stats every tick redraws it far more
    // often than the number itself actually changes. Same throttle recipe
    // as updateFps above, on a snapshot rather than an average - the ping
    // row doesn't want smoothing, just fewer redraws - so the displayed
    // text and its "lagging" colour always agree with each other.
    const PING_UPDATE_MS = 200;
    let pingLastUpdateAt = 0;
    let displayPingSnapshot = /** @type {{available: boolean, pingMs: number | null, interpBufferMs: number, lagging: boolean, stallMs: number} | null} */ (null);

    /** @param {any} stats */
    function updatePingSnapshot(stats) {
        const now = performance.now();
        if (displayPingSnapshot && now - pingLastUpdateAt < PING_UPDATE_MS) return displayPingSnapshot;
        pingLastUpdateAt = now;
        displayPingSnapshot = stats && stats.available
            ? {
                  available: true,
                  pingMs: stats.pingMs,
                  interpBufferMs: stats.interpBufferMs,
                  lagging: !!stats.stalled,
                  stallMs: stats.stallMs,
              }
            : { available: false, pingMs: null, interpBufferMs: 0, lagging: false, stallMs: 0 };
        return displayPingSnapshot;
    }

    // --- Ping sparkline -------------------------------------------------
    let canvas = /** @type {HTMLCanvasElement | null} */ (null);
    const CANVAS_H = 24;

    function ensureCanvas(width) {
        if (!canvas) {
            canvas = document.createElement("canvas");
            Object.assign(canvas.style, { display: "block", marginTop: "2px" });
        }
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== CANVAS_H) canvas.height = CANVAS_H;
        return canvas;
    }

    // The graph only moves when the ping snapshot below refreshes (it is a
    // minute of history 140px wide), so it is redrawn then - or when its
    // colour or window changes - rather than every frame.
    let graphDrawnFor = /** @type {any} */ (null);
    let graphDrawnColor = -1;
    let graphDrawnSeconds = -1;

    function drawGraph(samples, graphSeconds, color) {
        const width = 140;
        const cv = ensureCanvas(width);
        const c2d = cv.getContext("2d");
        if (!c2d) return null;
        c2d.clearRect(0, 0, width, CANVAS_H);
        if (samples.length < 2) return cv;

        const now = Date.now();
        const windowMs = graphSeconds * 1000;
        let first = 0;
        while (first < samples.length && now - samples[first].t > windowMs) first++;
        if (samples.length - first < 2) return cv;
        let maxMs = 1;
        for (let i = first; i < samples.length; i++) {
            if (samples[i].ms > maxMs) maxMs = samples[i].ms;
        }

        c2d.strokeStyle = toCss(color);
        c2d.lineWidth = 1.5;
        c2d.beginPath();
        for (let i = first; i < samples.length; i++) {
            const x = (1 - (now - samples[i].t) / windowMs) * width;
            const y = CANVAS_H - (samples[i].ms / maxMs) * CANVAS_H;
            if (i === first) c2d.moveTo(x, y);
            else c2d.lineTo(x, y);
        }
        c2d.stroke();
        return cv;
    }

    /** Compared against what was last written, not style.color, which reads
     * back normalised to rgb(). @param {any} el @param {string} color */
    function setColor(el, color) {
        if (el.__mouseColor === color) return;
        el.__mouseColor = color;
        el.style.color = color;
    }

    function releaseAll() {
        MOUSE.hudStack.release("fps");
        MOUSE.hudStack.release("ping");
        MOUSE.hudStack.release("pinggraph");
    }

    function onTick(dt, ctx) {
        if (!ctx.ready || !ctx.inGameScreen() || ctx.showingStats()) {
            releaseAll();
            return;
        }

        const settings = getSettings();
        updateFps(dt);

        const stats = (MOUSE.net && MOUSE.net.stats) || null;
        const snap = updatePingSnapshot(stats);
        const lagging = snap.lagging;
        const color = toCss(lagging ? settings.lagColor : settings.normalColor);

        if (settings.showFps) {
            const el = MOUSE.hudStack.row("fps", 10);
            setColor(el, toCss(settings.normalColor));
            MOUSE.hudStack.setText(el, "FPS: " + Math.round(displayFps));
        } else {
            MOUSE.hudStack.release("fps");
        }

        if (settings.showPing) {
            const el = MOUSE.hudStack.row("ping", 20);
            setColor(el, color);

            let text;
            if (!snap.available) {
                text = "Ping: --";
            } else {
                text = "Ping: " + (snap.pingMs !== null ? Math.round(snap.pingMs) + "ms" : "--");
                if (snap.interpBufferMs > 1) text += " (+" + Math.round(snap.interpBufferMs) + "ms buf)";
                if (lagging) text += " · stalled " + Math.round(snap.stallMs) + "ms";
            }
            MOUSE.hudStack.setText(el, text);
        } else {
            MOUSE.hudStack.release("ping");
        }

        if (settings.showGraph && stats && stats.available && stats.pingSamples.length > 1) {
            const graphColor = lagging ? settings.lagColor : settings.normalColor;
            if (graphDrawnFor !== snap || graphDrawnColor !== graphColor || graphDrawnSeconds !== settings.graphSeconds) {
                graphDrawnFor = drawGraph(stats.pingSamples, settings.graphSeconds, graphColor) ? snap : null;
                graphDrawnColor = graphColor;
                graphDrawnSeconds = settings.graphSeconds;
            }
            if (!graphDrawnFor || !canvas) {
                MOUSE.hudStack.release("pinggraph");
            } else {
                const el = MOUSE.hudStack.row("pinggraph", 21);
                if (canvas.parentElement !== el) el.appendChild(canvas);
            }
        } else {
            MOUSE.hudStack.release("pinggraph");
        }
    }

    MOUSE.modules.register({
        id: MODULE_ID,
        name: "FPS / Ping",
        description:
            "FPS and ping readouts above the match timer, plus a ping sparkline that can be shown with or without the number. The ping row goes red and shows a stall duration when no server update has arrived in a while, and shows how much buffer Lag Smoothing is currently adding, if that module is on.",
        settings: {
            showFps: { kind: "bool", label: "Show FPS", default: true },
            showPing: { kind: "bool", label: "Show ping", default: true },
            showGraph: { kind: "bool", label: "Show ping graph", default: true },
            graphSeconds: { kind: "number", label: "Graph window", default: 60, min: 30, max: 90, step: 5, unit: "s" },
            normalColor: { kind: "color", label: "Normal color", default: 0xffffff },
            lagColor: { kind: "color", label: "Lagging color", default: 0xff0000 },
        },
        onDisable() {
            releaseAll();
        },
        onTick,
    });
})();
