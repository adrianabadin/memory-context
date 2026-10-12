# Enrich Symbol Cards

Repository: `memory-context`
Worktree: `C:/Users/aabad/AppData/Local/Temp/pmc-enrich-symbol-cards`
Branch: `feat/enrich-symbol-cards` · Initial base: `76cb4be`
Design: `v3.md` · Plan: `docs/superpowers/plans/2026-10-09-enrich-symbol-cards.md`
Objective: deterministic symbol relationships, architectural roles and validated bottom-up narratives, served through MCP and CLI.
Status: IN PROGRESS — 0.3 closed; 0.4 exploration next. Ongoing scoped implementation, commits and native reviews authorized until a real blocker.
Delivery: single-pr; no push, PR creation, merge or publishing. Preserve main and its intentional deletions; guard integration deferred.
Safety: owned temporary fixtures only. No real DB access or production PMC session-start/get-context/refresh/sync/enrich/watch until checkout identity guard lands. Compact PMC context unavailable safely: authorized disk mapping, no CodeGraph calls/init. No network/install, host cleanup or process termination. Real-data pruning needs separate authorization and backup.
Workflow: sequential delegated writers; observed deterministic RED/GREEN; independent checks; separate Conventional Commit/native review per work unit. Native approval requires exact acknowledgement; advisories do not reopen reviewed candidates.
Continuity: detailed historical evidence is preserved in this file at commit `f317ae0`, the linked unit trackers and Engram discoveries. This compact projection retains task states, acceptance and receipt evidence without repeating closed incident transcripts.

## F0 — Hygiene and identity
- [x] 0.0 Golden relational fixture/eval harness — source `4ed1bce`, closure `4455281`; independent 12/12, real graphify baseline 2/12 (not stub accuracy). Native `review-ee4df511d212422b` approved/acknowledged. Full suite skipped; seven nonblocking advisories.
- [x] 0.1 Walker exclusions and graphifyignore — source `ed39cb5`, closure `867913f`; independent 29/29; full 852 pass/1 baseline Codex failure. Native `review-26a60365cfe00bb6` approved/acknowledged. Explicitly approved global reliability model switch to Codex medium; hidden-scope advisory left untouched.
- [x] 0.2 Persist semanticSummary — source `2093c84`, closure `f317ae0`; independent 27/27 including registered fixture MCP query. First Responsibility sentence, max 200 chars; omitted summary preserves prior value, explicit null may clear; graph fallback retained. Native `review-1ed9347bb82ccc2a` approved/acknowledged, one responsibility-list advisory.
- [x] 0.3 DONE — attach_symbol on sync and backfill-symbol-keys CLI
  - Initial estimate 350–500 lines revised to 650–850 before edits; unchanged scope split into small sequential reviewable units.
  - [x] 0.3a Sync attachment/retry — `4a8edea7924b91f3b8637ff16746dbd6eee56a67`, 2 files +172/-1. RED 34 pass/7 fail; GREEN/independent 41/41 (492.8ms). Exact attachment after parsed store/update; missing ID and MCP errors remain pending; retry reuses the stored row. Native `review-01e28e9249a67d3a` approved/acknowledged; consumed `sha256:b3f4acd69c3b2f141af5096c7376943ed403cabd3c8c0f03c5b72cc828c545a3`. Static advisories only; no live backend claim.
  - [x] 0.3b Dry-run planner — `3b1e141ccc3998609533b0cab7816d10fba04a5e`, 2 files +422. Observed RED; correction RED 2 failures for single-character project tags and mixed duplicate IDs, then GREEN/independent 58/58 (534.5ms). Index-driven exact-tag search, collision grouping before eligibility, project ownership/conflict/duplicate/unsafe-path checks, cap reporting. Native `review-ff16f310a123e26d` approved/acknowledged; consumed `sha256:79a0322effb044f7df3e7efece7e910edd3784d1b659d19171236e79b36ecb8c`. One nonblocking cap-group advisory R3-001; approved planner unchanged.
  - [x] 0.3c CLI/apply and fixture acceptance — `b3fe0ddfc56ab7effa098a435948a771e34bb53f`, 5 files +412/-3. RED missing exports/registration; target-cwd RED 77/78 then GREEN/independent 78/78. Actual owned SQLite reader and context main render `Semantic Memory` with exact fixture content. Native `review-4d831b5728740bca` approved/acknowledged, consumed `sha256:ad814958e40fa93ea49e6f038b15d4ae72bf0597c9b58c472e3d72624010f9f5`; no correction offered. Cleanup failures are logged without changing successful application counts. Live backend acceptance not run.
  - Acceptance: dry-run default, only --apply mutates; refuse ALL application if coverage.complete is false, closing capped-group duplicate risk without reopening 0.3b. Validate arguments before setup, missing/invalid index safe, exact project slug documented with explicit override if needed, honest indexed-only coverage. Controlled failure counts/exit and client cleanup. Fixture get_by_symbol protocol plus real local SQLite reader and get-context render Semantic Memory; backend submodule absent, never label stubs a live handler test.
  - Checks: focused sync/backfill/dispatch plus bounded serial full suite after safety audit. Preserve known unrelated Codex template failure; no full-green claim. No production commands or approved advisory fixes.
- [ ] 0.4 IN PROGRESS — Deterministic graphNodeId resolution and null-reason report (read-only exploration; write scope/acceptance after mapping)
- [ ] 0.5 Decision D1 checkpoint — graphify vs own tree-sitter edges; stop for unresolved human product decision
- [ ] 0.6 Real-repo prune — STOP: explicit authorization and backup

## F1 — Typed nodes, file cards, facts and relations
- [ ] 1.1 Typed node kinds in graph.db (file/symbol/member/doc/config/data)
- [ ] 1.2 Class member extraction and member keys (D2)
- [ ] 1.3 Facts builder
- [ ] 1.4 File cards
- [ ] 1.5 get-context inbound callers and disambiguation
- [ ] 1.6 MCP pmc_relations and facts-only pmc_card

## F2–F5 — Expand at phase entry
- [ ] F2 Role classifier and profiles (>=90% fixture accuracy)
- [ ] F3 Bottom-up structured narrative, validator, narrativeHash and concurrency
- [ ] F4 Role-aware surface: stopAtRole, entrypoints, impact, card levels, Pi MCP access
- [ ] F5 Rollups and eval metrics in CI

## Separately authorized safety work (closed)
- [x] B1 Bootstrap test isolation — source `e0864da`, closure `d453383`; independent 23/23; native `review-c21c7c759dfcdef9` approved/acknowledged, two nonblocking advisories. See `odd/tasks/bootstrap-test-isolation.md`.
- [x] B2 Watcher overlap test barrier — source `b9c5c7e`, closure `7c2ef81`; deterministic RED/GREEN, independent 16/16; native `review-81d10d8eaf686e0c` approved/acknowledged, one advisory. See `odd/tasks/watcher-test-synchronization.md`.
- Last complete serial suite (0.3c): 913 tests, 21 suites, 912 pass/1 known pre-existing Codex failure, 0 skipped/cancelled, 54.074s, exit 1; no hang. Both package test selectors ran, including nested extractor tests. Earlier root-only run 869/870 is NOT full-suite evidence. Failure `tests/template-installer.test.mjs:308`: expected 1 PMC comment block, found 3, reproduced at untouched `4455281`. Log `%TEMP%/pmc-verify-03c/full.tap` contains human-readable Node output, not TAP. Default parallel suite not rerun after B2.
- Earlier host-install side effects and old runner ownership remain unverified. No host remediation, process kills or bulk cleanup authorized. Old verifier artifacts left intact.
