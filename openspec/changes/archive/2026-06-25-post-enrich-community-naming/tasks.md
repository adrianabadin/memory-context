# Tasks: Post-enrich community naming via GLM-4.7-Flash

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 350–420 |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: DB + naming command → PR 2: Integration hooks |
| Delivery strategy | force-chained |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Foundation: DB schema + standalone naming command | PR 1 | Base; includes tests for name-communities.mjs |
| 2 | Integration: enrich-queue hook + get-context exposure | PR 2 | Depends on PR 1; wiring and output changes |

## Phase 1: Foundation — DB Schema

- [x] 1.1 Add `community_names` table schema (`community_id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `created_at TEXT`, `updated_at TEXT`) — implemented in `tools/project-memory-context/src/graph-store/graph-db.mjs` (actual path; `src/graph/db.mjs` does not exist)
- [x] 1.2 Add `upsertCommunityName(communityId, name)` method to the SQLite graph store
- [x] 1.3 Add `getCommunityName(communityId)` method to the SQLite graph store
- [x] 1.4 Add `getAllCommunityNames()` method to the SQLite graph store
- [x] 1.5 Add `deleteCommunityName(communityId)` method to the SQLite graph store

## Phase 2: Core — Naming Command

- [x] 2.1 Create `tools/project-memory-context/cli/name-communities.mjs` — CLI entry point accepting `<projectRoot>` arg
- [x] 2.2 Implement `fetchCommunities(db)` — query graph.db for distinct community IDs and member symbols
- [x] 2.3 Implement member-summary gathering — `fetchCommunities` collects enriched summaries from node metadata per community (folded into 2.2; no separate `gatherMemberSummaries` needed)
- [x] 2.4 Implement `callGLM4Flash(symbols, apiKey)` — native fetch to `https://open.bigmodel.cn/api/paas/v4/chat/completions` with Bearer token from `BIGMODEL_API_KEY`
- [x] 2.5 Implement `truncateSymbols(symbols, max=50)` — limit symbols by degree centrality for large communities
- [x] 2.6 Implement naming pipeline: iterate communities, call API, store results via `upsertCommunityName`
- [x] 2.7 Add graceful fallback: missing API key → log warning, skip; API failure → keep generic ID, continue

## Phase 3: Integration — Hooks + Exposure

- [x] 3.1 Modify `tools/project-memory-context/cli/enrich-queue.mjs` — added `maybeNameCommunities` post-enrich hook (runs only when symbols enriched, never throws) invoked at end of `main()`
- [x] 3.2 Expose community names in get-context — `query-engine.mjs` resolves the target's community name via `getAllCommunityNames()`, surfaced through `context.mjs` (actual path; `cli/get-context.mjs` does not exist) and rendered in `context-renderer-v1.mjs`
- [x] 3.3 Update sync-manifest generation to include community names — `createCommunitySyncEntry` in `src/sync-manifest.mjs`, appended per named community by the enrich-queue hook

## Phase 4: Testing + Verification

- [x] 4.1 Unit test for `callGLM4Flash` — mock fetch, verify request payload and response parsing (`tests/name-communities.test.mjs`)
- [x] 4.2 Unit test for `truncateSymbols` — verify truncation logic for communities >50 members (`tests/name-communities.test.mjs`)
- [x] 4.3 Integration test for DB round-trip — upsert and retrieve community names (`tests/community-names-db.test.mjs`)
- [x] 4.4 Integration test for naming pipeline — end-to-end with mocked API (`tests/name-communities.test.mjs` `nameCommunities` cases)
- [x] 4.5 Verify `get-context` output includes community names when present — `context-cli.test.mjs` (`get-context output surfaces the community name for a named community`, plus renderer + `buildRenderInput` cases)
