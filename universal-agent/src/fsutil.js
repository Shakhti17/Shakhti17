// Safe file updates. The model often calls tools in parallel, so two updates to
// the same JSON file can overlap; serialise them per file and write atomically.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const queues = new Map();

/** Run fn exclusively for `key`; calls with the same key run one after another. */
export function withLock(key, fn) {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/** Write to a temporary file and rename it into place, so readers never see a partial file. */
export async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}
