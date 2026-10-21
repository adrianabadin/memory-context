# PMC Commands Reference

All commands are run via `pmc <command> [args]` (globally installed) or `node tools/project-memory-context/cli/<command>.mjs [args]` (source repo). Top-level flags `pmc --help` and `pmc --version` are also supported.

## Registered Commands

The `pmc` binary dispatches to these subcommands (defined in `src/command-dispatch.mjs`):

| Command | CLI File | Purpose | Example |
|---------|----------|---------|---------|
| `--help` | — | Shows usage text (alias for `help`) | `pmc --help` |
| `--version` | — | Prints installed package version | `pmc --version` |
| `backfill-symbol-keys` | `cli/backfill-symbol-keys.mjs` | Plans or explicitly applies symbol-key attachments for legacy memories found by known index tags | `pmc backfill-symbol-keys .` |
| `card` | `cli/card.mjs` | Read-only file/community/explicit-feature cards with accepted narrative provenance | `pmc card file src/index.ts` |
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
| `subagent-apply` | `cli/subagent-apply.mjs` | Persists enrichment results from an agent subagent into the standard PMC pipeline; entries queued with narrative metadata (`promptVersion`/`schema`/`knownGraphKeys`) are validated against the shared narrative schema first, entries carrying opt-in fingerprint evidence are additionally re-derived against the current source bytes (a changed/vanished/tampered queued fingerprint is rejected before any accepted write), and invalid output marks the entry `error` instead of `enriched` | `pmc subagent-apply . --entry-id <id> --content-file <path>` |
| `sync-context` | `cli/sync.mjs` | Syncs pending enrichment data from the local graph into agent memory via MCP | `pmc sync-context` |
| `view-context` | `bin/pmc-view-context.mjs` | Opens the PMC Graph Explorer web UI | `pmc view-context` |
| `watch` | `cli/watch.mjs` | Watches project files for changes with debounced refresh-context triggers | `pmc watch .` |

## card — Aggregate Cards (S23)

Run inside a PMC-enabled project (root found by walking up to `install.json`):

```bash
pmc card file src/services/user.service.ts
pmc card community 1
pmc card feature auth --member "ts|src/auth.ts|function|exported|login|2" --member "file|src/auth.ts"
pmc card --help
```

Only `--member <canonical-key>` (repeatable, feature only) and `--help`/`-h` are supported. No `--level`, depth, project-root flag or inferred membership. Each subcommand takes exactly one positional argument; feature requires nonempty, duplicate-free members. Valid output is deterministic pretty JSON on stdout (exit 0); errors have empty stdout, diagnostic stderr and exit 1. Help is stdout, exit 0. Withheld narrative reasons are JSON `diagnostics`, not stderr warnings. Unverifiable explicit members remain honest `rejected` entries; file membership does not implicitly select all its symbols.

The shared query registry now exposes eleven tools, adding these strict read-only tools (unknown options reject):

- `pmc_file_rollup({target: string})`: canonical existing graph FILE only (`path` or `file|path`); a symbol returns `status: 'not-a-file'`, absent files return `missing`, ambiguous identities return candidates. Uses `buildFileNarrativeRollup`.
- `pmc_community_card({communityId: string | number})`: actual graph community assignments; internally scans all coherent known file nodes, indexed source files and canonical native-import file endpoints. `scannedFiles` reports the full enumeration even for files lacking symbol rows. Unknown communities yield empty members and stored name or null.
- `pmc_feature_card({name: string, members: string[]})`: explicit canonical symbols/files verified against the graph; no feature inference or persistence.

None accepts `level`. Existing eight descriptors and `pmc_card` defaults remain unchanged, including file `enrichment: ''` when narrative artifacts exist.

Narratives require matching validated stored fingerprints in symbol-index, unique worklist entry and canonical `.memory.json` artifact, plus artifact key identity and shared schema/graph-mention validation. Missing, malformed, stale, conflicting, foreign, ambiguous or escaped evidence is withheld in `diagnostics`; summaries are never fabricated from `semanticSummary`. No accepted artifacts means empty narratives/text. DB, metadata and artifact realpaths must remain contained; symlink/junction escapes fail closed. These are read-only SQLite/artifact operations: no DDL, config writes, providers or model calls. Acceptance checks the stored three-way binding, **not live source recomputation**; it cannot detect source edits not yet reflected in those stored fingerprints. This is not real Pi runtime acceptance.

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

In explicit narrative mode (an injected `narrativeContext` / `narrativeResolver`; there is still no CLI flag, config key or automatic activation), a structurally proven trivial symbol — a getter, or fewer than 5 physical code lines without branching — receives a deterministic template narrative and makes **no model call**: the queue skips the Ollama tokenizer probe, the provider/fallback chain and the subagent route before any model-bound work. Template results persist through the same validated narrative path (validated JSON in `content`, template summary in the index `semanticSummary`, a sync-manifest upsert) with no attempt records, and empty `sideEffects`/`errors`/`contracts`/`mentions` lists mean "uninferred", never "proved absent". If the symbol's source changes or disappears between the queue's initial proof and the runner's independent recheck, the bypassed symbol fails closed with an honest source-changed/unavailable error — no model call, no template/"no model call" success claim, previously accepted artifacts preserved — and is retried through the normal queue on a later pass. Triviality is proven from the real Tree-sitter AST over the declared symbol range (never from names), limited to the javascript/typescript/tsx/python/csharp grammars; unsupported grammars, syntax errors and unreadable or invalid ranges keep the standard model-backed flow. The default `pmc enrich` text flow is byte-for-byte unchanged. See `docs/DEVELOPMENT.md` ("Trivial-Symbol Template Fast Path") for the proof vocabulary and public hooks.

## Narrative Fingerprint Cache Reuse (F3.5 opt-in, N5B)

Still only in explicit narrative mode (the injected `narrativeContext` / `narrativeResolver`; no CLI flag, no config key, no automatic activation), the queue now derives the accepted fingerprint `narrativeHash = h(code, signature, role, calleeSummaryHashes, promptVersion)` over the exact prompt source slice and the canonical FULL callee summary text list, and checks it **before** the template proof, the Ollama tokenizer probe, the provider/fallback chain and the subagent route. A matching stored fingerprint on the worklist, the symbol index and the accepted artifact — with accepted `content` that still validates against the shared narrative schema and canonical graph keys — reuses the accepted memory with **zero tokenizer, provider, subagent and template work**, reported honestly as `REUSE … accepted narrative cache hit` with empty attempts and no memory/provider-event/sync-manifest write. Mere file existence is never a cache proof: corrupt JSON, a wrong key, missing content, a missing stored hash, invalid mentions/schema or a mismatching fingerprint fail closed into exactly one baseline generation, with the miss reason reported (`STALE <symbol> — <reason>`). A successful validated narrative or template persists the aligned `narrativeHash`, complete `calleeSummaryHashes` and `promptVersion` on the worklist entry, the symbol index and the accepted artifact's `narrativeEvidence` block; a failed or rejected run preserves the previously accepted fingerprint, summary and bytes. Regeneration propagates upward **only** when a callee's accepted summary TEXT actually changes: every previously accepted dependent caller — identified through its complete stored callee-key hash map, never through display callers or names — is marked `stale` with `staleReason: 'callee-summary-changed'` for the next pass while keeping its accepted memory and fingerprint. Queued subagent entries carry the complete evidence bundle, and `pmc subagent-apply` re-derives it against the actual current source bytes: a changed, vanished or tampered queued fingerprint is rejected before any accepted write (`staleReason: 'queued-fingerprint-mismatch'`). Three internal gates keep the proof honest (no CLI flag, no config): the persisted fingerprint always derives from the exact source snapshot the prompt was built from (a disk that changed mid-run can never become a cache hit, and a prebuilt prompt without an inspectable snapshot claims no cache proof and persists no fingerprint), and the caller-owned resolver context (signature, nested role objects, callee data, symbol keys) is copied into an owned `structuredClone` snapshot before the queue's first await so all five fingerprint inputs and the prompt share one immutable value while the caller's object is never mutated or frozen; upward invalidation keys on the stored accepted fingerprint+dependency bundle rather than the transient worklist status, so a dependent stranded in `error` or `subagent-queued` is still marked `stale`/`callee-summary-changed` while unaccepted pending rows are never faked into accepted ones; and an explicit `narrativeEvidence: null` in the queue file is rejected exactly like `appendSubagentQueue` does (exit 1, error output, accepted bytes untouched) instead of downgrading to legacy success — only an absent field is legacy. The default `pmc enrich` text flow and all legacy entries stay byte-for-byte unchanged; concurrency and default activation remain N6. See `docs/DEVELOPMENT.md` ("Opt-In Narrative Fingerprint Cache and Summary Propagation") for the miss reasons and public hooks.

## Queue Concurrency (F3.6 / S12, N6B — environment only, no CLI flag)

The enrichment queue honors `PMC_CONCURRENCY` in its actual Ollama loop: the value is parsed once at module start with the historical semantics (raw default `8`, any non-positive or unparsable value falls back to `1`) and bounds the pool that runs every selected symbol's model and tokenizer work — prompt build, Ollama tokenizer probe, provider/fallback driver and subagent-route write share ONE global bound, so at most that many jobs are in flight while independent symbols overlap. There is **no `--concurrency` flag, no config key and no default narrative activation**: legacy text mode stays the default, and the bound applies to the legacy flow exactly as to the explicit narrative flow. Programmatic `main({concurrency})` exists for in-process callers only and rejects a malformed value before touching any file. Final output (keysets, `timing` order, per-symbol requests, summary counts) is aggregated in the original selected order, so results are deterministic regardless of completion order; the legacy flow also DISPATCHES in that selection order at any concurrency (concurrent FIFO up to the bound, never silently sequential), while explicit narrative mode keeps the pool's canonical SCC order. The start line reports what actually runs — `Starting concurrent enrichment` above bound 1, the historical `Starting sequential enrichment` at 1. Acceptance is published only after every acceptance write succeeds (worklist acceptance last, prior state restored on failure), so a rejected write is reported as an error and can never be counted or cached as accepted. In narrative mode, dependent symbols run leaf-first through the SCC barrier and each caller's context is resolved fresh at that barrier with the same-run accepted callee summaries overlaid — editing a caller never re-runs the LLM on the callee. Concurrent completions serialize their `worklist.json`/index/manifest read-merge-write through one in-process per-directory coordinator with atomic temp+rename writes and a bounded `EBUSY`/`EPERM` retry around file operations only (inference is never retried to repair a file lock; an exhausted retry surfaces as an error, never a false success). See `docs/DEVELOPMENT.md` ("Queue Concurrency, Fresh SCC Contexts and Serialized Writes") for the full contract.

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

`pmc_relations({target, direction: "in" | "out", relations?, depth?, stopAtRole?})`
returns `{status, target, direction, depth, edges}` for a resolved target.
Edges carry typed canonical symbol endpoints (`symbolKey`, registry `id`,
`kind`, `path`) or file endpoints (`file|<path>`, `kind: "file"`, `path`).
`inbound`/`outbound` are accepted direction aliases. Depth is an integer
from 1 through 3 (default 1); relation types are `calls`, `imports`,
`imports_from`, `contains`, and `method`. Symbol import edges are file-scoped
and marked `scope: "file"`, not individual symbol-use claims.

The optional `stopAtRole` argument takes a nonempty canonical role name —
from the packaged profile `roleLayers` vocabulary or a role actually
assigned in the project's canonical role ledger — and switches the
traversal to a role-stopping bounded walk over exactly the requested
direction/relations/depth: the first node on each traversed path whose
persisted role equals the requested role is retained as a boundary but
never expanded, while every tie or additional boundary is kept. Only with
the option present does the response add `stoppedAtRole` and `matches`
(`{symbolKey, role, distance, path}`, sorted by distance then canonical
key; `distance` counts relation hops and `path` is the evidence chain from
the start to the boundary); without it the response stays byte-identical to
the shape above. A matching start is a depth-0 boundary with no walk. A
container-level start may expand to its proven members at distance 0, and a
matched member projects to its uniquely resolved owner only when that
owner's own canonical role also equals the requested role — a non-matching,
absent, or explicitly unknown owner is never advertised, so the matching
member stays the boundary with its own role and path. Class or file
answers therefore reach class boundaries only through genuinely matching
owners; a member-level start keeps member boundaries. A member inherits a
container role only while its current node kind is role-eligible
(`symbol`/`member`, the same guard as the canonical role ledger), so an
excluded node such as a `doc` member neither matches nor inherits. Empty,
unknown, or non-string values reject with a tool error instead of being
ignored as success. Roles are read only from the `node_role_assignments`
ledger through the canonical role getter; metadata-only legacy roles never
match.

`pmc_entrypoints_for({target})` returns `{status, target, matches, entrypoints,
controllers}` — "which CLI commands, MCP tools, routes, or `main` functions
reach X". The walk is complete reverse `calls` reachability over the known
graph: iterative, each key visited once (cycles terminate), no hop limit, and
no cut at an intermediate controller or entrypoint, so an upstream `main` is
still reported behind a matching controller. Only actual call relations are
followed (native plus legacy through the same adapter, with constructor-edge
exclusions intact); imports and other relation types are never treated as
calls. `matches` is the deduplicated union — dedup key: canonical symbol key —
of application entrypoint evidence (canonical role `entrypoint`, `cli-command`
or `mcp-tool`, or any canonical classification with layer `entrypoint`, which
is how the fixture's role `cli` main qualifies) and controller evidence
(canonical role `controller`; express route handlers are classified
`controller`). `entrypoints` and `controllers` are the two projections of that
union (they may overlap when the canonical data justifies it); each match is
`{symbolKey, role, layer, distance, path}`, sorted by distance then canonical
key, where `distance` counts actual call hops (`path` includes the zero-hop
membership step when a class or file target expands to its proven members) and
`path` is the full evidence chain from the selected target. A recognized
entrypoint or controller target matches at distance 0 and the walk still
continues upstream. Membership expansion is fail-closed exactly like the
`stopAtRole` guards: only proven current registry containers/members expand,
an explicit unknown assignment never matches or inherits, excluded node kinds
never self-match or inherit, metadata-only legacy roles never count, and
foreign, prefix or ambiguous same-file names never invent ownership; matching
members keep their actual method key, never a projected owner class. The
argument list is strict — only `target`; `depth`, `direction` and `stopAtRole`
are rejected here as unknown options — ambiguous or missing targets return
their usual `{status, candidates}` with empty projections, and every request
opens `graph.db` read-only and changes nothing. Parent ties are chosen
deterministically: each hop unions one-hop call edges queried per individual
sorted frontier key (never a batched multi-seed scan that could drop a tied
edge), deduplicates them, and then advances to the smallest canonical
caller/callee edge key — so equal-distance diamond branches resolve to the
same actual shortest path under every node and edge insertion order.

`pmc_impact({target})` returns `{status, target, dependents, tests, roles,
rankModel}` — "dependents, covering tests, affected roles, ranked by
PageRank". The ranking is a deterministic, dependency-free PageRank
(`algorithm: "PageRank"`, damping `0.85`, tolerance `1e-8`, maxIterations
`100`, `scope: "full-known-canonical-dependencies"`) computed over the FULL
known canonical dependency graph of the project — one node per registry
symbol plus one endpoint per known file (files with symbols, files with
native import evidence and standalone known file nodes recognized by the
same reader/card coherence, so an empty file vertex never disappears), one
directed edge per grounded
`calls` edge (caller to callee, through the same guarded adapter with its
endpoint coherence and constructor-edge exclusions) and per file-level
`imports` edge (importer to importee) — so the same node carries the same
score for every target of one database state; `iterations`/`converged` report
the actual bounded run, and a graph still moving at the bound says so
honestly instead of faking success. The numeric parameters are reported
implementation defaults, never accepted as options. `dependents` is the
COMPLETE reverse closure over those grounded calls and imports: no hop cut,
no role cut, cycles visit each canonical key once, a class/file target
expands only to its proven registry members or exact-path symbols as
zero-hop steps shown in `path`, and file import dependents reuse the existing
binding-resolved inbound import lift (the exported symbols of a file whose
resolved binding actually targets the visited symbol) — never same-file or
name guesses. Each record is `{symbolKey, kind, distance, role, layer, rank,
path}` sorted by rank descending then canonical key ascending; `distance`
counts actual dependency hops and roles/layers come only from the canonical
`node_role_assignments` ledger (explicit unknowns, excluded node kinds,
metadata-only roles and filename guesses stay null). `tests` reuses the
existing facts evidence (importer files plus the existing test-path filter
plus top-level exported symbols) as STATIC referenced-test candidates —
`provenance: "static-import-reference"`, never executed coverage — with the
same rank/key ordering; a member target keeps its class's projection and a
file target keeps the file-scope `file|<path>` shape. `roles` aggregates the
canonical non-null roles of the unique affected keys (dependents and tests
counted once per canonical key) as `{role, layer, rank, symbolKeys}` with the
sum of the unique member ranks, sorted by rank descending then role
ascending; the aggregated `layer` projects only when every contributing
record carries the same known canonical layer — an absent canonical layer
or any mixture yields null. The argument list is strict — only `target`;
every other option is rejected; ambiguous or missing targets return their
usual `{status, candidates}` with empty projections and no `rankModel`;
every request opens `graph.db` read-only and changes nothing.

`pmc_card({target})` returns `{status, target, facts, enrichment}` for a
symbol or file. Symbol enrichment is the existing semantic summary; file
cards currently return an empty enrichment string rather than inventing a
narrative. Targets accept a canonical key, graph node ID, name, `path#name`,
or file path (`file|<path>` is also accepted). Ambiguous results return `{status: "ambiguous", candidates}`
with canonical identities; missing symbols return `status: "missing"`.
Files absent from graph nodes and native evidence also return `status: "missing"`.
File exports, members and counts use the same validated identity registry as
symbol queries.

`pmc_card({target, level})` adds an optional detail level with a deterministic
token ceiling. Omitting `level` returns the legacy facts-only payload above,
byte-for-byte unchanged. With `level` the response is
`{status, target, level, tokenCeiling, tokensEstimated, truncated, omittedSections, card}`:

- `compact` (ceiling 2000) — essentials only: `id`, `kind`, `signature`,
  `location`, `role` (`{role, layer, confidence}`, no evidence), `fanIn`,
  `fanOut`, `summary` (file cards: `path`, `kind`, `role`, `symbolCount`,
  `summary`).
- `extended` (ceiling 5000) — essentials plus relation context
  (`callers`, `callees`, `imports`, `importedBy`, `implements`, `tests`; file
  cards: `exports`, `members`, `importsFrom`, `importedBy`).
- `deep` (ceiling 10000) — extended plus `roleEvidence` (the role
  classification evidence array).

The ceilings are caps, not target lengths: nothing is padded to reach them.
`tokensEstimated` is the real chars/4 estimate of the returned `card` payload
(no model or provider calls). When a card would exceed its ceiling the
lowest-priority sections are dropped first (evidence, then context), recorded
in `omittedSections` with `truncated: true`; essentials are never dropped.
Unknown explicit arguments are rejected rather than silently discarded:
`stopAtRole` is accepted only by `pmc_relations`, and an invalid `level`
value surfaces as an `isError` tool response.
These readers require an existing `graph.db`, open it read-only, and close
it per request. Missing databases produce an explicit MCP tool error and
are never created implicitly. Dependency aliases retain their legacy array
shape and artifact fallback for legacy schemas or partially canonicalized
neighbors; this fallback is never native proof for the new facts tools.
When a canonical persisted role assignment exists, symbol/file facts include
`roleClassification: {role, layer, confidence, evidence}`. No assignment adds no
field; explicitly unknown assignments preserve null role/layer, zero confidence,
and empty evidence. Role queries are read-only and do not trigger classification.
Generated narratives and card levels remain later-phase work. Role-aware
stopping ships as the `pmc_relations` `stopAtRole` option documented above,
entrypoint reachability ships as the `pmc_entrypoints_for` tool documented
above, and impact ranking ships as the `pmc_impact` tool documented above;
card-level units stay pending.

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
