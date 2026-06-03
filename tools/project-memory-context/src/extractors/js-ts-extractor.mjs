import { parse } from '@babel/parser';
import { createHash } from 'node:crypto';
import { buildSymbolKey } from '../symbol-keys.mjs';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);

function makePlugins(ext) {
  const plugins = ['decorators'];
  if (TS_EXTENSIONS.has(ext)) plugins.push('typescript');
  if (JSX_EXTENSIONS.has(ext)) plugins.push('jsx');
  return plugins;
}

function buildCodeHash(lines, startLine, endLine) {
  const fragment = lines.slice(startLine - 1, endLine).join('\n');
  return createHash('sha1').update(fragment).digest('hex');
}

function isExported(node) {
  // Babel wraps exported declarations in ExportNamedDeclaration / ExportDefaultDeclaration
  return node._exported === true;
}

function symbolFromNode(node, lines, filePath, language, kind, name, arity) {
  const startLine = node.loc?.start?.line ?? 1;
  const endLine = node.loc?.end?.line ?? startLine;
  const codeHash = buildCodeHash(lines, startLine, endLine);
  const exportScope = node._exported ? 'exported' : 'local';
  const symbol = {
    language,
    filePath: filePath.replace(/\\/g, '/'),
    kind,
    name,
    exportScope,
    arity,
    range: { startLine, endLine },
    codeHash,
  };
  symbol.symbolKey = buildSymbolKey(symbol);
  return symbol;
}

export function extractJsTsSymbols({ filePath, content }) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const language = TS_EXTENSIONS.has(ext) ? 'ts' : 'js';

  let ast;
  try {
    ast = parse(content, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: makePlugins(ext),
    });
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const symbols = [];

  for (const node of ast.program.body) {
    const exported = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration';
    const decl = exported ? (node.declaration ?? node) : node;
    if (decl) decl._exported = exported;

    switch (decl?.type) {
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (decl.id?.name) {
          symbols.push(symbolFromNode(decl, lines, filePath, language, 'class', decl.id.name, undefined));
        }
        break;

      case 'FunctionDeclaration':
        if (decl.id?.name) {
          const arity = decl.params?.length ?? 0;
          symbols.push(symbolFromNode(decl, lines, filePath, language, 'function', decl.id.name, arity));
        }
        break;

      case 'VariableDeclaration':
        for (const declarator of decl.declarations ?? []) {
          const init = declarator.init;
          const isArrow = init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression';
          if (isArrow && declarator.id?.name) {
            declarator._exported = decl._exported;
            const arity = init.params?.length ?? 0;
            symbols.push(symbolFromNode(declarator, lines, filePath, language, 'function', declarator.id.name, arity));
          }
        }
        break;

      case 'TSInterfaceDeclaration':
        if (decl.id?.name) {
          symbols.push(symbolFromNode(decl, lines, filePath, language, 'interface', decl.id.name, undefined));
        }
        break;

      case 'TSTypeAliasDeclaration':
        if (decl.id?.name) {
          symbols.push(symbolFromNode(decl, lines, filePath, language, 'type', decl.id.name, undefined));
        }
        break;

      case 'TSEnumDeclaration':
        if (decl.id?.name) {
          symbols.push(symbolFromNode(decl, lines, filePath, language, 'class', decl.id.name, undefined));
        }
        break;
    }
  }

  symbols.sort((a, b) => a.range.startLine - b.range.startLine);
  return symbols;
}
