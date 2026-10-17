import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

import { writeAtomic } from '../../src/config-merge/atomic-write.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pmc-atomic-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('writeAtomic writes data atomically to target file creating parent directories', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'nested', 'deep', 'config.json');
    const content = JSON.stringify({ hello: 'world' }, null, 2) + '\n';

    await writeAtomic(filePath, content);

    const actual = await readFile(filePath, 'utf8');
    assert.equal(actual, content);
  });
});

test('writeAtomic retries on simulated Windows EPERM/EBUSY rename error', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'retry-target.txt');
    const content = 'retry content\n';

    let attempts = 0;
    const fakeRename = async (tmpPath, targetPath) => {
      attempts++;
      if (attempts < 3) {
        const err = new Error('Permission denied / busy');
        err.code = attempts === 1 ? 'EPERM' : 'EBUSY';
        throw err;
      }
      const { rename } = await import('node:fs/promises');
      return rename(tmpPath, targetPath);
    };

    await writeAtomic(filePath, content, { renameImpl: fakeRename, retryDelayMs: 1 });

    assert.equal(attempts, 3);
    const actual = await readFile(filePath, 'utf8');
    assert.equal(actual, content);
  });
});

test('writeAtomic cleans up temp file when rename permanently fails after bounded retries', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'fail-target.txt');
    const content = 'fail content\n';

    let lastTmpPath = null;
    const failingRename = async (tmpPath, targetPath) => {
      lastTmpPath = tmpPath;
      const err = new Error('Permission denied permanently');
      err.code = 'EPERM';
      throw err;
    };

    await assert.rejects(
      async () => {
        await writeAtomic(filePath, content, {
          renameImpl: failingRename,
          maxRetries: 2,
          retryDelayMs: 1,
        });
      },
      (err) => err.code === 'EPERM',
    );

    assert.ok(lastTmpPath, 'rename should have been attempted');
    await assert.rejects(
      async () => stat(lastTmpPath),
      (err) => err.code === 'ENOENT',
      'temp file should be unlinked on permanent rename failure',
    );
  });
});
