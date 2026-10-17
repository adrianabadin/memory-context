# Design: Graph Explorer community names display

## Technical Approach

Add a new backend endpoint `/api/communities` to `server.mjs` that queries the `community_names` table in `graph.db`. The frontend will fetch this mapping during initialization and store it in global state. The `app.js`, `filters.js`, `sidebar.js`, and `graph.js` modules will be updated to display the resolved community name, falling back to "Community {ID}" if a name is unavailable.

## Architecture Decisions

### Decision: API Endpoint vs Merging into graph.json

**Choice**: Create a separate `/api/communities` REST endpoint querying `graph.db` dynamically.
**Alternatives considered**: Modifying the batch graph generation to include names in `graph.json`, or piggybacking on `/api/graph`.
**Rationale**: `graph.json` contains static network structure and is cached. `community_names` is metadata that can evolve independently. Fetching it via a dedicated endpoint keeps `/api/graph` lightweight and focuses metadata retrieval where it belongs.

### Decision: Frontend State Management for Names

**Choice**: Store the fetched name mapping globally in `app.js` as `state.communityNames` and pass it to rendering functions.
**Alternatives considered**: Making components fetch the names individually, or querying per node.
**Rationale**: Community names are globally applicable and small in size. Fetching them once on `init()` and distributing via the existing `state` object prevents redundant network calls and guarantees synchronous rendering in UI components.

## Data Flow

    Frontend (app.js) ─── GET /api/communities ──→ Backend (server.mjs)
          │                                              │
          │                                    [Query graph.db]
          ↓                                              │
    Store in state.communityNames ⟵──── JSON Map ────────┘
          │
          ├──→ filters.js (Filter labels)
          ├──→ sidebar.js (Node detail view)
          └──→ graph.js   (Node tooltips)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `tools/pmc-graph-explorer/server.mjs` | Modify | Add `/api/communities` route, import `better-sqlite3`, query `graph.db` (`SELECT community_id, name FROM community_names`), return `Record<string, string>`. Handle missing DB/table. |
| `tools/pmc-graph-explorer/public/app.js` | Modify | Fetch `/api/communities` in `loadData()`, store in `state.communityNames`. |
| `tools/pmc-graph-explorer/public/filters.js` | Modify | Read `state.communityNames` in `initFilters` to format labels as `{name}` or `Community {ID}`. |
| `tools/pmc-graph-explorer/public/sidebar.js` | Modify | Update `updateSidebar` to display the community name instead of just the ID. |
| `tools/pmc-graph-explorer/public/graph.js` | Modify | Update `tooltip.innerHTML` in `createGraph` to show the community name. |

## Interfaces / Contracts

**GET `/api/communities`**
Returns a JSON object mapping community IDs to their string names:
```json
{
  "0": "Core API",
  "1": "CLI Tools"
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Frontend Name Resolution | Verify that UI components correctly use `state.communityNames` or fallback gracefully to "Community {ID}". |
| Integration | API Endpoint | Start server, call `/api/communities`, expect a valid JSON map (or empty `{}` if missing table/DB). |

## Migration / Rollout

No database migration required for the Graph Explorer itself. It gracefully relies on the existence of the `community_names` table produced by PMC analysis.

## Open Questions

- None
