# PMC Development Guide

## Testing

Run tests from `tools/project-memory-context`:

```bash
cd tools/project-memory-context
npm test
```

Or run focused test files directly with Node's native test runner:

```bash
cd tools/project-memory-context
node --test tests/walk-ignores.test.mjs tests/graphify-runner.test.mjs tests/non-source-scopes.test.mjs
```

## Scope Exclusions and .graphifyignore

PMC walkers exclude non-source scopes and generator artifacts consistently:
- Walkers (`file-hash-store`, `structure-extractor`, `sanitize`, `bootstrap`, `file-watcher`) consult shared definitions from `src/walk-ignores.mjs`. Source walkers additionally preserve prior exclusions for `.opencode/**`.
- Scopes excluded: `.planning/**`, `.worktrees/**`, `graphify-out/**`, `.graphify_*.json`, build outputs (`dist`, `build`, `obj`, `bin`, `coverage`, `target`), vendor directories (`node_modules`), and version control metadata (`.git`).
- `.planning/**` declared intake artifacts remain explicitly readable via artifact paths under `.planning/project-memory-context/`.
- `ensureGraphifyIgnore(projectRoot)` in `src/graphify-runner.mjs` idempotently appends `.worktrees/`, `.planning/`, `node_modules/`, `graphify-out/`, and `.graphify_*.json` to `.graphifyignore` prior to invoking graphify, preserving existing user rules and comments. If writing `.graphifyignore` fails (such as on a directory collision), `runGraphifyUpdate` degrades gracefully without throwing.

## Symbol Index Semantic Summary Persistence

Enrichment pipelines persist a concise `semanticSummary` field in `symbol-index.json`. Queue workers and `pmc subagent-apply` record summaries via `persistEnrichmentSuccess` (`cli/enrich-queue.mjs`), while enrichment linking propagates entries via `applyEnrichmentResult` (`src/enrichment-linker.mjs`). For freeform enrichment text, `extractSemanticSummary` in `src/symbol-index.mjs` extracts the first sentence of the `Responsibility` section, bounded to a maximum of 200 characters. When updating existing entries, `upsertSymbolIndexEntry` preserves any pre-existing `semanticSummary` if the update omits the field. Query artifact loaders (`loadQueryArtifacts` in `src/query/load-artifacts.mjs`) fall back to graph node metadata (`node.metadata.semanticSummary`) whenever an index entry lacks a summary.

## Deterministic Graph Node Resolution

`attachGraphNodeIds({ symbols, graph })` first resolves an exact `metadata.symbolKey` (with legacy top-level `symbolKey` support only when metadata has no key). Conflicting nonempty metadata and top-level keys fail closed when either claims the requested key. Otherwise file/name fallback requires the same normalized relative `source_file`, exact name after removing Graphify's optional leading dot and trailing `()`, and consistent explicit kinds; a candidate with an explicit nonmatching key is excluded. If multiple candidates remain, it selects only a uniquely nearest valid `source_location` (`L<n>` or `L<n>-L<m>` with a positive end line not before the start) to the symbol's positive integer `range.startLine`; missing, malformed, invalid, or tied line evidence is ambiguous. A single exact file/name candidate can resolve without line data. It never uses `norm_label`, case folding, global-name matching, or array order. At the resolver level, unresolved symbols have `graphNodeId: null`, overriding any input value. The existing extraction pipeline can subsequently restore a prior ID via its `symbol.graphNodeId ?? prior.graphNodeId` merge; correcting that separate pipeline behavior is a follow-up outside this resolver/backfill change.

`resolverReport({ symbols, graph })` returns `{ total, resolved, unresolved, nullRate, reasons, symbols }`. `reasons` always includes `no-file-node`, `no-label-match`, and `ambiguous`; each returned symbol exposes an own, non-enumerable `resolutionReason` for diagnostics. It remains readable as `symbol.resolutionReason` but is excluded from object spread and JSON serialization, so it cannot leak into persisted worklist records. Aggregate counts/reasons remain enumerable and serialize normally. The empty input null rate is 0. This is fixture-level resolver diagnostic evidence, not an end-to-end resolver/pipeline accuracy score; a zero fixture null rate does not establish real-graph or Graphify pipeline accuracy.

## Typed Node Kinds in graph.db (classifyNodeKind, node_kind, traverse nodeKinds)

`src/graph-store/graph-db.mjs` persists a stable typed-taxonomy classification per node in the additive `nodes.node_kind` column, exported as the pure function `classifyNodeKind(node)` with taxonomy `NODE_KINDS = ['file', 'symbol', 'member', 'doc', 'config', 'data']` (plan Task 1.1). The legacy `kind` column (Graphify/extractor kinds such as `function`, `class`) and all existing `id`/`label`/`source_file`/`metadata` fields are preserved unchanged, so current readers (`graph-node-resolver`, query engine, renderers) keep their behaviour; consumers read the typed class from `node.node_kind` on `getNode`/`getNodesByFile`/`traverse` readback.

Classification is deterministic with this precedence: (1) structured member evidence — a member `kind` (`method`, `field`, …), a `symbolKey` whose kind segment is a member kind (generic 6-part keys index 2, C# 7-part keys index 4), or an explicit container field (`container`, `containerName`, …); (2) Graphify `file_type: 'document'` nodes → `doc`; (3) a path-shaped label (path separator, known code/doc/data extension, known config basename, or dotfile; graphify `.name()` call labels are explicitly not path-shaped) → `file` for code extensions, `doc` for markdown extensions, and `config` vs `data` for JSON/YAML/TOML-family files by basename rules (dotfiles, `package.json`/`docker-compose.yml`-style names, and any basename containing `config` are `config`; other JSON/YAML files, including lockfiles, are `data`); (4) structured symbol evidence — a `symbolKey`, a symbol `kind`, or `file_type: 'code'` plus `source_location` — but only when the label is not path-shaped, so file detection stays label/path-driven; (5) otherwise a conservative `data` fallback. Unknown, invalid, or label-only inputs never classify as code symbols. Limitation: until Task 1.2 member keys exist, Graphify method-shaped labels without container/kind evidence classify as `symbol`, not `member`.

Persistence is additive and migration-safe: `buildFromGraphJson` idempotently adds `node_kind` to pre-existing schemas via `PRAGMA table_info` introspection and a fixed (code-constant) `ALTER TABLE` statement, with every node/edge/meta write bound through prepared-statement parameters (no interpolated filters), and records `meta.schema_version`. `node_kind` is a reserved core field alongside `id`/`kind`: raw `graph.json` payload `node_kind` values are ignored on ingest (the computed classification is canonical), are never serialized into `metadata`, and only the persisted column value is reported by `getNode`, `getNodesByFile`, and `traverse`, so a contradictory or bogus payload key cannot shadow readback or filtering. `openGraphDb` rebuilds from `graph.json` when either `content_hash` differs (existing behaviour) or `schema_version` predates the current typed-kind layer, so legacy databases gain classifications on first open without dropping tables, reindexing, or losing `community_names` data. No new index is created; filtering happens in the traversal layer.

`traverse({ …, nodeKinds })` restricts results to the listed taxonomy values: omitting `nodeKinds` keeps the legacy unfiltered eligibility, node IDs, edges, depth, and default-filter behaviour unchanged for existing callers such as the query engine — the only readback difference is the additive `node_kind` field now present on every node object (payloads are not byte-identical to pre-1.1 node objects) — while an explicit list is a strict allowlist — including `nodeKinds: []`, which matches nothing. Seeds obey the same filter (a seed outside the filter yields an empty result), excluded intermediate nodes never appear in `nodes`/`edges`, never join the frontier, block path continuation, and consume no traversal depth, so `nodeKinds: ['file', 'symbol', 'member']` gives code-coherent paths. Duplicate valid entries collapse to the deduplicated set; any invalid, non-string, or injection-shaped entry (and non-array/null values) throws `TypeError` before any SQL runs, so a bad filter can never silently widen results. The filter is validated against the fixed `NODE_KINDS` allowlist and evaluated against the persisted column — never interpolated into SQL. The in-memory graph store (`in-memory-graph.mjs`) and `query-engine.traverseGraph` do not yet forward `nodeKinds`; wiring retrieval callers is follow-up work outside Task 1.1.

## Relational Evaluation Harness

The relational evaluation harness benchmarks relation retrieval (callers, callees, dependents, dependencies, nearest controller, entrypoint, tests) against golden answers.

### Fixture

The canonical golden fixture lives at:
`tools/project-memory-context/tests/fixtures/layered-app/`

It contains a layered TypeScript application with:
- Controller (`src/controllers/user.controller.ts`)
- Service (`src/services/user.service.ts`)
- Repository (`src/repositories/user.repository.ts`)
- Database client (`src/db/client.ts`)
- Model (`src/models/user.model.ts`)
- Interface (`src/interfaces/user-repository.ts`)
- Utility (`src/utils/format.ts`)
- View (`src/views/user.view.ts`)
- CLI entrypoint (`src/cli/main.ts`)
- Tests (`tests/user.service.test.ts`)
- Non-code documentation (`docs/README.md`)
- Ignored paths (`.planning/**`, `.worktrees/**`, `dist/**`)

All current relation IDs in `expected.json` use the exact extractor format:
`ts|filePath|kind|exported/local|name|arity`
Proposed method-level member symbols use `ts|filePath|method|member|Container.method|arity` and are explicitly labeled with `"future": true` in the symbols map.

### Running the Evaluator

Run the evaluator CLI entrypoint:

```bash
# Baseline invocation (runs on owned temporary child root, executes graphify and query orchestrator if available)
node tools/project-memory-context/src/eval/relational-eval.mjs

# Stub verification mode (evaluates unit stub adapter with 100% exact match; labeled as mode: "stub")
node tools/project-memory-context/src/eval/relational-eval.mjs --stub
```

### Baseline Status

- **End-to-End Pipeline:** When `graphify` is resolved via platform runner detection, the baseline invokes `runGraphifyUpdate` on an isolated temporary child directory using fixture sources only, extracts symbols with `extractTopLevelSymbols`, resolves nodes with `attachGraphNodeIds`, and queries `createQueryOrchestrator`. It measures an accuracy of 2/12 (~0.167) matching top-level function calls and empty entrypoint caller sets.
- **Extraction Capabilities:** Separately reported from the relational baseline. Current tree-sitter extraction scans 10 files and extracts 12 top-level symbols, but 0 methods are extracted because `src/extractors/tree-sitter/extract.mjs`'s `isTopLevel` filter rejects member nodes in TypeScript. This is a code capability limitation addressed in Task 1.2.
- **Fallback / Not Run:** If `graphify` cannot be resolved or its update fails, the report states `endToEnd: { status: "UNAVAILABLE" | "NOT_RUN", reason: "..." }` with no numeric relational score.
