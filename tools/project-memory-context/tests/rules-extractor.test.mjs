import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRulesContext } from '../src/extractors/rules-extractor.mjs';

test('detectRulesContext extracts rules from readme text', async () => {
  const result = await detectRulesContext({
    readmeText: 'Use pnpm. Avoid editing generated files. Keep domain logic in src/domain.',
  });

  assert.equal(result.rules.includes('Use pnpm.'), true);
  assert.equal(result.rules.includes('Avoid editing generated files.'), true);
});
