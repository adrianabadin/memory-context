# Watcher Test Synchronization

Repository: memory-context
Worktree: C:/Users/aabad/AppData/Local/Temp/pmc-enrich-symbol-cards
Branch: feat/enrich-symbol-cards
Base: 867913f
Status: DONE — source commit b9c5c7e; independent functional verification complete and native review approved/acknowledged.
Authorization: User explicitly approved the test-only synchronization correction; ongoing scoped work-unit commits and native reviews authorized. No push, PR, merge, production watcher changes, host process kills or cleanup.
Related: B1 bootstrap isolation and task 0.2 remain pending and separate.

## Work unit
- [x] B2 DONE — Make the overlap/error watcher test wait for a logical refresh-start barrier, and prove the scheduling race deterministically.
  - Surface: tools/project-memory-context/tests/watch-runtime.test.mjs only. Parent owns this document.
  - Route: bounded delegated writer (test preparation and deterministic RED/GREEN), independent focused verification, separate work-unit commit/native review. Forecast 30–100 authored lines, advisory only.
  - Problem: first tick yields during heartbeat filesystem I/O before setting refreshRunning; the test immediately awaits second tick and only then releases refresh. If second wins I/O scheduling, the release is unreachable. No fixed sleep exists in the current test.
  - Acceptance: an explicit refreshStarted promise is signalled only after the fake refresh has installed its completion callback; second tick starts only after that barrier. Preserve overlap prevention, calls=1 and refresh-error/pending assertions. Cleanup owned fixture and release manual gates in finally even on assertion failure.
  - Test-first: controlled fake heartbeat I/O forces the dangerous order; bounded in-test timeout/assertion proves RED without leaving unresolved processes. Add the barrier and observe GREEN under that same schedule. Do not alter production watch code or add sleeps to mask the race.
  - Checks: focused overlap test; all watch-runtime/watcher-lifecycle/worklist tests with external 30s timeout; independent repeat. After focused GREEN, one bounded full-suite check with direct TAP/serial concurrency (300s), no filters/pipelines. Known Codex template idempotency failure remains outside scope.
  - Safety: all dependency fakes and owned temporary directories; no actual refresh/enrich/watch, real DB, network/install/config, production PMC commands, CodeGraph initialization, bulk deletion or process kills. PMC compact context safely unavailable; disk mapping fallback.
  - Evidence: writer observed controlled RED with `refresh start deadlock`, then matched focused GREEN 1/1; initial wrong-cwd path error is not counted as RED. Independent three-file serial check passed 16/16; production watcher unchanged, owned fixture count unchanged.
  - Full serial suite: completed in 55.3s, 877 tests / 876 pass / 1 known pre-existing Codex template failure, 21 suites, 0 cancelled. Previous 300s stall absent. Output `C:/Users/aabad/AppData/Local/Temp/pi-bash-a7bcf0454363f7ce.log`; 829 top-level results. Full suite is NOT green.
  - Scope evidence: only watch-runtime.test.mjs changed for B2 (+67/-28); B1 and 0.2 file hashes unchanged by checks. Other full-suite tests left temporary files; no cleanup permission or action. No old processes terminated.
  - Commit: `b9c5c7e` — `test(pmc): synchronize watcher refresh overlap assertions`, only the authorized test file (+67/-28).
  - Native closure: `review-81d10d8eaf686e0c`, medium / review-reliability; approved and exact acknowledgement burned authority, consumed revision `sha256:c51e892219fad3bfe9340863f82edc3336e1794a980288c72ef141061b24248f`, target `sha256:3083b6639e3685f1a62e8452ea81b3bae893b6b5123cd367cfc54598bce7343a`. Advisory `R3-001` at test lines 171-172 is non-blocking; no correction offered or applied.
  - Review routing: committed-range inspect must carry the same baseRef/committedOnly selector as START, plus exclusion of unrelated untracked files. Initial ambient selection mismatch created no lineage; first consent expired without creating authority; fresh anchored consent succeeded. No reset or recovery performed.
  - Next: close B1 and 0.2 as separate work units; no push/PR/merge or host cleanup.

## Existing evidence
- B1 bootstrap 23/23 and 0.2 summaries 27/27 passed independently; three watch files passed 16/16 in isolation.
- Both default-concurrency and serial full-suite checks timed out at 300s. Latest serial log ends after 818 results at the preceding watch-runtime test; only recorded failure is known template-installer Codex idempotency.
- Old runner PID 17628 and child 16932 were alive on prior observation; exact worktree ownership not fully established. No termination is authorized or performed.
