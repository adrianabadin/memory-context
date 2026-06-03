import test from 'node:test';
import assert from 'node:assert/strict';

import { materializeProjectContextMemories } from '../src/materializer.mjs';

test('materializeProjectContextMemories creates 9 materialized memories', () => {
  const result = materializeProjectContextMemories({
    projectSlug: 'demo',
    detected: {
      stack: { languages: ['typescript'], runtimes: ['node'], frameworks: ['next'], packageManagers: ['npm@10'], buildTools: ['typescript'], dependenciesSummary: { critical: ['next'], testing: [] }, integrations: { detectedServices: ['supabase'] } },
      structure: { rootDirectories: ['src'], keySubtrees: ['src/services'], entryPoints: ['src/main.ts'] },
      architecture: { pattern: 'detected-structure', entryPoints: ['src/main.ts'], graphRefs: ['node:src/main.ts'] },
      rules: { rules: ['Use pnpm.'] },
    },
    declared: {
      architectureTarget: { architecture: 'Layered architecture.' },
      technicalRules: { rules: ['Keep services pure.'] },
      projectRequirements: { requirements: ['Track sessions.'] },
      knownIssuesAndFixes: { items: [{ symptom: 'Build fails', workaround: 'Reinstall deps.' }] },
    },
    updatedAt: '2026-05-17T00:00:00.000Z',
  });

  assert.equal(result.length, 9);
  assert.equal(result.find((item) => item.kind === 'stack-runtime').tags.includes('project:demo'), true);
  assert.equal(result.find((item) => item.kind === 'architecture-target').body.includes('Layered architecture.'), true);
  assert.equal(result.find((item) => item.kind === 'known-issues-and-fixes').body.includes('Build fails'), true);
});
