import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryEngine } from '../src/retrieval/query-engine.mjs';
import { createInMemoryGraphStore } from '../src/graph-store/in-memory-graph.mjs';
import { runTargetContext } from '../cli/context.mjs';

const key = (lang, file, name) => `${lang}|${file}|function|exported|${name}|0`;
const a = key('js', 'a.js', 'alpha');
const b = key('js', 'b.js', 'beta');
const c = key('py', 'c.py', 'gamma');
const d = key('py', 'd.py', 'delta');

function fixture(native = true) {
  const graphStore = createInMemoryGraphStore({
    nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, label: id })),
    links: [{ source: 'c', target: 'd', relation: 'calls' }, { source: 'a', target: 'c', relation: 'contains' }],
  });
  if (native) graphStore.listNativeEdges = () => [{ source: { id: a }, target: { id: b }, relation: 'calls' }];
  return { graphStore, symbolIndex: {
    [a]: { graphNodeId: 'a' }, [b]: { graphNodeId: 'b' }, [c]: { graphNodeId: 'c' }, [d]: { graphNodeId: 'd' },
  } };
}

test('Task1.5/S5: native JS evidence preserves legacy Python calls', async () => {
  const engine = createQueryEngine(fixture());
  const expected = [{ source: 'c', target: 'd', relation: 'calls' }];
  assert.deepEqual((await engine.querySymbolContext({ symbolKey: c, depth: 'compact' })).edges, expected);
  assert.deepEqual((await engine.queryImpactScope({ symbolKeys: [d], depth: 'compact' })).edges, expected);
});

test('Task1.5: dependencies focus preserves existing relevant output', async () => {
  const result = await runTargetContext({ projectRoot: process.cwd(), target: 'alpha', explicitMode: 'symbol',
    depth: 'extended', focus: 'dependencies', artifacts: fixture(false) });
  assert.deepEqual(result.input.relevant, [{ label: 'gamma', filePath: 'c.py' }, { label: 'delta', filePath: 'd.py' }]);
  assert.deepEqual(result.input.nextReads, ['c.py', 'd.py']);
  assert.deepEqual(result.input.relations, []);
});

test('Task1.5/S1/S2: contradictory graph identities cannot alias native endpoints', async () => {
  const graphStore = createInMemoryGraphStore({ nodes: [
    { id: 'a', label: 'alpha', source_file: 'a.js', metadata: { symbolKey: a } },
    { id: 'b', label: 'delta', source_file: 'd.py', metadata: { symbolKey: d } },
  ], links: [] });
  graphStore.listNativeEdges = () => [{ source: { id: a }, target: { id: b }, relation: 'calls' }];
  const engine = createQueryEngine({ graphStore, symbolIndex: { [a]: { graphNodeId: 'a' }, [b]: { graphNodeId: 'b' } } });
  assert.deepEqual((await engine.querySymbolContext({ symbolKey: a, depth: 'compact' })).edges, []);
});

test('Task1.5/S1/S2: conflicting explicit native identities fail closed', async () => {
  const other = key('py', 'other.py', 'other');
  const graphStore = createInMemoryGraphStore({ nodes: [
    { id: 'a', source_file: 'a.js', kind: 'function', metadata: { symbolKey: a } },
    { id: 'b', source_file: 'b.js', kind: 'function', symbolKey: b, metadata: { symbolKey: other } },
  ], links: [] });
  graphStore.listNativeEdges = () => [{ source: { id: a }, target: { id: b }, relation: 'calls' }];
  const engine = createQueryEngine({ graphStore, symbolIndex: { [a]: { graphNodeId: 'a' }, [b]: { graphNodeId: 'b' } } });
  assert.deepEqual((await engine.querySymbolContext({ symbolKey: a, depth: 'compact' })).edges, [],
    'Every explicit canonical identity must agree');
});
