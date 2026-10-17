const COMMUNITY_COLORS = d3.scaleOrdinal(d3.schemeTableau10);

// Status ring colors — drawn as an outer ring around each node.
// Only nodes present in the worklist get a ring; untracked nodes have none.
const STATUS_RING_COLOR = {
  enriched:         '#22c55e',  // green-500
  stale:            '#f59e0b',  // amber-500
  error:            '#ef4444',  // red-500
  pending:          '#94a3b8',  // slate-400 (subtle — never enriched)
  already_enriched: '#22c55e',  // same green as enriched
  'subagent-queued': '#a78bfa', // violet-400 — queued for subagent enrichment
};

const EDGE_RELATION_THICKNESS = {
  imports_from: 2,
  imports: 1.5,
  contains: 1,
  method: 1,
  calls: 1.5,
  inherits: 2,
  case_of: 1,
};

function nodeRadius(node) {
  const label = (node.label || "").toLowerCase();
  if (/\.(ts|js|mjs|json)$/.test(label)) return 12;
  if (label.includes("(")) return 5;
  return 8;
}

export function createGraph(state, callbacks) {
  const container = document.getElementById("canvas");
  const svg = d3.select("#graph-svg");
  const tooltip = document.getElementById("tooltip");
  const width = container.clientWidth;
  const height = container.clientHeight;

  svg.attr("viewBox", [0, 0, width, height]);

  const g = svg.append("g");

  const zoom = d3.zoom()
    .scaleExtent([0.1, 8])
    .on("zoom", (event) => {
      g.attr("transform", event.transform);
    });

  svg.call(zoom);

  const { nodes, links } = state.graphData;
  const activeIds = callbacks.getActiveNodeIds();
  const enrichedIds = callbacks.getEnrichedNodeIds();
  // Full status map: graphNodeId → status string ('enriched', 'stale', 'error', 'pending', …)
  const worklistStatusMap = callbacks.getWorklistStatusMap ? callbacks.getWorklistStatusMap() : new Map();

  const defs = svg.append("defs");
  const filter = defs.append("filter").attr("id", "glow");
  filter.append("feGaussianBlur").attr("stdDeviation", "6").attr("result", "blur");
  filter.append("feMerge").selectAll("feMergeNode")
    .data(["blur", "SourceGraphic"])
    .join("feMergeNode")
    .attr("in", (d) => d);

  const linkElements = g.append("g")
    .attr("class", "links")
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("stroke", "#475569")
    .attr("stroke-opacity", 0.15)
    .attr("stroke-width", (d) => EDGE_RELATION_THICKNESS[d.relation] || 1);

  const nodeGroups = g.append("g")
    .attr("class", "nodes")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", "node-group")
    .style("cursor", "pointer");

  nodeGroups.filter((d) => activeIds.has(d.id))
    .append("circle")
    .attr("r", (d) => nodeRadius(d) + 6)
    .attr("fill", "none")
    .attr("stroke", "#06b6d4")
    .attr("stroke-width", 2)
    .attr("filter", "url(#glow)")
    .attr("class", "active-halo");

  // Status ring: drawn for every node that has a worklist entry.
  // Ring sits just outside the node fill circle, inside the active halo.
  nodeGroups.filter((d) => worklistStatusMap.has(d.id))
    .append("circle")
    .attr("r", (d) => nodeRadius(d) + 3)
    .attr("fill", "none")
    .attr("stroke", (d) => STATUS_RING_COLOR[worklistStatusMap.get(d.id)] || '#94a3b8')
    .attr("stroke-width", 2.5)
    .attr("class", "status-ring");

  nodeGroups.append("circle")
    .attr("r", (d) => nodeRadius(d))
    .attr("fill", (d) => COMMUNITY_COLORS(d.community))
    .attr("fill-opacity", (d) => activeIds.has(d.id) ? 1 : 0.7)
    .attr("stroke", (d) => activeIds.has(d.id) ? "#06b6d4" : "#1e293b")
    .attr("stroke-width", (d) => activeIds.has(d.id) ? 2 : 1);

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(40).strength(0.5))
    .force("charge", d3.forceManyBody().strength(-80))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius((d) => nodeRadius(d) + 4))
    .alphaDecay(0.02)
    .on("tick", ticked);

  function ticked() {
    linkElements
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    nodeGroups.attr("transform", (d) => `translate(${d.x},${d.y})`);
  }

  const drag = d3.drag()
    .on("start", (event, d) => {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on("end", (event, d) => {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });

  nodeGroups.call(drag);

  nodeGroups
    .on("mouseover", (event, d) => {
      const status = worklistStatusMap.get(d.id) || (enrichedIds.has(d.id) ? "enriched" : "not tracked");
      const active = activeIds.has(d.id) ? " | IN CONTEXT" : "";
      const ringColor = STATUS_RING_COLOR[status];
      const statusBadge = ringColor
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ringColor};margin-right:4px;vertical-align:middle;"></span>`
        : '';
      const communityName = state.communityNames?.[String(d.community)] ?? `Community ${d.community}`;
      tooltip.innerHTML = `<strong>${d.label}</strong><br><code>${d.source_file}:${d.source_location}</code><br>${communityName} | ${statusBadge}${status}${active}`;
      tooltip.classList.add("visible");
      tooltip.style.left = `${event.offsetX + 12}px`;
      tooltip.style.top = `${event.offsetY - 8}px`;
    })
    .on("mouseout", () => {
      tooltip.classList.remove("visible");
    })
    .on("click", (event, d) => {
      event.stopPropagation();
      callbacks.onNodeClick(d);
    })
    .on("dblclick", (event, d) => {
      event.stopPropagation();
      const scale = 2;
      const transform = d3.zoomIdentity
        .translate(width / 2 - d.x * scale, height / 2 - d.y * scale)
        .scale(scale);
      svg.transition().duration(400).call(zoom.transform, transform);
    });

  document.addEventListener("graph-update", (e) => {
    applyFilters(e.detail, nodeGroups, linkElements, simulation);
  });

  document.addEventListener("graph-resize", () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    svg.attr("viewBox", [0, 0, w, h]);
    simulation.force("center", d3.forceCenter(w / 2, h / 2));
    simulation.alpha(0.3).restart();
  });
}

function applyFilters(state, nodeGroups, linkElements, simulation) {
  const activeIds = new Set(
    state.contextData?.activeNodeIds || []
  );
  const q = state.searchQuery;

  nodeGroups.style("display", (d) => {
    const matchSearch = !q || d.label.toLowerCase().includes(q) || d.source_file.toLowerCase().includes(q);
    const matchCommunity = state.enabledCommunities.has(d.community);
    const kind = inferKind(d.label);
    const matchType = state.enabledTypes.has(kind);
    const matchActive = !state.activeOnly || activeIds.has(d.id);
    return matchSearch && matchCommunity && matchType && matchActive ? null : "none";
  });

  if (q) {
    nodeGroups.select("circle:not(.active-halo)")
      .attr("fill-opacity", (d) => d.label.toLowerCase().includes(q) ? 1 : 0.15);
  } else {
    nodeGroups.select("circle:not(.active-halo)")
      .attr("fill-opacity", (d) => activeIds.has(d.id) ? 1 : 0.7);
  }

  simulation.alpha(0.1).restart();
}

function inferKind(label) {
  if (/\.(ts|js|mjs|json)$/.test(label)) return "file";
  if (label.includes("(")) return "method";
  return "class";
}
