# Configuration Reference

PMC uses a layered configuration system: global defaults, project-level overrides, and environment variables.

## Global Configuration

The global config file lives at `~/.config/opencode/project-memory-context.json`. This is the primary configuration file for sleep mode, gradual forgetting, and cross-project settings.

### Full Schema

```json
{
  "sleep": {
    "idleMinMinutes": 10,
    "cpuHighPercent": 65,
    "cpuResumeBelowPercent": 45,
    "maxRunHours": 6,
    "keepAwakeLeaseMinutes": 30,
    "onlyWhenPluggedIn": true,
    "pauseAfterCurrentSymbol": true
  },
  "forgetting": {
    "coolingAfterDays": 30,
    "dimmedAfterDays": 90,
    "shadowAfterDays": 180,
    "gistCandidateAfterDays": 365,
    "gistOnlyRetentionDays": 90
  }
}
```

### Sleep Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `idleMinMinutes` | number | `10` | Minutes of idle time before sleep-run is eligible |
| `cpuHighPercent` | number | `65` | CPU usage % above which sleep-run pauses |
| `cpuResumeBelowPercent` | number | `45` | CPU usage % below which sleep-run resumes |
| `maxRunHours` | number | `6` | Maximum hours a sleep-run can execute |
| `keepAwakeLeaseMinutes` | number | `30` | Keep-awake lease TTL in minutes |
| `onlyWhenPluggedIn` | boolean | `true` | Only run when machine is plugged in (laptops) |
| `pauseAfterCurrentSymbol` | boolean | `true` | Finish current symbol before pausing on activity |

### Forgetting Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `coolingAfterDays` | number | `30` | Days unused before `active → cooling` |
| `dimmedAfterDays` | number | `90` | Days unused before `cooling → dimmed` |
| `shadowAfterDays` | number | `180` | Days unused before `dimmed → shadow` |
| `gistCandidateAfterDays` | number | `365` | Days unused before `shadow → gist_only` |
| `gistOnlyRetentionDays` | number | `90` | Days to retain the original after gist creation before prune eligibility |

### Example: Conservative Forgetting

For projects where memories should persist longer:

```json
{
  "forgetting": {
    "coolingAfterDays": 90,
    "dimmedAfterDays": 180,
    "shadowAfterDays": 365,
    "gistCandidateAfterDays": 730,
    "gistOnlyRetentionDays": 180
  }
}
```

### Example: Aggressive Forgetting

For projects with high memory churn:

```json
{
  "forgetting": {
    "coolingAfterDays": 14,
    "dimmedAfterDays": 30,
    "shadowAfterDays": 60,
    "gistCandidateAfterDays": 90,
    "gistOnlyRetentionDays": 30
  }
}
```

## Environment Variables

### Agent Memory MCP

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MEMORY_DB_PATH` | Yes | — | SQLite database path on disk (e.g., `path/to/memory.db`) |
| `EMBEDDING_MODEL` | No | `Xenova/bge-m3` | HuggingFace model ID for embeddings |
| `EMBEDDING_DIMENSIONS` | No | `1024` | Vector dimensions (override for custom models) |
| `EMBEDDING_POOLING` | No | `cls` | Pooling mode: `cls` for BGE models, `mean` for MiniLM-style models |
| `MEMORY_DECAY_HALF_LIFE` | No | `30` | Temporal decay half-life in days. Set to `0` to disable decay |
| `ENABLE_HARDCOPY` | No | `false` | Set `'true'` to enable JSON file backup |
| `HARDCOPY_PATH` | Conditional | — | Directory for JSON mirror files (required if hardcopy enabled) |
| `EMBEDDING_CACHE_PATH` | No | — | Directory for content-addressed binary embedding cache. Invalidated when `EMBEDDING_MODEL` changes |

### PMC CLI

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PMC_PROJECT_ROOT` | No | `process.cwd()` | Project root for PMC operations |
| `PMC_LOCAL_MODEL_BASE_URL` | No | `http://localhost:11434` | Ollama API base URL |
| `PMC_LOCAL_MODEL_NAME` | No | `llama3.2` | Ollama model name for enrichment |

## Project-Level Configuration

### Enrichment Config

Location: `.planning/project-memory-context/enrichment/config.json`

```json
{
  "mode": "local-model",
  "model": "llama3.2",
  "concurrency": 3,
  "subagentThresholdTokens": 5000,
  "localModelBaseUrl": "http://localhost:11434"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | `local-model` | Provider selection: `local-model`, `cloud-api`, `agent-subagent` |
| `model` | string | `llama3.2` | Ollama model name |
| `concurrency` | number | `3` | Parallel enrichment slots |
| `subagentThresholdTokens` | number | `5000` | Token count threshold for subagent routing |
| `localModelBaseUrl` | string | `http://localhost:11434` | Ollama API URL |

### Context Tracking

Location: `.planning/project-memory-context/context-tracker.json`

Auto-managed by PMC. Tracks active context for the current project.

### File Hash Store

Location: `.planning/project-memory-context/file-hash-store.json`

Auto-managed by PMC. Stores XXH3 file hashes for change detection.

## Override Behavior

Configuration is resolved in this order (last wins):

1. **Defaults**: Hard-coded defaults in the source
2. **Global config**: `~/.config/opencode/project-memory-context.json`
3. **Project config**: `.planning/project-memory-context/enrichment/config.json`
4. **Environment variables**: `MEMORY_DB_PATH`, `PMC_LOCAL_MODEL_BASE_URL`, etc.

Sleep mode and forgetting settings are **global-only** — no project-level overrides. This ensures consistent behavior across all registered projects.

## MCP Configuration

PMC generates MCP configuration for supported agent platforms. Currently, PMC uses two separate MCP servers (`pmc-query` and `pmc-agent-memory`). A unified `pmc` server is planned.

### Current Generated Config Structure

```json
{
  "mcpServers": {
    "pmc-query": {
      "command": "npx",
      "args": ["--yes", "--package", "@aabadin/project-memory-context", "pmc-query-server"],
      "env": {
        "PMC_PROJECT_ROOT": "path/to/project"
      }
    },
    "pmc-agent-memory": {
      "command": "npx",
      "args": ["-y", "@aabadin/agent-memory-mcp"],
      "env": {
        "MEMORY_DB_PATH": "path/to/memory.db",
        "EMBEDDING_MODEL": "Xenova/bge-m3"
      }
    }
  }
}
```

### Planned Unified Config (Not Yet Implemented)

When the unified `pmc-mcp-server.mjs` ships, the config will consolidate to:

```json
{
  "mcpServers": {
    "pmc": {
      "command": "node",
      "args": ["path/to/pmc-mcp-server.mjs"],
      "env": {
        "MEMORY_DB_PATH": "path/to/memory.db",
        "PMC_PROJECT_ROOT": "path/to/project"
      }
    }
  }
}
```

### Legacy Aliases (Transition Period)

For one release, PMC also emits transitional aliases:

```json
{
  "mcpServers": {
    "pmc": { "..." : "primary server" },
    "pmc-query": { "..." : "transitional alias (deprecated)" },
    "pmc-agent-memory": { "..." : "transitional alias (deprecated)" }
  }
}
```

Old `pmc-query_` and `pmc-agent-memory_` prefixed tool names remain callable through these aliases during the transition period. See [MIGRATION.md](MIGRATION.md) for details.

## Sleep Mode Reports

Sleep run reports are written to `~/.config/opencode/pmc/sleep/runs/<runId>/report.json`:

```json
{
  "runId": "sleep-20260623-001",
  "status": "completed",
  "startedAt": "2026-06-23T02:00:00Z",
  "completedAt": "2026-06-23T04:30:00Z",
  "phases": [
    {
      "name": "refresh",
      "status": "completed",
      "startedAt": "...",
      "completedAt": "..."
    }
  ],
  "summary": {
    "projectsProcessed": 3,
    "symbolsEnriched": 47,
    "symbolsDeferred": 2,
    "memoryMaintenance": {
      "decayTransitions": 12,
      "gistsCreated": 3,
      "promotions": 1
    },
    "pauseEvents": [],
    "keepAwakeStatus": "active"
  }
}
```

### Report Fields

| Field | Type | Description |
|-------|------|-------------|
| `runId` | string | Unique run identifier |
| `status` | string | `completed`, `paused`, `failed` |
| `startedAt` | string | ISO 8601 start time |
| `completedAt` | string | ISO 8601 end time |
| `phases` | array | Per-phase results |
| `summary.projectsProcessed` | number | Number of projects processed |
| `summary.symbolsEnriched` | number | Symbols successfully enriched |
| `summary.symbolsDeferred` | number | Symbols deferred (e.g., local model unavailable) |
| `summary.memoryMaintenance` | object | Decay, gist, and promotion counts |
| `summary.pauseEvents` | array | Reasons and timestamps for pauses |
| `summary.keepAwakeStatus` | string | `unavailable`, `active`, or `failed` |
