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
import { type FreebuffTokenClient, FreebuffTokenPool } from './freebuff'
import { loadConfig, MODEL_CATALOG, type RouterConfig, resolveFreebuffTokens } from './config'
import { isResponsesRequest, translateResponsesToChat } from './translate'
import { claudeToOpenAI, initAnthropicStreamState, openAIChunkToClaudeEvents, finalizeClaudeStream } from './anthropic'
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
  cleanup: () => Promise<void>
}
// How long a token is skipped after its tool-quota bucket 429s. Long enough
// to fail tool calls over to other tokens for the day, short enough that a
// transient blip doesn't strand the token useless.
const TOOL_QUOTA_COOLDOWN_MS = 15 * 60 * 1000
// Acquire a token from the pool, run the full Freebuff protocol flow.
// Retries on model_locked (session bound to a different model) by trying
// the next idle token. Returns the response and a cleanup function.
async function executeWithLease(
  pool: FreebuffTokenPool,
  model: string,
  body: Record<string, unknown>,
): Promise<LeaseResult & { cleanup: () => Promise<void> }> {
  let client: FreebuffTokenClient
  let result: LeaseResult
  let attempts = 0
  const maxAttempts = pool.tokenCount

  while (attempts < maxAttempts) {
    client = await pool.acquire(model)
    try {
      result = await tryLeaseClient(client, model, body)
      const cleanup = async () => {
        try { await client.finishRun(result.runId) } catch {}
        if (result.admitted) { try { await client.releaseSession() } catch {} }
        pool.release(client)
      }
      return { ...result, cleanup }
    } catch (err) {
      pool.release(client)
      const msg = (err as Error).message
      // Session bound to a different model → try the next idle token.
      if (msg.includes('model_locked') && attempts < maxAttempts - 1) {
        attempts++
        continue
      }
      // Free tier's tool-quota bucket exhausted (a 429 naming high-balance /
      // free-models-per-day). Quarantine this token and fail the request over
      // to another token; only genuinely-failing tool-quota 429s count — other
      // 429s propagate as-is.
      if (isToolQuota429(msg)) {
        client.markToolQuotaExhausted(TOOL_QUOTA_COOLDOWN_MS)
        if (attempts < maxAttempts - 1) {
          attempts++
          continue
        }
      }
      throw err
    }
  }
  throw new Error('All tokens exhausted trying to acquire a session')
}

/** True for the free-tier tool-quota 429 (`free-models-per-day-high-balance`). */
function isToolQuota429(msg: string): boolean {
  return msg.includes('429') && msg.includes('high-balance')
}

async function tryLeaseClient(
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

  // 2. Start agent run (fresh run per request — the server expires runs
  // with the ~6h session, which getSession re-admits on 410/404 below).
  const runId = await client.startRun(instanceId, model)

  // 3. Forward chat — pass tools, tool_choice, temperature, etc.
  const stream = body.stream === true
  const messages = (body.messages as Array<Record<string, unknown>> | undefined)?.map(normalizeMessage) ?? []
  const { model: _, instanceId: __, ...extra } = body
  const response = await client.streamChat(instanceId, model, runId, messages, stream, extra)

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
  // (retries on model_locked with the next token)
  let result: LeaseResult
  try {
    result = await executeWithLease(pool, modelId, chatBody)
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

  const { response } = result

  // Translate Freebuff-specific errors into OpenAI-compatible error responses
  if (!response.ok) {
    const text = await response.text()
    let fbError: Record<string, unknown> = {}
    try { fbError = JSON.parse(text) } catch {}

    const status = String(fbError?.status ?? `http_${response.status}`)
    const message = String(fbError?.message ?? fbError?.error ?? `Freebuff API error: ${response.status}`)

    const { openAIError, httpStatus } = formatFreebuffError(status, message, modelId)
    void result.cleanup()
    return new Response(JSON.stringify({ error: openAIError }), {
      status: httpStatus,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!chatBody.stream) {
    // Non-streaming: consume upstream JSON, then clean up. cleanup() must run
    // even when the body is malformed — a leaked lease wedges the pool forever.
    try {
      const json = await response.json()
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } finally {
      void result.cleanup()
    }
  }

  // Streaming: relay the upstream SSE stream, running cleanup on every exit
  // path. flush() alone is not enough — TransformStream.flush is skipped when
  // the source errors, and a client disconnect cancels the stream entirely;
  // both would leak the lease (token stuck busy, pool wedged).
  const relay = withCleanup(response.body, () => result.cleanup())

  return new Response(relay, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

/**
 * Wrap an upstream body so `cleanup` runs exactly once on every terminal
 * path: clean end, upstream error, and client cancel. A plain
 * TransformStream.flush misses error+cancel — those leak the lease.
 */
function withCleanup(
  body: ReadableStream<Uint8Array> | null,
  cleanup: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = body?.getReader()
  let cleaned = false
  const once = () => {
    if (cleaned) return
    cleaned = true
    void cleanup().catch(() => {})
  }
  if (!reader) {
    once()
    return new ReadableStream({ start(c) { c.close() } })
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          once()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (err) {
        once()
        controller.error(err)
      }
    },
    cancel() {
      once()
      reader.releaseLock()
    },
  })
}

/**
 * Handle Anthropic /v1/messages requests.
 * Converts to OpenAI chat format, proxies to Freebuff, then translates
 * the streaming response back to Anthropic SSE format.
 */
async function handleClaudeMessages(
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

  // Convert Anthropic → OpenAI format
  const { openaiBody, model, stream } = claudeToOpenAI(body as Record<string, unknown>)

  if (!model) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required parameter: model' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const messages = openaiBody.messages as Array<unknown> | undefined
  if (!messages || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: 'No messages provided' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // Acquire a token from the pool and run the Freebuff flow (same as chat)
  let result: LeaseResult
  try {
    result = await executeWithLease(pool, model, openaiBody)
  } catch (err) {
    return handleFreebuffError(err, model)
  }

  const { response } = result

  if (!response.ok) {
    return handleFreebuffResponseError(response, model)
  }

  if (!stream) {
    try {
      const json = await response.json() as Record<string, unknown>
      return new Response(JSON.stringify(openAINonStreamToClaude(json)), {
        headers: { 'Content-Type': 'application/json' },
      })
    } finally {
      void result.cleanup()
    }
  }

  // Streaming: translate OpenAI SSE → Anthropic SSE. cleanup runs inside the
  // generator's finally, after the last event is yielded (or on early
  // termination/error) — never before the stream is consumed.
  const sseStream = openAIToClaudeSSE(response.body!, () => result.cleanup())
  return new Response(sseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

/**
 * Convert an OpenAI SSE stream to Anthropic SSE events.
 * Yields Anthropic-format SSE lines as Uint8Array chunks.
 */
async function* openAIToClaudeSSE(
  body: ReadableStream<Uint8Array>,
  onDone?: () => Promise<void>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  let lineBuffer = ''

  try {
    // Send initial message_start event
    yield new TextEncoder().encode('event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        id: crypto.randomUUID(),
        type: 'message',
        role: 'assistant',
        model: '',
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }) + '\n\n')

    const state = initAnthropicStreamState()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        lineBuffer += new TextDecoder().decode(value)
        const lines = lineBuffer.split('\n')
        // Last element is either '' (clean line end) or a partial next line.
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue

          try {
            const chunk = JSON.parse(data)
            const events = openAIChunkToClaudeEvents(chunk, state)
            for (const event of events) {
              yield new TextEncoder().encode('event: ' + event.type + '\ndata: ' + event.data + '\n\n')
            }
          } catch {
            // Non-JSON, skip
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Send final events. finalizeClaudeStream already emits message_stop —
    // never append another here or Anthropic clients see a duplicate trailing
    // message_stop event.
    for (const event of finalizeClaudeStream(state)) {
      yield new TextEncoder().encode('event: ' + event.type + '\ndata: ' + event.data + '\n\n')
    }
  } finally {
    // Runs on clean end AND on early termination (client cancel / upstream
    // error) — the lease must never outlive the stream.
    if (onDone) await onDone().catch(() => {})
  }
}

/** Translate Freebuff/OpenAI error to Anthropic format. */
function handleFreebuffError(err: unknown, model: string): Response {
  const e = err as Error
  const msg = e.message ?? 'Session admission failed'
  const statusMatch = msg.match(/\[(\w+)\]/)
  const fbStatus = statusMatch ? statusMatch[1] : 'api_error'
  const { openAIError, httpStatus } = formatFreebuffError(fbStatus, msg, model)
  return anthropicErrorResponse(openAIError.message as string, httpStatus)
}

function handleFreebuffResponseError(response: Response, model: string): Response {
  return anthropicErrorResponse(`OpenAI API error: ${response.status}`, response.status === 429 ? 429 : response.status >= 500 ? 503 : 400)
}

/** Anthropic Messages API error envelope: { type: 'error', error: { type, message } }. */
function anthropicErrorResponse(message: string, httpStatus: number): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message },
    }),
    { status: httpStatus, headers: { 'Content-Type': 'application/json' } },
  )
}

export function openAINonStreamToClaude(json: Record<string, unknown>): Record<string, unknown> {
  const choices = json.choices as Array<Record<string, unknown>> | undefined
  if (!choices || choices.length === 0) {
    return {
      id: crypto.randomUUID(),
      type: 'message',
      role: 'assistant',
      model: str(json.model),
      content: [],
      stop_reason: 'end_turn',
      usage: json.usage,
    }
  }

  const choice = choices[0]
  const msg = choice.message as Record<string, unknown> | undefined
  const content: Array<Record<string, unknown>> = []

  if (msg?.content) {
    content.push({ type: 'text', text: String(msg.content) })
  }

  if (msg?.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const tcObj = tc as { function?: { name?: string; arguments?: string } }
      content.push({
        type: 'tool_use',
        id: crypto.randomUUID(),
        name: tcObj.function?.name,
        input: tcObj.function?.arguments ? safeJSONParse(tcObj.function.arguments) : {},
      })
    }
  }

  return {
    id: crypto.randomUUID(),
    type: 'message',
    role: 'assistant',
    model: str(json.model),
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: json.usage,
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function safeJSONParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return {} }
}

export async function startRouter(configOverride?: RouterConfig): Promise<ReturnType<typeof serve>> {
  const config = configOverride ?? loadConfig()
  const tokens = resolveFreebuffTokens()
  const pool = new FreebuffTokenPool(config.freebuff.apiHost, tokens)

  const server = serve({
    hostname: config.host,
    port: config.port,
    async fetch(req: Request) {
      const url = new URL(req.url)
      const path = url.pathname

      // Health check (no auth)
      if (path === '/health') {
        const url = new URL(req.url)
        const verbose = url.searchParams.get('verbose') === '1'
        const base: Record<string, unknown> = { status: 'ok', tokens: pool.tokenCount }
        if (verbose) {
          base.tokensDetail = pool.snapshot()
          base.streak = await pool.fetchStreak().catch(() => ({ error: 'unreachable' }))
        }
        return new Response(JSON.stringify(base), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // All routes except /health require auth if routerKey is set — this
      // includes the non-/v1 alias routes (convenience mirrors would
      // otherwise bypass the gate and burn Freebuff quota unauthenticated).
      if (path !== '/health') {
        const authErr = checkAuth(req, config)
        if (authErr) return authErr
      }

      if (path === '/v1/streak' || path === '/streak') {
        const streak = await pool.fetchStreak().catch(() => ({ error: 'unreachable' }))
        return new Response(JSON.stringify(streak), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (path === '/v1/token-count' || path === '/token-count') {
        const payload = await req.json().catch(() => null)
        if (!payload || typeof payload !== 'object') {
          return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const { json, error } = await pool.fetchTokenCount(payload as Record<string, unknown>)
        if (error) {
          return new Response(JSON.stringify({ error: { message: error } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify(json), {
          headers: { 'Content-Type': 'application/json' },
        })
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

      if (path === '/v1/messages' || path === '/messages') {
        return handleClaudeMessages(req, config, pool)
      }

      // Deployment-style alias (Azure compat)
      const depMatch = path.match(/^\/v1\/deployments\/[^/]+\/(.+)$/)
      if (depMatch) {
        const subPath = depMatch[1]
        const newUrl = new URL(req.url)
        newUrl.pathname = `/v1/${subPath}`
        const newReq = new Request(newUrl, req)
        if (subPath === 'messages') return handleClaudeMessages(newReq, config, pool)
        if (subPath === 'models') return modelsResponse(pool)
        if (subPath === 'streak') {
          const streak = await pool.fetchStreak().catch(() => ({ error: 'unreachable' }))
          return new Response(JSON.stringify(streak), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (subPath === 'token-count') {
          const payload = await newReq.json().catch(() => null)
          if (!payload || typeof payload !== 'object') {
            return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          const { json, error } = await pool.fetchTokenCount(payload as Record<string, unknown>)
          if (error) {
            return new Response(JSON.stringify({ error: { message: error } }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return new Response(JSON.stringify(json), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
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
