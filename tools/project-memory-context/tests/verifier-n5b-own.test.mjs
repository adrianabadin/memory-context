import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire,syncBuiltinESMExports} from 'node:module';
const target=process.env.PROBE_TARGET || resolve(import.meta.dirname,'..');
const load=p=>import(pathToFileURL(join(target,p)));
const q=await load('cli/enrich-queue.mjs');
const {main:apply}=await load('cli/subagent-apply.mjs');
const {appendSubagentQueue}=await load('src/subagent-queue.mjs');
const {computeNarrativeHash,hashCalleeSummaries}=await load('src/hash.mjs');
const {NARRATIVE_SCHEMA}=await load('src/cards/narrative-schema.mjs');
const cp=createRequire(import.meta.url)('node:child_process');
cp.spawn=()=>{throw Error('verifier denies all native spawn');};syncBuiltinESMExports();
const K='js|src/a.js|function|exported|a|1';
const D='js|src/d.js|function|exported|d|1';
const code=['export function a(x) {','  if (x < 0) {','    throw Error("negative");','  }','  return x + 1;','}'].join('\n');
const newer=code.replace('x + 1','x + 2');
const range={startLine:1,endLine:6};
const context={symbolKeys:[K,D],signature:'export function a(x)',role:null,callees:[{key:D,summary:'Dependency summary.'}],callers:[],projectRules:[]};
const narrative=s=>({summary:s,behavior:[],sideEffects:[],errors:[],contracts:[],changeNotes:'',mentions:[]});
const result=s=>({status:'succeeded',content:JSON.stringify(narrative(s)),mode:'local-model',attempts:[]});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'own-n5b-')); const dir=join(root,'.planning/project-memory-context/enrichment');await mkdir(dir,{recursive:true});await mkdir(join(root,'src'));await writeFile(join(root,'src/a.js'),code+'\n// padding\n// padding\n// padding\n// padding\n');
 const symbol={symbolKey:K,name:'a',filePath:'src/a.js',language:'js',kind:'function',range,codeHash:'old',status:'pending'};
 const f={root,dir,symbol,wl:join(dir,'worklist.json'),idx:join(dir,'symbol-index.json'),mem:join(dir,K.replace(/[^a-zA-Z0-9_-]+/g,'_')+'.memory.json')};
 await json(f.wl,[symbol]);await json(f.idx,{});return f;
}
const json=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const parsed=async p=>JSON.parse(await readFile(p,'utf8'));
const sha=async p=>{try{return createHash('sha256').update(await readFile(p)).digest('hex');}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const accepted=async f=>Promise.all([f.mem,f.idx,join(f.dir,'sync-manifest.json')].map(sha));
async function runner(f,c=context,provider=async()=>result('Accepted narrative.')){
 return q.runQueueSymbolEnrichment({symbol:f.symbol,projectRoot:f.root,projectSlug:'owned',enrichmentDir:f.dir,worklist:await parsed(f.wl),worklistFile:f.wl,symbolIndex:await parsed(f.idx),symbolIndexFile:f.idx,config:{preferredModes:['local-model']},providers:[],narrativeContext:c,runEnrichmentWithFallbackImpl:provider});
}
const fp=async(c,text=code)=>computeNarrativeHash({code:text,signature:c.signature,role:c.role,calleeSummaryHashes:await hashCalleeSummaries(c.callees.map(e=>({symbolKey:e.key,summaryText:e.summary}))),promptVersion:'v2'});
async function quiet(fn){let logs=[],errors=[];const a=console.log,b=console.error;console.log=(...x)=>logs.push(x.join(' '));console.error=(...x)=>errors.push(x.join(' '));try{return {value:await fn(),logs,errors};}finally{console.log=a;console.error=b;}}
const cfg={preferredModes:['local-model'],localModel:{baseUrl:'http://127.0.0.1:0',model:'owned'},fileCoverageThreshold:0.99,subagentTokenThreshold:999999};

test('S11 independent runner: exact formula, caller immunity, invalid artifact, rejected-provider SHA preservation',async()=>{
 const f=await fixture();let calls=0;const provider=async()=>{calls++;return result('Accepted narrative.');};
 await runner(f,context,provider);assert.equal((await parsed(f.wl))[0].narrativeHash,await fp(context));
 const before=await accepted(f);const hit=await runner(f,{...context,callers:[{key:D,name:'newCaller',role:'controller'}]},provider);assert.equal(hit.reused,true);assert.equal(calls,1);assert.deepEqual(await accepted(f),before);
 const payload=await parsed(f.mem);payload.content=JSON.stringify({...narrative('Accepted narrative.'),mentions:['node_bad']});await json(f.mem,payload);await runner(f,context,provider);assert.equal(calls,2);
 const stable=await accepted(f);const hash=(await parsed(f.wl))[0].narrativeHash;
 await assert.rejects(runner(f,{...context,signature:'new signature'},async()=>({status:'error',attempts:[]})));
 assert.deepEqual(await accepted(f),stable);assert.equal((await parsed(f.wl))[0].narrativeHash,hash);
});

test('S11 main never accepts a fingerprint for code different from its actual provider prompt',async()=>{
 const f=await fixture();let sent;await quiet(()=>q.main({projectRoot:f.root,config:cfg,providers:[],narrativeResolver:async()=>structuredClone(context),countPromptTokensImpl:async()=>{await writeFile(join(f.root,'src/a.js'),newer+'\n// padding\n// padding\n// padding\n// padding\n');return 100;},runEnrichmentWithFallbackImpl:async({request})=>{sent=request.prompt;return result('Describes the old plus-one implementation.');}}));
 assert.ok(sent.includes('x + 1;'));assert.ok(!sent.includes('x + 2;'));
 const row=(await parsed(f.wl))[0];let nextCalls=0;const next=await quiet(()=>q.main({projectRoot:f.root,config:cfg,providers:[],narrativeResolver:async()=>structuredClone(context),countPromptTokensImpl:async()=>100,runEnrichmentWithFallbackImpl:async()=>{nextCalls++;return result('New generation.');}}));console.log(JSON.stringify({probe:'B1',acceptedHash:row.narrativeHash,promptHash:await fp(context,code),diskHash:await fp(context,newer),nextCalls,reuse:next.errors.filter(x=>x.includes('REUSE'))}));if(row.status==='enriched')assert.equal(row.narrativeHash,await fp(context,code),'accepted fingerprint must describe the exact code supplied to the provider, not a later disk read');
});

test('S11 every previously accepted dependent remains invalidated, including a failed retry and queued retry',async()=>{
 const f=await fixture();const a='long-summary-word-'.repeat(13)+'old';const b=a.slice(0,-3)+'new';assert.equal(a.slice(0,200),b.slice(0,200));
 await runner(f,{...context,callees:[]},async()=>result(a));
 const hashes=await hashCalleeSummaries({[K]:a});const rows=await parsed(f.wl);
 for(let i=0;i<8;i++)rows.push({symbolKey:`js|src/c${i}.js|function|exported|c${i}|1`,status:i===6?'error':i===7?'subagent-queued':'enriched',memoryId:`accepted-${i}`,narrativeHash:`accepted-hash-${i}`,calleeSummaryHashes:hashes,promptVersion:'v2'});
 await json(f.wl,rows);await runner(f,{...context,callees:[],signature:'changed signature'},async()=>result(b));
 const after=await parsed(f.wl);assert.deepEqual(after.slice(1).map(e=>e.status),Array(8).fill('stale'),'all accepted callers must be next-pass eligible, not stranded in error/subagent-queued');
});

test('S11 hand-edited null evidence must reject just like append, without accepted writes',async()=>{
 const f=await fixture();await runner(f);const before=await accepted(f);
 const ev={symbolKey:K,narrativeHash:await fp(context),calleeSummaryHashes:await hashCalleeSummaries({[D]:'Dependency summary.'}),promptVersion:'v2',signature:context.signature,role:null,range};
 const entry=await appendSubagentQueue(f.dir,{...f.symbol,prompt:'owned',promptVersion:'v2',schema:NARRATIVE_SCHEMA,knownGraphKeys:[K,D],narrativeEvidence:ev});
 const queuePath=join(f.dir,'subagent-queue.json');const queue=await parsed(queuePath);queue.entries[0].narrativeEvidence=null;await json(queuePath,queue);
 const out=join(f.root,'content.json');await json(out,narrative('Must not replace accepted memory.'));
 const observed=await quiet(()=>apply([f.root,'--entry-id',entry.id,'--content-file',out]));
 console.log(JSON.stringify({probe:'B3',exit:observed.value,stdout:observed.logs,stderr:observed.errors,before,after:await accepted(f)}));assert.equal(observed.value,1,'explicit malformed evidence must not silently downgrade into legacy success');assert.deepEqual(await accepted(f),before);
});

test('S11 merge guard keeps every historical downgrade behavior outside explicit stale reasons',async()=>{
 const f=await fixture();const disk={...f.symbol,status:'enriched',memoryId:'accepted'};await json(f.wl,[disk]);
 for(const status of ['pending','error','subagent-queued','stale','already_enriched']){const row={...f.symbol,status};await q.saveWorklistMerged(f.wl,[row]);if(status!=='already_enriched')assert.deepEqual(row,disk);await json(f.wl,[disk]);}
 for(const staleReason of ['narrative-hash-changed','narrative-hash-missing','callee-summary-changed','queued-fingerprint-mismatch']){const row={...disk,status:'stale',staleReason};await q.saveWorklistMerged(f.wl,[row]);assert.equal((await parsed(f.wl))[0].status,'stale');await json(f.wl,[disk]);}
});

test('S11 owned baseline: unchanged legacy provider request and stable persisted payload/index fields',{skip:!process.env.N5A_BASELINE},async()=>{
 assert.ok(process.env.N5A_BASELINE,'baseline archive required');const base=await import(pathToFileURL(join(process.env.N5A_BASELINE,'tools/project-memory-context/cli/enrich-queue.mjs')));
 const results=[];for(const api of [base,q]){const f=await fixture();let request;const r=await api.runQueueSymbolEnrichment({symbol:f.symbol,projectRoot:f.root,projectSlug:'owned',enrichmentDir:f.dir,worklist:await parsed(f.wl),worklistFile:f.wl,symbolIndex:{},symbolIndexFile:f.idx,config:{preferredModes:['local-model']},providers:[],runEnrichmentWithFallbackImpl:async x=>{request=x.request;return {status:'succeeded',content:'Legacy responsibility.',mode:'local-model',attempts:[]};}});const idx=(await parsed(f.idx))[K];delete idx.lastEnrichedAt;results.push({request,memory:await parsed(f.mem),index:idx,status:r.status,keys:Object.keys(r)});}assert.deepEqual(results[1],results[0]);
});

test('S11 trio-only subagent apply preserves N3 baseline outputs and accepted payload keysets',{skip:!process.env.N5A_BASELINE},async()=>{
 const base=process.env.N5A_BASELINE;assert.ok(base);const snapshots=[];
 for(const root of [join(base,'tools/project-memory-context'),target]){
  const {appendSubagentQueue:append}=await import(pathToFileURL(join(root,'src/subagent-queue.mjs')));
  const {main:applyOld}=await import(pathToFileURL(join(root,'cli/subagent-apply.mjs')));
  const f=await fixture();const e=await append(f.dir,{...f.symbol,prompt:'owned',promptVersion:'v2',schema:NARRATIVE_SCHEMA,knownGraphKeys:[K,D]});const out=join(f.root,'content.json');await json(out,narrative('Trio-only narrative.'));
  const got=await quiet(()=>applyOld([f.root,'--entry-id',e.id,'--content-file',out]));const payload=await parsed(f.mem);const idx=(await parsed(f.idx))[K];delete idx.lastEnrichedAt;const stdout=JSON.parse(got.logs[0]);delete stdout.entryId;
  snapshots.push({exit:got.value,stdout,stderr:got.errors,memory:payload,index:idx});
 }
 // Project tags include owned random fixture names; all other bytes/fields must agree.
 for(const s of snapshots){s.memory.tags=s.memory.tags.map(x=>x.startsWith('project:')?'project:<owned>':x);}
 assert.deepEqual(snapshots[1],snapshots[0]);
});
