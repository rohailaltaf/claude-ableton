# claude-ableton

A local MCP server that lets [Claude](https://claude.ai) create tracks, load instruments, and write MIDI clips in Ableton Live 12.

> **Pre-release**: no working implementation yet. See [DESIGN.md](DESIGN.md) for the architecture and scope. The install instructions below describe the intended v0.1 flow.

## Compatibility

- macOS
- Ableton Live 12 **Suite** (Intro/Standard are missing several instruments in the allowlist)
- Claude Desktop

## Install

### 1. AbletonOSC (our fork)

This server talks to Live through [AbletonOSC](https://github.com/ideoforms/AbletonOSC), a Remote Script that exposes Live's Object Model over OSC. We use a [fork](https://github.com/rohailaltaf/AbletonOSC) that adds OSC handlers AbletonOSC doesn't ship with (e.g. `/live/track/load_instrument`). Each addition lives on its own feature branch so it can be PR'd upstream later — see [DESIGN.md](DESIGN.md).

```bash
mkdir -p ~/Music/Ableton/User\ Library/Remote\ Scripts
git clone https://github.com/rohailaltaf/AbletonOSC.git \
  ~/Music/Ableton/User\ Library/Remote\ Scripts/AbletonOSC
```

The fork's `master` accumulates each new handler we add. Individual `feat/<name>` branches live alongside it so each addition can be PR'd to upstream as a single coherent change.

Restart Live, then go to **Preferences → Link, Tempo & MIDI → Control Surface** and select **AbletonOSC**.

Smoke-test the bridge (TODO: ship `scripts/ping.py`):

```bash
python scripts/ping.py   # expects a reply from /live/test within 500ms
```

### 2. The MCP server

This project uses [uv](https://github.com/astral-sh/uv) to manage Python and dependencies.

```bash
brew install uv                      # or: curl -LsSf https://astral.sh/uv/install.sh | sh
git clone https://github.com/rohailaltaf/claude-ableton.git
cd claude-ableton
uv sync                              # installs Python 3.12 and dependencies into .venv
```

### 3. Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`, replacing the directory path with where you cloned the repo:

```json
{
  "mcpServers": {
    "ableton": {
      "command": "/opt/homebrew/bin/uv",
      "args": ["run", "--directory", "/absolute/path/to/claude-ableton", "claude-ableton"]
    }
  }
}
```

Restart Claude Desktop.

> Once the package is published to PyPI, this will simplify to `"command": "uvx", "args": ["claude-ableton"]`.

## Usage

With Live open and Claude Desktop running, try:

> "Create a MIDI track, load Wavetable on it, and write a four-bar Cmaj7 → Am7 → Fmaj7 → G7 progression in quarter notes."

## Tools

| Tool | Status | Purpose |
|---|---|---|
| `create_midi_track(name?)` | shipped | Add a MIDI track. |
| `load_instrument(track_index, instrument)` | shipped | Load a built-in Live instrument from the allowlist (default init patch). |
| `list_presets(path?)` | shipped | List child names in Live's instrument browser at a slash-separated path. |
| `load_preset(track_index, preset_path)` | shipped | Load a specific preset by browser path (e.g. `Wavetable/Synth Lead/Big Pluck`). |
| `list_drum_kits(path?)` | shipped | List child names in Live's drum browser at a slash-separated path. |
| `load_drum_kit(track_index, kit_path)` | shipped | Load a complete drum kit (Drum Rack with mapped samples) by browser path. |
| `create_clip(track_index, clip_slot, length_bars, notes, name?)` | shipped | Create a MIDI clip and write notes (Session view). |
| `play_clip(track_index, clip_slot)` | shipped | Fire a Session view clip. |
| `stop_clip(track_index, clip_slot)` | shipped | Stop a Session view clip. |
| `delete_clip(track_index, clip_slot)` | shipped | Delete a clip from a slot (destructive, Undo-able). |
| `fire_scene(scene_index)` | shipped | Fire all clips in a scene (row), locking multiple tracks to the same downbeat. |
| `set_tempo(bpm)` | shipped | Set the project tempo (20-999 BPM). |
| `list_tracks()` | shipped | List every track with index, name, MIDI/audio, device count. |
| `list_clips(track_index)` | shipped | List clip slots on a track with occupancy, name, length. |
| `get_track_devices(track_index)` | shipped | List devices on a track with index, name, type, class name. |
| `set_track_volume(track_index, volume)` | shipped | Set track volume (0.0–1.0; ~0.85 = 0 dB). |
| `set_track_pan(track_index, pan)` | shipped | Set track pan (-1.0 to 1.0). |
| `set_track_mute(track_index, mute)` | shipped | Mute/unmute a track. |
| `set_track_solo(track_index, solo)` | shipped | Solo/un-solo a track. |
| `get_device_parameters(track_index, device_index)` | shipped | List a device's parameters with current value + range. |
| `set_device_parameter(track_index, device_index, parameter_index, value)` | shipped | Set one device parameter by index. |
| `list_audio_effects(path?)` | shipped | List child names in Live's audio-effects browser at a slash-separated path. |
| `load_audio_effect(track_index, effect_path)` | shipped | Append an audio effect (reverb, delay, EQ, compressor, etc.) to a track's device chain. |
| `start_playing()` | shipped | Start global playback. |
| `stop_playing()` | shipped | Stop global playback. |
| `continue_playing()` | shipped | Resume playback from the current position. |
| `get_sidechain_sources(track_index, device_index)` | shipped | List sidechain source names available to a Compressor/Gate/Vocoder/etc. |
| `get_sidechain_channels(track_index, device_index)` | shipped | List sidechain channel tap points (Pre FX / Post FX / Post Mixer). |
| `set_sidechain_source(track_index, device_index, source)` | shipped | Set sidechain source by name (e.g. wire bass's Compressor to "Drums"). |
| `set_sidechain_channel(track_index, device_index, channel)` | shipped | Set sidechain channel tap point. |
| `list_return_tracks()` | shipped | List return tracks with index and name. |
| `create_return_track()` | shipped | Create a new return track; returns the new index. |
| `load_audio_effect_on_return(return_index, effect_path)` | shipped | Load an audio effect onto a return track (e.g. a Reverb on a shared bus). |
| `set_send(track_index, send_index, value)` | shipped | Set a track's send level (0.0–1.0) to a return track. |
| `get_sends(track_index)` | shipped | List a track's send levels to every return. |
| `get_notes(track_index, clip_slot, ...range)` | shipped | Read notes from an existing clip, optionally filtered by pitch/time range. |
| `add_notes_to_clip(track_index, clip_slot, notes)` | shipped | Add notes to an existing clip without removing what's there. |
| `remove_notes(track_index, clip_slot, ...range)` | shipped | Remove notes from a clip in a pitch/time range (default = all). |
| `delete_track(track_index)` | shipped | Delete a track (destructive, Undo-able). |
| `delete_device(track_index, device_index)` | shipped | Delete a device from a track (e.g. to swap instruments). |
| `chord_progression(track_index, clip_slot, chords, rhythm?, name?, velocity?, octave?)` | shipped | Write a chord progression as block chords in root position. |

See [DESIGN.md](DESIGN.md) for conventions (pitch numbering, beat units, instrument allowlist).

## Limitations (v0.1)

- **Session view only.** Created clips live in the Session view grid, not the Arrangement view. Switch Live to Session view (Tab key) to see and trigger them.
- **4/4 time assumed.** `length_bars` is multiplied by 4 to get beats; we don't read or set the project time signature.
- **No time signature, no playback position.** Can fire clips and scenes, start/stop/continue the global transport, and set tempo. Can't yet change the project time signature or read the current playback position.
- **No audio tracks, no effects, no routing.** Only MIDI tracks with a single built-in instrument.
- **Instrument allowlist** is limited to the 9 built-in Live 12 Suite instruments listed in [DESIGN.md](DESIGN.md). Intro/Standard editions are missing several.

## Security

This server grants Claude write access to your active Ableton Live session. The bridge is localhost-only (no network port), but treat it as you would any local automation tool — review what Claude proposes before it runs if you have unsaved work.

## License

[MIT](LICENSE).
