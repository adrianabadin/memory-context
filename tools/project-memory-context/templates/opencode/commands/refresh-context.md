---
name: refresh-context
description: Detect code changes and update graph, worklist, and memories incrementally
---

# Refresh Context

Detect changed source files, run incremental graph update, extract new/modified symbols, and queue selective re-enrichment.

## When to run

- After making code changes (new functions, modified classes, deleted files)
- Before starting work on a task if context might be stale
- As part of session autostart if changes were made outside this session

## Command

```bash
{{PMC_BIN}} refresh-context
```

## What it does

1. Computes file hashes and compares with last known state
2. Runs incremental graphify on changed files only
3. Merges new graph nodes/edges into existing graph
4. Extracts symbols from changed files
5. Computes symbol deltas (new, stale, removed)
6. Updates worklist and sync-manifest
7. Launches background enrichment for pending symbols

## After running

Run `{{PMC_BIN}} sync-context` to persist enrichment results to agent-memory.
