export async function detectArchitectureContext({ graph }) {
  const labels = (graph?.nodes ?? []).map((node) => String(node.label ?? node.id ?? ''));
  return {
    pattern: 'detected-structure',
    entryPoints: labels.filter((label) => /(?:^|\/)main\.[cm]?[jt]sx?$|(?:^|\/)app\.[cm]?[jt]sx?$/.test(label)),
    graphRefs: labels.map((label) => `node:${label}`),
  };
}
