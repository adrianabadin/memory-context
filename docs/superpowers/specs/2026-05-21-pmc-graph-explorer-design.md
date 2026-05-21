# PMC Graph Explorer - Design Spec

**Date:** 2026-05-21
**Status:** Draft
**Scope:** V1 - Graph visualization for PMC enrichment data

## Problem

PMC generates a structural dependency graph (`graph.json`) with 360+ nodes and enrichment status per symbol. There is no visual way to explore which symbols are enriched, which are in the agent's active context, or how they relate to each other. The CLI (`pmc status`) shows counts only.

## Solution

A single-page web UI that renders the PMC graph as an interactive D3.js force-directed visualization. Symbols that are "in context" (consulted, read, or retrieved) are highlighted with a luminous glow effect.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Layout | Force-directed graph | Shows real relationships (imports, calls, containment) organically |
| Stack | Vanilla HTML/CSS/JS + D3.js v7 | No build step, served statically, minimal dependencies |
| Theme | Dark minimal | Reduces visual noise, makes glow effects pop |
| Context highlight | Cyan glow + pulse animation | Immediately distinguishable without color-only reliance |
| Side panel | Collapsible detail view | Keeps canvas maximized, shows info on demand |

## Layout

Single-page fullscreen, no scroll. Three zones:

```
+--------------------------------------------------+
|  HEADER (56px fixed)                             |
|  Title | Stats | Search | Filters               |
+--------+-----------------------------------------+
| SIDE   |                                         |
| PANEL  |     FORCE-DIRECTED GRAPH CANVAS         |
| 280px  |     (D3.js SVG, zoom/pan/drag)          |
| collap-|                                         |
| sable  |                                         |
+--------+-----------------------------------------+
```

- **Header**: title "PMC Graph Explorer", active node counter, search input, community filter toggles
- **Side Panel** (280px, collapsible): selected node detail + relationship list. Auto-collapses below 768px viewport
- **Canvas**: D3.js SVG fills remaining space

## Graph Visualization

### Nodes

| Property | Rule |
|----------|------|
| Color | By `community` field, using `d3.schemeTableau10` |
| Radius | File = 12px, Class/Interface = 8px, Method/Function = 5px |
| Active context | Cyan halo (`#06b6d4`) with 6px blur + subtle pulse animation (2s infinite) |
| Hover | Tooltip showing `label`, `source_file`, `source_location`, `community` |

### Edges

| Property | Rule |
|----------|------|
| Default | `#475569` at 0.15 opacity |
| Selected node | Edges highlight in source community color, others dim |
| Thickness | `imports_from` = 2px, `contains` = 1px, other = 1.5px |

### Interactions

- **Zoom**: mouse wheel
- **Pan**: drag on background
- **Drag node**: reposition individual nodes
- **Click node**: open side panel with detail
- **Double-click node**: center + zoom to node's neighborhood (1 hop)

## Side Panel - Node Detail

When a node is selected, the side panel shows:

1. Symbol name (`label`)
2. Kind badge (file, class, method, etc.)
3. Source location (`source_file:source_location`)
4. Community badge with matching color
5. "EN CONTEXTO" badge if the node is active
6. Incoming relationships list (clickable, navigates to source node)
7. Outgoing relationships list (clickable, navigates to target node)

## Stats Bar and Filters

### Stats

- Total nodes
- Enriched nodes (from `worklist.json`)
- Active context nodes
- Per-community breakdown

### Filters

- Community checkboxes (colored by palette)
- Type filter (file / class / method)
- "Solo contexto activo" toggle: hides non-active nodes
- Search input: filters nodes by name, auto-highlights matches

## Context Tracking

A node is "in context" if **any** of:

1. Returned by a `/get-context` query (tracked via session log)
2. Its memory was retrieved via `agent-memory` (tag match)
3. Its source file was read with the `Read` tool during the session

### Implementation

- A `context-tracker.json` file in `.planning/project-memory-context/` stores active node IDs
- Updated by the backend on each agent operation
- UI polls or reads this file to mark active nodes
- Initial version: manual seed or CLI command to populate the tracker

## Tech Stack

| Component | Choice | Version |
|-----------|--------|---------|
| HTML/CSS/JS | Vanilla | ES2022+ |
| Graph rendering | D3.js | v7 via CDN |
| Server | Express or `npx serve` | Static file serving |
| Data source | `graph.json`, `worklist.json`, `context-tracker.json` | Direct file reads |

### File Structure

```
tools/pmc-graph-explorer/
  index.html          # Single page entry point
  styles.css          # Dark minimal theme
  app.js              # App initialization, layout, state management
  graph.js            # D3 force simulation, rendering, interactions
  sidebar.js          # Side panel logic
  filters.js          # Search, community/type filters, stats
  context-tracker.js  # Context tracking state and UI updates
```

## Visual Theme (Dark Minimal)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#0f172a` (slate-900) | Page background |
| `--bg-surface` | `#1e293b` (slate-800) | Side panel, header |
| `--bg-elevated` | `#334155` (slate-700) | Cards, inputs |
| `--text-primary` | `#e2e8f0` (slate-200) | Body text |
| `--text-secondary` | `#94a3b8` (slate-400) | Labels, metadata |
| `--accent` | `#06b6d4` (cyan-500) | Active context glow, links |
| `--accent-dim` | `#0891b2` (cyan-600) | Hover states |
| `--border` | `#475569` (slate-600) | Dividers, edges |

### Typography

| Role | Font | Size | Weight |
|------|------|------|--------|
| Title | Inter / system sans | 18px | 600 |
| Body | Inter / system sans | 14px | 400 |
| Label | Inter / system sans | 12px | 500 |
| Code/path | JetBrains Mono / monospace | 12px | 400 |

## Accessibility

- All interactive elements have focus-visible rings (2px cyan outline)
- Tooltip content available via aria-label on nodes
- Side panel close button has aria-label
- Color not sole indicator: active nodes use glow + badge text
- Keyboard navigation: Tab between controls, Enter to select node
- Respects `prefers-reduced-motion`: disables pulse animation

## Performance

- 360 nodes is well within D3 force simulation comfort zone
- Use `requestAnimationFrame` for render loop
- Debounce search input (300ms)
- Edges rendered as single path element per group when possible
- SVG layer for graph, HTML overlay for tooltips (avoids SVG text layout cost)

## Out of Scope (V1)

- Real-time WebSocket updates (polling or manual refresh instead)
- Multi-project switching
- Edit/enrichment actions from the UI
- Export/share functionality
- Authentication
