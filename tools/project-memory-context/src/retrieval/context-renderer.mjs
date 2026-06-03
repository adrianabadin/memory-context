import { createDepthConfig } from './query-engine.mjs';

export function renderContext({ target, neighbors, edges, depth, depthReached, projectBase, memoryContents, sourceCode }) {
  const config = createDepthConfig(depth);
  const maxChars = config.maxTokens * 4;

  const sections = [];

  if (projectBase) {
    sections.push(`## Project Base\nStack: ${projectBase.stack} | Architecture: ${projectBase.architecture}`);
  }

  const enrichment = target.memoryId ? (memoryContents.get(target.memoryId) ?? '') : '';
  const rangeStr = target.range ? ` (L${target.range.startLine}-${target.range.endLine})` : '';
  let targetSection = `### Target: ${target.name} (${target.kind})\nFile: ${target.filePath}${rangeStr}`;
  if (enrichment) {
    targetSection += `\n${enrichment}`;
  }
  sections.push(targetSection);

  if (neighbors.length > 0 && depth !== 'compact' || neighbors.length > 0 && depth === 'compact') {
    const edgeMap = new Map();
    for (const edge of edges) {
      if (!edgeMap.has(edge.target)) edgeMap.set(edge.target, []);
      edgeMap.get(edge.target).push(edge);
      if (!edgeMap.has(edge.source)) edgeMap.set(edge.source, []);
      edgeMap.get(edge.source).push(edge);
    }

    const lines = [];
    for (const nb of neighbors) {
      const nbEnrichment = nb.memoryId ? (memoryContents.get(nb.memoryId) ?? '') : '';
      const firstLine = nbEnrichment ? nbEnrichment.split('\n')[0] : '';

      const relEdge = edges.find(e => e.source === nb.graphNodeId || e.target === nb.graphNodeId);
      const relation = relEdge ? relEdge.relation : '';
      const dir = relEdge ? (relEdge.source === target.graphNodeId ? '→' : '←') : '';

      let bullet = `- **${nb.name}** (${nb.kind}) ${dir} ${relation}`;
      if (nb.filePath && nb.filePath !== target.filePath) {
        bullet += ` — ${nb.filePath}`;
      }
      if (firstLine) {
        bullet += `\n  ${firstLine}`;
      }
      lines.push(bullet);
    }

    if (lines.length > 0) {
      sections.push(`### Structural Neighbors\n${lines.join('\n')}`);
    }
  }

  if (depth === 'extended' || depth === 'deep' || depth === 'disk') {
    const communities = new Map();
    for (const nb of neighbors) {
      const comm = nb.community ?? 'default';
      if (!communities.has(comm)) communities.set(comm, []);
      communities.get(comm).push(nb);
    }
    if (communities.size > 0 && !(communities.size === 1 && communities.has('default'))) {
      const commLines = [];
      for (const [comm, members] of communities) {
        if (comm === 'default') continue;
        commLines.push(`- **${comm}**: ${members.map(m => m.name).join(', ')}`);
      }
      if (commLines.length > 0) {
        sections.push(`### Module Communities\n${commLines.join('\n')}`);
      }
    }
  }

  if (depth === 'deep' || depth === 'disk') {
    const inbound = edges.filter(e => e.target === target.graphNodeId);
    if (inbound.length > 0) {
      const impactLines = inbound.map(e => {
        const srcNode = neighbors.find(n => n.graphNodeId === e.source);
        const srcName = srcNode ? srcNode.name : e.source;
        return `- ${srcName} — ${e.relation}`;
      });
      sections.push(`### Impact Scope\n${impactLines.join('\n')}`);
    }
  }

  if (depth === 'disk' && sourceCode) {
    sections.push(`### Source Code\n\`\`\`\n${sourceCode}\n\`\`\``);
  }

  const header = `## Context: ${target.name}`;
  let result = header + '\n\n' + sections.join('\n\n');

  if (result.length > maxChars) {
    result = result.slice(0, maxChars);
  }

  return result;
}
