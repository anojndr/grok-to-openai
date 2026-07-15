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
  `image_url`, including remote URLs, Base64 data URLs, and uploaded
  `file_id` references.
- Multi-turn Responses uses `previous_response_id`.
- If the original Grok conversation no longer exists, the bridge can replay the
  locally stored conversation history and attachments to continue the thread.
- A single `GROK_COOKIE_FILE` or `GROK_COOKIES_TEXT` value can define one or
  many Grok accounts by concatenating multiple Netscape cookie-file blocks or
  providing JSON arrays/objects of cookies. The bridge automatically hot-reloads
  these configuration files and updates the active clients when contents change.
- New requests and replay fallbacks always try the primary account first, then
  the current active fallback account. Failed fallback accounts are temporarily quarantined (placed on a 15-minute cooldown), closed,
  and fallback selection advances in deterministic top-to-bottom order, wraps back
  to the secondary account after the last fallback, and raises after two full
  fallback passes fail.
- Account rotation and quarantining are triggered by upstream rate-limit errors
  (HTTP `429`, "too many requests", "heavy usage"), authentication issues (HTTP `401`/`403`, "session expired", or redirect to login pages), and standard session blocks.
- During browser initialization, the bridge automatically dismisses standard Terms
  of Service, Acceptable Use Policies, cookie consents, and privacy update modals
  by dynamically clicking consent buttons on the page.
- If `grok-4.5-auto`, `grok-4.5-expert`, `grok-4.5-heavy`, or `grok-4.5-beta`
  exhaust every configured account or hit an upstream beta stream failure, the
  bridge retries once in `grok-4.5-fast`.
- If an account hits a "Model is not found" upstream error for a premium model, the
  bridge dynamically caches that model as unsupported for that specific account. Subsequent
  requests for the model on that account bypass the upstream check entirely and fall
  back directly to `grok-4.5-fast` (if model fallback is enabled).
- Follow-up requests first try the account that owns the stored Grok thread. If
  that follow-up fails, the bridge rebuilds the full conversation history,
  including attachments, as one replay message and retries across the account
  list.
- Completed text preserves Grok inline citations as shortened Markdown links by
  default.
- Optional `source_attribution` can append source lists and search queries.
- Grok image generation and image edits are exposed instead of being dropped.
- Grok searched image cards are exposed as assistant images with direct source
  URLs instead of being stripped from the reply.
- Uploaded files and Responses state are persisted under `.data/` by default
  or in PostgreSQL when `DATABASE_URL` is set.

## Model routing

`GET /v1/models` returns:

- `grok-4.5-auto`
- `grok-4.5-fast`
- `grok-4.5-expert`
- `grok-4.5-heavy`
- `grok-4.5-beta`

Accepted aliases are intentionally broad:

- `grok`, `grok-latest`, `grok-4.5`, `gpt-4o`, `gpt-4.1`, and `gpt-5`
  all route to auto mode.
- `grok-4.5-beta`, `grok-4.5`, `grok 4.5 (beta)`, and the exact upstream
  `grok-420-computer-use-sa` all route to Grok 4.5 beta mode.
- Names containing `fast`, `expert`, `heavy`, or `auto` route to that Grok
  mode even if the exact string is not listed above.
- If `model` is omitted, `DEFAULT_MODEL` is used.
- If no explicit mode is present, `reasoning.effort=high` on Responses or
  `reasoning_effort=high` on Chat Completions routes to expert mode.
- If a premium/expert model request returns a "Model is not found" error, the
  bridge caches this unsupported model internally for the active account to skip future
  upstream attempts, routing immediately to `grok-4.5-fast` instead.

## Response shapes

Responses image output follows the OpenAI-style `image_generation_call` item
pattern and includes a bridge-specific `result_url`. Generated Grok images are
fetched through the authenticated browser session that created them, uploaded to
Imgbb, and returned as public Imgbb URLs instead of protected
`assets.grok.com` links. Fresh `/v1/responses` creates return `result_url` by
default and avoid embedding inline Base64 image bytes:

```json
{
  "output": [
    {
      "id": "ig_...",
      "type": "image_generation_call",
      "status": "completed",
      "result_url": "https://i.ibb.co/...jpg",
      "mime_type": "image/jpeg",
      "action": "generate"
    }
  ]
}
```

Chat Completions keeps the assistant text usable for Markdown clients and adds
structured image metadata in a bridge-specific `message.image_urls` field. This
is used for both generated images and searched/public image cards:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "![Generated Image](https://i.ibb.co/...jpg)",
        "image_urls": [
          {
            "url": "https://i.ibb.co/...jpg",
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
- If you front the bridge with Cloudflare or another reverse proxy, prefer
  uploading images to `/v1/files` and sending `input_image.file_id` or
  `image_url.file_id`. Inline Base64 image JSON can be challenged before the
  request reaches the bridge.
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
  stream metadata, so `grok-4.5-auto` also hides thought when it internally
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
- `GET /v1/responses/:response_id` reconstructs image `result` lazily from the
  stored assistant attachment when available, so retrieval stays compatible
  without persisting duplicate inline image bytes.
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
DEFAULT_MODEL=grok-4.5-auto
IMGBB_API_KEY=your-imgbb-api-key
IMGBB_EXPIRATION=
ALLOW_ORIGINS=*
```

Supported configuration:

- `HOST`, `PORT`
- `BRIDGE_API_KEY`
  Leave empty to disable bearer auth.
- `CHROME_EXECUTABLE_PATH`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
- `GROK_COOKIE_FILE`
  Cookie file path. Supports standard Netscape format or JSON format.
  - Netscape format: multiple accounts can be defined by concatenating multiple cookie blocks.
  - JSON format: can be a single array of cookie objects, an array of arrays (one per account), concatenated JSON arrays, or an array of account objects containing a `cookies` field.
  The bridge watches this file and hot-reloads it when changed.
- `GROK_COOKIES_TEXT`
  Inline cookie text in Netscape format or JSON format (same parsing rules as `GROK_COOKIE_FILE`).
- `GROK_BASE_URL`
  Defaults to `https://grok.com`.
- `HEADLESS`, `IMPORT_COOKIES_ON_BOOT`
- `BROWSER_PROFILE_DIR`, `DATA_DIR`
- `DATABASE_URL`, `POSTGRES_URL`
  When set to a `postgres://` or `postgresql://` URL, uploaded files and stored
  Responses move from `.data/` into PostgreSQL.
- `DEFAULT_MODEL`
- `IMGBB_API_KEY`
  Required when you want generated Grok images rehosted as public Imgbb URLs.
- `IMGBB_API_URL`
  Defaults to `https://api.imgbb.com/1/upload`.
- `IMGBB_EXPIRATION`
  Optional auto-delete TTL in seconds. Must be between `60` and `15552000`.
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

Imgbb notes:

- Set `IMGBB_API_KEY` if you want generated-image responses to return public
  image URLs.
- The bridge uploads generated images directly to Imgbb with multipart `POST`
  requests and verifies the returned public URL before exposing it.
- The bridge now sets Imgbb's optional upload `name` field from the filename
  and rejects images above Imgbb's documented `32 MB` maximum before upload.

### Multi-account and Failover Routing

The bridge supports running a pool of multiple Grok accounts for load-balancing, rate-limit resilience, and automatic failover:

- **Configuring Multiple Accounts**: 
  - **Netscape format**: Concatenate multiple Netscape cookie blocks (with `# Netscape HTTP Cookie File` headers or separated by duplicate key occurrences) into a single file or env variable.
  - **JSON format**: Supply a JSON array containing arrays of cookie objects, or an array of account objects with a `cookies` property, or multiple concatenated JSON arrays.
- **Isolated Browser Profiles**: When multiple accounts are configured, `BROWSER_PROFILE_DIR` is automatically split into per-account subdirectories (e.g. `account-001`, `account-002`, etc.) to keep browser state and local storage fully isolated.
- **Failover & Rotation**: The bridge automatically starts with the primary account (index 0). If a request fails due to rate limits (HTTP `429` / "too many requests" / "heavy usage") or authentication/session issues (HTTP `401`/`403`, "session expired", or redirect to login pages), that account is temporarily quarantined. The bridge then rotates to the next active fallback account.
- **Quarantine & Dynamic Cooldown**: When an account is quarantined, it is placed on a 15-minute cooldown. If all configured accounts are exhausted, the bridge will reset the unavailable status to retry the pool.
- **Hot-Reloading**: The bridge monitors `GROK_COOKIE_FILE` and `GROK_COOKIES_TEXT`. If changes are detected, it hot-reloads the cookies, gracefully closes existing browser sessions, and re-initializes the account pool in-place without requiring a server reboot.
- **Automatic ToS Modal Dismissal**: During browser startup, the bridge evaluates the page context and automatically dismisses standard Terms of Service, Acceptable Use Policies, cookie consents, or privacy update modals by simulating button clicks (e.g. "Got it", "I agree", "Close") to prevent automation blocks.

Log in manually (by running with `HEADLESS=false` temporarily) if cookies need to be refreshed, then restart with `HEADLESS=true` for headless server execution.

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
    "model": "grok-4.5-auto",
    "input": "Reply with the single word PONG."
  }'
```

Streaming Responses request:

```bash
curl -N http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.5-fast",
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
    "model": "grok-4.5-auto",
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
    "model": "grok-4.5-auto",
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

Use the returned `file_id` in an image input to avoid inline Base64 image JSON:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.5-auto",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "What is in this image?" },
          { "type": "input_image", "file_id": "file_..." }
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
  -d '{"model":"grok-4.5-auto","input":"Tell me a joke."}')

RESP_ID=$(printf '%s' "$FIRST" | node -e 'process.stdin.once("data", d => console.log(JSON.parse(d).id))')

curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"grok-4.5-auto\",
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
    "model": "grok-4.5-auto",
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
- `.data/file-metadata/`
  One JSON metadata record per uploaded file returned by `/v1/files`. Older
  `.data/files-index.json` snapshots are still read for compatibility.
- `.data/responses/`
  One compact JSON file per stored Response, containing the OpenAI payload plus
  Grok conversation state and replay history. Older monolithic
  `.data/responses.json` records are still read and migrated on first access.

When `DATABASE_URL` or `POSTGRES_URL` is set, uploaded files and stored
Responses are kept in PostgreSQL tables `bridge_files` and `bridge_responses`
instead, and only the Playwright browser profile remains on disk.
