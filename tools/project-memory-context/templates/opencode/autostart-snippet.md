<!-- pmc:autostart -->
On EVERY session start, BEFORE responding to the user, execute these steps IN ORDER:

1. **Check enrichment status**: Read `.planning/project-memory-context/enrichment/worklist.json`. Count entries with `status: "pending"` or `status: "stale"`. If count > 0, launch background enrichment:
   - Windows: `Start-Process -FilePath "npx" -ArgumentList "--yes","--package","@aabadin/project-memory-context","pmc","enrich","." -WindowStyle Hidden`
   - POSIX: `nohup npx --yes --package @aabadin/project-memory-context pmc enrich . > /dev/null 2>&1 &`

2. **Check sync-manifest**: Read `.planning/project-memory-context/enrichment/sync-manifest.json`. If `entries` contains any element with `status: "pending"`, surface: "PMC has N pending sync operations. Run `/sync-context` to apply them."

3. **Recall base context**: Call `agent-memory_search` with `query: "project context overview"` and `tags: ["project-context"]`. Present a brief summary (~500 tokens) to establish session context.

4. **Remind**: "Use `/get-context <target>` for structural deep-dive BEFORE reading files."

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `pmc get-context <file-or-symbol>` FIRST. Do NOT open files with Read/Grep without first checking PMC context.
- **AFTER implementing code changes**: Run `pmc refresh-context` to detect changes, update graph, and queue re-enrichment.
- **AFTER refresh-context completes**: Run `pmc sync-context` to persist new/updated memories.
- **Default context depth**: Always use `depth=compact`. Use `extended` or `deep` ONLY when explicitly asked.

## Context Retrieval Rules

| Situation | Command | Depth |
|-----------|---------|-------|
| About to read a file | `pmc get-context <file>` | compact |
| Working on a specific symbol | `pmc get-context <symbol>` | compact |
| Need dependency information | `pmc get-context <symbol> extended dependencies` | extended |
| Debugging complex issues | `pmc get-context <symbol> deep all` | deep |
| Need raw source code | `pmc get-context <symbol> disk` | disk |
| Quick project overview | `agent-memory_search "project context overview"` | — |
| After code changes | `pmc refresh-context` then `pmc sync-context` | — |
<!-- /pmc:autostart -->
