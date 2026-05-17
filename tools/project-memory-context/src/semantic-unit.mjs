function sliceLines(content, startLine, endLine) {
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

function collectTypeScriptContext(lines, symbolStartLine) {
  const context = [];
  for (let index = 0; index < symbolStartLine - 1; index += 1) {
    const line = lines[index];
    if (/^\s*import\b/.test(line)) {
      context.push(line);
    }
  }
  return context;
}

function collectCSharpContext(lines, symbolStartLine) {
  const context = [];
  for (let index = 0; index < symbolStartLine - 1; index += 1) {
    const line = lines[index];
    if (/^\s*using\s+/.test(line) || /^\s*namespace\s+/.test(line)) {
      context.push(line);
    }
  }
  return context;
}

export function buildSemanticPrompt(unit) {
  return [
    `Symbol Key: ${unit.symbolKey}`,
    `Language: ${unit.language}`,
    `Kind: ${unit.kind}`,
    `Name: ${unit.name}`,
    `Location: ${unit.filePath}:${unit.range.startLine}-${unit.range.endLine}`,
    '',
    'Context:',
    unit.context || 'None',
    '',
    'Code:',
    unit.code,
    '',
    'Return a compact structured explanation with:',
    '- responsibility',
    '- primary inputs',
    '- output',
    '- immediate dependencies',
    '- role in module',
  ].join('\n');
}

export function buildSemanticUnit({ symbol, content }) {
  const lines = content.split('\n');
  const { startLine, endLine } = symbol.range;
  const contextLines = symbol.language === 'csharp'
    ? collectCSharpContext(lines, startLine)
    : collectTypeScriptContext(lines, startLine);

  const unit = {
    symbolKey: symbol.symbolKey,
    graphNodeId: symbol.graphNodeId ?? null,
    language: symbol.language,
    filePath: symbol.filePath,
    kind: symbol.kind,
    name: symbol.name,
    range: symbol.range,
    codeHash: symbol.codeHash,
    context: contextLines.join('\n').trim(),
    code: sliceLines(content, startLine, endLine),
  };

  return {
    ...unit,
    prompt: buildSemanticPrompt(unit),
  };
}
