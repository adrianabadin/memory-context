import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderTemplate,
  hasBlockMarker,
  replaceOrAppendBlock,
  stripBlockMarkers,
  wrapBlock,
} from '../../src/templates/render.mjs';
import * as templateInstaller from '../../src/template-installer.mjs';

test('renderTemplate replaces {{placeholders}} in string', () => {
  const result = renderTemplate('Hello {{NAME}}, welcome to {{PROJECT}}!', {
    NAME: 'Alice',
    PROJECT: 'PMC',
  });
  assert.equal(result, 'Hello Alice, welcome to PMC!');
});

test('block-marker helpers manage HTML comment blocks', () => {
  const marker = 'autostart';
  const block = '## Block';

  assert.equal(hasBlockMarker('<!-- pmc:autostart -->', marker), true);
  assert.equal(hasBlockMarker('no marker', marker), false);

  const wrapped = wrapBlock(marker, block);
  assert.equal(wrapped, '<!-- pmc:autostart -->\n## Block\n<!-- /pmc:autostart -->\n');

  const stripped = stripBlockMarkers(wrapped, marker);
  assert.equal(stripped, '## Block');

  const appended = replaceOrAppendBlock('# Existing\n', marker, block);
  assert.ok(appended.includes('<!-- pmc:autostart -->\n## Block\n<!-- /pmc:autostart -->'));
});

test('template-installer re-exports all five render helpers for backward-compatibility', () => {
  assert.equal(typeof templateInstaller.renderTemplate, 'function');
  assert.equal(typeof templateInstaller.hasBlockMarker, 'function');
  assert.equal(typeof templateInstaller.replaceOrAppendBlock, 'function');
  assert.equal(typeof templateInstaller.stripBlockMarkers, 'function');
  assert.equal(typeof templateInstaller.wrapBlock, 'function');
});
