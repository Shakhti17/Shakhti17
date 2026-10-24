// The web platform end to end: auth, a chat run streamed over SSE with a
// command approved from the "browser", files, and security headers, against
// the mock Messages API.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, json, startMockApi, text, toolCall } from "./mock-api.js";

const PASSWORD = "correct horse battery";

function respond(body) {
  const { system, toolResults } = describe(body);
  if (system.includes("You are the team lead of an AI team")) {
    return json({
      mode: "single",
      reply: "",
      agent: "senior_developer",
      instructions: "Write a hello script and run it.",
      tasks: [],
      needs_review: false,
    });
  }
  if (system.includes("You are the Senior Developer")) {
    if (toolResults.length === 0) return toolCall("write_file", { path: "hello/hello.js", content: "console.log('hello from ofis')" });
    if (toolResults.length === 1) return toolCall("run_command", { command: "node hello/hello.js", reason: "check that it runs" });
    return text(`Done.\n\n${toolResults[1].content}`);
  }
  return null;
}

async function startPlatform(t, { apiToken = "" } = {}) {
  const mock = await startMockApi(respond);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ofis-"));
  const { createApp } = await import("../src/web/app.js");
  const { MemoryStore } = await import("../src/memory.js");
  const memory = await MemoryStore.open(path.join(dir, "data", "memory.json"));
  const { app } = createApp({ workspace: path.join(dir, "workspace"), dataDir: path.join(dir, "data"), memory, password: PASSWORD, apiToken });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
    await fs.rm(dir, { recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (p, { method = "GET", body } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  };
  return { base, call, cookie: () => cookie, dir };
}

/** Read SSE events from an open stream until `until(event)` returns true. */
async function readEvents(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("event stream ended");
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (data && (await onEvent(JSON.parse(data.slice(6))))) {
        await reader.cancel();
        return;
      }
    }
  }
}

test("web platform: sign in, chat with approval, files", async (t) => {
  const { base, call, cookie } = await startPlatform(t);

  // Locked until signed in.
  assert.equal((await call("/api/conversations")).status, 401);
  assert.deepEqual(await (await call("/api/me")).json(), { authenticated: false });
  assert.equal((await call("/api/login", { method: "POST", body: { password: "nope" } })).status, 401);
  const login = await call("/api/login", { method: "POST", body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.deepEqual(await (await call("/api/me")).json(), { authenticated: true });

  // Security headers on every response.
  const page = await call("/");
  assert.match(await page.text(), /<title>Ofis<\/title>/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await call("/vendor/marked.js")).status, 200);
  assert.equal((await call("/vendor/purify.js")).status, 200);
  assert.equal((await call("/vendor/fonts/unbounded-latin-600-normal.woff2")).status, 200);

  // Start a conversation and listen to its events.
  const conversation = await (await call("/api/conversations", { method: "POST" })).json();
  const events = await fetch(`${base}/api/conversations/${conversation.id}/events`, { headers: { cookie: cookie() } });
  assert.equal(events.headers.get("content-type"), "text/event-stream");

  const sent = await call(`/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    body: { text: "Write a hello script and run it", review: false, webSearch: false },
  });
  assert.equal(sent.status, 202);

  const seen = [];
  let reply;
  await readEvents(events, async (event) => {
    seen.push(event.type);
    if (event.type === "approval") {
      assert.equal(event.approval.command, "node hello/hello.js");
      // One message at a time per conversation.
      const busy = await call(`/api/conversations/${conversation.id}/messages`, { method: "POST", body: { text: "again" } });
      assert.equal(busy.status, 409);
      const approved = await call(`/api/approvals/${event.approval.id}`, { method: "POST", body: { approved: true } });
      assert.equal(approved.status, 200);
    }
    if (event.type === "message" && event.message.role !== "user") {
      reply = event.message;
      return true;
    }
    return false;
  });

  assert.equal(reply.role, "assistant", reply.text);
  assert.equal(reply.agent, "senior_developer");
  assert.match(reply.text, /hello from ofis/);
  assert.ok(reply.steps.some((s) => s.includes("[Senior Developer] write_file hello/hello.js")));
  for (const type of ["snapshot", "status", "message", "step", "approval", "approval_resolved"]) {
    assert.ok(seen.includes(type), `missing ${type} event`);
  }

  // The conversation was saved with a title and both messages.
  const saved = await (await call(`/api/conversations/${conversation.id}`)).json();
  assert.equal(saved.title, "Write a hello script and run it");
  assert.deepEqual(saved.messages.map((m) => m.role), ["user", "assistant"]);
  const list = await (await call("/api/conversations")).json();
  assert.equal(list[0].id, conversation.id);

  // Files: listed, viewable as plain text, downloadable, and confined to the workspace.
  const { files } = await (await call("/api/files")).json();
  assert.deepEqual(files, ["hello/", "hello/hello.js"]);
  const view = await call("/api/files/content?path=hello/hello.js");
  assert.match(view.headers.get("content-type"), /^text\/plain/);
  assert.equal(await view.text(), "console.log('hello from ofis')");
  const download = await call("/api/files/content?download=1&path=hello/hello.js");
  assert.match(download.headers.get("content-disposition"), /attachment; filename="?hello\.js"?/);
  assert.equal((await call("/api/files/content?path=../data/memory.json")).status, 400);
  assert.equal((await call("/api/files/content?path=missing.txt")).status, 404);

  // Board and memory endpoints.
  assert.deepEqual(await (await call("/api/board")).json(), { nextId: 1, tasks: [] });
  assert.ok("episodic" in (await (await call("/api/memory")).json()));

  // Unknown or malformed conversation ids are 404, and deleting works.
  assert.equal((await call("/api/conversations/not-an-id")).status, 404);
  assert.equal((await call(`/api/conversations/${conversation.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(`/api/conversations/${conversation.id}`)).status, 404);

  // Signing out clears the session.
  await call("/api/logout", { method: "POST" });
  assert.equal((await call("/api/conversations")).status, 401);
});

test("web platform: repeated wrong passwords are locked out", async (t) => {
  const { call } = await startPlatform(t);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call("/api/login", { method: "POST", body: { password: "guess" } })).status, 401);
  }
  assert.equal((await call("/api/login", { method: "POST", body: { password: PASSWORD } })).status, 429);
});

test("web platform: bots can use the API with a bearer token", async (t) => {
  const TOKEN = "a".repeat(20) + "-bot-token-" + "b".repeat(20);
  const { base } = await startPlatform(t, { apiToken: TOKEN });
  const bot = (p, { method = "GET", body, token = TOKEN } = {}) =>
    fetch(base + p, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });

  assert.equal((await bot("/api/conversations")).status, 200);
  assert.deepEqual(await (await bot("/api/me")).json(), { authenticated: true });
  assert.equal((await bot("/api/conversations", { token: "wrong-token" })).status, 401);
  assert.equal((await bot("/api/conversations", { token: TOKEN + "x" })).status, 401);

  // A full exchange over the token: start a conversation and stream its events.
  const conversation = await (await bot("/api/conversations", { method: "POST" })).json();
  const events = await bot(`/api/conversations/${conversation.id}/events`);
  assert.equal(events.headers.get("content-type"), "text/event-stream");
  await events.body.cancel();
});

test("web platform: bearer tokens are refused when no API token is configured", async (t) => {
  const { base } = await startPlatform(t);
  const res = await fetch(`${base}/api/conversations`, { headers: { authorization: "Bearer anything-at-all-long-enough-0123456789" } });
  assert.equal(res.status, 401);
  const { createAuth } = await import("../src/web/auth.js");
  assert.throws(() => createAuth({ password: PASSWORD, apiToken: "short" }), /at least 32/);
});
