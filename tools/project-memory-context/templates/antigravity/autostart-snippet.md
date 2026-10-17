<!-- pmc:autostart -->
## PMC Session Autostart

Session initialization is handled automatically by the `{{PMC_BIN}} session-start` hook
(installed by `pmc setup`). The hook runs **outside the model context window**, costs zero
tokens, and injects a compact status + project context summary.

**If your harness does NOT have a SessionStart hook configured**, run this once per session:

```bash
{{PMC_BIN}} session-start .
```

This command handles everything deterministic in one shot:
- Checks enrichment status; launches background enrich + watchdog if needed
- Reports pending sync operations (run `/sync-context` to apply)
- Loads project context from materialized disk artifacts (no MCP round-trip)
- Reports if LLM subagent drain is needed

**If the session summary reports `subagentQueue.pending > 0`**, dispatch the `enrich` subagent
to drain those entries — that is the only step that requires LLM involvement.

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `{{PMC_BIN}} get-context <file-or-symbol>` FIRST. Do NOT open files without first checking PMC context.
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

## Memory Protocol — Deterministic Triggers

The complete deterministic Memory Protocol — including the plugin-active exception, the 7-event save triggers, the local/global search table, the post-compaction recovery, the global error tracking rules, the topic-key/alias flow, and the memory-lifecycle rules — lives in **`pmc-skill`**. Load the skill before the first memory/session call; it owns the tool names and triggers.

- **Skill location** (this project): `.agents/skills/pmc-skill/SKILL.md`
- **Skill location** (global config): `~/.config/opencode/skills/pmc-skill/SKILL.md` (OpenCode) / `~/.claude/skills/pmc-skill/SKILL.md` (Claude Code)

<!-- /pmc:autostart -->
