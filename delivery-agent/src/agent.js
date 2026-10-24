// The orchestrator: wires the five patterns together.
//
//   memory ──► planner ──► workers (parallel waves, tool use) ──► re-plan?
//                                                                   │
//   memory ◄── lessons ◄── evaluator ◄── generator ◄────────────────┘
import fs from "node:fs/promises";
import path from "node:path";
import { MemoryStore } from "./memory.js";
import { createTools } from "./tools.js";
import { makePlan, replan } from "./planner.js";
import { runWorker } from "./workers.js";
import { reflect } from "./reflection.js";

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";
}

/** Run tasks in dependency waves; tasks within a wave run in parallel. */
async function executeTasks({ tasks, results, brief, tools, memory, log }) {
  const remaining = [...tasks];
  while (remaining.length) {
    const doneIds = new Set(results.map((r) => r.id));
    const ready = remaining.filter((t) => t.depends_on.every((d) => doneIds.has(d)));
    if (!ready.length) throw new Error(`no runnable tasks left: ${remaining.map((t) => t.id).join(", ")}`);

    log(`  wave: ${ready.map((t) => `${t.id} (${t.worker})`).join(", ")}`);
    const outputs = await Promise.all(
      ready.map((task) =>
        runWorker({
          task,
          brief,
          tools,
          // Context engineering: a worker only sees the outputs it depends on.
          inputs: results.filter((r) => task.depends_on.includes(r.id)),
          memoryNotes: memory.format(memory.search(`${task.title} ${task.instructions}`, 5)),
        }),
      ),
    );
    ready.forEach((task, i) => {
      results.push({ ...task, output: outputs[i] });
      remaining.splice(remaining.indexOf(task), 1);
    });
  }
}

export async function runDeliveryAgent({
  brief,
  workspaceDir,
  memoryFile,
  outDir,
  webSearch = false,
  maxReplans = 1,
  maxReflectionRounds = 3,
  log = (msg) => console.error(msg),
}) {
  const memory = await MemoryStore.open(memoryFile);
  const tools = createTools({ memory, workspaceDir, webSearch });
  log(`Memory: ${memory.size} items loaded from ${memoryFile}`);

  log("Planning...");
  const plan = await makePlan({ brief, memoryNotes: memory.format(memory.search(brief, 10)) });
  log(`  goal: ${plan.goal}`);
  for (const t of plan.tasks) log(`  ${t.id} [${t.worker}] ${t.title}${t.depends_on.length ? ` <- ${t.depends_on.join(", ")}` : ""}`);

  // Working memory for this run: every completed task and its output.
  const results = [];
  let pending = plan.tasks;
  for (let round = 0; ; round++) {
    log("Executing...");
    await executeTasks({ tasks: pending, results, brief, tools, memory, log });
    if (round >= maxReplans) break;

    log("Checking for gaps...");
    const decision = await replan({ brief, plan, results });
    log(`  ${decision.complete ? "complete" : "re-planning"}: ${decision.reason}`);
    if (decision.complete || !decision.new_tasks.length) break;
    pending = decision.new_tasks;
  }

  log("Writing and reviewing the delivery plan...");
  const { draft, review, rounds } = await reflect({ brief, results, maxRounds: maxReflectionRounds, log });

  const reviewTable = review.scores.map((s) => `| ${s.criterion} | ${s.score}/5 | ${s.comment} |`).join("\n");
  const document = `${draft}

---

## Appendix: automated review

Result: **${review.passed ? "passed" : "did not pass"}** after ${rounds} round(s), average ${review.average.toFixed(1)}/5.

| Criterion | Score | Comment |
|---|---|---|
${reviewTable}
`;

  await fs.mkdir(outDir, { recursive: true });
  const outputFile = path.join(outDir, `${slugify(plan.goal)}.md`);
  await fs.writeFile(outputFile, document);

  // Long-term memory: remember the episode and the reusable lessons.
  const date = new Date().toISOString().slice(0, 10);
  await memory.add(
    "episodic",
    `${date}: planned "${plan.goal}" with ${results.length} tasks; review ${review.average.toFixed(1)}/5 ` +
      `(${review.passed ? "passed" : "did not pass"}) after ${rounds} round(s).`,
  );
  for (const lesson of review.lessons) await memory.add("procedural", lesson);
  log(`Memory: ${memory.size} items saved to ${memoryFile}`);

  return { plan, results, draft, review, rounds, outputFile };
}
