#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { runDoctor } from '../src/doctor.mjs';
import { resolvePythonBin } from '../src/platform.mjs';

function spawnCheck(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf-8', timeout: 5000 });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const { checks } = await runDoctor({ resolvePythonBin, spawnCheck });

const icon = { ok: '✓', warn: '⚠', fail: '✗' };
const color = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', reset: '\x1b[0m' };

console.log('\npmc doctor\n');
for (const c of checks) {
  const col = color[c.status] ?? '';
  console.log(`  ${col}${icon[c.status]}${color.reset}  ${c.name.padEnd(22)} ${c.message}`);
}
console.log('');

const hasFail = checks.some(c => c.status === 'fail');
if (hasFail) {
  console.log('Some checks failed. Fix the issues above before running pmc setup.\n');
  process.exit(1);
} else {
  console.log('All checks passed.\n');
}
