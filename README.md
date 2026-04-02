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

## Limits of this first version

- Historical user file attachments inside manually seeded multi-message `input` are not supported unless you continue from `previous_response_id`.
- Text streaming is emitted as OpenAI-style SSE events, but usage accounting is `null`.
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

## Reference notes

The bridge shape follows OpenAI Responses API guidance:

- `input_file` accepts `file_id`, `file_url`, or Base64 `file_data`.
- Multi-turn continuation is exposed via `previous_response_id`.
- `stream: true` uses SSE-style typed events such as `response.created`, `response.output_text.delta`, and `response.completed`.

Source docs:

- https://developers.openai.com/api/docs/guides/file-inputs/
- https://developers.openai.com/api/docs/guides/conversation-state/
- https://developers.openai.com/api/docs/guides/streaming-responses/
