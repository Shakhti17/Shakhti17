// Workspace file tools, shared by every specialist. Every path the model
// supplies is confined to the workspace directory.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

const MAX_READ = 100_000;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

/** Resolve a model-supplied path and refuse anything outside the workspace. */
export function resolveInside(root, requested) {
  const base = path.resolve(root);
  const target = path.resolve(base, requested);
  const rel = path.relative(base, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path "${requested}" is outside the workspace`);
  }
  return target;
}

export async function listFiles(root, dir = ".", limit = 400) {
  const base = path.resolve(root);
  const out = [];
  async function walk(abs) {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      if (SKIP.has(e.name)) continue;
      const full = path.join(abs, e.name);
      const rel = path.relative(base, full);
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        await walk(full);
      } else {
        out.push(rel);
      }
    }
  }
  await walk(resolveInside(root, dir));
  return out;
}

/** Replace exactly one occurrence of oldText; refuse ambiguous or missing matches. */
export function replaceOnce(source, oldText, newText) {
  const first = source.indexOf(oldText);
  if (first === -1) throw new Error("old_text was not found; read the file again and copy the text exactly");
  if (source.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error("old_text occurs more than once; include more surrounding lines to make it unique");
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

const errorText = (err) => `Error: ${err.message}`;

export function createFileTools(workspace, { onWrite = () => {} } = {}) {
  return [
    betaZodTool({
      name: "list_files",
      description: "List files in the workspace recursively (skips node_modules, .git, build output). Pass '.' for the root.",
      inputSchema: z.object({ path: z.string().describe("Directory relative to the workspace, e.g. '.'") }),
      run: async ({ path: dir }) => {
        try {
          const files = await listFiles(workspace, dir);
          return files.length ? files.join("\n") : "(empty)";
        } catch (err) {
          return errorText(err);
        }
      },
    }),
    betaZodTool({
      name: "read_file",
      description: "Read a text file from the workspace.",
      inputSchema: z.object({ path: z.string() }),
      run: async ({ path: p }) => {
        try {
          const text = await fs.readFile(resolveInside(workspace, p), "utf8");
          return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[truncated: ${text.length} chars]` : text;
        } catch (err) {
          return errorText(err);
        }
      },
    }),
    betaZodTool({
      name: "write_file",
      description: "Create or overwrite a file in the workspace with the full content. Parent folders are created.",
      eager_input_streaming: true,
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      run: async ({ path: p, content }) => {
        try {
          const target = resolveInside(workspace, p);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content);
          onWrite(path.relative(path.resolve(workspace), target));
          return `Wrote ${p} (${content.length} chars).`;
        } catch (err) {
          return errorText(err);
        }
      },
    }),
    betaZodTool({
      name: "edit_file",
      description:
        "Edit a file by replacing one exact snippet. old_text must match the file exactly and occur once. " +
        "Prefer this over rewriting a whole file for small changes.",
      eager_input_streaming: true,
      inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
      run: async ({ path: p, old_text, new_text }) => {
        try {
          const target = resolveInside(workspace, p);
          const updated = replaceOnce(await fs.readFile(target, "utf8"), old_text, new_text);
          await fs.writeFile(target, updated);
          onWrite(path.relative(path.resolve(workspace), target));
          return `Edited ${p}.`;
        } catch (err) {
          return errorText(err);
        }
      },
    }),
  ];
}
