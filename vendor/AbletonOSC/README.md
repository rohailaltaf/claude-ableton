# AbletonOSC (Rohail's fork)

A lightweight fork of [**AbletonOSC**](https://github.com/ideoforms/AbletonOSC)
by **Daniel Jones / ideoforms**, extended with some extra OSC handlers that power
the [**claude-ableton**](https://github.com/rohailaltaf/claude-ableton) MCP
plugin (Claude driving Ableton Live).

This fork exists only to keep that plugin in sync — it isn't a replacement for
the original. For the full project, installation guide, and the canonical OSC API
reference, head to the original repo:

**→ https://github.com/ideoforms/AbletonOSC**

Big shout out to Daniel Jones for the original work.

## What's extended here

On top of upstream AbletonOSC, this fork adds OSC handlers for:

- loading instruments and presets by browser path
- browsing more of Live's browser tree (drums, audio/MIDI effects, samples,
  packs, plugins, sounds, user library, current project, Max for Live)
- Master / Main-track device control (mastering chains)
- Arrangement clip writing and listing
- clip quantization
- Drum Rack pad introspection and per-pad sample loading
- device input (sidechain) routing
- return tracks
- step automation envelopes (device and mixer parameters)

## License

MIT — same as the original. See [LICENSE.md](LICENSE.md). All original copyright
and attribution to Daniel Jones / ideoforms is retained.
