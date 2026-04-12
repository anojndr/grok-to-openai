# grok-to-openai

OpenAI-compatible bridge for authenticated `grok.com` web sessions. The server
drives Grok through the same web endpoints the site uses via a persistent
Playwright browser profile. It does not use the official xAI API.

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`
- `GET /v1/responses/:response_id`
- `POST /v1/chat/completions`
- `POST /v1/files`
- `GET /v1/files/:file_id`
- `GET /v1/files/:file_id/content`

## Supported behavior

- `/v1/responses` accepts a string, one message object, or a message array.
- `system` and `developer` messages are folded into Grok custom instructions.
- `input_file` supports `file_id`, `file_url`, and inline `file_data`.
- Image inputs support Responses `input_image` and Chat Completions
  `image_url`, including remote URLs and Base64 data URLs.
- Multi-turn Responses uses `previous_response_id`.
- If the original Grok conversation no longer exists, the bridge can replay the
  locally stored conversation history and attachments to continue the thread.
- A single `GROK_COOKIE_FILE` or `GROK_COOKIES_TEXT` value can define one or
  many Grok accounts by concatenating multiple Netscape cookie-file blocks.
- New requests and replay fallbacks iterate configured accounts in deterministic
  top-to-bottom order until one succeeds.
- If `grok-4-auto`, `grok-4-expert`, or `grok-4-heavy` exhaust every
  configured account, the bridge retries once in `grok-4-fast`.
- Follow-up requests first try the account that owns the stored Grok thread. If
  that follow-up fails, the bridge rebuilds the full conversation history,
  including attachments, as one replay message and retries across the account
  list.
- Completed text preserves Grok inline citations as shortened Markdown links by
  default.
- Optional `source_attribution` can append source lists and search queries.
- Grok image generation and image edits are exposed instead of being dropped.
- Uploaded files and Responses state are persisted under `.data/` by default
  or in PostgreSQL when `DATABASE_URL` is set.

## Model routing

`GET /v1/models` returns:

- `grok-4-auto`
- `grok-4-fast`
- `grok-4-expert`
- `grok-4-heavy`

Accepted aliases are intentionally broad:

- `grok`, `grok-latest`, `grok-4`, `grok-3`, `gpt-4o`, `gpt-4.1`, and `gpt-5`
  all route to auto mode.
- Names containing `fast`, `expert`, `heavy`, or `auto` route to that Grok
  mode even if the exact string is not listed above.
- If `model` is omitted, `DEFAULT_MODEL` is used.
- If no explicit mode is present, `reasoning.effort=high` on Responses or
  `reasoning_effort=high` on Chat Completions routes to expert mode.

## Response shapes

Responses image output follows the OpenAI-style `image_generation_call` item
pattern and also includes a bridge-specific `result_url`:

```json
{
  "output": [
    {
      "id": "ig_...",
      "type": "image_generation_call",
      "status": "completed",
      "result": "<base64 image bytes>",
      "result_url": "https://assets.grok.com/.../image.jpg",
      "mime_type": "image/jpeg",
      "action": "generate"
    }
  ]
}
```

Chat Completions keeps the assistant text usable for Markdown clients and adds
structured image metadata in a bridge-specific `message.image_urls` field:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "![Generated Image](https://assets.grok.com/.../image.jpg)",
        "image_urls": [
          {
            "url": "https://assets.grok.com/.../image.jpg",
            "mime_type": "image/jpeg",
            "action": "generate"
          }
        ]
      }
    }
  ]
}
```

## Compatibility notes

- `/v1/responses` does not implement `conversation`; use
  `previous_response_id`.
- Tool or function calling is not implemented.
- Chat Completions ignores `tool` messages.
- Chat Completions only supports `n=1`.
- Several OpenAI fields are accepted for compatibility but are not translated
  into equivalent Grok behavior. This includes `tools`, `tool_choice`,
  `response_format`, `stop`, `max_tokens`, `max_completion_tokens`, and
  `stream_options.include_usage`.
- If you send multi-message history without `previous_response_id`, prior turns
  are flattened into a transcript prompt. The final message must be a user
  message, and only the final user turn's attachments are uploaded.
- `store: false` is reflected in the Responses object, but Responses are still
  stored locally so `GET /v1/responses/:response_id` and continuation replay
  keep working.
- Responses usage is `null`. Non-streaming Chat Completions returns placeholder
  zero usage.
- Streaming forwards Grok token deltas live for every model instead of
  buffering `auto`, `expert`, or `heavy` responses until completion.
- Live streaming suppresses Grok thinking-phase tokens. This uses Grok's actual
  stream metadata, so `grok-4-auto` also hides thought when it internally
  escalates to Expert or Heavy behavior.
- If Grok's final normalized answer differs from the raw live stream, the
  closing `/v1/responses` events still carry the canonical final text, with
  Grok Expert and Heavy thought sections removed from bridge output.
- Streaming text strips inline citation tags instead of rewriting them on the
  fly.
- Streaming `/v1/responses` still returns final source attribution metadata in
  the closing `response.completed` event when available.
- Streaming `/v1/chat/completions` does not currently emit a parallel citation
  metadata chunk.
- Responses streaming emits completed image items only after the final asset
  URL is known. Partial image preview events are not proxied.
- Responses image items try to hydrate `result` with Base64 bytes from the
  final Grok asset. If that fetch fails, the item keeps `result_url` and
  exposes `result_error`.
- Automated login with `GROK_EMAIL` or `GROK_PASSWORD` is not implemented.
- Older monolithic filesystem `responses.json` records created before history
  snapshots were added may not be replayable if a continuation has to rebuild
  missing attachments.

## Requirements

- Node.js `>=20`
- Chrome or Chromium available to `playwright-core`
- An authenticated Grok web session

`playwright-core` does not download a browser. Set
`CHROME_EXECUTABLE_PATH` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an
installed browser binary.

## Setup

Install dependencies:

```bash
npm install
```

The project loads `.env` automatically. Example:

```bash
HOST=127.0.0.1
PORT=8787
BRIDGE_API_KEY=sk-local-test
CHROME_EXECUTABLE_PATH=/path/to/chrome
GROK_COOKIE_FILE=.grok.cookies.txt
HEADLESS=true
IMPORT_COOKIES_ON_BOOT=true
BROWSER_PROFILE_DIR=.browser-profile
DATA_DIR=.data
DATABASE_URL=postgresql://user:pass@db.example.com:5432/groktoopenai?sslmode=disable
DEFAULT_MODEL=grok-4-auto
ALLOW_ORIGINS=*
```

Supported configuration:

- `HOST`, `PORT`
- `BRIDGE_API_KEY`
  Leave empty to disable bearer auth.
- `CHROME_EXECUTABLE_PATH`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
- `GROK_COOKIE_FILE`
  Netscape-format cookie file. You can concatenate multiple Netscape cookie
  files into one file to define multiple accounts.
- `GROK_COOKIES_TEXT`
  Inline Netscape-format cookie text. Multiple concatenated Netscape blocks are
  treated as multiple accounts.
- `GROK_BASE_URL`
  Defaults to `https://grok.com`.
- `HEADLESS`, `IMPORT_COOKIES_ON_BOOT`
- `BROWSER_PROFILE_DIR`, `DATA_DIR`
- `DATABASE_URL`, `POSTGRES_URL`
  When set to a `postgres://` or `postgresql://` URL, uploaded files and stored
  Responses move from `.data/` into PostgreSQL.
- `DEFAULT_MODEL`
- `ALLOW_ORIGINS`

Currently parsed but unused:

- `GROK_EMAIL`
- `GROK_PASSWORD`
- `DEFAULT_MODE`

If cookie import alone is rejected by Grok's anti-bot layer, warm the browser
profile once with a visible browser:

```bash
export HEADLESS=false
npm start
```

For multi-account setups, concatenate each account's full Netscape cookie file
into the same secret file in the order you want the bridge to use them. When
more than one account is configured, `BROWSER_PROFILE_DIR` is automatically
split into per-account subdirectories such as `account-001`, `account-002`,
and so on.

Log in manually, then restart with `HEADLESS=true` if you want a headless
server again.

Start the server:

```bash
npm start
```

Run tests:

```bash
npm test
```

## Examples

Basic Responses request:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4-auto",
    "input": "Reply with the single word PONG."
  }'
```

Streaming Responses request:

```bash
curl -N http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4-fast",
    "input": "Write one short paragraph.",
    "stream": true
  }'
```

Chat Completions request with an image:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4-auto",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "What is in this image?" },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"
            }
          }
        ]
      }
    ]
  }'
```

Upload a file:

```bash
curl http://127.0.0.1:8787/v1/files \
  -H "Authorization: Bearer sk-local-test" \
  -F purpose=user_data \
  -F file=@fixtures/sample-note.txt
```

Use the returned `file_id` in a Responses request:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4-auto",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_file", "file_id": "file_..." },
          { "type": "input_text", "text": "Summarize this file." }
        ]
      }
    ]
  }'
```

Continue a prior Responses thread:

```bash
FIRST=$(curl -s http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{"model":"grok-4-auto","input":"Tell me a joke."}')

RESP_ID=$(printf '%s' "$FIRST" | node -e 'process.stdin.once("data", d => console.log(JSON.parse(d).id))')

curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"grok-4-auto\",
    \"previous_response_id\": \"$RESP_ID\",
    \"input\": [{\"role\":\"user\",\"content\":\"Tell me another.\"}]
  }"
```

Request sources and query provenance:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4-auto",
    "input": "Summarize the latest AI news in one paragraph.",
    "source_attribution": {
      "include_sources": true,
      "include_search_queries": true
    }
  }'
```

## Local state

By default the bridge writes:

- `.browser-profile/`
  Persistent Playwright profile used for Grok web auth.
- `.data/files/`
  Uploaded file contents.
- `.data/files-index.json`
  Metadata returned by `/v1/files`.
- `.data/responses/`
  One compact JSON file per stored Response, containing the OpenAI payload plus
  Grok conversation state and replay history. Older monolithic
  `.data/responses.json` records are still read and migrated on first access.

When `DATABASE_URL` or `POSTGRES_URL` is set, uploaded files and stored
Responses are kept in PostgreSQL tables `bridge_files` and `bridge_responses`
instead, and only the Playwright browser profile remains on disk.
