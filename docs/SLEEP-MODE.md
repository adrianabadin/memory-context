# Sleep Mode

Sleep mode runs PMC maintenance during idle windows without competing with active user work. It is Windows-first, uses local-model-only enrichment, and yields cooperatively when user activity resumes.

## Overview

Sleep mode consists of two components:

1. **`sleep-watch`** — idle daemon that monitors CPU/idle state and spawns `sleep-run` when eligible
2. **`sleep-run`** — one-shot maintenance pipeline with checkpointing and crash recovery

## How It Works

```
sleep-watch (daemon)
  │
  ├─ Polls CPU usage and idle time
  ├─ Checks eligibility (idle >= idleMinMinutes, CPU < cpuHighPercent)
  ├─ Acquires keep-awake lease (30 min TTL, renewed every 10 min)
  ├─ Spawns sleep-run (detached)
  │   │
  │   ├─ For each registered project:
  │   │   ├─ pmc refresh-context (detect changes)
  │   │   ├─ pmc enrich (local-model only, no cloud/subagent)
  │   │   └─ pmc sync-context (persist memories)
  │   │
  │   ├─ Memory maintenance:
  │   │   ├─ Run decay state transitions
  │   │   ├─ Create gists for gist_only candidates
  │   │   ├─ Run revive gate on prune candidates
  │   │   └─ Check global promotion rules
  │   │
  │   ├─ Checkpoint after each safe boundary
  │   └─ Write report on completion/pause/error
  │
  └─ Monitors for activity → pauses sleep-run at symbol boundary
```

## Idle Detection

`sleep-watch` evaluates eligibility based on:

| Condition | Threshold | Description |
|-----------|-----------|-------------|
| Idle time | `>= idleMinMinutes` (default 10) | No user input detected |
| CPU usage | `< cpuHighPercent` (default 65%) | System not under load |
| Plugged in | `onlyWhenPluggedIn` (default true) | Laptop on battery → skip |

When CPU exceeds `cpuHighPercent`, sleep-run pauses. It resumes when CPU drops below `cpuResumeBelowPercent` (default 45%).

## Keep-Awake Lease

The keep-awake lease prevents the system from sleeping while maintenance is active:

- **Acquire**: 30-minute TTL (configurable via `keepAwakeLeaseMinutes`)
- **Renew**: Every 10 minutes while work continues
- **Release**: On pause, completion, or error
- **Failure**: Warns but does not block; reported via `keepAwakeStatus` in the report

On Windows, this uses `SetThreadExecutionState` to prevent sleep. On other platforms, it uses platform-appropriate mechanisms.

## Symbol-Boundary Yielding

When user activity resumes during a sleep-run:

1. The current symbol finishes processing
2. State is checkpointed (current project, symbol, phase)
3. The keep-awake lease is released
4. Work pauses at the next safe boundary

This ensures no work is lost and the user gets immediate CPU access.

## Local-Only Enforcement

Sleep mode uses **local-model-only** enrichment:

- No cloud API calls
- No agent/subagent fallback
- If the local model (Ollama) is unavailable, enrichment is deferred
- Non-LLM work (refresh, sync, maintenance) continues regardless

This prevents unattended cloud billing and ensures sleep mode is truly autonomous.

## Multi-Project Orchestration

When multiple projects are registered, sleep-mode iterates them:

1. Each project is refreshed, enriched, and synced in turn
2. Checkpoints are written after each project boundary
3. If the run is interrupted, it resumes at the next project on restart
4. Per-project stats are collected in the final report

## Crash Recovery

If `sleep-run` is interrupted (crash, power loss, forced kill):

1. On restart, the system reads the latest checkpoint from `~/.config/opencode/pmc/sleep/runs/<runId>/checkpoint.json`
2. Processing continues from the last safe boundary
3. No state corruption — checkpointing uses atomic writes (temp + rename)

### Checkpoint Format

```json
{
  "runId": "sleep-20260623-001",
  "status": "running",
  "startedAt": "2026-06-23T02:00:00Z",
  "currentProject": "my-project",
  "currentPath": "/path/to/project",
  "phase": "enrich",
  "currentSymbolKey": "src/auth/middleware.ts:validateToken",
  "processed": 42,
  "deferred": 1,
  "lastSafeBoundary": "2026-06-23T02:15:00Z",
  "pauseReason": null
}
```

## Report Format

After completion or pause, a report is written to `~/.config/opencode/pmc/sleep/runs/<runId>/report.json`:

```json
{
  "runId": "sleep-20260623-001",
  "status": "completed",
  "startedAt": "2026-06-23T02:00:00Z",
  "completedAt": "2026-06-23T04:30:00Z",
  "phases": [
    {
      "name": "refresh",
      "status": "completed",
      "startedAt": "2026-06-23T02:00:00Z",
      "completedAt": "2026-06-23T02:05:00Z"
    },
    {
      "name": "enrich",
      "status": "completed",
      "startedAt": "2026-06-23T02:05:00Z",
      "completedAt": "2026-06-23T04:00:00Z"
    },
    {
      "name": "sync",
      "status": "completed",
      "startedAt": "2026-06-23T04:00:00Z",
      "completedAt": "2026-06-23T04:15:00Z"
    },
    {
      "name": "maintenance",
      "status": "completed",
      "startedAt": "2026-06-23T04:15:00Z",
      "completedAt": "2026-06-23T04:30:00Z"
    }
  ],
  "summary": {
    "projectsProcessed": 3,
    "symbolsEnriched": 47,
    "symbolsDeferred": 2,
    "memoryMaintenance": {
      "decayTransitions": 12,
      "gistsCreated": 3,
      "promotions": 1,
      "pruned": 0
    },
    "pauseEvents": [],
    "warnings": [],
    "keepAwakeStatus": "active"
  }
}
```

### Report Status Values

| Status | Meaning |
|--------|---------|
| `completed` | All phases finished successfully |
| `paused` | Work paused due to user activity or CPU pressure |
| `failed` | Unrecoverable error (see warnings) |

### Keep-Awake Status Values

| Status | Meaning |
|--------|---------|
| `active` | Lease held successfully throughout the run |
| `unavailable` | Platform does not support keep-awake |
| `failed` | Lease acquisition or renewal failed |

## Configuration

Global config at `~/.config/opencode/project-memory-context.json`:

```json
{
  "sleep": {
    "idleMinMinutes": 10,
    "cpuHighPercent": 65,
    "cpuResumeBelowPercent": 45,
    "maxRunHours": 6,
    "keepAwakeLeaseMinutes": 30,
    "onlyWhenPluggedIn": true,
    "pauseAfterCurrentSymbol": true
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `idleMinMinutes` | number | `10` | Minutes of idle before eligibility |
| `cpuHighPercent` | number | `65` | CPU % above which work pauses |
| `cpuResumeBelowPercent` | number | `45` | CPU % below which work resumes |
| `maxRunHours` | number | `6` | Maximum hours per sleep-run |
| `keepAwakeLeaseMinutes` | number | `30` | Keep-awake lease TTL |
| `onlyWhenPluggedIn` | boolean | `true` | Skip on battery power |
| `pauseAfterCurrentSymbol` | boolean | `true` | Finish current symbol before pausing |

## Windows-Specific Behavior

Sleep mode is Windows-first with these considerations:

- **Detached spawn**: Uses `spawn()` with `detached: true`, `stdio: 'ignore'`, `.unref()`, `shell: false`, and array args
- **No Git Bash path translation**: Direct Node invocation, no raw `bash` with Windows paths
- **Keep-awake**: Uses `SetThreadExecutionState` via native bindings
- **DB safety**: Avoids unsafe lock behavior; uses WAL mode
- **Path handling**: Neutral CWD, environment reset, `windowsHide: true`

## Commands

Sleep mode is available as `pmc` subcommands:

```bash
# Start the idle daemon
pmc sleep-watch

# Run one-shot maintenance (usually spawned by sleep-watch)
pmc sleep-run --db ./memory.db

# Check daemon status
pmc sleep-watch --status

# View/edit sleep config
pmc sleep-config show
pmc sleep-config set idleMinMinutes 15
```

## Limitations

- **Local-model only**: No cloud or subagent fallback during sleep
- **Global config only**: No per-project sleep/forgetting overrides
- **Windows-first**: Other platforms may have limited keep-awake support
- **No UI**: Reports are JSON files; no visualization
