import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectPath } from '../src/platform.mjs';

test('normalizeProjectPath: converts backslashes, preserves spaces', () => {
  assert.equal(
    normalizeProjectPath('C:\\Users\\nombre apellido\\proyecto'),
    'C:/Users/nombre apellido/proyecto'
  );
});

test('normalizeProjectPath: POSIX path unchanged', () => {
  assert.equal(
    normalizeProjectPath('/home/user/my project'),
    '/home/user/my project'
  );
});

test('normalizeProjectPath: mixed separators', () => {
  assert.equal(
    normalizeProjectPath('C:\\code/ia\\memory context'),
    'C:/code/ia/memory context'
  );
});

test('normalizeProjectPath: handles empty string', () => {
  assert.equal(normalizeProjectPath(''), '');
});

test('normalizeProjectPath: path without spaces unchanged except separators', () => {
  assert.equal(
    normalizeProjectPath('C:\\Users\\user\\repos\\project'),
    'C:/Users/user/repos/project'
  );
});
