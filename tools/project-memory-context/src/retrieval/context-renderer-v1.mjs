export function renderTargetContext({ summary = [], target = {}, relevant = [], relations = [], nextReads = [], metadata = {}, source } = {}) {
  const lines = [];

  // ── Staleness banner (shown first when source is stale) ──────────
  if (source?.fresh === false) {
    lines.push('⚠️  STALE: file changed since last enrichment — run `pmc refresh-context`. Showing current disk content.');
    lines.push('');
  }

  lines.push('Summary');
  if (summary.length > 0) {
    for (const s of summary) {
      lines.push(`- ${s}`);
    }
  } else {
    lines.push('- none');
  }

  lines.push('Target');
  if (target.mode != null) lines.push(`  mode: ${target.mode}`);
  if (target.name != null) lines.push(`  name: ${target.name}`);
  if (target.value != null) lines.push(`  value: ${target.value}`);
  if (target.filePath != null) lines.push(`  filePath: ${target.filePath}`);
  if (target.range != null) lines.push(`  range: ${target.range.startLine}-${target.range.endLine}`);
  if (target.communityName != null) lines.push(`  community: ${target.communityName}`);

  lines.push('Relevant');
  if (relevant.length > 0) {
    for (const r of relevant) {
      const display = r.filePath ?? r.label ?? 'unknown';
      lines.push(`- ${display}`);
    }
  } else {
    lines.push('- none');
  }

  lines.push('Relations');
  if (relations.length > 0) {
    for (const rel of relations) {
      const itemsStr = (rel.items ?? []).join(', ');
      lines.push(`- ${rel.kind}: ${itemsStr}`);
    }
  } else {
    lines.push('- none');
  }

  lines.push('Next Reads');
  if (nextReads.length > 0) {
    for (const nr of nextReads) {
      lines.push(`- ${nr}`);
    }
  } else {
    lines.push('- none');
  }

  lines.push('Metadata');
  if (metadata.depth != null) lines.push(`  depth: ${metadata.depth}`);
  if (metadata.focus != null) lines.push(`  focus: ${metadata.focus}`);

  // ── Source section (disk / cache) ────────────────────────────────
  if (source != null) {
    lines.push('');
    if (source.error) {
      lines.push(`Source (disk)`);
      lines.push(`  error: ${source.error}`);
    } else if (source.code != null) {
      const label = source.source === 'cache' ? 'Source (cache — unverified)' : 'Source (disk)';
      lines.push(label);
      if (source.source === 'cache') {
        lines.push('  ⚠️  Unverified cache hit — content may be stale. Run `pmc refresh-context` to validate.');
      }
      lines.push('```');
      lines.push(source.code);
      lines.push('```');
      if (source.fresh === true) {
        lines.push(`  ✅ fresh (hash verified)`);
      }
    }
  }

  // ── Semantic Memory (linked memories from symbol links) ─────────
  if (target.linkedMemories?.length > 0) {
    lines.push('');
    lines.push('Semantic Memory');
    for (const mem of target.linkedMemories) {
      const typeTag = mem.type ? ` (${mem.type})` : '';
      lines.push(`- ${mem.content}${typeTag}`);
    }
  }

  return lines.join('\n');
}
