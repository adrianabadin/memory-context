---
name: get-context
description: Retrieve structured project context for a target (symbol, file, or query).
argument-hint: "<target> [depth] [focus]"
allowed-tools:
  - Bash
  - Read
---

<objective>
Retrieve and display structured project context for the given target. Use before reading files to get a structural overview.
</objective>

<execution>
Auto mode (recommended):

```bash
pmc get-context <target> [depth] [focus]
```

Explicit modes:

```bash
pmc get-context symbol <target> [depth] [focus]
pmc get-context file <target> [depth] [focus]
pmc get-context query <target> [depth] [focus]
```

Depths: compact (default), extended, deep.
Focus modes: all (default), dependencies, callers, containment, impact.

Repository refresh:

```bash
pmc get-context --refresh
```

This resets the 9 base project-context memories without a specific target.
</execution>
