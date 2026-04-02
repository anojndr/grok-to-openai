# grok-to-openai

OpenAI-compatible bridge for `grok.com` web sessions. It drives Grok through the same authenticated web endpoints the site uses, not the official Grok API.

## What it supports

- `POST /v1/responses`
- `POST /v1/chat/completions`
- `GET /v1/responses/:response_id`
- `POST /v1/files`
- `GET /v1/files/:file_id`
- `GET /v1/files/:file_id/content`
- `GET /v1/models`
- Multi-turn conversations via `previous_response_id`
- File inputs via OpenAI-style `input_file` parts using:
  - `file_id`
  - `file_url`
  - `file_data`
- Image inputs via:
  - Responses API `input_image`
  - Chat Completions `messages[].content[].type = "image_url"`
- Inline Grok citations preserved as shortened Markdown links instead of being stripped
- Optional source attribution output with:
  - full source lists
  - per-source search query provenance
  - raw query lists in the JSON response

## Limits of this first version

- Historical user file attachments inside manually seeded multi-message `input` are not supported unless you continue from `previous_response_id`.
- Text streaming is emitted as OpenAI-style SSE events, but usage accounting is `null`.
- When Grok emits inline citations, streaming may hold back text after the first citation marker so the final emitted suffix preserves correct clickable links.
- Historical user attachments in manually seeded Chat Completions history are only supported on the final user turn.

## Setup

```bash
npm install
```

The project now loads `.env` automatically. A ready-to-use local `.env` and
`.grok.cookies.txt` can live in the repo root, and both are ignored by git.

If a fresh cookie import still gets rejected by Grok's anti-bot layer, run the
bridge once with a visible browser, log in manually in that browser profile, and
reuse the saved profile afterward:

```bash
export HEADLESS=false
```

The bridge keeps its persistent browser state in `.browser-profile/` by default.
Once that profile is warmed and trusted, you can switch back to `HEADLESS=true`.

Key settings live in `.env`:

```bash
BRIDGE_API_KEY=sk-local-test
CHROME_EXECUTABLE_PATH=/home/sweetpotet/chrome-linux/chrome
GROK_COOKIE_FILE=.grok.cookies.txt
GROK_EMAIL=your-email@example.com
GROK_PASSWORD=your-password
HEADLESS=false
```

Then start the server:

```bash
npm start
```

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

Then use the returned `file_id`:

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

## Multi-turn example

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

## Streaming example

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

## Citations and source attribution

The bridge now keeps Grok's inline citations by default. Instead of removing
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
  - The inline citation links that were resolved from Grok `card_id` markers.
- `sources`
  - The deduplicated full source pool returned by Grok web search results.
- `sources[].cited`
  - `true` when that source was used by an inline citation in the final answer.
- `sources[].search_queries`
  - The Grok web search queries whose result sets contained that source URL.
- `search_queries`
  - The distinct raw web search queries Grok executed while producing the answer.

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

The bridge shape follows OpenAI Responses API guidance:

- `input_file` accepts `file_id`, `file_url`, or Base64 `file_data`.
- Multi-turn continuation is exposed via `previous_response_id`.
- `stream: true` uses SSE-style typed events such as `response.created`, `response.output_text.delta`, and `response.completed`.

Source docs:

- https://developers.openai.com/api/docs/guides/file-inputs/
- https://developers.openai.com/api/docs/guides/conversation-state/
- https://developers.openai.com/api/docs/guides/streaming-responses/
