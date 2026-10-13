# D1 isolated regeneration

Parent feature: odd/tasks/enrich-symbol-cards.md (task 0.5)
Worktree: C:/Users/aabad/AppData/Local/Temp/pmc-enrich-symbol-cards
Branch: feat/enrich-symbol-cards
Input revision: b1e90fcde85b5b9133d88cbc519e3068a5adaf83
Status: IN PROGRESS — R1 verified; R2 validation evidence is being recorded before the human D1 decision.

## Authority and scope
The user explicitly authorized regenerating graph and symbols in an isolated copy, running PMC/Graphify there, including possible external processing. Original checkout and artifacts must remain intact. No original DB opening, real MCP sync, host configuration changes, dependency installation, publishing, old-process cleanup, pruning or architectural D1 decision.

Only tracked parser-supported code at the input revision is copied. Exclude .git, .planning, .worktrees, node_modules, agent configurations and credential files. Preflight counted 271 eligible files; the execution manifest must establish the actual count. This is a code-only structural measurement, not document enrichment or semantic accuracy evaluation. Fixture/test and production subsets must be distinguished in the report.

Generated inputs, outputs, logs and scripts stay under tools/project-memory-context/.planning/d1-rebuild/run-*/ (already ignored). An isolated local Git root may be initialized inside the input copy to prevent Graphify's upward ignore traversal from selecting the feature checkout. No remotes, hooks, commits or host Git configuration changes. Record the authoritative source revision in the manifest; do not fabricate a target commit.

## Tasks
- [x] R1 — Fresh run-1AeGxo completed and independently accepted. Graphify PID 9940, exit 0, close 0, duration 12,216ms, timeout false; events persisted before finalization. 270 Git-object inputs, all input hashes unchanged, 1,343 unique graph nodes, 2,718 valid edges and a complete 805-symbol worklist. Metadata is explicitly derived. Original three JSON artifacts and package sync-state hashes/size/mtime unchanged. Initial run-SyMrKq remains retained with exit unknown; no blind replay or old-process cleanup.
- [ ] R2 IN PROGRESS — Independently validate containment, original integrity, input-hash parity, complete JSON, node/symbol identity and reproducible pure resolver counts. Verification completed read-only; record its detailed evidence and limitations. Null/mismatch checks are structural proxies, not ground-truth accuracy.
- [ ] R3 — Record verified evidence and ask the human to choose the D1 edge source. Do not start F1 or real pruning before the required decision.

Route: delegated writer for multi-file artifacts and execution; independent verifier for external-tool generation and command-running checks. No meaningful RED exists for passive regeneration: validate execution outcomes and artifact integrity instead. No production source behavior changes are authorized by this task.

## Preflight evidence
Installed graphifyy 0.8.25; update needs no previous graph. Its foreground AST extraction uses worker processes and writes graphify-out files/cache. PMC runGraphifyUpdate also creates .graphifyignore and uses a 60s process-tree timeout. Only the current owned invocation may be bounded; no unrelated-process actions. Eleven PMC grammar WASM files and web-tree-sitter 0.26.9 are installed. Corrected Windows execution was independently verified; cache/temp outputs are confined to the owned run paths observed, without an OS sandbox or global host-side-effect claim. No PTY tools are available; long-running execution is foreground and bounded, not detached.

Historical invalid capture remains at .planning/d1-snapshots/snapshot-9FexP4; never stage it or use git add -A. Original worklist is truncated at 1 MiB and graph metadata 209 disagrees with actual 38,296 nodes. Do not reuse it as a valid baseline or claim an established truncation cause. Full evidence: Engram 3013.
