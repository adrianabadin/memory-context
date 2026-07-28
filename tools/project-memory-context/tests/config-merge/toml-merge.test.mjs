import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeTomlConfig, mergeTomlBlock } from '../../src/config-merge/toml.mjs';
import { parseToml, stringifyToml, isParseFailure } from '../../src/config-merge/toml.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pmc-toml-merge-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('mergeTomlConfig returns malformed: true WITHOUT touching disk when existing TOML is unparseable', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'config.toml');
    const broken = 'this is = "not valid toml\n[mcp_servers\n';
    await writeFile(filePath, broken, 'utf8');

    const result = await mergeTomlConfig(filePath, { mcp_servers: { 'pmc-query': { type: 'local' } } });

    assert.equal(result.malformed, true);
    const after = await readFile(filePath, 'utf8');
    assert.equal(after, broken, 'malformed TOML must remain byte-identical');
  });
});

test('mergeTomlConfig preserves unowned keys and isolates owned keys into the PMC-owned block', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'config.toml');
    const existing = [
      '# unrelated comment - must survive',
      'model = "gpt-5"',
      '[other_tool]',
      'name = "preserve-me"',
      '',
    ].join('\n');
    await writeFile(filePath, existing, 'utf8');

    const result = await mergeTomlConfig(filePath, {
      mcp_servers: {
        'pmc-query': { type: 'local', command: ['pmc', 'query-server'], enabled: true },
        'pmc-agent-memory': { type: 'local', command: ['npx', 'agent-memory-mcp'], enabled: true },
      },
    });

    assert.equal(result.status, 'installed');
    const updated = await readFile(filePath, 'utf8');

    // Unowned content survives verbatim
    assert.equal(updated.includes('# unrelated comment - must survive'), true);
    assert.equal(updated.includes('model = "gpt-5"'), true);
    assert.equal(updated.includes('[other_tool]'), true);
    assert.equal(updated.includes('name = "preserve-me"'), true);

    // Owned keys appear in the PMC block
    assert.equal(updated.includes('# pmc:mcp'), true, 'PMC-owned block opens with `# pmc:mcp`');
    assert.equal(updated.includes('# /pmc:mcp'), true, 'PMC-owned block closes with `# /pmc:mcp`');
    assert.equal(updated.includes('[mcp_servers.pmc-query]'), true);
    assert.equal(updated.includes('[mcp_servers.pmc-agent-memory]'), true);

    // Re-parse to confirm PMC-owned TOML is still valid
    const parsed = parseToml(updated);
    assert.ok(parsed.mcp_servers?.['pmc-query']);
    assert.ok(parsed.mcp_servers?.['pmc-agent-memory']);
    assert.equal(parsed.model, 'gpt-5');
    assert.equal(parsed.other_tool?.name, 'preserve-me');
  });
});

test('mergeTomlConfig is idempotent: second merge produces unchanged status and identical bytes', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'config.toml');
    await writeFile(
      filePath,
      ['# preamble', 'tool = "tweak"', ''].join('\n'),
      'utf8',
    );

    const owned = {
      mcp_servers: {
        'pmc-query': { type: 'local', command: ['pmc'] },
      },
    };

    const first = await mergeTomlConfig(filePath, owned);
    assert.equal(first.status, 'installed');
    const afterFirst = await readFile(filePath, 'utf8');

    const second = await mergeTomlConfig(filePath, owned);
    assert.equal(second.status, 'unchanged');
    const afterSecond = await readFile(filePath, 'utf8');

    assert.equal(afterFirst, afterSecond, 'second merge must not mutate bytes');
  });
});

test('mergeTomlConfig on missing file creates a PMC-owned-only file that round-trips through smol-toml', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'config.toml');

    const result = await mergeTomlConfig(filePath, {
      mcp_servers: {
        'pmc-query': { type: 'local', command: ['pmc', 'query-server'] },
      },
    });
    assert.equal(result.status, 'installed');

    const text = await readFile(filePath, 'utf8');
    assert.equal(text.includes('# pmc:mcp'), true);
    assert.equal(text.includes('[mcp_servers.pmc-query]'), true);

    const parsed = parseToml(text);
    assert.ok(parsed.mcp_servers['pmc-query']);
  });
});

test('mergeTomlBlock: block-only splice respects the marker and is idempotent', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'config.toml');
    const seed = '[model]\nname = "x"\n';
    await writeFile(filePath, seed, 'utf8');

    const block = '[mcp_servers.pmc-query]\ntype = "local"\n';

    const r1 = await mergeTomlBlock(filePath, block, 'mcp');
    assert.equal(r1.status, 'installed');

    const once = await readFile(filePath, 'utf8');
    const r2 = await mergeTomlBlock(filePath, block, 'mcp');
    assert.equal(r2.status, 'unchanged');
    const twice = await readFile(filePath, 'utf8');
    assert.equal(once, twice);
    assert.equal(once.includes('# pmc:mcp'), true);
  });
});

test('parseToml round-trips: stringify → parse equals source object semantically', () => {
  const src = {
    mcp_servers: {
      'pmc-query': { type: 'local', command: ['pmc', 'query-server'], enabled: true },
      'pmc-agent-memory': { type: 'local', enabled: false },
    },
    model: 'gpt-5',
  };
  const text = stringifyToml(src);
  assert.equal(text.includes('[mcp_servers'), true);
  const parsed = parseToml(text);
  assert.equal(parsed.mcp_servers['pmc-query'].type, 'local');
  assert.deepEqual(parsed.mcp_servers['pmc-query'].command, ['pmc', 'query-server']);
  assert.equal(parsed.mcp_servers['pmc-agent-memory'].enabled, false);
  assert.equal(parsed.model, 'gpt-5');
});

test('isParseFailure distinguishes a Throwable thrown by parseToml from a valid parse result', async () => {
  // Valid input → success
  const ok = parseToml('key = "value"\n');
  assert.ok(!isParseFailure(ok));
  assert.equal(ok.key, 'value');

  // Invalid input → throws a recognizable failure
  let threw = false;
  try {
    parseToml('bad = "unterminated\n[section');
  } catch (err) {
    threw = true;
    assert.equal(isParseFailure(err), true, 'thrown error should report as a parse failure');
  }
  assert.ok(threw, 'invalid TOML must throw');
});
