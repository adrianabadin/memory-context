---
name: enrich-ondemand
description: "Enrich a specific symbol on the fly using the agent's own LLM. Use when a single symbol is needed and hasn't been enriched yet, or when the user requests targeted enrichment of a specific function, class, or module."
---

# On-Demand Enrichment — Single Symbol

Enrich a **specific target symbol** directly using your language model capabilities, without launching the batch CLI. Use this when:
- A symbol the user needs hasn't been enriched yet
- The user requests targeted enrichment of a specific function/class/module
- Only 1–5 symbols need processing (for large batches, use `/enrich` instead)

## Execution

### Step 1 — Identify the target symbol

The user will specify a symbol name, file path, or both. If ambiguous, read the worklist to find matching entries.

### Step 2 — Read the worklist

Read `.planning/project-memory-context/enrichment/worklist.json` and find the entry matching the target. The entry contains:
- `symbolKey` — unique identifier
- `filePath` — source file path
- `startLine` / `endLine` — line range of the symbol
- `status` — should be `"pending"` or `"stale"`

If the symbol is already `"enriched"`, tell the user and stop.

### Step 3 — Read the source code

Read the file at `filePath`, extracting the code from `startLine` to `endLine`.

### Step 4 — Generate the semantic enrichment

Use your LLM capabilities to produce a high-quality semantic explanation containing:

- **Responsibility**: A concise explanation of what the symbol does.
- **Primary Inputs**: Its inputs, arguments, or parameters.
- **Output**: What it returns, emits, or produces.
- **Immediate Dependencies**: Other symbols/libraries it imports or calls.
- **Role in Module**: Its architectural purpose and role within its module/package.

### Step 5 — Write the memory file

Compute `safeKey` by replacing any non-alphanumeric/non-dash/non-underscore characters in `symbolKey` with `_`.

Write to `.planning/project-memory-context/enrichment/<safeKey>.memory.json`:

```json
{
  "content": "<markdown explanation>",
  "category": "architecture",
  "tags": ["symbol", "<language>", "<kind>", "project:<projectSlug>", "file:<filePath>"]
}
```

### Step 6 — Update the worklist

In `.planning/project-memory-context/enrichment/worklist.json`, update the matching entry:
- Set `status` to `"enriched"`
- Set `memoryId` to `"queue-<safeKey>"`
- Set `enrichedAt` to the current ISO timestamp

### Step 7 — Append to sync-manifest

Add a new entry to `.planning/project-memory-context/enrichment/sync-manifest.json` → `entries` array:

```json
{
  "id": "<generate a random UUID>",
  "action": "upsert",
  "key_tag": "key:symbol:<safeKey>",
  "content": "## <symbolName>\n\n<markdown explanation>",
  "category": "architecture",
  "tags": ["symbol", "<language>", "<kind>", "project:<projectSlug>", "file:<filePath>", "enriched-by-agent"],
  "status": "pending",
  "source": "enrich-ondemand",
  "symbolKey": "<symbolKey>",
  "addedAt": "<current ISO timestamp>"
}
```

### Step 8 — Report and suggest sync

Tell the user: "Enriched `<symbolName>` — run `pmc sync-context` to persist to agent memory."

## Success criteria

- Target symbol's worklist entry updated to `status: "enriched"`
- Memory file written to enrichment directory
- Sync-manifest entry appended with `status: "pending"`
