// Live updates: which conversations are running, their steps, and pending
// command approvals, pushed to browsers over Server-Sent Events.
import crypto from "node:crypto";

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export class Hub {
  constructor() {
    this.listeners = new Map(); // conversationId -> Set<res>
    this.running = new Map(); // conversationId -> { steps: string[] }
    this.approvals = new Map(); // approvalId -> { conversationId, command, reason, resolve, timer }
  }

  subscribe(conversationId, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    if (!this.listeners.has(conversationId)) this.listeners.set(conversationId, new Set());
    this.listeners.get(conversationId).add(res);

    // Catch up a page that (re)connects in the middle of a run.
    this.send(res, this.snapshot(conversationId));
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(heartbeat);
      this.listeners.get(conversationId)?.delete(res);
    });
  }

  snapshot(conversationId) {
    return {
      type: "snapshot",
      running: this.running.has(conversationId),
      steps: this.running.get(conversationId)?.steps ?? [],
      approvals: this.pendingApprovals(conversationId),
    };
  }

  send(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  emit(conversationId, event) {
    for (const res of this.listeners.get(conversationId) ?? []) this.send(res, event);
  }

  start(conversationId) {
    if (this.running.has(conversationId)) return false;
    this.running.set(conversationId, { steps: [] });
    this.emit(conversationId, { type: "status", running: true });
    return true;
  }

  step(conversationId, line) {
    this.running.get(conversationId)?.steps.push(line);
    this.emit(conversationId, { type: "step", line });
  }

  finish(conversationId, message) {
    for (const [id, a] of this.approvals) if (a.conversationId === conversationId) this.resolveApproval(id, false);
    this.running.delete(conversationId);
    this.emit(conversationId, { type: "message", message });
    this.emit(conversationId, { type: "status", running: false });
  }

  isRunning(conversationId) {
    return this.running.has(conversationId);
  }

  pendingApprovals(conversationId) {
    return [...this.approvals]
      .filter(([, a]) => a.conversationId === conversationId)
      .map(([id, a]) => ({ id, command: a.command, reason: a.reason }));
  }

  /** Ask the browser to approve a command; resolves false on decline or timeout. */
  requestApproval(conversationId, command, reason) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolveApproval(id, false), APPROVAL_TIMEOUT_MS);
      this.approvals.set(id, { conversationId, command, reason, resolve, timer });
      this.emit(conversationId, { type: "approval", approval: { id, command, reason } });
    });
  }

  resolveApproval(id, approved) {
    const approval = this.approvals.get(id);
    if (!approval) return false;
    clearTimeout(approval.timer);
    this.approvals.delete(id);
    approval.resolve(approved);
    this.emit(approval.conversationId, { type: "approval_resolved", id, approved });
    return true;
  }
}
