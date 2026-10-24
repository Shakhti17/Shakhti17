// Starts a real Ofis web server, backed by the mock Messages API, for the Python
// bridge tests. Prints one JSON line {"url", "token"} once it is listening.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, json, startMockApi, text, toolCall } from "../../../test/mock-api.js";

const TOKEN = "telegram-bridge-test-token-0123456789abcdef";

await startMockApi((body) => {
  const { system, first, toolResults } = describe(body);
  if (system.includes("You are the team lead of an AI team")) {
    const message = first.split("<user_message>\n")[1] ?? "";
    if (message.startsWith("Who am I")) {
      return json({ mode: "direct", reply: "You asked me to build hello.js earlier.", agent: "program_manager", instructions: "", tasks: [], needs_review: false });
    }
    return json({ mode: "single", reply: "", agent: "senior_developer", instructions: "Write hello.js and run it.", tasks: [], needs_review: false });
  }
  if (system.includes("You are the Senior Developer")) {
    if (toolResults.length === 0) return toolCall("write_file", { path: "hello/hello.js", content: "console.log('salom from telegram')" });
    if (toolResults.length === 1) return toolCall("run_command", { command: "node hello/hello.js", reason: "check that it runs" });
    return text(`Built hello/hello.js.\n\n${toolResults[1].content}`);
  }
  return null;
});

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ofis-tg-"));
const { createApp } = await import("../../../src/web/app.js");
const { MemoryStore } = await import("../../../src/memory.js");
const memory = await MemoryStore.open(path.join(dir, "data", "memory.json"));
const { app } = createApp({
  workspace: path.join(dir, "workspace"),
  dataDir: path.join(dir, "data"),
  memory,
  password: "not-used-by-bots",
  apiToken: TOKEN,
});
const server = app.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: TOKEN }));
});
process.on("SIGTERM", async () => {
  server.closeAllConnections();
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
  process.exit(0);
});
