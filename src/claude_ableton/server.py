"""MCP server: tools for driving Ableton Live via AbletonOSC."""

from __future__ import annotations

import time

from mcp.server.fastmcp import FastMCP

from claude_ableton.osc import AbletonClient

LIVE_TICK_SEC = 0.15

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


@mcp.tool()
def create_midi_track(name: str | None = None) -> dict[str, int]:
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


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
