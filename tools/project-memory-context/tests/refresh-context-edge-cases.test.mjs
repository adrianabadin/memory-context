import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { refreshContext } from '../cli/refresh-context.mjs';

let counter = 0;
function tmp(label) {
  return join(tmpdir(), `pmc-edge-${++counter}-${label}`);
}

async function setupDirs(t) {
  const dirs = {
    base: t,
    enrichment: join(t, '.planning', 'project-memory-context', 'enrichment'),
    graph: join(t, '.planning', 'project-memory-context', 'graph'),
    src: join(t, 'src'),
  };
  await mkdir(dirs.enrichment, { recursive: true });
  await mkdir(dirs.graph, { recursive: true });
  await mkdir(dirs.src, { recursive: true });
  return dirs;
}

async function writeSrc(t, relPath, content) {
  const full = join(t, 'src', relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

async function assertWorklist(T, fn) {
  const raw = await readFile(join(T, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'), 'utf8');
  const wl = JSON.parse(raw);
  fn(wl);
}

// ---------------------------------------------------------------------------
// 1. Empty project — no source files
// ---------------------------------------------------------------------------
test('1. Empty project — no source files', async () => {
  const T = tmp('empty');
  await setupDirs(T);
  const result = await refreshContext(T);
  assert.equal(result.total, 0, 'no files at all');
  assert.equal(result.added, 0);
  assert.equal(result.modified, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.newSymbols, 0);
  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 2. Only non-tracked files
// ---------------------------------------------------------------------------
test('2. Only non-tracked files (README.md, notes.txt)', async () => {
  const T = tmp('nontracked');
  await setupDirs(T);
  await writeSrc(T, 'README.md', '# Readme\n');
  await writeSrc(T, 'notes.txt', 'hello\n');
  const result = await refreshContext(T);
  assert.equal(result.total, 0, 'non-tracked extensions ignored');
  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 3. File with no extractable symbols (comments only)
// ---------------------------------------------------------------------------
test('3. Tracked file with no extractable symbols', async () => {
  const T = tmp('no-symbols');
  await setupDirs(T);
  await writeSrc(T, 'empty.mjs', '// just a comment\n/* block */\n');
  const result = await refreshContext(T);
  assert.equal(result.total, 1, 'file is tracked and detected as added');
  assert.equal(result.newSymbols, 0, 'no symbols extracted');
  await assertWorklist(T, (wl) => {
    assert.equal(wl.length, 0, 'worklist empty — no symbols');
  });
  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 4. Deeply nested source file is tracked
// ---------------------------------------------------------------------------
test('4. Deeply nested source file tracked', async () => {
  const T = tmp('deep');
  await setupDirs(T);
  await writeSrc(T, 'a/b/c/d/deep.mjs', "export function deep() { return 'deep'; }\n");
  const result = await refreshContext(T);
  assert.equal(result.total, 1);
  await assertWorklist(T, (wl) => {
    assert.equal(wl.length, 1);
    assert.equal(wl[0].name, 'deep');
    assert.equal(wl[0].filePath, 'src/a/b/c/d/deep.mjs');
  });
  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 5. Unicode/emoji in function body
// ---------------------------------------------------------------------------
test('5. Unicode/emoji in function body', async () => {
  const T = tmp('unicode');
  await setupDirs(T);
  await writeSrc(T, 'unicode.mjs', "export function emojiTest() { const x = 'café 🎉'; return x; }\n");
  const result = await refreshContext(T);
  assert.equal(result.total, 1);
  await assertWorklist(T, (wl) => {
    assert.equal(wl.length, 1);
    assert.equal(wl[0].name, 'emojiTest');
  });
  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 6. Empty file (0 bytes)
// ---------------------------------------------------------------------------
test('6. Empty file (0 bytes)', async () => {
  const T = tmp('zero-byte');
  await setupDirs(T);
  await writeSrc(T, 'empty.mjs', '');
  const result = await refreshContext(T);
  assert.equal(result.total, 1, 'empty file still tracked by hash');
  assert.equal(result.newSymbols, 0, 'no symbols extracted from empty file');
  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 7. Multiple symbols in file, only one changes
// ---------------------------------------------------------------------------
test('7. Multiple symbols — only one changes', async () => {
  const T = tmp('multi');
  await setupDirs(T);

  const run1 = `export function funcA() { return 'A'; }
export function funcB() { return 'B'; }
`;
  await writeSrc(T, 'multi.mjs', run1);

  const r1 = await refreshContext(T);
  assert.equal(r1.total, 1, 'file added');
  assert.equal(r1.newSymbols, 2, 'both symbols new');

  const run2 = `export function funcA() { return 'A-changed'; }
export function funcB() { return 'B'; }
`;
  await writeSrc(T, 'multi.mjs', run2);

  const r2 = await refreshContext(T);
  assert.equal(r2.total, 1, 'one file modified');
  assert.equal(r2.modified, 1);
  assert.equal(r2.staleSymbols, 1, 'funcA stale');
  assert.equal(r2.newSymbols, 0, 'no new symbols');
  assert.equal(r2.removedSymbols, 0);

  await assertWorklist(T, (wl) => {
    const funcA = wl.find(e => e.name === 'funcA');
    const funcB = wl.find(e => e.name === 'funcB');
    assert.ok(funcA, 'funcA in worklist');
    assert.ok(funcB, 'funcB in worklist');
    assert.equal(funcA.status, 'stale', 'funcA stale');
    assert.ok(funcB.status !== 'stale', 'funcB not stale');
  });

  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 8. File renamed (same content, different path)
// ---------------------------------------------------------------------------
test('8. File renamed — same content, different path', async () => {
  const T = tmp('rename');
  await setupDirs(T);

  const content = 'export function keep() { return 1; }\n';
  await writeSrc(T, 'old.mjs', content);

  // Run 1: establish
  const r1 = await refreshContext(T);
  assert.equal(r1.total, 1, 'first run: file added');
  assert.equal(r1.newSymbols, 1);

  // Delete old, create new with same content
  await rm(join(T, 'src', 'old.mjs'));
  await writeSrc(T, 'new.mjs', content);

  const r2 = await refreshContext(T);
  assert.equal(r2.total, 2, 'one removed + one added');
  assert.equal(r2.removed, 1, 'old path removed');
  assert.equal(r2.added, 1, 'new path added');
  assert.equal(r2.newSymbols, 1, 'symbol from new path is new');
  assert.equal(r2.removedSymbols, 1, 'symbol from old path is removed');

  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 9. Symbol deleted from file (file still exists)
// ---------------------------------------------------------------------------
test('9. Symbol deleted from file, file still exists', async () => {
  const T = tmp('shrink');
  await setupDirs(T);

  await writeSrc(T, 'shrink.mjs', `export function keepMe() { return 1; }
export function deleteMe() { return 2; }
`);

  const r1 = await refreshContext(T);
  assert.equal(r1.total, 1);
  assert.equal(r1.newSymbols, 2);

  await writeSrc(T, 'shrink.mjs', `export function keepMe() { return 1; }
`);

  const r2 = await refreshContext(T);
  assert.equal(r2.total, 1, 'file modified');
  assert.equal(r2.modified, 1);
  assert.equal(r2.removedSymbols, 1, 'deleteMe removed');
  assert.equal(r2.staleSymbols, 0);

  await assertWorklist(T, (wl) => {
    const keep = wl.find(e => e.name === 'keepMe');
    assert.ok(keep, 'keepMe still in worklist');
    const del = wl.find(e => e.name === 'deleteMe');
    assert.equal(del, undefined, 'deleteMe NOT in worklist');
  });

  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 10. Corrupt worklist.json
// ---------------------------------------------------------------------------
test('10. Corrupt worklist.json', async () => {
  const T = tmp('corrupt-wl');
  await setupDirs(T);
  await writeSrc(T, 'app.mjs', 'export function foo() { return 1; }\n');

  await writeFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'),
    '{ not an array }',
    'utf-8',
  );

  await assert.rejects(
    () => refreshContext(T),
    /Unexpected token|JSON/,
    'readJsonArtifact throws on non-ENOENT errors (corrupt JSON is not handled)',
  );

  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 11. Corrupt hash-store.json
// ---------------------------------------------------------------------------
test('11. Corrupt hash-store.json — survives gracefully', async () => {
  const T = tmp('corrupt-hs');
  await setupDirs(T);
  await writeSrc(T, 'app.mjs', 'export function bar() { return 42; }\n');

  await writeFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json'),
    'not json',
    'utf-8',
  );

  const result = await refreshContext(T);
  assert.equal(result.total, 1, 'file detected as added when hash store is corrupt');
  assert.equal(result.newSymbols, 1);

  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 12. Multiple files changed simultaneously
// ---------------------------------------------------------------------------
test('12. Multiple files changed simultaneously', async () => {
  const T = tmp('multi-file');
  await setupDirs(T);

  await writeSrc(T, 'a.mjs', 'export function a() { return 1; }\n');
  await writeSrc(T, 'b.mjs', 'export function b() { return 2; }\n');

  await refreshContext(T);

  await writeSrc(T, 'a.mjs', 'export function a() { return 11; }\n');
  await writeSrc(T, 'b.mjs', 'export function b() { return 22; }\n');

  const r2 = await refreshContext(T);
  assert.equal(r2.total, 2, 'two files modified');
  assert.equal(r2.modified, 2);
  assert.equal(r2.added, 0);

  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 13. Whitespace changes outside symbol range — codeHash unchanged
// ---------------------------------------------------------------------------
test('13. Whitespace/comment changes outside symbol range', async () => {
  const T = tmp('whitespace');
  await setupDirs(T);

  await writeSrc(T, 'stable.mjs', `export function foo() { return 'same'; }
`);

  await refreshContext(T);

  // Add a comment BEFORE the function (file hash changes, symbol body doesn't)
  await writeSrc(T, 'stable.mjs', `// this is a new comment added before the function
export function foo() { return 'same'; }
`);

  const r2 = await refreshContext(T);
  assert.equal(r2.total, 1, 'file detected as modified');
  assert.equal(r2.modified, 1);
  assert.equal(r2.staleSymbols, 0, 'codeHash unchanged — not stale');

  await assertWorklist(T, (wl) => {
    const entry = wl.find(e => e.name === 'foo');
    assert.ok(entry, 'foo still in worklist');
    assert.ok(entry.status !== 'stale', 'foo not stale');
  });

  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 14. Idempotency — two consecutive runs with no changes
// ---------------------------------------------------------------------------
test('14. Idempotency — two consecutive runs', async () => {
  const T = tmp('idem');
  await setupDirs(T);

  await writeSrc(T, 'id.mjs', 'export function id() { return 1; }\n');

  const r1 = await refreshContext(T);
  assert.equal(r1.total, 1, 'first run: file added');

  const r2 = await refreshContext(T);
  assert.equal(r2.total, 0, 'second run: no changes');
  assert.equal(r2.added, 0);
  assert.equal(r2.modified, 0);
  assert.equal(r2.removed, 0);
  assert.equal(r2.newSymbols, 0);
  assert.equal(r2.staleSymbols, 0);

  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 15. Non-ASCII file path characters
// ---------------------------------------------------------------------------
test('15. Non-ASCII file path characters', async () => {
  const T = tmp('unicode-path');
  await setupDirs(T);

  await writeSrc(T, 'file-with-español.mjs', "export function hola() { return 'mundo'; }\n");

  const result = await refreshContext(T);
  assert.equal(result.total, 1, 'file tracked');
  await assertWorklist(T, (wl) => {
    assert.equal(wl.length, 1);
    assert.equal(wl[0].name, 'hola');
    assert.ok(wl[0].filePath.includes('español'), 'filePath preserves unicode characters');
  });
  await rm(T, { recursive: true });
});

// ---------------------------------------------------------------------------
// 16. trySyncProjectToGlobal does not hang when MCP connect stalls
// ---------------------------------------------------------------------------
test('16. trySyncProjectToGlobal times out when MCP connect never resolves', async () => {
  const T = tmp('sync-stall');
  await setupDirs(T);

  // Provide a valid .mcp.json so the function proceeds to the client step.
  await writeFile(
    join(T, '.mcp.json'),
    JSON.stringify({
      mcpServers: { 'agent-memory': { command: 'node', args: ['fake.js'] } },
    }),
    'utf-8',
  );

  // Fake client whose connect() never resolves. This simulates a stalled
  // agent-memory MCP handshake — the exact production failure mode that
  // previously blocked refresh indefinitely.
  let connectCalls = 0;
  const stallingClient = {
    connect: () => { connectCalls++; return new Promise(() => {}); },
    callTool: async () => { throw new Error('should not reach callTool while connect is stalled'); },
    close: async () => {},
  };

  const { trySyncProjectToGlobal } = await import('../cli/refresh-context.mjs');
  const dirs = {
    enrichment: join(T, '.planning', 'project-memory-context', 'enrichment'),
    graph: join(T, '.planning', 'project-memory-context', 'graph'),
    projectContextMarkdown: join(T, '.planning', 'project-memory-context', 'project-context', 'markdown'),
  };

  const start = Date.now();
  await trySyncProjectToGlobal(T, dirs, { timeoutMs: 250, client: stallingClient });
  const elapsed = Date.now() - start;

  assert.equal(connectCalls, 1, 'connect must be attempted exactly once');
  assert.ok(elapsed < 5_000, `must return promptly, took ${elapsed}ms`);
  await rm(T, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 17. trySyncProjectToGlobal succeeds when MCP client is fast
// ---------------------------------------------------------------------------
test('17. trySyncProjectToGlobal completes quickly with a fast fake client', async () => {
  const T = tmp('sync-fast');
  await setupDirs(T);

  await writeFile(
    join(T, '.mcp.json'),
    JSON.stringify({
      mcpServers: { 'agent-memory': { command: 'node', args: ['fake.js'] } },
    }),
    'utf-8',
  );

  const callOrder = [];
  const fastClient = {
    connect: async () => { callOrder.push('connect'); },
    callTool: async ({ name }) => { callOrder.push(name); return {}; },
    close: async () => { callOrder.push('close'); },
  };

  const { trySyncProjectToGlobal } = await import('../cli/refresh-context.mjs');
  const dirs = {
    enrichment: join(T, '.planning', 'project-memory-context', 'enrichment'),
    graph: join(T, '.planning', 'project-memory-context', 'graph'),
    projectContextMarkdown: join(T, '.planning', 'project-memory-context', 'project-context', 'markdown'),
  };

  const start = Date.now();
  await trySyncProjectToGlobal(T, dirs, { timeoutMs: 2_000, client: fastClient });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2_000, `fast sync should complete quickly, took ${elapsed}ms`);
  assert.ok(callOrder.includes('connect'), 'connect must be called');
  assert.ok(callOrder.includes('register_project'), 'register_project must be called');
  assert.ok(callOrder.includes('sync_project_metadata'), 'sync_project_metadata must be called');
  assert.ok(callOrder.includes('close'), 'client must be closed');
  await rm(T, { recursive: true, force: true });
});
