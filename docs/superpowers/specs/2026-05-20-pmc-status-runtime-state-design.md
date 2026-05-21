# PMC Status Runtime State Design

## Goal

Make `pmc status` answer the operational question directly: whether the enrichment queue is running right now, has finished, is idle, or appears stalled.

## Current Problem

`tools/project-memory-context/cli/status.mjs` only summarizes `worklist.json`. That tells us backlog counts, but not whether `enrich-queue.mjs` is currently alive. Users are forced to infer runtime state from generic `node` processes or stale log timestamps.

## Chosen Approach

Add a runtime state file written by `enrich-queue.mjs` and read by `pmc status`:

- File: `.planning/project-memory-context/enrichment/queue-state.json`
- Producer: `tools/project-memory-context/cli/enrich-queue.mjs`
- Consumer: `tools/project-memory-context/cli/status.mjs`

This gives a portable, repo-local signal without relying on OS-specific process inspection.

## Data Model

`queue-state.json` shape:

```json
{
  "status": "running",
  "pid": 12345,
  "startedAt": "2026-05-20T21:00:00.000Z",
  "heartbeatAt": "2026-05-20T21:00:30.000Z",
  "finishedAt": null,
  "lastError": null,
  "summary": {
    "pending": 120,
    "enriched": 40,
    "errors": 3
  }
}
```

Fields:

- `status`: `running` | `finished` | `failed`
- `pid`: current process PID
- `startedAt`: queue start timestamp
- `heartbeatAt`: last liveness update
- `finishedAt`: terminal timestamp for `finished` or `failed`
- `lastError`: fatal top-level error message if the queue exits abnormally
- `summary`: latest queue counts derived from the worklist

## Status Semantics

`pmc status` will expose a top-level inferred `state` with these values:

- `running`: `queue-state.json` exists, `status === "running"`, and `heartbeatAt` is recent
- `stalled`: `queue-state.json` exists, `status === "running"`, but the heartbeat is older than the timeout window
- `finished`: `queue-state.json` exists and `status === "finished"`
- `failed`: `queue-state.json` exists and `status === "failed"`
- `idle`: no usable runtime state file exists yet

Heartbeat freshness rule:

- default stale threshold: `90s`
- derived from `PMC_REPORT_INTERVAL`, but never lower than a safe floor

## Queue Writer Behavior

`enrich-queue.mjs` changes:

1. On startup, write `queue-state.json` with:
   - `status: "running"`
   - `pid: process.pid`
   - `startedAt`
   - initial `heartbeatAt`
   - initial `summary`
2. On each periodic progress report, update:
   - `heartbeatAt`
   - `summary`
3. After checkpoint saves or major transitions, also refresh `heartbeatAt`
4. On normal completion, write:
   - `status: "finished"`
   - `finishedAt`
   - final `summary`
5. On fatal top-level failure, write:
   - `status: "failed"`
   - `finishedAt`
   - `lastError`
   - final `summary` if available

The file should be overwritten atomically through the existing JSON write helper pattern.

## Status Reader Behavior

`status.mjs` changes:

1. Read `queue-state.json` if present
2. Determine `state` from runtime status + heartbeat freshness
3. Return a new `runtime` object in the JSON report:

```json
{
  "state": "running",
  "runtime": {
    "pid": 12345,
    "startedAt": "...",
    "heartbeatAt": "...",
    "finishedAt": null,
    "staleAfterSeconds": 90,
    "lastError": null
  }
}
```

4. Keep the existing `worklist` summary unchanged for backward compatibility

## CLI Output Example

```json
{
  "ok": true,
  "command": "status",
  "projectRoot": "C:\\repo",
  "state": "running",
  "runtime": {
    "pid": 12345,
    "startedAt": "2026-05-20T21:00:00.000Z",
    "heartbeatAt": "2026-05-20T21:00:30.000Z",
    "finishedAt": null,
    "staleAfterSeconds": 90,
    "lastError": null
  },
  "worklist": {
    "pending": 64,
    "enriched": 115,
    "errors": 181
  },
  "lastSync": "2026-05-20T21:29:21.086Z"
}
```

## Error Handling

- Missing `queue-state.json` is not an error; report `state: "idle"`
- Corrupt `queue-state.json` should not crash `pmc status`; treat as `idle` and expose no `runtime`
- If the queue dies before writing terminal state, `pmc status` should eventually show `stalled`
- Existing worklist counting remains the fallback source for backlog visibility

## Testing

Add tests for:

- `status.mjs` returns `idle` when no runtime file exists
- `status.mjs` returns `running` for fresh heartbeat
- `status.mjs` returns `stalled` for expired heartbeat
- `status.mjs` returns `finished` for terminal success
- `status.mjs` returns `failed` and preserves `lastError`
- `enrich-queue.mjs` writes startup, heartbeat, and terminal queue-state transitions

## Scope Boundaries

Included:

- runtime state file
- top-level `state` in `pmc status`
- `runtime` block in the JSON report
- tests

Not included:

- OS-level process validation
- lockfiles or queue singleton enforcement
- human-readable text mode for `pmc status`

## Implementation Notes

- Reuse existing `saveJson()` style logic where possible
- Keep the change minimal and local to `status.mjs`, `enrich-queue.mjs`, and tests
- Do not change current worklist semantics or retry policy in this iteration

## Review Notes

This design intentionally separates:

- backlog state (`worklist`)
- runtime liveness (`queue-state.json`)

That keeps `pmc status` simple to interpret: users can answer both “is it running?” and “how much remains?” from a single command.
