import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function detectServicesFromSrc(projectRoot) {
  const detected = new Set();
  try {
    const entries = await readdir(join(projectRoot, 'src'), { recursive: true });
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      if (!entry.endsWith('.js') && !entry.endsWith('.mjs') && !entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      const content = await readFile(join(projectRoot, 'src', entry), 'utf8');
      if (content.includes('@supabase/supabase-js')) detected.add('supabase');
      if (content.includes('stripe')) detected.add('stripe');
      if (content.includes('aws-sdk') || content.includes('@aws-sdk/')) detected.add('aws');
    }
  } catch {}
  return [...detected].sort();
}

export async function detectStackContext(projectRoot) {
  const packageJson = await readJson(join(projectRoot, 'package.json'));
  const tsconfig = await readJson(join(projectRoot, 'tsconfig.json'));
  const deps = packageJson?.dependencies ?? {};
  const devDeps = packageJson?.devDependencies ?? {};
  const allDeps = { ...deps, ...devDeps };
  return {
    languages: tsconfig ? ['typescript'] : [],
    runtimes: ['node'],
    frameworks: ['next', 'react'].filter((name) => name in allDeps),
    packageManagers: packageJson?.packageManager ? [packageJson.packageManager] : [],
    buildTools: ['typescript'].filter((name) => name in allDeps),
    dependenciesSummary: {
      critical: Object.keys(deps).filter((name) => ['react', 'next', 'zod'].includes(name)),
      testing: Object.keys(devDeps).filter((name) => ['vitest', 'jest'].includes(name)),
    },
    integrations: {
      detectedServices: await detectServicesFromSrc(projectRoot),
    },
  };
}
