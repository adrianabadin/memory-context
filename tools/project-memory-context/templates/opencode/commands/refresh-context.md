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

- Without `--enrich`: run `{{PMC_BIN}} enrich . --background` then `{{PMC_BIN}} sync-context`.
- With `--enrich`: enrichment is already running in background; run `{{PMC_BIN}} sync-context` after it finishes.

> `map-project --all` is only needed for full reinstall or to rebuild the graph from scratch.
> For day-to-day code changes, `refresh-context` keeps everything up-to-date.
