# PMC Enrichment Redesign: Symbol Cards — Implementation Plan

> **For agentic workers:** Execute task by task with test-first development (RED → GREEN → refactor). Steps use checkbox (`- [ ]`) syntax. Run `pmc get-context <target>` (compact) before reading each source file. Never run `refresh-context`, `sync`, `enrich`, or `watch` against the main checkout's memory DB from a worktree (see Guardrails).

**Goal:** Turn PMC enrichment into **Symbol Cards** with three layers:
- deterministic graph **facts** linked by `symbolKey`;
- a rule-based architectural **role** with evidence;
- a bottom-up, schema-validated LLM **narrative**.

Agents must answer "who calls X", "what does X depend on", "what depends on X", and "which controller or entrypoint reaches X" through MCP and CLI.

**Design:** `v3.md` (repo root). **Audit baseline:** `v2.md`.

**Tech stack:** Node ≥ 22.5, ESM `.mjs`, `node:test` + `node:assert/strict`, `node:sqlite`, tree-sitter extractors, temporary fixtures created with `mkdtemp`. agent-memory-mcp is TypeScript with vitest. No new frameworks.

**Test commands:**
- From `tools/project-memory-context/`: focused `node --test tests/<file>.test.mjs`; full suite `node --test tests/*.test.mjs tests/**/*.test.mjs`.
- From `agent-memory-mcp/`: `npx vitest run <file>`.

**Verified codebase facts** (do not re-derive):
- Prompt builder: `cli/enrich-queue.mjs:192-203` (`buildSymbolPromptMeta`). It receives the symbol code and the file's import lines only. Ollama loop at `:630` is sequential; `PMC_CONCURRENCY` is parsed at `:49` and never used.
- Payload: `src/memory-payload.mjs:6-38`, producing `{content, category:"architecture", tags:["symbol",lang,kind,"project:*","file:*"]}`. The sync manifest adds `keyTag: key:symbol:<safeKey>` (`cli/enrich-queue.mjs:342-352`).
- `cli/sync.mjs:93-118` (`applySyncEntry`) calls agent-memory `store`/`update` with `{content, category, tags}`. The agent-memory `store` tool **has no `symbol_key` param** (`agent-memory-mcp/src/tools.ts:893-904`). `attach_symbol(memory_id, symbol_key)` exists (`tools.ts:1244`), and so does `get_by_symbol` (`tools.ts:1257`).
- `src/symbol-index.mjs:1-12` writes only `{memoryId, graphNodeId, codeHash, status, lastEnrichedAt}`; `semanticSummary` is dropped.
- `src/graph-node-resolver.mjs:22-63` matches `metadata.symbolKey`, or `source_file` plus the stripped label. Real-repo result: null for 91/468 main symbols.
- `src/extractors/tree-sitter/extract.mjs:32-53` (`isTopLevel`) drops class members except in C#. Symbol keys come from `src/symbol-keys.mjs:17-24` as `lang|path|kind|scope|name|arity`.
- `src/symbol-delta.mjs:37-47`: staleness is triggered only by the symbol's own `codeHash`.
- Graph store: `src/graph-store/graph-db.mjs` holds tables `nodes(id,label,kind,source_file,community,degree,metadata)` and `edges(source,target,relation)`, indexed by `(source,relation)` and `(target,relation)`. It has a `traverse({nodeIds,maxHops,edgeTypes,direction})` BFS. `kind` is NULL on every real node.
- Retrieval: `src/retrieval/query-engine.mjs`. Focus maps to edge types at `:26-33`. `queryImpactScope` (inbound) exists but `cli/context.mjs` `buildRenderInput` (`:158-205`) never calls it, and `focus=callers` traverses outbound.
- MCP: `mcp/query-tools.mjs` registers `pmc_query_project`, `pmc_search_symbols`, `pmc_get_dependents`, and `pmc_get_dependencies`, all through `src/query/orchestrator.mjs:141-174`. That path reads `graph.json`, is 1-hop, applies no edge filter, and drops non-symbol nodes.
- Scope:
  - `.graphifyignore` contains only `.worktrees/` and is untracked.
  - `src/walk-ignores.mjs` ignores hidden directories **except** the allowlisted `.opencode` and `.planning`, so `.planning/**` (including `enrichment/*.memory.json`) reaches the graph.
  - `src/file-watcher.mjs:4` already ignores `.planning`.
- Real-repo pollution (from `v2.md`): graph 49% `.worktrees` nodes and 77% `.planning` nodes; enrichment directory 82% worktree copies; symbol index 1,700/2,168 worktree keys.

## Guardrails

- **G1. Isolation.** Work on branch `feat/enrich-symbol-cards`, created in an isolated worktree. The main checkout is dirty (341 changes on `feat/community-naming-db-and-command`).
- **G2. Unmerged incident guard.** `assertCheckoutIdentity` is not merged; it is still in `.worktrees/pmc-pi-project-integration`. Until it lands, **never** run `refresh-context`, `sync`, `enrich`, or `watch` from the new worktree. Use fixture projects in temp directories for every integration test.
- **G3. Real-repo cleanup** (Task 0.6) is destructive. Run it only after explicit user authorization, with a backup first, and from the main checkout.
- **G4. Commits.** One Conventional Commit per task, with tests and docs alongside the behavior. No push, PR, or merge without the user's decision.

## Shared fixture

**Task 0.0** creates `tests/fixtures/layered-app/`, a small TypeScript project with known structure:

```
src/controllers/user.controller.ts   (@Controller-like class UserController, method getUser → UserService.findById)
src/services/user.service.ts         (class UserService, findById → UserRepository.findOne; util formatName)
src/repositories/user.repository.ts  (class UserRepository implements IUserRepository, findOne → db client)
src/models/user.model.ts             (interface User, class UserEntity)
src/interfaces/user-repository.ts    (interface IUserRepository)
src/utils/format.ts                  (export function formatName)
src/views/user.view.ts               (function renderUser → formatName)
src/cli/main.ts                      (main → UserController.getUser)
tests/user.service.test.ts           (imports UserService)
docs/README.md                       (non-code; must NOT become a code node)
.planning/project-memory-context/enrichment/x.memory.json   (must be ignored)
.worktrees/copy/src/services/user.service.ts                (must be ignored)
```

`tests/fixtures/layered-app/expected.json` holds the golden answers: callers, callees, dependents, roles, and the nearest controller and entrypoint for each symbol.

---

## Phase F0 — Hygiene and identity (unblocks everything)

### Task 0.0: Golden fixture and relational eval harness
**Files:** Create `tests/fixtures/layered-app/**`, `tests/fixtures/layered-app/expected.json`, `src/eval/relational-eval.mjs`, `tests/relational-eval.test.mjs`.
- [ ] Write the failing test. `runRelationalEval({projectRoot, answer})` compares an `answer(question)` adapter against `expected.json` and reports per-question pass/fail plus accuracy.
- [ ] Implement the harness (pure; no LLM).
- [ ] Add the eval command to `docs/DEVELOPMENT.md`.
- **Accept:** the harness runs against a stub adapter. The baseline accuracy of the current pipeline is recorded in the tracker; it is expected to be low.

### Task 0.1: Exclude non-source scopes from every walker and from graphify
**Files:** Modify `src/walk-ignores.mjs` (stop allowlisting `.planning` for code walkers; ignore `.worktrees` explicitly), `src/graphify-runner.mjs` (ensure `.graphifyignore` contains `.worktrees/`, `.planning/`, `node_modules/`, `graphify-out/`, and `.graphify_*.json` before running), `src/file-hash-store.mjs` and `src/symbol-extractor.mjs` if they bypass `walk-ignores`. Tests: `tests/walk-ignores.test.mjs`, `tests/graphify-runner.test.mjs`.
- [ ] RED: walking the fixture yields no `.planning/**` or `.worktrees/**` path.
- [ ] RED: `ensureGraphifyIgnore(projectRoot)` appends the missing entries idempotently and preserves user lines.
- [ ] GREEN. Then confirm that project-context extractors still read `.planning` declared intake through their own explicit paths.
- **Accept:** fixture symbol extraction has 0 polluted keys; the full suite passes.

### Task 0.2: Persist `semanticSummary` in the symbol index
**Files:** `src/symbol-index.mjs`, `cli/enrich-queue.mjs` (`:328-335`), `cli/subagent-apply.mjs`. Test: `tests/symbol-index.test.mjs`.
- [ ] RED: `upsertSymbolIndexEntry` keeps `semanticSummary`. Enrichment output yields a summary: the first sentence of Responsibility, at most 200 characters, for now.
- [ ] GREEN.
- **Accept:** `pmc_search_symbols` returns non-empty summaries on the fixture.

### Task 0.3: Link enrichment memories by `symbol_key`
**Files:** `cli/sync.mjs` (`applySyncEntry` calls `attach_symbol(memory_id, entry.symbolKey)` after `store`/`update` when `entry.symbolKey` is present). Create `cli/backfill-symbol-keys.mjs`, which maps existing memories with a `key:symbol:<safeKey>` tag to `symbolKey` through `symbol-index.json`; it is dry-run by default and applies with `--apply`. Register it in `src/command-dispatch.mjs`. Tests: `tests/sync-cli.test.mjs`, `tests/backfill-symbol-keys.test.mjs`.
- [ ] RED: a sync with a fake MCP client records an `attach_symbol` call carrying the exact key.
- [ ] RED: the backfill dry-run lists mappings and skips worktree or unknown keys.
- [ ] GREEN.
- **Accept:** `get_by_symbol(<key>)` returns the enrichment in an agent-memory fixture; `get-context` renders "Semantic Memory".

### Task 0.4: Deterministic `graphNodeId` resolution with diagnostics
**Files:** `src/graph-node-resolver.mjs`, `src/graph-backfill.mjs`. Tests: `tests/graph-node-resolver.test.mjs`, `tests/graph-backfill.test.mjs`.
- [ ] RED: resolution order is
  1. `metadata.symbolKey`;
  2. same `source_file` plus normalized name plus nearest `source_location` to `range.startLine`;
  3. unresolved, with a reason (`no-file-node`, `no-label-match`, `ambiguous`).
- [ ] RED: `resolverReport()` returns null counts by reason.
- [ ] GREEN.
- **Accept:** fixture null rate is 0 for functions and classes. The report data feeds decision D1.

### Task 0.5: Decision D1 checkpoint (no code)
- [ ] Measure the resolver report on a copy of the real graph, read-only. Decide: graphify edges plus resolver, or PMC's own tree-sitter edges.
- [ ] Record the decision in `v3.md` §5 and in Engram (`pmc/enrich-redesign-proposal`).

### Task 0.6: Real-repo cleanup (requires user authorization, G3)
**Files:** Create `cli/prune-polluted.mjs`. It is dry-run by default; `--apply` removes `.worktrees/**` keys from `symbol-index.json`, worklist, enrichment files, and agent-memory rows tagged `file:.worktrees/`, after an online SQLite backup. Test: `tests/prune-polluted.test.mjs` (fixture only).
- [ ] RED/GREEN on the fixture.
- [ ] **STOP:** present the dry-run counts and ask the user. On approval, back up, apply, and rebuild the graph from the main checkout.
- **Accept:** real-repo pollution is 0%; `graph.metadata.json` matches the counts in `graph.db`.

---

## Phase F1 — Typed nodes, file cards, facts, relations

### Task 1.1: Typed node layer in `graph.db`
**Files:** `src/graph-store/graph-db.mjs`, plus a new pure function `classifyNodeKind(node)`. Test: `tests/graph-db.test.mjs`.
- [ ] RED: rebuilt nodes get `kind ∈ {file, symbol, member, doc, config, data}`.
  - File nodes come from code-file labels and paths.
  - Markdown nodes become `doc`.
  - JSON and YAML nodes become `config` or `data`.
  - Nodes carry `metadata.symbolKey` when resolved.
- [ ] RED: `traverse` accepts `nodeKinds` to restrict results to code.
- [ ] GREEN, then bump the schema version so a rebuild is triggered.
- **Accept:** fixture `docs/README.md` produces only `doc` nodes, excluded from code relations by default.

### Task 1.2: Extract class members (methods)
**Files:** `src/extractors/tree-sitter/extract.mjs` (member pass over class bodies for TS/JS/Python/Java/Go/Rust), `src/symbol-keys.mjs` (member key per D2: `lang|path|method|member|Container.name|arity`). Tests: `tests/symbol-extractor-multilang.test.mjs`, `tests/symbol-keys.test.mjs`.
- [ ] RED: the fixture yields `UserService.findById`, `UserRepository.findOne`, and `UserController.getUser` as members carrying a `container`.
- [ ] RED: existing top-level keys are unchanged (regression).
- [ ] GREEN.
- **Accept:** member symbols are present and resolver-linked; the full suite passes.

### Task 1.3: Facts builder
**Files:** Create `src/cards/facts.mjs`, exporting `buildFacts(graphDb, symbolKey, {depth})`. It returns `{id, kind, signature, location, callers[], callees[], imports[], importedBy[], implements[], tests[], fanIn, fanOut}`, where each relation item is `{symbolKey|path, relation, kind}`. Tests are file-scoped where the target is a file. Test: `tests/card-facts.test.mjs`.
- [ ] RED against `expected.json`: `UserService.findById` callers = [`UserController.getUser`]; callees = [`UserRepository.findOne`]; tests = [`tests/user.service.test.ts`].
- [ ] GREEN.
- **Accept:** fixture facts match 100%.

### Task 1.4: File cards
**Files:** Create `src/cards/file-card.mjs`, exporting `buildFileCard(graphDb, filePath)`. It returns `{path, kind:"file", exports[], importsFrom[], importedBy[], symbolCount, members}`, with all IDs linked. Test: `tests/file-card.test.mjs`.
- [ ] RED/GREEN on fixture files.

### Task 1.5: get-context — inbound callers and disambiguation
**Files:** `cli/context.mjs` (`buildRenderInput`: `focus=callers` and `focus=impact` route to inbound `queryImpactScope`, and `all` renders both directions labeled), `src/retrieval/target-resolver.mjs` (accept `symbolKey`, `path#name`, and node id; on ambiguity return candidates with their keys). Tests: `tests/context-cli.test.mjs`, `tests/query-engine.test.mjs`.
- [ ] RED: `get-context symbol findById compact callers` lists `getUser` as a caller.
- [ ] RED: `get-context symbol "src/services/user.service.ts#findById"` resolves uniquely.
- [ ] GREEN.
- **Accept:** golden Q1–Q3 pass through the CLI adapter in the eval harness.

### Task 1.6: MCP `pmc_relations` and `pmc_card` (facts-only), backed by `graph.db`
**Files:** `mcp/query-tools.mjs`, plus a new `src/query/relations.mjs` that uses `graph-db.mjs`, not `graph.json`. Existing `pmc_get_dependents` and `pmc_get_dependencies` become thin aliases over `relations`. Tests: `tests/query.test.mjs`, plus a new `tests/mcp-relations.test.mjs`.
- [ ] RED: `pmc_relations({target, direction:"in", relations:["calls"], depth:2})` returns typed edges with `symbolKey`s.
- [ ] RED: ambiguous targets return candidates.
- [ ] RED: `pmc_card({target})` returns facts plus the existing enrichment text.
- [ ] GREEN, then update `docs/COMMANDS.md` and `docs/ARCHITECTURE.md`.
- **Accept:** golden Q1–Q3 pass through the MCP adapter. The F1 exit criterion is met.

---

## Phase F2 — Role classifier (planned at phase entry; outline)

- **2.1** `src/roles/signals.mjs`: pure signal extractors (decorators, inheritance, suffix, directory, topology, side-effect markers). Each returns `{signal, weight, evidence}`.
- **2.2** `src/roles/profiles/*.json` (`generic`, `node-cli`, `express`, `nest`, `spring`, `aspnet`, `django`), plus project overrides in `.planning/project-memory-context/roles.json`.
- **2.3** `src/roles/classify.mjs`: weighted scoring that produces `{role, layer, confidence, evidence[]}` for files and symbols; a member inherits its container's role unless overridden.
- **2.4** Persist roles in `graph.db` node metadata, and expose them in facts, cards, and `get-context`.
- **2.5** Optional constrained-LLM tie-breaker for `confidence < 0.5` (enum output only).
- **Accept:** ≥ 90% role accuracy on the fixture; PMC's own repo is classified sensibly (`cli-command`, `mcp-tool`, `extractor`, `store`) through the `node-cli` profile.

## Phase F3 — Bottom-up structured narrative (outline)

- **3.1** `src/cards/narrative-schema.mjs`: JSON schema (summary, behavior, sideEffects, errors, contracts, changeNotes, mentions) plus a validator. Mentions must exist in the graph; retry once on invalid output.
- **3.2** `src/cards/order.mjs`: reverse topological order over `calls` edges; SCC batching (Tarjan).
- **3.3** Prompt v2 in `buildSymbolPromptMeta`: code, signature, role, callee one-line summaries with keys, top-5 callers (name and role), the file-card summary, and relevant project rules. Use Ollama's JSON-schema `format`. The subagent route uses the same schema.
- **3.4** Trivial-symbol template path (no LLM).
- **3.5** `narrativeHash` invalidation in `src/symbol-delta.mjs`, with upward propagation only when a callee's summary text changes.
- **3.6** Honor `PMC_CONCURRENCY` in the Ollama loop (bounded pool, keeping the file-lock retry for `worklist.json`).
- **Accept:** 0 invalid mentions; editing a caller does not re-run the LLM on the callee; throughput scales with concurrency.

## Phase F4 — Role-aware agent surface (outline)

- **4.1** `pmc_relations` gains `stopAtRole`, enabling "nearest controller or entrypoint".
- **4.2** `pmc_entrypoints_for(target)`: reverse reachability to roles `entrypoint`, `cli-command`, `mcp-tool`, `controller`, or route handlers.
- **4.3** `pmc_impact(target)`: dependents, covering tests, and affected roles, ranked by PageRank.
- **4.4** `pmc_card` levels `compact`, `extended`, and `deep`, with token budgets.
- **4.5** Pi access: land the `.worktrees/pmc-pi-project-integration` work, or add `.pi/mcp.json`, so the PMC tools are callable from Pi.
- **Accept:** from a Pi session, "which controller reaches `findById`" returns `UserController.getUser` on the fixture.

## Phase F5 — Rollups and evaluation (outline)

- **5.1** File narratives rolled up from symbol cards; community and feature cards (HCGS-style).
- **5.2** Eval metrics in CI: relation accuracy, narrative faithfulness (mention validity plus a sampled LLM judge), and agent task success with file-read counts.

---

## Self-review

- **Spec coverage:** v3 §3.1 maps to Tasks 0.1–0.4 and 1.1–1.6; §3.2 to F2; §3.3 to F3; §3.4 to 1.6 and F4; §3.5 is produced by `pmc_card` after F2 and F3.
- **Risk ordering:** the unmerged incident guard and the dirty main checkout are handled by G1–G3 before any real-repo mutation.
- **Re-planning:** F2–F5 are expanded into step-level tasks at phase entry, using the F1 outcomes and decision D1.
