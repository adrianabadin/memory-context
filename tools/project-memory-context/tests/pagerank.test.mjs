// F4B / S15: the pure, dependency-free PageRank helper behind `pmc_impact`.
//
// Plan 4.3 ranks impact with PageRank; the spec fixes no numeric parameters,
// so damping 0.85 / tolerance 1e-8 / maxIterations 100 are documented
// implementation defaults (implementation detail, never new MCP/CLI knobs).
// Every test here drives the PUBLIC helper only: no graph store, no database,
// no I/O, no state. Analytical expectations are derived by hand from the
// PageRank equations, not by re-running the implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePageRank, PAGERANK_DEFAULTS } from '../src/query/pagerank.mjs';

const approx = (actual, expected, epsilon = 1e-9, message) =>
  assert.ok(Math.abs(actual - expected) <= epsilon,
    message ?? `expected ${actual} to be within ${epsilon} of ${expected}`);

test('S15 PageRank defaults are the documented damping/tolerance/iteration constants', () => {
  assert.deepEqual(PAGERANK_DEFAULTS, { damping: 0.85, tolerance: 1e-8, maxIterations: 100 });
});

test('S15 two-node graph reaches the analytical stationary distribution', () => {
  const d = 0.85;
  // a -> b with b dangling. Solving r_a = (1-d)/2 + d*r_b/2 and
  // r_b = (1-d)/2 + d*r_a + d*r_b/2 gives r_b = (1-d^2)/(2-d-d^2).
  const expectedB = (1 - d * d) / (2 - d - d * d);
  const expectedA = 1 - expectedB;
  const result = computePageRank({ nodes: ['a', 'b'], edges: [{ source: 'a', target: 'b' }] });
  assert.equal(result.nodeCount, 2);
  assert.equal(result.converged, true, 'the flag reports real convergence');
  assert.ok(result.iterations >= 1 && result.iterations <= 100, 'iteration count is bounded, never infinite');
  // Stopping at tolerance 1e-8 leaves a bounded residual, hence 1e-7 here.
  approx(result.scores.get('b'), expectedB, 1e-7);
  approx(result.scores.get('a'), expectedA, 1e-7);
  approx(result.scores.get('a') + result.scores.get('b'), 1, 1e-12);

  const relaxed = computePageRank({ nodes: ['a', 'b'], edges: [{ source: 'a', target: 'b' }], tolerance: 1e-6 });
  assert.equal(relaxed.converged, true, 'a satisfied tolerance flips the flag honestly');
  assert.ok(relaxed.iterations <= result.iterations, 'a looser tolerance never needs more iterations');
  approx(relaxed.scores.get('b'), expectedB, 1e-4);
});

test('S15 empty and single-node graphs score honestly', () => {
  const empty = computePageRank({ nodes: [], edges: [] });
  assert.equal(empty.scores.size, 0, 'an empty graph has no scores at all');
  assert.equal(empty.nodeCount, 0);
  assert.equal(empty.iterations, 0);
  assert.equal(empty.converged, true);

  const single = computePageRank({ nodes: ['only'], edges: [] });
  assert.equal(single.scores.get('only'), 1);
  assert.equal(single.converged, true);

  const loop = computePageRank({ nodes: ['only'], edges: [{ source: 'only', target: 'only' }] });
  assert.equal(loop.scores.get('only'), 1, 'a self loop keeps the whole mass on the node');
  assert.equal(loop.converged, true);
});

test('S15 dangling nodes redistribute uniformly and isolates keep finite mass', () => {
  // 3-cycle plus one isolate: every cycle node must hold exactly the same
  // score at every iteration (graph symmetry), the isolate keeps only the
  // teleport/dangling share (1-d)/(N-d), and the total stays 1.
  const d = 0.85;
  const nodes = ['a', 'b', 'c', 'isolate'];
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' },
  ];
  const result = computePageRank({ nodes, edges });
  const a = result.scores.get('a');
  const b = result.scores.get('b');
  const c = result.scores.get('c');
  const isolate = result.scores.get('isolate');
  assert.equal(a, b, 'symmetric cycle nodes score identically');
  assert.equal(b, c, 'symmetric cycle nodes score identically');
  assert.ok(isolate > 0 && isolate < a, 'an isolate never collapses to zero and never outranks the cycle');
  assert.ok(Number.isFinite(isolate) && Number.isFinite(a));
  approx(isolate, (1 - d) / (4 - d), 1e-7, 'the isolate holds exactly the teleport+dangling share');
  approx(a, (1 - (1 - d) / (4 - d)) / 3, 1e-7, 'the cycle splits the remaining mass symmetrically');
  approx(a + b + c + isolate, 1, 1e-9);
  assert.equal(result.converged, true, 'symmetry holds at convergence');

  const twoIsolates = computePageRank({ nodes: ['x', 'y'], edges: [] });
  assert.equal(twoIsolates.scores.get('x'), 0.5);
  assert.equal(twoIsolates.scores.get('y'), 0.5);
  assert.equal(twoIsolates.converged, true, 'uniform scores are already fixed');
});

test('S15 a long chain converges with ascending mass toward the sink and total 1', () => {
  const count = 500;
  const nodes = Array.from({ length: count }, (_, index) => `n${index}`);
  const edges = nodes.slice(0, -1).map((node, index) => ({ source: node, target: nodes[index + 1] }));
  const result = computePageRank({ nodes, edges });
  assert.equal(result.converged, true, 'the chain converges inside the default bound');
  assert.ok(result.iterations >= 1 && result.iterations <= 100, 'bounded iteration');
  let total = 0;
  for (const node of nodes) {
    const score = result.scores.get(node);
    assert.ok(Number.isFinite(score) && score >= 0, `${node} must be finite and nonnegative`);
    total += score;
  }
  approx(total, 1, 1e-9, 'the complete graph keeps total mass 1');
  assert.ok(result.scores.get('n499') > result.scores.get('n0'), 'mass accumulates toward the sink');
});

test('S15 non-convergence is reported truthfully with a finite approximation, never a fake pass', () => {
  // A directed cycle fed by one leaf excites the slowest PageRank mode (rate
  // exactly the damping factor): 100 default iterations cannot reach 1e-8,
  // and the helper must say so instead of pretending.
  const cycleNodes = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'leaf'];
  const cycleEdges = [
    { source: 'c1', target: 'c2' },
    { source: 'c2', target: 'c3' },
    { source: 'c3', target: 'c4' },
    { source: 'c4', target: 'c5' },
    { source: 'c5', target: 'c6' },
    { source: 'c6', target: 'c1' },
    { source: 'leaf', target: 'c1' },
  ];
  const bounded = computePageRank({ nodes: cycleNodes, edges: cycleEdges });
  assert.equal(bounded.converged, false, 'the default bound truthfully reports non-convergence');
  assert.equal(bounded.iterations, 100, 'and stops exactly at the bound, never looping forever');
  let total = 0;
  for (const node of cycleNodes) {
    const score = bounded.scores.get(node);
    assert.ok(Number.isFinite(score) && score >= 0, `${node} stays a finite nonnegative approximation`);
    total += score;
  }
  approx(total, 1, 1e-9, 'even the unconverged run keeps total mass 1 over the complete graph');

  // A validated iteration cap truncates honestly too: the partial scores are
  // finite and close to, but not equal to, the converged values.
  const edges = [{ source: 'a', target: 'b' }];
  const truncated = computePageRank({ nodes: ['a', 'b'], edges, maxIterations: 3 });
  assert.equal(truncated.converged, false);
  assert.equal(truncated.iterations, 3);
  const converged = computePageRank({ nodes: ['a', 'b'], edges });
  assert.ok(truncated.scores.get('a') !== converged.scores.get('a'), 'a truncated run never fakes converged scores');
  assert.ok(Math.abs(truncated.scores.get('a') - converged.scores.get('a')) < 0.05, 'yet it stays a close approximation');
  approx(truncated.scores.get('a') + truncated.scores.get('b'), 1, 1e-12);
});

test('S15 duplicate directed pairs are deduplicated and reversed insertion is identical', () => {
  const nodes = ['a', 'b', 'c'];
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'b' }, // duplicate neighbor pair: never double weight
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' },
  ];
  const forward = computePageRank({ nodes, edges });
  const reversed = computePageRank({
    nodes: [...nodes].reverse(),
    edges: [...edges].reverse().concat([{ source: 'a', target: 'b' }]),
  });
  const sorted = result => JSON.stringify([...result.scores.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  assert.equal(sorted(forward), sorted(reversed), 'insertion order never changes a score');
  assert.equal(forward.iterations, reversed.iterations);
  assert.equal(forward.converged, reversed.converged);
  // Dedup proof: the duplicated pair must equal the same graph without it.
  const deduped = computePageRank({ nodes, edges: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' },
  ] });
  assert.equal(sorted(forward), sorted(deduped));
});

test('S15 strict validation rejects bad input before computing and preserves inputs byte for byte', () => {
  const nodes = ['a', 'b'];
  const edges = [{ source: 'a', target: 'b' }];
  const nodesBefore = JSON.stringify(nodes);
  const edgesBefore = JSON.stringify(edges);

  for (const bad of [
    computePageRank, // missing options object
    () => computePageRank('nope'),
    () => computePageRank({ nodes: 'a', edges: [] }),
    () => computePageRank({ nodes: ['a'], edges: 'a->b' }),
    () => computePageRank({ nodes: ['a'], edges: [], extraOption: 1 }),
    () => computePageRank({ nodes: ['a', 'a'], edges: [] }), // duplicate node key
    () => computePageRank({ nodes: [1], edges: [] }), // non-string node
    () => computePageRank({ nodes: ['a'], edges: [{}] }), // missing endpoints
    () => computePageRank({ nodes: ['a'], edges: [{ source: 'a', target: null }] }),
    () => computePageRank({ nodes: ['a'], edges: [{ source: 'a', target: 'ghost' }] }), // unknown endpoint
    () => computePageRank({ nodes: ['a'], edges: [], damping: NaN }),
    () => computePageRank({ nodes: ['a'], edges: [], damping: -0.1 }),
    () => computePageRank({ nodes: ['a'], edges: [], damping: 1.5 }),
    () => computePageRank({ nodes: ['a'], edges: [], damping: '0.85' }),
    () => computePageRank({ nodes: ['a'], edges: [], tolerance: 0 }),
    () => computePageRank({ nodes: ['a'], edges: [], tolerance: Infinity }),
    () => computePageRank({ nodes: ['a'], edges: [], maxIterations: 0 }),
    () => computePageRank({ nodes: ['a'], edges: [], maxIterations: 2.5 }),
    () => computePageRank({ nodes: ['a'], edges: [], maxIterations: Infinity }),
  ]) {
    assert.throws(bad, TypeError, `expected TypeError for ${bad.toString().slice(0, 80)}`);
  }
  assert.equal(JSON.stringify(nodes), nodesBefore, 'rejected input stays byte-identical');
  assert.equal(JSON.stringify(edges), edgesBefore, 'rejected input stays byte-identical');

  // Accepted optional parameters are validated too, and a valid call still
  // leaves the caller's arrays/objects untouched.
  computePageRank({ nodes, edges, damping: 0.5, tolerance: 1e-6, maxIterations: 7 });
  assert.equal(JSON.stringify(nodes), nodesBefore, 'accepted input stays byte-identical');
  assert.equal(JSON.stringify(edges), edgesBefore, 'accepted input stays byte-identical');
  assert.throws(() => computePageRank({ nodes, edges, damping: 0.5, typo: true }), TypeError);
});

test('S15 prototype-shaped keys survive as own properties without object-literal loss', () => {
  const result = computePageRank({
    nodes: ['__proto__', 'normal'],
    edges: [{ source: '__proto__', target: 'normal' }],
  });
  assert.equal(typeof result.scores.get('__proto__'), 'number');
  const asObject = Object.fromEntries(result.scores);
  assert.ok(Object.hasOwn(asObject, '__proto__'), 'representation keeps __proto__ as an own property');
  assert.equal(typeof asObject.__proto__, 'number', 'the own data property shadows the prototype accessor');
  assert.equal(Object.getPrototypeOf(asObject), Object.prototype, 'no prototype pollution');
  approx(Object.values(asObject).reduce((sum, value) => sum + value, 0), 1, 1e-9);
});

test('S15 ties and equal structures score equally so canonical key order can break rank ties', () => {
  // Two mirrored callers of one sink: identical structure => identical rank.
  const result = computePageRank({
    nodes: ['sink', 'zebra', 'alpha'],
    edges: [
      { source: 'zebra', target: 'sink' },
      { source: 'alpha', target: 'sink' },
    ],
  });
  approx(result.scores.get('zebra'), result.scores.get('alpha'), 1e-15);
  assert.ok(result.scores.get('sink') > result.scores.get('alpha'), 'the shared dependency outranks both callers');
});
