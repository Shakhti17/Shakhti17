// The team lead: routes each request, plans multi-discipline work, runs the
// specialists, reviews their output and remembers what happened.
//
//   request ─► route ─┬─ direct ──────────────────────────────► reply
//                     ├─ single ─► specialist ⇄ reviewer ─────► reply
//                     └─ team ───► plan ─► waves of specialists ─► summary
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AGENTS, buildTools } from "./agents.js";
import { complete, runAgent, structured } from "./llm.js";

const AGENT_IDS = Object.keys(AGENTS);
const ROSTER = Object.entries(AGENTS)
  .map(([id, a]) => `- ${id} (${a.title}): ${a.description}`)
  .join("\n");

const PASS_SCORE = 4;
const HISTORY_TURNS = 6;

// ---------- schemas ----------

const Task = z.object({
  id: z.string().describe("Short unique id such as T1"),
  agent: z.enum(AGENT_IDS),
  title: z.string(),
  instructions: z.string().describe("Specific, self-contained instructions for the specialist"),
  depends_on: z.array(z.string()).describe("ids of earlier tasks whose output this task needs"),
});

const Route = z.object({
  mode: z.enum(["direct", "single", "team"]),
  reply: z.string().describe("direct mode only: the full answer to the user; otherwise empty"),
  agent: z.enum(AGENT_IDS).describe("single mode: the specialist to use; otherwise any value"),
  instructions: z.string().describe("single mode: the request rewritten as clear, self-contained instructions"),
  tasks: z.array(Task).describe("team mode only: 2-6 tasks in dependency order; otherwise empty"),
  needs_review: z.boolean().describe("true when the output is a deliverable (code, document, campaign, plan)"),
});

const Review = z.object({
  scores: z.array(z.object({ criterion: z.string(), score: z.number().int().describe("1-5"), comment: z.string() })),
  feedback: z.string().describe("Specific changes required; empty if none"),
  lessons: z.array(z.string()).describe("General lessons for this role's future work, not about this task; may be empty"),
});

// ---------- prompts ----------

const ROUTER = `You are the team lead of an AI team that works for one user. Your team:
${ROSTER}

For each user message, choose a mode:
- direct: greetings, questions about the team, or quick questions you can answer fully
  yourself in a few sentences. Put the answer in "reply".
- single: one specialist can do it. Most requests are single. Rewrite the request as
  clear instructions, resolving references to the recent conversation.
- team: the request clearly needs more than one discipline (e.g. "launch a product":
  plan + build + marketing). Break it into 2-6 tasks, each for one specialist; a task may
  depend on earlier tasks' outputs, and tasks without dependencies run in parallel.

Set needs_review to true for deliverables (code, plans, documents, campaigns), false for
quick answers and small edits.`;

const REVIEWER = `You are a demanding reviewer on an AI team. Score the specialist's work against each
criterion from 1 to 5. A ${PASS_SCORE} means ready to hand to the user. Quote the problem when you
mark something down and say exactly what to change. Judge only what is shown: if the work
claims something was tested but no output is shown, that is not verified.`;

const SUMMARIZER = `You are the team lead reporting back to the user after your team finished a request.
Write a short, skimmable summary: what each specialist delivered (with file paths), how the
pieces fit together, decisions the user needs to make, and recommended next steps. Don't
repeat the full deliverables.`;

// ---------- helpers ----------

export function validateDependencies(tasks) {
  const known = new Set();
  for (const t of tasks) {
    if (known.has(t.id)) throw new Error(`duplicate task id ${t.id}`);
    for (const dep of t.depends_on) {
      if (!known.has(dep)) throw new Error(`task ${t.id} depends on ${dep}, which is not an earlier task`);
    }
    known.add(t.id);
  }
}

const clipText = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text);

function describeToolCall(block) {
  const input = block.input ?? {};
  const detail = input.path ?? input.command ?? input.query ?? input.action ?? "";
  return `${block.name}${detail ? ` ${clipText(String(detail), 80).replace(/\s+/g, " ")}` : ""}`;
}

// ---------- the team ----------

export class Team {
  constructor({ workspace, memory, approve, webSearch = true, review = true, maxReviewRounds = 2, log = () => {} }) {
    Object.assign(this, { workspace, memory, approve, webSearch, review, maxReviewRounds, log });
    this.history = [];
  }

  conversationContext() {
    if (!this.history.length) return "(this is the first message)";
    return this.history
      .slice(-HISTORY_TURNS)
      .map((h) => `User: ${clipText(h.request, 1500)}\nTeam: ${clipText(h.answer, 2500)}`)
      .join("\n\n");
  }

  contextBlock(query) {
    return `<today>${new Date().toISOString().slice(0, 10)}</today>

<recent_conversation>
${this.conversationContext()}
</recent_conversation>

<relevant_memory>
${this.memory.format(this.memory.search(query, 8)) || "(none)"}
</relevant_memory>`;
  }

  async handle(request) {
    await fs.mkdir(this.workspace, { recursive: true });
    const route = await structured({
      name: "router",
      system: ROUTER,
      prompt: `${this.contextBlock(request)}\n\n<user_message>\n${request}\n</user_message>`,
      schema: Route,
    });

    let answer;
    if (route.mode === "team" && route.tasks.length) {
      validateDependencies(route.tasks);
      answer = await this.runTeam(request, route);
    } else if (route.mode === "direct" && route.reply.trim()) {
      answer = route.reply;
    } else {
      this.log(`→ ${AGENTS[route.agent].title}`);
      const result = await this.runSpecialist({
        agentId: route.agent,
        instructions: route.instructions || request,
        inputs: [],
        needsReview: route.needs_review,
      });
      answer = result.output;
    }

    this.history.push({ request, answer });
    if (route.mode !== "direct") {
      const who = route.mode === "team" ? [...new Set(route.tasks.map((t) => t.agent))].join(", ") : route.agent;
      await this.memory.add(
        "episodic",
        `${new Date().toISOString().slice(0, 10)}: ${who} handled "${clipText(request, 200)}"`,
      );
    }
    return { answer, route };
  }

  /** Pattern 3: plan & execute. Tasks run in dependency waves, in parallel within a wave. */
  async runTeam(request, route) {
    this.log(`→ Team plan:`);
    for (const t of route.tasks) {
      this.log(`   ${t.id} ${AGENTS[t.agent].title}: ${t.title}${t.depends_on.length ? ` (after ${t.depends_on.join(", ")})` : ""}`);
    }

    const results = [];
    const remaining = [...route.tasks];
    while (remaining.length) {
      const done = new Set(results.map((r) => r.id));
      const ready = remaining.filter((t) => t.depends_on.every((d) => done.has(d)));
      const outputs = await Promise.all(
        ready.map((task) =>
          this.runSpecialist({
            agentId: task.agent,
            instructions: `${task.title}\n\n${task.instructions}\n\n(Part of the user's request: "${request}")`,
            // Context engineering: each specialist only sees the outputs it depends on.
            inputs: results.filter((r) => task.depends_on.includes(r.id)),
            needsReview: route.needs_review,
            label: task.id,
          }),
        ),
      );
      ready.forEach((task, i) => {
        results.push({ ...task, output: outputs[i].output, files: outputs[i].files });
        remaining.splice(remaining.indexOf(task), 1);
      });
    }

    this.log("→ Team lead: summarising");
    const report = results
      .map((r) => `### ${r.id} - ${AGENTS[r.agent].title}: ${r.title}\nFiles: ${r.files.join(", ") || "none"}\n\n${r.output}`)
      .join("\n\n");
    return complete({
      name: "summary",
      system: SUMMARIZER,
      prompt: `<user_request>\n${request}\n</user_request>\n\n<team_outputs>\n${report}\n</team_outputs>`,
    });
  }

  /** Run one specialist, then (pattern 2) review and revise until it passes. */
  async runSpecialist({ agentId, instructions, inputs, needsReview, label = "" }) {
    const agent = AGENTS[agentId];
    const tag = `[${agent.title}${label ? ` ${label}` : ""}]`;
    const files = new Set();
    const tools = buildTools(agentId, {
      workspace: this.workspace,
      memory: this.memory,
      approve: this.approve,
      webSearch: this.webSearch,
      onWrite: (p) => files.add(p),
    });
    const teammateWork = inputs.length
      ? inputs.map((i) => `### From ${AGENTS[i.agent].title} (${i.id}: ${i.title})\n${i.output}`).join("\n\n")
      : "(none)";

    let output;
    let feedback;
    const rounds = this.review && needsReview ? this.maxReviewRounds + 1 : 1;
    for (let round = 1; round <= rounds; round++) {
      const revision = feedback
        ? `\n\n<your_previous_answer>\n${output}\n</your_previous_answer>\n\n<reviewer_feedback>\n${feedback}\n</reviewer_feedback>\n\nAddress every point of the feedback. Your earlier files are still in the workspace.`
        : "";
      output = await runAgent({
        name: tag,
        system: agent.system,
        tools,
        effort: agent.effort,
        maxIterations: agent.maxIterations,
        onToolCall: (block) => this.log(`   ${tag} ${describeToolCall(block)}`),
        prompt: `${this.contextBlock(instructions)}

<work_from_teammates>
${teammateWork}
</work_from_teammates>

<request>
${instructions}
</request>${revision}`,
      });
      if (round === rounds) break;

      const review = await this.reviewWork({ agentId, instructions, output, files: [...files] });
      for (const lesson of review.lessons) await this.memory.add("procedural", `${agent.title}: ${lesson}`);
      this.log(`   ${tag} review ${review.average.toFixed(1)}/5 - ${review.passed ? "approved" : "revising"}`);
      if (review.passed) break;
      feedback = review.feedback;
    }
    return { output, files: [...files] };
  }

  async reviewWork({ agentId, instructions, output, files }) {
    const agent = AGENTS[agentId];
    const contents = [];
    let budget = 60_000;
    for (const file of files) {
      if (budget <= 0) break;
      try {
        const text = await fs.readFile(path.join(this.workspace, file), "utf8");
        const shown = clipText(text, Math.min(budget, 20_000));
        budget -= shown.length;
        contents.push(`--- ${file} ---\n${shown}`);
      } catch {
        // The file may have been moved or deleted since; skip it.
      }
    }
    const review = await structured({
      name: "reviewer",
      system: REVIEWER,
      prompt: `<role>${agent.title}</role>

<request>
${instructions}
</request>

<rubric>
${agent.rubric.map((c, i) => `${i + 1}. ${c}`).join("\n")}
</rubric>

<specialist_answer>
${output}
</specialist_answer>

<files_written>
${contents.join("\n\n") || "(none)"}
</files_written>`,
      schema: Review,
    });
    const passed = review.scores.length >= agent.rubric.length && review.scores.every((s) => s.score >= PASS_SCORE);
    const average = review.scores.reduce((n, s) => n + s.score, 0) / Math.max(review.scores.length, 1);
    return { ...review, passed, average };
  }
}
