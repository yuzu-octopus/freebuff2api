/**
 * Router configuration.
 *
 * Freebuff-only router: all chat requests are forwarded through the Freebuff
 * protocol (session admission + agent run + chat stream). The router presents
 * a local OpenAI-compatible /v1 surface to any agent client.
 *
 * Multiple Freebuff tokens can be provided (comma-separated) for concurrency:
 * each Freebuff account has a single global active session, so multiple tokens
 * = multiple independent session slots = parallel request handling.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type ModelQuotaType = 'unlimited' | 'premium' | 'referral' | 'limited'

export interface FreebuffModelOption {
  id: string
  display: string
  quota: string
  type: ModelQuotaType
}

export interface FreebuffConfig {
  /** Login origin (freebuff.com prod default). */
  loginHost: string
  /** API origin for session status (www.codebuff.com is canonical). */
  apiHost: string
}

export interface RouterConfig {
  host: string
  port: number
  /** If set, all /v1/* routes require `Authorization: Bearer <routerKey>`. */
  routerKey?: string
  freebuff: FreebuffConfig
}

export const DEFAULT_CONFIG_PATH = 'router.config.json'

export const DEFAULT_FREEBUFF: FreebuffConfig = {
  loginHost: 'https://freebuff.com',
  apiHost: 'https://www.codebuff.com',
}

// FREEBUFF_ROOT_AGENT_ID_BY_MODEL (common/src/constants/free-agents.ts):
// the free-mode root agent must pair with the exact model id, or the server
// rejects with 403 free_mode_invalid_agent_model.
export const AGENT_BY_MODEL: Record<string, string> = {
  'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash',
  'mimo/mimo-v2.5': 'base2-free-mimo',
  'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
  'minimax/minimax-m3': 'base2-free-minimax-m3',
  'openai/gpt-5.6-luna': 'base2-free-luna',
  'z-ai/glm-5.2': 'base2-free-glm',
  'anthropic/claude-fable-5': 'base2-free-fable',
}

export const AGENT_FALLBACK = 'base2-free'

// Default model for probing session status.
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'

// Static model catalog: models a user can always request. Unlimited models
// have ad-hoc sessions; premium models share a 6/day pool; referral-gated
// models (GLM 5.2) appear in the catalog but require entitlement.
export const MODEL_CATALOG: FreebuffModelOption[] = [
  { id: 'deepseek/deepseek-v4-flash', display: 'DeepSeek V4 Flash', quota: 'unlimited', type: 'unlimited' },
  { id: 'mimo/mimo-v2.5', display: 'MiMo 2.5', quota: 'unlimited', type: 'unlimited' },
  { id: 'deepseek/deepseek-v4-pro', display: 'DeepSeek V4 Pro', quota: '6/day', type: 'premium' },
  { id: 'minimax/minimax-m3', display: 'MiniMax M3', quota: '6/day', type: 'premium' },
  { id: 'openai/gpt-5.6-luna', display: 'GPT-5.6 Luna', quota: '6/day', type: 'premium' },
  { id: 'z-ai/glm-5.2', display: 'GLM 5.2', quota: 'referral-gated', type: 'referral' },
  // Fable 5 is a limited-time offer surfaced dynamically via the session's
  // limitedModelOffers — included here as type: 'limited' for fallback.
  { id: 'anthropic/claude-fable-5', display: 'Claude Fable 5', quota: 'limited', type: 'limited' },
]

export function loadConfig(path = process.env.ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH): RouterConfig {
  const resolved = resolve(path)
  if (!existsSync(resolved)) {
    throw new Error(
      `Config not found at ${path}. Copy router.config.example.json to ${path} and fill in your provider keys.`,
    )
  }
  const raw = JSON.parse(readFileSync(resolved, 'utf8')) as Partial<RouterConfig & { freebuffTokens?: string }>
  return {
    host: raw.host ?? '127.0.0.1',
    port: raw.port ?? 8787,
    routerKey: raw.routerKey ?? process.env.ROUTER_TOKEN,
    freebuff: raw.freebuff
      ? { ...DEFAULT_FREEBUFF, ...raw.freebuff }
      : { ...DEFAULT_FREEBUFF },
  }
}

// Resolve Freebuff tokens: ROUTER_TOKEN env var (comma-separated for concurrency)
// or the credentials file. Returns an empty array if neither is available.
export function resolveFreebuffTokens(): string[] {
  const envToken = process.env.ROUTER_TOKEN
  if (envToken) {
    return envToken.split(',').map((t) => t.trim()).filter(Boolean)
  }

  const credPath = getDefaultCredPath()
  if (!credPath) return []

  try {
    const creds = JSON.parse(readFileSync(credPath, 'utf8'))
    const token = creds?.default?.authToken ?? creds?.authToken
    if (token) return [token]
  } catch {
    // fall through
  }
  return []
}

function getDefaultCredPath(): string | null {
  const home = process.env.HOME ?? process.env.HOMEPATH ?? ''
  if (!home) return null
  const p = resolve(home, '.config', 'manicode', 'credentials.json')
  return existsSync(p) ? p : null
}
