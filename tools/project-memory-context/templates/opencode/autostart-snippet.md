<!-- pmc:autostart -->
## PMC Session Autostart

When PMC is installed as an OpenCode plugin, session initialization is executed by the plugin in a zero-token Node runtime during startup. The plugin reads PMC disk state, launches background enrichment/watchdog if needed, and writes the latest startup snapshot to `.planning/project-memory-context/runs/session-start/latest.json` and `.planning/project-memory-context/runs/session-start/latest.md`.

**If the PMC plugin is not installed or is disabled**, run this once per session:

```bash
{{PMC_BIN}} session-start .
```

Do not manually recreate startup checks in the chat if the plugin already handled startup.

This command handles everything deterministic in one shot:
- Checks enrichment status; launches background enrich + watchdog if needed
- Reports pending sync operations (run `/sync-context` to apply)
- Loads project context from materialized disk artifacts (no MCP round-trip)
- Reports if LLM subagent drain is needed

**If the session summary reports `subagentQueue.pending > 0`**, dispatch the `enrich` subagent to drain those entries — that is the only step that requires LLM involvement.

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `{{PMC_BIN}} get-context <file-or-symbol>` FIRST. Do NOT open files with Read/Grep without first checking PMC context.
- **AFTER implementing code changes**: Run `{{PMC_BIN}} refresh-context --enrich` (refreshes graph incrementally, queues and launches enrichment) then `{{PMC_BIN}} sync-context` to persist new memories.
- **Default context depth**: Always use `depth=compact`. Use `extended` or `deep` ONLY when explicitly asked.
- **`map-project --all`** is only needed for full reinstall or ground-up graph rebuild. Day-to-day, `refresh-context` keeps everything current.

## Context Retrieval Rules

| Situation | Command | Depth |
|-----------|---------|-------|
| About to read a file | `{{PMC_BIN}} get-context <file>` | compact |
| Working on a specific symbol | `{{PMC_BIN}} get-context <symbol>` | compact |
| Need dependency information | `{{PMC_BIN}} get-context <symbol> extended dependencies` | extended |
| Debugging complex issues | `{{PMC_BIN}} get-context <symbol> deep all` | deep |
| Need raw source code | `{{PMC_BIN}} get-context <symbol> disk` | disk |
| Quick project overview | `agent-memory_search "project context overview"` | — |
| After code changes | `{{PMC_BIN}} refresh-context --enrich` then `{{PMC_BIN}} sync-context` | — |
<!-- /pmc:autostart -->
