---
name: enrich
description: "Launch batch semantic enrichment for all pending symbols using size-sorted split strategy: worklist is sorted ascending by line count, bottom half goes to Ollama (small/cheap), top half goes to subagents (large/expensive, batched 3 symbols per call). They run simultaneously. After each subagent batch, remaining pending are re-split and the next large batch is injected. Use when the user asks to enrich, index, analyze, or process pending symbols."
allowed-tools: Bash Read Write Agent
---

# Batch Enrichment — Size-Split Parallel Strategy

**Strategy:** Sort all pending symbols by line count (ascending). Bottom half → Ollama (sequential, small symbols). Top half → subagents (parallel, **3 symbols per subagent call**, 3 calls in parallel = 9 symbols per wave). Both run simultaneously. After each wave, re-split and inject again — iterating until all symbols are processed.

Symbols injected into the subagent queue are marked `subagent-queued` in `worklist.json` so Ollama skips them automatically.

---

## Step 1 — Check current state

Run `pmc enrich-status` first.

- `.state` is `running` AND `.worklist.pending > 0` → Ollama already active. Skip to **Step 3** (inject subagents alongside it).
- `.state` is `finished` AND `.worklist.pending` is 0 AND `.subagentQueue.pending` is 0 → nothing to do. Report and stop.
- `.state` is `finished` AND `.subagentQueue.pending > 0` → skip to **Step 3** (drain subagents only).
- Otherwise → proceed to **Step 2**.

---

## Step 2 — Launch Ollama + inject large-symbol batches

### 2a — Report and launch Ollama

Report to the user: "PMC: N symbols pending — Ollama takes the small half, subagents take the large half (batched 3/call)…"

Launch via **Bash `run_in_background: true`**:

```bash
pmc enrich .
```

⚠️ Never use `PowerShell Start-Process -WindowStyle Hidden` — crashes silently, leaves stalled queue.

### 2b — Inject large-symbol batches into subagent queue

Run the injection script below. It:
1. Finds all `pending`/`stale` symbols not already claimed
2. Sorts ascending by line count (shortest first)
3. Takes the **top half** (largest symbols) — capped at 36 total (= 12 batches × 3), minimum 3
4. **Groups into batches of 3** — each batch becomes one subagent queue entry
5. Builds a combined prompt per batch asking for a JSON array response
6. Marks those symbols as `subagent-queued` in worklist so Ollama skips them
7. Outputs the batch entries as JSON

```bash
node -e "
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=process.cwd();
const wlPath=path.join(root,'.planning/project-memory-context/enrichment/worklist.json');
const sqPath=path.join(root,'.planning/project-memory-context/enrichment/subagent-queue.json');
const wl=JSON.parse(fs.readFileSync(wlPath,'utf8'));
const sq=JSON.parse(fs.readFileSync(sqPath,'utf8'));
const alreadyClaimed=new Set(sq.entries.filter(e=>e.status==='pending'||e.status==='in_progress').map(e=>e.symbolKey));
const pending=Object.entries(wl)
  .filter(([k,v])=>(v.status==='pending'||v.status==='stale')&&!alreadyClaimed.has(v.symbolKey))
  .map(([k,v])=>({key:k,...v,lineCount:(v.range?.endLine??0)-(v.range?.startLine??0)}))
  .sort((a,b)=>a.lineCount-b.lineCount);
if(!pending.length){console.log('[]');process.exit(0);}
const half=Math.ceil(pending.length/2);
const take=Math.min(Math.max(half,3),36);
const symbols=pending.slice(-take);
// Group into batches of 3
const batches=[];
for(let i=0;i<symbols.length;i+=3) batches.push(symbols.slice(i,i+3));
const newEntries=batches.map(batch=>{
  const batchId=crypto.randomUUID();
  const items=batch.map(s=>{
    let code='',imports='(none)';
    try{
      const lines=fs.readFileSync(path.join(root,s.filePath),'utf8').split('\n');
      code=lines.slice(s.range.startLine-1,s.range.endLine).join('\n');
      const imp=lines.slice(0,Math.min(30,lines.length)).filter(l=>l.trim().startsWith('import ')||l.trim().startsWith('const {'));
      if(imp.length)imports=imp.join('\n');
    }catch(e){code='[file not found]';}
    return{id:crypto.randomUUID(),symbolKey:s.symbolKey,name:s.name,filePath:s.filePath,language:s.language,kind:s.kind,code,imports,startLine:s.range?.startLine??0,endLine:s.range?.endLine??0};
  });
  const prompt=[
    'You are enriching code symbols for a project memory index.',
    'Return ONLY a valid JSON array with exactly '+items.length+' objects — no preamble, no markdown fences, no code blocks.',
    'Each object must have exactly two fields: \"id\" (string, the symbol id provided) and \"content\" (string, the structured explanation).',
    '',
    ...items.flatMap((item,i)=>[
      '--- Symbol '+(i+1)+' [id: '+item.id+'] ---',
      'Symbol: '+item.name,
      'Kind: '+item.kind,
      'Language: '+item.language,
      'Location: '+item.filePath+':'+item.startLine+'-'+item.endLine,
      '',
      'Context (imports):',
      item.imports,
      '',
      'Code:',
      item.code,
      '',
      'Return for this symbol:',
      '- responsibility',
      '- primary inputs',
      '- output',
      '- immediate dependencies',
      '- role in module',
      '',
    ]),
    'Return as JSON array (no other text):',
    '[{"id":"'+items[0].id+'","content":"..."},'+items.slice(1).map(it=>'{"id":"'+it.id+'","content":"..."}').join(',')+']',
  ].join('\n');
  return{
    id:batchId,
    batchItems:items.map(({id,symbolKey,name})=>({id,symbolKey,name})),
    symbolKey:'batch:'+items.map(i=>i.name).join(','),
    name:'batch('+items.map(i=>i.name).join(',')+') x'+items.length,
    filePath:'(batch)',language:'mixed',kind:'batch',
    tokenCount:Math.ceil(prompt.length/4),
    prompt,status:'pending',memoryId:null,
    queuedAt:new Date().toISOString(),claimedAt:null,doneAt:null,errorAt:null,error:null,
  };
});
sq.entries.push(...newEntries);
fs.writeFileSync(sqPath,JSON.stringify(sq,null,2));
const claimedKeys=new Set(symbols.map(s=>s.symbolKey));
for(const[k,v]of Object.entries(wl)){if(claimedKeys.has(v.symbolKey))wl[k].status='subagent-queued';}
fs.writeFileSync(wlPath,JSON.stringify(wl,null,2));
console.log(JSON.stringify(newEntries.map(e=>({id:e.id,name:e.name,batchItems:e.batchItems,prompt:e.prompt}))));
" 2>&1
```

Parse the JSON output — each object has `{ id, name, batchItems: [{id, symbolKey, name}], prompt }`.

**Dispatch first 3 batch-subagents in parallel** (`run_in_background: true` per Agent call):

For each of the first 3 batch entries:
```
You are enriching code symbols for a project memory index.
Return ONLY a valid JSON array — no preamble, no markdown fences, no code blocks.

<entry.prompt>
```

When each subagent returns, write the JSON array to a temp file and apply the whole batch in one call:
```bash
cat > /tmp/batch-<entry.id>.json << 'BATCH_EOF'
<subagent JSON array response>
BATCH_EOF
pmc subagent-apply . --entry-id <entry.id> --content-file /tmp/batch-<entry.id>.json
rm /tmp/batch-<entry.id>.json
```

---

## Step 3 — Watchdog + iterative re-injection loop

Run every **≥120 seconds**. Track `relaunchCounter` (cap: 3) and `inProgressSubagents` set.

**Each iteration:**

### 3a — Apply completed subagents

For each subagent in `inProgressSubagents` that has returned: parse the JSON array response, apply each symbol with `pmc subagent-apply`, remove from set.

### 3b — Crash check (Ollama)

Run `pmc enrich-status`. If `.state` is `stalled` or `failed` AND `.worklist.pending > 0`:
- Increment `relaunchCounter`.
- If ≤ 3: relaunch `pmc enrich .` (background); report "PMC enrichment crashed — relaunched (N/3)."
- If > 3: stop and report "PMC enrichment crashed 3 times. Run `/pmc-doctor`."

### 3c — Re-inject next large batches

After applying completed subagents, if `inProgressSubagents` has < 3 in-flight:

Re-run the injection script from Step 2b. If it outputs entries:
- Dispatch up to 3 new batch-subagents in parallel (filling available slots).
- Add their handles to `inProgressSubagents`.

### 3d — Exit condition

Stop when ALL of:
- `.state` is `finished`
- `.subagentQueue.pending` is `0`
- `inProgressSubagents` is empty

---

## Step 4 — Report success

```
Enrichment complete:
  - Ollama enriched: N symbols (small)
  - Subagents enriched: M symbols (large, batched 3/call)
  - Errors: X (run /retry-errors if > 0)
```

Suggest: "Run `/sync-context` to persist all new memories to agent-memory."
