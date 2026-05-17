"""MCP server: tools for driving Ableton Live via AbletonOSC."""

from __future__ import annotations

import math
import time
from typing import TypedDict

from mcp.server.fastmcp import FastMCP
from pychord import Chord

from claude_ableton.osc import AbletonClient


class CreateTrackResult(TypedDict):
    track_index: int


class LoadInstrumentResult(TypedDict):
    instrument: str
    device_index: int


class Note(TypedDict):
    pitch: int          # MIDI note number, 0-127 (60 = C4)
    start_beat: float   # beats from clip start
    duration_beat: float
    velocity: int       # MIDI velocity, 1-127


class CreateClipResult(TypedDict):
    track_index: int
    clip_slot: int
    length_beats: float
    note_count: int


class ClipActionResult(TypedDict):
    track_index: int
    clip_slot: int
    action: str


class DeleteTrackResult(TypedDict):
    track_index: int
    action: str


class DeleteDeviceResult(TypedDict):
    track_index: int
    device_index: int
    action: str


class ListPresetsResult(TypedDict):
    path: str
    children: list[str]


class LoadPresetResult(TypedDict):
    track_index: int
    preset_path: str
    device_index: int


class FireSceneResult(TypedDict):
    scene_index: int
    action: str


class SetTempoResult(TypedDict):
    bpm: float
    action: str


class RhythmStep(TypedDict):
    start_beat: float
    duration_beat: float


# Pitch-class lookup for chord component note names (sharps & flats).
_PITCH_CLASS: dict[str, int] = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3,
    "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8,
    "A": 9, "A#": 10, "Bb": 10, "B": 11,
}


BEATS_PER_BAR = 4  # MVP assumes 4/4 time
TIME_QUANTUM = 1e-6  # round note times to avoid LOM denormal issues

LIVE_TICK_SEC = 0.15
LOAD_TIMEOUT_SEC = 2.0
LOAD_POLL_SEC = 0.1

# Allowlist of built-in Live 12 Suite instruments.
# Keys are lowercase identifiers exposed to callers; values are the exact
# names of items under app.browser.instruments in Live (as the AbletonOSC
# /live/track/load_instrument handler matches by name).
INSTRUMENT_MAP: dict[str, str] = {
    "operator": "Operator",
    "wavetable": "Wavetable",
    "drift": "Drift",
    "meld": "Meld",
    "analog": "Analog",
    "electric": "Electric",
    "tension": "Tension",
    "simpler": "Simpler",
    "collision": "Collision",
}

mcp = FastMCP("ableton")
_client: AbletonClient | None = None
_pinged = False


def _get_client() -> AbletonClient:
    global _client, _pinged
    if _client is None:
        _client = AbletonClient()
    if not _pinged:
        _client.ping_or_raise()
        _pinged = True
    return _client


def _num_devices(client: AbletonClient, track_index: int) -> int:
    reply = client.query("/live/track/get/num_devices", track_index)
    # reply shape: (track_id, num_devices)
    return int(reply[1])


@mcp.tool()
def create_midi_track(name: str | None = None) -> CreateTrackResult:
    """Create a MIDI track appended at the end of the track list.

    Args:
        name: Optional name for the new track.

    Returns:
        Dict with `track_index` — zero-based index of the new track.
    """
    client = _get_client()
    (current_count,) = client.query("/live/song/get/num_tracks")
    client.send("/live/song/create_midi_track", -1)
    time.sleep(LIVE_TICK_SEC)
    new_index = int(current_count)
    if name:
        client.send("/live/track/set/name", new_index, name)
    return {"track_index": new_index}


@mcp.tool()
def load_instrument(track_index: int, instrument: str) -> LoadInstrumentResult:
    """Load a built-in Live 12 Suite instrument onto a track.

    Args:
        track_index: zero-based index of the target track.
        instrument: instrument identifier from the allowlist. One of:
            operator, wavetable, drift, meld, analog, electric, tension,
            simpler, collision. Case-insensitive.

    Returns:
        Dict with `instrument` (the loaded identifier) and `device_index`
        (zero-based index of the newly added device on the track).

    Raises:
        ValueError: if `instrument` is not in the allowlist.
        RuntimeError: if the device does not appear on the track within
            the load timeout (2s).
    """
    client = _get_client()
    key = instrument.lower()
    browser_name = INSTRUMENT_MAP.get(key)
    if browser_name is None:
        raise ValueError(
            f"Unknown instrument {instrument!r}. "
            f"Allowed: {sorted(INSTRUMENT_MAP)}"
        )

    devices_before = _num_devices(client, track_index)
    client.send("/live/track/load_instrument", track_index, browser_name)

    deadline = time.monotonic() + LOAD_TIMEOUT_SEC
    while time.monotonic() < deadline:
        time.sleep(LOAD_POLL_SEC)
        if _num_devices(client, track_index) > devices_before:
            return {"instrument": key, "device_index": devices_before}

    raise RuntimeError(
        f"Load timed out: {instrument!r} did not appear on track "
        f"{track_index} within {LOAD_TIMEOUT_SEC:.0f}s."
    )


def _validate_note(note: Note, index: int) -> None:
    pitch = note["pitch"]
    velocity = note["velocity"]
    start_beat = note["start_beat"]
    duration_beat = note["duration_beat"]
    if not (0 <= pitch <= 127):
        raise ValueError(f"note[{index}]: pitch {pitch} out of range 0-127")
    if not (1 <= velocity <= 127):
        raise ValueError(
            f"note[{index}]: velocity {velocity} out of range 1-127 "
            "(0 means note-off and is not accepted)"
        )
    if start_beat < 0:
        raise ValueError(f"note[{index}]: start_beat {start_beat} must be >= 0")
    if duration_beat <= 0:
        raise ValueError(
            f"note[{index}]: duration_beat {duration_beat} must be > 0"
        )


def _create_clip(
    track_index: int,
    clip_slot: int,
    length_bars: float,
    notes: list[Note] | None,
    name: str | None,
) -> CreateClipResult:
    """Implementation shared by create_clip and chord_progression."""
    if length_bars <= 0:
        raise ValueError(f"length_bars must be > 0 (got {length_bars})")

    notes = notes or []
    for i, note in enumerate(notes):
        _validate_note(note, i)

    client = _get_client()

    has = client.query("/live/clip_slot/get/has_clip", track_index, clip_slot)
    if bool(has[2]):
        raise ValueError(
            f"clip_slot ({track_index}, {clip_slot}) already contains a clip. "
            "Delete it first or pick another slot."
        )

    length_beats = float(length_bars) * BEATS_PER_BAR
    client.send("/live/clip_slot/create_clip", track_index, clip_slot, length_beats)
    time.sleep(LIVE_TICK_SEC)

    if name:
        client.send("/live/clip/set/name", track_index, clip_slot, name)

    if notes:
        # /live/clip/add/notes takes (track, clip, pitch, start, duration, velocity, mute, ...)
        # flattened across all notes.
        flat: list[float | int | bool] = [track_index, clip_slot]
        for note in notes:
            flat.extend([
                int(note["pitch"]),
                round(float(note["start_beat"]) / TIME_QUANTUM) * TIME_QUANTUM,
                round(float(note["duration_beat"]) / TIME_QUANTUM) * TIME_QUANTUM,
                int(note["velocity"]),
                False,  # mute
            ])
        client.send("/live/clip/add/notes", *flat)
        time.sleep(LIVE_TICK_SEC)

    return {
        "track_index": track_index,
        "clip_slot": clip_slot,
        "length_beats": length_beats,
        "note_count": len(notes),
    }


@mcp.tool()
def create_clip(
    track_index: int,
    clip_slot: int,
    length_bars: float,
    notes: list[Note] | None = None,
    name: str | None = None,
) -> CreateClipResult:
    """Create a MIDI clip in the given clip slot and optionally write notes.

    Assumes 4/4 time (4 beats per bar). If the slot already contains a clip,
    raises rather than overwriting.

    Args:
        track_index: zero-based track index. Track must be a MIDI track.
        clip_slot: zero-based clip slot (scene) index.
        length_bars: clip length in bars (must be > 0).
        notes: optional list of notes to write. Each note:
            - pitch: MIDI note number 0-127 (60 = C4 in Ableton)
            - start_beat: beats from clip start (>= 0)
            - duration_beat: beats (> 0)
            - velocity: MIDI velocity 1-127 (0 means note-off, rejected)
        name: optional clip name.

    Returns:
        Dict with track_index, clip_slot, length_beats, note_count.

    Raises:
        ValueError: invalid length, slot collision, or invalid note.
    """
    return _create_clip(track_index, clip_slot, length_bars, notes, name)


def _chord_to_midi(components: list[str], octave: int) -> list[int]:
    """Convert pychord components (note names) to MIDI pitches in root position.

    The root is placed at the given octave; subsequent chord tones are placed
    ascending from the root (bumped up an octave if their pitch class falls
    below the root's MIDI pitch).
    """
    base = 12 * (octave + 1)
    try:
        root_pc = _PITCH_CLASS[components[0]]
    except KeyError as e:
        raise ValueError(f"Unknown note name in chord components: {e}") from e
    root_midi = base + root_pc

    midi_notes = [root_midi]
    for component in components[1:]:
        try:
            pc = _PITCH_CLASS[component]
        except KeyError as e:
            raise ValueError(f"Unknown note name in chord components: {e}") from e
        pitch = base + pc
        while pitch < root_midi:
            pitch += 12
        midi_notes.append(pitch)
    return midi_notes


@mcp.tool()
def chord_progression(
    track_index: int,
    clip_slot: int,
    chords: list[str],
    rhythm: list[RhythmStep] | None = None,
    name: str | None = None,
    velocity: int = 90,
    octave: int = 4,
) -> CreateClipResult:
    """Write a chord progression into a clip as block chords.

    Each chord symbol is parsed (via pychord) and voiced in naïve root
    position from the given octave. By default each chord occupies one bar;
    pass `rhythm` to control timing explicitly.

    Args:
        track_index: target MIDI track index.
        clip_slot: target clip slot (must be empty).
        chords: chord symbols, e.g. `["Cmaj7", "Am7", "Fmaj7", "G7"]`.
            Supports maj/min/7/maj7/m7/dim/aug and common extensions; see
            pychord for the full grammar.
        rhythm: optional list of `{start_beat, duration_beat}` aligned with
            chords (same length). If omitted, each chord lasts one bar
            (4 beats), played in order.
        name: optional clip name. Defaults to chord symbols joined with " | ".
        velocity: MIDI velocity for every note (default 90).
        octave: octave for the chord roots (default 4 → C4 = MIDI 60).

    Returns:
        Same shape as create_clip.

    Raises:
        ValueError: mismatched chords/rhythm length, unparseable chord
            symbol, invalid velocity, or slot collision.
    """
    if not chords:
        raise ValueError("chords must not be empty")
    if not (1 <= velocity <= 127):
        raise ValueError(f"velocity {velocity} out of range 1-127")

    if rhythm is None:
        rhythm = [
            {"start_beat": float(i * BEATS_PER_BAR),
             "duration_beat": float(BEATS_PER_BAR)}
            for i in range(len(chords))
        ]
    if len(chords) != len(rhythm):
        raise ValueError(
            f"chords ({len(chords)}) and rhythm ({len(rhythm)}) must be the same length"
        )

    notes: list[Note] = []
    max_end = 0.0
    for i, (symbol, step) in enumerate(zip(chords, rhythm)):
        try:
            components = Chord(symbol).components()
        except Exception as e:
            raise ValueError(f"chord[{i}] {symbol!r} could not be parsed: {e}") from e

        start = float(step["start_beat"])
        duration = float(step["duration_beat"])
        if start < 0:
            raise ValueError(f"rhythm[{i}]: start_beat {start} must be >= 0")
        if duration <= 0:
            raise ValueError(f"rhythm[{i}]: duration_beat {duration} must be > 0")

        for pitch in _chord_to_midi(components, octave):
            notes.append({
                "pitch": pitch,
                "start_beat": start,
                "duration_beat": duration,
                "velocity": velocity,
            })
        max_end = max(max_end, start + duration)

    length_bars = max(1, math.ceil(max_end / BEATS_PER_BAR))
    if name is None:
        name = " | ".join(chords)

    return _create_clip(track_index, clip_slot, length_bars, notes, name)


@mcp.tool()
def fire_scene(scene_index: int) -> FireSceneResult:
    """Fire all clips in the given scene (row).

    Locks multiple tracks to the same downbeat, useful when starting
    a chord clip and a lead clip together. Fire-and-forget.

    Args:
        scene_index: zero-based scene (row) index.
    """
    client = _get_client()
    client.send("/live/scene/fire", scene_index)
    return {"scene_index": scene_index, "action": "fired"}


@mcp.tool()
def set_tempo(bpm: float) -> SetTempoResult:
    """Set the project tempo.

    Args:
        bpm: target tempo in BPM. Live's valid range is 20-999.

    Raises:
        ValueError: if bpm is outside 20-999.
    """
    if not (20.0 <= bpm <= 999.0):
        raise ValueError(f"bpm {bpm} out of range 20-999")
    client = _get_client()
    client.send("/live/song/set/tempo", float(bpm))
    return {"bpm": float(bpm), "action": "set"}


@mcp.tool()
def play_clip(track_index: int, clip_slot: int) -> ClipActionResult:
    """Trigger playback of the clip in the given clip slot (Session view).

    Fire-and-forget: no confirmation that playback actually started. If the
    slot is empty, Live silently does nothing.

    Args:
        track_index: zero-based track index.
        clip_slot: zero-based clip slot (scene) index.
    """
    client = _get_client()
    client.send("/live/clip_slot/fire", track_index, clip_slot)
    return {"track_index": track_index, "clip_slot": clip_slot, "action": "fired"}


@mcp.tool()
def list_presets(path: str = "") -> ListPresetsResult:
    """List child names in Live's instrument browser at the given path.

    Walks `app.browser.instruments`. With an empty path, returns the top-level
    instrument names (Wavetable, Operator, etc.). With a path like "Wavetable"
    returns its category folders; "Wavetable/Synth Lead" returns presets in
    that folder. Slash-separated.

    If the path doesn't exist, returns an empty children list (and Live logs
    a warning).

    Args:
        path: slash-separated browser path; "" for top-level.
    """
    client = _get_client()
    reply = client.query("/live/browser/list_instrument_presets", path)
    # Reply shape: (path, name1, name2, ...). When path doesn't exist or has
    # no children, reply is (path,) alone.
    children = [str(x) for x in reply[1:]]
    return {"path": str(reply[0]), "children": children}


@mcp.tool()
def list_drum_kits(path: str = "") -> ListPresetsResult:
    """List child names in Live's drum browser at the given path.

    Walks `app.browser.drums`. With an empty path, returns the top-level
    drum categories (Kit-Core 909, Kit-Core 808, etc., depending on what
    ships with your Live install). With a path like "Kit-Core 909" returns
    the kits inside that category. Slash-separated.

    Empty children list means the path doesn't exist (or has no children).

    Args:
        path: slash-separated drum-browser path; "" for top-level.
    """
    client = _get_client()
    reply = client.query("/live/browser/list_drum_kits", path)
    children = [str(x) for x in reply[1:]]
    return {"path": str(reply[0]), "children": children}


@mcp.tool()
def load_drum_kit(track_index: int, kit_path: str) -> LoadPresetResult:
    """Load a complete drum kit onto a track by drum-browser path.

    Path is slash-separated from `app.browser.drums` — e.g.
    "Kit-Core 909/909 Kit". Use list_drum_kits to discover paths.
    The result is a Drum Rack with samples mapped to standard pad pitches
    (kick on C1=36, snare on D1=38, etc.), so a single track with one MIDI
    clip can drive the whole kit.

    Args:
        track_index: zero-based track index.
        kit_path: slash-separated browser path to the kit.

    Returns:
        Dict with track_index, the kit path (under `preset_path` for shape
        symmetry with load_preset), and the device_index of the loaded kit.

    Raises:
        RuntimeError: if no device appears on the track within 2s
            (probably means the path doesn't exist or isn't loadable).
    """
    client = _get_client()
    devices_before = _num_devices(client, track_index)
    client.send("/live/track/load_drum_kit", track_index, kit_path)

    deadline = time.monotonic() + LOAD_TIMEOUT_SEC
    while time.monotonic() < deadline:
        time.sleep(LOAD_POLL_SEC)
        if _num_devices(client, track_index) > devices_before:
            return {
                "track_index": track_index,
                "preset_path": kit_path,
                "device_index": devices_before,
            }

    raise RuntimeError(
        f"Load timed out: drum kit {kit_path!r} did not appear on track "
        f"{track_index} within {LOAD_TIMEOUT_SEC:.0f}s. The path may not "
        "exist or may not be loadable; try list_drum_kits to verify."
    )


@mcp.tool()
def load_preset(track_index: int, preset_path: str) -> LoadPresetResult:
    """Load a specific instrument preset onto a track by browser path.

    Path is slash-separated from `app.browser.instruments` — e.g.
    "Wavetable/Synth Lead/Big Pluck". Use list_presets to discover paths.

    Args:
        track_index: zero-based track index.
        preset_path: slash-separated browser path to the preset.

    Returns:
        Dict with track_index, preset_path, and the device_index of the
        loaded device.

    Raises:
        RuntimeError: if no device appears on the track within 2s
            (probably means the path doesn't exist or isn't loadable).
    """
    client = _get_client()
    devices_before = _num_devices(client, track_index)
    client.send("/live/track/load_instrument_preset", track_index, preset_path)

    deadline = time.monotonic() + LOAD_TIMEOUT_SEC
    while time.monotonic() < deadline:
        time.sleep(LOAD_POLL_SEC)
        if _num_devices(client, track_index) > devices_before:
            return {
                "track_index": track_index,
                "preset_path": preset_path,
                "device_index": devices_before,
            }

    raise RuntimeError(
        f"Load timed out: preset {preset_path!r} did not appear on track "
        f"{track_index} within {LOAD_TIMEOUT_SEC:.0f}s. The path may not "
        "exist or may not be loadable; try list_presets to verify."
    )


@mcp.tool()
def delete_track(track_index: int) -> DeleteTrackResult:
    """Delete a track from the song.

    Destructive: removes the track and everything on it (devices, clips).
    Live's Undo (Cmd+Z) can recover.

    Args:
        track_index: zero-based track index.
    """
    client = _get_client()
    client.send("/live/song/delete_track", track_index)
    return {"track_index": track_index, "action": "deleted"}


@mcp.tool()
def delete_device(track_index: int, device_index: int) -> DeleteDeviceResult:
    """Delete a device (instrument or effect) from a track.

    Destructive but Undo-able. Useful for swapping instruments: delete the
    current device, then call load_instrument for the new one.

    Args:
        track_index: zero-based track index.
        device_index: zero-based device index on the track.
    """
    client = _get_client()
    client.send("/live/track/delete_device", track_index, device_index)
    return {
        "track_index": track_index,
        "device_index": device_index,
        "action": "deleted",
    }


@mcp.tool()
def stop_clip(track_index: int, clip_slot: int) -> ClipActionResult:
    """Stop playback of the clip in the given clip slot.

    Fire-and-forget. If the clip isn't playing, this is a no-op.

    Args:
        track_index: zero-based track index.
        clip_slot: zero-based clip slot (scene) index.
    """
    client = _get_client()
    client.send("/live/clip/stop", track_index, clip_slot)
    return {"track_index": track_index, "clip_slot": clip_slot, "action": "stopped"}


@mcp.tool()
def delete_clip(track_index: int, clip_slot: int) -> ClipActionResult:
    """Delete the clip in the given clip slot, emptying the slot.

    Destructive but Undo-able in Live. Useful for replacing a clip with
    a new one in the same slot (create_clip refuses to overwrite).

    Args:
        track_index: zero-based track index.
        clip_slot: zero-based clip slot (scene) index.
    """
    client = _get_client()
    client.send("/live/clip_slot/delete_clip", track_index, clip_slot)
    return {"track_index": track_index, "clip_slot": clip_slot, "action": "deleted"}


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
