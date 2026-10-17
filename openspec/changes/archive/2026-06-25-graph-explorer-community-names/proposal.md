# Proposal: Graph Explorer Community Names Display

## Intent

Graph Explorer currently renders communities as raw integer IDs ("Community 0", "Community 1"). Community names are already generated and stored in graph.db by the community-naming pipeline, but the explorer has no way to access them. This change bridges that gap so users see descriptive names in tooltips, sidebar, and filters.

## Scope

### In Scope
- Add `/api/communities` endpoint to `server.mjs` that reads names from graph.db
- UI fetches name mapping on init and caches in state
- Replace `Community ${id}` with name in tooltips, sidebar, and filters
- Fallback to `Community {ID}` if names unavailable or table missing

### Out of Scope
- Changes to community naming generation logic (covered by `community-naming` spec)
- Changes to graph.json structure
- Community name editing UI

## Capabilities

### New Capabilities
- `community-names-api`: Server endpoint that reads community names from graph.db and returns a mapping of community ID → name

### Modified Capabilities
- `community-naming`: Adds requirement that graph explorer MUST fetch and display names from the new API endpoint (delta to existing spec)

## Approach

1. **Server**: Add `GET /api/communities` to `server.mjs`. Query `community_names` table in graph.db, return `{ "0": "Graph Storage", "1": "CLI Commands", ... }`.
2. **App init**: In `app.js`, fetch `/api/communities` after loading graph data, store in `state.communityNames`.
3. **Display**: In `filters.js`, `graph.js`, `sidebar.js`, replace `Community ${id}` with `state.communityNames[id] || `Community ${id}``.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `tools/pmc-graph-explorer/server.mjs` | Modified | Add `/api/communities` endpoint |
| `tools/pmc-graph-explorer/public/app.js` | Modified | Fetch names on init, store in state |
| `tools/pmc-graph-explorer/public/filters.js` | Modified | Show name in sidebar filter list |
| `tools/pmc-graph-explorer/public/graph.js` | Modified | Show name in tooltip |
| `tools/pmc-graph-explorer/public/sidebar.js` | Modified | Show name in node detail badge |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `community_names` table missing in older graph.db | Low | API returns empty object; UI falls back to IDs |
| Graph.db locked during enrichment | Low | Read-only query, SQLite handles concurrent reads |

## Rollback Plan

Revert the 5 modified files. No data migration needed — changes are UI/API only.

## Dependencies

- `community-naming` spec must be implemented (names exist in graph.db)
- SQLite3 module available in server runtime

## Success Criteria

- [ ] Graph Explorer tooltips show descriptive community names
- [ ] Sidebar filter list shows names instead of "Community 0"
- [ ] Node detail badge shows community name
- [ ] Fallback to "Community {ID}" works when names unavailable
