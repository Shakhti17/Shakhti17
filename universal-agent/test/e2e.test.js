// End-to-end run of the whole team against a local mock of the Messages API
// (streaming and non-streaming), so routing, parallel specialists, real tool
// execution, review loops and memory are exercised offline without an API key.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const requests = [];
const threads = new Map();
let nextId = 0;
let developerReviews = 0;

const message = (content, stop_reason = "end_turn") => ({
  id: `msg_${nextId++}`,
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});
const text = (t) => message([{ type: "text", text: t }]);
const json = (o) => text(JSON.stringify(o));
const toolCall = (name, input) => message([{ type: "tool_use", id: `toolu_${nextId}`, name, input }], "tool_use");

const plan = {
  mode: "team",
  reply: "",
  agent: "program_manager",
  instructions: "",
  needs_review: true,
  tasks: [
    { id: "T1", agent: "program_manager", title: "Launch plan", instructions: "Plan the MVP", depends_on: [] },
    { id: "T2", agent: "senior_developer", title: "Build MVP", instructions: "Build a todo CLI", depends_on: ["T1"] },
    { id: "T3", agent: "marketing_manager", title: "Launch copy", instructions: "Write launch post", depends_on: ["T1"] },
  ],
};

function respond(body) {
  const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
  const first = body.messages[0].content;
  const toolResults = body.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
  );

  if (system.includes("You are the team lead of an AI team")) {
    if (first.includes("<user_message>\nLaunch a todo app")) return json(plan);
    return json({ ...plan, mode: "direct", reply: "Hi! Ask me for plans, code or marketing.", tasks: [], needs_review: false });
  }
  if (system.includes("demanding reviewer")) {
    const isDev = first.includes("<role>Senior Developer</role>");
    const fail = isDev && developerReviews++ === 0;
    const score = fail ? 2 : 5;
    return json({
      scores: [1, 2, 3, 4].map((i) => ({ criterion: `c${i}`, score, comment: fail ? "no README" : "good" })),
      feedback: fail ? "Add a README." : "",
      lessons: fail ? ["Always include a README with run steps."] : [],
    });
  }
  if (system.includes("team lead reporting back")) return text("Summary: plan, app and launch copy are ready.");

  if (system.includes("You are the Program Manager")) {
    if (!toolResults.length) return toolCall("manage_tasks", { action: "add", title: "Build MVP", owner: "Senior Developer" });
    return text(`Plan ready. ${toolResults[0].content}`);
  }
  if (system.includes("You are the Senior Developer")) {
    if (first.includes("<reviewer_feedback>")) return text("Fixed after review: added README.");
    if (toolResults.length === 0) {
      return toolCall("write_file", {
        path: "todo/index.js",
        content: "console.log(process.env.ANTHROPIC_API_KEY ?? 'todo ok')",
      });
    }
    if (toolResults.length === 1) return toolCall("run_command", { command: "node todo/index.js", reason: "verify it runs" });
    return text(`Built todo/index.js.\n${toolResults[1].content}`);
  }
  if (system.includes("You are the Marketing Manager")) return text("Launch copy ready.");
  return null;
}

function writeStream(res, msg) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  send("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null } });
  msg.content.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } });
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

// The SDK's tool runner continues a conversation server-side by sending only the
// new messages plus `thread.previous_message_id`; rebuild the full request here.
function expand(body) {
  if (body.thread?.type !== "continue") return body;
  const prev = threads.get(body.thread.previous_message_id);
  if (!prev) throw new Error(`unknown thread ${body.thread.previous_message_id}`);
  return { ...prev, ...body, messages: [...prev.messages, ...body.messages] };
}

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const body = expand(JSON.parse(raw));
    requests.push({ headers: req.headers, body });
    const reply = respond(body);
    if (!reply) throw new Error("unmocked request");
    threads.set(reply.id, { ...body, messages: [...body.messages, { role: "assistant", content: reply.content }] });
    if (body.stream) return writeStream(res, reply);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  } catch (err) {
    // 400 is not retried by the SDK, so a broken mock fails fast instead of hanging.
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message } }));
  }
});

test("the team handles a multi-discipline request end to end", async (t) => {
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ua-e2e-"));
  t.after(() => fs.rm(dir, { recursive: true }));
  const workspace = path.join(dir, "workspace");

  const { Team } = await import("../src/team.js");
  const { MemoryStore } = await import("../src/memory.js");
  const memory = await MemoryStore.open(path.join(dir, "memory.json"));
  const approvals = [];
  const logs = [];
  const team = new Team({
    workspace,
    memory,
    webSearch: false,
    approve: async (command) => {
      approvals.push(command);
      return true;
    },
    log: (line) => logs.push(line),
  });

  const { answer, route } = await team.handle("Launch a todo app");
  assert.equal(route.mode, "team");
  assert.equal(answer, "Summary: plan, app and launch copy are ready.");

  // Tool use: the developer really wrote and ran the file (approval asked once),
  // and the command could not see the Anthropic API key.
  assert.equal(await fs.readFile(path.join(workspace, "todo/index.js"), "utf8"), "console.log(process.env.ANTHROPIC_API_KEY ?? 'todo ok')");
  assert.deepEqual(approvals, ["node todo/index.js"]);
  const devRun = requests.find(
    (r) => JSON.stringify(r.body.system).includes("Senior Developer") && JSON.stringify(r.body.messages).includes("exit code: 0"),
  );
  assert.match(JSON.stringify(devRun.body.messages), /todo ok/);

  // The PM's task board was persisted in the workspace.
  const board = JSON.parse(await fs.readFile(path.join(workspace, "pm/board.json"), "utf8"));
  assert.deepEqual(board.tasks.map((x) => x.title), ["Build MVP"]);

  // Plan & execute: the developer and marketer saw the PM's output, but not each other's.
  const marketingPrompt = requests.find((r) => JSON.stringify(r.body.system).includes("You are the Marketing Manager")).body.messages[0].content;
  assert.match(marketingPrompt, /From Program Manager \(T1/);
  assert.doesNotMatch(marketingPrompt, /From Senior Developer/);
  assert.ok(logs.some((l) => l.includes("[Senior Developer T2] run_command node todo/index.js")));

  // Reflection: the reviewer saw the written file; the developer revised after failing review.
  const reviewerPrompt = requests.find((r) => r.body.messages[0].content.includes?.("<role>Senior Developer</role>")).body.messages[0].content;
  assert.match(reviewerPrompt, /--- todo\/index\.js ---/);
  assert.equal(developerReviews, 2);
  assert.ok(requests.some((r) => r.body.messages[0].content.includes?.("<reviewer_feedback>\nAdd a README.")));

  // Memory: episode and lesson saved.
  assert.equal(memory.data.episodic.length, 1);
  assert.deepEqual(memory.data.procedural.map((m) => m.text), ["Senior Developer: Always include a README with run steps."]);

  // Context management: the next message sees the conversation so far.
  const second = await team.handle("hi");
  assert.equal(second.route.mode, "direct");
  const routerPrompt = requests.at(-1).body.messages[0].content;
  assert.match(routerPrompt, /User: Launch a todo app/);

  // Every request opts into server-side refusal fallbacks.
  for (const r of requests) {
    assert.equal(r.body.fallbacks, "default");
    assert.match(r.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  }
});
