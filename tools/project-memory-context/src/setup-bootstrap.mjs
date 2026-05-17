import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ensureProjectMemoryContextDirs, writeJsonArtifact } from './artifacts.mjs';

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function ensurePluginRegistration(projectRoot) {
  const configPath = join(projectRoot, '.opencode', 'opencode.json');
  const config = await readJson(configPath, { $schema: 'https://opencode.ai/config.json' });
  const existing = Array.isArray(config.plugin) ? config.plugin : [];
  if (!existing.includes('opencode-project-memory-context')) {
    config.plugin = [...existing, 'opencode-project-memory-context'];
  }
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

async function copyTemplate(packageRoot, templateName, projectRoot) {
  const source = join(packageRoot, 'templates', templateName);
  const target = join(projectRoot, templateName);
  const content = await readFile(source, 'utf8');
  const rendered = content.replaceAll('__PMC_PACKAGE_ROOT__', packageRoot);
  await writeFile(target, rendered, 'utf8');
  return target;
}

export async function bootstrapProjectInstall({
  projectRoot,
  packageRoot,
  ollamaBaseUrl,
  ollamaModel,
}) {
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const memoryDbPath = join(dirs.base, 'memory-db');
  const installState = {
    packageRoot,
    ollamaBaseUrl,
    ollamaModel,
    memoryDbPath,
    installedAt: new Date().toISOString(),
  };

  await mkdir(memoryDbPath, { recursive: true });
  await writeJsonArtifact(join(dirs.base, 'install.json'), installState);
  const configPath = await ensurePluginRegistration(projectRoot);
  const commandPath = await copyTemplate(packageRoot, 'project-memory-context.md', projectRoot);
  const workflowPath = await copyTemplate(packageRoot, 'project-memory-context workflow.md', projectRoot);

  return {
    installState,
    configPath,
    commandPath,
    workflowPath,
  };
}
