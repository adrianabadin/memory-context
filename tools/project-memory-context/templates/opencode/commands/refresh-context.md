---
name: refresh-context
description: Detect code changes and update graph, worklist, and memories incrementally
allowed-tools:
  - Bash
  - pty_list
  - pty_spawn
  - pty_read
  - pty_kill
---

# Refresh Context

Detect changed source files, run incremental graph update, extract new/modified symbols, and queue selective re-enrichment.

## When to run

- After making code changes (new functions, modified classes, deleted files)
- Before starting work on a task if context might be stale
- As part of session autostart if changes were made outside this session

## Command

**Detect PTY:** Call `pty_list`. Success (even an empty list) → `HAS_PTY = true`. Failure or tool absent → `HAS_PTY = false`.

**With PTY (preferred):**
```
pty_spawn:
  command: "{{PMC_BIN}}"
  args: ["refresh-context"]
  title: "PMC Refresh Context"
  notifyOnExit: true
  description: "Incremental graph + worklist refresh"
```
Pass `args: ["refresh-context", "--enrich"]` instead when launching enrichment automatically (see Options below). Use `pty_read` to capture the refresh summary, `pty_kill` to close the session once it completes (this is a bounded, one-shot operation, not a persistent watcher).

**Without PTY (fallback):**
```bash
{{PMC_BIN}} refresh-context
```

## Options

```
--enrich    Launch background enrichment automatically if there are pending symbols
```

## What it does

1. Computes file hashes and compares with last known state
2. Runs `graphify update` incrementally (AST only, no LLM — fast because only changed files are re-parsed)
3. Copies updated `graph.json` to `.planning/project-memory-context/graph/`
4. Extracts symbols from changed files and resolves graph node IDs against the fresh graph
5. Computes symbol deltas (new, stale, removed)
6. Updates worklist and sync-manifest
7. If `--enrich` is passed and there are pending symbols, launches background enrichment

## After running

- Without `--enrich`: launch enrichment (`/enrich` — PTY-first per its own template) then `sync-context` (`/sync-context` — PTY-first per its own template).
- With `--enrich`: enrichment is already launched as a separate background process (regardless of whether `refresh-context` itself ran via PTY or Bash); run `sync-context` (`/sync-context`) after it finishes.

> `map-project --all` is only needed for full reinstall or to rebuild the graph from scratch.
> For day-to-day code changes, `refresh-context` keeps everything up-to-date.
