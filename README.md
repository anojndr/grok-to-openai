# grok-to-openai

OpenAI-compatible API proxy for [grok.com](https://grok.com). It fronts grok's WebSocket chat gateway with a FastAPI server that speaks the OpenAI API, so existing OpenAI clients and tools can talk to Grok unchanged.

## Features

- OpenAI-compatible endpoints: chat completions, responses, image generation, and file uploads
- Multiple grok accounts with cookie-based auth, load balancing, and hot reload from `accounts.txt`
- Multi-turn conversations via a local SQLite store; each turn replays prior history
- Streaming responses
- Optional bearer-token auth

## Setup

```bash
# 1. Add grok.com cookies (Netscape format, one block per account)
#    Each block needs the `sso` cookie (and usually `sso-rw`, `cf_clearance`, `x-userid`).
vim accounts.txt

# 2. Optional: set an API key
echo 'GROK_OPENAI_API_KEY=secret' >> .env

# 3. Run
./run.sh          # creates a venv, installs deps, starts on port 15553
```

Environment variables (defaults in parentheses):

| Variable | Purpose |
| --- | --- |
| `GROK_PORT` (`15553`) | Listen port |
| `GROK_ACCOUNTS_FILE` (`accounts.txt`) | Cookie accounts file |
| `GROK_DB` (`grok_sessions.db`) | SQLite session store |
| `GROK_OPENAI_API_KEY` | If set, requires `Authorization: Bearer <key>` on chat, responses, images, and files requests. `/v1/models` and `/healthz` stay public |
| `GROK_FILES_DIR` (`.openai_files`) | Storage for uploaded files |
| `GROK_LOG` (`server.log`) | Log file used by `restart.sh` |
| `GROK_PIDFILE` (`server.pid`) | PID file used by `restart.sh` |

## Usage

Point any OpenAI client at it:

```bash
curl http://localhost:15553/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "grok-4.5", "messages": [{"role": "user", "content": "Hello"}]}'
```

Supported models: `fast`, `grok-3-mini-fast`, `grok-4.5-fast`, `grok-4.5`, `expert` (aliases map to the same set).

Endpoints:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/images/generations`
- `GET|POST /v1/files`, `GET|DELETE /v1/files/{id}`
- `GET /v1/models`
- `GET /healthz`, `GET /docs` (OpenAPI UI)

## Notes

- The client inside is reverse-engineered from the grok web app and can break when grok changes its gateway.
- Rate limits and quota are those of the accounts in `accounts.txt`; add more accounts to spread load.
- Accounts are reloaded automatically when `accounts.txt` changes, no restart needed.
- Run `restart.sh` to restart the server.

Use with accounts you own. This project is not affiliated with xAI.