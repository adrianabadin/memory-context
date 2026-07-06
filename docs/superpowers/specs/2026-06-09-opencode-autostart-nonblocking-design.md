# OpenCode Autostart No Bloqueante — Design Spec

Date: 2026-06-09
Status: approved-design
Supersedes: `2026-06-08-watcher-lifecycle-management-design.md`, `2026-06-08-opencode-integration-fix-design.md` (absorbe ambas y las extiende)
Builds on: `2026-06-07-opencode-session-start-unification-design.md` (implementada en v0.5.0)

## Objetivo

Que OpenCode abra inmediatamente y deje trabajar al usuario sin esperar a que PMC resuelva nada, mientras PMC ejecuta de forma determinística y en background:

1. Flujo PMC determinístico — sin pasos manuales del modelo.
2. Todos los comandos PMC disponibles vía el paquete global `@aabadin/project-memory-context`.
3. Al iniciar sesión: `refresh-context`, verificación de enrich pendiente con lanzamiento automático, y un watcher de filesystem con debounce de 5 minutos que dispara refresh + enrich sobre lo modificado que quedó quieto.
4. Nada bloqueante: todo corre como procesos detached fuera del proceso de OpenCode.
5. Lo más cercano posible a 0 tokens: ninguna intervención del modelo en el arranque ni en el mantenimiento.

## Decisiones cerradas con el usuario

| Decisión | Resolución |
|----------|-----------|
| Backend de ejecución | Procesos Node detached (`spawnBackground`). PTY descartado para autostart: las herramientas `pty_*` son agent tools (cuestan tokens) y el plugin de OpenCode no puede invocarlas. PTY queda solo para comandos manuales del agente (spec pty-commands 06-07). |
| Refresh al inicio | Siempre, detached, en cada session-start. `refresh-context` es incremental por hash XXH3: sin cambios termina en segundos. **Debe correr desde el paquete global, no desde el repo local.** |
| Watcher vs hook `tool.execute.after` | Se consolida en el watcher FS únicamente. El hook `tool.execute.after` y el módulo `opencode-refresh-hook.mjs` se eliminan del plugin. |
| Semántica del debounce | Por archivo quieto: dispara cuando existe al menos un archivo pendiente sin cambios hace ≥5 min. La edición continua de un archivo no bloquea el refresh del resto. |
| Identidad del watcher | PID file por proyecto + verificación de `projectRoot` + heartbeat de 30s. |

## Principio rector

El plugin de OpenCode **nunca ejecuta trabajo, solo lo despacha**: lecturas rápidas de disco (3-4 JSON, milisegundos) y spawns detached (`child_process.spawn` con `detached: true, stdio: 'ignore'` + `unref()`). La llamada retorna de inmediato; los hijos corren independientes del proceso de OpenCode y le sobreviven. Overhead total de arranque: <100 ms, 0 tokens.

## Contexto: las 3 fallas actuales

Hoy nada de esto se dispara automáticamente en OpenCode porque:

1. **El plugin nunca se instala**: `installOpencode()` escribe comandos, skills y el bloque de autostart en `AGENTS.md`, pero nunca copia el plugin a `.opencode/plugins/`, que es de donde OpenCode auto-carga plugins.
2. **Interfaz incompatible**: `plugin/index.mjs` usa `export default` (OpenCode espera named exports) y un hook `config` que no existe en el sistema de eventos de OpenCode. Además `tool.execute.after` recibe `(input, output)`, no `(input)`.
3. **Sin lifecycle del watcher**: `cli/watch.mjs` corre en foreground, sin PID file, sin `--detach/--stop/--status`, con debounce global de 2 segundos. Sesiones múltiples acumulan watchers zombi duplicados.

## Diseño

### Capa 1 — Instalación del plugin y MCP config

`installOpencode()` (en `src/template-installer.mjs`) suma dos responsabilidades:

1. **Generar `.opencode/plugins/pmc.mjs`** desde un template (`templates/opencode/plugin.mjs`) con el placeholder `{{PLUGIN_IMPORT_PATH}}` resuelto en tiempo de instalación:
   - Repos consumidores: `@aabadin/project-memory-context` (paquete global/instalado).
   - Repo fuente (este repo): ruta relativa a `tools/project-memory-context/`.
   - Usa `import()` dinámico para evitar problemas de resolución ESM. Idempotente: reinstalar sobreescribe.
2. **Escribir la config MCP en `.opencode/opencode.json`** (crear si falta, merge idempotente de la sección `mcp` si existe). Reemplaza la inyección que hoy hace el hook `config` inexistente:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pmc-query": {
      "type": "local",
      "command": ["npx", "--yes", "--package", "@aabadin/project-memory-context", "pmc-query-server"],
      "enabled": true,
      "environment": { "PMC_PROJECT_ROOT": "{{PROJECT_ROOT}}" }
    },
    "pmc-agent-memory": {
      "type": "local",
      "command": ["npx", "-y", "@aabadin/agent-memory-mcp"],
      "enabled": true,
      "environment": { "MEMORY_DB_PATH": "{{MEMORY_DB_PATH}}" }
    }
  }
}
```

### Capa 2 — Plugin compatible con la API real de OpenCode

`plugin/index.mjs` se reescribe a:

```javascript
export const PMCPlugin = async ({ directory }) => {
  try {
    await runSessionStartRuntime(directory, { mode: 'opencode-plugin' });
  } catch {
    // PMC nunca debe impedir que OpenCode arranque.
  }
  return {};
};
```

- Named export `PMCPlugin` (convención OpenCode).
- Sin hook `config` — el startup corre durante la inicialización del plugin.
- **Sin `tool.execute.after`**: el watcher FS reemplaza al refresh hook. `src/opencode-refresh-hook.mjs` se elimina junto con sus tests; el estado `opencode-refresh-hook.json` queda obsoleto (se ignora, no se migra).

### Capa 3 — `session-start-runtime` ampliado

`runSessionStartRuntime` (ya existente, v0.5.0) suma tres lanzamientos, todos detached y tolerantes a fallo:

1. **`launchRefreshContext(projectRoot)`** — nuevo. Siempre lanza `refresh-context . --enrich` detached **desde el paquete global**: resuelve la raíz del paquete instalado (vía `createRequire`/`import.meta.resolve` desde el propio runtime, que ya vive en el paquete) y spawnea `process.execPath <pkgRoot>/cli/refresh-context.mjs . --enrich`. Nota Windows: `spawnBackground` usa `shell: false`, por lo que el shim global `pmc.cmd` no es spawneable directamente — `node + ruta absoluta del script del paquete global` es el equivalente determinístico del binario global. Ese proceso, al terminar el refresh, encadena el enrichment de lo que detectó stale (comportamiento existente de `--enrich`).
2. **`launchEnrichmentIfNeeded`** — existente, sin cambios de contrato. Cubre símbolos pendientes huérfanos de sesiones anteriores aunque no haya cambios de archivos.
3. **`launchWatcherIfNeeded(projectRoot)`** — nuevo. Si no hay watcher vivo (ver Capa 4), lanza `watch.mjs <projectRoot>` detached desde el paquete global.

**Invariante anti-duplicación**: `enrich-queue` debe tener guarda de instancia única por proyecto (estado `running` en `queue-state.json` con PID + heartbeat o verificación equivalente), porque puede ser lanzado concurrentemente por session-start, por el refresh detached y por el watcher. La implementación debe verificar la guarda existente y reforzarla si solo es un flag sin verificación de proceso vivo.

El snapshot `runs/session-start/latest.{json,md}` registra todas las decisiones de lanzamiento (qué se lanzó, qué ya corría, backend, warnings) para inspección posterior sin tokens.

### Capa 4 — Watcher con lifecycle y debounce por archivo quieto

`cli/watch.mjs` se reescribe sobre dos ejes:

**Lifecycle (PID + heartbeat):**

- PID file: `<projectRoot>/.planning/project-memory-context/state/watch.pid`:

```json
{
  "pid": 12345,
  "projectRoot": "C:/ruta/al/proyecto",
  "startedAt": "2026-06-09T12:00:00.000Z",
  "lastHeartbeat": "2026-06-09T12:05:30.000Z"
}
```

- **"Vivo" = tres condiciones**: (a) el PID existe y responde a `process.kill(pid, 0)`, (b) `projectRoot` del archivo coincide con el proyecto actual, (c) `lastHeartbeat` < 90 s (3× el tick). Cualquier otra combinación = stale → se elimina el archivo y se puede lanzar un watcher nuevo. Esto resuelve: dos proyectos simultáneos (cada uno tiene su PID file dentro de su árbol), reutilización de PID por el SO (un proceso ajeno nunca escribe heartbeats en este archivo) y watchers colgados (proceso vivo pero congelado → heartbeat viejo → restart).
- El watcher actualiza `lastHeartbeat` en cada tick de 30 s.
- Al arrancar: si detecta un watcher vivo, sale con mensaje. Si detecta stale, limpia y continúa. Escribe su PID file apenas monta `fs.watch`. Borra el PID file en SIGINT/SIGTERM/salida limpia.
- Flags nuevos:
  - `--detach`: se relanza a sí mismo vía `spawnBackground` y hace poll del PID file hasta 5 s para confirmar arranque; sale 0/1.
  - `--stop`: lee PID file, mata el proceso (`process.kill`), borra el archivo. PID no vivo → "no running watcher", exit 0.
  - `--status`: imprime estado (vivo/stale/ausente, pid, heartbeat, pendientes).
- Invariante: **máximo un watcher por proyecto**.

**Debounce de 5 minutos por archivo quieto:**

- El watcher mantiene un mapa `archivo → timestampÚltimoCambio`, persistido en `state/watch-pending.json` (sobrevive reinicios: al arrancar, los pendientes heredados se evalúan con la regla normal).
- `fs.watch` recursivo + filtro `shouldWatch` (existente) alimentan el mapa. Cambios dentro de `.planning/` se ignoran (evita auto-disparos por los propios artefactos de PMC).
- Tick cada 30 s: si existe ≥1 archivo pendiente con últimoCambio hace ≥5 min → dispara `refresh-context . --enrich` (detached, desde el paquete global) y remueve del mapa los archivos que estaban quietos. Los archivos aún calientes permanecen y se recapturan en ticks siguientes.
- `refresh-context` es incremental por hash de archivo, así que procesará exactamente lo que cambió y quedó estable; si un archivo caliente cambió de nuevo durante el refresh, su hash difiere y se recaptura en el próximo ciclo. No se requiere scoping de archivos en la invocación.
- Guarda de no-solapamiento: el watcher no dispara un refresh nuevo mientras el anterior sigue corriendo (verifica proceso o flag con verificación de vida); si al terminar quedaron pendientes quietos, el próximo tick dispara.

### Requisito 2 — comandos vía paquete global

- Los templates de comandos slash ya resuelven `{{PMC_BIN}}` → `pmc` (binario global) en tiempo de instalación. Sin cambios.
- Los spawns internos (plugin, session-start, watcher) usan `node + ruta absoluta de script dentro del paquete global resuelto` — equivalente determinístico del binario global, robusto ante el problema de shims `.cmd` en Windows con `shell: false`.
- En el repo fuente, la resolución cae a las rutas locales `tools/project-memory-context/` (mismo mecanismo de resolución, distinta raíz).

### Errores y degradación

- Cualquier lanzamiento fallido → warning en el snapshot, nunca excepción hacia OpenCode.
- PID file ilegible/corrupto → se trata como ausente.
- Watcher muerto → el próximo session-start lo relanza vía `launchWatcherIfNeeded`.
- Escritura de PID/heartbeat falla → log warning, el watcher sigue funcionando (solo pierde trackeabilidad).
- `--detach` sin confirmación en 5 s → exit 1 con mensaje.
- Snapshot no escribible → warning en el resultado, startup continúa.

## Archivos a crear/modificar

| Archivo | Acción | Capa |
|---------|--------|------|
| `templates/opencode/plugin.mjs` | Crear | 1 |
| `src/template-installer.mjs` | Modificar — instala plugin + escribe MCP en `.opencode/opencode.json` | 1 |
| `plugin/index.mjs` | Reescribir — named export, sin `config`, sin refresh hook | 2 |
| `src/opencode-refresh-hook.mjs` | Eliminar (+ tests) | 2 |
| `src/session-start-runtime.mjs` | Modificar — `launchRefreshContext`, `launchWatcherIfNeeded`, resolución de paquete global | 3 |
| `src/watcher-lifecycle.mjs` | Crear — PID file, heartbeat, stale detection, helpers cross-platform | 4 |
| `cli/watch.mjs` | Reescribir — flags, lifecycle, debounce por archivo quieto, tick 30 s | 4 |
| `cli/enrich-queue.mjs` | Verificar/reforzar guarda de instancia única | 3 |
| `tests/watcher-lifecycle.test.mjs` | Crear | 4 |
| `tests/watch-debounce.test.mjs` | Crear | 4 |
| `tests/session-start.test.mjs` | Modificar | 3 |
| `tests/plugin.test.mjs` | Reescribir | 2 |
| `tests/template-installer.test.mjs` | Modificar | 1 |
| `templates/opencode/autostart-snippet.md` | Modificar — describir plugin auto-cargado + watcher automático | Docs |
| `AGENTS.md` (raíz del repo) | Modificar — alinear con el snippet nuevo | Docs |
| `README.md` (paquete) | Modificar — flags del watcher, modelo de startup OpenCode | Docs |

## Testing

- **Unit** (node:test, timers/spawn mockeados): lectura/escritura/staleness del PID file (incl. mismatch de `projectRoot` y heartbeat vencido), debounce por archivo (archivo caliente no bloquea al quieto), `--detach` poll, `--stop`, generación del template del plugin con import paths correctos, merge idempotente de `opencode.json`, guarda de instancia única de enrich-queue, `launchRefreshContext`/`launchWatcherIfNeeded` en el runtime.
- **Integración**: dispatch de `watch --detach/--stop/--status`; `runSessionStartRuntime` completo sobre repo temporal verificando snapshot + decisiones de lanzamiento; plugin `PMCPlugin` no lanza excepción cuando el runtime falla.
- **Manual**: instalar en un repo consumidor scratch, abrir OpenCode, verificar que abre sin demora y que `watch --status` + snapshot reflejan los procesos lanzados.

## Trade-offs aceptados

- **Sin inyección de contexto en el chat de OpenCode**: el snapshot en disco es el punto de inspección (heredado del diseño 06-07). El único paso que requiere modelo sigue siendo el drain del subagent queue, y solo si `subagentQueue.pending > 0`.
- **Detached es menos observable que PTY**: aceptado explícitamente — el usuario priorizó no-bloqueante y 0 tokens por sobre observabilidad de procesos. Los estados en disco (`queue-state.json`, `watch.pid`, snapshot) son el mecanismo de observación.
- **Eliminar el refresh hook pierde la señal directa de "el agente editó X"**: aceptado — el watcher FS ve esas mismas escrituras en disco con cobertura superior (también ediciones humanas y git).

## Criterios de éxito

- OpenCode abre sin demora perceptible con PMC instalado (plugin <100 ms antes de retornar).
- El plugin es realmente cargado por OpenCode (named export, en `.opencode/plugins/`).
- En cada inicio: refresh-context corre detached desde el paquete global, el enrich pendiente se lanza solo, y queda exactamente un watcher vivo por proyecto.
- Editar un archivo y dejarlo quieto 5 min produce refresh + enrich automáticos sin tokens, aunque otro archivo siga editándose.
- Dos proyectos abiertos en simultáneo mantienen watchers independientes sin interferencia.
- Cero llamadas del modelo en todo el flujo de arranque y mantenimiento.
