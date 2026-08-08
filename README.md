# Freebuff LLM Router

A local OpenAI-compatible `/v1` gateway that routes LLM requests through
Freebuff (the free tier of Codebuff). Point any agent — Claude Code,
OpenAI SDK, ai-sdk, Cursor, etc. — at `http://localhost:8787/v1` and it
handles the full Freebuff protocol transparently.

## How it works

```
Agent (OpenAI /v1/chat/completions)
  │  user-agent: ai-sdk/openai-compatible/.../codebuff
  ▼
localhost:8787/v1/chat/completions
  │
  ├─ Pool.acquire(model)  → pick an idle Freebuff token (session affinity)
  ├─ POST /api/v1/freebuff/session    (admit if no active session)
  ├─ POST /api/v1/agent-runs (START)  → runId
  ├─ POST /api/v1/chat/completions    (stream back SSE)
  └─ release → finish run + release session
```

Each Freebuff account has a **single global active session** per model. Multiple
tokens = multiple independent session slots = parallelism. The router maintains
an idle-slot pool so concurrent requests each get their own token.

## Features

- **OpenAI-compatible surface** — `/v1/chat/completions` and `/v1/responses`
  (translated from Responses API to chat format)
- **Multi-token concurrency** — comma-separated `ROUTER_TOKEN` env var; each
  token is an independent session slot
- **Session affinity** — reuses a token that already has an active session for
  the requested model (preserves Freebuff's context cache, avoids churn)
- **Run rotation** — rotates agent runs every 5.5h to stay under Freebuff's
  ~6-hour session expiry
- **Live model enrichment** — `/v1/models` augments the static catalog with
  real-time `rateLimitsByModel` and `limitedModelOffers` from Freebuff
- **CLI identity spoofing** — user-agent and `codebuff_metadata.cost_mode: 'free'`
  bypass the `free_mode_cli_required` gate
- **Auth gating** — optional `routerKey` protects the `/v1/*` surface

## Install

```bash
bun install
```

## Configuration

### Quick start

1. Export your Freebuff token:

```bash
export ROUTER_TOKEN=your_token_here
```

2. Start the router:

```bash
bun dev
```

3. Point your agent at `http://localhost:8787/v1`.

### Multi-token (concurrency)

```bash
export ROUTER_TOKEN=token_a,token_b,token_c
bun dev
```

### Config file

Copy the example and edit:

```bash
cp router.config.example.json router.config.json
```

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "routerKey": null,
  "freebuff": {
    "loginHost": "https://freebuff.com",
    "apiHost": "https://www.codebuff.com"
  }
}
```

### Router auth key

If `routerKey` is set, all `/v1/*` routes require
`Authorization: Bearer <routerKey>`. If unset, the router is open locally.

## Testing

```bash
# Unit + integration tests
bun test

# Router tests only
bun test router/

# End-to-end smoke test (starts a mock Freebuff backend)
bun smoke
```

## API surface

### `GET /health`

Health check. Returns `{ "status": "ok", "tokens": <N> }`.

### `GET /v1/models`

Returns the model catalog enriched with live Freebuff rate limits and
limited-time offers (e.g. Fable 5).

### `POST /v1/chat/completions`

Standard OpenAI-compatible request body (supports `stream: true` for SSE).

### `POST /v1/responses`

OpenAI Responses API — translated to chat format internally.

### `POST /v1/messages`

**Anthropic-compatible endpoint** — translates `/v1/messages` requests to
OpenAI chat format and converts streaming responses back to Anthropic SSE.
Supports text, image, tool_use, tool_result, and thinking content blocks.
## Project layout

├── anthropic.ts       # Anthropic /v1/messages format bridge
├── types.ts           # Shared TypeScript types
├── config.ts          # Config loading, model catalog, token resolution
├── translate.ts       # Responses API → Chat Completions translator
├── smoke-test.ts      # End-to-end smoke test with mock backend

PROTOCOL.md            # Reverse-engineered Freebuff protocol reference
source/                # Reference sources (gitignored, not shipped)
client.mjs             # Standalone protocol client for debugging
```

## License

Educational project. Freebuff is a trademark of Codebuff AI.
