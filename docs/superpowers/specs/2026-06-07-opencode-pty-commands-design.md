# OpenCode PTY-aware command templates

**Date:** 2026-06-07
**Status:** Approved

## Problem

The OpenCode autostart snippet (`templates/opencode/autostart-snippet.md`) already
documents a "PTY-first execution rule": prefer the `opencode-pty` plugin over
blocking Bash for long-running PMC processes (enrichment, file watching,
refresh-context), and detects `HAS_PTY` via `pty_list` at session start.

However, the four individual slash-command templates that wrap PMC operations —
`enrich.md`, `enrich-status.md`, `refresh-context.md`, `sync-context.md` (in
`tools/project-memory-context/templates/opencode/commands/`) — only declare
`allowed-tools: [Bash]` and invoke `{{PMC_BIN}}` directly through Bash. They never
check for or use PTY, so an agent following `/enrich` or `/refresh-context` runs
these as blocking Bash calls even when `opencode-pty` is installed and the
autostart already established `HAS_PTY = true`.

The user wants all four commands to prefer PTY when available, while continuing
to invoke the **global** `pmc` binary (already resolved through the `{{PMC_BIN}}`
placeholder, which expands to `pmc` — the package's `bin` entry — at install
time via `template-installer.mjs`). No change is needed to how `{{PMC_BIN}}`
resolves; it already avoids hardcoding install paths.

Separately: `pmc watch` already exists as a registered subcommand
(`cli/watch.mjs`, wired in `src/command-dispatch.mjs`) and is already invoked via
PTY in the autostart snippet — no new command is required there.

## Goals

- Each of the four command templates (`enrich`, `enrich-status`,
  `refresh-context`, `sync-context`) detects PTY availability and prefers
  `pty_spawn` over Bash when available.
- All four fall back to the existing `{{PMC_BIN)}` + Bash invocation when PTY is
  unavailable (current behavior is preserved as the fallback).
- `allowed-tools` frontmatter in each template lists the PTY tools alongside
  `Bash`.
- No change to `{{PMC_BIN}}` resolution, no new PMC subcommands, no change to
  `pmc watch`.

## Non-goals

- Changing the autostart snippet's existing PTY policy (it already covers
  `enrich` and `watch` correctly).
- Adding a one-line "install opencode-pty" reminder to each of these four
  commands — that pitch already lives in the autostart and would be noisy if
  repeated on every `/enrich-status` invocation.
- Publishing a new package version or running the installer against consumer
  repos (covered separately in rollout notes below, as an operational follow-up
  for the user, not part of this implementation).

## Design

### Shared pattern added to each template

Each template gains a short "PTY-first execution" section, placed before the
existing execution steps, structured as:

1. **Detect**: Call `pty_list`. Success (even empty list) → `HAS_PTY = true`;
   failure or tool absent → `HAS_PTY = false`. (Same detection already used in
   the autostart — no new convention introduced.)
2. **If `HAS_PTY = true`**: launch via `pty_spawn` with `command: "{{PMC_BIN}}"`,
   the relevant `args`, a command-specific `title`/`description`, and
   `notifyOnExit: true`. Use `pty_read` to inspect output when the command's
   result needs to be parsed (e.g., `enrich-status` JSON, `sync-context`
   summary) and `pty_kill` if the agent needs to stop a hung session.
3. **If `HAS_PTY = false`**: fall back to the existing Bash invocation —
   unchanged from current template content.

### Per-template specifics

- **`enrich.md`**: Step 2 ("Launch Ollama") gains a PTY branch:
  `pty_spawn { command: "{{PMC_BIN}}", args: ["enrich", "."], title: "PMC Enrichment", notifyOnExit: true }`,
  superseding the `--background` Bash invocation when PTY is available (PTY
  gives crash recovery + inspectable output, making `--background` unnecessary).
  The watchdog loop in Step 3 stays as-is (it already reads state from
  `enrich-status`, independent of how the process was launched).

- **`enrich-status.md`**: wrap the single `{{PMC_BIN}} enrich-status` call —
  PTY branch spawns it, reads output via `pty_read`, and (since this is a
  one-shot status check, not a persistent session) closes the PTY session after
  reading. Bash branch unchanged.

- **`refresh-context.md`**: PTY branch spawns
  `{{PMC_BIN}} refresh-context [--enrich]` with `title: "PMC Refresh Context"`,
  `notifyOnExit: true`. The "After running" guidance (run `enrich .
  --background` then `sync-context`, or just `sync-context` if `--enrich` was
  passed) is rephrased to route those follow-up invocations through the same
  PTY-first pattern rather than hardcoding Bash.

- **`sync-context.md`**: PTY branch spawns `{{PMC_BIN}} sync-context`, reads the
  summary via `pty_read`, closes the session. Bash branch unchanged.

### Frontmatter changes

Each template's `allowed-tools` list gains `pty_list`, `pty_spawn`, `pty_read`,
`pty_kill` alongside the existing `Bash` entry.

## Rollout (operational notes, not implementation scope)

These templates are the installable source of truth, copied into consumer repos
by `pmc init` / `install-pmc`. To propagate this change to repos where PMC is
already installed:

1. Bump the package version and `npm publish` from
   `tools/project-memory-context/`.
2. In each consumer repo, update the global install:
   `npm install -g @aabadin/project-memory-context@latest` (or run via `npx
   --yes --package @aabadin/project-memory-context pmc init .` if using npx).
3. Re-run `pmc init .` (or the equivalent install-templates command) in each
   consumer repo — `install-pmc.mjs` already force-overwrites
   skills/commands on detecting the agent, so the new command templates replace
   the old ones in `.opencode/command/`.

This repo's root `AGENTS.md` already documents the PTY policy at the
session/autostart level and does not need changes — it is itself an "installed
instance" pattern, not the templates' source.

## Testing

These are Markdown instruction templates consumed by an LLM agent, not
executable code — there is no automated test surface. Validation is manual:
install the updated templates into a scratch consumer project (or this repo's
own `.opencode/command/` via `pmc init .`), confirm `pty_list` detection and
`pty_spawn` invocation read naturally and match the autostart's established
conventions, and confirm the Bash fallback path is intact and unchanged when
PTY is unavailable.
