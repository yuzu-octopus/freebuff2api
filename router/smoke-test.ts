#!/usr/bin/env bun
/**
 * Smoke test: starts the router with a mock Freebuff backend and verifies
 * the full HTTP surface works end-to-end.
 *
 * Run with: `bun smoke-test` from the router/ directory, or
 *           `bun smoke-test.ts` from the project root.
 */

import { serve } from 'bun'

import { startRouter } from './server'
import { MODEL_CATALOG } from './config'

const VALID_TOKEN = 'smoke-test-token'

function parseBearer(auth: string | null): string | null {
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

type MockServer = { port: number; stop: (force?: boolean) => void }

function startMockFreebuff(): Promise<{ server: MockServer; url: string }> {
  const { promise, resolve } = Promise.withResolvers<{ server: MockServer; url: string }>()

  const sessions = new Map<string, string>()
  const server = serve({
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
          sessions.set(model, newInstanceId)
          return Response.json({
            status: 'active',
            instanceId: newInstanceId,
            model,
            rateLimit: { recentCount: 0, limit: 100, resetAt: new Date(Date.now() + 86400000).toISOString() },
          })
        }
        if (req.method === 'GET') {
          if (!instanceId) return Response.json({ status: 'none' })
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
              { choices: [{ index: 0, delta: { content: 'Smoke ' } }] },
              { choices: [{ index: 0, delta: { content: 'test ' } }] },
              { choices: [{ index: 0, delta: { content: 'passed!' } }] },
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

  const url = `http://127.0.0.1:${server.port}`
  resolve({ server, url })
  return promise
}

async function main() {
  process.env.ROUTER_TOKEN = VALID_TOKEN

  console.log('[smoke] starting mock Freebuff server...')
  const mock = await startMockFreebuff()
  console.log(`[smoke] mock Freebuff at ${mock.url}`)

  console.log('[smoke] starting router...')
  const router = await startRouter({
    host: '127.0.0.1',
    port: 0,
    freebuff: { apiHost: mock.url, loginHost: 'https://freebuff.com' },
  })

  const routerUrl = `http://127.0.0.1:${router.port}`
  const errors: string[] = []

  // Test 1: /v1/models
  console.log('[smoke] test: GET /v1/models')
  const modelsRes = await fetch(`${routerUrl}/v1/models`)
  if (modelsRes.status !== 200) {
    errors.push(`GET /v1/models returned ${modelsRes.status}`)
  } else {
    const models = await modelsRes.json() as { data: Array<{ id: string }> }
    const ids = models.data.map((m) => m.id)
    const expected = MODEL_CATALOG.map((m) => m.id)
    if (JSON.stringify(ids) !== JSON.stringify(expected)) {
      errors.push(`Models mismatch: got ${JSON.stringify(ids)}, want ${JSON.stringify(expected)}`)
    } else {
      console.log(`[smoke] ✓ models returned ${ids.length} models`)
    }
  }

  // Test 2: /v1/chat/completions (streaming)
  console.log('[smoke] test: POST /v1/chat/completions (streaming)')
  const chatRes = await fetch(`${routerUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hello, Freebuff!' }],
      stream: true,
    }),
  })
  if (chatRes.status !== 200) {
    errors.push(`POST /v1/chat/completions returned ${chatRes.status}`)
  } else if (!chatRes.headers.get('content-type')?.includes('event-stream')) {
    errors.push('Expected text/event-stream content type')
  } else {
    const reader = chatRes.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()

    // Check all delta content is present (content is split across SSE chunks in raw SSE form)
    if (!text.includes('Smoke ') || !text.includes('test ') || !text.includes('passed!')) {
      errors.push(`Chat response missing expected content: ${text.slice(0, 200)}`)
    } else {
      console.log('[smoke] ✓ streamed response received')
    }
    if (!text.includes('[DONE]')) {
      errors.push('Missing [DONE] in stream')
    }
  }

  // Test 3: /v1/responses (responses API → chat)
  console.log('[smoke] test: POST /v1/responses')
  const respRes = await fetch(`${routerUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo/mimo-v2.5',
      instructions: 'Be helpful',
      input: [{ type: 'message', role: 'user', content: 'Test responses API' }],
      stream: true,
    }),
  })
  if (respRes.status !== 200) {
    errors.push(`POST /v1/responses returned ${respRes.status}`)
  } else {
    const reader = respRes.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    if (!text.includes('[DONE]')) {
      errors.push('Responses API stream missing [DONE]')
    } else {
      console.log('[smoke] ✓ responses API translated and streamed')
    }
  }

  // Test 4: health check
  console.log('[smoke] test: GET /health')
  const healthRes = await fetch(`${routerUrl}/health`)
  if (healthRes.status !== 200) {
    errors.push(`GET /health returned ${healthRes.status}`)
  } else {
    console.log('[smoke] ✓ health check passed')
  }

  // Test 5: auth gating
  console.log('[smoke] test: auth gating')
  const secured = await startRouter({
    host: '127.0.0.1',
    port: 0,
    routerKey: 'secret',
    freebuff: { apiHost: mock.url, loginHost: 'https://freebuff.com' },
  })
  const securedUrl = `http://127.0.0.1:${secured.port}`

  const noAuthRes = await fetch(`${securedUrl}/v1/models`)
  if (noAuthRes.status !== 401) {
    errors.push(`Expected 401 without auth, got ${noAuthRes.status}`)
  } else {
    console.log('[smoke] ✓ auth gate works')
  }

  const withAuthRes = await fetch(`${securedUrl}/v1/models`, {
    headers: { Authorization: 'Bearer secret' },
  })
  if (withAuthRes.status !== 200) {
    errors.push(`Expected 200 with auth, got ${noAuthRes.status}`)
  }

  // Cleanup
  secured.stop(true)
  router.stop(true)
  mock.server.stop(true)

  if (errors.length > 0) {
    console.error('\n[smoke] ✗ failures:')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  } else {
    console.log('\n[smoke] ✓ all smoke tests passed\n')
  }
}

main().catch((err) => {
  console.error('[smoke] fatal:', err)
  process.exit(1)
})
