// tools/project-memory-context/src/roles/signals.mjs
//
// Pure signal extractors for the F2 role classifier (plan 2.1). Each function
// is deterministic, side-effect free, reads no project/fixture/graph, and
// returns either `null` (no supporting evidence) or a single signal object
// `{ signal, role, weight, evidence }`.
//
// S1 covers six kinds of evidence. Decorator and inheritance evidence each have
// a strong structured form (caller-provided from real syntax inspection) and a
// weaker marker/inheritance form, so the six kinds map to these signal kinds:
//   1. decorators    -> framework-annotation (structured) + decorator-factory (name marker)
//   2. inheritance   -> structured-heritage (structured)  + container-role (member inheritance)
//   3. suffix        -> name-suffix
//   4. directory     -> directory-token
//   5. topology      -> topology
//   6. side-effects  -> side-effect-marker
//
// Honesty contract: names, paths, topology and side-effect inputs are weak
// markers or heuristics, never verified AST decorator/inheritance/execution
// facts. Evidence strings label them as such. Structured annotation/heritage
// inputs are trusted as caller-provided real-syntax evidence; this module does
// not verify them and never invents them from names.

// Descending weight per accepted v3 §3.2; also the tie-break/evidence order.
export const SIGNAL_KINDS = [
  'framework-annotation',
  'structured-heritage',
  'container-role',
  'name-suffix',
  'decorator-factory',
  'directory-token',
  'topology',
  'side-effect-marker',
];

export function priorityIndex(signal) {
  const i = SIGNAL_KINDS.indexOf(signal);
  return i === -1 ? SIGNAL_KINDS.length : i;
}

function normalizePath(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

// Longest case-insensitive stereotype match. For name suffixes the name must be
// strictly longer than the stereotype (a bare `Controller` is not `*Controller`);
// heritage base names may also match a stereotype exactly (`Repository<T>`).
function stereotypeMatch(name, suffixRoles, { allowExact = false } = {}) {
  const lower = String(name ?? '').toLowerCase();
  let best = null;
  for (const { suffix, role } of suffixRoles ?? []) {
    const lSuffix = String(suffix).toLowerCase();
    const hit = allowExact
      ? (lower === lSuffix || (lower.length > lSuffix.length && lower.endsWith(lSuffix)))
      : (lower.length > lSuffix.length && lower.endsWith(lSuffix));
    if (hit && (!best || lSuffix.length > best.lSuffix.length)) best = { suffix, role, lSuffix };
  }
  return best;
}

// Normalize a structured heritage clause to its base type name, recognizing the
// accepted v3 inheritance FORMS rather than matching the raw clause end-wise:
//   'implements Repository<User>' -> 'Repository'   (keyword + generics stripped)
//   'models.Model'                -> 'Model'        (terminal dot segment)
//   'ControllerBase'              -> 'ControllerBase' (unchanged compound base)
function baseHeritageName(clause) {
  let s = String(clause ?? '').trim();
  s = s.replace(/^(extends|implements)\s+/i, '');
  const lt = s.indexOf('<');
  if (lt !== -1) s = s.slice(0, lt);
  const dot = s.lastIndexOf('.');
  if (dot !== -1) s = s.slice(dot + 1);
  return s.trim();
}

// 1a. Framework decorator/annotation from caller-provided structured evidence.
export function frameworkAnnotationSignal({ annotations, profile }) {
  const decorators = annotations?.decorators;
  if (!Array.isArray(decorators) || decorators.length === 0) return null;
  for (const raw of decorators) {
    const name = String(raw).replace(/^@/, '');
    const hit = (profile.annotationRoles ?? []).find((r) => r.annotation === name);
    if (hit) {
      return {
        signal: 'framework-annotation',
        role: hit.role,
        weight: profile.weights.frameworkAnnotation,
        evidence: `structured decorator annotation '@${name}' (from caller-provided syntax evidence) -> role ${hit.role}`,
      };
    }
  }
  return null;
}

// 2a. Inheritance/implementation from caller-provided structured heritage. The
// clause is normalized to its base type name (v3 inheritance forms: dotted,
// generic, compound-base), then matched against the explicit heritage-type table
// and the stereotype table (exact or suffix). Never invents AST from names — the
// clause is trusted caller-provided syntax evidence, honestly labeled.
export function structuredHeritageSignal({ heritage, profile }) {
  if (!Array.isArray(heritage) || heritage.length === 0) return null;
  for (const clause of heritage) {
    const base = baseHeritageName(clause);
    const declared = (profile.heritageTypeRoles ?? []).find(
      (r) => String(r.name).toLowerCase() === base.toLowerCase(),
    );
    if (declared) {
      return {
        signal: 'structured-heritage',
        role: declared.role,
        weight: profile.weights.structuredHeritage,
        evidence: `structured heritage '${clause}' (from caller-provided syntax evidence) -> role ${declared.role}`,
      };
    }
    const match = stereotypeMatch(base, profile.suffixRoles, { allowExact: true });
    if (match) {
      return {
        signal: 'structured-heritage',
        role: match.role,
        weight: profile.weights.structuredHeritage,
        evidence: `structured heritage '${clause}' (from caller-provided syntax evidence) -> role ${match.role}`,
      };
    }
  }
  return null;
}

// 2b. Member inherits a uniquely identified container role. Ambiguity (zero or
// multiple same-name containers in the file) fails closed — never array order.
// `resolveRole` is injected by classify.mjs to avoid a circular import.
export function containerRoleSignal({ record, allSymbols, profile, resolveRole }) {
  if (record.kind !== 'method' || typeof record.container !== 'string' || !record.container) return null;
  const target = normalizePath(record.filePath);
  const matches = (allSymbols ?? []).filter(
    (s) => s.kind === 'class' && s.name === record.container && normalizePath(s.filePath) === target,
  );
  if (matches.length !== 1) return null;
  const role = resolveRole(matches[0]);
  if (!role) return null;
  return {
    signal: 'container-role',
    role,
    weight: profile.weights.containerRole,
    evidence: `inherits role from unique container '${record.container}'`,
  };
}

// 3. Name-suffix stereotype. Two principled exclusions keep the accepted v3
// ordering (suffixes outweigh directory tokens) from misclassifying symbols
// whose name describes what they REFERENCE rather than their role:
//   - abstraction kinds (interface/type) name what they expose, not their role;
//   - symbols inside a test scope (a directory token mapped to the `test` role)
//     are tests by location, however they are named after the unit they exercise.
// Both gates are profile/kind driven, never hardcoded golden keys or paths.
export function nameSuffixSignal({ record, profile }) {
  if (record.kind === 'interface' || record.kind === 'type') return null;
  const testTokens = new Set(
    (profile.directoryRoles ?? [])
      .filter((r) => r.role === 'test')
      .map((r) => String(r.token).toLowerCase()),
  );
  const segments = String(record.filePath ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((s) => testTokens.has(s.toLowerCase()))) return null;
  const match = stereotypeMatch(record.name, profile.suffixRoles);
  if (!match) return null;
  return {
    signal: 'name-suffix',
    role: match.role,
    weight: profile.weights.nameSuffix,
    evidence: `name suffix marker: '${record.name}' ends with '${match.suffix}' -> role ${match.role}`,
  };
}

// 1b. Decorator-factory name marker (honestly a marker, not verified syntax).
export function decoratorFactorySignal({ record, profile }) {
  if (record.kind !== 'function' || record.exportScope !== 'local') return null;
  if (!(profile.decoratorFactoryNames ?? []).includes(record.name)) return null;
  return {
    signal: 'decorator-factory',
    role: 'decorator',
    weight: profile.weights.decoratorFactory,
    evidence: `name marker only: local function named '${record.name}' matches configured decorator-factory name; decorator syntax not verified -> role decorator`,
  };
}

// 4. Directory token: the deepest path segment that matches a configured token.
export function directoryTokenSignal({ path, profile }) {
  const segments = normalizePath(path).split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i].toLowerCase();
    const hit = (profile.directoryRoles ?? []).find((r) => String(r.token).toLowerCase() === segment);
    if (hit) {
      return {
        signal: 'directory-token',
        role: hit.role,
        weight: profile.weights.directoryToken,
        evidence: `directory token marker: path segment '${hit.token}' -> role ${hit.role}`,
      };
    }
  }
  return null;
}

// 5. Graph topology heuristic (weak; caller-provided fan-in/fan-out only).
export function topologySignal({ topology, profile }) {
  const fanIn = topology?.fanIn;
  const fanOut = topology?.fanOut;
  if (!Number.isFinite(fanIn) || !Number.isFinite(fanOut)) return null;
  const t = profile.topologyThresholds ?? {};
  const rules = profile.topologyRules ?? [];
  let when = null;
  if (fanOut >= t.fanOut && fanIn <= t.lowFanIn) when = 'highFanOutLowFanIn';
  else if (fanIn >= t.fanIn) when = 'highFanIn';
  if (!when) return null;
  const rule = rules.find((r) => r.when === when);
  if (!rule) return null;
  return {
    signal: 'topology',
    role: rule.role,
    weight: profile.weights.topology,
    evidence: `topology heuristic (weak): fan-in ${fanIn}, fan-out ${fanOut} -> suggests role ${rule.role}`,
  };
}

// 6. Side-effect marker (honestly a marker, not a verified execution fact).
export function sideEffectMarkerSignal({ sideEffects, profile }) {
  if (!Array.isArray(sideEffects) || sideEffects.length === 0) return null;
  for (const marker of sideEffects) {
    const hit = (profile.sideEffectRoles ?? []).find((r) => r.marker === marker);
    if (hit) {
      return {
        signal: 'side-effect-marker',
        role: hit.role,
        weight: profile.weights.sideEffectMarker,
        evidence: `side-effect marker '${marker}' (not a verified execution fact) -> role ${hit.role}`,
      };
    }
  }
  return null;
}
