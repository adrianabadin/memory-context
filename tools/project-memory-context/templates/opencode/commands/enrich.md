---
name: enrich
description: "Launch enrichment for all pending symbols using size-sorted split strategy: bottom half goes to Ollama (small symbols), top half goes to subagents (large symbols, 1 per call, 3 in parallel). They run simultaneously and iterate until done."
argument-hint: ""
allowed-tools:
  - Bash
---

# Enrichment — Size-Split Parallel Strategy

**Strategy:** Sort all pending symbols by line count (ascending). Bottom half → Ollama (sequential, small symbols). Top half → subagents (parallel, 1 symbol per call, 3 in parallel). Both run simultaneously. After each wave, re-split and inject again — iterating until all symbols are processed.

Symbols injected into the subagent queue are marked `subagent-queued` in `worklist.json` so Ollama skips them automatically.

---

## Step 1 — Check current state

Run `{{PMC_BIN}} enrich-status` first.

- `.state` is `running` AND `.worklist.pending > 0` → Ollama already active. Skip to **Step 3**.
- `.state` is `finished` AND `.worklist.pending` is 0 AND `.subagentQueue.pending` is 0 → nothing to do. Report and stop.
- `.state` is `finished` AND `.subagentQueue.pending > 0` → skip to **Step 3**.
- Otherwise → proceed to **Step 2**.

---

## Step 2 — Launch Ollama + inject large-symbol subagents

### 2a — Launch Ollama

Report: "PMC: N symbols pending — Ollama takes the small half, subagents take the large half…"

Launch via **Bash `run_in_background: true`**:

```bash
{{PMC_BIN}} enrich .
```

⚠️ Never use `PowerShell Start-Process -WindowStyle Hidden` — crashes silently, leaves stalled queue.

### 2b — Inject large symbols into subagent queue

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
const batchSize=Math.min(Math.max(half,3),12);
const batch=pending.slice(-batchSize);
const newEntries=batch.map(s=>{
  let code='',imports='(none)';
  try{
    const lines=fs.readFileSync(path.join(root,s.filePath),'utf8').split('\n');
    code=lines.slice(s.range.startLine-1,s.range.endLine).join('\n');
    const imp=lines.slice(0,Math.min(30,lines.length)).filter(l=>l.trim().startsWith('import ')||l.trim().startsWith('const {'));
    if(imp.length)imports=imp.join('\n');
  }catch(e){code='[file not found]';}
  const prompt=[
    'Analyze this code symbol and return a structured explanation.',
    'Return ONLY the explanation — no preamble, no markdown fences.',
    '',
    'Symbol: '+s.name,'Kind: '+s.kind,'Language: '+s.language,
    'Location: '+s.filePath+':'+(s.range?.startLine??0)+'-'+(s.range?.endLine??0),
    '','Context (imports):',imports,'','Code:',code,'',
    'Return:','- responsibility','- primary inputs','- output','- immediate dependencies','- role in module',
  ].join('\n');
  return{id:crypto.randomUUID(),symbolKey:s.symbolKey,name:s.name,filePath:s.filePath,language:s.language,kind:s.kind,
    tokenCount:Math.ceil(prompt.length/4),prompt,status:'pending',memoryId:null,
    queuedAt:new Date().toISOString(),claimedAt:null,doneAt:null,errorAt:null,error:null};
});
sq.entries.push(...newEntries);
fs.writeFileSync(sqPath,JSON.stringify(sq,null,2));
const claimedKeys=new Set(batch.map(s=>s.symbolKey));
for(const[k,v]of Object.entries(wl)){if(claimedKeys.has(v.symbolKey))wl[k].status='subagent-queued';}
fs.writeFileSync(wlPath,JSON.stringify(wl,null,2));
console.log(JSON.stringify(newEntries.map(e=>({id:e.id,name:e.name,symbolKey:e.symbolKey,prompt:e.prompt}))));
" 2>&1
```

**Dispatch first 3 subagents in parallel** for the first 3 entries:
```
You are enriching a code symbol for a project memory index.
Return ONLY the structured explanation — no preamble, no markdown fences.

<entry.prompt>
```

When each returns, apply:
```bash
cat > /tmp/enrich-<entry.id>.txt << 'EOF'
<subagent plain text response>
EOF
{{PMC_BIN}} subagent-apply . --entry-id <entry.id> --content-file /tmp/enrich-<entry.id>.txt
rm /tmp/enrich-<entry.id>.txt
```

---

## Step 3 — Watchdog + iterative re-injection loop

Run every **≥120 seconds**. Track `relaunchCounter` (cap: 3) and `inProgressSubagents` set.

1. Apply any completed subagents (write to temp file → `{{PMC_BIN}} subagent-apply` → delete).
2. **Crash check**: if `.state` is `stalled`/`failed` AND `.worklist.pending > 0` → relaunch (max 3x).
3. **Re-inject**: if `inProgressSubagents` < 3 → re-run injection script, dispatch up to 3 new subagents.
4. **Exit** when `.state` is `finished` + `.subagentQueue.pending` is `0` + no in-progress subagents.

---

## Step 4 — Report success

Report counts (Ollama enriched, subagents enriched, errors). Suggest `/sync-context`.
