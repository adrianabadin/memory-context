// T-013 REFACTOR — End-to-end system test for the PMC plugin capture wiring.
// Uses a temp-dir fixture with a real `.opencode/` layout, real buildHooks
// (real JSONL writes), and mocked spawn + runSessionStartRuntime so no real
// processes are launched. Verifies the full hook → queue path end to end.
//
// W3 NOTE (assistant messages): The current OpenCode hook API exposes
// `chat.message` for inbound messages and `tool.execute.after` for tool calls.
// Assistant/model response text is NOT reliably surfaced as a distinct,
// capturable event in the current hook contract, so capture of assistant
// responses is BEST-EFFORT only. The drainer's `processEntry` supports a
// `response` type for forward-compatibility, but the plugin does not synthesize
// `response` entries from the current hook API. This is documented, not a bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PMCPlugin } from '../plugin/index.mjs';

function makeFixture() {
  const root = join(tmpdir(), `pmc-e2e-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, '.opencode'), { recursive: true });
  mkdirSync(join(root, '.planning', 'project-memory-context', 'memory'), { recursive: true });
  // Mock memory.db (empty) — the real drainer would open it, but this test
  // mocks spawn so no drainer runs. The file exists to mirror a real project.
  writeFileSync(join(root, '.planning', 'project-memory-context', 'memory', 'memory.db'), '');
  return root;
}

function noopSpawn() {
  return () => 99999;
}
function noopStartup() {
  return async () => ({ hasPmc: true, projectRoot: null, warnings: [] });
}

test('E2E: PMCPlugin hooks populate the JSONL queue through the full path', async () => {
  const root = makeFixture();
  const queuePath = join(root, '.opencode', 'pmc-capture-queue.jsonl');
  try {
    const result = await PMCPlugin({
      projectRoot: root,
      sessionId: 'e2e-sess',
      projectId: 'e2e-proj',
      __testOverrides: {
        runSessionStartRuntime: noopStartup(),
        spawnBackground: noopSpawn(),
      },
    });

    // (4) hooks object has both functions
    assert.ok(result.hooks, 'plugin must return hooks');
    assert.equal(typeof result.hooks['chat.message'], 'function');
    assert.equal(typeof result.hooks['tool.execute.after'], 'function');

    // (5) fire chat.message
    result.hooks['chat.message']({ content: 'test prompt', role: 'user' });

    // (6) queue has 1 JSONL entry with correct structure
    assert.equal(existsSync(queuePath), true, 'queue file must exist after chat.message');
    let lines = readFileSync(queuePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'queue must have exactly 1 entry after one chat.message');
    const entry1 = JSON.parse(lines[0]);
    assert.equal(entry1.type, 'prompt');
    assert.equal(entry1.content, 'test prompt');
    assert.equal(entry1.sessionId, 'e2e-sess');
    assert.equal(entry1.projectId, 'e2e-proj');
    assert.equal(entry1.role, 'user');
    assert.equal(typeof entry1.ts, 'number');

    // (7) fire tool.execute.after
    result.hooks['tool.execute.after']({
      tool: 'test_tool',
      args: { file: 'foo.mjs' },
      result: 'ok',
      durationMs: 12,
      importance: 'normal',
    });

    // (8) queue has 2 entries
    lines = readFileSync(queuePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'queue must have exactly 2 entries after tool hook');
    const entry2 = JSON.parse(lines[1]);
    assert.equal(entry2.type, 'tool_call');
    assert.equal(entry2.toolName, 'test_tool');
    assert.equal(entry2.sessionId, 'e2e-sess');
    assert.equal(entry2.projectId, 'e2e-proj');
    assert.equal(entry2.resultSummary, 'ok');
    assert.equal(entry2.durationMs, 12);
    assert.equal(entry2.importance, 'normal');
    // argsSafe is a JSON string with the (sanitized) args object
    assert.equal(typeof entry2.argsSafe, 'string');
    assert.deepEqual(JSON.parse(entry2.argsSafe), { file: 'foo.mjs' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// W3: assistant responses are best-effort. This test documents that the current
// hook contract does not synthesize `response` entries — calling chat.message
// with role:'assistant' records a prompt-type entry, but no separate response
// capture path exists yet.
test('E2E (W3): assistant messages via chat.message are recorded as prompt-type entries (best-effort)', async () => {
  const root = makeFixture();
  const queuePath = join(root, '.opencode', 'pmc-capture-queue.jsonl');
  try {
    const result = await PMCPlugin({
      projectRoot: root,
      sessionId: 'e2e-w3',
      projectId: 'e2e-proj',
      __testOverrides: { runSessionStartRuntime: noopStartup(), spawnBackground: noopSpawn() },
    });
    // Simulate an assistant message arriving through chat.message.
    result.hooks['chat.message']({ content: 'assistant reply text', role: 'assistant' });
    const lines = readFileSync(queuePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    // Documented best-effort behavior: captured as a prompt entry with the
    // assistant role preserved. No `response`-type entry is synthesized by the
    // current hook API.
    assert.equal(entry.type, 'prompt');
    assert.equal(entry.role, 'assistant');
    assert.equal(entry.content, 'assistant reply text');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
