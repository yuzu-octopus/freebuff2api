/**
 * Tests for config loading and model catalog.
 * Writes a real temp config file to disk — no mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, DEFAULT_FREEBUFF, AGENT_BY_MODEL, AGENT_FALLBACK, MODEL_CATALOG } from './config'

const TMP_CONFIG = path.join(import.meta.dirname, 'test.config.json')

describe('config', () => {
  beforeAll(() => {
    fs.writeFileSync(TMP_CONFIG, JSON.stringify({
      host: '0.0.0.0',
      port: 9999,
      routerKey: 'test-key',
      freebuff: {
        apiHost: 'https://staging.codebuff.com',
      },
    }))
  })

  afterAll(() => {
    if (fs.existsSync(TMP_CONFIG)) fs.unlinkSync(TMP_CONFIG)
  })

  it('loads config from file with defaults applied', () => {
    const config = loadConfig(TMP_CONFIG)
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(9999)
    expect(config.routerKey).toBe('test-key')
  })

  it('applies default freebuff hosts when partial config provided', () => {
    const config = loadConfig(TMP_CONFIG)
    expect(config.freebuff).toBeDefined()
    expect(config.freebuff.apiHost).toBe('https://staging.codebuff.com')
    expect(config.freebuff.loginHost).toBe(DEFAULT_FREEBUFF.loginHost)
  })

  it('uses defaults when no freebuff section present', () => {
    const noFreebuffConfig = path.join(import.meta.dirname, 'test.nofreebuff.json')
    fs.writeFileSync(noFreebuffConfig, JSON.stringify({
      host: '127.0.0.1',
      port: 8080,
    }))

    // loadConfig derives routerKey from ROUTER_KEY env; keep the env out
    // of this assertion so CI (which may set it) can't break the test.
    const savedToken = process.env.ROUTER_KEY
    delete process.env.ROUTER_KEY
    try {
      const config = loadConfig(noFreebuffConfig)
      expect(config.host).toBe('127.0.0.1')
      expect(config.port).toBe(8080)
      expect(config.routerKey).toBeUndefined()
      expect(config.freebuff.apiHost).toBe(DEFAULT_FREEBUFF.apiHost)
      expect(config.freebuff.loginHost).toBe(DEFAULT_FREEBUFF.loginHost)
    } finally {
      if (savedToken !== undefined) process.env.ROUTER_KEY = savedToken
      fs.unlinkSync(noFreebuffConfig)
    }
  })

  it('derives routerKey from ROUTER_KEY env when the file omits it', () => {
    const noKeyConfig = path.join(import.meta.dirname, 'test.nokey.json')
    fs.writeFileSync(noKeyConfig, JSON.stringify({ host: '127.0.0.1', port: 8080 }))

    const saved = process.env.ROUTER_KEY
    process.env.ROUTER_KEY = 'env-router-key'
    try {
      const config = loadConfig(noKeyConfig)
      expect(config.routerKey).toBe('env-router-key')
    } finally {
      if (saved === undefined) delete process.env.ROUTER_KEY
      else process.env.ROUTER_KEY = saved
      fs.unlinkSync(noKeyConfig)
    }
  })

  it('prefers the file routerKey over ROUTER_KEY env', () => {
    const saved = process.env.ROUTER_KEY
    process.env.ROUTER_KEY = 'env-key'
    try {
      // TMP_CONFIG carries routerKey: 'test-key' in the file
      expect(loadConfig(TMP_CONFIG).routerKey).toBe('test-key')
    } finally {
      if (saved === undefined) delete process.env.ROUTER_KEY
      else process.env.ROUTER_KEY = saved
    }
  })

  it('does not fall back to FREEBUFF_TOKEN for routerKey', () => {
    // routerKey: null in the file → falls through to env; without ROUTER_KEY
    // the router stays open even when FREEBUFF_TOKEN is set.
    const nullKeyConfig = path.join(import.meta.dirname, 'test.nullkey.json')
    fs.writeFileSync(nullKeyConfig, JSON.stringify({ host: '127.0.0.1', port: 8080, routerKey: null }))

    const savedKey = process.env.ROUTER_KEY
    const savedToken = process.env.FREEBUFF_TOKEN
    delete process.env.ROUTER_KEY
    process.env.FREEBUFF_TOKEN = 'freebuff-token'
    try {
      const config = loadConfig(nullKeyConfig)
      expect(config.routerKey).toBeUndefined()
    } finally {
      if (savedKey !== undefined) process.env.ROUTER_KEY = savedKey
      if (savedToken !== undefined) process.env.FREEBUFF_TOKEN = savedToken
      else delete process.env.FREEBUFF_TOKEN
      fs.unlinkSync(nullKeyConfig)
    }
  })

  it('falls back to defaults when config file missing (env-driven setup)', () => {
    const saved = process.env.ROUTER_KEY
    process.env.ROUTER_KEY = 'env-key'
    try {
      const config = loadConfig(path.join(import.meta.dirname, 'nonexistent.config.json'))
      expect(config.host).toBe('127.0.0.1')
      expect(config.port).toBe(8787)
      expect(config.routerKey).toBe('env-key')
      expect(config.freebuff).toEqual(DEFAULT_FREEBUFF)
    } finally {
      if (saved === undefined) delete process.env.ROUTER_KEY
      else process.env.ROUTER_KEY = saved
    }
  })

  it('resolves model id to agent id', () => {
    expect(AGENT_BY_MODEL['deepseek/deepseek-v4-flash']).toBe('base2-free-deepseek-flash')
    expect(AGENT_BY_MODEL['mimo/mimo-v2.5']).toBe('base2-free-mimo')
    expect(AGENT_FALLBACK).toBe('base2-free')
  })

  it('exposes model catalog for /v1/models', () => {
    expect(MODEL_CATALOG.length).toBe(6)
    expect(MODEL_CATALOG[0].id).toBe('deepseek/deepseek-v4-flash')
    expect(MODEL_CATALOG[0].quota).toBe('unlimited')
  })
})
