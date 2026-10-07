# Known limitations

Scope boundaries and known gaps, not bugs — either deliberate or a hard limit of what the game
actually exposes to the client. If something here used to work and stopped, that's
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) instead.

## What this client will not do

Every module either changes how something is *drawn for you*, adds a readout of information the game
already has on screen or in its own debug HUD, or — in Null binds' case — withholds one of two keys
you are already holding. Nothing in this client:

- shows you anything the normal client hides (no seeing through walls, roofs or smoke, no extra view
  distance, no information about players you can't see),
- presses, clicks, aims or loots for you,
- sends anything to the server that your own inputs didn't produce.

New modules are held to the same line. That is a design boundary, not a promise about how any
particular server or community treats browser extensions — check survev.io's own rules if you are
unsure.

## Null binds

Null binds only acts on keys that go through the game's keybinds. survev also has an
unbound-arrow-key movement fallback that reads the keyboard directly; if your move binds aren't the
arrow keys, the arrow keys still move you and aren't covered.

## Lag smoothing

- Only player positions are buffered. Loot, projectiles and the gas keep the game's own
  interpolation, and facing direction is never touched.
- It draws everyone slightly further in the past than the game does, by design — that delay is what
  absorbs a late update. On a clean connection the adaptive buffer shrinks to almost nothing.
- Your own inputs reach the server exactly as fast as before; "Smooth own player" only changes how
  you and the camera are drawn.

## Skin Changer

- Only covers guns, and only sprites that actually changed at some point (see [SKINS.md](SKINS.md)
  for exactly which guns/slots and why some are missing) — it doesn't touch melee weapons, throwables,
  gear, or outfits, and a gun that has always used the game's shared generic silhouette art (never
  gotten a unique model of its own) has nothing to revert.
- Picking a world skin for a pistol that can be dual-wielded applies to the dual version too. It has
  to: survev points several dual defs (deagle, flare gun, OT-38) at the single gun's world sprite
  rather than at art of their own, so one texture swap already reaches both hands. Loot icons are
  unaffected — single and dual always have separate icon art.

## Anti-Cosmetics

Ghillie suits and role-locked skins are never defaulted — see [MODULES.md](MODULES.md#anti-cosmetics)
for why. That's deliberate, not a gap.

## Recorder

- A recording only exists in the browser's memory until you stop it. Closing or reloading the tab
  mid-recording loses it; the page asks first while one is running.
- Chrome writes a fragmented MP4 with no length in its header. Browsers (and so Discord), mpv and VLC
  find the length and seek normally; a stricter player or editor may show no length, or refuse the
  `avc3` video or, on Linux, the Opus audio. Re-encoding the file fixes that. Playback in Windows'
  own Media Player hasn't been tested.
- Encoding runs on the same CPU as the game. If the game's frame rate drops while recording, lower
  Resolution or Frame rate.
- It records what's on screen, so anything the client draws is in the video unless **Client enabled**
  is off, and so are client windows opened mid-recording.
- Compressing only handles this recorder's own MP4s. A WebM recording (Chromium without H.264) is
  saved at full size, and **Compress a file** refuses regular MP4s from other software (OBS, phones),
  which keep their samples in a layout it doesn't read.
- Compressing holds the original and the re-encoded copy in memory together and keeps the CPU busy
  while it runs, so it's best left to finish between matches.
- Below a certain bitrate, Chrome's H.264 encoder stops getting smaller, so a long recording squeezed
  into a small limit comes out at a lower resolution, down to 240p. Under that it gives up and saves
  the original.

## Match timers

Match timers' underlying `wait`/`circleIdx` numbers (50v50 promotions, Cobalt twins bunker) are
stripped from survev's own production client bundle and are hand-copied into `36-timerhud.js` from the
source instead of being read off a live object — update them by hand if a game update changes them.
