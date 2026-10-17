import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic-write.mjs';

function spliceMarkdownMarkerBlock(existingContent, blockContent, markerName) {
  const startMarker = `<!-- pmc:${markerName} -->`;
  const endMarker = `<!-- /pmc:${markerName} -->`;

  const startIndex = existingContent.indexOf(startMarker);
  const endIndex = existingContent.indexOf(endMarker);

  const blockToInsert = blockContent.includes(startMarker)
    ? blockContent
    : `${startMarker}\n${blockContent}\n${endMarker}`;

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = existingContent.slice(0, startIndex);
    const after = existingContent.slice(endIndex + endMarker.length);
    return (before + blockToInsert + after).replace(/\n{3,}/g, '\n\n');
  }

  if (existingContent.trim().length === 0) {
    return blockToInsert + '\n';
  }

  const prefix = existingContent.endsWith('\n\n')
    ? existingContent
    : existingContent.endsWith('\n')
      ? `${existingContent}\n`
      : `${existingContent}\n\n`;

  return prefix + blockToInsert + '\n';
}

export async function mergeMarkdownBlock(filePath, blockContent, markerName) {
  let existingContent = '';
  try {
    existingContent = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const newContent = spliceMarkdownMarkerBlock(existingContent, blockContent, markerName);

  if (existingContent === newContent) {
    return { status: 'unchanged' };
  }

  await writeAtomic(filePath, newContent);
  return { status: 'installed' };
}
