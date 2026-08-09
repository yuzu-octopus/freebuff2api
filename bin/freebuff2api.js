#!/usr/bin/env bun
/**
 * freebuff2api — Freebuff LLM router.
 *
 * Starts the local OpenAI-/v1-compatible server that proxies free-mode
 * Freebuff models. Requires Bun (the router is built on Bun.serve).
 *
 * Usage:
 *   freebuff2api                    # serve on 127.0.0.1:8787 (default)
 *   ROUTER_CONFIG=my.json freebuff2api
 */
import { startRouter } from '../router/server.ts'

startRouter().catch((err) => {
  console.error('[freebuff2api] fatal:', err)
  process.exit(1)
})