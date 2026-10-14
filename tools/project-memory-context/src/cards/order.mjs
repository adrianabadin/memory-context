// Leaf-first SCC batches over caller-owned graph keys and native calls edges.
// Iterative Tarjan avoids imposing the JavaScript recursion limit on a codebase.
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function endpointKey(endpoint) {
  if (!object(endpoint) || !nonempty(endpoint.id) ||
      (endpoint.symbolKey !== undefined && endpoint.symbolKey !== endpoint.id)) {
    throw new TypeError('Call edges require coherent canonical endpoint objects');
  }
  return endpoint.id;
}

export function orderNarratives(options) {
  if (!object(options) || Object.keys(options).some((key) => !['symbolKeys', 'edges'].includes(key))) {
    throw new TypeError('Narrative ordering accepts only symbolKeys and edges');
  }
  const { symbolKeys, edges = [] } = options;
  if (!Array.isArray(symbolKeys) || symbolKeys.some((key) => !nonempty(key)) || !Array.isArray(edges)) {
    throw new TypeError('Narrative ordering requires graph symbol-key and edge arrays');
  }
  const known = new Set(symbolKeys);
  if (known.size !== symbolKeys.length) throw new TypeError('Graph symbol keys must be unique');
  const adjacency = new Map([...known].sort().map((key) => [key, new Set()]));
  for (const edge of edges) {
    if (!object(edge)) throw new TypeError('Graph edges must be objects');
    if (edge.relation !== 'calls') continue;
    const source = endpointKey(edge.source), target = endpointKey(edge.target);
    // Historical native records can outlive current nodes. They neither invent
    // symbols nor impose dependencies on this caller-selected current graph.
    if (known.has(source) && known.has(target)) adjacency.get(source).add(target);
  }

  const indices = new Map(), low = new Map();
  const stack = [], onStack = new Set(), batches = [];
  let nextIndex = 0;
  function enter(node, parent) {
    indices.set(node, nextIndex);
    low.set(node, nextIndex++);
    stack.push(node);
    onStack.add(node);
    return { node, parent, children: [...adjacency.get(node)].sort(), next: 0 };
  }

  for (const start of adjacency.keys()) {
    if (indices.has(start)) continue;
    const frames = [enter(start, null)];
    while (frames.length) {
      const frame = frames.at(-1);
      if (frame.next < frame.children.length) {
        const child = frame.children[frame.next++];
        if (!indices.has(child)) frames.push(enter(child, frame.node));
        else if (onStack.has(child)) low.set(frame.node, Math.min(low.get(frame.node), indices.get(child)));
        continue;
      }
      frames.pop();
      if (frame.parent !== null) low.set(frame.parent, Math.min(low.get(frame.parent), low.get(frame.node)));
      if (low.get(frame.node) === indices.get(frame.node)) {
        const batch = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          batch.push(member);
        } while (member !== frame.node);
        // Tarjan emits each dependency SCC before its caller SCC. Sorting inputs
        // and members makes the otherwise valid topological choices repeatable.
        batches.push(batch.sort());
      }
    }
  }
  return batches;
}
