const COMMUNITY_COLORS_MAP = d3.scaleOrdinal(d3.schemeTableau10);

export function initFilters(state, communities) {
  const container = document.getElementById("filters");

  const communitySection = document.createElement("div");
  communitySection.innerHTML = `<h3>Communities (${communities.length})</h3>`;

  communities.forEach((c) => {
    const row = document.createElement("label");
    row.className = "filter-row";
    row.innerHTML = `<input type="checkbox" checked data-community="${c}"><span class="filter-dot" style="background:${COMMUNITY_COLORS_MAP(c)}"></span>Community ${c}`;
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