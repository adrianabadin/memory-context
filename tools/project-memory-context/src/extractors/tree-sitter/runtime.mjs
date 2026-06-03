import { Parser, Language } from 'web-tree-sitter';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { LANGUAGE_TO_GRAMMAR } from './language-map.mjs';

const require = createRequire(import.meta.url);

// Promise-based singleton — concurrent callers share a single init Promise
// (same pattern as hash.mjs) so Parser.init() is never called twice.
let _initPromise = null;

export function initParser() {
  if (!_initPromise) {
    _initPromise = Parser.init().then(() => new Parser());
  }
  return _initPromise;
}

const languageCache = new Map();

export async function loadLanguage(name) {
  if (languageCache.has(name)) return languageCache.get(name);

  const entry = LANGUAGE_TO_GRAMMAR[name];
  if (!entry) {
    throw new Error(
      `Unsupported language: "${name}". Supported: ${Object.keys(LANGUAGE_TO_GRAMMAR).join(', ')}`
    );
  }

  const pkgDir = dirname(require.resolve(`${entry.pkg}/package.json`));
  const wasmPath = join(pkgDir, entry.wasm);

  // Ensure Parser is initialized before loading a Language
  await initParser();

  const language = await Language.load(wasmPath);
  languageCache.set(name, language);
  return language;
}
