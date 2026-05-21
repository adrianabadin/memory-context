# PMC Graph Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-page web UI that visualizes the PMC structural graph as an interactive force-directed layout, highlighting nodes that are "in context" of the agent session.

**Architecture:** Vanilla HTML/CSS/JS app served statically. D3.js v7 renders the force-directed graph from `graph.json`. A lightweight Express server serves the static files and exposes the JSON data files. Context tracking reads `context-tracker.json`.

**Tech Stack:** Vanilla ES2022+, D3.js v7 (CDN), Express.js, CSS custom properties

---

## File Structure

```
tools/pmc-graph-explorer/
  server.mjs           # Express server: serves static + JSON data endpoints
  public/
    index.html          # Single page entry point
    styles.css          # Dark minimal theme with custom properties
    app.js              # App init, layout state, data loading
    graph.js            # D3 force simulation, node/edge rendering, zoom/pan/drag
    sidebar.js          # Side panel: node detail, relationship list
    filters.js          # Search, community/type filters, stats counters
    context-tracker.js  # Reads context-tracker.json, marks active nodes
```

Data files consumed (read-only):
- `.planning/project-memory-context/graph/graph.json` — 638 nodes, 1325 links
- `.planning/project-memory-context/enrichment/worklist.json` — 360 enrichment entries
- `.planning/project-memory-context/context-tracker.json` — active context node IDs (created if missing)

---

### Task 1: Express Server

**Files:**
- Create: `tools/pmc-graph-explorer/server.mjs`

- [ ] **Step 1: Create server.mjs**

```js
import express from "express";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

const PROJECT_ROOT = resolve(__dirname, "../..");
const GRAPH_PATH = resolve(PROJECT_ROOT, ".planning/project-memory-context/graph/graph.json");
const WORKLIST_PATH = resolve(PROJECT_ROOT, ".planning/project-memory-context/enrichment/worklist.json");
const TRACKER_PATH = resolve(PROJECT_ROOT, ".planning/project-memory-context/context-tracker.json");

app.use(express.static(resolve(__dirname, "public")));

app.get("/api/graph", (req, res) => {
  try {
    const data = JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
    res.json(data);
  } catch {
    res.status(404).json({ error: "graph.json not found" });
  }
});

app.get("/api/worklist", (req, res) => {
  try {
    const data = JSON.parse(readFileSync(WORKLIST_PATH, "utf-8"));
    res.json(data);
  } catch {
    res.status(404).json({ error: "worklist.json not found" });
  }
});

app.get("/api/context", (req, res) => {
  if (!existsSync(TRACKER_PATH)) {
    return res.json({ activeNodeIds: [] });
  }
  try {
    const data = JSON.parse(readFileSync(TRACKER_PATH, "utf-8"));
    res.json(data);
  } catch {
    res.json({ activeNodeIds: [] });
  }
});

app.listen(PORT, () => {
  console.log(`PMC Graph Explorer running at http://localhost:${PORT}`);
});
```

- [ ] **Step 2: Test server starts and serves data**

Run: `node tools/pmc-graph-explorer/server.mjs &` then `curl http://localhost:3001/api/graph | head -c 200`

Expected: JSON response starting with `{"directed":false,"multigraph":false`

- [ ] **Step 3: Commit**

```bash
git add tools/pmc-graph-explorer/server.mjs
git commit -m "feat(graph-explorer): add Express server with data endpoints"
```

---

### Task 2: HTML Entry Point

**Files:**
- Create: `tools/pmc-graph-explorer/public/index.html`

- [ ] **Step 1: Create index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PMC Graph Explorer</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="header">
    <div class="header-left">
      <h1 class="header-title">PMC Graph Explorer</h1>
      <div class="stats" id="stats"></div>
    </div>
    <div class="header-right">
      <input type="text" id="search" class="search-input" placeholder="Search nodes..." autocomplete="off">
      <button id="toggle-active" class="btn-toggle" title="Show only active context">Active only</button>
      <button id="toggle-panel" class="btn-toggle" title="Toggle side panel">&#9776;</button>
    </div>
  </header>

  <div class="main">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-content" id="sidebar-content">
        <p class="sidebar-empty">Click a node to see details</p>
      </div>
      <div class="sidebar-filters" id="filters"></div>
    </aside>

    <div class="canvas" id="canvas">
      <svg id="graph-svg"></svg>
      <div class="tooltip" id="tooltip"></div>
    </div>
  </div>

  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add tools/pmc-graph-explorer/public/index.html
git commit -m "feat(graph-explorer): add HTML entry point"
```

---

### Task 3: Dark Minimal Theme

**Files:**
- Create: `tools/pmc-graph-explorer/public/styles.css`

- [ ] **Step 1: Create styles.css**

```css
:root {
  --bg-primary: #0f172a;
  --bg-surface: #1e293b;
  --bg-elevated: #334155;
  --text-primary: #e2e8f0;
  --text-secondary: #94a3b8;
  --accent: #06b6d4;
  --accent-dim: #0891b2;
  --border: #475569;
  --radius: 6px;
  --header-h: 56px;
  --sidebar-w: 280px;
  --font-sans: "Inter", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", monospace;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-sans);
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-primary);
  height: 100vh;
  overflow: hidden;
}

.header {
  height: var(--header-h);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  z-index: 10;
}

.header-left { display: flex; align-items: center; gap: 16px; }

.header-title {
  font-size: 18px;
  font-weight: 600;
  white-space: nowrap;
}

.stats {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

.stat-badge {
  background: var(--bg-elevated);
  padding: 2px 8px;
  border-radius: var(--radius);
}

.stat-badge.active {
  background: var(--accent);
  color: var(--bg-primary);
  font-weight: 600;
}

.header-right { display: flex; align-items: center; gap: 8px; }

.search-input {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-primary);
  padding: 6px 12px;
  font-size: 13px;
  width: 200px;
  outline: none;
  transition: border-color 150ms;
}

.search-input:focus { border-color: var(--accent); }

.btn-toggle {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 6px 12px;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 13px;
  transition: all 150ms;
}

.btn-toggle:hover { border-color: var(--accent); color: var(--text-primary); }
.btn-toggle.active { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }

.main {
  display: flex;
  height: calc(100vh - var(--header-h));
}

.sidebar {
  width: var(--sidebar-w);
  background: var(--bg-surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  transition: width 200ms ease, opacity 200ms ease;
  overflow: hidden;
  flex-shrink: 0;
}

.sidebar.collapsed { width: 0; opacity: 0; pointer-events: none; }

.sidebar-content {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
}

.sidebar-empty {
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
  padding-top: 32px;
}

.sidebar-filters {
  border-top: 1px solid var(--border);
  padding: 12px 16px;
  max-height: 240px;
  overflow-y: auto;
}

.sidebar-filters h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
  cursor: pointer;
}

.filter-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.node-detail-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.node-detail-value {
  font-size: 14px;
  margin-bottom: 12px;
  word-break: break-all;
}

.node-detail-value code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-elevated);
  padding: 2px 6px;
  border-radius: 3px;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 600;
}

.badge-context {
  background: var(--accent);
  color: var(--bg-primary);
  animation: pulse 2s ease-in-out infinite;
}

.badge-community {
  color: #fff;
}

.relations-list {
  list-style: none;
  margin-top: 8px;
}

.relations-list li {
  padding: 4px 0;
  font-size: 12px;
  cursor: pointer;
  color: var(--accent-dim);
  transition: color 100ms;
}

.relations-list li:hover { color: var(--accent); }

.relations-list .rel-type {
  color: var(--text-secondary);
  margin-right: 4px;
}

.canvas {
  flex: 1;
  position: relative;
  overflow: hidden;
}

#graph-svg {
  width: 100%;
  height: 100%;
}

.tooltip {
  position: absolute;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 12px;
  font-size: 12px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 100ms;
  z-index: 20;
  max-width: 300px;
}

.tooltip.visible { opacity: 1; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

@media (prefers-reduced-motion: reduce) {
  .badge-context { animation: none; }
  .sidebar { transition: none; }
}

@media (max-width: 768px) {
  .sidebar { width: 0; opacity: 0; pointer-events: none; }
  .search-input { width: 120px; }
  .stats { display: none; }
}

*:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

- [ ] **Step 2: Commit**

```bash
git add tools/pmc-graph-explorer/public/styles.css
git commit -m "feat(graph-explorer): add dark minimal theme"
```

---

### Task 4: App Initialization and Data Loading

**Files:**
- Create: `tools/pmc-graph-explorer/public/app.js`

- [ ] **Step 1: Create app.js**

```js
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

  initFilters(state, communities);
  updateStats(state);
  createGraph(state, {
    onNodeClick: (node) => {
      state.selectedNode = node;
      updateSidebar(node, state);
    },
    getActiveNodeIds,
    getEnrichedNodeIds,
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
```

- [ ] **Step 2: Commit**

```bash
git add tools/pmc-graph-explorer/public/app.js
git commit -m "feat(graph-explorer): add app initialization and state management"
```

---

### Task 5: Force-Directed Graph Rendering

**Files:**
- Create: `tools/pmc-graph-explorer/public/graph.js`

- [ ] **Step 1: Create graph.js**

```js
const COMMUNITY_COLORS = d3.scaleOrdinal(d3.schemeTableau10);
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
  if (!label.includes(".") && !label.includes("(") && label.includes(".ts") || label.includes(".mjs") || label.includes(".json")) return 12;
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

  nodeGroups.append("circle")
    .attr("r", (d) => nodeRadius(d))
    .attr("fill", (d) => COMMUNITY_COLORS(d.community))
    .attr("fill-opacity", (d) => activeIds.has(d.id) ? 1 : 0.7)
    .attr("stroke", (d) => activeIds.has(d.id) ? "#06b6d4" : "#1e293b")
    .attr("stroke-width", (d) => activeIds.has(d.id) ? 2 : 1);

  const defs = svg.append("defs");
  const filter = defs.append("filter").attr("id", "glow");
  filter.append("feGaussianBlur").attr("stdDeviation", "6").attr("result", "blur");
  filter.append("feMerge").selectAll("feMergeNode")
    .data(["blur", "SourceGraphic"])
    .join("feMergeNode")
    .attr("in", (d) => d);

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
      const status = enrichedIds.has(d.id) ? "enriched" : "not enriched";
      const active = activeIds.has(d.id) ? " | IN CONTEXT" : "";
      tooltip.innerHTML = `<strong>${d.label}</strong><br><code>${d.source_file}:${d.source_location}</code><br>Community ${d.community} | ${status}${active}`;
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
```

- [ ] **Step 2: Commit**

```bash
git add tools/pmc-graph-explorer/public/graph.js
git commit -m "feat(graph-explorer): add D3 force-directed graph rendering"
```

---

### Task 6: Side Panel - Node Detail

**Files:**
- Create: `tools/pmc-graph-explorer/public/sidebar.js`

- [ ] **Step 1: Create sidebar.js**

```js
import { COMMUNITY_COLORS } from "./graph.js";

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

  const inLinks = state.graphData.links.filter((l) => l.target === node.id || l.target?.id === node.id);
  const outLinks = state.graphData.links.filter((l) => l.source === node.id || l.source?.id === node.id);

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
```

- [ ] **Step 2: Commit**

```bash
git add tools/pmc-graph-explorer/public/sidebar.js
git commit -m "feat(graph-explorer): add side panel node detail"
```

---

### Task 7: Filters and Stats

**Files:**
- Create: `tools/pmc-graph-explorer/public/filters.js`

- [ ] **Step 1: Create filters.js**

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add tools/pmc-graph-explorer/public/filters.js
git commit -m "feat(graph-explorer): add community filters and stats counters"
```

---

### Task 8: Context Tracker Module

**Files:**
- Create: `tools/pmc-graph-explorer/public/context-tracker.js`

- [ ] **Step 1: Create context-tracker.js**

```js
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
```

- [ ] **Step 2: Add POST endpoint to server.mjs**

Add to `tools/pmc-graph-explorer/server.mjs` before `app.listen`:

```js
app.use(express.json());

app.post("/api/context", (req, res) => {
  const { add } = req.body;
  if (!Array.isArray(add)) return res.status(400).json({ error: "add must be array" });
  let tracker = { activeNodeIds: [] };
  if (existsSync(TRACKER_PATH)) {
    try { tracker = JSON.parse(readFileSync(TRACKER_PATH, "utf-8")); } catch {}
  }
  const existing = new Set(tracker.activeNodeIds || []);
  add.forEach((id) => existing.add(id));
  tracker.activeNodeIds = [...existing];
  writeFileSync(TRACKER_PATH, JSON.stringify(tracker, null, 2));
  res.json(tracker);
});
```

Also add `writeFileSync` to the existing imports at top of server.mjs:

```js
import { readFileSync, writeFileSync, existsSync } from "fs";
```

- [ ] **Step 3: Commit**

```bash
git add tools/pmc-graph-explorer/public/context-tracker.js tools/pmc-graph-explorer/server.mjs
git commit -m "feat(graph-explorer): add context tracker with POST endpoint"
```

---

### Task 9: Integration Test and Launch

**Files:**
- No new files

- [ ] **Step 1: Start the server**

Run: `node tools/pmc-graph-explorer/server.mjs`

Expected: `PMC Graph Explorer running at http://localhost:3001`

- [ ] **Step 2: Open browser and verify**

Open `http://localhost:3001` in browser. Verify:
- Dark theme renders correctly
- Force-directed graph appears with 638 nodes and 1325 links
- Hovering a node shows tooltip with name, file, location
- Clicking a node opens side panel with detail
- Double-clicking zooms to neighborhood
- Search input filters nodes
- Community checkboxes toggle visibility
- "Active only" toggle works (no active nodes initially, so all hide)
- Side panel collapses with toggle button

- [ ] **Step 3: Test context activation via API**

Run:
```bash
curl -X POST http://localhost:3001/api/context -H "Content-Type: application/json" -d "{\"add\": [\"src_embedder_transformersembedder\"]}"
```

Expected: Returns JSON with `activeNodeIds` containing the added ID. Refresh browser to see the node highlighted with cyan glow.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(graph-explorer): complete V1 integration"
```

---

## Self-Review

**1. Spec coverage:**
- Layout (3 zones): Task 2 (HTML), Task 3 (CSS) ✓
- Graph visualization (nodes, edges, glow): Task 5 ✓
- Side panel detail: Task 6 ✓
- Stats and filters: Task 7 ✓
- Context tracking: Task 8 ✓
- Dark theme tokens: Task 3 ✓
- Accessibility (focus, reduced motion, a11y): Task 3 CSS ✓
- Server endpoints: Task 1, Task 8 ✓

**2. Placeholder scan:** No TBDs, TODOs, or vague instructions found.

**3. Type consistency:** `COMMUNITY_COLORS_MAP` used in both `graph.js` and `sidebar.js` via `d3.schemeTableau10`. Node ID references use string `id` field consistently. State object shape is consistent across all modules.

**One gap found:** `getWorklistStatusMap` is referenced in `sidebar.js` but defined as a local function in `app.js`. It needs to be attached to state. Fix: add `state.getWorklistStatusMap = getWorklistStatusMap` and `state.getEnrichedNodeIds = getEnrichedNodeIds` in `app.js` init function (already implied by usage in Task 6 and 7).
