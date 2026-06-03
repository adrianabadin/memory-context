export function detectChangedFilesFromHashes(previousHashes, nextHashes) {
  const changed = [];
  const files = new Set([...Object.keys(previousHashes), ...Object.keys(nextHashes)]);
  for (const file of files) {
    if (previousHashes[file] !== nextHashes[file]) {
      changed.push(file);
    }
  }
  return changed;
}
