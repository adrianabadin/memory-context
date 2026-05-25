import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const TRACKED_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx', '.cs']);

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'bin',
  'obj',
  '.opencode',
  '.planning',
  'graphify-out',
  'target',
  '.next',
]);

async function walkDir(dir, projectRoot) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...await walkDir(join(dir, entry.name), projectRoot));
    } else if (entry.isFile()) {
      const ext = entry.name.substring(entry.name.lastIndexOf('.'));
      if (TRACKED_EXTENSIONS.has(ext)) {
        files.push(relative(projectRoot, join(dir, entry.name)).replace(/\\/g, '/'));
      }
    }
  }
  return files;
}

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export async function computeFileHashes(projectRoot) {
  const files = await walkDir(projectRoot, projectRoot);
  const hashes = {};
  for (const relPath of files) {
    hashes[relPath] = await hashFile(join(projectRoot, relPath));
  }
  return hashes;
}

export async function saveHashStore(storePath, hashes) {
  const { writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(storePath), { recursive: true });
  const payload = { hashes, updatedAt: new Date().toISOString() };
  await writeFile(storePath, JSON.stringify(payload, null, 2), 'utf-8');
}

export async function loadHashStore(storePath) {
  try {
    const raw = await readFile(storePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.hashes ?? parsed;
  } catch {
    return {};
  }
}

export function detectChangedFiles(previous, current) {
  const added = [];
  const modified = [];
  const removed = [];
  const unchanged = [];

  for (const file of Object.keys(current)) {
    if (!(file in previous)) {
      added.push(file);
    } else if (previous[file] !== current[file]) {
      modified.push(file);
    } else {
      unchanged.push(file);
    }
  }

  for (const file of Object.keys(previous)) {
    if (!(file in current)) {
      removed.push(file);
    }
  }

  return { added, modified, removed, unchanged };
}
