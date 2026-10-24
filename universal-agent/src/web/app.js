// The Ofis web platform: a private web app around the AI team.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Team } from "../team.js";
import { AGENTS } from "../agents.js";
import { describeError } from "../errors.js";
import { listFiles, resolveInside } from "../tools/files.js";
import { createAuth } from "./auth.js";
import { Hub } from "./hub.js";
import { ConversationStore, historyFrom } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = (name) => path.join(here, "..", "..", "node_modules", name);

const MAX_MESSAGE = 20_000;
const MAX_VIEW_BYTES = 2 * 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function createApp({ workspace, dataDir, memory, password, sessionSecret, trustProxy = false }) {
  const app = express();
  const auth = createAuth({ password, secret: sessionSecret });
  const store = new ConversationStore(dataDir);
  const hub = new Hub();

  if (trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "100kb" }));

  // ---------- static ----------
  app.use(express.static(path.join(here, "..", "..", "public")));
  app.get("/vendor/marked.js", (req, res) => res.sendFile(path.join(pkgDir("marked"), "lib", "marked.umd.js")));
  app.get("/vendor/purify.js", (req, res) => res.sendFile(path.join(pkgDir("dompurify"), "dist", "purify.min.js")));
  app.use("/vendor/fonts", express.static(path.join(pkgDir("@fontsource/onest"), "files")));
  app.use("/vendor/fonts", express.static(path.join(pkgDir("@fontsource/unbounded"), "files")));

  // ---------- auth ----------
  app.post("/api/login", auth.login);
  app.post("/api/logout", auth.logout);
  app.get("/api/me", (req, res) => res.json({ authenticated: auth.isAuthenticated(req) }));
  app.use("/api", auth.require);

  // ---------- team & conversations ----------
  app.get("/api/team", (req, res) => {
    res.json(Object.entries(AGENTS).map(([id, a]) => ({ id, title: a.title, description: a.description })));
  });

  app.get("/api/conversations", async (req, res) => {
    const list = await store.list();
    res.json(list.map((c) => ({ ...c, running: hub.isRunning(c.id) })));
  });

  app.post("/api/conversations", async (req, res) => {
    res.status(201).json(await store.create());
  });

  app.get("/api/conversations/:id", async (req, res) => {
    const conversation = await store.get(req.params.id);
    res.json({ ...conversation, running: hub.isRunning(conversation.id) });
  });

  app.delete("/api/conversations/:id", async (req, res) => {
    if (hub.isRunning(req.params.id)) return res.status(409).json({ error: "Wait for the team to finish first." });
    await store.remove(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/conversations/:id/events", async (req, res) => {
    await store.get(req.params.id); // 404 for unknown ids
    hub.subscribe(req.params.id, res);
  });

  app.post("/api/conversations/:id/messages", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "Write a message first." });
    if (text.length > MAX_MESSAGE) return res.status(400).json({ error: `Keep messages under ${MAX_MESSAGE} characters.` });

    const conversation = await store.get(req.params.id);
    if (!hub.start(conversation.id)) return res.status(409).json({ error: "The team is still working on the last message." });

    const history = historyFrom(conversation.messages);
    const userMessage = { role: "user", text, at: new Date().toISOString() };
    conversation.messages.push(userMessage);
    if (conversation.title === "New conversation") conversation.title = text.replace(/\s+/g, " ").slice(0, 70);
    await store.save(conversation);
    hub.emit(conversation.id, { type: "message", message: userMessage });
    res.status(202).json({ ok: true });

    runTeam(conversation.id, text, history, {
      webSearch: req.body.webSearch !== false,
      review: req.body.review !== false,
    });
  });

  async function runTeam(id, text, history, { webSearch, review }) {
    const steps = [];
    const team = new Team({
      workspace,
      memory,
      webSearch,
      review,
      approve: (command, reason) => hub.requestApproval(id, command, reason),
      log: (line) => {
        steps.push(line);
        hub.step(id, line);
      },
    });
    team.history = history;

    let reply;
    try {
      const { answer, route } = await team.handle(text);
      reply = { role: "assistant", text: answer, route: route.mode, agent: route.mode === "single" ? route.agent : null };
    } catch (err) {
      reply = { role: "error", text: describeError(err) };
    }
    Object.assign(reply, { steps, at: new Date().toISOString() });

    try {
      const conversation = await store.get(id);
      conversation.messages.push(reply);
      await store.save(conversation);
    } catch {
      // The conversation was deleted mid-run; the reply is still delivered live.
    }
    hub.finish(id, reply);
  }

  app.post("/api/approvals/:id", (req, res) => {
    const ok = hub.resolveApproval(req.params.id, req.body?.approved === true);
    if (!ok) return res.status(404).json({ error: "This request is no longer waiting for approval." });
    res.json({ ok: true });
  });

  // ---------- workspace, board, memory ----------
  app.get("/api/files", async (req, res) => {
    await fs.mkdir(workspace, { recursive: true });
    res.json({ files: await listFiles(workspace, ".", 2000) });
  });

  app.get("/api/files/content", async (req, res) => {
    const requested = String(req.query.path ?? "");
    let target;
    try {
      target = resolveInside(workspace, requested);
    } catch {
      return res.status(400).json({ error: "That path is outside the workspace." });
    }
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) return res.status(404).json({ error: "File not found." });

    if (req.query.download === "1") return res.download(target, path.basename(target));
    if (stat.size > MAX_VIEW_BYTES) return res.status(413).json({ error: "This file is too large to preview. Download it instead." });
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) return res.status(415).json({ error: "This is a binary file. Download it instead." });
    // Always plain text: files written by the team are never rendered as HTML here.
    res.type("text/plain; charset=utf-8").send(buffer);
  });

  app.get("/api/board", async (req, res) => {
    try {
      res.json(JSON.parse(await fs.readFile(path.join(workspace, "pm", "board.json"), "utf8")));
    } catch {
      res.json({ nextId: 1, tasks: [] });
    }
  });

  app.get("/api/memory", (req, res) => res.json(memory.data));

  // ---------- errors ----------
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Server error." : err.message });
  });

  return { app, hub, store };
}
