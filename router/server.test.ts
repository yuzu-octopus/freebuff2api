/**
 * Integration tests for the router server.
 *
 * Tests the full HTTP surface: /v1/models, /v1/chat/completions (both
 * chat-completions and responses API formats), auth gating, and error handling.
 *
 * Uses the same mock Freebuff approach as freebuff.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { serve } from 'bun'
import { startRouter } from './server'
import type { RouterConfig } from './config'
import { MODEL_CATALOG } from './config'

const VALID_TOKEN = 'fake-token'

function parseBearer(auth: string | null): string | null {
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

type MockServer = { port: number; stop: (force?: boolean) => void }

let freebuffMock: MockServer
let freebuffApiUrl: string
let router: MockServer
let routerUrl: string

function startFreebuffMock(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()

  const sessions = new Map<string, string>()

  freebuffMock = serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const token = parseBearer(req.headers.get('authorization'))
      if (token !== VALID_TOKEN) return new Response('Unauthorized', { status: 401 })

      const model = req.headers.get('x-freebuff-model')!

      if (url.pathname === '/api/v1/freebuff/session') {
        const instanceId = req.headers.get('x-freebuff-instance-id')

        if (req.method === 'POST') {
          // Simulate rate limiting for a specific test model
          if (model === 'test/rate-limited') {
            return new Response(
              JSON.stringify({ status: 'rate_limited', rateLimit: { recentCount: 6, limit: 6, resetAt: new Date(Date.now() + 3600000).toISOString() } }),
              { status: 429, headers: { 'Content-Type': 'application/json' } },
            )
          }
          const newInstanceId = crypto.randomUUID()
          sessions.set(model, newInstanceId)
          return Response.json({
            status: 'active',
            instanceId: newInstanceId,
            model,
            rateLimit: { recentCount: 0, limit: 100, resetAt: new Date(Date.now() + 86400000).toISOString() },
          })
        }
        if (req.method === 'GET') {
          if (!instanceId) {
            // No active session — return live model availability info
            return Response.json({
              status: 'none',
              rateLimitsByModel: {
                'deepseek/deepseek-v4-flash': { model: 'deepseek/deepseek-v4-flash', limit: 100, recentCount: 0, resetAt: new Date(Date.now() + 86400000).toISOString(), period: 'pacific_day', resetTimeZone: 'America/Los_Angeles', windowHours: 24 },
                'openai/gpt-5.6-luna': { model: 'openai/gpt-5.6-luna', limit: 6, recentCount: 3, resetAt: new Date(Date.now() + 3600000).toISOString(), period: 'pacific_day', resetTimeZone: 'America/Los_Angeles', windowHours: 24 },
              },
              limitedModelOffers: [
                { model: 'anthropic/claude-fable-5', remaining: 5, total: 10, userRemaining: 1, userResetAt: new Date(Date.now() + 3600000).toISOString() },
              ],
            })
          }
          // Verify the instance belongs to this model
          if (sessions.get(model) !== instanceId) return Response.json({ status: 'none' })
          return Response.json({ status: 'active', instanceId, model })
        }

        if (req.method === 'DELETE') {
          sessions.delete(model)
          return new Response(null, { status: 204 })
        }
      }

      if (url.pathname === '/api/v1/agent-runs') {
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({}))
          if (body.action === 'START') return Response.json({ runId: `run-${crypto.randomUUID()}` })
          if (body.action === 'FINISH') return new Response(null, { status: 204 })
        }
      }

      if (url.pathname === '/api/v1/chat/completions') {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            const chunks = [
              { id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant' } }] },
              { choices: [{ index: 0, delta: { content: 'Mock ' } }] },
              { choices: [{ index: 0, delta: { content: 'response' } }] },
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
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
        })
      }

      return new Response('Not found', { status: 404 })
    },
    error() {
      return new Response('Internal', { status: 500 })
    },
  })

  freebuffApiUrl = `http://127.0.0.1:${freebuffMock.port}`
  resolve()
  return promise
}

function stopFreebuffMock(): void {
  freebuffMock.stop(true)
}

beforeAll(() => {
  process.env.FREEBUFF_TOKEN = VALID_TOKEN
})

describe('Router server', () => {
  beforeAll(async () => {
    await startFreebuffMock()

    const config: RouterConfig = {
      host: '127.0.0.1',
      port: 0,
      freebuff: {
        apiHost: freebuffApiUrl,
        loginHost: 'https://freebuff.com',
      },
    }
    router = await startRouter(config)
    routerUrl = `http://127.0.0.1:${router.port}`
  })

  describe('GET /v1/models', () => {
    it('returns the model catalog as JSON', async () => {
      const res = await fetch(`${routerUrl}/v1/models`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')

      interface ModelsResponse {
        object: string
        data: Array<{ id: string; display?: string; quota?: string; type?: string; userRemaining?: number; userResetAt?: string; remaining?: number; total?: number }>
      }
      const body = await res.json() as ModelsResponse
      expect(body.data.length).toBe(MODEL_CATALOG.length)
      expect(body.data[0].id).toBe('deepseek/deepseek-v4-flash')
      expect(body.object).toBe('list')
    })

    it('enriches models with live Freebuff rate limits and limited offers', async () => {
      const res = await fetch(`${routerUrl}/v1/models`)
      expect(res.status).toBe(200)

      interface ModelEntry {
        id: string
        quota?: string
        userRemaining?: number
        userResetAt?: string
        remaining?: number
        total?: number
      }
      const body = await res.json() as { data: ModelEntry[] }

      // Flash model should have user quota info from rateLimitsByModel
      const flash = body.data.find((m) => m.id === 'deepseek/deepseek-v4-flash')
      expect(flash).toBeDefined()
      // Luna model should have 3 of 6 used
      const luna = body.data.find((m) => m.id === 'openai/gpt-5.6-luna')
      expect(luna).toBeDefined()
      expect(luna!.userRemaining).toBe(3) // limit 6, recentCount 3
    })
  })

  describe('POST /v1/chat/completions (chat format)', () => {
    it('returns streaming SSE response', async () => {
      const res = await fetch(`${routerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek/deepseek-v4-flash',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }

      expect(text).toContain('Mock')
      expect(text).toContain('response')
      expect(text).toContain('data: [DONE]')
    })
  })

  describe('POST /v1/responses (responses API)', () => {
    it('translates to chat completions and streams back', async () => {
      const res = await fetch(`${routerUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek/deepseek-v4-flash',
          instructions: 'You are concise',
          input: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      })

      expect(res.status).toBe(200)

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }

      expect(text).toContain('data:')
      expect(text).toContain('[DONE]')
    })
  })

  describe('Auth gating', () => {
    it('returns 401 when routerKey is required but not provided', async () => {
      const configWithKey: RouterConfig = {
        host: '127.0.0.1',
        port: 0,
        routerKey: 'secret',
        freebuff: { apiHost: freebuffApiUrl, loginHost: 'https://freebuff.com' },
      }

      const securedRouter = await startRouter(configWithKey)
      const url = `http://127.0.0.1:${securedRouter.port}`

      try {
        const res = await fetch(`${url}/v1/models`)
        expect(res.status).toBe(401)
        expect(res.headers.get('www-authenticate')).toBe('Bearer')
      } finally {
        securedRouter.stop(true)
      }
    })

    it('succeeds when routerKey is provided', async () => {
      const configWithKey: RouterConfig = {
        host: '127.0.0.1',
        port: 0,
        routerKey: 'secret',
        freebuff: { apiHost: freebuffApiUrl, loginHost: 'https://freebuff.com' },
      }

      const securedRouter = await startRouter(configWithKey)
      const url = `http://127.0.0.1:${securedRouter.port}`

      try {
        const res = await fetch(`${url}/v1/models`, {
          headers: { Authorization: 'Bearer secret' },
        })
        expect(res.status).toBe(200)
      } finally {
        securedRouter.stop(true)
      }
    })
  })

  describe('Error handling', () => {
    it('returns 400 when model is missing', async () => {
      const res = await fetch(`${routerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { error: { message: string } }
      expect(body.error.message).toMatch(/model/i)
    })

    it('returns 400 when messages and input both missing', async () => {
      const res = await fetch(`${routerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash' }),
      })

      expect(res.status).toBe(400)
    })

    it('translates Freebuff rate_limited to OpenAI rate_limit_error', async () => {
      const res = await fetch(`${routerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test/rate-limited',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })

      expect(res.status).toBe(429)
      const body = await res.json() as { error: { type: string; message: string } }
      expect(body.error.type).toBe('rate_limit_error')
      expect(body.error.message).toMatch(/rate/i)
    })
  })
})

