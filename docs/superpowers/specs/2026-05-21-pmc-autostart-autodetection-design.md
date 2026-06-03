# PMC Autostart Autodetection Design

## Goal

Make PMC autostart work in both the source repository and consumer projects without requiring a global `pmc` binary.

## Problem

The AGENTS.md and command templates hardcode `pmc` or `{{PMC_BIN}}` as the CLI binary. In the source repo, `pmc` is not in PATH — the real entry point is `node tools/project-memory-context/cli/<command>.mjs`. This means enrichment never autostarts in the source repo.

## Solution

Add inline autodetection to every place that invokes PMC:

- If `tools/project-memory-context/cli/enrich-queue.mjs` exists → source repo → use direct `node` path
- Otherwise → consumer project → use `npx --yes --package @aabadin/project-memory-context pmc-<command>`

## Files to Change

### Source repo
- `AGENTS.md` — autostart section uses autodetection

### Templates (installed into consumer projects)
- `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet`
- `tools/project-memory-context/templates/cursor/.cursorrules.snippet`

### Global OpenCode commands
- `~/.config/opencode/commands/map-project.md`
- `~/.config/opencode/commands/enrich-status.md`
- `~/.config/opencode/commands/get-context.md`
- `~/.config/opencode/commands/sanitize.md`
- `~/.config/opencode/commands/sync-context.md`

### Template commands (installed into consumer projects)
- `tools/project-memory-context/templates/opencode/commands/map-project.md`
- `tools/project-memory-context/templates/opencode/commands/enrich-status.md`
- `tools/project-memory-context/templates/opencode/commands/get-context.md`
- `tools/project-memory-context/templates/opencode/commands/sanitize.md`
- `tools/project-memory-context/templates/opencode/commands/sync-context.md`

## Autodetection Pattern

For autostart (enrichment queue):
```
if (Test-Path "tools/project-memory-context/cli/enrich-queue.mjs") {
  Start-Process -FilePath "node" -ArgumentList "tools/project-memory-context/cli/enrich-queue.mjs" -WindowStyle Hidden
} else {
  Start-Process -FilePath "npx" -ArgumentList "--yes","--package","@aabadin/project-memory-context","pmc-enrich","." -WindowStyle Hidden
}
```

For slash commands, replace `{{PMC_BIN}} <cmd>` with:
```
node tools/project-memory-context/cli/<cmd>.mjs
```
or in consumer projects the template renders `{{PMC_BIN}}` which resolves to `npx --yes --package @aabadin/project-memory-context pmc-<cmd>`.

## Not in Scope

- Adding a global `pmc` binary
- Changing CLI scripts themselves
- Changing `install-pmc.mjs`
