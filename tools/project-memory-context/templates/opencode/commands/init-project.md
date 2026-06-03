---
name: init-project
description: Initialize PMC project structure — creates .planning/project-memory-context/ directory tree.
argument-hint: ""
allowed-tools:
  - Bash
---

<objective>
Initialize the PMC directory structure in the current project. Creates the .planning/project-memory-context/ hierarchy and default configuration.
</objective>

<execution>
Run:

```bash
{{PMC_BIN}} init-project
```

This creates the full directory tree under `.planning/project-memory-context/` with intake, graph, enrichment, project-context, and runs subdirectories.
</execution>
