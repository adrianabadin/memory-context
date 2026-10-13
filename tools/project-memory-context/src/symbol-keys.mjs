function normalizePath(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

/**
 * Build the canonical symbol key.
 *
 * D2 class-member contract (unit 1.2-A): when `symbol.kind === 'method'` and
 * the record carries a structured `container` (the concrete top-level class
 * name), the key canonicalizes into the qualified `Container.name` name slot
 * and the `member` exportScope slot, e.g.
 * `ts|src/services/user.service.ts|method|member|UserService.findById|1`.
 *
 * API contract: callers pass an unqualified `name` plus a separate `container`.
 * This function is pure — it never mutates the input record and never rewrites
 * the record's own `name`/`exportScope`. Methods without a container (legacy
 * C#/PHP/other-language output until unit 1.2-B maps them) keep the exact
 * legacy key bytes. The dedicated C# branch is unchanged.
 */
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

  const hasContainer =
    symbol.kind === 'method' &&
    typeof symbol.container === 'string' &&
    symbol.container.length > 0;
  const name = hasContainer ? `${symbol.container}.${symbol.name}` : symbol.name;
  const exportScope = hasContainer ? 'member' : (symbol.exportScope ?? 'local');

  return [
    symbol.language,
    filePath,
    symbol.kind,
    exportScope,
    name,
    String(symbol.arity ?? 0),
  ].join('|');
}
