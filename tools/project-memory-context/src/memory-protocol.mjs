// tools/project-memory-context/src/memory-protocol.mjs
//
// Pure logic for the dual memory-save protocol. NO I/O at import time.
//
// The protocol routes every memory-save trigger to BOTH backends:
//   - PMC (pmc-agent-memory_store) — MANDATORY, always fires.
//   - Engram (engram_mem_save)     — additive, fires only when version is "dual".
//
// `detectMemoryProtocol` decides the active version from a runtime flag file
// (if present) or from backend availability detection. Backend probing uses
// injected fs/spawn implementations so the logic stays unit-testable without
// touching the real filesystem or spawning subprocesses.

import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const VALID_VERSIONS = new Set(['dual', 'pmc-only']);
const DEFAULT_ENGRAM_PROBE_TIMEOUT_MS = 2000;

/**
 * Map an Engram observation type to a PMC memory category.
 *
 * Unknown / null / anything-else falls back to "learning".
 *
 * @param {string|null|undefined} engramType
 * @returns {string} PMC category
 */
export function mapEngramTypeToPmcCategory(engramType) {
  switch (engramType) {
    case 'bugfix':
      return 'bug-fix';
    case 'decision':
      return 'architecture';
    case 'architecture':
      return 'architecture';
    case 'discovery':
      return 'learning';
    case 'pattern':
      return 'learning';
    case 'config':
      return 'tool-usage';
    case 'preference':
      return 'personal';
    default:
      return 'learning';
  }
}

/**
 * Build a PMC `pmc-agent-memory_store` payload from Engram `mem_save` args.
 *
 * @param {{ title?: string, content?: string, type?: string, topic_key?: string }} engramArgs
 * @param {{ sessionId?: string, projectId?: string }} [context]
 * @returns {{ content: string, category: string, tags: string[], provenance: { origin: string, sessionId?: string } }}
 */
export function buildPmcPayloadFromEngramSave(engramArgs = {}, context = {}) {
  const { title = '', content = '', type, topic_key: topicKey } = engramArgs;
  const { sessionId, projectId } = context;

  const titleText = String(title ?? '').trim();
  const bodyText = String(content ?? '').trim();

  const composedContent = titleText
    ? `**What**: ${titleText}\n\n${bodyText}`
    : bodyText;

  const tags = [];
  if (projectId) tags.push(projectId);
  if (topicKey) {
    for (const segment of String(topicKey).split('/')) {
      const trimmed = segment.trim();
      if (trimmed && !tags.includes(trimmed)) tags.push(trimmed);
    }
  }

  const provenance = { origin: 'manual' };
  if (sessionId) provenance.sessionId = sessionId;

  return {
    content: composedContent,
    category: mapEngramTypeToPmcCategory(type),
    tags,
    provenance,
  };
}

async function readJsonSafe(filePath, readFileImpl) {
  try {
    return JSON.parse(await readFileImpl(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function pathExists(filePath, statImpl) {
  try {
    await statImpl(filePath);
    return true;
  } catch {
    return false;
  }
}

function probeEngramOnPath(spawnImpl, platform, timeoutMs) {
  return new Promise((resolvePromise) => {
    const finder = platform === 'win32' ? 'where' : 'which';
    let settled = false;

    const finish = (available) => {
      if (settled) return;
      settled = true;
      resolvePromise(available);
    };

    let child;
    try {
      child = spawnImpl(finder, ['engram'], { stdio: 'ignore', shell: false });
    } catch {
      finish(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        /* best-effort */
      }
      finish(false);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.once?.('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.once?.('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

/**
 * Detect the active memory protocol version for a project.
 *
 * Resolution order:
 *   1. If `.planning/project-memory-context/memory-protocol.json` exists and
 *      carries a valid `memory_protocol_version`, that wins (source = "flag").
 *   2. Otherwise the version is derived from backend availability:
 *        - both PMC + Engram available  -> "dual"
 *        - either one unavailable        -> "pmc-only"
 *      (source = "detected").
 *
 * Never throws — degrades to safe defaults so a detection failure can never
 * crash a session start.
 *
 * @param {{ projectRoot?: string }} [options]
 * @param {{ readFile?: Function, stat?: Function, spawn?: Function, platform?: string, engramProbeTimeoutMs?: number }} [deps]
 * @returns {Promise<{ version: string, pmcAvailable: boolean, engramAvailable: boolean, pmcDbPath: string|null, source: string }>}
 */
export async function detectMemoryProtocol(options = {}, deps = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const readFileImpl = deps.readFile ?? readFile;
  const statImpl = deps.stat ?? stat;
  const spawnImpl = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;
  const timeoutMs = deps.engramProbeTimeoutMs ?? DEFAULT_ENGRAM_PROBE_TIMEOUT_MS;

  const planningDir = join(projectRoot, '.planning', 'project-memory-context');
  const installPath = join(planningDir, 'install.json');
  const flagPath = join(planningDir, 'memory-protocol.json');

  // Resolve PMC DB path + availability from install.json.
  let pmcDbPath = null;
  let pmcAvailable = false;
  const installState = await readJsonSafe(installPath, readFileImpl);
  const memoryDbBase = installState?.memoryDbPath;
  if (memoryDbBase && typeof memoryDbBase === 'string') {
    pmcDbPath = memoryDbBase.endsWith('.db') ? memoryDbBase : `${memoryDbBase}.db`;
    pmcAvailable = await pathExists(pmcDbPath, statImpl);
  }

  // Probe Engram on PATH.
  let engramAvailable = false;
  try {
    engramAvailable = await probeEngramOnPath(spawnImpl, platform, timeoutMs);
  } catch {
    engramAvailable = false;
  }

  // Detected version: dual only when both backends are usable.
  const detectedVersion = pmcAvailable && engramAvailable ? 'dual' : 'pmc-only';

  // Flag file overrides detection when present and valid.
  const flagState = await readJsonSafe(flagPath, readFileImpl);
  const flagVersion = flagState?.memory_protocol_version;
  if (VALID_VERSIONS.has(flagVersion)) {
    return {
      version: flagVersion,
      pmcAvailable,
      engramAvailable,
      pmcDbPath,
      source: 'flag',
    };
  }

  return {
    version: detectedVersion,
    pmcAvailable,
    engramAvailable,
    pmcDbPath,
    source: 'detected',
  };
}

/**
 * Validate a protocol version string.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function isValidProtocolVersion(version) {
  return VALID_VERSIONS.has(version);
}

/**
 * Render a human-readable summary of a detection result.
 *
 * @param {{ version: string, pmcAvailable: boolean, engramAvailable: boolean, pmcDbPath: string|null, source: string }} detection
 * @returns {string}
 */
export function formatProtocolReport(detection) {
  const {
    version = 'unknown',
    pmcAvailable = false,
    engramAvailable = false,
    pmcDbPath = null,
    source = 'detected',
  } = detection ?? {};

  const yesNo = (value) => (value ? 'yes' : 'no');
  const lines = [];

  lines.push('Memory Protocol');
  lines.push('===============');
  lines.push(`  Version:          ${version} (source: ${source})`);
  lines.push(`  PMC available:    ${yesNo(pmcAvailable)}`);
  lines.push(`  Engram available: ${yesNo(engramAvailable)}`);
  lines.push(`  PMC DB path:      ${pmcDbPath ?? '(none)'}`);
  lines.push('');

  if (version === 'dual') {
    lines.push('  Saves fire to BOTH PMC (mandatory) and Engram (additive).');
  } else {
    lines.push('  Saves fire to PMC only. Engram is skipped.');
    if (!engramAvailable) {
      lines.push('  Reason: Engram CLI not found on PATH.');
    }
    if (!pmcAvailable) {
      lines.push('  WARNING: PMC DB not found — saves cannot be persisted.');
    }
  }

  return lines.join('\n');
}
