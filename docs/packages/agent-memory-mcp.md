# Agent Memory MCP — Full Reference

`@aabadin/agent-memory-mcp` is an MCP (Model Context Protocol) server backed by SQLite (WAL mode) with hybrid FTS5 BM25 + cosine vector search. It exposes memory storage, search, session ledger, lifecycle management, topic aliases, and global context tools over stdio transport.

**Package location**: `agent-memory-mcp/` (git submodule in the PMC monorepo)

## Architecture

```
Embedder → SqliteMemoryStore → [HardcopyMemoryStore] → MCP Server → stdio transport
```

- **Embedder**: Xenova/bge-m3 (1024 dimensions) via Hugging Face transformers. Lazy-loaded — the model is not downloaded until the first `store`/`search` call.
- **SqliteMemoryStore**: Main storage layer. Split-table layout (`memories` for metadata/FTS, `memory_embeddings` for vectors). IEEE 754 float32 BLOB vectors with in-process cosine distance.
- **HardcopyMemoryStore**: Decorator that mirrors mutations to `{id}.json` files on disk. Write-only; errors logged but never propagated.

## MCP Tools

Tools are registered on the `pmc-agent-memory` MCP server. Tool names below omit the `pmc-agent-memory_` prefix. A unified `pmc` server that composes both query and memory tools is planned (see [MIGRATION.md](../MIGRATION.md)).

### Storage Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `store` | `content`, `category`, `tags`, `provenance?` | Stored memory with ID | Store a single memory. On conflict (same ID), merges provenance, preserves `created_at`, increments `version`, never downgrades status. |
| `store_batch` | `memories[]` (each: `content`, `category`, `tags`, `provenance?`) | `{ stored, memories }` | Store multiple memories in one call. Use at end-of-session. |

**Provenance schema** (optional on `store`/`store_batch`):

```json
{
  "origin": "extracted | inferred | ambiguous | manual | unknown",
  "sourceTool": "pmc-enrichment/ollama",
  "sessionId": "session-abc",
  "contentHash": "sha256:..."
}
```

**12 memory categories**: `code-solution`, `bug-fix`, `architecture`, `learning`, `tool-usage`, `debugging`, `performance`, `security`, `observation`, `personal`, `relationship`, `other`

### Search Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `search` | `query`, `mode?` (`hybrid`/`keyword`/`semantic`), `category?`, `tags?`, `after?`, `before?`, `limit?`, `explain?` | `{ count, results }` | Hybrid FTS5 BM25 + cosine vector search with Reciprocal Rank Fusion (RRF k=60). Default mode: `hybrid`. Temporal decay applied on-read. |
| `recall` | `topics[]`, `include_recent?`, `limit_per_topic?` | `{ byTopic, recent }` | Multi-topic contextual recall. Searches multiple topics in parallel and includes recent memories. The "morning coffee" tool. |
| `find_related` | `memory_id`, `limit?` | `{ count, results }` | Find memories similar to a specific memory using embedding similarity. |
| `list_recent` | `limit?`, `category?` | `{ count, memories }` | List most recent memories, optionally filtered by category. |

**Search modes**:
- `hybrid` (default): BM25 keyword + cosine vector via RRF
- `keyword`: FTS5 BM25 only
- `semantic`: Cosine vector distance only

**Explain mode** (`explain: true`): Returns per-stage scoring breakdown per result — `keywordRank`, `semanticCosine`, `decayFactor`, `accessMultiplier`, `finalScore`.

### Management Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `update` | `id`, `content?`, `category?`, `tags?` | Updated memory | Update an existing memory. If `content` changes, embedding is regenerated. |
| `delete` | `id` | `{ deleted, id }` | Permanently remove a memory by ID. |
| `stats` | _(none)_ | Statistics object | Total count, category breakdown, oldest/newest timestamps, access patterns, prune-eligible counts. |
| `prune` | `dryRun?` (default `true`), `minStrength?` (default `0.05`), `maxDormantDays?` (default `90`) | Prune candidates/results | Prune low-strength and dormant memories. Evergreen memories (tagged `evergreen` or `never-forget`) are always preserved. |

### Lifecycle Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `update_memory_status` | `memory_id`, `status` (`active`/`needs_review`/`archived`), `review_reason?` | Updated memory | Transition a memory between lifecycle states. Transitions are one-way: `active → needs_review → archived`. `archived` cannot downgrade. |

**Lifecycle rules**:
- `search` and `list_recent` exclude `archived` by default
- `status: 'all'` returns every state
- `store()` preserves existing status on conflict (never downgrades)
- `review_reason` is required for `needs_review` and `archived` transitions

### Topic Alias Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `upsert_topic_alias` | `topic_key`, `memory_id` | `{ topic_key, memory_id }` | Create or update a stable topic key that points to a memory. Idempotent — replaces the mapped `memory_id` for the same `topic_key`. |
| `resolve_topic` | `topic_key` | Memory array | Find a memory by its topic key. Returns null/not-found if no alias exists. |
| `suggest_topic_key` | `content`, `category?`, `tags?` | `{ topic_key }` | Suggest a deterministic topic key derived from content. Deduplicates against existing keys. |

**Topic key format**: lowercase slug, non-alphanumeric → hyphen, max 60 chars. Example: `architecture/auth-model`.

**Store-driven alias creation**: `store()` accepts optional `topic_key` and creates/refreshes the alias automatically.

### Session Context Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `set_session_context` | `session_id`, `project_id` | `{ sessionId, projectId }` | Set the active session context. All subsequent `store()`/`update()` calls are auto-linked to this session. |
| `get_session_context` | _(none)_ | Context object or null | Get the currently active session context. |

### Session Ledger Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `store_session_prompt` | `session_id`, `raw_prompt` | Prompt with ID | Record a user prompt. Returns the prompt ID. |
| `store_session_response` | `session_id`, `prompt_id`, `full_response` | Response with ID | Record an assistant response linked to a prompt. |
| `store_session_tool_call` | `session_id`, `tool_name`, `args_safe?`, `result_summary?`, `importance?` (`high`/`normal`/`low`), `prompt_id?`, `response_id?` | Tool call with ID | Record an important tool call. |
| `store_session_summary` | `session_id`, `summary`, `decisions?`, `key_titles?`, `memory_ids?`, `artifact_refs?`, `prompt_id?`, `response_id?` | Summary with ID | Store a generated session summary. Structured fields are JSON arrays. |
| `get_session` | `session_id`, `limit?`, `include_summary?` (default `true`) | Session ledger | Retrieve full session: prompts, responses, tool calls, summaries. Ordered by `created_at`. Forgotten rows hidden by default. |
| `list_sessions` | `limit?` | `{ count, sessions }` | List recent sessions with prompt count and last activity time. |
| `link_prompt_to_memory` | `prompt_id`, `memory_id`, `relation` (`created_from`/`updated_by`/`referenced`), `response_id?` | `{ linked }` | Explicitly link a session prompt/response to a memory. |

**Session lifecycle fields** (schema v3): `updated_at`, `access_count`, `last_accessed_at`, `status`. Read operations increment `access_count` and update `last_accessed_at`. Records with `status='forgotten'` are excluded from default retrieval.

### Session Forget/Purge Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `forget_session_item` | `id` | `{ type, success }` | **Soft delete**: sets `status='forgotten'`, hidden from default retrieval/search but recoverable. Works on prompts, responses, tool calls, and summaries. |
| `purge_session_item` | `id` | `{ type, success }` | **Hard delete**: permanently removes the row AND its embedding. Irreversible. Never triggered automatically by decay/retention. |

**Safety**: Hard purge requires explicit tool invocation. Decay and retention only perform soft forget. Both tools reject unknown or ambiguous IDs.

### Global Context Tools

These tools are registered only when a `GlobalStore` is provided (the unified `pmc` server always provides one).

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `register_project` | `name`, `rootPath`, `objective?`, `stack?`, `architecture?` | Project record | Register a project in the global context store. Idempotent. |
| `sync_project_metadata` | `projectId`, `objective?`, `stack?`, `architecture?`, `dependencies?`, `minimap?` | Updated record | Update the global context snapshot for a project. |
| `record_error` | `projectId`, `message`, `stack?`, `rootCause?`, `fix`, `files?`, `tags?`, `source` (`auto`/`manual`) | Error record | Record a debugged error and its solution. Deduplicated by (message + root_cause) per project. |
| `search_global_errors` | `query`, `projectId?`, `limit?` | `{ count, results }` | Search the global cross-project error database. Hybrid FTS5 + semantic search. |
| `merge_projects` | `source_project_id`, `target_project_id`, `dry_run?` (default `true`) | Merge result | Consolidate duplicate project names. Moves memories/errors from source to target. Dry-run is default. Transactional; refuses self-merge. |

## Session Ledger

### Schema

Five tables persist the session ledger:

| Table | Key Columns | Purpose |
|-------|------------|---------|
| `session_prompts` | `id`, `session_id`, `raw_prompt`, `embedding` | User prompts |
| `session_responses` | `id`, `session_id`, `prompt_id` (FK), `full_response`, `embedding` | Assistant responses |
| `session_tool_calls` | `id`, `session_id`, `prompt_id?`, `response_id?`, `tool_name`, `args_safe`, `result_summary`, `importance`, `embedding` | Tool invocations |
| `session_summaries` | `id`, `session_id`, `prompt_id?`, `response_id?`, `summary`, `decisions` (JSON), `key_titles` (JSON), `memory_ids` (JSON), `artifact_refs` (JSON), `embedding` | Generated summaries |
| `session_memory_links` | `prompt_id`, `response_id`, `memory_id` (FK→memories), `relation` | Prompt↔memory relationships |

All tables have `created_at`, `updated_at`, `access_count`, `last_accessed_at`, `status` (added in schema v3).

### Access Tracking

Reading session records through `get_session`, `list_sessions`, or search increments `access_count` and updates `last_accessed_at`.

### Decay

Session records participate in the same decay model as memories:
- `status='forgotten'` records are hidden by default
- Access tracking updates on every read
- No automatic purge — only explicit `purge_session_item` removes rows

## Memory Lifecycle

### States

```
active → needs_review → archived
```

- `active`: Default state. Included in all searches.
- `needs_review`: Flagged for human/model review. Still searchable.
- `archived`: Excluded from default search/list. Requires `status: 'all'` to appear.

### Transitions

| From | To | Allowed | Notes |
|------|-----|---------|-------|
| `active` | `needs_review` | Yes | Requires `review_reason` |
| `active` | `archived` | Yes | Requires `review_reason` |
| `needs_review` | `archived` | Yes | Requires `review_reason` |
| `needs_review` | `active` | Yes | Explicit reactivation |
| `archived` | _anything_ | **No** | `archived` is terminal |

### Upsert Semantics

When `store()` encounters a conflict (same ID):
- `created_at` is preserved (never overwritten)
- `version` is incremented
- Provenance fields (`origin`, `sourceTool`, `sessionId`, `contentHash`) are merged — new values replace old, absent values keep existing
- Status is never downgraded (re-store without status is a no-op on status)

## Topic Aliases

### Storage

```sql
CREATE TABLE memory_topics (
  topic_key TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (topic_key, memory_id)
);
```

### Behavior

- `upsert_topic_alias`: Idempotent. Replaces the mapped `memory_id` for the same `topic_key`.
- `resolve_topic`: Returns the pointed memory. Fails with NOT_FOUND if no alias exists.
- `suggest_topic_key`: Deterministic slug from content. Deduplicates by appending `-2`, `-3`, etc.
- `store()` with `topic_key`: Auto-creates/refreshes the alias on insert or upsert.

## Project Merging

`merge_projects(source_id, target_id)`:

1. **Dry-run** (default): Reports what would move without modifying data.
2. **Apply**: Moves memories and errors from source to target in a transaction. Deletes the source project row after commit.
3. **Self-merge rejected**: Same source and target ID fails with `INVALID_ARGUMENT`.

## Temporal Decay

Memories have exponential temporal decay applied on-read:

```
score = base_score × decay_factor
decay_factor = 2^(-age_days / half_life_days)
```

- Default half-life: 30 days (configurable via `MEMORY_DECAY_HALF_LIFE` env var)
- Set `MEMORY_DECAY_HALF_LIFE=0` to disable decay
- Memories tagged `evergreen` or `never-forget` are exempt from decay
- Access tracking provides spaced-repetition reinforcement

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MEMORY_DB_PATH` | Yes | — | SQLite database path on disk |
| `EMBEDDING_MODEL` | No | `Xenova/bge-m3` | HuggingFace model ID |
| `EMBEDDING_DIMENSIONS` | No | `1024` | Vector dimensions |
| `EMBEDDING_POOLING` | No | `cls` | Pooling mode (`cls` for BGE, `mean` for MiniLM) |
| `MEMORY_DECAY_HALF_LIFE` | No | `30` | Temporal decay half-life in days. `0` disables. |
| `ENABLE_HARDCOPY` | No | `false` | Set `'true'` to enable JSON file backup |
| `HARDCOPY_PATH` | Conditional | — | Directory for JSON mirror files (required if hardcopy enabled) |
| `EMBEDDING_CACHE_PATH` | No | — | Directory for content-addressed binary embedding cache |

## Building and Testing

```bash
cd agent-memory-mcp
npm install
npm run build    # tsc → dist/
npm test         # vitest run
npx vitest run tests/tools.test.ts        # single file
npx vitest run -t "store tool"            # single test by name
```

See [DEVELOPMENT.md](../DEVELOPMENT.md) for full setup instructions.
