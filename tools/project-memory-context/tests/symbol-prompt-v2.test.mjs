/**
 * Prompt v2 (accepted plan 3.3 / spec S9) — opt-in narrative prompt metadata.
 *
 * buildSymbolPromptMeta(symbol, projectRoot) must stay byte-identical to the
 * legacy text prompt and must keep its exact legacy return shape. Passing an
 * explicit `narrativeContext` switches to prompt v2, which carries code,
 * signature, role, callee one-line summaries with canonical keys, at most five
 * callers (name and role), the file-card summary, relevant project rules, the
 * English instruction, the shared NARRATIVE_SCHEMA, and promptVersion 'v2'.
 *
 * Facts and roles are caller-owned: ambiguous, unkeyed and raw-ID nodes are
 * withheld from the prompt instead of being invented from names. Callers keep
 * their supplied deterministic order, labeled as not semantically ranked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROMPT_VERSION, normalizeSymbolKeys } from '../src/cards/prompt-v2.mjs';
import { buildSymbolKey } from '../src/symbol-keys.mjs';
import { NARRATIVE_SCHEMA } from '../src/cards/narrative-schema.mjs';

const ENGLISH_INSTRUCTION =
  'Write all descriptive explanation fields in English, regardless of source comments or conversation language. Preserve code, identifiers, paths, tags and structured keys exactly.';

const USER_TS = [
  "import { db } from './db';",
  '',
  'export async function getUser(id) {',
  '  return db.users.find(id);',
  '}',
  '',
].join('\n');

async function makeProject() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-prompt-v2-'));
  const srcDir = join(projectRoot, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, 'user.ts'), USER_TS, 'utf8');
  return projectRoot;
}

function makeSymbol() {
  return {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|3',
    name: 'getUser',
    kind: 'function',
    language: 'ts',
    filePath: 'src/user.ts',
    range: { startLine: 3, endLine: 5 },
  };
}

function makeNarrativeContext() {
  return {
    symbolKeys: [
      'ts|src/user.ts|function|exported|getUser|3',
      'ts|src/db.ts|function|exported|find|1',
      'ts|src/api.ts|function|exported|listUsers|1',
    ],
    signature: 'export async function getUser(id): Promise<User>',
    role: { role: 'repository', layer: 'domain', confidence: 0.9, evidence: [] },
    callees: [
      { key: 'ts|src/db.ts|function|exported|find|1', name: 'find', summary: 'Returns one row by primary key.' },
    ],
    callers: [
      { key: 'ts|src/api.ts|function|exported|listUsers|1', name: 'listUsers', role: 'controller' },
    ],
    fileCardSummary: 'User lookup helpers for the API layer.',
    projectRules: ['Prefer repository helpers over raw queries.'],
  };
}

async function buildMeta(options) {
  const mod = await import('../cli/enrich-queue.mjs');
  assert.equal(
    typeof mod.buildSymbolPromptMeta,
    'function',
    'buildSymbolPromptMeta must be exported from cli/enrich-queue.mjs',
  );
  const projectRoot = await makeProject();
  try {
    return await mod.buildSymbolPromptMeta(makeSymbol(), projectRoot, options);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test('promptVersion constant is exported as v2 for later narrativeHash use (N5)', () => {
  assert.equal(PROMPT_VERSION, 'v2');
});

test('legacy two-argument buildSymbolPromptMeta keeps byte-identical text and exact return shape', async () => {
  const result = await buildMeta();

  assert.deepEqual(Object.keys(result).sort(), ['prompt', 'totalLines']);
  assert.equal(result.totalLines, 6);

  const expected = [
    'Symbol: getUser',
    'Kind: function',
    'Language: ts',
    'Location: src/user.ts:3-5',
    '',
    'Context (imports):',
    "import { db } from './db';",
    '',
    'Code:',
    'export async function getUser(id) {',
    '  return db.users.find(id);',
    '}',
    '',
    'Return a compact structured explanation with:',
    '- responsibility',
    '- primary inputs',
    '- output',
    '- immediate dependencies',
    '- role in module',
    '',
    ENGLISH_INSTRUCTION,
  ].join('\n');

  assert.equal(result.prompt, expected, 'legacy prompt text must stay byte-identical');
  assert.ok(!('promptVersion' in result), 'legacy result must not carry prompt metadata');
  assert.ok(!('schema' in result), 'legacy result must not carry a schema');
});

test('narrativeContext builds prompt v2 carrying every S9 section plus promptVersion and schema', async () => {
  const result = await buildMeta({ narrativeContext: makeNarrativeContext() });

  assert.equal(result.promptVersion, 'v2');
  assert.equal(result.promptVersion, PROMPT_VERSION);
  assert.deepEqual(result.schema, NARRATIVE_SCHEMA);
  assert.equal(result.totalLines, 6);

  const prompt = result.prompt;

  // Identity header + version marker.
  assert.ok(prompt.includes('Symbol: getUser'));
  assert.ok(prompt.includes('Language: ts'));
  assert.ok(prompt.includes('Prompt version: v2'));

  // Role and signature are explicit caller-owned context.
  assert.ok(prompt.includes('Role: repository (layer: domain, confidence: 0.9)'));
  assert.ok(prompt.includes('Signature: export async function getUser(id): Promise<User>'));

  // Callee one-line summaries with canonical keys.
  assert.ok(prompt.includes('Callee one-line summaries (canonical symbol keys):'));
  assert.ok(prompt.includes('- ts|src/db.ts|function|exported|find|1: Returns one row by primary key.'));

  // At most top-5 callers, name + role, honestly labeled deterministic order.
  assert.ok(prompt.includes('Top callers (at most 5; caller-supplied deterministic order, not ranked by semantic importance):'));
  assert.ok(prompt.includes('- listUsers — role: controller'));

  // File-card summary and relevant project rules.
  assert.ok(prompt.includes('File card summary:'));
  assert.ok(prompt.includes('User lookup helpers for the API layer.'));
  assert.ok(prompt.includes('Relevant project rules:'));
  assert.ok(prompt.includes('- Prefer repository helpers over raw queries.'));

  // Code, imports and the shared schema contract.
  assert.ok(prompt.includes('Code:'));
  assert.ok(prompt.includes('export async function getUser(id) {'));
  assert.ok(prompt.includes("import { db } from './db';"));
  assert.ok(prompt.includes('Output contract: reply with a single JSON object'));
  assert.ok(prompt.includes(JSON.stringify(NARRATIVE_SCHEMA, null, 2)));
  assert.ok(prompt.includes('Mentionable symbol keys'));
  assert.ok(prompt.includes('- ts|src/db.ts|function|exported|find|1'));

  // English instruction is part of the v2 prompt too.
  assert.ok(prompt.includes(ENGLISH_INSTRUCTION));
});

test('prompt v2 withholds ambiguous, unkeyed and raw-ID context nodes instead of inventing identities', async () => {
  const context = makeNarrativeContext();
  context.callees.push(
    { name: 'ghostFind', summary: 'GHOST-SUMMARY-NOKEY' },
    { key: '42', name: 'rawFind', summary: 'RAWSUMMARY-FROM-RAW-ID' },
    {
      key: 'ts|src/db.ts|function|exported|find|9',
      name: 'ambFind',
      summary: 'AMBIGUOUS-SUMMARY-TEXT',
      ambiguous: true,
    },
  );
  context.callers.push(
    { name: 'ghostCaller', role: 'controller' },
    { key: '77', name: 'rawCaller', role: 'util' },
    { key: 'ts|src/api.ts|function|exported|other|1', name: 'ambCaller', role: 'service', ambiguous: true },
  );
  context.projectRules.push(42, null);

  const { prompt } = await buildMeta({ narrativeContext: context });

  assert.ok(prompt.includes('- ts|src/db.ts|function|exported|find|1: Returns one row by primary key.'));
  assert.ok(prompt.includes('- listUsers — role: controller'));

  assert.ok(!prompt.includes('GHOST-SUMMARY-NOKEY'), 'unkeyed callee must be withheld');
  assert.ok(!prompt.includes('RAWSUMMARY-FROM-RAW-ID'), 'raw numeric ID callee must be withheld');
  assert.ok(!prompt.includes('AMBIGUOUS-SUMMARY-TEXT'), 'ambiguous callee must be withheld');
  assert.ok(!prompt.includes('- 42:'), 'raw numeric IDs must never render as canonical keys');
  assert.ok(!prompt.includes('ghostCaller'), 'unkeyed caller must be withheld');
  assert.ok(!prompt.includes('rawCaller'), 'raw-ID caller must be withheld');
  assert.ok(!prompt.includes('ambCaller'), 'ambiguous caller must be withheld');
  assert.ok(prompt.includes('- Prefer repository helpers over raw queries.'), 'string rules still render');
  assert.ok(!prompt.includes('42'), 'non-string project rules must be withheld');
});

test('prompt v2 renders at most five callers in caller-supplied deterministic order', async () => {
  const context = makeNarrativeContext();
  context.callers = Array.from({ length: 7 }, (_, i) => ({
    key: `ts|src/caller${i + 1}.ts|function|exported|caller${i + 1}|1`,
    name: `caller${i + 1}`,
    role: i % 2 === 0 ? 'controller' : 'service',
  }));

  const { prompt } = await buildMeta({ narrativeContext: context });

  assert.ok(prompt.includes('Top callers (at most 5; caller-supplied deterministic order, not ranked by semantic importance):'));
  for (let i = 1; i <= 5; i++) {
    assert.ok(prompt.includes(`caller${i}`), `caller${i} must be rendered`);
  }
  assert.ok(!prompt.includes('caller6'), 'only the first five callers may be rendered');
  assert.ok(!prompt.includes('caller7'), 'only the first five callers may be rendered');

  const positions = [1, 2, 3, 4, 5].map((i) => prompt.indexOf(`caller${i}`));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i - 1] < positions[i], 'callers must keep their supplied deterministic order');
  }
});

test('prompt v2 falls back to the first code line when no signature is supplied', async () => {
  const context = makeNarrativeContext();
  delete context.signature;

  const { prompt } = await buildMeta({ narrativeContext: context });

  assert.ok(prompt.includes('Signature: export async function getUser(id) {'));
});

test('buildSymbolPromptMeta rejects an invalid narrativeContext type instead of degrading silently', async () => {
  await assert.rejects(
    () => buildMeta({ narrativeContext: 'not-an-object' }),
    TypeError,
  );
});

// ── Canonical key handling (N3 correction B2) ────────────────────────────────

test('normalizeSymbolKeys rejects raw graph IDs and null and accepts every real canonical key format', () => {
  assert.throws(() => normalizeSymbolKeys(['123']), TypeError, 'numeric raw IDs are not symbol keys');
  assert.throws(() => normalizeSymbolKeys(['node_123']), TypeError, 'raw graphify IDs are not symbol keys');
  assert.throws(() => normalizeSymbolKeys(['js|src/a.js|function|exported|a|1-node']), TypeError, 'arity must stay numeric');
  assert.throws(() => normalizeSymbolKeys([' js|src/a.js|function|exported|a|1']), TypeError, 'keys are never whitespace-munged');
  assert.throws(() => normalizeSymbolKeys(null), TypeError, 'explicit null is not an absent collection');

  const canonical = [
    'js|src/a.js|function|exported|a|1',
    'ts|src/services/user.service.ts|method|member|UserService.findById|1',
    'csharp|src/User.cs|Acme.App|UserService|method|Find|User Find(int id)',
  ];
  assert.deepEqual([...normalizeSymbolKeys(canonical)], canonical, 'real keys keep exact bytes and order');
  assert.deepEqual([...normalizeSymbolKeys(new Set(canonical))], canonical, 'Set collections are accepted');
});

test('prompt v2 renders canonical member and C# legacy keys unchanged', async () => {
  const memberKey = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
  const csharpKey = 'csharp|src/User.cs|Acme.App|UserService|method|Find|User Find(int id)';
  const context = makeNarrativeContext();
  context.symbolKeys = [...context.symbolKeys, memberKey, csharpKey];
  context.callees = [
    { key: memberKey, name: 'findById', summary: 'Finds a user.\nExtra detail withheld to one line.' },
    { key: csharpKey, name: 'Find', summary: 'Finds a user by id.' },
  ];

  const { prompt } = await buildMeta({ narrativeContext: context });

  assert.ok(prompt.includes(`- ${memberKey}: Finds a user.`), 'member keys render byte-exact');
  assert.ok(prompt.includes(`- ${csharpKey}: Finds a user by id.`), 'C# legacy 7-part keys render byte-exact');
  assert.ok(prompt.includes(`- ${memberKey}`), 'member keys stay mentionable');
});

// ── Explicit malformed list shapes reject (N3 correction B3) ─────────────────

test('prompt v2 rejects malformed explicit caller and project rule list shapes', async () => {
  await assert.rejects(
    () => buildMeta({ narrativeContext: { ...makeNarrativeContext(), callers: 'listUsers' } }),
    TypeError,
    'a non-array callers value must not silently render as none',
  );
  await assert.rejects(
    () => buildMeta({ narrativeContext: { ...makeNarrativeContext(), projectRules: { rule: 'Keep pure.' } } }),
    TypeError,
    'a non-array projectRules value must not silently render as none',
  );
});

// ── Actual builder compatibility for optional empty C# fields (B2 second) ───

test('csharp keys with explicitly empty optional namespace and containerName stay canonical per buildSymbolKey', () => {
  const bothEmpty = buildSymbolKey({
    language: 'csharp',
    filePath: 'src/A.cs',
    namespace: '',
    containerName: '',
    kind: 'class',
    name: 'A',
  });
  assert.equal(bothEmpty, 'csharp|src/A.cs|||class|A|()', 'the actual builder preserves explicit empty optional fields');
  assert.deepEqual([...normalizeSymbolKeys([bothEmpty])], [bothEmpty]);

  const emptyNamespace = buildSymbolKey({ language: 'csharp', filePath: 'src/A.cs', namespace: '', kind: 'class', name: 'A' });
  const emptyContainer = buildSymbolKey({ language: 'csharp', filePath: 'src/A.cs', namespace: 'Example', containerName: '', kind: 'class', name: 'A' });
  assert.deepEqual([...normalizeSymbolKeys([emptyNamespace, emptyContainer])], [emptyNamespace, emptyContainer]);

  // Required parts stay required: signature, kind, name, filePath.
  assert.throws(() => normalizeSymbolKeys(['csharp|src/A.cs|Ns|C|class|A|']), TypeError, 'empty signature stays malformed');
  assert.throws(() => normalizeSymbolKeys(['csharp|src/A.cs|Ns|C||A|()']), TypeError, 'empty kind stays malformed');
  assert.throws(() => normalizeSymbolKeys(['csharp||Ns|C|class|A|()']), TypeError, 'empty filePath stays malformed');
  assert.throws(() => normalizeSymbolKeys(['node_123']), TypeError, 'raw graph IDs stay rejected');
  assert.throws(() => normalizeSymbolKeys(['123']), TypeError, 'numeric raw IDs stay rejected');
});
