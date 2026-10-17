import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic-write.mjs';

function deepMerge(target, source) {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      output[key] = deepMerge(target[key], source[key]);
    } else {
      output[key] = source[key];
    }
  }
  return output;
}

export async function mergeJsonConfig(filePath, updates) {
  let existingContent = '';
  let existingObj = {};

  try {
    existingContent = await readFile(filePath, 'utf8');
    if (existingContent.trim().length > 0) {
      existingObj = JSON.parse(existingContent);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      existingObj = {};
      existingContent = '';
    } else if (err instanceof SyntaxError) {
      return { malformed: true };
    } else {
      throw err;
    }
  }

  const mergedObj = deepMerge(existingObj, updates);
  const newContent = JSON.stringify(mergedObj, null, 2) + '\n';

  if (existingContent === newContent) {
    return { status: 'unchanged' };
  }

  await writeAtomic(filePath, newContent);
  return { status: 'installed' };
}
