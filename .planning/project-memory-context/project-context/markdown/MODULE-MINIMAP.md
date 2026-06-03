# Module navigation map

**Kind:** module-minimap
**Updated:** 2026-06-02T05:31:53.395Z

## Summary

Module-level navigation map: 17 key modules, 3 cross-module connectors identified. Use get-context to drill into any module.

## Body

**Key modules** (ranked by how many others import them):

- `src/artifacts.mjs` ← 74 modules · imports: —
- `src/types.ts` ← 52 modules · imports: —
- `src/platform.mjs` ← 47 modules · imports: —
- `src/sync-manifest.mjs` ← 32 modules · imports: —
- `src/tools.ts` ← 13 modules · imports: src/types.ts
- `src/symbol-extractor.mjs` ← 13 modules · imports: extractors/regex-extractor.mjs, extractors/js-ts-extractor.mjs, src/symbol-keys.mjs
- `cli/enrich-queue.mjs` ← 13 modules · imports: src/enrichment-attempts.mjs, src/sync-manifest.mjs, providers/cloud-api-provider.mjs, providers/local-model-provider.mjs
- `src/memory-store.ts` ← 11 modules · imports: src/types.ts, src/errors.ts
- `retrieval/query-engine.mjs` ← 11 modules · imports: —
- `src/command-dispatch.mjs` ← 10 modules · imports: —
- `src/file-hash-store.mjs` ← 10 modules · imports: —
- `src/plugin-config.mjs` ← 10 modules · imports: —
- `retrieval/source-cache.mjs` ← 9 modules · imports: src/semantic-unit.mjs
- `src/template-installer.mjs` ← 9 modules · imports: src/platform.mjs

**Entry points** (import many, imported by few):
- `public/app.js` → 8 deps · public/filters.js, public/context-tracker.js, public/graph.js
- `cli/retry-errors.mjs` → 7 deps · src/sync-manifest.mjs, providers/cloud-api-provider.mjs, providers/local-model-provider.mjs
- `src/index.ts` → 6 deps · src/embedder.ts, src/embedding-cache.ts, src/hardcopy-store.ts

**Cross-module connectors** (high betweenness centrality):
- `LanceMemoryStore`: High betweenness centrality (0.076) - this node is a cross-community bridge.
- `HardcopyMemoryStore`: High betweenness centrality (0.059) - this node is a cross-community bridge.
- `MockMemoryStore`: High betweenness centrality (0.055) - this node is a cross-community bridge.

> Drill: `pmc get-context <symbol> extended dependencies` · `pmc get-context <symbol> extended dependents`

## Source Files

- `.planning/project-memory-context/graph/graph.json`

## Graph References

- `tools/project-memory-context/src/artifacts.mjs`
- `agent-memory-mcp/src/types.ts`
- `tools/project-memory-context/src/platform.mjs`
- `tools/project-memory-context/src/sync-manifest.mjs`
- `agent-memory-mcp/src/tools.ts`
