// tools/project-memory-context/tests/name-communities.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  truncateSymbols,
  buildNamingPrompt,
  parseNameResponse,
  callGLM4Flash,
  nameCommunities,
  GLM_ENDPOINT,
  GLM_MODEL,
} from '../cli/name-communities.mjs';

// ── truncateSymbols ────────────────────────────────────────────────────────────

test('truncateSymbols returns all symbols when under the limit', () => {
  const symbols = [
    { id: 'a', degree: 1 },
    { id: 'b', degree: 2 },
  ];
  assert.deepEqual(truncateSymbols(symbols, 50), symbols);
});

test('truncateSymbols keeps the highest-degree symbols when over the limit', () => {
  const symbols = [];
  for (let i = 0; i < 75; i++) {
    symbols.push({ id: `s${i}`, degree: i }); // s74 has highest degree
  }
  const result = truncateSymbols(symbols, 50);
  assert.equal(result.length, 50);
  // The single lowest-degree symbol (degree 0) must be dropped.
  assert.ok(!result.some((s) => s.id === 's0'), 'lowest-degree symbol should be dropped');
  // The highest-degree symbol must be retained.
  assert.ok(result.some((s) => s.id === 's74'), 'highest-degree symbol should be kept');
});

test('truncateSymbols defaults missing degree to 0 and stays deterministic', () => {
  const symbols = [
    { id: 'x' }, // no degree → 0
    { id: 'y', degree: 5 },
    { id: 'z', degree: 3 },
  ];
  const result = truncateSymbols(symbols, 2);
  assert.equal(result.length, 2);
  const ids = result.map((s) => s.id).sort();
  assert.deepEqual(ids, ['y', 'z'], 'should keep the two highest-degree symbols');
});

// ── buildNamingPrompt ──────────────────────────────────────────────────────────

test('buildNamingPrompt produces a system + user message pair', () => {
  const messages = buildNamingPrompt([
    { label: 'openGraphDb', summary: 'Opens the SQLite graph database.' },
    { label: 'buildFromGraphJson', summary: 'Rebuilds nodes/edges from graph.json.' },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
});

test('buildNamingPrompt embeds each symbol label and summary in the user message', () => {
  const messages = buildNamingPrompt([
    { label: 'openGraphDb', summary: 'Opens the SQLite graph database.' },
  ]);
  const userContent = messages[1].content;
  assert.match(userContent, /openGraphDb/);
  assert.match(userContent, /Opens the SQLite graph database\./);
});

// ── parseNameResponse ──────────────────────────────────────────────────────────

test('parseNameResponse extracts the assistant message content', () => {
  const data = { choices: [{ message: { content: 'Graph Storage' } }] };
  assert.equal(parseNameResponse(data), 'Graph Storage');
});

test('parseNameResponse trims whitespace and surrounding quotes', () => {
  const data = { choices: [{ message: { content: '  "Retrieval Layer"\n' } }] };
  assert.equal(parseNameResponse(data), 'Retrieval Layer');
});

test('parseNameResponse returns null for an empty or malformed response', () => {
  assert.equal(parseNameResponse({}), null);
  assert.equal(parseNameResponse({ choices: [] }), null);
  assert.equal(parseNameResponse({ choices: [{ message: { content: '   ' } }] }), null);
});

// ── callGLM4Flash ──────────────────────────────────────────────────────────────

test('callGLM4Flash posts to the GLM endpoint with a Bearer token and parses the name', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'Graph Storage' } }] };
      },
    };
  };

  const name = await callGLM4Flash(
    [{ label: 'openGraphDb', summary: 'Opens the graph db.' }],
    'secret-key',
    { fetchImpl },
  );

  assert.equal(captured.url, GLM_ENDPOINT);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer secret-key');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, GLM_MODEL);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(name, 'Graph Storage');
});

test('callGLM4Flash returns null when the API responds with a non-ok status', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    async text() {
      return 'server error';
    },
  });
  const name = await callGLM4Flash([{ label: 'x', summary: 'y' }], 'key', { fetchImpl });
  assert.equal(name, null);
});

test('callGLM4Flash returns null when fetch throws (timeout/network)', async () => {
  const fetchImpl = async () => {
    throw new Error('AbortError: timeout');
  };
  const name = await callGLM4Flash([{ label: 'x', summary: 'y' }], 'key', { fetchImpl });
  assert.equal(name, null);
});

// ── nameCommunities pipeline ───────────────────────────────────────────────────

function makeStoreStub({ communities }) {
  const stored = new Map();
  return {
    fetchCommunitiesCalls: 0,
    fetchCommunities() {
      return communities;
    },
    upsertCommunityName(id, name) {
      stored.set(String(id), name);
    },
    getCommunityName(id) {
      return stored.get(String(id)) ?? null;
    },
    getAllCommunityNames() {
      return [...stored.entries()].map(([community_id, name]) => ({ community_id, name }));
    },
    _stored: stored,
  };
}

test('nameCommunities names each non-empty community and stores the result', async () => {
  const store = makeStoreStub({
    communities: [
      { communityId: '1', symbols: [{ label: 'openGraphDb', summary: 'Opens db', degree: 2 }] },
      { communityId: '2', symbols: [{ label: 'renderContext', summary: 'Renders', degree: 1 }] },
    ],
  });

  const names = ['Graph Storage', 'Retrieval Layer'];
  let call = 0;
  const callGLM = async () => names[call++];

  const result = await nameCommunities(store, {
    apiKey: 'key',
    callGLM,
    rateLimitMs: 0,
    log: () => {},
  });

  assert.equal(store.getCommunityName('1'), 'Graph Storage');
  assert.equal(store.getCommunityName('2'), 'Retrieval Layer');
  assert.equal(result.named, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);
});

test('nameCommunities skips empty communities without calling the API', async () => {
  const store = makeStoreStub({
    communities: [
      { communityId: '1', symbols: [] },
      { communityId: '2', symbols: [{ label: 'x', summary: 'y', degree: 1 }] },
    ],
  });

  let glmCalls = 0;
  const callGLM = async () => {
    glmCalls++;
    return 'Named';
  };

  const result = await nameCommunities(store, { apiKey: 'key', callGLM, rateLimitMs: 0, log: () => {} });

  assert.equal(glmCalls, 1, 'API should be called only for the non-empty community');
  assert.equal(store.getCommunityName('1'), null, 'empty community keeps generic id');
  assert.equal(store.getCommunityName('2'), 'Named');
  assert.equal(result.skipped, 1);
  assert.equal(result.named, 1);
});

test('nameCommunities keeps the generic id and continues when the API fails for one community', async () => {
  const store = makeStoreStub({
    communities: [
      { communityId: '1', symbols: [{ label: 'a', summary: 'b', degree: 1 }] },
      { communityId: '2', symbols: [{ label: 'c', summary: 'd', degree: 1 }] },
    ],
  });

  const callGLM = async (symbols) =>
    symbols[0].label === 'a' ? null /* failure */ : 'Recovered';

  const result = await nameCommunities(store, { apiKey: 'key', callGLM, rateLimitMs: 0, log: () => {} });

  assert.equal(store.getCommunityName('1'), null, 'failed community keeps generic id');
  assert.equal(store.getCommunityName('2'), 'Recovered', 'subsequent community still processed');
  assert.equal(result.failed, 1);
  assert.equal(result.named, 1);
});

test('nameCommunities aborts early and makes no API calls when the API key is missing', async () => {
  const store = makeStoreStub({
    communities: [{ communityId: '1', symbols: [{ label: 'a', summary: 'b', degree: 1 }] }],
  });

  let glmCalls = 0;
  const callGLM = async () => {
    glmCalls++;
    return 'Named';
  };
  const warnings = [];

  const result = await nameCommunities(store, {
    apiKey: undefined,
    callGLM,
    rateLimitMs: 0,
    log: (msg) => warnings.push(msg),
  });

  assert.equal(glmCalls, 0, 'no API calls without a key');
  assert.equal(store.getCommunityName('1'), null, 'community keeps generic id');
  assert.equal(result.skipped, 1);
  assert.ok(
    warnings.some((w) => /api key/i.test(w)),
    'should log a warning about the missing API key',
  );
});

test('nameCommunities truncates large communities before naming', async () => {
  const bigSymbols = [];
  for (let i = 0; i < 75; i++) bigSymbols.push({ label: `s${i}`, summary: 's', degree: i });
  const store = makeStoreStub({
    communities: [{ communityId: '1', symbols: bigSymbols }],
  });

  let received;
  const callGLM = async (symbols) => {
    received = symbols;
    return 'Big Community';
  };

  await nameCommunities(store, { apiKey: 'key', callGLM, rateLimitMs: 0, log: () => {} });

  assert.equal(received.length, 50, 'symbols passed to the API are truncated to 50');
});
