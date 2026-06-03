# PMC Enrichment Fallback Design

**Date:** 2026-05-17

## Goal

Design a single enrichment execution layer for `project-memory-context` that supports three interchangeable execution modes for semantic symbol enrichment:

- `local-model`
- `cloud-api`
- `agent-subagent`

The system must work on machines with Ollama, on machines that only have access to a paid external API, and on machines where enrichment should be delegated to the opencode agent itself.

## Scope

Version 1 includes:

- a shared enrichment driver used by PMC entrypoints
- a provider model for `local-model`, `cloud-api`, and `agent-subagent`
- ordered fallback via configuration
- per-project plus global configuration with environment variable overrides
- structured attempt logging and resumable state in worklist entries
- reuse of the existing sync-manifest and worklist persistence model
- integration with `enrich-queue`, `enrich-batch`, and on-demand `@enrich`

Version 1 does not include:

- changing `agent-memory-mcp` embeddings or search behavior
- replacing the sync-manifest layer
- a hosted daemon or always-on enrichment service
- automatic secret storage beyond opencode/global config plus environment variables

## Non-Goals

- No change to the semantic prompt format used for symbol enrichment.
- No change to the project-context materialization subsystem.
- No change to how `agent-memory` stores or searches memories.

## Design Principles

- One enrichment decision layer, not duplicated fallback code.
- Entry points remain thin orchestration wrappers.
- Failure of one provider must not corrupt worklist state.
- Every state mutation must be resumable.
- Keep the provider contract small and explicit.
- Prefer configuration over branching logic in commands.

## High-Level Architecture

Add a new enrichment execution subsystem under `tools/project-memory-context/src/`:

```text
src/
  enrichment-config.mjs
  enrichment-driver.mjs
  enrichment-attempts.mjs
  providers/
    local-model-provider.mjs
    cloud-api-provider.mjs
    agent-subagent-provider.mjs
```

### Responsibilities

- `enrichment-config.mjs`
  - load project config
  - load global/default config
  - apply environment overrides
  - return one effective config object

- `enrichment-driver.mjs`
  - accept a symbol enrichment request
  - resolve ordered provider list
  - skip unavailable providers
  - execute fallback chain
  - classify failures
  - return structured result metadata

- `enrichment-attempts.mjs`
  - append provider-attempt events to `provider-events.jsonl`
  - update in-memory worklist entries with attempt history

- provider files
  - implement one provider each with a shared contract

## Provider Contract

Each provider exports a small interface:

```js
{
  kind: 'local-model' | 'cloud-api' | 'agent-subagent',
  isConfigured(context): { ok: boolean, reason?: string },
  isAvailable(context): Promise<{ ok: boolean, reason?: string }>,
  enrich(request, context): Promise<{ content, provider, model, raw? }>
}
```

### Request shape

The driver receives a normalized request:

```js
{
  symbol,
  prompt,
  projectRoot,
  projectSlug,
  timeoutMs,
}
```

### Success shape

```js
{
  content,
  provider,
  model,
  mode,
}
```

## Execution Modes

### 1. `local-model`

Purpose:
Use a local Ollama-compatible model for enrichment.

Required config:

- `baseUrl`
- `model`

Default provider:

- `ollama`

Notes:

- uses the current HTTP generate call pattern
- remains the fastest default when available
- keeps current prompt and response format

### 2. `cloud-api`

Purpose:
Use an external paid model over HTTP.

Version 1 supports:

- generic OpenAI-compatible API
- named presets for common providers layered on top of the generic shape

Required config:

- `provider`
- `baseUrl`
- `model`
- `apiKeyEnv` or equivalent resolved secret source

Named presets are convenience only. The generic wire format is the real contract.

### 3. `agent-subagent`

Purpose:
Use the opencode agent path instead of a model API.

This provider delegates enrichment to the existing `@enrich` workflow rather than calling Ollama or an external API directly.

Version 1 behavior:

- queue/orchestrator mode may materialize a provider-specific job file for later agent execution
- on-demand mode can call through to the existing agent flow immediately
- provider output must still land in the same worklist/sync-manifest pipeline

## Configuration Model

## Effective Config

The effective config is built with this precedence:

1. project override
2. global default
3. environment variable overrides applied last only for explicit runtime control

### Logical shape

```json
{
  "preferredModes": ["local-model", "cloud-api", "agent-subagent"],
  "localModel": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "deepseek-coder-v2:16b-ctx32k"
  },
  "cloudApi": {
    "provider": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4.1-mini",
    "apiKeyEnv": "PMC_CLOUD_API_KEY"
  },
  "agentSubagent": {
    "enabled": true,
    "agentName": "enrich"
  }
}
```

### Storage locations

- per-project: `.opencode/project-memory-context.json`
- global: `~/.config/opencode/project-memory-context.json`
- environment: explicit runtime override variables such as `PMC_ENRICHMENT_PREFERRED_MODES`

## Fallback Semantics

The driver walks `preferredModes` in order.

For each mode:

1. check `isConfigured`
2. check `isAvailable`
3. attempt enrichment
4. on success, stop and return
5. on failure, classify error and continue if retryable/fallback-eligible

### Fallback-eligible failures

- auth failure
- timeout
- network error
- rate limit
- provider unavailable
- invalid local daemon state

### Non-corrupting failures

If all providers fail, the symbol is marked `error`, with attempt history preserved. The queue must continue processing the remaining symbols.

## Failure Classification

All attempts are normalized into these classes:

- `config`
- `auth`
- `network`
- `timeout`
- `rate-limit`
- `provider`
- `runtime`

This classification drives logging and fallback decisions.

## Worklist and Attempt Persistence

Each worklist entry may contain:

```json
{
  "attempts": [
    {
      "mode": "local-model",
      "provider": "ollama",
      "status": "failed",
      "errorType": "network",
      "errorMessage": "connection refused",
      "startedAt": "...",
      "endedAt": "..."
    },
    {
      "mode": "cloud-api",
      "provider": "openai-compatible",
      "status": "succeeded",
      "model": "gpt-4.1-mini",
      "startedAt": "...",
      "endedAt": "..."
    }
  ],
  "lastModeUsed": "cloud-api"
}
```

### Provider event log

Append-only log file:

```text
.planning/project-memory-context/enrichment/provider-events.jsonl
```

Each line stores one provider attempt with enough information for debugging and postmortem analysis.

## Entry Point Changes

### `cli/enrich-queue.mjs`

- stops calling Ollama directly
- builds the same prompt as today
- calls `enrichment-driver`
- writes attempt metadata to the worklist entry
- preserves current checkpointing and sync-manifest behavior

### `cli/enrich-batch.mjs`

- delegates each symbol to the driver
- preserves current concurrency behavior

### `@enrich`

- uses the same driver contract
- for on-demand enrichment, it may still force `agent-subagent` if the user explicitly requests it later, but default behavior should use normal config resolution

### `cli/sanitize.mjs`

- does not enrich inline
- only refreshes the worklist state and marks `pending` / `stale` / `removed`
- background enrichment later resolves provider choice through the driver

## Packaging Impact

To make the system portable across machines, the new provider configuration must be installable without editing source code.

Therefore:

- `new-project.mjs` should write provider-aware defaults
- a future installer should provision global defaults and commands
- no provider choice should be hardcoded in project scripts after this change

## Testing Strategy

Version 1 should add tests for:

- config resolution precedence
- provider availability and selection
- fallback ordering
- error classification
- worklist attempt persistence
- queue behavior when one provider fails and the next succeeds
- queue behavior when all providers fail

Use pure unit tests for the driver and config layer first. Keep provider HTTP tests mocked or simulated through injected fetch implementations.

## Migration Strategy

No migration of canonical PMC artifacts is required.

Worklist entries may safely gain new optional fields:

- `attempts`
- `lastModeUsed`
- `lastProvider`

Existing worklists remain valid.

## Recommended Implementation Order

1. add config loader
2. add provider interface and failure classifier
3. implement local provider
4. implement cloud provider
5. implement driver tests
6. wire `enrich-queue`
7. wire on-demand `@enrich`
8. add append-only provider event logging
9. update packaging/bootstrap defaults

## Open Questions Resolved

- Fallback applies only to PMC enrichment, not `agent-memory` embeddings.
- The third mode is specifically `agent-subagent`, not manual CLI entry.
- Cloud mode supports both generic OpenAI-compatible configuration and named provider presets.
- Mode order is configurable via a preferred-mode list.
- Configuration is mixed: global defaults plus project overrides.

## Final Recommendation

Implement a single enrichment driver with provider adapters. This gives a consistent enrichment path across queue, batch, sanitize, and on-demand workflows while keeping fallback behavior explicit, testable, and portable across machines.
