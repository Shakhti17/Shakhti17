// Pattern 2 - Reflection.
// Two roles: a generator writes the delivery plan, an evaluator scores it
// against a rubric and gives feedback; the loop repeats until it passes.
import { z } from "zod";
import { complete, structured } from "./llm.js";

export const RUBRIC = [
  "Grounded: every section follows from the brief and worker outputs; assumptions are labelled",
  "Complete: scope/WBS, schedule with critical path, risk register, stakeholders/RACI and governance are all present",
  "Consistent: dates, durations and ids agree across sections; schedule figures match the computed schedule",
  "Actionable: owners, next steps for the first two weeks, and clear decisions needed from the sponsor",
  "Concise: an executive summary a sponsor can read in two minutes; no filler",
];

export const PASS_SCORE = 4;

const Review = z.object({
  scores: z.array(
    z.object({
      criterion: z.string(),
      score: z.number().int().describe("1 (poor) to 5 (excellent)"),
      comment: z.string(),
    }),
  ),
  feedback: z.string().describe("Specific changes the writer must make; empty if none"),
  lessons: z
    .array(z.string())
    .describe("General, reusable lessons for writing future delivery plans (not about this project)"),
});

const WRITER = `You are a senior IT program manager writing a delivery plan for a project sponsor.
Combine the specialist outputs into one coherent Markdown document with these sections:
Executive summary, Scope & WBS, Schedule & milestones, Risk register, Stakeholders & RACI,
Governance & communication, First two weeks, Decisions needed, Assumptions.
Keep the numbers from the specialists' tool results exactly; do not invent new dates.
Output only the document.`;

const EVALUATOR = `You are a demanding PMO reviewer. Score the delivery plan against each rubric
criterion from 1 to 5, quote the problem when you mark something down, and say exactly
what to change. A score of ${PASS_SCORE} means ready to send to a sponsor.`;

export async function generate({ brief, results, previous, feedback }) {
  const inputs = results.map((r) => `### ${r.id} - ${r.title} (${r.worker})\n${r.output}`).join("\n\n");
  const revision = previous
    ? `\n\n<previous_draft>\n${previous}\n</previous_draft>\n\n<reviewer_feedback>\n${feedback}\n</reviewer_feedback>\n\nRevise the draft to address every point of feedback.`
    : "\n\nWrite the delivery plan.";
  return complete({
    name: "generator",
    system: WRITER,
    prompt: `<brief>\n${brief}\n</brief>\n\n<specialist_outputs>\n${inputs}\n</specialist_outputs>${revision}`,
  });
}

export async function evaluate({ brief, draft }) {
  const review = await structured({
    name: "evaluator",
    system: EVALUATOR,
    prompt: `<brief>\n${brief}\n</brief>\n\n<rubric>\n${RUBRIC.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n</rubric>\n\n<delivery_plan>\n${draft}\n</delivery_plan>`,
    schema: Review,
  });
  const passed = review.scores.length >= RUBRIC.length && review.scores.every((s) => s.score >= PASS_SCORE);
  const average = review.scores.reduce((n, s) => n + s.score, 0) / Math.max(review.scores.length, 1);
  return { ...review, passed, average };
}

/** Generate -> evaluate -> revise until the plan passes or rounds run out. */
export async function reflect({ brief, results, maxRounds = 3, log }) {
  let draft;
  let review;
  let round = 0;
  while (round < maxRounds) {
    round++;
    draft = await generate({ brief, results, previous: draft, feedback: review?.feedback });
    review = await evaluate({ brief, draft });
    log(`  round ${round}: average ${review.average.toFixed(1)}/5 - ${review.passed ? "passed" : "revising"}`);
    if (review.passed) break;
  }
  return { draft, review, rounds: round };
}
