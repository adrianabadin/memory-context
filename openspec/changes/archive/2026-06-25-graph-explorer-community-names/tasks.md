# Tasks: Graph Explorer community names display

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~60–80 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | single PR |
| Delivery strategy | auto-chain (forced-chained but risk is Low) |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

## Phase 1: Backend — Add `/api/communities` endpoint

- [x] 1.1 Add `import { openGraphDb } from "../project-memory-context/src/graph-store/graph-db.mjs"` at top of `tools/pmc-graph-explorer/server.mjs`
- [x] 1.2 Add `GRAPH_DB_PATH` constant pointing to `resolve(projectRoot, ".planning/project-memory-context/graph/graph.db")`
- [x] 1.3 Add `GET /api/communities` route in `server.mjs`: open graph.db via `openGraphDb`, call `getAllCommunityNames()`, map to `{ [community_id]: name }`, return JSON. Catch errors and return `{}`

## Phase 2: Frontend state — Fetch and store names

- [x] 2.1 In `tools/pmc-graph-explorer/public/app.js` `loadData()`: add `fetch("/api/communities")` to `Promise.all`, store result as `state.communityNames`
- [x] 2.2 Add helper `getCommunityName(id)` to `app.js` that returns `state.communityNames[String(id)] ?? "Community ${id}"`; expose on state object

## Phase 3: Frontend display — Use names in UI components

- [x] 3.1 In `tools/pmc-graph-explorer/public/filters.js` `initFilters()`: replace hardcoded `Community ${c}` label with `state.communityNames[String(c)] ?? "Community ${c}"` (pass `state` or `communityNames` as param)
- [x] 3.2 In `tools/pmc-graph-explorer/public/sidebar.js` `updateSidebar()`: replace `Community ${node.community}` badge text with resolved name from `state.communityNames`
- [x] 3.3 In `tools/pmc-graph-explorer/public/graph.js` tooltip: replace `Community ${d.community}` with resolved name from `state.communityNames`

## Phase 4: Verification

- [x] 4.1 Manual test: start explorer (`node tools/pmc-graph-explorer/server.mjs`), verify community filter labels show names
- [x] 4.2 Manual test: click a node, verify sidebar shows community name
- [x] 4.3 Manual test: hover a node, verify tooltip shows community name
- [x] 4.4 Edge case: if graph.db missing or community_names empty, verify fallback "Community {ID}" works
