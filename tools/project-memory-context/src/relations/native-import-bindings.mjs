import { posix } from 'node:path';
import { extractNativeImports } from './native-imports.mjs';
import { extractSymbolsForFile } from '../extractors/tree-sitter/extract.mjs';
import { initParser, loadLanguage } from '../extractors/tree-sitter/runtime.mjs';
import { languageForExtension } from '../extractors/tree-sitter/language-map.mjs';

const add = (map, name, value) => map.set(name, [...(map.get(name) ?? []), value]);

// Additive API: the established file-import extractor output stays unchanged.
// Resolve explicit local exports only, against real AST spans and canonical
// extracted keys. Namespace imports and reexports never imply all symbols.
export async function extractNativeImportBindings({ files } = {}) {
  const result = await extractNativeImports({ files });
  const contents = new Map(files.map(file => [posix.normalize(file.path.replace(/\\/g, '/')), file.content]));
  const modules = new Map();
  for (const file of result.files) {
    const language = languageForExtension(posix.extname(file.path));
    if (!['javascript', 'typescript', 'tsx'].includes(language)) continue;
    const content = contents.get(file.path);
    const symbols = await extractSymbolsForFile({ filePath: file.path, content });
    const parser = await initParser(); parser.setLanguage(await loadLanguage(language));
    const tree = parser.parse(content);
    const declarations = new Map(); const exports = new Map();
    try {
      if (tree.rootNode.hasError) { modules.set(file.path, { declarations, exports }); continue; }
      const roots = tree.rootNode.namedChildren;
      for (const root of roots) {
        const node = root.type === 'export_statement' ? root.childForFieldName('declaration') : root;
        if (!node) continue;
        const candidates = ['lexical_declaration', 'variable_declaration'].includes(node.type)
          ? node.namedChildren.filter(child => child.type === 'variable_declarator') : [node];
        for (const child of candidates) {
          const nameNode = child.childForFieldName('name');
          if (!nameNode || !['identifier', 'type_identifier'].includes(nameNode.type)) continue;
          const name = nameNode.text;
          const matches = symbols.filter(symbol => !symbol.container && symbol.name === name &&
            symbol.range.startLine === node.startPosition.row + 1 && symbol.range.endLine === node.endPosition.row + 1);
          const unique = matches.length === 1 && symbols.filter(symbol => symbol.symbolKey === matches[0].symbolKey).length === 1;
          add(declarations, name, unique ? { id: matches[0].symbolKey, symbolKey: matches[0].symbolKey,
            kind: matches[0].kind, path: file.path } : null);
        }
      }
      for (const node of roots.filter(root => root.type === 'export_statement')) {
        const declaration = node.childForFieldName('declaration');
        if (declaration) {
          const names = ['lexical_declaration', 'variable_declaration'].includes(declaration.type)
            ? declaration.namedChildren.filter(child => child.type === 'variable_declarator').map(child => child.childForFieldName('name')?.text)
            : [declaration.childForFieldName('name')?.text];
          for (const name of names.filter(Boolean)) add(exports, node.children.some(child => child.type === 'default') ? 'default' : name, name);
        } else {
          const value = node.childForFieldName('value');
          if (value?.type === 'identifier') add(exports, 'default', value.text);
          const clause = node.namedChildren.find(child => child.type === 'export_clause');
          for (const spec of clause?.namedChildren ?? []) {
            if (spec.type !== 'export_specifier') continue;
            const name = spec.childForFieldName('name'); const alias = spec.childForFieldName('alias');
            if (name) add(exports, alias?.text ?? name.text, node.childForFieldName('source') ? null : name.text);
          }
        }
      }
      modules.set(file.path, { declarations, exports });
    } finally { tree.delete(); }
  }
  return { ...result, relations: result.relations.map(fact => ({ ...fact,
    bindings: fact.bindings.map(binding => {
      const module = modules.get(fact.target.path);
      const names = module?.exports.get(binding.imported) ?? [];
      const declarations = names.length === 1 ? module?.declarations.get(names[0]) ?? [] : [];
      if (binding.imported !== '*' && names.length === 1 && declarations.length === 1 && declarations[0]) {
        return { ...binding, target: declarations[0] };
      }
      return { ...binding, reason: binding.imported === '*' ? 'namespace-import' : 'unresolved-export' };
    }),
  })) };
}
