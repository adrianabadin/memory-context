#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve('@adamrdrew/agent-memory-mcp/package.json');
const packageRoot = dirname(packageJsonPath);
const entry = join(packageRoot, 'dist', 'index.js');

const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
