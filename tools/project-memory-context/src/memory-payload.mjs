function normalizeList(values) {
  return (values ?? []).map((value) => String(value).trim()).filter(Boolean);
}

export function buildMemoryPayload({ projectSlug, job, semantic }) {
  const inputs = normalizeList(semantic.inputs);
  const dependencies = normalizeList(semantic.dependencies);
  const tags = [
    'symbol',
    job.language,
    job.kind,
    `project:${projectSlug}`,
    `file:${job.filePath}`,
  ];

  const content = [
    `Symbol: ${job.name}`,
    `Kind: ${job.kind}`,
    `Language: ${job.language}`,
    `Location: ${job.filePath}:${job.range.startLine}-${job.range.endLine}`,
    '',
    'Responsibility:',
    semantic.responsibility,
    '',
    'Inputs:',
    ...(inputs.length > 0 ? inputs.map((input) => `- ${input}`) : ['- None detected']),
    '',
    'Output:',
    semantic.output,
    '',
    'Immediate dependencies:',
    ...(dependencies.length > 0 ? dependencies.map((dependency) => `- ${dependency}`) : ['- None detected']),
    '',
    'Role in module:',
    semantic.role,
  ].join('\n');

  return {
    content,
    category: 'architecture',
    tags,
  };
}

export function buildEnrichmentResult({ job, memoryId, semanticSummary, status, enrichedAt }) {
  return {
    symbolKey: job.symbolKey,
    graphNodeId: job.graphNodeId ?? null,
    memoryId,
    codeHash: job.codeHash,
    semanticSummary,
    status,
    enrichedAt,
  };
}
