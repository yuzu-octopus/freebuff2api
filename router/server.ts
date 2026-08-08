/**
 * Freebuff LLM Router.
 *
 * A local OpenAI-compatible gateway. Point any agent's model base URL at
 * http://localhost:8787/v1 and the router transparently handles:
 *   - Session admission against Freebuff (GET/DELETE session, POST admit)
 *   - Agent run lifecycle (START → chat → FINISH, with 6h rotation)
 *   - CLI identity spoofing (user-agent + codebuff_metadata.cost_mode: 'free')
 *   - Multi-token concurrency pool (each token = independent session slot)
 *
 * Supports two input formats:
 *   - /v1/chat/completions — standard OpenAI chat body
 *   - /v1/responses — OpenAI Responses API (translated to chat format)
 */

import { serve } from 'bun'
import { loadConfig, MODEL_CATALOG, type RouterConfig } from './config'
import { type FreebuffTokenClient, FreebuffTokenPool, createDefaultTokenProvider } from './freebuff'
import { isResponsesRequest, translateResponsesToChat } from './translate'
import type { ChatMessage } from './types'

// Convert a chat message from the incoming OpenAI body to our internal type.
function normalizeMessage(msg: Record<string, unknown>): ChatMessage {
  return {
    role: msg.role as ChatMessage['role'],
    content: msg.content as ChatMessage['content'],
    ...(msg.name ? { name: msg.name as string } : {}),
    ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id as string } : {}),
    ...(msg.tool_calls ? { tool_calls: msg.tool_calls as ChatMessage['tool_calls'] } : {}),
  }
}

// Build the /v1/models response, enriched with live Freebuff model availability
// (rate limits per model + limited-time offers like Fable 5). Falls back to
// the static MODEL_CATALOG if the server is unreachable.
async function modelsResponse(pool: FreebuffTokenPool): Promise<Response> {
  const live = await pool.fetchLiveModelInfo().catch(() => null)

  const rateLimits = live?.rateLimitsByModel ?? {}
  const limitedOffers = live?.limitedModelOffers ?? []
  const baseTime = Math.floor(Date.now() / 1000)

  const data = MODEL_CATALOG.map((m) => {
    const rl = rateLimits[m.id]
    const offer = limitedOffers.find((o) => o.model === m.id)
    const entry: Record<string, unknown> = {
      id: m.id,
      object: 'model',
      created: baseTime,
      owned_by: 'freebuff',
      display: m.display,
      quota: m.quota,
      type: m.type,
    }
    if (rl) {
      entry.userRemaining = rl.limit - rl.recentCount
      entry.userResetAt = rl.resetAt
    }
    if (offer) {
      entry.remaining = offer.remaining
      entry.total = offer.total
      entry.userRemaining = offer.userRemaining
      entry.userResetAt = offer.userResetAt
    }
    return entry
  })

  return new Response(
    JSON.stringify({ object: 'list', data }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

// Auth gate — return null if OK (no auth needed or auth passes).
function checkAuth(req: Request, config: RouterConfig): Response | null {
  if (!config.routerKey) return null
  const auth = req.headers.get('authorization')
  if (auth === `Bearer ${config.routerKey}`) return null
  return new Response(
    JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }),
    { status: 401, headers: { 'www-authenticate': 'Bearer', 'Content-Type': 'application/json' } },
  )
}

// Format a Freebuff error status into an OpenAI-compatible error response.
function formatFreebuffError(
  status: string,
  msg: string,
  modelId: string,
): { openAIError: Record<string, unknown>; httpStatus: number } {
  let openAIError: Record<string, unknown>
  switch (status) {
    case 'rate_limited':
      openAIError = { type: 'rate_limit_error', message: 'Rate limit exceeded' }
      break
    case 'spend_limited':
      openAIError = { type: 'insufficient_quota', message: 'Spend limit has been reached' }
      break
    case 'ip_capped':
      openAIError = { type: 'ip_blocked', message: 'IP address is rate-limited' }
      break
    case 'country_blocked':
      openAIError = { type: 'permission_error', message: 'Country/IP is blocked by Freebuff' }
      break
    case 'banned':
      openAIError = { type: 'permission_error', message: 'Account is banned' }
      break
    case 'model_locked':
    case 'model_unavailable':
      openAIError = { type: 'not_found', message: `Model \`${modelId}\` is unavailable`, param: 'model' }
      break
    case 'free_mode_cli_required':
      openAIError = { type: 'insufficient_quota', message: 'Free mode requires the official CLI', code: 'free_mode_cli_required' }
      break
    default:
      openAIError = { type: 'api_error', message: msg }
  }

  const httpStatus = status === 'rate_limited' ? 429
    : status === 'model_locked' || status === 'model_unavailable' ? 404
    : 503
  return { openAIError, httpStatus }
}

interface LeaseResult {
  runId: string
  instanceId: string
  response: Response
  admitted: boolean
}

// Acquire a token from the pool, run the full Freebuff protocol flow.
// Returns the response and a cleanup function to release resources.
async function executeWithLease(
  pool: FreebuffTokenPool,
  client: FreebuffTokenClient,
  model: string,
  body: Record<string, unknown>,
): Promise<LeaseResult> {
  // 1. Reuse active session, or admit a new one
  let session = await client.getSession(model)
  let admitted = false
  if (!session) {
    session = await client.admitSession(model)
    admitted = true
  }
  const instanceId = session.instanceId

  // 2. Start agent run
  const runId = await client.startRun(instanceId, model)

  // 3. Forward chat
  const stream = body.stream === true
  const messages = (body.messages as Array<Record<string, unknown>> | undefined)?.map(normalizeMessage) ?? []
  const response = await client.streamChat(instanceId, model, runId, messages, stream)

  return { runId, instanceId, response, admitted }
}

// Handle chat/completions or responses requests.
async function handleChat(
  req: Request,
  config: RouterConfig,
  pool: FreebuffTokenPool,
): Promise<Response> {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const modelId = (body as Record<string, unknown>).model as string | undefined
  if (!modelId) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required parameter: model' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // Translate Responses API → Chat Completions
  let chatBody: Record<string, unknown>
  if (isResponsesRequest(body as Record<string, unknown>)) {
    const translated = translateResponsesToChat(body)
    chatBody = {
      model: translated.model,
      messages: translated.messages,
      stream: translated.stream,
      temperature: translated.temperature,
      top_p: translated.top_p,
      max_tokens: translated.max_tokens,
      response_format: translated.response_format,
    }
  } else {
    chatBody = body
  }

  const messages = chatBody.messages as Array<unknown> | undefined
  if (!messages || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: 'No messages provided' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // Acquire a token from the pool and run the Freebuff flow
  let result: LeaseResult
  let client: FreebuffTokenClient
  try {
    client = await pool.acquire(modelId)
    try {
      result = await executeWithLease(pool, client, modelId, chatBody)
    } finally {
      pool.release(client)
    }
  } catch (err) {
    const e = err as Error
    const msg = e.message ?? 'Session admission failed'
    const statusMatch = msg.match(/\[(\w+)\]/)
    const fbStatus = statusMatch ? statusMatch[1] : 'api_error'

    const { openAIError, httpStatus } = formatFreebuffError(fbStatus, msg, modelId)
    return new Response(JSON.stringify({ error: openAIError }), {
      status: httpStatus,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { runId, admitted, response } = result

  // Translate Freebuff-specific errors into OpenAI-compatible error responses
  if (!response.ok) {
    const text = await response.text()
    let fbError: Record<string, unknown> = {}
    try { fbError = JSON.parse(text) } catch {}

    const status = String(fbError?.status ?? `http_${response.status}`)
    const message = String(fbError?.message ?? fbError?.error ?? `Freebuff API error: ${response.status}`)

    const { openAIError, httpStatus } = formatFreebuffError(status, message, modelId)
    return new Response(JSON.stringify({ error: openAIError }), {
      status: response.status === 429 ? 429 : response.status >= 500 ? 503 : 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Cleanup function (best-effort)
  const cleanup = async () => {
    try { await client.finishRun(runId) } catch {}
    if (admitted) { try { await client.releaseSession() } catch {} }
  }

  if (!chatBody.stream) {
    // Non-streaming: consume upstream JSON, then clean up
    const json = await response.json()
    void cleanup()
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Streaming: relay the upstream SSE stream, running cleanup when the
  // client finishes reading. A TransformStream lets us run cleanup code
  // after the last byte passes through to the client.
  const transform = new TransformStream({
    async transform(chunk, controller) {
      controller.enqueue(chunk)
    },
    async flush(controller) {
      controller.terminate()
      void cleanup().catch(() => {})
    },
  })

  return new Response(response.body?.pipeThrough(transform), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

export async function startRouter(configOverride?: RouterConfig): Promise<ReturnType<typeof serve>> {
  const config = configOverride ?? loadConfig()
  const { tokens } = createDefaultTokenProvider()
  const pool = new FreebuffTokenPool(config.freebuff.apiHost, tokens)

  const server = serve({
    hostname: config.host,
    port: config.port,
    async fetch(req: Request) {
      const url = new URL(req.url)
      const path = url.pathname

      // Health check (no auth)
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', tokens: pool.tokenCount }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // All /v1/* routes require auth if routerKey is set
      if (path.startsWith('/v1/')) {
        const authErr = checkAuth(req, config)
        if (authErr) return authErr
      }

      // Route matching
      if (path === '/v1/models' || path === '/models') {
        return modelsResponse(pool)
      }

      if (path === '/v1/chat/completions' || path === '/chat/completions') {
        return handleChat(req, config, pool)
      }

      if (path === '/v1/responses' || path === '/responses') {
        return handleChat(req, config, pool)
      }

      // Deployment-style alias (Azure compat)
      const depMatch = path.match(/^\/v1\/deployments\/[^/]+\/(.+)$/)
      if (depMatch) {
        const subPath = depMatch[1]
        const newUrl = new URL(req.url)
        newUrl.pathname = `/v1/${subPath}`
        const newReq = new Request(newUrl, req)
        return handleChat(newReq, config, pool)
      }

      return new Response(JSON.stringify({ error: { message: 'Not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    error(error: Error) {
      console.error('[router]', error.message)
      return new Response(
        JSON.stringify({ error: { message: 'Internal server error' } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })

  console.log(`[router] freebuff proxy listening on http://${config.host}:${server.port}`)
  console.log(`[router] models: http://${config.host}:${server.port}/v1/models`)
  return server
}

// Entry point when run directly via `bun server.ts`
if (import.meta.main) {
  startRouter().catch((err) => {
    console.error('[router] fatal:', err)
    process.exit(1)
  })
}
