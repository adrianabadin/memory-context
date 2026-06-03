#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');

const GRAPH_EXPLORER_PATH = resolve(PACKAGE_ROOT, 'tools/pmc-graph-explorer/server.mjs');
const PID_FILE = join(tmpdir(), 'pmc-graph-explorer.pid');
const PORT = 3001;

function killByPidFile() {
  if (!existsSync(PID_FILE)) return;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid) {
      process.kill(pid, 'SIGKILL');
      console.log(`[pmc] Killed previous instance (PID ${pid})`);
    }
  } catch (err) {
    console.error(`[pmc] Could not kill previous instance by PID: ${err.message}`);
  }
}

function killPortProcess(port) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf8' });
      const pids = new Set();
      for (const line of output.trim().split('\n')) {
        const match = line.trim().match(/\s+(\d+)$/);
        if (match && match[1] !== '0') pids.add(match[1]);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
          console.log(`[pmc] Killed process on port ${port} (PID ${pid})`);
        } catch (e) {
          console.error(`[pmc] Could not kill PID ${pid}: ${e.message}`);
        }
      }
    } else {
      const output = execSync(`lsof -ti :${port}`, { encoding: 'utf8' });
      for (const pid of output.trim().split('\n').filter(Boolean)) {
        try {
          execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
          console.log(`[pmc] Killed process on port ${port} (PID ${pid})`);
        } catch (e) {
          console.error(`[pmc] Could not kill PID ${pid}: ${e.message}`);
        }
      }
    }
  } catch {
    // No process on that port — fine
  }
}

killByPidFile();
killPortProcess(PORT);

// Let the OS release the port before binding again
await sleep(300);

const child = spawn(process.execPath, [GRAPH_EXPLORER_PATH], {
  env: { ...process.env, PMC_PROJECT_ROOT: process.cwd() },
  stdio: 'inherit',
  detached: true,
  shell: false,
});

child.once('error', (err) => {
  console.error(`[pmc] Failed to start graph explorer: ${err.message}`);
  process.exit(1);
});

writeFileSync(PID_FILE, String(child.pid), 'utf8');
child.unref();
