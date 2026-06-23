// T-012 — Verify the generated `.opencode/plugins/pmc.mjs` template propagates
// `{ hooks }` returned by the real PMCPlugin. The template is a thin wrapper:
//   `return await mod.PMCPlugin(input);`
// so any object the plugin returns (including `{ hooks }`) reaches OpenCode's
// plugin runner unchanged. This test simulates install (render + write) and
// imports the rendered wrapper pointed at a stub module, confirming the hooks
// object survives the forwarding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { renderTemplate } from '../src/template-installer.mjs';

const TEMPLATE_PATH = join(
  process.cwd(),
  'tools',
  'project-memory-context',
  'templates',
  'opencode',
  'plugins',
  'pmc.mjs',
);

test('rendered pmc.mjs template forwards { hooks } from the plugin module', async () => {
  const root = join(tmpdir(), `pmc-tpl-prop-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, '.opencode', 'plugins'), { recursive: true });
  // Stub plugin module that the rendered wrapper will import.
  const stubPath = join(root, 'stub-plugin.mjs');
  const stubHooks = {
    'chat.message': () => {},
    'tool.execute.after': () => {},
  };
  writeFileSync(
    stubPath,
    `export const PMCPlugin = async (input) => ({ hooks: ${JSON.stringify({
      hasChat: true,
      hasTool: true,
    })} });\n`,
  );

  try {
    const raw = readFileSync(TEMPLATE_PATH, 'utf8');
    const rendered = renderTemplate(raw, {
      PMC_PLUGIN_IMPORT: pathToFileURL(stubPath).href,
    });
    assert.doesNotMatch(rendered, /\{\{PMC_PLUGIN_IMPORT\}\}/, 'placeholder must be substituted');

    const wrapperPath = join(root, '.opencode', 'plugins', 'pmc.mjs');
    writeFileSync(wrapperPath, rendered);

    const mod = await import(pathToFileURL(wrapperPath).href);
    const result = await mod.PMCPlugin({ projectRoot: root });
    assert.ok(result && result.hooks, 'wrapper must forward the hooks object');
    assert.equal(result.hooks.hasChat, true);
    assert.equal(result.hooks.hasTool, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rendered pmc.mjs template still returns {} on import failure (never breaks startup)', async () => {
  const root = join(tmpdir(), `pmc-tpl-fail-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, '.opencode', 'plugins'), { recursive: true });
  try {
    const raw = readFileSync(TEMPLATE_PATH, 'utf8');
    const rendered = renderTemplate(raw, {
      // Point at a non-existent module to trigger the catch branch.
      PMC_PLUGIN_IMPORT: pathToFileURL(join(root, 'does-not-exist.mjs')).href,
    });
    const wrapperPath = join(root, '.opencode', 'plugins', 'pmc.mjs');
    writeFileSync(wrapperPath, rendered);

    const mod = await import(pathToFileURL(wrapperPath).href);
    const result = await mod.PMCPlugin({});
    assert.deepEqual(result, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
