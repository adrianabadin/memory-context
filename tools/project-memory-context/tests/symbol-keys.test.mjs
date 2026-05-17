import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSymbolKey } from '../src/symbol-keys.mjs';

test('buildSymbolKey creates stable TypeScript keys', () => {
  const key = buildSymbolKey({
    language: 'ts',
    filePath: 'src/services/user.ts',
    kind: 'function',
    exportScope: 'exported',
    name: 'getUser',
    arity: 2,
  });

  assert.equal(key, 'ts|src/services/user.ts|function|exported|getUser|2');
});

test('buildSymbolKey creates stable C# keys', () => {
  const key = buildSymbolKey({
    language: 'csharp',
    filePath: 'Services/UserService.cs',
    namespace: 'MyApp.Services',
    containerName: 'UserService',
    kind: 'method',
    name: 'GetUserAsync',
    signature: '(Guid,CancellationToken)',
  });

  assert.equal(
    key,
    'csharp|Services/UserService.cs|MyApp.Services|UserService|method|GetUserAsync|(Guid,CancellationToken)',
  );
});
