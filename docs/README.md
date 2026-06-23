# PMC Documentation

PMC (Project Memory Context) gives AI agents persistent, queryable knowledge about codebases via knowledge graphs, semantic enrichment, and agent-memory integration.

## Package Documentation

| Document | Description |
|----------|-------------|
| [Agent Memory MCP](packages/agent-memory-mcp.md) | Full reference for the `@aabadin/agent-memory-mcp` package: MCP tools, session ledger, memory lifecycle, topic aliases, upsert semantics, project merging. |
| [Project Memory Context](packages/project-memory-context.md) | Full reference for the `@aabadin/project-memory-context` CLI/runtime: CLI commands, enrichment pipeline, refresh/sync workflow, file watcher, sleep mode, gradual forgetting internals. |
| [Semantic Search](SEMANTIC-SEARCH.md) | Unified search surfaces: `search_memories`, `search_sessions`, `search_global`, `recall_global`, `find_related`. Result schemas, filters, explain scoring. |
| [Configuration](CONFIGURATION.md) | Global JSON config schema (`~/.config/opencode/project-memory-context.json`), defaults, override behavior, examples. |
| [Sleep Mode](SLEEP-MODE.md) | Idle-time maintenance: idle detection, CPU thresholds, keep-awake lease, local-only enforcement, crash recovery, report format. |
| [Gradual Forgetting](GRADUAL-FORGETTING.md) | Memory decay stages, gist preservation, revive gate, global promotion, defaults. |
| [Architecture](ARCHITECTURE.md) | High-level architecture: two-package structure, pipeline stages, on-disk state, composition chain. |

## Existing Documentation

| Document | Description |
|----------|-------------|
| [Commands Reference](COMMANDS.md) | All `pmc` CLI subcommands with examples. |
| [Development Guide](DEVELOPMENT.md) | Setup, testing, running enrichment, debugging. |
| [Migration Guide](MIGRATION.md) | Future migration to the unified `pmc` MCP server (planned, not yet implemented). |
| [Changelog](../CHANGELOG.md) | Recent changes and version history. |
