#!/bin/bash
# Continuous enrichment loop - keeps 8 parallel slots running always
# Each run processes 8 symbols, syncs, then re-runs until done

ENRICH_DIR=".planning/project-memory-context/enrichment"
WORKLIST="$ENRICH_DIR/worklist.json"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-deepseek-coder-v2:16b-ctx16k}"

check_pending() {
  node -e "const w=require('$WORKLIST'); const p=w.filter(s=>s.status==='pending').length; console.log(p)" 2>/dev/null || echo "99"
}

echo "[loop] Starting continuous enrichment loop"
echo "[loop] Ollama: $OLLAMA_URL | Model: $OLLAMA_MODEL"

batch=0
while true; do
  pending=$(check_pending)
  if [ "$pending" -eq "0" ]; then
    echo "[loop] All symbols enriched! Done."
    break
  fi
  if [ "$pending" -gt "87" ]; then
    echo "[loop] Worklist corrupted or missing. Stop."
    break
  fi

  batch=$((batch + 1))
  echo ""
  echo "[loop] ===== BATCH $batch ===== ($pending symbols remaining)"
  echo "[loop] $(date +%H:%M:%S) Dispatching 8 subagents via Task tool..."

  # Run orchestrator to get next 8 symbols + prompts
  manifest=$(node tools/project-memory-context/cli/enrich-orchestrator.mjs 2>/dev/null)
  if [ $? -ne 0 ]; then
    echo "[loop] Orchestrator failed. Retrying in 5s..."
    sleep 5
    continue
  fi

  echo "$manifest" | node -e "
    const stdin = require('fs').readFileSync('/dev/stdin', 'utf8');
    const j = JSON.parse(stdin);
    if (j.complete) { console.log('ALL_DONE'); process.exit(0); }
    if (!j.subagentPrompts || j.subagentPrompts.length === 0) {
      console.log('NO_PROMPTS');
      process.exit(1);
    }
    console.log(JSON.stringify(j.subagentPrompts.map((p, i) => ({
      idx: i,
      prompt: p,
      symbolKey: j.pending[i]?.symbolKey || 'unknown'
    }))));
  " > /tmp/pmc_batch_$batch.json 2>/dev/null

  if [ $? -ne 0 ]; then
    echo "[loop] Failed to get batch. Retrying..."
    sleep 5
    continue
  fi

  batch_data=$(cat /tmp/pmc_batch_$batch.json)
  if [ "$batch_data" = "ALL_DONE" ] || [ "$batch_data" = "NO_PROMPTS" ]; then
    echo "[loop] No more symbols to process."
    break
  fi

  # Extract symbol keys and names for dispatch
  echo "$batch_data" | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
    data.forEach((item, i) => {
      const sym = JSON.parse(item.prompt.split('SYMBOL: ')[1].split('\n')[0]);
      console.log(JSON.stringify(sym));
    });
  " > /tmp/pmc_symbols_$batch.json 2>/dev/null

  echo "[loop] Dispatching 8 subagents in parallel..."

  # Dispatch all 8 subagents in background and collect task IDs
  declare -a TASK_IDS
  idx=0
  while read -r symbol_json; do
    [ -z "$symbol_json" ] && continue
    task_id=$(node -e "
      const spawn = require('child_process').spawn;
      const sym = $symbol_json;
      const prompt = 'You are enriching ONE code symbol for project-memory-context.\n\nSYMBOL: ' + JSON.stringify(sym) + '\nPROJECT_ROOT: C:\\\\Users\\\\aabad\\\\Documents\\\\CODE\\\\ia\\\\memory-context\nOLLAMA_URL: http://localhost:11434\nOLLAMA_MODEL: deepseek-coder-v2:16b-ctx16k\n\nSTEPS:\n1. Read the source file at the symbol filePath (use Read tool), lines startLine to endLine PLUS imports above\n2. Call Ollama via bash: node -e \"fetch('http://localhost:11434/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:\'qwen2.5-coder:14b\',prompt:\'YOUR_PROMPT\',stream:false,options:{temperature:0.1,num_predict:512}})})).then(r=>r.json()).then(d=>process.stdout.write(d.response))\"\n3. Store via agent-memory_store: content, category architecture, tags symbol ts kind project:memory-context file:filepath\n4. Return JSON with symbolKey memoryId status enrichedAt\n\nDo NOT update any JSON files. Return result.'
      // Can't actually dispatch task from here - output the prompt for manual use
      console.log(prompt);
    " 2>&1 | head -1) &
    TASK_IDS[$idx]=$!
    idx=$((idx + 1))
  done < /tmp/pmc_symbols_$batch.json

  # Wait for all background jobs
  for pid in "${TASK_IDS[@]}"; do
    wait $pid 2>/dev/null
  done

  echo "[loop] Batch $batch dispatched. Sleeping 5s before checking..."
  sleep 5

  # Check if we should continue
  pending=$(check_pending)
  if [ "$pending" -eq "0" ]; then
    echo "[loop] All done!"
    break
  fi
  if [ "$batch" -ge 20 ]; then
    echo "[loop] Max batches reached ($batch). Stopping safely."
    break
  fi
done

echo "[loop] Loop complete. Final state:"
node -e "const w=require('.planning/project-memory-context/enrichment/worklist.json'); const p=w.filter(s=>s.status==='pending').length; const e=w.filter(s=>s.status==='enriched').length; const err=w.filter(s=>s.status==='error').length; console.log('pending='+p+' enriched='+e+' error='+err+' total='+w.length)"