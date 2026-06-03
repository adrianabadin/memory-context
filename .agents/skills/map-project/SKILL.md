---
name: map-project
description: Bootstrap PMC in the current project with graphify, worklist, and base memories.
argument-hint: "[--all] [--enrich]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

<objective>
Bootstrap PMC in the current project. Runs graphify, builds the enrichment worklist, materializes 9 base project-context memories, and writes the sync-manifest.
</objective>

<execution>
Run:

```bash
pmc map-project --all --enrich
```

Then follow up with `pmc enrich-status` to verify the worklist was created.
</execution>

<success_criteria>
- `.planning/project-memory-context/` directory exists with `graph/`, `enrichment/worklist.json`, and `enrichment/sync-manifest.json`
- 9 base project-context memories materialized in `agent-memory`
- Background enrichment started if `--enrich` was passed
</success_criteria>
