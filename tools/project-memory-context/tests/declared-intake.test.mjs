import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeclaredProjectContextTemplates } from '../src/declared-intake.mjs';

test('createDeclaredProjectContextTemplates returns all declared files', () => {
  const result = createDeclaredProjectContextTemplates({
    architectureTarget: 'Layered architecture.',
    technicalRules: ['Keep services pure.'],
    projectRequirements: ['System tracks sessions.'],
    knownIssuesAndFixes: [],
  });

  assert.equal(result['architecture-target.json'].title, 'Target project architecture');
  assert.deepEqual(result['technical-rules.json'].rules, ['Keep services pure.']);
  assert.deepEqual(result['project-requirements.json'].requirements, ['System tracks sessions.']);
  assert.deepEqual(result['known-issues-and-fixes.json'].items, []);
});
