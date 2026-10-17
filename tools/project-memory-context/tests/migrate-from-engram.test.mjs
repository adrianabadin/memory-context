// tests/migrate-from-engram.test.mjs
//
// T-009: migrate-from-engram CLI — PMC-style smoke tests
// Uses node:test runner.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildUsageText } from '../cli/migrate-from-engram.mjs';

describe('migrate-from-engram CLI', () => {
  describe('parseArgs', () => {
    it('parses engram-db-path as first positional arg', () => {
      const result = parseArgs(['/path/to/engram.db']);
      assert.equal(result.engramDbPath, '/path/to/engram.db');
    });

    it('recognizes --dry-run flag', () => {
      const result = parseArgs(['/path/to/engram.db', '--dry-run']);
      assert.equal(result.dryRun, true);
    });

    it('parses --limit N', () => {
      const result = parseArgs(['/path/to/engram.db', '--limit', '50']);
      assert.equal(result.limit, 50);
    });

    it('parses --batch-size N', () => {
      const result = parseArgs(['/path/to/engram.db', '--batch-size', '25']);
      assert.equal(result.batchSize, 25);
    });

    it('returns null engramDbPath when no positional arg', () => {
      const result = parseArgs(['--dry-run']);
      assert.equal(result.engramDbPath, null);
    });

    it('defaults dryRun to false', () => {
      const result = parseArgs(['/path/to/engram.db']);
      assert.equal(result.dryRun, false);
    });

    it('defaults limit to Infinity', () => {
      const result = parseArgs(['/path/to/engram.db']);
      assert.equal(result.limit, Infinity);
    });

    it('defaults batch-size to 50', () => {
      const result = parseArgs(['/path/to/engram.db']);
      assert.equal(result.batchSize, 50);
    });
  });

  describe('buildUsageText', () => {
    it('returns a string containing the command name', () => {
      const text = buildUsageText();
      assert.ok(text.includes('migrate-from-engram'));
    });

    it('mentions --dry-run', () => {
      const text = buildUsageText();
      assert.ok(text.includes('--dry-run'));
    });

    it('mentions --limit', () => {
      const text = buildUsageText();
      assert.ok(text.includes('--limit'));
    });
  });
});
