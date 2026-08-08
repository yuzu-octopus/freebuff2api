/**
 * Translation layer: OpenAI Responses API → Chat Completions.
 *
 * The Responses API (beta) uses `input` + `instructions` instead of `messages`.
 * Freebuff's chat endpoint expects OpenAI chat format. This module bridges that.
 */

import type { ChatMessage } from './types'

// Minimal shape of a Responses API request body.
export interface ResponsesRequest {
  model?: string
  input?: Array<{ role: string; content: string }>
  instructions?: string
  stream?: boolean
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  response_format?: unknown
  reasoning?: { effort?: string }
  // ... other OpenAI Responses fields
}

// Shape of a Chat Completions request body.
export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  response_format?: unknown
  [key: string]: unknown
}

export function isResponsesRequest(body: Record<string, unknown>): boolean {
  return 'input' in body && !('messages' in body)
}

/** Translate a Responses API body into a Chat Completions body. */
export function translateResponsesToChat(body: ResponsesRequest): ChatRequest {
  const messages: ChatMessage[] = []

  // Instructions → system prompt (must come first)
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions })
  }

  // Input → messages
  if (body.input) {
    for (const msg of body.input) {
      // Skip non-message input types (e.g. function_call, function_call_result)
      if (msg.role && msg.content !== undefined) {
        messages.push({ role: msg.role, content: msg.content })
      }
    }
  }

  // Strip response_format if it uses structured outputs (Freebuff may not support)
  // but preserve json_object / text modes
  let responseFormat = body.response_format
  if (responseFormat) {
    const rf = responseFormat as { type?: string; json_schema?: unknown }
    if (rf.type && !['text', 'json_object'].includes(rf.type)) {
      // Drop unsupported response formats rather than sending garbage upstream
      responseFormat = undefined
    }
  }

  return {
    model: body.model ?? '',
    messages,
    stream: body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_output_tokens,
    response_format: responseFormat,
  }
}
