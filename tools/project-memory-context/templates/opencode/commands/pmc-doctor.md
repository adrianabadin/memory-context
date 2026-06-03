---
name: pmc-doctor
description: Run environment diagnostics — check Python, Ollama, Node, agent-memory, and graphify.
argument-hint: ""
allowed-tools:
  - Bash
---

<objective>
Run the PMC environment doctor to verify all dependencies are correctly installed and configured.
</objective>

<execution>
Run:

```bash
{{PMC_BIN}} doctor
```

This checks: Node version, Python availability, graphifyy installation, Ollama connectivity, MEMORY_DB_PATH, and embedding cache path.
</execution>
