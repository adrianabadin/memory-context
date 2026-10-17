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

test('buildSymbolKey canonicalizes a D2 class member key (container + member scope)', () => {
  const key = buildSymbolKey({
    language: 'ts',
    filePath: 'src/services/user.service.ts',
    kind: 'method',
    exportScope: 'local',
    container: 'UserService',
    name: 'findById',
    arity: 1,
  });

  assert.equal(key, 'ts|src/services/user.service.ts|method|member|UserService.findById|1');
});

test('member scope slot is forced to member regardless of the record exportScope', () => {
  const key = buildSymbolKey({
    language: 'js',
    filePath: 'src/a.js',
    kind: 'method',
    exportScope: 'exported',
    container: 'A',
    name: 'run',
    arity: 0,
  });

  assert.equal(key, 'js|src/a.js|method|member|A.run|0');
});

test('legacy method without a container keeps the exact legacy key bytes', () => {
  const jsKey = buildSymbolKey({
    language: 'js',
    filePath: 'src/a.js',
    kind: 'method',
    exportScope: 'exported',
    name: 'compute',
    arity: 2,
  });
  assert.equal(jsKey, 'js|src/a.js|method|exported|compute|2');

  const phpKey = buildSymbolKey({
    language: 'php',
    filePath: 'lib/Foo.php',
    kind: 'method',
    exportScope: 'exported',
    name: 'handle',
    arity: 1,
  });
  assert.equal(phpKey, 'php|lib/Foo.php|method|exported|handle|1');
});

test('C# method without containerName keeps the legacy none-container slot', () => {
  const key = buildSymbolKey({
    language: 'csharp',
    filePath: 'Services/Foo.cs',
    namespace: 'MyApp.Services',
    kind: 'method',
    name: 'Bar',
    signature: '()',
  });

  assert.equal(key, 'csharp|Services/Foo.cs|MyApp.Services|none|method|Bar|()');
});

test('buildSymbolKey never mutates its input record', () => {
  const symbol = Object.freeze({
    language: 'ts',
    filePath: 'src/services/user.service.ts',
    kind: 'method',
    exportScope: 'local',
    container: 'UserService',
    name: 'findById',
    arity: 1,
  });
  const before = { ...symbol };

  buildSymbolKey(symbol);

  assert.deepEqual(symbol, before);
  assert.equal(symbol.name, 'findById', 'the record name must stay unqualified');
  assert.equal(symbol.exportScope, 'local', 'the record exportScope must not be rewritten');
});
