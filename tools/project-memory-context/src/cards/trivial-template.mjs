// Trivial-symbol template path (accepted plan 3.4 / spec S10).
//
// Trivial symbols — getters, or fewer than 5 lines without branching — get a
// deterministic template narrative and make no LLM call. Triviality is proven
// from structure only:
//   * the trusted structured worklist kind `getter`, or
//   * an actual getter AST form in the declared slice (JS/TS `get x()`,
//     Python whose decorator's own subject is `property` — never a `property`
//     call argument such as `@decorate(property)` and never `@x.setter` —,
//     C# `get` accessor or expression-bodied arrow on a property or indexer
//     declaration), or
//   * a declared range of 1..TRIVIAL_MAX_LINES physical code lines whose
//     parsed syntax contains no branching construct (if/switch/match/loops/
//     try/catch/ternaries/short-circuit operators and optional chains).
// Names are never heuristics: a method named `getFoo` is not a getter, and
// the template never interpolates symbol names. Comments and string literals
// never fabricate branches because detection walks the real Tree-sitter AST.
//
// Honest limits, verified against the shipped grammars:
//   * Branch vocabularies are trusted only for javascript, typescript, tsx,
//     python and csharp. Every other grammar (java, go, rust, ruby, php, cpp,
//     kotlin, swift, …) resolves to `unsupported-language` and keeps the
//     standard flow.
//   * Line counting uses every physical line of the declared range, including
//     comment and blank lines, so comment-heavy spans stay conservatively
//     non-trivial.
//   * Unsupported grammar, syntax errors, unreadable sources and invalid or
//     past-EOF ranges never claim triviality.
//   * A structured `getter` kind is trusted without reading the source; its
//     proof honestly reports `branchTypes: null` (no scan happened).
//
// Parser discipline: this module never mutates or deletes the shared runtime
// singleton from `initParser()`. Each analysis constructs its own owned
// `Parser` instance after shared initialization, deletes only its own parse
// trees and parser, and leaves the cached `Language` objects untouched, so
// interleaved different-language analyses (and a future N6 concurrency pool)
// cannot race on shared parser state. Method/property slices that are not
// valid standalone programs are parsed inside a synthetic single-member class
// wrapper; the wrapper is parsing scaffolding only — line counts and facts
// always come from the preserved code bytes of the slice, never from the
// wrapper.
//
// This module performs no enrichment I/O of its own beyond reading the
// requested symbol source, and it never generates graph facts: the template
// narrative is validated against the shared N1 `NARRATIVE_SCHEMA` with the
// caller's authoritative known-key set before it may be persisted, and empty
// sideEffects/errors/contracts/mentions lists mean "uninferred", never
// "proved absent".

import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { Parser } from 'web-tree-sitter';

import { initParser, loadLanguage } from '../extractors/tree-sitter/runtime.mjs';
import { languageForExtension } from '../extractors/tree-sitter/language-map.mjs';
import { validateNarrative } from './narrative-schema.mjs';

/** Maximum physical code lines for the branch-free trivial form (spec: "<5"). */
export const TRIVIAL_MAX_LINES = 4;

// Symbol language aliases → shipped grammar names. Anything not listed here
// (nor resolving through the file extension to a vocabulary-backed grammar)
// is unsupported for the fast path.
const LANGUAGE_GRAMMAR = new Map([
  ['javascript', 'javascript'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['typescript', 'typescript'],
  ['ts', 'typescript'],
  ['tsx', 'tsx'],
  ['python', 'python'],
  ['py', 'python'],
  ['csharp', 'csharp'],
  ['cs', 'csharp'],
]);

// Synthetic single-member wrapper container per grammar family. Wrapping is
// only attempted after a raw slice parse produced errors.
const WRAPPER_CONTAINER = {
  javascript: 'class_body',
  typescript: 'class_body',
  tsx: 'class_body',
  csharp: 'declaration_list',
};

// Branch node vocabularies, each name verified against the shipped WASM
// grammar it belongs to (never guessed from regexes or names).
const BRANCH_NODES = {
  javascript: [
    'if_statement', 'switch_statement', 'for_statement', 'for_in_statement',
    'while_statement', 'do_statement', 'try_statement', 'catch_clause',
    'ternary_expression', 'optional_chain',
  ],
  typescript: [
    'if_statement', 'switch_statement', 'for_statement', 'for_in_statement',
    'while_statement', 'do_statement', 'try_statement', 'catch_clause',
    'ternary_expression', 'optional_chain',
  ],
  tsx: [
    'if_statement', 'switch_statement', 'for_statement', 'for_in_statement',
    'while_statement', 'do_statement', 'try_statement', 'catch_clause',
    'ternary_expression', 'optional_chain',
  ],
  python: [
    'if_statement', 'match_statement', 'for_statement', 'while_statement',
    'try_statement', 'except_clause', 'conditional_expression',
    'boolean_operator', 'list_comprehension', 'set_comprehension',
    'dictionary_comprehension', 'generator_expression',
  ],
  csharp: [
    'if_statement', 'switch_statement', 'switch_expression', 'foreach_statement',
    'for_statement', 'while_statement', 'do_statement', 'try_statement',
    'catch_clause', 'conditional_expression', 'conditional_access_expression',
  ],
};

// Short-circuit operator filters: only these operators make the otherwise
// shared binary/assignment node types branching.
const LOGICAL_OPERATORS = new Set(['&&', '||', '??', '&&=', '||=', '??=']);
const OPERATOR_NODES = {
  javascript: ['binary_expression', 'augmented_assignment_expression'],
  typescript: ['binary_expression', 'augmented_assignment_expression'],
  tsx: ['binary_expression', 'augmented_assignment_expression'],
  python: [],
  csharp: ['binary_expression', 'assignment_expression'],
};

function grammarFor(symbol) {
  const explicit = typeof symbol.language === 'string'
    ? LANGUAGE_GRAMMAR.get(symbol.language.toLowerCase())
    : null;
  if (explicit) return explicit;
  const extension = extname(symbol.filePath ?? '');
  if (!extension) return null;
  const byExtension = languageForExtension(extension);
  return byExtension && BRANCH_NODES[byExtension] ? byExtension : null;
}

function declaredLineCount(symbol) {
  const range = symbol.range;
  if (!range || typeof range !== 'object') return null;
  const { startLine, endLine } = range;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  if (startLine < 1 || endLine < startLine) return null;
  return endLine - startLine + 1;
}

async function parseSlice(grammar, slice) {
  let parser = null;
  let tree = null;
  try {
    // Shared initialization only: the returned singleton parser is never
    // mutated, reused or deleted here. The analysis below owns `parser`.
    await initParser();
    const language = await loadLanguage(grammar);
    parser = new Parser();
    parser.setLanguage(language);

    tree = parser.parse(slice);
    let wrapped = false;
    if (!tree || tree.rootNode.hasError) {
      if (tree) { tree.delete(); tree = null; }
      if (!WRAPPER_CONTAINER[grammar]) return { failed: true };
      wrapped = true;
      tree = parser.parse(`class PmcTrivialWrap {\n${slice}\n}`);
      if (!tree || tree.rootNode.hasError) return { failed: true };
    }

    const ownedTree = tree;
    const ownedParser = parser;
    const parsed = {
      grammar,
      wrapped,
      root: ownedTree.rootNode,
      // Dispose closes over the OWNED tree/parser references — never the
      // shared singleton parser and never a cached Language — and is
      // idempotent, so the success path below can hand cleanup over without
      // nulling the captured variables (which would silently delete nothing).
      // Exactly one successful parse leaves this function; the failure paths
      // in `finally` still delete their own partial tree and parser.
      disposed: false,
      dispose() {
        if (parsed.disposed) return;
        parsed.disposed = true;
        ownedTree.delete();
        ownedParser.delete();
      },
    };
    tree = null;
    parser = null;
    return parsed;
  } catch {
    return { failed: true };
  } finally {
    if (tree) tree.delete();
    if (parser) parser.delete();
  }
}

function wrapperContainer(parsed) {
  const classNode = parsed.root.namedChildren.find((node) => node.type === 'class_declaration');
  if (!classNode) return null;
  return classNode.namedChildren.find((node) => node.type === WRAPPER_CONTAINER[parsed.grammar]) ?? null;
}

function primaryConstruct(parsed) {
  const container = parsed.wrapped ? wrapperContainer(parsed) : parsed.root;
  if (!container) return null;
  const members = container.namedChildren.filter((node) => node.type !== 'comment');
  return members.length === 1 ? members[0] : null;
}

function isJavaScriptGetter(node) {
  if (node.type !== 'method_definition') return false;
  // The getter discriminator is the anonymous `get` token of the grammar;
  // a property identifier merely named `get` is a named child, never matched.
  return node.children.some((child) => !child.isNamed && child.type === 'get');
}

function isPythonPropertyDecorator(decorator) {
  if (decorator.type !== 'decorator') return false;
  // Only the decorator's OWN subject proves a property: `@property` and
  // `@pkg.property`, optionally called (`@property()`), qualify. A `property`
  // identifier inside call arguments — `@decorate(property)` — is an argument,
  // never the decorator itself, and `@x.setter` / `@x.deleter` subjects are
  // not getters.
  let subject = decorator.namedChildren[0] ?? null;
  if (subject?.type === 'call') subject = subject.childForFieldName('function') ?? null;
  if (subject?.type === 'identifier') return subject.text === 'property';
  if (subject?.type === 'attribute') return subject.childForFieldName('attribute')?.text === 'property';
  return false;
}

function isPythonGetter(node) {
  if (node.type !== 'decorated_definition') return false;
  return node.namedChildren.some((decorator) => isPythonPropertyDecorator(decorator));
}

function csharpAccessorHasGet(node) {
  return node
    .descendantsOfType(['accessor_declaration'])
    .some((accessor) => accessor.children.some((child) => !child.isNamed && child.type === 'get'));
}

function isCsharpGetter(node) {
  // Properties and indexers are both getter carriers: `{ get; }`, the
  // expression-bodied property arrow, and `public T this[int i] { get ... }`.
  // A set-only accessor (property or indexer) is never a getter.
  if (node.type === 'property_declaration') {
    if (node.namedChildren.some((child) => child.type === 'arrow_expression_clause')) return true;
    return csharpAccessorHasGet(node);
  }
  if (node.type === 'indexer_declaration') return csharpAccessorHasGet(node);
  return false;
}

function isPrimaryGetter(parsed) {
  const primary = primaryConstruct(parsed);
  if (!primary) return false;
  if (parsed.grammar === 'csharp') return isCsharpGetter(primary);
  if (parsed.grammar === 'python') return isPythonGetter(primary);
  return isJavaScriptGetter(primary);
}

function scanBranches(parsed) {
  const found = new Set(parsed.root.descendantsOfType(BRANCH_NODES[parsed.grammar]).map((node) => node.type));
  for (const nodeType of OPERATOR_NODES[parsed.grammar]) {
    for (const node of parsed.root.descendantsOfType([nodeType])) {
      const operator = node.childForFieldName('operator');
      if (operator && LOGICAL_OPERATORS.has(operator.text)) found.add(`${nodeType}:${operator.text}`);
    }
  }
  return [...found].sort();
}

/**
 * Prove whether a worklist symbol qualifies for the trivial-template fast
 * path, from structure only. Never throws: every failure resolves to
 * `{trivial: false, reason}` so callers keep the standard enrichment flow.
 *
 * @param {object} input
 * @param {object} input.symbol - worklist symbol entry (kind/language/filePath/range)
 * @param {string} input.projectRoot
 * @param {string} [input.source] - already-read file content (avoids a re-read)
 * @returns {Promise<{trivial: false, reason: string, lineCount?: number, branchTypes?: string[]} | {trivial: true, proof: object}>}
 */
export async function analyzeTrivialSymbol({ symbol, projectRoot, source } = {}) {
  if (!symbol || typeof symbol !== 'object' || Array.isArray(symbol)) {
    return { trivial: false, reason: 'invalid-symbol' };
  }

  // Trusted structured kind: the accepted plan lists getters unconditionally,
  // so no source read, parse or branch scan happens for this proof.
  if (symbol.kind === 'getter') {
    return {
      trivial: true,
      proof: {
        kind: 'getter',
        detection: 'structured-kind',
        language: typeof symbol.language === 'string' ? symbol.language : null,
        lineCount: declaredLineCount(symbol),
        branchTypes: null,
      },
    };
  }

  const grammar = grammarFor(symbol);
  if (!grammar) return { trivial: false, reason: 'unsupported-language' };

  const declared = declaredLineCount(symbol);
  if (declared === null) return { trivial: false, reason: 'invalid-range' };

  let content = source;
  if (content === undefined || content === null) {
    try {
      content = await readFile(resolve(projectRoot ?? '', symbol.filePath ?? ''), 'utf8');
    } catch {
      return { trivial: false, reason: 'source-unavailable' };
    }
  }

  const fileLines = content.split('\n');
  const { startLine, endLine } = symbol.range;
  if (endLine > fileLines.length) return { trivial: false, reason: 'invalid-range' };
  const slice = fileLines.slice(startLine - 1, endLine).join('\n');
  const lineCount = slice.split('\n').length;

  const parsed = await parseSlice(grammar, slice);
  if (parsed.failed) return { trivial: false, reason: 'parse-error' };

  try {
    if (parsed.root.hasError) return { trivial: false, reason: 'parse-error' };
    const branchTypes = scanBranches(parsed);
    if (isPrimaryGetter(parsed)) {
      // The accepted plan lists getters as trivial regardless of body size or
      // branching; the scan result is still reported for honest diagnostics.
      return {
        trivial: true,
        proof: { kind: 'getter', detection: 'ast', language: grammar, lineCount, branchTypes },
      };
    }
    if (branchTypes.length > 0) return { trivial: false, reason: 'branching', lineCount, branchTypes };
    if (lineCount < 1 || lineCount > TRIVIAL_MAX_LINES) {
      return { trivial: false, reason: 'line-count', lineCount };
    }
    return {
      trivial: true,
      proof: { kind: 'branch-free', detection: 'ast', language: grammar, lineCount, branchTypes: [] },
    };
  } finally {
    parsed.dispose();
  }
}

function describeLocation(symbol) {
  const startLine = symbol.range?.startLine;
  const filePath = typeof symbol.filePath === 'string' ? symbol.filePath : 'its declared file';
  return Number.isInteger(startLine) ? `${filePath}:${startLine}` : filePath;
}

/**
 * Build the deterministic N1-schema template narrative for a proven trivial
 * symbol. Pure: no I/O, no name interpolation, no invented facts. Mentions
 * only ever contain the symbol's own canonical key, and only when the
 * caller's authoritative known-key set contains it.
 *
 * @param {object} input
 * @param {object} input.symbol
 * @param {object} input.proof - a `{trivial: true}` proof from analyzeTrivialSymbol
 * @param {Set<string>} input.knownKeys - authoritative canonical graph symbol keys
 * @returns {object} a narrative matching NARRATIVE_SCHEMA
 */
export function buildTrivialNarrative({ symbol, proof, knownKeys } = {}) {
  if (!symbol || typeof symbol !== 'object' || Array.isArray(symbol)) {
    throw new TypeError('symbol must be a worklist symbol entry');
  }
  if (!proof || typeof proof !== 'object' || (proof.kind !== 'getter' && proof.kind !== 'branch-free')) {
    throw new TypeError('proof must be a triviality proof with kind "getter" or "branch-free"');
  }
  if (!(knownKeys instanceof Set)) {
    throw new TypeError('knownKeys must be a Set of canonical graph symbol keys');
  }

  const location = describeLocation(symbol);
  const isGetter = proof.kind === 'getter';
  const getterProofSource = proof.detection === 'structured-kind'
    ? 'trusted structured getter kind from the worklist'
    : 'getter syntax found by AST parsing';

  const narrative = {
    summary: isGetter
      ? 'Trivial getter template: exposes a property value; no language model call analyzed this symbol.'
      : `Trivial template for a branch-free symbol of at most ${TRIVIAL_MAX_LINES} physical code lines; no model call was made.`,
    behavior: isGetter
      ? [
        `Getter declared at ${location}; exposes the property value.`,
        `Getter proof: ${getterProofSource}.`,
      ]
      : [
        `Branch-free declaration spanning ${proof.lineCount} physical code line(s) at ${location}.`,
        "AST parsing found no branching constructs in this symbol's own syntax.",
      ],
    // Uninferred, never proved absent: the template ran no dynamic analysis.
    sideEffects: [],
    errors: [],
    contracts: [],
    changeNotes: 'Generated from the trivial-symbol structural template without a language model call; verify actual behavior before modifying this symbol.',
    mentions: knownKeys.has(symbol.symbolKey) ? [symbol.symbolKey] : [],
  };

  return narrative;
}

/**
 * Combined opt-in hook used by the queue seams: analyze, build the template
 * and validate it against the shared NARRATIVE_SCHEMA plus the authoritative
 * known keys before any caller may persist it. Returns `null` (never throws)
 * for non-trivial symbols and for any analysis or validation failure, so the
 * caller conservatively keeps the standard model-backed flow.
 *
 * @param {object} input
 * @param {object} input.symbol
 * @param {string} input.projectRoot
 * @param {Set<string>} [input.knownKeys] - defaults to an empty (fail-closed) set
 * @param {string} [input.source] - already-read file content
 * @returns {Promise<{narrative: object, proof: object}|null>}
 */
export async function tryBuildTrivialNarrative({ symbol, projectRoot, knownKeys, source } = {}) {
  try {
    const known = knownKeys instanceof Set ? knownKeys : new Set();
    const analysis = await analyzeTrivialSymbol({ symbol, projectRoot, source });
    if (!analysis.trivial) return null;
    const narrative = buildTrivialNarrative({ symbol, proof: analysis.proof, knownKeys: known });
    const check = validateNarrative(narrative, { symbolKeys: known });
    if (!check.valid) return null;
    return { narrative, proof: analysis.proof };
  } catch {
    return null;
  }
}
