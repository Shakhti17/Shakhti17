import Anthropic from "@anthropic-ai/sdk";
import { RefusalError } from "./llm.js";

/** A one-line, user-facing explanation of a failed request. */
export function describeError(err) {
  if (err instanceof RefusalError) return `Stopped: ${err.message}`;
  if (err instanceof Anthropic.AuthenticationError) {
    return "Authentication failed: set ANTHROPIC_API_KEY (or run `ant auth login`).";
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Anthropic API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return `Something went wrong: ${err?.message ?? err}`;
}
