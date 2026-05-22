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


class SceneInfo(TypedDict):
    scene_index: int
    name: str
    is_empty: bool


class SceneActionResult(TypedDict):
    scene_index: int
    action: str


class SetTempoResult(TypedDict):
    bpm: float
    action: str


class RhythmStep(TypedDict):
    start_beat: float
    duration_beat: float


class TrackInfo(TypedDict):
    track_index: int
    name: str
    is_midi: bool
    num_devices: int


class ClipSlotInfo(TypedDict):
    clip_slot: int
    has_clip: bool
    name: str | None
    length_beats: float | None


class DeviceInfo(TypedDict):
    device_index: int
    name: str
    type_id: int  # 0 = audio_effect, 1 = instrument, 2 = midi_effect
    class_name: str


class DeviceParameterInfo(TypedDict):
    parameter_index: int
    name: str
    value: float
    min: float
    max: float
    is_quantized: bool


class SetTrackPropertyResult(TypedDict):
    track_index: int
    property: str
    value: float


class SetDeviceParameterResult(TypedDict):
    track_index: int
    device_index: int
    parameter_index: int
    value: float


class LoadAudioEffectResult(TypedDict):
    track_index: int
    effect_path: str
    device_index: int


class LoadMidiEffectResult(TypedDict):
    track_index: int
    effect_path: str
    device_count: int


class TransportResult(TypedDict):
    action: str


class SidechainSourceList(TypedDict):
    track_index: int
    device_index: int
    sources: list[str]


class SidechainChannelList(TypedDict):
    track_index: int
    device_index: int
    channels: list[str]


class SetSidechainResult(TypedDict):
    track_index: int
    device_index: int
    value: str


class ReturnTrackInfo(TypedDict):
    return_index: int
    name: str


class CreateReturnTrackResult(TypedDict):
    return_index: int


class LoadAudioEffectOnReturnResult(TypedDict):
    return_index: int
    effect_path: str


class SendInfo(TypedDict):
    send_index: int
    value: float


class SetSendResult(TypedDict):
    track_index: int
    send_index: int
    value: float


class AddNotesResult(TypedDict):
    track_index: int
    clip_slot: int
    added_count: int


class RemoveNotesResult(TypedDict):
    track_index: int
    clip_slot: int


class LoadSampleResult(TypedDict):
    track_index: int
    sample_path: str


class PaginatedSampleList(TypedDict):
    path: str
    offset: int
    total_count: int
    children: list[str]


class LoadSampleToDrumPadResult(TypedDict):
    track_index: int
    device_index: int
    pad_pitch: int
    sample_path: str


class DrumPadInfo(TypedDict):
    note: int   # MIDI note that triggers the pad (e.g. 36 = kick)
    name: str   # pad name, usually the loaded sample/drum name


class AutomationStep(TypedDict):
    start_beat: float    # beats from clip start
    length_beats: float  # length of the constant-value segment
    value: float         # parameter value during this segment


class AutomationResult(TypedDict):
    track_index: int
    clip_slot: int
    step_count: int


class ClearEnvelopesResult(TypedDict):
    track_index: int
    clip_slot: int


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


def _voice_chord_smooth(
    components: list[str], octave: int, prev_notes: list[int] | None
) -> list[int]:
    """Voice a chord's pitch classes with smooth voice-leading.

    With no previous chord, falls back to close root-position voicing from
    `octave` (same as `_chord_to_midi`). Otherwise each pitch class is placed
    in the octave nearest the previous chord's centroid, so the progression
    stays in a stable register and common tones barely move — what a keyboard
    player does, instead of root-position chords leaping by large intervals.
    """
    try:
        pcs = [_PITCH_CLASS[c] for c in components]
    except KeyError as e:
        raise ValueError(f"Unknown note name in chord components: {e}") from e

    if not prev_notes:
        return _chord_to_midi(components, octave)

    anchor = sum(prev_notes) / len(prev_notes)
    notes = [pc + 12 * round((anchor - pc) / 12) for pc in pcs]
    return sorted(int(n) for n in notes)


@mcp.tool()
def chord_progression(
    track_index: int,
    clip_slot: int,
    chords: list[str],
    rhythm: list[RhythmStep] | None = None,
    name: str | None = None,
    velocity: int = 90,
    octave: int = 4,
    voicing: str = "smooth",
) -> CreateClipResult:
    """Write a chord progression into a clip as block chords.

    Each chord symbol is parsed (via pychord) and voiced into MIDI. By default
    each chord occupies one bar; pass `rhythm` to control timing explicitly.

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
        octave: octave for the first chord's root (default 4 → C4 = MIDI 60).
        voicing: `"smooth"` (default) applies voice-leading so chords stay in a
            stable register and common tones barely move — sounds like a player,
            not root-position blocks leaping around. `"root"` keeps every chord
            in literal root position from `octave` (the original v0.1 behavior).

    Returns:
        Same shape as create_clip.

    Raises:
        ValueError: mismatched chords/rhythm length, unparseable chord
            symbol, invalid velocity, unknown voicing, or slot collision.
    """
    if not chords:
        raise ValueError("chords must not be empty")
    if not (1 <= velocity <= 127):
        raise ValueError(f"velocity {velocity} out of range 1-127")
    if voicing not in ("smooth", "root"):
        raise ValueError(f"voicing {voicing!r} must be 'smooth' or 'root'")

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
    prev_notes: list[int] | None = None
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

        if voicing == "smooth":
            pitches = _voice_chord_smooth(components, octave, prev_notes)
        else:
            pitches = _chord_to_midi(components, octave)

        for pitch in pitches:
            notes.append({
                "pitch": pitch,
                "start_beat": start,
                "duration_beat": duration,
                "velocity": velocity,
            })
        prev_notes = pitches
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
def list_scenes() -> list[SceneInfo]:
    """List every scene (row) with its index, name, and whether it's empty.

    Scenes are the horizontal rows of the Session grid. `is_empty` is True
    when no track has a clip in that row. Useful for "where should the drop
    go?" or finding a blank row before building a new section.
    """
    client = _get_client()
    (n_scenes,) = client.query("/live/song/get/num_scenes")
    scenes: list[SceneInfo] = []
    for i in range(int(n_scenes)):
        name_reply = client.query("/live/scene/get/name", i)
        empty_reply = client.query("/live/scene/get/is_empty", i)
        scenes.append({
            "scene_index": i,
            "name": str(name_reply[1]),
            "is_empty": bool(empty_reply[1]),
        })
    return scenes


@mcp.tool()
def create_scene(index: int = -1, name: str | None = None) -> SceneActionResult:
    """Create a new empty scene (row).

    Args:
        index: insertion position. -1 (default) appends at the end; any other
            value inserts at that scene index, shifting later scenes down.
        name: optional name for the new scene.

    Returns:
        Dict with the new scene's `scene_index` and `action`.
    """
    client = _get_client()
    (before,) = client.query("/live/song/get/num_scenes")
    before = int(before)
    new_index = before if index < 0 else index
    client.send("/live/song/create_scene", index)
    time.sleep(LIVE_TICK_SEC)
    if name:
        client.send("/live/scene/set/name", new_index, name)
    return {"scene_index": new_index, "action": "created"}


@mcp.tool()
def duplicate_scene(scene_index: int) -> SceneActionResult:
    """Duplicate a scene, inserting the copy directly below it.

    Copies every clip in the row, so it's the fast way to make a variation
    of an existing section (e.g. duplicate the verse, then tweak).

    Args:
        scene_index: zero-based index of the scene to duplicate.

    Returns:
        Dict with the new (duplicated) scene's `scene_index` (scene_index + 1)
        and `action`.
    """
    client = _get_client()
    client.send("/live/song/duplicate_scene", scene_index)
    time.sleep(LIVE_TICK_SEC)
    return {"scene_index": scene_index + 1, "action": "duplicated"}


@mcp.tool()
def rename_scene(scene_index: int, name: str) -> SceneActionResult:
    """Rename a scene (row).

    Args:
        scene_index: zero-based scene index.
        name: new scene name.
    """
    client = _get_client()
    client.send("/live/scene/set/name", scene_index, name)
    return {"scene_index": scene_index, "action": "renamed"}


@mcp.tool()
def delete_scene(scene_index: int) -> SceneActionResult:
    """Delete a scene (row). Destructive but Undo-able.

    Live requires at least one scene to exist; deleting the only remaining
    scene will fail in Live.

    Args:
        scene_index: zero-based scene index to delete.
    """
    client = _get_client()
    client.send("/live/song/delete_scene", scene_index)
    return {"scene_index": scene_index, "action": "deleted"}


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


#--------------------------------------------------------------------------------
# State visibility — let the LLM see what's already in the project.
#--------------------------------------------------------------------------------


@mcp.tool()
def list_tracks() -> list[TrackInfo]:
    """List every track in the song with its key properties.

    Returns one entry per track with its zero-based index, name, whether it
    accepts MIDI input, and how many devices it has. Use this before any
    "fix the bass" / "swap the lead" workflow — you need to know which
    track index corresponds to which name.
    """
    client = _get_client()
    (n,) = client.query("/live/song/get/num_tracks")
    tracks: list[TrackInfo] = []
    for i in range(int(n)):
        name_reply = client.query("/live/track/get/name", i)
        midi_reply = client.query("/live/track/get/has_midi_input", i)
        ndev_reply = client.query("/live/track/get/num_devices", i)
        tracks.append({
            "track_index": i,
            "name": str(name_reply[1]),
            "is_midi": bool(midi_reply[1]),
            "num_devices": int(ndev_reply[1]),
        })
    return tracks


@mcp.tool()
def list_clips(track_index: int) -> list[ClipSlotInfo]:
    """List clip slots on a track with their occupancy.

    Returns one entry per Session-view clip slot. Empty slots have
    `has_clip=False` and `name=None`. Useful for "what's already on the
    Bass track?" before creating or deleting clips.

    Args:
        track_index: zero-based track index.
    """
    client = _get_client()
    (n_scenes,) = client.query("/live/song/get/num_scenes")
    slots: list[ClipSlotInfo] = []
    for s in range(int(n_scenes)):
        has_reply = client.query("/live/clip_slot/get/has_clip", track_index, s)
        has = bool(has_reply[2])
        if has:
            name_reply = client.query("/live/clip/get/name", track_index, s)
            length_reply = client.query("/live/clip/get/length", track_index, s)
            slots.append({
                "clip_slot": s,
                "has_clip": True,
                "name": str(name_reply[2]),
                "length_beats": float(length_reply[2]),
            })
        else:
            slots.append({
                "clip_slot": s,
                "has_clip": False,
                "name": None,
                "length_beats": None,
            })
    return slots


@mcp.tool()
def get_track_devices(track_index: int) -> list[DeviceInfo]:
    """List the devices (instrument + effects) on a track.

    Returns one entry per device with its index, name, type, and Live
    class name. type_id is 0 (audio_effect), 1 (instrument), or 2
    (midi_effect). Use this to discover device indices before calling
    `delete_device` or `get_device_parameters`.

    Args:
        track_index: zero-based track index.
    """
    client = _get_client()
    ndev_reply = client.query("/live/track/get/num_devices", track_index)
    n = int(ndev_reply[1])
    if n == 0:
        return []
    name_reply = client.query("/live/track/get/devices/name", track_index)
    type_reply = client.query("/live/track/get/devices/type", track_index)
    class_reply = client.query("/live/track/get/devices/class_name", track_index)
    names = name_reply[1:]
    types = type_reply[1:]
    classes = class_reply[1:]
    return [
        {
            "device_index": i,
            "name": str(names[i]),
            "type_id": int(types[i]),
            "class_name": str(classes[i]),
        }
        for i in range(n)
    ]


#--------------------------------------------------------------------------------
# Mixer — track-level volume / pan / mute / solo.
#--------------------------------------------------------------------------------


@mcp.tool()
def set_track_volume(track_index: int, volume: float) -> SetTrackPropertyResult:
    """Set track volume.

    Args:
        track_index: zero-based track index.
        volume: Live's normalized volume in [0.0, 1.0]. ~0.85 is 0 dB unity
            gain; 1.0 is +6 dB.
    """
    if not (0.0 <= volume <= 1.0):
        raise ValueError(f"volume {volume} out of range 0.0-1.0")
    client = _get_client()
    client.send("/live/track/set/volume", track_index, float(volume))
    return {"track_index": track_index, "property": "volume", "value": float(volume)}


@mcp.tool()
def set_track_pan(track_index: int, pan: float) -> SetTrackPropertyResult:
    """Set track pan.

    Args:
        track_index: zero-based track index.
        pan: -1.0 (full left) to 1.0 (full right). 0.0 is centered.
    """
    if not (-1.0 <= pan <= 1.0):
        raise ValueError(f"pan {pan} out of range -1.0 to 1.0")
    client = _get_client()
    client.send("/live/track/set/panning", track_index, float(pan))
    return {"track_index": track_index, "property": "pan", "value": float(pan)}


@mcp.tool()
def set_track_mute(track_index: int, mute: bool) -> SetTrackPropertyResult:
    """Mute or unmute a track.

    Args:
        track_index: zero-based track index.
        mute: True to mute, False to unmute.
    """
    client = _get_client()
    client.send("/live/track/set/mute", track_index, int(bool(mute)))
    return {"track_index": track_index, "property": "mute", "value": float(bool(mute))}


@mcp.tool()
def set_track_solo(track_index: int, solo: bool) -> SetTrackPropertyResult:
    """Solo or un-solo a track.

    Args:
        track_index: zero-based track index.
        solo: True to solo, False to un-solo.
    """
    client = _get_client()
    client.send("/live/track/set/solo", track_index, int(bool(solo)))
    return {"track_index": track_index, "property": "solo", "value": float(bool(solo))}


#--------------------------------------------------------------------------------
# Device parameters — sound design knobs on any loaded device.
#--------------------------------------------------------------------------------


@mcp.tool()
def get_device_parameters(
    track_index: int, device_index: int
) -> list[DeviceParameterInfo]:
    """List a device's exposed parameters with current value + range.

    Returns one entry per macro/control: parameter_index, name, current
    value, min, max, is_quantized (whether the value snaps to discrete
    steps — typical for switches and dropdown-style selectors).

    Use this to discover parameter indices before calling
    `set_device_parameter`. Most synths expose 8 macro controls at the
    top of the list; sampler devices and effects may expose dozens.

    Args:
        track_index: zero-based track index.
        device_index: zero-based device index on the track.
    """
    client = _get_client()
    n_reply = client.query(
        "/live/device/get/num_parameters", track_index, device_index
    )
    n = int(n_reply[2])
    if n == 0:
        return []
    name_reply = client.query(
        "/live/device/get/parameters/name", track_index, device_index
    )
    value_reply = client.query(
        "/live/device/get/parameters/value", track_index, device_index
    )
    min_reply = client.query(
        "/live/device/get/parameters/min", track_index, device_index
    )
    max_reply = client.query(
        "/live/device/get/parameters/max", track_index, device_index
    )
    quant_reply = client.query(
        "/live/device/get/parameters/is_quantized", track_index, device_index
    )
    names = name_reply[2:]
    values = value_reply[2:]
    mins = min_reply[2:]
    maxs = max_reply[2:]
    quants = quant_reply[2:]
    return [
        {
            "parameter_index": i,
            "name": str(names[i]),
            "value": float(values[i]),
            "min": float(mins[i]),
            "max": float(maxs[i]),
            "is_quantized": bool(quants[i]),
        }
        for i in range(n)
    ]


@mcp.tool()
def set_device_parameter(
    track_index: int,
    device_index: int,
    parameter_index: int,
    value: float,
) -> SetDeviceParameterResult:
    """Set a single device parameter by index.

    Use `get_device_parameters` first to discover the parameter index and
    its valid range. Passing a value outside [min, max] silently clamps
    inside Live; no validation here.

    Args:
        track_index: zero-based track index.
        device_index: zero-based device index on the track.
        parameter_index: zero-based parameter index from
            `get_device_parameters`.
        value: target value (within the parameter's [min, max] range).
    """
    client = _get_client()
    client.send(
        "/live/device/set/parameter/value",
        track_index, device_index, parameter_index, float(value),
    )
    return {
        "track_index": track_index,
        "device_index": device_index,
        "parameter_index": parameter_index,
        "value": float(value),
    }


#--------------------------------------------------------------------------------
# Audio effects — wraps our fork's app.browser.audio_effects endpoints.
#--------------------------------------------------------------------------------


@mcp.tool()
def list_audio_effects(path: str = "") -> ListPresetsResult:
    """List child names in Live's audio-effects browser at the given path.

    Walks `app.browser.audio_effects`. Empty path returns top-level
    categories (Reverb, Delay, EQ Eight, Compressor, etc.). With a path
    like "Reverb" returns presets in that folder. Slash-separated.

    Args:
        path: slash-separated audio-effects browser path; "" for top-level.
    """
    client = _get_client()
    reply = client.query("/live/browser/list_audio_effects", path)
    children = [str(x) for x in reply[1:]]
    return {"path": str(reply[0]), "children": children}


@mcp.tool()
def load_audio_effect(track_index: int, effect_path: str) -> LoadAudioEffectResult:
    """Load an audio effect onto a track by browser path.

    Appended to the track's device chain (after any existing devices).
    Path is slash-separated from `app.browser.audio_effects` — e.g.
    "Reverb" loads the default Reverb device, "Compressor/Mixing/Vocal"
    loads a specific preset. Use `list_audio_effects` to discover paths.

    Args:
        track_index: zero-based track index.
        effect_path: slash-separated browser path to the effect.

    Returns:
        Dict with track_index, effect_path, and the device_index of the
        loaded effect.

    Raises:
        RuntimeError: if no new device appears on the track within 2s.
    """
    client = _get_client()
    devices_before = _num_devices(client, track_index)
    client.send("/live/track/load_audio_effect", track_index, effect_path)

    deadline = time.monotonic() + LOAD_TIMEOUT_SEC
    while time.monotonic() < deadline:
        time.sleep(LOAD_POLL_SEC)
        if _num_devices(client, track_index) > devices_before:
            return {
                "track_index": track_index,
                "effect_path": effect_path,
                "device_index": devices_before,
            }

    raise RuntimeError(
        f"Load timed out: audio effect {effect_path!r} did not appear on track "
        f"{track_index} within {LOAD_TIMEOUT_SEC:.0f}s. The path may not "
        "exist or may not be loadable; try list_audio_effects to verify."
    )


#--------------------------------------------------------------------------------
# MIDI effects — wraps our fork's app.browser.midi_effects endpoints.
#--------------------------------------------------------------------------------


@mcp.tool()
def list_midi_effects(path: str = "") -> ListPresetsResult:
    """List child names in Live's MIDI-effects browser at the given path.

    Walks `app.browser.midi_effects`. Empty path returns top-level MIDI
    effects (Arpeggiator, Chord, Scale, Note Length, Random, Velocity,
    Note Echo, Pitch, etc.). A path like "Arpeggiator" returns its presets.
    Slash-separated.

    Args:
        path: slash-separated MIDI-effects browser path; "" for top-level.
    """
    client = _get_client()
    reply = client.query("/live/browser/list_midi_effects", path)
    children = [str(x) for x in reply[1:]]
    return {"path": str(reply[0]), "children": children}


@mcp.tool()
def load_midi_effect(track_index: int, effect_path: str) -> LoadMidiEffectResult:
    """Load a MIDI effect onto a MIDI track by browser path.

    MIDI effects process notes *before* the instrument, so Live inserts them
    ahead of the instrument in the device chain (existing device indices may
    shift). Path is slash-separated from `app.browser.midi_effects` — e.g.
    "Arpeggiator" loads the default Arpeggiator, "Scale" constrains notes to a
    scale, "Chord" stacks intervals. Use `list_midi_effects` to discover paths.

    Args:
        track_index: zero-based MIDI track index.
        effect_path: slash-separated browser path to the MIDI effect.

    Returns:
        Dict with track_index, effect_path, and device_count (the track's new
        total device count after loading).

    Raises:
        RuntimeError: if no new device appears on the track within 2s.
    """
    client = _get_client()
    devices_before = _num_devices(client, track_index)
    client.send("/live/track/load_midi_effect", track_index, effect_path)

    deadline = time.monotonic() + LOAD_TIMEOUT_SEC
    while time.monotonic() < deadline:
        time.sleep(LOAD_POLL_SEC)
        count = _num_devices(client, track_index)
        if count > devices_before:
            return {
                "track_index": track_index,
                "effect_path": effect_path,
                "device_count": count,
            }

    raise RuntimeError(
        f"Load timed out: MIDI effect {effect_path!r} did not appear on track "
        f"{track_index} within {LOAD_TIMEOUT_SEC:.0f}s. The path may not "
        "exist or may not be loadable; try list_midi_effects to verify."
    )


#--------------------------------------------------------------------------------
# Transport — global play/stop/continue.
#--------------------------------------------------------------------------------


@mcp.tool()
def start_playing() -> TransportResult:
    """Start global playback from the beginning of the current arrangement
    position, or fire whatever Session view clips are queued.

    Use this when no Session clip has been launched but you want sound;
    `fire_scene` / `play_clip` will also start the transport if it isn't
    already running.
    """
    client = _get_client()
    client.send("/live/song/start_playing")
    return {"action": "started"}


@mcp.tool()
def stop_playing() -> TransportResult:
    """Stop global playback. All playing clips are stopped."""
    client = _get_client()
    client.send("/live/song/stop_playing")
    return {"action": "stopped"}


@mcp.tool()
def continue_playing() -> TransportResult:
    """Resume playback from the current arrangement position without
    restarting from the top.
    """
    client = _get_client()
    client.send("/live/song/continue_playing")
    return {"action": "continued"}


#--------------------------------------------------------------------------------
# Sidechain — wraps our fork's device input-routing endpoints. Use to wire
# a Compressor / Gate / Vocoder's sidechain input to a kick (or any) track.
#--------------------------------------------------------------------------------


@mcp.tool()
def get_sidechain_sources(
    track_index: int, device_index: int
) -> SidechainSourceList:
    """List the available sidechain source names for a device.

    Only devices with input routing (Compressor, Glue Compressor, Gate,
    Vocoder, etc.) return a non-empty list. Source names are typically
    track names plus "No Input" and any external inputs configured in
    Live's preferences.

    Args:
        track_index: zero-based track index hosting the device.
        device_index: zero-based device index on the track.
    """
    client = _get_client()
    reply = client.query(
        "/live/device/get/available_input_routing_types",
        track_index, device_index,
    )
    # reply: (track_index, device_index, name1, name2, ...)
    sources = [str(x) for x in reply[2:]]
    return {
        "track_index": track_index,
        "device_index": device_index,
        "sources": sources,
    }


@mcp.tool()
def get_sidechain_channels(
    track_index: int, device_index: int
) -> SidechainChannelList:
    """List the available sidechain channel tap points for a device.

    Typical values: "Pre FX", "Post FX", "Post Mixer". Determines where
    in the source track's signal chain the sidechain is tapped.

    Args:
        track_index: zero-based track index hosting the device.
        device_index: zero-based device index on the track.
    """
    client = _get_client()
    reply = client.query(
        "/live/device/get/available_input_routing_channels",
        track_index, device_index,
    )
    channels = [str(x) for x in reply[2:]]
    return {
        "track_index": track_index,
        "device_index": device_index,
        "channels": channels,
    }


@mcp.tool()
def set_sidechain_source(
    track_index: int, device_index: int, source: str
) -> SetSidechainResult:
    """Set the sidechain source for a Compressor / Gate / Vocoder etc.

    Use `get_sidechain_sources` first to discover valid names. To
    actually hear sidechain pumping, you also need to enable the
    device's S/C On parameter (typically param index 20 on the stock
    Compressor) via `set_device_parameter`.

    Args:
        track_index: zero-based track index hosting the device.
        device_index: zero-based device index on the track.
        source: display name of the source (e.g. "Drums", "Kick",
            "No Input"). Must match exactly.
    """
    client = _get_client()
    client.send(
        "/live/device/set/input_routing_type",
        track_index, device_index, source,
    )
    return {
        "track_index": track_index,
        "device_index": device_index,
        "value": source,
    }


@mcp.tool()
def set_sidechain_channel(
    track_index: int, device_index: int, channel: str
) -> SetSidechainResult:
    """Set the sidechain channel tap point.

    Use `get_sidechain_channels` first to discover valid names.
    Typical: "Pre FX" (raw source), "Post FX" (after effects), or
    "Post Mixer" (after fader/pan — what you hear).

    Args:
        track_index: zero-based track index hosting the device.
        device_index: zero-based device index on the track.
        channel: display name of the tap point. Must match exactly.
    """
    client = _get_client()
    client.send(
        "/live/device/set/input_routing_channel",
        track_index, device_index, channel,
    )
    return {
        "track_index": track_index,
        "device_index": device_index,
        "value": channel,
    }


#--------------------------------------------------------------------------------
# Sends and return tracks — share reverb/delay buses across tracks.
#--------------------------------------------------------------------------------


@mcp.tool()
def list_return_tracks() -> list[ReturnTrackInfo]:
    """List every return track with its index and name.

    Return tracks live separately from regular tracks (`song.return_tracks`).
    Their indices are independent — return 0 is the first return track,
    not the first regular track.
    """
    client = _get_client()
    reply = client.query("/live/song/get/return_tracks/name")
    # reply: (name1, name2, ...)
    return [
        {"return_index": i, "name": str(name)}
        for i, name in enumerate(reply)
    ]


@mcp.tool()
def create_return_track() -> CreateReturnTrackResult:
    """Create a new (empty) return track at the end of the return-track list.

    Returns the new return track's index. Use `load_audio_effect_on_return`
    to put a reverb/delay/etc. on it, then `set_send` on regular tracks to
    route audio in.
    """
    client = _get_client()
    (before,) = client.query("/live/song/get/num_return_tracks")
    client.send("/live/song/create_return_track")
    time.sleep(LIVE_TICK_SEC)
    return {"return_index": int(before)}


@mcp.tool()
def load_audio_effect_on_return(
    return_index: int, effect_path: str
) -> LoadAudioEffectOnReturnResult:
    """Load an audio effect onto a return track by browser path.

    Appended to the return track's device chain. Path is slash-separated
    from `app.browser.audio_effects` — e.g. "Reverb" loads the default
    Reverb device. Use `list_audio_effects` to discover paths.

    Fire-and-forget (no device-count polling — return tracks aren't exposed
    via `/live/track/get/num_devices`, so we'd be blind to confirmation).

    Args:
        return_index: zero-based return track index.
        effect_path: slash-separated browser path to the effect.
    """
    client = _get_client()
    client.send(
        "/live/return_track/load_audio_effect", return_index, effect_path
    )
    time.sleep(LIVE_TICK_SEC * 2)  # browser load isn't instant
    return {"return_index": return_index, "effect_path": effect_path}


@mcp.tool()
def set_send(
    track_index: int, send_index: int, value: float
) -> SetSendResult:
    """Set a track's send level to a return track.

    Each (regular) track has one send per return track, indexed in order.
    `set_send(5, 0, 0.5)` sends track 5 to return 0 at ~half. Use
    `list_return_tracks` to map names to indices.

    Args:
        track_index: zero-based (regular) track index sending audio.
        send_index: zero-based send/return index.
        value: send level in [0.0, 1.0]. 0 = no send, 1 = max.
    """
    if not (0.0 <= value <= 1.0):
        raise ValueError(f"send value {value} out of range 0.0-1.0")
    client = _get_client()
    client.send("/live/track/set/send", track_index, send_index, float(value))
    return {
        "track_index": track_index,
        "send_index": send_index,
        "value": float(value),
    }


@mcp.tool()
def get_sends(track_index: int) -> list[SendInfo]:
    """List the send levels of a track to every return.

    Args:
        track_index: zero-based (regular) track index.
    """
    client = _get_client()
    n_reply = client.query("/live/song/get/num_return_tracks")
    n = int(n_reply[0])
    sends: list[SendInfo] = []
    for i in range(n):
        reply = client.query("/live/track/get/send", track_index, i)
        # reply: (track_index, send_index, value)
        sends.append({"send_index": i, "value": float(reply[2])})
    return sends


#--------------------------------------------------------------------------------
# Clip editing — get / add / remove notes on existing clips, so we can
# iterate on patterns without delete-and-recreate cycles.
#--------------------------------------------------------------------------------

# AbletonOSC's get/remove notes use a wide default range to mean "everything".
# Mirror that convention in our MCP layer.
_ALL_PITCH_START = 0
_ALL_PITCH_SPAN = 128
_ALL_BEAT_START = -8192.0
_ALL_BEAT_SPAN = 16384.0


@mcp.tool()
def get_notes(
    track_index: int,
    clip_slot: int,
    start_pitch: int = _ALL_PITCH_START,
    pitch_span: int = _ALL_PITCH_SPAN,
    start_beat: float = _ALL_BEAT_START,
    beat_span: float = _ALL_BEAT_SPAN,
) -> list[Note]:
    """Read notes from an existing clip, optionally filtered by range.

    Default range covers all possible notes. Use `start_pitch`/`pitch_span`
    to filter by MIDI pitch range, `start_beat`/`beat_span` by time range.
    Filtering is inclusive of the start, exclusive of (start+span).

    Args:
        track_index: zero-based track index.
        clip_slot: zero-based clip slot (scene) index.
        start_pitch: lowest MIDI pitch to include (default 0).
        pitch_span: number of pitches to span (default 128 = all).
        start_beat: earliest beat to include (default -8192, effectively all).
        beat_span: number of beats to span (default 16384, effectively all).

    Returns:
        List of notes in the clip matching the filter.
    """
    client = _get_client()
    reply = client.query(
        "/live/clip/get/notes",
        track_index, clip_slot,
        int(start_pitch), int(pitch_span),
        float(start_beat), float(beat_span),
    )
    # reply: (track_index, clip_slot, pitch, start, duration, velocity, mute, ...)
    # Each note = 5 values; mute is dropped from our Note shape.
    notes: list[Note] = []
    for i in range(2, len(reply), 5):
        notes.append({
            "pitch": int(reply[i]),
            "start_beat": float(reply[i + 1]),
            "duration_beat": float(reply[i + 2]),
            "velocity": int(reply[i + 3]),
        })
    return notes


@mcp.tool()
def add_notes_to_clip(
    track_index: int,
    clip_slot: int,
    notes: list[Note],
) -> AddNotesResult:
    """Add notes to an existing clip without removing what's already there.

    Use this to iterate ("make the bassline 2x denser", "add ghost notes
    between the kicks") without delete+recreate. For a full replacement,
    use `delete_clip` + `create_clip` instead.

    Args:
        track_index: zero-based track index.
        clip_slot: zero-based clip slot (scene) index.
        notes: list of notes to add. Same shape as `create_clip`.

    Raises:
        ValueError: invalid note (pitch/velocity/timing).
    """
    if not notes:
        raise ValueError("notes list is empty")
    for i, note in enumerate(notes):
        _validate_note(note, i)

    client = _get_client()
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
        "added_count": len(notes),
    }


@mcp.tool()
def remove_notes(
    track_index: int,
    clip_slot: int,
    start_pitch: int = _ALL_PITCH_START,
    pitch_span: int = _ALL_PITCH_SPAN,
    start_beat: float = _ALL_BEAT_START,
    beat_span: float = _ALL_BEAT_SPAN,
) -> RemoveNotesResult:
    """Remove notes from a clip in a pitch/time range. Default removes all.

    The range defines a rectangle in the piano roll; notes whose start
    falls inside get removed. Pass narrower ranges to surgically delete
    specific note groups (e.g. all hi-hats: `start_pitch=42`, `pitch_span=1`).

    Args:
        track_index: zero-based track index.
        clip_slot: zero-based clip slot (scene) index.
        start_pitch: lowest MIDI pitch to remove (default 0).
        pitch_span: number of pitches to span (default 128 = all).
        start_beat: earliest beat to remove from (default -8192).
        beat_span: number of beats to span (default 16384).
    """
    client = _get_client()
    client.send(
        "/live/clip/remove/notes",
        track_index, clip_slot,
        int(start_pitch), int(pitch_span),
        float(start_beat), float(beat_span),
    )
    time.sleep(LIVE_TICK_SEC)
    return {"track_index": track_index, "clip_slot": clip_slot}


#--------------------------------------------------------------------------------
# Samples — load actual audio (vocal chops, drum hits, percussion loops)
# instead of synthesizing everything from MIDI.
#--------------------------------------------------------------------------------


@mcp.tool()
def list_samples(path: str = "", offset: int = 0) -> PaginatedSampleList:
    """List child names in Live's sample browser, with pagination.

    Walks `app.browser.samples`. Empty path returns top-level entries
    (typically file names in the flat root of the samples library, or
    pack-named folders depending on Live install). Drill in with
    slash-separated paths.

    The samples library can be huge (hundreds of files per folder).
    Reply is byte-capped to fit one OSC packet (~7.5 KB); when
    truncated, use `offset = previous offset + len(children)` to fetch
    the next page. `total_count` tells you when you're done
    (`offset + len(children) >= total_count`).

    Args:
        path: slash-separated sample-browser path; "" for top-level.
        offset: zero-based index to start listing from (default 0).
    """
    client = _get_client()
    reply = client.query(
        "/live/browser/list_samples", path, int(offset), timeout=3.0
    )
    # reply: (path, offset, total_count, name1, name2, ...)
    return {
        "path": str(reply[0]),
        "offset": int(reply[1]),
        "total_count": int(reply[2]),
        "children": [str(x) for x in reply[3:]],
    }


@mcp.tool()
def load_sample(track_index: int, sample_path: str) -> LoadSampleResult:
    """Load a sample onto a MIDI track. Live wraps it in a Simpler.

    The sample becomes playable via MIDI — triggering any pitch plays
    the sample transposed from its root note. Useful for vocal chops
    (write a melodic MIDI clip that "plays" the vocal), drum one-shots
    (one note per hit), or texture/atmosphere samples.

    Loaded as the track's instrument, so it replaces any existing
    instrument on the track. For drum-rack-style multi-sample mapping,
    load onto a Drum Rack pad instead (TODO: not yet exposed).

    Args:
        track_index: zero-based MIDI track index.
        sample_path: slash-separated browser path under `app.browser.samples`.

    Fire-and-forget (sample loads can be slow on first call — Live indexes
    the file).
    """
    client = _get_client()
    client.send("/live/track/load_sample", track_index, sample_path)
    time.sleep(LIVE_TICK_SEC * 3)  # samples take longer than presets
    return {"track_index": track_index, "sample_path": sample_path}


@mcp.tool()
def load_sample_to_drum_pad(
    track_index: int,
    device_index: int,
    pad_pitch: int,
    sample_path: str,
) -> LoadSampleToDrumPadResult:
    """Load a sample onto a specific pad of a Drum Rack.

    Lets you swap a single drum (e.g. replace the kick) for a real
    sample without touching the rest of the kit. The Drum Rack must
    already exist on the track — typically loaded via `load_drum_kit`
    or as part of a Live default project.

    `pad_pitch` is the MIDI note that triggers the pad. By standard
    convention: 36 = kick, 38 = snare, 39 = clap, 42 = closed hat,
    46 = open hat, 49 = crash, 51 = ride. Drum Racks normally start
    at C1 (36) and Live's GM-style Drum Rack presets match this.

    Args:
        track_index: zero-based track index containing the Drum Rack.
        device_index: zero-based device index of the Drum Rack on
            the track.
        pad_pitch: MIDI note (0-127) of the target pad.
        sample_path: slash-separated path under `app.browser.samples`.
    """
    client = _get_client()
    client.send(
        "/live/track/load_sample_to_drum_pad",
        track_index, device_index, pad_pitch, sample_path,
    )
    time.sleep(LIVE_TICK_SEC * 3)
    return {
        "track_index": track_index,
        "device_index": device_index,
        "pad_pitch": pad_pitch,
        "sample_path": sample_path,
    }


@mcp.tool()
def list_drum_pads(track_index: int, device_index: int) -> list[DrumPadInfo]:
    """List the populated pads of a Drum Rack with their MIDI note and name.

    Returns one entry per pad that has content (a sample/instrument loaded),
    ordered by MIDI note. Empty pads are omitted. Use this to see what's
    already in a kit before swapping a drum with `load_sample_to_drum_pad`
    (e.g. "which note is the snare on?"). Returns an empty list if the device
    at `device_index` is not a Drum Rack.

    Args:
        track_index: zero-based track index containing the Drum Rack.
        device_index: zero-based device index of the Drum Rack on the track.
    """
    client = _get_client()
    reply = client.query("/live/device/get/drum_pads", track_index, device_index)
    # reply: (track_index, device_index, note1, name1, note2, name2, ...)
    pad_data = reply[2:]
    return [
        {"note": int(pad_data[i]), "name": str(pad_data[i + 1])}
        for i in range(0, len(pad_data), 2)
    ]


#--------------------------------------------------------------------------------
# Clip automation — write step-style envelopes on a clip's device or mixer
# parameters. Each step is a constant-value segment; for smooth ramps,
# pass many small adjacent steps. The envelopes loop with the clip.
#--------------------------------------------------------------------------------


def _flatten_steps(steps: list[AutomationStep]) -> list[float]:
    """Validate steps and flatten to (time, length, value)*N for OSC."""
    if not steps:
        raise ValueError("steps list is empty")
    flat: list[float] = []
    for i, step in enumerate(steps):
        start = float(step["start_beat"])
        length = float(step["length_beats"])
        value = float(step["value"])
        if start < 0:
            raise ValueError(f"step[{i}]: start_beat {start} must be >= 0")
        if length <= 0:
            raise ValueError(f"step[{i}]: length_beats {length} must be > 0")
        flat.extend([start, length, value])
    return flat


@mcp.tool()
def automate_device_parameter(
    track_index: int,
    clip_slot: int,
    device_index: int,
    parameter_index: int,
    steps: list[AutomationStep],
) -> AutomationResult:
    """Write step automation for a device parameter into a clip's envelope.

    Each step is a constant-value segment `[start_beat, start_beat+length_beats)`.
    For a smooth ramp (filter sweep, crescendo), pass many small adjacent
    steps — e.g. 64 steps of 0.25 beats each across 16 beats, with values
    interpolated linearly from start to end.

    The envelope loops with the clip, so a 16-beat sweep on a 4-bar clip
    re-runs each loop.

    Use `get_device_parameters` first to discover (device_index, parameter_index,
    min, max). Step values must be inside [min, max] or Live silently clamps.

    Args:
        track_index: track holding the device.
        clip_slot: clip slot index (must already contain a clip).
        device_index: device index on the track.
        parameter_index: parameter index within the device.
        steps: list of step segments to write.
    """
    flat = _flatten_steps(steps)
    client = _get_client()
    client.send(
        "/live/clip/automate_device_parameter",
        track_index, clip_slot, device_index, parameter_index,
        *flat,
    )
    time.sleep(LIVE_TICK_SEC)
    return {
        "track_index": track_index,
        "clip_slot": clip_slot,
        "step_count": len(steps),
    }


@mcp.tool()
def automate_mixer_parameter(
    track_index: int,
    clip_slot: int,
    parameter: str,
    steps: list[AutomationStep],
) -> AutomationResult:
    """Write step automation for a mixer parameter (volume / pan / send).

    `parameter` is one of:
        "volume"  — normalized 0.0-1.0 (0.85 ≈ 0 dB unity)
        "panning" — -1.0 (full left) to 1.0 (full right)
        "send_N"  — N is the zero-based return index; value 0.0-1.0

    Common use cases:
    - "Sidechain duck" via automation: write a quick volume drop on the bass
      clip at each kick position, recovering between hits — tighter than
      a real sidechain compressor for some genres.
    - Reverb send swell: gradually raise `send_N` value over the clip
      length for a building wash.

    Args:
        track_index: track whose clip and mixer to automate.
        clip_slot: clip slot index (must already contain a clip).
        parameter: "volume" | "panning" | "send_N".
        steps: list of step segments to write.
    """
    flat = _flatten_steps(steps)
    client = _get_client()
    client.send(
        "/live/clip/automate_mixer_parameter",
        track_index, clip_slot, parameter,
        *flat,
    )
    time.sleep(LIVE_TICK_SEC)
    return {
        "track_index": track_index,
        "clip_slot": clip_slot,
        "step_count": len(steps),
    }


@mcp.tool()
def re_enable_automation() -> TransportResult:
    """Re-enable any automation that Live has currently disabled.

    Live marks a parameter "automation disabled" (orange dot in the UI)
    whenever you touch a knob mid-playback or in some cases when
    automation is added via the API. This call re-enables all
    automation song-wide, equivalent to clicking Live's
    "Re-Enable Automation" button.

    Our `automate_*` tools already re-enable per-parameter after writing,
    so this is rarely needed — useful mainly after manual UI tweaks that
    might have orphaned an envelope.
    """
    client = _get_client()
    client.send("/live/song/re_enable_automation")
    return {"action": "automation re-enabled"}


@mcp.tool()
def clear_clip_envelopes(
    track_index: int, clip_slot: int
) -> ClearEnvelopesResult:
    """Remove all automation envelopes from a clip.

    Resets every automated parameter to its static value. Doesn't touch
    notes or other clip properties.

    Args:
        track_index: track holding the clip.
        clip_slot: clip slot index.
    """
    client = _get_client()
    client.send("/live/clip/clear_envelopes", track_index, clip_slot)
    time.sleep(LIVE_TICK_SEC)
    return {"track_index": track_index, "clip_slot": clip_slot}


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
