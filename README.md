# Mouse Client — survev.io

A legit version of a client for [survev.io](https://survev.io) (the open-source revival of surviv.io), built as an
unpacked Chromium extension. No build step, no bundler — it's plain JS that patches the game's own
bundle in your browser at load time.

**v1.0.0** — built and tagged against survev.io **v0.4.3** (build `6d25af64`). The main panel's
footer shows this tag live and flags it amber if the running game has moved past it — see
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) if that happens.

Built for Chromium-based browsers (Chrome, Edge, Brave, Opera, Vivaldi, ...), though it's only actually
been tested in Google Chrome itself. There are no plans to port it to Firefox-based browsers — the
Manifest V3 `world: "MAIN"` content-script option this relies on works differently there.

## What it does — and doesn't

Quality-of-life and cosmetic features, held to one line: **nothing here shows you what the normal
client hides, and nothing plays for you.** No seeing through walls, roofs or smoke, no extra view
distance, no aiming, clicking or looting on your behalf. See
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for the exact boundary.

A click-to-configure GUI (Right Shift to open), styled after survev's own menus:

- **Anti-Cosmetics** — shows every outfit and heal/boost particle as the plain default, and can skip
  the decorative melee pull-out/idle flourishes. Ghillie suits and role skins are left alone.
- **Null binds** — last-key-priority movement: tapping the opposite direction while holding one
  switches to it instead of stopping you dead.
- **Lag smoothing** — a jitter buffer that smooths out the freeze-then-crawl movement you get from
  late server updates. Render-side only.
- **Puzzle helper** — outlines the next step of a bunker or vault puzzle.
- **Health numbers**, **FPS / Ping** (with a ping graph and stall indicator) and **Match timers**
  (50v50 role promotions, Cobalt's twins bunker) — HUD readouts.

Plus two windows of their own:

- **Skin Changer** — revert guns to their older art, on your screen only.
- **Recorder** — records the tab to MP4 on its own hotkey.

Every module ships **off and unbound** — nothing does anything until you turn it on and, if you want,
give it a hotkey. Full description of what each one does and how: **[`docs/MODULES.md`](docs/MODULES.md)**.

## Install

Either way the extension is loaded unpacked, so **Developer mode** has to be on. Your settings live
in survev.io's own page storage rather than in the extension, so they survive updating or
reinstalling the client.

### From a release (recommended)

1. Download the latest `mouse-client-vX.Y.Z.zip` from the
   [Releases page](https://github.com/Anti-2k/mouse-client/releases).
2. Unzip it somewhere you'll keep it — the browser loads the extension from that folder every time it
   starts, so deleting or moving the folder removes the extension.
3. Open `chrome://extensions` (or your browser's equivalent — `edge://extensions`,
   `brave://extensions`, etc. all work the same way) and turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder (the one with `manifest.json` in it).

To update, unzip the new release over the same folder, click the reload icon on the extension's card
in `chrome://extensions`, and refresh any open survev.io tab.

### From source

1. Clone or download this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the
   `extension/` folder in this project.

After editing any file under `extension/src/`, reload the extension from `chrome://extensions` (the
reload icon on the card) and then refresh the survev.io tab — extension reloads don't re-inject into
already-open tabs.

### Checking it works

Open [survev.io](https://survev.io). Open DevTools (F12) and check the console — you should see a run
of `[mouse] ...` lines including `[mouse] bundle evaluated (2/2 anchors patched)` and
`[mouse] gui mounted (Right Shift to toggle)`. If both are there and there are no page errors,
everything is working.

## Usage

- **Right Shift** shows/hides every window together. This is the only bound key out of the box.
- Click a module's row to turn it on — it lights up while on. Click the chevron at the end of the
  row (or right-click the row) to open its settings; modules with nothing to configure have no chevron.
- Click a module's keycap (blank by default) and press any key or mouse button to give it a hotkey;
  Escape or Backspace while capturing clears it instead. A hotkey is additive — pressing it
  never blocks that key/click from also doing whatever it already does in the game.
- Drag any window by its header. Position, collapsed state, and every module's settings are saved
  automatically and restored on reload.
- There's also a master **Client enabled** On/Off switch in the main window's header, and a full kill
  switch (`?nomouse` on the URL, or `localStorage.setItem('mouseDisable', '1')`) for when you want the
  game completely untouched — see [`docs/MODULES.md`](docs/MODULES.md#turning-everything-off) for the
  difference between the two.

## Documentation

- **[`docs/MODULES.md`](docs/MODULES.md)** — what every module does and why it's built the way it is.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — how survev.io's bundle works under the hood,
  and the shared mechanisms the client is built on.
- **[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)** — what the client deliberately won't do, and known
  scope boundaries.
- **[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)** — what to check when a game update breaks
  something.
- **[`docs/SKINS.md`](docs/SKINS.md)** — the Skin Changer's per-gun version data: what's covered,
  what's missing, how to add a version.

## Contributing

There's no build step — edit a file under `extension/src/`, reload the extension, refresh the tab.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the project layout and how the pieces fit
together, and [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for the line every module has to stay
behind.

## License

[GPL-3.0](LICENSE), the same license as survev itself, whose gun art the Skin Changer's data is
derived from.
