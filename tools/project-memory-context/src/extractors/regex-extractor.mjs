import { hashSymbol } from '../hash.mjs';
import { buildSymbolKey } from '../symbol-keys.mjs';

// ── Shared utilities ───────────────────────────────────────────────

async function codeHash(lines, startLine, endLine) {
  return hashSymbol(lines.slice(startLine - 1, endLine).join('\n'));
}

function findBlockEnd(lines, startIdx) {
  let depth = 0;
  let opened = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      if (ch === '}') { depth--; if (opened && depth === 0) return i + 1; }
    }
  }
  return startIdx + 1;
}

async function makeSymbol(filePath, language, kind, name, exportScope, lines, startLine, endLine, arity) {
  const symbol = {
    language,
    filePath: filePath.replace(/\\/g, '/'),
    kind,
    name,
    exportScope,
    arity,
    range: { startLine, endLine },
    codeHash: await codeHash(lines, startLine, endLine),
  };
  symbol.symbolKey = buildSymbolKey(symbol);
  return symbol;
}

// ── Language extractors ────────────────────────────────────────────
// Each extractor returns an array of Promises (from makeSymbol).
// extractRegexSymbols resolves them with Promise.all.

function extractPython(lines, filePath) {
  const promises = [];
  const classRe = /^(class)\s+(\w+)/;
  const funcRe = /^(async\s+def|def)\s+(\w+)\s*\(([^)]*)\)/;
  const decoratedFuncRe = /^(async\s+def|def)\s+(\w+)/;

  let pendingDecorator = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();
    if (line.startsWith('#')) continue;
    if (line.startsWith('@')) { pendingDecorator = true; continue; }

    const classMatch = classRe.exec(line);
    if (classMatch) {
      const name = classMatch[2];
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'python', 'class', name, name.startsWith('_') ? 'local' : 'exported', lines, i + 1, endLine, undefined));
      pendingDecorator = false;
      continue;
    }

    const fnMatch = funcRe.exec(line) ?? (pendingDecorator ? decoratedFuncRe.exec(line) : null);
    if (fnMatch) {
      const name = fnMatch[2];
      const params = fnMatch[3] ?? '';
      const arity = params.trim() ? params.split(',').filter(p => p.trim() && p.trim() !== 'self' && p.trim() !== 'cls').length : 0;
      // Only top-level (not indented)
      if (!lines[i].startsWith(' ') && !lines[i].startsWith('\t')) {
        const endLine = findBlockEnd(lines, i);
        promises.push(makeSymbol(filePath, 'python', 'function', name, name.startsWith('_') ? 'local' : 'exported', lines, i + 1, endLine, arity));
      }
      pendingDecorator = false;
      continue;
    }
    pendingDecorator = false;
  }
  return promises;
}

function extractJava(lines, filePath) {
  const promises = [];
  const classRe = /^(?:public\s+)?(?:abstract\s+)?(?:final\s+)?(class|interface|enum|@interface|record)\s+(\w+)/;
  const methodRe = /^\s+(?:@\w+\s+)*(?:public|protected|private|static|final|abstract|synchronized|native|default)[\w\s<>,\[\]]*?\s+(\w+)\s*\(([^)]*)\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();
    const classMatch = classRe.exec(line);
    if (classMatch) {
      const kind = classMatch[1] === 'interface' ? 'interface' : 'class';
      const name = classMatch[2];
      const exported = lines[i].includes('public');
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'java', kind, name, exported ? 'exported' : 'local', lines, i + 1, endLine, undefined));
      continue;
    }

    const methodMatch = methodRe.exec(lines[i]);
    if (methodMatch) {
      const name = methodMatch[1];
      if (name === 'if' || name === 'for' || name === 'while' || name === 'switch') continue;
      const params = methodMatch[2] ?? '';
      const arity = params.trim() ? params.split(',').length : 0;
      const exported = lines[i].includes('public');
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'java', 'function', name, exported ? 'exported' : 'local', lines, i + 1, endLine, arity));
    }
  }
  return promises;
}

function extractGo(lines, filePath) {
  const promises = [];
  const funcRe = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)/;
  const typeRe = /^type\s+(\w+)\s+(struct|interface|func)/;

  for (let i = 0; i < lines.length; i++) {
    const funcMatch = funcRe.exec(lines[i]);
    if (funcMatch) {
      const name = funcMatch[1];
      const params = funcMatch[2] ?? '';
      const arity = params.trim() ? params.split(',').length : 0;
      const exported = name[0] === name[0].toUpperCase() && /[A-Z]/.test(name[0]);
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'go', 'function', name, exported ? 'exported' : 'local', lines, i + 1, endLine, arity));
      continue;
    }

    const typeMatch = typeRe.exec(lines[i]);
    if (typeMatch) {
      const name = typeMatch[1];
      const kind = typeMatch[2] === 'interface' ? 'interface' : 'class';
      const exported = name[0] === name[0].toUpperCase() && /[A-Z]/.test(name[0]);
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'go', kind, name, exported ? 'exported' : 'local', lines, i + 1, endLine, undefined));
    }
  }
  return promises;
}

function extractRust(lines, filePath) {
  const promises = [];
  const patterns = [
    { kind: 'class',     re: /^(?:pub(?:\([^)]+\))?\s+)?struct\s+(\w+)/ },
    { kind: 'class',     re: /^(?:pub(?:\([^)]+\))?\s+)?enum\s+(\w+)/ },
    { kind: 'interface', re: /^(?:pub(?:\([^)]+\))?\s+)?trait\s+(\w+)/ },
    { kind: 'function',  re: /^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/ },
    { kind: 'class',     re: /^impl(?:<[^>]+>)?\s+(?:\w+\s+for\s+)?(\w+)/ },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('//')) continue;
    for (const { kind, re } of patterns) {
      const m = re.exec(line);
      if (m) {
        const name = m[1];
        if (!name || name === 'fn' || name === 'struct') continue;
        const params = m[2] ?? '';
        const arity = kind === 'function' && params.trim() ? params.split(',').length : undefined;
        const exported = line.trimStart().startsWith('pub');
        const endLine = findBlockEnd(lines, i);
        promises.push(makeSymbol(filePath, 'rust', kind, name, exported ? 'exported' : 'local', lines, i + 1, endLine, arity));
        break;
      }
    }
  }
  return promises;
}

function extractRuby(lines, filePath) {
  const promises = [];
  const classRe = /^(?:class|module)\s+([\w:]+)/;
  const methodRe = /^  def\s+(?:self\.)?(\w+)(?:\(([^)]*)\))?/;

  for (let i = 0; i < lines.length; i++) {
    const classMatch = classRe.exec(lines[i]);
    if (classMatch) {
      const name = classMatch[1].split('::').at(-1);
      // Find matching 'end'
      let depth = 1, end = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trimStart();
        if (/^(class|module|def|do|if|unless|while|until|for|begin|case)\b/.test(t)) depth++;
        if (/^end\b/.test(t)) { depth--; if (depth === 0) { end = j + 1; break; } }
      }
      promises.push(makeSymbol(filePath, 'ruby', 'class', name, 'exported', lines, i + 1, end, undefined));
      continue;
    }
    const methodMatch = methodRe.exec(lines[i]);
    if (methodMatch) {
      const name = methodMatch[1];
      const params = methodMatch[2] ?? '';
      const arity = params.trim() ? params.split(',').length : 0;
      promises.push(makeSymbol(filePath, 'ruby', 'function', name, 'exported', lines, i + 1, i + 1, arity));
    }
  }
  return promises;
}

function extractPhp(lines, filePath) {
  const promises = [];
  const classRe = /^(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/;
  const funcRe = /^(?:function|(?:public|protected|private|static|abstract|final)[\w\s]*function)\s+(?:&\s*)?(\w+)\s*\(([^)]*)\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();
    const classMatch = classRe.exec(line);
    if (classMatch) {
      const name = classMatch[1];
      const keyword = line.match(/^(?:\w+\s+)*(class|interface|trait|enum)/)?.[1] ?? 'class';
      const kind = keyword === 'interface' ? 'interface' : 'class';
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'php', kind, name, 'exported', lines, i + 1, endLine, undefined));
      continue;
    }
    const funcMatch = funcRe.exec(line);
    if (funcMatch) {
      const name = funcMatch[1];
      const params = funcMatch[2] ?? '';
      const arity = params.trim() ? params.split(',').length : 0;
      const exported = /\bpublic\b/.test(line) || !lines[i].startsWith(' ');
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'php', 'function', name, exported ? 'exported' : 'local', lines, i + 1, endLine, arity));
    }
  }
  return promises;
}

function extractKotlin(lines, filePath) {
  const promises = [];
  const classRe = /^(?:(?:public|private|protected|internal|abstract|open|sealed|data|inline|value|enum)\s+)*(?:class|object|interface)\s+(\w+)/;
  const funcRe = /^(?:(?:public|private|protected|internal|override|suspend|inline|operator|infix|tailrec|external)\s+)*fun\s+(?:<[^>]+>\s+)?(?:\w+\s*\.\s*)?(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classMatch = classRe.exec(line.trimStart());
    if (classMatch) {
      const name = classMatch[1];
      const keyword = line.match(/(class|object|interface)\s/)?.[1] ?? 'class';
      const kind = keyword === 'interface' ? 'interface' : 'class';
      const exported = !line.includes('private') && !line.includes('internal');
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'kotlin', kind, name, exported ? 'exported' : 'local', lines, i + 1, endLine, undefined));
      continue;
    }
    const funcMatch = funcRe.exec(line.trimStart());
    if (funcMatch) {
      const name = funcMatch[1];
      const params = funcMatch[2] ?? '';
      const arity = params.trim() ? params.split(',').length : 0;
      const exported = !line.includes('private') && !line.includes('internal');
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'kotlin', 'function', name, exported ? 'exported' : 'local', lines, i + 1, endLine, arity));
    }
  }
  return promises;
}

function extractSwift(lines, filePath) {
  const promises = [];
  const patterns = [
    { kind: 'class',     re: /^(?:(?:public|private|internal|open|final|fileprivate)\s+)*(?:class|struct|actor|enum)\s+(\w+)/ },
    { kind: 'interface', re: /^(?:(?:public|private|internal|open|fileprivate)\s+)*protocol\s+(\w+)/ },
    { kind: 'class',     re: /^(?:(?:public|private|internal|open|fileprivate)\s+)*extension\s+(\w+)/ },
    { kind: 'function',  re: /^(?:(?:public|private|internal|open|override|static|class|fileprivate|mutating|nonmutating|dynamic|final|required|convenience|async|throws|rethrows)\s+)*func\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/ },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('//')) continue;
    for (const { kind, re } of patterns) {
      const m = re.exec(line.trimStart());
      if (m) {
        const name = m[1];
        const params = m[2] ?? '';
        const arity = kind === 'function' && params.trim() ? params.split(',').length : undefined;
        const exported = /\bpublic\b|\bopen\b/.test(line);
        const endLine = findBlockEnd(lines, i);
        promises.push(makeSymbol(filePath, 'swift', kind, name, exported ? 'exported' : 'local', lines, i + 1, endLine, arity));
        break;
      }
    }
  }
  return promises;
}

function extractCpp(lines, filePath) {
  const promises = [];
  const classRe = /^(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(\w+)(?:\s*:\s*[\w\s,:<>]*)?(?:\s*\{|$)/;
  const nsRe = /^namespace\s+(\w+)\s*\{/;
  const funcRe = /^(?:(?:inline|static|virtual|explicit|friend|constexpr|consteval|auto|template\s*<[^>]*>)\s+)*(?:[\w:*&<>\s]+\s+)?(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:\{|;)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('#')) continue;

    const nsMatch = nsRe.exec(line.trimStart());
    if (nsMatch) {
      promises.push(makeSymbol(filePath, 'cpp', 'class', nsMatch[1], 'exported', lines, i + 1, i + 1, undefined));
      continue;
    }

    const classMatch = classRe.exec(line.trimStart());
    if (classMatch) {
      const name = classMatch[1];
      if (name === 'override' || name === 'final') continue;
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'cpp', 'class', name, 'exported', lines, i + 1, endLine, undefined));
      continue;
    }

    const funcMatch = funcRe.exec(line.trimStart());
    if (funcMatch) {
      const name = funcMatch[1];
      const reserved = new Set(['if','for','while','switch','catch','return','delete','new']);
      if (reserved.has(name) || name.includes('<') || name.includes(':')) continue;
      const params = funcMatch[2] ?? '';
      const arity = params.trim() && params.trim() !== 'void' ? params.split(',').length : 0;
      const endLine = findBlockEnd(lines, i);
      promises.push(makeSymbol(filePath, 'cpp', 'function', name, 'exported', lines, i + 1, endLine, arity));
    }
  }
  return promises;
}

function extractCSharp(lines, filePath) {
  const promises = [];
  let currentNamespace = 'global';
  let currentContainer = null;
  let containerDepth = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nsMatch = line.match(/^\s*namespace\s+([\w.]+)/);
    if (nsMatch) currentNamespace = nsMatch[1];

    const typeMatch = line.match(/^\s*(?:public\s+)?(?:partial\s+)?(?:abstract\s+)?(?:sealed\s+)?(?:static\s+)?(record|class|interface|enum|struct)\s+(\w+)/);
    if (typeMatch) {
      const rawKind = typeMatch[1];
      const kind = rawKind === 'interface' ? 'interface' : rawKind === 'record' ? 'record' : 'class';
      const name = typeMatch[2];
      const exported = line.includes('public');
      const startLine = i + 1;
      const endLine = findBlockEnd(lines, i);
      // Capture namespace/container for async symbol construction
      const ns = currentNamespace;
      const container = currentContainer;
      promises.push(
        codeHash(lines, startLine, endLine).then(hash => {
          const symbol = {
            language: 'csharp',
            filePath: filePath.replace(/\\/g, '/'),
            kind,
            name,
            exportScope: exported ? 'exported' : 'local',
            namespace: ns,
            containerName: container?.name ?? 'none',
            signature: '()',
            range: { startLine, endLine },
            codeHash: hash,
          };
          symbol.symbolKey = buildSymbolKey(symbol);
          return symbol;
        })
      );

      if (['class','interface','record','struct'].includes(rawKind)) {
        currentContainer = { name, kind: rawKind };
        containerDepth = braceDepth + (line.includes('{') ? 1 : 0);
      }
    }

    if (currentContainer) {
      const methodMatch = line.match(/^\s+(?:public|protected|private|internal|static|virtual|override|abstract|async|sealed|new|extern)[\w\s<>,?.\[\]]*\s+(\w+)\s*\(([^)]*)\)/);
      if (methodMatch && methodMatch[1] !== currentContainer.name) {
        const name = methodMatch[1];
        const params = methodMatch[2] ?? '';
        const arity = params.trim() ? params.split(',').length : 0;
        const exported = line.includes('public');
        const startLine = i + 1;
        const endLine = findBlockEnd(lines, i);
        const ns = currentNamespace;
        const container = currentContainer;
        promises.push(
          codeHash(lines, startLine, endLine).then(hash => {
            const symbol = {
              language: 'csharp',
              filePath: filePath.replace(/\\/g, '/'),
              kind: 'method',
              name,
              exportScope: exported ? 'exported' : 'local',
              namespace: ns,
              containerName: container.name,
              signature: `(${params.split(',').map(p => p.trim().split(' ')[0]).filter(Boolean).join(',')})`,
              arity,
              range: { startLine, endLine },
              codeHash: hash,
            };
            symbol.symbolKey = buildSymbolKey(symbol);
            return symbol;
          })
        );
      }
    }

    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }
    if (currentContainer && containerDepth !== null && braceDepth < containerDepth) {
      currentContainer = null;
      containerDepth = null;
    }
  }
  return promises;
}

// ── Public dispatcher ──────────────────────────────────────────────

const LANGUAGE_EXTRACTORS = {
  python:  extractPython,
  java:    extractJava,
  go:      extractGo,
  rust:    extractRust,
  ruby:    extractRuby,
  php:     extractPhp,
  kotlin:  extractKotlin,
  swift:   extractSwift,
  cpp:     extractCpp,
  csharp:  extractCSharp,
};

export const EXTENSION_TO_LANGUAGE = new Map([
  ['.py',   'python'],
  ['.java', 'java'],
  ['.go',   'go'],
  ['.rs',   'rust'],
  ['.rb',   'ruby'],
  ['.php',  'php'],
  ['.kt',   'kotlin'], ['.kts', 'kotlin'],
  ['.swift','swift'],
  ['.cpp',  'cpp'], ['.cc', 'cpp'], ['.cxx', 'cpp'],
  ['.hpp',  'cpp'], ['.h',  'cpp'],
  ['.cs',   'csharp'],
]);

export async function extractRegexSymbols({ filePath, content }) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const language = EXTENSION_TO_LANGUAGE.get(ext);
  if (!language) return [];
  const lines = content.split('\n');
  return Promise.all(LANGUAGE_EXTRACTORS[language](lines, filePath));
}
