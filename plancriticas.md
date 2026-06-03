# Plan de resolución — `criticas.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task with TDD. Steps use checkbox (`- [ ]`) syntax.

**Fecha**: 2026-05-19
**Scope**: Resolver los 15 issues de `criticas.md` antes de publicar `@brain/project-memory-context@0.1.0` + `@brain/agent-memory-mcp@2.0.0`.

**Evaluación previa**: las 15 críticas fueron verificadas contra el código real. **Concuerdo con todas**. Origen mixto: 4 bugs introducidos durante la migración a `.mcp.json` (3, 4, 5, 14), 3 bugs preexistentes (1, 2, 7), 2 errores de regresión en Plan B reciente (6, 14), y 6 deudas de diseño preexistentes (8–15).

**Goal**: dejar PMC + agent-memory listos para `npm publish` con 0 tests fallidos, 0 dependencias `file:`, código muerto eliminado, y duplicaciones consolidadas.

**Architecture**: 4 fases ordenadas por severidad. Cada task sigue TDD estricto — test fallido → implementación → verificación. Fases son ejecutables en serie por dependencias entre fixes (los cambios de diseño asumen que los blockers están resueltos).

**Tech Stack**: Node.js 18+ ESM, `node:test`, `node:assert/strict`. Sin nuevas dependencias.

---

## Estado actual de tests

```
PMC:          205/209 pass (4 fail por items 3, 4, 5, 6)
agent-memory: 105/105 pass (sin issues)
npm pack:     PMC 89 files / 64.3 kB | agent-memory 33 files / 37.1 kB
```

Objetivo del plan: PMC **209/209** o más después de los nuevos tests TDD.

---

# FASE 1 — Bloqueadores de publish (CRÍTICO)

## Task 1: Eliminar dependencia `file:` y wrapper huérfano

**Files:**
- Modify: `tools/project-memory-context/package.json`
- Delete: `tools/project-memory-context/mcp/agent-memory-wrapper.mjs`
- Delete: `tools/project-memory-context/mcp/` (si queda vacío)
- Modify: `tools/project-memory-context/README.md` (referencias al wrapper)

**Decisión clave**: Eliminar el wrapper completamente. Razón: el `grep` confirma que **ningún archivo del proyecto lo referencia**, y `setup-bootstrap.mjs` ya escribe `.mcp.json` con `npx -y @brain/agent-memory-mcp`. La dep `file:` solo existía para que el wrapper resolviera el paquete.

- [ ] **Step 1: Verificar que el wrapper realmente no se usa**

  ```bash
  cd tools/project-memory-context
  grep -r "agent-memory-wrapper" --exclude-dir=node_modules .
  grep -r "mcp/agent-memory" --exclude-dir=node_modules .
  ```
  Debe retornar 0 matches en archivos `.mjs`, `.json`, `.md` (excepto este plan). Si hay matches → reportar y replanificar.

- [ ] **Step 2: Eliminar wrapper y dependencia**

  ```bash
  rm tools/project-memory-context/mcp/agent-memory-wrapper.mjs
  rmdir tools/project-memory-context/mcp 2>/dev/null || true
  ```

  En `package.json`:
  ```diff
  - "@brain/agent-memory-mcp": "file:../../agent-memory-mcp",
  ```

  Eliminar también la línea correspondiente del array `files` si existe (revisar):
  ```diff
  - "mcp/",
  ```

- [ ] **Step 3: Actualizar README**

  Quitar la sección que documenta el wrapper. Reemplazar con la estrategia actual: `setup-bootstrap.mjs` escribe `.mcp.json` con `npx -y @brain/agent-memory-mcp`.

- [ ] **Step 4: Reinstalar y verificar build limpio**

  ```bash
  cd tools/project-memory-context
  rm -rf node_modules package-lock.json
  npm install --ignore-scripts --legacy-peer-deps
  npm pack --dry-run
  ```

  Debe completar sin errores y sin la dep `file:`.

---

# FASE 2 — Tests fallidos (IMPORTANTE)

## Task 2: Fix `normalizeProjectPath` para resolver `..`

**Files:**
- Modify: `tools/project-memory-context/src/platform.mjs`
- Verify: `tools/project-memory-context/tests/platform.test.mjs` (no cambia — el test esperado ya es correcto)
- Verify: `tools/project-memory-context/tests/platform-paths.test.mjs` (mis tests nuevos siguen pasando)

**Causa**: durante Plan B.7 saqué `posix.normalize` con un comentario incorrecto. El comentario decía "posix.normalize would collapse meaningful spaces" — esto es **falso**. `posix.normalize` no afecta espacios, solo colapsa `.` y `..`.

- [ ] **Step 1: Verificar test fallido**

  ```bash
  cd tools/project-memory-context
  node --test tests/platform.test.mjs 2>&1 | grep "normalizes separators"
  ```

  Debe fallar con `expected 'C:/repo/AGENTS.md', got 'C:/repo/docs/../AGENTS.md'`.

- [ ] **Step 2: Restaurar `posix.normalize`**

  En `src/platform.mjs`:
  ```js
  export function normalizeProjectPath(filePath) {
    // Converts backslashes to forward slashes and resolves . / ..
    // posix.normalize does NOT affect spaces (verified — earlier comment was wrong).
    return posix.normalize(String(filePath).replace(/\\/g, '/'));
  }
  ```

- [ ] **Step 3: Verificar que mis tests de Plan B.7 siguen pasando**

  ```bash
  node --test tests/platform.test.mjs tests/platform-paths.test.mjs
  ```

  `normalizeProjectPath('C:\\Users\\nombre apellido\\proyecto')` debe seguir retornando `'C:/Users/nombre apellido/proyecto'` (espacios preservados) **y** el test original `'C:\\repo\\docs\\..\\AGENTS.md' → 'C:/repo/AGENTS.md'` debe pasar.

  Si mis tests anteriores se rompen → posix.normalize está afectando algo más; revisar caso por caso.

---

## Task 3: Fix test `spawnBackground` — alinear con `shell: false`

**Files:**
- Modify: `tools/project-memory-context/tests/platform.test.mjs:60-66`

**Causa**: Plan B.7 cambió `spawnBackground` a `shell: false` (correcto para evitar shell injection en paths con espacios), pero el test no se actualizó.

- [ ] **Step 1: Verificar test fallido**

  ```bash
  node --test tests/platform.test.mjs 2>&1 | grep "spawnBackground"
  ```

- [ ] **Step 2: Actualizar aserciones del test**

  En `tests/platform.test.mjs:60-66`:
  ```diff
  - shell: true,
  + shell: false,
  ```

  El nombre del test también ya no es preciso ("uses shell on Windows"). Renombrar:
  ```diff
  - test('spawnBackground detaches, unreferences, and uses shell on Windows', ...
  + test('spawnBackground detaches, unreferences, and uses array args (no shell)', ...
  ```

- [ ] **Step 3: Verificar**

  ```bash
  node --test tests/platform.test.mjs
  ```

---

## Task 4: Fix tests `bootstrapProjectInstall` — alinear con `.mcp.json`

**Files:**
- Modify: `tools/project-memory-context/tests/setup-bootstrap.test.mjs:15-95`

**Causa**: Plan B cambió `setup-bootstrap.mjs` para escribir `.mcp.json` (estándar industria) en lugar de `.opencode/opencode.json` y `.claude/project-memory-context.json`. Los 3 primeros tests del archivo siguen verificando rutas viejas.

- [ ] **Step 1: Verificar tests fallidos**

  ```bash
  node --test tests/setup-bootstrap.test.mjs 2>&1 | grep -E "bootstrapProjectInstall|FAIL"
  ```

- [ ] **Step 2: Reescribir los 3 tests de bootstrap**

  Caso 1 — OpenCode: ahora debe verificar **dos archivos**: `.opencode/opencode.json` (plugin registration) **y** `.mcp.json` (servidor MCP):
  ```js
  test('bootstrapProjectInstall registers opencode plugin AND writes .mcp.json', async () => {
    // ... setup
    const opencode = await readJsonArtifact(join(projectRoot, '.opencode', 'opencode.json'));
    const mcp = await readJsonArtifact(join(projectRoot, '.mcp.json'));
    assert.ok(opencode.plugin.includes('opencode-project-memory-context'));
    assert.ok(mcp.mcpServers['agent-memory']);
    assert.equal(mcp.mcpServers['agent-memory'].command, 'npx');
    assert.deepEqual(mcp.mcpServers['agent-memory'].args, ['-y', '@brain/agent-memory-mcp']);
    assert.equal(mcp.mcpServers['agent-memory'].env.MEMORY_DB_PATH, installState.memoryDbPath);
  });
  ```

  Caso 2 — Claude Code: verifica `.mcp.json` directo y `.claude/project-memory-context.json` con `enrichment`:
  ```js
  test('bootstrapProjectInstall writes .mcp.json and enrichment config for Claude Code', async () => {
    // ... setup with .claude dir
    const mcp = await readJsonArtifact(join(projectRoot, '.mcp.json'));
    const enrich = await readJsonArtifact(join(projectRoot, '.claude', 'project-memory-context.json'));
    assert.ok(mcp.mcpServers['agent-memory']);
    assert.equal(enrich.enrichment.localModel.baseUrl, 'http://localhost:11434');
  });
  ```

  Caso 3 — Preservar config existente: verifica que `.mcp.json` y `enrichment` se **mergean** sin perder claves custom.

- [ ] **Step 3: Verificar**

  ```bash
  node --test tests/setup-bootstrap.test.mjs
  ```

---

## Task 5: Fix C# extractor — preservar `record` y emitir `method`

**Files:**
- Modify: `tools/project-memory-context/src/extractors/regex-extractor.mjs:300-380`
- Verify: `tools/project-memory-context/tests/symbol-extractor.test.mjs:43`

**Causa**: el extractor C# mapea `record` → `'class'` y miembros de clase → `kind: 'function'`. El test legacy esperaba `record` y `method` como tipos distintos (consistente con `symbol-keys.mjs` que usa `signature` para C#).

- [ ] **Step 1: Verificar test fallido**

  ```bash
  node --test tests/symbol-extractor.test.mjs 2>&1 | grep -A 5 "csharp"
  ```

  Debe mostrar diff: `[['class','User','csharp'],...] vs [['record','User','csharp'],...]`.

- [ ] **Step 2: Fix mapeo de tipos en `extractCSharp`**

  En `regex-extractor.mjs`:
  ```js
  // Línea ~338: en la rama de typeMatch, NO colapsar record → class
  const rawKind = typeMatch[1];  // 'record', 'class', 'interface', 'enum', 'struct'
  const kind = rawKind === 'interface' ? 'interface'
            : rawKind === 'record'    ? 'record'
            : 'class';  // class, enum, struct → class

  // Línea ~376: para miembros de clase usar 'method'
  const memberKind = 'method';  // antes era 'function'
  ```

  Tener cuidado: `buildSymbolKey()` en `symbol-keys.mjs` para C# usa `kind` directamente — si cambia, el `symbolKey` cambia. Esto es correcto: símbolos previamente enriquecidos con kind=`'function'` serán re-enriquecidos como `'method'`. Acceptable (codeHash igual o distinto disparará lo correcto).

- [ ] **Step 3: Actualizar mis tests de Plan B**

  En `tests/symbol-extractor-multilang.test.mjs`, el test C# verifica `kind: 'class'` para record/struct. Verificar:
  - `PersonRecord` debe ser `kind: 'record'`
  - Métodos de clase deben ser `kind: 'method'`

  Si el test nuevo se rompe → actualizarlo para reflejar la nueva taxonomía correcta.

- [ ] **Step 4: Verificar full suite**

  ```bash
  node --test tests/symbol-extractor.test.mjs tests/symbol-extractor-multilang.test.mjs
  ```

  Debe pasar el test legacy `[['record','User','csharp'],['class','UserService','csharp'],['method','GetUserAsync','csharp']]`.

---

# FASE 3 — Debilidades de diseño (IMPORTANTE)

## Task 6: Consolidar `detectAgentType` duplicado

**Files:**
- Modify: `tools/project-memory-context/src/platform.mjs` (export nuevo)
- Modify: `tools/project-memory-context/cli/status.mjs:17-22` (importar)
- Modify: `tools/project-memory-context/src/template-installer.mjs:12-19` (importar)
- Create: `tools/project-memory-context/tests/detect-agent-type.test.mjs`

- [ ] **Step 1: Test fallido**

  Crear `tests/detect-agent-type.test.mjs`:
  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { detectAgentType } from '../src/platform.mjs';

  test('detects .opencode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-detect-'));
    await mkdir(join(dir, '.opencode'));
    assert.equal(detectAgentType(dir), 'opencode');
    await rm(dir, { recursive: true, force: true });
  });

  test('detects CLAUDE.md → claude-code', async () => { ... });
  test('detects .claude → claude-code', async () => { ... });
  test('detects .cursorrules → cursor', async () => { ... });
  test('detects .cursor → cursor', async () => { ... });
  test('returns generic when no markers present', async () => { ... });
  ```

  El test fallará porque `detectAgentType` aún no se exporta desde `platform.mjs`.

- [ ] **Step 2: Mover implementación a `platform.mjs`**

  Usar la versión más completa (la de `template-installer.mjs`, que detecta tanto `CLAUDE.md` como `.claude`):
  ```js
  // src/platform.mjs (nuevo export)
  export function detectAgentType(projectRoot) {
    if (existsSync(join(projectRoot, '.opencode'))) return 'opencode';
    if (existsSync(join(projectRoot, 'CLAUDE.md'))) return 'claude-code';
    if (existsSync(join(projectRoot, '.claude'))) return 'claude-code';
    if (existsSync(join(projectRoot, '.cursorrules'))) return 'cursor';
    if (existsSync(join(projectRoot, '.cursor'))) return 'cursor';
    return 'generic';
  }
  ```

  En `cli/status.mjs`: eliminar la función local, importar desde platform.
  En `src/template-installer.mjs`: eliminar la función local, importar desde platform.

- [ ] **Step 3: Verificar**

  ```bash
  node --test tests/detect-agent-type.test.mjs tests/platform.test.mjs
  ```

---

## Task 7: Eliminar paths hardcodeados en tests

**Files:**
- Modify: `tools/project-memory-context/tests/setup-bootstrap.test.mjs:109,145,170`

**Causa**: `cwd: 'C:/Users/aabad/Documents/CODE/ia/memory-context'` rompe en CI o en otra máquina.

- [ ] **Step 1: Verificar el patrón hardcodeado**

  ```bash
  grep -n "C:/Users/aabad" tests/setup-bootstrap.test.mjs
  ```

- [ ] **Step 2: Derivar de `import.meta.url`**

  Al inicio del archivo de test ya está:
  ```js
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  ```

  El `cwd` correcto para `spawnSync(..., { cwd: ... })` es el repo root (3 niveles arriba del test):
  ```js
  const repoRoot = dirname(dirname(packageRoot));  // memory-context/
  ```

  Reemplazar las 3 ocurrencias:
  ```diff
  - cwd: 'C:/Users/aabad/Documents/CODE/ia/memory-context',
  + cwd: repoRoot,
  ```

- [ ] **Step 3: Verificar**

  ```bash
  node --test tests/setup-bootstrap.test.mjs
  ```

  Tests deben pasar desde cualquier directorio.

---

## Task 8: Agregar `scripts` a PMC `package.json`

**Files:**
- Modify: `tools/project-memory-context/package.json`

- [ ] **Step 1: Agregar bloque scripts**

  ```json
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "test:watch": "node --test --watch tests/*.test.mjs",
    "prepublishOnly": "npm test"
  }
  ```

- [ ] **Step 2: Verificar**

  ```bash
  cd tools/project-memory-context && npm test
  ```

  Debe correr todos los tests y reportar pass/fail. `prepublishOnly` bloqueará un publish accidental con tests rotos.

---

## Task 9: Eliminar import `stat` no usado

**Files:**
- Modify: `tools/project-memory-context/cli/sanitize.mjs:4`

- [ ] **Step 1: Quitar `stat` del import**

  ```diff
  - import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
  + import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
  ```

- [ ] **Step 2: Verificar que el archivo sigue parseando**

  ```bash
  node --check cli/sanitize.mjs
  ```

---

## Task 10: Derivar nombres de binarios de `package.json`

**Files:**
- Modify: `tools/project-memory-context/src/template-installer.mjs:28-34`

**Causa**: `buildPlaceholders` hardcodea `PMC_BIN: 'pmc'` y `AGENT_MEMORY_CMD: 'agent-memory-mcp'`. Si el usuario instala con `npx` o renombra, los templates quedan incorrectos.

- [ ] **Step 1: Leer nombres del `package.json`**

  ```js
  import { readFile } from 'node:fs/promises';
  import { join, dirname } from 'node:path';
  import { fileURLToPath } from 'node:url';

  async function loadBinNames() {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    return {
      PMC_BIN: Object.keys(pkg.bin ?? {})[0] ?? 'pmc',
      AGENT_MEMORY_CMD: 'npx -y @brain/agent-memory-mcp',  // ahora siempre via npx
    };
  }
  ```

  Hacer `buildPlaceholders` async y propagar.

- [ ] **Step 2: Verificar templates renderizados**

  Tests existentes en `tests/install-pmc.test.mjs` deben seguir verdes.

---

# FASE 4 — Calidad y deuda técnica (MENOR)

## Task 11: Extraer helper `installWithBlockMarker` para Claude Code/Cursor

**Files:**
- Modify: `tools/project-memory-context/src/template-installer.mjs:102-140`

- [ ] **Step 1: Identificar el patrón común**

  `installClaudeCode` y `installCursor` solo difieren en:
  - File path (`CLAUDE.md` vs `.cursorrules`)
  - Template name (`claude-code/CLAUDE.md.snippet` vs `cursor/.cursorrules.snippet`)
  - Marker (ambos usan `'init'`)

- [ ] **Step 2: Extraer helper**

  ```js
  async function installWithBlockMarker({ projectRoot, packageRoot, placeholders, targetFile, templatePath, marker = 'init' }) {
    const targetPath = join(projectRoot, targetFile);
    const snippet = renderTemplate(await readTemplate(packageRoot, templatePath), placeholders);
    let existing = '';
    if (existsSync(targetPath)) existing = await readFile(targetPath, 'utf8');
    if (hasBlockMarker(existing, marker)) {
      const inner = snippet.split('\n').slice(1, -1).join('\n').replace(new RegExp(`<!-- pmc:${marker} -->|<!-- /pmc:${marker} -->`, 'g'), '').trim();
      await writeFile(targetPath, replaceOrAppendBlock(existing, marker, inner), 'utf8');
    } else {
      await writeFile(targetPath, snippet, 'utf8');
    }
  }

  const installClaudeCode = (ctx) => installWithBlockMarker({ ...ctx, targetFile: 'CLAUDE.md', templatePath: 'claude-code/CLAUDE.md.snippet' });
  const installCursor    = (ctx) => installWithBlockMarker({ ...ctx, targetFile: '.cursorrules', templatePath: 'cursor/.cursorrules.snippet' });
  ```

- [ ] **Step 3: Verificar tests existentes**

  ```bash
  node --test tests/install-pmc.test.mjs
  ```

---

## Task 12: Quitar parámetro muerto `packageRoot` en `plugin-config.mjs`

**Files:**
- Modify: `tools/project-memory-context/src/plugin-config.mjs:1`
- Modify: `tools/project-memory-context/plugin/index.mjs` (caller)
- Verify: `tools/project-memory-context/tests/plugin-config.test.mjs`

- [ ] **Step 1: Eliminar el parámetro**

  ```diff
  - export function buildInjectedPmcConfig({ packageRoot, installState }) {
  + export function buildInjectedPmcConfig({ installState }) {
  ```

- [ ] **Step 2: Actualizar caller**

  En `plugin/index.mjs`:
  ```diff
  - buildInjectedPmcConfig({ packageRoot, installState })
  + buildInjectedPmcConfig({ installState })
  ```

- [ ] **Step 3: Verificar tests**

  ```bash
  node --test tests/plugin-config.test.mjs
  ```

---

## Task 13: Estandarizar `install.json` (eliminar `install-state.json`)

**Files:**
- Modify: `tools/project-memory-context/cli/status.mjs:47`
- Modify: `tools/project-memory-context/cli/install-pmc.mjs:102`
- Modify: `tools/project-memory-context/plugin/index.mjs:11-13`
- Modify: `tools/project-memory-context/tests/install-pmc.test.mjs:33`

**Decisión**: usar `install.json` (lo que escribe `setup-bootstrap.mjs`). Es el nombre más simple y consistente con MCP/npm convenciones.

- [ ] **Step 1: Grep todas las ocurrencias**

  ```bash
  grep -rn "install-state\.json\|install\.json" --include="*.mjs" --include="*.md" .
  ```

- [ ] **Step 2: Reemplazo global**

  Cambiar `install-state.json` → `install.json` en:
  - `cli/status.mjs:47`
  - `cli/install-pmc.mjs:102`
  - `plugin/index.mjs:11` (eliminar el primer fallback, dejar solo `install.json`)
  - `tests/install-pmc.test.mjs:33`

  No tocar el contenido del JSON (la estructura no cambia).

- [ ] **Step 3: Verificar**

  ```bash
  node --test tests/install-pmc.test.mjs tests/setup-bootstrap.test.mjs
  ```

---

## Task 14: Mejorar `resolvePackageRoot` con `fileURLToPath`

**Files:**
- Modify: `tools/project-memory-context/src/template-installer.mjs:23-26`

**Causa**: el fix actual de drive letter con regex `$1` es frágil:
```js
function resolvePackageRoot() {
  const url = import.meta.url;
  return join(dirname(new URL(url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
}
```

- [ ] **Step 1: Reemplazar por `fileURLToPath`**

  ```js
  import { fileURLToPath } from 'node:url';

  function resolvePackageRoot() {
    return join(dirname(fileURLToPath(import.meta.url)), '..');
  }
  ```

  `fileURLToPath` ya maneja drive letters de Windows correctamente — es la API oficial.

- [ ] **Step 2: Verificar en Windows y POSIX**

  ```bash
  node --test tests/install-pmc.test.mjs
  ```

  El test debe pasar tanto en Windows (con `C:` drive) como en Linux/macOS.

---

# Verificación End-to-End

Una vez completadas las 14 tasks:

```bash
# 1. Tests
cd tools/project-memory-context && npm test          # debe ser >= 209 pass, 0 fail
cd ../../agent-memory-mcp && npm test                 # 105 pass

# 2. Build limpio
cd ../tools/project-memory-context
rm -rf node_modules package-lock.json
npm install --ignore-scripts --legacy-peer-deps
npm pack --dry-run                                    # debe completar sin la dep file:

cd ../../agent-memory-mcp
npm run build
npm pack --dry-run

# 3. Smoke test cross-package
cd /tmp/test-project
git init
node /path/to/pmc/bin/pmc.mjs doctor                  # 6 checks visibles
node /path/to/pmc/bin/pmc.mjs setup                   # crea .mcp.json correcto
cat .mcp.json                                          # debe tener "npx -y @brain/agent-memory-mcp"
```

---

## Resumen de archivos modificados

**Críticos** (Fase 1 + 2):
- `tools/project-memory-context/package.json` (Task 1, 8)
- `tools/project-memory-context/mcp/agent-memory-wrapper.mjs` **DELETE** (Task 1)
- `tools/project-memory-context/src/platform.mjs` (Task 2, 6)
- `tools/project-memory-context/tests/platform.test.mjs` (Task 3)
- `tools/project-memory-context/tests/setup-bootstrap.test.mjs` (Task 4, 7)
- `tools/project-memory-context/src/extractors/regex-extractor.mjs` (Task 5)

**Diseño** (Fase 3):
- `tools/project-memory-context/cli/status.mjs` (Task 6, 13)
- `tools/project-memory-context/src/template-installer.mjs` (Task 6, 10, 11, 14)
- `tools/project-memory-context/cli/sanitize.mjs` (Task 9)
- `tools/project-memory-context/cli/install-pmc.mjs` (Task 13)

**Calidad** (Fase 4):
- `tools/project-memory-context/src/plugin-config.mjs` (Task 12)
- `tools/project-memory-context/plugin/index.mjs` (Task 12, 13)

**Tests nuevos**:
- `tools/project-memory-context/tests/detect-agent-type.test.mjs` (Task 6)

**Total**: 13 archivos modificados + 1 eliminado + 1 nuevo test = **15 archivos tocados**.

---

## Orden de ejecución sugerido

1. **Fase 1** (Tasks 1) — habilita publish; los items siguientes asumen wrapper eliminado
2. **Fase 2** (Tasks 2–5) — verde la suite de tests; bloquea CI hasta resolver
3. **Fase 3** (Tasks 6–10) — limpieza de duplicación y deuda; mejora mantenibilidad
4. **Fase 4** (Tasks 11–14) — calidad fina; puede ejecutarse después del primer publish si urge

Cada fase es ejecutable de manera independiente. Tasks dentro de una fase pueden hacerse en paralelo (no comparten archivos críticos).
