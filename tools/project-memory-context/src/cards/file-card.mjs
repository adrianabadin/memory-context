import { posix } from 'node:path';
import { buildFacts } from './facts.mjs';

const compare = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Pure read-only file card with canonical symbol/file links. */
export function buildFileCard(graphDb, filePath) {
  if (!graphDb || typeof graphDb.getNodesByFile !== 'function') {
    throw new TypeError('buildFileCard requires a GraphStore read surface');
  }
  if (typeof filePath !== 'string' || !filePath || /[\u0000-\u001f\u007f|]/.test(filePath)) {
    throw new TypeError('filePath must be a nonempty project-relative file path');
  }
  const slashPath = filePath.replace(/\\/g, '/');
  const path = posix.normalize(slashPath);
  if (posix.isAbsolute(slashPath) || /^[a-z]:/i.test(path) || path === '.' || path === '..' || path.startsWith('../') || path.endsWith('/')) {
    throw new TypeError('filePath must identify a file inside the project');
  }
  const registry = new Map();
  for (const node of graphDb.getNodesByFile(path)) {
    if (!['symbol', 'member'].includes(node.node_kind)) continue;
    const symbolKey = node.symbolKey ?? node.metadata?.symbolKey ?? node.id;
    if (typeof symbolKey !== 'string') continue;
    const parts = symbolKey.split('|');
    if (parts.length !== 6 || parts.some(part => !part) || parts[1] !== path) continue;
    const item = { id: node.id, symbolKey, kind: node.kind ?? parts[2] };
    const entry = { item, exported: parts[3] === 'exported', member: node.node_kind === 'member' };
    if (!registry.has(symbolKey)) registry.set(symbolKey, []);
    registry.get(symbolKey).push(entry);
  }
  // Never let a Map overwrite turn a canonical collision into uniqueness.
  const symbols = [...registry.values()].filter(group => group.length === 1).map(group => group[0]);
  const facts = buildFacts(graphDb, `file|${path}`);
  const fileLinks = items => items.map(item => ({ id: `file|${item.path}`, path: item.path, kind: 'file' }));
  return {
    path,
    kind: 'file',
    ...(facts.roleClassification != null ? { roleClassification: facts.roleClassification } : {}),
    exports: symbols.filter(symbol => symbol.exported).map(symbol => symbol.item).sort(compare),
    importsFrom: fileLinks(facts.imports),
    importedBy: fileLinks(facts.importedBy),
    symbolCount: symbols.length,
    members: symbols.filter(symbol => symbol.member).map(symbol => symbol.item).sort(compare),
  };
}
