#!/usr/bin/env node
// tools/project-memory-context/cli/name-communities.mjs
//
// Assign descriptive, function-oriented names to graph communities by calling
// bigmodel.cn's GLM-4-Flash model with each community's member summaries.
//
// Pure helpers (truncateSymbols, buildNamingPrompt, parseNameResponse,
// callGLM4Flash) and the nameCommunities pipeline are exported for testing.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openGraphDb } from '../src/graph-store/graph-db.mjs';

// ── Constants ──────────────────────────────────────────────────────────────────

export const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const GLM_MODEL = 'glm-4-flash';
export const API_KEY_ENV = 'BIGMODEL_API_KEY';
export const MAX_SYMBOLS = 50;
export const DEFAULT_RATE_LIMIT_MS = 250;
export const REQUEST_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  'You name clusters of related source-code symbols. Given a list of symbols and ' +
  'their summaries, respond with a short (2-4 word) descriptive name capturing the ' +
  "community's functional role. Respond with the name only — no quotes, no explanation.";

// ── Pure helpers ────────────────────────────────────────────────────────────────

/**
 * Limit a symbol list to `max` entries, keeping the highest-degree symbols.
 * Stable and deterministic; missing degree counts as 0.
 *
 * @param {Array<{degree?: number}>} symbols
 * @param {number} max
 */
export function truncateSymbols(symbols, max = MAX_SYMBOLS) {
  if (symbols.length <= max) return symbols;
  return [...symbols]
    .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
    .slice(0, max);
}

/**
 * Build the chat messages for the naming request.
 *
 * @param {Array<{label?: string, summary?: string}>} symbols
 * @returns {Array<{role: string, content: string}>}
 */
export function buildNamingPrompt(symbols) {
  const lines = symbols.map((s) => {
    const label = s.label ?? s.id ?? 'symbol';
    const summary = s.summary ?? '';
    return summary ? `- ${label}: ${summary}` : `- ${label}`;
  });
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Symbols in this community:\n${lines.join('\n')}` },
  ];
}

/**
 * Extract a clean community name from a GLM chat-completions response.
 * Returns null when the response is empty or malformed.
 */
export function parseNameResponse(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  const cleaned = content.trim().replace(/^["']+|["']+$/g, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

// ── API client ──────────────────────────────────────────────────────────────────

/**
 * Call GLM-4-Flash to generate a community name. Returns the name string, or
 * null on any failure (non-ok status, network error, timeout, empty response).
 *
 * @param {Array<{label?: string, summary?: string}>} symbols
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function callGLM4Flash(symbols, apiKey, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  try {
    const response = await fetchImpl(GLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      body: JSON.stringify({
        model: GLM_MODEL,
        messages: buildNamingPrompt(symbols),
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return parseNameResponse(data);
  } catch {
    return null;
  }
}

// ── Graph queries ────────────────────────────────────────────────────────────────

/**
 * Read distinct communities and their member symbols from the raw graph DB.
 * Enriched summaries are read from node metadata when available.
 *
 * @param {DatabaseSync} db
 * @returns {Array<{communityId: string, symbols: object[]}>}
 */
export function fetchCommunities(db) {
  const rows = db
    .prepare(
      `SELECT id, label, community, degree, metadata
         FROM nodes
        WHERE community IS NOT NULL`,
    )
    .all();

  const byCommunity = new Map();
  for (const row of rows) {
    const key = String(row.community);
    if (!byCommunity.has(key)) byCommunity.set(key, []);
    byCommunity.get(key).push({
      id: row.id,
      label: row.label,
      degree: row.degree ?? 0,
      summary: extractSummary(row.metadata),
    });
  }

  return [...byCommunity.entries()].map(([communityId, symbols]) => ({ communityId, symbols }));
}

function extractSummary(metadataJson) {
  try {
    const meta = JSON.parse(metadataJson ?? '{}');
    return meta.summary ?? meta.explanation ?? '';
  } catch {
    return '';
  }
}

// ── Pipeline ─────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Name every non-empty community in the store.
 *
 * @param {{
 *   fetchCommunities: () => Array<{communityId: string, symbols: object[]}>,
 *   upsertCommunityName: (id: string, name: string) => void,
 * }} store
 * @param {{
 *   apiKey?: string,
 *   callGLM?: (symbols: object[], apiKey: string) => Promise<string|null>,
 *   rateLimitMs?: number,
 *   maxSymbols?: number,
 *   log?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<{named: number, skipped: number, failed: number}>}
 */
export async function nameCommunities(store, opts = {}) {
  const log = opts.log ?? console.error;
  const apiKey = opts.apiKey;
  const callGLM = opts.callGLM ?? ((symbols, key) => callGLM4Flash(symbols, key));
  const rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const maxSymbols = opts.maxSymbols ?? MAX_SYMBOLS;

  const communities = store.fetchCommunities();
  const result = { named: 0, skipped: 0, failed: 0 };

  if (!apiKey) {
    log(`[name-communities] API key ${API_KEY_ENV} is not set — skipping naming, keeping generic ids.`);
    // Every non-empty community is effectively skipped.
    for (const c of communities) {
      if (c.symbols && c.symbols.length > 0) result.skipped++;
    }
    return result;
  }

  for (const community of communities) {
    const symbols = community.symbols ?? [];
    if (symbols.length === 0) {
      result.skipped++;
      continue;
    }

    const payload = truncateSymbols(symbols, maxSymbols);
    const name = await callGLM(payload, apiKey);

    if (name) {
      store.upsertCommunityName(community.communityId, name);
      result.named++;
      log(`[name-communities] community ${community.communityId} → "${name}"`);
    } else {
      result.failed++;
      log(`[name-communities] community ${community.communityId} → naming failed, keeping generic id.`);
    }

    await sleep(rateLimitMs);
  }

  return result;
}

// ── CLI entry ────────────────────────────────────────────────────────────────────

function findProjectRoot(startDir) {
  let currentDir = resolve(startDir);
  while (true) {
    if (existsSync(join(currentDir, '.planning', 'project-memory-context', 'install.json'))) {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const projectRoot = findProjectRoot(argv[0] ?? process.cwd());
  if (!projectRoot) {
    console.error('[name-communities] No PMC project found (missing install.json).');
    return 1;
  }

  const graphDir = join(projectRoot, '.planning', 'project-memory-context', 'graph');
  const dbPath = join(graphDir, 'graph.db');
  const jsonPath = join(graphDir, 'graph.json');

  if (!existsSync(dbPath) || !existsSync(jsonPath)) {
    console.error('[name-communities] graph.db or graph.json missing — run map/refresh first.');
    return 1;
  }

  const store = openGraphDb(dbPath, jsonPath);
  // Open a raw read handle to query community membership.
  const rawDb = new DatabaseSync(dbPath);
  store.fetchCommunities = () => fetchCommunities(rawDb);

  try {
    const result = await nameCommunities(store, { apiKey: env[API_KEY_ENV] });
    console.error(
      `[name-communities] done — named: ${result.named}, skipped: ${result.skipped}, failed: ${result.failed}`,
    );
    return 0;
  } finally {
    rawDb.close();
    store.close();
  }
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '');
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then((code) => process.exit(code ?? 0));
}
