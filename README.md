# grok-to-openai

OpenAI-compatible bridge for authenticated `grok.com` web sessions. The server
drives Grok through the same web endpoints the site uses via a persistent
Playwright browser profile. It does not use the official xAI API.

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`, `GET /v1/responses/:response_id`
- `POST /v1/chat/completions`
- `POST /v1/files`, `GET /v1/files/:file_id`, `GET /v1/files/:file_id/content`

## Features

- **Inputs**: Responses accepts a string, one message, or a message array.
  `system`/`developer` messages become Grok custom instructions.
  `input_file` supports `file_id`, `file_url`, and inline `file_data`.
  Images accept `input_image`/`image_url`, remote URLs, Base64 data URLs, and
  uploaded `file_id` references.
- **Multi-turn**: Responses uses `previous_response_id`. Follow-ups first try
  the account that owns the stored Grok thread; on failure the bridge replays
  the stored conversation history (including attachments) across the pool.
- **Images**: Grok image generation, edits, and searched image cards are
  exposed instead of dropped. Generated assets are rehosted as public PixelVault
  URLs. Responses returns `image_generation_call` items with `result_url`;
  Chat Completions keeps Markdown text plus a bridge-specific
  `message.image_urls` field.
- **Citations**: Completed text preserves Grok inline citations as shortened
  Markdown links by default. Optional `source_attribution` appends source
  lists and search queries (also streamed in the closing `response.completed`
  event).
- **Accounts**: `GROK_COOKIE_FILE` / `GROK_COOKIES_TEXT` may define one or many
  accounts (concatenated Netscape cookie blocks, or JSON arrays/objects).
  Config files hot-reload on change; the pool keeps the last known-good set on
  malformed updates. Per-account browser profiles are isolated under
  `BROWSER_PROFILE_DIR`.
- **Failover**: Requests start on the primary account and advance through
  fallbacks in deterministic order. Rate limits (`429`, "too many requests"),
  auth failures (`401`/`403`, "session expired", login redirects), and session
  blocks quarantine an account on a 15-minute cooldown. After two full
  fallback passes fail, the request errors. One backup account is kept warm
  in the background so a fallback request never pays a cold browser start.
- **Account targeting**: send `X-Grok-Account: <index>` on `/v1/responses` or
  `/v1/chat/completions` to route a request to one specific account (no
  fallback; unavailable accounts answer `503`). Useful for testing/ops; omit
  the header for normal pooled behavior.
- **Resilience**: Transient browser context/protocol errors recreate the
  session and retry; modal/ToS popups are auto-dismissed; storage-exhausted
  accounts are pruned; timed-out page fetches return `504`.
- **Model fallback**: If a premium model ("Model is not found", timeouts) or
  the full account pool is exhausted, the bridge retries once in
  `grok-4.6-fast`, and caches unsupported premium models per account to skip
  future upstream attempts.
- **Streaming**: Grok answer tokens stream to the OpenAI client in real time as
  they arrive. Grok's `final`-tagged deltas are forwarded while thinking-phase
  tokens (`header`/`thinking_start`/`response_start`) are suppressed, so planning
  preambles never leak into the stream. The canonical answer is included in the
  closing Responses state events, but is never replayed as a second text delta
  when it diverges from the live stream (for example, because citations or
  markup were normalized). Streaming text strips inline citation tags; Responses
  streaming emits completed image items only after final asset URLs are known.
- **Storage**: Uploaded files and Responses state persist under `.data/`
  (files, incremental metadata, per-Response JSON) or in PostgreSQL
  (`bridge_files`, `bridge_responses`) when `DATABASE_URL` is set. Legacy
  monolithic records are migrated on access.

## Models

`GET /v1/models` returns `grok-4.6-auto`, `grok-4.6-fast`, `grok-4.6-expert`,
`grok-4.6-heavy`, `grok-4.6-beta`. Aliases are broad:

- `grok`, `grok-latest`, `grok-4.6`, `gpt-4o`, `gpt-4.1`, `gpt-5` → auto
- `grok-4.6-beta`, `grok 4.6 (beta)`, `grok-420-computer-use-sa` → beta mode
- Any name containing `fast`, `expert`, `heavy`, or `auto` routes to that mode
- `reasoning.effort=high` (Responses) or `reasoning_effort=high`
  (Chat Completions) routes to expert mode; omitted `model` uses
  `DEFAULT_MODEL`.

## Compatibility notes

- `conversation` is not implemented; use `previous_response_id`.
- Tool/function calling is not implemented; Chat Completions ignores `tool`
  messages and supports `n=1` only.
- `tools`, `tool_choice`, `response_format`, `stop`, `max_tokens`,
  `max_completion_tokens`, and `stream_options.include_usage` are accepted
  but not translated into Grok behavior.
- `store: false` is reflected in the Response object, but Responses are still
  stored so `GET /v1/responses/:response_id` and continuation replay work.
- Responses `usage` is `null`; non-streaming Chat Completions returns
  placeholder zero usage. Streaming Chat Completions has no parallel citation
  chunk; text is streamed live and the canonical final answer is emitted in
  the closing chunks.
- `GET /v1/responses/:response_id` reconstructs image `result` lazily from
  the stored assistant attachment when available.
- Prefer uploading images to `/v1/files` and sending `file_id` references if
  you front the bridge with a reverse proxy: inline Base64 image JSON can be
  challenged before reaching the bridge.
- Automated login (`GROK_EMAIL`/`GROK_PASSWORD`) is not implemented.

## Setup

Requirements: Node.js `>=20`, Chrome/Chromium available to `playwright-core`
(it does not download a browser; set `CHROME_EXECUTABLE_PATH` or
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`), and an authenticated Grok web session.

```bash
npm install
```

The project loads `.env` automatically. Example:

```bash
HOST=127.0.0.1
PORT=62774
BRIDGE_API_KEY=sk-local-test
CHROME_EXECUTABLE_PATH=/path/to/chrome
GROK_COOKIE_FILE=.grok.cookies.txt
HEADLESS=true
IMPORT_COOKIES_ON_BOOT=true
BROWSER_PROFILE_DIR=.browser-profile
BROWSER_STREAM_BATCH_MAX_CHARS=16384
BROWSER_STREAM_BATCH_DELAY_MS=2
BROWSER_STATSIG_MAX_ATTEMPTS=600
BROWSER_STATSIG_RETRY_DELAY_MS=150
FALLBACK_MAX_TOTAL_MS=120000
RATE_LIMIT_COOLDOWN_MS=120000
BROWSER_REQUEST_TIMEOUT_MS=600000
BROWSER_TTFB_TIMEOUT_MS=45000
SHUTDOWN_TIMEOUT_MS=30000
FILE_UPLOAD_CONCURRENCY=4
DATA_DIR=.data
DATABASE_URL=postgresql://user:pass@db.example.com:5432/groktoopenai?sslmode=disable
DEFAULT_MODEL=grok-4.6-auto
GROK_DISABLE_SEARCH=false
PIXELVAULT_API_KEY=your-pixelvault-api-key
PIXELVAULT_EXPIRATION=
ALLOW_ORIGINS=*
```

Configuration notes:

- `BRIDGE_API_KEY`: leave empty to disable bearer auth.
- `GROK_COOKIE_FILE` / `GROK_COOKIES_TEXT`: Netscape or JSON cookie format;
  multiple accounts by concatenating blocks/arrays. Hot-reloaded on change.
- `GROK_BASE_URL`: defaults to `https://grok.com`.
- `BROWSER_STREAM_BATCH_MAX_CHARS` / `BROWSER_STREAM_BATCH_DELAY_MS`:
  browser-to-Node stream batching; defaults `16384` / `2`.
- `BROWSER_STATSIG_MAX_ATTEMPTS` / `BROWSER_STATSIG_RETRY_DELAY_MS`: how long the
  in-page statsig id generator keeps retrying while the Grok app is still
  mounting (its DOM input appears tens of seconds after a cold page load);
  defaults `600` attempts every `150` ms (~90 s). Accounts whose pages can
  never mount the app (login redirects, session expiry) bail out immediately
  and are quarantined.
- `FALLBACK_MAX_TOTAL_MS`: global deadline for one multi-account fallback
  sweep. Once it elapses on a session-unavailable failure the request errors
  immediately instead of walking every account; default `120000` (2 min).
- `BROWSER_REQUEST_TIMEOUT_MS`: max lifetime of one Grok browser request;
  defaults to `600000` (10 min), timed-out fetches return `504`.
- `BROWSER_TTFB_TIMEOUT_MS`: how long a request may wait for Grok response
  headers after the in-page fetch has been dispatched; defaults to `45000`
  (45 s). A wedged page (stale SPA, dead network path) that would otherwise
  hang until the full request timeout now fails fast, recreates the page,
  and retries once before falling back to other accounts.
- Browser memory tuning: each account's Chromium runs with a
  `--max-old-space-size=512` renderer heap cap (a guard against slow
  page-heap growth on multi-day uptimes — the Grok SPA stays far below it,
  so requests never hit GC pressure), and the in-page DOM-clone cache is
  bounded (1024 clones) instead of growing forever. Per-account browser
  footprint is otherwise kept low by the pool warming exactly one primary
  plus one backup browser; the bridge never holds one Chrome per account.
- `RATE_LIMIT_COOLDOWN_MS`: quarantine length for rate-limited (`429`)
  accounts; defaults to `120000` (2 min). Auth/session failures keep the
  full 15-minute cooldown. Keeps a pool of throttled accounts self-healing
  instead of sitting out for 15 minutes.
- `GROK_DISABLE_SEARCH`: set `true` to send `disableSearch` on every
  conversation request. Grok's web search phase is the main driver of
  multi-second response latency for factual/current-events prompts, so
  disabling it gets responses back inside the 10-20 s envelope but drops
  web citations. Defaults to `false` (search + citations kept).
- `SHUTDOWN_TIMEOUT_MS`: drain time for active requests on shutdown;
  defaults to `30000`.
- `FILE_UPLOAD_CONCURRENCY`: parallel attachment uploads per request;
  defaults to `4`, set `1` for sequential.
- `DATABASE_URL` / `POSTGRES_URL`: move files and Responses into PostgreSQL.
- `PIXELVAULT_API_KEY`: required to rehost generated images as public URLs.
  `PIXELVAULT_API_URL` defaults to `https://api.pixelvault.dev/v1/images`;
  `PIXELVAULT_EXPIRATION` sets an auto-delete TTL (60–2592000 seconds).
- `ALLOW_ORIGINS`: CORS origin (default `*`).

Parsed but unused: `GROK_EMAIL`, `GROK_PASSWORD`, `DEFAULT_MODE`.

If cookie import is rejected by Grok's anti-bot layer, warm the browser
profile once with a visible browser (`HEADLESS=false`, `npm start`), then
restart headless.

Requests never go out without a valid `x-statsig-id`: if Grok's statsig
middleware cannot produce one yet (fresh page whose app is still mounting),
the bridge retries in-page for up to `BROWSER_STATSIG_MAX_ATTEMPTS ×
BROWSER_STATSIG_RETRY_DELAY_MS` — long enough to cover a cold page load —
injecting a DOM stand-in for the logo element the middleware reads (class
name learned from the page's own `__next_f` payload and observed elements).
If the cached statsig chunk goes stale after a Grok redeploy it rediscovers
the chunk automatically and retries the request once; accounts that can
never generate an id (expired sessions, login redirects) are quarantined and
a failing sweep aborts after `FALLBACK_MAX_TOTAL_MS` instead of crawling
every account.

Start the server and run tests:

```bash
npm start
npm test
```

## Examples

```bash
# Basic Responses request
curl http://127.0.0.1:62774/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.6-auto",
    "input": "Reply with the single word PONG."
  }'

# Streaming Responses request
curl -N http://127.0.0.1:62774/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.6-fast",
    "input": "Write one short paragraph.",
    "stream": true
  }'

# Chat Completions with an image
curl http://127.0.0.1:62774/v1/chat/completions \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.6-auto",
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

# Upload a file, then reference it by file_id
curl http://127.0.0.1:62774/v1/files \
  -H "Authorization: Bearer sk-local-test" \
  -F purpose=user_data \
  -F file=@README.md

curl http://127.0.0.1:62774/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.6-auto",
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

# Continue a prior Responses thread
FIRST=$(curl -s http://127.0.0.1:62774/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{"model":"grok-4.6-auto","input":"Tell me a joke."}')

RESP_ID=$(printf '%s' "$FIRST" | node -e 'process.stdin.once("data", d => console.log(JSON.parse(d).id))')

curl http://127.0.0.1:62774/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"grok-4.6-auto\",
    \"previous_response_id\": \"$RESP_ID\",
    \"input\": [{\"role\":\"user\",\"content\":\"Tell me another.\"}]
  }"

# Request sources and query provenance
curl http://127.0.0.1:62774/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.6-auto",
    "input": "Summarize the latest AI news in one paragraph.",
    "source_attribution": {
      "include_sources": true,
      "include_search_queries": true
    }
  }'
```

## Local state

By default the bridge writes:

- `.browser-profile/`: persistent Playwright profile for Grok web auth.
- `.data/files/` and `.data/file-metadata/`: uploaded file contents and one
  JSON metadata record per file.
- `.data/responses/`: one compact JSON file per Response (OpenAI payload plus
  Grok conversation state and replay history).

With `DATABASE_URL` set, files and Responses live in PostgreSQL tables
`bridge_files` and `bridge_responses`; only the browser profile stays on disk.
