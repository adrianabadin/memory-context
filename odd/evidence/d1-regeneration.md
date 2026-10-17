# D1 isolated regeneration evidence

## Scope and disposition

- Input source revision: `b1e90fcde85b5b9133d88cbc519e3068a5adaf83`.
- R1: complete and independently accepted; task documentation records commit `6ade7a2ffc8352f264617c407a06ee709497bbb6`.
- R2: independently accepted from corrected ignored run `tools/project-memory-context/.planning/d1-rebuild/run-1AeGxo`. Native assessment of the committed range was unassessable because the old raw snapshot is untracked; this does not negate the completed functional independent verification.
- R3: CLOSED by the explicit human acceptance of PMC-native Tree-sitter `calls`/`imports` relations with canonical symbol identity (“si acepto tu recomendacion”). This is a product decision, not a conclusion inferred from structural metrics. Native identity does not resolve all extractor-key, container, dynamic-call, or semantic-accuracy limitations; uncertain endpoints must remain unresolved rather than be invented.
- The native implementation is planned after typed nodes (1.1) and member identity (1.2), as bounded extraction (1.2b) and persistence/integration (1.2c), before facts (1.3). Initial coverage is JS/TS only; other languages remain unimplemented/unresolved.
- The separately authorized real-repo PMC artifact prune is deferred until after native call/import implementation and validation, and requires an exact target/scope preview plus online SQLite backup. No pruning occurred here.
- This is structural evidence, not source behavior, semantic quality, or provider accuracy evaluation.

## Execution and integrity

- Installed Graphify `0.8.25`; AST update ran on its own input root/local Git root, without hooks, remotes, or commits.
- Actual Graphify PID `9940`; exit `0`, close `0`, timeout `false`, duration `12,216 ms`. These values came from persisted actual execution events before finalization, not from log inference.
- Independent R2 `v2.mjs` was read-only and took `3,300 ms`. Re-extraction and resolver output were byte-identical; normal and reverse input ordering produced identical IDs.
- Input manifest: 270 Git-blob inputs (136 production, 134 test/fixture); every blob and SHA-256 matched. Generated `dist` fixture excluded; two legitimate token-named files included. Aggregate SHA-256 before and after: `8cb82b2591f2b1ad811b9a2fb76745fd4c4e424e1c67d7f11e060744a726d0e4`.
- Credential/config paths were excluded from the input allowlist; no exhaustive content-level secret audit is claimed. No claim is made that OS sandboxing or absence of all global/external host effects was established.
- Original three JSON artifacts and package ignored sync-state hashes, size, and mtime were unchanged; locks/logs count was zero before and after. Source configuration was read-only; no installation occurred.

## Structural results

- Graph contains 1,343 unique nodes and 2,718 edges with valid endpoints; graph SHA-256 `8d1b0b6954fb7f3eae895dfc339b78d34e8acdabceb61013de1dd2fd8a71b017`.
- Metadata is explicitly derived, not upstream metadata. Graph represents 268/270 inputs: installed `detect.py` regex `(?<![a-zA-Z0-9])tokens?(?![a-zA-Z])` skips `ollama-token-counter.mjs` and its test.
- Worklist: 420,679 bytes, complete JSON, 805 symbols; 785 resolved, 20 null (2.484%). Production: 602 symbols, 600 resolved, 2 null (0.332%). Test/fixture: 203 symbols, 185 resolved, 18 null (8.867%).
- Null causes: two production no-file-node (`countPromptTokens`, `estimateTokens`); 18 fixture class/interface/record no-label-match.
- Two duplicate keys account for four fixture occurrences: Kotlin `greet` lines 2/6 and PHP `speak` lines 8/13. Distinct graph IDs were retained; 803 unique keys.
- One known identity limitation: Swift `Greetable.greet` line 2 attaches to `Animal.greet` line 6, also claimed as real `Animal.greet`—a container false association. Range/file/label checks pass but do not prove identity. Other checked node IDs, cross-file and labels had zero validation failures; this does not override the container finding.

## Limits and preservation

- No semantic call-edge ground truth, LLM quality assessment, or full-suite test was performed or claimed.
- Historical `run-SyMrKq` remains retained with exit UNKNOWN; corrected `run-1AeGxo` did not overwrite it. The old raw snapshot at `.planning/d1-snapshots/snapshot-9FexP4` is untracked and not ignored: preserve it, never stage it. Its truncated worklist and inconsistent metadata are historical, not a current blocker.
- During R1/R2, no original commands, original DB access, real MCP sync, configuration changes, host installs, publishing, pruning, process cleanup, or architectural decision was performed. The subsequent human decision and deferred bounded PMC artifact-prune authorization are recorded above; no pruning occurred in this evidence task.

## Key learnings

1. Independent byte-identical re-extraction and reversed-order resolution support deterministic structural output.
2. Valid ranges and labels do not establish the correct containing symbol identity.
3. Fixture and production null rates differ substantially and should remain separately reported.
4. Explicitly derived metadata must not be described as upstream-generated metadata.
5. A historical invalid snapshot can remain preserved without blocking a corrected independent run.
