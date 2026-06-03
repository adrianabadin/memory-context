import { loadQueryArtifacts } from './load-artifacts.mjs';

function normalizePath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

function tokenize(value) {
  return String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function countMatches(tokens, fields) {
  if (tokens.length === 0) {
    return 0;
  }

  const haystack = fields.join(' ').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function searchMemoryMatches(memories, tokens) {
  return memories
    .map((memory) => ({
      ...memory,
      score: countMatches(tokens, [
        memory.title,
        memory.summary,
        memory.body,
        ...(memory.tags ?? []),
      ]),
    }))
    .filter((memory) => memory.score > 0)
    .sort((a, b) => b.score - a.score || String(a.path).localeCompare(String(b.path)));
}

function searchSymbolMatches(symbols, tokens, fileFilter) {
  const normalizedFilter = normalizePath(fileFilter);

  return symbols
    .map((symbol) => ({
      ...symbol,
      score: countMatches(tokens, [symbol.name, symbol.filePath, symbol.semanticSummary]),
    }))
    .filter((symbol) => symbol.score > 0)
    .filter((symbol) => !normalizedFilter || symbol.filePath === normalizedFilter)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function buildRelatedSymbols(symbols) {
  const symbolByKey = new Map(symbols.map((symbol) => [symbol.symbolKey, symbol]));
  const symbolKeyByNodeId = new Map(
    symbols
      .filter((symbol) => symbol.graphNodeId)
      .map((symbol) => [symbol.graphNodeId, symbol.symbolKey]),
  );

  return { symbolByKey, symbolKeyByNodeId };
}

export function createQueryOrchestrator({ projectRoot, loadArtifacts = loadQueryArtifacts }) {
  async function searchSymbols(query, fileFilter) {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }

    const artifacts = await loadArtifacts(projectRoot);
    return searchSymbolMatches(artifacts.symbols, tokens, fileFilter);
  }

  async function query(question) {
    const tokens = tokenize(question);
    if (tokens.length === 0) {
      return { answer: '', sources: [], tokens_saved: 0 };
    }

    const artifacts = await loadArtifacts(projectRoot);
    const memoryMatches = searchMemoryMatches(artifacts.memories, tokens);
    const symbolMatches = searchSymbolMatches(artifacts.symbols, tokens);

    if (memoryMatches.length === 0 && symbolMatches.length === 0) {
      return { answer: '', sources: [], tokens_saved: 0 };
    }

    const answerParts = [];
    const sources = [];
    let sourceCharacters = 0;

    for (const memory of memoryMatches.slice(0, 3)) {
      const body = String(memory.body ?? '').trim();
      if (!body) {
        continue;
      }

      answerParts.push(`${memory.title}: ${body}`);
      sources.push({
        type: 'project-context',
        path: normalizePath(memory.path),
        title: memory.title,
      });
      sourceCharacters += body.length + String(memory.summary ?? '').length;
    }

    for (const symbol of symbolMatches.slice(0, 3)) {
      const summary = String(symbol.semanticSummary ?? '').trim();
      if (!summary) {
        continue;
      }

      answerParts.push(`Symbol ${symbol.name} (${symbol.filePath}): ${summary}`);
      sources.push({
        type: 'symbol',
        symbolKey: symbol.symbolKey,
        filePath: symbol.filePath,
        graphNodeId: symbol.graphNodeId,
      });
      sourceCharacters += summary.length;
    }

    const answer = answerParts.join('\n\n');
    if (!answer) {
      return { answer: '', sources: [], tokens_saved: 0 };
    }

    return {
      answer,
      sources,
      tokens_saved: Math.max(0, Math.ceil(sourceCharacters / 4) - Math.ceil(answer.length / 4)),
    };
  }

  async function getRelatedSymbols(symbolKey, direction) {
    if (!symbolKey) {
      return [];
    }

    const artifacts = await loadArtifacts(projectRoot);
    const { symbolByKey, symbolKeyByNodeId } = buildRelatedSymbols(artifacts.symbols);
    const origin = symbolByKey.get(symbolKey);
    if (!origin?.graphNodeId) {
      return [];
    }

    return artifacts.edges
      .map((edge) => {
        const relatedNodeId = direction === 'inbound'
          ? (edge.target === origin.graphNodeId ? edge.source : null)
          : (edge.source === origin.graphNodeId ? edge.target : null);

        return relatedNodeId ? symbolKeyByNodeId.get(relatedNodeId) : null;
      })
      .filter(Boolean)
      .map((relatedKey) => symbolByKey.get(relatedKey));
  }

  return {
    query,
    searchSymbols,
    getDependents(symbolKey) {
      return getRelatedSymbols(symbolKey, 'inbound');
    },
    getDependencies(symbolKey) {
      return getRelatedSymbols(symbolKey, 'outbound');
    },
  };
}
