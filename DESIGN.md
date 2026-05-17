# Design — Ableton MCP Server

A local MCP server that lets Claude create tracks, load instruments, and write MIDI clips in Ableton Live 12.

> **Status**: pre-release, no implementation yet. This doc captures the design decisions. User-facing install/usage lives in [README.md](README.md).

## Setup

- **Host**: macOS, Ableton Live 12 Suite (Intro/Standard ship without several instruments in the allowlist).
- **Bridge into Live**: [AbletonOSC](https://github.com/ideoforms/AbletonOSC) (Daniel Jones, MIT-licensed). A Remote Script that exposes the Live Object Model over OSC on localhost. We use a [fork](https://github.com/rohailaltaf/AbletonOSC) because AbletonOSC doesn't ship handlers for some operations we need (notably device loading). The fork's `master` accumulates each handler we add (merged with `--no-ff`); each addition also lives on its own `feat/<name>` branch indefinitely so it can be PR'd upstream as a single coherent change whenever we choose.
- **MCP transport**: stdio. Claude Desktop launches the server as a child process. No network port.
- **Language**: Python. Same language as AbletonOSC, mature MCP SDK, `python-osc` for the bridge call.

## Architecture

```
Claude Desktop ──stdio──▶ MCP server ──OSC──▶ AbletonOSC ──LOM──▶ Ableton Live
                          (this repo)         (in Live)
```

Four processes, three transports. This repo is the second box — the only piece we author.

The MCP server speaks OSC bidirectionally: it sends commands to `127.0.0.1:11000` and binds a UDP listener on `127.0.0.1:11001` to receive replies. Not pure fire-and-forget.

## MVP scope (v0.1)

Four tools. The first three are LOM-thin; the fourth is the LLM-friendly helper.

| Tool | Status | Purpose |
|---|---|---|
| `create_midi_track(name?)` | shipped | Add a MIDI track. Returns track index. |
| `load_instrument(track_index, instrument)` | shipped | Load a built-in Live instrument. `instrument` is one of the allowlist keys (see below); we resolve to the browser name and call our fork's `/live/track/load_instrument`. Loads the default init patch only. |
| `list_presets(path?)` | shipped | List instrument-browser child names at a slash-separated path. Wraps `/live/browser/list_instrument_presets`. |
| `load_preset(track_index, preset_path)` | shipped | Load any item under `app.browser.instruments` by path (e.g. `Wavetable/Synth Lead/Big Pluck`). Polls `num_devices` to confirm. Wraps `/live/track/load_instrument_preset`. |
| `list_drum_kits(path?)` | shipped | Walks `app.browser.drums` by path. Wraps `/live/browser/list_drum_kits`. |
| `load_drum_kit(track_index, kit_path)` | shipped | Load a Drum Rack kit by path under `app.browser.drums`. Returns a Drum Rack with pads mapped to standard MIDI notes. Wraps `/live/track/load_drum_kit`. |
| `create_clip(track_index, clip_slot, length_bars, notes, name?)` | shipped | Create a Session-view MIDI clip and write notes. Validates pitch/velocity/timing per the conventions below; rejects on slot collision; assumes 4/4 time. |
| `play_clip(track_index, clip_slot)` | shipped | Fire a Session view clip (`/live/clip_slot/fire`). Fire-and-forget. |
| `stop_clip(track_index, clip_slot)` | shipped | Stop a Session view clip (`/live/clip/stop`). Fire-and-forget. |
| `delete_clip(track_index, clip_slot)` | shipped | Delete a clip via `/live/clip_slot/delete_clip`. Pairs with `create_clip` for replace-in-place. |
| `fire_scene(scene_index)` | shipped | Fire all clips in a scene via `/live/scene/fire`. Locks downbeats across tracks. |
| `set_tempo(bpm)` | shipped | Set the project tempo via `/live/song/set/tempo`. Validates 20-999 BPM. |
| `list_tracks()` | shipped | Iterates `num_tracks` queries to collect name/has_midi_input/num_devices per track. State-visibility primitive. |
| `list_clips(track_index)` | shipped | Iterates clip slots; queries `has_clip` + `name` + `length` per occupied slot. |
| `get_track_devices(track_index)` | shipped | Wraps `/live/track/get/num_devices` + `devices/{name,type,class_name}` lists. |
| `set_track_volume / set_track_pan / set_track_mute / set_track_solo` | shipped | Mixer wrappers around `/live/track/set/{volume,panning,mute,solo}`. Fire-and-forget. |
| `get_device_parameters(track_index, device_index)` | shipped | Lists each parameter's name/value/min/max/is_quantized for sound design. |
| `set_device_parameter(track_index, device_index, parameter_index, value)` | shipped | Single-parameter setter; LLM should call `get_device_parameters` first to discover indices and ranges. |
| `list_audio_effects(path?)` | shipped | Walks `app.browser.audio_effects` by path. Wraps `/live/browser/list_audio_effects`. |
| `load_audio_effect(track_index, effect_path)` | shipped | Appends an audio effect to a track's device chain via `/live/track/load_audio_effect`. Polls `num_devices` to confirm. |
| `start_playing / stop_playing / continue_playing` | shipped | Global transport via `/live/song/{start,stop,continue}_playing`. Fire-and-forget. |
| `delete_track(track_index)` | shipped | Delete a track via `/live/song/delete_track`. Destructive, Undo-able in Live. |
| `delete_device(track_index, device_index)` | shipped | Delete a device via `/live/track/delete_device`. Pairs with `load_instrument` for swap workflows. |
| `chord_progression(track_index, clip_slot, chords, rhythm?, name?, velocity?, octave?)` | shipped | Higher-level helper. Parses chord symbols via pychord, voices each in naïve root position from the given octave, and delegates to `create_clip`. Rhythm defaults to one-chord-per-bar if omitted. |

### Conventions

- **Pitch**: MIDI note numbers, 0–127. `60 = C4` (Ableton convention; some DAWs call this C3).
- **Velocity**: integer 1–127. 0 means note-off and is rejected.
- **Time**: beats from clip start, not project position. Floats accepted; rounded to 1e-6 before sending to avoid LOM denormal issues.
- **Note shape**: `{pitch: int, start_beat: float, duration_beat: float, velocity: int}`.
- **`clip_slot` collision**: if the slot already contains a clip, the tool returns an error. No overwrite, no auto-pick.

### Instrument allowlist (v0.1)

Live's LOM loads devices by browser URI, not by name. Hand-maintained map of Live 12 Suite built-ins:

`operator`, `wavetable`, `drift`, `meld`, `analog`, `electric`, `tension`, `simpler`, `collision`

Each maps to a verified browser path. Adding instruments = extending this map after testing the URI.

### Chord parsing

`chord_progression` uses [`pychord`](https://github.com/yuma-m/pychord) for symbol parsing. Lighter than music21, covers the common cases (maj/min/7/maj7/m7/dim/aug, slash chords, extensions). Voicing is naïve root-position for v0.1.

### Out of scope for MVP

- Audio tracks, audio clips, audio routing
- Effects, device chains beyond the instrument slot
- Time signature, full transport control (play/stop/position) — though `set_tempo` and `fire_scene` shipped post-MVP
- Saving, loading, or exporting project files
- User instrument libraries, third-party packs, M4L devices

## Constraints worth knowing

- **Live has no native API.** The only ways in are Remote Scripts (Python in Live) or Max for Live devices. AbletonOSC is the Remote Script — we do not reinvent it.
- **Instruments load by URI, not by name.** Hardcode the map. Wrong URI = silent failure or wrong device.
- **OSC is UDP.** No connection errors. The server pings `/live/test` lazily on the first tool call with a 500ms timeout and raises a clear error if Live isn't reachable. (Lazy rather than at-startup so Claude Desktop doesn't need Live running when it spawns the server — the user can start Live mid-session and the next tool call will succeed.)
- **Localhost-only.** Bridge on `127.0.0.1:11000`/`11001`. Stdio MCP transport has no listening port. Nothing reachable off-machine.
- **Live must be running** with AbletonOSC selected as the active Control Surface before any tool call works.

## Open decisions

- **Rhythm pattern shape for `chord_progression`**: explicit `(start_beat, duration_beat)` tuples vs named patterns (`"whole"`, `"quarter"`, `"comping"`). Lean explicit tuples for v0.1, named patterns later.
- **Voicing**: root position only for v0.1. Voice-leading is a v0.2 question.

## Related work

Other Ableton MCP projects exist (e.g. Siddharth Ahuja's `ableton-mcp`). Audit before public release and either differentiate (AbletonOSC-based approach, scope, chord helper) or consider contributing upstream. Add a "Related work" section to README before going public.

## Design provenance

These decisions came out of a design conversation in claude.ai chat before this repo had any code. The non-obvious calls — using AbletonOSC instead of writing a custom Remote Script, choosing stdio over HTTP, scoping MVP to four tools — are explained in that conversation. If you change any of them, write down why.
