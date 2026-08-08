/**
 * Tests for the Freebuff protocol handler.
 *
 * We spin up a local mock Freebuff API server that implements the protocol
 * documented in PROTOCOL.md, then verify our handler speaks it correctly.
 * No real Freebuff calls — fully deterministic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { serve } from 'bun'
import { FreebuffTokenPool } from './freebuff'
import { resolveFreebuffTokens } from './config'

const VALID_TOKEN = 'test-token'

function parseBearer(auth: string | null): string | null {
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

interface SessionInfo {
  model: string
  instanceId: string
  active: boolean
}

interface RunInfo {
  model: string
  active: boolean
}

interface MockState {
  sessions: Map<string, SessionInfo>
  runs: Map<string, RunInfo>
  lastChatHeaders: Record<string, string> | null
  lastStartBody: Record<string, unknown> | null
  lastChatBody: Record<string, unknown> | null
}

let server: { port: number; stop: (force?: boolean) => void }
let baseUrl: string
let state: MockState

function startMockServer(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()

  state = {
    sessions: new Map(),
    runs: new Map(),
    lastChatHeaders: null,
    lastStartBody: null,
    lastChatBody: null,
  }

  server = serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const token = parseBearer(req.headers.get('authorization'))
      if (token !== VALID_TOKEN) return new Response('Unauthorized', { status: 401 })

      const model = req.headers.get('x-freebuff-model')!

      if (url.pathname === '/api/v1/freebuff/session') {
        const instanceId = req.headers.get('x-freebuff-instance-id')

        if (req.method === 'POST') {
          const newInstanceId = crypto.randomUUID()
          state.sessions.set(newInstanceId, {
            model,
            instanceId: newInstanceId,
            active: true,
          })
          return Response.json({
            status: 'active',
            instanceId: newInstanceId,
            model,
            rateLimit: { recentCount: 0, limit: 100, resetAt: new Date(Date.now() + 86400000).toISOString() },
          })
        }

        if (req.method === 'GET') {
          if (!instanceId) return Response.json({ status: 'none' })
          const sess = state.sessions.get(instanceId)
          if (!sess || !sess.active) return Response.json({ status: 'none' })
          return Response.json({ status: 'active', instanceId: sess.instanceId, model: sess.model })
        }

        if (req.method === 'DELETE') {
          if (instanceId) {
            const sess = state.sessions.get(instanceId)
            if (sess) sess.active = false
          }
          return new Response(null, { status: 204 })
        }
      }

      if (url.pathname === '/api/v1/agent-runs') {
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({}))
          if (body.action === 'START') {
            const runId = `run-${crypto.randomUUID()}`
            state.runs.set(runId, { model, active: true })
            state.lastStartBody = body
            return Response.json({ runId })
          }
          if (body.action === 'FINISH') {
            const run = state.runs.get(body.runId ?? '')
            if (run) run.active = false
            return new Response(null, { status: 204 })
          }
        }
      }

      if (url.pathname === '/api/v1/chat/completions') {
        state.lastChatHeaders = Object.fromEntries(req.headers.entries())
        state.lastChatBody = await req.json().catch(() => null)
        const encoder = new TextEncoder()
        const stream = new globalThis.ReadableStream({
          start(controller) {
            const chunks = [
              { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Hello ' } }] },
              { choices: [{ index: 0, delta: { content: 'from ' } }] },
              { choices: [{ index: 0, delta: { content: 'Freebuff!' } }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            ]
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      }

      return new Response('Not found', { status: 404 })
    },
    error() {
      return new Response('Internal', { status: 500 })
    },
  })

  resolve()
  return promise
}

function stopMockServer(): void {
  server.stop(true)
}

describe('FreebuffTokenPool', () => {
  beforeAll(async () => {
    await startMockServer()
    baseUrl = `http://127.0.0.1:${server.port}`
  })
  afterAll(stopMockServer)

  it('admits a session and reuses it on subsequent calls', async () => {
    const pool = new FreebuffTokenPool(baseUrl, [VALID_TOKEN])

    // Acquire a token for the model
    const client = await pool.acquire('deepseek/deepseek-v4-flash')
    try {
      const session = await client.admitSession('deepseek/deepseek-v4-flash')
      expect(session.status).toBe('active')
      expect(session.instanceId).toBeTruthy()
      expect(session.model).toBe('deepseek/deepseek-v4-flash')

      // The token now has a session for this model — session affinity
      expect(client.getSessionModel()).toBe('deepseek/deepseek-v4-flash')
    } finally {
      pool.release(client)
    }

    // A second acquire should prefer the same token (session affinity)
    const client2 = await pool.acquire('deepseek/deepseek-v4-flash')
    try {
      expect(client2).toBe(client) // same token client
    } finally {
      pool.release(client2)
    }

    // Clean up
    await client.releaseSession()
    pool.clients // access for test cleanup
  })

  it('starts and finishes a run with correct agent id', async () => {
    const pool = new FreebuffTokenPool(baseUrl, [VALID_TOKEN])
    const client = await pool.acquire('deepseek/deepseek-v4-flash')
    try {
      const session = await client.admitSession('deepseek/deepseek-v4-flash')

      const runId = await client.startRun(session.instanceId, 'deepseek/deepseek-v4-flash')
      expect(runId).toMatch(/^run-/)

      expect(state.lastStartBody).toBeDefined()
      expect(state.lastStartBody?.action).toBe('START')
      expect(state.lastStartBody?.agentId).toBe('base2-free-deepseek-flash')

      await client.finishRun(runId)
    } finally {
      pool.release(client)
    }
  })

  it('streams chat completions with CLI-spoofing user-agent', async () => {
    const pool = new FreebuffTokenPool(baseUrl, [VALID_TOKEN])
    const client = await pool.acquire('deepseek/deepseek-v4-flash')
    try {
      const session = await client.admitSession('deepseek/deepseek-v4-flash')
      const runId = await client.startRun(session.instanceId, 'deepseek/deepseek-v4-flash')

      const res = await client.streamChat(
        session.instanceId, 'deepseek/deepseek-v4-flash', runId,
        [{ role: 'user', content: 'Hello' }],
      )
      expect(res.ok).toBe(true)

      expect(state.lastChatHeaders?.authorization).toBe('Bearer test-token')
      expect(state.lastChatHeaders?.['user-agent']).toContain('ai-sdk/openai-compatible')
      expect(state.lastChatHeaders?.['x-freebuff-model']).toBe('deepseek/deepseek-v4-flash')

      // Parse SSE and reconstruct the concatenated delta content
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let raw = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        raw += decoder.decode(value, { stream: true })
      }

      const content = raw
        .split('\n\n')
        .map((block) => block.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => {
          const json = line.slice(5).trim()
          if (json === '[DONE]') return null
          const parsed = JSON.parse(json)
          return parsed.choices?.[0]?.delta?.content ?? ''
        })
        .filter(Boolean)
        .join('')

      expect(content).toBe('Hello from Freebuff!')
      expect(raw).toContain('data: [DONE]')
    } finally {
      pool.release(client)
    }
  })

  it('includes freebuff_instance_id and cost_mode in codebuff_metadata', async () => {
    const pool = new FreebuffTokenPool(baseUrl, [VALID_TOKEN])
    const client = await pool.acquire('deepseek/deepseek-v4-flash')
    try {
      const session = await client.admitSession('deepseek/deepseek-v4-flash')
      const runId = await client.startRun(session.instanceId, 'deepseek/deepseek-v4-flash')

      const res = await client.streamChat(
        session.instanceId, 'deepseek/deepseek-v4-flash', runId,
        [{ role: 'user', content: 'Hello' }],
      )
      await res.body?.cancel()

      const body = state.lastChatBody as Record<string, unknown> | null
      expect(body).toBeTruthy()
      expect(body?.runId).toBe(runId)
      const meta = body?.codebuff_metadata as Record<string, unknown> | undefined
      expect(meta?.run_id).toBe(runId)
      expect(meta?.cost_mode).toBe('free')
      expect(meta?.client_id).toBeTruthy()
      expect(meta?.freebuff_instance_id).toBe(session.instanceId)
    } finally {
      pool.release(client)
    }
  })

  it('supports multiple tokens with session affinity', async () => {
    const pool = new FreebuffTokenPool(baseUrl, [VALID_TOKEN, 'token-b', 'token-c'])
    expect(pool.tokenCount).toBe(3)

    // Use model A on token 1
    const clientA = await pool.acquire('deepseek/deepseek-v4-flash')
    await clientA.admitSession('deepseek/deepseek-v4-flash')
    pool.release(clientA)

    // Request same model again — should get the same token
    const clientA2 = await pool.acquire('deepseek/deepseek-v4-flash')
    try {
      expect(clientA2).toBe(clientA)
      expect(clientA2.getSessionModel()).toBe('deepseek/deepseek-v4-flash')
    } finally {
      pool.release(clientA2)
    }
  })

  it('falls back to any idle token when model has no session', async () => {
    const pool = new FreebuffTokenPool(baseUrl, [VALID_TOKEN, 'token-b'])
    expect(pool.tokenCount).toBe(2)

    // No sessions active — acquire should pick an idle token
    const client = await pool.acquire('deepseek/deepseek-v4-flash')
    try {
      expect(client.isBusy).toBe(true)
    } finally {
      pool.release(client)
    }
  })
})

describe('resolveFreebuffTokens', () => {
  it('reads comma-separated tokens from FREEBUFF_TOKEN env', () => {
    const original = process.env.FREEBUFF_TOKEN
    process.env.FREEBUFF_TOKEN = 'token-a,token-b,token-c'
    try {
      const tokens = resolveFreebuffTokens()
      expect(tokens).toEqual(['token-a', 'token-b', 'token-c'])
    } finally {
      if (original === undefined) delete process.env.FREEBUFF_TOKEN
      else process.env.FREEBUFF_TOKEN = original
    }
  })
})
