// The developer's shell. Every command needs approval (from the user, or
// --yes), runs inside the workspace, and never sees the Anthropic credentials.
import { exec } from "node:child_process";
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

const MAX_OUTPUT = 20_000;

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("ANTHROPIC_")) delete env[key];
  return env;
}

function clip(text) {
  if (text.length <= MAX_OUTPUT) return text;
  const half = MAX_OUTPUT / 2;
  return `${text.slice(0, half)}\n[... ${text.length - MAX_OUTPUT} chars omitted ...]\n${text.slice(-half)}`;
}

export function runCommand(command, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: cleanEnv() }, (err, stdout, stderr) => {
      const timedOut = Boolean(err?.killed);
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, timedOut, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function createShellTool(workspace, { approve, timeoutMs = 120_000 }) {
  return betaZodTool({
    name: "run_command",
    description:
      "Run a shell command in the workspace root (install packages, run tests, build, run scripts). " +
      `Commands time out after ${timeoutMs / 1000}s, so never start long-running servers or watchers; ` +
      "test servers with a script that starts, checks and stops them.",
    inputSchema: z.object({
      command: z.string(),
      reason: z.string().describe("One short sentence telling the user why you need to run this"),
    }),
    run: async ({ command, reason }) => {
      if (!(await approve(command, reason))) {
        return "The user declined to run this command. Ask them or continue another way.";
      }
      const r = await runCommand(command, { cwd: workspace, timeoutMs });
      return [
        `exit code: ${r.code}${r.timedOut ? " (timed out)" : ""}`,
        "--- stdout ---",
        clip(r.stdout) || "(empty)",
        "--- stderr ---",
        clip(r.stderr) || "(empty)",
      ].join("\n");
    },
  });
}
