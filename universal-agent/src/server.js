#!/usr/bin/env node
// Starts the Ofis web platform.
//   APP_PASSWORD=... ANTHROPIC_API_KEY=... node src/server.js
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./web/app.js";
import { MemoryStore } from "./memory.js";

const env = process.env;

if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 8) {
  console.error("Set APP_PASSWORD (at least 8 characters) to protect the platform.");
  process.exit(1);
}
const hasCredentials = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || existsSync(path.join(os.homedir(), ".config", "anthropic"));
if (!hasCredentials) {
  console.error("No Anthropic credentials found: set ANTHROPIC_API_KEY.");
  process.exit(1);
}
if (!env.SESSION_SECRET) {
  console.warn("SESSION_SECRET is not set: you will need to sign in again after every restart.");
}

const dataDir = path.resolve(env.DATA_DIR ?? "data");
const workspace = path.resolve(env.WORKSPACE_DIR ?? "workspace");
const memory = await MemoryStore.open(path.join(dataDir, "memory.json"));

const { app } = createApp({
  workspace,
  dataDir,
  memory,
  password: env.APP_PASSWORD,
  sessionSecret: env.SESSION_SECRET,
  trustProxy: env.TRUST_PROXY === "1",
});

const port = Number(env.PORT ?? 3000);
const host = env.HOST ?? "127.0.0.1";
app.listen(port, host, () => {
  console.log(`Ofis is running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(`Workspace: ${workspace}\nData: ${dataDir}`);
});
