/**
 * Leveled symbol/file cards with deterministic token ceilings (S16, plan 4.4).
 *
 * Levels and confirmed ceilings (ceilings, NOT target lengths — never pad):
 *   - compact  (2000): essentials only.
 *   - extended (5000): essentials + context (relation lists).
 *   - deep    (10000): essentials + context + evidence (role evidence).
 *
 * Token counting uses the shared deterministic chars/4 estimator
 * (`estimateTokens`); no model/provider calls are made. When an assembled
 * card exceeds its ceiling, the lowest-priority sections are dropped in a
 * fixed order (evidence, then context); essentials are never dropped. Nothing
 * is ever added to approach the ceiling.
 */

import { estimateTokens } from '../providers/ollama-token-counter.mjs';

/** Section priority: essentials first, then context, then evidence. */
const SECTION_ORDER = ['essentials', 'context', 'evidence'];

export const CARD_LEVELS = {
  compact: { ceiling: 2000, sections: ['essentials'] },
  extended: { ceiling: 5000, sections: ['essentials', 'context'] },
  deep: { ceiling: 10000, sections: ['essentials', 'context', 'evidence'] },
};

function roleSummary(roleClassification) {
  if (roleClassification == null) return null;
  const { role = null, layer = null, confidence = 0 } = roleClassification;
  return { role, layer, confidence };
}

function roleEvidence(roleClassification) {
  const evidence = roleClassification?.evidence;
  return Array.isArray(evidence) ? evidence : [];
}

/** Build the ordered sections for a symbol facts object. */
function symbolSections(facts, enrichment) {
  return {
    essentials: {
      id: facts.id,
      kind: facts.kind ?? null,
      signature: facts.signature ?? null,
      location: facts.location ?? null,
      role: roleSummary(facts.roleClassification),
      fanIn: facts.fanIn ?? 0,
      fanOut: facts.fanOut ?? 0,
      summary: typeof enrichment === 'string' ? enrichment : '',
    },
    context: {
      callers: facts.callers ?? [],
      callees: facts.callees ?? [],
      imports: facts.imports ?? [],
      importedBy: facts.importedBy ?? [],
      implements: facts.implements ?? [],
      tests: facts.tests ?? [],
    },
    evidence: {
      roleEvidence: roleEvidence(facts.roleClassification),
    },
  };
}

/** Build the ordered sections for a file card facts object. */
function fileSections(facts, enrichment) {
  return {
    essentials: {
      path: facts.path,
      kind: 'file',
      role: roleSummary(facts.roleClassification),
      symbolCount: facts.symbolCount ?? 0,
      summary: typeof enrichment === 'string' ? enrichment : '',
    },
    context: {
      exports: facts.exports ?? [],
      members: facts.members ?? [],
      importsFrom: facts.importsFrom ?? [],
      importedBy: facts.importedBy ?? [],
    },
    evidence: {
      roleEvidence: roleEvidence(facts.roleClassification),
    },
  };
}

/**
 * Assemble a leveled card from already-computed facts and enrichment text.
 *
 * @param {object} args
 * @param {object} args.facts      - buildFacts() or buildFileCard() output.
 * @param {string} args.enrichment - existing semantic summary text ('' if none).
 * @param {'compact'|'extended'|'deep'} args.level
 * @returns {{level:string, tokenCeiling:number, tokensEstimated:number,
 *            truncated:boolean, omittedSections:string[], card:object}}
 */
export function buildLeveledCard({ facts, enrichment, level } = {}) {
  const spec = CARD_LEVELS[level];
  if (!spec) {
    throw new TypeError(`level must be one of compact|extended|deep, got ${JSON.stringify(level)}`);
  }
  if (!facts || typeof facts !== 'object') {
    throw new TypeError('buildLeveledCard requires a facts object');
  }

  const sections = facts.kind === 'file' ? fileSections(facts, enrichment) : symbolSections(facts, enrichment);

  // Sections this level is allowed to include, in priority order.
  const included = SECTION_ORDER.filter((name) => spec.sections.includes(name));
  const omittedSections = [];

  const assemble = (names) => {
    const card = {};
    for (const name of names) Object.assign(card, sections[name]);
    return card;
  };

  // Drop lowest-priority optional sections (never essentials) until the card
  // fits the ceiling. Essentials are mandatory and kept even if alone they
  // exceed the ceiling (marked truncated without padding or field loss).
  let active = [...included];
  let card = assemble(active);
  let tokensEstimated = estimateTokens(JSON.stringify(card));
  while (tokensEstimated > spec.ceiling && active.length > 1) {
    const dropped = active.pop();
    omittedSections.unshift(dropped);
    card = assemble(active);
    tokensEstimated = estimateTokens(JSON.stringify(card));
  }

  const truncated = omittedSections.length > 0 || tokensEstimated > spec.ceiling;

  return {
    level,
    tokenCeiling: spec.ceiling,
    tokensEstimated,
    truncated,
    omittedSections,
    card,
  };
}
