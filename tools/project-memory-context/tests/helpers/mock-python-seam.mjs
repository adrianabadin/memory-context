/**
 * Test-only controlled hermetic boundary for bootstrap integration tests.
 *
 * Provides a controlled in-process and subprocess boundary for PMC bootstrap tests:
 * - Mutates node:child_process exports and syncBuiltinESMExports for named imports ONLY
 *   when running inside an isolated child/grandchild process with valid isolation marker.
 * - Leaves parent test runner completely side-effect-free on import.
 * - Fakes/logs Python probe (--version) and pip-install calls to a sentinel log in-seam.
 * - Fakes/denies graphify executions without host binaries.
 * - Allows only exact canonical Node scripts from pinned allowlist (checkout CLI,
 *   packageSandbox CLI, registered test fixtures).
 * - Sibling paths and path-prefix tricks are strictly rejected before execute.
 * - Arbitrary -e/--eval and unknown options are rejected before execute.
 * - Fails closed on direct external launcher calls without host execution.
 * - Blocks outbound network interfaces (node:net, node:http, node:https, node:http2, node:dns, fetch, dgram).
 * - Isolates HOME, USERPROFILE, APPDATA, LOCALAPPDATA, and XDG roots from host.
 */

import cp from 'node:child_process';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, basename, dirname, sep, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helperPath = fileURLToPath(import.meta.url);
const helperDir = dirname(helperPath);
const packageRoot = resolve(helperDir, '..', '..');
const repoRoot = resolve(packageRoot, '..', '..');
const checkoutCliDir = resolve(packageRoot, 'cli');

const origSpawn = cp.spawn;
const origSpawnSync = cp.spawnSync;
const origExecFile = cp.execFile;
const origExecFileSync = cp.execFileSync;
const origExec = cp.exec;
const origExecSync = cp.execSync;
const origFork = cp.fork;
const origHomedir = os.homedir;

export const ALLOWED_PMC_SCRIPTS = new Set([
  'bootstrap.mjs',
  'new-project.mjs',
  'build-worklist.mjs',
  'project-context.mjs',
  'enrich-queue.mjs',
]);

export function isSamePath(a, b) {
  if (!a || !b) return false;
  const normA = resolve(a);
  const normB = resolve(b);
  if (process.platform === 'win32') {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
}

export function isPathContained(child, parentDir) {
  if (!child || !parentDir) return false;
  const normChild = resolve(child);
  const normParent = resolve(parentDir);
  const c = process.platform === 'win32' ? normChild.toLowerCase() : normChild;
  const p = process.platform === 'win32' ? normParent.toLowerCase() : normParent;
  if (c === p) return true;
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(prefix);
}

export class SimpleMockChild extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pid = options.pid || 12345;
    this.killed = false;
    queueMicrotask(() => {
      if (options.error) {
        this.emit('error', options.error);
      } else {
        this.emit('exit', options.exitCode ?? 0, options.signalCode ?? null);
        this.emit('close', options.exitCode ?? 0, options.signalCode ?? null);
      }
    });
  }

  kill() {
    this.killed = true;
    return true;
  }

  unref() {
    return this;
  }

  ref() {
    return this;
  }
}

function logIntent(entry, explicitLogFile = null) {
  const logFile = explicitLogFile || process.env.PMC_TEST_SENTINEL_LOG;
  if (!logFile) return;
  try {
    const record = {
      ...entry,
      timestamp: Date.now(),
      pid: process.pid,
    };
    appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // Best effort logging inside test fixture
  }
}

function classifyCommand(command, args = []) {
  if (!command) return 'UNKNOWN';
  const str = String(command).trim();
  const base = basename(str).toLowerCase().replace(/\.exe$/, '');
  const argList = Array.isArray(args) ? args.map(String) : [];

  if (['python', 'python3', 'py'].includes(base)) {
    if (argList.some((a) => ['--version', '-V', '-v'].includes(a))) {
      return 'PYTHON_PROBE';
    }
    if (argList.includes('pip') || (argList.includes('-m') && argList.includes('pip'))) {
      return 'PIP_INSTALL';
    }
    return 'PYTHON_PROBE';
  }

  if (['pip', 'pip3'].includes(base)) {
    return 'PIP_INSTALL';
  }

  if (str.includes('my-custom-graphify-bin') || base === 'graphify' || str.includes('graphify')) {
    return 'GRAPHIFY';
  }

  if (['where', 'which'].includes(base)) {
    if (argList.some((a) => a.includes('graphify'))) {
      return 'FINDER_GRAPHIFY';
    }
    return 'UNKNOWN';
  }

  if (base === 'taskkill') {
    return 'TASKKILL';
  }

  if (
    base === 'node' ||
    str === process.execPath ||
    isSamePath(str, process.execPath)
  ) {
    return 'NODE';
  }

  return 'UNKNOWN';
}

export function parseAllowedScripts(raw) {
  if (!raw) return new Set();
  const items = String(raw).split(delimiter).map((s) => s.trim()).filter(Boolean);
  return new Set(items.map((p) => resolve(p)));
}

export function isAllowedScript(canonicalScript, allowedSet) {
  for (const allowed of allowedSet) {
    if (isSamePath(canonicalScript, allowed)) {
      return true;
    }
  }
  return false;
}

export function validateControlledNodeLaunch(command, args = [], options = {}, ownedTempRoot = null, extraAllowedScripts = null) {
  if (options.shell) {
    return { ok: false, reason: 'Hermetic test boundary: shell execution is denied' };
  }

  const cmdStr = String(command).trim();
  const base = basename(cmdStr).toLowerCase().replace(/\.exe$/, '');
  const isNode = base === 'node' || isSamePath(cmdStr, process.execPath);

  if (!isNode) {
    return { ok: false, reason: `Hermetic test boundary: alternative Node executable is denied: ${command}` };
  }

  const argList = Array.isArray(args) ? args.map(String) : [];

  // Reject argv bypass options
  for (const arg of argList) {
    if (arg === '--no-node-options' || arg.startsWith('--no-node-options=')) {
      return { ok: false, reason: 'Hermetic test boundary: --no-node-options flag is denied' };
    }
    if (arg === '--require' || arg === '-r' || arg.startsWith('--require=') || arg.startsWith('-r=')) {
      return { ok: false, reason: 'Hermetic test boundary: require flag is denied' };
    }
    if (
      arg === '--loader' ||
      arg === '--experimental-loader' ||
      arg.startsWith('--loader=') ||
      arg.startsWith('--experimental-loader=')
    ) {
      return { ok: false, reason: 'Hermetic test boundary: loader flag is denied' };
    }
    if (arg === '--import' || arg.startsWith('--import=')) {
      return { ok: false, reason: 'Hermetic test boundary: argv import override is denied' };
    }
    if (arg === '-e' || arg === '--eval' || arg.startsWith('-e=') || arg.startsWith('--eval=')) {
      return { ok: false, reason: 'Hermetic test boundary: inline eval is denied' };
    }
  }

  // Safe version check (single flag)
  if (argList.length === 1 && (argList[0] === '-v' || argList[0] === '--version')) {
    return { ok: true };
  }

  if (argList.length === 0) {
    return { ok: false, reason: 'Hermetic test boundary: no valid script target provided' };
  }

  // Reject unknown flags/options before execute
  if (argList[0].startsWith('-')) {
    return { ok: false, reason: `Hermetic test boundary: unknown or disallowed option: ${argList[0]}` };
  }

  const scriptArg = argList[0];
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const fullScriptPath = resolve(cwd, scriptArg);

  // Prefix trick / sibling directory rejection:
  // If the path starts with repoRoot prefix string but is not contained within repoRoot, reject!
  const fullScriptLower = fullScriptPath.toLowerCase();
  const repoLower = repoRoot.toLowerCase();
  if (fullScriptLower.startsWith(repoLower) && !isPathContained(fullScriptPath, repoRoot)) {
    return { ok: false, reason: `Hermetic test boundary: execution of uncontrolled script is denied: ${scriptArg}` };
  }

  // Build the effective allowlist
  const envAllowed = parseAllowedScripts(process.env.PMC_TEST_ALLOWED_SCRIPTS);
  const callerAllowed = extraAllowedScripts instanceof Set
    ? extraAllowedScripts
    : new Set((extraAllowedScripts ?? []).map((p) => resolve(p)));

  if (isAllowedScript(fullScriptPath, callerAllowed) || isAllowedScript(fullScriptPath, envAllowed)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Hermetic test boundary: execution of uncontrolled script is denied: ${scriptArg}`,
  };
}

export function deriveAllowedScripts({ allowedCliDirs = [], allowedScripts = [] } = {}) {
  const allowed = new Set(Array.from(ALLOWED_PMC_SCRIPTS, (name) => resolve(checkoutCliDir, name)));

  for (const cliDir of allowedCliDirs) {
    const resolvedDir = resolve(cliDir);
    for (const name of ALLOWED_PMC_SCRIPTS) {
      const candidate = resolve(resolvedDir, name);
      if (existsSync(candidate)) allowed.add(candidate);
    }
  }

  for (const script of allowedScripts) {
    allowed.add(resolve(script));
  }

  return allowed;
}

export function createHermeticEnv({ fakeHome, sentinelLog, ownedTempRoot, allowedScripts = [], extraEnv = {} } = {}) {
  const helperUrl = pathToFileURL(helperPath).href;

  const safeExtraEnv = { ...extraEnv };
  delete safeExtraEnv.NODE_OPTIONS;
  delete safeExtraEnv.PMC_TEST_ISOLATED_HOME;
  delete safeExtraEnv.PMC_TEST_SENTINEL_LOG;
  delete safeExtraEnv.PMC_TEST_ISOLATED_ROOT;
  delete safeExtraEnv.PMC_TEST_ALLOWED_SCRIPTS;

  const baseEnv = { ...process.env, ...safeExtraEnv };

  // Drop external application configuration overrides
  delete baseEnv.CODEX_HOME;
  delete baseEnv.OPENCODE_CONFIG_DIR;
  delete baseEnv.PMC_CONFIG_PATH;
  delete baseEnv.PMC_PROJECT_CONFIG;
  delete baseEnv.PMC_GLOBAL_CONFIG;

  // Pin owned roots - NO fallback to tmpdir()!
  const root = ownedTempRoot
    ? resolve(ownedTempRoot)
    : process.env.PMC_TEST_ISOLATED_ROOT
      ? resolve(process.env.PMC_TEST_ISOLATED_ROOT)
      : null;

  if (!root) {
    throw new Error('Hermetic test boundary: owned root must be provided; fallback to tmpdir is disallowed');
  }

  const home = fakeHome
    ? resolve(fakeHome)
    : process.env.PMC_TEST_ISOLATED_HOME
      ? resolve(process.env.PMC_TEST_ISOLATED_HOME)
      : join(root, 'home');

  const sentinel = sentinelLog
    ? resolve(sentinelLog)
    : process.env.PMC_TEST_SENTINEL_LOG
      ? resolve(process.env.PMC_TEST_SENTINEL_LOG)
      : join(root, 'sentinel-intent.log');

  // Validate root ownership containment
  if (!isPathContained(home, root)) {
    throw new Error(`Hermetic test boundary: home root ${home} is not contained within owned root ${root}`);
  }
  if (!isPathContained(sentinel, root)) {
    throw new Error(`Hermetic test boundary: sentinel log ${sentinel} is not contained within owned root ${root}`);
  }

  const allowedSet = allowedScripts instanceof Set
    ? allowedScripts
    : new Set((allowedScripts || []).map((p) => resolve(p)));

  const allowedStr = Array.from(allowedSet).join(delimiter);

  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    NODE_OPTIONS: `--import ${helperUrl}`,
    PMC_TEST_ISOLATED: '1',
    PMC_TEST_ISOLATED_ROOT: root,
    PMC_TEST_ISOLATED_HOME: home,
    PMC_TEST_SENTINEL_LOG: sentinel,
    PMC_TEST_ALLOWED_SCRIPTS: allowedStr,
    NO_PROXY: '*',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    npm_config_registry: 'http://127.0.0.1:0',
  };
}

function propagateHermeticEnv(options = {}) {
  const ownedTempRoot = process.env.PMC_TEST_ISOLATED_ROOT;
  const fakeHome = process.env.PMC_TEST_ISOLATED_HOME;
  const sentinelLog = process.env.PMC_TEST_SENTINEL_LOG;
  const allowedScripts = parseAllowedScripts(process.env.PMC_TEST_ALLOWED_SCRIPTS);

  if (!ownedTempRoot || !fakeHome || !sentinelLog) {
    throw new Error('Hermetic test boundary: cannot propagate uninitialized hermetic environment');
  }

  return createHermeticEnv({
    fakeHome,
    sentinelLog,
    ownedTempRoot,
    allowedScripts,
    extraEnv: options.env ?? {},
  });
}

function mockSpawnSync(command, args, options) {
  if (!Array.isArray(args) && typeof args === 'object' && options === undefined) {
    options = args;
    args = [];
  }
  args = args ?? [];
  options = options ?? {};

  if (options.shell) {
    logIntent({ type: 'denied-spawn', command: String(command), args, cwd: options.cwd });
    const error = new Error('Hermetic test boundary: shell execution is denied');
    error.code = 'EACCES';
    return {
      status: 1,
      error,
      stdout: options.encoding ? '' : Buffer.alloc(0),
      stderr: options.encoding ? error.message : Buffer.from(error.message),
      pid: 0,
      signal: null,
    };
  }

  const kind = classifyCommand(command, args);

  if (kind === 'PYTHON_PROBE') {
    logIntent({ type: 'python-probe', command: String(command), args, cwd: options.cwd });
    const out = 'Python 3.11.0\n';
    return {
      status: 0,
      stdout: options.encoding ? out : Buffer.from(out),
      stderr: options.encoding ? '' : Buffer.alloc(0),
      pid: 9901,
      signal: null,
    };
  }

  if (kind === 'PIP_INSTALL') {
    logIntent({ type: 'pip-install', command: String(command), args, cwd: options.cwd });
    const out = 'Successfully installed graphifyy\n';
    return {
      status: 0,
      stdout: options.encoding ? out : Buffer.from(out),
      stderr: options.encoding ? '' : Buffer.alloc(0),
      pid: 9902,
      signal: null,
    };
  }

  if (kind === 'GRAPHIFY') {
    logIntent({ type: 'graphify-execution', command: String(command), args, cwd: options.cwd });
    return {
      status: 0,
      stdout: options.encoding ? '' : Buffer.alloc(0),
      stderr: options.encoding ? '' : Buffer.alloc(0),
      pid: 9903,
      signal: null,
    };
  }

  if (kind === 'FINDER_GRAPHIFY') {
    logIntent({ type: 'where-graphify', command: String(command), args, cwd: options.cwd });
    const out = 'C:\\mock\\bin\\graphify.exe\n';
    return {
      status: 0,
      stdout: options.encoding ? out : Buffer.from(out),
      stderr: options.encoding ? '' : Buffer.alloc(0),
      pid: 9904,
      signal: null,
    };
  }

  if (kind === 'TASKKILL') {
    return {
      status: 0,
      stdout: options.encoding ? '' : Buffer.alloc(0),
      stderr: options.encoding ? '' : Buffer.alloc(0),
      pid: 9905,
      signal: null,
    };
  }

  if (kind === 'NODE') {
    const check = validateControlledNodeLaunch(command, args, options, process.env.PMC_TEST_ISOLATED_ROOT);
    if (!check.ok) {
      logIntent({ type: 'denied-spawn', command: String(command), args, cwd: options.cwd });
      const error = new Error(check.reason);
      error.code = 'EACCES';
      return {
        status: 1,
        error,
        stdout: options.encoding ? '' : Buffer.alloc(0),
        stderr: options.encoding ? error.message : Buffer.from(error.message),
        pid: 0,
        signal: null,
      };
    }
    const safeEnv = propagateHermeticEnv(options);
    return origSpawnSync(command, args, { ...options, shell: false, env: safeEnv });
  }

  logIntent({ type: 'denied-spawn', command: String(command), args, cwd: options.cwd });
  const error = new Error(`Hermetic test boundary: execution of unknown external process is denied: ${command}`);
  error.code = 'EACCES';
  return {
    status: 1,
    error,
    stdout: options.encoding ? '' : Buffer.alloc(0),
    stderr: options.encoding ? error.message : Buffer.from(error.message),
    pid: 0,
    signal: null,
  };
}

function mockSpawn(command, args, options) {
  if (!Array.isArray(args) && typeof args === 'object' && options === undefined) {
    options = args;
    args = [];
  }
  args = args ?? [];
  options = options ?? {};

  if (options.shell) {
    logIntent({ type: 'denied-spawn', command: String(command), args, cwd: options.cwd });
    return new SimpleMockChild({
      error: Object.assign(new Error('Hermetic test boundary: shell execution is denied'), { code: 'EACCES' }),
    });
  }

  const kind = classifyCommand(command, args);

  if (kind === 'NODE') {
    const check = validateControlledNodeLaunch(command, args, options, process.env.PMC_TEST_ISOLATED_ROOT);
    if (!check.ok) {
      logIntent({ type: 'denied-spawn', command: String(command), args, cwd: options.cwd });
      return new SimpleMockChild({
        error: Object.assign(new Error(check.reason), { code: 'EACCES' }),
      });
    }
    const safeEnv = propagateHermeticEnv(options);
    return origSpawn(command, args, { ...options, shell: false, env: safeEnv });
  }

  logIntent({ type: 'denied-spawn', command: String(command), args, cwd: options.cwd });
  return new SimpleMockChild({
    error: Object.assign(
      new Error(`Hermetic test boundary: execution of unknown external process is denied: ${command}`),
      { code: 'EACCES' },
    ),
  });
}

function mockExecFileSync(file, args, options) {
  if (!Array.isArray(args) && typeof args === 'object' && options === undefined) {
    options = args;
    args = [];
  }
  args = args ?? [];
  options = options ?? {};

  if (options.shell) {
    logIntent({ type: 'denied-spawn', command: String(file), args, cwd: options.cwd });
    const error = new Error('Hermetic test boundary: shell execution is denied');
    error.code = 'EACCES';
    throw error;
  }

  const kind = classifyCommand(file, args);

  if (kind === 'PYTHON_PROBE') {
    logIntent({ type: 'python-probe', command: String(file), args, cwd: options.cwd });
    return options.encoding ? 'Python 3.11.0\n' : Buffer.from('Python 3.11.0\n');
  }

  if (kind === 'PIP_INSTALL') {
    logIntent({ type: 'pip-install', command: String(file), args, cwd: options.cwd });
    return options.encoding ? 'Successfully installed graphifyy\n' : Buffer.from('Successfully installed graphifyy\n');
  }

  if (kind === 'GRAPHIFY') {
    logIntent({ type: 'graphify-execution', command: String(file), args, cwd: options.cwd });
    return options.encoding ? '' : Buffer.alloc(0);
  }

  if (kind === 'FINDER_GRAPHIFY') {
    logIntent({ type: 'where-graphify', command: String(file), args, cwd: options.cwd });
    return options.encoding ? 'C:\\mock\\bin\\graphify.exe\n' : Buffer.from('C:\\mock\\bin\\graphify.exe\n');
  }

  if (kind === 'TASKKILL') {
    return options.encoding ? '' : Buffer.alloc(0);
  }

  if (kind === 'NODE') {
    const check = validateControlledNodeLaunch(file, args, options, process.env.PMC_TEST_ISOLATED_ROOT);
    if (!check.ok) {
      logIntent({ type: 'denied-spawn', command: String(file), args, cwd: options.cwd });
      const error = new Error(check.reason);
      error.code = 'EACCES';
      throw error;
    }
    const safeEnv = propagateHermeticEnv(options);
    return origExecFileSync(file, args, { ...options, shell: false, env: safeEnv });
  }

  logIntent({ type: 'denied-spawn', command: String(file), args, cwd: options.cwd });
  const error = new Error(`Hermetic test boundary: execution of unknown external process is denied: ${file}`);
  error.code = 'EACCES';
  throw error;
}

function mockExecFile(file, args, options, callback) {
  if (typeof args === 'function') {
    callback = args;
    args = [];
    options = {};
  } else if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  args = args ?? [];
  options = options ?? {};

  const deny = (message) => {
    logIntent({ type: 'denied-spawn', command: String(file), args, cwd: options.cwd });
    const error = Object.assign(new Error(message), { code: 'EACCES' });
    if (typeof callback === 'function') queueMicrotask(() => callback(error, '', error.message));
    return new SimpleMockChild({ error });
  };

  if (options.shell) return deny('Hermetic test boundary: shell execution is denied');
  if (classifyCommand(file, args) !== 'NODE') {
    return deny(`Hermetic test boundary: execution of unknown external process is denied: ${file}`);
  }

  const check = validateControlledNodeLaunch(file, args, options, process.env.PMC_TEST_ISOLATED_ROOT);
  if (!check.ok) return deny(check.reason);
  return origExecFile(file, args, { ...options, shell: false, env: propagateHermeticEnv(options) }, callback);
}

function mockExec(command, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options ?? {};
  const parts = String(command).trim().split(/\s+/);
  return mockExecFile(parts[0], parts.slice(1), options, callback);
}

function mockExecSync(command, options) {
  options = options ?? {};
  const parts = String(command).trim().split(/\s+/);
  return mockExecFileSync(parts[0], parts.slice(1), options);
}

function mockFork(modulePath, args, options) {
  args = args ?? [];
  options = options ?? {};
  const check = validateControlledNodeLaunch(process.execPath, [modulePath, ...args], options, process.env.PMC_TEST_ISOLATED_ROOT);
  if (!check.ok) {
    const err = new Error(check.reason);
    err.code = 'EACCES';
    throw err;
  }
  const safeEnv = propagateHermeticEnv(options);
  return origFork(modulePath, args, { ...options, shell: false, env: safeEnv });
}

export function installHermeticSeam() {
  cp.spawn = mockSpawn;
  cp.spawnSync = mockSpawnSync;
  cp.execFile = mockExecFile;
  cp.execFileSync = mockExecFileSync;
  cp.exec = mockExec;
  cp.execSync = mockExecSync;
  cp.fork = mockFork;

  os.homedir = function () {
    return process.env.PMC_TEST_ISOLATED_HOME || origHomedir.call(os);
  };

  const blockNetwork = () => {
    throw new Error('Hermetic test boundary: network access is disabled');
  };

  net.connect = blockNetwork;
  net.createConnection = blockNetwork;
  if (net.Socket && net.Socket.prototype) {
    net.Socket.prototype.connect = blockNetwork;
  }

  http.request = blockNetwork;
  http.get = blockNetwork;
  https.request = blockNetwork;
  https.get = blockNetwork;
  dgram.createSocket = blockNetwork;

  const blockDns = (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    const err = new Error('Hermetic test boundary: network access is disabled');
    err.code = 'ENOTFOUND';
    if (cb) queueMicrotask(() => cb(err));
    throw err;
  };
  const blockDnsPromise = () => Promise.reject(new Error('Hermetic test boundary: network access is disabled'));

  dns.lookup = blockDns;
  dns.resolve = blockDns;
  dns.resolve4 = blockDns;
  dns.resolve6 = blockDns;
  dns.resolveMx = blockDns;
  dns.resolveTxt = blockDns;
  dns.resolveSrv = blockDns;
  dns.resolveNs = blockDns;
  dns.resolveCname = blockDns;
  dns.lookupService = blockDns;
  if (dns.promises) {
    dns.promises.lookup = blockDnsPromise;
    dns.promises.resolve = blockDnsPromise;
    dns.promises.resolve4 = blockDnsPromise;
    dns.promises.resolve6 = blockDnsPromise;
  }

  http2.connect = blockNetwork;

  globalThis.fetch = () => Promise.reject(new Error('Hermetic test boundary: network access is disabled'));

  syncBuiltinESMExports();
}

export async function runIsolatedSubprocess(command, args = [], options = {}) {
  const ownedTempRoot = options.ownedTempRoot ? resolve(options.ownedTempRoot) : (await mkdtemp(join(tmpdir(), 'pmc-hermetic-')));
  const fakeHome = join(ownedTempRoot, 'home');
  const sentinelLog = join(ownedTempRoot, 'sentinel-intent.log');
  await mkdir(fakeHome, { recursive: true });
  await writeFile(sentinelLog, '', 'utf8');

  const derivedAllowed = deriveAllowedScripts({
    allowedScripts: options.allowedScripts ?? [],
    allowedCliDirs: options.allowedCliDirs ?? [],
  });

  const hermeticEnv = createHermeticEnv({
    fakeHome,
    sentinelLog,
    ownedTempRoot,
    allowedScripts: derivedAllowed,
    extraEnv: options.env ?? {},
  });

  const readSentinelLog = async () => {
    try {
      const text = await readFile(sentinelLog, 'utf8');
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };

  const cleanup = async () => rm(ownedTempRoot, { recursive: true, force: true }).catch(() => {});

  if (options.shell) {
    const error = new Error('Hermetic test boundary: shell execution is denied');
    error.code = 'EACCES';
    logIntent({ type: 'denied-spawn', command: String(command), args, cwd: options.cwd }, sentinelLog);
    return {
      status: 1,
      error,
      stdout: '',
      stderr: error.message,
      pid: 0,
      signal: null,
      ownedTempRoot,
      fakeHome,
      sentinelLog,
      readSentinelLog,
      cleanup,
    };
  }

  const kind = classifyCommand(command, args);
  if (kind !== 'NODE') {
    const isDirectInstaller = kind === 'PIP_INSTALL' || kind === 'PYTHON_PROBE';
    const errorMsg = isDirectInstaller
      ? `Hermetic test boundary: execution of direct external installer is denied: ${command}`
      : `Hermetic test boundary: execution of unknown external process is denied: ${command}`;
    const error = new Error(errorMsg);
    error.code = 'EACCES';
    logIntent({ type: 'denied-spawn', command: String(command), args, cwd: options.cwd }, sentinelLog);
    return {
      status: 1,
      error,
      stdout: '',
      stderr: error.message,
      pid: 0,
      signal: null,
      ownedTempRoot,
      fakeHome,
      sentinelLog,
      readSentinelLog,
      cleanup,
    };
  }

  const check = validateControlledNodeLaunch(command, args, options, ownedTempRoot, derivedAllowed);
  if (!check.ok) {
    const error = new Error(check.reason);
    error.code = 'EACCES';
    logIntent({ type: 'denied-spawn', command: String(command), args, cwd: options.cwd }, sentinelLog);
    return {
      status: 1,
      error,
      stdout: '',
      stderr: error.message,
      pid: 0,
      signal: null,
      ownedTempRoot,
      fakeHome,
      sentinelLog,
      readSentinelLog,
      cleanup,
    };
  }

  const result = origSpawnSync(command, args, {
    ...options,
    shell: false,
    env: hermeticEnv,
    encoding: options.encoding ?? 'utf8',
    timeout: options.timeout ?? 60000,
  });

  return {
    ...result,
    ownedTempRoot,
    fakeHome,
    sentinelLog,
    readSentinelLog,
    cleanup,
  };
}

export function maybeActivateSeam() {
  if (process.env.PMC_TEST_ISOLATED !== '1') {
    return false;
  }
  const root = process.env.PMC_TEST_ISOLATED_ROOT;
  const home = process.env.PMC_TEST_ISOLATED_HOME;
  const sentinel = process.env.PMC_TEST_SENTINEL_LOG;
  const allowed = process.env.PMC_TEST_ALLOWED_SCRIPTS;

  if (!root || !home || !sentinel || !allowed || !existsSync(root) || !existsSync(sentinel)) {
    return false;
  }

  if (!isPathContained(home, root) || !isPathContained(sentinel, root)) {
    return false;
  }

  installHermeticSeam();
  return true;
}

// Activate ONLY in child/grandchild with valid explicit marker and roots
maybeActivateSeam();
