import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON_PATH = resolve(PACKAGE_ROOT, 'package.json');

export function getPackageVersion() {
  const content = readFileSync(PACKAGE_JSON_PATH, 'utf8');
  return JSON.parse(content).version;
}
