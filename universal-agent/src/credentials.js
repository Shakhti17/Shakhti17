// Detects whether the Anthropic SDK will find credentials, so the CLI and the
// server can fail early with a clear message instead of on the first request.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Load ./.env if present. Variables already set in the environment win. */
export function loadDotEnv(file = ".env") {
  if (existsSync(file) && typeof process.loadEnvFile === "function") process.loadEnvFile(file);
}

export function credentialSource(env = process.env) {
  if (env.ANTHROPIC_API_KEY) return "api key";
  if (env.ANTHROPIC_AUTH_TOKEN) return "auth token";
  // Workload identity federation: the SDK exchanges a short-lived identity token
  // from the cloud/CI provider for an access token, so no API key is stored.
  const federation =
    env.ANTHROPIC_FEDERATION_RULE_ID &&
    env.ANTHROPIC_ORGANIZATION_ID &&
    env.ANTHROPIC_SERVICE_ACCOUNT_ID &&
    (env.ANTHROPIC_IDENTITY_TOKEN_FILE || env.ANTHROPIC_IDENTITY_TOKEN);
  if (federation) return "identity federation";
  if (env.ANTHROPIC_PROFILE || existsSync(path.join(os.homedir(), ".config", "anthropic"))) return "profile";
  return null;
}

/**
 * Problems with credential values that would otherwise fail on every request with
 * a cryptic error, e.g. a key copied from a UI that masks secrets with "•".
 */
export function credentialProblem(env = process.env) {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    const value = env[name];
    if (!value) continue;
    const bad = [...value].findIndex((ch) => ch.charCodeAt(0) > 126 || ch.charCodeAt(0) < 33);
    if (bad !== -1) {
      return (
        `${name} contains an invalid character at position ${bad + 1} ("${value[bad]}"). ` +
        "It was probably copied from a page that hides part of the key; paste the full key again."
      );
    }
  }
  return null;
}

export const MISSING_CREDENTIALS =
  "No Anthropic credentials found. Set ANTHROPIC_API_KEY, configure identity federation " +
  "(ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_SERVICE_ACCOUNT_ID and " +
  "ANTHROPIC_IDENTITY_TOKEN_FILE), or run `ant auth login`.";
