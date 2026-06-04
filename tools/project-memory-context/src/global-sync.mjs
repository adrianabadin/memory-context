// tools/project-memory-context/src/global-sync.mjs

/**
 * Parse KNOWN-ISSUES-AND-FIXES.md into payloads suitable for `record_error`.
 *
 * Expected section format in the Body:
 *   ### Issue: <message>
 *   **Root cause:** <text>       (optional)
 *   **Fix:** <text>              (required)
 *   **Files:** file1, file2      (optional)
 *   **Tags:** tag1, tag2         (optional)
 *
 * @param {string} markdown
 * @returns {Array<{message: string, rootCause: string|null, fix: string, files: string[], tags: string[]}>}
 */
export function parseKnownIssuesMarkdown(markdown) {
  const results = [];

  // Extract the Body section
  const bodyMatch = markdown.match(/##\s+Body\s*\n([\s\S]*?)(?=\n##\s|\s*$)/);
  if (!bodyMatch) return results;

  const body = bodyMatch[1];

  // Split into issue blocks by "### Issue:" heading
  const issueBlocks = body.split(/\n(?=###\s+Issue:)/);

  for (const block of issueBlocks) {
    const messageMatch = block.match(/###\s+Issue:\s*(.+)/);
    if (!messageMatch) continue;

    const message = messageMatch[1].trim();

    const fixMatch = block.match(/\*\*Fix:\*\*\s*(.+)/);
    if (!fixMatch) continue; // fix is required

    const fix = fixMatch[1].trim();

    const rootCauseMatch = block.match(/\*\*Root cause:\*\*\s*(.+)/);
    const rootCause = rootCauseMatch ? rootCauseMatch[1].trim() : null;

    const filesMatch = block.match(/\*\*Files:\*\*\s*(.+)/);
    const files = filesMatch
      ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean)
      : [];

    const tagsMatch = block.match(/\*\*Tags:\*\*\s*(.+)/);
    const tags = tagsMatch
      ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
      : [];

    results.push({ message, rootCause, fix, files, tags });
  }

  return results;
}

/**
 * Read KNOWN-ISSUES-AND-FIXES.md from the PMC planning dir and return
 * payloads ready for the `record_error` MCP tool.
 *
 * @param {string} pmcRoot - The .planning/project-memory-context dir
 * @param {string} projectId - The global project ID
 * @returns {Promise<Array>}
 */
export async function buildErrorPayloads(pmcRoot, projectId) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const mdPath = join(pmcRoot, 'project-context', 'markdown', 'KNOWN-ISSUES-AND-FIXES.md');
  let markdown;
  try {
    markdown = await readFile(mdPath, 'utf8');
  } catch {
    return []; // File doesn't exist yet — no errors to promote
  }

  const parsed = parseKnownIssuesMarkdown(markdown);
  return parsed.map(item => ({
    projectId,
    message: item.message,
    rootCause: item.rootCause ?? undefined,
    fix: item.fix,
    files: item.files.length > 0 ? item.files : undefined,
    tags: item.tags.length > 0 ? item.tags : undefined,
    source: 'auto',
  }));
}
