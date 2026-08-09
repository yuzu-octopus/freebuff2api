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
- **Anthropic-compatible surface** — `/v1/messages` endpoint with full SSE
  streaming translation (Claude Code compatible)
- **Multi-token concurrency** — comma-separated `FREEBUFF_TOKEN` env var; each
  token is an independent session slot
- **Session queuing** — polls waiting-room queue every 5s (up to 30s timeout)
- **Tool schema normalization** — resolves `$ref` and nullable type combinators
  for broad client compatibility
- **Session affinity** — reuses a token that already has an active session for
  the requested model (preserves Freebuff's context cache, avoids churn)
- **Session resilience** — fresh run per request; expired or superseded
  sessions (Freebuff's ~6-hour expiry) are detected on the next request and
  re-admitted automatically
- **Live model enrichment** — `/v1/models` augments the static catalog with
  real-time `rateLimitsByModel` and `limitedModelOffers` from Freebuff
- **CLI identity spoofing** — user-agent and `codebuff_metadata.cost_mode: 'free'`
  bypass the `free_mode_cli_required` gate
- **Auth gating** — optional `routerKey` protects the `/v1/*` surface
## Install

```bash
# From npm (requires Bun)
bunx freebuff2api        # or: npx freebuff2api

# Or from source
bun install
bun start
```

## Configuration
### Quick start

1. Export your Freebuff token:

```bash
export FREEBUFF_TOKEN=your_token_here
```

2. Start the router:

```bash
bunx freebuff2api
```

3. Point your agent at `http://localhost:8787/v1`.

### Multi-token (concurrency)

```bash
export FREEBUFF_TOKEN=token_a,token_b,token_c
bunx freebuff2api
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

`routerKey` comes from the config file or the `ROUTER_KEY` env var — it is
independent of `FREEBUFF_TOKEN`. If set, every route except `/health`
(including the non-`/v1` alias routes) requires `Authorization: Bearer
<routerKey>`. If unset (null/absent), the router is open locally.

### Rate limits

Free-tier model quotas (e.g. the `6/day` premium models) are enforced
server-side. The router does not pre-block requests: it surfaces live
remaining quotas via `/v1/models` (`userRemaining`) and auto-fails over to
the next token when a token's tool-quota bucket is exhausted (a `429` naming
`high-balance`), rather than failing fast. Other `429`s are relayed as-is.
Add more tokens to `FREEBUFF_TOKEN` to raise concurrency and spread quota
across accounts.

## Testing

```bash
# Unit + integration tests
bun test

# Router tests only
bun test router/

# End-to-end smoke test (starts a mock Freebuff backend)
bun router/smoke-test.ts
```

## API surface

### `GET /health`

Health check. Returns `{ "status": "ok", "tokens": <N> }`. With
`?verbose=1` also returns `tokensDetail` (per-token masked snapshot: `token`,
`busy`, `sessionModel`, `toolQuotaExhausted`) and the daily `streak`.
No auth required (safe for orchestrator probes).

### `GET /v1/streak`

Passthrough of the Freebuff `GET /api/v1/freebuff/streak` (daily streak /
quota status from the first pool token).

### `POST /v1/token-count`

Passthrough of the Freebuff `POST /api/v1/token-count` (server-side token
meter); body `{ messages, system?, model?, tools? }` is forwarded verbatim
and the upstream response is returned unchanged.

### `GET /v1/models`

Returns the model catalog enriched with live Freebuff rate limits and
limited-time offers (e.g. Fable 5).

### `POST /v1/chat/completions`

Standard OpenAI-compatible request body (supports `stream: true` for SSE).

### `POST /v1/responses`

OpenAI Responses API — `input`/`instructions` bodies are translated to chat
format internally. **Limitation:** the response is relayed in chat-completions
shape (`choices[].message`), not native Responses `output` format; use
`/v1/chat/completions` or `/v1/messages` for harnesses that need strict
schema compliance.

### `POST /v1/messages`

**Anthropic-compatible endpoint** — translates `/v1/messages` requests to
OpenAI chat format and converts streaming responses back to Anthropic SSE.
Supports text, image, tool_use, tool_result, and thinking content blocks.
## Project layout

```
freebuff2api/
├── bin/freebuff2api.js    # npm bin — starts the router (bun-runtime)
├── router/                # the whole router lives here
│   ├── server.ts          # HTTP server, /v1 routing, auth
│   ├── freebuff.ts        # Freebuff protocol client, session pool, gate injection
│   ├── prompt.ts          # "You are Buffy" marker + System Override injection
│   ├── anthropic.ts       # Anthropic /v1/messages format bridge
│   ├── config.ts          # Config loading, model catalog, token resolution
│   ├── tools.ts           # Tool schema normalization ($ref / nullable)
│   ├── translate.ts       # Responses API → Chat Completions translator
│   ├── types.ts           # Shared TypeScript types
│   └── *.test.ts          # unit + integration tests (mock backend)
├── PROTOCOL.md            # Reverse-engineered Freebuff protocol reference
├── source/                # Reference sources (gitignored, not shipped)
├── client.mjs             # Standalone protocol client for debugging
├── docs/                  # Project site (CI-generated from project.toml)
└── project.toml           # Source for the ProjectSite page
```

## License

MIT + third-party-services disclaimer — see [LICENSE.md](LICENSE.md). Freebuff
is a trademark of its respective owner; this project is independent and not
affiliated with or endorsed by it. Use of the Freebuff API through this router
may violate its Terms of Service; users assume that responsibility themselves
(see the disclaimer).
