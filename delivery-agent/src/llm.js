// Thin wrappers around the Anthropic SDK shared by every part of the agent.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

export const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5";
export const WORKER_MODEL = process.env.AGENT_WORKER_MODEL ?? MODEL;

const client = new Anthropic();

// If a safety classifier declines a request, the API re-runs it on Anthropic's
// recommended fallback model instead of returning a refusal.
const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

export class RefusalError extends Error {
  constructor(where, details) {
    super(`${where}: model declined (${details?.category ?? "no category"})`);
    this.details = details;
  }
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Run a tool-using agent loop until the model stops calling tools.
 * Returns the final text answer.
 */
export async function runToolAgent({
  name,
  system,
  prompt,
  tools,
  model = WORKER_MODEL,
  effort = "medium",
  maxIterations = 12,
}) {
  const runner = client.beta.messages.toolRunner({
    ...FALLBACK,
    model,
    max_tokens: 16000,
    output_config: { effort },
    system,
    tools,
    max_iterations: maxIterations,
    messages: [{ role: "user", content: prompt }],
  });

  for await (const message of runner) {
    // Server tools (web search) can pause a long turn; push it back to resume.
    if (message.stop_reason === "pause_turn") {
      runner.pushMessages({ role: "assistant", content: message.content });
    }
  }

  const final = await runner.done();
  if (final.stop_reason === "refusal") throw new RefusalError(name, final.stop_details);
  if (final.stop_reason === "max_tokens") {
    throw new Error(`${name}: answer was cut off at max_tokens`);
  }
  if (final.stop_reason === "tool_use") {
    throw new Error(`${name}: still calling tools after ${maxIterations} iterations`);
  }
  return textOf(final);
}

/** A single call whose reply is validated against a Zod schema. */
export async function structured({ name, system, prompt, schema, model = MODEL, effort = "high" }) {
  const response = await client.beta.messages.parse({
    ...FALLBACK,
    model,
    max_tokens: 16000,
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") throw new RefusalError(name, response.stop_details);
  if (!response.parsed_output) throw new Error(`${name}: reply did not match the schema`);
  return response.parsed_output;
}

/** A single plain-text call (used by the generator in the reflection loop). */
export async function complete({ name, system, prompt, model = MODEL, effort = "high" }) {
  const stream = client.beta.messages.stream({
    ...FALLBACK,
    model,
    max_tokens: 64000,
    output_config: { effort },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new RefusalError(name, message.stop_details);
  if (message.stop_reason === "max_tokens") throw new Error(`${name}: output was cut off`);
  return textOf(message);
}
