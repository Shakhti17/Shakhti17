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
  // fetch rejects header values outside Latin-1, which in practice means a mangled API key.
  if (err instanceof TypeError && /ByteString/.test(err.message)) {
    return "The Anthropic API key contains invalid characters (it was probably copied from a page that hides part of it). Put the full key in .env and restart.";
  }
  return `Something went wrong: ${err?.message ?? err}`;
}
