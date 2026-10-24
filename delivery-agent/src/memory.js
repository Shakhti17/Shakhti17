// Pattern 5 - Memory & context management.
// A small persistent store with the three long-term memory types:
//   semantic   - facts about the organisation ("we deploy on AWS", "team of 6")
//   episodic   - what happened on earlier projects (summary + review score)
//   procedural - how to do the job better (lessons from the evaluator)
// Working memory is the per-run state the orchestrator keeps in src/agent.js.
import fs from "node:fs/promises";
import path from "node:path";

const KINDS = ["semantic", "episodic", "procedural"];

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or our that the this to was we were will with".split(" "),
);

function tokens(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export class MemoryStore {
  constructor(file) {
    this.file = file;
    this.data = { semantic: [], episodic: [], procedural: [] };
  }

  static async open(file) {
    const store = new MemoryStore(file);
    try {
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      for (const kind of KINDS) store.data[kind] = saved[kind] ?? [];
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return store;
  }

  async add(kind, text, meta = {}) {
    if (!KINDS.includes(kind)) throw new Error(`unknown memory kind: ${kind}`);
    const clean = text.trim();
    if (!clean || this.data[kind].some((m) => m.text === clean)) return;
    this.data[kind].push({ text: clean, created: new Date().toISOString(), ...meta });
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2));
  }

  /** Keyword-overlap retrieval. Procedural lessons always rank (they apply to every plan). */
  search(query, limit = 8) {
    const q = new Set(tokens(query));
    const scored = [];
    for (const kind of KINDS) {
      for (const m of this.data[kind]) {
        const overlap = tokens(m.text).filter((t) => q.has(t)).length;
        const score = overlap + (kind === "procedural" ? 0.5 : 0);
        if (score > 0) scored.push({ kind, ...m, score });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  format(memories) {
    return memories.map((m) => `- [${m.kind}] ${m.text}`).join("\n");
  }

  get size() {
    return KINDS.reduce((n, k) => n + this.data[k].length, 0);
  }
}
