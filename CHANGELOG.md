# Changelog

All notable changes to the PMC toolchain are documented in this file.

## [Unreleased] — Symbol-Linked Memory Context

### Added

- **Soft symbol links** (implemented in `agent-memory-mcp/src/sqlite-store.ts`): optional `symbol_key` (`lang|path|kind|scope|name|arity`) on `memories` and all 4 session-ledger tables. Survives graph rebuilds; unresolved keys soft-miss (empty result, never an error).
- **Symbol MCP tools** (implemented in `agent-memory-mcp/src/tools.ts`): `attach_symbol` (upsert a symbol key onto a memory/session item), `get_by_symbol` (retrieve all records linked to a symbol), `enrich_symbols` (per-symbol enrichment batch — unknown keys soft-miss without failing the batch).
- **Project-scoped session retrieval** (implemented in `agent-memory-mcp/src/sqlite-store.ts`): session rows carry `project_id`; `search_sessions` is **default-deny** for legacy null-project rows unless `includeLegacy: true`. `set_session_context` backfills `project_id` on existing rows (idempotent).
- **get-context semantic composition** (implemented in `tools/project-memory-context/cli/context.mjs`, `src/retrieval/query-engine.mjs`, `src/retrieval/context-renderer-v1.mjs`): `pmc get-context <symbol>` composes a **Semantic Memory** section from `symbol_key`-linked memories. New `cli/memory-store-loader.mjs` opens the agent-memory DB read-only via `node:sqlite` (build-independent, legacy-DB-safe). Depth-aware rendering (compact = 200 chars, extended/deep = full, disk = full + source).
- **Lock-tolerant retrieval** (implemented in `tools/project-memory-context/cli/lock-retry.mjs`, `src/graph-store/graph-db.mjs`): `withLockRetry` (WAL + `busy_timeout=5000` + 3-attempt exponential backoff with stale fallback) wraps enrichment reads.
- **Schema v7**: `symbol_key` on `memories`; `project_id`/`symbol_key` on all 4 session tables; indexes on every new column.

### Changed

- `parseSearchQuery` now accepts `projectId` and `includeLegacy` and flows them through to project-scoped session search (previously `projectId` was rejected).

## [Unreleased] — PMC Sleep Mode, Gradual Forgetting & Semantic Search

### Added

- **Gradual forgetting state machine** (implemented in `agent-memory-mcp/src/decay.ts`): memories decay through stages (`active → cooling → dimmed → shadow → gist_only → purged`) based on usage. Configurable thresholds in global config. `activation_score` modulates recall weight.
- **Gist preservation** (implemented in `agent-memory-mcp/src/sqlite-store.ts`): before pruning, the system creates compressed gists in `memory_gists` with `core_fact`, `why_it_matters`, and `revive_triggers`. Gists are non-forgettable and survive original purge.
- **Revive gate** (implemented in `agent-memory-mcp/src/sqlite-store.ts`): LLM/local model judges prune candidates as `revive`, `prune`, or `defer` (confidence < 0.7). Decisions recorded in `memory_revive_reviews`.
- **Global promotion** (implemented in `agent-memory-mcp/src/global/global-promotion.ts`): repeated useful patterns (2+ projects, 2+ critical recurrences, 3+ revivals) are promoted to global memory. Audit trail in `global_promotion_log`.
- **Sleep mode** (implemented in `agent-memory-mcp/src/sleep-run.ts`, `sleep-watch.ts`, `sleep-config.ts`): idle-time maintenance with keep-awake lease, symbol-boundary yielding, crash recovery with checkpoints. CLI wrappers: `pmc sleep-run`, `pmc sleep-watch`, `pmc sleep-config`.
- **Unified semantic search surfaces** (implemented in `agent-memory-mcp/src/sqlite-store.ts`): `search_sessions`, `search_global`, `recall_global` with typed `UnifiedSearchResult`, `DecisionHint`, `contentRef`, source balancing, compacted-first session search.
- **Schema v4–v6**: `memory_gists`, `memory_decay_log`, `memory_revive_reviews`, `global_promotion_log` tables; `activation_score`/`memory_state`/`last_reinforced_at` on `memories`; `gist_id`/`confidence` on `memory_revive_reviews`.
- **Sleep configuration**: global config at `~/.config/opencode/project-memory-context.json` with `sleep` and `forgetting` sections.
- **Sleep reports**: JSON reports and checkpoints at `~/.config/opencode/pmc/sleep/runs/<runId>/`.

### Changed

- Temporal decay now factors in `activation_score` from gradual forgetting.
- Search explain mode includes `accessMultiplier` from activation score.

## [Unreleased] — Engram Features → PMC Backend

### Added

- **Session ledger**: five tables (`session_prompts`, `session_responses`, `session_tool_calls`, `session_summaries`, `session_memory_links`) with embeddings for queryable session history.
- **Session ledger tools**: `store_session_prompt`, `store_session_response`, `store_session_tool_call`, `store_session_summary`, `get_session`, `list_sessions`, `link_prompt_to_memory`.
- **Memory lifecycle**: `status` column on `memories` with `active → needs_review → archived` transitions. `update_memory_status` tool. `archived` excluded from default search.
- **Topic aliases**: `memory_topics` table, `upsert_topic_alias`, `resolve_topic`, `suggest_topic_key` tools. Deterministic slug-based key suggestion with deduplication.
- **Store upsert fix**: `store()` conflict branch now preserves `created_at`, merges provenance, increments `version`, and never downgrades status.
- **Session context**: `set_session_context`/`get_session_context` tools for auto-linking memories to sessions.
- **Project merging**: `merge_projects` tool with dry-run default, transactional execution, and self-merge rejection.
- **Schema v2**: `status`/`review_reason`/`reviewed_at` on `memories`; 6 new tables; 5 indexes.

## [Unreleased] — Unified PMC MCP + Background-Action Verification

### Added

- **Session-ledger lifecycle decay (schema v3)**: `updated_at`, `access_count`, `last_accessed_at`, and `status` columns on all 4 session tables.
- **`forget_session_item(id)` MCP tool**: soft-deletes a session record (`status='forgotten'`).
- **`purge_session_item(id)` MCP tool**: hard, destructive delete of a session record and its embedding.
- **Stale-reference audit** (`scripts/audit-stale-tool-refs.mjs`): fails CI if non-allowlisted legacy references remain.
- **Executable background-action E2E test**: proves long-running PMC actions run detached and non-blocking.
- **Migration guide** (`docs/MIGRATION.md`) for consumers moving to the unified server.

### Planned (Not Yet Implemented)

- **Unified `pmc` MCP server** (`pmc-mcp-server`): single server composing query + memory tools under one namespace.
- **Session summarization**: `pmc session-summarize <session-id>` using local-model pipeline (zero agent tokens).

### Deprecated

- `pmc-query` and `pmc-agent-memory` server keys and their `pmc-query_` / `pmc-agent-memory_` tool prefixes are transitional aliases for one release.

### Backward compatibility

- Legacy server keys remain callable during the transition release.
- Schema v3 migration is additive and idempotent.
