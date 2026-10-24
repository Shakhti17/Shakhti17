import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { computeSchedule, scoreRisks, resolveInside } from "../src/tools.js";
import { MemoryStore } from "../src/memory.js";
import { validateDependencies } from "../src/planner.js";

test("computeSchedule finds the critical path and skips weekends", () => {
  // 2026-11-02 is a Monday.
  const result = computeSchedule(
    [
      { id: "A", name: "Discovery", duration_days: 3, depends_on: [] },
      { id: "B", name: "Build", duration_days: 5, depends_on: ["A"] },
      { id: "C", name: "Training material", duration_days: 2, depends_on: ["A"] },
      { id: "D", name: "Go-live", duration_days: 1, depends_on: ["B", "C"] },
    ],
    "2026-11-02",
  );
  assert.equal(result.total_working_days, 9);
  assert.deepEqual(result.critical_path, ["A", "B", "D"]);
  const byId = Object.fromEntries(result.schedule.map((s) => [s.id, s]));
  assert.equal(byId.A.start, "2026-11-02");
  assert.equal(byId.A.finish, "2026-11-04");
  assert.equal(byId.B.start, "2026-11-05");
  assert.equal(byId.B.finish, "2026-11-11"); // crosses a weekend
  assert.equal(byId.C.slack_days, 3);
  assert.equal(byId.D.start, "2026-11-12");
  assert.equal(result.project_finish, "2026-11-12");
});

test("computeSchedule moves a weekend start to Monday", () => {
  const result = computeSchedule([{ id: "A", name: "x", duration_days: 1, depends_on: [] }], "2026-10-31");
  assert.equal(result.project_start, "2026-11-02");
  assert.equal(result.project_finish, "2026-11-02");
});

test("computeSchedule rejects cycles and unknown dependencies", () => {
  assert.throws(
    () =>
      computeSchedule(
        [
          { id: "A", name: "a", duration_days: 1, depends_on: ["B"] },
          { id: "B", name: "b", duration_days: 1, depends_on: ["A"] },
        ],
        "2026-11-02",
      ),
    /cycle/,
  );
  assert.throws(
    () => computeSchedule([{ id: "A", name: "a", duration_days: 1, depends_on: ["Z"] }], "2026-11-02"),
    /unknown task/,
  );
});

test("scoreRisks ranks by exposure and clamps out-of-range scores", () => {
  const ranked = scoreRisks([
    { id: "R1", description: "minor", probability: 1, impact: 2 },
    { id: "R2", description: "major", probability: 5, impact: 4 },
    { id: "R3", description: "bad input", probability: 9, impact: 0 },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ["R2", "R3", "R1"]);
  assert.equal(ranked[0].rating, "critical");
  assert.equal(ranked[1].exposure, 5);
  assert.equal(ranked[2].rating, "low");
});

test("resolveInside blocks paths outside the workspace", () => {
  const root = path.resolve("/tmp/workspace");
  assert.equal(resolveInside(root, "brief.md"), path.join(root, "brief.md"));
  assert.throws(() => resolveInside(root, "../etc/passwd"), /escapes/);
  assert.throws(() => resolveInside(root, "/etc/passwd"), /escapes/);
});

test("validateDependencies rejects forward references and reused ids", () => {
  const t = (id, depends_on = []) => ({ id, title: id, instructions: "", worker: "scheduler", depends_on });
  assert.doesNotThrow(() => validateDependencies([t("T1"), t("T2", ["T1"])], []));
  assert.throws(() => validateDependencies([t("T2", ["T3"]), t("T3")], []), /not an earlier task/);
  assert.throws(() => validateDependencies([t("T1")], ["T1"]), /reused/);
});

test("MemoryStore persists, de-duplicates and retrieves by keyword", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-"));
  const file = path.join(dir, "memory.json");
  const store = await MemoryStore.open(file);
  await store.add("semantic", "The billing system only accepts CSV imports.");
  await store.add("semantic", "The billing system only accepts CSV imports.");
  await store.add("procedural", "Always include a rollback plan for cutovers.");
  await store.add("episodic", "Planned the HR portal upgrade; review 4.2/5.");

  const reopened = await MemoryStore.open(file);
  assert.equal(reopened.size, 3);
  const hits = reopened.search("integration with billing");
  assert.equal(hits[0].kind, "semantic");
  // Procedural lessons rank even without keyword overlap.
  assert.ok(reopened.search("data migration").some((m) => m.kind === "procedural"));
  await fs.rm(dir, { recursive: true });
});
