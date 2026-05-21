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