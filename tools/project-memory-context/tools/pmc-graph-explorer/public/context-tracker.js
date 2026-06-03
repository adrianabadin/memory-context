export async function loadContext() {
  try {
    const res = await fetch("/api/context");
    if (!res.ok) return { activeNodeIds: [] };
    return await res.json();
  } catch {
    return { activeNodeIds: [] };
  }
}

export async function markNodesActive(nodeIds) {
  await fetch("/api/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ add: nodeIds }),
  });
  document.dispatchEvent(new CustomEvent("context-changed"));
}