// Pattern 1 - Tool use / function calling.
// The model decides when to call these; the deterministic work (date math,
// critical path, risk scoring, file access, memory) happens in code, not in
// the model's head.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

// ---------- pure functions (unit-tested) ----------

function addWorkingDays(date, days) {
  const d = new Date(date);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d;
}

function nextWorkingDay(date) {
  const d = new Date(date);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Critical-path schedule over working days (Mon-Fri).
 * tasks: [{ id, name, duration_days, depends_on: [id] }]
 */
export function computeSchedule(tasks, startDate) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!byId.has(dep)) throw new Error(`task "${t.id}" depends on unknown task "${dep}"`);
    }
  }

  // Kahn's algorithm: topological order + cycle detection.
  const indegree = new Map(tasks.map((t) => [t.id, (t.depends_on ?? []).length]));
  const queue = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const t of tasks) {
      if ((t.depends_on ?? []).includes(id)) {
        indegree.set(t.id, indegree.get(t.id) - 1);
        if (indegree.get(t.id) === 0) queue.push(t.id);
      }
    }
  }
  if (order.length !== tasks.length) {
    const stuck = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
    throw new Error(`dependency cycle among: ${stuck.join(", ")}`);
  }

  // Forward pass (earliest start/finish, in working-day offsets).
  const es = new Map();
  const ef = new Map();
  for (const id of order) {
    const t = byId.get(id);
    const start = Math.max(0, ...(t.depends_on ?? []).map((d) => ef.get(d)));
    es.set(id, start);
    ef.set(id, start + t.duration_days);
  }
  const projectDays = Math.max(0, ...ef.values());

  // Backward pass (latest finish) to find slack and the critical path.
  const lf = new Map();
  for (const id of [...order].reverse()) {
    const successors = tasks.filter((t) => (t.depends_on ?? []).includes(id));
    lf.set(id, successors.length ? Math.min(...successors.map((s) => lf.get(s.id) - s.duration_days)) : projectDays);
  }

  const start = nextWorkingDay(new Date(`${startDate}T00:00:00Z`));
  const schedule = order.map((id) => {
    const t = byId.get(id);
    const slack = lf.get(id) - ef.get(id);
    return {
      id,
      name: t.name,
      duration_days: t.duration_days,
      start: iso(addWorkingDays(start, es.get(id))),
      // A 1-day task that starts on day 0 finishes the same day.
      finish: iso(addWorkingDays(start, Math.max(ef.get(id) - 1, es.get(id)))),
      slack_days: slack,
      critical: slack === 0,
    };
  });

  return {
    project_start: iso(start),
    project_finish: iso(addWorkingDays(start, Math.max(projectDays - 1, 0))),
    total_working_days: projectDays,
    critical_path: schedule.filter((s) => s.critical).map((s) => s.id),
    schedule,
  };
}

/** Probability x impact (each 1-5) exposure scoring, highest first. */
export function scoreRisks(risks) {
  return risks
    .map((r) => {
      const clamp = (n) => Math.min(5, Math.max(1, Math.round(n)));
      const probability = clamp(r.probability);
      const impact = clamp(r.impact);
      const exposure = probability * impact;
      const rating = exposure >= 15 ? "critical" : exposure >= 10 ? "high" : exposure >= 5 ? "medium" : "low";
      return { ...r, probability, impact, exposure, rating };
    })
    .sort((a, b) => b.exposure - a.exposure);
}

/** Resolve a model-supplied path and refuse anything outside the workspace. */
export function resolveInside(root, requested) {
  const base = path.resolve(root);
  const target = path.resolve(base, requested);
  const rel = path.relative(base, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("path escapes the workspace");
  }
  return target;
}

// ---------- tool definitions ----------

const scale = z.number().int().describe("1 (very low) to 5 (very high)");

export function createTools({ memory, workspaceDir, webSearch = false }) {
  const readProjectFile = betaZodTool({
    name: "read_project_file",
    description:
      "Read a text file from the project workspace (briefs, requirements, notes). " +
      "Pass '.' to list the files available.",
    inputSchema: z.object({ path: z.string().describe("Path relative to the workspace") }),
    run: async ({ path: p }) => {
      try {
        const target = resolveInside(workspaceDir, p);
        const stat = await fs.stat(target);
        if (stat.isDirectory()) return (await fs.readdir(target)).join("\n");
        const text = await fs.readFile(target, "utf8");
        return text.length > 60000 ? `${text.slice(0, 60000)}\n[truncated: file is ${text.length} chars]` : text;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  });

  const computeScheduleTool = betaZodTool({
    name: "compute_schedule",
    description:
      "Compute a critical-path schedule over working days (Mon-Fri). Returns start/finish " +
      "dates, slack, the critical path and the project finish date. Always use this instead " +
      "of doing date arithmetic yourself.",
    inputSchema: z.object({
      start_date: z.string().describe("YYYY-MM-DD"),
      tasks: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          duration_days: z.number().int().describe("Working days, at least 1"),
          depends_on: z.array(z.string()).describe("ids of tasks that must finish first"),
        }),
      ),
    }),
    run: async ({ start_date, tasks }) => {
      try {
        return JSON.stringify(computeSchedule(tasks, start_date), null, 2);
      } catch (err) {
        return `Error: ${err.message}. Fix the task list and call again.`;
      }
    },
  });

  const scoreRisksTool = betaZodTool({
    name: "score_risks",
    description: "Score risks by probability x impact and return them ranked with a rating.",
    inputSchema: z.object({
      risks: z.array(
        z.object({
          id: z.string(),
          description: z.string(),
          probability: scale,
          impact: scale,
          mitigation: z.string(),
          owner: z.string(),
        }),
      ),
    }),
    run: async ({ risks }) => JSON.stringify(scoreRisks(risks), null, 2),
  });

  const recallMemory = betaZodTool({
    name: "recall_memory",
    description:
      "Search long-term memory: facts about the organisation, lessons from past plans, " +
      "and summaries of earlier projects.",
    inputSchema: z.object({ query: z.string() }),
    run: async ({ query }) => memory.format(memory.search(query, 6)) || "No matching memories.",
  });

  const saveMemory = betaZodTool({
    name: "save_memory",
    description:
      "Save a durable fact about the organisation (e.g. team size, tooling, constraints) that " +
      "future projects should know. Do not save project-specific details.",
    inputSchema: z.object({ fact: z.string() }),
    run: async ({ fact }) => {
      await memory.add("semantic", fact);
      return "Saved.";
    },
  });

  const tools = {
    read_project_file: readProjectFile,
    compute_schedule: computeScheduleTool,
    score_risks: scoreRisksTool,
    recall_memory: recallMemory,
    save_memory: saveMemory,
  };
  if (webSearch) tools.web_search = { type: "web_search_20260209", name: "web_search", max_uses: 3 };
  return tools;
}
