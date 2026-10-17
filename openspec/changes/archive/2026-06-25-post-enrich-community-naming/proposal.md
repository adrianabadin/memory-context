# Proposal: Post-Enrich Community Naming via Local LLM

## Intent

Communities in the knowledge graph are identified by numeric IDs (e.g., `community: 23`, `community: 15`) that carry no semantic meaning. When viewing the graph explorer or reading context reports, users cannot quickly understand what functional area a community represents. After enrichment completes, we can leverage the local Ollama model to generate descriptive names based on each community's member symbols and their enriched summaries.

## Scope

### In Scope
- New CLI command: `pmc name-communities <projectRoot>`
- Query graph.db for distinct communities and their member symbols
- Fetch enriched summaries for each community's symbols from sync-manifest/agent-memory
- Send batch prompt to Ollama: "Given these symbols: [list with summaries], what is the functional role? Respond with a short descriptive name."
- Store community names in a new `communities` table in graph.db (community_id → name mapping)
- Update graph explorer UI to display community names instead of "Community N"
- Update context-renderer to include community names in output

### Out of Scope
- Automatic re-naming on every enrichment run (manual or explicit trigger only)
- Renaming communities during graphify (names are post-processing)
- Multi-language community names
- Community description/metadata beyond the name

## Capabilities

### New Capabilities
- `community-naming`: Post-enrichment LLM-based community name generation and storage

### Modified Capabilities
- None (existing specs are unrelated to graph visualization)

## Approach

1. **New module**: `src/community-naming/name-communities.mjs`
   - Query `SELECT DISTINCT community FROM nodes` from graph.db
   - For each community, gather member nodes and their enrichment summaries
   - Batch prompt Ollama with structured input: symbol labels + summaries
   - Parse response into `community_id → name` mapping
   - Upsert into new `communities` table

2. **Schema addition**: Add `communities` table to graph-db.mjs
   ```sql
   CREATE TABLE IF NOT EXISTS communities (
     id   INTEGER PRIMARY KEY,
     name TEXT NOT NULL
   );
   ```

3. **CLI integration**: `cli/name-communities.mjs`
   - Accepts `<projectRoot>` argument
   - Opens graph.db, runs naming pipeline, reports results
   - Can be called standalone or as post-enrich hook

4. **UI update**: Graph explorer reads community names from db, displays in sidebar and tooltips

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/graph-store/graph-db.mjs` | Modified | Add `communities` table schema + read/write helpers |
| `src/community-naming/name-communities.mjs` | New | Core naming logic — Ollama prompt + response parsing |
| `cli/name-communities.mjs` | New | CLI entry point |
| `tools/pmc-graph-explorer/public/sidebar.js` | Modified | Display community names |
| `tools/pmc-graph-explorer/public/filters.js` | Modified | Show names in filter checkboxes |
| `tools/pmc-graph-explorer/public/graph.js` | Modified | Names in tooltips |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Ollama generates inconsistent/unhelpful names | Med | Prompt engineering + fallback to "Community N" |
| Large communities (>50 symbols) exceed context window | Med | Truncate to top-N symbols by degree centrality |
| Names become stale after code changes | Low | `name-communities` is re-runnable; names are overwritten |
| Ollama unavailable at call time | Low | Graceful fallback — skip naming, log warning |

## Rollback Plan

1. Drop `communities` table from graph.db: `DROP TABLE IF EXISTS communities`
2. Revert graph.json rebuild (community field unchanged — it's numeric)
3. UI gracefully falls back to "Community N" when no name found

## Dependencies

- Ollama running locally with configured model (already required for enrichment)
- graph.db must exist (created by `refresh-context` or `map-project`)

## Success Criteria

- [ ] `pmc name-communities .` generates names for all communities with ≥3 members
- [ ] Community names are stored in graph.db `communities` table
- [ ] Graph explorer displays descriptive names instead of numeric IDs
- [ ] Names reflect actual codebase function (e.g., "CLI Commands", "Graph Storage", "Enrichment Pipeline")
- [ ] Command completes in <60s for typical project (50-100 communities)
