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
 * Run rotation (~6 hours) prevents session expiry on long-lived connections.
 *
 * Flow per request:
 *   1. Acquire an idle token from the pool.
 *   2. Reuse active session (GET /session) or admit a new one (POST /session).
 *   3. Start agent run (POST /agent-runs START → runId, rotate if >6h old).
 *   4. Stream chat (POST /chat/completions with runId + codebuff_metadata).
 *   5. Release token back to the pool (best-effort FINISH + session release).
 */

import { AGENT_BY_MODEL, AGENT_FALLBACK, DEFAULT_MODEL, resolveFreebuffTokens } from './config'

export interface Session {
  status: string
  instanceId: string
  model: string
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

export interface FreebuffClientOpts {
  apiHost: string
  tokens: string[]
}

// Wire header the SDK uses (see PROTOCOL.md line 84).
export const CLI_USER_AGENT = 'ai-sdk/openai-compatible/0.1.0/codebuff'

// Freebuff sessions expire after ~6 hours; rotate runs before then.
const RUN_ROTATION_INTERVAL_MS = 5.5 * 60 * 60 * 1000

export class FreebuffTokenClient {
  readonly token: string
  private apiHost: string
  private instanceId: string | null = null
  private runId: string | null = null
  private runStartedAt: number = 0
  private busy: boolean = false
  private sessionModel: string | null = null

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
      if (res.status === 404 || body?.status === 'none') return null
      const status = body?.status ?? `http_${res.status}`
      const detail = body?.message ?? body?.error ?? ''
      throw new Error(`Session GET failed [${status}]: ${detail}`.trim())
    }

    if (body?.status === 'none') return null
    if (body?.status === 'active') {
      if (body.model && body.model !== model) return null
      this.instanceId = body.instanceId
      return body
    }
    return null
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
      headers: this.authHeaders(),
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
    this.runStartedAt = Date.now()
    return this.runId
  }

  /** Best-effort FINISH to close server-side run accounting. */
  async finishRun(runId: string): Promise<void> {
    if (runId !== this.runId) return // run was already rotated
    try {
      await fetch(this.runsUrl, {
        method: 'POST',
        headers: this.authHeaders(),
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
  ): Promise<Response> {
    const payload = {
      model,
      messages,
      stream,
      runId,
      codebuff_metadata: {
        run_id: runId,
        client_id: crypto.randomUUID(),
        cost_mode: 'free',
        freebuff_instance_id: instanceId,
      },
    }

    const headers: Record<string, string> = {
      ...this.authHeaders(),
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
        const body = JSON.parse(text)
        if (body.error === 'free_mode_cli_required') {
          hint = '\n  (Server rejected: free_mode_cli_required. Your token may not be CLI-entitled.)'
        }
      } catch {
        /* non-JSON */
      }
      throw new Error(`Chat failed: HTTP ${res.status} ${text.slice(0, 300)}${hint}`)
    }

    return res
  }

  /** Returns true if the run needs rotation (older than 5.5h). */
  needsRunRotation(): boolean {
    return Date.now() - this.runStartedAt > RUN_ROTATION_INTERVAL_MS
  }

  /** Returns the model this token currently has an active session for, if any. */
  getSessionModel(): string | null {
    return this.sessionModel
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
      // All busy — wait for a release
      const { promise, resolve } = Promise.withResolvers<void>()
      this.waiters.push(resolve)
      await promise
    }
  }

  /** Release a client back to the pool. */
  release(client: FreebuffTokenClient): void {
    client.setBusy(false)
    const waiter = this.waiters.shift()
    if (waiter) waiter()
  }

  private pickIdle(): FreebuffTokenClient | null {
    const count = this.clients.length
    for (let i = 0; i < count; i++) {
      const idx = (this.nextIndex + i) % count
      if (!this.clients[idx].isBusy) {
        this.nextIndex = (idx + 1) % count
        return this.clients[idx]
      }
    }
    return null
  }

  /** Pick an idle token that has an active session for `model`. */
  private pickIdleWithModel(model: string): FreebuffTokenClient | null {
    for (const client of this.clients) {
      if (!client.isBusy && client.getSessionModel() === model) {
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
}

/** Build a TokenProvider that reads ROUTER_TOKEN env (comma-separated for multi-token)
 * or the CLI credentials file. */
export function createDefaultTokenProvider(): { tokens: string[] } {
  return { tokens: resolveFreebuffTokens() }
}
