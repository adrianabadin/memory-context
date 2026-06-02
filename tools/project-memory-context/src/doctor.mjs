import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export async function runDoctor({
  env = process.env,
  fetchImpl = globalThis.fetch,
  resolvePythonBin = () => null,
  resolveGraphify = () => null,
  spawnCheck = null,
} = {}) {
  const checks = await Promise.all([
    checkNodeVersion(),
    checkNodeSqlite(),
    checkPython(resolvePythonBin, spawnCheck),
    checkGraphify(resolvePythonBin, spawnCheck),
    checkAgentMemoryMcp(spawnCheck),
    checkOllama(env, fetchImpl),
    checkMemoryDbPath(env),
    checkEmbeddingCachePath(env),
  ]);
  return { checks };
}

async function checkAgentMemoryMcp(spawnCheck) {
  if (!spawnCheck) {
    return { name: 'agent-memory', status: 'warn', message: 'agent-memory check skipped (no spawn check provided)' };
  }
  
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  
  // Check global first
  const globalCheck = await spawnCheck(npmCmd, ['list', '-g', '@aabadin/agent-memory-mcp']);
  if (globalCheck.exitCode === 0 && globalCheck.stdout.includes('@aabadin/agent-memory-mcp')) {
    return { name: 'agent-memory', status: 'ok', message: 'agent-memory-mcp installed globally ✓' };
  }
  
  // Check local
  const localCheck = await spawnCheck(npmCmd, ['list', '@aabadin/agent-memory-mcp']);
  if (localCheck.exitCode === 0 && localCheck.stdout.includes('@aabadin/agent-memory-mcp')) {
    return { name: 'agent-memory', status: 'ok', message: 'agent-memory-mcp installed locally ✓' };
  }
  
  return { 
    name: 'agent-memory', 
    status: 'warn', 
    message: 'agent-memory-mcp not installed. Run: npm install -g @aabadin/agent-memory-mcp' 
  };
}

async function checkNodeVersion() {
  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  return {
    name: 'node-version',
    status: major >= 18 ? 'ok' : 'fail',
    message: major >= 18
      ? `Node.js ${process.version} ✓`
      : `Node.js ${process.version} requires ≥ 18 — upgrade Node.js`,
  };
}

async function checkNodeSqlite() {
  const parts = process.version.slice(1).split('.').map(Number);
  const [major, minor] = parts;

  if (major >= 24) {
    return {
      name: 'node-sqlite',
      status: 'ok',
      message: `node:sqlite available (Node.js ${process.version}) ✓`,
    };
  }
  if (major > 22 || (major === 22 && minor >= 5)) {
    return {
      name: 'node-sqlite',
      status: 'warn',
      message: `node:sqlite requires --experimental-sqlite flag on Node.js ${process.version} — upgrade to Node.js 24 for stable access`,
    };
  }
  return {
    name: 'node-sqlite',
    status: 'fail',
    message: `node:sqlite unavailable on Node.js ${process.version} — graph store requires Node.js ≥ 22.5 (Node.js 24 recommended)`,
  };
}

async function checkPython(resolvePythonBin, spawnCheck) {
  const bin = resolvePythonBin?.() ?? null;
  if (!bin) {
    return { name: 'python', status: 'fail', message: 'Python 3 not found — download from https://www.python.org/downloads/ or set PATH' };
  }
  if (!spawnCheck) {
    return { name: 'python', status: 'ok', message: `${bin} found (not verified — no spawn check provided)` };
  }
  const result = await spawnCheck(bin, ['--version']);
  return {
    name: 'python',
    status: result.exitCode === 0 ? 'ok' : 'fail',
    message: result.exitCode === 0
      ? `${bin} ${result.stdout?.trim() ?? ''} ✓`
      : `${bin} failed to run — check Python installation`,
  };
}

async function checkGraphify(resolvePythonBin, spawnCheck) {
  const bin = resolvePythonBin?.() ?? 'python3';
  if (!spawnCheck) {
    return { name: 'graphifyy', status: 'warn', message: 'graphifyy check skipped (no spawn check provided)' };
  }
  const result = await spawnCheck(bin, ['-c', 'import graphifyy; print("ok")']);
  return {
    name: 'graphifyy',
    status: result.exitCode === 0 ? 'ok' : 'fail',
    message: result.exitCode === 0
      ? 'graphifyy importable ✓'
      : 'graphifyy not installed — run: pip install graphifyy',
  };
}

async function checkOllama(env, fetchImpl) {
  const baseUrl = env.PMC_LOCAL_MODEL_BASE_URL ?? DEFAULT_OLLAMA_URL;
  try {
    const res = await Promise.race([
      fetchImpl(`${baseUrl}/api/tags`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return {
      name: 'ollama',
      status: res.ok ? 'ok' : 'warn',
      message: res.ok
        ? `Ollama reachable at ${baseUrl} ✓`
        : `Ollama responded ${res.status} at ${baseUrl}`,
    };
  } catch {
    return {
      name: 'ollama',
      status: 'warn',
      message: `Ollama not reachable at ${baseUrl} — enrichment will use cloud-api fallback`,
    };
  }
}

async function checkMemoryDbPath(env) {
  const p = env.MEMORY_DB_PATH;
  if (!p) {
    return { name: 'memory-db-path', status: 'fail', message: 'MEMORY_DB_PATH not set — required for agent-memory-mcp' };
  }
  try {
    await access(p, constants.W_OK);
    return { name: 'memory-db-path', status: 'ok', message: `${p} writable ✓` };
  } catch {
    return { name: 'memory-db-path', status: 'warn', message: `${p} does not exist yet (will be created on first run)` };
  }
}

async function checkEmbeddingCachePath(env) {
  const p = env.EMBEDDING_CACHE_PATH;
  if (!p) {
    return { name: 'embedding-cache', status: 'ok', message: 'EMBEDDING_CACHE_PATH not set (cache disabled — optional)' };
  }
  try {
    await access(p, constants.W_OK);
    return { name: 'embedding-cache', status: 'ok', message: `${p} writable ✓` };
  } catch {
    return { name: 'embedding-cache', status: 'warn', message: `${p} does not exist yet (will be created on first run)` };
  }
}
