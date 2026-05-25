import { extname } from 'node:path';

const WATCH_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx', '.cs']);
const IGNORE_PREFIXES = ['node_modules', 'dist', '.git', 'bin', 'obj', '.opencode', '.planning', 'graphify-out', '.next'];

export function shouldWatch(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (IGNORE_PREFIXES.some(prefix => normalized.includes(`/${prefix}/`) || normalized.startsWith(`${prefix}/`))) {
    return false;
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
