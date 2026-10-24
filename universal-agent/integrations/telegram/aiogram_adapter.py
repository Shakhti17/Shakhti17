"""Connect Ofis to an aiogram (v3) bot.

    from ofis_bridge import OfisBridge
    from aiogram_adapter import ofis_router

    bridge = OfisBridge.from_env()
    dp.include_router(ofis_router(bridge))   # include it BEFORE your own routers
"""
from __future__ import annotations

import asyncio
from typing import Any

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject
from aiogram.types import BufferedInputFile, CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message

from ofis_bridge import OfisBridge

HELP = (
    "You're talking to your Ofis team (Program Manager, Senior Developer, Marketing Manager).\n\n"
    "Just write what you need. Commands:\n"
    "/files: list files the team made\n"
    "/file <path>: get one of them\n"
    "/ofis_new: start a fresh conversation\n"
    "/ofis_exit: go back to the normal bot"
)


class AiogramChat:
    def __init__(self, bot: Bot, chat_id: int) -> None:
        self.bot, self.chat_id = bot, chat_id

    async def send(self, text: str) -> Any:
        return await self.bot.send_message(self.chat_id, text)

    async def edit(self, handle: Any, text: str) -> None:
        try:
            await self.bot.edit_message_text(text, chat_id=self.chat_id, message_id=handle.message_id)
        except TelegramBadRequest:
            pass  # e.g. "message is not modified"

    async def send_approval(self, approval_id: str, command: str, reason: str) -> Any:
        keyboard = InlineKeyboardMarkup(
            inline_keyboard=[[
                InlineKeyboardButton(text="✅ Run command", callback_data=f"ofis:a:{approval_id}"),
                InlineKeyboardButton(text="❌ Decline", callback_data=f"ofis:d:{approval_id}"),
            ]]
        )
        text = f"🛠 The developer wants to run a command.\n{reason}\n\n$ {command}"
        return await self.bot.send_message(self.chat_id, text, reply_markup=keyboard)

    async def send_file(self, filename: str, data: bytes) -> None:
        await self.bot.send_document(self.chat_id, BufferedInputFile(data, filename=filename))


def ofis_router(bridge: OfisBridge, *, command: str = "ofis") -> Router:
    router = Router(name="ofis")
    tasks: set[asyncio.Task] = set()

    def allowed(message: Message) -> bool:
        return bridge.is_allowed(message.from_user.id if message.from_user else None)

    def active(message: Message) -> bool:
        return allowed(message) and bridge.is_active(message.chat.id)

    def background(coro: Any) -> None:
        # Keep a reference so the task isn't garbage-collected mid-run.
        task = asyncio.create_task(coro)
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    @router.message(Command(command), allowed)
    async def enter(message: Message, command: CommandObject, bot: Bot) -> None:
        bridge.enter(message.chat.id)
        if command.args:
            background(bridge.ask(message.chat.id, command.args, AiogramChat(bot, message.chat.id)))
        else:
            await message.answer(HELP)

    @router.message(Command(f"{command}_exit"), allowed)
    async def leave(message: Message) -> None:
        bridge.leave(message.chat.id)
        await message.answer(f"Back to the normal bot. Send /{command} to talk to the team again.")

    @router.message(Command(f"{command}_new"), allowed)
    async def new(message: Message) -> None:
        bridge.new_conversation(message.chat.id)
        await message.answer("Started a fresh conversation with the team.")

    @router.message(Command("files"), active)
    async def files(message: Message, bot: Bot) -> None:
        await bridge.list_files(AiogramChat(bot, message.chat.id))

    @router.message(Command("file"), active)
    async def file(message: Message, command: CommandObject, bot: Bot) -> None:
        await bridge.send_file(command.args or "", AiogramChat(bot, message.chat.id))

    @router.message(F.text & ~F.text.startswith("/"), active)
    async def text(message: Message, bot: Bot) -> None:
        background(bridge.ask(message.chat.id, message.text, AiogramChat(bot, message.chat.id)))

    @router.callback_query(F.data.startswith("ofis:"))
    async def decision(query: CallbackQuery) -> None:
        if not bridge.is_allowed(query.from_user.id):
            await query.answer("Not allowed.")
            return
        _, action, approval_id = query.data.split(":", 2)
        result = await bridge.decide(approval_id, action == "a")
        await query.answer(result[:190])
        if query.message:
            try:
                await query.message.edit_text(f"{query.message.text}\n\n{result}")
            except TelegramBadRequest:
                pass

    return router
