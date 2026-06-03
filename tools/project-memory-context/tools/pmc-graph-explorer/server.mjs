import express from "express";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Project root = where the user ran the command (their project directory)
const projectRoot = process.env.PMC_PROJECT_ROOT
  ? resolve(process.env.PMC_PROJECT_ROOT)
  : resolve(process.cwd());

const GRAPH_PATH = resolve(projectRoot, ".planning/project-memory-context/graph/graph.json");
const WORKLIST_PATH = resolve(projectRoot, ".planning/project-memory-context/enrichment/worklist.json");
const TRACKER_PATH = resolve(projectRoot, ".planning/project-memory-context/context-tracker.json");

if (!existsSync(resolve(projectRoot, ".planning/project-memory-context"))) {
  console.error(`Error: No PMC data found at ${projectRoot}`);
  console.error(`Run this command from a project with .planning/project-memory-context/`);
  process.exit(1);
}

const app = express();
const PORT = 3001;

app.use(express.static(resolve(__dirname, "public")));
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`PMC Graph Explorer running at http://localhost:${PORT}`);
  console.log(`Project root: ${projectRoot}`);
}).on('error', (err) => {
  console.error(`[pmc-server] Failed to start on port ${PORT}: ${err.message}`);
  process.exit(1);
});
