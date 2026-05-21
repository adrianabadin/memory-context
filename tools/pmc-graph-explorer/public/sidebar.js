const COMMUNITY_COLORS_MAP = d3.scaleOrdinal(d3.schemeTableau10);

export function updateSidebar(node, state) {
  const container = document.getElementById("sidebar-content");
  if (!node) {
    container.innerHTML = '<p class="sidebar-empty">Click a node to see details</p>';
    return;
  }

  const activeIds = new Set(state.contextData?.activeNodeIds || []);
  const isActive = activeIds.has(node.id);
  const worklistMap = state.getWorklistStatusMap ? state.getWorklistStatusMap() : new Map();
  const enrichStatus = worklistMap.get(node.id) || "unknown";

  const inLinks = state.graphData.links.filter((l) => l.target === node.id || (l.target && l.target.id === node.id));
  const outLinks = state.graphData.links.filter((l) => l.source === node.id || (l.source && l.source.id === node.id));

  const kind = inferKind(node.label);

  container.innerHTML = `
    <div class="node-detail">
      <div class="node-detail-label">Name</div>
      <div class="node-detail-value">${escapeHtml(node.label)}</div>

      <div class="node-detail-label">Kind</div>
      <div class="node-detail-value"><span class="badge" style="background:var(--bg-elevated)">${kind}</span></div>

      <div class="node-detail-label">Source</div>
      <div class="node-detail-value"><code>${escapeHtml(node.source_file)}:${escapeHtml(node.source_location)}</code></div>

      <div class="node-detail-label">Community</div>
      <div class="node-detail-value">
        <span class="badge badge-community" style="background:${COMMUNITY_COLORS_MAP(node.community)}">Community ${node.community}</span>
      </div>

      <div class="node-detail-label">Enrichment</div>
      <div class="node-detail-value">
        <span class="badge" style="background:var(--bg-elevated)">${enrichStatus}</span>
      </div>

      ${isActive ? '<div class="node-detail-value"><span class="badge badge-context">EN CONTEXTO</span></div>' : ""}

      <div class="node-detail-label">Incoming (${inLinks.length})</div>
      <ul class="relations-list">
        ${inLinks.map((l) => {
          const srcId = typeof l.source === "object" ? l.source.id : l.source;
          const srcNode = state.graphData.nodes.find((n) => n.id === srcId);
          return `<li data-node-id="${srcId}"><span class="rel-type">${l.relation}</span>${srcNode ? escapeHtml(srcNode.label) : srcId}</li>`;
        }).join("")}
      </ul>

      <div class="node-detail-label">Outgoing (${outLinks.length})</div>
      <ul class="relations-list">
        ${outLinks.map((l) => {
          const tgtId = typeof l.target === "object" ? l.target.id : l.target;
          const tgtNode = state.graphData.nodes.find((n) => n.id === tgtId);
          return `<li data-node-id="${tgtId}"><span class="rel-type">${l.relation}</span>${tgtNode ? escapeHtml(tgtNode.label) : tgtId}</li>`;
        }).join("")}
      </ul>
    </div>
  `;

  container.querySelectorAll("[data-node-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const targetId = el.getAttribute("data-node-id");
      const targetNode = state.graphData.nodes.find((n) => n.id === targetId);
      if (targetNode) {
        state.selectedNode = targetNode;
        updateSidebar(targetNode, state);
      }
    });
  });
}

function inferKind(label) {
  if (/\.(ts|js|mjs|json)$/.test(label)) return "file";
  if (label.includes("(")) return "method";
  return "class";
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}