import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSemanticReport } from '../src/semantic-report.mjs';

test('normalizeSemanticReport extracts structured semantic fields from report findings', () => {
  const semantic = normalizeSemanticReport({
    summary: 'Fetches a user and normalizes the response.',
    findings: [
      'responsibility: Fetches a user and normalizes the response.',
      'inputs: id, includePosts',
      'output: Normalized user object or null.',
      'dependencies: api.get, normalizeUser',
      'role: Main retrieval entry point for the module.',
    ],
  });

  assert.deepEqual(semantic, {
    responsibility: 'Fetches a user and normalizes the response.',
    inputs: ['id', 'includePosts'],
    output: 'Normalized user object or null.',
    dependencies: ['api.get', 'normalizeUser'],
    role: 'Main retrieval entry point for the module.',
    summary: 'Fetches a user and normalizes the response.',
  });
});

test('normalizeSemanticReport falls back to summary when fields are missing', () => {
  const semantic = normalizeSemanticReport({
    summary: 'Small helper for successful MCP responses.',
    findings: [],
  });

  assert.equal(semantic.responsibility, 'Small helper for successful MCP responses.');
  assert.deepEqual(semantic.inputs, []);
  assert.equal(semantic.output, 'Not specified.');
  assert.deepEqual(semantic.dependencies, []);
  assert.equal(semantic.role, 'Not specified.');
});
