# PMC Commands Reference

All commands are run via `pmc <command> [args]` (globally installed) or `node tools/project-memory-context/cli/<command>.mjs [args]` (source repo).

## Registered Commands

The `pmc` binary dispatches to these subcommands (defined in `src/command-dispatch.mjs`):

| Command | CLI File | Purpose | Example |
|---------|----------|---------|---------|
| `backfill-symbol-keys` | `cli/backfill-symbol-keys.mjs` | Plans or explicitly applies symbol-key attachments for legacy memories found by known index tags | `pmc backfill-symbol-keys .` |
| `doctor` | `cli/doctor.mjs` | Runs health checks on the PMC environment (Node, Python, Ollama, agent-memory) | `pmc doctor .` |
| `enrich` | `cli/enrich.mjs` | Launches enrichment queue for pending/stale symbols | `pmc enrich .` |
| `enrich-status` | `cli/status.mjs` | Reports current enrichment status: counts of pending/enriched/error entries, queue state | `pmc enrich-status .` |
| `get-context` | `cli/context.mjs` | Retrieves structural context for a target (file or symbol) at configurable depth | `pmc get-context src/index.ts` |
| `help` | — | Shows usage text | `pmc help` |
| `init-project` | `cli/init.mjs` | Initializes PMC for an agent type (opencode, claude-code, cursor, generic) | `pmc init-project --agent opencode` |
| `install-pmc` | `cli/install-pmc.mjs` | Installs PMC tooling into a target project | `node install-pmc.mjs` |
| `map-project` | `cli/bootstrap.mjs` | Bootstraps a new project: sets up directories, enrichment config, graphify, and initial graph | `pmc map-project [target-repo]` |
| `project-context` | `cli/project-context.mjs` | Detects and materializes project-level context (stack, structure, architecture) into memories | `node project-context.mjs` |
| `query` | `cli/query.mjs` | Queries PMC project-context and symbol artifacts with a natural language question | `pmc query "how does auth work?"` |
| `refresh-context` | `cli/refresh-context.mjs` | Incrementally refreshes the knowledge graph by detecting changed files and updating symbol deltas | `pmc refresh-context --enrich` |
| `retry-errors` | `cli/retry-errors.mjs` | Retries failed enrichment entries from the worklist using configured providers | `pmc retry-errors` |
| `sanitize` | `cli/sanitize.mjs` | Rebuilds PMC graph artifacts by re-extracting symbols, re-hashing, and re-syncing | `pmc sanitize` |
| `session-start` | `cli/session-start.mjs` | One-shot session initializer: checks enrichment, launches background processes, reports pending sync ops | `pmc session-start .` |
| `setup` | `cli/setup.mjs` | Interactive setup wizard: runs doctor, installs graphify, bootstraps project, configures agent templates | `pmc setup --opencode` |
| `sleep-config` | `cli/sleep-config.mjs` | Read, validate, or edit the global sleep-mode configuration | `pmc sleep-config show` |
| `sleep-run` | `cli/sleep-run.mjs` | One-shot maintenance pipeline: decay evaluation, promotion, enrichment with checkpointing | `pmc sleep-run --db ./memory.db` |
| `sleep-watch` | `cli/sleep-watch.mjs` | Idle daemon that monitors CPU/idle state and spawns sleep-run when eligible | `pmc sleep-watch` |
| `subagent-apply` | `cli/subagent-apply.mjs` | Persists enrichment results from an agent subagent into the standard PMC pipeline; entries queued with narrative metadata (`promptVersion`/`schema`/`knownGraphKeys`) are validated against the shared narrative schema first, and invalid output marks the entry `error` instead of `enriched` | `pmc subagent-apply . --entry-id <id> --content-file <path>` |
| `sync-context` | `cli/sync.mjs` | Syncs pending enrichment data from the local graph into agent memory via MCP | `pmc sync-context` |
| `view-context` | `bin/pmc-view-context.mjs` | Opens the PMC Graph Explorer web UI | `pmc view-context` |
| `watch` | `cli/watch.mjs` | Watches project files for changes with debounced refresh-context triggers | `pmc watch .` |

## backfill-symbol-keys Details

`pmc backfill-symbol-keys [project-root] [--apply] [--project-slug <name>]` defaults to a read-only dry run. It loads only `<project-root>/.planning/project-memory-context/enrichment/symbol-index.json` and `<project-root>/.mcp.json`, then searches the existing exact `key:symbol:<safe-key>` tags for each eligible indexed symbol. It never scans agent-memory for unknown tagged records; coverage is explicitly limited to known index keys. Capped lookups make coverage incomplete and refuse the entire apply run, including otherwise eligible mappings. `--apply` is the only mode that calls `attach_symbol`, sequentially, stopping on the first MCP error and reporting successful IDs and the original failure.

The default project tag follows `enrich-queue`: `PMC_PROJECT_SLUG` when set, otherwise the project-root basename. Projects whose other memory producer uses a different slug or case must provide its exact value with `--project-slug`; values are not normalized or lowercased. Unknown tag coverage is not expanded by an override.

Examples:

```sh
pmc backfill-symbol-keys .
pmc backfill-symbol-keys . --project-slug "Exact Project Slug"
pmc backfill-symbol-keys . --apply
```

## sync-context Details

`pmc sync-context` applies pending `sync-manifest.json` entries to agent-memory over MCP. Lookup is hybrid (full-text query + key-tag filter) and duplicate records converge to one per key. Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--checkpoint-batch-size <n>` | 25 (allowed 1–200) | Successfully applied entries committed ("marked synced" — one manifest write) per checkpoint; a final flush commits the remainder. `--detach` forwards the flag to the background worker. |

Behavior and caveats:

- **Serial by design — there is no `--concurrency` flag.** Entries mutate shared agent-memory records in manifest order. Concurrent lookups could act on stale snapshots (for example a prefetched miss followed by a same-key store would duplicate the record), so mutations and checkpoints stay serial. The batched checkpoint removes the dominant per-entry cost instead: previously every entry triggered one manifest write plus one sync-state write.
- **Only committed checkpoints count as synced.** Any pre-checkpoint gate failure or checkpoint write failure aborts the whole batch with zero commits — a selective commit around a failed gate could let an older uncommitted mutation overwrite a newer committed one on the next run. Applied-but-uncommitted entries remain pending and are re-applied idempotently. Fatal aborts exit nonzero and log the reason in both foreground and background.
- **A failed entry halts later entries with the same key tag** (per-key order preserved); other keys continue. Failed and halted entries stay pending and the exit code is nonzero.
- **Progress state writes follow the checkpoint cadence**, plus a 10-second heartbeat timer; failed and finished states report truthful synced/errors/pending counts. Progress observers are best-effort: a failing observer is logged and never fails the run or double-counts committed entries.
- **Lock guard:** foreground and background share `sync.lock`. Both modes re-verify on-disk ownership read-only (`isOwner` — token check, no heartbeat write) before every mutation and checkpoint, so a takeover between timer ticks aborts new work; an unreadable lock record fails closed as an abort. An orphaned atomic transition guard also fails closed — live PIDs are never evicted automatically. After verifying no sync process is actually running (check the PID recorded in the lock), remove the stale lock manually to recover.
- **CPU:** sync is local JSON/FTS work plus MCP round-trips. It performs no embedding inference and no embeddings-model changes; heavy CPU work lives in enrichment, not here.

## Enrichment Output Language

All future symbol enrichments explicitly instruct the model to **write descriptive explanation fields in English**, regardless of source-comment or conversation language, while preserving code, identifiers, paths, tags, and structured keys verbatim. This applies to every prompt surface the pipeline builds: `enrich`/`enrich-queue`, `retry-errors`, the semantic-unit prompt, the local-model MCP `semantic_report` system prompt, and the subagent wrapper instructions in the agent templates (which also cover already-queued entries whose stored prompt predates this requirement — the queue itself is not rewritten).

Scope notes:
- This is a prospective prompt requirement only. Existing enriched memories, queued records, and databases are not re-enriched or translated.
- `symbol.language` continues to hold the programming language; it is never set to a natural-language code.
- The instruction is part of the prompt contract; actual output quality depends on the model and is not guaranteed.

## Trivial-Symbol Narrative Templates (F3.4 opt-in fast path)

In explicit narrative mode (an injected `narrativeContext` / `narrativeResolver`; there is still no CLI flag, config key or automatic activation), a structurally proven trivial symbol — a getter, or fewer than 5 physical code lines without branching — receives a deterministic template narrative and makes **no model call**: the queue skips the Ollama tokenizer probe, the provider/fallback chain and the subagent route before any model-bound work. Template results persist through the same validated narrative path (validated JSON in `content`, template summary in the index `semanticSummary`, a sync-manifest upsert) with no attempt records, and empty `sideEffects`/`errors`/`contracts`/`mentions` lists mean "uninferred", never "proved absent". Triviality is proven from the real Tree-sitter AST over the declared symbol range (never from names), limited to the javascript/typescript/tsx/python/csharp grammars; unsupported grammars, syntax errors and unreadable or invalid ranges keep the standard model-backed flow. The default `pmc enrich` text flow is byte-for-byte unchanged. See `docs/DEVELOPMENT.md` ("Trivial-Symbol Template Fast Path") for the proof vocabulary and public hooks.

## Internal CLI Scripts

These scripts exist in `cli/` but are not registered as `pmc` subcommands. They are used internally by the enrichment pipeline:

| Script | Purpose |
|--------|---------|
| `enrich-queue.mjs` | Main enrichment queue processor (internal; use `enrich` as the entry point) |
| `enrich-watchdog.mjs` | Background watchdog that monitors the enrichment queue and relaunches on stalls |
| `build-worklist.mjs` | Builds enrichment worklist from source files by extracting top-level symbols |
| `apply-enrichment-result.mjs` | Applies a JSON enrichment result payload to the project graph, index, and worklist |
| `finalize-enrichment.mjs` | Finalizes an enrichment result by persisting to graph, index, and worklist |
| `fail-enrichment.mjs` | Records an enrichment failure for a symbol |
| `prepare-semantic-jobs.mjs` | Prepares semantic enrichment job definitions from the current worklist |
| `materialize-enrichment-artifacts.mjs` | Materializes enrichment job and report into persisted memory files |
| `save-intake-context.mjs` | Saves an intake context (project description + mapping goals) as a JSON artifact |

## Context Depth Levels

### Facts-only MCP tools

`pmc_relations({target, direction: "in" | "out", relations?, depth?})`
returns `{status, target, direction, depth, edges}` for a resolved target.
Edges carry typed canonical symbol endpoints (`symbolKey`, registry `id`,
`kind`, `path`) or file endpoints (`file|<path>`, `kind: "file"`, `path`).
`inbound`/`outbound` are accepted direction aliases. Depth is an integer
from 1 through 3 (default 1); relation types are `calls`, `imports`,
`imports_from`, `contains`, and `method`. Symbol import edges are file-scoped
and marked `scope: "file"`, not individual symbol-use claims.

`pmc_card({target})` returns `{status, target, facts, enrichment}` for a
symbol or file. Symbol enrichment is the existing semantic summary; file
cards currently return an empty enrichment string rather than inventing a
narrative. Targets accept a canonical key, graph node ID, name, `path#name`,
or file path (`file|<path>` is also accepted). Ambiguous results return `{status: "ambiguous", candidates}`
with canonical identities; missing symbols return `status: "missing"`.
Files absent from graph nodes and native evidence also return `status: "missing"`.
File exports, members and counts use the same validated identity registry as
symbol queries. Unknown explicit arguments, including future `level` or
`stopAtRole` options, are rejected rather than silently discarded.
These readers require an existing `graph.db`, open it read-only, and close
it per request. Missing databases produce an explicit MCP tool error and
are never created implicitly. Dependency aliases retain their legacy array
shape and artifact fallback for legacy schemas or partially canonicalized
neighbors; this fallback is never native proof for the new facts tools.
When a canonical persisted role assignment exists, symbol/file facts include
`roleClassification: {role, layer, confidence, evidence}`. No assignment adds no
field; explicitly unknown assignments preserve null role/layer, zero confidence,
and empty evidence. Role queries are read-only and do not trigger classification.
Generated narratives, levels and role-aware stopping remain later-phase work.

### CLI target resolution

Symbol targets accept an exact canonical `symbolKey`, a graph node ID, a name,
or `path#name`. Bare member names such as `findById` match terminal member
names; multiple matches remain ambiguous and display their canonical keys.

```sh
pmc get-context symbol findById compact callers
pmc get-context symbol "src/services/user.service.ts#findById" compact all
```

For symbol targets, `callers` and `impact` traverse inbound relationships;
`all` labels outbound and inbound groups separately. Native static call
evidence is used when available, while graph-only projects retain legacy
traversal and other Graphify relation types remain available. Constructor
instantiation edges do not appear as named callers/callees. File/query modes
and depth defaults are unchanged.

Assigned symbol/file targets also show `role`, `layer`, `confidence`, and
`evidence` under `Target`, at every existing depth/focus. Unassigned targets keep
their previous output exactly. An explicit unknown assignment shows `null` for
role/layer, `0` confidence, and `none` evidence; it is not a new role enum.

Used with `get-context`:

| Depth | Description |
|-------|-------------|
| `compact` | Summary with key relationships (default) |
| `extended` | Includes dependencies and extended metadata |
| `deep` | Full traversal with all available detail |
| `disk` | Raw source code of the target |
