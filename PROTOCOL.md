# Freebuff CLI — Reverse-Engineered Protocol Map

Source obtained from:
- `source/shim/` — the `freebuff@0.0.106` npm launcher package (copied from the local bun global install). It only downloads the platform binary from `https://codebuff.com/api/releases/download/<version>/freebuff-<platform>.tar.gz` and spawns it; no agent logic.
- `source/github/` — the public `CodebuffAI/freebuff` repo (Apache-2.0). Freebuff is the Codebuff CLI compiled with `FREEBUFF_MODE=true` (`freebuff/SPEC.md`), which strips paid features, credits UI, and mode switching.

Key source files:
- `cli/src/utils/freebuff-session-api.ts` — session/admission protocol
- `cli/src/utils/codebuff-api.ts` — API client (login, me, usage, feedback)
- `common/src/constants/freebuff-models.ts` — model catalog, quotas, wire headers
- `common/src/constants/freebuff-model-ids.ts` — model id literals
- `packages/agent-runtime/src/llm-api/codebuff-web-api.ts` — web-search / docs-search / gravity-index / token-count

## Endpoints

| Route | Method | Purpose |
|---|---|---|
| `https://codebuff.com/api/v1/chat/completions` | POST, SSE stream | Main agent chat (OpenAI-compatible body) |
| `https://codebuff.com/api/v1/freebuff/session` | POST/GET/DELETE | Session admission + per-model rate-limit gate |
| `https://codebuff.com/api/v1/freebuff/streak` | GET | Daily streak rewards |
| `https://codebuff.com/api/v1/freebuff/title` | POST | Chat title |
| `https://codebuff.com/api/v1/web-search` | POST | Web search (agent tool) |
| `https://codebuff.com/api/v1/docs-search` | POST | Docs search (agent tool) |
| `https://codebuff.com/api/v1/gravity-index` | POST | Gravity index (agent tool) |
| `https://codebuff.com/api/v1/token-count` | POST | Token counting |
| `https://codebuff.com/api/v1/me` | GET | User details |
| `https://codebuff.com/api/v1/usage` | POST | Server-side usage/billing |
| `https://codebuff.com/api/v1/feedback` | POST | Feedback |

`NEXT_PUBLIC_CODEBUFF_APP_URL` overrides the `codebuff.com` base (default), `NEXT_PUBLIC_FREEBUFF_APP_URL` overrides the login origin (prod default `https://freebuff.com`).

## Session protocol (`/api/v1/freebuff/session`) — the rate-limit gate

The server enforces per-user quota via this endpoint. POST admits a session for a model; the CLI polls GET while active; DELETE releases the slot.

Headers:
- `Authorization: Bearer <token>` (token from `~/.config/manicode/credentials.json`)
- `x-freebuff-model: <model-id>` (POST)
- `x-freebuff-instance-id: <uuid>` (GET)
- `x-freebuff-compact-session: 1` (GET; omit quota fields the CLI already has)
- `x-freebuff-heartbeat: 1` (GET; liveness beat, sent every 45s)
- `x-freebuff-takeover-instance-id: <id>` (POST; end another tab's session)
- `x-freebuff-multi-session: 1` (Desktop only)

Responses:
- 404 → `{status: 'none'}`
- 403 → `country_blocked` / `banned`
- 409 → `model_locked` / `model_unavailable`
- 429 → `rate_limited` / `spend_limited` / `ip_capped` (POST only)
- 200 → `{status: 'active'|'ended', instanceId, model, rateLimit, rateLimitsByModel, ...}`

## Model catalog & quotas (CLI, full access tier)

| Model id | Display | Quota on CLI |
|---|---|---|
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | **Unlimited** (default pick) |
| `mimo/mimo-v2.5` | MiMo 2.5 | **Unlimited**, multimodal |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | Premium pool: 6 sessions/day |
| `minimax/minimax-m3` | MiniMax M3 | Premium pool: 6 sessions/day |
| `openai/gpt-5.6-luna` | GPT-5.6 Luna | Premium pool: 6 sessions/day |
| `z-ai/glm-5.2` | GLM 5.2 | Referral-gated (1h per referral per day) |
| `anthropic/claude-fable-5` | Claude Fable 5 | Global limited pool, 1 session/day (offer-driven) |

- Premium/limited pools reset at midnight Pacific (`FREEBUFF_PREMIUM_SESSION_LIMIT = 6`, `FREEBUFF_LIMITED_SESSION_LIMIT = 6`).
- Source comment: *"The CLI keeps these models [Flash, MiMo] unlimited; browser surfaces cap fresh sessions."*
- Limited access tier (restricted regions) only gets Flash + MiMo.
- Streak rewards: 7-day streak adds +1 session/day to the pool.

## Auth flow

Device-code login via the web app (`freebuff.com` for freebuff builds, `codebuff.com` otherwise); the CLI polls the auth status endpoint until the user approves in the browser; the resulting API token is stored in `~/.config/manicode/credentials.json`.

## Chat request (agent run flow)

The CLI does NOT call chat directly — it runs the agent loop via the SDK, which:

1. **Start run** — `POST /api/v1/agent-runs` with `{action:'START', agentId}` → `{runId}`.
   - `agentId` must be the free-mode root paired to the model: `base2-free-deepseek-flash` for `deepseek/deepseek-v4-flash`, `base2-free-mimo` for `mimo/mimo-v2.5` (see `FREEBUFF_ROOT_AGENT_ID_BY_MODEL` in `common/src/constants/free-agents.ts`). Wrong pairing → `403 free_mode_invalid_agent_model`.
2. **Stream chat** — `POST /api/v1/chat/completions` with an OpenAI-compatible body plus:
   - `runId` and `codebuff_metadata: {run_id, client_id, cost_mode, freebuff_instance_id}` — `cost_mode: 'free'` is mandatory; without it the server bills the request as paid (`402 out of credits`). `freebuff_instance_id` is the session UUID from step 1; the server reads it server-side to enforce per-instance quotas.

Headers: `Authorization: Bearer <token>`, `user-agent: ai-sdk/openai-compatible/…/codebuff`. The SDK builds the URL as `{NEXT_PUBLIC_CODEBUFF_APP_URL}/api/v1/chat/completions` (301 → `www.codebuff.com`; the chat handler rejects POST→GET redirect downgrades, so hit the canonical host).

### The CLI-only gate

Free-mode chat is gated server-side to the official freebuff CLI. Even a request with the correct user-agent (`ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.20 runtime/browser`), all headers (`x-freebuff-instance-id`, `codebuff_metadata` with `cost_mode: 'free'`), and a valid session will get `403 free_mode_cli_required` — *"Free mode is only available through the freebuff CLI. Install it with `npm i -g freebuff`, then run `freebuff`. Calling the API directly is not supported and may get your account banned."*

The gate checks something beyond header spoofing — likely token metadata (CLI-issued vs credentials file) or an unspoofable signature. The free session endpoint (GET/DELETE, quota introspection) is not gated; only free-mode inference is. The supported unlimited-free-model surface is the CLI itself.
