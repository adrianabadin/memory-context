import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeGraphDelta, extractChangedFilesFromGraph } from '../src/incremental-graph.mjs';

test('mergeGraphDelta adds new nodes and edges without duplicating existing ones', () => {
  const existing = {
    nodes: [
      { id: 'n1', label: 'App', source_file: 'src/app.mjs', community: 'core' },
      { id: 'n2', label: 'Util', source_file: 'src/util.mjs', community: 'core' },
    ],
    edges: [
      { source: 'n1', target: 'n2', relation: 'imports' },
    ],
  };

  const delta = {
    nodes: [
      { id: 'n2', label: 'Util', source_file: 'src/util.mjs', community: 'core' },
      { id: 'n3', label: 'NewModule', source_file: 'src/new.mjs', community: 'feature' },
    ],
    edges: [
      { source: 'n1', target: 'n3', relation: 'imports' },
    ],
  };

  const merged = mergeGraphDelta(existing, delta);

  assert.equal(merged.nodes.length, 3);
  assert.equal(merged.edges.length, 2);

  const ids = merged.nodes.map(n => n.id);
  assert.ok(ids.includes('n3'));
  assert.ok(ids.includes('n2'));
});

test('mergeGraphDelta handles empty delta', () => {
  const existing = { nodes: [{ id: 'n1' }], edges: [] };
  const merged = mergeGraphDelta(existing, { nodes: [], edges: [] });
  assert.equal(merged.nodes.length, 1);
});

test('extractChangedFilesFromGraph identifies which files appear in delta nodes', () => {
  const delta = {
    nodes: [
      { id: 'n1', source_file: 'src/app.mjs' },
      { id: 'n2', source_file: 'src/util.mjs' },
      { id: 'n3' },
    ],
  };

  const files = extractChangedFilesFromGraph(delta);
  assert.deepEqual(files.sort(), ['src/app.mjs', 'src/util.mjs']);
});

test('mergeGraphDelta deduplicates edges by source|target|relation composite key', () => {
  const existing = {
    nodes: [{ id: 'n1' }],
    edges: [
      { source: 'n1', target: 'n2', relation: 'imports' },
      { source: 'n1', target: 'n3', relation: 'calls' },
    ],
  };

  const delta = {
    nodes: [],
    edges: [
      { source: 'n1', target: 'n2', relation: 'imports' },
    ],
  };

  const merged = mergeGraphDelta(existing, delta);
  assert.equal(merged.edges.length, 2);
});

test('mergeGraphDelta delta nodes update existing nodes with same id', () => {
  const existing = {
    nodes: [{ id: 'n1', label: 'Old', version: 1 }],
    edges: [],
  };

  const delta = {
    nodes: [{ id: 'n1', label: 'Updated', version: 2 }],
    edges: [],
  };

  const merged = mergeGraphDelta(existing, delta);
  assert.equal(merged.nodes.length, 1);
  assert.equal(merged.nodes[0].label, 'Updated');
  assert.equal(merged.nodes[0].version, 2);
});

test('mergeGraphDelta handles empty existing graph', () => {
  const existing = { nodes: [], edges: [] };
  const delta = {
    nodes: [{ id: 'n1' }],
    edges: [{ source: 'n1', target: 'n2', relation: 'imports' }],
  };

  const merged = mergeGraphDelta(existing, delta);
  assert.equal(merged.nodes.length, 1);
  assert.equal(merged.edges.length, 1);
});

test('extractChangedFilesFromGraph returns empty array for nodes without source_file', () => {
  const delta = {
    nodes: [{ id: 'n1' }, { id: 'n2' }],
  };

  const files = extractChangedFilesFromGraph(delta);
  assert.deepEqual(files, []);
});

test('extractChangedFilesFromGraph deduplicates source_file values', () => {
  const delta = {
    nodes: [
      { id: 'n1', source_file: 'src/app.mjs' },
      { id: 'n2', source_file: 'src/app.mjs' },
    ],
  };

  const files = extractChangedFilesFromGraph(delta);
  assert.deepEqual(files, ['src/app.mjs']);
});
