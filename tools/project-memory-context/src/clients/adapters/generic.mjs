import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderTemplate, hasBlockMarker, replaceOrAppendBlock, stripBlockMarkers, wrapBlock } from '../../templates/render.mjs';
import { CLIENT_MARKERS } from '../markers.mjs';

export const genericAdapter = Object.freeze({
  id: 'generic',
  legacyId: 'generic',
  priority: 50,
  flags: ['--generic'],
  markers: CLIENT_MARKERS.generic,
  paths: {
    projectConfig: (root) => join(root, 'README-SETUP.md'),
    globalConfig: (home) => join(home, '.pmc'),
  },
  capabilities: {
    mcp: {
      supported: false,
    },
    instructions: {
      supported: true,
      format: 'markdown',
      target: 'README-SETUP.md',
      marker: 'generic',
    },
    skills: {
      supported: false,
    },
    hooks: {
      supported: false,
    },
  },
  writers: {
    instructions: async ({ projectRoot, packageRoot, placeholders, readTemplate }) => {
      const marker = 'generic';
      const readmePath = join(projectRoot, 'README-SETUP.md');
      const statePath = join(projectRoot, '.pmc', 'generic-readme-installed');
      const readme = renderTemplate(
        await readTemplate(packageRoot, 'generic/README-SETUP.md'),
        placeholders,
      );
      const block = stripBlockMarkers(readme, marker);

      if (existsSync(statePath)) {
        if (!existsSync(readmePath)) {
          await writeFile(readmePath, wrapBlock(marker, block), 'utf8');
          return;
        }

        const existing = await readFile(readmePath, 'utf8');
        if (hasBlockMarker(existing, marker)) {
          await writeFile(readmePath, replaceOrAppendBlock(existing, marker, block), 'utf8');
        } else {
          await writeFile(readmePath, replaceOrAppendBlock(existing, marker, block), 'utf8');
        }
        return;
      }

      if (existsSync(readmePath)) {
        const existing = await readFile(readmePath, 'utf8');
        if (existing.trim()) {
          await writeFile(readmePath, replaceOrAppendBlock(existing, marker, block), 'utf8');
        } else {
          await writeFile(readmePath, wrapBlock(marker, block), 'utf8');
        }
      } else {
        await writeFile(readmePath, wrapBlock(marker, block), 'utf8');
      }

      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, 'installed\n', 'utf8');
    },
  },
  verifiers: {
    instructions: async ({ projectRoot }) => existsSync(join(projectRoot, 'README-SETUP.md')),
  },
});
