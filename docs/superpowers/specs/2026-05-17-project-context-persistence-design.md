# Project Context Persistence Design

**Date:** 2026-05-17

## Goal

Design a brownfield-first project context persistence flow that captures high-value project context as local canonical artifacts and synchronizes the current state into `agent-memory` for operational semantic recall during future implementation work.

The purpose of this context is not to answer user questions directly. The purpose is to ensure the agent can restore enough project context to work in an orderly way when new requests arrive.

## Scope

Version 1 supports:

- brownfield repositories that already contain code
- a dual model of project knowledge:
  - detected current state from the repository
  - declared desired state and rules from guided intake and editable files
- local canonical storage under `.planning/project-memory-context/project-context/`
- synchronization of current materialized context into per-project `agent-memory`
- incremental refresh based on `git diff` when available and file hashes/timestamps as fallback
- graph-aware context generation using `graphify` as structural support for architecture and structure summaries
- nine base project-context memories optimized for operational recall

Version 1 does not include:

- greenfield project initialization from zero
- a full automatic context-retrieval policy for future tasks
- perfect semantic impact propagation across the entire graph
- complete product-spec documentation or deep business analysis
- storing historical memory versions in `agent-memory`

## Design Principles

- Keep context operational, not encyclopedic.
- Separate detected state from declared intent.
- Store canonical truth locally; use `agent-memory` as the semantic operating index.
- Prefer medium-granularity memories over one giant summary or many tiny fragments.
- Refresh only what changed.
- Use the graph as a structural deepening tool, not as the only memory layer.
- Keep `agent-memory` focused on the current state only; historical evolution stays in local artifacts and git.

## Terminology

### Brownfield

An already-started project with existing code, dependencies, structure, and prior technical decisions.

### Greenfield

A new or nearly empty project where architecture, rules, and structure can be defined before implementation.

This design targets brownfield first.

## High-Level Architecture

The system uses two layers.

### Layer A: Detected and Declared Source Artifacts

This layer gathers structured inputs from:

- repository manifests and configuration
- filesystem structure
- `graphify` outputs
- docs and operational files such as `README`, `AGENTS.md`, `.opencode/`, and key project docs
- guided intake answers
- manually editable declared context files

### Layer B: Materialized Project Context Memories

This layer combines detected and declared inputs into medium-sized canonical memory units.

Each materialized unit is:

- stored as canonical JSON
- optionally rendered as Markdown for human readability
- synchronized to `agent-memory` using a stable `memory_key`

## Source Model: Dual Context

Project context is modeled as two parallel views.

### Detected Current State

Facts extracted from the repository, manifests, structure, graph, and operational docs.

Examples:

- installed frameworks
- current folder layout
- actual architecture patterns visible in code
- detected technical rules or conventions

### Declared Intended State

Statements provided during intake or maintained manually in editable files.

Examples:

- desired target architecture
- explicit technical rules
- project requirements and functional constraints
- known issues and accepted workarounds

### Conflict Handling

Detected state and declared state are stored separately and never collapsed into a single undifferentiated source.

When they differ:

- detected state remains the source of truth for what currently exists
- declared state remains the source of truth for intended direction, constraints, and explicit project rules
- materialized memories may be marked as `merged` but must preserve traceability to both source types

## Canonical Local Storage

Canonical project-context artifacts live under:

```text
.planning/project-memory-context/project-context/
  detected/
    manifests-summary.json
    dependency-inventory.json
    structure-snapshot.json
    architecture-snapshot.json
    detected-rules.json
    detected-requirements.json

  declared/
    architecture-target.json
    technical-rules.json
    project-requirements.json
    known-issues-and-fixes.json

  materialized/
    stack-runtime.json
    dependencies-summary.json
    integrations-summary.json
    architecture-current.json
    architecture-target.json
    structure-summary.json
    technical-rules.json
    project-requirements.json
    known-issues-and-fixes.json

  markdown/
    STACK-RUNTIME.md
    DEPENDENCIES-SUMMARY.md
    INTEGRATIONS-SUMMARY.md
    ARCHITECTURE-CURRENT.md
    ARCHITECTURE-TARGET.md
    STRUCTURE-SUMMARY.md
    TECHNICAL-RULES.md
    PROJECT-REQUIREMENTS.md
    KNOWN-ISSUES-AND-FIXES.md

  state/
    refresh-state.json
    content-hashes.json
    invalidation-report.json
```

## Canonical Format Strategy

The storage model is hybrid:

- JSON is the canonical machine-oriented source of truth
- Markdown is derived for human review and editing support

JSON is required because the persistence and incremental refresh pipeline need deterministic structured input.

Markdown is helpful because:

- it is easy to inspect during reviews
- it supports diffing and auditing
- it can be edited manually when needed

## Base Memories

Version 1 materializes nine base project-context memories.

### 1. `stack-runtime`

Purpose:
Capture the main technology stack and runtime environment.

Minimum content:

- primary languages
- runtimes
- core frameworks
- package managers
- build and dev tooling
- target platforms

### 2. `dependencies-summary`

Purpose:
Provide an operational summary of important installed dependencies without storing the full inventory in `agent-memory`.

Minimum content:

- core frameworks and platform libraries
- testing libraries
- data or ORM libraries
- auth and security libraries
- logging or observability libraries
- important SDKs
- dependency risk notes when relevant

The complete dependency inventory remains local in canonical artifacts.

### 3. `integrations-summary`

Purpose:
Summarize the project's external systems and integration surfaces.

Minimum content:

- databases
- auth providers
- storage services
- queues or jobs
- external APIs
- webhooks or callbacks
- critical env-var categories without exposing secret values

### 4. `architecture-current`

Purpose:
Describe the current architecture detected in the repository.

Minimum content:

- overall pattern
- main modules or layers
- important entrypoints
- main execution/data flows
- dependency boundaries
- key technical constraints
- graph references to relevant structural zones

### 5. `architecture-target`

Purpose:
Capture the desired architecture even if the current code does not fully match it.

Minimum content:

- intended pattern
- desired layers or modules
- intended boundaries
- important structural decisions
- meaningful deltas from current architecture
- evolution guidance

### 6. `structure-summary`

Purpose:
Provide a practical view of where things live and where new work should go.

Minimum content:

- important root directories
- key subtrees at intermediate depth
- entrypoints and composition files
- locations for domain code, infrastructure, UI, tests, scripts, and utilities
- practical placement rules for new code

Deep structure remains available through the filesystem and `graphify`.

### 7. `technical-rules`

Purpose:
Capture technical and operational rules needed for safe implementation.

Minimum content:

- hard conventions
- technical restrictions
- preferred implementation patterns
- anti-patterns to avoid
- file placement or editing rules
- tooling-related decisions that affect implementation

### 8. `project-requirements`

Purpose:
Capture lightweight functional and project-level context that helps implementation tasks stay aligned.

Minimum content:

- system purpose
- main capabilities
- main actors or users when relevant
- basic functional flows
- business-facing constraints visible in the project
- declared project requirements that should influence future changes

This is not a full product specification.

### 9. `known-issues-and-fixes`

Purpose:
Capture reusable operational knowledge about recurring errors, fragile areas, proven fixes, and workarounds.

Minimum content:

- symptom
- probable or confirmed cause
- affected modules or files
- solution or workaround
- verification method
- status or current validity
- confidence

This memory should store reusable operational knowledge, not vague debugging notes.

## Materialized Memory Shape

Each materialized memory uses a stable structure.

```json
{
  "memory_key": "project-context:architecture-current",
  "title": "Current project architecture",
  "kind": "architecture-current",
  "source_mode": "merged",
  "summary": "Compact 1-3 sentence summary used for semantic ranking and quick recall.",
  "body": "Short structured operational content.",
  "tags": [
    "project-context",
    "architecture",
    "current-state",
    "project:<slug>"
  ],
  "source_files": [
    "README.md",
    "src/app.ts"
  ],
  "graph_refs": [
    "node:src/app.ts"
  ],
  "declared_sources": [
    ".planning/project-memory-context/project-context/declared/architecture-target.json"
  ],
  "detected_sources": [
    ".planning/project-memory-context/project-context/detected/architecture-snapshot.json"
  ],
  "confidence": "high",
  "content_hash": "abc123",
  "updated_at": "2026-05-17T18:00:00Z"
}
```

### Required Fields

- `memory_key`: stable upsert key, for example `project-context:stack-runtime`
- `title`: human-readable label
- `kind`: exact memory type
- `source_mode`: `detected`, `declared`, or `merged`
- `summary`: 1 to 3 sentences for fast semantic recall
- `body`: short structured content optimized for implementation context
- `tags`: strong retrieval tags
- `source_files`: concrete file paths to inspect when deeper reading is needed
- `graph_refs`: graph nodes or graph zones related to the memory
- `confidence`: `high`, `medium`, or `low`
- `content_hash`: deterministic refresh key
- `updated_at`: last materialization time

### Optional Fields

- `declared_sources`
- `detected_sources`
- future `related_memory_keys` if cross-memory linking becomes useful

## Body Content Strategy

The `body` field should be semi-structured, short, and practical.

Examples:

- architecture memories should describe layers, flows, constraints, and where to make typical changes
- structure memories should describe key directories, placement rules, and entrypoint locations
- technical rules should describe conventions, restrictions, and anti-patterns
- requirements should describe purpose, capabilities, and functional constraints
- known issues should describe symptoms, causes, and verified fixes

The `body` field should not include:

- full folder trees
- complete dependency inventories
- raw graph dumps
- symbol-by-symbol explanations
- long-form documentation that should live elsewhere

## Source Strategy by Domain

### Stack and Dependencies

Primary inputs:

- `package.json`
- lockfiles
- `tsconfig*`
- `*.csproj`
- `global.json`
- framework and build configs

### Structure

Primary inputs:

- filesystem snapshot at intermediate depth
- `graphify` structure support

### Architecture Current

Primary inputs:

- `graphify` outputs
- focal reads of entrypoints, composition roots, and core modules

### Rules and Requirements Detected

Primary inputs:

- `README.md`
- `AGENTS.md`
- `.opencode/`
- config files
- key project docs

### Architecture Target, Rules, and Requirements Declared

Primary inputs:

- guided intake responses
- editable declared files under `declared/`

## Bootstrap Flow

### Step 1: Detect Current Project State

Produce the detected artifacts from manifests, configs, docs, structure, and graph sources.

### Step 2: Collect Declared Context

Run guided intake to produce initial declared artifacts for:

- target architecture
- technical rules
- project requirements
- known issues and fixes

These declared artifacts remain editable after bootstrap.

### Step 3: Materialize Canonical Memories

Combine detected and declared inputs into the nine canonical materialized JSON files.

### Step 4: Derive Markdown

Render review-friendly Markdown from the materialized JSON files.

### Step 5: Sync Current State to `agent-memory`

Upsert each memory by stable `memory_key` so `agent-memory` contains only the current state.

## Incremental Refresh Strategy

### Change Detection

Use a hybrid strategy:

- use `git diff` when available and meaningful
- fall back to hashes and timestamps when necessary

This supports dirty repos and partial local changes.

### Invalidation Rules

#### Changes to manifests or platform configs

Refresh:

- `stack-runtime`
- `dependencies-summary`
- `integrations-summary`

#### Changes to root directories or important subtrees

Refresh:

- `structure-summary`

#### Changes to entrypoints, composition roots, or core graph zones

Refresh:

- `architecture-current`

#### Changes to docs, operational rules, or project-level config

Refresh:

- detected rules inputs
- detected requirements inputs
- possibly `technical-rules`
- possibly `project-requirements`

#### Changes to declared files

Refresh:

- `architecture-target`
- `technical-rules`
- `project-requirements`
- `known-issues-and-fixes`

### Partial Rematerialization

Only affected artifacts and memories are regenerated.

Unchanged memories are not rewritten or resynchronized.

## Relationship to `graphify`

`graphify` is not the memory itself.

It provides:

- structural grounding
- module and entrypoint relationships
- architecture support
- references for later deep reads

The project-context memory layer is a compact abstraction above the graph.

## Relationship to Symbol Enrichment

Project-context memories and symbol-level memories serve different purposes.

Project-context memories answer:

- what kind of project is this
- how is it organized
- what rules apply
- what is the current vs intended architecture
- what known issues should influence work

Symbol-level memories answer:

- what a specific symbol does
- what its inputs and outputs are
- how it fits into its local module

The future retrieval layer can combine both, but Version 1 only defines how project-context memories are generated and persisted.

## `agent-memory` Usage Model

The project-level `opencode.json` config should point `agent-memory` at a local per-project database path so every repository has isolated semantic memory.

Example:

```json
{
  "mcp": {
    "agent-memory": {
      "type": "local",
      "command": ["agent-memory-mcp"],
      "environment": {
        "MEMORY_DB_PATH": "./.planning/db"
      }
    }
  }
}
```

This keeps project context and symbol context local to each repository.

## Risks and Mitigations

### Risk: Memories become too long

Problem:
The memory layer turns into mini-documentation rather than operational recall.

Mitigation:
Keep all memory bodies short, structured, and action-oriented.

### Risk: Refresh invalidates too much

Problem:
Small code changes cause broad rematerialization and noisy updates.

Mitigation:
Use explicit invalidation rules and partial rematerialization only.

### Risk: Detected and declared states become confused

Problem:
The system loses the distinction between current reality and intended direction.

Mitigation:
Preserve separate source artifacts and explicit traceability fields in materialized memories.

### Risk: Functional context is too weak

Problem:
`project-requirements` becomes generic and not useful during implementation.

Mitigation:
Require a minimum guided intake structure for purpose, capabilities, and constraints.

### Risk: Known issues degrade into noisy notes

Problem:
The issues memory becomes an unstructured dumping ground.

Mitigation:
Require symptom, cause, affected area, fix/workaround, verification, and confidence for each reusable issue record.

## Out of Scope for Version 1

- greenfield-first initialization workflow
- automatic task-time context retrieval policy
- graph-wide semantic impact propagation
- exhaustive business documentation
- deep automatic classification of every code convention or requirement
- storing historical versions of base memories in `agent-memory`

## Implementation Phases

### Phase 1: Schema and Storage Foundation

- define JSON schemas for detected, declared, and materialized artifacts
- define stable `memory_key` conventions
- define hash and refresh-state tracking
- define Markdown derivation rules

### Phase 2: Brownfield Bootstrap

- implement detected extractors
- implement guided declared intake
- implement materialization pipeline
- implement sync to `agent-memory`

### Phase 3: Incremental Refresh

- implement hybrid change detection
- implement invalidation matrix
- implement partial rematerialization and resync

### Phase 4: Future Retrieval Layer

- define which project-context memories to query for each task type
- define how to combine semantic recall with `graph_refs`
- define how to choose which files to read after context recall

## Success Criteria

- brownfield project context can be captured into local canonical artifacts
- nine base project-context memories can be materialized deterministically
- `agent-memory` stores only the current state of those memories
- detected and declared states remain distinguishable and traceable
- incremental refresh updates only affected context memories
- project-level memory is isolated per repository using local `agent-memory` storage
- the resulting memory layer is compact enough to support future minimal-context retrieval
