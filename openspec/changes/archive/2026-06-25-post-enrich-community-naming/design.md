# Design: Post-enrich community naming via GLM-4.7-Flash

## Technical Approach
Implement a new command `pmc name-communities` that is triggered post-enrichment. It queries the `graph.db` for existing communities, aggregates their member summaries, and calls the ZhipuAI/bigmodel.cn API (GLM-4.7-Flash) to generate human-readable names. Results are stored in the graph database.

## Architecture Decisions

### Decision: API Client for GLM-4.7-Flash
**Choice**: Native `fetch` API.
**Alternatives considered**: Axios or official Zhipu SDK.
**Rationale**: Native `fetch` is built into Node.js (v18+) and avoids adding external dependencies for a single REST API call.

### Decision: Triggering Mechanism
**Choice**: Automatic hook at the end of `enrich-queue.mjs`.
**Alternatives considered**: Purely manual command or cron job.
**Rationale**: Ensures community names are always up-to-date with the latest enrichment data without requiring manual user intervention, while keeping the core enrichment loop fast.

## Data Flow
1. `enrich-queue.mjs` completes its worklist processing.
2. Invokes `tools/project-memory-context/cli/name-communities.mjs`.
3. Queries `graph.db` for communities and top N member symbols (by degree).
4. For each community, invokes GLM-4.7-Flash via REST API with member summaries.
5. Saves returned community names back to `graph.db`.
6. Updates `sync-manifest.json` for agent-memory integration.

## File Changes
| File | Action | Description |
|------|--------|-------------|
| `tools/project-memory-context/cli/name-communities.mjs` | Create | New CLI command for naming communities |
| `tools/project-memory-context/cli/enrich-queue.mjs` | Modify | Trigger `name-communities` post-enrichment |
| `tools/project-memory-context/src/graph/db.mjs` | Modify | Add schema/queries for community names |
| `tools/project-memory-context/cli/get-context.mjs` | Modify | Expose community names in output |

## Interfaces / Contracts
**ZhipuAI API Expected Payload:**
```json
{
  "model": "glm-4-flash",
  "messages": [
    {"role": "system", "content": "Generate a short, descriptive name for a code community based on these symbols..."},
    {"role": "user", "content": "[Symbol 1 summary], [Symbol 2 summary]"}
  ]
}
```

## Testing Strategy
| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | API Client | Mock `fetch` to simulate bigmodel.cn responses and timeouts. |
| Integration | Graph DB | Verify community names are correctly saved and retrieved via `get-context`. |

## Migration / Rollout
Update the `graph.db` schema to include a `name` column in the `communities` table (or handle it via existing metadata JSON if applicable). No breaking changes to existing data.

## Open Questions
- [ ] Should we allow configurable token limits per community to avoid exceeding the GLM-4.7-Flash context window?
- [ ] Is there a retry mechanism required for API 5xx errors?