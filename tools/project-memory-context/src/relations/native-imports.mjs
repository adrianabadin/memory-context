import { posix } from 'node:path';
import { initParser, loadLanguage } from '../extractors/tree-sitter/runtime.mjs';
import { languageForExtension } from '../extractors/tree-sitter/language-map.mjs';

const EXTENSIONS = ['.js', '.jsx', '.mjs', '.ts', '.tsx'];
const LANGUAGES = new Set(['javascript', 'typescript', 'tsx']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const endpoint = path => ({ id: `file|${path}`, kind: 'file', path });

function canonicalPath(path) {
  if (typeof path !== 'string' || !path || /[\u0000-\u001f\u007f|]/.test(path)) {
    throw new TypeError('Native relation paths must be nonempty project-relative strings without control characters or |');
  }
  const slashPath = path.replace(/\\/g, '/');
  const normalized = posix.normalize(slashPath);
  if (posix.isAbsolute(slashPath) || /^[a-z]:/i.test(normalized) || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.endsWith('/')) {
    throw new TypeError('Native relation paths must identify files inside the project');
  }
  return normalized;
}

function supported(path) {
  return LANGUAGES.has(languageForExtension(posix.extname(path)));
}

// This is structural resolution against the complete supplied inventory, not
// Node/tsconfig/package resolution. Never prefer one extension or index file
// when several candidates exist, even if a runtime resolver would do so.
function resolveModule(sourcePath, specifier, inventory) {
  if (specifier === null || /[\\\u0000-\u001f\u007f?#]/.test(specifier)) return { reason: 'unsupported-specifier' };
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return { reason: 'external-module' };
  const base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  if (base === '..' || base.startsWith('../')) return { reason: 'outside-project' };
  const paths = EXTENSIONS.includes(posix.extname(base))
    ? [base]
    : [base, ...EXTENSIONS.map(ext => `${base}${ext}`), ...EXTENSIONS.map(ext => posix.join(base, `index${ext}`))];
  const candidates = [...new Set(paths)].filter(path => inventory.has(path));
  if (candidates.length === 0) return { reason: 'missing-module' };
  if (candidates.length !== 1) return { reason: 'ambiguous-module' };
  const targetPath = candidates[0];
  if (inventory.get(targetPath).length !== 1) return { reason: 'file-collision' };
  if (!supported(targetPath)) return { reason: 'unsupported-language' };
  return { target: endpoint(targetPath) };
}

function literal(node) {
  if (node?.type !== 'string') return null;
  return node.text.slice(1, -1); // escaped literals remain unresolved; no guessed decoding
}

function importBindings(node, typeOnly) {
  const bindings = [];
  const clause = node.namedChildren.find(c => c.type === 'import_clause');
  for (const child of clause?.namedChildren ?? []) {
    if (child.type === 'identifier') bindings.push({ imported: 'default', local: child.text, typeOnly });
    if (child.type === 'namespace_import') {
      const name = child.namedChildren.find(c => c.type === 'identifier');
      if (name) bindings.push({ imported: '*', local: name.text, typeOnly });
    }
    if (child.type === 'named_imports') {
      for (const spec of child.namedChildren.filter(c => c.type === 'import_specifier')) {
        const name = spec.childForFieldName('name');
        const alias = spec.childForFieldName('alias');
        if (name) bindings.push({
          imported: name.text, local: alias?.text ?? name.text,
          typeOnly: typeOnly || spec.children.some(c => c.type === 'type'),
        });
      }
    }
  }
  return bindings;
}

function* syntaxNodes(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    yield node;
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/**
 * Extract conservative static ESM file imports from caller-owned source text.
 * No filesystem scan, package/config resolution, symbol mutation or graph IO.
 * Only unique validated inventory paths become canonical `file|path` endpoints.
 * Bindings are raw syntax metadata, NEVER resolved symbol IDs. Unresolved
 * syntax contains no target; callers must not promote its specifier to an edge.
 *
 * @param {{files: Array<{path: string, content: string}>}} options
 * @returns {Promise<{files: Array, relations: Array, unresolved: Array}>}
 */
export async function extractNativeImports({ files } = {}) {
  if (!Array.isArray(files)) throw new TypeError('Native import files must be an array');
  const inventory = new Map();
  // Validate the whole input before using the parser; rejected inventories do
  // not partially emit facts or mutate caller-owned records.
  for (const file of files) {
    if (!file || typeof file.content !== 'string') throw new TypeError('Native import file content must be a string');
    const path = canonicalPath(file.path);
    if (!inventory.has(path)) inventory.set(path, []);
    inventory.get(path).push({ path, content: file.content });
  }

  const result = { files: [], relations: [], unresolved: [] };
  for (const path of [...inventory.keys()].sort(compare)) {
    const entries = inventory.get(path);
    if (entries.length !== 1) {
      result.unresolved.push({ relation: 'imports', source: null, path, specifier: null, bindings: [], typeOnly: false, range: null, reason: 'file-collision' });
      continue;
    }
    const source = endpoint(path);
    result.files.push(source);
    if (!supported(path)) {
      result.unresolved.push({ relation: 'imports', source, specifier: null, bindings: [], typeOnly: false, range: null, reason: 'unsupported-language' });
      continue;
    }
    const parser = await initParser();
    parser.setLanguage(await loadLanguage(languageForExtension(posix.extname(path))));
    const tree = parser.parse(entries[0].content);
    try {
      for (const node of syntaxNodes(tree.rootNode)) {
        let reason = null;
        let sourceNode = null;
        if (node.type === 'import_statement') {
          sourceNode = node.childForFieldName('source');
          if (node.hasError || node.parent?.type !== 'program') reason = 'invalid-syntax';
        } else if (node.type === 'export_statement' && node.childForFieldName('source')) {
          sourceNode = node.childForFieldName('source');
          reason = 'unsupported-reexport';
        } else if (node.type === 'call_expression') {
          const callee = node.childForFieldName('function');
          if (callee?.type === 'import') reason = 'dynamic-import';
          else if (callee?.type === 'identifier' && callee.text === 'require') reason = 'unsupported-commonjs';
          else continue;
          sourceNode = node.childForFieldName('arguments')?.namedChildren[0];
        } else continue;

        const typeOnly = node.type === 'import_statement' && node.children.some(c => c.type === 'type');
        const fact = {
          relation: 'imports', source, specifier: literal(sourceNode),
          bindings: node.type === 'import_statement' ? importBindings(node, typeOnly) : [],
          typeOnly, range: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
        };
        const resolution = reason ? { reason } : resolveModule(path, fact.specifier, inventory);
        if (resolution.target) result.relations.push({ ...fact, target: resolution.target });
        else result.unresolved.push({ ...fact, reason: resolution.reason });
      }
    } finally {
      tree.delete();
    }
  }
  return result;
}
