import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderTemplate, hasBlockMarker, replaceOrAppendBlock, stripBlockMarkers } from '../../templates/render.mjs';
import { CLIENT_MARKERS } from '../markers.mjs';

export const cursorAdapter = Object.freeze({
  id: 'cursor',
  legacyId: 'cursor',
  priority: 30,
  flags: ['--cursor'],
  markers: CLIENT_MARKERS.cursor,
  paths: {
    projectConfig: (root) => join(root, '.mcp.json'),
    globalConfig: (home) => join(home, '.cursor'),
  },
  capabilities: {
    mcp: {
      supported: true,
      format: 'json',
      target: 'projectConfig',
      ownedKeys: ['mcpServers.pmc-query', 'mcpServers.pmc-agent-memory'],
    },
    instructions: {
      supported: true,
      format: 'markdown',
      target: '.cursorrules',
      marker: 'init',
    },
    skills: {
      supported: false,
    },
    hooks: {
      supported: false,
    },
  },
  writers: {
    mcp: async () => {},
    instructions: async ({ projectRoot, packageRoot, placeholders, readTemplate }) => {
      const targetPath = join(projectRoot, '.cursorrules');
      const snippet = renderTemplate(await readTemplate(packageRoot, 'cursor/.cursorrules.snippet'), placeholders);

      let existing = '';
      if (existsSync(targetPath)) {
        existing = await readFile(targetPath, 'utf8');
      }

      if (hasBlockMarker(existing, 'init')) {
        const updated = replaceOrAppendBlock(existing, 'init', stripBlockMarkers(snippet, 'init'));
        await writeFile(targetPath, updated, 'utf8');
        return;
      }

      if (existing.trim()) {
        const updated = replaceOrAppendBlock(existing, 'init', stripBlockMarkers(snippet, 'init'));
        await writeFile(targetPath, updated, 'utf8');
        return;
      }

      await writeFile(targetPath, snippet, 'utf8');
    },
  },
  verifiers: {
    mcp: async ({ projectRoot }) => existsSync(join(projectRoot, '.mcp.json')),
    instructions: async ({ projectRoot }) => existsSync(join(projectRoot, '.cursorrules')),
  },
});
