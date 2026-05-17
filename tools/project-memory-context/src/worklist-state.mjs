export function updateWorklistEntry(worklist, symbolKey, updates) {
  return (worklist ?? []).map((entry) => {
    if (entry.symbolKey !== symbolKey) {
      return entry;
    }

    return {
      ...entry,
      ...updates,
    };
  });
}
