# PMC Global CLI Design

**Goal:** Make PMC run exclusively through the published `pmc` executable, align command templates with explicit `pmc <subcommand>` invocations, and remove copying PMC source code into consumer projects.

## Problem

PMC currently mixes two execution models:

- global/package execution through `pmc`
- copied local source execution through `node tools/project-memory-context/cli/...`

This creates three structural problems:

1. Command templates and real CLI names are not fully aligned.
2. Consumer projects receive a copied `tools/project-memory-context/` source tree that should not be part of the runtime model.
3. Some bootstrap and install flows still assume local script paths instead of the package CLI.

The target model is simpler:

- consumer projects keep only PMC state and agent configuration
- all executable PMC behavior lives in the npm package
- every framework command exposed through Markdown templates runs via `pmc`

## Scope

This change covers:

- `tools/project-memory-context/templates/opencode/commands/*.md`
- `tools/project-memory-context/src/command-dispatch.mjs`
- install/bootstrap flows that currently copy or reference PMC source files in the consumer project
- tests that validate CLI dispatch, install behavior, and command template behavior

This change does not require redesigning the internal implementations of the existing CLI modules such as `context.mjs`, `sync.mjs`, or `status.mjs`. Those can continue to exist behind the new public command names.

## Public CLI Contract

PMC will expose these agent-facing command names that match the installed command Markdown files:

- `pmc get-context <target> [depth] [focus]`
- `pmc sync-context`
- `pmc sanitize`
- `pmc map-project [--all] [--enrich]`
- `pmc init-project`
- `pmc doctor`
- `pmc enrich-status`
- `pmc retry-errors [options]`
- `pmc view-context`

PMC may continue to expose package-level operational subcommands that are not installed as agent command Markdown files, as long as they are not legacy names for the agent-facing workflow. This includes commands such as `pmc enrich`, `pmc project-context`, `pmc query`, `pmc install-pmc`, or `pmc setup` if they are still needed internally or operationally.

The old agent-facing names will be removed from the dispatcher:

- `context`
- `sync`
- `status`
- `bootstrap`
- `init`
- `new-project`

If a user invokes an old name, the dispatcher should reject it as invalid rather than silently mapping it.

## Internal Command Mapping

To minimize implementation churn, the new public names will delegate to the existing internal entrypoints:

- `get-context` -> `cli/context.mjs`
- `sync-context` -> `cli/sync.mjs`
- `sanitize` -> `cli/sanitize.mjs`
- `map-project` -> `cli/bootstrap.mjs`
- `init-project` -> `cli/init.mjs`
- `doctor` -> `cli/doctor.mjs`
- `enrich-status` -> `cli/status.mjs`
- `retry-errors` -> `cli/retry-errors.mjs`
- `view-context` -> `bin/pmc-view-context.mjs`

This preserves the existing implementation files while making the external contract consistent.

## Consumer Project Model

After this change, a consumer project should contain:

- `.planning/project-memory-context/**`
- `.planning/project-memory-context/install.json`
- agent configuration such as `.mcp.json`, `.claude/*`, `.cursor/*`, or `.opencode/opencode.json`
- installed command markdown files for the target agent experience

A consumer project should no longer receive a copied PMC code tree such as:

- `tools/project-memory-context/cli/**`
- `tools/project-memory-context/src/**`
- `tools/project-memory-context/mcp/**`
- `tools/project-memory-context/plugin/**`
- `tools/project-memory-context/package.json`

PMC becomes a package runtime, not a vendored toolchain.

## Installation Design

`cli/install-pmc.mjs` will stop copying PMC source into the target project.

New responsibilities of `install-pmc`:

- create `.planning/project-memory-context/` directory structure
- write `.planning/project-memory-context/install.json`
- preserve install metadata needed by PMC runtime and agent integrations
- install or update the agent-facing command templates/configuration that instruct the agent to use `pmc`

Removed responsibilities:

- copying `cli/`
- copying `src/`
- copying `mcp/`
- copying `plugin/`
- copying package-local templates as a code artifact into `tools/project-memory-context/`
- copying package `package.json` into the target project

The install metadata should continue to describe the consumer project root and PMC data locations. It should not imply that PMC source code exists inside the project.

## Bootstrap Design

`cli/bootstrap.mjs` will stop syncing PMC tools to the target repository.

Required changes:

- remove the `installPmcTools()` sync step from bootstrap
- remove status/help text that tells the user to run `node tools/project-memory-context/cli/...`
- update follow-up instructions to use only `pmc ...`
- when bootstrap starts background enrichment, it must do so through the package runtime path rather than assuming the script exists under the consumer project's `tools/` directory

Because bootstrap itself is already running inside the package, it can launch the package entrypoint directly by module path resolution from the package root. The consumer project remains only the working directory and data location.

## Command Template Design

All files under `tools/project-memory-context/templates/opencode/commands/` must explicitly show the correct `pmc` command.

Required command mappings:

- `get-context.md` -> `pmc get-context <target> [depth] [focus]`
- `sync-context.md` -> `pmc sync-context`
- `sanitize.md` -> `pmc sanitize`
- `map-project.md` -> `pmc map-project --all --enrich`
- `init-project.md` -> `pmc init-project`
- `doctor.md` -> `pmc doctor`
- `enrich-status.md` -> `pmc enrich-status`
- `retry-errors.md` -> `pmc retry-errors --timeout 300000`
- `view-context.md` -> `pmc view-context`

The templates should not instruct the agent to manually replay `agent-memory_store`/`agent-memory_update` for sync if the framework already has a first-class `pmc sync-context` command. The public framework command should be the documented execution path.

All public template commands are current-project commands. They run from the consumer project root and should rely on `process.cwd()` rather than requiring an explicit `.` positional argument in the user-facing template.

## Data Flow

### Install flow

1. User or agent runs `pmc map-project` or `pmc init-project`.
2. PMC initializes `.planning/project-memory-context/**` and config artifacts in the consumer project.
3. The consumer project stores only data/config state.
4. Subsequent PMC actions run from the package executable against that project state.

### Runtime flow

1. Agent command Markdown invokes `pmc <public-command>`.
2. `bin/pmc.mjs` dispatches through `src/command-dispatch.mjs`.
3. Dispatcher resolves the internal module in the installed package.
4. Internal module reads/writes `.planning/project-memory-context/**` in the current target project.
5. No PMC source files are expected inside the consumer project.

## Error Handling

- Old command names must fail fast with a clear `Invalid command` response.
- Install/bootstrap must not leave user-facing instructions that reference nonexistent `tools/project-memory-context/...` paths.
- Any command that requires a PMC-enabled project should continue to validate `.planning/project-memory-context/` presence and fail with a clear message.
- `view-context` must keep resolving assets from the installed package, not from the consumer repo.

## Testing Strategy

### Dispatcher tests

- verify all new public command names resolve successfully
- verify removed names (`context`, `sync`, `status`, `bootstrap`, `init`) are rejected
- verify help output lists only the new public names

### Install tests

- verify `.planning/project-memory-context/**` and `install.json` are created
- verify no `tools/project-memory-context/**` tree is copied into the consumer project
- verify any retained install metadata remains valid without local copied source

### Bootstrap tests

- verify bootstrap no longer calls the local sync-to-target step
- verify user-facing messages reference `pmc ...` only
- verify background enrichment launch does not depend on `target/tools/project-memory-context/cli/enrich-queue.mjs`

### Template tests

- verify each command markdown file references the correct `pmc` subcommand
- verify `sync-context.md` documents the framework command instead of an ad hoc MCP replay flow

## Migration Outcome

After the change:

- the official PMC interface is `pmc`
- command markdown names and CLI names are aligned one-to-one
- consumer projects no longer vendor PMC runtime source
- framework behavior runs from the global/package repository installation

## Out Of Scope

- automatic migration tooling for already-copied legacy `tools/project-memory-context/` directories
- backward-compatibility shims for old command names
- redesign of the underlying query, sync, sanitize, or enrichment logic beyond what is needed to run from the package runtime
