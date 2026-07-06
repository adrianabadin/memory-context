# Design: pmc-session-capture-plugin

## Technical Approach

Implement synchronous JSONL-appending hooks in the OpenCode plugin to capture events with zero agent token cost. A detached background `capture-drain.mjs` process consumes the JSONL queue and writes rows using a specialized `createLedgerOnlyStore` factory over `agent-memory-mcp`, entirely bypassing the embedding model to avoid startup cost and direct DB access fragmentation.

## Architecture Decisions

### Decision: Hook execution
**Choice**: Synchronous JSONL appending using `fs.appendFileSync`.
**Alternatives considered**: Calling MCP `storeSessionPrompt` tool directly, shelling out to a CLI, posting to an HTTP server.
**Rationale**: OpenCode UI thread blocks on hooks. HTTP server is too complex; CLI spawn is too slow. JSONL append is fast, atomic, and safe.

### Decision: Drainer process
**Choice**: Detached `capture-drain.mjs` spawned during plugin load, processing max 100 entries per batch.
**Alternatives considered**: Cron job, agent tool call, integrating drainer loop inside OpenCode process.
**Rationale**: Keeps OpenCode lightweight. A detached worker can safely use `agent-memory-mcp` with WAL SQLite retries.

### Decision: DB writes
**Choice**: New `createLedgerOnlyStore` factory in `agent-memory-mcp/src/compose.ts`.
**Alternatives considered**: Direct `better-sqlite3` execution inside the drainer.
**Rationale**: Bypassing the MCP package creates schema drift risk. The factory instantiates `SqliteMemoryStore` with a dummy embedder, safely reusing the core ledger implementations.

## Data Flow

    [OpenCode Agent]
          │ (hooks: chat.message, tool.execute.after)
          ▼
    [session-capture.mjs] (Synchronous Redact & Append)
          │
          ▼
    [.opencode/pmc-capture-queue.jsonl]
          │
          ▼
    [capture-drain.mjs] (Detached Worker, batches of 100)
          │
          ▼
    [createLedgerOnlyStore] (agent-memory-mcp)
          │
          ▼
    [.planning/project-memory-context/memory-db/memory.db]

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `plugin/index.mjs` | Modify | Return hooks and spawn background drainer |
| `src/session-capture.mjs` | Create | `buildHooks`, `appendToQueue`, `sanitize` logic |
| `cli/capture-drain.mjs` | Create | Queue consumer, writes to SQLite with exponential backoff |
| `agent-memory-mcp/src/compose.ts` | Modify | Add `createLedgerOnlyStore` and `LedgerStore` type |

## Interfaces / Contracts

**1. OpenCode plugin hook shapes (`plugin/index.mjs`)**
```javascript
export const PMCPlugin = async (input) => {
  // input: { directory, sessionId, __testOverrides }
  const projectRoot = input.directory ?? process.cwd();
  return {
    hooks: {
      'chat.message': async ({ input, output }) => {
         // input.sessionID, output.parts[0].text, output.role
      },
      'tool.execute.after': async ({ input, output }) => {
         // input.tool, input.sessionID, output (result string)
      }
    }
  };
};
```

**2. JSONL queue entry schema**
```typescript
type CaptureEntry =
  | { type: 'prompt'; ts: number; sessionId: string; projectId: string; content: string; role: 'user' | 'assistant' }
  | { type: 'tool_call'; ts: number; sessionId: string; projectId: string; toolName: string; argsSafe: string; resultSummary: string; durationMs: number; importance: 'high' | 'normal' | 'low' }
```

**3. `session-capture.mjs` module design**
```javascript
export function buildHooks(sessionId, projectId, queuePath) { /* ... */ }
export function appendToQueue(queuePath, entry) { 
  // Sync fs.appendFileSync. 
  // If stat size > 1MB, rename to pmc-capture-queue.{ts}.jsonl
}
export function sanitizeContent(text) { 
  return text.replace(/<private>[\s\S]*?<\/private>/g, '[REDACTED]'); 
}
export function sanitizeArgs(args) { 
  // Regex mask bearer tokens, passwords, API keys.
}
```

**4. `capture-drain.mjs` CLI design**
Entry: `pmc capture-drain <projectRoot>`
Uses lockfile `.opencode/pmc-capture-drain.lock`.
Loops over `pmc-capture-queue*.jsonl`, batches 100 entries. 
MUST retry transient SQLite write failures up to 3 times with exponential backoff (100ms, 200ms, 400ms).
Deletes processed files or rewrites with remaining lines. 
Exits if queue is empty and `mtime` hasn't changed for 30s.

**5. `createLedgerOnlyStore` (`agent-memory-mcp/src/compose.ts`)**
```typescript
export interface LedgerStore {
  initialize(): Promise<void>;
  storeSessionPrompt(sessionId: string, rawPrompt: string): Promise<SessionPrompt>;
  storeSessionResponse(sessionId: string, promptId: string, fullResponse: string): Promise<SessionResponse>;
  storeSessionToolCall(params: any): Promise<SessionToolCall>;
  setSessionContext(sessionId: string, projectId: string): void;
  getSessionContext(): { sessionId: string; projectId: string } | null;
}

const dummyEmbedder: Embedder = {
  initialize: async () => {},
  embed: async () => [],
  embedBatch: async () => [],
  dimensions: () => 1024,
};

export async function createLedgerOnlyStore(dbPath: string): Promise<LedgerStore> {
  const { SqliteMemoryStore } = await import('./sqlite-store.js');
  // Match path convention: append .db to the base path
  const sqlitePath = `${dbPath}.db`;
  const store = new SqliteMemoryStore(sqlitePath, dummyEmbedder);
  await store.initialize();
  
  // Enforce busy_timeout=5000ms after opening the DB for capture-pipeline R2
  (store as any).db.exec('PRAGMA busy_timeout = 5000');
  
  return store as unknown as LedgerStore; // Exposing only required methods
}
```

**6. Plugin template update**
`tools/project-memory-context/plugin/index.mjs` is updated to return `{ hooks: buildHooks(...) }`. The auto-generated `templates/opencode/plugins/pmc.mjs` template (`template-installer.mjs`) already does `return await mod.PMCPlugin(input);` at line 7 — so hooks propagate automatically when `plugin/index.mjs` returns `{ hooks: ... }`. No changes to the install string itself are required, just the package implementation.

**7. Drainer launch from plugin startup**
In `plugin/index.mjs`:
```javascript
import { spawnBackground } from '../src/platform.mjs';
import { join } from 'node:path';

// Launch fire-and-forget drainer
spawnBackground(process.execPath, [join(__dirname, '../cli/capture-drain.mjs'), projectRoot], { cwd: projectRoot });
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Hooks logic | Mock `fs` and verify queue append contents + redaction. |
| Integration | Drainer | Write temp queue file, run `capture-drain`, verify SQLite rows. |
| E2E | Plugin | Mock OpenCode load, trigger `chat.message`, verify DB write asynchronously. |

## Migration / Rollout

No migration required.
