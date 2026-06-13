---
name: mastering-chain
description: Master the current Ableton Live set — build a Glue Compressor → (EQ Eight) → Limiter chain on the Main track with conservative, streaming-safe settings. Use when the user asks to master the track, finish/polish the mix, "make it louder", add glue/punch to the whole mix, or prepare the song for export or streaming.
---

# Mastering chain (Main track)

Build a conservative mastering chain on the Main track. Goal: glue + perceived
loudness without audible pumping or clipping. When in doubt, do less.

## 1. Pre-flight — always do this first

1. `get_master_devices` — see what's already on the Main track.
   - If a Limiter (or Glue Compressor) is already loaded, **adjust it instead of
     stacking a second one**. Never end up with two limiters.
2. `get_master_volume` — set to ~0.85 (unity / 0 dB) via `set_master_volume` if
   it's been pushed higher. Loudness must come from the limiter's Input Gain,
   not the master fader.
3. If the mix is playing, spot-check the loudest tracks with `get_track_state`:
   `output_meter_level` pinned above ~0.95 means the mix itself is too hot —
   pull those track volumes down before mastering. Mastering cannot fix a
   clipping mix bus.

## 2. Choose the devices — don't reflexively reach for stock

Each chain stage is a *role* (glue compressor, EQ, limiter), not a fixed
device. Pick the best available tool for each role before loading:

1. **Check what the user owns.** `list_plugins` for third-party mastering
   plugins (FabFilter Pro-L/Pro-C/Pro-Q, iZotope Ozone, Waves, etc.).
2. **Honor an explicit request.** If the user named a plugin ("master with
   Ozone", "use Pro-L 2"), use it — find it via `list_plugins` and load it
   with `load_browser_item_on_master(node='plugins', path=...)`.
3. **Otherwise prefer the user's plugins over stock when one clearly fits the
   role** (same principle as preferring packs over stock instruments — it's
   what keeps results from sounding like default Ableton). A dedicated
   mastering limiter like Pro-L beats stock Limiter when present.
4. **Match the genre when choosing between options:**
   - EDM / pop / anything needing max loudness → transparent brickwall
     limiter (Pro-L, or stock Limiter pushed).
   - Hip-hop / lo-fi / rock → favor *character*: glue compression and a
     touch of saturation over clinical transparency.
   - Acoustic / jazz / classical → minimal: gentle glue, little to no
     limiting, preserve dynamics. Consider skipping the limiter.
5. **When two options are equally valid and the user gave no preference,
   briefly say which you're choosing and why** (one line) rather than
   silently picking.

If the user has no relevant plugins, **stock is a perfectly good default** —
Glue Compressor + Limiter (+ EQ Eight when needed). Don't apologize for it.

**Loading:**
- Stock Live effects → `load_audio_effect_on_master("Glue Compressor")` etc.
- Third-party plugins / saved racks → `load_browser_item_on_master`.
- Load in chain order, last device = the limiter (brickwall goes last).
- Re-run `get_master_devices` after each load — indices shift as devices are
  added, and you need the real index for the parameter calls below.
- Loaded the wrong device? `delete_master_device(device_index)` removes it.

## 3. Settings — find parameters BY NAME, never by assumed index

For each device: `get_master_device_parameters(device_index)`, locate the
parameter by its `name`, and use its reported `min`/`max` to choose values
(values are in device-native units; re-read after setting to confirm it took).

**Stock devices** have clean, stable parameter names (below). **Third-party
plugins do not** — their host-exposed parameter names vary, are sometimes
cryptic, and occasionally not all controls are exposed. For a third-party
plugin: call `get_master_device_parameters` to see what it actually exposes,
set only the parameters you can confidently identify (e.g. a clearly-named
"Gain"/"Ceiling"/"Threshold"), and otherwise **trust the plugin's own
defaults** rather than guessing — then tell the user to fine-tune in the
plugin UI. Don't blindly set parameters by position on a plugin.

**Glue Compressor** (gentle glue, not squash):
- `Ratio` → lowest available (2:1)
- `Attack` → slow side (the 10–30 ms region of its range) so transients punch through
- `Release` → auto/medium (upper end of the dial is Auto)
- `Threshold` → lower it only until the mix just "grips" — aim for ~1–2 dB of
  gain reduction, which usually means staying in the upper third of its range
- `Dry/Wet` → leave at 1.0; `Peak Clip In` → leave off

**EQ Eight** (only when needed):
- Band 1 (`1 Filter Type A` / `1 Frequency A`): high-pass around 25–30 Hz to
  clear inaudible sub-rumble and reclaim limiter headroom
- Leave every other band flat unless the user asked for a tonal change

**Limiter**:
- `Ceiling` → -0.3 dB (use -1.0 dB if the user mentions streaming platforms)
- `Input Gain` → raise for loudness; +2 to +4 dB is the normal range.
  **Ask before pushing past +4 dB** — beyond that, pumping and distortion are
  a taste decision the user should own.

## 4. Verify & report

- `get_master_devices` — confirm final order: Glue → (EQ) → Limiter.
- Report the chain and the actual settings you landed on, in dB terms.
- Remind the user that each step is individually Undo-able (Cmd+Z).

## Pitfalls

- **Reflexive stock devices** = sounds like default Ableton. Scan
  `list_plugins` and prefer the user's tools / genre-fit before defaulting.
- **Two limiters** = the classic mistake. Check before loading.
- **Master fader as loudness** — anything above ~0.85 boosts *into* the
  limiter and just trades headroom for distortion.
- **Indices go stale** — every `load_audio_effect_on_master` shifts them;
  re-list before setting parameters.
- **Over-compression** — if the user wants "more glue", lower Glue threshold in
  small steps; 3+ dB of constant gain reduction on a master is audible pumping.
