// Conversations are stored as one JSON file each in <dataDir>/conversations.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ConversationStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "conversations");
  }

  file(id) {
    if (!ID.test(id)) throw Object.assign(new Error("invalid conversation id"), { status: 404 });
    return path.join(this.dir, `${id}.json`);
  }

  async list() {
    await fs.mkdir(this.dir, { recursive: true });
    const names = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".json"));
    const all = await Promise.all(names.map((n) => this.get(n.slice(0, -5)).catch(() => null)));
    return all
      .filter(Boolean)
      .map(({ id, title, created, updated }) => ({ id, title, created, updated }))
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(this.file(id), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") throw Object.assign(new Error("conversation not found"), { status: 404 });
      throw err;
    }
  }

  async create() {
    const now = new Date().toISOString();
    const conversation = { id: crypto.randomUUID(), title: "New conversation", created: now, updated: now, messages: [] };
    await this.save(conversation);
    return conversation;
  }

  async save(conversation) {
    conversation.updated = new Date().toISOString();
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(conversation.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(conversation, null, 2));
    await fs.rename(tmp, target);
    return conversation;
  }

  async remove(id) {
    await fs.rm(this.file(id), { force: true });
  }
}

/** Rebuild the team's conversation context from stored messages. */
export function historyFrom(messages) {
  const history = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].role === "user" && messages[i + 1].role === "assistant") {
      history.push({ request: messages[i].text, answer: messages[i + 1].text });
    }
  }
  return history;
}
