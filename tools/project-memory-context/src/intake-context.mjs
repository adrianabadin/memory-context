function normalizeString(value) {
  return String(value ?? '').trim();
}

function normalizeList(values) {
  return Array.from(new Set((values ?? []).map((value) => normalizeString(value)).filter(Boolean)));
}

export function buildIntakeContext({ projectDescription, mappingGoals, focusAreas = [] }) {
  return {
    projectDescription: normalizeString(projectDescription),
    mappingGoals: normalizeList(mappingGoals),
    focusAreas: normalizeList(focusAreas),
    createdAt: new Date().toISOString(),
  };
}
