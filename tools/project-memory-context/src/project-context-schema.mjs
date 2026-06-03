import { createHash } from 'node:crypto';

export const PROJECT_CONTEXT_KINDS = [
  'stack-runtime',
  'dependencies-summary',
  'integrations-summary',
  'architecture-current',
  'architecture-target',
  'structure-summary',
  'technical-rules',
  'project-requirements',
  'known-issues-and-fixes',
  'module-minimap',
];

export function buildProjectContextMemoryKey(kind) {
  if (!PROJECT_CONTEXT_KINDS.includes(kind)) {
    throw new Error(`Unknown project context kind: ${kind}`);
  }
  return `project-context:${kind}`;
}

export function hashProjectContextContent(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createMaterializedProjectContext({
  kind,
  title,
  summary,
  body,
  tags,
  sourceFiles,
  graphRefs,
  sourceMode,
  confidence,
  detectedSources = [],
  declaredSources = [],
  updatedAt,
}) {
  const contentShape = { title, summary, body, tags, sourceFiles, graphRefs, sourceMode, confidence, detectedSources, declaredSources };
  return {
    memory_key: buildProjectContextMemoryKey(kind),
    title,
    kind,
    source_mode: sourceMode,
    summary,
    body,
    tags,
    source_files: sourceFiles,
    graph_refs: graphRefs,
    detected_sources: detectedSources,
    declared_sources: declaredSources,
    confidence,
    content_hash: hashProjectContextContent(contentShape),
    updated_at: updatedAt,
  };
}
