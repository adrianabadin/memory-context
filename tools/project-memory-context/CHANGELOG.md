# Changelog

All notable changes to `@aabadin/project-memory-context` (the `pmc`
CLI) are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.9.0] — 2026-07-29

### Added

- **OpenAI Codex CLI (`--codex`) and Kimi Code (`--kimi`) support** —
  two new auto-detected agents in `pmc setup`. The install writes the
  shared AGENTS.md autostart snippet plus a per-agent MCP config file
  (`.codex/config.toml` for Codex, `.kimi-code/mcp.json` for Kimi),
  merged non-destructively. Detection markers: `.codex/` and
  `.kimi-code/`. Codex requires the user to accept its project-trust
  prompt once on first run before the project config loads. Kimi's
  `.kimi-code/local.toml` is user-owned and **never** touched by PMC.
  No slash-command / skill templates this pass — neither tool has a
  documented file convention yet. See
  `docs/plans/2026-07-29-add-codex-kimi-agent-support-design.md` for
  the confirmed config schemas and the rationale.

- **`pmc repair-sync-manifest`** (`cli/repair-sync-manifest.mjs`) —
  recover a corrupted `sync-manifest.json` that contains concatenated or
  truncated JSON documents. It extracts every complete top-level document,
  merges entries de-duplicated by `id` (last write wins), writes a
  timestamped `.bak-<timestamp>` backup, and atomically rewrites a single
  valid manifest. If nothing is recoverable it fails without mutating the
  file. Pure recovery logic lives in `src/manifest-recovery.mjs`
  (`parseConcatenatedManifests`, `recoverManifestEntries`,
  `repairManifestFile`).

  Usage: `node cli/repair-sync-manifest.mjs <project-root>` then re-run
  `pmc sync-context`.

- **13 unit tests** for the recovery module and atomic-write contract
  (`tests/manifest-recovery.test.mjs`, plus the `writeSyncManifest
  atomicity` suite in `tests/sync-manifest.test.mjs`).

### Fixed

- **Atomic `sync-manifest.json` writes** — `writeSyncManifest`
  (`src/sync-manifest.mjs`) now writes to a process- and call-unique
  temporary file and `rename`s it onto the final path. rename(2) is
  atomic on the same filesystem, so concurrent PMC processes (enrich
  workers, file watcher, `pmc sync-context`) can no longer expose a
  partially written or concatenated JSON document to readers, nor clobber
  each other's temp file. This is the root cause of `pmc sync-context`
  failures like `Unexpected non-whitespace character after JSON at
  position N` and `Unterminated string in JSON`.

## [0.8.0] — 2026-06-24

### Added

- **`pmc memory-protocol`** — read or set the runtime dual-save memory
  protocol flag. The flag lives at
  `.planning/project-memory-context/memory-protocol.json` with values
  `dual` (default — mirror saves to both PMC and Engram) or
  `pmc-only` (after the Engram uninstall — save only to PMC). The
  detection logic in `src/memory-protocol.mjs` checks Engram CLI
  availability + PMC DB path accessibility to suggest a value when no
  flag file exists. Useful during the parallel-run validation phase
  after `engram-parity-final`.
- **`pmc verify-memory-parity`** — audit recent saves on both PMC and
  Engram and report drift. The default window is 60 minutes; override
  with `--window-minutes N`. Exits non-zero when one backend has
  writes the other does not in the window. Useful as a weekly cron or
  as a pre-commit gate during the parallel-run phase.
- **`src/memory-protocol.mjs`** — pure logic module backing the
  `pmc memory-protocol` CLI. Exports `detectMemoryProtocol`,
  `mapEngramTypeToPmcCategory`, `buildPmcPayloadFromEngramSave`,
  `formatProtocolReport`, `isValidProtocolVersion`. All functions are
  dependency-injected and pure (no module-level I/O), which makes the
  unit tests trivial.
- **`src/cli/memory-protocol.mjs`** — CLI wrapper for the protocol flag.
- **`src/cli/verify-memory-parity.mjs`** — CLI wrapper for parity
  verification.
- **20 unit tests** for the new module + CLIs (`tests/memory-protocol.test.mjs`
  + `tests/verify-memory-parity.test.mjs`), all using `node --test`.
- **`pmc-agent-memory_get_memory_protocol`** MCP tool (delivered with
  `agent-memory-mcp@2.2.0`, surfaced here for completeness) exposes the
  same flag to MCP clients so agents can read it without spawning a CLI.
  See the companion `agent-memory-mcp` changelog for the full set of
  MCP tool additions in this cycle.

### Changed

- **`src/command-dispatch.mjs`** — `COMMANDS` Map registers
  `memory-protocol` and `verify-memory-parity` (placed after
  `enrich-status`, alphabetical order preserved). No other subcommand
  behaviour changed.
- **`AGENTS.md`** — Memory Protocol section is now canonical: declares
  the trigger conditions as the single source of truth, references
  the new skill, and documents the runtime flag + audit pattern. Older
  duplicated trigger descriptions elsewhere in the file are removed.

### Migration notes

- v0.7.x → v0.8.0: additive. No breaking changes to existing
  subcommands. New `memory-protocol.json` is only created when you
  run `pmc memory-protocol --set`. No data migration required.
- When `engram-parity-final` is fully shipped and you have validated
  the parallel run for 1+ weeks, run:
  ```bash
  pmc memory-protocol . --set pmc-only
  ```
  to stop mirroring saves to Engram. The change is reversible
  (`--set dual`) for emergencies.

## [0.7.1] — 2026-06 (approx)

- Prior stable baseline. Existing CLI surface (setup, map-project,
  enrich, get-context, enrich-status, doctor, init-project,
  sync-context, sanitize, project-context), OpenCode plugin
  bootstrap, session-start runtime, file watcher, and the 9 base
  project-context memories.