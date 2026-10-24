"""Framework-independent logic that connects a Telegram chat to the Ofis team.

Adapters for python-telegram-bot (ptb_adapter.py) and aiogram (aiogram_adapter.py)
implement the small `Chat` interface below and call the bridge.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Protocol

from ofis_client import OfisBusy, OfisClient, OfisError, OfisNotFound

TELEGRAM_LIMIT = 4096
STATUS_EDIT_SECONDS = 3.0

TOOL_WORDS = {
    "write_file": "Wrote",
    "edit_file": "Edited",
    "read_file": "Read",
    "list_files": "Looked through files",
    "run_command": "Ran",
    "compute_schedule": "Calculated the schedule",
    "score_risks": "Scored risks",
    "manage_tasks": "Updated the task board",
    "content_check": "Checked the copy",
    "build_utm_links": "Built tracking links",
    "web_search": "Searched the web",
    "recall_memory": "Checked memory",
    "save_memory": "Saved to memory",
}


class Chat(Protocol):
    """What the bridge needs from a Telegram framework, for one chat."""

    async def send(self, text: str) -> Any: ...
    async def edit(self, handle: Any, text: str) -> None: ...
    async def send_approval(self, approval_id: str, command: str, reason: str) -> Any: ...
    async def send_file(self, filename: str, data: bytes) -> None: ...


def describe_step(line: str) -> str:
    """Turn an Ofis log line like '   [Senior Developer T2] write_file app.js' into plain words."""
    m = re.search(r"\[(Program Manager|Senior Developer|Marketing Manager)(?: (T\d+))?\]\s+(.*)", line)
    if not m:
        return line.strip().lstrip("→").strip()
    who, _task, rest = m.groups()
    review = re.match(r"review ([\d.]+)/5 - (\w+)", rest)
    if review:
        verdict = "review passed" if review.group(2) == "approved" else "revising after review"
        return f"{who}: {verdict} ({review.group(1)}/5)"
    tool, _, detail = rest.partition(" ")
    detail = "" if detail.strip() == "." else detail.strip()
    return f"{who}: {TOOL_WORDS.get(tool, tool)}{' ' + detail if detail else ''}"


def split_message(text: str, limit: int = TELEGRAM_LIMIT) -> list[str]:
    """Split long replies at paragraph or line breaks so each part fits in one Telegram message."""
    parts: list[str] = []
    rest = text.strip() or "(empty reply)"
    while len(rest) > limit:
        cut = rest.rfind("\n\n", 0, limit)
        if cut < limit // 2:
            cut = rest.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = limit
        parts.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    parts.append(rest)
    return parts


class OfisBridge:
    def __init__(
        self,
        client: OfisClient,
        allowed_user_ids: set[int],
        store_path: str | os.PathLike[str] = "ofis_telegram.json",
        *,
        web_search: bool = True,
        review: bool = True,
    ) -> None:
        self.client = client
        self.allowed_user_ids = allowed_user_ids
        self.store_path = Path(store_path)
        self.web_search = web_search
        self.review = review
        self._lock = asyncio.Lock()
        self._state = {"conversations": {}, "active": []}
        if self.store_path.exists():
            self._state.update(json.loads(self.store_path.read_text()))

    @classmethod
    def from_env(cls, store_path: str = "ofis_telegram.json") -> "OfisBridge":
        """Build a bridge from OFIS_URL, OFIS_API_TOKEN and OFIS_ALLOWED_USERS (comma-separated Telegram user IDs)."""
        url = os.environ["OFIS_URL"]
        token = os.environ["OFIS_API_TOKEN"]
        allowed = {int(x) for x in os.environ.get("OFIS_ALLOWED_USERS", "").replace(" ", "").split(",") if x}
        if not allowed:
            raise ValueError("Set OFIS_ALLOWED_USERS to your Telegram user ID, so strangers can't use your Ofis")
        return cls(OfisClient(url, token), allowed, store_path)

    # ---------- state ----------

    def is_allowed(self, user_id: int | None) -> bool:
        return user_id is not None and user_id in self.allowed_user_ids

    def is_active(self, chat_id: int) -> bool:
        return chat_id in self._state["active"]

    def _save(self) -> None:
        tmp = self.store_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._state, indent=2))
        tmp.replace(self.store_path)

    def enter(self, chat_id: int) -> None:
        if chat_id not in self._state["active"]:
            self._state["active"].append(chat_id)
            self._save()

    def leave(self, chat_id: int) -> None:
        if chat_id in self._state["active"]:
            self._state["active"].remove(chat_id)
            self._save()

    def new_conversation(self, chat_id: int) -> None:
        self._state["conversations"].pop(str(chat_id), None)
        self._save()

    async def _conversation_id(self, chat_id: int) -> str:
        async with self._lock:
            existing = self._state["conversations"].get(str(chat_id))
            if existing:
                return existing
            conversation_id = await self.client.create_conversation()
            self._state["conversations"][str(chat_id)] = conversation_id
            self._save()
            return conversation_id

    # ---------- actions ----------

    async def ask(self, chat_id: int, text: str, chat: Chat) -> None:
        """Send one message to the team and relay progress, approvals and the reply."""
        try:
            await self._ask(chat_id, text, chat)
        except OfisNotFound:
            # The conversation was deleted in the web app: start a fresh one and retry once.
            self.new_conversation(chat_id)
            try:
                await self._ask(chat_id, text, chat)
            except OfisError as err:
                await chat.send(f"⚠️ {err}")
        except OfisError as err:
            await chat.send(f"⚠️ {err}")

    async def _ask(self, chat_id: int, text: str, chat: Chat) -> None:
        conversation_id = await self._conversation_id(chat_id)
        async with self.client.events(conversation_id) as events:
            stream = events.__aiter__()
            snapshot = await anext(stream)  # connected: nothing can be missed from here on
            if snapshot.get("running"):
                await chat.send("⏳ The team is still working on your previous message.")
                return
            try:
                await self.client.send_message(conversation_id, text, web_search=self.web_search, review=self.review)
            except OfisBusy:
                await chat.send("⏳ The team is still working on your previous message.")
                return

            status = await chat.send("🧑‍💼 The team is on it…")
            steps: list[str] = []
            last_edit = 0.0
            async for event in stream:
                kind = event.get("type")
                if kind == "step":
                    steps.append(describe_step(event["line"]))
                    if time.monotonic() - last_edit >= STATUS_EDIT_SECONDS:
                        await chat.edit(status, "🧑‍💼 Working…\n\n" + "\n".join(f"• {s}" for s in steps[-6:]))
                        last_edit = time.monotonic()
                elif kind == "approval":
                    a = event["approval"]
                    await chat.send_approval(a["id"], a["command"], a.get("reason", ""))
                elif kind == "message" and event["message"]["role"] != "user":
                    reply = event["message"]
                    done = "✅ Done" if reply["role"] == "assistant" else "⚠️ Stopped"
                    await chat.edit(status, f"{done} ({len(steps)} steps)")
                    prefix = "" if reply["role"] == "assistant" else "⚠️ "
                    for part in split_message(prefix + reply["text"]):
                        await chat.send(part)
                    return

    async def decide(self, approval_id: str, approved: bool) -> str:
        try:
            await self.client.decide(approval_id, approved)
        except OfisNotFound:
            return "This request is no longer waiting for approval."
        except OfisError as err:
            return f"⚠️ {err}"
        return "✅ Approved, running it." if approved else "❌ Declined."

    async def list_files(self, chat: Chat) -> None:
        try:
            files = [f for f in await self.client.list_files() if not f.endswith("/")]
        except OfisError as err:
            await chat.send(f"⚠️ {err}")
            return
        if not files:
            await chat.send("The workspace is empty so far.")
            return
        listing = "\n".join(files[-80:])
        for part in split_message(f"Files in the workspace (send /file <path> to get one):\n\n{listing}"):
            await chat.send(part)

    async def send_file(self, path: str, chat: Chat) -> None:
        path = path.strip()
        if not path:
            await chat.send("Usage: /file <path>, for example /file landing/index.html")
            return
        try:
            data = await self.client.download_file(path)
        except OfisNotFound:
            await chat.send(f"No file called {path}. Send /files to see what's there.")
            return
        except OfisError as err:
            await chat.send(f"⚠️ {err}")
            return
        await chat.send_file(Path(path).name, data)
