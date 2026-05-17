import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTopLevelSymbols } from '../src/symbol-extractor.mjs';

test('extractTopLevelSymbols finds exported TypeScript contracts and functions', () => {
  const code = `
export interface User {
  id: string;
}

export function getUser(id: string, includePosts: boolean) {
  return { id, includePosts };
}
`;

  const symbols = extractTopLevelSymbols({ filePath: 'src/user.ts', content: code });

  assert.deepEqual(
    symbols.map((symbol) => [symbol.kind, symbol.name, symbol.language]),
    [
      ['interface', 'User', 'ts'],
      ['function', 'getUser', 'ts'],
    ],
  );
});

test('extractTopLevelSymbols finds csharp public types and methods', () => {
  const code = `
namespace MyApp.Services;

public record User(Guid Id);

public class UserService {
  public Task<User> GetUserAsync(Guid id, CancellationToken token) {
    throw new NotImplementedException();
  }
}
`;

  const symbols = extractTopLevelSymbols({ filePath: 'Services/UserService.cs', content: code });

  assert.deepEqual(
    symbols.map((symbol) => [symbol.kind, symbol.name, symbol.language]),
    [
      ['record', 'User', 'csharp'],
      ['class', 'UserService', 'csharp'],
      ['method', 'GetUserAsync', 'csharp'],
    ],
  );
});
