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


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
