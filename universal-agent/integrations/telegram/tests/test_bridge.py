"""End-to-end tests: the Telegram bridge against a real Ofis server (mocked Claude API).

    pip install -r requirements.txt pytest
    pytest tests
"""
import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from ofis_bridge import OfisBridge, describe_step, split_message  # noqa: E402
from ofis_client import OfisClient  # noqa: E402

OWNER = 111
STRANGER = 222


@pytest.fixture(scope="module")
def ofis():
    proc = subprocess.Popen(
        ["node", str(HERE / "ofis_test_server.mjs")],
        stdout=subprocess.PIPE,
        text=True,
        cwd=HERE.parents[2],
    )
    info = json.loads(proc.stdout.readline())
    yield info
    proc.terminate()
    proc.wait(timeout=10)


class FakeChat:
    """Records what the bridge would show in Telegram and approves commands like a user tapping the button."""

    def __init__(self, bridge, approve=True):
        self.bridge, self.approve = bridge, approve
        self.sent, self.edits, self.approvals, self.files = [], [], [], []

    async def send(self, text):
        self.sent.append(text)
        return len(self.sent)

    async def edit(self, handle, text):
        self.edits.append(text)

    async def send_approval(self, approval_id, command, reason):
        self.approvals.append((command, reason))
        self.decisions = getattr(self, "decisions", [])
        self.decisions.append(await self.bridge.decide(approval_id, self.approve))

    async def send_file(self, filename, data):
        self.files.append((filename, data))


def make_bridge(ofis, tmp_path):
    return OfisBridge(OfisClient(ofis["url"], ofis["token"]), {OWNER}, tmp_path / "state.json", web_search=False, review=False)


def test_full_conversation_from_telegram(ofis, tmp_path):
    async def run():
        bridge = make_bridge(ofis, tmp_path)
        assert bridge.is_allowed(OWNER) and not bridge.is_allowed(STRANGER) and not bridge.is_allowed(None)

        bridge.enter(42)
        assert bridge.is_active(42)
        chat = FakeChat(bridge)
        await bridge.ask(42, "Write hello.js and run it", chat)

        # Approval button shown and pressed; the real command ran on the Ofis side.
        assert chat.approvals == [("node hello/hello.js", "check that it runs")]
        assert chat.decisions == ["✅ Approved, running it."]
        assert chat.sent[0] == "🧑‍💼 The team is on it…"
        assert chat.edits[-1].startswith("✅ Done (")
        assert "salom from telegram" in chat.sent[-1]

        # Same Telegram chat → same Ofis conversation, so the team remembers context.
        first_conversation = bridge._state["conversations"]["42"]
        chat2 = FakeChat(bridge)
        await bridge.ask(42, "Who am I?", chat2)
        assert chat2.sent[-1] == "You asked me to build hello.js earlier."
        assert bridge._state["conversations"]["42"] == first_conversation

        # Files made by the team can be listed and downloaded into Telegram.
        files_chat = FakeChat(bridge)
        await bridge.list_files(files_chat)
        assert "hello/hello.js" in files_chat.sent[0]
        await bridge.send_file("hello/hello.js", files_chat)
        assert files_chat.files == [("hello.js", b"console.log('salom from telegram')")]
        await bridge.send_file("missing.txt", files_chat)
        assert "No file called missing.txt" in files_chat.sent[-1]

        # State survives a restart of the bot.
        reloaded = make_bridge(ofis, tmp_path)
        assert reloaded.is_active(42)
        assert reloaded._state["conversations"]["42"] == first_conversation

        bridge.leave(42)
        assert not bridge.is_active(42)
        await bridge.client.aclose()
        await reloaded.client.aclose()

    asyncio.run(run())


def test_declined_command_and_deleted_conversation(ofis, tmp_path):
    async def run():
        bridge = make_bridge(ofis, tmp_path)
        chat = FakeChat(bridge, approve=False)
        # Point the chat at a conversation that no longer exists: the bridge starts a new one.
        bridge._state["conversations"]["7"] = "00000000-0000-4000-8000-000000000000"
        await bridge.ask(7, "Write hello.js and run it", chat)
        assert chat.decisions == ["❌ Declined."]
        assert bridge._state["conversations"]["7"] != "00000000-0000-4000-8000-000000000000"
        assert chat.edits[-1].startswith("✅ Done (")
        await bridge.client.aclose()

    asyncio.run(run())


def test_wrong_token_gives_a_clear_message(ofis, tmp_path):
    async def run():
        bridge = OfisBridge(OfisClient(ofis["url"], "wrong-token"), {OWNER}, tmp_path / "s.json")
        chat = FakeChat(bridge)
        await bridge.ask(1, "hello", chat)
        assert chat.sent == ["⚠️ Ofis rejected the API token. Check OFIS_API_TOKEN on both servers."]
        await bridge.client.aclose()

    asyncio.run(run())


def test_helpers():
    assert describe_step("   [Senior Developer T2] write_file app/index.js") == "Senior Developer: Wrote app/index.js"
    assert describe_step("   [Program Manager] review 4.5/5 - approved") == "Program Manager: review passed (4.5/5)"
    assert describe_step("→ Team plan:") == "Team plan:"
    parts = split_message(("para " * 300 + "\n\n") * 6, limit=4096)
    assert all(len(p) <= 4096 for p in parts) and len(parts) > 1


def test_adapters_register_without_network():
    from telegram.ext import Application

    from aiogram_adapter import ofis_router
    from ptb_adapter import register_ofis

    bridge = OfisBridge(OfisClient("http://127.0.0.1:9", "token"), {OWNER}, "/tmp/ofis-adapter-test.json")
    app = Application.builder().token("123456:TEST").build()
    register_ofis(app, bridge)
    assert len(app.handlers[-1]) == 7

    router = ofis_router(bridge)
    assert len(router.message.handlers) == 6 and len(router.callback_query.handlers) == 1
