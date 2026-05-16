# claude-ableton

A local MCP server that lets [Claude](https://claude.ai) create tracks, load instruments, and write MIDI clips in Ableton Live 12.

> **Pre-release**: no working implementation yet. See [DESIGN.md](DESIGN.md) for the architecture and scope. The install instructions below describe the intended v0.1 flow.

## Compatibility

- macOS
- Ableton Live 12 **Suite** (Intro/Standard are missing several instruments in the allowlist)
- Claude Desktop

## Install

### 1. AbletonOSC

This server talks to Live through [AbletonOSC](https://github.com/ideoforms/AbletonOSC), a Remote Script that exposes Live's Object Model over OSC.

```bash
mkdir -p ~/Music/Ableton/User\ Library/Remote\ Scripts
git clone https://github.com/ideoforms/AbletonOSC.git \
  ~/Music/Ableton/User\ Library/Remote\ Scripts/AbletonOSC
cd ~/Music/Ableton/User\ Library/Remote\ Scripts/AbletonOSC
git checkout 0ca68214bd62c9b5cb641ca34006cfd70ba94430
```

Restart Live, then go to **Preferences → Link, Tempo & MIDI → Control Surface** and select **AbletonOSC**.

Smoke-test the bridge (TODO: ship `scripts/ping.py`):

```bash
python scripts/ping.py   # expects a reply from /live/test within 500ms
```

### 2. The MCP server

```bash
# TODO: pip / uv install instructions once the package ships
```

### 3. Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ableton": {
      "command": "claude-ableton"
    }
  }
}
```

Restart Claude Desktop.

## Usage

With Live open and Claude Desktop running, try:

> "Create a MIDI track, load Wavetable on it, and write a four-bar Cmaj7 → Am7 → Fmaj7 → G7 progression in quarter notes."

## Tools

| Tool | Purpose |
|---|---|
| `create_midi_track(name?)` | Add a MIDI track. |
| `load_instrument(track_index, instrument)` | Load a built-in Live instrument from the allowlist. |
| `create_clip(track_index, clip_slot, length_bars, notes)` | Create a MIDI clip and write notes. |
| `chord_progression(track_index, clip_slot, chords, rhythm)` | Write a chord progression. |

See [DESIGN.md](DESIGN.md) for conventions (pitch numbering, beat units, instrument allowlist).

## Security

This server grants Claude write access to your active Ableton Live session. The bridge is localhost-only (no network port), but treat it as you would any local automation tool — review what Claude proposes before it runs if you have unsaved work.

## License

[MIT](LICENSE).
