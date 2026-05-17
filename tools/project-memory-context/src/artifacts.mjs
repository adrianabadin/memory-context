import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function ensureProjectMemoryContextDirs(projectRoot) {
  const base = join(projectRoot, '.planning', 'project-memory-context');
  const dirs = {
    base,
    intake: join(base, 'intake'),
    graph: join(base, 'graph'),
    enrichment: join(base, 'enrichment'),
    runs: join(base, 'runs'),
  };

  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  return dirs;
}

export async function writeJsonArtifact(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJsonArtifact(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}
