import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_CONTEXT_KINDS,
  buildProjectContextMemoryKey,
  createMaterializedProjectContext,
} from '../src/project-context-schema.mjs';

test('buildProjectContextMemoryKey creates stable keys', () => {
  assert.equal(buildProjectContextMemoryKey('stack-runtime'), 'project-context:stack-runtime');
});

test('PROJECT_CONTEXT_KINDS lists all 10 base memories', () => {
  assert.deepEqual(PROJECT_CONTEXT_KINDS, [
    'stack-runtime',
    'dependencies-summary',
    'integrations-summary',
    'architecture-current',
    'architecture-target',
    'structure-summary',
    'technical-rules',
    'project-requirements',
    'known-issues-and-fixes',
    'module-minimap',
  ]);
});

test('createMaterializedProjectContext fills required fields', () => {
  const result = createMaterializedProjectContext({
    kind: 'technical-rules',
    title: 'Technical rules',
    summary: 'Follow existing structure and conventions.',
    body: '- Prefer focused edits.\n- Keep files in existing module boundaries.',
    tags: ['project-context', 'rules', 'project:demo'],
    sourceFiles: ['README.md'],
    graphRefs: [],
    sourceMode: 'merged',
    confidence: 'high',
    detectedSources: ['detected-rules.json'],
    declaredSources: ['technical-rules.json'],
    updatedAt: '2026-05-17T00:00:00.000Z',
  });

  assert.equal(result.memory_key, 'project-context:technical-rules');
  assert.equal(result.kind, 'technical-rules');
  assert.equal(result.source_mode, 'merged');
  assert.equal(result.confidence, 'high');
  assert.match(result.content_hash, /^[a-f0-9]{64}$/);
});
