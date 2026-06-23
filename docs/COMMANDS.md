# PMC Commands Reference

All commands are run via `pmc <command> [args]` (globally installed) or `node tools/project-memory-context/cli/<command>.mjs [args]` (source repo).

## Registered Commands

The `pmc` binary dispatches to these subcommands (defined in `src/command-dispatch.mjs`):

| Command | CLI File | Purpose | Example |
|---------|----------|---------|---------|
| `doctor` | `cli/doctor.mjs` | Runs health checks on the PMC environment (Node, Python, Ollama, agent-memory) | `pmc doctor .` |
| `enrich` | `cli/enrich.mjs` | Launches enrichment queue for pending/stale symbols | `pmc enrich .` |
| `enrich-status` | `cli/status.mjs` | Reports current enrichment status: counts of pending/enriched/error entries, queue state | `pmc enrich-status .` |
| `get-context` | `cli/context.mjs` | Retrieves structural context for a target (file or symbol) at configurable depth | `pmc get-context src/index.ts` |
| `help` | — | Shows usage text | `pmc help` |
| `init-project` | `cli/init.mjs` | Initializes PMC for an agent type (opencode, claude-code, cursor, generic) | `pmc init-project --agent opencode` |
| `install-pmc` | `cli/install-pmc.mjs` | Installs PMC tooling into a target project | `node install-pmc.mjs` |
| `map-project` | `cli/bootstrap.mjs` | Bootstraps a new project: sets up directories, enrichment config, graphify, and initial graph | `pmc map-project [target-repo]` |
| `project-context` | `cli/project-context.mjs` | Detects and materializes project-level context (stack, structure, architecture) into memories | `node project-context.mjs` |
| `query` | `cli/query.mjs` | Queries PMC project-context and symbol artifacts with a natural language question | `pmc query "how does auth work?"` |
| `refresh-context` | `cli/refresh-context.mjs` | Incrementally refreshes the knowledge graph by detecting changed files and updating symbol deltas | `pmc refresh-context --enrich` |
| `retry-errors` | `cli/retry-errors.mjs` | Retries failed enrichment entries from the worklist using configured providers | `pmc retry-errors` |
| `sanitize` | `cli/sanitize.mjs` | Rebuilds PMC graph artifacts by re-extracting symbols, re-hashing, and re-syncing | `pmc sanitize` |
| `session-start` | `cli/session-start.mjs` | One-shot session initializer: checks enrichment, launches background processes, reports pending sync ops | `pmc session-start .` |
| `setup` | `cli/setup.mjs` | Interactive setup wizard: runs doctor, installs graphify, bootstraps project, configures agent templates | `pmc setup --opencode` |
| `sleep-config` | `cli/sleep-config.mjs` | Read, validate, or edit the global sleep-mode configuration | `pmc sleep-config show` |
| `sleep-run` | `cli/sleep-run.mjs` | One-shot maintenance pipeline: decay evaluation, promotion, enrichment with checkpointing | `pmc sleep-run --db ./memory.db` |
| `sleep-watch` | `cli/sleep-watch.mjs` | Idle daemon that monitors CPU/idle state and spawns sleep-run when eligible | `pmc sleep-watch` |
| `subagent-apply` | `cli/subagent-apply.mjs` | Persists enrichment results from an agent subagent into the standard PMC pipeline | `pmc subagent-apply . --entry-id <id> --content-file <path>` |
| `sync-context` | `cli/sync.mjs` | Syncs pending enrichment data from the local graph into agent memory via MCP | `pmc sync-context` |
| `view-context` | `bin/pmc-view-context.mjs` | Opens the PMC Graph Explorer web UI | `pmc view-context` |
| `watch` | `cli/watch.mjs` | Watches project files for changes with debounced refresh-context triggers | `pmc watch .` |

## Internal CLI Scripts

These scripts exist in `cli/` but are not registered as `pmc` subcommands. They are used internally by the enrichment pipeline:

| Script | Purpose |
|--------|---------|
| `enrich-queue.mjs` | Main enrichment queue processor (internal; use `enrich` as the entry point) |
| `enrich-watchdog.mjs` | Background watchdog that monitors the enrichment queue and relaunches on stalls |
| `build-worklist.mjs` | Builds enrichment worklist from source files by extracting top-level symbols |
| `apply-enrichment-result.mjs` | Applies a JSON enrichment result payload to the project graph, index, and worklist |
| `finalize-enrichment.mjs` | Finalizes an enrichment result by persisting to graph, index, and worklist |
| `fail-enrichment.mjs` | Records an enrichment failure for a symbol |
| `prepare-semantic-jobs.mjs` | Prepares semantic enrichment job definitions from the current worklist |
| `materialize-enrichment-artifacts.mjs` | Materializes enrichment job and report into persisted memory files |
| `save-intake-context.mjs` | Saves an intake context (project description + mapping goals) as a JSON artifact |

## Context Depth Levels

Used with `get-context`:

| Depth | Description |
|-------|-------------|
| `compact` | Summary with key relationships (default) |
| `extended` | Includes dependencies and extended metadata |
| `deep` | Full traversal with all available detail |
| `disk` | Raw source code of the target |
