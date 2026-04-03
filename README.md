# grok-to-openai

OpenAI-compatible bridge for authenticated `grok.com` web sessions. It drives
Grok through the same web endpoints the site uses via a persistent Playwright
browser session. It does not use the official xAI API.

## Current surface area

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`
- `GET /v1/responses/:response_id`
- `POST /v1/chat/completions`
- `POST /v1/files`
- `GET /v1/files/:file_id`
- `GET /v1/files/:file_id/content`

## Implemented behavior

- Responses API input as a string, a single message object, or a message array
- System and developer messages folded into Grok custom instructions
- Responses API file parts via `input_file` using:
  - `file_id`
  - `file_url`
  - `file_data`
- Image inputs via:
  - Responses API `input_image`
  - Chat Completions `messages[].content[].type = "image_url"`
- Remote URLs and Base64 data URLs for image inputs
- Multi-turn Responses API continuation via `previous_response_id`
- Streaming for both `/v1/responses` and `/v1/chat/completions`
- Inline Grok citations preserved as shortened Markdown links by default
- Optional source attribution output with:
  - full source lists
  - per-source search query provenance
  - raw query lists in the JSON response
- Local persistence of uploaded files and Responses API state under `.data/`

## Model IDs

`GET /v1/models` returns:

- `grok-4-auto`
- `grok-4-fast`
- `grok-4-expert`

The bridge also accepts these aliases and maps them to Grok auto mode:

- `grok-4`
- `grok-latest`
- `gpt-4o`
- `gpt-4.1`
- `gpt-5`

If you omit `model`, the bridge uses `DEFAULT_MODEL`, which defaults to
`grok-4-auto`.

## Compatibility notes

- `conversation` on `/v1/responses` is not implemented. Use
  `previous_response_id`.
- Tool or function calling is not implemented.
- Several OpenAI request fields are accepted for client compatibility but are
  not translated into equivalent Grok behavior. This includes fields such as
  `tools`, `tool_choice`, `response_format`, `stop`, `max_tokens`,
  `max_completion_tokens`, and `stream_options.include_usage`.
- When you manually seed multi-message history without `previous_response_id`,
  the bridge flattens prior turns into a transcript prompt and requires the
  final message to be a user message.
- In manually seeded history, attachments and images are only uploaded for the
  final user turn. Earlier turns keep only an `[Attachments: N]` marker in the
  synthesized transcript.
- Chat Completions `tool` messages are ignored.
- Responses are still stored locally even if you send `"store": false`; the
  flag is only reflected in the returned response object.
- Usage accounting is `null` for Responses API payloads. Non-streaming Chat
  Completions returns placeholder zero usage.
- The current implementation does not perform automated login with
  `GROK_EMAIL` or `GROK_PASSWORD`. You need valid Grok session cookies or a
  warmed browser profile.

## Requirements

- Node.js `>=20`
- A Chrome or Chromium executable available to `playwright-core`
- An authenticated Grok web session

`playwright-core` does not download a browser for you, so set
`CHROME_EXECUTABLE_PATH` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an
installed browser binary.

## Setup

Install dependencies:

```bash
npm install
```

The project loads `.env` automatically. Typical local files in the repo root:

- `.env`
- `.grok.cookies.txt`
- `.browser-profile/`
- `.data/`

Example `.env`:

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
DEFAULT_MODEL=grok-4-auto
ALLOW_ORIGINS=*
```

Other supported environment variables:

- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
  - Fallback browser path if `CHROME_EXECUTABLE_PATH` is unset.
- `GROK_COOKIES_TEXT`
  - Inline Netscape-format cookie text instead of a cookie file.
- `GROK_BASE_URL`
  - Defaults to `https://grok.com`.

Notes:

- Leave `BRIDGE_API_KEY` empty to disable bearer auth.
- Relative paths are resolved from the repo root.
- `POST /v1/files` has a `50 MiB` upload limit.
- JSON request bodies are limited to `60 MiB`.
- The config currently defines `GROK_EMAIL`, `GROK_PASSWORD`, and
  `DEFAULT_MODE`, but the current codebase does not use them.

If a fresh cookie import still gets rejected by Grok's anti-bot layer, warm the
persistent browser profile once with a visible browser:

```bash
export HEADLESS=false
npm start
```

Log in manually in the launched browser window. The bridge stores the profile in
`.browser-profile/` by default. Once that profile is warmed and trusted, you can
switch back to `HEADLESS=true`.

Start the server:

```bash
npm start
```

Run tests:

```bash
npm test
```

## Local state

By default the bridge writes:

- `.browser-profile/`
  - Persistent Playwright browser profile used for Grok web auth.
- `.data/files/`
  - Uploaded file contents.
- `.data/files-index.json`
  - File metadata returned by `/v1/files`.
- `.data/responses.json`
  - Stored Responses API payloads plus Grok conversation state used by
    `previous_response_id`.

## Responses example

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4-auto",
    "input": "Reply with the single word PONG."
  }'
```

## Streaming Responses example

```bash
curl -N http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4-auto",
    "input": "Write one short paragraph.",
    "stream": true
  }'
```

## Chat Completions example

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4-auto",
    "messages": [
      { "role": "developer", "content": "You are concise." },
      { "role": "user", "content": "Reply with the single word PONG." }
    ]
  }'
```

## Chat Completions image example

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

## File upload example

```bash
curl http://127.0.0.1:8787/v1/files \
  -H "Authorization: Bearer sk-local-test" \
  -F purpose=user_data \
  -F file=@fixtures/sample-note.txt
```

Then use the returned `file_id` in a Responses API request:

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

## Multi-turn Responses example

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

## Citations and source attribution

The bridge keeps Grok's inline citations by default. Instead of removing
`<grok:render ... type="render_inline_citation">` tags, it resolves each
`card_id` against Grok's citation attachment payload and renders a shortened,
clickable Markdown link inline.

Example output:

```md
... enterprise integration and AI spending. ([techcrunch.com/category/artificial-intelligence](https://techcrunch.com/category/artificial-intelligence/))
```

### Request options

Both `POST /v1/responses` and `POST /v1/chat/completions` accept the custom
top-level field `source_attribution`:

```json
{
  "source_attribution": {
    "inline_citations": true,
    "include_sources": true,
    "include_search_queries": true
  }
}
```

Field behavior:

- `inline_citations`
  - Default: `true`
  - Preserves inline Grok citations as shortened Markdown links.
  - Set to `false` to strip inline citations and fall back to plain text output.
- `include_sources`
  - Default: `false`
  - Appends a `Sources` section to the assistant text.
  - Exposes `response.source_attribution.sources` in the JSON response.
- `include_search_queries`
  - Default: `false`
  - Appends a `Search Queries` section to the assistant text.
  - Adds `search_queries` to each source entry plus a top-level
    `response.source_attribution.search_queries` list.
  - This also enables the full source list, because the queries are shown as
    provenance for those sources.

### Responses API example

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

### Chat Completions example

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4-auto",
    "messages": [
      { "role": "user", "content": "Summarize the latest AI news in one paragraph." }
    ],
    "source_attribution": {
      "include_sources": true,
      "include_search_queries": true
    }
  }'
```

### What gets displayed

When `include_sources` is enabled, the rendered assistant text appends:

```md
Sources
1. [Example Report](https://example.com/report) (example.com/report) [cited] via `alpha search`; `beta search`
2. [Another Source](https://example.org/post) (example.org/post)
```

When `include_search_queries` is enabled, the text also appends:

```md
Search Queries
1. `alpha search`
2. `beta search`
```

### JSON response structure

The bridge also includes a top-level `source_attribution` object in completed
Responses API payloads and non-streaming Chat Completions payloads:

```json
{
  "source_attribution": {
    "inline_citations": "short_url_markdown",
    "citation_count": 2,
    "cited_source_count": 2,
    "source_count": 12,
    "search_query_count": 3,
    "citations": [
      {
        "card_id": "abc123",
        "url": "https://example.com/report",
        "short_url": "example.com/report"
      }
    ],
    "sources": [
      {
        "url": "https://example.com/report",
        "short_url": "example.com/report",
        "title": "Example Report",
        "preview": "Short preview text",
        "cited": true,
        "citation_card_ids": ["abc123"],
        "search_queries": ["alpha search"]
      }
    ],
    "search_queries": ["alpha search", "beta search"]
  }
}
```

Interpretation:

- `citations`
  - The inline citation links resolved from Grok `card_id` markers.
- `sources`
  - The deduplicated full source pool returned by Grok web search results.
- `sources[].cited`
  - `true` when that source was used by an inline citation in the final answer.
- `sources[].search_queries`
  - The Grok web search queries whose result sets contained that source URL.
- `search_queries`
  - The distinct raw web search queries Grok executed while producing the
    answer.

### Implementation notes

This feature is based on Grok's actual web payload shape:

- The answer text carries inline citation markers such as
  `<grok:render ... card_id="..." type="render_inline_citation">`.
- The corresponding source URLs arrive separately in
  `modelResponse.cardAttachmentsJson`.
- The full fetched source pool arrives in `modelResponse.webSearchResults`.
- Query provenance comes from `modelResponse.steps[].toolUsageCards[*].webSearch.args.query`,
  with per-query result lists in `modelResponse.steps[].toolUsageResults`.

## Reference notes

The bridge shape follows OpenAI Responses API guidance for the parts it
implements:

- `input_file` accepts `file_id`, `file_url`, or Base64 `file_data`.
- Multi-turn continuation is exposed via `previous_response_id`.
- `stream: true` on `/v1/responses` uses typed SSE events such as
  `response.created`, `response.output_text.delta`, and `response.completed`.

Reference docs:

- https://developers.openai.com/api/docs/guides/file-inputs/
- https://developers.openai.com/api/docs/guides/conversation-state/
- https://developers.openai.com/api/docs/guides/streaming-responses/
