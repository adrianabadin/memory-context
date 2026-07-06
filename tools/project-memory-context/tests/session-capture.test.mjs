import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildHooks,
  appendToQueue,
  sanitizeContent,
  sanitizeArgs,
} from '../src/session-capture.mjs';

const tmp = join(tmpdir(), `pmc-capture-test-${process.pid}`);
const queuePath = join(tmp, 'pmc-capture-queue.jsonl');

function resetQueue() {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
}

test('buildHooks() returns chat.message and tool.execute.after hook functions', () => {
  const hooks = buildHooks('sess-1', 'proj-1', queuePath);
  assert.equal(typeof hooks['chat.message'], 'function');
  assert.equal(typeof hooks['tool.execute.after'], 'function');
});

test('appendToQueue() creates JSONL file on first write, each line is valid JSON', () => {
  resetQueue();
  appendToQueue(queuePath, { type: 'prompt', ts: 1, content: 'hello' });
  appendToQueue(queuePath, { type: 'prompt', ts: 2, content: 'world' });
  assert.equal(existsSync(queuePath), true);
  const lines = readFileSync(queuePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'prompt', ts: 1, content: 'hello' });
  assert.deepEqual(JSON.parse(lines[1]), { type: 'prompt', ts: 2, content: 'world' });
  resetQueue();
});

test('sanitizeContent() strips <private>...</private> to [REDACTED]', () => {
  const out = sanitizeContent('before <private>secret data</private> after');
  assert.equal(out, 'before [REDACTED] after');
});

test('sanitizeArgs() masks bearer tokens, api_key, and password fields', () => {
  const safe = sanitizeArgs({
    url: 'https://api.example.com',
    headers: { authorization: 'Bearer abc123' },
    api_key: 'sk-live-999',
    password: 'hunter2',
    publicField: 'ok',
  });
  const parsed = JSON.parse(safe);
  assert.equal(parsed.publicField, 'ok');
  assert.equal(parsed.url, 'https://api.example.com');
  assert.equal(parsed.headers.authorization, '***REDACTED***');
  assert.equal(parsed.api_key, '***REDACTED***');
  assert.equal(parsed.password, '***REDACTED***');
});

test('Queue rotation at >=1MB renames old file and starts fresh', () => {
  resetQueue();
  mkdirSync(tmp, { recursive: true });
  // Pre-fill queue file to exactly 1MB boundary (>= 1MB triggers rotation)
  writeFileSync(queuePath, 'x'.repeat(1_048_576));
  const beforeSize = statSync(queuePath).size;
  assert.ok(beforeSize >= 1_048_576);

  appendToQueue(queuePath, { type: 'prompt', ts: 99, content: 'rotated' });

  // Old file renamed to pmc-capture-queue.{ts}.jsonl
  const rotatedFiles = readdirSync(tmp).filter(
    (f) => f.startsWith('pmc-capture-queue.') && f.endsWith('.jsonl') && f !== 'pmc-capture-queue.jsonl'
  );
  assert.ok(rotatedFiles.length >= 1, 'expected a rotated archive file');
  // New queue file exists and is fresh (small, contains only the new event)
  assert.equal(existsSync(queuePath), true);
  const newLines = readFileSync(queuePath, 'utf8').trim().split('\n');
  assert.equal(newLines.length, 1);
  assert.equal(JSON.parse(newLines[0]).content, 'rotated');
  resetQueue();
});

test('Hook payloads match expected schema for prompt and tool_call', () => {
  resetQueue();
  const hooks = buildHooks('sess-2', 'proj-2', queuePath);
  hooks['chat.message']({ content: 'hi <private>x</private>', role: 'user' });
  hooks['tool.execute.after']({
    tool: 'shell',
    args: { cmd: 'ls', password: 'pw' },
    result: 'file1\nfile2',
    durationMs: 12,
  });

  const lines = readFileSync(queuePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);

  const prompt = JSON.parse(lines[0]);
  assert.equal(prompt.type, 'prompt');
  assert.equal(typeof prompt.ts, 'number');
  assert.equal(prompt.sessionId, 'sess-2');
  assert.equal(prompt.projectId, 'proj-2');
  assert.equal(prompt.content, 'hi [REDACTED]');
  assert.equal(prompt.role, 'user');

  const toolCall = JSON.parse(lines[1]);
  assert.equal(toolCall.type, 'tool_call');
  assert.equal(typeof toolCall.ts, 'number');
  assert.equal(toolCall.sessionId, 'sess-2');
  assert.equal(toolCall.projectId, 'proj-2');
  assert.equal(toolCall.toolName, 'shell');
  assert.equal(typeof toolCall.argsSafe, 'string');
  const args = JSON.parse(toolCall.argsSafe);
  assert.equal(args.cmd, 'ls');
  assert.equal(args.password, '***REDACTED***');
  assert.equal(typeof toolCall.resultSummary, 'string');
  assert.equal(toolCall.durationMs, 12);
  assert.equal(toolCall.importance, 'normal');
  resetQueue();
});

// --- T-006 REFACTOR: edge cases ---

test('Append succeeds when queue file is exactly at the 1MB boundary', () => {
  resetQueue();
  mkdirSync(tmp, { recursive: true });
  writeFileSync(queuePath, 'x'.repeat(1_048_576));
  assert.equal(statSync(queuePath).size, 1_048_576);
  appendToQueue(queuePath, { type: 'prompt', ts: 1, content: 'boundary' });
  // Exactly 1MB is >= threshold -> rotation fires; new file holds the new entry
  const newLines = readFileSync(queuePath, 'utf8').trim().split('\n');
  assert.equal(newLines.length, 1);
  assert.equal(JSON.parse(newLines[0]).content, 'boundary');
  resetQueue();
});

test('Nil/null projectId falls back to unknown', () => {
  resetQueue();
  const hooks = buildHooks('sess-3', null, queuePath);
  hooks['chat.message']({ content: 'msg' });
  const line = JSON.parse(readFileSync(queuePath, 'utf8').trim());
  assert.equal(line.projectId, 'unknown');
  assert.equal(line.sessionId, 'sess-3');
  resetQueue();
});

test('Deeply nested secrets in tool args are still redacted', () => {
  const safe = sanitizeArgs({
    level1: { level2: { level3: { api_key: 'deep-secret', keep: 'visible' } } },
    list: [{ token: 'tok-1' }, { normal: 'ok' }],
  });
  const parsed = JSON.parse(safe);
  assert.equal(parsed.level1.level2.level3.api_key, '***REDACTED***');
  assert.equal(parsed.level1.level2.level3.keep, 'visible');
  assert.equal(parsed.list[0].token, '***REDACTED***');
  assert.equal(parsed.list[1].normal, 'ok');
});

test('Rotation filename is deterministic and timestamp-based', () => {
  resetQueue();
  mkdirSync(tmp, { recursive: true });
  writeFileSync(queuePath, 'x'.repeat(1_048_576));
  const before = Date.now();
  appendToQueue(queuePath, { type: 'prompt', ts: 0, content: 'rotate' });
  const after = Date.now();
  const rotated = readdirSync(tmp).find(
    (f) => /^pmc-capture-queue\.\d+\.jsonl$/.test(f)
  );
  assert.ok(rotated, 'expected a timestamp-suffixed rotated file matching pmc-capture-queue.<digits>.jsonl');
  const ts = Number(rotated.match(/pmc-capture-queue\.(\d+)\.jsonl/)[1]);
  assert.ok(ts >= before && ts <= after, 'rotation timestamp falls within the append window');
  resetQueue();
});

test('sanitizeContent with no <private> tags passes through unchanged', () => {
  const text = 'just a normal message with no redactions needed';
  assert.equal(sanitizeContent(text), text);
});

