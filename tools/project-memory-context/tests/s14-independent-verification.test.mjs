// S14 independent request-derived regression probes; no production artifacts.
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
import { loadProfile } from '../src/roles/classify.mjs';
const key = (name, path=`src/${name}.js`, kind='function', scope='exported') => `js|${path}|${kind}|${scope}|${name}|0`;
const ep = id => ({id, symbolKey:id, path:id.split('|')[1], kind:id.split('|')[2]});
const node = id => ({id, label:id.split('|')[4], kind:id.split('|')[2], source_file:id.split('|')[1], metadata:{symbolKey:id}});
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function connect(t, root, register=registerQueryTools) {
  const server = new McpServer({name:'independent-s14',version:'1'});
  register(server,{projectRoot:root});
  const [a,b]=InMemoryTransport.createLinkedPair(); await server.connect(b);
  const client = new Client({name:'independent-s14',version:'1'}); await client.connect(a);
  t.after(async()=>{await client.close();await server.close();}); return client;
}
async function fixture(t,{keys,edges=[],roles=[],native=false,reverse=false,edit=()=>{}}) {
  const root=mkdtempSync(join(tmpdir(),'independent-s14-')); const p=join(root,'.planning/project-memory-context');
  mkdirSync(join(p,'graph'),{recursive:true});mkdirSync(join(p,'enrichment'),{recursive:true});
  const order=x=>reverse?[...x].reverse():x;
  const graph={nodes:order(keys).map(node),links:native?[]:order(edges).map(([source,target,relation='calls'])=>({source,target,relation}))};
  const dbPath=join(p,'graph/graph.db'), db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
  buildFromGraphJson(db,graph,'independent'); const store=createSqliteGraphStore(db);
  if(native)store.persistNativeRelations({relations:order(edges).map(([source,target,relation='calls'])=>({source:ep(source),target:ep(target),relation})),unresolved:[]});
  const profile=loadProfile('generic');profile.roleLayers.customRoot='entrypoint';for(const [,role,layer]of roles)if(role)profile.roleLayers[role]=layer;
  store.persistNodeRoles(order(roles).map(([id,role,layer])=>({endpoint:ep(id),classification:{role,layer,confidence:role?0.8:0,evidence:role?['independent declared role evidence']:[]}})),{profile});
  edit(db);db.close();
  const index=Object.fromEntries(order(keys).map(id=>[id,{graphNodeId:id}]));
  for(const [file,value]of [['graph/graph.json',graph],['enrichment/symbol-index.json',index],['enrichment/worklist.json',[]],['roles.json',{extends:'generic'}]])writeFileSync(join(p,file),JSON.stringify(value));
  const snapshot=()=>{
    const d=new DatabaseSync(dbPath,{readOnly:true});try{return JSON.stringify({sha:sha(dbPath),mtime:statSync(dbPath).mtimeMs,schema:d.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),roles:d.prepare('SELECT * FROM node_role_assignments ORDER BY endpoint_id').all(),meta:d.prepare('SELECT * FROM meta ORDER BY key').all(),config:['graph/graph.json','enrichment/symbol-index.json','enrichment/worklist.json','roles.json'].map(f=>sha(join(p,f)))});}finally{d.close();}
  };
  const client=await connect(t,root),reader=createRelationsReader({projectRoot:root});
  return {root,dbPath,index,reader,client,snapshot,async call(args){const before=snapshot();try{return await client.callTool({name:'pmc_entrypoints_for',arguments:args});}finally{assert.equal(snapshot(),before);}},async direct(args){const before=snapshot();try{return await reader.entrypoints(args);}finally{assert.equal(snapshot(),before);}}};
}
const decode=result=>{assert.notEqual(result.isError,true,result.content[0]?.text);return JSON.parse(result.content[0].text);};
const match=(symbolKey,role,layer,distance,path)=>({symbolKey,role,layer,distance,path});

test('S14 independent shortest-path oracle: deep diamond, cycle, duplicate, multiple roots, native/legacy and reversed insertion',async t=>{
 const names=['sink','a','b','c','d','e','root','tool','custom','route'];const k=Object.fromEntries(names.map(n=>[n,key(n)]));
 const edges=[[k.a,k.sink],[k.b,k.sink],[k.c,k.a],[k.c,k.b],[k.d,k.c],[k.e,k.d],[k.root,k.e],[k.tool,k.root],[k.custom,k.sink],[k.route,k.sink],[k.a,k.c],[k.a,k.sink]];
 const roles=[[k.root,'cli-command','entrypoint'],[k.tool,'mcp-tool','entrypoint'],[k.custom,'customRoot','entrypoint'],[k.route,'controller','presentation']];
 // Independent queue oracle, not the implementation's impact traversal.
 const distance=new Map([[k.sink,0]]),queue=[k.sink];for(let i=0;i<queue.length;i++)for(const [caller,callee]of edges)if(callee===queue[i]&&!distance.has(caller)){distance.set(caller,distance.get(callee)+1);queue.push(caller);}
 const results=[];
 for(const native of [false,true])for(const reverse of [false,true]){
  const f=await fixture(t,{keys:Object.values(k),edges,roles,native,reverse});const result=decode(await f.call({target:k.sink}));
  assert.deepEqual(await f.direct({target:k.sink}),result);
  assert.deepEqual(result.matches.map(m=>[m.symbolKey,m.distance]),roles.map(([id])=>[id,distance.get(id)]).sort((a,b)=>a[1]-b[1]||(a[0]<b[0]?-1:1)));
  for(const m of result.matches){assert.equal(m.path[0],k.sink);assert.equal(m.path.at(-1),m.symbolKey);assert.equal(m.path.length-1,m.distance);for(let i=1;i<m.path.length;i++)assert.ok(edges.some(([s,d])=>s===m.path[i]&&d===m.path[i-1]));}
  assert.equal(result.matches.find(m=>m.symbolKey===k.tool).distance,6);
  results.push({native,reverse,result}); console.log(JSON.stringify({native,reverse,path:result.matches.find(m=>m.symbolKey===k.root).path}));
  const self=decode(await f.call({target:k.root}));assert.deepEqual(self.matches.map(m=>[m.symbolKey,m.distance]),[[k.root,0],[k.tool,1]]);
  if(process.env.S14_BASELINE){const {createRelationsReader:oldReader}=await import(pathToFileURL(join(process.env.S14_BASELINE,'tools/project-memory-context/src/query/relations.mjs'))); const {createQueryEngine}=await import(pathToFileURL(join(process.env.S14_BASELINE,'tools/project-memory-context/src/retrieval/query-engine.mjs')));const d=new DatabaseSync(f.dbPath,{readOnly:true});try{const e=createQueryEngine({graphStore:createSqliteGraphStore(d),symbolIndex:f.index,worklist:[]});const old=await e.queryImpactScope({symbolKeys:[k.a,k.b],depth:'compact',edgeTypes:['calls']});console.log(JSON.stringify({baseline:true,native,reverse,diamondEdges:old.edges.map(e=>[e.source,e.target])}));}finally{d.close();}}
 }
 for(const native of [false,true])assert.equal(JSON.stringify(results.find(r=>r.native===native&&!r.reverse).result),JSON.stringify(results.find(r=>r.native===native&&r.reverse).result),'S14 equal-distance diamond paths must not depend on insertion order');
});

test('S14 independent membership, explicit unknown, override and current-kind eligibility',async t=>{
 const owner=key('Owner','src/owner.js','class'),member=key('Owner.run','src/owner.js','method','member'),sink=key('sink'),root=key('root');
 for(const state of ['inherit','unknown','override','doc']){
  const roles=[[owner,'cli-command','entrypoint'],[root,'mcp-tool','entrypoint']];if(state==='unknown')roles.push([member,null,null]);if(state==='override'||state==='doc')roles.push([member,'controller','presentation']);
  const f=await fixture(t,{keys:[owner,member,sink,root],edges:[[member,sink],[root,member]],roles,edit:db=>{if(state==='doc')db.prepare('UPDATE nodes SET node_kind=? WHERE id=?').run('doc',member);}});
  const result=decode(await f.call({target:sink}));assert.equal(result.matches.some(m=>m.symbolKey===owner),false);
  const expected=state==='inherit'?[match(member,'cli-command','entrypoint',1,[sink,member])]:state==='override'?[match(member,'controller','presentation',1,[sink,member])]:[];
  assert.deepEqual(result.matches,[...expected,match(root,'mcp-tool','entrypoint',2,[sink,member,root])]);
  for(const target of [owner,'src/owner.js','src/owner.js#run']){const q=decode(await f.call({target}));assert.ok(q.matches.some(m=>m.symbolKey===root));const m=q.matches.find(m=>m.symbolKey===root);assert.equal(m.distance,1);assert.equal(m.path[0],target===owner?owner:target.includes('#')?member:'file|src/owner.js');}
 }
});

test('S14 independent strict adapter/MCP inputs, missing and ambiguous shapes, no mutation',async t=>{
 const a=key('same','src/a.js'),b=key('same','src/b.js');const f=await fixture(t,{keys:[a,b],roles:[[a,'cli-command','entrypoint']]});
 for(const target of ['', ' ',null,0,[],{},false,undefined]){await assert.rejects(()=>f.direct({target}),{name:'TypeError',message:'target must be a nonempty string'});const r=await f.call(target===undefined?{}:{target});assert.equal(r.isError,true);}
 for(const option of ['depth','role','direction','stopAtRole','unused']){await assert.rejects(()=>f.direct({target:a,[option]:null}),{name:'TypeError',message:`pmc_entrypoints_for accepts only the target option; unknown option '${option}'`});const r=await f.call({target:a,[option]:null});assert.equal(r.isError,true);assert.match(r.content[0].text,/Unrecognized key/);}
 const missing={status:'missing',candidates:[],matches:[],entrypoints:[],controllers:[]};assert.deepEqual(decode(await f.call({target:'not-a-symbol'})),missing);
 const ambiguous=decode(await f.call({target:'same'}));assert.equal(ambiguous.status,'ambiguous');assert.deepEqual(ambiguous.candidates.map(c=>c.symbolKey).sort(),[a,b].sort());for(const p of ['matches','entrypoints','controllers'])assert.deepEqual(ambiguous[p],[]);
});

test('S14 independent calls-only, constructor exclusion, overlap, no name inference and empty roots',async t=>{
 const sink=key('sink'),fake=key('main'),ctl=key('route'),ctor=key('Box.constructor','src/box.js','constructor','member'),owner=key('Box','src/box.js','class');
 const f=await fixture(t,{keys:[sink,fake,ctl,ctor,owner],edges:[[fake,sink,'imports'],[ctor,sink],[ctl,sink]],roles:[[fake,'cli-command','entrypoint'],[ctor,'cli-command','entrypoint'],[ctl,'controller','entrypoint']]});
 const q=decode(await f.call({target:sink}));const both=match(ctl,'controller','entrypoint',1,[sink,ctl]);const legacyCtor=match(ctor,'cli-command','entrypoint',1,[sink,ctor]);assert.deepEqual(q.matches,[legacyCtor,both]);assert.deepEqual(q.entrypoints,[legacyCtor,both]);assert.deepEqual(q.controllers,[both]);
 const nf=await fixture(t,{keys:[sink,ctl,ctor,owner],edges:[[ctor,sink],[ctl,sink]],roles:[[ctor,'cli-command','entrypoint'],[ctl,'controller','entrypoint']],native:true});assert.deepEqual(decode(await nf.call({target:sink})).matches,[both]);
 if(process.env.S14_BASELINE){const {createRelationsReader:oldReader}=await import(pathToFileURL(join(process.env.S14_BASELINE,'tools/project-memory-context/src/query/relations.mjs')));assert.deepEqual((await oldReader({projectRoot:f.root}).relations({target:sink,direction:'in',relations:['calls'],depth:1})).edges.map(e=>e.source.symbolKey).sort(),[ctor,ctl].sort());}
 const empty=await fixture(t,{keys:[sink,key('main')],edges:[[key('main'),sink]],roles:[]});assert.deepEqual(decode(await empty.call({target:sink})),{status:'resolved',target:sink,matches:[],entrypoints:[],controllers:[]});
});

test('S14 independent old-tool complete-response baseline parity (conditional archive)',{skip:!process.env.S14_BASELINE},async t=>{
 const base=await import(pathToFileURL(join(process.env.S14_BASELINE,'tools/project-memory-context/mcp/query-tools.mjs')));
 const a=key('sink'),b=key('root');const f=await fixture(t,{keys:[a,b],edges:[[b,a]],roles:[[b,'cli-command','entrypoint']],native:true});const old=await connect(t,f.root,base.registerQueryTools);
 const nowTools=(await f.client.listTools()).tools,oldTools=(await old.listTools()).tools;
 assert.deepEqual(nowTools.filter(t=>t.name!=='pmc_entrypoints_for'),oldTools);
 let count=0;for(const target of [a,b,'sink','src/sink.js','not-found'])for(const name of ['pmc_card','pmc_get_dependencies','pmc_get_dependents','pmc_relations']){
  const variants=name==='pmc_relations'?['in','out'].flatMap(direction=>[1,2,3].map(depth=>({target,direction,depth,relations:['calls']}))):name.startsWith('pmc_get_')?[{symbol:target}]:[{target}];
  for(const args of variants){const before=f.snapshot();assert.equal(JSON.stringify(await f.client.callTool({name,arguments:args})),JSON.stringify(await old.callTool({name,arguments:args})));assert.equal(f.snapshot(),before);count++;}
 }
 for(const [name,args]of [['pmc_query_project',{question:'sink'}],['pmc_query_project',{question:''}],['pmc_search_symbols',{query:'root'}]]){assert.equal(JSON.stringify(await f.client.callTool({name,arguments:args})),JSON.stringify(await old.callTool({name,arguments:args})));count++;}
 console.log(`independent baseline complete responses=${count}`);
});



test('S14 independent actual layered extraction, canonical F2 ledger, q8 class and q7 preservation',async t=>{
 const {extractNativeCalls}=await import('../src/relations/native-calls.mjs');
 const {extractSymbolsForFile}=await import('../src/extractors/tree-sitter/extract.mjs');
 const {classifySymbol}=await import('../src/roles/classify.mjs');
 const paths=['src/cli/main.ts','src/controllers/user.controller.ts','src/services/user.service.ts','src/repositories/user.repository.ts','src/db/client.ts','src/models/user.model.ts','src/interfaces/user-repository.ts','src/utils/format.ts','src/views/user.view.ts','tests/user.service.test.ts'];
 const files=paths.map(path=>({path,content:readFileSync(new URL(`./fixtures/layered-app/${path}`,import.meta.url),'utf8')}));
 const calls=await extractNativeCalls({files});const records=[];for(const f of files)records.push(...await extractSymbolsForFile({filePath:f.path,content:f.content}));
 const profile=loadProfile('generic');const roles=calls.symbols.map(s=>{const c=classifySymbol(records.find(r=>r.symbolKey===s.symbolKey),{profile,allSymbols:records});return[s.id,c.role,c.layer];});
 const f=await fixture(t,{keys:calls.symbols.map(s=>s.id),edges:calls.relations.map(e=>[e.source.id,e.target.id,e.relation]),roles,native:true});
 const expected=JSON.parse(readFileSync(new URL('./fixtures/layered-app/expected.json',import.meta.url),'utf8'));
 for(const [id,c]of Object.entries(expected.symbols)){const actual=roles.find(([k])=>k===id);assert.ok(actual);assert.deepEqual(actual.slice(1),[c.role,c.layer]);}assert.equal(Object.keys(expected.symbols).length,16);
 const cls='ts|src/services/user.service.ts|class|exported|UserService|0',method='ts|src/services/user.service.ts|method|member|UserService.findById|1',get='ts|src/controllers/user.controller.ts|method|member|UserController.getUser|1',main='ts|src/cli/main.ts|function|exported|main|0';
 for(const target of [cls,method,'findById']){const q=decode(await f.call({target}));assert.deepEqual(q.entrypoints.map(m=>m.symbolKey),expected.questions.find(q=>q.id==='q8-entrypoint-user-service').expected);assert.deepEqual(q.matches.map(m=>[m.symbolKey,m.distance]),[[get,1],[main,2]]);assert.equal(q.matches[0].path[0],target===cls?cls:method);}
 const q7=await f.reader.relations({target:cls,direction:'in',relations:['calls'],depth:1,stopAtRole:'controller'});assert.deepEqual(q7.matches.map(m=>m.symbolKey),expected.questions.find(q=>q.id==='q7-nearest-controller-user-service').expected);
});

test('S14 independent contradictory endpoint identity is transparent to no false match',async t=>{
 const a=key('sink'),b=key('root');for(const contradiction of ['path','metadata']){
  const f=await fixture(t,{keys:[a,b],edges:[[b,a]],roles:[[b,'cli-command','entrypoint']],edit:db=>{if(contradiction==='path')db.prepare('UPDATE nodes SET source_file=? WHERE id=?').run('src/foreign.js',b);else db.prepare('UPDATE nodes SET metadata=? WHERE id=?').run(JSON.stringify({symbolKey:key('other')}),b);}});
  assert.deepEqual(decode(await f.call({target:a})).matches,[]);
 }
});
