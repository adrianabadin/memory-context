#!/usr/bin/env node
import { runCommand } from '../src/command-dispatch.mjs';

const exitCode = await runCommand(process.argv.slice(2)).catch((error) => {
  console.error('[pmc] FATAL:', error.message);
  return 1;
});

if (exitCode !== 0) {
  process.exit(exitCode);
}
