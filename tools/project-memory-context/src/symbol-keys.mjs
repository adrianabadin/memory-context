function normalizePath(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

export function buildSymbolKey(symbol) {
  const filePath = normalizePath(symbol.filePath);

  if (symbol.language === 'csharp') {
    return [
      'csharp',
      filePath,
      symbol.namespace ?? 'global',
      symbol.containerName ?? 'none',
      symbol.kind,
      symbol.name,
      symbol.signature ?? '()',
    ].join('|');
  }

  return [
    symbol.language,
    filePath,
    symbol.kind,
    symbol.exportScope ?? 'local',
    symbol.name,
    String(symbol.arity ?? 0),
  ].join('|');
}
