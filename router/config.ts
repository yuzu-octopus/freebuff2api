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
  /** Hard context window in tokens (measured from real provider rejections). */
  contextWindow: number
  /** Conservative output ceiling in tokens (upstream decides; client cap). */
  maxOutputTokens: number
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
  'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
  'mimo/mimo-v2.5': 'base2-free-mimo',
  'minimax/minimax-m3': 'base2-free-minimax-m3',
  'openai/gpt-5.6-luna': 'base2-free-luna',
  'z-ai/glm-5.2': 'base2-free-glm',
  'poolside/laguna-s-2.1': 'base2-free-laguna-s-2.1',
  'inclusionai/ling-3.0-flash:free': 'base2-free-ling-3-flash',
  'crof/greg-2-ultra': 'base2-free-greg-2-ultra',
  'crof/greg-2-super': 'base2-free-greg-2-super',
  'anthropic/claude-fable-5': 'base2-free-fable',
  'meta/muse-spark-1.2-contributor': 'base2-free-muse-spark',
}

export const AGENT_FALLBACK = 'base2-free'

// Default model for probing session status.
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'

// Static model catalog: models a user can always request. Unlimited models.
// contextWindow values are measured from real provider rejections (see
// source/github/common/src/constants/freebuff-models.ts); unmeasured models
// get the conservative 131072 default. maxOutputTokens is a conservative
// client-side cap — upstream enforces the real limit.
const DEFAULT_WINDOW = 131_072
const DEFAULT_OUTPUT = 32_768
export const MODEL_CATALOG: FreebuffModelOption[] = [
  { id: 'deepseek/deepseek-v4-flash', display: 'DeepSeek V4 Flash', quota: 'unlimited', type: 'unlimited', contextWindow: 1_048_576, maxOutputTokens: DEFAULT_OUTPUT },
  { id: 'mimo/mimo-v2.5', display: 'MiMo 2.5', quota: 'unlimited', type: 'unlimited', contextWindow: DEFAULT_WINDOW, maxOutputTokens: DEFAULT_OUTPUT },
  { id: 'deepseek/deepseek-v4-pro', display: 'DeepSeek V4 Pro', quota: '6/day', type: 'premium', contextWindow: DEFAULT_WINDOW, maxOutputTokens: DEFAULT_OUTPUT },
  { id: 'minimax/minimax-m3', display: 'MiniMax M3', quota: '6/day', type: 'premium', contextWindow: 524_288, maxOutputTokens: DEFAULT_OUTPUT },
  { id: 'openai/gpt-5.6-luna', display: 'GPT-5.6 Luna', quota: '6/day', type: 'premium', contextWindow: 1_000_000, maxOutputTokens: DEFAULT_OUTPUT },
  { id: 'z-ai/glm-5.2', display: 'GLM 5.2', quota: 'referral-gated', type: 'referral', contextWindow: DEFAULT_WINDOW, maxOutputTokens: DEFAULT_OUTPUT },
]
export function loadConfig(path = process.env.ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH): RouterConfig {
  const resolved = resolve(path)
  if (!existsSync(resolved)) {
    // No config file (e.g. fresh `bunx freebuff2api` without a local copy) —
    // fall back to defaults. FREEBUFF_TOKEN / ROUTER_KEY env vars still apply,
    // and the token pool rejects an empty token list at startup.
    return {
      host: '127.0.0.1',
      port: 8787,
      routerKey: process.env.ROUTER_KEY,
      freebuff: { ...DEFAULT_FREEBUFF },
    }
  }
  const raw = JSON.parse(readFileSync(resolved, 'utf8')) as Partial<RouterConfig>
  return {
    host: raw.host ?? '127.0.0.1',
    port: raw.port ?? 8787,
    routerKey: raw.routerKey ?? process.env.ROUTER_KEY,
    freebuff: raw.freebuff
      ? { ...DEFAULT_FREEBUFF, ...raw.freebuff }
      : { ...DEFAULT_FREEBUFF },
  }
}

// Resolve Freebuff tokens: FREEBUFF_TOKEN env var (comma-separated for concurrency)
// or the credentials file. Returns an empty array if neither is available.
export function resolveFreebuffTokens(): string[] {
  const envToken = process.env.FREEBUFF_TOKEN
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
