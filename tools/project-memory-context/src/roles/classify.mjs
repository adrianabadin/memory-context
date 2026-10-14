// tools/project-memory-context/src/roles/classify.mjs
//
// F2 role classifier (plan 2.3) with declarative packaged profiles.
// Pure weighted scoring over the S1 signals; produces `{role, layer, confidence,
// evidence[]}` for files and symbols. A member inherits a uniquely identified
// container's role unless its own stronger provided evidence overrides. When no
// signal supports a role it returns the documented unknown shape
// `{role: null, layer: null, confidence: 0, evidence: []}` (no invented enum).
//
// Confidence is a finite 0..1 heuristic evidence strength (noisy-OR over the
// agreeing signals' weights), NOT a calibrated probability or semantic-accuracy
// score. Classification reads no project/fixture/graph and never hardcodes
// golden keys or paths; profiles are declarative data loaded at module init.
import { readFileSync } from 'node:fs';
import {
  frameworkAnnotationSignal,
  structuredHeritageSignal,
  containerRoleSignal,
  nameSuffixSignal,
  decoratorFactorySignal,
  directoryTokenSignal,
  topologySignal,
  sideEffectMarkerSignal,
  priorityIndex,
} from './signals.mjs';

const genericProfile = JSON.parse(readFileSync(new URL('./profiles/generic.json', import.meta.url), 'utf8'));
const nodeCliProfile = JSON.parse(readFileSync(new URL('./profiles/node-cli.json', import.meta.url), 'utf8'));
const frameworkProfiles = Object.fromEntries(
  ['express', 'nest', 'spring', 'aspnet', 'django'].map((name) => [
    name, JSON.parse(readFileSync(new URL(`./profiles/${name}.json`, import.meta.url), 'utf8')),
  ]),
);

function dedupeByKey(items, keyFn) {
  const map = new Map();
  for (const item of items) map.set(keyFn(item), item); // later entry wins
  return [...map.values()];
}

// node-cli extends generic: scalar tables merge, keyed tables dedupe with the
// override winning on the same key (profile priority), array tables replace.
// Both inputs are deep-cloned first so the returned profile shares no object
// identity with the module-owned JSON — mutating or freezing a returned profile
// can never corrupt later loadProfile results (B2 isolation).
export function mergeProfiles(base, override) {
  const b = structuredClone(base);
  const o = structuredClone(override);
  return {
    ...b,
    ...o,
    roleLayers: { ...b.roleLayers, ...o.roleLayers },
    weights: { ...b.weights, ...o.weights },
    topologyThresholds: { ...b.topologyThresholds, ...o.topologyThresholds },
    decoratorFactoryNames: o.decoratorFactoryNames ?? b.decoratorFactoryNames,
    suffixRoles: dedupeByKey([...(b.suffixRoles ?? []), ...(o.suffixRoles ?? [])], (s) => String(s.suffix).toLowerCase()),
    directoryRoles: dedupeByKey([...(b.directoryRoles ?? []), ...(o.directoryRoles ?? [])], (s) => String(s.token).toLowerCase()),
    annotationRoles: dedupeByKey([...(b.annotationRoles ?? []), ...(o.annotationRoles ?? [])], (s) => s.annotation),
    sideEffectRoles: dedupeByKey([...(b.sideEffectRoles ?? []), ...(o.sideEffectRoles ?? [])], (s) => s.marker),
    heritageTypeRoles: dedupeByKey([...(b.heritageTypeRoles ?? []), ...(o.heritageTypeRoles ?? [])], (r) => String(r.name).toLowerCase()),
    topologyRules: o.topologyRules ?? b.topologyRules,
  };
}

export function loadProfile(name) {
  if (name === 'generic') return structuredClone(genericProfile);
  if (name === 'node-cli') return mergeProfiles(genericProfile, nodeCliProfile);
  if (Object.hasOwn(frameworkProfiles, name)) return mergeProfiles(genericProfile, frameworkProfiles[name]);
  throw new TypeError(`Unknown role profile: ${name}`);
}

// Tables whose `role` must be a declared role in `roleLayers` (supported enum).
const ROLE_TABLES = [
  'suffixRoles',
  'directoryRoles',
  'annotationRoles',
  'sideEffectRoles',
  'heritageTypeRoles',
  'topologyRules',
];

// B3: the public resolved-profile API fails closed before scoring. Every weight
// must be a finite number in [0,1] (never silently clamped) and every role a
// mapping table can produce must be declared in roleLayers. Legitimate declared
// profile extensions (a role added to roleLayers AND used in a table) pass; a
// bogus weight or undeclared role throws TypeError instead of being invented.
export function assertProfile(profile) {
  if (
    !profile || typeof profile !== 'object' ||
    typeof profile.roleLayers !== 'object' || profile.roleLayers === null ||
    typeof profile.weights !== 'object' || profile.weights === null
  ) {
    throw new TypeError('classify requires a resolved role profile object (see loadProfile)');
  }
  for (const [key, value] of Object.entries(profile.weights)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`role profile weight '${key}' must be a finite number in [0,1], got ${String(value)}`);
    }
  }
  for (const table of ROLE_TABLES) {
    for (const entry of profile[table] ?? []) {
      const role = entry?.role;
      if (typeof role !== 'string' || !Object.hasOwn(profile.roleLayers, role)) {
        throw new TypeError(`role profile ${table} references undeclared role '${String(role)}'`);
      }
    }
  }
}

const round4 = (x) => Math.round(x * 10000) / 10000;

function basenameNoExt(path) {
  const base = String(path).replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

function collectSignals(record, profile, allSymbols, resolveRole) {
  const signals = [];
  for (const s of [
    frameworkAnnotationSignal({ annotations: record.annotations, profile }),
    structuredHeritageSignal({ heritage: record.heritage, profile }),
    containerRoleSignal({ record, allSymbols, profile, resolveRole }),
    nameSuffixSignal({ record, profile }),
    decoratorFactorySignal({ record, profile }),
    directoryTokenSignal({ path: record.filePath, profile }),
    topologySignal({ topology: record.topology, profile }),
    sideEffectMarkerSignal({ sideEffects: record.sideEffects, profile }),
  ]) {
    if (s) signals.push(s);
  }
  return signals;
}

// Group signals by role; confidence = noisy-OR over agreeing weights. Winner =
// highest confidence, ties broken by signal priority then role name (deterministic).
function scoreRoles(signals) {
  const byRole = new Map();
  for (const s of signals) {
    if (!byRole.has(s.role)) byRole.set(s.role, []);
    byRole.get(s.role).push(s);
  }
  let best = null;
  for (const [role, sigs] of byRole) {
    let inv = 1;
    let bestPriority = Infinity;
    for (const s of sigs) {
      inv *= 1 - s.weight;
      const pi = priorityIndex(s.signal);
      if (pi < bestPriority) bestPriority = pi;
    }
    const confidence = round4(1 - inv);
    if (
      !best ||
      confidence > best.confidence + 1e-9 ||
      (Math.abs(confidence - best.confidence) <= 1e-9 && bestPriority < best.bestPriority) ||
      (Math.abs(confidence - best.confidence) <= 1e-9 && bestPriority === best.bestPriority && role < best.role)
    ) {
      best = { role, confidence, sigs, bestPriority };
    }
  }
  return best;
}

function finalize(best, profile) {
  if (!best) return { role: null, layer: null, confidence: 0, evidence: [] };
  const evidence = best.sigs
    .slice()
    .sort((a, b) => priorityIndex(a.signal) - priorityIndex(b.signal) || a.evidence.localeCompare(b.evidence))
    .map((s) => s.evidence);
  const layer = profile.roleLayers[best.role] ?? null;
  return { role: best.role, layer, confidence: best.confidence, evidence };
}

// B3 (second batch): enforce the output contract on the ACTUALLY generated
// signals, after collection but before the noisy-OR arithmetic and before any
// return. `assertProfile` only sees present weights and table-mapped roles; this
// gate additionally catches a required-but-missing active weight (undefined ->
// non-finite confidence) and an implicit/hardcoded role no table declares (e.g.
// the decorator-factory role). It is generic over whatever signals fire — never
// a hardcoded special case and never a silent clamp.
function assertSignals(signals, profile) {
  for (const s of signals) {
    if (typeof s.weight !== 'number' || !Number.isFinite(s.weight) || s.weight < 0 || s.weight > 1) {
      throw new TypeError(`signal '${s.signal}' produced a non-finite or out-of-range weight ${String(s.weight)}`);
    }
    if (typeof s.role !== 'string' || !Object.hasOwn(profile.roleLayers, s.role)) {
      throw new TypeError(`signal '${s.signal}' produced undeclared role '${String(s.role)}'`);
    }
  }
}

// Internal classification path (profile already validated once by the caller).
// Container-role resolution recurses here so a deep member chain is not
// re-validated on every hop.
function classifyWithProfile(record, profile, allSymbols) {
  const resolveRole = (r) => classifyWithProfile(r, profile, allSymbols).role;
  const signals = collectSignals(record, profile, allSymbols, resolveRole);
  assertSignals(signals, profile);
  // A member's stronger structured annotation is an explicit role override:
  // corroborating suffix/path markers must not outvote it through noisy-OR.
  const inherited = signals.find((signal) => signal.signal === 'container-role');
  const annotation = signals.find((signal) => signal.signal === 'framework-annotation');
  if (record.kind === 'method' && inherited && annotation && annotation.weight > inherited.weight) {
    return finalize(scoreRoles(signals.filter((signal) => signal.role === annotation.role)), profile);
  }
  return finalize(scoreRoles(signals), profile);
}

export function classifySymbol(record, { profile, allSymbols = [] } = {}) {
  assertProfile(profile);
  if (!record || typeof record !== 'object') throw new TypeError('classifySymbol requires a symbol record');
  return classifyWithProfile(record, profile, allSymbols);
}

// Files are classified from their path (directory token + basename suffix) plus
// any caller-provided annotations/side-effects/topology. The pseudo-record kind
// 'file' naturally disables decorator-factory and container-role signals.
export function classifyFile({ path, annotations, sideEffects, topology } = {}, { profile } = {}) {
  assertProfile(profile);
  if (typeof path !== 'string' || !path) throw new TypeError('classifyFile requires a path');
  const record = {
    filePath: path,
    name: basenameNoExt(path),
    kind: 'file',
    exportScope: 'exported',
    annotations,
    sideEffects,
    topology,
  };
  return classifyWithProfile(record, profile, []);
}
