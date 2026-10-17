#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairManifestFile } from '../src/manifest-recovery.mjs';

const MANIFEST_RELATIVE = '.planning/project-memory-context/enrichment/sync-manifest.json';

export function resolveManifestPath(projectRoot) {
  return join(resolve(projectRoot), MANIFEST_RELATIVE);
}

export async function main(argv = process.argv.slice(2), log = console.log, errLog = console.error) {
  const projectRoot = argv[0] ?? process.cwd();
  const manifestPath = resolveManifestPath(projectRoot);

  try {
    const result = await repairManifestFile(manifestPath);
    if (!result.repaired) {
      log(`[repair] Manifest already valid — ${result.recovered} entries, no changes.`);
      return 0;
    }
    log(`[repair] Recovered ${result.recovered} entries.`);
    log(`[repair] Backup written to ${result.backupPath}`);
    log(`[repair] Manifest rewritten: ${manifestPath}`);
    return 0;
  } catch (err) {
    errLog(`[repair] Failed to repair ${manifestPath}: ${err.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
