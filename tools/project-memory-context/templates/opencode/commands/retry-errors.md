---
name: retry-errors
description: Re-enrich symbols still in error status through PMC's fallback chain, with a per-symbol report.
argument-hint: "[--limit N] [--model MODEL] [--concurrency N] [--timeout MS]"
allowed-tools:
  - Bash
---

<objective>
Retry enrichment for symbols currently in error status, deduped by symbol, while preserving a per-symbol report of previous failures and retry outcomes.
</objective>

<execution>
Run:

```bash
{{PMC_BIN}} retry-errors --concurrency 1 --timeout 300000
```

The command reads the worklist, retries each unique `symbolKey` through the configured fallback chain (`local-model -> cloud-api -> agent-subagent`), and stops when all symbols recover or 5 iterations complete. A JSON report is saved to `.planning/project-memory-context/enrichment/retry-report.json` with:
- Previous error details for each symbol (error type, message, provider)
- Retry result per iteration (succeeded/failed, elapsed time, content preview)
- Overall summary: symbols retried, symbols recovered, symbols still failing, max iterations reached
</execution>
