# Ofis in Telegram

Talk to your Ofis team (Program Manager, Senior Developer, Marketing Manager) from an existing
Python Telegram bot. The bot can run on a different server and keep its own Claude API key:
it only relays messages, while Ofis does the work with its own key.

```
/ofis                    → team mode on (your bot's other features pause in this chat)
Plan a launch for Friday → the team works; one status message updates with progress
                           🛠 The developer wants to run a command.  [✅ Run command] [❌ Decline]
                         → the reply arrives when the team is done
/files, /file <path>     → list or download files the team made
/ofis_new                → fresh conversation
/ofis_exit               → back to your normal bot
```

Only the Telegram user IDs you allow can use it, so strangers can't spend your credit or run
commands on your server.

## 1. Get the API token from the Ofis server

Update Ofis once (this also creates the token), then read it:

```bash
curl -fsSL https://raw.githubusercontent.com/Shakhti17/Shakhti17/main/universal-agent/deploy/install.sh | bash
grep OFIS_API_TOKEN /opt/ofis/universal-agent/.env
```

## 2. Add it to your bot (on the bot's server)

Copy `ofis_client.py`, `ofis_bridge.py` and the adapter for your framework next to your bot's code,
then `pip install httpx`.

Set these environment variables for the bot:

| Variable | Value |
|---|---|
| `OFIS_URL` | `https://179-198-193-132.sslip.io` (your Ofis address) |
| `OFIS_API_TOKEN` | the token from step 1 |
| `OFIS_ALLOWED_USERS` | your Telegram user ID (comma-separate several); [@userinfobot](https://t.me/userinfobot) tells you yours |

**python-telegram-bot (v21+):**

```python
from ofis_bridge import OfisBridge
from ptb_adapter import register_ofis

register_ofis(application, OfisBridge.from_env())
```

**aiogram (v3):**

```python
from ofis_bridge import OfisBridge
from aiogram_adapter import ofis_router

dp.include_router(ofis_router(OfisBridge.from_env()))  # before your own routers
```

The Ofis handlers only take over in chats that are in team mode, so the rest of your bot works
as before. Which Telegram chat belongs to which Ofis conversation is saved in
`ofis_telegram.json` next to the bot, so restarts keep the context.

Want to try it without touching your bot? `example_bot.py` is a complete minimal bot:
`pip install httpx "python-telegram-bot>=21"`, set `TELEGRAM_BOT_TOKEN` plus the variables
above, and run `python example_bot.py`.

## Tests

`pytest tests` runs the bridge against a real Ofis server with a mocked Claude API (needs Node.js
and `npm install` in `universal-agent/`): approvals, replies, conversation memory, files, a
deleted conversation and a wrong token.
