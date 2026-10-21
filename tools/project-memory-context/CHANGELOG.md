# Changelog

All notable changes to `@aabadin/project-memory-context` (the `pmc`
CLI) are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.10.1] — Pending Release

### Added

- **Production native pipeline integration** — `map-project` and
  `refresh-context` directly materialize canonical identities, native
  call/import relations, deterministic roles, and symbol index from source.
- **Top-level flags** — `--help` and `--version` support on the root `pmc`
  CLI, resolving package version dynamically and preserving subcommands.

### Changed

- **Graphify override & availability detection** — respects `PMC_GRAPHIFY_PATH`
  and detects an available host Graphify executable before falling back to
  pip installation.
- **Dynamic MCP package version** — `pmc-query-server` reports the actual
  installed package version instead of a hardcoded version.

## [0.10.0] — 2026-10-20

Changes since the published `0.9.1`.

### Added

- **Unified client-adapter installer** — detection, planning, isolated
  execution, verification and reporting through one pipeline, with
  adapters for OpenCode, Claude Code, Cursor, Antigravity, generic, Codex,
  Kimi and Pi.
- **Native call/import relations** with canonical symbol identity, typed
  `graph.db` facts and file cards.
- **Role classification** (`generic`, `node-cli` and framework profiles,
  plus project `roles.json` overrides) exposed in facts, cards and
  `get-context`.
- **Opt-in structured narratives** — schema validation, call-order (SCC)
  batching, trivial-symbol templates, `narrativeHash` invalidation and a
  `PMC_CONCURRENCY` bounded pool. Text output remains the default.
- **Role-aware MCP tools** — `pmc_relations` gains `stopAtRole`;
  new `pmc_entrypoints_for`, `pmc_impact` (deterministic PageRank) and
  `pmc_card` levels `compact` / `extended` / `deep` with token ceilings.
- **Aggregate cards** — MCP tools `pmc_file_rollup`, `pmc_community_card`
  and `pmc_feature_card`, plus the `pmc card file|community|feature` CLI.
  They use only accepted narratives with explicit provenance.

### Changed

- **Pi**: the Pi adapter (`pmc install-pmc --pi` or `--client=pi`, or
  auto-detected from a project `.pi/` directory) writes native Pi 1.3
  `.pi/mcp.json` (`mcpServers`, stdio). It no longer registers `pi-mcp-adapter`, which
  replaces Pi's built-in MCP; existing `.pi/settings.json` is left untouched.
- **Kimi**: `.kimi-code/mcp.json` now uses the standard MCP stdio format
  and registers both `pmc-query` and `pmc-agent-memory`.
- **Codex**: project `.codex/config.toml` is merged programmatically
  (TOML), replacing the static snippet.
- Agent instruction templates advertise the full MCP tool surface.
- The eight pre-existing MCP tool descriptors and default `pmc_card`
  output are unchanged.

### Removed

- `templates/codex/config.toml.snippet` and `templates/kimi/mcp.json.snippet`
  (superseded by the adapters above).

### Dependencies

- Added `smol-toml` for lossless TOML config merging.

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