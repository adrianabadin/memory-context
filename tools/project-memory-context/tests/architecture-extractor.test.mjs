import test from 'node:test';
import assert from 'node:assert/strict';

import { detectArchitectureContext } from '../src/extractors/architecture-extractor.mjs';

test('detectArchitectureContext extracts node paths from graph', async () => {
  const graph = {
    nodes: [
      { id: '1', label: 'src/main.ts' },
      { id: '2', label: 'src/services/user.ts' },
    ],
    edges: [],
  };

  const result = await detectArchitectureContext({ graph });

  assert.deepEqual(result.entryPoints, ['src/main.ts']);
  assert.equal(result.graphRefs.includes('node:src/services/user.ts'), true);
});
