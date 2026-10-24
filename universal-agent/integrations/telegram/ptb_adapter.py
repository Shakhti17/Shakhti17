"""Connect Ofis to a python-telegram-bot (v21+) Application.

    from ofis_bridge import OfisBridge
    from ptb_adapter import register_ofis

    bridge = OfisBridge.from_env()
    register_ofis(application, bridge)   # before or after your own handlers
"""
from __future__ import annotations

from typing import Any

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, InputFile, Update
from telegram.error import BadRequest
from telegram.ext import (
    Application,
    ApplicationHandlerStop,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from ofis_bridge import OfisBridge

HELP = (
    "You're talking to your Ofis team (Program Manager, Senior Developer, Marketing Manager).\n\n"
    "Just write what you need. Commands:\n"
    "/files: list files the team made\n"
    "/file <path>: get one of them\n"
    "/ofis_new: start a fresh conversation\n"
    "/ofis_exit: go back to the normal bot"
)


class PtbChat:
    def __init__(self, bot: Any, chat_id: int) -> None:
        self.bot, self.chat_id = bot, chat_id

    async def send(self, text: str) -> Any:
        return await self.bot.send_message(self.chat_id, text)

    async def edit(self, handle: Any, text: str) -> None:
        try:
            await self.bot.edit_message_text(text, chat_id=self.chat_id, message_id=handle.message_id)
        except BadRequest:
            pass  # e.g. "message is not modified"

    async def send_approval(self, approval_id: str, command: str, reason: str) -> Any:
        keyboard = InlineKeyboardMarkup(
            [[
                InlineKeyboardButton("✅ Run command", callback_data=f"ofis:a:{approval_id}"),
                InlineKeyboardButton("❌ Decline", callback_data=f"ofis:d:{approval_id}"),
            ]]
        )
        text = f"🛠 The developer wants to run a command.\n{reason}\n\n$ {command}"
        return await self.bot.send_message(self.chat_id, text, reply_markup=keyboard)

    async def send_file(self, filename: str, data: bytes) -> None:
        await self.bot.send_document(self.chat_id, InputFile(data, filename=filename))


def register_ofis(application: Application, bridge: OfisBridge, *, command: str = "ofis", group: int = -1) -> None:
    """Add Ofis handlers. They run before your own handlers (group -1) and only take over in team mode."""

    def allowed(update: Update) -> bool:
        return bridge.is_allowed(update.effective_user.id if update.effective_user else None)

    async def enter(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not allowed(update):
            return
        chat_id = update.effective_chat.id
        bridge.enter(chat_id)
        text = " ".join(context.args or [])
        if text:
            context.application.create_task(bridge.ask(chat_id, text, PtbChat(context.bot, chat_id)))
        else:
            await update.message.reply_text(HELP)
        raise ApplicationHandlerStop

    async def leave(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not allowed(update):
            return
        bridge.leave(update.effective_chat.id)
        await update.message.reply_text(f"Back to the normal bot. Send /{command} to talk to the team again.")
        raise ApplicationHandlerStop

    async def new(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not allowed(update):
            return
        bridge.new_conversation(update.effective_chat.id)
        await update.message.reply_text("Started a fresh conversation with the team.")
        raise ApplicationHandlerStop

    async def files(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not allowed(update) or not bridge.is_active(update.effective_chat.id):
            return
        await bridge.list_files(PtbChat(context.bot, update.effective_chat.id))
        raise ApplicationHandlerStop

    async def file(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not allowed(update) or not bridge.is_active(update.effective_chat.id):
            return
        await bridge.send_file(" ".join(context.args or []), PtbChat(context.bot, update.effective_chat.id))
        raise ApplicationHandlerStop

    async def text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        chat_id = update.effective_chat.id
        if not allowed(update) or not bridge.is_active(chat_id):
            return  # not in team mode: let the bot's own handlers deal with it
        # Run in the background so the bot stays responsive during long team runs.
        context.application.create_task(bridge.ask(chat_id, update.message.text, PtbChat(context.bot, chat_id)))
        raise ApplicationHandlerStop

    async def decision(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        if not allowed(update):
            await query.answer("Not allowed.")
            return
        _, action, approval_id = query.data.split(":", 2)
        result = await bridge.decide(approval_id, action == "a")
        await query.answer(result[:190])
        try:
            await query.edit_message_text(f"{query.message.text}\n\n{result}")
        except BadRequest:
            pass
        raise ApplicationHandlerStop

    application.add_handler(CommandHandler(command, enter), group=group)
    application.add_handler(CommandHandler(f"{command}_exit", leave), group=group)
    application.add_handler(CommandHandler(f"{command}_new", new), group=group)
    application.add_handler(CommandHandler("files", files), group=group)
    application.add_handler(CommandHandler("file", file), group=group)
    application.add_handler(CallbackQueryHandler(decision, pattern=r"^ofis:[ad]:"), group=group)
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text), group=group)
