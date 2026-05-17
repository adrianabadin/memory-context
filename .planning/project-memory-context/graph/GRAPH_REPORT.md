# Graph Report - .  (2026-05-16)

## Corpus Check
- Corpus is ~25,632 words - fits in a single context window. You may not need a graph.

## Summary
- 209 nodes · 459 edges · 15 communities (12 shown, 3 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 30 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]

## God Nodes (most connected - your core abstractions)
1. `LanceMemoryStore` - 23 edges
2. `ensureProjectMemoryContextDirs()` - 21 edges
3. `writeJsonArtifact()` - 20 edges
4. `readJsonArtifact()` - 18 edges
5. `HardcopyMemoryStore` - 16 edges
6. `MockMemoryStore` - 15 edges
7. `registerTools()` - 13 edges
8. `persistEnrichmentResult()` - 9 edges
9. `TransformersEmbedder` - 8 edges
10. `finalizeEnrichment()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `createServer()` --calls--> `registerTools()`  [INFERRED]
  agent-memory-mcp/src/server.ts → agent-memory-mcp/src/tools.ts
- `persistEnrichmentArtifacts()` --calls--> `ensureProjectMemoryContextDirs()`  [INFERRED]
  tools/project-memory-context/src/enrichment-artifacts.mjs → tools/project-memory-context/src/artifacts.mjs
- `persistEnrichmentArtifacts()` --calls--> `writeJsonArtifact()`  [INFERRED]
  tools/project-memory-context/src/enrichment-artifacts.mjs → tools/project-memory-context/src/artifacts.mjs
- `persistEnrichmentResult()` --calls--> `applyEnrichmentResult()`  [INFERRED]
  tools/project-memory-context/src/persist-enrichment-result.mjs → tools/project-memory-context/src/enrichment-linker.mjs
- `prepareSemanticJobs()` --calls--> `buildSemanticUnit()`  [INFERRED]
  tools/project-memory-context/src/prepare-semantic-jobs.mjs → tools/project-memory-context/src/semantic-unit.mjs

## Communities (15 total, 3 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.14
Nodes (13): applyWhereClause(), computeDecayFactor(), importanceMultiplier(), isEvergreen(), LanceMemoryStore, parseDecayHalfLife(), postFilter(), resultToSearchResult() (+5 more)

### Community 1 - "Community 1"
Cohesion: 0.19
Nodes (15): ensureProjectMemoryContextDirs(), readJsonArtifact(), writeJsonArtifact(), recordEnrichmentFailure(), finalizeEnrichment(), buildIntakeContext(), normalizeList(), normalizeString() (+7 more)

### Community 2 - "Community 2"
Cohesion: 0.12
Nodes (4): TransformersEmbedder, main(), createServer(), MockEmbedder

### Community 3 - "Community 3"
Cohesion: 0.21
Nodes (9): buildEnrichmentArtifacts(), persistEnrichmentArtifacts(), safeSymbolKey(), buildEnrichmentResult(), buildMemoryPayload(), normalizeList(), loadResultInput(), normalizeSemanticReport() (+1 more)

### Community 4 - "Community 4"
Cohesion: 0.25
Nodes (12): buildCodeHash(), buildEnrichmentWorklist(), countParameters(), extractCSharpSymbols(), extractTopLevelSymbols(), extractTypeScriptSymbols(), findBlockEndLine(), inferScriptLanguage() (+4 more)

### Community 5 - "Community 5"
Cohesion: 0.29
Nodes (11): handleDelete(), handleFindRelated(), handleListRecent(), handlePrune(), handleRecall(), handleSearch(), handleStats(), handleStore() (+3 more)

### Community 8 - "Community 8"
Cohesion: 0.35
Nodes (5): applyEnrichmentResult(), backfillGraphNode(), findGraphNodeIdByMemoryId(), findMemoryIdByGraphNodeId(), upsertSymbolIndexEntry()

### Community 9 - "Community 9"
Cohesion: 0.52
Nodes (5): buildSemanticPrompt(), buildSemanticUnit(), collectCSharpContext(), collectTypeScriptContext(), sliceLines()

### Community 10 - "Community 10"
Cohesion: 0.38
Nodes (3): attachGraphNodeIds(), findByFallback(), normalizePath()

## Knowledge Gaps
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `LanceMemoryStore` connect `Community 0` to `Community 2`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Why does `HardcopyMemoryStore` connect `Community 6` to `Community 2`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `MockMemoryStore` connect `Community 7` to `Community 2`, `Community 5`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Are the 6 inferred relationships involving `ensureProjectMemoryContextDirs()` (e.g. with `persistEnrichmentArtifacts()` and `recordEnrichmentFailure()`) actually correct?**
  _`ensureProjectMemoryContextDirs()` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `writeJsonArtifact()` (e.g. with `persistEnrichmentArtifacts()` and `recordEnrichmentFailure()`) actually correct?**
  _`writeJsonArtifact()` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `readJsonArtifact()` (e.g. with `recordEnrichmentFailure()` and `finalizeEnrichment()`) actually correct?**
  _`readJsonArtifact()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._