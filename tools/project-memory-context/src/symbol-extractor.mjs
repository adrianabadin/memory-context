import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import { buildSymbolKey } from './symbol-keys.mjs';

const TOP_LEVEL_EXPORT_SCOPE = /^(?:\s*export\b)/;

function inferScriptLanguage(filePath) {
  const extension = extname(filePath).toLowerCase();
  return extension === '.js' || extension === '.jsx' ? 'js' : 'ts';
}

function countParameters(parameterList) {
  const trimmed = parameterList.trim();
  if (!trimmed) return 0;
  return trimmed.split(',').map((part) => part.trim()).filter(Boolean).length;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function findBlockEndLine(content, startIndex) {
  const braceIndex = content.indexOf('{', startIndex);
  if (braceIndex === -1) {
    return lineNumberAt(content, startIndex);
  }

  let depth = 0;
  for (let index = braceIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return lineNumberAt(content, index);
      }
    }
  }

  return lineNumberAt(content, content.length - 1);
}

function buildCodeHash(content) {
  return createHash('sha1').update(content).digest('hex');
}

function extractTypeScriptSymbols(filePath, content) {
  const language = inferScriptLanguage(filePath);
  const symbols = [];
  const patterns = [
    { kind: 'interface', regex: /^(\s*export\s+)?interface\s+(\w+)/gm },
    { kind: 'class', regex: /^(\s*export\s+)?class\s+(\w+)/gm },
    { kind: 'function', regex: /^(\s*export\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm },
    { kind: 'function', regex: /^(\s*export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/gm },
    { kind: 'type', regex: /^(\s*export\s+)?type\s+(\w+)\s*=/gm },
  ];

  for (const { kind, regex } of patterns) {
    for (const match of content.matchAll(regex)) {
      const fullMatch = match[0];
      const name = match[2];
      const startIndex = match.index ?? 0;
      const startLine = lineNumberAt(content, startIndex);
      const endLine = findBlockEndLine(content, startIndex);
      const arity = kind === 'function' ? countParameters(match[3] ?? '') : undefined;
      const exportScope = TOP_LEVEL_EXPORT_SCOPE.test(fullMatch) ? 'exported' : 'local';
      const codeFragment = content.split('\n').slice(startLine - 1, endLine).join('\n');
      const symbol = {
        language,
        filePath: filePath.replace(/\\/g, '/'),
        kind,
        name,
        exportScope,
        arity,
        range: { startLine, endLine },
        codeHash: buildCodeHash(codeFragment),
      };
      symbol.symbolKey = buildSymbolKey(symbol);
      symbols.push(symbol);
    }
  }

  symbols.sort((left, right) => left.range.startLine - right.range.startLine);
  return symbols;
}

function parseCSharpParameters(parameterList) {
  const trimmed = parameterList.trim();
  if (!trimmed) return { arity: 0, signature: '()' };
  const types = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/).slice(0, -1).join(' ') || part.split(/\s+/)[0])
    .map((part) => part.replace(/^params\s+/, '').trim());
  return {
    arity: types.length,
    signature: `(${types.join(',')})`,
  };
}

function extractCSharpSymbols(filePath, content) {
  const lines = content.split('\n');
  const symbols = [];
  let currentNamespace = 'global';
  let currentContainer = null;
  let braceDepth = 0;
  let containerDepth = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const namespaceMatch = line.match(/^\s*namespace\s+([\w.]+)/);
    if (namespaceMatch) {
      currentNamespace = namespaceMatch[1];
    }

    const typeMatch = line.match(/^\s*public\s+(?:partial\s+)?(record|class|interface|enum)\s+(\w+)/);
    if (typeMatch) {
      const kind = typeMatch[1];
      const name = typeMatch[2];
      const startLine = lineIndex + 1;
      const startIndex = content.indexOf(line);
      const endLine = findBlockEndLine(content, startIndex);
      const codeFragment = lines.slice(startLine - 1, endLine).join('\n');
      const symbol = {
        language: 'csharp',
        filePath: filePath.replace(/\\/g, '/'),
        kind,
        name,
        namespace: currentNamespace,
        containerName: currentContainer?.name ?? 'none',
        signature: kind === 'record' ? '(record)' : '()',
        range: { startLine, endLine },
        codeHash: buildCodeHash(codeFragment),
      };
      symbol.symbolKey = buildSymbolKey(symbol);
      symbols.push(symbol);

      if (kind === 'class' || kind === 'interface' || kind === 'record') {
        currentContainer = { name, kind };
        containerDepth = braceDepth + (line.includes('{') ? 1 : 0);
      }
    }

    if (currentContainer) {
      const methodMatch = line.match(/^\s*public\s+(?:async\s+)?[\w<>,?.\[\]\s]+\s+(\w+)\s*\(([^)]*)\)\s*(?:\{|=>)/);
      if (methodMatch && methodMatch[1] !== currentContainer.name) {
        const name = methodMatch[1];
        const params = parseCSharpParameters(methodMatch[2]);
        const startLine = lineIndex + 1;
        const startIndex = content.indexOf(line, content.indexOf(lines[0]));
        const endLine = findBlockEndLine(content, startIndex);
        const codeFragment = lines.slice(startLine - 1, endLine).join('\n');
        const symbol = {
          language: 'csharp',
          filePath: filePath.replace(/\\/g, '/'),
          kind: 'method',
          name,
          namespace: currentNamespace,
          containerName: currentContainer.name,
          signature: params.signature,
          arity: params.arity,
          range: { startLine, endLine },
          codeHash: buildCodeHash(codeFragment),
        };
        symbol.symbolKey = buildSymbolKey(symbol);
        symbols.push(symbol);
      }
    }

    for (const char of line) {
      if (char === '{') braceDepth += 1;
      if (char === '}') braceDepth -= 1;
    }

    if (currentContainer && containerDepth !== null && braceDepth < containerDepth) {
      currentContainer = null;
      containerDepth = null;
    }
  }

  symbols.sort((left, right) => left.range.startLine - right.range.startLine);
  return symbols;
}

export function extractTopLevelSymbols({ filePath, content }) {
  if (filePath.toLowerCase().endsWith('.cs')) {
    return extractCSharpSymbols(filePath, content);
  }
  return extractTypeScriptSymbols(filePath, content);
}

export function buildEnrichmentWorklist({ symbols, symbolIndex }) {
  return symbols.map((symbol) => {
    const prior = symbolIndex[symbol.symbolKey];
    const status = prior && prior.codeHash === symbol.codeHash ? 'enriched' : 'pending';
    return {
      ...symbol,
      status,
      memoryId: prior?.memoryId ?? null,
      graphNodeId: symbol.graphNodeId ?? prior?.graphNodeId ?? null,
    };
  });
}
