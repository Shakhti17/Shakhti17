// Thin wrappers around the Anthropic SDK shared by the whole team.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

export const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5";

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

function checkStop(name, message) {
  if (message.stop_reason === "refusal") throw new RefusalError(name, message.stop_details);
  if (message.stop_reason === "max_tokens") throw new Error(`${name}: output was cut off at max_tokens`);
}

/**
 * Run a tool-using agent until it stops calling tools; returns its final text.
 * Streams each turn so large tool inputs (whole files) arrive without timeouts.
 */
export async function runAgent({
  name,
  system,
  prompt,
  tools,
  model = MODEL,
  effort = "high",
  maxIterations = 20,
  onToolCall = () => {},
}) {
  const runner = client.beta.messages.toolRunner({
    ...FALLBACK,
    model,
    max_tokens: 64000,
    output_config: { effort },
    system,
    tools,
    max_iterations: maxIterations,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  });

  for await (const stream of runner) {
    const message = await stream.finalMessage();
    for (const block of message.content) {
      if (block.type === "tool_use" || block.type === "server_tool_use") onToolCall(block);
    }
    // Server tools (web search) can pause a long turn; push it back to resume.
    if (message.stop_reason === "pause_turn") {
      runner.pushMessages({ role: "assistant", content: message.content });
    }
  }

  const final = await runner.done();
  checkStop(name, final);
  if (final.stop_reason === "tool_use") {
    throw new Error(`${name}: still calling tools after ${maxIterations} iterations`);
  }
  return textOf(final);
}

/** A single call whose reply is validated against a Zod schema. */
export async function structured({ name, system, prompt, schema, model = MODEL, effort = "medium" }) {
  const response = await client.beta.messages.parse({
    ...FALLBACK,
    model,
    max_tokens: 16000,
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  checkStop(name, response);
  if (!response.parsed_output) throw new Error(`${name}: reply did not match the schema`);
  return response.parsed_output;
}

/** A single plain-text call. */
export async function complete({ name, system, prompt, model = MODEL, effort = "medium" }) {
  const stream = client.beta.messages.stream({
    ...FALLBACK,
    model,
    max_tokens: 64000,
    output_config: { effort },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  checkStop(name, message);
  return textOf(message);
}
