import { validateNarrativeEvidence } from './cards/narrative-cache.mjs';

function extractFirstSentence(text) {
  const cleaned = text.trim();
  if (!cleaned) return null;

  const match = cleaned.match(/^(.+?[.!?])(?:\s|$)/);
  if (match) {
    return match[1].trim();
  }

  return cleaned.split(/\r?\n/)[0].trim();
}

export function extractSemanticSummary(content) {
  if (!content || typeof content !== 'string') {
    return null;
  }

  const text = content.trim();
  if (!text) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  let responsibilityText = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const inlineMatch = line.match(
      /^(?:[-*]\s+)?(?:\*{1,2}|_{1,2})?Responsibility(?::(?:\*{1,2}|_{1,2})?|(?:\*{1,2}|_{1,2})?:|:)\s*(.*)$/i,
    );
    if (inlineMatch) {
      const rest = inlineMatch[1].trim();
      if (rest) {
        const parts = [rest];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (!next || /^(?:#{1,6}\s+|[-*]\s+|[A-Z][a-zA-Z\s]+:)/.test(next)) break;
          parts.push(next);
          if (/[.!?]$/.test(next)) break;
        }
        responsibilityText = parts.join(' ');
        break;
      }

      const parts = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) {
          if (parts.length > 0) break;
          continue;
        }
        if (/^(?:#{1,6}\s+|[-*]\s+|[A-Z][a-zA-Z\s]+:)/.test(next)) break;
        parts.push(next);
        if (/[.!?]$/.test(next)) break;
      }
      if (parts.length > 0) {
        responsibilityText = parts.join(' ');
        break;
      }
    }

    const headingMatch = line.match(
      /^(?:#{1,6}\s+)?(?:\*{1,2}|_{1,2})?Responsibility:?(?:\*{1,2}|_{1,2})?:?\s*$/i,
    );
    if (headingMatch) {
      const parts = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) {
          if (parts.length > 0) break;
          continue;
        }
        if (/^(?:#{1,6}\s+|[-*]\s+|[A-Z][a-zA-Z\s]+:)/.test(next)) break;
        parts.push(next);
        if (/[.!?]$/.test(next)) break;
      }
      if (parts.length > 0) {
        responsibilityText = parts.join(' ');
        break;
      }
    }
  }

  if (!responsibilityText) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^#{1,6}\s+/.test(trimmed)) continue;
      if (/^(?:Symbol|Kind|Language|Location):/i.test(trimmed)) continue;
      responsibilityText = trimmed.replace(/^[-*]\s+/, '');
      break;
    }
  }

  if (!responsibilityText) {
    return null;
  }

  const sentence = extractFirstSentence(responsibilityText);
  if (!sentence) {
    return null;
  }

  return sentence.length > 200 ? sentence.slice(0, 200) : sentence;
}

export function upsertSymbolIndexEntry(index, entry) {
  const existing = index?.[entry.symbolKey];

  let semanticSummary;
  if (entry.semanticSummary === null) {
    semanticSummary = null;
  } else if (entry.semanticSummary !== undefined) {
    const trimmed = typeof entry.semanticSummary === 'string'
      ? entry.semanticSummary.trim()
      : String(entry.semanticSummary).trim();
    semanticSummary = trimmed.length > 0 ? trimmed : null;
  } else if (existing?.semanticSummary !== undefined) {
    semanticSummary = existing.semanticSummary;
  }

  const record = {
    memoryId: entry.memoryId ?? null,
    graphNodeId: entry.graphNodeId ?? null,
    codeHash: entry.codeHash,
    status: entry.status,
    lastEnrichedAt: entry.lastEnrichedAt ?? null,
  };

  if (semanticSummary !== undefined && semanticSummary !== null) {
    record.semanticSummary = semanticSummary;
  } else if (entry.semanticSummary === null) {
    record.semanticSummary = null;
  } else if (entry.semanticSummary !== undefined && semanticSummary === null) {
    record.semanticSummary = null;
  } else if (existing && 'semanticSummary' in existing && existing.semanticSummary === null) {
    record.semanticSummary = null;
  }

  // N5B (plan 3.5 / S11): optional narrative fingerprint bundle
  // `{narrativeHash, calleeSummaryHashes, promptVersion}`. Omitted fields
  // preserve any existing bundle (or add nothing on legacy records), an
  // explicit null clears it, and a partial or malformed bundle rejects with
  // TypeError before any record is produced.
  const narrativeFields = [entry.narrativeHash, entry.calleeSummaryHashes, entry.promptVersion];
  const supplied = narrativeFields.filter((value) => value !== undefined);
  const clearing = narrativeFields.some((value) => value === null);
  if (clearing) {
    const values = narrativeFields.filter((value) => value !== undefined && value !== null);
    if (values.length > 0) {
      throw new TypeError('narrativeHash, calleeSummaryHashes and promptVersion must be supplied together (null clears all three)');
    }
  } else if (supplied.length > 0) {
    if (supplied.length < 3) {
      throw new TypeError('narrativeHash, calleeSummaryHashes and promptVersion must be supplied together');
    }
    const bundle = validateNarrativeEvidence({
      narrativeHash: entry.narrativeHash,
      calleeSummaryHashes: entry.calleeSummaryHashes,
      promptVersion: entry.promptVersion,
    });
    record.narrativeHash = bundle.narrativeHash;
    record.calleeSummaryHashes = bundle.calleeSummaryHashes;
    record.promptVersion = bundle.promptVersion;
  } else if (existing && existing.narrativeHash !== undefined) {
    record.narrativeHash = existing.narrativeHash;
    if (existing.calleeSummaryHashes !== undefined) record.calleeSummaryHashes = existing.calleeSummaryHashes;
    if (existing.promptVersion !== undefined) record.promptVersion = existing.promptVersion;
  }

  return {
    ...index,
    [entry.symbolKey]: record,
  };
}

export function findGraphNodeIdByMemoryId(index, memoryId) {
  for (const entry of Object.values(index)) {
    if (entry.memoryId === memoryId) {
      return entry.graphNodeId ?? null;
    }
  }
  return null;
}

export function findMemoryIdByGraphNodeId(index, graphNodeId) {
  for (const entry of Object.values(index)) {
    if (entry.graphNodeId === graphNodeId) {
      return entry.memoryId ?? null;
    }
  }
  return null;
}
