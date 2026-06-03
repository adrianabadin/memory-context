# PMC Global CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PMC run from the package-level `pmc` executable only, align all installed command templates with `pmc <subcommand>`, and stop copying `tools/project-memory-context/**` into consumer projects.

**Architecture:** Keep the existing implementation modules (`cli/context.mjs`, `cli/status.mjs`, `cli/bootstrap.mjs`, `cli/init.mjs`, `cli/sync.mjs`) but remap the public dispatcher surface to the new agent-facing names (`get-context`, `enrich-status`, `map-project`, `init-project`, `sync-context`). Consumer repositories retain only `.planning/project-memory-context/**` and agent config; bootstrap and install flows stop vendoring PMC runtime code into the target repo and instead launch package-local modules against the target project as data.

**Tech Stack:** Node.js ESM, npm package `bin`, filesystem-based template installation, Node built-in test runner (`node --test`), Markdown command templates.

---

### Task 1: Replace The Public CLI Surface In The Dispatcher

**Files:**
- Modify: `tools/project-memory-context/src/command-dispatch.mjs`
- Modify: `tools/project-memory-context/cli/context.mjs`
- Modify: `tools/project-memory-context/cli/status.mjs`
- Modify: `tools/project-memory-context/cli/init.mjs`
- Modify: `tools/project-memory-context/cli/bootstrap.mjs`
- Modify: `tools/project-memory-context/cli/new-project.mjs`
- Test: `tools/project-memory-context/tests/command-dispatch.test.mjs`

- [ ] **Step 1: Write the failing dispatcher contract test**

Add explicit coverage for the new public names and the removed legacy aliases in `tools/project-memory-context/tests/command-dispatch.test.mjs`:

```javascript
test('resolveCommand maps the new agent-facing names', () => {
  const expected = new Map([
    ['map-project', resolve(PACKAGE_ROOT, 'cli', 'bootstrap.mjs')],
    ['get-context', resolve(PACKAGE_ROOT, 'cli', 'context.mjs')],
    ['enrich-status', resolve(PACKAGE_ROOT, 'cli', 'status.mjs')],
    ['init-project', resolve(PACKAGE_ROOT, 'cli', 'init.mjs')],
    ['sync-context', resolve(PACKAGE_ROOT, 'cli', 'sync.mjs')],
    ['sanitize', resolve(PACKAGE_ROOT, 'cli', 'sanitize.mjs')],
    ['doctor', resolve(PACKAGE_ROOT, 'cli', 'doctor.mjs')],
    ['retry-errors', resolve(PACKAGE_ROOT, 'cli', 'retry-errors.mjs')],
    ['view-context', resolve(PACKAGE_ROOT, 'bin', 'pmc-view-context.mjs')],
  ]);

  for (const [name, modulePath] of expected) {
    const command = resolveCommand([name]);
    assert.equal(command.name, name);
    assert.equal(command.modulePath, modulePath);
    assert.equal(command.valid, true);
  }
});

test('resolveCommand rejects removed legacy aliases', () => {
  for (const name of ['bootstrap', 'context', 'status', 'sync', 'init', 'new-project']) {
    const command = resolveCommand([name]);
    assert.equal(command.valid, false, `expected ${name} to be rejected`);
    assert.equal(command.modulePath, null);
  }
});
```

- [ ] **Step 2: Run the dispatcher test and confirm the failure is about the old command table**

Run: `node --test tools/project-memory-context/tests/command-dispatch.test.mjs`

Expected: FAIL because `resolveCommand()` still maps `bootstrap/context/status/sync/init/new-project` and does not know `map-project/get-context/enrich-status/init-project/sync-context`.

- [ ] **Step 3: Replace the public command map in `src/command-dispatch.mjs`**

Update the dispatcher so the public command table matches the new contract while preserving auxiliary package commands like `enrich`, `project-context`, `query`, `install-pmc`, and `setup`:

```javascript
const COMMANDS = new Map([
  ['doctor', 'cli/doctor.mjs'],
  ['enrich', 'cli/enrich.mjs'],
  ['enrich-status', 'cli/status.mjs'],
  ['get-context', 'cli/context.mjs'],
  ['help', null],
  ['init-project', 'cli/init.mjs'],
  ['install-pmc', 'cli/install-pmc.mjs'],
  ['map-project', 'cli/bootstrap.mjs'],
  ['project-context', 'cli/project-context.mjs'],
  ['query', 'cli/query.mjs'],
  ['retry-errors', 'cli/retry-errors.mjs'],
  ['sanitize', 'cli/sanitize.mjs'],
  ['setup', 'cli/setup.mjs'],
  ['sync-context', 'cli/sync.mjs'],
  ['view-context', 'bin/pmc-view-context.mjs'],
]);
```

- [ ] **Step 4: Update help text in the delegated CLIs to advertise the new public names**

Adjust the user-facing usage strings so the public help surface matches the dispatcher:

```javascript
// tools/project-memory-context/cli/context.mjs
console.log('Usage: pmc get-context [options] [<target>]');
console.log('       pmc get-context {symbol|file|query} <target> [depth] [focus]');
console.log('  pmc get-context createQueryEngine');
console.log('  pmc get-context symbol MyFunc extended dependencies');
console.log('  pmc get-context --refresh');

// tools/project-memory-context/cli/status.mjs
console.log('Usage: pmc enrich-status [project-dir]');

// tools/project-memory-context/cli/init.mjs
console.log('Usage: pmc init-project [--agent opencode|claude-code|cursor|generic]');

// tools/project-memory-context/cli/bootstrap.mjs
console.log('Usage: pmc map-project [target-repo] [--stage-a] [--stage-b] [--all] [--enrich]');

// tools/project-memory-context/cli/new-project.mjs
console.log('This legacy wrapper is no longer dispatched by `pmc`; use `pmc map-project`.');
```

- [ ] **Step 5: Re-run the dispatcher test and keep a commit command ready only if requested**

Run: `node --test tools/project-memory-context/tests/command-dispatch.test.mjs`

Expected: PASS, with help output listing `map-project`, `get-context`, `enrich-status`, `init-project`, and `sync-context`, and invalid-command coverage rejecting the legacy aliases.

If a commit is explicitly requested later, use:

```bash
git add tools/project-memory-context/src/command-dispatch.mjs tools/project-memory-context/cli/context.mjs tools/project-memory-context/cli/status.mjs tools/project-memory-context/cli/init.mjs tools/project-memory-context/cli/bootstrap.mjs tools/project-memory-context/cli/new-project.mjs tools/project-memory-context/tests/command-dispatch.test.mjs
git commit -m "feat(pmc): rename public cli commands"
```

### Task 2: Align Source Templates And Installed Agent Snippets With `pmc`

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/commands/get-context.md`
- Modify: `tools/project-memory-context/templates/opencode/commands/sync-context.md`
- Modify: `tools/project-memory-context/templates/opencode/commands/sanitize.md`
- Modify: `tools/project-memory-context/templates/opencode/commands/map-project.md`
- Modify: `tools/project-memory-context/templates/opencode/commands/init-project.md`
- Modify: `tools/project-memory-context/templates/opencode/commands/enrich-status.md`
- Modify: `tools/project-memory-context/templates/opencode/commands/retry-errors.md`
- Modify: `tools/project-memory-context/templates/opencode/commands/view-context.md`
- Modify: `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet`
- Modify: `tools/project-memory-context/templates/cursor/.cursorrules.snippet`
- Modify: `tools/project-memory-context/templates/generic/README-SETUP.md`
- Modify: `tools/project-memory-context/templates/opencode/autostart-snippet.md`
- Test: `tools/project-memory-context/tests/init.test.mjs`
- Create: `tools/project-memory-context/tests/template-command-contract.test.mjs`

- [ ] **Step 1: Add a failing contract test for the source templates**

Create `tools/project-memory-context/tests/template-command-contract.test.mjs` so the package templates themselves are checked, not only installed copies:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readTemplate(relativePath) {
  return readFileSync(join(packageRoot, 'templates', relativePath), 'utf8');
}

test('opencode commands use the new pmc subcommands', () => {
  assert.match(readTemplate('opencode/commands/map-project.md'), /\{\{PMC_BIN\}\} map-project --all --enrich/);
  assert.match(readTemplate('opencode/commands/get-context.md'), /\{\{PMC_BIN\}\} get-context <target>/);
  assert.match(readTemplate('opencode/commands/enrich-status.md'), /\{\{PMC_BIN\}\} enrich-status/);
  assert.match(readTemplate('opencode/commands/init-project.md'), /\{\{PMC_BIN\}\} init-project/);
  assert.match(readTemplate('opencode/commands/sync-context.md'), /\{\{PMC_BIN\}\} sync-context/);
});

test('agent snippets do not reference copied local CLI paths', () => {
  const claude = readTemplate('claude-code/CLAUDE.md.snippet');
  const cursor = readTemplate('cursor/.cursorrules.snippet');
  assert.doesNotMatch(claude, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
  assert.doesNotMatch(cursor, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
  assert.match(claude, /\{\{PMC_BIN\}\} enrich \./);
  assert.match(cursor, /\{\{PMC_BIN\}\} enrich \./);
});
```

- [ ] **Step 2: Extend the installed-template test to fail on the old command names**

In `tools/project-memory-context/tests/init.test.mjs`, replace the legacy expectations with the new contract:

```javascript
assert.match(claudeMd, /pmc map-project --all --enrich/);
assert.match(claudeMd, /pmc get-context <target>/);
assert.match(claudeMd, /pmc enrich-status/);
assert.match(claudeMd, /pmc init-project/);
assert.match(claudeMd, /pmc sync-context/);
assert.doesNotMatch(claudeMd, /pmc bootstrap/);
assert.doesNotMatch(claudeMd, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
```

Do the same for Cursor and Generic README expectations.

- [ ] **Step 3: Run the template tests and confirm the failures point at the old command text**

Run: `node --test tools/project-memory-context/tests/init.test.mjs tools/project-memory-context/tests/template-command-contract.test.mjs`

Expected: FAIL because the templates still contain `pmc bootstrap`, `pmc context`, `pmc status`, `pmc init`, a manual sync description, and local `tools/project-memory-context/cli/enrich-queue.mjs` paths.

- [ ] **Step 4: Rewrite the source templates and snippets to the new command surface**

Update the command markdown files and agent snippets so they consistently invoke the new subcommands and use package-level `pmc enrich .` in autostart:

```text
tools/project-memory-context/templates/opencode/commands/map-project.md
  {{PMC_BIN}} map-project --all --enrich

tools/project-memory-context/templates/opencode/commands/get-context.md
  {{PMC_BIN}} get-context <target> [depth] [focus]
  {{PMC_BIN}} get-context symbol <target> [depth] [focus]
  {{PMC_BIN}} get-context file <target> [depth] [focus]
  {{PMC_BIN}} get-context query <target> [depth] [focus]
  {{PMC_BIN}} get-context --refresh

tools/project-memory-context/templates/opencode/commands/sync-context.md
  {{PMC_BIN}} sync-context

tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet
  When the user types `/map-project`, run: {{PMC_BIN}} map-project --all --enrich
  When the user types `/get-context`, run: {{PMC_BIN}} get-context <target> [depth] [focus]
  When the user types `/enrich-status`, run: {{PMC_BIN}} enrich-status
  When the user types `/sync-context`, run: {{PMC_BIN}} sync-context
  When starting a session in a project with `.planning/project-memory-context/`: {{PMC_BIN}} enrich .
```

Also rewrite `generic/README-SETUP.md` to use `map-project`, `enrich-status`, `get-context --refresh`, `sanitize`, and `sync-context` instead of the legacy names.

- [ ] **Step 5: Re-run the template tests and keep a commit command ready only if requested**

Run: `node --test tools/project-memory-context/tests/init.test.mjs tools/project-memory-context/tests/template-command-contract.test.mjs`

Expected: PASS, proving both the source templates and the installed outputs use `pmc` consistently and contain no copied-local-script references.

If a commit is explicitly requested later, use:

```bash
git add tools/project-memory-context/templates/opencode/commands/get-context.md tools/project-memory-context/templates/opencode/commands/sync-context.md tools/project-memory-context/templates/opencode/commands/sanitize.md tools/project-memory-context/templates/opencode/commands/map-project.md tools/project-memory-context/templates/opencode/commands/init-project.md tools/project-memory-context/templates/opencode/commands/enrich-status.md tools/project-memory-context/templates/opencode/commands/retry-errors.md tools/project-memory-context/templates/opencode/commands/view-context.md tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet tools/project-memory-context/templates/cursor/.cursorrules.snippet tools/project-memory-context/templates/generic/README-SETUP.md tools/project-memory-context/templates/opencode/autostart-snippet.md tools/project-memory-context/tests/init.test.mjs tools/project-memory-context/tests/template-command-contract.test.mjs
git commit -m "feat(pmc): align templates with global cli"
```

### Task 3: Stop Copying PMC Runtime Code During `install-pmc`

**Files:**
- Modify: `tools/project-memory-context/cli/install-pmc.mjs`
- Test: `tools/project-memory-context/tests/install-pmc.test.mjs`

- [ ] **Step 1: Rewrite the install test to fail if runtime code is copied**

Replace the current copied-tree assertions in `tools/project-memory-context/tests/install-pmc.test.mjs` with negative assertions:

```javascript
assert.equal(existsSync(join(targetDir, 'tools', 'project-memory-context')), false);
assert.equal(existsSync(join(targetDir, 'tools', 'project-memory-context', 'cli', 'enrich-queue.mjs')), false);
assert.equal(existsSync(join(targetDir, 'tools', 'project-memory-context', 'src', 'enrichment-driver.mjs')), false);

assert.ok(existsSync(join(targetDir, '.planning', 'project-memory-context', 'enrichment')));
assert.ok(existsSync(join(targetDir, '.planning', 'project-memory-context', 'graph')));

const state = JSON.parse(readFileSync(join(targetDir, '.planning', 'project-memory-context', 'install.json'), 'utf8'));
assert.equal(state.projectRoot, targetDir);
assert.equal(state.memoryDbPath, join(targetDir, '.planning', 'project-memory-context', 'memory-db'));
```

- [ ] **Step 2: Run the install test and confirm the failure is caused by copied `tools/project-memory-context/**`**

Run: `node --test tools/project-memory-context/tests/install-pmc.test.mjs`

Expected: FAIL because `installPmcTools()` still creates `tools/project-memory-context/cli`, `src`, `mcp`, `plugin`, and `package.json` inside the target project.

- [ ] **Step 3: Replace the copy implementation in `cli/install-pmc.mjs` with a planning-state installer**

Remove the tree-copy helpers and keep only the planning/install-state work:

```javascript
export function installPmcTools({ sourceRoot, targetRoot }) {
  const planningBase = resolve(targetRoot, '.planning', 'project-memory-context');
  const memoryDbPath = resolve(planningBase, 'memory-db');

  for (const sub of ['intake', 'graph', 'enrichment', 'memory-db', 'db']) {
    mkdirSync(resolve(planningBase, sub), { recursive: true });
  }

  const installState = {
    installedAt: new Date().toISOString(),
    memoryDbPath,
    projectRoot: resolve(targetRoot),
    sourceRoot: resolve(sourceRoot),
    version: '0.1.0',
  };

  writeFileSync(resolve(planningBase, 'install.json'), `${JSON.stringify(installState, null, 2)}\n`, 'utf8');

  return { cliFiles: 0, srcFiles: 0, templateFiles: 0 };
}
```

Also update the CLI help banner from “Copy PMC tools into a target project” to “Initialize PMC project state in a target project”.

- [ ] **Step 4: Keep the return contract stable while removing the old copied-tree assumptions**

Preserve the exported function name and return shape so the rest of the package keeps working, but update the test expectations accordingly:

```javascript
const result = installPmcTools({ sourceRoot, targetRoot: targetDir });
assert.equal(result.cliFiles, 0);
assert.equal(result.srcFiles, 0);
assert.equal(result.templateFiles, 0);
```

- [ ] **Step 5: Re-run the install test and keep a commit command ready only if requested**

Run: `node --test tools/project-memory-context/tests/install-pmc.test.mjs`

Expected: PASS, confirming install state is created without vendoring PMC runtime code into the consumer project.

If a commit is explicitly requested later, use:

```bash
git add tools/project-memory-context/cli/install-pmc.mjs tools/project-memory-context/tests/install-pmc.test.mjs
git commit -m "refactor(pmc): stop copying runtime into projects"
```

### Task 4: Remove Bootstrap Sync-To-Target And Launch Enrichment From The Package Runtime

**Files:**
- Modify: `tools/project-memory-context/cli/bootstrap.mjs`
- Modify: `tools/project-memory-context/cli/enrich-sync.mjs`
- Modify: `tools/project-memory-context/cli/enrich-orchestrator.mjs`
- Modify: `tools/project-memory-context/cli/batch-enrich.mjs`
- Modify: `tools/project-memory-context/cli/enrich-batch.mjs`
- Test: `tools/project-memory-context/tests/setup-bootstrap.test.mjs`

- [ ] **Step 1: Rewrite the bootstrap tests so they fail on copied runtime files**

Change the package-install and standalone bootstrap assertions in `tools/project-memory-context/tests/setup-bootstrap.test.mjs` from positive copied-file checks to negative checks:

```javascript
assert.equal(existsSync(join(root, 'tools', 'project-memory-context', 'cli', 'enrich-queue.mjs')), false);
assert.equal(existsSync(join(root, 'tools', 'project-memory-context', 'src', 'providers', 'local-model-provider.mjs')), false);
assert.equal(existsSync(join(root, 'tools', 'project-memory-context', 'src', 'providers', 'cloud-api-provider.mjs')), false);
```

Add one output assertion for the new follow-up text:

```javascript
const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
assert.match(combined, /pmc enrich \./);
assert.doesNotMatch(combined, /node tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
```

- [ ] **Step 2: Run the bootstrap tests and confirm the failure is about sync-to-target and old messaging**

Run: `node --test tools/project-memory-context/tests/setup-bootstrap.test.mjs`

Expected: FAIL because `bootstrap.mjs` still calls `installPmcTools()`, copied runtime files still appear in the target repo, and the fallback instructions still print `node tools/project-memory-context/cli/enrich-queue.mjs`.

- [ ] **Step 3: Remove the sync-to-target step and launch enrichment from the package-local CLI path**

In `tools/project-memory-context/cli/bootstrap.mjs`, delete the `syncToolsToTarget()` call and use the package-local `enrich-queue.mjs` path when background enrichment is needed:

```javascript
// delete this block entirely
log('Syncing PMC tools to target repo...');
await syncToolsToTarget(targetDir);

// replace the enrichment launch
const enrichScript = resolve(PMC_CLI_ROOT, 'enrich-queue.mjs');
spawnBackground(process.execPath, [enrichScript, targetDir], { cwd: targetDir });

// replace the fallback message
log('Run enrichment with:');
log(`  pmc enrich ${targetDir === process.cwd() ? '.' : targetDir}`);
```

- [ ] **Step 4: Update legacy wrapper/deprecation messages to point at `pmc enrich`**

Rewrite the legacy wrapper files so they no longer tell the user to run package-internal paths:

```javascript
// tools/project-memory-context/cli/enrich-sync.mjs
console.error('[enrich-sync] Deprecated. Run: pmc enrich .');

// tools/project-memory-context/cli/enrich-orchestrator.mjs
console.error('[enrich-orchestrator] Deprecated. Run: pmc enrich .');

// tools/project-memory-context/cli/batch-enrich.mjs
console.error('[batch-enrich] Deprecated. Run: pmc enrich .');

// tools/project-memory-context/cli/enrich-batch.mjs
console.error('[enrich-batch] Deprecated. Run: pmc enrich .');
```

- [ ] **Step 5: Re-run the bootstrap test suite and keep a commit command ready only if requested**

Run: `node --test tools/project-memory-context/tests/setup-bootstrap.test.mjs`

Expected: PASS, proving bootstrap creates planning/config state only, starts enrichment from the installed package runtime, and no longer prints `node tools/project-memory-context/cli/...` instructions.

If a commit is explicitly requested later, use:

```bash
git add tools/project-memory-context/cli/bootstrap.mjs tools/project-memory-context/cli/enrich-sync.mjs tools/project-memory-context/cli/enrich-orchestrator.mjs tools/project-memory-context/cli/batch-enrich.mjs tools/project-memory-context/cli/enrich-batch.mjs tools/project-memory-context/tests/setup-bootstrap.test.mjs
git commit -m "refactor(pmc): run bootstrap from package runtime"
```

### Task 5: Update Package Documentation To Match The New Command Contract

**Files:**
- Modify: `tools/project-memory-context/README.md`
- Test: `tools/project-memory-context/tests/template-command-contract.test.mjs`

- [ ] **Step 1: Extend the contract test to fail on README references to removed agent-facing names**

Add a README check to `tools/project-memory-context/tests/template-command-contract.test.mjs`:

```javascript
test('README advertises the new agent-facing subcommands', () => {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');
  assert.match(readme, /pmc map-project/);
  assert.match(readme, /pmc get-context/);
  assert.match(readme, /pmc enrich-status/);
  assert.match(readme, /pmc init-project/);
  assert.match(readme, /pmc sync-context/);
  assert.doesNotMatch(readme, /### `pmc bootstrap`/);
  assert.doesNotMatch(readme, /### `pmc context`/);
  assert.doesNotMatch(readme, /### `pmc status`/);
  assert.doesNotMatch(readme, /### `pmc init`/);
});
```

- [ ] **Step 2: Run the template contract test and confirm the failure points at the old README command names**

Run: `node --test tools/project-memory-context/tests/template-command-contract.test.mjs`

Expected: FAIL because `README.md` still contains `pmc bootstrap`, `pmc context`, `pmc status`, and `pmc init` sections.

- [ ] **Step 3: Rewrite the README command reference to the new public names**

Replace the user-facing command sections and examples with the new names while leaving auxiliary operational commands like `pmc enrich`, `pmc project-context`, and `pmc query` documented separately:

```text
### `pmc map-project`
pmc map-project [target-repo] [--all] [--stage-a] [--stage-b] [--enrich]

### `pmc get-context`
pmc get-context [target] [--refresh] [--depth compact|extended|deep|disk]

### `pmc enrich-status`
pmc enrich-status

### `pmc init-project`
pmc init-project [--agent opencode|claude-code|cursor|generic]

### `pmc sync-context`
pmc sync-context
```

- [ ] **Step 4: Re-run the README contract test and the installed-template test together**

Run: `node --test tools/project-memory-context/tests/template-command-contract.test.mjs tools/project-memory-context/tests/init.test.mjs`

Expected: PASS, confirming the published docs and the installed templates agree on the same public command contract.

- [ ] **Step 5: Keep a docs commit command ready only if requested**

If a commit is explicitly requested later, use:

```bash
git add tools/project-memory-context/README.md tools/project-memory-context/tests/template-command-contract.test.mjs
git commit -m "docs(pmc): document global cli workflow"
```

---

## Final Verification

- [ ] Run the focused suite:

```bash
node --test tools/project-memory-context/tests/command-dispatch.test.mjs tools/project-memory-context/tests/init.test.mjs tools/project-memory-context/tests/template-command-contract.test.mjs tools/project-memory-context/tests/install-pmc.test.mjs tools/project-memory-context/tests/setup-bootstrap.test.mjs
```

Expected: PASS.

- [ ] Run one direct CLI smoke check from the source repo:

```bash
node tools/project-memory-context/bin/pmc.mjs
node tools/project-memory-context/bin/pmc.mjs get-context --help
node tools/project-memory-context/bin/pmc.mjs enrich-status .
```

Expected:
- help output lists the new public names
- `get-context --help` prints `pmc get-context`
- `enrich-status .` returns JSON without throwing

- [ ] Optional manual install smoke check in a temp repo:

```bash
node tools/project-memory-context/cli/bootstrap.mjs C:\Users\aabad\AppData\Local\Temp\opencode\pmc-global-cli-smoke
```

Expected:
- `.planning/project-memory-context/**` exists
- `.mcp.json` and agent config files exist
- `tools/project-memory-context/**` does not exist in the target repo
