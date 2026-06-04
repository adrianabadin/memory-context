import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKnownIssuesMarkdown } from '../src/global-sync.mjs';

describe('parseKnownIssuesMarkdown', () => {
  it('returns empty array for empty summary', () => {
    const md = `# Known issues and fixes
**Kind:** known-issues-and-fixes
**Updated:** 2026-06-03T00:00:00.000Z

## Summary
0 known issues recorded.

## Body
- No known issues recorded.`;
    assert.deepEqual(parseKnownIssuesMarkdown(md), []);
  });

  it('extracts a single issue with message and fix', () => {
    const md = `# Known issues and fixes

## Body

### Issue: ENOENT when loading graph.json
**Root cause:** File is written relative to project root but resolved from CWD.
**Fix:** Use resolve(projectRoot, 'graph.json') instead of relative path.
**Files:** cli/context.mjs
**Tags:** file-system, path`;
    const result = parseKnownIssuesMarkdown(md);
    assert.equal(result.length, 1);
    assert.ok(result[0].message.includes('ENOENT'));
    assert.ok(result[0].fix.includes('resolve(projectRoot'));
    assert.ok(result[0].rootCause?.includes('relative to project root'));
    assert.deepEqual(result[0].files, ['cli/context.mjs']);
    assert.ok(result[0].tags.includes('file-system'));
  });

  it('extracts multiple issues', () => {
    const md = `# Known issues
## Body
### Issue: Error A
**Fix:** Fix A

### Issue: Error B
**Fix:** Fix B`;
    const result = parseKnownIssuesMarkdown(md);
    assert.equal(result.length, 2);
    assert.ok(result[0].message.includes('Error A'));
    assert.ok(result[1].message.includes('Error B'));
  });

  it('handles missing optional fields gracefully', () => {
    const md = `# Known issues
## Body
### Issue: Something broke
**Fix:** Do something`;
    const result = parseKnownIssuesMarkdown(md);
    assert.equal(result.length, 1);
    assert.equal(result[0].rootCause, null);
    assert.deepEqual(result[0].files, []);
    assert.deepEqual(result[0].tags, []);
  });
});
