import test from 'node:test';
import assert from 'node:assert/strict';

import { renderProjectContextMarkdown } from '../src/markdown-renderer.mjs';

test('renderProjectContextMarkdown renders title, summary, body, and sources', () => {
  const markdown = renderProjectContextMarkdown({
    title: 'Technical rules',
    kind: 'technical-rules',
    summary: 'Follow existing module boundaries.',
    body: '- Keep files focused.\n- Avoid generated files.',
    source_files: ['README.md'],
    graph_refs: ['node:src/main.ts'],
    updated_at: '2026-05-17T00:00:00.000Z',
  });

  assert.match(markdown, /^# Technical rules/m);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /README.md/);
  assert.match(markdown, /node:src\/main.ts/);
});
