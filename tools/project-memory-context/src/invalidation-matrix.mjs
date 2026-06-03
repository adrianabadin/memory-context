import { isAgentInstructionFile, normalizeProjectPath } from './platform.mjs';

const PACKAGE_FILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'global.json']);

export function detectInvalidatedProjectContextKinds(changedFiles) {
  const invalidated = new Set();
  for (const file of changedFiles) {
    const normalizedFile = normalizeProjectPath(file);

    if (PACKAGE_FILES.has(normalizedFile) || normalizedFile.endsWith('.csproj')) {
      invalidated.add('stack-runtime');
      invalidated.add('dependencies-summary');
      invalidated.add('integrations-summary');
    }
    if (normalizedFile.startsWith('.planning/project-memory-context/project-context/declared/technical-rules')) {
      invalidated.add('technical-rules');
    }
    if (normalizedFile.startsWith('.planning/project-memory-context/project-context/declared/project-requirements')) {
      invalidated.add('project-requirements');
    }
    if (normalizedFile.startsWith('.planning/project-memory-context/project-context/declared/known-issues-and-fixes')) {
      invalidated.add('known-issues-and-fixes');
    }
    if (normalizedFile.startsWith('.planning/project-memory-context/project-context/declared/architecture-target')) {
      invalidated.add('architecture-target');
    }
    if (normalizedFile === 'README.md' || isAgentInstructionFile(normalizedFile)) {
      invalidated.add('technical-rules');
      invalidated.add('project-requirements');
    }
  }
  return [...invalidated];
}
