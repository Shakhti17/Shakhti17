#!/usr/bin/env node
// Usage:
//   node src/cli.js                       interactive chat with the team
//   node src/cli.js "Build a todo API"    one request, then exit
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { Team } from "./team.js";
import { AGENTS } from "./agents.js";
import { MemoryStore } from "./memory.js";
import { RefusalError } from "./llm.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: "string", default: "workspace" },
    memory: { type: "string", default: "data/memory.json" },
    yes: { type: "boolean", default: false },
    "no-web": { type: "boolean", default: false },
    "no-review": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const HELP = `Usage: node src/cli.js [request] [options]

Chat with an AI team: Program Manager, Senior Developer and Marketing Manager.
Without a request it starts an interactive chat.

Options:
  --workspace <dir>  where the team saves code and documents (default: workspace)
  --memory <file>    long-term memory file (default: data/memory.json)
  --yes              run shell commands without asking (only in a sandbox you trust)
  --no-web           disable web search
  --no-review        skip the reviewer loop (faster and cheaper)

In the chat: /team lists the specialists, /exit quits.`;

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const hasCredentials =
  process.env.ANTHROPIC_API_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  existsSync(path.join(os.homedir(), ".config", "anthropic"));
if (!hasCredentials) {
  console.error("No Anthropic credentials found: set ANTHROPIC_API_KEY (or run `ant auth login`).");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const interactive = positionals.length === 0;

// rl.question never settles once input closes (Ctrl-D, end of piped input), so reject instead.
let inputClosed = false;
rl.on("close", () => {
  inputClosed = true;
});
function prompt(query) {
  if (inputClosed) return Promise.reject(new Error("input closed"));
  return new Promise((resolve, reject) => {
    const onClose = () => reject(new Error("input closed"));
    rl.once("close", onClose);
    rl.question(query).then(
      (answer) => {
        rl.off("close", onClose);
        resolve(answer);
      },
      reject,
    );
  });
}

// Approvals are serialised so parallel specialists never ask at the same time.
let approvalQueue = Promise.resolve();
function approve(command, reason) {
  if (values.yes) return Promise.resolve(true);
  if (!process.stdin.isTTY && !interactive) {
    console.error(`  ⚠ Declined "${command}": no terminal to ask for approval (use --yes to allow commands).`);
    return Promise.resolve(false);
  }
  const ask = approvalQueue.then(async () => {
    const answer = await prompt(`\n  ⚠ Run command? ${reason}\n    $ ${command}\n    [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  });
  approvalQueue = ask.catch(() => false);
  return ask;
}

const memory = await MemoryStore.open(path.resolve(values.memory));
const team = new Team({
  workspace: path.resolve(values.workspace),
  memory,
  approve,
  webSearch: !values["no-web"],
  review: !values["no-review"],
  log: (line) => console.error(line),
});

async function ask(request) {
  try {
    const { answer } = await team.handle(request);
    console.log(`\n${answer}\n`);
  } catch (err) {
    if (err instanceof RefusalError) console.error(`Stopped: ${err.message}`);
    else if (err instanceof Anthropic.AuthenticationError) {
      console.error("Authentication failed: set ANTHROPIC_API_KEY (or run `ant auth login`).");
    } else if (err instanceof Anthropic.RateLimitError) console.error("Rate limited by the API - wait a moment and try again.");
    else if (err instanceof Anthropic.APIConnectionError) console.error(`Could not reach the Anthropic API: ${err.message}`);
    else if (err instanceof Anthropic.APIError) console.error(`API error ${err.status}: ${err.message}`);
    else console.error(err);
    return false;
  }
  return true;
}

if (!interactive) {
  const ok = await ask(positionals.join(" "));
  rl.close();
  process.exit(ok ? 0 : 1);
}

console.log(`Your AI team is ready. Workspace: ${team.workspace}
Ask for anything: plans, code, marketing. /team lists specialists, /exit quits.\n`);
while (true) {
  let request;
  try {
    request = (await prompt("you › ")).trim();
  } catch {
    break; // Ctrl-D / closed input
  }
  if (!request) continue;
  if (request === "/exit" || request === "/quit") break;
  if (request === "/team") {
    for (const a of Object.values(AGENTS)) console.log(`- ${a.title}: ${a.description}`);
    continue;
  }
  await ask(request);
}
rl.close();
