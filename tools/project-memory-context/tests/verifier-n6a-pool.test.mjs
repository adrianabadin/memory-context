import test from 'node:test';
import assert from 'node:assert/strict';
import { runNarrativePool } from '../src/cards/batch-pool.mjs';
const edge=(caller,callee)=>({relation:'calls',source:{id:caller},target:{id:callee}});
async function flush(){for(let i=0;i<40;i++)await Promise.resolve();}
test('S12A B1: preparation work respects the global bound',async()=>{
 const gates=[];let active=0,maximum=0;
 const pending=runNarrativePool({symbolKeys:['a','b','c','d','e'],edges:[],concurrency:2,prepareBatch(){active++;maximum=Math.max(maximum,active);return new Promise(resolve=>gates.push(resolve)).finally(()=>active--);},run:key=>key});
 await flush();while(gates.length){gates.splice(0).forEach(resolve=>resolve());await flush();}const results=await pending;
 assert.equal(results.length,5);assert.ok(maximum<=2,`prepareBatch max active ${maximum} exceeds concurrency 2`);assert.equal(active,0);
});
test('S12A B2: synchronous preparation failure releases callers once',async()=>{
 const failure=new Error('leaf preparation failed');const events=[];
 const results=await runNarrativePool({symbolKeys:['caller','leaf'],edges:[edge('caller','leaf')],concurrency:1,prepareBatch(members){events.push(['prepare',...members]);if(members.includes('leaf'))throw failure;},run(key){events.push(['run',key]);return key;}});
 assert.deepEqual(events,[['prepare','leaf'],['prepare','caller'],['run','caller']]);
 assert.deepEqual(results,[{key:'leaf',status:'rejected',reason:failure},{key:'caller',status:'fulfilled',value:'caller'}]);
});
test('S12A B3: 3000 synchronous preparation failures settle iteratively',async()=>{
 const symbolKeys=Array.from({length:3000},(_,i)=>`k${String(i).padStart(4,'0')}`);const edges=symbolKeys.slice(1).map((key,i)=>edge(symbolKeys[i],key));const failure=new Error('preparation failed');let prepares=0,runs=0;
 const results=await runNarrativePool({symbolKeys,edges,concurrency:2,prepareBatch(){prepares++;throw failure;},run(){runs++;}});
 assert.equal(prepares,3000);assert.equal(runs,0);assert.deepEqual(results,[...symbolKeys].reverse().map(key=>({key,status:'rejected',reason:failure})));
});
test('S12A B1 combined control: prepare and run callbacks share one global slot bound',async()=>{
 const symbolKeys=['caller','leaf','iso1','iso2'];
 const gates=[];const kinds={prepare:0,run:0};let active=0,maximum=0,prepares=0,runs=0,sawMixed=false;
 const hold=()=>new Promise(resolve=>gates.push(resolve));
 const enter=(kind)=>{active+=1;kinds[kind]+=1;if(kinds.prepare>0&&kinds.run>0)sawMixed=true;maximum=Math.max(maximum,active);return hold().finally(()=>{active-=1;kinds[kind]-=1;});};
 const pending=runNarrativePool({symbolKeys,edges:[edge('caller','leaf')],concurrency:2,
   prepareBatch(){prepares+=1;return enter('prepare');},
   run(){runs+=1;return enter('run');}});
 await flush();
 assert.equal(active,2,'both slots are held by preparation before any gate resolves');
 gates.shift()();await flush();
 gates.shift()();await flush();
 assert.ok(sawMixed,'a preparation and a run callback occupied slots at the same time');
 assert.ok(maximum<=2,`global active ${maximum} exceeds concurrency 2`);
 while(gates.length){gates.splice(0).forEach(resolve=>resolve());await flush();}
 const results=await pending;
 assert.equal(prepares,4);assert.equal(runs,4);
 assert.equal(results.length,4);assert.ok(results.every(entry=>entry.status==='fulfilled'));
 assert.equal(maximum,2,'the global bound is reached and never exceeded');
 assert.equal(active,0);
});
