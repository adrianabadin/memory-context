import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { Query } from 'web-tree-sitter';
import { initParser, loadLanguage } from './runtime.mjs';
import { languageForExtension } from './language-map.mjs';
import { hashSymbol } from '../../hash.mjs';
import { buildSymbolKey } from '../../symbol-keys.mjs';

// Cache for loaded query text
const queryCache = new Map();

async function loadQuery(language) {
  if (queryCache.has(language)) return queryCache.get(language);
  const url = new URL(`./queries/${language}.scm`, import.meta.url);
  const text = await readFile(fileURLToPath(url), 'utf-8');
  queryCache.set(language, text);
  return text;
}

// Map capture names to canonical kinds
const CAPTURE_TO_KIND = {
  class: 'class',
  function: 'function',
  interface: 'interface',
  type: 'type',
};

/**
 * Determine if a node is at the top level of the file (not nested inside
 * another class/function body). For Python the module is the direct parent;
 * for other languages the root node (program/source_file/…) is the parent.
 * C++ nodes inside a namespace are also considered top-level.
 */
function isTopLevel(node) {
  const parentType = node.parent?.type;
  if (!parentType) return true;
  // Python: module; JS/TS: program; Go/Rust/Java/etc: source_file; C++: translation_unit
  if (
    parentType === 'module' ||
    parentType === 'program' ||
    parentType === 'source_file' ||
    parentType === 'translation_unit'
  ) return true;
  // C++: class/struct inside a namespace — parent is declaration_list whose parent is namespace_definition
  if (parentType === 'declaration_list' && node.parent?.parent?.type === 'namespace_definition') return true;
  return false;
}

/**
 * Infer export scope based on language conventions and symbol name.
 */
function inferExportScope(language, name, node) {
  switch (language) {
    case 'python':
      return name.startsWith('_') ? 'local' : 'exported';

    case 'go':
      // Uppercase first letter → exported (Go convention)
      return name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()
        ? 'exported'
        : 'local';

    case 'rust': {
      // Check the symbol node's own text for 'pub' visibility modifier
      // (parent is source_file or declaration_list which may span many items)
      const nodeText = node.text ?? '';
      return nodeText.trimStart().startsWith('pub ') ? 'exported' : 'local';
    }

    case 'java':
    case 'csharp':
    case 'kotlin': {
      const parentText = node.parent?.text ?? '';
      return parentText.includes('public') ? 'exported' : 'local';
    }

    case 'typescript':
    case 'tsx':
    case 'javascript': {
      // For TS/JS, check if the node or its parent is an export_statement
      // or if the parent text starts with 'export'
      const parent = node.parent;
      if (parent?.type === 'export_statement') return 'exported';
      if (parent?.parent?.type === 'export_statement') return 'exported';
      const grandParentText = parent?.parent?.text ?? '';
      if (grandParentText.trimStart().startsWith('export')) return 'exported';
      const parentText2 = parent?.text ?? '';
      if (parentText2.trimStart().startsWith('export')) return 'exported';
      return 'local';
    }

    // ruby, php, swift, cpp — all public by convention
    default:
      return 'exported';
  }
}

function normalizeLanguageName(rawLanguage) {
  // tree-sitter language names vs PMC language names
  if (rawLanguage === 'typescript') return 'ts';
  if (rawLanguage === 'tsx') return 'tsx';
  if (rawLanguage === 'javascript') return 'js';
  return rawLanguage;
}

/**
 * Extract symbols from a single file using tree-sitter.
 *
 * @param {{ filePath: string, content: string }} opts
 * @returns {Promise<Array>} array of symbol objects
 */
export async function extractSymbolsForFile({ filePath, content }) {
  const ext = extname(filePath).toLowerCase();
  const rawLanguage = languageForExtension(ext);
  if (!rawLanguage) return [];

  // Check we have a query file for this language
  let queryText;
  try {
    queryText = await loadQuery(rawLanguage);
  } catch {
    // No query file for this language yet — skip silently
    return [];
  }

  const parser = await initParser();
  const lang = await loadLanguage(rawLanguage);
  parser.setLanguage(lang);

  const tree = parser.parse(content);

  let query;
  try {
    query = new Query(lang, queryText);
  } catch (e) {
    throw new Error(`Failed to compile tree-sitter query for ${rawLanguage}: ${e.message}`);
  }

  const captures = query.captures(tree.rootNode);
  const language = normalizeLanguageName(rawLanguage);
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const lines = content.split('\n');

  // Group captures: we get pairs of (kind-capture, name-capture) per symbol.
  // We want only top-level symbols. Walk captures in order; when we see a
  // kind capture (@class / @function / …) followed by a @name capture for the
  // same subtree, emit a symbol.
  const seen = new Set(); // deduplicate by startRow+name
  const symbolPromises = [];

  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i];
    const captureName = cap.name;
    const kind = CAPTURE_TO_KIND[captureName];
    if (!kind) continue; // skip @name captures in this loop — handled below

    const symbolNode = cap.node;

    // Only top-level symbols
    if (!isTopLevel(symbolNode)) continue;

    // Find the associated @name capture (next capture that is 'name' and whose
    // node is a descendant of symbolNode)
    let nameNode = null;
    for (let j = i + 1; j < captures.length; j++) {
      if (captures[j].name === 'name' && symbolNode.startIndex <= captures[j].node.startIndex && captures[j].node.endIndex <= symbolNode.endIndex) {
        nameNode = captures[j].node;
        break;
      }
    }
    if (!nameNode) continue;

    const name = nameNode.text;
    const startLine = symbolNode.startPosition.row + 1; // 1-indexed
    const endLine = symbolNode.endPosition.row + 1;     // 1-indexed

    const dedupeKey = `${kind}:${name}:${startLine}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const exportScope = inferExportScope(rawLanguage, name, symbolNode);
    const codeFragment = lines.slice(startLine - 1, endLine).join('\n');

    symbolPromises.push(
      hashSymbol(codeFragment).then(codeHash => {
        const symbol = {
          language,
          filePath: normalizedFilePath,
          kind,
          name,
          exportScope,
          range: { startLine, endLine },
          codeHash,
        };
        symbol.symbolKey = buildSymbolKey(symbol);
        return symbol;
      })
    );
  }

  const symbols = await Promise.all(symbolPromises);
  symbols.sort((a, b) => a.range.startLine - b.range.startLine);
  return symbols;
}
