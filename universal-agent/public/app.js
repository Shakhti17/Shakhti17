// Ofis client: plain JavaScript, no build step.
"use strict";

const $ = (sel) => document.querySelector(sel);

const LANES = {
  "Program Manager": { key: "pm", col: 1 },
  "Senior Developer": { key: "dev", col: 2 },
  "Marketing Manager": { key: "mkt", col: 3 },
};
const AGENT_LANE = { program_manager: "pm", senior_developer: "dev", marketing_manager: "mkt" };

const TOOL_WORDS = {
  write_file: "Wrote",
  edit_file: "Edited",
  read_file: "Read",
  list_files: "Looked through files",
  run_command: "Ran",
  compute_schedule: "Calculated the schedule",
  score_risks: "Scored risks",
  manage_tasks: "Updated the task board:",
  content_check: "Checked the copy",
  build_utm_links: "Built tracking links",
  web_search: "Searched the web for",
  recall_memory: "Checked memory for",
  save_memory: "Saved to memory",
};

const SUGGESTIONS = [
  { lane: "pm", who: "Program Manager", text: "Write a project plan with a schedule and risks for migrating our CRM to the cloud by March." },
  { lane: "dev", who: "Senior Developer", text: "Build a REST API for a todo app in Node.js with tests." },
  { lane: "mkt", who: "Marketing Manager", text: "Create a 4-week LinkedIn content calendar for our product launch." },
  { lane: "lead", who: "Whole team", text: "We're launching a time-tracking app in January. Plan it, build a landing page and prepare the launch campaign." },
];

const state = {
  view: "chat",
  conversationId: null,
  conversations: [],
  running: false,
  events: null,
};

// ---------- helpers ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("Sign in to continue.");
  }
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

window.addEventListener("DOMContentLoaded", () => {
  // Open links in model output safely in a new tab.
  window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  boot();
});

function renderMarkdown(text) {
  const html = window.marked.parse(text ?? "", { gfm: true, breaks: false });
  const div = el("div", { class: "prose" });
  div.innerHTML = window.DOMPurify.sanitize(html);
  return div;
}

/** Turn one team log line into a lane step. */
function parseStep(line) {
  const plan = line.match(/^\s*(T\d+) (Program Manager|Senior Developer|Marketing Manager): (.*)$/);
  if (plan) return { kind: "plan", lane: LANES[plan[2]].key, task: plan[1], action: plan[3] };

  const m = line.match(/\[(Program Manager|Senior Developer|Marketing Manager)(?: (T\d+))?\]\s+(.*)/);
  if (!m) return { kind: "lead", lane: "lead", action: line.replace(/^\s*→\s*/, "").trim() };

  const [, who, task, rest] = m;
  const lane = LANES[who].key;
  const review = rest.match(/^review ([\d.]+)\/5 - (\w+)/);
  if (review) {
    const action = review[2] === "approved" ? "Review passed" : "Sent back for changes";
    return { kind: "review", lane, task, action, detail: `${review[1]}/5` };
  }
  const [tool, ...args] = rest.split(" ");
  const detail = args.join(" ");
  return { kind: "tool", lane, task, action: TOOL_WORDS[tool] ?? tool, detail: detail === "." ? "" : detail };
}

function stepItem(line, isNew = false) {
  const s = parseStep(line);
  const li = el("li", { class: `step-${s.kind} lane-${s.lane}${isNew ? " is-new" : ""}` });
  for (const key of ["pm", "dev", "mkt"]) li.append(el("span", { class: `rail lane-${key}${s.lane === key ? " on" : ""}`, "aria-hidden": "true" }));
  const textCell = el("div", { class: "step-text" });
  if (s.task) textCell.append(el("span", { class: "task-id", text: s.task }));
  textCell.append(el("span", { class: "action", text: s.action }));
  if (s.detail) textCell.append(" ", el("span", { class: "detail", text: s.detail }));
  li.append(textCell);
  return li;
}

// ---------- auth ----------

function showLogin() {
  state.events?.close();
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#password").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("#password").value } });
    $("#password").value = "";
    await startApp();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

async function boot() {
  const me = await api("/api/me");
  if (me.authenticated) await startApp();
  else showLogin();
}

async function startApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  const team = await api("/api/team");
  $("#roster").replaceChildren(...team.map((a) => el("li", { class: `lane-${AGENT_LANE[a.id]}`, title: a.description, text: a.title })));
  renderSuggestions();
  await refreshConversations();
  if (state.conversations.length) await openConversation(state.conversations[0].id);
  else showEmptyChat();
}

// ---------- navigation ----------

const VIEW_TITLES = { files: "Files", board: "Task board", memory: "Memory" };

function setView(view) {
  state.view = view;
  for (const link of document.querySelectorAll(".view-link")) {
    link.toggleAttribute("aria-current", link.dataset.view === view);
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
  }
  for (const v of ["chat", "files", "board", "memory"]) $(`#view-${v}`).hidden = v !== view;
  $("#delete-conversation").hidden = view !== "chat" || !state.conversationId;
  $("#view-title").textContent = view === "chat" ? currentTitle() : VIEW_TITLES[view];
  closeMenu();
  if (view === "files") loadFiles();
  if (view === "board") loadBoard();
  if (view === "memory") loadMemory();
}

for (const link of document.querySelectorAll(".view-link")) link.addEventListener("click", () => setView(link.dataset.view));
$("#menu-open").addEventListener("click", () => $("#app").classList.add("menu-open"));
$("#menu-close").addEventListener("click", closeMenu);
function closeMenu() {
  $("#app").classList.remove("menu-open");
}

function currentTitle() {
  return state.conversations.find((c) => c.id === state.conversationId)?.title ?? "New conversation";
}

// ---------- conversations ----------

async function refreshConversations() {
  state.conversations = await api("/api/conversations");
  if (!state.conversations.length) {
    $("#conversation-list").replaceChildren(el("li", { class: "empty-note", text: "No conversations yet." }));
    return;
  }
  $("#conversation-list").replaceChildren(
    ...state.conversations.map((c) =>
      el(
        "li",
        {},
        el("button", {
          text: c.title,
          title: c.title,
          class: c.running ? "running" : "",
          "aria-current": c.id === state.conversationId ? "true" : "false",
          onclick: () => openConversation(c.id),
        }),
      ),
    ),
  );
  if (state.view === "chat") $("#view-title").textContent = currentTitle();
}

$("#new-conversation").addEventListener("click", async () => {
  const empty = state.conversations.find((c) => c.title === "New conversation");
  if (empty) return openConversation(empty.id);
  const c = await api("/api/conversations", { method: "POST" });
  await refreshConversations();
  await openConversation(c.id);
});

$("#delete-conversation").addEventListener("click", async () => {
  if (!state.conversationId || !confirm("Delete this conversation? Files in the workspace are kept.")) return;
  try {
    await api(`/api/conversations/${state.conversationId}`, { method: "DELETE" });
  } catch (err) {
    alert(err.message);
    return;
  }
  state.conversationId = null;
  state.events?.close();
  await refreshConversations();
  if (state.conversations.length) await openConversation(state.conversations[0].id);
  else showEmptyChat();
});

function showEmptyChat() {
  state.conversationId = null;
  $("#messages").replaceChildren();
  $("#empty-chat").hidden = false;
  $("#approvals").replaceChildren();
  resetActivity();
  setRunning(false);
  setView("chat");
}

async function openConversation(id) {
  state.conversationId = id;
  state.events?.close();
  const c = await api(`/api/conversations/${id}`);
  $("#messages").replaceChildren(...c.messages.map(messageNode));
  $("#empty-chat").hidden = c.messages.length > 0;
  $("#approvals").replaceChildren();
  resetActivity();
  const last = [...c.messages].reverse().find((m) => m.steps?.length);
  for (const line of last?.steps ?? []) addStep(line, false);
  setView("chat");
  await refreshConversations();
  scrollMessages();
  connectEvents(id);
}

function connectEvents(id) {
  const source = new EventSource(`/api/conversations/${id}/events`);
  state.events = source;
  source.onmessage = (e) => {
    if (state.conversationId !== id) return source.close();
    handleEvent(JSON.parse(e.data));
  };
}

function handleEvent(event) {
  switch (event.type) {
    case "snapshot":
      setRunning(event.running);
      if (event.running) {
        resetActivity();
        for (const line of event.steps) addStep(line, false);
      }
      $("#approvals").replaceChildren(...event.approvals.map(approvalNode));
      break;
    case "status":
      setRunning(event.running);
      if (event.running) resetActivity();
      refreshConversations();
      break;
    case "step":
      addStep(event.line, true);
      break;
    case "message":
      $("#empty-chat").hidden = true;
      $("#messages").append(messageNode(event.message));
      scrollMessages();
      break;
    case "approval":
      $("#approvals").append(approvalNode(event.approval));
      break;
    case "approval_resolved":
      document.querySelector(`[data-approval="${CSS.escape(event.id)}"]`)?.remove();
      break;
  }
}

function setRunning(running) {
  state.running = running;
  $("#working").hidden = !running;
  $("#send").disabled = running;
}

function scrollMessages() {
  const box = $("#messages");
  box.scrollTop = box.scrollHeight;
}

// ---------- messages ----------

function messageNode(m) {
  if (m.role === "user") {
    return el("div", { class: "message-wrap-user" }, el("div", { class: "message-user", text: m.text }));
  }
  if (m.role === "error") {
    return el("div", { class: "message message-error", role: "alert" }, el("p", { text: m.text }));
  }
  const lane = m.agent ? AGENT_LANE[m.agent] : "lead";
  const who = m.agent ? Object.keys(LANES).find((k) => LANES[k].key === lane) : m.route === "team" ? "Team" : "Team lead";
  const node = el("article", { class: `message message-team lane-${lane}` }, el("div", { class: "message-meta", text: who }), renderMarkdown(m.text));
  if (m.steps?.length) {
    const lanes = el("ol", { class: "lanes" }, ...m.steps.map((line) => stepItem(line)));
    node.append(el("details", { class: "steps-toggle" }, el("summary", { text: `Show ${m.steps.length} steps` }), lanes));
  }
  return node;
}

function approvalNode(a) {
  const decide = async (approved, box) => {
    for (const b of box.querySelectorAll("button")) b.disabled = true;
    try {
      await api(`/api/approvals/${a.id}`, { method: "POST", body: { approved } });
    } catch (err) {
      box.remove();
      alert(err.message);
    }
  };
  const box = el("div", { class: "approval", "data-approval": a.id, role: "group", "aria-label": "Command approval" });
  box.append(
    el("p", {}, el("strong", { text: "The developer wants to run a command. " }), document.createTextNode(a.reason.charAt(0).toUpperCase() + a.reason.slice(1))),
    el("code", { text: a.command }),
    el(
      "div",
      { class: "approval-actions" },
      el("button", { class: "button-primary", text: "Run command", onclick: () => decide(true, box) }),
      el("button", { class: "link-button", text: "Decline", onclick: () => decide(false, box) }),
    ),
  );
  return box;
}

// ---------- activity ----------

function resetActivity() {
  $("#activity").replaceChildren();
  $("#activity-empty").hidden = false;
  $(".activity").classList.remove("has-steps");
}

function addStep(line, isNew) {
  $("#activity-empty").hidden = true;
  $(".activity").classList.add("has-steps");
  const list = $("#activity");
  list.append(stepItem(line, isNew));
  list.scrollTop = list.scrollHeight;
}

// ---------- composer ----------

function renderSuggestions() {
  $("#suggestions").replaceChildren(
    ...SUGGESTIONS.map((s) =>
      el(
        "button",
        {
          type: "button",
          class: `suggestion lane-${s.lane}`,
          onclick: () => {
            $("#message").value = s.text;
            $("#message").focus();
          },
        },
        el("small", { text: s.who }),
        document.createTextNode(s.text),
      ),
    ),
  );
}

$("#message").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#message").value.trim();
  if (!text || state.running) return;
  try {
    if (!state.conversationId) {
      const c = await api("/api/conversations", { method: "POST" });
      state.conversationId = c.id;
      connectEvents(c.id);
    }
    setRunning(true);
    await api(`/api/conversations/${state.conversationId}/messages`, {
      method: "POST",
      body: { text, webSearch: $("#opt-web").checked, review: $("#opt-review").checked },
    });
    $("#message").value = "";
    $("#empty-chat").hidden = true;
  } catch (err) {
    setRunning(false);
    alert(err.message);
  }
});

// ---------- files ----------

async function loadFiles() {
  const { files } = await api("/api/files");
  $("#files-empty").hidden = files.length > 0;
  $("#file-list").replaceChildren(
    ...files.map((f) =>
      f.endsWith("/")
        ? el("li", { class: "dir", text: f })
        : el("li", {}, el("button", { text: f.split("/").pop(), title: f, "data-path": f, onclick: () => openFile(f) })),
    ),
  );
}

async function openFile(path) {
  for (const b of document.querySelectorAll("#file-list button")) b.setAttribute("aria-current", String(b.dataset.path === path));
  $("#file-name").textContent = path;
  const download = $("#file-download");
  download.href = `/api/files/content?download=1&path=${encodeURIComponent(path)}`;
  download.hidden = false;
  try {
    $("#file-content").textContent = await api(`/api/files/content?path=${encodeURIComponent(path)}`);
  } catch (err) {
    $("#file-content").textContent = err.message;
  }
}

// ---------- board ----------

const STATUS_NAMES = { todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done" };

async function loadBoard() {
  const { tasks } = await api("/api/board");
  $("#board-empty").hidden = tasks.length > 0;
  $("#board").hidden = tasks.length === 0;
  $("#board").replaceChildren(
    ...Object.entries(STATUS_NAMES).map(([status, name]) => {
      const items = tasks.filter((t) => t.status === status);
      return el(
        "section",
        { class: "board-column", "data-status": status },
        el("h2", {}, el("span", { text: name }), el("span", { text: String(items.length) })),
        el(
          "ul",
          {},
          ...items.map((t) =>
            el(
              "li",
              { class: "task" },
              el("div", { class: "task-title", text: t.title }),
              el("div", { class: "task-meta", text: [t.id, t.owner, t.due && `due ${t.due}`].filter(Boolean).join(", ") }),
              t.notes ? el("div", { class: "task-meta", text: t.notes }) : null,
            ),
          ),
        ),
      );
    }),
  );
}

// ---------- memory ----------

const MEMORY_SECTIONS = [
  ["semantic", "Facts about your business", "What the team has learned about your company, product, audience and preferences."],
  ["procedural", "Lessons", "What reviewers taught the team about doing the work better."],
  ["episodic", "Past requests", "A log of what the team has worked on."],
];

async function loadMemory() {
  const data = await api("/api/memory");
  $("#memory").replaceChildren(
    ...MEMORY_SECTIONS.map(([kind, title, description]) => {
      const items = data[kind] ?? [];
      return el(
        "section",
        {},
        el("h2", { text: title }),
        el("p", { text: description }),
        items.length
          ? el("ul", {}, ...[...items].reverse().map((m) => el("li", { text: m.text })))
          : el("p", { class: "empty-note", text: "Nothing yet." }),
      );
    }),
  );
}
