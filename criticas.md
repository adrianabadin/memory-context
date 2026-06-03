# Code Review: PMC Pre-Publish

**Fecha**: 2026-05-19
**Scope**: `@brain/project-memory-context@0.1.0` + `@brain/agent-memory-mcp@2.0.0`
**Suite de tests**: PMC 205/209 pass (4 fail) | agent-memory 105/105 pass

---

## CRITICO — Blockers para publish

### 1. Dependencia `file:` en package.json

**Archivo**: `tools/project-memory-context/package.json:50`

```json
"@brain/agent-memory-mcp": "file:../../agent-memory-mcp"
```

Es un link local. En publish npm lo resuelve como tarball inline, pero los consumidores que instalen `@brain/project-memory-context` obtendran una copia de dev sin publicar o un error directo.

**Fix**: Cambiar a `"@brain/agent-memory-mcp": "^2.0.0"` si PMC importa el paquete en runtime, o eliminar la dependencia si `setup-bootstrap.mjs` maneja toda la config del MCP server via `npx`.

---

### 2. `require.resolve` en wrapper publicado

**Archivo**: `mcp/agent-memory-wrapper.mjs:7`

```js
const packageJsonPath = require.resolve('@brain/agent-memory-mcp/package.json');
```

Este wrapper busca el entry point de agent-memory via `require.resolve`. Eso implica que PMC **requiere** que agent-memory este instalado al lado. Pero `setup-bootstrap.mjs` ahora genera configs `.mcp.json` usando `npx -y @brain/agent-memory-mcp` (descarga on-demand). El wrapper `mcp/` esta desconectado de la nueva estrategia.

**Fix**: Cambiar a `spawn('npx', ['-y', '@brain/agent-memory-mcp'], ...)` o eliminar el wrapper si `setup-bootstrap` maneja toda la config del MCP server.

---

## IMPORTANTE — 4 tests fallidos

### 3. `normalizeProjectPath` no resuelve `..`

**Archivos**: `src/platform.mjs:15-19`, `tests/platform.test.mjs:13-15`

Test espera `C:\repo\docs\..\AGENTS.md` → `C:/repo/AGENTS.md` pero la impl solo reemplaza `\` con `/`.

El comentario dice "posix.normalize would collapse meaningful spaces" lo cual es incorrecto — `posix.normalize` no afecta espacios.

**Fix**:
```js
return posix.normalize(String(filePath).replace(/\\/g, '/'));
```

---

### 4. Test de `spawnBackground` stale

**Archivo**: `tests/platform.test.mjs:64`

Se cambio `shell: false` en la implementacion (correcto para portabilidad con array args), pero el test aun espera `shell: true` en Windows.

**Fix**: Actualizar test a `shell: false`.

---

### 5. Test de `bootstrapProjectInstall` stale

**Archivo**: `tests/setup-bootstrap.test.mjs:51-53`

Se cambio `setup-bootstrap.mjs` para escribir `.mcp.json` en project root en vez de `.claude/project-memory-context.json`. El test espera la ruta vieja.

**Fix**: Actualizar aserciones para verificar `.mcp.json`.

---

### 6. Tipos de simbolos C# incorrectos

**Archivo**: `src/extractors/regex-extractor.mjs:338,376`

El extractor mapea `record` → `class` (linea 338) y metodos usan `kind: 'function'` en vez de `kind: 'method'` (linea 376). El test espera `record` y `method`.

**Fix**: Preservar `record` como tipo distinto y usar `method` para miembros de clase.

---

## IMPORTANTE — Debilidades de diseno

### 7. `detectAgentType` duplicado

Definido en:
- `cli/status.mjs:17-22`
- `src/template-installer.mjs:12-19`

Consolidar en una sola export desde `src/platform.mjs`.

---

### 8. Paths hardcodeados en tests

**Archivo**: `tests/setup-bootstrap.test.mjs:109,145,170`

```js
cwd: 'C:/Users/aabad/Documents/CODE/ia/memory-context'
```

No funciona en otra maquina ni CI. Derivar de `import.meta.url`.

---

### 9. Falta seccion `scripts` en PMC package.json

No hay `test`, `lint` ni otros lifecycle scripts. Consumidores y contribuyentes no pueden correr tests sin conocer el runner interno.

**Fix**: Agregar:
```json
"scripts": {
  "test": "node --test tests/*.test.mjs"
}
```

---

### 10. `buildPlaceholders` hardcodea nombres de binarios

**Archivo**: `src/template-installer.mjs:30-33`

```js
PMC_BIN: 'pmc',
AGENT_MEMORY_CMD: 'agent-memory-mcp',
```

Si se invoca via `npx` o se instala con nombre diferente, los templates seran incorrectos. Considerar derivar de `package.json` bin field.

---

### 11. `stat` importado pero no usado

**Archivo**: `cli/sanitize.mjs` importa `stat` de `fs/promises` pero nunca se usa.

---

## MENOR — Observaciones de calidad

### 12. Template install casi duplicado

`installClaudeCode` y `installCursor` en `src/template-installer.mjs` son 90% identicas (solo difieren en file path y template name). Extraer helper compartido `installWithBlockMarker()`.

---

### 13. Parametro muerto `packageRoot`

**Archivo**: `src/plugin-config.mjs:1`

Acepta `packageRoot` pero nunca lo lee.

---

### 14. `install-state.json` vs `install.json`

- `cli/status.mjs:48` busca `install-state.json`
- `setup-bootstrap.mjs:120` escribe `install.json`
- `plugin/index.mjs:10-13` intenta ambos

Estandarizar en un solo filename.

---

### 15. `resolvePackageRoot` en template-installer

**Archivo**: `src/template-installer.mjs:23-26`

El fix de drive letter de Windows (`$1`) es correcto pero fragil. Considerar usar `fileURLToPath(import.meta.url)`.

---

## LO QUE ESTA BIEN

- `setup-bootstrap.mjs` reescrito a `.mcp.json` es la **decision correcta** — el estandar de la industria se mueve hacia `.mcp.json` en project root.
- `spawnBackground` con `shell: false` es mejor para portabilidad.
- El extractor C# con brace-depth tracking y container context es robusto — solo necesita fixes de mapeo de tipos.
- agent-memory 105/105 tests limpios, sin issues.
- `npm pack --dry-run` produce packages limpios para ambos (PMC: 89 files, 64.3 kB; agent-memory: 33 files, 37.1 kB).
- La jerarquia de resolucion de config (`.pmc` → `.opencode` → `.claude` → `.cursor`) es correcta.
- Separacion limpia entre bootstrap/portable wrapper en `cli/new-project.mjs` (41 lineas) vs `cli/bootstrap.mjs` (357 lineas).
- El sistema de templates con idempotencia via block markers (`<!-- pmc:init -->`) esta bien disenado.

---

## Resumen de acciones pre-publish

| # | Severidad | Item |
|---|-----------|------|
| 1 | CRITICO | Fix `file:` dependency en `package.json` |
| 2 | CRITICO | Fix o eliminar `mcp/agent-memory-wrapper.mjs` `require.resolve` |
| 3 | IMPORTANTE | Fix `normalizeProjectPath` para resolver `..` |
| 4 | IMPORTANTE | Actualizar test `spawnBackground` a `shell: false` |
| 5 | IMPORTANTE | Actualizar test bootstrap a `.mcp.json` |
| 6 | IMPORTANTE | Fix tipos C# `record`/`method` en extractor |
| 7 | IMPORTANTE | Consolidar `detectAgentType` duplicado |
| 8 | IMPORTANTE | Eliminar paths hardcodeados en tests |
| 9 | IMPORTANTE | Agregar `scripts` a PMC `package.json` |
