// A local mock of the Messages API for offline tests: JSON and SSE streaming
// responses, plus the tool runner's server-side thread continuation, driven by
// a scripted responder.
import http from "node:http";

let nextId = 0;

export const message = (content, stop_reason = "end_turn") => ({
  id: `msg_${nextId++}`,
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});
export const text = (t) => message([{ type: "text", text: t }]);
export const json = (o) => text(JSON.stringify(o));
export const toolCall = (name, input) =>
  message([{ type: "tool_use", id: `toolu_${nextId}`, name, input }], "tool_use");

/** Helpers for responders: the system prompt, first user message and tool results of a request. */
export function describe(body) {
  return {
    system: typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? ""),
    first: body.messages[0].content,
    toolResults: body.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
    ),
  };
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
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

/**
 * Start the mock and point the Anthropic SDK at it.
 * respond(body) returns a message, or null for an unmocked request.
 */
export async function startMockApi(respond) {
  const requests = [];
  const threads = new Map();

  // The tool runner continues a conversation by sending only the new messages
  // plus `thread.previous_message_id`; rebuild the full request here.
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
      const reply = await respond(body);
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

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  return {
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
