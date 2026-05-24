# Design — Ableton MCP Server

A local MCP server that lets Claude create tracks, load instruments, and write MIDI clips in Ableton Live 12.

> **Status**: implemented and shipping. Node/TypeScript MCP server, ~81 tools, distributed as a Claude plugin (Code + Desktop) and via `npx` for other MCP clients. This doc captures design decisions; install/usage lives in [README.md](README.md).

## Setup

- **Host**: macOS, Ableton Live 12 Suite (Intro/Standard ship without several instruments in the allowlist).
- **Bridge into Live**: [AbletonOSC](https://github.com/ideoforms/AbletonOSC) (Daniel Jones / ideoforms, MIT-licensed). A Remote Script that exposes the Live Object Model over OSC on localhost. We maintain a standalone [fork](https://github.com/rohailaltaf/AbletonOSC) that adds handlers AbletonOSC doesn't ship (device loading, browser nodes, master track, arrangement writing, quantize, drum-pad introspection, clip automation). A **pinned copy of the fork is bundled** into this package (`vendor/AbletonOSC`, generated reproducibly by `scripts/vendor-remote-script.mjs`); the server checks its version on every launch and (re)installs it into Live's User Library, never clobbering a developer's `.git` checkout. This guarantees the MCP server and Remote Script stay in lockstep with no drift window.
- **MCP transport**: stdio. The MCP client (Claude Code, Claude Desktop, Cursor, …) launches the server as a child process. No network port.
- **Language**: Node/TypeScript, bundled to a single self-contained `dist/index.js` (esbuild) so it runs with zero installs. OSC is hand-rolled over Node's `dgram` (explicit int32/float32 typing to match AbletonOSC's wire format); chord symbols are parsed with [`tonal`](https://github.com/tonaljs/tonal). (A Python prototype came first; the Node rewrite is the shipping version, verified at full parity.)

## Architecture

```
MCP client ──stdio──▶ MCP server ──OSC──▶ AbletonOSC ──LOM──▶ Ableton Live
(Claude/Cursor/…)     (this repo)         (in Live)
```

Four processes, three transports. This repo is the second box — the only piece we author (plus the bundled Remote Script fork).

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
| `list_scenes / create_scene / duplicate_scene / rename_scene / delete_scene` | shipped | Scene CRUD over stock `/live/song/{create,delete,duplicate}_scene`, `/live/song/get/num_scenes`, and `/live/scene/{get,set}/name`. No fork change — all endpoints ship with upstream AbletonOSC. |
| `set_tempo(bpm)` | shipped | Set the project tempo via `/live/song/set/tempo`. Validates 20-999 BPM. |
| `list_tracks()` | shipped | Iterates `num_tracks` queries to collect name/has_midi_input/num_devices per track. State-visibility primitive. |
| `list_clips(track_index)` | shipped | Iterates clip slots; queries `has_clip` + `name` + `length` per occupied slot. |
| `get_track_devices(track_index)` | shipped | Wraps `/live/track/get/num_devices` + `devices/{name,type,class_name}` lists. |
| `set_track_volume / set_track_pan / set_track_mute / set_track_solo` | shipped | Mixer wrappers around `/live/track/set/{volume,panning,mute,solo}`. Fire-and-forget. |
| `get_device_parameters(track_index, device_index)` | shipped | Lists each parameter's name/value/min/max/is_quantized for sound design. |
| `set_device_parameter(track_index, device_index, parameter_index, value)` | shipped | Single-parameter setter; LLM should call `get_device_parameters` first to discover indices and ranges. |
| `list_audio_effects(path?)` | shipped | Walks `app.browser.audio_effects` by path. Wraps `/live/browser/list_audio_effects`. |
| `load_audio_effect(track_index, effect_path)` | shipped | Appends an audio effect to a track's device chain via `/live/track/load_audio_effect`. Polls `num_devices` to confirm. |
| `list_midi_effects(path?)` | shipped | Walks `app.browser.midi_effects` by path. Wraps our fork's `/live/browser/list_midi_effects`. |
| `load_midi_effect(track_index, effect_path)` | shipped | Loads a MIDI effect onto a MIDI track via `/live/track/load_midi_effect` (Live inserts ahead of the instrument). Polls `num_devices` to confirm. |
| `start_playing / stop_playing / continue_playing` | shipped | Global transport via `/live/song/{start,stop,continue}_playing`. Fire-and-forget. |
| `get_sidechain_sources / get_sidechain_channels` | shipped | Wraps `/live/device/get/available_input_routing_{types,channels}` from our fork. Returns lists of display names available on a Compressor/Gate/Vocoder/etc. |
| `set_sidechain_source / set_sidechain_channel` | shipped | Wraps `/live/device/set/input_routing_{type,channel}`. Looks up the source by display name and binds it. To actually hear pumping, also set the device's `S/C On` parameter via `set_device_parameter`. |
| `list_return_tracks / create_return_track` | shipped | Walks `song.return_tracks` via our fork's `/live/song/get/{num_return_tracks,return_tracks/name}`. `create_return_track` queries the count before to compute the new index (since AbletonOSC's `create_return_track` is fire-and-forget). |
| `load_audio_effect_on_return / set_send / get_sends` | shipped | Wraps our fork's `/live/return_track/load_audio_effect` and stock `/live/track/{set,get}/send`. Enables the classic shared-reverb-bus mixing pattern. |
| `load_audio_effect_on_master / get_master_devices / get,set_master_device_parameter / get,set_master_volume` | shipped | Master (Main) track support via our fork's `/live/master_track/*`. The Main track is `song.master_track` — OUTSIDE `song.tracks`, so regular track/device tools can't reach it. Enables mastering (Glue Compressor → Limiter on the final bus) + output level. |
| `get_notes / add_notes_to_clip / remove_notes` | shipped | Clip note read / append / range-delete. Wraps stock `/live/clip/{get,add,remove}/notes`. Default ranges in get/remove mean "all notes". Enables iterative pattern editing without delete+recreate. |
| `list_samples / load_sample` | shipped | Walks `app.browser.samples` via our fork's `/live/browser/list_samples` and `/live/track/load_sample`. Live wraps loaded samples in Simpler automatically so MIDI plays them transposed. `list_samples` is paginated (reply byte-capped to UDP MTU; `total_count` returned so callers can scroll). |
| `load_sample_to_drum_pad` | shipped | Loads a sample onto a specific Drum Rack pad via `/live/track/load_sample_to_drum_pad`. Sets `device.view.selected_drum_pad` before `app.browser.load_item` so Live drops the sample on the chosen pad. Lets the LLM swap or build kits one pad at a time on top of any existing Drum Rack. |
| `list_packs / list_plugins / list_user_library / list_sounds / list_browser_clips / list_max_for_live / list_current_project` | shipped | The rest of Live's `Application.Browser` tree, via a generic byte-capped+paginated fork lister (`/live/browser/list_<node>`). MCP side auto-paginates. `grooves`/`templates` aren't real browser nodes in Live 12 (omitted). Drum-browser listing (`list_drum_kits`) is also byte-capped+paginated now (big packs overflowed the UDP MTU). |
| `list_drum_pads(track_index, device_index)` | shipped | Lists a Drum Rack's populated pads (note + name) via our fork's `/live/device/get/drum_pads`. Pairs with `load_sample_to_drum_pad` so the LLM can introspect a kit before swapping a drum, instead of loading blind. |
| `automate_device_parameter / automate_mixer_parameter / clear_clip_envelopes` | shipped | Step-style clip automation via our fork's `/live/clip/automate_{device,mixer}_parameter` and `/live/clip/clear_envelopes`. Live's `AutomationEnvelope.insert_step` is the only public knob for writing envelopes (no native breakpoint-with-curve), so smooth ramps are approximated with many small adjacent steps. Envelopes loop with the clip. The fork's write path uses `create_automation_envelope` on first-write and calls `parameter.re_enable_automation()` after so per-parameter auto-disable doesn't swallow our envelope. |
| `re_enable_automation()` | shipped | Song-wide wrapper for `/live/song/re_enable_automation`. Rarely needed since the automate_* tools re-enable per-parameter, but useful as a "fix it" button after manual UI tweaks. |
| `delete_track(track_index)` | shipped | Delete a track via `/live/song/delete_track`. Destructive, Undo-able in Live. |
| `delete_device(track_index, device_index)` | shipped | Delete a device via `/live/track/delete_device`. Pairs with `load_instrument` for swap workflows. |
| `chord_progression(track_index, clip_slot, chords, rhythm?, name?, velocity?, octave?, voicing?)` | shipped | Higher-level helper. Parses chord symbols via `tonal` and delegates to `create_clip`. `voicing="smooth"` (default) applies voice-leading; `voicing="root"` keeps root position. Rhythm defaults to one-chord-per-bar if omitted. |

### Conventions

- **Pitch**: MIDI note numbers, 0–127. `60 = C4` (Ableton convention; some DAWs call this C3).
- **Velocity**: integer 1–127. 0 means note-off and is rejected.
- **Time**: beats from clip start, not project position. Floats accepted; rounded to 1e-6 before sending to avoid LOM denormal issues.
- **Note shape**: `{pitch: int, start_beat: float, duration_beat: float, velocity: int}`.
- **`clip_slot` collision**: if the slot already contains a clip, the tool returns an error. No overwrite, no auto-pick.

### Instrument allowlist

`load_instrument` resolves a short identifier to the exact top-level item name under `app.browser.instruments`, then the fork's `/live/track/load_instrument` handler matches that name and calls `app.browser.load_item`. The map now covers the full top-level instrument set of a Live 12 Suite install:

- **Synths / modeling**: `operator`, `wavetable`, `drift`, `meld`, `analog`, `electric`, `tension`, `collision`
- **Samplers**: `simpler`, `sampler`, `impulse`, `drum_sampler`
- **Racks / routing**: `drum_rack` (empty — use `load_drum_kit` for a kit), `instrument_rack`, `external_instrument`
- **Drum Synths**: `ds_kick`, `ds_snare`, `ds_hh`, `ds_clap`, `ds_tom`, `ds_cymbal`, `ds_fm`, `ds_clang`

Each loads the default init patch. For named factory/user presets, use `load_preset` with a browser path (e.g. `Wavetable/Synth Lead/Big Pluck`). Adding more = extend `INSTRUMENT_MAP` with the exact browser name (verify via `list_presets("")`). Intro/Standard editions ship fewer instruments; a missing one just fails to load (the tool then times out with a clear error).

### Chord parsing

`chord_progression` uses [`tonal`](https://github.com/tonaljs/tonal) for symbol parsing (`Chord.get` for components, `Note.chroma` for pitch classes) — covers the common cases (maj/min/7/maj7/m7/dim/aug, slash chords, extensions). The original Python prototype used `pychord`; the smooth voice-leading algorithm is a verbatim port (including Python's round-half-to-even) so voicings are identical. Voicing defaults to `"smooth"`: the first chord is voiced close from the given octave, then each subsequent chord places every pitch class in the octave nearest the previous chord's centroid — common tones barely move and the progression stays in register. `"root"` preserves the original literal root-position behavior.

### Out of scope for MVP

- Time signature, playback position — `set_tempo`, `fire_scene`, and global transport (start/stop/continue) all shipped post-MVP
- User instrument libraries, third-party packs, M4L devices

### Live API ceilings (investigated — not buildable via the LOM)

These were scoped as candidate capabilities and ruled out after confirming the Live Object Model doesn't expose them (verified against AbletonOSC's comprehensive handler coverage, which mirrors the LOM):

- **Track grouping.** `Track.group_track` / `Track.is_grouped` / `ClipSlot.is_group_slot` are read-only — they tell you *which* group a track is in, but there is no method to *create* or dissolve a group. Grouping is a UI-only operation (Cmd+G).
- **Saving / loading / exporting Live Sets.** No `save` method exists on `Song` or `Application`. The LOM cannot save the set or open a different one.
- **Audio clips from a file.** `Song.create_audio_track` can make an empty audio track, but there is no API to drop an audio file into a Session slot as an audio clip — audio clips only come from recording. This is exactly why samples are shipped Simpler-wrapped on MIDI tracks.
- **Freeze / flatten tracks.** No LOM support of any kind.
- **Clip follow actions.** Live 12 removed `follow_action_a/b/enabled/time` from the `Clip` object (probed: `'Clip' object has no attribute ...`), so auto-advancing clips/scenes can't be scripted. (To build a fixed track instead, use Arrangement writing — see below.)

**Arrangement writing IS supported** (added post-MVP): `duplicate_clip_to_arrangement` stamps a Session clip onto the timeline at a beat position via `Track.duplicate_clip_to_arrangement` — the only LOM path to a linear arrangement (raw-note arrangement clips still aren't creatable). `list_arrangement_clips` reads the timeline back.
- **Smooth-curve automation breakpoints.** Live's API only exposes step envelopes natively; smooth ramps are approximated with many small adjacent steps (shipped).

## Constraints worth knowing

- **Live has no native API.** The only ways in are Remote Scripts (Python in Live) or Max for Live devices. AbletonOSC is the Remote Script — we do not reinvent it.
- **Instruments load by URI, not by name.** Hardcode the map. Wrong URI = silent failure or wrong device.
- **OSC is UDP.** No connection errors. The server pings `/live/test` lazily on the first tool call with a 500ms timeout and raises a clear error if Live isn't reachable. (Lazy rather than at-startup so the MCP client doesn't need Live running when it spawns the server — the user can start Live mid-session and the next tool call will succeed.)
- **Localhost-only.** Bridge on `127.0.0.1:11000`/`11001`. Stdio MCP transport has no listening port. Nothing reachable off-machine.
- **Live must be running** with AbletonOSC selected as the active Control Surface before any tool call works.

## Open decisions

- **Rhythm pattern shape for `chord_progression`**: explicit `(start_beat, duration_beat)` tuples vs named patterns (`"whole"`, `"quarter"`, `"comping"`). Lean explicit tuples for v0.1, named patterns later.
- **Voicing**: ~~root position only for v0.1. Voice-leading is a v0.2 question.~~ Resolved — `voicing="smooth"` (centroid-anchored voice-leading) is now the default; `voicing="root"` retained for the original behavior.

## Related work

Other Ableton MCP projects exist (e.g. Siddharth Ahuja's `ableton-mcp`). This project differentiates on the AbletonOSC-based approach, breadth of scope (~81 tools), and the chord/voice-leading helper. The README credits prior art in its License & credits section.

## Design provenance

These decisions came out of a design conversation in claude.ai chat before this repo had any code. The non-obvious calls — using AbletonOSC instead of writing a custom Remote Script, choosing stdio over HTTP, scoping MVP to four tools — are explained in that conversation. If you change any of them, write down why.
