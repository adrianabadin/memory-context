# Delta for capture-pipeline

## Purpose
Persist queued capture events into the session ledger safely on Windows.

## ADDED Requirements

### Requirement: R1 MUST maintain a rotating JSONL queue
The system MUST append queue records to `.opencode/pmc-capture-queue.jsonl`, create the file on first append, and rotate it to `.opencode/pmc-capture-queue.{ts}.jsonl` when size exceeds 1 MB.

#### Scenario: First append
- GIVEN the queue file does not exist
- WHEN a hook writes the first event
- THEN the queue file is created and contains one JSON object line

#### Scenario: Normal append order
- GIVEN an existing queue file
- WHEN multiple events arrive
- THEN each event is appended as one ordered line

#### Scenario: Rotation threshold reached
- GIVEN the queue exceeds 1 MB before append completes
- WHEN the next event is written
- THEN the current file is archived and a fresh queue starts

### Requirement: R2 MUST drain with lock, timeout, retry, and batches
`pmc capture-drain <projectRoot>` MUST use `.opencode/pmc-capture-drain.lock`, MUST configure SQLite `busy_timeout=5000ms`, MUST retry transient failures up to 3 times with exponential backoff, and MUST process at most 100 entries per cycle before yielding.

#### Scenario: Another drainer is active
- GIVEN the lockfile is held
- WHEN a new drainer starts
- THEN it exits without processing the queue

#### Scenario: SQLite is briefly busy
- GIVEN the ledger database returns a transient busy error
- WHEN the drainer writes a batch
- THEN it retries with the configured timeout and backoff up to 3 times

#### Scenario: Queue has more than 100 entries
- GIVEN 250 queued events exist
- WHEN one cycle runs
- THEN no more than 100 entries are written before the drainer yields

### Requirement: R3 MUST use a ledger-only compose store
The drainer MUST use `createLedgerOnlyStore(dbPath)` from `agent-memory-mcp/src/compose.ts`, and that factory MUST open WAL SQLite without initializing the embedder while exposing only session-ledger methods.

#### Scenario: Drainer bootstraps store
- GIVEN the drainer starts
- WHEN it opens the database
- THEN the ledger-only factory is used

#### Scenario: Non-ledger API requested
- GIVEN drainer code tries to access embedding features
- WHEN the ledger-only store is used
- THEN only session-ledger methods are available

#### Scenario: Queue becomes idle
- GIVEN the queue is empty and stays idle for 30 seconds
- WHEN the drainer loop checks again
- THEN the drainer exits cleanly

## Out of Scope
- Direct SQLite writes outside compose
- HTTP or stdio re-entry services
- Embedding ledger rows during drain
