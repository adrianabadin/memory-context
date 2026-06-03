export function renderProjectContextMarkdown(memory) {
  const sourceFiles = (memory.source_files ?? []).map((file) => `- \`${file}\``).join('\n') || '- None';
  const graphRefs = (memory.graph_refs ?? []).map((ref) => `- \`${ref}\``).join('\n') || '- None';
  return [
    `# ${memory.title}`,
    '',
    `**Kind:** ${memory.kind}`,
    `**Updated:** ${memory.updated_at}`,
    '',
    '## Summary',
    '',
    memory.summary,
    '',
    '## Body',
    '',
    memory.body,
    '',
    '## Source Files',
    '',
    sourceFiles,
    '',
    '## Graph References',
    '',
    graphRefs,
    '',
  ].join('\n');
}
