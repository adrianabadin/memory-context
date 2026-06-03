# PMC Enrichment Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared PMC enrichment driver with `local-model`, `cloud-api`, and `agent-subagent` modes, ordered fallback, and resumable provider attempt logging.

**Architecture:** Introduce a new enrichment execution layer under `tools/project-memory-context/src/` that owns config resolution, provider selection, failure classification, and event logging. Keep the queue and on-demand entrypoints thin by routing all enrichment calls through the same driver.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict`, `fetch`, existing PMC artifact helpers, existing worklist/sync-manifest persistence.

---

### Task 1: Add Enrichment Config Loader

**Files:**
- Create: `tools/project-memory-context/src/enrichment-config.mjs`
- Create: `tools/project-memory-context/tests/enrichment-config.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/enrichment-config.test.mjs` covering:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveEnrichmentConfig } from '../src/enrichment-config.mjs';

test('resolveEnrichmentConfig applies defaults', () => {
  const result = resolveEnrichmentConfig({ projectConfig: null, globalConfig: null, env: {} });
  assert.deepEqual(result.preferredModes, ['local-model', 'cloud-api', 'agent-subagent']);
  assert.equal(result.localModel.provider, 'ollama');
});

test('resolveEnrichmentConfig lets project override global', () => {
  const result = resolveEnrichmentConfig({
    globalConfig: { enrichment: { localModel: { model: 'global-model' } } },
    projectConfig: { enrichment: { localModel: { model: 'project-model' } } },
    env: {},
  });
  assert.equal(result.localModel.model, 'project-model');
});

test('resolveEnrichmentConfig lets env override explicit fields', () => {
  const result = resolveEnrichmentConfig({
    projectConfig: null,
    globalConfig: null,
    env: { PMC_ENRICHMENT_PREFERRED_MODES: 'cloud-api,agent-subagent' },
  });
  assert.deepEqual(result.preferredModes, ['cloud-api', 'agent-subagent']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/enrichment-config.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create `tools/project-memory-context/src/enrichment-config.mjs` exporting `resolveEnrichmentConfig({ projectConfig, globalConfig, env })` with:

```js
const DEFAULTS = {
  preferredModes: ['local-model', 'cloud-api', 'agent-subagent'],
  localModel: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'deepseek-coder-v2:16b-ctx32k',
  },
  cloudApi: {
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    apiKeyEnv: 'PMC_CLOUD_API_KEY',
  },
  agentSubagent: {
    enabled: true,
    agentName: 'enrich',
  },
};
```

Merge order: defaults -> global `enrichment` -> project `enrichment` -> env overrides.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/enrichment-config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 2: Add Error Classification Utilities

**Files:**
- Create: `tools/project-memory-context/src/enrichment-errors.mjs`
- Create: `tools/project-memory-context/tests/enrichment-errors.test.mjs`

- [ ] **Step 1: Write the failing test**

Create tests for `classifyEnrichmentError(error)`:

```js
assert.equal(classifyEnrichmentError(new Error('401 unauthorized')).type, 'auth');
assert.equal(classifyEnrichmentError(new Error('429 rate limit')).type, 'rate-limit');
assert.equal(classifyEnrichmentError(new Error('ECONNREFUSED')).type, 'network');
assert.equal(classifyEnrichmentError(new Error('timeout exceeded')).type, 'timeout');
assert.equal(classifyEnrichmentError(new Error('bad config')).type, 'config');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/enrichment-errors.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create a classifier that returns:

```js
{ type: 'auth' | 'rate-limit' | 'network' | 'timeout' | 'config' | 'provider' | 'runtime', message: error.message }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/enrichment-errors.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 3: Add Provider Attempt Logging

**Files:**
- Create: `tools/project-memory-context/src/enrichment-attempts.mjs`
- Create: `tools/project-memory-context/tests/enrichment-attempts.test.mjs`

- [ ] **Step 1: Write the failing test**

Create a test that appends two attempt events to `provider-events.jsonl` and asserts both lines are present and JSON parseable.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/enrichment-attempts.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create:

```js
export async function appendProviderEvent(enrichmentDir, event) {}
export function withRecordedAttempt(entry, attempt) {}
```

`appendProviderEvent()` should append one JSON line to `provider-events.jsonl`. `withRecordedAttempt()` should return a copy of the worklist entry with `attempts` appended and `lastModeUsed` updated.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/enrichment-attempts.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 4: Add Local and Cloud Providers

**Files:**
- Create: `tools/project-memory-context/src/providers/local-model-provider.mjs`
- Create: `tools/project-memory-context/src/providers/cloud-api-provider.mjs`
- Create: `tools/project-memory-context/tests/local-model-provider.test.mjs`
- Create: `tools/project-memory-context/tests/cloud-api-provider.test.mjs`

- [ ] **Step 1: Write the failing tests**

Cover:

- local provider returns `ok: false` when model/baseUrl missing
- local provider calls injected `fetch` and returns content
- cloud provider returns `ok: false` when `apiKeyEnv` is unset in env
- cloud provider calls an OpenAI-compatible `chat/completions` endpoint and extracts message content

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/project-memory-context/tests/local-model-provider.test.mjs tools/project-memory-context/tests/cloud-api-provider.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementations**

Local provider contract:

```js
export function createLocalModelProvider({ fetchImpl = fetch } = {}) {
  return {
    kind: 'local-model',
    isConfigured(context) { ... },
    async isAvailable(context) { ... },
    async enrich(request, context) { ... },
  };
}
```

Cloud provider contract:

```js
export function createCloudApiProvider({ fetchImpl = fetch } = {}) {
  return {
    kind: 'cloud-api',
    isConfigured(context) { ... },
    async isAvailable(context) { ... },
    async enrich(request, context) { ... },
  };
}
```

Use the existing prompt as-is. For cloud, send a minimal OpenAI-compatible payload with `model` and a single user message containing the enrichment prompt.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/project-memory-context/tests/local-model-provider.test.mjs tools/project-memory-context/tests/cloud-api-provider.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 5: Add Driver Selection and Fallback

**Files:**
- Create: `tools/project-memory-context/src/enrichment-driver.mjs`
- Create: `tools/project-memory-context/tests/enrichment-driver.test.mjs`

- [ ] **Step 1: Write the failing test**

Add tests for:

- first configured provider succeeds
- first provider fails and second succeeds
- unavailable provider is skipped
- all providers fail and final result is `status: 'error'`

Use fake provider objects with `kind`, `isConfigured`, `isAvailable`, and `enrich` methods.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/enrichment-driver.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create `runEnrichmentWithFallback({ request, config, providers })` that:

- iterates `config.preferredModes`
- finds matching provider
- skips unconfigured/unavailable providers
- records each attempt outcome
- returns a structured result containing:

```js
{
  status: 'succeeded' | 'error',
  content,
  mode,
  provider,
  model,
  attempts,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/enrichment-driver.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 6: Route `enrich-queue` Through the Driver

**Files:**
- Modify: `tools/project-memory-context/cli/enrich-queue.mjs`
- Create: `tools/project-memory-context/tests/enrich-queue-driver.test.mjs`

- [ ] **Step 1: Write the failing test**

Create a focused test that stubs driver output and verifies queue-side persistence updates:

- success path writes `.memory.json`
- success path appends sync-manifest entry
- worklist entry gains `attempts` and `lastModeUsed`
- fallback success preserves both failed and successful attempts

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/enrich-queue-driver.test.mjs`
Expected: FAIL because queue does not use the driver yet.

- [ ] **Step 3: Write minimal implementation**

Refactor queue code so:

- prompt construction stays local to the queue or moves to a small helper
- direct `callOllama()` usage is removed from the queue path
- each symbol goes through `runEnrichmentWithFallback()`
- worklist updates include attempt metadata

Preserve current checkpointing, stale handling, and sync-manifest append behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/enrich-queue-driver.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run regression suite**

Run: `node --test tools/project-memory-context/tests/*.test.mjs`
Expected: PASS with no regressions.

- [ ] **Step 6: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 7: Wire On-Demand Enrichment and Bootstrap Defaults

**Files:**
- Modify: `C:\Users\aabad\.config\opencode\agent\enrich.md`
- Modify: `tools/project-memory-context/cli/new-project.mjs`
- Modify: `C:\Users\aabad\.config\opencode\commands\new-project.md`

- [ ] **Step 1: Write the failing test or verification target**

Because the agent markdown is configuration-driven, use a CLI verification target instead of a unit test:

- `new-project.mjs` should emit provider-aware enrichment defaults in generated `.opencode/opencode.json`
- `enrich.md` should instruct the agent to respect the shared enrichment config instead of assuming Ollama-only

- [ ] **Step 2: Run verification to confirm current behavior is insufficient**

Run: generate a temp project via `node tools/project-memory-context/cli/new-project.mjs <tmp> --stage-b`
Expected: generated config lacks the new enrichment fallback structure.

- [ ] **Step 3: Write minimal implementation**

Update bootstrap to write an `enrichment` block such as:

```json
"enrichment": {
  "preferredModes": ["local-model", "cloud-api", "agent-subagent"],
  "localModel": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "deepseek-coder-v2:16b-ctx32k"
  },
  "cloudApi": {
    "provider": "openai-compatible",
    "baseUrl": "",
    "model": "",
    "apiKeyEnv": "PMC_CLOUD_API_KEY"
  },
  "agentSubagent": {
    "enabled": true,
    "agentName": "enrich"
  }
}
```

Update `enrich.md` to reference the shared fallback driver instead of assuming Ollama-only enrichment.

- [ ] **Step 4: Re-run verification**

Run: `node tools/project-memory-context/cli/new-project.mjs <tmp> --stage-b`
Expected: generated `.opencode/opencode.json` includes the new enrichment block.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 8: Update Docs and Run Final Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-05-17-pmc-enrichment-fallback-design.md` if implementation details changed
- Modify: any README or command docs touched during implementation

- [ ] **Step 1: Update docs to match final implementation**

Ensure all file names, config keys, and defaults match the actual code.

- [ ] **Step 2: Run full verification**

Run:

```bash
node --test tools/project-memory-context/tests/*.test.mjs
```

Expected: PASS.

Run:

```bash
cd agent-memory-mcp
npm test
```

Expected: PASS.

- [ ] **Step 3: Summarize manual verification**

Verify at least one scenario of each kind:

- local model available
- local model unavailable, cloud succeeds
- both unavailable, agent-subagent remains configured fallback

- [ ] **Step 4: Commit**

Skip commit in this workspace because it is not a git repository.
