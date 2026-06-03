export function createDeclaredProjectContextTemplates({
  architectureTarget = '',
  technicalRules = [],
  projectRequirements = [],
  knownIssuesAndFixes = [],
} = {}) {
  return {
    'architecture-target.json': {
      title: 'Target project architecture',
      architecture: architectureTarget,
    },
    'technical-rules.json': {
      title: 'Technical rules',
      rules: technicalRules,
    },
    'project-requirements.json': {
      title: 'Project requirements',
      requirements: projectRequirements,
    },
    'known-issues-and-fixes.json': {
      title: 'Known issues and fixes',
      items: knownIssuesAndFixes,
    },
  };
}
