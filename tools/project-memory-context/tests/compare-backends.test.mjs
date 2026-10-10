// tests/compare-backends.test.mjs
//
// T-010: compare-backends CLI — PMC-style smoke tests
// Uses node:test runner.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildUsageText } from '../cli/compare-backends.mjs';

describe('compare-backends CLI', () => {
  describe('parseArgs', () => {
    it('parses --engram-db path', () => {
      const result = parseArgs(['--engram-db', '/path/to/engram.db', '--pmc-db', '/path/to/pmc.db']);
      assert.equal(result.engramDbPath, '/path/to/engram.db');
    });

    it('parses --pmc-db path', () => {
      const result = parseArgs(['--engram-db', '/path/to/engram.db', '--pmc-db', '/path/to/pmc.db']);
      assert.equal(result.pmcDbPath, '/path/to/pmc.db');
    });

    it('returns null for missing --engram-db', () => {
      const result = parseArgs(['--pmc-db', '/path/to/pmc.db']);
      assert.equal(result.engramDbPath, null);
    });

    it('returns null for missing --pmc-db', () => {
      const result = parseArgs(['--engram-db', '/path/to/engram.db']);
      assert.equal(result.pmcDbPath, null);
    });

    it('parses --window-minutes N', () => {
      const result = parseArgs(['--engram-db', 'a.db', '--pmc-db', 'b.db', '--window-minutes', '30']);
      assert.equal(result.windowMinutes, 30);
    });

    it('defaults windowMinutes to null (no filter)', () => {
      const result = parseArgs(['--engram-db', 'a.db', '--pmc-db', 'b.db']);
      assert.equal(result.windowMinutes, null);
    });

    it('parses --query custom queries', () => {
      const result = parseArgs(['--engram-db', 'a.db', '--pmc-db', 'b.db', '--query', 'auth,config,fix']);
      assert.deepEqual(result.queries, ['auth', 'config', 'fix']);
    });

    it('defaults queries to standard set', () => {
      const result = parseArgs(['--engram-db', 'a.db', '--pmc-db', 'b.db']);
      assert.deepEqual(result.queries, ['auth', 'config', 'fix', 'decision', 'error']);
    });
  });

  describe('buildUsageText', () => {
    it('returns a string containing the command name', () => {
      const text = buildUsageText();
      assert.ok(text.includes('compare-backends'));
    });

    it('mentions --engram-db and --pmc-db', () => {
      const text = buildUsageText();
      assert.ok(text.includes('--engram-db'));
      assert.ok(text.includes('--pmc-db'));
    });

    it('mentions --window-minutes', () => {
      const text = buildUsageText();
      assert.ok(text.includes('--window-minutes'));
    });
  });
});
