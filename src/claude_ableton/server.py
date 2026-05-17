"""MCP server: tools for driving Ableton Live via AbletonOSC."""

from __future__ import annotations

import time
from typing import TypedDict

from mcp.server.fastmcp import FastMCP

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
    if length_bars <= 0:
        raise ValueError(f"length_bars must be > 0 (got {length_bars})")

    notes = notes or []
    for i, note in enumerate(notes):
        _validate_note(note, i)

    client = _get_client()

    # Collision check
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


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
