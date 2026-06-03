import { createGraph } from "./graph.js";
import { updateSidebar } from "./sidebar.js";
import { initFilters, updateStats } from "./filters.js";
import { loadContext } from "./context-tracker.js";

const state = {
  graphData: null,
  worklistData: null,
  contextData: null,
  selectedNode: null,
  activeOnly: false,
  searchQuery: "",
  enabledCommunities: new Set(),
  enabledTypes: new Set(["file", "class", "method", "function", "interface"]),
};

async function loadData() {
  const [graphRes, worklistRes, contextRes] = await Promise.all([
    fetch("/api/graph"),
    fetch("/api/worklist"),
    fetch("/api/context"),
  ]);
  state.graphData = await graphRes.json();
  state.worklistData = await worklistRes.json();
  state.contextData = await contextRes.json();
  return state;
}

function getActiveNodeIds() {
  if (!state.contextData || !Array.isArray(state.contextData.activeNodeIds)) {
    return new Set();
  }
  return new Set(state.contextData.activeNodeIds);
}

function getEnrichedNodeIds() {
  if (!state.worklistData) return new Set();
  return new Set(state.worklistData.map((e) => e.graphNodeId));
}

function getWorklistStatusMap() {
  if (!state.worklistData) return new Map();
  const m = new Map();
  state.worklistData.forEach((e) => m.set(e.graphNodeId, e.status));
  return m;
}

async function init() {
  await loadData();

  const communities = [
    ...new Set(state.graphData.nodes.map((n) => n.community)),
  ].sort((a, b) => a - b);
  communities.forEach((c) => state.enabledCommunities.add(c));

  state.getEnrichedNodeIds = getEnrichedNodeIds;
  state.getWorklistStatusMap = getWorklistStatusMap;

  initFilters(state, communities);
  updateStats(state);
  createGraph(state, {
    onNodeClick: (node) => {
      state.selectedNode = node;
      updateSidebar(node, state);
    },
    getActiveNodeIds,
    getEnrichedNodeIds,
    getWorklistStatusMap,
  });
}

document.getElementById("search").addEventListener("input", (e) => {
  state.searchQuery = e.target.value.toLowerCase();
  document.dispatchEvent(new CustomEvent("graph-update", { detail: state }));
});

document.getElementById("toggle-active").addEventListener("click", (e) => {
  state.activeOnly = !state.activeOnly;
  e.target.classList.toggle("active", state.activeOnly);
  document.dispatchEvent(new CustomEvent("graph-update", { detail: state }));
});

document.getElementById("toggle-panel").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("collapsed");
  document.dispatchEvent(new CustomEvent("graph-resize"));
});

document.addEventListener("context-changed", async () => {
  const res = await fetch("/api/context");
  state.contextData = await res.json();
  document.dispatchEvent(new CustomEvent("graph-update", { detail: state }));
  updateStats(state);
});

init();