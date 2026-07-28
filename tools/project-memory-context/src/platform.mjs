import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { CLIENT_MARKERS } from './clients/markers.mjs';

const PROJECT_DIR_NAMES = ['.pmc', '.opencode', '.claude', '.cursor'];
const INSTRUCTION_FILES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
]);

export function normalizeProjectPath(filePath) {
  if (filePath === '') return '';
  // Converts backslashes to forward slashes and resolves . / .. segments.
  // posix.normalize preserves meaningful spaces.
  return posix.normalize(String(filePath).replace(/\\/g, '/'));
}

export function isAgentInstructionFile(filePath) {
  const normalizedPath = normalizeProjectPath(filePath);
  return INSTRUCTION_FILES.has(normalizedPath.split('/').at(-1));
}

const DETECT_PRIORITY = [
  { agent: 'opencode', markers: CLIENT_MARKERS.opencode },
  { agent: 'claude-code', markers: CLIENT_MARKERS['claude-code'] },
  { agent: 'cursor', markers: CLIENT_MARKERS.cursor },
  { agent: 'antigravity', markers: CLIENT_MARKERS.antigravity },
];

export function detectAgentType(projectRoot) {
  for (const { agent, markers } of DETECT_PRIORITY) {
    for (const markerDir of markers.project) {
      if (existsSync(join(projectRoot, markerDir))) return agent;
    }
    for (const markerFile of markers.instructionFiles) {
      if (existsSync(join(projectRoot, markerFile))) return agent;
    }
  }
  return 'generic';
}

export function detectSetupAgentType(projectRoot, options = {}) {
  if (options.requestedAgent) return options.requestedAgent;

  const projectAgent = detectAgentType(projectRoot);
  if (projectAgent !== 'generic') return projectAgent;

  const exists = options.exists ?? existsSync;
  const homeDir = options.homeDir ?? homedir();
  if (exists(join(homeDir, '.config', 'opencode'))) return 'opencode';

  return projectAgent;
}

export function resolveConfigDirs(projectRoot = process.cwd(), options = {}) {
  const root = resolve(projectRoot);
  const exists = options.exists ?? existsSync;
  const homeDir = options.homeDir ?? homedir();

  const projectConfig = PROJECT_DIR_NAMES
    .map((name) => join(root, name))
    .find((candidate) => exists(candidate)) ?? join(root, '.pmc');

  const globalConfig = [
    join(homeDir, '.config', 'pmc'),
    join(homeDir, '.config', 'opencode'),
    join(homeDir, '.claude'),
  ].find((candidate) => exists(candidate)) ?? join(homeDir, '.config', 'pmc');

  return {
    projectRoot: root,
    projectConfig,
    globalConfig,
    projectConfigDir: projectConfig,
    globalConfigDir: globalConfig,
  };
}

export function spawnBackground(command, args = [], options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  // Always use array-form args (never shell: true with a concatenated string)
  // so paths containing spaces are passed correctly on all platforms.
  const child = spawnImpl(command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    shell: false,
  });

  child.unref();
  return child.pid;
}

export function resolvePythonBin(options = {}) {
  const platform = options.platform ?? process.platform;
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;

  if (platform === 'win32') {
    try {
      execFileSyncImpl('python', ['--version'], { stdio: 'ignore' });
      return 'python';
    } catch {
      try {
        execFileSyncImpl('py', ['--version'], { stdio: 'ignore' });
        return 'py';
      } catch {
        return 'python';
      }
    }
  }

  try {
    execFileSyncImpl('python3', ['--version'], { stdio: 'ignore' });
    return 'python3';
  } catch {
    return 'python';
  }
}

export function resolveGraphify(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;

  if (env.PMC_GRAPHIFY_PATH) {
    return env.PMC_GRAPHIFY_PATH;
  }

  if (env.PMC_GRAPHIFY_BIN) {
    return env.PMC_GRAPHIFY_BIN;
  }

  const finder = platform === 'win32' ? 'where' : 'which';

  try {
    return execFileSyncImpl(finder, ['graphify'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {
    throw new Error('graphify not found. Install it with `pip install graphifyy` or set PMC_GRAPHIFY_PATH or PMC_GRAPHIFY_BIN.');
  }
}
