// Program Manager tools: critical-path scheduling, risk scoring and a
// persistent task board. The math happens in code, not in the model's head.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { withLock, writeFileAtomic } from "../fsutil.js";

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

const STATUSES = ["todo", "in_progress", "blocked", "done"];

/** Apply one task-board action and return { board, message }. Pure; unit-tested. */
export function applyBoardAction(board, input) {
  const tasks = board.tasks.map((t) => ({ ...t }));
  const today = new Date().toISOString().slice(0, 10);

  if (input.action === "add") {
    if (!input.title) throw new Error("title is required to add a task");
    const id = `T${board.nextId}`;
    tasks.push({
      id,
      title: input.title,
      owner: input.owner || "unassigned",
      status: input.status || "todo",
      due: input.due || "",
      notes: input.notes || "",
      updated: today,
    });
    return { board: { nextId: board.nextId + 1, tasks }, message: `Added ${id}.` };
  }

  if (input.action === "update") {
    const task = tasks.find((t) => t.id === input.id);
    if (!task) throw new Error(`no task with id ${input.id}`);
    for (const key of ["title", "owner", "status", "due", "notes"]) if (input[key]) task[key] = input[key];
    task.updated = today;
    return { board: { ...board, tasks }, message: `Updated ${task.id}.` };
  }

  if (input.action === "remove") {
    const remaining = tasks.filter((t) => t.id !== input.id);
    if (remaining.length === tasks.length) throw new Error(`no task with id ${input.id}`);
    return { board: { ...board, tasks: remaining }, message: `Removed ${input.id}.` };
  }

  // list
  if (!tasks.length) return { board, message: "The board is empty." };
  const counts = STATUSES.map((s) => `${s}: ${tasks.filter((t) => t.status === s).length}`).join(", ");
  const rows = tasks.map((t) => `| ${t.id} | ${t.title} | ${t.owner} | ${t.status} | ${t.due} | ${t.notes} |`);
  return {
    board,
    message: `${counts}\n\n| id | title | owner | status | due | notes |\n|---|---|---|---|---|---|\n${rows.join("\n")}`,
  };
}

const scale = z.number().int().describe("1 (very low) to 5 (very high)");

export function createPmTools(workspace) {
  const boardFile = path.join(workspace, "pm", "board.json");

  async function loadBoard() {
    try {
      return JSON.parse(await fs.readFile(boardFile, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return { nextId: 1, tasks: [] };
      throw err;
    }
  }

  return [
    betaZodTool({
      name: "compute_schedule",
      description:
        "Compute a critical-path schedule over working days (Mon-Fri): start/finish dates, slack, " +
        "critical path and finish date. Always use this instead of doing date arithmetic yourself.",
      inputSchema: z.object({
        start_date: z.string().describe("YYYY-MM-DD"),
        tasks: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            duration_days: z.number().int().describe("Working days, at least 1"),
            depends_on: z.array(z.string()),
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
    }),
    betaZodTool({
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
    }),
    betaZodTool({
      name: "manage_tasks",
      description:
        "The team's persistent task board (pm/board.json). Actions: add, update, remove, list. " +
        "Use it to track work, owners, status and due dates across conversations.",
      inputSchema: z.object({
        action: z.enum(["add", "update", "remove", "list"]),
        id: z.string().optional().describe("Task id for update/remove, e.g. T3"),
        title: z.string().optional(),
        owner: z.string().optional(),
        status: z.enum(STATUSES).optional(),
        due: z.string().optional().describe("YYYY-MM-DD"),
        notes: z.string().optional(),
      }),
      run: (input) =>
        // Parallel tool calls must not overwrite each other's board changes.
        withLock(boardFile, async () => {
          try {
            const { board, message } = applyBoardAction(await loadBoard(), input);
            if (input.action !== "list") await writeFileAtomic(boardFile, JSON.stringify(board, null, 2));
            return message;
          } catch (err) {
            return `Error: ${err.message}`;
          }
        }),
    }),
  ];
}
