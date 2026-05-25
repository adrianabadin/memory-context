import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import { shouldWatch, debounce } from '../src/file-watcher.mjs';
import { refreshContext } from './refresh-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(msg) { console.error(`[watch] ${msg}`); }

async function main() {
  const projectRoot = resolve(process.argv[2] ?? process.cwd());
  log(`Watching ${projectRoot} for source file changes...`);
  log('Press Ctrl+C to stop.');

  const onChange = debounce(async () => {
    log('Changes detected, running refresh-context...');
    try {
      await refreshContext(projectRoot);
    } catch (err) {
      log(`refresh-context error: ${err.message}`);
    }
  }, 2000);

  const watcher = watch(projectRoot, { recursive: true }, (eventType, filename) => {
    if (filename && shouldWatch(filename)) {
      log(`  ${eventType}: ${filename}`);
      onChange();
    }
  });

  watcher.on('error', (err) => {
    log(`Watcher error: ${err.message}`);
  });

  process.on('SIGINT', () => {
    log('Stopping watcher.');
    watcher.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[watch] FATAL:', err.message);
  process.exit(1);
});
