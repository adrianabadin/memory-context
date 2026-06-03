import { extractSymbolsForFile } from './extractors/tree-sitter/extract.mjs';
import { extractRegexSymbols, EXTENSION_TO_LANGUAGE } from './extractors/regex-extractor.mjs';
import { LANGUAGE_TO_GRAMMAR } from './extractors/tree-sitter/language-map.mjs';

// Languages without tree-sitter WASM grammars fall back to the regex extractor
const REGEX_FALLBACK_EXTS = new Set(
  [...EXTENSION_TO_LANGUAGE.entries()]
    .filter(([, lang]) => !LANGUAGE_TO_GRAMMAR[lang])
    .map(([ext]) => ext)
);

export async function extractTopLevelSymbols({ filePath, content }) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (REGEX_FALLBACK_EXTS.has(ext)) {
    return extractRegexSymbols({ filePath, content });
  }
  return extractSymbolsForFile({ filePath, content });
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
