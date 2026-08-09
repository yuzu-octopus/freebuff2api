#!/usr/bin/env bun
/**
 * Live parity test — exercises the REAL router against the REAL Freebuff
 * upstream, verifying OpenAI + Anthropic surface parity with a normal
 * service provider: model list + limits, chat completions (stream and not),
 * Anthropic messages (stream and not), tool calls on both protocols,
 * streaming event sequences, and a small concurrency burst.
 *
 * Requires:
 *   - Router running (default http://127.0.0.1:8787, override ROUTER_URL)
 *   - Tokens: FREEBUFF_TOKEN env (comma-separated) or router/.env
 *
 * Run:  bun router/live-parity-test.ts
 * Exit: 0 = all checks passed, 1 = any check failed.
 *
 * Each check is independent and reported; the script never throws past a
 * check boundary, so a single quota hiccup doesn't mask the rest.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROUTER_URL = process.env.ROUTER_URL ?? 'http://127.0.0.1:8787'
const TEST_MODEL = process.env.PARITY_MODEL ?? 'deepseek/deepseek-v4-flash'
const TIMEOUT_MS = 120_000

// --- token resolution (env, else .env next to the script) ---
function loadTokens(): string {
  const env = process.env.FREEBUFF_TOKEN
  if (env) return env.split(',')[0].trim()
  const envPath = resolve(import.meta.dir, '.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^FREEBUFF_TOKEN=(.+)$/)
      if (m) return m[1].split(',')[0].trim()
    }
  }
  throw new Error('No FREEBUFF_TOKEN found (env or router/.env)')
}

const TOKEN = loadTokens()
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

// --- check harness ---
const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function skip(name: string, detail: string): void {
  results.push({ name, ok: true, detail: `SKIP — ${detail}` })
  console.log(`  SKIP  ${name} — ${detail}`)
}

/** True when every token's free tool-call bucket is spent (daily quota). */
let toolQuotaExhausted = false
async function probeToolQuota(): Promise<void> {
  const res = await fetch(`${ROUTER_URL}/health?verbose=1`, { signal: AbortSignal.timeout(10_000) })
  const j = (await res.json()) as { tokensDetail?: Array<{ toolQuotaExhausted: boolean }> }
  const details = j.tokensDetail ?? []
  toolQuotaExhausted = details.length > 0 && details.every((t) => t.toolQuotaExhausted)
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = Date.now()
  const value = await fn()
  return { ms: Date.now() - t0, value }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${ROUTER_URL}${path}`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

// --- checks ---

async function checkHealth(): Promise<void> {
  const res = await fetch(`${ROUTER_URL}/health?verbose=1`, { signal: AbortSignal.timeout(10_000) })
  const j = (await res.json()) as Record<string, unknown>
  const detail = j.tokensDetail as Array<{ token: string; toolQuotaExhausted: boolean }> | undefined
  const masked = detail?.every((t) => /^.{4}…/.test(t.token) || t.token === '***')
  check('health: verbose with masked tokens', res.status === 200 && masked === true, `tokens=${j.tokens}`)
}

async function checkModelList(): Promise<void> {
  const res = await fetch(`${ROUTER_URL}/v1/models`, { headers: AUTH, signal: AbortSignal.timeout(20_000) })
  const j = (await res.json()) as { data?: Array<Record<string, unknown>> }
  const data = j.data ?? []
  const entry = data.find((m) => m.id === TEST_MODEL)
  const ok = res.status === 200 && !!entry
  const spec = !!entry &&
    typeof entry.context_window === 'number' &&
    typeof entry.max_output_tokens === 'number' &&
    typeof entry.display_name === 'string'
  check('models: list with spec metadata', ok && spec,
    entry ? `ctx=${entry.context_window} out=${entry.max_output_tokens}` : `model ${TEST_MODEL} absent`)
}

async function checkModelDetail(): Promise<void> {
  // Anthropic Models API: GET /v1/models/{id}
  const res = await fetch(`${ROUTER_URL}/v1/models/${encodeURIComponent(TEST_MODEL)}`, {
    headers: AUTH,
    signal: AbortSignal.timeout(10_000),
  })
  const j = (await res.json()) as Record<string, unknown>
  check('models: GET /v1/models/{id} (Anthropic shape)',
    res.status === 200 && j.type === 'model' && typeof j.context_window === 'number' && typeof j.max_output_tokens === 'number',
    `ctx=${String(j.context_window)} out=${String(j.max_output_tokens)}`)
}

async function checkOpenAIChat(): Promise<void> {
  const { ms, value: res } = await timed(() => post('/v1/chat/completions', {
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: PARITY_OK' }],
    max_tokens: 30,
  }))
  const j = (await res.json()) as Record<string, unknown>
  const choices = j.choices as Array<{ message?: { content?: string } }> | undefined
  const content = choices?.[0]?.message?.content ?? ''
  const hasUsage = !!j.usage
  check('openai: non-stream chat', res.status === 200 && content.length > 0 && hasUsage,
    `${ms}ms usage=${hasUsage}`)
}

async function checkOpenAIStream(): Promise<void> {
  const { ms, value: res } = await timed(() => post('/v1/chat/completions', {
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
    stream: true,
    max_tokens: 50,
  }))
  const raw = await res.text()
  const done = (raw.match(/\[DONE\]/g) ?? []).length
  const deltas = (raw.match(/"delta"/g) ?? []).length
  check('openai: stream SSE with [DONE]', res.status === 200 && done === 1 && deltas > 0,
    `${ms}ms [DONE]=${done} deltas=${deltas}`)
}

/** True when a router error response means the free tool-call bucket is spent. */
function isToolQuotaError(j: Record<string, unknown>): boolean {
  const msg = String((j.error as Record<string, unknown> | undefined)?.message ?? '')
  return msg.includes('429') && msg.includes('high-balance')
}

async function checkOpenAITools(): Promise<void> {
  if (toolQuotaExhausted) return skip('openai: tool call round-trip', 'free tool-call budget exhausted upstream (daily)')
  const { ms, value: res } = await timed(() => post('/v1/chat/completions', {
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
    tool_choice: 'auto',
    max_tokens: 100,
  }))
  const j = (await res.json()) as Record<string, unknown>
  if (res.status >= 400 && isToolQuotaError(j)) {
    toolQuotaExhausted = true
    return skip('openai: tool call round-trip', 'free tool-call budget exhausted upstream (daily)')
  }
  const choices = j.choices as Array<{ message?: { tool_calls?: unknown[] } }> | undefined
  const toolCalls = choices?.[0]?.message?.tool_calls
  const ok = res.status === 200 && Array.isArray(toolCalls) && toolCalls.length > 0
  check('openai: tool call round-trip', ok,
    `${ms}ms tool_calls=${Array.isArray(toolCalls) ? toolCalls.length : 0}`)
}

async function checkAnthropicChat(): Promise<void> {
  const { ms, value: res } = await timed(() => post('/v1/messages', {
    model: TEST_MODEL,
    max_tokens: 30,
    messages: [{ role: 'user', content: 'Reply with exactly: ANTH_OK' }],
  }))
  const j = (await res.json()) as Record<string, unknown>
  const valid = j.type === 'message' && !!j.id && !!j.model && Array.isArray(j.content) &&
    j.content.some((b: unknown) => (b as { type?: string }).type === 'text')
  check('anthropic: non-stream Message envelope', res.status === 200 && valid,
    `${ms}ms type=${String(j.type)}`)
}

async function checkAnthropicStream(): Promise<void> {
  const { ms, value: res } = await timed(() => post('/v1/messages', {
    model: TEST_MODEL,
    max_tokens: 50,
    stream: true,
    messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
  }))
  const raw = await res.text()
  const events = [...raw.matchAll(/event: (\w+)/g)].map((m) => m[1])
  const stopCount = events.filter((e) => e === 'message_stop').length
  const startBeforeDelta = events.indexOf('content_block_start') !== -1 &&
    (events.indexOf('content_block_delta') === -1 ||
      events.indexOf('content_block_start') < events.indexOf('content_block_delta'))
  const hasStart = events.includes('message_start')
  check('anthropic: stream event sequence', res.status === 200 && stopCount === 1 && startBeforeDelta && hasStart,
    `${ms}ms events=${events.join('>')}`)
}

async function checkAnthropicTools(): Promise<void> {
  if (toolQuotaExhausted) return skip('anthropic: tool_use block', 'free tool-call budget exhausted upstream (daily)')
  const { ms, value: res } = await timed(() => post('/v1/messages', {
    model: TEST_MODEL,
    max_tokens: 100,
    tools: [{
      name: 'get_weather',
      description: 'Get current weather for a city',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }],
    messages: [{ role: 'user', content: 'What is the weather in Tokyo? Use the get_weather tool.' }],
  }))
  const j = (await res.json()) as Record<string, unknown>
  if (res.status >= 400 && isToolQuotaError(j)) {
    toolQuotaExhausted = true
    return skip('anthropic: tool_use block', 'free tool-call budget exhausted upstream (daily)')
  }
  const content = j.content as Array<{ type?: string }> | undefined
  const hasToolUse = content?.some((b) => b.type === 'tool_use')
  check('anthropic: tool_use block', res.status === 200 && hasToolUse,
    `${ms}ms tool_use=${hasToolUse}`)
}

async function checkStreak(): Promise<void> {
  const res = await fetch(`${ROUTER_URL}/v1/streak`, { headers: AUTH, signal: AbortSignal.timeout(10_000) })
  const j = (await res.json()) as Record<string, unknown>
  check('streak: /v1/streak passthrough', res.status === 200 && typeof j.streak === 'number', `streak=${String(j.streak)}`)
}

async function checkTokenCount(): Promise<void> {
  const res = await post('/v1/token-count', { messages: [{ role: 'user', content: 'hello' }] })
  const j = (await res.json()) as Record<string, unknown>
  const ok = res.status === 200 && (typeof j.tokenCount === 'number' || typeof j.inputTokens === 'number')
  check('token-count: passthrough', ok, `status=${res.status}`)
}

async function checkConcurrency(): Promise<void> {
  // Plain chat is NOT blocked by a tool-quota quarantine (the quarantine is
  // scoped to tool-bearing requests), so this burst runs even when the daily
  // tool budget is spent.
  const N = 6
  const jobs = Array.from({ length: N }, (_, i) => post('/v1/chat/completions', {
    model: TEST_MODEL,
    messages: [{ role: 'user', content: `Reply with ONLY the exact token: CONC${i}` }],
    max_tokens: 20,
  }).then(async (res) => {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as Record<string, unknown>
      const c = (j.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content ?? ''
      return { status: res.status, content: c }
    } catch {
      return { status: res.status, content: '' }
    }
  }))
  const t0 = Date.now()
  const out = await Promise.all(jobs)
  const ms = Date.now() - t0
  const okCount = out.filter((o) => o.status === 200).length
  const bleed = out.some((o, i) => o.status === 200 && o.content && !o.content.includes(`CONC${i}`))
  // Some requests may 404/503 when the 3-token pool is at capacity (upstream
  // model_unavailable) — that is expected behavior, not content corruption.
  check('concurrency: no cross-request bleed', okCount > 0 && !bleed,
    `${N} reqs ${ms}ms ok=${okCount}/${N} bleed=${bleed}`)
}

// --- main ---
async function main(): Promise<void> {
  console.log(`Live parity test → ${ROUTER_URL}  model=${TEST_MODEL}  token=${TOKEN.slice(0, 4)}…`)
  console.log('')

  const checks: Array<[string, () => Promise<void>]> = [
    ['health', checkHealth],
    ['models list', checkModelList],
    ['models detail', checkModelDetail],
    ['openai non-stream', checkOpenAIChat],
    ['openai stream', checkOpenAIStream],
    ['openai tools', checkOpenAITools],
    ['anthropic non-stream', checkAnthropicChat],
    ['anthropic stream', checkAnthropicStream],
    ['anthropic tools', checkAnthropicTools],
    ['streak', checkStreak],
    ['token-count', checkTokenCount],
    ['concurrency', checkConcurrency],
  ]

  try {
    await probeToolQuota()
  } catch {
    // health unreachable — individual checks will surface it
  }
  if (toolQuotaExhausted) {
    console.log(`  note: free tool-call budget exhausted on all tokens — tool checks skipped`)
  }

  for (const [name, fn] of checks) {
    try {
      await fn()
    } catch (err) {
      check(name, false, `threw: ${(err as Error).message.slice(0, 120)}`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('FAILED:')
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[parity] fatal:', err)
  process.exit(1)
})
