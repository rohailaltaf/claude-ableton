# Agent Skills

Bundled [Agent Skills](https://code.claude.com/docs/en/plugins#add-skills-to-your-plugin)
that ship with the `claude-ableton` plugin. Each skill is a subdirectory
containing a `SKILL.md` (YAML frontmatter `name`/`description` + the recipe).
Skills are auto-discovered and namespaced as `claude-ableton:<skill-name>` —
they trigger automatically when a request matches their description.

## Shipped

- **mastering-chain** — Glue Compressor → (EQ Eight) → Limiter on the Main
  track with conservative, streaming-safe settings. Triggers on "master the
  track", "make it louder", "polish the mix", etc.

## Planned

Genre starters (lo-fi, hip-hop beats), sampling/chop workflows, sidechain
pumping, humanize/groove recipes — higher-level musical knowledge built on
top of the MCP tools.
