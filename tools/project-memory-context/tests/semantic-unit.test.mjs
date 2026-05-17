import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticUnit } from '../src/semantic-unit.mjs';

test('buildSemanticUnit extracts import context and exact TypeScript symbol fragment', () => {
  const content = [
    "import { api } from './api';",
    "import { normalizeUser } from './normalize';",
    '',
    'const ignored = true;',
    '',
    'export async function getUser(id, includePosts) {',
    '  const result = await api.get(id);',
    '  return normalizeUser(result, includePosts);',
    '}',
  ].join('\n');

  const unit = buildSemanticUnit({
    symbol: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|2',
      language: 'ts',
      filePath: 'src/user.ts',
      kind: 'function',
      name: 'getUser',
      range: { startLine: 6, endLine: 9 },
    },
    content,
  });

  assert.match(unit.context, /import \{ api \}/);
  assert.match(unit.context, /import \{ normalizeUser \}/);
  assert.equal(unit.code, [
    'export async function getUser(id, includePosts) {',
    '  const result = await api.get(id);',
    '  return normalizeUser(result, includePosts);',
    '}',
  ].join('\n'));
});

test('buildSemanticUnit extracts using context for csharp symbols', () => {
  const content = [
    'using System.Threading;',
    'using MyApp.Domain;',
    '',
    'namespace MyApp.Services;',
    '',
    'public class UserService {',
    '  public Task<User> GetUserAsync(Guid id, CancellationToken token) {',
    '    return Task.FromResult(new User(id));',
    '  }',
    '}',
  ].join('\n');

  const unit = buildSemanticUnit({
    symbol: {
      symbolKey: 'csharp|Services/UserService.cs|MyApp.Services|UserService|method|GetUserAsync|(Guid,CancellationToken)',
      language: 'csharp',
      filePath: 'Services/UserService.cs',
      kind: 'method',
      name: 'GetUserAsync',
      range: { startLine: 7, endLine: 9 },
    },
    content,
  });

  assert.match(unit.context, /using System.Threading;/);
  assert.match(unit.context, /using MyApp.Domain;/);
  assert.match(unit.context, /namespace MyApp.Services;/);
  assert.equal(unit.code, [
    '  public Task<User> GetUserAsync(Guid id, CancellationToken token) {',
    '    return Task.FromResult(new User(id));',
    '  }',
  ].join('\n'));
});
