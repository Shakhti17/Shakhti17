// End-to-end run against a local mock of the Messages API, so the whole
// pipeline (planning, parallel workers, tool calls, re-planning, reflection,
// memory) is exercised offline without an API key.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const requests = [];
let reviews = 0;

let nextId = 0;
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

const plan = {
  goal: "Migrate the CRM to the cloud",
  tasks: [
    { id: "T1", title: "WBS", instructions: "Break down the work", worker: "scope_analyst", depends_on: [] },
    { id: "T2", title: "Stakeholders", instructions: "RACI", worker: "stakeholder_analyst", depends_on: [] },
    { id: "T3", title: "Schedule", instructions: "Build the timeline", worker: "scheduler", depends_on: ["T1"] },
    { id: "T4", title: "Risks", instructions: "Risk register", worker: "risk_analyst", depends_on: ["T1"] },
  ],
};

function respond(body) {
  const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
  const last = body.messages.at(-1);
  const prompt = typeof last.content === "string" ? last.content : JSON.stringify(last.content);

  if (system.includes("You plan; workers execute")) {
    if (prompt.includes("Create the plan.")) return json(plan);
    return json({ complete: true, reason: "all areas covered", new_tasks: [] });
  }
  if (system.includes("PMO reviewer")) {
    reviews++;
    const score = reviews === 1 ? 3 : 5;
    return json({
      scores: ["Grounded", "Complete", "Consistent", "Actionable", "Concise"].map((criterion) => ({
        criterion,
        score,
        comment: score === 5 ? "good" : "missing rollback plan",
      })),
      feedback: score === 5 ? "" : "Add a rollback plan for cutover.",
      lessons: ["Always include a rollback plan for a cutover."],
    });
  }
  if (system.includes("Role: scheduler")) {
    if (body.messages.length === 1) {
      return message(
        [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "compute_schedule",
            input: {
              start_date: "2026-11-02",
              tasks: [
                { id: "P1", name: "Discovery", duration_days: 5, depends_on: [] },
                { id: "P2", name: "Migration", duration_days: 10, depends_on: ["P1"] },
              ],
            },
          },
        ],
        "tool_use",
      );
    }
    const result = last.content.find((b) => b.type === "tool_result");
    const computed = JSON.parse(result.content);
    return text(`Finish date ${computed.project_finish}, critical path ${computed.critical_path.join(" > ")}`);
  }
  if (system.includes("Role: ")) return text(`${system.match(/Role: ([a-z ]+)/)[1]} output`);
  return null;
}

function writeStream(res, msg) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  send("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null } });
  msg.content.forEach((block, index) => {
    send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

// The SDK's tool runner continues a conversation server-side by sending only the
// new messages plus `thread.previous_message_id`; rebuild the full request here.
const threads = new Map();

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

    if (body.stream) {
      const draft = body.messages[0].content.includes("<reviewer_feedback>") ? "# Plan v2 with rollback plan" : "# Plan v1";
      return writeStream(res, text(draft));
    }
    const reply = respond(body);
    if (!reply) throw new Error("unmocked request");
    threads.set(reply.id, { ...body, messages: [...body.messages, { role: "assistant", content: reply.content }] });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  } catch (err) {
    // 400 is not retried by the SDK, so a broken mock fails fast instead of hanging.
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message } }));
  }
});

test("full agent run against a mocked API", async (t) => {
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-e2e-"));
  t.after(() => fs.rm(dir, { recursive: true }));
  const memoryFile = path.join(dir, "memory.json");

  const { runDeliveryAgent } = await import("../src/agent.js");
  const result = await runDeliveryAgent({
    brief: "Migrate the CRM to the cloud by March.",
    workspaceDir: dir,
    memoryFile,
    outDir: dir,
    log: () => {},
  });

  // Plan & execute: all four planned tasks ran, scope before schedule.
  assert.deepEqual(result.results.map((r) => r.id), ["T1", "T2", "T3", "T4"]);

  // Tool use: the scheduler's answer came from the real compute_schedule result.
  const schedule = result.results.find((r) => r.id === "T3").output;
  assert.equal(schedule, "Finish date 2026-11-20, critical path P1 > P2");

  // Orchestrator/workers: the scheduler saw T1's output but not T2's or T4's.
  const schedulerCall = requests.find((r) => JSON.stringify(r.body.system).includes("Role: scheduler"));
  const schedulerPrompt = schedulerCall.body.messages[0].content;
  assert.ok(schedulerPrompt.includes("scope analyst output"));
  assert.ok(!schedulerPrompt.includes("stakeholder analyst output"));
  assert.deepEqual(schedulerCall.body.tools.map((tool) => tool.name).sort(), ["compute_schedule", "recall_memory"]);

  // Reflection: first draft failed review, revised draft passed.
  assert.equal(result.rounds, 2);
  assert.equal(result.review.passed, true);
  assert.match(result.draft, /rollback plan/);
  const written = await fs.readFile(result.outputFile, "utf8");
  assert.match(written, /Appendix: automated review/);

  // Memory: the episode and the lesson were persisted.
  const memory = JSON.parse(await fs.readFile(memoryFile, "utf8"));
  assert.equal(memory.episodic.length, 1);
  assert.deepEqual(memory.procedural.map((m) => m.text), ["Always include a rollback plan for a cutover."]);

  // Every request opts into server-side refusal fallbacks.
  for (const r of requests) {
    assert.equal(r.body.fallbacks, "default");
    assert.match(r.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    assert.equal(r.body.model, "claude-opus-5-5");
  }
});
