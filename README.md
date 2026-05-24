# claude-ableton

Make music in **Ableton Live 12** by talking to Claude. This is a local MCP
server that lets Claude create tracks, load instruments / drum kits / samples,
write MIDI clips and chord progressions, mix, route sidechains, automate
parameters, build arrangements, and master — driving Live through
[AbletonOSC](https://github.com/ideoforms/AbletonOSC).

```
"Make a lo-fi beat at 82 BPM: Boom Bap drums, a warm Rhodes on
 Cmaj7 → Am7 → Dm7 → G7 with smooth voicing, a sub bass sidechained
 to the kick, and a tape-wobble auto-filter on the keys."
```

Everything materializes in your open Live set. ~81 tools, localhost-only, no
cloud round-trip for your audio.

---

## Requirements

- **macOS** (Windows support is planned).
- **Ableton Live 12** — Suite recommended (Intro/Standard ship fewer of the
  built-in instruments in the allowlist).
- A client that speaks MCP: **Claude Code**, **Claude Desktop**, or any other
  MCP client (Cursor, Codex, …).
- **Node 18+** *only* if you install via the `npx` path below. Claude Code and
  Claude Desktop bundle their own Node, so the plugin install needs nothing
  extra.

---

## Install

The plugin bundles the MCP server **and** the AbletonOSC Remote Script, and
**auto-updates** when the marketplace refreshes.

### Claude Code (plugin — recommended)

Run the slash commands to add the marketplace, then install:

```
/plugin marketplace add rohailaltaf/claude-ableton
/plugin install claude-ableton@claude-ableton
```

### Claude Desktop (plugin — recommended)

Use Claude Desktop's **Add marketplace** feature (in its plugin settings), add
`rohailaltaf/claude-ableton`, then install the **claude-ableton** plugin from it.
(The `/plugin` slash commands are Claude Code-only — Desktop uses the marketplace
UI instead.)

### Cursor, Codex, or any other MCP client (npx)

Add this to your client's MCP config (no install, no clone — `npx` fetches and
runs the latest from GitHub):

```json
{
  "mcpServers": {
    "ableton": {
      "command": "npx",
      "args": ["-y", "github:rohailaltaf/claude-ableton"]
    }
  }
}
```

---

## One-time Ableton setup

On its first launch the server installs the bundled AbletonOSC Remote Script
into your Live User Library automatically. You then enable it once:

1. Start (or restart) **Ableton Live**.
2. Open **Settings/Preferences → Link, Tempo & MIDI**.
3. Under **Control Surface**, select **AbletonOSC**. (Leave Input/Output set to
   None.)

<!-- TODO: add screenshot at docs/control-surface.png -->

That's it. The server checks the Remote Script version on every launch and
re-installs it if the plugin updated, so you stay in sync. (If you already keep
your own git checkout of AbletonOSC in `Remote Scripts/AbletonOSC`, the
installer leaves it untouched.)

---

## How it works

```
Claude (Code / Desktop / Cursor / …)
   │  MCP (stdio)
   ▼
claude-ableton  ──OSC──▶  127.0.0.1:11000  AbletonOSC Remote Script  ──▶  Live's LOM
                ◀──OSC──   127.0.0.1:11001
```

The bridge is **localhost-only** — there is no network listener and nothing is
reachable off your machine.

---

## What it can do (~81 tools)

- **Tracks & instruments** — create/duplicate/delete MIDI tracks; load any
  built-in Live 12 instrument (synths, samplers, racks, Drum Synths) or a named
  preset by browser path.
- **Clips & notes** — create MIDI clips, read/add/remove notes, rename, loop,
  color, quantize, duplicate.
- **Chord progressions** — parse chord symbols and write block chords with
  **smooth voice-leading** (common tones held) or literal root position.
- **Drums & samples** — load full drum kits, inspect Drum Rack pads, drop
  samples onto pads, or load a sample onto a track (Simpler-wrapped).
- **Browser** — list instruments, drums, audio/MIDI effects, samples, packs,
  plugins, sounds, clips, Max for Live, user library, current project.
- **Mixing** — volume, pan, mute, solo; device parameters; return tracks &
  sends; sidechain source/channel routing.
- **Mastering** — load effects on the Main track (Glue Compressor → Limiter),
  read/set master device params and output level.
- **Automation** — step envelopes for device and mixer parameters (volume / pan
  / sends); smooth ramps via many small steps.
- **Scenes & arrangement** — list/create/duplicate/rename/delete scenes; stamp
  Session clips onto the Arrangement timeline to build a finite track.
- **Transport & state** — play/stop/continue, fire scenes/clips, set/read
  tempo, time signature, playback position.

See [DESIGN.md](DESIGN.md) for conventions (pitch numbering, beat units, the
instrument allowlist) and design decisions.

---

## Limitations

- **Session-view authoring.** Notes and clips are written into the Session grid;
  to build a fixed track, stamp clips onto the Arrangement timeline with
  `duplicate_clip_to_arrangement` (the only LOM path to a linear arrangement).
- **4/4 assumed** when converting bars↔beats (you can still read the real time
  signature).
- **Step automation only.** Smooth curves are approximated with many small
  steps — Live's API doesn't expose breakpoint curves.
- **Live API ceilings** (not exposed by Live's scripting API, so not buildable):
  grouping tracks, saving/loading/exporting the Set, importing an audio file as a
  clip (hence the Simpler workaround), freezing/flattening, and clip follow
  actions (removed from the Clip API in Live 12).

---

## Security

This server grants Claude write access to your **active Ableton Live session**.
The OSC bridge is localhost-only (no network port), but treat it like any local
automation tool: review what Claude proposes before running it if you have
unsaved work. Use Live's Undo (Cmd+Z) freely.

---

## Development

```bash
git clone https://github.com/rohailaltaf/claude-ableton.git
cd claude-ableton
npm install
npm run package      # vendor the Remote Script + typecheck + bundle dist/index.js
```

- `npm run build` — bundle `src/` into a single `dist/index.js` (esbuild).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run vendor` — re-vendor the pinned AbletonOSC fork into `vendor/`.
- `node scripts/integration-test.mjs` — drive all 81 tools against a running
  Live (needs OSC port 11001 free and a scratch set open).

The server is bundled into one self-contained file with no runtime
dependencies, so the committed `dist/index.js` and `vendor/AbletonOSC` run
directly under the plugin.

---

## License & credits

[MIT](LICENSE) © Rohail Altaf.

Built on [**AbletonOSC**](https://github.com/ideoforms/AbletonOSC) by Daniel
Jones / ideoforms (MIT) — a (lightly extended) fork is bundled here; its license
and attribution are preserved in `vendor/AbletonOSC/LICENSE.md`.
