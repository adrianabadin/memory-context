// Lazy singleton — xxhash-wasm initializes once
import xxhash from 'xxhash-wasm';

let _initPromise = null;

async function getH64() {
  if (!_initPromise) {
    _initPromise = xxhash().then(m => m.h64ToString);
  }
  return _initPromise;
}

export async function hashSymbol(fragment) {
  return (await getH64())(String(fragment));
}

export async function hashFile(content) {
  return (await getH64())(String(content));
}

export const HASH_VERSION = 'xxh3-1';
