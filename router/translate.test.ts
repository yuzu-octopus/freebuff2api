/**
 * Tests for the OpenAI Responses API → Chat Completions translation layer.
 *
 * The Responses API uses a different format:
 *   - `input`: array of {type: "message", role, content}
 *   - `instructions`: string (system prompt)
 *   - `tools`: optional function tools
 * We translate this into a standard OpenAI chat/completions body.
 */

import { describe, it, expect } from 'bun:test'
import { translateResponsesToChat, isResponsesRequest } from './translate'

describe('isResponsesRequest', () => {
  it('detects responses API by presence of "input"', () => {
    expect(isResponsesRequest({ input: [{ role: 'user', content: 'hi' }] })).toBe(true)
  })

  it('detects chat API by presence of "messages"', () => {
    expect(isResponsesRequest({ messages: [{ role: 'user', content: 'hi' }] })).toBe(false)
  })

  it('returns false when neither field present', () => {
    expect(isResponsesRequest({ model: 'test' })).toBe(false)
  })
})

describe('translateResponsesToChat', () => {
  it('converts basic responses input to chat messages', () => {
    const result = translateResponsesToChat({
      model: 'deepseek/deepseek-v4-flash',
      input: [{ role: 'user', content: 'hello' }],
    })

    expect(result.model).toBe('deepseek/deepseek-v4-flash')
    expect(result.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('moves instructions to a system message', () => {
    const result = translateResponsesToChat({
      model: 'deepseek/deepseek-v4-flash',
      instructions: 'You are a helpful assistant',
      input: [{ role: 'user', content: 'hello' }],
    })

    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' })
    expect(result.messages[1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('preserves message ordering with system first', () => {
    const result = translateResponsesToChat({
      model: 'deepseek/deepseek-v4-flash',
      instructions: 'be concise',
      input: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    })

    expect(result.messages).toEqual([
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ])
  })

  it('strips OpenAI-specific fields not understood by Freebuff', () => {
    const result = translateResponsesToChat({
      model: 'deepseek/deepseek-v4-flash',
      input: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
      max_output_tokens: 100,
      reasoning: { effort: 'low' },
    })

    expect(result.model).toBe('deepseek/deepseek-v4-flash')
    expect(result.messages).toEqual([{ role: 'user', content: 'hi' }])
    // Should preserve passthrough fields
    expect(result.max_tokens).toBe(100)
    expect(result.response_format).toEqual({ type: 'json_object' })
  })

  it('handles empty input gracefully', () => {
    const result = translateResponsesToChat({
      model: 'deepseek/deepseek-v4-flash',
      input: [],
    })

    expect(result.messages).toEqual([])
  })

  it('passes through stream flag', () => {
    const result = translateResponsesToChat({
      model: 'deepseek/deepseek-v4-flash',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    expect(result.stream).toBe(true)
  })
})
