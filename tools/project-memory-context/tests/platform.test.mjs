import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSetupAgentType,
  isAgentInstructionFile,
  normalizeProjectPath,
  resolveConfigDirs,
  resolveGraphify,
  resolvePythonBin,
  spawnBackground,
} from '../src/platform.mjs';

test('detectSetupAgentType uses opencode when only global opencode config exists', () => {
  const agent = detectSetupAgentType('C:/repo', {
    exists: (candidate) => candidate.replace(/\\/g, '/').endsWith('/.config/opencode'),
    homeDir: 'C:/Users/alice',
  });

  assert.equal(agent, 'opencode');
});

test('detectSetupAgentType honours explicit requested agent', () => {
  const agent = detectSetupAgentType('C:/repo', {
    requestedAgent: 'opencode',
    exists: () => false,
    homeDir: 'C:/Users/alice',
  });

  assert.equal(agent, 'opencode');
});

test('normalizeProjectPath normalizes separators and dot segments', () => {
  assert.equal(normalizeProjectPath('C:\\repo\\docs\\..\\AGENTS.md'), 'C:/repo/AGENTS.md');
});

test('isAgentInstructionFile recognises supported agent rule files by basename', () => {
  assert.equal(isAgentInstructionFile('AGENTS.md'), true);
  assert.equal(isAgentInstructionFile('docs/CLAUDE.md'), true);
  assert.equal(isAgentInstructionFile('nested\\.cursorrules'), true);
  assert.equal(isAgentInstructionFile('README.md'), false);
});

test('resolveConfigDirs prefers .pmc over legacy config directories and falls back globally', () => {
  const dirs = resolveConfigDirs('C:/repo', {
    exists: (candidate) => {
      const normalized = candidate.replace(/\\/g, '/');
      return normalized.endsWith('.pmc') || normalized.endsWith('.opencode') || normalized.endsWith('alice/.claude');
    },
    homeDir: 'C:/Users/alice',
  });

  assert.match(dirs.projectConfig, /\.pmc$/);
  assert.match(dirs.globalConfig, /\.claude$/);
});

test('spawnBackground detaches, unreferences, and uses array args without shell', () => {
  const calls = [];
  let unrefCalled = false;

  const pid = spawnBackground('pmc', ['enrich'], {
    cwd: 'C:/repo',
    platform: 'win32',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        pid: 42,
        unref() {
          unrefCalled = true;
        },
      };
    },
  });

  assert.equal(pid, 42);
  assert.equal(unrefCalled, true);
  assert.deepEqual(calls, [{
    command: 'pmc',
    args: ['enrich'],
    options: {
      cwd: 'C:/repo',
      detached: true,
      stdio: 'ignore',
      shell: false,
    },
  }]);
});

test('resolvePythonBin prefers python3 on non-Windows when available', () => {
  const attempts = [];
  const pythonBin = resolvePythonBin({
    platform: 'linux',
    execFileSyncImpl: (command, args, options) => {
      attempts.push({ command, args, options });
    },
  });

  assert.equal(pythonBin, 'python3');
  assert.deepEqual(attempts, [{
    command: 'python3',
    args: ['--version'],
    options: { stdio: 'ignore' },
  }]);
});

test('resolvePythonBin falls back to py launcher on Windows when python is unavailable', () => {
  const attempts = [];
  const pythonBin = resolvePythonBin({
    platform: 'win32',
    execFileSyncImpl: (command, args, options) => {
      attempts.push({ command, args, options });
      if (command === 'python') {
        throw new Error('missing python');
      }
    },
  });

  assert.equal(pythonBin, 'py');
  assert.deepEqual(attempts, [
    {
      command: 'python',
      args: ['--version'],
      options: { stdio: 'ignore' },
    },
    {
      command: 'py',
      args: ['--version'],
      options: { stdio: 'ignore' },
    },
  ]);
});

test('resolveGraphify honors env override before command lookup', () => {
  assert.equal(resolveGraphify({ env: { PMC_GRAPHIFY_PATH: '/opt/graphify' } }), '/opt/graphify');
  assert.equal(resolveGraphify({ env: { PMC_GRAPHIFY_BIN: 'custom-graphify' } }), 'custom-graphify');
});

test('resolveGraphify finds the first discovered executable path', () => {
  const graphify = resolveGraphify({
    platform: 'linux',
    env: {},
    execFileSyncImpl: (command, args, options) => {
      assert.equal(command, 'which');
      assert.deepEqual(args, ['graphify']);
      assert.deepEqual(options, { encoding: 'utf8' });
      return '/usr/local/bin/graphify\n/usr/bin/graphify\n';
    },
  });

  assert.equal(graphify, '/usr/local/bin/graphify');
});

test('resolveGraphify throws a portable install hint when not found', () => {
  assert.throws(
    () => resolveGraphify({
      env: {},
      execFileSyncImpl() {
        throw new Error('missing');
      },
    }),
    /PMC_GRAPHIFY_PATH.*PMC_GRAPHIFY_BIN|PMC_GRAPHIFY_BIN.*PMC_GRAPHIFY_PATH/i,
  );
});
