import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { listFiles, replaceOnce, resolveInside } from "../src/tools/files.js";
import { runCommand } from "../src/tools/shell.js";
import { applyBoardAction, computeSchedule, scoreRisks } from "../src/tools/pm.js";
import { analyzeContent, buildUtmUrl } from "../src/tools/marketing.js";
import { validateDependencies } from "../src/team.js";
import { MemoryStore } from "../src/memory.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ua-"));

test("resolveInside confines paths to the workspace", () => {
  const root = path.resolve("/tmp/ws");
  assert.equal(resolveInside(root, "app/index.js"), path.join(root, "app/index.js"));
  assert.throws(() => resolveInside(root, "../secret"), /outside the workspace/);
  assert.throws(() => resolveInside(root, "/etc/passwd"), /outside the workspace/);
});

test("listFiles walks the tree and skips node_modules", async () => {
  const dir = await tmp();
  await fs.mkdir(path.join(dir, "app/node_modules/x"), { recursive: true });
  await fs.writeFile(path.join(dir, "app/index.js"), "");
  await fs.writeFile(path.join(dir, "README.md"), "");
  assert.deepEqual(await listFiles(dir), ["app/", "app/index.js", "README.md"]);
  await fs.rm(dir, { recursive: true });
});

test("replaceOnce requires exactly one match", () => {
  assert.equal(replaceOnce("a b c", "b", "x"), "a x c");
  assert.throws(() => replaceOnce("a b c", "z", "x"), /not found/);
  assert.throws(() => replaceOnce("b b", "b", "x"), /more than once/);
});

test("runCommand reports exit codes and hides Anthropic credentials", async () => {
  const dir = await tmp();
  process.env.ANTHROPIC_API_KEY = "secret";
  const ok = await runCommand(`node -e "console.log(process.env.ANTHROPIC_API_KEY ?? 'hidden')"`, { cwd: dir, timeoutMs: 10_000 });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), "hidden");
  const fail = await runCommand(`node -e "process.exit(3)"`, { cwd: dir, timeoutMs: 10_000 });
  assert.equal(fail.code, 3);
  const slow = await runCommand(`node -e "setTimeout(() => {}, 5000)"`, { cwd: dir, timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  delete process.env.ANTHROPIC_API_KEY;
  await fs.rm(dir, { recursive: true });
});

test("computeSchedule finds the critical path over working days", () => {
  const result = computeSchedule(
    [
      { id: "A", name: "Design", duration_days: 3, depends_on: [] },
      { id: "B", name: "Build", duration_days: 5, depends_on: ["A"] },
      { id: "C", name: "Docs", duration_days: 2, depends_on: ["A"] },
    ],
    "2026-11-02",
  );
  assert.deepEqual(result.critical_path, ["A", "B"]);
  assert.equal(result.project_finish, "2026-11-11");
});

test("scoreRisks ranks by exposure", () => {
  const ranked = scoreRisks([
    { id: "R1", probability: 1, impact: 1 },
    { id: "R2", probability: 4, impact: 5 },
  ]);
  assert.deepEqual(ranked.map((r) => [r.id, r.rating]), [["R2", "critical"], ["R1", "low"]]);
});

test("task board adds, updates, lists and removes tasks", () => {
  let board = { nextId: 1, tasks: [] };
  ({ board } = applyBoardAction(board, { action: "add", title: "Write PRD", owner: "PM" }));
  ({ board } = applyBoardAction(board, { action: "add", title: "Build API" }));
  ({ board } = applyBoardAction(board, { action: "update", id: "T2", status: "in_progress", owner: "Dev" }));
  const { message } = applyBoardAction(board, { action: "list" });
  assert.match(message, /todo: 1, in_progress: 1/);
  assert.match(message, /\| T2 \| Build API \| Dev \| in_progress \|/);
  ({ board } = applyBoardAction(board, { action: "remove", id: "T1" }));
  assert.deepEqual(board.tasks.map((t) => t.id), ["T2"]);
  assert.throws(() => applyBoardAction(board, { action: "update", id: "T9" }), /no task/);
  assert.throws(() => applyBoardAction(board, { action: "add" }), /title is required/);
});

test("analyzeContent measures copy and flags SEO problems", () => {
  const good = analyzeContent(
    "# Project planning software for small teams\n\nPlan your work. Track your tasks. Ship on time with project planning software.",
    "project planning software",
  );
  assert.equal(good.title, "Project planning software for small teams");
  assert.equal(good.keyword_count, 2);
  assert.equal(good.sentences, 3);
  assert.ok(good.flesch_reading_ease > 30);
  // A 13-word sample with the keyword twice is genuinely over-optimised.
  assert.deepEqual(good.flags, ["Keyword density 15.4% looks like stuffing; aim for 0.5-2.5%."]);

  const bad = analyzeContent("Some text without a title.", "crm");
  assert.ok(bad.flags.some((f) => f.includes("No H1")));
  assert.ok(bad.flags.some((f) => f.includes("does not appear")));
});

test("buildUtmUrl adds normalised UTM parameters", () => {
  const url = buildUtmUrl({ url: "https://example.com/pricing?ref=1", source: "LinkedIn", medium: "social", campaign: "Spring Launch" });
  assert.equal(url, "https://example.com/pricing?ref=1&utm_source=linkedin&utm_medium=social&utm_campaign=spring-launch");
  assert.throws(() => buildUtmUrl({ url: "not a url", source: "x", medium: "y", campaign: "z" }));
});

test("validateDependencies rejects forward references and duplicates", () => {
  const t = (id, depends_on = []) => ({ id, agent: "program_manager", title: id, instructions: "", depends_on });
  assert.doesNotThrow(() => validateDependencies([t("T1"), t("T2", ["T1"])]));
  assert.throws(() => validateDependencies([t("T1", ["T2"]), t("T2")]), /not an earlier task/);
  assert.throws(() => validateDependencies([t("T1"), t("T1")]), /duplicate/);
});

test("MemoryStore persists and retrieves", async () => {
  const dir = await tmp();
  const store = await MemoryStore.open(path.join(dir, "m.json"));
  await store.add("semantic", "Our product is a CRM for dental clinics.");
  const reopened = await MemoryStore.open(path.join(dir, "m.json"));
  assert.equal(reopened.search("landing page for the dental CRM")[0].kind, "semantic");
  await fs.rm(dir, { recursive: true });
});

test("credentialSource recognises API keys, identity federation and nothing", async () => {
  const { credentialSource } = await import("../src/credentials.js");
  const home = { HOME: "/nonexistent" };
  assert.equal(credentialSource({ ANTHROPIC_API_KEY: "sk" }), "api key");
  const federation = {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_1",
    ANTHROPIC_ORGANIZATION_ID: "org",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_1",
    ANTHROPIC_IDENTITY_TOKEN_FILE: "/var/run/token",
  };
  assert.equal(credentialSource(federation), "identity federation");
  // All four federation variables are needed.
  const { ANTHROPIC_SERVICE_ACCOUNT_ID, ...partial } = federation;
  assert.notEqual(credentialSource(partial), "identity federation");
  assert.ok([null, "profile"].includes(credentialSource(home)));
});

test("parallel task-board updates are all kept (no lost writes or corrupted JSON)", async () => {
  const { createPmTools } = await import("../src/tools/pm.js");
  const dir = await tmp();
  const board = createPmTools(dir).find((t) => t.name === "manage_tasks");
  await Promise.all(Array.from({ length: 10 }, (_, i) => board.run({ action: "add", title: `Task ${i}` })));
  const saved = JSON.parse(await fs.readFile(path.join(dir, "pm/board.json"), "utf8"));
  assert.equal(saved.tasks.length, 10);
  assert.equal(new Set(saved.tasks.map((t) => t.id)).size, 10);
  await fs.rm(dir, { recursive: true });
});

test("parallel memory saves are all persisted", async () => {
  const dir = await tmp();
  const file = path.join(dir, "memory.json");
  const store = await MemoryStore.open(file);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.add("semantic", `Fact number ${i}`)));
  const reopened = await MemoryStore.open(file);
  assert.equal(reopened.data.semantic.length, 10);
  await fs.rm(dir, { recursive: true });
});
