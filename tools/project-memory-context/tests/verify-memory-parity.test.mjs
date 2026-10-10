import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '..', 'cli', 'verify-memory-parity.mjs');

async function createProjectFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-parity-'));
  const planningDir = join(projectRoot, '.planning', 'project-memory-context');
  await mkdir(planningDir, { recursive: true });
  return { projectRoot, planningDir };
}

/**
 * Run the CLI with a forced-empty PATH so the `engram` probe always fails,
 * guaranteeing the deterministic "pmc-only" path and exit code 0.
 */
async function runCli(args, projectRoot) {
  const env = {
    ...process.env,
    PATH: '',
    Path: '',
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, projectRoot, ...args],
      { env },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('verify-memory-parity --help exits 0 and shows usage', async () => {
  const { code, stdout } = await runCli(['--help'], process.cwd());
  assert.equal(code, 0);
  assert.match(stdout, /Usage: pmc verify-memory-parity/);
  assert.match(stdout, /--window-minutes/);
});

test('verify-memory-parity reports pmc-only when engram unavailable (exit 0)', async () => {
  const { projectRoot, planningDir } = await createProjectFixture();
  await writeFile(
    join(planningDir, 'install.json'),
    JSON.stringify({ memoryDbPath: join(planningDir, 'memory-db') }),
  );

  const { code, stdout } = await runCli(['--json'], projectRoot);
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.command, 'verify-memory-parity');
  assert.equal(report.parity, 'pmc-only');
  assert.equal(report.engram.reachable, false);
});

test('verify-memory-parity respects --window-minutes', async () => {
  const { projectRoot, planningDir } = await createProjectFixture();
  await writeFile(
    join(planningDir, 'install.json'),
    JSON.stringify({ memoryDbPath: join(planningDir, 'memory-db') }),
  );

  const { code, stdout } = await runCli(['--window-minutes', '1', '--json'], projectRoot);
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.windowMinutes, 1);
});

test('verify-memory-parity human report lists both backends', async () => {
  const { projectRoot, planningDir } = await createProjectFixture();
  await writeFile(
    join(planningDir, 'install.json'),
    JSON.stringify({ memoryDbPath: join(planningDir, 'memory-db') }),
  );

  const { code, stdout } = await runCli([], projectRoot);
  assert.equal(code, 0);
  assert.match(stdout, /Memory Parity Report/);
  assert.match(stdout, /PMC/);
  assert.match(stdout, /Engram/);
});
