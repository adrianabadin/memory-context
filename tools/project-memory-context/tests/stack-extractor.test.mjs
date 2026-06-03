import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectStackContext } from '../src/extractors/stack-extractor.mjs';

test('detectStackContext reads package.json and tsconfig.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-stack-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'demo',
    packageManager: 'npm@10.8.0',
    dependencies: { react: '^19.0.0', next: '^15.0.0', zod: '^3.24.0' },
    devDependencies: { typescript: '^5.0.0', vitest: '^2.0.0' },
  }), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'db.ts'), "import { createClient } from '@supabase/supabase-js';\n", 'utf8');

  const result = await detectStackContext(root);

  assert.equal(result.languages.includes('typescript'), true);
  assert.equal(result.packageManagers[0], 'npm@10.8.0');
  assert.equal(result.frameworks.includes('next'), true);
  assert.equal(result.dependenciesSummary.critical.includes('react'), true);
  assert.equal(result.integrations.detectedServices.includes('supabase'), true);
});
