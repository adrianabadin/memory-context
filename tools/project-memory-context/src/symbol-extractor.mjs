import { extractJsTsSymbols } from './extractors/js-ts-extractor.mjs';
import { extractRegexSymbols, EXTENSION_TO_LANGUAGE } from './extractors/regex-extractor.mjs';
import { buildSymbolKey } from './symbol-keys.mjs';

const JS_TS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

export function extractTopLevelSymbols({ filePath, content }) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (JS_TS_EXTENSIONS.has(ext)) {
    return extractJsTsSymbols({ filePath, content });
  }
  if (EXTENSION_TO_LANGUAGE.has(ext)) {
    return extractRegexSymbols({ filePath, content });
  }
  return [];
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
