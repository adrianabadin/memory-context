# opencode-project-memory-context

Bootstrap package for project memory context workflows in OpenCode.

This package installs and wires together:

- a project bootstrapper (`pmc-setup`)
- a local semantic MCP backed by Ollama (`pmc-local-model`)
- an `agent-memory` wrapper MCP (`pmc-agent-memory`)
- command/workflow templates for `project-memory-context`
- helper CLIs and artifact management for the semantic enrichment loop

## What it installs for you

The setup flow is designed to resolve everything automatically except:

- installing Ollama itself
- pulling/downloading your local model

The setup flow handles:

- asking for `OLLAMA_BASE_URL`
- asking for `OLLAMA_MODEL`
- installing `graphifyy` with Python/pip
- creating `.planning/project-memory-context/`
- writing project install state
- registering the plugin in `.opencode/opencode.json`
- copying `project-memory-context.md` and `project-memory-context workflow.md` into the target project

## Install

Install the package where OpenCode can resolve npm plugins from, then run setup inside the target repository.

```bash
npm install opencode-project-memory-context
node node_modules/opencode-project-memory-context/cli/setup.mjs
```

If you publish it globally and your environment resolves OpenCode plugin packages globally, the setup entrypoint can be run from the installed package location.

## Setup prompts

`pmc-setup` asks for:

- Ollama base URL, default `http://localhost:11434`
- Ollama model name, default `deepseek-coder-v2:16b-ctx32k`

It then attempts to install:

```bash
python -m pip install graphifyy
```

or an equivalent Python launcher depending on platform.

## Resulting project files

After setup, the target project contains:

```text
.opencode/opencode.json
.planning/project-memory-context/install.json
project-memory-context.md
project-memory-context workflow.md
```

## Runtime layout

During workflow execution, artifacts accumulate under:

```text
.planning/project-memory-context/
  intake/
  graph/
  enrichment/
  runs/
```

## MCP servers registered by the plugin

The plugin injects these local MCP entries at runtime using values from `.planning/project-memory-context/install.json`:

- `pmc-local-model`
- `pmc-agent-memory`

`pmc-local-model` exposes a semantic report tool backed by Ollama.

`pmc-agent-memory` wraps the packaged `@adamrdrew/agent-memory-mcp` server.

## Workflow order

1. `stage-a`
   - intake
   - brainstorming clarification
   - graphify structural mapping

2. `stage-b`
   - build worklist
   - prepare semantic jobs
   - call `pmc-local-model`
   - materialize `*.memory.json`
   - store/update in `pmc-agent-memory`
   - materialize `*.result.json`
   - finalize or fail each symbol

## Development verification

Run the local test suite:

```bash
node --test "tools/project-memory-context/tests/*.test.mjs"
```
