# PMC Auto Retry Errors Design

## Goal

Make PMC automatically retry failed symbol enrichments in the background after `enrich-queue` finishes, while avoiding duplicate work and producing a per-symbol report.

## Problem

Today PMC leaves failed enrichments in `worklist.json` with `status: "error"`, but retrying them is a separate manual, foreground command.

This causes three issues:

- the agent can block while running `retry-errors`
- a single symbol may accumulate multiple historical provider failures, but retries should still treat that symbol as one unit of work
- once `enrich-queue` finishes, remaining errors are not automatically retried through the fallback chain

## Requirements

The new behavior must:

- launch retry work in the background by default so agent sessions are not blocked
- automatically trigger retry processing when `enrich-queue` finishes and errors remain
- retry by unique `symbolKey`, not by individual historical error record
- aggregate prior failures for the same symbol into one report entry
- keep using the normal fallback chain: `local-model -> cloud-api -> agent-subagent`
- continue retrying until either no symbols remain in `error` or 5 iterations have run
- avoid launching a second background retry process if one is already running for the same project
- leave unresolved symbols in `error` after the 5-iteration cap and clearly report that outcome

## Non-Goals

- No change to prompt format for enrichment.
- No change to sync-manifest semantics.
- No infinite retry daemon.
- No per-symbol permanent suppression state in version 1.

## Recommended Approach

Keep `retry-errors` as a separate command, but make `enrich-queue` responsible for auto-launching it in the background when the queue completes with remaining errors.

This is the smallest correct change because:

- it preserves the current command split
- it keeps manual retry available
- it adds automatic behavior without turning `enrich-queue` into a large supervisor
- it minimizes changes to the normal queue execution path

## High-Level Flow

### 1. Queue completion

When `enrich-queue.mjs` reaches its normal finished state:

1. compute the final summary from `worklist.json`
2. if `summary.errors === 0`, exit as today
3. if `summary.errors > 0`, check whether a retry process is already running for this project
4. if no retry is running, launch `retry-errors` in the background
5. write a clear log message saying retry was launched and where logs/report will be written

### 2. Retry execution model

`retry-errors.mjs` changes from a single-pass command to a bounded retry loop.

For each iteration:

1. load the current `worklist.json`
2. collect all entries with `status: "error"`
3. dedupe them by `symbolKey`
4. build one work item per symbol using the latest symbol state plus all historical errors/attempts for reporting
5. retry each symbol once for that iteration using the existing fallback chain
6. persist updated worklist and symbol-index state after each symbol
7. stop early if no symbols remain in `error`

The command stops when either:

- there are no remaining error symbols, or
- 5 iterations have completed

### 3. Duplicate prevention

Duplicate prevention is required at two levels.

#### Process-level

Before `enrich-queue` launches background retry, it must detect whether a retry process is already active for the same project root. If one exists, it must not launch another.

#### Symbol-level

Within `retry-errors`, each iteration operates on unique `symbolKey` values only. A symbol with multiple historical provider failures is retried once in that iteration. If that retry succeeds, the symbol is not re-enqueued because of older failures.

## Reporting Design

`retry-report.json` should become a per-symbol report, not a per-error report.

### Report shape

```json
{
  "startedAt": "...",
  "finishedAt": "...",
  "iterations": 3,
  "config": {
    "concurrency": 1,
    "timeoutMs": 300000,
    "preferredModes": ["local-model", "cloud-api", "agent-subagent"]
  },
  "symbols": [
    {
      "symbolKey": "...",
      "name": "...",
      "filePath": "...",
      "previousErrors": [
        {
          "provider": "ollama",
          "errorType": "timeout",
          "message": "request timed out",
          "failedAt": "..."
        }
      ],
      "iterationResults": [
        {
          "iteration": 1,
          "status": "failed",
          "elapsedMs": 12345,
          "attempts": []
        },
        {
          "iteration": 2,
          "status": "succeeded",
          "elapsedMs": 9876,
          "attempts": []
        }
      ],
      "finalStatus": "enriched",
      "memoryId": "queue-...",
      "contentPreview": "..."
    }
  ],
  "summary": {
    "symbolsRetried": 10,
    "symbolsRecovered": 7,
    "symbolsStillFailing": 3,
    "maxIterationsReached": false
  }
}
```

### Reporting rules

- one top-level report entry per symbol
- `previousErrors` summarizes failures known before the current retry run starts
- `iterationResults` captures what happened on each retry iteration
- `finalStatus` is the symbol status at the end of the whole retry run
- if 5 iterations are exhausted, the summary must say so explicitly

## Fallback Behavior

Automatic retry must use the same fallback driver PMC already uses.

Version 1 should not force Ollama-only mode. The retry loop should honor the normal fallback chain:

- `local-model`
- `cloud-api`
- `agent-subagent`

That keeps behavior aligned with the rest of enrichment and lets retries recover from failures like:

- Ollama timeouts
- missing or invalid cloud API credentials that are later fixed
- agent-subagent failure after other providers fail

## Files to Change

### Core CLI

- `tools/project-memory-context/cli/retry-errors.mjs`
  - refactor from single-pass retry into iterative retry loop
  - dedupe work by `symbolKey`
  - aggregate historical errors per symbol
  - emit the new report format

- `tools/project-memory-context/cli/enrich-queue.mjs`
  - after successful queue finalization, detect remaining errors
  - detect whether retry is already running
  - launch background retry when needed
  - log retry launch/skipped state

### Optional shared helper

If needed to keep both commands small, add a shared helper under `tools/project-memory-context/src/`, for example:

- `retry-errors-runner.mjs`
  - symbol grouping
  - iteration loop
  - report assembly
  - reusable status helpers

This helper is optional. If the logic remains readable in `retry-errors.mjs`, keep the change in one file.

## Runtime State And Locking

Version 1 needs a lightweight way to detect whether retry is already active.

Recommended approach:

- write a `retry-state.json` file under `.planning/project-memory-context/enrichment/`
- include `status`, `pid`, `projectRoot`, `startedAt`, `heartbeatAt`, `finishedAt`, and `lastError`
- update `heartbeatAt` periodically during retry execution
- treat stale state as recoverable if the process no longer exists or the heartbeat is too old

This mirrors the existing queue state model and is enough to prevent duplicate auto-launches.

## Error Handling

- If background launch fails, `enrich-queue` must still finish normally and log the launch failure.
- If retry crashes mid-run, it must finalize `retry-state.json` with `status: "failed"` and preserve the current worklist state.
- If a symbol succeeds in iteration 1, later iterations must not touch it unless it becomes `error` again in the worklist before the next iteration starts.
- If 5 iterations complete and errors remain, keep those entries in `status: "error"` and report them clearly.

## Testing

Add coverage for:

- dedupe by `symbolKey` when multiple historical failures exist for the same symbol
- successful recovery removes the symbol from later iterations
- retry loop exits early when no errors remain
- retry loop stops after 5 iterations when errors persist
- queue auto-launches retry only when final error count is greater than zero
- queue does not auto-launch retry when `retry-state.json` shows an active process
- stale retry state can be recovered and relaunched

## Open Implementation Choices

These choices are already constrained by the approved design:

- process dedupe is required
- symbol dedupe is required
- max iterations is fixed at 5
- unresolved symbols stay in `error` and must be reported

The remaining implementation freedom is only about code organization, not behavior.

## Rollout Notes

- manual `retry-errors` remains available
- auto-retry should be background-only when launched by the agent/queue path
- users should be able to inspect `.planning/project-memory-context/enrichment/retry-report.json` and retry logs for outcomes
