# Enrich Symbol Cards

Repository: memory-context
Worktree: C:/Users/aabad/AppData/Local/Temp/pmc-enrich-symbol-cards
Branch: feat/enrich-symbol-cards · Initial base: 76cb4be
Design: v3.md · Plan: docs/superpowers/plans/2026-10-09-enrich-symbol-cards.md
Status: BLOCKED — B3 and 0.4 closed; D1 (0.5) lacks a complete, coherent source snapshot. No F1 or real pruning before its decisions.
Objective: deterministic symbol relationships, architectural roles and validated bottom-up narratives through MCP and CLI.
Authority: ongoing scoped implementation, commits and reviews until a real blocker. Single-pr delivery shape only; no push, PR, merge or publishing. Preserve main and intentional deletions; guard integration deferred.
Safety: owned fixtures only; no real DB/config, production PMC commands, Graphify, CodeGraph/init, network/install, host cleanup or process termination. Safe compact context unavailable: authorized disk mapping. Do not reuse the failed test-name filter; exclude the entire relational-eval.test.mjs file through an asserted explicit test-file array. D1 snapshot copying is now authorized: read/copy only graph/graph.json, graph/graph.metadata.json and enrichment/worklist.json from the original checkout's .planning/project-memory-context into owned isolated snapshots; no original modification, database opening or PMC/Graphify commands. Real pruning still needs separate authorization.
Workflow: sequential bounded writers, observed RED/GREEN and independent verification, source work-unit commits, native approval plus exact acknowledgement. Advisory findings never reopen receipts.
History: detailed closed evidence remains in this file at f317ae0 and 6872b88, separate safety trackers and Engram observations 2950, 2999–3008.

## F0 — Hygiene and identity
- [x] 0.0 Golden relational fixture/eval — 4ed1bce/4455281; 12/12 independent; real baseline 2/12, not stub accuracy. Native approved/acknowledged; seven advisories, full suite skipped.
- [x] 0.1 Walker exclusions/graphifyignore — ed39cb5/867913f; 29/29 independent; full 852/853 with known Codex failure. Native approved/acknowledged; explicit reliability-model switch to Codex medium; hidden-scope advisory untouched.
- [x] 0.2 semanticSummary persistence — 2093c84/f317ae0; 27/27 including fixture MCP readback; native approved/acknowledged. First Responsibility sentence, max 200 chars; omitted values preserve prior summaries, explicit null may clear; graph fallback retained.
- [x] 0.3 Symbol attachment/backfill — 4a8edea (sync), 3b1e141 (planner), b3fe0dd (CLI); closure 6872b88. Independent 41/41, 58/58, 78/78 respectively; all native reviews approved/acknowledged. Dry-run default, --apply only, exact project slug, global refusal on incomplete lookup coverage, accurate partial failure counts, fixture SQLite reader and actual context Semantic Memory output. Backend absent: no live handler claim. One planner cap advisory addressed by caller refusal, not by reopening the planner.
- [x] 0.4 DONE — deterministic graphNodeId resolution and diagnostics
  - Source commit 5539e16189f84eaf806255726fbac3c6045acc1f, five files +430/-57; base after separate B3 closure 977822dfbb879c85f71d806a48e731ed8e2db0e5. Original forecast 250–400 authored lines, advisory only.
  - Contract: consistent exact metadata.symbolKey first, then normalized same-file/name and uniquely nearest valid source line. Contradictory or foreign explicit keys, duplicate IDs/keys, ties or insufficient line data fail closed; no fuzzy/global-name or array-order fallback. Invalid/reversed ranges do not select a winner; stale input IDs become null at resolver level.
  - Pure resolverReport returns totals/nullRate/reason counts (no-file-node, no-label-match, ambiguous) and resolved symbols. Per-symbol resolutionReason is non-enumerable: accessible in memory but omitted from spread, JSON and actual worklist serialization. No index/DB schema change. Backfill both ID and metadata-only paths reject conflicting keys.
  - Observed correction RED/GREEN: initial 20/20, diagnostic/identity/range correction 6 failing then 28/28, metadata-only guard 1 failing then independent 29/29. Synthetic multilingual function/class fixture null rate 0 is NOT pipeline accuracy. Pre-existing caller nullish merge can restore stale IDs; documented follow-up, outside scope.
  - After B3: independent combined focused 46/46 (resolver/backfill/linker/summary/driver), 1951ms. Broad explicit array 111/112 files (entire relational file excluded, 12 tests not run): 918 tests, 21 suites, 917 pass/1 known Codex baseline failure, 0 skipped/cancelled, 56.0408s; exit 1, not full npm test. Source hashes and ignored sync-state SHA/mtime/presence unchanged. Logs %TEMP%/verif-broad.tap and verif-focused.tap. Earlier 55.385s run exposed the driver boundary; do not confuse it with this successful isolation check.
  - Native review-5d357ec59881cd84 approved; exact acknowledgement burned authority, consumed sha256:22eb19b49b836f810f4bb39966d30af5dbec3a73a9c11728cf5d977cdf956af9. Two informational reliability advisories at resolver lines 81-83 and 59; no correction opened or applied.
- [ ] 0.5 BLOCKED — D1 checkpoint; authorized copies created at .planning/d1-snapshots/snapshot-9FexP4 and independently verified byte-identical to all three originals (source hashes/size/mtime unchanged). The original worklist is truncated at exactly 1,048,576 bytes, ending mid-string; copy JSON parsing fails at position 1048576, line 30722. Graph JSON parses 38,296 nodes but accompanying May 16 metadata reports 209: no consistent-generation claim. Manifest is marked invalid; no partial salvage, resolver measurement or edge-source decision. Need a complete, coherent graph/symbol export before D1 can proceed; rebuilding originals or running PMC/Graphify remains unauthorized. No F1 until resolved.
  - Raw snapshot is untracked and NOT gitignored; never stage it or use git add -A. Stage only named task documents. Package ignored sync-state SHA/mtime unchanged; no original DB opening, repairs, refresh or process actions performed. Detailed hashes and independent evidence: Engram pmc/enrich-symbol-cards/d1-snapshot-validation (3013).
- [ ] 0.6 Real pruning — STOP for explicit authorization and online backup

## F1 — Typed nodes, file cards, facts and relations
- [ ] 1.1 Typed node kinds in graph.db
- [ ] 1.2 Class members and member keys (D2)
- [ ] 1.3 Facts builder
- [ ] 1.4 File cards
- [ ] 1.5 get-context inbound callers and disambiguation
- [ ] 1.6 MCP pmc_relations and facts-only pmc_card

## F2–F5 — Expand at phase entry
- [ ] F2 Role classifier/profiles (>=90% fixture accuracy)
- [ ] F3 Bottom-up narrative, validator, narrativeHash and concurrency
- [ ] F4 Role-aware surface, impact, entrypoints, card levels and Pi MCP
- [ ] F5 Rollups and CI eval

## Separate safety units
- [x] B1 Bootstrap isolation — e0864da/d453383; independent 23/23, native approved/acknowledged. See odd/tasks/bootstrap-test-isolation.md.
- [x] B2 Watcher overlap barrier — b9c5c7e/7c2ef81; independent 16/16, native approved/acknowledged. See odd/tasks/watcher-test-synchronization.md.
- [x] B3 Driver spawn isolation — bf93d6af2220db50d6e94b59303bd82186a22e91/977822dfbb879c85f71d806a48e731ed8e2db0e5; independent 17/17; native review-57dcab5d4f7913fe approved/exactly acknowledged, consumed sha256:f3b8bc9fd2e58aedfaaf0b5def71777cd1af49f07203a19203b400d77c69d193. See odd/tasks/enrichment-driver-test-isolation.md. Universal spawn denial, fixture-owned dependencies and cleanup, exact close counts; production unchanged.
- Last unfiltered complete suite (0.3c): 913 tests, 912 pass/1 known Codex baseline failure, 54.074s. Failure tests/template-installer.test.mjs:308: expected 1 PMC comment block, found 3, reproduced at untouched 4455281. No full-green claim. Later root-only or excluded-file checks are not full npm test.
- Existing package sync-state SHA f555fd82fc7728708841d2a0a1da5584750a5594d7014e0d6d68984f0fecf5cd and mtime 1791844641098.541 unchanged through B3; lock/log artifacts absent. Preserve it; no restoration/deletion authorized.
- Earlier unintended live Graphify runs, host-install effects, old temp artifacts and runner ownership remain unverified. No host cleanup/process action authorized or performed; expected finally cleanup is not proof of global absence.
