# Legacy Golden Fixture Baseline Manifest

## Provenance
- **Source Worktree**: `memory-context-pmc-multi-client-slice-2-baseline`
- **Baseline Commit**: `d056323f93bf012dfe6f555cb0d83882f7e6b915`
- **Captured Date**: Mon Jul 27 2026
- **Capture Strategy**: Executed `installAgentTemplates` from the legacy baseline worktree against isolated temporary project and global config directories for all 5 supported hosts (`opencode`, `claude-code`, `cursor`, `antigravity`, `generic`).
- **Fixture File**: `legacy-golden-trees.json`

## Expected Host Output Inventory
1. `opencode`:
   - Global config: 11 markdown command files in `commands/`, `agents/enrich.md`, `skills/pmc-skill/SKILL.md`
   - Project config: `AGENTS.md` (with `<!-- pmc:autostart -->` block), `.opencode/plugins/pmc.mjs`, `.opencode/opencode.json` (schema + MCP config)
2. `claude-code`:
   - Global config: 11 markdown command files in `commands/`, `skills/pmc-skill/SKILL.md`, `agents/enrich.md`, `CLAUDE.md` (with autostart snippet), `hooks/pmc-session-start.js`, `settings.json` (with SessionStart hook)
   - Project config: `CLAUDE.md` (with `<!-- pmc:init -->` block)
3. `cursor`:
   - Project config: `.cursorrules` (with `<!-- pmc:init -->` block)
4. `antigravity`:
   - Global config: 11 command skills in `skills/`, `skills/pmc-skill/SKILL.md`, `skills/enrich/SKILL.md`, `skills/enrich-ondemand/SKILL.md`
   - Project config: 11 command skills in `.agents/skills/`, `.agents/skills/pmc-skill/SKILL.md`, `.agents/skills/enrich/SKILL.md`, `.agents/skills/enrich-ondemand/SKILL.md`, `AGENTS.md` (with autostart block)
5. `generic`:
   - Project config: `README-SETUP.md` (with `<!-- pmc:generic -->` block), `.pmc/generic-readme-installed`

## Isolation & Non-Pollution Invariants
- The write worktree tests load `legacy-golden-trees.json` and compare migrated adapter/installer outputs against these static JSON/text fixture bytes.
- The expected fixture data does NOT import or execute migrated production code at test time.
- The legacy baseline worktree remains byte-clean and untouched at commit `d056323f93bf012dfe6f555cb0d83882f7e6b915`.
