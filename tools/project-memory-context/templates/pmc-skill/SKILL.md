---
name: pmc-skill
description: "PMC-Aware Workflow — structural context before file reads, deterministic memory triggers, session lifecycle protocol, enrichment rules, and graph.db fallback."
---

# PMC-Aware Workflow

PMC first, files second. Before reading more than 3 files, query PMC for structural context.

---

## Memory Protocol — Deterministic Triggers (MANDATORY)

These rules are NOT optional. The agent MUST follow them without being asked. Use the exact, fully-qualified `pmc-agent-memory_*` tool names below — never abbreviated or generic names.

### Session lifecycle

- **Session start**: call `pmc-agent-memory_set_session_context` once, then `pmc-agent-memory_recall` to recover prior context on the current topic.
- **Before reading source / changing code**: run `pmc get-context <target>` (default depth `compact`).
- **After implementing code changes**: run `pmc refresh-context --enrich` (PTY-first when available, otherwise Bash) then `pmc sync-context`.
- **Session close** (BEFORE saying "done" / "listo" / "that's it"): call `pmc-agent-memory_store_session_summary`. This is NOT optional — if skipped, the next session starts blind.
- **Before AND after compaction**: call `pmc-agent-memory_store_session_summary` immediately to persist the pre-compaction state, then call `pmc-agent-memory_recall` to recover prior context before continuing.

### Plugin-active exception (do NOT duplicate auto-capture)

When the PMC OpenCode plugin is active, do **NOT** manually call these three auto-captured tools:

- `pmc-agent-memory_store_session_prompt`
- `pmc-agent-memory_store_session_response`
- `pmc-agent-memory_store_session_tool_call`

All other memory tools remain your manual responsibility.

### Save triggers → `pmc-agent-memory_store`

Call `pmc-agent-memory_store` IMMEDIATELY after any of these, without being asked:

- Bug fix completed (include root cause)
- Architecture or design decision made
- Tool or library choice made with tradeoffs
- Non-obvious discovery about the codebase
- Configuration change or environment setup
- Pattern established (naming, structure, convention)
- User preference or constraint learned

**Format for `pmc-agent-memory_store`**:
- **title**: Verb + what — short, searchable (e.g. "Fixed N+1 query in UserList")
- **type**: `bugfix` | `decision` | `architecture` | `discovery` | `pattern` | `config` | `preference`
- **scope**: `project` (default) | `personal`
- **topic_key** (recommended for evolving topics): stable key like `architecture/auth-model`
- **content**: `**What**: ... **Why**: ... **Where**: ... **Learned**: ...`

### Search triggers (local vs global)

| Scope | When | Tools (exact names) |
|-------|------|---------------------|
| Local (current project) | Before reading source, changing code, or answering project-structure questions; reactively when the user says "remember" / "recall" / "recordar" / "acordate" or references past work; proactively before proposing an approach | `pmc-agent-memory_recall`, `pmc-agent-memory_search`, `pmc-agent-memory_find_related`, `pmc-agent-memory_list_recent` |
| Global (cross-project errors only) | Before debugging a non-trivial error, or after resolving one | `pmc-agent-memory_search_global_errors` (read), `pmc-agent-memory_record_error` (write, after a fix) |

> Global scope today covers the cross-project ERROR database only. There is currently NO general cross-project memory/convention search — do not promise one. For local recall, start with `pmc-agent-memory_recall` (fast, multi-topic), then fall back to `pmc-agent-memory_search` with keywords.

### Error tracking

- **BEFORE debugging anything non-trivial**: call `pmc-agent-memory_search_global_errors` to check for a known fix.
- **AFTER resolving an error**: call `pmc-agent-memory_record_error` to persist the root cause and fix for future sessions.

### Topic keys (evolving topics)

- Different topics MUST NOT overwrite each other (e.g. architecture vs bugfix).
- For an evolving topic, call `pmc-agent-memory_suggest_topic_key` then `pmc-agent-memory_upsert_topic_alias` so future updates reuse the same key instead of creating duplicates.
- To look up an existing topic, call `pmc-agent-memory_resolve_topic`.
- Use `pmc-agent-memory_update` when you have an exact memory ID to correct.

### Memory lifecycle

- **active**: use normally.
- **needs_review**: stale context — surface to the user and verify before relying on it.
- **archived**: excluded from search by default.
- When a stored memory becomes stale or obsolete, call `pmc-agent-memory_update_memory_status` to mark it — do not silently leave outdated facts as trusted context.
- NEVER call any `mark_reviewed` equivalent automatically — only after explicit user confirmation.

### Project registration (install/setup only — NOT agent runtime)

`pmc-agent-memory_register_project` and `pmc-agent-memory_sync_project_metadata` run during PMC install/bootstrap. Do **NOT** call them from agent runtime; the install/setup flow already handles project registration.

---

## Session Capture Plugin (automatic capture)

PMC includes an OpenCode plugin that **automatically captures** session events at ZERO agent-token cost.

### What it captures
- User prompts (via `chat.message` hook)
- Tool calls with sanitized args (via `tool.execute.after` hook)
- Assistant responses (best-effort, via `chat.message` role detection)

### How it works
```
OpenCode plugin hooks
  → append JSONL to .opencode/pmc-capture-queue.jsonl
  → detached drainer process reads queue in batches
  → writes to agent-memory via LedgerOnlyStore
  → queue rotates at 1MB
```

### Secret redaction (automatic)
- `<private>...</private>` tags → `[REDACTED]`
- `authorization`, `api_key`, `password`, `secret`, `token` fields → `***REDACTED***`
- Tool result summaries truncated to 200 chars

### Reliability
- Single-instance lockfile prevents double drainer
- WAL mode + `busy_timeout=5000ms` for SQLite concurrency
- 3x retry with exponential backoff (100ms, 200ms, 400ms) on transient failures
- Watchdog relaunches drainer up to 3x on crash

### The agent does NOT need to
- Manually call `pmc-agent-memory_store_session_prompt` (plugin handles it)
- Manually call `pmc-agent-memory_store_session_tool_call` (plugin handles it)
- Remember to record context (plugin fires on every interaction)

### The agent DOES need to
- Call `pmc-agent-memory_set_session_context` at session start
- Call `pmc-agent-memory_store_session_summary` at session close
- Call `pmc-agent-memory_store` for architectural decisions, bug fixes, patterns, preferences

---

## Structural Context Rules

### Before reading files

| Situation | Command | Depth |
|-----------|---------|-------|
| About to read a file | `pmc get-context <file>` | compact |
| Working on a specific symbol | `pmc get-context <symbol>` | compact |
| Need dependency information | `pmc get-context <symbol> extended dependencies` | extended |
| Debugging complex issues | `pmc get-context <symbol> deep all` | deep |
| Quick project overview | `pmc-agent-memory_recall "project context overview"` | — |
| Architecture question | `pmc-query_pmc_query_project <question>` | — |
| Find a symbol by name/description | `pmc-query_pmc_search_symbols <query>` | — |
| Before modifying a symbol | `pmc-query_pmc_get_dependencies` + `pmc-query_pmc_get_dependents` | — |

### After code changes

- If the PTY file watcher is running: automatic — just run `pmc sync-context` after
- If watcher is NOT running: run `pmc refresh-context --enrich` then `pmc sync-context`

---

## Available commands

- `/get-context <target> [depth] [focus]` — resolve a symbol, file, or query and return structural context
- `/map-project [--all] [--enrich]` — bootstrap PMC graph, worklist, and base memories
- `/enrich` — launch batch semantic enrichment via `pmc enrich . --background`
- `/enrich-ondemand` — enrich a specific symbol using the agent's LLM
- `/enrich-status` — show enrichment progress (pending, enriched, stale, failed)
- `/sync-context` — upsert enriched memories from sync-manifest into agent-memory
- `/sanitize` — re-run graphify, diff symbols, mark stale entries
- `/refresh-context` — incremental graph + worklist update after code changes
- `/pmc-doctor` — run environment diagnostics
- `/init-project` — initialize PMC project structure

## Available MCP tools

### Query (structural context) — `pmc-query_*` server
- `pmc-query_pmc_query_project` — natural-language questions about the codebase
- `pmc-query_pmc_search_symbols` — semantic symbol search
- `pmc-query_pmc_get_dependencies` — what a symbol depends on
- `pmc-query_pmc_get_dependents` — who uses a symbol
- `pmc-query_pmc_get_context` — multi-depth structural context retrieval; pass `focus=impact` for blast-radius analysis of a changed target (no standalone `pmc_get_impact` MCP tool exists — impact is a focus mode of `get_context`)

### Memory (persistent knowledge) — `pmc-agent-memory_*` server
- `pmc-agent-memory_store` — save a single memory (bugfix, decision, discovery, etc.)
- `pmc-agent-memory_store_batch` — save multiple memories at once
- `pmc-agent-memory_update` — correct an existing memory by ID
- `pmc-agent-memory_delete` — remove a memory (soft by default)
- `pmc-agent-memory_search` — search by meaning and/or keywords (current project)
- `pmc-agent-memory_recall` — multi-topic contextual recall from previous sessions
- `pmc-agent-memory_list_recent` — most recent memories
- `pmc-agent-memory_find_related` — memories similar to a specific one
- `pmc-agent-memory_stats` — memory database statistics

### Session lifecycle — `pmc-agent-memory_*` server
- `pmc-agent-memory_set_session_context` — establish active session identity
- `pmc-agent-memory_get_session_context` — retrieve current session context
- `pmc-agent-memory_store_session_prompt` — record a user prompt (auto-captured by plugin)
- `pmc-agent-memory_store_session_response` — record an agent response (auto-captured by plugin)
- `pmc-agent-memory_store_session_tool_call` — record a tool call (auto-captured by plugin)
- `pmc-agent-memory_store_session_summary` — end-of-session summary
- `pmc-agent-memory_get_session` — retrieve the full session ledger
- `pmc-agent-memory_list_sessions` — list recent sessions
- `pmc-agent-memory_link_prompt_to_memory` — connect a prompt to a stored memory

### Topic & lifecycle — `pmc-agent-memory_*` server
- `pmc-agent-memory_suggest_topic_key` — deterministic topic key from type+title
- `pmc-agent-memory_upsert_topic_alias` — create or update a stable topic key
- `pmc-agent-memory_resolve_topic` — find a memory by topic key
- `pmc-agent-memory_update_memory_status` — transition between lifecycle states
- `pmc-agent-memory_prune` — remove low-strength dormant memories

### Error tracking — `pmc-agent-memory_*` server
- `pmc-agent-memory_record_error` — save a debugged error and its solution
- `pmc-agent-memory_search_global_errors` — search cross-project error database (errors only)

### Project management (install/setup only) — `pmc-agent-memory_*` server
- `pmc-agent-memory_register_project` — register a project in the global store
- `pmc-agent-memory_sync_project_metadata` — update project context snapshot
- `pmc-agent-memory_merge_projects` — consolidate duplicate project names

---

## Running enrichment (`pmc enrich`) — launch rules

### ✅ Correct: use `--background` flag
```bash
pmc enrich . --background
```

### ❌ Wrong: PowerShell `Start-Process -WindowStyle Hidden`
```powershell
# DO NOT DO THIS
Start-Process -FilePath "npx" ... -WindowStyle Hidden
```

### Still-Alive watchdog
Cap: 3 automatic relaunches. Poll `pmc enrich-status` every ~30s:
- `running` → alive; loop
- `finished` → done; report summary
- `stalled`/`failed` + pending > 0 → relaunch if ≤3; if >3 tell user to run `/pmc-doctor`

---

## Working with unenriched symbols — graph.db structural fallback

When a symbol has no semantic enrichment (status is `pending` or `stale`), the graph still contains full structural information.

| Available | Not available (requires enrichment) |
|-----------|-------------------------------------|
| Symbol name, kind, language | Responsibility / purpose description |
| File path and line range | Input/output semantics |
| Direct dependencies (imports) | Role in module |
| Direct dependents (who uses it) | Cross-symbol semantic relationships |
| Call graph edges | Natural language summaries |

### Strategy when enrichment is absent
1. `pmc get-context <symbol> extended dependencies` — dependency graph first
2. Read source file for the specific symbol (not the whole file)
3. `pmc get-context <symbol> extended callers` — understand usage
4. After changes: `pmc refresh-context --enrich` — queue for enrichment

This gives ~80% of enrichment value without waiting for LLM processing.
