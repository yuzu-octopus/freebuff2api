#!/usr/bin/env node
/**
 * Freebuff protocol client — uses YOUR account token from
 * ~/.config/manicode/credentials.json against the documented protocol
 * (see PROTOCOL.md). No limits to defeat: DeepSeek V4 Flash and MiMo 2.5
 * are unlimited for CLI users by design.
 *
 * Usage:
 *   node client.mjs "your prompt" [--model deepseek/deepseek-v4-flash] [--base https://codebuff.com]
 *
 * Flow (mirrors cli/src/utils/freebuff-session-api.ts + sdk/src/impl):
 *   1. GET  /api/v1/freebuff/session  -> reuse an active session if present
 *   2. POST /api/v1/agent-runs        (action START) -> runId
 *   3. POST /api/v1/chat/completions  (OpenAI-compatible + codebuff_metadata
 *      {run_id, client_id, cost_mode:'free'}) -> SSE stream
 *   4. POST /api/v1/agent-runs        (action FINISH, best-effort)
 *
 * NOTE: free-mode chat is gated server-side to the official freebuff CLI
 * (403 free_mode_cli_required: "Calling the API directly is not supported and
 * may get your account banned"). This client faithfully implements the wire
 * protocol but does NOT spoof the CLI identity, so free-mode chat will be
 * refused. The CLI itself is the supported unlimited-free-model surface.
 * The session GET/DELETE + quota introspection below work fine.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MODEL_DEFAULT = 'deepseek/deepseek-v4-flash'
const SESSION_PATH = '/api/v1/freebuff/session'
const RUNS_PATH = '/api/v1/agent-runs'
const CHAT_PATH = '/api/v1/chat/completions'
// FREEBUFF_ROOT_AGENT_ID_BY_MODEL (common/src/constants/free-agents.ts): the
// free-mode root agent must pair with the exact model id or the server rejects
// with free_mode_invalid_agent_model.
const AGENT_BY_MODEL = {
  'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash',
  'mimo/mimo-v2.5': 'base2-free-mimo',
  'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
  'minimax/minimax-m3': 'base2-free-minimax-m3',
  'openai/gpt-5.6-luna': 'base2-free-luna',
}
const AGENT_FALLBACK = 'base2-free'

function parseArgs(argv) {
  const args = { model: MODEL_DEFAULT, base: process.env.FREEBUFF_API_URL || 'https://www.codebuff.com', prompt: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i]
    else if (argv[i] === '--base') args.base = argv[++i]
    else args.prompt = argv[i]
  }
  return args
}

function getToken() {
  const p = path.join(os.homedir(), '.config', 'manicode', 'credentials.json')
  if (!fs.existsSync(p)) throw new Error(`No credentials at ${p} — run the freebuff CLI once and log in.`)
  const creds = JSON.parse(fs.readFileSync(p, 'utf8'))
  const token = creds?.default?.authToken
  if (!token) throw new Error('No authToken in credentials.json')
  return token
}

async function requestSession(method, base, token, { model, instanceId } = {}) {
  const headers = { Authorization: `Bearer ${token}` }
  if (model) headers['x-freebuff-model'] = model
  if (instanceId) headers['x-freebuff-instance-id'] = instanceId
  const res = await fetch(`${base}${SESSION_PATH}`, { method, headers })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const status = body?.status ?? `http_${res.status}`
    const detail = body?.message ?? body?.error ?? ''
    throw new Error(`Session ${method} failed [${status}]: ${detail}`.trim())
  }
  return body
}

/** Get the current active session for the account+model, or null if none. */
async function getSession(base, token, model) {
  const body = await requestSession('GET', base, token, {})
  if (!body || body.status === 'none') return null
  if (body.status === 'active' && body.model === model) return body
  // An active session exists but for another model — treat as none for this
  // model and let admission sort it out (it may return model_locked).
  return null
}

/** Admit a session for the model. Only called when none is active. */
async function admitSession(base, token, model) {
  const body = await requestSession('POST', base, token, { model })
  if (body?.status === 'rate_limited') {
    const rl = body.rateLimit ?? body.rateLimitsByModel?.[model]
    const used = rl ? `${rl.recentCount}/${rl.limit} (resets ${rl.resetAt})` : 'unknown'
    throw new Error(`Rate limited: ${used}`)
  }
  if (body?.status === 'country_blocked' || body?.status === 'banned') {
    throw new Error(`Session rejected: ${body.status}`)
  }
  if (body?.status === 'model_locked' || body?.status === 'model_unavailable') {
    throw new Error(`Session rejected: ${body.status}`)
  }
  return body
}

/** Start an agent run; the server returns the runId the chat body must carry. */
async function startRun(base, token, model) {
  const agentId = AGENT_BY_MODEL[model] ?? AGENT_FALLBACK
  const res = await fetch(`${base}${RUNS_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'START', agentId }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`startRun failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  const body = await res.json().catch(() => null)
  if (!body?.runId) throw new Error(`startRun returned no runId: ${JSON.stringify(body)}`)
  return body.runId
}

/** Best-effort FINISH so the server-side run accounting closes cleanly. */
async function finishRun(base, token, runId) {
  try {
    await fetch(`${base}${RUNS_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'FINISH', runId, status: 'completed', totalSteps: 0, directCredits: 0, totalCredits: 0 }),
    })
  } catch {
    /* best-effort */
  }
}

async function streamChat(base, token, model, prompt, runId, clientId) {
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    runId,
    codebuff_metadata: { run_id: runId, client_id: clientId, cost_mode: 'free' },
  }
  const res = await fetch(`${base}${CHAT_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-freebuff-model': model,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let hint = ''
    try {
      const body = JSON.parse(text)
      if (body.error === 'free_mode_cli_required') {
        hint = '\n  (The server only allows free-mode chat from the official freebuff CLI.\n   It explicitly bans direct API calls. Use the CLI itself for free models.)'
      }
    } catch {
      /* non-JSON */
    }
    throw new Error(`Chat failed: HTTP ${res.status} ${text.slice(0, 300)}${hint}`)
  }
  return res.body
}

/** Minimal SSE parser: reads the body stream, yields parsed `data:` JSON. */
async function* sse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          yield data
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function releaseSession(base, token) {
  try {
    await fetch(`${base}${SESSION_PATH}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    /* best-effort release */
  }
}

async function main() {
  const { prompt, model, base } = parseArgs(process.argv.slice(2))
  if (!prompt) {
    console.error('Usage: node client.mjs "your prompt" [--model <id>] [--base <url>]')
    process.exit(1)
  }

  const token = getToken()

  // Safe admission: reuse an already-active session (e.g. the running CLI's)
  // rather than POSTing and risking instance takeover. Only admit when none
  // exists, and only release a session we created ourselves.
  let session = await getSession(base, token, model)
  let admitted = false
  if (session) {
    console.error(`▸ reusing active session (instance ${session.instanceId.slice(0, 8)}…)`)
  } else {
    console.error(`▸ admitting session (model: ${model})…`)
    session = await admitSession(base, token, model)
    admitted = true
    console.error(`▸ session ${session.status}${session.instanceId ? ` (instance ${session.instanceId.slice(0, 8)}…)` : ''}`)
  }
  const rl = session?.rateLimit ?? session?.rateLimitsByModel?.[model]
  if (rl) console.error(`▸ quota: ${rl.recentCount}/${rl.limit} used, resets ${rl.resetAt}`)

  console.error('▸ starting agent run…')
  const runId = await startRun(base, token, model)
  const clientId = session?.instanceId ?? crypto.randomUUID()
  let finished = false

  try {
    console.error('▸ streaming…\n')
    const body = await streamChat(base, token, model, prompt, runId, clientId)
    let text = ''
    for await (const data of sse(body)) {
      if (data === '[DONE]') break
      try {
        const json = JSON.parse(data)
        const delta = json.choices?.[0]?.delta
        if (delta?.content) {
          process.stdout.write(delta.content)
          text += delta.content
        }
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
    console.error('\n\n▸ done.')
    return text
  } finally {
    if (!finished) {
      await finishRun(base, token, runId)
      finished = true
    }
    if (admitted) await releaseSession(base, token)
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`)
  process.exit(1)
})
