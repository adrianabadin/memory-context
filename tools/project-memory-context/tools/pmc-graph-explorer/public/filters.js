const COMMUNITY_COLORS_MAP = d3.scaleOrdinal(d3.schemeTableau10);

export function initFilters(state, communities) {
  const container = document.getElementById("filters");

  const communitySection = document.createElement("div");
  communitySection.innerHTML = `<h3>Communities (${communities.length})</h3>`;

  communities.forEach((c) => {
    const row = document.createElement("label");
    row.className = "filter-row";
    const communityName = state.communityNames?.[String(c)] ?? `Community ${c}`;
    row.innerHTML = `<input type="checkbox" checked data-community="${c}"><span class="filter-dot" style="background:${COMMUNITY_COLORS_MAP(c)}"></span>${communityName}`;
    row.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) {
        state.enabledCommunities.add(c);
      } else {
        state.enabledCommunities.delete(c);
      }
      document.dispatchEvent(new CustomEvent("graph-update", { detail: state }));
      updateStats(state);
    });
    communitySection.appendChild(row);
  });

  container.appendChild(communitySection);

  // Status ring legend — explains the colored rings drawn around enriched/stale/error nodes.
  const STATUS_LEGEND = [
    { status: 'enriched',         color: '#22c55e', label: 'Enriched' },
    { status: 'stale',            color: '#f59e0b', label: 'Stale (changed)' },
    { status: 'pending',          color: '#94a3b8', label: 'Pending (new)' },
    { status: 'error',            color: '#ef4444', label: 'Error' },
    { status: 'subagent-queued',  color: '#a78bfa', label: 'Subagent queued' },
  ];

  const legendSection = document.createElement('div');
  legendSection.className = 'legend-section';
  legendSection.innerHTML = '<h3>Enrichment Status</h3>';
  STATUS_LEGEND.forEach(({ color, label }) => {
    const row = document.createElement('div');
    row.className = 'filter-row';
    row.innerHTML = `<span class="filter-dot" style="background:transparent;border:2.5px solid ${color};box-sizing:border-box;"></span>${label}`;
    legendSection.appendChild(row);
  });

  container.appendChild(legendSection);
}

export function updateStats(state) {
  const statsEl = document.getElementById("stats");
  const nodes = state.graphData?.nodes || [];
  const activeIds = new Set(state.contextData?.activeNodeIds || []);
  const enrichedIds = state.getEnrichedNodeIds ? state.getEnrichedNodeIds() : new Set();
  const activeCount = nodes.filter((n) => activeIds.has(n.id)).length;
  const enrichedCount = nodes.filter((n) => enrichedIds.has(n.id)).length;
  const visibleCount = nodes.filter((n) => {
    const matchCommunity = state.enabledCommunities.has(n.community);
    const matchActive = !state.activeOnly || activeIds.has(n.id);
    const matchSearch = !state.searchQuery || n.label.toLowerCase().includes(state.searchQuery);
    return matchCommunity && matchActive && matchSearch;
  }).length;

  statsEl.innerHTML = `
    <span class="stat-badge">Nodes: ${nodes.length}</span>
    <span class="stat-badge">Visible: ${visibleCount}</span>
    <span class="stat-badge">Enriched: ${enrichedCount}</span>
    ${activeCount > 0 ? `<span class="stat-badge active">Active: ${activeCount}</span>` : ""}
  `;
}
