# /get-context V1 Design

## Goal
Turn `/get-context` from a repo-level refresh wrapper into a real target-aware structural retrieval command for PMC.

## Problem
Current `/get-context` templates advertise a target argument, but the actual command path runs `pmc context . --refresh`, which only refreshes project-context memories for the whole repository. It does not resolve a target, inspect structural relationships, or guide next reads.

## V1 Scope

### In scope
- Target-aware retrieval for:
  - symbols
  - file paths
  - free-text structural queries
- Auto-resolution by default
- Explicit override modes:
  - `symbol`
  - `file`
  - `query`
- Structured output with:
  - summary
  - target metadata
  - relevant symbols/files
  - structural relations
  - next reads
- Depth presets:
  - `compact`
  - `extended`
  - `deep`
- Focus modes:
  - `all`
  - `dependencies`
  - `callers`
  - `containment`
  - `impact`

### Out of scope
- LLM synthesis
- source-file loading by default
- web UI
- replacing `pmc query`
- broad semantic QA over arbitrary text

## Recommended Approach
Use the existing structural engine in `src/retrieval/query-engine.mjs` and add a thin target-resolution + rendering layer in front of it.

This is preferred over rebuilding on top of the newer `pmc query` orchestrator because:
- the retrieval engine already knows how to traverse symbols/files/impact
- the command is structural by nature, not primarily semantic
- it minimizes code duplication and preserves the separation between:
  - structural retrieval (`/get-context`)
  - semantic query (`pmc query`)

## Command Shape

### Default mode
```bash
pmc context <target> [depth] [focus]
```

Examples:
```bash
pmc context UserService
pmc context src/auth.ts extended callers
pmc context "login flow" compact all
```

### Explicit override mode
```bash
pmc context symbol UserService extended dependencies
pmc context file src/auth.ts compact containment
pmc context query "login flow" extended impact
```

## Resolution Rules

### Auto-resolution order
1. **file** if the target looks like a path and exists or matches indexed file paths
2. **symbol** if the target matches one or more indexed symbol names
3. **query** otherwise

### Ambiguity handling
- If multiple symbols match, return a compact ambiguity result listing candidates
- Do not guess silently when multiple candidates are equally plausible

## Output Contract

V1 output should be stable, compact, and text-first.

Sections:
1. `Summary`
2. `Target`
3. `Relevant Symbols/Files`
4. `Relations`
5. `Next Reads`
6. `Metadata`

Example shape:

```text
Summary
- UserService orchestrates authentication state and token refresh.

Target
- mode: symbol
- name: UserService
- file: src/services/user-service.ts

Relevant Symbols/Files
- AuthClient (src/lib/auth-client.ts)
- SessionStore (src/state/session-store.ts)

Relations
- dependencies: AuthClient, SessionStore
- callers: LoginPage, useCurrentUser

Next Reads
- src/services/user-service.ts
- src/lib/auth-client.ts
- src/state/session-store.ts

Metadata
- depth: extended
- focus: dependencies
```

## Architecture

### Reused core
- `src/retrieval/query-engine.mjs`
  - `createDepthConfig`
  - `focusToEdgeTypes`
  - `querySymbolContext`
  - `queryFileContext`
  - `queryImpactScope`

### New pieces
- target resolver
- CLI argument parser for explicit modes
- compact renderer for structural output

### Data sources
- `.planning/project-memory-context/graph/graph.json`
- `.planning/project-memory-context/enrichment/symbol-index.json`
- `.planning/project-memory-context/enrichment/worklist.json`

## Data Flow
1. Parse CLI args
2. Load PMC graph/symbol/worklist artifacts
3. Build query engine
4. Resolve target mode:
   - file
   - symbol
   - query
5. Dispatch to the correct retrieval path
6. Render compact output

## Behavior by Mode

### Symbol mode
- Use `findSymbolKeyByName()`
- If exactly one match, call `querySymbolContext()`
- If multiple matches, return candidates

### File mode
- Use `findSymbolKeysByFilePath()` plus file-level graph traversal
- Call `queryFileContext()`

### Query mode
- Resolve free text heuristically:
  - check symbol-name matches first
  - check indexed file path matches second
  - if still unresolved, return a “best candidates” list rather than pretending semantic certainty

## Error Handling
- No PMC data -> clear setup error
- Unknown depth/focus -> default or explicit validation error
- Ambiguous target -> candidate list, not a silent guess
- No match -> “no structural match found” + suggestion to use `pmc query`

## Testing Strategy

Tests should cover:
- auto-resolve file target
- auto-resolve symbol target
- fallback query target
- explicit override modes
- ambiguous symbol match result
- `focus=dependencies/callers/containment/impact`
- output contains stable sections

## Success Criteria
- `/get-context` genuinely uses a target
- output is structural, compact, and actionable
- users can inspect symbols/files without broad file reads
- the command complements `pmc query` instead of overlapping confusingly
