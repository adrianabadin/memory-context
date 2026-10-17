import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ADAPTERS_DIR = join(__dirname, '..', '..', 'src', 'clients', 'adapters');

export function checkNoCycleInvariants(adaptersDir = DEFAULT_ADAPTERS_DIR) {
  const adapterFiles = readdirSync(adaptersDir).filter((f) => f.endsWith('.mjs'));
  const forbiddenSpecifiers = ['registry.mjs', 'platform.mjs', 'template-installer.mjs'];

  for (const file of adapterFiles) {
    const filePath = join(adaptersDir, file);
    const content = readFileSync(filePath, 'utf8');

    // Parse static and dynamic import/export statements, filtering out single-line & multi-line comment blocks
    const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, '');
    const lines = cleanContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const commentIdx = rawLine.indexOf('//');
      const line = commentIdx !== -1 ? rawLine.substring(0, commentIdx) : rawLine;
      const trimmed = line.trim();

      if (!trimmed) continue;

      const isImportOrExport =
        trimmed.startsWith('import ') ||
        trimmed.startsWith('import(') ||
        trimmed.startsWith('export ') ||
        trimmed.includes('import(');

      if (isImportOrExport) {
        // Normalize backslashes to forward slashes for cross-platform checking
        const normLine = trimmed.replace(/\\/g, '/');
        for (const forbidden of forbiddenSpecifiers) {
          if (
            normLine.includes(`/${forbidden}`) ||
            normLine.includes(`'./${forbidden}'`) ||
            normLine.includes(`"./${forbidden}"`) ||
            normLine.includes(`'../${forbidden}'`) ||
            normLine.includes(`"../${forbidden}"`)
          ) {
            throw new Error(`Adapter module ${file} violates Invariant 9 by importing ${forbidden}`);
          }
        }
      }
    }
  }
  return true;
}
