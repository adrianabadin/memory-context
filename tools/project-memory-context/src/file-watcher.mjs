import { basename, extname } from 'node:path';
import { IGNORED_DIRS, isGraphifyScope } from './walk-ignores.mjs';

const WATCH_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx', '.cs']);

export function shouldWatch(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = basename(normalized);
  if (isGraphifyScope(fileName)) {
    return false;
  }
  if (normalized.startsWith('.opencode/') || normalized.includes('/.opencode/')) {
    return false;
  }
  for (const prefix of IGNORED_DIRS) {
    if (normalized.startsWith(`${prefix}/`) || normalized.includes(`/${prefix}/`)) {
      return false;
    }
  }
  return WATCH_EXTENSIONS.has(extname(normalized));
}

export function debounce(fn, delayMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}
