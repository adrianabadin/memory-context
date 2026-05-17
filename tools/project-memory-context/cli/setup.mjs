#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { bootstrapProjectInstall } from '../src/setup-bootstrap.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function installGraphify() {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const command of candidates) {
    const result = spawnSync(command, ['-m', 'pip', 'install', 'graphifyy'], { stdio: 'inherit' });
    if (result.status === 0) {
      return command;
    }
  }
  throw new Error('Unable to install graphifyy. Ensure Python and pip are available.');
}

const rl = createInterface({ input, output });
const cwd = resolve(process.cwd());

try {
  const ollamaBaseUrl = (await rl.question('Ollama base URL [http://localhost:11434]: ')).trim() || 'http://localhost:11434';
  const ollamaModel = (await rl.question('Ollama model name [deepseek-coder-v2:16b-ctx32k]: ')).trim() || 'deepseek-coder-v2:16b-ctx32k';
  installGraphify();
  const result = await bootstrapProjectInstall({
    projectRoot: cwd,
    packageRoot,
    ollamaBaseUrl,
    ollamaModel,
  });
  console.log(JSON.stringify({
    installed: true,
    projectRoot: cwd,
    configPath: result.configPath,
    commandPath: result.commandPath,
    workflowPath: result.workflowPath,
    ollamaBaseUrl,
    ollamaModel,
  }, null, 2));
} finally {
  rl.close();
}
