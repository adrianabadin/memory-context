// Lazy singleton — xxhash-wasm initializes once
import xxhash from 'xxhash-wasm';

let _h64 = null;

async function getH64() {
  if (!_h64) {
    const { h64ToString } = await xxhash();
    _h64 = h64ToString;
  }
  return _h64;
}

export async function hashSymbol(fragment) {
  return (await getH64())(String(fragment));
}

export async function hashFile(content) {
  return (await getH64())(String(content));
}

export const HASH_VERSION = 'xxh3-1';
