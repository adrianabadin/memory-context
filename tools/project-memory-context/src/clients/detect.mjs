import { existsSync } from 'node:fs';
import { join } from 'node:path';

const GENERIC_ID = 'generic';

function uniqueOrdered(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (item == null || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function listDetected({ registry, projectRoot, exists }) {
  const probe = exists ?? existsSync;
  const detected = [];
  for (const adapter of registry) {
    const markers = adapter.markers ?? {};
    let matched = false;
    for (const dir of markers.project ?? []) {
      if (probe(join(projectRoot, dir))) { matched = true; break; }
    }
    if (!matched) {
      for (const file of markers.instructionFiles ?? []) {
        if (probe(join(projectRoot, file))) { matched = true; break; }
      }
    }
    if (matched) detected.push(adapter.id);
  }
  return detected;
}

function listExplicit({ registry, flags, csvClients }) {
  const out = [];
  for (const adapter of registry) {
    const flagsList = adapter.flags ?? [];
    if (flags && flags.some((f) => flagsList.includes(f))) out.push(adapter.id);
  }
  if (Array.isArray(csvClients)) out.push(...csvClients.filter((c) => typeof c === 'string' && c.length > 0));
  return out;
}

export function selectClients({
  projectRoot,
  registry,
  exists,
  flags = [],
  csvClients,
  homeDir,
} = {}) {
  if (!Array.isArray(registry) || registry.length === 0) {
    return { source: 'detected', clientIds: [GENERIC_ID] };
  }

  const explicit = listExplicit({ registry, flags, csvClients });
  if (explicit.length > 0) {
    const priority = (id) => {
      const adapter = registry.find((a) => a.id === id || a.legacyId === id);
      return adapter ? adapter.priority : Number.POSITIVE_INFINITY;
    };
    const ids = uniqueOrdered(explicit).sort((a, b) => priority(a) - priority(b));
    return { source: 'flag', clientIds: ids };
  }

  const detected = listDetected({ registry, projectRoot, exists });
  if (detected.length === 0) {
    if (homeDir && (exists ?? existsSync)(join(homeDir, '.config', 'opencode'))) {
      return { source: 'detected', clientIds: ['opencode'] };
    }
    return { source: 'detected', clientIds: [GENERIC_ID] };
  }

  const priority = (id) => {
    const adapter = registry.find((a) => a.id === id);
    return adapter ? adapter.priority : Number.POSITIVE_INFINITY;
  };
  const ids = uniqueOrdered(detected).sort((a, b) => priority(a) - priority(b));
  return { source: 'detected', clientIds: ids };
}

export function parseClientCsv(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  return uniqueOrdered(value.split(',').map((s) => s.trim()).filter(Boolean));
}
