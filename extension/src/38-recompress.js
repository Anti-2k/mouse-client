// 38-recompress.js
//
// Shrinks a finished recording to fit a size limit - the recorder's "Size
// limit" setting (37-recorder.js). Exposes MOUSE.recompress.fitToSize and does
// nothing else on its own.
//
// It re-encodes only the video, at the bitrate that fills the limit, and
// keeps everything else from the original: its audio untouched, its frame
// timings, its track headers. The aim is "just under", not "as small as
// possible" - a 111 MB recording at a 100 MB limit should come out near
// 97 MB, not 11 - so each pass aims for TARGET_SHARE of the limit, and a pass
// that misses (over the limit, or far enough under it to be wasting quality)
// is redone with the bitrate scaled by how far off the encoder's rate
// control landed. Each pass decodes the whole recording again rather than
// keeping its frames, which at 1080p would be gigabytes.
//
// Chrome's software H.264 encoder has a quality floor: asked for 500 kbps on
// busy 720p60 it still gave 3.3 Mbps. So a long recording squeezed into a
// small limit can't get there on bitrate alone, and a pass that lands far
// over what it asked for shrinks the picture for the next one instead - the
// encoder scales each frame down to its configured size by itself.
//
// Built for exactly what Chrome's MediaRecorder writes in 37-recorder.js's
// MP4 formats: a fragmented MP4 (ftyp, moov, then moof+mdat pairs) with an
// H.264 `avc3` video track and an Opus or AAC audio track. The reader below
// handles fragmented MP4 in general rather than one byte layout, but WebM -
// the fallback for Chromium builds without H.264 - isn't handled at all.
//
// Everything runs through WebCodecs: VideoDecoder on the original samples,
// VideoEncoder at the new bitrate. The output is written as fresh fragments,
// one per keyframe (forced every KEY_INTERVAL_S), and the new encoder's
// SPS/PPS replace the old ones in the moov's avcC. The sample entry is
// `avc3`, so the parameter sets also stay in-band at every keyframe, which
// is what lets a mid-recording resize (fullscreen, resizing the window)
// re-encode as a new size rather than corrupting everything after it.

(function () {
    "use strict";

    /** @type {any} */
    const w = window;
    const MOUSE = w.__MOUSE;

    if (MOUSE.disabled) return;

    /** What a pass aims for, as a share of the limit. The rest is headroom
     * for the encoder's rate control overshooting. */
    const TARGET_SHARE = 0.97;
    /** A result under this share of the limit is redone at a higher bitrate,
     * since it's thrown away quality the limit had room for. */
    const LOW_SHARE = 0.9;
    const MAX_PASSES = 4;
    /** A pass whose video came out this far over what it asked for means the
     * encoder is at its quality floor, not missing the bitrate. */
    const FLOOR_SLACK = 1.1;
    /** Shrinking the picture to fit stops here. */
    const MIN_HEIGHT = 240;
    /** A forced keyframe this often, for seeking and fragment boundaries. */
    const KEY_INTERVAL_S = 2;
    /** Below this the video would be unwatchable, so it isn't attempted. */
    const MIN_VIDEO_BPS = 150e3;
    /** Encoder codecs to try, best first: Main, then Constrained Baseline,
     * at level 5.2 so any size up to 4K60 is in range. Not High: its avcC
     * needs chroma fields that would mean parsing the SPS. */
    const ENCODE_CODECS = ["avc3.4D0034", "avc3.42E034"];

    // --- Reading ------------------------------------------------------------

    /** @typedef {{type: string, start: number, end: number, body: number}} Box */
    /** @typedef {{dts: number, dur: number, cto: number, flags: number, data: Uint8Array}} Sample */
    /**
     * @typedef {{
     *   id: number, timescale: number, handler: string,
     *   entry: Box | null, avcC: Box | null, path: Box[],
     *   defaults: {dur: number, size: number, flags: number},
     *   samples: Sample[],
     * }} Track
     */

    /** @param {Uint8Array} b @param {number} p */
    function fourcc(b, p) {
        return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    }

    /** @param {ArrayBuffer} buf */
    function parseMp4(buf) {
        const b = new Uint8Array(buf);
        const dv = new DataView(buf);

        /** @param {number} start @param {number} end @returns {Box[]} */
        function boxes(start, end) {
            const out = [];
            let p = start;
            while (p + 8 <= end) {
                let size = dv.getUint32(p);
                let header = 8;
                if (size === 1) {
                    size = Number(dv.getBigUint64(p + 8));
                    header = 16;
                } else if (size === 0) {
                    size = end - p;
                }
                // A recording cut off mid-box (the tab closing while it was
                // being written) ends at the last whole one.
                if (size < header || p + size > end) break;
                out.push({ type: fourcc(b, p + 4), start: p, end: p + size, body: p + header });
                p += size;
            }
            return out;
        }
        /** @param {Box | null} box @param {string} type @param {number} [skip] */
        function find(box, type, skip) {
            if (!box) return null;
            return boxes(box.body + (skip || 0), box.end).find((x) => x.type === type) || null;
        }
        /** @param {Box} box */
        const isV1 = (box) => b[box.body] === 1;

        const top = boxes(0, b.length);
        const ftyp = top.find((x) => x.type === "ftyp");
        const moov = top.find((x) => x.type === "moov");
        if (!ftyp || !moov) throw new Error("not an MP4 file");

        /** @type {Map<number, {dur: number, size: number, flags: number}>} */
        const trex = new Map();
        const mvex = find(moov, "mvex");
        if (mvex) {
            for (const x of boxes(mvex.body, mvex.end)) {
                if (x.type !== "trex") continue;
                trex.set(dv.getUint32(x.body + 4), {
                    dur: dv.getUint32(x.body + 12),
                    size: dv.getUint32(x.body + 16),
                    flags: dv.getUint32(x.body + 20),
                });
            }
        }

        /** @type {Map<number, Track>} */
        const tracks = new Map();
        for (const trak of boxes(moov.body, moov.end)) {
            if (trak.type !== "trak") continue;
            const tkhd = find(trak, "tkhd");
            const mdia = find(trak, "mdia");
            const mdhd = find(mdia, "mdhd");
            const hdlr = find(mdia, "hdlr");
            const minf = find(mdia, "minf");
            const stbl = find(minf, "stbl");
            const stsd = find(stbl, "stsd");
            if (!tkhd || !mdia || !mdhd || !hdlr || !minf || !stbl || !stsd) continue;
            const id = dv.getUint32(tkhd.body + (isV1(tkhd) ? 20 : 12));
            const entry = boxes(stsd.body + 8, stsd.end)[0] || null;
            tracks.set(id, {
                id: id,
                timescale: dv.getUint32(mdhd.body + (isV1(mdhd) ? 20 : 12)),
                handler: fourcc(b, hdlr.body + 8),
                entry: entry,
                // A visual sample entry's child boxes start after its 78
                // bytes of fixed fields.
                avcC: entry && /^avc[13]$/.test(entry.type) ? find(entry, "avcC", 78) : null,
                path: entry ? [moov, trak, mdia, minf, stbl, stsd, entry] : [],
                defaults: trex.get(id) || { dur: 0, size: 0, flags: 0 },
                samples: [],
            });
        }

        // Samples, resolved to absolute timings, flags and bytes. Field
        // presence follows the tfhd/trun flag bits; whatever a trun leaves
        // out falls back to its tfhd, then the track's trex.
        /** @type {Map<number, number>} */
        const nextDts = new Map();
        for (const moof of top) {
            if (moof.type !== "moof") continue;
            // Where a traf's data starts when its tfhd says nothing: the moof
            // for the first, the end of the previous traf's data after that.
            let prevEnd = moof.start;
            for (const traf of boxes(moof.body, moof.end)) {
                if (traf.type !== "traf") continue;
                const tfhd = find(traf, "tfhd");
                const track = tfhd && tracks.get(dv.getUint32(tfhd.body + 4));
                if (!tfhd || !track) continue;
                const hf = dv.getUint32(tfhd.body) & 0xffffff;
                let q = tfhd.body + 8;
                let base = hf & 0x20000 ? moof.start : prevEnd;
                if (hf & 0x1) {
                    base = Number(dv.getBigUint64(q));
                    q += 8;
                }
                if (hf & 0x2) q += 4;
                const def = Object.assign({}, track.defaults);
                if (hf & 0x8) { def.dur = dv.getUint32(q); q += 4; }
                if (hf & 0x10) { def.size = dv.getUint32(q); q += 4; }
                if (hf & 0x20) { def.flags = dv.getUint32(q); q += 4; }

                const tfdt = find(traf, "tfdt");
                let dts = nextDts.get(track.id) || 0;
                if (tfdt) dts = isV1(tfdt) ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);

                let pos = base;
                for (const trun of boxes(traf.body, traf.end)) {
                    if (trun.type !== "trun") continue;
                    const rf = dv.getUint32(trun.body) & 0xffffff;
                    const count = dv.getUint32(trun.body + 4);
                    let r = trun.body + 8;
                    if (rf & 0x1) { pos = base + dv.getInt32(r); r += 4; }
                    let firstFlags = -1;
                    if (rf & 0x4) { firstFlags = dv.getUint32(r); r += 4; }
                    for (let i = 0; i < count; i++) {
                        let dur = def.dur;
                        let size = def.size;
                        let flags = i === 0 && firstFlags !== -1 ? firstFlags : def.flags;
                        let cto = 0;
                        if (rf & 0x100) { dur = dv.getUint32(r); r += 4; }
                        if (rf & 0x200) { size = dv.getUint32(r); r += 4; }
                        if (rf & 0x400) { flags = dv.getUint32(r); r += 4; }
                        if (rf & 0x800) { cto = isV1(trun) ? dv.getInt32(r) : dv.getUint32(r); r += 4; }
                        if (pos + size > b.length) break;
                        track.samples.push({ dts: dts, dur: dur, cto: cto, flags: flags, data: b.subarray(pos, pos + size) });
                        dts += dur;
                        pos += size;
                    }
                }
                nextDts.set(track.id, dts);
                prevEnd = pos;
            }
        }

        // A regular MP4 keeps its samples in the moov's tables instead, which
        // this doesn't read - a file from somewhere other than the recorder.
        if (!top.some((x) => x.type === "moof")) throw new Error("only MP4s saved by this recorder can be compressed");
        return { b: b, ftyp: b.subarray(ftyp.start, ftyp.end), moov: moov, tracks: Array.from(tracks.values()) };
    }

    // --- H.264 framing ------------------------------------------------------

    /** @param {number} n */
    const hex = (n) => n.toString(16).padStart(2, "0").toUpperCase();

    /** SPS and PPS NAL units out of an AVCDecoderConfigurationRecord.
     * @param {Uint8Array} c */
    function avcCParamSets(c) {
        /** @type {Uint8Array[]} */
        const out = [];
        let p = 5;
        for (let set = 0; set < 2; set++) {
            const count = set === 0 ? c[p] & 0x1f : c[p];
            p++;
            for (let i = 0; i < count && p + 2 <= c.length; i++) {
                const len = (c[p] << 8) | c[p + 1];
                out.push(c.subarray(p + 2, p + 2 + len));
                p += 2 + len;
            }
        }
        return out;
    }

    /** @param {Uint8Array} sps @param {Uint8Array} pps */
    function buildAvcC(sps, pps) {
        const c = new Uint8Array(11 + sps.length + pps.length);
        c.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]);
        c.set(sps, 8);
        let p = 8 + sps.length;
        c.set([1, pps.length >> 8, pps.length & 0xff], p);
        c.set(pps, p + 3);
        return c;
    }

    /** @param {Uint8Array[]} nals @param {boolean} startCodes */
    function joinNals(nals, startCodes) {
        let size = 0;
        for (const n of nals) size += 4 + n.length;
        const out = new Uint8Array(size);
        const dv = new DataView(out.buffer);
        let p = 0;
        for (const n of nals) {
            dv.setUint32(p, startCodes ? 1 : n.length);
            out.set(n, p + 4);
            p += 4 + n.length;
        }
        return out;
    }

    /** Length-prefixed NAL units (MP4 samples) to a list.
     * @param {Uint8Array} d @param {number} lengthSize */
    function splitLengthPrefixed(d, lengthSize) {
        /** @type {Uint8Array[]} */
        const nals = [];
        let p = 0;
        while (p + lengthSize <= d.length) {
            let len = 0;
            for (let k = 0; k < lengthSize; k++) len = len * 256 + d[p + k];
            p += lengthSize;
            nals.push(d.subarray(p, p + len));
            p += len;
        }
        return nals;
    }

    /** Annex B (start-code separated, what the encoder emits) to a list.
     * Trailing zero bytes before a start code belong to it, not the NAL.
     * @param {Uint8Array} d */
    function splitAnnexB(d) {
        /** @type {Uint8Array[]} */
        const nals = [];
        let start = -1;
        for (let i = 0; i + 2 < d.length; i++) {
            if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 1) continue;
            if (start >= 0) {
                let end = i;
                while (end > start && d[end - 1] === 0) end--;
                nals.push(d.subarray(start, end));
            }
            start = i + 3;
            i += 2;
        }
        if (start >= 0) nals.push(d.subarray(start));
        return nals;
    }

    // --- Re-encoding --------------------------------------------------------

    /** @typedef {{pts: number, dur: number, key: boolean, data: Uint8Array}} OutFrame */

    /**
     * The first encoder codec and rate mode this browser takes at the
     * recording's size. Constant bitrate first: it lands nearer the target.
     * @param {number} width @param {number} height @param {number} bitrate @param {number} framerate
     */
    async function pickEncoder(width, height, bitrate, framerate) {
        for (const codec of ENCODE_CODECS) {
            for (const bitrateMode of ["constant", "variable"]) {
                const config = {
                    codec: codec,
                    width: width,
                    height: height,
                    bitrate: bitrate,
                    framerate: framerate,
                    bitrateMode: bitrateMode,
                    latencyMode: "quality",
                    avc: { format: "annexb" },
                };
                try {
                    const res = await w.VideoEncoder.isConfigSupported(config);
                    if (res.supported) return config;
                } catch (e) {
                    // An invalid combination throws rather than answering no.
                }
            }
        }
        throw new Error("no H.264 encoder available");
    }

    /**
     * One full decode and re-encode of the video track, with each side of
     * the picture scaled by `scale`.
     * @param {Track} video @param {any} baseConfig from pickEncoder
     * @param {number} bitrate @param {number} scale @param {(f: number) => void} onProgress
     * @returns {Promise<{frames: OutFrame[], sps: Uint8Array, pps: Uint8Array, bytes: number, height: number}>}
     */
    async function encodePass(video, baseConfig, bitrate, scale, onProgress) {
        const avcC = /** @type {Box} */ (video.avcC);
        const mp4b = video.samples[0].data;
        // The avcC record, read through the same buffer the samples view.
        const c = new Uint8Array(mp4b.buffer, avcC.body, avcC.end - avcC.body);
        const lengthSize = (c[4] & 3) + 1;
        const paramSets = avcCParamSets(c);

        // Microsecond timestamps back to the track's own units and durations.
        /** @type {Map<number, {pts: number, dur: number}>} */
        const byUs = new Map();

        /** @type {OutFrame[]} */
        const frames = [];
        let sps = /** @type {Uint8Array | null} */ (null);
        let pps = /** @type {Uint8Array | null} */ (null);
        let bytes = 0;
        /** @type {any} */
        let failure = null;

        /** @type {(() => void) | null} */
        let wake = null;
        const kick = () => {
            const f = wake;
            wake = null;
            if (f) f();
        };
        // ondequeue is the real signal; the timeout only covers a missed one.
        const idle = () =>
            new Promise((resolve) => {
                wake = /** @type {() => void} */ (resolve);
                setTimeout(kick, 50);
            });

        const encoder = new w.VideoEncoder({
            /** @param {any} chunk */
            output(chunk) {
                const raw = new Uint8Array(chunk.byteLength);
                chunk.copyTo(raw);
                // Access unit delimiters (type 9) carry nothing a player needs.
                const nals = splitAnnexB(raw).filter((n) => (n[0] & 0x1f) !== 9);
                for (const n of nals) {
                    if (!sps && (n[0] & 0x1f) === 7) sps = n.slice();
                    if (!pps && (n[0] & 0x1f) === 8) pps = n.slice();
                }
                const t = byUs.get(chunk.timestamp);
                if (!t) return;
                const data = joinNals(nals, false);
                frames.push({ pts: t.pts, dur: t.dur, key: chunk.type === "key", data: data });
                bytes += data.length;
            },
            /** @param {any} e */
            error(e) {
                failure = failure || e;
                kick();
            },
        });

        /** @type {any} */
        let config = null;
        let forceKey = true;
        let lastKeyUs = -Infinity;
        const decoder = new w.VideoDecoder({
            /** @param {any} frame */
            output(frame) {
                try {
                    if (failure) return;
                    // The encoder scales each frame to its configured size
                    // itself. H.264 wants that size even.
                    const width = Math.max(2, Math.round(frame.displayWidth * scale) & ~1);
                    const height = Math.max(2, Math.round(frame.displayHeight * scale) & ~1);
                    if (!config || config.width !== width || config.height !== height) {
                        config = Object.assign({}, baseConfig, { width: width, height: height, bitrate: bitrate });
                        encoder.configure(config);
                        forceKey = true;
                    }
                    const key = forceKey || frame.timestamp - lastKeyUs >= KEY_INTERVAL_S * 1e6;
                    encoder.encode(frame, { keyFrame: key });
                    if (key) lastKeyUs = frame.timestamp;
                    forceKey = false;
                } catch (e) {
                    failure = failure || e;
                } finally {
                    frame.close();
                }
            },
            /** @param {any} e */
            error(e) {
                failure = failure || e;
                kick();
            },
        });
        decoder.ondequeue = kick;
        encoder.ondequeue = kick;

        try {
            decoder.configure({ codec: "avc1." + hex(c[1]) + hex(c[2]) + hex(c[3]) });
            const samples = video.samples;
            let started = false;
            for (let i = 0; i < samples.length; i++) {
                if (failure) throw failure;
                const s = samples[i];
                const key = !(s.flags & 0x10000);
                // Decoding has to start on a keyframe.
                if (!started && !key) continue;
                const nals = splitLengthPrefixed(s.data, lengthSize);
                // The avcC's parameter sets ahead of the first frame, in case
                // the stream doesn't repeat them in-band.
                const data = joinNals(started ? nals : [...paramSets, ...nals], true);
                started = true;
                const pts = s.dts + s.cto;
                const us = Math.round((pts * 1e6) / video.timescale);
                byUs.set(us, { pts: pts, dur: s.dur });
                decoder.decode(new w.EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: us, data: data }));
                while (!failure && (decoder.decodeQueueSize > 2 || encoder.encodeQueueSize > 2)) await idle();
                if ((i & 15) === 0) onProgress(i / samples.length);
            }
            await decoder.flush();
            if (failure) throw failure;
            if (!config) throw new Error("no frames decoded");
            await encoder.flush();
            if (failure) throw failure;
        } finally {
            if (decoder.state !== "closed") decoder.close();
            if (encoder.state !== "closed") encoder.close();
        }
        if (!sps || !pps) throw new Error("encoder gave no SPS/PPS");
        frames.sort((a, b) => a.pts - b.pts);
        return { frames: frames, sps: sps, pps: pps, bytes: bytes, height: config.height };
    }

    // --- Writing ------------------------------------------------------------

    /** @param {Uint8Array} out @param {number} p @param {number} size @param {string} type */
    function writeHeader(out, p, size, type) {
        new DataView(out.buffer, out.byteOffset).setUint32(p, size);
        for (let k = 0; k < 4; k++) out[p + 4 + k] = type.charCodeAt(k);
    }

    /** The moov with the video's avcC swapped for the new encoder's, and
     * every box around it resized to match.
     * @param {Uint8Array} b @param {Box} moov @param {Track} video @param {Uint8Array} avcCBody */
    function patchMoov(b, moov, video, avcCBody) {
        const old = /** @type {Box} */ (video.avcC);
        const box = new Uint8Array(8 + avcCBody.length);
        writeHeader(box, 0, box.length, "avcC");
        box.set(avcCBody, 8);
        const delta = box.length - (old.end - old.start);
        const out = new Uint8Array(moov.end - moov.start + delta);
        out.set(b.subarray(moov.start, old.start), 0);
        out.set(box, old.start - moov.start);
        out.set(b.subarray(old.end, moov.end), old.start - moov.start + box.length);
        const dv = new DataView(out.buffer);
        for (const anc of video.path) {
            const at = anc.start - moov.start;
            const size = dv.getUint32(at);
            if (size < 8) throw new Error("64-bit box size in moov");
            dv.setUint32(at, size + delta);
        }
        // avc1 would forbid the in-band parameter sets a resize needs.
        const entry = /** @type {Box} */ (video.entry);
        writeHeader(out, entry.start - moov.start, dv.getUint32(entry.start - moov.start), "avc3");
        return out;
    }

    /** One moof+mdat holding a run of samples per track.
     * @param {number} seq @param {Array<{id: number, samples: Sample[]}>} runs */
    function fragment(seq, runs) {
        runs = runs.filter((r) => r.samples.length);
        // traf = header 8 + tfhd 16 + tfdt 20 + trun (20 + 16 per sample)
        let moofSize = 8 + 16;
        for (const r of runs) moofSize += 8 + 16 + 20 + 20 + 16 * r.samples.length;
        const moof = new Uint8Array(moofSize);
        const dv = new DataView(moof.buffer);
        writeHeader(moof, 0, moofSize, "moof");
        writeHeader(moof, 8, 16, "mfhd");
        dv.setUint32(20, seq);
        let p = 24;
        let offset = moofSize + 8;
        /** @type {Uint8Array[]} */
        const data = [];
        for (const r of runs) {
            const n = r.samples.length;
            writeHeader(moof, p, 8 + 16 + 20 + 20 + 16 * n, "traf");
            writeHeader(moof, p + 8, 16, "tfhd");
            dv.setUint32(p + 16, 0x020000); // default-base-is-moof
            dv.setUint32(p + 20, r.id);
            writeHeader(moof, p + 24, 20, "tfdt");
            dv.setUint32(p + 32, 0x01000000); // version 1: 64-bit time
            dv.setBigUint64(p + 36, BigInt(r.samples[0].dts));
            writeHeader(moof, p + 44, 20 + 16 * n, "trun");
            // version 1 (signed offsets); data offset, then per-sample
            // duration, size, flags and composition offset.
            dv.setUint32(p + 52, 0x01000f01);
            dv.setUint32(p + 56, n);
            dv.setInt32(p + 60, offset);
            p += 64;
            for (let i = 0; i < n; i++) {
                const s = r.samples[i];
                // A trun only has durations, so each one runs to the next
                // sample's time: Chrome's own fragments leave small gaps
                // between them, which would otherwise close up here and pull
                // everything after them early.
                dv.setUint32(p, i + 1 < n ? r.samples[i + 1].dts - s.dts : s.dur);
                dv.setUint32(p + 4, s.data.length);
                dv.setUint32(p + 8, s.flags);
                dv.setInt32(p + 12, s.cto);
                p += 16;
                offset += s.data.length;
                data.push(s.data);
            }
        }
        const mdat = new Uint8Array(8);
        writeHeader(mdat, 0, offset - moofSize, "mdat");
        return [moof, mdat, ...data];
    }

    /** @param {ReturnType<typeof parseMp4>} mp4 @param {Track} video
     * @param {Track | null} audio @param {Awaited<ReturnType<typeof encodePass>>} pass */
    function writeMp4(mp4, video, audio, pass) {
        /** @type {BlobPart[]} */
        const parts = [mp4.ftyp, patchMoov(mp4.b, mp4.moov, video, buildAvcC(pass.sps, pass.pps))];
        /** @type {Sample[]} */
        const vs = pass.frames.map((f) => ({
            dts: f.pts,
            dur: f.dur,
            cto: 0,
            // sync: depends on nothing; otherwise depends on others, non-sync
            flags: f.key ? 0x02000000 : 0x01010000,
            data: f.data,
        }));
        const as = audio ? audio.samples : [];
        let ai = 0;
        let seq = 1;
        for (let i = 0; i < vs.length; ) {
            let j = i + 1;
            while (j < vs.length && !pass.frames[j].key) j++;
            // The audio that plays before the next keyframe goes with this
            // one; whatever runs past the last video goes in the last.
            const end = j < vs.length ? vs[j].dts / video.timescale : Infinity;
            const from = ai;
            while (ai < as.length && as[ai].dts / /** @type {Track} */ (audio).timescale < end) ai++;
            /** @type {Array<{id: number, samples: Sample[]}>} */
            const runs = [{ id: video.id, samples: vs.slice(i, j) }];
            if (audio) runs.push({ id: audio.id, samples: as.slice(from, ai) });
            for (const part of fragment(seq++, runs)) parts.push(/** @type {BlobPart} */ (part));
            i = j;
        }
        return new Blob(parts, { type: "video/mp4" });
    }

    // --- Entry point --------------------------------------------------------

    /**
     * Re-encodes an MP4 recording to fit in `limit` bytes. Rejects (and the
     * caller keeps the original) if it isn't an MP4 with H.264 video, if the
     * limit leaves too little for watchable video, or if no pass got under.
     * `height` is the result's (last) frame height, `scaled` whether that's
     * below the original's.
     * @param {Blob} blob
     * @param {number} limit
     * @param {(pass: number, fraction: number) => void} onProgress pass from 1
     * @returns {Promise<{blob: Blob, height: number, scaled: boolean}>}
     */
    async function fitToSize(blob, limit, onProgress) {
        if (typeof w.VideoEncoder !== "function" || typeof w.VideoDecoder !== "function") {
            throw new Error("this browser has no WebCodecs");
        }
        const mp4 = parseMp4(await blob.arrayBuffer());
        const video = mp4.tracks.find((t) => t.handler === "vide" && t.avcC && t.samples.length);
        if (!video) throw new Error("no H.264 video track");
        const audio = mp4.tracks.find((t) => t.handler === "soun" && t.samples.length) || null;

        const vs = video.samples;
        const first = vs[0];
        const last = vs[vs.length - 1];
        const seconds = (last.dts + last.dur - first.dts) / video.timescale;
        if (!(seconds > 0)) throw new Error("recording has no length");
        let sourceVideoBytes = 0;
        for (const s of vs) sourceVideoBytes += s.data.length;
        let audioBytes = 0;
        for (const s of audio ? audio.samples : []) audioBytes += s.data.length;
        // Everything but the video's own bytes: headers, the audio as it is,
        // 16 bytes of trun entry per sample, and each fragment's boxes.
        const sampleCount = vs.length + (audio ? audio.samples.length : 0);
        const fixed =
            mp4.ftyp.length + (mp4.moov.end - mp4.moov.start) + audioBytes +
            16 * sampleCount + 200 * (seconds / KEY_INTERVAL_S + 2);
        const videoBudget = limit * TARGET_SHARE - fixed;
        const sourceBitrate = (sourceVideoBytes * 8) / seconds;
        let bitrate = Math.min((videoBudget * 8) / seconds, sourceBitrate);
        if (bitrate < MIN_VIDEO_BPS) throw new Error("too long to fit in " + Math.round(limit / 1048576) + " MB");

        // The sample entry's size, for asking whether an encoder exists; the
        // real size comes from each decoded frame.
        const e = /** @type {Box} */ (video.entry);
        const dv = new DataView(mp4.b.buffer);
        const baseConfig = await pickEncoder(
            dv.getUint16(e.body + 24) & ~1 || 1280,
            dv.getUint16(e.body + 26) & ~1 || 720,
            Math.round(bitrate),
            Math.max(1, Math.round(vs.length / seconds)),
        );

        /** @type {{blob: Blob, height: number, scaled: boolean} | null} */
        let best = null;
        let scale = 1;
        for (let pass = 1; pass <= MAX_PASSES; pass++) {
            const out = await encodePass(video, baseConfig, Math.round(bitrate), scale, (f) => onProgress(pass, f));
            const blob = writeMp4(mp4, video, audio, out);
            MOUSE.log(
                "recompress: pass " + pass + " at " + Math.round(bitrate / 1000) + " kbps, " + out.height + "p -> " +
                    (blob.size / 1048576).toFixed(1) + " MB of " + (limit / 1048576).toFixed(0),
            );
            if (blob.size <= limit && (!best || blob.size > best.blob.size)) {
                best = { blob: blob, height: out.height, scaled: scale < 1 };
            }
            if (blob.size <= limit && blob.size >= limit * LOW_SHARE) break;
            // Under 1 when the video came out over budget, over 1 when under.
            const miss = videoBudget / Math.max(1, out.bytes);
            if (blob.size > limit && out.bytes > ((bitrate * seconds) / 8) * FLOOR_SLACK) {
                // The encoder hit its quality floor instead of following the
                // bitrate, so a lower one would change nothing: fewer pixels
                // instead. Size went with about pixels^0.66 in testing, so
                // each side shrinks by miss^0.75. Overdoing it costs little -
                // at a size where the encoder follows the bitrate again, the
                // result is the budget anyway.
                const next = scale * Math.pow(miss, 0.75);
                if (out.height * (next / scale) < MIN_HEIGHT) break;
                scale = next;
                continue;
            }
            // Rate control misses by a roughly steady factor, so scale by it.
            const next = Math.min(bitrate * miss, sourceBitrate);
            // Already at the source's own bitrate and still small: the
            // content just doesn't need more.
            if (blob.size <= limit && next <= bitrate) break;
            if (next < MIN_VIDEO_BPS) break;
            bitrate = next;
        }
        if (!best) throw new Error("couldn't get it under " + Math.round(limit / 1048576) + " MB");
        return best;
    }

    MOUSE.recompress = { fitToSize: fitToSize };
})();
