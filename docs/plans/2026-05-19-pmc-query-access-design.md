# PMC Query Access — Design

## Goal
Give humans and agents fast, token-efficient access to PMC-enriched project memory via CLI, MCP tools, and agent skills.

## Architecture (4 layers, building 3)

```
Agent Skill "PMC-Aware"
    ┃ enseña al agente: PMC primero, archivos después
    ┃
┌─────────────────────────────────────────┐
│ 2. MCP Tools (pmc-query-server)         │ ← tools para cualquier agente
├─────────────────────────────────────────┤
│ 1. CLI `pmc query`                      │ ← para humanos
├─────────────────────────────────────────┤
│   PMC Query Engine (src/query/)         │ ← núcleo compartido
└─────────────────────────────────────────┘
```

Layer 4 (Web UI) postergado.

## Components

### PMC Query Engine (`src/query/orchestrator.mjs`)

Single entry point `orchestrateQuery(question, options)`:

1. **Analyze question** — detect mentions of symbols, files, or general intent
2. **Search agent-memory** — semantic search with top-5 relevant memories
3. **Lookup symbol index** — if a symbol is mentioned, get its graph node, enrichment, location
4. **Traverse graph** — find dependents/dependencies of matched symbols
5. **Collect sources** — file paths, line numbers, enrichment summaries
6. **Synthesize** (optional, if LLM available) — pass context to local LLM for coherent answer
7. **Return** structured result: `{ answer, sources: [{ file, line, summary }], tokens_saved }`

Fallback: if no LLM, return raw context fragments.

### CLI `pmc query`

```
pmc query "<natural language question>"
pmc query "<question>" --format json
pmc query --interactive       # REPL mode
```

Output: concise answer with file citations. Shows estimated tokens saved vs reading sources directly.

### MCP Server (`mcp/pmc-query-server.mjs`)

Tools:
| Tool | Input | Returns |
|---|---|---|
| `pmc_query_project` | `question: string` | Answer with sources |
| `pmc_search_symbols` | `query: string, file?: string` | Matching symbols |
| `pmc_get_dependents` | `symbol: string` | Files/symbols that depend on it |
| `pmc_get_dependencies` | `symbol: string` | Files/symbols it depends on |
| `pmc_get_memories` | `query: string, limit?: number` | Agent-memory entries |

Registered via the existing PMC plugin (`plugin/index.mjs` → `mcp.json` injection).

### Agent Skill "PMC-Aware"

File: `pmc-skill/SKILL.md` (installed to global skills dirs)

Core instructions:
- Before reading >3 files, call `pmc_query_project` first
- To understand architecture, use `/get-context` before making changes
- PMC has pre-enriched context — querying costs ~500 tokens vs reading files = ~5000+
- Only read source files when you need exact line-level detail
- Use `pmc_search_symbols` to find where things are defined before grepping

## Data Flow

```
Agent/Human
  │
  ├─► pmc query "how does enrichment work?"
  │     │
  │     ├─► agent-memory.search("enrichment queue")
  │     │     └─► returns [memory: "Enrichment queue processes..."]
  │     │
  │     ├─► symbol-index search("enrich*")
  │     │     └─► returns [symbolKey, file, graphNodeId]
  │     │
  │     ├─► graph.traverse(graphNodeId, { direction: "outbound" })
  │     │     └─► returns [dependencies: enrich-queue, enrich-batch, etc.]
  │     │
  │     └─► local LLM synthesis (optional)
  │           └─► "The enrichment queue works by..."
  │
  └─► Response: answer + [source files: enrich-queue.mjs:42, etc.]
```

## Token Optimization Strategy

| Action | Tokens aprox |
|---|---|
| Read 10 source files | ~5000-15000 |
| `pmc query` (with answer) | ~500-1500 |
| `/get-context <target>` | ~200-800 |
| Agent-memory search | ~100-300 |

La skill entrena al agente a elegir la opción más barata primero.

## Implementation Order

1. `src/query/orchestrator.mjs` — query engine core
2. `cli/query.mjs` — `pmc query` command
3. `mcp/pmc-query-server.mjs` — MCP tools
4. `src/query/agent-skill.mjs` — skill template installer
5. Templates: SKILL.md for OpenCode, CLAUDE.md snippet update
6. Tests

## Future (postergado)
- Web UI (`pmc ui`)
- `--watch` / REPL mode for CLI
- Query caching
- Cross-project queries
