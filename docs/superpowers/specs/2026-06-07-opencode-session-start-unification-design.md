# OpenCode Session-Start Unification Design

Date: 2026-06-07
Status: approved-design
Scope: Replace manual, model-driven PMC startup checks in OpenCode with a single zero-token Node runtime reused by both the CLI and the OpenCode plugin.

## Goal

Make PMC startup in OpenCode deterministic, non-blocking, and zero-token for all purely mechanical work.

The intended result is:

- one canonical Node startup runtime for PMC session initialization
- no model-side startup loops that manually run `pty_list`, `glob`, `agent-memory_search`, or ad hoc file reads
- background enrichment launch when needed without blocking the user
- a persisted startup snapshot on disk so the agent or user can inspect the result later without reconstructing it
- OpenCode docs and snippets that describe the real behavior instead of a Claude Code style SessionStart hook that OpenCode does not have

## Non-Goals

- Implementing true PTY-backed startup directly from the OpenCode plugin runtime in this iteration
- Adding automatic startup context injection into the OpenCode chat stream if the platform does not expose a SessionStart-style output channel
- Replacing the existing OpenCode `tool.execute.after` refresh hook with a long-running filesystem watcher
- Automatically running `pmc sync-context` during startup
- Automatically draining the large-symbol subagent queue during startup

## Problem Statement

The repository already contains a unified PMC startup command at `tools/project-memory-context/cli/session-start.mjs`, but the OpenCode experience is still split across three different layers:

- the CLI has a Node-based `pmc session-start` flow
- the OpenCode plugin only launches enrichment and rehydrates the refresh hook
- the OpenCode autostart snippet still implies a SessionStart-hook style startup path that OpenCode does not actually provide

This gap causes a fallback behavior where the model performs startup work inside the chat session.

The `iniciodd.md` log is an example of that fallback path. It records a model-driven startup sequence that manually executed checks like:

- `pty_list`
- `glob` over `.planning/project-memory-context/**`
- `agent-memory_search` for project context
- multiple reads of materialized PMC files

That log is useful for debugging, but it is not the desired steady-state behavior.

## Current Context

Relevant files today:

- `tools/project-memory-context/cli/session-start.mjs`
  - already computes startup status, sync count, and project context overview from disk
  - already launches enrichment plus watchdog when needed
- `tools/project-memory-context/plugin/index.mjs`
  - injects PMC MCP config into OpenCode
  - rehydrates the debounce-based refresh hook
  - currently calls only `launchEnrichmentIfNeeded()` during plugin startup
- `tools/project-memory-context/src/template-installer.mjs`
  - installs a real SessionStart hook script for Claude Code
  - writes the OpenCode autostart snippet into `AGENTS.md`
- `tools/project-memory-context/templates/opencode/autostart-snippet.md`
  - currently says startup is handled by the `pmc session-start` hook installed by `pmc setup`
  - that statement is accurate for Claude Code, but misleading for OpenCode

Important platform constraint:

- OpenCode PTY support exists at the agent tool layer (`pty_spawn`, `pty_read`, etc.)
- the PMC OpenCode plugin is plain Node code running in the plugin lifecycle, not an agent tool caller
- therefore the plugin cannot reliably invoke PTY tools directly as part of a zero-token startup path

That means the correct zero-token backend today is detached Node child processes, not PTY.

## Recommended Approach

Use a single shared Node runtime as the source of truth for PMC startup behavior, and have both the CLI and the OpenCode plugin call it.

This is Option 2 from the design discussion.

Rationale:

- preserves zero-token startup for mechanical work
- removes duplicated startup logic between the CLI path and the plugin path
- matches the user's priority: zero tokens first, non-blocking second, PTY only if the platform can support it cleanly
- keeps OpenCode behavior honest: plugin startup does real work, while the chat instructions become fallback documentation instead of the primary execution path

## Functional Requirements

### 1. Single source of truth runtime

Introduce a shared runtime module, tentatively:

- `tools/project-memory-context/src/session-start-runtime.mjs`

This module becomes the canonical implementation for PMC startup decisions.

It is responsible for:

- detecting whether PMC is installed in the current project
- reading enrichment status from disk
- deciding whether to launch background enrichment and watchdog
- reading `sync-manifest.json` pending count
- loading project-context overview from materialized disk artifacts
- collecting subagent queue summary
- writing a persisted startup snapshot

It should return a structured object rather than formatted text.

Example shape:

```json
{
  "hasPmc": true,
  "projectRoot": "C:/repo",
  "status": { "state": "idle", "worklist": { "pending": 0, "enriched": 42, "errors": 0 } },
  "launch": { "attempted": false, "launchedEnrichment": false, "launchedWatchdog": false, "backend": "detached-node" },
  "syncPending": 3,
  "subagentPending": 0,
  "overview": [
    { "kind": "architecture-current", "title": "Architecture", "summary": "..." }
  ],
  "snapshot": {
    "jsonPath": "...",
    "markdownPath": "..."
  },
  "warnings": []
}
```

### 2. OpenCode plugin startup must run the shared runtime

During OpenCode plugin initialization, `plugin/index.mjs` must stop calling only `launchEnrichmentIfNeeded()` and instead execute the shared startup runtime.

Desired flow inside `config()`:

1. Read install state.
2. Inject PMC MCP config.
3. Rehydrate the refresh-hook controller.
4. Execute shared session-start runtime in silent mode.
5. Swallow all runtime errors so OpenCode startup never fails because PMC startup failed.

Silent mode means:

- no stdout intended for chat injection
- no model tool calls
- no blocking prompt
- only disk reads, in-memory summary building, and optional detached background process launches

### 3. CLI `pmc session-start` becomes a formatter wrapper

`tools/project-memory-context/cli/session-start.mjs` should remain the user-facing entrypoint, but most of its logic should move into the shared runtime.

The CLI layer should only:

- parse arguments
- call the shared runtime
- format output for `text` or `claude-code`
- preserve the current non-blocking and always-exit-zero behavior

This keeps Claude Code behavior intact while making OpenCode consume the same runtime.

### 4. Persist the startup summary to disk

Because OpenCode does not offer the same `additionalContext` SessionStart injection path used by Claude Code, the startup result must be persisted to disk.

Proposed paths:

- `.planning/project-memory-context/runs/session-start/latest.json`
- `.planning/project-memory-context/runs/session-start/latest.md`

Requirements:

- always overwrite the latest snapshot atomically enough for normal single-session use
- write machine-readable JSON and human-readable Markdown/text
- include timestamps and launch backend metadata
- degrade gracefully if snapshot writing fails

This snapshot becomes the inspection point for later agent work, debugging, or user review.

### 5. Background launch policy remains Node-detached in v1

The shared runtime should keep using Node detached child processes through `spawnBackground()` for startup-launched background work.

Startup-launched processes in scope:

- `enrich-queue.mjs`
- `enrich-watchdog.mjs`

Backend metadata should explicitly record:

- `backend: "detached-node"`

This makes the limitation visible and leaves room for a future PTY-backed backend if OpenCode later exposes PTY access to plugins.

### 6. PTY is a future extension point, not a startup dependency

The design should not pretend that PTY is available from the plugin runtime today.

Instead, startup launch should be abstracted behind a small internal launcher boundary so a future PTY backend can be added without rewriting session-start logic.

For this iteration:

- detached Node is the only runtime backend
- PTY remains available only when an agent explicitly uses PTY tools later in the session
- documentation should say "PTY preferred when the agent is manually driving long-lived processes," not "plugin startup uses PTY"

### 7. Do not replace the existing OpenCode refresh hook

The debounce-based `tool.execute.after` refresh hook should stay in place.

Session-start unification is a startup concern.
The refresh hook is an after-edit maintenance concern.

Replacing the hook with `watch.mjs` during startup would introduce overlapping refresh mechanisms and create unnecessary behavioral change in this scope.

### 8. OpenCode autostart snippet must match reality

Update `tools/project-memory-context/templates/opencode/autostart-snippet.md` so it no longer says that OpenCode startup is handled by a SessionStart hook installed by `pmc setup`.

The OpenCode snippet should instead say:

- when PMC is installed as an OpenCode plugin, startup work is executed by the plugin in zero-token Node runtime
- if the plugin is not installed or disabled, the manual fallback is `pmc session-start .`
- the model should not manually recreate startup checks if the plugin already handled them

The snippet should remain a workflow reminder, not a startup execution recipe.

## Detailed Flow

### OpenCode startup flow

1. OpenCode loads the PMC plugin.
2. Plugin `config()` reads install state.
3. Plugin injects PMC MCP config into OpenCode.
4. Plugin rehydrates the refresh-hook controller.
5. Plugin calls `runSessionStartRuntime(projectRoot, { mode: "opencode-plugin" })`.
6. Runtime reads status, sync manifest, subagent queue, and materialized overview from disk.
7. Runtime decides whether enrichment plus watchdog need to be launched.
8. Runtime launches them with detached Node child processes if needed.
9. Runtime writes `latest.json` and `latest.md` snapshots.
10. Plugin returns without printing chat-facing startup text.

### Claude Code flow

1. Claude Code SessionStart hook executes `pmc session-start <dir> --format=claude-code`.
2. CLI calls the shared runtime.
3. CLI formats the returned state into `additionalContext`.
4. Claude Code receives the same logical startup result, but via hook output instead of a persisted snapshot lookup.

### Manual fallback flow

1. User or agent runs `pmc session-start .`.
2. CLI calls the shared runtime.
3. CLI prints a human-readable summary.
4. Snapshot files are refreshed at the same time.

This keeps the manual path aligned with the plugin path instead of creating a third behavior.

## Output Semantics

The runtime summary should include these top-level sections conceptually, even if internal field names differ:

- enrichment state summary
- launch decisions and backend used
- pending sync count
- pending large-symbol subagent count
- compact project-context overview from materialized disk artifacts
- warnings or degraded-mode notes

If project-context materialized files are missing, the runtime should not fail startup. It should write a warning and continue.

If enrichment state files are missing, the runtime should treat the project as PMC-installed but not fully initialized, mirroring the current tolerant behavior.

## Implementation Boundaries

Expected code touchpoints:

- `tools/project-memory-context/src/session-start-runtime.mjs`
  - new shared runtime module
- `tools/project-memory-context/cli/session-start.mjs`
  - reduced to argument parsing plus formatting
- `tools/project-memory-context/plugin/index.mjs`
  - call shared runtime from `config()` instead of only `launchEnrichmentIfNeeded()`
- `tools/project-memory-context/templates/opencode/autostart-snippet.md`
  - describe actual OpenCode behavior
- `tools/project-memory-context/README.md`
  - clarify the OpenCode startup model and PTY limitation
- tests covering both CLI and plugin startup paths

Likely not needed:

- changes to the current `tool.execute.after` refresh controller behavior
- any new user-facing command beyond the existing `pmc session-start`

## Testing Requirements

Add or update tests for the following:

1. Shared runtime returns structured startup state for a PMC-installed project.
2. Shared runtime writes both JSON and Markdown snapshots.
3. Shared runtime launches enrichment plus watchdog only when pending work exists and queue is not already running.
4. OpenCode plugin `config()` invokes the shared runtime and does not throw if the runtime fails.
5. CLI `pmc session-start` still produces human-readable text output.
6. Claude Code formatting path still emits `additionalContext` payload shape.
7. OpenCode autostart snippet no longer claims a SessionStart hook installed by `pmc setup`.

## Risks and Trade-Offs

### No automatic OpenCode chat injection

This design intentionally accepts that OpenCode startup may not inject a summary into the chat automatically.

Trade-off:

- better zero-token correctness now
- no fake promise of automatic chat context injection where the platform does not support it

The persisted snapshot is the replacement inspection mechanism.

### Detached Node is less inspectable than PTY

Detached processes are the correct backend for zero-token plugin startup today, but they are less observable than PTY-managed sessions.

Trade-off:

- correct non-blocking startup now
- defer PTY-backed plugin integration until the platform exposes a real plugin-side PTY interface

### Startup summary remains eventually visible, not instantly conversational

The agent will not automatically "know" the startup summary unless it reads the snapshot or the user runs `pmc session-start .` manually.

This is acceptable because the main objective is to remove wasteful model-side startup work, not to simulate a missing platform capability.

## Success Criteria

This design is successful when all of the following are true:

- OpenCode startup no longer depends on model-side startup probing for deterministic PMC checks
- PMC startup behavior is implemented once in shared Node runtime and reused by both CLI and plugin
- background enrichment launch remains non-blocking and zero-token
- the latest startup result is inspectable from disk
- OpenCode documentation no longer implies a Claude Code style SessionStart hook that does not exist
- existing Claude Code SessionStart behavior remains intact

## Recommendation

Implement the shared runtime extraction first, then wire the OpenCode plugin to call it, then update the OpenCode autostart snippet and README language.

That order keeps behavioral change small and lets the repository validate the shared runtime before changing user-facing documentation.
