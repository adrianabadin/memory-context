// S15 independent public-contract probes. Owned fixtures only; no writer helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerQueryTools } from '../mcp/query-tools.mjs';
import { createRelationsReader } from '../src/query/relations.mjs';
import { buildFromGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';
import { computePageRank } from '../src/query/pagerank.mjs';
const key=(n,p=`src/${n}.js`,kind='function',scope='exported')=>`js|${p}|${kind}|${scope}|${n}|0`;
const ep=k=>({id:k,symbolKey:k,path:k.split('|')[1],kind:k.split('|')[2]});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const decode=r=>{assert.notEqual(r.isError,true,r.content?.[0]?.text);return JSON.parse(r.content[0].text);};
async function connect(t,root,register=registerQueryTools){
 const server=new McpServer({name:'independent',version:'1'});register(server,{projectRoot:root});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);
 const client=new Client({name:'independent-client',version:'1'});await client.connect(a);
 t.after(async()=>{await client.close();await server.close();});return client;
}
async function fixture(t,{keys,edges=[],native=false,imports=[],roles=[],edit,extraNodes=[]}){
 const root=mkdtempSync(join(tmpdir(),'s15-independent-')),pmc=join(root,'.planning/project-memory-context');
 mkdirSync(join(pmc,'graph'),{recursive:true});mkdirSync(join(pmc,'enrichment'),{recursive:true});
 const graph={nodes:[...keys.map(k=>({id:k,label:k.split('|')[4],kind:k.split('|')[2],source_file:k.split('|')[1],metadata:{symbolKey:k}})),...extraNodes],links:native?[]:edges.map(([source,target,relation='calls'])=>({source,target,relation}))};
 const dbPath=join(pmc,'graph/graph.db'),db=new DatabaseSync(dbPath);
 db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT);CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
 buildFromGraphJson(db,graph,'independent');const store=createSqliteGraphStore(db);
 store.persistNativeRelations({relations:[...(native?edges.map(([a,b,relation='calls'])=>({source:ep(a),target:ep(b),relation})):[]),...imports.map(([a,b,bindings=[]])=>({source:{id:`file|${a}`,kind:'file',path:a},target:{id:`file|${b}`,kind:'file',path:b},relation:'imports',bindings}))],unresolved:[]});
 if(roles.length)store.persistNodeRoles(roles.map(([k,role,layer])=>({endpoint:ep(k),classification:{role,layer,confidence:role?0.8:0,evidence:role?['owned evidence']:[]}})));
 edit?.(db);db.close();
 const artifacts=[['graph/graph.json',graph],['enrichment/symbol-index.json',Object.fromEntries(keys.map(k=>[k,{graphNodeId:k}]))],['enrichment/worklist.json',[]],['roles.json',{sentinel:true}]];
 for(const [p,v]of artifacts)writeFileSync(join(pmc,p),JSON.stringify(v));
 const snapshot=()=>JSON.stringify([dbPath,...artifacts.map(([p])=>join(pmc,p))].map(p=>[hash(p),statSync(p).mtimeMs]));
 const client=await connect(t,root);return{root,client,reader:createRelationsReader({projectRoot:root}),snapshot,async call(args,name='pmc_impact'){const before=snapshot();try{return await client.callTool({name,arguments:args});}finally{assert.equal(snapshot(),before,'accepted/rejected query preserves every byte and mtime');}}};
}
// Independent stationary-distribution oracle: solve (I-d*P^T)r=(1-d)/N.
function stationary(nodes,edges){
 const ns=[...nodes].sort(),n=ns.length,a=ns.map((_,i)=>ns.map((_,j)=>+(i===j)).concat(.15/n));
 for(let j=0;j<n;j++){const out=[...new Set(edges.filter(([s])=>s===ns[j]).map(([,v])=>v))];for(let i=0;i<n;i++)a[i][j]-=.85*(out.length?(out.includes(ns[i])?1/out.length:0):1/n);}
 for(let j=0;j<n;j++){let p=j;for(let i=j+1;i<n;i++)if(Math.abs(a[i][j])>Math.abs(a[p][j]))p=i;[a[p],a[j]]=[a[j],a[p]];const d=a[j][j];for(let k=j;k<=n;k++)a[j][k]/=d;for(let i=0;i<n;i++)if(i!==j){const v=a[i][j];for(let k=j;k<=n;k++)a[i][k]-=v*a[j][k];}}
 return new Map(ns.map((k,i)=>[k,a[i][n]]));
}
test('S15 independent PageRank analytical, boundaries, exact order and input immunity',()=>{
 for(const [nodes,pairs]of [[['a','b'],[['a','b']]],[['a','b','c'],[['a','a'],['b','a']]],[['__proto__','b','c'],[]],[['a','b','c'],[['a','b'],['b','c'],['c','a']]]]){
  const edges=pairs.map(([source,target])=>({source,target})),args={nodes,edges},before=JSON.stringify(args),r=computePageRank(args),expected=stationary(nodes,pairs);
  assert.equal(JSON.stringify(args),before);assert.equal(r.converged,true);assert.ok(Math.abs([...r.scores.values()].reduce((a,b)=>a+b,0)-1)<1e-12);
  for(const [k,v]of r.scores){assert.ok(Number.isFinite(v)&&v>=0);assert.ok(Math.abs(v-expected.get(k))<1e-7,`${k}: independent linear solution`);}
  assert.deepEqual(computePageRank({nodes:[...nodes].reverse(),edges:[...edges,...edges].reverse()}),r);
 }
 const r=computePageRank({nodes:['a','b'],edges:[{source:'a',target:'b'}],maxIterations:1,tolerance:1e-15});assert.deepEqual([...r.scores],[['a',.2875],['b',.7124999999999999]]);assert.equal(r.iterations,1);assert.equal(r.converged,false);
 assert.deepEqual(computePageRank({nodes:[],edges:[]}),{scores:new Map(),iterations:0,converged:true,nodeCount:0});
 for(const extra of [{damping:NaN},{damping:-.1},{damping:1.1},{tolerance:0},{tolerance:Infinity},{maxIterations:0},{maxIterations:1.5},JSON.parse('{"__proto__":true}'),{depth:1}])assert.throws(()=>computePageRank({nodes:['a'],edges:[],...extra}),TypeError);
 for(const args of [{nodes:['a','a'],edges:[]},{nodes:[''],edges:[]},{nodes:['a'],edges:[{source:'a',target:'ghost'}]}])assert.throws(()=>computePageRank(args),TypeError);
});
test('S15 independent public reverse diamonds/cycles/native/legacy/full graph ranks',async t=>{
 const ks=['sink','a','b','c','d','e','root','isolate'].map(n=>key(n));const [sink,a,b,c,d,e,root]=ks;
 const edges=[[a,sink],[b,sink],[c,a],[c,b],[d,c],[e,d],[root,e],[e,c],[c,e]],expectedPairs=edges;
 let previous;
 for(const native of [false,true])for(const reverse of [false,true]){
  const f=await fixture(t,{keys:reverse?[...ks].reverse():ks,edges:reverse?[...edges].reverse():edges,native});const q=decode(await f.call({target:sink}));
  assert.deepEqual(q.dependents.map(v=>[v.symbolKey,v.distance]),[[a,1],[b,1],[c,2],[d,3],[e,3],[root,4]].sort((x,y)=>q.dependents.findIndex(v=>v.symbolKey===x[0])-q.dependents.findIndex(v=>v.symbolKey===y[0])));
  assert.deepEqual(q.dependents.find(v=>v.symbolKey===root).path,[sink,a,c,e,root]);
  const all=[...ks,...ks.map(k=>'file|'+k.split('|')[1])],oracle=stationary(all,expectedPairs);
  for(const v of q.dependents)assert.ok(Math.abs(v.rank-oracle.get(v.symbolKey))<1e-7,'full graph including disconnected file endpoints');
  const other=decode(await f.call({target:c}));for(const v of other.dependents)assert.equal(v.rank,q.dependents.find(x=>x.symbolKey===v.symbolKey).rank);
  if(previous)assert.deepEqual(q,previous);previous=q;
 }
});
test('S15 independent strict rejection, exact direct errors, ambiguity and baseline descriptor/response parity',async t=>{
 const sink=key('sink'),a=key('a'),other=key('sink','src/second.js');const f=await fixture(t,{keys:[sink,a,other],edges:[[a,sink]]});
 for(const option of ['depth','direction','damping','options']){
  const args=JSON.parse(JSON.stringify({target:sink}));Object.defineProperty(args,option,{value:1,enumerable:true});assert.equal((await f.call(args)).isError,true);
  await assert.rejects(f.reader.impact(args),{name:'TypeError',message:`pmc_impact accepts only the target option; unknown option '${option}'`});
 }
 for(const target of ['', '   ',null,0,[],{}])assert.equal((await f.call({target})).isError,true);
 assert.deepEqual(decode(await f.call({target:'no-match'})),{status:'missing',candidates:[],dependents:[],tests:[],roles:[]});
 const ambiguous=decode(await f.call({target:'sink'}));assert.equal(ambiguous.status,'ambiguous');assert.equal(ambiguous.candidates.length,2);assert.deepEqual(ambiguous.dependents,[]);
 if(process.env.S15_BASELINE){const base=await import(pathToFileURL(join(process.env.S15_BASELINE,'tools/project-memory-context/mcp/query-tools.mjs'))),old=await connect(t,f.root,base.registerQueryTools),tools=(await old.listTools()).tools;assert.deepEqual((await f.client.listTools()).tools.filter(v=>tools.some(o=>o.name===v.name)),tools);
  let count=0;for(const target of [sink,a,'sink','src/sink.js','no-match'])for(const name of tools.map(v=>v.name)){const args=name==='pmc_query_project'?{question:target}:name==='pmc_search_symbols'?{query:target}:name.startsWith('pmc_get_')?{symbol:target}:{target};assert.equal(JSON.stringify(await f.call(args,name)),JSON.stringify(await old.callTool({name,arguments:args})));count++;}console.log(`S15_INDEPENDENT_OLD_PARITY=${count}`);
 }
});
test('S15 independent static tests, imported files, canonical unknown and node-kind guards',async t=>{
 const service=key('Service','src/service.js','class'),work=key('Service.work','src/service.js','method','member'),tester=key('testService','tests/service.spec.js'),other=key('controller','src/controller.js'),doc=key('Doc.work','src/doc.js','method','member'),owner=key('Doc','src/doc.js','class');
 const f=await fixture(t,{keys:[service,work,tester,other,doc,owner],edges:[[tester,work],[other,work],[doc,work]],imports:[['tests/service.spec.js','src/service.js']],roles:[[tester,'test','test'],[other,null,null],[owner,'controller','presentation']],edit:db=>db.prepare('UPDATE nodes SET node_kind=? WHERE id=?').run('doc',doc)});
 for(const target of [service,work]){const q=decode(await f.call({target}));assert.deepEqual(q.tests.map(v=>[v.symbolKey,v.provenance]),[[tester,'static-import-reference']]);assert.deepEqual(q.roles.map(v=>[v.role,v.symbolKeys,v.rank]),[['test',[tester],q.tests[0].rank]]);assert.equal(q.dependents.find(v=>v.symbolKey===other).role,null);assert.equal(q.dependents.find(v=>v.symbolKey===doc).role,null);}
 const file=decode(await f.call({target:'src/service.js'}));assert.deepEqual(file.tests.map(v=>[v.symbolKey,v.kind,v.role]),[['file|tests/service.spec.js','file',null]]);assert.ok(file.dependents.some(v=>v.symbolKey==='file|tests/service.spec.js'&&v.distance===1));
});

test('S15 independent known standalone file endpoint participates in full-graph rank',async t=>{
 const sink=key('sink'),a=key('a'),path='src/empty.js',file='file|'+path;
 const f=await fixture(t,{keys:[sink,a],edges:[[a,sink]],extraNodes:[{id:file,label:path,kind:'file',source_file:path,metadata:{}}]});
 assert.equal(decode(await f.call({target:path},'pmc_card')).status,'resolved','public card confirms this is an existing known file');
 if(process.env.S15_BASELINE){const base=await import(pathToFileURL(join(process.env.S15_BASELINE,'tools/project-memory-context/mcp/query-tools.mjs'))),old=await connect(t,f.root,base.registerQueryTools);assert.equal(decode(await old.callTool({name:'pmc_card',arguments:{target:path}})).status,'resolved');console.log('BASELINE_KNOWN_FILE=resolved; pmc_impact absent');}
 const q=decode(await f.call({target:sink})),expected=stationary([sink,a,'file|src/sink.js','file|src/a.js',file],[[a,sink]]);
 console.log('KNOWN_FILE_RANK',JSON.stringify({actual:q.dependents[0].rank,expected:expected.get(a)}));
 assert.ok(Math.abs(q.dependents[0].rank-expected.get(a))<1e-7,'standalone known files must not disappear from the full ranking graph');
});
test('S15 independent aggregate layer requires unanimity including absent canonical layer',async t=>{
 const sink=key('sink'),a=key('a'),b=key('b');
 const f=await fixture(t,{keys:[sink,a,b],edges:[[a,sink],[b,sink]],roles:[[a,'controller','presentation'],[b,'controller','presentation']],edit:db=>{
  const c=JSON.parse(db.prepare('SELECT classification FROM node_role_assignments WHERE endpoint_id=?').get(b).classification);delete c.layer;
  db.prepare('UPDATE node_role_assignments SET classification=? WHERE endpoint_id=?').run(JSON.stringify(c),b);
 }});
 if(process.env.S15_BASELINE){const base=await import(pathToFileURL(join(process.env.S15_BASELINE,'tools/project-memory-context/mcp/query-tools.mjs'))),old=await connect(t,f.root,base.registerQueryTools);assert.equal(Object.hasOwn(decode(await old.callTool({name:'pmc_card',arguments:{target:b}})).facts.roleClassification,'layer'),false);console.log('BASELINE_CANONICAL_LAYER=absent; aggregation absent');}
 const q=decode(await f.call({target:sink}));assert.deepEqual(q.dependents.map(v=>[v.symbolKey,v.layer]),[[a,'presentation'],[b,null]]);
 console.log('NON_UNANIMOUS_LAYER',JSON.stringify(q.roles));assert.equal(q.roles[0].layer,null,'unknown is not unanimous presentation');
});
test('S15 independent golden q12 via actual native extractors and 16/16 classifier',async t=>{
 const {extractNativeCalls}=await import('../src/relations/native-calls.mjs'),{extractNativeImportBindings}=await import('../src/relations/native-import-bindings.mjs'),{extractSymbolsForFile}=await import('../src/extractors/tree-sitter/extract.mjs'),{classifySymbol,loadProfile}=await import('../src/roles/classify.mjs');
 const paths=['src/cli/main.ts','src/controllers/user.controller.ts','src/services/user.service.ts','src/repositories/user.repository.ts','src/db/client.ts','src/models/user.model.ts','src/interfaces/user-repository.ts','src/utils/format.ts','src/views/user.view.ts','tests/user.service.test.ts'];
 const files=paths.map(path=>({path,content:readFileSync(new URL('./fixtures/layered-app/'+path,import.meta.url),'utf8')}));
 const calls=await extractNativeCalls({files}),imports=await extractNativeImportBindings({files}),records=[];for(const f of files)records.push(...await extractSymbolsForFile({filePath:f.path,content:f.content}));
 const expected=JSON.parse(readFileSync(new URL('./fixtures/layered-app/expected.json',import.meta.url),'utf8')),profile=loadProfile('generic');
 const roles=calls.symbols.map(s=>{const c=classifySymbol(records.find(r=>r.symbolKey===s.symbolKey),{profile,allSymbols:records});return[s.id,c.role,c.layer];});
 for(const [id,v]of Object.entries(expected.symbols))assert.deepEqual(roles.find(([k])=>k===id).slice(1),[v.role,v.layer]);assert.equal(Object.keys(expected.symbols).length,16);
 const f=await fixture(t,{keys:calls.symbols.map(s=>s.id),native:true,edges:calls.relations.map(e=>[e.source.id,e.target.id,e.relation]),imports:imports.relations.map(e=>[e.source.id.slice(5),e.target.id.slice(5),e.bindings]),roles});
 const service='ts|src/services/user.service.ts|class|exported|UserService|0',member='ts|src/services/user.service.ts|method|member|UserService.findById|1';
 for(const target of [service,member]){const q=decode(await f.call({target}));assert.deepEqual(q.tests.map(v=>v.symbolKey),['ts|tests/user.service.test.ts|function|exported|testUserService|0']);assert.deepEqual(q.tests.map(v=>v.provenance),['static-import-reference']);assert.equal(q.roles.find(v=>v.role==='test').rank,q.tests[0].rank);}
 console.log('S15_INDEPENDENT_F2=16/16');
});

test('S15 independent rank excludes conflicting registry identities without changing old relations',async t=>{
 const sink=key('sink'),a=key('a'),bad=key('bad');
 const f=await fixture(t,{keys:[sink,a,bad],native:true,edges:[[a,sink],[bad,sink]],edit:db=>db.prepare('UPDATE nodes SET kind=? WHERE id=?').run('class',bad)});
 const q=decode(await f.call({target:sink}));assert.deepEqual(q.dependents.map(v=>v.symbolKey),[a]);
 const oracle=stationary([sink,a,'file|src/sink.js','file|src/a.js'],[[a,sink]]);assert.ok(Math.abs(q.dependents[0].rank-oracle.get(a))<1e-7,'conflicting endpoint is not a ghost ranking node');
 if(process.env.S15_BASELINE){const base=await import(pathToFileURL(join(process.env.S15_BASELINE,'tools/project-memory-context/src/query/relations.mjs')));assert.deepEqual(await f.reader.relations({target:sink,direction:'in',relations:['calls']}),await base.createRelationsReader({projectRoot:f.root}).relations({target:sink,direction:'in',relations:['calls']}));}
});
