#!/usr/bin/env node
// Usage: node src/cli.js <brief.md> [--web] [--out <dir>] [--memory <file>]
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { runDeliveryAgent } from "./agent.js";
import { RefusalError } from "./llm.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    web: { type: "boolean", default: false },
    out: { type: "string", default: "output" },
    memory: { type: "string", default: "data/memory.json" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.error(`Usage: node src/cli.js <brief.md> [options]

Turns an IT project brief into a reviewed delivery plan.

Options:
  --web            let the risk analyst use web search
  --out <dir>      where to write the plan (default: output)
  --memory <file>  long-term memory file (default: data/memory.json)`);
  process.exit(values.help ? 0 : 1);
}

const briefPath = path.resolve(positionals[0]);

try {
  const brief = await fs.readFile(briefPath, "utf8");
  const { outputFile, review } = await runDeliveryAgent({
    brief,
    workspaceDir: path.dirname(briefPath),
    memoryFile: path.resolve(values.memory),
    outDir: path.resolve(values.out),
    webSearch: values.web,
  });
  console.log(`\nDelivery plan written to ${outputFile} (review ${review.average.toFixed(1)}/5)`);
} catch (err) {
  if (err instanceof RefusalError) {
    console.error(`Stopped: ${err.message}`);
  } else if (err instanceof Anthropic.AuthenticationError) {
    console.error("Authentication failed: set ANTHROPIC_API_KEY (or run `ant auth login`).");
  } else if (err instanceof Anthropic.RateLimitError) {
    console.error("Rate limited by the API - wait a moment and try again.");
  } else if (err instanceof Anthropic.APIError) {
    console.error(`API error ${err.status}: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
