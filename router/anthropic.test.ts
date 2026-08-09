/**
 * Regression tests for the Anthropic response translation layer.
 *
 * Anthropic's content blocks require `text` to be a plain string, and its
 * streaming `text_delta` events require `text` to be a plain string too. A
 * previous implementation emitted `{ value: ... }` objects, which Anthropic
 * clients reject. These tests pin the plain-string contract on both the
 * non-streaming and streaming paths.
 */

import { describe, it, expect } from 'bun:test'
import { openAIChunkToClaudeEvents, initAnthropicStreamState } from './anthropic'
import { openAINonStreamToClaude } from './server'

describe('openAINonStreamToClaude', () => {
  it('emits assistant text content as a plain string, not an object', () => {
    const out = openAINonStreamToClaude({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello there' },
          finish_reason: 'stop',
        },
      ],
    })

    const blocks = out.content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({ type: 'text', text: 'Hello there' })
    expect(typeof (blocks[0] as { text: unknown }).text).toBe('string')
  })

  it('preserves tool_use blocks with parsed input', () => {
    const out = openAINonStreamToClaude({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { function: { name: 'run_shell', arguments: '{"cmd":"ls"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })

    const blocks = out.content as Array<Record<string, unknown>>
    expect(blocks[0]).toMatchObject({ type: 'tool_use', name: 'run_shell' })
    expect(blocks[0].input).toEqual({ cmd: 'ls' })
  })
})

describe('openAIChunkToClaudeEvents', () => {
  it('emits text_delta with a plain string text, not an object', () => {
    const state = initAnthropicStreamState()
    const events = openAIChunkToClaudeEvents(
      {
        choices: [{ index: 0, delta: { content: 'Hi' } }],
      },
      state,
      0,
      0,
    )

    const textDelta = events.find((e) => e.type === 'content_block_delta')
    const data = JSON.parse(textDelta!.data) as { text: unknown }
    expect(data.text).toBe('Hi')
    expect(typeof data.text).toBe('string')
  })
})