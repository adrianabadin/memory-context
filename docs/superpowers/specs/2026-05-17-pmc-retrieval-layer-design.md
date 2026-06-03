# PMC Retrieval Layer Design

**Date**: 2026-05-17
**Status**: Approved
**Depends on**: graph-node-resolver fix (graphNodeId population), symbol enrichment pipeline, 9 project-context memories

## Problem

PMC produces rich structural data — 209 graph nodes, 459 edges (calls, imports, contains, method), enriched symbol descriptions, and 9 project-context memories — but the agent cannot access the graph at runtime. It can do semantic search over individual symbol descriptions and project-context summaries, but cannot traverse code structure, follow call chains, understand file/module boundaries, or assess impact scope.

The agent needs:
- Task context: files and symbols involved in a task, their descriptions, and their structural neighbors
- Navigation: what's in a file, what methods a class has, what are the entry points
- Impact analysis: if I change X, what breaks
- Debugging escalation: progressively deeper context when troubleshooting, up to reading source files directly

## Approach

**Approach A: Query Engine as Library** — a local query engine reads `graph.json`, `symbol-index.json`, and `worklist.json` from the filesystem. No graph edges are synced to agent-memory. The graph is traversed on-demand via BFS. This is fast (<5ms for typical queries), zero sync overhead, and the agent always has access to the project's filesystem.

## Architecture

### Components

1. **`src/retrieval/query-engine.mjs`** — Core query engine. Reads local PMC data files, performs graph traversal, joins with enriched symbol data.
2. **`src/retrieval/context-renderer.mjs`** — Takes query results + agent-memory base context, renders structured markdown with token budget management.
3. **`/get-context` command** — Opencode command the agent invokes to request structural context.
4. **`pmc-autostart` enhancement** — Extends existing AGENTS.md block to inject ~500 tokens of base project context automatically at session start.

### Data Flow

```
Agent → /get-context target=embedder.ts depth=compact
  → query-engine loads graph.json (BFS from file nodes)
  → query-engine loads symbol-index.json (enrichment join)
  → query-engine reads .memory.json files (enriched descriptions)
  → agent-memory_search (base memories: stack, architecture, structure)
  → renderer produces structured markdown
  → agent receives context without reading source files
```

## Query Engine

### API

```js
export function createQueryEngine({ planningDir, projectSlug });
// Returns: { querySymbolContext, queryFileContext, queryImpactScope, traverseGraph }

export function createDepthConfig(depth); // 'compact'|'extended'|'deep'|'disk' → config
```

`createQueryEngine` loads `graph.json`, `symbol-index.json`, and `worklist.json` once, builds an inverted index `graphNodeId → symbolKey` for fast joins.

### Functions

**`traverseGraph({ nodeIds, maxHops, edgeTypes })`**
- Reads `graph.json` from `.planning/project-memory-context/graph/`
- BFS from initial `nodeIds`
- Filters by `edgeTypes` (default: `['calls','imports','contains','method']`)
- Returns `{ nodes: [...], edges: [...], depth_reached: N }`

**`querySymbolContext({ symbolKey, depth })`**
1. Look up `symbol-index.json` → get `graphNodeId` + `memoryId`
2. If `graphNodeId`: traverse from that node with `maxHops` per depth config
3. For each reached node: look up its symbolKey via inverted index
4. For each found symbol: read `.memory.json` from `enrichment/` dir
5. Returns: target symbol + enrichment + structural neighbors + their enrichments

**`queryFileContext({ filePath, depth })`**
1. Filter `graph.json` nodes where `source_file === filePath`
2. Filter `symbol-index.json` entries where `filePath` matches
3. Traverse from the file's nodes per depth config
4. Returns: file's symbols + enrichments + imports + callers

**`queryImpactScope({ symbolKeys, depth })`**
1. Resolve graphNodeIds for the given symbolKeys
2. Traverse **inbound** (edges where node is `target`, not `source`)
3. Returns: which symbols depend on the targets — for "if I change X, what breaks"

### Node Resolution

Uses the fixed `graph-node-resolver.mjs` to map `symbolKey → graphNodeId`. The inverted index `graphNodeId → symbolKey` is built at load time from `symbol-index.json`.

### Depth Configuration

```
depth    → { maxHops, includeCommunity, maxTokens, readSourceFiles }
compact  → { maxHops: 1, includeCommunity: false, maxTokens: 2000,  readSourceFiles: false }
extended → { maxHops: 2, includeCommunity: true,  maxTokens: 5000,  readSourceFiles: false }
deep     → { maxHops: 3, includeCommunity: true,  maxTokens: 10000, readSourceFiles: false }
disk     → { maxHops: 3, includeCommunity: true,  maxTokens: 15000, readSourceFiles: true  }
```

When `readSourceFiles: true`, the engine reads `.ts`/`.cs` files directly and extracts source fragments using `range.startLine`/`range.endLine` from worklist entries.

## `/get-context` Command

**Location**: `~/.config/opencode/commands/get-context.md`

**Parameters:**
- `target` — file path (`src/embedder.ts`), symbol name (`TransformersEmbedder`), or free description (`embedding pipeline`)
- `depth` — `compact` (default) | `extended` | `deep` | `disk`
- `focus` (optional) — filters edge types: `dependencies` (`imports`,`imports_from`), `callers` (`calls`), `containment` (`contains`,`method`), `all` (default)

**Resolution logic:**
1. If target looks like a file path → `queryFileContext`
2. If target looks like a symbol name → search `symbol-index.json` by name → `querySymbolContext`
3. If target is a free description → `agent-memory_search` → extract symbolKeys from results → `querySymbolContext`

**Agent instructions:**
- Always fetch base project-context memories from agent-memory (tags: `project-context`, `project:{slug}`)
- Render output as structured markdown
- Do NOT read source files unless `depth=disk` or context is exhausted

## Auto-Injection (pmc-autostart Enhancement)

Extends the existing `pmc-autostart` block in AGENTS.md:

After checking worklist and sync-manifest, if `.planning/project-memory-context/` exists:

1. Search agent-memory for memories with tags `["project-context", "project:{slug}"]`
2. Inject a compact summary (~500 tokens) of:
   - Stack and runtime
   - Current architecture
   - Key directory structure
3. Instruct agent: "Use `/get-context` for structural deep-dive before reading files"

## Context Renderer

### `src/retrieval/context-renderer.mjs`

Takes query-engine output + agent-memory base memories → produces markdown.

### Output Format by Depth

**compact** (~2K tokens):
```markdown
## Context: embedder.ts
Stack: TypeScript + Node.js | Architecture: MCP server with pluggable embedder
### Target File
- `TransformersEmbedder` (class, exported) — Loads bge-m3 via @huggingface/transformers...
### Direct Neighbors
- imports: `../config.ts` (model config)
- used by: `index.ts` (MCP entry point)
```

**extended** (~5K tokens) — adds:
```markdown
### Module Community (2)
- `config.ts` — MCP server configuration
- `index.ts` — Entry point, registers tools
### Call Chain (2 hops)
- `index.ts` → `TransformersEmbedder.initialize()` → `pipeline()`
```

**deep** (~10K tokens) — adds:
```markdown
### Full Subgraph (3 hops, 12 nodes, 18 edges)
{node table with enrichment summaries}
### Impact Scope
- Changing `embed()` affects: `index.ts:handleEmbed`, `batch-processor.ts:processAll`
```

**disk** (~15K tokens) — adds at end:
```markdown
### Source Code
// agent-memory-mcp/src/embedder.ts (lines 5-45)
export class TransformersEmbedder { ... }
```

### Token Budget Management

Estimated tokens = chars / 4. If budget exceeded, truncate lower-priority sections:

1. Project base (always included, ~200 tokens)
2. Target enrichment (always included)
3. Direct neighbors (compact+)
4. Community/module summary (extended+)
5. Call chains (extended+)
6. Full subgraph (deep+)
7. Impact scope (deep+)
8. Source code (disk only)

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No `graph.json` | Return enriched memories from agent-memory only, no traversal. Indicate: "No structural graph. Run `/new-project`." |
| Empty `symbol-index.json` | Return graph neighbors without enrichments. Structure only: names, files, relations. |
| `graphNodeId` null for symbol | Fallback: find graph nodes by `filePath` + label match. If still no match: return symbol without structural neighbors, enriched content only. |
| Ambiguous target (multiple matches) | List candidates with file and kind. Agent chooses or asks for clarification. |
| Source file not found (disk depth) | Handle `ENOENT` gracefully, indicate "source file not found" |
| No `.planning/` directory | Inform that PMC is not initialized, suggest `/new-project` |

## Debugging Escalation

The retrieval layer integrates with the `systematic-debugging` skill's escalation path:

1. **compact** — initial queries, understand the landscape
2. **extended** — fix requires understanding inter-module interactions
3. **deep** — bug crosses multiple layers
4. **disk** — last resort, read source code directly

The agent escalates explicitly via `/get-context target=X depth=extended`. The debugging skill can recommend escalation when context at current depth is insufficient.

## Testing

1. **`query-engine` tests**: graph traversal with mock graph (2-3 nodes, edges), joins with symbol-index, inverted index lookup, each depth config
2. **`context-renderer` tests**: markdown output per depth level, token budget truncation, section priority ordering
3. **`graph-node-resolver`**: existing 8 tests + inverse join test (graphNodeId → symbolKey)
4. **Integration test**: `/get-context` end-to-end with real project data from memory-context repo

## File Inventory

New files:
- `tools/project-memory-context/src/retrieval/query-engine.mjs`
- `tools/project-memory-context/src/retrieval/context-renderer.mjs`
- `tools/project-memory-context/tests/query-engine.test.mjs`
- `tools/project-memory-context/tests/context-renderer.test.mjs`
- `~/.config/opencode/commands/get-context.md`

Modified files:
- `~/.config/opencode/AGENTS.md` — pmc-autostart block extended with auto-injection
- `tools/project-memory-context/cli/new-project.mjs` — sync retrieval tools to target projects
