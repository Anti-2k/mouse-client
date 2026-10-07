// 37-recorder.js
//
// Screen recorder: records this tab - exactly what's on screen, client
// windows included if they're open - to a video file in Downloads. It has its
// own window, shown and hidden with every other window by Right Shift like
// the skin changer's, with the record hotkey's keycap in its header.
//
// Deliberately not a module (12-modules.js). The master switch runs every
// enabled module's onDisable and stops their ticks, and setting binds only
// fire for active modules, so a recorder built as one would stop the moment
// the client was switched off. Instead it keeps its own state and config
// ("recorder.*"), and its hotkey is one of 31-gui.js's tool binds, which the
// master switch does not gate. It never touches ctx either, so it keeps working even when a
// game update has broken the bundle patch.
//
// Capture is getDisplayMedia with preferCurrentTab: Chrome's "share this tab"
// prompt, with this tab already picked. The call needs a user gesture - a
// click on the Record button and the hotkey's own keydown both count - and
// the stream it returns is kept for the rest of the page load, so only the
// first recording asks. Chrome marks the tab as shared (blue border, sharing
// bar) for as long as the stream is open. Its own "Stop sharing" ends the
// stream, and with it any recording in progress, which is saved as usual; the
// next recording asks again.
//
// Starting a recording closes every client window, then waits START_PAUSE_MS
// before the first frame so they aren't caught half-closed. Stopping doesn't
// reopen them.
//
// With "Compress recordings" on, a recording over the "Size limit" is
// re-encoded to land just under it (38-recompress.js) before it's saved.
// That takes a while - every pass decodes and encodes the whole video - so
// the button reads "Compressing" until it's done and ignores the hotkey
// meanwhile. If it can't be done (a WebM recording, or a limit too small for
// its length), the original is saved instead and the status says why.
// "Compress a file" runs the same thing on an MP4 picked from disk, such as
// a recording saved with compressing off, and saves the result as
// "<name>-compressed.mp4".

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;
    const config = MOUSE.config;

    // Nothing mounts under the kill switch (99-boot.js), and a hotkey that
    // could still open Chrome's share prompt would be the one part of the
    // client left running on the vanilla page.
    if (MOUSE.disabled) return;

    const CONFIG_PATH = "recorder";

    /** Long enough for the windows to close on screen, plus the capture
     * pipeline's own frame or
     * two of latency - and on the first recording, for Chrome's sharing bar
     * to appear and the game to re-lay itself out around it. */
    const START_PAUSE_MS = 500;

    // Recording formats, most preferred first. H.264 is `avc3` rather than
    // `avc1`: both are H.264 in MP4, but avc1 keeps the stream's parameters
    // (its frame size included) only in the file header, so the first resize
    // mid-recording - fullscreen, resizing the window - leaves everything
    // after it undecodable. avc3 repeats them in the stream and switches size
    // cleanly. Tested against Chrome 152 on Linux: avc1 corrupted after a
    // resize, avc3 and both WebM codecs did not. AAC is tried first since it
    // plays everywhere, but Chrome can only encode it where the OS provides
    // an encoder - not on Linux, where the MP4 carries Opus instead. WebM is
    // for Chromium builds shipped without H.264.
    const MIME_AUDIO = [
        "video/mp4;codecs=avc3,mp4a.40.2",
        "video/mp4;codecs=avc3,opus",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
    ];
    // "Also share tab audio" unticked in Chrome's prompt: no audio track.
    const MIME_VIDEO = ["video/mp4;codecs=avc3", "video/webm;codecs=vp9", "video/webm;codecs=vp8"];

    /** @type {Record<string, import("./11-config.js").SettingDef>} */
    const SETTINGS = {
        resolution: {
            kind: "enum",
            label: "Resolution",
            default: "1080",
            options: [
                { value: "native", label: "Native" },
                { value: "1440", label: "1440p" },
                { value: "1080", label: "1080p" },
                { value: "720", label: "720p" },
            ],
            hint: "The most a recording is scaled to. A smaller tab records at its own size. Encoding takes CPU the game also wants, so higher can cost frames.",
        },
        fps: {
            kind: "enum",
            label: "Frame rate",
            default: "60",
            options: [
                { value: "60", label: "60 fps" },
                { value: "30", label: "30 fps" },
            ],
        },
        bitrate: {
            kind: "number",
            label: "Bitrate",
            default: 12,
            min: 2,
            max: 40,
            step: 1,
            unit: "Mbps",
            hint: "Higher is sharper and bigger: 12 Mbps is about 90 MB a minute.",
        },
        autoCompress: {
            kind: "bool",
            label: "Compress recordings",
            default: true,
            hint: "A recording bigger than the size limit is re-encoded after it stops, before it's saved.",
        },
        sizeLimit: {
            kind: "number",
            label: "Size limit",
            default: 100,
            min: 5,
            max: 500,
            step: 5,
            unit: "MB",
            hint: "What compressing fits a video under: it lands just under, around 97%, not far below. Very long ones also drop resolution to fit.",
        },
        compressFile: {
            kind: "action",
            label: "Compress a file",
            buttonLabel: "Choose...",
            default: null,
            hint: "Compresses an MP4 this recorder saved earlier to the size limit, saving it as a new file next to the original name.",
            onClick: chooseFile,
        },
    };

    /** @type {Record<string, any>} */
    const settingDefaults = {};
    for (const key in SETTINGS) settingDefaults[key] = SETTINGS[key].default;
    config.ensureDefaults(CONFIG_PATH, { bind: null, settings: settingDefaults });

    /** @param {string} key */
    function getSetting(key) {
        return config.get(CONFIG_PATH + ".settings." + key, SETTINGS[key].default);
    }
    const getBind = () => config.get(CONFIG_PATH + ".bind", null);
    /** @param {any} bind */
    const setBind = (bind) => config.set(CONFIG_PATH + ".bind", bind);

    // --- State ------------------------------------------------------------
    /** asking: Chrome's share prompt is up. pausing: START_PAUSE_MS between
     * closing the windows and the first frame. saving: stopped, waiting on
     * the recorder's last data. compressing: fitting it under the size limit.
     * @type {"idle"|"asking"|"pausing"|"recording"|"saving"|"compressing"} */
    let state = "idle";
    /** @type {MediaStream | null} */
    let stream = null;
    /** @type {MediaRecorder | null} */
    let recorder = null;
    /** @type {Blob[]} */
    let chunks = [];
    let bytes = 0;
    let startedAt = 0;
    let fileBase = "";
    /** @type {any} */
    let pauseTimer = null;
    /** @type {any} */
    let clockTimer = null;
    /** Progress readout while compressing. */
    let compressText = "";

    function streamLive() {
        return !!stream && stream.getVideoTracks().some((t) => t.readyState === "live");
    }

    function toggle() {
        if (state === "idle") start();
        else if (state === "pausing") cancelStart();
        else if (state === "recording") stop();
        // "asking", "saving" and "compressing" ignore presses until they resolve.
    }

    /** Size and frame-rate limits for the video track, from the settings.
     * The height is the binding limit and the width only a ceiling wide
     * enough for any monitor, so Chrome scales the tab down to fit and keeps
     * its aspect ratio. Some limit has to be given: left unconstrained,
     * Chrome delivered a 1280-wide tab at 800 wide in testing.
     * @returns {any} */
    function captureConstraints() {
        const fps = Number(getSetting("fps")) || 60;
        const res = getSetting("resolution");
        const maxHeight = res === "native" ? 2160 : Number(res) || 1080;
        return {
            width: { max: Math.round((maxHeight * 32) / 9) },
            height: { max: maxHeight },
            frameRate: { ideal: fps, max: fps },
            resizeMode: "crop-and-scale",
        };
    }

    function start() {
        state = "asking";
        render();
        /** @type {Promise<MediaStream>} */
        let ready;
        if (streamLive()) {
            ready = Promise.resolve(/** @type {MediaStream} */ (stream));
        } else {
            // Called synchronously, still inside the click or keydown that
            // got here - Chrome refuses the prompt without that gesture.
            try {
                ready = navigator.mediaDevices
                    .getDisplayMedia(
                        /** @type {any} */ ({
                            video: captureConstraints(),
                            audio: true,
                            preferCurrentTab: true,
                            selfBrowserSurface: "include",
                            surfaceSwitching: "exclude",
                            monitorTypeSurfaces: "exclude",
                        }),
                    )
                    .then(adoptStream);
            } catch (e) {
                ready = Promise.reject(e);
            }
        }
        ready.then(beginPause, function (e) {
            state = "idle";
            setStatus(
                e && e.name === "NotAllowedError"
                    ? "Share prompt dismissed"
                    : "Couldn't capture the tab: " + ((e && e.message) || e),
            );
            render();
        });
    }

    /** @param {MediaStream} s */
    function adoptStream(s) {
        stream = s;
        // Chrome's "Stop sharing" ends the tracks. MediaRecorder stops by
        // itself once its stream has nothing live left, which saves as
        // usual; stop() here only covers the audio track outliving the video.
        s.getVideoTracks()[0].addEventListener("ended", function () {
            if (stream !== s) return;
            stream = null;
            if (state === "pausing") cancelStart();
            else if (state === "recording") stop();
            else setStatus("Tab sharing stopped");
            render();
        });
        return s;
    }

    function beginPause() {
        if (state !== "asking") return;
        MOUSE.gui.setVisible(false);
        // Settings can change between recordings on the same stream. This
        // settles within a frame or two, well inside the pause.
        const track = stream && stream.getVideoTracks()[0];
        if (track) {
            track.applyConstraints(captureConstraints()).catch(function (e) {
                MOUSE.warn("recorder: couldn't apply capture settings", e);
            });
        }
        state = "pausing";
        render();
        pauseTimer = setTimeout(beginRecording, START_PAUSE_MS);
    }

    function cancelStart() {
        clearTimeout(pauseTimer);
        state = "idle";
        setStatus("Start cancelled");
        render();
    }

    /** @param {boolean} withAudio */
    function pickMimeType(withAudio) {
        const list = withAudio ? MIME_AUDIO : MIME_VIDEO;
        for (const m of list) if (MediaRecorder.isTypeSupported(m)) return m;
        return ""; // Chrome's own default
    }

    function beginRecording() {
        if (state !== "pausing") return;
        if (!stream || !streamLive()) {
            state = "idle";
            setStatus("Tab sharing stopped");
            render();
            return;
        }
        const withAudio = stream.getAudioTracks().some((t) => t.readyState === "live");
        /** @type {MediaRecorder} */
        let rec;
        try {
            rec = new MediaRecorder(stream, {
                mimeType: pickMimeType(withAudio),
                videoBitsPerSecond: Number(getSetting("bitrate")) * 1e6,
            });
        } catch (e) {
            state = "idle";
            setStatus("Couldn't start recording: " + ((e && e.message) || e));
            render();
            return;
        }
        chunks = [];
        bytes = 0;
        fileBase = "survev-" + timestamp(new Date());
        rec.ondataavailable = function (e) {
            if (!e.data || !e.data.size) return;
            chunks.push(e.data);
            bytes += e.data.size;
        };
        // An error stops the recorder too, and what it had is still saved.
        rec.onerror = function (e) {
            MOUSE.warn("recorder: MediaRecorder error", /** @type {any} */ (e).error || e);
        };
        rec.onstop = function () {
            save(rec);
        };
        // A timeslice so the size readout moves and the data arrives as it
        // goes rather than as one buffer at the end.
        rec.start(1000);
        recorder = rec;
        startedAt = performance.now();
        state = "recording";
        clockTimer = setInterval(render, 250);
        setStatus("Recording");
        render();
    }

    function stop() {
        if (state !== "recording" || !recorder) return;
        state = "saving";
        render();
        if (recorder.state !== "inactive") recorder.stop();
    }

    /** @param {MediaRecorder} rec */
    function save(rec) {
        if (rec !== recorder) return;
        clearInterval(clockTimer);
        recorder = null;
        state = "idle";
        const type = rec.mimeType || "video/webm";
        const blob = new Blob(chunks, { type: type });
        chunks = [];
        if (!blob.size) {
            setStatus("Nothing was recorded");
            render();
            return;
        }
        const isMp4 = type.indexOf("mp4") !== -1;
        const name = fileBase + (isMp4 ? ".mp4" : ".webm");
        if (!getSetting("autoCompress") || blob.size <= sizeLimit()) {
            download(blob, name, "");
            return;
        }
        if (!isMp4) {
            download(blob, name, ", over the size limit: only MP4 can be compressed");
            return;
        }
        compress(blob, name, function (e) {
            download(blob, name, ", not compressed: " + ((e && e.message) || e));
        });
    }

    function sizeLimit() {
        return Number(getSetting("sizeLimit")) * 1048576;
    }

    /** Fits `blob` under the size limit and saves the result as `name`;
     * `onFail` gets the error if that can't be done.
     * @param {Blob} blob @param {string} name @param {(e: any) => void} onFail */
    function compress(blob, name, onFail) {
        state = "compressing";
        compressText = "";
        setStatus("Compressing " + formatSize(blob.size) + " to fit " + getSetting("sizeLimit") + " MB");
        render();
        MOUSE.recompress
            .fitToSize(blob, sizeLimit(), function (/** @type {number} */ pass, /** @type {number} */ fraction) {
                compressText = (pass > 1 ? "pass " + pass + ", " : "") + Math.floor(fraction * 100) + "%";
                render();
            })
            .then(
                /** @param {{blob: Blob, height: number, scaled: boolean}} res */
                function (res) {
                    state = "idle";
                    download(
                        res.blob,
                        name,
                        ", from " + formatSize(blob.size) + (res.scaled ? " at " + res.height + "p" : ""),
                    );
                },
                /** @param {any} e */
                function (e) {
                    MOUSE.warn("recorder: compressing failed", e);
                    state = "idle";
                    onFail(e);
                    render();
                },
            );
    }

    // "Compress a file": the picker is a detached file input, opened from
    // the button's click so Chrome counts it as the user's own.
    const filePicker = document.createElement("input");
    filePicker.type = "file";
    filePicker.accept = "video/mp4,.mp4";
    filePicker.addEventListener("change", function () {
        const file = filePicker.files && filePicker.files[0];
        filePicker.value = "";
        if (!file || state !== "idle") return;
        if (file.size <= sizeLimit()) {
            setStatus(file.name + " is already under " + getSetting("sizeLimit") + " MB");
            return;
        }
        compress(file, file.name.replace(/\.[^.]*$/, "") + "-compressed.mp4", function (e) {
            setStatus("Couldn't compress " + file.name + ": " + ((e && e.message) || e));
        });
    });

    function chooseFile() {
        if (state !== "idle") {
            setStatus("Finish the current recording first");
            return;
        }
        filePicker.click();
    }

    /** @param {Blob} blob @param {string} name @param {string} note */
    function download(blob, name, note) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        // The download holds its own reference once it has started; the URL
        // only has to outlive that.
        setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 60000);
        setStatus("Saved " + name + " (" + formatSize(blob.size) + note + ")");
        render();
    }

    // A recording only exists in memory until it's saved. survev asks before
    // a reload only while in a match; this asks whenever one would be lost.
    window.addEventListener("beforeunload", function (e) {
        if (state !== "recording" && state !== "saving" && state !== "compressing") return;
        e.preventDefault();
        e.returnValue = "";
    });

    /** @param {Date} d */
    function timestamp(d) {
        const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
        return (
            d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
            "_" + p(d.getHours()) + "-" + p(d.getMinutes()) + "-" + p(d.getSeconds())
        );
    }

    /** @param {number} ms */
    function formatClock(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor(s / 60) % 60;
        const sec = String(s % 60).padStart(2, "0");
        return h ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
    }

    /** @param {number} n */
    function formatSize(n) {
        const mb = n / 1048576;
        if (mb < 1) return Math.max(1, Math.round(n / 1024)) + " KB";
        return mb < 1024 ? mb.toFixed(1) + " MB" : (mb / 1024).toFixed(2) + " GB";
    }

    // --- Window -------------------------------------------------------------
    const win = MOUSE.gui.createWindow({
        id: "recorder",
        title: "Recorder",
        width: 300,
        collapsible: true,
        // Right of the skin changer's default spot where the screen has room.
        defaultPos: { x: Math.max(0, Math.min(1160, window.innerWidth - 310)), y: 80 },
    });
    const bindField = MOUSE.gui.makeGenericBindField(getBind, setBind);
    bindField.title = "Record hotkey";
    win.controls.appendChild(bindField);
    MOUSE.gui.addToolBind(getBind, toggle);

    // The record button is a module row: the same button, lit the same cyan
    // while recording.
    const btn = document.createElement("div");
    btn.className = "module-row rec-btn";
    const dot = document.createElement("span");
    dot.className = "rec-dot";
    const btnLabel = document.createElement("div");
    btnLabel.className = "module-name";
    const clock = document.createElement("div");
    clock.className = "rec-clock";
    btn.appendChild(dot);
    btn.appendChild(btnLabel);
    btn.appendChild(clock);
    btn.addEventListener("click", toggle);
    win.body.appendChild(btn);

    const settingsEl = document.createElement("div");
    settingsEl.className = "rec-settings";
    for (const key in SETTINGS) {
        settingsEl.appendChild(
            MOUSE.gui.renderSettingRow(
                SETTINGS[key],
                () => getSetting(key),
                (v) => config.set(CONFIG_PATH + ".settings." + key, v),
            ),
        );
    }
    win.body.appendChild(settingsEl);

    const statusEl = document.createElement("span");
    win.footer.appendChild(statusEl);
    /** @param {string} text */
    function setStatus(text) {
        statusEl.textContent = text;
    }
    setStatus("Ready");

    const BUTTON_LABELS = {
        idle: "Record",
        asking: "Waiting for Chrome...",
        pausing: "Starting...",
        recording: "Recording",
        saving: "Saving...",
        compressing: "Compressing...",
    };
    function render() {
        btnLabel.textContent = BUTTON_LABELS[state];
        btn.classList.toggle("on", state === "recording");
        dot.classList.toggle("live", state === "recording");
        // Chrome's MP4 muxer hands over the file header on its own and then
        // a fragment every couple of seconds, so the size moves in steps
        // rather than with the clock.
        let clockText = "";
        if (state === "recording") {
            clockText = formatClock(performance.now() - startedAt);
            if (bytes) clockText += " · " + formatSize(bytes);
        } else if (state === "compressing") {
            clockText = compressText;
        }
        clock.textContent = clockText;
        btn.title = state === "recording" ? "Stop recording" : state === "pausing" ? "Cancel" : "";
    }
    render();

    MOUSE.log("recorder window mounted");
})();
