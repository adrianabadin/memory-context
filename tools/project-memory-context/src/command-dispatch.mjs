import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const COMMANDS = new Map([
  ['doctor', 'cli/doctor.mjs'],
  ['enrich', 'cli/enrich.mjs'],
  ['enrich-status', 'cli/status.mjs'],
  ['get-context', 'cli/context.mjs'],
  ['help', null],
  ['init-project', 'cli/init.mjs'],
  ['install-pmc', 'cli/install-pmc.mjs'],
  ['map-project', 'cli/bootstrap.mjs'],
  ['project-context', 'cli/project-context.mjs'],
  ['query', 'cli/query.mjs'],
  ['refresh-context', 'cli/refresh-context.mjs'],
  ['retry-errors', 'cli/retry-errors.mjs'],
  ['sanitize', 'cli/sanitize.mjs'],
  ['session-start', 'cli/session-start.mjs'],
  ['setup', 'cli/setup.mjs'],
  ['subagent-apply', 'cli/subagent-apply.mjs'],
  ['sync-context', 'cli/sync.mjs'],
  ['view-context', 'bin/pmc-view-context.mjs'],
  ['watch', 'cli/watch.mjs'],
]);

function usageText() {
  return `Usage: pmc <${[...COMMANDS.keys()].join('|')}>`;
}

function writeLine(stream, message) {
  stream.write(`${message}\n`);
}

export function resolveCommand(argv = []) {
  const name = argv[0] ?? 'help';
  const relativeModule = COMMANDS.get(name);

  if (relativeModule === undefined) {
    return { name, modulePath: null, args: argv.slice(1), valid: false };
  }

  return {
    name,
    modulePath: relativeModule ? resolve(PACKAGE_ROOT, relativeModule) : null,
    args: argv.slice(1),
    valid: true,
  };
}

export async function runCommand(argv = [], options = {}) {
  const { stdio = 'inherit', stdout = process.stdout, stderr = process.stderr } = options;
  const command = resolveCommand(argv);

  if (!command.valid) {
    writeLine(stderr, `Invalid command: ${command.name}`);
    writeLine(stdout, usageText());
    return 1;
  }

  if (!command.modulePath) {
    writeLine(stdout, usageText());
    return 0;
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [command.modulePath, ...command.args], { stdio });

    if (stdio === 'pipe') {
      child.stdout?.on('data', (chunk) => {
        stdout.write(chunk);
      });

      child.stderr?.on('data', (chunk) => {
        stderr.write(chunk);
      });
    }

    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`Command exited from signal ${signal}`));
        return;
      }

      resolvePromise(code ?? 0);
    });
  });
}
