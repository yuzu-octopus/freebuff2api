/**
 * Freebuff protocol handler.
 *
 * Implements the session/admission/agent-run/chat protocol documented in
 * PROTOCOL.md. Spoofs the CLI user-agent to bypass the free_mode_cli_required
 * gate. All requests carry codebuff_metadata with cost_mode: 'free' so the
 * server bills to the free tier.
 *
 * Supports multiple Freebuff tokens via a token pool for concurrency:
 * each account has a single global active session, so multiple tokens
 * = multiple independent session slots = parallel request handling.
 * Sessions expire server-side after ~6h; getSession treats 410/409-stale
 * as dead and re-admits a fresh session automatically.
 *
 * Flow per request:
 *   1. Acquire an idle token from the pool.
 *   2. Reuse active session (GET /session) or admit a new one (POST /session).
 *   3. Start agent run (POST /agent-runs START → runId, fresh per request).
 *   4. Stream chat (POST /chat/completions with runId + codebuff_metadata).
 *   5. Release token back to the pool (best-effort FINISH + session release).
 */

import { AGENT_BY_MODEL, AGENT_FALLBACK, DEFAULT_MODEL, resolveFreebuffTokens } from './config'
import { normalizeTools } from './tools'
import { ensureFreeMarker } from './prompt'

export interface Session {
  status: string
  instanceId: string
  model: string
  position?: number
  queueDepth?: number
  rateLimit?: { recentCount: number; limit: number; resetAt: string }
  rateLimitsByModel?: Record<string, { recentCount: number; limit: number; resetAt: string }>
  limitedModelOffers?: Array<{
    model: string
    remaining: number
    total: number
    userRemaining: number
    userResetAt: string
  }>
}


// Wire header the real SDK sends on chat + agent-runs (model-provider.ts):
// `ai-sdk/openai-compatible/${VERSION}/codebuff`. No runtime/browser suffix —
// that variant identifies a browser client, and the free-mode gate rejects it.
export const CLI_USER_AGENT = 'ai-sdk/openai-compatible/0.0.0-test/codebuff'

export class FreebuffTokenClient {
  readonly token: string
  private apiHost: string
  private instanceId: string | null = null
  private runId: string | null = null
  private busy: boolean = false
  private sessionModel: string | null = null
  private userId: string | null | undefined = undefined
  private userIdFetching: Promise<string | null> | null = null
  /** MS epoch until this token's tool-quota bucket is expected to free up. */
  private quotaCooldownUntil: number = 0

  constructor(token: string, apiHost: string) {
    this.token = token
    this.apiHost = apiHost
  }

  get isBusy(): boolean {
    return this.busy
  }

  setBusy(value: boolean): void {
    this.busy = value
  }

  private get sessionUrl(): string {
    return `${this.apiHost}/api/v1/freebuff/session`
  }

  private get runsUrl(): string {
    return `${this.apiHost}/api/v1/agent-runs`
  }

  private get chatUrl(): string {
    return `${this.apiHost}/api/v1/chat/completions`
  }

  private get meUrl(): string {
    return `${this.apiHost}/api/v1/me?fields=id`
  }

  /**
   * Resolve the account's user id (GET /api/v1/me?fields=id), as the SDK
   * does before every run. The id is sent as x-freebuff-acting-user-id on
   * agent-runs and chat; without it those requests lack the CLI identity the
   * free-mode gate checks. Cached per token; failures fall back to omitting
   * the header (the SDK tolerates a missing userId the same way).
   */
  resolveUserId(): Promise<string | null> {
    if (this.userId !== undefined) return Promise.resolve(this.userId)
    if (this.userIdFetching) return this.userIdFetching
    this.userIdFetching = (async () => {
      try {
        const res = await fetch(this.meUrl, {
          headers: { Authorization: `Bearer ${this.token}` },
        })
        if (!res.ok) return (this.userId = null)
        const body = await res.json().catch(() => null)
        return (this.userId =
          typeof body?.id === 'string' && body.id ? body.id : null)
      } catch {
        return (this.userId = null)
      }
    })()
    return this.userIdFetching
  }

  private async actingUserHeaders(): Promise<Record<string, string>> {
    const id = await this.resolveUserId()
    return id ? { 'x-freebuff-acting-user-id': id } : {}
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'user-agent': CLI_USER_AGENT,
    }
  }

  /** Release the session we admitted. */
  async releaseSession(): Promise<void> {
    if (!this.instanceId) return
    try {
      const headers = {
        ...this.authHeaders(),
        'x-freebuff-instance-id': this.instanceId,
      }
      await fetch(this.sessionUrl, { method: 'DELETE', headers }).catch(() => {})
    } catch {
      // best-effort
    } finally {
      this.instanceId = null
      this.sessionModel = null
    }
  }

  /** Get active session for the current instance, or null if none. */
  async getSession(model: string): Promise<Session | null> {
    const headers: Record<string, string> = this.authHeaders()
    if (this.instanceId) {
      headers['x-freebuff-instance-id'] = this.instanceId
    }
    headers['x-freebuff-compact-session'] = '1'
    headers['x-freebuff-model'] = model
    headers['x-freebuff-heartbeat'] = '1'
    const res = await fetch(this.sessionUrl, { method: 'GET', headers })
    const body = await res.json().catch(() => null)

    if (!res.ok) {
      // Stale or displaced session: 409 model_locked (bound to a different
      // model), 410 session_expired (the ~6h session expired), 409
      // session_superseded / session_model_mismatch (another client rotated
      // or the model tier changed). All mean "our cached session is dead" —
      // invalidate and let tryLeaseClient admit a fresh one.
      if (res.status === 409 || res.status === 410) {
        this.invalidateSession()
        return null
      }
      if (res.status === 404 || body?.status === 'none') return null
      const status = body?.status ?? `http_${res.status}`
      const detail = body?.message ?? body?.error ?? ''
      throw new Error(`Session GET failed [${status}]: ${detail}`.trim())
    }

    if (body?.status === 'none') return null
    if (body?.status === 'queued') {
      // Waiting room: poll position until session is admitted
      return this.pollQueuedSession(model, body.position, body.queueDepth)
    }
    if (body?.status === 'active') {
      if (body.model && body.model !== model) return null
      this.instanceId = body.instanceId
      this.sessionModel = model
      return body
    }
    return null
  }

  /** Invalidate cached session state (instanceId + model). */
  private invalidateSession(): void {
    this.instanceId = null
    this.sessionModel = null
  }

  /** Poll session endpoint while in waiting room queue. */
  private async pollQueuedSession(
    model: string,
    position: number,
    queueDepth: number,
  ): Promise<Session> {
    const maxWaitMs = 30_000
    const intervalMs = 5_000
    const start = Date.now()

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, intervalMs))
      const session = await this.getSession(model)
      if (session) {
        this.instanceId = session.instanceId
        return session
      }
    }
    throw new Error(`Session wait timed out after ${maxWaitMs / 1000}s (queue depth: ${queueDepth})`)
  }

  /** Admit a new session for the model. */
  async admitSession(model: string): Promise<Session> {
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      'x-freebuff-model': model,
    }

    const res = await fetch(this.sessionUrl, { method: 'POST', headers })
    const body = await res.json().catch(() => null)

    if (!res.ok) {
      const status = body?.status ?? `http_${res.status}`
      const detail = body?.message ?? body?.error ?? ''
      throw new Error(`Session admit failed [${status}]: ${detail}`.trim())
    }

    this.instanceId = body.instanceId ?? null
    this.sessionModel = model
    return body
  }

  /**
   * Fetch live model availability from the Freebuff session endpoint.
   * Returns null if the server is unreachable or auth fails.
   */
  async fetchLiveModelInfo(): Promise<Session | null> {
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      'x-freebuff-model': DEFAULT_MODEL,
      'x-freebuff-heartbeat': '1',
    }
    const res = await fetch(this.sessionUrl, { method: 'GET', headers }).catch(() => null)
    if (!res || !res.ok) return null
    const body = await res.json().catch(() => null)
    return body as Session | null
  }

  /** Start an agent run; returns the runId. */
  async startRun(instanceId: string, model: string): Promise<string> {
    const agentId = AGENT_BY_MODEL[model] ?? AGENT_FALLBACK
    const res = await fetch(this.runsUrl, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        ...(await this.actingUserHeaders()),
      },
      body: JSON.stringify({ action: 'START', agentId }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`startRun failed: HTTP ${res.status} ${text.slice(0, 300)}`)
    }

    const body = await res.json().catch(() => null)
    if (!body?.runId) {
      throw new Error(`startRun returned no runId: ${JSON.stringify(body)}`)
    }
    this.runId = body.runId
    return this.runId
  }

  /** Best-effort FINISH to close server-side run accounting. */
  async finishRun(runId: string): Promise<void> {
    if (runId !== this.runId) return // run was already rotated
    try {
      await fetch(this.runsUrl, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          ...(await this.actingUserHeaders()),
        },
        body: JSON.stringify({
          action: 'FINISH',
          runId,
          status: 'completed',
          totalSteps: 0,
          directCredits: 0,
          totalCredit: 0,
        }),
      }).catch(() => {})
    } catch {
      // best-effort — never throw on finish
    }
  }

  /**
   * Stream chat completions.
   * Sends the OpenAI-compatible body with runId + codebuff_metadata.
   */
async streamChat(
    instanceId: string,
    model: string,
    runId: string,
    messages: Array<{ role: string; content: string }>,
    stream = true,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    const { tools, tool_choice, ...rest } = extra
    const normalizedTools = tools ? normalizeTools(tools) : undefined
    const agentName = AGENT_BY_MODEL[model] ?? AGENT_FALLBACK
    // The free-mode chat gate requires the first system message to open with
    // the "You are Buffy" marker. Inject marker+override like XxxTeam's
    // freebuff2api (prefix the first system message, or insert one at index 0
    // when absent), deduping when the caller already carries the marker.
    const chatMessages = ensureFreeMarker(messages as Array<{ role: string; content: unknown }>)
    const payload = {
      model,
      ...rest,
      messages: chatMessages,
      stream,
      runId,
      ...(normalizedTools ? { tools: normalizedTools } : {}),
      ...(tool_choice ? { tool_choice } : {}),
      codebuff_metadata: {
        run_id: runId,
        client_id: crypto.randomUUID(),
        n: agentName,
        cost_mode: 'free',
        freebuff_instance_id: instanceId,
      },
    }

    const headers: Record<string, string> = {
      ...this.authHeaders(),
      ...(await this.actingUserHeaders()),
      'Content-Type': 'application/json',
      'x-freebuff-model': model,
      Accept: stream ? 'text/event-stream' : 'application/json',
    }

    const res = await fetch(this.chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let hint = ''
      try {
        const b = JSON.parse(text)
        if (b.error === 'free_mode_cli_required') {
          hint = '\n  (Server rejected: free_mode_cli_required — request not recognised as the CLI. Ensure the first message is the "You are Buffy" system prompt and CLI user-agent is set.)'
        }
      } catch {
        /* non-JSON */
      }
      throw new Error(`Chat failed: HTTP ${res.status} ${text.slice(0, 300)}${hint}`)
    }

    return res
  }
  /** Returns the model this token currently has an active session for, if any. */
  getSessionModel(): string | null {
    return this.sessionModel
  }

  /**
   * Mark this token's tool-quota bucket exhausted for `cooldownMs`. The pool
   * skips it until then so subsequent tool requests fail over to other tokens
   * instead of rehitting the same 429.
   */
  markToolQuotaExhausted(cooldownMs: number): void {
    this.quotaCooldownUntil = Date.now() + cooldownMs
  }

  /** True while this token is in its tool-quota cooldown window. */
  isToolQuotaExhausted(): boolean {
    return Date.now() < this.quotaCooldownUntil
  }

  /** MS epoch when this token's tool-quota cooldown clears. */
  quotaCooldownEndsAt(): number {
    return this.quotaCooldownUntil
  }

  /** Daily free streak (quota/streak status surface). */
  async fetchStreak(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.apiHost}/api/v1/freebuff/streak`, {
      headers: this.authHeaders(),
    })
    if (!res.ok) return { error: `Streak fetch failed: HTTP ${res.status}` }
    return (await res.json().catch(() => ({}))) as Record<string, unknown>
  }

  /** Token-count passthrough (mirrors the CLI's context-metering call). */
  async fetchTokenCount(payload: Record<string, unknown>): Promise<{ json?: unknown; error?: string }> {
    const res = await fetch(`${this.apiHost}/api/v1/token-count`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = (json as Record<string, unknown>)?.error
      return { error: msg ? String(msg) : `HTTP ${res.status}` }
    }
    return { json }
  }

  /** Masked token for status surfaces (never expose the raw value). */
  tokenLabel(): string {
    return this.token.length > 8 ? `${this.token.slice(0, 4)}…${this.token.slice(-4)}` : '***'
  }
}

/**
 * Pool of Freebuff token clients for concurrent request handling.
 * Assigns requests to idle tokens. If all are busy, the request waits.
 * This maximizes concurrency while avoiding session conflicts — each token
 * has its own global active session that can't be shared across models.
 */
export class FreebuffTokenPool {
  private clients: FreebuffTokenClient[]
  private nextIndex: number = 0
  private waiters: Array<() => void> = []

  constructor(apiHost: string, tokens: string[]) {
    if (tokens.length === 0) {
      throw new Error('FreebuffTokenPool requires at least one token')
    }
    this.clients = tokens.map((t) => new FreebuffTokenClient(t, apiHost))
  }

  get tokenCount(): number {
    return this.clients.length
  }

  /**
   * Acquire an idle token client, preferring tokens that already have an
   * active session for `model` (avoids unnecessary session rotation and
   * preserves Freebuff's context/cache for the same user conversation).
   * Falls back to round-robin among all idle tokens.
   * Waits if all tokens are busy.
   */
  async acquire(model?: string): Promise<FreebuffTokenClient> {
    while (true) {
      // Prefer a token with an active session for the same model
      if (model) {
        const match = this.pickIdleWithModel(model)
        if (match) {
          match.setBusy(true)
          return match
        }
      }
      // Fall back to any idle token
      const client = this.pickIdle()
      if (client) {
        client.setBusy(true)
        return client
      }
      // All busy (or all tool-quota-quarantined) — wait for a release. If
      // every idle token is quarantined, no release() will ever come (the
      // request that triggered the quarantine already threw), so also wake
      // when the earliest cooldown expires. Without this, a single-token
      // router hangs forever after one tool-quota 429 instead of retrying
      // after the 15-minute cooldown.
      const { promise, resolve } = Promise.withResolvers<void>()
      this.waiters.push(resolve)
      const earliestClear = this.earliestQuotaClear()
      const timer = earliestClear === null
        ? null
        : setTimeout(resolve, Math.max(0, earliestClear - Date.now()))
      await promise
      if (timer) clearTimeout(timer)
    }
  }

  /** Release a client back to the pool. */
  release(client: FreebuffTokenClient): void {
    client.setBusy(false)
    const waiter = this.waiters.shift()
    if (waiter) waiter()
  }

  /** Earliest MS epoch at which a quarantined idle token's cooldown clears. */
  private earliestQuotaClear(): number | null {
    let earliest: number | null = null
    for (const c of this.clients) {
      if (!c.isBusy && c.isToolQuotaExhausted()) {
        const until = c.quotaCooldownEndsAt()
        if (earliest === null || until < earliest) earliest = until
      }
    }
    return earliest
  }

  private pickIdle(): FreebuffTokenClient | null {
    const count = this.clients.length
    for (let i = 0; i < count; i++) {
      const idx = (this.nextIndex + i) % count
      if (!this.clients[idx].isBusy && !this.clients[idx].isToolQuotaExhausted()) {
        this.nextIndex = (idx + 1) % count
        return this.clients[idx]
      }
    }
    return null
  }

  /** Pick an idle token that has an active session for `model`. */
  private pickIdleWithModel(model: string): FreebuffTokenClient | null {
    for (const client of this.clients) {
      if (!client.isBusy && !client.isToolQuotaExhausted() && client.getSessionModel() === model) {
        return client
      }
    }
    return null
  }

  /** Aggregate live model info from all tokens; uses first token to probe. */
  async fetchLiveModelInfo(): Promise<Session | null> {
    try {
      return await this.clients[0].fetchLiveModelInfo()
    } catch {
      return null
    }
  }

  /** Per-token status for /health?verbose. Masks tokens; no secret exposure. */
  snapshot(): Array<{ token: string; busy: boolean; sessionModel: string | null; toolQuotaExhausted: boolean }> {
    return this.clients.map((c) => ({
      token: c.tokenLabel(),
      busy: c.isBusy,
      sessionModel: c.getSessionModel(),
      toolQuotaExhausted: c.isToolQuotaExhausted(),
    }))
  }

  /** Daily free streak via the first token (quota/streak status surface). */
  fetchStreak(): Promise<Record<string, unknown>> {
    return this.clients[0].fetchStreak()
  }

  /** Token-count passthrough (mirrors the CLI's context-metering call). */
  fetchTokenCount(payload: Record<string, unknown>): Promise<{ json?: unknown; error?: string }> {
    return this.clients[0].fetchTokenCount(payload)
  }
}
