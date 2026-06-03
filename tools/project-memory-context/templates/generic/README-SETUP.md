# PMC Setup Guide

This project uses PMC (Project Memory Context) for persistent structured memory.

## Quick Start

```bash
# Bootstrap the project (graphify + worklist + base memories)
{{PMC_BIN}} map-project --all --enrich

# Check enrichment status
{{PMC_BIN}} enrich-status

# Run semantic enrichment for pending symbols
{{PMC_BIN}} enrich .

# Refresh project context memories
{{PMC_BIN}} get-context --refresh

# Sanitize (re-run graphify, mark stale entries)
{{PMC_BIN}} sanitize

# Sync pending PMC updates into agent-memory
{{PMC_BIN}} sync-context
```

## How It Works

1. **Map Project** runs `graphify` to map your codebase structure, extracts symbols, and creates an enrichment worklist.
2. **Enrich** processes each symbol through a semantic enrichment pipeline (local model -> cloud API -> agent subagent fallback chain).
3. **Sync** pushes enriched memories to `agent-memory-mcp` for persistent retrieval via `{{PMC_BIN}} sync-context`.
4. **Context** materializes 9 base project-context memories (stack, architecture, dependencies, etc.).

## Files

- `.planning/project-memory-context/` — all PMC data lives here
- `.planning/project-memory-context/enrichment/worklist.json` — symbol enrichment queue
- `.planning/project-memory-context/enrichment/sync-manifest.json` — pending agent-memory upserts
- `.planning/project-memory-context/graph/` — graphify output

## Requirements

- Node.js >= 18
- Python + `graphifyy` (`pip install graphifyy`)
- `{{AGENT_MEMORY_CMD}}` (optional, for persistent memory)

## CLI Reference

```
{{PMC_BIN}} init-project [--agent opencode|claude-code|cursor|generic]
{{PMC_BIN}} map-project [dir] [--all] [--enrich]
{{PMC_BIN}} enrich [dir] [--concurrency N]
{{PMC_BIN}} get-context [<target>] [depth] [focus]
{{PMC_BIN}} get-context --refresh
{{PMC_BIN}} sanitize
{{PMC_BIN}} enrich-status
{{PMC_BIN}} sync-context
```
