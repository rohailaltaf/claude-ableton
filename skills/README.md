# Agent Skills (future)

This directory is reserved for bundled [Agent Skills](https://code.claude.com/docs/en/plugins#add-skills-to-your-plugin)
that ship with the `claude-ableton` plugin. Each skill is a subdirectory
containing a `SKILL.md` (with YAML frontmatter `name`/`description`) plus any
supporting `reference.md` or `scripts/`.

Planned skills (not yet written): genre starters (e.g. lo-fi, hip-hop beats),
sampling/chop workflows, and mixing/mastering recipes — higher-level recipes
built on top of the MCP tools.

Skills are auto-discovered and namespaced as `claude-ableton:<skill-name>`.
