# @aabadin/project-memory-context (PMC)

Portable project memory context — bootstraps **semantic enrichment workflows** for any AI coding agent.

`pmc` installs, configures, and runs a complete pipeline that:
1. **Maps** your codebase into a knowledge graph (via graphifyy)
2. **Extracts** every top-level symbol (functions, classes, interfaces, etc.)
3. **Enriches** each symbol with LLM-generated semantics (responsibility, inputs, outputs, dependencies)
4. **Persists** everything as searchable memories that survive across sessions

This gives your AI agent persistent, recallable knowledge of your entire codebase without re-reading files.

---

## Table of Contents

- [Concept & Objective](#concept--objective)
- [Architecture](#architecture)
- [Models](#models)
- [Installation](#installation)
- [Setup](#setup)
  - [Single-agent setup](#single-agent-setup)
  - [Multi-agent setup](#multi-agent-setup--flags)
  - [Automated detection](#automated-detection)
- [CLI Reference](#cli-reference)
  - [`pmc setup`](#pmc-setup)
  - [`pmc map-project`](#pmc-map-project)
  - [`pmc enrich`](#pmc-enrich)
  - [`pmc get-context`](#pmc-get-context)
  - [`pmc enrich-status`](#pmc-enrich-status)
  - [`pmc doctor`](#pmc-doctor)
  - [`pmc init-project`](#pmc-init-project)
  - [`pmc sync-context`](#pmc-sync-context)
  - [`pmc sanitize`](#pmc-sanitize)
  - [`pmc project-context`](#pmc-project-context)
- [Environment Variables](#environment-variables)
- [OpenCode Session Startup](#opencode-session-startup)
- [OpenCode Auto-Refresh Hook](#opencode-auto-refresh-hook)
- [Recommended Optional Plugin: opencode-pty](#recommended-optional-plugin-opencode-pty)
- [Project Structure](#project-structure)
- [9 Base Project-Context Memories](#9-base-project-context-memories)
- [Credits](#credits)

---

## Concept & Objective

AI coding agents (OpenCode, Claude Code, Cursor, etc.) work within a single session. When a session ends, the agent forgets everything it learned about your codebase.

**Project-Memory-Context (PMC)** solves this by creating a **persistent semantic layer** between your codebase and your agent:

| Component | What it does |
|---|---|
| **Visit (graphifyy)** | AST-level static analysis — builds a dependency graph of your entire codebase |
| **Symbol extraction** | Regex+parser extraction of all top-level symbols (classes, functions, interfaces, etc.) |
| **Semantic enrichment** | Calls a local LLM (Ollama) to describe each symbol's responsibility, inputs, outputs, and role |
| **Agent Memory** | Stores each enriched symbol as a searchable vector memory (hybrid BM25 + semantic) |
| **Project Context** | 9 auto-generated "base memories" about your project's stack, structure, architecture, etc. |

The result: your agent can recall what a file does, how symbols connect, and what the project architecture looks like — across sessions, without re-scanning.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PMC Package (@aabadin/...)                    │
│                                                                     │
│  cli/setup.mjs          cli/bootstrap.mjs       cli/enrich-queue.mjs│
│  cli/context.mjs        cli/project-context.mjs  cli/doctor.mjs     │
│  cli/build-worklist.mjs cli/enrich.mjs           cli/status.mjs     │
│  cli/sanitize.mjs       cli/finalize.mjs         ...                │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  src/                           │  templates/                  │  │
│  │  ├── providers/                 │  ├── opencode/ (commands,    │  │
│  │  │   ├── local-model-provider   │  │    agents, autostart)     │  │
│  │  │   └── cloud-api-provider     │  ├── claude-code/            │  │
│  │  ├── extractors/ (stack,       │  ├── cursor/                 │  │
│  │  │   structure, symbols)        │  └── generic/               │  │
│  │  ├── retrieval/ (query-engine)  └───────────────────────────────┘  │
│  │  ├── setup-bootstrap.mjs                                            │
│  │  ├── template-installer.mjs                                        │
│  │  ├── enrichment-driver.mjs                                         │
│  │  ├── enrichment-config.mjs                                         │
│  │  ├── sync-manifest.mjs                                             │
│  │  ├── platform.mjs                                                  │
│  │  └── ...                                                           │
│  └────────────────────────────────────────────────────────────────    │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  MCP Servers (installed by pmc setup)                        │   │
│  │  └── agent-memory  → npx -y @aabadin/agent-memory-mcp       │   │
│  │                      (LanceDB + hybrid search)               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  External Dependencies                                        │   │
│  │  ├── Ollama (local LLM for enrichment)                        │   │
│  │  ├── graphifyy (Python pkg, AST-level knowledge graph)        │   │
│  │  └── agent-memory-mcp (MCP server, hybrid BM25+vector DB)    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer details

**PMC CLI layer** (`cli/*.mjs`): Each file is a single command dispatchable via `pmc <command>`. They import from `src/` for shared logic.

**PMC source layer** (`src/*.mjs`): Shared utilities, providers, extractors, and state management.

**Agent Memory MCP** (`@aabadin/agent-memory-mcp`): A TypeScript MCP server backed by **LanceDB** with hybrid BM25 + vector search. Stores every enriched symbol as a searchable memory. Embeddings are generated locally using `Xenova/bge-m3` via ONNX — no API keys, no network after initial download. See [Credits](#credits) for the original repo.

**Graphify** (`graphifyy`): A Python package by [obra](https://github.com/obra/graphify) that performs AST-level structural analysis of your codebase. Produces a `graph.json`, `graph.html`, and `GRAPH_REPORT.md` showing file-level dependencies, imports, and module clustering. No LLM calls during graph generation. See [Credits](#credits) for the original repo.

---

## Models

### Embedding Model: `Xenova/bge-m3`

| Property | Value |
|---|---|
| Model | [Xenova/bge-m3](https://huggingface.co/Xenova/bge-m3) |
| Dimensions | 1024 |
| Pooling | CLS (first token) |
| Runtime | ONNX via `@huggingface/transformers` v4.2.0 |
| Cache | Local ONNX model cache (~1 GB on first download) |
| Provider | Runs entirely locally inside the `agent-memory-mcp` process |

Used for: converting every memory into a dense vector for semantic similarity search. The ONNX runtime downloads the model once on first run and caches it locally — no network calls during normal operation.

### LLM: `deepseek-coder-v2:16b-ctx16k` (Ollama)

| Property | Value |
|---|---|
| Model | [deepseek-coder-v2](https://ollama.com/library/deepseek-coder-v2) |
| Provider | [Ollama](http://localhost:11434) |
| Context | 32K tokens |
| Size | 16B parameters |
| Hardware | Local GPU/CPU via Ollama |

Used for: semantic enrichment — reading source code fragments and producing structured descriptions of each symbol's responsibility, inputs, outputs, dependencies, and role.

**Alternative models** (configure via `OLLAMA_MODEL` env var):
- `qwen3-coder:30b` — larger, better reasoning
- `codellama:13b` — good for code tasks
- `deepseek-coder-v2:16b-ctx16k` — default, best balance of speed and quality

---

## Installation

```bash
npm install -g @aabadin/project-memory-context
```

Or run without installing:

```bash
npx @aabadin/project-memory-context setup
```

**System requirements:**
- Node.js ≥ 18
- Ollama installed and running
- Python 3 (for graphifyy)
- git (required to install graphifyy from source fork — see note below)
- ~2 GB free disk space (for embedding model cache + LanceDB)

> **Note — graphifyy fork:** PMC currently installs graphifyy from a fork that adds Razor/CSHTML support for ASP.NET MVC projects. This is a temporary measure while [PR #1085](https://github.com/safishamsi/graphify/pull/1085) is under review. Once merged, PMC will revert to installing from PyPI. To install manually:
> ```bash
> pip install git+https://github.com/adrianabadin/graphify.git@feat/cshtml-mvc-razor-extraction
> ```
> If you prefer the stable PyPI release (without Razor support):
> ```bash
> pip install graphifyy
> ```

---

## Setup

Run `pmc setup` in your project root:

```bash
cd /path/to/your/project
pmc setup
```

The interactive prompt asks for:
1. **Ollama base URL** (default: `http://localhost:11434`)
2. **Ollama model name** (default: `deepseek-coder-v2:16b-ctx16k`)

It then:
1. Installs `graphifyy` via pip
2. Creates `.planning/project-memory-context/` with full directory structure
3. Writes MCP config for `agent-memory` and per-agent enrichment config files
4. Installs agent-specific templates (commands, agents config, autostart snippets)
5. Runs the environment doctor to verify everything works

### Single-agent setup

```bash
pmc setup                        # Auto-detects your agent
pmc setup --opencode             # Force OpenCode
pmc setup --claude               # Force Claude Code
pmc setup --cursor               # Force Cursor
pmc setup --antigravity          # Force Antigravity CLI
pmc setup --generic              # Generic (writes README-SETUP.md)
```

> **Note:** The generated commands invoke `pmc` directly. Make sure the CLI is installed globally:
> `npm install -g @aabadin/project-memory-context`

### Multi-agent setup (combinable flags)

```bash
pmc setup --opencode --claude                    # OpenCode + Claude Code
pmc setup --opencode --claude --cursor           # All three
pmc setup --opencode --cursor                    # OpenCode + Cursor only
pmc setup --claude --antigravity                 # Claude Code + Antigravity
```

Each agent gets its own configuration:
- **OpenCode**: `.opencode/opencode.json` with `mcp.agent-memory` entry + `AGENTS.md` autostart + global commands/agents/skills
- **Claude Code**: `.claude/project-memory-context.json` enrichment config + `.mcp.json` + global commands/skills/`agents/enrich.md` subagent
- **Antigravity**: `AGENTS.md` autostart + `.agents/skills/<cmd>/SKILL.md` (cada comando PMC como skill/slash command) + `.agents/skills/{pmc-skill,enrich}/SKILL.md`. Nota: Antigravity no soporta subagentes por archivo (feature request abierta); `enrich` se instala como skill invocable por el modelo y por slash command `/enrich`.
- **Cursor**: `.cursor/project-memory-context.json` enrichment config + `.mcp.json`
- **All agents**: `.mcp.json` at project root (universal fallback)

### Automated detection

When run without flags, `pmc setup` detects your agent by checking (in order):

1. `.opencode/` directory → OpenCode
2. `CLAUDE.md` file → Claude Code
3. `.claude/` directory → Claude Code
4. `.cursorrules` file → Cursor
5. `.cursor/` directory → Cursor
6. `.agents/` directory → Antigravity
7. `~/.config/opencode/` exists → OpenCode (global)
8. Otherwise → Generic

---

## CLI Reference

### `pmc setup`

Interactively bootstraps PMC in the current project.

```bash
pmc setup [--opencode] [--claude] [--cursor] [--antigravity] [--generic]
```

| Flag | Description |
|---|---|
| `--opencode` | Install configs for OpenCode |
| `--claude` | Install configs for Claude Code |
| `--cursor` | Install configs for Cursor |
| `--antigravity` | Install configs for Antigravity CLI |
| `--generic` | Generic setup (README only) |
| *(no flags)* | Auto-detect agent(s) |

**What it creates:**
```
.planning/
  project-memory-context/
    install.json
    enrichment/
    graph/
    intake/
    runs/
    project-context/
      detected/     (auto-detected metadata)
      declared/     (user-declared metadata)
      materialized/ (9 base memories)
      markdown/     (human-readable context)
      state/        (refresh state)
.opencode/opencode.json            (if opencode)
.claude/project-memory-context.json (if claude-code)
.cursor/project-memory-context.json (if cursor)
.mcp.json                          (universal MCP)
AGENTS.md                          (autostart snippet, if opencode)
project-memory-context.md
project-memory-context workflow.md
```

---

### `pmc map-project`

Portable, non-interactive bootstrap for any repo. Runs all stages.

```bash
pmc map-project [target-repo] [--all] [--stage-a] [--stage-b] [--enrich]
```

| Argument / Flag | Description |
|---|---|
| `target-repo` | Path to the target repo (default: current dir) |
| `--stage-a` | Intake + graphify structural mapping |
| `--stage-b` | Symbol extraction + build enrichment worklist |
| `--all` | Both stages |
| `--enrich` | Start enrichment queue in background (requires at least one stage) |

**Examples:**

```bash
# Full pipeline (setup + graphify + symbols + enrichment)
pmc map-project . --all

# Graphify only
pmc map-project . --stage-a

# Symbols + enrichment only (after graphify)
pmc map-project . --stage-b --enrich

# Custom model
OLLAMA_MODEL=qwen3-coder:30b pmc map-project . --all --enrich
```

**Environment variables for map-project:**

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama REST endpoint |
| `OLLAMA_MODEL` | `deepseek-coder-v2:16b-ctx16k` | Ollama model |
| `PMC_CONCURRENCY` | `8` | Parallel slots for worklist |
| `PMC_GRAPHIFY_PATH` | *(auto-detect)* | Custom path to graphify executable |

---

### `pmc enrich`

Run the semantic enrichment queue.

```bash
pmc enrich [project-dir]
```

The enrichment queue:
1. Reads `worklist.json` for pending symbols
2. For each symbol, extracts the source code fragment
3. Calls the local Ollama LLM with a structured prompt
4. Stores the result as a memory via `agent-memory-mcp`
5. Updates `graph.json`, `symbol-index.json`, and `worklist.json`

**Internal pipeline per symbol:**
```
Symbol → semantic-unit (code fragment + imports)
       → local-model-provider (Ollama) → structured report
       → normalize-semantic-report → memory payload
       → agent-memory: store → memoryId
       → finalize-enrichment (graph + index + worklist)
```

---

### `pmc get-context`

Render project context for the current directory or a specific target.

```bash
pmc get-context [target] [depth] [focus]
pmc get-context {symbol|file|query} <target> [depth] [focus]
pmc get-context --refresh
```

| Option | Description |
|---|---|
| `target` | Symbol key or file path to focus on (default: project overview) |
| `depth` | Output verbosity (default: `compact`) |
| `focus` | Output focus (`all`, `dependencies`, `callers`, `containment`) |
| `--refresh` | Re-detect files and refresh stale memories |

Depth levels:
- **compact** — symbol name + one-line summary
- **extended** — full LLM-generated description
- **deep** — includes all neighbors (depends on / depended by)
- **disk** — includes raw source code

---

### `pmc enrich-status`

Show enrichment progress and system health.

```bash
pmc enrich-status
```

Output:
```
Enrichment config:
  Preferred modes: local-model, cloud-api, agent-subagent
  Local model: deepseek-coder-v2:16b-ctx16k @ http://localhost:11434

Worklist:
  Total symbols:    314
  Pending:          201
  Enriched:         87
  Stale:            21
  Failed:           5
```

---

### `pmc doctor`

Run environment diagnostics to check that all dependencies are available.

```bash
pmc doctor
```

Checks:
- **node-version** — Node.js ≥ 18?
- **python** — Python 3 available?
- **graphifyy** — graphifyy package installed?
- **ollama** — Ollama reachable?
- **memory-db-path** — MEMORY_DB_PATH set and writable?
- **embedding-cache** — EMBEDDING_CACHE_PATH configured?

---

### `pmc init-project`

Initialize PMC project state and install agent-facing templates.

```bash
pmc init-project [--agent opencode|claude-code|cursor|generic]
```

Creates the `.planning/project-memory-context/` directory tree, default configuration files, and agent-specific command snippets for the current project.

---

### `pmc sync-context`

Apply pending sync-manifest operations to `agent-memory`.

```bash
pmc sync-context
```

---

### `pmc sanitize`

Clean up stale enrichment artifacts and rebuild worklist state.

```bash
pmc sanitize
```

---

### `pmc project-context`

Materialize or refresh the 9 base project-context memories.

```bash
pmc project-context [--refresh]
```

| Flag | Description |
|---|---|
| *(none)* | Generate all 9 memories from scratch |
| `--refresh` | Only refresh memories whose source files have changed |

---

## Environment Variables

### PMC variables

| Variable | Default | Description |
|---|---|---|
| `PMC_CLOUD_API_KEY` | *(none)* | API key for cloud enrichment fallback |
| `PMC_CONCURRENCY` | `8` | Parallel enrichment slots |
| `PMC_GRAPHIFY_PATH` | *(auto-detect)* | Custom path to graphify executable |
| `PMC_GRAPHIFY_BIN` | *(auto-detect)* | Alternative to `PMC_GRAPHIFY_PATH` |
| `PMC_GLOBAL_CONFIG` | `~/.config/opencode/project-memory-context.json` | Override global config path |
| `PMC_LOCAL_MODEL_BASE_URL` | `http://localhost:11434` | Ollama URL for enrichment |
| `PMC_LOCAL_MODEL_NAME` | *(from setup)* | Ollama model for enrichment |

### Agent Memory MCP variables

| Variable | Required | Description |
|---|---|---|
| `MEMORY_DB_PATH` | Yes | Path to LanceDB database directory |
| `EMBEDDING_MODEL` | No | `Xenova/bge-m3` (default) |
| `EMBEDDING_DIMENSIONS` | No | `1024` (inferred from model) |
| `EMBEDDING_POOLING` | No | `cls` (inferred from model) |
| `EMBEDDING_CACHE_PATH` | No | Content-addressed binary embedding cache |
| `MEMORY_DECAY_HALF_LIFE` | No | `30` days (set `0` to disable) |
| `ENABLE_HARDCOPY` | No | `true` to enable JSON file backup |
| `HARDCOPY_PATH` | If hardcopy | Directory for JSON mirror files |

---

## OpenCode Session Startup

`pmc init .` (or `pmc install-pmc`) installs `.opencode/plugins/pmc.mjs` — an auto-loaded plugin that OpenCode picks up at startup with no manual wiring required. It also writes the PMC MCP server entries into `.opencode/opencode.json` (merging non-destructively with existing config).

On every OpenCode startup the plugin runs a zero-token Node runtime (`runSessionStartRuntime`) that:

1. Launches `pmc refresh-context --enrich` detached (hash-incremental — only changed files are re-processed)
2. Launches background enrichment + watchdog if pending symbols exist
3. Ensures exactly one detached file watcher per project (see **OpenCode File Watcher** below)
4. Writes the startup snapshot to `.planning/project-memory-context/runs/session-start/latest.json` and `.planning/project-memory-context/runs/session-start/latest.md`

The startup sequence adds less than 100ms of wall time and zero tokens to the session. Startup uses detached Node child processes today, not PTY tools. If the plugin is disabled, the manual fallback is `pmc session-start .`.

---

## OpenCode File Watcher

The PMC file watcher (`pmc watch .`) watches source files and triggers `pmc refresh-context --enrich` automatically when files go quiet. It supersedes the old `opencode-refresh-hook` (`tool.execute.after`) approach — it sees agent edits, human edits, and git operations alike.

### Debounce semantics

Each file has its own independent 5-minute quiet timer. A file that is being continuously edited never blocks the refresh of other files that have gone quiet. Once a file's quiet window expires, a single `pmc refresh-context --enrich` run is launched (pending state is merged across files).

### Lifecycle

- **30-second tick + heartbeat**: the watcher writes a heartbeat every 30s to `state/watch.pid`
- **PID file identity**: the PID file stores `{ pid, projectRoot, heartbeatAt }`. A running watcher is considered stale if `heartbeatAt` is more than 90s old (guards against PID reuse, zombie processes, and hung watchers)
- **Pending state persistence**: `state/watch-pending.json` survives restarts — if the watcher is killed mid-debounce, the next startup picks up where it left off

### CLI flags

```bash
pmc watch . --detach   # start in background (confirms startup within 5s)
pmc watch . --status   # JSON: alive, pid, lastHeartbeat, pendingFiles
pmc watch . --stop     # stop the tracked watcher
```

The plugin startup (`runSessionStartRuntime`) calls the `--detach` path automatically. Manual use is only needed when the plugin is not installed or after a manual `--stop`.

### Enrichment single-instance guard

`enrich-queue` has a built-in single-instance guard (PID + heartbeat) so concurrent launchers — session-start, refresh-context, and the file watcher — cannot double-process the same queue. If an instance is already running, subsequent launch attempts exit immediately without starting a second worker.

---

## Recommended Optional Plugin: opencode-pty

[opencode-pty](https://github.com/shekohex/opencode-pty) is a community OpenCode plugin that adds interactive pseudo-terminal (PTY) management. It lets agents spawn long-running background processes (`pmc enrich`, dev servers, file watchers, etc.), stream their output on demand, send interactive input (Ctrl+C, prompts, keystrokes), and clean them up on exit.

**Why PMC recommends it:** the recommended PMC workflow keeps `pmc enrich .` running in the background while the agent works on other tasks. Without PTY support that process is invisible to the agent — it cannot read progress, recover a stalled run, or react to prompts. The autostart block in `AGENTS.md` (watchdog poll + subagent drain) assumes PTY tools are available, and falls back to blind background `bash` otherwise. Install opencode-pty to get the full intended workflow.

### Installation

Add `opencode-pty` to the `plugin` array in your OpenCode configuration (project-level `.opencode/opencode.json` or global `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-pty"]
}
```

OpenCode installs the plugin automatically on the next run. After saving the config, restart OpenCode so the plugin code is loaded.

If you keep your OpenCode config under version control, commit this change so it stays in sync across machines.

### Verifying

Inside an OpenCode session, the following tools should be available:

- `pty_spawn` — start a new background process with a command
- `pty_list` — list active PTY sessions
- `pty_read` — read buffered output from a session
- `pty_write` — send input (e.g. `\\x03` for Ctrl+C)
- `pty_kill` — terminate a session and free its buffer

If they are missing, confirm the entry is in the `plugin` array, then restart OpenCode. Run `pmc doctor` to check that the rest of the environment (Ollama, graphifyy, memory DB) is healthy.

### Updating

OpenCode does not auto-update plugins. To upgrade opencode-pty:

```bash
rm -rf ~/.cache/opencode/node_modules/opencode-pty
opencode
```

OpenCode reinstalls the latest version on the next start.

---

## Project Structure

A project with PMC installed will have:

```
your-repo/
├── .planning/
│   └── project-memory-context/
│       ├── install.json               # PMC install state
│       ├── enrichment/
│       │   ├── worklist.json          # All symbols + enrichment status
│       │   ├── sync-manifest.json     # Pending agent-memory syncs
│       │   ├── semantic-jobs.json     # Prepared LLM enrichment jobs
│       │   ├── failures.json          # Failed enrichment attempts
│       │   └── *.memory.json          # Per-symbol memory payloads
│       ├── graph/
│       │   ├── graph.json             # Knowledge graph (graphifyy output)
│       │   ├── graph.html             # Visual knowledge graph
│       │   ├── graph.metadata.json    # Graph metadata
│       │   └── GRAPH_REPORT.md        # Human-readable graph report
│       ├── intake/                    # Project description + goals
│       ├── runs/                      # Run-specific artifacts
│       └── project-context/
│           ├── detected/              # Auto-detected context
│           ├── declared/              # User-declared context
│           ├── materialized/          # 9 base memories (JSON)
│           ├── markdown/              # Human-readable context
│           └── state/                 # Refresh state tracking
├── .opencode/opencode.json            # OpenCode MCP config (if opencode)
├── .claude/project-memory-context.json # Claude Code enrichment config
├── .mcp.json                          # Universal MCP server config
├── AGENTS.md                          # PMC autostart block
├── project-memory-context.md          # Command template
└── project-memory-context workflow.md # Workflow template
```

---

## 9 Base Project-Context Memories

When you run `pmc project-context`, PMC generates and stores 9 memories in `agent-memory`:

| # | Memory Key | Description |
|---|---|---|
| 1 | `stack-runtime` | Language, framework, runtime version (from `package.json`, `tsconfig.json`, etc.) |
| 2 | `dependencies-summary` | Key dependencies and libraries |
| 3 | `integrations-summary` | External services and APIs |
| 4 | `architecture-current` | Current architecture patterns and entry points |
| 5 | `architecture-target` | Desired or declared target architecture |
| 6 | `structure-summary` | Root directories, key subtrees, and entry points |
| 7 | `technical-rules` | Coding standards, conventions, and rules |
| 8 | `project-requirements` | Declared business and functional requirements |
| 9 | `known-issues-and-fixes` | Known issues and recorded workarounds |

These are refreshed automatically when their source files change (`--refresh` mode).

---

## Credits

### Agent Memory MCP

The `@aabadin/agent-memory-mcp` package is a **fork** of [adamrdrew/agent-memory-mcp](https://github.com/adamrdrew/agent-memory-mcp), published under the `@aabadin` scope on npm.

**Original**: Adam Drew's [agent-memory-mcp](https://github.com/adamrdrew/agent-memory-mcp) is an MCP server for persistent agent memory backed by LanceDB with hybrid BM25 + vector search using local ONNX embeddings.

**Modifications for this project:**
- Published under `@aabadin` scope (original author did not publish to npm under `@brain` scope)
- Version bumped to 2.0.0
- All references updated from `@brain/` to `@aabadin/` scope
- Fully compatible with the original API and tool set

The `agent-memory-mcp` package provides the **persistence layer** — every enriched symbol, every project-context memory, and every user observation is stored via this MCP server. It runs `npx -y @aabadin/agent-memory-mcp` automatically when installed by `pmc setup`.

### Graphifyy

[graphifyy](https://github.com/safishamsi/graphify) by [safishamsi](https://github.com/safishamsi) is a Python package for AST-level structural analysis of codebases. It produces knowledge graphs showing file dependencies, imports, module clustering, and code organization — all without LLM calls.

**Role in PMC:** Graphify generates the base knowledge graph (`graph.json`) that PMC uses to understand symbol locations, file dependencies, and module relationships. The graph is stored under `.planning/project-memory-context/graph/` and is consumed by the query engine for context-aware symbol lookups.

**Fork:** PMC currently uses [adrianabadin/graphify @ feat/cshtml-mvc-razor-extraction](https://github.com/adrianabadin/graphify/tree/feat/cshtml-mvc-razor-extraction), which extends `extract_razor()` with MVC-specific CSHTML patterns (Layout inheritance, Html.Partial, asp-controller/action, form submissions, TagHelpers). A PR has been submitted upstream: [safishamsi/graphify#1085](https://github.com/safishamsi/graphify/pull/1085). Once merged, PMC will switch back to the official PyPI package.

---

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
