import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { shouldIgnoreDir } from '../walk-ignores.mjs';

async function listDirectories(dir, root, depth = 0, maxDepth = 2, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (shouldIgnoreDir(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full).replace(/\\/g, '/');
    acc.push({ rel, depth });
    if (depth < maxDepth - 1) {
      await listDirectories(full, root, depth + 1, maxDepth, acc);
    }
  }
  return acc;
}

export async function detectStructureContext(projectRoot) {
  const dirs = await listDirectories(projectRoot, projectRoot);
  const rootDirectories = dirs.filter((item) => item.depth === 0).map((item) => item.rel);
  const keySubtrees = dirs.filter((item) => item.depth > 0).map((item) => item.rel);
  const entryPoints = [];
  for (const rel of ['src/main.ts', 'src/index.ts', 'src/app.ts', 'src/server.ts']) {
    try {
      const s = await stat(join(projectRoot, rel));
      if (s.isFile()) entryPoints.push(rel);
    } catch {}
  }
  return { rootDirectories, keySubtrees, entryPoints };
}
