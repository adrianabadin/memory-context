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

test('B1 direct regression: accepted signature role and callee hashes match the actual prompt snapshot',async()=>{
 const f=await fixture();const ctx=structuredClone(context);const before=structuredClone(ctx);let sent;
 await quiet(()=>q.main({projectRoot:f.root,config:cfg,providers:[],narrativeResolver:async()=>ctx,countPromptTokensImpl:async()=>{ctx.signature='export function a(changed)';ctx.role={role:'store',layer:'infrastructure'};ctx.callees[0].summary='Replaced dependency summary.';return 100;},runEnrichmentWithFallbackImpl:async({request})=>{sent=request.prompt;return result('Narrative based on original prompt facts.');}}));
 assert.ok(sent.includes(before.signature));assert.ok(sent.includes('Dependency summary.'));assert.ok(!sent.includes('Replaced dependency summary.'));
 const row=(await parsed(f.wl))[0];let nextCalls=0;const next=await quiet(()=>q.main({projectRoot:f.root,config:cfg,providers:[],narrativeResolver:async()=>ctx,countPromptTokensImpl:async()=>100,runEnrichmentWithFallbackImpl:async()=>{nextCalls++;return result('Current metadata narrative.');}}));console.log(JSON.stringify({probe:'B1-metadata',acceptedHash:row.narrativeHash,promptHash:await fp(before),laterContextHash:await fp(ctx),nextCalls,reuse:next.errors.filter(x=>x.includes('REUSE'))}));
 if(row.status==='enriched')assert.equal(row.narrativeHash,await fp(before),'all five fingerprint inputs must describe the actual prompt, including pre-tokenizer metadata');
});

test('B1 direct regression: opaque prebuilt prompt preserves generation but never fabricates cache evidence',async()=>{
 const f=await fixture();await runner(f);let calls=0;
 for(let i=0;i<2;i++){
  const got=await q.runQueueSymbolEnrichment({symbol:f.symbol,projectRoot:f.root,projectSlug:'owned',enrichmentDir:f.dir,worklist:await parsed(f.wl),worklistFile:f.wl,symbolIndex:await parsed(f.idx),symbolIndexFile:f.idx,config:{preferredModes:['local-model']},providers:[],narrativeContext:context,prompt:'EXPLICIT OPAQUE PREBUILT PROMPT',runEnrichmentWithFallbackImpl:async({request})=>{calls++;assert.equal(request.prompt,'EXPLICIT OPAQUE PREBUILT PROMPT');return result('Opaque prompt narrative.');}});
  assert.equal(got.status,'enriched');assert.notEqual(got.reused,true);assert.equal(Object.hasOwn(await parsed(f.mem),'narrativeEvidence'),false);
 }assert.equal(calls,2);
});

test('B2 direct regression: stale-since-queue proof cannot restore acceptance and unaccepted pending is not promoted',async()=>{
 const f=await fixture();await runner(f);const before=await accepted(f);const ev={symbolKey:K,narrativeHash:await fp(context),calleeSummaryHashes:await hashCalleeSummaries({[D]:'Dependency summary.'}),promptVersion:'v2',signature:context.signature,role:null,range};
 const e=await appendSubagentQueue(f.dir,{...f.symbol,prompt:'owned',promptVersion:'v2',schema:NARRATIVE_SCHEMA,knownGraphKeys:[K,D],narrativeEvidence:ev});
 const rows=await parsed(f.wl);rows[0].status='stale';rows[0].staleReason='callee-summary-changed';await json(f.wl,rows);
 const out=join(f.root,'content.json');await json(out,narrative('Outdated queued narrative.'));const got=await quiet(()=>apply([f.root,'--entry-id',e.id,'--content-file',out]));
 assert.equal(got.value,1);assert.deepEqual(await accepted(f),before);assert.equal((await parsed(f.wl))[0].status,'stale');console.log(JSON.stringify({probe:'B2-stale-queue',stderr:got.errors,acceptedHashes:before}));
});
