// Pattern 3 - Plan & execute (task decomposition).
// The planner breaks the goal into ordered subtasks, each assigned to a worker;
// after execution it looks at the results and decides whether to re-plan.
import { z } from "zod";
import { structured } from "./llm.js";
import { WORKERS } from "./workers.js";

const Task = z.object({
  id: z.string().describe("Short unique id such as T1"),
  title: z.string(),
  instructions: z.string().describe("What the worker must produce, specific to this project"),
  worker: z.enum(Object.keys(WORKERS)),
  depends_on: z.array(z.string()).describe("ids of tasks whose output this task needs"),
});

const Plan = z.object({
  goal: z.string(),
  tasks: z.array(Task),
});

const Replan = z.object({
  complete: z.boolean().describe("true if the results are enough to write the delivery plan"),
  reason: z.string(),
  new_tasks: z.array(Task).describe("Extra tasks to run; empty when complete"),
});

const roster = Object.entries(WORKERS)
  .map(([name, w]) => `- ${name}: ${w.description}`)
  .join("\n");

const SYSTEM = `You are the orchestrator of an AI project-delivery team. You plan; workers execute.
Workers available:
${roster}

Rules:
- Decompose the goal into 3-7 subtasks, in dependency order, one worker each.
- A task may depend only on earlier task ids. Tasks without dependencies run in parallel.
- The scheduler needs work packages with estimates, so it depends on scope work.
- Write instructions specific to this project, not generic boilerplate.`;

export async function makePlan({ brief, memoryNotes }) {
  const plan = await structured({
    name: "planner",
    system: SYSTEM,
    prompt: `<brief>\n${brief}\n</brief>\n\n<relevant_memory>\n${memoryNotes || "(none)"}\n</relevant_memory>\n\nCreate the plan.`,
    schema: Plan,
  });
  validateDependencies(plan.tasks, []);
  return plan;
}

export async function replan({ brief, plan, results }) {
  const done = results.map((r) => `### ${r.id} - ${r.title} (${r.worker})\n${r.output}`).join("\n\n");
  const decision = await structured({
    name: "replanner",
    system: SYSTEM,
    effort: "medium",
    prompt: `<brief>\n${brief}\n</brief>\n\nGoal: ${plan.goal}\n\n<completed_tasks>\n${done}\n</completed_tasks>

Is there a gap that blocks writing a complete delivery plan (scope, schedule, risks,
stakeholders/governance)? If so add at most 3 new tasks with ids not used above;
they may depend on completed task ids. Otherwise mark complete.`,
    schema: Replan,
  });
  validateDependencies(decision.new_tasks, results.map((r) => r.id));
  return decision;
}

/** Reject plans whose tasks reference unknown ids or each other in a cycle. */
export function validateDependencies(tasks, existingIds) {
  const known = new Set(existingIds);
  for (const t of tasks) {
    if (known.has(t.id)) throw new Error(`planner reused task id ${t.id}`);
    for (const dep of t.depends_on) {
      if (!known.has(dep)) throw new Error(`task ${t.id} depends on ${dep}, which is not an earlier task`);
    }
    known.add(t.id);
  }
}
