# PMC Maintenance Flow

How the project memory context stays up-to-date across the three lifecycle events:
**session start**, **code change**, and **full rebuild**.

---

## 1. Session Start (autostart)

Triggered automatically by the agent on every new session.

```
Read worklist.json
  └─ pending/stale > 0?
       YES → pmc enrich . (Bash run_in_background: true)
             ├─ Still-Alive watchdog: poll enrich-status every ~2 min
             │    running  → wait
             │    finished → report summary
             │    stalled  → relaunch (max 3 attempts), then /doctor
             └─ enrichment runs concurrently while agent works
       NO  → nothing to do

Read sync-manifest.json
  └─ pending entries? → surface "PMC has N pending sync ops. Run /sync-context."

agent-memory_search "project context overview" tags:["project-context"]
  └─ present ~500 token summary to prime session context

Remind: "Use /get-context <target> before reading files."
```

---

## 2. After Code Changes (day-to-day)

### Command: `pmc refresh-context [--enrich]`

Full pipeline on every invocation:

```
computeFileHashes(projectRoot)
  └─ diff against hash-store.json
       │
       ├─ No changes → exit early
       │
       └─ Changes detected (added/modified/removed)
            │
            ▼
       runGraphifyUpdate(projectRoot)           ← NEW in v0.3.4
         ├─ graphify update <root>  (AST only, no LLM)
         │   graphify caches AST per file hash → only changed files re-parsed
         │   typically: <5s for 1-3 changed files on a 1000-file project
         ├─ copies graph.json / GRAPH_REPORT.md → .planning/.../graph/
         └─ if graphify not installed → no-op, continues gracefully
            │
            ▼
       read fresh graph.json from .planning/.../graph/
            │
            ▼
       extractTopLevelSymbols(changedFiles)    ← regex+AST extractor
            │
            ▼
       attachGraphNodeIds(symbols, freshGraph) ← symbols get real graphNodeId,
            │                                    startLine, community, edges
            ▼
       computeSymbolDelta(current, existingWorklist)
         ├─ new    → added to worklist as "pending"
         ├─ stale  → code changed; re-added as "stale" + delete op in sync-manifest
         ├─ removed → delete op in sync-manifest
         └─ unchanged → kept as-is
            │
            ▼
       write worklist.json  (new + stale + unchanged)
       write sync-manifest  (delete ops for stale/removed)
       write hash-store.json (current hashes)
            │
            ▼
       if --enrich AND pendingEnrichment > 0:
         spawnBackground(enrich-queue.mjs)     ← NEW in v0.3.4
         log "Launched background enrichment (N pending)"
       else if pendingEnrichment > 0:
         log "Tip: run pmc refresh-context --enrich or pmc enrich ."
```

### Then: `pmc sync-context`

Reads sync-manifest.json and upserts/deletes entries in agent-memory. Run after enrichment
completes (or at any point to flush delete ops).

### Recommended post-change workflow

```bash
pmc refresh-context --enrich   # graph + worklist + launches enrich in bg
# ... work while enrich runs ...
pmc sync-context               # persist enriched memories to agent-memory
```

---

## 3. Full Rebuild (`pmc map-project --all`)

Use only for: initial setup, corrupted graph, major restructuring (many files moved/renamed).

```
installGraphify()              ← pip install graphifyy (fork with Razor/CSHTML)
bootstrapProjectInstall()      ← sets up .planning dirs, MCP config, agent templates
project-context.mjs            ← generates architecture/stack/rules artifacts

Stage-A: runGraphifyUpdate()   ← graphify update (full, no cache on first run)
  └─ 9903 nodes, 11777 edges example on DiarioDigital (1007 files)

Stage-B: build-worklist.mjs    ← extractTopLevelSymbols on ALL files
  ├─ reads fresh graph.json
  ├─ attachGraphNodeIds
  └─ buildEnrichmentWorklist → worklist.json (952 entries example)

Optional --enrich:
  spawnBackground(enrich-queue.mjs)
```

**map-project is NOT needed for routine changes** — `refresh-context` handles incremental
graph updates and worklist maintenance.

---

## 4. Continuous Watch (`pmc watch .`)

Wraps `refresh-context --enrich` behind a 2-second debounce file watcher.

```
fs.watch(projectRoot, recursive)
  └─ file change on .ts/.tsx/.mjs/.js/.jsx/.cs
       └─ debounce 2000ms
            └─ refreshContext(projectRoot, { enrich: true })
                 ├─ graphify update (incremental)
                 ├─ symbol delta
                 └─ spawnBackground(enrich-queue) if pending > 0
```

Useful for long edit sessions where you want the context always fresh without manual commands.

---

## Component Responsibilities

| Component | File | Role |
|---|---|---|
| `runGraphifyUpdate` | `src/graphify-runner.mjs` | Incremental AST graph update (shared helper) |
| `installGraphify` | `src/graphify-runner.mjs` | pip install of graphify fork |
| `refreshContext` | `cli/refresh-context.mjs` | File-delta → graph update → symbol delta → worklist |
| `enrich-queue` | `cli/enrich-queue.mjs` | Parallel LLM enrichment of pending symbols |
| `sync-context` | `cli/sync.mjs` | Flush sync-manifest ops to agent-memory |
| `build-worklist` | `cli/build-worklist.mjs` | Full worklist build (used by map-project) |
| `watch` | `cli/watch.mjs` | File watcher → refresh + enrich loop |

---

## State Files

| File | Location | Updated by |
|---|---|---|
| `worklist.json` | `.planning/.../enrichment/` | `refresh-context`, `build-worklist`, `enrich` |
| `hash-store.json` | `.planning/.../enrichment/` | `refresh-context` |
| `sync-manifest.json` | `.planning/.../enrichment/` | `refresh-context` (appends), `sync-context` (clears) |
| `graph.json` | `.planning/.../graph/` | `runGraphifyUpdate` (via refresh or map-project) |
| `GRAPH_REPORT.md` | `.planning/.../graph/` | `runGraphifyUpdate` |
| `graph.json` (source) | `graphify-out/` | graphify executable |

---

## Graceful Degradation

| Failure | Behavior |
|---|---|
| graphify not installed | `runGraphifyUpdate` logs warning and returns `{ ran: false }` — refresh continues against old graph |
| graphify update fails (non-zero exit) | same as above — no throw |
| enrich process crashes | autostart watchdog detects `stalled` state, relaunches (cap 3×) |
| No `--enrich` flag | worklist updated, tip printed, no background process |
