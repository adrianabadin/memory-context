# Enrich Symbol Cards

Repository: `memory-context` · Target branch: `feat/enrich-symbol-cards` (isolated worktree: C:/Users/aabad/AppData/Local/Temp/pmc-enrich-symbol-cards; base 76cb4be)
Design: `v3.md` · Plan: `docs/superpowers/plans/2026-10-09-enrich-symbol-cards.md` · Baseline audit: `v2.md`
Objective: Make PMC enrichment useful for coding through Symbol Cards: deterministic graph facts linked by `symbolKey`, a rule-based architectural role, and a bottom-up, schema-validated LLM narrative, served through MCP and CLI.
Constraints: Test-first (`node --test` from `tools/project-memory-context`); fixture-only integration tests; never run refresh, sync, enrich, or watch from the worktree until `assertCheckoutIdentity` lands; real-repo cleanup only with explicit authorization and a backup; one Conventional Commit per task; no push, PR, or merge.
Status: IN PROGRESS — task 0.0 implemented and independently checked; explicit commit authorization received; final staged checks and candidate review pending. Delivery strategy: single-pr (user chose one combined review); chain strategy not applicable. This grants no push, PR creation, or merge permission. Main and its intentional deletions remain untouched. Guard integration deferred.
Route 0.0: delegated writer (multi-file implementation), RED/GREEN with temporary data only, followed by independent verifier. Forecast was 350–400 lines; observed implementation/tests/fixture: 1,136 authored lines (planning/docs separately: 433). No publishing or merge authorized.

## F0 — Hygiene and identity
- [ ] 0.0 IN PROGRESS — Golden fixture `layered-app` + relational eval harness (record baseline accuracy)
- [ ] 0.1 Exclude `.planning/**`, `.worktrees/**`, graphify artifacts from walkers + `.graphifyignore`
- [ ] 0.2 Persist `semanticSummary` in symbol-index
- [ ] 0.3 `attach_symbol` on sync + `backfill-symbol-keys` CLI (dry-run default)
- [ ] 0.4 Deterministic `graphNodeId` resolution + null-reason report
- [ ] 0.5 Decision D1 checkpoint (graphify edges vs own tree-sitter edges)
- [ ] 0.6 Real-repo prune (STOP: user authorization + backup)

## F1 — Typed nodes, file cards, facts, relations
- [ ] 1.1 Typed node kinds in graph.db (`file/symbol/member/doc/config/data`)
- [ ] 1.2 Class member extraction + member keys (D2)
- [ ] 1.3 Facts builder (`src/cards/facts.mjs`)
- [ ] 1.4 File cards (`src/cards/file-card.mjs`)
- [ ] 1.5 get-context inbound callers + target disambiguation
- [ ] 1.6 MCP `pmc_relations` + facts-only `pmc_card` on graph.db

## F2–F5 (expanded to step level at phase entry)
- [ ] F2 Role classifier + profiles (≥90% fixture accuracy)
- [ ] F3 Bottom-up structured narrative + validator + narrativeHash + concurrency
- [ ] F4 stopAtRole, entrypoints, impact, card levels, Pi MCP access
- [ ] F5 Rollups + eval metrics in CI

## Evidence log
- 2026-10-09: Audit `v2.md`, design `v3.md`, and plan written. No source changes, no commits.
- Task 0.0: delegated writer observed RED then GREEN; independent verifier reran 12/12 focused tests and both baseline/stub commands. Baseline via real graphify 0.8.25 on owned temporary root: 2/12 exact matches (16.7%), including 1 graph-backed call relation and 1 empty-set match. Extraction: 10 files, 12 symbols, 0 methods. Stub 12/12 is harness validation only, NOT pipeline accuracy.
- Earlier verifier blockers (incorrect graphify probe, incompatible golden keys, fake graphless baseline, unsafe caller temp root) were corrected and rechecked. No remaining technical blockers reported. Full suite skipped; global graphify integration check is environment-dependent. Baseline CLI includes graphify stdout and is not pure JSON. git diff --check does not cover untracked files.
- Closure pending: final staged checks, authorized work-unit commit, and native candidate review when applicable. User selected single-pr delivery; size choice resolved. No task checkbox checked; no commits, push, PR, or merge. Main remains unchanged.
