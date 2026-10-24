"""A minimal standalone bot that talks to Ofis (python-telegram-bot).

Use it to try the connection, or as a reference for adding Ofis to your own bot.

    pip install -r requirements.txt "python-telegram-bot>=21"
    export TELEGRAM_BOT_TOKEN=...  OFIS_URL=https://...  OFIS_API_TOKEN=...  OFIS_ALLOWED_USERS=123456789
    python example_bot.py
"""
import logging
import os

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

from ofis_bridge import OfisBridge
from ptb_adapter import register_ofis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Your bot's own features would live here. This one just points at Ofis.
    await update.message.reply_text(
        f"Hi! Your Telegram user ID is {update.effective_user.id}.\nSend /ofis to talk to your AI team."
    )


def main() -> None:
    bridge = OfisBridge.from_env()
    app = Application.builder().token(os.environ["TELEGRAM_BOT_TOKEN"]).build()
    app.add_handler(CommandHandler("start", start))
    register_ofis(app, bridge)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
